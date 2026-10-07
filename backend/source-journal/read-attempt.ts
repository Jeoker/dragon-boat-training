import { parseSourceJson, sourceBytes, sourceCanonical, sourceInstant, sourceObject,
  type SourceJson } from "../../shared/c2-source-capture-contract";
import { readPrivateSourceOperationContext } from "./operation";
import { journalAssert, sanitizeJournalError } from "./service";
import type { SourceReadCheckpointPort, SourceReadContext } from "./source-reader";

const canonical = (value: unknown) => sourceCanonical(value as SourceJson);
const LIMITS = Object.freeze({ requests: 384, response_bytes: 6_000_000, record_bytes: 14_000_000 });
interface Entry {
  request_text: string; response_text: string; digest: string;
  observed_start_at: string; observed_end_at: string;
}
export interface PrivateSourceReadRecord {
  format: "c2-private-source-read-v1"; key: string; revision: number; context_text: string;
  observed_start_at: string; observed_end_at: string | null;
  entries: Entry[]; pending: { request_text: string; observed_start_at: string } | null;
}
/** Contains raw pages, ranges and private request URLs. The same privacy/CAS
 * requirements as operation storage apply; isolate it from business TeamState/public DTOs. */
export interface PrivateSourceReadStore {
  read(key: string): Promise<unknown | null>;
  compareAndSet(key: string, revision: number | null, value: PrivateSourceReadRecord): Promise<boolean>;
}
const exact = (value: unknown, keys: string[]) => {
  const row = sourceObject(value as SourceJson);
  journalAssert(Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key)), "SOURCE_CHECKPOINT_INVALID");
  return row;
};

/** Sequential append-only read transcript. A begun request with no durable
 * reply is unresolved: it MUST NOT be refetched from a changed live source.
 * Completed entries can be replayed; only never-started requests may continue. */
export class PrivateSourceReadAttempt implements SourceReadCheckpointPort {
  constructor(private readonly contextPort: () => unknown, private readonly store: PrivateSourceReadStore,
    private readonly hashPort: (text: string) => Promise<string>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly beforeRequest?: (url: string) => Promise<void>) {}

  async open(readContext: SourceReadContext, start: string) {
    return this.guarded(async () => {
      const context = readPrivateSourceOperationContext(this.contextPort()), contextText = canonical(context);
      journalAssert(canonical(context.read_context) === canonical(readContext), "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
      const fresh = () => journalAssert(canonical(readPrivateSourceOperationContext(this.contextPort())) === contextText,
        "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
      const hash = async (text: string) => {
        const digest = await this.hashPort(text); fresh();
        journalAssert(typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/u.test(digest), "SOURCE_CHECKPOINT_INVALID");
        return digest;
      };
      const key = await hash("c2-private-source-read-key-v1\n" + canonical([
        context.read_context.source.team_id, context.read_context.source.source_operation_id]));
      const time = (value: string) => {
        const instant = sourceInstant(value), beginning = sourceInstant(row.observed_start_at);
        journalAssert(instant >= beginning && instant - beginning <= 15n * 60n * 1_000_000_000n,
          "SOURCE_CHECKPOINT_TIME_BUDGET_EXCEEDED");
        return instant;
      };
      let row: PrivateSourceReadRecord;
      const load = async () => {
        const raw = await this.store.read(key); fresh();
        if (raw === null) return null;
        const text = canonical(raw);
        journalAssert(sourceBytes(text) <= LIMITS.record_bytes, "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
        const saved = exact(JSON.parse(text), ["format", "key", "revision", "context_text", "observed_start_at",
          "observed_end_at", "entries", "pending"]);
        journalAssert(saved.format === "c2-private-source-read-v1" && saved.key === key && saved.context_text === contextText,
          "SOURCE_CHECKPOINT_CONTEXT_CHANGED");
        journalAssert(typeof saved.observed_start_at === "string" && Array.isArray(saved.entries) && saved.entries.length <= LIMITS.requests,
          "SOURCE_CHECKPOINT_INVALID");
        const beginning = sourceInstant(saved.observed_start_at);
        let last = beginning, bytes = 0;
        const interval = (a: unknown, b: unknown) => {
          journalAssert(typeof a === "string" && typeof b === "string", "SOURCE_CHECKPOINT_INVALID");
          const first = sourceInstant(a), end = sourceInstant(b);
          journalAssert(first >= last && end >= first && end - beginning <= 15n * 60n * 1_000_000_000n,
            "SOURCE_CHECKPOINT_INVALID");
          last = end;
        };
        for (const [index, value] of saved.entries.entries()) {
          const entry = exact(value, ["request_text", "response_text", "digest", "observed_start_at", "observed_end_at"]);
          journalAssert(typeof entry.request_text === "string" && typeof entry.response_text === "string", "SOURCE_CHECKPOINT_INVALID");
          const request = exact(parseSourceJson(entry.request_text), ["url", "method", "body"]);
          journalAssert(typeof request.url === "string" && canonical(request) === entry.request_text, "SOURCE_CHECKPOINT_INVALID");
          const response = sourceObject(parseSourceJson(entry.response_text));
          journalAssert(canonical(response) === entry.response_text && entry.digest === await hash(
            "c2-private-source-read-entry-v1\n" + canonical([index, entry.request_text,
              entry.response_text, entry.observed_start_at, entry.observed_end_at])), "SOURCE_CHECKPOINT_CONTENT_CHANGED");
          bytes += sourceBytes(entry.response_text); interval(entry.observed_start_at, entry.observed_end_at);
        }
        journalAssert(bytes <= LIMITS.response_bytes, "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
        if (saved.pending !== null) {
          const pending = exact(saved.pending, ["request_text", "observed_start_at"]);
          journalAssert(typeof pending.request_text === "string" && saved.observed_end_at === null, "SOURCE_CHECKPOINT_INVALID");
          exact(parseSourceJson(pending.request_text), ["url", "method", "body"]);
          interval(pending.observed_start_at, pending.observed_start_at);
        }
        if (saved.observed_end_at !== null) interval(saved.observed_end_at, saved.observed_end_at);
        journalAssert(saved.revision === 1 + saved.entries.length * 2 + (saved.pending === null ? 0 : 1) +
          (saved.observed_end_at === null ? 0 : 1), "SOURCE_CHECKPOINT_INVALID");
        return saved as unknown as PrivateSourceReadRecord;
      };
      const save = async (next: PrivateSourceReadRecord, revision: number | null) => {
        fresh();
        journalAssert(sourceBytes(canonical(next)) <= LIMITS.record_bytes &&
          sourceBytes(JSON.stringify(next)) <= LIMITS.record_bytes, "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
        const won = await this.store.compareAndSet(key, revision, next); fresh();
        journalAssert(won === true, "SOURCE_CHECKPOINT_CAS_UNCONFIRMED"); row = next;
      };
      const existing = await load();
      if (existing) row = existing;
      else {
        sourceInstant(start);
        await save({ format: "c2-private-source-read-v1", key, revision: 1, context_text: contextText,
          observed_start_at: start, observed_end_at: null, entries: [], pending: null }, null);
      }
      let cursor = 0;
      return {
        observed_start_at: row!.observed_start_at, observed_end_at: row!.observed_end_at,
        request: (url: string, body: unknown | undefined, read: () => Promise<Record<string, unknown>>) => this.guarded(async () => {
          fresh();
          const requestText = canonical({ url, method: body === undefined ? "GET" : "POST", body: body ?? null }), index = cursor++;
          const saved = (await load())!; row = saved;
          const entry = saved.entries[index];
          if (entry) {
            journalAssert(entry.request_text === requestText, "SOURCE_CHECKPOINT_REQUEST_CHANGED");
            return JSON.parse(entry.response_text) as Record<string, unknown>;
          }
          journalAssert(index === saved.entries.length && saved.observed_end_at === null,
            "SOURCE_CHECKPOINT_REQUEST_CHANGED");
          journalAssert(saved.pending === null, "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
          journalAssert(index < LIMITS.requests, "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
          // A host may yield before an unstarted request. Completed replies replay
          // first; yielding never creates an unknown STARTED marker.
          await this.beforeRequest?.(url); fresh();
          const began = this.now(); time(began);
          if (saved.entries.length) journalAssert(sourceInstant(began) >= sourceInstant(saved.entries.at(-1)!.observed_end_at), "SOURCE_CHECKPOINT_INVALID");
          await save({ ...saved, revision: saved.revision + 1, pending: { request_text: requestText, observed_start_at: began } }, saved.revision);
          const responseText = canonical(await read()); fresh();
          // Keep the strict raw scanner's per-response budget and depth contract.
          sourceObject(parseSourceJson(responseText));
          const ended = this.now(); time(ended);
          journalAssert(sourceInstant(ended) >= sourceInstant(began), "SOURCE_CHECKPOINT_INVALID");
          journalAssert(sourceBytes(responseText) + saved.entries.reduce((count, item) => count + sourceBytes(item.response_text), 0) <=
            LIMITS.response_bytes, "SOURCE_CHECKPOINT_BUDGET_EXCEEDED");
          const digest = await hash("c2-private-source-read-entry-v1\n" + canonical([index, requestText, responseText, began, ended]));
          await save({ ...row, revision: row.revision + 1, pending: null, entries: [...saved.entries,
            { request_text: requestText, response_text: responseText, digest, observed_start_at: began, observed_end_at: ended }] }, row.revision);
          return JSON.parse(responseText) as Record<string, unknown>;
        }),
        finish: (end: string) => this.guarded(async () => {
          row = (await load())!;
          journalAssert(row.pending === null && cursor === row.entries.length, "SOURCE_CHECKPOINT_REQUEST_UNRESOLVED");
          if (row.observed_end_at !== null) return row.observed_end_at;
          time(end);
          journalAssert(!row.entries.length || sourceInstant(end) >= sourceInstant(row.entries.at(-1)!.observed_end_at), "SOURCE_CHECKPOINT_INVALID");
          await save({ ...row, revision: row.revision + 1, observed_end_at: end }, row.revision);
          return end;
        }),
      };
    });
  }
  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      throw sanitizeJournalError(error, "SOURCE_CHECKPOINT_DEPENDENCY_UNCONFIRMED");
    }
  }
}
