import { BACKUP_TABLES } from "../../shared/c2-business-backup-tables";
import { verifyBusinessBackup } from "../../shared/c2-business-backup";
export { verifyBusinessBackup, type BusinessBackupBundle } from "../../shared/c2-business-backup";
import { applySchema } from "./schema";
import { canonicalJson } from "../../shared/c1-rules";

export const BUSINESS_BACKUP_TABLES = BACKUP_TABLES;
type Row = Record<string, SqlStorageValue>;
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
const fail = (): never => { throw new Error("RECOVERY_UNCONFIRMED"); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const digest = (v: unknown): string => typeof v === "string" && /^sha256_v1:[A-Za-z0-9_-]{43}$/u.test(v) ? v : fail();


/** Restores real SQLite only into a never-initialized quarantine object. This
 * module has no alarm, business service, source authority or Google transport. */
export async function restoreBusinessBackup(storage: Storage, bundle: unknown, expectedDigest: string, authorize?: () => Promise<void>) {
  const checked = await verifyBusinessBackup(bundle);
  if (digest(expectedDigest) !== checked.manifest.content_digest) fail();
  await authorize?.();
  return storage.transactionSync(() => {
    if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").toArray().length) fail();
    // All table definitions, constraints and indexes come from reviewed code.
    applySchema(storage as DurableObjectStorage);
    storage.sql.exec("DELETE FROM app_meta");
    storage.sql.exec("PRAGMA defer_foreign_keys=ON");
    for (const [table, rows] of checked.tables) {
      const columns = storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(row => row.name);
      for (const row of rows) {
        if (!same(Object.keys(row).sort(), [...columns].sort())) fail();
        storage.sql.exec(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, ...columns.map(column => row[column]));
      }
    }
    if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length) fail();
    // 14→16 is additive: original 47 tables remain, annual/pin four are empty.
    applySchema(storage as DurableObjectStorage);
    for (const [table, original] of checked.tables) {
      const actual = storage.sql.exec<Row>(`SELECT * FROM ${table} ORDER BY rowid`).toArray();
      const expected = table === "app_meta" ? original.map(row => row.key === "schema_version" ? { ...row, value: "16" } : row) : original;
      if (!same(actual, expected)) fail();
    }
    if (storage.sql.exec("PRAGMA foreign_key_check").toArray().length) fail();
    storage.sql.exec("CREATE TABLE recovery_seal (id INTEGER PRIMARY KEY CHECK(id=1), content_digest TEXT NOT NULL, source_schema INTEGER NOT NULL)");
    storage.sql.exec("INSERT INTO recovery_seal VALUES (1,?,?)", expectedDigest, checked.sourceSchemaVersion);
    return { state: "ISOLATED_RESTORED" as const, schema_version: 16, source_schema_version: checked.sourceSchemaVersion,
      table_count: 51, source_content_digest: expectedDigest, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, execution_enabled: false };
  });
}
