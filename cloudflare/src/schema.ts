export const APPLICATION_SCHEMA_VERSION = 1;

export function applySchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS c0_counters (
        counter_name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS system_requests (
        request_key TEXT PRIMARY KEY,
        actor_scope TEXT NOT NULL,
        action TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COMPLETED')),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE (actor_scope, action, request_id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL,
        actor_scope TEXT NOT NULL,
        action TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
      );
      CREATE TABLE IF NOT EXISTS sync_outbox (
        outbox_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
        due_at_ms INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
      );
      CREATE INDEX IF NOT EXISTS sync_outbox_due_idx
        ON sync_outbox(status, due_at_ms);
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED')),
        due_at_ms INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until_ms INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx
        ON scheduled_jobs(status, due_at_ms, lease_until_ms);
    `).toArray();

    const current = sql
      .exec<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .toArray()[0];
    if (current && Number(current.value) > APPLICATION_SCHEMA_VERSION) {
      throw new Error(`Unsupported database schema version ${current.value}.`);
    }
    sql.exec(
      `INSERT INTO app_meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(APPLICATION_SCHEMA_VERSION)
    ).toArray();
  });
}
