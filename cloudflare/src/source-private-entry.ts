import { WorkerEntrypoint } from "cloudflare:workers";
import { C2_CONTRACT_VERSION } from "../../shared/c2-actions";
import { readPrivateSourceCommand, type SourceAuthorityRpc } from "../../shared/c2-private-source-command";
import { readSourceAuthorityPin, sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { sha256Base64Url } from "./crypto";
import { ApiError } from "./http";
import { parseSourceJson } from "../../shared/c2-source-capture-contract";
import { rpcResultScope } from "./rpc-result";
import { readNativeTabProof } from "./c2-native-tab-proof";

/** Internal callback, not a route. TeamState authenticates the current Coach
 * every time, including saved-pin replay, against current season ownership. */
export class SourceAuthority extends WorkerEntrypoint<Env> implements SourceAuthorityRpc {
  async nativeTabProof(command: { request_id: string; season_id: string; session_token: string }) {
    try {
      const before = await this.pin(command); if (!before.ok) throw Error();
      const pin = readSourceAuthorityPin(before.pin), proof = await readNativeTabProof(this.env, pin, command.request_id);
      const after = await this.pin(command);
      if (!after.ok || sourceAuthorityText(after.pin) !== sourceAuthorityText(pin)) throw Error();
      return { ok: true as const, data: { proof, source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false as const } };
    } catch { return { ok: false as const }; }
  }
  async pin(command: { request_id: string; season_id: string; session_token: string }): ReturnType<SourceAuthorityRpc["pin"]> {
    try {
      if (this.env.ENVIRONMENT !== "staging") return { ok: false };
      if (Object.keys(command).length !== 3 || Object.keys(command).some(key =>
        !["request_id", "season_id", "session_token"].includes(key))) return { ok: false };
      const input = readPrivateSourceCommand({ ...command, action: "pin" });
      const response = await this.env.TEAM_STATE.getByName(this.env.TEAM_ID).fetch(new Request(
        "https://internal.example/internal/c2/pin-source-authority", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ request_id: input.request_id, season_id: input.season_id, session_token: input.session_token }) }));
      if (response.status !== 200) { await response.body?.cancel(); return { ok: false }; }
      const result = await response.json() as { ok?: unknown; data?: { pin?: unknown }; meta?: Record<string, unknown> };
      const meta = result.meta;
      if (result.ok !== true || !meta || meta.contract_version !== C2_CONTRACT_VERSION || meta.request_id !== input.request_id ||
        meta.backend_instance !== this.env.BACKEND_INSTANCE || meta.backend_generation !== this.env.BACKEND_GENERATION ||
        meta.writer_epoch !== Number(this.env.WRITER_EPOCH) || meta.environment !== "staging") return { ok: false };
      const pin = readSourceAuthorityPin(result.data?.pin), { authority_digest, ...core } = pin;
      if (pin.source.team_id !== this.env.TEAM_ID || pin.source.season_id !== input.season_id ||
        pin.source.backend_generation !== this.env.BACKEND_GENERATION || pin.source.writer_epoch !== Number(this.env.WRITER_EPOCH) ||
        await sha256Base64Url("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) !== authority_digest) return { ok: false };
      return { ok: true, pin };
    } catch { return { ok: false }; }
  }
}

export async function runNativeSourceTabProof(request: Request, env: Env) {
  try {
    if (env.ENVIRONMENT !== "staging") throw Error();
    if (!request.body) throw Error();
    const reader = request.body.getReader(), parts: Uint8Array[] = []; let count = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      count += next.value.byteLength; if (count > 20_000) throw Error(); parts.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const input = parseSourceJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Record<string, unknown>;
    const result = await new SourceAuthority({} as ExecutionContext, env).nativeTabProof(input as { request_id: string; season_id: string; session_token: string });
    if (!result.ok) throw Error(); return { requestId: String(input.request_id), result: result.data };
  } catch { throw new ApiError("NATIVE_TAB_PROOF_UNCONFIRMED", "Native response tab proof could not be confirmed.", 409); }
}

/** Small fixed route body bound; source/actor/census/keys are never accepted. */
export async function runPrivateSource(request: Request, env: Env) {
  try {
    if (env.ENVIRONMENT !== "staging" || !env.PRIVATE_SOURCE_RUNTIME || !request.body) throw Error();
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      count += next.value.byteLength; if (count > 120_000) throw Error(); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const command = readPrivateSourceCommand(parseSourceJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
    using reply = rpcResultScope(await env.PRIVATE_SOURCE_RUNTIME.run(command));
    const result = reply.value;
    if (!result.ok) throw Error();
    return { result: JSON.parse(JSON.stringify(result.data)) as unknown, requestId: command.request_id };
  } catch { throw new ApiError("SOURCE_PRIVATE_RUNTIME_UNCONFIRMED", "Private source operation could not be confirmed.", 409); }
}
