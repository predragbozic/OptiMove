import { Router } from "express";
import { query } from "../db.js";
import { buildProgramData, buildWeeks } from "../utils/grouping.js";
import { canAccessPlan } from "../access.js";
import { hasTemplateAccessRecord, needsTemplateApproval } from "../programAccessPolicy.js";

const router = Router();

router.get("/:planId/weekly", async (req, res, next) => {
  try {
    if (!(await canAccessPlan(query, req, req.params.planId))) return res.status(403).json({ error: "Forbidden" });
    // Mirrors plans.v_weekly_plan_items's own internal ORDER BY exactly (see
    // migrations_v2/202608231000_weekly_plan_items_hierarchy_order.sql) -
    // same reasoning as loadWeeklyData() in athletes.js: a `select *` from a
    // view is not guaranteed pre-sorted for the caller, so this outer query
    // must re-apply the same order (day_order + hierarchy included) or the
    // view's fix would be silently undone here.
    const result = await query(
      `
      select *
      from plans.v_weekly_plan_items
      where plan_id = $1
      order by date, day_order, session_order, hierarchy_sort_path, item_order, plan_item_id, plan_node_id
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
    const canReadPlan = await canAccessPlan(query, req, req.params.planId);
    const hasAccessRecord = await hasTemplateAccessRecord(query, req, summary.rows[0], req.params.planId);
    if (!canReadPlan && !hasAccessRecord) return res.status(403).json({ error: "Forbidden" });
    if (await needsTemplateApproval(query, req, summary.rows[0], req.params.planId)) {
      return res.status(403).json({ error: "Program access requires coach approval." });
    }

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

export default router;
