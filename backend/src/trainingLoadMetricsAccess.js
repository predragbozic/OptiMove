// Shared scope/permission helpers for the Training Load metrics catalog +
// measurements feature - reuses the app's existing authorization
// primitives (backend/src/authz.js, backend/src/workspace.js) rather than
// inventing a parallel model, mirroring trainingLoadAccess.js's own shape
// for measurement/workspace ownership and taxonomy.js's own shape for
// client-requested catalog ownership (system is platform-admin-only,
// club/team requires real management rights over that specific club/team,
// user is always available to the requester themselves).
//
// Two DIFFERENT ownership-resolution strategies are used on purpose:
//  - CATALOG objects (metric_domains/categories/definitions/structure
//    links) let the client REQUEST a scope (e.g. "create this as a club
//    definition"), validated against real rights - same as taxonomy.js's
//    resolveOwnerScope. A coach reasonably wants to choose "private to me"
//    vs "shared with my club" when adding a metric.
//  - MEASUREMENTS (events/occasions) derive ownership from the coach's
//    CURRENTLY ACTIVE workspace at write time, never from client input -
//    same as trainingLoadAccess.js's externalScheduleOwnerContextFromWorkspace.
//    A measurement belongs to whichever workspace the coach was acting in
//    when they recorded it, not to an arbitrary scope they could otherwise
//    type into a request body.
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "./authz.js";
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
// this request (avoids a second resolveActiveWorkspace read - see the
// "resolve once, reuse" convention already established elsewhere).
export function metricsScopeForWorkspace(workspace, req) {
  const scope = scopeFromWorkspace(workspace, req);
  if (scope.type !== null) scope.ownerContext = ownerContextFromWorkspace(workspace, req);
  return scope;
}

export async function resolveMetricsWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return metricsScopeForWorkspace(workspace, req);
}

// Per-row "may this scope manage this already-owned catalog row" check -
// same shape as testsAccess.js's canManageSchedule, generalized to any row
// carrying the standard owner_scope/owner_*_id columns.
export function canManageCatalogRow(req, row) {
  if (isPlatformAdministrator(req.authz)) return true;
  if (row.owner_scope === "user") return String(row.owner_user_id) === String(req.user.id);
  if (row.owner_scope === "club") return canManageClub(req.authz, row.owner_club_id);
  if (row.owner_scope === "team") return canManageTeamById(req.authz, row.owner_team_id);
  return false;
}

// Resolves the owner_scope/owner_*_id a NEW catalog object (domain,
// category, definition, or structure link) should be created with, from
// the CLIENT'S requested scope - validated against real rights, never
// trusted outright. Mirrors taxonomy.js's resolveOwnerScope exactly:
// 'system' requires platform admin, 'club'/'team' requires real
// management rights over that specific club/team, 'user' (default) is
// always available to the requester's own account.
const VALID_SCOPES = new Set(["system", "club", "team", "user"]);

export function resolveCatalogOwnerScope(req, body) {
  const requested = VALID_SCOPES.has(body?.ownerScope) ? body.ownerScope : "user";
  if (requested === "system") {
    if (!isPlatformAdministrator(req.authz)) {
      return { error: "Only a platform administrator can create shared system-wide catalog content.", status: 403 };
    }
    return { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
  }
  if (requested === "club") {
    const clubId = body?.ownerClubId;
    if (!clubId) return { error: "ownerClubId is required for club-scoped content.", status: 400 };
    if (!canManageClub(req.authz, clubId)) return { error: "That club is outside your access.", status: 403 };
    return { ownerScope: "club", ownerUserId: null, ownerClubId: clubId, ownerTeamId: null };
  }
  if (requested === "team") {
    const teamId = body?.ownerTeamId;
    if (!teamId) return { error: "ownerTeamId is required for team-scoped content.", status: 400 };
    if (!canManageTeamById(req.authz, teamId)) return { error: "That team is outside your access.", status: 403 };
    return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: teamId };
  }
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// SQL fragment for "which catalog rows are visible to this account" -
// system-scoped rows are visible to everyone; club/team-scoped rows only
// to a real manager of that specific club/team; user-scoped rows only to
// their own owner. `alias` is the table alias in the calling query (e.g.
// "d" for metric_domains). Appends its own bind params to the caller's
// `params` array, same convention as externalScheduleScopeSqlForWorkspace.
export function catalogVisibilitySql(req, alias, params) {
  if (isPlatformAdministrator(req.authz)) return "true";
  const clubIds = (req.authz.clubRoles || []).filter((r) => r.role === "club_admin").map((r) => r.clubId);
  const teamIds = new Set([
    ...(req.authz.teamRoles || []).filter((r) => r.role === "team_coach").map((r) => r.teamId),
    ...(req.authz.managedTeamIds || []),
  ]);
  params.push(req.user.id);
  const userIdx = params.length;
  params.push(clubIds.length ? clubIds : null);
  const clubIdx = params.length;
  params.push(teamIds.size ? [...teamIds] : null);
  const teamIdx = params.length;
  return `(
    ${alias}.owner_scope = 'system'
    or (${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${userIdx})
    or (${alias}.owner_scope = 'club' and $${clubIdx}::uuid[] is not null and ${alias}.owner_club_id = any($${clubIdx}::uuid[]))
    or (${alias}.owner_scope = 'team' and $${teamIdx}::uuid[] is not null and ${alias}.owner_team_id = any($${teamIdx}::uuid[]))
  )`;
}

// Per-row "may this scope manage this already-owned MEASUREMENT event"
// check - same shape as canManageExternalScheduleInScope, for
// metric_events rows (owner_scope stamped from the ACTIVE workspace at
// write time, per this file's own header).
export function canManageMetricEventInScope(scope, event) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return event.owner_scope === "club" && String(event.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return event.owner_scope === "team" && String(event.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return event.owner_scope === "user" && String(event.owner_user_id) === String(scope.userId);
  return false;
}

// List-query SQL-fragment variant of canManageMetricEventInScope, for
// filtering "every event this workspace may see/manage" without a
// per-row round trip - same convention as
// externalScheduleScopeSqlForWorkspace. `alias` is the events table alias.
export function metricEventScopeSqlForWorkspace(scope, alias, params) {
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
