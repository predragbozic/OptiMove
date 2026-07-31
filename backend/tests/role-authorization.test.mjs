import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (cleanupAthleteIds.size) await query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]]);
  if (cleanupTeamIds.size) await query(`delete from public.teams where id = any($1::uuid[])`, [[...cleanupTeamIds]]);
  if (cleanupClubIds.size) await query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]]);
  if (cleanupUserIds.size) await query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
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

async function makeUser({ email, roleHint = "coach" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, true)
     returning id, email`,
    [email, hashPassword("irrelevant-password-123"), roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
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

async function makeAthlete({ clubId = null, teamId = null, userId = null } = {}) {
  // Keep the numeric portion short: loadManagedAthletes sorts by casting
  // digits-only(athlete_id) to a 32-bit int, so a long digit run (e.g. a raw
  // Date.now() timestamp) overflows it.
  const externalId = `ra${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, club_id, team_id, user_id, is_active)
     values ($1, $1, 'Role', 'Test', 'Role Test', 'Role Test', $2, $3, $4, true)
     returning id`,
    [externalId, clubId, teamId, userId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  // Authorization now comes from athlete_memberships (active rows), not the
  // legacy club_id/team_id columns above - a fixture that only sets those
  // columns would no longer be manageable by a club/team-scoped actor.
  if (clubId) {
    await query(
      `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
       values ($1, $2, null, 'club', 'active')
       on conflict (athlete_id, club_id) where status = 'active' and membership_type = 'club' do nothing`,
      [athleteId, clubId],
    );
  }
  if (teamId) {
    await query(
      `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
       values ($1, $2, $3, 'team', 'active')
       on conflict (athlete_id, team_id) where status = 'active' and membership_type = 'team' do nothing`,
      [athleteId, clubId, teamId],
    );
  }
  return athleteId;
}

async function grantClubRole(userId, clubId, active = true) {
  await query(
    `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', $3)
     on conflict (user_id, club_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, clubId, active],
  );
}

async function grantTeamRole(userId, teamId, active = true) {
  await query(
    `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', $3)
     on conflict (user_id, team_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, teamId, active],
  );
}

async function grantCoachAthleteLink(userId, athleteId) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
    [userId, athleteId],
  );
}

test("1. role_hint='user' with no other roles cannot access coach endpoints", async () => {
  const user = await makeUser({ email: `plain-user-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(user.id);
  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 403);
});

test("2. an athlete with no other roles cannot access coach endpoints", async () => {
  const athleteUser = await makeUser({ email: `plain-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthlete({ userId: athleteUser.id });
  const token = await createSession(athleteUser.id);
  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 403);
});

test("3. an independent coach (role_hint='coach', no scoped roles) can use the coach workspace", async () => {
  const coach = await makeUser({ email: `independent-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const token = await createSession(coach.id);
  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
});

test("4. a club admin can manage their own club", async () => {
  const clubA = await makeClub(`Club A ${Date.now()}`);
  const admin = await makeUser({ email: `club-admin-a-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, clubA);
  const token = await createSession(admin.id);

  const res = await api("/api/organization/teams", {
    method: "POST",
    cookie: cookieFor(token),
    body: { name: "New Team", clubId: clubA },
  });
  assert.equal(res.status, 201);
  cleanupTeamIds.add(res.body.team.id);
});

test("5. a club admin cannot manage a different club", async () => {
  const clubA = await makeClub(`Club A2 ${Date.now()}`);
  const clubB = await makeClub(`Club B ${Date.now()}`);
  const admin = await makeUser({ email: `club-admin-b-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, clubA);
  const token = await createSession(admin.id);

  const res = await api("/api/organization/teams", {
    method: "POST",
    cookie: cookieFor(token),
    body: { name: "Should Fail", clubId: clubB },
  });
  assert.equal(res.status, 403);
});

test("6. a team coach can manage their own team's athlete", async () => {
  const club = await makeClub(`Club TC ${Date.now()}`);
  const teamX = await makeTeam(club, "Team X");
  const athlete = await makeAthlete({ clubId: club, teamId: teamX });
  const coach = await makeUser({ email: `team-coach-x-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, teamX);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/athletes/${athlete}`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { fullName: "Role Test Updated" },
  });
  assert.equal(res.status, 200, "a team coach must be able to manage (edit) an athlete on their own team");
});

test("7. a team coach cannot manage a different team's athlete", async () => {
  const club = await makeClub(`Club TC2 ${Date.now()}`);
  const teamX = await makeTeam(club, "Team X2");
  const teamY = await makeTeam(club, "Team Y2");
  const athleteOnY = await makeAthlete({ clubId: club, teamId: teamY });
  const coach = await makeUser({ email: `team-coach-y-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, teamX);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/athletes/${athleteOnY}`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { fullName: "Should Not Update" },
  });
  assert.equal(res.status, 403);
});

test("8. an independent coach sees only athletes with an active coach relationship", async () => {
  const coach = await makeUser({ email: `sees-only-mine-${Date.now()}@test.local`, roleHint: "coach" });
  const myAthlete = await makeAthlete();
  const otherAthlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, myAthlete);
  const token = await createSession(coach.id);

  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const ids = res.body.athletes.map((a) => a.id);
  assert.ok(ids.includes(myAthlete), "should see the linked athlete");
  assert.ok(!ids.includes(otherAthlete), "should not see an unrelated athlete");
});

test("9. a single account can hold athlete and coach capability at the same time", async () => {
  const club = await makeClub(`Club MultiRole ${Date.now()}`);
  const user = await makeUser({ email: `multi-role-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthlete({ userId: user.id });
  await grantClubRole(user.id, club);
  const token = await createSession(user.id);

  const orgRes = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(orgRes.status, 200, "role_hint='athlete' must not block real club_admin capability");

  const meRes = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(meRes.body.user.capabilities.athleteWorkspace, true);
  assert.equal(meRes.body.user.capabilities.coachWorkspace, true);
});

test("10. a club admin cannot grant platform_admin through the add-user form", async () => {
  const club = await makeClub(`Club NoEscalate ${Date.now()}`);
  const admin = await makeUser({ email: `club-admin-noescalate-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, club);
  const token = await createSession(admin.id);

  const targetEmail = `attempted-platform-admin-${Date.now()}@test.local`;
  const res = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(token),
    body: { email: targetEmail, password: "somepassword123", roleHint: "platform_admin" },
  });
  assert.equal(res.status, 201);
  cleanupUserIds.add(res.body.user.id);
  assert.notEqual(res.body.user.role_hint, "platform_admin");
});

test("11. a hand-crafted request cannot escalate privilege via club-roles", async () => {
  // An independent coach with no club scope at all, manually POSTing to
  // /club-roles trying to grant themselves club_admin on a club they have
  // nothing to do with.
  const club = await makeClub(`Club Escalation Target ${Date.now()}`);
  const coach = await makeUser({ email: `escalation-attempt-${Date.now()}@test.local`, roleHint: "coach" });
  const token = await createSession(coach.id);

  const res = await api("/api/organization/club-roles", {
    method: "POST",
    cookie: cookieFor(token),
    body: { userId: coach.id, clubId: club },
  });
  assert.equal(res.status, 403);

  const check = await query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2`, [coach.id, club]);
  assert.equal(check.rowCount, 0, "no club_admin row should have been created");
});

test("12. deactivating a scoped role immediately revokes the matching access", async () => {
  const club = await makeClub(`Club Revoke ${Date.now()}`);
  const team = await makeTeam(club, "Revoke Team");
  const athlete = await makeAthlete({ clubId: club, teamId: team });
  const coach = await makeUser({ email: `revoke-team-role-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, team, true);
  const token = await createSession(coach.id);

  const before1 = await api(`/api/organization/athletes/${athlete}`, { method: "PUT", cookie: cookieFor(token), body: { fullName: "Still Active" } });
  assert.equal(before1.status, 200, "access should work while the team role is active");

  await grantTeamRole(coach.id, team, false);

  const after1 = await api(`/api/organization/athletes/${athlete}`, { method: "PUT", cookie: cookieFor(token), body: { fullName: "Should Fail Now" } });
  assert.equal(after1.status, 403, "access must be revoked immediately once the scoped role is deactivated");
});

test("13. an account with role_hint='athlete' plus a real club_admin scope can edit its own club", async () => {
  const club = await makeClub(`Multi Club Own ${Date.now()}`);
  const user = await makeUser({ email: `multi-club-own-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthlete({ userId: user.id });
  await grantClubRole(user.id, club);
  const token = await createSession(user.id);

  const res = await api(`/api/organization/clubs/${club}`, { method: "PUT", cookie: cookieFor(token), body: { name: "Renamed Own Club" } });
  assert.equal(res.status, 200, "role_hint='athlete' must not block real club_admin scope");
});

test("14. an account with role_hint='athlete' plus club_admin scope cannot edit a different club", async () => {
  const ownClub = await makeClub(`Multi Club Own2 ${Date.now()}`);
  const otherClub = await makeClub(`Multi Club Other ${Date.now()}`);
  const user = await makeUser({ email: `multi-club-other-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthlete({ userId: user.id });
  await grantClubRole(user.id, ownClub);
  const token = await createSession(user.id);

  const res = await api(`/api/organization/clubs/${otherClub}`, { method: "PUT", cookie: cookieFor(token), body: { name: "Should Not Work" } });
  assert.equal(res.status, 403);
});

test("15. a legacy role_hint='club_admin' account with no scoped user_club_roles row cannot manage any club", async () => {
  const club = await makeClub(`Legacy NoScope Club ${Date.now()}`);
  const user = await makeUser({ email: `legacy-no-scope-${Date.now()}@test.local`, roleHint: "club_admin" });
  const token = await createSession(user.id);

  const res = await api(`/api/organization/clubs/${club}`, { method: "PUT", cookie: cookieFor(token), body: { name: "Should Fail" } });
  assert.equal(res.status, 403, "role_hint alone must never grant club management without a real user_club_roles row");
});

test("17. an archived athlete profile keeps athleteWorkspace=true, and is flagged inactive (not hidden) in the coach's list", async () => {
  const athleteUser = await makeUser({ email: `archived-workspace-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  const coach = await makeUser({ email: `archived-workspace-coach-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(coach.id, athlete);
  // Whole-profile archiving is platform-admin only (see archive-profile) -
  // a coach archiving their own relationship is a different, narrower action
  // covered separately by the coach-relationship archive tests.
  const admin = await makeUser({ email: `archived-workspace-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });

  const coachToken = await createSession(coach.id);
  const before1 = await api("/api/organization", { cookie: cookieFor(coachToken) });
  const beforeRow = before1.body.athletes.find((a) => a.id === athlete);
  assert.ok(beforeRow, "coach should see the athlete while active");
  assert.equal(beforeRow.is_active, true);

  const adminToken = await createSession(admin.id);
  const archiveRes = await api(`/api/organization/athletes/${athlete}/archive-profile`, { method: "DELETE", cookie: cookieFor(adminToken) });
  assert.equal(archiveRes.status, 200);

  const athleteToken = await createSession(athleteUser.id);
  const meRes = await api("/api/auth/me", { cookie: cookieFor(athleteToken) });
  assert.equal(meRes.body.user.capabilities.athleteWorkspace, true, "archiving the profile must not remove athlete login/workspace capability");

  // The Settings "Show archived" list needs archived rows returned (they're
  // just flagged, not hidden) - the frontend does the active/archived split.
  const after1 = await api("/api/organization", { cookie: cookieFor(coachToken) });
  const afterRow = after1.body.athletes.find((a) => a.id === athlete);
  assert.ok(afterRow, "the archived athlete should still be returned, flagged as inactive");
  assert.equal(afterRow.is_active, false);
});

test("18. a generic role_hint='user' account is never presented as a coach via /auth/me", async () => {
  const user = await makeUser({ email: `generic-not-coach-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(user.id);

  const res = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.user.role, "coach", "public role must not present a generic user as a coach");
  assert.equal(res.body.user.capabilities.coachWorkspace, false);
});

test("19. an athlete's login-status toggle works from athletes.user_id directly, not role_hint='athlete'", async () => {
  const admin = await makeUser({ email: `toggle-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  // role_hint is the generic "user" here on purpose (not literally "athlete",
  // and not a coach-ish value either - no staff capability follows from it)
  // - this proves the toggle recognizes the link via athletes.user_id itself,
  // without also tripping the multi-role guard added in test 20+ below.
  const genericLinkedUser = await makeUser({ email: `toggle-generic-${Date.now()}@test.local`, roleHint: "user" });
  const athlete = await makeAthlete({ userId: genericLinkedUser.id });
  const adminToken = await createSession(admin.id);

  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(adminToken),
    body: { active: false },
  });
  assert.equal(res.status, 200, "the toggle must work via athletes.user_id even though role_hint isn't literally 'athlete'");
  assert.equal(res.body.active, false);
});

test("20. a coach cannot deactivate a multi-role athlete+coach account via the athlete login toggle", async () => {
  // The target is genuinely both an athlete and an independent coach.
  const target = await makeUser({ email: `guard-athlete-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete({ userId: target.id });
  const actor = await makeUser({ email: `guard-actor-coach-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(actor.id, athlete);
  const actorToken = await createSession(actor.id);

  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(actorToken),
    body: { active: false },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "MULTI_ROLE_ACCOUNT");

  const targetAfter = await query(`select is_active from public.users where id = $1`, [target.id]);
  assert.equal(targetAfter.rows[0].is_active, true, "the multi-role account's is_active must be untouched");
});

test("21. a club admin cannot deactivate a multi-role athlete+club_admin account via the athlete login toggle", async () => {
  const club = await makeClub(`Guard Club ${Date.now()}`);
  const target = await makeUser({ email: `guard-athlete-clubadmin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(target.id, club);
  const athlete = await makeAthlete({ userId: target.id, clubId: club });

  const actor = await makeUser({ email: `guard-actor-clubadmin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(actor.id, club);
  const actorToken = await createSession(actor.id);

  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(actorToken),
    body: { active: false },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "MULTI_ROLE_ACCOUNT");

  const targetAfter = await query(`select is_active from public.users where id = $1`, [target.id]);
  assert.equal(targetAfter.rows[0].is_active, true, "the multi-role account's is_active must be untouched");
});

test("22. an athlete-only account can still be deactivated through the toggle", async () => {
  const admin = await makeUser({ email: `guard-admin-athleteonly-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const target = await makeUser({ email: `guard-athleteonly-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: target.id });
  const adminToken = await createSession(admin.id);

  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(adminToken),
    body: { active: false },
  });
  assert.equal(res.status, 200, "an athlete with no other roles must still be toggleable");
  assert.equal(res.body.active, false);
});

test("23. deactivating an athlete-only account deletes all of its sessions", async () => {
  const admin = await makeUser({ email: `guard-admin-sessions-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const target = await makeUser({ email: `guard-athleteonly-sessions-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: target.id });
  await createSession(target.id);
  const before = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [target.id]);
  assert.equal(before.rows[0].c, 1);

  const adminToken = await createSession(admin.id);
  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(adminToken),
    body: { active: false },
  });
  assert.equal(res.status, 200);

  const after = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [target.id]);
  assert.equal(after.rows[0].c, 0, "disabling an athlete-only account must revoke its sessions");
});

test("24. a rejected multi-role deactivation attempt changes neither is_active nor sessions", async () => {
  const target = await makeUser({ email: `guard-rejected-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete({ userId: target.id });
  const targetSessionToken = await createSession(target.id);
  const before = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [target.id]);
  assert.equal(before.rows[0].c, 1);

  const actor = await makeUser({ email: `guard-rejected-actor-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(actor.id, athlete);
  const actorToken = await createSession(actor.id);

  const res = await api(`/api/organization/athletes/${athlete}/login-status`, {
    method: "PUT",
    cookie: cookieFor(actorToken),
    body: { active: false },
  });
  assert.equal(res.status, 409);

  const targetAfter = await query(`select is_active from public.users where id = $1`, [target.id]);
  assert.equal(targetAfter.rows[0].is_active, true, "is_active must be untouched after a rejected attempt");

  const after = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [target.id]);
  assert.equal(after.rows[0].c, 1, "sessions must not be revoked after a rejected attempt");

  const meRes = await api("/api/auth/me", { cookie: cookieFor(targetSessionToken) });
  assert.notEqual(meRes.body.user, null, "the target's own session must still work after the rejected attempt");
});
