import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 4: security/scoped-role-management. club_admin/team_coach grant and
// revoke, kept strictly scoped: platform admin anywhere; a club_admin only
// within their own club (and that club's teams); nobody else, regardless of
// role_hint, independent_coach, or being that team's own team_coach. Every
// club fixture here is freshly created per test, so the LAST_CLUB_ADMIN
// invariant is naturally scoped and never collides with any other test file
// or any other club in the shared dev database.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();
const cleanupAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  // athletes.user_id is ON DELETE SET NULL, not CASCADE - athletes must be
  // deleted explicitly and before their linked user.
  await runCleanupSteps([
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["teams", () => cleanupTeamIds.size && query(`delete from public.teams where id = any($1::uuid[])`, [[...cleanupTeamIds]])],
    ["clubs", () => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function cookieFor(token) {
  return `optimove_session=${token}`;
}

// Deliberately does NOT auto-grant any matching real role - several tests
// need a fixture with a role_hint string and explicitly no real row, to
// prove that string alone grants nothing.
async function makeUser({ email, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, true)
     returning id, email, role_hint`,
    [email, hashPassword("irrelevant-password-123"), roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function grantGlobalRoleDirectly(userId, role) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active, granted_by_user_id)
     values ($1, $2, true, $1)
     on conflict (user_id, role) do update set is_active = true, revoked_at = null, revoked_by_user_id = null, updated_at = now()`,
    [userId, role],
  );
}

async function makeClub(name) {
  const result = await query(`insert into public.clubs (name, is_active) values ($1, true) returning id`, [name]);
  cleanupClubIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeTeam(clubId, name) {
  const result = await query(`insert into public.teams (club_id, name, is_active) values ($1, $2, true) returning id`, [clubId, name]);
  cleanupTeamIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function grantClubAdminDirectly(userId, clubId) {
  await query(
    `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)
     on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now()`,
    [userId, clubId],
  );
}

async function grantTeamCoachDirectly(userId, teamId) {
  await query(
    `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)
     on conflict (user_id, team_id, role) do update set is_active = true, updated_at = now()`,
    [userId, teamId],
  );
}

async function makeAthleteLinkedTo(userId) {
  const externalId = `scoped${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Role', 'Test', 'Role Test', 'Role Test', $2, true)
     returning id`,
    [externalId, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function sessionCountFor(userId) {
  const result = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [userId]);
  return result.rows[0].c;
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

async function makeClubAdmin(email, clubId) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubId);
  return admin;
}

// --- 1/2: platform admin grants/revokes both scoped roles anywhere ---

test("1. a platform admin can grant and revoke club_admin in any club", async () => {
  const club = await makeClub(`Scoped Club A ${Date.now()}`);
  const admin = await makePlatformAdmin(`scoped-pa-club-${Date.now()}@test.local`);
  const target = await makeUser({ email: `scoped-pa-club-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const grant = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.clubRoles.find((r) => r.clubId === club).isActive, true);

  // Grant a second admin first so the revoke below isn't blocked as the last one.
  const second = await makeClubAdmin(`scoped-pa-club-second-${Date.now()}@test.local`, club);

  const revoke = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.clubRoles.find((r) => r.clubId === club).isActive, false);
});

test("2. a platform admin can grant and revoke team_coach in any team", async () => {
  const club = await makeClub(`Scoped Club B ${Date.now()}`);
  const team = await makeTeam(club, "Team B");
  const admin = await makePlatformAdmin(`scoped-pa-team-${Date.now()}@test.local`);
  const target = await makeUser({ email: `scoped-pa-team-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const grant = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.teamRoles.find((r) => r.teamId === team).isActive, true);

  const revoke = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.teamRoles.find((r) => r.teamId === team).isActive, false);
});

// --- 3/4: a club admin is scoped to their own club (and its teams) ---

test("3. a club admin can grant/revoke club_admin only within their own club", async () => {
  const clubA = await makeClub(`Scoped Club C ${Date.now()}`);
  const clubB = await makeClub(`Scoped Club D ${Date.now()}`);
  const admin = await makeClubAdmin(`scoped-ca-own-${Date.now()}@test.local`, clubA);
  const target = await makeUser({ email: `scoped-ca-own-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const ownClub = await api(`/api/organization/users/${target.id}/club-roles/${clubA}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(ownClub.status, 200, "a club admin must be able to grant club_admin within their own club");

  const otherClub = await api(`/api/organization/users/${target.id}/club-roles/${clubB}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(otherClub.status, 200, "a club admin must never be able to grant club_admin in a club they don't administer");

  const row = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [target.id, clubB]);
  assert.equal(row.rowCount, 0, "no row may have been created for the outside club");
});

test("4. a club admin can grant/revoke team_coach only for a team that belongs to their own club", async () => {
  const clubA = await makeClub(`Scoped Club E ${Date.now()}`);
  const clubB = await makeClub(`Scoped Club F ${Date.now()}`);
  const teamInOwnClub = await makeTeam(clubA, "Team E");
  const teamInOtherClub = await makeTeam(clubB, "Team F");
  const admin = await makeClubAdmin(`scoped-ca-team-${Date.now()}@test.local`, clubA);
  const target = await makeUser({ email: `scoped-ca-team-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const ownTeam = await api(`/api/organization/users/${target.id}/team-roles/${teamInOwnClub}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(ownTeam.status, 200, "a club admin must be able to grant team_coach for a team in their own club");

  const otherTeam = await api(`/api/organization/users/${target.id}/team-roles/${teamInOtherClub}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(otherTeam.status, 200, "a club admin must never be able to grant team_coach for a team outside their own club");

  const row = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2 and role = 'team_coach'`, [target.id, teamInOtherClub]);
  assert.equal(row.rowCount, 0);
});

// --- 5-8: nobody else can grant/revoke, regardless of role_hint ---

test("5. a team coach cannot grant or revoke any scoped role, including on their own team", async () => {
  const club = await makeClub(`Scoped Club G ${Date.now()}`);
  const team = await makeTeam(club, "Team G");
  const coach = await makeUser({ email: `scoped-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamCoachDirectly(coach.id, team);
  const target = await makeUser({ email: `scoped-teamcoach-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(coach.id);

  const grantTeam = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(grantTeam.status, 200, "a team coach must never be able to grant team_coach, even on their own team");

  const grantClub = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(grantClub.status, 200, "a team coach must never be able to grant club_admin");

  // Revoking their own team_coach role must also be refused (they have no
  // assignment rights at all, not even to remove themselves).
  const revokeSelf = await api(`/api/organization/users/${coach.id}/team-roles/${team}/team_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.notEqual(revokeSelf.status, 200);
  const stillActive = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2`, [coach.id, team]);
  assert.equal(stillActive.rows[0].is_active, true, "the team coach's own role must be untouched by their own rejected request");
});

test("6. an independent/private coach cannot grant or revoke scoped roles from that global role alone", async () => {
  const club = await makeClub(`Scoped Club H ${Date.now()}`);
  const team = await makeTeam(club, "Team H");
  const coach = await makeUser({ email: `scoped-indie-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  const target = await makeUser({ email: `scoped-indie-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(coach.id);

  const grantClub = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(grantClub.status, 200);
  const grantTeam = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(grantTeam.status, 200);
});

test("7. an athlete-only account and a plain generic user cannot grant or revoke scoped roles", async () => {
  const club = await makeClub(`Scoped Club I ${Date.now()}`);
  const athleteUser = await makeUser({ email: `scoped-athlete-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(athleteUser.id);
  const genericUser = await makeUser({ email: `scoped-generic-${Date.now()}@test.local`, roleHint: "user" });
  const target = await makeUser({ email: `scoped-plain-target-${Date.now()}@test.local`, roleHint: "user" });

  for (const actor of [athleteUser, genericUser]) {
    const token = await createSession(actor.id);
    const res = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
    assert.notEqual(res.status, 200, `${actor.email} must not be able to grant club_admin`);
  }
});

test("8. a fake role_hint claiming club_admin/team_coach/platform_admin with no real row grants nothing", async () => {
  const club = await makeClub(`Scoped Club J ${Date.now()}`);
  const team = await makeTeam(club, "Team J");
  const target = await makeUser({ email: `scoped-fake-target-${Date.now()}@test.local`, roleHint: "user" });

  for (const roleHint of ["club_admin", "team_coach", "platform_admin"]) {
    const fake = await makeUser({ email: `scoped-fake-${roleHint}-${Date.now()}@test.local`, roleHint });
    const token = await createSession(fake.id);
    const res = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
    assert.notEqual(res.status, 200, `role_hint='${roleHint}' with no real row must not grant club_admin assignment rights`);
    const res2 = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
    assert.notEqual(res2.status, 200, `role_hint='${roleHint}' with no real row must not grant team_coach assignment rights`);
  }
});

// --- 9: idempotency ---

test("9. granting an already-active role, and revoking an already-inactive/nonexistent role, are both idempotent 200s", async () => {
  const club = await makeClub(`Scoped Club K ${Date.now()}`);
  const admin = await makePlatformAdmin(`scoped-idem-admin-${Date.now()}@test.local`);
  const second = await makeClubAdmin(`scoped-idem-second-${Date.now()}@test.local`, club);
  const target = await makeUser({ email: `scoped-idem-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const grant1 = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(grant1.status, 200);
  const grant2 = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(grant2.status, 200, "granting an already-active role must be idempotent");
  const activeRows = grant2.body.clubRoles.filter((r) => r.clubId === club && r.isActive);
  assert.equal(activeRows.length, 1, "granting twice must not create a duplicate row");

  const revoke1 = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke1.status, 200);
  const revoke2 = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke2.status, 200, "revoking an already-inactive role must be idempotent");

  const neverGranted = await makeUser({ email: `scoped-idem-never-${Date.now()}@test.local`, roleHint: "user" });
  const revokeNever = await api(`/api/organization/users/${neverGranted.id}/team-roles/${club}/team_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revokeNever.status, 404, "revoking a role that was never granted on a nonexistent team id returns 404, not a 500");
});

// --- 10: cross-club team rejection ---

test("10. a team belonging to a different club than the one implied by the actor's scope is rejected", async () => {
  const clubA = await makeClub(`Scoped Club L ${Date.now()}`);
  const clubB = await makeClub(`Scoped Club M ${Date.now()}`);
  const teamInB = await makeTeam(clubB, "Team M");
  const adminOfA = await makeClubAdmin(`scoped-crossclub-${Date.now()}@test.local`, clubA);
  const target = await makeUser({ email: `scoped-crossclub-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(adminOfA.id);

  const res = await api(`/api/organization/users/${target.id}/team-roles/${teamInB}/team_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.notEqual(res.status, 200, "a club admin of club A must not be able to grant team_coach for a team that belongs to club B");
});

// --- 11/12: last club admin protection ---

test("11. the last active club_admin of a club cannot be removed", async () => {
  const club = await makeClub(`Scoped Club N ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-lastadmin-${Date.now()}@test.local`, club);
  const token = await createSession(soleAdmin.id);

  const res = await api(`/api/organization/users/${soleAdmin.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "LAST_CLUB_ADMIN");

  const row = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2`, [soleAdmin.id, club]);
  assert.equal(row.rows[0].is_active, true, "the last admin's role must remain active after a rejected revoke");
});

test("11b. a platform admin cannot bypass LAST_CLUB_ADMIN with an ordinary revoke call", async () => {
  const club = await makeClub(`Scoped Club O ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-lastadmin-target-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-lastadmin-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const res = await api(`/api/organization/users/${soleAdmin.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 409, "a platform admin must not be able to bypass the last-club-admin protection");
  assert.equal(res.body.error, "LAST_CLUB_ADMIN");
});

test("12. two concurrent revoke requests, each targeting a DIFFERENT one of the club's two admins, never leave zero admins", async () => {
  const club = await makeClub(`Scoped Club P ${Date.now()}`);
  const admin1 = await makeClubAdmin(`scoped-concurrent-1-${Date.now()}@test.local`, club);
  const admin2 = await makeClubAdmin(`scoped-concurrent-2-${Date.now()}@test.local`, club);
  const token1 = await createSession(admin1.id);
  const token2 = await createSession(admin2.id);

  // Each admin revokes their OWN role at the same time - with exactly two
  // qualifying admins to start, the first request to acquire the lock must
  // see "2 left" and succeed; the second must then see "1 left" and be
  // rejected as the last one. This is the real race the lock exists to
  // serialize, not two actors both targeting the SAME already-last admin
  // (which would trivially reject both, proving nothing about the lock).
  const [resA, resB] = await Promise.all([
    api(`/api/organization/users/${admin1.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token1) }),
    api(`/api/organization/users/${admin2.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token2) }),
  ]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one concurrent revoke must succeed and the other must be rejected as the last admin");

  const remaining = await query(
    `select count(*)::int as c from public.user_club_roles where club_id = $1 and role = 'club_admin' and is_active = true`,
    [club],
  );
  assert.equal(remaining.rows[0].c, 1, "the club must still have exactly one active admin after the race");
});

// --- 13: revoke team_coach touches nothing else ---

test("13. revoking team_coach never changes login, sessions, global roles, athlete profile, or other memberships", async () => {
  const club = await makeClub(`Scoped Club Q ${Date.now()}`);
  const team = await makeTeam(club, "Team Q");
  const otherTeam = await makeTeam(club, "Team Q2");
  const admin = await makePlatformAdmin(`scoped-touch-admin-${Date.now()}@test.local`);
  const target = await makeUser({ email: `scoped-touch-target-${Date.now()}@test.local`, roleHint: "athlete" });
  await grantTeamCoachDirectly(target.id, team);
  await grantTeamCoachDirectly(target.id, otherTeam);
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  const athleteId = await makeAthleteLinkedTo(target.id);
  await createSession(target.id);
  const token = await createSession(admin.id);
  assert.equal(await sessionCountFor(target.id), 1);

  const res = await api(`/api/organization/users/${target.id}/team-roles/${team}/team_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);

  const userRow = await query(`select role_hint, is_active from public.users where id = $1`, [target.id]);
  assert.equal(userRow.rows[0].role_hint, "athlete", "role_hint must be untouched");
  assert.equal(userRow.rows[0].is_active, true, "login status must be untouched");
  assert.equal(await sessionCountFor(target.id), 1, "sessions must be untouched");

  const globalRole = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [target.id]);
  assert.equal(globalRole.rows[0].is_active, true, "the independent_coach global role must be untouched");

  const athleteRow = await query(`select is_active, user_id from public.athletes where id = $1`, [athleteId]);
  assert.equal(athleteRow.rows[0].is_active, true, "the athlete profile must be untouched");
  assert.equal(athleteRow.rows[0].user_id, target.id, "the athlete link must be untouched");

  const otherTeamRole = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2`, [target.id, otherTeam]);
  assert.equal(otherTeamRole.rows[0].is_active, true, "the OTHER team's team_coach role must be untouched");

  const revokedTeamRole = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2`, [target.id, team]);
  assert.equal(revokedTeamRole.rows[0].is_active, false, "only the targeted team's role must actually be revoked");
});

// --- 14: audit fields ---

test("14. grant sets grantedByUserId and clears any prior revoke audit fields; revoke sets revokedAt/revokedByUserId", async () => {
  const club = await makeClub(`Scoped Club R ${Date.now()}`);
  const admin = await makeClubAdmin(`scoped-audit-admin-${Date.now()}@test.local`, club);
  const other = await makeClubAdmin(`scoped-audit-other-${Date.now()}@test.local`, club);
  const target = await makeUser({ email: `scoped-audit-target-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);
  const otherToken = await createSession(other.id);

  const grant = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(adminToken) });
  const grantedRow = grant.body.clubRoles.find((r) => r.clubId === club);
  assert.equal(grantedRow.grantedByUserId, admin.id);
  assert.equal(grantedRow.revokedAt, null);
  assert.equal(grantedRow.revokedByUserId, null);

  const revoke = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(otherToken) });
  const revokedRow = revoke.body.clubRoles.find((r) => r.clubId === club);
  assert.equal(revokedRow.isActive, false);
  assert.equal(revokedRow.revokedByUserId, other.id);
  assert.ok(revokedRow.revokedAt, "revokedAt must be set");

  const regrant = await api(`/api/organization/users/${target.id}/club-roles/${club}/club_admin`, { method: "PUT", cookie: cookieFor(adminToken) });
  const regrantedRow = regrant.body.clubRoles.find((r) => r.clubId === club);
  assert.equal(regrantedRow.isActive, true);
  assert.equal(regrantedRow.revokedAt, null, "reactivating must clear the prior revoke audit fields");
  assert.equal(regrantedRow.revokedByUserId, null);
});

// --- 15: the legacy endpoint cannot bypass the new rules ---

test("15. the legacy POST /club-roles endpoint enforces the exact same scope check as the new endpoint", async () => {
  const clubA = await makeClub(`Scoped Club S ${Date.now()}`);
  const clubB = await makeClub(`Scoped Club T ${Date.now()}`);
  const admin = await makeClubAdmin(`scoped-legacy-${Date.now()}@test.local`, clubA);
  const target = await makeUser({ email: `scoped-legacy-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const outsideAttempt = await api("/api/organization/club-roles", {
    method: "POST",
    cookie: cookieFor(token),
    body: { userId: target.id, clubId: clubB },
  });
  assert.notEqual(outsideAttempt.status, 201, "the legacy endpoint must not grant club_admin in a club the actor does not administer");
  assert.notEqual(outsideAttempt.status, 200);

  const row = await query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2`, [target.id, clubB]);
  assert.equal(row.rowCount, 0);

  const ownClubAttempt = await api("/api/organization/club-roles", {
    method: "POST",
    cookie: cookieFor(token),
    body: { userId: target.id, clubId: clubA },
  });
  assert.equal(ownClubAttempt.status, 200, "the legacy endpoint must still work for a club the actor genuinely administers");
});

// --- 16-22: LAST_CLUB_ADMIN protection extended to the login-status disable path ---

test("16. disabling the login of the last active club_admin of an active club is rejected with 409 LAST_CLUB_ADMIN, login and sessions untouched", async () => {
  const club = await makeClub(`Scoped Club V ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-loginlast-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-loginlast-pa-${Date.now()}@test.local`);
  await createSession(soleAdmin.id);
  const token = await createSession(platformAdmin.id);
  assert.equal(await sessionCountFor(soleAdmin.id), 1);

  const res = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "LAST_CLUB_ADMIN");

  const row = await query(`select is_active from public.users where id = $1`, [soleAdmin.id]);
  assert.equal(row.rows[0].is_active, true, "the last club admin's login must remain enabled after a rejected disable");
  assert.equal(await sessionCountFor(soleAdmin.id), 1, "sessions must be untouched by a rejected disable");
});

test("17. when a club has two usable club_admins, disabling one of their logins succeeds", async () => {
  const club = await makeClub(`Scoped Club W ${Date.now()}`);
  const admin1 = await makeClubAdmin(`scoped-logintwo-1-${Date.now()}@test.local`, club);
  const admin2 = await makeClubAdmin(`scoped-logintwo-2-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-logintwo-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const res = await api(`/api/organization/users/${admin1.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(res.status, 200, "disabling one of two usable club admins must succeed");

  const row = await query(`select is_active from public.users where id = $1`, [admin1.id]);
  assert.equal(row.rows[0].is_active, false);
  const otherRow = await query(`select is_active from public.users where id = $1`, [admin2.id]);
  assert.equal(otherRow.rows[0].is_active, true, "the other admin's login must remain untouched");
});

test("18. a platform admin cannot disable the login of the last club admin - must grant another admin first", async () => {
  const club = await makeClub(`Scoped Club X ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-loginbypass-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-loginbypass-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const blocked = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(blocked.status, 409, "a platform admin must not be able to bypass LAST_CLUB_ADMIN via login-status");
  assert.equal(blocked.body.error, "LAST_CLUB_ADMIN");

  // Grant a second admin first, then the original disable must succeed.
  const second = await makeClubAdmin(`scoped-loginbypass-second-${Date.now()}@test.local`, club);
  const allowed = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(allowed.status, 200, "once a second admin exists, the original account's login can be disabled");
});

test("19. re-enabling a login still works and needs no LAST_CLUB_ADMIN check", async () => {
  const club = await makeClub(`Scoped Club Y ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-reenable-${Date.now()}@test.local`, club);
  const second = await makeClubAdmin(`scoped-reenable-second-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-reenable-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const disable = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(disable.status, 200);

  const reenable = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: true },
  });
  assert.equal(reenable.status, 200, "re-enabling a login must always work, even though this club would then have only one qualifying admin again");
  const row = await query(`select is_active from public.users where id = $1`, [soleAdmin.id]);
  assert.equal(row.rows[0].is_active, true);
});

test("20. an archived club does not block disabling the login of, or revoking, its last club_admin", async () => {
  const club = await makeClub(`Scoped Club Z ${Date.now()}`);
  const soleAdmin = await makeClubAdmin(`scoped-archived-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-archived-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);
  await query(`update public.clubs set is_active = false where id = $1`, [club]);

  const disableRes = await api(`/api/organization/users/${soleAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(disableRes.status, 200, "an archived club must not block disabling its last club_admin's login");

  // Re-enable, then prove the revoke endpoint is equally unblocked.
  await api(`/api/organization/users/${soleAdmin.id}/login-status`, { method: "PUT", cookie: cookieFor(token), body: { active: true } });
  const revokeRes = await api(`/api/organization/users/${soleAdmin.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revokeRes.status, 200, "an archived club must not block revoking its last club_admin role");
});

test("21. concurrent revoke(admin A) + disable-login(admin B), the only two admins of the same club: exactly one succeeds, and at least one login-active + role-active club_admin remains", async () => {
  const club = await makeClub(`Scoped Club AA ${Date.now()}`);
  const adminA = await makeClubAdmin(`scoped-concur-a-${Date.now()}@test.local`, club);
  const adminB = await makeClubAdmin(`scoped-concur-b-${Date.now()}@test.local`, club);
  const platformAdmin = await makePlatformAdmin(`scoped-concur-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const [revokeA, disableB] = await Promise.all([
    api(`/api/organization/users/${adminA.id}/club-roles/${club}/club_admin`, { method: "DELETE", cookie: cookieFor(token) }),
    api(`/api/organization/users/${adminB.id}/login-status`, { method: "PUT", cookie: cookieFor(token), body: { active: false } }),
  ]);
  const statuses = [revokeA.status, disableB.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one of the concurrent revoke/disable must succeed and the other must be rejected as the last admin");

  const qualifying = await query(
    `select u.id
     from public.users u
     join public.user_club_roles r on r.user_id = u.id and r.club_id = $1 and r.role = 'club_admin' and r.is_active = true
     where u.is_active = true`,
    [club],
  );
  assert.ok(qualifying.rowCount >= 1, "at least one login-active + role-active club_admin must remain after the race");
});

test("22. disabling the login of a user who administers multiple clubs does not deadlock and leaves no club adminless", async () => {
  const clubOne = await makeClub(`Scoped Club BB1 ${Date.now()}`);
  const clubTwo = await makeClub(`Scoped Club BB2 ${Date.now()}`);
  const multiAdmin = await makeClubAdmin(`scoped-multi-${Date.now()}@test.local`, clubOne);
  await grantClubAdminDirectly(multiAdmin.id, clubTwo);
  // A second admin only on clubTwo, so disabling multiAdmin's login must be
  // blocked by clubOne (where multiAdmin is the sole qualifying admin), not
  // by clubTwo - proving both clubs are actually checked.
  const secondOnTwo = await makeClubAdmin(`scoped-multi-second-${Date.now()}@test.local`, clubTwo);
  const platformAdmin = await makePlatformAdmin(`scoped-multi-pa-${Date.now()}@test.local`);
  const token = await createSession(platformAdmin.id);

  const blocked = await api(`/api/organization/users/${multiAdmin.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { active: false },
  });
  assert.equal(blocked.status, 409, "must be blocked because clubOne would be left without a qualifying admin");
  assert.equal(blocked.body.error, "LAST_CLUB_ADMIN");

  // Now run it concurrently from two different actors to also exercise the
  // deterministic multi-lock ordering under real concurrency: one platform
  // admin disabling multiAdmin's login, another revoking multiAdmin's role
  // in clubTwo at the same time. Neither club may end up adminless, and the
  // pair must not hang (a real deadlock would cause this test to time out).
  const secondPlatformAdmin = await makePlatformAdmin(`scoped-multi-pa2-${Date.now()}@test.local`);
  const token2 = await createSession(secondPlatformAdmin.id);
  const [disableRes, revokeClubTwoRes] = await Promise.all([
    api(`/api/organization/users/${multiAdmin.id}/login-status`, { method: "PUT", cookie: cookieFor(token), body: { active: false } }),
    api(`/api/organization/users/${multiAdmin.id}/club-roles/${clubTwo}/club_admin`, { method: "DELETE", cookie: cookieFor(token2) }),
  ]);
  assert.equal(disableRes.status, 409, "clubOne still has no second admin, so disabling multiAdmin's login must still be rejected");
  assert.equal(revokeClubTwoRes.status, 200, "revoking multiAdmin's clubTwo role must succeed since clubTwo still has secondOnTwo as a qualifying admin");

  const clubOneQualifying = await query(
    `select u.id from public.users u
     join public.user_club_roles r on r.user_id = u.id and r.club_id = $1 and r.role = 'club_admin' and r.is_active = true
     where u.is_active = true`,
    [clubOne],
  );
  assert.ok(clubOneQualifying.rowCount >= 1, "clubOne must still have a qualifying admin");
  const clubTwoQualifying = await query(
    `select u.id from public.users u
     join public.user_club_roles r on r.user_id = u.id and r.club_id = $1 and r.role = 'club_admin' and r.is_active = true
     where u.is_active = true`,
    [clubTwo],
  );
  assert.ok(clubTwoQualifying.rowCount >= 1, "clubTwo must still have a qualifying admin");
});

test("15b. the legacy POST /team-roles endpoint no longer lets a team_coach grant team_coach on their own team", async () => {
  const club = await makeClub(`Scoped Club U ${Date.now()}`);
  const team = await makeTeam(club, "Team U");
  const coach = await makeUser({ email: `scoped-legacy-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamCoachDirectly(coach.id, team);
  const target = await makeUser({ email: `scoped-legacy-teamcoach-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(coach.id);

  const res = await api("/api/organization/team-roles", {
    method: "POST",
    cookie: cookieFor(token),
    body: { userId: target.id, teamId: team },
  });
  assert.notEqual(res.status, 200, "the legacy endpoint must no longer allow a team_coach to grant team_coach on their own team");
  assert.notEqual(res.status, 201);

  const row = await query(`select 1 from public.user_team_roles where user_id = $1 and team_id = $2`, [target.id, team]);
  assert.equal(row.rowCount, 0);
});
