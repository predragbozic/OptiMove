import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// hotfix/mobile-messages-test-regression: GET /api/messages and
// GET /api/messages/:conversationId now include an `imageUrl` field per
// participant, sourced from coach_profiles.photo_url (coach priority) or
// athletes.image_url - see the audit comment at the top of
// src/routes/messages.js for why these two columns and not
// users.image_url/image_mime_type (unused dead columns, verified via a
// repo-wide grep before writing this).

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupConversationIds = new Set();
const cleanupCoachProfileUserIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["conversations", () => cleanupConversationIds.size && query(`delete from public.message_conversations where id = any($1::uuid[])`, [[...cleanupConversationIds]])],
    ["coach_profiles", () => cleanupCoachProfileUserIds.size && query(`delete from public.coach_profiles where user_id = any($1::uuid[])`, [[...cleanupCoachProfileUserIds]])],
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

async function makeUser({ email, name = "Avatar Test" }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Avatar', 'Test', $2, $3, $3, 'user', true)
     returning id, email`,
    [email, hashPassword("avatar-test-pass-123"), name],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeAthleteFor(userId, { imageUrl = null, name = "Avatar Athlete" } = {}) {
  const externalId = `av${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active, image_url)
     values ($1, $1, 'Avatar', 'Athlete', $2, $2, $3, true, $4)
     returning id`,
    [externalId, name, userId, imageUrl],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeCoachProfileFor(userId, { photoUrl = null } = {}) {
  await query(`insert into public.coach_profiles (user_id, visibility, photo_url) values ($1, 'public', $2)`, [userId, photoUrl]);
  cleanupCoachProfileUserIds.add(userId);
}

// Bypasses ensureDirectCoachConversation's relationship-checking on purpose
// - these tests are about what GET /api/messages(/:id) RETURNS for
// participants of an already-existing conversation, not about how
// conversations get created (that's messages-direct-coach.test.mjs's job).
async function makeConversationBetween(userAId, userBId) {
  const conversation = await query(
    `insert into public.message_conversations (conversation_type, created_by_user_id, last_message_at)
     values ('direct', $1, now())
     returning id`,
    [userAId],
  );
  const conversationId = conversation.rows[0].id;
  cleanupConversationIds.add(conversationId);
  await query(
    `insert into public.message_participants (conversation_id, user_id, participant_role, last_read_at)
     values ($1, $2, 'owner', now()), ($1, $3, 'member', now())`,
    [conversationId, userAId, userBId],
  );
  await query(`insert into public.messages (conversation_id, sender_user_id, body) values ($1, $2, 'hello')`, [conversationId, userAId]);
  return conversationId;
}

function participantById(participants, userId) {
  return participants.find((p) => p.userId === userId);
}

// === Athlete participant with a photo ===

test("GET /api/messages: an athlete participant with athletes.image_url set returns that URL as imageUrl", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-1") });
  const athleteUser = await makeUser({ email: await uniqueEmail("avatar-athlete-1") });
  await makeAthleteFor(athleteUser.id, { imageUrl: "https://example.test/athlete-1.jpg" });
  await makeConversationBetween(viewer.id, athleteUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const participant = participantById(res.body.conversations[0].participants, athleteUser.id);
  assert.equal(participant.imageUrl, "https://example.test/athlete-1.jpg");
});

test("GET /api/messages/:conversationId: same athlete photo appears in the single-conversation detail view", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-2") });
  const athleteUser = await makeUser({ email: await uniqueEmail("avatar-athlete-2") });
  await makeAthleteFor(athleteUser.id, { imageUrl: "https://example.test/athlete-2.jpg" });
  const conversationId = await makeConversationBetween(viewer.id, athleteUser.id);
  const token = await createSession(viewer.id);

  const res = await api(`/api/messages/${conversationId}`, { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const participant = participantById(res.body.conversation.participants, athleteUser.id);
  assert.equal(participant.imageUrl, "https://example.test/athlete-2.jpg");
});

// === Coach participant with a photo ===

test("GET /api/messages: a coach participant with coach_profiles.photo_url set returns that URL as imageUrl", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-3") });
  const coachUser = await makeUser({ email: await uniqueEmail("avatar-coach-1") });
  await makeCoachProfileFor(coachUser.id, { photoUrl: "https://example.test/coach-1.jpg" });
  await makeConversationBetween(viewer.id, coachUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const participant = participantById(res.body.conversations[0].participants, coachUser.id);
  assert.equal(participant.imageUrl, "https://example.test/coach-1.jpg");
});

test("GET /api/messages/:conversationId: same coach photo appears in the single-conversation detail view", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-4") });
  const coachUser = await makeUser({ email: await uniqueEmail("avatar-coach-2") });
  await makeCoachProfileFor(coachUser.id, { photoUrl: "https://example.test/coach-2.jpg" });
  const conversationId = await makeConversationBetween(viewer.id, coachUser.id);
  const token = await createSession(viewer.id);

  const res = await api(`/api/messages/${conversationId}`, { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  const participant = participantById(res.body.conversation.participants, coachUser.id);
  assert.equal(participant.imageUrl, "https://example.test/coach-2.jpg");
});

// === Participant with no photo at all ===

test("a participant with neither an athletes row nor a coach_profiles row gets an empty imageUrl, never null/undefined", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-5") });
  const plainUser = await makeUser({ email: await uniqueEmail("avatar-plain-1") });
  await makeConversationBetween(viewer.id, plainUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  const participant = participantById(res.body.conversations[0].participants, plainUser.id);
  assert.equal(participant.imageUrl, "");
});

test("an athlete row that exists but has a null image_url also gets an empty imageUrl", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-6") });
  const athleteUser = await makeUser({ email: await uniqueEmail("avatar-athlete-3") });
  await makeAthleteFor(athleteUser.id, { imageUrl: null });
  await makeConversationBetween(viewer.id, athleteUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  const participant = participantById(res.body.conversations[0].participants, athleteUser.id);
  assert.equal(participant.imageUrl, "");
});

// === Multi-role priority: coach photo wins over athlete photo ===

test("a multi-role participant (both an athlete row and a coach_profiles row, both with photos) returns the COACH photo, per the documented priority", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-7") });
  const multiRoleUser = await makeUser({ email: await uniqueEmail("avatar-multi-1") });
  await makeAthleteFor(multiRoleUser.id, { imageUrl: "https://example.test/athlete-side.jpg" });
  await makeCoachProfileFor(multiRoleUser.id, { photoUrl: "https://example.test/coach-side.jpg" });
  await makeConversationBetween(viewer.id, multiRoleUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  const participant = participantById(res.body.conversations[0].participants, multiRoleUser.id);
  assert.equal(participant.imageUrl, "https://example.test/coach-side.jpg");
});

test("a multi-role participant with ONLY an athlete photo (no coach_profiles row) falls back to the athlete photo", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-8") });
  const athleteOnlyUser = await makeUser({ email: await uniqueEmail("avatar-athlete-only") });
  await makeAthleteFor(athleteOnlyUser.id, { imageUrl: "https://example.test/athlete-only.jpg" });
  await makeConversationBetween(viewer.id, athleteOnlyUser.id);
  const token = await createSession(viewer.id);

  const res = await api("/api/messages", { cookie: cookieFor(token) });
  const participant = participantById(res.body.conversations[0].participants, athleteOnlyUser.id);
  assert.equal(participant.imageUrl, "https://example.test/athlete-only.jpg");
});

// === No leak of a non-participant's photo ===

test("a photo belonging to a user who is NOT a participant of the conversation never appears anywhere in the response", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-9") });
  const athleteUser = await makeUser({ email: await uniqueEmail("avatar-athlete-4") });
  await makeAthleteFor(athleteUser.id, { imageUrl: "https://example.test/athlete-4.jpg" });
  const conversationId = await makeConversationBetween(viewer.id, athleteUser.id);

  // A completely unrelated third user with a distinctive photo, never added
  // as a participant of this conversation.
  const outsider = await makeUser({ email: await uniqueEmail("avatar-outsider") });
  await makeCoachProfileFor(outsider.id, { photoUrl: "https://example.test/OUTSIDER-SECRET.jpg" });

  const token = await createSession(viewer.id);
  const listRes = await api("/api/messages", { cookie: cookieFor(token) });
  const detailRes = await api(`/api/messages/${conversationId}`, { cookie: cookieFor(token) });

  assert.ok(!JSON.stringify(listRes.body).includes("OUTSIDER-SECRET"), "the list response must never mention the outsider's photo");
  assert.ok(!JSON.stringify(detailRes.body).includes("OUTSIDER-SECRET"), "the detail response must never mention the outsider's photo");
  assert.equal(listRes.body.conversations[0].participants.length, 2, "only the real 2 participants, never a 3rd");
});

// === No N+1: query count does not grow with conversation count ===

test("GET /api/messages issues the same number of pool.query calls whether the viewer has 1 or many conversations", async () => {
  const viewer = await makeUser({ email: await uniqueEmail("avatar-viewer-10") });
  const otherUser1 = await makeUser({ email: await uniqueEmail("avatar-other-1") });
  await makeAthleteFor(otherUser1.id, { imageUrl: "https://example.test/other-1.jpg" });
  await makeConversationBetween(viewer.id, otherUser1.id);
  const token = await createSession(viewer.id);

  const originalQuery = pool.query.bind(pool);
  let callCount = 0;
  pool.query = (...args) => {
    callCount += 1;
    return originalQuery(...args);
  };
  try {
    await api("/api/messages", { cookie: cookieFor(token) });
    const oneConversationCallCount = callCount;

    // Add 4 more conversations (5 total), each with its own athlete
    // participant with a photo - if the participants query were a separate
    // round trip per conversation (or per participant), callCount would
    // grow; a single LATERAL join stays at the same call count regardless.
    for (let i = 0; i < 4; i += 1) {
      const extraUser = await makeUser({ email: await uniqueEmail(`avatar-extra-${i}`) });
      await makeAthleteFor(extraUser.id, { imageUrl: `https://example.test/extra-${i}.jpg` });
      await makeConversationBetween(viewer.id, extraUser.id);
    }

    callCount = 0;
    const res = await api("/api/messages", { cookie: cookieFor(token) });
    assert.equal(res.body.conversations.length, 5, "sanity check: 5 conversations now exist for this viewer");
    assert.equal(callCount, oneConversationCallCount, "the number of DB round trips must not grow with the number of conversations/participants");
  } finally {
    pool.query = originalQuery;
  }
});
