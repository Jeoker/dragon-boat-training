import { readSourceAuthorityPin, sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { PrivateSourceOperation, readPrivateSourceOperationContext, type PrivateSourceOperationContext, type PrivateSourceOperationPorts } from "./operation";
import { sourceObject, type SourceJson } from "../../shared/c2-source-capture-contract";
import { journalAssert, SourceJournalError, sanitizeJournalError } from "./service";

/** Only call with a pin obtained from a trusted authenticated server port and
 * a private target registry. Digest validation does not authenticate a supplied
 * object; neither port may be fed directly from browser request fields. */
export async function bindSourceAuthorityContext(serverPin: unknown, registeredTarget: unknown,
  hash: (text: string) => Promise<string>): Promise<PrivateSourceOperationContext> {
  try {
    const pin = readSourceAuthorityPin(serverPin), { authority_digest, ...core } = pin;
    const target = sourceObject(JSON.parse(sourceAuthorityText(registeredTarget)) as SourceJson);
    const keys = ["source_operation_id", "attempt_id", "api_user_permission_id", "journal_spreadsheet_id",
      "journal_sheet_id", "owner_permission_id"];
    journalAssert(Object.keys(target).length === keys.length && Object.keys(target).every(key => keys.includes(key)) &&
      target.source_operation_id === pin.source.source_operation_id, "SOURCE_PRIVATE_TARGET_UNREGISTERED");
    journalAssert(await hash("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) === authority_digest,
      "SOURCE_PRIVATE_AUTHORITY_CHANGED");
    return readPrivateSourceOperationContext({ read_context: { source: pin.source, known_sources: pin.known_sources,
      declared_mappings: [], response_tab_title: pin.response_tab_title, api_user_permission_id: target.api_user_permission_id },
      actor_id: pin.actor_id, attempt_id: target.attempt_id, journal_spreadsheet_id: target.journal_spreadsheet_id,
      journal_sheet_id: target.journal_sheet_id, owner_permission_id: target.owner_permission_id });
  } catch (error) {
    throw sanitizeJournalError(error, "SOURCE_PRIVATE_AUTHORITY_UNCONFIRMED");
  }
}

/** Runtime ports authenticate/recheck server ownership and load the private
 * registration. No browser-supplied actor/census/target is accepted here. This
 * factory does not itself deploy either service or authenticate its transport. */
export async function createAuthorizedSourceOperation(authorize: () => Promise<unknown>,
  registeredTarget: (operationId: string) => Promise<unknown>,
  portsFor: (context: () => PrivateSourceOperationContext) => Omit<PrivateSourceOperationPorts, "checkAuthority">) {
  try {
    const original = readSourceAuthorityPin(await authorize());
    const portsContext = { value: null as PrivateSourceOperationContext | null };
    const ports = portsFor(() => {
      journalAssert(portsContext.value, "SOURCE_PRIVATE_AUTHORITY_UNCONFIRMED");
      return JSON.parse(sourceAuthorityText(portsContext.value)) as PrivateSourceOperationContext;
    });
    const context = await bindSourceAuthorityContext(original, await registeredTarget(original.source.source_operation_id), ports.hash);
    portsContext.value = context;
    return new PrivateSourceOperation(() => portsContext.value, { ...ports, nativeAuthorityDigest: original.authority_digest, async checkAuthority(expected) {
      const current = readSourceAuthorityPin(await authorize());
      journalAssert(sourceAuthorityText(current) === sourceAuthorityText(original), "SOURCE_PRIVATE_AUTHORITY_CHANGED");
      const target = await registeredTarget(current.source.source_operation_id);
      const freshContext = await bindSourceAuthorityContext(current, target, ports.hash);
      journalAssert(sourceAuthorityText(freshContext) === sourceAuthorityText(expected), "SOURCE_PRIVATE_AUTHORITY_CHANGED");
    } });
  } catch {
    throw new SourceJournalError("SOURCE_PRIVATE_AUTHORITY_UNCONFIRMED");
  }
}
