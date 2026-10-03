import { parseSourceJson, sourceBytes } from "../../shared/c2-source-capture-contract";
import { sanitizeJournalError, journalAssert } from "./service";

export type GoogleObject = Record<string, unknown>;
export const googleObject = (value: unknown): GoogleObject => {
  journalAssert(value !== null && typeof value === "object" && !Array.isArray(value), "JOURNAL_GOOGLE_SHAPE_INVALID");
  return value as GoogleObject;
};
export const googleArray = (value: unknown): unknown[] => {
  journalAssert(Array.isArray(value), "JOURNAL_GOOGLE_SHAPE_INVALID"); return value;
};

/** Private server transport. Bounded bodies, fixed hosts, no redirects or error-body logging. */
export class PrivateGoogleClient {
  constructor(private readonly token: () => Promise<string>,
    private readonly fetchPort: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  async request(url: string, method: "GET" | "POST", body?: unknown, limit = 64_000,
    sourceJson = false): Promise<GoogleObject> {
    try {
      const address = new URL(url);
      journalAssert(address.protocol === "https:" && !address.username && !address.password && !address.port &&
        !address.hash && ["www.googleapis.com", "sheets.googleapis.com", "forms.googleapis.com"].includes(address.hostname),
        "JOURNAL_GOOGLE_HOST_INVALID");
      const token = await this.token();
      journalAssert(typeof token === "string" && token.length > 0 && token.length <= 16_000 &&
        !/[\r\n]/u.test(token), "JOURNAL_OAUTH_UNAVAILABLE");
      const payload = body === undefined ? undefined : JSON.stringify(body);
      journalAssert(payload === undefined || sourceBytes(payload) <= 14_000_000, "JOURNAL_BUDGET_EXCEEDED");
      const response = await this.fetchPort(url, { method, redirect: "error", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      }, body: payload, signal: AbortSignal.timeout(30_000) });
      journalAssert(response.ok, "JOURNAL_GOOGLE_REQUEST_UNCONFIRMED");
      const declared = response.headers.get("content-length");
      journalAssert(declared === null || /^\d+$/u.test(declared) && Number(declared) <= limit,
        "JOURNAL_BUDGET_EXCEEDED");
      journalAssert(response.body, "JOURNAL_GOOGLE_SHAPE_INVALID");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let count = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          count += next.value.byteLength;
          journalAssert(count <= limit, "JOURNAL_BUDGET_EXCEEDED"); chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      // Full source responses use the original lexical/depth/finite-number scanner,
      // before JSON.parse could erase duplicate decoded keys or overflow numbers.
      return googleObject(sourceJson ? parseSourceJson(text) : JSON.parse(text));
    } catch (error) {
      throw sanitizeJournalError(error, "JOURNAL_GOOGLE_REQUEST_UNCONFIRMED");
    }
  }
}
