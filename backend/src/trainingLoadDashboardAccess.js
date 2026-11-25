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
import {
  canManageClub, canManageTeamById, holdsClubAdminRole, holdsTeamCoachRole, isPlatformAdministrator, managesTeamThroughClub,
} from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";
import { isAthleteInWorkspaceScope } from "./trainingLoadAccess.js";
import { query } from "./db.js";
import { calculatedDefinitionSql } from "./calculatedValues.js";
import { can } from "./permissions.js";
import { athleteTrainingLoadAllowed } from "./athleteTrainingLoadLicence.js";
import { canView, viewReadScope } from "./moduleView.js";

export { isAthleteInWorkspaceScope };

// ------------------------------------------------------------
// Roles V-6 (docs/ai/roles-v-steps-plan.md sections 2.7 and 13): dashboards in a view workspace, and dashboards.view.
//
//   - The module's entry gate (server.js) admits a view workspace (club_view / team_view) only to the listed reads; it
//     sets req.moduleView there. Every other request of a view workspace is marked req.dashboardsViewRefused and passed
//     on, so the route answers what it answers an account with no workspace, without resolving the workspace again.
//   - An admitted read's data workspace is the club or team the view names (ADR-002: the workspace stays the data
//     context); it carries `view: true` and sees only the system templates and the shared dashboards of that data
//     workspace, never through manage rights.
//   - A view workspace never manages a dashboard (canManageDashboardRow, dashboardManageBasis, the create context),
//     admitted or refused: dashboard writes do not otherwise look at the workspace.
//   - A club or team workspace (an old role row) keeps its data workspace only with can(dashboards.view) there (the
//     club's licence is inside can()); without it every route answers as for no workspace (R4 section 6).
// ------------------------------------------------------------
const VIEW_MODULE = "dashboards";

// Is this request's active workspace a view one (admitted to a listed read, or refused by the gate)?
export function isDashboardsViewRequest(req) {
  return req?.moduleView?.module === VIEW_MODULE || req?.dashboardsViewRefused === true;
}

export function dashboardWidgetsForViewer(req, widgets) {
  if (!isDashboardsViewRequest(req)) return widgets;
  return widgets.map(widget => {
    if (!Object.hasOwn(widget.presentation_config ?? {}, "referenceConfig")) return widget;
    const presentation_config = { ...widget.presentation_config };
    delete presentation_config.referenceConfig;
    return { ...widget, presentation_config };
  });
}

// The resolved workspace behind each data-workspace descriptor (the descriptor's own shape is unchanged: it is stored
// with a page request and compared on its replay).
const RESOLVED_WORKSPACE = new WeakMap();

function coachMayViewDashboards(authz, workspace) {
  if (workspace.scopeId == null || workspace.scopeId === "") return false;
  return can(authz, "dashboards.view", { type: workspace.type, id: String(workspace.scopeId) });
}

// The data context of an admitted view read: only when the gate admitted THIS view workspace and the word still holds.
function admittedViewScope(workspace, req) {
  const scope = viewReadScope(workspace);
  const admitted = req?.moduleView;
  if (!scope || admitted?.module !== VIEW_MODULE || !admitted.scope) return null;
  if (admitted.scope.type !== scope.type || String(admitted.scope.id) !== scope.id) return null;
  return canView(req.authz, workspace, VIEW_MODULE) ? scope : null;
}

// ------------------------------------------------------------
// Data workspace (5-value, query/read context).
// ------------------------------------------------------------

function dataWorkspaceFromActiveWorkspace(workspace, req) {
  const described = describeDataWorkspace(workspace, req);
  if (described.type !== null) RESOLVED_WORKSPACE.set(described, workspace);
  return described;
}

function describeDataWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform", dataWorkspaceType: "platform", dataWorkspaceScopeId: null };
  if (workspace.type === "club") return coachMayViewDashboards(req.authz, workspace) ? { type: "club", dataWorkspaceType: "club", dataWorkspaceScopeId: workspace.scopeId } : { type: null };
  if (workspace.type === "team") return coachMayViewDashboards(req.authz, workspace) ? { type: "team", dataWorkspaceType: "team", dataWorkspaceScopeId: workspace.scopeId } : { type: null };
  if (workspace.type === "private_coach") return { type: "private_coach", dataWorkspaceType: "private_coach", dataWorkspaceScopeId: null, dataWorkspaceUserId: req.user.id };
  if (workspace.type === "athlete") {
    if (!req.authz.athleteId) return { type: null };
    // dataWorkspaceUserId (the ATHLETE'S OWN login account id, req.user.id
    // — same identity dataWorkspaceMatches compares against a private
    // dashboard's own owner_user_id) closes finding #1's account-identity
    // gap: private_coach/athlete both carry data_workspace_scope_id=NULL,
    // so type-matching alone previously treated EVERY private_coach (or
    // EVERY athlete) workspace as interchangeable, regardless of whose it
    // was.
    return { type: "athlete", dataWorkspaceType: "athlete", dataWorkspaceScopeId: null, dataWorkspaceUserId: req.user.id, athleteWorkspaceAthleteId: req.authz.athleteId };
  }
  const view = admittedViewScope(workspace, req);
  if (view) return { type: view.type, dataWorkspaceType: view.type, dataWorkspaceScopeId: view.id, view: true };
  return { type: null };
}

// May this request's dashboard answers carry rows per athlete (load.view.athlete)? Not limited in the platform, a
// private coach's or an athlete's own workspace; in a club or team workspace, and a view one, canView(load_athlete) at
// its scope (a view workspace: only once Training Load's V step opens load_athlete).
// The athletes a filter names are athlete-level data too (V-6 security review, HIGH): without load.view.athlete a
// dashboard's default_filter, a page's default_filter and a widget's local_filter_override are returned with
// athleteIds set to null (the rest of the filter unchanged). Pure; returns a copy.
export function withoutFilterAthletes(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter) || !Object.hasOwn(filter, "athleteIds")) return filter;
  return { ...filter, athleteIds: null };
}

export function redactDashboardAthleteFilters({ dashboard, page, pages, widgets } = {}) {
  const out = {};
  if (dashboard !== undefined) out.dashboard = dashboard && { ...dashboard, default_filter: withoutFilterAthletes(dashboard.default_filter) };
  if (page !== undefined) out.page = page && { ...page, default_filter: withoutFilterAthletes(page.default_filter) };
  if (pages !== undefined) out.pages = (pages || []).map((p) => ({ ...p, default_filter: withoutFilterAthletes(p.default_filter) }));
  if (widgets !== undefined) out.widgets = (widgets || []).map((w) => ({ ...w, local_filter_override: withoutFilterAthletes(w.local_filter_override) }));
  return out;
}

export function dashboardNamedAthletesAllowed(req, dataWorkspace) {
  if (!dataWorkspace || dataWorkspace.type === null) return false;
  if (dataWorkspace.dataWorkspaceType !== "club" && dataWorkspace.dataWorkspaceType !== "team") return true;
  const workspace = RESOLVED_WORKSPACE.get(dataWorkspace);
  return Boolean(workspace) && canView(req.authz, workspace, "load_athlete")
    && (!viewReadScope(workspace) || canView(req.authz, workspace, "athletes"));
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
      // V-6: a view workspace is never resolved again here (the gate resolved it read-only): an admitted read takes
      // the gate's workspace, a refused request answers as for no workspace.
      if (req.dashboardsViewRefused === true) return { type: null };
      if (req.moduleView?.module === VIEW_MODULE) return dataWorkspaceFromActiveWorkspace(req.moduleView.workspace, req);
      const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
      if (workspace?.type === "athlete" && !(await athleteTrainingLoadAllowed(req.authz?.athleteId))) return { type: null };
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
  if (dataWorkspace.dataWorkspaceType === "private_coach" || dataWorkspace.dataWorkspaceType === "athlete") {
    // Only a 'user'-owned (private) dashboard can EVER carry this data
    // workspace type (club/team dashboards are forced to 'club'/'team',
    // system dashboards to null — enforced by the DB CHECK on
    // training_load.dashboards) — so its own owner_user_id IS the account
    // identity this workspace belongs to. Finding #1: a bare type match
    // used to be treated as sufficient, letting one private_coach (or
    // athlete) account's active workspace "match" ANY OTHER account's
    // private_coach/athlete-bound dashboard — including a platform admin's
    // own private workspace matching a coach's totally unrelated one.
    return dashboardRow.owner_user_id != null && String(dataWorkspace.dataWorkspaceUserId) === String(dashboardRow.owner_user_id);
  }
  return true; // 'platform' carries no scope_id/account identity to compare — every platform-workspace viewer shares the same platform context
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

  // V-6: a view workspace creates nothing; each owner answers what an account without that right gets.
  const viewRequest = isDashboardsViewRequest(req);
  if (requested === "system") {
    if (viewRequest || !isPlatformAdministrator(req.authz)) {
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
    // V-6 (code review HIGH): a create does not resolve the workspace, so it asks dashboards.view at the owner itself;
    // without it (the word taken from the role, or the licence closed) the answer of an account without that club.
    if (viewRequest || !canManageClub(req.authz, clubId) || !can(req.authz, "dashboards.view", { type: "club", id: String(clubId) })) return { error: "That club is outside your access.", status: 403 };
    return {
      ownerScope: "club", ownerUserId: null, ownerClubId: clubId, ownerTeamId: null,
      dataWorkspaceType: "club", dataWorkspaceScopeId: clubId, isTemplate: requestedIsTemplate,
    };
  }
  if (requested === "team") {
    const teamId = body?.ownerTeamId;
    if (!teamId) return { error: "ownerTeamId is required for team-owned dashboards.", status: 400 };
    if (viewRequest || !canManageTeamById(req.authz, teamId) || !can(req.authz, "dashboards.view", { type: "team", id: String(teamId) })) return { error: "That team is outside your access.", status: 403 };
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
  if (isDashboardsViewRequest(req)) return false; // V-6: a view workspace never manages a dashboard
  if (isPlatformAdministrator(req.authz)) return true;
  if (row.owner_scope === "user") return String(row.owner_user_id) === String(req.user.id);
  if (row.owner_scope === "club") return canManageClub(req.authz, row.owner_club_id);
  if (row.owner_scope === "team") return canManageTeamById(req.authz, row.owner_team_id);
  return false; // 'system' templates are never individually "managed" by a non-admin — see canViewDashboardRow for read access
}

// On what authority may this account manage this row — for the deletion
// log (v19). Mirrors canManageDashboardRow exactly (non-null iff it
// returns true), but reports the most specific basis first: an admin who
// is also the owner is 'owner'; 'platform_admin' means the admin override
// was the ONLY reason. A club admin managing a team under their club
// (authz.managedTeamIds) is 'club_admin'. Built from the same role
// predicates canManageClub/canManageTeamById use (authz.js), minus their
// platform-admin short-circuit - agreement is by construction, and pinned
// by a matrix test.
export function dashboardManageBasis(req, row) {
  const authz = req.authz;
  if (isDashboardsViewRequest(req)) return null; // V-6: as canManageDashboardRow
  if (row.owner_scope === "user" && String(row.owner_user_id) === String(req.user.id)) return "owner";
  if (row.owner_scope === "club" && holdsClubAdminRole(authz, row.owner_club_id)) return "club_admin";
  if (row.owner_scope === "team") {
    if (holdsTeamCoachRole(authz, row.owner_team_id)) return "team_coach";
    if (managesTeamThroughClub(authz, row.owner_team_id)) return "club_admin";
  }
  if (isPlatformAdministrator(authz)) return "platform_admin";
  return null;
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
  // V-6: an admitted view read sees a shared dashboard of its own data workspace, and nothing through manage rights.
  if (dataWorkspace?.view === true) return row.owner_scope !== "user" && dataWorkspaceMatches(dataWorkspace, row);
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
    `select d.owner_scope, d.owner_user_id, d.owner_club_id, d.owner_team_id, d.state, ${calculatedDefinitionSql("d")} as calculated,
            (select to_jsonb(dv.*) -> 'calculation' ->> 'kind' from training_load.metric_definition_versions dv
              where dv.id = d.current_version_id) as calculation_kind
       from training_load.metric_definitions d where d.id = $1`,
    [metricDefinitionId],
  );
  const def = r.rows[0];
  if (!def) return { visible: false, def: null };
  // J21: an athlete's own dashboards never take a calculated variable; it answers like a foreign one.
  if (def.calculated && dashboardRow.data_workspace_type === "athlete") return { visible: false, def: null };
  if (def.owner_scope === "system") return { visible: true, def };
  if (dashboardRow.owner_scope === "user" && def.owner_scope === "user" && String(def.owner_user_id) === String(dashboardRow.owner_user_id)) return { visible: true, def };
  if (def.owner_scope === "club" && dashboardRow.data_workspace_type === "club" && String(def.owner_club_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, def };
  if (def.owner_scope === "team" && dashboardRow.data_workspace_type === "team" && String(def.owner_team_id) === String(dashboardRow.data_workspace_scope_id)) return { visible: true, def };
  // v55 (O7): a team's dashboards may use the variables of the team's own club - an active team of an active club.
  // The same rule as the trigger, which stays the authoritative backstop; anything else answers like a foreign definition.
  if (def.owner_scope === "club" && dashboardRow.data_workspace_type === "team") {
    const own = await query(
      `select 1 from public.teams t join public.clubs c on c.id = t.club_id
        where t.id = $1 and t.club_id = $2 and coalesce(t.is_active, true) and coalesce(c.is_active, true)`,
      [dashboardRow.data_workspace_scope_id, def.owner_club_id],
    );
    if (own.rowCount) return { visible: true, def };
  }
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
  // V-6: an admitted view read lists the system templates and the shared dashboards of its data workspace only (no
  // owner clause, no platform admin's shortcut), the twin of canViewDashboardRow's view branch.
  if (dataWorkspace?.view === true) {
    params.push(dataWorkspace.dataWorkspaceType, dataWorkspace.dataWorkspaceScopeId);
    clauses.push(`(${alias}.owner_scope <> 'user' and ${alias}.data_workspace_type = $${params.length - 1} and ${alias}.data_workspace_scope_id = $${params.length}::uuid)`);
    return `(${clauses.join(" or ")})`;
  }
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
  // Data-workspace READ visibility - mirrors canViewDashboardRow's last
  // branch, which only ever reaches dataWorkspaceMatches() for a SHARED
  // (club/team-owned) dashboard (for today's roles; the club/team owner
  // clauses above are wider than canManageClub/canManageTeamById for any
  // future non-admin role - see docs/ai/CURRENT_STATE.md, Open risks): a 'user'-owned private dashboard is
  // visible to its owner (the clause above) or a platform admin, NEVER via
  // a workspace match. Without the owner_scope guard here this clause
  // listed every OTHER account's private dashboard whose stored data
  // workspace happened to equal the caller's - every private coach's
  // (`private_coach` + null scope) board to every other private coach, and
  // one club coach's private board to every colleague active in the same
  // club/team. The single-row GET always re-checked via canViewDashboardRow
  // and 404'd, so what leaked was the LIST row itself - id, name,
  // description, owner_scope/owner ids, data-workspace binding, status,
  // revision, timestamps - never the widgets, series or query data.
  if (dataWorkspace?.dataWorkspaceType) {
    params.push(dataWorkspace.dataWorkspaceType);
    const typeIdx = params.length;
    if (dataWorkspace.dataWorkspaceScopeId != null) {
      params.push(dataWorkspace.dataWorkspaceScopeId);
      clauses.push(`(${alias}.owner_scope <> 'user' and ${alias}.data_workspace_type = $${typeIdx} and ${alias}.data_workspace_scope_id = $${params.length})`);
    } else {
      clauses.push(`(${alias}.owner_scope <> 'user' and ${alias}.data_workspace_type = $${typeIdx} and ${alias}.data_workspace_scope_id is null)`);
    }
  }
  return `(${clauses.join(" or ")})`;
}
