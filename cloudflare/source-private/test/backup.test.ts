import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPrivateBackup, PRIVATE_BACKUP_LIMITS, restorePrivateBackup } from "../src/backup";
import { PrivateSourceSqlStore } from "../src/store";
import type { PrivateSourceEnv } from "../src/index";
import { sha256Base64Url } from "../../src/crypto";
import { sourceCanonical, type SourceJson } from "../../../shared/c2-source-capture-contract";
import { sourceObjectName } from "../src/runtime";
import { seedBusiness, googleModel, target } from "./entrypoint-fixture";

const privateEnv = env as unknown as PrivateSourceEnv;
const stub = (name: string) => privateEnv.PRIVATE_SOURCE_STATE.getByName(name);
const sqlRun = <T>(name: string, work: (ctx: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stub(name), (_instance, ctx) => work(ctx));
const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
const objectName = "c2-private-source-v1:fixture_team:fixture_operation";
async function blank(ctx: DurableObjectState) {
  expect(ctx.storage.sql.exec("SELECT * FROM source_private_records").toArray()).toEqual([]);
  ctx.storage.sql.exec("DROP TABLE source_private_chunks; DROP TABLE source_private_records; DROP TABLE source_private_schema");
}
async function simpleBundle(name: string) {
  return sqlRun(`backup-source-${name}`, async ctx => {
    const store = new PrivateSourceSqlStore(ctx.storage);
    const key = "a".repeat(43), key2 = "b".repeat(43);
    for (let revision = 1; revision <= 7; revision++) expect(await store.compareAndSet(key, revision === 1 ? null : revision - 1,
      { key, revision, raw: "原候选 😀".repeat(8_000), source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false })).toBe(true);
    expect(await store.compareAndSet(key2, null, { key: key2, revision: 1, pending: { request_text: "ORIGINAL_UNKNOWN_REQUEST" } })).toBe(true);
    return exportPrivateBackup(ctx.storage, objectName);
  });
}
async function reseal(bundle: any) {
  const { content_digest: _, ...core } = bundle.manifest;
  bundle.manifest.content_digest = await sha256Base64Url(canonical(core));
  return bundle;
}
const rows = (ctx: DurableObjectState) => ({ records: ctx.storage.sql.exec("SELECT * FROM source_private_records ORDER BY key").toArray(),
  chunks: ctx.storage.sql.exec("SELECT key,chunk_index,hex(bytes) bytes FROM source_private_chunks ORDER BY key,chunk_index").toArray() });
afterEach(() => vi.restoreAllMocks());

describe("separate private SQLite backup and sealed recovery", () => {
  it("preserves real candidate, Google journal receipt, checkpoint and append-only review evidence through a sealed copy and actual eviction", async () => {
    const f = await seedBusiness("backup_real"), pin = (await f.call("/internal/c2/pin-source-authority", f.command)).pin;
    const name = sourceObjectName(pin), original = stub(name), model = googleModel(pin);
    expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    expect((await f.run("capture")).ok).toBe(true);
    expect((await f.run("stage", { confirm_private_journal: true })).ok).toBe(true);
    const view = await f.run("review-view"); if (!view.ok) throw Error("View not confirmed");
    const command_text = JSON.stringify({ request_id: "backup_review_append", local_snapshot_id: view.data.result.anchor.local_snapshot_id,
      row_index: 1, response_id: "fixture_response", expected_sheet_digest: view.data.result.sheet_records[0].content_digest,
      expected_form_digest: view.data.result.form_records[0].content_digest, decision: "CONFIRM_LINK", reason: "REVIEWED_FIXED_RECORDS" });
    expect((await f.run("review-append", { command_text })).ok).toBe(true);
    const before = await runInDurableObject(original, (_instance, ctx) => rows(ctx));
    const exported = await f.run("backup", { confirm_private_backup: true });
    expect(exported.ok).toBe(true); if (!exported.ok) throw Error("Backup not confirmed");
    const bundle = exported.data;
    expect(bundle.manifest.object_name).toBe(name);
    const targetName = "backup-sealed-copy-real", restored = stub(targetName), calls = model.spy.mock.calls.length;
    await sqlRun(targetName, async ctx => {
      await blank(ctx);
      expect(await restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest)).toMatchObject({
        state: "ISOLATED_PRIVATE_RESTORED", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, execution_enabled: false });
      expect(rows(ctx)).toEqual(before);
      const store = new PrivateSourceSqlStore(ctx.storage), text: string[] = [];
      for (const record of bundle.manifest.records) text.push(canonical(await store.read(record.key)));
      expect(text.join("\n")).toContain("c2-private-source-review-ledger-v1");
      expect(text.join("\n")).toContain("JOURNAL_READBACK_CONFIRMED");
      expect(text.join("\n")).not.toMatch(/FICTIONAL_ACCESS_TOKEN|FICTIONAL_REFRESH_TOKEN|session_token/);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
    await evictDurableObject(restored);
    expect(await sqlRun(targetName, ctx => rows(ctx))).toEqual(before);
    expect(model.spy.mock.calls.length).toBe(calls);
    expect(await restored.execute({ ...f.command, action: "resume" })).toEqual({ ok: false, code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" });
    await f.logout();
    expect(await f.run("backup", { confirm_private_backup: true })).toEqual({ ok: false, code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" });
    expect(model.spy.mock.calls.length).toBe(calls);
  });

  it("copies unresolved original source requests as unresolved facts without retrying Google", async () => {
    const f = await seedBusiness("backup_unknown"), pin = (await f.call("/internal/c2/pin-source-authority", f.command)).pin;
    const model = googleModel(pin); expect((await f.run("register", { target: target(pin) })).ok).toBe(true);
    model.state.failSource = true; expect((await f.run("capture")).ok).toBe(false);
    const exported = await f.run("backup", { confirm_private_backup: true });
    if (!exported.ok) throw Error("Unknown request backup rejected");
    const bundle = exported.data, calls = model.spy.mock.calls.length;
    await sqlRun("backup-unknown-copy", async ctx => {
      await blank(ctx); await restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest);
      const store = new PrivateSourceSqlStore(ctx.storage);
      const values = await Promise.all(bundle.manifest.records.map((record: any) => store.read(record.key)));
      expect(values.some(value => (value as any)?.format === "c2-private-source-read-v1" && (value as any).pending !== null)).toBe(true);
      expect(ctx.storage.sql.exec("SELECT * FROM recovery_seal").toArray()).toHaveLength(1);
    });
    expect(model.spy.mock.calls.length).toBe(calls);
  });

  it.each(["schema", "record-order", "duplicate-record", "revision", "missing-chunk", "chunk-order", "chunk-count", "duplicate-chunk",
    "payload-change", "invalid-base64", "invalid-utf8", "invalid-json", "total", "unknown-field"])(
    "rejects %s backup corruption before creating any target table", async mode => {
      const bundle: any = await simpleBundle(`bad-${mode}`);
      if (mode === "schema") bundle.manifest.schema_version = 2;
      if (mode === "record-order") bundle.manifest.records.reverse();
      if (mode === "duplicate-record") bundle.manifest.records[1] = structuredClone(bundle.manifest.records[0]);
      if (mode === "revision") bundle.manifest.records[0].revision++;
      if (mode === "missing-chunk") bundle.chunks.pop();
      if (mode === "chunk-order") [bundle.chunks[0], bundle.chunks[1]] = [bundle.chunks[1], bundle.chunks[0]];
      if (mode === "chunk-count") bundle.manifest.records[0].chunk_count++;
      if (mode === "duplicate-chunk") bundle.chunks[1] = structuredClone(bundle.chunks[0]);
      if (mode === "payload-change") bundle.chunks[0].bytes_base64 = "eA==";
      if (mode === "invalid-base64") bundle.chunks[0].bytes_base64 = "@@@@";
      if (mode === "invalid-utf8") bundle.chunks[0].bytes_base64 = btoa("\xff".repeat(64_000));
      if (mode === "invalid-json") bundle.chunks[0].bytes_base64 = btoa("!".repeat(64_000));
      if (mode === "total") bundle.manifest.total_bytes++;
      if (mode === "unknown-field") bundle.manifest.raw_authorization = "PRIVATE_SENTINEL";
      await reseal(bundle);
      await sqlRun(`reject-private-${mode}`, async ctx => {
        await blank(ctx);
        await expect(restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest)).rejects.toThrow();
        expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
      });
    });

  it("keeps original revision CAS semantics and refuses nonempty destinations and concurrent second restores", async () => {
    const bundle = await simpleBundle("cas"), name = "private-restored-cas";
    await sqlRun(name, async ctx => {
      await blank(ctx);
      const settled = await Promise.allSettled([restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest),
        restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest)]);
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const store = new PrivateSourceSqlStore(ctx.storage), record: any = await store.read("a".repeat(43));
      expect(record.revision).toBe(7);
      expect(await store.compareAndSet(record.key, 6, { ...record, revision: 7 })).toBe(false);
      expect(await store.compareAndSet(record.key, 7, { ...record, revision: 8 })).toBe(true);
      const before = rows(ctx);
      await expect(restorePrivateBackup(ctx.storage, bundle, bundle.manifest.content_digest)).rejects.toThrow("PRIVATE_BACKUP_UNCONFIRMED");
      expect(rows(ctx)).toEqual(before);
    });
  });

  it("rolls back schema and prior chunks after a partial SQL failure and denies a revoked restore before touching SQLite", async () => {
    const bundle = await simpleBundle("fault");
    for (const mode of ["sql", "revoked"]) await sqlRun(`private-fault-${mode}`, async ctx => {
      await blank(ctx);
      const sql = new Proxy(ctx.storage.sql, { get(target, key) {
        if (key === "exec") return (query: string, ...args: SqlStorageValue[]) => {
          if (mode === "sql" && query.startsWith("INSERT INTO source_private_chunks") && args[1] === 1) throw Error("AFTER_FIRST_CHUNK_SENTINEL");
          return target.exec(query, ...args);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(restorePrivateBackup({ sql, transactionSync: ctx.storage.transactionSync.bind(ctx.storage) }, bundle,
        bundle.manifest.content_digest, async () => { if (mode === "revoked") throw Error("REVOKED_COACH_SENTINEL"); })).rejects.toThrow();
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
    });
  });

  it.each(["bytes", "records", "orphan", "text-blob", "missing-schema", "schema-version", "wrong-ddl"])("rejects %s store export before materializing an invalid backup", async mode => {
    await sqlRun(`export-budget-${mode}`, async ctx => {
      const store = new PrivateSourceSqlStore(ctx.storage), key = "c".repeat(43);
      await store.compareAndSet(key, null, { key, revision: 1, raw: "bound original" });
      if (mode === "bytes") ctx.storage.sql.exec("UPDATE source_private_records SET byte_count=?", PRIVATE_BACKUP_LIMITS.totalBytes + 1);
      if (mode === "records") ctx.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<128)
        INSERT INTO source_private_records SELECT printf('%043d',x),1,1,1,? FROM n`, "d".repeat(43));
      if (mode === "orphan") ctx.storage.sql.exec("INSERT INTO source_private_chunks VALUES (?,?,?)", "d".repeat(43), 0, new Uint8Array([1]).buffer);
      if (mode === "text-blob") ctx.storage.sql.exec("UPDATE source_private_chunks SET bytes='PRIVATE_TEXT_BLOB'");
      if (mode === "missing-schema") ctx.storage.sql.exec("DROP TABLE source_private_schema");
      if (mode === "schema-version") ctx.storage.sql.exec("UPDATE source_private_schema SET version=2");
      if (mode === "wrong-ddl") {
        ctx.storage.sql.exec("DROP TABLE source_private_chunks");
        ctx.storage.sql.exec("CREATE TABLE source_private_chunks(record_key TEXT, chunk_index INTEGER, bytes BLOB)");
      }
      await expect(exportPrivateBackup(ctx.storage, objectName)).rejects.toThrow();
    });
  });
});
