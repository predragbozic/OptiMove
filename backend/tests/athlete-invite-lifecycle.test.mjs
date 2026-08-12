import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Phase 6: feature/athlete-invite-lifecycle. Extends the existing
// single-athlete invite flow with a remembered CONTEXT (private_coach/club/
// team/platform), an explicit context-aware permission matrix (never the
// broad, scope-agnostic canManageAthlete, and never role_hint), revoke,
// regenerate, and context re-validation at accept/link time. Still targets
// exactly one existing athlete profile per invite - never a group/join link.

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
    // athlete_invites cascades from athletes (on delete cascade), so no
    // separate cleanup step is needed for it.
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

async function makeAthlete(name, { userId = null } = {}) {
  const externalId = `inv${Math.floor(Math.random() * 900000 + 100000)}`;
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

async function addTeamMembership(athleteId, clubId, teamId, { status = "active" } = {}) {
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
     values ($1, $2, $3, 'team', $4)`,
    [athleteId, clubId, teamId, status],
  );
}

async function setClubMembershipStatus(athleteId, clubId, status) {
  await query(
    `update public.athlete_memberships set status = $3, updated_at = now() where athlete_id = $1 and club_id = $2 and membership_type = 'club'`,
    [athleteId, clubId, status],
  );
}

async function makeCoachRelationship(coachUserId, athleteId, { isActive = true } = {}) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', $3)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = $3, updated_at = now()`,
    [coachUserId, athleteId, isActive],
  );
}

async function makePlatformAdmin(email) {
  const admin = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(admin.id, "platform_admin");
  return admin;
}

async function makePrivateCoach(email) {
  const coach = await makeUser({ email, roleHint: "user" });
  await grantGlobalRoleDirectly(coach.id, "independent_coach");
  return coach;
}

async function loadInviteRow(inviteId) {
  const result = await query(
    `select id, athlete_id, email, token_hash, context_type, context_id, invited_by_user_id, expires_at,
            accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id, revoke_reason
     from public.athlete_invites where id = $1`,
    [inviteId],
  );
  return result.rows[0] || null;
}

async function loadOpenInvitesFor(athleteId, contextType, contextId) {
  const result = await query(
    `select id from public.athlete_invites
     where athlete_id = $1 and context_type = $2 and coalesce(context_id::text, '') = coalesce($3::text, '')
       and accepted_at is null and revoked_at is null`,
    [athleteId, contextType, contextId],
  );
  return result.rows;
}

function inviteEndpoint() {
  return "/api/organization/athlete-invites";
}

// --- 1-8: creation permission matrix ---

test("1. a private coach can invite only their own actively-linked athlete", async () => {
  const coach = await makePrivateCoach(`invite-pc-${Date.now()}@test.local`);
  const athlete = await makeAthlete("PC Athlete");
  await makeCoachRelationship(coach.id, athlete);
  const token = await createSession(coach.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `pc-target-${Date.now()}@test.local`, contextType: "private_coach", contextId: null },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.invite.contextType, "private_coach");
});

test("2. a private coach cannot invite an athlete they have no relationship with", async () => {
  const coach = await makePrivateCoach(`invite-pc-none-${Date.now()}@test.local`);
  const athlete = await makeAthlete("PC Stranger");
  const token = await createSession(coach.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `pc-none-target-${Date.now()}@test.local`, contextType: "private_coach", contextId: null },
  });
  assert.equal(res.status, 403);
});

test("3. a club admin can invite only an active member of their own club, not a non-member or another club's member", async () => {
  const clubA = await makeClub(`Invite Club A ${Date.now()}`);
  const clubB = await makeClub(`Invite Club B ${Date.now()}`);
  const admin = await makeUser({ email: `invite-clubadmin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, clubA);
  const token = await createSession(admin.id);

  const memberOfA = await makeAthlete("Club A Member");
  await addClubMembership(memberOfA, clubA);
  const okRes = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: memberOfA, email: `clubA-target-${Date.now()}@test.local`, contextType: "club", contextId: clubA },
  });
  assert.equal(okRes.status, 201);

  const nonMember = await makeAthlete("No Membership");
  const noMembershipRes = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: nonMember, email: `no-membership-${Date.now()}@test.local`, contextType: "club", contextId: clubA },
  });
  assert.equal(noMembershipRes.status, 403, "an athlete with no active membership in this club must be rejected");

  const memberOfB = await makeAthlete("Club B Member");
  await addClubMembership(memberOfB, clubB);
  const wrongClubRes = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: memberOfB, email: `clubB-target-${Date.now()}@test.local`, contextType: "club", contextId: clubA },
  });
  assert.equal(wrongClubRes.status, 403, "an athlete belonging to a different club must never be inviteable via this club's context");
});

test("4. a team coach can invite only an active member of their own team", async () => {
  const club = await makeClub(`Invite Team Club ${Date.now()}`);
  const teamMine = await makeTeam(club, "Team Mine");
  const teamOther = await makeTeam(club, "Team Other");
  const coach = await makeUser({ email: `invite-teamcoach-${Date.now()}@test.local`, roleHint: "user" });
  await grantTeamCoachDirectly(coach.id, teamMine);
  const token = await createSession(coach.id);

  const memberOfMine = await makeAthlete("Team Mine Member");
  await addTeamMembership(memberOfMine, club, teamMine);
  const okRes = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: memberOfMine, email: `teammine-target-${Date.now()}@test.local`, contextType: "team", contextId: teamMine },
  });
  assert.equal(okRes.status, 201);

  const memberOfOther = await makeAthlete("Team Other Member");
  await addTeamMembership(memberOfOther, club, teamOther);
  const wrongTeamRes = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: memberOfOther, email: `teamother-target-${Date.now()}@test.local`, contextType: "team", contextId: teamMine },
  });
  assert.equal(wrongTeamRes.status, 403, "a team_coach must never invite via a DIFFERENT team's context, even in the same club");
});

test("5. a club admin can invite a member of one of their club's teams via the team context", async () => {
  const club = await makeClub(`Invite ClubAdmin Team Club ${Date.now()}`);
  const team = await makeTeam(club, "Team Under Club Admin");
  const admin = await makeUser({ email: `invite-clubadmin-team-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const token = await createSession(admin.id);

  const teamMember = await makeAthlete("Team Under Club Admin Member");
  await addTeamMembership(teamMember, club, team);
  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: teamMember, email: `clubadmin-team-target-${Date.now()}@test.local`, contextType: "team", contextId: team },
  });
  assert.equal(res.status, 201, "a club_admin of the team's owning club must be able to invite via that team's context");
});

test("6. a platform admin can send a platform-level invite for any active athlete, no membership required", async () => {
  const admin = await makePlatformAdmin(`invite-platform-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Platform Target");
  const token = await createSession(admin.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `platform-target-${Date.now()}@test.local`, contextType: "platform", contextId: null },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.invite.contextType, "platform");
  assert.equal(res.body.invite.contextId, null);
});

test("7. an athlete-only, generic, or fake-role_hint account is rejected in every context, regardless of role_hint", async () => {
  const club = await makeClub(`Invite Reject Club ${Date.now()}`);
  const athlete = await makeAthlete("Reject Target");
  await addClubMembership(athlete, club);

  for (const roleHint of ["athlete", "user", "platform_admin", "club_admin", "coach"]) {
    const fake = await makeUser({ email: `invite-fake-${roleHint}-${Date.now()}@test.local`, roleHint });
    const token = await createSession(fake.id);
    const res = await api(inviteEndpoint(), {
      method: "POST",
      cookie: cookieFor(token),
      body: { athleteId: athlete, email: `fake-target-${roleHint}-${Date.now()}@test.local`, contextType: "club", contextId: club },
    });
    assert.equal(res.status, 403, `role_hint='${roleHint}' with no real matching row must never be able to send a club invite`);
  }
});

test("8. an unsupported context type (including 'athlete') is rejected with 400, never creating a row", async () => {
  const admin = await makePlatformAdmin(`invite-badcontext-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Bad Context Target");
  const token = await createSession(admin.id);

  for (const contextType of ["athlete", "team_admin", "club_manager", ""]) {
    const res = await api(inviteEndpoint(), {
      method: "POST",
      cookie: cookieFor(token),
      body: { athleteId: athlete, email: `badcontext-target-${Date.now()}@test.local`, contextType, contextId: null },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "UNSUPPORTED_INVITE_CONTEXT");
  }
  const rows = await query(`select id from public.athlete_invites where athlete_id = $1`, [athlete]);
  assert.equal(rows.rowCount, 0, "no invite row may be created for an unsupported context");
});

// --- 9: already-linked athlete ---

test("9. an athlete who already has a login cannot receive a new invite in any context", async () => {
  const admin = await makePlatformAdmin(`invite-already-linked-${Date.now()}@test.local`);
  const athleteUser = await makeUser({ email: `invite-already-linked-target-${Date.now()}@test.local`, roleHint: "user" });
  const athlete = await makeAthlete("Already Linked", { userId: athleteUser.id });
  const token = await createSession(admin.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `already-linked-invite-${Date.now()}@test.local`, contextType: "platform", contextId: null },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "ATHLETE_ALREADY_HAS_LOGIN");
});

// --- 10-11: token storage and expiry ---

test("10. the raw token is never stored - only its hash", async () => {
  const admin = await makePlatformAdmin(`invite-tokenhash-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Token Hash Target");
  const token = await createSession(admin.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `tokenhash-target-${Date.now()}@test.local`, contextType: "platform", contextId: null },
  });
  assert.equal(res.status, 201);
  const rawToken = res.body.inviteUrl.split("token=")[1];
  const row = await loadInviteRow(res.body.invite.id);
  assert.ok(row.token_hash, "a token_hash must be stored");
  assert.notEqual(row.token_hash, rawToken, "the raw token must never be stored verbatim");
  assert.ok(!JSON.stringify(row).includes(decodeURIComponent(rawToken)), "the raw token must not appear anywhere in the stored row");
});

test("11. the new link expires in approximately 7 days", async () => {
  const admin = await makePlatformAdmin(`invite-expiry-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Expiry Target");
  const token = await createSession(admin.id);

  const res = await api(inviteEndpoint(), {
    method: "POST",
    cookie: cookieFor(token),
    body: { athleteId: athlete, email: `expiry-target-${Date.now()}@test.local`, contextType: "platform", contextId: null },
  });
  assert.equal(res.status, 201);
  const expiresAt = new Date(res.body.invite.expiresAt).getTime();
  const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(expiresAt - expectedMs) < 5 * 60 * 1000, "expiry must be ~7 days from creation (within a 5 minute tolerance)");
});

// --- 12-13: concurrency, regenerate ---

test("12. two parallel create requests for the same athlete+context leave exactly one open (valid) invite", async () => {
  const admin = await makePlatformAdmin(`invite-concurrent-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Concurrent Target");
  const token = await createSession(admin.id);

  const [resA, resB] = await Promise.all([
    api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `concurrent-a-${Date.now()}@test.local`, contextType: "platform", contextId: null } }),
    api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `concurrent-b-${Date.now()}@test.local`, contextType: "platform", contextId: null } }),
  ]);
  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201);

  const open = await loadOpenInvitesFor(athlete, "platform", null);
  assert.equal(open.length, 1, "exactly one open invite must remain after two parallel generate requests");
});

test("13. regenerating an invite immediately revokes the previous token", async () => {
  const admin = await makePlatformAdmin(`invite-regenerate-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Regenerate Target");
  const token = await createSession(admin.id);
  const email = `regenerate-target-${Date.now()}@test.local`;

  const first = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } });
  assert.equal(first.status, 201);
  const firstRawToken = decodeURIComponent(first.body.inviteUrl.split("token=")[1]);

  const second = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.invite.id, first.body.invite.id, "regenerate must create a new invite row, not update the old one in place");

  const firstRow = await loadInviteRow(first.body.invite.id);
  assert.ok(firstRow.revoked_at, "the previous invite must be revoked once regenerated");
  assert.equal(firstRow.revoke_reason, "regenerated");

  const oldTokenLookup = await api(`/api/auth/invites/${encodeURIComponent(firstRawToken)}`);
  assert.equal(oldTokenLookup.status, 404, "the old token must stop working immediately after regenerate");
});

// --- 14-17: revoke, generic invalid/expired/revoked/unknown ---

test("14. revoking an invite stops its token from working", async () => {
  const admin = await makePlatformAdmin(`invite-revoke-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Revoke Target");
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `revoke-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const revoke = await api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke.status, 200);

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.error, "Invite is invalid or expired.");
});

test("15. an expired invite is rejected with the same generic message as everything else", async () => {
  const admin = await makePlatformAdmin(`invite-expired-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Expired Target");
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `expired-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  await query(`update public.athlete_invites set expires_at = now() - interval '1 hour' where id = $1`, [created.body.invite.id]);

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.error, "Invite is invalid or expired.");
});

test("16. a revoked invite and an unknown token produce the identical generic response (never distinguishing why)", async () => {
  const admin = await makePlatformAdmin(`invite-generic-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Generic Target");
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `generic-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  await api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) });

  const revokedLookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  const unknownLookup = await api(`/api/auth/invites/${encodeURIComponent("totally-made-up-token")}`);
  assert.equal(revokedLookup.status, unknownLookup.status);
  assert.deepEqual(revokedLookup.body, unknownLookup.body);
});

test("17. an already-accepted invite cannot be revoked, but a repeated revoke of an already-revoked invite is idempotent", async () => {
  const admin = await makePlatformAdmin(`invite-revoke-accepted-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Revoke Accepted Target");
  const token = await createSession(admin.id);
  const email = `revoke-accepted-${Date.now()}@test.local`;

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 200);
  cleanupUserIds.add(accept.body.user.id);

  const revokeAccepted = await api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revokeAccepted.status, 409, "an accepted invite must not be revocable as if it were still pending");

  const created2 = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: await makeAthlete("Revoke Twice Target"), email: `revoke-twice-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  const revoke1 = await api(`/api/organization/athlete-invites/${created2.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke1.status, 200);
  const revoke2 = await api(`/api/organization/athlete-invites/${created2.body.invite.id}`, { method: "DELETE", cookie: cookieFor(token) });
  assert.equal(revoke2.status, 200, "revoking an already-revoked invite must be idempotent, not an error");
});

// --- 18: context archived after issuance blocks accept ---

test("18. archiving the club membership after an invite was issued blocks accept, and does not resurrect the membership", async () => {
  const club = await makeClub(`Invite Archive Club ${Date.now()}`);
  const admin = await makeUser({ email: `invite-archive-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const athlete = await makeAthlete("Archive Context Target");
  await addClubMembership(athlete, club);
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `archive-context-${Date.now()}@test.local`, contextType: "club", contextId: club } });
  assert.equal(created.status, 201);
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  await setClubMembershipStatus(athlete, club, "archived");

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404, "an invite whose backing club membership was archived must no longer be usable");

  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 404);

  const membership = await query(`select status from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club'`, [athlete, club]);
  assert.equal(membership.rows[0].status, "archived", "a rejected accept must never resurrect the archived membership");
  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  assert.equal(athleteRow.rows[0].user_id, null, "a rejected accept must never link a login");
});

test("18b. the inviter losing their own club_admin role also invalidates a technically-unexpired invite", async () => {
  const club = await makeClub(`Invite Inviter Lost Role Club ${Date.now()}`);
  const admin = await makeUser({ email: `invite-lostrole-admin-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const athlete = await makeAthlete("Lost Role Target");
  await addClubMembership(athlete, club);
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `lostrole-${Date.now()}@test.local`, contextType: "club", contextId: club } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  await query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [admin.id, club]);

  const lookup = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}`);
  assert.equal(lookup.status, 404, "an invite must stop working once the inviter no longer holds the role that backed it, even if the athlete's membership is still active");
});

// --- 19-21: accept/link mechanics ---

test("19. a brand-new email creates a new account on accept", async () => {
  const admin = await makePlatformAdmin(`invite-newaccount-${Date.now()}@test.local`);
  const athlete = await makeAthlete("New Account Target");
  const token = await createSession(admin.id);
  const email = `newaccount-target-${Date.now()}@test.local`;

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.user.email, email);
  cleanupUserIds.add(accept.body.user.id);

  const athleteRow = await query(`select user_id from public.athletes where id = $1`, [athlete]);
  assert.equal(athleteRow.rows[0].user_id, accept.body.user.id);
});

test("20. an existing email never has its password changed by accept - it returns requiresLogin instead", async () => {
  const admin = await makePlatformAdmin(`invite-existingemail-${Date.now()}@test.local`);
  const existing = await makeUser({ email: `invite-existing-${Date.now()}@test.local`, roleHint: "user" });
  const originalHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  const athlete = await makeAthlete("Existing Email Target");
  const token = await createSession(admin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: existing.email, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 409);
  assert.equal(accept.body.requiresLogin, true);

  const afterHash = (await query(`select password_hash from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  assert.equal(afterHash, originalHash, "an existing account's password must never change via the public accept form");
});

test("21. logging in and using /link connects the athlete profile without any password/role change, and email mismatch or an already-linked profile are rejected", async () => {
  const admin = await makePlatformAdmin(`invite-link-${Date.now()}@test.local`);
  const existing = await makeUser({ email: `invite-link-existing-${Date.now()}@test.local`, roleHint: "user" });
  const originalHash = (await query(`select password_hash, role_hint from public.users where id = $1`, [existing.id])).rows[0].password_hash;
  const athlete = await makeAthlete("Link Target");
  const adminToken = await createSession(admin.id);
  const existingToken = await createSession(existing.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: athlete, email: existing.email, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const mismatchAthlete = await makeAthlete("Mismatch Target");
  const mismatchInvite = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: mismatchAthlete, email: `someone-else-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  assert.equal(mismatchInvite.status, 201, JSON.stringify(mismatchInvite.body));
  const mismatchToken = decodeURIComponent(mismatchInvite.body.inviteUrl.split("token=")[1]);
  const mismatchRes = await api(`/api/auth/invites/${encodeURIComponent(mismatchToken)}/link`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(mismatchRes.status, 403, "linking must be rejected when the invite's email does not match the logged-in account's email");

  const link = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/link`, { method: "POST", cookie: cookieFor(existingToken) });
  assert.equal(link.status, 200);
  assert.equal(link.body.athleteId, athlete);

  const afterRow = (await query(`select password_hash, role_hint from public.users where id = $1`, [existing.id])).rows[0];
  assert.equal(afterRow.password_hash, originalHash, "/link must never change the password");
  assert.equal(afterRow.role_hint, "user", "/link must never change role_hint");

  // Race scenario (section 4): the invite was issued while the athlete was
  // still unlinked, but by the time /link is called, the athlete has ALREADY
  // been linked to a different account through some other path.
  const raceAthlete = await makeAthlete("Race Already Linked Target");
  const raceEmail = `race-linked-${Date.now()}@test.local`;
  const raceInvite = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(adminToken), body: { athleteId: raceAthlete, email: raceEmail, contextType: "platform", contextId: null } });
  assert.equal(raceInvite.status, 201, JSON.stringify(raceInvite.body));
  const raceToken = decodeURIComponent(raceInvite.body.inviteUrl.split("token=")[1]);
  const raceOwner = await makeUser({ email: `invite-race-owner-${Date.now()}@test.local`, roleHint: "user" });
  await query(`update public.athletes set user_id = $1 where id = $2`, [raceOwner.id, raceAthlete]);
  const raceAttemptUser = await makeUser({ email: raceEmail, roleHint: "user" });
  const raceAttemptToken = await createSession(raceAttemptUser.id);
  const rejectedLink = await api(`/api/auth/invites/${encodeURIComponent(raceToken)}/link`, { method: "POST", cookie: cookieFor(raceAttemptToken) });
  assert.equal(rejectedLink.status, 409, "linking must be rejected when the athlete profile is already linked to a DIFFERENT account");
});

// --- 22: multi-role account keeps its staff roles after linking as an athlete ---

test("22. a coach/admin account that accepts an invite for its own athlete profile keeps every staff role it already had", async () => {
  const club = await makeClub(`Invite Multi Role Club ${Date.now()}`);
  const staffAdmin = await makeUser({ email: `invite-multirole-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(staffAdmin.id, club);
  await grantGlobalRoleDirectly(staffAdmin.id, "independent_coach");
  const platformAdmin = await makePlatformAdmin(`invite-multirole-pa-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Multi Role Target");
  await addClubMembership(athlete, club);
  const platformAdminToken = await createSession(platformAdmin.id);
  const staffToken = await createSession(staffAdmin.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(platformAdminToken), body: { athleteId: athlete, email: staffAdmin.email, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  const link = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/link`, { method: "POST", cookie: cookieFor(staffToken) });
  assert.equal(link.status, 200);

  const me = await api("/api/auth/me", { cookie: cookieFor(staffToken) });
  assert.ok(me.body.user.availableWorkspaces.some((w) => w.type === "athlete"), "the account must now also have an athlete workspace");
  assert.ok(me.body.user.availableWorkspaces.some((w) => w.type === "club" && w.scopeId === club), "the account's club_admin workspace must remain untouched");
  assert.ok(me.body.user.availableWorkspaces.some((w) => w.type === "private_coach"), "the account's independent_coach workspace must remain untouched");
});

// --- 23: accept/link never create new memberships or touch existing relationships ---

test("23. accept never creates new club/team memberships or private-coach relationships beyond what already existed", async () => {
  const club = await makeClub(`Invite No Widen Club ${Date.now()}`);
  const team = await makeTeam(club, "No Widen Team");
  const privateCoach = await makePrivateCoach(`invite-nowiden-coach-${Date.now()}@test.local`);
  const athlete = await makeAthlete("No Widen Target");
  await addClubMembership(athlete, club);
  await addTeamMembership(athlete, club, team);
  await makeCoachRelationship(privateCoach.id, athlete);
  const coachToken = await createSession(privateCoach.id);
  const email = `nowiden-target-${Date.now()}@test.local`;

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(coachToken), body: { athleteId: athlete, email, contextType: "private_coach", contextId: null } });
  assert.equal(created.status, 201);
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);
  const accept = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(accept.status, 200);
  cleanupUserIds.add(accept.body.user.id);

  const memberships = await query(`select membership_type, status, club_id, team_id from public.athlete_memberships where athlete_id = $1 order by membership_type`, [athlete]);
  assert.equal(memberships.rowCount, 2, "only the pre-existing club+team membership rows may exist - accept must not create new ones");
  assert.ok(memberships.rows.every((row) => row.status === "active"));

  const coachRelationships = await query(`select user_id, is_active from public.user_athletes where athlete_id = $1 and relationship_type = 'coach'`, [athlete]);
  assert.equal(coachRelationships.rowCount, 1);
  assert.equal(coachRelationships.rows[0].user_id, privateCoach.id);
  assert.equal(coachRelationships.rows[0].is_active, true, "the pre-existing private-coach relationship must remain exactly as it was");
});

// --- 24: one token cannot be accepted twice ---

test("24. one token cannot be accepted twice", async () => {
  const admin = await makePlatformAdmin(`invite-onceonly-${Date.now()}@test.local`);
  const athlete = await makeAthlete("Once Only Target");
  const token = await createSession(admin.id);
  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email: `onceonly-target-${Date.now()}@test.local`, contextType: "platform", contextId: null } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rawToken = decodeURIComponent(created.body.inviteUrl.split("token=")[1]);

  const first = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "somepassword123" } });
  assert.equal(first.status, 200);
  cleanupUserIds.add(first.body.user.id);
  const second = await api(`/api/auth/invites/${encodeURIComponent(rawToken)}/accept`, { method: "POST", body: { password: "someotherpassword456" } });
  assert.equal(second.status, 404, "a token that was already accepted must never be usable again");
});

// --- 25: an unauthorized viewer cannot see or revoke another context's invite ---

test("25. an unauthorized viewer cannot see another context's pending invite in Organization data, and cannot revoke it", async () => {
  const clubMine = await makeClub(`Invite Unauthorized Club Mine ${Date.now()}`);
  const clubOther = await makeClub(`Invite Unauthorized Club Other ${Date.now()}`);
  const adminOther = await makeUser({ email: `invite-unauthorized-other-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(adminOther.id, clubOther);
  const adminMine = await makeUser({ email: `invite-unauthorized-mine-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(adminMine.id, clubMine);
  const athlete = await makeAthlete("Unauthorized Target");
  await addClubMembership(athlete, clubOther);
  const otherToken = await createSession(adminOther.id);
  const mineToken = await createSession(adminMine.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(otherToken), body: { athleteId: athlete, email: `unauthorized-target-${Date.now()}@test.local`, contextType: "club", contextId: clubOther } });
  assert.equal(created.status, 201);

  const revokeAttempt = await api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(mineToken) });
  assert.equal(revokeAttempt.status, 403, "a club admin of a DIFFERENT club must not be able to revoke this invite");

  const orgView = await api("/api/organization", { cookie: cookieFor(mineToken) });
  await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(mineToken), body: { type: "club", scopeId: clubMine } });
  const orgViewAfterSwitch = await api("/api/organization", { cookie: cookieFor(mineToken) });
  assert.ok(
    !orgViewAfterSwitch.body.athletes.some((a) => a.id === athlete),
    "an athlete belonging only to a different club must not even appear in this viewer's club workspace",
  );
});

test("25b. a private_coach invite is never visible to a different coach who also sees the same athlete", async () => {
  const coachA = await makePrivateCoach(`invite-pc-viewer-a-${Date.now()}@test.local`);
  const coachB = await makePrivateCoach(`invite-pc-viewer-b-${Date.now()}@test.local`);
  const athlete = await makeAthlete("PC Viewer Target");
  await makeCoachRelationship(coachA.id, athlete);
  await makeCoachRelationship(coachB.id, athlete);
  const tokenA = await createSession(coachA.id);
  const tokenB = await createSession(coachB.id);

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(tokenA), body: { athleteId: athlete, email: `pc-viewer-target-${Date.now()}@test.local`, contextType: "private_coach", contextId: null } });
  assert.equal(created.status, 201);

  const orgViewA = await api("/api/organization", { cookie: cookieFor(tokenA) });
  const rowA = orgViewA.body.athletes.find((a) => a.id === athlete);
  assert.equal(rowA?.inviteStatus, "pending", "coach A (the inviter) must see their own pending invite");

  const orgViewB = await api("/api/organization", { cookie: cookieFor(tokenB) });
  const rowB = orgViewB.body.athletes.find((a) => a.id === athlete);
  assert.equal(rowB?.inviteStatus, "none", "coach B must never see coach A's private-coach invite for the same shared athlete");

  const revokeAttemptB = await api(`/api/organization/athlete-invites/${created.body.invite.id}`, { method: "DELETE", cookie: cookieFor(tokenB) });
  assert.equal(revokeAttemptB.status, 403, "coach B must not be able to revoke coach A's private-coach invite");
});

// --- 26: GET /organization surfaces pending status without ever exposing the token ---

test("26. GET /organization exposes pending invite details for the managing viewer, and never the token or its hash", async () => {
  const club = await makeClub(`Invite Status Club ${Date.now()}`);
  const admin = await makeUser({ email: `invite-status-${Date.now()}@test.local`, roleHint: "user" });
  await grantClubAdminDirectly(admin.id, club);
  const athlete = await makeAthlete("Status Target");
  await addClubMembership(athlete, club);
  const token = await createSession(admin.id);
  const email = `status-target-${Date.now()}@test.local`;

  const created = await api(inviteEndpoint(), { method: "POST", cookie: cookieFor(token), body: { athleteId: athlete, email, contextType: "club", contextId: club } });
  assert.equal(created.status, 201);

  await api("/api/auth/workspace", { method: "PUT", cookie: cookieFor(token), body: { type: "club", scopeId: club } });
  const org = await api("/api/organization", { cookie: cookieFor(token) });
  const row = org.body.athletes.find((a) => a.id === athlete);
  assert.equal(row.inviteStatus, "pending");
  assert.equal(row.invite.email, email);
  assert.equal(row.invite.contextType, "club");
  assert.equal(row.invite.contextId, club);
  assert.ok(row.invite.expiresAt);
  assert.ok(row.invite.createdAt);
  assert.ok(!("tokenHash" in row.invite));
  assert.ok(!("token" in row.invite));
  assert.ok(!JSON.stringify(row.invite).toLowerCase().includes("hash"));
});
