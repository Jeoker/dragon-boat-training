// Local-only original-package drill. No business worker, auth service or alarm.
import { DurableObject } from "cloudflare:workers";
import { applySchema } from "../src/schema";
import { BUSINESS_BACKUP_TABLES, restoreBusinessBackup, verifyBusinessBackup } from "../src/c2-backup-recovery";
import { canonicalJson } from "../../shared/c1-rules";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const requireTrue = (value: boolean) => { if (!value) throw Error("LOCAL_DRILL_UNCONFIRMED"); };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export class OriginalBackupLocalDrill extends DurableObject {
  shape() {
    return Object.fromEntries(BUSINESS_BACKUP_TABLES.map(table => [table, {
      columns: this.ctx.storage.sql.exec(`PRAGMA table_info(${quote(table)})`).toArray(),
      foreign_keys: this.ctx.storage.sql.exec(`PRAGMA foreign_key_list(${quote(table)})`).toArray(),
      indexes: this.ctx.storage.sql.exec<{name:string}>(`PRAGMA index_list(${quote(table)})`).toArray().map(index => ({
        ...index, columns: this.ctx.storage.sql.exec(`PRAGMA index_info(${quote(index.name)})`).toArray() }))
    }]));
  }
  async oracle() { applySchema(this.ctx.storage); return this.shape(); }
  async drill(bundle: unknown, expectedDigest: string, oracle: unknown) {
    const checked = await verifyBusinessBackup(bundle);
    requireTrue(checked.manifest.content_digest === expectedDigest && checked.sourceSchemaVersion === 14);
    const result = await restoreBusinessBackup(this.ctx.storage, bundle, expectedDigest);
    const sql = this.ctx.storage.sql;
    let comparedRows = 0;
    for (const [table, original] of checked.tables) {
      const expected = table === "app_meta" ? original.map(row => row.key === "schema_version" ? { ...row, value: "16" } : row) : original;
      requireTrue(equal(sql.exec(`SELECT * FROM ${quote(table)} ORDER BY rowid`).toArray(), expected));
      comparedRows += original.length;
    }
    requireTrue(equal(this.shape(), oracle));
    const added = BUSINESS_BACKUP_TABLES.slice(47);
    for (const table of [...added, "coach_sessions", "backup_snapshots", "backup_snapshot_chunks"])
      requireTrue(sql.exec<{n:number}>(`SELECT COUNT(*) n FROM ${quote(table)}`).one().n === 0);
    requireTrue(sql.exec("PRAGMA foreign_key_check").toArray().length === 0);
    requireTrue(equal(sql.exec("SELECT * FROM recovery_seal").toArray(), [{id:1,content_digest:expectedDigest,source_schema:14}]));
    requireTrue(await this.ctx.storage.getAlarm() === null);
    const constraintProbe = (query: string, values: SqlStorageValue[] = []) => {
      let rejected = false;
      try { this.ctx.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys=OFF").toArray();
        try { sql.exec(query, ...values).toArray(); } catch { rejected = true; }
        throw Error("LOCAL_PROBE_ROLLBACK");
      }); } catch { /* Always roll back even a failed assertion probe. */ }
      requireTrue(rejected); return rejected;
    };
    const checkConstraint = constraintProbe("UPDATE coaches SET active=2");
    const coach = sql.exec<Record<string,SqlStorageValue>>("SELECT * FROM coaches ORDER BY rowid LIMIT 1").one();
    const columns = Object.keys(coach);
    const primaryKey = constraintProbe(`INSERT INTO coaches (${columns.map(quote).join(",")}) VALUES (${columns.map(()=>"?").join(",")})`, columns.map(name=>coach[name]));
    const foreignKey = constraintProbe("UPDATE members SET season_id='local_drill_missing_parent' WHERE rowid=(SELECT rowid FROM members LIMIT 1)");
    // All probes must leave original rows exactly intact.
    for (const [table, original] of checked.tables) {
      const expected = table === "app_meta" ? original.map(row => row.key === "schema_version" ? { ...row, value: "16" } : row) : original;
      requireTrue(equal(sql.exec(`SELECT * FROM ${quote(table)} ORDER BY rowid`).toArray(), expected));
    }
    let repeatedRestoreRejected = false;
    try { await restoreBusinessBackup(this.ctx.storage,bundle,expectedDigest); } catch { repeatedRestoreRejected = true; }
    requireTrue(repeatedRestoreRejected && await this.ctx.storage.getAlarm() === null);
    return { status:"ORIGINAL_BUSINESS_BACKUP_LOCAL_SQLITE_DRILL_PASSED", result,
      original_table_count:checked.tables.size, original_row_count:comparedRows, original_rows_equal:true,
      reviewed_ddl_columns_foreign_keys_indexes_equal:true, foreign_key_check_count:0,
      check_constraint_rejected:checkConstraint, primary_key_rejected:primaryKey, foreign_key_rejected:foreignKey,
      added_tables_empty:added, sessions_and_backup_tables_empty:true, sealed:true, repeated_restore_rejected:true,
      alarm_absent:true, online_activation:false, authority_gate_tested:false };
  }
}
type DrillEnv = { LOCAL_DRILL: DurableObjectNamespace<OriginalBackupLocalDrill> };
export default { async fetch(request: Request, env: DrillEnv) {
  try {
    const { bundle, expectedDigest } = await request.json() as {bundle:unknown;expectedDigest:string};
    const oracle = await env.LOCAL_DRILL.getByName("local-reviewed-ddl-oracle").oracle();
    using result = await env.LOCAL_DRILL.getByName("local-original-sealed-target").drill(bundle, expectedDigest, oracle);
    return Response.json(JSON.parse(JSON.stringify(result)));
  } catch { return Response.json({status:"LOCAL_DRILL_UNCONFIRMED"},{status:400}); }
} } satisfies ExportedHandler<DrillEnv>;
