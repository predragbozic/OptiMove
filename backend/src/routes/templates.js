import { Router } from "express";
import { query } from "../db.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const result = await query(`
      select *
      from plans.v_plan_summary
      where plan_type = 'program'
        and is_template = true
      order by source_external_id, program_order nulls last, plan_name
    `);
    res.json({ templates: result.rows });
  } catch (error) {
    next(error);
  }
});

export default router;
