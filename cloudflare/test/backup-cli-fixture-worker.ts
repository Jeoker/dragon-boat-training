import { DurableObject } from "cloudflare:workers";
import businessWorker from "../src/index";
import { TeamState } from "../src/team-state";
import { BACKUP_TABLES } from "../src/c1-history-service";
import { legacyCredentialDigest } from "../src/crypto";
import { verifyBusinessBackup, restoreBusinessBackup } from "../src/c2-backup-recovery";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** Test-only SQL integrity data. Every table is nonempty with its real reviewed
 * columns/FKs/CHECK constraints. This is not a simulated production dataset. */
export class BackupFixtureState extends TeamState {
  async persistentRows() {
    return Object.fromEntries(this.ctx.storage.sql.exec<{name:string}>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name"
    ).toArray().map(({name})=>[name,this.ctx.storage.sql.exec(`SELECT * FROM ${quote(name)} ORDER BY rowid`).toArray()]));
  }
  async disableCoach() {
    this.ctx.storage.sql.exec("UPDATE coaches SET active=0 WHERE coach_id='fixture_coach_id'");
    return {ready:true};
  }
  async rotationMaintenanceBaseline() {
    this.ctx.storage.sql.exec("INSERT INTO settings(setting_key,value_json,settings_version,updated_at) VALUES ('history_maintenance_enabled','true',0,?) " +
      "ON CONFLICT(setting_key) DO UPDATE SET value_json='true'", new Date().toISOString()).toArray();
    this.ctx.storage.sql.exec("UPDATE seasons SET status='COMPLETED'").toArray();
    this.ctx.storage.sql.exec("DELETE FROM scheduled_jobs").toArray();
    this.ctx.storage.sql.exec("DELETE FROM usage_snapshots").toArray();
    return {ready:true};
  }
  async facts() {
    return { backups: this.ctx.storage.sql.exec("SELECT COUNT(*) n FROM backup_snapshots").one().n,
      backup_requests: this.ctx.storage.sql.exec("SELECT COUNT(*) n FROM system_requests WHERE action='createBackupSnapshot'").one().n,
      backup_audits: this.ctx.storage.sql.exec("SELECT COUNT(*) n FROM audit_events WHERE action='createBackupSnapshot'").one().n };
  }
  async addSecondCoach() {
    const original = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM coaches ORDER BY coach_id LIMIT 1").one();
    const row = { ...original, coach_id: "fixture_second_coach", code_salt: "fixture_second_salt",
      code_digest: await legacyCredentialDigest("fixture_second_salt", "fixture-second-code", this.env.COACH_CODE_SECRET!) };
    const names = Object.keys(row);
    this.ctx.storage.sql.exec(`INSERT INTO coaches (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`, ...names.map(name => row[name as keyof typeof row]));
    return { ready: true };
  }
  async seed() {
    const sql = this.ctx.storage.sql;
    for (const table of BACKUP_TABLES) {
      if (table === "app_meta" || sql.exec(`SELECT COUNT(*) n FROM ${quote(table)}`).one().n) continue;
      const definition = String(sql.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).one().sql);
      const columns = sql.exec<{ name: string; type: string }>(`PRAGMA table_info(${quote(table)})`).toArray();
      const row: Record<string, SqlStorageValue> = {};
      for (const column of columns) {
        const allowed = new RegExp(`\\b${column.name}\\b[\\s\\S]*?CHECK\\s*\\(\\s*${column.name}\\s+IN\\s*\\(([^)]*)\\)`, "iu").exec(definition);
        const minimum = new RegExp(`CHECK\\s*\\(\\s*${column.name}\\s*>=\\s*(\\d+)`, "iu").exec(definition);
        row[column.name] = /INT/u.test(column.type) ? Math.max(1, Number(minimum?.[1] ?? 1)) :
          allowed?.[1].match(/'([^']*)'/u)?.[1] ?? (column.name.endsWith("_json") ? "{}" :
            /(?:_at|_date)$/u.test(column.name) ? "2020-09-01T12:00:00.000Z" : `fixture_${column.name}`);
      }
      for (const fk of sql.exec<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${quote(table)})`).toArray()) {
        const parent = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${quote(fk.table)} ORDER BY rowid LIMIT 1`).toArray()[0];
        if (!parent) throw Error("FIXTURE_PARENT_MISSING"); row[fk.from] = parent[fk.to];
      }
      const names = columns.map(column => column.name);
      sql.exec(`INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`, ...names.map(name => row[name]));
    }
    if (sql.exec("PRAGMA foreign_key_check").toArray().length) throw Error("FIXTURE_FK_INVALID");
    // Integrity fixtures are retained backup rows, not executable background work.
    sql.exec("UPDATE scheduled_jobs SET status='COMPLETED',completed_at='2020-09-01T12:00:00.000Z'");
    sql.exec("UPDATE coaches SET active=1,code_salt='fixture_cli_salt',code_digest=?,credential_version=1",
      await legacyCredentialDigest("fixture_cli_salt", "fixture-cli-code", this.env.COACH_CODE_SECRET!));
    return { tables: BACKUP_TABLES.map(name => ({ name, count: sql.exec(`SELECT COUNT(*) n FROM ${quote(name)}`).one().n })),
      columns: Object.fromEntries(BACKUP_TABLES.map(table => [table, sql.exec<{ name: string }>(`PRAGMA table_info(${quote(table)})`).toArray().map(row => row.name)])) };
  }
}
export class BackupFixtureRecovery extends DurableObject {
  async verifyAndRestore(bundle: unknown) {
    const checked = await verifyBusinessBackup(bundle);
    const result = await restoreBusinessBackup(this.ctx.storage, bundle, checked.manifest.content_digest as string);
    return { result, tables: [...checked.tables].map(([name, rows]) => ({ name, count: rows.length })),
      restored: Object.fromEntries(BACKUP_TABLES.map(name => [name, this.ctx.storage.sql.exec(`SELECT * FROM ${quote(name)} ORDER BY rowid`).toArray()])) };
  }
}
type FixtureEnv = Env & { FIXTURE_RECOVERY: DurableObjectNamespace<BackupFixtureRecovery> };
export default {
  async fetch(request: Request, env: FixtureEnv) {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/seed") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).seed());
    if (path === "/__fixture/facts") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).facts());
    if (path === "/__fixture/rows") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).persistentRows());
    if (path === "/__fixture/disable-coach") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).disableCoach());
    if (path === "/__fixture/rotation-maintenance") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).rotationMaintenanceBaseline());
    if (path === "/__fixture/second-coach") return Response.json(await (env.TEAM_STATE.getByName(env.TEAM_ID) as unknown as DurableObjectStub<BackupFixtureState>).addSecondCoach());
    if (path === "/__fixture/recover") {
      using result = await env.FIXTURE_RECOVERY.getByName(crypto.randomUUID()).verifyAndRestore(await request.json());
      return Response.json(JSON.parse(JSON.stringify(result)));
    }
    return businessWorker.fetch(request as Parameters<typeof businessWorker.fetch>[0], env);
  }
} satisfies ExportedHandler<FixtureEnv>;
