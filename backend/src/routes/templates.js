import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes } from "../access.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const params = [req.user.id, canAccessAllAthletes(req.user)];
    const result = await query(
      `
      select ps.*
      from plans.v_plan_summary ps
      join plans.plans p on p.id = ps.plan_id
      where ps.plan_type = 'program'
        and ps.is_template = true
        and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
      order by ps.source_external_id, ps.program_order nulls last, ps.plan_name
      `,
      params,
    );
    res.json({ templates: result.rows });
  } catch (error) {
    next(error);
  }
});

export default router;
