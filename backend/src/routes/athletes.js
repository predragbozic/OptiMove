import { Router } from "express";
import { query } from "../db.js";
import { buildPrograms, buildWeeks } from "../utils/grouping.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const result = await query(`
      select
        athlete_uuid,
        athlete_id,
        athlete_source_external_id,
        athlete_name,
        athlete_image_url,
        count(*) filter (where plan_type = 'weekly') as weekly_plan_count,
        count(*) filter (where plan_type = 'program' and is_template = false) as program_count
      from plans.v_plan_summary
      where athlete_uuid is not null
      group by athlete_uuid, athlete_id, athlete_source_external_id, athlete_name, athlete_image_url
      order by nullif(regexp_replace(coalesce(athlete_source_external_id, athlete_id), '\\D', '', 'g'), '')::int nulls last,
               athlete_name
    `);
    res.json({
      mode: "admin",
      adminRows: result.rows.map((row) => ({
        athlete_uuid: row.athlete_uuid,
        athlete_id: row.athlete_source_external_id || row.athlete_id,
        athlete: row.athlete_name,
        athlete_image_url: row.athlete_image_url || "",
        weekly_plan_count: Number(row.weekly_plan_count || 0),
        program_count: Number(row.program_count || 0),
      })),
      rows: [],
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:athleteId/plans", async (req, res, next) => {
  try {
    const athleteId = req.params.athleteId;
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

router.get("/:athleteId/program-data", async (req, res, next) => {
  try {
    const athleteId = req.params.athleteId;
    const requestedProgram = String(req.query.program || "");

    const weeklyPlans = await query(
      `
      select *
      from plans.v_plan_summary
      where (athlete_source_external_id = $1 or athlete_id = $1)
        and plan_type = 'weekly'
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
      order by program_order nulls last, plan_name
      `,
      [athleteId],
    );

    const adminRows = await getAdminRows();
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

async function loadWeeklyData(athleteId) {
  const items = await query(
    `
    select *
    from plans.v_weekly_plan_items
    where athlete_source_external_id = $1 or athlete_id = $1
    order by week_start, date, session_order, item_order
    `,
    [athleteId],
  );
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

  const rowsByPlanId = new Map();
  items.rows.forEach((row) => {
    if (!rowsByPlanId.has(row.plan_id)) rowsByPlanId.set(row.plan_id, []);
    rowsByPlanId.get(row.plan_id).push(row);
  });
  return buildPrograms(programPlans, rowsByPlanId);
}

async function getAdminRows() {
  const result = await query(`
    select
      athlete_uuid,
      athlete_id,
      athlete_source_external_id,
      athlete_name,
      athlete_image_url
    from plans.v_plan_summary
    where athlete_uuid is not null
    group by athlete_uuid, athlete_id, athlete_source_external_id, athlete_name, athlete_image_url
    order by nullif(regexp_replace(coalesce(athlete_source_external_id, athlete_id), '\\D', '', 'g'), '')::int nulls last,
             athlete_name
  `);
  return result.rows.map((row) => ({
    athlete_id: row.athlete_source_external_id || row.athlete_id,
    athlete: row.athlete_name,
    athlete_image_url: row.athlete_image_url || "",
  }));
}

export default router;
