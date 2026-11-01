// Central calendar (K1a) — the reads of GET /api/calendar and the item model
// (docs/ai/central-calendar-k1-plan.md, sections 1-2; owner decisions
// D12-D15). Pure read: a bounded number of statements whatever the number
// of items (one per family of rows for the window, one for the roster
// counts), then grouping, folding, `expects` and `status` in memory.
//
// NO WRITE ON READ. The Training Load calendar generates the current
// external occurrences before it reads (routes/trainingLoad.js); this
// module never calls trainingLoadOccurrenceService.js or
// testsOccurrenceService.js. A schedule day without a generated occurrence
// is projected in memory from the schedule's own dates, the way GET
// /api/tests/weekly projects a week (routes/tests.js,
// scheduleOccupiedDatesInRange) — a static test refuses either import here.
//
// One item per thing that happened or is planned (section 2):
//   planned   a planned GROUP (owner decision D16b, 2026-10-31): the
//             sessions of one plan OWNER on one day, slot and session name
//             (plannedGroupKey); a plan without a resolved owner is a group
//             of one. An activity
//             whose canonical participant is linked (confirmed) to one of
//             the group's logical sessions FOLDS into the group's card
//             (links.activityIds) — a training of 20 athletes with 17 RPE
//             results is ONE card, never 20.
//   activity  a canonical activity that folded into no planned or external
//             card: a GPEXE / imported session, a coach-made activity, a
//             self-report activity whose session is outside the window or
//             the caller's scope.
//   external  an external schedule on one day (its generated occurrence,
//             or a projected day).
//   test      a test schedule on one day (the same).
//   event     a calendar event (K2a, calendar.events) on one of its days: the
//             owner's own event (structural), or one reached through a target
//             athlete who was a member ON THAT DAY; a referenced external or
//             test schedule's day card FOLDS under it (plan section 1.4), and so
//             do the planned sessions and the activities linked to it (K2a-1b,
//             calendar.event_session_links / event_activity_links). The
//             athlete workspace gets the reduced card of D21.
import crypto from "node:crypto";
import { query } from "./db.js";
import {
  calendarActivityFilterSql, calendarActivityScopeSql, calendarAthleteFilterSql, calendarAthleteScopeSql,
  calendarScheduleCandidateSql, calendarScheduleStructuralSql, loadWorkspaceTeams, membershipOnDaySql,
} from "./calendarAccess.js";
import { eventOwnerOfRow, eventWriteBasis } from "./calendarEventAccess.js";
// The one published-weekly-plan rule, shared with GET /weekly and GET
// /calendar of routes/trainingLoad.js.
import { WEEKLY_PLAN_SESSION_FILTER_SQL } from "./trainingLoadAccess.js";

export const CALENDAR_MAX_RANGE_DAYS = 62;
export const CALENDAR_KINDS = Object.freeze(["planned", "activity", "external", "test", "event"]);
export const CALENDAR_STATUSES = Object.freeze(["planned", "done", "awaiting_entry", "missed", "not_opened", "cancelled", "none"]);

const athleteNameSql = (alias) => `coalesce(${alias}.display_name, ${alias}.full_name, concat_ws(' ', ${alias}.first_name, ${alias}.last_name), ${alias}.athlete_id)`;
// The athlete's team memberships among the workspace's teams
// ($<teamsParam>::uuid[]) ON THE DAY `dayExpr`, by the calendar's one
// membership rule (calendarAccess.js membershipOnDaySql), as an array; '{}'
// outside a club / team workspace.
const athleteTeamIdsSql = (alias, teamsParam, dayExpr) =>
  `(select coalesce(array_agg(distinct wt.id), '{}') from unnest($${teamsParam}::uuid[]) as wt(id)
     where ${membershipOnDaySql(`${alias}.id`, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = wt.id)`, dayExpr)})`;
// A terminal assignment status: the entry can no longer be made (plan 2.5,
// status `missed`).
const MISSED_ASSIGNMENT_STATUSES = new Set(["missed"]);

// A self-report activity (migration v44's words): one athlete's own report,
// never "awaiting entry" (D15). The verdict is v44's: a team-owned activity
// of a self-report origin with at most one canonical participant and no
// measured value has no roster — `hasRoster` is training.activity_has_roster()
// read for the card, never a copy of that rule; the origin and the count
// only keep a club- or user-owned one-participant report (which never has a
// roster) in the same class.
const SELF_REPORT_ORIGINS = new Set(["planned_session", "external_assignment"]);
export function isSelfReportCard(row, participantCount, hasRoster) {
  return SELF_REPORT_ORIGINS.has(row.origin) && participantCount <= 1 && hasRoster !== true;
}
// An imported activity IS the device data (expects ["device_data"], met).
const IMPORTED_ORIGINS = new Set(["api_import", "source_import"]);
// An assignment that still asks for something.
const CLOSED_ASSIGNMENT_STATUSES = new Set(["cancelled", "excused"]);

// A real Gregorian date (the rule of routes/trainingLoad.js's
// isValidGregorianDateString) with a year in 2000-2100: "2026-02-30" is
// refused, and a day walk towards "9999-12-31" can never leave the
// four-digit form. Shared by the calendar read's validation
// (routes/calendar.js) and the event commands (calendarEventService.js).
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const CALENDAR_MIN_YEAR = 2000;
export const CALENDAR_MAX_YEAR = 2100;
export function isValidCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < CALENDAR_MIN_YEAR || year > CALENDAR_MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// db.js returns DATE columns as "YYYY-MM-DD" strings; a Date is handled too.
// Shared with calendarEventService.js.
export function dateStr(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
// A Postgres `time` comes back as "HH:MM:SS".
export function timeStr(value) {
  if (value == null) return null;
  const s = String(value);
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : null;
}
function uniq(values) {
  return [...new Set(values.filter((v) => v != null).map(String))];
}
function shortHash(text) {
  return crypto.createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 12);
}

// THE grouping rule of a planned session (owner decision D16b, 2026-10-31,
// replacing D16's batch-only grouping): one card per plan OWNER (the plan's
// stored training_load.plan_workspace_ownership — owner_scope and the owner's
// id), DAY, SLOT (AM / PM and Before / Training / After) and SESSION NAME,
// trimmed and compared case-insensitively. Plans made one by one or imported
// group like a Builder batch (a batch shares owner, day, slot and name
// anyway, so the batch id left the key); different slots, names or owners
// (a team's plan and the club's) stay separate cards. A plan without a
// trustworthy owner (`unresolved`, or no ownership row) is a group of one.
// The owner part is hashed: the key reaches every viewer, and a private
// coach's user id must never be read from it. The group is formed over the
// rows the viewer's scope already returned (readPlannedRows, per athlete and
// day), so a card never holds an athlete the viewer may not see, and a wide
// window is the union of its days. This function is the one place the rule
// lives.
export function normalizedSessionName(name) {
  return String(name ?? "").trim().toLowerCase();
}
export function plannedGroupKey(row, day) {
  const resolved = row.plan_owner_scope && row.plan_owner_scope !== "unresolved" && row.plan_owner_id;
  const owner = resolved ? `${row.plan_owner_scope}:${row.plan_owner_id}` : `plan:${row.plan_id}`;
  return `planned:${shortHash(owner)}:${day}:${row.am_pm || ""}:${row.bta || ""}:${shortHash(normalizedSessionName(row.session_name))}`;
}
// A planned card's title: the spelling most of its sessions carry (trimmed);
// on a tie the alphabetically first; nothing named → null (the screen's
// "Training session").
function pickTitle(votes) {
  let best = null;
  let bestCount = 0;
  for (const [name, count] of votes) {
    if (count > bestCount || (count === bestCount && best !== null && name < best)) {
      best = name;
      bestCount = count;
    }
  }
  return best || null;
}
// One athlete's RPE state over several sessions of one card: what is still
// to do wins (missing, then missed), then what was done.
const RPE_STATE_RANK = { missing: 4, missed: 3, submitted: 2, not_asked: 1 };
function mergeRpeState(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return (RPE_STATE_RANK[b] || 0) > (RPE_STATE_RANK[a] || 0) ? b : a;
}
// A linked session's slot (calendar.event_session_links' identity, plan
// section 2.2): the live plan, the day and the slot with its order.
function slotKeyOf(planId, day, amPm, bta, order) {
  return `${planId}|${day}|${amPm || ""}|${bta || ""}|${Number(order) || 0}`;
}

// ---------------------------------------------------------------------------
// Reads — one statement each, for the whole window.
// ---------------------------------------------------------------------------

async function readPlannedRows(ctx, { from, to, filters, teamIds }) {
  const params = [from, to, teamIds];
  const scope = calendarAthleteScopeSql(ctx, "ath", params, "pd.date");
  const extra = calendarAthleteFilterSql("ath", filters, params, "pd.date");
  const result = await query(
    `select ps.id as session_id, ps.logical_session_id, ps.name as session_name, ps.session_time, ps.am_pm, ps.bta, ps.session_order,
            ps.rpe_enabled, ps.training_load_enabled,
            pd.date as day, p.id as plan_id,
            pwo.owner_scope as plan_owner_scope,
            case pwo.owner_scope when 'club' then pwo.owner_club_id::text when 'team' then pwo.owner_team_id::text
                                 when 'user' then pwo.owner_user_id::text when 'system' then 'system' end as plan_owner_id,
            ath.id as athlete_id, ${athleteNameSql("ath")} as athlete_name,
            ${athleteTeamIdsSql("ath", 3, "pd.date")} as team_ids,
            (ps.rpe_enabled = true and training_load.planned_rpe_effective_for_plan(p.id, pd.date)) as rpe_expected,
            exists (select 1 from training_load.session_feedback sf where sf.athlete_id = ath.id and sf.logical_session_id = ps.logical_session_id) as rpe_submitted
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes ath on ath.id = p.athlete_id
       left join training_load.plan_workspace_ownership pwo on pwo.plan_id = p.id
      where ${WEEKLY_PLAN_SESSION_FILTER_SQL}
        and pd.date between $1::date and $2::date
        and (${scope})${extra}
      order by pd.date, ps.am_pm, ps.bta, ps.session_order, athlete_name, ath.id`,
    params,
  );
  return result.rows;
}

// Every canonical activity of the window in the caller's READ scope, with
// its canonical participants, the Training Load calendar's own "RPE
// requested / rated" rule (an external-assignment link is always a request,
// a planned-session link only when that session's rpe_enabled is true) and
// the logical sessions and external assignments its alias set is linked to
// (for the folding). The roster question (training.activity_has_roster, v44)
// is asked only of the activities that stay their own card, in
// readRosterCounts — never of the many that fold into a planned card.
async function readActivityRows(ctx, { from, to, filters }) {
  const params = [from, to];
  const scope = calendarActivityScopeSql(ctx, "a", params);
  const extra = calendarActivityFilterSql("a", filters, params);
  // The athlete workspace reads its OWN participation of an activity only:
  // never a teammate's id, name, RPE or link (the rule of the activity
  // detail, trainingActivityResults.js, which strips every other athlete's
  // facts for an athlete-self caller).
  let selfSql = "";
  if (ctx.type === "athlete") {
    params.push(ctx.athleteId);
    selfSql = ` and ap.athlete_id = $${params.length}`;
  }
  const result = await query(
    `select a.id, a.name, a.activity_type_key, a.occurred_local_date as day, a.started_at, a.timezone_snapshot, a.origin,
            a.owner_scope, a.owner_team_id,
            to_char(a.started_at at time zone a.timezone_snapshot, 'HH24:MI') as start_time,
            coalesce(pc.participants, '[]'::jsonb) as participants,
            coalesce(rc.requested, 0)::int as rpe_requested, coalesce(rc.rated, 0)::int as rpe_rated,
            coalesce(pl.logical_session_ids, '{}') as logical_session_ids,
            coalesce(pl.external_assignment_ids, '{}') as external_assignment_ids
       from training.activities a
       left join lateral (
         select jsonb_agg(jsonb_build_object('athleteId', ap.athlete_id, 'name', ${athleteNameSql("ath")}) order by ${athleteNameSql("ath")}, ap.athlete_id) as participants
           from training.activity_participants ap
           join public.athletes ath on ath.id = ap.athlete_id
          where ap.activity_id = a.id and ap.merge_status = 'canonical'${selfSql}
       ) pc on true
       left join lateral (
         select count(*) filter (where l.external_assignment_id is not null or ps.rpe_enabled = true) as requested,
                count(*) filter (where sf.id is not null and (l.external_assignment_id is not null or ps.rpe_enabled = true)) as rated
           from training.activity_participants ap
           join training.activity_participant_session_links l on l.activity_participant_id = ap.id and l.link_status = 'confirmed'
           left join plans.plan_sessions ps on ps.logical_session_id = l.logical_session_id
           left join training_load.session_feedback sf on sf.athlete_id = ap.athlete_id
             and ((l.logical_session_id is not null and sf.logical_session_id = l.logical_session_id) or (l.external_assignment_id is not null and sf.external_assignment_id = l.external_assignment_id))
          where ap.activity_id = a.id and ap.merge_status = 'canonical'${selfSql}
       ) rc on true
       left join lateral (
         select array_agg(distinct l.logical_session_id) filter (where l.logical_session_id is not null) as logical_session_ids,
                array_agg(distinct l.external_assignment_id) filter (where l.external_assignment_id is not null) as external_assignment_ids
           from training.activity_participants ap
           join training.activity_participant_session_links l on l.activity_participant_id = ap.id and l.link_status = 'confirmed'
          where ap.activity_id in (select x.activity_id from training.activity_alias_ids(a.id) x)${selfSql}
       ) pl on true
      where a.lifecycle_state <> 'superseded'
        and a.occurred_local_date between $1::date and $2::date
        and (${scope})${extra}
      order by a.occurred_local_date, a.started_at nulls last, a.id`,
    params,
  );
  return result.rows;
}

// For the activities that are their own card: whether each has a roster
// (training.activity_has_roster, v44 — the one definition, called, never
// copied) and, only where it has one (section 2.7), the roster
// (training.activity_roster), who still needs a state
// (training.activity_roster_needs_state, v26), who did not participate (a
// current decision, counted outside the needs-state group so the two never
// overlap on a two-states conflict), and whether a measured source exists
// (an effective api_import / csv_import value, the roster's own definition
// of "measured"). One statement for the whole window.
async function readRosterCounts(activityIds) {
  if (!activityIds.length) return new Map();
  const result = await query(
    `with t as (
       select a.id, coalesce(training.activity_has_roster(a.id), false) as has_roster
         from training.activities a
        where a.id = any($1::uuid[])
     )
     select t.id, t.has_roster,
            case when t.has_roster then (select count(*)::int from training.activity_roster(t.id)) else 0 end as roster,
            case when t.has_roster then (select count(*)::int from training.activity_roster_needs_state(t.id)) else 0 end as needs_state,
            case when t.has_roster then (
              select count(*)::int from training.activity_roster(t.id) r
               where exists (select 1 from training.activity_athlete_decisions d
                              where d.athlete_id = r.athlete_id and d.superseded_by_decision_id is null and d.decision_kind = 'did_not_participate'
                                and d.activity_id in (select x.activity_id from training.activity_alias_ids(t.id) x))
                 and not exists (select 1 from training.activity_roster_needs_state(t.id) ns where ns.athlete_id = r.athlete_id)
            ) else 0 end as did_not_participate,
            case when t.has_roster then exists (
              select 1 from training.canonical_activity_results(t.id) x
               where x.fact_kind = 'metric_value' and x.detail ->> 'entryMethod' in ('api_import', 'csv_import')
            ) else false end as measured
       from t`,
    [activityIds],
  );
  return new Map(result.rows.map((row) => [String(row.id), {
    hasRoster: row.has_roster === true,
    roster: Number(row.roster), needsState: Number(row.needs_state), didNotParticipate: Number(row.did_not_participate), measured: row.measured === true,
  }]));
}

async function readExternalAssignmentRows(ctx, { from, to, filters, teamIds }) {
  const params = [from, to, teamIds];
  const scope = calendarAthleteScopeSql(ctx, "ath", params, "asg.local_scheduled_date");
  const extra = calendarAthleteFilterSql("ath", filters, params, "asg.local_scheduled_date");
  const result = await query(
    `select asg.id as assignment_id, asg.athlete_id, ${athleteNameSql("ath")} as athlete_name, ${athleteTeamIdsSql("ath", 3, "asg.local_scheduled_date")} as team_ids,
            asg.local_scheduled_date as day, asg.status as assignment_status,
            eo.id as occurrence_id, eo.status as occurrence_status,
            s.id as schedule_id, s.event_name, s.event_type, s.status as schedule_status, s.opens_time,
            exists (select 1 from training_load.session_feedback sf where sf.external_assignment_id = asg.id) as rpe_submitted
       from training_load.external_assignments asg
       join training_load.external_schedule_occurrences eo on eo.id = asg.occurrence_id
       join training_load.external_schedules s on s.id = eo.schedule_id
       join public.athletes ath on ath.id = asg.athlete_id
      where asg.local_scheduled_date between $1::date and $2::date
        and (${scope})${extra}
      order by asg.local_scheduled_date, s.id, athlete_name, ath.id`,
    params,
  );
  return result.rows;
}

// Active external schedules that could occupy the window — the CANDIDATES
// of the in-memory projection of the days that have no generated occurrence
// yet, each with its `structural` relation to the workspace (owned, or
// targeting the workspace's club / team itself). A candidate reached only
// through athletes shows a day only when readScheduleTargetAthletes finds a
// member ON THAT DAY (readCalendar). The explicit dates of a 'dates'
// schedule (migration v8) come along as text.
async function readExternalScheduleRows(ctx, { from, to }) {
  const params = [from, to];
  const candidate = calendarScheduleCandidateSql(ctx, "s", "training_load.external_schedule_targets", params, "$1", "$2");
  if (candidate === "false") return [];
  const structural = calendarScheduleStructuralSql(ctx, "s", "training_load.external_schedule_targets", params);
  const result = await query(
    `select s.id, s.event_name, s.event_type, s.status, s.schedule_kind, s.start_date, s.end_date, s.recurrence_rule, s.opens_time,
            (${structural}) as structural,
            (select coalesce(array_agg(d.scheduled_date::text order by d.scheduled_date), '{}') from training_load.external_schedule_dates d
              where d.schedule_id = s.id and d.scheduled_date between $1::date and $2::date) as explicit_dates
       from training_load.external_schedules s
      where s.status = 'active'
        and s.start_date <= $2::date and (s.end_date is null or s.end_date >= $1::date)
        and (${candidate})
      order by s.id`,
    params,
  );
  return result.rows;
}

async function readTestAssignmentRows(ctx, { from, to, filters, teamIds }) {
  const params = [from, to, teamIds];
  const scope = calendarAthleteScopeSql(ctx, "ath", params, "asg.local_scheduled_date");
  const extra = calendarAthleteFilterSql("ath", filters, params, "asg.local_scheduled_date");
  const result = await query(
    `select asg.id as assignment_id, asg.athlete_id, ${athleteNameSql("ath")} as athlete_name, ${athleteTeamIdsSql("ath", 3, "asg.local_scheduled_date")} as team_ids,
            asg.local_scheduled_date as day, asg.status as assignment_status,
            o.id as occurrence_id, o.status as occurrence_status,
            sch.id as schedule_id, sch.status as schedule_status, sch.opens_time,
            coalesce(tv.name, tbv.name) as test_name
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_schedules sch on sch.id = o.schedule_id
       left join tests.test_versions tv on tv.id = sch.test_version_id
       left join tests.test_battery_versions tbv on tbv.id = sch.test_battery_version_id
       join public.athletes ath on ath.id = asg.athlete_id
      where asg.local_scheduled_date between $1::date and $2::date
        and (${scope})${extra}
      order by asg.local_scheduled_date, sch.id, athlete_name, ath.id`,
    params,
  );
  return result.rows;
}

// The same for test schedules (candidates with their structural relation).
async function readTestScheduleRows(ctx, { from, to }) {
  const params = [from, to];
  const candidate = calendarScheduleCandidateSql(ctx, "sch", "tests.test_schedule_targets", params, "$1", "$2");
  if (candidate === "false") return [];
  const structural = calendarScheduleStructuralSql(ctx, "sch", "tests.test_schedule_targets", params);
  const result = await query(
    `select sch.id, sch.status, sch.schedule_kind, sch.start_date, sch.end_date, sch.recurrence_rule, sch.opens_time,
            (${structural}) as structural,
            coalesce(tv.name, tbv.name) as test_name
       from tests.test_schedules sch
       left join tests.test_versions tv on tv.id = sch.test_version_id
       left join tests.test_battery_versions tbv on tbv.id = sch.test_battery_version_id
      where sch.status = 'active'
        and sch.start_date <= $2::date and (sch.end_date is null or sch.end_date >= $1::date)
        and (${candidate})
      order by sch.id`,
    params,
  );
  return result.rows;
}

// The athletes a schedule targets ON A PROJECTED DAY (which has no
// assignment rows), inside the caller's scope on that day: direct athlete
// targets, members of a target team on the day, members of a target club on
// the day (the calendar's one membership rule). One statement for every
// (schedule, day) pair.
// Exported for the event service's reduced view (the targets a non-manager
// reader may see); `queryable` lets a caller run it on its own connection.
export async function readScheduleTargetAthletes(ctx, targetsTable, { pairs, filters, teamIds, idColumn = "schedule_id", queryable = null }) {
  if (!pairs.length) return new Map();
  const params = [pairs.map((p) => p.scheduleId), pairs.map((p) => p.day), teamIds];
  const scope = calendarAthleteScopeSql(ctx, "ath", params, "p.day");
  const extra = calendarAthleteFilterSql("ath", filters, params, "p.day");
  const run = queryable ? (text, values) => queryable.query(text, values) : query;
  const result = await run(
    `select p.schedule_id, p.day, ath.id as athlete_id, ${athleteNameSql("ath")} as athlete_name, ${athleteTeamIdsSql("ath", 3, "p.day")} as team_ids
       from unnest($1::uuid[], $2::date[]) as p(schedule_id, day)
       join ${targetsTable} tg on tg.${idColumn} = p.schedule_id
       join public.athletes ath on (
            (tg.target_kind = 'athlete' and ath.id = tg.target_athlete_id)
         or (tg.target_kind = 'team' and ${membershipOnDaySql("ath.id", (m) => `(${m}.membership_type = 'team' and ${m}.team_id = tg.target_team_id)`, "p.day")})
         or (tg.target_kind = 'club' and ${membershipOnDaySql("ath.id", (m) => `(${m}.membership_type = 'club' and ${m}.club_id = tg.target_club_id)`, "p.day")}))
      where coalesce(ath.is_active, true)
        and (${scope})${extra}
      group by p.schedule_id, p.day, ath.id
      order by p.schedule_id, p.day, athlete_name, ath.id`,
    params,
  );
  const byPair = new Map();
  for (const row of result.rows) {
    const key = `${row.schedule_id}|${dateStr(row.day)}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push({ athleteId: row.athlete_id, name: row.athlete_name, teamIds: uniq(row.team_ids || []) });
  }
  return byPair;
}

// The events of the window (K2a): every event whose days touch the window
// and that the workspace may see at all — the CANDIDATE rule of the
// schedules (calendarScheduleCandidateSql over calendar.event_targets): the
// owner's own event or one targeting the scope's club / team (structural),
// or one reached through an athlete in scope on some day of the window. The
// per-day decision is readCalendar's, through readScheduleTargetAthletes on
// each day. The athlete workspace: its own targets only (D21).
async function readEventRows(ctx, { from, to }) {
  const params = [from, to];
  const candidate = calendarScheduleCandidateSql(ctx, "e", "calendar.event_targets", params, "$1", "$2", "event_id");
  if (candidate === "false") return [];
  const structural = calendarScheduleStructuralSql(ctx, "e", "calendar.event_targets", params, "event_id");
  const result = await query(
    `select e.id, e.owner_scope, e.owner_user_id, e.owner_club_id, e.owner_team_id, e.event_type_id,
            e.title, e.day, e.end_day, e.start_time, e.end_time, e.location, e.status, e.expects, e.notes,
            e.external_schedule_id, e.test_schedule_id, e.revision,
            et.kind as event_kind, et.label as event_type_label,
            t.club_id as owner_team_club_id, coalesce(t.is_active, true) as owner_team_active,
            coalesce(c.is_active, true) as owner_club_active, coalesce(tc.is_active, true) as owner_team_club_active,
            (${structural}) as structural
       from calendar.events e
       join calendar.event_types et on et.id = e.event_type_id
       left join public.teams t on t.id = e.owner_team_id
       left join public.clubs c on c.id = e.owner_club_id
       left join public.clubs tc on tc.id = t.club_id
      where e.day <= $2::date and coalesce(e.end_day, e.day) >= $1::date
        and (${candidate})
      order by e.day, e.start_time nulls first, e.id`,
    params,
  );
  return result.rows;
}

// The team targets of the window's events (a club event addressed to a team
// is that team's card even on a day none of its members is in scope).
async function readEventTeamTargets(eventIds) {
  if (!eventIds.length) return new Map();
  const result = await query(
    `select tg.event_id, tg.target_team_id from calendar.event_targets tg where tg.event_id = any($1::uuid[]) and tg.target_kind = 'team'`,
    [eventIds],
  );
  const byEvent = new Map();
  for (const row of result.rows) {
    if (!byEvent.has(String(row.event_id))) byEvent.set(String(row.event_id), []);
    byEvent.get(String(row.event_id)).push(String(row.target_team_id));
  }
  return byEvent;
}

// The live session links of the window's events (K2a-1b), each resolved to
// the published session now in its slot (plan section 2.2): a link whose plan
// was deleted (plan_id null) or whose slot holds no published session any
// more is ORPHANED (no session_id) — counted on the event's card, never an
// error and never silently gone; a session renamed since the link still
// resolves and is counted as renamed. One statement.
async function readEventSessionLinks(eventIds) {
  const result = await query(
    `select l.id, l.event_id, l.plan_id, l.day, l.am_pm, l.bta, l.session_order, l.session_name_at_link,
            s.session_id, s.session_name
       from calendar.event_session_links l
       left join lateral (
         select ps.id as session_id, ps.name as session_name
           from plans.plans p
           join plans.plan_days pd on pd.plan_id = p.id
           join plans.plan_sessions ps on ps.plan_day_id = pd.id
          where p.id = l.plan_id and ${WEEKLY_PLAN_SESSION_FILTER_SQL}
            and pd.date = l.day and ps.am_pm is not distinct from l.am_pm and ps.bta is not distinct from l.bta
            and ps.session_order = l.session_order
          order by ps.id
          limit 1
       ) s on true
      where l.event_id = any($1::uuid[]) and l.ended_at is null`,
    [eventIds],
  );
  return result.rows;
}

// The live activity links of the window's events, each followed forward to
// its canonical activity (ADR-001: a merged activity's link names the
// survivor), the oldest first. Two live links can name one survivor only
// when the merge came after both were made; the caller folds the survivor
// under the oldest one whose event is shown on the survivor's own day, so
// every window that holds that day gives the same answer (independent review
// of PR #313, MEDIUM-1, and its narrow code re-review). One statement.
async function readEventActivityLinks(eventIds) {
  const result = await query(
    `select l.event_id, training.resolve_canonical_activity_id(l.activity_id) as activity_id
       from calendar.event_activity_links l
      where l.event_id = any($1::uuid[]) and l.ended_at is null
      order by l.linked_at, l.id`,
    [eventIds],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// The in-memory projection of a schedule's days (the rule of routes/tests.js,
// scheduleOccupiedDatesInRange): one_time → its start date; 'dates' → its
// explicit dates (external schedules, v8); recurring daily → every day of
// the range inside [start_date, end_date]; any other recurrence → no date
// (never guessed). Only days inside [from, to].
// ---------------------------------------------------------------------------
export function projectScheduleDates(schedule, from, to) {
  const start = dateStr(schedule.start_date);
  const end = dateStr(schedule.end_date);
  if (schedule.schedule_kind === "one_time") return start >= from && start <= to ? [start] : [];
  if (schedule.schedule_kind === "dates") return (schedule.explicit_dates || []).map(dateStr).filter((d) => d >= from && d <= to);
  if (schedule.schedule_kind !== "recurring" || schedule.recurrence_rule?.freq !== "daily") return [];
  const first = start > from ? start : from;
  const last = end && end < to ? end : to;
  const dates = [];
  for (let cursor = first; cursor <= last; cursor = addDaysIso(cursor, 1)) dates.push(cursor);
  return dates;
}

// ---------------------------------------------------------------------------
// Status (section 2.5; D14, D15). `awaiting_entry` only once the item's day
// has passed, for an unmet expectation and for a roster that still needs a
// state alike; `missed` when, after the day, every unmet entry can no longer
// be made (a terminal assignment status); a self-report activity is never
// awaiting.
// ---------------------------------------------------------------------------
export function deriveStatus(card, today) {
  if (card.cancelled) return "cancelled";
  if (card.projected) return card.date < today ? "not_opened" : "planned";
  const checks = [];
  let unmet = 0;
  let terminal = 0;
  if (card.rpe && card.rpe.asked > 0) {
    checks.push(card.rpe.submitted >= card.rpe.asked);
    unmet += Math.max(0, card.rpe.asked - card.rpe.submitted);
    terminal += card.rpe.missed || 0;
  }
  if (card.results && card.results.expected > 0) {
    checks.push(card.results.completed >= card.results.expected);
    unmet += Math.max(0, card.results.expected - card.results.completed);
    terminal += card.results.missed || 0;
  }
  if (card.expects.includes("device_data")) checks.push(true);
  const rosterWaits = Boolean(card.attendance) && card.measuredSource === true;
  if (rosterWaits) checks.push(card.attendance.needsState === 0);
  if (!checks.length) return "none";
  const met = checks.every(Boolean);
  if (card.selfReport) return met ? "done" : "none";
  if (met) return "done";
  if (!(card.date < today)) return "planned";
  if (unmet > 0 && terminal >= unmet && !(rosterWaits && card.attendance.needsState > 0)) return "missed";
  return "awaiting_entry";
}

// The status of an EVENT card (K2a plan section 3.2; D15, D19). The event
// declares `expects`; the card judges by the channels that exist:
//   rpe          the referenced external schedule's assignments (asked > 0);
//                a declared RPE with no channel is a GAP — nobody can answer,
//                so it is never awaiting (K2a-1b adds the linked sessions);
//   test_result  the referenced test schedule's assignments; the same gap rule;
//   device_data  a linked imported activity (K2a-1b); none yet → unmet, so a
//                past day is awaiting: the import is the coach's own next step.
// `gaps` names the declared expectations that have no channel. A cancelled
// event is cancelled; an event that expects nothing is `none`; one whose
// every expectation is a gap reads `planned` before its day and `none` after.
export function deriveEventStatus(card, today) {
  const gaps = [];
  card.gaps = gaps;
  if (card.cancelled) return "cancelled";
  const expects = card.expects || [];
  if (!expects.length) return "none";
  const checks = [];
  let unmet = 0;
  let terminal = 0;
  // A referenced schedule shown as its own card beside the event (it reaches
  // athletes the event does not list) is the channel: its card carries the
  // counts and the status, so the event shows no gap for it.
  if (expects.includes("rpe")) {
    if (card.rpe && card.rpe.asked > 0) {
      checks.push(card.rpe.submitted >= card.rpe.asked);
      unmet += Math.max(0, card.rpe.asked - card.rpe.submitted);
      terminal += card.rpe.missed || 0;
    } else if (card.scheduleFold?.external !== "separate") gaps.push("rpe");
  }
  if (expects.includes("test_result")) {
    if (card.results && card.results.expected > 0) {
      checks.push(card.results.completed >= card.results.expected);
      unmet += Math.max(0, card.results.expected - card.results.completed);
      terminal += card.results.missed || 0;
    } else if (card.scheduleFold?.test !== "separate") gaps.push("test_result");
  }
  if (expects.includes("device_data")) {
    checks.push(card.deviceData === true);
    if (card.deviceData !== true) unmet += 1;
  }
  if (!checks.length) return card.date < today ? "none" : "planned";
  if (checks.every(Boolean)) return "done";
  if (!(card.date < today)) return "planned";
  if (unmet > 0 && terminal >= unmet) return "missed";
  return "awaiting_entry";
}

// The weekly plan's own order (frontend/weekly-plan.js: AM then PM, Before /
// Training / After, then the session order), then the start time, then the
// title. An item without a slot sorts among the AM items when its start is
// before 12:00, among the PM items otherwise, and last without a start
// (D13, section 2.8). An all-day EVENT (no start time) comes first in its
// day (K2a plan section 1.4).
const AM_PM_RANK = { AM: 0, PM: 1 };
const BTA_RANK = { B: 0, T: 1, A: 2 };
export function sortKey(card) {
  const slot = card.slot;
  const time = card.startTime || "";
  if (card.kind === "event" && !time) return [-1, 0, 0, "", card.title || "", card.key];
  const amPm = slot?.amPm ? AM_PM_RANK[slot.amPm] : time ? (time < "12:00" ? 0 : 1) : 2;
  const bta = slot?.bta ? BTA_RANK[slot.bta] : 1;
  return [amPm, bta, slot?.order ?? 0, time || "99:99", card.title || "", card.key];
}
function compareCards(x, y) {
  const a = sortKey(x);
  const b = sortKey(y);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// The linked planned sessions and activities of one event day (K2a-1b, plan
// sections 2.3 and 3.2) become the event's channels:
//   - RPE x/y over the linked sessions that ask (rpe_enabled and the
//     workspace switch: the K1a rule), added to a folded external
//     schedule's; each athlete's state from their linked session; a linked
//     athlete who is no target any more is listed with `targeted: false`;
//   - `alignment.pending`: the linked sessions whose flags do not follow the
//     event's `expects` (D20: a panel note until the coach aligns them,
//     never an alarm; the status stays the channels');
//   - device data: a linked imported activity whose roster (where one
//     exists) needs no state; its attendance is the event's.
function applyEventFold(card, fold) {
  const expectsRpe = card.expects.includes("rpe");
  let asked = 0;
  let submitted = 0;
  let pending = 0;
  const states = new Map();
  const extraAthletes = new Map();
  for (const r of fold.rows) {
    const state = r.rpe_expected ? (r.rpe_submitted ? "submitted" : "missing") : "not_asked";
    if (r.rpe_expected) {
      asked += 1;
      if (r.rpe_submitted) submitted += 1;
    }
    const aligned = expectsRpe ? r.rpe_enabled === true && r.training_load_enabled === true : r.rpe_enabled !== true;
    if (!aligned) pending += 1;
    const id = String(r.athlete_id);
    states.set(id, mergeRpeState(states.get(id), state));
    if (!extraAthletes.has(id)) extraAthletes.set(id, { athleteId: r.athlete_id, name: r.athlete_name, teamIds: uniq(r.team_ids || []) });
    card.links.planIds.push(r.plan_id);
    if (r.logical_session_id) card.links.logicalSessionIds.push(r.logical_session_id);
  }
  if (asked > 0) {
    card.rpe = card.rpe
      ? { ...card.rpe, asked: card.rpe.asked + asked, submitted: card.rpe.submitted + submitted }
      : { asked, submitted };
  }
  const listed = new Set(card.athletes.map((a) => String(a.athleteId)));
  for (const a of card.athletes) {
    if (states.has(String(a.athleteId))) a.rpe = mergeRpeState(a.rpe, states.get(String(a.athleteId)));
  }
  for (const [id, a] of extraAthletes) {
    if (listed.has(id)) continue;
    card.athletes.push({ ...a, rpe: states.get(id) ?? null, result: null, targeted: false });
  }
  card.links.planIds = uniq(card.links.planIds);
  card.links.logicalSessionIds = uniq(card.links.logicalSessionIds);
  card.links.activityIds.push(...fold.activityIds, ...fold.activities.map((a) => a.id));
  const imported = fold.activities.filter((a) => a.imported);
  if (imported.length) {
    const withRoster = imported.filter((a) => a.counts);
    if (withRoster.length) {
      const sum = (f) => withRoster.reduce((n, a) => n + f(a.counts), 0);
      const roster = sum((c) => c.roster);
      const needsState = sum((c) => c.needsState);
      card.attendance = { roster, present: Math.max(0, roster - needsState - sum((c) => c.didNotParticipate)), needsState };
    }
    card.deviceData = imported.some((a) => !a.counts || a.counts.needsState === 0);
  }
  card.alignment = { pending };
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------
function newCard(fields) {
  return {
    key: null, kind: null, date: null, title: null, slot: null, startTime: null, startsAt: null,
    teamIds: new Set(), athletes: [], expects: [], status: null, rpe: null, attendance: null, results: null,
    cancelled: false, projected: false, links: {}, origin: undefined,
    selfReport: false, measuredSource: false,
    ...fields,
  };
}

export async function readCalendar(ctx, { from, to, today, kinds, filters, includeAthletes }) {
  const wantPlanned = kinds.has("planned");
  const wantActivity = kinds.has("activity");
  const wantExternal = kinds.has("external");
  const wantTest = kinds.has("test");
  const teams = await loadWorkspaceTeams(ctx);
  const teamIds = teams.map((t) => t.teamId);
  // With a Club / Team / Athletes filter on, a projected schedule day whose
  // targets leave nobody in the filter is not shown (the filter narrows).
  const filtering = Boolean(filters.clubIds || filters.teamIds || filters.athleteIds);
  const cards = new Map();
  const logicalSessionToKey = new Map();
  const assignmentToKey = new Map();

  // Events (K2a) are read first, whatever `kinds` asks: a referenced external
  // or test schedule's day card folds under its event, so those kinds are
  // read too whenever an event of the window refers to one — a folded thing
  // is never emitted alone (the D16 rule), and event cards are emitted only
  // when `event` is requested.
  const eventRows = await readEventRows(ctx, { from, to });
  const refersExternal = eventRows.some((r) => r.external_schedule_id);
  const refersTest = eventRows.some((r) => r.test_schedule_id);
  const readExternal = wantExternal || wantActivity || refersExternal;
  const readExternalProjected = wantExternal || refersExternal;
  const readTest = wantTest || refersTest;

  // The event days (K2a), decided BEFORE the other kinds are read: a planned
  // session or an activity linked to an event folds only under an event card
  // this viewer really gets on that day, so it never vanishes into a card
  // that is not emitted (it stays its own card instead). One card per event
  // and day of its span inside the window, shown through the structural
  // relation or through at least one target athlete who was a member ON THAT
  // DAY (the P1 rule).
  const eventDays = [];
  const eventDayKeys = new Set();
  let teamTargets = new Map();
  // The teams an event names: its team targets and its owner team.
  const eventTeams = (row) => new Set([...(teamTargets.get(String(row.id)) || []), ...(row.owner_scope === "team" && row.owner_team_id ? [String(row.owner_team_id)] : [])]);
  if (eventRows.length) {
    const pairs = [];
    for (const row of eventRows) {
      const first = dateStr(row.day) > from ? dateStr(row.day) : from;
      const lastOwn = dateStr(row.end_day) || dateStr(row.day);
      const last = lastOwn < to ? lastOwn : to;
      for (let cursor = first; cursor <= last; cursor = addDaysIso(cursor, 1)) pairs.push({ scheduleId: row.id, day: cursor });
    }
    teamTargets = await readEventTeamTargets(eventRows.map((r) => r.id));
    // A coach's card names the workspace's teams; the athlete's card (D21
    // "teams") names the athlete's own teams ON THAT DAY among the teams the
    // event names — the membership rule of readScheduleTargetAthletes over
    // the union of the window's event teams, cut back per event below. (The
    // other kinds' athlete cards still carry no team: a K1a follow-up, plan
    // section 8.)
    const teamScope = ctx.type === "athlete" ? uniq(eventRows.flatMap((row) => [...eventTeams(row)])) : teamIds;
    const targets = await readScheduleTargetAthletes(ctx, "calendar.event_targets", { pairs, filters, teamIds: teamScope, idColumn: "event_id" });
    for (const row of eventRows) {
      for (const { scheduleId, day } of pairs) {
        if (String(scheduleId) !== String(row.id)) continue;
        const athletes = targets.get(`${row.id}|${day}`) || [];
        if (row.structural !== true && !athletes.length) continue;
        if (filtering && !athletes.length) continue;
        eventDays.push({ row, day, athletes });
        eventDayKeys.add(`event:${row.id}:${day}`);
      }
    }
  }

  // The links (K2a-1b) are a coach's matter: the athlete workspace folds
  // nothing (plan section 5) and reads none. A PLANNED event folds its linked
  // sessions and activities on a day it is shown; a cancelled event folds
  // nothing (manager decision 9.12), so its sessions are planned cards again.
  // A response that does not carry the event cards (`kinds` without `event`)
  // folds nothing either: a linked session or activity is then its own card,
  // never gone from that response (security review of K2a-1b).
  const coachView = ctx.type !== "athlete";
  const foldsLinks = coachView && kinds.has("event") && eventRows.length > 0;
  const sessionLinks = foldsLinks ? await readEventSessionLinks(eventRows.map((r) => r.id)) : [];
  const activityLinks = foldsLinks ? await readEventActivityLinks(eventRows.map((r) => r.id)) : [];
  const eventById = new Map(eventRows.map((r) => [String(r.id), r]));
  const foldsInto = (eventId, day) => {
    const row = eventById.get(String(eventId));
    if (!foldsLinks || !row || row.status !== "planned") return null;
    const key = `event:${row.id}:${day}`;
    return eventDayKeys.has(key) ? key : null;
  };
  const slotToEventKey = new Map();
  for (const link of sessionLinks) {
    if (!link.session_id) continue;
    const key = foldsInto(link.event_id, dateStr(link.day));
    if (key) slotToEventKey.set(slotKeyOf(link.plan_id, dateStr(link.day), link.am_pm, link.bta, link.session_order), key);
  }
  const activityToEventIds = new Map();
  for (const link of activityLinks) {
    const key = String(link.activity_id);
    if (!activityToEventIds.has(key)) activityToEventIds.set(key, []);
    activityToEventIds.get(key).push(String(link.event_id));
  }
  const eventFolds = new Map();
  const foldFor = (key) => {
    if (!eventFolds.has(key)) eventFolds.set(key, { rows: [], activityIds: [], activities: [] });
    return eventFolds.get(key);
  };

  // The planned groups and the external days are read whenever activities
  // are, so that an activity linked to one of them always folds into its
  // card and never stands alone (never twenty cards for one training); when
  // their kind is not requested, the cards are simply not emitted. They are
  // read as well when an event of the window has a linked session (its RPE
  // channel).
  if (wantPlanned || wantActivity || slotToEventKey.size) {
    for (const row of await readPlannedRows(ctx, { from, to, filters, teamIds })) {
      const day = dateStr(row.day);
      // A session linked to an event shown on that day folds under it; the
      // rest of its group stays a planned card (an athlete added to the
      // training after the attach stays visible beside the event).
      const eventKey = slotToEventKey.get(slotKeyOf(row.plan_id, day, row.am_pm, row.bta, row.session_order));
      if (eventKey) {
        foldFor(eventKey).rows.push(row);
        if (row.logical_session_id) logicalSessionToKey.set(String(row.logical_session_id), eventKey);
        continue;
      }
      const key = plannedGroupKey(row, day);
      if (!cards.has(key)) {
        cards.set(key, newCard({
          key, kind: "planned", date: day, title: null,
          slot: { amPm: row.am_pm || null, bta: row.bta || null, order: Number(row.session_order) || 0 },
          links: { activityIds: [], planIds: [], logicalSessionIds: [] },
          titleVotes: new Map(), times: new Set(),
        }));
      }
      const card = cards.get(key);
      const spelled = String(row.session_name ?? "").trim();
      card.titleVotes.set(spelled, (card.titleVotes.get(spelled) || 0) + 1);
      card.times.add(timeStr(row.session_time) || "");
      const teamIdsOfAthlete = uniq(row.team_ids || []);
      teamIdsOfAthlete.forEach((id) => card.teamIds.add(id));
      card.athletes.push({
        athleteId: row.athlete_id, name: row.athlete_name, teamIds: teamIdsOfAthlete,
        planId: row.plan_id, sessionId: row.session_id, logicalSessionId: row.logical_session_id,
        rpe: row.rpe_expected ? (row.rpe_submitted ? "submitted" : "missing") : "not_asked",
      });
      card.links.planIds.push(row.plan_id);
      card.links.logicalSessionIds.push(row.logical_session_id);
      if (row.logical_session_id) logicalSessionToKey.set(String(row.logical_session_id), key);
    }
    for (const card of cards.values()) {
      if (card.kind !== "planned") continue;
      card.title = pickTitle(card.titleVotes);
      // The time every session of the group shares; different times show
      // the slot words instead of a time that is wrong for some athletes.
      card.startTime = card.times.size === 1 ? ([...card.times][0] || null) : null;
      // RPE x/y over the sessions that ask (a group may mix rpe_enabled).
      const asked = card.athletes.filter((a) => a.rpe !== "not_asked").length;
      const submitted = card.athletes.filter((a) => a.rpe === "submitted").length;
      card.expects = asked > 0 ? ["rpe"] : [];
      card.rpe = asked > 0 ? { asked, submitted } : null;
      // One athlete with two same-named sessions in one slot is listed once.
      const byAthlete = new Map();
      for (const a of card.athletes) {
        const prior = byAthlete.get(String(a.athleteId));
        if (prior) prior.rpe = mergeRpeState(prior.rpe, a.rpe);
        else byAthlete.set(String(a.athleteId), a);
      }
      card.athletes = [...byAthlete.values()];
      card.links.planIds = uniq(card.links.planIds);
      card.links.logicalSessionIds = uniq(card.links.logicalSessionIds);
    }
  }

  if (readExternal) {
    for (const row of await readExternalAssignmentRows(ctx, { from, to, filters, teamIds })) {
      const day = dateStr(row.day);
      const key = `external:${row.schedule_id}:${day}`;
      if (!cards.has(key)) {
        cards.set(key, newCard({
          key, kind: "external", date: day, title: row.event_name || null, eventType: row.event_type || null,
          startTime: timeStr(row.opens_time), expects: ["rpe"],
          cancelled: row.schedule_status === "cancelled" || row.occurrence_status === "cancelled",
          links: { activityIds: [], externalScheduleId: row.schedule_id, externalOccurrenceId: row.occurrence_id },
        }));
      }
      const card = cards.get(key);
      const teamIdsOfAthlete = uniq(row.team_ids || []);
      teamIdsOfAthlete.forEach((id) => card.teamIds.add(id));
      const open = !CLOSED_ASSIGNMENT_STATUSES.has(row.assignment_status);
      const missed = MISSED_ASSIGNMENT_STATUSES.has(row.assignment_status);
      card.athletes.push({
        athleteId: row.athlete_id, name: row.athlete_name, teamIds: teamIdsOfAthlete,
        assignmentId: row.assignment_id, assignmentStatus: row.assignment_status,
        rpe: !open ? "not_asked" : row.rpe_submitted ? "submitted" : missed ? "missed" : "missing",
      });
      assignmentToKey.set(String(row.assignment_id), key);
    }
    for (const card of cards.values()) {
      if (card.kind !== "external") continue;
      const asked = card.athletes.filter((a) => a.rpe !== "not_asked").length;
      const submitted = card.athletes.filter((a) => a.rpe === "submitted").length;
      const missed = card.athletes.filter((a) => a.rpe === "missed").length;
      card.rpe = { asked, submitted, missed };
      // Every assignment in scope cancelled or excused: nothing is expected.
      card.expects = asked > 0 ? ["rpe"] : [];
    }
  }
  if (readExternalProjected) {
    const schedules = await readExternalScheduleRows(ctx, { from, to });
    const projected = [];
    for (const schedule of schedules) {
      for (const day of projectScheduleDates(schedule, from, to)) {
        const key = `external:${schedule.id}:${day}`;
        if (cards.has(key)) continue;
        projected.push({ key, schedule, day });
      }
    }
    if (projected.length) {
      const targets = await readScheduleTargetAthletes(ctx, "training_load.external_schedule_targets", {
        pairs: projected.map((p) => ({ scheduleId: p.schedule.id, day: p.day })), filters, teamIds,
      });
      for (const { key, schedule, day } of projected) {
        const athletes = targets.get(`${schedule.id}|${day}`) || [];
        // The day's access: the workspace's own event (structural), or at
        // least one athlete who was a member ON THAT DAY — never the window.
        if (schedule.structural !== true && !athletes.length) continue;
        if (filtering && !athletes.length) continue;
        const card = newCard({
          key, kind: "external", date: day, title: schedule.event_name || null, eventType: schedule.event_type || null,
          startTime: timeStr(schedule.opens_time), expects: ["rpe"], projected: true,
          athletes: athletes.map((a) => ({ ...a, rpe: null })),
          links: { activityIds: [], externalScheduleId: schedule.id, externalOccurrenceId: null },
        });
        athletes.forEach((a) => a.teamIds.forEach((id) => card.teamIds.add(id)));
        cards.set(key, card);
      }
    }
  }

  if (readTest) {
    for (const row of await readTestAssignmentRows(ctx, { from, to, filters, teamIds })) {
      const day = dateStr(row.day);
      const key = `test:${row.schedule_id}:${day}`;
      if (!cards.has(key)) {
        cards.set(key, newCard({
          key, kind: "test", date: day, title: row.test_name || null,
          startTime: timeStr(row.opens_time), expects: ["test_result"],
          cancelled: row.schedule_status === "cancelled" || row.occurrence_status === "cancelled",
          links: { testScheduleId: row.schedule_id, testOccurrenceId: row.occurrence_id },
        }));
      }
      const card = cards.get(key);
      const teamIdsOfAthlete = uniq(row.team_ids || []);
      teamIdsOfAthlete.forEach((id) => card.teamIds.add(id));
      const open = !CLOSED_ASSIGNMENT_STATUSES.has(row.assignment_status);
      const missed = MISSED_ASSIGNMENT_STATUSES.has(row.assignment_status);
      card.athletes.push({
        athleteId: row.athlete_id, name: row.athlete_name, teamIds: teamIdsOfAthlete,
        assignmentId: row.assignment_id, assignmentStatus: row.assignment_status,
        result: row.assignment_status === "completed" ? "completed" : !open ? "not_asked" : missed ? "missed" : "missing",
      });
    }
    for (const card of cards.values()) {
      if (card.kind !== "test") continue;
      const expected = card.athletes.filter((a) => a.result !== "not_asked").length;
      const completed = card.athletes.filter((a) => a.result === "completed").length;
      const missed = card.athletes.filter((a) => a.result === "missed").length;
      card.results = { expected, completed, missed };
      card.expects = expected > 0 ? ["test_result"] : [];
    }
    const schedules = await readTestScheduleRows(ctx, { from, to });
    const projected = [];
    for (const schedule of schedules) {
      for (const day of projectScheduleDates(schedule, from, to)) {
        const key = `test:${schedule.id}:${day}`;
        if (cards.has(key)) continue;
        projected.push({ key, schedule, day });
      }
    }
    if (projected.length) {
      const targets = await readScheduleTargetAthletes(ctx, "tests.test_schedule_targets", {
        pairs: projected.map((p) => ({ scheduleId: p.schedule.id, day: p.day })), filters, teamIds,
      });
      for (const { key, schedule, day } of projected) {
        const athletes = targets.get(`${schedule.id}|${day}`) || [];
        if (schedule.structural !== true && !athletes.length) continue;
        if (filtering && !athletes.length) continue;
        const card = newCard({
          key, kind: "test", date: day, title: schedule.test_name || null,
          startTime: timeStr(schedule.opens_time), expects: ["test_result"], projected: true,
          athletes: athletes.map((a) => ({ ...a, result: null })),
          links: { testScheduleId: schedule.id, testOccurrenceId: null },
        });
        athletes.forEach((a) => a.teamIds.forEach((id) => card.teamIds.add(id)));
        cards.set(key, card);
      }
    }
  }

  // Activities: fold the linked ones into their planned / external card
  // (section 2.2) or under the event they are linked to (K2a-1b); the rest
  // are their own cards. Read as well when an event is asked for (its RPE
  // channel and its device data).
  if (wantPlanned || wantExternal || wantActivity || (kinds.has("event") && eventRows.length > 0)) {
    const own = [];
    const linkedToEvents = [];
    for (const row of await readActivityRows(ctx, { from, to, filters })) {
      let linkedKey = null;
      for (const linkedEventId of activityToEventIds.get(String(row.id)) || []) {
        linkedKey = foldsInto(linkedEventId, dateStr(row.day));
        if (linkedKey) break;
      }
      if (linkedKey) {
        linkedToEvents.push({ row, key: linkedKey });
        continue;
      }
      let folded = false;
      for (const logicalSessionId of row.logical_session_ids || []) {
        const key = logicalSessionToKey.get(String(logicalSessionId));
        if (!key) continue;
        if (key.startsWith("event:")) foldFor(key).activityIds.push(row.id);
        else cards.get(key).links.activityIds.push(row.id);
        folded = true;
      }
      for (const assignmentId of row.external_assignment_ids || []) {
        const key = assignmentToKey.get(String(assignmentId));
        if (!key) continue;
        cards.get(key).links.activityIds.push(row.id);
        folded = true;
      }
      if (!folded && wantActivity) own.push(row);
    }
    // The roster (who of the team still needs a state) is the coach's view:
    // the athlete workspace gets no attendance of a team activity.
    const rosterCounts = ctx.type === "athlete" ? new Map() : await readRosterCounts([...own, ...linkedToEvents.map((x) => x.row)].map((row) => row.id));
    for (const { row, key } of linkedToEvents) {
      const read = rosterCounts.get(String(row.id)) || null;
      foldFor(key).activities.push({ id: row.id, imported: IMPORTED_ORIGINS.has(row.origin), counts: read?.hasRoster ? read : null });
    }
    for (const row of own) {
      const participants = Array.isArray(row.participants) ? row.participants : [];
      const expects = [];
      if (IMPORTED_ORIGINS.has(row.origin)) expects.push("device_data");
      if (row.rpe_requested > 0) expects.push("rpe");
      const read = rosterCounts.get(String(row.id)) || null;
      const counts = read?.hasRoster ? read : null;
      const card = newCard({
        key: `activity:${row.id}`, kind: "activity", date: dateStr(row.day), title: row.name || null,
        origin: row.origin, activityTypeKey: row.activity_type_key || null,
        startTime: row.start_time || null, startsAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        athletes: participants.map((p) => ({ athleteId: p.athleteId, name: p.name, teamIds: [] })),
        expects,
        rpe: row.rpe_requested > 0 ? { asked: row.rpe_requested, submitted: row.rpe_rated } : null,
        attendance: counts ? { roster: counts.roster, present: Math.max(0, counts.roster - counts.needsState - counts.didNotParticipate), needsState: counts.needsState } : null,
        selfReport: isSelfReportCard(row, participants.length, read?.hasRoster),
        measuredSource: IMPORTED_ORIGINS.has(row.origin) || counts?.measured === true,
        links: { activityIds: [row.id], logicalSessionIds: uniq(row.logical_session_ids || []), externalAssignmentIds: uniq(row.external_assignment_ids || []) },
      });
      if (row.owner_scope === "team" && row.owner_team_id && teamIds.some((id) => String(id) === String(row.owner_team_id))) card.teamIds.add(String(row.owner_team_id));
      cards.set(card.key, card);
    }
  }

  // Event cards (K2a plan section 1.4), one per event day decided above, with
  // the referenced schedule's day card, the linked sessions (K2a-1b) and the
  // linked activities folded under a PLANNED event.
  const workspaceTeams = new Set(teamIds.map(String));
  for (const { row, day, athletes } of eventDays) {
    const canManage = ctx.type === "coach" && eventWriteBasis(ctx, eventOwnerOfRow(row)) !== null;
    const card = newCard({
      key: `event:${row.id}:${day}`, kind: "event", date: day, title: row.title,
      startTime: timeStr(row.start_time), endTime: timeStr(row.end_time), location: row.location,
      eventId: String(row.id), eventKind: row.event_kind, eventTypeId: String(row.event_type_id), eventTypeLabel: row.event_type_label,
      span: { from: dateStr(row.day), to: dateStr(row.end_day) || dateStr(row.day) },
      expects: [...(row.expects || [])], cancelled: row.status === "cancelled",
      revision: row.revision, canManage, notes: canManage ? row.notes : undefined,
      athleteView: ctx.type === "athlete",
      scheduleFold: { external: null, test: null },
      athletes: athletes.map((a) => ({ ...a, rpe: null, result: null })),
      links: {
        eventId: String(row.id), planIds: [], logicalSessionIds: [], activityIds: [],
        externalScheduleId: row.external_schedule_id ? String(row.external_schedule_id) : null, externalOccurrenceId: null,
        testScheduleId: row.test_schedule_id ? String(row.test_schedule_id) : null, testOccurrenceId: null,
        orphanedSessionLinks: 0, renamedSessionLinks: 0,
      },
    });
    if (ctx.type === "athlete") {
      const named = eventTeams(row);
      athletes.forEach((a) => a.teamIds.forEach((id) => { if (named.has(String(id))) card.teamIds.add(String(id)); }));
    } else {
      athletes.forEach((a) => a.teamIds.forEach((id) => card.teamIds.add(id)));
    }
    for (const id of teamTargets.get(String(row.id)) || []) if (workspaceTeams.has(id)) card.teamIds.add(id);
    if (row.owner_scope === "team" && row.owner_team_id && workspaceTeams.has(String(row.owner_team_id))) card.teamIds.add(String(row.owner_team_id));
    // The referenced schedule's card of this day folds under a PLANNED
    // event: its counts and per-athlete states become the event's channel;
    // the card itself is never emitted alone. A cancelled event folds
    // nothing (manager decision 9.12: the schedule keeps collecting and stays
    // its own card), and the athlete workspace folds nothing either — the
    // athlete's own RPE request stays visible beside the reduced event card
    // (plan section 5).
    // It folds only when, for this day and this viewer, EVERY athlete of the
    // schedule's card is among the event's target athletes (the owner's
    // external review of PR #298, the manager's option 3): the numbers on an
    // event card come only from athletes the card lists. A schedule that
    // reaches wider than the event stays its own card beside it, and the
    // event card says so (`scheduleFold`: separate) instead of taking the
    // schedule's numbers.
    const folds = row.status === "planned" && ctx.type !== "athlete";
    const listed = new Set(card.athletes.map((a) => String(a.athleteId)));
    const covers = (other) => other.athletes.every((a) => listed.has(String(a.athleteId)));
    if (folds && row.external_schedule_id) {
      const ext = cards.get(`external:${row.external_schedule_id}:${day}`);
      if (ext && !covers(ext)) card.scheduleFold.external = "separate";
      else if (ext) {
        card.scheduleFold.external = "folded";
        card.rpe = ext.rpe;
        card.links.externalOccurrenceId = ext.links.externalOccurrenceId ?? null;
        card.links.activityIds.push(...(ext.links.activityIds || []));
        const states = new Map(ext.athletes.map((a) => [String(a.athleteId), a.rpe]));
        for (const a of card.athletes) a.rpe = states.get(String(a.athleteId)) ?? null;
        cards.delete(ext.key);
      }
    }
    if (folds && row.test_schedule_id) {
      const tst = cards.get(`test:${row.test_schedule_id}:${day}`);
      if (tst && !covers(tst)) card.scheduleFold.test = "separate";
      else if (tst) {
        card.scheduleFold.test = "folded";
        card.results = tst.results;
        card.links.testOccurrenceId = tst.links.testOccurrenceId ?? null;
        const states = new Map(tst.athletes.map((a) => [String(a.athleteId), a.result]));
        for (const a of card.athletes) a.result = states.get(String(a.athleteId)) ?? null;
        cards.delete(tst.key);
      }
    }
    const fold = folds ? eventFolds.get(card.key) : null;
    if (fold) applyEventFold(card, fold);
    if (ctx.type !== "athlete") {
      // The links that no longer find their session (a deleted plan, a
      // session moved to another slot) and the sessions renamed since the
      // link: visible on the manager's card, never silent (plan 2.2).
      for (const link of sessionLinks) {
        if (String(link.event_id) !== String(row.id) || dateStr(link.day) !== day) continue;
        if (!link.session_id) card.links.orphanedSessionLinks += 1;
        else if (normalizedSessionName(link.session_name) !== normalizedSessionName(link.session_name_at_link)) card.links.renamedSessionLinks += 1;
      }
    }
    cards.set(card.key, card);
  }

  // Days, statuses, order, the public shape.
  const byDate = new Map();
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) byDate.set(cursor, []);
  for (const card of cards.values()) {
    if (!kinds.has(card.kind)) continue;
    const bucket = byDate.get(card.date);
    if (!bucket) continue;
    card.status = card.kind === "event" ? deriveEventStatus(card, today) : deriveStatus(card, today);
    if (card.links.activityIds) card.links.activityIds = uniq(card.links.activityIds);
    bucket.push(card);
  }
  const days = [];
  for (const [date, items] of byDate) {
    items.sort(compareCards);
    days.push({ date, items: items.map((card) => publicCard(card, includeAthletes)) });
  }
  return { from, to, today, workspace: { type: ctx.workspace.type, scopeId: ctx.workspace.scopeId ?? null }, teams, days };
}

function publicCard(card, includeAthletes) {
  // The athlete's own view of an event (D21): name, kind, date, time, place,
  // status (planned / cancelled) and teams — never a count, a teammate, a
  // note or a link beyond the event's id.
  if (card.kind === "event" && card.athleteView) {
    return {
      key: card.key, kind: "event", date: card.date, title: card.title,
      eventKind: card.eventKind, eventTypeLabel: card.eventTypeLabel, span: card.span,
      startTime: card.startTime, endTime: card.endTime, location: card.location,
      status: card.cancelled ? "cancelled" : "planned", cancelled: card.cancelled,
      teamIds: [...card.teamIds].sort(),
      links: { eventId: card.eventId },
    };
  }
  const athleteIds = uniq(card.athletes.map((a) => a.athleteId));
  const out = {
    key: card.key, kind: card.kind, date: card.date, title: card.title,
    slot: card.slot, startTime: card.startTime, startsAt: card.startsAt,
    teamIds: [...card.teamIds].sort(), athleteIds, athleteCount: athleteIds.length,
    expects: card.expects, status: card.status,
    rpe: card.rpe, attendance: card.attendance, results: card.results,
    cancelled: card.cancelled, projected: card.projected,
    links: card.links,
  };
  if (card.kind === "activity") {
    out.origin = card.origin;
    out.activityTypeKey = card.activityTypeKey ?? null;
  }
  if (card.kind === "external") out.eventType = card.eventType ?? null;
  if (card.kind === "event") {
    out.eventId = card.eventId;
    out.eventKind = card.eventKind;
    out.eventTypeLabel = card.eventTypeLabel;
    out.endTime = card.endTime;
    out.location = card.location;
    out.span = card.span;
    out.gaps = card.gaps || [];
    // Whether the referenced schedule's day card is folded under this card
    // or shown beside it (it reaches wider than the event's targets):
    // "folded", "separate", or null (no schedule card that day).
    out.scheduleFold = card.scheduleFold ?? { external: null, test: null };
    out.revision = card.revision;
    out.canManage = card.canManage === true;
    if (card.canManage) {
      out.eventTypeId = card.eventTypeId;
      out.notes = card.notes ?? null;
      out.alignment = card.alignment ?? { pending: 0 };
    } else {
      // A reader who may not manage the event gets no id of its type or of
      // its referenced schedules (the reduced GET /:id shows none either);
      // the folded activities stay — they are the ones the reader may open.
      out.links = { eventId: card.links.eventId, activityIds: card.links.activityIds };
    }
  }
  if (includeAthletes) out.athletes = card.athletes;
  return out;
}
