import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes } from "../access.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const allowedScopes = new Set(["my", "club", "optimove", "marketplace"]);
    const requestedScope = allowedScopes.has(String(req.query.scope || "")) ? String(req.query.scope) : "my";
    const params = [req.user.id, canAccessAllAthletes(req.user), requestedScope];
    const result = await query(
      `
      select ps.*
      from plans.v_plan_summary ps
      join plans.plans p on p.id = ps.plan_id
      where ps.plan_type = 'program'
        and ps.is_template = true
        and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        and coalesce(p.library_scope, 'my') = $3
      order by coalesce(ps.library_category, 'General'), ps.source_external_id, ps.program_order nulls last, ps.plan_name
      `,
      params,
    );
    res.json({ scope: requestedScope, templates: result.rows });
  } catch (error) {
    next(error);
  }
});

export default router;
