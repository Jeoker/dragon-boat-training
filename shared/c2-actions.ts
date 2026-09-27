export const C2_CONTRACT_VERSION = "2026-09-27.c2.4-season";

export const C2_SYNC_ACTIONS = {
  "/internal/c2/import-sync-foundation": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c2/get-sync-overview": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c2/list-form-reviews": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c2/check-sheet-differences": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c2/export-next-member": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c2/pull-form-responses": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c2/form-submit-notification": { method: "POST", authentication: "signed_notification", writes: true },
  "/internal/c2/poll-active-forms": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c2/resolve-form-source": { method: "POST", authentication: "session_token", writes: true }
} as const;

export const C2_ACTIONS = { ...C2_SYNC_ACTIONS } as const;
