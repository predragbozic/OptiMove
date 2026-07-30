import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";

let server;
let baseUrl;
const cleanupUserEmails = new Set();
const cleanupAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (cleanupAthleteIds.size) {
    await query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]]);
  }
  if (cleanupUserEmails.size) {
    await query(`delete from public.users where lower(email) = any($1::text[])`, [[...cleanupUserEmails].map((e) => e.toLowerCase())]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, setCookie: res.headers.get("set-cookie") };
}

function sessionCookieFor(token) {
  return `optimove_session=${token}`;
}

async function makeUser({ email, roleHint = "coach", passwordHash = "x" }) {
  cleanupUserEmails.add(email);
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', $2, 'Test User', 'Test User', $3, true)
     returning id, email, role_hint, password_hash`,
    [email, passwordHash, roleHint],
  );
  return result.rows[0];
}

async function makeAthlete({ userId = null } = {}) {
  const externalId = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Test', 'Athlete', 'Test Athlete', 'Test Athlete', $2, true)
     returning id, athlete_id, user_id`,
    [externalId, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeInvite({ athleteId, email, acceptedAt = null, expiresAt = null }) {
  const token = crypto.randomBytes(16).toString("hex");
  const tokenHash = hashInviteToken(token);
  await query(
    `insert into public.athlete_invites (athlete_id, email, token_hash, expires_at, accepted_at)
     values ($1, $2, $3, $4, $5)`,
    [athleteId, email, tokenHash, expiresAt || new Date(Date.now() + 60 * 60 * 1000), acceptedAt],
  );
  return token;
}

async function getUser(email) {
  const result = await query(`select id, email, password_hash, role_hint, is_active from public.users where lower(email) = lower($1)`, [email]);
  return result.rows[0] || null;
}

async function getAthlete(id) {
  const result = await query(`select id, user_id, is_active from public.athletes where id = $1`, [id]);
  return result.rows[0] || null;
}

async function sessionCountFor(userId) {
  const result = await query(`select count(*)::int as count from public.auth_sessions where user_id = $1`, [userId]);
  return result.rows[0].count;
}

test("1. a new athlete can accept a valid invite and set their own password", async () => {
  const athlete = await makeAthlete();
  const email = `new-athlete-${Date.now()}@test.local`;
  cleanupUserEmails.add(email);
  const token = await makeInvite({ athleteId: athlete.id, email });

  const res = await api(`/api/auth/invites/${token}/accept`, { method: "POST", body: { password: "correcthorse123" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, email.toLowerCase());
  assert.ok(res.setCookie, "should set a session cookie");

  const updatedAthlete = await getAthlete(athlete.id);
  assert.ok(updatedAthlete.user_id, "athlete should now be linked to the new account");

  const createdUser = await getUser(email);
  assert.equal(createdUser.role_hint, "athlete");
  assert.equal(createdUser.is_active, true);
});

test("2. an invite whose email matches an existing coach never changes that coach's password or role", async () => {
  const coach = await makeUser({ email: `existing-coach-${Date.now()}@test.local`, roleHint: "coach", passwordHash: "original-hash" });
  const athlete = await makeAthlete();
  const token = await makeInvite({ athleteId: athlete.id, email: coach.email });

  const res = await api(`/api/auth/invites/${token}/accept`, { method: "POST", body: { password: "attackerchosen123" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.requiresLogin, true);

  const coachAfter = await getUser(coach.email);
  assert.equal(coachAfter.password_hash, "original-hash", "coach password must be untouched");
  assert.equal(coachAfter.role_hint, "coach", "coach role must not be downgraded to athlete");

  const athleteAfter = await getAthlete(athlete.id);
  assert.equal(athleteAfter.user_id, null, "athlete must not be linked without an explicit authenticated step");
});

test("3. an existing logged-in user can safely link an athlete profile via the authenticated endpoint", async () => {
  const password = "realpassword123";
const user = await makeUser({ email: `existing-user-${Date.now()}@test.local`, roleHint: "coach", passwordHash: hashPassword(password) });
  const athlete = await makeAthlete();
  const token = await makeInvite({ athleteId: athlete.id, email: user.email });

  const login = await api("/api/auth/login", { method: "POST", body: { email: user.email, password } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.split(";")[0];

  const linkRes = await api(`/api/auth/invites/${token}/link`, { method: "POST", cookie });
  assert.equal(linkRes.status, 200);

  const athleteAfter = await getAthlete(athlete.id);
  assert.equal(athleteAfter.user_id, user.id);

  const userAfter = await getUser(user.email);
  assert.equal(userAfter.password_hash, user.password_hash, "linking must not change the password hash");
  assert.equal(userAfter.role_hint, "coach", "linking must not force role_hint to athlete");
});

test("4. an already-used invite cannot be used again", async () => {
  const athlete = await makeAthlete();
  const email = `reuse-test-${Date.now()}@test.local`;
  cleanupUserEmails.add(email);
  const token = await makeInvite({ athleteId: athlete.id, email });

  const first = await api(`/api/auth/invites/${token}/accept`, { method: "POST", body: { password: "firsttimepass123" } });
  assert.equal(first.status, 200);

  const second = await api(`/api/auth/invites/${token}/accept`, { method: "POST", body: { password: "secondtimepass123" } });
  assert.equal(second.status, 404);
});

test("5. archiving an athlete does not disable their login", async () => {
const admin = await makeUser({ email: `admin-${Date.now()}@test.local`, roleHint: "platform_admin", passwordHash: hashPassword("adminpass123") });
  const athleteUser = await makeUser({ email: `roster-athlete-${Date.now()}@test.local`, roleHint: "athlete", passwordHash: hashPassword("athletepass123") });
  const athlete = await makeAthlete({ userId: athleteUser.id });

  const adminToken = await createSession(admin.id);
  const del = await api(`/api/organization/athletes/${athlete.id}`, { method: "DELETE", cookie: sessionCookieFor(adminToken) });
  assert.equal(del.status, 200);

  const athleteAfter = await getAthlete(athlete.id);
  assert.equal(athleteAfter.is_active, false);

  const userAfter = await getUser(athleteUser.email);
  assert.equal(userAfter.is_active, true, "login must remain active after archiving the profile");
});

test("6. disabling a login revokes existing sessions and blocks further logins with a clear message", async () => {
const admin = await makeUser({ email: `admin2-${Date.now()}@test.local`, roleHint: "platform_admin", passwordHash: hashPassword("adminpass123") });
  const password = "disableme123";
  const athleteUser = await makeUser({ email: `disable-athlete-${Date.now()}@test.local`, roleHint: "athlete", passwordHash: hashPassword(password) });
  const athlete = await makeAthlete({ userId: athleteUser.id });

  const athleteSessionToken = await createSession(athleteUser.id);
  assert.equal(await sessionCountFor(athleteUser.id), 1);

  const adminToken = await createSession(admin.id);
  const disable = await api(`/api/organization/athletes/${athlete.id}/login-status`, {
    method: "PUT",
    cookie: sessionCookieFor(adminToken),
    body: { active: false },
  });
  assert.equal(disable.status, 200);
  assert.equal(disable.body.active, false);

  assert.equal(await sessionCountFor(athleteUser.id), 0, "existing sessions must be revoked");

  const meWithOldSession = await api("/api/auth/me", { cookie: sessionCookieFor(athleteSessionToken) });
  assert.equal(meWithOldSession.body.user, null, "the old session token must no longer authenticate");

  const loginAttempt = await api("/api/auth/login", { method: "POST", body: { email: athleteUser.email, password } });
  assert.equal(loginAttempt.status, 403);
  assert.match(loginAttempt.body.error, /disabled/i);

  const wrongPasswordAttempt = await api("/api/auth/login", { method: "POST", body: { email: athleteUser.email, password: "wrongpassword" } });
  assert.equal(wrongPasswordAttempt.status, 401);
  assert.match(wrongPasswordAttempt.body.error, /invalid email or password/i);
});

test("7. restoring an archived athlete does not change their login status", async () => {
const admin = await makeUser({ email: `admin3-${Date.now()}@test.local`, roleHint: "platform_admin", passwordHash: hashPassword("adminpass123") });
  const athleteUser = await makeUser({ email: `restore-athlete-${Date.now()}@test.local`, roleHint: "athlete", passwordHash: hashPassword("restoreme123") });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  const adminToken = await createSession(admin.id);

  await api(`/api/organization/athletes/${athlete.id}/login-status`, {
    method: "PUT",
    cookie: sessionCookieFor(adminToken),
    body: { active: false },
  });
  await api(`/api/organization/athletes/${athlete.id}`, { method: "DELETE", cookie: sessionCookieFor(adminToken) });

  const archived = await getAthlete(athlete.id);
  assert.equal(archived.is_active, false);
  const userWhileArchived = await getUser(athleteUser.email);
  assert.equal(userWhileArchived.is_active, false, "login was explicitly disabled before archiving, should still be disabled");

  const restore = await api(`/api/organization/athletes/${athlete.id}/restore`, { method: "PUT", cookie: sessionCookieFor(adminToken) });
  assert.equal(restore.status, 200);

  const restored = await getAthlete(athlete.id);
  assert.equal(restored.is_active, true);

  const userAfterRestore = await getUser(athleteUser.email);
  assert.equal(userAfterRestore.is_active, false, "restore must not silently re-enable the login");
});
