// Shared scope/permission helpers for training_load.external_schedules -
// a training_load-owned copy of testsAccess.js's own shape, deliberately
// NOT imported from that file: training_load must mirror the WELLNESS
// (tests.*) authorization PATTERN without taking a dependency on tests.*
// internals. external_schedules follows the exact same owner_scope/
// owner_user_id/owner_club_id/owner_team_id shape testsAccess.js's own
// tests.test_schedules already uses, so "who may manage this schedule" is
// decided the same way "who may manage this club/team" already is
// everywhere else in the app.
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";

export function canManageExternalSchedule(req, schedule) {
  if (isPlatformAdministrator(req.authz)) return true;
  if (schedule.owner_scope === "user") return String(schedule.owner_user_id) === String(req.user.id);
  if (schedule.owner_scope === "club") return canManageClub(req.authz, schedule.owner_club_id);
  if (schedule.owner_scope === "team") return canManageTeamById(req.authz, schedule.owner_team_id);
  return false;
}

// Derives the owner_scope/owner_*_id a NEW schedule should be created
// with, from the coach's own currently-active workspace - the coach never
// manually re-picks a scope. A workspace type with no natural club/team
// home (platform, private_coach) falls back to owner_scope='user' scoped
// to the acting coach themselves.
export async function resolveExternalScheduleOwnerContext(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (workspace?.type === "club") {
    return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  }
  if (workspace?.type === "team") {
    return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  }
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

export function manageableClubIds(authz) {
  if (isPlatformAdministrator(authz)) return null;
  return (authz.clubRoles || []).filter((r) => r.role === "club_admin").map((r) => r.clubId);
}

export function manageableTeamIds(authz) {
  if (isPlatformAdministrator(authz)) return null;
  const direct = (authz.teamRoles || []).filter((r) => r.role === "team_coach").map((r) => r.teamId);
  return [...new Set([...direct, ...(authz.managedTeamIds || [])])];
}
