// Regression coverage for Phase 1 of the Builder day-copy/paste feature:
// POST /api/builder/days/:dayId/copy-into/:targetDayId. Content-only paste
// within one weekly plan - replaces the target day's sessions/nodes/items
// with the source day's, but never touches either day's own date/day_order
// row (a weekly plan always keeps its fixed 7 calendar days).
//
// Runs against the real local OPTIMOVE database (same established pattern as
// backend/tests/template-assign-to-athlete.test.mjs and
// backend/tests/builder-weekly-copy-day-order.test.mjs), with every created
// row tracked and deleted in after().
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
    [`day-copy-paste-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`, hashPassword("irrelevant-password-123")],
  );
  cleanupUserIds.add(result.rows[0].id);
  await grantGlobalRole(result.rows[0].id, "independent_coach");
  const token = await createSession(result.rows[0].id);
  return { id: result.rows[0].id, cookie: `optimove_session=${token}` };
}

async function makeAthlete(coachUserId) {
  const externalId = `dcp${Math.floor(Math.random() * 900000 + 100000)}`;
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

// Builds a weekly plan with the given days (each {dayOrder, title} - title
// null/omitted means an empty day, no session at all). Returns
// {planId, dayIdByOrder}.
async function makeWeeklyPlan(coachUserId, athleteId, weekStart, days) {
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'Day copy test week', 'active', 'builder', 'private', $3)
     returning id`,
    [coachUserId, athleteId, weekStart],
  );
  const planId = plan.rows[0].id;
  cleanupPlanIds.add(planId);

  const dayIdByOrder = new Map();
  for (const day of days) {
    const dayRow = await query(
      `insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type)
       values ($1, $2::date + ($3::integer - 1), $3, $3, $3, 'session') returning id`,
      [planId, weekStart, day.dayOrder],
    );
    const dayId = dayRow.rows[0].id;
    dayIdByOrder.set(day.dayOrder, dayId);
    if (!day.title) continue;
    const session = await query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order) values ($1, 'AM', 'T', 0) returning id`,
      [dayId],
    );
    const section = await query(
      `insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Warm-up', 0) returning id`,
      [session.rows[0].id],
    );
    await query(
      `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order)
       values ($1, $2, 'exercise', $3, 0)`,
      [session.rows[0].id, section.rows[0].id, day.title],
    );
  }
  return { planId, dayIdByOrder };
}

async function dayTitles(dayId) {
  const rows = await query(
    `select pi.title
     from plans.plan_items pi
     join plans.plan_sessions ps on ps.id = pi.plan_session_id
     where ps.plan_day_id = $1
     order by pi.item_order`,
    [dayId],
  );
  return rows.rows.map((row) => row.title);
}

test("1. pasting into an empty day succeeds directly (no confirmation needed) and copies the source day's content", async () => {
  const coach = await makeCoach("empty-target");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-09-07", [
    { dayOrder: 1, title: "Monday exercise" },
    { dayOrder: 4, title: null }, // empty Thursday
  ]);

  const res = await api(`/api/builder/days/${dayIdByOrder.get(1)}/copy-into/${dayIdByOrder.get(4)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 200, `expected the paste to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(await dayTitles(dayIdByOrder.get(4)), ["Monday exercise"]);
});

test("2. pasting into a day that already has content is refused with 409 and leaves that day's content untouched", async () => {
  const coach = await makeCoach("refuse-overwrite");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-09-14", [
    { dayOrder: 1, title: "Monday exercise" },
    { dayOrder: 4, title: "Thursday's own exercise" },
  ]);

  const res = await api(`/api/builder/days/${dayIdByOrder.get(1)}/copy-into/${dayIdByOrder.get(4)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 409, "must be refused, not silently overwrite or merge");
  assert.deepEqual(await dayTitles(dayIdByOrder.get(4)), ["Thursday's own exercise"], "the target day's original content must be completely untouched after a refused paste");
});

test("3. confirmOverwrite: true replaces the target day's content with the source day's", async () => {
  const coach = await makeCoach("confirm-overwrite");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-09-21", [
    { dayOrder: 1, title: "Monday exercise" },
    { dayOrder: 4, title: "Thursday's own exercise" },
  ]);

  const res = await api(`/api/builder/days/${dayIdByOrder.get(1)}/copy-into/${dayIdByOrder.get(4)}`, {
    method: "POST", cookie: coach.cookie, body: { confirmOverwrite: true },
  });

  assert.equal(res.status, 200, `expected the confirmed paste to succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(await dayTitles(dayIdByOrder.get(4)), ["Monday exercise"], "the target's old content must be gone, replaced by the source's");
});

test("4. the target day's own date/day_order row is never touched by a paste - only its content changes", async () => {
  const coach = await makeCoach("date-unchanged");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-09-28", [
    { dayOrder: 1, title: "Monday exercise" },
    { dayOrder: 4, title: null },
  ]);

  const before = await query("select date, day_order, block_index from plans.plan_days where id = $1", [dayIdByOrder.get(4)]);
  await api(`/api/builder/days/${dayIdByOrder.get(1)}/copy-into/${dayIdByOrder.get(4)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });
  const after = await query("select date, day_order, block_index from plans.plan_days where id = $1", [dayIdByOrder.get(4)]);

  assert.deepEqual(after.rows[0], before.rows[0], "a content paste must never change which calendar day this row represents");
});

test("5. pasting between two different plans' days is rejected (Phase 1 is same-plan only - cross-plan is Phase 2's job)", async () => {
  const coach = await makeCoach("cross-plan-rejected");
  const athleteA = await makeAthlete(coach.id);
  const athleteB = await makeAthlete(coach.id);
  const planA = await makeWeeklyPlan(coach.id, athleteA.id, "2026-10-05", [{ dayOrder: 1, title: "Plan A Monday" }]);
  const planB = await makeWeeklyPlan(coach.id, athleteB.id, "2026-10-05", [{ dayOrder: 1, title: null }]);

  const res = await api(`/api/builder/days/${planA.dayIdByOrder.get(1)}/copy-into/${planB.dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await dayTitles(planB.dayIdByOrder.get(1)), []);
});

test("6. pasting a day onto itself is rejected", async () => {
  const coach = await makeCoach("self-paste-rejected");
  const athlete = await makeAthlete(coach.id);
  const { dayIdByOrder } = await makeWeeklyPlan(coach.id, athlete.id, "2026-10-12", [{ dayOrder: 1, title: "Monday exercise" }]);

  const res = await api(`/api/builder/days/${dayIdByOrder.get(1)}/copy-into/${dayIdByOrder.get(1)}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 400);
});

test("7. day paste is refused for a non-weekly (program) plan's blocks", async () => {
  const coach = await makeCoach("program-rejected");
  const plan = await query(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template)
     values ('program', $1, 'Not a weekly plan', 'active', 'builder', 'private', true) returning id`,
    [coach.id],
  );
  cleanupPlanIds.add(plan.rows[0].id);
  const blockA = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_type) values ($1, 1, 1, 'session') returning id`,
    [plan.rows[0].id],
  );
  const blockB = await query(
    `insert into plans.plan_days (plan_id, block_index, block_order, block_type) values ($1, 2, 2, 'session') returning id`,
    [plan.rows[0].id],
  );

  const res = await api(`/api/builder/days/${blockA.rows[0].id}/copy-into/${blockB.rows[0].id}`, {
    method: "POST", cookie: coach.cookie, body: {},
  });

  assert.equal(res.status, 400);
});
