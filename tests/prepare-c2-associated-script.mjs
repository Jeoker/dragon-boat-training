// Prepare the clean C2 associated bridge in the disposable Apps Script checkout.
// It does not call clasp or deploy. Explicit invocation and exact v12 source guard are required.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";

assert.ok(process.argv.includes("--prepare-isolated-associated"),
  "Explicit --prepare-isolated-associated is required.");
const privateRoot = new URL("../../.c2-form-test/", import.meta.url);
const identities = JSON.parse(readFileSync(new URL("isolated-identities.json", privateRoot), "utf8"));
const clasp = JSON.parse(readFileSync(new URL(".clasp.json", privateRoot), "utf8"));
assert.match(identities.script_id, /^[A-Za-z0-9_-]{30,}$/u);
assert.match(identities.deployment_id, /^[A-Za-z0-9_-]{30,}$/u);
assert.equal(clasp.scriptId, identities.script_id);
assert.equal(clasp.rootDir, "source");
const sourceDir = new URL("source/", privateRoot);
const sourceNames = readdirSync(sourceDir).sort();
assert.deepEqual(sourceNames, ["C2Fixture.gs", "Code.gs", "Code.js", "appsscript.json"],
  "Unexpected isolated Apps Script source files; inspect them before preparing.");
const stalePath = new URL("source/Code.gs", privateRoot);
const preservedStalePath = new URL("pre-associated-legacy-Code.gs", privateRoot);
assert.ok(!existsSync(preservedStalePath), "The legacy source preservation target already exists.");
const sha = (data) => createHash("sha256").update(data).digest("hex").toUpperCase();
const currentPath = new URL("source/Code.js", privateRoot);
const current = readFileSync(currentPath, "utf8");
assert.equal(sha(current), identities.clean_v12_sha256,
  "The isolated Apps Script checkout is not the recorded clean v12; stop before overwriting it.");
const frozenV12 = readFileSync(new URL("draft-snapshot/source/Code.js", privateRoot), "utf8");
assert.equal(frozenV12, current, "The clean v12 recovery snapshot differs from the checkout.");
assert.ok(readFileSync(new URL("source/appsscript.json", privateRoot), "utf8").includes('"timeZone"'));
const generated = readFileSync(new URL("../backend/.build/Code.gs", import.meta.url), "utf8");
for (const name of ["cloudflarePatchSignupSheet", "cloudflarePatchSeatPlanStateSheet",
  "cloudflarePatchSeatPlanCurrentSheet", "cloudflarePatchSeatPlanRevisionSheet"]) {
  assert.ok(generated.includes(name), `The generated bridge lacks ${name}.`);
}
assert.ok(!generated.includes("TEST_INJECTED_") && !generated.includes("c2TestReadFaultReceipt"),
  "Fault-injection code must not enter the clean bridge.");
const nextHash = sha(generated);
assert.notEqual(nextHash, identities.clean_v12_sha256);
// `clasp push` uploads every source file. Preserve the old duplicate-name Code.gs
// outside rootDir so that the generated Code.js is the sole backend program.
renameSync(stalePath, preservedStalePath);
writeFileSync(currentPath, generated, "utf8");
assert.deepEqual(readdirSync(sourceDir).sort(), ["C2Fixture.gs", "Code.js", "appsscript.json"]);
console.log(JSON.stringify({ prepared: true, isolated_checkout: true,
  source_sha256: nextHash, script_identity_checked: true, legacy_source_preserved: true,
  deployed: false }));
