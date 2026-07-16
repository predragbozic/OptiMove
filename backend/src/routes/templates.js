import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes, canAccessAthlete, isAthlete } from "../access.js";
import { createNotification } from "../notifications.js";
import {
  accessExpiresAt,
  accessTypeForLicense,
  canEditTemplate,
  canUseTemplate,
  licenseSnapshot,
  loadAthleteLibraryAccess,
  requireUsedProgramAccess,
  templateScopesForUser,
} from "../programAccessPolicy.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const allowedScopes = new Set(["all", "workspace", "my", "club", "optimove", "marketplace"]);
    const requestedScope = allowedScopes.has(String(req.query.scope || "")) ? String(req.query.scope) : "my";
    const search = text(req.query.search);
    const category = text(req.query.category);
    const tag = text(req.query.tag);
    const pricing = normalizeChoice(req.query.pricing, ["all", "free", "paid"], "all");
    const athleteAccess = await loadAthleteLibraryAccess(query, req.user);
    const visibleScopes = templateScopesForUser(athleteAccess);
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
        creator_profile.id as creator_profile_id,
        creator_profile.photo_url as creator_photo_url,
        creator_profile.headline as creator_headline,
        coalesce(nullif(creator.display_name, ''), nullif(creator.full_name, ''), creator.email) as creator_name,
        creator.email as creator_email,
        coalesce(creator_clubs.club_ids, '[]'::jsonb) as creator_club_ids,
        coalesce(creator_clubs.club_names, '') as creator_club_names,
        reviews.average_rating,
        coalesce(reviews.review_count, 0)::int as review_count,
        user_access.status as user_access_status,
        user_access.access_type as user_access_type,
        user_access.used_at as user_access_used_at,
        user_access.expires_at as user_access_expires_at,
        coalesce(max(access_requests.pending_count), 0)::int as pending_access_count,
        coalesce(
          jsonb_agg(distinct jsonb_build_object('id', t.id, 'name', t.name))
            filter (where t.id is not null),
          '[]'::jsonb
        ) as tags
      from plans.v_plan_summary ps
      join plans.plans p on p.id = ps.plan_id
      left join public.users creator on creator.id = p.created_by_user_id
      left join public.coach_profiles creator_profile on creator_profile.user_id = p.created_by_user_id and creator_profile.is_active = true
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
      left join lateral (
        select pa.status, pa.access_type, pa.used_at, pa.expires_at
        from library.program_access pa
        where pa.plan_id = p.id
          and pa.user_id = $1
          and pa.status <> 'revoked'
          and (pa.expires_at is null or pa.expires_at > now())
        order by case pa.status
          when 'completed' then 4
          when 'used' then 3
          when 'accessed' then 2
          when 'requested' then 1
          when 'rejected' then 1
          else 0
        end desc,
        pa.updated_at desc
        limit 1
      ) user_access on true
      left join lateral (
        select count(*)::int as pending_count
        from library.program_access pa
        where pa.plan_id = p.id
          and pa.status = 'requested'
      ) access_requests on true
      left join library.program_tags pt on pt.plan_id = p.id
      left join library.program_tag_definitions t on t.id = pt.tag_id and t.is_active = true
      where ps.plan_type = 'program'
        and ps.is_template = true
        and (
          (not $8::boolean and ($2::boolean or p.created_by_user_id = $1 or p.visibility = 'public'))
          or (
            $8::boolean
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
              or (coalesce(p.library_scope, 'my') = 'club' and $11::boolean and coalesce(ps.athlete_can_view_directly, false) and p.visibility in ('club', 'public'))
              or (coalesce(p.library_scope, 'my') = 'optimove' and $12::boolean and coalesce(ps.athlete_can_view_directly, false) and p.visibility = 'public')
              or (coalesce(p.library_scope, 'my') = 'marketplace' and $13::boolean and coalesce(ps.athlete_can_view_directly, false) and p.visibility = 'public')
            )
          )
          or (
            $8::boolean
            and user_access.status in ('requested', 'rejected', 'accessed', 'used', 'completed')
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
        p.created_by_user_id, creator_profile.id, creator_profile.photo_url, creator_profile.headline,
        creator.display_name, creator.full_name, creator.email, creator_clubs.club_ids, creator_clubs.club_names,
        reviews.average_rating, reviews.review_count,
        user_access.status, user_access.access_type, user_access.used_at, user_access.expires_at
      order by coalesce(ps.library_category, 'General'), ps.source_external_id, ps.program_order nulls last, ps.plan_name
      `,
      params,
    );
    res.json({ scope: requestedScope, allowedScopes: visibleScopes, templates: result.rows });
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
    if (!(await canEditTemplate(query, req.user, planId))) return res.status(404).json({ error: "Template not found." });

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
    if (!(await canUseTemplate(query, req.user, req.params.planId))) {
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
    if (!(await canUseTemplate(query, req.user, req.params.planId))) {
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

router.get("/:planId/access-requests", async (req, res, next) => {
  try {
    if (isAthlete(req.user)) return res.status(403).json({ error: "Coach access required." });
    const result = await query(
      `select distinct
         pa.id,
         pa.plan_id,
         pa.user_id,
         pa.access_type,
         pa.status,
         pa.created_at,
         pa.updated_at,
         a.id as athlete_id,
         a.athlete_id as athlete_code,
         coalesce(a.display_name, a.full_name, a.athlete_id) as athlete_name,
         a.image_url as athlete_image_url,
         u.email as athlete_email
       from library.program_access pa
       join public.users u on u.id = pa.user_id
       join public.athletes a on a.user_id = pa.user_id
          or exists (
            select 1
            from public.user_athletes ua
            where ua.user_id = pa.user_id
              and ua.athlete_id = a.id
              and ua.relationship_type = 'athlete'
              and ua.is_active = true
          )
       where pa.plan_id = $1
         and pa.status = 'requested'
         and coalesce(a.is_active, true)
       order by pa.created_at desc
       limit 100`,
      [req.params.planId],
    );
    const requests = [];
    for (const row of result.rows) {
      if (await canAccessAthlete(query, req.user, row.athlete_id)) requests.push(row);
    }
    res.json({ requests });
  } catch (error) {
    next(error);
  }
});

router.post("/:planId/assignments", async (req, res, next) => {
  try {
    if (isAthlete(req.user)) return res.status(403).json({ error: "Coach access required." });
    const plan = await loadAssignableTemplate(req.user, req.params.planId);
    if (!plan) return res.status(404).json({ error: "Template not found." });
    if (plan.can_assign_to_athlete === false) return res.status(403).json({ error: "This program cannot be assigned." });

    const requestedIds = Array.isArray(req.body?.athleteIds) ? req.body.athleteIds.map(text).filter(Boolean) : [];
    const athleteIds = [...new Set(requestedIds)];
    if (!athleteIds.length) return res.status(400).json({ error: "Choose at least one athlete." });

    const assigned = [];
    const skipped = [];
    for (const athleteId of athleteIds) {
      const athlete = await loadAssignableAthlete(athleteId);
      if (!athlete) {
        skipped.push({ athleteId, reason: "Athlete not found." });
        continue;
      }
      if (!(await canAccessAthlete(query, req.user, athlete.id))) {
        skipped.push({ athleteId, athleteName: athlete.name, reason: "No access to this athlete." });
        continue;
      }
      if (!athlete.user_id) {
        skipped.push({ athleteId, athleteName: athlete.name, reason: "Athlete login is not enabled." });
        continue;
      }
      const access = await assignProgramAccess(plan, athlete.user_id);
      assigned.push({
        athleteId: athlete.id,
        athleteCode: athlete.athlete_id || athlete.source_external_id,
        athleteName: athlete.name,
        accessId: access.id,
        status: access.status,
      });
    }

    res.status(201).json({ assigned, skipped });
  } catch (error) {
    next(error);
  }
});

router.post("/:planId/tags", async (req, res, next) => {
  try {
    if (!(await canEditTemplate(query, req.user, req.params.planId))) {
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
    if (!(await canEditTemplate(query, req.user, req.params.planId))) {
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
    if (!(await canUseTemplate(query, req.user, req.params.planId))) {
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
    if (!(await canUseTemplate(query, req.user, req.params.planId))) {
      return res.status(404).json({ error: "Template not found." });
    }
    const access = await requireUsedProgramAccess(query, req.user, req.params.planId);
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

async function loadAssignableTemplate(user, planId) {
  const result = await query(
    `select id,
            access_model,
            access_duration_days,
            subscription_period,
            is_free,
            price_cents,
            can_copy,
            can_edit_copy,
            can_assign_to_athlete,
            athlete_can_view_directly,
            requires_approval
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and ($3::boolean or p.created_by_user_id = $2 or p.visibility = 'public')
     limit 1`,
    [planId, user.id, canAccessAllAthletes(user)],
  );
  return result.rows[0] || null;
}

async function loadAssignableAthlete(athleteId) {
  const result = await query(
    `select id,
            athlete_id,
            source_external_id,
            user_id,
            coalesce(display_name, full_name, concat_ws(' ', first_name, last_name), athlete_id, source_external_id) as name
     from public.athletes
     where coalesce(is_active, true)
       and (id::text = $1 or athlete_id = $1 or source_external_id = $1)
     limit 1`,
    [athleteId],
  );
  return result.rows[0] || null;
}

async function assignProgramAccess(plan, userId) {
  const snapshot = licenseSnapshot(plan);
  const expiresAt = accessExpiresAt(plan);
  const existing = await query(
    `select id
     from library.program_access
     where plan_id = $1
       and user_id = $2
       and status <> 'revoked'
     order by case status
       when 'requested' then 4
       when 'accessed' then 3
       when 'used' then 2
       when 'completed' then 1
       else 0
     end desc,
     updated_at desc
     limit 1`,
    [plan.id, userId],
  );
  if (existing.rows[0]?.id) {
    const updated = await query(
      `update library.program_access
       set status = case when status = 'completed' then 'completed' else 'accessed' end,
           starts_at = coalesce(starts_at, now()),
           expires_at = $2,
           source = 'coach_assignment',
           license_snapshot = $3::jsonb,
           accessed_at = now(),
           updated_at = now()
       where id = $1
       returning id, plan_id, user_id, access_type, status, expires_at`,
      [existing.rows[0].id, expiresAt, JSON.stringify(snapshot)],
    );
    return updated.rows[0];
  }
  const inserted = await query(
    `insert into library.program_access (
       plan_id, user_id, access_type, status, starts_at, expires_at, source, license_snapshot
     )
     values ($1, $2, 'coach_assigned', 'accessed', now(), $3, 'coach_assignment', $4::jsonb)
     on conflict (plan_id, user_id, access_type)
     do update set status = case when library.program_access.status = 'completed' then 'completed' else 'accessed' end,
                   starts_at = coalesce(library.program_access.starts_at, now()),
                   expires_at = excluded.expires_at,
                   source = excluded.source,
                   license_snapshot = excluded.license_snapshot,
                   accessed_at = now(),
                   updated_at = now()
     returning id, plan_id, user_id, access_type, status, expires_at`,
    [plan.id, userId, expiresAt, JSON.stringify(snapshot)],
  );
  return inserted.rows[0];
}

async function markProgramUsed(user, planId, note) {
  const plan = await query(
    `select id,
            name,
            created_by_user_id,
            access_model,
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
  const athleteAccess = await loadAthleteLibraryAccess(query, user);
  const approvalRequired = Boolean(athleteAccess) && (license.requires_approval === true || athleteAccess.require_approval === true);
  const snapshot = licenseSnapshot(license);
  const accessType = accessTypeForLicense(license);
  const expiresAt = accessExpiresAt(license);
  const existingAccess = await query(
    `select id, status
     from library.program_access
     where plan_id = $1
       and user_id = $2
       and access_type = $3
     order by updated_at desc
     limit 1`,
    [planId, user.id, accessType],
  );
  const hasApprovedAccess = ["accessed", "used", "completed"].includes(existingAccess.rows[0]?.status);
  const nextStatus = approvalRequired && !hasApprovedAccess ? "requested" : "used";
  const eventType = nextStatus === "requested" ? "requested" : "used";
  const existing = existingAccess.rows[0];
  const finalStatus = existing?.status === "completed"
    ? "completed"
    : ["accessed", "used"].includes(existing?.status) && nextStatus === "requested"
      ? existing.status
      : nextStatus;
  const access = existing?.id
    ? await query(
      `update library.program_access
       set status = $2::varchar,
           used_at = case when $2::text = 'used' then coalesce(used_at, now()) else used_at end,
           starts_at = coalesce(starts_at, now()),
           expires_at = $3,
           source = $4,
           license_snapshot = $5::jsonb,
           updated_at = now()
       where id = $1
       returning id, plan_id, user_id, access_type, status, used_at, expires_at, source, license_snapshot`,
      [existing.id, finalStatus, expiresAt, snapshot.accessModel, JSON.stringify(snapshot)],
    )
    : await query(
      `insert into library.program_access (
         plan_id, user_id, access_type, status, used_at, starts_at, expires_at, source, license_snapshot
       )
       values ($1, $2, $3, $7::varchar, case when $7::text = 'used' then now() else null end, now(), $4, $5, $6::jsonb)
       returning id, plan_id, user_id, access_type, status, used_at, expires_at, source, license_snapshot`,
      [planId, user.id, accessType, expiresAt, snapshot.accessModel, JSON.stringify(snapshot), finalStatus],
    );
  await query(
    `insert into library.program_usage_events (program_access_id, user_id, event_type, note)
     values ($1, $2, $3::varchar, nullif(trim($4::text), ''))`,
    [access.rows[0].id, user.id, eventType, note],
  );
  if (finalStatus === "requested" && existing?.status !== "requested" && license.created_by_user_id && String(license.created_by_user_id) !== String(user.id)) {
    await createNotification({
      recipientUserId: license.created_by_user_id,
      actorUserId: user.id,
      type: "program_access_requested",
      title: "Program access request",
      body: `${user.display_name || user.full_name || user.email || "Athlete"} requested ${license.name || "a program"}.`,
      entityType: "program_access",
      entityId: access.rows[0].id,
      href: "/app?tab=templates&section=requests",
      metadata: { planId },
    });
  }
  return access.rows[0];
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

export default router;
