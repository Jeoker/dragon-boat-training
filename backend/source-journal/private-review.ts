import { emptyReviewLedger, reviewJson, REVIEW_DOMAINS, REVIEW_LIMITS, parseLedgerEnvelope, type ReviewAnchor, type ReviewContext }
  from "../../shared/c2-source-mapping-review-contract";
import { prepareLocalMappingReviewFromPlan, planLocalMappingReviewFromPlan } from "../../shared/c2-source-plan-review-adapter";
import { parseSourceJson, sourceArray, sourceBytes, sourceInstant, sourceInteger, sourceObject, sourceText } from "../../shared/c2-source-capture-contract";
import { type PrivateSourceOperation, type PrivateSourceReviewSource } from "./operation";
import { journalAssert, SourceJournalError } from "./service";

interface ReviewRecord {
  format: "c2-private-source-review-ledger-v1"; key: string; revision: number;
  source_identity_digest: string; ledger_text: string; ledger_digest: string;
}
export interface PrivateReviewStore {
  read(key: string): Promise<unknown | null>;
  compareAndSet(key: string, revision: number | null, value: ReviewRecord): Promise<boolean>;
}
const RECORD_LIMIT = 3_080_000;
const digest = (value: unknown): string => {
  journalAssert(typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value), "SOURCE_PRIVATE_REVIEW_INVALID"); return value;
};

/** Authenticated private review only. Retained-plan LOCAL_* provenance stays
 * unchanged. The CAS ledger records responsibility declarations, never source
 * verification, annual eligibility or replacement of original source content. */
export class PrivateSourceReview {
  constructor(private readonly operation: Pick<PrivateSourceOperation, "readForReview" | "assertReviewSource">,
    private readonly store: PrivateReviewStore, private readonly hashPort: (text: string) => Promise<string>,
    private readonly clock: () => string = () => new Date().toISOString()) {}
  private async hash(text: string) { return digest(await this.hashPort(text)); }
  private time(source: PrivateSourceReviewSource) {
    const at = sourceText(this.clock(), 1, 128);
    journalAssert(sourceInstant(at) >= sourceInstant(source.observed_end_at), "SOURCE_PRIVATE_REVIEW_INVALID"); return at;
  }
  private anchor(source: PrivateSourceReviewSource): ReviewAnchor {
    return { source: source.context.read_context.source, source_plan_digest: source.source_plan_digest,
      local_snapshot_id: `LOCAL_INPUT_${source.source_plan_digest}`, provenance: "LOCAL_INPUT_DECLARATIONS_ONLY" };
  }
  private context(source: PrivateSourceReviewSource, row: ReviewRecord, at: string): ReviewContext {
    const anchor = this.anchor(source);
    return { source: anchor.source, source_plan_digest: anchor.source_plan_digest, local_snapshot_id: anchor.local_snapshot_id,
      actor_id: source.context.actor_id, permission_scope: "COACH_SOURCE_MAPPING_REVIEW", reviewed_at: at,
      ledger_version: row.revision - 1, ledger_digest: row.ledger_digest };
  }
  private async identity(source: PrivateSourceReviewSource) {
    return this.hash("c2-private-review-source-v1\n" + reviewJson([
      source.context, source.source_plan_digest, source.candidate_digest, source.receipt_digest]));
  }
  private async load(key: string, identity: string, source: PrivateSourceReviewSource, at: string) {
    const raw = await this.store.read(key); if (raw === null) return null;
    const text = reviewJson(raw); journalAssert(sourceBytes(text) <= RECORD_LIMIT, "SOURCE_PRIVATE_REVIEW_INVALID");
    const row = sourceObject(JSON.parse(text));
    journalAssert(Object.keys(row).length === 6 && Object.keys(row).every(field =>
      ["format", "key", "revision", "source_identity_digest", "ledger_text", "ledger_digest"].includes(field)) &&
      row.format === "c2-private-source-review-ledger-v1" && row.key === key && row.source_identity_digest === identity,
      "SOURCE_PRIVATE_REVIEW_INVALID");
    const record: ReviewRecord = { format: "c2-private-source-review-ledger-v1", key, source_identity_digest: identity,
      revision: sourceInteger(row.revision, 1, REVIEW_LIMITS.evidence + 1), ledger_text: sourceText(row.ledger_text, 1, REVIEW_LIMITS.ledger_bytes),
      ledger_digest: digest(row.ledger_digest) };
    const ledger = parseLedgerEnvelope(record.ledger_text, this.anchor(source));
    journalAssert(ledger.version === record.revision - 1 && await this.hash(REVIEW_DOMAINS.ledger + record.ledger_text) === record.ledger_digest,
      "SOURCE_PRIVATE_REVIEW_INVALID");
    if (ledger.version === 0) journalAssert(record.ledger_text === reviewJson(emptyReviewLedger(this.anchor(source))), "SOURCE_PRIVATE_REVIEW_INVALID");
    else {
      // Replaying the last original command runs the existing full ledger-chain,
      // raw record, locator, one-to-one and original-core validation. No new verifier.
      const last = sourceObject(sourceArray(ledger.evidence).at(-1)!);
      const checked = await planLocalMappingReviewFromPlan(source.core_text, record.ledger_text, reviewJson(last.command),
        () => this.context(source, record, at), text => this.hash(text));
      journalAssert(!checked.result.append_required && checked.result.ledger_text === record.ledger_text &&
        checked.result.ledger_digest === record.ledger_digest, "SOURCE_PRIVATE_REVIEW_INVALID");
    }
    return record;
  }
  private async open(source: PrivateSourceReviewSource, at: string) {
    const key = await this.hash("c2-private-source-review-key-v1\n" + reviewJson([
      source.context.read_context.source.team_id, source.context.read_context.source.source_operation_id]));
    const identity = await this.identity(source);
    let row = await this.load(key, identity, source, at);
    if (!row) {
      const ledger_text = reviewJson(emptyReviewLedger(this.anchor(source)));
      const initial: ReviewRecord = { format: "c2-private-source-review-ledger-v1", key, revision: 1, source_identity_digest: identity,
        ledger_text, ledger_digest: await this.hash(REVIEW_DOMAINS.ledger + ledger_text) };
      await this.operation.assertReviewSource(source);
      journalAssert(typeof await this.store.compareAndSet(key, null, initial) === "boolean", "SOURCE_PRIVATE_REVIEW_INVALID");
      row = await this.load(key, identity, source, at);
    }
    journalAssert(row, "SOURCE_PRIVATE_REVIEW_INVALID"); return { row, identity };
  }
  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { throw new SourceJournalError("SOURCE_PRIVATE_REVIEW_UNCONFIRMED"); }
  }
  private wrap<T>(result: T, row: ReviewRecord) {
    const wrapped = { format: "c2-private-source-review-service-v1", state: "PRIVATE_REVIEW_LEDGER_DURABLE_ONLY",
      validation_mode: "RETAINED_PLAN_ONLY", ledger_version: row.revision - 1, ledger_digest: row.ledger_digest,
      source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, result };
    journalAssert(sourceBytes(reviewJson(wrapped)) <= REVIEW_LIMITS.view_bytes, "SOURCE_PRIVATE_REVIEW_INVALID"); return wrapped;
  }
  async view() {
    return this.guarded(async () => {
      const source = await this.operation.readForReview(), at = this.time(source);
      const { row, identity } = await this.open(source, at);
      const view = await prepareLocalMappingReviewFromPlan(source.core_text, () => this.context(source, row, at), text => this.hash(text));
      const result = this.wrap(view.result, row);
      await this.operation.assertReviewSource(source);
      const current = await this.load(row.key, identity, source, at);
      journalAssert(current && reviewJson(current) === reviewJson(row), "SOURCE_PRIVATE_REVIEW_INVALID");
      await this.operation.assertReviewSource(source); return result;
    });
  }
  async append(commandText: unknown) {
    return this.guarded(async () => {
      const command = reviewJson(parseSourceJson(sourceText(commandText as string, 1, REVIEW_LIMITS.control_bytes)));
      const source = await this.operation.readForReview(), at = this.time(source);
      const { row, identity } = await this.open(source, at);
      const plan = await planLocalMappingReviewFromPlan(source.core_text, row.ledger_text, command,
        () => this.context(source, row, at), text => this.hash(text));
      if (plan.result.append_required && row.revision > 1) {
        const prior = parseLedgerEnvelope(row.ledger_text, this.anchor(source));
        const last = sourceObject(sourceArray(prior.evidence).at(-1)!);
        journalAssert(sourceInstant(at) >= sourceInstant(sourceText(last.reviewed_at)), "SOURCE_PRIVATE_REVIEW_INVALID");
      }
      const next: ReviewRecord = { ...row, revision: row.revision + (plan.result.append_required ? 1 : 0),
        ledger_text: plan.result.ledger_text, ledger_digest: plan.result.ledger_digest };
      const result = this.wrap(plan.result, next); // Prove complete output budget before any evidence CAS.
      journalAssert(sourceBytes(reviewJson(next)) <= RECORD_LIMIT, "SOURCE_PRIVATE_REVIEW_INVALID");
      await this.operation.assertReviewSource(source);
      if (plan.result.append_required)
        journalAssert(typeof await this.store.compareAndSet(row.key, row.revision, next) === "boolean", "SOURCE_PRIVATE_REVIEW_INVALID");
      const saved = await this.load(row.key, identity, source, at);
      journalAssert(saved, "SOURCE_PRIVATE_REVIEW_INVALID");
      // A competing same request may have won with its own original time. Replay
      // that exact durable evidence; never overwrite it or rebase a new command.
      const replay = await planLocalMappingReviewFromPlan(source.core_text, saved.ledger_text, command,
        () => this.context(source, saved, at), text => this.hash(text));
      journalAssert(!replay.result.append_required, "SOURCE_PRIVATE_REVIEW_INVALID");
      await this.operation.assertReviewSource(source);
      return reviewJson(saved) === reviewJson(next) ? result : this.wrap(replay.result, saved);
    });
  }
}
