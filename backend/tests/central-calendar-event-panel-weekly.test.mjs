// The central calendar's event panel package (docs/ai/central-calendar-event-panel-contract.md,
// sections 1.2, 1.3 and 5): GET /api/training-load/weekly's planned rows carry
// `logicalSessionId` and `sessionOrder` (B1), and nothing else of the read
// changes - the same rows for the same callers (B2). P3 pins the two
// membership rules the panel relies on: the card names an event's athletes by
// membership on the event's day, /weekly by current active membership.
//
// One disposable database through the calendar fixture; the real app over
// HTTP; invented people only. Nothing touches OPTIMOVE or any persistent
// database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addDays, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const PAST = addDays(TODAY, -2);
const TZ = "Europe/Belgrade";

function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}
const WEEK = mondayOf(PAST);

// The planned row's keys before the event panel package, pinned (B2): the
// package adds exactly logicalSessionId and sessionOrder.
const PLANNED_KEYS_BEFORE = [
  "sessionId", "sessionName", "amPm", "bta", "sessionTime", "planId", "planName", "athleteId", "athleteName", "rated", "feedback",
  "historical", "rpeEnabled", "trainingLoadEnabled", "workspacePlannedRpeEnabled", "actionable", "status", "ownershipUnresolved",
  "canResolveOwnership", "source", "externalAssignmentId", "scheduleId",
].sort();
const ADDED = ["logicalSessionId", "sessionOrder"];

let env;
let q;
let api;
let fx;

before(async () => {
  env = await startCalendarApp({ label: "evpanel" });
  ({ q, api, fx } = env);
});

after(async () => {
  if (env) await env.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let seq = 0;
async function squad() {
  seq += 1;
  const clubId = await fx.makeClub(`panel club ${seq}`);
  const teamId = await fx.makeTeam(clubId, `panel team ${seq}`);
  const coach = await fx.coachOf(teamId, `panel coach ${seq}`);
  const ana = await fx.makeAthlete(`Anaxa Panel${seq}`, { clubId, teamId });
  const ben = await fx.makeAthlete(`Benzo Panel${seq}`, { clubId, teamId });
  await q(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at) values ('team',$1,true,'2000-01-01T00:00:00Z')`,
    [teamId],
  );
  return { clubId, teamId, coach, ana, ben };
}
async function plan(athleteId, coachUserId, teamId) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
     values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`,
    [coachUserId, athleteId, WEEK],
  ))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, teamId]);
  return planId;
}
async function session(planId, { date = PAST, name = "Main session", amPm = "AM", bta = "T", order = 1 } = {}) {
  let dayId = (await q(`select id from plans.plan_days where plan_id = $1 and date = $2`, [planId, date]))[0]?.id;
  if (!dayId) dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,true,true,$6) returning id`,
    [dayId, name, amPm, bta, order, logicalSessionId],
  ))[0].id;
  return { planId, sessionId, logicalSessionId };
}
async function rate(athleteId, logicalSessionId, rpe, minutes = 60) {
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, logical_session_id, source, rpe, duration_minutes) values ($1,$2,$3,'planned',$4,$5)`,
    [athleteId, PAST, logicalSessionId, rpe, minutes],
  );
}
async function eventType(cookie, kind = "training") {
  const res = await api("/api/calendar/events/types", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === kind).id;
}
async function event(cookie, targets, title = "Team training") {
  const res = await api("/api/calendar/events", {
    method: "POST", cookie,
    body: { requestKey: newKey(), eventTypeId: await eventType(cookie), title, day: PAST, timezone: TZ, startTime: "10:00", endTime: "11:30", targets },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
const weekly = (cookie, athleteIds = null) =>
  api(`/api/training-load/weekly?weekStart=${WEEK}${athleteIds ? `&athleteIds=${athleteIds.join(",")}` : ""}`, { cookie });
const rows = (res) => (res.body.days || []).flatMap((d) => d.sessions);
const planned = (res) => rows(res).filter((r) => r.source === "planned");
async function card(cookie, eventId) {
  const res = await api(`/api/calendar?from=${PAST}&to=${PAST}&include=athletes`, { cookie });
  assert.equal(res.status, 200, res.text);
  return (res.body.days || []).flatMap((d) => d.items).find((i) => i.kind === "event" && i.links?.eventId === eventId) || null;
}
const without = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !ADDED.includes(k)));

// ---------------------------------------------------------------------------
// B1, B2
// ---------------------------------------------------------------------------
test("B1. a live planned row carries logicalSessionId and sessionOrder; two sessions of one slot carry their own; an orphaned row carries its feedback row's id and sessionOrder null", async () => {
  const s = await squad();
  const anaPlan = await plan(s.ana.athleteId, s.coach.id, s.teamId);
  const first = await session(anaPlan, { name: "Training one", order: 1 });
  const second = await session(anaPlan, { name: "Training two", order: 2 });
  await rate(s.ana.athleteId, second.logicalSessionId, 7);
  const goneId = crypto.randomUUID();
  await rate(s.ana.athleteId, goneId, 4, 30);

  const res = await weekly(s.coach.cookie, [s.ana.athleteId]);
  assert.equal(res.status, 200, res.text);
  const live = planned(res).filter((r) => !r.historical);
  assert.deepEqual(
    live.map((r) => [r.sessionName, r.logicalSessionId, r.sessionOrder, r.amPm, r.bta]),
    [["Training one", first.logicalSessionId, 1, "AM", "T"], ["Training two", second.logicalSessionId, 2, "AM", "T"]],
  );
  assert.equal(live.find((r) => r.logicalSessionId === second.logicalSessionId).feedback.rpe, 7, "the value travels with its own session");
  assert.equal(live.find((r) => r.logicalSessionId === first.logicalSessionId).feedback, null);
  const orphan = planned(res).filter((r) => r.historical);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].logicalSessionId, goneId);
  assert.equal(orphan[0].sessionOrder, null);
  assert.equal(orphan[0].feedback.rpe, 4);
});

test("B2. the scope is unchanged: the planned rows' keys are exactly the earlier keys plus the two fields, for a team coach, a club admin and an athlete; another team's athlete stays absent; external rows gain nothing", async () => {
  const s = await squad();
  const other = await squad();
  const clubAdmin = await fx.clubAdminOf(s.clubId, "panel club admin");
  const anaPlan = await plan(s.ana.athleteId, s.coach.id, s.teamId);
  const benPlan = await plan(s.ben.athleteId, s.coach.id, s.teamId);
  const strangerPlan = await plan(other.ana.athleteId, other.coach.id, other.teamId);
  await session(anaPlan);
  await session(benPlan);
  await session(strangerPlan);
  // An answered RPE request of the team, so external rows are in the answer too.
  const scheduleId = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_team_id)
     values ('one_time','UTC',$1,'17:00','23:59','active','Away match','match',$2,'team',$3) returning id`, [PAST, s.coach.id, s.teamId]))[0].id;
  await q(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_team_id) values ($1,'team',$2)`, [scheduleId, s.teamId]);
  const occurrenceId = (await q(
    `insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status) values ($1,$2,$3,$4,'closed') returning id`,
    [scheduleId, PAST, `${PAST}T17:00:00Z`, `${PAST}T23:59:00Z`]))[0].id;
  const assignmentId = (await q(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, started_at, completed_at)
     values ($1,$2,'UTC',$3,$4,$5,'completed',$6,$6) returning id`,
    [occurrenceId, s.ana.athleteId, PAST, `${PAST}T17:00:00Z`, `${PAST}T23:59:00Z`, `${PAST}T18:30:00Z`]))[0].id;
  await q(`insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, event_name, rpe, duration_minutes) values ($1,$2,$3,'scheduled_external','Away match',6,90)`,
    [s.ana.athleteId, PAST, assignmentId]);

  for (const [who, cookie, expected] of [
    ["team coach", s.coach.cookie, [s.ana.athleteId, s.ben.athleteId]],
    ["club admin", clubAdmin.cookie, [s.ana.athleteId, s.ben.athleteId]],
    ["athlete", s.ana.cookie, [s.ana.athleteId]],
  ]) {
    const res = await weekly(cookie);
    assert.equal(res.status, 200, `${who}: ${res.text}`);
    const mine = planned(res).filter((r) => [s.ana.athleteId, s.ben.athleteId, other.ana.athleteId].includes(r.athleteId));
    assert.deepEqual([...new Set(mine.map((r) => r.athleteId))].sort(), [...expected].sort(), `${who}: the same athletes`);
    assert.ok(!res.text.includes(other.ana.athleteId), `${who}: another team's athlete is absent`);
    for (const row of mine) {
      assert.deepEqual(Object.keys(row).sort(), [...PLANNED_KEYS_BEFORE, ...ADDED].sort(), `${who}: the keys`);
      assert.deepEqual(Object.keys(without(row)).sort(), PLANNED_KEYS_BEFORE, `${who}: nothing else`);
    }
    assert.ok(rows(res).some((r) => r.source === "scheduled_external" && r.athleteId === s.ana.athleteId), `${who}: the external row is there`);
    for (const row of rows(res).filter((r) => r.source === "scheduled_external")) {
      for (const k of ADDED) assert.ok(!(k in row), `${who}: an external row gains no ${k}`);
    }
  }
});

// ---------------------------------------------------------------------------
// P3: the two membership rules (contract section 1.2)
// ---------------------------------------------------------------------------
test("P3a. the manager of a team event and the manager of a club event each get every CURRENT member among the event's athletes", async () => {
  const s = await squad();
  const clubAdmin = await fx.clubAdminOf(s.clubId, "panel club admin");
  await session(await plan(s.ana.athleteId, s.coach.id, s.teamId));
  await session(await plan(s.ben.athleteId, s.coach.id, s.teamId));

  for (const [who, cookie, targets] of [
    ["team event, team coach", s.coach.cookie, [{ kind: "team", id: s.teamId }]],
    ["club event, club admin", clubAdmin.cookie, [{ kind: "club", id: s.clubId }]],
  ]) {
    const ev = await event(cookie, targets);
    const c = await card(cookie, ev.id);
    assert.ok(c, `${who}: the card`);
    const ids = c.athletes.filter((a) => a.targeted !== false).map((a) => a.athleteId);
    assert.deepEqual([...ids].sort(), [s.ana.athleteId, s.ben.athleteId].sort(), `${who}: the card's athletes`);
    const res = await weekly(cookie, ids);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...new Set(planned(res).map((r) => r.athleteId))].sort(), [...ids].sort(), `${who}: every current member is in /weekly`);
  }
});

test("P3b. an athlete whose membership ended after the event's day is on the card and absent from /weekly (fail closed: her state, no value)", async () => {
  const s = await squad();
  const benSession = await session(await plan(s.ben.athleteId, s.coach.id, s.teamId));
  await session(await plan(s.ana.athleteId, s.coach.id, s.teamId));
  await rate(s.ben.athleteId, benSession.logicalSessionId, 8);
  const ev = await event(s.coach.cookie, [{ kind: "team", id: s.teamId }]);
  await q(
    `update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where athlete_id = $1`,
    [s.ben.athleteId, `${addDays(TODAY, -1)}T10:00:00Z`],
  );
  const c = await card(s.coach.cookie, ev.id);
  assert.ok(c.athletes.some((a) => a.athleteId === s.ben.athleteId), "she is on the card (member on the event's day)");
  const res = await weekly(s.coach.cookie, c.athletes.map((a) => a.athleteId));
  assert.equal(res.status, 200, res.text);
  assert.ok(!res.text.includes(s.ben.athleteId), "she is absent from /weekly (current active membership)");
  assert.ok(planned(res).some((r) => r.athleteId === s.ana.athleteId), "the current member is there");
});

test("P3c. a club admin in the club workspace, a club event and a team-only athlete of the club: on the card and in /weekly as the code decides (recorded)", async () => {
  const s = await squad();
  const clubAdmin = await fx.clubAdminOf(s.clubId, "panel club admin");
  // A team-only athlete: a team membership in the club and no club membership row.
  const userId = await fx.makeUser("Cyra TeamOnly");
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name) values ($1,'Cyra TeamOnly','Cyra TeamOnly') returning id`, [userId]))[0].id;
  await fx.addMembership({ athleteId, clubId: s.clubId, teamId: s.teamId });
  await session(await plan(athleteId, s.coach.id, s.teamId));
  const ev = await event(clubAdmin.cookie, [{ kind: "club", id: s.clubId }]);
  const c = await card(clubAdmin.cookie, ev.id);
  const onCard = c.athletes.some((a) => a.athleteId === athleteId && a.targeted !== false);
  const res = await weekly(clubAdmin.cookie, [athleteId]);
  assert.equal(res.status, 200, res.text);
  const inWeekly = planned(res).some((r) => r.athleteId === athleteId);
  // Recorded behaviour: a club target needs a club membership (calendarAccess.js
  // targetsAthleteSql) and the club workspace's /weekly scope needs one too
  // (coachWorkspaceScopeSqlForWorkspace), so the team-only athlete is on
  // neither. The two rules agree here; no value can be missing for her.
  assert.deepEqual({ onCard, inWeekly }, { onCard: false, inWeekly: false });
});
