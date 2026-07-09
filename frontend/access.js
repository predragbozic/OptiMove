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

export function accessScopeLabel(user = state.currentUser) {
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
  return Boolean(user) && String(user?.accessScope || "").toLowerCase() !== "athlete";
}

export function canManageCoachProfile(user = state.currentUser) {
  if (!user || document.body.classList.contains("athlete-mode")) return false;
  const role = String(user.role || user.role_hint || "").toLowerCase();
  return (
    ["coach", "team_coach", "team_admin", "club_admin", "platform_admin", "general_admin", "admin"].includes(role) ||
    ["coach", "team", "club", "platform"].includes(String(user.accessScope || "").toLowerCase())
  );
}
