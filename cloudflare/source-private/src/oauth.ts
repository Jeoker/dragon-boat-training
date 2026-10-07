export interface GoogleOAuthSecrets {
  SOURCE_GOOGLE_OAUTH_CLIENT_ID?: string;
  SOURCE_GOOGLE_OAUTH_CLIENT_SECRET?: string;
  SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN?: string;
}
const failure = () => new Error("SOURCE_GOOGLE_OAUTH_UNCONFIRMED");
/** Secrets are injected by the platform; refresh/access tokens never use DO SQL.
 * No retry after an unknown refresh result; only an in-memory access-token cache. */
export class GoogleRefreshTokenProvider {
  private cached: { token: string; until: number; credentials: readonly string[] } | null = null;
  private pending: Promise<string> | null = null;
  private pendingCredentials: readonly string[] | null = null;
  constructor(private readonly secrets: GoogleOAuthSecrets,
    private readonly fetchPort: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly clock: () => number = Date.now) {}
  async token(beforeRefresh?: () => Promise<void>): Promise<string> {
    try {
      const fields = this.credentials();
      const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) throw failure();
      if (this.cached && now < this.cached.until && this.same(fields, this.cached.credentials)) return this.cached.token;
      this.cached = null;
      if (this.pending) {
        if (!this.pendingCredentials || !this.same(fields, this.pendingCredentials)) throw failure();
        return await this.pending;
      }
      this.pendingCredentials = fields;
      this.pending = this.refresh(fields, beforeRefresh);
      try { return await this.pending; } finally { this.pending = null; this.pendingCredentials = null; }
    } catch { throw failure(); }
  }
  private same(a: readonly string[], b: readonly string[]) { return a.every((field, index) => field === b[index]); }
  private credentials(): string[] {
    const fields = [this.secrets.SOURCE_GOOGLE_OAUTH_CLIENT_ID, this.secrets.SOURCE_GOOGLE_OAUTH_CLIENT_SECRET,
      this.secrets.SOURCE_GOOGLE_OAUTH_REFRESH_TOKEN];
    if (fields.some(value => typeof value !== "string" || !value.length || value.length > 16_000 || /[\r\n]/u.test(value))) throw failure();
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(fields[0]!)) throw failure();
    return fields as string[];
  }
  private async refresh(fields: readonly string[], beforeRefresh?: () => Promise<void>) {
    let response: Response | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = "https://oauth2.googleapis.com/token";
      if (beforeRefresh) await beforeRefresh();
      const controller = new AbortController();
      deadline = setTimeout(() => controller.abort(), 30_000);
      response = await this.fetchPort(url, { method: "POST", redirect: "error", cache: "no-store",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: fields[0]!, client_secret: fields[1]!, refresh_token: fields[2]!, grant_type: "refresh_token" }).toString(),
        signal: controller.signal });
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url) ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") || !response.body) throw failure();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 32_000)) throw failure();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > 32_000) throw failure(); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Record<string, unknown>;
      if (!data || Array.isArray(data) || typeof data.access_token !== "string" || !data.access_token.length ||
        data.access_token.length > 16_000 || /[\r\n]/u.test(data.access_token) || data.token_type !== "Bearer" ||
        typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 30 || data.expires_in > 86_400) throw failure();
      const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) throw failure();
      if (!this.same(fields, this.credentials())) throw failure();
      this.cached = { token: data.access_token, until: now + (data.expires_in - 30) * 1000, credentials: fields };
      return data.access_token;
    } catch {
      this.cached = null;
      try { await response?.body?.cancel(); } catch { /* Do not forward Google error bodies. */ }
      throw failure();
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      try { await response?.body?.cancel(); } catch { /* Never expose transport cleanup errors. */ }
    }
  }
}
