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

router.patch("/:planId/metadata", async (req, res, next) => {
  try {
    const planId = req.params.planId;
    const canEdit = await query(
      `
      select 1
      from plans.plans p
      where p.id = $1
        and p.plan_type = 'program'
        and p.is_template = true
        and ($3::boolean or p.created_by_user_id = $2)
      limit 1
      `,
      [planId, req.user.id, canAccessAllAthletes(req.user)],
    );
    if (!canEdit.rowCount) return res.status(404).json({ error: "Template not found." });

    const scope = normalizeChoice(req.body?.libraryScope, ["my", "club", "optimove", "marketplace"], "my");
    const ownerType = normalizeChoice(req.body?.ownerType, ["coach", "club", "optimove", "marketplace"], ownerTypeForScope(scope));
    const isFree = req.body?.isFree !== false && req.body?.isFree !== "false";
    const priceCents = isFree ? null : Math.max(0, Math.round(Number(req.body?.priceCents || 0)));
    const result = await query(
      `
      update plans.plans
      set library_scope = $2,
          library_category = nullif(trim($3), ''),
          cover_image_url = nullif(trim($4), ''),
          is_free = $5,
          price_cents = $6,
          available_until = nullif($7, '')::date,
          owner_type = $8,
          visibility = $9,
          updated_at = now()
      where id = $1
      returning id
      `,
      [
        planId,
        scope,
        text(req.body?.libraryCategory),
        text(req.body?.coverImageUrl),
        isFree,
        priceCents,
        text(req.body?.availableUntil),
        ownerType,
        normalizeChoice(req.body?.visibility, ["private", "team", "club", "public"], "private"),
      ],
    );
    res.json({ ok: true, planId: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

function text(value) {
  return String(value ?? "").trim();
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = text(value).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function ownerTypeForScope(scope) {
  if (scope === "club") return "club";
  if (scope === "optimove") return "optimove";
  if (scope === "marketplace") return "marketplace";
  return "coach";
}

export default router;
