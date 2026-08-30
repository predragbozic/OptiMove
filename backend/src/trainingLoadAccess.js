// Shared scope/permission helpers for training_load.external_schedules -
// a training_load-owned copy of testsAccess.js's own shape, deliberately
// NOT imported from that file: training_load must mirror the WELLNESS
// (tests.*) authorization PATTERN without taking a dependency on tests.*
// internals. external_schedules follows the exact same owner_scope/
// owner_user_id/owner_club_id/owner_team_id shape testsAccess.js's own
// tests.test_schedules already uses, so "who may manage this schedule" is
// decided the same way "who may manage this club/team" already is
// everywhere else in the app.
//
// Hardening correction: every function here now resolves against the
// account's CURRENTLY ACTIVE workspace, never its full global role set.
// The original shape (isPlatformAdministrator/canManageClub/
// canManageTeamById, all read straight off req.authz) let a dual-role
// coach - say, club_admin of BOTH Club A and Club B - list, edit, target,
// or remind against Club B's external schedules while sitting in the
// Club A workspace, simply because the SAME account also happened to
// manage Club B somewhere else. That's exactly the workspace-scoping bug
// GET /weekly's own coachWorkspaceScopeSql (routes/trainingLoad.js) was
// already built to avoid for athlete visibility - this file now applies
// the identical discipline to schedule ownership/management/targeting.
import { resolveActiveWorkspace } from "./workspace.js";

// Resolves "what may this request currently manage" as ONE discriminated
// scope object, computed ONCE per request and threaded through every
// other function below - never re-derived from req.authz directly by any
// of them. { type: null } covers both "no workspace at all" and the
// athlete workspace itself: a coach schedule route must be completely
// unreachable from an athlete workspace, even when the same account also
// holds a real coach role elsewhere - switching workspace is the only way
// back in, exactly like coachWorkspaceScopeSql's own athlete branch.
export async function resolveExternalScheduleWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform" };
  if (workspace.type === "club") return { type: "club", clubId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", teamId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", userId: req.user.id };
  return { type: null };
}

export function canManageExternalScheduleInScope(scope, schedule) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return schedule.owner_scope === "club" && String(schedule.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return schedule.owner_scope === "team" && String(schedule.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return schedule.owner_scope === "user" && String(schedule.owner_user_id) === String(scope.userId);
  return false;
}

// List-query equivalent of canManageExternalScheduleInScope's own per-row
// check - appends its own param(s) to the caller's params array (matching
// this file's existing SQL-fragment-builder convention) and returns just
// the boolean SQL fragment.
export function externalScheduleScopeSqlForWorkspace(scope, params) {
  if (scope.type === "platform") return "true";
  if (scope.type === "club") {
    params.push(scope.clubId);
    return `(s.owner_scope = 'club' and s.owner_club_id = $${params.length})`;
  }
  if (scope.type === "team") {
    params.push(scope.teamId);
    return `(s.owner_scope = 'team' and s.owner_team_id = $${params.length})`;
  }
  if (scope.type === "private_coach") {
    params.push(scope.userId);
    return `(s.owner_scope = 'user' and s.owner_user_id = $${params.length})`;
  }
  return "false";
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
