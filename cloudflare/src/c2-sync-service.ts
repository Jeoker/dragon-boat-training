import {
  parseImportSyncFoundation, parseSyncOverview, type ImportSyncFoundationRequest,
  type SourceImportSnapshot, type SyncBaselineSnapshot, type SyncBindingSnapshot
} from "../../shared/c2-sync-contract";
import { SYNC_FIELD_DEFINITIONS, formResponseSourceId, normalizeSyncValue } from "../../shared/c2-sync-rules";
import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { C1Service } from "./c1-service";
import { firstRow, operationReceipt, parseContract, type SqlRow } from "./c1-support";
import { APPLICATION_SCHEMA_VERSION } from "./schema";
import { C2FormService } from "./c2-form-service";
import { requireRequestId } from "./http";

interface PreparedBaseline extends SyncBaselineSnapshot { baseline_digest: string; }

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function bindingComparable(row: SyncBindingSnapshot | Record<string, unknown>): Record<string, unknown> {
  return {
    season_id: row.season_id, binding_version: Number(row.binding_version), form_id: row.form_id,
    runtime_spreadsheet_id: row.runtime_spreadsheet_id, response_sheet_id: row.response_sheet_id,
    response_sheet_name: row.response_sheet_name,
    field_mapping: "field_mapping_json" in row && typeof row.field_mapping_json === "string"
      ? JSON.parse(row.field_mapping_json) : row.field_mapping,
    schema_fingerprint: row.schema_fingerprint, export_paused: Number(row.export_paused) === 1 || row.export_paused === true,
    last_pull_at: row.last_pull_at ?? null, last_push_at: row.last_push_at ?? null,
    created_at: row.created_at, updated_at: row.updated_at
  };
}

function bindingIdentityComparable(row: SyncBindingSnapshot | Record<string, unknown>): Record<string, unknown> {
  const { response_sheet_name: _name, export_paused: _paused, last_pull_at: _pull,
    last_push_at: _push, updated_at: _updated, ...identity } = bindingComparable(row);
  return identity;
}

function timestampRegressed(previous: unknown, next: string | null): boolean {
  return previous != null && (next == null || Date.parse(next) < Date.parse(String(previous)));
}

function sourceComparable(row: SourceImportSnapshot | Record<string, unknown>): Record<string, unknown> {
  return {
    stable_source_id: row.stable_source_id, season_id: row.season_id,
    binding_version: Number(row.binding_version), source_type: row.source_type,
    source_external_id: row.source_external_id, source_digest: row.source_digest,
    source_version: Number(row.source_version), member_id: row.member_id ?? null, status: row.status,
    imported_at: row.imported_at ?? null, updated_at: row.updated_at
  };
}

function sourceContentComparable(row: SourceImportSnapshot | Record<string, unknown>): Record<string, unknown> {
  const { binding_version: _bindingVersion, ...content } = sourceComparable(row);
  return content;
}

export class C2SyncService {
  private readonly core: C1Service;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.core = new C1Service(ctx, env);
  }

  async handle(path: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (path === "/internal/c2/import-sync-foundation") return this.importFoundation(raw);
    if (path === "/internal/c2/get-sync-overview") return this.getOverview(raw);
    if (path === "/internal/c2/pull-form-responses") return new C2FormService(this.ctx, this.env).pull(raw);
    if (path === "/internal/c2/form-submit-notification") return this.formSubmitNotification(raw);
    if (path === "/internal/c2/poll-active-forms") return this.pollActiveForms(raw);
    if (path === "/internal/c2/resolve-form-source") return new C2FormService(this.ctx, this.env).resolve(raw);
    throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
  }

  private async formSubmitNotification(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = requireRequestId(raw);
    const seasonId = String(raw.season_id ?? "");
    const bindingVersion = Number(raw.binding_version);
    const formId = String(raw.form_id ?? "");
    const responseId = String(raw.response_id ?? "");
    const binding = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT b.form_id, b.binding_version FROM sync_bindings b
       JOIN seasons s ON s.season_id=b.season_id AND s.binding_version=b.binding_version
       WHERE b.season_id=? AND s.status IN ('OPEN','COMPLETED')`, seasonId);
    if (!binding || String(binding.form_id) !== formId || Number(binding.binding_version) !== bindingVersion) {
      throw new ApiError("SYNC_BINDING_NOT_FOUND", "The Form notification does not match an active binding.", 409);
    }
    const stableId = formResponseSourceId(seasonId, formId, responseId);
    const pages: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 4; index += 1) {
      const page = await new C2FormService(this.ctx, this.env).pull({
        request_id: `${requestId}_${index}`, season_id: seasonId, limit: 100
      });
      pages.push(page.result as Record<string, unknown>);
      const observed = firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT 1 AS present FROM source_imports WHERE stable_source_id=?", stableId);
      if (observed) return { season_id: seasonId, response_id: responseId, observed: true, pages };
      if (!(page.result as { has_more?: boolean }).has_more) break;
    }
    throw new ApiError("FORM_NOTIFICATION_PENDING", "The submitted Form response is not visible yet.", 503, true);
  }

  private async pollActiveForms(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = requireRequestId(raw);
    if (String(this.env.C2_FORM_POLL_ENABLED) !== "true" || this.env.ENVIRONMENT === "production") {
      throw new ApiError("FORM_POLL_DISABLED", "Automatic Form polling is disabled.", 409);
    }
    const seasons = this.ctx.storage.sql.exec<{ season_id: string }>(
      `SELECT b.season_id FROM sync_bindings b JOIN seasons s ON s.season_id=b.season_id
       LEFT JOIN form_import_cursors c ON c.season_id=b.season_id
       WHERE s.status IN ('OPEN','COMPLETED') AND s.binding_version=b.binding_version
       ORDER BY COALESCE(c.last_read_at_ms, 0), b.season_id LIMIT 4`).toArray();
    const results: Array<{ season_id: string; status: string; has_more?: boolean }> = [];
    for (const season of seasons) {
      try {
        const result = await new C2FormService(this.ctx, this.env).pull({
          request_id: `c2_${await sha256Base64Url(`${requestId}\n${season.season_id}`)}`,
          season_id: season.season_id, limit: 100
        });
        const data = result.result as { has_more: boolean };
        results.push({ season_id: season.season_id, status: "COMMITTED", has_more: data.has_more });
      } catch {
        results.push({ season_id: season.season_id, status: "RETRY_REQUIRED" });
      }
    }
    return { polled: results.length, results };
  }

  private bindingFor(seasonId: string, bindingVersion: number,
    inputBindings: Map<string, SyncBindingSnapshot>): SyncBindingSnapshot | Record<string, unknown> {
    const incoming = inputBindings.get(seasonId);
    if (incoming && incoming.binding_version === bindingVersion) return incoming;
    const current = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT b.* FROM sync_bindings b JOIN seasons s ON s.season_id=b.season_id
       WHERE b.season_id=? AND b.binding_version=? AND s.binding_version=b.binding_version`,
      seasonId, bindingVersion);
    if (!current) throw new ApiError("SYNC_BINDING_NOT_FOUND", "The sync record has no matching season binding.", 409);
    return current;
  }

  private validateBinding(binding: SyncBindingSnapshot): void {
    const season = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT binding_version FROM seasons WHERE season_id=?", binding.season_id);
    if (!season) throw new ApiError("IMPORT_REFERENCE_MISSING", "A sync binding references an unknown season.", 409);
    if (Number(season.binding_version) !== binding.binding_version) {
      throw new ApiError("SYNC_BINDING_STALE", "The sync binding version does not match the season.", 409);
    }
    const externalOwner = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT season_id FROM sync_bindings
       WHERE season_id<>? AND (form_id=? OR runtime_spreadsheet_id=?)`,
      binding.season_id, binding.form_id, binding.runtime_spreadsheet_id);
    if (externalOwner) {
      throw new ApiError("SYNC_BINDING_IDENTITY_CONFLICT",
        "A Google Form or Spreadsheet cannot be bound to more than one season.", 409);
    }
    const existing = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM sync_bindings WHERE season_id=?", binding.season_id);
    if (!existing) return;
    if (binding.binding_version < Number(existing.binding_version)) {
      throw new ApiError("IMPORT_VERSION_REGRESSION", "The sync binding snapshot is older than stored state.", 409);
    }
    if (binding.binding_version === Number(existing.binding_version)) {
      if (!same(bindingIdentityComparable(existing), bindingIdentityComparable(binding))) {
        throw new ApiError("IMPORT_CONFLICT", "The same sync binding version contains different identity or mapping data.", 409);
      }
      if (!same(bindingComparable(existing), binding) &&
          Date.parse(binding.updated_at) <= Date.parse(String(existing.updated_at))) {
        throw new ApiError("IMPORT_CONFLICT", "Changed binding metadata requires a newer updated_at.", 409);
      }
    }
    if (timestampRegressed(existing.last_pull_at, binding.last_pull_at) ||
        timestampRegressed(existing.last_push_at, binding.last_push_at) ||
        Date.parse(binding.updated_at) < Date.parse(String(existing.updated_at))) {
      throw new ApiError("IMPORT_VERSION_REGRESSION", "The sync binding timestamps cannot move backward.", 409);
    }
    if (["form_id", "runtime_spreadsheet_id", "response_sheet_id"].some((field) =>
      String(existing[field]) !== String(binding[field as keyof SyncBindingSnapshot])) ||
        String(existing.created_at) !== binding.created_at) {
      throw new ApiError("SYNC_BINDING_IDENTITY_CONFLICT",
        "An initialized season cannot silently change its Form, Spreadsheet, response tab or binding identity.", 409);
    }
  }

  private validateBaseline(baseline: SyncBaselineSnapshot): Record<string, unknown> {
    const definitions = SYNC_FIELD_DEFINITIONS[baseline.entity_type]
      .filter((definition) => definition.dependency_group === baseline.dependency_group);
    if (!definitions.length) {
      throw new ApiError("SYNC_MAPPING_INVALID", "The baseline dependency group is not mapped for this entity.", 409);
    }
    const expected = definitions.map((definition) => definition.field).sort();
    const actual = Object.keys(baseline.baseline).sort();
    if (!same(expected, actual)) {
      throw new ApiError("SYNC_MAPPING_INVALID", "A baseline must contain exactly its dependency-group fields.", 409);
    }
    let normalized: Record<string, unknown>;
    try {
      normalized = Object.fromEntries(definitions.map((definition) => [definition.field,
        normalizeSyncValue(baseline.baseline[definition.field], definition.kind, definition.allowed_values)]));
    } catch {
      throw new ApiError("SYNC_MAPPING_INVALID", "A baseline contains an invalid mapped value.", 409);
    }
    if (baseline.entity_type === "SEASON" && baseline.entity_id !== baseline.season_id) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", "The season baseline has the wrong entity identity.", 409);
    }
    if (baseline.entity_type === "MEMBER" && !firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT 1 AS present FROM members WHERE season_id=? AND member_id=?", baseline.season_id, baseline.entity_id)) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", "A member baseline references an unknown member.", 409);
    }
    if (["PRACTICE", "SEAT_PLAN_DRAFT", "HISTORY"].includes(baseline.entity_type) &&
        !firstRow<SqlRow>(this.ctx.storage.sql,
          "SELECT 1 AS present FROM practices WHERE season_id=? AND practice_id=?", baseline.season_id, baseline.entity_id)) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", "A sync baseline references an unknown practice.", 409);
    }
    if (baseline.entity_type === "SIGNUP") {
      const [practiceId, memberId, extra] = baseline.entity_id.split(":");
      if (extra || !practiceId || !memberId || !firstRow<SqlRow>(this.ctx.storage.sql,
        "SELECT 1 AS present FROM signups WHERE season_id=? AND practice_id=? AND member_id=?",
        baseline.season_id, practiceId, memberId)) {
        throw new ApiError("IMPORT_REFERENCE_MISSING", "A signup baseline references an unknown signup.", 409);
      }
    }
    if (baseline.dependency_group === "IDENTITY") {
      let expected: Record<string, unknown>;
      if (baseline.entity_type === "SEASON") expected = { season_id: baseline.season_id };
      else if (baseline.entity_type === "MEMBER") {
        const member = firstRow<SqlRow>(this.ctx.storage.sql,
          "SELECT source_key FROM members WHERE season_id=? AND member_id=?", baseline.season_id, baseline.entity_id)!;
        expected = { season_id: baseline.season_id, member_id: baseline.entity_id, source_key: member.source_key };
      } else if (baseline.entity_type === "SIGNUP") {
        const [practiceId, memberId] = baseline.entity_id.split(":");
        expected = { season_id: baseline.season_id, practice_id: practiceId, member_id: memberId };
      } else {
        const practice = firstRow<SqlRow>(this.ctx.storage.sql,
          "SELECT week_id FROM practices WHERE season_id=? AND practice_id=?", baseline.season_id, baseline.entity_id)!;
        expected = baseline.entity_type === "PRACTICE"
          ? { season_id: baseline.season_id, week_id: practice.week_id, practice_id: baseline.entity_id }
          : { season_id: baseline.season_id, practice_id: baseline.entity_id };
      }
      if (!same(normalized, expected)) {
        throw new ApiError("SYNC_MAPPING_INVALID", "A baseline identity does not match its referenced entity.", 409);
      }
    }
    return normalized;
  }

  private validateSource(source: SourceImportSnapshot, binding: SyncBindingSnapshot | Record<string, unknown>): void {
    if (source.source_type === "FORM_RESPONSE") {
      const formId = String("form_id" in binding ? binding.form_id : "");
      let expectedId: string;
      try {
        expectedId = formResponseSourceId(source.season_id, formId, source.source_external_id);
      } catch {
        throw new ApiError("SOURCE_IDENTITY_INVALID", "The Form response identifier is invalid.", 409);
      }
      if (source.stable_source_id !== expectedId) {
        throw new ApiError("SOURCE_IDENTITY_INVALID", "The Form response stable source identity is invalid.", 409);
      }
    } else if (source.stable_source_id !== `LEGACY_ROW:${source.season_id}:${source.source_external_id}`) {
      throw new ApiError("SOURCE_IDENTITY_INVALID", "The legacy row stable source identity is invalid.", 409);
    }
    if (source.member_id && !firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT 1 AS present FROM members WHERE season_id=? AND member_id=?", source.season_id, source.member_id)) {
      throw new ApiError("IMPORT_REFERENCE_MISSING", "A source mapping references an unknown member.", 409);
    }
    const existing = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT * FROM source_imports WHERE stable_source_id=?", source.stable_source_id);
    const externalOwner = firstRow<SqlRow>(this.ctx.storage.sql,
      `SELECT stable_source_id FROM source_imports
       WHERE season_id=? AND binding_version=? AND source_type=? AND source_external_id=?`,
      source.season_id, source.binding_version, source.source_type, source.source_external_id);
    if (externalOwner && String(externalOwner.stable_source_id) !== source.stable_source_id) {
      throw new ApiError("SOURCE_IDENTITY_CONFLICT", "An external source identity already has another stable mapping.", 409);
    }
    if (!existing) return;
    if (source.source_version < Number(existing.source_version)) {
      throw new ApiError("IMPORT_VERSION_REGRESSION", "The source mapping snapshot is older than stored state.", 409);
    }
    if (source.binding_version < Number(existing.binding_version)) {
      throw new ApiError("IMPORT_VERSION_REGRESSION", "The source binding snapshot is older than stored state.", 409);
    }
    if (source.source_version === Number(existing.source_version) &&
        !same(sourceContentComparable(existing), sourceContentComparable(source))) {
      throw new ApiError("IMPORT_CONFLICT", "The same source mapping version contains different data.", 409);
    }
    if (String(existing.season_id) !== source.season_id ||
        String(existing.source_type) !== source.source_type || String(existing.source_external_id) !== source.source_external_id ||
        (existing.member_id && source.member_id && String(existing.member_id) !== source.member_id)) {
      throw new ApiError("SOURCE_IDENTITY_CONFLICT", "A stable source identity cannot be reassigned.", 409);
    }
    if (String(existing.status) === "IMPORTED" &&
        (source.status !== "IMPORTED" || String(existing.member_id) !== source.member_id)) {
      throw new ApiError("SOURCE_IDENTITY_CONFLICT", "An imported source cannot return to review or change members.", 409);
    }
  }

  private async importFoundation(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input: ImportSyncFoundationRequest = parseContract(() => parseImportSyncFoundation(raw));
    const { request_id: _requestId, ...snapshot } = input;
    const identity = await this.core.createRequestIdentity("C2:MIGRATION", "importSyncFoundation", input.request_id, snapshot);
    const replay = this.core.replayRequest(identity.requestKey, identity.payloadDigest);
    if (replay) return replay;
    const prior = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT payload_digest FROM sync_migration_snapshots WHERE source_snapshot_id=?", input.source_snapshot_id);
    if (prior && String(prior.payload_digest) !== identity.payloadDigest) {
      throw new ApiError("IMPORT_SNAPSHOT_CONFLICT", "This sync snapshot identifier has different content.", 409);
    }
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) throw new ApiError("IMPORT_CONFLICT", `${label} contains duplicates.`, 409);
    };
    unique(input.bindings.map((row) => row.season_id), "bindings");
    unique(input.bindings.map((row) => row.form_id), "binding Form identities");
    unique(input.bindings.map((row) => row.runtime_spreadsheet_id), "binding Spreadsheet identities");
    unique(input.bindings.map((row) => `${row.runtime_spreadsheet_id}\n${row.response_sheet_id}`),
      "binding response tabs");
    unique(input.baselines.map((row) => `${row.season_id}\n${row.binding_version}\n${row.entity_type}\n${row.entity_id}\n${row.dependency_group}`), "baselines");
    unique(input.source_imports.map((row) => row.stable_source_id), "stable source identities");
    unique(input.source_imports.map((row) => `${row.season_id}\n${row.binding_version}\n${row.source_type}\n${row.source_external_id}`),
      "external source identities");
    const bindings = new Map(input.bindings.map((row) => [row.season_id, row]));
    input.bindings.forEach((row) => this.validateBinding(row));
    const normalizedBaselines: SyncBaselineSnapshot[] = [];
    for (const baseline of input.baselines) {
      this.bindingFor(baseline.season_id, baseline.binding_version, bindings);
      normalizedBaselines.push({ ...baseline, baseline: this.validateBaseline(baseline) });
    }
    for (const source of input.source_imports) {
      const binding = this.bindingFor(source.season_id, source.binding_version, bindings);
      this.validateSource(source, binding);
    }
    const prepared: PreparedBaseline[] = await Promise.all(normalizedBaselines.map(async (row) => ({ ...row,
      baseline_digest: `sha256_v1:${await sha256Base64Url(canonicalJson(row.baseline))}`
    })));
    const at = new Date().toISOString();
    const result = { operation: operationReceipt("importSyncFoundation", input.request_id, at), result: {
      source_snapshot_id: input.source_snapshot_id, bindings: input.bindings.length,
      baselines: input.baselines.length, source_imports: input.source_imports.length
    } };
    this.ctx.storage.transactionSync(() => {
      for (const row of input.bindings) this.ctx.storage.sql.exec(
        `INSERT INTO sync_bindings(season_id, binding_version, form_id, runtime_spreadsheet_id,
           response_sheet_id, response_sheet_name, field_mapping_json, schema_fingerprint,
           export_paused, last_pull_at, last_push_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(season_id) DO UPDATE SET binding_version=excluded.binding_version,
           form_id=excluded.form_id, runtime_spreadsheet_id=excluded.runtime_spreadsheet_id,
           response_sheet_id=excluded.response_sheet_id, response_sheet_name=excluded.response_sheet_name,
           field_mapping_json=excluded.field_mapping_json, schema_fingerprint=excluded.schema_fingerprint,
           export_paused=excluded.export_paused, last_pull_at=excluded.last_pull_at,
           last_push_at=excluded.last_push_at, created_at=excluded.created_at, updated_at=excluded.updated_at`,
        row.season_id, row.binding_version, row.form_id, row.runtime_spreadsheet_id,
        row.response_sheet_id, row.response_sheet_name, canonicalJson(row.field_mapping), row.schema_fingerprint,
        row.export_paused ? 1 : 0, row.last_pull_at, row.last_push_at, row.created_at, row.updated_at).toArray();
      for (const row of prepared) {
        const existing = firstRow<SqlRow>(this.ctx.storage.sql,
          `SELECT baseline_digest, cloud_version, sheet_digest, updated_at FROM sync_baselines
           WHERE season_id=? AND binding_version=? AND entity_type=? AND entity_id=? AND dependency_group=?`,
          row.season_id, row.binding_version, row.entity_type, row.entity_id, row.dependency_group);
        if (existing && (String(existing.baseline_digest) !== row.baseline_digest ||
            Number(existing.cloud_version) !== row.cloud_version || String(existing.sheet_digest) !== row.sheet_digest ||
            String(existing.updated_at) !== row.updated_at)) {
          throw new ApiError("IMPORT_CONFLICT", "An existing sync baseline has different immutable content.", 409);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO sync_baselines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(season_id, binding_version, entity_type, entity_id, dependency_group) DO NOTHING`,
          row.season_id, row.binding_version, row.entity_type, row.entity_id, row.dependency_group,
          canonicalJson(row.baseline), row.baseline_digest, row.cloud_version, row.sheet_digest, row.updated_at).toArray();
      }
      for (const row of input.source_imports) this.ctx.storage.sql.exec(
        `INSERT INTO source_imports(stable_source_id, season_id, binding_version, source_type,
           source_external_id, source_digest, source_version, member_id, status, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stable_source_id) DO UPDATE SET binding_version=excluded.binding_version,
           source_digest=excluded.source_digest,
           source_version=excluded.source_version, member_id=excluded.member_id, status=excluded.status,
           imported_at=excluded.imported_at, updated_at=excluded.updated_at`,
        row.stable_source_id, row.season_id, row.binding_version, row.source_type,
        row.source_external_id, row.source_digest, row.source_version, row.member_id, row.status,
        row.imported_at, row.updated_at).toArray();
      this.core.recordRequest(identity, "C2:MIGRATION", "importSyncFoundation", input.request_id, result,
        { source_snapshot_id: input.source_snapshot_id, counts: result.result }, at);
      this.ctx.storage.sql.exec(
        `INSERT INTO sync_migration_snapshots VALUES (?, ?, ?, ?)
         ON CONFLICT(source_snapshot_id) DO NOTHING`,
        input.source_snapshot_id, identity.payloadDigest, at, identity.requestKey).toArray();
    });
    return result;
  }

  private async getOverview(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseContract(() => parseSyncOverview(raw));
    await this.core.authenticateSession(input.session_token);
    const season = firstRow<SqlRow>(this.ctx.storage.sql,
      "SELECT season_id, binding_version FROM seasons WHERE season_id=?", input.season_id);
    if (!season) throw new ApiError("SEASON_NOT_FOUND", "The season does not exist.", 404);
    const binding = firstRow<SqlRow>(this.ctx.storage.sql, "SELECT * FROM sync_bindings WHERE season_id=?", input.season_id);
    const count = (query: string, ...values: SqlStorageValue[]) =>
      Number(this.ctx.storage.sql.exec<{ count: number }>(query, ...values).one().count);
    const bindingCurrent = !!binding && Number(binding.binding_version) === Number(season.binding_version);
    return {
      season_id: input.season_id,
      binding: binding ? bindingComparable(binding) : null,
      binding_current: bindingCurrent,
      counts: {
        baselines: bindingCurrent ? count("SELECT COUNT(*) AS count FROM sync_baselines WHERE season_id=? AND binding_version=?",
          input.season_id, Number(season.binding_version)) : 0,
        imported_sources: count(
          "SELECT COUNT(*) AS count FROM source_imports WHERE season_id=? AND status='IMPORTED'",
          input.season_id),
        sources_needing_review: count(
          "SELECT COUNT(*) AS count FROM source_imports WHERE season_id=? AND status='REVIEW_REQUIRED'",
          input.season_id),
        open_conflicts: count("SELECT COUNT(*) AS count FROM sync_conflicts WHERE season_id=? AND status='OPEN'", input.season_id),
        pending_batches: count(
          "SELECT COUNT(*) AS count FROM sync_batches WHERE season_id=? AND status IN ('PREPARED','SENT','PARTIAL','FAILED')",
          input.season_id),
        pending_outbox: count(
          `SELECT COUNT(*) AS count FROM sync_outbox
           WHERE status='PENDING' AND json_extract(payload_json, '$.entity.season_id')=?`, input.season_id)
      },
      schema_version: APPLICATION_SCHEMA_VERSION,
      generated_at: new Date().toISOString()
    };
  }
}
