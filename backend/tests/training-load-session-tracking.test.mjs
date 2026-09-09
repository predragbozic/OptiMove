// Training Activity Integration 2A: "Track this session in Training Load"
// is now a decision SEPARATE from "Request RPE from athletes" (migrations_v2/
// 202609080900_training_load_v14_session_tracking_and_rpe_defaults.sql).
// This file covers what's genuinely NEW in this round and not already
// exercised elsewhere:
//   - plan-level defaults (track/request) and the three explicit bulk
//     actions over an open Builder draft's own sessions;
//   - a brand-new session's own initial state, driven by its bta
//     classification and the plan's current defaults (POST /blocks/
//     :blockId/sessions);
//   - the new PATCH .../training-load-enabled quick toggle, including its
//     RPE cascade and confirm-before-disable gate;
//   - the effective-eligibility split (tracked+RPE-off must be metrics-
//     relevant but never RPE-actionable) on the real read paths;
//   - planned/external RPE materialization into training.activities:
//     exactly one activity/participant/link, idempotent retry, never
//     created by a pure GET.
//
// Deliberately the real-OPTIMOVE harness (not a disposable DB) - same
// established pattern as training-load-rpe-enabled.test.mjs and
// training-load-builder-edit-draft.test.mjs, for the same reason: Builder's
// own plans.plans/plan_sessions carry the full real base schema. Every
// created row (including the training.* rows this round's own
// materialization now creates) is tracked and deleted in after().
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
    ["training.activity_participant_session_links", () => cleanupAthleteIds.size && query(
      `delete from training.activity_participant_session_links where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]],
    )],
    // materialize_activity_group_from_external_occurrence (called from
    // POST /external-assignments/:id/rpe) also writes this junction table
    // - must be cleared before both training.activities AND
    // training_load.external_schedule_occurrences below.
    ["training.activity_external_occurrence_links", () => cleanupClubIds.size && query(
      `delete from training.activity_external_occurrence_links where activity_id in (select id from training.activities where owner_club_id = any($1::uuid[]))`, [[...cleanupClubIds]],
    )],
    ["training.activity_participants", () => cleanupAthleteIds.size && query(
      `delete from training.activity_participants where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]],
    )],
    ["training.activities", () => cleanupClubIds.size && query(
      `delete from training.activities where owner_club_id = any($1::uuid[])`, [[...cleanupClubIds]],
    )],
    ["training_load.planned_rpe_workspace_settings", () => cleanupClubIds.size && query(
      `delete from training_load.planned_rpe_workspace_settings where owner_club_id = any($1::uuid[])`, [[...cleanupClubIds]],
    )],
    ["training_load.external_assignments", () => cleanupAthleteIds.size && query(
      `delete from training_load.external_assignments where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]],
    )],
    ["training_load.external_schedule_occurrences", () => cleanupClubIds.size && query(
      `delete from training_load.external_schedule_occurrences where schedule_id in (select id from training_load.external_schedules where owner_club_id = any($1::uuid[]))`, [[...cleanupClubIds]],
    )],
    ["training_load.external_schedules", () => cleanupClubIds.size && query(
      `delete from training_load.external_schedules where owner_club_id = any($1::uuid[])`, [[...cleanupClubIds]],
    )],
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
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`TL tracking regression club ${STAMP()}`]);
  const clubId = clubResult.rows[0].id;
  cleanupClubIds.add(clubId);
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Coach', $2, 'TL Coach', 'TL Coach', 'club_admin', true) returning id`,
    [`tl-tracking-coach-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const coachId = userResult.rows[0].id;
  cleanupUserIds.add(coachId);
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coachId, clubId]);
  const token = await createSession(coachId);
  return { coachId, clubId, cookie: `optimove_session=${token}` };
}

async function makeAthleteInClub(clubId) {
  const externalId = `tltrack${Math.floor(Math.random() * 900000 + 100000)}`;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Athlete', $2, 'TL Athlete', 'TL Athlete', 'athlete', true) returning id`,
    [`tl-tracking-athlete-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
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

async function enablePlannedRpeForClub(clubId) {
  await query(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_club_id, enabled, enabled_at)
     values ('club',$1,true,'2000-01-01T00:00:00Z')
     on conflict (owner_scope, owner_user_id, owner_club_id, owner_team_id)
     do update set enabled = true, enabled_at = excluded.enabled_at`,
    [clubId],
  );
}

// Creates a real Weekly plan through the actual Builder API (POST
// /plans), then stamps its ownership (insertPlanOwnershipSnapshot already
// does this for a real coach-created plan - this only re-confirms/locks it
// to the SAME club deterministically, since findRequestedAthletes/
// resolveWeeklyPlanOwnerScope already resolve it from the coach's own
// active workspace, which IS this club).
async function makeRealPlanViaApi(coach, athleteExternalId) {
  const created = await api("/api/builder/plans", {
    method: "POST", cookie: coach.cookie,
    body: { planType: "weekly", weekStart: WEEK_START, athleteId: athleteExternalId },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = created.body.plan.id;
  cleanupPlanIds.add(planId);
  const blockId = created.body.blocks.find((b) => b.date === TODAY)?.id;
  assert.ok(blockId, "test setup: today's own block must exist in a freshly-created week");
  return { planId, blockId, draft: created.body };
}

// ============================================================
// A. Plan-level defaults
// ============================================================

test("A1. a brand-new Weekly plan defaults BOTH track and request-RPE to OFF", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { draft } = await makeRealPlanViaApi(coach, athlete.externalId);
  assert.equal(draft.plan.trackTrainingLoadDefault, false);
  assert.equal(draft.plan.requestRpeDefault, false);
});

test("A2. PATCH training-load-settings updates the defaults, and requestRpeDefault can never be saved true while track is false", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId } = await makeRealPlanViaApi(coach, athlete.externalId);

  const turnOn = await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
  assert.equal(turnOn.status, 200, JSON.stringify(turnOn.body));
  assert.equal(turnOn.body.plan.trackTrainingLoadDefault, true);
  assert.equal(turnOn.body.plan.requestRpeDefault, true);

  const turnTrackOff = await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: false } });
  assert.equal(turnTrackOff.status, 200, JSON.stringify(turnTrackOff.body));
  assert.equal(turnTrackOff.body.plan.trackTrainingLoadDefault, false);
  assert.equal(turnTrackOff.body.plan.requestRpeDefault, false, "requestRpeDefault must be forced off the instant track is off, even though only trackTrainingLoadDefault was sent");
});

// Correction round 3, item 2: trackTrainingLoadDefault/requestRpeDefault
// accept ONLY a real JSON true/false - every other JSON type is a
// controlled 400 with zero rows changed, never a silent Boolean(...)
// coercion.
const NON_BOOLEAN_VALUES = [
  ["the string \"true\"", "true"],
  ["the number 1", 1],
  ["null", null],
  ["an array", ["true"]],
  ["an object", { value: true }],
];

test("A2b. PATCH training-load-settings rejects a non-boolean trackTrainingLoadDefault/requestRpeDefault for every JSON type, and changes zero rows", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId } = await makeRealPlanViaApi(coach, athlete.externalId);

  for (const [label, value] of NON_BOOLEAN_VALUES) {
    const trackRes = await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: value } });
    assert.equal(trackRes.status, 400, `trackTrainingLoadDefault=${label}: expected 400, got ${trackRes.status}: ${JSON.stringify(trackRes.body)}`);

    const rpeRes = await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { requestRpeDefault: value } });
    assert.equal(rpeRes.status, 400, `requestRpeDefault=${label}: expected 400, got ${rpeRes.status}: ${JSON.stringify(rpeRes.body)}`);
  }

  const row = (await query(`select track_training_load_default, request_rpe_default from plans.plans where id = $1`, [planId])).rows[0];
  assert.equal(row.track_training_load_default, false, "every rejected value must have changed zero rows - the plan still has its own original default");
  assert.equal(row.request_rpe_default, false);
});

test("A3. a NEW main Training session inherits the plan's CURRENT defaults; Before/After/unclassified always start OFF/OFF regardless", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });

  const trainingSession = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main session" } });
  assert.equal(trainingSession.status, 201, JSON.stringify(trainingSession.body));
  const trainingRow = trainingSession.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main session");
  assert.equal(trainingRow.trackingEnabled, true, "the main Training slot must inherit the plan's OWN current defaults");
  assert.equal(trainingRow.rpeEnabled, true);

  const beforeSession = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "B", name: "Before session" } });
  const beforeRow = beforeSession.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Before session");
  assert.equal(beforeRow.trackingEnabled, false, "Before training must default OFF regardless of the plan's own defaults");
  assert.equal(beforeRow.rpeEnabled, false);

  const afterSession = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "A", name: "After session" } });
  const afterRow = afterSession.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "After session");
  assert.equal(afterRow.trackingEnabled, false, "After training must default OFF regardless of the plan's own defaults");
  assert.equal(afterRow.rpeEnabled, false);

  const unclassified = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { name: "No category" } });
  const unclassifiedRow = unclassified.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "No category");
  assert.equal(unclassifiedRow.trackingEnabled, false, "an unknown/unset training-phase category must never be guessed as tracked");
  assert.equal(unclassifiedRow.rpeEnabled, false);
});

test("A4. bulk action: apply-to-current-training-sessions overwrites ONLY existing 'T' sessions to match the plan's CURRENT defaults - Before/After sessions are untouched", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  // Created while defaults are still OFF/OFF - the main session starts OFF.
  const t = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  const before = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "B", name: "Warmup" } });

  await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
  const applied = await api(`/api/builder/plans/${planId}/training-load-settings/apply-to-training-sessions`, { method: "POST", cookie: coach.cookie });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const finalBlock = applied.body.blocks.find((b) => b.id === blockId);
  const tRow = finalBlock.sessions.find((s) => s.name === "Main");
  const bRow = finalBlock.sessions.find((s) => s.name === "Warmup");
  assert.equal(tRow.trackingEnabled, true, "the existing Training session must now be updated to match the new defaults");
  assert.equal(tRow.rpeEnabled, true);
  assert.equal(bRow.trackingEnabled, false, "the Before session must be completely untouched by this bulk action");
  assert.equal(bRow.rpeEnabled, false);
  void t; void before;
});

test("A5. bulk action: turn-off-before-after forces every B/A session off regardless of its own current state, and never touches Training sessions", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
  const t = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  const tSessionId = t.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main").id;
  const before = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "B", name: "Warmup" } });
  const beforeSessionId = before.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Warmup").id;
  // Explicitly turn Warmup ON first, to prove the bulk action really forces it off.
  await api(`/api/builder/sessions/${beforeSessionId}`, { method: "PATCH", cookie: coach.cookie, body: { trackingEnabled: true, rpeEnabled: true } });

  const result = await api(`/api/builder/plans/${planId}/training-load-settings/turn-off-before-after`, { method: "POST", cookie: coach.cookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const finalBlock = result.body.blocks.find((b) => b.id === blockId);
  assert.equal(finalBlock.sessions.find((s) => s.id === beforeSessionId).trackingEnabled, false);
  assert.equal(finalBlock.sessions.find((s) => s.id === beforeSessionId).rpeEnabled, false);
  assert.equal(finalBlock.sessions.find((s) => s.id === tSessionId).trackingEnabled, true, "the main Training session must be completely untouched by this bulk action");
});

test("A6. bulk action: turn-off-all-rpe turns RPE off everywhere but leaves tracking untouched", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  await api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
  const t = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  const tSessionId = t.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main").id;

  const result = await api(`/api/builder/plans/${planId}/training-load-settings/turn-off-all-rpe`, { method: "POST", cookie: coach.cookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const row = result.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.id === tSessionId);
  assert.equal(row.rpeEnabled, false);
  assert.equal(row.trackingEnabled, true, "tracking itself must be left on - only RPE is turned off");
});

// ============================================================
// B. The new PATCH .../training-load-enabled quick toggle
// ============================================================

test("B1. turning tracking OFF via the quick toggle also cascades RPE off in the same request", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL tracking plan', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`,
    [planId, coach.clubId],
  );
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionId = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Session',true,true) returning id`,
    [dayId],
  ).then((r) => r.rows[0].id);

  const res = await api(`/api/training-load/sessions/${sessionId}/training-load-enabled`, { method: "PATCH", cookie: coach.cookie, body: { trainingLoadEnabled: false } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.trainingLoadEnabled, false);
  assert.equal(res.body.rpeEnabled, false, "RPE must be cascaded off in the SAME response/transaction");

  const row = (await query(`select rpe_enabled, training_load_enabled from plans.plan_sessions where id=$1`, [sessionId])).rows[0];
  assert.equal(row.rpe_enabled, false);
  assert.equal(row.training_load_enabled, false);
});

test("B2. turning tracking off requires confirmDisableWithResults when a real RPE result already exists, exactly like the rpe-enabled route", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL tracking plan b2', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`,
    [planId, coach.clubId],
  );
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionId = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Session',true,true) returning id`,
    [dayId],
  ).then((r) => r.rows[0].id);
  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 45 } });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));

  const blocked = await api(`/api/training-load/sessions/${sessionId}/training-load-enabled`, { method: "PATCH", cookie: coach.cookie, body: { trainingLoadEnabled: false } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "hasExistingResults");

  const confirmed = await api(`/api/training-load/sessions/${sessionId}/training-load-enabled`, { method: "PATCH", cookie: coach.cookie, body: { trainingLoadEnabled: false, confirmDisableWithResults: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const feedbackCount = (await query(`select count(*)::int as n from training_load.session_feedback where athlete_id=$1`, [athlete.athleteId])).rows[0].n;
  assert.equal(feedbackCount, 1, "the historical result must never be deleted by turning tracking off");
});

// Training Activity Integration 2A hardening: the quick-toggle routes now
// authorize against the plan's OWN stored plan_workspace_ownership
// snapshot, resolved against the calling coach's single active workspace -
// never against "does this workspace merely also cover the same athlete
// via some other membership" (see canManagePlanTrainingLoadInScope,
// trainingLoadAccess.js, and this route's own comment for the full
// reasoning). This is the exact cross-workspace scenario that gap allowed:
// one athlete with active memberships in TWO different clubs, a plan
// genuinely owned by Club A, and a SEPARATE coach who only administers
// Club B (no relationship to Club A at all) - Club B's own workspace must
// never be able to toggle a session on Club A's plan just because it can
// also see the same athlete.
test("B3. a coach whose workspace merely ALSO covers the same athlete (via a different club) cannot quick-toggle a session on a plan owned by a DIFFERENT club - controlled 404, zero row changes", async () => {
  const ownerCoach = await makeCoachWithClub();
  const otherCoach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(ownerCoach.clubId);
  // Same athlete, a SECOND active club membership - otherCoach's own
  // workspace (Club B) genuinely covers this athlete too, which is
  // exactly the condition that used to be (wrongly) sufficient.
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athlete.athleteId, otherCoach.clubId]);

  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL tracking plan b3', 'active', 'builder', 'private', $3) returning id`,
    [ownerCoach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`,
    [planId, ownerCoach.clubId],
  );
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionId = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Session',true,true) returning id`,
    [dayId],
  ).then((r) => r.rows[0].id);

  const trainingLoadRes = await api(`/api/training-load/sessions/${sessionId}/training-load-enabled`, { method: "PATCH", cookie: otherCoach.cookie, body: { trainingLoadEnabled: false } });
  assert.equal(trainingLoadRes.status, 404, `Club B's workspace must not resolve Club A's plan at all, got ${trainingLoadRes.status}: ${JSON.stringify(trainingLoadRes.body)}`);

  const rpeRes = await api(`/api/training-load/sessions/${sessionId}/rpe-enabled`, { method: "PATCH", cookie: otherCoach.cookie, body: { rpeEnabled: false } });
  assert.equal(rpeRes.status, 404, `same rejection for the sibling rpe-enabled route, got ${rpeRes.status}: ${JSON.stringify(rpeRes.body)}`);

  const row = (await query(`select rpe_enabled, training_load_enabled from plans.plan_sessions where id=$1`, [sessionId])).rows[0];
  assert.equal(row.rpe_enabled, true, "neither rejected request may have changed a single row");
  assert.equal(row.training_load_enabled, true);

  // The plan's REAL owner (Club A) can still toggle it normally - this is
  // an authorization gap fix, not a general lockout.
  const ownerRes = await api(`/api/training-load/sessions/${sessionId}/training-load-enabled`, { method: "PATCH", cookie: ownerCoach.cookie, body: { trainingLoadEnabled: false } });
  assert.equal(ownerRes.status, 200, `the real owning workspace must still succeed, got ${ownerRes.status}: ${JSON.stringify(ownerRes.body)}`);
});

// ============================================================
// C. Effective eligibility: tracked+RPE-off is metrics-relevant but never RPE-actionable
// ============================================================

test("C1. a Training-Load-ON + RPE-OFF session never appears as an actionable RPE request on Athlete Home or the coach's Schedule view, and a direct submit is a controlled 409", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL tracking plan c1', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [planId, coach.clubId]);
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionId = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Recovery',false,true) returning id`,
    [dayId],
  ).then((r) => r.rows[0].id);

  const today = await api("/api/training-load/athlete/today", { cookie: athlete.cookie });
  assert.ok(!today.body.sessions.some((s) => s.sessionId === sessionId), "a tracked-but-RPE-off session must never appear as an RPE request on Home");

  const weekly = await api(`/api/training-load/weekly?weekStart=${WEEK_START}`, { cookie: coach.cookie });
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.ok(row, "the coach's own Schedule view must still see the session");
  assert.equal(row.trainingLoadEnabled, true);
  assert.equal(row.rpeEnabled, false);
  assert.equal(row.actionable, false, "actionable (which feeds the rated/expected denominator) must be false - RPE was never requested");
  assert.equal(row.status, "tracked_rpe_off");

  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 45 } });
  assert.equal(submit.status, 409);
  assert.match(submit.body.error, /RPE isn't being collected/);
});

test("C2. a session NOT tracked in Training Load at all shows status 'not_tracked' on the coach's Schedule view, and a direct submit is refused before ever reaching the RPE-specific gate", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL tracking plan c2', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [planId, coach.clubId]);
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionId = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Untracked',false,false) returning id`,
    [dayId],
  ).then((r) => r.rows[0].id);

  const weekly = await api(`/api/training-load/weekly?weekStart=${WEEK_START}`, { cookie: coach.cookie });
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.sessionId === sessionId);
  assert.equal(row.status, "not_tracked");
  assert.equal(row.actionable, false);

  const submit = await api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 5, durationMinutes: 45 } });
  assert.equal(submit.status, 409);
  assert.match(submit.body.error, /isn't being tracked in Training Load/);
});

// ============================================================
// D. Planned-RPE materialization into training.activities
// ============================================================

test("D1. a successful planned RPE submit materializes exactly ONE training.activities row, ONE participant, and ONE confirmed session link, reachable through the canonical read contract", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL materialize plan d1', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [planId, coach.clubId]);
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionRow = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Materialize Me',true,true) returning id, logical_session_id`,
    [dayId],
  ).then((r) => r.rows[0]);

  const submit = await api(`/api/training-load/sessions/${sessionRow.id}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 7, durationMinutes: 60 } });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));

  const links = await query(
    `select l.activity_participant_id, l.link_status, ap.athlete_id, ap.activity_id
     from training.activity_participant_session_links l
     join training.activity_participants ap on ap.id = l.activity_participant_id
     where l.logical_session_id = $1`,
    [sessionRow.logical_session_id],
  );
  assert.equal(links.rowCount, 1, "exactly one confirmed session link");
  assert.equal(links.rows[0].link_status, "confirmed");
  assert.equal(links.rows[0].athlete_id, athlete.athleteId);

  const activityCount = await query(`select count(*)::int as n from training.activities where id=$1`, [links.rows[0].activity_id]);
  assert.equal(activityCount.rows[0].n, 1);
  const participantCount = await query(`select count(*)::int as n from training.activity_participants where activity_id=$1`, [links.rows[0].activity_id]);
  assert.equal(participantCount.rows[0].n, 1, "exactly one participant on the materialized activity");

  const canonical = await query(`select detail from training.canonical_activity_results($1) where fact_kind='rpe'`, [links.rows[0].activity_id]);
  assert.equal(canonical.rowCount, 1);
  assert.equal(canonical.rows[0].detail.rpe, 7);
});

test("D2. an identical retry of the same planned RPE submit never creates a second activity/participant/link", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL materialize plan d2', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [planId, coach.clubId]);
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  const sessionRow = await query(
    `insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Retry Me',true,true) returning id, logical_session_id`,
    [dayId],
  ).then((r) => r.rows[0]);

  const first = await api(`/api/training-load/sessions/${sessionRow.id}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 4, durationMinutes: 30 } });
  assert.equal(first.status, 201);
  const retry = await api(`/api/training-load/sessions/${sessionRow.id}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 4, durationMinutes: 30 } });
  assert.equal(retry.status, 200, "an identical retry is a silent idempotent 200");

  const linkCount = await query(`select count(*)::int as n from training.activity_participant_session_links where logical_session_id=$1`, [sessionRow.logical_session_id]);
  assert.equal(linkCount.rows[0].n, 1, "never a second link from the retry");
  const activityCount = await query(
    `select count(distinct ap.activity_id)::int as n
     from training.activity_participant_session_links l join training.activity_participants ap on ap.id = l.activity_participant_id
     where l.logical_session_id=$1`,
    [sessionRow.logical_session_id],
  );
  assert.equal(activityCount.rows[0].n, 1, "never a second activity from the retry");
});

test("D3. a pure GET (Athlete Home, coach Schedule) never materializes a training.activities row for a session that has never been submitted", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  await enablePlannedRpeForClub(coach.clubId);
  const planId = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL materialize plan d3', 'active', 'builder', 'private', $3) returning id`,
    [coach.coachId, athlete.athleteId, WEEK_START],
  ).then((r) => r.rows[0].id);
  cleanupPlanIds.add(planId);
  await query(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_club_id) values ($1,'club',$2)`, [planId, coach.clubId]);
  const dayId = await query(`insert into plans.plan_days (plan_id, date, day_order, block_index) values ($1,$2,1,1) returning id`, [planId, TODAY]).then((r) => r.rows[0].id);
  await query(`insert into plans.plan_sessions (plan_day_id, name, rpe_enabled, training_load_enabled) values ($1,'Never Submitted',true,true)`, [dayId]);

  const before = await query(`select count(*)::int as n from training.activities where owner_club_id=$1`, [coach.clubId]);
  await api("/api/training-load/athlete/today", { cookie: athlete.cookie });
  await api(`/api/training-load/weekly?weekStart=${WEEK_START}`, { cookie: coach.cookie });
  await api(`/api/training-load/weekly?weekStart=${WEEK_START}`, { cookie: athlete.cookie });
  const after = await query(`select count(*)::int as n from training.activities where owner_club_id=$1`, [coach.clubId]);
  assert.equal(after.rows[0].n, before.rows[0].n, "browsing alone must never create a training.activities row");
});

test("D4. two DIFFERENT athletes' external RPE submits for the SAME occurrence converge on exactly ONE group training.activities row, never two", async () => {
  const coach = await makeCoachWithClub();
  const athleteA = await makeAthleteInClub(coach.clubId);
  const athleteB = await makeAthleteInClub(coach.clubId);

  const scheduleId = await query(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope, owner_club_id)
     values ('one_time','UTC',$1,'00:00','23:59','active','Group camp',$2,'club',$3) returning id`,
    [TODAY, coach.coachId, coach.clubId],
  ).then((r) => r.rows[0].id);
  const occurrenceId = await query(
    `insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at) values ($1,$2,$3,$4) returning id`,
    [scheduleId, TODAY, `${TODAY}T00:00:00Z`, `${TODAY}T23:59:00Z`],
  ).then((r) => r.rows[0].id);
  const assignmentAId = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5) returning id`,
    [occurrenceId, athleteA.athleteId, TODAY, `${TODAY}T00:00:00Z`, `${TODAY}T23:59:00Z`],
  ).then((r) => r.rows[0].id);
  const assignmentBId = await query(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5) returning id`,
    [occurrenceId, athleteB.athleteId, TODAY, `${TODAY}T00:00:00Z`, `${TODAY}T23:59:00Z`],
  ).then((r) => r.rows[0].id);

  const submitA = await api(`/api/training-load/external-assignments/${assignmentAId}/rpe`, { method: "POST", cookie: athleteA.cookie, body: { rpe: 6, durationMinutes: 50 } });
  assert.equal(submitA.status, 201, JSON.stringify(submitA.body));
  const submitB = await api(`/api/training-load/external-assignments/${assignmentBId}/rpe`, { method: "POST", cookie: athleteB.cookie, body: { rpe: 8, durationMinutes: 70 } });
  assert.equal(submitB.status, 201, JSON.stringify(submitB.body));

  const links = await query(
    `select ap.activity_id from training.activity_participant_session_links l
     join training.activity_participants ap on ap.id = l.activity_participant_id
     where l.external_assignment_id = any($1::uuid[])`,
    [[assignmentAId, assignmentBId]],
  );
  assert.equal(links.rowCount, 2, "one confirmed link per athlete");
  assert.equal(links.rows[0].activity_id, links.rows[1].activity_id, "both athletes must resolve to the exact SAME group activity");

  const activityCount = await query(`select count(*)::int as n from training.activities where id=$1`, [links.rows[0].activity_id]);
  assert.equal(activityCount.rows[0].n, 1);
});

// ------------------------------------------------------------
// E. Draft-only gate atomicity (Correction round 3, item 1): a plan-level
// Training Load settings PATCH or a session trackingEnabled/rpeEnabled
// PATCH racing a real, genuine-draft Submit (POST /plans/:planId/submit,
// the never-yet-submitted branch) on the SAME plan - deterministically
// proven both orderings via a real held Postgres lock (never a sleep/
// timing guess). A raw client (`lockClient`) BEGINs and takes
// `select ... for update` on the plan's own plans.plans row - the exact
// lock lockDraftPlanOrReject's own SELECT (and Submit's own single-
// statement UPDATE, which takes the same row's write lock as part of
// running) contend for - so a concurrent real HTTP request against that
// SAME row provably blocks behind it. waitUntilBlocked polls
// pg_stat_activity for any OTHER backend (excluding lockClient's and the
// monitor's own pids) sitting in wait_event_type='Lock'.
// ------------------------------------------------------------

async function waitUntilBlocked(monitorClient, excludePids, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await monitorClient.query(
      `select pid from pg_stat_activity where wait_event_type = 'Lock' and pid <> all($1::int[])`,
      [excludePids],
    );
    if (r.rowCount > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
}

test("E1. plan default atomicity: a settings PATCH that wins the row lock first commits, and a concurrent genuine-draft Submit then waits and publishes that SAME new default", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  // Real content, not just a bare session - Submit's own PRE-EXISTING
  // "empty draft is discarded" behavior (removeEmptyDraftOnSubmit,
  // unrelated to this correction round) would otherwise delete the whole
  // plan tree in its OWN separate transaction the instant Submit runs,
  // regardless of this test's own lock - a real, previously-undetected
  // deadlock between that unrelated delete path and lockClient's held
  // row lock, not a flaw in the draft-only gate itself.
  const sessionRes = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  assert.equal(sessionRes.status, 201, JSON.stringify(sessionRes.body));
  const sessionId = sessionRes.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main").id;
  const nodeRes = await api(`/api/builder/sessions/${sessionId}/nodes`, { method: "POST", cookie: coach.cookie, body: { nodeType: "section", name: "Warm-up" } });
  assert.equal(nodeRes.status, 201, JSON.stringify(nodeRes.body));

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("select id from plans.plans where id = $1 for update", [planId]);

    const submitPromise = api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: coach.cookie });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "Submit must be directly observed Lock-waiting behind the settings PATCH's own held lock");

    // The exact write PATCH /training-load-settings itself would run,
    // under the SAME held transaction/lock (lockClient stands in for
    // "the PATCH got there first" - a real HTTP request can't be used
    // for this side, since the whole point is holding the row's lock for
    // a controllable, observable duration).
    await lockClient.query(
      "update plans.plans set track_training_load_default = true, request_rpe_default = true, updated_at = now() where id = $1",
      [planId],
    );
    await lockClient.query("commit");

    const submitRes = await submitPromise;
    assert.equal(submitRes.status, 200, `expected Submit to succeed once unblocked, got ${submitRes.status}: ${JSON.stringify(submitRes.body)}`);
    assert.equal(submitRes.body.plan.status, "active");
    assert.equal(submitRes.body.plan.trackTrainingLoadDefault, true, "the PUBLISHED plan must carry the setting that committed first, not a stale pre-lock value");
    assert.equal(submitRes.body.plan.requestRpeDefault, true);
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }
});

test("E2. plan default atomicity: a genuine-draft Submit that wins the row lock first commits (activating the plan), and a concurrent settings PATCH then waits and is rejected 409 - never mutating the now-active plan", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId } = await makeRealPlanViaApi(coach, athlete.externalId);

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    // The EXACT statement the genuine-draft Submit branch itself runs -
    // a plain UPDATE already takes the row's write lock as part of
    // running (see that route's own comment on why no separate SELECT
    // FOR UPDATE is needed there).
    await lockClient.query(
      "update plans.plans set status = 'active', updated_at = now() where id = $1 and status = 'draft' returning id",
      [planId],
    );

    const patchPromise = api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "the settings PATCH must be directly observed Lock-waiting behind Submit's own held lock");

    await lockClient.query("commit");

    const patchRes = await patchPromise;
    assert.equal(patchRes.status, 409, `expected 409 once the plan is already active, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.equal(patchRes.body.error, "notDraft");
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }

  const row = (await query(`select status, track_training_load_default, request_rpe_default from plans.plans where id = $1`, [planId])).rows[0];
  assert.equal(row.status, "active");
  assert.equal(row.track_training_load_default, false, "the rejected PATCH must have changed zero rows");
  assert.equal(row.request_rpe_default, false);
});

test("E3. session tracking/RPE atomicity: a session PATCH that wins the row lock first commits, and a concurrent genuine-draft Submit then waits and publishes that SAME session state", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  const sessionRes = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  assert.equal(sessionRes.status, 201, JSON.stringify(sessionRes.body));
  const sessionId = sessionRes.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main").id;
  // Real content, not just a bare session - see E1's own comment on why
  // (Submit's PRE-EXISTING, unrelated "empty draft is discarded" behavior
  // would otherwise delete the whole plan tree in its own transaction).
  const nodeRes = await api(`/api/builder/sessions/${sessionId}/nodes`, { method: "POST", cookie: coach.cookie, body: { nodeType: "section", name: "Warm-up" } });
  assert.equal(nodeRes.status, 201, JSON.stringify(nodeRes.body));

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("select id from plans.plans where id = $1 for update", [planId]);

    const submitPromise = api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: coach.cookie });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "Submit must be directly observed Lock-waiting behind the session PATCH's own held plan-row lock");

    await lockClient.query(
      "update plans.plan_sessions set training_load_enabled = true, rpe_enabled = true, updated_at = now() where id = $1",
      [sessionId],
    );
    await lockClient.query("commit");

    const submitRes = await submitPromise;
    assert.equal(submitRes.status, 200, `expected Submit to succeed once unblocked, got ${submitRes.status}: ${JSON.stringify(submitRes.body)}`);
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }

  // The genuine-draft Submit branch only ever flips status - it never
  // touches plan_sessions rows at all (that delete-and-recreate is
  // applyEditDraft's own behavior, for an EDIT-draft specifically) - so
  // the same session id is still the live, published one.
  const row = (await query(`select training_load_enabled, rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0];
  assert.equal(row.training_load_enabled, true, "the published session must carry the setting that committed first");
  assert.equal(row.rpe_enabled, true);
});

test("E4. session tracking/RPE atomicity: a genuine-draft Submit that wins the row lock first commits, and a concurrent session PATCH then waits and is rejected 409 - never mutating the now-active plan's session", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);
  const sessionRes = await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
  assert.equal(sessionRes.status, 201, JSON.stringify(sessionRes.body));
  const sessionId = sessionRes.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main").id;

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query(
      "update plans.plans set status = 'active', updated_at = now() where id = $1 and status = 'draft' returning id",
      [planId],
    );

    const patchPromise = api(`/api/builder/sessions/${sessionId}`, { method: "PATCH", cookie: coach.cookie, body: { trackingEnabled: true, rpeEnabled: true } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "the session PATCH must be directly observed Lock-waiting behind Submit's own held lock");

    await lockClient.query("commit");

    const patchRes = await patchPromise;
    assert.equal(patchRes.status, 409, `expected 409 once the plan is already active, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.equal(patchRes.body.error, "notDraft");
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }

  const row = (await query(`select training_load_enabled, rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0];
  assert.equal(row.training_load_enabled, false, "the rejected PATCH must have changed zero rows");
  assert.equal(row.rpe_enabled, false);
});

// ------------------------------------------------------------
// F. New-session-creation vs plan defaults atomicity (Correction round 4,
// item 1): POST /blocks/:blockId/sessions used to read block.plan.
// track_training_load_default/request_rpe_default from an UNLOCKED
// access-check snapshot taken before this route's own transaction even
// opened - a concurrent settings PATCH could commit a new default in the
// gap, and a brand-new 'T' session would be stamped with an already-
// superseded value. Same deterministic single-row lock order as every
// other defaults-reading/draft-mutating route (lockDraftPlanOrReject's
// own header comment) - both orderings proven via a real held Postgres
// lock, never a sleep/timing guess.
// ------------------------------------------------------------

test("F1. new-session-creation vs plan defaults atomicity: a settings PATCH that wins the plan row lock first commits, and a concurrent session-create then waits and inherits that SAME new default", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("select id from plans.plans where id = $1 for update", [planId]);

    const createPromise = api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie: coach.cookie, body: { bta: "T", name: "Main" } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "session-create must be directly observed Lock-waiting behind the settings PATCH's own held lock");

    // The exact write PATCH /training-load-settings itself would run,
    // under the SAME held transaction/lock (lockClient stands in for
    // "the PATCH got there first").
    await lockClient.query(
      "update plans.plans set track_training_load_default = true, request_rpe_default = true, updated_at = now() where id = $1",
      [planId],
    );
    await lockClient.query("commit");

    const createRes = await createPromise;
    assert.equal(createRes.status, 201, `expected session-create to succeed once unblocked, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
    const created = createRes.body.blocks.find((b) => b.id === blockId).sessions.find((s) => s.name === "Main");
    assert.equal(created.trackingEnabled, true, "the NEW session must inherit the setting that committed first, not a stale pre-lock snapshot");
    assert.equal(created.rpeEnabled, true);
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }
});

test("F2. new-session-creation vs plan defaults atomicity: a session-create that wins the plan row lock first commits using the THEN-current defaults, and a concurrent settings PATCH then waits - the just-created session is never retroactively changed by it", async () => {
  const coach = await makeCoachWithClub();
  const athlete = await makeAthleteInClub(coach.clubId);
  const { planId, blockId } = await makeRealPlanViaApi(coach, athlete.externalId);

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("select id from plans.plans where id = $1 for update", [planId]);

    const patchPromise = api(`/api/builder/plans/${planId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "the settings PATCH must be directly observed Lock-waiting behind the session-create's own held lock");

    // The exact insert POST /blocks/:blockId/sessions itself would run,
    // under the SAME held transaction/lock, using the plan's own
    // defaults AS THEY STOOD when this lock was acquired - both still
    // false/false (the plan was just created via makeRealPlanViaApi).
    const orderResult = await lockClient.query(`select coalesce(max(session_order), 0) + 1 as next_value from plans.plan_sessions where plan_day_id = $1`, [blockId]);
    const sessionInsert = await lockClient.query(
      `insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name, training_load_enabled, rpe_enabled) values ($1, null, 'T', $2, 'Main', false, false) returning id`,
      [blockId, orderResult.rows[0].next_value],
    );
    const sessionId = sessionInsert.rows[0].id;
    await lockClient.query("commit");

    const patchRes = await patchPromise;
    assert.equal(patchRes.status, 200, `expected the settings PATCH to succeed once unblocked, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.equal(patchRes.body.plan.trackTrainingLoadDefault, true, "the LATER settings change itself must still succeed normally");

    const row = (await query(`select training_load_enabled, rpe_enabled from plans.plan_sessions where id = $1`, [sessionId])).rows[0];
    assert.equal(row.training_load_enabled, false, "the already-created session must never be retroactively changed by a LATER settings change - defaults only ever apply to sessions created AFTER they're saved");
    assert.equal(row.rpe_enabled, false);
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }
});

// ------------------------------------------------------------
// G. Batch sync + Submit atomicity (Correction round 4, item 2): a
// multi-athlete batch's own settings/session-content sync and its
// activation used to run as TWO separate transactions (syncBatchFromPlan's
// own self-managed one, then Submit's own activation UPDATE in a second) -
// a concurrent settings/session PATCH landing in the gap between them
// could commit against the source (or a sibling) after sync already
// copied the OLD state onto every sibling, permanently diverging them the
// instant activation published all of them. Now one atomic unit
// (syncAndActivateBatchWithClient) - both orderings proven via a real
// held Postgres lock on the source plan's own row (the first row
// lockBatchPlansForUpdate's own ascending-id lock order reaches for a
// 2-athlete batch, since a fresh UUID's sort position relative to the
// source is arbitrary in general, but this test creates the source
// first and only needs ONE held lock to prove the ordering - whichever
// row it locks, sync/activation for the WHOLE batch is provably gated
// behind it).
// ------------------------------------------------------------

async function makeRealBatchViaApi(coach, athleteExternalIds) {
  const created = await api("/api/builder/plans", {
    method: "POST", cookie: coach.cookie,
    body: { planType: "weekly", weekStart: WEEK_START, athleteIds: athleteExternalIds },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sourcePlanId = created.body.plan.id;
  const batchRows = (await query(
    `select id, athlete_id from plans.plans where builder_batch_id = (select builder_batch_id from plans.plans where id = $1) order by created_at`,
    [sourcePlanId],
  )).rows;
  for (const row of batchRows) cleanupPlanIds.add(row.id);
  // Real content on every batch member - the app's own PRE-EXISTING
  // "empty draft is discarded on submit" behavior (unrelated to this
  // correction round - see the earlier E1/E3 tests' own comment) would
  // otherwise delete the whole batch the instant Submit runs.
  for (const row of batchRows) {
    const dayResult = await query(`select id from plans.plan_days where plan_id = $1 order by day_order limit 1`, [row.id]);
    const sessionResult = await query(
      `insert into plans.plan_sessions (plan_day_id, session_order, name, bta) values ($1, 1, 'Main', 'T') returning id`,
      [dayResult.rows[0].id],
    );
    await query(`insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1, 'section', 'Warm-up', 1)`, [sessionResult.rows[0].id]);
  }
  return { sourcePlanId, batchRows };
}

test("G1. batch sync + Submit atomicity: a settings/session change that wins the source plan's row lock first commits, and a concurrent batch Submit then waits and publishes that SAME identical configuration to every athlete", async () => {
  const coach = await makeCoachWithClub();
  const athleteA = await makeAthleteInClub(coach.clubId);
  const athleteB = await makeAthleteInClub(coach.clubId);
  const { sourcePlanId, batchRows } = await makeRealBatchViaApi(coach, [athleteA.externalId, athleteB.externalId]);
  assert.equal(batchRows.length, 2, "sanity: a 2-athlete batch must create 2 plan rows");

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("select id from plans.plans where id = $1 for update", [sourcePlanId]);

    const submitPromise = api(`/api/builder/plans/${sourcePlanId}/submit`, { method: "POST", cookie: coach.cookie, body: { syncBatch: true } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "batch Submit must be directly observed Lock-waiting behind the settings PATCH's own held lock on the source row");

    // The exact write PATCH /training-load-settings itself would run
    // against the SOURCE plan, under the SAME held transaction/lock.
    await lockClient.query(
      "update plans.plans set track_training_load_default = true, request_rpe_default = true, updated_at = now() where id = $1",
      [sourcePlanId],
    );
    await lockClient.query("commit");

    const submitRes = await submitPromise;
    assert.equal(submitRes.status, 200, `expected batch Submit to succeed once unblocked, got ${submitRes.status}: ${JSON.stringify(submitRes.body)}`);
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }

  const rows = await query(
    `select id, status, track_training_load_default, request_rpe_default from plans.plans where id = any($1::uuid[])`,
    [batchRows.map((r) => r.id)],
  );
  for (const row of rows.rows) {
    assert.equal(row.status, "active", `plan ${row.id} must be activated`);
    assert.equal(row.track_training_load_default, true, `plan ${row.id} must carry the setting that committed first - every athlete must end up with the SAME identical configuration`);
    assert.equal(row.request_rpe_default, true);
  }
});

test("G2. batch sync + Submit atomicity: a batch Submit that wins the source plan's row lock first commits (activating every plan in the batch, mutually consistent), and a concurrent draft-only settings PATCH then waits and is rejected 409 - never mutating an already-active plan", async () => {
  const coach = await makeCoachWithClub();
  const athleteA = await makeAthleteInClub(coach.clubId);
  const athleteB = await makeAthleteInClub(coach.clubId);
  const { sourcePlanId, batchRows } = await makeRealBatchViaApi(coach, [athleteA.externalId, athleteB.externalId]);
  assert.equal(batchRows.length, 2, "sanity: a 2-athlete batch must create 2 plan rows");

  const lockClient = await pool.connect();
  const monitor = await pool.connect();
  try {
    await lockClient.query("begin");
    // The EXACT statement the genuine (non-batch-conditional) activation
    // itself runs against the source row as part of Submit's own batch
    // path - a plain UPDATE already takes the row's write lock as part
    // of running.
    await lockClient.query(
      "update plans.plans set status = 'active', updated_at = now() where id = $1 and status = 'draft' returning id",
      [sourcePlanId],
    );

    const patchPromise = api(`/api/builder/plans/${sourcePlanId}/training-load-settings`, { method: "PATCH", cookie: coach.cookie, body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
    const blocked = await waitUntilBlocked(monitor, [lockClient.processID, monitor.processID]);
    assert.equal(blocked, true, "the settings PATCH must be directly observed Lock-waiting behind Submit's own held lock on the source row");

    // Also activate the sibling directly (simulating the REST of Submit's
    // own atomic batch-activation, which this raw client stands in for)
    // before committing, so the "every activated plan stays mutually
    // consistent" assertion below has real, matching rows to check.
    const siblingId = batchRows.find((r) => String(r.id) !== String(sourcePlanId)).id;
    await lockClient.query("update plans.plans set status = 'active', updated_at = now() where id = $1 and status = 'draft'", [siblingId]);
    await lockClient.query("commit");

    const patchRes = await patchPromise;
    assert.equal(patchRes.status, 409, `expected 409 once the source plan is already active, got ${patchRes.status}: ${JSON.stringify(patchRes.body)}`);
    assert.equal(patchRes.body.error, "notDraft");
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
    monitor.release();
  }

  const rows = await query(
    `select id, status, track_training_load_default, request_rpe_default from plans.plans where id = any($1::uuid[])`,
    [batchRows.map((r) => r.id)],
  );
  for (const row of rows.rows) {
    assert.equal(row.status, "active", `plan ${row.id} must be activated`);
    assert.equal(row.track_training_load_default, false, "the rejected PATCH must have changed zero rows on any batch member");
    assert.equal(row.request_rpe_default, false);
  }
  assert.equal(rows.rows[0].track_training_load_default, rows.rows[1].track_training_load_default, "every activated plan in the batch must stay mutually consistent");
});
