import { constantTimeEqual } from "./crypto";
import { callGoogleBridgeProbe, type C0BridgeProbeScenario } from "./bridge";
import { ApiError, apiFailure, jsonResponse, readJsonObject, requireRequestId, requireString } from "./http";
export { TeamState } from "./team-state";

function meta(env: Env, requestId: string | null = null): Record<string, unknown> {
  return {
    contract_version: env.CONTRACT_VERSION,
    service_version: env.SERVICE_VERSION,
    backend_instance: env.BACKEND_INSTANCE,
    backend_generation: env.BACKEND_GENERATION,
    writer_epoch: Number(env.WRITER_EPOCH),
    environment: env.ENVIRONMENT,
    server_time: new Date().toISOString(),
    request_id: requestId
  };
}

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
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return jsonResponse({ ok: true, data: { status: "available" }, meta: meta(env) });
      }
      if (url.pathname.startsWith("/internal/c0/")) {
        requireC0Access(request, env);
        if (request.method === "POST" && url.pathname === "/internal/c0/bridge-probe") {
          const input = await readJsonObject(request);
          const requestId = requireRequestId(input);
          const challenge = requireString(input, "challenge", 1, 256);
          const scenario =
            typeof input.scenario === "string" && input.scenario.trim()
              ? input.scenario.trim()
              : "valid";
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
          return jsonResponse({
            ok: true,
            data: await callGoogleBridgeProbe(
              env,
              requestId,
              challenge,
              scenario as C0BridgeProbeScenario
            ),
            meta: meta(env, requestId)
          });
        }
        return env.TEAM_STATE.getByName(env.TEAM_ID).fetch(request);
      }
      throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    } catch (error) {
      return apiFailure(error);
    }
  }
} satisfies ExportedHandler<Env>;
