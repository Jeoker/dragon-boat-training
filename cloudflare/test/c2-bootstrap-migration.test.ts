import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { applySchema } from "../src/schema";
import { BUSINESS_BACKUP_TABLES } from "../src/c2-backup-recovery";
import { dumpTables, schemaShape, seedBackupTables } from "./backup-recovery-fixture";

const oldTables = [...BUSINESS_BACKUP_TABLES.slice(0, 47), "coach_sessions"];
const addedTables = [...BUSINESS_BACKUP_TABLES.slice(47)];
async function legacy(ctx: DurableObjectState) {
  seedBackupTables(ctx.storage.sql, oldTables);
  for (const table of [...addedTables].reverse()) ctx.storage.sql.exec(`DROP TABLE ${table}`).toArray();
  ctx.storage.sql.exec("UPDATE app_meta SET value='14' WHERE key='schema_version'").toArray();
  await ctx.storage.deleteAlarm();
  return { rows: dumpTables(ctx.storage.sql, oldTables), shape: schemaShape(ctx.storage.sql, oldTables) };
}
const inStorage = (name: string, work: (ctx: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.TEAM_STATE.getByName(`bootstrap-migration-${name}`), (_instance, ctx) => work(ctx));

describe("first schema16 isolated release upgrades the existing database", () => {
  it("preserves every original table, session and constraint, adds four empty tables and is idempotent without Google or alarms", async () => {
    await inStorage("preserve", async ctx => {
      const original = await legacy(ctx);
      const google = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("NO_GOOGLE_DURING_SCHEMA_UPGRADE"));
      try {
        applySchema(ctx.storage);
        const expected = structuredClone(original.rows);
        expected.app_meta = expected.app_meta.map(row => row.key === "schema_version" ? { ...row, value: "16" } : row);
        expect(dumpTables(ctx.storage.sql, oldTables)).toEqual(expected);
        expect(schemaShape(ctx.storage.sql, oldTables)).toEqual(original.shape);
        for (const table of addedTables) expect(ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
        expect(ctx.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
        const upgradedShape = schemaShape(ctx.storage.sql, [...oldTables, ...addedTables]);
        applySchema(ctx.storage);
        expect(dumpTables(ctx.storage.sql, oldTables)).toEqual(expected);
        expect(schemaShape(ctx.storage.sql, [...oldTables, ...addedTables])).toEqual(upgradedShape);
        expect(await ctx.storage.getAlarm()).toBeNull();
        expect(google).not.toHaveBeenCalled();
      } finally { google.mockRestore(); }
    });
  });

  it("rolls back all additive DDL when an existing new table has an incompatible definition", async () => {
    await inStorage("incompatible", async ctx => {
      const original = await legacy(ctx);
      ctx.storage.sql.exec("CREATE TABLE annual_archive_plans (snapshot_id TEXT PRIMARY KEY, retain_original TEXT)").toArray();
      const before = ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").toArray();
      expect(() => applySchema(ctx.storage)).toThrow();
      expect(dumpTables(ctx.storage.sql, oldTables)).toEqual(original.rows);
      expect(ctx.storage.sql.exec("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").toArray()).toEqual(before);
    });
  });

  it("refuses a future schema without changing old data or creating new tables", async () => {
    await inStorage("future", async ctx => {
      await legacy(ctx);
      ctx.storage.sql.exec("UPDATE app_meta SET value='17' WHERE key='schema_version'").toArray();
      const rows = dumpTables(ctx.storage.sql, oldTables);
      expect(() => applySchema(ctx.storage)).toThrow("Unsupported database schema version 17.");
      expect(dumpTables(ctx.storage.sql, oldTables)).toEqual(rows);
      for (const table of addedTables) expect(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name=?", table).toArray()).toEqual([]);
    });
  });
});
