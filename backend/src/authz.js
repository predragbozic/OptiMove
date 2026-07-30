// Centralized authorization: loads a user's real roles/scopes once per
// request and derives every permission decision from that, instead of the
// old model where a single flat users.role_hint string doubled as both the
// UI's "which screen do I land on" hint AND the actual security boundary.
//
// role_hint remains useful as a UI default (which workspace to show first
// after login), but it is NEVER, on its own, sufficient to grant coach or
// admin capability - a generic "user" role_hint must not slip into coach
// routes just because no one bothered to set a more specific value, and an
// "athlete" role_hint must not by itself PREVENT someone from also holding
// real coach/admin capability via user_club_roles/user_team_roles/
// user_athletes. Multiple roles on one account are the normal case, not an
// edge case.
import { query } from "./db.js";
import { isPlatformAdmin, normalizeRole } from "./access.js";

// role_hint values that represent a coach-ish job function on their own,
// before any specific club/team scope is assigned. Deliberately excludes
// "user" (the generic default - grants nothing) and "athlete" (grants
// nothing by itself; real athlete capability comes from an actual linked
// athletes row, checked separately below).
const INDEPENDENT_COACH_ROLE_HINTS = new Set(["coach", "independent_coach", "fitness_coach", "trainer"]);

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
  const platform = isPlatformAdmin(user);

  const [clubRolesResult, teamRolesResult, athleteResult] = await Promise.all([
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
    platformRoles: platform ? [roleHint] : [],
    clubRoles,
    teamRoles: teamRolesResult.rows.map((row) => ({ teamId: row.team_id, role: row.role })),
    managedTeamIds,
    isIndependentCoach: INDEPENDENT_COACH_ROLE_HINTS.has(roleHint),
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

export function canAssignTeamRole(authz, teamId) {
  return canManageTeamById(authz, teamId);
}

export function canUsePlatformAdministration(authz) {
  return isPlatformAdministrator(authz);
}
