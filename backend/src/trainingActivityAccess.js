// Shared scope/permission helpers for the Training Activity domain
// (training.activities / activity_participants / activity_components /
// the 5 typed link tables) — same shape as trainingLoadMetricsAccess.js,
// deliberately not importing from it (each feature owns its own scope
// resolution over its own tables), except isAthleteInWorkspaceScope, which
// IS the single shared source of truth for "does this athlete belong to
// what I currently manage" across every training_load/training feature.
//
// training.activities is stamped from the ACTING coach's CURRENTLY ACTIVE
// workspace at write time, never from client input — same reasoning as
// trainingLoadMetricsAccess.js's own header: an activity belongs to
// whichever workspace the coach was acting in when they recorded/
// materialized it, not to an arbitrary scope they could otherwise type
// into a request body.
import { resolveActiveWorkspace } from "./workspace.js";
import { isAthleteInWorkspaceScope } from "./trainingLoadAccess.js";

export { isAthleteInWorkspaceScope };

function scopeFromWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform" };
  if (workspace.type === "club") return { type: "club", clubId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", teamId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", userId: req.user.id };
  return { type: null }; // athlete workspace, or no workspace at all
}

function ownerContextFromWorkspace(workspace, req) {
  if (workspace?.type === "club") return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  if (workspace?.type === "team") return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  if (workspace?.type === "platform") return { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Synchronous variant for a caller that already resolved workspace itself
// this request — same "resolve once, reuse" convention as
// trainingLoadAccess.js / trainingLoadMetricsAccess.js.
export function activityScopeForWorkspace(workspace, req) {
  const scope = scopeFromWorkspace(workspace, req);
  if (scope.type !== null) scope.ownerContext = ownerContextFromWorkspace(workspace, req);
  return scope;
}

export async function resolveActivityWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return activityScopeForWorkspace(workspace, req);
}

// Per-row "may this scope manage this already-owned activity" check.
export function canManageActivityInScope(scope, activity) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return activity.owner_scope === "club" && String(activity.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return activity.owner_scope === "team" && String(activity.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return activity.owner_scope === "user" && String(activity.owner_user_id) === String(scope.userId);
  return false;
}

// List-query SQL-fragment variant — `alias` is the activities table alias
// in the calling query. Appends its own bind param(s) to the caller's
// `params` array, same convention as the rest of this app's scope
// helpers.
export function activityScopeSqlForWorkspace(scope, alias, params) {
  if (scope.type === "platform") return "true";
  if (scope.type === "club") {
    params.push(scope.clubId);
    return `(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${params.length})`;
  }
  if (scope.type === "team") {
    params.push(scope.teamId);
    return `(${alias}.owner_scope = 'team' and ${alias}.owner_team_id = $${params.length})`;
  }
  if (scope.type === "private_coach") {
    params.push(scope.userId);
    return `(${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${params.length})`;
  }
  return "false";
}
