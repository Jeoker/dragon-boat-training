// Creates an ignored, short-lived Apps Script overlay from the exact isolated v12 source.
// This file does not deploy anything and must never be used with a production script ID.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

assert.ok(process.argv.includes("--build-isolated-overlay"));
const privateRoot = new URL("../.c2-form-test/", import.meta.url);
const state = JSON.parse(readFileSync(new URL("schedule-fault-state.json", privateRoot), "utf8"));
assert.equal(state.season_id, "season_c2_isolated_2026");
assert.match(state.practice_id, /^practice_[A-Za-z0-9_-]+$/);
assert.match(state.partial_request_id, /^c2_schedule_fault_20260930_partial$/);
assert.match(state.reply_request_id, /^c2_schedule_fault_20260930_lost_reply$/);
assert.match(state.partial_batch_id, /^batch_[A-Za-z0-9_-]+$/);
assert.match(state.reply_batch_id, /^batch_[A-Za-z0-9_-]+$/);

const clean = readFileSync(new URL("draft-snapshot/source/Code.js", privateRoot), "utf8");
const pulledV12 = readFileSync(new URL("source/Code.js", privateRoot), "utf8");
assert.equal(clean, pulledV12, "The isolated draft and deployed v12 must match exactly.");
const cleanHash = createHash("sha256").update(clean).digest("hex").toUpperCase();
assert.equal(cleanHash, "E7FC11FF8C5CCC6C2F0BCD15A2FB5B0684D70C9C954074ABC709D2B1574B3686");
const identity = JSON.parse(readFileSync(new URL("isolated-identities.json", privateRoot), "utf8"));
assert.match(identity.script_id, /^[A-Za-z0-9_-]{30,}$/);
assert.match(identity.deployment_id, /^[A-Za-z0-9_-]{30,}$/);
assert.equal(identity.clean_v12_sha256, cleanHash);
const clasp = JSON.parse(readFileSync(new URL(".clasp.json", privateRoot), "utf8"));
assert.equal(clasp.scriptId, identity.script_id);
assert.equal(clasp.rootDir, "source");
const secrets = JSON.parse(readFileSync(new URL("worker-secrets.json", privateRoot), "utf8"));
assert.equal(new URL(secrets.GOOGLE_BRIDGE_URL).hostname, "script.google.com");
assert.ok(new URL(secrets.GOOGLE_BRIDGE_URL).pathname.includes(identity.deployment_id));

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, "Expected one exact source insertion point.");
  return source.replace(before, after);
}
const quote = JSON.stringify;
const partialGuard = `scope === "PRACTICE" && verified.team_id === "pentasus-c2-test" &&\n` +
  `                seasonId === ${quote(state.season_id)} && batchId === ${quote(state.partial_batch_id)} &&\n` +
  `                id === ${quote(state.practice_id)} && request.request_id === ${quote(state.partial_request_id)}`;
const firstCell = `            tab.getRange(rowNumber, index + 1, 1, 1).setNumberFormat("@").setValues([[item.target[index]]]);\n`;
let overlay = replaceOnce(clean.replaceAll("\r\n", "\n"), firstCell, firstCell +
  `            if (headers[index] === "location" && ${partialGuard}) {\n` +
  `              SpreadsheetApp.flush();\n` +
  `              throw dragonBoatRequestError_("TEST_INJECTED_PARTIAL", "Isolated schedule partial write.", true);\n` +
  `            }\n`);
const handler = `    return dragonBoatSuccess_(route.handle(request), requestId);\n`;
overlay = replaceOnce(overlay, handler,
  `    var result = route.handle(request);\n` +
  `    if (request.action === "cloudflarePatchSeasonSheet" &&\n` +
  `        request.request_id === ${quote(state.reply_request_id)} &&\n` +
  `        result && result.status === "verified" &&\n` +
  `        result.team_id === "pentasus-c2-test" &&\n` +
  `        result.season_id === ${quote(state.season_id)} &&\n` +
  `        result.operation_id === ${quote(state.reply_batch_id)}) {\n` +
  `      return ContentService.createTextOutput("");\n` +
  `    }\n` +
  `    return dragonBoatSuccess_(result, requestId);\n`);
const routeAnchor = `  add("getSeasonManagement", "POST", function (r) { return withDragonBoatScriptLock_(function () { return getSeasonManagement_(r); }); });\n`;
overlay = replaceOnce(overlay, routeAnchor,
  `  add("c2TestReadFaultReceipt", "POST", function (r) { return c2TestReadFaultReceipt_(r); });\n` + routeAnchor);
overlay += `\nfunction c2TestReadFaultReceipt_(request) {\n` +
  `  var verified = verifyBridgeEnvelope_(request, null);\n` +
  `  var input = verified.payload;\n` +
  `  if (verified.team_id !== "pentasus-c2-test" ||\n` +
  `      input.season_id !== ${quote(state.season_id)} ||\n` +
  `      verified.binding_version !== ${quote(state.season_id + ":1")} ||\n` +
  `      (input.batch_id !== ${quote(state.partial_batch_id)} &&\n` +
  `       input.batch_id !== ${quote(state.reply_batch_id)})) {\n` +
  `    throw dragonBoatRequestError_("BRIDGE_PAYLOAD_INVALID", "Test receipt scope invalid.");\n` +
  `  }\n` +
  `  var sheet = getSystemSpreadsheet_().getSheetByName("BridgeExportReceipts");\n` +
  `  if (!sheet) return { status: "MISSING", batch_id: input.batch_id };\n` +
  `  var matches = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)\n` +
  `    .createTextFinder(input.batch_id).matchEntireCell(true).matchCase(true).findAll() : [];\n` +
  `  if (matches.length !== 1) return { status: matches.length ? "DUPLICATE" : "MISSING", batch_id: input.batch_id };\n` +
  `  var row = sheet.getRange(matches[0].getRow(), 1, 1, 9).getDisplayValues()[0];\n` +
  `  return { status: row[5], batch_id: row[0], payload_digest: row[1],\n` +
  `    season_id: row[2], binding_version: row[3], writer_epoch: row[4], result_json: row[6] };\n` +
  `}\n`;
const outputRoot = new URL("fault-overlay/", privateRoot);
const outputSource = new URL("source/", outputRoot);
mkdirSync(outputSource, { recursive: true });
writeFileSync(new URL("Code.js", outputSource), overlay);
copyFileSync(new URL("draft-snapshot/source/appsscript.json", privateRoot),
  new URL("appsscript.json", outputSource));
copyFileSync(new URL(".clasp.json", privateRoot), new URL(".clasp.json", outputRoot));
console.log(JSON.stringify({ isolated_v12_sha256: cleanHash,
  overlay_sha256: createHash("sha256").update(overlay).digest("hex").toUpperCase(),
  partial_scope: "PRACTICE", lost_reply_scope: "SEASON", output_ignored: true }));
