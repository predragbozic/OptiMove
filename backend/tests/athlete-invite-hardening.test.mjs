import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 6 hardening: concurrency/deployment safety follow-up to
// feature/athlete-invite-lifecycle.
//
// 1. Backward-compatible migration: a pre-existing pending invite created by
//    a non-platform-admin (club admin/team coach/private coach) must not be
//    silently invalidated by backfilling it as 'platform' - it is backfilled
//    as 'legacy' instead, and stays usable as long as its original inviter
//    still has ANY real active access to the athlete.
// 2/3. generate/regenerate, accept, link, and revoke all now serialize
//    through ONE shared per-athlete advisory lock (see
//    backend/src/inviteContext.js's lockAthleteInviteActions), closing the
//    races where one of these could act on state another had already made
//    stale.
// 4. A DB CHECK constraint now forbids a row ever having both accepted_at
//    and revoked_at set at once.

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

function hashInviteToken(token) {
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

async function makeAthlete(name, { userId = null } = {}) {
  const externalId = `hard${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, $2, 'Athlete', $2, $2, $3, true)
     returning id`,
    [externalId, name, userId],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function addClubMembership(athleteId, clubId, { status = "active" } = {}) {
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
     values ($1, $2, null, 'club', $3)`,
    [athleteId, clubId, status],
  );
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

function inviteEndpoint() {
  return "/api/organization/athlete-invites";
}

// Simulates exactly the row shape the 20260806_athlete_invites_context.sql
// migration's backfill produces for a pre-existing invite: context_type =
// 'legacy', context_id null, invited_by_user_id whoever created it - never
// retroactively guessed at.
async function makeLegacyInvite({ athleteId, email, invitedByUserId, expiresAt = null }) {
  const token = crypto.randomBytes(16).toString("hex");
  const tokenHash = hashInviteToken(token);
  await query(
    `insert into public.athlete_invites (athlete_id, email, token_hash, invited_by_user_id, context_type, context_id, expires_at)
     values ($1, $2, $3, $4, 'legacy', null, $5)`,
    [athleteId, email, tokenHash, invitedByUserId, expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)],
  );
  return token;
}

// --- 1: backward-compatible migration classification ---

test("1. a legacy invite from a still-active, non-platform club admin remains usable", async () => {
  const club = await makeClub(`Hardening Legacy Club ${Date.now()}`);
  const admin = await makeUser({ email: `hardening-legacy-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const athlete = await makeAthlete("Legacy Target");
  await addClubMembership(athlete, club);
  const email = `hardening-legacy-target-${Date.now()}@test.local`;

  const rawToken = await makeLegacyInvite({ athleteId: athlete, email, invitedByUserId: admin.id });

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 200, "backfilling a historical invite as 'legacy' must never invalidate it just because its non-platform inviter isn't a platform admin");

  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 200);
  cleanupUserIds.add(accept.body.user.id);
});

test("1b. a legacy invite is invalidated once its inviter has no real active access left to the athlete", async () => {
  const plainUser = await makeUser({ email: `hardening-legacy-noaccess-${Date.now()}@test.local`, roleHint: "user" });
  const athlete = await makeAthlete("Legacy No Access Target");
  const email = `hardening-legacy-noaccess-target-${Date.now()}@test.local`;

  const rawToken = await makeLegacyInvite({ athleteId: athlete, email, invitedByUserId: plainUser.id });

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404, "a legacy invite must be rejected once the inviter has no real active access at all");
});

test("1c. a platform admin can always revoke a legacy invite, and a club admin with current real access to the athlete can too", async () => {
  const club = await makeClub(`Hardening Legacy Revoke Club ${Date.now()}`);
  const clubAdmin = await makeUser({ email: `hardening-legacy-revoke-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(clubAdmin.id, club);
  const athlete = await makeAthlete("Legacy Revoke Target");
  await addClubMembership(athlete, club);
  const rawToken = await makeLegacyInvite({ athleteId: athlete, email: `hardening-legacy-revoke-target-${Date.now()}@test.local`, invitedByUserId: clubAdmin.id });

  const inviteRow = await query(`select id from public.athlete_invites where token_hash = $1`, [hashInviteToken(rawToken)]);
  const clubAdminToken = await createSession(clubAdmin.id);

  const revoke = await api(`/api/organization/athlete-invites/${inviteRow.rows[0].id}`, { method: "DELETE", cookie: cookieFor(clubAdminToken) });
  assert.equal(revoke.status, 200, "a club admin with current real access to the athlete must be able to revoke a legacy invite");

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404);
});

// --- 4: DB CHECK invariant ---

test("2. the database rejects a row with both accepted_at and revoked_at set", async () => {
  const admin = await makePlatformAdmin(`hardening-constraint-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Constraint Target");
  const token = await createSession(admin.id);
  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `hardening-constraint-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });

  let threw = null;
  try {
    await query(`update public.athlete_invites set accepted_at = now(), revoked_at = now() where id = $1`, [created.body.invite.id]);
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "the database must reject a row with both accepted_at and revoked_at set");
  assert.match(String(threw.message || ""), /not_both_accepted_and_revoked/);
});

// --- 2/3: concurrency races, all serialized through the shared per-athlete lock ---

test("3. concurrent regenerate and accept of the old token never leave two accounts or an open invite once the athlete has a login", async () => {
  const admin = await makePlatformAdmin(`hardening-race-generate-accept-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Race Generate Accept Target");
  const token = await createSession(admin.id);
  const email = `hardening-race-ga-target-${Date.now()}@test.local`;

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } });
  const oldRawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const [regenerateRes, acceptRes] = await Promise.all([
    api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } }),
    api(`/api/auth/invites/${encodeURIComponent(oldRawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } }),
  ]);

  const outcome = `${regenerateRes.status},${acceptRes.status}`;
  assert.ok(["201,404", "409,200"].includes(outcome), `unexpected status pair for regenerate+accept race: ${outcome}`);
  if (acceptRes.status === 200) cleanupUserIds.add(acceptRes.body.user.id);

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  const openInvites = await query(
    `select id from public.athlete_invites where athlete_id = $1 and accepted_at is null and revoked_at is null`,
    [athlete],
  );
  if (athleteRow.rows[0].user_id) {
    assert.equal(openInvites.rowCount, 0, "once the athlete has a login, no open pending invite may remain");
  } else {
    assert.equal(openInvites.rowCount, 1, "if the athlete still has no login, exactly the freshly generated invite must remain open");
  }

  const reuse = await api(`/api/auth/invites/${encodeURIComponent(oldRawToken)}/accept`, { method: "POST", body: { password: "yetanotherpassword789" } });
  assert.equal(reuse.status, 404, "the old token must never be usable again after this race, regardless of who won it");
});

test("4. concurrent regenerate and link (existing account) of the old token never leave two accounts or an open invite once linked", async () => {
  const admin = await makePlatformAdmin(`hardening-race-generate-link-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Race Generate Link Target");
  const existing = await makeUser({ email: `hardening-race-gl-existing-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);
  const existingToken = await createSession(existing.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: athlete, email: existing.email, contextType: "platform", contextId: null } });
  const oldRawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const [regenerateRes, linkRes] = await Promise.all([
    api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: athlete, email: existing.email, contextType: "platform", contextId: null } }),
    api(`/api/auth/invites/${encodeURIComponent(oldRawToken)}/link`, { method: "POST", cookie: cookieFor(existingToken) }),
  ]);

  const outcome = `${regenerateRes.status},${linkRes.status}`;
  assert.ok(["201,404", "409,200"].includes(outcome), `unexpected status pair for regenerate+link race: ${outcome}`);

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  const openInvites = await query(
    `select id from public.athlete_invites where athlete_id = $1 and accepted_at is null and revoked_at is null`,
    [athlete],
  );
  if (athleteRow.rows[0].user_id) {
    assert.equal(String(athleteRow.rows[0].user_id), String(existing.id), "if linked, it must be linked to the existing account, never a new one");
    assert.equal(openInvites.rowCount, 0);
  } else {
    assert.equal(openInvites.rowCount, 1);
  }

  const reuse = await api(`/api/auth/invites/${encodeURIComponent(oldRawToken)}/link`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(reuse.status, 404, "the old token must never be usable again after this race");
});

test("5. concurrent revoke and accept: exactly one wins, and the row never ends up both accepted and revoked", async () => {
  const admin = await makePlatformAdmin(`hardening-race-revoke-accept-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Race Revoke Accept Target");
  const token = await createSession(admin.id);
  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `hardening-race-ra-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const [revokeRes, acceptRes] = await Promise.all([
    api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) }),
    api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } }),
  ]);

  const outcome = `${revokeRes.status},${acceptRes.status}`;
  assert.ok(["200,404", "409,200"].includes(outcome), `unexpected status pair for revoke+accept race: ${outcome}`);
  if (acceptRes.status === 200) cleanupUserIds.add(acceptRes.body.user.id);

  const row = await query(`select accepted_at, revoked_at from public.athlete_invites where id = $1`, [created.body.invite.id]);
  assert.ok(!(row.rows[0].accepted_at && row.rows[0].revoked_at), "the row must never end up with both accepted_at and revoked_at set");

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  if (revokeRes.status === 200) {
    assert.equal(acceptRes.status, 404);
    assert.equal(athleteRow.rows[0].user_id, null, "if revoke wins, the account/profile must never be linked");
    assert.equal(row.rows[0].accepted_at, null);
  } else {
    assert.equal(acceptRes.status, 200);
    assert.equal(revokeRes.status, 409, "if accept wins, the later revoke must return an accepted-conflict, not succeed");
    assert.equal(row.rows[0].revoked_at, null, "if accept wins, revoked_at must never get set");
  }
});

test("6. concurrent revoke and link (existing account): exactly one wins, and the row never ends up both accepted and revoked", async () => {
  const admin = await makePlatformAdmin(`hardening-race-revoke-link-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Race Revoke Link Target");
  const existing = await makeUser({ email: `hardening-race-rl-existing-${Date.now()}@test.local`, roleHint: "user" });
  const adminToken = await createSession(admin.id);
  const existingToken = await createSession(existing.id);
  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: athlete, email: existing.email, contextType: "platform", contextId: null } });
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const [revokeRes, linkRes] = await Promise.all([
    api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(adminToken) }),
    api(`/api/auth/invites/${encodeURIComponent(rawToken)}/link`, { method: "POST", cookie: cookieFor(existingToken) }),
  ]);

  const outcome = `${revokeRes.status},${linkRes.status}`;
  assert.ok(["200,404", "409,200"].includes(outcome), `unexpected status pair for revoke+link race: ${outcome}`);

  const row = await query(`select accepted_at, revoked_at from public.athlete_invites where id = $1`, [created.body.invite.id]);
  assert.ok(!(row.rows[0].accepted_at && row.rows[0].revoked_at));

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  if (revokeRes.status === 200) {
    assert.equal(linkRes.status, 404);
    assert.equal(athleteRow.rows[0].user_id, null, "if revoke wins, the profile must never be linked");
  } else {
    assert.equal(linkRes.status, 200);
    assert.equal(revokeRes.status, 409);
    assert.equal(String(athleteRow.rows[0].user_id), String(existing.id));
  }
});
