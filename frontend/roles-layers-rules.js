// Roles R4-4, PR B (docs/ai/roles-r4-4-screens-contract.md 5.2-5.6): the rules every word list of the role layers
// shares - a club's version of a built-in role and one person's custom role. Pure functions over the R2 catalog
// (GET /api/organization/roles/catalog) and the R4-3 reads; the islands import this module by a relative path, so it
// is the same module the plain side and the tests use. Nothing here is the protection: the server refuses every word
// these rules lock.
import { permissionLabel } from "./roles-view.js";

// The words a Club admin always keeps (R2 rule 7 inside a club; the server's club_admin_requires).
export const CLUB_ADMIN_REQUIRED = Object.freeze(["staff.assign", "roles.manage"]);

// The sentence of a locked word, or "" when it can be changed. `ctx`: { catalog, closedModules, basicKey, platform,
// ticked }.
export function wordLock(word, { catalog, closedModules = [], basicKey = "", platform = false, ticked = false }) {
  const cat = (catalog?.permissions || []).find((p) => p.word === word);
  if (!cat) return "Not known.";
  if (closedModules.includes(cat.module)) return "Not in your club's licence";
  // O6: a word no part of the app checks yet is never added or taken away; it shows what is stored.
  if (!cat.checked) return "Not available yet";
  if (basicKey === "club_admin" && CLUB_ADMIN_REQUIRED.includes(word)) return "A Club admin always has this";
  if (!platform && !ticked && !(catalog.held || []).includes(word)) return "You don't have this yourself";
  return "";
}

// The groups of a word list: each module's words that the role can hold at all (not platform-only; a word only the
// Club admin role may hold appears only for it; a word of no scope the role is given for is left out).
export function roleWordGroups(catalog, { basicKey = "", scopeTypes = [] } = {}) {
  const byWord = new Map((catalog?.permissions || []).map((p) => [p.word, p]));
  return (catalog?.groups || []).map((group) => ({
    key: group.key,
    label: group.label,
    words: group.permissions.filter((word) => {
      const p = byWord.get(word);
      if (!p || p.platformOnly) return false;
      if (p.systemRoleOnly && basicKey !== "club_admin") return false;
      return !scopeTypes.length || p.scopeTypes.some((t) => scopeTypes.includes(t));
    }),
  })).filter((group) => group.words.length);
}

// The difference of a draft from its base, as the R4-3 writes take it.
export function itemChanges(base = [], draft = []) {
  const b = new Set(base);
  const d = new Set(draft);
  return { add: [...d].filter((w) => !b.has(w)).sort(), remove: [...b].filter((w) => !d.has(w)).sort() };
}

export const wordLabel = permissionLabel;
export const wordsText = (words) => (words || []).map(permissionLabel).join(", ");

// One sentence per stable code of the R4-3 routes (contract 5.6). A club admin never sees a code or an id.
export function layersRefusalText(info) {
  const words = wordsText(info.words);
  switch (info.code) {
    case "notFound": return "This is no longer available.";
    case "version_changed":
    case "custom_changed": return "Someone changed this meanwhile. The newest version is shown; check your ticks and save again.";
    case "question_outdated": return "The question has changed. The newest is shown.";
    case "permission_not_available_yet": return `Not available yet: ${words}.`;
    case "closed_by_club_ceiling": return `Not in your club's licence: ${words}.`;
    case "permission_not_held":
    case "role_exceeds_your_permissions": return `You can't give what you don't have yourself${words ? `: ${words}` : ""}.`;
    case "club_admin_requires": return "A Club admin always keeps: Give roles to people, Create and change roles.";
    case "club_admin_would_lack": return "A club's Club admin would lose a right its coaches have.";
    case "admin_not_narrowable": return "Only OptiMove can change a club administrator.";
    case "self_custom": return "You can't change your own access.";
    case "custom_exists":
    case "holding_ambiguous": return "This person's access changed meanwhile. Reload and try again.";
    case "try_again": return "The server is busy. Nothing was written. Try again in a moment.";
    case "permissions_unavailable": return "Permissions could not be checked right now. Try again in a moment.";
    case "request_key_reused": return "This change was already sent with other content. Reload and try again.";
    // No server sentence for a club admin (frontend.md, Interaction principles).
    default: return info.status === 400 ? "Nothing was saved. Check the changes and try again." : "Nothing was saved.";
  }
}

// Check result: only an answer the server gives after reading its request record (or about the body itself) settles
// the first request; a 404, a busy server or no answer come before that record.
const SETTLING = new Set([
  "version_changed", "custom_changed", "question_outdated", "permission_not_available_yet", "closed_by_club_ceiling",
  "permission_not_held", "role_exceeds_your_permissions", "club_admin_requires", "club_admin_would_lack",
  "admin_not_narrowable", "self_custom", "custom_exists", "holding_ambiguous", "request_key_reused",
]);
export const layersCheckSettles = (info) => info.status === 400 || SETTLING.has(info.code);
