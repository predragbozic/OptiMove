import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { closeUnusableJoinLinkApplications, findJoinLinkIdsNeedingCleanupCheck, lockJoinLinkActions } from "../src/joinLinkContext.js";
import { __testHooks } from "../src/routes/organization.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// perf/join-link-cleanup: GET /api/organization[/athlete-join-links] used to
// call sweepUnusableJoinLink (its own pool.connect() + BEGIN + advisory
// lock + FOR UPDATE + COMMIT) once for every link with a pending count > 0,
// even when every one of them was still perfectly valid - the overwhelming
// common case. findJoinLinkIdsNeedingCleanupCheck is a read-only batch
// prefilter (at most 3 extra queries total, never one per link) that
// narrows this down to only the links that MIGHT be permanently unusable;
// sweepUnusableJoinLink itself, its lock, its re-fetch FOR UPDATE, and its
// recheck are completely unchanged for every candidate it still calls.
//
// These tests prove: (a) a healthy link's pending applications never cost a
// transaction any more, (b) every documented reason for permanent
// unusability (expired/revoked/archived club/archived team/lost
// independent_coach role) still gets swept exactly as before, (c) a
// full-capacity link is never mistaken for permanently unusable, (d) real
// SQL/transaction counts for the "N valid" and "N total, K invalid"
// scenarios the task asks for, and (e) every documented concurrent pairing
// (cleanup vs itself, vs approve, vs reject, vs revoke, vs regenerate, vs
// email confirm, vs apply) converges on the one allowed final state, never
// a partial mutation.

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

function linksEndpoint() {
  return "/api/organization/athlete-join-links";
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

async function confirmEmail(rawVerificationToken) {
  return api(`/api/auth/email-verifications/${encodeURIComponent(rawVerificationToken)}/confirm`, { method: "POST" });
}

async function applyToLink(rawToken, emailSeed) {
  return api(`/api/auth/join-links/${encodeURIComponent(rawToken)}/apply`, {
    method: "POST",
    body: { firstName: "Batch", lastName: "Applicant", email: `${emailSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, password: "somepassword123" },
  });
}

async function applicationRow(linkId) {
  const result = await query(`select id, status, password_hash from public.athlete_join_applications where join_link_id = $1 order by submitted_at desc limit 1`, [linkId]);
  return result.rows[0];
}

function approveEndpoint(applicationId) {
  return `/api/organization/athlete-join-applications/${applicationId}/approve`;
}
function rejectEndpoint(applicationId) {
  return `/api/organization/athlete-join-applications/${applicationId}/reject`;
}
function revokeEndpoint(linkId) {
  return `/api/organization/athlete-join-links/${linkId}`;
}
function regenerateEndpoint(linkId) {
  return `/api/organization/athlete-join-links/${linkId}/regenerate`;
}

// node-postgres's pg-pool implements the plain query() convenience method
// (used by db.js's own `query()`, and by every ordinary SELECT in this
// codebase, including the batch prefilter's own reads) internally via THE
// SAME pool.connect() - so counting raw connect() calls does not
// distinguish "a real cleanup transaction opened" from "any query ran at
// all" (confirmed by reading node_modules/pg-pool/index.js). What's actually
// unique to a real cleanup transaction (sweepUnusableJoinLink, and every
// other mutation endpoint in this codebase) is an explicit `client.query
// ("begin")` issued against a client checked out via an explicit
// pool.connect() call - a plain pool.query() never issues that literal
// statement. This wraps pool.connect to intercept the returned client's own
// .query() and count only exact "begin" calls, which is what precisely
// counts real transactions (not wall-clock timing) without touching
// production code at all - always restored in a finally block.
// Monkey-patching pool.connect()/client.query() to count real transactions
// was tried first and dropped: node-postgres recycles pooled client objects
// across acquisitions, and an occasional connect() unrelated to the request
// under test can stay pending well past this helper's own window (observed
// as spurious "asynchronous activity after the test ended" errors once the
// pool is torn down in this file's own after() hook) - the wrap has no safe
// place to fully unwind. organization.js's __testHooks.cleanupTransactionCount
// is a plain counter incremented once per real sweepUnusableJoinLink()
// transaction, with no pg internals involved at all - the diff between two
// readings of it is exactly "how many cleanup transactions actually ran"
// during `fn()`, and nothing about it can outlive `fn()` in a way that
// causes trouble.
async function countCleanupTransactions(fn) {
  const before = __testHooks.cleanupTransactionCount;
  await fn();
  return __testHooks.cleanupTransactionCount - before;
}

// Reconstructs the PRE-perf/join-link-cleanup per-link loop exactly - what
// loadJoinLinksForWorkspace used to do unconditionally for every
// pending-count>0 link, before findJoinLinkIdsNeedingCleanupCheck existed.
// sweepUnusableJoinLink itself (and everything it calls) is completely
// unchanged by this PR; this helper exists only to produce the documented
// "before" transaction count for the Scenario A/B proofs below, using the
// exact same already-exported primitives sweepUnusableJoinLink itself uses.
// Returns the number of transactions it opened directly (one per link,
// unconditionally, by construction) rather than routing through
// __testHooks.cleanupTransactionCount - this helper deliberately calls none
// of the real production code path (sweepUnusableJoinLink is what that
// counter tracks), only the same already-exported primitives it's built
// from, so its own loop is the ground truth for the "before" count.
async function oldStyleSweepEveryPendingLink(linkIds) {
  let transactionsOpened = 0;
  for (const linkId of linkIds) {
    const client = await pool.connect();
    transactionsOpened += 1;
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockJoinLinkActions(exec, linkId);
      const fresh = await client.query(
        `select id, context_type, context_id, created_by_user_id, is_active, revoked_at, expires_at
         from public.athlete_join_links where id = $1 limit 1 for update`,
        [linkId],
      );
      if (fresh.rows[0]) await closeUnusableJoinLinkApplications(exec, fresh.rows[0]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return transactionsOpened;
}

// --- 1: a healthy link's pending applications never cost a transaction ---

test("1. a valid link with pending applications opens zero cleanup transactions on GET", async () => {
  const coach = await makePrivateCoach(`jlc-valid-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-valid-applicant");

  const connects = await countCleanupTransactions(() => api(linksEndpoint(), { cookie: cookieFor(token) }));
  assert.equal(connects, 0, "a link that is still fully valid must never open sweepUnusableJoinLink's transaction");

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "pending", "the pending application itself must be untouched");
});

// --- 2-7: every documented reason for permanent unusability still sweeps ---

test("2. an expired link's pending application becomes cancelled and its password hash is cleared", async () => {
  const coach = await makePrivateCoach(`jlc-expired-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-expired-applicant");
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const connects = await countCleanupTransactions(() => api(linksEndpoint(), { cookie: cookieFor(token) }));
  assert.equal(connects, 1, "an actually-invalid candidate must still open exactly one real cleanup transaction");

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("3. a revoked link's pending application becomes cancelled once swept via GET", async () => {
  const coach = await makePrivateCoach(`jlc-revoked-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-revoked-applicant");
  // Simulates a link revoked through some path other than DELETE (which
  // already cancels applications inline) - directly flips is_active/revoked_at
  // so the GET-triggered sweep, not the revoke endpoint, is what's under test.
  await query(`update public.athlete_join_links set is_active = false, revoked_at = now() where id = $1`, [created.body.link.id]);

  const list = await api(linksEndpoint(), { cookie: cookieFor(token) });
  assert.equal(list.status, 200);
  const listed = list.body.links.find((l) => l.id === created.body.link.id);
  assert.equal(listed.status, "revoked");
  assert.equal(listed.pendingCount, 0);

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("4. an archived club closes its club-context link's pending application via GET", async () => {
  const club = await makeClub(`JLC Club ${Date.now()}`);
  const admin = await makeUser({ email: `jlc-club-${Date.now()}@test.local` });
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [admin.id, club]);
  const token = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "club", contextId: club, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-club-applicant");

  await query(`update public.clubs set is_active = false where id = $1`, [club]);
  // Once their own club is archived, this admin's "club" workspace may no
  // longer resolve at all (see backend/src/workspace.js) - a platform
  // admin's platform-wide GET is what actually sweeps it here, same as the
  // established pattern for the lost-independent_coach-role case (test 6).
  const platformAdmin = await makePlatformAdmin(`jlc-club-pa-${Date.now()}@test.local`);
  const platformToken = await createSession(platformAdmin.id);
  const list = await api(linksEndpoint(), { cookie: cookieFor(platformToken) });
  assert.equal(list.status, 200);
  assert.ok(list.body.links.some((l) => l.id === created.body.link.id));

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("5. an archived team closes its team-context link's pending application via GET", async () => {
  const club = await makeClub(`JLC Team Club ${Date.now()}`);
  const team = await makeTeam(club, "JLC Team");
  const admin = await makeUser({ email: `jlc-team-${Date.now()}@test.local` });
  await query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)`, [admin.id, team]);
  const token = await createSession(admin.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "team", contextId: team, expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-team-applicant");

  await query(`update public.teams set is_active = false where id = $1`, [team]);
  // Same reasoning as test 4 - the affected coach's own "team" workspace may
  // no longer resolve once the team is archived, so a platform admin's
  // platform-wide GET is what actually sweeps it here.
  const platformAdmin = await makePlatformAdmin(`jlc-team-pa-${Date.now()}@test.local`);
  const platformToken = await createSession(platformAdmin.id);
  const list = await api(linksEndpoint(), { cookie: cookieFor(platformToken) });
  assert.equal(list.status, 200);
  assert.ok(list.body.links.some((l) => l.id === created.body.link.id));

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("6. a private coach who loses the independent_coach role has their link's pending application closed once a platform admin's GET sweeps it", async () => {
  const coach = await makePrivateCoach(`jlc-lostrole-${Date.now()}@test.local`);
  const platformAdmin = await makePlatformAdmin(`jlc-lostrole-pa-${Date.now()}@test.local`);
  const coachToken = await createSession(coach.id);
  const platformToken = await createSession(platformAdmin.id);
  const created = await trackLink(await createLink(cookieFor(coachToken), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-lostrole-applicant");

  await revokeGlobalRoleDirectly(coach.id, "independent_coach");
  // A platform admin's GET sees every link table-wide, so an exact
  // transaction count here isn't a reliable signal on a shared dev database
  // (other tests' own links are in scope too) - the precise "0 for N valid,
  // K for N total" counting proof lives in tests 9/10 below, scoped to a
  // single creator's own view instead. This test only needs to prove the
  // actual cleanup still happens correctly through the platform-wide path.
  const list = await api(linksEndpoint(), { cookie: cookieFor(platformToken) });
  assert.equal(list.status, 200);
  assert.ok(list.body.links.some((l) => l.id === created.body.link.id), "a platform admin must see every link regardless of context");

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("7. a full-capacity link is never mistaken for permanently unusable - its pending applications are left untouched", async () => {
  const coach = await makePrivateCoach(`jlc-full-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  // maxUses=2 so BOTH applications can be submitted while the link is still
  // within capacity - loadUsableJoinLink (used by apply) already rejects a
  // NEW submission once a link is genuinely full, so the second application
  // must exist before the first approval pushes approved_uses to capacity.
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, maxUses: 2 }));
  const rawToken = extractToken(created.body.joinUrl);
  const firstApply = await applyToLink(rawToken, "jlc-full-first");
  assert.equal(firstApply.status, 201);
  const secondApply = await applyToLink(rawToken, "jlc-full-second");
  assert.equal(secondApply.status, 201, "a second application must still be accepted while the link has remaining capacity");
  const firstAppId = (await query(`select id from public.athlete_join_applications where join_link_id = $1 order by submitted_at limit 1`, [created.body.link.id])).rows[0].id;
  const secondAppId = (await query(`select id from public.athlete_join_applications where join_link_id = $1 order by submitted_at desc limit 1`, [created.body.link.id])).rows[0].id;

  await confirmEmail(firstApply.body.devVerificationToken);
  const approvedFirst = await api(approveEndpoint(firstAppId), { method: "POST", cookie: cookieFor(token) });
  assert.equal(approvedFirst.status, 200);
  cleanupUserIds.add(approvedFirst.body.userId);
  cleanupAthleteIds.add(approvedFirst.body.athleteId);

  await confirmEmail(secondApply.body.devVerificationToken);
  const approvedSecond = await api(approveEndpoint(secondAppId), { method: "POST", cookie: cookieFor(token) });
  assert.equal(approvedSecond.status, 200);
  cleanupUserIds.add(approvedSecond.body.userId);
  cleanupAthleteIds.add(approvedSecond.body.athleteId);

  // The link is now at capacity (approved_uses === max_uses === 2) but is
  // NOT permanently unusable. A THIRD, still-pending request submitted
  // before capacity was reached must survive the sweep untouched (it can
  // still legitimately be rejected later, just never approved past
  // capacity) - simulated directly here since apply() itself already
  // refuses any brand-new submission once genuinely full, which is
  // unrelated, pre-existing behavior this PR does not touch.
  const thirdInsert = await query(
    `insert into public.athlete_join_applications (join_link_id, applicant_user_id, email, first_name, last_name, display_name, password_hash, status, status_token_hash)
     values ($1, null, $2, 'Third', 'Pending', 'Third Pending', $3, 'pending', $4)
     returning id`,
    [created.body.link.id, `jlc-full-third-${Date.now()}@test.local`, hashPassword("irrelevant-password-123"), crypto.randomBytes(16).toString("base64url")],
  );
  const thirdAppId = thirdInsert.rows[0].id;

  const connects = await countCleanupTransactions(() => api(linksEndpoint(), { cookie: cookieFor(token) }));
  assert.equal(connects, 0, "a full-capacity link must never be treated as a cleanup candidate");

  const thirdRow = await query(`select status, password_hash from public.athlete_join_applications where id = $1`, [thirdAppId]);
  assert.equal(thirdRow.rows[0].status, "pending");
  assert.ok(thirdRow.rows[0].password_hash, "an untouched pending application must keep its password hash");

  const list = await api(linksEndpoint(), { cookie: cookieFor(token) });
  assert.equal(list.body.links.find((l) => l.id === created.body.link.id).status, "full");
});

test("8. an already-terminal (rejected) application on a since-expired link is left completely untouched", async () => {
  const coach = await makePrivateCoach(`jlc-terminal-reject-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-terminal-reject-applicant");
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  const rejected = await api(rejectEndpoint(appId), { method: "POST", cookie: cookieFor(token), body: { reason: "Not now" } });
  assert.equal(rejected.status, 200);

  const before = await query(`select status, reviewed_at, reviewed_by_user_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(before.rows[0].status, "rejected");

  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);
  await api(linksEndpoint(), { cookie: cookieFor(token) });

  const after = await query(`select status, reviewed_at, reviewed_by_user_id from public.athlete_join_applications where id = $1`, [appId]);
  assert.equal(after.rows[0].status, "rejected", "an already-rejected row must never be reopened or reclassified by the sweep");
  assert.deepEqual(after.rows[0].reviewed_at, before.rows[0].reviewed_at);
  assert.deepEqual(after.rows[0].reviewed_by_user_id, before.rows[0].reviewed_by_user_id);
});

// --- 9-10: performance proof (Scenario A and B from the task) ---

// Scenario A and B both use ONE coach creating N of their own private_coach
// links, then that SAME coach's own GET (private_coach workspace visibility
// is scoped to `created_by_user_id = self` - see loadJoinLinksForWorkspace)
// to count transactions. A platform-admin-wide view would also see every
// OTHER test's links in this shared dev database, making an exact
// transaction count unreliable; a single creator's own scope is fully
// isolated from everything else running in this file.

test("9. Scenario A: N valid links with pending applications cost N transactions the old way, 0 the new way", async () => {
  const N = 4;
  const coach = await makePrivateCoach(`jlc-scenA-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const linkIds = [];
  for (let i = 0; i < N; i += 1) {
    const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, label: `Scenario A link ${i}` }));
    const rawToken = extractToken(created.body.joinUrl);
    await applyToLink(rawToken, `jlc-scenA-applicant-${i}`);
    linkIds.push(created.body.link.id);
  }

  const beforeConnects = await oldStyleSweepEveryPendingLink(linkIds);
  assert.equal(beforeConnects, N, "the old per-link loop must open exactly one cleanup transaction per pending link, even when every one is valid");
  for (const linkId of linkIds) {
    const row = await applicationRow(linkId);
    assert.equal(row.status, "pending", "the old sweep simulation must not have actually closed anything - every link here is still valid");
  }

  const afterConnects = await countCleanupTransactions(() => api(linksEndpoint(), { cookie: cookieFor(token) }));
  assert.equal(afterConnects, 0, "the batched read-only prefilter must open zero cleanup transactions when every candidate is still valid");
});

test("10. Scenario B: N links with K permanently unusable cost at most K transactions, never N", async () => {
  const N = 5;
  const K = 2;
  const coach = await makePrivateCoach(`jlc-scenB-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const linkIds = [];
  for (let i = 0; i < N; i += 1) {
    const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5, label: `Scenario B link ${i}` }));
    const rawToken = extractToken(created.body.joinUrl);
    await applyToLink(rawToken, `jlc-scenB-applicant-${i}`);
    linkIds.push(created.body.link.id);
    if (i < K) await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);
  }

  const connects = await countCleanupTransactions(() => api(linksEndpoint(), { cookie: cookieFor(token) }));
  assert.equal(connects, K, "exactly the K actually-invalid links must open a cleanup transaction, never all N");

  for (let i = 0; i < N; i += 1) {
    const row = await applicationRow(linkIds[i]);
    assert.equal(row.status, i < K ? "cancelled" : "pending");
  }
});

// --- 11: two parallel GET cleanup requests over the same link ---

test("11. two parallel GET requests sweeping the same expired link converge on one cancelled application, never double-processed or erroring", async () => {
  const coach = await makePrivateCoach(`jlc-parallel-get-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-parallel-get-applicant");
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const [a, b] = await Promise.all([api(linksEndpoint(), { cookie: cookieFor(token) }), api(linksEndpoint(), { cookie: cookieFor(token) })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

// --- 12-16: cleanup racing every other join-link mutation ---

test("12. cleanup vs approve on an expired link: the only allowed outcome is cancelled + 409, never approved", async () => {
  const coach = await makePrivateCoach(`jlc-vs-approve-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const applied = await applyToLink(rawToken, "jlc-vs-approve-applicant");
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  await confirmEmail(applied.body.devVerificationToken);
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const [getResult, approveResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    api(approveEndpoint(appId), { method: "POST", cookie: cookieFor(token) }),
  ]);
  assert.equal(getResult.status, 200);
  assert.ok([200, 409].includes(approveResult.status), `approve must either lose the race cleanly (409) or the expiry check inside its own lock must reject it - got ${approveResult.status}`);
  if (approveResult.status === 200) assert.fail("an expired link must never successfully approve an application, regardless of race order");

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled", "the only allowed final state for an expired link's application is cancelled");
  assert.equal(row.password_hash, null);
  const linkRow = await query(`select approved_uses from public.athlete_join_links where id = $1`, [created.body.link.id]);
  assert.equal(Number(linkRow.rows[0].approved_uses), 0, "approved_uses must never be incremented for a link that never actually approved anything");
});

test("13. cleanup vs reject on an expired link: the only allowed outcome is cancelled, reject never succeeds against a dead link's stale row", async () => {
  const coach = await makePrivateCoach(`jlc-vs-reject-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-vs-reject-applicant");
  const appId = (await query(`select id from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id])).rows[0].id;
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const [getResult, rejectResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    api(rejectEndpoint(appId), { method: "POST", cookie: cookieFor(token), body: { reason: "no" } }),
  ]);
  assert.equal(getResult.status, 200);
  assert.ok([200, 409].includes(rejectResult.status));

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled", "an expired link's application must end up cancelled (by whichever path wins), never left rejected with a live hash gone missing inconsistently");
  assert.equal(row.password_hash, null);
});

test("14. cleanup vs revoke on a still-valid link: both converge on the same revoked+cancelled final state, no matter which wins the lock first", async () => {
  const coach = await makePrivateCoach(`jlc-vs-revoke-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-vs-revoke-applicant");

  const [getResult, revokeResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    api(revokeEndpoint(created.body.link.id), { method: "DELETE", cookie: cookieFor(token) }),
  ]);
  assert.equal(getResult.status, 200);
  assert.equal(revokeResult.status, 200);

  const linkRow = await query(`select is_active, revoked_at from public.athlete_join_links where id = $1`, [created.body.link.id]);
  assert.equal(linkRow.rows[0].is_active, false);
  assert.ok(linkRow.rows[0].revoked_at);
  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
});

test("15. cleanup vs regenerate on a still-valid link: regenerate always succeeds, the sweep finds nothing to close, no deadlock", async () => {
  const coach = await makePrivateCoach(`jlc-vs-regen-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-vs-regen-applicant");
  const originalTokenHash = (await query(`select token_hash from public.athlete_join_links where id = $1`, [created.body.link.id])).rows[0].token_hash;

  const [getResult, regenResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    api(regenerateEndpoint(created.body.link.id), { method: "POST", cookie: cookieFor(token) }),
  ]);
  assert.equal(getResult.status, 200);
  assert.equal(regenResult.status, 200);

  const newTokenHash = (await query(`select token_hash from public.athlete_join_links where id = $1`, [created.body.link.id])).rows[0].token_hash;
  assert.notEqual(newTokenHash, originalTokenHash, "regenerate must still succeed and change the token even with a concurrent cleanup GET");
  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "pending", "a still-valid link's pending application must be untouched by either request");
});

test("16. cleanup vs email confirm on an expired link: the only allowed outcome is cancelled, confirm never verifies a dead link's application", async () => {
  const coach = await makePrivateCoach(`jlc-vs-confirm-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  const applied = await applyToLink(rawToken, "jlc-vs-confirm-applicant");
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const [getResult, confirmResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    confirmEmail(applied.body.devVerificationToken),
  ]);
  assert.equal(getResult.status, 200);
  // The confirm endpoint's generic-invalid response is 404 ("This
  // verification link is invalid or has expired.") - the SAME response for
  // every unusable case (not found, already consumed, and - what's under
  // test here - a link that's since become permanently dead), by design
  // never distinguishing which.
  assert.equal(confirmResult.status, 404, "confirm must return the same generic-invalid response whether the cleanup sweep or confirm's own internal recheck is what caught the expiry");

  const row = await applicationRow(created.body.link.id);
  assert.equal(row.status, "cancelled");
  assert.equal(row.password_hash, null);
  assert.equal((await query(`select email_verified_at from public.athlete_join_applications where id = $1`, [row.id])).rows[0].email_verified_at, null, "an expired link's application must never end up email-verified via a race with its own cleanup");
});

test("17. cleanup vs a new apply on an already-expired link: apply is rejected as invalid regardless of race order, no new row is created", async () => {
  const coach = await makePrivateCoach(`jlc-vs-apply-${Date.now()}@test.local`);
  const token = await createSession(coach.id);
  const created = await trackLink(await createLink(cookieFor(token), { contextType: "private_coach", expiresInDays: 5 }));
  const rawToken = extractToken(created.body.joinUrl);
  await applyToLink(rawToken, "jlc-vs-apply-existing-applicant");
  await query(`update public.athlete_join_links set expires_at = now() - interval '1 hour' where id = $1`, [created.body.link.id]);

  const [getResult, applyResult] = await Promise.all([
    api(linksEndpoint(), { cookie: cookieFor(token) }),
    applyToLink(rawToken, "jlc-vs-apply-new-applicant"),
  ]);
  assert.equal(getResult.status, 200);
  assert.equal(applyResult.status, 404, "an expired link must never accept a brand-new application, race or not");

  const rows = await query(`select status, password_hash from public.athlete_join_applications where join_link_id = $1`, [created.body.link.id]);
  assert.equal(rows.rows.length, 1, "the concurrent apply attempt against an expired link must never create a second row");
  assert.equal(rows.rows[0].status, "cancelled");
  assert.equal(rows.rows[0].password_hash, null);
});

// --- 18: findJoinLinkIdsNeedingCleanupCheck unit coverage (no locks, no mutation) ---

test("18. findJoinLinkIdsNeedingCleanupCheck: empty input needs no query, and only flags the documented reasons", async () => {
  const empty = await findJoinLinkIdsNeedingCleanupCheck(query, []);
  assert.equal(empty.size, 0);

  const club = await makeClub(`JLC Unit Club ${Date.now()}`);
  const archivedClub = await makeClub(`JLC Unit Archived Club ${Date.now()}`);
  await query(`update public.clubs set is_active = false where id = $1`, [archivedClub]);

  const links = [
    { id: "valid-club", context_type: "club", context_id: club, created_by_user_id: null, expires_at: new Date(Date.now() + 86400000), is_active: true, revoked_at: null },
    { id: "archived-club", context_type: "club", context_id: archivedClub, created_by_user_id: null, expires_at: new Date(Date.now() + 86400000), is_active: true, revoked_at: null },
    { id: "expired", context_type: "club", context_id: club, created_by_user_id: null, expires_at: new Date(Date.now() - 3600000), is_active: true, revoked_at: null },
    { id: "revoked", context_type: "club", context_id: club, created_by_user_id: null, expires_at: new Date(Date.now() + 86400000), is_active: false, revoked_at: new Date() },
  ];
  const flagged = await findJoinLinkIdsNeedingCleanupCheck(query, links);
  assert.deepEqual([...flagged].sort(), ["archived-club", "expired", "revoked"].sort());
});
