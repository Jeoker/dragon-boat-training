interface Env {
  C0_TEST_KEY?: string;
  C1_TEST_KEY?: string;
  C2_TEST_KEY?: string;
  COACH_CODE_SECRET?: string;
  SESSION_SECRET?: string;
  COACH_SESSION_TTL_SECONDS?: string;
  GOOGLE_BRIDGE_URL?: string;
  GOOGLE_BRIDGE_SECRET?: string;
  C2_MEMBER_EXPORT_ENABLED?: string;
  C2_SCHEDULE_EXPORT_ENABLED?: string;
  C2_ASSOCIATED_EXPORT_ENABLED?: string;
  C2_EXPORT_POLL_ENABLED?: string;
  PRIVATE_SOURCE_RUNTIME?: import("../../shared/c2-private-source-command").PrivateSourceRuntimeRpc;
  ISOLATED_RECOVERY_RUNTIME?: { restore(command: unknown): Promise<{ ok: boolean; data?: unknown; code?: string }> };
}
