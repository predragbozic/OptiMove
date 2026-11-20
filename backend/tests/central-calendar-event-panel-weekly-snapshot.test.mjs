// The event panel package's condition (stream manager, build PR): every existing
// consumer of GET /api/training-load/weekly gets the same answer byte for byte,
// apart from the two new fields of the planned rows (logicalSessionId,
// sessionOrder). This file pins the whole answer - a coach's (live rated and
// unrated sessions, an orphaned result, an RPE request) and the athlete's own -
// as normalised JSON text with those two fields taken out. The same file passes
// on the commit before the package (where the fields do not exist) and after it,
// which is the before / after proof.
//
// One disposable database through the calendar fixture; the real app over
// HTTP; invented people only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addDays, startCalendarApp } from "./support/calendar-fixture.mjs";

// A fixed week in the past, so the answer does not depend on today.
const WEEK = "2026-03-02";
const DAY = "2026-03-03";
const ADDED = new Set(["logicalSessionId", "sessionOrder"]);

let env;
let q;
let api;
let fx;
before(async () => {
  env = await startCalendarApp({ label: "evsnap" });
  ({ q, api, fx } = env);
});
after(async () => {
  if (env) await env.stop();
});

// Ids become <id1>, <id2>... in order of first appearance; times become <time>.
function normalise(answer) {
  const ids = new Map();
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) if (!ADDED.has(k)) out[k] = walk(v, k);
      return out;
    }
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      if (!ids.has(value)) ids.set(value, `<id${ids.size + 1}>`);
      return ids.get(value);
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "<time>";
    return value;
  };
  return JSON.stringify(walk(answer));
}

async function world() {
  const clubId = await fx.makeClub("snap club");
  const teamId = await fx.makeTeam(clubId, "snap team");
  const coach = await fx.coachOf(teamId, "snap coach");
  const ana = await fx.makeAthlete("Anaxa Snap", { clubId, teamId });
  await q(`insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at) values ('team',$1,true,'2000-01-01T00:00:00Z')`, [teamId]);
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
     values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`, [coach.id, ana.athleteId, WEEK]))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, teamId]);
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, DAY]))[0].id;
  const session = async (name, order) => {
    const logical = crypto.randomUUID();
    await q(`insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
             values ($1,$2,'AM','T',$3,'09:00',true,true,$4)`, [dayId, name, order, logical]);
    return logical;
  };
  const rated = await session("Training one", 1);
  await session("Training two", 2);
  const feedback = (logical, rpe, minutes) => q(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes) values ($1,$2,$3,'planned',$4,$5)`,
    [ana.athleteId, DAY, logical, rpe, minutes]);
  await feedback(rated, 7, 60);
  await feedback(crypto.randomUUID(), 4, 30); // an orphaned result: its session is gone
  // An RPE request of the team on the same day, answered.
  const scheduleId = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_team_id)
     values ('one_time','UTC',$1,'17:00','23:59','active','Away match','match',$2,'team',$3) returning id`, [DAY, coach.id, teamId]))[0].id;
  await q(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, teamId]);
  const occurrenceId = (await q(
    `insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status) values ($1,$2,$3,$4,'closed') returning id`,
    [scheduleId, DAY, `${DAY}T17:00:00Z`, `${DAY}T23:59:00Z`]))[0].id;
  const assignmentId = (await q(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, started_at, completed_at)
     values ($1,$2,'UTC',$3,$4,$5,'completed',$6,$6) returning id`,
    [occurrenceId, ana.athleteId, DAY, `${DAY}T17:00:00Z`, `${DAY}T23:59:00Z`, `${DAY}T18:30:00Z`]))[0].id;
  await q(`insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, event_name, rpe, duration_minutes) values ($1,$2,$3,'scheduled_external','Away match',6,90)`,
    [ana.athleteId, DAY, assignmentId]);
  return { coach, ana };
}

let snapshots;
test("S0. the world's answers are read (coach and athlete)", async () => {
  const w = await world();
  const coach = await api(`/api/training-load/weekly?weekStart=${WEEK}`, { cookie: w.coach.cookie });
  assert.equal(coach.status, 200, coach.text);
  const athlete = await api(`/api/training-load/weekly?weekStart=${WEEK}`, { cookie: w.ana.cookie });
  assert.equal(athlete.status, 200, athlete.text);
  snapshots = { coach: normalise(coach.body), athlete: normalise(athlete.body) };
  if (process.env.PRINT_SNAPSHOT) console.log(JSON.stringify(snapshots, null, 2));
  assert.ok(addDays(WEEK, 1) === DAY);
});

test("S1. the coach's answer, without the two new fields, is byte for byte the pinned one", () => {
  assert.equal(snapshots.coach, COACH);
});

test("S2. the athlete's answer, without the two new fields, is byte for byte the pinned one", () => {
  assert.equal(snapshots.athlete, ATHLETE);
});

// Pinned from the answer (two planned sessions of one slot, one rated; an
// orphaned result; an answered RPE request). Regenerate only with a reason:
// PRINT_SNAPSHOT=1 prints them.
const COACH = "{\"weekStart\":\"2026-03-02\",\"weekEnd\":\"2026-03-08\",\"days\":[{\"date\":\"2026-03-02\",\"sessions\":[]},{\"date\":\"2026-03-03\",\"sessions\":[{\"sessionId\":\"<id1>\",\"sessionName\":\"Training one\",\"amPm\":\"AM\",\"bta\":\"T\",\"sessionTime\":\"09:00:00\",\"planId\":\"<id2>\",\"planName\":\"Week\",\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":7,\"durationMinutes\":60,\"srpe\":420,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":true,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":\"<id4>\",\"sessionName\":\"Training two\",\"amPm\":\"AM\",\"bta\":\"T\",\"sessionTime\":\"09:00:00\",\"planId\":\"<id2>\",\"planName\":\"Week\",\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":false,\"feedback\":null,\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":true,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":null,\"sessionName\":\"\",\"amPm\":\"\",\"bta\":\"\",\"sessionTime\":\"\",\"planId\":null,\"planName\":null,\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":4,\"durationMinutes\":30,\"srpe\":120,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":true,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":false,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":null,\"sessionName\":\"Away match\",\"amPm\":\"\",\"bta\":\"\",\"sessionTime\":\"\",\"planId\":null,\"planName\":null,\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":6,\"durationMinutes\":90,\"srpe\":540,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"status\":\"tracked_rpe_on\",\"source\":\"scheduled_external\",\"externalAssignmentId\":\"<id5>\",\"scheduleId\":\"<id6>\",\"opensAt\":\"<time>\",\"closesAt\":\"<time>\",\"scheduleStatus\":\"active\",\"assignmentStatus\":\"completed\",\"actionable\":false,\"ownershipUnresolved\":false,\"canResolveOwnership\":false}]},{\"date\":\"2026-03-04\",\"sessions\":[]},{\"date\":\"2026-03-05\",\"sessions\":[]},{\"date\":\"2026-03-06\",\"sessions\":[]},{\"date\":\"2026-03-07\",\"sessions\":[]},{\"date\":\"2026-03-08\",\"sessions\":[]}]}";
const ATHLETE = "{\"weekStart\":\"2026-03-02\",\"weekEnd\":\"2026-03-08\",\"days\":[{\"date\":\"2026-03-02\",\"sessions\":[]},{\"date\":\"2026-03-03\",\"sessions\":[{\"sessionId\":\"<id1>\",\"sessionName\":\"Training one\",\"amPm\":\"AM\",\"bta\":\"T\",\"sessionTime\":\"09:00:00\",\"planId\":\"<id2>\",\"planName\":\"Week\",\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":7,\"durationMinutes\":60,\"srpe\":420,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":true,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":\"<id4>\",\"sessionName\":\"Training two\",\"amPm\":\"AM\",\"bta\":\"T\",\"sessionTime\":\"09:00:00\",\"planId\":\"<id2>\",\"planName\":\"Week\",\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":false,\"feedback\":null,\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":true,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":null,\"sessionName\":\"\",\"amPm\":\"\",\"bta\":\"\",\"sessionTime\":\"\",\"planId\":null,\"planName\":null,\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":4,\"durationMinutes\":30,\"srpe\":120,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":true,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"workspacePlannedRpeEnabled\":true,\"actionable\":false,\"status\":\"tracked_rpe_on\",\"ownershipUnresolved\":false,\"canResolveOwnership\":false,\"source\":\"planned\",\"externalAssignmentId\":null,\"scheduleId\":null},{\"sessionId\":null,\"sessionName\":\"Away match\",\"amPm\":\"\",\"bta\":\"\",\"sessionTime\":\"\",\"planId\":null,\"planName\":null,\"athleteId\":\"<id3>\",\"athleteName\":\"Anaxa Snap\",\"rated\":true,\"feedback\":{\"rpe\":6,\"durationMinutes\":90,\"srpe\":540,\"note\":\"\",\"submittedAt\":\"<time>\"},\"historical\":false,\"rpeEnabled\":true,\"trainingLoadEnabled\":true,\"status\":\"tracked_rpe_on\",\"source\":\"scheduled_external\",\"externalAssignmentId\":\"<id5>\",\"scheduleId\":\"<id6>\",\"opensAt\":\"<time>\",\"closesAt\":\"<time>\",\"scheduleStatus\":\"active\",\"assignmentStatus\":\"completed\",\"actionable\":false,\"changeable\":false,\"revision\":0,\"ownershipUnresolved\":false,\"canResolveOwnership\":false}]},{\"date\":\"2026-03-04\",\"sessions\":[]},{\"date\":\"2026-03-05\",\"sessions\":[]},{\"date\":\"2026-03-06\",\"sessions\":[]},{\"date\":\"2026-03-07\",\"sessions\":[]},{\"date\":\"2026-03-08\",\"sessions\":[]}]}";
