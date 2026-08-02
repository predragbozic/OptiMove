import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { safeCleanup } from "./_test-cleanup.mjs";

// Phase 4 PR 2A: role_hint must never again gate an HTTP status, permission,
// scope, or available data set - only req.authz (backed by
// public.user_global_roles / user_club_roles / user_team_roles /
// athletes.user_id) may. These tests build fixtures with a role_hint string
// deliberately DISAGREEING with the account's real rows, to prove the app
// follows the real rows every time.
//
// A second, related invariant covered below: "coach-only" must mean "has
// coach capability" (req.authz.capabilities.coachWorkspace), never "lacks
// athlete identity". A multi-role account (athlete + coach/admin) must get
// the full union of its real capabilities, not have its coach access
// switched off just because it also happens to be an athlete.

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
  await safeCleanup(() => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]]), "plans");
  await safeCleanup(() => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]]), "athletes");
  await safeCleanup(() => cleanupTeamIds.size && query(`delete from public.teams where id = any($1::uuid[])`, [[...cleanupTeamIds]]), "teams");
  await safeCleanup(() => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]]), "clubs");
  await safeCleanup(() => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]]), "users");
  await safeCleanup(() => new Promise((resolve) => server.close(resolve)), "server close");
  await safeCleanup(() => pool.end(), "pool end");
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

// Deliberately does NOT auto-grant any matching user_global_roles row -
// several tests here need a fixture with a role_hint string and explicitly
// NO real role/link, to prove that string alone grants nothing.
async function makeUser({ email, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, true)
     returning id, email`,
    [email, hashPassword("irrelevant-password-123"), roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function grantGlobalRole(userId, role) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
     on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
    [userId, role],
  );
}

async function makeAthleteLinkedTo(userId) {
  const externalId = `pr2a${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Role', 'Test', 'Role Test', 'Role Test', $2, true)
     returning id`,
    [externalId, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeUnlinkedAthlete() {
  const externalId = `pr2a${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $1, 'Role', 'Test', 'Role Test', 'Role Test', true)
     returning id`,
    [externalId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
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

async function makePublicTemplate(creatorUserId, { canCopy = true } = {}) {
  const result = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, can_copy, visibility, status, is_active)
     values ('program', $1, 'PR2A Template', true, $2, 'public', 'active', true)
     returning id`,
    [creatorUserId, canCopy],
  );
  cleanupPlanIds.add(result.rows[0].id);
  return result.rows[0].id;
}

// --- 1-6: coach-only access must check coachWorkspace capability, never ---
// --- the presence/absence of athlete identity                          ---

test("1. an athlete-only account (real FK, no coach-capability role) is blocked from the coach-only access-requests route", async () => {
  const user = await makeUser({ email: `pr2a-athlete-only-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(user.id);
  const coach = await makeUser({ email: `pr2a-template-owner-a-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const planId = await makePublicTemplate(coach.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/access-requests`, { cookie: cookieFor(token) });
  assert.equal(res.status, 403, "an athlete with no coach-capability role must fail the coachWorkspace gate");
  assert.equal(res.body.error, "Coach access required.");
});

test("2. a plain account with no athlete FK and no coach-capability role is also blocked from the same route", async () => {
  const user = await makeUser({ email: `pr2a-plain-user-${Date.now()}@test.local`, roleHint: "user" });
  const coach = await makeUser({ email: `pr2a-template-owner-e-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const planId = await makePublicTemplate(coach.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/access-requests`, { cookie: cookieFor(token) });
  assert.equal(res.status, 403, "the gate must key off coachWorkspace, not athlete identity - lacking both must still be 403");
  assert.equal(res.body.error, "Coach access required.");
});

test("3. a fake role_hint='athlete' with no real FK and no coach-capability role is blocked from the same route", async () => {
  const user = await makeUser({ email: `pr2a-fake-athlete-${Date.now()}@test.local`, roleHint: "athlete" });
  const coach = await makeUser({ email: `pr2a-template-owner-b-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const planId = await makePublicTemplate(coach.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/access-requests`, { cookie: cookieFor(token) });
  assert.equal(res.status, 403, "role_hint='athlete' alone grants nothing, and this account has no real coach capability either");
  assert.equal(res.body.error, "Coach access required.");
});

test("4. a real athlete FK plus a real independent_coach global role is NOT blocked from the coach-only access-requests route", async () => {
  const user = await makeUser({ email: `pr2a-multi-indiecoach-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(user.id);
  await grantGlobalRole(user.id, "independent_coach");
  const coach = await makeUser({ email: `pr2a-template-owner-f-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const planId = await makePublicTemplate(coach.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/access-requests`, { cookie: cookieFor(token) });
  assert.notEqual(res.status, 403, "real coach capability must not be switched off by also being a real athlete");
});

test("5. a real athlete FK plus a real team_coach role is NOT blocked from the assignments route", async () => {
  const club = await makeClub(`PR2A Assign Club ${Date.now()}`);
  const team = await makeTeam(club, "PR2A Assign Team");
  const user = await makeUser({ email: `pr2a-multi-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(user.id);
  await grantTeamRole(user.id, team);
  const owner = await makeUser({ email: `pr2a-template-owner-g-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(owner.id, "independent_coach");
  const planId = await makePublicTemplate(owner.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/assignments`, {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteIds: ["pr2a-nonexistent-target"] },
  });
  assert.notEqual(res.status, 403, "a real team_coach role must not be switched off by also being a real athlete");
  assert.notEqual(res.body.error, "Coach access required.");
});

test("6. a real athlete FK plus a real platform_admin row passes the coachWorkspace gate on access-requests", async () => {
  const user = await makeUser({ email: `pr2a-multi-admin-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(user.id);
  await grantGlobalRole(user.id, "platform_admin");
  const coach = await makeUser({ email: `pr2a-template-owner-h-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const planId = await makePublicTemplate(coach.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/access-requests`, { cookie: cookieFor(token) });
  assert.notEqual(res.status, 403, "a real platform_admin row must not be switched off by also being a real athlete");
});

// --- 7/8: canAccessAllAthletes / the platform-wide bypass ---

test("7. a platform_admin granted purely through user_global_roles (neutral role_hint) sees an athlete they have no relationship with", async () => {
  const admin = await makeUser({ email: `pr2a-real-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const unrelatedAthlete = await makeUnlinkedAthlete();
  const token = await createSession(admin.id);

  const res = await api("/api/athletes", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const ids = res.body.adminRows.map((row) => row.athlete_uuid);
  assert.ok(ids.includes(unrelatedAthlete), "a real platform_admin row must grant the full-visibility bypass regardless of role_hint");
});

test("8. a fake role_hint='platform_admin' with no real user_global_roles row does not get the bypass", async () => {
  const fakeAdmin = await makeUser({ email: `pr2a-fake-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const unrelatedAthlete = await makeUnlinkedAthlete();
  const token = await createSession(fakeAdmin.id);

  const res = await api("/api/athletes", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const ids = res.body.adminRows.map((row) => row.athlete_uuid);
  assert.ok(!ids.includes(unrelatedAthlete), "role_hint='platform_admin' alone must never grant the full-visibility bypass");
});

// --- builder.js: canAccessAllAthletes bypass on the template-copy lock ---

test("9. a real platform_admin can duplicate a can_copy=false template via the builder", async () => {
  const owner = await makeUser({ email: `pr2a-template-owner-c-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(owner.id, "independent_coach");
  const planId = await makePublicTemplate(owner.id, { canCopy: false });
  const admin = await makeUser({ email: `pr2a-builder-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const token = await createSession(admin.id);

  const res = await api(`/api/builder/plans/${planId}/duplicate`, { method: "POST", cookie: cookieFor(token), body: {} });
  assert.equal(res.status, 201, "a real platform_admin row must bypass the can_copy=false lock");
  if (res.body?.plan?.id) cleanupPlanIds.add(res.body.plan.id);
});

test("10. a fake role_hint='platform_admin' cannot duplicate a can_copy=false template", async () => {
  const owner = await makeUser({ email: `pr2a-template-owner-d-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(owner.id, "independent_coach");
  const planId = await makePublicTemplate(owner.id, { canCopy: false });
  const fakeAdmin = await makeUser({ email: `pr2a-fake-builder-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(fakeAdmin.id);

  const res = await api(`/api/builder/plans/${planId}/duplicate`, { method: "POST", cookie: cookieFor(token), body: {} });
  assert.equal(res.status, 403, "role_hint='platform_admin' alone must never bypass the can_copy=false lock");
});

// --- multi-role: one account holding both athlete and coach capability ---

test("11. a single account with a real athlete FK and a real independent_coach row gets both workspaces regardless of role_hint", async () => {
  const user = await makeUser({ email: `pr2a-multi-role-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthleteLinkedTo(user.id);
  await grantGlobalRole(user.id, "independent_coach");
  const token = await createSession(user.id);

  const meRes = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.equal(meRes.body.user.capabilities.athleteWorkspace, true, "the real athlete FK must grant athleteWorkspace even though role_hint doesn't match anything conflicting");
  assert.equal(meRes.body.user.capabilities.coachWorkspace, true, "the real independent_coach row must grant coachWorkspace regardless of role_hint");

  const orgRes = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(orgRes.status, 200, "a multi-role athlete+coach account must be able to use the coach workspace");
});

test("12. a multi-role athlete+coach account can use a template available to it as a coach, even while also having an athlete FK", async () => {
  const user = await makeUser({ email: `pr2a-canusetemplate-multi-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(user.id);
  await grantGlobalRole(user.id, "independent_coach");
  const owner = await makeUser({ email: `pr2a-template-owner-i-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(owner.id, "independent_coach");
  // Public, but deliberately NOT athlete_can_view_directly - only the staff
  // (coachWorkspace) access path can see this, never the athlete-scope path.
  const planId = await makePublicTemplate(owner.id);
  const token = await createSession(user.id);

  const res = await api(`/api/templates/${planId}/use`, { method: "POST", cookie: cookieFor(token), body: {} });
  assert.equal(res.status, 200, "a real coach capability must grant canUseTemplate's staff branch even when the account is also a real athlete");
});

// --- organization.js loadUsers: multi-role visibility, no role_hint filter ---

test("13. a multi-role athlete+club_admin account is visible in the Users list to a fellow club admin", async () => {
  const club = await makeClub(`PR2A Users Club ${Date.now()}`);
  const multiRoleUser = await makeUser({ email: `pr2a-users-multirole-${Date.now()}@test.local`, roleHint: "athlete" });
  await makeAthleteLinkedTo(multiRoleUser.id);
  await grantClubRole(multiRoleUser.id, club);

  const viewer = await makeUser({ email: `pr2a-users-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(viewer.id, club);
  const token = await createSession(viewer.id);

  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const ids = res.body.users.map((u) => u.id);
  assert.ok(ids.includes(multiRoleUser.id), "a multi-role athlete+club_admin account must appear in the Users list despite role_hint='athlete'");
});

test("14. a pure athlete-only account (no staff role of any kind) is not visible in the Users list", async () => {
  const club = await makeClub(`PR2A Users Club Pure ${Date.now()}`);
  const pureAthlete = await makeUser({ email: `pr2a-users-pure-athlete-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(pureAthlete.id);

  const viewer = await makeUser({ email: `pr2a-users-viewer-pure-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(viewer.id, club);
  const token = await createSession(viewer.id);

  const res = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const ids = res.body.users.map((u) => u.id);
  assert.ok(!ids.includes(pureAthlete.id), "an account with no staff-ish role of any kind must not leak into the Users list");
});

// --- coaches.js: canBypassCoachVisibility ---

test("15. a real platform_admin sees a private coach profile via GET /api/coaches", async () => {
  const coach = await makeUser({ email: `pr2a-private-coach-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const coachToken = await createSession(coach.id);
  await api("/api/coaches/me", { cookie: cookieFor(coachToken) });

  const admin = await makeUser({ email: `pr2a-coach-visibility-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(admin.id, "platform_admin");
  const adminToken = await createSession(admin.id);

  const res = await api("/api/coaches", { cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);
  const userIds = res.body.coaches.map((c) => c.user_id);
  assert.ok(userIds.includes(coach.id), "a real platform_admin row must bypass private coach-profile visibility");
});

test("16. a fake role_hint='platform_admin' does not see a private coach profile via GET /api/coaches", async () => {
  const coach = await makeUser({ email: `pr2a-private-coach-b-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRole(coach.id, "independent_coach");
  const coachToken = await createSession(coach.id);
  await api("/api/coaches/me", { cookie: cookieFor(coachToken) });

  const fakeAdmin = await makeUser({ email: `pr2a-fake-coach-visibility-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(fakeAdmin.id);

  const res = await api("/api/coaches", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const userIds = res.body.coaches.map((c) => c.user_id);
  assert.ok(!userIds.includes(coach.id), "role_hint='platform_admin' alone must never bypass private coach-profile visibility");
});
