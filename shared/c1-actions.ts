export const C1_CONTRACT_VERSION = "2026-09-20.c1";

export const C1_CORE_ACTIONS = {
  "/internal/c1/import-core": { method: "POST", authentication: "transport_only", writes: true },
  "/internal/c1/coach-login": { method: "POST", authentication: "coach_code", writes: true },
  "/internal/c1/coach-logout": { method: "POST", authentication: "session_token", writes: true },
  "/internal/c1/coach-bootstrap": { method: "POST", authentication: "session_token", writes: false },
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

export const C1_ACTIONS = { ...C1_CORE_ACTIONS, ...C1_SCHEDULE_ACTIONS } as const;
