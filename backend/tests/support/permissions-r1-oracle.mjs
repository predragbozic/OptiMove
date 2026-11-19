// The oracle of roles R2's old-vs-new test (roles R2 contract, section 6 and
// tests 31, 32): R1's can(), exactly as it stood at f4dd289 - built from the
// role predicates of authz.js and the code constant BASIC_ROLE_PERMISSIONS -
// kept here for the tests only. It is not on the request path.
//
// withSeededRoleItems(authz, teamsOfClub) adds to a hand-built context the
// rolePermissions R2's loader builds from the old tables and the v84 seed: the
// Club admin role (R1's set plus roles.manage) for each club_admin row, the
// Team coach role for each team_coach row, and nothing else (the Independent
// coach role has no items). teamsOfClub maps a club id to its team ids.
import {
  holdsClubAdminRole,
  holdsTeamCoachRole,
  isPlatformAdministrator,
  managesTeamThroughClub,
} from "../../src/authz.js";
import { BASIC_ROLE_PERMISSIONS, PERMISSIONS } from "../../src/permissions.js";

const CLUB_ADMIN_SET = new Set(BASIC_ROLE_PERMISSIONS.club_admin);
const TEAM_COACH_SET = new Set(BASIC_ROLE_PERMISSIONS.team_coach);

// The v84 seed (contract 3.3): R1's sets, plus roles.manage in Club admin.
export const SEEDED_ROLE_ITEMS = Object.freeze({
  club_admin: Object.freeze([...BASIC_ROLE_PERMISSIONS.club_admin, "roles.manage"]),
  team_coach: Object.freeze([...BASIC_ROLE_PERMISSIONS.team_coach]),
  independent_coach: Object.freeze([]),
  platform_admin: Object.freeze([]),
});

export function canR1(authz, permission, scope) {
  const entry = Object.hasOwn(PERMISSIONS, permission) ? PERMISSIONS[permission] : null;
  if (!entry) throw new Error(`Unknown permission: ${String(permission)}`);
  const type = scope?.type;
  if (type !== "global" && type !== "club" && type !== "team") {
    throw new Error(`Unknown permission scope type: ${String(type)}`);
  }
  if (isPlatformAdministrator(authz)) return true;
  if (entry.platformOnly || type === "global") return false;
  if (scope.id == null || scope.id === "") return false;
  if (type === "club") {
    return CLUB_ADMIN_SET.has(permission) && holdsClubAdminRole(authz, scope.id);
  }
  return (TEAM_COACH_SET.has(permission) && holdsTeamCoachRole(authz, scope.id))
    || (CLUB_ADMIN_SET.has(permission) && managesTeamThroughClub(authz, scope.id));
}

export function withSeededRoleItems(authz, teamsOfClub = {}) {
  const rolePermissions = [];
  for (const row of authz.clubRoles) {
    if (row.role !== "club_admin") continue;
    rolePermissions.push({ scopeType: "club", scopeId: row.clubId, teamIds: [...(teamsOfClub[row.clubId] || [])], words: SEEDED_ROLE_ITEMS.club_admin });
  }
  for (const row of authz.teamRoles) {
    if (row.role !== "team_coach") continue;
    rolePermissions.push({ scopeType: "team", scopeId: row.teamId, teamIds: [], words: SEEDED_ROLE_ITEMS.team_coach });
  }
  return { ...authz, rolePermissions, roleAssignments: [] };
}
