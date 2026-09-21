export const APPLICATION_SCHEMA_VERSION = 2;

function applyC0Schema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS c0_counters (counter_name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS system_requests (
      request_key TEXT PRIMARY KEY, actor_scope TEXT NOT NULL, action TEXT NOT NULL,
      request_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('COMPLETED')), result_json TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT NOT NULL,
      UNIQUE (actor_scope, action, request_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY, request_key TEXT NOT NULL, actor_scope TEXT NOT NULL,
      action TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      outbox_id TEXT PRIMARY KEY, request_key TEXT NOT NULL, topic TEXT NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
      due_at_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
    CREATE INDEX IF NOT EXISTS sync_outbox_due_idx ON sync_outbox(status, due_at_ms);
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      job_id TEXT PRIMARY KEY, job_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED')),
      due_at_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_until_ms INTEGER, last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(status, due_at_ms, lease_until_ms);
  `).toArray();
}

function applyC1CoreSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS coaches (
      coach_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, code_salt TEXT NOT NULL,
      code_digest TEXT NOT NULL, credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
      active INTEGER NOT NULL CHECK (active IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coach_sessions (
      session_id TEXT PRIMARY KEY, coach_id TEXT NOT NULL, credential_version INTEGER NOT NULL,
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
      backend_generation TEXT NOT NULL, writer_epoch INTEGER NOT NULL,
      FOREIGN KEY (coach_id) REFERENCES coaches(coach_id)
    );
    CREATE INDEX IF NOT EXISTS coach_sessions_coach_idx ON coach_sessions(coach_id, expires_at);
    CREATE TABLE IF NOT EXISTS settings (
      setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
      settings_version INTEGER NOT NULL CHECK (settings_version >= 0), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seasons (
      season_id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      timezone TEXT NOT NULL, season_ends_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'COMPLETED', 'ARCHIVED')),
      binding_version INTEGER NOT NULL CHECK (binding_version >= 0),
      season_version INTEGER NOT NULL CHECK (season_version >= 0),
      roster_version INTEGER NOT NULL CHECK (roster_version >= 0),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seasons_status_idx ON seasons(status, start_date, season_id);
    CREATE TABLE IF NOT EXISTS members (
      season_id TEXT NOT NULL, member_id TEXT NOT NULL, source_key TEXT NOT NULL,
      source_display_name TEXT NOT NULL, display_name_override TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      default_preference TEXT NOT NULL CHECK (default_preference IN ('LEFT', 'AMBIENT', 'RIGHT')),
      member_version INTEGER NOT NULL CHECK (member_version >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, member_id), UNIQUE (season_id, source_key),
      FOREIGN KEY (season_id) REFERENCES seasons(season_id)
    );
    CREATE INDEX IF NOT EXISTS members_roster_idx ON members(season_id, status, source_display_name, member_id);
    CREATE TABLE IF NOT EXISTS migration_snapshots (
      source_snapshot_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL, request_key TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
  `).toArray();
}

export function applySchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`).toArray();
    const current = sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key = 'schema_version'").toArray()[0];
    const currentVersion = current ? Number(current.value) : 0;
    if (current && (!/^[1-9]\d*$/u.test(current.value) || !Number.isSafeInteger(currentVersion) ||
        currentVersion > APPLICATION_SCHEMA_VERSION)) {
      throw new Error(`Unsupported database schema version ${current.value}.`);
    }
    if (currentVersion < 1) applyC0Schema(sql);
    if (currentVersion < 2) applyC1CoreSchema(sql);
    sql.exec(
      `INSERT INTO app_meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(APPLICATION_SCHEMA_VERSION)
    ).toArray();
  });
}
