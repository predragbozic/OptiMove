// Centralized authorization: loads a user's real roles/scopes once per
// request and derives every permission decision from that, instead of the
// old model where a single flat users.role_hint string doubled as both a UI
// hint and the actual security boundary.
//
// role_hint is a TEMPORARY legacy column, kept only so old call sites and
// the current UI don't break. It is NEVER read for authorization here -
// platform admin and independent coach are real, independently-managed rows
// in public.user_global_roles (Phase 4 PR 1), just like club/team roles
// already are. It is also not the workspace-selection mechanism: a
// dedicated preference (e.g. a default_workspace field) will replace its
// remaining UI-default use in a later phase - do not start writing a user's
// chosen workspace back into role_hint in the meantime. A generic "user"
// role_hint must not slip into coach routes, and an "athlete" role_hint must
// not by itself PREVENT someone from also holding real coach/admin
// capability via user_global_roles/user_club_roles/user_team_roles/
// user_athletes. Multiple roles on one account are the normal case, not an
// edge case - including holding BOTH platform_admin AND independent_coach at
// once, which a single role_hint string could never represent.
import { query } from "./db.js";
import { normalizeRole } from "./access.js";

export async function loadAuthorizationContext(user) {
  if (!user) {
    return {
      userId: null,
      roleHint: null,
      platformRoles: [],
      clubRoles: [],
      teamRoles: [],
      managedTeamIds: [],
      isIndependentCoach: false,
      isAthlete: false,
      athleteId: null,
    };
  }

  const roleHint = normalizeRole(user.role_hint);

  const [globalRolesResult, clubRolesResult, teamRolesResult, athleteResult] = await Promise.all([
    query(
      `select role from public.user_global_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    query(
      `select club_id, role from public.user_club_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    query(
      `select team_id, role from public.user_team_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    // Real signal for "is this account an athlete", independent of role_hint -
    // this is what lets the same account be both athlete and coach at once.
    // Deliberately NOT filtered on the athlete profile's is_active: archiving
    // a roster profile (or deactivating a coach relationship) must never
    // revoke the athlete's own login/workspace - only club/team-scoped data
    // access is gated on active membership, checked separately elsewhere.
    query(
      `select id from public.athletes where user_id = $1 limit 1`,
      [user.id],
    ),
  ]);

  const globalRoles = new Set(globalRolesResult.rows.map((row) => row.role));

  const clubRoles = clubRolesResult.rows.map((row) => ({ clubId: row.club_id, role: row.role }));
  const clubAdminClubIds = clubRoles.filter((r) => r.role === "club_admin").map((r) => r.clubId);

  // Preload which teams fall under a club this user administers, so
  // per-request team checks never need an extra query to walk team -> club.
  let managedTeamIds = [];
  if (clubAdminClubIds.length) {
    const teamsResult = await query(
      `select id from public.teams where club_id = any($1::uuid[])`,
      [clubAdminClubIds],
    );
    managedTeamIds = teamsResult.rows.map((row) => row.id);
  }

  return {
    userId: user.id,
    roleHint,
    platformRoles: globalRoles.has("platform_admin") ? ["platform_admin"] : [],
    clubRoles,
    teamRoles: teamRolesResult.rows.map((row) => ({ teamId: row.team_id, role: row.role })),
    managedTeamIds,
    isIndependentCoach: globalRoles.has("independent_coach"),
    isAthlete: athleteResult.rows.length > 0,
    athleteId: athleteResult.rows[0]?.id || null,
  };
}

export function computeCapabilities(authz) {
  const isPlatform = authz.platformRoles.length > 0;
  const hasClubRole = authz.clubRoles.length > 0;
  const hasTeamRole = authz.teamRoles.length > 0;
  const coachWorkspace = isPlatform || hasClubRole || hasTeamRole || authz.isIndependentCoach;
  return {
    coachWorkspace,
    athleteWorkspace: authz.isAthlete,
    organizationManagement: isPlatform || hasClubRole || hasTeamRole,
    platformAdministration: isPlatform,
    canCreateAthlete: coachWorkspace,
    canCreatePlan: coachWorkspace,
  };
}

export function isPlatformAdministrator(authz) {
  return authz.platformRoles.length > 0;
}

export function canManageClub(authz, clubId) {
  if (isPlatformAdministrator(authz)) return true;
  return authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(clubId));
}

export function canManageTeamById(authz, teamId) {
  if (isPlatformAdministrator(authz)) return true;
  if (authz.teamRoles.some((r) => r.role === "team_coach" && String(r.teamId) === String(teamId))) return true;
  return authz.managedTeamIds.some((id) => String(id) === String(teamId));
}

export function canAssignClubRole(authz, clubId) {
  // Assigning a club_admin scope is itself a club-management action.
  return canManageClub(authz, clubId);
}

// Deliberately NOT canManageTeamById - that also returns true for the
// team's own team_coach (so they can manage their team's athletes day to
// day), but assigning or revoking the team_coach role itself is a
// CLUB-level staff decision: only a platform admin, or the club_admin of
// the club that owns this team, may do it. Reusing canManageTeamById here
// would let a team_coach grant themselves or anyone else more team_coach
// access on their own team - a privilege escalation via their own scope,
// found and fixed in Phase 4 PR 4 (security/scoped-role-management).
export function canAssignTeamRole(authz, teamId) {
  if (isPlatformAdministrator(authz)) return true;
  return authz.managedTeamIds.some((id) => String(id) === String(teamId));
}

export function canUsePlatformAdministration(authz) {
  return isPlatformAdministrator(authz);
}
