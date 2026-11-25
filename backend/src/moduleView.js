import { rolelessViewHandoff } from './viewWorkspaceHandoff.js';
// Roles V-0 (docs/ai/roles-v-steps-plan.md section 3): the one question every module asks before it shows its data to a
// role holder - "may this account VIEW this module in its active workspace?" - and the one entry gate that keeps a view
// workspace (club_view / team_view, roles R4-2) away from everything but a module's listed reads.
//
//   canView(authz, workspace, module)  - the right. A platform admin in the platform workspace and an independent coach
//     in its private workspace keep today's access (R4 Q10); a club or team workspace (an old role row) and a view
//     workspace ask can() for the module's view word at the workspace's club or team (the club's licence is inside
//     can(), step 6). A view workspace answers no for a module that has not opened yet (OPEN_VIEW_MODULES). Anything
//     else answers no.
//   viewReadScope(workspace)           - the DATA context of a view workspace (ADR-002: the workspace stays the data
//     context, the word is the right): { type: "club" | "team", id }. For reads only; a write never receives it.
//   viewEntryGate(module, readRoutes)  - express middleware in front of a module's router. An account whose active
//     workspace is not a view one goes on exactly as today. A view workspace reaches ONLY the listed reads (method and
//     path), only for an open module and only with canView(); everything else is refused with the router's own answer to
//     an account without a role (403 Forbidden by default), so every write, every owner fallback and every
//     workspace-trusting write helper stays out of reach by construction (plan section 1, hazards 3 and 4). It resolves
//     the workspace READ-ONLY (never a preference write, hazard 1) and hands the route what it resolved.
//
// Rules for the V steps that use this file (the V-0 reviews):
//   - canView receives only a RESOLVED workspace (resolveActiveWorkspace* / the gate's), never one built from a request;
//     a club or team workspace exists only for an old role row (workspace.js, pinned by roles-r4-checked-gates B2).
//   - req.moduleView means "a read context for a view workspace"; a write never checks it as a permission.
//   - A gated route reads req.moduleView.workspace / .scope and does not resolve the workspace again.
//
// V-0 opened no module; V-1 opens data_configuration (routes/sourceMetrics.js) and presets (routes/taxonomy.js through
// server.js, routes/sessionTypes.js); V-2 opens athletes (routes/athletes.js, routes/positions.js, the athletes of
// routes/organization.js GET /); V-3 opens calendar (routes/calendar.js, routes/calendarEvents.js, and the gate with
// no read on routes/calendarSettings.js; calendarModuleContext.js); V-4 opens tests and tests_results (routes/tests.js,
// testsAccess.js). Each module's V pull request adds its
// key to OPEN_VIEW_MODULES, mounts the gate with its reads, adds its word to ENFORCED_PERMISSIONS and
// VIEW_WORKSPACE_USABLE_WORDS (permissions.js), and its row to backend/tests/roles-v-sweep.test.mjs.
import { isPlatformAdministrator } from "./authz.js";
import { can } from "./permissions.js";
import { VIEW_WORKSPACE_TYPES, pickFallbackWorkspace, resolveActiveWorkspaceReadOnly } from "./workspace.js";

// The view word of each module (roles R4 contract 4.1; the plan's section 2). Every word is in the VIEW package (v92).
export const MODULE_VIEW_WORDS = Object.freeze({
  data_configuration: "variables.view",
  presets: "presets.use",
  athletes: "athletes.view",
  calendar: "calendar.view",
  tests: "tests.view",
  tests_results: "tests.results.view",
  load_team: "load.view.team",
  load_athlete: "load.view.athlete",
  dashboards: "dashboards.view",
  programs: "programs.view",
  exercises: "exercises.use",
});

// The modules a view workspace may read. A module enters here only in its own V pull request, with its entry gate.
// V-6 opens Dashboards read-only.
export const OPEN_VIEW_MODULES = Object.freeze(["data_configuration", "presets", "athletes", "calendar", "tests", "tests_results", "dashboards"]);

// The base scope of each view workspace type (the club or team it names).
const VIEW_SCOPE_TYPES = Object.freeze({ club_view: "club", team_view: "team" });
// The old-role workspaces that name a club or team.
const COACH_SCOPE_TYPES = Object.freeze({ club: "club", team: "team" });

function wordOf(module) {
  if (!Object.hasOwn(MODULE_VIEW_WORDS, module)) throw new Error(`Unknown view module: ${String(module)}`);
  return MODULE_VIEW_WORDS[module];
}

export function viewReadScope(workspace) {
  const type = workspace ? VIEW_SCOPE_TYPES[workspace.type] : undefined;
  if (!type || workspace.scopeId == null || workspace.scopeId === "") return null;
  return { type, id: String(workspace.scopeId) };
}

export function canView(authz, workspace, module, { open = OPEN_VIEW_MODULES } = {}) {
  const word = wordOf(module);
  if (!workspace || !authz) return false;
  if (workspace.type === "platform") return isPlatformAdministrator(authz);
  if (workspace.type === "private_coach") return Boolean(authz.isIndependentCoach);
  const coachType = COACH_SCOPE_TYPES[workspace.type];
  if (coachType) {
    if (workspace.scopeId == null || workspace.scopeId === "") return false;
    return can(authz, word, { type: coachType, id: String(workspace.scopeId) });
  }
  const scope = viewReadScope(workspace);
  if (!scope || !open.includes(module)) return false;
  return can(authz, word, scope);
}

// "GET /", "GET /:id", "GET /:id/history": the path of one READ route, matched segment by segment against req.path
// (relative to the router's mount). Only GET can be listed (a view workspace never writes), and a POST read marked
// `postRead` whose path ends in "/query" (V-6, below). A ":name" segment matches a
// canonical UUID unless the route gives that parameter its own CLOSED pattern (`params: { name: /^…$/ }`), so a listed
// "GET /:id" can never also admit a literal sibling route of the router ("GET /active", "GET /export"); nothing else is
// a wildcard. Each module's V step still proves its list against its router's GET routes (the plan's section 4).
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// V-6: a POST that only reads (a dashboard's batch query, which takes its period and filters in the body) may be
// listed with `postRead: true`, and only when its last segment is the literal "query": no other POST can be listed.
function compileRoute(route) {
  const method = String(route?.method || "").toUpperCase();
  const path = String(route?.path || "");
  const postRead = method === "POST" && route?.postRead === true && path.split("/").filter(Boolean).at(-1) === "query";
  if ((method !== "GET" && !postRead) || !path.startsWith("/")) throw new Error(`Bad view route: ${JSON.stringify(route)}`);
  const params = route.params || {};
  const parts = path.split("/").filter(Boolean).map((p) => {
    if (!p.startsWith(":")) return (segment) => segment === p;
    if (!Object.hasOwn(params, p.slice(1))) return (segment) => UUID_SEGMENT.test(segment);
    const given = params[p.slice(1)];
    // A custom pattern is wrapped whole, `^(?:…)$`, so an alternation such as /^a|b$/ cannot match a prefix or a suffix
    // alone; the g, y and m flags are refused (g and y keep state between test() calls, m lets ^ and $ match per line).
    if (!(given instanceof RegExp) || !given.source.startsWith("^") || !given.source.endsWith("$") || /[gym]/.test(given.flags)) {
      throw new Error(`Bad view route parameter (a closed ^…$ pattern without g, y or m): ${JSON.stringify(route)}`);
    }
    const pattern = new RegExp(`^(?:${given.source})$`, given.flags);
    return (segment) => pattern.test(segment);
  });
  return (req) => {
    if (req.method !== method) return false;
    const got = String(req.path || "").split("/").filter(Boolean);
    if (got.length !== parts.length) return false;
    return parts.every((matches, i) => matches(got[i]));
  };
}

function forbidden(_req, res) {
  res.status(403).json({ error: "Forbidden" });
}

// `refuse(req, res, next)` answers what the module's router answers today to an account without a role (403 Forbidden
// unless the module says otherwise, e.g. its identical 404). A module whose routes already answer a view workspace
// read-only and fail-closed (V-2, athletes; V-3, the calendar: no context) may instead call `next()` without
// req.moduleView (V-3 also marks the request), so each route gives its own pre-V answer. `resolve` and `open` are
// injectable for the unit tests only.
export function viewEntryGate(module, readRoutes, {
  refuse = forbidden, resolve = resolveActiveWorkspaceReadOnly, open = OPEN_VIEW_MODULES,
} = {}) {
  wordOf(module);
  const routes = Object.freeze((readRoutes || []).map(compileRoute));
  return async function moduleViewEntryGate(req, res, next) {
    try {
      // Only an account with a live new-style assignment can have a view workspace (workspace.js loadViewWorkspaces); any
      // other account goes on exactly as today, without a query. A role read that failed offers no view workspace either.
      const assignments = req.authz?.roleAssignments;
      if (!req.user || !Array.isArray(assignments) || assignments.length === 0) return next();
      const { workspace, availableWorkspaces } = await resolve(req.user.id, req.authz);
      const active = workspace || pickFallbackWorkspace(availableWorkspaces);
      if (!active || !VIEW_WORKSPACE_TYPES.has(active.type)) return next();
      if (!routes.some((matches) => matches(req)) || !canView(req.authz, active, module, { open })) {
        rolelessViewHandoff(req, { workspace: active, availableWorkspaces });
        return refuse(req, res, next);
      }
      req.moduleView = Object.freeze({ module, workspace: active, scope: viewReadScope(active) });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
