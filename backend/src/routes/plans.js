import { Router } from "express";
import { query } from "../db.js";
import { buildProgramData, buildWeeks } from "../utils/grouping.js";

const router = Router();

router.get("/:planId/weekly", async (req, res, next) => {
  try {
    if (!(await canAccessPlan(req.user, req.params.planId))) return res.status(403).json({ error: "Forbidden" });
    const result = await query(
      `
      select *
      from plans.v_weekly_plan_items
      where plan_id = $1
      order by date, session_order, item_order
      `,
      [req.params.planId],
    );
    res.json({
      mode: "date",
      weeks: buildWeeks(result.rows),
      rows: result.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:planId/program", async (req, res, next) => {
  try {
    const summary = await query("select * from plans.v_plan_summary where plan_id = $1", [req.params.planId]);
    if (!summary.rows.length) return res.status(404).json({ error: "Plan not found" });
    if (!(await canAccessPlan(req.user, req.params.planId))) return res.status(403).json({ error: "Forbidden" });

    const items = await query(
      `
      select *
      from plans.v_program_plan_items
      where plan_id = $1
      order by block_index, session_order, item_order
      `,
      [req.params.planId],
    );
    res.json(buildProgramData(summary.rows[0], items.rows));
  } catch (error) {
    next(error);
  }
});

async function canAccessPlan(user, planId) {
  if (!user) return false;
  if (user.role_hint !== "athlete") return true;
  const result = await query(
    `
    select 1
    from plans.v_plan_summary ps
    join public.athletes a on a.id = ps.athlete_uuid
    left join public.user_athletes ua on ua.athlete_id = a.id and ua.is_active = true
    where ps.plan_id = $1
      and (a.user_id = $2 or ua.user_id = $2)
    limit 1
    `,
    [planId, user.id],
  );
  return result.rowCount > 0;
}

export default router;
