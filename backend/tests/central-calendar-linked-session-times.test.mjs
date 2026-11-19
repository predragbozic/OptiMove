// Central calendar K3 / K2c-3, section 7 with O14 (docs/ai/central-calendar-k3-plan.md):
// a session linked to a calendar event and without a time of its own shows the
// event's time; a session with its own time keeps it. The time is read from
// the event (linkedSessionTimes.js), never copied into the plan.
//
// One disposable database through the calendar fixture (the real runner, v49
// links included); invented people only. Nothing touches OPTIMOVE or any
// persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const DAY = addDays(TODAY, 3);
const TZ = "Europe/Belgrade";

let env;
let q;
let api;
let fx;
let m;
let linkedSessionTimes;
let buildWeeks;

before(async () => {
  env = await startCalendarApp({ label: "lst" });
  ({ q, api, fx } = env);
  m = await calendarRoleMatrix(env, "lst");
  ({ linkedSessionTimes } = await import("../src/linkedSessionTimes.js"));
  ({ buildWeeks } = await import("../src/utils/grouping.js"));
  // The scaffold's plans.v_weekly_plan_items is a stand-in with one column;
  // the weekly route reads the real one's columns, so a stand-in with those
  // columns (one row per session, no items) replaces it for test 9.
  await q(`drop view if exists plans.v_weekly_plan_items`);
  await q(`create view plans.v_weekly_plan_items as
    select p.id as plan_id, p.name as plan_name, p.week_start, p.athlete_id as athlete_uuid, a.id::text as athlete_id,
           null::text as athlete_source_external_id, a.display_name as athlete_name, null::text as athlete_image_url,
           pd.date, pd.day_order, null::text as day_note, ps.id as plan_session_id, ps.am_pm, ps.bta, ps.session_order,
           ps.session_time, ps.name as session_name, null::uuid as plan_item_id, null::uuid as plan_node_id,
           null::text as item_type, null::int as item_order, null::text as hierarchy_sort_path, null::text as source_row_ref
      from plans.plans p join public.athletes a on a.id = p.athlete_id
      join plans.plan_days pd on pd.plan_id = p.id join plans.plan_sessions ps on ps.plan_day_id = pd.id
     where p.plan_type = 'weekly' and p.status = 'active' and coalesce(p.is_active, true) and not coalesce(p.is_edit_draft, false)`);
});

after(async () => {
  if (env) await env.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function teamWorld(label, { n = 2 } = {}) {
  const team = await fx.makeTeam(m.clubs.c1, `lst ${label}`);
  const coach = await fx.coachOf(team, `lst coach ${label}`);
  const athletes = [];
  for (let i = 0; i < n; i += 1) athletes.push(await fx.makeAthlete(`lst ${label} A${i + 1}`, { clubId: m.clubs.c1, teamId: team }));
  return { team, coach, athletes };
}
async function planSession({ athleteId, team, coachUserId, date = DAY, name = "Main session", amPm = "AM", bta = "T", order = 1, time = null }) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
     values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`,
    [coachUserId, athleteId, date],
  ))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, team]);
  return { planId, ...(await addSession({ planId, date, name, amPm, bta, order, time })) };
}
async function addSession({ planId, date, name = "Main session", amPm = "AM", bta = "T", order = 1, time = null }) {
  let dayId = (await q(`select id from plans.plan_days where plan_id = $1 and date = $2`, [planId, date]))[0]?.id;
  if (!dayId) dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,$6,false,true,$7) returning id`,
    [dayId, name, amPm, bta, order, time, logicalSessionId],
  ))[0].id;
  return { sessionId, logicalSessionId };
}
async function trainingType(team) {
  const res = await api("/api/calendar/events/types", { cookie: team.coach.cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === "training").id;
}
async function makeEvent(w, { day = DAY, endDay, startTime = "10:00", endTime = "11:30", targets } = {}) {
  const body = {
    requestKey: newKey(), eventTypeId: await trainingType(w), title: "Training", day, timezone: TZ,
    targets: targets || [{ kind: "team", id: w.team }],
    ...(endDay ? { endDay } : {}), ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}),
  };
  const res = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function attach(w, event, logicalSessionIds) {
  const res = await api(`/api/calendar/events/${event.id}/sessions`, {
    method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: event.revision, logicalSessionIds },
  });
  assert.equal(res.status, 200, res.text);
  return res.body.event;
}
// The rows a weekly reader gets for `planIds` (the stand-in view of before()).
async function rowsOf(planIds) {
  return q(`select * from plans.v_weekly_plan_items where plan_id = any($1::uuid[]) order by date, session_order`, [planIds]);
}
function counting() {
  let count = 0;
  return { count: () => count, queryable: { query: (sql, params) => { count += 1; return env.admin.query(sql, params); } } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("1. a linked session without its own time gets the event's start and end; a session with its own time keeps it (O14); an unlinked one gets nothing", async () => {
  const w = await teamWorld("one");
  const [a1, a2] = w.athletes;
  const s1 = await planSession({ athleteId: a1.athleteId, team: w.team, coachUserId: w.coach.id });
  const s2 = await planSession({ athleteId: a2.athleteId, team: w.team, coachUserId: w.coach.id, time: "10:30" });
  const free = await addSession({ planId: s1.planId, date: DAY, name: "Extra", amPm: "PM", order: 2 });
  const event = await makeEvent(w);
  await attach(w, event, [s1.logicalSessionId, s2.logicalSessionId]);
  const rows = await rowsOf([s1.planId, s2.planId]);
  await linkedSessionTimes(env.admin, rows);
  const linked = rows.find((r) => r.plan_session_id === s1.sessionId);
  assert.equal(linked.linked_event_start_time, "10:00");
  assert.equal(linked.linked_event_end_time, "11:30");
  const own = rows.find((r) => r.plan_session_id === s2.sessionId);
  assert.equal(own.linked_event_start_time, undefined, "a session with its own time is left as it is");
  assert.equal(String(own.session_time).slice(0, 5), "10:30");
  const unlinked = rows.find((r) => r.plan_session_id === free.sessionId);
  assert.equal(unlinked.linked_event_start_time, undefined);
});

test("2. buildWeeks: the event's time is the session's time, marked as from the event; its own time wins and is not marked", async () => {
  const items = buildWeeks([
    { plan_id: "p", date: DAY, week_start: DAY, am_pm: "AM", bta: "T", session_name: "From event", session_time: null, linked_event_start_time: "10:00", linked_event_end_time: "11:30" },
    { plan_id: "p", date: DAY, week_start: DAY, am_pm: "PM", bta: "T", session_name: "Own", session_time: "17:15:00", linked_event_start_time: "10:00", linked_event_end_time: "11:30" },
    { plan_id: "p", date: DAY, week_start: DAY, am_pm: "PM", bta: "A", session_name: "None", session_time: null },
    { plan_id: "p", date: DAY, week_start: DAY, am_pm: "AM", bta: "A", session_name: "Last day", session_time: null, linked_event_start_time: null, linked_event_end_time: "16:00" },
  ]);
  const flat = JSON.stringify(items);
  const all = [];
  JSON.parse(flat, (key, value) => { if (value && typeof value === "object" && "sessionName" in value) all.push(value); return value; });
  const byName = (name) => all.find((x) => x.sessionName === name);
  assert.equal(byName("From event").sessionTime, "10:00");
  assert.equal(byName("From event").sessionTimeFromEvent, true);
  assert.equal(byName("From event").sessionEndTime, "11:30");
  assert.equal(byName("Own").sessionTime, "17:15");
  assert.equal(byName("Own").sessionTimeFromEvent, false);
  assert.equal(byName("Own").sessionEndTime, "");
  assert.equal(byName("None").sessionTime, "");
  assert.equal(byName("None").sessionTimeFromEvent, false);
  // A multi-day event's last day: only its end, still marked as the event's.
  assert.equal(byName("Last day").sessionTime, "");
  assert.equal(byName("Last day").sessionEndTime, "16:00");
  assert.equal(byName("Last day").sessionTimeFromEvent, true);
});

test("3. a cancelled event's time is never used", async () => {
  const w = await teamWorld("cancel", { n: 1 });
  const s = await planSession({ athleteId: w.athletes[0].athleteId, team: w.team, coachUserId: w.coach.id });
  const event = await attach(w, await makeEvent(w), [s.logicalSessionId]);
  const res = await api(`/api/calendar/events/${event.id}/cancel`, { method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: event.revision } });
  assert.equal(res.status, 200, res.text);
  // The cancel ends the links in its own transaction; the helper's own
  // status filter is the second guard (a raw write that leaves a live link).
  assert.equal((await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and ended_at is null`, [event.id]))[0].n, 0);
  const rows = await rowsOf([s.planId]);
  await linkedSessionTimes(env.admin, rows);
  assert.equal(rows[0].linked_event_start_time, undefined);
});

test("4. an athlete who is no longer a target of the event is not shown its time; the athlete who still is, is", async () => {
  const w = await teamWorld("targets");
  const [a1, a2] = w.athletes;
  const s1 = await planSession({ athleteId: a1.athleteId, team: w.team, coachUserId: w.coach.id });
  const s2 = await planSession({ athleteId: a2.athleteId, team: w.team, coachUserId: w.coach.id });
  const created = await makeEvent(w, { targets: [{ kind: "athlete", id: a1.athleteId }, { kind: "athlete", id: a2.athleteId }] });
  const event = await attach(w, created, [s1.logicalSessionId, s2.logicalSessionId]);
  const res = await api(`/api/calendar/events/${event.id}`, {
    method: "PATCH", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: event.revision, targets: [{ kind: "athlete", id: a1.athleteId }] },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal((await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and ended_at is null`, [event.id]))[0].n, 2, "the second athlete's link is still live");
  const rows = await rowsOf([s1.planId, s2.planId]);
  await linkedSessionTimes(env.admin, rows);
  assert.equal(rows.find((r) => r.plan_session_id === s1.sessionId).linked_event_start_time, "10:00");
  assert.equal(rows.find((r) => r.plan_session_id === s2.sessionId).linked_event_start_time, undefined);
});

test("5. an ended link gives no time", async () => {
  const w = await teamWorld("detach", { n: 1 });
  const s = await planSession({ athleteId: w.athletes[0].athleteId, team: w.team, coachUserId: w.coach.id });
  const event = await attach(w, await makeEvent(w), [s.logicalSessionId]);
  const view = await api(`/api/calendar/events/${event.id}`, { cookie: w.coach.cookie });
  const linkIds = view.body.event.sessionLinks.map((l) => l.id);
  const res = await api(`/api/calendar/events/${event.id}/sessions/detach`, { method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: view.body.event.revision, linkIds } });
  assert.equal(res.status, 200, res.text);
  const rows = await rowsOf([s.planId]);
  await linkedSessionTimes(env.admin, rows);
  assert.equal(rows[0].linked_event_start_time, undefined);
});

test("6. a multi-day event: its start on the first day, its end on the last day, nothing in between", async () => {
  const w = await teamWorld("camp", { n: 1 });
  const a = w.athletes[0];
  const d1 = await planSession({ athleteId: a.athleteId, team: w.team, coachUserId: w.coach.id, date: DAY });
  const d2 = await addSession({ planId: d1.planId, date: addDays(DAY, 1) });
  const d3 = await addSession({ planId: d1.planId, date: addDays(DAY, 2) });
  const created = await makeEvent(w, { day: DAY, endDay: addDays(DAY, 2), startTime: "09:00", endTime: "16:00" });
  await attach(w, created, [d1.logicalSessionId, d2.logicalSessionId, d3.logicalSessionId]);
  const rows = await rowsOf([d1.planId]);
  await linkedSessionTimes(env.admin, rows);
  const on = (date) => rows.find((r) => String(r.date).slice(0, 10) === date);
  assert.deepEqual([on(DAY).linked_event_start_time, on(DAY).linked_event_end_time], ["09:00", null]);
  assert.equal(on(addDays(DAY, 1)).linked_event_start_time, undefined);
  assert.deepEqual([on(addDays(DAY, 2)).linked_event_start_time, on(addDays(DAY, 2)).linked_event_end_time], [null, "16:00"]);
});

test("7. an event without a time gives no time", async () => {
  const w = await teamWorld("notime", { n: 1 });
  const s = await planSession({ athleteId: w.athletes[0].athleteId, team: w.team, coachUserId: w.coach.id });
  await attach(w, await makeEvent(w, { startTime: null, endTime: null }), [s.logicalSessionId]);
  const rows = await rowsOf([s.planId]);
  await linkedSessionTimes(env.admin, rows);
  assert.equal(rows[0].linked_event_start_time, undefined);
});

test("8. one statement for any number of rows, and none when every row has its own time", async () => {
  const w = await teamWorld("count", { n: 3 });
  const sessions = [];
  for (const a of w.athletes) sessions.push(await planSession({ athleteId: a.athleteId, team: w.team, coachUserId: w.coach.id }));
  await attach(w, await makeEvent(w), sessions.map((s) => s.logicalSessionId));
  const rows = await rowsOf(sessions.map((s) => s.planId));
  // The view is one row per item in production: repeat every row, as items do.
  const many = rows.flatMap((r) => [r, { ...r }, { ...r }]);
  const c = counting();
  await linkedSessionTimes(c.queryable, many);
  assert.equal(c.count(), 1);
  assert.ok(many.every((r) => r.linked_event_start_time === "10:00"), "every item row of a linked session gets the time");
  const timed = rows.map((r) => ({ ...r, session_time: "08:00:00" }));
  const c2 = counting();
  await linkedSessionTimes(c2.queryable, timed);
  assert.equal(c2.count(), 0);
  const c3 = counting();
  await linkedSessionTimes(c3.queryable, []);
  assert.equal(c3.count(), 0);
});

test("9. the weekly route GET /api/plans/:planId/weekly shows the event's time for a linked session and its own time otherwise", async () => {
  const w = await teamWorld("route", { n: 1 });
  const a = w.athletes[0];
  const s = await planSession({ athleteId: a.athleteId, team: w.team, coachUserId: w.coach.id });
  const own = await addSession({ planId: s.planId, date: DAY, name: "Own time", amPm: "PM", order: 2, time: "17:00" });
  await attach(w, await makeEvent(w), [s.logicalSessionId, own.logicalSessionId]);
  const res = await api(`/api/plans/${s.planId}/weekly`, { cookie: m.roles.platformAdmin.cookie });
  assert.equal(res.status, 200, res.text);
  const found = [];
  JSON.parse(res.text, (key, value) => { if (value && typeof value === "object" && "sessionName" in value) found.push(value); return value; });
  const byName = (name) => found.find((x) => x.sessionName === name);
  assert.equal(byName("Main session").sessionTime, "10:00");
  assert.equal(byName("Main session").sessionTimeFromEvent, true);
  assert.equal(byName("Own time").sessionTime, "17:00");
  assert.equal(byName("Own time").sessionTimeFromEvent, false);
});

test("10. the athlete weekly reader (athletes.js loadWeeklyData, GET /api/athletes/:id/program-data) shows the linked event's time", async () => {
  const w = await teamWorld("athleteroute", { n: 1 });
  const a = w.athletes[0];
  const s = await planSession({ athleteId: a.athleteId, team: w.team, coachUserId: w.coach.id });
  await attach(w, await makeEvent(w), [s.logicalSessionId]);
  const { loadWeeklyData } = await import("../src/routes/athletes.js");
  // The stand-in view's athlete_id is the athlete's uuid as text, which the reader matches.
  const data = await loadWeeklyData(String(a.athleteId));
  const found = [];
  JSON.parse(JSON.stringify(data.weeks), (key, value) => { if (value && typeof value === "object" && "sessionName" in value) found.push(value); return value; });
  const main = found.find((x) => x.sessionName === "Main session");
  assert.ok(main, "the session is in the athlete's weeks");
  assert.equal(main.sessionTime, "10:00");
  assert.equal(main.sessionTimeFromEvent, true);
});

// The OptiMove manager's NO-GO on #649: the event's time is decoration and
// must never take a plan read down. A failed read of the links (here: the
// table is gone, as in a database without the calendar migrations) answers
// the plan exactly as it is without links.
test("11. a failed event-time read never fails the plan: GET /api/plans/:planId/weekly answers 200, identical to the plan before it had a link", async () => {
  const w = await teamWorld("failopen", { n: 1 });
  const s = await planSession({ athleteId: w.athletes[0].athleteId, team: w.team, coachUserId: w.coach.id });
  const read = () => api(`/api/plans/${s.planId}/weekly`, { cookie: m.roles.platformAdmin.cookie });
  const unlinked = await read();
  assert.equal(unlinked.status, 200, unlinked.text);
  await attach(w, await makeEvent(w), [s.logicalSessionId]);
  const linked = await read();
  assert.notEqual(linked.text, unlinked.text, "with the link the event's time is shown");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  await q(`alter table calendar.event_session_links rename to event_session_links_gone`);
  try {
    const failed = await read();
    assert.equal(failed.status, 200, failed.text);
    assert.deepEqual(failed.body, unlinked.body, "the plan without event times");
    assert.ok(!failed.text.includes("event_session_links"), "no SQL text in the answer");
  } finally {
    await q(`alter table calendar.event_session_links_gone rename to event_session_links`);
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[linked-session-times\] event times not read \(42P01\); the plan is shown without them$/);
});

test("12. linkedSessionTimes on a query that throws returns the rows unchanged and logs one line with no data", async () => {
  const rows = [{ plan_id: crypto.randomUUID(), athlete_uuid: crypto.randomUUID(), date: DAY, am_pm: "AM", bta: "T", session_order: 1, session_time: null, session_name: "Secret name" }];
  const before = JSON.stringify(rows);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const out = await linkedSessionTimes({ query: async () => { throw Object.assign(new Error(`timeout on ${rows[0].plan_id}`), { code: "57014" }); } }, rows);
    assert.equal(out, rows);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(warnings, ["[linked-session-times] event times not read (57014); the plan is shown without them"]);
});
