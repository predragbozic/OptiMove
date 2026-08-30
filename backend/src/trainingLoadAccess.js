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

function externalScheduleScopeFromWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform" };
  if (workspace.type === "club") return { type: "club", clubId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", teamId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", userId: req.user.id };
  return { type: null };
}

// Hardening correction: a platform-admin-created schedule used to be
// stamped owner_scope='user'/owner_user_id=<the admin> - byte-identical
// to what a private_coach-workspace schedule for that SAME account looks
// like. That let a dual-role account (platform admin who is ALSO a
// private coach somewhere) see/manage a schedule it created as an admin
// from its own unrelated private_coach workspace. The DB's own
// owner_scope CHECK already allows 'system' for exactly this case (see
// migrations_v2/202609011000's owner_scope shape) - it was simply never
// produced here. canManageExternalScheduleInScope's platform branch
// stays unconditionally true regardless (an admin manages everything),
// so this only ever tightens the private_coach/club/team branches.
function externalScheduleOwnerContextFromWorkspace(workspace, req) {
  if (workspace?.type === "club") return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  if (workspace?.type === "team") return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  if (workspace?.type === "platform") return { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Resolves "what may this request currently manage" as ONE discriminated
// scope object, computed ONCE per request (a single resolveActiveWorkspace
// call - see the ownerContext property below) and threaded through every
// other function for that same request - never re-derived independently
// partway through. { type: null } covers both "no workspace at all" and
// the athlete workspace itself: a coach schedule route must be completely
// unreachable from an athlete workspace, even when the same account also
// holds a real coach role elsewhere - switching workspace is the only way
// back in, exactly like coachWorkspaceScopeSql's own athlete branch.
//
// Hardening correction: this used to be called once for target-validation
// scope, with resolveExternalScheduleOwnerContext (below) re-resolving the
// active workspace a SECOND, independent time later in the SAME request to
// decide what to actually stamp on the new row. A workspace switch landing
// between those two reads could validate targets against workspace A but
// create the schedule owned by workspace B. The scope object returned here
// now carries its own `ownerContext` (computed from the SAME workspace
// read), so a caller that also needs ownership uses `scope.ownerContext`
// instead of a second resolveActiveWorkspace call.
export async function resolveExternalScheduleWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return externalScheduleScopeForWorkspace(workspace, req);
}

// Same result as resolveExternalScheduleWorkspaceScope, for a caller that
// has ALREADY resolved the active workspace itself this request (e.g.
// GET /weekly, which also needs it for coachWorkspaceScopeSql's own
// athlete-visibility scoping) - lets that caller reuse the SAME
// resolveActiveWorkspace read for both purposes instead of triggering a
// second one, closing the exact race this file's own header describes.
export function externalScheduleScopeForWorkspace(workspace, req) {
  const scope = externalScheduleScopeFromWorkspace(workspace, req);
  if (scope.type !== null) scope.ownerContext = externalScheduleOwnerContextFromWorkspace(workspace, req);
  return scope;
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
