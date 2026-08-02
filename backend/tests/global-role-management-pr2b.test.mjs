import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 4 PR 2B: safe grant/revoke of global roles (platform_admin,
// independent_coach), kept strictly separate from login/account status,
// athlete profile, and club/team relationships. The central invariant under
// test throughout is that the app can never end up with zero login-active
// platform admins - neither through revoking the role nor through disabling
// the account - and that this holds even under two concurrent requests.

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
  // athletes.user_id is ON DELETE SET NULL, not CASCADE - deleting the user
  // row first would silently orphan the athlete row (null user_id, fixture
  // data left behind forever) instead of removing it, so athletes must be
  // deleted explicitly and before their linked user. Every step is
  // attempted regardless of earlier failures, and the whole hook rejects if
  // any step failed - see runCleanupSteps.
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

// Deliberately does NOT auto-grant any matching user_global_roles row - most
// fixtures here need an account with a role_hint string and explicitly NO
// real role, to prove that string alone grants nothing.
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

async function makeAthleteLinkedTo(userId) {
  const externalId = `pr2b${Math.floor(Math.random() * 900000 + 100000)}`;
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

// This suite runs against a real, shared dev database that already has its
// own platform admin(s) (and other tests in this file create more) - the
// "last admin" tests can't just create one admin and assume it's the only
// one. This temporarily deactivates every OTHER currently-active
// platform_admin row so the test's own fixture(s) are provably the only
// ones left, then restores exactly those rows afterward regardless of
// whether the test passed, failed, or threw.
async function withOnlyTheseAdminsActive(allowedAdminUserIds, fn) {
  const others = await query(
    `select user_id from public.user_global_roles where role = 'platform_admin' and is_active = true and user_id <> all($1::uuid[])`,
    [allowedAdminUserIds],
  );
  const otherIds = others.rows.map((row) => row.user_id);
  if (otherIds.length) {
    await query(`update public.user_global_roles set is_active = false where role = 'platform_admin' and user_id = any($1::uuid[])`, [otherIds]);
  }
  try {
    return await fn();
  } finally {
    if (otherIds.length) {
      await query(`update public.user_global_roles set is_active = true where role = 'platform_admin' and user_id = any($1::uuid[])`, [otherIds]);
    }
  }
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

// --- 1/2: grant and revoke each global role, idempotently ---

test("1. a platform admin can grant the platform_admin role, and it is idempotent", async () => {
  const admin = await makePlatformAdmin(`pr2b-granter-a-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-target-a-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const first = await api(`/api/organization/users/${target.id}/global-roles/platform_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(first.status, 200);
  const role1 = first.body.globalRoles.find((r) => r.role === "platform_admin");
  assert.equal(role1.isActive, true);

  const second = await api(`/api/organization/users/${target.id}/global-roles/platform_admin`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(second.status, 200);
  const activeRows = second.body.globalRoles.filter((r) => r.role === "platform_admin" && r.isActive);
  assert.equal(activeRows.length, 1, "granting twice must not create a duplicate row");
});

test("2. a platform admin can grant the independent_coach role, and it is idempotent", async () => {
  const admin = await makePlatformAdmin(`pr2b-granter-b-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-target-b-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(admin.id);

  const first = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(first.status, 200);
  assert.equal(first.body.globalRoles.find((r) => r.role === "independent_coach").isActive, true);

  const second = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(second.status, 200);
  const activeRows = second.body.globalRoles.filter((r) => r.role === "independent_coach" && r.isActive);
  assert.equal(activeRows.length, 1);
});

test("3. a platform admin can revoke independent_coach, and revoking twice is idempotent", async () => {
  const admin = await makePlatformAdmin(`pr2b-revoker-a-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-target-c-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  const token = await createSession(admin.id);

  const first = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(first.status, 200);
  assert.equal(first.body.globalRoles.find((r) => r.role === "independent_coach").isActive, false);

  const second = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(second.status, 200, "revoking an already-revoked role must still succeed (idempotent)");
  assert.equal(second.body.globalRoles.find((r) => r.role === "independent_coach").isActive, false);
});

test("4. revoking platform_admin when another active admin exists succeeds", async () => {
  const admin = await makePlatformAdmin(`pr2b-revoker-b-${Date.now()}@test.local`);
  const target = await makePlatformAdmin(`pr2b-target-d-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/users/${target.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.globalRoles.find((r) => r.role === "platform_admin").isActive, false);
});

// --- 3: audit fields ---

test("5. granting sets grantedByUserId and clears any prior revoke audit fields; revoking sets revokedAt/revokedByUserId", async () => {
  const admin = await makePlatformAdmin(`pr2b-audit-admin-${Date.now()}@test.local`);
  const other = await makePlatformAdmin(`pr2b-audit-other-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-audit-target-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);
  const otherToken = await createSession(other.id);

  const grant = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(adminToken) });
  const grantedRow = grant.body.globalRoles.find((r) => r.role === "independent_coach");
  assert.equal(grantedRow.grantedByUserId, admin.id);
  assert.equal(grantedRow.revokedAt, null);
  assert.equal(grantedRow.revokedByUserId, null);

  const revoke = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(otherToken) });
  const revokedRow = revoke.body.globalRoles.find((r) => r.role === "independent_coach");
  assert.equal(revokedRow.isActive, false);
  assert.equal(revokedRow.revokedByUserId, other.id);
  assert.ok(revokedRow.revokedAt, "revokedAt must be set");

  const regrant = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(adminToken) });
  const regrantedRow = regrant.body.globalRoles.find((r) => r.role === "independent_coach");
  assert.equal(regrantedRow.isActive, true);
  assert.equal(regrantedRow.revokedAt, null, "reactivating must clear the prior revoke audit fields");
  assert.equal(regrantedRow.revokedByUserId, null);
});

// --- 4/6: role_hint, login, sessions, and other roles are all untouched ---

test("6. granting or revoking a global role never changes role_hint, login status, or sessions", async () => {
  const admin = await makePlatformAdmin(`pr2b-untouched-admin-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-untouched-target-${Date.now()}@test.local`, roleHint: "athlete" });
  const targetToken = await createSession(target.id);
  const adminToken = await createSession(admin.id);
  assert.equal(await sessionCountFor(target.id), 1);

  await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(adminToken) });
  await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(adminToken) });

  const targetRow = await query(`select role_hint, is_active from public.users where id = $1`, [target.id]);
  assert.equal(targetRow.rows[0].role_hint, "athlete", "role_hint must never be touched by grant/revoke");
  assert.equal(targetRow.rows[0].is_active, true, "login status must never be touched by grant/revoke");
  assert.equal(await sessionCountFor(target.id), 1, "sessions must never be touched by grant/revoke");

  const meRes = await api("/api/auth/me", { cookie: cookieFor(targetToken) });
  assert.notEqual(meRes.body.user, null, "the target's own session must still work after grant+revoke");
});

test("7. revoking one global role leaves the account's other global/club/team/athlete roles untouched", async () => {
  const admin = await makePlatformAdmin(`pr2b-isolated-admin-${Date.now()}@test.local`);
  const club = await makeClub(`PR2B Isolated Club ${Date.now()}`);
  const team = await makeTeam(club, "PR2B Isolated Team");
  const target = await makeUser({ email: `pr2b-isolated-target-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  await grantClubRole(target.id, club);
  await grantTeamRole(target.id, team);
  const athleteId = await makeAthleteLinkedTo(target.id);
  const adminToken = await createSession(admin.id);

  await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(adminToken) });

  const clubRow = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2`, [target.id, club]);
  assert.equal(clubRow.rows[0].is_active, true, "the club role must remain untouched");
  const teamRow = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2`, [target.id, team]);
  assert.equal(teamRow.rows[0].is_active, true, "the team role must remain untouched");
  const athleteRow = await query(`select is_active, user_id from public.athletes where id = $1`, [athleteId]);
  assert.equal(athleteRow.rows[0].is_active, true, "the athlete profile must remain untouched");
  assert.equal(athleteRow.rows[0].user_id, target.id, "the athlete FK link must remain untouched");
});

// --- 7: unauthorized attempts ---

test("8. a plain user, athlete, independent coach, club admin, and team coach cannot grant or revoke global roles (403)", async () => {
  const club = await makeClub(`PR2B Unauth Club ${Date.now()}`);
  const team = await makeTeam(club, "PR2B Unauth Team");
  const target = await makeUser({ email: `pr2b-unauth-target-${Date.now()}@test.local`, roleHint: "user" });

  const plainUser = await makeUser({ email: `pr2b-unauth-plain-${Date.now()}@test.local`, roleHint: "user" });
  const athleteUser = await makeUser({ email: `pr2b-unauth-athlete-${Date.now()}@test.local`, roleHint: "user" });
  await makeAthleteLinkedTo(athleteUser.id);
  const coach = await makeUser({ email: `pr2b-unauth-coach-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  const clubAdmin = await makeUser({ email: `pr2b-unauth-clubadmin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(clubAdmin.id, club);
  const teamCoach = await makeUser({ email: `pr2b-unauth-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamRole(teamCoach.id, team);

  for (const actor of [plainUser, athleteUser, coach, clubAdmin, teamCoach]) {
    const token = await createSession(actor.id);
    const grantRes = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(token) });
    assert.equal(grantRes.status, 403, `${actor.email} must not be able to grant a global role`);
    const revokeRes = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(token) });
    assert.equal(revokeRes.status, 403, `${actor.email} must not be able to revoke a global role`);
  }
});

test("9. a fake role_hint='platform_admin' with no real user_global_roles row cannot grant or revoke global roles", async () => {
  const fakeAdmin = await makeUser({ email: `pr2b-fake-admin-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const target = await makeUser({ email: `pr2b-fake-admin-target-${Date.now()}@test.local`, roleHint: "user" });
  const token = await createSession(fakeAdmin.id);

  const grantRes = await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(grantRes.status, 403, "role_hint='platform_admin' alone must never authorize granting a global role");

  const revokeRes = await api(`/api/organization/users/${target.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revokeRes.status, 403, "role_hint='platform_admin' alone must never authorize revoking a global role");
});

// --- 3/4: last-platform-admin protection ---

test("10. revoking the last active platform_admin is rejected with 409 LAST_PLATFORM_ADMIN", async () => {
  const solo = await makePlatformAdmin(`pr2b-solo-admin-${Date.now()}@test.local`);
  const token = await createSession(solo.id);

  await withOnlyTheseAdminsActive([solo.id], async () => {
    const res = await api(`/api/organization/users/${solo.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "LAST_PLATFORM_ADMIN");

    const row = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'platform_admin'`, [solo.id]);
    assert.equal(row.rows[0].is_active, true, "the last admin's role must remain active after a rejected revoke");
  });
});

test("11. disabling the last active platform_admin's login is rejected with 409 LAST_PLATFORM_ADMIN (a more specific reason than the generic self-disable 400)", async () => {
  // The only way to actually reach "disabling the last admin" is a platform
  // admin targeting THEIR OWN login while no other qualifying admin exists -
  // any other admin acting on someone else's login always leaves themselves
  // counted as a remaining admin. The last-admin check runs before the
  // generic self-disable rule specifically so this case is distinguishable
  // (409) from an ordinary self-disable attempt when other admins exist
  // (400, see test 15).
  const solo = await makePlatformAdmin(`pr2b-solo-login-${Date.now()}@test.local`);
  const soloToken = await createSession(solo.id);

  await withOnlyTheseAdminsActive([solo.id], async () => {
    const res = await api(`/api/organization/users/${solo.id}/login-status`, { method: "PUT", cookie: cookieFor(soloToken), body: { active: false } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "LAST_PLATFORM_ADMIN");

    const row = await query(`select is_active from public.users where id = $1`, [solo.id]);
    assert.equal(row.rows[0].is_active, true, "the last admin's login must remain active after a rejected disable");
  });
});

test("12. two concurrent revoke requests for platform_admin never leave zero active admins", async () => {
  const admin1 = await makePlatformAdmin(`pr2b-concurrent-1-${Date.now()}@test.local`);
  const admin2 = await makePlatformAdmin(`pr2b-concurrent-2-${Date.now()}@test.local`);
  const token1 = await createSession(admin1.id);
  const token2 = await createSession(admin2.id);

  await withOnlyTheseAdminsActive([admin1.id, admin2.id], async () => {
    const [res1, res2] = await Promise.all([
      api(`/api/organization/users/${admin1.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token1) }),
      api(`/api/organization/users/${admin2.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token2) }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one concurrent revoke must succeed and the other must be rejected as the last admin");

    const remaining = await query(
      `select count(*)::int as c from public.user_global_roles where role = 'platform_admin' and is_active = true and user_id = any($1::uuid[])`,
      [[admin1.id, admin2.id]],
    );
    assert.equal(remaining.rows[0].c, 1, "exactly one of the two admins must remain active");
  });
});

// --- 5: login-status endpoint ---

test("13. disabling a login destroys sessions but preserves every role", async () => {
  const admin = await makePlatformAdmin(`pr2b-disable-admin-${Date.now()}@test.local`);
  const club = await makeClub(`PR2B Disable Club ${Date.now()}`);
  const target = await makeUser({ email: `pr2b-disable-target-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  await grantClubRole(target.id, club);
  await createSession(target.id);
  assert.equal(await sessionCountFor(target.id), 1);
  const adminToken = await createSession(admin.id);

  const res = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.disabled, true);

  assert.equal(await sessionCountFor(target.id), 0, "disabling must destroy all of the target's sessions");
  const roleRow = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [target.id]);
  assert.equal(roleRow.rows[0].is_active, true, "disabling a login must preserve global roles");
  const clubRow = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2`, [target.id, club]);
  assert.equal(clubRow.rows[0].is_active, true, "disabling a login must preserve club roles");
});

test("14. re-enabling a disabled login does not reactivate a role that was separately revoked", async () => {
  const admin = await makePlatformAdmin(`pr2b-reenable-admin-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-reenable-target-${Date.now()}@test.local`, roleHint: "user" });
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  const adminToken = await createSession(admin.id);

  await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: false } });
  await api(`/api/organization/users/${target.id}/global-roles/independent_coach`, { method: "DELETE", cookie: cookieFor(adminToken) });
  const reenable = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: true } });
  assert.equal(reenable.status, 200);
  assert.equal(reenable.body.active, true);

  const roleRow = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [target.id]);
  assert.equal(roleRow.rows[0].is_active, false, "re-enabling the login must not resurrect a separately-revoked role");
});

test("15. self-disable is rejected even for a platform admin with other admins available", async () => {
  const admin = await makePlatformAdmin(`pr2b-self-disable-a-${Date.now()}@test.local`);
  await makePlatformAdmin(`pr2b-self-disable-b-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/users/${admin.id}/login-status`, { method: "PUT", cookie: cookieFor(token), body: { active: false } });
  assert.equal(res.status, 400);

  const row = await query(`select is_active from public.users where id = $1`, [admin.id]);
  assert.equal(row.rows[0].is_active, true);
});

test("16. a club admin can disable a login for an account they created, but never a platform admin's login", async () => {
  const club = await makeClub(`PR2B Scope Club ${Date.now()}`);
  const clubAdmin = await makeUser({ email: `pr2b-scope-clubadmin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(clubAdmin.id, club);
  const clubAdminToken = await createSession(clubAdmin.id);

  const created = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(clubAdminToken),
    body: { email: `pr2b-scope-created-${Date.now()}@test.local`, password: "somepassword123", roleHint: "athlete" },
  });
  assert.equal(created.status, 201);
  cleanupUserIds.add(created.body.user.id);

  const disableOwn = await api(`/api/organization/users/${created.body.user.id}/login-status`, { method: "PUT", cookie: cookieFor(clubAdminToken), body: { active: false } });
  assert.equal(disableOwn.status, 200, "a club admin must be able to disable the login of an account they created");

  const platformAdmin = await makePlatformAdmin(`pr2b-scope-platform-${Date.now()}@test.local`);
  const disableAdmin = await api(`/api/organization/users/${platformAdmin.id}/login-status`, { method: "PUT", cookie: cookieFor(clubAdminToken), body: { active: false } });
  assert.notEqual(disableAdmin.status, 200, "a club admin must never be able to disable a platform admin's login");

  const adminRow = await query(`select is_active from public.users where id = $1`, [platformAdmin.id]);
  assert.equal(adminRow.rows[0].is_active, true);
});

test("17. the legacy DELETE /users/:userId disables the account (never deletes the row) and is scope/last-admin protected the same way", async () => {
  const admin = await makePlatformAdmin(`pr2b-legacy-delete-admin-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-legacy-delete-target-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);

  const res = await api(`/api/organization/users/${target.id}`, { method: "DELETE", cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);
  assert.equal(res.body.disabled, true, "the response must label the account as disabled, not deleted");
  assert.equal(res.body.deleted, false);

  const row = await query(`select is_active from public.users where id = $1`, [target.id]);
  assert.notEqual(row.rows[0], undefined, "the row must still exist - never a hard delete");
  assert.equal(row.rows[0].is_active, false);

  const soloAdminRes = await api(`/api/organization/users/${admin.id}`, { method: "DELETE", cookie: cookieFor(adminToken) });
  assert.equal(soloAdminRes.status, 400, "self-disable must still be rejected through the legacy endpoint");
});

// --- 4: self-escalation for platform admins themselves ---

test("18. a platform admin can grant themselves independent_coach", async () => {
  const admin = await makePlatformAdmin(`pr2b-self-grant-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/users/${admin.id}/global-roles/independent_coach`, { method: "PUT", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.globalRoles.find((r) => r.role === "independent_coach").isActive, true);
});

test("19. a platform admin can revoke their own platform_admin role when another active admin exists", async () => {
  const admin = await makePlatformAdmin(`pr2b-self-revoke-${Date.now()}@test.local`);
  await makePlatformAdmin(`pr2b-self-revoke-other-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const res = await api(`/api/organization/users/${admin.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.globalRoles.find((r) => r.role === "platform_admin").isActive, false);
});

// --- 6: GET /api/organization returns structured real roles ---

test("20. GET /api/organization returns structured globalRoles/clubRoles/teamRoles/isAthlete/capabilities for each user", async () => {
  const admin = await makePlatformAdmin(`pr2b-shape-admin-${Date.now()}@test.local`);
  const clubName = `PR2B Shape Club ${Date.now()}`;
  const club = await makeClub(clubName);
  const team = await makeTeam(club, "PR2B Shape Team");
  const target = await makeUser({ email: `pr2b-shape-target-${Date.now()}@test.local`, roleHint: "athlete" });
  await grantGlobalRoleDirectly(target.id, "independent_coach");
  await grantClubRole(target.id, club);
  await grantTeamRole(target.id, team);
  await makeAthleteLinkedTo(target.id);
  const adminToken = await createSession(admin.id);

  const res = await api("/api/organization", { cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);
  const row = res.body.users.find((u) => u.id === target.id);
  assert.ok(row, "the target must appear in the Users list");
  assert.equal(row.legacyDisplayRole, "athlete");
  assert.equal(row.isAthlete, true);
  assert.equal(row.loginActive, true);
  assert.ok(row.globalRoles.some((r) => r.role === "independent_coach" && r.isActive));
  assert.ok(row.clubRoles.some((r) => r.clubId === club && r.role === "club_admin" && r.isActive));
  assert.equal(row.clubRoles.find((r) => r.clubId === club).clubName, clubName);
  assert.ok(row.teamRoles.some((r) => r.teamId === team && r.role === "team_coach" && r.isActive));
  assert.equal(row.teamRoles.find((r) => r.teamId === team).clubId, club);
  assert.equal(row.capabilities.coachWorkspace, true);
  assert.equal(row.capabilities.athleteWorkspace, true);
  assert.equal(row.capabilities.platformAdministration, false);
});

// --- follow-up fixes: LAST_PLATFORM_ADMIN must mean login-active AND
// role-active; a shared cross-endpoint lock; disabled accounts stay
// visible; strict login-status body validation ---

test("21. a role-active admin whose LOGIN is disabled does not count toward the LAST_PLATFORM_ADMIN check", async () => {
  const qualifying = await makePlatformAdmin(`pr2b-qualifying-${Date.now()}@test.local`);
  const loginDisabled = await makePlatformAdmin(`pr2b-login-disabled-${Date.now()}@test.local`);
  // Bypasses the endpoint on purpose - this builds the fixture state (role
  // active, login disabled) directly, rather than exercising the
  // disable-login code path itself.
  await query(`update public.users set is_active = false where id = $1`, [loginDisabled.id]);
  const token = await createSession(qualifying.id);

  await withOnlyTheseAdminsActive([qualifying.id, loginDisabled.id], async () => {
    const res = await api(`/api/organization/users/${qualifying.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(token) });
    assert.equal(res.status, 409, "the only login-active admin must be protected even though another role-active-but-login-disabled row exists");
    assert.equal(res.body.error, "LAST_PLATFORM_ADMIN");

    const row = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'platform_admin'`, [qualifying.id]);
    assert.equal(row.rows[0].is_active, true);
  });
});

test("22. concurrent revoke-role and disable-login targeting different admins never leave zero login-active admins", async () => {
  const adminA = await makePlatformAdmin(`pr2b-cross-a-${Date.now()}@test.local`);
  const adminB = await makePlatformAdmin(`pr2b-cross-b-${Date.now()}@test.local`);
  const actorToken = await createSession(adminA.id);

  await withOnlyTheseAdminsActive([adminA.id, adminB.id], async () => {
    const [revokeRes, disableRes] = await Promise.all([
      api(`/api/organization/users/${adminA.id}/global-roles/platform_admin`, { method: "DELETE", cookie: cookieFor(actorToken) }),
      api(`/api/organization/users/${adminB.id}/login-status`, { method: "PUT", cookie: cookieFor(actorToken), body: { active: false } }),
    ]);

    const statuses = [revokeRes.status, disableRes.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one of the two cross-endpoint operations must succeed");

    const qualifying = await query(
      `select u.id
       from public.users u
       join public.user_global_roles g on g.user_id = u.id and g.role = 'platform_admin' and g.is_active = true
       where u.is_active = true and u.id = any($1::uuid[])`,
      [[adminA.id, adminB.id]],
    );
    assert.equal(qualifying.rows.length, 1, "exactly one of the two admins must remain login-active and role-active");
  });
});

test("23. a disabled account remains visible in GET /organization with loginActive=false, and re-enabling flips it back to true", async () => {
  const admin = await makePlatformAdmin(`pr2b-visible-admin-${Date.now()}@test.local`);
  const club = await makeClub(`PR2B Visible Club ${Date.now()}`);
  const target = await makeUser({ email: `pr2b-visible-target-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(target.id, club);
  const adminToken = await createSession(admin.id);

  const disable = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: false } });
  assert.equal(disable.status, 200);

  const afterDisable = await api("/api/organization", { cookie: cookieFor(adminToken) });
  const disabledRow = afterDisable.body.users.find((u) => u.id === target.id);
  assert.ok(disabledRow, "a disabled account must still appear in the Users list so it can be found and re-enabled");
  assert.equal(disabledRow.loginActive, false);
  assert.ok(disabledRow.clubRoles.some((r) => r.clubId === club), "role data must still be present for a disabled account");

  const reenable = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: true } });
  assert.equal(reenable.status, 200);

  const afterReenable = await api("/api/organization", { cookie: cookieFor(adminToken) });
  const activeRow = afterReenable.body.users.find((u) => u.id === target.id);
  assert.equal(activeRow.loginActive, true);
});

test("24-27. login-status rejects anything that isn't a strict JSON boolean, with no mutation", async () => {
  const admin = await makePlatformAdmin(`pr2b-strict-admin-${Date.now()}@test.local`);
  const target = await makeUser({ email: `pr2b-strict-target-${Date.now()}@test.local`, roleHint: "user" });
  await createSession(target.id);
  const adminToken = await createSession(admin.id);
  const sessionsBefore = await sessionCountFor(target.id);

  const cases = [
    { label: "missing active", body: {} },
    { label: "string \"false\"", body: { active: "false" } },
    { label: "number 0", body: { active: 0 } },
    { label: "number 1", body: { active: 1 } },
    { label: "null", body: { active: null } },
  ];

  for (const { label, body } of cases) {
    const res = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body });
    assert.equal(res.status, 400, `${label} must be rejected`);
    assert.equal(res.body.error, "INVALID_LOGIN_STATUS", `${label} must return INVALID_LOGIN_STATUS`);
  }

  const row = await query(`select is_active from public.users where id = $1`, [target.id]);
  assert.equal(row.rows[0].is_active, true, "no invalid body may have changed the account's login status");
  assert.equal(await sessionCountFor(target.id), sessionsBefore, "no invalid body may have touched sessions");
});

// --- canManageLogin: GET /organization must mirror setUserLoginStatus's own policy ---

test("28. a platform admin viewer gets canManageLogin=true for every visible account", async () => {
  const admin = await makePlatformAdmin(`pr2b-canmanage-admin-${Date.now()}@test.local`);
  const other = await makeUser({ email: `pr2b-canmanage-other-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);

  const res = await api("/api/organization", { cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);
  const row = res.body.users.find((u) => u.id === other.id);
  assert.ok(row, "a platform admin must see every account");
  assert.equal(row.canManageLogin, true, "a platform admin must be able to manage any account's login");
});

test("29. a non-admin creator gets canManageLogin=true only for the account they created", async () => {
  const club = await makeClub(`PR2B CanManage Club ${Date.now()}`);
  const clubAdmin = await makeUser({ email: `pr2b-canmanage-creator-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(clubAdmin.id, club);
  const clubAdminToken = await createSession(clubAdmin.id);

  const created = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(clubAdminToken),
    body: { email: `pr2b-canmanage-created-${Date.now()}@test.local`, password: "somepassword123", roleHint: "athlete" },
  });
  assert.equal(created.status, 201);
  cleanupUserIds.add(created.body.user.id);

  const res = await api("/api/organization", { cookie: cookieFor(clubAdminToken) });
  assert.equal(res.status, 200);
  const ownRow = res.body.users.find((u) => u.id === created.body.user.id);
  assert.ok(ownRow, "the creator must see the account they created");
  assert.equal(ownRow.canManageLogin, true, "the creator must be able to manage the login of an account they created");
});

test("30. a club/team-scoped viewer sees an account through shared scope but canManageLogin=false without ownership", async () => {
  const club = await makeClub(`PR2B CanManage Scope Club ${Date.now()}`);
  const viewer = await makeUser({ email: `pr2b-canmanage-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(viewer.id, club);
  const viewerToken = await createSession(viewer.id);

  // Visible to viewer only because they share the club - viewer never
  // created this account and never grants/creates it here.
  const platformAdmin = await makePlatformAdmin(`pr2b-canmanage-other-creator-${Date.now()}@test.local`);
  const platformAdminToken = await createSession(platformAdmin.id);
  const created = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(platformAdminToken),
    body: { email: `pr2b-canmanage-scoped-${Date.now()}@test.local`, password: "somepassword123", roleHint: "athlete" },
  });
  assert.equal(created.status, 201);
  cleanupUserIds.add(created.body.user.id);
  await grantClubRole(created.body.user.id, club);

  const res = await api("/api/organization", { cookie: cookieFor(viewerToken) });
  assert.equal(res.status, 200);
  const row = res.body.users.find((u) => u.id === created.body.user.id);
  assert.ok(row, "the viewer must see the account through the shared club scope");
  assert.equal(row.canManageLogin, false, "shared scope alone must not grant login-management rights without ownership");
});

test("31. a hand-crafted login-status request from a non-owning, non-admin viewer is still rejected regardless of canManageLogin", async () => {
  const club = await makeClub(`PR2B CanManage Enforce Club ${Date.now()}`);
  const viewer = await makeUser({ email: `pr2b-canmanage-enforce-viewer-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubRole(viewer.id, club);
  const viewerToken = await createSession(viewer.id);

  const platformAdmin = await makePlatformAdmin(`pr2b-canmanage-enforce-creator-${Date.now()}@test.local`);
  const platformAdminToken = await createSession(platformAdmin.id);
  const created = await api("/api/organization/users", {
    method: "POST",
    cookie: cookieFor(platformAdminToken),
    body: { email: `pr2b-canmanage-enforce-target-${Date.now()}@test.local`, password: "somepassword123", roleHint: "athlete" },
  });
  assert.equal(created.status, 201);
  cleanupUserIds.add(created.body.user.id);
  await grantClubRole(created.body.user.id, club);

  const res = await api(`/api/organization/users/${created.body.user.id}/login-status`, {
    method: "PUT",
    cookie: cookieFor(viewerToken),
    body: { active: false },
  });
  assert.notEqual(res.status, 200, "the backend must still reject this even though the account is visible to the viewer");

  const row = await query(`select is_active from public.users where id = $1`, [created.body.user.id]);
  assert.equal(row.rows[0].is_active, true, "the account's login status must be untouched");
});
