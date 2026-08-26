import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { canAccessAthlete } from "../access.js";
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "../authz.js";
import { canManageSchedule, manageableClubIds, manageableTeamIds, resolveScheduleOwnerContext } from "../testsAccess.js";
import { ensureCurrentOccurrence, assignmentIsOpen } from "../testsOccurrenceService.js";
import { completeTestAssessmentWithDerivedResults } from "../testAssessmentCalculations.js";
import { emitRealtimeEvent } from "../realtime.js";

const router = Router();

// WELLNESS's real, seeded UUIDs (migrations_v2/202608221000_tests_v42_seed_
// wellness_fms.sql) - the only test this phase's scheduling/execution UI
// offers. FMS scheduling/execution is explicitly out of scope (no FMS form,
// no FMS check-in flow exists yet) - restricting schedule creation to this
// one test_version_id keeps the app from ever offering a "schedule" a coach
// could create but never see a real execution UI for. Lifting this
// restriction (to allow scheduling other tests/batteries once they have
// their own execution UI) only requires relaxing the one check in
// POST /schedules below - nothing else in this file hardcodes WELLNESS.
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const WELLNESS_TOTAL_DERIVED_PARAMETER_ID = "a342af02-52cb-4b39-83d5-3b7861fe2069";
const WELLNESS_INJURY_PARAMETER_ID = "a98f2afb-b458-40ff-98a7-c6b5108bba9e";

// The only two scheduleKind values POST/PATCH ever accept from a client -
// anything else (a typo like "weekly", an unrelated value) is a controlled
// 400, never silently coerced to "one_time" the way an unconditional
// `=== "daily" ? recurring : one_time` ternary used to.
const VALID_SCHEDULE_KIND_INPUTS = ["one_time", "daily"];

// POST /schedules/bulk (Specific dates) hard cap - a coach drag-selecting a
// huge range is still one request; this bounds its worst-case transaction
// size (one insert pair per date) without picking an arbitrary-feeling
// number - 366 is "every possible day of one calendar year, leap included".
const MAX_BULK_DATES = 366;

// Phase 3A: the four notification kinds tests.test_schedule_notification_
// rules already supports (added in migrations_v2/202608240900_..., a
// future-worker input at the time - see testsNotificationWorker.js for the
// worker that now reads them). digest_trigger is never client-controlled -
// the UI only ever offers "enabled" + (for reminder) an offset, so the
// backend fixes the trigger per kind itself.
const NOTIFICATION_KINDS = ["athlete_invitation", "athlete_reminder", "coach_digest", "final_digest"];
const DEFAULT_REMINDER_OFFSET_MINUTES = 60;
const DIGEST_TRIGGER_BY_KIND = { coach_digest: "periodic", final_digest: "on_close" };

// Validates + normalizes a client-supplied notificationRules array into
// EXACTLY one row per NOTIFICATION_KINDS entry - a kind the client omitted
// resolves to enabled:false, never "leave whatever existed before" (every
// save fully replaces the set - see replaceNotificationRules below - which
// is what makes "atomsko upisivanje sva četiri pravila" true: the coach
// always sees and confirms the complete set, never a partial merge).
// Returns { ok:false, status, error } on the first problem found, or
// { ok:true, rules: null } if the caller didn't send notificationRules at
// all (meaning: don't touch whatever's already saved for this schedule).
function resolveNotificationRules(rawRules) {
  if (rawRules === undefined) return { ok: true, rules: null };
  const byKind = new Map();
  for (const raw of Array.isArray(rawRules) ? rawRules : []) {
    if (!raw || !NOTIFICATION_KINDS.includes(raw.kind)) {
      return { ok: false, status: 400, error: `Unknown notification rule kind: "${raw?.kind}".` };
    }
    if (byKind.has(raw.kind)) {
      return { ok: false, status: 400, error: `Duplicate notification rule for "${raw.kind}".` };
    }
    if (typeof raw.enabled !== "boolean") {
      return { ok: false, status: 400, error: `The "${raw.kind}" rule needs an "enabled" true/false.` };
    }
    byKind.set(raw.kind, raw);
  }
  const resolved = [];
  for (const kind of NOTIFICATION_KINDS) {
    const raw = byKind.get(kind);
    const enabled = raw ? raw.enabled : false;
    let reminderOffsetMinutes = null;
    if (kind === "athlete_reminder") {
      // The DB CHECK requires a non-null offset on every athlete_reminder
      // row regardless of enabled/disabled - falling back to the same
      // 60-minute MVP default the create form itself shows (rather than
      // rejecting) means disabling the reminder without having typed an
      // offset first can never fail validation over a field the coach
      // can't even see while it's disabled.
      const rawOffset = raw?.reminderOffsetMinutes;
      reminderOffsetMinutes = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : DEFAULT_REMINDER_OFFSET_MINUTES;
    }
    const digestTrigger = DIGEST_TRIGGER_BY_KIND[kind] || null;
    resolved.push({ kind, enabled, reminderOffsetMinutes, digestTrigger });
  }
  return { ok: true, rules: resolved };
}

// Runs inside the caller's own open transaction (POST /schedules, POST
// /schedules/bulk's per-date loop, PATCH /schedules/:id) - a full
// delete-then-reinsert of all 4 rows, so a constraint violation on any one
// of them rolls back the whole write, never a partial rule set.
async function replaceNotificationRules(client, scheduleId, rules) {
  await client.query(`delete from tests.test_schedule_notification_rules where schedule_id = $1`, [scheduleId]);
  for (const rule of rules) {
    await client.query(
      `insert into tests.test_schedule_notification_rules
         (schedule_id, notification_kind, enabled, reminder_offset_minutes, digest_trigger)
       values ($1, $2, $3, $4, $5)`,
      [scheduleId, rule.kind, rule.enabled, rule.reminderOffsetMinutes, rule.digestTrigger],
    );
  }
}

async function loadNotificationRules(executor, scheduleId) {
  const result = await executor(
    `select notification_kind, enabled, reminder_offset_minutes, digest_trigger
     from tests.test_schedule_notification_rules where schedule_id = $1`,
    [scheduleId],
  );
  return result.rows.map((row) => ({
    kind: row.notification_kind,
    enabled: row.enabled,
    reminderOffsetMinutes: row.reminder_offset_minutes,
    digestTrigger: row.digest_trigger,
  }));
}

const athleteDisplayNameSql = `coalesce(a.display_name, a.full_name, nullif(concat_ws(' ', a.first_name, a.last_name), ''), a.source_external_id, a.athlete_id::text)`;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A bare regex accepts calendar-impossible strings like "2026-02-30" or
// "2026-04-31" - Date's own constructor doesn't reject those either, it
// silently rolls the extra days over into the next month. Validity here is
// confirmed by round-tripping the parsed year/month/day through
// Date.UTC(...) and checking the components come back unchanged (a rollover
// changes at least one of them).
function isValidGregorianDateString(value) {
  const match = DATE_STRING_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireAthlete(req, res) {
  if (!req.authz?.isAthlete || !req.authz.athleteId) {
    res.status(403).json({ error: "This account has no athlete profile." });
    return null;
  }
  return req.authz.athleteId;
}

function requireCoachWorkspace(req, res) {
  if (!req.authz?.capabilities?.coachWorkspace) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// Translates a controlled RAISE EXCEPTION from a Phase 1 trigger (SQLSTATE
// P0001 - e.g. "outside the schedule window", "wrong value type") into a
// 400 the frontend can show directly. Anything else (a real bug, a
// constraint we didn't anticipate) still flows to next(error) as a 500 -
// this never widens what counts as a "safe to show" error message.
function respondToWriteError(res, next, error) {
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

async function loadWellnessParameters(executor) {
  const result = await executor(
    `select p.id, p.parameter_key, p.value_type, p.minimum_value, p.maximum_value,
            pr.display_order, pr.is_required, pr.control_type, pr.direction, pr.min_value_label, pr.max_value_label, pr.help_text
     from tests.test_parameters p
     left join tests.test_parameter_presentation pr on pr.test_parameter_id = p.id
     where p.test_version_id = $1
     order by coalesce(pr.display_order, 999), p.parameter_key`,
    [WELLNESS_TEST_VERSION_ID],
  );
  return result.rows;
}

function parametersForResponse(rows) {
  return rows.map((row) => ({
    key: row.parameter_key,
    valueType: row.value_type,
    minimum: row.minimum_value === null ? null : Number(row.minimum_value),
    maximum: row.maximum_value === null ? null : Number(row.maximum_value),
    displayOrder: row.display_order === null ? 999 : row.display_order,
    required: row.is_required !== false,
    controlType: row.control_type || (row.value_type === "boolean" ? "yes_no" : "number"),
    direction: row.direction || "neutral",
    minLabel: row.min_value_label,
    maxLabel: row.max_value_label,
    helpText: row.help_text,
  }));
}

async function loadAssessmentValuesAndResult(executor, assessmentId) {
  const [valuesResult, derivedResult] = await Promise.all([
    executor(
      `select tp.parameter_key, v.value_numeric, v.value_boolean, v.value_text
       from tests.test_assessment_values v
       join tests.test_parameters tp on tp.id = v.test_parameter_id
       where v.assessment_id = $1`,
      [assessmentId],
    ),
    executor(
      `select result_numeric from tests.test_assessment_derived_results
       where assessment_id = $1 and test_version_derived_parameter_id = $2`,
      [assessmentId, WELLNESS_TOTAL_DERIVED_PARAMETER_ID],
    ),
  ]);
  const values = {};
  for (const row of valuesResult.rows) {
    values[row.parameter_key] = row.value_numeric !== null ? Number(row.value_numeric) : row.value_boolean !== null ? row.value_boolean : row.value_text;
  }
  return {
    values,
    wellnessScore: derivedResult.rows[0]?.result_numeric != null ? Number(derivedResult.rows[0].result_numeric) : null,
  };
}

// ------------------------------------------------------------
// Athlete: today / upcoming / history
// ------------------------------------------------------------

// Phase 4: the athlete's own device reports its IANA timezone here on every
// authenticated entry into the Tests area - never a manual picker. Strictly
// validated (public.validate_athlete_device_timezone trigger, migrations_v2/
// 202608300900_..._phase4_assignment_timezone_window.sql) - an invalid
// value is rejected as a controlled 400 via respondToWriteError, never
// silently stored. This is the ONLY write path for public.athletes.
// device_timezone in the whole app.
//
// Round 3 hardening (item 3): the frontend used to cache "have I already
// POSTed this exact timezone value in this page session" and skip repeat
// calls (frontend/tests-data.js's reportDeviceTimezone) - keyed only by the
// timezone STRING, never by which account was logged in when it was sent.
// Athlete A logging out and athlete B logging in on the same device, in the
// same timezone, could then skip B's own POST entirely, leaving B's row
// still carrying A's (coincidentally identical-looking, but never actually
// B's own) reported value. The frontend now always sends this request on
// every entry point instead of caching at all - correctness over shaving a
// request - so this endpoint has to be the one guarding against
// unnecessary writes: `device_timezone is distinct from $2` (NULL-safe)
// means a repeat POST of the SAME value is a true no-op, touching neither
// device_timezone NOR device_timezone_updated_at, while a genuinely
// different value (a real device-timezone change, or a different account
// under the same session) is written and timestamped exactly as before.
router.post("/athlete/timezone", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const timezone = text(req.body?.timezone);
    if (!timezone) return res.status(400).json({ error: "timezone is required." });
    await query(
      `update public.athletes set device_timezone = $2, device_timezone_updated_at = now() where id = $1 and device_timezone is distinct from $2`,
      [athleteId, timezone],
    );
    res.json({ ok: true, timezone });
  } catch (error) { respondToWriteError(res, next, error); }
});

router.get("/athlete/today", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;

    // Step 1: for every ACTIVE schedule CURRENTLY targeting this athlete
    // (direct, or via a current team/club membership), ensure today's/the
    // one-time occurrence exists - idempotent, matches Phase 1's own
    // on-demand materialization contract exactly. This step's only job is
    // to make sure new rows exist where they should; it never decides what
    // gets shown below.
    const schedules = await loadSchedulesTargetingAthlete(athleteId, "active");
    for (const schedule of schedules) {
      await ensureCurrentOccurrence(pool, schedule);
    }

    // Step 2: the athlete's OWN already-materialized assignments, for
    // TODAY's occurrence in each occurrence's own schedule timezone, are
    // the real source of truth for what Today shows - queried directly
    // from test_assignments, never re-derived from CURRENT membership.
    // This is what keeps an assignment visible even after the athlete's
    // team/club membership is later paused/removed/changed:
    // materialize_test_assignments_for_occurrence() (Phase 1) already
    // guarantees a later membership change never retroactively adds/
    // removes rows for an occurrence that was already materialized: this
    // endpoint must not undo that guarantee by re-deriving "today" from
    // step 1's membership-based schedule list instead of from the
    // assignment rows that already exist.
    //
    // The one exception: `sch.status <> 'cancelled'` below. DELETE
    // /schedules/:id (see the cancel branch) intentionally never touches
    // existing occurrence/assignment rows - they stay exactly as they are,
    // preserved for History/Results - but a still-PENDING assignment for a
    // schedule the coach has since cancelled must stop showing as an
    // actionable "Today" item (a completed one is unaffected here; it
    // always remains reachable through History regardless of schedule
    // status, via GET /athlete/history's own query, which never joins
    // against test_schedules at all).
    // "Today" is evaluated in the ASSIGNMENT's own snapshotted timezone
    // (asg.timezone - the athlete's effective timezone at materialization
    // time), never the schedule's - two athletes under the same occurrence
    // can genuinely disagree about whether "today" has arrived/ended.
    const assignmentsResult = await query(
      `select asg.*, o.status as occurrence_status, tv.name as test_name
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_schedules sch on sch.id = o.schedule_id
       join tests.test_versions tv on tv.id = asg.snapshot_test_version_id
       where asg.athlete_id = $1
         and asg.local_scheduled_date = (now() at time zone asg.timezone)::date
         and sch.status <> 'cancelled'
       order by asg.local_scheduled_date desc`,
      [athleteId],
    );
    const rows = [];
    for (const assignment of assignmentsResult.rows) {
      rows.push(await formatAthleteAssignmentRow(assignment));
    }
    res.json({ assignments: rows });
  } catch (error) { next(error); }
});

router.get("/athlete/upcoming", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    // No assignment row exists yet for these (nothing materialized) - the
    // preview uses the athlete's own LAST KNOWN effective timezone
    // (device_timezone, falling back to the schedule's) exactly as a real
    // future materialization would, per the spec's "last known timezone is
    // used for a future, not-yet-materialized assignment" rule.
    const result = await query(
      `select distinct sch.id, sch.start_date, sch.opens_time, coalesce(a.device_timezone, sch.timezone) as timezone, tv.name as test_name
       from tests.test_schedules sch
       join tests.test_versions tv on tv.id = sch.test_version_id
       join public.athletes a on a.id = $1
       left join tests.test_schedule_targets t on t.schedule_id = sch.id
       left join public.athlete_memberships m
         on (t.target_kind = 'team' and m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active' and m.athlete_id = $1)
         or (t.target_kind = 'club' and m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active' and m.athlete_id = $1)
       where sch.status = 'active'
         and sch.schedule_kind = 'one_time'
         and sch.start_date > (now() at time zone coalesce(a.device_timezone, sch.timezone))::date
         and (
           (t.target_kind = 'athlete' and t.target_athlete_id = $1)
           or (t.target_kind = 'team' and m.athlete_id = $1)
           or (t.target_kind = 'club' and m.athlete_id = $1)
           -- Round 3 hardening (item 1): same widening as loadSchedulesTargetingAthlete
           -- above - a snapshotted-but-not-yet-assigned athlete stays a
           -- candidate even after membership changes; still correctly
           -- "upcoming" as long as their own real current date hasn't
           -- reached the occurrence's own scheduled_date yet.
           or exists (
             select 1
             from tests.test_schedule_occurrences occ
             join tests.test_occurrence_target_snapshot snap on snap.occurrence_id = occ.id
             where occ.schedule_id = sch.id
               and snap.athlete_id = $1
               and not exists (
                 select 1 from tests.test_assignments asg
                 where asg.occurrence_id = occ.id and asg.athlete_id = snap.athlete_id
               )
           )
         )
       order by sch.start_date asc`,
      [athleteId],
    );
    res.json({
      upcoming: result.rows.map((row) => ({
        scheduleId: row.id,
        testName: row.test_name,
        startDate: row.start_date,
        opensTime: row.opens_time,
        timezone: row.timezone,
      })),
    });
  } catch (error) { next(error); }
});

router.get("/athlete/history", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const result = await query(
      `select ta.id, ta.status, ta.completed_at, tv.name as test_name,
              tdr.result_numeric as wellness_score,
              inj.value_boolean as injury
       from tests.test_assessments ta
       join tests.test_versions tv on tv.id = ta.test_version_id
       left join tests.test_assessment_derived_results tdr on tdr.assessment_id = ta.id and tdr.test_version_derived_parameter_id = $2
       left join tests.test_assessment_values inj on inj.assessment_id = ta.id and inj.test_parameter_id = $3
       where ta.athlete_id = $1
         and ta.superseded_by_assessment_id is null
         and ta.status = 'completed'
       order by ta.completed_at desc
       limit 100`,
      [athleteId, WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID],
    );
    res.json({
      history: result.rows.map((row) => ({
        assessmentId: row.id,
        testName: row.test_name,
        completedAt: row.completed_at,
        wellnessScore: row.wellness_score != null ? Number(row.wellness_score) : null,
        injury: row.injury,
      })),
    });
  } catch (error) { next(error); }
});

// Round 3 hardening (item 1): CURRENT membership is not the full picture of
// "which schedules does this athlete need ensureCurrentOccurrence() run
// for". An athlete already frozen into an occurrence's tests.test_
// occurrence_target_snapshot, but not yet assigned (their own local day
// hasn't arrived), must stay a candidate for materialization even after
// their membership is later paused/removed - otherwise this query would
// stop surfacing that schedule to them at all, and ensureCurrentOccurrence
// (whose own tests.resolve_current_target_dates() already accounts for
// outstanding snapshot members - see that migration) would simply never be
// called for it again from this athlete's own Today view. The second
// `or exists (...)` branch below is what keeps that path reachable; a LATE
// joiner (never snapshotted) still only ever matches via current
// membership, same as before.
async function loadSchedulesTargetingAthlete(athleteId, status) {
  const result = await query(
    `select distinct sch.*
     from tests.test_schedules sch
     left join tests.test_schedule_targets t on t.schedule_id = sch.id
     left join public.athlete_memberships m
       on (t.target_kind = 'team' and m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active')
       or (t.target_kind = 'club' and m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active')
     where sch.status = $2
       and (
         (t.target_kind = 'athlete' and t.target_athlete_id = $1)
         or (t.target_kind = 'team' and m.athlete_id = $1)
         or (t.target_kind = 'club' and m.athlete_id = $1)
         or exists (
           select 1
           from tests.test_schedule_occurrences occ
           join tests.test_occurrence_target_snapshot snap on snap.occurrence_id = occ.id
           where occ.schedule_id = sch.id
             and snap.athlete_id = $1
             and not exists (
               select 1 from tests.test_assignments asg
               where asg.occurrence_id = occ.id and asg.athlete_id = snap.athlete_id
             )
         )
       )`,
    [athleteId, status],
  );
  return result.rows;
}

async function formatAthleteAssignmentRow(assignment) {
  let latestAssessment = null;
  const assessmentResult = await query(
    `select id, status, completed_at from tests.test_assessments
     where standalone_assignment_id = $1 and superseded_by_assessment_id is null
     order by created_at desc limit 1`,
    [assignment.id],
  );
  if (assessmentResult.rows[0]) {
    const row = assessmentResult.rows[0];
    const { values, wellnessScore } = row.status === "completed" ? await loadAssessmentValuesAndResult(query, row.id) : { values: {}, wellnessScore: null };
    latestAssessment = { id: row.id, status: row.status, completedAt: row.completed_at, values, wellnessScore };
  }
  return {
    assignmentId: assignment.id,
    status: assignment.status,
    testName: assignment.test_name,
    // Field kept named "occurrence" for response-shape/frontend compat, but
    // opensAt/closesAt/isOpen now come from the ASSIGNMENT's own per-athlete
    // window (assignment.opens_at/due_at/closes_at, snapshotted at
    // materialization in the athlete's own effective timezone), not the
    // shared occurrence-level window - see testsOccurrenceService.js's
    // assignmentIsOpen().
    occurrence: {
      id: assignment.occurrence_id,
      opensAt: assignment.opens_at,
      closesAt: assignment.closes_at,
      status: assignment.occurrence_status,
      isOpen: assignmentIsOpen(assignment),
    },
    latestAssessment,
  };
}

// ------------------------------------------------------------
// Athlete: one assignment (form definition + latest answer) + submit
// ------------------------------------------------------------

router.get("/assignments/:assignmentId", async (req, res, next) => {
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;
    const assignmentResult = await query(
      `select asg.*, o.status as occurrence_status, tv.id as test_version_id, tv.name as test_name, tv.description as test_description,
              a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name, a.image_url as athlete_image_url, sch.status as schedule_status
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_schedules sch on sch.id = o.schedule_id
       join tests.test_versions tv on tv.id = asg.snapshot_test_version_id
       join public.athletes a on a.id = asg.athlete_id
       where asg.id = $1`,
      [req.params.assignmentId],
    );
    const assignment = assignmentResult.rows[0];
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });
    if (String(assignment.athlete_id) !== String(athleteId)) return res.status(404).json({ error: "Assignment not found." });
    if (assignment.snapshot_test_battery_version_id) return res.status(400).json({ error: "This assignment is for a battery, not a single test - not supported yet." });

    const parameterRows = await loadWellnessParameters(query);
    const assessmentResult = await query(
      `select id, status, completed_at from tests.test_assessments
       where standalone_assignment_id = $1 and superseded_by_assessment_id is null
       order by created_at desc limit 1`,
      [assignment.id],
    );
    let latestAssessment = null;
    if (assessmentResult.rows[0]) {
      const row = assessmentResult.rows[0];
      const { values, wellnessScore } = row.status === "completed" ? await loadAssessmentValuesAndResult(query, row.id) : { values: {}, wellnessScore: null };
      latestAssessment = { id: row.id, status: row.status, completedAt: row.completed_at, values, wellnessScore };
    }

    // canSubmit requires BOTH the occurrence's own opens/closes window AND
    // the parent schedule still being 'active' - a cancelled or paused
    // schedule must never offer a fillable form again, even to a coach/
    // athlete who had this exact page open before the status changed (the
    // real enforcement is server-side in POST /submit below; this only
    // controls what the GET tells the client to render).
    const isOpen = assignmentIsOpen(assignment);
    const canSubmit = isOpen && assignment.schedule_status === "active";
    res.json({
      assignment: {
        id: assignment.id,
        status: assignment.status,
        occurrence: { id: assignment.occurrence_id, opensAt: assignment.opens_at, closesAt: assignment.closes_at, status: assignment.occurrence_status, isOpen },
        athlete: { id: assignment.athlete_id, name: assignment.athlete_name, imageUrl: assignment.athlete_image_url || "" },
        scheduleStatus: assignment.schedule_status,
      },
      testVersion: { id: assignment.test_version_id, name: assignment.test_name, description: assignment.test_description },
      parameters: parametersForResponse(parameterRows),
      latestAssessment,
      canSubmit,
    });
  } catch (error) { next(error); }
});

router.post("/assignments/:assignmentId/submit", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const athleteId = requireAthlete(req, res);
    if (!athleteId) return;

    const values = req.body?.values && typeof req.body.values === "object" ? req.body.values : {};
    const idempotencyKey = text(req.body?.idempotencyKey) || null;

    await client.query("begin");

    // Step 0: an UNLOCKED read that only resolves which occurrence/schedule
    // this assignment currently belongs to - never a lock itself. This is
    // what lets the real locks below be taken in the SAME canonical order
    // every write path in this file now uses: schedule -> occurrence ->
    // assignment -> assessment (see PATCH /schedules/:id, which locks in
    // this exact order via loadScheduleActivity). The previous version of
    // this handler locked the assignment row FIRST, then occurrence, then
    // schedule - the exact opposite of PATCH/DELETE's order on the same
    // three tables, a textbook lock-order inversion: two transactions each
    // holding one lock and waiting on the other's is a real PostgreSQL
    // deadlock (40P01), not just a slow race. Resolving the ids here,
    // unlocked, and re-confirming the assignment once every real lock is
    // held (below) closes that gap without ever taking a lock out of order.
    const lookup = await client.query(
      `select asg.id as assignment_id, asg.athlete_id, asg.occurrence_id, o.schedule_id
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       where asg.id = $1`,
      [req.params.assignmentId],
    );
    const lookupRow = lookup.rows[0];
    if (!lookupRow || String(lookupRow.athlete_id) !== String(athleteId)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Assignment not found." });
    }

    // Canonical lock order from here on: schedule -> occurrence ->
    // assignment -> assessment. Whichever of this transaction or a
    // concurrent PATCH/DELETE (both lock in this same order) commits first
    // is authoritative; the other only proceeds once it can take its own
    // lock, and re-checks reality below rather than trusting the unlocked
    // lookup above.
    const scheduleLockResult = await client.query(`select status from tests.test_schedules where id = $1 for update`, [lookupRow.schedule_id]);
    const scheduleStatus = scheduleLockResult.rows[0]?.status;

    const occurrenceResult = await client.query(`select * from tests.test_schedule_occurrences where id = $1 for update`, [lookupRow.occurrence_id]);
    const occurrence = occurrenceResult.rows[0];
    if (!occurrence) {
      // Lost the race against a concurrent one-time edit that safely
      // regenerated this occurrence (PATCH deletes it; on delete cascade
      // removes this assignment with it) after our unlocked lookup above but
      // before we got here - a clean 404, never a crash on a missing row.
      await client.query("rollback");
      return res.status(404).json({ error: "Assignment not found." });
    }

    const assignmentResult = await client.query(`select * from tests.test_assignments where id = $1 for update`, [lookupRow.assignment_id]);
    const assignment = assignmentResult.rows[0];
    // Re-confirm reality now that every lock is held, exactly as at the
    // unlocked lookup above - the assignment must still exist, still belong
    // to this athlete, and still point at the occurrence we just locked.
    if (!assignment || String(assignment.athlete_id) !== String(athleteId) || String(assignment.occurrence_id) !== String(lookupRow.occurrence_id)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Assignment not found." });
    }
    if (!assignment.snapshot_test_version_id) {
      await client.query("rollback");
      return res.status(400).json({ error: "This assignment is for a battery, not a single test - not supported yet." });
    }

    // Idempotent replay: the exact same submission (same idempotency key)
    // resolving to an assessment that already completed is returned as-is,
    // never treated as a second submit/correction. Scoped to THIS exact
    // assignment/athlete/test_version, not just the bare key - the key
    // column already carries a global unique index (Phase 1), so a
    // mismatched key can never collide with a genuine different row here,
    // but this extra scoping is what stops a key value that leaked or was
    // reused from ever handing back another athlete's own assessment id/
    // values/score - a lookup that only matched on idempotency_key alone
    // would return whatever row that key belongs to, regardless of who is
    // asking. Deliberately checked BEFORE the schedule-active/occurrence-open
    // gates below: a replay of an already-completed submission must still
    // succeed even if the schedule was cancelled/paused afterward - that's
    // exactly the "completed history stays fully preserved" guarantee.
    if (idempotencyKey) {
      const existing = await client.query(
        `select id from tests.test_assessments
         where idempotency_key = $1 and status = 'completed'
           and assignment_id = $2 and athlete_id = $3 and test_version_id = $4`,
        [idempotencyKey, assignment.id, athleteId, assignment.snapshot_test_version_id],
      );
      if (existing.rows[0]) {
        await client.query("commit");
        const { values: existingValues, wellnessScore } = await loadAssessmentValuesAndResult(query, existing.rows[0].id);
        return res.json({ assessmentId: existing.rows[0].id, values: existingValues, wellnessScore });
      }
    }

    // A schedule the coach cancelled/paused after this exact form was
    // already open on the athlete's screen is caught here regardless -
    // canSubmit on the GET only ever reflected the status at load time.
    if (scheduleStatus !== "active") {
      await client.query("rollback");
      return res.status(409).json({
        error: scheduleStatus === "cancelled" ? "This schedule has been cancelled." : "This schedule is currently paused.",
      });
    }

    // The real submit-time gate: the ASSIGNMENT's own window (per-athlete
    // effective timezone, snapshotted at materialization), never the
    // occurrence's shared reference window - see testsOccurrenceService.js's
    // assignmentIsOpen(). `occurrence` above is still locked/re-confirmed
    // for the lock-ordering reasons explained at step 0, even though its own
    // opens_at/closes_at no longer gate this decision.
    if (!assignmentIsOpen(assignment)) {
      await client.query("rollback");
      return res.status(409).json({ error: "This check-in window is closed." });
    }

    const parameterRows = await loadWellnessParameters((sql, params) => client.query(sql, params));
    const missing = parameterRows.filter((p) => p.is_required !== false && !Object.prototype.hasOwnProperty.call(values, p.parameter_key));
    if (missing.length) {
      await client.query("rollback");
      return res.status(400).json({ error: `Missing required answer(s): ${missing.map((p) => p.parameter_key).join(", ")}` });
    }

    const headResult = await client.query(
      `select * from tests.test_assessments
       where standalone_assignment_id = $1 and superseded_by_assessment_id is null
       order by created_at desc limit 1 for update`,
      [assignment.id],
    );
    const head = headResult.rows[0] || null;

    let assessmentId;
    if (!head || head.status === "draft") {
      if (head) {
        assessmentId = head.id;
      } else {
        const created = await client.query(
          `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, attempt_number, source, idempotency_key)
           values ($1, $2, $3, 1, 'athlete_self', $4) returning id`,
          [athleteId, assignment.snapshot_test_version_id, assignment.id, idempotencyKey],
        );
        assessmentId = created.rows[0].id;
      }
    } else if (head.status === "completed") {
      const created = await client.query(
        `insert into tests.test_assessments (athlete_id, test_version_id, assignment_id, attempt_number, source, idempotency_key, supersedes_assessment_id)
         values ($1, $2, $3, $4, 'athlete_self', $5, $6) returning id`,
        [athleteId, assignment.snapshot_test_version_id, assignment.id, head.attempt_number, idempotencyKey, head.id],
      );
      assessmentId = created.rows[0].id;
    } else {
      await client.query("rollback");
      return res.status(409).json({ error: "This assignment's latest answer is invalidated and cannot be corrected directly." });
    }

    await writeAssessmentValues(client, assessmentId, assignment.snapshot_test_version_id, parameterRows, values);
    await completeTestAssessmentWithDerivedResults(client, assessmentId);

    if (head && head.status === "completed") {
      await client.query(
        `update tests.test_assessments set status = 'invalidated', superseded_by_assessment_id = $1 where id = $2`,
        [assessmentId, head.id],
      );
    }
    if (assignment.status === "pending" || assignment.status === "open") {
      await client.query(`update tests.test_assignments set status = 'completed', completed_at = now() where id = $1`, [assignment.id]);
    }

    await client.query("commit");
    const { values: savedValues, wellnessScore } = await loadAssessmentValuesAndResult(query, assessmentId);
    res.json({ assessmentId, values: savedValues, wellnessScore });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

async function writeAssessmentValues(client, assessmentId, testVersionId, parameterRows, values) {
  for (const parameter of parameterRows) {
    if (!Object.prototype.hasOwnProperty.call(values, parameter.parameter_key)) continue;
    const raw = values[parameter.parameter_key];
    const isNumericType = parameter.value_type === "numeric" || parameter.value_type === "integer" || parameter.value_type === "ordinal";
    const valueNumeric = isNumericType ? raw : null;
    const valueBoolean = parameter.value_type === "boolean" ? raw : null;
    const valueText = parameter.value_type === "text" ? raw : null;
    await client.query(
      `insert into tests.test_assessment_values (assessment_id, test_version_id, test_parameter_id, value_numeric, value_boolean, value_text)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (assessment_id, test_parameter_id) do update set value_numeric = excluded.value_numeric, value_boolean = excluded.value_boolean, value_text = excluded.value_text, updated_at = now()`,
      [assessmentId, testVersionId, parameter.id, valueNumeric, valueBoolean, valueText],
    );
  }
}

// ------------------------------------------------------------
// Coach: Test Library (read-only)
// ------------------------------------------------------------

router.get("/library", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const clubIds = manageableClubIds(req.authz);
    const teamIds = manageableTeamIds(req.authz);
    const scopeSql = `(t.owner_scope = 'system' or (t.owner_scope = 'user' and t.owner_user_id = $1) or ($2::uuid[] is null or (t.owner_scope = 'club' and t.owner_club_id = any($2))) or ($3::uuid[] is null or (t.owner_scope = 'team' and t.owner_team_id = any($3))))`;
    const [testsResult, batteriesResult] = await Promise.all([
      query(
        `select t.id as test_id, tv.id as test_version_id, tv.name, tv.description
         from tests.test t
         join tests.test_versions tv on tv.test_id = t.id and tv.status = 'active'
         where ${scopeSql}
         order by tv.name`,
        [req.user.id, clubIds, teamIds],
      ),
      query(
        `select t.id as battery_id, tv.id as battery_version_id, tv.name, tv.description
         from tests.test_battery t
         join tests.test_battery_versions tv on tv.test_battery_id = t.id and tv.status = 'active'
         where ${scopeSql}
         order by tv.name`,
        [req.user.id, clubIds, teamIds],
      ),
    ]);
    res.json({
      tests: testsResult.rows.map((row) => ({ testId: row.test_id, testVersionId: row.test_version_id, name: row.name, description: row.description, schedulable: row.test_version_id === WELLNESS_TEST_VERSION_ID })),
      batteries: batteriesResult.rows.map((row) => ({ batteryId: row.battery_id, batteryVersionId: row.battery_version_id, name: row.name, description: row.description, schedulable: false })),
    });
  } catch (error) { next(error); }
});

// ------------------------------------------------------------
// Coach: schedules
// ------------------------------------------------------------

router.get("/schedules", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const clubIds = manageableClubIds(req.authz);
    const teamIds = manageableTeamIds(req.authz);
    const includeCancelled = text(req.query?.includeCancelled) === "true";
    const result = await query(
      `select sch.*, tv.name as test_name,
              (select count(*)::int from tests.test_schedule_targets t where t.schedule_id = sch.id and t.target_kind = 'athlete') as athlete_target_count,
              (select string_agg(tm.name, ', ' order by tm.name) from tests.test_schedule_targets t join public.teams tm on tm.id = t.target_team_id where t.schedule_id = sch.id and t.target_kind = 'team') as team_target_names,
              (select string_agg(cl.name, ', ' order by cl.name) from tests.test_schedule_targets t join public.clubs cl on cl.id = t.target_club_id where t.schedule_id = sch.id and t.target_kind = 'club') as club_target_names,
              exists (select 1 from tests.test_schedule_occurrences o where o.schedule_id = sch.id) as has_occurrences
       from tests.test_schedules sch
       join tests.test_versions tv on tv.id = sch.test_version_id
       where (sch.status <> 'cancelled' or $5::boolean)
         and (
           $4::boolean
           or (sch.owner_scope = 'user' and sch.owner_user_id = $1)
           or (sch.owner_scope = 'club' and sch.owner_club_id = any($2::uuid[]))
           or (sch.owner_scope = 'team' and sch.owner_team_id = any($3::uuid[]))
         )
       order by sch.created_at desc`,
      [req.user.id, clubIds || [], teamIds || [], isPlatformAdministrator(req.authz), includeCancelled],
    );
    res.json({ schedules: result.rows.map(formatScheduleRow) });
  } catch (error) { next(error); }
});

router.post("/schedules", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const body = req.body || {};
    if (text(body.testVersionId) !== WELLNESS_TEST_VERSION_ID) {
      return res.status(400).json({ error: "Only WELLNESS can be scheduled in this phase." });
    }
    const scheduleKindInput = text(body.scheduleKind);
    if (!VALID_SCHEDULE_KIND_INPUTS.includes(scheduleKindInput)) {
      return res.status(400).json({ error: "scheduleKind must be 'one_time' or 'daily'." });
    }
    const scheduleKind = scheduleKindInput === "daily" ? "recurring" : "one_time";
    const timezone = text(body.timezone);
    const startDate = text(body.startDate);
    const endDate = text(body.endDate) || null;
    const opensTime = text(body.opensTime);
    const dueTime = text(body.dueTime) || null;
    const closesTime = text(body.closesTime);
    if (!timezone || !startDate || !opensTime || !closesTime) {
      return res.status(400).json({ error: "Timezone, start date, opens time and closes time are required." });
    }
    const resolved = await resolveValidTargets(req, body.targets);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const resolvedRules = resolveNotificationRules(body.notificationRules);
    if (!resolvedRules.ok) return res.status(resolvedRules.status).json({ error: resolvedRules.error });

    const owner = await resolveScheduleOwnerContext(req);
    await client.query("begin");
    const schedule = await insertScheduleRow(client, { scheduleKind, timezone, startDate, endDate, opensTime, dueTime, closesTime, userId: req.user.id, owner });
    await insertTargets(client, schedule.id, resolved.targets);
    // Not a hidden backend default: the coach saw and confirmed these
    // values in the create form (see the Notifications section there) - if
    // the request omits notificationRules entirely, nothing is written and
    // this schedule stays unconfigured (the worker sends nothing for it)
    // until a coach explicitly saves rules for it.
    if (resolvedRules.rules) await replaceNotificationRules(client, schedule.id, resolvedRules.rules);
    await client.query("commit");
    res.status(201).json({ schedule: formatScheduleRow({ ...schedule, test_name: "WELLNESS" }), notificationRules: resolvedRules.rules || [] });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

// Shared by POST /schedules (create) and POST /schedules/bulk (Specific
// dates) - the one place that actually inserts a tests.test_schedules row,
// so both call sites stay byte-for-byte identical in what they write.
async function insertScheduleRow(client, { scheduleKind, timezone, startDate, endDate, opensTime, dueTime, closesTime, userId, owner }) {
  const result = await client.query(
    `insert into tests.test_schedules
       (test_version_id, schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'active', $10, $11, $12, $13, $14)
     returning *`,
    [
      WELLNESS_TEST_VERSION_ID,
      scheduleKind,
      timezone,
      startDate,
      scheduleKind === "one_time" ? (endDate || startDate) : endDate,
      scheduleKind === "recurring" ? JSON.stringify({ version: 1, freq: "daily" }) : null,
      opensTime,
      dueTime,
      closesTime,
      userId,
      owner.ownerScope,
      owner.ownerUserId,
      owner.ownerClubId,
      owner.ownerTeamId,
    ],
  );
  return result.rows[0];
}

// "Specific dates" scheduling (Phase 2.5): deliberately NOT a new recurrence
// engine or a new grouping table - a coach picking dates on a calendar just
// creates one independent one_time schedule per unique date, sharing the
// same test/time/timezone/targets, reusing resolveValidTargets and
// insertScheduleRow exactly as POST /schedules does. Every created day is
// independently editable/pausable/cancellable/deletable afterward through
// the existing single-schedule routes above - nothing about this endpoint
// is special once the rows exist.
router.post("/schedules/bulk", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const body = req.body || {};
    if (text(body.testVersionId) !== WELLNESS_TEST_VERSION_ID) {
      return res.status(400).json({ error: "Only WELLNESS can be scheduled in this phase." });
    }
    const timezone = text(body.timezone);
    const opensTime = text(body.opensTime);
    const dueTime = text(body.dueTime) || null;
    const closesTime = text(body.closesTime);
    if (!timezone || !opensTime || !closesTime) {
      return res.status(400).json({ error: "Timezone, opens time and closes time are required." });
    }

    const rawDates = Array.isArray(body.dates) ? body.dates : [];
    const seenDates = new Set();
    const dates = [];
    for (const raw of rawDates) {
      const date = text(raw);
      if (!isValidGregorianDateString(date)) {
        return res.status(400).json({ error: `"${raw}" is not a valid calendar date (expected YYYY-MM-DD).` });
      }
      // Deduped, not rejected - a coach dragging back over an already-picked
      // day on the calendar (or a double-submitted request) collapses to
      // one schedule for that date, same "same target offered twice" spirit
      // as dedupeTargets below.
      if (seenDates.has(date)) continue;
      seenDates.add(date);
      dates.push(date);
    }
    if (!dates.length) return res.status(400).json({ error: "Choose at least one date." });
    if (dates.length > MAX_BULK_DATES) {
      return res.status(400).json({ error: `Choose at most ${MAX_BULK_DATES} dates per request (received ${dates.length} unique dates).` });
    }

    // Targets are validated ONCE, up front, and reused for every date - the
    // exact same resolveValidTargets used by POST/PATCH /schedules, so a
    // bulk request is never held to a looser standard. Nothing is written
    // until every date and every target has passed.
    const resolved = await resolveValidTargets(req, body.targets);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const resolvedRules = resolveNotificationRules(body.notificationRules);
    if (!resolvedRules.ok) return res.status(resolvedRules.status).json({ error: resolvedRules.error });

    const owner = await resolveScheduleOwnerContext(req);
    await client.query("begin");
    const created = [];
    for (const date of dates) {
      const schedule = await insertScheduleRow(client, {
        scheduleKind: "one_time", timezone, startDate: date, endDate: date, opensTime, dueTime, closesTime, userId: req.user.id, owner,
      });
      await insertTargets(client, schedule.id, resolved.targets);
      // Same rule set applied to every date - configured once in the create
      // form, shared by every schedule this one bulk request creates.
      if (resolvedRules.rules) await replaceNotificationRules(client, schedule.id, resolvedRules.rules);
      created.push(schedule);
    }
    await client.query("commit");
    res.status(201).json({
      schedules: created.map((row) => formatScheduleRow({ ...row, test_name: "WELLNESS" })),
      count: created.length,
      dates: created.map((row) => row.start_date),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

async function validateTarget(req, target) {
  if (!target || !target.id) return false;
  if (target.kind === "athlete") return canAccessAthlete(query, req, target.id);
  if (target.kind === "team") return canManageTeamById(req.authz, target.id);
  if (target.kind === "club") return canManageClub(req.authz, target.id);
  return false;
}

// Dedupe by (kind, id) - the exact same athlete/team/club offered twice
// (e.g. a double-submitted form field) collapses to one target row.
// Deliberately does NOT try to dedupe an athlete who is targeted BOTH
// directly and via a team/club they belong to - those are two genuinely
// different target rows, and tests.materialize_test_assignments_for_occurrence
// (Phase 1, unmodified) already unions all three target kinds into one
// distinct athlete_id set via its own `union` (not `union all`) CTE, so a
// single INSERT ... ON CONFLICT DO NOTHING assignment is guaranteed
// regardless of how many different target rows resolve to that athlete.
function dedupeTargets(rawTargets) {
  const seen = new Set();
  const result = [];
  for (const target of Array.isArray(rawTargets) ? rawTargets : []) {
    if (!target || !["athlete", "team", "club"].includes(target.kind) || !target.id) continue;
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: target.kind, id: target.id });
  }
  return result;
}

// Shared by POST /schedules (create) and PATCH /schedules/:id (full edit) -
// the server re-validates every target's access itself, never trusting the
// client's own filtering. Returns {ok:false, status, error} on the first
// problem found (empty list or any one unauthorized target - the whole
// request is rejected, never a partial target set).
async function resolveValidTargets(req, rawTargets) {
  const targets = dedupeTargets(rawTargets);
  if (!targets.length) return { ok: false, status: 400, error: "Choose at least one athlete, team or club." };
  for (const target of targets) {
    const allowed = await validateTarget(req, target);
    if (!allowed) return { ok: false, status: 403, error: "One of the chosen targets is outside your access." };
  }
  return { ok: true, targets };
}

async function insertTargets(client, scheduleId, targets) {
  for (const target of targets) {
    await client.query(
      `insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
       values ($1, $2, $3, $4, $5)`,
      [
        scheduleId,
        target.kind,
        target.kind === "athlete" ? target.id : null,
        target.kind === "team" ? target.id : null,
        target.kind === "club" ? target.id : null,
      ],
    );
  }
}

function formatScheduleRow(row) {
  return {
    id: row.id,
    testVersionId: row.test_version_id,
    testName: row.test_name,
    scheduleKind: row.schedule_kind,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    opensTime: row.opens_time,
    dueTime: row.due_time,
    closesTime: row.closes_time,
    status: row.status,
    ownerScope: row.owner_scope,
    athleteTargetCount: row.athlete_target_count != null ? Number(row.athlete_target_count) : undefined,
    teamTargetNames: row.team_target_names || undefined,
    clubTargetNames: row.club_target_names || undefined,
    hasOccurrences: typeof row.has_occurrences === "boolean" ? row.has_occurrences : undefined,
    hasActivity: typeof row.has_activity === "boolean" ? row.has_activity : undefined,
  };
}

// Whether ANY assignment under this schedule's occurrence(s) has moved past
// pending/untouched, or has a test_assessments row at all (draft or
// completed). Shared by GET /schedules/:id (a plain, unlocked read - just
// informs the coach before they open the edit form) and PATCH's own
// edit-safety check (locked with `for update`, the real enforcement - see
// the long comment there) so both ever answer this exact same question the
// exact same way, never a GET that says "editable" while PATCH disagrees.
// executor matches the loadWellnessParameters(executor) convention already
// used elsewhere in this file: pass `query` for a plain read, or
// `(sql, params) => client.query(sql, params)` to run inside (and lock
// within) an open transaction.
async function loadScheduleActivity(executor, scheduleId, { forUpdate = false } = {}) {
  const lock = forUpdate ? " for update" : "";
  const occurrenceRows = await executor(`select id from tests.test_schedule_occurrences where schedule_id = $1${lock}`, [scheduleId]);
  if (!occurrenceRows.rowCount) return { hasOccurrence: false, hasActivity: false };
  const occurrenceIds = occurrenceRows.rows.map((row) => row.id);
  const assignmentRows = await executor(
    `select id, status, started_at from tests.test_assignments where occurrence_id = any($1::uuid[])${lock}`,
    [occurrenceIds],
  );
  const hasAssignmentActivity = assignmentRows.rows.some((row) => row.status !== "pending" || row.started_at !== null);
  let hasAssessment = false;
  if (assignmentRows.rowCount) {
    const assessmentCheck = await executor(
      `select 1 from tests.test_assessments where assignment_id = any($1::uuid[]) limit 1`,
      [assignmentRows.rows.map((row) => row.id)],
    );
    hasAssessment = assessmentCheck.rowCount > 0;
  }
  return { hasOccurrence: true, hasActivity: hasAssignmentActivity || hasAssessment };
}

async function loadManageableSchedule(req, scheduleId) {
  const result = await query(`select sch.*, tv.name as test_name from tests.test_schedules sch join tests.test_versions tv on tv.id = sch.test_version_id where sch.id = $1`, [scheduleId]);
  const schedule = result.rows[0];
  if (!schedule) return null;
  if (!canManageSchedule(req, schedule)) return null;
  return schedule;
}

router.get("/schedules/:scheduleId", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const schedule = await loadManageableSchedule(req, req.params.scheduleId);
    if (!schedule) return res.status(404).json({ error: "Schedule not found." });
    const [targetsResult, linkResult, activity, notificationRules] = await Promise.all([
      query(
        `select t.target_kind, t.target_athlete_id, t.target_team_id, t.target_club_id,
                ${athleteDisplayNameSql} as athlete_name, tm.name as team_name, cl.name as club_name
         from tests.test_schedule_targets t
         left join public.athletes a on a.id = t.target_athlete_id
         left join public.teams tm on tm.id = t.target_team_id
         left join public.clubs cl on cl.id = t.target_club_id
         where t.schedule_id = $1`,
        [schedule.id],
      ),
      query(`select id, public_token, status, created_at from tests.test_access_links where schedule_id = $1 and link_kind = 'schedule' and status = 'active'`, [schedule.id]),
      loadScheduleActivity(query, schedule.id),
      loadNotificationRules(query, schedule.id),
    ]);
    res.json({
      schedule: formatScheduleRow({ ...schedule, has_occurrences: activity.hasOccurrence, has_activity: activity.hasActivity }),
      targets: targetsResult.rows.map((row) => ({
        kind: row.target_kind,
        id: row.target_athlete_id || row.target_team_id || row.target_club_id,
        name: row.athlete_name || row.team_name || row.club_name,
      })),
      link: linkResult.rows[0] ? { id: linkResult.rows[0].id, publicToken: linkResult.rows[0].public_token, createdAt: linkResult.rows[0].created_at } : null,
      // Empty array means "never configured" (not "all disabled") - the
      // frontend uses this exact distinction to show the unconfigured state
      // for a schedule created before this phase, per the spec's explicit
      // "don't silently start sending" requirement.
      notificationRules,
    });
  } catch (error) { next(error); }
});

// Full-edit fields (targets/kind/dates/times) vs the lightweight status-only
// toggle (Pause/Activate/Cancel) - kept as two paths so the simple toggle
// never has to resend targets/dates just to flip status, while a real edit
// can still optionally include status in the same request.
const FULL_EDIT_BODY_KEYS = ["targets", "scheduleKind", "timezone", "startDate", "endDate", "opensTime", "dueTime", "closesTime"];

router.patch("/schedules/:scheduleId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const body = req.body || {};

    await client.query("begin");
    // Locks the schedule row for the rest of this transaction - a
    // concurrent PATCH/DELETE on the same schedule serializes behind this
    // one instead of racing it.
    const scheduleResult = await client.query(`select * from tests.test_schedules where id = $1 for update`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageSchedule(req, schedule)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }

    // cancelled is terminal: no status transition and no full edit is ever
    // allowed out of it - the schedule's access links were already revoked
    // and its occurrences/results already preserved-and-hidden by DELETE
    // (the only route that reaches 'cancelled'), so reactivating it here
    // would silently undo that. A coach who wants this schedule's targets
    // again creates a new one.
    if (schedule.status === "cancelled") {
      await client.query("rollback");
      return res.status(409).json({ error: "This schedule is cancelled and can no longer be edited or reactivated. Create a new schedule instead." });
    }

    // Validated up front, before either branch below, so a bad rule rolls
    // back a status-only PATCH exactly the same way it rolls back a full
    // edit - notificationRules is accepted on both, independent of
    // FULL_EDIT_BODY_KEYS (a coach adjusting only notification settings
    // shouldn't have to resend targets/dates just to trip "full edit" mode).
    const resolvedRules = resolveNotificationRules(body.notificationRules);
    if (!resolvedRules.ok) {
      await client.query("rollback");
      return res.status(resolvedRules.status).json({ error: resolvedRules.error });
    }

    const isFullEdit = FULL_EDIT_BODY_KEYS.some((key) => body[key] !== undefined);
    if (!isFullEdit) {
      // Neither a status change nor notificationRules - there's nothing in
      // this request to apply. Kept as a 400, same message as before, so a
      // truly empty/garbage PATCH still gets a clear rejection rather than
      // a silent no-op commit.
      if (body.status === undefined && resolvedRules.rules === null) {
        await client.query("rollback");
        return res.status(400).json({ error: "Invalid status - use DELETE to cancel a schedule." });
      }
      let status = schedule.status;
      if (body.status !== undefined) {
        status = text(body.status);
        // 'cancelled' is deliberately not accepted here - DELETE is the
        // only route that cancels a schedule, since cancelling also has to
        // revoke active access links (see the DELETE handler below); a
        // status-only PATCH to 'cancelled' would reach the same terminal
        // state without that side effect.
        if (!["active", "paused"].includes(status)) {
          await client.query("rollback");
          return res.status(400).json({ error: "Invalid status - use DELETE to cancel a schedule." });
        }
        await client.query(`update tests.test_schedules set status = $2, updated_at = now() where id = $1`, [schedule.id, status]);
      }
      // A coach adjusting only notification settings (no status, no full
      // edit fields) must not have to resend a status just to trip this
      // branch - see the up-front validation/comment above.
      if (resolvedRules.rules) await replaceNotificationRules(client, schedule.id, resolvedRules.rules);
      await client.query("commit");
      return res.json({ ok: true, status, notificationRules: resolvedRules.rules || undefined });
    }

    // Full edit: validate everything FIRST, write nothing until every field
    // and every target has passed - a single unauthorized target rolls
    // back the entire edit, never a partial one.
    //
    // A one_time schedule that already has its occurrence is editable IF -
    // and only if - nothing real has happened against it yet: no assignment
    // has moved past 'pending' (started_at is Phase 1's own "in progress"
    // signal) and no test_assessments row exists at all for any of its
    // assignments (draft or completed - either means the athlete has real
    // work in progress, not just an untouched invite). `for update` on the
    // assignment rows here does double duty: it's the read that decides
    // whether this edit may proceed, AND it locks those exact rows for the
    // rest of this transaction, so a concurrent POST /submit (itself
    // `select ... for update` on the same assignment row, first thing it
    // does) is forced to wait behind this transaction rather than race it -
    // whichever of the two commits first is authoritative; the other sees
    // the committed outcome once its own lock is granted (a submit that
    // loses the race sees the assignment already gone - the edit deleted
    // the occurrence, which cascades - and correctly 404s "Assignment not
    // found", never a corrupted half-state).
    //
    // When safe, the occurrence (and, via `on delete cascade`, its
    // assignments) is deleted in this same transaction - a genuinely clean
    // slate, not a patch of immutable columns the identity trigger would
    // reject anyway. Nothing is regenerated eagerly here: the existing
    // on-demand mechanism (ensureCurrentOccurrence, testsOccurrenceService.js)
    // already owns "create the correct occurrence for the schedule's
    // CURRENT date/time/targets, exactly when it's actually due" - eagerly
    // generating here would risk materializing a FUTURE date's occurrence
    // before its own date, which is exactly what that on-demand gate exists
    // to prevent.
    let regenerateOneTimeOccurrence = false;
    if (schedule.schedule_kind === "one_time") {
      const activity = await loadScheduleActivity((sql, params) => client.query(sql, params), schedule.id, { forUpdate: true });
      if (activity.hasOccurrence) {
        if (activity.hasActivity) {
          await client.query("rollback");
          return res.status(409).json({
            error: "This one-time schedule already has a started or completed response and can no longer be edited. Cancel it, then create a new schedule instead.",
            reason: "has_activity",
          });
        }
        regenerateOneTimeOccurrence = true;
      }
    }

    if (body.scheduleKind !== undefined && !VALID_SCHEDULE_KIND_INPUTS.includes(text(body.scheduleKind))) {
      await client.query("rollback");
      return res.status(400).json({ error: "scheduleKind must be 'one_time' or 'daily'." });
    }
    const scheduleKind = (body.scheduleKind !== undefined ? text(body.scheduleKind) === "daily" : schedule.schedule_kind === "recurring") ? "recurring" : "one_time";

    // A daily (recurring) schedule already generates its own occurrences one
    // day at a time, ongoing - converting it to a single one_time schedule
    // has no safe answer for "which occurrence becomes THE one_time
    // occurrence" once any exist, unlike a same-kind daily edit (which only
    // ever affects FUTURE occurrences - existing ones are left alone,
    // untouched, exactly as B2 above documents). Any occurrence at all (not
    // just real activity - stricter than the same-kind one_time edit rule
    // above) blocks a recurring->one_time conversion outright. Reuses the
    // same loadScheduleActivity helper/lock order as the one_time block
    // above rather than a second bespoke query; the two blocks can never
    // both run for the same request since schedule.schedule_kind is a single
    // fixed value.
    if (schedule.schedule_kind === "recurring" && scheduleKind === "one_time") {
      const activity = await loadScheduleActivity((sql, params) => client.query(sql, params), schedule.id, { forUpdate: true });
      if (activity.hasOccurrence) {
        await client.query("rollback");
        return res.status(409).json({
          error: "This daily schedule already has generated occurrences and can't be converted to one-time. Cancel it, then create a new one-time schedule instead.",
          reason: "recurring_has_occurrence",
        });
      }
    }

    const timezone = body.timezone !== undefined ? text(body.timezone) : schedule.timezone;
    const startDate = body.startDate !== undefined ? text(body.startDate) : schedule.start_date;
    const endDate = body.endDate !== undefined ? (text(body.endDate) || null) : schedule.end_date;
    const opensTime = body.opensTime !== undefined ? text(body.opensTime) : schedule.opens_time;
    const dueTime = body.dueTime !== undefined ? (text(body.dueTime) || null) : schedule.due_time;
    const closesTime = body.closesTime !== undefined ? text(body.closesTime) : schedule.closes_time;
    if (!timezone || !startDate || !opensTime || !closesTime) {
      await client.query("rollback");
      return res.status(400).json({ error: "Timezone, start date, opens time and closes time are required." });
    }

    let status = schedule.status;
    if (body.status !== undefined) {
      status = text(body.status);
      // Same reasoning as the status-only path above - 'cancelled' is
      // reached only through DELETE, never through PATCH (full edit
      // included), so it always carries the link-revocation side effect.
      if (!["active", "paused"].includes(status)) {
        await client.query("rollback");
        return res.status(400).json({ error: "Invalid status - use DELETE to cancel a schedule." });
      }
    }

    let resolvedTargets = null;
    if (body.targets !== undefined) {
      const resolved = await resolveValidTargets(req, body.targets);
      if (!resolved.ok) {
        await client.query("rollback");
        return res.status(resolved.status).json({ error: resolved.error });
      }
      resolvedTargets = resolved.targets;
    }

    await client.query(
      `update tests.test_schedules set
         schedule_kind = $2, timezone = $3, start_date = $4, end_date = $5,
         recurrence_rule = $6, recurrence_rule_version = 1,
         opens_time = $7, due_time = $8, closes_time = $9, status = $10, updated_at = now()
       where id = $1`,
      [
        schedule.id,
        scheduleKind,
        timezone,
        startDate,
        scheduleKind === "one_time" ? (endDate || startDate) : endDate,
        scheduleKind === "recurring" ? JSON.stringify({ version: 1, freq: "daily" }) : null,
        opensTime,
        dueTime,
        closesTime,
        status,
      ],
    );

    if (resolvedTargets) {
      // For a RECURRING schedule, existing occurrences/assignments already
      // generated under the OLD targets are never touched here - their
      // snapshot_* columns were populated once, at generation time, and
      // Phase 1's own protect_occurrence_identity/
      // protect_assignment_identity_and_lifecycle triggers make them
      // immutable afterward regardless of what this schedule row (or its
      // targets) look like now. Replacing the target rows only changes who
      // tests.materialize_test_assignments_for_occurrence resolves for
      // occurrences generated FROM THIS POINT ON ("future occurrences
      // only"). A one_time schedule's own occurrence, if any, is handled
      // separately below (regenerateOneTimeOccurrence) - it doesn't have a
      // "future" to apply to, only a single date, so its stale occurrence
      // (already proven untouched above) is deleted outright instead.
      await client.query(`delete from tests.test_schedule_targets where schedule_id = $1`, [schedule.id]);
      await insertTargets(client, schedule.id, resolvedTargets);
    }

    if (resolvedRules.rules) await replaceNotificationRules(client, schedule.id, resolvedRules.rules);

    if (regenerateOneTimeOccurrence) {
      // Cascades to test_assignments (on delete cascade, Phase 1 schema) -
      // safe because every one of those assignment rows was just locked and
      // proven 'pending'/untouched with no test_assessments row above, in
      // this same transaction. Nothing is inserted here: the next on-demand
      // call (ensureCurrentOccurrence, e.g. the next time Today is viewed -
      // by the athlete or the coach) generates a fresh occurrence from the
      // schedule row's now-current start_date/opens_time/closes_time and
      // materializes assignments from its now-current targets, exactly the
      // same as a schedule that never had an occurrence in the first place.
      await client.query(`delete from tests.test_schedule_occurrences where schedule_id = $1`, [schedule.id]);
    }

    await client.query("commit");
    const [updated, updatedActivity, updatedRules] = await Promise.all([
      query(
        `select sch.*, tv.name as test_name from tests.test_schedules sch join tests.test_versions tv on tv.id = sch.test_version_id where sch.id = $1`,
        [schedule.id],
      ),
      loadScheduleActivity(query, schedule.id),
      loadNotificationRules(query, schedule.id),
    ]);
    res.json({ schedule: formatScheduleRow({ ...updated.rows[0], has_occurrences: updatedActivity.hasOccurrence, has_activity: updatedActivity.hasActivity }), notificationRules: updatedRules });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

// DELETE decides itself between a physical delete and a safe cancel, based
// on real DB state - the frontend is never trusted to make that call.
router.delete("/schedules/:scheduleId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    await client.query("begin");
    const scheduleResult = await client.query(`select * from tests.test_schedules where id = $1 for update`, [req.params.scheduleId]);
    const schedule = scheduleResult.rows[0];
    if (!schedule || !canManageSchedule(req, schedule)) {
      await client.query("rollback");
      return res.status(404).json({ error: "Schedule not found." });
    }

    // If this schedule has never generated a single occurrence, it (and its
    // targets/access links/notification rules - all `on delete cascade`
    // from tests.test_schedules, Phase 1 schema, unmodified here) can be
    // physically removed with nothing to preserve. Any occurrence at all
    // means assignments/assessments/results may exist under it (an
    // assignment can only ever exist via an occurrence's FK) - those are
    // never deleted, only hidden behind a cancelled status.
    //
    // This FOR UPDATE lock on the schedule row (taken above) now genuinely
    // serializes against a concurrent occurrence generation:
    // tests.generate_test_schedule_occurrence() takes FOR SHARE on this same
    // row - see the CREATE OR REPLACE in migrations_v2/202608260900_tests_v42_
    // occurrence_generation_lock_fix.sql (an additive migration; the
    // already-deployed Phase 1 file itself is untouched). If a generation
    // committed first, the check below sees its occurrence and this DELETE
    // cancels instead of deleting; if this DELETE wins first and removes the
    // row (no occurrence existed), a generation call blocked behind it wakes
    // up to find the row gone and returns null - see
    // testsOccurrenceService.js's ensureCurrentOccurrence(). Both orderings
    // are covered by the J1/J2 concurrency tests in
    // backend/tests/tests-module-schedule-management.test.mjs.
    const hasOccurrence = await client.query(`select 1 from tests.test_schedule_occurrences where schedule_id = $1 limit 1`, [schedule.id]);
    if (!hasOccurrence.rowCount) {
      await client.query(`delete from tests.test_schedules where id = $1`, [schedule.id]);
      await client.query("commit");
      return res.json({ action: "deleted" });
    }

    await client.query(`update tests.test_schedules set status = 'cancelled', updated_at = now() where id = $1`, [schedule.id]);
    await client.query(
      `update tests.test_access_links set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2 where schedule_id = $1 and status = 'active'`,
      [schedule.id, req.user.id],
    );
    await client.query("commit");
    res.json({ action: "cancelled", historyPreserved: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// Coach: Today (across every active schedule this coach manages)
// ------------------------------------------------------------

router.get("/today", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const clubIds = manageableClubIds(req.authz);
    const teamIds = manageableTeamIds(req.authz);
    const schedulesResult = await query(
      `select sch.*, tv.name as test_name
       from tests.test_schedules sch
       join tests.test_versions tv on tv.id = sch.test_version_id
       where sch.status = 'active'
         and (
           $4::boolean
           or (sch.owner_scope = 'user' and sch.owner_user_id = $1)
           or (sch.owner_scope = 'club' and sch.owner_club_id = any($2))
           or (sch.owner_scope = 'team' and sch.owner_team_id = any($3))
         )
       order by sch.created_at desc`,
      [req.user.id, clubIds || [], teamIds || [], isPlatformAdministrator(req.authz)],
    );

    const groups = [];
    for (const schedule of schedulesResult.rows) {
      // Side effect only - ensures whichever occurrence(s) are currently
      // relevant (today's, and/or an adjacent day's for an athlete whose
      // own timezone diverges from the schedule's) exist. loadScheduleGroup
      // below reads assignments directly, never a single "the" occurrence
      // id, so there is nothing to gate on here anymore.
      await ensureCurrentOccurrence(pool, schedule);
      groups.push(await loadScheduleGroup(schedule));
    }
    res.json({ groups });
  } catch (error) { next(error); }
});

// Item 4 correction: no single occurrence-level window is shown as if it
// applied to every athlete anymore - there isn't one "the" occurrence for
// a schedule at any given instant once athletes can span an adjacent
// calendar day (see testsOccurrenceService.js's ensureCurrentOccurrence).
// Every assignment CURRENTLY relevant to this schedule - "current" meaning
// THIS SPECIFIC athlete's own local_scheduled_date equals their own today,
// in their own effective timezone - is pulled directly, regardless of
// which underlying occurrence row it happens to live under. anyOpen/
// allClosed summarize the group from each athlete's OWN window, never a
// shared reference instant; the frontend's own group header shows the
// schedule's wall-clock opens/closes TIME (timezone-less, already on
// `schedule`) with a fixed "in each athlete's own timezone" label instead
// of a single computed instant.
async function loadScheduleGroup(schedule) {
  const rowsResult = await query(
    `select asg.id as assignment_id, asg.status as assignment_status, asg.completed_at,
            asg.opens_at, asg.closes_at,
            a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name,
            ta.id as assessment_id, ta.status as assessment_status,
            tdr.result_numeric as wellness_score,
            inj.value_boolean as injury
     from tests.test_assignments asg
     join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
     join public.athletes a on a.id = asg.athlete_id
     left join tests.test_assessments ta on ta.standalone_assignment_id = asg.id and ta.superseded_by_assessment_id is null
     left join tests.test_assessment_derived_results tdr on tdr.assessment_id = ta.id and tdr.test_version_derived_parameter_id = $2
     left join tests.test_assessment_values inj on inj.assessment_id = ta.id and inj.test_parameter_id = $3
     where o.schedule_id = $1
       and asg.local_scheduled_date = (now() at time zone asg.timezone)::date
     order by athlete_name asc`,
    [schedule.id, WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID],
  );
  const now = new Date();
  const athletes = rowsResult.rows.map((row) => {
    const completed = row.assessment_status === "completed";
    // Per-athlete "missed" uses THAT athlete's own closes_at (their own
    // effective timezone) - never a shared reference instant, which would
    // mark every athlete under one occurrence missed at the exact same
    // moment regardless of where they actually live.
    const rowIsClosed = new Date(row.closes_at) < now;
    const missed = !completed && rowIsClosed && !["excused", "cancelled"].includes(row.assignment_status);
    const status = completed ? "completed" : missed ? "missed" : "pending";
    return {
      assignmentId: row.assignment_id,
      athleteId: row.athlete_id,
      athleteName: row.athlete_name,
      status,
      wellnessScore: row.wellness_score != null ? Number(row.wellness_score) : null,
      injury: row.injury,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
    };
  });
  const counts = {
    total: athletes.length,
    completed: athletes.filter((a) => a.status === "completed").length,
    missed: athletes.filter((a) => a.status === "missed").length,
    pending: athletes.filter((a) => a.status === "pending").length,
    injuries: athletes.filter((a) => a.injury === true).length,
  };
  // "any open"/"all closed" - a clearly-defined AGGREGATE computed from
  // each real assignment's own window, never from a single occurrence-level
  // reference window standing in for everyone.
  const anyOpen = athletes.some((a) => a.status === "pending" && new Date(a.opensAt) <= now && new Date(a.closesAt) >= now);
  const allClosed = athletes.length > 0 && athletes.every((a) => a.status !== "pending" || new Date(a.closesAt) < now);
  return {
    schedule: formatScheduleRow(schedule),
    anyOpen,
    allClosed,
    counts,
    athletes,
  };
}

// ------------------------------------------------------------
// Coach: Results
// ------------------------------------------------------------

router.get("/results", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const clubIds = manageableClubIds(req.authz);
    const teamIds = manageableTeamIds(req.authz);
    const scheduleId = text(req.query?.scheduleId) || null;
    const result = await query(
      `select ta.id as assessment_id, ta.completed_at,
              a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name,
              tdr.result_numeric as wellness_score,
              inj.value_boolean as injury,
              o.scheduled_date, sch.id as schedule_id
       from tests.test_assessments ta
       join tests.test_assignments asg on asg.id = ta.assignment_id
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_schedules sch on sch.id = o.schedule_id
       join public.athletes a on a.id = ta.athlete_id
       left join tests.test_assessment_derived_results tdr on tdr.assessment_id = ta.id and tdr.test_version_derived_parameter_id = $1
       left join tests.test_assessment_values inj on inj.assessment_id = ta.id and inj.test_parameter_id = $2
       where ta.superseded_by_assessment_id is null
         and ta.status = 'completed'
         and ta.test_version_id = $3
         and ($8::uuid is null or sch.id = $8)
         and (
           $7::boolean
           or (sch.owner_scope = 'user' and sch.owner_user_id = $4)
           or (sch.owner_scope = 'club' and sch.owner_club_id = any($5::uuid[]))
           or (sch.owner_scope = 'team' and sch.owner_team_id = any($6::uuid[]))
         )
       order by o.scheduled_date desc, athlete_name asc
       limit 300`,
      // clubIds/teamIds are separate parameters ($5/$6) - a schedule owned
      // by a club never matches against teamIds and vice versa, even if a
      // club id and a team id happen to be equal (see the K2 test below).
      // A previous version of this query merged both into one array and
      // reused it for both branches - a real authorization bug, not just a
      // style issue.
      [WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID, WELLNESS_TEST_VERSION_ID, req.user.id, clubIds || [], teamIds || [], isPlatformAdministrator(req.authz), scheduleId],
    );
    res.json({
      results: result.rows.map((row) => ({
        assessmentId: row.assessment_id,
        completedAt: row.completed_at,
        athleteId: row.athlete_id,
        athleteName: row.athlete_name,
        wellnessScore: row.wellness_score != null ? Number(row.wellness_score) : null,
        injury: row.injury,
        scheduledDate: row.scheduled_date,
        scheduleId: row.schedule_id,
      })),
    });
  } catch (error) { next(error); }
});

router.get("/results/:assessmentId", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const assessmentResult = await query(
      `select ta.*, ${athleteDisplayNameSql} as athlete_name, sch.id as schedule_id, sch.owner_scope, sch.owner_user_id, sch.owner_club_id, sch.owner_team_id
       from tests.test_assessments ta
       join public.athletes a on a.id = ta.athlete_id
       left join tests.test_assignments asg on asg.id = ta.assignment_id
       left join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       left join tests.test_schedules sch on sch.id = o.schedule_id
       where ta.id = $1`,
      [req.params.assessmentId],
    );
    const row = assessmentResult.rows[0];
    if (!row) return res.status(404).json({ error: "Result not found." });
    if (!row.schedule_id || !canManageSchedule(req, row)) return res.status(404).json({ error: "Result not found." });
    const { values, wellnessScore } = await loadAssessmentValuesAndResult(query, row.id);
    res.json({ assessmentId: row.id, athleteName: row.athlete_name, completedAt: row.completed_at, status: row.status, values, wellnessScore });
  } catch (error) { next(error); }
});

// ------------------------------------------------------------
// Coach: group access link
// ------------------------------------------------------------

router.post("/schedules/:scheduleId/link", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const schedule = await loadManageableSchedule(req, req.params.scheduleId);
    if (!schedule) {
      return res.status(404).json({ error: "Schedule not found." });
    }
    await client.query("begin");
    await client.query(`update tests.test_access_links set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2 where schedule_id = $1 and link_kind = 'schedule' and status = 'active'`, [schedule.id, req.user.id]);
    const publicToken = crypto.randomBytes(24).toString("base64url");
    const inserted = await client.query(
      `insert into tests.test_access_links (link_kind, schedule_id, auth_mode, public_token, created_by_user_id)
       values ('schedule', $1, 'authenticated_group', $2, $3) returning id, public_token, created_at`,
      [schedule.id, publicToken, req.user.id],
    );
    await client.query("commit");
    res.status(201).json({ link: { id: inserted.rows[0].id, publicToken: inserted.rows[0].public_token, createdAt: inserted.rows[0].created_at } });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    respondToWriteError(res, next, error);
  } finally {
    client.release();
  }
});

router.post("/links/:linkId/revoke", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const linkResult = await query(`select * from tests.test_access_links where id = $1`, [req.params.linkId]);
    const link = linkResult.rows[0];
    if (!link) return res.status(404).json({ error: "Link not found." });
    const schedule = link.schedule_id ? await loadManageableSchedule(req, link.schedule_id) : null;
    if (!schedule) return res.status(404).json({ error: "Link not found." });
    await query(`update tests.test_access_links set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2 where id = $1 and status = 'active'`, [link.id, req.user.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ------------------------------------------------------------
// Coach: manual reminder (hotfix - a coach-triggered nudge for whichever
// assignments they pick right now, independent of the automated
// athlete_reminder worker rule, which stays untouched and may not even be
// enabled/running for a given schedule - see testsNotificationWorker.js).
// ------------------------------------------------------------

// Every rule below mirrors an existing, already-enforced invariant
// elsewhere in this file/the DB - this route only decides who's eligible to
// receive a REMINDER right now, it invents no new submit/eligibility logic
// of its own (assignmentIsOpen/schedule.status='active' already gate real
// submission server-side regardless of what this route ever does).
const MANUAL_REMINDER_COOLDOWN_MS = 5 * 60 * 1000;

function manualReminderDedupeKey(assignmentId, cooldownBucket) {
  // Namespaced (manual_reminder:v1:...), same convention as builder.js's
  // own dedupe_key values on this SAME shared column (migrations_v2/
  // 202608280900_app_notifications_dedupe_key.sql - already deployed, a
  // plain nullable column + partial unique index, no new migration needed
  // here). Unlike that one-shot-forever use, the bucket suffix here rotates
  // every MANUAL_REMINDER_COOLDOWN_MS - a genuine resend after the cooldown
  // window gets a brand-new key and succeeds; a double-click/retry WITHIN
  // the same window collides on the unique index and is a guaranteed
  // no-op, atomically (ON CONFLICT DO NOTHING needs no extra locking to be
  // race-proof under concurrent requests - that's exactly what it's for).
  return `manual_reminder:v1:${assignmentId}:${cooldownBucket}`;
}

router.post("/schedules/:scheduleId/remind", async (req, res, next) => {
  try {
    if (!requireCoachWorkspace(req, res)) return;
    const scheduleResult = await query(
      `select sch.*, tv.name as test_name from tests.test_schedules sch join tests.test_versions tv on tv.id = sch.test_version_id where sch.id = $1`,
      [req.params.scheduleId],
    );
    const schedule = scheduleResult.rows[0];
    if (!schedule) return res.status(404).json({ error: "Schedule not found." });
    // Explicit 403 (not the info-hiding 404 most of this file's other
    // routes use for "not found or not yours") - the schedule genuinely
    // exists, the coach just isn't allowed to act on it.
    if (!canManageSchedule(req, schedule)) return res.status(403).json({ error: "Forbidden" });

    const assignmentIds = Array.isArray(req.body?.assignmentIds) ? [...new Set(req.body.assignmentIds.filter((id) => typeof id === "string" && id))] : [];
    if (!assignmentIds.length) return res.status(400).json({ error: "assignmentIds is required." });

    // Schedule-level gates - checked ONCE, not per assignment: a cancelled
    // schedule's assignments are frozen history (never remind about a
    // check-in that no longer exists in any actionable sense); a paused
    // schedule blocks NEW submissions entirely (routes/tests.js's own
    // POST /submit already enforces schedule.status==='active'), so a
    // reminder to submit would be actively misleading.
    if (schedule.status === "cancelled") return res.status(400).json({ error: "This schedule is cancelled." });
    if (schedule.status === "paused") return res.status(400).json({ error: "This schedule is paused - athletes can't submit right now, so a reminder would be pointless." });

    const rowsResult = await query(
      `select asg.id, asg.status as assignment_status, asg.closes_at,
              a.id as athlete_id, a.user_id, ${athleteDisplayNameSql} as athlete_name
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join public.athletes a on a.id = asg.athlete_id
       where o.schedule_id = $1 and asg.id = any($2::uuid[])`,
      [schedule.id, assignmentIds],
    );
    const rowsById = new Map(rowsResult.rows.map((row) => [row.id, row]));
    const now = new Date();
    const cooldownBucket = Math.floor(now.getTime() / MANUAL_REMINDER_COOLDOWN_MS);

    const results = [];
    for (const assignmentId of assignmentIds) {
      const row = rowsById.get(assignmentId);
      if (!row) {
        results.push({ assignmentId, outcome: "skippedNotFound" });
        continue;
      }
      const base = { assignmentId, athleteId: row.athlete_id, athleteName: row.athlete_name };
      if (row.assignment_status === "completed") {
        results.push({ ...base, outcome: "skippedCompleted" });
        continue;
      }
      if (["missed", "excused", "cancelled"].includes(row.assignment_status)) {
        results.push({ ...base, outcome: "skippedNotOpen" });
        continue;
      }
      if (new Date(row.closes_at) < now) {
        results.push({ ...base, outcome: "skippedClosed" });
        continue;
      }
      if (!row.user_id) {
        results.push({ ...base, outcome: "skippedNoUser" });
        continue;
      }
      const dedupeKey = manualReminderDedupeKey(assignmentId, cooldownBucket);
      const inserted = await query(
        `insert into public.app_notifications (recipient_user_id, actor_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key)
         values ($1, $2, 'test_manual_reminder', 'WELLNESS reminder', $3, 'test_assignment', $4, $5::jsonb, $6)
         on conflict (dedupe_key) where dedupe_key is not null do nothing
         returning id`,
        [
          row.user_id,
          req.user.id,
          `${schedule.test_name || "Your coach"} sent you a reminder to complete today's questionnaire.`,
          assignmentId,
          JSON.stringify({ scheduleId: schedule.id, assignmentId }),
          dedupeKey,
        ],
      );
      if (inserted.rows[0]) {
        emitRealtimeEvent(row.user_id, "notifications_changed", { notificationId: inserted.rows[0].id, type: "test_manual_reminder" });
        results.push({ ...base, outcome: "notified" });
      } else {
        results.push({ ...base, outcome: "skippedCooldown" });
      }
    }

    res.json({
      results,
      notifiedCount: results.filter((r) => r.outcome === "notified").length,
      noUserCount: results.filter((r) => r.outcome === "skippedNoUser").length,
    });
  } catch (error) { next(error); }
});

export default router;
export { WELLNESS_TEST_VERSION_ID, WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID, loadWellnessParameters, parametersForResponse, loadAssessmentValuesAndResult, writeAssessmentValues, formatScheduleRow, formatAthleteAssignmentRow, athleteDisplayNameSql };
