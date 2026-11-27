// Navigation that follows the permissions the server returns with /me for the active workspace (roles plan R3, section
// 3.2). It only hides: every route still decides again, so nothing here is a protection.
//
// Two rules keep this safe:
//  - Fallback. When /me carries no `permissions` array (an older server), or says `permissionsUnavailable`, every
//    function here answers exactly what the screens answered before it existed.
//  - Only the words some server route actually honours (backend HONOURED_PERMISSIONS: org.view, org.teams.manage,
//    org.club.edit, athletes.manage, athletes.remove, staff.assign, roles.manage) decide visibility. A section the server
//    does not protect by a word yet (Calendar, Builder, Tests, Training Load, Athletes, Join links, Tags & Presets,
//    Icons ...) keeps today's visibility (owner Q1). Platform-only sections (Data sources, Source connections, Storage,
//    App health) stay on the workspace type and are never opened by a word: a platform admin in a club workspace is
//    returned every word, which must not show platform sections there.
import { state } from "./state.js";
import { viewModuleSettingsSections } from "./view-modules.js";

// The words of /me, or null when the screens must behave as before (no list, or the server could not read the roles).
export function heldPermissions(user = state.currentUser) {
  if (!user || user.permissionsUnavailable === true || !Array.isArray(user.permissions)) return null;
  return new Set(user.permissions.filter((word) => typeof word === "string"));
}

// `legacy` is what the screen decided before permissions existed; it is the answer whenever the list is absent.
export function holdsPermission(word, legacy = true, user = state.currentUser) {
  const held = heldPermissions(user);
  return held ? held.has(word) : legacy;
}

// Calendar's new-event entry points share the server's active-workspace permission.
export function canCreateCalendarEvents(workspaceType, user = state.currentUser) {
  return workspaceType === "private_coach" || ((workspaceType === "club" || workspaceType === "team")
    && holdsPermission("calendar.events.manage", user?.permissionsUnavailable !== true, user));
}

export function canManageExternalSchedules(user = state.currentUser) {
  const workspaceType = user?.activeWorkspace?.type;
  if (workspaceType === "platform" || workspaceType === "private_coach") return true;
  if (workspaceType !== "club" && workspaceType !== "team") return false;
  const held = heldPermissions(user);
  return Boolean(held?.has("load.view.team") && held.has("load.schedule.manage"));
}

// Library writes use the checked permissions from the selected native workspace.
export function canWriteExercise(word, user = state.currentUser) {
  const type = user?.activeWorkspace?.type;
  if (type === "platform" || type === "private_coach") return true;
  if (type === "club" || type === "team") {
    const held = heldPermissions(user);
    return Boolean(held?.has("exercises.use") && held.has(word));
  }
  return user?.activeWorkspace === undefined;
}

// Settings tabs (and the sidebar's Settings entries) that a honoured word decides. Any other tab is not listed here.
const SETTINGS_TAB_WORDS = Object.freeze({
  overview: ["org.view"],
  clubs: ["org.view"],
  teams: ["org.view"],
  users: ["staff.assign"],
});

// A view workspace (club_view / team_view, roles R4 contract 5.2): only the sections a word of /me opens, and when
// /me carries no list the answer is HIDDEN, never today's visibility - a role holder has no "before".
export const VIEW_WORKSPACE_SECTIONS = Object.freeze(["overview", "clubs", "teams"]);
const VIEW_TYPES = new Set(["club_view", "team_view"]);
export function viewSettingsSections(user = state.currentUser) {
  const held = heldPermissions(user);
  if (!held) return [];
  // V-0: a module's V step adds its Settings section (view-modules.js); none in V-0.
  return [...VIEW_WORKSPACE_SECTIONS.filter((section) => SETTINGS_TAB_WORDS[section].some((word) => held.has(word))), ...viewModuleSettingsSections(user)];
}

export function permissionTabAllowed(section, user = state.currentUser) {
  if (VIEW_TYPES.has(user?.activeWorkspace?.type)) return viewSettingsSections(user).includes(section);
  const words = SETTINGS_TAB_WORDS[section];
  const held = heldPermissions(user);
  if (!words || !held) return true;
  return words.some((word) => held.has(word));
}

// A team coach's or independent coach's Settings ("My team"): today's coach tabs intersected with the held words. A
// permission only decides whether a tab is SEEN; it never adds a tab the coach's Settings does not have (U1 removed
// Overview, Clubs, Teams and Users on purpose; manager's decision, 2026-11-22), and there is no Roles tab (Q5). None of
// today's four coach tabs stands on a honoured word (Q1), so the intersection is the same four tabs. The shape stays a
// function so a later honoured word for one of them has one place to change.
const BASE_COACH_SECTIONS = Object.freeze(["athletes", "joinLinks", "presets", "icons"]);
export function coachSettingsSections(user = state.currentUser) {
  void user;
  return BASE_COACH_SECTIONS;
}
