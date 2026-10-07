import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_BACKUP_TABLES, restoreBusinessBackup, verifyBusinessBackup } from "../src/c2-backup-recovery";
import { C1HistoryService } from "../src/c1-history-service";
import { C1Service } from "../src/c1-service";
import { legacyCredentialDigest } from "../src/crypto";
import { bundleFromRows, dumpTables, resealBundle, schemaShape, seedBackupTables } from "./backup-recovery-fixture";

const target = (name: string) => env.TEAM_STATE.getByName(`recovery-test-only-${name}`);
const inSql = <T>(name: string, work: (ctx: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(target(name), (_instance, ctx) => work(ctx));
async function emptyStorage(ctx: DurableObjectState) {
  // These dedicated local fixtures start with an empty TeamState schema. They
  // exercise the pure quarantine helper, never a restored live TeamState.
  expect(ctx.storage.sql.exec("SELECT COUNT(*) n FROM members").one().n).toBe(0);
  for (const row of ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray().reverse())
    ctx.storage.sql.exec(`DROP TABLE "${row.name}"`).toArray();
  await ctx.storage.deleteAlarm();
}
async function source(name: string) {
  return inSql(`source-${name}`, async ctx => {
    seedBackupTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES);
    return { rows: dumpTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES), shape: schemaShape(ctx.storage.sql, BUSINESS_BACKUP_TABLES) };
  });
}
afterEach(() => vi.restoreAllMocks());

describe("isolated business backup recovery", () => {
  it("downloads a real authenticated 51-table snapshot and restores every exported row and schema constraint without sessions or execution", async () => {
    const original = await inSql("real-source", async ctx => {
      seedBackupTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES);
      ctx.storage.sql.exec("UPDATE coaches SET code_salt='restore_salt',code_digest=?",
        await legacyCredentialDigest("restore_salt", "fixture-restore-code", "local-c1-coach-secret"));
      const login: any = await new C1Service(ctx, env).handle("/internal/c1/coach-login", {
        request_id: "restore_fixture_login", coach_code: "fixture-restore-code" });
      const token = login.result.session_token;
      const rows = dumpTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES);
      const history = new C1HistoryService(ctx, env), response: any = await history.handle("/internal/c1/create-backup-snapshot",
        { request_id: "restore_fixture_backup", session_token: token });
      const manifest = response.result.manifest, chunks: any[] = [];
      for (let chunk_index = 0; chunk_index < manifest.chunk_count; chunk_index++) {
        const part: any = await history.handle("/internal/c1/get-backup-chunk", { request_id: `restore_get_chunk_${chunk_index}`,
          session_token: token, snapshot_id: manifest.snapshot_id, chunk_index });
        chunks.push(part.chunk);
      }
      return { bundle: { manifest, chunks }, rows, token, shape: schemaShape(ctx.storage.sql, BUSINESS_BACKUP_TABLES) };
    });
    expect(original.bundle.manifest.table_count).toBe(51);
    expect(original.bundle.manifest.tables.every((table: any) => table.row_count > 0)).toBe(true);
    expect((await verifyBusinessBackup(original.bundle)).tables.size).toBe(51);
    const google = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("UNEXPECTED_GOOGLE_CALL"));
    await inSql("real-target", async ctx => {
      await emptyStorage(ctx);
      const result = await restoreBusinessBackup(ctx.storage, original.bundle, original.bundle.manifest.content_digest);
      expect(result).toMatchObject({ state: "ISOLATED_RESTORED", schema_version: 16, source_schema_version: 16,
        table_count: 51, execution_enabled: false, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false });
      expect(dumpTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES)).toEqual(original.rows);
      expect(schemaShape(ctx.storage.sql, BUSINESS_BACKUP_TABLES)).toEqual(original.shape);
      expect(ctx.storage.sql.exec("SELECT * FROM coach_sessions").toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("SELECT * FROM backup_snapshots").toArray()).toEqual([]);
      await expect(new C1Service(ctx, env).authenticateSession(original.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect(ctx.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      ctx.storage.sql.exec("PRAGMA defer_foreign_keys=OFF");
      expect(() => ctx.storage.sql.exec("DELETE FROM seasons").toArray()).toThrow();
    });
    expect(google).not.toHaveBeenCalled();
  });

  it("upgrades an exact schema14/47-table package additively and preserves original values except the explicit schema metadata", async () => {
    const old = await source("old47"), rows = Object.fromEntries(Object.entries(old.rows).slice(0, 47));
    rows.app_meta = rows.app_meta.map(row => row.key === "schema_version" ? { ...row, value: "14" } : row);
    const bundle = await bundleFromRows(rows, 14);
    await inSql("old47-target", async ctx => {
      await emptyStorage(ctx);
      expect(await restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest)).toMatchObject({ source_schema_version: 14, schema_version: 16 });
      const expected = { ...rows, app_meta: rows.app_meta.map(row => row.key === "schema_version" ? { ...row, value: "16" } : row) };
      expect(dumpTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES.slice(0, 47))).toEqual(expected);
      expect(schemaShape(ctx.storage.sql, BUSINESS_BACKUP_TABLES)).toEqual(old.shape);
      for (const table of BUSINESS_BACKUP_TABLES.slice(47)) expect(ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
      expect(ctx.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });

  it.each(["schema", "unknown-table", "extra-table", "duplicate-table", "manifest-count", "missing-chunk", "chunk-order", "chunk-offset", "payload-hash", "schema-meta"])(
    "rejects %s packages before initializing the target", async mode => {
      const { rows } = await source(`bad-${mode}`), bundle: any = await bundleFromRows(rows);
      if (mode === "schema") bundle.manifest.schema_version = 17;
      if (mode === "unknown-table") bundle.manifest.tables[0].name = "coaches;DROP TABLE seasons";
      if (mode === "extra-table") {
        bundle.manifest.tables.push({ name: "unknown_table", row_count: 0, chunk_indices: [] });
        await resealBundle(bundle);
      }
      if (mode === "duplicate-table") bundle.manifest.tables[1].name = bundle.manifest.tables[0].name;
      if (mode === "manifest-count") bundle.manifest.record_count++;
      if (mode === "missing-chunk") bundle.chunks.pop();
      if (mode === "chunk-order") [bundle.chunks[0], bundle.chunks[1]] = [bundle.chunks[1], bundle.chunks[0]];
      if (mode === "chunk-offset") bundle.chunks[0].payload.row_offset = 1;
      if (mode === "payload-hash") bundle.chunks[0].payload.rows[0].value = "CORRUPT_PRIVATE_SENTINEL";
      if (mode === "schema-meta") { bundle.chunks[0].payload.rows[0].value = "14"; await resealBundle(bundle); }
      await inSql(`reject-${mode}`, async ctx => {
        await emptyStorage(ctx);
        await expect(restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest)).rejects.toThrow("RECOVERY_UNCONFIRMED");
        expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
      });
    });

  it("requires an independently expected digest and never overwrites a nonempty target", async () => {
    const { rows } = await source("expectation"), bundle = await bundleFromRows(rows);
    await inSql("expectation-target", async ctx => {
      await emptyStorage(ctx);
      await expect(restoreBusinessBackup(ctx.storage, bundle, `sha256_v1:${"a".repeat(43)}`)).rejects.toThrow("RECOVERY_UNCONFIRMED");
      ctx.storage.sql.exec("CREATE TABLE existing_private_data (original TEXT); INSERT INTO existing_private_data VALUES ('retain')");
      await expect(restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest)).rejects.toThrow("RECOVERY_UNCONFIRMED");
      expect(ctx.storage.sql.exec("SELECT * FROM existing_private_data").toArray()).toEqual([{ original: "retain" }]);
    });
  });

  it.each(["duplicate-key", "unknown-column", "missing-column", "foreign-key", "sql-fault"])(
    "rolls back all schema and rows for %s instead of leaving a partial target", async mode => {
      const { rows } = await source(`rollback-${mode}`), bundle: any = await bundleFromRows(rows);
      const coaches = bundle.chunks.find((chunk: any) => chunk.table_name === "coaches");
      if (mode === "duplicate-key") {
        coaches.payload.rows.push(structuredClone(coaches.payload.rows[0])); coaches.row_count++;
        bundle.manifest.tables.find((table: any) => table.name === "coaches").row_count++;
        bundle.manifest.chunks[coaches.chunk_index].row_count++; bundle.manifest.record_count++;
      }
      if (mode === "unknown-column") coaches.payload.rows[0].injected_column = "PRIVATE_SENTINEL";
      if (mode === "missing-column") delete coaches.payload.rows[0].display_name;
      if (mode === "foreign-key") bundle.chunks.find((chunk: any) => chunk.table_name === "members").payload.rows[0].season_id = "missing_parent";
      await resealBundle(bundle);
      await inSql(`rollback-target-${mode}`, async ctx => {
        await emptyStorage(ctx);
        const sql = new Proxy(ctx.storage.sql, { get(target, key) {
          if (key === "exec") return (query: string, ...args: SqlStorageValue[]) => {
            if (mode === "sql-fault" && query.startsWith("INSERT INTO members")) throw Error("FAULT_AFTER_PRIOR_ROWS");
            return target.exec(query, ...args);
          };
          const result = Reflect.get(target, key); return typeof result === "function" ? result.bind(target) : result;
        } });
        await expect(restoreBusinessBackup({ sql, transactionSync: ctx.storage.transactionSync.bind(ctx.storage) }, bundle,
          bundle.manifest.content_digest)).rejects.toThrow();
        expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
      });
    });

  it("allows only one concurrent restoration and keeps the first sealed result intact", async () => {
    const { rows } = await source("race"), bundle = await bundleFromRows(rows);
    await inSql("race-target", async ctx => {
      await emptyStorage(ctx);
      const results = await Promise.allSettled([restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest),
        restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(dumpTables(ctx.storage.sql, BUSINESS_BACKUP_TABLES)).toEqual(rows);
      expect(ctx.storage.sql.exec("SELECT * FROM recovery_seal").toArray()).toHaveLength(1);
    });
  });

  it("rechecks current authority and target emptiness after asynchronous verification", async () => {
    const { rows } = await source("authority"), bundle = await bundleFromRows(rows);
    await inSql("revoked-target", async ctx => {
      await emptyStorage(ctx);
      await expect(restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest, async () => {
        throw Error("CURRENT_COACH_REVOKED_SENTINEL");
      })).rejects.toThrow();
      expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
    });
    await inSql("appeared-target", async ctx => {
      await emptyStorage(ctx);
      await expect(restoreBusinessBackup(ctx.storage, bundle, bundle.manifest.content_digest, async () => {
        ctx.storage.sql.exec("CREATE TABLE concurrent_owner (name TEXT); INSERT INTO concurrent_owner VALUES ('winner')");
      })).rejects.toThrow("RECOVERY_UNCONFIRMED");
      expect(ctx.storage.sql.exec("SELECT * FROM concurrent_owner").toArray()).toEqual([{ name: "winner" }]);
    });
  });
});
