// Permissions (roles plan, step R1): the closed catalog of permission words,
// the groups a role editor will work with, the basic roles' starting sets and
// can(authz, permission, scope).
//
// R1 changes no behaviour. can() is built from the role predicates of authz.js
// and answers, for every permission routes/organization.js uses, exactly what
// the predicate it replaced answered. A permission no module has moved to yet
// is in nobody's set but the platform admin's, so it fails closed.
//
// can() answers only "who may" for the RESOURCE's scope (the club or team the
// row belongs to). It never reads the active workspace: the workspace is the
// data context and the presentation and never grants a permission
// (workspace.js). Ownership (owner_scope, ADR-002) stays a separate check.
import {
  holdsClubAdminRole,
  holdsTeamCoachRole,
  isPlatformAdministrator,
  managesTeamThroughClub,
} from "./authz.js";

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
    ["manage_teams", "Manage teams", ["org.teams.manage"]],
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

// The basic roles' starting sets, as a code constant until R2 moves them to
// the database. platform_admin: everything. club_admin and team_coach: ONLY
// the permissions routes/organization.js checks through can() today, each
// derived from the predicate it replaced:
//   - canManageClub(club)        -> the word is in club_admin;
//   - canManageTeamById(team)    -> the word is in club_admin AND team_coach
//                                   (the team's own coach passes today);
//   - canAssignClubRole(club),
//     canAssignTeamRole(team)    -> the word is in club_admin and NOT in
//                                   team_coach (a coach never assigns roles).
// Every other permission is deliberately absent from these two sets: it is
// derived in the step that moves its module (plan section 4.1), and until
// then can() refuses it for anyone but a platform admin.
export const BASIC_ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(Object.keys(PERMISSIONS)),
  club_admin: Object.freeze([
    "org.view",
    "org.teams.manage",
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

const CLUB_ADMIN_SET = new Set(BASIC_ROLE_PERMISSIONS.club_admin);
const TEAM_COACH_SET = new Set(BASIC_ROLE_PERMISSIONS.team_coach);

// Resource scopes. A scope names the club or team the row belongs to, or
// "global" for something that belongs to no club or team.
export const GLOBAL_SCOPE = Object.freeze({ type: "global" });
export function clubScope(id) {
  return { type: "club", id };
}
export function teamScope(id) {
  return { type: "team", id };
}

// May this account do `permission` on a resource of `scope`?
//   - an unknown permission word or scope type is a programming error: throws;
//   - a platform admin passes every check;
//   - global scope: a platform admin only;
//   - club scope: the club's admin, when the Club admin set holds the word;
//   - team scope: the team's coach when the Team coach set holds the word, or
//     the admin of the team's club (authz.managedTeamIds) when the Club admin
//     set holds it.
// A platform-only word never passes for anyone else, whatever the sets say.
// A club or team scope without an id (null, undefined, "") is no resource:
// nobody but a platform admin passes it.
//
// Two conventions about the scope, which the SQL twin of R2
// (public.user_has_permission) must copy exactly:
//   1. global scope = a platform admin only, WHATEVER the word. A club or
//      team word checked at global scope ("accounts.manage", "athletes.remove"
//      in routes/organization.js) means "this resource belongs to no club or
//      team", so no club's or team's role reaches it.
//   2. a club's word holds at a team under that club. A word that may be
//      assigned only for a club ("staff.assign") can therefore be checked at
//      team scope; it then passes for the admin of the team's club and never
//      for the team's own coach, unless the Team coach set holds the word too.
// The catalog's `scopeTypes` say where a role may be ASSIGNED, not which
// resource scopes a check may name.
export function can(authz, permission, scope) {
  const entry = Object.hasOwn(PERMISSIONS, permission) ? PERMISSIONS[permission] : null;
  if (!entry) throw new Error(`Unknown permission: ${String(permission)}`);
  const type = scope?.type;
  if (type !== "global" && type !== "club" && type !== "team") {
    throw new Error(`Unknown permission scope type: ${String(type)}`);
  }
  if (isPlatformAdministrator(authz)) return true;
  if (entry.platformOnly || type === "global") return false;
  if (scope.id == null || scope.id === "") return false;
  if (type === "club") {
    return CLUB_ADMIN_SET.has(permission) && holdsClubAdminRole(authz, scope.id);
  }
  return (TEAM_COACH_SET.has(permission) && holdsTeamCoachRole(authz, scope.id))
    || (CLUB_ADMIN_SET.has(permission) && managesTeamThroughClub(authz, scope.id));
}
