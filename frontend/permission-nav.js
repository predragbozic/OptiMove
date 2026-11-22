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

// Settings tabs (and the sidebar's Settings entries) that a honoured word decides. Any other tab is not listed here.
const SETTINGS_TAB_WORDS = Object.freeze({
  overview: ["org.view"],
  clubs: ["org.view"],
  teams: ["org.view"],
  users: ["staff.assign"],
});

export function permissionTabAllowed(section, user = state.currentUser) {
  const words = SETTINGS_TAB_WORDS[section];
  const held = heldPermissions(user);
  if (!words || !held) return true;
  return words.some((word) => held.has(word));
}

// A team coach's or independent coach's Settings ("My team"): today's four tabs, plus the organization tabs the held words
// give (Clubs and Teams with org.view; Users with staff.assign). Never Roles, Overview or a platform tab. With no list the
// array is the one the screens always had.
const BASE_COACH_SECTIONS = Object.freeze(["athletes", "joinLinks", "presets", "icons"]);
export function coachSettingsSections(user = state.currentUser) {
  const held = heldPermissions(user);
  if (!held) return BASE_COACH_SECTIONS;
  return [
    ...(held.has("org.view") ? ["clubs", "teams"] : []),
    "athletes",
    ...(held.has("staff.assign") ? ["users"] : []),
    ...BASE_COACH_SECTIONS.slice(1),
  ];
}
