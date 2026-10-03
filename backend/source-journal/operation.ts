import { SOURCE_LIMITS, sourceBytes, sourceCanonical, sourceInstant, sourceInteger,
  sourceObject, sourceText, type SourceJson } from "../../shared/c2-source-capture-contract";
import { validateLocalSourcePlanCore } from "../../shared/c2-source-plan-validation-projection";
import { readSourceContext, type SourceReadContext } from "./source-reader";
import { JOURNAL_FORMAT, journalParts, SourceJournalError, sanitizeJournalError, journalAssert, type JournalContext, type JournalControl } from "./service";

export interface PrivateSourceOperationContext {
  read_context: SourceReadContext;
  attempt_id: string; actor_id: string;
  journal_spreadsheet_id: string; journal_sheet_id: number; owner_permission_id: string;
}
export interface PrivateSourceCandidate {
  core_text: string; observation_text: string; source_plan_digest: string; candidate_digest: string;
}
export interface PrivateSourceReviewSource {
  context: PrivateSourceOperationContext;
  core_text: string; source_plan_digest: string; candidate_digest: string; receipt_digest: string; observed_end_at: string;
}
export interface PrivateSourceOperationRecord {
  format: "c2-private-source-operation-v1"; key: string; context_text: string;
  revision: number; phase: "PINNED" | "CANDIDATE_DURABLE" | "JOURNAL_WRITE_STARTED" | "JOURNAL_READBACK_CONFIRMED";
  candidate: PrivateSourceCandidate | null;
  receipt: { control: JournalControl; receipt_digest: string } | null;
}
/** This port stores RAW candidate content. It MUST be private, durable and CAS
 * atomic. Never implement it in the public Worker/DO or a public backup table. */
export interface PrivateSourceOperationStore {
  read(key: string): Promise<unknown | null>;
  compareAndSet(key: string, revision: number | null, value: PrivateSourceOperationRecord): Promise<boolean>;
}
export interface PrivateSourceOperationPorts {
  store: PrivateSourceOperationStore;
  hash(text: string): Promise<string>;
  checkAuthority?(context: PrivateSourceOperationContext): Promise<void>;
  readSource(context: SourceReadContext): Promise<{ plan: { canonical_text: string }; observation: unknown }>;
  journal(context: () => JournalContext): {
    stage(core: string): Promise<{ core_text: string; control: JournalControl }>;
    resume(): Promise<{ core_text: string; control: JournalControl }>;
  };
}
const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
const PHASES = ["PINNED", "CANDIDATE_DURABLE", "JOURNAL_WRITE_STARTED", "JOURNAL_READBACK_CONFIRMED"] as const;
const RECORD_BYTES = 14_000_000;
const exact = (value: unknown, keys: string[]) => {
  const row = sourceObject(value as SourceJson);
  journalAssert(Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key)), "SOURCE_OPERATION_SHAPE_INVALID");
  return row;
};
const digestText = (value: unknown) => {
  journalAssert(typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value), "SOURCE_OPERATION_DIGEST_INVALID");
  return value;
};

export function readPrivateSourceOperationContext(value: unknown): PrivateSourceOperationContext {
  try {
    const row = exact(JSON.parse(canonical(value)), ["read_context", "attempt_id", "actor_id",
      "journal_spreadsheet_id", "journal_sheet_id", "owner_permission_id"]);
    const read_context = readSourceContext(row.read_context);
    const result = { read_context, attempt_id: sourceText(row.attempt_id, 1, 128), actor_id: sourceText(row.actor_id, 1, 128),
      journal_spreadsheet_id: sourceText(row.journal_spreadsheet_id, 1, 128), journal_sheet_id: sourceInteger(row.journal_sheet_id, 1, 2_147_483_647),
      owner_permission_id: sourceText(row.owner_permission_id, 1, 128) };
    journalAssert(/^[A-Za-z0-9_-]+$/u.test(result.journal_spreadsheet_id) &&
      result.journal_spreadsheet_id !== read_context.source.spreadsheet_id &&
      result.owner_permission_id === read_context.api_user_permission_id && sourceBytes(canonical(result)) <= SOURCE_LIMITS.input_bytes,
      "SOURCE_OPERATION_CONTEXT_INVALID");
    return result;
  } catch { throw new SourceJournalError("SOURCE_OPERATION_CONTEXT_INVALID"); }
}

/** Private orchestration only; caller authentication and authoritative binding
 * lookup remain prerequisites. No SOURCE_CAPTURE_FIXED/VERIFIED promotion.
 * A begun unknown write can only resume the original journal, never stage again. */
export class PrivateSourceOperation {
  constructor(private readonly contextPort: () => unknown, private readonly ports: PrivateSourceOperationPorts) {}
  private context(): PrivateSourceOperationContext {
    return readPrivateSourceOperationContext(this.contextPort());
  }
  private fresh(context: PrivateSourceOperationContext) {
    journalAssert(canonical(this.context()) === canonical(context), "SOURCE_OPERATION_OWNERSHIP_CHANGED");
  }
  private async authority(context: PrivateSourceOperationContext) {
    this.fresh(context);
    if (!this.ports.checkAuthority) return;
    try { await this.ports.checkAuthority(JSON.parse(canonical(context))); }
    catch { throw new SourceJournalError("SOURCE_OPERATION_AUTHORITY_UNCONFIRMED"); }
    this.fresh(context);
  }
  private async hash(text: string, context: PrivateSourceOperationContext) {
    let value;
    try { value = await this.ports.hash(text); } catch { throw new SourceJournalError("SOURCE_OPERATION_HASH_UNCONFIRMED"); }
    this.fresh(context); return digestText(value);
  }
  private async key(context: PrivateSourceOperationContext) {
    return this.hash("c2-private-source-operation-key-v1\n" + canonical([
      context.read_context.source.team_id, context.read_context.source.source_operation_id, context.attempt_id]), context);
  }
  private journalContext(context: PrivateSourceOperationContext, candidate: PrivateSourceCandidate): JournalContext {
    return { plan: { source: context.read_context.source, source_format: "c2-source-plan-v1", source_plan_digest: candidate.source_plan_digest },
      attempt_id: context.attempt_id, actor_id: context.actor_id, spreadsheet_id: context.journal_spreadsheet_id,
      sheet_id: context.journal_sheet_id, owner_permission_id: context.owner_permission_id };
  }
  private async candidate(core: unknown, observation: unknown, context: PrivateSourceOperationContext): Promise<PrivateSourceCandidate> {
    const core_text = sourceText(core as SourceJson, 1, SOURCE_LIMITS.total_bytes);
    const source_plan_digest = await this.hash("c2-source-review-source-v1\n" + core_text, context);
    const planContext = this.journalContext(context, { core_text, source_plan_digest, observation_text: "", candidate_digest: "" }).plan;
    let validated;
    try {
      validated = await validateLocalSourcePlanCore(core_text, () => { this.fresh(context); return planContext; }, text => this.hash(text, context));
    } catch {
      this.fresh(context); // retain the operation fence when shared validation sanitizes a hash failure
      throw new SourceJournalError("SOURCE_OPERATION_CANDIDATE_INVALID");
    }
    this.fresh(context);
    // The plan validator proves internal consistency, but its retained mappings
    // also have to match the declarations pinned for this operation. Array order
    // is not a mapping identity; compare every complete declaration as a set.
    const pendingRecords = validated.private_collection.records.PRIVATE_PENDING;
    const mappings = pendingRecords
      .filter(({ record }) => record.record_type === "SHEET_ROW" && record.declared_mapping !== null)
      .map(({ record }) => canonical(record.declared_mapping)).sort();
    const sheetSchema = pendingRecords.find(({ record }) => record.record_type === "SHEET_SCHEMA")!.record;
    journalAssert(sourceObject(sheetSchema.raw).title === context.read_context.response_tab_title &&
      canonical(mappings) === canonical(context.read_context.declared_mappings.map(canonical).sort()),
      "SOURCE_OPERATION_DECLARATIONS_CHANGED");
    const row = exact(JSON.parse(canonical(observation)), ["format", "state", "observed_start_at", "observed_end_at", "passes",
      "source_status", "annual_export_authorized", "response_tab_link_evidence"]);
    journalAssert(row.format === "c2-source-observation-v1" && row.state === "TWO_READS_MATCHED_NOT_ATOMIC" && row.passes === 2 &&
      row.source_status === "SOURCE_NOT_VERIFIED" && row.annual_export_authorized === false &&
      row.response_tab_link_evidence === "SERVER_BINDING_DECLARATION_ONLY", "SOURCE_OPERATION_OBSERVATION_INVALID");
    const start = sourceText(row.observed_start_at, 1, 64), end = sourceText(row.observed_end_at, 1, 64);
    journalAssert(sourceInstant(end) >= sourceInstant(start) && sourceInstant(end) - sourceInstant(start) <= 15n * 60n * 1_000_000_000n,
      "SOURCE_OPERATION_OBSERVATION_INVALID");
    const metadata = validated.private_collection.metadata;
    journalAssert(metadata.observed_start_at === start && metadata.observed_end_at === end &&
      canonical(metadata.known_sources) === canonical(context.read_context.known_sources), "SOURCE_OPERATION_OBSERVATION_INVALID");
    const observation_text = canonical(row);
    return { core_text, observation_text, source_plan_digest,
      candidate_digest: await this.hash("c2-private-source-candidate-v1\n" + canonical([core_text, observation_text]), context) };
  }
  private async control(context: PrivateSourceOperationContext, candidate: PrivateSourceCandidate): Promise<JournalControl> {
    const parts = journalParts(candidate.core_text), header = canonical({ format: JOURNAL_FORMAT,
      context: this.journalContext(context, candidate), core_utf8_bytes: sourceBytes(candidate.core_text), part_count: parts.length });
    return { format: JOURNAL_FORMAT, state: "PRIVATE_JOURNAL_READBACK_ONLY", source_status: "SOURCE_NOT_VERIFIED",
      annual_export_authorized: false, source_plan_digest: candidate.source_plan_digest,
      journal_digest: await this.hash("c2-private-source-journal-header-v1\n" + header, context),
      utf8_bytes: sourceBytes(candidate.core_text), part_count: parts.length };
  }
  private async receipt(context: PrivateSourceOperationContext, key: string, candidate: PrivateSourceCandidate, control: unknown) {
    const expected = await this.control(context, candidate);
    journalAssert(canonical(control) === canonical(expected), "SOURCE_OPERATION_RECEIPT_INVALID");
    return { control: expected, receipt_digest: await this.hash("c2-private-source-operation-receipt-v1\n" +
      canonical([key, canonical(context), candidate.candidate_digest, expected]), context) };
  }
  private async load(key: string, context: PrivateSourceOperationContext) {
    const raw = await this.ports.store.read(key); this.fresh(context);
    if (raw === null) return null;
    const text = canonical(raw); journalAssert(sourceBytes(text) <= RECORD_BYTES, "SOURCE_OPERATION_BUDGET_EXCEEDED");
    const row = exact(JSON.parse(text), ["format", "key", "context_text", "revision", "phase", "candidate", "receipt"]);
    journalAssert(row.format === "c2-private-source-operation-v1" && row.key === key && row.context_text === canonical(context),
      "SOURCE_OPERATION_IDENTITY_CHANGED");
    const phaseIndex = PHASES.indexOf(row.phase as typeof PHASES[number]);
    journalAssert(phaseIndex >= 0 && row.revision === phaseIndex + 1, "SOURCE_OPERATION_STATE_INVALID");
    if (phaseIndex === 0) journalAssert(row.candidate === null && row.receipt === null, "SOURCE_OPERATION_STATE_INVALID");
    else {
      const saved = exact(row.candidate, ["core_text", "observation_text", "source_plan_digest", "candidate_digest"]);
      const candidate = await this.candidate(saved.core_text, JSON.parse(sourceText(saved.observation_text)), context);
      journalAssert(canonical(candidate) === canonical(saved), "SOURCE_OPERATION_CANDIDATE_CHANGED");
      if (phaseIndex === 3) {
        const savedReceipt = exact(row.receipt, ["control", "receipt_digest"]);
        journalAssert(canonical(await this.receipt(context, key, candidate, savedReceipt.control)) === canonical(savedReceipt),
          "SOURCE_OPERATION_RECEIPT_CHANGED");
      } else journalAssert(row.receipt === null, "SOURCE_OPERATION_STATE_INVALID");
    }
    this.fresh(context); return row as unknown as PrivateSourceOperationRecord;
  }
  private async commit(key: string, revision: number | null, row: PrivateSourceOperationRecord, context: PrivateSourceOperationContext) {
    this.fresh(context);
    const saved = await this.ports.store.compareAndSet(key, revision, row); this.fresh(context);
    journalAssert(typeof saved === "boolean", "SOURCE_OPERATION_WRITE_UNCONFIRMED");
    return saved;
  }
  private async pin(key: string, context: PrivateSourceOperationContext) {
    let row = await this.load(key, context);
    if (!row) {
      await this.commit(key, null, { format: "c2-private-source-operation-v1", key, context_text: canonical(context), revision: 1,
        phase: "PINNED", candidate: null, receipt: null }, context);
      row = await this.load(key, context);
    }
    journalAssert(row, "SOURCE_OPERATION_PIN_UNCONFIRMED"); return row;
  }
  private async open(context: PrivateSourceOperationContext) {
    // Fence the whole source operation, not just an attempt. Changing attempt ID
    // or target must not bypass an unresolved original Google write.
    const scopeKey = await this.hash("c2-private-source-operation-scope-v1\n" + canonical([
      context.read_context.source.team_id, context.read_context.source.source_operation_id]), context);
    const scope = await this.pin(scopeKey, context);
    journalAssert(scope.phase === "PINNED", "SOURCE_OPERATION_SCOPE_CHANGED");
    return this.pin(await this.key(context), context);
  }
  private summary(row: PrivateSourceOperationRecord) {
    return { format: row.format, operation_key: row.key, phase: row.phase, revision: row.revision,
      candidate_digest: row.candidate?.candidate_digest ?? null, receipt_digest: row.receipt?.receipt_digest ?? null,
      source_status: "SOURCE_NOT_VERIFIED" as const, annual_export_authorized: false as const };
  }
  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      throw sanitizeJournalError(error, "SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED");
    }
  }
  async capture() {
    return this.guarded(async () => {
      const context = this.context(); await this.authority(context);
      const row = await this.open(context);
      if (row.candidate) return this.summary(row); // never reread a durable candidate
      const observed = await this.ports.readSource(JSON.parse(canonical(context.read_context))); this.fresh(context);
      const candidate = await this.candidate(observed.plan.canonical_text, observed.observation, context);
      await this.authority(context);
      await this.commit(row.key, row.revision, { ...row, revision: 2, phase: "CANDIDATE_DURABLE", candidate }, context);
      const saved = await this.load(row.key, context);
      journalAssert(saved?.candidate?.candidate_digest === candidate.candidate_digest, "SOURCE_OPERATION_CANDIDATE_CONFLICT");
      return this.summary(saved);
    });
  }
  async stage() { return this.guarded(() => this.journal(false)); }
  async resume() { return this.guarded(() => this.journal(true)); }
  /** Private raw output only. Authenticated authority and an already confirmed
   * candidate are mandatory; review never stages or rereads the live source. */
  async readForReview(): Promise<PrivateSourceReviewSource> {
    return this.guarded(async () => {
      journalAssert(this.ports.checkAuthority, "SOURCE_REVIEW_AUTHORITY_REQUIRED");
      const context = this.context(); await this.authority(context);
      const row = await this.open(context);
      journalAssert(row.phase === "JOURNAL_READBACK_CONFIRMED" && row.candidate && row.receipt, "SOURCE_REVIEW_CAPTURE_REQUIRED");
      const result = { context, core_text: row.candidate.core_text, source_plan_digest: row.candidate.source_plan_digest,
        candidate_digest: row.candidate.candidate_digest, receipt_digest: row.receipt.receipt_digest,
        observed_end_at: JSON.parse(row.candidate.observation_text).observed_end_at as string };
      await this.assertReviewSource(result); return JSON.parse(canonical(result));
    });
  }
  async assertReviewSource(source: PrivateSourceReviewSource): Promise<void> {
    return this.guarded(async () => {
      journalAssert(this.ports.checkAuthority, "SOURCE_REVIEW_AUTHORITY_REQUIRED");
      const context = this.context();
      journalAssert(canonical(context) === canonical(source.context), "SOURCE_REVIEW_OWNERSHIP_CHANGED");
      await this.authority(context);
      const row = await this.open(context);
      journalAssert(row.phase === "JOURNAL_READBACK_CONFIRMED" && row.candidate?.candidate_digest === source.candidate_digest &&
        row.candidate.source_plan_digest === source.source_plan_digest && row.candidate.core_text === source.core_text &&
        row.receipt?.receipt_digest === source.receipt_digest,
        "SOURCE_REVIEW_CAPTURE_CHANGED");
      journalAssert(JSON.parse(row.candidate.observation_text).observed_end_at === source.observed_end_at, "SOURCE_REVIEW_CAPTURE_CHANGED");
      await this.resume(); // Recheck current private ACL and exact original content; never stage or reread the source.
      await this.authority(context);
    });
  }
  private async journal(resumeOnly: boolean) {
    const context = this.context(); await this.authority(context);
    let row = await this.open(context);
    journalAssert(row.candidate, "SOURCE_OPERATION_CANDIDATE_REQUIRED");
    let firstWrite = false;
    if (row.phase === "CANDIDATE_DURABLE") {
      journalAssert(!resumeOnly, "SOURCE_OPERATION_WRITE_NOT_STARTED");
      firstWrite = await this.commit(row.key, row.revision, { ...row, revision: 3, phase: "JOURNAL_WRITE_STARTED" }, context);
      row = (await this.load(row.key, context))!;
      journalAssert(row?.phase === "JOURNAL_WRITE_STARTED" || row?.phase === "JOURNAL_READBACK_CONFIRMED", "SOURCE_OPERATION_WRITE_UNCONFIRMED");
    }
    const candidate = row.candidate!;
    await this.authority(context);
    const journal = this.ports.journal(() => { this.fresh(context); return this.journalContext(context, candidate); });
    const result = firstWrite ? await journal.stage(candidate.core_text) : await journal.resume(); this.fresh(context);
    journalAssert(result.core_text === candidate.core_text, "SOURCE_OPERATION_JOURNAL_CHANGED");
    const receipt = await this.receipt(context, row.key, candidate, result.control);
    await this.authority(context);
    if (row.phase !== "JOURNAL_READBACK_CONFIRMED")
      await this.commit(row.key, row.revision, { ...row, revision: 4, phase: "JOURNAL_READBACK_CONFIRMED", receipt }, context);
    const saved = await this.load(row.key, context);
    journalAssert(saved?.phase === "JOURNAL_READBACK_CONFIRMED" && canonical(saved.receipt) === canonical(receipt), "SOURCE_OPERATION_RECEIPT_UNCONFIRMED");
    return this.summary(saved);
  }
}
