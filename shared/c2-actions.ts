export const C2_CONTRACT_VERSION = "2026-09-21.c2.1";

export const C2_SYNC_ACTIONS = {
  "/internal/c2/import-sync-foundation": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c2/get-sync-overview": { method: "POST", authentication: "session_token", writes: false }
} as const;

export const C2_ACTIONS = { ...C2_SYNC_ACTIONS } as const;
