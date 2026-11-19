// Central calendar K2b-2a-1 — the core of *Ask athletes* (D40): the body
// rules, the window, the locks, the module schedules a question writes, the
// end of a question, the Day off's effect and the in-app notifications.
// Plan: docs/ai/central-calendar-k2b2-plan.md, sections 2-9 and the technical
// contract 9.1 with the manager's GO (9.1.13). Migration v81.
//
// No transaction here: every function runs on the caller's client inside one
// calendar command (calendarEventService.js, the runner's transaction). The
// lock order every command keeps (9.1.4), each lock before the first write:
//   1. lock_event_writer, the event row FOR UPDATE      (the runner's prepare)
//   2. the club's switch row FOR SHARE                    lockSwitch
//   3. the event's live questions FOR UPDATE, by id       lockLiveQuestions
//   4. Training Load: schedule -> occurrences -> assignments FOR UPDATE
//   5. Tests: schedule -> occurrences -> assignments FOR UPDATE -> assessments FOR SHARE
//                                                          lockQuestionSchedules
//   6. the club's day keys, exclusive, ascending           lockWellnessDays
//      then the open WELLNESS assignments a Day off cancels FOR UPDATE
//                                                          lockDayOffCandidates
import { EventError } from "./calendarEventAccess.js";
import { cancelExternalSchedule, insertExternalSchedule, insertExternalTargets, insertNotificationRules } from "./externalScheduleWriter.js";
import { cancelTestSchedule, insertScheduleRow, insertScheduleTargets, WELLNESS_TEST_VERSION_ID } from "./testsScheduleWriter.js";

export const QUESTION_KINDS = Object.freeze(["rpe", "wellness"]);
export const WINDOW_KINDS = Object.freeze(["after_event", "next_morning", "custom"]);
export const QUESTIONS_OFF = "Questions for athletes are not turned on for this club.";
export const ONE_DAY = "Answers can be collected within one day for now.";
export const MANAGED_BY_CALENDAR = "This question belongs to a calendar event. Change it on the event.";

const bad = (code, message) => new EventError(400, code, message);
const conflict = (code, message, details) => new EventError(409, code, message, details);
export const questionsOff = () => conflict("questions_off", QUESTIONS_OFF);

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AFTER_EVENT_DEFAULT_OPEN = "18:00";
const DAY_END = "23:59";
const NEXT_MORNING = { opens: "07:00", closes: "12:00" };

// The calendar's own notifications are the in-app ones (9.1.6); the
// external schedule's worker rules are written explicitly OFF, so an
// unconfigured schedule never falls back to the module's defaults.
export const CALENDAR_EXTERNAL_RULES = Object.freeze([
  { kind: "athlete_invitation", enabled: false, reminderOffsetMinutes: null },
  { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 },
  { kind: "final_digest", enabled: false, reminderOffsetMinutes: null },
]);

// ---------------------------------------------------------------------------
// Body rules (400s, before any database work)
// ---------------------------------------------------------------------------
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateWindow(raw) {
  if (!plainObject(raw)) throw bad("invalid_window", "window must be an object.");
  const kind = raw.kind;
  if (!WINDOW_KINDS.includes(kind)) throw bad("invalid_window", "window.kind must be after_event, next_morning or custom.");
  const extra = Object.keys(raw).filter((k) => !["kind", "date", "from", "to"].includes(k));
  if (extra.length) throw bad("invalid_window", "window takes kind, date, from and to only.");
  if (kind !== "custom") {
    if ("date" in raw || "from" in raw || "to" in raw) throw bad("invalid_window", "Only a custom window takes a date and times.");
    return { kind };
  }
  if (typeof raw.date !== "string" || !DATE_PATTERN.test(raw.date) || Number.isNaN(Date.parse(`${raw.date}T00:00:00Z`))
      || new Date(`${raw.date}T00:00:00Z`).toISOString().slice(0, 10) !== raw.date) {
    throw bad("invalid_window", "window.date must be a date (YYYY-MM-DD).");
  }
  if (typeof raw.from !== "string" || !TIME_PATTERN.test(raw.from) || typeof raw.to !== "string" || !TIME_PATTERN.test(raw.to)) {
    throw bad("invalid_window", "window.from and window.to must be times (HH:MM).");
  }
  if (raw.from >= raw.to) throw bad("window_one_day", ONE_DAY);
  return { kind, date: raw.date, from: raw.from, to: raw.to };
}

export function validateQuestion(raw) {
  if (!plainObject(raw)) throw bad("invalid_question", "A question must be an object.");
  const extra = Object.keys(raw).filter((k) => !["kind", "window"].includes(k));
  if (extra.length) throw bad("invalid_question", "A question takes kind and window only.");
  if (!QUESTION_KINDS.includes(raw.kind)) throw bad("invalid_question", "kind must be rpe or wellness.");
  return { kind: raw.kind, window: validateWindow(raw.window) };
}

// `questions` on an event's create / update: absent, or the list (at most
// one per kind).
export function validateQuestionsField(body) {
  if (!body || !("questions" in body)) return undefined;
  if (!Array.isArray(body.questions)) throw bad("invalid_question", "questions must be a list.");
  const list = body.questions.map(validateQuestion);
  if (new Set(list.map((q) => q.kind)).size !== list.length) throw bad("invalid_question", "Each kind of question is asked at most once.");
  return list.sort((a, b) => a.kind.localeCompare(b.kind));
}

export function validateDefaultQuestions(value) {
  if (!Array.isArray(value) || value.some((v) => !QUESTION_KINDS.includes(v)) || new Set(value).size !== value.length) {
    throw bad("invalid_questions", "defaultQuestions must be a list of rpe and wellness, each at most once.");
  }
  return QUESTION_KINDS.filter((k) => value.includes(k));
}

// A type's questions: its own list, or (null) derived from default_expects
// (⚑2: 'rpe' in it -> RPE).
export function typeQuestions(type) {
  if (Array.isArray(type.default_questions)) return QUESTION_KINDS.filter((k) => type.default_questions.includes(k));
  return (type.default_expects || []).includes("rpe") ? ["rpe"] : [];
}

// ---------------------------------------------------------------------------
// The window (plan 3.3, 9.1.3, the manager's O2)
// ---------------------------------------------------------------------------
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

// ev: { day, endDay, startTime, endTime } (dates YYYY-MM-DD, times HH:MM).
export function computeWindow(ev, window) {
  const last = ev.endDay || ev.day;
  if (window.kind === "after_event") {
    const start = hhmm(ev.startTime);
    const opens = hhmm(ev.endTime) || (start && start > AFTER_EVENT_DEFAULT_OPEN ? start : AFTER_EVENT_DEFAULT_OPEN);
    if (opens >= DAY_END) throw bad("invalid_window", "The event ends too late to ask after it on the same day.");
    return { windowKind: "after_event", date: last, opens, closes: DAY_END };
  }
  if (window.kind === "next_morning") return { windowKind: "next_morning", date: addDays(last, 1), ...NEXT_MORNING };
  if (window.date < ev.day || window.date > addDays(last, 1)) {
    throw bad("invalid_window", "A custom window is on one of the event's days or the day after.");
  }
  return { windowKind: "custom", date: window.date, opens: window.from, closes: window.to };
}

// The window a live question keeps when its event moves: the same kind, or
// the same custom date and times (refused when it falls outside).
export function windowOfRow(q) {
  if (q.window_kind === "custom") return { kind: "custom", date: dateOnly(q.window_date), from: hhmm(q.opens_time), to: hhmm(q.closes_time) };
  return { kind: q.window_kind };
}
export function dateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
export function sameWindow(q, win) {
  return q.window_kind === win.windowKind && dateOnly(q.window_date) === win.date
    && hhmm(q.opens_time) === win.opens && hhmm(q.closes_time) === win.closes;
}

// ---------------------------------------------------------------------------
// The locks (9.1.4)
// ---------------------------------------------------------------------------
// Step 2: the club's switch, held FOR SHARE (no row = off).
export async function lockSwitch(client, clubId) {
  if (!clubId) return false;
  const row = (await client.query(`select enabled from calendar.club_question_settings where club_id = $1 for share`, [clubId])).rows[0];
  return Boolean(row?.enabled);
}

// Step 3.
export async function lockLiveQuestions(client, eventId) {
  if (!eventId) return [];
  return (await client.query(
    // FOR NO KEY UPDATE (review round 1, H1): a skip row's foreign key check
    // (FOR KEY SHARE, from a materialization holding the day key) is not
    // blocked; a question's id never changes and a question is never deleted.
    `select * from calendar.event_questions where event_id = $1 and ended_at is null order by id for no key update`, [eventId],
  )).rows;
}

// Steps 4 and 5: Training Load first, then Tests, each parent before child.
export async function lockQuestionSchedules(client, questions) {
  const rpe = questions.filter((q) => q.kind === "rpe").map((q) => q.external_schedule_id).sort();
  const wellness = questions.filter((q) => q.kind === "wellness").map((q) => q.test_schedule_id).sort();
  if (rpe.length) {
    await client.query(`select id from training_load.external_schedules where id = any($1::uuid[]) order by id for update`, [rpe]);
    await client.query(`select id from training_load.external_schedule_occurrences where schedule_id = any($1::uuid[]) order by id for update`, [rpe]);
    await client.query(
      `select a.id from training_load.external_assignments a
         join training_load.external_schedule_occurrences o on o.id = a.occurrence_id
        where o.schedule_id = any($1::uuid[]) order by a.id for update of a`,
      [rpe],
    );
  }
  if (wellness.length) {
    await client.query(`select id from tests.test_schedules where id = any($1::uuid[]) order by id for update`, [wellness]);
    await client.query(`select id from tests.test_schedule_occurrences where schedule_id = any($1::uuid[]) order by id for update`, [wellness]);
    await client.query(
      `select a.id from tests.test_assignments a
         join tests.test_schedule_occurrences o on o.id = a.occurrence_id
        where o.schedule_id = any($1::uuid[]) order by a.id for update of a`,
      [wellness],
    );
    await client.query(
      `select x.id from tests.test_assessments x
         join tests.test_assignments a on a.id = x.assignment_id
         join tests.test_schedule_occurrences o on o.id = a.occurrence_id
        where o.schedule_id = any($1::uuid[]) order by x.id for share of x`,
      [wellness],
    );
  }
}

// Step 6: the club's day keys, exclusive, in ascending day order (the Day
// off's span and an event WELLNESS question's day).
export async function lockWellnessDays(client, clubId, days) {
  if (!clubId) return;
  for (const day of [...new Set(days)].sort()) {
    await client.query(`select pg_advisory_xact_lock(calendar.wellness_day_key($1, $2::date))`, [clubId, day]);
  }
}

export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Step 6, after the keys: the open, unanswered WELLNESS assignments of the
// club's skip-days-off schedules on the span — a superset of what the Day off
// reaches (its targets are written later), so every row it may cancel is
// locked before the first write.
export async function lockDayOffCandidates(client, clubId, from, to) {
  return (await client.query(
    `select a.id from tests.test_assignments a
       join tests.test_schedule_occurrences o on o.id = a.occurrence_id
       join tests.test_schedules s on s.id = o.schedule_id
      where s.skip_days_off
        and calendar.owner_club_id(s.owner_scope, s.owner_club_id, s.owner_team_id) = $1
        and a.local_scheduled_date between $2::date and $3::date
        and a.status in ('pending', 'open') and a.closes_at > now()
        and not exists (select 1 from tests.test_assessments x where x.assignment_id = a.id)
      order by a.id for update of a`,
    [clubId, from, to],
  )).rows.map((r) => r.id);
}

// After the event and its targets are written: the candidates the Day off
// reaches on their own day become 'cancelled', each with its skip row.
export async function cancelReachedByDayOff(client, eventId, candidateIds) {
  if (!candidateIds.length) return 0;
  const rows = (await client.query(
    `update tests.test_assignments a set status = 'cancelled', updated_at = now()
      where a.id = any($2::uuid[]) and a.status in ('pending', 'open') and a.closes_at > now()
        and not exists (select 1 from tests.test_assessments x where x.assignment_id = a.id)
        and calendar.athlete_reached_on_day($1, a.athlete_id, a.local_scheduled_date)
      returning a.id, a.athlete_id`,
    [eventId, candidateIds],
  )).rows;
  if (rows.length) {
    await client.query(
      `insert into calendar.question_assignment_skips (assignment_id, athlete_id, event_id, reason)
       select r.id, r.athlete_id, $1, 'day_off_cancelled' from unnest($2::uuid[], $3::uuid[]) as r(id, athlete_id)`,
      [eventId, rows.map((r) => r.id), rows.map((r) => r.athlete_id)],
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Answered (plan 3.5): a session_feedback row of the schedule's assignment
// (RPE, ADR-004), or a WELLNESS assignment started / completed or with an
// assessment.
// ---------------------------------------------------------------------------
export async function answeredCount(client, q) {
  if (q.kind === "rpe") {
    return (await client.query(
      `select count(*)::int as n from training_load.external_assignments a
         join training_load.external_schedule_occurrences o on o.id = a.occurrence_id
         join training_load.session_feedback f on f.external_assignment_id = a.id
        where o.schedule_id = $1`,
      [q.external_schedule_id],
    )).rows[0].n;
  }
  return (await client.query(
    `select count(*)::int as n from tests.test_assignments a
       join tests.test_schedule_occurrences o on o.id = a.occurrence_id
      where o.schedule_id = $1
        and (a.status in ('in_progress', 'completed') or exists (select 1 from tests.test_assessments x where x.assignment_id = a.id))`,
    [q.test_schedule_id],
  )).rows[0].n;
}

// ---------------------------------------------------------------------------
// RPE's one channel (plan 2.1) and WELLNESS never twice (plan 8, 9.1.13 O3)
// ---------------------------------------------------------------------------
export async function hasLiveSessionLinks(client, eventId) {
  if (!eventId) return false;
  return (await client.query(
    `select exists (select 1 from calendar.event_session_links where event_id = $1 and ended_at is null) as linked`, [eventId],
  )).rows[0].linked;
}

// Another WELLNESS already covers the day for an athlete the event reaches:
// her non-cancelled WELLNESS assignment of a schedule of the club, or another
// live event WELLNESS question of the club on that day. A daily schedule not
// yet materialized for the day is not a conflict: its materialization skips
// her (covered_by_event).
export async function wellnessAlreadyScheduled(client, { eventId, clubId, day }) {
  return (await client.query(
    `select exists (
       select 1 from calendar.event_audience_on_day($1, $3::date) aud
         join tests.test_assignments a on a.athlete_id = aud.athlete_id and a.local_scheduled_date = $3::date and a.status <> 'cancelled'
         join tests.test_schedule_occurrences o on o.id = a.occurrence_id
         join tests.test_schedules s on s.id = o.schedule_id
        where calendar.is_wellness_version(s.test_version_id) and s.status <> 'cancelled' and o.status <> 'cancelled'
          and calendar.owner_club_id(s.owner_scope, s.owner_club_id, s.owner_team_id) = $2
          and not exists (select 1 from calendar.event_questions q where q.test_schedule_id = s.id and q.event_id = $1)
     ) or exists (
       select 1 from calendar.event_questions q
         join calendar.events e on e.id = q.event_id and e.status = 'planned'
        where q.kind = 'wellness' and q.ended_at is null and q.window_date = $3::date and q.event_id <> $1
          and calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id) = $2
          and exists (select 1 from calendar.event_audience_on_day(e.id, $3::date) x
                       join calendar.event_audience_on_day($1, $3::date) y on y.athlete_id = x.athlete_id)
     ) as taken`,
    [eventId, clubId, day],
  )).rows[0].taken;
}

// ---------------------------------------------------------------------------
// Writing and ending a question
// ---------------------------------------------------------------------------
// ev: { title, timezone, ownerScope, ownerUserId, ownerClubId, ownerTeamId,
//       targets: [{ kind, id }] }; win: computeWindow's answer.
// Review round 1 (security M1): an athlete target is written only while she is
// a member of the event's owner on the window's day; team and club targets as
// they are. Nobody left: 409 no_athletes.
async function askableTargets(client, ev, day) {
  const athletes = ev.targets.filter((t) => t.kind === "athlete").map((t) => String(t.id));
  let kept = new Set();
  if (athletes.length) {
    kept = new Set((await client.query(
      `select a::text as id from unnest($1::uuid[]) as a
        where calendar.athlete_member_of_owner_on_day($2, $3, $4, a, $5::date)`,
      [athletes, ev.ownerScope, ev.ownerClubId, ev.ownerTeamId, day],
    )).rows.map((r) => r.id));
  }
  const out = ev.targets.filter((t) => t.kind !== "athlete" || kept.has(String(t.id)));
  if (!out.length) throw conflict("no_athletes", "Nobody on this event can be asked on that day.");
  return out;
}

export async function writeQuestionSchedule(client, ev, kind, win, userId) {
  const targets = await askableTargets(client, ev, win.date);
  const owner = { ownerScope: ev.ownerScope, ownerUserId: ev.ownerUserId ?? null, ownerClubId: ev.ownerClubId ?? null, ownerTeamId: ev.ownerTeamId ?? null };
  if (kind === "rpe") {
    const schedule = await insertExternalSchedule(client, {
      // The module's own one-time shape (POST /external-schedules): no end date.
      scheduleKind: "one_time", timezone: ev.timezone, startDate: win.date, endDate: null, recurrenceRule: null,
      opensTime: win.opens, dueTime: null, closesTime: win.closes, eventName: ev.title, eventType: null, eventNote: null, userId, owner,
    });
    await insertExternalTargets(client, schedule.id, targets);
    await insertNotificationRules(client, schedule.id, CALENDAR_EXTERNAL_RULES);
    return { externalScheduleId: schedule.id, testScheduleId: null };
  }
  const schedule = await insertScheduleRow(client, {
    scheduleKind: "one_time", timezone: ev.timezone, startDate: win.date, endDate: win.date,
    opensTime: win.opens, dueTime: null, closesTime: win.closes, userId, owner,
  });
  await insertScheduleTargets(client, schedule.id, targets);
  return { externalScheduleId: null, testScheduleId: schedule.id };
}

export async function insertQuestionRow(client, { eventId, kind, schedule, win, userId, replacesQuestionId = null }) {
  return (await client.query(
    `insert into calendar.event_questions (event_id, kind, external_schedule_id, test_schedule_id, window_kind, window_date, opens_time, closes_time,
                                           replaces_question_id, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [eventId, kind, schedule.externalScheduleId, schedule.testScheduleId, win.windowKind, win.date, win.opens, win.closes, replacesQuestionId, userId],
  )).rows[0];
}

// The question ends and its schedule is cancelled (the module's own cancel);
// the answers stay.
export async function endQuestion(client, q, userId, reason) {
  await client.query(
    `update calendar.event_questions set ended_at = now(), ended_by_user_id = $2, end_reason = $3 where id = $1 and ended_at is null`,
    [q.id, userId, reason],
  );
  if (q.kind === "rpe") await cancelExternalSchedule(client, q.external_schedule_id);
  else await cancelTestSchedule(client, q.test_schedule_id, userId);
}

// ---------------------------------------------------------------------------
// The in-app notifications (9.1.6): written in the command's transaction, one
// per athlete of the event's audience on the window's day who has a user; the
// realtime event is the runner's afterCommit.
// ---------------------------------------------------------------------------
function dmy(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}
export function notificationText(kind, title, win) {
  const what = kind === "rpe" ? `How did ${title} go?` : `How are you feeling around ${title}?`;
  return { title: "Your coach has a question", body: `${what} Answer from ${win.opens} on ${dmy(win.date)}.` };
}

export async function notifyQuestion(client, { eventId, question, title, win, actorUserId, type }) {
  const recipients = (await client.query(
    `select a.id as athlete_id, a.user_id from calendar.event_audience_on_day($1, $2::date) x
       join public.athletes a on a.id = x.athlete_id
      where a.user_id is not null
      order by a.id`,
    [eventId, win.date],
  )).rows;
  if (!recipients.length) return [];
  const text = notificationText(question.kind, title, win);
  const tag = type === "calendar_question_moved" ? "question_moved" : "question_asked";
  const inserted = (await client.query(
    `insert into public.app_notifications (recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key)
     select r.user_id, $1, $2, $3, $4, 'calendar_event', $5::uuid,
            jsonb_build_object('eventId', $5::uuid::text, 'questionId', $6::uuid::text, 'kind', $7::text),
            'calendar:v1:' || $8::text || ':' || $6::uuid::text || ':' || r.athlete_id::text
       from unnest($9::uuid[], $10::uuid[]) as r(athlete_id, user_id)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning recipient_user_id`,
    [actorUserId, type, text.title, text.body, eventId, question.id, question.kind, tag,
      recipients.map((r) => r.athlete_id), recipients.map((r) => r.user_id)],
  )).rows;
  return [...new Set(inserted.map((r) => String(r.recipient_user_id)))];
}

export { WELLNESS_TEST_VERSION_ID };

// Is the module schedule named by a live calendar question (9.1.13 ⚑6)? Its
// Tests / Training Load edit, pause, resume, cancel, delete and schedule-
// again routes then answer 409 schedule_managed_by_calendar; *Remind* stays
// allowed. A database without v81 has no such schedule.
export async function scheduleManagedByCalendar(queryable, kind, scheduleId) {
  const installed = (await queryable.query(`select to_regclass('calendar.event_questions') is not null as ok`)).rows[0].ok;
  if (!installed) return false;
  const column = kind === "external" ? "external_schedule_id" : "test_schedule_id";
  return (await queryable.query(
    `select exists (select 1 from calendar.event_questions where ${column} = $1 and ended_at is null) as managed`, [scheduleId],
  )).rows[0].managed;
}
