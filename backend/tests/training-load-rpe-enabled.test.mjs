// Per-session RPE opt-out (migrations_v2/202609010900_training_load_v3_
// rpe_enabled.sql) - real end-to-end coverage of Builder's own PATCH
// partial-update behavior and copy-path propagation, which both need the
// FULL real base schema (plans.plans/plan_days/plan_sessions carry dozens
// of columns builder.js's buildDraft()/respondWithDraft() actually read) -
// reproducing that in a from-scratch fixture would be its own large,
// fragile undertaking. Same established pattern as backend/tests/
// training-load-builder-edit-draft.test.mjs: runs against the real local
// OPTIMOVE database, every created row tracked and deleted in after().
//
// Runtime ENFORCEMENT (POST /rpe returning 409 for a disabled session, the
// weekly/today filter, the Training Load quick-toggle route) lands in a
// later round and is tested in backend/tests/training-load.test.mjs's own
// disposable-DB harness at that point - this file is scoped to Builder's
// side of the feature: does the setting persist correctly through every
// real copy/edit-draft mechanism.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupClubIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["plan trees", () => cleanupPlanIds.size && query(`delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[]) or edit_source_plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athlete_memberships", () => cleanupAthleteIds.size && query(`delete from public.athlete_memberships where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["user_club_roles", () => cleanupUserIds.size && query(`delete from public.user_club_roles where user_id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["clubs", () => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]])],
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

const STAMP = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeCoachWithClub() {
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`TL rpe-enabled club ${STAMP()}`]);
  const clubId = clubResult.rows[0].id;
  cleanupClubIds.add(clubId);
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Coach', $2, 'TL Coach', 'TL Coach', 'club_admin', true) returning id`,
    [`tl-rpeenabled-coach-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const coachId = userResult.rows[0].id;
  cleanupUserIds.add(coachId);
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coachId, clubId]);
  const token = await createSession(coachId);
  return { coachId, clubId, cookie: `optimove_session=${token}` };
}

async function makeAthleteInClub(clubId) {
  const externalId = `tlrpe${Math.floor(Math.random() * 900000 + 100000)}`;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Athlete', $2, 'TL Athlete', 'TL Athlete', 'athlete', true) returning id`,
    [`tl-rpeenabled-athlete-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const userId = userResult.rows[0].id;
  cleanupUserIds.add(userId);
  const athleteResult = await query(
    `insert into public.athletes (user_id, athlete_id, source_external_id, first_name, last_name, full_name, display_name, device_timezone, is_active)
     values ($1,$2,$2,'TL','Athlete','TL Athlete','TL Athlete','UTC',true) returning id`,
    [userId, externalId],
  );
  const athleteId = athleteResult.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  const token = await createSession(userId);
  return { athleteId, externalId, cookie: `optimove_session=${token}` };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
const TODAY_DATE = new Date();
TODAY_DATE.setUTCHours(0, 0, 0, 0);
const TODAY = isoDate(TODAY_DATE);
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}
const WEEK_START = mondayOf(TODAY);
function dayOrderForDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const raw = d.getUTCDay();
  return raw === 0 ? 7 : raw;
}
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

async function makeRealWeeklyPlan(coachId, athleteId, overrides = {}) {
  const planResult = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL rpe-enabled regression plan', 'active', 'builder', 'private', $3)
     returning id`,
    [coachId, athleteId, overrides.weekStart || WEEK_START],
  );
  const planId = planResult.rows[0].id;
  cleanupPlanIds.add(planId);
  return planId;
}
async function makeRealDay(planId, date, dayOrder) {
  const dayResult = await query(
    `insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,$3::numeric,$3::integer) returning id`,
    [planId, date, dayOrder],
  );
  return dayResult.rows[0].id;
}
async function makeRealSession(dayId, name, amPm = null, sessionOrder = 0, rpeEnabled = true) {
  const sessionResult = await query(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, session_order, rpe_enabled) values ($1,$2,$3,$4,$5) returning id`,
    [dayId, name, amPm, sessionOrder, rpeEnabled],
  );
  return sessionResult.rows[0].id;
}
async function sessionRpeEnabled(sessionId) {
  const result = await query(`select rpe_enabled from plans.plan_sessions where id = $1`, [sessionId]);
  return result.rows[0]?.rpe_enabled;
}

// ------------------------------------------------------------
// A. Builder PATCH /sessions/:sessionId - partial-update parity with
// amPm/bta (only touched when the request body actually includes the key).
// ------------------------------------------------------------

test("A1. PATCH with rpeEnabled: false persists false", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const planId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const dayId = await makeRealDay(planId, TODAY, dayOrderForDate(TODAY));
  const sessionId = await makeRealSession(dayId, "Mobility session", "AM");

  const res = await api(`/api/builder/sessions/${sessionId}`, { method: "PATCH", cookie: coach.cookie, body: { rpeEnabled: false } });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await sessionRpeEnabled(sessionId), false);
});

test("A2. PATCH with no rpeEnabled key leaves the existing value untouched - a partial update never silently re-enables/disables it", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const planId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const dayId = await makeRealDay(planId, TODAY, dayOrderForDate(TODAY));
  const sessionId = await makeRealSession(dayId, "Mobility session", "AM", 0, false);

  const res = await api(`/api/builder/sessions/${sessionId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Renamed" } });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(await sessionRpeEnabled(sessionId), false, "a PATCH that never mentions rpeEnabled must never flip it back to true");
});

test("A3. PATCH with rpeEnabled: true re-enables a previously disabled session", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const planId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const dayId = await makeRealDay(planId, TODAY, dayOrderForDate(TODAY));
  const sessionId = await makeRealSession(dayId, "Mobility session", "AM", 0, false);

  const res = await api(`/api/builder/sessions/${sessionId}`, { method: "PATCH", cookie: coach.cookie, body: { rpeEnabled: true } });
  assert.equal(res.status, 200);
  assert.equal(await sessionRpeEnabled(sessionId), true);
});

// ------------------------------------------------------------
// B. Copy-path propagation - rpe_enabled is a CONTENT property, always
// copied unconditionally, unlike logical_session_id (identity, only
// preserved on the live<->edit-draft round trip).
// ------------------------------------------------------------

test("B1. the live -> edit-draft -> live round trip (POST /plans/:planId/edit then /submit) preserves rpe_enabled = false the whole way through", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const livePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const dayId = await makeRealDay(livePlanId, TODAY, dayOrderForDate(TODAY));
  await makeRealSession(dayId, "Recovery session", "AM", 0, false);

  const editRes = await api(`/api/builder/plans/${livePlanId}/edit`, { method: "POST", cookie: coach.cookie });
  assert.equal(editRes.status, 200, `expected the edit-draft to open, got ${editRes.status}: ${JSON.stringify(editRes.body)}`);
  const draftPlanId = editRes.body.plan.id;
  cleanupPlanIds.add(draftPlanId);

  const draftSessionResult = await query(
    `select ps.id, ps.rpe_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`,
    [draftPlanId],
  );
  assert.equal(draftSessionResult.rows[0].rpe_enabled, false, "the live->draft copy (POST /plans/:planId/edit) must carry rpe_enabled forward");

  const submitDraftRes = await api(`/api/builder/plans/${draftPlanId}/submit`, { method: "POST", cookie: coach.cookie });
  assert.equal(submitDraftRes.status, 200, `expected the edit-draft to apply back onto the live plan, got ${submitDraftRes.status}: ${JSON.stringify(submitDraftRes.body)}`);

  const recreatedResult = await query(
    `select ps.rpe_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and pd.date = $2`,
    [livePlanId, TODAY],
  );
  assert.equal(recreatedResult.rows[0].rpe_enabled, false, "the draft->live copy (applyEditDraft) must carry rpe_enabled forward, not silently re-enable it");
});

test("B2. duplicating a weekly plan to a NEW athlete (POST /plans/:planId/duplicate) copies rpe_enabled from the source session", async () => {
  const coach = await makeCoachWithClub();
  const sourceAthlete = await makeAthleteInClub(coach.clubId);
  const targetAthlete = await makeAthleteInClub(coach.clubId);
  const sourcePlanId = await makeRealWeeklyPlan(coach.coachId, sourceAthlete.athleteId);
  const dayId = await makeRealDay(sourcePlanId, WEEK_START, 1);
  await makeRealSession(dayId, "Recovery session", "AM", 0, false);

  const nextWeekStart = addDaysIso(WEEK_START, 7);
  const dupRes = await api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
    method: "POST",
    cookie: coach.cookie,
    body: { athleteIds: [targetAthlete.externalId], weekStart: nextWeekStart },
  });
  assert.equal(dupRes.status, 201, `expected the duplicate to succeed, got ${dupRes.status}: ${JSON.stringify(dupRes.body)}`);
  const newPlanId = dupRes.body.plan.id;
  cleanupPlanIds.add(newPlanId);

  const newSessionResult = await query(
    `select ps.rpe_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`,
    [newPlanId],
  );
  assert.equal(newSessionResult.rowCount, 1);
  assert.equal(newSessionResult.rows[0].rpe_enabled, false, "duplicating to a new athlete must carry the source session's rpe_enabled setting, not silently reset it to enabled");
});

test("B3. the standalone session-copy endpoint (POST /sessions/:sessionId/copy-into/:targetDayId) copies rpe_enabled from the source session", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const sourcePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const sourceDayId = await makeRealDay(sourcePlanId, TODAY, dayOrderForDate(TODAY));
  const sourceSessionId = await makeRealSession(sourceDayId, "Rehab session", "PM", 0, false);

  const targetPlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId, { weekStart: addDaysIso(WEEK_START, 14) });
  const targetDayId = await makeRealDay(targetPlanId, TODAY, dayOrderForDate(TODAY));

  const copyRes = await api(`/api/builder/sessions/${sourceSessionId}/copy-into/${targetDayId}`, { method: "POST", cookie: coach.cookie });
  assert.equal(copyRes.status, 200, `expected the copy to succeed, got ${copyRes.status}: ${JSON.stringify(copyRes.body)}`);

  const copiedResult = await query(`select rpe_enabled from plans.plan_sessions where plan_day_id = $1`, [targetDayId]);
  assert.equal(copiedResult.rowCount, 1);
  assert.equal(copiedResult.rows[0].rpe_enabled, false, "the standalone session-copy endpoint must carry rpe_enabled forward");
});

test("B4. batch-sync to a DRAFT sibling plan copies rpe_enabled from the source session", async () => {
  const coach = await makeCoachWithClub();
  const athleteA = await makeAthleteInClub(coach.clubId);
  const athleteB = await makeAthleteInClub(coach.clubId);

  const created = await api("/api/builder/plans", { method: "POST", cookie: coach.cookie, body: { planType: "weekly", athleteIds: [athleteA.externalId, athleteB.externalId], weekStart: addDaysIso(WEEK_START, 21) } });
  assert.equal(created.status, 201, `expected batch create to succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
  const batch = await query(`select id, athlete_id from plans.plans where builder_batch_id = (select builder_batch_id from plans.plans where id = $1)`, [created.body.plan.id]);
  for (const row of batch.rows) cleanupPlanIds.add(row.id);
  assert.equal(batch.rowCount, 2, "sanity: a batch of 2 athletes must create 2 plan rows");

  const sourcePlanId = batch.rows.find((r) => String(r.athlete_id) === String(athleteA.athleteId)).id;
  const siblingPlanId = batch.rows.find((r) => String(r.athlete_id) === String(athleteB.athleteId)).id;
  const sourceDay = await query(`select id from plans.plan_days where plan_id = $1 order by day_order limit 1`, [sourcePlanId]);
  await makeRealSession(sourceDay.rows[0].id, "Recovery session", "AM", 0, false);

  const syncRes = await api(`/api/builder/plans/${sourcePlanId}/sync-batch`, { method: "POST", cookie: coach.cookie });
  assert.equal(syncRes.status, 200, `expected sync-batch to succeed, got ${syncRes.status}: ${JSON.stringify(syncRes.body)}`);

  const siblingSessionResult = await query(
    `select ps.rpe_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and ps.name = 'Recovery session'`,
    [siblingPlanId],
  );
  assert.equal(siblingSessionResult.rowCount, 1);
  assert.equal(siblingSessionResult.rows[0].rpe_enabled, false, "batch-sync to a draft sibling must carry rpe_enabled forward, matching every other content property");
});
