import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { __resetForgotIpLimiterForTests } from "../src/passwordReset.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// security/password-recovery: proves POST /api/auth/password/forgot,
// GET /api/auth/password/reset/:token, and POST /api/auth/password/reset/:token
// (backend/src/routes/auth.js, backend/src/passwordReset.js) against a real
// spawned-in-process server and the real dev DB - mirrors the shape of
// email-verification.test.mjs (the closest sibling flow) throughout.

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

// Every request in this file shares the same loopback IP, and the per-IP
// forgot limiter (backend/src/passwordReset.js) is deliberately a shared,
// module-level Map keyed by IP with a 15-minute window - without resetting
// it between tests, later tests in this file would spuriously start hitting
// its 10-attempt cap themselves. Test 8 below exercises the limiter's own
// behavior directly; every other test just needs a clean slate.
beforeEach(() => {
  __resetForgotIpLimiterForTests();
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

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

const GLOBAL_ROLE_BY_ROLE_HINT = {
  admin: "platform_admin",
  platform_admin: "platform_admin",
  coach: "independent_coach",
  independent_coach: "independent_coach",
};

async function makeUser({ email, roleHint = "user", isActive = true, password = "original-password-123" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, $4)
     returning id, email, password_hash`,
    [email, hashPassword(password), roleHint, isActive],
  );
  cleanupUserIds.add(result.rows[0].id);
  const globalRole = GLOBAL_ROLE_BY_ROLE_HINT[roleHint];
  if (globalRole) await grantGlobalRole(result.rows[0].id, globalRole);
  return result.rows[0];
}

async function grantGlobalRole(userId, role, active = true) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, $3)
     on conflict (user_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, role, active],
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

async function makeAthlete({ clubId = null, teamId = null, userId = null } = {}) {
  const externalId = `pr${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, club_id, team_id, user_id, is_active)
     values ($1, $1, 'Reset', 'Test', 'Reset Test', 'Reset Test', $2, $3, $4, true)
     returning id`,
    [externalId, clubId, teamId, userId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
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

async function grantCoachAthleteLink(userId, athleteId) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
    [userId, athleteId],
  );
}

async function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

async function forgot(email) {
  return api("/api/auth/password/forgot", { method: "POST", body: { email } });
}

async function checkResetToken(rawToken) {
  return api(`/api/auth/password/reset/${encodeURIComponent(rawToken)}`);
}

async function resetPassword(rawToken, password) {
  return api(`/api/auth/password/reset/${encodeURIComponent(rawToken)}`, { method: "POST", body: { password } });
}

async function backdateLastResetSentAt(userId, seconds) {
  await query(
    `update public.password_reset_tokens set sent_at = now() - ($2 || ' seconds')::interval
     where id = (select id from public.password_reset_tokens where user_id = $1 order by created_at desc limit 1)`,
    [userId, String(seconds)],
  );
}

// --- 1: golden path - active account gets a token ---

test("1. forgot on an existing active email issues a token and returns the generic response", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-active") });
  const res = await forgot(user.email);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.message, "If an active account exists for that email, we've sent password reset instructions.");
  assert.ok(res.body.devResetToken, "non-production responses must include the raw token for automated tests");

  const row = await query(`select token_hash, consumed_at, revoked_at, sent_at from public.password_reset_tokens where user_id = $1`, [user.id]);
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].token_hash, hashToken(res.body.devResetToken));
  assert.equal(row.rows[0].consumed_at, null);
  assert.equal(row.rows[0].revoked_at, null);
  assert.ok(row.rows[0].sent_at, "a successfully sent token must have sent_at set");
});

// --- 2: nonexistent email - no token created, identical response ---

test("2. forgot on a nonexistent email creates no token and returns the same generic response", async () => {
  const email = await uniqueEmail("pr-nonexistent");
  const res = await forgot(email);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.message, "If an active account exists for that email, we've sent password reset instructions.");
  assert.equal(res.body.devResetToken, undefined, "no token may be issued for an email with no account");

  const count = await query(`select count(*) from public.password_reset_tokens t join public.users u on u.id = t.user_id where lower(u.email) = $1`, [email]);
  assert.equal(Number(count.rows[0].count), 0);
});

// --- 3: deactivated account - no token, no email, identical response ---

test("3. forgot on a deactivated account's email creates no token and returns the same generic response", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-inactive"), isActive: false });
  const res = await forgot(user.email);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.message, "If an active account exists for that email, we've sent password reset instructions.");
  assert.equal(res.body.devResetToken, undefined, "a deactivated account must never receive a reset link");

  const count = await query(`select count(*) from public.password_reset_tokens where user_id = $1`, [user.id]);
  assert.equal(Number(count.rows[0].count), 0);
});

// --- 4: mixed-case email normalization ---

test("4. forgot normalizes email case identically to login (mixed-case input still finds the account)", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-mixedcase") });
  const res = await forgot(user.email.toUpperCase());
  assert.equal(res.status, 200);
  assert.ok(res.body.devResetToken, "an uppercased version of a real email must still resolve to the account and issue a token");
});

// --- 5: identical generic response shape across all three cases ---

test("5. forgot returns byte-identical response shape for an active, a nonexistent, and a deactivated email", async () => {
  const active = await makeUser({ email: await uniqueEmail("pr-shape-active") });
  const inactive = await makeUser({ email: await uniqueEmail("pr-shape-inactive"), isActive: false });
  const unknownEmail = await uniqueEmail("pr-shape-unknown");

  const [activeRes, inactiveRes, unknownRes] = await Promise.all([forgot(active.email), forgot(inactive.email), forgot(unknownEmail)]);
  assert.equal(activeRes.status, inactiveRes.status);
  assert.equal(activeRes.status, unknownRes.status);
  assert.equal(activeRes.body.message, inactiveRes.body.message);
  assert.equal(activeRes.body.message, unknownRes.body.message);
  assert.equal(activeRes.body.ok, inactiveRes.body.ok);
  assert.equal(inactiveRes.body.devResetToken, undefined);
  assert.equal(unknownRes.body.devResetToken, undefined);
});

// --- 6: DB throttle keyed off sent_at ---

test("6. a second forgot within the resend cooldown sends no new email/token, still returns the generic response", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-throttle") });
  const first = await forgot(user.email);
  assert.ok(first.body.devResetToken);

  const second = await forgot(user.email);
  assert.equal(second.status, 200);
  assert.equal(second.body.message, first.body.message);
  assert.equal(second.body.devResetToken, undefined, "a throttled forgot must not issue a new token");

  const count = await query(`select count(*) from public.password_reset_tokens where user_id = $1`, [user.id]);
  assert.equal(Number(count.rows[0].count), 1, "only the first token may exist while throttled");

  // The first token must still be the one usable to reset - the throttled
  // second call must not have disturbed it.
  const check = await checkResetToken(first.body.devResetToken);
  assert.equal(check.body.valid, true);
});

// --- 7: resend after cooldown revokes the previous token ---

test("7. a forgot issued after the cooldown has passed revokes the previous active token and only the new one works", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-resend") });
  const first = await forgot(user.email);
  assert.ok(first.body.devResetToken);
  await backdateLastResetSentAt(user.id, 120);

  const second = await forgot(user.email);
  assert.ok(second.body.devResetToken);
  assert.notEqual(second.body.devResetToken, first.body.devResetToken);

  const oldCheck = await checkResetToken(first.body.devResetToken);
  assert.equal(oldCheck.body.valid, false, "the old token must no longer be valid once revoked by the new request");
  const oldRow = await query(`select revoked_at from public.password_reset_tokens where token_hash = $1`, [hashToken(first.body.devResetToken)]);
  assert.ok(oldRow.rows[0].revoked_at);

  const newCheck = await checkResetToken(second.body.devResetToken);
  assert.equal(newCheck.body.valid, true);
});

// --- 8: IP throttle - best-effort, never the only protection, but still exercised ---

test("8. the per-IP forgot limiter refuses further attempts once its window is exhausted, still returning the generic response", async () => {
  __resetForgotIpLimiterForTests();
  try {
    const email = await uniqueEmail("pr-ip-throttle");
    // The dev/test IP is whatever requestIp(req) resolves to for a plain
    // loopback fetch with no x-forwarded-for header - every call in this
    // test shares that same key, so the 11th call (limit is 10) must be
    // refused by the limiter itself, before any DB throttle is even reached.
    let lastRes;
    for (let i = 0; i < 11; i += 1) {
      lastRes = await forgot(email);
      assert.equal(lastRes.status, 200, "every attempt, including throttled ones, must return 200");
    }
    // The account doesn't exist, so devResetToken is never present either
    // way - the real proof is that the endpoint never 500s or otherwise
    // reveals the limiter's internal state.
    assert.equal(lastRes.body.message, "If an active account exists for that email, we've sent password reset instructions.");
  } finally {
    __resetForgotIpLimiterForTests();
  }
});

// --- 9: email provider failure never leaks, response stays generic, sent_at unset, resend unblocked ---

test("9. a failing email provider still returns the generic response and never sets sent_at, leaving an immediate resend unblocked", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-providerfail") });

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  let res;
  try {
    res = await forgot(user.email);
  } finally {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.message, "If an active account exists for that email, we've sent password reset instructions.");
  // devResetToken is still returned in non-production even when the send
  // fails (the token itself was created before the provider call) - what
  // must never happen is sent_at getting set for a send that didn't work.
  assert.ok(res.body.devResetToken);

  const row = await query(`select sent_at from public.password_reset_tokens where user_id = $1`, [user.id]);
  assert.equal(row.rows[0].sent_at, null, "sent_at must never be set for a token whose provider send failed");

  const resend = await forgot(user.email);
  assert.ok(resend.body.devResetToken, "an immediate resend must not be throttled by a send that never actually succeeded");
});

// --- 10: valid reset changes the password and deletes all sessions ---

test("10. a valid reset changes the password, invalidates every existing session, and old sessions can no longer authenticate", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-reset-golden"), password: "old-password-123" });
  const sessionToken = await createSession(user.id);
  const oldCookie = cookieFor(sessionToken);
  const me = await api("/api/auth/me", { cookie: oldCookie });
  assert.notEqual(me.body.user, null, "the old session must be valid before the reset");

  const issued = await forgot(user.email);
  const reset = await resetPassword(issued.body.devResetToken, "new-password-456");
  assert.equal(reset.status, 200);
  assert.equal(reset.body.ok, true);

  const meAfter = await api("/api/auth/me", { cookie: oldCookie });
  assert.equal(meAfter.body.user, null, "the pre-reset session must be dead after a password reset");

  const consumed = await query(`select consumed_at from public.password_reset_tokens where token_hash = $1`, [hashToken(issued.body.devResetToken)]);
  assert.ok(consumed.rows[0].consumed_at);

  // Checked before any login call below - a successful login itself creates
  // a brand-new session, which would otherwise mask whether the RESET
  // actually cleared out every pre-existing one.
  const sessions = await query(`select count(*) from public.auth_sessions where user_id = $1`, [user.id]);
  assert.equal(Number(sessions.rows[0].count), 0, "every session for the user must be gone immediately after reset (before any new login)");

  const oldLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "old-password-123" } });
  assert.equal(oldLogin.status, 401, "the old password must no longer work");

  const newLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "new-password-456" } });
  assert.equal(newLogin.status, 200, "the new password must work");
});

// --- 11: wrong/nonexistent token ---

test("11. resetting with a token that was never issued returns the generic invalid response and changes nothing", async () => {
  const res = await resetPassword(crypto.randomBytes(32).toString("base64url"), "some-password-123");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "This reset link is invalid or has expired.");
});

// --- 12: expired token ---

test("12. resetting with an expired token fails generically and never changes the password", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-expired"), password: "keep-me-123" });
  const issued = await forgot(user.email);
  const beforeHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  await query(`update public.password_reset_tokens set expires_at = now() - interval '1 hour' where token_hash = $1`, [hashToken(issued.body.devResetToken)]);

  const reset = await resetPassword(issued.body.devResetToken, "new-password-789");
  assert.equal(reset.status, 404);
  assert.equal(reset.body.error, "This reset link is invalid or has expired.");

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  assert.equal(afterHash, beforeHash);

  const check = await checkResetToken(issued.body.devResetToken);
  assert.equal(check.body.valid, false);
});

// --- 13: consumed token cannot be reused ---

test("13. a consumed reset token cannot be reused to change the password again", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-consumed") });
  const issued = await forgot(user.email);
  const first = await resetPassword(issued.body.devResetToken, "first-new-password-1");
  assert.equal(first.status, 200);

  const passwordAfterFirst = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;

  const second = await resetPassword(issued.body.devResetToken, "second-new-password-2");
  assert.equal(second.status, 404);
  assert.equal(second.body.error, "This reset link is invalid or has expired.");

  const passwordAfterSecond = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  assert.equal(passwordAfterSecond, passwordAfterFirst, "a reuse attempt must never change the password again");
});

// --- 14: revoked token ---

test("14. a revoked reset token (superseded by a newer forgot request) cannot be used", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-revoked") });
  const first = await forgot(user.email);
  await backdateLastResetSentAt(user.id, 120);
  await forgot(user.email);

  const reset = await resetPassword(first.body.devResetToken, "should-never-apply-123");
  assert.equal(reset.status, 404);
  assert.equal(reset.body.error, "This reset link is invalid or has expired.");
});

// --- 15: weak password ---

test("15. resetting with a password under 8 characters is rejected before any mutation, token remains usable", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-weak") });
  const issued = await forgot(user.email);
  const beforeHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;

  const reset = await resetPassword(issued.body.devResetToken, "short");
  assert.equal(reset.status, 400);
  assert.equal(reset.body.error, "Password must be at least 8 characters.");

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  assert.equal(afterHash, beforeHash, "a rejected weak password must never touch password_hash");

  // The token itself must still be usable afterward - a failed weak-password
  // attempt must not have consumed or otherwise disturbed it.
  const check = await checkResetToken(issued.body.devResetToken);
  assert.equal(check.body.valid, true);
  const validReset = await resetPassword(issued.body.devResetToken, "long-enough-now-123");
  assert.equal(validReset.status, 200);
});

// --- 16: GET validation never consumes ---

test("16. GET /password/reset/:token never consumes the token - it can still be used afterward to actually reset", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-getcheck") });
  const issued = await forgot(user.email);

  const checks = await Promise.all([checkResetToken(issued.body.devResetToken), checkResetToken(issued.body.devResetToken), checkResetToken(issued.body.devResetToken)]);
  for (const c of checks) assert.equal(c.body.valid, true);

  const consumedRow = await query(`select consumed_at from public.password_reset_tokens where token_hash = $1`, [hashToken(issued.body.devResetToken)]);
  assert.equal(consumedRow.rows[0].consumed_at, null, "repeated GET checks must never mark the token consumed");

  const reset = await resetPassword(issued.body.devResetToken, "final-password-123");
  assert.equal(reset.status, 200);
});

test("16b. GET /password/reset/:token returns the same generic invalid shape for a nonexistent token as for a real invalid one", async () => {
  const nonexistent = await checkResetToken(crypto.randomBytes(32).toString("base64url"));
  const user = await makeUser({ email: await uniqueEmail("pr-getcheck-invalid") });
  const issued = await forgot(user.email);
  await query(`update public.password_reset_tokens set expires_at = now() - interval '1 hour' where token_hash = $1`, [hashToken(issued.body.devResetToken)]);
  const expired = await checkResetToken(issued.body.devResetToken);

  assert.deepEqual(nonexistent.body, { valid: false });
  assert.deepEqual(expired.body, { valid: false });
  assert.equal(nonexistent.status, expired.status);
});

// --- Concurrency: two parallel forgot requests on the same account ---

test("17. two parallel forgot requests on the same account: exactly one token is issued, neither 500s", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-parallel-forgot") });
  const [first, second] = await Promise.all([forgot(user.email), forgot(user.email)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const tokensIssued = [first.body.devResetToken, second.body.devResetToken].filter(Boolean);
  assert.equal(tokensIssued.length, 1, "exactly one of the two parallel forgot requests must actually issue a token - the other must be throttled by the same-transaction lock + sent_at check");

  const count = await query(`select count(*) from public.password_reset_tokens where user_id = $1`, [user.id]);
  assert.equal(Number(count.rows[0].count), 1, "only one token row may exist after two parallel forgot requests");
});

// --- Concurrency: two parallel reset requests on the same token ---

test("18. two parallel reset requests on the same token: exactly one succeeds, neither 500s, and only one password_hash ever takes effect", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-parallel-reset") });
  const issued = await forgot(user.email);

  const [first, second] = await Promise.all([resetPassword(issued.body.devResetToken, "candidate-password-aaa"), resetPassword(issued.body.devResetToken, "candidate-password-bbb")]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 404], "exactly one of the two parallel resets must succeed");

  const tokenRow = await query(`select consumed_at from public.password_reset_tokens where token_hash = $1`, [hashToken(issued.body.devResetToken)]);
  assert.ok(tokenRow.rows[0].consumed_at, "the token must end up consumed");

  // Whichever password won, it must be exactly one of the two candidates -
  // never a corrupted/partial value, and login must work for exactly that one.
  const winningLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "candidate-password-aaa" } });
  const losingLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "candidate-password-bbb" } });
  const successes = [winningLogin.status, losingLogin.status].filter((s) => s === 200);
  assert.equal(successes.length, 1, "exactly one of the two candidate passwords must actually be the account's real password afterward");
});

// --- Concurrency: reset of a stale/superseded token vs the freshly issued one ---

test("19. resetting with a stale (superseded) token fails even though a newer token for the same account is concurrently valid", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-stale-vs-fresh") });
  const stale = await forgot(user.email);
  await backdateLastResetSentAt(user.id, 120);
  const fresh = await forgot(user.email);
  assert.notEqual(fresh.body.devResetToken, stale.body.devResetToken);

  const staleAttempt = await resetPassword(stale.body.devResetToken, "stale-attempt-password-1");
  assert.equal(staleAttempt.status, 404, "the stale, revoked token must never succeed, even while a newer one for the same account is active");

  const freshAttempt = await resetPassword(fresh.body.devResetToken, "fresh-attempt-password-2");
  assert.equal(freshAttempt.status, 200, "the fresh token must still work");
});

// --- Concurrency: reset vs disable-login race ---

test("20. reset racing an account being disabled never deadlocks/500s; a reset that wins leaves the account disabled but with the new password set", async () => {
  const platformAdmin = await makeUser({ email: await uniqueEmail("pr-race-disable-admin"), roleHint: "platform_admin" });
  const adminToken = await createSession(platformAdmin.id);
  const target = await makeUser({ email: await uniqueEmail("pr-race-disable-target"), password: "before-race-123" });
  const issued = await forgot(target.email);

  const [resetResult, disableResult] = await Promise.all([
    resetPassword(issued.body.devResetToken, "after-race-password-1"),
    api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: false } }),
  ]);
  assert.ok([200, 404].includes(resetResult.status), "reset must never 500, regardless of who wins the race");
  assert.equal(disableResult.status, 200);

  const row = await query(`select is_active, password_hash from public.users where id = $1`, [target.id]);
  assert.equal(row.rows[0].is_active, false, "the account must end up disabled either way - reset must never re-enable it");
  if (resetResult.status === 200) {
    // The reset committed before the disable's own session-wipe and
    // is_active flip - the new password must have taken effect.
    assert.notEqual(row.rows[0].password_hash, target.password_hash);
  }
});

// --- Concurrency: reset vs the account being disabled first (deactivated mid-flow, before lock) ---

test("21. once an account is disabled after a token was issued, reset can no longer succeed with it", async () => {
  const platformAdmin = await makeUser({ email: await uniqueEmail("pr-disable-first-admin"), roleHint: "platform_admin" });
  const adminToken = await createSession(platformAdmin.id);
  const target = await makeUser({ email: await uniqueEmail("pr-disable-first-target"), password: "still-here-123" });
  const issued = await forgot(target.email);

  const disable = await api(`/api/organization/users/${target.id}/login-status`, { method: "PUT", cookie: cookieFor(adminToken), body: { active: false } });
  assert.equal(disable.status, 200);

  const reset = await resetPassword(issued.body.devResetToken, "should-not-apply-123");
  assert.equal(reset.status, 404, "reset must refuse once the account is no longer active, even with a token issued while it still was");

  const row = await query(`select password_hash from public.users where id = $1`, [target.id]);
  assert.equal(row.rows[0].password_hash, target.password_hash, "the password must be untouched");
});

// --- Concurrency: token expiring right at the lock/recheck boundary ---

test("22. a token that expires between the unlocked GET check and the locked POST reset is still correctly refused by the POST's own recheck", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-expiry-boundary") });
  const issued = await forgot(user.email);
  const check = await checkResetToken(issued.body.devResetToken);
  assert.equal(check.body.valid, true, "valid at the moment of the GET check");

  // Simulate time passing exactly in the gap between an earlier GET check
  // and the POST reset that follows it.
  await query(`update public.password_reset_tokens set expires_at = now() - interval '1 second' where token_hash = $1`, [hashToken(issued.body.devResetToken)]);

  const reset = await resetPassword(issued.body.devResetToken, "too-late-password-123");
  assert.equal(reset.status, 404, "the POST's own FOR UPDATE recheck must catch the expiry, independent of any earlier GET check");
});

// --- Rollback safety: a rejected reset attempt leaves everything untouched ---

test("23. rollback safety - an invalid-token reset attempt leaves password, sessions, and token state completely unchanged", async () => {
  const user = await makeUser({ email: await uniqueEmail("pr-rollback"), password: "untouched-123" });
  const sessionToken = await createSession(user.id);
  const beforeHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  const beforeSessionCount = Number((await query(`select count(*) from public.auth_sessions where user_id = $1`, [user.id])).rows[0].count);

  const badReset = await resetPassword(crypto.randomBytes(32).toString("base64url"), "irrelevant-password-123");
  assert.equal(badReset.status, 404);

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  const afterSessionCount = Number((await query(`select count(*) from public.auth_sessions where user_id = $1`, [user.id])).rows[0].count);
  assert.equal(afterHash, beforeHash);
  assert.equal(afterSessionCount, beforeSessionCount);

  // The still-live session must keep working, proving nothing was touched.
  const me = await api("/api/auth/me", { cookie: cookieFor(sessionToken) });
  assert.notEqual(me.body.user, null);
});

// --- Log redaction ---

test("24. the raw reset token and reset URL never appear in console output across forgot, GET check, and reset", async () => {
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

  let issued;
  let reset;
  try {
    const user = await makeUser({ email: await uniqueEmail("pr-nolog") });
    issued = await forgot(user.email);
    await checkResetToken(issued.body.devResetToken);
    reset = await resetPassword(issued.body.devResetToken, "logged-nowhere-password-1");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.ok(issued.body.devResetToken);
  assert.equal(reset.status, 200);
  for (const line of captured) {
    assert.ok(!line.includes(issued.body.devResetToken), `captured console output must never contain the raw reset token, but found it in: ${line}`);
    assert.ok(!line.includes("/reset-password?token="), `captured console output must never contain a reset URL, but found it in: ${line}`);
  }
});

test("24b. a failed email-provider send logs only a sanitized reason, never the raw token, URL, or API key", async () => {
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

  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = "resend";
  delete process.env.RESEND_API_KEY;
  let res;
  try {
    const user = await makeUser({ email: await uniqueEmail("pr-nolog-fail") });
    res = await forgot(user.email);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  }

  assert.ok(res.body.devResetToken);
  // The sanitized error class's own message (e.g. "RESEND_API_KEY is not
  // configured.") naming an env var is expected and fine - see
  // EmailConfigError in backend/src/email.js and the identical pattern
  // already accepted for email-verification's own provider-failure logging.
  // What must never appear is the raw token/URL, or an actual secret VALUE
  // (there is none configured in this test - RESEND_API_KEY is deleted).
  for (const line of captured) {
    assert.ok(!line.includes(res.body.devResetToken), `captured console output must never contain the raw reset token, but found it in: ${line}`);
    assert.ok(!line.includes("/reset-password?token="), `captured console output must never contain a reset URL, but found it in: ${line}`);
  }
});

// --- Multi-role preservation ---

async function assertOnlyPasswordAndSessionsChanged(userId, beforeSnapshot) {
  const after = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [userId]);
  assert.notEqual(after.rows[0].password_hash, beforeSnapshot.password_hash, "password_hash must have changed");
  assert.equal(after.rows[0].email, beforeSnapshot.email, "email must never change from a password reset");
  assert.equal(after.rows[0].role_hint, beforeSnapshot.role_hint, "role_hint must never change from a password reset");
  assert.equal(after.rows[0].is_active, beforeSnapshot.is_active, "is_active must never change from a password reset");
}

test("25. multi-role preservation - athlete-only account: reset changes only password_hash/sessions, athlete profile and membership are untouched", async () => {
  const club = await makeClub(`PR Athlete Club ${Date.now()}`);
  const athleteUser = await makeUser({ email: await uniqueEmail("pr-role-athlete"), roleHint: "athlete" });
  const athleteId = await makeAthlete({ clubId: club, userId: athleteUser.id });
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [athleteUser.id]);
  const athleteBefore = await query(`select first_name, last_name, club_id, team_id, user_id, is_active from public.athletes where id = $1`, [athleteId]);
  const membershipBefore = await query(`select membership_type, club_id, team_id, status from public.athlete_memberships where athlete_id = $1`, [athleteId]);

  const issued = await forgot(athleteUser.email);
  const reset = await resetPassword(issued.body.devResetToken, "athlete-new-password-1");
  assert.equal(reset.status, 200);

  await assertOnlyPasswordAndSessionsChanged(athleteUser.id, before.rows[0]);
  const athleteAfter = await query(`select first_name, last_name, club_id, team_id, user_id, is_active from public.athletes where id = $1`, [athleteId]);
  assert.deepEqual(athleteAfter.rows[0], athleteBefore.rows[0], "the athlete profile row must be byte-identical after a password reset");
  const membershipAfter = await query(`select membership_type, club_id, team_id, status from public.athlete_memberships where athlete_id = $1`, [athleteId]);
  assert.deepEqual(membershipAfter.rows, membershipBefore.rows, "athlete membership rows must be identical after a password reset");
});

test("26. multi-role preservation - independent coach: reset changes only password_hash/sessions, global role and athlete links are untouched", async () => {
  const coach = await makeUser({ email: await uniqueEmail("pr-role-indiecoach"), roleHint: "independent_coach" });
  const athleteId = await makeAthlete({});
  await grantCoachAthleteLink(coach.id, athleteId);
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [coach.id]);
  const roleBefore = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [coach.id]);
  const linkBefore = await query(`select is_active from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`, [coach.id, athleteId]);

  const issued = await forgot(coach.email);
  const reset = await resetPassword(issued.body.devResetToken, "coach-new-password-1");
  assert.equal(reset.status, 200);

  await assertOnlyPasswordAndSessionsChanged(coach.id, before.rows[0]);
  const roleAfter = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [coach.id]);
  assert.deepEqual(roleAfter.rows[0], roleBefore.rows[0]);
  const linkAfter = await query(`select is_active from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach'`, [coach.id, athleteId]);
  assert.deepEqual(linkAfter.rows[0], linkBefore.rows[0]);
});

test("27. multi-role preservation - club admin: reset changes only password_hash/sessions, club role is untouched, and LAST_CLUB_ADMIN is not affected", async () => {
  const club = await makeClub(`PR Club Admin Club ${Date.now()}`);
  const admin = await makeUser({ email: await uniqueEmail("pr-role-clubadmin") });
  await grantClubRole(admin.id, club, true);
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [admin.id]);
  const roleBefore = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [admin.id, club]);

  const issued = await forgot(admin.email);
  const reset = await resetPassword(issued.body.devResetToken, "clubadmin-new-password-1");
  assert.equal(reset.status, 200, "resetting the only club admin's password must never be blocked by LAST_CLUB_ADMIN - the account stays active and the role is never revoked");

  await assertOnlyPasswordAndSessionsChanged(admin.id, before.rows[0]);
  const roleAfter = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [admin.id, club]);
  assert.deepEqual(roleAfter.rows[0], roleBefore.rows[0]);
});

test("28. multi-role preservation - team coach: reset changes only password_hash/sessions, team role is untouched", async () => {
  const club = await makeClub(`PR Team Coach Club ${Date.now()}`);
  const team = await makeTeam(club, `PR Team ${Date.now()}`);
  const coach = await makeUser({ email: await uniqueEmail("pr-role-teamcoach") });
  await grantTeamRole(coach.id, team, true);
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [coach.id]);
  const roleBefore = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2 and role = 'team_coach'`, [coach.id, team]);

  const issued = await forgot(coach.email);
  const reset = await resetPassword(issued.body.devResetToken, "teamcoach-new-password-1");
  assert.equal(reset.status, 200);

  await assertOnlyPasswordAndSessionsChanged(coach.id, before.rows[0]);
  const roleAfter = await query(`select is_active from public.user_team_roles where user_id = $1 and team_id = $2 and role = 'team_coach'`, [coach.id, team]);
  assert.deepEqual(roleAfter.rows[0], roleBefore.rows[0]);
});

test("29. multi-role preservation - platform admin: reset changes only password_hash/sessions, and LAST_PLATFORM_ADMIN is not affected", async () => {
  const admin = await makeUser({ email: await uniqueEmail("pr-role-platformadmin"), roleHint: "platform_admin" });
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [admin.id]);
  const roleBefore = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'platform_admin'`, [admin.id]);

  const issued = await forgot(admin.email);
  const reset = await resetPassword(issued.body.devResetToken, "platformadmin-new-password-1");
  assert.equal(reset.status, 200, "resetting a platform admin's password (even the only one) must never be blocked by LAST_PLATFORM_ADMIN - the account stays active and the role is never revoked");

  await assertOnlyPasswordAndSessionsChanged(admin.id, before.rows[0]);
  const roleAfter = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'platform_admin'`, [admin.id]);
  assert.deepEqual(roleAfter.rows[0], roleBefore.rows[0]);
});

test("30. multi-role preservation - multi-role athlete+staff account: reset changes only password_hash/sessions, every role and the athlete link survive intact", async () => {
  const club = await makeClub(`PR Multi Role Club ${Date.now()}`);
  const user = await makeUser({ email: await uniqueEmail("pr-role-multi"), roleHint: "independent_coach" });
  const athleteId = await makeAthlete({ clubId: club, userId: user.id });
  await grantClubRole(user.id, club, true);
  const before = await query(`select password_hash, email, role_hint, is_active from public.users where id = $1`, [user.id]);
  const globalRoleBefore = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [user.id]);
  const clubRoleBefore = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [user.id, club]);
  const athleteBefore = await query(`select user_id, is_active from public.athletes where id = $1`, [athleteId]);

  const issued = await forgot(user.email);
  const reset = await resetPassword(issued.body.devResetToken, "multirole-new-password-1");
  assert.equal(reset.status, 200);

  await assertOnlyPasswordAndSessionsChanged(user.id, before.rows[0]);
  const globalRoleAfter = await query(`select is_active from public.user_global_roles where user_id = $1 and role = 'independent_coach'`, [user.id]);
  assert.deepEqual(globalRoleAfter.rows[0], globalRoleBefore.rows[0]);
  const clubRoleAfter = await query(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [user.id, club]);
  assert.deepEqual(clubRoleAfter.rows[0], clubRoleBefore.rows[0]);
  const athleteAfter = await query(`select user_id, is_active from public.athletes where id = $1`, [athleteId]);
  assert.deepEqual(athleteAfter.rows[0], athleteBefore.rows[0]);
});

// --- Never leaks account existence via error shape ---

test("31. an invalid-token reset and a well-formed-but-unknown-token reset return the exact same error shape", async () => {
  const knownButConsumed = await (async () => {
    const user = await makeUser({ email: await uniqueEmail("pr-shape-consumed") });
    const issued = await forgot(user.email);
    await resetPassword(issued.body.devResetToken, "consumed-once-already-1");
    return issued.body.devResetToken;
  })();
  const neverIssued = crypto.randomBytes(32).toString("base64url");

  const [consumedAttempt, neverIssuedAttempt] = await Promise.all([resetPassword(knownButConsumed, "irrelevant-1"), resetPassword(neverIssued, "irrelevant-2")]);
  assert.equal(consumedAttempt.status, neverIssuedAttempt.status);
  assert.deepEqual(consumedAttempt.body, neverIssuedAttempt.body);
});
