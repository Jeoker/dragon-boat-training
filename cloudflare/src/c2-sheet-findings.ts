import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "./crypto";
import type { SheetFinding } from "./c2-sheet-diff";
import type { SheetScope } from "./c2-sheet-bridge";

interface PersistedFinding {
  conflict_id: string;
  entity_id: string;
  dependency_group: string;
  outcome: "CONFLICT" | "REVIEW_REQUIRED" | "REJECTED";
  row_number: number | null;
  reason: string;
  baseline_json: string;
  cloud_json: string;
  google_json: string;
  cloud_version: number;
  google_digest: string;
  fingerprint: string;
}

function needsAttention(outcome: SheetFinding["outcome"]): outcome is PersistedFinding["outcome"] {
  return outcome === "CONFLICT" || outcome === "REVIEW_REQUIRED" || outcome === "REJECTED";
}

function cloudVersion(scope: SheetScope, finding: SheetFinding,
  cloudRows: Array<Record<string, unknown>>, signupVersions: Map<string, number>): number {
  if (scope === "SIGNUP") {
    const row = cloudRows.find((candidate) =>
      `${candidate.practice_id}:${candidate.member_id}` === finding.entity_id);
    return signupVersions.get(String(row?.practice_id ?? "")) ?? 0;
  }
  const row = cloudRows.find((candidate) => (scope === "MEMBER" ? candidate.member_id :
    scope === "SEASON" ? candidate.season_id : candidate.practice_id) === finding.entity_id);
  const field = scope === "SEASON" ? "season_version" : scope === "MEMBER" ? "member_version" :
    scope === "PRACTICE" ? "practice_version" : "seat_plan_version";
  const version = Number(row?.[field] ?? 0);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

export async function prepareSheetFindings(input: {
  season_id: string; binding_version: number; entity_type: SheetScope;
  findings: SheetFinding[]; cloud_rows: Array<Record<string, unknown>>;
  signup_versions?: Map<string, number>;
}): Promise<PersistedFinding[]> {
  const prepared: PersistedFinding[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    if (!needsAttention(finding.outcome)) continue;
    const fingerprint = `sha256_v1:${await sha256Base64Url(canonicalJson({
      season_id: input.season_id, binding_version: input.binding_version,
      entity_type: input.entity_type, entity_id: finding.entity_id,
      dependency_group: finding.dependency_group, outcome: finding.outcome,
      reason: finding.reason, baseline: finding.baseline,
      cloudflare: finding.cloudflare, google: finding.google
    }))}`;
    const conflictId = `sheet_${fingerprint.slice("sha256_v1:".length)}`;
    if (seen.has(conflictId)) continue;
    seen.add(conflictId);
    prepared.push({ conflict_id: conflictId,
      entity_id: finding.entity_id, dependency_group: finding.dependency_group,
      outcome: finding.outcome, row_number: finding.row_number, reason: finding.reason,
      baseline_json: canonicalJson(finding.baseline), cloud_json: canonicalJson(finding.cloudflare),
      google_json: canonicalJson(finding.google),
      cloud_version: cloudVersion(input.entity_type, finding, input.cloud_rows,
        input.signup_versions ?? new Map()),
      google_digest: `sha256_v1:${await sha256Base64Url(canonicalJson(finding.google))}`,
      fingerprint });
  }
  return prepared;
}

export function persistSheetFindings(sql: SqlStorage, input: {
  season_id: string; binding_version: number; entity_type: SheetScope;
  status: "OK" | "STRUCTURE_INVALID"; truncated: boolean;
  findings: PersistedFinding[];
}): { created: number; superseded: number; open: number } {
  const open = sql.exec<{ conflict_id: string }>(
    `SELECT conflict_id FROM sync_conflicts
     WHERE season_id=? AND binding_version=? AND entity_type=? AND status='OPEN'`,
    input.season_id, input.binding_version, input.entity_type).toArray();
  const openIds = new Set(open.map((row) => row.conflict_id));
  const activeIds = new Set(input.findings.map((finding) => finding.conflict_id));
  let superseded = 0;
  let created = 0;
  const at = new Date().toISOString();
  for (const previous of open) {
    if (activeIds.has(previous.conflict_id) || input.truncated || input.status !== "OK") continue;
    sql.exec(`UPDATE sync_conflicts SET status='SUPERSEDED', resolved_at=?
      WHERE conflict_id=? AND status='OPEN'`, at, previous.conflict_id).toArray();
    superseded += 1;
  }
  for (const finding of input.findings) {
    if (openIds.has(finding.conflict_id)) continue;
    const existing = sql.exec<{ status: string }>(
      "SELECT status FROM sync_conflicts WHERE conflict_id=?", finding.conflict_id).toArray()[0];
    if (existing?.status === "RESOLVED") continue;
    if (existing?.status === "SUPERSEDED") {
      sql.exec("UPDATE sync_conflicts SET status='OPEN', resolved_at=NULL WHERE conflict_id=?",
        finding.conflict_id).toArray();
      created += 1;
      continue;
    }
    sql.exec(`INSERT INTO sync_conflicts (
      conflict_id, season_id, binding_version, entity_type, entity_id, dependency_group,
      baseline_json, cloud_json, google_json, cloud_version, google_digest, status,
      created_at, resolved_at, resolution_json, finding_outcome, reason, row_number, fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?, ?, ?)`,
    finding.conflict_id, input.season_id, input.binding_version, input.entity_type,
    finding.entity_id, finding.dependency_group, finding.baseline_json, finding.cloud_json,
    finding.google_json, finding.cloud_version, finding.google_digest, at, finding.outcome,
    finding.reason, finding.row_number, finding.fingerprint).toArray();
    created += 1;
  }
  return { created, superseded,
    open: Number(sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM sync_conflicts
      WHERE season_id=? AND binding_version=? AND entity_type=? AND status='OPEN'`,
    input.season_id, input.binding_version, input.entity_type).one().count) };
}
