import { Router } from "express";
import { query } from "../db.js";
import { buildProgramData, buildWeeks } from "../utils/grouping.js";
import { canAccessPlan, isAthlete } from "../access.js";

const router = Router();

router.get("/:planId/weekly", async (req, res, next) => {
  try {
    if (!(await canAccessPlan(query, req.user, req.params.planId))) return res.status(403).json({ error: "Forbidden" });
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
    if (!(await canAccessPlan(query, req.user, req.params.planId))) return res.status(403).json({ error: "Forbidden" });
    if (await needsTemplateApproval(req.user, summary.rows[0], req.params.planId)) {
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

async function needsTemplateApproval(user, summary, planId) {
  if (!isAthlete(user)) return false;
  if (summary?.plan_type !== "program" || summary?.is_template !== true) return false;
  const access = await query(
    `select 1
     from library.program_access
     where plan_id = $1
       and user_id = $2
       and status in ('accessed', 'used', 'completed')
       and (expires_at is null or expires_at > now())
     limit 1`,
    [planId, user.id],
  );
  if (access.rowCount > 0) return false;
  const approval = await query(
    `select ($2::boolean or coalesce(ala.require_approval, true)) as approval_required
     from public.athletes a
     left join public.athlete_library_access ala on ala.athlete_id = a.id
     where coalesce(a.is_active, true)
       and (
         a.user_id = $1
         or exists (
           select 1
           from public.user_athletes ua
           where ua.user_id = $1
             and ua.athlete_id = a.id
             and ua.relationship_type = 'athlete'
             and ua.is_active = true
         )
       )
     order by a.created_at nulls last
     limit 1`,
    [user.id, summary?.requires_approval === true],
  );
  return approval.rows[0]?.approval_required === true;
}

export default router;
