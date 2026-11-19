// Central calendar K4a-B (docs/ai/central-calendar-k4a-contract.md section 1):
// in the athlete workspace, a planned event she is shown folds HER OWN linked
// planned sessions into its card (`sessions`), and nothing else. The OptiMove
// manager's GO conditions: the whole response text carries no teammate's id or
// name; an athlete removed from the targets gets her ordinary card back and no
// event; `sessions[].rpe` comes from her own row only; the coach's card is
// unchanged; the fold adds no query per session.
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
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const TZ = "Europe/Belgrade";

// The D21 / D27 allowlist of the athlete's event card
// (central-calendar-k2a-events.test.mjs), and what K4a adds.
const ALLOWED = ["key", "kind", "date", "title", "eventKind", "eventTypeLabel", "eventTypeIconKey", "eventTypeColorKey", "span", "startTime", "endTime", "timezone", "location", "place", "status", "cancelled", "teamIds", "links"].sort();
const SESSION_KEYS = ["title", "slot", "time", "timeFromEvent", "sessionId", "logicalSessionId", "rpe"].sort();

let env;
let q;
let api;
let fx;

before(async () => {
  env = await startCalendarApp({ label: "k4afold" });
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
  const clubId = await fx.makeClub(`k4a club ${seq}`);
  const teamId = await fx.makeTeam(clubId, `k4a team ${seq}`);
  const coach = await fx.coachOf(teamId, `k4a coach ${seq}`);
  const ana = await fx.makeAthlete(`Anaxa Seq${seq}`, { clubId, teamId });
  const ben = await fx.makeAthlete(`Benzo Seq${seq}`, { clubId, teamId });
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
    [coachUserId, athleteId, FROM],
  ))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, teamId]);
  return planId;
}
async function session(planId, { date = PAST, name = "Main session", amPm = "AM", bta = "T", order = 1, time = null } = {}) {
  let dayId = (await q(`select id from plans.plan_days where plan_id = $1 and date = $2`, [planId, date]))[0]?.id;
  if (!dayId) dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,$6,true,true,$7) returning id`,
    [dayId, name, amPm, bta, order, time, logicalSessionId],
  ))[0].id;
  return { planId, sessionId, logicalSessionId };
}
async function trainingType(cookie) {
  const res = await api("/api/calendar/events/types", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === "training").id;
}
async function event(s, { day = PAST, endDay, startTime = "10:00", endTime = "11:30", targets, title = "Team training" } = {}) {
  const res = await api("/api/calendar/events", {
    method: "POST", cookie: s.coach.cookie,
    body: {
      requestKey: newKey(), eventTypeId: await trainingType(s.coach.cookie), title, day, timezone: TZ,
      targets: targets || [{ kind: "team", id: s.teamId }],
      ...(endDay ? { endDay } : {}), ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}),
    },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function attach(s, ev, logicalSessionIds) {
  const res = await api(`/api/calendar/events/${ev.id}/sessions`, {
    method: "POST", cookie: s.coach.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, logicalSessionIds },
  });
  assert.equal(res.status, 200, res.text);
  return res.body.event;
}
const read = (cookie, extra = "") => api(`/api/calendar?from=${FROM}&to=${TO}${extra}`, { cookie });
const items = (res) => (res.body.days || []).flatMap((d) => d.items);
const eventCard = (res, eventId, date = PAST) => items(res).find((i) => i.kind === "event" && i.links?.eventId === eventId && i.date === date) || null;
const plannedCards = (res) => items(res).filter((i) => i.kind === "planned");
async function statements(run) {
  const original = env.appPool.query;
  const seen = [];
  env.appPool.query = function recorded(...args) {
    seen.push({ sql: String(typeof args[0] === "string" ? args[0] : args[0]?.text || ""), params: args[1] });
    return original.apply(this, args);
  };
  try {
    await run();
  } finally {
    env.appPool.query = original;
  }
  return seen;
}

// A squad with one event and one linked session for each of the two athletes.
async function linkedWorld({ anaTime = null } = {}) {
  const s = await squad();
  const anaPlan = await plan(s.ana.athleteId, s.coach.id, s.teamId);
  const benPlan = await plan(s.ben.athleteId, s.coach.id, s.teamId);
  const a = await session(anaPlan, { time: anaTime });
  const b = await session(benPlan);
  const ev = await attach(s, await event(s), [a.logicalSessionId, b.logicalSessionId]);
  return { s, a, b, ev, anaPlan, benPlan };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("1. the allowlist key by key: without a fold today's keys exactly; with a fold today's keys plus `sessions`, each session exactly its keys, links exactly { eventId }", async () => {
  const s = await squad();
  const unlinked = await event(s, { title: "Video review", startTime: "08:00", endTime: "09:00" });
  const anaPlan = await plan(s.ana.athleteId, s.coach.id, s.teamId);
  const a = await session(anaPlan, { name: "Main session", time: "10:15" });
  const linked = await attach(s, await event(s), [a.logicalSessionId]);
  const res = await read(s.ana.cookie);
  assert.equal(res.status, 200, res.text);
  const plain = eventCard(res, unlinked.id);
  assert.deepEqual(Object.keys(plain).sort(), ALLOWED);
  const folded = eventCard(res, linked.id);
  assert.deepEqual(Object.keys(folded).sort(), [...ALLOWED, "sessions"].sort());
  assert.deepEqual(folded.links, { eventId: linked.id });
  assert.equal(folded.sessions.length, 1);
  assert.deepEqual(Object.keys(folded.sessions[0]).sort(), SESSION_KEYS);
  assert.deepEqual(folded.sessions[0], {
    title: "Main session", slot: { amPm: "AM", bta: "T", order: 1 }, time: "10:15", timeFromEvent: false,
    sessionId: a.sessionId, logicalSessionId: a.logicalSessionId, rpe: "missing",
  });
  // One card (O3): the folded session is not also a planned card.
  assert.equal(plannedCards(res).some((c) => (c.links?.logicalSessionIds || []).includes(a.logicalSessionId)), false);
});

test("2. two athletes in one event: each sees only her own session, and the WHOLE response carries no teammate's athlete, plan, session, logical or link id, nor her name", async () => {
  const { s, a, b, ev, benPlan } = await linkedWorld();
  const linkIds = (await q(`select id from calendar.event_session_links where event_id = $1`, [ev.id])).map((r) => r.id);
  assert.equal(linkIds.length, 2);
  const res = await read(s.ana.cookie);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(eventCard(res, ev.id).sessions.map((x) => x.sessionId), [a.sessionId]);
  for (const secret of [s.ben.athleteId, benPlan, b.sessionId, b.logicalSessionId, ...linkIds, s.ben.name, "Benzo"]) {
    assert.ok(!res.text.includes(String(secret)), `the response carries ${secret}`);
  }
  const benRes = await read(s.ben.cookie);
  assert.deepEqual(eventCard(benRes, ev.id).sessions.map((x) => x.sessionId), [b.sessionId]);
  assert.ok(!benRes.text.includes(a.sessionId) && !benRes.text.includes(s.ana.athleteId));
});

test("2b. an athlete removed from the event's targets after the link: her session is her ordinary planned card again, the event is absent, and no teammate's id or name appears", async () => {
  const { s, a, b, ev, benPlan } = await linkedWorld();
  const patched = await api(`/api/calendar/events/${ev.id}`, {
    method: "PATCH", cookie: s.coach.cookie,
    body: { requestKey: newKey(), expectedRevision: ev.revision, targets: [{ kind: "athlete", id: s.ben.athleteId }] },
  });
  assert.equal(patched.status, 200, patched.text);
  const res = await read(s.ana.cookie);
  assert.equal(res.status, 200, res.text);
  assert.equal(eventCard(res, ev.id), null, "the event is not hers any more");
  const own = plannedCards(res).find((c) => (c.links?.logicalSessionIds || []).includes(a.logicalSessionId));
  assert.ok(own, "her session is a planned card again");
  for (const secret of [s.ben.athleteId, benPlan, b.sessionId, b.logicalSessionId, ev.id, s.ben.name]) {
    assert.ok(!res.text.includes(String(secret)), `the response carries ${secret}`);
  }
});

test("3. a cancelled event folds nothing: no `sessions`, her session is a planned card again", async () => {
  const { s, a, ev } = await linkedWorld();
  const cancelled = await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: s.coach.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision } });
  assert.equal(cancelled.status, 200, cancelled.text);
  const res = await read(s.ana.cookie);
  const card = eventCard(res, ev.id);
  assert.ok(card && card.cancelled === true);
  assert.equal("sessions" in card, false);
  assert.ok(plannedCards(res).some((c) => (c.links?.logicalSessionIds || []).includes(a.logicalSessionId)));
});

test("4. time (O12 / O14): her own time wins; without one the event's start, marked; a multi-day event's middle day gives none", async () => {
  const { s, ev } = await linkedWorld({ anaTime: null });
  let card = eventCard(await read(s.ana.cookie), ev.id);
  assert.deepEqual([card.sessions[0].time, card.sessions[0].timeFromEvent], ["10:00", true]);
  const anaPlan2 = await plan(s.ana.athleteId, s.coach.id, s.teamId).catch(() => null);
  assert.ok(anaPlan2);
  const own = await session(anaPlan2, { name: "Own time", amPm: "AM", bta: "A", time: "10:45" });
  const ev2 = await attach(s, await event(s, { title: "Second", startTime: "10:00", endTime: "11:30" }), [own.logicalSessionId]);
  card = eventCard(await read(s.ana.cookie), ev2.id);
  assert.deepEqual([card.sessions[0].time, card.sessions[0].timeFromEvent], ["10:45", false]);
  const mid = addDays(PAST, 1);
  const camp = await plan(s.ana.athleteId, s.coach.id, s.teamId);
  const midSession = await session(camp, { date: mid, name: "Camp day 2" });
  const ev3 = await attach(s, await event(s, { title: "Camp", day: PAST, endDay: addDays(PAST, 2), startTime: "09:00", endTime: "16:00" }), [midSession.logicalSessionId]);
  card = eventCard(await read(s.ana.cookie), ev3.id, mid);
  assert.deepEqual([card.sessions[0].time, card.sessions[0].timeFromEvent], [null, false]);
});

test("5. `sessions[].rpe` comes from her own row only: a teammate's submitted RPE does not change it; her own does", async () => {
  const { s, a, b, ev } = await linkedWorld();
  const rate = (athlete, sessionId) => api(`/api/training-load/sessions/${sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 7, durationMinutes: 75 } });
  const benRated = await rate(s.ben, b.sessionId);
  assert.equal(benRated.status, 201, benRated.text);
  assert.equal(eventCard(await read(s.ana.cookie), ev.id).sessions[0].rpe, "missing");
  assert.equal(eventCard(await read(s.ben.cookie), ev.id).sessions[0].rpe, "submitted");
  const anaRated = await rate(s.ana, a.sessionId);
  assert.equal(anaRated.status, 201, anaRated.text);
  assert.equal(eventCard(await read(s.ana.cookie), ev.id).sessions[0].rpe, "submitted");
});

test("6. no query per session: the athlete's fold reads the links in ONE statement, restricted to her own plans, whether one or three sessions are linked", async () => {
  const one = await linkedWorld();
  const three = await squad();
  const p = await plan(three.ana.athleteId, three.coach.id, three.teamId);
  const sessions = [
    await session(p, { name: "Before", bta: "B" }), await session(p, { name: "Main" }), await session(p, { name: "After", bta: "A", amPm: "AM", order: 2 }),
  ];
  await attach(three, await event(three), sessions.map((x) => x.logicalSessionId));
  const linkReads = (seen) => seen.filter((x) => /from calendar\.event_session_links l/.test(x.sql));
  let res;
  const seenOne = await statements(async () => { res = await read(one.s.ana.cookie); });
  assert.equal(res.status, 200);
  const seenThree = await statements(async () => { res = await read(three.ana.cookie); });
  assert.equal(eventCard(res, items(res).find((i) => i.kind === "event")?.links.eventId)?.sessions.length, 3);
  assert.equal(seenOne.length, seenThree.length, "the same number of statements for one and three linked sessions");
  for (const seen of [seenOne, seenThree]) {
    const reads = linkReads(seen);
    assert.equal(reads.length, 1);
    assert.match(reads[0].sql, /l\.plan_id in \(select p\.id from plans\.plans p where p\.athlete_id = \$2::uuid\)/);
  }
  assert.deepEqual(linkReads(seenThree)[0].params[1], three.ana.athleteId);
  // Order: Before, Training, After (the Weekly plan's order).
  assert.deepEqual(eventCard(res, items(res).find((i) => i.kind === "event").links.eventId).sessions.map((x) => x.title), ["Before", "Main", "After"]);
});

test("7. the coach's card is unchanged: the coach's link read is the old statement (no athlete filter), and the coach's event card is the snapshot of before K4a", async () => {
  const { s, a, b, ev } = await linkedWorld();
  let res;
  const seen = await statements(async () => { res = await read(s.coach.cookie, "&include=athletes"); });
  assert.equal(res.status, 200, res.text);
  const linkRead = seen.filter((x) => /from calendar\.event_session_links l/.test(x.sql));
  assert.equal(linkRead.length, 1);
  assert.ok(!/plan_id in \(select/.test(linkRead[0].sql), "no athlete filter for a coach");
  assert.deepEqual(linkRead[0].params, [[ev.id]]);
  const card = eventCard(res, ev.id);
  assert.equal("sessions" in card, false);
  assert.deepEqual(Object.keys(card).sort(), [
    "alignment", "athleteCount", "athleteIds", "athletes", "attendance", "cancelled", "date", "details", "endTime", "eventId",
    "eventKind", "eventTypeColorKey", "eventTypeIconKey", "eventTypeId", "eventTypeLabel", "expects", "gaps", "key", "kind", "links",
    "location", "notes", "place", "projected", "results", "revision", "rpe", "scheduleFold", "slot", "span", "startTime", "startsAt",
    "status", "teamIds", "timezone", "title", "canManage",
  ].sort());
  assert.deepEqual([...card.links.logicalSessionIds].sort(), [a.logicalSessionId, b.logicalSessionId].sort());
  assert.equal(card.athleteCount, 2);
  assert.equal(plannedCards(res).some((c) => (c.links?.logicalSessionIds || []).includes(a.logicalSessionId)), false);
});

test("8. Q2: `kinds=event` alone (Home's Upcoming events) folds nothing and reads no link", async () => {
  const { s, ev } = await linkedWorld();
  let res;
  const seen = await statements(async () => { res = await read(s.ana.cookie, "&kinds=event"); });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(eventCard(res, ev.id)).sort(), ALLOWED);
  assert.equal(seen.filter((x) => /from calendar\.event_session_links l/.test(x.sql)).length, 0);
});

test("9. fail closed: an athlete's link read without her athlete id throws instead of reading every link", async () => {
  const { readEventSessionLinks } = await import("../src/calendarQuery.js");
  await assert.rejects(() => readEventSessionLinks([crypto.randomUUID()], { athleteOnly: true, athleteId: null }), /needs her athlete id/);
  await assert.rejects(() => readEventSessionLinks([crypto.randomUUID()], { athleteOnly: true }), /needs her athlete id/);
  assert.deepEqual(await readEventSessionLinks([crypto.randomUUID()]), [], "a coach's read is unchanged");
});

test("10. as built (contract 1.1): her own recorded activity of a folded session folds with it - no activity card for it, the event's links stay { eventId }, her RPE reads submitted", async () => {
  const { s, a, ev } = await linkedWorld();
  const rated = await api(`/api/training-load/sessions/${a.sessionId}/rpe`, { method: "POST", cookie: s.ana.cookie, body: { rpe: 6, durationMinutes: 60 } });
  assert.equal(rated.status, 201, rated.text);
  const res = await read(s.ana.cookie, "&kinds=event,planned,activity");
  assert.equal(res.status, 200, res.text);
  const activity = items(res).filter((i) => i.kind === "activity" && (i.links?.logicalSessionIds || []).includes(a.logicalSessionId));
  assert.deepEqual(activity, [], "no activity card of her own session");
  assert.equal(plannedCards(res).some((c) => (c.links?.logicalSessionIds || []).includes(a.logicalSessionId)), false);
  const card = eventCard(res, ev.id);
  assert.deepEqual(card.links, { eventId: ev.id });
  assert.equal(card.sessions[0].rpe, "submitted");
});
