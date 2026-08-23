// Shared scope/permission helpers for the Tests module (Phase 2) - reuses
// the app's existing authorization primitives rather than inventing a
// parallel scope model. tests.test_schedules follows the exact same
// owner_scope/owner_user_id/owner_club_id/owner_team_id pattern already used
// by tests.test/tests.test_battery (Tests v4.2, untouched here) - "who may
// manage this schedule" is decided the same way "who may manage this
// club/team" already is everywhere else in the app.
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";

// A schedule is manageable by: a platform admin, the exact independent coach
// who owns a 'user'-scoped schedule, a club_admin of a 'club'-scoped
// schedule's club, or a team_coach (or the club_admin of its club) of a
// 'team'-scoped schedule's team - i.e. exactly canManageClub/canManageTeamById,
// mirrored from tests.test_schedules' own ownership CHECK.
export function canManageSchedule(req, schedule) {
  if (isPlatformAdministrator(req.authz)) return true;
  if (schedule.owner_scope === "user") return String(schedule.owner_user_id) === String(req.user.id);
  if (schedule.owner_scope === "club") return canManageClub(req.authz, schedule.owner_club_id);
  if (schedule.owner_scope === "team") return canManageTeamById(req.authz, schedule.owner_team_id);
  return false;
}

// Derives the owner_scope/owner_*_id a NEW schedule should be created with,
// from the coach's own currently-active workspace (backend/src/workspace.js) -
// the same "which context am I acting in right now" concept already driving
// Organization's data-context filtering, reused here instead of asking the
// coach to redundantly re-pick a scope the app already knows. A platform
// workspace (or any workspace type with no natural club/team home) falls
// back to owner_scope='user' scoped to the acting coach themselves - a
// platform admin's own ad hoc schedule, matching created_by_user_id anyway.
export async function resolveScheduleOwnerContext(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (workspace?.type === "club") {
    return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  }
  if (workspace?.type === "team") {
    return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  }
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Which club/team ids this coach may manage - used to build the "give me
// every schedule I may manage" WHERE clause without re-deriving the same
// sets query by query. Platform admins get a sentinel the caller interprets
// as "no scope filter at all" (see routes/tests.js).
export function manageableClubIds(authz) {
  if (isPlatformAdministrator(authz)) return null;
  return (authz.clubRoles || []).filter((r) => r.role === "club_admin").map((r) => r.clubId);
}

export function manageableTeamIds(authz) {
  if (isPlatformAdministrator(authz)) return null;
  const direct = (authz.teamRoles || []).filter((r) => r.role === "team_coach").map((r) => r.teamId);
  return [...new Set([...direct, ...(authz.managedTeamIds || [])])];
}
