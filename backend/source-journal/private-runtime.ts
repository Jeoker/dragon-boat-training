import { readSourceAuthorityPin, sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { createAuthorizedSourceOperation, bindSourceAuthorityContext } from "./authority-context";
import { type PrivateSourceOperationRecord } from "./operation";
import { PrivateSourceReadAttempt, type PrivateSourceReadRecord } from "./read-attempt";
import { GoogleSourceReader } from "./source-reader";
import { GoogleSourceJournalStore } from "./google-store";
import { PrivateSourceJournal, journalAssert, SourceJournalError } from "./service";

export interface PrivateSourceRuntimePorts {
  authorize(): Promise<unknown>;
  registeredTarget(operationId: string): Promise<unknown>;
  store: {
    read(key: string): Promise<unknown | null>;
    compareAndSet(key: string, revision: number | null, value: PrivateSourceOperationRecord | PrivateSourceReadRecord): Promise<boolean>;
  };
  hash(text: string): Promise<string>;
  oauthToken(): Promise<string>;
  fetchGoogle?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => string;
}

/** Private Node host composition only. Source reads always use durable request
 * checkpoints. Every actual Google request also rechecks live server authority
 * and immutable target registration; OAuth never stands in for Coach identity. */
export async function createPrivateSourceRuntime(ports: PrivateSourceRuntimePorts) {
  try {
    const hash = (text: string) => ports.hash(text), token = () => ports.oauthToken();
    const initial = readSourceAuthorityPin(await ports.authorize()), operationId = initial.source.source_operation_id;
    const target = JSON.parse(sourceAuthorityText(await ports.registeredTarget(operationId)));
    await bindSourceAuthorityContext(initial, target, hash);
    const check = async () => {
      const current = readSourceAuthorityPin(await ports.authorize());
      const registered = await ports.registeredTarget(operationId);
      journalAssert(sourceAuthorityText(current) === sourceAuthorityText(initial) &&
        sourceAuthorityText(registered) === sourceAuthorityText(target), "SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED");
      await bindSourceAuthorityContext(current, registered, hash);
    };
    const guardedFetch = async (url: string, init: RequestInit) => {
      await check();
      const response = await (ports.fetchGoogle ?? fetch)(url, init);
      try { await check(); return response; }
      catch {
        await response.body?.cancel().catch(() => {});
        throw new SourceJournalError("SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED");
      }
    };
    const now = ports.now ? () => ports.now!() : undefined;
    return await createAuthorizedSourceOperation(async () => { await check(); return initial; }, id => ports.registeredTarget(id), context => ({
      hash, store: ports.store,
      readSource: async () => new GoogleSourceReader(() => context().read_context, token, guardedFetch, now,
        new PrivateSourceReadAttempt(context, ports.store, hash, now)).read(),
      journal: journalContext => new PrivateSourceJournal(journalContext,
        new GoogleSourceJournalStore(token, guardedFetch), hash),
    }));
  } catch { throw new SourceJournalError("SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED"); }
}
