// Independently pinned minimal package for the configured named RPC wire test.
// Nonempty 47/51-table data is exercised by the separate integrity suite.
export const RECOVERY_WIRE_TARGET = "recovery-quarantine-wired-copy-0001";
export const RECOVERY_WIRE_DIGEST = "sha256_v1:d5H2cQCqVD864wQsbegQihJci-XyK0qBav3WxsIP6Ng";
const names = ["app_meta", "c0_counters", "system_requests", "audit_events", "sync_outbox", "scheduled_jobs",
  "coaches", "settings", "seasons", "members", "migration_snapshots", "schedule_templates", "training_weeks", "practices",
  "practice_versions", "schedule_migration_snapshots", "signups", "signup_migration_snapshots", "seat_plan_states", "seat_plan_draft_seats",
  "seat_plan_revisions", "seat_plan_revision_seats", "seat_plan_revision_names", "seating_migration_snapshots", "practice_history",
  "history_corrections", "season_history", "history_migration_snapshots", "usage_snapshots", "sync_bindings", "sync_baselines",
  "source_imports", "sync_conflicts", "sync_batches", "sync_batch_items", "sync_migration_snapshots", "form_import_cursors",
  "form_import_receipts", "form_source_observations", "sync_export_controls", "sync_export_retries", "sync_associated_cursors",
  "sync_associated_physical_baselines", "sync_export_event_index", "sync_export_event_blocks", "sync_export_request_selections",
  "sync_export_poll_plans", "annual_archive_plans", "annual_archive_chunks", "annual_archive_requests", "source_authority_pins"];
const payload = { table: "app_meta", row_offset: 0, rows: [{ key: "schema_version", value: "16" }] };
const descriptor = { chunk_index: 0, table_name: "app_meta", row_offset: 0, row_count: 1,
  payload_digest: "sha256_v1:WMnVZNhPbNfPlmKB1yyqF60XW3t4wt33WuW3dA0Q-lU" };
export const RECOVERY_WIRE_BUNDLE = { manifest: { snapshot_id: "backup_fixture_wired_0001", schema_version: 16,
  format: "sqlite-json-chunks-v1", created_at: "2020-09-01T12:00:00.000Z",
  tables: names.map((name, index) => ({ name, row_count: index === 0 ? 1 : 0, chunk_indices: index === 0 ? [0] : [] })),
  table_count: 51, record_count: 1, chunk_count: 1, chunks: [descriptor], content_digest: RECOVERY_WIRE_DIGEST },
  chunks: [{ ...descriptor, payload }] };
