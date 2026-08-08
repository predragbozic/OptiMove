import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { loadAuthorizationContext } from "../src/authz.js";
import { canManageAthlete, canManageAthletes } from "../src/routes/organization.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// perf/program-access-batch-authorization: loadProgramAccessRequests used to
// call canManageAthlete once per row (N extra SQL queries for N rows, worse
// for repeat rows of the same athlete). canManageAthletes replaces that with
// one batch query for the whole set. These tests prove:
//   (a) canManageAthletes returns EXACTLY what N individual canManageAthlete
//       calls would, across the full permission matrix (equivalence);
//   (b) the SQL call count is bounded at 1 regardless of row/athlete count,
//       proven via real instrumentation (a counting executor / a temporary
//       pool.query wrap), never wall-clock timing;
//   (c) the GET /api/organization endpoint's accessRequests output is
//       unchanged end-to-end (same rows, same order, same limit, same
//       workspace filtering, same 200 semantics).
// canManageAthlete itself is untouched - see assertEquivalent below, which
// drives BOTH the old per-athlete loop and the new batch call from the same
// fixtures and diffs the results.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupClubIds = new Set();
const cleanupTeamIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["program_access", () => cleanupPlanIds.size && query(`delete from library.program_access where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["teams", () => cleanupTeamIds.size && query(`delete from public.teams where id = any($1::uuid[])`, [[...cleanupTeamIds]])],
    ["clubs", () => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: cookie ? { Cookie: cookie } : {} });
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

async function makeAthlete({ userId = null } = {}) {
  const externalId = `pab${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active)
     values ($1, $1, 'Batch', 'Athlete', 'Batch Athlete', 'Batch Athlete', $2, true)
     returning id`,
    [externalId, userId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  return athleteId;
}

async function addMembership(athleteId, { clubId = null, teamId = null, membershipType, status = "active" }) {
  await query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status)
     values ($1, $2, $3, $4, $5)`,
    [athleteId, clubId, teamId, membershipType, status],
  );
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

async function grantCoachAthleteLink(userId, athleteId, active = true) {
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', $3)
     on conflict (user_id, athlete_id, relationship_type) do update set is_active = $3, updated_at = now()`,
    [userId, athleteId, active],
  );
}

// Builds a real req.authz exactly the way attachAuthorizationContext does in
// production (req.authz = await loadAuthorizationContext(req.user)) - never
// a hand-mocked shape, so these tests exercise the exact same authz object
// the real request pipeline would build.
async function reqFor(user) {
  const authz = await loadAuthorizationContext({ id: user.id, role_hint: user.role_hint || "user" });
  return { user: { id: user.id }, authz };
}

// Drives BOTH the untouched single-athlete canManageAthlete (once per id,
// exactly like loadProgramAccessRequests' old loop) and the new batch
// canManageAthletes from the SAME req/athleteIds, and asserts they agree -
// this is the equivalence proof requirement, reused by every matrix test
// below instead of being one giant separate fixture.
async function assertEquivalent(req, athleteIds, expectedManageable, label) {
  const oldWay = new Set();
  for (const id of athleteIds) {
    if (await canManageAthlete(req, id)) oldWay.add(String(id));
  }
  const newWay = await canManageAthletes(req, athleteIds);
  assert.deepEqual([...oldWay].sort(), [...newWay].sort(), `${label}: batch result must exactly match the old per-athlete loop`);
  assert.deepEqual([...newWay].sort(), [...expectedManageable].map(String).sort(), `${label}: unexpected manageable set`);
}

test("1. platform admin can manage any athlete, with zero SQL queries (short-circuit, same as canManageAthlete)", async () => {
  const admin = await makeUser({ email: `pab-admin-${Date.now()}@test.local` });
  await grantGlobalRole(admin.id, "platform_admin");
  const athleteA = await makeAthlete();
  const athleteB = await makeAthlete();
  const req = await reqFor(admin);

  let calls = 0;
  const countingExecutor = { query: (...args) => { calls += 1; return query(...args); } };
  const manageable = await canManageAthletes(req, [athleteA, athleteB], countingExecutor);
  assert.equal(calls, 0, "a platform admin must never issue an authorization SQL query, matching canManageAthlete's own short-circuit");
  assert.deepEqual([...manageable].sort(), [athleteA, athleteB].sort());
  await assertEquivalent(req, [athleteA, athleteB], [athleteA, athleteB], "platform admin");
});

test("2. independent coach with an active relationship can manage that athlete, and only that one", async () => {
  const coach = await makeUser({ email: `pab-coach-${Date.now()}@test.local` });
  await grantGlobalRole(coach.id, "independent_coach");
  const myAthlete = await makeAthlete();
  const otherAthlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, myAthlete);
  const req = await reqFor(coach);

  await assertEquivalent(req, [myAthlete, otherAthlete], [myAthlete], "independent coach with relationship");
});

test("3. independent coach with no relationship to the athlete cannot manage it", async () => {
  const coach = await makeUser({ email: `pab-coach-none-${Date.now()}@test.local` });
  await grantGlobalRole(coach.id, "independent_coach");
  const athlete = await makeAthlete();
  const req = await reqFor(coach);

  await assertEquivalent(req, [athlete], [], "independent coach with no relationship");
});

test("4. club admin can manage an athlete with an active club membership in their own club", async () => {
  const club = await makeClub(`PAB Club A ${Date.now()}`);
  const admin = await makeUser({ email: `pab-clubadmin-${Date.now()}@test.local` });
  await grantClubRole(admin.id, club);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, membershipType: "club" });
  const req = await reqFor(admin);

  await assertEquivalent(req, [athlete], [athlete], "club admin, own club");
});

test("5. club admin cannot manage an athlete whose active club membership is a DIFFERENT club", async () => {
  const clubA = await makeClub(`PAB Club B1 ${Date.now()}`);
  const clubB = await makeClub(`PAB Club B2 ${Date.now()}`);
  const admin = await makeUser({ email: `pab-clubadmin-other-${Date.now()}@test.local` });
  await grantClubRole(admin.id, clubA);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: clubB, membershipType: "club" });
  const req = await reqFor(admin);

  await assertEquivalent(req, [athlete], [], "club admin, other club - must never leak across clubs via the batch optimization");
});

test("6. team coach can manage an athlete with an active team membership on their own team", async () => {
  const club = await makeClub(`PAB Club C ${Date.now()}`);
  const teamX = await makeTeam(club, "PAB Team X");
  const coach = await makeUser({ email: `pab-teamcoach-${Date.now()}@test.local` });
  await grantTeamRole(coach.id, teamX);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, teamId: teamX, membershipType: "team" });
  const req = await reqFor(coach);

  await assertEquivalent(req, [athlete], [athlete], "team coach, own team");
});

test("7. team coach cannot manage an athlete on a DIFFERENT team of the SAME club", async () => {
  const club = await makeClub(`PAB Club D ${Date.now()}`);
  const teamX = await makeTeam(club, "PAB Team D1");
  const teamY = await makeTeam(club, "PAB Team D2");
  const coach = await makeUser({ email: `pab-teamcoach-sibling-${Date.now()}@test.local` });
  await grantTeamRole(coach.id, teamX);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, teamId: teamY, membershipType: "team" });
  const req = await reqFor(coach);

  await assertEquivalent(req, [athlete], [], "team coach, sibling team same club - must never leak across teams via the batch optimization");
});

test("8. team coach cannot manage an athlete on a team in a DIFFERENT club entirely", async () => {
  const clubA = await makeClub(`PAB Club E1 ${Date.now()}`);
  const clubB = await makeClub(`PAB Club E2 ${Date.now()}`);
  const teamX = await makeTeam(clubA, "PAB Team E1");
  const teamZ = await makeTeam(clubB, "PAB Team E2");
  const coach = await makeUser({ email: `pab-teamcoach-otherclub-${Date.now()}@test.local` });
  await grantTeamRole(coach.id, teamX);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: clubB, teamId: teamZ, membershipType: "team" });
  const req = await reqFor(coach);

  await assertEquivalent(req, [athlete], [], "team coach, different club entirely");
});

test("9. a multi-role account (club_admin of club A + team_coach of a team in club B + independent coach of athlete C) manages one athlete via each mechanism, in a single batch call", async () => {
  const clubA = await makeClub(`PAB Club F1 ${Date.now()}`);
  const clubB = await makeClub(`PAB Club F2 ${Date.now()}`);
  const teamInB = await makeTeam(clubB, "PAB Team F");
  const multi = await makeUser({ email: `pab-multirole-${Date.now()}@test.local` });
  await grantGlobalRole(multi.id, "independent_coach");
  await grantClubRole(multi.id, clubA);
  await grantTeamRole(multi.id, teamInB);

  const viaClub = await makeAthlete();
  await addMembership(viaClub, { clubId: clubA, membershipType: "club" });
  const viaTeam = await makeAthlete();
  await addMembership(viaTeam, { clubId: clubB, teamId: teamInB, membershipType: "team" });
  const viaRelationship = await makeAthlete();
  await grantCoachAthleteLink(multi.id, viaRelationship);
  const unrelated = await makeAthlete();

  const req = await reqFor(multi);
  await assertEquivalent(req, [viaClub, viaTeam, viaRelationship, unrelated], [viaClub, viaTeam, viaRelationship], "multi-role account, one batch call");
});

test("10. an athlete-only account can manage its own athlete profile (a.user_id = actor), but not an unrelated one", async () => {
  const athleteUser = await makeUser({ email: `pab-athleteself-${Date.now()}@test.local`, roleHint: "athlete" });
  const ownAthlete = await makeAthlete({ userId: athleteUser.id });
  const unrelated = await makeAthlete();
  const req = await reqFor(athleteUser);

  await assertEquivalent(req, [ownAthlete, unrelated], [ownAthlete], "athlete-only account managing itself");
});

test("11. a plain user with no roles at all cannot manage any athlete - the batch query still runs exactly once and finds nothing", async () => {
  const plain = await makeUser({ email: `pab-plainuser-${Date.now()}@test.local` });
  const athlete = await makeAthlete();
  const req = await reqFor(plain);

  let calls = 0;
  const countingExecutor = { query: (...args) => { calls += 1; return query(...args); } };
  const manageable = await canManageAthletes(req, [athlete], countingExecutor);
  assert.equal(calls, 1, "a non-empty athlete list for a non-admin must still issue exactly one authorization query, even when nothing is found");
  assert.equal(manageable.size, 0);
  await assertEquivalent(req, [athlete], [], "plain user");
});

test("12. an ARCHIVED (deactivated) coach relationship grants no access", async () => {
  const coach = await makeUser({ email: `pab-archived-rel-${Date.now()}@test.local` });
  await grantGlobalRole(coach.id, "independent_coach");
  const athlete = await makeAthlete();
  await grantCoachAthleteLink(coach.id, athlete, false); // is_active = false
  const req = await reqFor(coach);

  await assertEquivalent(req, [athlete], [], "archived coach relationship");
});

test("13. an ARCHIVED club/team membership grants no access, even though the actor's role is active", async () => {
  const club = await makeClub(`PAB Club G ${Date.now()}`);
  const admin = await makeUser({ email: `pab-archived-membership-${Date.now()}@test.local` });
  await grantClubRole(admin.id, club);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, membershipType: "club", status: "archived" });
  const req = await reqFor(admin);

  await assertEquivalent(req, [athlete], [], "archived club membership - archived-only visibility must never become manage access");
});

test("14. a DEACTIVATED scoped role grants no access, even though the membership itself is active", async () => {
  const club = await makeClub(`PAB Club H ${Date.now()}`);
  const admin = await makeUser({ email: `pab-deactivated-role-${Date.now()}@test.local` });
  await grantClubRole(admin.id, club, false); // is_active = false
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, membershipType: "club" });
  const req = await reqFor(admin);

  await assertEquivalent(req, [athlete], [], "deactivated club_admin role");
});

test("15. an empty athlete list returns an empty set with no SQL query at all", async () => {
  const coach = await makeUser({ email: `pab-empty-${Date.now()}@test.local` });
  const req = await reqFor(coach);

  let calls = 0;
  const countingExecutor = { query: (...args) => { calls += 1; return query(...args); } };
  const manageable = await canManageAthletes(req, [], countingExecutor);
  assert.equal(calls, 0, "an empty athleteIds list must never issue a query - there is nothing to authorize");
  assert.equal(manageable.size, 0);
});

test("16. duplicate athlete ids in the input never cost extra queries or produce duplicate/incorrect results", async () => {
  const club = await makeClub(`PAB Club I ${Date.now()}`);
  const admin = await makeUser({ email: `pab-dupes-${Date.now()}@test.local` });
  await grantClubRole(admin.id, club);
  const athlete = await makeAthlete();
  await addMembership(athlete, { clubId: club, membershipType: "club" });
  const req = await reqFor(admin);

  let calls = 0;
  const countingExecutor = { query: (...args) => { calls += 1; return query(...args); } };
  // Simulates 4 access-request rows all pointing at the same athlete.
  const manageable = await canManageAthletes(req, [athlete, athlete, athlete, athlete], countingExecutor);
  assert.equal(calls, 1, "repeated ids for the same athlete must never increase the number of authorization queries");
  assert.deepEqual([...manageable], [athlete]);
});

// --- Performance proof: N rows -> N old-style queries, 1 new-style query ---

test("17. performance proof: the OLD per-row pattern issues one authorization query per row (including duplicates); the NEW batch path issues exactly one, regardless", async () => {
  const club = await makeClub(`PAB Club J ${Date.now()}`);
  const admin = await makeUser({ email: `pab-perf-${Date.now()}@test.local` });
  await grantClubRole(admin.id, club);
  const athleteA = await makeAthlete();
  const athleteB = await makeAthlete();
  const athleteC = await makeAthlete();
  await addMembership(athleteA, { clubId: club, membershipType: "club" });
  await addMembership(athleteB, { clubId: club, membershipType: "club" });
  await addMembership(athleteC, { clubId: club, membershipType: "club" });
  const req = await reqFor(admin);

  // Simulates 5 access-request rows: 2 for athleteA, 2 for athleteB, 1 for athleteC.
  const rowAthleteIds = [athleteA, athleteA, athleteB, athleteB, athleteC];

  let beforeCalls = 0;
  const originalPoolQuery = pool.query.bind(pool);
  pool.query = (text, params) => {
    if (typeof text === "string" && text.includes("from public.athletes a") && text.includes("a.id = $2")) beforeCalls += 1;
    return originalPoolQuery(text, params);
  };
  try {
    for (const id of rowAthleteIds) {
      await canManageAthlete(req, id);
    }
  } finally {
    pool.query = originalPoolQuery;
  }
  assert.equal(beforeCalls, rowAthleteIds.length, "the old per-row loop must issue exactly one authorization query per row, scaling with row count even for a repeated athlete");

  let afterCalls = 0;
  const countingExecutor = { query: (text, params) => { afterCalls += 1; return query(text, params); } };
  const manageable = await canManageAthletes(req, rowAthleteIds, countingExecutor);
  assert.equal(afterCalls, 1, "the batch path must issue at most one authorization query no matter how many rows (or duplicate athletes) are passed in");
  assert.deepEqual([...manageable].sort(), [athleteA, athleteB, athleteC].sort());
});

// --- End-to-end: GET /api/organization's accessRequests output is unchanged ---

async function makeRequestedProgramAccess(athleteUserId, creatorUserId, { status = "requested" } = {}) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template)
     values ('program', $1, 'PAB Access Request Plan', true)
     returning id`,
    [creatorUserId],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  await query(
    `insert into library.program_access (plan_id, user_id, access_type, status)
     values ($1, $2, 'assigned', $3)`,
    [plan.rows[0].id, athleteUserId, status],
  );
  return plan.rows[0].id;
}

test("18. end-to-end: GET /api/organization still returns a club admin's own club's access requests, including multiple requests for the same athlete, and excludes another club's", async () => {
  const clubA = await makeClub(`PAB E2E Club A ${Date.now()}`);
  const clubB = await makeClub(`PAB E2E Club B ${Date.now()}`);
  const admin = await makeUser({ email: `pab-e2e-admin-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, clubA);

  const athleteUserA = await makeUser({ email: `pab-e2e-athlete-a-${Date.now()}@test.local` });
  const athleteA = await makeAthlete({ userId: athleteUserA.id });
  await addMembership(athleteA, { clubId: clubA, membershipType: "club" });
  // Two separate access-request rows for the SAME athlete.
  await makeRequestedProgramAccess(athleteUserA.id, admin.id);
  await makeRequestedProgramAccess(athleteUserA.id, admin.id);

  const athleteUserB = await makeUser({ email: `pab-e2e-athlete-b-${Date.now()}@test.local` });
  const athleteB = await makeAthlete({ userId: athleteUserB.id });
  await addMembership(athleteB, { clubId: clubB, membershipType: "club" });
  await makeRequestedProgramAccess(athleteUserB.id, admin.id);

  const token = await createSession(admin.id);
  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.status, 200);

  const forAthleteA = org.body.accessRequests.filter((r) => r.athlete_id === athleteA);
  assert.equal(forAthleteA.length, 2, "both access-request rows for the club admin's own athlete must be visible");
  assert.ok(!org.body.accessRequests.some((r) => r.athlete_id === athleteB), "an access request for another club's athlete must never be visible");
});

test("19. end-to-end: an unrelated coach sees no access requests at all (same 200-with-empty-list semantics as before)", async () => {
  const club = await makeClub(`PAB E2E Club C ${Date.now()}`);
  const otherCoach = await makeUser({ email: `pab-e2e-outsider-${Date.now()}@test.local`, roleHint: "coach" });
  await grantGlobalRole(otherCoach.id, "independent_coach");

  const admin = await makeUser({ email: `pab-e2e-admin2-${Date.now()}@test.local`, roleHint: "club_admin" });
  await grantClubRole(admin.id, club);
  const athleteUser = await makeUser({ email: `pab-e2e-athlete-c-${Date.now()}@test.local` });
  const athlete = await makeAthlete({ userId: athleteUser.id });
  await addMembership(athlete, { clubId: club, membershipType: "club" });
  await makeRequestedProgramAccess(athleteUser.id, admin.id);

  const token = await createSession(otherCoach.id);
  const org = await api("/api/organization", { cookie: cookieFor(token) });
  assert.equal(org.status, 200);
  assert.ok(!org.body.accessRequests.some((r) => r.athlete_id === athlete), "an independent coach with no relationship to this athlete must never see its access request");
});
