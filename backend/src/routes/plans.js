import { Router } from "express";
import { query } from "../db.js";
import { buildProgramData, buildWeeks } from "../utils/grouping.js";

const router = Router();

router.get("/:planId/weekly", async (req, res, next) => {
  try {
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
