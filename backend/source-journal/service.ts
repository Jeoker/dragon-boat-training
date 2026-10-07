// Private Google-side journal storage. Never expose through public DTOs.
import { SOURCE_LIMITS, parseGeneratedSourceJson, sourceBytes, sourceCanonical, sourceInteger,
  sourceObject, sourceText, type SourceJson } from "../../shared/c2-source-capture-contract";
import { readPlanValidationContext, type PlanValidationContext, type PlanHashPort }
  from "../../shared/c2-source-plan-validation-contract";
import { validateLocalSourcePlanCore } from "../../shared/c2-source-plan-validation-projection";

export const JOURNAL_FORMAT = "c2-private-source-journal-v1";
export const JOURNAL_LIMITS = Object.freeze({ control_bytes: 8_000, part_bytes: 16_000, parts: 127 });
export class SourceJournalError extends Error {
  constructor(readonly code: string) {
    super("Private source journal could not be confirmed."); this.name = "SourceJournalError";
  }
}
// Only fixed diagnostics may cross a private service boundary. Dependencies can
// throw this exported class too, with altered message, code getters or extra raw
// fields. Never forward their object or evaluate diagnostic accessors.
const PRIVATE_DIAGNOSTICS = new Set(`
JOURNAL_BUDGET_EXCEEDED JOURNAL_CONTEXT_INVALID JOURNAL_GOOGLE_HOST_INVALID
JOURNAL_GOOGLE_REQUEST_UNCONFIRMED JOURNAL_GOOGLE_SHAPE_INVALID JOURNAL_HASH_FAILED
JOURNAL_IDENTITY_OR_CONTENT_CHANGED JOURNAL_INPUT_OR_DEPENDENCY_INVALID JOURNAL_LAYOUT_INVALID
JOURNAL_NOT_FOUND JOURNAL_OAUTH_UNAVAILABLE JOURNAL_OWNERSHIP_CHANGED JOURNAL_PLAN_INVALID
JOURNAL_PRIVACY_UNPROVEN JOURNAL_READ_DRIFT JOURNAL_READ_UNCONFIRMED JOURNAL_WRITE_UNCONFIRMED
SOURCE_CHECKPOINT_BUDGET_EXCEEDED SOURCE_CHECKPOINT_CAS_UNCONFIRMED SOURCE_CHECKPOINT_CONTENT_CHANGED
SOURCE_CHECKPOINT_CONTEXT_CHANGED SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED SOURCE_CHECKPOINT_INVALID
SOURCE_CHECKPOINT_REQUEST_CHANGED SOURCE_CHECKPOINT_REQUEST_UNRESOLVED SOURCE_CHECKPOINT_TIME_BUDGET_EXCEEDED
SOURCE_OPERATION_AUTHORITY_UNCONFIRMED SOURCE_OPERATION_BUDGET_EXCEEDED SOURCE_OPERATION_CANDIDATE_CHANGED
SOURCE_OPERATION_CANDIDATE_CONFLICT SOURCE_OPERATION_CANDIDATE_INVALID SOURCE_OPERATION_CANDIDATE_REQUIRED
SOURCE_OPERATION_CONTEXT_INVALID SOURCE_OPERATION_DECLARATIONS_CHANGED SOURCE_OPERATION_DEPENDENCY_UNCONFIRMED
SOURCE_OPERATION_DIGEST_INVALID SOURCE_OPERATION_HASH_UNCONFIRMED SOURCE_OPERATION_IDENTITY_CHANGED
SOURCE_OPERATION_JOURNAL_CHANGED SOURCE_OPERATION_OBSERVATION_INVALID SOURCE_OPERATION_OWNERSHIP_CHANGED
SOURCE_OPERATION_PIN_UNCONFIRMED SOURCE_OPERATION_RECEIPT_CHANGED SOURCE_OPERATION_RECEIPT_INVALID
SOURCE_OPERATION_RECEIPT_UNCONFIRMED SOURCE_OPERATION_SCOPE_CHANGED SOURCE_OPERATION_SHAPE_INVALID
SOURCE_OPERATION_STATE_INVALID SOURCE_OPERATION_WRITE_NOT_STARTED SOURCE_OPERATION_WRITE_UNCONFIRMED
SOURCE_PRIVATE_AUTHORITY_CHANGED SOURCE_PRIVATE_AUTHORITY_UNCONFIRMED SOURCE_PRIVATE_TARGET_UNREGISTERED
SOURCE_PRIVATE_REVIEW_INVALID SOURCE_PRIVATE_REVIEW_UNCONFIRMED SOURCE_READ_API_USER_CHANGED
SOURCE_READ_BINDING_UNPROVEN SOURCE_READ_BUDGET_EXCEEDED SOURCE_READ_CONTEXT_INVALID SOURCE_READ_DRIFT
SOURCE_READ_DUPLICATE_RESPONSE SOURCE_READ_GRID_BUDGET_EXCEEDED SOURCE_READ_GRID_INCOMPLETE
SOURCE_READ_INPUT_UNSUPPORTED SOURCE_READ_OWNERSHIP_CHANGED SOURCE_READ_PAGE_BUDGET_EXCEEDED
SOURCE_READ_PAGE_SHAPE_INVALID SOURCE_READ_PAGE_TOKEN_INVALID SOURCE_READ_TIME_BUDGET_EXCEEDED
SOURCE_REVIEW_AUTHORITY_REQUIRED SOURCE_REVIEW_CAPTURE_CHANGED SOURCE_REVIEW_CAPTURE_REQUIRED
SOURCE_REVIEW_OWNERSHIP_CHANGED SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED SOURCE_SERVER_AUTHORITY_UNCONFIRMED
SOURCE_SERVER_COMMAND_INVALID SOURCE_SERVER_CONFIG_INVALID SOURCE_SERVER_CREDENTIALS_UNAVAILABLE
SOURCE_SERVER_IDENTITY_CHANGED SOURCE_SERVER_RESPONSE_INVALID SOURCE_TARGET_REGISTRY_CONFLICT
SOURCE_TARGET_REGISTRY_UNCONFIRMED SOURCE_TARGET_REGISTRY_UNREGISTERED
SOURCE_READ_STRING_REQUIRED SOURCE_READ_STRING_BOUNDS SOURCE_READ_INVALID_TIMESTAMP
SOURCE_READ_OBSERVED_INTERVAL_INVALID SOURCE_READ_RECORD_BYTES_EXCEEDED SOURCE_READ_RECORD_COUNT_EXCEEDED
SOURCE_READ_TOTAL_BYTES_EXCEEDED SOURCE_READ_UNSUPPORTED_LATE_RESPONSE
`.trim().split(/\s+/u));
export function sanitizeJournalError(error: unknown, fallback: string): SourceJournalError {
  try {
    if (error instanceof SourceJournalError) {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code && Object.hasOwn(code, "value") && typeof code.value === "string" && PRIVATE_DIAGNOSTICS.has(code.value))
        return new SourceJournalError(code.value);
    }
  } catch { /* Hostile reflection cannot disclose a dependency exception. */ }
  return new SourceJournalError(PRIVATE_DIAGNOSTICS.has(fallback) ? fallback : "JOURNAL_INPUT_OR_DEPENDENCY_INVALID");
}
export function journalAssert(value: unknown, code: string): asserts value {
  if (!value) throw new SourceJournalError(code);
}
export interface JournalContext {
  plan: PlanValidationContext;
  attempt_id: string;
  actor_id: string;
  spreadsheet_id: string;
  sheet_id: number;
  owner_permission_id: string;
}
export interface JournalStore {
  assertPrivate(context: JournalContext): Promise<void>;
  // null means the pinned Tab does not exist. A failed read must throw.
  read(context: JournalContext): Promise<readonly string[] | null>;
  // Atomically add the pinned Tab AND all rows. Never update an existing Tab.
  create(context: JournalContext, rows: readonly string[]): Promise<void>;
}
export interface JournalControl {
  format: typeof JOURNAL_FORMAT;
  state: "PRIVATE_JOURNAL_READBACK_ONLY";
  source_status: "SOURCE_NOT_VERIFIED";
  annual_export_authorized: false;
  source_plan_digest: string;
  journal_digest: string;
  utf8_bytes: number;
  part_count: number;
}
const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
const fail = (code: string): never => { throw new SourceJournalError(code); };
function bounded(value: unknown, max: number): string {
  journalAssert(typeof value === "string" && value.length <= max && sourceBytes(value) <= max,
    "JOURNAL_BUDGET_EXCEEDED");
  sourceText(value, 1, max); // Reject invalid Unicode before network encoding.
  return value;
}
function readContext(port: () => unknown): JournalContext {
  try {
    const input = port();
    journalAssert(input !== null && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype,
      "JOURNAL_CONTEXT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = ["plan", "attempt_id", "actor_id", "spreadsheet_id", "sheet_id", "owner_permission_id"];
    journalAssert(Reflect.ownKeys(input).length === keys.length && keys.every(key =>
      descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], "value")), "JOURNAL_CONTEXT_INVALID");
    const values = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    const context: JournalContext = {
      plan: readPlanValidationContext(() => values.plan),
      attempt_id: sourceText(values.attempt_id, 1, 128), actor_id: sourceText(values.actor_id, 1, 128),
      spreadsheet_id: sourceText(values.spreadsheet_id, 1, 128),
      sheet_id: sourceInteger(values.sheet_id, 1, 2_147_483_647),
      owner_permission_id: sourceText(values.owner_permission_id, 1, 128),
    };
    journalAssert(/^[A-Za-z0-9_-]+$/u.test(context.spreadsheet_id) &&
      context.spreadsheet_id !== context.plan.source.spreadsheet_id, "JOURNAL_CONTEXT_INVALID");
    bounded(canonical(context), JOURNAL_LIMITS.control_bytes);
    return context;
  } catch { return fail("JOURNAL_CONTEXT_INVALID"); }
}

// Preserve code points without normalization. Transport parts do not renumber
// the retained source plan's namespaces, chunks or record offsets.
export function journalParts(text: string): string[] {
  bounded(text, SOURCE_LIMITS.total_bytes);
  const parts: string[] = [];
  let start = 0, offset = 0, bytes = 0;
  for (const point of text) {
    const size = sourceBytes(point);
    if (bytes + size > JOURNAL_LIMITS.part_bytes) {
      parts.push(text.slice(start, offset)); start = offset; bytes = 0;
    }
    bytes += size; offset += point.length;
  }
  if (offset > start) parts.push(text.slice(start));
  journalAssert(parts.length >= 1 && parts.length <= JOURNAL_LIMITS.parts, "JOURNAL_BUDGET_EXCEEDED");
  return parts;
}

/** Caller must durably pin server-owned context BEFORE IO and authenticate Coach separately.
 * This adapter proves retained bytes/storage, never actual Form/Sheet capture. */
export class PrivateSourceJournal {
  constructor(private readonly contextPort: () => unknown, private readonly store: JournalStore,
    private readonly hashPort: PlanHashPort) {}
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      throw sanitizeJournalError(error, "JOURNAL_INPUT_OR_DEPENDENCY_INVALID");
    }
  }
  private fresh(context: JournalContext) {
    journalAssert(canonical(readContext(this.contextPort)) === canonical(context), "JOURNAL_OWNERSHIP_CHANGED");
  }
  private async hash(text: string, context: JournalContext): Promise<string> {
    let digest: string;
    try { digest = await this.hashPort(text); } catch { return fail("JOURNAL_HASH_FAILED"); }
    this.fresh(context);
    journalAssert(typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/u.test(digest), "JOURNAL_HASH_FAILED");
    return digest;
  }
  private async privateTarget(context: JournalContext) {
    try { await this.store.assertPrivate(context); } catch { return fail("JOURNAL_PRIVACY_UNPROVEN"); }
    this.fresh(context);
  }
  private async read(context: JournalContext): Promise<string[] | null> {
    let rows: readonly string[] | null;
    try { rows = await this.store.read(context); } catch { return fail("JOURNAL_READ_UNCONFIRMED"); }
    this.fresh(context);
    if (rows === null) return null;
    journalAssert(Array.isArray(rows) && rows.length >= 2 && rows.length <= JOURNAL_LIMITS.parts + 1,
      "JOURNAL_LAYOUT_INVALID");
    let total = 0;
    // Copy port primitives before any hash await.
    const copy = Array.from(rows, (text, index) => {
      const value = bounded(text, index === 0 ? JOURNAL_LIMITS.control_bytes : JOURNAL_LIMITS.part_bytes);
      total += sourceBytes(value); return value;
    });
    journalAssert(total <= SOURCE_LIMITS.total_bytes + JOURNAL_LIMITS.control_bytes, "JOURNAL_BUDGET_EXCEEDED");
    return copy;
  }
  private async validate(core: string, context: JournalContext) {
    try {
      await validateLocalSourcePlanCore(core, () => { this.fresh(context); return context.plan; },
        text => this.hash(text, context));
    } catch (error) {
      // The shared validator sanitizes dependency failures; retain our broader
      // target/actor fence even when it masks a hash-port ownership rejection.
      this.fresh(context);
      throw sanitizeJournalError(error, "JOURNAL_PLAN_INVALID");
    }
    this.fresh(context);
  }
  private async confirm(rows: string[] | null, context: JournalContext) {
    journalAssert(rows !== null, "JOURNAL_NOT_FOUND");
    let header;
    try { header = sourceObject(parseGeneratedSourceJson(rows[0])); }
    catch { return fail("JOURNAL_LAYOUT_INVALID"); }
    const core = rows.slice(1).join("");
    bounded(core, SOURCE_LIMITS.total_bytes);
    const expected = { format: JOURNAL_FORMAT, context, core_utf8_bytes: sourceBytes(core), part_count: rows.length - 1 };
    journalAssert(rows[0] === canonical(expected) && canonical(journalParts(core)) === canonical(rows.slice(1)) &&
      canonical(header) === rows[0], "JOURNAL_IDENTITY_OR_CONTENT_CHANGED");
    await this.validate(core, context);
    const digest = await this.hash("c2-private-source-journal-header-v1\n" + rows[0], context);
    await this.privateTarget(context);
    const second = await this.read(context);
    journalAssert(second !== null && canonical(second) === canonical(rows), "JOURNAL_READ_DRIFT");
    await this.privateTarget(context);
    return {
      control: { format: JOURNAL_FORMAT, state: "PRIVATE_JOURNAL_READBACK_ONLY", source_status: "SOURCE_NOT_VERIFIED",
        annual_export_authorized: false, source_plan_digest: context.plan.source_plan_digest,
        journal_digest: digest, utf8_bytes: sourceBytes(core), part_count: rows.length - 1 } as JournalControl,
      // Private return. Ordinary bridge responses may return control, never this full object.
      core_text: core,
    };
  }
  async resume() {
    return this.guarded(async () => {
      const context = readContext(this.contextPort);
      await this.privateTarget(context);
      return this.confirm(await this.read(context), context);
    });
  }
  async stage(coreText: unknown) {
    return this.guarded(() => this.stagePrivate(coreText));
  }
  private async stagePrivate(coreText: unknown) {
    const context = readContext(this.contextPort);
    const core = bounded(coreText, SOURCE_LIMITS.total_bytes);
    await this.validate(core, context);
    await this.privateTarget(context);
    const existing = await this.read(context);
    if (existing !== null) return this.confirm(existing, context);
    const parts = journalParts(core);
    const header = canonical({ format: JOURNAL_FORMAT, context, core_utf8_bytes: sourceBytes(core), part_count: parts.length });
    bounded(header, JOURNAL_LIMITS.control_bytes);
    this.fresh(context);
    try { await this.store.create(context, [header, ...parts]); }
    catch { /* Unknown response: only read the SAME target, never create a second one. */ }
    this.fresh(context);
    await this.privateTarget(context);
    const saved = await this.read(context);
    journalAssert(saved !== null, "JOURNAL_WRITE_UNCONFIRMED");
    return this.confirm(saved, context);
  }
}
