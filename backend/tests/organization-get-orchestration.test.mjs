import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// perf/settings-navigation-fast-path: GET /api/organization's independent
// loaders (loadAthleteInviteStatuses, loadJoinLinksForWorkspace) now run via
// Promise.all instead of back-to-back awaits; loadJoinApplicationsForWorkspace
// still runs after them since it needs the resolved join-link ids. Nothing
// about permissions, SQL, transactions, or locking changed - only await
// ordering. These tests exist to prove the response is exactly as correct
// and complete as it was before that reordering, not to re-test business
// logic already covered in athlete-invite-lifecycle.test.mjs/
// athlete-join-links.test.mjs/workspace-selection.test.mjs.

let server;
let baseUrl;
const cleanupUserIds = new Set();
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
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
     on conflict (user_id, role) do update set is_active = true, revoked_at = null, updated_at = now()`,
    [userId, role],
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

async function makeAthlete(name) {
  const externalId = `orgshape${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $1, $2, 'Athlete', $2, $2, true)
     returning id`,
    [externalId, name],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeCoachRelationship(coachUserId, athleteId) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
    [coachUserId, athleteId],
  );
}

function extractToken(joinUrl) {
  return decodeURIComponent(joinUrl.split("token=")[1]);
}

test("1. GET /api/organization still correctly links invite status AND join-link applications in the same response after parallelizing the two independent loaders", async () => {
  const coach = await makePrivateCoach(`orgshape-coach-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Org Shape Athlete");
  await makeCoachRelationship(coach.id, athlete);
  const token = await createSession(coach.id);

  const inviteEmail = `orgshape-invitee-${Date.now()}@test.local`;
  const invite = await api("/api/organization/athlete-invites", {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: inviteEmail, contextType: "private_coach", contextId: null },
  });
  assert.equal(invite.status, 201);

  const link = await api("/api/organization/athlete-join-links", {
    method: "POST",
    cookie: cookieFor(token),
    body: { contextType: "private_coach", contextId: null, label: "Org shape link", expiresInDays: 5, maxUses: null },
  });
  assert.equal(link.status, 201);
  cleanupJoinLinkIds.add(link.body.link.id);
  const rawToken = extractToken(link.body.joinUrl);
  const applied = await api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: {
      firstName: "Applicant",
      lastName: "One",
      email: `orgshape-applicant-${Date.now()}@test.local`,
      password: "somepassword123",
    },
  });
  assert.equal(applied.status, 201);

  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.status, 200);

  for (const key of ["scope", "isPlatformAdmin", "canCreateClub", "canCreateTeam", "canCreateAthlete", "canCreateUser", "manageableClubIds", "manageableTeamIds", "clubs", "teams", "athletes", "users", "accessRequests", "joinLinks", "joinApplications", "activeWorkspace"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(org.body, key), `response must still include "${key}"`);
  }

  const athleteRow = org.body.athletes.find((a) => a.id === athlete);
  assert.ok(athleteRow, "the coach's own athlete must still be in the athletes list");
  assert.equal(athleteRow.inviteStatus, "pending", "loadAthleteInviteStatuses must still resolve and attach correctly after running in parallel with loadJoinLinksForWorkspace");
  assert.equal(athleteRow.invite?.email, inviteEmail);

  const joinLinkRow = org.body.joinLinks.find((l) => l.id === link.body.link.id);
  assert.ok(joinLinkRow, "the created join link must still be in joinLinks");
  assert.equal(joinLinkRow.pendingCount, 1);

  const applicationsForLink = org.body.joinApplications.filter((a) => a.joinLinkId === link.body.link.id);
  assert.equal(applicationsForLink.length, 1, "loadJoinApplicationsForWorkspace must still receive the just-resolved join link ids and return its application");
  assert.equal(applicationsForLink[0].status, "pending");
});

test("2. GET /api/organization's top-level response shape is unchanged (same key set as before the loader reordering)", async () => {
  const admin = await makePlatformAdmin(`orgshape-admin-${Date.now()}@test.local`);
  const token = await createSession(admin.id);

  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.status, 200);

  const expectedKeys = [
    "scope", "isPlatformAdmin", "canCreateClub", "canCreateTeam", "canCreateAthlete", "canCreateUser",
    "manageableClubIds", "manageableTeamIds", "clubs", "teams", "athletes", "users", "accessRequests",
    "joinLinks", "joinApplications", "activeWorkspace",
  ].sort();
  assert.deepEqual(Object.keys(org.body).sort(), expectedKeys);
});
