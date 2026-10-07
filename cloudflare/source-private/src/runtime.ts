import { readSourceAuthorityPin, sourceAuthorityText, type SourceAuthorityPin } from "../../../shared/c2-source-authority-contract";
import { readPrivateSourceCommand, type SourceAuthorityRpc, type PrivateSourceResult } from "../../../shared/c2-private-source-command";
import { PrivateSourceTargetRegistry } from "../../../backend/source-journal/target-registry";
import { createPrivateSourceRuntime } from "../../../backend/source-journal/private-runtime";
import { PrivateSourceReview } from "../../../backend/source-journal/private-review";
import { sha256Base64Url } from "../../src/crypto";
import { GoogleRefreshTokenProvider, type GoogleOAuthSecrets } from "./oauth";
import { rpcResultScope } from "../../src/rpc-result";

export interface SourceRuntimeEnv extends GoogleOAuthSecrets {
  BUSINESS_SOURCE_AUTHORITY?: SourceAuthorityRpc;
  SOURCE_TEAM_ID?: string; SOURCE_BACKEND_GENERATION?: string; SOURCE_WRITER_EPOCH?: string;
}
export interface RuntimeStore {
  read(key: string): Promise<unknown | null>;
  compareAndSet(key: string, revision: number | null, value: unknown): Promise<boolean>;
  backup?(): Promise<unknown>;
}
export const sourceRuntimeFailure = (): PrivateSourceResult => ({ ok: false, code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" });
export const sourceObjectName = (pin: SourceAuthorityPin) =>
  `c2-private-source-v1:${pin.source.team_id}:${pin.source.source_operation_id}`;

/** The binding returns authenticated current server authority, not a client pin.
 * Environment identity is mandatory; no dynamic destination is accepted. */
export async function currentSourcePin(env: SourceRuntimeEnv, command: unknown) {
  const input = readPrivateSourceCommand(command);
  using reply = rpcResultScope(await env.BUSINESS_SOURCE_AUTHORITY?.pin({ request_id: input.request_id,
    season_id: input.season_id, session_token: input.session_token }));
  const result = reply.value;
  if (!result?.ok) throw Error();
  const pin = readSourceAuthorityPin(result.pin), { authority_digest, ...core } = pin;
  if (!env.SOURCE_TEAM_ID || !env.SOURCE_BACKEND_GENERATION || env.SOURCE_WRITER_EPOCH === undefined ||
    !/^(?:0|[1-9]\d*)$/u.test(env.SOURCE_WRITER_EPOCH) || pin.source.team_id !== env.SOURCE_TEAM_ID ||
    pin.source.backend_generation !== env.SOURCE_BACKEND_GENERATION || pin.source.writer_epoch !== Number(env.SOURCE_WRITER_EPOCH) ||
    pin.source.season_id !== input.season_id ||
    await sha256Base64Url("c2-source-authority-pin-v1\n" + sourceAuthorityText(core)) !== authority_digest) throw Error();
  return pin;
}

/** Called inside the private DO. Tokens/sessions are request-lifetime values.
 * Per-call source budget yields before a STARTED marker, so capture can continue
 * confirmed checkpoints. A begun request with no durable reply never re-fetches. */
export async function executePrivateSourceCommand(env: SourceRuntimeEnv, store: RuntimeStore, command: unknown,
  objectName: string, oauth: GoogleRefreshTokenProvider = new GoogleRefreshTokenProvider(env),
  fetchGoogle: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<PrivateSourceResult> {
  try {
    const input = readPrivateSourceCommand(command), initial = await currentSourcePin(env, input);
    if (objectName !== sourceObjectName(initial)) throw Error();
    const initialText = sourceAuthorityText(initial);
    const authorize = async () => {
      const current = await currentSourcePin(env, input);
      if (sourceAuthorityText(current) !== initialText) throw Error();
      return current;
    };
    const guardedStore: RuntimeStore = {
      async read(key) { await authorize(); const value = await store.read(key); await authorize(); return value; },
      async compareAndSet(key, revision, value) {
        await authorize(); const won = await store.compareAndSet(key, revision, value); await authorize(); return won;
      },
    };
    if (input.action === "pin") { await authorize(); return { ok: true, data: { pin: initial } }; }
    if (input.action === "backup") {
      if (!store.backup) throw Error(); await authorize();
      const data = await store.backup(); await authorize(); return { ok: true, data };
    }
    const registry = new PrivateSourceTargetRegistry(initial.source.team_id, guardedStore, sha256Base64Url);
    if (input.action === "register") {
      await registry.register(initial, input.target); await authorize();
      return { ok: true, data: { state: "PRIVATE_TARGET_REGISTERED", source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false } };
    }
    let sourceRequests = 0, externalRequests = 0;
    const reserveExternalRequest = async (count = 1) => {
      if (externalRequests + count > 40) throw Error(); externalRequests += count;
    };
    const operation = await createPrivateSourceRuntime({ authorize, registeredTarget: id => registry.get(id),
      store: guardedStore, hash: sha256Base64Url,
      reuseJournalReadbackWithinInvocation: input.action === "review-view" || input.action === "review-append",
      oauthToken: async () => { await authorize(); const token = await oauth.token(reserveExternalRequest); await authorize(); return token; },
      beforeSourceRequest: async url => {
        await authorize(); if (sourceRequests >= 32) throw Error();
        // Native bridge has at most one controlled ContentService redirect.
        // Reserve both network calls BEFORE saving its STARTED marker.
        if (url.startsWith("https://native-tab-proof.internal/")) await reserveExternalRequest(2);
        sourceRequests++;
      },
      ...(input.action === "capture-native" ? { nativeTabProof: async () => {
        await authorize();
        using reply = rpcResultScope(await env.BUSINESS_SOURCE_AUTHORITY?.nativeTabProof?.({ request_id: input.request_id,
          season_id: input.season_id, session_token: input.session_token }));
        const result = reply.value;
        if (!result?.ok || result.data.source_status !== "SOURCE_NOT_VERIFIED" || result.data.annual_export_authorized !== false) throw Error();
        await authorize(); return result.data.proof;
      } } : {}),
      fetchGoogle: async (url, init) => {
        // Leaves headroom for OAuth refresh; no automatic quota retry. All journal
        // dependency reads/writes also stop before the next network request.
        await reserveExternalRequest();
        return fetchGoogle(url, init);
      },
    });
    const review = () => new PrivateSourceReview(operation, guardedStore, sha256Base64Url);
    const data = input.action === "capture" || input.action === "capture-native" ? await operation.capture() : input.action === "stage" ? await operation.stage() :
      input.action === "resume" ? await operation.resume() : input.action === "review-view" ? await review().view() :
        await review().append(input.command_text);
    await authorize(); return { ok: true, data };
  } catch { return sourceRuntimeFailure(); }
}
