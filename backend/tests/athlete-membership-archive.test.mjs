import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession } from "../src/auth.js";
import { canUseTemplate } from "../src/programAccessPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260801_athlete_memberships.sql");

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  // Deleting athletes/clubs/teams cascades to athlete_memberships,
  // user_athletes, and plans.plans rows created for these tests. Template
  // plans (athlete_id is null) need their own explicit cleanup.
  if (cleanupPlanIds.size) await query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]]);
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

// Mirrors the exact mapping the real create-user flow now applies
// transactionally (see POST /organization/users) and the backfill migration
// used for pre-existing accounts - a fixture built with roleHint: "coach" (or
// any of the other independent-coach-ish/platform-admin-ish strings) behaves
// exactly as it did before authz.js stopped trusting role_hint directly,
// because it now also gets the matching real user_global_roles row.
const GLOBAL_ROLE_BY_ROLE_HINT = {
  admin: "platform_admin",
  platform_admin: "platform_admin",
  general_admin: "platform_admin",
  coach: "independent_coach",
  independent_coach: "independent_coach",
  fitness_coach: "independent_coach",
  trainer: "independent_coach",
};

async function makeUser({ email, roleHint = "coach" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', 'x', 'Test User', 'Test User', $2, true)
     returning id, email`,
    [email, roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  const globalRole = GLOBAL_ROLE_BY_ROLE_HINT[roleHint];
  if (globalRole) {
    await query(
      `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
       on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
      [result.rows[0].id, globalRole],
    );
  }
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

async function makeAthlete({ userId = null } = {}) {
  const externalId = `am${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Membership', 'Test', 'Membership Test', 'Membership Test', $2, true)
     returning id`,
    [externalId, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function grantClubRole(userId, clubId) {
  await query(
    `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)
     on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now()`,
    [userId, clubId],
  );
}

async function grantTeamRole(userId, teamId) {
  await query(
    `insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)
     on conflict (user_id, team_id, role) do update set is_active = true, updated_at = now()`,
    [userId, teamId],
  );
}

async function grantCoachAthleteLink(userId, athleteId) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
    [userId, athleteId],
  );
}

async function addClubMembership(athleteId, clubId) {
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
     values ($1, $2, null, 'club', 'active')
     on conflict (athlete_id, club_id) where status = 'active' and membership_type = 'club' do nothing`,
    [athleteId, clubId],
  );
}

async function addTeamMembership(athleteId, clubId, teamId) {
  await addClubMembership(athleteId, clubId);
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
     values ($1, $2, $3, 'team', 'active')
     on conflict (athlete_id, team_id) where status = 'active' and membership_type = 'team' do nothing`,
    [athleteId, clubId, teamId],
  );
}

async function membershipStatus(athleteId, { clubId, teamId, membershipType }) {
  const result = await query(
    `select status from public.athlete_memberships
     where athlete_id = $1 and membership_type = $2 and club_id = $3 and team_id is not distinct from $4
     order by created_at desc limit 1`,
    [athleteId, membershipType, clubId, teamId ?? null],
  );
  return result.rows[0]?.status || null;
}

async function sessionCountFor(userId) {
  const result = await query(`select count(*)::int as c from public.auth_sessions where user_id = $1`, [userId]);
  return result.rows[0].c;
}

async function isActiveUser(userId) {
  const result = await query(`select is_active from public.users where id = $1`, [userId]);
  return result.rows[0]?.is_active;
}

async function membershipRowCount(athleteId, { clubId, teamId, membershipType }) {
  const result = await query(
    `select count(*)::int as c from public.athlete_memberships
     where athlete_id = $1 and membership_type = $2 and club_id = $3 and team_id is not distinct from $4`,
    [athleteId, membershipType, clubId, teamId ?? null],
  );
  return result.rows[0].c;
}

test("1. a private coach archives their own relationship and no longer sees the athlete on their active list", async () => {
  const coach = await makeUser({ email: `own-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, athlete);
  const token = await createSession(coach.id);

  const before1 = await api("/api/organization", { cookie: cookieFor(token) });
  assert.ok(before1.body.athletes.some((a) => a.id === athlete), "coach should see the athlete before archiving");

  const archiveRes = await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(archiveRes.status, 200);

  const after1 = await api("/api/organization", { cookie: cookieFor(token) });
  const afterRow = after1.body.athletes.find((a) => a.id === athlete);
  assert.equal(afterRow?.has_my_active_coach_relationship, false, "the relationship must no longer read as active");
  assert.equal(afterRow?.has_my_archived_coach_relationship, true, "the athlete must still surface under Show archived so it can be restored");
});

test("2. a second private coach still sees the same athlete after the first coach archives their own relationship", async () => {
  const coachA = await makeUser({ email: `coach-a-${Date.now()}@test.local`, roleHint: "coach" });
  const coachB = await makeUser({ email: `coach-b-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coachA.id, athlete);
  await grantCoachAthleteLink(coachB.id, athlete);

  const tokenA = await createSession(coachA.id);
  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(tokenA) });

  const tokenB = await createSession(coachB.id);
  const afterB = await api("/api/organization", { cookie: cookieFor(tokenB) });
  assert.ok(afterB.body.athletes.some((a) => a.id === athlete), "the second coach's relationship must be unaffected");
});

test("3. restoring a private coach relationship brings the athlete back", async () => {
  const coach = await makeUser({ email: `restore-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, athlete);
  const token = await createSession(coach.id);

  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(token) });
  const restoreRes = await api(`/api/organization/athletes/${athlete}/coach-relationship/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(restoreRes.status, 200);

  const after1 = await api("/api/organization", { cookie: cookieFor(token) });
  assert.ok(after1.body.athletes.some((a) => a.id === athlete), "the athlete must be visible again after restore");
});

test("4. a team coach removes an athlete only from their own team", async () => {
  const club = await makeClub(`Membership Club A ${Date.now()}`);
  const teamX = await makeTeam(club, "Team X");
  const teamY = await makeTeam(club, "Team Y");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, teamX);
  await addTeamMembership(athlete, club, teamY);
  const coach = await makeUser({ email: `team-remove-coach-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, teamX);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/teams/${teamX}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);

  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: teamX, membershipType: "team" }), "archived");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: teamY, membershipType: "team" }), "active", "the other team membership must be untouched");
});

test("5. a team coach cannot remove an athlete from a different team", async () => {
  const club = await makeClub(`Membership Club B ${Date.now()}`);
  const teamX = await makeTeam(club, "Team X2");
  const teamY = await makeTeam(club, "Team Y2");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, teamY);
  const coach = await makeUser({ email: `team-remove-wrong-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, teamX);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/teams/${teamY}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 403);
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: teamY, membershipType: "team" }), "active", "an unauthorized attempt must not change the membership");
});

test("6. a club admin archives a membership only in their own club", async () => {
  const clubA = await makeClub(`Membership Club C ${Date.now()}`);
  const clubB = await makeClub(`Membership Club D ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, clubA);
  const admin = await makeUser({ email: `club-admin-own-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, clubA);
  const token = await createSession(admin.id);

  const okRes = await api(`/api/organization/clubs/${clubA}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(okRes.status, 200);

  const otherAthlete = await makeAthlete();
  await addClubMembership(otherAthlete, clubB);
  const forbiddenRes = await api(`/api/organization/clubs/${clubB}/athletes/${otherAthlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(forbiddenRes.status, 403, "a club admin must not be able to archive a membership in a club they don't manage");
});

test("7. archiving a club membership ends active team memberships within that club only", async () => {
  const club = await makeClub(`Membership Club E ${Date.now()}`);
  const team = await makeTeam(club, "Team E");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const admin = await makeUser({ email: `club-cascade-admin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, club);
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);

  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: null, membershipType: "club" }), "archived");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "archived", "the team membership within the archived club must also be archived");
});

test("8. an athlete's membership in a different club remains untouched when one club is archived", async () => {
  const clubA = await makeClub(`Membership Club F ${Date.now()}`);
  const clubB = await makeClub(`Membership Club G ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, clubA);
  await addClubMembership(athlete, clubB);
  const admin = await makeUser({ email: `club-independent-admin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, clubA);
  const token = await createSession(admin.id);

  await api(`/api/organization/clubs/${clubA}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  assert.equal(await membershipStatus(athlete, { clubId: clubA, teamId: null, membershipType: "club" }), "archived");
  assert.equal(await membershipStatus(athlete, { clubId: clubB, teamId: null, membershipType: "club" }), "active", "membership in the other club must be unaffected");
});

test("9. archiving any relationship never changes users.is_active", async () => {
  const club = await makeClub(`Membership Club H ${Date.now()}`);
  const team = await makeTeam(club, "Team H");
  const athleteUser = await makeUser({ email: `no-deactivate-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addTeamMembership(athlete, club, team);
  const coach = await makeUser({ email: `no-deactivate-coach-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(coach.id, athlete);
  const admin = await makeUser({ email: `no-deactivate-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const adminToken = await createSession(admin.id);
  const coachToken = await createSession(coach.id);

  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(coachToken) });
  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });
  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });

  assert.equal(await isActiveUser(athleteUser.id), true, "the athlete's login must remain active through all three relationship archives");
});

test("10. archiving any relationship never deletes the athlete's sessions", async () => {
  const club = await makeClub(`Membership Club I ${Date.now()}`);
  const team = await makeTeam(club, "Team I");
  const athleteUser = await makeUser({ email: `no-session-wipe-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addTeamMembership(athlete, club, team);
  await createSession(athleteUser.id);
  assert.equal(await sessionCountFor(athleteUser.id), 1);

  const admin = await makeUser({ email: `no-session-wipe-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const adminToken = await createSession(admin.id);

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });
  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });

  assert.equal(await sessionCountFor(athleteUser.id), 1, "the athlete's own session must survive every relationship archive");
});

test("11. an athlete with no active coach or club membership still has an athlete workspace", async () => {
  const athleteUser = await makeUser({ email: `standalone-workspace-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthlete({ userId: athleteUser.id });
  const token = await createSession(athleteUser.id);

  const meRes = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(meRes.body.user.capabilities.athleteWorkspace, true, "an athlete's workspace must not depend on having any active coach/club/team relationship");
});

test("12. historical plans and workouts are not deleted by any relationship archive", async () => {
  const club = await makeClub(`Membership Club J ${Date.now()}`);
  const team = await makeTeam(club, "Team J");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const coach = await makeUser({ email: `plan-keeper-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(coach.id, athlete);
  const admin = await makeUser({ email: `plan-keeper-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const adminToken = await createSession(admin.id);
  const coachToken = await createSession(coach.id);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, is_template)
     values ('program', $1, $2, 'Historical Program', false)
     returning id`,
    [coach.id, athlete],
  );
  const planId = plan.rows[0].id;

  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(coachToken) });
  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });
  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });

  const stillThere = await query(`select id from plans.plans where id = $1`, [planId]);
  assert.equal(stillThere.rows.length, 1, "the historical plan row must still exist after every relationship archive");
});

test("13. the whole-profile archive is not available to a normal coach", async () => {
  const coach = await makeUser({ email: `no-profile-archive-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, athlete);
  const token = await createSession(coach.id);

  const res = await api(`/api/organization/athletes/${athlete}/archive-profile`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 403);

  const profile = await query(`select is_active from public.athletes where id = $1`, [athlete]);
  assert.equal(profile.rows[0].is_active, true, "the profile must remain active after a rejected archive-profile attempt");
});

test("14. a hand-crafted request cannot archive a relationship outside the requester's scope", async () => {
  const club = await makeClub(`Membership Club K ${Date.now()}`);
  const otherClub = await makeClub(`Membership Club K2 ${Date.now()}`);
  const team = await makeTeam(club, "Team K");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const unrelatedCoach = await makeUser({ email: `unrelated-${Date.now()}@test.local`, roleHint: "coach" });
  const token = await createSession(unrelatedCoach.id);

  const teamRes = await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(teamRes.status, 403);

  const clubRes = await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(clubRes.status, 403);

  const coachRelRes = await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(coachRelRes.status, 404, "an actor with no coach relationship of their own has nothing to archive here");

  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "active");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: null, membershipType: "club" }), "active");
  void otherClub;
});

test("15. the athlete_memberships backfill migration is idempotent", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const club = await makeClub(`Migration Idempotent Club ${Date.now()}`);
  const athleteUser = await makeUser({ email: `migration-idempotent-${Date.now()}@test.local`, roleHint: "athlete" });
  // Bypass the API (which now writes memberships directly) and set only the
  // legacy pointer, exactly like a pre-migration production row.
  const legacyAthlete = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, club_id, is_active)
     values ($1, $1, 'Legacy', 'Row', 'Legacy Row', 'Legacy Row', $2, $3, true)
     returning id`,
    [`mi${Math.floor(Math.random() * 900000 + 100000)}`, athleteUser.id, club],
  );
  cleanupAthleteIds.add(legacyAthlete.rows[0].id);

  await pool.query(sql);
  await pool.query(sql);

  const rows = await query(
    `select count(*)::int as c from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active'`,
    [legacyAthlete.rows[0].id, club],
  );
  assert.equal(rows.rows[0].c, 1, "rerunning the migration must not duplicate the backfilled club membership");
});

test("16. a conflict between the athlete's club and the team's club never produces a wrong membership", async () => {
  const declaredClub = await makeClub(`Conflict Declared Club ${Date.now()}`);
  const actualClub = await makeClub(`Conflict Actual Club ${Date.now()}`);
  const team = await makeTeam(actualClub, "Conflict Team");
  const athleteUser = await makeUser({ email: `conflict-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const conflictedAthlete = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, club_id, team_id, is_active)
     values ($1, $1, 'Conflict', 'Row', 'Conflict Row', 'Conflict Row', $2, $3, $4, true)
     returning id`,
    [`cf${Math.floor(Math.random() * 900000 + 100000)}`, athleteUser.id, declaredClub, team],
  );
  cleanupAthleteIds.add(conflictedAthlete.rows[0].id);

  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);

  const teamMembership = await query(
    `select count(*)::int as c from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team'`,
    [conflictedAthlete.rows[0].id, team],
  );
  assert.equal(teamMembership.rows[0].c, 0, "a conflicting row must never be guessed into a team membership");

  const wrongClubMembership = await query(
    `select count(*)::int as c from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active'`,
    [conflictedAthlete.rows[0].id, actualClub],
  );
  assert.equal(wrongClubMembership.rows[0].c, 0, "the team's actual club must never receive a guessed club membership either");
});

test("18. an athlete with two active clubs, a team in each, and two private coaches keeps every other relationship intact when one is archived", async () => {
  const clubA = await makeClub(`Multi Club A ${Date.now()}`);
  const clubB = await makeClub(`Multi Club B ${Date.now()}`);
  const teamA = await makeTeam(clubA, "Multi Team A");
  const teamB = await makeTeam(clubB, "Multi Team B");
  const athleteUser = await makeUser({ email: `multi-relationship-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addTeamMembership(athlete, clubA, teamA);
  await addTeamMembership(athlete, clubB, teamB);
  await createSession(athleteUser.id);

  const coach1 = await makeUser({ email: `multi-coach-1-${Date.now()}@test.local`, roleHint: "coach" });
  const coach2 = await makeUser({ email: `multi-coach-2-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(coach1.id, athlete);
  await grantCoachAthleteLink(coach2.id, athlete);

  const clubAAdmin = await makeUser({ email: `multi-clubadmin-a-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(clubAAdmin.id, clubA);
  const teamACoach = await makeUser({ email: `multi-teamcoach-a-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(teamACoach.id, teamA);

  // Archive just one of the two coach relationships.
  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(await createSession(coach1.id)) });
  // Archive just the team A membership.
  await api(`/api/organization/teams/${teamA}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(await createSession(teamACoach.id)) });

  // Coach 2's relationship, club A membership, club B and its team must all remain active.
  const coach2Link = await query(
    `select is_active from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`,
    [coach2.id, athlete],
  );
  assert.equal(coach2Link.rows[0].is_active, true, "coach 2's relationship must be untouched");
  assert.equal(await membershipStatus(athlete, { clubId: clubA, teamId: null, membershipType: "club" }), "active", "club A membership must survive archiving only its team");
  assert.equal(await membershipStatus(athlete, { clubId: clubA, teamId: teamA, membershipType: "team" }), "archived");
  assert.equal(await membershipStatus(athlete, { clubId: clubB, teamId: null, membershipType: "club" }), "active", "club B membership must be untouched");
  assert.equal(await membershipStatus(athlete, { clubId: clubB, teamId: teamB, membershipType: "team" }), "active", "team B membership must be untouched");

  // Now archive club A's membership entirely - club B and coach 2 must still be untouched.
  await api(`/api/organization/clubs/${clubA}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(await createSession(clubAAdmin.id)) });
  assert.equal(await membershipStatus(athlete, { clubId: clubA, teamId: null, membershipType: "club" }), "archived");
  assert.equal(await membershipStatus(athlete, { clubId: clubB, teamId: null, membershipType: "club" }), "active");
  assert.equal(await membershipStatus(athlete, { clubId: clubB, teamId: teamB, membershipType: "team" }), "active");
  const coach2LinkAfter = await query(
    `select is_active from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`,
    [coach2.id, athlete],
  );
  assert.equal(coach2LinkAfter.rows[0].is_active, true, "coach 2's relationship must still be untouched");
  assert.equal(await isActiveUser(athleteUser.id), true, "login must remain active throughout");
});

test("19. archiving a team membership removes it from active but keeps it visible for restore by the managing team coach", async () => {
  const club = await makeClub(`Show Archived Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Show Archived Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const coach = await makeUser({ email: `show-archived-team-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, team);
  const token = await createSession(coach.id);

  const before1 = await api("/api/organization", { cookie: cookieFor(token) });
  assert.ok(before1.body.athletes.some((a) => a.id === athlete), "team coach should see the athlete while active");

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const afterArchive = await api("/api/organization", { cookie: cookieFor(token) });
  const archivedRow = afterArchive.body.athletes.find((a) => a.id === athlete);
  assert.ok(archivedRow, "the athlete must still be returned so Show archived can render it");
  const archivedMembership = (archivedRow.memberships || []).find((m) => m.membershipType === "team" && String(m.teamId) === String(team));
  assert.equal(archivedMembership?.status, "archived");

  const restoreRes = await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(restoreRes.status, 200, "the frontend-supported restore flow must work");

  const afterRestore = await api("/api/organization", { cookie: cookieFor(token) });
  const restoredRow = afterRestore.body.athletes.find((a) => a.id === athlete);
  const restoredMembership = (restoredRow.memberships || []).find((m) => m.membershipType === "team" && String(m.teamId) === String(team));
  assert.equal(restoredMembership?.status, "active");
});

test("20. archiving a club membership removes it from active but keeps it visible for restore by the managing club admin", async () => {
  const club = await makeClub(`Show Archived Club ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, club);
  const admin = await makeUser({ email: `show-archived-club-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, club);
  const token = await createSession(admin.id);

  const before1 = await api("/api/organization", { cookie: cookieFor(token) });
  assert.ok(before1.body.athletes.some((a) => a.id === athlete));

  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const afterArchive = await api("/api/organization", { cookie: cookieFor(token) });
  const archivedRow = afterArchive.body.athletes.find((a) => a.id === athlete);
  assert.ok(archivedRow, "the athlete must still be returned so Show archived can render it");
  const archivedMembership = (archivedRow.memberships || []).find((m) => m.membershipType === "club" && String(m.clubId) === String(club));
  assert.equal(archivedMembership?.status, "archived");

  const restoreRes = await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(restoreRes.status, 200);

  const afterRestore = await api("/api/organization", { cookie: cookieFor(token) });
  const restoredRow = afterRestore.body.athletes.find((a) => a.id === athlete);
  const restoredMembership = (restoredRow.memberships || []).find((m) => m.membershipType === "club" && String(m.clubId) === String(club));
  assert.equal(restoredMembership?.status, "active");
});

test("21. an archive -> reactivate -> archive -> restore cycle never creates a duplicate team membership row", async () => {
  const club = await makeClub(`Cycle Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Cycle Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const admin = await makeUser({ email: `cycle-team-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1);

  // Reactivate via the real production "assign to team" endpoint.
  const reassign = await api(`/api/organization/teams/${team}/athletes`, { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete } });
  assert.equal(reassign.status, 200);
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "active");
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1, "reactivating must reuse the same row, not insert a new one");

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1);

  const restoreRes = await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(restoreRes.status, 200);
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "active");
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1, "the full cycle must never produce a second row");
});

test("22. an archive -> reactivate -> archive -> restore cycle never creates a duplicate club membership row", async () => {
  const club = await makeClub(`Cycle Club ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, club);
  const admin = await makeUser({ email: `cycle-club-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1);

  // Reactivate via the real production "edit athlete" endpoint.
  const editRes = await api(`/api/organization/athletes/${athlete}`, {
    method: "PUT",
    cookie: cookieFor(token),
    body: { fullName: "Membership Test", clubId: club },
  });
  assert.equal(editRes.status, 200);
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: null, membershipType: "club" }), "active");
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1, "reactivating must reuse the same row, not insert a new one");

  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1);

  const restoreRes = await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(restoreRes.status, 200);
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: null, membershipType: "club" }), "active");
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1);
});

test("23. restoring a team membership twice is idempotent and never duplicates the row", async () => {
  const club = await makeClub(`Dup Restore Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Dup Restore Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const admin = await makeUser({ email: `dup-restore-team-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const first = await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(first.status, 200);
  const second = await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(second.status, 200, "a second restore call must not error");
  assert.equal(second.body.alreadyActive, true);
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1);
});

test("24. restoring a team membership that was never archived is idempotent and never duplicates the row", async () => {
  const club = await makeClub(`Never Archived Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Never Archived Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const admin = await makeUser({ email: `never-archived-team-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyActive, true);
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1);
});

test("25. restoring a club membership twice is idempotent and never duplicates the row", async () => {
  const club = await makeClub(`Dup Restore Club ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, club);
  const admin = await makeUser({ email: `dup-restore-club-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const first = await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(first.status, 200);
  const second = await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(second.status, 200, "a second restore call must not error");
  assert.equal(second.body.alreadyActive, true);
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1);
});

test("26. restoring a club membership that was never archived is idempotent and never duplicates the row", async () => {
  const club = await makeClub(`Never Archived Club ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, club);
  const admin = await makeUser({ email: `never-archived-club-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyActive, true);
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: null, membershipType: "club" }), 1);
});

test("27. two concurrent restore requests for the same team membership never produce a duplicate active row", async () => {
  const club = await makeClub(`Concurrent Restore Club ${Date.now()}`);
  const team = await makeTeam(club, "Concurrent Restore Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const admin = await makeUser({ email: `concurrent-restore-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(admin.id);

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const [r1, r2] = await Promise.all([
    api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) }),
    api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) }),
  ]);
  assert.ok([r1.status, r2.status].every((status) => status === 200), "neither concurrent restore call should error");
  assert.equal(await membershipRowCount(athlete, { clubId: club, teamId: team, membershipType: "team" }), 1, "concurrent restores must never create a duplicate row");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "active");
});

test("28. an athlete active in two scopes sees content from both, and archiving one membership removes only that scope's access", async () => {
  const clubA = await makeClub(`Scope Club A ${Date.now()}`);
  const teamA = await makeTeam(clubA, "Scope Team A");
  const clubB = await makeClub(`Scope Club B ${Date.now()}`);
  const athleteUser = await makeUser({ email: `scope-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addTeamMembership(athlete, clubA, teamA);
  await addClubMembership(athlete, clubB);

  await query(
    `insert into public.athlete_library_access (athlete_id, can_view_team_library, can_view_club_library)
     values ($1, true, true)
     on conflict (athlete_id) do update set can_view_team_library = true, can_view_club_library = true`,
    [athlete],
  );

  const teamCoachA = await makeUser({ email: `scope-teamcoach-a-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(teamCoachA.id, teamA);
  const clubAdminB = await makeUser({ email: `scope-clubadmin-b-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(clubAdminB.id, clubB);

  const planTeam = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, athlete_can_view_directly, is_free, status)
     values ('program', $1, 'Team Scoped Template', true, 'team', 'team', true, true, 'active')
     returning id`,
    [teamCoachA.id],
  );
  cleanupPlanIds.add(planTeam.rows[0].id);
  const planClub = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, athlete_can_view_directly, is_free, status)
     values ('program', $1, 'Club Scoped Template', true, 'club', 'club', true, true, 'active')
     returning id`,
    [clubAdminB.id],
  );
  cleanupPlanIds.add(planClub.rows[0].id);

  const athleteViewer = { id: athleteUser.id, role_hint: "athlete" };
  assert.equal(await canUseTemplate(query, athleteViewer, planTeam.rows[0].id), true, "the athlete's active team membership must unlock the team-scoped template");
  assert.equal(await canUseTemplate(query, athleteViewer, planClub.rows[0].id), true, "the athlete's active club membership must unlock the club-scoped template");

  const admin = await makeUser({ email: `scope-platform-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const adminToken = await createSession(admin.id);
  await api(`/api/organization/teams/${teamA}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(adminToken) });

  assert.equal(await canUseTemplate(query, athleteViewer, planTeam.rows[0].id), false, "archiving the team membership must remove access to the team-scoped template");
  assert.equal(await canUseTemplate(query, athleteViewer, planClub.rows[0].id), true, "the untouched club membership must still unlock the club-scoped template");
});

test("29. archiving the whole profile changes neither the login, sessions, nor any individual relationship", async () => {
  const club = await makeClub(`Profile Archive Club ${Date.now()}`);
  const team = await makeTeam(club, "Profile Archive Team");
  const athleteUser = await makeUser({ email: `profile-archive-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addTeamMembership(athlete, club, team);
  const coach = await makeUser({ email: `profile-archive-coach-${Date.now()}@test.local`, roleHint: "coach" });
  await grantCoachAthleteLink(coach.id, athlete);
  await createSession(athleteUser.id);
  assert.equal(await sessionCountFor(athleteUser.id), 1);

  const admin = await makeUser({ email: `profile-archive-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const adminToken = await createSession(admin.id);

  const res = await api(`/api/organization/athletes/${athlete}/archive-profile`, { method: "DELETE", cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);

  const profile = await query(`select is_active from public.athletes where id = $1`, [athlete]);
  assert.equal(profile.rows[0].is_active, false, "the profile itself must be archived");

  assert.equal(await isActiveUser(athleteUser.id), true, "archiving the profile must not disable the login");
  assert.equal(await sessionCountFor(athleteUser.id), 1, "archiving the profile must not delete sessions");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: team, membershipType: "team" }), "active", "archiving the profile must not touch the team membership");
  assert.equal(await membershipStatus(athlete, { clubId: club, teamId: null, membershipType: "club" }), "active", "archiving the profile must not touch the club membership");
  const coachLink = await query(
    `select is_active from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`,
    [coach.id, athlete],
  );
  assert.equal(coachLink.rows[0].is_active, true, "archiving the profile must not touch the private-coach relationship");
});

// Mirrors the exact rule the frontend must apply: is_active !== false is the
// PROFILE flag alone and is never sufficient on its own - has_active_access
// is what says whether THIS viewer's own tie to the athlete is currently
// active. A row can legitimately appear in the API response with
// is_active !== false but has_active_access === false (their only tie is
// archived), and it must never be treated as "in the active list" then.
function isInActiveList(row) {
  return row.is_active !== false && row.has_active_access === true;
}

test("30. a private coach loses active access (but not archived visibility) after archiving their only coach relationship, and regains it on restore", async () => {
  const coach = await makeUser({ email: `active-access-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, athlete);
  const token = await createSession(coach.id);

  const before = await api("/api/organization", { cookie: cookieFor(token) });
  const beforeRow = before.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(beforeRow), true, "must be in the active list before archiving");

  await api(`/api/organization/athletes/${athlete}/coach-relationship`, { method: "DELETE", cookie: cookieFor(token) });

  const afterArchive = await api("/api/organization", { cookie: cookieFor(token) });
  const archivedRow = afterArchive.body.athletes.find((a) => a.id === athlete);
  assert.ok(archivedRow, "the row must still be returned for Show archived");
  assert.equal(archivedRow.has_active_access, false, "active access must be false once the only coach relationship is archived");
  assert.equal(isInActiveList(archivedRow), false, "must NOT be treated as in the active list anymore");
  assert.equal(archivedRow.has_my_archived_coach_relationship, true);

  await api(`/api/organization/athletes/${athlete}/coach-relationship/restore`, { method: "PUT", cookie: cookieFor(token) });

  const afterRestore = await api("/api/organization", { cookie: cookieFor(token) });
  const restoredRow = afterRestore.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(restoredRow), true, "must be back in the active list after restore");
});

test("31. a team coach loses active access after archiving their only team membership, and regains it on restore", async () => {
  const club = await makeClub(`Active Access Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Active Access Team");
  const athlete = await makeAthlete();
  await addTeamMembership(athlete, club, team);
  const coach = await makeUser({ email: `active-access-teamcoach-${Date.now()}@test.local`, roleHint: "team_coach" });
  await grantTeamRole(coach.id, team);
  const token = await createSession(coach.id);

  const before = await api("/api/organization", { cookie: cookieFor(token) });
  const beforeRow = before.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(beforeRow), true, "must be in the active list before archiving");

  await api(`/api/organization/teams/${team}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const afterArchive = await api("/api/organization", { cookie: cookieFor(token) });
  const archivedRow = afterArchive.body.athletes.find((a) => a.id === athlete);
  assert.ok(archivedRow, "the row must still be returned for Show archived");
  assert.equal(archivedRow.has_active_access, false, "active access must be false once the only team membership is archived");
  assert.equal(isInActiveList(archivedRow), false, "must NOT be treated as in the active list anymore");

  await api(`/api/organization/teams/${team}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });

  const afterRestore = await api("/api/organization", { cookie: cookieFor(token) });
  const restoredRow = afterRestore.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(restoredRow), true, "must be back in the active list after restore");
});

test("32. a club admin loses active access after archiving their only club membership, and regains it on restore", async () => {
  const club = await makeClub(`Active Access Club ${Date.now()}`);
  const athlete = await makeAthlete();
  await addClubMembership(athlete, club);
  const admin = await makeUser({ email: `active-access-clubadmin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, club);
  const token = await createSession(admin.id);

  const before = await api("/api/organization", { cookie: cookieFor(token) });
  const beforeRow = before.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(beforeRow), true, "must be in the active list before archiving");

  await api(`/api/organization/clubs/${club}/athletes/${athlete}`, { method: "DELETE", cookie: cookieFor(token) });

  const afterArchive = await api("/api/organization", { cookie: cookieFor(token) });
  const archivedRow = afterArchive.body.athletes.find((a) => a.id === athlete);
  assert.ok(archivedRow, "the row must still be returned for Show archived");
  assert.equal(archivedRow.has_active_access, false, "active access must be false once the only club membership is archived");
  assert.equal(isInActiveList(archivedRow), false, "must NOT be treated as in the active list anymore");

  await api(`/api/organization/clubs/${club}/athletes/${athlete}/restore`, { method: "PUT", cookie: cookieFor(token) });

  const afterRestore = await api("/api/organization", { cookie: cookieFor(token) });
  const restoredRow = afterRestore.body.athletes.find((a) => a.id === athlete);
  assert.equal(isInActiveList(restoredRow), true, "must be back in the active list after restore");
});

// Regression for the production incident on commit 23fb2bf: loadProgramAccessRequests
// was called as loadProgramAccessRequests(req.user) and internally called
// canManageAthlete(user, ...) - canManageAthlete reads req.authz, so passing
// the bare user object (no .authz) crashed with
// "TypeError: Cannot read properties of undefined (reading 'platformRoles')"
// as soon as there was at least one library.program_access row in a
// requested/rejected/accessed/used/completed status to check. GET
// /api/organization returned a plain 200 in every earlier test in this file
// only because none of them had ever created a program_access row.
test("33. GET /api/organization returns 200 (not 500) when there is a pending program-access request to check", async () => {
  const coach = await makeUser({ email: `program-access-coach-${Date.now()}@test.local`, roleHint: "coach" });
  const athleteUser = await makeUser({ email: `program-access-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await grantCoachAthleteLink(coach.id, athlete);

  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template)
     values ('program', $1, 'Regression Plan', true)
     returning id`,
    [coach.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  await query(
    `insert into library.program_access (plan_id, user_id, access_type, status)
     values ($1, $2, 'assigned', 'requested')`,
    [plan.rows[0].id, athleteUser.id],
  );

  const token = await createSession(coach.id);
  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200, "must not 500 when a program-access request needs to be checked against canManageAthlete");
  assert.ok(Array.isArray(res.body.accessRequests), "the response must still include the accessRequests array");
  assert.ok(
    res.body.accessRequests.some((r) => r.athlete_id === athlete),
    "the coach must see the pending request for their own athlete",
  );
});
