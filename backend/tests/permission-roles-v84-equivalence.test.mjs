// Roles R2: can() reading role items from the database, the SQL twin
// public.user_has_permission, and R1's can() (the oracle,
// tests/support/permissions-r1-oracle.mjs) - the old-vs-new test of contract
// section 6 (tests 31 and 31a), expiry (25), the old helpers never reading the
// new fields (33), and unreadable role tables (34). Disposable database only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildDatabase, fixtures, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let db, k, F, srv, authz, perms, oracle;
const W = {};

before(async () => {
  db = await buildDatabase({ label: "v84_eq", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  authz = await import("../src/authz.js");
  perms = await import("../src/permissions.js");
  oracle = await import("./support/permissions-r1-oracle.mjs");
  // Two clubs with a team each, and the accounts of R1's matrix.
  W.A = await F.club("A"); W.B = await F.club("B");
  W.T1 = await F.team(W.A, "T1"); W.T2 = await F.team(W.B, "T2");
  const acct = async (label, setup) => { const id = await F.user(label); await setup(id); return id; };
  W.users = {
    "no role": await acct("none", async () => {}),
    "athlete only": await acct("athlete", (id) => F.makeAthlete(id)),
    "independent coach": await acct("indep", (id) => F.grantIndependent(id)),
    "platform admin": await acct("pa", (id) => F.grantPlatform(id)),
    "club admin of A": await acct("caA", (id) => F.grantClub(id, W.A)),
    "club admin of A and B": await acct("caAB", async (id) => { await F.grantClub(id, W.A); await F.grantClub(id, W.B); }),
    "team coach of T1": await acct("tc1", (id) => F.grantTeam(id, W.T1)),
    "team coach of T2": await acct("tc2", (id) => F.grantTeam(id, W.T2)),
    "club admin of A and team coach of T2": await acct("caA_tc2", async (id) => { await F.grantClub(id, W.A); await F.grantTeam(id, W.T2); }),
    "club admin of A and team coach of T1": await acct("caA_tc1", async (id) => { await F.grantClub(id, W.A); await F.grantTeam(id, W.T1); }),
    "platform admin and club admin of A": await acct("paA", async (id) => { await F.grantPlatform(id); await F.grantClub(id, W.A); }),
    "inactive club admin row of A, inactive team coach row of T1": await acct("inactiveRows", async (id) => { await F.grantClub(id, W.A, false); await F.grantTeam(id, W.T1, false); }),
  };
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const SEEDED_VIEW = ["athletes.view", "programs.view", "exercises.use", "presets.use", "calendar.view", "load.view.team",
  "load.view.athlete", "dashboards.view", "tests.view", "tests.results.view", "variables.view"];
const ctxOf = (userId) => authz.loadAuthorizationContext({ id: userId, role_hint: null });
const twin = async (userId, word, type, id) => (await k.query(`select public.user_has_permission($1, $2, $3, $4) as ok`, [userId, word, type, id ?? null])).rows[0].ok;
const scopesOf = () => ({
  global: [["global", { type: "global" }, null]],
  club: [[`club A`, perms.clubScope(W.A), W.A], [`club B`, perms.clubScope(W.B), W.B], [`unknown club`, perms.clubScope(crypto.randomUUID()), null], ["club without id", perms.clubScope(null), null]],
  team: [[`team T1`, perms.teamScope(W.T1), W.T1], [`team T2`, perms.teamScope(W.T2), W.T2], [`unknown team`, perms.teamScope(crypto.randomUUID()), null], ["team without id", perms.teamScope(null), null]],
});

test("31. old-vs-new: for every account of R1's matrix, every one of the 52 words and every scope, the new can(), the SQL twin and R1's can() agree - apart from the audited V and M seeds and roles.manage for a club's admin", async () => {
  const words = Object.keys(perms.PERMISSIONS);
  const rosterDecide = "load.roster.decide";
  const estimatesManage = "load.estimates.manage";
  const activitiesManage = "load.activities.manage";
  const dashboardsManage = "dashboards.manage";
  const builderRpe = "programs.rpe_settings";
  const programEdit = "programs.edit";
  assert.ok(perms.HONOURED_PERMISSIONS.includes(programEdit) && perms.STORABLE_PERMISSIONS.includes(programEdit));
  const programAssignmentBridge = ["programs.assign", "programs.publish"];
  for (const word of programAssignmentBridge) {
    assert.ok(perms.HONOURED_PERMISSIONS.includes(word));
    assert.ok(perms.STORABLE_PERMISSIONS.includes(word));
  }
  const testsScheduleBridge = "tests.schedule.manage";
  assert.ok(perms.HONOURED_PERMISSIONS.includes(testsScheduleBridge));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(testsScheduleBridge));
  const sourcesConnect = "sources.connect";
  assert.ok(!perms.HONOURED_PERMISSIONS.includes(sourcesConnect));
  assert.ok(!perms.STORABLE_PERMISSIONS.includes(sourcesConnect));
  const mappingsManage = "mappings.manage";
  assert.ok(perms.HONOURED_PERMISSIONS.includes(mappingsManage));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(mappingsManage));
  const variablesManage = "variables.manage";
  assert.ok(perms.HONOURED_PERMISSIONS.includes(variablesManage));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(variablesManage));
  const variablesRenameArchive = "variables.rename_archive";
  assert.ok(perms.HONOURED_PERMISSIONS.includes(variablesRenameArchive));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(variablesRenameArchive));
  const exerciseWrites = ["exercises.add", "exercises.remove"];
  for (const word of exerciseWrites) assert.ok(perms.HONOURED_PERMISSIONS.includes(word) && perms.STORABLE_PERMISSIONS.includes(word));
  assert.ok(perms.HONOURED_PERMISSIONS.includes(builderRpe));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(builderRpe));
  assert.ok(perms.HONOURED_PERMISSIONS.includes(dashboardsManage));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(dashboardsManage));
  assert.ok(perms.HONOURED_PERMISSIONS.includes(activitiesManage));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(activitiesManage));
  assert.ok(perms.HONOURED_PERMISSIONS.includes(estimatesManage));
  assert.ok(perms.STORABLE_PERMISSIONS.includes(estimatesManage));
  assert.ok(perms.HONOURED_PERMISSIONS.includes(rosterDecide), "M-3a exposure checks the projected word");
  assert.ok(perms.STORABLE_PERMISSIONS.includes(rosterDecide), "M-3a exposure lets the role editor grant the word");
  let cells = 0, differences = 0;
  for (const [name, userId] of Object.entries(W.users)) {
    const ctx = await ctxOf(userId);
    assert.ok(Array.isArray(ctx.rolePermissions), `${name}: the role items were loaded`);
    for (const [type, list] of Object.entries(scopesOf())) {
      for (const [scopeName, scope] of list) {
        for (const word of words) {
          const r1 = oracle.canR1(ctx, word, scope);
          const now = perms.can(ctx, word, scope);
          const sql = await twin(userId, word, type, scope.id);
          const clubAdminHere = ctx.clubRoles.some((r) => r.role === "club_admin"
            && ((type === "club" && r.clubId === scope.id) || (type === "team" && ((r.clubId === W.A && scope.id === W.T1) || (r.clubId === W.B && scope.id === W.T2)))));
          // Roles R4-1 (v92): the VIEW package is seeded into Club admin and Team coach (contract 4.1); R1's oracle never
          // knew those words. A seeded view word is held exactly where org.view (seeded in both since v84) is held.
          const seededView = SEEDED_VIEW.includes(word) && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededCalendar = ctx.platformRoles.length === 0 && (
            (word === "calendar.events.manage" && oracle.canR1(ctx, "org.view", scope))
            || (word === "calendar.settings.manage" && clubAdminHere)
          );
          const seededSchedule = word === "load.schedule.manage" && ctx.platformRoles.length === 0
            && oracle.canR1(ctx, "org.view", scope);
          // M-3a seeds both native basic roles. Exposure projects the checked word in native scopes.
          const seededRoster = word === rosterDecide && ctx.platformRoles.length === 0
            && oracle.canR1(ctx, "org.view", scope);
          const rolesManage = word === "roles.manage" && clubAdminHere && ctx.platformRoles.length === 0;
          const seededEstimates = word === estimatesManage && ctx.platformRoles.length === 0
            && oracle.canR1(ctx, "org.view", scope);
          const seededActivities = word === activitiesManage && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededDashboards = word === dashboardsManage && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededBuilderRpe = word === builderRpe && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededExerciseWrite = exerciseWrites.includes(word) && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededProgramEdit = word === programEdit && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededProgramAssignment = programAssignmentBridge.includes(word) && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);

          const seededTestsSchedule = word === testsScheduleBridge && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);

          const seededVariablesRenameArchive = word === variablesRenameArchive && ctx.platformRoles.length === 0 && oracle.canR1(ctx, "org.view", scope);
          const seededVariablesManage = word === variablesManage && ctx.platformRoles.length === 0 && clubAdminHere;
          const seededMappingsManage = word === mappingsManage && ctx.platformRoles.length === 0 && clubAdminHere;
          const seededSourcesConnect = word === sourcesConnect && ctx.platformRoles.length === 0 && clubAdminHere;
          if (word === sourcesConnect && ctx.platformRoles.length === 0 && (type === "club" || type === "team")) {
            const projection = perms.permissionsForWorkspace(ctx, { type, scopeId: scope.id });
            assert.equal(projection.permissions.includes(word), false, "Sources remains hidden before exposure");
          }
          const expected = seededSourcesConnect || seededMappingsManage || seededVariablesManage || seededVariablesRenameArchive || seededTestsSchedule || seededProgramEdit || seededProgramAssignment || rolesManage || seededView || seededCalendar || seededSchedule || seededRoster || seededEstimates || seededActivities || seededDashboards || seededBuilderRpe || seededExerciseWrite ? true : r1;
          if ((word === rosterDecide || word === estimatesManage || word === activitiesManage || word === dashboardsManage || word === builderRpe || word === programEdit || word === testsScheduleBridge || word === variablesRenameArchive || word === variablesManage || word === mappingsManage || programAssignmentBridge.includes(word) || exerciseWrites.includes(word)) && ctx.platformRoles.length === 0 && (type === "club" || type === "team")) {
            const projection = perms.permissionsForWorkspace(ctx, { type, scopeId: scope.id });
            assert.equal(projection.permissions.includes(word), expected, `${name}: exposed ${word} on ${scopeName}`);
          }
          if (expected !== r1 && !seededView && !seededCalendar && !seededSchedule && !seededRoster && !seededEstimates && !seededActivities && !seededDashboards && !seededBuilderRpe && !seededExerciseWrite && !seededProgramEdit && !seededProgramAssignment && !seededTestsSchedule && !seededVariablesRenameArchive && !seededVariablesManage && !seededMappingsManage && !seededSourcesConnect) differences++;
          assert.equal(now, expected, `${name}: can(${word}) on ${scopeName}`);
          assert.equal(sql, expected, `${name}: twin(${word}) on ${scopeName}`);
          cells++;
        }
      }
    }
  }
  assert.ok(cells > 5000, `${cells} cells`);
  // The one stated difference, cell by cell: roles.manage for 5 club-admin accounts without the platform role,
  // at their clubs and those clubs' teams.
  assert.equal(differences, 2 + 4 + 2 + 2, "club admin of A; of A and B; of A with a team of B; of A with a team of A");
});

test("31-M13. an inactive user (users.is_active false) is false in the twin at every step after the platform-admin short-circuit too - a named difference outside the equivalence, since can() relies on the session", async () => {
  const id = await F.user("inactive-admin"); await F.grantClub(id, W.A); await F.grantPlatform(id);
  await k.query(`update public.users set is_active = false where id = $1`, [id]);
  assert.equal(await twin(id, "org.view", "club", W.A), false);
  assert.equal(await twin(id, "platform.admin", "global", null), false);
  assert.equal(await twin(null, "org.view", "club", W.A), false);
});

test("31-M12. the twin raises 22023 for an unknown word or scope type, as can() throws", async () => {
  for (const [word, type] of [["org.unknown", "club"], ["org.view", "platform"], ["org.view", null]]) {
    await assert.rejects(k.query(`select public.user_has_permission($1, $2, $3, $4)`, [W.users["platform admin"], word, type, W.A]), (e) => e.code === "22023" && /unknown permission or scope type/.test(e.message));
    await assert.rejects(Promise.resolve().then(() => perms.can({ platformRoles: ["platform_admin"], rolePermissions: [] }, word, { type, id: W.A })), /Unknown permission/);
  }
});

test("31a. the twin against can() with non-basic assignments: club and team scopes, own and another account's, active, revoked and expired, of a role archived afterwards, together with a basic role; every honoured word at every scope of the matrix", async () => {
  const pa = W.users["platform admin"];
  // Two system roles and a club role of A, planted directly (triggers off) so that every state can be made.
  const role = async (owner, name, items, { club = true, team = true } = {}) => {
    const id = crypto.randomUUID();
    await k.query(`set session_replication_role = replica`);
    await k.query(`insert into public.permission_roles (id, owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id) values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, owner ? "club" : "system", owner, name, club, team, pa]);
    for (const w of items) await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, $2)`, [id, w]);
    await k.query(`reset session_replication_role`);
    return id;
  };
  const plant = async (userId, roleId, scopeType, scopeId, { revoked = false, expired = false } = {}) => {
    await k.query(`set session_replication_role = replica`);
    await k.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason, created_at, expires_at, revoked_at, revoked_by_user_id, revoke_kind, revoke_reason)
                   values ($1, $2, $3, $4, $5, 'platform_admin', 'Matrix', now() - interval '2 days', $6, $7, $8, $9, $10)`,
    [userId, roleId, scopeType, scopeId, pa, expired ? new Date(Date.now() - 86400000) : null, revoked ? new Date() : null, revoked ? pa : null, revoked ? "revoked" : null, revoked ? "Matrix" : null]);
    await k.query(`reset session_replication_role`);
  };
  const viewer = await role(null, `Viewer ${crypto.randomBytes(2).toString("hex")}`, ["org.view", "athletes.manage"]);
  const remover = await role(null, `Remover ${crypto.randomBytes(2).toString("hex")}`, ["athletes.remove", "org.club.edit"], { team: false });
  const clubOwn = await role(W.A, `A role ${crypto.randomBytes(2).toString("hex")}`, ["org.teams.manage", "athletes.remove"], { team: false });
  const archived = await role(null, `Archived ${crypto.randomBytes(2).toString("hex")}`, ["org.view"]);
  const u = {};
  u.clubAssignment = await F.user("a-club"); await plant(u.clubAssignment, viewer, "club", W.A);
  u.teamAssignment = await F.user("a-team"); await plant(u.teamAssignment, viewer, "team", W.T1);
  u.otherAccount = await F.user("a-other"); // holds nothing; the club assignment above is another account's
  u.revoked = await F.user("a-revoked"); await plant(u.revoked, viewer, "club", W.A, { revoked: true });
  u.expired = await F.user("a-expired"); await plant(u.expired, viewer, "team", W.T2, { expired: true });
  u.archived = await F.user("a-archived"); await plant(u.archived, archived, "club", W.B);
  u.union = await F.user("a-union"); await F.grantTeam(u.union, W.T2); await plant(u.union, remover, "club", W.A); await plant(u.union, clubOwn, "club", W.A);
  u.clubAtOtherTeam = await F.user("a-cross"); await plant(u.clubAtOtherTeam, viewer, "club", W.B);
  // The role is archived after its assignment.
  await k.query(`set session_replication_role = replica`);
  await k.query(`update public.permission_roles set archived_at = now(), archived_by_user_id = $2, revision = revision + 1 where id = $1`, [archived, pa]);
  await k.query(`reset session_replication_role`);
  let cells = 0;
  for (const [name, userId] of Object.entries(u)) {
    const ctx = await ctxOf(userId);
    for (const [type, list] of Object.entries(scopesOf())) {
      for (const [scopeName, scope] of list) {
        for (const word of perms.HONOURED_PERMISSIONS) {
          assert.equal(perms.can(ctx, word, scope), await twin(userId, word, type, scope.id), `${name}: ${word} on ${scopeName}`);
          cells++;
        }
      }
    }
  }
  assert.ok(cells >= 7 * 9 * 8);
  // The named cases.
  const ask = async (who, word, scope) => perms.can(await ctxOf(u[who]), word, scope);
  assert.equal(await ask("clubAssignment", "org.view", perms.clubScope(W.A)), true);
  assert.equal(await ask("clubAssignment", "org.view", perms.teamScope(W.T1)), true, "a club assignment at a team of that club");
  assert.equal(await ask("clubAssignment", "org.view", perms.teamScope(W.T2)), false, "at a team of another club");
  assert.equal(await ask("teamAssignment", "org.view", perms.clubScope(W.A)), false, "a team assignment at its club");
  assert.equal(await ask("teamAssignment", "org.view", perms.teamScope(W.T2)), false, "at another team");
  assert.equal(await ask("otherAccount", "org.view", perms.clubScope(W.A)), false, "another account's assignment");
  assert.equal(await ask("revoked", "org.view", perms.clubScope(W.A)), false);
  assert.equal(await ask("expired", "org.view", perms.teamScope(W.T2)), false);
  assert.equal(await ask("archived", "org.view", perms.clubScope(W.B)), false);
  assert.equal(await ask("union", "athletes.manage", perms.teamScope(W.T2)), true, "the basic role of the old table");
  assert.equal(await ask("union", "org.teams.manage", perms.clubScope(W.A)), true, "the club's own role");
  assert.equal(await ask("union", "org.club.edit", perms.clubScope(W.A)), true, "the system role");
  assert.equal(await ask("clubAtOtherTeam", "org.view", perms.teamScope(W.T1)), false);
});

test("25. (D4) an assignment past expires_at gives nothing in can() and in the twin; a transaction opened before the expiry keeps its first answer", async () => {
  const pa = W.users["platform admin"];
  const roleId = crypto.randomUUID();
  await k.query(`set session_replication_role = replica`);
  await k.query(`insert into public.permission_roles (id, owner_scope, name, assignable_club, assignable_team, created_by_user_id) values ($1, 'system', $2, true, true, $3)`, [roleId, `Expiring ${crypto.randomBytes(2).toString("hex")}`, pa]);
  await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, 'org.view')`, [roleId]);
  const holder = await F.user("expiring");
  await k.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason, expires_at)
                 values ($1, $2, 'club', $3, $4, 'platform_admin', 'Short', now() + interval '1500 milliseconds')`, [holder, roleId, W.A, pa]);
  await k.query(`reset session_replication_role`);
  assert.equal(perms.can(await ctxOf(holder), "org.view", perms.clubScope(W.A)), true);
  const open = new pg.Client({ connectionString: db.url });
  await open.connect();
  try {
    await open.query("begin");
    const first = (await open.query(`select public.user_has_permission($1, 'org.view', 'club', $2) as ok`, [holder, W.A])).rows[0].ok;
    await new Promise((r) => setTimeout(r, 1800));
    const again = (await open.query(`select public.user_has_permission($1, 'org.view', 'club', $2) as ok`, [holder, W.A])).rows[0].ok;
    assert.deepEqual([first, again], [true, true], "now() is the transaction's start");
    await open.query("commit");
  } finally {
    await open.end();
  }
  assert.equal(await twin(holder, "org.view", "club", W.A), false);
  assert.equal(perms.can(await ctxOf(holder), "org.view", perms.clubScope(W.A)), false);
});

test("33. the old helpers never read the new context fields; the old fields keep their shape", async () => {
  const source = fs.readFileSync(path.join(REPO, "backend/src/authz.js"), "utf8");
  for (const fn of ["computeCapabilities", "isPlatformAdministrator", "holdsClubAdminRole", "holdsTeamCoachRole", "managesTeamThroughClub", "canManageClub", "canManageTeamById", "canAssignClubRole", "canAssignTeamRole", "canUsePlatformAdministration"]) {
    const start = source.indexOf(`export function ${fn}(`);
    assert.ok(start >= 0, fn);
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    assert.ok(!/rolePermissions|roleAssignments/.test(body), `${fn} reads a new field`);
  }
  // workspace.js left this list in roles R4-2 (contract 5.1): it reads roleAssignments to offer the club_view /
  // team_view types, and rolePermissions only to know the role tables were unreadable (no fallback persisted then).
  // It still offers a club or team workspace only from the old role rows: roles-r4-checked-gates.test.mjs B2.
  for (const file of ["backend/src/auth.js"]) {
    assert.ok(!/rolePermissions|roleAssignments/.test(fs.readFileSync(path.join(REPO, file), "utf8")), file);
  }
  const ctx = await ctxOf(W.users["club admin of A and team coach of T2"]);
  assert.deepEqual(Object.keys(ctx).sort(), ["athleteId", "clubRoles", "isAthlete", "isIndependentCoach", "managedTeamIds", "platformRoles", "roleAssignments", "roleHint", "rolePermissions", "teamRoles", "userId"]);
  assert.deepEqual(ctx.clubRoles, [{ clubId: W.A, role: "club_admin" }]);
  assert.deepEqual(ctx.teamRoles, [{ teamId: W.T2, role: "team_coach" }]);
  assert.deepEqual(ctx.managedTeamIds, [W.T1]);
  assert.deepEqual(ctx.platformRoles, []);
});

test("34. role tables unreadable: a platform admin still passes the organization routes; a club's admin gets 503 permissions_unavailable, never a fallback or a wrong 404; readable again, it works", async () => {
  const adminCookie = await srv.cookieFor(W.users["club admin of A"]);
  const paCookie = await srv.cookieFor(W.users["platform admin"]);
  const route = `/api/organization/teams`;
  const body = { clubId: W.A, name: `Team ${crypto.randomBytes(2).toString("hex")}` };
  await k.query(`alter table public.permission_role_items rename to permission_role_items_hidden`);
  try {
    const refused = await srv.api(adminCookie, route, { method: "POST", body });
    assert.equal(refused.status, 503, refused.text);
    assert.deepEqual(refused.body.error, "permissions_unavailable");
    const pa = await srv.api(paCookie, route, { method: "POST", body: { ...body, name: `${body.name} p` } });
    assert.ok(pa.status === 200 || pa.status === 201, pa.text);
  } finally {
    await k.query(`alter table public.permission_role_items_hidden rename to permission_role_items`);
  }
  const ok = await srv.api(adminCookie, route, { method: "POST", body: { ...body, name: `${body.name} again` } });
  assert.ok(ok.status === 200 || ok.status === 201, ok.text);
  assert.equal(ROLE_IDS.club_admin.length, 36);
});

test("34b. role tables unreadable inside a caller's own transaction (dashboardSimple's preview runner): the read fails closed (unavailable) under a savepoint and the caller's transaction stays usable - never 25P02; outside a transaction the same runner still fails closed", async () => {
  const user = (await k.query(`select * from public.users where id = $1`, [W.users["club admin of A"]])).rows[0];
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  const runner = (sql, params) => c.query(sql, params);
  await k.query(`alter table public.permission_role_items rename to permission_role_items_hidden`);
  try {
    await c.query("begin");
    const inside = await authz.loadAuthorizationContext(user, runner);
    assert.equal(inside.rolePermissions.unavailable, true);
    assert.equal((await c.query("select 1 as one")).rows[0].one, 1, "the caller's transaction is still usable");
    await c.query("commit");
    const outside = await authz.loadAuthorizationContext(user, runner);
    assert.equal(outside.rolePermissions.unavailable, true);
    assert.equal((await c.query("select 1 as one")).rows[0].one, 1);
  } finally {
    await c.query("rollback").catch(() => {});
    await k.query(`alter table public.permission_role_items_hidden rename to permission_role_items`);
  }
  // Readable again, inside a transaction: the words, and the savepoint released.
  await c.query("begin");
  const again = await authz.loadAuthorizationContext(user, runner);
  assert.ok(Array.isArray(again.rolePermissions) && again.rolePermissions.some((e) => e.scopeId === W.A && e.words.includes("roles.manage")));
  assert.equal((await c.query("select 1 as one")).rows[0].one, 1);
  await c.query("commit");
  await c.end();
});
