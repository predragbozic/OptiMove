// Regression coverage for a crash in copyWeeklyPlanTree (backend/src/routes/
// builder.js) found while investigating a live report of slow "Copy" on
// Specific Programs: copying a weekly plan via POST
// /api/builder/plans/:planId/duplicate could throw a 500
// (plan_days_plan_date_unique violation) instead of creating the copy.
//
// Root cause: createWeeklyDays() pre-creates all 7 of the target plan's day
// rows (day_order = block_index = block_order = 1..7, date = weekStart +
// (day_order - 1)). copyWeeklyPlanTree() then tried to match each SOURCE day
// to one of those 7 by a compound "day_order:block_index" key. Real weekly
// plans always have block_index === day_order (createWeeklyDays is the only
// place that ever sets either), but some existing/imported plans carry a
// block_index that doesn't follow that (null, or something else) - for
// those, the compound key never matched, so the code fell into an "insert a
// new day" branch and computed a date that one of the 7 already-inserted
// placeholder rows already had, crashing the whole copy.
//
// The fix matches by day_order ALONE (normalized/clamped into 1-7), since
// that's the only field that actually means anything for a weekly day's
// position in its week - block_index is redundant with it by construction.
//
// Runs against the real local OPTIMOVE database (same established pattern as
// backend/tests/template-assign-to-athlete.test.mjs), with every created row
// tracked and deleted in after().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

async function grantGlobalRole(userId, role) {
  await query(
    `insert into public.user_global_roles (user_id, role, is_active) values ($1, $2, true)
     on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
    [userId, role],
  );
}

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["plan trees", () => cleanupPlanIds.size && query(
      `delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]],
    )],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["program_access", () => cleanupPlanIds.size && query(`delete from library.program_access where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", cookie, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function makeCoach(label) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'Coach', $2, 'Test Coach', 'Test Coach', 'independent_coach', true)
     returning id`,
    [`weekly-copy-day-order-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await grantGlobalRole(result.rows[0].id, "independent_coach");
  const token = await createSession(result.rows[0].id);
  return { id: result.rows[0].id, cookie: `optimove_session=${token}` };
}

async function makeAthlete(coachUserId) {
  const externalId = `wcdo${Math.floor(Math.random() * 900000 + 100000)}`;
  const result = await query(
    `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, is_active)
     values ($1, $1, 'Test', 'Athlete', 'Test Athlete', 'Test Athlete', true)
     returning id`,
    [externalId],
  );
  const athleteId = result.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(
    `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`,
    [coachUserId, athleteId],
  );
  return { id: athleteId, externalId };
}

// Builds a weekly source plan with exactly the day rows given (each
// {dayOrder, blockIndex, date, title}) - one exercise item per day, under a
// section/session, so the copy actually has content to move.
async function makeWeeklySourcePlan(coachUserId, athleteId, weekStart, days) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'Source week', 'active', 'builder', 'private', $3)
     returning id`,
    [coachUserId, athleteId, weekStart],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);

  for (const day of days) {
    const dayRow = await query(
      `insert into plans.plan_days (plan_id, date, day_order, block_index, block_type)
       values ($1, $2, $3, $4, 'session') returning id`,
      [planId, day.date, day.dayOrder, day.blockIndex ?? null],
    );
    const session = await query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`,
      [dayRow.rows[0].id],
    );
    const section = await query(
      `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Warm-up', 0) returning id`,
      [session.rows[0].id],
    );
    await query(
      `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order)
       values ($1, $2, 'exercise', $3, 0)`,
      [session.rows[0].id, section.rows[0].id, day.title || "Exercise"],
    );
  }
  return planId;
}

test("1. copying a weekly day whose block_index doesn't match its day_order (the exact shape that used to crash) succeeds instead of 500ing", async () => {
  const coach = await makeCoach("crash-repro");
  const sourceAthlete = await makeAthlete(coach.id);
  const targetAthlete = await makeAthlete(coach.id);
  // block_index: null, day_order: 1 (Monday) - matches the real local
  // OPTIMOVE row that reproduced the live crash (day_order="1", block_index
  // null), with a literal `date` that deliberately does NOT fall on a
  // Monday, to also prove the copy is driven by day_order, not the source's
  // stored date.
  const sourcePlanId = await makeWeeklySourcePlan(coach.id, sourceAthlete.id, "2026-01-05", [
    { dayOrder: 1, blockIndex: null, date: "2026-01-09", title: "Monday session" },
  ]);

  const targetWeekStart = "2027-09-06"; // a Monday
  const res = await api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
    method: "POST",
    cookie: coach.cookie,
    body: { athleteId: targetAthlete.externalId, athleteIds: [targetAthlete.externalId], weekStart: targetWeekStart },
  });

  assert.equal(res.status, 201, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  cleanupPlanIds.add(res.body.plan.id);
  const monday = res.body.blocks.find((block) => block.date === targetWeekStart);
  assert.ok(monday, "the copied day must land on the target week's Monday (day_order 1), not wherever the source's stale literal date pointed");
  assert.equal(monday.sessions[0]?.nodes[0]?.items[0]?.title, "Monday session", "the actual content must have been copied onto that day, not lost");
});

test("2. day_order determines which weekday the copy lands on, independent of the source plan's literal stored date", async () => {
  const coach = await makeCoach("weekday-mapping");
  const sourceAthlete = await makeAthlete(coach.id);
  const targetAthlete = await makeAthlete(coach.id);
  // day_order 3 = Wednesday, but the literal source date is deliberately a
  // totally unrelated Sunday far in the past.
  const sourcePlanId = await makeWeeklySourcePlan(coach.id, sourceAthlete.id, "2020-01-01", [
    { dayOrder: 3, blockIndex: 3, date: "2019-06-02", title: "Wednesday session" },
  ]);

  const targetWeekStart = "2028-02-07"; // a Monday
  const res = await api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
    method: "POST",
    cookie: coach.cookie,
    body: { athleteId: targetAthlete.externalId, athleteIds: [targetAthlete.externalId], weekStart: targetWeekStart },
  });

  assert.equal(res.status, 201, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  cleanupPlanIds.add(res.body.plan.id);
  const wednesday = res.body.blocks.find((block) => block.date === "2028-02-09"); // targetWeekStart + 2 days
  assert.ok(wednesday, "day_order=3 must land on the target week's Wednesday");
  assert.equal(wednesday.sessions[0]?.nodes[0]?.items[0]?.title, "Wednesday session");
});

test("3. a normal full week (day_order 1-7, block_index matching, exactly what createWeeklyDays itself produces) still copies every day onto the correct date", async () => {
  const coach = await makeCoach("full-week");
  const sourceAthlete = await makeAthlete(coach.id);
  const targetAthlete = await makeAthlete(coach.id);
  const sourceWeekStart = "2025-03-03"; // a Monday
  const days = [1, 2, 3, 4, 5, 6, 7].map((dayOrder) => ({
    dayOrder,
    blockIndex: dayOrder,
    date: `2025-03-${String(2 + dayOrder).padStart(2, "0")}`,
    title: `Day ${dayOrder}`,
  }));
  const sourcePlanId = await makeWeeklySourcePlan(coach.id, sourceAthlete.id, sourceWeekStart, days);

  const targetWeekStart = "2029-05-14"; // a Monday
  const res = await api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
    method: "POST",
    cookie: coach.cookie,
    body: { athleteId: targetAthlete.externalId, athleteIds: [targetAthlete.externalId], weekStart: targetWeekStart },
  });

  assert.equal(res.status, 201, `expected the copy to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  cleanupPlanIds.add(res.body.plan.id);
  assert.equal(res.body.blocks.length, 7, "all 7 weekday slots must be present, none dropped and none duplicated");
  const datesByTitle = new Map(res.body.blocks.map((block) => [block.sessions[0]?.nodes[0]?.items[0]?.title, block.date]));
  for (let dayOrder = 1; dayOrder <= 7; dayOrder += 1) {
    const expectedDate = new Date(`${targetWeekStart}T12:00:00Z`);
    expectedDate.setUTCDate(expectedDate.getUTCDate() + (dayOrder - 1));
    assert.equal(datesByTitle.get(`Day ${dayOrder}`), expectedDate.toISOString().slice(0, 10), `Day ${dayOrder}'s content must land on the correct weekday of the target week`);
  }
  const uniqueDates = new Set(res.body.blocks.map((block) => block.date));
  assert.equal(uniqueDates.size, 7, "every one of the 7 days must have its own distinct date - no two days collapsed onto the same date");
});
