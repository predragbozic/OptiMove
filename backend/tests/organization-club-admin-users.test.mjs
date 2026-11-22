// The owner's decision of 2026-11-22: in its own club's workspace a club's admin sees in Settings > Users every account
// that holds an ACTIVE role in that club or in one of its teams, with the fields the platform admin sees - but only this
// club's roles, and of global roles only the word and its state. Never another club's member, never a platform admin who
// holds nothing in the club, never a former member (the switch CLUB_MEMBERS_ACTIVE_ROLES_ONLY in
// backend/src/routes/organization.js; test 3 pins it). Nothing of the account actions changes (canManageLogin,
// manageableClubIds / manageableTeamIds). The team, private-coach and platform workspaces are unchanged.
// Real server on a disposable database built from the legacy snapshot and the runner.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildDatabase, fixtures, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
let db, k, F, srv, W;

before(async () => {
  db = await buildDatabase({ label: "club_admin_users" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  W = await world();
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const setWorkspace = (userId, type, scopeId) => k.query(
  `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
   on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
  [userId, type, scopeId],
);
async function person(label, setup = async () => {}) {
  const id = await F.user(label);
  await setup(id);
  return { id, cookie: await srv.cookieFor(id) };
}
async function org(who, type, scopeId) {
  await setWorkspace(who.id, type, scopeId);
  const body = ok(await srv.api(who.cookie, "/api/organization"));
  if (type) assert.equal(body.activeWorkspace?.type, type, "the workspace the test meant is the active one");
  return body;
}
const ids = (body) => new Set(body.users.map((u) => u.id));
const row = (body, who) => body.users.find((u) => u.id === who.id);

async function world() {
  const w = { A: await F.club("A"), B: await F.club("B") };
  w.TA1 = await F.team(w.A, "TA1");
  w.TA2 = await F.team(w.A, "TA2");
  w.TB = await F.team(w.B, "TB");
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.coAdminA = await person("coAdminA", (id) => F.grantClub(id, w.A));
  w.coachA1 = await person("coachA1", (id) => F.grantTeam(id, w.TA1));
  w.coachA2 = await person("coachA2", (id) => F.grantTeam(id, w.TA2));
  w.formerCoachA = await person("formerCoachA", (id) => F.grantTeam(id, w.TA2, false));
  w.formerAdminA = await person("formerAdminA", (id) => F.grantClub(id, w.A, false));
  // Two clubs: admin of B and coach in A; and admin of A and of B with a global role and an inactive B team role.
  w.dual = await person("dual", async (id) => { await F.grantClub(id, w.B); await F.grantTeam(id, w.TA1); });
  w.dualAdmin = await person("dualAdmin", async (id) => {
    await F.grantClub(id, w.A); await F.grantClub(id, w.B); await F.grantIndependent(id); await F.grantTeam(id, w.TB, false);
  });
  // A coach in A who left one of A's teams: the inactive role is club A's own data and stays on the row.
  w.coachA1FormerA2 = await person("coachA1FormerA2", async (id) => { await F.grantTeam(id, w.TA1); await F.grantTeam(id, w.TA2, false); });
  w.coachB = await person("coachB", (id) => F.grantTeam(id, w.TB));
  // Former members of A who are active in B now: the case the active-only rule exists for (their e-mail and login state
  // must not stay visible to A; the workspace filter alone would keep them, since it matches inactive roles too).
  w.movedCoach = await person("movedCoach", async (id) => { await F.grantTeam(id, w.TA2, false); await F.grantTeam(id, w.TB); });
  w.movedAdmin = await person("movedAdmin", async (id) => { await F.grantClub(id, w.A, false); await F.grantClub(id, w.B); });
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.paOutside = await person("paOutside", (id) => F.grantPlatform(id));
  w.paInA = await person("paInA", async (id) => { await F.grantPlatform(id); await F.grantClub(id, w.A); });
  w.paCoachA = await person("paCoachA", async (id) => { await F.grantPlatform(id); await F.grantTeam(id, w.TA1); });
  w.athleteCoachA = await person("athleteCoachA", async (id) => { await F.makeAthlete(id); await F.grantTeam(id, w.TA1); });
  w.pureAthlete = await person("pureAthlete", (id) => F.makeAthlete(id));
  w.nobody = await person("nobody");
  // Accounts adminA created: one without any role (visible today), one whose only role is in club B (never visible in A).
  w.ownUnassigned = await person("ownUnassigned");
  w.ownInB = await person("ownInB", (id) => F.grantTeam(id, w.TB));
  await k.query(`update public.users set created_by_user_id = $1 where id = any($2::uuid[])`, [w.adminA.id, [w.ownUnassigned.id, w.ownInB.id]]);
  w.revokedAdminA = await person("revokedAdminA", (id) => F.grantClub(id, w.A, false));
  return w;
}

test("1. a club's admin in its club's workspace sees every account with an active role in the club or its teams - and nobody else", async () => {
  const w = W;
  const body = await org(w.adminA, "club", w.A);
  const before = [w.adminA, w.coAdminA, w.dualAdmin, w.paInA, w.ownUnassigned]; // what the old rules already showed
  const added = [w.coachA1, w.coachA2, w.dual, w.coachA1FormerA2, w.paCoachA, w.athleteCoachA];
  const never = [w.formerCoachA, w.formerAdminA, w.movedCoach, w.movedAdmin, w.coachB, w.adminB, w.paOutside, w.pureAthlete, w.nobody, w.ownInB, w.revokedAdminA];
  assert.deepEqual(ids(body), new Set([...before, ...added].map((p) => p.id)));
  for (const p of never) assert.equal(row(body, p), undefined, "never visible");
});

test("2. the rows of a club's admin carry only this club's roles and of global roles only the word and its state", async () => {
  const w = W;
  const body = await org(w.adminA, "club", w.A);
  const dual = row(body, w.dual);
  assert.deepEqual(dual.clubRoles, [], "dual's admin role in B is not shown in A");
  assert.deepEqual(dual.teamRoles.map((r) => r.teamId), [w.TA1]);
  const dualAdmin = row(body, w.dualAdmin);
  assert.deepEqual(dualAdmin.clubRoles.map((r) => r.clubId), [w.A], "the same for a co-admin already visible today");
  assert.deepEqual(dualAdmin.teamRoles, [], "an inactive role in B's team is not shown either");
  assert.deepEqual(dualAdmin.globalRoles, [{ role: "independent_coach", isActive: true }]);
  const kept = row(body, w.coachA1FormerA2);
  assert.deepEqual(kept.teamRoles.map((r) => [r.teamId, r.isActive]).sort(), [[w.TA1, true], [w.TA2, false]].sort(), "club A's inactive role stays");
  assert.deepEqual(row(body, w.paInA).globalRoles, [{ role: "platform_admin", isActive: true }]);
  for (const u of body.users) {
    for (const g of u.globalRoles) assert.deepEqual(Object.keys(g).sort(), ["isActive", "role"]);
    for (const r of u.clubRoles) assert.equal(r.clubId, w.A);
    for (const r of u.teamRoles) assert.equal(r.clubId, w.A);
  }
  const text = JSON.stringify(body.users);
  for (const leak of [w.B, w.TB]) assert.equal(text.includes(leak), false, "no id of club B or its team in the users");
  // The fields the screen shows are present on a newly visible row.
  const coach = row(body, w.coachA1);
  for (const f of ["email", "name", "loginActive", "isAthlete", "capabilities"]) assert.ok(f in coach, f);
  assert.match(coach.email, /@test\.local$/);
});

test("3. former members (only an inactive role in the club) stay hidden: the switch CLUB_MEMBERS_ACTIVE_ROLES_ONLY is on", async () => {
  const w = W;
  const body = await org(w.adminA, "club", w.A);
  assert.equal(row(body, w.formerCoachA), undefined);
  assert.equal(row(body, w.formerAdminA), undefined);
  assert.equal(row(body, w.movedCoach), undefined, "a former coach of A now coaching in B");
  assert.equal(row(body, w.movedAdmin), undefined, "a former admin of A now administering B");
  // The platform admin's own view of the same club does show them (the switch would make the two equal).
  const pa = await org(w.paInA, "club", w.A);
  assert.ok(row(pa, w.formerCoachA) && row(pa, w.formerAdminA));
});

test("4. nothing of the account actions opens: canManageLogin only for the admin's own creations, the manageable scopes unchanged", async () => {
  const w = W;
  const body = await org(w.adminA, "club", w.A);
  for (const u of body.users) {
    const expected = u.id === w.ownUnassigned.id;
    assert.equal(u.canManageLogin, expected, `canManageLogin of ${u.name}`);
  }
  assert.deepEqual(body.manageableClubIds, [w.A]);
  assert.deepEqual(new Set(body.manageableTeamIds), new Set([w.TA1, w.TA2]));
  assert.equal(body.isPlatformAdmin, false);
  // The platform admin's account view stays refused to the club's admin.
  const account = await srv.api(w.adminA.cookie, `/api/organization/users/${w.coachA1.id}/account`);
  assert.equal(account.status, 403);
});

test("5. another club stays closed: B's admin in B's workspace sees B's people, never A's; a two-club admin sees per workspace", async () => {
  const w = W;
  const b = await org(w.adminB, "club", w.B);
  assert.deepEqual(ids(b), new Set([w.adminB, w.dual, w.dualAdmin, w.coachB, w.ownInB, w.movedCoach, w.movedAdmin].map((p) => p.id)), "ownInB coaches B's team, so it is B's member");
  for (const p of [w.coachA1, w.adminA, w.athleteCoachA]) assert.equal(row(b, p), undefined);
  assert.deepEqual(row(b, w.dual).clubRoles.map((r) => r.clubId), [w.B]);
  assert.deepEqual(row(b, w.dual).teamRoles, [], "dual's team role in A is not shown in B");

  const inA = await org(w.dualAdmin, "club", w.A);
  assert.equal(row(inA, w.coachB), undefined);
  assert.ok(row(inA, w.coachA1));
  const inB = await org(w.dualAdmin, "club", w.B);
  assert.equal(row(inB, w.coachA1), undefined);
  assert.ok(row(inB, w.coachB));
});

test("6. a revoked admin (an inactive club role) gets nothing new; a team coach in the team workspace sees what it saw before", async () => {
  const w = W;
  await setWorkspace(w.revokedAdminA.id, "club", w.A);
  const revoked = await srv.api(w.revokedAdminA.cookie, "/api/organization");
  assert.equal(revoked.status, 403, "an account with no active role is refused the whole route, as before");
  assert.equal(revoked.body.users, undefined);

  const coach = await org(w.coachA1, "team", w.TA1);
  // The old rule: the coach's own team's active coaches (and itself); nobody of the club's other team, no club admin.
  assert.deepEqual(ids(coach), new Set([w.coachA1, w.dual, w.coachA1FormerA2, w.paCoachA, w.athleteCoachA].map((p) => p.id)));
  assert.ok(row(coach, w.paCoachA).globalRoles.some((g) => "grantedByUserId" in g), "the team workspace's rows are not narrowed");
});

test("7. the platform admin is unchanged: the full rows in the platform workspace and in a club's workspace", async () => {
  const w = W;
  const platform = await org(w.paOutside, "platform", null);
  for (const p of [w.coachA1, w.coachB, w.formerCoachA, w.nobody, w.dualAdmin]) assert.ok(row(platform, p), p.id);
  assert.deepEqual(row(platform, w.dualAdmin).clubRoles.map((r) => r.clubId).sort(), [w.A, w.B].sort());
  assert.ok(row(platform, w.dualAdmin).globalRoles.every((g) => "grantedByUserId" in g));
  const inA = await org(w.paInA, "club", w.A);
  assert.ok(row(inA, w.nobody), "the platform admin's club view keeps its unassigned accounts");
  assert.deepEqual(row(inA, w.dual).clubRoles.map((r) => r.clubId), [w.B], "and its full rows");
});
