import { state } from "./state.js";

export function roleLabel(user = state.currentUser) {
  const role = String(user?.role || user?.role_hint || "").toLowerCase();
  const labels = {
    platform_admin: "Platform admin",
    general_admin: "Platform admin",
    admin: "Platform admin",
    club_admin: "Club admin",
    team_admin: "Team admin",
    team_coach: "Team coach",
    coach: "Coach",
    athlete: "Athlete",
  };
  return labels[role] || labels[user?.accessScope] || "User";
}

// Once GET /api/auth/me has resolved (loadSession() has run at least once),
// `activeWorkspace` is always present on state.currentUser - even a null
// value means "resolved, but no real workspace at all", which is itself
// meaningful (never falls back to role_hint). Only the bare shape returned
// directly by /login or /invites/:token/accept (before that follow-up /me
// call completes) lacks the key entirely - that brief window is the ONLY
// place the accessScope/role_hint-derived fallback below may still apply.
function hasResolvedWorkspace(user) {
  return Boolean(user) && Object.prototype.hasOwnProperty.call(user, "activeWorkspace");
}

// The workspace types that put an account in a staff context right now -
// never role_hint, and never merely "holds a staff-capable role somewhere"
// (that's req.authz's job) - this is specifically "what is the CURRENTLY
// active workspace showing".
const STAFF_WORKSPACE_TYPES = new Set(["platform", "private_coach", "club", "team"]);

export function accessScopeLabel(user = state.currentUser) {
  const workspace = user?.activeWorkspace;
  if (workspace) {
    if (workspace.type === "platform") return "All platform data";
    if (workspace.type === "private_coach") return "Private coaching";
    if (workspace.type === "club") return workspace.label || "Club workspace";
    if (workspace.type === "team") return workspace.label || "Team workspace";
    if (workspace.type === "athlete") return "Athlete view";
  }
  if (hasResolvedWorkspace(user)) return "Workspace";
  // Legacy fallback - only before /me has resolved activeWorkspace.
  const scope = String(user?.accessScope || "").toLowerCase();
  return (
    {
      platform: "All platform data",
      club: "Club workspace",
      team: "Team workspace",
      coach: "Private coach workspace",
      athlete: "Athlete view",
    }[scope] || "Workspace"
  );
}

export function hasOrganizationAccess(user = state.currentUser) {
  if (!user) return false;
  if (hasResolvedWorkspace(user)) return STAFF_WORKSPACE_TYPES.has(user.activeWorkspace?.type);
  // Legacy fallback - only before /me has resolved activeWorkspace.
  return String(user?.accessScope || "").toLowerCase() !== "athlete";
}

export function canManageCoachProfile(user = state.currentUser) {
  if (!user || isAthleteMode()) return false;
  if (hasResolvedWorkspace(user)) return STAFF_WORKSPACE_TYPES.has(user.activeWorkspace?.type);
  // Legacy fallback - only before /me has resolved activeWorkspace.
  const role = String(user.role || user.role_hint || "").toLowerCase();
  return (
    ["coach", "team_coach", "team_admin", "club_admin", "platform_admin", "general_admin", "admin"].includes(role) ||
    ["coach", "team", "club", "platform"].includes(String(user.accessScope || "").toLowerCase())
  );
}

export function isAthleteMode() {
  return document.body.classList.contains("athlete-mode");
}

// perf/main-navigation-cache: the account id + active workspace (type and,
// where relevant, scope id) is the part of a view-cache context key that
// every cached view shares - Coaches/Organization/Program Library/Exercise
// Library/Builder drafts all differ per account and per active workspace,
// on top of whatever view-specific filters they add themselves (see
// view-cache.js's buildContextKey). Centralized here so every call site
// derives it the exact same way, rather than five slightly different
// inline reads of state.currentUser.
export function currentUserWorkspaceContextParts(user = state.currentUser) {
  return [user?.id, user?.activeWorkspace?.type, user?.activeWorkspace?.scopeId];
}
