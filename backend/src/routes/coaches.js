import { Router } from "express";
import { query } from "../db.js";
import { canAccessAllAthletes, isClubAdmin, isTeamCoach } from "../access.js";
import { createNotification } from "../notifications.js";
import { ensureConversationForContactRequest } from "../messages.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const result = await query(coachListSql(), [req.user.id, canAccessAllAthletes(req.user), canUseClubProfiles(req.user)]);
    res.json({ coaches: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const profile = await ensureCoachProfile(req.user);
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});

router.patch("/me", async (req, res, next) => {
  try {
    const profile = await ensureCoachProfile(req.user);
    const visibility = normalizeChoice(req.body?.visibility, ["private", "club", "public", "marketplace"], "private");
    await query(
      `update public.coach_profiles
       set headline = nullif(trim($2), ''),
           bio = nullif(trim($3), ''),
           specialties = nullif(trim($4), ''),
           photo_url = nullif(trim($5), ''),
           cover_image_url = nullif(trim($6), ''),
           contact_email = nullif(trim($7), ''),
           contact_enabled = $8,
           visibility = $9,
           updated_at = now()
       where id = $1`,
      [
        profile.id,
        text(req.body?.headline),
        text(req.body?.bio),
        text(req.body?.specialties),
        text(req.body?.photoUrl),
        text(req.body?.coverImageUrl),
        text(req.body?.contactEmail),
        req.body?.contactEnabled !== false && req.body?.contactEnabled !== "false",
        visibility,
      ],
    );
    await replaceProfileTags(profile.id, req.body?.tags);
    const updated = await loadCoachProfileByUser(req.user.id, req.user);
    res.json({ profile: updated });
  } catch (error) {
    next(error);
  }
});

router.get("/:profileId", async (req, res, next) => {
  try {
    const profile = await loadVisibleCoachProfile(req.params.profileId, req.user);
    if (!profile) return res.status(404).json({ error: "Coach profile not found." });
    const programs = await query(
      `select ps.plan_id, ps.plan_name, ps.library_category, ps.cover_image_url, ps.is_free, ps.price_cents, ps.item_count,
              coalesce(ps.library_scope, 'my') as library_scope,
              reviews.average_rating,
              coalesce(reviews.review_count, 0)::int as review_count
       from plans.v_plan_summary ps
       join plans.plans p on p.id = ps.plan_id
       left join lateral (
         select round(avg(pr.rating)::numeric, 1) as average_rating,
                count(*)::int as review_count
         from library.program_reviews pr
         where pr.plan_id = p.id
           and pr.status = 'published'
       ) reviews on true
       where p.created_by_user_id = $1
         and ps.plan_type = 'program'
         and ps.is_template = true
         and coalesce(p.is_active, true)
         and (p.visibility = 'public' or p.library_scope in ('marketplace', 'optimove') or $2::boolean or p.created_by_user_id = $3)
       order by coalesce(ps.library_category, 'General'), ps.plan_name`,
      [profile.user_id, canAccessAllAthletes(req.user), req.user.id],
    );
    res.json({ profile, programs: programs.rows });
  } catch (error) {
    next(error);
  }
});

router.post("/:profileId/contact", async (req, res, next) => {
  try {
    const profile = await loadVisibleCoachProfile(req.params.profileId, req.user);
    if (!profile || !profile.contact_enabled) return res.status(404).json({ error: "Coach profile not found." });
    const message = text(req.body?.message);
    if (!message) return res.status(400).json({ error: "Message is required." });
    const inserted = await query(
      `insert into public.coach_contact_requests (coach_profile_id, sender_user_id, sender_name, sender_email, message)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [profile.id, req.user?.id || null, text(req.body?.name) || req.user?.display_name || req.user?.full_name || req.user?.email, text(req.body?.email) || req.user?.email, message],
    );
    const senderName = text(req.body?.name) || req.user?.display_name || req.user?.full_name || req.user?.email || "Someone";
    await createNotification({
      recipientUserId: profile.user_id,
      actorUserId: req.user?.id || null,
      type: "coach_contact_requested",
      title: "New coach contact",
      body: `${senderName}: ${message.slice(0, 140)}${message.length > 140 ? "..." : ""}`,
      entityType: "coach_contact_request",
      entityId: inserted.rows[0]?.id || null,
      href: "/app?tab=coaches",
      metadata: { coachProfileId: profile.id },
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.patch("/contact-requests/:requestId", async (req, res, next) => {
  try {
    const status = normalizeChoice(req.body?.status, ["read", "replied", "accepted", "archived"], "");
    if (!status) return res.status(400).json({ error: "Choose a valid contact status." });
    const result = await query(
      `update public.coach_contact_requests ccr
       set status = $2,
           updated_at = now()
       from public.coach_profiles cp
       where ccr.id = $1
         and cp.id = ccr.coach_profile_id
         and (cp.user_id = $3 or $4::boolean)
       returning ccr.id, ccr.coach_profile_id, ccr.sender_user_id, ccr.status, ccr.updated_at`,
      [req.params.requestId, status, req.user.id, canAccessAllAthletes(req.user)],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Contact request not found." });
    let conversationId = null;
    if (status === "accepted") {
      conversationId = await ensureConversationForContactRequest(result.rows[0].id, req.user.id);
      if (conversationId) {
        await createNotification({
          recipientUserId: result.rows[0].sender_user_id,
          actorUserId: req.user.id,
          type: "coach_contact_accepted",
          title: "Contact accepted",
          body: "Your coach contact request was accepted. You can now continue in Messages.",
          entityType: "message_conversation",
          entityId: conversationId,
          href: "/app?tab=messages",
          metadata: { conversationId, coachProfileId: result.rows[0].coach_profile_id },
        });
      }
    }
    res.json({ contactRequest: result.rows[0], conversationId });
  } catch (error) {
    next(error);
  }
});

router.post("/:profileId/reviews", async (req, res, next) => {
  try {
    const profile = await loadVisibleCoachProfile(req.params.profileId, req.user);
    if (!profile) return res.status(404).json({ error: "Coach profile not found." });
    if (String(profile.user_id) === String(req.user.id)) {
      return res.status(400).json({ error: "You cannot review your own coach profile." });
    }
    const contact = await requireVerifiedCoachContact(req.user, profile.id);
    if (!contact) {
      return res.status(403).json({ error: "Contact this coach and receive a reply before leaving a review." });
    }
    const rating = Number.parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }
    const review = await query(
      `insert into public.coach_profile_reviews (coach_profile_id, reviewer_user_id, rating, comment, status, is_verified, verified_contact_request_id)
       values ($1, $2, $3, nullif(trim($4), ''), 'published', true, $5)
       on conflict (coach_profile_id, reviewer_user_id)
       where reviewer_user_id is not null
       do update set rating = excluded.rating,
                     comment = excluded.comment,
                     status = 'published',
                     is_verified = true,
                     verified_contact_request_id = excluded.verified_contact_request_id,
                     updated_at = now()
       returning id, rating, comment, status, is_verified, updated_at`,
      [profile.id, req.user.id, rating, text(req.body?.comment), contact.id],
    );
    res.status(201).json({ review: review.rows[0] });
  } catch (error) {
    next(error);
  }
});

function coachListSql({ includeOrder = true } = {}) {
  return `
    select cp.id, cp.user_id,
      coalesce(nullif(u.display_name, ''), nullif(u.full_name, ''), u.email) as name,
      u.email,
      cp.headline,
      cp.bio,
      cp.specialties,
      cp.photo_url,
      cp.cover_image_url,
      cp.contact_enabled,
      cp.visibility,
      coalesce(tags.tags, '[]'::jsonb) as tags,
      reviews.average_rating,
      coalesce(reviews.review_count, 0)::int as review_count,
      coalesce(programs.program_count, 0)::int as program_count,
      coalesce(programs.marketplace_count, 0)::int as marketplace_count,
      coalesce(clubs.club_names, '') as club_names
    from public.coach_profiles cp
    join public.users u on u.id = cp.user_id
    left join lateral (
      select jsonb_agg(jsonb_build_object('id', cpt.id, 'name', cpt.name) order by cpt.name) as tags
      from public.coach_profile_tags cpt
      where cpt.coach_profile_id = cp.id
    ) tags on true
    left join lateral (
      select count(*) as program_count,
             count(*) filter (where p.library_scope = 'marketplace') as marketplace_count
      from plans.plans p
      where p.created_by_user_id = cp.user_id
        and p.plan_type = 'program'
        and p.is_template = true
        and coalesce(p.is_active, true)
    ) programs on true
    left join lateral (
      select round(avg(cpr.rating)::numeric, 1) as average_rating,
             count(*)::int as review_count
      from public.coach_profile_reviews cpr
      where cpr.coach_profile_id = cp.id
        and cpr.status = 'published'
    ) reviews on true
    left join lateral (
      select string_agg(distinct c.name, ', ' order by c.name) as club_names
      from public.user_club_roles ucr
      join public.clubs c on c.id = ucr.club_id and coalesce(c.is_active, true)
      where ucr.user_id = cp.user_id
        and ucr.is_active = true
    ) clubs on true
    left join lateral (
      select coalesce(ala.can_view_coach_profiles, true) as can_view_coach_profiles,
             coalesce(ala.can_view_public_coach_profiles, false) as can_view_public_coach_profiles
      from public.athletes viewer_athlete
      left join public.athlete_library_access ala on ala.athlete_id = viewer_athlete.id
      where coalesce(viewer_athlete.is_active, true)
        and (
          viewer_athlete.user_id = $1
          or exists (
            select 1
            from public.user_athletes athlete_link
            where athlete_link.athlete_id = viewer_athlete.id
              and athlete_link.user_id = $1
              and athlete_link.relationship_type = 'athlete'
              and athlete_link.is_active = true
          )
        )
      order by viewer_athlete.created_at nulls last
      limit 1
    ) viewer_access on true
    where cp.is_active = true
      and (
        cp.user_id = $1
        or $2::boolean
        or (not $3::boolean and cp.visibility in ('public', 'marketplace') and coalesce(viewer_access.can_view_public_coach_profiles, true))
        or exists (
          select 1
          from public.athletes viewer_athlete
          join public.user_athletes coach_rel
            on coach_rel.athlete_id = viewer_athlete.id
           and coach_rel.user_id = cp.user_id
           and coach_rel.relationship_type = 'coach'
           and coach_rel.is_active = true
          where coalesce(viewer_athlete.is_active, true)
            and (
              viewer_athlete.user_id = $1
              or exists (
                select 1
                from public.user_athletes athlete_link
                where athlete_link.athlete_id = viewer_athlete.id
                  and athlete_link.user_id = $1
                  and athlete_link.relationship_type = 'athlete'
                  and athlete_link.is_active = true
              )
            )
            and coalesce(viewer_access.can_view_coach_profiles, true)
        )
        or ($3::boolean and cp.visibility = 'club' and exists (
          select 1
          from public.user_club_roles viewer_role
          join public.user_club_roles coach_role on coach_role.club_id = viewer_role.club_id and coach_role.user_id = cp.user_id and coach_role.is_active = true
          where viewer_role.user_id = $1 and viewer_role.is_active = true
        ))
        or ($3::boolean and exists (
          select 1
          from public.user_team_roles viewer_team
          join public.user_team_roles coach_team
            on coach_team.team_id = viewer_team.team_id
           and coach_team.user_id = cp.user_id
           and coach_team.is_active = true
          where viewer_team.user_id = $1
            and viewer_team.is_active = true
        ))
        or ($3::boolean and exists (
          select 1
          from public.user_club_roles viewer_club
          join public.teams club_team
            on club_team.club_id = viewer_club.club_id
           and coalesce(club_team.is_active, true)
          join public.user_team_roles coach_team
            on coach_team.team_id = club_team.id
           and coach_team.user_id = cp.user_id
           and coach_team.is_active = true
          where viewer_club.user_id = $1
            and viewer_club.is_active = true
        ))
      )
    ${includeOrder ? "order by cp.visibility = 'marketplace' desc, programs.marketplace_count desc, name" : ""}
  `;
}

async function ensureCoachProfile(user) {
  await query(
    `insert into public.coach_profiles (user_id, contact_email, visibility)
     values ($1, $2, 'private')
     on conflict (user_id) do nothing`,
    [user.id, user.email],
  );
  return loadCoachProfileByUser(user.id, user);
}

async function loadCoachProfileByUser(userId, viewer) {
  const result = await query(
    `${coachListSql({ includeOrder: false })} and cp.user_id = $4`,
    [viewer.id, canAccessAllAthletes(viewer), canUseClubProfiles(viewer), userId],
  );
  return result.rows[0] || null;
}

async function loadVisibleCoachProfile(profileId, viewer) {
  const result = await query(
    `${coachListSql({ includeOrder: false })} and cp.id = $4`,
    [viewer.id, canAccessAllAthletes(viewer), canUseClubProfiles(viewer), profileId],
  );
  return result.rows[0] || null;
}

async function requireVerifiedCoachContact(user, profileId) {
  const result = await query(
    `select id, status
     from public.coach_contact_requests
     where coach_profile_id = $1
       and sender_user_id = $2
       and status in ('replied', 'accepted')
     order by updated_at desc
     limit 1`,
    [profileId, user.id],
  );
  return result.rows[0] || null;
}

async function replaceProfileTags(profileId, tagsValue) {
  const names = String(Array.isArray(tagsValue) ? tagsValue.join(",") : tagsValue || "")
    .split(",")
    .map((tag) => text(tag))
    .filter(Boolean)
    .slice(0, 12);
  await query(`delete from public.coach_profile_tags where coach_profile_id = $1`, [profileId]);
  for (const name of [...new Set(names)]) {
    await query(
      `insert into public.coach_profile_tags (coach_profile_id, name, slug)
       values ($1, $2, $3)
       on conflict (coach_profile_id, slug) do nothing`,
      [profileId, name, slugify(name)],
    );
  }
}

function canUseClubProfiles(user) {
  return isClubAdmin(user) || isTeamCoach(user);
}

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

export default router;
