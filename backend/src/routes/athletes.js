import { decorateMediaRows } from '../exerciseMedia.js';
import { decoratePlanItemEnglish } from '../planItemEnglish.js';
import { Router } from "express";
import { query } from "../db.js";
import { buildPrograms, buildWeeks } from "../utils/grouping.js";
import { canAccessAthletePlans, canViewProgramsAt } from "../access.js";
import { currentAthleteRosterScope, viewMembershipScope } from "../athleteRosterScope.js";
import { linkedSessionTimes } from "../linkedSessionTimes.js";
import { canView, coachModuleGate, viewEntryGate } from "../moduleView.js";

const router = Router();
// An athlete's code, source id or uuid in a path (a closed pattern for the programs view gate).
const ATHLETE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

// Roles V-2 (docs/ai/roles-v-steps-plan.md section 9): a view workspace (club_view / team_view) with athletes.view at its
// club or team reads the athlete list of its workspace (GET /) and nothing else here. Every other request of a view
// workspace - /today and /training-days (plan data), /:id/plans and /:id/program-data (programs.view), or any read
// without the word - is handed on unchanged (no req.moduleView), so the router answers it exactly as it did before V-2
// (the roster scope of a view workspace is `and false`; canAccessAthlete reads the old role rows only).
router.use(viewEntryGate("athletes", [{ method: "GET", path: "/" }], { refuse: (_req, _res, next) => next() }));
// Roles V-7 (docs/ai/roles-v-steps-plan.md, "V-7 design"): a view workspace with programs.view also reads ONE athlete's
// program page (GET /:athleteId/program-data), for an athlete of its club or team and with athletes.view there; any other
// request is handed on unchanged, as above. On the coach path an athlete's plan reads need programs.view (coachModuleGate
// in a club or team workspace; canAccessAthletePlans, the programs.view arrays, for the athlete).
router.use(viewEntryGate("programs", [
  { method: "GET", path: "/:athleteId/program-data", params: { athleteId: ATHLETE_CODE } },
], { refuse: (_req, _res, next) => next() }));
const programsCoachGate = coachModuleGate("programs", { allowed: canViewProgramsAt });

// Kept local, the same small validators trainingLoad.js and tests.js keep in
// their own route modules.
const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Home's calendar asks for one Monday-first month grid at a time: at most
// six weeks.
const TRAINING_DAYS_MAX_SPAN = 42;

router.get("/", async (req, res, next) => {
  try {
    const filter = await currentAthleteRosterScope(req, "a");
    const result = await query(`
      select
        a.id as athlete_uuid,
        a.athlete_id,
        a.source_external_id as athlete_source_external_id,
        coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
        a.image_url as athlete_image_url,
        coalesce(summary.weekly_plan_count, 0) as weekly_plan_count,
        coalesce(summary.program_count, 0) as program_count
      from public.athletes a
      left join (
        select
          athlete_uuid,
          count(*) filter (where plan_type = 'weekly') as weekly_plan_count,
          count(*) filter (where plan_type = 'program' and is_template = false) as program_count
        from plans.v_plan_summary
        where athlete_uuid is not null
        group by athlete_uuid
      ) summary on summary.athlete_uuid = a.id
      where coalesce(a.is_active, true)
        ${filter.sql}
      order by nullif(regexp_replace(coalesce(a.source_external_id, a.athlete_id), '\\D', '', 'g'), '')::numeric nulls last,
               athlete_name
    `, filter.params);
    // A view workspace's list carries no plan counts: they are program data (programs.view), not athletes.view.
    const viewer = req.moduleView?.module === "athletes";
    res.json({
      mode: "admin",
      adminRows: result.rows.map((row) => ({
        athlete_uuid: row.athlete_uuid,
        athlete_id: row.athlete_source_external_id || row.athlete_id,
        athlete: row.athlete_name,
        athlete_image_url: row.athlete_image_url || "",
        weekly_plan_count: viewer ? null : Number(row.weekly_plan_count || 0),
        program_count: viewer ? null : Number(row.program_count || 0),
      })),
      rows: [],
    });
  } catch (error) {
    next(error);
  }
});

// Home's day overview. Without `date` it is today by the server's own clock,
// exactly as before; with `date` (Home's calendar) the same roster and the
// same counts for that one day.
router.get("/today", async (req, res, next) => {
  try {
    const requestedDate = req.query?.date === undefined ? "" : String(req.query.date);
    if (requestedDate && !isValidGregorianDateString(requestedDate)) {
      return res.status(400).json({ error: "date must be a valid YYYY-MM-DD date." });
    }
    const filter = await currentAthleteRosterScope(req, "a");
    const params = [...filter.params];
    let dateSql = "current_date";
    if (requestedDate) {
      params.push(requestedDate);
      dateSql = `$${params.length}::date`;
    }
    const result = await query(`
      select
        a.id as athlete_uuid,
        a.athlete_id,
        a.source_external_id as athlete_source_external_id,
        coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
        a.image_url as athlete_image_url,
        coalesce(today.session_count, 0) as session_count,
        coalesce(today.item_count, 0) as item_count,
        today.plan_id,
        today.plan_name
      from public.athletes a
      left join (
        select
          athlete_uuid,
          count(distinct plan_session_id) as session_count,
          count(distinct plan_item_id) filter (where plan_item_id is not null) as item_count,
          (array_agg(plan_id order by plan_id))[1] as plan_id,
          (array_agg(plan_name order by plan_id))[1] as plan_name
        from plans.v_weekly_plan_items
        where date = ${dateSql}
        group by athlete_uuid
      ) today on today.athlete_uuid = a.id
      where coalesce(a.is_active, true)
        ${filter.sql}
      order by (today.session_count is null or today.session_count = 0) asc, athlete_name
    `, params);
    res.json({
      ...(requestedDate ? { date: requestedDate } : {}),
      rows: result.rows.map((row) => ({
        athleteUuid: row.athlete_uuid,
        athleteId: row.athlete_source_external_id || row.athlete_id,
        athlete: row.athlete_name,
        athleteImageUrl: row.athlete_image_url || "",
        planId: row.plan_id || null,
        planName: row.plan_name || "",
        sessionCount: Number(row.session_count || 0),
        itemCount: Number(row.item_count || 0),
        hasTrainingToday: Number(row.session_count || 0) > 0,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// The dots of Home's calendar: per day of [from, to], how many athletes of
// the active workspace's roster have at least one weekly-plan session that
// day. The same roster scope and the same session rule as /today, read only.
router.get("/training-days", async (req, res, next) => {
  try {
    const from = String(req.query?.from || "");
    const to = String(req.query?.to || "");
    if (!isValidGregorianDateString(from) || !isValidGregorianDateString(to)) {
      return res.status(400).json({ error: "from and to must be valid YYYY-MM-DD dates." });
    }
    if (to < from || addDaysIso(from, TRAINING_DAYS_MAX_SPAN - 1) < to) {
      return res.status(400).json({ error: `to must not be before from, and the range may cover at most ${TRAINING_DAYS_MAX_SPAN} days.` });
    }
    const filter = await currentAthleteRosterScope(req, "a");
    const params = [...filter.params, from, to];
    const result = await query(`
      select to_char(i.date, 'YYYY-MM-DD') as day, count(distinct a.id) as athlete_count
      from plans.v_weekly_plan_items i
      join public.athletes a on a.id = i.athlete_uuid
      where i.date between $${params.length - 1}::date and $${params.length}::date
        and i.plan_session_id is not null
        and coalesce(a.is_active, true)
        ${filter.sql}
      group by i.date
      order by i.date
    `, params);
    res.json({
      from,
      to,
      days: result.rows.map((row) => ({ date: row.day, athleteCount: Number(row.athlete_count || 0) })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:athleteId/plans", programsCoachGate, async (req, res, next) => {
  try {
    const athleteId = req.params.athleteId;
    if (!(await canAccessAthletePlans(query, req, athleteId))) return res.status(403).json({ error: "Forbidden" });
    const result = await query(
      `
      select *
      from plans.v_plan_summary
      where athlete_source_external_id = $1 or athlete_id = $1
      order by plan_type, week_start nulls last, program_order nulls last, plan_name
      `,
      [athleteId],
    );
    res.json({ plans: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/:athleteId/program-data", programsCoachGate, async (req, res, next) => {
  try {
    const athleteId = req.params.athleteId;
    // Roles V-7: a view workspace the programs gate let through reads the plans of an athlete of ITS club or team only,
    // and only with athletes.view there too (P-1: the page names the athlete); everything else is today's 403.
    const viewScope = req.moduleView?.module === "programs" ? req.moduleView.scope : null;
    const allowed = viewScope
      ? canView(req.authz, req.moduleView.workspace, "athletes") && await viewAthleteInScope(viewScope, athleteId)
      : await canAccessAthletePlans(query, req, athleteId);
    if (!allowed) return res.status(403).json({ error: "Forbidden" });
    const requestedProgram = String(req.query.program || "");

    // status = 'active' here (unlike GET /:athleteId/plans above, which
    // intentionally shows every status - the cross-plan-copy picker needs
    // to offer even an in-progress weekly plan as a copy source) so
    // hasWeekly reflects what loadWeeklyData() below will actually render -
    // v_weekly_plan_items itself now hides 'draft' weekly plans from the
    // Calendar until "Save and finish".
    const weeklyPlans = await query(
      `
      select *
      from plans.v_plan_summary
      where (athlete_source_external_id = $1 or athlete_id = $1)
        and plan_type = 'weekly'
        and status = 'active'
      order by week_start
      `,
      [athleteId],
    );

    const programPlans = await query(
      `
      select *
      from plans.v_plan_summary
      where (athlete_source_external_id = $1 or athlete_id = $1)
        and plan_type = 'program'
        and is_template = false
        -- Roles V-7: a view workspace never sees a draft or an archived program (P-2).
        and (not $2::boolean or coalesce(status, 'active') not in ('draft', 'archived'))
      order by program_order nulls last, plan_name
      `,
      [athleteId, Boolean(viewScope)],
    );

    const adminRows = viewScope ? await getViewAthleteRows(viewScope) : await getAdminRows(req);
    const hasWeekly = weeklyPlans.rows.length > 0;

    if (requestedProgram === "__all_programs__") {
      const programs = await loadPrograms(programPlans.rows);
      return res.json({ mode: "programsBundle", programs, adminRows, hasWeekly });
    }

    if (requestedProgram && requestedProgram !== "__weekly__") {
      const selected = programPlans.rows.find((plan) => plan.plan_name === requestedProgram);
      if (!selected) return res.status(404).json({ error: "Program not found" });
      const programs = await loadPrograms(programPlans.rows);
      const selectedProgram = programs.find((program) => program.id === selected.plan_id);
      return res.json({
        ...selectedProgram.data,
        adminRows,
        hasWeekly,
        availablePrograms: programs,
        initialProgramName: selected.plan_name,
      });
    }

    const weeklyData = hasWeekly
      ? await loadWeeklyData(athleteId)
      : { mode: "date", weeks: [], dayGroups: [], microcycles: [], rows: [] };

    if (requestedProgram === "__weekly__") {
      const availablePrograms = await loadPrograms(programPlans.rows);
      return res.json({ ...weeklyData, adminRows, hasWeekly, availablePrograms });
    }

    if (hasWeekly) {
      const availablePrograms = await loadPrograms(programPlans.rows);
      return res.json({ ...weeklyData, adminRows, hasWeekly, availablePrograms });
    }

    const programs = await loadPrograms(programPlans.rows);
    return res.json({ mode: "programs", adminRows, hasWeekly: false, programs });
  } catch (error) {
    next(error);
  }
});

// Exported for its test (central-calendar-linked-session-times, test 10).
export async function loadWeeklyData(athleteId) {
  // Mirrors plans.v_weekly_plan_items's own internal ORDER BY exactly (see
  // migrations_v2/202608231000_weekly_plan_items_hierarchy_order.sql) - a
  // `select *` from a view does NOT guarantee its rows arrive pre-sorted to
  // the caller, so this outer query must re-apply the same order, hierarchy
  // included, or the view's fix would be silently undone here. day_order is
  // included too (was missing before) as the same day_order/date pairing
  // the view itself sorts by.
  const items = await query(
    `
    select *
    from plans.v_weekly_plan_items
    where athlete_source_external_id = $1 or athlete_id = $1
    order by week_start, date, day_order, session_order, hierarchy_sort_path, item_order, plan_item_id, plan_node_id
    `,
    [athleteId],
  );
  await decorateMediaRows(items.rows,'plan_item',query);
  await decoratePlanItemEnglish(items.rows, query);
  // K3 / K2c-3: a session without its own time shows its linked event's time.
  await linkedSessionTimes({ query }, items.rows);
  return {
    mode: "date",
    weeks: buildWeeks(items.rows),
    dayGroups: [],
    microcycles: [],
    rows: items.rows,
    hasAmPm: items.rows.some((row) => row.am_pm === "AM" || row.am_pm === "PM"),
    hasBta: items.rows.some((row) => ["B", "T", "A"].includes(row.bta)),
    programLabel: "",
  };
}

async function loadPrograms(programPlans) {
  if (!programPlans.length) return [];
  const planIds = programPlans.map((plan) => plan.plan_id);
  const items = await query(
    `
    select *
    from plans.v_program_plan_items
    where plan_id = any($1::uuid[])
    order by program_order nulls last, plan_name, block_index, session_order, item_order
    `,
    [planIds],
  );

  await decorateMediaRows(items.rows,'plan_item',query);
  await decoratePlanItemEnglish(items.rows, query);
  const rowsByPlanId = new Map();
  items.rows.forEach((row) => {
    if (!rowsByPlanId.has(row.plan_id)) rowsByPlanId.set(row.plan_id, []);
    rowsByPlanId.get(row.plan_id).push(row);
  });
  return buildPrograms(programPlans, rowsByPlanId);
}

// Roles V-7: is this athlete (by code, source id or uuid) an active member of a view workspace's club or team?
async function viewAthleteInScope(scope, athleteId) {
  const filter = viewMembershipScope(scope, "a");
  const result = await query(
    `select 1 from public.athletes a
      where (a.athlete_id = $2 or a.source_external_id = $2 or a.id::text = $2) and coalesce(a.is_active, true) ${filter.sql}
      limit 1`,
    [...filter.params, String(athleteId)],
  );
  return result.rowCount > 0;
}

// The athlete chooser of a view workspace's program page: its club's or team's athletes (the same rows as V-2's list).
async function getViewAthleteRows(scope) {
  const filter = viewMembershipScope(scope, "a");
  const result = await query(`
    select a.athlete_id, a.source_external_id as athlete_source_external_id,
      coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
      a.image_url as athlete_image_url
    from public.athletes a
    where coalesce(a.is_active, true) ${filter.sql}
    order by nullif(regexp_replace(coalesce(a.source_external_id, a.athlete_id), '\\D', '', 'g'), '')::numeric nulls last, athlete_name
  `, filter.params);
  return result.rows.map((row) => ({
    athlete_id: row.athlete_source_external_id || row.athlete_id,
    athlete: row.athlete_name,
    athlete_image_url: row.athlete_image_url || "",
  }));
}

async function getAdminRows(req = null) {
  return getAthleteRows(req);
}

async function getAthleteRows(req = null) {
  const filter = await currentAthleteRosterScope(req, "a");
  const result = await query(`
    select
      a.id as athlete_uuid,
      a.athlete_id,
      a.source_external_id as athlete_source_external_id,
      coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as athlete_name,
      a.image_url as athlete_image_url
    from public.athletes a
    where coalesce(a.is_active, true)
      ${filter.sql}
    order by nullif(regexp_replace(coalesce(a.source_external_id, a.athlete_id), '\\D', '', 'g'), '')::numeric nulls last,
             athlete_name
  `, filter.params);
  return result.rows.map((row) => ({
    athlete_id: row.athlete_source_external_id || row.athlete_id,
    athlete: row.athlete_name,
    athlete_image_url: row.athlete_image_url || "",
  }));
}

export default router;
