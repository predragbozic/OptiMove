// Training load (RPE/sRPE) correction round: a REAL end-to-end regression
// for the exact scenario that motivated logical_session_id (migrations_v2/
// 202608320900_training_load_v2_logical_session_identity.sql) - an athlete
// submits RPE, the coach opens the SAME Weekly plan through the real
// Builder "Edit" flow and clicks "Save and finish" again (POST /plans/
// :planId/edit then POST /plans/:draftId/submit, which internally calls
// applyEditDraft() - see builder.js), and the already-submitted result
// must survive that real round trip unchanged and undeduplicated.
//
// Deliberately NOT the disposable-DB harness training-load.test.mjs uses -
// plans.plans/plan_days/plan_sessions carry the FULL real base schema
// (dozens of columns with real constraints/defaults) that only exists in
// an actual OPTIMOVE-shaped database; reproducing it in a from-scratch
// fixture would be its own large, fragile undertaking. Runs against the
// real local OPTIMOVE database instead, the exact same established
// pattern as backend/tests/builder-weekly-copy-day-order.test.mjs and
// backend/tests/template-assign-to-athlete.test.mjs - every created row is
// tracked and deleted in after().
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
    ["training_load.session_feedback", () => cleanupAthleteIds.size && query(
      `delete from training_load.session_feedback where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]],
    )],
    ["plan trees (draft + live)", () => cleanupPlanIds.size && query(
      `delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]],
    )],
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
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`TL edit-draft regression club ${STAMP()}`]);
  const clubId = clubResult.rows[0].id;
  cleanupClubIds.add(clubId);
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Coach', $2, 'TL Coach', 'TL Coach', 'club_admin', true) returning id`,
    [`tl-editdraft-coach-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const coachId = userResult.rows[0].id;
  cleanupUserIds.add(coachId);
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coachId, clubId]);
  const token = await createSession(coachId);
  return { coachId, clubId, cookie: `optimove_session=${token}` };
}

async function makeAthleteInClub(clubId) {
  const externalId = `tledit${Math.floor(Math.random() * 900000 + 100000)}`;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Athlete', $2, 'TL Athlete', 'TL Athlete', 'athlete', true) returning id`,
    [`tl-editdraft-athlete-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
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
  return { athleteId, cookie: `optimove_session=${token}` };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
const TODAY_DATE = new Date();
TODAY_DATE.setUTCHours(0, 0, 0, 0);
const TODAY = isoDate(TODAY_DATE);
const YESTERDAY_DATE = new Date(TODAY_DATE);
YESTERDAY_DATE.setUTCDate(YESTERDAY_DATE.getUTCDate() - 1);
const YESTERDAY = isoDate(YESTERDAY_DATE);
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}
const WEEK_START = mondayOf(TODAY);

// A real, minimal weekly plan a coach could have built by hand in the
// Builder - only the columns POST /plans/:id/edit + applyEditDraft's own
// copyWeeklyPlanTree/copyDaySessions actually read.
async function makeRealWeeklyPlan(coachId, athleteId) {
  const planResult = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL edit-draft regression plan', 'active', 'builder', 'private', $3)
     returning id`,
    [coachId, athleteId, WEEK_START],
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
async function makeRealSession(dayId, name, amPm = null, sessionOrder = 0) {
  const sessionResult = await query(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, session_order) values ($1,$2,$3,$4) returning id`,
    [dayId, name, amPm, sessionOrder],
  );
  return sessionResult.rows[0].id;
}

test("a real Builder Edit -> Save and finish round trip preserves an already-submitted RPE result: one result, recognized as rated, never duplicated - and a genuinely new session added afterward is still independently ratable", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);

  const livePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  const dayOrderForDate = (date) => {
    const d = new Date(`${date}T00:00:00Z`);
    const raw = d.getUTCDay();
    return raw === 0 ? 7 : raw;
  };
  const todayDayId = await makeRealDay(livePlanId, TODAY, dayOrderForDate(TODAY));
  const yesterdayDayId = await makeRealDay(livePlanId, YESTERDAY, dayOrderForDate(YESTERDAY));
  const todaySessionId = await makeRealSession(todayDayId, "Today session", "AM");
  const yesterdaySessionId = await makeRealSession(yesterdayDayId, "Yesterday session");

  // 1) The athlete rates BOTH real sessions before any edit happens.
  const submitToday = await api(`/api/training-load/sessions/${todaySessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 7, durationMinutes: 60 } });
  assert.equal(submitToday.status, 201, `expected 201, got ${submitToday.status}: ${JSON.stringify(submitToday.body)}`);
  const submitYesterday = await api(`/api/training-load/sessions/${yesterdaySessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 45 } });
  assert.equal(submitYesterday.status, 201);

  // 2) The coach opens this SAME weekly plan through the real Builder
  // "Edit" flow.
  const editRes = await api(`/api/builder/plans/${livePlanId}/edit`, { method: "POST", cookie: coach.cookie });
  assert.equal(editRes.status, 200, `expected the edit-draft to open, got ${editRes.status}: ${JSON.stringify(editRes.body)}`);
  const draftPlanId = editRes.body.plan.id;
  cleanupPlanIds.add(draftPlanId);
  assert.notEqual(draftPlanId, livePlanId, "the draft is a genuinely different plan row while it's open");

  // 3) ...and clicks "Save and finish" again, with NO actual content
  // change - the exact real-world trigger for applyEditDraft()'s delete-
  // and-recreate of the live plan's entire session tree.
  const submitDraftRes = await api(`/api/builder/plans/${draftPlanId}/submit`, { method: "POST", cookie: coach.cookie });
  assert.equal(submitDraftRes.status, 200, `expected the edit-draft to apply back onto the live plan, got ${submitDraftRes.status}: ${JSON.stringify(submitDraftRes.body)}`);
  assert.equal(submitDraftRes.body.plan.id, livePlanId, "applyEditDraft() re-activates the ORIGINAL live plan id, not a new one");

  // The live plan's sessions now have BRAND NEW row ids (applyEditDraft
  // deleted and recreated them) - re-resolve them by date.
  const newSessionsResult = await query(
    `select ps.id, pd.date from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by pd.date`,
    [livePlanId],
  );
  const newTodaySessionId = newSessionsResult.rows.find((r) => r.date === TODAY)?.id;
  const newYesterdaySessionId = newSessionsResult.rows.find((r) => r.date === YESTERDAY)?.id;
  assert.ok(newTodaySessionId && newYesterdaySessionId, "the recreated sessions exist under the live plan");
  assert.notEqual(newTodaySessionId, todaySessionId, "row ids really did change - this is the exact scenario logical_session_id exists for");
  assert.notEqual(newYesterdaySessionId, yesterdaySessionId, "row ids really did change - this is the exact scenario logical_session_id exists for");

  // 4) The already-submitted results must both still exist, exactly once
  // each, and be recognized as rated against the NEW row ids.
  const feedbackCountResult = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId]);
  assert.equal(feedbackCountResult.rows[0].n, 2, "still exactly two results - never duplicated by the edit round trip");

  const today = await api("/api/training-load/athlete/today", { cookie: athlete.cookie });
  const todayRow = today.body.sessions.find((s) => s.sessionId === newTodaySessionId);
  assert.ok(todayRow, "Athlete Home resolves the recreated session");
  assert.equal(todayRow.rated, true, "Athlete Home must NOT ask for a new RPE for a session that was already rated before the edit");
  assert.equal(todayRow.feedback.rpe, 7);
  assert.equal(todayRow.feedback.srpe, 420);

  // 5) A fresh submit against the NEW row id, with different values, is
  // correctly rejected (not silently overwritten, not blindly re-accepted
  // as if nothing had ever been submitted).
  const conflictRes = await api(`/api/training-load/sessions/${newTodaySessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 2, durationMinutes: 10 } });
  assert.equal(conflictRes.status, 409);

  // 6) Results/weekly must show this session exactly once, correctly
  // rated, never as a second "historical" duplicate alongside the live row.
  const weekly = await api(`/api/training-load/weekly?weekStart=${WEEK_START}`, { cookie: coach.cookie });
  const allSessions = weekly.body.days.flatMap((d) => d.sessions);
  const matchingToday = allSessions.filter((s) => s.feedback?.srpe === 420);
  assert.equal(matchingToday.length, 1, "the today session's 420 AU result appears exactly once in the weekly projection - never also as a second, historical duplicate");
  assert.equal(matchingToday[0].sessionId, newTodaySessionId, "reachable as the LIVE session");
  assert.equal(matchingToday[0].historical, false);

  // 7) A genuinely NEW session, added to the live plan AFTER the edit
  // round trip (simulating the coach adding one more session while
  // editing), gets its own fresh logical_session_id automatically and
  // remains independently, normally ratable. applyEditDraft() recreates
  // the DAY rows too, not just the sessions - yesterdayDayId is now a
  // stale, deleted id, so the new day must be re-resolved by date first.
  const newYesterdayDayResult = await query(`select id from plans.plan_days where plan_id = $1 and date = $2`, [livePlanId, YESTERDAY]);
  const newYesterdayDayId = newYesterdayDayResult.rows[0].id;
  const addedSessionId = await makeRealSession(newYesterdayDayId, "Newly added session", null, 1);
  const addedSubmit = await api(`/api/training-load/sessions/${addedSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 3, durationMinutes: 15 } });
  assert.equal(addedSubmit.status, 201, "a genuinely new session must never be blocked or pre-rated because of an unrelated logical_session_id");
});
