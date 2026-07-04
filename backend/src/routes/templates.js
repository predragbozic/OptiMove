import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes } from "../access.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const allowedScopes = new Set(["all", "my", "club", "optimove", "marketplace"]);
    const requestedScope = allowedScopes.has(String(req.query.scope || "")) ? String(req.query.scope) : "my";
    const search = text(req.query.search);
    const category = text(req.query.category);
    const tag = text(req.query.tag);
    const pricing = normalizeChoice(req.query.pricing, ["all", "free", "paid"], "all");
    const params = [req.user.id, canAccessAllAthletes(req.user), requestedScope, search, category, tag, pricing];
    const result = await query(
      `
      select ps.*,
        coalesce(
          jsonb_agg(distinct jsonb_build_object('id', t.id, 'name', t.name))
            filter (where t.id is not null),
          '[]'::jsonb
        ) as tags
      from plans.v_plan_summary ps
      join plans.plans p on p.id = ps.plan_id
      left join library.program_tags pt on pt.plan_id = p.id
      left join library.tags t on t.id = pt.tag_id and t.is_active = true
      where ps.plan_type = 'program'
        and ps.is_template = true
        and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        and ($3 = 'all' or coalesce(p.library_scope, 'my') = $3)
        and ($4 = '' or ps.plan_name ilike '%' || $4 || '%' or coalesce(ps.source_external_id, '') ilike '%' || $4 || '%')
        and ($5 = '' or coalesce(ps.library_category, '') = $5)
        and ($6 = '' or exists (
          select 1
          from library.program_tags fpt
          join library.tags ft on ft.id = fpt.tag_id
          where fpt.plan_id = p.id
            and ft.is_active = true
            and ft.name = $6
        ))
        and ($7 = 'all' or ($7 = 'free' and coalesce(ps.is_free, true)) or ($7 = 'paid' and not coalesce(ps.is_free, true)))
      group by ps.plan_id, ps.plan_type, ps.is_template, ps.plan_name, ps.status, ps.source_type, ps.source_external_id,
        ps.week_start, ps.week_end, ps.start_date, ps.valid_until, ps.duration_days, ps.program_order,
        ps.athlete_uuid, ps.athlete_id, ps.athlete_source_external_id, ps.athlete_name, ps.athlete_image_url,
        ps.block_or_day_count, ps.session_count, ps.item_count, ps.matched_exercise_count, ps.item_without_exercise_id_count,
        ps.library_scope, ps.library_category, ps.cover_image_url, ps.is_free, ps.price_cents, ps.available_until, ps.owner_type, ps.visibility
      order by coalesce(ps.library_category, 'General'), ps.source_external_id, ps.program_order nulls last, ps.plan_name
      `,
      params,
    );
    res.json({ scope: requestedScope, templates: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/options", async (req, res, next) => {
  try {
    const [categories, tags] = await Promise.all([
      query(
        `
        select distinct library_category as name
        from plans.plans p
        where p.plan_type = 'program'
          and p.is_template = true
          and coalesce(p.is_active, true)
          and nullif(trim(p.library_category), '') is not null
          and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        order by library_category
        `,
        [req.user.id, canAccessAllAthletes(req.user)],
      ),
      query(
        `
        select distinct t.name
        from library.tags t
        join library.program_tags pt on pt.tag_id = t.id
        join plans.plans p on p.id = pt.plan_id
        where t.is_active = true
          and p.plan_type = 'program'
          and p.is_template = true
          and coalesce(p.is_active, true)
          and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        order by t.name
        `,
        [req.user.id, canAccessAllAthletes(req.user)],
      ),
    ]);
    res.json({
      categories: categories.rows.map((row) => row.name).filter(Boolean),
      tags: tags.rows.map((row) => row.name).filter(Boolean),
    });
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

router.get("/:planId/tags", async (req, res, next) => {
  try {
    if (!(await canUseTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const [allTags, programTags] = await Promise.all([
      query(
        `select id, name
         from library.tags
         where is_active = true
           and exists (
             select 1
             from library.program_tags pt
             join plans.plans p on p.id = pt.plan_id
             where pt.tag_id = library.tags.id
               and p.plan_type = 'program'
               and p.is_template = true
               and coalesce(p.is_active, true)
               and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
           )
         order by name`,
        [req.user.id, canAccessAllAthletes(req.user)],
      ),
      query(
        `select t.id, t.name
         from library.program_tags pt
         join library.tags t on t.id = pt.tag_id
         where pt.plan_id = $1
           and t.is_active = true
         order by t.name`,
        [req.params.planId],
      ),
    ]);
    res.json({ tags: programTags.rows, options: allTags.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/:planId/tags", async (req, res, next) => {
  try {
    if (!(await canEditTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const name = text(req.body?.name);
    const tagId = text(req.body?.tagId);
    let finalTagId = tagId;

    if (!finalTagId) {
      if (!name) return res.status(400).json({ error: "Tag name is required." });
      finalTagId = await findOrCreateUserTag(req.user, name);
    }

    const tag = await query(
      `select id, name
       from library.tags
       where id = $1
         and is_active = true`,
      [finalTagId],
    );
    if (!tag.rows[0]) return res.status(404).json({ error: "Tag not found." });

    await query(
      `insert into library.program_tags (plan_id, tag_id)
       values ($1, $2)
       on conflict (plan_id, tag_id) do nothing`,
      [req.params.planId, finalTagId],
    );
    res.status(201).json({ tag: tag.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/:planId/tags/:tagId", async (req, res, next) => {
  try {
    if (!(await canEditTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    await query(
      `delete from library.program_tags
       where plan_id = $1 and tag_id = $2`,
      [req.params.planId, req.params.tagId],
    );
    res.json({ ok: true });
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

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `tag-${Date.now()}`;
}

async function canUseTemplate(user, planId) {
  const result = await query(
    `select 1
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and ($3::boolean or p.created_by_user_id = $2 or p.visibility = 'public')
     limit 1`,
    [planId, user.id, canAccessAllAthletes(user)],
  );
  return Boolean(result.rows[0]);
}

async function canEditTemplate(user, planId) {
  const result = await query(
    `select 1
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and ($3::boolean or p.created_by_user_id = $2)
     limit 1`,
    [planId, user.id, canAccessAllAthletes(user)],
  );
  return Boolean(result.rows[0]);
}

async function findOrCreateUserTag(user, name) {
  const existing = await query(
    `select id, is_active
     from library.tags
     where lower(name) = lower($1)
     limit 1`,
    [name],
  );
  if (existing.rows[0]?.id) {
    if (!existing.rows[0].is_active) {
      await query(`update library.tags set is_active = true, updated_at = now() where id = $1`, [existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }

  try {
    const created = await query(
      `insert into library.tags (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
       values ($1, concat($2, '-', substring(gen_random_uuid()::text from 1 for 8)), 'user', $3, $3, true)
       returning id`,
      [name, slugify(name), user.id],
    );
    return created.rows[0].id;
  } catch (error) {
    if (error?.code !== "23505") throw error;
    const fallback = await query(
      `select id
       from library.tags
       where lower(name) = lower($1)
       limit 1`,
      [name],
    );
    if (fallback.rows[0]?.id) {
      await query(`update library.tags set is_active = true, updated_at = now() where id = $1`, [fallback.rows[0].id]);
      return fallback.rows[0].id;
    }
    throw error;
  }
}

function ownerTypeForScope(scope) {
  if (scope === "club") return "club";
  if (scope === "optimove") return "optimove";
  if (scope === "marketplace") return "marketplace";
  return "coach";
}

export default router;
