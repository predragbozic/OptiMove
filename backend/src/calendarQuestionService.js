// Central calendar K2b-2a-1 — the reads of *Ask athletes* and the athlete's
// *Later* (plan docs/ai/central-calendar-k2b2-plan.md, 3.4 and 9.1.3, the
// manager's A1):
//   GET  /api/calendar/events/:eventId/questions   the event's managers: the
//        counts and the three name lists; the identical 404 for anyone else
//        and while the club's switch is off
//   GET  /api/calendar/questions/mine              an athlete: her own open
//        questions, after the day's occurrence and her assignment are made
//   POST /api/calendar/questions/:questionId/later  her *Later* (requestKey)
import { pool } from "./db.js";
import { EventError, eventOwnerOfRow, eventWriteBasis, notFound } from "./calendarEventAccess.js";
import { requestKeyOf, isUuid } from "./calendarEventService.js";
import { withinBound } from "./calendarCommandRunner.js";
import { COMMIT_ANSWER_TIMEOUT_MS, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS, OUTCOME_UNKNOWN, NOTHING_SAVED, commitCertainlyRefused } from "./activityRosterCommands.js";
import { ensureCurrentOccurrence } from "./testsOccurrenceService.js";
import { ensureCurrentExternalOccurrence } from "./trainingLoadOccurrenceService.js";
import { dateOnly } from "./calendarQuestions.js";

export const testHooks = {};

const athleteName = (a) => `coalesce(${a}.display_name, ${a}.full_name, nullif(concat_ws(' ', ${a}.first_name, ${a}.last_name), ''), ${a}.athlete_id)`;
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

async function questionsInstalled(queryable) {
  return (await queryable.query(`select to_regclass('calendar.event_questions') is not null as ok`)).rows[0].ok;
}

// Who is asked: the schedule's frozen snapshot once an occurrence exists,
// else its targets resolved now (the module's own rule, so the panel never
// counts someone the module will not ask), kept only while the event reaches
// her on the question's day (round 1b: the module resolvers' athlete branch
// has no membership check).
const ASKED_SQL = `
  select x.athlete_id from (
    select s.athlete_id from training_load.external_occurrence_target_snapshot s
      join training_load.external_schedule_occurrences o on o.id = s.occurrence_id
     where q.kind = 'rpe' and o.schedule_id = q.external_schedule_id
    union
    select r.athlete_id from training_load.resolve_external_schedule_target_athletes(q.external_schedule_id) r
     where q.kind = 'rpe' and not exists (select 1 from training_load.external_schedule_occurrences o where o.schedule_id = q.external_schedule_id)
    union
    select s.athlete_id from tests.test_occurrence_target_snapshot s
      join tests.test_schedule_occurrences o on o.id = s.occurrence_id
     where q.kind = 'wellness' and o.schedule_id = q.test_schedule_id
    union
    select r.athlete_id from tests.resolve_schedule_target_athletes(q.test_schedule_id) r
     where q.kind = 'wellness' and not exists (select 1 from tests.test_schedule_occurrences o where o.schedule_id = q.test_schedule_id)
  ) x
  where calendar.athlete_reached_on_day(q.event_id, x.athlete_id, q.window_date)`;

const ANSWERED_SQL = (athleteExpr) => `(
  (q.kind = 'rpe' and exists (
     select 1 from training_load.external_assignments ea
       join training_load.external_schedule_occurrences eo on eo.id = ea.occurrence_id
       join training_load.session_feedback f on f.external_assignment_id = ea.id
      where eo.schedule_id = q.external_schedule_id and ea.athlete_id = ${athleteExpr}))
  or (q.kind = 'wellness' and exists (
     select 1 from tests.test_assignments ta
       join tests.test_schedule_occurrences tox on tox.id = ta.occurrence_id
      where tox.schedule_id = q.test_schedule_id and ta.athlete_id = ${athleteExpr}
        and (ta.status in ('in_progress', 'completed') or exists (select 1 from tests.test_assessments x where x.assignment_id = ta.id)))))`;

// ---------------------------------------------------------------------------
// The coach's panel
// ---------------------------------------------------------------------------
export async function getEventQuestions(ctx, eventId) {
  if (ctx.type !== "coach" || !isUuid(eventId)) throw notFound();
  if (!(await questionsInstalled(pool))) throw notFound();
  const row = (await pool.query(
    `select e.*, t.club_id as owner_team_club_id, coalesce(t.is_active, true) as owner_team_active,
            coalesce(c.is_active, true) as owner_club_active, coalesce(tc.is_active, true) as owner_team_club_active,
            calendar.questions_enabled(calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id)) as questions_on
       from calendar.events e
       left join public.teams t on t.id = e.owner_team_id
       left join public.clubs c on c.id = e.owner_club_id
       left join public.clubs tc on tc.id = t.club_id
      where e.id = $1`,
    [eventId],
  )).rows[0];
  if (!row || !row.questions_on || !eventWriteBasis(ctx, eventOwnerOfRow(row))) throw notFound();
  // K4b (v83): an RPE answer the athlete changed carries the time of its last change.
  const changesInstalled = (await pool.query(`select to_regclass('training_load.session_feedback_changes') is not null as ok`)).rows[0].ok;
  const lastChangedSql = changesInstalled
    ? `(case when q.kind = 'rpe' then (select max(h.changed_at) from training_load.session_feedback_changes h
          join training_load.external_assignments ea on ea.id = h.external_assignment_id
          join training_load.external_schedule_occurrences eo on eo.id = ea.occurrence_id
         where eo.schedule_id = q.external_schedule_id and ea.athlete_id = a.id) end)`
    : "null::timestamptz";
  const questions = (await pool.query(
    `select q.id, q.kind, q.window_kind, q.window_date, q.opens_time, q.closes_time, q.ended_at, q.end_reason,
            (select coalesce(jsonb_agg(jsonb_build_object('athleteId', a.id, 'name', ${athleteName("a")},
                     'answered', ${ANSWERED_SQL("a.id")}, 'lastChangedAt', ${lastChangedSql},
                     'later', exists (select 1 from calendar.question_postponements p where p.question_id = q.id and p.athlete_id = a.id))
                   order by ${athleteName("a")}, a.id), '[]'::jsonb)
               from (${ASKED_SQL}) asked join public.athletes a on a.id = asked.athlete_id) as athletes
       from calendar.event_questions q
      where q.event_id = $1 and (q.ended_at is null or q.end_reason in ('closed_early', 'event_cancelled'))
      order by q.kind, q.created_at`,
    [eventId],
  )).rows;
  return {
    questions: questions.map((q) => {
      const answered = q.athletes.filter((a) => a.answered);
      const later = q.athletes.filter((a) => !a.answered && a.later);
      const notAnswered = q.athletes.filter((a) => !a.answered && !a.later);
      const strip = (list) => list.map((a) => ({ athleteId: a.athleteId, name: a.name }));
      return {
        id: q.id, kind: q.kind,
        window: { kind: q.window_kind, date: dateOnly(q.window_date), from: hhmm(q.opens_time), to: hhmm(q.closes_time) },
        status: q.ended_at ? q.end_reason : "live",
        counts: { asked: q.athletes.length, answered: answered.length, later: later.length, notAnswered: notAnswered.length },
        answered: q.kind === "rpe"
          ? answered.map((a) => ({ athleteId: a.athleteId, name: a.name, changed: a.lastChangedAt != null, lastChangedAt: a.lastChangedAt ?? null }))
          : strip(answered),
        later: strip(later), notAnswered: strip(notAnswered),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The athlete's open questions (A1: the day's occurrence and her assignment
// are made first, as athlete Today does)
// ---------------------------------------------------------------------------
const HER_QUESTIONS_SQL = `
  select q.id, q.kind, q.external_schedule_id, q.test_schedule_id, e.id as event_id, e.title, e.day, e.start_time
    from calendar.event_questions q
    join calendar.events e on e.id = q.event_id and e.status = 'planned'
   where q.ended_at is null
     and q.window_date between current_date - 1 and current_date + 1
     and calendar.questions_enabled(calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id))
     and $1 in (${ASKED_SQL})
   order by q.window_date, q.opens_time, q.id`;

export async function myOpenQuestions(ctx) {
  if (ctx.type !== "athlete") return { questions: [] };
  if (!(await questionsInstalled(pool))) return { questions: [] };
  const candidates = (await pool.query(HER_QUESTIONS_SQL, [ctx.athleteId])).rows;
  for (const q of candidates) {
    if (q.kind === "rpe") await ensureCurrentExternalOccurrence({ id: q.external_schedule_id }, pool);
    else await ensureCurrentOccurrence(pool, { id: q.test_schedule_id });
  }
  if (!candidates.length) return { questions: [] };
  const rows = (await pool.query(
    `select q.id, q.kind, e.id as event_id, e.title, e.day, e.start_time,
            coalesce(ea.id, ta.id) as assignment_id, coalesce(ea.opens_at, ta.opens_at) as opens_at, coalesce(ea.closes_at, ta.closes_at) as closes_at,
            exists (select 1 from calendar.question_postponements p where p.question_id = q.id and p.athlete_id = $1) as later
       from calendar.event_questions q
       join calendar.events e on e.id = q.event_id
       left join training_load.external_schedule_occurrences eo on q.kind = 'rpe' and eo.schedule_id = q.external_schedule_id
       left join training_load.external_assignments ea on ea.occurrence_id = eo.id and ea.athlete_id = $1
       left join tests.test_schedule_occurrences tox on q.kind = 'wellness' and tox.schedule_id = q.test_schedule_id
       left join tests.test_assignments ta on ta.occurrence_id = tox.id and ta.athlete_id = $1
      where q.id = any($2::uuid[]) and calendar.question_open_for(q.id, $1)
        and coalesce(ea.id, ta.id) is not null
        and now() between coalesce(ea.opens_at, ta.opens_at) and coalesce(ea.closes_at, ta.closes_at)
        and coalesce(ea.status, ta.status) in ('pending', 'open')
      order by coalesce(ea.opens_at, ta.opens_at), q.id`,
    [ctx.athleteId, candidates.map((c) => c.id)],
  )).rows;
  return {
    questions: rows.map((r) => ({
      questionId: r.id, kind: r.kind, eventId: r.event_id, eventTitle: r.title, eventDay: dateOnly(r.day), eventStart: hhmm(r.start_time),
      window: { opensAt: new Date(r.opens_at).toISOString(), closesAt: new Date(r.closes_at).toISOString() },
      form: r.kind === "rpe" ? { kind: "rpe", externalAssignmentId: r.assignment_id } : { kind: "wellness", assignmentId: r.assignment_id },
      later: r.later,
    })),
  };
}

// ---------------------------------------------------------------------------
// *Later*: one row, its own request record (performed_by_user_id, request_key)
// ---------------------------------------------------------------------------
const requestKeyReused = () => new EventError(409, "request_key_reused", "This requestKey was already used for a different request.");
const questionNotOpen = () => new EventError(409, "question_not_open", "This question is not open now.");

function laterAnswer(row, extra = {}) {
  return { status: 200, body: { postponement: { questionId: row.question_id, at: new Date(row.created_at).toISOString() }, ...extra } };
}

export async function postponeQuestion(ctx, questionId, body) {
  if (ctx.type !== "athlete" || !isUuid(questionId)) throw notFound();
  const requestKey = requestKeyOf(body);
  const qid = questionId.toLowerCase();
  if (!(await questionsInstalled(pool))) throw notFound();
  const client = await pool.connect();
  let commitSent = false;
  let released = false;
  let broken = false;
  const onErr = () => { broken = true; };
  client.on("error", onErr);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '15s'`);
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`calendar.question_postponements:${ctx.userId}:${requestKey}`]);
    const prior = (await client.query(
      `select * from calendar.question_postponements where performed_by_user_id = $1 and request_key = $2`, [ctx.userId, requestKey],
    )).rows[0];
    if (prior) {
      await client.query("rollback").catch(() => { broken = true; });
      if (String(prior.question_id) !== qid || String(prior.athlete_id) !== String(ctx.athleteId)) throw requestKeyReused();
      return { ...laterAnswer(prior, { replayed: true }), replayed: true };
    }
    // Hers: a live question of a planned event of a club whose switch is on,
    // that asks her (the schedule's own rule).
    const hers = (await client.query(
      `select q.id from calendar.event_questions q
         join calendar.events e on e.id = q.event_id and e.status = 'planned'
        where q.id = $1 and q.ended_at is null
          and calendar.questions_enabled(calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id))
          and $2 in (${ASKED_SQL})`,
      [qid, ctx.athleteId],
    )).rows[0];
    if (!hers) throw notFound();
    const open = (await client.query(`select calendar.question_open_for($1, $2) as open`, [qid, ctx.athleteId])).rows[0].open;
    if (!open) throw questionNotOpen();
    const row = (await client.query(
      `insert into calendar.question_postponements (question_id, athlete_id, performed_by_user_id, request_key)
       values ($1, $2, $3, $4) returning *`,
      [qid, ctx.athleteId, ctx.userId, requestKey],
    )).rows[0];
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return laterAnswer(row);
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error instanceof EventError) throw error;
      if (error?.code === "55P03" || error?.code === "40P01") throw new EventError(409, "try_again", "Try again in a moment.");
      if (error?.code === "23514" && error.constraint === "question_postponements_own") throw notFound();
      if (error?.code === "23514" && error.constraint === "question_postponements_open") throw questionNotOpen();
      throw error;
    }
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new EventError(500, "internal_error", NOTHING_SAVED);
    }
    released = true;
    client.removeListener("error", onErr);
    client.on("error", () => {});
    client.release(true);
    const found = await findPostponement(ctx.userId, requestKey).catch(() => null);
    if (found && String(found.question_id) === qid) return { ...laterAnswer(found, { verifiedAfterCommitError: true }), verifiedAfterCommitError: true };
    throw new EventError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onErr);
      client.release(broken ? true : undefined);
    }
  }
}

async function findPostponement(userId, requestKey) {
  const checker = await withinBound(pool.connect(), UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
  try {
    if (testHooks.checkFault) await testHooks.checkFault(checker);
    const answer = checker.query({
      text: `select * from calendar.question_postponements where performed_by_user_id = $1 and request_key = $2`,
      values: [userId, requestKey], query_timeout: UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
    });
    answer.catch(() => {});
    return (await withinBound(answer, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS)).rows[0] ?? null;
  } finally {
    checker.release(true);
  }
}
