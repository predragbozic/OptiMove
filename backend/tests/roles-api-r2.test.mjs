// Roles R2: the Roles API through the real server on a disposable database
// (docs/ai/roles-r2-contract.md section 8: tests 17-24, 28-30, 35).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildDatabase, fixtures, key, rankedId, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
let db, k, F, srv, svc;
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await buildDatabase({ label: "roles_api", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  for (const level of ["log", "info", "warn", "error"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => { logLines.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.code ?? ""} ${a.message}` : JSON.stringify(a))).join(" ")); };
  }
  srv = await startServer(db.url);
  svc = await import("../src/permissionRolesService.js");
});
afterEach(() => {
  svc?.setRolesCommitForTests();
  svc?.setRolesBeforeLocksHoldForTests(null);
  svc?.setRolesAfterBeginHoldForTests(null);
  svc?.setRolesWriteHoldForTests(null);
  svc?.setRolesStatementRecorderForTests(null);
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const code = (res, status, error) => { assert.equal(res.status, status, res.text); assert.equal(res.body.error, error, res.text); return res.body; };
const hex = () => crypto.randomBytes(3).toString("hex");
function gate() { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; }
async function waiting(n = 1, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await one(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`fewer than ${n} backend(s) wait on a lock`);
}
const noDeadlock = () => assert.ok(!logLines.some((l) => /deadlock|40P01/i.test(l)), logLines.filter((l) => /deadlock|40P01/i.test(l)).join(" | "));

// A world: a club A (two teams) and a club B, their admins, coaches, a platform admin.
async function world() {
  const w = { A: await F.club("A"), B: await F.club("B") };
  w.T1 = await F.team(w.A, "T1"); w.T2 = await F.team(w.A, "T2"); w.TB = await F.team(w.B, "TB");
  const person = async (label, setup = async () => {}) => { const id = await F.user(label); await setup(id); return { id, cookie: await srv.cookieFor(id) }; };
  w.pa = await person("pa", (id) => F.grantPlatform(id));
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.adminAB = await person("adminAB", async (id) => { await F.grantClub(id, w.A); await F.grantClub(id, w.B); });
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.coachA = await person("coachA", (id) => F.grantTeam(id, w.T1));
  w.indep = await person("indep", (id) => F.grantIndependent(id));
  w.athlete = await person("athlete", (id) => F.makeAthlete(id));
  w.nobody = await person("nobody");
  w.target = await person("target");
  return w;
}
const createRole = (who, body) => srv.api(who.cookie, R, { method: "POST", body: { requestKey: key(), scopeTypes: ["club", "team"], items: ["org.view"], name: `Role ${hex()}`, ...body } });
const change = (who, roleId, body) => srv.api(who.cookie, `${R}/${roleId}/change`, { method: "POST", body: { requestKey: key(), reason: "Change", ...body } });
const archive = (who, roleId, expectedRevision) => srv.api(who.cookie, `${R}/${roleId}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision, reason: "Done" } });
const grant = (who, body) => srv.api(who.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", ...body } });
const revoke = (who, assignmentId, expected) => srv.api(who.cookie, `${R}/assignments/${assignmentId}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected } });
const revision = async (roleId) => (await one(`select revision from public.permission_roles where id = $1`, [roleId])).revision;
async function clubAdminItems(pa, items) {
  const rev = await revision(ROLE_IDS.club_admin);
  return ok(await change(pa, ROLE_IDS.club_admin, { expectedRevision: rev, items }));
}
const CLUB_ADMIN_SEED = ["athletes.manage", "athletes.remove", "org.club.edit", "org.teams.manage", "org.view", "roles.manage", "staff.assign"];

// ---------------------------------------------------------------------------
// Ceiling and dominance
// ---------------------------------------------------------------------------
test("17. ceiling: a club's admin adds a word it does not hold, a platform-only word, a non-delegable word; a platform admin adds an unhonoured word to a basic role, removes athletes.remove from Team coach (the change record and the affected counts) and puts it back", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  code(await change(w.adminA, role.id, { expectedRevision: 1, items: ["org.view", "platform.admin"] }), 409, "permission_platform_only");
  for (const word of ["staff.assign", "roles.manage", "accounts.manage"]) {
    code(await change(w.adminA, role.id, { expectedRevision: 1, items: ["org.view", word] }), 409, "permission_not_delegable");
  }
  code(await change(w.adminA, role.id, { expectedRevision: 1, items: ["org.view", "programs.view"] }), 409, "permission_not_honoured");
  // The platform admin takes org.club.edit out of Club admin: the club's admin no longer holds it.
  await clubAdminItems(w.pa, CLUB_ADMIN_SEED.filter((x) => x !== "org.club.edit"));
  try {
    const refused = code(await change(w.adminA, role.id, { expectedRevision: 1, scopeTypes: ["club"], items: ["org.view", "org.club.edit"] }), 409, "permission_not_held");
    assert.deepEqual(refused.words, ["org.club.edit"]);
  } finally {
    await clubAdminItems(w.pa, CLUB_ADMIN_SEED);
  }
  code(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), items: ["org.view", "athletes.manage", "athletes.remove", "programs.view"] }), 409, "permission_not_honoured");
  // A club's own role holding athletes.remove, held by one person: the narrowing does not reach it (S4).
  const own = ok(await createRole(w.adminA, { clubId: w.A, items: ["athletes.remove"] })).role;
  ok(await grant(w.adminA, { userId: w.target.id, roleId: own.id, scopeType: "club", scopeId: w.A }));
  const expected = await one(`select count(distinct r.id)::int as roles, count(distinct r.owner_club_id)::int as clubs,
      count(distinct a.user_id) filter (where a.id is not null)::int as people
    from public.permission_roles r join public.permission_role_items i on i.role_id = r.id and i.permission_word = 'athletes.remove'
    left join public.user_role_assignments a on a.role_id = r.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
    where r.owner_scope = 'club' and r.archived_at is null`);
  assert.ok(expected.roles >= 1 && expected.people >= 1);
  const rev = await revision(ROLE_IDS.team_coach);
  const removed = ok(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: rev, items: ["org.view", "athletes.manage"] }));
  assert.deepEqual(removed.role.items, ["athletes.manage", "org.view"]);
  assert.ok(removed.affected.people >= 1 && removed.affected.clubs >= 1, JSON.stringify(removed.affected));
  assert.deepEqual(removed.affected.clubRolesKeepingRemovedWords, expected);
  assert.deepEqual((await one(`select array_agg(permission_word) as w from public.permission_role_items where role_id = $1`, [own.id])).w, ["athletes.remove"], "the club's own role keeps the word");
  const record = await one(`select kind, basis, items_removed, reason from public.permission_role_changes where role_id = $1 and revision_after = $2`, [ROLE_IDS.team_coach, rev + 1]);
  assert.deepEqual(record, { kind: "change", basis: "platform_admin", items_removed: ["athletes.remove"], reason: "Change" });
  ok(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: rev + 1, items: ["org.view", "athletes.manage", "athletes.remove"] }));
});

test("17-honoured. HONOURED_PERMISSIONS equals the (word, scope type) pairs of organization.js's can() calls at a club or team scope, plus roles.manage; a word checked only at a global site is not in it", async () => {
  const { HONOURED_PERMISSIONS } = await import("../src/permissions.js");
  const source = fs.readFileSync(path.join(REPO, "backend/src/routes/organization.js"), "utf8");
  const pairs = [...source.matchAll(/can\(\s*req\.authz\s*,\s*"([^"]+)"\s*,\s*(clubScope|teamScope|GLOBAL_SCOPE)/g)].map((m) => [m[1], m[2]]);
  const honoured = new Set(pairs.filter(([, s]) => s !== "GLOBAL_SCOPE").map(([w]) => w));
  honoured.add("roles.manage");
  assert.deepEqual([...HONOURED_PERMISSIONS].sort(), [...honoured].sort());
  assert.ok(pairs.some(([w, s]) => w === "accounts.manage" && s === "GLOBAL_SCOPE"));
  assert.ok(!HONOURED_PERMISSIONS.includes("accounts.manage"));
});

test("17a. the 51st role of a club is refused (role_limit_reached); an archived role does not count", async () => {
  const w = await world();
  await k.query(`set session_replication_role = replica`);
  for (let i = 0; i < 50; i += 1) {
    await k.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, created_by_user_id) values ('club', $1, $2, true, $3)`, [w.A, `Bulk ${i} ${hex()}`, w.adminA.id]);
  }
  await k.query(`reset session_replication_role`);
  code(await createRole(w.adminA, { clubId: w.A }), 409, "role_limit_reached");
  await k.query(`set session_replication_role = replica`);
  await k.query(`update public.permission_roles set archived_at = now(), archived_by_user_id = $2 where id = (select id from public.permission_roles where owner_club_id = $1 limit 1)`, [w.A, w.adminA.id]);
  await k.query(`reset session_replication_role`);
  ok(await createRole(w.adminA, { clubId: w.A }));
});

test("18. dominance: a club's admin edits, archives and assigns a role holding a word it lacks (role_exceeds_your_permissions) and still revokes an assignment of it; revokes an assignment of its own; an admin of another club and a team's coach get 404", async () => {
  const w = await world();
  const role = ok(await createRole(w.pa, { clubId: w.A, scopeTypes: ["club"], items: ["org.view", "org.club.edit"] })).role;
  const assigned = ok(await grant(w.pa, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  const viewer = ok(await createRole(w.pa, { clubId: w.A, scopeTypes: ["club"], items: ["org.view"] })).role;
  const own = ok(await grant(w.pa, { userId: w.adminA.id, roleId: viewer.id, scopeType: "club", scopeId: w.A })).assignment;
  await clubAdminItems(w.pa, CLUB_ADMIN_SEED.filter((x) => x !== "org.club.edit"));
  try {
    code(await change(w.adminA, role.id, { expectedRevision: 1, name: `Renamed ${hex()}` }), 409, "role_exceeds_your_permissions");
    code(await archive(w.adminA, role.id, 1), 409, "role_exceeds_your_permissions");
    code(await grant(w.adminA, { userId: w.nobody.id, roleId: role.id, scopeType: "club", scopeId: w.A }), 409, "role_exceeds_your_permissions");
    code(await revoke(w.adminB, assigned.id, { userId: w.target.id, roleId: role.id }), 404, "notFound");
    code(await revoke(w.coachA, assigned.id, { userId: w.target.id, roleId: role.id }), 404, "notFound");
    ok(await revoke(w.adminA, assigned.id, { userId: w.target.id, roleId: role.id }));
    ok(await revoke(w.adminA, own.id, { userId: w.adminA.id, roleId: viewer.id }));
  } finally {
    await clubAdminItems(w.pa, CLUB_ADMIN_SEED);
  }
});

test("18a. (mandatory) no role but Club admin can be given staff.assign - by the service (a club's role, a system role, Team coach) - so the old grant and revoke routes pass for nobody new; the direct-SQL refusal is test 11 of permission-roles-v84", async () => {
  const w = await world();
  code(await createRole(w.adminA, { clubId: w.A, scopeTypes: ["club"], items: ["org.view", "staff.assign"] }), 409, "permission_not_delegable");
  code(await createRole(w.pa, { scopeTypes: ["club"], items: ["staff.assign"] }), 409, "permission_not_delegable");
  code(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), items: ["org.view", "staff.assign"] }), 409, "permission_not_delegable");
  const holders = await one(`select count(*)::int as n from public.permission_role_items where permission_word = 'staff.assign'`);
  assert.equal(holders.n, 1, "only the Club admin role holds staff.assign");
});

test("19. losing the word mid-request: the admin's club role is revoked between the route's check and the locks; the write answers 404 and writes nothing", async () => {
  const w = await world();
  const second = await F.user("adminA2"); await F.grantClub(second, w.A);
  const g = gate(); let entered = false;
  svc.setRolesBeforeLocksHoldForTests(async () => { entered = true; await g.promise; });
  const pending = createRole(w.adminA, { clubId: w.A, name: "Mid request" });
  const start = Date.now();
  while (!entered && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(entered);
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]);
  g.open();
  code(await pending, 404, "notFound");
  assert.equal((await one(`select count(*)::int as n from public.permission_roles where name = 'Mid request'`)).n, 0);
});

test("18b. revoke with a wrong expected pair (another user, another role): 409 assignment_mismatch, the assignment stays active and no request or change row is written", async () => {
  const w = await world();
  const role = ok(await createRole(w.pa, { clubId: w.A, scopeTypes: ["club"], items: ["org.view"] })).role;
  const other = ok(await createRole(w.pa, { clubId: w.A, scopeTypes: ["club"], items: ["org.view"] })).role;
  const a = ok(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  const counts = async () => one(`select (select count(*)::int from public.permission_requests) as requests, (select count(*)::int from public.permission_role_changes) as changes`);
  const before = await counts();
  code(await revoke(w.adminA, a.id, { userId: w.nobody.id, roleId: role.id }), 409, "assignment_mismatch");
  code(await revoke(w.adminA, a.id, { userId: w.target.id, roleId: other.id }), 409, "assignment_mismatch");
  assert.deepEqual(await counts(), before, "nothing written");
  assert.equal((await one(`select revoked_at from public.user_role_assignments where id = $1`, [a.id])).revoked_at, null, "still active");
  ok(await revoke(w.adminA, a.id, { userId: w.target.id, roleId: role.id }));
});

test("19c. a revocation whose caller loses the right between the route's gate and the locks (the admin's club role is revoked, then the club is archived): the identical 404 and nothing written", async () => {
  const w = await world();
  const role = ok(await createRole(w.pa, { clubId: w.A, scopeTypes: ["club"], items: ["org.view"] })).role;
  const a = ok(await grant(w.pa, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  const counts = async () => one(`select (select count(*)::int from public.permission_requests) as requests, (select count(*)::int from public.permission_role_changes) as changes`);
  const before = await counts();
  const hold = async (lose, restore) => {
    const g = gate(); let entered = false;
    let pending;
    try {
      svc.setRolesBeforeLocksHoldForTests(async () => { entered = true; await g.promise; });
      pending = revoke(w.adminA, a.id, { userId: w.target.id, roleId: role.id });
      const start = Date.now();
      while (!entered && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(entered);
      await lose();
      g.open();
      return await pending;
    } finally {
      g.open();
      svc.setRolesBeforeLocksHoldForTests(null);
      if (pending) await pending.catch(() => {});
      await restore();
    }
  };
  // Case 1: lock_permission_actor finds no basis (the club role is inactive): `!basis` in revokeAssignment's prepare.
  // Case 2: an archived club does not change the lock's basis (lock_permission_actor does not read clubs.is_active),
  // so only `!(await staffStanding(ctx)(client, clubId))` in the same prepare stops it (standingFor of runWrite runs on replays only).
  code(await hold(
    () => k.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]),
    () => k.query(`update public.user_club_roles set is_active = true where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]),
  ), 404, "notFound");
  code(await hold(
    () => k.query(`update public.clubs set is_active = false where id = $1`, [w.A]),
    () => k.query(`update public.clubs set is_active = true where id = $1`, [w.A]),
  ), 404, "notFound");
  assert.deepEqual(await counts(), before, "nothing written");
  assert.equal((await one(`select revoked_at from public.user_role_assignments where id = $1`, [a.id])).revoked_at, null, "still active");
});

test("19b. losing roles.manage alone mid-request (staff.assign kept, so the lock's basis still holds): P4 and P7 re-check roles.manage under the locks, answer 404 and write nothing (a latent case: rule 7 keeps roles.manage on Club admin, so the item is removed past the guards and put back)", async () => {
  const w = await world();
  const hold = async (send) => {
    const g = gate(); let entered = false;
    svc.setRolesBeforeLocksHoldForTests(async () => { entered = true; await g.promise; });
    const pending = send();
    const start = Date.now();
    while (!entered && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(entered);
    await k.query(`set session_replication_role = replica`);
    await k.query(`delete from public.permission_role_items where role_id = $1 and permission_word = 'roles.manage'`, [ROLE_IDS.club_admin]);
    await k.query(`reset session_replication_role`);
    g.open();
    try {
      return await pending;
    } finally {
      svc.setRolesBeforeLocksHoldForTests(null);
      await k.query(`set session_replication_role = replica`);
      await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, 'roles.manage')`, [ROLE_IDS.club_admin]);
      await k.query(`reset session_replication_role`);
    }
  };
  const name = `Mid ${hex()}`;
  code(await hold(() => createRole(w.adminA, { clubId: w.A, name })), 404, "notFound");
  code(await hold(() => srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `${name} c` } })), 404, "notFound");
  assert.equal((await one(`select count(*)::int as n from public.permission_roles where name like $1`, [`${name}%`])).n, 0);
  ok(await createRole(w.adminA, { clubId: w.A, name }));
});

test("20. self-assignment (a platform admin too); a basic role; a global scope; a role of club A at club B or a team of B; P6 role_has_assignments for a platform admin too", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  code(await grant(w.adminA, { userId: w.adminA.id, roleId: role.id, scopeType: "club", scopeId: w.A }), 409, "self_assignment");
  code(await grant(w.pa, { userId: w.pa.id, roleId: role.id, scopeType: "club", scopeId: w.A }), 409, "self_assignment");
  code(await grant(w.adminA, { userId: w.target.id, roleId: ROLE_IDS.club_admin, scopeType: "club", scopeId: w.A }), 409, "role_not_assignable_here");
  code(await grant(w.pa, { userId: w.target.id, roleId: role.id, scopeType: "global" }), 409, "role_not_assignable_here");
  code(await grant(w.adminAB, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.B }), 404, "notFound");
  code(await grant(w.adminAB, { userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.TB }), 404, "notFound");
  ok(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.T1 }));
  const refused = code(await archive(w.pa, role.id, 1), 409, "role_has_assignments");
  assert.equal(refused.count, 1);
});

test("21. narrowing Club admin below a system role is refused (rule 7)", async () => {
  const w = await world();
  const refused = code(await change(w.pa, ROLE_IDS.club_admin, { expectedRevision: await revision(ROLE_IDS.club_admin), items: CLUB_ADMIN_SEED.filter((x) => x !== "athletes.manage") }), 409, "club_admin_requires");
  assert.deepEqual(refused.words, ["athletes.manage"]);
  code(await change(w.pa, ROLE_IDS.club_admin, { expectedRevision: await revision(ROLE_IDS.club_admin), items: CLUB_ADMIN_SEED.filter((x) => x !== "roles.manage") }), 409, "club_admin_requires");
});

test("21b. a basic role's scope types are fixed: P5 with other scope types is 409 role_not_editable; the same types in any order pass with a name change", async () => {
  const w = await world();
  code(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), scopeTypes: ["club", "team"] }), 409, "role_not_editable");
  code(await change(w.pa, ROLE_IDS.club_admin, { expectedRevision: await revision(ROLE_IDS.club_admin), scopeTypes: ["team"] }), 409, "role_not_editable");
  const name = (await one(`select name from public.permission_roles where id = $1`, [ROLE_IDS.team_coach])).name;
  ok(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), scopeTypes: ["team"], name: `${name} 2` }));
  ok(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), name }));
});

// ---------------------------------------------------------------------------
// Cross-club and info hiding
// ---------------------------------------------------------------------------
test("22. the actors x routes matrix: every cell not allowed is the identical 404 (never 403), also for another club's role and assignment ids and random ids; an unknown path or method answers the same 404", async () => {
  const w = await world();
  const archivedClub = await F.club("Archived");
  const archivedAdmin = { id: await F.user("archivedAdmin") };
  await F.grantClub(archivedAdmin.id, archivedClub);
  await k.query(`update public.clubs set is_active = false where id = $1`, [archivedClub]);
  archivedAdmin.cookie = await srv.cookieFor(archivedAdmin.id);
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const assignment = ok(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  const roleB = ok(await createRole(w.adminB, { clubId: w.B })).role;
  const routes = (r, a) => [
    ["GET", `${R}/catalog?clubId=${w.A}`],
    ["GET", `${R}?clubId=${w.A}`],
    ["GET", `${R}/${r}`],
    ["POST", R, { requestKey: key(), clubId: w.A, name: `M ${hex()}`, scopeTypes: ["club"], items: ["org.view"] }],
    ["POST", `${R}/${r}/change`, { requestKey: key(), expectedRevision: 99, reason: "x", name: `N ${hex()}` }],
    ["POST", `${R}/${r}/archive`, { requestKey: key(), expectedRevision: 99, reason: "x" }],
    ["POST", `${R}/${ROLE_IDS.team_coach}/copy`, { requestKey: key(), clubId: w.A }],
    ["GET", `${R}/assignments?clubId=${w.A}`],
    ["POST", `${R}/assignments`, { requestKey: key(), userId: w.nobody.id, roleId: r, scopeType: "club", scopeId: w.A, reason: "x" }],
    ["POST", `${R}/assignments/${a}/revoke`, { requestKey: key(), reason: "x", expected: { userId: w.target.id, roleId: r } }],
  ];
  const outsiders = { "admin of B": w.adminB, "coach of a team of A": w.coachA, "independent coach": w.indep, athlete: w.athlete, "no role": w.nobody, "admin of an archived club": archivedAdmin };
  for (const [name, who] of Object.entries(outsiders)) {
    for (const [method, p, body] of routes(role.id, assignment.id)) {
      const res = await srv.api(who.cookie, p, { method, body });
      assert.equal(res.status, 404, `${name}: ${method} ${p} -> ${res.status} ${res.text}`);
      assert.deepEqual(res.body, { error: "notFound" }, `${name}: ${method} ${p}`);
    }
  }
  // Another club's role and random ids, for the admin of A.
  for (const [method, p, body] of [...routes(roleB.id, crypto.randomUUID()).slice(2, 3), ["GET", `${R}/${crypto.randomUUID()}`], ["POST", `${R}/${roleB.id}/change`, { requestKey: key(), expectedRevision: 1, reason: "x", name: "y" }], ["POST", `${R}/assignments/${crypto.randomUUID()}/revoke`, { requestKey: key(), reason: "x", expected: { userId: w.target.id, roleId: role.id } }]]) {
    const res = await srv.api(w.adminA.cookie, p, { method, body });
    assert.deepEqual([res.status, res.body], [404, { error: "notFound" }], `${method} ${p}`);
  }
  // Allowed: the platform admin, the admin of A, the admin of A and B (reads).
  for (const who of [w.pa, w.adminA, w.adminAB]) {
    for (const p of [`${R}/catalog?clubId=${w.A}`, `${R}?clubId=${w.A}`, `${R}/${role.id}`, `${R}/assignments?clubId=${w.A}`]) assert.equal((await srv.api(who.cookie, p)).status, 200, p);
  }
  for (const who of [w.athlete, w.coachA, w.pa]) {
    for (const [method, p] of [["GET", `${R}/x/y/z`], ["PUT", `${R}/${role.id}`], ["DELETE", R], ["PATCH", `${R}/assignments`]]) {
      const res = await srv.api(who.cookie, p, { method });
      assert.deepEqual([res.status, res.body], [404, { error: "notFound" }], `${method} ${p}`);
    }
  }
  assert.equal((await srv.api(null, `${R}?clubId=${w.A}`)).status, 401, "no session: requireAuth");
});

test("22b. ADR-006 order: for every route that takes a role or assignment id, another club's id and a random id answer the identical 404 before any body-level 409 (self-assignment, a stale revision, a mismatched expected pair)", async () => {
  const w = await world();
  const roleB = ok(await createRole(w.adminB, { clubId: w.B })).role;
  const assignmentB = ok(await grant(w.adminB, { userId: w.nobody.id, roleId: roleB.id, scopeType: "club", scopeId: w.B })).assignment;
  const roleA = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const cases = (roleId, assignmentId) => [
    ["GET", `${R}/${roleId}?clubId=${w.A}`],
    ["POST", `${R}/${roleId}/change`, { requestKey: key(), clubId: w.A, expectedRevision: 99, reason: "x", name: `N ${hex()}` }],
    ["POST", `${R}/${roleId}/archive`, { requestKey: key(), clubId: w.A, expectedRevision: 99, reason: "x" }],
    ["POST", `${R}/${roleId}/copy`, { requestKey: key(), clubId: w.A }],
    // P9: self (409 self_assignment for a role of A), at the club and at a team of A.
    ["POST", `${R}/assignments`, { requestKey: key(), userId: w.adminA.id, roleId, scopeType: "club", scopeId: w.A, reason: "x" }],
    ["POST", `${R}/assignments`, { requestKey: key(), userId: w.adminA.id, roleId, scopeType: "team", scopeId: w.T1, reason: "x" }],
    ["POST", `${R}/assignments`, { requestKey: key(), userId: w.target.id, roleId, scopeType: "club", scopeId: w.A, reason: "x" }],
    // P10: an expected pair that does not match (409 assignment_mismatch for an assignment of A).
    ["POST", `${R}/assignments/${assignmentId}/revoke`, { requestKey: key(), reason: "x", expected: { userId: w.target.id, roleId: roleA.id } }],
  ];
  const foreign = cases(roleB.id, assignmentB.id);
  const random = cases(crypto.randomUUID(), crypto.randomUUID());
  for (let i = 0; i < foreign.length; i += 1) {
    const [method, p, body] = foreign[i];
    const a = await srv.api(w.adminA.cookie, p, { method, body });
    const [m2, p2, b2] = random[i];
    const b = await srv.api(w.adminA.cookie, p2, { method: m2, body: b2 });
    assert.deepEqual([a.status, a.body], [404, { error: "notFound" }], `another club's id: ${method} ${p}`);
    assert.deepEqual([b.status, b.body], [404, { error: "notFound" }], `a random id: ${m2} ${p2}`);
  }
  // The same bodies with club A's own ids reach the 409s (so the 404s above hide them).
  code(await grant(w.adminA, { userId: w.adminA.id, roleId: roleA.id, scopeType: "club", scopeId: w.A }), 409, "self_assignment");
  code(await change(w.adminA, roleA.id, { expectedRevision: 99, name: `N ${hex()}` }), 409, "staleRevision");
  // Nothing was written by the refused requests.
  assert.equal(Number((await one(`select count(*)::int as n from public.user_role_assignments where user_id = $1`, [w.adminA.id])).n), 0);
});

test("22c. P7 without a name: \"<source name> (copy)\"; a second copy without a name and a copy named like a current system role are 409 role_name_taken (O7); a long source name is cut to fit 80 characters", async () => {
  const w = await world();
  const copy = (body) => srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A, ...body } });
  const first = ok(await copy({}));
  assert.equal(first.role.name, "Team coach (copy)");
  code(await copy({}), 409, "role_name_taken");
  code(await copy({ name: "team coach" }), 409, "role_name_taken");
  ok(await copy({ name: `Own ${hex()}` }));
  const longName = `L${"x".repeat(78)}${hex().slice(0, 1)}`;
  assert.equal(longName.length, 80);
  const sys = ok(await createRole(w.pa, { name: longName, scopeTypes: ["club"], items: ["org.view"] })).role;
  const long = ok(await srv.api(w.adminA.cookie, `${R}/${sys.id}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A } }));
  assert.equal(long.role.name, `${longName.slice(0, 73)} (copy)`);
  assert.equal([...long.role.name].length, 80);
});

test("22d. P3's history of a SYSTEM role, read by a club's admin, carries only revision, kind, itemsAdded, itemsRemoved, at and byMigration (no reason, basis or name); a platform admin reads all of it; a club's own role keeps its full history for its admin", async () => {
  const w = await world();
  const sys = ok(await createRole(w.pa, { name: `System ${hex()}`, scopeTypes: ["club"], items: ["org.view"] })).role;
  ok(await change(w.pa, sys.id, { expectedRevision: 1, name: `Renamed ${hex()}`, items: ["org.view", "athletes.manage"], reason: "Platform secret reason" }));
  const clubView = ok(await srv.api(w.adminA.cookie, `${R}/${sys.id}?clubId=${w.A}`));
  assert.equal(clubView.history.length, 2);
  for (const h of clubView.history) assert.deepEqual(Object.keys(h).sort(), ["at", "byMigration", "itemsAdded", "itemsRemoved", "kind", "revision"]);
  assert.deepEqual(clubView.history[1].itemsAdded, ["athletes.manage"]);
  assert.ok(!JSON.stringify(clubView.history).includes("Platform secret reason"));
  const paView = ok(await srv.api(w.pa.cookie, `${R}/${sys.id}`));
  assert.equal(paView.history[1].reason, "Platform secret reason");
  assert.equal(paView.history[1].basis, "platform_admin");
  // A seeded basic role read by a club's admin: the same reduced shape.
  for (const h of ok(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.club_admin}?clubId=${w.A}`)).history) {
    assert.deepEqual(Object.keys(h).sort(), ["at", "byMigration", "itemsAdded", "itemsRemoved", "kind", "revision"]);
  }
  const own = ok(await createRole(w.adminA, { clubId: w.A })).role;
  ok(await change(w.adminA, own.id, { expectedRevision: 1, name: `Own ${hex()}`, reason: "Club reason" }));
  const ownView = ok(await srv.api(w.adminA.cookie, `${R}/${own.id}`));
  assert.equal(ownView.history[1].reason, "Club reason");
});

test("23. P2, P3 and P8 never return a role, a holder or a count of another club; holderCount for a club caller counts that club only", async () => {
  const w = await world();
  const sys = ok(await createRole(w.pa, { scopeTypes: ["club", "team"], items: ["org.view"] })).role;
  ok(await grant(w.adminA, { userId: w.target.id, roleId: sys.id, scopeType: "club", scopeId: w.A }));
  ok(await grant(w.adminB, { userId: w.nobody.id, roleId: sys.id, scopeType: "club", scopeId: w.B }));
  const roleB = ok(await createRole(w.adminB, { clubId: w.B })).role;
  const list = ok(await srv.api(w.adminA.cookie, `${R}?clubId=${w.A}&state=all`)).roles;
  assert.ok(!list.some((r) => r.id === roleB.id));
  assert.equal(list.find((r) => r.id === sys.id).holderCount, 1);
  assert.equal(ok(await srv.api(w.pa.cookie, `${R}/${sys.id}`)).holderCount, 2);
  const rows = ok(await srv.api(w.adminA.cookie, `${R}/assignments?clubId=${w.A}`)).assignments;
  assert.ok(rows.length > 0 && rows.every((r) => r.clubId === w.A), "only club A's holders");
  assert.ok(!rows.some((r) => r.userId === w.nobody.id));
});

test("24. no answer and no log line carries database text of a guard refusal: an unmapped refusal at the COMMIT answers a sanitized 500 internal_error", async () => {
  const w = await world();
  logLines.length = 0;
  const { DatabaseError } = (await import("pg")).default;
  svc.setRolesCommitForTests({ fault: async () => {
    const e = new DatabaseError("permission role: the change has no change record", 0, "error");
    e.code = "23514"; e.severity = "ERROR"; e.routine = "ExecConstraints";
    throw e;
  } });
  const res = await createRole(w.adminA, { clubId: w.A });
  assert.equal(res.status, 500, res.text);
  assert.deepEqual(Object.keys(res.body).sort(), ["error", "message"]);
  assert.equal(res.body.error, "internal_error");
  assert.ok(!/permission role|change record|23514/.test(res.text));
  assert.ok(!logLines.some((l) => /permission role:|change record/.test(l)), logLines.join(" | "));
});

// ---------------------------------------------------------------------------
// Lock order, races and COMMIT outcomes
// ---------------------------------------------------------------------------
const LOCKING = /\bfor (update|no key update|share|key share)\b|lock_permission_actor|pg_advisory/i;
const WRITE = /^(insert|update|delete)\b/i;
async function recorded(fn) {
  const seen = [];
  svc.setRolesStatementRecorderForTests((t) => seen.push(t));
  try { return { res: await fn(), seen }; } finally { svc.setRolesStatementRecorderForTests(null); }
}
test("28. the recorded SQL order of every write route: every lock before the first write, no locking clause after it, the request record last; for P9 and P10 the pair statement (no is_active filter) before lock_permission_actor", async () => {
  const w = await world();
  const steps = [];
  const c1 = await recorded(() => createRole(w.adminA, { clubId: w.A }));
  const role = ok(c1.res).role; steps.push(["P4", c1.seen]);
  const c2 = await recorded(() => change(w.adminA, role.id, { expectedRevision: 1, name: `C ${hex()}` })); ok(c2.res); steps.push(["P5", c2.seen]);
  const c3 = await recorded(() => srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Copy ${hex()}` } })); ok(c3.res); steps.push(["P7", c3.seen]);
  const c4 = await recorded(() => grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.T1 }));
  const assignment = ok(c4.res).assignment; steps.push(["P9", c4.seen]);
  const c5 = await recorded(() => revoke(w.adminA, assignment.id, { userId: w.target.id, roleId: role.id })); ok(c5.res); steps.push(["P10", c5.seen]);
  const c6 = await recorded(() => archive(w.adminA, role.id, 2)); ok(c6.res); steps.push(["P6", c6.seen]);
  for (const [name, seen] of steps) {
    const firstWrite = seen.findIndex((t) => WRITE.test(t));
    const locks = seen.map((t, i) => (LOCKING.test(t) ? i : -1)).filter((i) => i >= 0);
    const actorLock = seen.findIndex((t) => /lock_permission_actor/.test(t));
    assert.ok(actorLock >= 0 && actorLock < firstWrite, `${name}: lock_permission_actor before the first write\n${seen.join("\n")}`);
    assert.ok(/pg_advisory_xact_lock\(hashtextextended\('permission_request:'/.test(seen[locks[0]]), `${name}: the request-key lock is the first lock\n${seen.join("\n")}`);
    assert.ok(locks.every((i) => i < firstWrite), `${name}: no lock after the first write\n${seen.join("\n")}`);
    const request = seen.findIndex((t) => /insert into public\.permission_requests/.test(t));
    assert.ok(request > firstWrite && seen.slice(request + 1).every((t) => !WRITE.test(t)), `${name}: the request record is the last write`);
    assert.ok(seen.slice(0, firstWrite).some((t) => /set_config\('optimove\.permission_actor'/.test(t)), `${name}: the acting user is set before the first write`);
    if (name === "P9" || name === "P10") {
      const pair = seen.findIndex((t) => /where u\.id in \(\$1, \$2\) order by u\.id for share$/.test(t));
      // Only the request-key advisory lock (place 0, taken by every write route) comes before it.
      assert.ok(/pg_advisory_xact_lock\(hashtextextended\('permission_request:'/.test(seen[locks[0]]), `${name}: the request-key lock first\n${seen.join("\n")}`);
      assert.ok(pair >= 0 && pair < actorLock && pair === locks[1], `${name}: the pair statement is the first row lock\n${seen.join("\n")}`);
      assert.ok(!/is_active/.test(seen[pair]));
    }
  }
});

test("28b. P5 and P6 on a SYSTEM role by a club's admin (with and without clubId): the identical 404 before the write runner opens - no statement of runWrite, so no lock on the system role row; a platform admin's change of it runs", async () => {
  const w = await world();
  const sys = ok(await createRole(w.pa, { name: `System ${hex()}`, scopeTypes: ["club"], items: ["org.view"] })).role;
  for (const [label, send] of [
    ["P5 with clubId", () => change(w.adminA, sys.id, { clubId: w.A, expectedRevision: 1, name: `N ${hex()}` })],
    ["P5 without clubId", () => change(w.adminA, sys.id, { expectedRevision: 1, name: `N ${hex()}` })],
    ["P6 with clubId", () => srv.api(w.adminA.cookie, `${R}/${sys.id}/archive`, { method: "POST", body: { requestKey: key(), clubId: w.A, expectedRevision: 1, reason: "x" } })],
    ["P5 on Club admin", () => change(w.adminA, ROLE_IDS.club_admin, { clubId: w.A, expectedRevision: 1, name: "Boss" })],
  ]) {
    const r = await recorded(send);
    assert.deepEqual([r.res.status, r.res.body], [404, { error: "notFound" }], label);
    assert.deepEqual(r.seen, [], `${label}: runWrite never opened`);
  }
  const p = await recorded(() => change(w.pa, sys.id, { expectedRevision: 1, name: `PA ${hex()}` }));
  ok(p.res);
  assert.ok(p.seen.some((t) => /lock_permission_actor/.test(t)));
});

test("29. races, both orders, no 40P01: old club-admin revocation against that admin's role save; the old revocation against a new assignment by the same granter, the target's id below and above the actor's; two saves of one role; two grants of one key and of one (user, role, scope); grant against archive; grant against the target's login switched off", async () => {
  logLines.length = 0;
  const w = await world();
  // (a) The old club_admin revocation (by the platform admin) against the admin's role save, the save holding its locks first.
  {
    const held = await F.user("held-admin"); await F.grantClub(held, w.A);
    const heldWho = { cookie: await srv.cookieFor(held) };
    const role = ok(await createRole(heldWho, { clubId: w.A })).role;
    const g = gate(); let entered = false;
    svc.setRolesWriteHoldForTests(async () => { entered = true; await g.promise; });
    const save = change(heldWho, role.id, { expectedRevision: 1, name: `Held ${hex()}` });
    while (!entered) await new Promise((r) => setTimeout(r, 10));
    svc.setRolesWriteHoldForTests(null);
    const revoked = srv.api(w.pa.cookie, `/api/organization/users/${held}/club-roles/${w.A}/club_admin`, { method: "DELETE" });
    await waiting(1);
    g.open();
    const [s, r] = await Promise.all([save, revoked]);
    assert.equal(s.status, 200, s.text); assert.equal(r.status, 200, r.text);
  }
  // (a') The other order: the revocation first (a peer holds the admin's users row so the revocation waits on it), then the save.
  {
    const admin = await F.user("adminA3"); await F.grantClub(admin, w.A);
    const cookie = await srv.cookieFor(admin);
    const role = ok(await createRole({ cookie }, { clubId: w.A })).role;
    const peer = new pg.Client({ connectionString: db.url }); await peer.connect();
    await peer.query("begin"); await peer.query(`select 1 from public.users where id = $1 for update`, [admin]);
    const revoked = srv.api(w.pa.cookie, `/api/organization/users/${admin}/club-roles/${w.A}/club_admin`, { method: "DELETE" });
    await waiting(1);
    const save = change({ cookie }, role.id, { expectedRevision: 1, name: `After ${hex()}` });
    await waiting(2);
    await peer.query("commit"); await peer.end();
    const [r, s] = await Promise.all([revoked, save]);
    assert.equal(r.status, 200, r.text);
    assert.equal(s.status, 404, `the save after the revocation: ${s.text}`);
  }
  // (b) The old revocation of a club admin against a new assignment by the same granter, the target's id below and above the granter's.
  for (const targetBelow of [true, false]) {
    const club = await F.club("M6");
    const granter = await F.user("granter", { rank: 0x80 }); await F.grantClub(granter, club);
    const other = await F.user("other-admin", { rank: 0x90 }); await F.grantClub(other, club);
    const target = await F.user("m6-target", { rank: targetBelow ? 0x10 : 0xf0 }); await F.grantClub(target, club);
    const gc = await srv.cookieFor(granter);
    const role = ok(await createRole({ cookie: gc }, { clubId: club })).role;
    const g = gate(); let entered = false;
    svc.setRolesWriteHoldForTests(async () => { entered = true; await g.promise; });
    const assign = grant({ cookie: gc }, { userId: target, roleId: role.id, scopeType: "club", scopeId: club });
    while (!entered) await new Promise((r) => setTimeout(r, 10));
    svc.setRolesWriteHoldForTests(null);
    const revoked = srv.api(w.pa.cookie, `/api/organization/users/${target}/club-roles/${club}/club_admin`, { method: "DELETE" });
    await waiting(1);
    g.open();
    const [a, r] = await Promise.all([assign, revoked]);
    assert.equal(a.status, 200, a.text); assert.equal(r.status, 200, r.text);
  }
  // (c) Two saves of one role: one wins, the other is staleRevision.
  {
    const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
    const [x, y] = await Promise.all([change(w.adminA, role.id, { expectedRevision: 1, name: `X ${hex()}` }), change(w.adminAB, role.id, { expectedRevision: 1, name: `Y ${hex()}` })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal([x, y].find((r) => r.status === 409).body.error, "staleRevision");
  }
  // (d) Two grants of one key: one row; of one (user, role, scope) under two keys: one assignment_exists.
  {
    const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
    const body = { requestKey: key(), reason: "Same", userId: w.nobody.id, roleId: role.id, scopeType: "club", scopeId: w.A };
    const [p, q] = await Promise.all([srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body }), srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body })]);
    assert.deepEqual([p.status, q.status], [200, 200], `${p.text} ${q.text}`);
    assert.equal(p.body.assignment.id, q.body.assignment.id);
    const [m, n] = await Promise.all([grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.T2 }), grant(w.adminAB, { userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.T2 })]);
    assert.deepEqual([m.status, n.status].sort(), [200, 409]);
    assert.equal([m, n].find((r) => r.status === 409).body.error, "assignment_exists");
  }
  // (e) Grant against archive, both orders.
  for (const archiveFirst of [true, false]) {
    const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
    const g = gate(); let entered = false;
    svc.setRolesWriteHoldForTests(async () => { entered = true; await g.promise; });
    const first = archiveFirst ? archive(w.adminA, role.id, 1) : grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A });
    while (!entered) await new Promise((r) => setTimeout(r, 10));
    svc.setRolesWriteHoldForTests(null);
    const second = archiveFirst ? grant(w.adminAB, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A }) : archive(w.adminAB, role.id, 1);
    await waiting(1);
    g.open();
    const [f, s] = await Promise.all([first, second]);
    assert.equal(f.status, 200, f.text);
    code(s, 409, archiveFirst ? "role_archived" : "role_has_assignments");
  }
  // (f) Grant against the target's login switched off: the grant holds its locks first.
  {
    const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
    const target = await F.user("switch-target");
    const g = gate(); let entered = false;
    svc.setRolesWriteHoldForTests(async () => { entered = true; await g.promise; });
    const assign = grant(w.adminA, { userId: target, roleId: role.id, scopeType: "club", scopeId: w.A });
    while (!entered) await new Promise((r) => setTimeout(r, 10));
    svc.setRolesWriteHoldForTests(null);
    const off = srv.api(w.pa.cookie, `/api/organization/users/${target}/login-status`, { method: "PUT", body: { active: false } });
    await waiting(1);
    g.open();
    const [a, o] = await Promise.all([assign, off]);
    assert.equal(a.status, 200, a.text); assert.equal(o.status, 200, o.text);
  }
  noDeadlock();
});

test("29b. two requests of one caller with one key, the first held after its checks and before its writes: the second waits on the request-key lock and replays the first's answer (200, replayed, the same id), for P9 and for P4; one row each", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const sameKeyTwice = async (send) => {
    const g = gate(); let entered = 0;
    svc.setRolesWriteHoldForTests(async () => { entered += 1; if (entered === 1) await g.promise; });
    try {
      const first = send();
      const start = Date.now();
      while (entered < 1 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
      assert.equal(entered, 1);
      const second = send();
      await waiting(1);
      g.open();
      return await Promise.all([first, second]);
    } finally {
      svc.setRolesWriteHoldForTests(null);
    }
  };
  const grantBody = { requestKey: key(), reason: "Same key", userId: w.nobody.id, roleId: role.id, scopeType: "club", scopeId: w.A };
  const [a, b] = await sameKeyTwice(() => srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body: grantBody }));
  assert.deepEqual([a.status, b.status], [200, 200], `${a.text} ${b.text}`);
  assert.equal(a.body.assignment.id, b.body.assignment.id);
  assert.deepEqual([a.body.replayed, b.body.replayed], [false, true]);
  assert.equal((await one(`select count(*)::int as n from public.user_role_assignments where user_id = $1 and role_id = $2`, [w.nobody.id, role.id])).n, 1);
  const name = `Twice ${hex()}`;
  const createBody = { requestKey: key(), clubId: w.A, name, scopeTypes: ["club"], items: ["org.view"] };
  const [c, d] = await sameKeyTwice(() => srv.api(w.adminA.cookie, R, { method: "POST", body: createBody }));
  assert.deepEqual([c.status, d.status], [200, 200], `${c.text} ${d.text}`);
  assert.equal(c.body.role.id, d.body.role.id);
  assert.equal((await one(`select count(*)::int as n from public.permission_roles where name = $1`, [name])).n, 1);
});

test("30. COMMIT outcomes: an error before the COMMIT writes nothing; a COMMIT that never answers is verified (verified_after_commit_error) or 503 outcome_unknown and the same key then writes once; a replay after the right was lost is 404; request_key_reused; try_again on a held lock", async () => {
  const w = await world();
  // An error before the COMMIT.
  svc.setRolesWriteHoldForTests(async () => { throw new Error("broken before the commit"); });
  const before = await createRole(w.adminA, { clubId: w.A, name: "Never written" });
  assert.equal(before.status, 500); svc.setRolesWriteHoldForTests(null);
  assert.equal((await one(`select count(*)::int as n from public.permission_roles where name = 'Never written'`)).n, 0);
  // The COMMIT sent and answered, but its answer lost.
  svc.setRolesCommitForTests({ fault: async (c) => { await c.query("commit"); throw new Error("connection lost after commit"); } });
  const verified = ok(await createRole(w.adminA, { clubId: w.A, name: "Verified" }));
  assert.equal(verified.verified_after_commit_error, true);
  svc.setRolesCommitForTests();
  // The COMMIT never sent: unknown, then the same key writes once.
  svc.setRolesCommitForTests({ fault: () => new Promise(() => {}), timeoutMs: 300 });
  const body = { requestKey: key(), clubId: w.A, name: `Unknown ${hex()}`, scopeTypes: ["club"], items: ["org.view"] };
  const unknown = await srv.api(w.adminA.cookie, R, { method: "POST", body });
  code(unknown, 503, "outcome_unknown");
  svc.setRolesCommitForTests();
  ok(await srv.api(w.adminA.cookie, R, { method: "POST", body }));
  const replay = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body }));
  assert.equal(replay.replayed, true);
  assert.equal((await one(`select count(*)::int as n from public.permission_roles where name = $1`, [body.name])).n, 1);
  code(await srv.api(w.adminA.cookie, R, { method: "POST", body: { ...body, name: `Other ${hex()}` } }), 409, "request_key_reused");
  // A replay after the right was lost.
  const second = await F.user("second-admin"); await F.grantClub(second, w.A);
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]);
  code(await srv.api(w.adminA.cookie, R, { method: "POST", body }), 404, "notFound");
  await k.query(`update public.user_club_roles set is_active = true where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]);
  // A held lock: try_again within the bound.
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const peer = new pg.Client({ connectionString: db.url }); await peer.connect();
  await peer.query("begin"); await peer.query(`select 1 from public.permission_roles where id = $1 for update`, [role.id]);
  try {
    code(await change(w.adminA, role.id, { expectedRevision: 1, name: `Busy ${hex()}` }), 409, "try_again");
  } finally {
    await peer.query("rollback"); await peer.end();
  }
});

// ---------------------------------------------------------------------------
// 35: a holder of a non-basic role on the organization routes
// ---------------------------------------------------------------------------
test("35. a holder of a non-basic role passes can() on the club- and team-scope call sites it holds, when it also passes requireCoach; an account with only the non-basic role gets 403 on every organization route (requireCoach); a global call site stays a platform admin's", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A, scopeTypes: ["club"], items: ["org.view", "org.club.edit", "org.teams.manage", "athletes.manage", "athletes.remove"] })).role;
  // A coach of club B's team (passes requireCoach) and an account with nothing else.
  const coachB = await F.user("coachB"); await F.grantTeam(coachB, w.TB);
  const only = await F.user("only-role");
  for (const u of [coachB, only]) ok(await grant(w.adminA, { userId: u, roleId: role.id, scopeType: "club", scopeId: w.A }));
  const coachCookie = await srv.cookieFor(coachB);
  const onlyCookie = await srv.cookieFor(only);
  const calls = [
    ["PUT", `/api/organization/clubs/${w.A}`, { name: `Club A ${hex()}` }],
    ["POST", `/api/organization/teams`, { clubId: w.A, name: `Team ${hex()}` }],
    ["PUT", `/api/organization/teams/${w.T1}`, { name: `T1 ${hex()}` }],
  ];
  for (const [method, p, body] of calls) {
    const blocked = await srv.api(onlyCookie, p, { method, body });
    assert.equal(blocked.status, 403, `only the role: ${method} ${p} ${blocked.text}`);
  }
  const editClub = await srv.api(coachCookie, calls[0][1], { method: "PUT", body: calls[0][2] });
  assert.ok([200, 201].includes(editClub.status), `org.club.edit through the role: ${editClub.text}`);
  const renameTeam = await srv.api(coachCookie, calls[2][1], { method: "PUT", body: calls[2][2] });
  assert.ok([200, 201].includes(renameTeam.status), `org.view + org.teams.manage through the role: ${renameTeam.text}`);
  // POST /teams keeps its own pre-gate on the old club roles (organization.js): narrower, refused.
  assert.equal((await srv.api(coachCookie, calls[1][1], { method: "POST", body: calls[1][2] })).status, 403);
  // Another club's call site is refused; a global one stays a platform admin's.
  assert.equal((await srv.api(coachCookie, `/api/organization/clubs/${w.B}`, { method: "PUT", body: { name: "No" } })).status, 403);
  assert.equal((await srv.api(coachCookie, `/api/organization/clubs`, { method: "POST", body: { name: "No" } })).status, 403);
  assert.ok(rankedId(1));
});

// 29a with the real routes: the login switch-off of an admin Z of two clubs K1 < K2, while an admin A of K2
// assigns a role to (P9), or revokes an assignment of (P10), T, an admin of K1. Peers holding A's and T's users
// rows choreograph the arrival; the ids in both orders, both orders of arrival. No 40P01.
async function holdUser(userId) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  await c.query("begin");
  await c.query(`select 1 from public.users where id = $1 for update`, [userId]);
  return c;
}
const releasePeer = async (c) => { await c.query("commit").catch(() => {}); await c.end().catch(() => {}); };
for (const op of ["P9", "P10"]) {
  for (const actorBelow of [true, false]) {
    for (const rolesFirst of [true, false]) {
      test(`29a. the login switch-off of an admin of K1 and K2 against ${op} by an admin of K2 on an admin of K1 (actor ${actorBelow ? "below" : "above"} target, ${rolesFirst ? op : "switch-off"} first): no 40P01`, async () => {
        logLines.length = 0;
        const pa = { id: await F.user("pa29") }; await F.grantPlatform(pa.id); pa.cookie = await srv.cookieFor(pa.id);
        const K1 = await F.club("K1"); const K2 = await F.club("K2");
        const A = await F.user("a-k2", { rank: actorBelow ? 0x30 : 0x50 });
        const T = await F.user("t-k1", { rank: actorBelow ? 0x50 : 0x30 });
        const Z = await F.user("z-k1-k2", { rank: 0x70 });
        await F.grantClub(Z, K1); await F.grantClub(Z, K2); await F.grantClub(T, K1); await F.grantClub(A, K2);
        // T is also a holder at K2 so that A may act on T there.
        const aWho = { cookie: await srv.cookieFor(A) };
        const role = ok(await createRole(aWho, { clubId: K2, scopeTypes: ["club"] })).role;
        let assignment = null;
        if (op === "P10") assignment = ok(await grant(aWho, { userId: T, roleId: role.id, scopeType: "club", scopeId: K2 })).assignment;
        const [low, high] = [A, T].sort();
        const p1 = await holdUser(low);
        const p2 = await holdUser(high);
        const roleCall = () => (op === "P9" ? grant(aWho, { userId: T, roleId: role.id, scopeType: "club", scopeId: K2 }) : revoke(aWho, assignment.id, { userId: T, roleId: role.id }));
        const offCall = () => srv.api(pa.cookie, `/api/organization/users/${Z}/login-status`, { method: "PUT", body: { active: false } });
        let r, o;
        if (rolesFirst) { r = roleCall(); await waiting(1); o = offCall(); await waiting(2); } else { o = offCall(); await waiting(1); r = roleCall(); await waiting(2); }
        await releasePeer(p1); await new Promise((x) => setTimeout(x, 300));
        await releasePeer(p2);
        const [rr, oo] = await Promise.all([r, o]);
        assert.equal(rr.status, 200, rr.text);
        assert.equal(oo.status, 200, oo.text);
        noDeadlock();
      });
    }
  }
}

test("25 (API). a new grant of the same (user, role, scope) first stamps the lapsed row expired (D4) and inserts; a revoke of a lapsed row is assignment_already_revoked", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const first = ok(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A, expiresAt: new Date(Date.now() + 1200).toISOString() })).assignment;
  code(await grant(w.adminAB, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A }), 409, "assignment_exists");
  await new Promise((r) => setTimeout(r, 1500));
  code(await revoke(w.adminA, first.id, { userId: w.target.id, roleId: role.id }), 409, "assignment_already_revoked");
  const second = ok(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A })).assignment;
  assert.notEqual(second.id, first.id);
  assert.equal((await one(`select revoke_kind, revoked_by_user_id from public.user_role_assignments where id = $1`, [first.id])).revoke_kind, "expired");
  code(await grant(w.adminA, { userId: w.target.id, roleId: role.id, scopeType: "club", scopeId: w.A, expiresAt: "2020-01-01T00:00:00Z" }), 400, "invalid_request");
});

test("30b. a replay re-evaluates the caller's standing inside its transaction: the right lost after the route's gate and before the replay check answers 404", async () => {
  const w = await world();
  const second = await F.user("second"); await F.grantClub(second, w.A);
  const body = { requestKey: key(), clubId: w.A, name: `Replay ${hex()}`, scopeTypes: ["club"], items: ["org.view"] };
  ok(await srv.api(w.adminA.cookie, R, { method: "POST", body }));
  svc.setRolesAfterBeginHoldForTests(async () => {
    svc.setRolesAfterBeginHoldForTests(null);
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]);
  });
  code(await srv.api(w.adminA.cookie, R, { method: "POST", body }), 404, "notFound");
});
