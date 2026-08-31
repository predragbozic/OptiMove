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

// Round 3: the slot-based re-correlation fixup this file used to exercise
// was removed (see migrations_v2/
// 202608320900_training_load_v2_logical_session_identity.sql's own section
// 3 comment) - a slot key describes a session's CURRENT position, not its
// identity over time, and heuristically matching on it could both miss a
// real pair (the coach changed the draft's own slot before migration) and
// wrongly match an unrelated one (the coach deleted the original session
// and created a new, different one at the same slot). Replaced with an
// explicit legacy_pre_migration_draft marker + a submission block on the
// live plan - see the tests below, which flip that marker directly via SQL
// to stand in for a draft the migration's own backfill would have marked.

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
    // Each test's own club-scoped planned-RPE setting (see
    // enablePlannedRpeForClub below) - must be removed BEFORE the club
    // itself (owner_club_id is an ON DELETE RESTRICT foreign key), and
    // in any case per this branch's own explicit rule: a real-DB test
    // must create, use, and tear down its OWN scope-specific setting,
    // never leave a permanent row behind.
    ["training_load.planned_rpe_workspace_settings", () => cleanupClubIds.size && query(
      `delete from training_load.planned_rpe_workspace_settings where owner_club_id = any($1::uuid[])`, [[...cleanupClubIds]],
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
function dayOrderForDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const raw = d.getUTCDay();
  return raw === 0 ? 7 : raw;
}

// This file's plans are created via raw SQL (not through a real Builder
// POST /plans call - see makeRealWeeklyPlan's own header), so they never
// go through routes/builder.js's own automatic ownership-snapshot
// insertion (insertPlanOwnershipSnapshot). Every test that submits real
// RPE must therefore stamp its own plan's stored ownership directly, and
// enable a matching, real, club-scoped setting of its own - never a
// permanent/global row (removed in after() above, per this branch's own
// explicit "no global test fixture" rule).
async function setPlanOwnershipDirect(planId, clubId) {
  await query(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id)
     values ($1,'club',$2)
     on conflict (plan_id) do update set owner_scope = 'club', owner_club_id = excluded.owner_club_id, owner_user_id = null, owner_team_id = null`,
    [planId, clubId],
  );
}
async function enablePlannedRpeForClub(clubId) {
  await query(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_club_id, enabled, enabled_at)
     values ('club',$1,true,'2000-01-01T00:00:00Z')
     on conflict (owner_scope, owner_user_id, owner_club_id, owner_team_id)
     do update set enabled = true, enabled_at = excluded.enabled_at`,
    [clubId],
  );
}

test("a real Builder Edit -> Save and finish round trip preserves an already-submitted RPE result: one result, recognized as rated, never duplicated - and a genuinely new session added afterward is still independently ratable", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);

  const livePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  await setPlanOwnershipDirect(livePlanId, coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
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

// ------------------------------------------------------------
// Item 1 correction, round 3: a draft that was ALREADY OPEN before the v2
// migration ran can no longer be trusted to round-trip via slot-matching
// (see the migration file's own section 3 comment - a slot key is not a
// safe identity mechanism). Instead, the migration marks exactly the
// edit-drafts that existed at migration time (legacy_pre_migration_draft),
// and POST /sessions/:sessionId/rpe refuses new submissions against a live
// plan for as long as one of its legacy drafts remains open. A real
// edit-draft, opened through the real Builder "Edit" endpoint, stands in
// for that pre-existing draft (flipped to legacy_pre_migration_draft =
// true directly via SQL, exactly what the migration's own backfill would
// have done to it). Its session's own slot is ALSO changed before saving -
// counter-example 1 from the correction: a slot-matching fixup would have
// found no live-side match at all here, but the block never depended on
// slot matching in the first place.
// ------------------------------------------------------------
test("a real legacy pre-migration draft (its own session slot changed before saving) blocks new RPE on its live plan, and saving it through the real Builder flow correctly lifts the block - one result, never re-rateable, never a duplicate", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);

  const livePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  await setPlanOwnershipDirect(livePlanId, coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const dayId = await makeRealDay(livePlanId, TODAY, dayOrderForDate(TODAY));
  const liveSessionId = await makeRealSession(dayId, "Pre-existing draft scenario session", "AM");

  // Open a real edit-draft through the real Builder "Edit" flow, then mark
  // it legacy - exactly what the migration's own backfill would have done
  // to a draft that was already open at migration time.
  const editRes = await api(`/api/builder/plans/${livePlanId}/edit`, { method: "POST", cookie: coach.cookie });
  assert.equal(editRes.status, 200, `expected the edit-draft to open, got ${editRes.status}: ${JSON.stringify(editRes.body)}`);
  const draftPlanId = editRes.body.plan.id;
  cleanupPlanIds.add(draftPlanId);
  await query(`update plans.plans set legacy_pre_migration_draft = true where id = $1`, [draftPlanId]);

  // Counter-example 1: the coach changes the draft's OWN copy of this
  // session's slot before saving - a slot-matching fixup would find no
  // live-side match here at all.
  const draftSessionResult = await query(
    `select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`,
    [draftPlanId],
  );
  await query(`update plans.plan_sessions set am_pm = 'PM' where id = $1`, [draftSessionResult.rows[0].id]);

  // While the legacy draft is pending, a new submission against the live
  // plan's session is controlled-rejected, never a 500, and creates no row.
  const blocked = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 6, durationMinutes: 50 } });
  assert.equal(blocked.status, 409, `expected 409 while the legacy draft is pending, got ${blocked.status}: ${JSON.stringify(blocked.body)}`);
  const feedbackBeforeSave = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId]);
  assert.equal(feedbackBeforeSave.rows[0].n, 0, "no row must exist while blocked");

  // The coach saves the legacy draft through the REAL Builder submit flow
  // (applyEditDraft) - its row is deleted as an unconditional last step,
  // taking the marker with it.
  const submitDraftRes = await api(`/api/builder/plans/${draftPlanId}/submit`, { method: "POST", cookie: coach.cookie });
  assert.equal(submitDraftRes.status, 200, `expected the edit-draft to apply back onto the live plan, got ${submitDraftRes.status}: ${JSON.stringify(submitDraftRes.body)}`);
  assert.equal(submitDraftRes.body.plan.id, livePlanId);

  const recreatedResult = await query(
    `select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and pd.date = $2`,
    [livePlanId, TODAY],
  );
  const recreatedSessionId = recreatedResult.rows[0].id;
  assert.notEqual(recreatedSessionId, liveSessionId, "applyEditDraft really did delete and recreate the row");

  const submit = await api(`/api/training-load/sessions/${recreatedSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 6, durationMinutes: 50 } });
  assert.equal(submit.status, 201, `expected 201 once the legacy draft is gone, got ${submit.status}: ${JSON.stringify(submit.body)}`);

  const feedbackAfter = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId]);
  assert.equal(feedbackAfter.rows[0].n, 1, "exactly one result - never duplicated");

  const today = await api("/api/training-load/athlete/today", { cookie: athlete.cookie });
  const todayRow = today.body.sessions.find((s) => s.sessionId === recreatedSessionId);
  assert.ok(todayRow, "the recreated session resolves on Athlete Home");
  assert.equal(todayRow.rated, true);

  const retrySame = await api(`/api/training-load/sessions/${recreatedSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 6, durationMinutes: 50 } });
  assert.equal(retrySame.status, 200, "an identical retry must be idempotent, never a new 201");

  const retryDifferent = await api(`/api/training-load/sessions/${recreatedSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 9, durationMinutes: 90 } });
  assert.equal(retryDifferent.status, 409, "a genuinely different retry must be rejected, never silently accepted as a new 201");
});

test("a real legacy pre-migration draft blocks new RPE on its live plan, and DISCARDING it (real DELETE /plans/:planId, never touching the live plan) lifts the block - the ORIGINAL live session rates normally", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);

  const livePlanId = await makeRealWeeklyPlan(coach.coachId, athlete.athleteId);
  await setPlanOwnershipDirect(livePlanId, coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const dayId = await makeRealDay(livePlanId, TODAY, dayOrderForDate(TODAY));
  const liveSessionId = await makeRealSession(dayId, "Pre-existing draft, discard scenario", "AM");

  const editRes = await api(`/api/builder/plans/${livePlanId}/edit`, { method: "POST", cookie: coach.cookie });
  assert.equal(editRes.status, 200);
  const draftPlanId = editRes.body.plan.id;
  await query(`update plans.plans set legacy_pre_migration_draft = true where id = $1`, [draftPlanId]);

  const blocked = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(blocked.status, 409);

  // Discard through the real generic delete-plan endpoint - never touches
  // the live plan at all.
  const discardRes = await api(`/api/builder/plans/${draftPlanId}`, { method: "DELETE", cookie: coach.cookie });
  assert.equal(discardRes.status, 200, `expected the discard to succeed, got ${discardRes.status}: ${JSON.stringify(discardRes.body)}`);

  const submit = await api(`/api/training-load/sessions/${liveSessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 30 } });
  assert.equal(submit.status, 201, `expected 201 against the untouched original live session, got ${submit.status}: ${JSON.stringify(submit.body)}`);

  const feedbackCountResult = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athlete.athleteId]);
  assert.equal(feedbackCountResult.rows[0].n, 1);
});

// ------------------------------------------------------------
// Item 2 correction: POST /plans/:planId/sync-batch must never touch an
// ACTIVE (published) sibling plan - only a genuinely pre-publish DRAFT
// sibling. Before this correction, syncBatchFromPlan()'s sibling query only
// excluded 'archived', so an ACTIVE sibling was swept in too - its entire
// session tree deleted and recreated from the source plan's current
// content, with fresh logical_session_id values, orphaning any RPE the
// sibling's own athlete had already submitted and re-opening the recreated
// session for a duplicate submit.
// ------------------------------------------------------------
test("a batch-sync against an ALREADY-PUBLISHED sibling plan must never touch it - a sibling athlete's already-submitted RPE stays linked to the exact same session, never orphaned or re-openable", async () => {
  const coach = await makeCoachWithClub();
  const athleteA = await makeAthleteInClub(coach.clubId);
  const athleteB = await makeAthleteInClub(coach.clubId);

  // Two independently-published (ACTIVE) weekly plans for two different
  // athletes, sharing one builder_batch_id - exactly what a batch
  // assignment leaves behind once both siblings have already been
  // individually published.
  const sourcePlanId = await makeRealWeeklyPlan(coach.coachId, athleteA.athleteId);
  const siblingPlanId = await makeRealWeeklyPlan(coach.coachId, athleteB.athleteId);
  await setPlanOwnershipDirect(sourcePlanId, coach.clubId);
  await setPlanOwnershipDirect(siblingPlanId, coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const batchIdResult = await query(`select gen_random_uuid() as id`);
  const batchId = batchIdResult.rows[0].id;
  await query(`update plans.plans set builder_batch_id = $1 where id = any($2::uuid[])`, [batchId, [sourcePlanId, siblingPlanId]]);

  const sourceDayId = await makeRealDay(sourcePlanId, TODAY, dayOrderForDate(TODAY));
  await makeRealSession(sourceDayId, "Source athlete's session", "AM");
  const siblingDayId = await makeRealDay(siblingPlanId, TODAY, dayOrderForDate(TODAY));
  const siblingSessionId = await makeRealSession(siblingDayId, "Sibling athlete's own session", "AM");

  // Athlete B (the sibling) already rated their own, already-published
  // session before any further batch-sync happens.
  const submit = await api(`/api/training-load/sessions/${siblingSessionId}/rpe`, { method: "POST", cookie: athleteB.cookie, body: { rpe: 6, durationMinutes: 40 } });
  assert.equal(submit.status, 201, `expected 201, got ${submit.status}: ${JSON.stringify(submit.body)}`);

  // The coach later triggers a batch-sync from the SOURCE (athlete A's)
  // plan - e.g. after tweaking athlete A's own already-published plan and
  // wanting the change reflected across the batch.
  const syncRes = await api(`/api/builder/plans/${sourcePlanId}/sync-batch`, { method: "POST", cookie: coach.cookie });
  assert.equal(syncRes.status, 200, `expected sync-batch to succeed, got ${syncRes.status}: ${JSON.stringify(syncRes.body)}`);

  // The sibling's ACTIVE plan must be entirely untouched - same session row,
  // never deleted-and-recreated.
  const siblingSessionsAfter = await query(
    `select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`,
    [siblingPlanId],
  );
  assert.equal(siblingSessionsAfter.rowCount, 1);
  assert.equal(siblingSessionsAfter.rows[0].id, siblingSessionId, "an ACTIVE sibling's session row must never be deleted/recreated by a batch-sync");

  // The already-submitted result must still be recognized as rated against
  // that same session - never orphaned, never duplicated, never re-openable.
  const feedbackCountResult = await query(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [athleteB.athleteId]);
  assert.equal(feedbackCountResult.rows[0].n, 1, "exactly one result for the sibling athlete - a batch-sync against an active sibling must never orphan or duplicate it");

  const today = await api("/api/training-load/athlete/today", { cookie: athleteB.cookie });
  const todayRow = today.body.sessions.find((s) => s.sessionId === siblingSessionId);
  assert.ok(todayRow, "the sibling's session still resolves under its original id");
  assert.equal(todayRow.rated, true, "must still show as rated, never reset to Not rated by an unrelated batch-sync");

  const retrySame = await api(`/api/training-load/sessions/${siblingSessionId}/rpe`, { method: "POST", cookie: athleteB.cookie, body: { rpe: 6, durationMinutes: 40 } });
  assert.equal(retrySame.status, 200, "an identical retry is still idempotent - the session was never re-opened");

  const retryDifferent = await api(`/api/training-load/sessions/${siblingSessionId}/rpe`, { method: "POST", cookie: athleteB.cookie, body: { rpe: 9, durationMinutes: 90 } });
  assert.equal(retryDifferent.status, 409, "a genuinely different retry must still be rejected - never a fresh 201 against a re-opened session");
});
