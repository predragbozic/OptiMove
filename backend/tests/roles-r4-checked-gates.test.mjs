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

// permissions.js imports authz.js, which imports db.js, which needs a URL even to construct its lazy pool. This
// unreachable loopback placeholder is never connected to (the unit runner scrubs every real database target).
process.env.DATABASE_URL ??= "postgresql://gates_fixture@127.0.0.1:1/gates_no_database";
const { ENFORCED_PERMISSIONS, HONOURED_PERMISSIONS, PERMISSIONS, STORABLE_PERMISSIONS } = await import("../src/permissions.js");

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

// A line that branches on a workspace type, whatever the variable is called: `workspace.type` / `activeWorkspace?.type`,
// any `<x>.type` or a local `type` / `<name>Type` compared with a workspace type word (either side), a `case "<type>":`,
// a list of type words or a `*_TYPES` constant asked `.includes(` / `.has(`.
const TYPES = "club|team|club_view|team_view|platform|private_coach|athlete";
const WORD = `["'](?:${TYPES})["']`;
const NAMED_TYPE = "(?:\\.type\\b|(?:^|[^\\w.])\\w*[tT]ype\\b)";
export const WORKSPACE_BRANCH = new RegExp([
  "(?:workspace|Workspace)\\??\\.type\\b",
  `${NAMED_TYPE}\\s*[!=]==?\\s*${WORD}`,
  `${WORD}\\s*[!=]==?\\s*[A-Za-z_.?]*[tT]ype\\b`,
  `case\\s+${WORD}\\s*:`,
  `\\[[^\\]]*${WORD}[^\\]]*\\]\\s*\\.(?:includes|has)\\(`,
  "\\b[A-Z_]*(?:WORKSPACE|SCOPE|CONTEXT)[A-Z_]*TYPES\\.(?:includes|has)\\(",
].join("|"));

// The reviewed list (roles R4-1, at the R4-1 base 4a24996): file -> number of lines that branch on a workspace type.
// Every one is pre-existing code; none offers a workspace (B2). The six modules of contract section 6 (calendar, training
// activities, external RPE schedules, measurements, dashboards, session types) take the active workspace as their data
// context and, for now, as their right; they recognize only the five existing types, so the R4-2 types fall through to
// "no scope" (fail closed). Each module's VIEW pull request revisits its rows. Changing or adding a count needs a review
// of that file against the rule (.claude/rules/backend-security.md), recorded in the pull request.
// The R4-1 files (permissions.js, permissionRolesService.js, clubCeilingLock.js) branch on a resource's or a role
// assignment's scope type ("club" / "team"), never on an offered workspace; inviteContext.js / joinLinkContext.js branch
// on an invitation's context and check the inviter's role rows; dashboardShellFilter.js and trainingLoadDashboardQuery.js
// read the dashboard's data workspace (one of the five existing types, anything else refused).
const REVIEWED = Object.freeze({
  "activityRoster.js": 5,
  // V-2: the view branch reads only the athletes gate's scope (req.moduleView, can(athletes.view)), never an offered
  // workspace; a view workspace without the gate's pass stays `and false` (+3).
  "athleteRosterScope.js": 7,
  // V-3: the read scopes branch on the type of the workspace a READ shows (calendarReadWorkspace: the active one, or the
  // club or team a view workspace names, from the entry gate only); the same 17 branches as before, renamed.
  "calendarAccess.js": 17,
  "calendarEventAccess.js": 7,
  // V-3: calendar.view on a coach workspace (its club or team scope), and the club of a team view scope (the gate's).
  "calendarModuleContext.js": 2,
  "calendarEventService.js": 5, // V-3: the catalog owner of a view workspace's GET /types (the club or team it names)
  "calendarQuery.js": 12,
  "calendarQuestionService.js": 2,
  "calendarSettingsService.js": 3,
  // V-1: resolveVariableViewer reads the club of the gate's view scope (club or team), never an offered workspace.
  "canonicalVariableAdminService.js": 2,
  "clubCeilingLock.js": 2,
  // P3 owner contract: both helpers explicitly close every workspace except club/team.
  "dashboardPages/service.js": 2, // Page scope consistency and athlete Training Load licence
  "dashboardReferences/access.js": 1,
  "dashboardReferences/bindingRouter.js": 1, // athlete/cohort groupBy validation, not a workspace authority
  "dashboardReferences/query.js": 1,
  "dashboardReferences/router.js": 1, // team picker narrows to the active team
  "dashboardReferences/preview.js": 2, // athlete/cohort grouping only; authorization stays in the existing query route
  "dashboardShellFilter.js": 5,
  "dashboardSimple/platformPilot.js": 1,
  "gpexeAthleteIdentityService.js": 3,
  "gpexeImportAccess.js": 5,
  "inviteContext.js": 6,
  "joinLinkContext.js": 5,
  "mediaStorage.js": 2,
  // V-0 (docs/ai/roles-v-steps-plan.md 3): canView maps a workspace to the scope can() is asked at (platform, private,
  // the old club / team rows, the view types) and viewReadScope to a view workspace's data context; never an offer, and
  // the entry gate lets a view workspace reach only a module's listed reads.
  "moduleView.js": 5,
  "organizationEntry.js": 1, // R4-2: lets a non-coach through only with a view workspace (contract 5.1)
  "permissionRolesService.js": 5,
  // R4-3 (reviewed in its pull request): a custom role's scope (club or team) - which club a team lies in, and that
  // the team is still active; a resource scope of the request, never an offered workspace.
  // + the acting user's team rows locked for a team-scope custom (the custom's own scope, as lock_permission_actor).
  "permissionLayersService.js": 3,
  "permissions.js": 8, // R4-2: closedModulesForWorkspace maps a workspace to its scope, /me narrows a view workspace's words (+4, never an offer)
  // V-2 (+3): the view scope of the athletes gate (club or team, never an offered workspace), and the club or team the
  // coach path asks athletes.view at (its own resolved club / team workspace).
  "positionService.js": 11,
  "routes/auth.js": 1,
  "routes/builder.js": 4,
  "routes/calendar.js": 1,
  "routes/gpexeImport.js": 3,
  "routes/organization.js": 22, // R4-2: the view branch of GET /, its fail-closed filter and the members rule (+3)
  "routes/taxonomy.js": 1, // V-1: viewScopeSql reads the gate's view scope (club or team), never an offered workspace
  "routes/tests.js": 1,
  "routes/trainingActivity.js": 9,
  "routes/trainingLoad.js": 16,
  "routes/trainingLoadDashboard.js": 1,
  "routes/trainingLoadMetrics.js": 8,
  "sessionTypeService.js": 6, // V-1: the club of the gate's view scope (club or team) (+1)
  "sourceConnectionService.js": 5,
  "sourceMetricAccess.js": 3,
  "testsAccess.js": 3, // V-4: viewScheduleScope reads the gate's view scope (club or team), never an offered workspace
  "trainingActivityAccess.js": 17,
  "trainingActivityMaterialize.js": 4,
  "trainingActivityResults.js": 1,
  "trainingLoadAccess.js": 24,
  // V-6: dashboards.view at a coach workspace's own club or team (an old role row), and the club / team data workspace
  // that load.view.athlete is asked for (+2); a view workspace is read through viewReadScope (the gate's), never offered.
  "trainingLoadDashboardAccess.js": 10,
  "trainingLoadDashboardCatalog.js": 3,
  "trainingLoadDashboardQuery.js": 13,
  "trainingLoadDashboardWidgets.js": 1,
  "trainingLoadMetricsAccess.js": 16,
  "trainingLoadOccurrenceService.js": 4,
  "workspace.js": 5, // R4-2: a stored club / team preference maps to club_view / team_view without the old row; L1 keeps such a preference (+3)
});

test("B0. the branch pattern finds a branch whatever the variable is called", () => {
  for (const line of ['if (ws.type === "club") return', 'w.type !== "team"', 'scope?.type === "club_view"', 'ctx.type == "platform"',
    '"team" === active.type', 'case "private_coach":', 'if (workspace?.type) x', 'const t = activeWorkspace.type;',
    "if (type === 'club') x", 'else if (type === "club" || type === "team")', 'if (dataWorkspaceType !== "platform")',
    "['platform','club','team'].includes(type)", "RECOGNIZED_DATA_WORKSPACE_TYPES.includes(dataWorkspaceType)"]) {
    assert.ok(WORKSPACE_BRANCH.test(line), line);
  }
  for (const line of ['const type = "club";', 'row.type === "drill"', 'event.kind === "club"', 'if (subtype === "drill")',
    "if (!MIME_TYPES.includes(x)) fail()", "if (!NODE_TYPES.has(nodeType)) return"]) assert.ok(!WORKSPACE_BRANCH.test(line), line);
});

// R4-2 (contract 5.1): the view types are named by the way in (workspace.js) and the organization read path only. Each
// module's VIEW pull request that opens its module to a view workspace adds its file here, reviewed against section 6
// (can() next to the workspace match, never instead of it). permissions.js maps them to a scope by object keys.
// V-0 (the code review): the pattern also sees an unquoted object key (club_view: …), so permissions.js (the scope map of
// /me) and moduleView.js (canView / the entry gate, reviewed in V-0) are listed.
const VIEW_TYPE_FILES = ["athleteRosterScope.js", "moduleView.js", "permissions.js", "routes/organization.js", "workspace.js"];
test("B3. the R4-2 workspace types (club_view, team_view) are named only where R4-2 opened them (a tripwire for the next helper)", () => {
  const named = SOURCES.filter((s) => /(?:["'](?:club_view|team_view)["']|\b(?:club_view|team_view)\s*:)/.test(s.text)).map((s) => s.rel).sort();
  assert.deepEqual(named, VIEW_TYPE_FILES);
});

test("B1. every workspace-type branch in backend/src is on the reviewed list (the R4-1 standing rule)", () => {
  const found = {};
  for (const src of SOURCES) {
    const n = src.text.split("\n").filter((line) => WORKSPACE_BRANCH.test(line)).length;
    if (n) found[src.rel] = n;
  }
  assert.ok(Object.hasOwn(found, "calendarEventAccess.js") && found["positionService.js"] >= 8, "the pattern sees branches on any variable");
  assert.ok(Object.hasOwn(found, "dashboardShellFilter.js") && Object.hasOwn(found, "trainingLoadDashboardQuery.js"), "and on a local type variable or a type list");
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
