import { decorateMediaRows } from '../exerciseMedia.js';
import { decoratePlanItemEnglish } from '../planItemEnglish.js';
import { Router } from "express";
import { query } from "../db.js";
import { buildProgramData, buildWeeks } from "../utils/grouping.js";
import { canAccessPlan, canViewProgramsAt } from "../access.js";
import { hasTemplateAccessRecord, isPublicLibraryTemplate, needsTemplateApproval } from "../programAccessPolicy.js";
import { linkedSessionTimes } from "../linkedSessionTimes.js";
import { coachModuleGate, handOnReadsRefuseWrites, viewEntryGate } from "../moduleView.js";

const router = Router();

// Roles V-7 (docs/ai/roles-v-steps-plan.md, "V-7 design"): a view workspace with programs.view opens a public Program
// Library template's program (GET /:planId/program) and nothing else here; a missing id and one it may not open answer
// the same 403. An unlisted read (/:planId/weekly) is handed on and answers as before. In a club or team workspace the
// module needs programs.view there (coachModuleGate, R4 section 6).
router.use(viewEntryGate("programs", [{ method: "GET", path: "/:planId/program" }], { refuse: handOnReadsRefuseWrites }));
router.use(coachModuleGate("programs", { allowed: canViewProgramsAt }));

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
    await decorateMediaRows(result.rows,'plan_item',query);
    await decoratePlanItemEnglish(result.rows, query);
    // K3 / K2c-3: a session without its own time shows its linked event's time.
    await linkedSessionTimes({ query }, result.rows);
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
    if (req.moduleView?.module === "programs") {
      if (!(await isPublicLibraryTemplate(query, req.params.planId))) return res.status(403).json({ error: "Forbidden" });
      const viewSummary = await query("select * from plans.v_plan_summary where plan_id = $1", [req.params.planId]);
      if (!viewSummary.rows.length) return res.status(403).json({ error: "Forbidden" });
      return res.json(await programAnswer(viewSummary.rows[0], req.params.planId));
    }
    const summary = await query("select * from plans.v_plan_summary where plan_id = $1", [req.params.planId]);
    if (!summary.rows.length) return res.status(404).json({ error: "Plan not found" });
    const canReadPlan = await canAccessPlan(query, req, req.params.planId);
    const hasAccessRecord = await hasTemplateAccessRecord(query, req, summary.rows[0], req.params.planId);
    if (!canReadPlan && !hasAccessRecord) return res.status(403).json({ error: "Forbidden" });
    if (await needsTemplateApproval(query, req, summary.rows[0], req.params.planId)) {
      return res.status(403).json({ error: "Program access requires coach approval." });
    }

    res.json(await programAnswer(summary.rows[0], req.params.planId));
  } catch (error) {
    next(error);
  }
});

async function programAnswer(summaryRow, planId) {
  const items = await query(
    `
    select *
    from plans.v_program_plan_items
    where plan_id = $1
    order by block_index, session_order, item_order
    `,
    [planId],
  );
  await decorateMediaRows(items.rows,'plan_item',query);
  await decoratePlanItemEnglish(items.rows, query);
  return buildProgramData(summaryRow, items.rows);
}

export default router;
