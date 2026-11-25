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
import { effectiveClosedModules } from "./permissionModules.js";

export async function loadAuthorizationContext(user, queryRunner = query) {
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
      rolePermissions: Object.freeze([]),
      roleAssignments: Object.freeze([]),
    };
  }

  const roleHint = normalizeRole(user.role_hint);

  const [globalRolesResult, clubRolesResult, teamRolesResult, athleteResult] = await Promise.all([
    queryRunner(
      `select role from public.user_global_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    queryRunner(
      `select club_id, role from public.user_club_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    queryRunner(
      `select team_id, role from public.user_team_roles where user_id = $1 and is_active = true`,
      [user.id],
    ),
    // Real signal for "is this account an athlete", independent of role_hint -
    // this is what lets the same account be both athlete and coach at once.
    // Deliberately NOT filtered on the athlete profile's is_active: archiving
    // a roster profile (or deactivating a coach relationship) must never
    // revoke the athlete's own login/workspace - only club/team-scoped data
    // access is gated on active membership, checked separately elsewhere.
    queryRunner(
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
    const teamsResult = await queryRunner(
      `select id from public.teams where club_id = any($1::uuid[])`,
      [clubAdminClubIds],
    );
    managedTeamIds = teamsResult.rows.map((row) => row.id);
  }

  const { rolePermissions, roleAssignments } = await loadRolePermissions(user.id, queryRunner);

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
    // Roles R2 (v84). The old helpers below (holdsClubAdminRole, canManageClub,
    // canManageTeamById, computeCapabilities, managedTeamIds, workspaces) never
    // read these two fields; only can() (permissions.js) reads rolePermissions.
    rolePermissions,
    roleAssignments,
  };
}

// The role items the account holds, per scope, from both sources (roles R2
// contract 4.1 step 6 and section 6): the basic roles its rows of the old
// tables map to, and its active non-basic assignments. One statement. Since
// roles R4 (v92, contract section 8) the words are the EFFECTIVE items of each
// holding (public.permission_user_holdings: custom -> club version -> role) and
// each entry carries the closed modules of its club, read in the same statement
// so the two can never come from different moments.
//   rolePermissions: [{ scopeType: "club" | "team" | "private", scopeId,
//                      teamIds (a club's teams, archived ones included, as
//                      managedTeamIds; empty for other scopes), words,
//                      clubId (the holding's club, null for private),
//                      closedModules (that club's EFFECTIVE ceiling: its stored rows plus
//                      the children of a closed parent, v96 / permissionModules.js) }]
//   roleAssignments: [{ assignmentId, roleId, scopeType, scopeId, expiresAt }]
// A role that is archived gives nothing. If the statement fails (a missing
// table, a permission error, a timeout), rolePermissions is marked unavailable
// ({ unavailable: true }): can() then still answers a platform admin and throws
// PermissionsUnavailableError for anyone else. Never a fallback to a constant.
export const ROLE_PERMISSIONS_SQL = `
  select h.scope_type as "scopeType", h.scope_id as "scopeId", h.role_id as "roleId", h.assignment_id as "assignmentId",
         h.expires_at as "expiresAt", h.club_id as "clubId", h.custom_role_id as "customRoleId", h.words,
         public.permission_club_closed_modules(h.club_id) as "closedModules",
         case when h.scope_type = 'club' then array(select t.id from public.teams t where t.club_id = h.scope_id order by 1) else '{}'::uuid[] end as "teamIds"
    from public.permission_user_holdings($1) h
   -- Every table the answer rests on is named in this statement itself, so an unreadable one fails it whatever the
   -- account holds (a platform admin without a role row included): the context is then marked unavailable.
   where not exists (select 1 from public.permission_role_items, public.permission_club_role_version_items,
                       public.permission_custom_role_items, public.club_permission_ceiling limit 0)`

const loggedRolePermissionFailures = new Set();

async function loadRolePermissions(userId, queryRunner) {
  let rows;
  // A caller-supplied runner may be inside the caller's own transaction
  // (dashboardSimple/previewContext.js): the read runs under a savepoint, so a
  // failure leaves that transaction usable and the request still fails closed
  // (503 permissions_unavailable), never 25P02. Outside a transaction the
  // savepoint is refused and the read runs as it is.
  const ownRunner = queryRunner === query;
  let savepoint = false;
  try {
    if (!ownRunner) savepoint = await queryRunner("savepoint authz_role_permissions").then(() => true, () => false);
    rows = (await queryRunner(ROLE_PERMISSIONS_SQL, [userId])).rows;
    if (!Array.isArray(rows)) throw new Error("no rows");
    if (savepoint) await queryRunner("release savepoint authz_role_permissions");
  } catch (error) {
    if (savepoint) await queryRunner("rollback to savepoint authz_role_permissions").catch(() => {});
    // Logged once per error code per process, so a database without v84 (a
    // test database built from a curated list) does not log on every request.
    const code = String(error?.code || "error");
    if (!loggedRolePermissionFailures.has(code)) {
      loggedRolePermissionFailures.add(code);
      console.error(`[authz] the role tables could not be read: ${code}`);
    }
    return { rolePermissions: Object.freeze({ unavailable: true }), roleAssignments: [] };
  }
  const rolePermissions = rows.map((row) => Object.freeze({
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    teamIds: Object.freeze([...(row.teamIds || [])]),
    words: Object.freeze([...(row.words || [])]),
    clubId: row.clubId ?? null,
    // The effective ceiling (v96, the licence hierarchy): the stored rows plus the children of a closed parent.
    closedModules: Object.freeze(effectiveClosedModules(row.closedModules)),
  }));
  const roleAssignments = rows.filter((row) => row.assignmentId).map((row) => Object.freeze({
    assignmentId: row.assignmentId,
    roleId: row.roleId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    expiresAt: row.expiresAt,
  }));
  return { rolePermissions: Object.freeze(rolePermissions), roleAssignments: Object.freeze(roleAssignments) };
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

// Role predicates WITHOUT the platform-admin short-circuit. canManageClub /
// canManageTeamById below are built from exactly these, and so is any caller
// that must know the SPECIFIC basis for a decision (e.g. the Training Load
// dashboard deletion log, dashboardManageBasis) - one definition, so the two
// can never drift apart.
export function holdsClubAdminRole(authz, clubId) {
  return authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(clubId));
}

export function holdsTeamCoachRole(authz, teamId) {
  return authz.teamRoles.some((r) => r.role === "team_coach" && String(r.teamId) === String(teamId));
}

// A team under a club this account administers (authz.managedTeamIds).
export function managesTeamThroughClub(authz, teamId) {
  return authz.managedTeamIds.some((id) => String(id) === String(teamId));
}

export function canManageClub(authz, clubId) {
  if (isPlatformAdministrator(authz)) return true;
  return holdsClubAdminRole(authz, clubId);
}

export function canManageTeamById(authz, teamId) {
  if (isPlatformAdministrator(authz)) return true;
  return holdsTeamCoachRole(authz, teamId) || managesTeamThroughClub(authz, teamId);
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
