import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryState, type RecoveryEnv } from "../../src/recovery-entry";
import recoveryWorker from "../../src/recovery-worker";
import { sourceObjectName } from "../src/runtime";
import type { PrivateSourceEnv } from "../src/index";
import { seedBusiness, fixtureEnv } from "./entrypoint-fixture";
import { rpcResultScope } from "../../src/rpc-result";
import { exportPrivateBackup } from "../src/backup";
import { PrivateSourceSqlStore } from "../src/store";
import { RECOVERY_WIRE_BUNDLE, RECOVERY_WIRE_TARGET } from "./recovery-wire-fixture";

const testEnv = env as unknown as PrivateSourceEnv & {
  TEST_RECOVERY_STATE: DurableObjectNamespace<RecoveryState>;
  TEST_RECOVERY_RPC: { restore(command: unknown): Promise<{ ok: boolean; code?: string }> };
};
async function fixture(name: string, kind: "BUSINESS" | "PRIVATE" = "BUSINESS") {
  const f = await seedBusiness(`quarantine_${name}`), pin = (await f.call("/internal/c2/pin-source-authority", f.command)).pin;
  let bundle: any;
  if (kind === "BUSINESS") {
    const response = await f.call("/internal/c1/create-backup-snapshot", {
      request_id: `backup_quarantine_${name}`, session_token: f.command.session_token }, "local-c1-test-key");
    const manifest = response.result.manifest, chunks: unknown[] = [];
    for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) {
      const part = await f.call("/internal/c1/get-backup-chunk", { request_id: `backup_quarantine_${name}_${chunk_index}`,
        session_token: f.command.session_token, snapshot_id: manifest.snapshot_id, chunk_index }, "local-c1-test-key");
      chunks.push(part.chunk);
    }
    bundle = { manifest, chunks };
  } else {
    bundle = await runInDurableObject(testEnv.TEST_RECOVERY_STATE.getByName(`recovery-quarantine-original-${name}`), async (_instance, ctx) => {
      const store = new PrivateSourceSqlStore(ctx.storage), key = "e".repeat(43);
      await store.compareAndSet(key, null, { key, revision: 1, pending: { request_text: "ORIGINAL_UNKNOWN_SOURCE_REQUEST" },
        source_operation_id: pin.source.source_operation_id, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
      return exportPrivateBackup(ctx.storage, sourceObjectName(pin));
    });
  }
  const target_name = `recovery-quarantine-${name}-copy-0001`;
  const command = { ...f.command, kind, bundle, target_name };
  const configured: RecoveryEnv = { ...testEnv, RECOVERY_STATE: testEnv.TEST_RECOVERY_STATE, RECOVERY_TARGET_NAME: target_name,
    RECOVERY_BUSINESS_DIGEST: kind === "BUSINESS" ? bundle.manifest.content_digest : undefined,
    RECOVERY_PRIVATE_DIGEST: kind === "PRIVATE" ? bundle.manifest.content_digest : undefined,
    RECOVERY_SOURCE_OBJECT_NAME: kind === "PRIVATE" ? sourceObjectName(pin) : undefined };
  const stub = testEnv.TEST_RECOVERY_STATE.getByName(target_name);
  const invoke = (input = command, overrides: Partial<RecoveryEnv> = {}) =>
    runInDurableObject(stub, (_instance, ctx) => new RecoveryState(ctx, { ...configured, ...overrides }).restore(input));
  const tables = () => runInDurableObject(stub, (_instance, ctx) =>
    ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").toArray());
  return { f, pin, bundle, command, configured, invoke, tables, stub };
}
afterEach(() => vi.restoreAllMocks());

describe("isolated RecoveryState namespace and current authority gate", () => {
  it("has no HTTP surface and refuses RecoveryRuntime commands outside its allowlist", async () => {
    expect(recoveryWorker.fetch().status).toBe(404);
    using result = rpcResultScope(await testEnv.TEST_RECOVERY_RPC.restore({ target_name: "untrusted", kind: "BUSINESS", bundle: {} }));
    expect(result.value).toMatchObject({ ok: false, code: "RECOVERY_UNCONFIRMED" });
    expect(Object.getOwnPropertyNames(RecoveryState.prototype)).not.toContain("alarm");
    expect(Object.getOwnPropertyNames(RecoveryState.prototype)).not.toContain("execute");
  });

  it("restores a fixed allowed bundle through business HTTP, named RecoveryRuntime and its independent SQLite namespace", async () => {
    const f = await seedBusiness("quarantine_wire");
    await f.call("/internal/c2/pin-source-authority", f.command);
    const command = { ...f.command, kind: "BUSINESS", bundle: RECOVERY_WIRE_BUNDLE, target_name: RECOVERY_WIRE_TARGET };
    const restored = await f.call("/internal/c2/restore-isolated-backup", command);
    expect(restored.result).toMatchObject({ state: "ISOLATED_RESTORED", schema_version: 16, table_count: 51,
      execution_enabled: false, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
    const stub = testEnv.TEST_RECOVERY_STATE.getByName(RECOVERY_WIRE_TARGET);
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT value FROM app_meta WHERE key='schema_version'").one().value).toBe("16");
      expect(ctx.storage.sql.exec("SELECT * FROM recovery_seal").toArray()).toHaveLength(1);
      expect(ctx.storage.sql.exec("SELECT * FROM coach_sessions").toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
    await evictDurableObject(stub);
    const response = await fixtureEnv.TEST_BUSINESS_API.fetch(new Request("https://business.test/internal/c2/restore-isolated-backup", {
      method: "POST", headers: { authorization: "Bearer local-c2-test-key", "content-type": "application/json" },
      body: JSON.stringify(command) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "RECOVERY_UNCONFIRMED" } });
  });

  it.each(["BUSINESS", "PRIVATE"] as const)("restores %s only in a fresh separate quarantine object, surviving actual eviction without execution", async kind => {
    const item = await fixture(`success_${kind.toLowerCase()}`, kind), google = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("UNEXPECTED_GOOGLE"));
    expect(await item.tables()).toEqual([]);
    const result = await item.invoke();
    expect(result).toMatchObject({ ok: true, data: { execution_enabled: false, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false } });
    await runInDurableObject(item.stub, (_instance, ctx) => {
      expect(ctx.storage.sql.exec("SELECT * FROM recovery_seal").toArray()).toHaveLength(1);
      if (kind === "BUSINESS") {
        expect(ctx.storage.sql.exec("SELECT * FROM coach_sessions").toArray()).toEqual([]);
        expect(ctx.storage.sql.exec<{ pin_text: string }>("SELECT pin_text FROM source_authority_pins WHERE season_id=?", item.f.season).one().pin_text).toContain(item.pin.source.source_operation_id);
      } else expect(ctx.storage.sql.exec("SELECT * FROM source_private_records").toArray().length).toBeGreaterThan(0);
    });
    const stored = await item.tables(); await evictDurableObject(item.stub); expect(await item.tables()).toEqual(stored);
    expect(await item.invoke()).toMatchObject({ ok: false, code: "RECOVERY_UNCONFIRMED" });
    expect(google).not.toHaveBeenCalled();
  });

  it.each(["no-target", "wrong-target", "no-digest", "wrong-digest", "session", "extra-field", "private-scope"])(
    "rejects %s commands with fixed errors before initializing a namespace", async mode => {
      const item = await fixture(`deny_${mode.replaceAll("-", "_")}`, mode === "private-scope" ? "PRIVATE" : "BUSINESS");
      const command: any = structuredClone(item.command), overrides: Partial<RecoveryEnv> = {};
      if (mode === "no-target") overrides.RECOVERY_TARGET_NAME = undefined;
      if (mode === "wrong-target") command.target_name = "recovery-quarantine-another-copy-0001";
      if (mode === "no-digest") overrides.RECOVERY_BUSINESS_DIGEST = undefined;
      if (mode === "wrong-digest") overrides.RECOVERY_BUSINESS_DIGEST = `sha256_v1:${"a".repeat(43)}`;
      if (mode === "session") command.session_token = "forged.token";
      if (mode === "extra-field") command.sql = "DROP TABLE seasons";
      if (mode === "private-scope") overrides.RECOVERY_SOURCE_OBJECT_NAME = "c2-private-source-v1:other_team:other_operation";
      expect(await item.invoke(command, overrides)).toEqual({ ok: false, code: "RECOVERY_UNCONFIRMED" });
      expect(await item.tables()).toEqual([]);
    });

  it("refuses a current Coach revoked during digest verification and does not leave partial restored rows", async () => {
    const item = await fixture("revoke"), authority = testEnv.BUSINESS_SOURCE_AUTHORITY!;
    let calls = 0;
    const gate = { async pin(command: Parameters<typeof authority.pin>[0]) {
      if (++calls === 2) await item.f.logout();
      return authority.pin(command);
    } };
    expect(await item.invoke(item.command, { BUSINESS_SOURCE_AUTHORITY: gate })).toEqual({ ok: false, code: "RECOVERY_UNCONFIRMED" });
    expect(calls).toBe(2); expect(await item.tables()).toEqual([]);
  });
});
