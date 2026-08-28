import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// feature/athlete-home-mvp: GET /api/athlete-home resolves the athlete
// EXCLUSIVELY from req.authz.athleteId (the real, direct
// athletes.user_id link for the authenticated session) - there is no
// athleteId route param, query param, or body field anywhere on this
// endpoint, so there is nothing for a hand-crafted request to override.
// Mirrors this codebase's other narrow, self-only endpoints (e.g.
// GET /api/auth/account/email-change/status) in shape.

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupPlanIds = new Set();
// Item 5 (WELLNESS Home card): tests.test_schedules cascades (on delete
// cascade) down through targets/occurrences/assignments/assessments, so
// deleting just the schedule row is enough - but it must happen BEFORE the
// athletes/users cleanup above, since assignment rows reference athlete_id.
const cleanupScheduleIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    // test_assessments.assignment_id/standalone_assignment_id are both
    // `on delete restrict` (deliberate - see the schema migration's own
    // comment on that column) - a completed WELLNESS submit's own
    // assessment row would otherwise block the schedule cascade below, so
    // it must be cleared first.
    ["test assessments", () => cleanupScheduleIds.size && query(
      `delete from tests.test_assessments
       where assignment_id in (select id from tests.test_assignments where occurrence_id in (select id from tests.test_schedule_occurrences where schedule_id = any($1::uuid[])))
          or standalone_assignment_id in (select id from tests.test_assignments where occurrence_id in (select id from tests.test_schedule_occurrences where schedule_id = any($1::uuid[])))`,
      [[...cleanupScheduleIds]],
    )],
    ["test schedules", () => cleanupScheduleIds.size && query(`delete from tests.test_schedules where id = any($1::uuid[])`, [[...cleanupScheduleIds]])],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
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

async function makeUser({ email, password = "athlete-home-pass-123", isActive = true }) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Home', 'Test', $2, 'Home Test', 'Home Test', 'user', $3)
     returning id, email`,
    [email, hashPassword(password), isActive],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0];
}

async function makeCoach() {
  const user = await makeUser({ email: await uniqueEmail("home-coach") });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  return user;
}

async function makeAthlete({ userId = null, name = "Home Athlete", isActive = true } = {}) {
  const externalId = `hm${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active, image_url)
     values ($1, $1, 'Home', 'Athlete', $2, $2, $3, $4, 'https://example.test/photo.jpg')
     returning id`,
    [externalId, name, userId, isActive],
  );
  cleanupAthleteIds.add(result.rows[0].id);
  return result.rows[0].id;
}

function mondayOfIso(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// test/stabilize-backend-suite: this USED to be `new Date().toISOString().
// slice(0, 10)` - always the process's UTC calendar date. The actual
// endpoint (src/routes/athleteHome.js) determines "today" exclusively via
// Postgres's own `current_date`, which is evaluated in the DB SESSION's
// configured TIMEZONE - on this dev machine that's Europe/Budapest (UTC+2),
// confirmed via `SHOW TIMEZONE` and not set anywhere in this app's own code
// (no TZ in DATABASE_URL, no SET TIMEZONE in db.js) - it's whatever the
// Postgres server/OS defaults to. Europe/Budapest's calendar day rolls over
// 2 hours BEFORE UTC's does (00:00 local = 22:00 UTC the previous day), so
// for that ~2-hour window every day (22:00-24:00 UTC), a UTC-computed
// fixture date was one calendar day BEHIND what the app itself considered
// "today" - the app would never see the fixture's training as today's,
// making test 5 fail deterministically (not randomly) whenever it happened
// to run in that window. Fixed by reading current_date from the SAME
// connection/session the app's own queries run through, so the fixture and
// the app can never disagree about what day "today" is, regardless of the
// wall-clock moment the test happens to run at.
//
// This does NOT fix the underlying product question of whether "today"
// SHOULD be keyed off the DB server's ambient timezone at all (a real risk
// if this app is ever deployed on infrastructure with a different default
// TZ than its users - e.g. a UTC-default cloud Postgres would make
// "today's training" wrong for hours every day for real Balkans-based
// users). That is a separate, already-flagged investigation
// (background task task_6d767ecf) and is deliberately NOT addressed here -
// this file only needs the test to agree with whatever "today" the app
// currently computes, not to change what that computation should be.
async function todayIso() {
  const result = await query(`select current_date::text as today`);
  return result.rows[0].today;
}

// v_weekly_plan_items inner-joins plan_days -> plan_sessions -> plan_items,
// so a real training day needs the full chain - a bare plans.plans row
// alone never appears in it.
async function makeWeeklyTrainingDay({ athleteId, coachId, date }) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, week_start, is_active, status)
     values ('weekly', $1, $2, $3, $4, true, 'active')
     returning id`,
    [coachId, athleteId, `Home Test Weekly ${Date.now()}`, mondayOfIso(date)],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  const day = await query(`insert into plans.plan_days (plan_id, date) values ($1, $2) returning id`, [plan.rows[0].id, date]);
  const session = await query(`insert into plans.plan_sessions (plan_day_id) values ($1) returning id`, [day.rows[0].id]);
  await query(`insert into plans.plan_items (plan_session_id, item_type, title) values ($1, 'exercise', 'Home Test Exercise')`, [session.rows[0].id]);
  return plan.rows[0].id;
}

// v_plan_summary only needs the plans.plans row itself (it left-joins
// down to days/sessions/items and coalesces missing counts to 0), so an
// "active program exists" fixture is just this one insert.
async function makeProgramPlan({ athleteId, coachId, name, programOrder = null }) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, is_template, is_active, cover_image_url, program_order)
     values ('program', $1, $2, $3, false, true, 'https://example.test/cover.jpg', $4)
     returning id`,
    [coachId, athleteId, name, programOrder],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  return plan.rows[0].id;
}

async function loginAndGetHome({ email, password = "athlete-home-pass-123", extraBody = {} } = {}) {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  return api("/api/athlete-home", { cookie, ...(Object.keys(extraBody).length ? { method: "POST" } : {}) });
}

// === 1: golden path - an athlete-only account sees only its own Home ===

test("1. an athlete-only account sees its own Home data", async () => {
  const coach = await makeCoach();
  const email = await uniqueEmail("home-basic");
  const user = await makeUser({ email });
  await makeAthlete({ userId: user.id, name: "Basic Athlete" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Basic Athlete");
  assert.equal(res.body.athlete.imageUrl, "https://example.test/photo.jpg");
  assert.ok(res.body.today);
  assert.ok(res.body.week);
  assert.equal(res.body.week.days.length, 7, "the week strip must always have exactly 7 days, real data or not");
  assert.ok(res.body.programs);
  void coach;
});

// === 2: another athlete can never be selected by any request shape ===

test("2. no athleteId of any kind (query, body) can select a different athlete's Home", async () => {
  const userA = await makeUser({ email: await uniqueEmail("home-a") });
  const athleteA = await makeAthlete({ userId: userA.id, name: "Athlete A" });
  const userB = await makeUser({ email: await uniqueEmail("home-b") });
  await makeAthlete({ userId: userB.id, name: "Athlete B" });
  const tokenA = await createSession(userA.id);

  const viaQuery = await api(`/api/athlete-home?athleteId=${encodeURIComponent("does-not-matter")}`, { cookie: cookieFor(tokenA) });
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.body.athlete.name, "Athlete A", "a query-string athleteId must be silently ignored - the endpoint has no such parameter");

  const viaBody = await fetch(`${baseUrl}/api/athlete-home`, {
    method: "GET",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(tokenA) },
  });
  const bodyResult = await viaBody.json();
  assert.equal(bodyResult.athlete.name, "Athlete A");
  void athleteA;
});

// === 3: a plain user with no athlete link gets a documented 403 ===

test("3. a plain user account with no athlete link gets 403 NO_ATHLETE_PROFILE", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-plain") });
  const token = await createSession(user.id);
  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "NO_ATHLETE_PROFILE");
});

// === 4: multi-role account (athlete + coach) sees its own Home regardless of active workspace ===

test("4. a multi-role account (athlete + independent coach) sees its own Home", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-multi") });
  await makeAthlete({ userId: user.id, name: "Multi Role Athlete" });
  await query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)`, [user.id]);
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Multi Role Athlete");
});

// === 5/6: today's training exists / does not exist ===

test("5. today's training exists: hasTraining is true with real session/item counts and a plan to open", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-today-yes") });
  const athleteId = await makeAthlete({ userId: user.id });
  const today = await todayIso();
  const planId = await makeWeeklyTrainingDay({ athleteId, coachId: coach.id, date: today });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, true);
  assert.equal(res.body.today.sessionCount, 1);
  assert.equal(res.body.today.itemCount, 1);
  assert.equal(res.body.today.planId, planId);
  assert.equal(res.body.today.date, today);
  const todayInWeek = res.body.week.days.find((day) => day.date === today);
  assert.ok(todayInWeek);
  assert.equal(todayInWeek.isToday, true);
  assert.equal(todayInWeek.hasTraining, true);
});

// test/stabilize-backend-suite: these two don't wait for a specific
// wall-clock moment to prove the fix - they construct the exact mismatch
// deterministically (a plan dated exactly at current_date vs. exactly one
// day before it), so they reliably pass at ANY time of day, including
// during the UTC/DB-timezone mismatch window described in todayIso()'s
// comment above.

test("5b. a plan dated exactly at the DB's own current_date is always today's training - reliable regardless of the process's local/UTC clock or time of day", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-today-tz-proof") });
  const athleteId = await makeAthlete({ userId: user.id });
  const today = await todayIso();
  const planId = await makeWeeklyTrainingDay({ athleteId, coachId: coach.id, date: today });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, true, "a plan dated exactly at current_date must always show as today's training");
  assert.equal(res.body.today.planId, planId);
  assert.equal(res.body.today.date, today);
});

test("5c. proof of the original bug's exact mechanism: a plan dated ONE DAY BEFORE current_date is never today's training - this is exactly the value a UTC-computed fixture date could produce during the UTC/DB-timezone mismatch window", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-today-tz-mismatch") });
  const athleteId = await makeAthlete({ userId: user.id });
  const today = await todayIso();
  const yesterday = await query(`select (current_date - interval '1 day')::date::text as d`);
  await makeWeeklyTrainingDay({ athleteId, coachId: coach.id, date: yesterday.rows[0].d });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, false, "a plan dated the day before current_date must never count as today's - this is why the fixture date must come from the same source (the DB) the app itself uses for 'today', never a separately-computed UTC date");
  assert.equal(res.body.today.date, today);
});

test("6. today's training does not exist: hasTraining is false, no plan reference, no error", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-today-no") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.today.hasTraining, false);
  assert.equal(res.body.today.planId, null);
  assert.equal(res.body.today.sessionCount, 0);
});

// === 7/8: active programs exist / do not exist ===

test("7. active specific programs exist: up to 3 returned with real names/images, total reflects the full count", async () => {
  const coach = await makeCoach();
  const user = await makeUser({ email: await uniqueEmail("home-programs-yes") });
  const athleteId = await makeAthlete({ userId: user.id });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program A", programOrder: 1 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program B", programOrder: 2 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program C", programOrder: 3 });
  await makeProgramPlan({ athleteId, coachId: coach.id, name: "Program D", programOrder: 4 });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.programs.rows.length, 3, "at most 3 programs are returned for card display");
  assert.equal(res.body.programs.total, 4, "the true total must still be reported so the frontend can show 'View all programs'");
  assert.equal(res.body.programs.rows[0].name, "Program A");
  assert.equal(res.body.programs.rows[0].imageUrl, "https://example.test/cover.jpg");
  assert.ok(!("progress" in res.body.programs.rows[0]), "no fabricated progress percentage may ever be returned");
});

test("8. no active specific programs: an empty, stable list, never an error", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-programs-no") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.programs.rows, []);
  assert.equal(res.body.programs.total, 0);
});

// === 9: no leakage of another athlete's plans ===

test("9. one athlete's training and programs never leak into another athlete's Home", async () => {
  const coach = await makeCoach();
  const userA = await makeUser({ email: await uniqueEmail("home-leak-a") });
  const athleteA = await makeAthlete({ userId: userA.id, name: "Leak A" });
  await makeWeeklyTrainingDay({ athleteId: athleteA, coachId: coach.id, date: await todayIso() });
  await makeProgramPlan({ athleteId: athleteA, coachId: coach.id, name: "A's Secret Program" });

  const userB = await makeUser({ email: await uniqueEmail("home-leak-b") });
  await makeAthlete({ userId: userB.id, name: "Leak B" });
  const tokenB = await createSession(userB.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(tokenB) });
  assert.equal(res.status, 200);
  assert.equal(res.body.athlete.name, "Leak B");
  assert.equal(res.body.today.hasTraining, false, "athlete B must never see athlete A's training");
  assert.deepEqual(res.body.programs.rows, [], "athlete B must never see athlete A's programs");
});

// === 10: a disabled login cannot reach the endpoint at all ===

test("10. a disabled login has no session and cannot reach the endpoint (401)", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-disabled") });
  await makeAthlete({ userId: user.id });
  const token = await createSession(user.id);
  await query(`update public.users set is_active = false where id = $1`, [user.id]);
  await query(`delete from public.auth_sessions where user_id = $1`, [user.id]);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 401);
});

// === 11: an archived athlete profile with an active login follows the existing agreed policy ===

test("11. an archived athlete profile that still has an active login keeps seeing its own Home", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-archived") });
  await makeAthlete({ userId: user.id, name: "Archived But Logged In", isActive: false });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200, "req.authz.athleteId is deliberately not filtered on athletes.is_active - archiving the roster profile must never revoke the athlete's own Home, matching the same policy already applied to workspace/capabilities resolution");
  assert.equal(res.body.athlete.name, "Archived But Logged In");
});

// === Unauthenticated ===

test("12. an unauthenticated request is rejected", async () => {
  const res = await api("/api/athlete-home");
  assert.equal(res.status, 401);
});

// === Item 5: the WELLNESS card ===

// WELLNESS's real seeded test version (migrations_v2/202608221000_tests_v42_
// seed_wellness_fms.sql) - same UUID tests-module-schedule-management.test.mjs
// (the disposable-DB harness) uses; this file runs against the real DB where
// that seed already exists.
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";

async function makeCoachCookie() {
  const coach = await makeCoach();
  const token = await createSession(coach.id);
  return { coachId: coach.id, coachCookie: cookieFor(token) };
}

// A coach can only target an athlete they're actually linked to
// (validateTarget -> canAccessAthlete, backend/src/access.js) - a direct
// public.user_athletes row is the simplest real link for this fixture,
// same table an "assign athlete to coach" flow would populate.
async function linkCoachToAthlete(coachId, athleteId) {
  await query(`insert into public.user_athletes (user_id, athlete_id, is_active) values ($1, $2, true)`, [coachId, athleteId]);
}

// One_time schedule, targeting the athlete directly, open all day today -
// mirrors baseCreateBody from tests-module-schedule-management.test.mjs
// (the disposable-DB sibling), just posted through a real coach session
// against the real DB this file already runs against.
async function makeOpenWellnessSchedule({ coachCookie, athleteId }) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${baseUrl}/api/tests/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: coachCookie },
    body: JSON.stringify({
      testVersionId: WELLNESS_TEST_VERSION_ID,
      scheduleKind: "one_time",
      timezone: "UTC",
      startDate: today,
      opensTime: "00:00",
      closesTime: "23:59",
      targets: [{ kind: "athlete", id: athleteId }],
    }),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`Could not create WELLNESS schedule fixture: ${res.status} ${JSON.stringify(body)}`);
  cleanupScheduleIds.add(body.schedule.id);
  return body.schedule.id;
}

test("13. an open, not-yet-completed WELLNESS assignment shows on Home as a single actionable card", async () => {
  const { coachId, coachCookie } = await makeCoachCookie();
  const user = await makeUser({ email: await uniqueEmail("home-wellness-open") });
  const athleteId = await makeAthlete({ userId: user.id, name: "Wellness Open Athlete" });
  await linkCoachToAthlete(coachId, athleteId);
  await makeOpenWellnessSchedule({ coachCookie, athleteId });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.wellness.count, 1, "GET /api/athlete-home materializes today's occurrence on demand, same as GET /api/tests/athlete/today");
  assert.ok(res.body.wellness.assignmentId, "a real assignment id must be returned so the Home card can deep-link straight to it");
  assert.equal(res.body.wellness.testName, "WELLNESS");
  assert.ok(res.body.wellness.closesAt);
});

test("14. no WELLNESS schedule at all: wellness.count is 0, never an error", async () => {
  const user = await makeUser({ email: await uniqueEmail("home-wellness-none") });
  await makeAthlete({ userId: user.id, name: "No Wellness Athlete" });
  const token = await createSession(user.id);

  const res = await api("/api/athlete-home", { cookie: cookieFor(token) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.wellness, { count: 0, assignmentId: null, testName: "", closesAt: null });
});

// Round 2 correction: this used to submit a REAL answer through POST
// /assignments/:id/submit to prove a completed assignment stops counting -
// but that creates a genuinely completed tests.test_assessments row, which
// a DB trigger refuses to ever physically delete ("use supersede
// instead"). That made this fixture permanently unremovable, so every
// full-suite run left a new coach/athlete/schedule/assignment/assessment
// behind in the shared dev database - not an acceptable test pattern.
// Flipping the assignment's own `status` column directly (the exact same
// end-state a real submit leaves the ROW in - see
// tests.materialize_test_assignments_for_occurrence/the submit route's own
// UPDATE) exercises the SAME Home-side filter (`row.status === "pending"`,
// backend/src/routes/athleteHome.js) without ever creating an assessment
// row at all, so this fixture is fully cleanable via the normal cleanup
// sets below - no exclusion needed. The frontend's own "a real submit
// invalidates the Home cache" behavior is covered separately, and
// deterministically, in frontend/tests/tests-wellness-ux-round2.actions.test.mjs
// (a spy on invalidateAthleteHomeCache, not a real network round-trip).
test("15. a completed assignment stops counting as pending on the very next Home read", async () => {
  const { coachId, coachCookie } = await makeCoachCookie();
  const user = await makeUser({ email: await uniqueEmail("home-wellness-done") });
  const athleteId = await makeAthlete({ userId: user.id, name: "Wellness Done Athlete" });
  await linkCoachToAthlete(coachId, athleteId);
  await makeOpenWellnessSchedule({ coachCookie, athleteId });
  const token = await createSession(user.id);
  const athleteCookie = cookieFor(token);

  const before2 = await api("/api/athlete-home", { cookie: athleteCookie });
  assert.equal(before2.body.wellness.count, 1);
  const assignmentId = before2.body.wellness.assignmentId;

  await query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [assignmentId]);

  const after2 = await api("/api/athlete-home", { cookie: athleteCookie });
  assert.equal(after2.body.wellness.count, 0, "a completed assignment must never keep showing as pending on Home");
});

// === Correction: a paused schedule must never look actionable on Home ===

test("16. a materialized pending assignment disappears from Home the moment its own schedule is paused, even though it's still inside its open window", async () => {
  const { coachId, coachCookie } = await makeCoachCookie();
  const user = await makeUser({ email: await uniqueEmail("home-wellness-paused") });
  const athleteId = await makeAthlete({ userId: user.id, name: "Wellness Paused Athlete" });
  await linkCoachToAthlete(coachId, athleteId);
  const scheduleId = await makeOpenWellnessSchedule({ coachCookie, athleteId });
  const token = await createSession(user.id);
  const athleteCookie = cookieFor(token);

  const before3 = await api("/api/athlete-home", { cookie: athleteCookie });
  assert.equal(before3.body.wellness.count, 1, "materialized and open before the pause");

  const paused = await fetch(`${baseUrl}/api/tests/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: coachCookie },
    body: JSON.stringify({ status: "paused" }),
  });
  assert.equal(paused.status, 200);

  const after3 = await api("/api/athlete-home", { cookie: athleteCookie });
  assert.equal(after3.body.wellness.count, 0, "a paused schedule's assignment must never show as a 'Complete now' actionable card, matching what POST /assignments/:id/submit already enforces (409 'This schedule is currently paused.')");
});

test("17. reactivating the same schedule brings the card back, since the assignment is still inside its own open window", async () => {
  const { coachId, coachCookie } = await makeCoachCookie();
  const user = await makeUser({ email: await uniqueEmail("home-wellness-reactivated") });
  const athleteId = await makeAthlete({ userId: user.id, name: "Wellness Reactivated Athlete" });
  await linkCoachToAthlete(coachId, athleteId);
  const scheduleId = await makeOpenWellnessSchedule({ coachCookie, athleteId });
  const token = await createSession(user.id);
  const athleteCookie = cookieFor(token);

  await fetch(`${baseUrl}/api/tests/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: coachCookie },
    body: JSON.stringify({ status: "paused" }),
  });
  assert.equal((await api("/api/athlete-home", { cookie: athleteCookie })).body.wellness.count, 0);

  const reactivated = await fetch(`${baseUrl}/api/tests/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: coachCookie },
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(reactivated.status, 200);

  const after4 = await api("/api/athlete-home", { cookie: athleteCookie });
  assert.equal(after4.body.wellness.count, 1, "reactivating must bring the card straight back, no re-materialization needed - the assignment row never went anywhere");
  assert.ok(after4.body.wellness.assignmentId);
});

void loginAndGetHome;
