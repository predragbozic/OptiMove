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
import { query } from "./db.js";

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
//
// MEMOIZED ON THE REQUEST OBJECT, via the IN-FLIGHT PROMISE itself — not
// merely the resolved value. resolveActiveWorkspace() itself reads (and
// can opportunistically WRITE) public.user_workspace_preferences, so
// calling it more than once per HTTP request is both wasteful and, worse,
// a real correctness risk. A value-only cache (`if (req._resolved) return
// req._resolved;`) still has a genuine race: two calls that both start
// before EITHER has finished its own `await resolveActiveWorkspace(...)`
// will both see the cache as empty and both trigger a real, independent
// resolution — the check only helps once the FIRST call has fully
// settled. Caching the PROMISE synchronously, before any `await` runs,
// closes this precisely: the second (or Nth) concurrent call, however soon
// it arrives, always sees the first call's own in-flight promise already
// installed on `req` and just awaits that SAME promise — one real
// resolveActiveWorkspace() execution per request, guaranteed, not merely
// "usually, once the first call happens to finish first." A rejection is
// never left cached — the next caller (later in this same request, e.g.
// after some other recoverable condition) gets a fresh attempt rather
// than being permanently stuck behind a stale failure.
export function resolveActiveDataWorkspace(req) {
  if (!req._resolvedDataWorkspacePromise) {
    req._resolvedDataWorkspacePromise = (async () => {
      const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
      return dataWorkspaceFromActiveWorkspace(workspace, req);
    })();
    req._resolvedDataWorkspacePromise.catch(() => {
      req._resolvedDataWorkspacePromise = null;
    });
  }
  return req._resolvedDataWorkspacePromise;
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
// `dataWorkspace` (optional) — a caller that already resolved the active
// workspace itself THIS request (e.g. the clone route, which needs it for
// its own authorization check before ever reaching here) passes the SAME
// snapshot in, so the 'user' branch below never triggers a second
// resolveActiveWorkspace() call. When omitted, the 'user' branch resolves
// it itself (still exactly once, thanks to resolveActiveDataWorkspace's
// own per-request memoization above).
export async function resolveDashboardCreateContext(req, body, dataWorkspace) {
  if (body?.ownerScope !== undefined && body?.ownerScope !== null && !VALID_OWNER_SCOPES.has(body.ownerScope)) {
    return { error: `ownerScope must be one of ${[...VALID_OWNER_SCOPES].join(", ")}.`, status: 400 };
  }
  if (body?.isTemplate !== undefined && typeof body.isTemplate !== "boolean") {
    return { error: "isTemplate must be a strict boolean.", status: 400 };
  }
  const requested = body?.ownerScope ?? "user";
  // A strict boolean, never silently forced to false for club/team/user —
  // only 'system' has a fixed, non-optional value (always true).
  const requestedIsTemplate = body?.isTemplate === true;

  if (requested === "system") {
    if (!isPlatformAdministrator(req.authz)) {
      return { error: "Only a platform administrator can create a shared system template.", status: 403 };
    }
    if (body?.isTemplate === false) {
      return { error: "A system dashboard is always a template.", status: 400 };
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
      dataWorkspaceType: "club", dataWorkspaceScopeId: clubId, isTemplate: requestedIsTemplate,
    };
  }
  if (requested === "team") {
    const teamId = body?.ownerTeamId;
    if (!teamId) return { error: "ownerTeamId is required for team-owned dashboards.", status: 400 };
    if (!canManageTeamById(req.authz, teamId)) return { error: "That team is outside your access.", status: 403 };
    return {
      ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: teamId,
      dataWorkspaceType: "team", dataWorkspaceScopeId: teamId, isTemplate: requestedIsTemplate,
    };
  }
  // 'user' (private) — always bound to the CALLER's own currently active
  // workspace, resolved fresh (or reused from an ALREADY-resolved
  // snapshot this same request took, see `dataWorkspace` above), from the
  // SAME source of truth every other "what workspace am I acting in"
  // decision in this app uses. Never a client-supplied data workspace.
  const resolvedDataWorkspace = dataWorkspace ?? await resolveActiveDataWorkspace(req);
  if (resolvedDataWorkspace.type === null) {
    return { error: "You have no active workspace to bind a private dashboard to — switch to a real workspace first.", status: 403 };
  }
  return {
    ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null,
    dataWorkspaceType: resolvedDataWorkspace.dataWorkspaceType, dataWorkspaceScopeId: resolvedDataWorkspace.dataWorkspaceScopeId ?? null,
    isTemplate: requestedIsTemplate,
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

// ------------------------------------------------------------
// Metric / source-connection reference pre-checks — mirror the exact
// visibility predicate the real DB triggers (dashboard_widget_series_
// validate_metric_visibility / _validate_source_connection_visibility,
// v16) enforce at write time, so a foreign or nonexistent reference can be
// rejected HERE, at the application layer, with a clean, info-hiding 404
// — BEFORE the write ever reaches the trigger, whose own detailed P0001
// message names owner_scope/club/team ids and must never reach an HTTP
// client (see routes/trainingLoadDashboard.js's respondToServiceError).
// The DB trigger remains the authoritative backstop for every other write
// path (a raw SQL statement, a future caller) — this is a pre-check, not
// a replacement.
// ------------------------------------------------------------
export async function isMetricVisibleToDashboard(dashboardRow, metricDefinitionId) {
  const r = await query(
    `select owner_scope, owner_user_id, owner_club_id, owner_team_id, state from training_load.metric_definitions where id = $1`,
    [metricDefinitionId],
  );
  const def = r.rows[0];
  if (!def) return { visible: false, def: null };
  if (def.owner_scope === "system") return { visible: true, def };
  if (dashboardRow.owner_scope === "user" && def.owner_scope === "user" && String(def.owner_user_id) === String(dashboardRow.owner_user_id)) return { visible: true, def };
  if (def.owner_scope === "club" && dashboardRow.data_workspace_type === "club" && String(def.owner_club_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, def };
  if (def.owner_scope === "team" && dashboardRow.data_workspace_type === "team" && String(def.owner_team_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, def };
  return { visible: false, def };
}

export async function isSourceConnectionVisibleToDashboard(dashboardRow, sourceConnectionId) {
  const r = await query(
    `select owner_scope, owner_user_id, owner_club_id, owner_team_id, state from training_load.metric_source_connections where id = $1`,
    [sourceConnectionId],
  );
  const conn = r.rows[0];
  if (!conn) return { visible: false, conn: null };
  if (conn.owner_scope === "system") return { visible: true, conn };
  if (dashboardRow.owner_scope === "user" && conn.owner_scope === "user" && String(conn.owner_user_id) === String(dashboardRow.owner_user_id)) return { visible: true, conn };
  if (conn.owner_scope === "club" && dashboardRow.data_workspace_type === "club" && String(conn.owner_club_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, conn };
  if (conn.owner_scope === "team" && dashboardRow.data_workspace_type === "team" && String(conn.owner_team_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, conn };
  return { visible: false, conn };
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
