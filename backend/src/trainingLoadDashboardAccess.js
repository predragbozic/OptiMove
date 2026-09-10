// Shared scope/permission helpers for the Training Load Analysis
// Dashboard feature (training_load.dashboards / dashboard_widgets /
// dashboard_widget_series / dashboard_active_selection). Mirrors
// trainingLoadMetricsAccess.js's own shape for CATALOG ownership
// (client-requested, validated against real rights), deliberately NOT
// importing from it — each feature owns its own scope resolution over
// its own tables, same convention as trainingActivityAccess.js.
//
// This feature genuinely needs TWO separate scope concepts, resolved
// independently (never conflated — that conflation was the central bug
// the design proof this migration is built from exists to fix):
//
//  - OWNER SCOPE (4-value: system/club/team/user) — who may see/edit/
//    clone/archive a dashboard ROW. Client-requested at creation time,
//    validated against real rights, same pattern as resolveCatalogOwnerScope.
//  - DATA WORKSPACE (5-value: platform/private_coach/club/team/athlete)
//    — which workspace's metric_definitions/source_connections/
//    activities/athletes a dashboard's widgets may ever read. For a
//    club/team-owned dashboard this is FORCED to equal that same club/
//    team (no independent choice). For a system-owned dashboard it is
//    always null (a template, workspace-agnostic until cloned). ONLY a
//    'user'-owned (private) dashboard genuinely picks one — and it always
//    picks the CALLER's own CURRENTLY ACTIVE workspace at creation time,
//    never an arbitrary client-supplied workspace — see
//    resolveDataWorkspaceForCreate below.
//
// Unlike every other training_load access module, the data-workspace
// shape here DOES include 'athlete' — an athlete viewing (or owning) their
// own dashboard is a real, supported case for this feature (self-view),
// unlike the coach-only measurement-write features those other modules
// guard.
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";
import { isAthleteInWorkspaceScope } from "./trainingLoadAccess.js";

export { isAthleteInWorkspaceScope };

// ------------------------------------------------------------
// Data workspace (5-value, query/read context).
// ------------------------------------------------------------

function dataWorkspaceFromActiveWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform", dataWorkspaceType: "platform", dataWorkspaceScopeId: null };
  if (workspace.type === "club") return { type: "club", dataWorkspaceType: "club", dataWorkspaceScopeId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", dataWorkspaceType: "team", dataWorkspaceScopeId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", dataWorkspaceType: "private_coach", dataWorkspaceScopeId: null, dataWorkspaceUserId: req.user.id };
  if (workspace.type === "athlete") {
    if (!req.authz.athleteId) return { type: null };
    return { type: "athlete", dataWorkspaceType: "athlete", dataWorkspaceScopeId: null, athleteWorkspaceAthleteId: req.authz.athleteId };
  }
  return { type: null };
}

// Resolves the CALLER's own currently active workspace as a data-
// workspace descriptor — used both to authorize which dashboards are
// reachable right now, and (via resolveDataWorkspaceForCreate below) to
// decide what a NEW private dashboard binds to.
export async function resolveActiveDataWorkspace(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return dataWorkspaceFromActiveWorkspace(workspace, req);
}

// Synchronous variant for a caller that already resolved the active
// workspace itself this request (resolve once, reuse — same convention
// as every other access module in this app).
export function dataWorkspaceForActiveWorkspace(workspace, req) {
  return dataWorkspaceFromActiveWorkspace(workspace, req);
}

// Does a dashboard's own stored data_workspace_type/scope_id/(implicit)
// user id match the CALLER's given data-workspace descriptor? Used for
// both "may this request query this dashboard's data" and "is this the
// dashboard this active-selection row may legally point at".
export function dataWorkspaceMatches(dataWorkspace, dashboardRow) {
  if (dataWorkspace.type === null) return false;
  if (dataWorkspace.dataWorkspaceType !== dashboardRow.data_workspace_type) return false;
  if (dataWorkspace.dataWorkspaceType === "club" || dataWorkspace.dataWorkspaceType === "team") {
    return String(dataWorkspace.dataWorkspaceScopeId) === String(dashboardRow.data_workspace_scope_id);
  }
  return true; // platform/private_coach/athlete carry no scope_id column value to compare (ownership is separate)
}

// ------------------------------------------------------------
// Owner scope (4-value, CRUD/lifecycle rights).
// ------------------------------------------------------------

const VALID_OWNER_SCOPES = new Set(["system", "club", "team", "user"]);

// Resolves the owner_scope/owner_*_id/data_workspace_* a NEW dashboard
// should be created with, from the CLIENT'S requested owner scope —
// validated against real rights, never trusted outright. Mirrors
// trainingLoadMetricsAccess.js's resolveCatalogOwnerScope for the
// owner-rights half; the data-workspace half is this feature's own
// (system=null always; club/team=forced to that same club/team;
// user=the caller's own CURRENTLY ACTIVE workspace, resolved via
// resolveActiveWorkspace so it can never be a client-chosen arbitrary
// value).
export async function resolveDashboardCreateContext(req, body) {
  if (body?.ownerScope !== undefined && body?.ownerScope !== null && !VALID_OWNER_SCOPES.has(body.ownerScope)) {
    return { error: `ownerScope must be one of ${[...VALID_OWNER_SCOPES].join(", ")}.`, status: 400 };
  }
  const requested = body?.ownerScope ?? "user";

  if (requested === "system") {
    if (!isPlatformAdministrator(req.authz)) {
      return { error: "Only a platform administrator can create a shared system template.", status: 403 };
    }
    return {
      ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null,
      dataWorkspaceType: null, dataWorkspaceScopeId: null, isTemplate: true,
    };
  }
  if (requested === "club") {
    const clubId = body?.ownerClubId;
    if (!clubId) return { error: "ownerClubId is required for club-owned dashboards.", status: 400 };
    if (!canManageClub(req.authz, clubId)) return { error: "That club is outside your access.", status: 403 };
    return {
      ownerScope: "club", ownerUserId: null, ownerClubId: clubId, ownerTeamId: null,
      dataWorkspaceType: "club", dataWorkspaceScopeId: clubId, isTemplate: false,
    };
  }
  if (requested === "team") {
    const teamId = body?.ownerTeamId;
    if (!teamId) return { error: "ownerTeamId is required for team-owned dashboards.", status: 400 };
    if (!canManageTeamById(req.authz, teamId)) return { error: "That team is outside your access.", status: 403 };
    return {
      ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: teamId,
      dataWorkspaceType: "team", dataWorkspaceScopeId: teamId, isTemplate: false,
    };
  }
  // 'user' (private) — always bound to the CALLER's own currently active
  // workspace, resolved fresh, right now, from the SAME source of truth
  // every other "what workspace am I acting in" decision in this app
  // uses. Never a client-supplied data workspace.
  const dataWorkspace = await resolveActiveDataWorkspace(req);
  if (dataWorkspace.type === null) {
    return { error: "You have no active workspace to bind a private dashboard to — switch to a real workspace first.", status: 403 };
  }
  return {
    ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null,
    dataWorkspaceType: dataWorkspace.dataWorkspaceType, dataWorkspaceScopeId: dataWorkspace.dataWorkspaceScopeId ?? null,
    isTemplate: false,
  };
}

// Per-row "may this account see/edit/archive this already-owned dashboard
// row" — same shape as canManageCatalogRow.
export function canManageDashboardRow(req, row) {
  if (isPlatformAdministrator(req.authz)) return true;
  if (row.owner_scope === "user") return String(row.owner_user_id) === String(req.user.id);
  if (row.owner_scope === "club") return canManageClub(req.authz, row.owner_club_id);
  if (row.owner_scope === "team") return canManageTeamById(req.authz, row.owner_team_id);
  return false; // 'system' templates are never individually "managed" by a non-admin — see canViewDashboardRow for read access
}

// Per-row READ visibility — broader than canManageDashboardRow: a system
// template is visible to everyone (so it can be browsed/cloned), and a
// club/team dashboard is visible to anyone whose CURRENT active data
// workspace matches it (not just those who can also edit it) — a club
// coach without admin rights can still VIEW the club's shared dashboards,
// same "viewing is broader than editing" precedent used throughout this
// app's own catalog/results visibility split.
export function canViewDashboardRow(req, row, dataWorkspace) {
  if (row.owner_scope === "system") return true;
  if (canManageDashboardRow(req, row)) return true;
  if (row.owner_scope === "user") return false; // a private dashboard is visible ONLY to its own owner (or a platform admin, above)
  return dataWorkspaceMatches(dataWorkspace, row);
}

// SQL fragment: "which dashboards may this account currently LIST/browse"
// — combines owner-manage visibility with data-workspace read visibility,
// for the list endpoint (never used for a single-row GET, which re-checks
// via canViewDashboardRow against the ACTUAL fetched row instead).
export function dashboardVisibilitySql(req, dataWorkspace, alias, params) {
  const clauses = [`${alias}.owner_scope = 'system'`];
  if (isPlatformAdministrator(req.authz)) {
    return "true";
  }
  params.push(req.user.id);
  clauses.push(`(${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${params.length})`);
  const clubIds = (req.authz.clubRoles || []).map((r) => r.clubId);
  if (clubIds.length) {
    params.push(clubIds);
    clauses.push(`(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = any($${params.length}::uuid[]))`);
  }
  const teamIds = new Set([...(req.authz.teamRoles || []).map((r) => r.teamId), ...(req.authz.managedTeamIds || [])]);
  if (teamIds.size) {
    params.push([...teamIds]);
    clauses.push(`(${alias}.owner_scope = 'team' and ${alias}.owner_team_id = any($${params.length}::uuid[]))`);
  }
  if (dataWorkspace?.dataWorkspaceType) {
    params.push(dataWorkspace.dataWorkspaceType);
    const typeIdx = params.length;
    if (dataWorkspace.dataWorkspaceScopeId != null) {
      params.push(dataWorkspace.dataWorkspaceScopeId);
      clauses.push(`(${alias}.data_workspace_type = $${typeIdx} and ${alias}.data_workspace_scope_id = $${params.length})`);
    } else {
      clauses.push(`(${alias}.data_workspace_type = $${typeIdx} and ${alias}.data_workspace_scope_id is null)`);
    }
  }
  return `(${clauses.join(" or ")})`;
}
