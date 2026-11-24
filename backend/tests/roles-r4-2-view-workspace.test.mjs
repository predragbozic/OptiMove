// Roles R4-2 (docs/ai/roles-r4-contract.md 5.1, 6, 11 and 14 item 7): the way into a club for an account that holds a
// role there only through a live new-style assignment - the club_view / team_view workspaces, the organization entry
// gate, GET /api/organization for a view workspace, /me (words and closed modules), the members list with live
// assignments (#717's rule) and its staff.assign gate (L3), the forged preference, cross-club and the mixed account, and
// the mandatory test of section 6 (a view workspace opens no module beyond the organization read). Disposable database,
// the real server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildDatabase, fixtures, key, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
const VIEW = ["athletes.view", "calendar.view", "dashboards.view", "exercises.use", "load.view.athlete", "load.view.team",
  "presets.use", "programs.view", "tests.results.view", "tests.view", "variables.view"];
const VIEW_KEYS = ["scope", "isPlatformAdmin", "canCreateClub", "canCreateTeam", "canCreateAthlete", "canCreateUser",
  "manageableClubIds", "manageableTeamIds", "clubs", "teams", "archivedTeams", "athletes", "users", "accessRequests",
  "joinLinks", "joinApplications", "activeWorkspace"];
let db, k, F, srv, w;

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const person = async (label, setup = async () => {}) => { const id = await F.user(label); await setup(id); return { id, cookie: await srv.cookieFor(id) }; };
const me = async (who) => ok(await srv.api(who.cookie, "/api/auth/me")).user;
const org = (who) => srv.api(who.cookie, "/api/organization");
const pref = async (who) => one(`select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1`, [who.id]);
const setPref = (who, type, scopeId) => k.query(
  `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at) values ($1, $2, $3, now())
   on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id, updated_at = now()`,
  [who.id, type, scopeId]);
const clearPref = (who) => k.query(`delete from public.user_workspace_preferences where user_id = $1`, [who.id]);
const createRole = async (who, clubId, scopeTypes) => ok(await srv.api(who.cookie, R, { method: "POST", body: {
  requestKey: key(), clubId, scopeTypes, items: ["org.view"], name: `View ${key().slice(0, 6)}` } })).role;
const grant = async (who, userId, roleId, scopeType, scopeId) => ok(await srv.api(who.cookie, `${R}/assignments`, { method: "POST", body: {
  requestKey: key(), reason: "Needed", userId, roleId, scopeType, scopeId } })).assignment;
const revoke = async (who, a) => ok(await srv.api(who.cookie, `${R}/assignments/${a.id}/revoke`, { method: "POST", body: {
  requestKey: key(), reason: "Done", expected: { userId: a.userId, roleId: a.roleId } } }));
// The text of an answer, ids of the request's own account replaced, so two accounts' answers compare.
const has = (text, ids) => ids.filter((id) => id && text.includes(String(id)));

before(async () => {
  db = await buildDatabase({ label: "r42view", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  w = { A: await F.club("Alpha"), B: await F.club("Beta") };
  w.TA1 = await F.team(w.A, "TA1");
  w.TA2 = await F.team(w.A, "TA2");
  w.TA3 = await F.team(w.A, "TA3archived");
  await k.query(`update public.teams set is_active = false where id = $1`, [w.TA3]);
  w.TB1 = await F.team(w.B, "TB1");
  w.pa = await person("pa", (id) => F.grantPlatform(id));
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.coachA = await person("coachA", (id) => F.grantTeam(id, w.TA1));
  w.coachB = await person("coachB", (id) => F.grantTeam(id, w.TB1));
  w.viewer = await person("viewer");
  w.teamViewer = await person("teamViewer");
  w.mixed = await person("mixed", (id) => F.grantClub(id, w.A));
  w.teamAssigned = await person("teamAssigned");
  w.revoked = await person("revoked");
  w.expired = await person("expired");
  w.nobody = await person("nobody");
  w.roleA = await createRole(w.adminA, w.A, ["club", "team"]);
  w.roleB = await createRole(w.adminB, w.B, ["club", "team"]);
  w.aViewer = await grant(w.adminA, w.viewer.id, w.roleA.id, "club", w.A);
  w.aTeamViewer = await grant(w.adminB, w.teamViewer.id, w.roleB.id, "team", w.TB1);
  w.aMixed = await grant(w.adminB, w.mixed.id, w.roleB.id, "club", w.B);
  w.aTeamAssigned = await grant(w.adminA, w.teamAssigned.id, w.roleA.id, "team", w.TA2);
  w.aRevoked = await grant(w.adminA, w.revoked.id, w.roleA.id, "club", w.A);
  await revoke(w.adminA, w.aRevoked);
  w.aExpired = await grant(w.adminA, w.expired.id, w.roleA.id, "club", w.A);
  await k.query(`set session_replication_role = replica`);
  await k.query(`update public.user_role_assignments set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`, [w.aExpired.id]);
  await k.query(`set session_replication_role = origin`);
  // An athlete of each club, so a leak of athlete data shows by name and id.
  w.athA = ok(await srv.api(w.adminA.cookie, "/api/organization/athletes", { method: "POST", body: { fullName: "Zorana Alphaathlete", clubId: w.A, teamId: w.TA1 } }), 201).athlete;
  w.athB = ok(await srv.api(w.adminB.cookie, "/api/organization/athletes", { method: "POST", body: { fullName: "Bojana Betaathlete", clubId: w.B, teamId: w.TB1 } }), 201).athlete;
  w.idsA = [w.A, w.TA1, w.TA2, w.TA3, w.athA.id, "Alphaathlete", w.adminA.id, w.coachA.id];
  w.idsB = [w.B, w.TB1, w.athB.id, "Betaathlete", w.adminB.id, w.coachB.id];
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

test("1. an account with only a club assignment is offered club_view (never club), lands in it, and the stored preference is club", async () => {
  await clearPref(w.viewer);
  const u = await me(w.viewer);
  assert.deepEqual(u.availableWorkspaces.map((x) => [x.type, x.scopeId]), [["club_view", w.A]]);
  assert.equal(u.activeWorkspace.type, "club_view");
  assert.equal(u.activeWorkspace.role, "role_holder");
  assert.deepEqual(await pref(w.viewer), { workspace_type: "club", scope_id: w.A });
  assert.deepEqual(u.permissions, ["org.view"]);
  assert.deepEqual(u.closedModules, []);
  assert.equal(u.capabilities.coachWorkspace, false);
  // A team assignment: team_view of that team (with its club), never team; an archived team or a revoked / expired
  // assignment is offered nothing.
  const t = await me(w.teamViewer);
  assert.deepEqual(t.availableWorkspaces.map((x) => [x.type, x.scopeId, x.clubId]), [["team_view", w.TB1, w.B]]);
  for (const who of [w.revoked, w.expired, w.nobody]) {
    const x = await me(who);
    assert.deepEqual(x.availableWorkspaces, [], who.id);
    assert.equal(x.activeWorkspace, null);
  }
  // An old role row of that club wins: the club admin of A with an assignment in A is offered club only.
  const extra = await grant(w.adminA, w.coachA.id, w.roleA.id, "club", w.A);
  const c = await me(w.coachA);
  assert.deepEqual(c.availableWorkspaces.map((x) => x.type).sort(), ["club_view", "team"]);
  // With two workspaces the stored club + A is the club_view one (the mapping), not the fallback (team comes first).
  await setPref(w.coachA, "club", w.A);
  assert.deepEqual([(await me(w.coachA)).activeWorkspace.type, (await pref(w.coachA)).workspace_type], ["club_view", "club"]);
  await revoke(w.adminA, extra);
  assert.deepEqual((await me(w.coachA)).availableWorkspaces.map((x) => x.type), ["team"]);
});

test("2. GET /api/organization for club_view: the club and its active teams, no athlete, the account itself only, a fixed list of keys", async () => {
  await setPref(w.viewer, "club", w.A);
  const res = await org(w.viewer);
  const body = ok(res);
  assert.deepEqual(Object.keys(body), VIEW_KEYS);
  assert.deepEqual(body.clubs.map((c) => c.id), [w.A]);
  assert.deepEqual(body.teams.map((t) => t.id).sort(), [w.TA1, w.TA2].sort());
  assert.deepEqual(body.athletes, []);
  assert.deepEqual(body.users.map((u) => u.id), [w.viewer.id]);
  for (const k2 of ["archivedTeams", "accessRequests", "joinLinks", "joinApplications", "manageableClubIds", "manageableTeamIds"]) assert.deepEqual(body[k2], [], k2);
  for (const k2 of ["canCreateClub", "canCreateTeam", "canCreateAthlete", "canCreateUser", "isPlatformAdmin"]) assert.equal(body[k2], false, k2);
  assert.equal(body.activeWorkspace.type, "club_view");
  assert.deepEqual(has(res.text, [w.TA3, w.athA.id, "Alphaathlete", w.adminA.id, w.coachA.id, w.teamAssigned.id, ...w.idsB]), []);
  // team_view: that team only.
  const t = await org(w.teamViewer);
  const tb = ok(t);
  assert.deepEqual(Object.keys(tb), VIEW_KEYS);
  assert.deepEqual(tb.clubs, []);
  assert.deepEqual(tb.teams.map((x) => x.id), [w.TB1]);
  assert.deepEqual(tb.users.map((u) => u.id), [w.teamViewer.id]);
  assert.deepEqual(has(t.text, [w.athB.id, "Betaathlete", w.adminB.id, w.coachB.id, ...w.idsA]), []);
});

test("3. the entry gate: every other method and path behind the organization router answers today's 403; an account without a view workspace gets 403 on GET / too", async () => {
  const calls = [
    ["POST", "/athletes", { fullName: "Leak Test", clubId: w.A }], ["POST", "/teams", { name: "New", clubId: w.A }],
    ["PUT", `/clubs/${w.A}`, { name: "Renamed" }], ["DELETE", `/clubs/${w.A}`], ["GET", "/clubs-summary"],
    ["GET", "/athlete-join-links"], ["POST", "/club-roles", { userId: w.viewer.id, clubId: w.A, role: "club_admin" }],
    ["PUT", `/users/${w.viewer.id}/club-roles/${w.A}/club_admin`], ["POST", "/users", { email: "x@test.local" }],
    ["GET", `/users/${w.viewer.id}/account`], ["PUT", `/teams/${w.TA1}`, { name: "x" }], ["POST", "/"], ["PUT", "/"],
  ];
  for (const [method, p, body] of calls) {
    const res = await srv.api(w.viewer.cookie, `/api/organization${p}`, { method, body });
    assert.equal(res.status, 403, `${method} ${p}: ${res.text}`);
    assert.deepEqual(res.body, { error: "Forbidden" }, `${method} ${p}`);
  }
  assert.equal((await one(`select count(*)::int as n from public.teams where name = 'New'`)).n, 0);
  assert.equal((await one(`select count(*)::int as n from public.athletes where full_name = 'Leak Test'`)).n, 0);
  for (const who of [w.nobody, w.revoked, w.expired]) {
    const res = await org(who);
    assert.equal(res.status, 403, res.text);
    assert.deepEqual(res.body, { error: "Forbidden" });
  }
  // An athlete without a role: as before.
  const ath = await person("ath", (id) => F.makeAthlete(id));
  assert.equal((await org(ath)).status, 403);
  assert.equal(await pref(ath), undefined, "the refused request wrote no preference (the gate only reads)");
  assert.equal((await me(ath)).activeWorkspace.type, "athlete");
});

test("4. a forged or stale preference: club + A resolves to club_view A (never club); club + B (nothing there) falls back; PUT accepts club_view only for its own club", async () => {
  await setPref(w.viewer, "club", w.A);
  assert.equal((await me(w.viewer)).activeWorkspace.type, "club_view");
  await setPref(w.viewer, "club", w.B);
  const u = await me(w.viewer);
  assert.deepEqual([u.activeWorkspace.type, u.activeWorkspace.scopeId], ["club_view", w.A]);
  assert.deepEqual(await pref(w.viewer), { workspace_type: "club", scope_id: w.A });
  await setPref(w.viewer, "team", w.TA1);
  assert.equal((await me(w.viewer)).activeWorkspace.type, "club_view");
  const put = (body) => srv.api(w.viewer.cookie, "/api/auth/workspace", { method: "PUT", body });
  for (const body of [{ type: "club", scopeId: w.A }, { type: "club_view", scopeId: w.B }, { type: "team_view", scopeId: w.TA1 }, { type: "team", scopeId: w.TA1 }]) {
    const res = await put(body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.body.error, "WORKSPACE_NOT_AVAILABLE");
  }
  const okPut = ok(await put({ type: "club_view", scopeId: w.A }));
  assert.equal(okPut.activeWorkspace.type, "club_view");
  assert.deepEqual(await pref(w.viewer), { workspace_type: "club", scope_id: w.A });
  // The team viewer: PUT team_view stores team.
  ok(await srv.api(w.teamViewer.cookie, "/api/auth/workspace", { method: "PUT", body: { type: "team_view", scopeId: w.TB1 } }));
  assert.deepEqual(await pref(w.teamViewer), { workspace_type: "team", scope_id: w.TB1 });
});

test("5. cross-club: a role holder of A reaches nothing of B; the Roles API answers the identical 404 for B", async () => {
  await setPref(w.viewer, "club", w.B);
  const res = await org(w.viewer);
  ok(res);
  assert.equal(res.body.activeWorkspace.scopeId, w.A);
  assert.deepEqual(has(res.text, w.idsB), []);
  const roles = await srv.api(w.viewer.cookie, `${R}/assignments?clubId=${w.B}`);
  const missing = await srv.api(w.viewer.cookie, `${R}/assignments?clubId=00000000-0000-4000-8000-00000000abcd`);
  assert.equal(roles.status, 404);
  assert.deepEqual([roles.status, roles.body], [missing.status, missing.body]);
});

test("6. a mixed account (club admin of A, role holder of B) in club_view B sees nothing of A; in its club workspace it sees A as before", async () => {
  ok(await srv.api(w.mixed.cookie, "/api/auth/workspace", { method: "PUT", body: { type: "club_view", scopeId: w.B } }));
  const res = await org(w.mixed);
  const body = ok(res);
  assert.deepEqual(Object.keys(body), VIEW_KEYS);
  assert.deepEqual(body.clubs.map((c) => c.id), [w.B]);
  assert.deepEqual(body.teams.map((t) => t.id), [w.TB1]);
  assert.deepEqual(body.users.map((u) => u.id), [w.mixed.id]);
  assert.deepEqual(body.users[0].clubRoles, [], "its own row is narrowed to B: its club_admin row of A is not shown");
  assert.deepEqual(has(res.text, w.idsA), []);
  const meB = await me(w.mixed);
  assert.deepEqual(meB.permissions, ["org.view"]);
  ok(await srv.api(w.mixed.cookie, "/api/auth/workspace", { method: "PUT", body: { type: "club", scopeId: w.A } }));
  const a = ok(await org(w.mixed));
  assert.deepEqual(a.clubs.map((c) => c.id), [w.A]);
  assert.ok(a.athletes.some((x) => x.id === w.athA.id));
});

test("7. the members list (#717, L3): live assignments make a member for the club's admin; a role holder of org.view alone sees only itself", async () => {
  await setPref(w.adminA, "club", w.A);
  const users = ok(await org(w.adminA)).users.map((u) => u.id);
  for (const id of [w.adminA.id, w.coachA.id, w.mixed.id, w.viewer.id, w.teamAssigned.id]) assert.ok(users.includes(id), id);
  for (const id of [w.revoked.id, w.expired.id, w.teamViewer.id, w.adminB.id, w.coachB.id, w.nobody.id]) assert.ok(!users.includes(id), id);
  // B's admin sees its own assignment holders (the team viewer, the mixed account) and none of A's.
  await setPref(w.adminB, "club", w.B);
  const usersB = ok(await org(w.adminB)).users;
  const idsB = usersB.map((u) => u.id);
  for (const id of [w.teamViewer.id, w.mixed.id, w.coachB.id]) assert.ok(idsB.includes(id), id);
  for (const id of [w.viewer.id, w.teamAssigned.id, w.coachA.id]) assert.ok(!idsB.includes(id), id);
  assert.deepEqual(usersB.find((u) => u.id === w.mixed.id).clubRoles, [], "the mixed account's club_admin row of A is narrowed away");
  // L3: the org.view-only role holder in club_view A gets itself, never the members.
  await setPref(w.viewer, "club", w.A);
  assert.deepEqual(ok(await org(w.viewer)).users.map((u) => u.id), [w.viewer.id]);
  // A revoked assignment ends membership at once.
  const tmp = await grant(w.adminA, w.nobody.id, w.roleA.id, "team", w.TA1);
  assert.ok(ok(await org(w.adminA)).users.some((u) => u.id === w.nobody.id));
  await revoke(w.adminA, tmp);
  assert.ok(!ok(await org(w.adminA)).users.some((u) => u.id === w.nobody.id));
});

test("8. /me closedModules: the active workspace's club licence, only to an account holding a role there", async () => {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  const ceiling = async (action) => {
    await c.query("begin");
    await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [w.pa.id]);
    await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.A]]);
    if (action === "close") await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'calendar', $2, 'licence')`, [w.A, w.pa.id]);
    else await c.query(`delete from public.club_permission_ceiling where club_id = $1 and module_word = 'calendar'`, [w.A]);
    await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'calendar', $3, $2, 'licence')`, [w.A, w.pa.id, action]);
    await c.query("commit");
  };
  try {
    await ceiling("close");
    await setPref(w.viewer, "club", w.A);
    await setPref(w.adminA, "club", w.A);
    await setPref(w.coachA, "team", w.TA1);
    await setPref(w.teamAssigned, "team", w.TA2);
    await setPref(w.adminB, "club", w.B);
    assert.deepEqual((await me(w.viewer)).closedModules, ["calendar"]);
    assert.deepEqual((await me(w.adminA)).closedModules, ["calendar"]);
    assert.deepEqual((await me(w.coachA)).closedModules, ["calendar"]);
    assert.deepEqual((await me(w.teamAssigned)).closedModules, ["calendar"]);
    assert.deepEqual((await me(w.adminB)).closedModules, []);
    assert.deepEqual((await me(w.pa)).closedModules, []);
    await ceiling("open");
    assert.deepEqual((await me(w.viewer)).closedModules, []);
  } finally {
    await c.end();
  }
});

test("9. the assignment ends: the view workspace is gone at once, /api/organization answers 403", async () => {
  const p = await person("short");
  const a = await grant(w.adminA, p.id, w.roleA.id, "club", w.A);
  assert.equal((await me(p)).activeWorkspace.type, "club_view");
  ok(await org(p));
  await revoke(w.adminA, a);
  assert.equal((await me(p)).activeWorkspace, null);
  assert.equal((await org(p)).status, 403);
});

test("10. no fallback is persisted when the role tables could not be read (5.1, L1)", async () => {
  const { resolveActiveWorkspace } = await import("../src/workspace.js");
  await setPref(w.viewer, "club", w.A);
  const unreadable = { userId: w.viewer.id, platformRoles: [], clubRoles: [], teamRoles: [], isIndependentCoach: false, isAthlete: true,
    rolePermissions: Object.freeze({ unavailable: true }), roleAssignments: [] };
  const r = await resolveActiveWorkspace(w.viewer.id, unreadable);
  assert.equal(r.workspace.type, "athlete");
  assert.deepEqual(await pref(w.viewer), { workspace_type: "club", scope_id: w.A });
  // L1 is narrow: unreadable role tables keep only a stale club / team preference that may be a view workspace. One
  // where the account holds no live assignment (club B; a revoked assignment in A for w.revoked) is replaced as before R4-2.
  await setPref(w.viewer, "club", w.B);
  await resolveActiveWorkspace(w.viewer.id, unreadable);
  assert.deepEqual(await pref(w.viewer), { workspace_type: "athlete", scope_id: null });
  await setPref(w.revoked, "club", w.A);
  await resolveActiveWorkspace(w.revoked.id, { ...unreadable, userId: w.revoked.id });
  assert.deepEqual(await pref(w.revoked), { workspace_type: "athlete", scope_id: null });
  await setPref(w.viewer, "team", w.TA1);
  await resolveActiveWorkspace(w.viewer.id, unreadable);
  assert.deepEqual(await pref(w.viewer), { workspace_type: "athlete", scope_id: null }, "an assignment of another scope does not keep it");
  await setPref(w.viewer, "club", w.A);
  await resolveActiveWorkspace(w.viewer.id, unreadable);
  assert.deepEqual(await pref(w.viewer), { workspace_type: "club", scope_id: w.A }, "a live assignment in that scope keeps it");
  const r2 = await resolveActiveWorkspace(w.viewer.id, { ...unreadable, rolePermissions: [] });
  assert.equal(r2.workspace.type, "athlete");
  assert.deepEqual(await pref(w.viewer), { workspace_type: "athlete", scope_id: null });
  await setPref(w.viewer, "club", w.A);
});

// Section 6, mandatory: an account with only a club assignment holding EVERY view word (planted: the service refuses an
// unchecked word, O6), in club_view - and again with a forged club preference - gets from every module exactly what an
// account with no role at all gets (the same status and the same answer), and no write lands. The modules open one by
// one in their VIEW pull requests, which change their rows here.
test("11. section 6: a view workspace with every view word opens no module beyond the organization read", async () => {
  const full = await createRole(w.adminA, w.A, ["club", "team"]);
  await k.query(`set session_replication_role = replica`);
  try {
    for (const word of VIEW) await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, $2)`, [full.id, word]);
  } finally {
    await k.query(`set session_replication_role = origin`);
  }
  const holder = await person("holder");
  await grant(w.adminA, holder.id, full.id, "club", w.A);
  const hm = await me(holder);
  assert.equal(hm.activeWorkspace.type, "club_view");
  assert.deepEqual(hm.permissions, ["org.view"], "only checked words reach /me");
  const q = `from=2026-11-01&to=2026-11-30`;
  const reads = ["/api/athletes", "/api/plans", "/api/templates", "/api/exercises", "/api/exercise-collections", "/api/builder/plans",
    "/api/taxonomy", `/api/calendar?${q}`, `/api/calendar/events?${q}`, `/api/calendar/settings?clubId=${w.A}`,
    `/api/training-activity?${q}`, "/api/training-activity/session-types", "/api/training-load/weekly",
    "/api/training-load/external-schedules", "/api/training-load/metrics/definitions", `/api/training-load/metrics/occasions?${q}`,
    "/api/training-load/dashboards", "/api/tests", `/api/training-load/gpexe/teams/${w.TA1}/status`,
    "/api/training-load/sources/metrics/variables", "/api/positions", "/api/coaches", `/api/athletes/${w.athA.id}`];
  const writes = [["/api/calendar/events", { title: "x", clubId: w.A }], ["/api/training-load/dashboards", { name: "x" }],
    ["/api/training-activity/session-types", { name: "x" }], ["/api/plans", { name: "x" }], ["/api/tests", { name: "x" }]];
  const norm = (who, text) => text.split(who.id).join("<me>");
  for (const forged of [false, true]) {
    if (forged) await setPref(holder, "club", w.A);
    for (const p of reads) {
      const a = await srv.api(holder.cookie, p);
      const b = await srv.api(w.nobody.cookie, p);
      assert.equal(a.status, b.status, `${p}: ${a.status} ${a.text.slice(0, 200)} vs ${b.status} ${b.text.slice(0, 200)}`);
      assert.equal(norm(holder, a.text), norm(w.nobody, b.text), `${p}: the same answer as an account with no role`);
      assert.deepEqual(has(a.text, w.idsA.filter((id) => !p.includes(String(id)))), [], p);
    }
    for (const [p, body] of writes) {
      const a = await srv.api(holder.cookie, p, { method: "POST", body });
      assert.ok(a.status >= 400, `${p}: ${a.status} ${a.text.slice(0, 200)}`);
    }
    assert.equal((await me(holder)).activeWorkspace.type, "club_view");
  }
});

test("12. org.view is the right: a holder of a role without it gets the way in but no club, team or member", async () => {
  const bare = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: {
    requestKey: key(), clubId: w.A, scopeTypes: ["club", "team"], items: [], name: `Bare ${key().slice(0, 6)}` } })).role;
  const p = await person("bare");
  await grant(w.adminA, p.id, bare.id, "club", w.A);
  const u = await me(p);
  assert.equal(u.activeWorkspace.type, "club_view");
  assert.deepEqual(u.permissions, []);
  const body = ok(await org(p));
  assert.deepEqual([body.clubs, body.teams, body.users.map((x) => x.id)], [[], [], [p.id]]);
});

test("14. /me in a view workspace lists only the words its routes let through: a held org.teams.manage is not offered, and its route answers 403", async () => {
  const role = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: {
    requestKey: key(), clubId: w.A, scopeTypes: ["club"], items: ["org.view", "org.teams.manage"], name: `Teams ${key().slice(0, 6)}` } })).role;
  const p = await person("teamsword");
  await grant(w.adminA, p.id, role.id, "club", w.A);
  const u = await me(p);
  assert.equal(u.activeWorkspace.type, "club_view");
  assert.deepEqual(u.permissions, ["org.view"]);
  const res = await srv.api(p.cookie, "/api/organization/teams", { method: "POST", body: { name: "Never", clubId: w.A } });
  assert.deepEqual([res.status, res.body], [403, { error: "Forbidden" }]);
});

test("15. an athlete with a live assignment is a member of the club for its admin, and sees its own account in club_view", async () => {
  const p = await person("athleteMember", (id) => F.makeAthlete(id));
  await grant(w.adminA, p.id, w.roleA.id, "team", w.TA1);
  await setPref(w.adminA, "club", w.A);
  assert.ok(ok(await org(w.adminA)).users.some((u) => u.id === p.id));
  const q = await person("athleteViewer", (id) => F.makeAthlete(id));
  await grant(w.adminA, q.id, w.roleA.id, "club", w.A);
  await setPref(q, "club", w.A);
  const body = ok(await org(q));
  assert.equal(body.activeWorkspace.type, "club_view");
  assert.deepEqual(body.users.map((u) => u.id), [q.id]);
});

test("16. L-1: a club's admin holding an assignment in its own club is not also offered club_view; L-2: an inactive club is not offered as club_view; L-3: an athlete with an assignment lands in the athlete workspace", async () => {
  // L-1
  const extra = await grant(w.pa, w.adminA.id, w.roleA.id, "club", w.A);
  const a = await me(w.adminA);
  assert.deepEqual(a.availableWorkspaces.filter((x) => x.scopeId === w.A).map((x) => x.type), ["club"]);
  await revoke(w.pa, extra);
  // L-2
  const C = await F.club("Gamma");
  const adminC = await person("adminC", (id) => F.grantClub(id, C));
  const p = await person("gammaViewer");
  const roleC = await createRole(adminC, C, ["club"]);
  await grant(adminC, p.id, roleC.id, "club", C);
  assert.deepEqual((await me(p)).availableWorkspaces.map((x) => [x.type, x.scopeId]), [["club_view", C]]);
  await k.query(`update public.clubs set is_active = false where id = $1`, [C]);
  const gone = await me(p);
  assert.deepEqual(gone.availableWorkspaces, []);
  assert.equal(gone.activeWorkspace, null);
  // L-3: no preference -> athlete; club_view is still offered and reachable through the switch.
  const q = await person("athleteFirst", (id) => F.makeAthlete(id));
  await grant(w.adminA, q.id, w.roleA.id, "club", w.A);
  const u = await me(q);
  assert.equal(u.activeWorkspace.type, "athlete");
  assert.deepEqual(u.availableWorkspaces.map((x) => x.type).sort(), ["athlete", "club_view"]);
  assert.deepEqual(await pref(q), { workspace_type: "athlete", scope_id: null });
  ok(await srv.api(q.cookie, "/api/auth/workspace", { method: "PUT", body: { type: "club_view", scopeId: w.A } }));
  assert.equal((await me(q)).activeWorkspace.type, "club_view");
});

test("13. filterOrganizationDataForWorkspace fails closed: an unknown workspace type shows nothing", async () => {
  const { filterOrganizationDataForWorkspace } = await import("../src/routes/organization.js");
  const data = { clubs: [{ id: w.A }], teams: [{ id: w.TA1, club_id: w.A }], athletes: [{ id: w.athA.id, memberships: [{ clubId: w.A }] }],
    users: [{ id: w.viewer.id }], accessRequests: [{ athlete_id: w.athA.id }] };
  for (const type of ["club_admin", "view", "CLUB", "", "club_viewer"]) {
    assert.deepEqual(filterOrganizationDataForWorkspace({ type, scopeId: w.A }, data, w.viewer.id),
      { clubs: [], teams: [], athletes: [], users: [], accessRequests: [] }, type);
  }
  const clubView = filterOrganizationDataForWorkspace({ type: "club_view", scopeId: w.A }, data, w.viewer.id);
  assert.deepEqual(clubView.clubs.map((c) => c.id), [w.A]);
});
