import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes } from "../access.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const allowedScopes = new Set(["all", "workspace", "my", "club", "optimove", "marketplace"]);
    const requestedScope = allowedScopes.has(String(req.query.scope || "")) ? String(req.query.scope) : "my";
    const search = text(req.query.search);
    const category = text(req.query.category);
    const tag = text(req.query.tag);
    const pricing = normalizeChoice(req.query.pricing, ["all", "free", "paid"], "all");
    const athleteAccess = await loadAthleteLibraryAccess(req.user);
    const params = [
      req.user.id,
      canAccessAllAthletes(req.user),
      requestedScope,
      search,
      category,
      tag,
      pricing,
      Boolean(athleteAccess),
      athleteAccess?.athlete_id || null,
      athleteAccess?.can_view_coach_library === true,
      athleteAccess?.can_view_club_library === true,
      athleteAccess?.can_view_optimove_library === true,
      athleteAccess?.can_view_marketplace === true,
      athleteAccess?.free_only !== false,
    ];
    const result = await query(
      `
      select ps.*,
        p.created_by_user_id,
        coalesce(nullif(creator.display_name, ''), nullif(creator.full_name, ''), creator.email) as creator_name,
        creator.email as creator_email,
        coalesce(creator_clubs.club_ids, '[]'::jsonb) as creator_club_ids,
        coalesce(creator_clubs.club_names, '') as creator_club_names,
        reviews.average_rating,
        coalesce(reviews.review_count, 0)::int as review_count,
        coalesce(
          jsonb_agg(distinct jsonb_build_object('id', t.id, 'name', t.name))
            filter (where t.id is not null),
          '[]'::jsonb
        ) as tags
      from plans.v_plan_summary ps
      join plans.plans p on p.id = ps.plan_id
      left join public.users creator on creator.id = p.created_by_user_id
      left join lateral (
        select
          jsonb_agg(distinct c.id) filter (where c.id is not null) as club_ids,
          string_agg(distinct c.name, ', ' order by c.name) filter (where c.id is not null) as club_names
        from public.user_club_roles ucr
        join public.clubs c on c.id = ucr.club_id and coalesce(c.is_active, true)
        where ucr.user_id = p.created_by_user_id
          and ucr.is_active = true
      ) creator_clubs on true
      left join lateral (
        select round(avg(pr.rating)::numeric, 1) as average_rating,
               count(*)::int as review_count
        from library.program_reviews pr
        where pr.plan_id = p.id
          and pr.status = 'published'
      ) reviews on true
      left join library.program_tags pt on pt.plan_id = p.id
      left join library.program_tag_definitions t on t.id = pt.tag_id and t.is_active = true
      where ps.plan_type = 'program'
        and ps.is_template = true
        and (
          (not $8::boolean and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public'))
          or (
            $8::boolean
            and coalesce(ps.athlete_can_view_directly, false)
            and (not $14::boolean or coalesce(ps.is_free, true))
            and (
              (coalesce(p.library_scope, 'my') = 'my' and $10::boolean and exists (
                select 1
                from public.user_athletes coach_rel
                where coach_rel.athlete_id = $9
                  and coach_rel.user_id = p.created_by_user_id
                  and coach_rel.relationship_type = 'coach'
                  and coach_rel.is_active = true
              ))
              or (coalesce(p.library_scope, 'my') = 'club' and $11::boolean and p.visibility in ('club', 'public'))
              or (coalesce(p.library_scope, 'my') = 'optimove' and $12::boolean and p.visibility = 'public')
              or (coalesce(p.library_scope, 'my') = 'marketplace' and $13::boolean and p.visibility = 'public')
            )
          )
        )
        and ($3 = 'all' or coalesce(p.library_scope, 'my') = $3)
        and ($4 = '' or ps.plan_name ilike '%' || $4 || '%' or coalesce(ps.source_external_id, '') ilike '%' || $4 || '%')
        and ($5 = '' or coalesce(ps.library_category, '') = $5)
        and ($6 = '' or exists (
          select 1
          from library.program_tags fpt
          join library.program_tag_definitions ft on ft.id = fpt.tag_id
          where fpt.plan_id = p.id
            and ft.is_active = true
            and ft.name ilike '%' || $6 || '%'
        ))
        and ($7 = 'all' or ($7 = 'free' and coalesce(ps.is_free, true)) or ($7 = 'paid' and not coalesce(ps.is_free, true)))
      group by ps.plan_id, ps.plan_type, ps.is_template, ps.plan_name, ps.status, ps.source_type, ps.source_external_id,
        ps.week_start, ps.week_end, ps.start_date, ps.valid_until, ps.duration_days, ps.program_order,
        ps.athlete_uuid, ps.athlete_id, ps.athlete_source_external_id, ps.athlete_name, ps.athlete_image_url,
        ps.block_or_day_count, ps.session_count, ps.item_count, ps.matched_exercise_count, ps.item_without_exercise_id_count,
        ps.library_scope, ps.library_category, ps.cover_image_url, ps.is_free, ps.price_cents, ps.available_until, ps.owner_type, ps.visibility,
        ps.access_model, ps.access_duration_days, ps.subscription_period, ps.can_copy, ps.can_edit_copy, ps.can_assign_to_athlete,
        ps.athlete_can_view_directly, ps.requires_approval,
        p.created_by_user_id, creator.display_name, creator.full_name, creator.email, creator_clubs.club_ids, creator_clubs.club_names,
        reviews.average_rating, reviews.review_count
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
    const [categories, tags, creators, clubs] = await Promise.all([
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
        from library.program_tag_definitions t
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
      query(
        `
        select distinct
          p.created_by_user_id as id,
          coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email) as name,
          u.email
        from plans.plans p
        join public.users u on u.id = p.created_by_user_id
        where p.plan_type = 'program'
          and p.is_template = true
          and coalesce(p.is_active, true)
          and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        order by name, u.email
        `,
        [req.user.id, canAccessAllAthletes(req.user)],
      ),
      query(
        `
        select distinct c.id, c.name
        from plans.plans p
        join public.user_club_roles ucr on ucr.user_id = p.created_by_user_id and ucr.is_active = true
        join public.clubs c on c.id = ucr.club_id and coalesce(c.is_active, true)
        where p.plan_type = 'program'
          and p.is_template = true
          and coalesce(p.is_active, true)
          and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public')
        order by c.name
        `,
        [req.user.id, canAccessAllAthletes(req.user)],
      ),
    ]);
    res.json({
      categories: categories.rows.map((row) => row.name).filter(Boolean),
      tags: tags.rows.map((row) => row.name).filter(Boolean),
      creators: creators.rows,
      clubs: clubs.rows,
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

    const scope = normalizeChoice(req.body?.libraryScope, ["workspace", "my", "club", "optimove", "marketplace"], "my");
    const ownerType = normalizeChoice(req.body?.ownerType, ["coach", "club", "optimove", "marketplace"], ownerTypeForScope(scope));
    const isFree = req.body?.isFree !== false && req.body?.isFree !== "false";
    const priceCents = isFree ? null : Math.max(0, Math.round(Number(req.body?.priceCents || 0)));
    const accessModel = normalizeChoice(
      req.body?.accessModel,
      ["free_forever", "one_time_forever", "time_limited", "subscription", "assigned", "trial"],
      isFree ? "free_forever" : "one_time_forever",
    );
    const accessDurationDays = positiveIntegerOrNull(req.body?.accessDurationDays);
    const subscriptionPeriod = accessModel === "subscription"
      ? normalizeChoice(req.body?.subscriptionPeriod, ["month", "year"], "month")
      : null;
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
          access_model = $10,
          access_duration_days = $11,
          subscription_period = $12,
          can_copy = $13,
          can_edit_copy = $14,
          can_assign_to_athlete = $15,
          athlete_can_view_directly = $16,
          requires_approval = $17,
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
        accessModel,
        accessDurationDays,
        subscriptionPeriod,
        booleanValue(req.body?.canCopy, true),
        booleanValue(req.body?.canEditCopy, true),
        booleanValue(req.body?.canAssignToAthlete, true),
        booleanValue(req.body?.athleteCanViewDirectly, false),
        booleanValue(req.body?.requiresApproval, false),
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
         from library.program_tag_definitions
         where is_active = true
           and exists (
             select 1
             from library.program_tags pt
             join plans.plans p on p.id = pt.plan_id
             where pt.tag_id = library.program_tag_definitions.id
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
         join library.program_tag_definitions t on t.id = pt.tag_id
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

router.get("/:planId/reviews", async (req, res, next) => {
  try {
    if (!(await canUseTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const result = await query(
      `select pr.id,
              pr.rating,
              pr.comment,
              pr.is_verified,
              pr.verification_type,
              pr.updated_at,
              pr.created_at,
              coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email, 'User') as reviewer_name
       from library.program_reviews pr
       left join public.users u on u.id = pr.reviewer_user_id
       where pr.plan_id = $1
         and pr.status = 'published'
       order by pr.updated_at desc, pr.created_at desc
       limit 30`,
      [req.params.planId],
    );
    res.json({ reviews: result.rows });
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
      finalTagId = await findOrCreateProgramTag(req.user, name);
    }

    const tag = await query(
      `select id, name
       from library.program_tag_definitions
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

router.post("/:planId/use", async (req, res, next) => {
  try {
    if (!(await canUseTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const access = await markProgramUsed(req.user, req.params.planId, text(req.body?.note));
    res.json({ access });
  } catch (error) {
    next(error);
  }
});

router.post("/:planId/reviews", async (req, res, next) => {
  try {
    if (!(await canUseTemplate(req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const access = await requireUsedProgramAccess(req.user, req.params.planId);
    if (!access) {
      return res.status(403).json({ error: "Use this program before leaving a review." });
    }
    const rating = Number.parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }
    const review = await query(
      `insert into library.program_reviews (plan_id, reviewer_user_id, rating, comment, status, is_verified, verified_access_id, verification_type)
       values ($1, $2, $3, nullif(trim($4), ''), 'published', true, $5, $6)
       on conflict (plan_id, reviewer_user_id)
       where reviewer_user_id is not null
       do update set rating = excluded.rating,
                     comment = excluded.comment,
                     status = 'published',
                     is_verified = true,
                     verified_access_id = excluded.verified_access_id,
                     verification_type = excluded.verification_type,
                     updated_at = now()
       returning id, rating, comment, status, is_verified, verification_type, updated_at`,
      [req.params.planId, req.user.id, rating, text(req.body?.comment), access.id, access.access_type],
    );
    res.status(201).json({ review: review.rows[0] });
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
  if (result.rows[0]) return true;

  const athleteAccess = await loadAthleteLibraryAccess(user);
  if (!athleteAccess) return false;
  const athleteResult = await query(
    `select 1
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and coalesce(p.athlete_can_view_directly, false)
       and (not $7::boolean or coalesce(p.is_free, true))
       and (
         (coalesce(p.library_scope, 'my') = 'my' and $3::boolean and exists (
           select 1
           from public.user_athletes coach_rel
           where coach_rel.athlete_id = $2
             and coach_rel.user_id = p.created_by_user_id
             and coach_rel.relationship_type = 'coach'
             and coach_rel.is_active = true
         ))
         or (coalesce(p.library_scope, 'my') = 'club' and $4::boolean and p.visibility in ('club', 'public'))
         or (coalesce(p.library_scope, 'my') = 'optimove' and $5::boolean and p.visibility = 'public')
         or (coalesce(p.library_scope, 'my') = 'marketplace' and $6::boolean and p.visibility = 'public')
       )
     limit 1`,
    [
      planId,
      athleteAccess.athlete_id,
      athleteAccess.can_view_coach_library === true,
      athleteAccess.can_view_club_library === true,
      athleteAccess.can_view_optimove_library === true,
      athleteAccess.can_view_marketplace === true,
      athleteAccess.free_only !== false,
    ],
  );
  return Boolean(athleteResult.rows[0]);
}

async function loadAthleteLibraryAccess(user) {
  if (String(user?.role_hint || "").toLowerCase() !== "athlete") return null;
  const result = await query(
    `select
       a.id as athlete_id,
       coalesce(ala.can_view_coach_library, true) as can_view_coach_library,
       coalesce(ala.can_view_club_library, false) as can_view_club_library,
       coalesce(ala.can_view_optimove_library, false) as can_view_optimove_library,
       coalesce(ala.can_view_marketplace, false) as can_view_marketplace,
       coalesce(ala.free_only, true) as free_only,
       coalesce(ala.require_approval, true) as require_approval,
       coalesce(ala.selected_programs_only, false) as selected_programs_only
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
    [user.id],
  );
  return result.rows[0] || null;
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

async function markProgramUsed(user, planId, note) {
  const plan = await query(
    `select access_model,
            access_duration_days,
            subscription_period,
            is_free,
            price_cents,
            can_copy,
            can_edit_copy,
            can_assign_to_athlete,
            athlete_can_view_directly,
            requires_approval
     from plans.plans
     where id = $1
     limit 1`,
    [planId],
  );
  const license = plan.rows[0] || {};
  const snapshot = licenseSnapshot(license);
  const accessType = accessTypeForLicense(license);
  const expiresAt = accessExpiresAt(license);
  const access = await query(
    `insert into library.program_access (
       plan_id, user_id, access_type, status, used_at, starts_at, expires_at, source, license_snapshot
     )
     values ($1, $2, $3, 'used', now(), now(), $4, $5, $6::jsonb)
     on conflict (plan_id, user_id, access_type)
     do update set status = case when library.program_access.status = 'completed' then 'completed' else 'used' end,
                   used_at = coalesce(library.program_access.used_at, now()),
                   expires_at = excluded.expires_at,
                   source = excluded.source,
                   license_snapshot = excluded.license_snapshot,
                   updated_at = now()
     returning id, plan_id, user_id, access_type, status, used_at, expires_at, source, license_snapshot`,
    [planId, user.id, accessType, expiresAt, snapshot.accessModel, JSON.stringify(snapshot)],
  );
  await query(
    `insert into library.program_usage_events (program_access_id, user_id, event_type, note)
     values ($1, $2, 'used', nullif(trim($3), ''))`,
    [access.rows[0].id, user.id, note],
  );
  return access.rows[0];
}

async function requireUsedProgramAccess(user, planId) {
  const result = await query(
    `select id, access_type, status, expires_at
     from library.program_access
     where plan_id = $1
       and user_id = $2
       and status in ('used', 'completed')
       and (expires_at is null or expires_at > now())
     order by used_at desc nulls last, updated_at desc
     limit 1`,
    [planId, user.id],
  );
  return result.rows[0] || null;
}

async function findOrCreateProgramTag(user, name) {
  const existing = await query(
    `select id, is_active
     from library.program_tag_definitions
     where lower(name) = lower($1)
     limit 1`,
    [name],
  );
  if (existing.rows[0]?.id) {
    if (!existing.rows[0].is_active) {
      await query(`update library.program_tag_definitions set is_active = true, updated_at = now() where id = $1`, [existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }

  try {
    const created = await query(
      `insert into library.program_tag_definitions (name, slug, owner_scope, owner_user_id, created_by_user_id, is_active)
       values ($1, concat($2::text, '-', substring(gen_random_uuid()::text from 1 for 8)), 'user', $3, $3, true)
       returning id`,
      [name, slugify(name), user.id],
    );
    return created.rows[0].id;
  } catch (error) {
    if (error?.code !== "23505") throw error;
    const fallback = await query(
      `select id
       from library.program_tag_definitions
       where lower(name) = lower($1)
       limit 1`,
      [name],
    );
    if (fallback.rows[0]?.id) {
      await query(`update library.program_tag_definitions set is_active = true, updated_at = now() where id = $1`, [fallback.rows[0].id]);
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

function booleanValue(value, fallback = false) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function positiveIntegerOrNull(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function accessExpiresAt(plan) {
  const days = positiveIntegerOrNull(plan?.access_duration_days);
  if (!days) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function accessTypeForLicense(plan) {
  if (plan?.access_model === "assigned") return "assigned";
  if (plan?.access_model === "subscription" || plan?.is_free === false) return "purchased";
  return "downloaded";
}

function licenseSnapshot(plan) {
  return {
    accessModel: plan?.access_model || "free_forever",
    accessDurationDays: plan?.access_duration_days || null,
    subscriptionPeriod: plan?.subscription_period || null,
    isFree: plan?.is_free !== false,
    priceCents: plan?.price_cents || null,
    canCopy: plan?.can_copy !== false,
    canEditCopy: plan?.can_edit_copy !== false,
    canAssignToAthlete: plan?.can_assign_to_athlete !== false,
    athleteCanViewDirectly: plan?.athlete_can_view_directly === true,
    requiresApproval: plan?.requires_approval === true,
  };
}

export default router;
