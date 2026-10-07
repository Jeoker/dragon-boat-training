import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { currentSourcePin, type SourceRuntimeEnv } from "../source-private/src/runtime";
import { sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { restoreBusinessBackup } from "./c2-backup-recovery";
import { restorePrivateBackup } from "../source-private/src/backup";
import { boundedBackupText } from "./backup-json";
import { ApiError } from "./http";
import { rpcResultScope } from "./rpc-result";

export interface RecoveryEnv extends SourceRuntimeEnv {
  RECOVERY_STATE: DurableObjectNamespace<RecoveryState>;
  RECOVERY_TARGET_NAME?: string;
  RECOVERY_BUSINESS_DIGEST?: string;
  RECOVERY_PRIVATE_DIGEST?: string;
  RECOVERY_SOURCE_OBJECT_NAME?: string;
}
const failed = () => ({ ok: false as const, code: "RECOVERY_UNCONFIRMED" });
/** Separate class/namespace, never a TeamState or PrivateSourceState alias.
 * No fetch/alarm/business/source-run method exists. Restored facts stay sealed. */
export class RecoveryState extends DurableObject<RecoveryEnv> {
  async restore(value: unknown) {
    try {
      const encoded = boundedBackupText(value, 30_000_000);
      const command = JSON.parse(encoded) as Record<string, unknown>;
      if (Object.keys(command).sort().join() !== "bundle,kind,request_id,season_id,session_token,target_name" ||
          !["BUSINESS", "PRIVATE"].includes(String(command.kind)) ||
          !this.env.RECOVERY_TARGET_NAME || !/^recovery-quarantine-[a-z0-9_-]{8,100}$/u.test(this.env.RECOVERY_TARGET_NAME) ||
          command.target_name !== this.env.RECOVERY_TARGET_NAME || this.ctx.id.name !== this.env.RECOVERY_TARGET_NAME) throw Error();
      const auth = { action: "pin", request_id: command.request_id, season_id: command.season_id, session_token: command.session_token };
      const initial = await currentSourcePin(this.env, auth), initialText = sourceAuthorityText(initial);
      const authorize = async () => { if (sourceAuthorityText(await currentSourcePin(this.env, auth)) !== initialText) throw Error(); };
      const expected = command.kind === "BUSINESS" ? this.env.RECOVERY_BUSINESS_DIGEST : this.env.RECOVERY_PRIVATE_DIGEST;
      if (!expected) throw Error();
      if (command.kind === "PRIVATE") {
        const bundle = command.bundle as { manifest?: { object_name?: string } };
        const expectedObject = `c2-private-source-v1:${initial.source.team_id}:${initial.source.source_operation_id}`;
        if (!this.env.RECOVERY_SOURCE_OBJECT_NAME || this.env.RECOVERY_SOURCE_OBJECT_NAME !== expectedObject ||
            bundle?.manifest?.object_name !== expectedObject) throw Error();
      }
      const data = command.kind === "BUSINESS" ? await restoreBusinessBackup(this.ctx.storage, command.bundle, expected, authorize) :
        await restorePrivateBackup(this.ctx.storage, command.bundle, expected, authorize);
      return { ok: true as const, data };
    } catch { return failed(); }
  }
}
export class RecoveryRuntime extends WorkerEntrypoint<RecoveryEnv> {
  async restore(command: unknown) {
    try {
      if (!this.env.RECOVERY_TARGET_NAME) return failed();
      using reply = await this.env.RECOVERY_STATE.getByName(this.env.RECOVERY_TARGET_NAME).restore(command);
      return JSON.parse(JSON.stringify(reply)) as { ok: boolean; data?: unknown; code?: string };
    } catch { return failed(); }
  }
}

export async function runIsolatedRecovery(request: Request, env: Env) {
  try {
    if (env.ENVIRONMENT !== "staging" || !env.ISOLATED_RECOVERY_RUNTIME || !request.body) throw Error();
    const reader = request.body.getReader(), parts: Uint8Array[] = []; let count = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      count += next.value.byteLength; if (count > 30_000_000) throw Error(); parts.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const command = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Record<string, unknown>;
    boundedBackupText(command, 30_000_000);
    using reply = rpcResultScope(await env.ISOLATED_RECOVERY_RUNTIME.restore(command));
    if (!reply.value?.ok) throw Error();
    return { requestId: String(command.request_id), result: JSON.parse(JSON.stringify(reply.value.data)) as unknown };
  } catch { throw new ApiError("RECOVERY_UNCONFIRMED", "Isolated recovery could not be confirmed.", 409); }
}
