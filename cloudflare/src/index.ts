import { constantTimeEqual } from "./crypto";
import { callGoogleBridgeProbe, type C0BridgeProbeScenario } from "./bridge";
import { ApiError, apiFailure, apiSuccess, readJsonObject, requireRequestId, requireString } from "./http";
import { C1_CONTRACT_VERSION } from "../../shared/c1-actions";
import { C2_CONTRACT_VERSION } from "../../shared/c2-actions";
import { FORM_NOTIFY_PATH, verifyFormNotification } from "./c2-form-notify";
export { TeamState } from "./team-state";

function requireInternalAccess(request: Request, env: Env, generation: "C0" | "C1" | "C2"): void {
  if (env.ENVIRONMENT === "production") {
    throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
  }
  const configured = generation === "C0" ? env.C0_TEST_KEY ?? "" :
    generation === "C1" ? env.C1_TEST_KEY ?? "" : env.C2_TEST_KEY ?? "";
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!configured || !supplied || !constantTimeEqual(configured, supplied)) {
    throw new ApiError(`${generation}_ACCESS_DENIED`, `${generation} test access was denied.`, 403);
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
        requireInternalAccess(request, env, "C0");
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
      if (url.pathname.startsWith("/internal/c1/")) {
        requireInternalAccess(request, env, "C1");
        return await env.TEAM_STATE.getByName(env.TEAM_ID).fetch(request);
      }
      if (url.pathname.startsWith("/internal/c2/")) {
        if (request.method === "POST" && url.pathname === FORM_NOTIFY_PATH) {
          const notification = await verifyFormNotification(await readJsonObject(request), env);
          requestId = notification.request_id;
          return await env.TEAM_STATE.getByName(env.TEAM_ID).fetch(new Request(request.url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(notification)
          }));
        }
        requireInternalAccess(request, env, "C2");
        return await env.TEAM_STATE.getByName(env.TEAM_ID).fetch(request);
      }
      throw new ApiError("NOT_FOUND", "The requested resource does not exist.", 404);
    } catch (error) {
      return apiFailure(error, env, requestId, url.pathname.startsWith("/internal/c2/") ? C2_CONTRACT_VERSION :
        url.pathname.startsWith("/internal/c1/") ? C1_CONTRACT_VERSION : env.CONTRACT_VERSION);
    }
  },
  async scheduled(controller, env): Promise<void> {
    if (env.ENVIRONMENT === "production" || String(env.C2_FORM_POLL_ENABLED) !== "true") return;
    const response = await env.TEAM_STATE.getByName(env.TEAM_ID).fetch(new Request(
      "https://internal.example/internal/c2/poll-active-forms", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: `c2_poll_${controller.scheduledTime}` })
      }));
    if (!response.ok) throw new Error("Scheduled Form polling did not complete.");
    const body = await response.json() as { data?: { results?: Array<{ status: string }> } };
    if (body.data?.results?.some((item) => item.status === "RETRY_REQUIRED")) {
      throw new Error("Scheduled Form polling has retryable failures.");
    }
  }
} satisfies ExportedHandler<Env>;
