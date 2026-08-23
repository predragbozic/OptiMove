import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { canAccessAthlete } from "../access.js";
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "../authz.js";
import { canManageSchedule, manageableClubIds, manageableTeamIds, resolveScheduleOwnerContext } from "../testsAccess.js";
import { ensureCurrentOccurrence, occurrenceIsOpen } from "../testsOccurrenceService.js";
import { completeTestAssessmentWithDerivedResults } from "../testAssessmentCalculations.js";

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

const athleteDisplayNameSql = `coalesce(a.display_name, a.full_name, nullif(concat_ws(' ', a.first_name, a.last_name), ''), a.source_external_id, a.athlete_id::text)`;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
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
    const assignmentsResult = await query(
      `select asg.*, o.opens_at, o.closes_at, o.status as occurrence_status, tv.name as test_name
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
       join tests.test_schedules sch on sch.id = o.schedule_id
       join tests.test_versions tv on tv.id = asg.snapshot_test_version_id
       where asg.athlete_id = $1
         and o.scheduled_date = (now() at time zone sch.timezone)::date
       order by o.scheduled_date desc`,
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
    const result = await query(
      `select distinct sch.id, sch.start_date, sch.opens_time, sch.timezone, tv.name as test_name
       from tests.test_schedules sch
       join tests.test_versions tv on tv.id = sch.test_version_id
       left join tests.test_schedule_targets t on t.schedule_id = sch.id
       left join public.athlete_memberships m
         on (t.target_kind = 'team' and m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active' and m.athlete_id = $1)
         or (t.target_kind = 'club' and m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active' and m.athlete_id = $1)
       where sch.status = 'active'
         and sch.schedule_kind = 'one_time'
         and sch.start_date > (now() at time zone sch.timezone)::date
         and (
           (t.target_kind = 'athlete' and t.target_athlete_id = $1)
           or (t.target_kind = 'team' and m.athlete_id = $1)
           or (t.target_kind = 'club' and m.athlete_id = $1)
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

async function loadSchedulesTargetingAthlete(athleteId, status) {
  const result = await query(
    `select distinct sch.*
     from tests.test_schedules sch
     join tests.test_schedule_targets t on t.schedule_id = sch.id
     left join public.athlete_memberships m
       on (t.target_kind = 'team' and m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active')
       or (t.target_kind = 'club' and m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active')
     where sch.status = $2
       and (
         (t.target_kind = 'athlete' and t.target_athlete_id = $1)
         or (t.target_kind = 'team' and m.athlete_id = $1)
         or (t.target_kind = 'club' and m.athlete_id = $1)
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
    occurrence: {
      id: assignment.occurrence_id,
      opensAt: assignment.opens_at,
      closesAt: assignment.closes_at,
      status: assignment.occurrence_status,
      isOpen: occurrenceIsOpen({ status: assignment.occurrence_status, opens_at: assignment.opens_at, closes_at: assignment.closes_at }),
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
      `select asg.*, o.opens_at, o.closes_at, o.status as occurrence_status, tv.id as test_version_id, tv.name as test_name, tv.description as test_description,
              a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name
       from tests.test_assignments asg
       join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
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

    const isOpen = occurrenceIsOpen({ status: assignment.occurrence_status, opens_at: assignment.opens_at, closes_at: assignment.closes_at });
    res.json({
      assignment: {
        id: assignment.id,
        status: assignment.status,
        occurrence: { id: assignment.occurrence_id, opensAt: assignment.opens_at, closesAt: assignment.closes_at, status: assignment.occurrence_status, isOpen },
        athlete: { id: assignment.athlete_id, name: assignment.athlete_name },
      },
      testVersion: { id: assignment.test_version_id, name: assignment.test_name, description: assignment.test_description },
      parameters: parametersForResponse(parameterRows),
      latestAssessment,
      canSubmit: isOpen,
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

    const assignmentResult = await client.query(`select * from tests.test_assignments where id = $1 for update`, [req.params.assignmentId]);
    const assignment = assignmentResult.rows[0];
    if (!assignment) {
      await client.query("rollback");
      return res.status(404).json({ error: "Assignment not found." });
    }
    if (String(assignment.athlete_id) !== String(athleteId)) {
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
    // asking.
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

    const occurrenceResult = await client.query(`select * from tests.test_schedule_occurrences where id = $1 for update`, [assignment.occurrence_id]);
    const occurrence = occurrenceResult.rows[0];
    if (!occurrenceIsOpen(occurrence)) {
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

    const owner = await resolveScheduleOwnerContext(req);
    await client.query("begin");
    const scheduleResult = await client.query(
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
        req.user.id,
        owner.ownerScope,
        owner.ownerUserId,
        owner.ownerClubId,
        owner.ownerTeamId,
      ],
    );
    const schedule = scheduleResult.rows[0];
    await insertTargets(client, schedule.id, resolved.targets);
    await client.query("commit");
    res.status(201).json({ schedule: formatScheduleRow({ ...schedule, test_name: undefined }) });
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
  };
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
    const [targetsResult, linkResult, occurrenceResult] = await Promise.all([
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
      query(`select 1 from tests.test_schedule_occurrences where schedule_id = $1 limit 1`, [schedule.id]),
    ]);
    res.json({
      schedule: formatScheduleRow({ ...schedule, has_occurrences: occurrenceResult.rowCount > 0 }),
      targets: targetsResult.rows.map((row) => ({
        kind: row.target_kind,
        id: row.target_athlete_id || row.target_team_id || row.target_club_id,
        name: row.athlete_name || row.team_name || row.club_name,
      })),
      link: linkResult.rows[0] ? { id: linkResult.rows[0].id, publicToken: linkResult.rows[0].public_token, createdAt: linkResult.rows[0].created_at } : null,
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

    const isFullEdit = FULL_EDIT_BODY_KEYS.some((key) => body[key] !== undefined);
    if (!isFullEdit) {
      const status = text(body.status);
      // 'cancelled' is deliberately not accepted here - DELETE is the only
      // route that cancels a schedule, since cancelling also has to revoke
      // active access links (see the DELETE handler below); a status-only
      // PATCH to 'cancelled' would reach the same terminal state without
      // that side effect.
      if (!["active", "paused"].includes(status)) {
        await client.query("rollback");
        return res.status(400).json({ error: "Invalid status - use DELETE to cancel a schedule." });
      }
      await client.query(`update tests.test_schedules set status = $2, updated_at = now() where id = $1`, [schedule.id, status]);
      await client.query("commit");
      return res.json({ ok: true, status });
    }

    // Full edit: validate everything FIRST, write nothing until every field
    // and every target has passed - a single unauthorized target rolls
    // back the entire edit, never a partial one.
    if (schedule.schedule_kind === "one_time") {
      const hasOccurrence = await client.query(`select 1 from tests.test_schedule_occurrences where schedule_id = $1 limit 1`, [schedule.id]);
      if (hasOccurrence.rowCount) {
        await client.query("rollback");
        return res.status(409).json({ error: "This one-time schedule already has its occurrence and can no longer be edited - cancel or delete it instead." });
      }
    }

    if (body.scheduleKind !== undefined && !VALID_SCHEDULE_KIND_INPUTS.includes(text(body.scheduleKind))) {
      await client.query("rollback");
      return res.status(400).json({ error: "scheduleKind must be 'one_time' or 'daily'." });
    }
    const scheduleKind = (body.scheduleKind !== undefined ? text(body.scheduleKind) === "daily" : schedule.schedule_kind === "recurring") ? "recurring" : "one_time";
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
      // Existing occurrences/assignments already generated under the OLD
      // targets are never touched here - their snapshot_* columns were
      // populated once, at generation time, and Phase 1's own
      // protect_occurrence_identity/protect_assignment_identity_and_lifecycle
      // triggers make them immutable afterward regardless of what this
      // schedule row (or its targets) look like now. Replacing the target
      // rows only changes who tests.materialize_test_assignments_for_occurrence
      // resolves for occurrences generated FROM THIS POINT ON.
      await client.query(`delete from tests.test_schedule_targets where schedule_id = $1`, [schedule.id]);
      await insertTargets(client, schedule.id, resolvedTargets);
    }

    await client.query("commit");
    const updated = await query(
      `select sch.*, tv.name as test_name, exists (select 1 from tests.test_schedule_occurrences o where o.schedule_id = sch.id) as has_occurrences
       from tests.test_schedules sch join tests.test_versions tv on tv.id = sch.test_version_id where sch.id = $1`,
      [schedule.id],
    );
    res.json({ schedule: formatScheduleRow(updated.rows[0]) });
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
      const occurrenceId = await ensureCurrentOccurrence(pool, schedule);
      if (!occurrenceId) {
        groups.push({ schedule: formatScheduleRow(schedule), occurrence: null, counts: null, athletes: [] });
        continue;
      }
      groups.push(await loadOccurrenceGroup(schedule, occurrenceId));
    }
    res.json({ groups });
  } catch (error) { next(error); }
});

async function loadOccurrenceGroup(schedule, occurrenceId) {
  const occurrenceResult = await query(`select * from tests.test_schedule_occurrences where id = $1`, [occurrenceId]);
  const occurrence = occurrenceResult.rows[0];
  const rowsResult = await query(
    `select asg.id as assignment_id, asg.status as assignment_status, asg.completed_at,
            a.id as athlete_id, ${athleteDisplayNameSql} as athlete_name,
            ta.id as assessment_id, ta.status as assessment_status,
            tdr.result_numeric as wellness_score,
            inj.value_boolean as injury
     from tests.test_assignments asg
     join public.athletes a on a.id = asg.athlete_id
     left join tests.test_assessments ta on ta.standalone_assignment_id = asg.id and ta.superseded_by_assessment_id is null
     left join tests.test_assessment_derived_results tdr on tdr.assessment_id = ta.id and tdr.test_version_derived_parameter_id = $2
     left join tests.test_assessment_values inj on inj.assessment_id = ta.id and inj.test_parameter_id = $3
     where asg.occurrence_id = $1
     order by athlete_name asc`,
    [occurrenceId, WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID],
  );
  const isOpen = occurrenceIsOpen(occurrence);
  const isClosed = new Date(occurrence.closes_at) < new Date();
  const athletes = rowsResult.rows.map((row) => {
    const completed = row.assessment_status === "completed";
    const missed = !completed && isClosed && !["excused", "cancelled"].includes(row.assignment_status);
    const status = completed ? "completed" : missed ? "missed" : "pending";
    return {
      assignmentId: row.assignment_id,
      athleteId: row.athlete_id,
      athleteName: row.athlete_name,
      status,
      wellnessScore: row.wellness_score != null ? Number(row.wellness_score) : null,
      injury: row.injury,
    };
  });
  const counts = {
    total: athletes.length,
    completed: athletes.filter((a) => a.status === "completed").length,
    missed: athletes.filter((a) => a.status === "missed").length,
    pending: athletes.filter((a) => a.status === "pending").length,
    injuries: athletes.filter((a) => a.injury === true).length,
  };
  return {
    schedule: formatScheduleRow(schedule),
    occurrence: { id: occurrence.id, scheduledDate: occurrence.scheduled_date, opensAt: occurrence.opens_at, closesAt: occurrence.closes_at, status: occurrence.status, isOpen },
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

export default router;
export { WELLNESS_TEST_VERSION_ID, WELLNESS_TOTAL_DERIVED_PARAMETER_ID, WELLNESS_INJURY_PARAMETER_ID, loadWellnessParameters, parametersForResponse, loadAssessmentValuesAndResult, writeAssessmentValues, formatScheduleRow, formatAthleteAssignmentRow, athleteDisplayNameSql };
