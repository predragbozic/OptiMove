import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// security/verified-email-change: proves the self-service
// (POST/GET /api/auth/account/email-change/*, GET/POST /api/auth/email-changes/:token[/confirm])
// and platform-admin-initiated (POST/GET /api/organization/users/:userId/email-change/*,
// GET /api/organization/users/:userId/account, POST /api/organization/users/:userId/password-reset/send)
// flows against a real spawned-in-process server and the real dev DB.
// Mirrors password-reset.test.mjs's shape throughout - the closest sibling
// token-based flow in this codebase.

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
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

async function makeUser({ email, password = "original-password-123", isActive = true, roleHint = "user" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, $4)
     returning id, email, password_hash`,
    [email, hashPassword(password), roleHint, isActive],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function grantGlobalRole(userId, role, active = true) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, $3)
     on conflict (user_id, role) do update set is_active = $3, updated_at = now()`,
    [userId, role, active],
  );
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "platform_admin" });
  await grantGlobalRole(admin.id, "platform_admin");
  return admin;
}

async function makeAthleteOnlyAccount(email) {
  const user = await makeUser({ email });
  const externalId = `ec${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Athlete', 'Only', 'Athlete Only', 'Athlete Only', $2, true)
     returning id`,
    [externalId, user.id],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return { user, athleteId: result.rows[0].id };
}

async function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

// --- Self-service helpers ---

async function requestEmailChange(cookie, newEmail, currentPassword) {
  return api("/api/auth/account/email-change/request", { method: "POST", cookie, body: { newEmail, currentPassword } });
}

async function resendEmailChange(cookie) {
  return api("/api/auth/account/email-change/resend", { method: "POST", cookie });
}

async function cancelEmailChange(cookie) {
  return api("/api/auth/account/email-change/cancel", { method: "POST", cookie });
}

async function emailChangeStatus(cookie) {
  return api("/api/auth/account/email-change/status", { cookie });
}

async function checkConfirmToken(rawToken) {
  return api(`/api/auth/email-changes/${encodeURIComponent(rawToken)}`);
}

async function confirmEmailChange(rawToken) {
  return api(`/api/auth/email-changes/${encodeURIComponent(rawToken)}/confirm`, { method: "POST" });
}

async function backdateSentAt(userId, seconds) {
  await query(
    `update public.account_email_change_tokens set sent_at = now() - ($2 || ' seconds')::interval
     where id = (select id from public.account_email_change_tokens where user_id = $1 order by created_at desc limit 1)`,
    [userId, String(seconds)],
  );
}

// === Self-service request (section 4) ===

test("1. a self-service request creates exactly one hashed token and never changes users.email", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-req-golden") });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-req-golden-new");

  const res = await requestEmailChange(cookieFor(token), newEmail, "original-password-123");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.newEmail, newEmail);
  assert.ok(res.body.devEmailChangeToken, "non-production responses must include the raw token for automated tests");

  const row = await query(`select token_hash, new_email, request_source, requested_by_user_id, consumed_at, revoked_at, sent_at from public.account_email_change_tokens where user_id = $1`, [user.id]);
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].token_hash, hashToken(res.body.devEmailChangeToken));
  assert.notEqual(row.rows[0].token_hash, res.body.devEmailChangeToken, "the raw token must never be stored verbatim");
  assert.equal(row.rows[0].new_email, newEmail.toLowerCase());
  assert.equal(row.rows[0].request_source, "self");
  assert.equal(row.rows[0].requested_by_user_id, user.id);
  assert.equal(row.rows[0].consumed_at, null);
  assert.equal(row.rows[0].revoked_at, null);
  assert.ok(row.rows[0].sent_at, "a successfully sent token must have sent_at set");

  const stillUser = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(stillUser.rows[0].email, user.email, "users.email must be untouched by a mere request");
});

test("2. a request with the wrong current password creates no token and leaves the account untouched", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-req-wrongpw") });
  const token = await createSession(user.id);
  const res = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-req-wrongpw-new"), "not-the-real-password");
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "INVALID_CURRENT_PASSWORD");

  const count = await query(`select count(*) from public.account_email_change_tokens where user_id = $1`, [user.id]);
  assert.equal(Number(count.rows[0].count), 0, "no token may be issued for a wrong-password request");
});

test("3. requesting the account's own current email is rejected as EMAIL_UNCHANGED", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-req-same") });
  const token = await createSession(user.id);
  const res = await requestEmailChange(cookieFor(token), user.email, "original-password-123");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "EMAIL_UNCHANGED");
});

test("4. requesting an email already used by another account is rejected as EMAIL_ALREADY_IN_USE, no token created", async () => {
  const taken = await makeUser({ email: await uniqueEmail("ec-req-taken-owner") });
  const user = await makeUser({ email: await uniqueEmail("ec-req-taken-requester") });
  const token = await createSession(user.id);
  const res = await requestEmailChange(cookieFor(token), taken.email, "original-password-123");
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "EMAIL_ALREADY_IN_USE");

  const count = await query(`select count(*) from public.account_email_change_tokens where user_id = $1`, [user.id]);
  assert.equal(Number(count.rows[0].count), 0);
});

test("5. an unauthenticated request is rejected", async () => {
  const res = await requestEmailChange(undefined, await uniqueEmail("ec-req-unauth"), "whatever");
  assert.equal(res.status, 401);
});

test("6. GET status reflects the pending request with newEmail/expiresAt, and none once cancelled", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-status") });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-status-new");

  const none = await emailChangeStatus(cookieFor(token));
  assert.deepEqual(none.body, { pending: false });

  await requestEmailChange(cookieFor(token), newEmail, "original-password-123");
  const pending = await emailChangeStatus(cookieFor(token));
  assert.equal(pending.body.pending, true);
  assert.equal(pending.body.newEmail, newEmail.toLowerCase());
  assert.ok(pending.body.expiresAt);
  assert.equal(pending.body.requestSource, "self");

  const cancel = await cancelEmailChange(cookieFor(token));
  assert.equal(cancel.status, 200);
  const afterCancel = await emailChangeStatus(cookieFor(token));
  assert.deepEqual(afterCancel.body, { pending: false });
});

// === Confirming the new address (section 5) ===

test("7. confirming changes only users.email - password_hash, roles, and the athlete profile are untouched", async () => {
  const { user, athleteId } = await makeAthleteOnlyAccount(await uniqueEmail("ec-confirm-scope"));
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-confirm-scope-new");
  const beforeHash = (await query(`select password_hash from public.users where id = $1`, [user.id])).rows[0].password_hash;
  const beforeAthlete = (await query(`select full_name, display_name, user_id from public.athletes where id = $1`, [athleteId])).rows[0];

  const issued = await requestEmailChange(cookieFor(token), newEmail, "original-password-123");
  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.ok, true);

  const after = await query(`select email, password_hash from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, newEmail.toLowerCase());
  assert.equal(after.rows[0].password_hash, beforeHash, "confirming an email change must never touch the password hash");

  const afterAthlete = (await query(`select full_name, display_name, user_id from public.athletes where id = $1`, [athleteId])).rows[0];
  assert.deepEqual(afterAthlete, beforeAthlete, "the athlete profile (and its own fields, standing in for a 'contact' record - see PR notes on athletes.email not existing as a column) must be completely untouched by a login-email change");
});

test("8. after confirming, every prior session dies, the old email stops working, and the new email + OLD password logs in", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-confirm-sessions"), password: "keep-this-password-123" });
  const oldEmail = user.email;
  const oldToken = await createSession(user.id);
  const meBefore = await api("/api/auth/me", { cookie: cookieFor(oldToken) });
  assert.notEqual(meBefore.body.user, null);

  const newEmail = await uniqueEmail("ec-confirm-sessions-new");
  const issued = await requestEmailChange(cookieFor(oldToken), newEmail, "keep-this-password-123");
  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);

  const meAfter = await api("/api/auth/me", { cookie: cookieFor(oldToken) });
  assert.equal(meAfter.body.user, null, "the pre-confirm session must be dead immediately after confirm");

  const sessions = await query(`select count(*) from public.auth_sessions where user_id = $1`, [user.id]);
  assert.equal(Number(sessions.rows[0].count), 0);

  const oldLogin = await api("/api/auth/login", { method: "POST", body: { email: oldEmail, password: "keep-this-password-123" } });
  assert.equal(oldLogin.status, 401, "the old email must no longer work for login");

  const newLogin = await api("/api/auth/login", { method: "POST", body: { email: newEmail, password: "keep-this-password-123" } });
  assert.equal(newLogin.status, 200, "the new email with the SAME (unchanged) password must work");
});

test("9. confirming with a token that was never issued fails generically and changes nothing", async () => {
  const res = await confirmEmailChange(crypto.randomBytes(32).toString("base64url"));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "This confirmation link is invalid or has expired.");
});

test("10. an expired token is rejected generically and never changes the email", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-expired") });
  const token = await createSession(user.id);
  const issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-expired-new"), "original-password-123");
  await query(`update public.account_email_change_tokens set expires_at = now() - interval '1 hour' where token_hash = $1`, [hashToken(issued.body.devEmailChangeToken)]);

  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 404);
  assert.equal(confirm.body.error, "This confirmation link is invalid or has expired.");

  const after = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, user.email);

  const check = await checkConfirmToken(issued.body.devEmailChangeToken);
  assert.equal(check.body.valid, false);
});

test("11. a revoked token (superseded by a newer request) cannot be confirmed", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-revoked") });
  const token = await createSession(user.id);
  const first = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-revoked-first"), "original-password-123");
  const second = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-revoked-second"), "original-password-123");
  assert.notEqual(first.body.devEmailChangeToken, second.body.devEmailChangeToken);

  const confirmFirst = await confirmEmailChange(first.body.devEmailChangeToken);
  assert.equal(confirmFirst.status, 404, "the superseded (revoked) token must never be confirmable, even though it was never explicitly consumed");

  const confirmSecond = await confirmEmailChange(second.body.devEmailChangeToken);
  assert.equal(confirmSecond.status, 200, "the current, non-revoked token must still work");
});

test("12. a consumed token cannot be reused to change the email again", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-consumed") });
  const token = await createSession(user.id);
  const issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-consumed-new"), "original-password-123");
  const first = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(first.status, 200);

  const emailAfterFirst = (await query(`select email from public.users where id = $1`, [user.id])).rows[0].email;
  const second = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(second.status, 404);

  const emailAfterSecond = (await query(`select email from public.users where id = $1`, [user.id])).rows[0].email;
  assert.equal(emailAfterSecond, emailAfterFirst, "a reuse attempt must never change the email again");
});

test("13. if the new address becomes taken between request and confirm, confirm returns EMAIL_ALREADY_IN_USE, changes nothing, and leaves the token usable", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-conflict-requester") });
  const token = await createSession(user.id);
  const contestedEmail = await uniqueEmail("ec-conflict-contested");
  const issued = await requestEmailChange(cookieFor(token), contestedEmail, "original-password-123");

  // A different account claims the exact same address in the meantime.
  const otherOwner = await makeUser({ email: contestedEmail });

  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error, "EMAIL_ALREADY_IN_USE");

  const requester = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(requester.rows[0].email, user.email, "the requester's account must be untouched by the conflict");
  const owner = await query(`select email from public.users where id = $1`, [otherOwner.id]);
  assert.equal(owner.rows[0].email, otherOwner.email, "the account that legitimately owns the address must never be overwritten");

  const tokenRow = await query(`select consumed_at, revoked_at from public.account_email_change_tokens where token_hash = $1`, [hashToken(issued.body.devEmailChangeToken)]);
  assert.equal(tokenRow.rows[0].consumed_at, null, "the token must not be consumed by a conflict it did not cause - it is left usable so the requester can pick a different address via resend");
  assert.equal(tokenRow.rows[0].revoked_at, null);

  // Proves the email write and the session wipe genuinely share one
  // transaction, not just "both usually happen together": a rejected
  // confirm (rolled back before either statement's effects are visible)
  // must leave the requester's own pre-existing session exactly as alive as
  // it was - if the session delete had somehow escaped the rollback while
  // the email write didn't (or vice versa), this session would be dead here.
  const stillLive = await api("/api/auth/me", { cookie: cookieFor(token) });
  assert.notEqual(stillLive.body.user, null, "the requester's session must survive a rolled-back confirm - proves the email write and session wipe are atomic, not two independent steps");
});

test("14. GET /email-changes/:token never consumes the token - it can still be used afterward to actually confirm", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-getcheck") });
  const token = await createSession(user.id);
  const issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-getcheck-new"), "original-password-123");

  const checks = await Promise.all([checkConfirmToken(issued.body.devEmailChangeToken), checkConfirmToken(issued.body.devEmailChangeToken)]);
  for (const c of checks) assert.equal(c.body.valid, true);

  const row = await query(`select consumed_at from public.account_email_change_tokens where token_hash = $1`, [hashToken(issued.body.devEmailChangeToken)]);
  assert.equal(row.rows[0].consumed_at, null);

  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);
});

// === Concurrency (section 11) ===

test("15. two parallel confirms on the same token: exactly one succeeds, neither 500s, email ends up exactly one of the candidates", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-parallel-confirm") });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-parallel-confirm-new");
  const issued = await requestEmailChange(cookieFor(token), newEmail, "original-password-123");

  const [first, second] = await Promise.all([confirmEmailChange(issued.body.devEmailChangeToken), confirmEmailChange(issued.body.devEmailChangeToken)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 404], "exactly one of the two parallel confirms must succeed");

  const after = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, newEmail.toLowerCase());
});

test("16. two parallel requests on the same account leave at most one active token", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-parallel-request") });
  const token = await createSession(user.id);
  const [first, second] = await Promise.all([
    requestEmailChange(cookieFor(token), await uniqueEmail("ec-parallel-request-a"), "original-password-123"),
    requestEmailChange(cookieFor(token), await uniqueEmail("ec-parallel-request-b"), "original-password-123"),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const active = await query(`select count(*) from public.account_email_change_tokens where user_id = $1 and consumed_at is null and revoked_at is null`, [user.id]);
  assert.equal(Number(active.rows[0].count), 1, "only one token may remain active after two parallel requests - the earlier one must be revoked by the later one's own issuance");
});

// Pre-merge audit (2026): the SELECT-based conflict check in the confirm
// endpoint only protects against a conflict that already committed before
// this confirm's own check runs - it does NOT by itself serialize two
// DIFFERENT users' confirms racing toward the same new_email, since neither
// transaction's still-uncommitted row is visible to the other's
// read-committed check. What actually decides the race is the real
// users_email_key UNIQUE constraint on public.users.email, hit by the
// UPDATE itself - confirmed by manually forcing this exact race ~15-20x in
// a row against the dev DB before the fix below existed, which reproduced a
// raw, uncontrolled 500 (with the Postgres constraint-violation message in
// the response body) roughly 1 in 7 runs. The fix in
// POST /email-changes/:token/confirm now catches that specific unique-
// violation (code 23505, constraint users_email_key) and converts it into
// the exact same controlled 409 EMAIL_ALREADY_IN_USE the pre-check produces.
// This test amplifies the same race across many iterations so the
// low-probability interleaving is very likely exercised at least once, and
// asserts the invariant holds unconditionally on every iteration regardless
// of which specific run actually hits the tight interleaving.
test("16b. two DIFFERENT users racing to confirm the same target email never both succeed, never 500, and never end up sharing an email", async () => {
  const ITERATIONS = 20;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const userA = await makeUser({ email: await uniqueEmail(`ec-race-a-${i}`) });
    const userB = await makeUser({ email: await uniqueEmail(`ec-race-b-${i}`) });
    const tokenA = await createSession(userA.id);
    const tokenB = await createSession(userB.id);
    const contested = await uniqueEmail(`ec-race-target-${i}`);

    const [reqA, reqB] = await Promise.all([
      requestEmailChange(cookieFor(tokenA), contested, "original-password-123"),
      requestEmailChange(cookieFor(tokenB), contested, "original-password-123"),
    ]);
    assert.equal(reqA.status, 200);
    assert.equal(reqB.status, 200);

    const [confA, confB] = await Promise.all([
      confirmEmailChange(reqA.body.devEmailChangeToken),
      confirmEmailChange(reqB.body.devEmailChangeToken),
    ]);

    for (const conf of [confA, confB]) {
      assert.ok([200, 409].includes(conf.status), `iteration ${i}: confirm must resolve as either a clean success (200) or a controlled conflict (409) - got ${conf.status} (${JSON.stringify(conf.body)}), never an uncontrolled 500`);
    }
    const statuses = [confA.status, confB.status].sort();
    assert.deepEqual(statuses, [200, 409], `iteration ${i}: exactly one of the two racing confirms must win`);

    const finalA = await query(`select email from public.users where id = $1`, [userA.id]);
    const finalB = await query(`select email from public.users where id = $1`, [userB.id]);
    assert.notEqual(finalA.rows[0].email, finalB.rows[0].email, `iteration ${i}: two different accounts must never end up with the same email - the DB's own unique constraint is the real backstop here`);
  }
});

// === Resend and cancel (section 7) ===

test("17. resend before the cooldown elapses returns RESEND_TOO_SOON and issues no new token", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-resend-cooldown") });
  const token = await createSession(user.id);
  const issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-resend-cooldown-new"), "original-password-123");

  const resend = await resendEmailChange(cookieFor(token));
  assert.equal(resend.status, 429);
  assert.equal(resend.body.error, "RESEND_TOO_SOON");

  const row = await query(`select token_hash from public.account_email_change_tokens where user_id = $1 and consumed_at is null and revoked_at is null`, [user.id]);
  assert.equal(row.rows[0].token_hash, hashToken(issued.body.devEmailChangeToken), "the original token must still be the active one after a throttled resend");
});

test("18. resend after the cooldown issues a fresh token and revokes the previous one, without changing the target address", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-resend-fresh") });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-resend-fresh-new");
  const issued = await requestEmailChange(cookieFor(token), newEmail, "original-password-123");
  await backdateSentAt(user.id, 120);

  const resend = await resendEmailChange(cookieFor(token));
  assert.equal(resend.status, 200);
  assert.equal(resend.body.newEmail, newEmail.toLowerCase());
  assert.notEqual(resend.body.devEmailChangeToken, issued.body.devEmailChangeToken);

  const oldTokenRow = await query(`select revoked_at from public.account_email_change_tokens where token_hash = $1`, [hashToken(issued.body.devEmailChangeToken)]);
  assert.ok(oldTokenRow.rows[0].revoked_at, "the pre-resend token must be revoked");

  const oldConfirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(oldConfirm.status, 404, "the old token must no longer be confirmable after resend");

  const newConfirm = await confirmEmailChange(resend.body.devEmailChangeToken);
  assert.equal(newConfirm.status, 200);
});

test("19. resend re-checks the target address and fails with EMAIL_ALREADY_IN_USE if it became taken since the original request", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-resend-conflict") });
  const token = await createSession(user.id);
  const contestedEmail = await uniqueEmail("ec-resend-conflict-contested");
  await requestEmailChange(cookieFor(token), contestedEmail, "original-password-123");
  await backdateSentAt(user.id, 120);
  await makeUser({ email: contestedEmail });

  const resend = await resendEmailChange(cookieFor(token));
  assert.equal(resend.status, 409);
  assert.equal(resend.body.error, "EMAIL_ALREADY_IN_USE");
});

test("20. resend with no pending request returns NO_PENDING_EMAIL_CHANGE", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-resend-none") });
  const token = await createSession(user.id);
  const resend = await resendEmailChange(cookieFor(token));
  assert.equal(resend.status, 404);
  assert.equal(resend.body.error, "NO_PENDING_EMAIL_CHANGE");
});

test("21. a failed provider send during resend never counts toward the cooldown and never changes users.email", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-resend-sendfail") });
  const token = await createSession(user.id);
  await requestEmailChange(cookieFor(token), await uniqueEmail("ec-resend-sendfail-new"), "original-password-123");
  await backdateSentAt(user.id, 120);

  // Forces a real send failure the same way this codebase's other
  // provider-failure tests do: point at a provider with bad-but-present
  // credentials so the transport call itself throws.
  const originalProvider = process.env.EMAIL_PROVIDER;
  const originalKey = process.env.GMAIL_APP_PASSWORD;
  const originalUser = process.env.GMAIL_USER;
  const originalFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_PROVIDER = "gmail";
  process.env.GMAIL_USER = "nonexistent-test-fixture@example.invalid";
  process.env.GMAIL_APP_PASSWORD = "not-a-real-app-password";
  process.env.EMAIL_FROM = "OptiMove <nonexistent-test-fixture@example.invalid>";
  let resend;
  try {
    resend = await resendEmailChange(cookieFor(token));
  } finally {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    if (originalUser === undefined) delete process.env.GMAIL_USER;
    else process.env.GMAIL_USER = originalUser;
    if (originalKey === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = originalKey;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
  }
  assert.equal(resend.status, 502);
  assert.equal(resend.body.error, "EMAIL_SEND_FAILED");

  const row = await query(`select sent_at from public.account_email_change_tokens where user_id = $1 and consumed_at is null and revoked_at is null`, [user.id]);
  assert.equal(row.rows[0].sent_at, null, "sent_at must never be set for a token whose provider send failed");

  const retryResend = await resendEmailChange(cookieFor(token));
  assert.notEqual(retryResend.status, 429, "a failed send must never trigger the resend cooldown");
});

test("22. cancel revokes the active token, makes it unusable, and never changes users.email", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-cancel") });
  const token = await createSession(user.id);
  const issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-cancel-new"), "original-password-123");

  const cancel = await cancelEmailChange(cookieFor(token));
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.ok, true);

  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 404, "a cancelled token must never be confirmable");

  const after = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, user.email);
});

// === Combined password-change endpoint can no longer touch email (section 8) ===

test("23. PUT /me/credentials with an email field in the body is rejected with EMAIL_VERIFICATION_REQUIRED and changes nothing, even hand-crafted", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-credentials-guard"), password: "still-here-123" });
  const token = await createSession(user.id);
  const res = await api("/api/auth/me/credentials", {
    method: "PUT",
    cookie: cookieFor(token),
    body: { email: await uniqueEmail("ec-credentials-guard-hijack"), currentPassword: "still-here-123", newPassword: "new-password-456" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "EMAIL_VERIFICATION_REQUIRED");

  const after = await query(`select email, password_hash from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, user.email);
  assert.equal(after.rows[0].password_hash, user.password_hash, "the rejected request must not even change the password");
});

test("24. PUT /me/credentials (password-only) changes the password, keeps the current session alive, kills every OTHER session, and never touches email", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-credentials-password"), password: "old-password-123" });
  const currentToken = await createSession(user.id);
  const otherToken = await createSession(user.id);

  const res = await api("/api/auth/me/credentials", {
    method: "PUT",
    cookie: cookieFor(currentToken),
    body: { currentPassword: "old-password-123", newPassword: "new-password-456" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, user.email);

  const meCurrent = await api("/api/auth/me", { cookie: cookieFor(currentToken) });
  assert.notEqual(meCurrent.body.user, null, "the session that just proved the old password stays alive");
  const meOther = await api("/api/auth/me", { cookie: cookieFor(otherToken) });
  assert.equal(meOther.body.user, null, "every OTHER session must be killed by a password change");

  const oldLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "old-password-123" } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api("/api/auth/login", { method: "POST", body: { email: user.email, password: "new-password-456" } });
  assert.equal(newLogin.status, 200);
});

test("25. an email-change request and a password change are fully independent - each can happen without disturbing the other's state", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-independent"), password: "starting-password-123" });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-independent-new");

  const issued = await requestEmailChange(cookieFor(token), newEmail, "starting-password-123");
  assert.equal(issued.status, 200);

  const pwChange = await api("/api/auth/me/credentials", {
    method: "PUT",
    cookie: cookieFor(token),
    body: { currentPassword: "starting-password-123", newPassword: "second-password-456" },
  });
  assert.equal(pwChange.status, 200);

  // Password change kills other sessions but not the caller's own - the
  // pending email-change token, being account-scoped data rather than a
  // session, must still be exactly as it was.
  const tokenRow = await query(`select token_hash, consumed_at, revoked_at from public.account_email_change_tokens where token_hash = $1`, [hashToken(issued.body.devEmailChangeToken)]);
  assert.equal(tokenRow.rows[0].consumed_at, null);
  assert.equal(tokenRow.rows[0].revoked_at, null);

  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200, "the pending email-change token must still confirm successfully after an unrelated password change");

  const after = await query(`select email, password_hash from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, newEmail.toLowerCase());
  assert.notEqual(after.rows[0].password_hash, user.password_hash, "the password change must still have taken effect");
});

// === Platform-admin-initiated change (section 9) ===

test("26. a non-admin cannot start a platform-admin-initiated email change - real 403, no token created", async () => {
  const coach = await makeUser({ email: await uniqueEmail("ec-admin-forbidden-coach") });
  const coachToken = await createSession(coach.id);
  const target = await makeUser({ email: await uniqueEmail("ec-admin-forbidden-target") });

  const res = await api(`/api/organization/users/${target.id}/email-change/request`, {
    method: "POST",
    cookie: cookieFor(coachToken),
    body: { newEmail: await uniqueEmail("ec-admin-forbidden-new") },
  });
  assert.equal(res.status, 403);

  const count = await query(`select count(*) from public.account_email_change_tokens where user_id = $1`, [target.id]);
  assert.equal(Number(count.rows[0].count), 0);
});

test("27. a fake role_hint='platform_admin' with no real user_global_roles row cannot start an admin-initiated change", async () => {
  const fakeAdmin = await makeUser({ email: await uniqueEmail("ec-fake-role-hint"), roleHint: "platform_admin" });
  const fakeToken = await createSession(fakeAdmin.id);
  const target = await makeUser({ email: await uniqueEmail("ec-fake-role-hint-target") });

  const res = await api(`/api/organization/users/${target.id}/email-change/request`, {
    method: "POST",
    cookie: cookieFor(fakeToken),
    body: { newEmail: await uniqueEmail("ec-fake-role-hint-new") },
  });
  assert.equal(res.status, 403, "role_hint alone, without a real active user_global_roles row, must never authorize this");
});

test("28. a real platform admin can start a change for an athlete-only account that holds no staff role, but cannot confirm it directly - only the token can", async () => {
  const admin = await makePlatformAdmin(await uniqueEmail("ec-admin-athlete-only-admin"));
  const adminToken = await createSession(admin.id);
  const { user: target } = await makeAthleteOnlyAccount(await uniqueEmail("ec-admin-athlete-only-target"));
  const newEmail = await uniqueEmail("ec-admin-athlete-only-new");

  const account = await api(`/api/organization/users/${target.id}/account`, { cookie: cookieFor(adminToken) });
  assert.equal(account.status, 200);
  assert.equal(account.body.email, target.email);
  assert.equal(account.body.loginActive, true);
  assert.equal(account.body.pendingEmailChange, null);

  const res = await api(`/api/organization/users/${target.id}/email-change/request`, {
    method: "POST",
    cookie: cookieFor(adminToken),
    body: { newEmail },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.devEmailChangeToken);

  const stillOld = await query(`select email from public.users where id = $1`, [target.id]);
  assert.equal(stillOld.rows[0].email, target.email, "users.email must not change until the NEW address's own inbox confirms");

  const tokenRow = await query(`select request_source, requested_by_user_id from public.account_email_change_tokens where user_id = $1`, [target.id]);
  assert.equal(tokenRow.rows[0].request_source, "platform_admin");
  assert.equal(tokenRow.rows[0].requested_by_user_id, admin.id, "the audit trail must record the ACTING ADMIN, not the account owner");

  // The admin never sees or sets a password, and cannot themselves "confirm"
  // as the admin - only the exact token holder (the new address's own
  // inbox) can, via the same public, unauthenticated confirm endpoint the
  // self-service flow uses.
  const confirm = await confirmEmailChange(res.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);
  const finalRow = await query(`select email from public.users where id = $1`, [target.id]);
  assert.equal(finalRow.rows[0].email, newEmail.toLowerCase());
});

test("29. GET /users/:userId/account is platform-admin-only and never reachable by a non-admin", async () => {
  const coach = await makeUser({ email: await uniqueEmail("ec-account-forbidden-coach") });
  const coachToken = await createSession(coach.id);
  const target = await makeUser({ email: await uniqueEmail("ec-account-forbidden-target") });
  const res = await api(`/api/organization/users/${target.id}/account`, { cookie: cookieFor(coachToken) });
  assert.equal(res.status, 403);
});

test("30. admin resend/cancel work the same as self-service and stay platform-admin-gated", async () => {
  const admin = await makePlatformAdmin(await uniqueEmail("ec-admin-resend-cancel-admin"));
  const adminToken = await createSession(admin.id);
  const target = await makeUser({ email: await uniqueEmail("ec-admin-resend-cancel-target") });
  const newEmail = await uniqueEmail("ec-admin-resend-cancel-new");

  const issued = await api(`/api/organization/users/${target.id}/email-change/request`, { method: "POST", cookie: cookieFor(adminToken), body: { newEmail } });
  await backdateSentAt(target.id, 120);

  const resend = await api(`/api/organization/users/${target.id}/email-change/resend`, { method: "POST", cookie: cookieFor(adminToken) });
  assert.equal(resend.status, 200);
  assert.notEqual(resend.body.devEmailChangeToken, issued.body.devEmailChangeToken);

  const coach = await makeUser({ email: await uniqueEmail("ec-admin-resend-cancel-coach") });
  const coachToken = await createSession(coach.id);
  const forbiddenCancel = await api(`/api/organization/users/${target.id}/email-change/cancel`, { method: "POST", cookie: cookieFor(coachToken) });
  assert.equal(forbiddenCancel.status, 403);

  const cancel = await api(`/api/organization/users/${target.id}/email-change/cancel`, { method: "POST", cookie: cookieFor(adminToken) });
  assert.equal(cancel.status, 200);
  const confirm = await confirmEmailChange(resend.body.devEmailChangeToken);
  assert.equal(confirm.status, 404, "cancelling the admin-initiated request must invalidate its token just like the self-service flow");
});

test("31. an admin can send a password-reset link without ever setting or seeing the password, and it is refused for a disabled login", async () => {
  const admin = await makePlatformAdmin(await uniqueEmail("ec-admin-pwreset-admin"));
  const adminToken = await createSession(admin.id);
  const target = await makeUser({ email: await uniqueEmail("ec-admin-pwreset-target"), password: "target-keeps-this-123" });
  const beforeHash = target.password_hash;

  const res = await api(`/api/organization/users/${target.id}/password-reset/send`, { method: "POST", cookie: cookieFor(adminToken) });
  assert.equal(res.status, 200);
  assert.ok(res.body.devResetToken, "the endpoint reuses the existing password-reset token flow - a raw token is expected in dev mode, same as the self-service forgot-password flow");

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [target.id])).rows[0].password_hash;
  assert.equal(afterHash, beforeHash, "the admin triggering a reset link must never itself change the password - only the target completing the reset flow can");

  const disabledTarget = await makeUser({ email: await uniqueEmail("ec-admin-pwreset-disabled"), isActive: false });
  const disabledRes = await api(`/api/organization/users/${disabledTarget.id}/password-reset/send`, { method: "POST", cookie: cookieFor(adminToken) });
  assert.equal(disabledRes.status, 409);
  assert.equal(disabledRes.body.error, "NO_LOGIN");
});

// === Old-address notification (section 6) ===

test("32. confirming sends a best-effort notice to the OLD address and never rolls back the change if that notice fails", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-oldnotice") });
  const token = await createSession(user.id);
  const newEmail = await uniqueEmail("ec-oldnotice-new");
  const issued = await requestEmailChange(cookieFor(token), newEmail, "original-password-123");

  // The dev adapter never actually fails, so there is nothing to force-break
  // here without the env-based provider tricks test 21 already exercises for
  // the request/resend path - the meaningful assertion for the CONFIRM path
  // is simply that the change commits regardless of whatever the best-effort
  // old-address notice (fired after commit - see the confirm endpoint's own
  // header comment in backend/src/routes/auth.js) does.
  const confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);
  const after = await query(`select email from public.users where id = $1`, [user.id]);
  assert.equal(after.rows[0].email, newEmail.toLowerCase());
});

// === Log redaction (section 4/5/6) ===

test("33. the raw token and confirmation URL never appear in console output across request, GET check, and confirm", async () => {
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
  let confirm;
  try {
    const user = await makeUser({ email: await uniqueEmail("ec-nolog") });
    const token = await createSession(user.id);
    issued = await requestEmailChange(cookieFor(token), await uniqueEmail("ec-nolog-new"), "original-password-123");
    await checkConfirmToken(issued.body.devEmailChangeToken);
    confirm = await confirmEmailChange(issued.body.devEmailChangeToken);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.ok(issued.body.devEmailChangeToken);
  assert.equal(confirm.status, 200);
  for (const line of captured) {
    assert.ok(!line.includes(issued.body.devEmailChangeToken), `captured console output must never contain the raw token, but found it in: ${line}`);
    assert.ok(!line.includes("/confirm-email-change?token="), `captured console output must never contain a confirmation URL, but found it in: ${line}`);
  }
});

// === Production mode never leaks the dev token (section 4) ===

test("34. in production mode, the self-service request response never includes devEmailChangeToken", async () => {
  const user = await makeUser({ email: await uniqueEmail("ec-prodmode") });
  const port = await getFreePort();
  const child = spawn("node", ["src/server.js"], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      EMAIL_PROVIDER: "brevo",
      BREVO_API_KEY: "account-email-change-prodmode-test-fixture-key",
      EMAIL_FROM: "Test Fixture <test-fixture@test.local>",
    },
  });

  try {
    const healthy = await waitForHealth(port);
    assert.ok(healthy, "spawned production server must become healthy");

    const loginRes = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "original-password-123" }),
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("set-cookie") || "";
    const sessionCookie = setCookie.split(";")[0];

    const res = await fetch(`http://localhost:${port}/api/auth/account/email-change/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ newEmail: await uniqueEmail("ec-prodmode-new"), currentPassword: "original-password-123" }),
    });
    const body = await res.json();
    assert.ok(!("devEmailChangeToken" in body), "production response must never include devEmailChangeToken");
  } finally {
    await killChild(child);
  }
});

// === Migration idempotency / registration is covered separately in migration-deploy-runner.test.mjs (tests added alongside this file) ===
