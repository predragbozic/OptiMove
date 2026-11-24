// Roles V-0 (docs/ai/roles-v-steps-plan.md section 3): the shared view helper - canView, viewReadScope and the entry
// gate - on hand-built authorization contexts (the shape loadAuthorizationContext builds) and a stub workspace resolver.
// No database. The real server path is backend/tests/roles-v-sweep.test.mjs.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

if (needsModuleMocksRelaunch()) {
  test("module view helper with db.js replaced (no database)", () => {
    relaunchWithModuleMocks(import.meta.url);
  });
} else {
// db.js is replaced: any query from the helper would be a failure (the gate resolves the workspace through its stub).
mock.module("../src/db.js", { namedExports: { query: async () => { throw new Error("no database in this test"); }, pool: {} } });
const { MODULE_VIEW_WORDS, OPEN_VIEW_MODULES, canView, viewEntryGate, viewReadScope } = await import("../src/moduleView.js");
const { PERMISSIONS, STORABLE_PERMISSIONS } = await import("../src/permissions.js");

const CLUB = "11111111-0000-4000-8000-0000000000a1";
const TEAM = "11111111-0000-4000-8000-0000000000b1";
const OTHER = "11111111-0000-4000-8000-0000000000a2";

// An authz with one club-scope entry holding `words` (its teams listed), and the closed modules of that club.
function authzWith(words, { closed = [], scopeType = "club", scopeId = CLUB, teamIds = [TEAM], assignments = [{ scopeType, scopeId }] } = {}) {
  return {
    userId: "u1", platformRoles: [], clubRoles: [], teamRoles: [], isIndependentCoach: false,
    rolePermissions: [{ scopeType, scopeId, clubId: scopeType === "club" ? scopeId : CLUB, teamIds, words, closedModules: closed }],
    roleAssignments: assignments,
  };
}
const clubView = { type: "club_view", scopeId: CLUB };
const teamView = { type: "team_view", scopeId: TEAM, clubId: CLUB };

test("1. every module's view word is a known, storable (VIEW package) word, scoped to club and team", () => {
  for (const [module, word] of Object.entries(MODULE_VIEW_WORDS)) {
    assert.ok(Object.hasOwn(PERMISSIONS, word), `${module}: ${word}`);
    assert.ok(STORABLE_PERMISSIONS.includes(word), `${module}: ${word} is storable`);
    assert.deepEqual([...PERMISSIONS[word].scopeTypes].sort(), ["club", "team"], word);
  }
  assert.throws(() => canView(authzWith([]), clubView, "nope"), /Unknown view module/);
  assert.throws(() => viewEntryGate("nope", []), /Unknown view module/);
});

test("2. V-0 opens no module: a view workspace holding every view word is refused every module", () => {
  assert.deepEqual(OPEN_VIEW_MODULES, []);
  const all = authzWith(Object.values(MODULE_VIEW_WORDS));
  for (const module of Object.keys(MODULE_VIEW_WORDS)) {
    assert.equal(canView(all, clubView, module), false, module);
    assert.equal(canView(all, teamView, module), false, module);
  }
});

test("3. an open module: a view workspace reads it only with the word, at its own club (and the club's teams), never with the module closed by the licence", () => {
  const open = ["calendar"];
  assert.equal(canView(authzWith(["calendar.view"]), clubView, "calendar", { open }), true);
  assert.equal(canView(authzWith(["calendar.view"]), teamView, "calendar", { open }), true, "a club's word holds at its team");
  assert.equal(canView(authzWith(["tests.view"]), clubView, "calendar", { open }), false, "another word");
  assert.equal(canView(authzWith(["calendar.view"]), { type: "club_view", scopeId: OTHER }, "calendar", { open }), false, "another club");
  assert.equal(canView(authzWith(["calendar.view"], { closed: ["calendar"] }), clubView, "calendar", { open }), false, "closed by the ceiling");
  assert.equal(canView(authzWith(["calendar.view"]), clubView, "tests", { open }), false, "a module not open");
  assert.equal(canView(authzWith(["calendar.view"]), { type: "club_view", scopeId: "" }, "calendar", { open }), false, "no scope");
});

test("4. the coach workspaces ask can() at their scope; platform and private keep today's access; anything else is no", () => {
  const admin = authzWith(["calendar.view"]);
  assert.equal(canView(admin, { type: "club", scopeId: CLUB }, "calendar"), true, "open list does not matter for a coach workspace");
  assert.equal(canView(admin, { type: "team", scopeId: TEAM }, "calendar"), true);
  assert.equal(canView(authzWith([]), { type: "club", scopeId: CLUB }, "calendar"), false, "a club version without the word");
  assert.equal(canView(admin, { type: "club", scopeId: OTHER }, "calendar"), false);
  assert.equal(canView(authzWith(["calendar.view"], { closed: ["calendar"] }), { type: "club", scopeId: CLUB }, "calendar"), false);
  const platform = { ...authzWith([]), platformRoles: [{ role: "platform_admin" }] };
  assert.equal(canView(platform, { type: "platform", scopeId: null }, "calendar"), true);
  assert.equal(canView(authzWith(["calendar.view"]), { type: "platform", scopeId: null }, "calendar"), false, "a forged platform workspace");
  assert.equal(canView({ ...authzWith([]), isIndependentCoach: true }, { type: "private_coach", scopeId: null }, "calendar"), true);
  assert.equal(canView(authzWith([]), { type: "private_coach", scopeId: null }, "calendar"), false);
  for (const type of ["athlete", "bogus", undefined]) assert.equal(canView(admin, { type, scopeId: CLUB }, "calendar", { open: ["calendar"] }), false, String(type));
  assert.equal(canView(admin, null, "calendar"), false);
});

test("5. viewReadScope: the data context of a view workspace only", () => {
  assert.deepEqual(viewReadScope(clubView), { type: "club", id: CLUB });
  assert.deepEqual(viewReadScope(teamView), { type: "team", id: TEAM });
  for (const ws of [{ type: "club", scopeId: CLUB }, { type: "team", scopeId: TEAM }, { type: "platform" }, { type: "club_view", scopeId: "" }, null]) {
    assert.equal(viewReadScope(ws), null, JSON.stringify(ws));
  }
});

// The gate, with a stub resolver: what it answers and whether it called next().
async function runGate(gate, req) {
  const out = { status: null, body: null, next: false, error: null };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  await gate(req, res, (error) => { out.next = true; out.error = error || null; });
  return out;
}
const READS = [{ method: "GET", path: "/" }, { method: "GET", path: "/events/:id" }];
const resolver = (workspace, calls = []) => async (userId) => { calls.push(userId); return { workspace, availableWorkspaces: workspace ? [workspace] : [] }; };

test("6. the gate: an account that cannot have a view workspace goes on as today without a query; a coach workspace goes on unchanged", async () => {
  const calls = [];
  const gate = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: resolver(clubView, calls) });
  for (const authz of [{ roleAssignments: [] }, { roleAssignments: null }, { roleAssignments: "unavailable" }, {}]) {
    const r = await runGate(gate, { user: { id: "u1" }, authz, method: "POST", path: "/" });
    assert.equal(r.next, true);
    assert.equal(r.status, null);
  }
  assert.deepEqual(calls, [], "no workspace read for them");
  const coach = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: resolver({ type: "club", scopeId: CLUB }) });
  const r = await runGate(coach, { user: { id: "u1" }, authz: authzWith([]), method: "DELETE", path: "/events/x" });
  assert.equal(r.next, true, "a coach workspace is not this gate's business");
});

test("7. the gate: a view workspace reaches only the listed reads, of an open module, with the word; everything else is the router's refusal", async () => {
  const holder = authzWith(["calendar.view"]);
  const gate = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: resolver(clubView) });
  const ok = { user: { id: "u1" }, authz: holder, method: "GET", path: "/events/e1" };
  const r = await runGate(gate, ok);
  assert.equal(r.next, true);
  assert.deepEqual(ok.moduleView, { module: "calendar", workspace: clubView, scope: { type: "club", id: CLUB } });
  for (const [method, path] of [["POST", "/"], ["PATCH", "/events/e1"], ["GET", "/events"], ["GET", "/events/e1/questions"], ["GET", "/settings"], ["HEAD", "/"]]) {
    const req = { user: { id: "u1" }, authz: holder, method, path };
    const x = await runGate(gate, req);
    assert.equal(x.next, false, `${method} ${path}`);
    assert.equal(x.status, 403);
    assert.deepEqual(x.body, { error: "Forbidden" });
    assert.equal(req.moduleView, undefined);
  }
  const noWord = await runGate(gate, { user: { id: "u1" }, authz: authzWith(["tests.view"]), method: "GET", path: "/" });
  assert.equal(noWord.status, 403);
  const closedGate = viewEntryGate("calendar", READS, { open: [], resolve: resolver(clubView) });
  assert.equal((await runGate(closedGate, { user: { id: "u1" }, authz: holder, method: "GET", path: "/" })).status, 403, "a module not open");
  const notFound = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: resolver(clubView), refuse: (_q, res) => res.status(404).json({ error: "notFound" }) });
  const nf = await runGate(notFound, { user: { id: "u1" }, authz: holder, method: "POST", path: "/" });
  assert.deepEqual([nf.status, nf.body], [404, { error: "notFound" }], "the router's own refusal");
});

test("8. the gate: the fallback workspace counts; a resolver error goes to the error handler; no user goes on (requireAuth answers first)", async () => {
  const holder = authzWith(["calendar.view"]);
  const fallback = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: async () => ({ workspace: null, availableWorkspaces: [clubView] }) });
  assert.equal((await runGate(fallback, { user: { id: "u1" }, authz: holder, method: "POST", path: "/" })).status, 403);
  const boom = new Error("db down");
  const failing = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: async () => { throw boom; } });
  const f = await runGate(failing, { user: { id: "u1" }, authz: holder, method: "GET", path: "/" });
  assert.equal(f.error, boom);
  assert.equal((await runGate(failing, { authz: holder, method: "GET", path: "/" })).next, true);
});

test("9. a bad route list is refused at mount; the gate resolves read-only (never the writing resolveActiveWorkspace)", () => {
  assert.throws(() => viewEntryGate("calendar", [{ method: "GET", path: "events" }]), /Bad view route/);
  assert.throws(() => viewEntryGate("calendar", [{ path: "/" }]), /Bad view route/);
  const src = fs.readFileSync(new URL("../src/moduleView.js", import.meta.url), "utf8");
  assert.ok(!/resolveActiveWorkspace(?!ReadOnly)\b/.test(src), "moduleView.js never calls the resolver that writes a preference");
});
}
