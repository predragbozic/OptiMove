// Roles R4-1 (docs/ai/roles-r4-contract.md sections 4 and 13): two static proofs over backend/src.
//   A. "Checked means every gate" (7b's static half): every word of ENFORCED_PERMISSIONS is checked by can() in each
//      gate file it lists, and every can() call with a literal word in backend/src names a listed word from a listed
//      file - except the two global-only words (accounts.manage, platform.admin), which R2's test 17-honoured pins to
//      GLOBAL_SCOPE call sites. A word moves into the list only with every gate of its module (section 4).
//   B. The standing rule of R4-1 (.claude/rules/backend-security.md, "Workspace types"): every branch on a workspace
//      type in backend/src is on a reviewed list; a new one fails here until it is reviewed against the rule (no club
//      or team workspace for an account without that club's club_admin / that team's team_coach row, no helper that
//      derives a scope from {type, scopeId} without checking a role).
// No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENFORCED_PERMISSIONS, HONOURED_PERMISSIONS, PERMISSIONS, STORABLE_PERMISSIONS } from "../src/permissions.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : []));
}
const SOURCES = files(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf8") }));
const CAN_CALL = /\bcan\(\s*[A-Za-z_.?]+\s*,\s*"([a-z_.]+)"/g;
const GLOBAL_ONLY = new Set(["accounts.manage", "platform.admin"]);

test("A1. every listed gate file checks its word through can()", () => {
  for (const [word, gates] of Object.entries(ENFORCED_PERMISSIONS)) {
    assert.ok(Object.hasOwn(PERMISSIONS, word), word);
    assert.ok(gates.length > 0, `${word} lists its gates`);
    for (const gate of gates) {
      const src = SOURCES.find((s) => s.rel === gate);
      assert.ok(src, `${word}: gate file ${gate} exists`);
      const words = [...src.text.matchAll(CAN_CALL)].map((m) => m[1]);
      assert.ok(words.includes(word), `${word}: ${gate} calls can() with it`);
    }
  }
});

test("A2. every can() call with a literal word names a checked word from one of its listed gates (or a global-only word)", () => {
  let calls = 0;
  for (const src of SOURCES) {
    for (const m of src.text.matchAll(CAN_CALL)) {
      calls += 1;
      const word = m[1];
      if (GLOBAL_ONLY.has(word)) continue;
      assert.ok(Object.hasOwn(ENFORCED_PERMISSIONS, word), `${src.rel}: can(${word}) is not in ENFORCED_PERMISSIONS`);
      assert.ok(ENFORCED_PERMISSIONS[word].includes(src.rel), `${src.rel} is not a listed gate of ${word}`);
    }
  }
  assert.ok(calls >= 30, `${calls} can() calls found`);
});

test("A3. the lists nest: checked (HONOURED) = ENFORCED keys, checked is inside storable, storable has no platform-only word", () => {
  assert.deepEqual([...HONOURED_PERMISSIONS].sort(), Object.keys(ENFORCED_PERMISSIONS).sort());
  for (const w of HONOURED_PERMISSIONS) assert.ok(STORABLE_PERMISSIONS.includes(w), w);
  for (const w of STORABLE_PERMISSIONS) assert.ok(!PERMISSIONS[w].platformOnly, w);
  assert.equal(new Set(STORABLE_PERMISSIONS).size, STORABLE_PERMISSIONS.length);
});

// The reviewed list (roles R4-1, at the R4-1 base): file -> number of lines that branch on a workspace type. Each was
// read for the rule: the helpers recognize only the five existing types, and an unknown type (club_view / team_view
// of R4-2) falls through to "no scope" (contract section 6; the security review's list of fail-closed helpers).
// Changing a count needs a review of that file against the rule, recorded in the pull request.
const REVIEWED = Object.freeze({
  "activityRoster.js": 3,
  "athleteRosterScope.js": 4,
  "calendarAccess.js": 13,
  "calendarEventService.js": 4,
  "calendarQuery.js": 1,
  "calendarSettingsService.js": 3,
  "canonicalVariableAdminService.js": 1,
  "dashboardSimple/platformPilot.js": 1,
  "gpexeImportAccess.js": 5,
  "permissions.js": 1,
  "positionService.js": 1,
  "routes/auth.js": 1,
  "routes/gpexeImport.js": 3,
  "routes/organization.js": 14,
  "routes/trainingActivity.js": 3,
  "routes/trainingLoad.js": 7,
  "routes/trainingLoadMetrics.js": 5,
  "sourceConnectionService.js": 5,
  "sourceMetricAccess.js": 3,
  "testsAccess.js": 2,
  "trainingActivityAccess.js": 7,
  "trainingLoadAccess.js": 7,
  "trainingLoadDashboardAccess.js": 5,
  "trainingLoadMetricsAccess.js": 7
});

test("B1. every workspace-type branch in backend/src is on the reviewed list (the R4-1 standing rule)", () => {
  const found = {};
  for (const src of SOURCES) {
    const n = src.text.split("\n").filter((line) => /workspace\??\.type|activeWorkspace\??\.type/.test(line)).length;
    if (n) found[src.rel] = n;
  }
  for (const [file, n] of Object.entries(found)) {
    assert.ok(Object.hasOwn(REVIEWED, file), `${file} branches on a workspace type and is not on the reviewed list`);
    assert.ok(n <= REVIEWED[file], `${file}: ${n} workspace-type branches, ${REVIEWED[file]} reviewed`);
  }
});

test("B2. no source file offers a club or team workspace except workspace.js, and workspace.js offers them only from the old role rows", () => {
  const offers = SOURCES.filter((s) => /workspaces\.push\(\{\s*type:\s*"(club|team)"/.test(s.text)).map((s) => s.rel);
  assert.deepEqual(offers, ["workspace.js"]);
  const ws = SOURCES.find((s) => s.rel === "workspace.js").text;
  assert.match(ws, /const clubIds = authz\.clubRoles\.filter\(\(r\) => r\.role === "club_admin"\)/);
  assert.match(ws, /const teamIds = authz\.teamRoles\.filter\(\(r\) => r\.role === "team_coach"\)/);
  assert.match(ws, /type: "club", scopeId: club\.id[^}]*role: "club_admin"/);
  assert.match(ws, /type: "team", scopeId: team\.id[^}]*role: "team_coach"/);
});
