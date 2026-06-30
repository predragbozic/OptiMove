const PLATFORM_ROLES = new Set(["admin", "platform_admin", "general_admin"]);
const CLUB_ROLES = new Set(["club_admin", "club_manager"]);
const TEAM_ROLES = new Set(["team_admin", "team_coach", "team_trainer"]);
const COACH_ROLES = new Set(["coach", "independent_coach", "fitness_coach", "trainer"]);

export function normalizeRole(role) {
  return String(role || "user").trim().toLowerCase();
}

export function isAthlete(user) {
  return normalizeRole(user?.role_hint) === "athlete";
}

export function isPlatformAdmin(user) {
  return PLATFORM_ROLES.has(normalizeRole(user?.role_hint));
}

export function isClubAdmin(user) {
  return CLUB_ROLES.has(normalizeRole(user?.role_hint));
}

export function isTeamCoach(user) {
  return TEAM_ROLES.has(normalizeRole(user?.role_hint));
}

export function isCoachUser(user) {
  const role = normalizeRole(user?.role_hint);
  return Boolean(user) && !isAthlete(user) && (
    PLATFORM_ROLES.has(role) || CLUB_ROLES.has(role) || TEAM_ROLES.has(role) || COACH_ROLES.has(role) || role === "user"
  );
}

export function publicRole(user) {
  const role = normalizeRole(user?.role_hint);
  if (PLATFORM_ROLES.has(role)) return "platform_admin";
  if (CLUB_ROLES.has(role)) return "club_admin";
  if (TEAM_ROLES.has(role)) return "team_coach";
  if (COACH_ROLES.has(role) || role === "user") return "coach";
  if (role === "athlete") return "athlete";
  return role;
}

export function accessScope(user) {
  if (isPlatformAdmin(user)) return "platform";
  if (isClubAdmin(user)) return "club";
  if (isTeamCoach(user)) return "team";
  if (isAthlete(user)) return "athlete";
  return "coach";
}

export function canAccessAllAthletes(user) {
  return isPlatformAdmin(user);
}

export function athleteListAccessFilter(user, athleteAlias = "a", startParam = 1) {
  if (!user) return { sql: "and false", params: [] };
  if (canAccessAllAthletes(user)) return { sql: "", params: [] };
  return {
    sql: `and ${athleteAccessPredicate(athleteAlias, `$${startParam}`)}`,
    params: [user.id],
  };
}

export async function canAccessAthlete(query, user, athleteId) {
  if (!user) return false;
  if (canAccessAllAthletes(user)) return true;
  const result = await query(
    `
    select 1
    from public.athletes a
    where (a.athlete_id = $1 or a.source_external_id = $1 or a.id::text = $1)
      and ${athleteAccessPredicate("a", "$2")}
    limit 1
    `,
    [athleteId, user.id],
  );
  return result.rowCount > 0;
}

export async function canAccessPlan(query, user, planId, { editable = false } = {}) {
  if (!user) return false;
  if (canAccessAllAthletes(user)) return true;
  const ownPlanStatus = editable
    ? "or p.created_by_user_id = $2"
    : "or (p.created_by_user_id = $2 and (p.visibility = 'private' or p.is_template = true))";
  const result = await query(
    `
    select 1
    from plans.plans p
    left join public.athletes a on a.id = p.athlete_id
    where p.id = $1
      and (
        p.visibility = 'public'
        ${ownPlanStatus}
        or (a.id is not null and ${athleteAccessPredicate("a", "$2")})
      )
    limit 1
    `,
    [planId, user.id],
  );
  return result.rowCount > 0;
}

export function athleteAccessPredicate(athleteAlias = "a", userParam = "$1") {
  return `(
    ${athleteAlias}.user_id = ${userParam}
    or exists (
      select 1
      from public.user_athletes ua
      where ua.athlete_id = ${athleteAlias}.id
        and ua.user_id = ${userParam}
        and ua.is_active = true
    )
    or exists (
      select 1
      from public.user_team_roles utr
      where utr.user_id = ${userParam}
        and utr.is_active = true
        and utr.team_id = ${athleteAlias}.team_id
    )
    or exists (
      select 1
      from public.user_club_roles ucr
      left join public.teams athlete_team on athlete_team.id = ${athleteAlias}.team_id
      where ucr.user_id = ${userParam}
        and ucr.is_active = true
        and (ucr.club_id = ${athleteAlias}.club_id or ucr.club_id = athlete_team.club_id)
    )
  )`;
}
