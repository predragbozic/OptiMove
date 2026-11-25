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
const EVENT = "22222222-0000-4000-8000-000000000001";
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

test("2. only the open modules (V-1: data_configuration, presets; V-2: athletes; V-3: calendar; V-6: dashboards): a view workspace holding every view word is refused every other module", () => {
  assert.deepEqual([...OPEN_VIEW_MODULES].sort(), ["athletes", "calendar", "dashboards", "data_configuration", "presets"]);
  const all = authzWith(Object.values(MODULE_VIEW_WORDS));
  for (const module of Object.keys(MODULE_VIEW_WORDS)) {
    const open = OPEN_VIEW_MODULES.includes(module);
    assert.equal(canView(all, clubView, module), open, module);
    assert.equal(canView(all, teamView, module), open, module);
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
  const ok = { user: { id: "u1" }, authz: holder, method: "GET", path: `/events/${EVENT}` };
  const r = await runGate(gate, ok);
  assert.equal(r.next, true);
  assert.deepEqual(ok.moduleView, { module: "calendar", workspace: clubView, scope: { type: "club", id: CLUB } });
  for (const [method, path] of [["POST", "/"], ["PATCH", `/events/${EVENT}`], ["GET", "/events"], ["GET", `/events/${EVENT}/questions`], ["GET", "/settings"], ["HEAD", "/"], ["GET", "/events/types"], ["GET", "/events/e1"]]) {
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
  // V-3: a refusal that passes the request on (marked, WITHOUT req.moduleView), so each route gives its own answer.
  const passOn = viewEntryGate("calendar", READS, { open: ["calendar"], resolve: resolver(clubView), refuse: (q, _res, next) => { q.marked = true; next(); } });
  const pq = { user: { id: "u1" }, authz: holder, method: "POST", path: "/" };
  const p = await runGate(passOn, pq);
  assert.deepEqual([p.next, p.status, pq.marked, pq.moduleView], [true, null, true, undefined], "passed on, marked, never as a view read");
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
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) assert.throws(() => viewEntryGate("calendar", [{ method, path: "/" }]), /Bad view route/, `only GET may be listed: ${method}`);
  assert.throws(() => viewEntryGate("calendar", [{ method: "GET", path: "/:key", params: { key: /[a-z]+/ } }]), /closed/, "an open parameter pattern");
  assert.doesNotThrow(() => viewEntryGate("calendar", [{ method: "GET", path: "/:key", params: { key: /^[a-z_]{1,40}$/ } }]));
  const src = fs.readFileSync(new URL("../src/moduleView.js", import.meta.url), "utf8");
  assert.ok(!/\bresolveActiveWorkspace\s*\(/.test(src), "moduleView.js never calls the resolver that writes a preference");
  const imports = src.match(/^import[^;]*;/gm).join("\n");
  assert.ok(!/\bresolveActiveWorkspace\b(?!ReadOnly)/.test(imports), "nor imports it");
});

test("10. through a real Express router: a listed GET /:dashboardId never admits the literal sibling GET /active (defined first); the listed read runs its handler", async () => {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const holder = authzWith(["dashboards.view"]);
  const ran = [];
  const router = express.Router();
  router.get("/active", (req, res) => { ran.push("active"); res.json({ active: true }); });
  router.get("/:dashboardId", (req, res) => { ran.push("one"); res.json({ scope: req.moduleView?.scope || null }); });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "u1" }; req.authz = holder; next(); });
  app.use("/d", viewEntryGate("dashboards", [{ method: "GET", path: "/:dashboardId" }], { open: ["dashboards"], resolve: resolver(clubView) }), router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/d`;
    const active = await fetch(`${base}/active`);
    assert.equal(active.status, 403, "a literal sibling is not a listed read");
    const one = await fetch(`${base}/${EVENT}`);
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { scope: { type: "club", id: CLUB } });
    assert.deepEqual(ran, ["one"], "the /active handler never ran");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("11. a custom parameter pattern is matched whole: an alternation /^a|b$/ admits only a and b; the g, y and m flags are refused", async () => {
  const holder = authzWith(["calendar.view"]);
  const gate = viewEntryGate("calendar", [{ method: "GET", path: "/x/:key", params: { key: /^a|b$/ } }], { open: ["calendar"], resolve: resolver(clubView) });
  for (const key of ["a", "b"]) assert.equal((await runGate(gate, { user: { id: "u1" }, authz: holder, method: "GET", path: `/x/${key}` })).next, true, key);
  for (const key of ["ab-anything", "a-sibling", "x-b", "ab", "A"]) {
    const r = await runGate(gate, { user: { id: "u1" }, authz: holder, method: "GET", path: `/x/${key}` });
    assert.equal(r.status, 403, key);
  }
  for (const flags of ["g", "y", "m", "gi"]) {
    assert.throws(() => viewEntryGate("calendar", [{ method: "GET", path: "/:key", params: { key: new RegExp("^[a-z]+$", flags) } }]), /without g, y or m/, flags);
  }
  assert.doesNotThrow(() => viewEntryGate("calendar", [{ method: "GET", path: "/:key", params: { key: /^[a-z]+$/i } }]), "the i flag is harmless");
});
test("12. V-6: a POST read is listed only with postRead and a last segment \"query\"; it then admits that POST and nothing else", async () => {
  assert.throws(() => viewEntryGate("dashboards", [{ method: "POST", path: "/:id/query" }]), /Bad view route/, "postRead is required");
  for (const path of ["/:id", "/:id/query/x", "/:id/queries", "/query-all"]) assert.throws(() => viewEntryGate("dashboards", [{ method: "POST", path, postRead: true }]), /Bad view route/, path);
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.throws(() => viewEntryGate("dashboards", [{ method, path: "/:id/query", postRead: true }]), /Bad view route/, method);
  const ID = "33333333-0000-4000-8000-000000000001";
  const holder = authzWith(["dashboards.view"]);
  const gate = viewEntryGate("dashboards", [{ method: "POST", path: "/:id/query", postRead: true }], { resolve: resolver(clubView), open: ["dashboards"] });
  const yes = await runGate(gate, { user: { id: "u1" }, authz: holder, method: "POST", path: `/${ID}/query` });
  assert.equal(yes.next, true);
  assert.equal(yes.status, null);
  for (const [method, path] of [["GET", `/${ID}/query`], ["POST", `/${ID}`], ["POST", `/${ID}/clone`], ["DELETE", `/${ID}/query`]]) {
    const no = await runGate(gate, { user: { id: "u1" }, authz: holder, method, path });
    assert.equal(no.status, 403, `${method} ${path}`);
  }
});
}
