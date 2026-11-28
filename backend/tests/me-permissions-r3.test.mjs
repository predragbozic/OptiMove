// Roles R3 PR-A: GET /api/auth/me carries `permissions`, the words the account
// holds in its ACTIVE workspace, computed through can() over the same authz the
// routes use, and `permissionsUnavailable`. Real server, disposable database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { buildDatabase, fixtures, key, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
let db, k, F, srv, P, A;

before(async () => {
  db = await buildDatabase({ label: "me_perm_r3", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  P = await import("../src/permissions.js");
  A = await import("../src/authz.js");
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const hex = () => crypto.randomBytes(3).toString("hex");
const sorted = (list) => [...list].sort();
// Roles V-1: variables.view and presets.use are checked words, held by both basic roles (v92's seed); roles V-2 adds
// athletes.view, roles V-3 calendar.view, roles V-4 tests.view and tests.results.view.
// Calendar M-1 adds event management to both basic roles and Settings management to Club admin.
const CLUB_ADMIN = ["athletes.manage", "athletes.remove", "athletes.view", "calendar.events.manage", "calendar.settings.manage", "calendar.view", "dashboards.manage", "dashboards.view", "exercises.add", "exercises.remove", "exercises.use", "load.activities.manage", "load.estimates.manage", "load.roster.decide", "load.schedule.manage", "load.view.athlete", "load.view.team", "mappings.manage", "org.club.edit", "org.teams.manage", "org.view", "presets.use", "programs.assign", "programs.edit", "programs.publish", "programs.rpe_settings", "programs.view", "roles.manage", "staff.assign", "tests.results.view", "tests.schedule.manage", "tests.view", "variables.manage", "variables.rename_archive", "variables.view"];
const TEAM_COACH = ["athletes.manage", "athletes.remove", "athletes.view", "calendar.events.manage", "calendar.view", "dashboards.manage", "dashboards.view", "exercises.add", "exercises.remove", "exercises.use", "load.activities.manage", "load.estimates.manage", "load.roster.decide", "load.schedule.manage", "load.view.athlete", "load.view.team", "org.view", "presets.use", "programs.assign", "programs.edit", "programs.publish", "programs.rpe_settings", "programs.view", "tests.results.view", "tests.schedule.manage", "tests.view", "variables.rename_archive", "variables.view"];


async function person(label, setup = async () => {}) {
  const id = await F.user(label);
  await setup(id);
  return { id, cookie: await srv.cookieFor(id) };
}
const me = async (who) => ok(await srv.api(who.cookie, "/api/auth/me")).user;
async function inWorkspace(who, type, scopeId = null) {
  ok(await srv.api(who.cookie, "/api/auth/workspace", { method: "PUT", body: { type, scopeId } }));
  const user = await me(who);
  assert.equal(user.activeWorkspace?.type, type);
  return user;
}
const createRole = (who, body) => srv.api(who.cookie, R, { method: "POST", body: { requestKey: key(), scopeTypes: ["club", "team"], items: ["org.view"], name: `Role ${hex()}`, ...body } });
const grant = (who, body) => srv.api(who.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", ...body } });

let W;
async function world() {
  if (W) return W;
  const w = { A: await F.club("A"), B: await F.club("B") };
  w.T1 = await F.team(w.A, "T1"); w.TB = await F.team(w.B, "TB");
  w.pa = await person("pa", (id) => F.grantPlatform(id));
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.coach = await person("coach", (id) => F.grantTeam(id, w.T1));
  w.indep = await person("indep", (id) => F.grantIndependent(id));
  w.athlete = await person("athlete", (id) => F.makeAthlete(id));
  w.all = await person("all", async (id) => {
    await F.grantClub(id, w.B); await F.grantTeam(id, w.T1); await F.grantIndependent(id); await F.makeAthlete(id);
  });
  w.nobody = await person("nobody");
  W = w;
  return w;
}

test("1. each basic role x workspace type: club admin, team coach, independent coach, athlete; another club's team gives nothing", async () => {
  const w = await world();
  const club = await inWorkspace(w.adminA, "club", w.A);
  assert.deepEqual(sorted(club.permissions), CLUB_ADMIN);
  assert.equal(club.permissionsUnavailable, false);
  const team = await inWorkspace(w.coach, "team", w.T1);
  assert.deepEqual(sorted(team.permissions), TEAM_COACH);
  assert.deepEqual((await inWorkspace(w.indep, "private_coach")).permissions, []);
  assert.deepEqual((await inWorkspace(w.athlete, "athlete")).permissions, []);
  const nobody = await me(w.nobody);
  assert.equal(nobody.activeWorkspace, null);
  assert.deepEqual(nobody.permissions, []);
  assert.equal(nobody.permissionsUnavailable, false);
  // One account, four workspaces: the words follow the active one only.
  assert.deepEqual(sorted((await inWorkspace(w.all, "club", w.B)).permissions), CLUB_ADMIN);
  assert.deepEqual(sorted((await inWorkspace(w.all, "team", w.T1)).permissions), TEAM_COACH);
  assert.deepEqual((await inWorkspace(w.all, "private_coach")).permissions, []);
  assert.deepEqual((await inWorkspace(w.all, "athlete")).permissions, []);
});

test("2. a platform admin: every catalog word in the platform workspace (as can() at global scope)", async () => {
  const w = await world();
  const user = await inWorkspace(w.pa, "platform");
  assert.deepEqual(sorted(user.permissions), sorted(Object.keys(P.PERMISSIONS)));
  assert.equal(user.permissionsUnavailable, false);
});

test("3. the other /me fields are unchanged in shape; a signed-out caller still gets { user: null }", async () => {
  const w = await world();
  const user = await inWorkspace(w.adminA, "club", w.A);
  for (const field of ["id", "activeWorkspace", "availableWorkspaces", "capabilities", "clubs", "contentLanguage", "teams"]) {
    assert.ok(Object.hasOwn(user, field), field);
  }
  assert.ok(Array.isArray(user.permissions));
  assert.equal(typeof user.permissionsUnavailable, "boolean");
  assert.deepEqual(user.capabilities, { coachWorkspace: true, athleteWorkspace: false, organizationManagement: true, platformAdministration: false, canCreateAthlete: true, canCreatePlan: true });
  const anon = await srv.api(null, "/api/auth/me");
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.body, { user: null });
});

test("4. a non-basic assignment: its words appear where can() grants them; an account holding ONLY a non-basic role lands in its club's club_view workspace (R4-2, O8 (a)) with exactly those words", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A, scopeTypes: ["club"], items: ["org.teams.manage"] })).role;
  const coach2 = await person("coach2", (id) => F.grantTeam(id, w.T1));
  ok(await grant(w.adminA, { userId: coach2.id, roleId: role.id, scopeType: "club", scopeId: w.A }));
  // A club's word holds at its teams (can() convention 2).
  assert.deepEqual(sorted((await inWorkspace(coach2, "team", w.T1)).permissions), sorted([...TEAM_COACH, "org.teams.manage"]));
  const only = await person("onlyNonBasic");
  ok(await grant(w.adminA, { userId: only.id, roleId: role.id, scopeType: "club", scopeId: w.A }));
  const onlyMe = await me(only);
  // Before roles R4-2 this account had no workspace at all (requireCoach gated it); since R4-2 its way in is the
  // club_view type, which the six workspace-authorizing modules do not recognize (contract section 6).
  assert.deepEqual([onlyMe.activeWorkspace?.type, onlyMe.activeWorkspace?.scopeId], ["club_view", w.A]);
  assert.deepEqual(onlyMe.availableWorkspaces.map((x) => x.type), ["club_view"]);
  // A view workspace lists only the words its routes let through (VIEW_WORKSPACE_USABLE_WORDS: org.view in R4-2), so
  // the held org.teams.manage is not offered there: POST /api/organization/teams answers it 403.
  assert.deepEqual(onlyMe.permissions, []);
});

test("5. an expired assignment, an archived role and a revoked assignment give nothing", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A, scopeTypes: ["club"], items: ["org.teams.manage"] })).role;
  const expired = await person("expired", (id) => F.grantTeam(id, w.T1));
  const expiring = ok(await grant(w.adminA, { userId: expired.id, roleId: role.id, scopeType: "club", scopeId: w.A, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).assignment;
  assert.ok((await inWorkspace(expired, "team", w.T1)).permissions.includes("org.teams.manage"));
  // The expiry moved into the past by a raw write past the guards (disposable
  // database only), so the proof does not depend on the runner's speed.
  await k.query(`begin`);
  try {
    await k.query(`set local session_replication_role = replica`);
    await k.query(`update public.user_role_assignments set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' where id = $1`, [expiring.id]);
    await k.query(`commit`);
  } catch (error) {
    await k.query(`rollback`);
    throw error;
  }
  assert.deepEqual(sorted((await me(expired)).permissions), TEAM_COACH);

  const revoked = await person("revoked", (id) => F.grantTeam(id, w.T1));
  const assignment = ok(await grant(w.adminA, { userId: revoked.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  assert.ok((await inWorkspace(revoked, "team", w.T1)).permissions.includes("org.teams.manage"));
  ok(await srv.api(w.adminA.cookie, `${R}/assignments/${assignment.id}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected: { userId: revoked.id, roleId: role.id, scopeType: "club", scopeId: w.A } } }));
  assert.deepEqual(sorted((await me(revoked)).permissions), TEAM_COACH);

  const archivedRole = ok(await createRole(w.adminA, { clubId: w.A, scopeTypes: ["club"], items: ["org.teams.manage"] })).role;
  const held = await person("held", (id) => F.grantTeam(id, w.T1));
  ok(await grant(w.adminA, { userId: held.id, roleId: archivedRole.id, scopeType: "club", scopeId: w.A }));
  assert.ok((await inWorkspace(held, "team", w.T1)).permissions.includes("org.teams.manage"));
  // The API refuses to archive an assigned role; a raw write past the guards
  // (disposable database only) proves the loader gives an archived role nothing.
  const refused = await srv.api(w.adminA.cookie, `${R}/${archivedRole.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: archivedRole.revision ?? 1, reason: "Done" } });
  assert.equal(refused.status, 409, refused.text);
  await k.query(`begin`);
  try {
    await k.query(`set local session_replication_role = replica`);
    await k.query(`update public.permission_roles set archived_at = now(), archived_by_user_id = $2 where id = $1`, [archivedRole.id, w.adminA.id]);
    await k.query(`commit`);
  } catch (error) {
    await k.query(`rollback`);
    throw error;
  }
  assert.deepEqual(sorted((await me(held)).permissions), TEAM_COACH);

  // A deactivated old-table role: the workspace and the words go with it.
  const gone = await person("gone", (id) => F.grantClub(id, w.A));
  assert.deepEqual(sorted((await inWorkspace(gone, "club", w.A)).permissions), CLUB_ADMIN);
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [gone.id]);
  const after = await me(gone);
  assert.equal(after.activeWorkspace, null);
  assert.deepEqual(after.permissions, []);
});

test("6. role tables unreadable: permissions [] with permissionsUnavailable true for everyone (a platform admin too), never a 500, never extra words; readable again, the words return", async () => {
  const w = await world();
  await inWorkspace(w.adminA, "club", w.A);
  await inWorkspace(w.pa, "platform");
  await k.query(`alter table public.permission_role_items rename to permission_role_items_hidden`);
  try {
    for (const who of [w.adminA, w.pa]) {
      const res = await srv.api(who.cookie, "/api/auth/me");
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.body.user.permissions, []);
      assert.equal(res.body.user.permissionsUnavailable, true);
      assert.ok(res.body.user.activeWorkspace, "the rest of /me still answers");
    }
  } finally {
    await k.query(`alter table public.permission_role_items_hidden rename to permission_role_items`);
  }
  const back = await me(w.adminA);
  assert.deepEqual(sorted(back.permissions), CLUB_ADMIN);
  assert.equal(back.permissionsUnavailable, false);
});

test("7. equality: for every account, each of its workspaces and every catalog word, `word in permissions` === can(authz, word, the workspace's scope)", async () => {
  const w = await world();
  const scopeOf = (ws, userId) => ({
    platform: P.GLOBAL_SCOPE, club: P.clubScope(ws.scopeId), team: P.teamScope(ws.scopeId), private_coach: P.privateScope(userId),
  })[ws.type];
  let cells = 0;
  for (const who of [w.pa, w.adminA, w.coach, w.indep, w.athlete, w.all]) {
    const row = (await k.query(`select * from public.users where id = $1`, [who.id])).rows[0];
    for (const ws of (await me(who)).availableWorkspaces) {
      const user = await inWorkspace(who, ws.type, ws.scopeId);
      const authz = await A.loadAuthorizationContext(row);
      const scope = scopeOf(ws, who.id);
      for (const word of Object.keys(P.PERMISSIONS)) {
        // Since v92 (R4-1) a non-admin's role also holds unchecked VIEW words; /me offers only checked words (its
        // candidates are HONOURED_PERMISSIONS, contract 5.1), so an unchecked word is never in the list.
        const offered = authz.platformRoles.length > 0 || P.HONOURED_PERMISSIONS.includes(word);
        const expected = scope && offered ? P.can(authz, word, scope) : false;
        assert.equal(user.permissions.includes(word), expected, `${ws.type} ${word}`);
        cells += 1;
      }
      assert.equal(new Set(user.permissions).size, user.permissions.length, "no duplicates");
    }
  }
  assert.ok(cells >= Object.keys(P.PERMISSIONS).length * 9, String(cells));
});

test("8. permissionsForWorkspace (pure): a forged platform workspace for a non-admin, an unknown type, no workspace, an athlete workspace give nothing; a non-admin is never offered an unhonoured word even if a role carried one", () => {
  const base = { userId: "u", platformRoles: [], rolePermissions: [] };
  assert.deepEqual(P.permissionsForWorkspace(base, { type: "platform", scopeId: null }), { permissions: [], unavailable: false });
  assert.deepEqual(P.permissionsForWorkspace(base, { type: "galaxy", scopeId: "x" }), { permissions: [], unavailable: false });
  assert.deepEqual(P.permissionsForWorkspace(base, null), { permissions: [], unavailable: false });
  const clubId = crypto.randomUUID();
  const forged = { ...base, rolePermissions: [{ scopeType: "club", scopeId: clubId, teamIds: [], words: ["org.view", "import.check"] }] }; // a word outside the checked catalog
  assert.deepEqual(P.permissionsForWorkspace(forged, { type: "athlete", scopeId: null }).permissions, []);
  assert.deepEqual(P.permissionsForWorkspace(forged, { type: "club", scopeId: clubId }).permissions, ["org.view"]);
  const privateForged = { ...base, rolePermissions: [{ scopeType: "private", scopeId: "u", teamIds: [], words: ["org.view"] }] };
  assert.deepEqual(P.permissionsForWorkspace(privateForged, { type: "private_coach", scopeId: null }).permissions, []);
  assert.deepEqual(P.permissionsForWorkspace({ ...base, rolePermissions: { unavailable: true } }, { type: "club", scopeId: clubId }), { permissions: [], unavailable: true });
});
