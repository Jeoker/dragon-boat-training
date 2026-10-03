import { C2_CONTRACT_VERSION } from "../../shared/c2-actions";
import { readSourceAuthorityPin, sourceAuthorityText, type SourceAuthorityPin } from "../../shared/c2-source-authority-contract";
import { parseGeneratedSourceJson, sourceObject, sourceText, sourceInteger, type SourceJson } from "../../shared/c2-source-capture-contract";
import { journalAssert, SourceJournalError } from "./service";

export interface SourceServerConfig {
  origin: string; team_id: string; backend_instance: string; backend_generation: string; writer_epoch: number;
}
export interface SourceServerCredentials { transport_key: string; session_token: string; }
const LIMIT = 2_000_000;
const fail = () => new SourceJournalError("SOURCE_SERVER_AUTHORITY_UNCONFIRMED");

/** Server-side only: configure the exact HTTPS origin and backend identity from
 * private configuration. Never take these or the credentials from browser fields.
 * No automatic retries, redirects, credential persistence or error-body logging. */
export class SourceServerAuthorityClient {
  private readonly config: SourceServerConfig;
  constructor(config: SourceServerConfig, private readonly credentials: () => Promise<SourceServerCredentials>,
    private readonly hash: (text: string) => Promise<string>,
    private readonly fetchPort: (url: string, init: RequestInit) => Promise<Response> = fetch) {
    try {
      const row = sourceObject(config as unknown as SourceJson), origin = sourceText(row.origin, 1, 1024), url = new URL(origin);
      journalAssert(Object.keys(row).length === 5 && Object.keys(row).every(key =>
        ["origin", "team_id", "backend_instance", "backend_generation", "writer_epoch"].includes(key)) &&
        url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
        url.pathname === "/" && origin === url.origin, "SOURCE_SERVER_CONFIG_INVALID");
      this.config = { origin, team_id: sourceText(row.team_id, 1, 512), backend_instance: sourceText(row.backend_instance, 1, 512),
        backend_generation: sourceText(row.backend_generation, 1, 512), writer_epoch: sourceInteger(row.writer_epoch) };
    } catch { throw new SourceJournalError("SOURCE_SERVER_CONFIG_INVALID"); }
  }
  async pin(requestId: string, seasonId: string): Promise<SourceAuthorityPin> {
    let response: Response | undefined;
    try {
      journalAssert(typeof requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(requestId) &&
        typeof seasonId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(seasonId), "SOURCE_SERVER_COMMAND_INVALID");
      const credentials = sourceObject(await this.credentials() as unknown as SourceJson);
      journalAssert(Object.keys(credentials).length === 2 && Object.keys(credentials).every(key =>
        ["transport_key", "session_token"].includes(key)), "SOURCE_SERVER_CREDENTIALS_UNAVAILABLE");
      const key = sourceText(credentials.transport_key, 1, 16_000), token = sourceText(credentials.session_token, 1, 16_000);
      journalAssert(!/[\r\n]/u.test(key) && !/[\r\n]/u.test(token), "SOURCE_SERVER_CREDENTIALS_UNAVAILABLE");
      const url = `${this.config.origin}/internal/c2/pin-source-authority`;
      response = await this.fetchPort(url, { method: "POST", redirect: "error", cache: "no-store", headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      }, body: JSON.stringify({ request_id: requestId, session_token: token, season_id: seasonId }), signal: AbortSignal.timeout(30_000) });
      journalAssert(response.status === 200 && !response.redirected && (!response.url || response.url === url) &&
        /^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? ""), "SOURCE_SERVER_RESPONSE_INVALID");
      const declared = response.headers.get("content-length");
      journalAssert(declared === null || /^\d+$/u.test(declared) && Number(declared) <= LIMIT, "SOURCE_SERVER_RESPONSE_INVALID");
      journalAssert(response.body, "SOURCE_SERVER_RESPONSE_INVALID");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; journalAssert(size <= LIMIT, "SOURCE_SERVER_RESPONSE_INVALID"); chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope = sourceObject(parseGeneratedSourceJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
      journalAssert(Object.keys(envelope).length === 3 && envelope.ok === true &&
        Object.keys(envelope).every(field => ["ok", "data", "meta"].includes(field)), "SOURCE_SERVER_RESPONSE_INVALID");
      const meta = sourceObject(envelope.meta), data = sourceObject(envelope.data);
      journalAssert(Object.keys(data).length === 1 && Object.hasOwn(data, "pin") &&
        meta.contract_version === C2_CONTRACT_VERSION && meta.request_id === requestId && meta.environment === "staging" &&
        meta.backend_instance === this.config.backend_instance && meta.backend_generation === this.config.backend_generation &&
        meta.writer_epoch === this.config.writer_epoch, "SOURCE_SERVER_IDENTITY_CHANGED");
      const pin = readSourceAuthorityPin(data.pin), { authority_digest, ...core } = pin;
      journalAssert(pin.source.team_id === this.config.team_id && pin.source.season_id === seasonId &&
        pin.source.backend_generation === this.config.backend_generation && pin.source.writer_epoch === this.config.writer_epoch &&
        await this.hash("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) === authority_digest, "SOURCE_SERVER_IDENTITY_CHANGED");
      return pin;
    } catch {
      try { await response?.body?.cancel(); } catch { /* Cleanup cannot expose transport exceptions. */ }
      throw fail();
    }
  }
}
