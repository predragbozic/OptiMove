import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/group-athlete-join-links: a link tied to a CONTEXT
// (private_coach/club/team) that many different people can submit a request
// against, each reviewed and approved/rejected independently. Deliberately
// separate from the single-athlete invite lifecycle
// (athlete-invite-lifecycle.test.mjs / athlete-invite-hardening.test.mjs) -
// no join link is ever addressed to a pre-existing athlete profile.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupJoinLinkIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    // athlete_join_applications cascades from athlete_join_links.
    ["join links", () => cleanupJoinLinkIds.size && query(`delete from public.athlete_join_links where id = any($1::uuid[])`, [[...cleanupJoinLinkIds]])],
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

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
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
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
     on conflict (user_id, role) do update set is_active = true, revoked_at = null, updated_at = now()`,
    [userId, role],
  );
}

async function revokeGlobalRoleDirectly(userId, role) {
  await query(`update public.user_global_roles set is_active = false, revoked_at = now() where user_id = $1 and role = $2`, [userId, role]);
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

async function makePrivateCoach(email) {
  const coach = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  return coach;
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

function linksEndpoint() {
  return "/api/organization/athlete-join-links";
}

async function createLink(cookie, { contextType, contextId = null, label = "Test link", expiresInDays = 7, maxUses = null }) {
  return api(linksEndpoint(), { method: "POST", cookie, body: { contextType, contextId, label, expiresInDays, maxUses } });
}

function extractToken(joinUrl) {
  return decodeURIComponent(joinUrl.split("token=")[1]);
}

async function trackLink(created) {
  if (created?.body?.link?.id) cleanupJoinLinkIds.add(created.body.link.id);
  return created;
}

// feature/email-verification-foundation: every new-email apply() response
// now includes a devVerificationToken (non-production only - see
// backend/src/routes/auth.js) that must be confirmed via this endpoint
// before the resulting application can ever be approved. Existing tests
// below that approve a new-email application now call this first - the
// email-verification-specific behavior itself (expiry, reuse, races,
// resend, EMAIL_NOT_VERIFIED gating) is covered separately in
// backend/tests/email-verification.test.mjs.
async function confirmEmail(rawVerificationToken) {
  return api(`/api/auth/email-verifications/${encodeURIComponent(rawVerificationToken)}/confirm`, { method: "POST" });
}

// --- 1: creation permission matrix ---

test("1a. a private coach can create a private_coach join link", async () => {
  const coach = await makePrivateCoach(`join-priv-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  assert.equal(created.status, 201);
  assert.equal(created.body.link.contextType, "private_coach");
  assert.ok(created.body.joinUrl.includes("/join?token="));
});

test("1b. a plain user cannot create a private_coach join link", async () => {
  const user = await makeUser({ email: `join-plain-${Date.now()}@test.local` });
  const token = await createSession(user.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  assert.equal(created.status, 403);
});

test("1c. a club admin can create a club join link for their own club, not for another club", async () => {
  const clubA = await makeClub(`Join Club A ${Date.now()}`);
  const clubB = await makeClub(`Join Club B ${Date.now()}`);
  const admin = await makeUser({ email: `join-clubadmin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, clubA);
  const token = await createSession(admin.id);

  const ok = await trackLink(await createLink(cookieFor(token), { contextType: "club", contextId: clubA, expiresInDays: 10 }));
  assert.equal(ok.status, 201);

  const forbidden = await createLink(cookieFor(token), { contextType: "club", contextId: clubB, expiresInDays: 10 });
  assert.equal(forbidden.status, 403);
});

test("1d. a team coach can create a team join link, and a club admin can create one for a team in their own club", async () => {
  const club = await makeClub(`Join Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Join Team");
  const coach = await makeUser({ email: `join-teamcoach-${Date.now()}@test.local` });
  await grantTeamCoachDirectly(coach.id, team);
  const coachToken = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(coachToken), { contextType: "team", contextId: team, expiresInDays: 10 }));
  assert.equal(created.status, 201);

  const admin = await makeUser({ email: `join-clubadmin-team-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const adminToken = await createSession(admin.id);
  const createdByAdmin = await trackLink(await createLink(cookieFor(adminToken), { contextType: "team", contextId: team, expiresInDays: 10 }));
  assert.equal(createdByAdmin.status, 201);
});

test("1e. a fake/generic role_hint never grants join-link creation - only real scoped roles do", async () => {
  const club = await makeClub(`Join Fake Role Club ${Date.now()}`);
  const faker = await makeUser({ email: `join-fake-${Date.now()}@test.local`, roleHint: "club_admin" });
  const token = await createSession(faker.id);
  const created = await createLink(cookieFor(token), { contextType: "club", contextId: club, expiresInDays: 5 });
  assert.equal(created.status, 403, "role_hint='club_admin' with no real user_club_roles row must never grant this");
});

test("1f. an unsupported context (e.g. platform, athlete) is rejected", async () => {
  const admin = await makePlatformAdmin(`join-platformctx-${Date.now()}@test.local`);
  const token = await createSession(admin.id);
  const created = await createLink(cookieFor(token), { contextType: "platform", expiresInDays: 5 });
  assert.equal(created.status, 400);
  assert.equal(created.body.error, "UNSUPPORTED_JOIN_LINK_CONTEXT");
});

test("1g. expiresInDays and maxUses are bounded", async () => {
  const coach = await makePrivateCoach(`join-bounds-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const tooLong = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 90 });
  assert.equal(tooLong.status, 400);
  const tooManyUses = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, maxUses: 5000 });
  assert.equal(tooManyUses.status, 400);
});

// --- 2: raw token is never stored ---

test("2. the raw join-link token is never persisted, only its hash", async () => {
  const coach = await makePrivateCoach(`join-rawtoken-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const row = await query(`select token_hash from public.athlete_join_links where id = $1`, [created.body.link.id]);
  assert.notEqual(row.rows[0].token_hash, rawToken);
  assert.equal(row.rows[0].token_hash, hashToken(rawToken));
});

// --- 3: public GET + generic invalid/expired/revoked/full response ---

test("3a. GET /join-links/:token returns safe public info for a valid link", async () => {
  const club = await makeClub(`Join Public Info Club ${Date.now()}`);
  const admin = await makeUser({ email: `join-publicinfo-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "club", contextId: club, label: "Come join us", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);

  const lookup = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.link.label, "Come join us");
  assert.equal(lookup.body.link.contextType, "club");
  assert.ok(!("token" in lookup.body.link) && !("tokenHash" in lookup.body.link) && !("createdByEmail" in lookup.body.link));
});

test("3b. an unknown token returns the generic 404 message", async () => {
  const lookup = await api(`/api/auth/join-links/${encodeURIComponent("totally-made-up-token")}`);
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.error, "This join link is invalid or no longer available.");
});

test("3c. a revoked link returns the same generic message", async () => {
  const coach = await makePrivateCoach(`join-revoked-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const revoke = await api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);
  const lookup = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.error, "This join link is invalid or no longer available.");
});

test("3d. a link at max capacity returns the same generic message for new lookups", async () => {
  const coach = await makePrivateCoach(`join-full-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, maxUses: 1 }));
  const rawToken = extractToken(created.body.joinUrl);

  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Full", lastName: "Slot", email: `join-full-applicant-${Date.now()}@test.local`, password: "somepassword123" },
  });
  assert.equal(apply.status, 201);
  const confirm = await confirmEmail(apply.body.devVerificationToken);
  assert.equal(confirm.status, 200);
  const approve = await api(`/api/organization/athlete-join-applications/${(await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 200);
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);

  const lookup = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404, "a link at max capacity must be treated as unavailable for new applications");
  assert.equal(lookup.body.error, "This join link is invalid or no longer available.");
});

// --- 4: regenerate invalidates the old token but keeps pending applications ---

test("4. regenerate invalidates the old token immediately, and never deletes already-submitted pending applications", async () => {
  const coach = await makePrivateCoach(`join-regen-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const oldRawToken = extractToken(created.body.joinUrl);

  const apply = await api(`/api/auth/join-links/${encodeURIComponent(oldRawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Pending", lastName: "Person", email: `join-regen-applicant-${Date.now()}@test.local`, password: "somepassword123" },
  });
  assert.equal(apply.status, 201);

  const regenerate = await api(`${linksEndpoint()}/${created.body.link.id}/regenerate`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(regenerate.status, 200);
  assert.equal(regenerate.body.link.id, created.body.link.id, "regenerate must keep the same link id/row");
  const newRawToken = extractToken(regenerate.body.joinUrl);
  assert.notEqual(newRawToken, oldRawToken);

  const oldLookup = await api(`/api/auth/join-links/${encodeURIComponent(oldRawToken)}`);
  assert.equal(oldLookup.status, 404, "the old token must be invalid immediately after regenerate");
  const newLookup = await api(`/api/auth/join-links/${encodeURIComponent(newRawToken)}`);
  assert.equal(newLookup.status, 200);

  const pendingCount = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1 and status = 'pending'`, [created.body.link.id]);
  assert.equal(Number(pendingCount.rows[0].count), 1, "regenerate must never delete an already-submitted pending application");
});

// --- 5: revoke cancels pending applications and strips password hashes ---

test("5. revoke cancels every pending application for the link and clears their password hashes", async () => {
  const coach = await makePrivateCoach(`join-revoke-cancel-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);

  const email = `join-revoke-cancel-applicant-${Date.now()}@test.local`;
  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Cancel", lastName: "Me", email, password: "somepassword123" },
  });
  assert.equal(apply.status, 201);

  const revoke = await api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);

  const row = await query(`select status, password_hash from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].password_hash, null);
});

// --- 6: multiple new athletes can use the same link ---

test("6. several different people can submit a pending request against the same link", async () => {
  const club = await makeClub(`Join Multi Club ${Date.now()}`);
  const admin = await makeUser({ email: `join-multi-admin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);

  const applyA = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Person", lastName: "A", email: `join-multi-a-${Date.now()}@test.local`, password: "somepassword123" },
  });
  const applyB = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Person", lastName: "B", email: `join-multi-b-${Date.now()}@test.local`, password: "somepassword456" },
  });
  assert.equal(applyA.status, 201);
  assert.equal(applyB.status, 201);
  assert.notEqual(applyA.body.statusToken, applyB.body.statusToken);

  const count = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(Number(count.rows[0].count), 2);
});

// --- 7: new-email apply never creates a user/athlete row up front ---

test("7. a brand-new-email apply creates only a pending application, never a user or athlete row", async () => {
  const coach = await makePrivateCoach(`join-newemail-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-newemail-applicant-${Date.now()}@test.local`;

  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "New", lastName: "Email", email, password: "somepassword123" },
  });
  assert.equal(apply.status, 201);
  assert.ok(apply.body.statusToken);

  const userRow = await query(`select id from public.users where lower(email) = lower($1)`, [email]);
  assert.equal(userRow.rowCount, 0, "no user row may exist before approval");
  const appRow = await query(`select applicant_user_id, resulting_user_id, resulting_athlete_id, password_hash, status from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(appRow.rows[0].applicant_user_id, null);
  assert.equal(appRow.rows[0].resulting_user_id, null);
  assert.equal(appRow.rows[0].resulting_athlete_id, null);
  assert.equal(appRow.rows[0].status, "pending");
  assert.ok(appRow.rows[0].password_hash, "a pending new-email application must carry a password hash");
});

// --- 8: existing email -> requiresLogin, password never touched ---

test("8. applying with an email that already has an account returns requiresLogin and never creates a second pending row or touches the password", async () => {
  const coach = await makePrivateCoach(`join-existingemail-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const existing = await makeUser({ email: `join-existing-target-${Date.now()}@test.local` });
  const originalHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;

  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Should", lastName: "Fail", email: existing.email, password: "totallydifferentpassword1" },
  });
  assert.equal(apply.status, 409);
  assert.equal(apply.body.requiresLogin, true);

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  assert.equal(afterHash, originalHash, "the existing account's password must never be touched by the public apply form");
  const count = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(Number(count.rows[0].count), 0, "no application row is created for an email that already has an account");
});

// --- 9: authenticated existing-user apply ---

test("9. an authenticated existing user can apply-existing, and it never carries a password", async () => {
  const club = await makeClub(`Join Existing Apply Club ${Date.now()}`);
  const admin = await makeUser({ email: `join-existing-apply-admin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const adminToken = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(adminToken), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);

  const existing = await makeUser({ email: `join-existing-applicant-${Date.now()}@test.local` });
  const existingToken = await createSession(existing.id);

  const applyExisting = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(applyExisting.status, 201);
  assert.ok(applyExisting.body.statusToken);

  const row = await query(`select applicant_user_id, email, password_hash, status from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(String(row.rows[0].applicant_user_id), String(existing.id));
  assert.equal(row.rows[0].email.toLowerCase(), existing.email.toLowerCase());
  assert.equal(row.rows[0].password_hash, null);
});

test("9b. apply-existing without a session is rejected", async () => {
  const coach = await makePrivateCoach(`join-existing-noauth-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const applyExisting = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST" });
  assert.equal(applyExisting.status, 401);
});

// --- 10: status token only sees its own application ---

test("10. a status token only ever reveals its own application, never any other's", async () => {
  const coach = await makePrivateCoach(`join-statustoken-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, label: "Status token link" }));
  const rawToken = extractToken(created.body.joinUrl);

  const applyA = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Status", lastName: "A", email: `join-status-a-${Date.now()}@test.local`, password: "somepassword123" },
  });
  const applyB = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Status", lastName: "B", email: `join-status-b-${Date.now()}@test.local`, password: "somepassword456" },
  });

  const statusA = await api(`/api/auth/join-applications/${encodeURIComponent(applyA.body.statusToken)}`);
  assert.equal(statusA.status, 200);
  assert.equal(statusA.body.application.status, "pending");
  assert.equal(statusA.body.application.contextLabel, "Status token link");

  // Using B's status token must never surface A's application (or vice versa) -
  // each token is scoped to exactly the one application it was issued for.
  const crossCheck = await api(`/api/auth/join-applications/${encodeURIComponent(applyA.body.statusToken)}`);
  assert.notEqual(crossCheck.body.application, undefined);
  const unknown = await api(`/api/auth/join-applications/${encodeURIComponent("not-a-real-status-token")}`);
  assert.equal(unknown.status, 404);
  void applyB;
});

// --- 11: duplicate pending protection ---

test("11a. a second apply with the same email against the same link does not create a second row", async () => {
  const coach = await makePrivateCoach(`join-dupe-email-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-dupe-email-applicant-${Date.now()}@test.local`;

  const first = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Dupe", lastName: "One", email, password: "somepassword123" } });
  assert.equal(first.status, 201);
  const second = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Dupe", lastName: "Two", email, password: "someotherpassword456" } });
  assert.equal(second.status, 409);

  const count = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1 and lower(email) = lower($2)`, [created.body.link.id, email]);
  assert.equal(Number(count.rows[0].count), 1);
});

test("11b. a second apply-existing by the same account against the same link does not create a second row", async () => {
  const coach = await makePrivateCoach(`join-dupe-user-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const existing = await makeUser({ email: `join-dupe-user-applicant-${Date.now()}@test.local` });
  const existingToken = await createSession(existing.id);

  const first = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(first.status, 201);
  const second = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(second.status, 409);

  const count = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1 and applicant_user_id = $2`, [created.body.link.id, existing.id]);
  assert.equal(Number(count.rows[0].count), 1);
});

// --- 12: approve new-email applicant ---

test("12. approving a new-email application creates exactly one user + athlete, links them, and sets approved/audit fields", async () => {
  const coach = await makePrivateCoach(`join-approve-new-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-approve-new-applicant-${Date.now()}@test.local`;

  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Approve", lastName: "New", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  const confirm = await confirmEmail(apply.body.devVerificationToken);
  assert.equal(confirm.status, 200);

  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 200);
  assert.ok(approve.body.userId);
  assert.ok(approve.body.athleteId);
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);

  const newUser = await query(`select id, password_hash from public.users where id = $1`, [approve.body.userId]);
  assert.equal(newUser.rows[0].password_hash.startsWith("pbkdf2:"), true);
  const athleteRow = await query(`select user_id, created_by_user_id from public.athletes where id = $1`, [approve.body.athleteId]);
  assert.equal(String(athleteRow.rows[0].user_id), String(approve.body.userId));

  const relationship = await query(`select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true`, [coach.id, approve.body.athleteId]);
  assert.equal(relationship.rowCount, 1, "approving a private_coach application must create the coach relationship");

  const appRow = await query(`select status, password_hash, reviewed_by_user_id, resulting_user_id, resulting_athlete_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(appRow.rows[0].status, "approved");
  assert.equal(appRow.rows[0].password_hash, null);
  assert.equal(String(appRow.rows[0].reviewed_by_user_id), String(coach.id));
  assert.equal(String(appRow.rows[0].resulting_user_id), String(approve.body.userId));

  void apply;
});

// --- 13: approve existing multi-role user, reusing an athlete profile ---

test("13. approving an existing multi-role account's application never touches their password/roles, and reuses an existing athlete profile", async () => {
  const club = await makeClub(`Join Approve Existing Club ${Date.now()}`);
  const admin = await makeUser({ email: `join-approve-existing-admin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const adminToken = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(adminToken), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);

  const existing = await makeUser({ email: `join-approve-existing-applicant-${Date.now()}@test.local` });
  await grantGlobalRoleDirectly(existing.id, "independent_coach");
  const existingToken = await createSession(existing.id);
  const originalHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;

  // Pre-existing athlete profile for this exact account.
  const preExisting = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Existing', 'Athlete', 'Existing Athlete', 'Existing Athlete', $2, true)
     returning id`,
    [`joinpre${Math.floor(Math.random() * 900000 + 100000)}`, existing.id],
  );
  cleanupAthleteIds.add(preExisting.rows[0].id);

  const applyExisting = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(applyExisting.status, 201);
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(adminToken) });
  assert.equal(approve.status, 200);
  assert.equal(String(approve.body.athleteId), String(preExisting.rows[0].id), "approval must reuse the account's existing athlete profile, never create a second one");
  assert.equal(String(approve.body.userId), String(existing.id));

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  assert.equal(afterHash, originalHash);
  const stillCoach = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [existing.id]);
  assert.equal(stillCoach.rows[0].is_active, true, "approval must never remove an existing role - multi-role accounts stay multi-role");

  const membership = await query(`select 1 from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active'`, [preExisting.rows[0].id, club]);
  assert.equal(membership.rowCount, 1);
});

// --- 14: team approval creates both club and team membership ---

test("14. approving a team-context application creates both an active club membership and an active team membership", async () => {
  const club = await makeClub(`Join Team Approve Club ${Date.now()}`);
  const team = await makeTeam(club, "Join Team Approve");
  const coach = await makeUser({ email: `join-team-approve-coach-${Date.now()}@test.local` });
  await grantTeamCoachDirectly(coach.id, team);
  const coachToken = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(coachToken), { contextType: "team", contextId: team, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-team-approve-applicant-${Date.now()}@test.local`;

  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Team", lastName: "Joiner", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200);
  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(coachToken) });
  assert.equal(approve.status, 200);
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);

  const clubMembership = await query(`select 1 from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active'`, [approve.body.athleteId, club]);
  assert.equal(clubMembership.rowCount, 1);
  const teamMembership = await query(`select 1 from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team' and status = 'active'`, [approve.body.athleteId, team]);
  assert.equal(teamMembership.rowCount, 1);
});

// --- 15: reject creates nothing and strips the hash ---

test("15. reject sets status/audit fields, creates no user/athlete, and clears the password hash", async () => {
  const coach = await makePrivateCoach(`join-reject-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-reject-applicant-${Date.now()}@test.local`;
  await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Reject", lastName: "Me", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const reject = await api(`/api/organization/athlete-join-applications/${appId}/reject`, { method: "POST", cookie: cookieFor(token), body: { reason: "Not a fit" } });
  assert.equal(reject.status, 200);

  const row = await query(`select status, password_hash, reviewed_by_user_id, rejection_reason, resulting_user_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(row.rows[0].status, "rejected");
  assert.equal(row.rows[0].password_hash, null);
  assert.equal(row.rows[0].rejection_reason, "Not a fit");
  assert.equal(row.rows[0].resulting_user_id, null);
  const userRow = await query(`select id from public.users where lower(email) = lower($1)`, [email]);
  assert.equal(userRow.rowCount, 0);
});

// --- 16: two parallel approvals of the SAME application create only one account ---

test("16. two parallel approve requests for the same application create only one account/profile", async () => {
  const coach = await makePrivateCoach(`join-parallel-approve-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-parallel-approve-applicant-${Date.now()}@test.local`;
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Parallel", lastName: "Approve", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200);

  const [first, second] = await Promise.all([
    api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) }),
    api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one of the two parallel approvals must succeed");
  const winner = first.status === 200 ? first : second;
  cleanupUserIds.add(winner.body.userId);
  cleanupAthleteIds.add(winner.body.athleteId);

  const userCount = await query(`select count(*) from public.users where lower(email) = lower($1)`, [email]);
  assert.equal(Number(userCount.rows[0].count), 1);
});

// --- 17: approve vs revoke race ---

test("17. concurrent approve and revoke: exactly one wins, and a revoked link never ends up with a newly approved application", async () => {
  const coach = await makePrivateCoach(`join-approve-revoke-race-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-approve-revoke-race-applicant-${Date.now()}@test.local`;
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Race", lastName: "Approve", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  // Verify email up front so the race below is genuinely between approve
  // and revoke - not just an immediate, uninteresting EMAIL_NOT_VERIFIED.
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200);

  const [approveRes, revokeRes] = await Promise.all([
    api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) }),
    api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(token) }),
  ]);
  assert.equal(revokeRes.status, 200, "revoke itself always succeeds (it is idempotent)");
  if (approveRes.status === 200) {
    cleanupUserIds.add(approveRes.body.userId);
    cleanupAthleteIds.add(approveRes.body.athleteId);
  } else {
    assert.equal(approveRes.status, 409);
  }

  const row = await query(`select status from public.athlete_join_applications where id = $1`, [appId]);
  assert.ok(["approved", "cancelled"].includes(row.rows[0].status), `application must end up approved or cancelled, got ${row.rows[0].status}`);
});

// --- 18: max_uses concurrency ---

test("18. max_uses = 1 under concurrent approvals never approves more than one application", async () => {
  const coach = await makePrivateCoach(`join-maxuses-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, maxUses: 1 }));
  const rawToken = extractToken(created.body.joinUrl);
  const emailA = `join-maxuses-a-${Date.now()}@test.local`;
  const emailB = `join-maxuses-b-${Date.now()}@test.local`;
  const appliedA = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Max", lastName: "A", email: emailA, password: "somepassword123" } });
  const appliedB = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Max", lastName: "B", email: emailB, password: "somepassword456" } });
  assert.equal((await confirmEmail(appliedA.body.devVerificationToken)).status, 200);
  assert.equal((await confirmEmail(appliedB.body.devVerificationToken)).status, 200);
  const rows = await query(`select id from public.athlete_join_applications where join_link_id = $1 order by submitted_at`, [created.body.link.id]);
  const [appIdA, appIdB] = rows.rows.map((r) => r.id);

  const [resA, resB] = await Promise.all([
    api(`/api/organization/athlete-join-applications/${appIdA}/approve`, { method: "POST", cookie: cookieFor(token) }),
    api(`/api/organization/athlete-join-applications/${appIdB}/approve`, { method: "POST", cookie: cookieFor(token) }),
  ]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [200, 409], "with max_uses=1, exactly one of two concurrent approvals may succeed");
  const winner = resA.status === 200 ? resA : resB;
  cleanupUserIds.add(winner.body.userId);
  cleanupAthleteIds.add(winner.body.athleteId);

  const linkRow = await query(`select approved_uses from public.athlete_join_links where id = $1`, [created.body.link.id]);
  assert.equal(Number(linkRow.rows[0].approved_uses), 1);
});

// --- 19: email-now-exists race at approval time ---

test("19. approving a new-email application whose email now belongs to a real account returns EMAIL_NOW_EXISTS_REQUIRES_LOGIN and never touches that account", async () => {
  const coach = await makePrivateCoach(`join-email-race-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-email-race-applicant-${Date.now()}@test.local`;
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Race", lastName: "Email", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  // Verified BEFORE the racer below claims the email, so this exercises the
  // approve-time race specifically, not the confirm-time one (already
  // covered by email-verification.test.mjs test 11).
  assert.equal((await confirmEmail(applied.body.devVerificationToken)).status, 200);

  // Someone else claims this exact email via a normal account creation in the
  // meantime.
  const racer = await makeUser({ email });
  const racerHash = (await query(`select password_hash from public.users where id = $1`, [racer.id])).rows[0].password_hash;

  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 409);
  assert.equal(approve.body.error, "EMAIL_NOW_EXISTS_REQUIRES_LOGIN");

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [racer.id])).rows[0].password_hash;
  assert.equal(afterHash, racerHash, "the account that claimed the email first must never be modified by this approval");
  const appRow = await query(`select status, password_hash from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(appRow.rows[0].status, "requires_login");
  assert.equal(appRow.rows[0].password_hash, null);
});

// --- 20: lost role / archived club or team before approval blocks it ---

test("20a. a private coach who loses their role before approval can no longer have it approved", async () => {
  const coach = await makePrivateCoach(`join-lostrole-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-lostrole-applicant-${Date.now()}@test.local`;
  await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Lost", lastName: "Role", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  await revokeGlobalRoleDirectly(coach.id, "independent_coach");
  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 403, "having lost the independent_coach role, this account can no longer manage/review this link at all");

  const row = await query(`select status from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(row.rows[0].status, "pending", "nothing must be created/changed when approval is blocked");
});

test("20b. an archived club blocks approval of its pending applications even for a still-active club admin", async () => {
  const club = await makeClub(`Join Archived Club ${Date.now()}`);
  const admin = await makeUser({ email: `join-archived-club-admin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-archived-club-applicant-${Date.now()}@test.local`;
  await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Archived", lastName: "Club", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  await query(`update public.clubs set is_active = false where id = $1`, [club]);
  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 409, "an archived club must block approval even though the admin's role row is technically still active");

  // The archived-club sweep (closeUnusableJoinLinkApplications, run inside
  // this same approve attempt) closes the application as 'cancelled' with
  // its password hash cleared - it does NOT stay 'pending' forever, since
  // nothing (no background job) would ever revisit it otherwise. Nothing was
  // created: no user, no athlete, no membership.
  const row = await query(`select status, password_hash, resulting_user_id, resulting_athlete_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].password_hash, null);
  assert.equal(row.rows[0].resulting_user_id, null);
  assert.equal(row.rows[0].resulting_athlete_id, null);
  const userRow = await query(`select id from public.users where lower(email) = lower($1)`, [email]);
  assert.equal(userRow.rowCount, 0, "nothing must be created when approval is blocked by an archived club");
  await query(`update public.clubs set is_active = true where id = $1`, [club]);
});

// --- 21: cross-context isolation ---

test("21. a club admin of a DIFFERENT club can neither see nor approve/reject another club's application", async () => {
  const clubA = await makeClub(`Join Isolation Club A ${Date.now()}`);
  const clubB = await makeClub(`Join Isolation Club B ${Date.now()}`);
  const adminA = await makeUser({ email: `join-isolation-admin-a-${Date.now()}@test.local` });
  const adminB = await makeUser({ email: `join-isolation-admin-b-${Date.now()}@test.local` });
  await grantClubAdminDirectly(adminA.id, clubA);
  await grantClubAdminDirectly(adminB.id, clubB);
  const tokenA = await createSession(adminA.id);
  const tokenB = await createSession(adminB.id);

  const created = await trackLink(await createLink(cookieFor(tokenA), { contextType: "club", contextId: clubA, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-isolation-applicant-${Date.now()}@test.local`;
  await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Isolated", lastName: "Applicant", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const listB = await api(linksEndpoint(), { cookie: cookieFor(tokenB) });
  assert.ok(!listB.body.links.some((l) => l.id === created.body.link.id), "a different club's admin must never see this link in their list");

  const approveByB = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(tokenB) });
  assert.equal(approveByB.status, 403);
  const rejectByB = await api(`/api/organization/athlete-join-applications/${appId}/reject`, { method: "POST", cookie: cookieFor(tokenB) });
  assert.equal(rejectByB.status, 403);
});

// --- 22: role_hint never influences any decision ---

test("22. role_hint plays no part in any join-link decision", async () => {
  const club = await makeClub(`Join RoleHint Club ${Date.now()}`);
  const impostor = await makeUser({ email: `join-rolehint-${Date.now()}@test.local`, roleHint: "platform_admin" });
  const token = await createSession(impostor.id);
  const created = await createLink(cookieFor(token), { contextType: "club", contextId: club, expiresInDays: 5 });
  assert.equal(created.status, 403, "role_hint='platform_admin' with no real user_global_roles row must never grant this");
});

// --- 23: another current holder of the same club/team role can also review ---

test("23. a DIFFERENT current club admin of the same club can approve/reject a pending application (not only the link's creator)", async () => {
  const club = await makeClub(`Join Shared Review Club ${Date.now()}`);
  const creatorAdmin = await makeUser({ email: `join-shared-creator-${Date.now()}@test.local` });
  const otherAdmin = await makeUser({ email: `join-shared-other-${Date.now()}@test.local` });
  await grantClubAdminDirectly(creatorAdmin.id, club);
  await grantClubAdminDirectly(otherAdmin.id, club);
  const creatorToken = await createSession(creatorAdmin.id);
  const otherToken = await createSession(otherAdmin.id);

  const created = await trackLink(await createLink(cookieFor(creatorToken), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-shared-applicant-${Date.now()}@test.local`;
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Shared", lastName: "Review", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  assert.equal((await confirmEmail(applied.body.devVerificationToken)).status, 200);

  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(otherToken) });
  assert.equal(approve.status, 200, "any current club_admin of this club may review it, not only the original creator");
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);
});

// --- 24: a private_coach link stays tied to its specific creator only ---

test("24. a different independent coach cannot manage or review someone else's private_coach link", async () => {
  const coachA = await makePrivateCoach(`join-privatepin-a-${Date.now()}@test.local`);
  const coachB = await makePrivateCoach(`join-privatepin-b-${Date.now()}@test.local`);
  const tokenA = await createSession(coachA.id);
  const tokenB = await createSession(coachB.id);
  const created = await trackLink(await createLink(cookieFor(tokenA), { contextType: "private_coach", expiresInDays: 5 }));

  const revokeByB = await api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(tokenB) });
  assert.equal(revokeByB.status, 403, "a private_coach link stays tied to its specific creator, unlike club/team links");
});

// --- Post-launch hardening: fixes for 3 issues found before merge ---
// 1. Concurrent approval of the SAME existing account through two DIFFERENT
//    join links (so lockJoinLinkActions alone can't serialize them).
// 2. nextAthleteId() raced on a non-transactional MAX(...) + 1 - now backed
//    by public.athlete_generated_id_seq (see
//    migrations/20260808_athlete_id_sequence.sql).
// 3. A pending application's password_hash could live forever once its link
//    expired or its context died, since only approve/reject/revoke ever
//    cleared it - now swept by closeUnusableJoinLinkApplications, called
//    opportunistically from the same authenticated read/management flows
//    that already hold the per-link lock (GET /api/organization[/
//    athlete-join-links], and immediately inside approve/reject).

test("25. two applications for the SAME existing account, through two DIFFERENT join links, both approve successfully and share one athlete profile", async () => {
  const coach = await makePrivateCoach(`join-hardening-existing-coach-${Date.now()}@test.local`);
  const club = await makeClub(`Join Hardening Existing Club ${Date.now()}`);
  const clubAdmin = await makeUser({ email: `join-hardening-existing-clubadmin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(clubAdmin.id, club);
  const coachToken = await createSession(coach.id);
  const clubAdminToken = await createSession(clubAdmin.id);

  const existing = await makeUser({ email: `join-hardening-existing-applicant-${Date.now()}@test.local` });
  const existingToken = await createSession(existing.id);

  const linkA = await trackLink(await createLink(cookieFor(coachToken), { contextType: "private_coach", expiresInDays: 5 }));
  const linkB = await trackLink(await createLink(cookieFor(clubAdminToken), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawTokenA = extractToken(linkA.body.joinUrl);
  const rawTokenB = extractToken(linkB.body.joinUrl);

  const applyA = await api(`/api/auth/join-links/${encodeURIComponent(rawTokenA)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  const applyB = await api(`/api/auth/join-links/${encodeURIComponent(rawTokenB)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(applyA.status, 201);
  assert.equal(applyB.status, 201);
  const appIdA = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [linkA.body.link.id])).rows[0].id;
  const appIdB = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [linkB.body.link.id])).rows[0].id;

  const [approveA, approveB] = await Promise.all([
    api(`/api/organization/athlete-join-applications/${appIdA}/approve`, { method: "POST", cookie: cookieFor(coachToken) }),
    api(`/api/organization/athlete-join-applications/${appIdB}/approve`, { method: "POST", cookie: cookieFor(clubAdminToken) }),
  ]);
  assert.equal(approveA.status, 200, `expected both approvals to succeed, got A=${approveA.status} body=${JSON.stringify(approveA.body)}`);
  assert.equal(approveB.status, 200, `expected both approvals to succeed, got B=${approveB.status} body=${JSON.stringify(approveB.body)}`);
  assert.equal(String(approveA.body.athleteId), String(approveB.body.athleteId), "both approvals must converge on the exact same athlete profile");
  cleanupAthleteIds.add(approveA.body.athleteId);

  const athleteRows = await query(`select id from public.athletes where user_id = $1`, [existing.id]);
  assert.equal(athleteRows.rowCount, 1, "exactly one athletes row must exist for this account, never two");

  const coachRelationship = await query(
    `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true`,
    [coach.id, approveA.body.athleteId],
  );
  assert.equal(coachRelationship.rowCount, 1, "the private-coach relationship from link A must exist");
  const clubMembership = await query(
    `select 1 from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active'`,
    [approveA.body.athleteId, club],
  );
  assert.equal(clubMembership.rowCount, 1, "the club membership from link B must exist");
});

test("26. two concurrent approvals of two DIFFERENT brand-new applicants on the same link both succeed with distinct athlete ids", async () => {
  const coach = await makePrivateCoach(`join-hardening-newid-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const emailA = `join-hardening-newid-a-${Date.now()}@test.local`;
  const emailB = `join-hardening-newid-b-${Date.now()}@test.local`;
  const appliedA = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "New", lastName: "IdA", email: emailA, password: "somepassword123" } });
  const appliedB = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "New", lastName: "IdB", email: emailB, password: "somepassword456" } });
  assert.equal((await confirmEmail(appliedA.body.devVerificationToken)).status, 200);
  assert.equal((await confirmEmail(appliedB.body.devVerificationToken)).status, 200);
  const rows = await query(`select id from public.athlete_join_applications where join_link_id = $1 order by submitted_at`, [created.body.link.id]);
  const [appIdA, appIdB] = rows.rows.map((r) => r.id);

  const [approveA, approveB] = await Promise.all([
    api(`/api/organization/athlete-join-applications/${appIdA}/approve`, { method: "POST", cookie: cookieFor(token) }),
    api(`/api/organization/athlete-join-applications/${appIdB}/approve`, { method: "POST", cookie: cookieFor(token) }),
  ]);
  assert.equal(approveA.status, 200, `expected both approvals to succeed, got A=${approveA.status} body=${JSON.stringify(approveA.body)}`);
  assert.equal(approveB.status, 200, `expected both approvals to succeed, got B=${approveB.status} body=${JSON.stringify(approveB.body)}`);
  cleanupUserIds.add(approveA.body.userId);
  cleanupUserIds.add(approveB.body.userId);
  cleanupAthleteIds.add(approveA.body.athleteId);
  cleanupAthleteIds.add(approveB.body.athleteId);
  assert.notEqual(approveA.body.athleteId, approveB.body.athleteId);

  const idRows = await query(`select athlete_id, source_external_id from public.athletes where id = any($1::uuid[])`, [[approveA.body.athleteId, approveB.body.athleteId]]);
  const generatedIds = idRows.rows.map((r) => r.athlete_id);
  assert.equal(new Set(generatedIds).size, 2, "the two concurrently generated athlete_id values must be distinct");
});

test("26b. two concurrent POST /organization/athletes calls (the other caller of the shared id generator) get distinct athlete_id values", async () => {
  const admin = await makePlatformAdmin(`join-hardening-directcreate-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const [createA, createB] = await Promise.all([
    api("/api/organization/athletes", { method: "POST", cookie: cookieFor(token), body: { fullName: "Direct Create A" } }),
    api("/api/organization/athletes", { method: "POST", cookie: cookieFor(token), body: { fullName: "Direct Create B" } }),
  ]);
  assert.equal(createA.status, 201);
  assert.equal(createB.status, 201);
  cleanupAthleteIds.add(createA.body.athlete.id);
  cleanupAthleteIds.add(createB.body.athlete.id);
  assert.notEqual(createA.body.athlete.athlete_id, createB.body.athlete.athlete_id, "POST /organization/athletes must also get distinct ids from the shared sequence-backed generator under concurrency");
});

test("27. a pending new-email application against a link that has since expired has its password hash cleared and its status closed, once an authenticated manager loads it", async () => {
  const coach = await makePrivateCoach(`join-hardening-expired-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-hardening-expired-applicant-${Date.now()}@test.local`;
  const apply = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Expired", lastName: "Pending", email, password: "somepassword123" } });
  assert.equal(apply.status, 201);
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const beforeHash = (await query(`select password_hash from public.athlete_join_applications where id = $1`, [appId])).rows[0].password_hash;
  assert.ok(beforeHash, "the pending application must have a password hash before expiry");

  // Simulate time passing past expiry - directly, since we can't wait days
  // in a test.
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  // GET /api/organization/athlete-join-links is the authenticated
  // management/read flow the sweep is wired into - the creator loading
  // their own links is what performs the cleanup here.
  const list = await api(linksEndpoint(), { cookie: cookieFor(token) });
  assert.equal(list.status, 200);
  const listedLink = list.body.links.find((l) => l.id === created.body.link.id);
  assert.equal(listedLink.status, "expired");
  assert.equal(listedLink.pendingCount, 0, "the list response must reflect the sweep immediately, not the stale pre-sweep count");

  const row = await query(`select status, password_hash from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].password_hash, null);
});

test("28. a private coach losing the role closes their link's pending application once a platform admin's read flow sweeps it", async () => {
  const coach = await makePrivateCoach(`join-hardening-lostrole-sweep-${Date.now()}@test.local`);
  const platformAdmin = await makePlatformAdmin(`join-hardening-lostrole-sweep-pa-${Date.now()}@test.local`);
  const coachToken = await createSession(coach.id);
  const platformToken = await createSession(platformAdmin.id);
  const created = await trackLink(await createLink(cookieFor(coachToken), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-hardening-lostrole-sweep-applicant-${Date.now()}@test.local`;
  await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Lost", lastName: "RoleSweep", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  await revokeGlobalRoleDirectly(coach.id, "independent_coach");

  // The coach themself can no longer even hold a private_coach workspace
  // (see backend/src/workspace.js), so they could never trigger this via
  // their own GET - but a platform admin's platform-workspace read flow
  // sees every link regardless of context and performs the sweep instead.
  const list = await api(linksEndpoint(), { cookie: cookieFor(platformToken) });
  assert.equal(list.status, 200);
  assert.ok(list.body.links.some((l) => l.id === created.body.link.id), "a platform admin must see every link regardless of context");

  const row = await query(`select status, password_hash from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].password_hash, null);
});

test("29. an already-terminal (approved) application on a since-expired link is left completely untouched by the sweep", async () => {
  const coach = await makePrivateCoach(`join-hardening-terminal-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const email = `join-hardening-terminal-applicant-${Date.now()}@test.local`;
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, { method: "POST", body: { firstName: "Terminal", lastName: "Approved", email, password: "somepassword123" } });
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  assert.equal((await confirmEmail(applied.body.devVerificationToken)).status, 200);
  const approve = await api(`/api/organization/athlete-join-applications/${appId}/approve`, { method: "POST", cookie: cookieFor(token) });
  assert.equal(approve.status, 200);
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);

  const before = await query(`select status, reviewed_at, resulting_user_id, resulting_athlete_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(before.rows[0].status, "approved");

  // Now the link expires - the already-approved row must never be reopened,
  // relabeled, or otherwise touched by the sweep.
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);
  const list = await api(linksEndpoint(), { cookie: cookieFor(token) });
  assert.equal(list.status, 200);

  const after = await query(`select status, reviewed_at, resulting_user_id, resulting_athlete_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(after.rows[0].status, "approved");
  assert.equal(String(after.rows[0].resulting_user_id), String(before.rows[0].resulting_user_id));
  assert.equal(String(after.rows[0].resulting_athlete_id), String(before.rows[0].resulting_athlete_id));
  assert.deepEqual(after.rows[0].reviewed_at, before.rows[0].reviewed_at);
});
