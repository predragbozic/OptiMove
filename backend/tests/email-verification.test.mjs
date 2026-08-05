import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/email-verification-foundation: a brand-new-email
// athlete_join_applications row (applicant_user_id null) can never be
// approved until it proves ownership of its email through
// email_verification_tokens (see backend/src/emailVerification.js and
// backend/src/email.js). An authenticated apply-existing application
// (applicant_user_id set) never goes through this at all - session-proven
// ownership of the existing account already IS proof of email control (see
// the comment on POST /join-links/:token/apply-existing in
// backend/src/routes/auth.js).

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
    // email_verification_tokens cascades from athlete_join_applications,
    // which cascades from athlete_join_links.
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

async function makeClub(name) {
  const result = await query(`insert into public.clubs (name, is_active) values ($1, true) returning id`, [name]);
  cleanupClubIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function grantClubAdminDirectly(userId, clubId) {
  await query(
    `insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)
     on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now()`,
    [userId, clubId],
  );
}

async function makePrivateCoach(email) {
  const coach = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  return coach;
}

function linksEndpoint() {
  return "/api/organization/athlete-join-links";
}

async function createLink(cookie, { contextType, contextId = null, label = "Test link", expiresInDays = 7, maxUses = null }) {
  const created = await api(linksEndpoint(), { method: "POST", cookie, body: { contextType, contextId, label, expiresInDays, maxUses } });
  if (created.body?.link?.id) cleanupJoinLinkIds.add(created.body.link.id);
  return created;
}

function extractToken(joinUrl) {
  return decodeURIComponent(joinUrl.split("token=")[1]);
}

async function applyNew(rawToken, overrides = {}) {
  return api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: {
      firstName: "New",
      lastName: "Applicant",
      email: `ev-applicant-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      password: "somepassword123",
      ...overrides,
    },
  });
}

async function confirmEmail(rawVerificationToken) {
  return api(`/api/auth/email-verifications/${encodeURIComponent(rawVerificationToken)}/confirm`, { method: "POST" });
}

async function resendVerification(email) {
  return api("/api/auth/email-verifications/resend", { method: "POST", body: { email } });
}

// Pushes the application's most recent verification token's sent_at back so
// resend's 60-second-since-last-send throttle (keyed off sent_at, never
// created_at - see loadLastVerificationTokenSentAt) doesn't collide with the
// token issued by the original apply() call itself, which always happens
// moments earlier in the same test.
async function backdateLastVerificationToken(applicationId, seconds) {
  await query(
    `update public.email_verification_tokens set sent_at = now() - ($2 || ' seconds')::interval
     where id = (select id from public.email_verification_tokens where athlete_join_application_id = $1 order by created_at desc limit 1)`,
    [applicationId, String(seconds)],
  );
}

async function approveApplication(applicationId, cookie) {
  return api(`/api/organization/athlete-join-applications/${applicationId}/approve`, { method: "POST", cookie });
}

async function makeCoachLinkAndApply() {
  const coach = await makePrivateCoach(`ev-coach-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const applied = await applyNew(rawToken);
  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  return { coach, coachCookie: cookieFor(token), link: created.body.link, applicationId, applied };
}

// --- 1: new email creates only a pending application, never user/athlete ---

test("1. a brand-new-email apply creates only a pending application (no user/athlete), with an unverified email", async () => {
  const { link, applicationId, applied } = await makeCoachLinkAndApply();
  assert.equal(applied.status, 201);
  assert.ok(applied.body.devVerificationToken, "non-production responses must include the raw verification token for automated tests");
  assert.equal(applied.body.emailSendFailed, false, "the dev adapter never fails, so this must be false on the golden path");

  const row = await query(`select email_verified_at, status from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].email_verified_at, null);
  assert.equal(row.rows[0].status, "pending");

  const tokenRow = await query(`select id, sent_at from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.equal(tokenRow.rowCount, 1, "exactly one verification token must exist for this application");
  assert.ok(tokenRow.rows[0].sent_at, "a successfully sent token must have sent_at set");
  void link;
});

// --- 2: raw token never stored ---

test("2. the raw email verification token is never persisted, only its hash", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const row = await query(`select token_hash from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.notEqual(row.rows[0].token_hash, applied.body.devVerificationToken);
  assert.equal(row.rows[0].token_hash, hashToken(applied.body.devVerificationToken));
});

// --- 3: approve before verification -> 409 ---

test("3. approving a new-email application before its email is verified returns 409 EMAIL_NOT_VERIFIED, and creates nothing", async () => {
  const { coachCookie, applicationId } = await makeCoachLinkAndApply();
  const approve = await approveApplication(applicationId, coachCookie);
  assert.equal(approve.status, 409);
  assert.equal(approve.body.error, "EMAIL_NOT_VERIFIED");

  const row = await query(`select status, resulting_user_id, resulting_athlete_id from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "pending", "the application must remain pending, still approvable once verified");
  assert.equal(row.rows[0].resulting_user_id, null);
  assert.equal(row.rows[0].resulting_athlete_id, null);
});

// --- 4: a valid token confirms the email ---

test("4. a valid verification token confirms the email, and creates no user/athlete/approval by itself", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.ok, true);

  const row = await query(`select email_verified_at, status, resulting_user_id from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.ok(row.rows[0].email_verified_at, "email_verified_at must be set after confirm");
  assert.equal(row.rows[0].status, "pending", "confirm alone must never approve the application");
  assert.equal(row.rows[0].resulting_user_id, null);

  const tokenRow = await query(`select consumed_at from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.ok(tokenRow.rows[0].consumed_at, "the token must be marked consumed");
});

// --- 5: approve after verification works ---

test("5. approving a new-email application after email verification succeeds and creates the account/profile/relationship", async () => {
  const { coach, coachCookie, applicationId, applied } = await makeCoachLinkAndApply();
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200);

  const approve = await approveApplication(applicationId, coachCookie);
  assert.equal(approve.status, 200);
  assert.ok(approve.body.userId);
  assert.ok(approve.body.athleteId);
  cleanupUserIds.add(approve.body.userId);
  cleanupAthleteIds.add(approve.body.athleteId);

  const relationship = await query(
    `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true`,
    [coach.id, approve.body.athleteId],
  );
  assert.equal(relationship.rowCount, 1);
});

// --- 6: expired token does not work ---

test("6. an expired verification token cannot confirm the email", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  await query(`update public.email_verification_tokens set expires_at = now() - interval '1 hour' where athlete_join_application_id = $1`, [applicationId]);

  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 404);
  assert.equal(confirm.body.error, "This verification link is invalid or has expired.");

  const row = await query(`select email_verified_at from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].email_verified_at, null);
});

// --- 7: a consumed token cannot be reused ---

test("7. a consumed verification token cannot confirm the email again", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const first = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(first.status, 200);

  const second = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(second.status, 404);
  assert.equal(second.body.error, "This verification link is invalid or has expired.");

  const row = await query(`select email_verified_at from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.ok(row.rows[0].email_verified_at, "the first confirm must still have taken effect");
});

// --- 8: parallel confirms - only one consumes the token, no 500 ---

test("8. two parallel confirm requests for the same token: only one consumes it, neither 500s", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const [first, second] = await Promise.all([confirmEmail(applied.body.devVerificationToken), confirmEmail(applied.body.devVerificationToken)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 404], "exactly one of the two parallel confirms must succeed");

  const row = await query(`select email_verified_at from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.ok(row.rows[0].email_verified_at);
  const tokenRow = await query(`select consumed_at from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.ok(tokenRow.rows[0].consumed_at);
});

// --- 9: resend revokes the old token ---

test("9. resend revokes the previous active token and issues a new one that alone can confirm", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const email = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
  // Isolate resend's own behavior from the 60s-since-last-send throttle,
  // which would otherwise immediately fire since apply() just issued a
  // token moments ago (see test 10 for the throttle itself).
  await backdateLastVerificationToken(applicationId, 120);

  const resend = await resendVerification(email);
  assert.equal(resend.status, 200);
  assert.ok(resend.body.devVerificationToken);
  assert.notEqual(resend.body.devVerificationToken, applied.body.devVerificationToken);

  // The OLD token must no longer work.
  const oldConfirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(oldConfirm.status, 404);

  const oldTokenRow = await query(`select revoked_at from public.email_verification_tokens where token_hash = $1`, [hashToken(applied.body.devVerificationToken)]);
  assert.ok(oldTokenRow.rows[0].revoked_at, "the old token must be marked revoked");

  // The NEW token must work.
  const newConfirm = await confirmEmail(resend.body.devVerificationToken);
  assert.equal(newConfirm.status, 200);
});

// --- 10: resend rate limit (per application, 60s) ---

test("10. resend refuses (silently, generically) a second attempt within 60 seconds of the last one", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const email = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
  // Same isolation as test 9 - the FIRST resend below must succeed on its
  // own merits, not be blocked by the token apply() itself just issued.
  await backdateLastVerificationToken(applicationId, 120);
  void applied;

  const first = await resendVerification(email);
  assert.equal(first.status, 200);
  assert.ok(first.body.devVerificationToken);

  const second = await resendVerification(email);
  assert.equal(second.status, 200, "the throttled response must still be the generic 200, never a distinguishable error");
  assert.equal(second.body.devVerificationToken, undefined, "a throttled resend must not issue (or return) a new token");

  // The FIRST resend's token (the currently active one at this point - the
  // original apply() token was already legitimately revoked by that first,
  // successful resend) must still be the only usable one - the THROTTLED
  // second resend must not have disturbed it.
  const confirmOriginal = await confirmEmail(first.body.devVerificationToken);
  assert.equal(confirmOriginal.status, 200, "the throttled resend must not have disturbed the still-active token from the first, successful resend");
});

// --- 11: email becomes taken before confirm -> requires_login, hash cleared ---

test("11. if the email becomes a real account's before confirm, confirm returns EMAIL_NOW_EXISTS_REQUIRES_LOGIN, sets requires_login, and clears the password hash", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const email = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
  const racer = await makeUser({ email });
  const racerHash = (await query(`select password_hash from public.users where id = $1`, [racer.id])).rows[0].password_hash;

  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error, "EMAIL_NOW_EXISTS_REQUIRES_LOGIN");

  const row = await query(`select status, password_hash, email_verified_at from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "requires_login");
  assert.equal(row.rows[0].password_hash, null);
  assert.equal(row.rows[0].email_verified_at, null);

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [racer.id])).rows[0].password_hash;
  assert.equal(afterHash, racerHash, "the account that claimed the email must never be touched");
});

// --- 12: apply-existing never creates or requires a verification token ---

test("12. apply-existing creates no email_verification_tokens row and never touches the existing account's password/roles", async () => {
  const club = await makeClub(`EV Existing Apply Club ${Date.now()}`);
  const admin = await makeUser({ email: `ev-existing-admin-${Date.now()}@test.local` });
  await grantClubAdminDirectly(admin.id, club);
  const adminToken = await createSession(admin.id);
  const created = await createLink(cookieFor(adminToken), { contextType: "club", contextId: club, expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);

  const existing = await makeUser({ email: `ev-existing-applicant-${Date.now()}@test.local` });
  await grantGlobalRoleDirectly(existing.id, "independent_coach");
  const existingToken = await createSession(existing.id);
  const originalHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;

  const applyExisting = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply-existing`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(applyExisting.status, 201);
  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const tokenCount = await query(`select count(*) from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.equal(Number(tokenCount.rows[0].count), 0, "apply-existing must never create a verification token");

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  assert.equal(afterHash, originalHash);
  const stillCoach = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [existing.id]);
  assert.equal(stillCoach.rows[0].is_active, true);

  // Approve must succeed WITHOUT any confirm step, since applicant_user_id
  // is set - the EMAIL_NOT_VERIFIED gate only applies to new-email rows.
  const approve = await approveApplication(applicationId, cookieFor(adminToken));
  assert.equal(approve.status, 200);
  cleanupAthleteIds.add(approve.body.athleteId);
});

// --- 13: revoked/expired link cannot end in an approval-enabling confirm ---

test("13. revoking a join link revokes its application's verification token, and confirm can no longer succeed", async () => {
  const coach = await makePrivateCoach(`ev-revoke-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const applied = await applyNew(rawToken);
  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const revoke = await api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);

  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 404, "a revoked link's application must already be cancelled, so confirm can never succeed for it");

  const row = await query(`select status, email_verified_at from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].email_verified_at, null);
});

test("13b. even if confirm succeeds in the window before a link's expiry is swept, approve still blocks it via its own link-validity sweep", async () => {
  const { coachCookie, applicationId, applied, link } = await makeCoachLinkAndApply();
  const confirm = await confirmEmail(applied.body.devVerificationToken);
  assert.equal(confirm.status, 200, "confirm succeeds while the application is still genuinely pending");

  // Simulate time passing past the link's expiry - directly, since we can't
  // wait days in a test. No sweep has run yet, so the application is still
  // 'pending' and verified at this exact moment.
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [link.id]);

  const approve = await approveApplication(applicationId, coachCookie);
  assert.equal(approve.status, 409, "approve's own sweep must catch the now-expired link and refuse, regardless of email_verified_at");
  assert.notEqual(approve.body.error, undefined);

  const row = await query(`select status, resulting_user_id from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "cancelled", "the sweep inside approve must have closed it, exactly like any other expired-link application");
  assert.equal(row.rows[0].resulting_user_id, null);
});

// --- 13c/13d/13e: confirm follows the same global join-link lock order as
// revoke/reject, so it can never deadlock against them, and a revoked/
// expired/rejected link never ends up with an approvable application ---

test("13c. confirm racing a link revoke never deadlocks/500s, and the application ends cancelled either way", async () => {
  const coach = await makePrivateCoach(`ev-race-revoke-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const applied = await applyNew(rawToken);
  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;

  const [confirmResult, revokeResult] = await Promise.all([
    confirmEmail(applied.body.devVerificationToken),
    api(`${linksEndpoint()}/${created.body.link.id}`, { method: "DELETE", cookie: cookieFor(token) }),
  ]);
  assert.ok([200, 404].includes(confirmResult.status), "confirm must never 500, regardless of who wins the race");
  assert.equal(revokeResult.status, 200);

  const row = await query(`select status, email_verified_at, resulting_user_id from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "cancelled", "a revoked link must never leave behind a still-pending, approvable application");
  assert.equal(row.rows[0].resulting_user_id, null);
});

test("13d. confirm racing an application reject never deadlocks/500s, and the application ends rejected either way", async () => {
  const { coachCookie, applicationId, applied } = await makeCoachLinkAndApply();

  const [confirmResult, rejectResult] = await Promise.all([confirmEmail(applied.body.devVerificationToken), api(`/api/organization/athlete-join-applications/${applicationId}/reject`, { method: "POST", cookie: coachCookie })]);
  assert.ok([200, 404].includes(confirmResult.status), "confirm must never 500, regardless of who wins the race");
  assert.equal(rejectResult.status, 200);

  const row = await query(`select status, resulting_user_id from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "rejected", "a rejected application must never end up approvable, even if confirm also ran");
  assert.equal(row.rows[0].resulting_user_id, null);
});

test("13e. two parallel confirms against an already-expired link never deadlock/500, and the sweep leaves the application cancelled", async () => {
  const { applicationId, applied, link } = await makeCoachLinkAndApply();
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [link.id]);

  const [first, second] = await Promise.all([confirmEmail(applied.body.devVerificationToken), confirmEmail(applied.body.devVerificationToken)]);
  assert.ok([200, 404].includes(first.status));
  assert.ok([200, 404].includes(second.status));
  assert.notEqual(first.status, 200, "an already-expired link's sweep must fire before any confirm can succeed");
  assert.notEqual(second.status, 200);

  const row = await query(`select status, email_verified_at, password_hash from public.athlete_join_applications where id = $1`, [applicationId]);
  assert.equal(row.rows[0].status, "cancelled");
  assert.equal(row.rows[0].email_verified_at, null);
  assert.equal(row.rows[0].password_hash, null);
});

// --- 14: email provider failure never creates duplicate applications ---

test("14. a failing email provider still leaves exactly one usable application, and a resubmission hits the existing duplicate guard", async () => {
  const coach = await makePrivateCoach(`ev-providerfail-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const email = `ev-providerfail-applicant-${Date.now()}@test.local`;

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  let applied;
  try {
    applied = await applyNew(rawToken, { email });
  } finally {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  }

  // The application itself must still have been created successfully - the
  // provider failure (missing RESEND_API_KEY) happens strictly after commit
  // and must never surface as a failed apply.
  assert.equal(applied.status, 201);
  assert.ok(applied.body.statusToken);
  assert.equal(applied.body.emailSendFailed, true, "the client must be told the confirmation email specifically could not be sent");

  const count = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1 and lower(email) = lower($2)`, [created.body.link.id, email]);
  assert.equal(Number(count.rows[0].count), 1);

  const retry = await applyNew(rawToken, { email });
  assert.equal(retry.status, 409, "a resubmission for the same email must hit the existing duplicate-pending guard, never create a second row");
  const countAfter = await query(`select count(*) from public.athlete_join_applications where join_link_id = $1 and lower(email) = lower($2)`, [created.body.link.id, email]);
  assert.equal(Number(countAfter.rows[0].count), 1);

  // sent_at must never have been set for the failed token - the resend
  // throttle is keyed off sent_at, never created_at, so this proves an
  // immediate resend is not blocked.
  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1 and lower(email) = lower($2)`, [created.body.link.id, email])).rows[0].id;
  const tokenRow = await query(`select sent_at from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.equal(tokenRow.rows[0].sent_at, null, "a token whose send failed must never be marked sent");
});

test("14b. immediately after a failed send, resend is not throttled and succeeds on its own next attempt", async () => {
  const coach = await makePrivateCoach(`ev-providerfail-resend-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const email = `ev-providerfail-resend-applicant-${Date.now()}@test.local`;

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  let applied;
  try {
    applied = await applyNew(rawToken, { email });
  } finally {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  }
  assert.equal(applied.status, 201);
  assert.equal(applied.body.emailSendFailed, true);

  // Resend immediately (no backdating) - must succeed on the dev adapter
  // (which never fails) since sent_at was never set for the prior, failed
  // attempt, so the 60-second-since-last-send throttle never engaged.
  const resend = await resendVerification(email);
  assert.equal(resend.status, 200);
  assert.ok(resend.body.devVerificationToken, "the immediate resend must not be throttled by a send that never actually succeeded");

  const confirm = await confirmEmail(resend.body.devVerificationToken);
  assert.equal(confirm.status, 200);
});

// --- 14c: EMAIL_PROVIDER=brevo, end to end - sent_at only follows a real success ---

// The outer HTTP calls this test file's own api()/applyNew()/resendVerification()
// helpers make (against this test's local http.Server) and the inner Brevo
// HTTPS call backend/src/email.js makes both go through the same global
// fetch in this one process - so the mock installed here must pass every
// non-Brevo request straight through to the real fetch, and only intercept
// requests to api.brevo.com. Restored in `finally` no matter what.
function mockBrevoFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (typeof url === "string" && url.includes("api.brevo.com")) return handler(url, options);
    return originalFetch(url, options);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("14c. with EMAIL_PROVIDER=brevo, sent_at is set only after a genuinely successful Brevo call, and a failed one still leaves resend unblocked", async () => {
  const coach = await makePrivateCoach(`ev-brevo-coach-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
  const rawToken = extractToken(created.body.joinUrl);
  const email = `ev-brevo-applicant-${Date.now()}@test.local`;

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.BREVO_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_PROVIDER = "brevo";
  process.env.BREVO_API_KEY = "test-brevo-key";
  process.env.EMAIL_FROM = "OptiMove <optimovee@gmail.com>";
  const restoreEnv = () => {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
  };

  let restoreFetch = mockBrevoFetch(async () => ({ ok: false, status: 401, json: async () => ({ code: "unauthorized" }) }));
  let applied;
  try {
    applied = await applyNew(rawToken, { email });
  } finally {
    restoreFetch();
  }
  assert.equal(applied.status, 201);
  assert.equal(applied.body.emailSendFailed, true, "a failing Brevo call must surface as emailSendFailed, never a false success");

  const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1 and lower(email) = lower($2)`, [created.body.link.id, email])).rows[0].id;
  const afterFailure = await query(`select sent_at from public.email_verification_tokens where athlete_join_application_id = $1`, [applicationId]);
  assert.equal(afterFailure.rows[0].sent_at, null, "sent_at must never be set for a token whose Brevo send failed");

  restoreFetch = mockBrevoFetch(async () => ({ ok: true, status: 201, json: async () => ({ messageId: "mock-message-id" }) }));
  let resend;
  try {
    // No backdating needed - sent_at was never set by the failed apply, so
    // the 60-second throttle (keyed off sent_at) never engaged.
    resend = await resendVerification(email);
  } finally {
    restoreFetch();
    restoreEnv();
  }
  assert.equal(resend.status, 200, "the immediate resend must not be throttled by a Brevo call that never actually succeeded");

  const afterSuccess = await query(`select sent_at from public.email_verification_tokens where athlete_join_application_id = $1 order by created_at desc limit 1`, [applicationId]);
  assert.ok(afterSuccess.rows[0].sent_at, "sent_at must be set once the Brevo call actually succeeds");
});

// --- Extra: resend never reveals whether an email/application exists ---

test("15. resend returns the exact same response for a real pending application and a completely unknown email", async () => {
  const { applicationId } = await makeCoachLinkAndApply();
  const knownEmail = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
  const unknownEmail = `ev-unknown-${Date.now()}@test.local`;

  const knownResult = await resendVerification(knownEmail);
  const unknownResult = await resendVerification(unknownEmail);
  assert.equal(knownResult.status, unknownResult.status);
  assert.equal(knownResult.body.message, unknownResult.body.message);
  // devVerificationToken is the one intentional difference (only present
  // when work actually happened) - strip it before comparing the rest of
  // the shape.
  const { devVerificationToken: _a, ...knownRest } = knownResult.body;
  const { devVerificationToken: _b, ...unknownRest } = unknownResult.body;
  assert.deepEqual(knownRest, unknownRest);
});

// --- 17: raw verification token/URL must never be logged ---

test("17. the raw verification token and verification URL never appear in console output for apply, confirm, or resend", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const captured = [];
  const capture = (...args) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;

  let applied;
  let resend;
  try {
    const coach = await makePrivateCoach(`ev-nolog-coach-${Date.now()}@test.local`);
    const token = await createSession(coach.id);
    const created = await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 });
    const rawToken = extractToken(created.body.joinUrl);
    applied = await applyNew(rawToken);
    const applicationId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
    await backdateLastVerificationToken(applicationId, 120);
    const email = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
    resend = await resendVerification(email);
    await confirmEmail(resend.body.devVerificationToken);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(applied.status, 201);
  assert.equal(resend.status, 200);
  const rawTokens = [applied.body.devVerificationToken, resend.body.devVerificationToken].filter(Boolean);
  assert.ok(rawTokens.length >= 2);
  for (const line of captured) {
    for (const rawToken of rawTokens) {
      assert.ok(!line.includes(rawToken), `captured console output must never contain a raw verification token, but found it in: ${line}`);
    }
    assert.ok(!line.includes("/verify-email?token="), `captured console output must never contain a verification URL, but found it in: ${line}`);
  }
});

// --- 18: resend keeps its generic response even when the underlying send itself fails ---

test("18. resend still returns its generic success response even when the provider send fails", async () => {
  const { applicationId, applied } = await makeCoachLinkAndApply();
  const email = (await query(`select email from public.athlete_join_applications where id = $1`, [applicationId])).rows[0].email;
  await backdateLastVerificationToken(applicationId, 120);
  void applied;

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  let resend;
  try {
    resend = await resendVerification(email);
  } finally {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  }

  assert.equal(resend.status, 200, "a failed provider send must never surface as a distinguishable error from resend");
  assert.equal(resend.body.message, "If a pending request needs email verification, a new link has been sent.");

  const tokenRow = await query(`select sent_at from public.email_verification_tokens where athlete_join_application_id = $1 order by created_at desc limit 1`, [applicationId]);
  assert.equal(tokenRow.rows[0].sent_at, null, "the newly issued token must not be marked sent since the provider call failed");
});

// --- Migration idempotency ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260809_email_verification.sql");

test("16. the email_verification migration file can be applied twice with no error", async () => {
  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);
  await pool.query(sql);
  const cols = await query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'email_verification_tokens'`,
  );
  assert.ok(cols.rowCount > 0);
});
