// Central calendar K5-2 (docs/ai/central-calendar-k5-12-contract.md section 2.2, Q11): `holdsImport`, one boolean on
// the event, planned and RPE cards of a coach's or a reader's answer, never in the athlete's answer. True when any id
// of the card's own `links.activityIds` is an imported activity of the viewer's scoped read, whichever way it got
// there: an event's direct link, its linked Builder session, its folded RPE schedule; a planned card's session; an
// RPE card's assignment. The managers' conditions: the allowlists of the four cards (exactly one new key), no card of
// the athlete's answer carries it, a viewer with no right to the activity never gets `true`.
//
// One disposable database through the calendar fixture; the real app over HTTP; invented people only. Nothing
// touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addDays, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
// Every fixture lives on today: an RPE schedule's assignments are made only on their own day in the athlete's time
// (training_load.materialize_external_assignments_for_occurrence, v81), and the RPE cards are built from them.
const DAY = TODAY;
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const TZ = "UTC";
const WELLNESS = "7a386bd1-d25e-4651-9012-e76d9dc32559";

// The keys of today's cards (publicCard, backend/src/calendarQuery.js), read without include=athletes.
const COMMON = ["key", "kind", "date", "title", "slot", "startTime", "startsAt", "teamIds", "athleteIds", "athleteCount", "expects", "status", "rpe", "attendance", "results", "cancelled", "projected", "links"];
const EVENT_READER = [...COMMON, "eventId", "eventKind", "eventTypeLabel", "eventTypeIconKey", "eventTypeColorKey", "endTime", "timezone", "location", "place", "span", "gaps", "scheduleFold", "revision", "canManage"];
const EVENT_MANAGER = [...EVENT_READER, "eventTypeId", "notes", "details", "alignment"];
const PLANNED = [...COMMON];
const EXTERNAL = [...COMMON, "eventType"];
const sorted = (keys) => [...keys].sort();

let env;
let q;
let api;
let fx;

before(async () => {
  env = await startCalendarApp({ label: "k5holds" });
  ({ q, api, fx } = env);
});

after(async () => {
  if (env) await env.stop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let seq = 0;
// A club with teams X and Y, a coach of each, the club's admin, two athletes of X and one of Y.
async function squad() {
  seq += 1;
  const clubId = await fx.makeClub(`k5 club ${seq}`);
  const teamX = await fx.makeTeam(clubId, `k5 X ${seq}`);
  const teamY = await fx.makeTeam(clubId, `k5 Y ${seq}`);
  const clubAdmin = await fx.clubAdminOf(clubId, `k5 admin ${seq}`);
  const coachX = await fx.coachOf(teamX, `k5 coach X ${seq}`);
  const coachY = await fx.coachOf(teamY, `k5 coach Y ${seq}`);
  const ana = await fx.makeAthlete(`Anaxa Kfive${seq}`, { clubId, teamId: teamX });
  const ben = await fx.makeAthlete(`Benzo Kfive${seq}`, { clubId, teamId: teamX });
  const yan = await fx.makeAthlete(`Yanta Kfive${seq}`, { clubId, teamId: teamY });
  await q(
    `insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at) values ('team',$1,true,'2000-01-01T00:00:00Z')`,
    [teamX],
  );
  return { clubId, teamX, teamY, clubAdmin, coachX, coachY, ana, ben, yan };
}
async function typeOf(cookie, kind = "training") {
  const res = await api("/api/calendar/events/types", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === kind).id;
}
async function event(cookie, { targets, day = DAY, title = "Team training", expects } = {}) {
  const res = await api("/api/calendar/events", {
    method: "POST", cookie,
    body: { requestKey: newKey(), eventTypeId: await typeOf(cookie), title, day, timezone: TZ, startTime: "10:00", endTime: "11:30", targets, ...(expects ? { expects } : {}) },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function activity({ teamId, origin = "source_import", name = "GPS session", date = DAY }) {
  return (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
     values ($1,$2,$3,$4,'team',$5,$6,'confirmed') returning id`,
    [name, date, `${date}T10:05:00Z`, TZ, teamId, origin],
  ))[0].id;
}
async function participant(activityId, athleteId, date = DAY) {
  return (await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,$4,'participated') returning id`,
    [activityId, athleteId, date, TZ],
  ))[0].id;
}
async function linkParticipant(participantId, athleteId, { logicalSessionId = null, externalAssignmentId = null }) {
  await q(
    `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, external_assignment_id, link_method, link_status, confirmed_at)
     values ($1,$2,$3,$4,'manual','confirmed',now())`,
    [participantId, athleteId, logicalSessionId, externalAssignmentId],
  );
}
async function plannedSession(s, athlete, { date = DAY, name = "Team training" } = {}) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
     values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`,
    [s.coachX.id, athlete.athleteId, FROM],
  ))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, s.teamX]);
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,'AM','T',1,'10:00',true,true,$3)`,
    [dayId, name, logicalSessionId],
  );
  return { planId, logicalSessionId };
}
// An RPE schedule of team X on DAY, and each athlete's assignment of it.
async function rpeSchedule(s, { name = "RPE after training" } = {}) {
  const res = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: s.coachX.cookie,
    body: { eventName: name, scheduleKind: "one_time", startDate: DAY, timezone: TZ, opensTime: "10:00", closesTime: "23:00", targets: [{ kind: "team", id: s.teamX }] },
  });
  assert.ok([200, 201].includes(res.status), res.text);
  const scheduleId = res.body.schedules[0].id;
  // The occurrence of DAY and its assignments, as the routes' ensureCurrentExternalOccurrence makes them on read.
  const occurrenceId = (await q(`select training_load.generate_external_schedule_occurrence($1, $2) as id`, [scheduleId, DAY]))[0].id;
  await q(`select training_load.materialize_external_assignments_for_occurrence($1)`, [occurrenceId]);
  const rows = await q(
    `select asg.id, asg.athlete_id from training_load.external_assignments asg
       join training_load.external_schedule_occurrences eo on eo.id = asg.occurrence_id
      where eo.schedule_id = $1`,
    [scheduleId],
  );
  assert.ok(rows.length > 0, "the schedule's assignments of the day exist");
  return { scheduleId, assignmentOf: (athlete) => rows.find((r) => String(r.athlete_id) === String(athlete.athleteId))?.id };
}
async function attachActivity(cookie, ev, activityId) {
  const res = await api(`/api/calendar/events/${ev.id}/activities`, { method: "POST", cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, activityId } });
  assert.equal(res.status, 200, res.text);
  return res.body.event;
}
async function attachSessions(cookie, ev, logicalSessionIds) {
  const res = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, logicalSessionIds } });
  assert.equal(res.status, 200, res.text);
  return res.body.event;
}
const read = async (cookie, extra = "") => {
  const res = await api(`/api/calendar?from=${FROM}&to=${TO}${extra}`, { cookie });
  assert.equal(res.status, 200, res.text);
  return res;
};
const items = (res) => (res.body.days || []).flatMap((d) => d.items);
const eventCard = (res, ev) => items(res).find((i) => i.kind === "event" && i.links?.eventId === ev.id && i.date === DAY) || null;
const plannedWith = (res, logicalSessionId) => items(res).find((i) => i.kind === "planned" && (i.links?.logicalSessionIds || []).includes(logicalSessionId)) || null;
const externalOf = (res, scheduleId) => items(res).find((i) => i.kind === "external" && i.links?.externalScheduleId === scheduleId) || null;

// ---------------------------------------------------------------------------
// The value, per path
// ---------------------------------------------------------------------------
test("1. an event: an imported activity linked directly makes it true; a coach-made one does not", async () => {
  const s = await squad();
  const imported = await activity({ teamId: s.teamX });
  await participant(imported, s.ana.athleteId);
  const manual = await activity({ teamId: s.teamX, origin: "manual", name: "Gym" });
  await participant(manual, s.ana.athleteId);
  const withImport = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "With import" });
  const withManual = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "With manual" });
  await attachActivity(s.coachX.cookie, withImport, imported);
  await attachActivity(s.coachX.cookie, withManual, manual);
  const res = await read(s.coachX.cookie);
  const a = eventCard(res, withImport);
  assert.ok(a.links.activityIds.includes(imported));
  assert.equal(a.holdsImport, true);
  const b = eventCard(res, withManual);
  assert.ok(b.links.activityIds.includes(manual));
  assert.equal(b.holdsImport, false, "a coach-made activity is not an import");
});

test("2. an event: an import folded through a linked Builder session makes it true", async () => {
  const s = await squad();
  const ses = await plannedSession(s, s.ana);
  const ev = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }] });
  await attachSessions(s.coachX.cookie, ev, [ses.logicalSessionId]);
  const imported = await activity({ teamId: s.teamX });
  await linkParticipant(await participant(imported, s.ana.athleteId), s.ana.athleteId, { logicalSessionId: ses.logicalSessionId });
  const card = eventCard(await read(s.coachX.cookie), ev);
  assert.ok(card.links.activityIds.includes(imported), "the import reaches the event through the session");
  assert.equal(card.holdsImport, true);
});

test("3. an event: an import folded through the event's RPE schedule makes it true", async () => {
  const s = await squad();
  const sch = await rpeSchedule(s);
  let ev = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }] });
  const linked = await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: s.coachX.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, externalScheduleId: sch.scheduleId } });
  assert.equal(linked.status, 200, linked.text);
  ev = linked.body.event;
  const imported = await activity({ teamId: s.teamX });
  await linkParticipant(await participant(imported, s.ana.athleteId), s.ana.athleteId, { externalAssignmentId: sch.assignmentOf(s.ana) });
  const res = await read(s.coachX.cookie);
  const card = eventCard(res, ev);
  assert.equal(card.scheduleFold.external, "folded");
  assert.equal(externalOf(res, sch.scheduleId), null, "the RPE card folded under the event");
  assert.ok(card.links.activityIds.includes(imported));
  assert.equal(card.holdsImport, true);
});

test("4. a planned card and a lone RPE card: an import through the session / the assignment makes each true", async () => {
  const s = await squad();
  const ses = await plannedSession(s, s.ana);
  const viaSession = await activity({ teamId: s.teamX, name: "GPS planned" });
  await linkParticipant(await participant(viaSession, s.ana.athleteId), s.ana.athleteId, { logicalSessionId: ses.logicalSessionId });
  const sch = await rpeSchedule(s, { name: "Lone RPE" });
  const viaAssignment = await activity({ teamId: s.teamX, name: "GPS lone RPE" });
  await linkParticipant(await participant(viaAssignment, s.ana.athleteId), s.ana.athleteId, { externalAssignmentId: sch.assignmentOf(s.ana) });
  const res = await read(s.coachX.cookie);
  const planned = plannedWith(res, ses.logicalSessionId);
  assert.ok(planned.links.activityIds.includes(viaSession));
  assert.equal(planned.holdsImport, true);
  const external = externalOf(res, sch.scheduleId);
  assert.ok(external.links.activityIds.includes(viaAssignment));
  assert.equal(external.holdsImport, true);
});

test("5. false: an event that only waits for device data, an event with no activity, a cancelled event with an import, and the same cards with nothing", async () => {
  const s = await squad();
  const waiting = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "Waits", expects: ["device_data"] });
  const empty = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "Empty" });
  let cancelled = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "Rained off" });
  const imported = await activity({ teamId: s.teamX });
  await participant(imported, s.ana.athleteId);
  cancelled = await attachActivity(s.coachX.cookie, cancelled, imported);
  const off = await api(`/api/calendar/events/${cancelled.id}/cancel`, { method: "POST", cookie: s.coachX.cookie, body: { requestKey: newKey(), expectedRevision: cancelled.revision, reason: "Rain" } });
  assert.equal(off.status, 200, off.text);
  const ses = await plannedSession(s, s.ben, { name: "Quiet session" });
  const res = await read(s.coachX.cookie);
  assert.equal(eventCard(res, waiting).holdsImport, false, "waiting for device data is not holding an import");
  assert.equal(eventCard(res, empty).holdsImport, false);
  assert.equal(eventCard(res, cancelled).cancelled, true);
  assert.equal(eventCard(res, cancelled).holdsImport, false, "a cancelled event folds nothing");
  assert.equal(plannedWith(res, ses.logicalSessionId).holdsImport, false);
});

// ---------------------------------------------------------------------------
// The allowlists and who gets the key
// ---------------------------------------------------------------------------
test("6. allowlists: the manager's and the reader's event card, a planned card and an RPE card have exactly today's keys plus holdsImport; activity and test cards have no such key", async () => {
  const s = await squad();
  const teamEvent = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }], title: "Team event" });
  const clubEvent = await event(s.clubAdmin.cookie, { targets: [{ kind: "club", id: s.clubId }], title: "Club event" });
  const ses = await plannedSession(s, s.ana);
  const sch = await rpeSchedule(s);
  const lone = await activity({ teamId: s.teamX, name: "Lone GPS" });
  await participant(lone, s.ben.athleteId);
  const tests = await api("/api/tests/schedules", {
    method: "POST", cookie: s.coachX.cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: TZ, startDate: DAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: s.teamX }] },
  });
  assert.equal(tests.status, 201, tests.text);
  const res = await read(s.coachX.cookie);
  const manager = eventCard(res, teamEvent);
  assert.equal(manager.canManage, true);
  assert.deepEqual(Object.keys(manager).sort(), sorted([...EVENT_MANAGER, "holdsImport"]));
  const reader = eventCard(res, clubEvent);
  assert.equal(reader.canManage, false, "a team coach reads the club's event");
  assert.deepEqual(Object.keys(reader).sort(), sorted([...EVENT_READER, "holdsImport"]));
  assert.deepEqual(Object.keys(plannedWith(res, ses.logicalSessionId)).sort(), sorted([...PLANNED, "holdsImport"]));
  assert.deepEqual(Object.keys(externalOf(res, sch.scheduleId)).sort(), sorted([...EXTERNAL, "holdsImport"]));
  for (const card of items(res)) {
    if (["event", "planned", "external"].includes(card.kind)) assert.equal(typeof card.holdsImport, "boolean", `${card.key}: always a boolean`);
    else assert.equal("holdsImport" in card, false, `${card.key}: no key on a ${card.kind} card`);
  }
  assert.ok(items(res).some((c) => c.kind === "activity"), "an activity card was checked");
  assert.ok(items(res).some((c) => c.kind === "test"), "a test card was checked");
});

test("7. the athlete's answer carries holdsImport on no card, while the same day's event, planned and RPE cards hold an import for the coach", async () => {
  const s = await squad();
  const ev = await event(s.coachX.cookie, { targets: [{ kind: "team", id: s.teamX }] });
  const direct = await activity({ teamId: s.teamX });
  await participant(direct, s.ana.athleteId);
  await attachActivity(s.coachX.cookie, ev, direct);
  const ses = await plannedSession(s, s.ana, { name: "Her session" });
  const viaSession = await activity({ teamId: s.teamX, name: "GPS planned" });
  await linkParticipant(await participant(viaSession, s.ana.athleteId), s.ana.athleteId, { logicalSessionId: ses.logicalSessionId });
  const sch = await rpeSchedule(s, { name: "Her RPE" });
  const viaAssignment = await activity({ teamId: s.teamX, name: "GPS RPE" });
  await linkParticipant(await participant(viaAssignment, s.ana.athleteId), s.ana.athleteId, { externalAssignmentId: sch.assignmentOf(s.ana) });

  const coach = await read(s.coachX.cookie);
  assert.equal(eventCard(coach, ev).holdsImport, true);
  assert.equal(plannedWith(coach, ses.logicalSessionId).holdsImport, true);
  assert.equal(externalOf(coach, sch.scheduleId).holdsImport, true);

  for (const extra of ["", "&include=athletes", "&kinds=planned,external"]) {
    const mine = await read(s.ana.cookie, extra);
    const kinds = new Set(items(mine).map((c) => c.kind));
    assert.ok(kinds.has("planned") && kinds.has("external"), `${extra}: her planned and RPE cards are in her answer (${[...kinds]})`);
    if (!extra.includes("kinds=")) assert.ok(eventCard(mine, ev), `${extra}: her reduced event card is in her answer, so its early return ran`);
    for (const card of items(mine)) assert.equal("holdsImport" in card, false, `${extra}: ${card.key} carries no holdsImport for the athlete`);
    assert.equal(mine.text.includes("holdsImport"), false, `${extra}: the word is nowhere in her answer`);
  }
});

test("8. no right, never true: a team coach reading the club's event does not get true for team X's import, which its read never returns; team X's coach does", async () => {
  const s = await squad();
  const clubEvent = await event(s.clubAdmin.cookie, { targets: [{ kind: "club", id: s.clubId }], title: "Club session" });
  const imported = await activity({ teamId: s.teamX });
  await participant(imported, s.ana.athleteId);
  await attachActivity(s.clubAdmin.cookie, clubEvent, imported);

  const own = eventCard(await read(s.coachX.cookie), clubEvent);
  assert.ok(own.links.activityIds.includes(imported));
  assert.equal(own.holdsImport, true, "team X's coach may read the import");

  const other = eventCard(await read(s.coachY.cookie), clubEvent);
  assert.ok(other, "team Y's coach reads the club's event (Yanta is a target)");
  assert.equal(other.links.activityIds.includes(imported), false, "team X's activity is outside team Y's read");
  assert.equal(other.holdsImport, false);

  const stranger = await fx.clubAdminOf(await fx.makeClub("k5 other club"), "k5 stranger");
  const theirs = await read(stranger.cookie);
  assert.equal(eventCard(theirs, clubEvent), null, "another club's admin does not see the event at all");
  assert.equal(theirs.text.includes(imported), false);
});

// A planned or RPE card of team X can never list another workspace's activity, so "no right, never true" holds there
// by construction: the database refuses the link itself (the session link must resolve to a same-workspace published
// session; the assignment link must share the schedule's owner scope). This test pins those refusals: if either one is
// ever removed, a planned or RPE card could hold an out-of-scope import and holdsImport's scope must be proven again.
test("9. no right, never true, on a planned and an RPE card: the database refuses linking another workspace's activity to them", async () => {
  const s = await squad();
  const ses = await plannedSession(s, s.ana, { name: "Her session" });
  const sch = await rpeSchedule(s, { name: "Her RPE" });
  const outside = await activity({ teamId: s.teamY, name: "Team Y GPS" });
  const ap = await participant(outside, s.ana.athleteId);
  await assert.rejects(
    () => linkParticipant(ap, s.ana.athleteId, { logicalSessionId: ses.logicalSessionId }),
    /same-workspace Weekly plan session/,
    "team Y's activity cannot be linked to team X's planned session",
  );
  await assert.rejects(
    () => linkParticipant(ap, s.ana.athleteId, { externalAssignmentId: sch.assignmentOf(s.ana) }),
    /owner scope does not match/,
    "team Y's activity cannot be linked to team X's RPE assignment",
  );
  const coach = await read(s.coachX.cookie);
  assert.equal(plannedWith(coach, ses.logicalSessionId).holdsImport, false);
  assert.equal(externalOf(coach, sch.scheduleId).holdsImport, false);
  assert.equal(coach.text.includes(outside), false, "team Y's activity is nowhere in team X's coach's answer");
});
