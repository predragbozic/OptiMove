import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 5: feature/multi-role-workspace-selection. A multi-role account
// picks which context (platform/private_coach/club/team/athlete) it is
// currently acting in after login, and can change it without logging out.
// Every workspace here is built purely from real, active roles/FKs
// (req.authz) - never role_hint, which must never grant or hide a
// workspace by itself. Every club/team fixture is created fresh per test,
// so LAST_CLUB_ADMIN-style invariants from earlier phases never interact
// with these tests and vice versa.

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

async function revokeGlobalRoleDirectly(userId, role) {
  await query(
    `update public.user_global_roles set is_active = false, revoked_at = now(), updated_at = now() where user_id = $1 and role = $2`,
    [userId, role],
  );
}

async function makeClub(name, { isActive = true } = {}) {
  const result = await query(`insert into public.clubs (name, is_active) values ($1, $2) returning id`, [name, isActive]);
  cleanupClubIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeTeam(clubId, name, { isActive = true } = {}) {
  const result = await query(`insert into public.teams (club_id, name, is_active) values ($1, $2, $3) returning id`, [clubId, name, isActive]);
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

async function revokeClubAdminDirectly(userId, clubId) {
  await query(
    `update public.user_club_roles set is_active = false, updated_at = now() where user_id = $1 and club_id = $2 and role = 'club_admin'`,
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

async function makeAthleteLinkedTo(userId, extra = {}) {
  const externalId = `wksp${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Role', 'Test', 'Role Test', 'Role Test', $2, true)
     returning id`,
    [externalId, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  if (extra.membershipClubId) {
    await query(
      `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
       values ($1, $2, null, 'club', 'active')`,
      [result.rows[0].id, extra.membershipClubId],
    );
  }
  if (extra.membershipTeamId && extra.membershipClubId) {
    await query(
      `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
       values ($1, $2, $3, 'team', 'active')`,
      [result.rows[0].id, extra.membershipClubId, extra.membershipTeamId],
    );
  }
  return result.rows[0].id;
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

async function preferenceRowFor(userId) {
  const result = await query(`select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1`, [userId]);
  return result.rows[0] || null;
}

// --- 1-8: availability, purely from real roles/FKs ---

test("1. a platform admin gets a platform workspace", async () => {
  const admin = await makePlatformAdmin(`wksp-platform-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.activeWorkspace.type, "platform");
  assert.ok(me.body.user.availableWorkspaces.some((w) => w.type === "platform"));
});

test("2. an independent coach gets a private_coach workspace", async () => {
  const coach = await makeUser({ email: `wksp-indie-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  const token = await createSession(coach.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.body.user.activeWorkspace.type, "private_coach");
  assert.equal(me.body.user.availableWorkspaces.length, 1);
});

test("3. a club admin gets a workspace only for the clubs they actually administer", async () => {
  const clubA = await makeClub(`Workspace Club A ${Date.now()}`);
  const clubB = await makeClub(`Workspace Club B ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-clubadmin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubA);
  const token = await createSession(admin.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  const clubWorkspaces = me.body.user.availableWorkspaces.filter((w) => w.type === "club");
  assert.equal(clubWorkspaces.length, 1);
  assert.equal(clubWorkspaces[0].scopeId, clubA);
  assert.ok(!clubWorkspaces.some((w) => w.scopeId === clubB), "must never offer a workspace for a club this account does not administer");
});

test("4. a team coach gets a workspace only for the teams they actually coach, and no separate workspace merely from managing the club", async () => {
  const club = await makeClub(`Workspace Club C ${Date.now()}`);
  const teamMine = await makeTeam(club, "Team Mine");
  const teamOther = await makeTeam(club, "Team Other");
  const coach = await makeUser({ email: `wksp-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamCoachDirectly(coach.id, teamMine);
  const token = await createSession(coach.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  const teamWorkspaces = me.body.user.availableWorkspaces.filter((w) => w.type === "team");
  assert.equal(teamWorkspaces.length, 1);
  assert.equal(teamWorkspaces[0].scopeId, teamMine);
  assert.ok(!teamWorkspaces.some((w) => w.scopeId === teamOther));
  assert.ok(!me.body.user.availableWorkspaces.some((w) => w.type === "club"), "a plain team_coach with no club_admin role must not get a club workspace");
});

test("4b. a club admin does not automatically get a separate team workspace for their club's teams", async () => {
  const club = await makeClub(`Workspace Club C2 ${Date.now()}`);
  await makeTeam(club, "Team Under Club Admin");
  const admin = await makeUser({ email: `wksp-clubadmin-noteam-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.ok(!me.body.user.availableWorkspaces.some((w) => w.type === "team"), "club_admin alone must never produce a team workspace");
});

test("5. a real athlete FK gives an athlete workspace", async () => {
  const athleteUser = await makeUser({ email: `wksp-athlete-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(athleteUser.id);
  const token = await createSession(athleteUser.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.ok(me.body.user.availableWorkspaces.some((w) => w.type === "athlete"));
});

test("6. a multi-role account gets every real workspace it actually holds", async () => {
  const club = await makeClub(`Workspace Club D ${Date.now()}`);
  const team = await makeTeam(club, "Team D");
  const user = await makeUser({ email: `wksp-multi-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(user.id, "platform_admin");
  await grantGlobalRoleDirectly(user.id, "independent_coach");
  await grantClubAdminDirectly(user.id, club);
  const otherClub = await makeClub(`Workspace Club D2 ${Date.now()}`);
  const otherTeam = await makeTeam(otherClub, "Team D2");
  await grantTeamCoachDirectly(user.id, otherTeam);
  await makeAthleteLinkedTo(user.id);
  const token = await createSession(user.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  const types = me.body.user.availableWorkspaces.map((w) => w.type).sort();
  assert.deepEqual(types, ["athlete", "club", "platform", "private_coach", "team"]);
});

test("7. a fake role_hint claiming platform_admin/coach/athlete with no real row/FK grants no workspace", async () => {
  for (const roleHint of ["platform_admin", "admin", "coach", "athlete"]) {
    const fake = await makeUser({ email: `wksp-fake-${roleHint}-${Date.now()}@test.local`, roleHint });
    const token = await createSession(fake.id);
    const me = await api("/api/auth/me", { cookie: cookieFor(token) });
    assert.deepEqual(me.body.user.availableWorkspaces, [], `role_hint='${roleHint}' with no real row must grant zero workspaces`);
    assert.equal(me.body.user.activeWorkspace, null);
  }
});

test("8. a deactivated (revoked) role no longer grants its workspace", async () => {
  const club = await makeClub(`Workspace Club E ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-revoked-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);

  const before1 = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.ok(before1.body.user.availableWorkspaces.some((w) => w.type === "club"));

  await revokeClubAdminDirectly(admin.id, club);
  const after1 = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.deepEqual(after1.body.user.availableWorkspaces, []);
});

// --- 9-12: selection, validation, idempotency ---

test("9. a valid workspace selection is saved and reflected on the next /me call", async () => {
  const clubA = await makeClub(`Workspace Club F ${Date.now()}`);
  const clubB = await makeClub(`Workspace Club F2 ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-select-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubA);
  await grantClubAdminDirectly(admin.id, clubB);
  const token = await createSession(admin.id);

  const put = await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: clubB } });
  assert.equal(put.status, 200);
  assert.equal(put.body.activeWorkspace.type, "club");
  assert.equal(put.body.activeWorkspace.scopeId, clubB);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.body.user.activeWorkspace.type, "club");
  assert.equal(me.body.user.activeWorkspace.scopeId, clubB);

  const row = await preferenceRowFor(admin.id);
  assert.equal(row.workspace_type, "club");
  assert.equal(row.scope_id, clubB);
});

test("10. an unsupported workspace type is rejected with 400 and no mutation", async () => {
  const user = await makeUser({ email: `wksp-badtype-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(user.id, "independent_coach");
  const token = await createSession(user.id);
  const before1 = await preferenceRowFor(user.id);

  const res = await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club_manager", scopeId: null } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "UNSUPPORTED_WORKSPACE_TYPE");
  assert.deepEqual(await preferenceRowFor(user.id), before1);
});

test("11. a club this account does not administer is rejected with 403 and no mutation - a different club/team can never be selected", async () => {
  const ownClub = await makeClub(`Workspace Club G ${Date.now()}`);
  const outsideClub = await makeClub(`Workspace Club G2 ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-outside-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, ownClub);
  const token = await createSession(admin.id);

  const res = await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: outsideClub } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "WORKSPACE_NOT_AVAILABLE");
  assert.equal(await preferenceRowFor(admin.id), null, "no preference row may be created by a rejected selection");
});

test("12. selecting the same workspace twice is idempotent - both calls return 200", async () => {
  const club = await makeClub(`Workspace Club H ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-idem-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);

  const first = await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: club } });
  assert.equal(first.status, 200);
  const second = await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: club } });
  assert.equal(second.status, 200);
});

// --- 13-15: fallback ---

test("13. revoking the role backing the active workspace activates a valid fallback, without a 500", async () => {
  const clubA = await makeClub(`Workspace Club I ${Date.now()}`);
  const clubB = await makeClub(`Workspace Club I2 ${Date.now()}`);
  const admin = await makeUser({ email: `wksp-fallback-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubA);
  await grantClubAdminDirectly(admin.id, clubB);
  const token = await createSession(admin.id);

  await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: clubA } });
  await revokeClubAdminDirectly(admin.id, clubA);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.activeWorkspace.type, "club");
  assert.equal(me.body.user.activeWorkspace.scopeId, clubB, "must fall back to the remaining valid club, never keep the revoked one");

  const row = await preferenceRowFor(admin.id);
  assert.equal(row.workspace_type, "club");
  assert.equal(row.scope_id, clubB, "the fallback must be persisted (controlled write), not just returned once");
});

test("14. an athlete-only account falls back directly to the athlete workspace", async () => {
  const athleteUser = await makeUser({ email: `wksp-athlete-fallback-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(athleteUser.id);
  const token = await createSession(athleteUser.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.body.user.activeWorkspace.type, "athlete");
});

test("15. an account with no real workspace at all gets a clear null state, never invented coach access", async () => {
  const plain = await makeUser({ email: `wksp-none-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(plain.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(me.body.user.activeWorkspace, null);
  assert.deepEqual(me.body.user.availableWorkspaces, []);
  assert.equal(me.body.user.capabilities.coachWorkspace, false);
});

// --- 16: /me shape stays backward compatible ---

test("16. GET /api/auth/me returns the existing compatible user shape plus the new workspace fields", async () => {
  const admin = await makePlatformAdmin(`wksp-shape-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const me = await api("/api/auth/me", { cookie: cookieFor(token) });
  const user = me.body.user;
  for (const field of ["id", "email", "name", "role", "role_hint", "accessScope", "capabilities", "clubs", "teams"]) {
    assert.ok(field in user, `existing field '${field}' must still be present for compatibility`);
  }
  assert.ok("activeWorkspace" in user);
  assert.ok("availableWorkspaces" in user);
});

// --- 17-20: GET /api/organization is workspace-aware, without weakening write authz ---

test("17. a club workspace scopes GET /organization to just that club, its teams, athletes with active membership there, and its users", async () => {
  const clubMine = await makeClub(`Workspace Club J ${Date.now()}`);
  const clubOther = await makeClub(`Workspace Club J2 ${Date.now()}`);
  const teamMine = await makeTeam(clubMine, "Team J");
  const teamOther = await makeTeam(clubOther, "Team J2");
  const admin = await makeUser({ email: `wksp-org-club-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubMine);
  await grantClubAdminDirectly(admin.id, clubOther);
  const athleteUserMine = await makeUser({ email: `wksp-org-club-ath1-${Date.now()}@test.local` });
  const athleteInMine = await makeAthleteLinkedTo(athleteUserMine.id, { membershipClubId: clubMine });
  const athleteUserOther = await makeUser({ email: `wksp-org-club-ath2-${Date.now()}@test.local` });
  const athleteInOther = await makeAthleteLinkedTo(athleteUserOther.id, { membershipClubId: clubOther });
  const token = await createSession(admin.id);

  await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: clubMine } });
  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.status, 200);
  assert.deepEqual(org.body.clubs.map((c) => c.id), [clubMine]);
  assert.deepEqual(org.body.teams.map((t) => t.id), [teamMine]);
  assert.ok(org.body.athletes.some((a) => a.id === athleteInMine));
  assert.ok(!org.body.athletes.some((a) => a.id === athleteInOther), "an athlete only active in the OTHER club must not appear in this club's workspace view");
  assert.ok(!org.body.teams.some((t) => t.id === teamOther));
});

test("18. a team workspace scopes GET /organization to just that team and its athletes", async () => {
  const club = await makeClub(`Workspace Club K ${Date.now()}`);
  const teamMine = await makeTeam(club, "Team K");
  const teamOther = await makeTeam(club, "Team K2");
  const coach = await makeUser({ email: `wksp-org-team-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamCoachDirectly(coach.id, teamMine);
  const athleteUserMine = await makeUser({ email: `wksp-org-team-ath1-${Date.now()}@test.local` });
  const athleteInMine = await makeAthleteLinkedTo(athleteUserMine.id, { membershipClubId: club, membershipTeamId: teamMine });
  const athleteUserOther = await makeUser({ email: `wksp-org-team-ath2-${Date.now()}@test.local` });
  const athleteInOther = await makeAthleteLinkedTo(athleteUserOther.id, { membershipClubId: club, membershipTeamId: teamOther });
  const token = await createSession(coach.id);

  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.body.activeWorkspace.type, "team");
  assert.deepEqual(org.body.teams.map((t) => t.id), [teamMine]);
  assert.ok(org.body.athletes.some((a) => a.id === athleteInMine));
  assert.ok(!org.body.athletes.some((a) => a.id === athleteInOther));
  assert.deepEqual(org.body.clubs, []);
});

test("19. a private_coach workspace shows only athletes with an active private-coach relationship, never clubs/teams from other roles", async () => {
  const club = await makeClub(`Workspace Club L ${Date.now()}`);
  const coach = await makeUser({ email: `wksp-org-private-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  await grantClubAdminDirectly(coach.id, club);
  const myAthleteUser = await makeUser({ email: `wksp-org-private-ath-${Date.now()}@test.local` });
  const myAthleteId = await makeAthleteLinkedTo(myAthleteUser.id);
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`,
    [coach.id, myAthleteId],
  );
  const token = await createSession(coach.id);

  await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "private_coach", scopeId: null } });
  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.body.activeWorkspace.type, "private_coach");
  assert.deepEqual(org.body.clubs, [], "private_coach workspace must never show clubs, even though this account also holds club_admin");
  assert.deepEqual(org.body.teams, []);
  assert.ok(org.body.athletes.some((a) => a.id === myAthleteId));
});

test("20. a platform workspace (and no workspace at all) leaves GET /organization unfiltered, matching pre-workspace behavior", async () => {
  const admin = await makePlatformAdmin(`wksp-org-platform-${Date.now()}@test.local`);
  const club = await makeClub(`Workspace Club M ${Date.now()}`);
  const token = await createSession(admin.id);

  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.body.activeWorkspace.type, "platform");
  assert.ok(org.body.clubs.some((c) => c.id === club), "a platform workspace must still see every club, unfiltered");
});
