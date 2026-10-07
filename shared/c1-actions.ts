export const C1_CONTRACT_VERSION = "2026-09-21.c1.5";

export const C1_CORE_ACTIONS = {
  "/internal/c1/import-core": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/coach-login": { method: "POST", authentication: "coach_code", writes: true },
  "/internal/c1/coach-logout": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/coach-bootstrap": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/prepare-coach-code-rotation": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/rotate-coach-code": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/get-coach-rotation-receipt": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/create-season": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/update-member": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/public-roster": { method: "GET", authentication: "public", writes: false }
} as const;

export const C1_SCHEDULE_ACTIONS = {
  "/internal/c1/import-schedule": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/schedule-workspace": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/update-schedule-templates": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/prepare-training-week": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/confirm-training-week": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/publish-training-week": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/create-practice": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/publish-additional-practice": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/preview-practice-change": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/update-practice": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/cancel-practice": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/public-schedule": { method: "GET", authentication: "public", writes: false }
} as const;

export const C1_SIGNUP_ACTIONS = {
  "/internal/c1/import-signups": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/public-practice": { method: "GET", authentication: "public", writes: false },
  "/internal/c1/signup": { method: "POST", authentication: "public", writes: true },
  "/internal/c1/update-signup": { method: "POST", authentication: "public", writes: true },
  "/internal/c1/cancel-signup": { method: "POST", authentication: "public", writes: true },
  "/internal/c1/signup-by-coach": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/update-signup-by-coach": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/cancel-signup-by-coach": { method: "POST", authentication: "session_token", writes: true }
} as const;

export const C1_SEATING_ACTIONS = {
  "/internal/c1/import-seating": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/get-seating-workspace": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/save-seat-plan-draft": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/publish-seat-plan": { method: "POST", authentication: "session_token", writes: true }
} as const;

export const C1_HISTORY_ACTIONS = {
  "/internal/c1/import-history": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/public-history-seasons": { method: "GET", authentication: "public", writes: false },
  "/internal/c1/public-season-history": { method: "GET", authentication: "public", writes: false },
  "/internal/c1/public-archived-practice": { method: "GET", authentication: "public", writes: false },
  "/internal/c1/get-history-management": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/append-history-correction": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/list-management-audit": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/create-backup-snapshot": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/get-backup-chunk": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/verify-backup-snapshot": { method: "POST", authentication: "session_token", writes: false },
  "/internal/c1/get-operations": { method: "POST", authentication: "session_token", writes: false }
} as const;

export const C1_ACTIONS = {
  ...C1_CORE_ACTIONS, ...C1_SCHEDULE_ACTIONS, ...C1_SIGNUP_ACTIONS, ...C1_SEATING_ACTIONS,
  ...C1_HISTORY_ACTIONS
} as const;
