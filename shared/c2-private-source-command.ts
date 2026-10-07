import { sourceAuthorityText } from "./c2-source-authority-contract";
import { parseSourceJson, sourceObject, sourceText, sourceBytes, type SourceJson } from "./c2-source-capture-contract";

export type PrivateSourceAction = "pin" | "register" | "capture" | "capture-native" | "stage" | "resume" | "review-view" | "review-append" | "backup";
export interface PrivateSourceCommand {
  action: PrivateSourceAction; request_id: string; season_id: string; session_token: string;
  target?: SourceJson; command_text?: string; confirm_private_journal?: true;
  confirm_private_backup?: true;
}
/** Only operation identifiers and an ephemeral current session enter this port.
 * Authority, actor, storage keys and source content cannot be supplied. */
export function readPrivateSourceCommand(value: unknown): PrivateSourceCommand {
  try {
    const text = sourceAuthorityText(value);
    if (sourceBytes(text) > 120_000) throw Error();
    const row = sourceObject(parseSourceJson(text)), action = row.action;
    if (!["pin", "register", "capture", "capture-native", "stage", "resume", "review-view", "review-append", "backup"].includes(action as string)) throw Error();
    const extra = action === "register" ? ["target"] : action === "stage" ? ["confirm_private_journal"] :
      action === "review-append" ? ["command_text"] : action === "backup" ? ["confirm_private_backup"] : [];
    const keys = ["action", "request_id", "season_id", "session_token", ...extra];
    if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw Error();
    const request_id = sourceText(row.request_id, 8, 128), season_id = sourceText(row.season_id, 8, 128);
    if (!/^[A-Za-z0-9_-]+$/u.test(request_id) || !/^[A-Za-z0-9_-]+$/u.test(season_id)) throw Error();
    const command: PrivateSourceCommand = { action: action as PrivateSourceAction, request_id, season_id,
      session_token: sourceText(row.session_token, 1, 16_000) };
    if (action === "register") command.target = sourceObject(row.target);
    if (action === "stage") { if (row.confirm_private_journal !== true) throw Error(); command.confirm_private_journal = true; }
    if (action === "review-append") command.command_text = sourceText(row.command_text, 1, 100_000);
    if (action === "backup") { if (row.confirm_private_backup !== true) throw Error(); command.confirm_private_backup = true; }
    return command;
  } catch { throw new Error("SOURCE_PRIVATE_RUNTIME_UNCONFIRMED"); }
}
export interface SourceAuthorityRpc {
  nativeTabProof?(command: { request_id: string; season_id: string; session_token: string }):
    Promise<{ ok: true; data: { proof: unknown; source_status: string; annual_export_authorized: false } } | { ok: false }>;
  pin(command: { request_id: string; season_id: string; session_token: string }):
    Promise<{ ok: true; pin: unknown } | { ok: false }>;
}
export type PrivateSourceResult = { ok: true; data: unknown } | { ok: false; code: "SOURCE_PRIVATE_RUNTIME_UNCONFIRMED" };
export interface PrivateSourceRuntimeRpc { run(command: unknown): Promise<PrivateSourceResult>; }
