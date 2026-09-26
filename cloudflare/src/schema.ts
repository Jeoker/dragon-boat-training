export const APPLICATION_SCHEMA_VERSION = 8;

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

function applyC1SignupSchema(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(practice_versions)").toArray();
  if (!columns.some((column) => column.name === "signup_sequence")) {
    sql.exec(`ALTER TABLE practice_versions ADD COLUMN signup_sequence INTEGER NOT NULL DEFAULT 0
      CHECK (signup_sequence >= 0);`).toArray();
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL, member_id TEXT NOT NULL,
      preference TEXT NOT NULL CHECK (preference IN ('LEFT', 'AMBIENT', 'RIGHT')),
      status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'WAITLISTED', 'CANCELLED')),
      queue_at TEXT NOT NULL, queue_sequence INTEGER NOT NULL CHECK (queue_sequence >= 1),
      updated_at TEXT NOT NULL, last_request_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (season_id, practice_id, member_id),
      UNIQUE (season_id, practice_id, queue_sequence),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id),
      FOREIGN KEY (season_id, member_id) REFERENCES members(season_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS signups_practice_queue_idx
      ON signups(season_id, practice_id, status, queue_at, queue_sequence);
    CREATE INDEX IF NOT EXISTS signups_member_active_idx
      ON signups(season_id, member_id, status, practice_id);
    CREATE TABLE IF NOT EXISTS signup_rate_limits (
      season_id TEXT NOT NULL, member_id TEXT NOT NULL, minute_bucket INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1), updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, member_id, minute_bucket)
    );
    CREATE TABLE IF NOT EXISTS signup_migration_snapshots (
      source_snapshot_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL, request_key TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
  `).toArray();
}

function applyC1SeatingSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS seat_plan_states (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      coach_member_id TEXT, steerer_member_id TEXT,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id),
      FOREIGN KEY (season_id, coach_member_id) REFERENCES members(season_id, member_id),
      FOREIGN KEY (season_id, steerer_member_id) REFERENCES members(season_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS seat_plan_draft_seats (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
      row_number INTEGER NOT NULL CHECK (row_number >= 1), member_id TEXT,
      seat_plan_version INTEGER NOT NULL CHECK (seat_plan_version >= 1),
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id, side, row_number),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id),
      FOREIGN KEY (season_id, member_id) REFERENCES members(season_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS seat_plan_draft_member_idx
      ON seat_plan_draft_seats(season_id, member_id, practice_id);
    CREATE TABLE IF NOT EXISTS seat_plan_revisions (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL CHECK (revision_number >= 1), revision_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL, seat_plan_version INTEGER NOT NULL CHECK (seat_plan_version >= 0),
      coach_member_id TEXT, steerer_member_id TEXT,
      published_by TEXT NOT NULL, published_at TEXT NOT NULL, request_id TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id, revision_number),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id),
      FOREIGN KEY (season_id, coach_member_id) REFERENCES members(season_id, member_id),
      FOREIGN KEY (season_id, steerer_member_id) REFERENCES members(season_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS seat_plan_revision_seats (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
      row_number INTEGER NOT NULL CHECK (row_number >= 1), member_id TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id, revision_number, side, row_number),
      UNIQUE (season_id, practice_id, revision_number, member_id),
      FOREIGN KEY (season_id, practice_id, revision_number)
        REFERENCES seat_plan_revisions(season_id, practice_id, revision_number),
      FOREIGN KEY (season_id, member_id) REFERENCES members(season_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS seat_plan_revision_member_idx
      ON seat_plan_revision_seats(season_id, member_id, practice_id, revision_number);
    CREATE TABLE IF NOT EXISTS seat_plan_revision_names (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
      member_id TEXT NOT NULL, display_name TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id, revision_number, member_id),
      FOREIGN KEY (season_id, practice_id, revision_number)
        REFERENCES seat_plan_revisions(season_id, practice_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS seating_migration_snapshots (
      source_snapshot_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL, request_key TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
  `).toArray();
}

function applyC1HistorySchema(sql: SqlStorage): void {
  const auditColumns = sql.exec<{ name: string }>("PRAGMA table_info(audit_events)").toArray();
  if (!auditColumns.some((column) => column.name === "season_id")) {
    sql.exec("ALTER TABLE audit_events ADD COLUMN season_id TEXT;").toArray();
    sql.exec(`UPDATE audit_events SET season_id=json_extract(details_json, '$.season_id')
      WHERE json_valid(details_json) AND json_type(details_json, '$.season_id')='text'`).toArray();
  }
  sql.exec(`
    CREATE INDEX IF NOT EXISTS audit_events_season_idx
      ON audit_events(season_id, created_at DESC, event_id DESC);
    CREATE TABLE IF NOT EXISTS practice_history (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      history_version INTEGER NOT NULL CHECK (history_version >= 1),
      final_status TEXT NOT NULL CHECK (final_status IN ('FROZEN', 'UNPUBLISHED')),
      frozen_revision INTEGER NOT NULL CHECK (frozen_revision >= 0),
      snapshot_json TEXT NOT NULL, frozen_at TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id),
      FOREIGN KEY (season_id, practice_id) REFERENCES practices(season_id, practice_id)
    );
    CREATE INDEX IF NOT EXISTS practice_history_season_idx
      ON practice_history(season_id, frozen_at DESC, practice_id DESC);
    CREATE INDEX IF NOT EXISTS practices_history_maintenance_idx
      ON practices(season_id, end_at, practice_id)
      WHERE schedule_published_at IS NOT NULL AND cancelled_at IS NULL;
    CREATE TABLE IF NOT EXISTS history_corrections (
      season_id TEXT NOT NULL, practice_id TEXT NOT NULL,
      correction_id TEXT NOT NULL UNIQUE,
      history_version INTEGER NOT NULL CHECK (history_version >= 2),
      note TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (season_id, practice_id, history_version),
      FOREIGN KEY (season_id, practice_id) REFERENCES practice_history(season_id, practice_id)
    );
    CREATE TABLE IF NOT EXISTS season_history (
      season_id TEXT PRIMARY KEY, archive_year INTEGER NOT NULL,
      practice_count INTEGER NOT NULL CHECK (practice_count >= 0),
      published_practice_count INTEGER NOT NULL CHECK (published_practice_count >= 0),
      snapshot_json TEXT NOT NULL, archived_at TEXT NOT NULL,
      FOREIGN KEY (season_id) REFERENCES seasons(season_id)
    );
    CREATE INDEX IF NOT EXISTS season_history_public_idx
      ON season_history(archive_year DESC, archived_at DESC, season_id DESC);
    CREATE TABLE IF NOT EXISTS history_migration_snapshots (
      source_snapshot_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL, request_key TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      usage_date TEXT PRIMARY KEY, captured_at TEXT NOT NULL,
      database_size_bytes INTEGER NOT NULL CHECK (database_size_bytes >= 0),
      request_count INTEGER NOT NULL CHECK (request_count >= 0),
      audit_count INTEGER NOT NULL CHECK (audit_count >= 0),
      outbox_pending INTEGER NOT NULL CHECK (outbox_pending >= 0),
      jobs_pending INTEGER NOT NULL CHECK (jobs_pending >= 0),
      history_practice_count INTEGER NOT NULL CHECK (history_practice_count >= 0),
      history_season_count INTEGER NOT NULL CHECK (history_season_count >= 0)
    );
    CREATE TABLE IF NOT EXISTS backup_snapshots (
      snapshot_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('BUILDING', 'READY')),
      schema_version INTEGER NOT NULL, request_key TEXT NOT NULL, request_id TEXT NOT NULL,
      actor_scope TEXT NOT NULL, payload_digest TEXT NOT NULL, event_id TEXT NOT NULL,
      table_count INTEGER NOT NULL CHECK (table_count >= 0),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      content_digest TEXT NOT NULL DEFAULT '', manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS backup_snapshot_chunks (
      snapshot_id TEXT NOT NULL, chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      table_name TEXT NOT NULL, row_offset INTEGER NOT NULL CHECK (row_offset >= 0),
      row_count INTEGER NOT NULL CHECK (row_count >= 0), payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (snapshot_id, chunk_index),
      FOREIGN KEY (snapshot_id) REFERENCES backup_snapshots(snapshot_id)
    );
  `).toArray();
}

function applyC2SyncFoundationSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sync_bindings (
      season_id TEXT PRIMARY KEY, binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
      form_id TEXT NOT NULL UNIQUE, runtime_spreadsheet_id TEXT NOT NULL UNIQUE,
      response_sheet_id TEXT NOT NULL, response_sheet_name TEXT NOT NULL,
      field_mapping_json TEXT NOT NULL CHECK (json_valid(field_mapping_json)), schema_fingerprint TEXT NOT NULL,
      export_paused INTEGER NOT NULL DEFAULT 0 CHECK (export_paused IN (0, 1)),
      last_pull_at TEXT, last_push_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (season_id) REFERENCES seasons(season_id)
    );
    CREATE TABLE IF NOT EXISTS sync_baselines (
      season_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN
        ('SEASON', 'MEMBER', 'SIGNUP', 'PRACTICE', 'SEAT_PLAN_DRAFT', 'HISTORY')),
      entity_id TEXT NOT NULL, dependency_group TEXT NOT NULL,
      baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)), baseline_digest TEXT NOT NULL,
      cloud_version INTEGER NOT NULL CHECK (cloud_version >= 0), sheet_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (season_id, binding_version, entity_type, entity_id, dependency_group),
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id)
    );
    CREATE INDEX IF NOT EXISTS sync_baselines_entity_idx
      ON sync_baselines(season_id, entity_type, entity_id, dependency_group);
    CREATE TABLE IF NOT EXISTS source_imports (
      stable_source_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('FORM_RESPONSE', 'LEGACY_ROW')),
      source_external_id TEXT NOT NULL, source_digest TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version >= 1), member_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('IMPORTED', 'REVIEW_REQUIRED')),
      imported_at TEXT, updated_at TEXT NOT NULL,
      CHECK ((status = 'IMPORTED' AND member_id IS NOT NULL AND imported_at IS NOT NULL) OR
             (status = 'REVIEW_REQUIRED' AND member_id IS NULL AND imported_at IS NULL)),
      UNIQUE (season_id, binding_version, source_type, source_external_id),
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id),
      FOREIGN KEY (season_id, member_id) REFERENCES members(season_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS source_imports_status_idx
      ON source_imports(season_id, status, updated_at, stable_source_id);
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN
        ('SEASON', 'MEMBER', 'SIGNUP', 'PRACTICE', 'SEAT_PLAN_DRAFT', 'HISTORY')),
      entity_id TEXT NOT NULL, dependency_group TEXT NOT NULL,
      baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
      cloud_json TEXT NOT NULL CHECK (json_valid(cloud_json)),
      google_json TEXT NOT NULL CHECK (json_valid(google_json)),
      cloud_version INTEGER NOT NULL CHECK (cloud_version >= 0), google_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'SUPERSEDED')),
      created_at TEXT NOT NULL, resolved_at TEXT,
      resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id)
    );
    CREATE INDEX IF NOT EXISTS sync_conflicts_open_idx
      ON sync_conflicts(season_id, status, created_at, conflict_id);
    CREATE TABLE IF NOT EXISTS sync_batches (
      batch_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 0),
      direction TEXT NOT NULL CHECK (direction IN ('CLOUDFLARE_TO_GOOGLE', 'GOOGLE_TO_CLOUDFLARE')),
      status TEXT NOT NULL CHECK (status IN
        ('PREPARED', 'SENT', 'PARTIAL', 'CONFIRMED', 'FAILED', 'SUPERSEDED')),
      payload_digest TEXT NOT NULL, first_outbox_id TEXT, last_outbox_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id)
    );
    CREATE INDEX IF NOT EXISTS sync_batches_status_idx
      ON sync_batches(season_id, status, updated_at, batch_id);
    CREATE TABLE IF NOT EXISTS sync_batch_items (
      batch_id TEXT NOT NULL, item_index INTEGER NOT NULL CHECK (item_index >= 0),
      entity_type TEXT NOT NULL CHECK (entity_type IN
        ('SEASON', 'MEMBER', 'SIGNUP', 'PRACTICE', 'SEAT_PLAN_DRAFT', 'HISTORY')),
      entity_id TEXT NOT NULL, dependency_group TEXT NOT NULL,
      expected_sheet_digest TEXT NOT NULL,
      target_json TEXT NOT NULL CHECK (json_valid(target_json)), target_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'VERIFIED', 'FAILED', 'SUPERSEDED')),
      receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)), updated_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, item_index),
      FOREIGN KEY (batch_id) REFERENCES sync_batches(batch_id)
    );
    CREATE TABLE IF NOT EXISTS sync_migration_snapshots (
      source_snapshot_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL, request_key TEXT NOT NULL,
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
  `).toArray();
}

function applyC2FormImportSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS form_import_cursors (
      season_id TEXT PRIMARY KEY, binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
      watermark_ms INTEGER NOT NULL DEFAULT 0 CHECK (watermark_ms >= 0),
      window_start_ms INTEGER, scan_baseline_ms INTEGER,
      after_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (after_at_ms >= 0),
      after_id TEXT NOT NULL DEFAULT '', last_read_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id)
    );
    CREATE TABLE IF NOT EXISTS form_import_receipts (
      operation_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
      season_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      request_digest TEXT NOT NULL, response_digest TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)), committed_at TEXT NOT NULL,
      FOREIGN KEY (season_id) REFERENCES sync_bindings(season_id),
      FOREIGN KEY (request_key) REFERENCES system_requests(request_key)
    );
    CREATE INDEX IF NOT EXISTS form_import_receipts_season_idx
      ON form_import_receipts(season_id, committed_at, operation_id);
    CREATE TABLE IF NOT EXISTS form_source_observations (
      stable_source_id TEXT PRIMARY KEY, season_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL, display_name TEXT NOT NULL,
      source_digest TEXT NOT NULL, review_reason TEXT NOT NULL DEFAULT '', observed_at TEXT NOT NULL,
      FOREIGN KEY (stable_source_id) REFERENCES source_imports(stable_source_id)
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
    if (currentVersion < 4) applyC1SignupSchema(sql);
    if (currentVersion < 5) applyC1SeatingSchema(sql);
    if (currentVersion < 6) applyC1HistorySchema(sql);
    if (currentVersion < 7) applyC2SyncFoundationSchema(sql);
    if (currentVersion < 8) applyC2FormImportSchema(sql);
    sql.exec(
      `INSERT INTO app_meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(APPLICATION_SCHEMA_VERSION)
    ).toArray();
  });
}
