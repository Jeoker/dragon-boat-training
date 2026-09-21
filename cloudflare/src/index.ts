import { constantTimeEqual } from "./crypto";
import { callGoogleBridgeProbe, type C0BridgeProbeScenario } from "./bridge";
import { ApiError, apiFailure, apiSuccess, readJsonObject, requireRequestId, requireString } from "./http";
export { TeamState } from "./team-state";

function requireC0Access(request: Request, env: Env): void {
  if (env.ENVIRONMENT === "production") {
    throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
  }
  const configured = env.C0_TEST_KEY ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!configured || !supplied || !constantTimeEqual(configured, supplied)) {
    throw new ApiError("C0_ACCESS_DENIED", "C0 test access was denied.", 403);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    let requestId: string | null = null;
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        if (url.searchParams.has("request_id")) requestId = requireRequestId({ request_id: url.searchParams.get("request_id") });
        return apiSuccess({ status: "available" }, env, requestId);
      }
      if (url.pathname.startsWith("/internal/c0/")) {
        requireC0Access(request, env);
        if (request.method === "POST" && url.pathname === "/internal/c0/bridge-probe") {
          const input = await readJsonObject(request);
          requestId = requireRequestId(input);
          const challenge = requireString(input, "challenge", 1, 256);
          const scenario = input.scenario === undefined ? "valid" : requireString(input, "scenario", 1, 40);
          const allowedScenarios = new Set<C0BridgeProbeScenario>([
            "valid",
            "expired",
            "tampered_payload",
            "wrong_team",
            "wrong_binding",
            "wrong_epoch"
          ]);
          if (!allowedScenarios.has(scenario as C0BridgeProbeScenario)) {
            throw new ApiError("INVALID_REQUEST", "The C0 bridge scenario is invalid.");
          }
          return apiSuccess(await callGoogleBridgeProbe(
            env,
            requestId,
            challenge,
            scenario as C0BridgeProbeScenario
          ), env, requestId);
        }
        if (url.pathname === "/internal/c0/commit" || url.pathname === "/internal/c0/state") {
          return await env.TEAM_STATE.getByName(env.TEAM_ID).fetch(request);
        }
      }
      throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    } catch (error) {
      return apiFailure(error, env, requestId);
    }
  }
} satisfies ExportedHandler<Env>;
