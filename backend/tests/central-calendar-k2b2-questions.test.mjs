// Central calendar K2b-2a-1 — Ask athletes and the daily WELLNESS "Skip days
// off", migration v81 (plan docs/ai/central-calendar-k2b2-plan.md, 9.1 and
// the manager's GO 9.1.13). The real app over HTTP on a disposable database
// migrated by the calendar fixture (Tests schema included); invented people
// only. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const WELLNESS = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const TODAY = new Date().toISOString().slice(0, 10);
const ALL_DAY = { kind: "custom", date: TODAY, from: "00:00", to: "23:59" };

let env;
let q;
let api;
let fx;
let m;
let athleteTwo;
let eventHooks;
let questionHooks;

before(async () => {
  env = await startCalendarApp({ label: "k2b2q" });
  ({ q, api, fx } = env);
  // The fixture's legacy scaffold has no in-app notifications table: the
  // real one's shape (legacy schema + 202608280900's dedupe index).
  await q(`create table if not exists public.app_notifications (
             id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null, actor_user_id uuid,
             type varchar(80) not null, title text not null, body text, entity_type varchar(80), entity_id uuid, href text,
             metadata jsonb not null default '{}'::jsonb, read_at timestamptz, created_at timestamptz not null default now(),
             dedupe_key varchar(300))`);
  await q(`create unique index if not exists app_notifications_dedupe_key_idx on public.app_notifications (dedupe_key) where dedupe_key is not null`);
  m = await calendarRoleMatrix(env, "q");
  athleteTwo = await fx.makeAthlete("q athlete T1 two", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  eventHooks = (await import("../src/calendarEventService.js")).testHooks;
  questionHooks = (await import("../src/calendarQuestionService.js")).testHooks;
});

after(async () => {
  if (env) await env.stop();
});

const role = (name) => m.roles[name];

async function typeId(clubId, kind) {
  return (await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = $2 and archived_at is null order by sort_order limit 1`, [clubId, kind]))[0].id;
}
async function switchOn(clubId = m.clubs.c1, enabled = true) {
  const res = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role("platformInClub").cookie, body: { requestKey: newKey(), enabled, reason: "Pilot of the athlete questions." } });
  assert.equal(res.status, 200, res.text);
  return res;
}
async function createTeamEvent(body = {}, cookie = role("teamCoach").cookie) {
  const res = await api("/api/calendar/events", {
    method: "POST", cookie,
    body: {
      requestKey: newKey(), eventTypeId: await typeId(body.clubId || m.clubs.c1, body.kind || "training"), title: body.title || `Training ${uid()}`,
      day: body.day || TODAY, ...(body.endDay ? { endDay: body.endDay } : {}), ...(body.startTime ? { startTime: body.startTime } : {}),
      ...(body.endTime ? { endTime: body.endTime } : {}), timezone: "UTC",
      targets: body.targets || [{ kind: "team", id: m.teams.t1 }], ...(body.questions ? { questions: body.questions } : {}),
    },
  });
  return res;
}
async function eventRow(id) {
  return (await q(`select * from calendar.events where id = $1`, [id]))[0];
}
async function liveQuestions(eventId) {
  return q(`select * from calendar.event_questions where event_id = $1 and ended_at is null order by kind`, [eventId]);
}
async function materialize(testScheduleId, day = TODAY) {
  const occ = (await q(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [testScheduleId, day]))[0].id;
  await q(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ]);
  return occ;
}
async function assignmentsOf(testScheduleId) {
  return q(
    `select a.*, k.reason as skip_reason from tests.test_assignments a
       join tests.test_schedule_occurrences o on o.id = a.occurrence_id
       left join calendar.question_assignment_skips k on k.assignment_id = a.id
      where o.schedule_id = $1 order by a.athlete_id`,
    [testScheduleId],
  );
}
async function dailyWellness({ skipDaysOff = true, cookie = role("teamCoach").cookie, startDate = TODAY } = {}) {
  const res = await api("/api/tests/schedules", {
    method: "POST", cookie,
    body: {
      testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate, endDate: addDays(startDate, 5),
      opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: m.teams.t1 }], ...(skipDaysOff !== undefined ? { skipDaysOff } : {}),
    },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.schedule.id;
}

test("1. the switch: off by default — no question is asked, every question command and read is the identical 404, `questions` is 409 questions_off", async () => {
  const created = await createTeamEvent();
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  assert.equal((await liveQuestions(ev.id)).length, 0, "the type's defaults ask nothing while the switch is off");
  assert.equal((await eventRow(ev.id)).external_schedule_id, null);
  const ask = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } } });
  assert.equal(ask.status, 404);
  assert.deepEqual(ask.body, { error: "notFound", message: "Not found." });
  const panel = await api(`/api/calendar/events/${ev.id}/questions`, { cookie: role("teamCoach").cookie });
  assert.equal(panel.status, 404);
  const explicit = await createTeamEvent({ questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  assert.equal(explicit.status, 409);
  assert.equal(explicit.body.error, "questions_off");
  assert.equal(explicit.body.message, "Questions for athletes are not turned on for this club.");
  const mine = await api("/api/calendar/questions/mine", { cookie: m.athletes.athlete.cookie });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, { questions: [] });
});

test("2. the switch command: a platform admin in the club's workspace only, a reason, the change row, the replay and request_key_reused", async () => {
  for (const name of ["clubAdmin", "teamCoach", "platformAdmin", "stranger", "athlete"]) {
    const res = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role(name).cookie, body: { requestKey: newKey(), enabled: true, reason: "x" } });
    assert.equal(res.status, 404, `${name}: ${res.text}`);
  }
  const noReason = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role("platformInClub").cookie, body: { requestKey: newKey(), enabled: true } });
  assert.equal(noReason.status, 400);
  const key = newKey();
  const body = { requestKey: key, enabled: true, reason: "Pilot of the athlete questions." };
  const first = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role("platformInClub").cookie, body });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.questions.enabled, true);
  const again = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role("platformInClub").cookie, body });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  const reused = await api("/api/calendar/settings/questions", { method: "PUT", cookie: role("platformInClub").cookie, body: { ...body, enabled: false } });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  const changes = await q(
    `select c.* from calendar.settings_changes c join calendar.settings_requests r on r.id = c.request_id
      where r.club_id = $1 and c.subject_kind = 'club'`,
    [m.clubs.c1],
  );
  assert.equal(changes.length, 1, "one change row; the replay wrote nothing");
  assert.equal(changes[0].kind, "questions_switch");
  assert.equal(changes[0].basis, "platform_admin");
  const settings = await api("/api/calendar/settings", { cookie: role("clubAdmin").cookie });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.questions.enabled, true);
  const training = settings.body.types.find((t) => t.kind === "training");
  assert.deepEqual(training.defaultQuestions, ["rpe"], "derived from default_expects (⚑2)");
  assert.deepEqual(settings.body.types.find((t) => t.kind === "day_off").defaultQuestions, []);
});

test("3. a Training event asks its type's RPE: the external schedule (one-time, after the event), its targets, the link, the notifications in the same transaction", async () => {
  const created = await createTeamEvent({ startTime: "16:00", endTime: "17:30" });
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  const [rpe] = await liveQuestions(ev.id);
  assert.equal(rpe.kind, "rpe");
  assert.equal(rpe.window_kind, "after_event");
  assert.equal(String(rpe.opens_time).slice(0, 5), "17:30");
  assert.equal(String(rpe.closes_time).slice(0, 5), "23:59");
  const row = await eventRow(ev.id);
  assert.equal(String(row.external_schedule_id), String(rpe.external_schedule_id));
  const [schedule] = await q(`select * from training_load.external_schedules where id = $1`, [rpe.external_schedule_id]);
  assert.equal(schedule.schedule_kind, "one_time");
  assert.equal(schedule.owner_scope, "team");
  assert.equal(String(schedule.owner_team_id), String(m.teams.t1));
  assert.equal(schedule.event_name, ev.title);
  const targets = await q(`select target_kind, target_team_id from training_load.external_schedule_targets where schedule_id = $1`, [schedule.id]);
  assert.deepEqual(targets.map((t) => [t.target_kind, String(t.target_team_id)]), [["team", String(m.teams.t1)]]);
  const rules = await q(`select kind, enabled from training_load.external_schedule_notification_rules where schedule_id = $1 order by kind`, [schedule.id]);
  assert.deepEqual(rules.map((r) => r.enabled), [false, false, false], "the module's worker rules are written off");
  const notes = await q(`select * from public.app_notifications where type = 'calendar_question_asked' and entity_id = $1 order by recipient_user_id`, [ev.id]);
  assert.deepEqual(notes.map((n) => String(n.recipient_user_id)).sort(), [String(m.athletes.athlete.userId), String(athleteTwo.userId)].sort());
  assert.match(notes[0].body, /^How did .+ go\? Answer from 17:30 on \d{2}\.\d{2}\.\d{4}\.$/);
  for (const n of notes) assert.match(n.dedupe_key, new RegExp(`^calendar:v1:question_asked:${rpe.id}:[0-9a-f-]{36}$`));
  // A failure after the notifications leaves none (the same transaction).
  const countBefore = (await q(`select count(*)::int as n from public.app_notifications`))[0].n;
  eventHooks.beforeCommit = async ({ operation }) => { if (operation === "create") throw new Error("forced"); };
  try {
    const failing = await createTeamEvent({ title: "Forced failure" });
    assert.equal(failing.status, 500);
  } finally {
    delete eventHooks.beforeCommit;
  }
  assert.equal((await q(`select count(*)::int as n from public.app_notifications`))[0].n, countBefore, "no notification outlives the rolled-back command");
  assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Forced failure'`))[0].n, 0);
});

test("4. the schedules equal their module's own create route with the same input (9.1.7)", async () => {
  const created = await createTeamEvent({ title: "Same rows", questions: [{ kind: "rpe", window: ALL_DAY }, { kind: "wellness", window: ALL_DAY }] });
  assert.equal(created.status, 201, created.text);
  const qs = await liveQuestions(created.body.event.id);
  const rpe = qs.find((x) => x.kind === "rpe");
  const wel = qs.find((x) => x.kind === "wellness");
  const ext = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: {
      eventName: "Same rows", scheduleKind: "one_time", startDate: TODAY, timezone: "UTC", opensTime: "00:00", closesTime: "23:59",
      targets: [{ kind: "team", id: m.teams.t1 }],
      notificationRules: [{ kind: "athlete_invitation", enabled: false }, { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 }, { kind: "final_digest", enabled: false }],
    },
  });
  assert.equal(ext.status, 201, ext.text);
  const cols = (r) => { const { id, created_at, updated_at, ...rest } = r; return rest; };
  const [a] = await q(`select * from training_load.external_schedules where id = $1`, [rpe.external_schedule_id]);
  const [b] = await q(`select * from training_load.external_schedules where id = $1`, [ext.body.schedules[0].id]);
  assert.deepEqual(cols(a), cols(b));
  const tgt = (id) => q(`select target_kind, target_athlete_id, target_team_id, target_club_id from training_load.external_schedule_targets where schedule_id = $1`, [id]);
  assert.deepEqual(await tgt(a.id), await tgt(b.id));
  const rl = (id) => q(`select kind, enabled, reminder_offset_minutes from training_load.external_schedule_notification_rules where schedule_id = $1 order by kind`, [id]);
  assert.deepEqual(await rl(a.id), await rl(b.id));
  const tst = await api("/api/tests/schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: m.teams.t1 }] },
  });
  assert.equal(tst.status, 201, tst.text);
  const [c] = await q(`select * from tests.test_schedules where id = $1`, [wel.test_schedule_id]);
  const [d] = await q(`select * from tests.test_schedules where id = $1`, [tst.body.schedule.id]);
  assert.deepEqual(cols(c), cols(d));
  const ttg = (id) => q(`select target_kind, target_athlete_id, target_team_id, target_club_id from tests.test_schedule_targets where schedule_id = $1`, [id]);
  assert.deepEqual(await ttg(c.id), await ttg(d.id));
  // Clean the second one-time WELLNESS away (never twice on a day, test 9).
  await q(`update tests.test_schedules set status = 'cancelled' where id = $1`, [d.id]);
  await q(`update training_load.external_schedules set status = 'cancelled' where id = $1`, [b.id]);
  // And the event's own questions, so later tests start from a clean day.
  const view = await eventRow(created.body.event.id);
  const cancel = await api(`/api/calendar/events/${view.id}/cancel`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: view.revision } });
  assert.equal(cancel.status, 200, cancel.text);
  const ended = await q(`select end_reason from calendar.event_questions where event_id = $1`, [view.id]);
  assert.deepEqual(ended.map((x) => x.end_reason).sort(), ["event_cancelled", "event_cancelled"]);
  assert.equal((await q(`select status from training_load.external_schedules where id = $1`, [a.id]))[0].status, "cancelled");
  assert.equal((await q(`select status from tests.test_schedules where id = $1`, [c.id]))[0].status, "cancelled");
});

test("5. ask, the athlete's open questions on a fresh day (A1), Later only for her own, the panel's counts and lists, the replay", async () => {
  const created = await createTeamEvent({ title: "Open today", questions: [] });
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  const key = newKey();
  const askBody = { requestKey: key, expectedRevision: 1, kind: "wellness", window: ALL_DAY };
  const ask = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: askBody });
  assert.equal(ask.status, 200, ask.text);
  const replay = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: askBody });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await liveQuestions(ev.id)).length, 1, "the replay asked nothing more");
  const reused = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { ...askBody, kind: "rpe" } });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  const twice = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { ...askBody, requestKey: newKey(), expectedRevision: 2 } });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "question_already_asked");
  const [wq] = await liveQuestions(ev.id);
  assert.equal((await q(`select count(*)::int as n from tests.test_schedule_occurrences where schedule_id = $1`, [wq.test_schedule_id]))[0].n, 0, "a fresh day: nothing materialized yet");
  const mine = await api("/api/calendar/questions/mine", { cookie: m.athletes.athlete.cookie });
  assert.equal(mine.status, 200, mine.text);
  const item = mine.body.questions.find((x) => x.questionId === wq.id);
  assert.ok(item, mine.text);
  assert.equal(item.form.kind, "wellness");
  const [asg] = await q(`select * from tests.test_assignments where id = $1`, [item.form.assignmentId]);
  assert.equal(String(asg.athlete_id), String(m.athletes.athlete.athleteId), "a usable form id, her own");
  // Later: her own only, open only, the replay.
  const laterKey = newKey();
  const l1 = await api(`/api/calendar/questions/${wq.id}/later`, { method: "POST", cookie: m.athletes.athlete.cookie, body: { requestKey: laterKey } });
  const l2 = await api(`/api/calendar/questions/${wq.id}/later`, { method: "POST", cookie: m.athletes.athlete.cookie, body: { requestKey: laterKey } });
  assert.equal(l1.status, 200);
  assert.equal(l2.status, 200);
  assert.equal(l2.body.replayed, true);
  const foreign = await api(`/api/calendar/questions/${wq.id}/later`, { method: "POST", cookie: m.athletes.athleteU1.cookie, body: { requestKey: newKey() } });
  assert.equal(foreign.status, 404);
  const coachLater = await api(`/api/calendar/questions/${wq.id}/later`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey() } });
  assert.equal(coachLater.status, 404);
  // The panel: managers only.
  for (const name of ["athlete", "stranger", "revokedAdmin"]) {
    const res = await api(`/api/calendar/events/${ev.id}/questions`, { cookie: role(name).cookie });
    assert.equal(res.status, 404, name);
  }
  // athleteTwo answers (completed), athlete chose Later.
  await materialize(wq.test_schedule_id);
  await q(
    `update tests.test_assignments set status = 'completed', completed_at = now()
      where athlete_id = $1 and occurrence_id in (select id from tests.test_schedule_occurrences where schedule_id = $2)`,
    [athleteTwo.athleteId, wq.test_schedule_id],
  );
  const panel = await api(`/api/calendar/events/${ev.id}/questions`, { cookie: role("teamCoach").cookie });
  assert.equal(panel.status, 200, panel.text);
  const p = panel.body.questions[0];
  assert.deepEqual(p.counts, { asked: 2, answered: 1, later: 1, notAnswered: 0 });
  assert.deepEqual(p.answered.map((a) => a.athleteId), [String(athleteTwo.athleteId)]);
  assert.deepEqual(p.later.map((a) => a.athleteId), [String(m.athletes.athlete.athleteId)]);
  // Answered: a move of the event is refused, a remove closes early.
  const view = await eventRow(ev.id);
  const move = await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: view.revision, startTime: "10:00" } });
  assert.equal(move.status, 409, move.text);
  assert.equal(move.body.error, "questions_answered");
  const remove = await api(`/api/calendar/events/${ev.id}/questions/${wq.id}/remove`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: view.revision } });
  assert.equal(remove.status, 200, remove.text);
  assert.equal((await q(`select end_reason from calendar.event_questions where id = $1`, [wq.id]))[0].end_reason, "closed_early");
  assert.equal((await q(`select status from tests.test_schedules where id = $1`, [wq.test_schedule_id]))[0].status, "cancelled");
  const closedLater = await api(`/api/calendar/questions/${wq.id}/later`, { method: "POST", cookie: m.athletes.athlete.cookie, body: { requestKey: newKey() } });
  assert.equal(closedLater.status, 404, "an ended question is not hers to postpone any more");
});

test("6. move and remove while nobody answered: a new schedule replaces the old one, the old question ends `moved`, a `moved` notification; remove ends `removed`", async () => {
  const created = await createTeamEvent({ title: "Will move", day: addDays(TODAY, 3), questions: [{ kind: "rpe", window: { kind: "next_morning" } }] });
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  const [old] = await liveQuestions(ev.id);
  assert.equal(String(old.window_date).length > 0, true);
  const patch = await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, day: addDays(TODAY, 4) } });
  assert.equal(patch.status, 200, patch.text);
  const [moved] = await liveQuestions(ev.id);
  assert.equal(String(moved.replaces_question_id), String(old.id));
  assert.equal((await q(`select end_reason from calendar.event_questions where id = $1`, [old.id]))[0].end_reason, "moved");
  assert.equal((await q(`select status from training_load.external_schedules where id = $1`, [old.external_schedule_id]))[0].status, "cancelled");
  assert.equal(String((await eventRow(ev.id)).external_schedule_id), String(moved.external_schedule_id));
  assert.equal((await q(`select count(*)::int as n from public.app_notifications where type = 'calendar_question_moved' and entity_id = $1`, [ev.id]))[0].n, 2);
  const custom = await api(`/api/calendar/events/${ev.id}/questions/${moved.id}/move`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 2, window: { kind: "custom", date: addDays(TODAY, 9), from: "08:00", to: "09:00" } } });
  assert.equal(custom.status, 400);
  assert.equal(custom.body.error, "invalid_window");
  const oneDay = await api(`/api/calendar/events/${ev.id}/questions/${moved.id}/move`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 2, window: { kind: "custom", date: addDays(TODAY, 4), from: "20:00", to: "08:00" } } });
  assert.equal(oneDay.status, 400);
  assert.equal(oneDay.body.error, "window_one_day");
  const rm = await api(`/api/calendar/events/${ev.id}/questions/${moved.id}/remove`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 2 } });
  assert.equal(rm.status, 200, rm.text);
  assert.equal((await q(`select end_reason from calendar.event_questions where id = $1`, [moved.id]))[0].end_reason, "removed");
  assert.equal((await eventRow(ev.id)).external_schedule_id, null, "a removed RPE question clears the link");
});

test("7. O2: without an end time, after_event opens at the later of 18:00 and the start; a start at 23:59 is invalid_window", async () => {
  const late = await createTeamEvent({ day: addDays(TODAY, 6), startTime: "20:15", questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  assert.equal(late.status, 201, late.text);
  assert.equal(String((await liveQuestions(late.body.event.id))[0].opens_time).slice(0, 5), "20:15");
  const early = await createTeamEvent({ day: addDays(TODAY, 7), startTime: "09:00", questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  assert.equal(String((await liveQuestions(early.body.event.id))[0].opens_time).slice(0, 5), "18:00");
  const tooLate = await createTeamEvent({ day: addDays(TODAY, 8), startTime: "23:59", questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  assert.equal(tooLate.status, 400);
  assert.equal(tooLate.body.error, "invalid_window");
});

test("8. RPE's one channel: linked sessions refuse an RPE ask; attaching sessions replaces an unanswered RPE question and is refused once answered; a set_schedule link refuses an RPE ask", async () => {
  const day = addDays(TODAY, 10);
  const created = await createTeamEvent({ day, questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  const ev = created.body.event;
  const [rpe] = await liveQuestions(ev.id);
  const session = await planSession(m.athletes.athlete, day);
  const attach = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: [session.logicalSessionId] } });
  assert.equal(attach.status, 200, attach.text);
  assert.equal((await q(`select end_reason from calendar.event_questions where id = $1`, [rpe.id]))[0].end_reason, "replaced_by_sessions");
  assert.equal((await eventRow(ev.id)).external_schedule_id, null);
  const again = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 2, kind: "rpe", window: { kind: "after_event" } } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "rpe_from_sessions");
  // Answered: a link is refused.
  const ev2 = (await createTeamEvent({ day: TODAY, questions: [{ kind: "rpe", window: ALL_DAY }] })).body.event;
  const [rpe2] = await liveQuestions(ev2.id);
  const mine = await api("/api/calendar/questions/mine", { cookie: m.athletes.athlete.cookie });
  const item = mine.body.questions.find((x) => x.questionId === rpe2.id);
  assert.ok(item, mine.text);
  const answer = await api(`/api/training-load/external-assignments/${item.form.externalAssignmentId}/rpe`, { method: "POST", cookie: m.athletes.athlete.cookie, body: { rpe: 6, durationMinutes: 60 } });
  assert.ok([200, 201].includes(answer.status), answer.text);
  const session2 = await planSession(m.athletes.athlete, TODAY);
  const refused = await api(`/api/calendar/events/${ev2.id}/sessions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: [session2.logicalSessionId] } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error, "rpe_already_answered");
  // A schedule linked by set_schedule (not a question): an RPE ask is refused.
  const ext = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { eventName: "Linked by hand", scheduleKind: "one_time", startDate: addDays(TODAY, 11), timezone: "UTC", opensTime: "18:00", closesTime: "22:00", targets: [{ kind: "team", id: m.teams.t1 }] },
  });
  const ev3 = (await createTeamEvent({ day: addDays(TODAY, 11), questions: [] })).body.event;
  const linked = await api(`/api/calendar/events/${ev3.id}`, { method: "PATCH", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, externalScheduleId: ext.body.schedules[0].id } });
  assert.equal(linked.status, 200, linked.text);
  const ask3 = await api(`/api/calendar/events/${ev3.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 2, kind: "rpe", window: { kind: "after_event" } } });
  assert.equal(ask3.status, 409);
  assert.equal(ask3.body.error, "rpe_already_linked");
});

async function planSession(athlete, date) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft)
     values ('weekly',$1,$2,'Week','active',$3,true,false) returning id`,
    [role("teamCoach").id, athlete.athleteId, date],
  ))[0].id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, m.teams.t1]);
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,'Team training','PM','T',1,'18:00',true,true,$2)`,
    [dayId, logicalSessionId],
  );
  return { planId, logicalSessionId };
}

test("9. WELLNESS never twice on a day: an athlete's WELLNESS already made that day refuses an event's WELLNESS ask", async () => {
  const day = addDays(TODAY, 1);
  const one = await api("/api/tests/schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: day, opensTime: "06:00", closesTime: "10:00", targets: [{ kind: "athlete", id: athleteTwo.athleteId }] },
  });
  assert.equal(one.status, 201, one.text);
  const occ = (await q(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [one.body.schedule.id, day]))[0].id;
  await q(`insert into tests.test_occurrence_target_snapshot (occurrence_id, athlete_id) values ($1, $2)`, [occ, athleteTwo.athleteId]);
  await q(`insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5)`,
    [occ, athleteTwo.athleteId, day, `${day}T06:00:00Z`, `${day}T10:00:00Z`]);
  const ev = (await createTeamEvent({ day, questions: [] })).body.event;
  const ask = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: { kind: "after_event" } } });
  assert.equal(ask.status, 409, ask.text);
  assert.equal(ask.body.error, "wellness_already_scheduled");
  assert.equal(ask.body.message, "Today's WELLNESS already covers this day.");
  assert.equal((await liveQuestions(ev.id)).length, 0, "nothing was asked");
  await q(`update tests.test_schedules set status = 'cancelled' where id = $1`, [one.body.schedule.id]);
});

test("10. Skip days off (⚑4): a Day off before materialization makes the day's assignment `cancelled` with a day_off row; after it, the Day off cancels the open ones; switch / flag / club conditions; the Tests overview, the worker and the candidate dates", async () => {
  const daily = await dailyWellness({ skipDaysOff: true });
  const flagOff = await dailyWellness({ skipDaysOff: false });
  assert.equal((await q(`select skip_days_off from tests.test_schedules where id = $1`, [daily]))[0].skip_days_off, true);
  // A Day off of the team today, before anything is materialized.
  const dayOff = await createTeamEvent({ kind: "day_off", title: "Rest", questions: [] });
  assert.equal(dayOff.status, 201, dayOff.text);
  await materialize(daily);
  const rows = await assignmentsOf(daily);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.status, r.skip_reason]), [["cancelled", "day_off"], ["cancelled", "day_off"]]);
  // The flag off: asked as today.
  await materialize(flagOff);
  assert.deepEqual((await assignmentsOf(flagOff)).map((r) => [r.status, r.skip_reason]), [["pending", null], ["pending", null]]);
  // resolve_current_target_dates: the skipped day is no longer an outstanding date.
  // (resolve_current_target_dates' from_outstanding_snapshot reads exactly
  // this: a snapshotted athlete without a row keeps the date a candidate.)
  assert.equal((await q(
    `select count(*)::int as n from tests.test_occurrence_target_snapshot s join tests.test_schedule_occurrences o on o.id = s.occurrence_id
      where o.schedule_id = $1 and not exists (select 1 from tests.test_assignments a where a.occurrence_id = o.id and a.athlete_id = s.athlete_id)`,
    [daily],
  ))[0].n, 0, "no snapshotted athlete is left without a row");
  // The notification worker leaves a cancelled assignment alone.
  await q(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, enabled) values ($1, 'athlete_invitation', true)`, [daily]);
  await q(`insert into tests.test_schedule_notification_rules (schedule_id, notification_kind, enabled) values ($1, 'athlete_invitation', true)`, [flagOff]);
  const { processTestNotificationCycle } = await import("../src/testsNotificationWorker.js");
  const summary = await processTestNotificationCycle({ pool: env.appPool });
  // The fixture has no Tests phase-3 dispatch link, so a send itself fails;
  // what the worker ATTEMPTS is the point: the two pending (control), never
  // the two cancelled.
  const attempted = new Set(summary.errors.filter((e) => e.stage === "athlete_invitation").map((e) => String(e.assignmentId)));
  assert.equal(summary.invitations.attempted, 2, JSON.stringify(summary.invitations));
  const pendingIds = (await assignmentsOf(flagOff)).map((r) => String(r.id));
  const cancelledIds = (await assignmentsOf(daily)).map((r) => String(r.id));
  assert.deepEqual([...attempted].sort(), pendingIds.sort(), "the control: the pending ones are invited");
  assert.ok(cancelledIds.every((id) => !attempted.has(id)), "a cancelled assignment is never invited");
  // The Tests overview (GET /api/tests/weekly): the two cancelled are skipped,
  // not open, not missed.
  const weekly = await api(`/api/tests/weekly?weekStart=${TODAY}`, { cookie: role("teamCoach").cookie });
  assert.equal(weekly.status, 200, weekly.text);
  const session = weekly.body.days.find((d) => d.date === TODAY).sessions.find((x) => x.scheduleId === daily);
  assert.ok(session, weekly.text);
  assert.equal(session.counts.skipped, 2, JSON.stringify(session.counts));
  assert.equal(session.counts.total, 2);
  assert.equal(session.counts.openPending, 0);
  // The switch off: the next day's materialization asks as before (no skip).
  await switchOn(m.clubs.c1, false);
  try {
    const plain = await dailyWellness({ skipDaysOff: false });
    await q(`update tests.test_schedules set skip_days_off = true where id = $1`, [plain]);
    await materialize(plain);
    assert.deepEqual((await assignmentsOf(plain)).map((r) => [r.status, r.skip_reason]), [["pending", null], ["pending", null]]);
    await q(`update tests.test_schedules set status = 'cancelled' where id = $1`, [plain]);
  } finally {
    await switchOn(m.clubs.c1, true);
  }
  await q(`update tests.test_schedules set status = 'cancelled' where id = any($1::uuid[])`, [[daily, flagOff]]);
});

test("11. covered_by_event (O3): an event's WELLNESS question makes the daily assignment of that day `cancelled`, whatever skip_days_off says; two event questions on one day are refused; removed before the day, the daily comes back", async () => {
  const team = await fx.makeTeam(m.clubs.c1, "q covered");
  const coach = await fx.coachOf(team, "q covered coach");
  await fx.makeAthlete("q covered one", { clubId: m.clubs.c1, teamId: team });
  await fx.makeAthlete("q covered two", { clubId: m.clubs.c1, teamId: team });
  const mk = async (day, questions) => (await createTeamEvent({ day, questions, targets: [{ kind: "team", id: team }] }, coach.cookie));
  const covering = await mk(TODAY, [{ kind: "wellness", window: ALL_DAY }]);
  assert.equal(covering.status, 201, covering.text);
  const other = (await mk(TODAY, [])).body.event;
  const second = await api(`/api/calendar/events/${other.id}/questions`, { method: "POST", cookie: coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: ALL_DAY } });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.body.error, "wellness_already_scheduled");
  const daily = await api("/api/tests/schedules", {
    method: "POST", cookie: coach.cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate: TODAY, endDate: addDays(TODAY, 3), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: team }], skipDaysOff: false },
  });
  assert.equal(daily.status, 201, daily.text);
  await materialize(daily.body.schedule.id);
  assert.deepEqual((await assignmentsOf(daily.body.schedule.id)).map((r) => [r.status, r.skip_reason]), [["cancelled", "covered_by_event"], ["cancelled", "covered_by_event"]]);
  // The event's own schedule is never covered by itself.
  const [own] = await liveQuestions(covering.body.event.id);
  await materialize(own.test_schedule_id);
  assert.deepEqual((await assignmentsOf(own.test_schedule_id)).map((r) => r.status), ["pending", "pending"]);
  // Removed before its day: nothing covers the day any more.
  const future = addDays(TODAY, 3);
  const evF = (await mk(future, [{ kind: "wellness", window: { kind: "custom", date: future, from: "06:00", to: "09:00" } }])).body.event;
  const [wf] = await liveQuestions(evF.id);
  const rm = await api(`/api/calendar/events/${evF.id}/questions/${wf.id}/remove`, { method: "POST", cookie: coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } });
  assert.equal(rm.status, 200, rm.text);
  assert.equal((await q(`select count(*)::int as n from calendar.event_questions where kind = 'wellness' and ended_at is null and window_date = $1`, [future]))[0].n, 0);
});

test("12. the Tests and TL routes refuse a calendar-managed schedule; Remind stays allowed", async () => {
  const ev = (await createTeamEvent({ day: addDays(TODAY, 12), questions: [{ kind: "rpe", window: { kind: "after_event" } }, { kind: "wellness", window: { kind: "next_morning" } }] })).body.event;
  const qs = await liveQuestions(ev.id);
  const rpe = qs.find((x) => x.kind === "rpe");
  const wel = qs.find((x) => x.kind === "wellness");
  const checks = [
    ["PATCH", `/api/tests/schedules/${wel.test_schedule_id}`, { status: "paused" }],
    ["DELETE", `/api/tests/schedules/${wel.test_schedule_id}`, undefined],
    ["PATCH", `/api/training-load/external-schedules/${rpe.external_schedule_id}`, { eventName: "Other" }],
    ["POST", `/api/training-load/external-schedules/${rpe.external_schedule_id}/pause`, {}],
    ["POST", `/api/training-load/external-schedules/${rpe.external_schedule_id}/resume`, {}],
    ["POST", `/api/training-load/external-schedules/${rpe.external_schedule_id}/cancel`, {}],
    ["POST", `/api/training-load/external-schedules/${rpe.external_schedule_id}/schedule-again`, { startDate: addDays(TODAY, 20) }],
  ];
  for (const [method, path, body] of checks) {
    const res = await api(path, { method, cookie: role("teamCoach").cookie, body });
    assert.equal(res.status, 409, `${method} ${path}: ${res.text}`);
    assert.equal(res.body.error, "schedule_managed_by_calendar");
    assert.equal(res.body.message, "This question belongs to a calendar event. Change it on the event.");
  }
  const remindT = await api(`/api/tests/schedules/${wel.test_schedule_id}/remind`, { method: "POST", cookie: role("teamCoach").cookie, body: {} });
  assert.notEqual(remindT.status, 409, remindT.text);
  const remindL = await api(`/api/training-load/external-schedules/${rpe.external_schedule_id}/remind`, { method: "POST", cookie: role("teamCoach").cookie, body: {} });
  assert.notEqual(remindL.status, 409, remindL.text);
});

test("13. skipDaysOff on the Tests route: only daily, only while the club's switch is on", async () => {
  const oneTime = await api("/api/tests/schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: addDays(TODAY, 30), opensTime: "06:00", closesTime: "09:00", targets: [{ kind: "team", id: m.teams.t1 }], skipDaysOff: true },
  });
  assert.equal(oneTime.status, 400);
  assert.equal(oneTime.body.error, "skip_days_off_unavailable");
  const otherClubCoach = await fx.coachOf(m.teams.u1, "q coach U1");
  const offClub = await api("/api/tests/schedules", {
    method: "POST", cookie: otherClubCoach.cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate: addDays(TODAY, 30), endDate: addDays(TODAY, 31), opensTime: "06:00", closesTime: "09:00", targets: [{ kind: "team", id: m.teams.u1 }], skipDaysOff: true },
  });
  assert.equal(offClub.status, 400, offClub.text);
  assert.equal(offClub.body.error, "skip_days_off_unavailable");
});

test("14. a lost COMMIT of an ask: verified after the error, or 503 outcome_unknown, never a second schedule; Later's lost COMMIT the same", async () => {
  const ev = (await createTeamEvent({ day: addDays(TODAY, 14), questions: [] })).body.event;
  const body = { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } };
  eventHooks.commit = async (client) => { await client.query("commit"); throw new Error("the answer was lost"); };
  try {
    const res = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.verifiedAfterCommitError, true);
  } finally {
    delete eventHooks.commit;
  }
  const again = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body });
  assert.equal(again.body.replayed, true);
  assert.equal((await liveQuestions(ev.id)).length, 1);
  const ev2 = (await createTeamEvent({ day: addDays(TODAY, 15), questions: [] })).body.event;
  eventHooks.commit = () => new Promise(() => {});
  eventHooks.commitTimeoutMs = 300;
  eventHooks.checkFault = async () => { throw new Error("no answer"); };
  try {
    const res = await api(`/api/calendar/events/${ev2.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { ...body, requestKey: newKey() } });
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.error, "outcome_unknown");
  } finally {
    delete eventHooks.commit;
    delete eventHooks.commitTimeoutMs;
    delete eventHooks.checkFault;
  }
  // Later.
  const evL = (await createTeamEvent({ day: TODAY, questions: [{ kind: "rpe", window: ALL_DAY }] })).body.event;
  const [lq] = await liveQuestions(evL.id);
  await api("/api/calendar/questions/mine", { cookie: athleteTwo.cookie });
  const laterKey = newKey();
  questionHooks.commit = async (client) => { await client.query("commit"); throw new Error("lost"); };
  try {
    const res = await api(`/api/calendar/questions/${lq.id}/later`, { method: "POST", cookie: athleteTwo.cookie, body: { requestKey: laterKey } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.verifiedAfterCommitError, true);
  } finally {
    delete questionHooks.commit;
  }
  assert.equal((await q(`select count(*)::int as n from calendar.question_postponements where request_key = $1`, [laterKey]))[0].n, 1);
});

test("15. the recorded SQL of an ask: every locking clause before the first write, in the contract's order (9.1.4)", async () => {
  const ev = (await createTeamEvent({ day: addDays(TODAY, 16), questions: [{ kind: "rpe", window: { kind: "after_event" } }] })).body.event;
  const sql = [];
  eventHooks.beforeLocks = async ({ client }) => {
    const original = client.query.bind(client);
    client.query = (...args) => { sql.push(typeof args[0] === "string" ? args[0] : args[0]?.text || ""); return original(...args); };
  };
  try {
    const res = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: role("teamCoach").cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: { kind: "next_morning" } } });
    assert.equal(res.status, 200, res.text);
  } finally {
    delete eventHooks.beforeLocks;
  }
  const isWrite = (s) => /^\s*(insert|update|delete)\b/i.test(s);
  const isLock = (s) => /\bfor (update|share|no key update)\b/i.test(s) || /pg_advisory_xact_lock|lock_event_writer/i.test(s);
  const firstWrite = sql.findIndex(isWrite);
  assert.ok(firstWrite > 0);
  const locksAfter = sql.slice(firstWrite).filter(isLock).filter((s) => !/requests? where performed_by_user_id/.test(s));
  assert.deepEqual(locksAfter, [], "no locking clause after the first write");
  const order = [
    sql.findIndex((s) => /lock_event_writer/.test(s)),
    sql.findIndex((s) => /from calendar\.events e[\s\S]*for no key update of e/.test(s)),
    sql.findIndex((s) => /club_question_settings[\s\S]*for share/.test(s)),
    sql.findIndex((s) => /calendar\.event_questions[\s\S]*for no key update/.test(s)),
    sql.findIndex((s) => /training_load\.external_schedules[\s\S]*for update/.test(s)),
    sql.findIndex((s) => /wellness_day_key/.test(s)),
  ];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "writer, event, switch, questions, TL, the day key");
});

test("16. a Day off and a materialization at once, in both orders: no 40P01, the day ends consistent", async () => {
  const day = TODAY;
  for (const first of ["materialize", "dayoff"]) {
    const team = await fx.makeTeam(m.clubs.c1, `q race ${first}`);
    const coach = await fx.coachOf(team, `q race coach ${first}`);
    const ath = await fx.makeAthlete(`q race athlete ${first}`, { clubId: m.clubs.c1, teamId: team });
    const daily = await api("/api/tests/schedules", {
      method: "POST", cookie: coach.cookie,
      body: { testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate: day, endDate: addDays(day, 2), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: team }], skipDaysOff: true },
    });
    assert.equal(daily.status, 201, daily.text);
    const scheduleId = daily.body.schedule.id;
    const holder = new pg.Client({ connectionString: env.db.url });
    await holder.connect();
    const dayOffBody = {
      requestKey: newKey(), eventTypeId: await typeId(m.clubs.c1, "day_off"), title: `Rest ${first}`, day, timezone: "UTC",
      targets: [{ kind: "team", id: team }], questions: [],
    };
    try {
      if (first === "materialize") {
        await holder.query("begin");
        const occ = (await holder.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, day])).rows[0].id;
        await holder.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ]);
        const pending = api("/api/calendar/events", { method: "POST", cookie: coach.cookie, body: dayOffBody });
        await new Promise((r) => setTimeout(r, 400));
        await holder.query("commit");
        const res = await pending;
        assert.equal(res.status, 201, res.text);
        const rows = await assignmentsOf(scheduleId);
        assert.deepEqual(rows.map((r) => [r.status, r.skip_reason]), [["cancelled", "day_off_cancelled"]], "made first, then cancelled by the Day off");
      } else {
        await holder.query("begin");
        await holder.query(`select pg_advisory_xact_lock(calendar.wellness_day_key($1, $2::date))`, [m.clubs.c1, day]);
        const pending = api("/api/calendar/events", { method: "POST", cookie: coach.cookie, body: dayOffBody });
        await new Promise((r) => setTimeout(r, 300));
        const mat = (async () => {
          const c2 = new pg.Client({ connectionString: env.db.url });
          await c2.connect();
          try {
            await c2.query("begin");
            const occ = (await c2.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, day])).rows[0].id;
            await c2.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ]);
            await c2.query("commit");
          } finally {
            await c2.end();
          }
        })();
        await holder.query("commit");
        const res = await pending;
        assert.equal(res.status, 201, res.text);
        await mat;
        const rows = await assignmentsOf(scheduleId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "cancelled", "whichever order: never an open WELLNESS on the Day off");
        assert.equal(rows[0].skip_reason, "day_off", "the materialization waited on the day's key and saw the committed Day off");
      }
    } finally {
      await holder.end();
    }
  }
});

test("17. a cancelled insert passes every Tests CHECK and trigger (the function's own insert), and is terminal", async () => {
  const rows = await q(`select a.id, a.status from tests.test_assignments a join calendar.question_assignment_skips k on k.assignment_id = a.id limit 1`);
  assert.equal(rows.length, 1);
  await assert.rejects(q(`update tests.test_assignments set status = 'pending' where id = $1`, [rows[0].id]), /terminal|backward/);
  await assert.rejects(q(`delete from calendar.question_assignment_skips where assignment_id = $1`, [rows[0].id]));
});

test("18. the type's default questions: Settings while on, questions_off while off", async () => {
  const admin = role("clubAdmin");
  const type = (await q(`select id, revision from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = 'match'`, [m.clubs.c1]))[0];
  const res = await api(`/api/calendar/settings/types/${type.id}`, { method: "PATCH", cookie: admin.cookie, body: { requestKey: newKey(), expectedRevision: type.revision, defaultQuestions: ["wellness", "rpe"] } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.type.defaultQuestions, ["rpe", "wellness"]);
  const off = await api(`/api/calendar/settings/types/${(await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = 'match'`, [m.clubs.c2]))[0].id}`, { method: "PATCH", cookie: role("stranger").cookie, body: { requestKey: newKey(), expectedRevision: 1, defaultQuestions: ["rpe"] } });
  assert.equal(off.status, 409, off.text);
  assert.equal(off.body.error, "questions_off");
});


test("19. the database guards on their own (a raw write past the services): the switch, the owner, the window, her own Later, a skip row of a live assignment", async () => {
  const ev = (await createTeamEvent({ day: addDays(TODAY, 20), questions: [] })).body.event;
  const otherTeamSchedule = await api("/api/tests/schedules", {
    method: "POST", cookie: role("clubAdmin").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: addDays(TODAY, 21), opensTime: "07:00", closesTime: "12:00", targets: [{ kind: "team", id: m.teams.t2 }] },
  });
  assert.equal(otherTeamSchedule.status, 201, otherTeamSchedule.text);
  const raw = async (sql, params, re, label) => {
    const c = new pg.Client({ connectionString: env.db.url });
    await c.connect();
    try {
      await c.query("begin");
      await assert.rejects(c.query(sql, params), re, label);
    } finally {
      await c.query("rollback").catch(() => {});
      await c.end();
    }
  };
  const insertQuestion = `insert into calendar.event_questions (event_id, kind, test_schedule_id, window_kind, window_date, opens_time, closes_time, created_by_user_id)
                          values ($1, 'wellness', $2, 'next_morning', $3, '07:00', '12:00', $4)`;
  await raw(insertQuestion, [ev.id, otherTeamSchedule.body.schedule.id, addDays(TODAY, 21), role("teamCoach").id], /belongs to the event's owner/, "the owner");
  const own = await api("/api/tests/schedules", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: addDays(TODAY, 21), opensTime: "07:00", closesTime: "11:00", targets: [{ kind: "team", id: m.teams.t1 }] },
  });
  assert.equal(own.status, 201, own.text);
  await raw(insertQuestion, [ev.id, own.body.schedule.id, addDays(TODAY, 21), role("teamCoach").id], /question's window/, "the window");
  const c2Coach = await fx.coachOf(m.teams.u1, "q raw coach U1");
  const evOff = (await createTeamEvent({ day: addDays(TODAY, 20), clubId: m.clubs.c2, targets: [{ kind: "team", id: m.teams.u1 }] }, c2Coach.cookie));
  assert.equal(evOff.status, 201, evOff.text);
  await raw(insertQuestion, [evOff.body.event.id, own.body.schedule.id, addDays(TODAY, 21), c2Coach.id], /not turned on/, "the switch");
  const open = (await createTeamEvent({ day: TODAY, questions: [{ kind: "wellness", window: ALL_DAY }], targets: [{ kind: "athlete", id: m.athletes.athlete.athleteId }] }));
  assert.equal(open.status, 201, open.text);
  const [oq] = await liveQuestions(open.body.event.id);
  await api("/api/calendar/questions/mine", { cookie: m.athletes.athlete.cookie });
  await raw(`insert into calendar.question_postponements (question_id, athlete_id, performed_by_user_id, request_key) values ($1, $2, $3, $4)`,
    [oq.id, m.athletes.athlete.athleteId, athleteTwo.userId, newKey()], /only her own/, "her own Later");
  const [live] = await assignmentsOf(oq.test_schedule_id);
  assert.equal(live.status, "pending");
  await raw(`insert into calendar.question_assignment_skips (assignment_id, athlete_id, event_id, reason) values ($1, $2, $3, 'day_off')`,
    [live.id, live.athlete_id, open.body.event.id], /athlete's and cancelled/, "a skip row of a live assignment");
});

test("20. the Day off's effect stays inside its club (⚑7): another club's Day off reaching an athlete of two clubs skips nothing of this club's schedule", async () => {
  // A team of C1 with no Day off of C1 today (test 10's Day off is T1's).
  const t4 = await fx.makeTeam(m.clubs.c1, "q T4");
  const both = await fx.makeAthlete("q two clubs", { clubId: m.clubs.c1, teamId: t4 });
  await fx.addMembership({ athleteId: both.athleteId, clubId: m.clubs.c2, type: "club" });
  const c2Admin = role("stranger");
  const res = await api("/api/calendar/settings/questions", { method: "PUT", cookie: (await fx.platformAdmin("q platform C2", { clubId: m.clubs.c2 })).cookie, body: { requestKey: newKey(), enabled: true, reason: "Second pilot club." } });
  assert.equal(res.status, 200, res.text);
  const day = TODAY;
  const otherDayOff = await api("/api/calendar/events", {
    method: "POST", cookie: c2Admin.cookie,
    body: { requestKey: newKey(), eventTypeId: await typeId(m.clubs.c2, "day_off"), title: "C2 rest", day, timezone: "UTC", targets: [{ kind: "club", id: m.clubs.c2 }], questions: [] },
  });
  assert.equal(otherDayOff.status, 201, otherDayOff.text);
  const sched = await api("/api/tests/schedules", {
    method: "POST", cookie: role("clubAdmin").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate: day, endDate: addDays(day, 1), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: both.athleteId }], skipDaysOff: true },
  });
  assert.equal(sched.status, 201, sched.text);
  await materialize(sched.body.schedule.id);
  const rows = await assignmentsOf(sched.body.schedule.id);
  assert.deepEqual(rows.map((r) => [r.status, r.skip_reason]), [["pending", null]], "C2's Day off is not C1's");
});

// ---------------------------------------------------------------------------
// Review round 1 (plan 9.1.15)
// ---------------------------------------------------------------------------
async function freshTeam(label, n = 2) {
  const team = await fx.makeTeam(m.clubs.c1, `q ${label}`);
  const coach = await fx.coachOf(team, `q ${label} coach`);
  const athletes = [];
  for (let i = 0; i < n; i += 1) athletes.push(await fx.makeAthlete(`q ${label} athlete ${i + 1}`, { clubId: m.clubs.c1, teamId: team }));
  return { team, coach, athletes };
}
async function teamEvent(t, body) {
  const res = await createTeamEvent({ ...body, targets: body.targets || [{ kind: "team", id: t.team }] }, t.coach.cookie);
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
async function teamDaily(t, { skipDaysOff, startDate = TODAY } = {}) {
  const res = await api("/api/tests/schedules", {
    method: "POST", cookie: t.coach.cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "daily", timezone: "UTC", startDate, endDate: addDays(startDate, 3), opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: t.team }], skipDaysOff },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.schedule.id;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves to { ok, value | error } and never rejects; `done` tells whether it settled.
function track(promise) {
  const t = { done: false };
  t.p = promise.then((value) => { t.done = true; t.value = value; return t; }, (error) => { t.done = true; t.error = error; return t; });
  return t;
}

// H1, probe R3 and its variants: the command holds the event row (and the
// live questions) and is held at a gate right after the row lock; the day's
// materialization runs meanwhile, takes the day key SHARED and writes its skip
// row (a foreign key check on the event / the question); then the command
// goes on and wants the key EXCLUSIVE. With FOR UPDATE that is a 40P01; with
// FOR NO KEY UPDATE the materialization never waits on the command.
async function gatedRace({ label, operation, startCommand, scheduleId, expectReason }) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let reached;
  const atGate = new Promise((r) => { reached = r; });
  eventHooks.afterEventLock = async (info) => {
    if (info.operation !== operation) return;
    reached();
    await gate;
  };
  const holder = new pg.Client({ connectionString: env.db.url });
  await holder.connect();
  let command;
  let mat;
  try {
    command = track(startCommand());
    await Promise.race([atGate, sleep(5000)]);
    await holder.query("begin");
    mat = track((async () => {
      const occ = (await holder.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [scheduleId, TODAY])).rows[0].id;
      await holder.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ]);
    })());
    await Promise.race([mat.p, sleep(2500)]);
    assert.equal(mat.done, true, `${label}: the materialization must not wait on the command's event / question lock`);
    assert.equal(mat.error, undefined, `${label}: ${mat.error?.code} ${mat.error?.message}`);
    release();
    await sleep(300);
    await holder.query("commit");
    const res = (await command.p);
    assert.equal(res.error, undefined, `${label}: ${res.error?.message}`);
    assert.ok([200, 201].includes(res.value.status), `${label}: ${res.value.text}`);
    if (expectReason) assert.deepEqual([...new Set((await assignmentsOf(scheduleId)).map((r) => r.skip_reason))], [expectReason]);
  } finally {
    release();
    delete eventHooks.afterEventLock;
    if (mat) await mat.p;
    if (command) await command.p;
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
}

test("21. H1 (probe R3): a Day off widened, a WELLNESS asked on a Day off and a WELLNESS moved, each while the day's materialization runs — no 40P01 in either order", async () => {
  // R3: a planned Day off today, a daily skip-days-off WELLNESS, a PATCH that
  // widens the Day off while the day's materialization runs.
  const a = await freshTeam("r3a");
  const dayOff = await teamEvent(a, { kind: "day_off", title: "Rest R3", questions: [] });
  const dailyA = await teamDaily(a, { skipDaysOff: true });
  await gatedRace({
    label: "R3 widen", operation: "update", scheduleId: dailyA, expectReason: "day_off",
    startCommand: () => api(`/api/calendar/events/${dayOff.id}`, { method: "PATCH", cookie: a.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, endDay: addDays(TODAY, 1) } }),
  });
  // A WELLNESS ask on the Day off itself (the coach may ask on a day off).
  const b = await freshTeam("r3b");
  const dayOffB = await teamEvent(b, { kind: "day_off", title: "Rest R3b", questions: [] });
  const dailyB = await teamDaily(b, { skipDaysOff: true });
  await gatedRace({
    label: "ask", operation: "ask_question", scheduleId: dailyB, expectReason: "day_off",
    startCommand: () => api(`/api/calendar/events/${dayOffB.id}/questions`, { method: "POST", cookie: b.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: ALL_DAY } }),
  });
  // A WELLNESS move while the daily's materialization records covered_by_event
  // against the question being moved.
  const c = await freshTeam("r3c");
  const ev = await teamEvent(c, { title: "Covered R3c", questions: [{ kind: "wellness", window: ALL_DAY }] });
  const [wq] = await liveQuestions(ev.id);
  const dailyC = await teamDaily(c, { skipDaysOff: false });
  await gatedRace({
    label: "move", operation: "move_question", scheduleId: dailyC, expectReason: "covered_by_event",
    startCommand: () => api(`/api/calendar/events/${ev.id}/questions/${wq.id}/move`, { method: "POST", cookie: c.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, window: { kind: "custom", date: TODAY, from: "00:01", to: "23:58" } } }),
  });
  // The other order: the command holds everything at its COMMIT (the key
  // exclusive included); the materialization waits for it, then sees the
  // widened Day off.
  const d = await freshTeam("r3d");
  const dayOffD = await teamEvent(d, { kind: "day_off", title: "Rest R3d", day: addDays(TODAY, -1), questions: [] });
  const dailyD = await teamDaily(d, { skipDaysOff: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  eventHooks.beforeCommit = async ({ operation }) => { if (operation === "update") await gate; };
  const holder = new pg.Client({ connectionString: env.db.url });
  await holder.connect();
  try {
    const command = track(api(`/api/calendar/events/${dayOffD.id}`, { method: "PATCH", cookie: d.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, endDay: TODAY } }));
    await sleep(500);
    const mat = track((async () => {
      const occ = (await holder.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [dailyD, TODAY])).rows[0].id;
      await holder.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occ]);
    })());
    await sleep(500);
    assert.equal(mat.done, false, "the materialization waits for the Day off's key");
    release();
    const res = await command.p;
    assert.equal(res.value.status, 200, res.value.text);
    await mat.p;
    assert.equal(mat.error, undefined, String(mat.error?.message));
    assert.deepEqual((await assignmentsOf(dailyD)).map((r) => [r.status, r.skip_reason]), [["cancelled", "day_off"], ["cancelled", "day_off"]]);
  } finally {
    release();
    delete eventHooks.beforeCommit;
    await holder.end();
  }
});

test("22. H2 (test 8b): while an RPE question is live, the event's RPE link changes neither to another schedule nor to null; the database twin refuses a raw write", async () => {
  const t = await freshTeam("h2");
  const ev = await teamEvent(t, { day: addDays(TODAY, 2), questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  const [rpe] = await liveQuestions(ev.id);
  const other = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: t.coach.cookie,
    body: { eventName: "Other RPE", scheduleKind: "one_time", startDate: addDays(TODAY, 2), timezone: "UTC", opensTime: "18:00", closesTime: "22:00", targets: [{ kind: "team", id: t.team }] },
  });
  assert.equal(other.status, 201, other.text);
  for (const value of [other.body.schedules[0].id, null]) {
    const res = await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, externalScheduleId: value } });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, "rpe_from_question");
    assert.equal(res.body.message, "This event already asks athletes for RPE. Remove that question first.");
    assert.equal(String((await eventRow(ev.id)).external_schedule_id), String(rpe.external_schedule_id));
    assert.equal((await liveQuestions(ev.id)).length, 1);
  }
  await assert.rejects(
    q(`update calendar.events set external_schedule_id = $2, revision = revision + 1 where id = $1`, [ev.id, other.body.schedules[0].id]),
    /live RPE question keeps the event's RPE schedule/,
  );
});

test("23. M1: an athlete target who left the club before the window's day gets no schedule target, no notification, and is not in the panel; nobody left is 409 no_athletes", async () => {
  const t = await freshTeam("m1", 1);
  const leaver = await fx.makeAthlete("q m1 leaver", { clubId: m.clubs.c1, teamId: t.team });
  await q(`update public.athlete_memberships set status = 'archived', archived_at = now() where athlete_id = $1`, [leaver.athleteId]);
  const day = addDays(TODAY, 3);
  const ev = await teamEvent(t, { day, questions: [], targets: [{ kind: "athlete", id: t.athletes[0].athleteId }, { kind: "athlete", id: leaver.athleteId }] }).catch(() => null);
  // The event's own create judges its targets by the calendar's rule; fall back to
  // writing the leaver's target directly when the create already refuses her.
  let eventId = ev?.id;
  if (!eventId) {
    const made = await teamEvent(t, { day, questions: [], targets: [{ kind: "athlete", id: t.athletes[0].athleteId }] });
    eventId = made.id;
    await q(`insert into calendar.event_targets (event_id, target_kind, target_athlete_id) values ($1, 'athlete', $2)`, [eventId, leaver.athleteId]);
  }
  const ask = await api(`/api/calendar/events/${eventId}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: (await eventRow(eventId)).revision, kind: "rpe", window: { kind: "after_event" } } });
  assert.equal(ask.status, 200, ask.text);
  const [rpe] = await liveQuestions(eventId);
  const targets = await q(`select target_athlete_id from training_load.external_schedule_targets where schedule_id = $1`, [rpe.external_schedule_id]);
  assert.deepEqual(targets.map((r) => String(r.target_athlete_id)), [String(t.athletes[0].athleteId)], "the leaver is not a schedule target");
  const notified = await q(`select recipient_user_id from public.app_notifications where entity_id = $1`, [eventId]);
  assert.deepEqual(notified.map((r) => String(r.recipient_user_id)), [String(t.athletes[0].userId)]);
  const panel = await api(`/api/calendar/events/${eventId}/questions`, { cookie: t.coach.cookie });
  assert.deepEqual(panel.body.questions[0].notAnswered.map((a) => a.athleteId), [String(t.athletes[0].athleteId)]);
  // Only the leaver targeted: nobody to ask. Her target is swapped in by a raw
  // write in one transaction (v49 keeps every event with a target at COMMIT).
  const solo = await teamEvent(t, { day, questions: [], targets: [{ kind: "athlete", id: t.athletes[0].athleteId }] });
  await q("begin");
  try {
    await q(`delete from calendar.event_targets where event_id = $1`, [solo.id]);
    await q(`insert into calendar.event_targets (event_id, target_kind, target_athlete_id) values ($1, 'athlete', $2)`, [solo.id, leaver.athleteId]);
    await q("commit");
  } catch (error) {
    await q("rollback");
    throw error;
  }
  const none = await api(`/api/calendar/events/${solo.id}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } } });
  assert.equal(none.status, 409, none.text);
  assert.equal(none.body.error, "no_athletes");
  assert.equal(none.body.message, "Nobody on this event can be asked on that day.");
  assert.equal((await liveQuestions(solo.id)).length, 0);
});

test("23b. round 1b: an athlete target whose membership ended before the window's day is not asked on that day (RPE and WELLNESS): not in /mine, Later 404, not counted, no assignment; question_open_for refuses her even with a backdated assignment", async () => {
  const t = await freshTeam("m1b", 2);
  const [stay, leave] = t.athletes;
  const ev = await teamEvent(t, {
    title: "M1b", targets: [{ kind: "athlete", id: stay.athleteId }, { kind: "athlete", id: leave.athleteId }],
    questions: [{ kind: "rpe", window: ALL_DAY }, { kind: "wellness", window: ALL_DAY }],
  });
  const qs = await liveQuestions(ev.id);
  const rpe = qs.find((x) => x.kind === "rpe");
  const wel = qs.find((x) => x.kind === "wellness");
  const endPeriods = async (athleteId) => {
    await q(`alter table public.athlete_membership_periods disable trigger athlete_membership_periods_protect`);
    try {
      await q(`update public.athlete_membership_periods set valid_from = least(valid_from, now() - interval '5 days'), valid_to = now() - interval '2 days' where athlete_id = $1`, [athleteId]);
    } finally {
      await q(`alter table public.athlete_membership_periods enable trigger athlete_membership_periods_protect`);
    }
  };
  // (A) Her periods end before the window's day, after the ask and before any
  // occurrence of the day: the module's resolvers still list her as a target.
  await endPeriods(leave.athleteId);
  const mineStay = await api("/api/calendar/questions/mine", { cookie: stay.cookie });
  assert.deepEqual(mineStay.body.questions.map((x) => x.questionId).sort(), [rpe.id, wel.id].sort(), "the one who stays is asked");
  const mineLeave = await api("/api/calendar/questions/mine", { cookie: leave.cookie });
  assert.equal(mineLeave.status, 200, mineLeave.text);
  assert.deepEqual(mineLeave.body.questions, [], "nothing for the leaver");
  for (const question of [rpe, wel]) {
    const later = await api(`/api/calendar/questions/${question.id}/later`, { method: "POST", cookie: leave.cookie, body: { requestKey: newKey() } });
    assert.equal(later.status, 404, later.text);
  }
  const panel = await api(`/api/calendar/events/${ev.id}/questions`, { cookie: t.coach.cookie });
  for (const pq of panel.body.questions) {
    assert.equal(pq.counts.asked, 1, `${pq.kind}: counts.asked excludes her`);
    assert.deepEqual(pq.notAnswered.map((a) => a.athleteId), [String(stay.athleteId)]);
  }
  const assignments = async () => ({
    rpe: (await q(`select count(*)::int as n from training_load.external_assignments a join training_load.external_schedule_occurrences o on o.id = a.occurrence_id where o.schedule_id = $1 and a.athlete_id = $2`, [rpe.external_schedule_id, leave.athleteId]))[0].n,
    wel: (await q(`select count(*)::int as n from tests.test_assignments a join tests.test_schedule_occurrences o on o.id = a.occurrence_id where o.schedule_id = $1 and a.athlete_id = $2`, [wel.test_schedule_id, leave.athleteId]))[0].n,
  });
  assert.deepEqual(await assignments(), { rpe: 0, wel: 0 }, "no assignment for her (her answer has nothing to attach to)");
  // The module's own materialization, called again, still makes none for her.
  await q(`select training_load.materialize_external_assignments_for_occurrence(o.id) from training_load.external_schedule_occurrences o where o.schedule_id = $1`, [rpe.external_schedule_id]);
  await q(`select tests.materialize_test_assignments_for_occurrence(o.id) from tests.test_schedule_occurrences o where o.schedule_id = $1`, [wel.test_schedule_id]);
  assert.deepEqual(await assignments(), { rpe: 0, wel: 0 });

  // (B) A backdated end: her assignments were made while she was a member, then
  // her periods are ended before the day. The calendar no longer offers them.
  const t2 = await freshTeam("m1bb", 2);
  const [stay2, late2] = t2.athletes;
  const ev2 = await teamEvent(t2, {
    title: "M1b backdated", targets: [{ kind: "athlete", id: stay2.athleteId }, { kind: "athlete", id: late2.athleteId }],
    questions: [{ kind: "rpe", window: ALL_DAY }, { kind: "wellness", window: ALL_DAY }],
  });
  const qs2 = await liveQuestions(ev2.id);
  const before = await api("/api/calendar/questions/mine", { cookie: late2.cookie });
  assert.equal(before.body.questions.length, 2, "asked while a member");
  await endPeriods(late2.athleteId);
  const after = await api("/api/calendar/questions/mine", { cookie: late2.cookie });
  assert.deepEqual(after.body.questions, []);
  for (const question of qs2) {
    assert.equal((await q(`select calendar.question_open_for($1, $2) as o`, [question.id, late2.athleteId]))[0].o, false, `${question.kind}: not open for her`);
    assert.equal((await q(`select calendar.question_open_for($1, $2) as o`, [question.id, stay2.athleteId]))[0].o, true, `${question.kind}: open for the one who stays`);
    await assert.rejects(
      q(`insert into calendar.question_postponements (question_id, athlete_id, performed_by_user_id, request_key) values ($1, $2, $3, $4)`, [question.id, late2.athleteId, late2.userId, newKey()]),
      (e) => e.constraint === "question_postponements_open",
      `${question.kind}: the database refuses her Later`,
    );
    const later = await api(`/api/calendar/questions/${question.id}/later`, { method: "POST", cookie: late2.cookie, body: { requestKey: newKey() } });
    assert.equal(later.status, 404, later.text);
  }
  const panel2 = await api(`/api/calendar/events/${ev2.id}/questions`, { cookie: t2.coach.cookie });
  for (const pq of panel2.body.questions) assert.equal(pq.counts.asked, 1, `${pq.kind}: not counted after the backdated end`);
});

test("23c. round 1b (db LOW): a club event's athlete target counts through a club period, or a team period of one of the club's ACTIVE teams", async () => {
  const team = await fx.makeTeam(m.clubs.c1, "q m1c");
  const only = (await q(`insert into public.athletes (full_name, display_name) values ('q m1c team only', 'q m1c team only') returning id`))[0].id;
  await fx.addMembership({ athleteId: only, clubId: m.clubs.c1, teamId: team });
  const member = async () => (await q(`select calendar.athlete_member_of_owner_on_day('club', $1, null, $2, current_date) as ok`, [m.clubs.c1, only]))[0].ok;
  assert.equal(await member(), true, "a team period of an active team of the club");
  await q(`update public.teams set is_active = false where id = $1`, [team]);
  assert.equal(await member(), false, "a team period of an inactive team does not count");
  await fx.addMembership({ athleteId: only, clubId: m.clubs.c1, type: "club" });
  assert.equal(await member(), true, "a club period counts");
  assert.equal((await q(`select calendar.athlete_member_of_owner_on_day('team', $1, $2, $3, current_date) as ok`, [m.clubs.c1, team, only]))[0].ok, true, "the team rule is unchanged");
});

test("24. M3 (test 12b): a check-in link made on a calendar question's schedule is revoked when the question is removed; its token answers 404", async () => {
  const t = await freshTeam("m3", 1);
  const ev = await teamEvent(t, { day: addDays(TODAY, 4), questions: [{ kind: "wellness", window: { kind: "next_morning" } }] });
  const [wq] = await liveQuestions(ev.id);
  const link = await api(`/api/tests/schedules/${wq.test_schedule_id}/link`, { method: "POST", cookie: t.coach.cookie, body: {} });
  assert.equal(link.status, 201, link.text);
  const token = link.body.link.publicToken;
  assert.equal((await api(`/api/tests/check-in/${token}`, { cookie: t.athletes[0].cookie })).status, 200);
  const rm = await api(`/api/calendar/events/${ev.id}/questions/${wq.id}/remove`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } });
  assert.equal(rm.status, 200, rm.text);
  const [row] = await q(`select status, revoked_by_user_id from tests.test_access_links where public_token = $1`, [token]);
  assert.equal(row.status, "revoked");
  assert.equal(String(row.revoked_by_user_id), String(t.coach.id));
  assert.equal((await api(`/api/tests/check-in/${token}`, { cookie: t.athletes[0].cookie })).status, 404);
});

test("25. M4 (a): the realtime event only after the COMMIT — none when the command fails, exactly the athletes' users after an ask, none on a replay", async () => {
  const t = await freshTeam("m4a");
  const calls = [];
  eventHooks.emitRealtime = (userId, type) => calls.push([String(userId), type]);
  try {
    eventHooks.beforeCommit = async ({ operation }) => { if (operation === "ask_question") throw new Error("forced"); };
    const ev = await teamEvent(t, { day: addDays(TODAY, 5), questions: [] });
    const failing = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } } });
    assert.equal(failing.status, 500);
    assert.deepEqual(calls, []);
    delete eventHooks.beforeCommit;
    const body = { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } };
    const ok = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: t.coach.cookie, body });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(calls.map((c) => c[0]).sort(), t.athletes.map((a) => String(a.userId)).sort());
    assert.ok(calls.every((c) => c[1] === "notifications_changed"));
    calls.length = 0;
    const replay = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: t.coach.cookie, body });
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(calls, []);
  } finally {
    delete eventHooks.beforeCommit;
    delete eventHooks.emitRealtime;
  }
});

test("26. M4 (b, c): A2's recipients by membership on the window's day; a late joiner is not asked", async () => {
  const t = await freshTeam("m4b", 0);
  const day = addDays(TODAY, 6);
  const starter = await fx.makeAthlete("q m4b starter");
  await fx.addMembership({ athleteId: starter.athleteId, clubId: m.clubs.c1, type: "club", startsAt: `${day}T00:00:00Z` });
  await fx.addMembership({ athleteId: starter.athleteId, clubId: m.clubs.c1, teamId: t.team, startsAt: `${day}T00:00:00Z` });
  const ended = await fx.makeAthlete("q m4b ended", { clubId: m.clubs.c1, teamId: t.team });
  await q(`update public.athlete_memberships set status = 'archived', archived_at = now() where athlete_id = $1`, [ended.athleteId]);
  const ev = await teamEvent(t, { day: addDays(day, -1), questions: [{ kind: "rpe", window: { kind: "next_morning" } }] });
  const notified = (await q(`select recipient_user_id from public.app_notifications where entity_id = $1`, [ev.id])).map((r) => String(r.recipient_user_id));
  assert.ok(notified.includes(String(starter.userId)), "a period that starts on the window's day: notified");
  assert.ok(!notified.includes(String(ended.userId)), "a period that ended before it: not notified");
  // (c) Late joiners: a member added after the day's snapshot is not asked.
  const lt = await freshTeam("m4c", 1);
  const lev = await teamEvent(lt, { questions: [{ kind: "wellness", window: ALL_DAY }] });
  const [wq] = await liveQuestions(lev.id);
  await materialize(wq.test_schedule_id);
  const late = await fx.makeAthlete("q m4c late", { clubId: m.clubs.c1, teamId: lt.team });
  const mine = await api("/api/calendar/questions/mine", { cookie: late.cookie });
  assert.ok(!mine.body.questions.some((x) => x.questionId === wq.id), "the late joiner is not asked");
  const panel = await api(`/api/calendar/events/${lev.id}/questions`, { cookie: lt.coach.cookie });
  assert.equal(panel.body.questions[0].counts.asked, 1);
});

test("27. M4 (d): an athlete of two clubs who has the other club's WELLNESS that day is still asked by this club's event", async () => {
  const t = await freshTeam("m4d", 0);
  const both = await fx.makeAthlete("q m4d both", { clubId: m.clubs.c1, teamId: t.team });
  await fx.addMembership({ athleteId: both.athleteId, clubId: m.clubs.c2, type: "club" });
  const c2 = await api("/api/tests/schedules", {
    method: "POST", cookie: role("stranger").cookie,
    body: { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: TODAY, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: both.athleteId }] },
  });
  assert.equal(c2.status, 201, c2.text);
  await materialize(c2.body.schedule.id);
  assert.equal((await assignmentsOf(c2.body.schedule.id))[0].status, "pending", "C2's WELLNESS today");
  const ev = await teamEvent(t, { questions: [] });
  const ask = await api(`/api/calendar/events/${ev.id}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: ALL_DAY } });
  assert.equal(ask.status, 200, ask.text);
});

test("28. M4 (e, f, g) and the decisions: Remind's exact answer; Later and ask/move while the switch is off are 404, remove still works; wellness_not_available; a Day off for a past day leaves a closed window missed; skipDaysOff refused for a non-WELLNESS test", async () => {
  const t = await freshTeam("m4e", 1);
  const ev = await teamEvent(t, { questions: [{ kind: "rpe", window: ALL_DAY }, { kind: "wellness", window: ALL_DAY }] });
  const qs = await liveQuestions(ev.id);
  const rpe = qs.find((x) => x.kind === "rpe");
  const wel = qs.find((x) => x.kind === "wellness");
  // (e) Remind on a calendar-managed schedule: allowed, with its own answer.
  const mineE = await api("/api/calendar/questions/mine", { cookie: t.athletes[0].cookie });
  const formOf = (kind) => mineE.body.questions.find((x) => x.questionId === (kind === "rpe" ? rpe.id : wel.id)).form;
  const remindT = await api(`/api/tests/schedules/${wel.test_schedule_id}/remind`, { method: "POST", cookie: t.coach.cookie, body: { assignmentIds: [formOf("wellness").assignmentId] } });
  const remindL = await api(`/api/training-load/external-schedules/${rpe.external_schedule_id}/remind`, { method: "POST", cookie: t.coach.cookie, body: { assignmentIds: [formOf("rpe").externalAssignmentId] } });
  for (const [r, id] of [[remindT, formOf("wellness").assignmentId], [remindL, formOf("rpe").externalAssignmentId]]) {
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.notifiedCount, 1);
    assert.deepEqual(r.body.results.map((x) => [x.assignmentId, x.outcome]), [[id, "notified"]]);
  }
  // (f) The switch off: Later, ask and move are 404; remove still works.
  await api("/api/calendar/questions/mine", { cookie: t.athletes[0].cookie });
  await switchOn(m.clubs.c1, false);
  try {
    const later = await api(`/api/calendar/questions/${wel.id}/later`, { method: "POST", cookie: t.athletes[0].cookie, body: { requestKey: newKey() } });
    assert.equal(later.status, 404, later.text);
    const ev2 = await teamEvent(t, { day: addDays(TODAY, 7) });
    const ask = await api(`/api/calendar/events/${ev2.id}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "rpe", window: { kind: "after_event" } } });
    assert.equal(ask.status, 404);
    const move = await api(`/api/calendar/events/${ev.id}/questions/${rpe.id}/move`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, window: { kind: "custom", date: TODAY, from: "01:00", to: "02:00" } } });
    assert.equal(move.status, 404);
    const rm = await api(`/api/calendar/events/${ev.id}/questions/${rpe.id}/remove`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } });
    assert.equal(rm.status, 200, rm.text);
  } finally {
    await switchOn(m.clubs.c1, true);
  }
  // (g) WELLNESS not available: the version is not active.
  const status = (await q(`select status from tests.test_versions where id = $1`, [WELLNESS]))[0].status;
  let changed = false;
  try {
    await q(`update tests.test_versions set status = 'archived' where id = $1`, [WELLNESS]);
    changed = true;
  } catch (error) {
    // The Tests module freezes an active version: then nothing can make it unavailable here.
    assert.match(error.message, /immutable|frozen|cannot|active/i);
  }
  if (changed) {
    try {
      const ev3 = await teamEvent(t, { day: addDays(TODAY, 8) });
      const ask = await api(`/api/calendar/events/${ev3.id}/questions`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, kind: "wellness", window: { kind: "after_event" } } });
      assert.equal(ask.status, 409, ask.text);
      assert.equal(ask.body.error, "wellness_not_available");
    } finally {
      // The Tests module freezes an archived version; the disposable database
      // gets WELLNESS back with that one trigger off for the restore.
      await q(`alter table tests.test_versions disable trigger freeze_test_versions`);
      await q(`update tests.test_versions set status = $2, archived_at = null, archived_by = null where id = $1`, [WELLNESS, status]);
      await q(`alter table tests.test_versions enable trigger freeze_test_versions`);
    }
  }
  // A Day off for a past day: a window already closed stays missed; today's open one is cancelled.
  const p = await freshTeam("past", 1);
  const daily = await teamDaily(p, { skipDaysOff: true, startDate: addDays(TODAY, -1) });
  const yesterday = addDays(TODAY, -1);
  const occY = (await q(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [daily, yesterday]))[0].id;
  await q(`insert into tests.test_occurrence_target_snapshot (occurrence_id, athlete_id) values ($1, $2)`, [occY, p.athletes[0].athleteId]);
  await q(`insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5)`,
    [occY, p.athletes[0].athleteId, yesterday, `${yesterday}T00:00:00Z`, `${yesterday}T23:59:00Z`]);
  await materialize(daily);
  const off = await teamEvent(p, { kind: "day_off", title: "Rest past", day: yesterday, endDay: TODAY, questions: [] });
  void off;
  const rows = await q(`select a.local_scheduled_date::text as d, a.status from tests.test_assignments a join tests.test_schedule_occurrences o on o.id = a.occurrence_id where o.schedule_id = $1 order by 1`, [daily]);
  assert.deepEqual(rows.map((r) => [r.d, r.status]), [[yesterday, "pending"], [TODAY, "cancelled"]]);
  // skipDaysOff for a test that is not WELLNESS.
  const fms = await api("/api/tests/schedules", {
    method: "POST", cookie: p.coach.cookie,
    body: { testVersionId: "560cf251-50b1-4728-b317-a2c38fe9107a", scheduleKind: "daily", timezone: "UTC", startDate: TODAY, endDate: addDays(TODAY, 2), opensTime: "06:00", closesTime: "09:00", targets: [{ kind: "team", id: p.team }], skipDaysOff: true },
  });
  assert.equal(fms.status, 400, fms.text);
});

test("29. M2: ending a WELLNESS question takes the day key of its window (remove and cancel)", async () => {
  const t = await freshTeam("m2", 1);
  for (const op of ["remove", "cancel"]) {
    const ev = await teamEvent(t, { day: addDays(TODAY, 9), title: `M2 ${op}`, questions: [{ kind: "wellness", window: { kind: "next_morning" } }] });
    const [wq] = await liveQuestions(ev.id);
    const sql = [];
    eventHooks.beforeLocks = async ({ client }) => {
      const original = client.query.bind(client);
      client.query = (...args) => { sql.push(typeof args[0] === "string" ? args[0] : args[0]?.text || ""); return original(...args); };
    };
    try {
      const res = op === "remove"
        ? await api(`/api/calendar/events/${ev.id}/questions/${wq.id}/remove`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } })
        : await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } });
      assert.equal(res.status, 200, res.text);
    } finally {
      delete eventHooks.beforeLocks;
    }
    const key = sql.findIndex((s) => /wellness_day_key/.test(s));
    const firstWrite = sql.findIndex((s) => /^\s*(insert|update|delete)\b/i.test(s));
    assert.ok(key >= 0 && key < firstWrite, `${op}: the day key before the first write (${key}, ${firstWrite})`);
  }
});

test("30. a Day off that is cancelled or moved takes the day keys of its old span before the first write", async () => {
  const t = await freshTeam("oldspan", 1);
  const d1 = addDays(TODAY, 12);
  const d2 = addDays(TODAY, 13);
  const d3 = addDays(TODAY, 15);
  for (const op of ["cancel", "move"]) {
    const ev = await teamEvent(t, { kind: "day_off", title: `Rest ${op}`, day: d1, endDay: d2, questions: [] });
    const calls = [];
    eventHooks.beforeLocks = async ({ client }) => {
      const original = client.query.bind(client);
      client.query = (...args) => {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
        calls.push({ text, params: Array.isArray(args[1]) ? args[1] : args[0]?.values || [] });
        return original(...args);
      };
    };
    try {
      const res = op === "cancel"
        ? await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1 } })
        : await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: t.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, day: d3, endDay: d3 } });
      assert.equal(res.status, 200, res.text);
    } finally {
      delete eventHooks.beforeLocks;
    }
    const firstWrite = calls.findIndex((c) => /^\s*(insert|update|delete)\b/i.test(c.text));
    const keyedDays = calls.slice(0, firstWrite).filter((c) => /wellness_day_key/.test(c.text)).map((c) => String(c.params[1]));
    for (const day of [d1, d2]) assert.ok(keyedDays.includes(day), `${op}: the old day ${day} is keyed before the first write (${keyedDays})`);
    if (op === "move") assert.ok(keyedDays.includes(d3), "move: the new day is keyed too");
  }
});
