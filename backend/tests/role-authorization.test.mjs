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
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
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

  const res = await api(`/api/organization/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
});

test("7. a team coach cannot manage a different team's athlete", async () => {
  const club = await makeClub(`Club TC2 ${Date.now()}`);
  const teamX = await makeTeam(club, "Team X2");
  const teamY = await makeTeam(club, "Team Y2");
  const athleteOnY = await makeAthlete({ clubId: club, teamId: teamY });
  const coach = await makeUser({ email: `team-coach-y-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, teamX);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/athletes/${athleteOnY}`, { method: "DELETE", cookie: cookieFor(token) });
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
