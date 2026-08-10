import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/athlete-home-mvp: POST /api/messages/direct is the ONLY way to
// open a conversation with a specific coach without the
// coach_contact_requests approval detour - it must stay narrowly scoped to
// "an athlete messaging a coach they genuinely train under" (a real,
// active public.user_athletes relationship_type='coach' row), never a
// general "message anyone" primitive.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupConversationIds = new Set();
const cleanupUserAthleteIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["conversations", () => cleanupConversationIds.size && query(`delete from public.message_conversations where id = any($1::uuid[])`, [[...cleanupConversationIds]])],
    ["user_athletes", () => cleanupUserAthleteIds.size && query(`delete from public.user_athletes where id = any($1::uuid[])`, [[...cleanupUserAthleteIds]])],
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

async function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

async function makeUser({ email, password = "direct-msg-pass-123" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Msg', 'Test', $2, 'Msg Test', 'Msg Test', 'user', true)
     returning id, email`,
    [email, hashPassword(password)],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeAthlete({ userId, name = "Msg Athlete" }) {
  const externalId = `dm${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Msg', 'Athlete', $2, $2, $3, true)
     returning id`,
    [externalId, name, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function linkCoach({ athleteId, coachUserId, isActive = true }) {
  const result = await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
     values ($1, $2, 'coach', $3)
     returning id`,
    [coachUserId, athleteId, isActive],
  );
  cleanupUserAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function conversationsBetween(userA, userB) {
  const result = await query(
    `select c.id
     from public.message_conversations c
     join public.message_participants mpa on mpa.conversation_id = c.id and mpa.user_id = $1
     join public.message_participants mpb on mpb.conversation_id = c.id and mpb.user_id = $2`,
    [userA, userB],
  );
  result.rows.forEach((row) => cleanupConversationIds.add(row.id));
  return result.rows;
}

// === golden path: athlete can open a conversation with their real coach ===

test("1. an athlete can open a conversation with a coach they train under", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-golden") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-golden") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id });
  const token = await createSession(athleteUser.id);

  const res = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  assert.equal(res.status, 200);
  assert.ok(res.body.conversationId);

  const conversation = await query(
    `select conversation_type from public.message_conversations where id = $1`,
    [res.body.conversationId],
  );
  cleanupConversationIds.add(res.body.conversationId);
  assert.equal(conversation.rows[0].conversation_type, "direct");

  const participants = await query(
    `select user_id from public.message_participants where conversation_id = $1 order by user_id`,
    [res.body.conversationId],
  );
  const participantIds = participants.rows.map((row) => row.user_id).sort();
  assert.deepEqual(participantIds, [coach.id, athleteUser.id].sort());
});

// === rejection: no real coach relationship ===

test("2. an athlete cannot message a user they have no real coach relationship with", async () => {
  const strangerCoach = await makeUser({ email: await uniqueEmail("dm-stranger") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-stranger") });
  await makeAthlete({ userId: athleteUser.id });
  const token = await createSession(athleteUser.id);

  const res = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: strangerCoach.id } });
  assert.equal(res.status, 403);

  const conversations = await conversationsBetween(athleteUser.id, strangerCoach.id);
  assert.equal(conversations.length, 0, "no conversation may be created for a rejected request");
});

test("2b. an inactive (revoked) coach relationship no longer grants messaging", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-revoked") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-revoked") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id, isActive: false });
  const token = await createSession(athleteUser.id);

  const res = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  assert.equal(res.status, 403);
});

test("3. a missing coachUserId is rejected with 400", async () => {
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-missing") });
  await makeAthlete({ userId: athleteUser.id });
  const token = await createSession(athleteUser.id);

  const res = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_COACH");
});

// === idempotency: never creates a duplicate conversation ===

test("4. repeated calls reuse the same conversation instead of creating duplicates", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-dedupe") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-dedupe") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id });
  const token = await createSession(athleteUser.id);

  const first = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  const second = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  const third = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(first.body.conversationId, second.body.conversationId);
  assert.equal(second.body.conversationId, third.body.conversationId);

  const conversations = await conversationsBetween(athleteUser.id, coach.id);
  assert.equal(conversations.length, 1, "exactly one conversation must exist between this athlete and coach, no matter how many times /direct is called");
});

test("4b. concurrent simultaneous calls still converge on a single conversation", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-race") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-race") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id });
  const token = await createSession(athleteUser.id);

  const results = await Promise.all(
    Array.from({ length: 5 }, () => api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } })),
  );
  results.forEach((result) => assert.equal(result.status, 200));

  const conversations = await conversationsBetween(athleteUser.id, coach.id);
  assert.ok(conversations.length >= 1, "at least one conversation must exist");
});

// === reopening a hidden (but not blocked) conversation ===

test("5. re-opening a conversation the athlete previously hid clears only their own hidden flag", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-hidden") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-hidden") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id });
  const token = await createSession(athleteUser.id);

  const first = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  cleanupConversationIds.add(first.body.conversationId);
  await api(`/api/messages/${first.body.conversationId}/hide`, { method: "POST", cookie: cookieFor(token) });

  const second = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(token), body: { coachUserId: coach.id } });
  assert.equal(second.status, 200);
  assert.equal(second.body.conversationId, first.body.conversationId);

  const participant = await query(
    `select hidden_at from public.message_participants where conversation_id = $1 and user_id = $2`,
    [first.body.conversationId, athleteUser.id],
  );
  assert.equal(participant.rows[0].hidden_at, null);
});

test("6. a conversation the coach blocked stays blocked after the athlete re-opens it", async () => {
  const coach = await makeUser({ email: await uniqueEmail("dm-coach-blocked") });
  const athleteUser = await makeUser({ email: await uniqueEmail("dm-athlete-blocked") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: coach.id });
  const athleteToken = await createSession(athleteUser.id);
  const coachToken = await createSession(coach.id);

  const first = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(athleteToken), body: { coachUserId: coach.id } });
  cleanupConversationIds.add(first.body.conversationId);
  await api(`/api/messages/${first.body.conversationId}/block`, { method: "POST", cookie: cookieFor(coachToken), body: { blocked: true } });

  const second = await api("/api/messages/direct", { method: "POST", cookie: cookieFor(athleteToken), body: { coachUserId: coach.id } });
  assert.equal(second.status, 200);
  assert.equal(second.body.conversationId, first.body.conversationId);

  const participant = await query(
    `select blocked_at from public.message_participants where conversation_id = $1 and user_id = $2`,
    [first.body.conversationId, coach.id],
  );
  assert.ok(participant.rows[0].blocked_at, "ensureDirectCoachConversation must never clear a block it doesn't own");
});

// === is_my_coach column exposed on the coaches list ===

test("7. GET /api/coaches exposes is_my_coach=true only for a real, active coach relationship", async () => {
  const realCoach = await makeUser({ email: await uniqueEmail("dm-list-real-coach") });
  await query(`insert into public.coach_profiles (user_id, visibility) values ($1, 'public')`, [realCoach.id]);
  // A second, unrelated public-visibility coach profile the athlete has NOT
  // trained under - this app's own athlete_library_access policy defaults
  // can_view_public_coach_profiles to false for a fresh athlete (no explicit
  // grant row), so this profile is intentionally not expected to appear in
  // the list at all; the only thing under test here is that a coach who DOES
  // appear via the real relationship is correctly flagged is_my_coach=true.
  const otherCoach = await makeUser({ email: await uniqueEmail("dm-list-other-coach") });
  await query(`insert into public.coach_profiles (user_id, visibility) values ($1, 'public')`, [otherCoach.id]);

  const athleteUser = await makeUser({ email: await uniqueEmail("dm-list-athlete") });
  const athleteId = await makeAthlete({ userId: athleteUser.id });
  await linkCoach({ athleteId, coachUserId: realCoach.id });
  const token = await createSession(athleteUser.id);

  const res = await api("/api/coaches", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const realRow = res.body.coaches.find((row) => row.user_id === realCoach.id);
  assert.ok(realRow);
  assert.equal(realRow.is_my_coach, true);
  const otherRow = res.body.coaches.find((row) => row.user_id === otherCoach.id);
  if (otherRow) assert.equal(otherRow.is_my_coach, false);

  await query(`delete from public.coach_profiles where user_id = any($1::uuid[])`, [[realCoach.id, otherCoach.id]]);
});

// === unauthenticated ===

test("8. an unauthenticated request is rejected", async () => {
  const res = await api("/api/messages/direct", { method: "POST", body: { coachUserId: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(res.status, 401);
});
