import { canAccessAllAthletes } from "./access.js";

export async function loadAthleteLibraryAccess(query, req) {
  if (!req?.authz?.isAthlete) return null;
  const result = await query(
    `select
       a.id as athlete_id,
       coalesce(ala.can_view_coach_library, true) as can_view_coach_library,
       coalesce(ala.can_view_team_library, false) as can_view_team_library,
       coalesce(ala.can_view_club_library, false) as can_view_club_library,
       coalesce(ala.can_view_optimove_library, false) as can_view_optimove_library,
       coalesce(ala.can_view_marketplace, false) as can_view_marketplace,
       coalesce(ala.can_view_coach_profiles, true) as can_view_coach_profiles,
       coalesce(ala.can_view_club_coach_profiles, false) as can_view_club_coach_profiles,
       coalesce(ala.can_view_public_coach_profiles, false) as can_view_public_coach_profiles,
       coalesce(ala.can_contact_visible_coaches, true) as can_contact_visible_coaches,
       coalesce(ala.can_view_assigned_exercises, true) as can_view_assigned_exercises,
       coalesce(ala.can_view_coach_exercise_library, false) as can_view_coach_exercise_library,
       coalesce(ala.can_view_team_exercise_library, false) as can_view_team_exercise_library,
       coalesce(ala.can_view_club_exercise_library, false) as can_view_club_exercise_library,
       coalesce(ala.can_view_optimove_exercise_library, false) as can_view_optimove_exercise_library,
       coalesce(ala.can_view_exercise_groups, false) as can_view_exercise_groups,
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
    [req.user.id],
  );
  return result.rows[0] || null;
}

export function templateScopesForUser(athleteAccess) {
  if (!athleteAccess) return ["my_programs", "optimove", "marketplace"];
  const scopes = ["my_programs"];
  if (athleteAccess.can_view_optimove_library === true) scopes.push("optimove");
  if (athleteAccess.can_view_marketplace === true) scopes.push("marketplace");
  return scopes;
}

export async function hasActiveProgramAccess(query, user, planId, statuses = ["accessed", "used", "completed"]) {
  if (!user) return false;
  const result = await query(
    `select 1
     from library.program_access
     where plan_id = $1
       and user_id = $2
       and status = any($3::varchar[])
       and (expires_at is null or expires_at > now())
     limit 1`,
    [planId, user.id, statuses],
  );
  return result.rowCount > 0;
}

export async function hasTemplateAccessRecord(query, req, summary, planId) {
  if (!req?.authz?.isAthlete) return false;
  if (summary?.plan_type !== "program" || summary?.is_template !== true) return false;
  return hasActiveProgramAccess(query, req.user, planId, ["requested", "rejected", "accessed", "used", "completed"]);
}

export async function needsTemplateApproval(query, req, summary, planId) {
  if (!req?.authz?.isAthlete) return false;
  if (summary?.plan_type !== "program" || summary?.is_template !== true) return false;
  if (await hasActiveProgramAccess(query, req.user, planId)) return false;

  // The approval workflow exists to gate OTHER users' access to this
  // content, not the creator's own view of it (or a platform admin's full
  // bypass). A multi-role account that also happens to be an athlete must
  // never be blocked from its own coach-side access by its own athlete-side
  // approval settings.
  if (req?.authz?.capabilities?.coachWorkspace) {
    if (canAccessAllAthletes(req)) return false;
    const ownership = await query(
      `select 1 from plans.plans where id = $1 and created_by_user_id = $2 limit 1`,
      [planId, req.user.id],
    );
    if (ownership.rows[0]) return false;
  }

  const athleteAccess = await loadAthleteLibraryAccess(query, req);
  return Boolean(athleteAccess) && (summary?.requires_approval === true || athleteAccess.require_approval === true);
}

export async function requireUsedProgramAccess(query, user, planId) {
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

export async function canUseTemplate(query, req, planId) {
  const user = req.user;
  // Runs whenever the account has coach/platform capability, regardless of
  // whether it's ALSO an athlete - a multi-role account must get the union
  // of both, not one or the other. If this branch doesn't grant access, the
  // athlete-scope checks below still run normally.
  if (req?.authz?.capabilities?.coachWorkspace) {
    const staffResult = await query(
      `select 1
       from plans.plans p
       where p.id = $1
         and p.plan_type = 'program'
         and p.is_template = true
         and coalesce(p.is_active, true)
         and ($3::boolean or p.created_by_user_id = $2 or p.visibility = 'public')
       limit 1`,
      [planId, user.id, canAccessAllAthletes(req)],
    );
    if (staffResult.rows[0]) return true;
  }

  const accessResult = await query(
    `select 1
     from library.program_access pa
     join plans.plans p on p.id = pa.plan_id
     where pa.plan_id = $1
       and pa.user_id = $2
       and pa.status in ('requested', 'rejected', 'accessed', 'used', 'completed')
       and (pa.expires_at is null or pa.expires_at > now())
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and coalesce(p.status, 'active') not in ('draft', 'archived')
       and coalesce(p.library_scope, 'my') <> 'workspace'
     limit 1`,
    [planId, user.id],
  );
  if (accessResult.rows[0]) return true;

  const athleteAccess = await loadAthleteLibraryAccess(query, req);
  if (!athleteAccess) return false;

  const athleteResult = await query(
    `select 1
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and (not $8::boolean or coalesce(p.is_free, true))
       and coalesce(p.status, 'active') not in ('draft', 'archived')
       and coalesce(p.library_scope, 'my') <> 'workspace'
       and (
         (coalesce(p.library_scope, 'my') = 'my' and $3::boolean and coalesce(p.athlete_can_view_directly, false) and exists (
           select 1
           from public.user_athletes coach_rel
           where coach_rel.athlete_id = $2
             and coach_rel.user_id = p.created_by_user_id
             and coach_rel.relationship_type = 'coach'
             and coach_rel.is_active = true
         ))
         -- Keyed off the viewer athlete's ACTIVE athlete_memberships rows,
         -- not the legacy athletes.club_id/team_id pointer - an athlete can
         -- hold several active team/club memberships at once, and an
         -- archived one must never keep unlocking a scope it no longer
         -- belongs to.
         or (coalesce(p.library_scope, 'my') = 'team' and $4::boolean and coalesce(p.athlete_can_view_directly, false) and p.visibility in ('team', 'club', 'public') and exists (
           select 1
           from public.athlete_memberships viewer_team_membership
           join public.user_team_roles creator_team
             on creator_team.team_id = viewer_team_membership.team_id
            and creator_team.user_id = p.created_by_user_id
            and creator_team.is_active = true
           where viewer_team_membership.athlete_id = $2
             and viewer_team_membership.membership_type = 'team'
             and viewer_team_membership.status = 'active'
         ))
         or (coalesce(p.library_scope, 'my') = 'club' and $5::boolean and coalesce(p.athlete_can_view_directly, false) and p.visibility in ('club', 'public') and exists (
           select 1
           from public.athlete_memberships viewer_club_membership
           join public.user_club_roles creator_club
             on creator_club.club_id = viewer_club_membership.club_id
            and creator_club.user_id = p.created_by_user_id
            and creator_club.is_active = true
           where viewer_club_membership.athlete_id = $2
             and viewer_club_membership.membership_type = 'club'
             and viewer_club_membership.status = 'active'
         ))
         or (coalesce(p.library_scope, 'my') = 'optimove' and $6::boolean and coalesce(p.athlete_can_view_directly, false) and p.visibility = 'public')
         or (coalesce(p.library_scope, 'my') = 'marketplace' and $7::boolean and coalesce(p.athlete_can_view_directly, false) and p.visibility = 'public')
       )
     limit 1`,
    [
      planId,
      athleteAccess.athlete_id,
      athleteAccess.can_view_coach_library === true,
      athleteAccess.can_view_team_library === true,
      athleteAccess.can_view_club_library === true,
      athleteAccess.can_view_optimove_library === true,
      athleteAccess.can_view_marketplace === true,
      athleteAccess.free_only !== false,
    ],
  );
  return Boolean(athleteResult.rows[0]);
}

export async function canEditTemplate(query, req, planId) {
  const result = await query(
    `select 1
     from plans.plans p
     where p.id = $1
       and p.plan_type = 'program'
       and p.is_template = true
       and coalesce(p.is_active, true)
       and ($3::boolean or p.created_by_user_id = $2)
     limit 1`,
    [planId, req.user.id, canAccessAllAthletes(req)],
  );
  return Boolean(result.rows[0]);
}

export function accessExpiresAt(plan) {
  const days = positiveIntegerOrNull(plan?.access_duration_days);
  if (!days) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export function accessTypeForLicense(plan) {
  if (plan?.access_model === "assigned") return "assigned";
  if (plan?.access_model === "subscription" || plan?.is_free === false) return "purchased";
  return "downloaded";
}

export function licenseSnapshot(plan) {
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

function positiveIntegerOrNull(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}
