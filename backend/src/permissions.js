// Permissions (roles plan, steps R1 and R2): the closed catalog of permission
// words, the groups a role editor will work with, and can(authz, permission,
// scope).
//
// R1 built can() from the role predicates of authz.js. R2 (migration v84)
// moves the basic roles' items to the database: can() reads the role items
// loadAuthorizationContext loaded (authz.rolePermissions) and, for every
// existing account, answers what R1 answered apart from roles.manage, which the
// seed gives to the Club admin role (roles R2 contract section 6). A permission
// no module has moved to yet is in no role, so it fails closed.
//
// can() answers only "who may" for the RESOURCE's scope (the club or team the
// row belongs to). It never reads the active workspace: the workspace is the
// data context and the presentation and never grants a permission
// (workspace.js). Ownership (owner_scope, ADR-002) stays a separate check.
import { isPlatformAdministrator } from "./authz.js";

const CLUB_TEAM = Object.freeze(["club", "team"]);
const CLUB = Object.freeze(["club"]);
const TEAM = Object.freeze(["team"]);
const GLOBAL = Object.freeze(["global"]);

function permission(module, scopeTypes, flags = {}) {
  return Object.freeze({
    module,
    scopeTypes,
    platformOnly: flags.platformOnly === true,
    systemRoleOnly: flags.systemRoleOnly === true,
  });
}

// The catalog. `scopeTypes` says where a role carrying the word may be
// ASSIGNED; a word held for a club also holds for that club's teams, so the
// resource scope passed to can() may be a team for a club-assigned word.
// `platformOnly`: only the Platform admin role ever holds it.
// `systemRoleOnly`: never in a club's own role (not delegable).
export const PERMISSIONS = Object.freeze({
  // Organization and staff
  "org.view": permission("organization", CLUB_TEAM),
  "org.teams.manage": permission("organization", CLUB),
  // Edit a club's own details (name and the fields PUT /clubs/:clubId accepts).
  // The owner, 2026-11-19: done by the platform admin and the club's admin.
  "org.club.edit": permission("organization", CLUB),
  "accounts.manage": permission("organization", CLUB, { systemRoleOnly: true }),
  "staff.assign": permission("organization", CLUB, { systemRoleOnly: true }),
  "roles.manage": permission("organization", CLUB, { systemRoleOnly: true }),
  "platform.admin": permission("organization", GLOBAL, { platformOnly: true }),
  // Athletes
  "athletes.view": permission("athletes", CLUB_TEAM),
  "athletes.manage": permission("athletes", CLUB_TEAM),
  "athletes.remove": permission("athletes", CLUB_TEAM),
  "athletes.logins.manage": permission("athletes", CLUB_TEAM),
  "athletes.library_access": permission("athletes", CLUB_TEAM),
  "join_links.manage": permission("athletes", CLUB_TEAM),
  // Programs (Builder)
  "programs.view": permission("programs", CLUB_TEAM),
  "programs.edit": permission("programs", CLUB_TEAM),
  "programs.assign": permission("programs", CLUB_TEAM),
  "programs.publish": permission("programs", CLUB_TEAM),
  "programs.rpe_settings": permission("programs", CLUB_TEAM),
  // Tags and presets
  "presets.use": permission("presets", CLUB_TEAM),
  "presets.manage": permission("presets", CLUB_TEAM),
  "exercise_lists.manage": permission("presets", CLUB_TEAM),
  // Exercises
  "exercises.use": permission("exercises", CLUB_TEAM),
  "exercises.add": permission("exercises", CLUB_TEAM),
  "exercises.media.upload": permission("exercises", CLUB_TEAM),
  "exercises.remove": permission("exercises", CLUB_TEAM),
  "exercises.blocks.manage": permission("exercises", GLOBAL, { platformOnly: true }),
  // Calendar
  "calendar.view": permission("calendar", CLUB_TEAM),
  "calendar.events.manage": permission("calendar", CLUB_TEAM),
  "calendar.settings.manage": permission("calendar", CLUB),
  // Training Load
  "load.view.team": permission("training_load", CLUB_TEAM),
  "load.view.athlete": permission("training_load", CLUB_TEAM),
  "load.schedule.manage": permission("training_load", CLUB_TEAM),
  "load.roster.decide": permission("training_load", CLUB_TEAM),
  "load.estimates.manage": permission("training_load", CLUB_TEAM),
  "load.activities.manage": permission("training_load", CLUB_TEAM),
  // Dashboards
  "dashboards.view": permission("dashboards", CLUB_TEAM),
  "dashboards.manage": permission("dashboards", CLUB_TEAM),
  // Imports
  "import.check": permission("imports", CLUB_TEAM),
  "import.link": permission("imports", CLUB_TEAM),
  "import.approve": permission("imports", TEAM),
  "import.undo": permission("imports", TEAM),
  // Tests
  "tests.view": permission("tests", CLUB_TEAM),
  "tests.results.view": permission("tests", CLUB_TEAM),
  "tests.schedule.manage": permission("tests", CLUB_TEAM),
  "tests.library.manage": permission("tests", GLOBAL, { platformOnly: true }),
  // Messages
  "messages.send": permission("messages", CLUB_TEAM),
  // Data configuration
  "variables.view": permission("data_configuration", CLUB_TEAM),
  "variables.rename_archive": permission("data_configuration", CLUB_TEAM),
  "variables.manage": permission("data_configuration", CLUB),
  "mappings.manage": permission("data_configuration", CLUB),
  "sources.connect": permission("data_configuration", CLUB),
  "platform.metrics.manage": permission("data_configuration", GLOBAL, { platformOnly: true }),
});

// One group = one area of the app = one module. `levels` is the ladder of the
// plan's section 3.0: each level is the full, cumulative list of the group's
// permissions at that level, starting with Off (nothing). A platform-only word
// belongs to its group but to no level: it can never be ticked into a role.
function ladder(steps) {
  const levels = [Object.freeze({ key: "off", label: "Off", permissions: Object.freeze([]) })];
  let held = [];
  for (const [key, label, added] of steps) {
    held = [...held, ...added];
    levels.push(Object.freeze({ key, label, permissions: Object.freeze([...held]) }));
  }
  return Object.freeze(levels);
}

function group(key, label, steps) {
  const permissions = Object.freeze(Object.keys(PERMISSIONS).filter((word) => PERMISSIONS[word].module === key));
  return Object.freeze({ key, label, permissions, levels: ladder(steps) });
}

export const PERMISSION_GROUPS = Object.freeze([
  group("organization", "Organization and staff", [
    ["view", "View", ["org.view"]],
    ["manage_teams", "Manage teams", ["org.teams.manage", "org.club.edit"]],
    ["manage_staff", "Manage staff and accounts", ["accounts.manage", "staff.assign", "roles.manage"]],
  ]),
  group("athletes", "Athletes", [
    ["view", "View", ["athletes.view"]],
    ["edit", "Add and edit", ["athletes.manage"]],
    ["full", "Full", ["athletes.remove", "athletes.logins.manage", "athletes.library_access", "join_links.manage"]],
  ]),
  group("programs", "Programs (Builder)", [
    ["view", "View", ["programs.view"]],
    ["edit", "Edit", ["programs.edit"]],
    ["full", "Full", ["programs.assign", "programs.publish", "programs.rpe_settings"]],
  ]),
  group("exercises", "Exercises", [
    ["use", "Use", ["exercises.use"]],
    ["add", "Add (with media)", ["exercises.add", "exercises.media.upload"]],
    ["full", "Full", ["exercises.remove"]],
  ]),
  group("presets", "Tags and presets", [
    ["use", "Use", ["presets.use"]],
    ["manage", "Manage", ["presets.manage", "exercise_lists.manage"]],
  ]),
  group("calendar", "Calendar", [
    ["view", "View", ["calendar.view"]],
    ["manage_events", "Manage events", ["calendar.events.manage"]],
    ["full", "Full", ["calendar.settings.manage"]],
  ]),
  group("training_load", "Training Load", [
    ["team_totals", "Team totals", ["load.view.team"]],
    ["named_athletes", "Named athletes", ["load.view.athlete"]],
    ["manage", "Manage", ["load.schedule.manage", "load.roster.decide", "load.estimates.manage", "load.activities.manage"]],
  ]),
  group("dashboards", "Dashboards", [
    ["view", "View", ["dashboards.view"]],
    ["manage", "Manage", ["dashboards.manage"]],
  ]),
  group("imports", "Imports", [
    ["check_link", "Check and link", ["import.check", "import.link"]],
    ["approve", "Approve", ["import.approve"]],
    ["full", "Full", ["import.undo"]],
  ]),
  group("tests", "Tests", [
    ["view_schedule", "View schedule", ["tests.view"]],
    ["results", "Results", ["tests.results.view"]],
    ["schedule", "Schedule", ["tests.schedule.manage"]],
  ]),
  group("messages", "Messages", [
    ["send", "Send", ["messages.send"]],
  ]),
  group("data_configuration", "Data configuration", [
    ["view", "View", ["variables.view"]],
    ["variables", "Variables", ["variables.rename_archive", "variables.manage"]],
    ["full", "Full", ["mappings.manage", "sources.connect"]],
  ]),
]);

// The basic roles' starting sets of R1, kept as a code constant ONLY as the
// oracle of R2's old-vs-new test (backend/tests/support/permissions-r1-oracle.mjs).
// Since R2 (migration v84) the basic roles' items live in the database
// (public.permission_role_items) and can() never reads this constant: it is not
// on the request path.
export const BASIC_ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(Object.keys(PERMISSIONS)),
  club_admin: Object.freeze([
    "org.view",
    "org.teams.manage",
    "org.club.edit",
    "athletes.manage",
    "athletes.remove",
    "staff.assign",
  ]),
  team_coach: Object.freeze([
    "org.view",
    "athletes.manage",
    "athletes.remove",
  ]),
});

// The honoured words (roles R2 contract 3.3): the words some can() call site
// checks at a club or a team scope - the only words a role may hold in R2. Its
// database twin is public.permission_word_honoured() (v84); a test asserts the
// two agree and that this list equals R1's call-site table taken by (word,
// scope type) with scope type club or team, plus roles.manage (the Roles API).
export const HONOURED_PERMISSIONS = Object.freeze([
  "org.view",
  "org.teams.manage",
  "org.club.edit",
  "athletes.manage",
  "athletes.remove",
  "staff.assign",
  "roles.manage",
]);

// Resource scopes. A scope names the club or team the row belongs to, the
// independent coach's own workspace ("private", the coach's user id), or
// "global" for something that belongs to no club or team.
export const GLOBAL_SCOPE = Object.freeze({ type: "global" });
export function clubScope(id) {
  return { type: "club", id };
}
export function teamScope(id) {
  return { type: "team", id };
}
export function privateScope(userId) {
  return { type: "private", id: userId };
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// The role tables could not be read for this request (loadAuthorizationContext
// marks authz.rolePermissions unavailable). can() then throws this for anyone
// but a platform admin; the global error handler answers 503
// permissions_unavailable. Never a fallback to a code constant.
export class PermissionsUnavailableError extends Error {
  constructor() {
    super("The permission tables could not be read.");
    this.name = "PermissionsUnavailableError";
    this.status = 503;
    this.code = "permissions_unavailable";
  }
}

// May this account do `permission` on a resource of `scope`? (Roles R2
// contract section 6; the SQL twin is public.user_has_permission, v84.)
//   - an unknown permission word or scope type is a programming error: throws;
//   - a platform admin passes every check (it reads platformRoles only, so the
//     platform can repair even when the role tables cannot be read);
//   - the role tables unreadable for this request: throws
//     PermissionsUnavailableError (fail closed, loudly);
//   - global scope and platform-only words: a platform admin only;
//   - a scope without an id (null, undefined, "", the nil uuid) is no resource;
//   - otherwise: true when a role the account holds for that scope has the word
//     in its items (authz.rolePermissions, loaded from the database: the basic
//     roles of the old tables and the active non-basic assignments). A club's
//     entry also holds at that club's teams.
// A context without rolePermissions (built by hand) answers false: there is no
// fallback to the R1 constant.
//
// The three conventions of R1 stay; the SQL twin of R2
// (public.user_has_permission, v84) must copy exactly:
//   1. global scope = a platform admin only, WHATEVER the word;
//   2. a club's word holds at a team under that club;
//   3. a club or team scope without an id is no resource.
// It never reads the active workspace or any other field of authz.
export function can(authz, permission, scope) {
  const entry = Object.hasOwn(PERMISSIONS, permission) ? PERMISSIONS[permission] : null;
  if (!entry) throw new Error(`Unknown permission: ${String(permission)}`);
  const type = scope?.type;
  if (type !== "global" && type !== "club" && type !== "team" && type !== "private") {
    throw new Error(`Unknown permission scope type: ${String(type)}`);
  }
  if (isPlatformAdministrator(authz)) return true;
  const entries = authz.rolePermissions;
  if (entries && !Array.isArray(entries)) throw new PermissionsUnavailableError();
  if (entry.platformOnly || type === "global") return false;
  if (scope.id == null || scope.id === "" || String(scope.id) === NIL_UUID) return false;
  if (!Array.isArray(entries)) return false;
  const id = String(scope.id);
  for (const e of entries) {
    if (!e.words.includes(permission)) continue;
    if (e.scopeType === type && String(e.scopeId) === id) return true;
    if (type === "team" && e.scopeType === "club" && e.teamIds.some((t) => String(t) === id)) return true;
  }
  return false;
}

// The permission words the account holds in its ACTIVE workspace, for `/me`
// (roles R3 PR-A; plan section 3.2: navigation follows the permissions the
// server returns). Never a second rule: each word is asked of can() itself,
// against the scope the workspace names. On top of can():
//   - an account that is not a platform admin is offered only the honoured
//     words (HONOURED_PERMISSIONS), and only in a club or team workspace: no
//     call site checks a word at another scope today, so no other word can be
//     granted by the server (the database guard keeps every role's items
//     honoured, so for a club or team this filter changes nothing);
//   - the athlete workspace and no workspace name no scope: nothing;
//   - the role tables unreadable for this request: nothing, flagged
//     (`unavailable: true`), for a platform admin as well (fail closed: the
//     list is navigation, the routes still decide);
//   - a role the account holds through a non-basic assignment counts as can()
//     says. Such an account reaches a club or team workspace only through a
//     role of the old tables (loadAvailableWorkspaces), so a word listed here
//     is never one that requireCoach (O8 (a), until R4) stands in front of.
// Pure: no query. Returns { permissions: string[], unavailable: boolean }.
const WORKSPACE_SCOPE_TYPES = Object.freeze({ platform: "global", club: "club", team: "team", private_coach: "private" });

export function permissionsForWorkspace(authz, workspace) {
  if (authz?.rolePermissions && !Array.isArray(authz.rolePermissions)) {
    return { permissions: [], unavailable: true };
  }
  const scopeType = workspace ? WORKSPACE_SCOPE_TYPES[workspace.type] : undefined;
  if (!scopeType) return { permissions: [], unavailable: false };
  const platform = isPlatformAdministrator(authz);
  // The platform workspace exists only for a platform admin; anyone else
  // could only reach "global" through a forged workspace object.
  if (scopeType === "global" && !platform) return { permissions: [], unavailable: false };
  if (!platform && scopeType !== "club" && scopeType !== "team") return { permissions: [], unavailable: false };
  const scope = scopeType === "global"
    ? GLOBAL_SCOPE
    : { type: scopeType, id: scopeType === "private" ? authz.userId : workspace.scopeId };
  const candidates = platform ? Object.keys(PERMISSIONS) : HONOURED_PERMISSIONS;
  return { permissions: candidates.filter((word) => can(authz, word, scope)), unavailable: false };
}
