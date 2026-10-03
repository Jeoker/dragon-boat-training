import { readSourceAuthorityPin, sourceAuthorityText, type SourceAuthorityPin } from "../../shared/c2-source-authority-contract";
import { sourceBytes, sourceObject, sourceText, type SourceJson } from "../../shared/c2-source-capture-contract";
import { bindSourceAuthorityContext } from "./authority-context";
import { journalAssert, SourceJournalError } from "./service";

interface Registration {
  format: "c2-private-source-target-v1"; key: string; revision: 1;
  pin: SourceAuthorityPin; target: SourceJson; registration_digest: string;
}
export interface SourceTargetRegistryStore {
  read(key: string): Promise<unknown | null>;
  compareAndSet(key: string, revision: number | null, value: Registration): Promise<boolean>;
}

/** Immutable private registration. Uses a distinct key domain in the same
 * private CAS store; neither target nor attempt can replace an existing entry. */
export class PrivateSourceTargetRegistry {
  private readonly team: string;
  constructor(teamId: string, private readonly store: SourceTargetRegistryStore, private readonly hash: (text: string) => Promise<string>) {
    try { this.team = sourceText(teamId, 1, 512); } catch { throw new SourceJournalError("SOURCE_TARGET_REGISTRY_UNCONFIRMED"); }
  }
  private async key(operationId: string) {
    const id = sourceText(operationId, 1, 512);
    const key = await this.hash("c2-private-source-target-key-v1\n" + sourceAuthorityText([this.team, id]));
    journalAssert(typeof key === "string" && /^[A-Za-z0-9_-]{43}$/u.test(key), "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
    return key;
  }
  private async load(operationId: string, key: string) {
    const raw = await this.store.read(key); if (raw === null) return null;
    const text = sourceAuthorityText(raw); journalAssert(sourceBytes(text) <= 2_008_000, "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
    const row = sourceObject(JSON.parse(text));
    journalAssert(Object.keys(row).length === 6 && Object.keys(row).every(field =>
      ["format", "key", "revision", "pin", "target", "registration_digest"].includes(field)) && row.format === "c2-private-source-target-v1" &&
      row.key === key && row.revision === 1, "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
    const pin = readSourceAuthorityPin(row.pin);
    journalAssert(pin.source.team_id === this.team && pin.source.source_operation_id === operationId, "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
    await bindSourceAuthorityContext(pin, row.target, this.hash);
    const { registration_digest, ...core } = row;
    journalAssert(await this.hash("c2-private-source-target-v1\n" + sourceAuthorityText(core)) === registration_digest,
      "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
    return row as unknown as Registration;
  }
  async register(serverPin: unknown, target: unknown) {
    try {
      const pin = readSourceAuthorityPin(serverPin), savedTarget = JSON.parse(sourceAuthorityText(target)) as SourceJson;
      journalAssert(pin.source.team_id === this.team, "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
      await bindSourceAuthorityContext(pin, savedTarget, this.hash);
      const operationId = pin.source.source_operation_id, key = await this.key(operationId);
      const core = { format: "c2-private-source-target-v1" as const, key, revision: 1 as const, pin, target: savedTarget };
      const record = { ...core, registration_digest: await this.hash("c2-private-source-target-v1\n" + sourceAuthorityText(core)) };
      journalAssert(sourceBytes(sourceAuthorityText(record)) <= 2_008_000, "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
      const prior = await this.load(operationId, key);
      if (!prior) {
        const result = await this.store.compareAndSet(key, null, record);
        journalAssert(typeof result === "boolean", "SOURCE_TARGET_REGISTRY_UNCONFIRMED");
      }
      const saved = await this.load(operationId, key);
      journalAssert(saved && sourceAuthorityText(saved) === sourceAuthorityText(record), "SOURCE_TARGET_REGISTRY_CONFLICT");
      return JSON.parse(sourceAuthorityText(saved.target));
    } catch (error) {
      let code = "SOURCE_TARGET_REGISTRY_UNCONFIRMED";
      try {
        if (error instanceof SourceJournalError && Object.getOwnPropertyDescriptor(error, "code")?.value === "SOURCE_TARGET_REGISTRY_CONFLICT")
          code = "SOURCE_TARGET_REGISTRY_CONFLICT";
      } catch { /* Foreign diagnostics, including Proxy traps, remain private. */ }
      throw new SourceJournalError(code);
    }
  }
  async get(operationId: string) {
    try {
      const row = await this.load(operationId, await this.key(operationId));
      journalAssert(row, "SOURCE_TARGET_REGISTRY_UNREGISTERED");
      return JSON.parse(sourceAuthorityText(row.target));
    } catch { throw new SourceJournalError("SOURCE_TARGET_REGISTRY_UNCONFIRMED"); }
  }
}
