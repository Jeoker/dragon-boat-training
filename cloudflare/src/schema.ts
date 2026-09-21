export const APPLICATION_SCHEMA_VERSION = 3;

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

function applyC1ScheduleSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schedule_templates (
      season_id TEXT NOT NULL, template_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, timezone TEXT NOT NULL,
      location TEXT NOT NULL, address TEXT NOT NULL, map_url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      template_version INTEGER NOT NULL CHECK (template_version >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, template_id),
      FOREIGN KEY (season_id) REFERENCES seasons(season_id)
    );
    CREATE INDEX IF NOT EXISTS schedule_templates_active_idx
      ON schedule_templates(season_id, active, day_of_week, start_time, template_id);
    CREATE TABLE IF NOT EXISTS training_weeks (
      season_id TEXT NOT NULL, week_id TEXT NOT NULL, week_start_date TEXT NOT NULL,
      scheduled_open_at TEXT, status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SCHEDULED', 'OPENED')),
      week_version INTEGER NOT NULL CHECK (week_version >= 1), confirmed_version INTEGER,
      confirmed_by TEXT, confirmed_at TEXT, published_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, week_id), UNIQUE (season_id, week_start_date),
      FOREIGN KEY (season_id) REFERENCES seasons(season_id),
      FOREIGN KEY (confirmed_by) REFERENCES coaches(coach_id)
    );
    CREATE INDEX IF NOT EXISTS training_weeks_status_idx
      ON training_weeks(season_id, status, scheduled_open_at, week_start_date);
    CREATE TABLE IF NOT EXISTS practices (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL, week_id TEXT NOT NULL,
      template_id TEXT, generation_key TEXT,
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, timezone TEXT NOT NULL,
      location TEXT NOT NULL, address TEXT NOT NULL, map_url TEXT NOT NULL DEFAULT '',
      left_capacity INTEGER NOT NULL CHECK (left_capacity >= 1),
      right_capacity INTEGER NOT NULL CHECK (right_capacity >= 1),
      signup_cutoff_at TEXT NOT NULL,
      practice_version INTEGER NOT NULL CHECK (practice_version >= 1),
      cancelled_at TEXT, cancelled_by TEXT, schedule_published_at TEXT, schedule_published_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id), UNIQUE (season_id, generation_key),
      FOREIGN KEY (season_id, week_id) REFERENCES training_weeks(season_id, week_id),
      FOREIGN KEY (cancelled_by) REFERENCES coaches(coach_id),
      FOREIGN KEY (schedule_published_by) REFERENCES coaches(coach_id)
    );
    CREATE INDEX IF NOT EXISTS practices_week_idx ON practices(season_id, week_id, start_at, practice_id);
    CREATE INDEX IF NOT EXISTS practices_public_idx
      ON practices(season_id, schedule_published_at, cancelled_at, start_at, practice_id);
    CREATE TABLE IF NOT EXISTS practice_versions (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      signup_version INTEGER NOT NULL DEFAULT 0 CHECK (signup_version >= 0),
      seat_plan_version INTEGER NOT NULL DEFAULT 0 CHECK (seat_plan_version >= 0),
      published_revision INTEGER NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
      PRIMARY KEY (season_id, practice_id),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_migration_snapshots (
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
    if (currentVersion < 3) applyC1ScheduleSchema(sql);
    sql.exec(
      `INSERT INTO app_meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(APPLICATION_SCHEMA_VERSION)
    ).toArray();
  });
}
