import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

test("every production action and HTTP method matches the executable route registry", async () => {
  const { context } = await createBackend({ setup: false });
  const contract = JSON.parse(await readFile(new URL("../contracts/api-v1.json", import.meta.url), "utf8"));
  const routes = context.dragonBoatRoutes_();
  assert.deepEqual(Object.keys(routes).filter(name => name !== "cloudflareBridgeProbe").sort(), Object.keys(contract.actions).sort());
  for (const [name, definition] of Object.entries(contract.actions)) {
    assert.deepEqual([...routes[name].methods], definition.methods, name);
  }
  const unknown = post(context, { action: "toString", request_id: "unknown_action_01" });
  assert.equal(unknown.error.code, "UNSUPPORTED_ACTION");
  const wrongMethod = post(context, { action: "members", request_id: "wrong_method_01" });
  assert.equal(wrongMethod.error.code, "METHOD_NOT_ALLOWED");
});

test("POST never creates a request ID for an unidentifiable retry", async () => {
  const { context, spreadsheet } = await createBackend();
  for (const request_id of [undefined, null, "", "  ", 12345678]) {
    const result = post(context, { action: "coachLogin", coach_code: "coach-code-123", request_id });
    assert.equal(result.error.code, "INVALID_REQUEST_ID");
  }
  assert.equal(sheetRecords(spreadsheet, "CoachSessions").length, 0);
  assert.equal(sheetRecords(spreadsheet, "SystemRequests").length, 0);
});

test("version and flag inputs reject coercion while retaining legacy numeric strings and roster hints", async () => {
  const { context } = await createBackend({ setup: false });
  for (const value of [null, "", "  ", false, true, [], [0], {}, -1, 0.2, "1e0", Number.MAX_SAFE_INTEGER + 1]) {
    const result = post(context, { action: "health", request_id: "bad_version_01", signup_version: value });
    assert.equal(result.error.code, "INVALID_REQUEST", JSON.stringify(value));
  }
  for (const value of [0, "0", 4, "4"]) assert.doesNotThrow(() => context.requireVersion_(Number(value), value, "test"));
  for (const value of [undefined, null, false, ""]) assert.throws(() => context.requireVersion_(0, value, "test"), e => e.code === "INVALID_REQUEST");
  assert.throws(() => context.requireVersion_(1, 0, "test"), e => e.code === "VERSION_CONFLICT");
  assert.equal(post(context, { action: "health", request_id: "roster_unknown_01", known_roster_version: -1 }).ok, true);
  assert.equal(post(context, { action: "health", request_id: "bad_boolean_01", include_current_view: "false" }).error.code, "INVALID_REQUEST");
  assert.equal(payload(context.doGet({ parameter: { action: "bootstrap", season_id: 42 } })).error.code, "INVALID_REQUEST");
});

test("pagination rejects malformed values and caps valid larger page sizes", async () => {
  const { context } = await createBackend({ setup: false });
  for (const limit of [null, false, [], {}, "x", 0, -1, 1.5, "1.5"]) {
    assert.throws(() => context.historyPageOptions_({ limit }, 30, 100), e => e.code === "INVALID_REQUEST");
  }
  for (const cursor of [null, false, [], {}, "x", -1, 1.5, "1e2"]) {
    assert.throws(() => context.historyPageOptions_({ cursor }, 30, 100), e => e.code === "INVALID_REQUEST");
  }
  assert.equal(context.historyPageOptions_({ limit: 200, cursor: "30" }, 30, 100).limit, 100);
  assert.equal(context.historyPageOptions_({ cursor: "" }, 30, 100).offset, 0);
});

test("a logged-out login request cannot return an apparently active session", async () => {
  const { context, spreadsheet } = await createBackend();
  const input = { action: "coachLogin", request_id: "login_replay_001", coach_code: "coach-code-123" };
  const login = post(context, input);
  assert.equal(login.ok, true);
  assert.equal(post(context, { action: "coachLogout", request_id: "logout_replay_01", session_token: login.data.session_token }).ok, true);
  assert.equal(post(context, input).error.code, "SESSION_REVOKED");
  assert.equal(sheetRecords(spreadsheet, "CoachSessions").length, 1);
  assert.equal(post(context, { ...input, request_id: "new_login_001" }).ok, true);
});
