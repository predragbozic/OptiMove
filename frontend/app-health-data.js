// Settings -> App health (Option A, A2): the errors the app recorded (GET /api/app-errors/groups), for a platform admin.
// Read only: nothing here changes anything. A newer read wins over an older one (generation counter).
import { api } from "./api.js";
import { state } from "./state.js";

export function emptyAppHealth() {
  return { days: 7, role: "all", where: "all", loading: false, error: "", groups: null, selected: "", generation: 0 };
}

export function appHealthContext(data) {
  return Boolean(data?.isPlatformAdmin);
}

export async function loadAppHealth(render) {
  const h = state.appHealth;
  const generation = h.generation + 1;
  h.generation = generation;
  h.loading = true;
  h.error = "";
  render?.();
  try {
    const answer = await api(`/api/app-errors/groups?days=${encodeURIComponent(h.days)}`);
    if (h.generation !== generation) return;
    h.groups = Array.isArray(answer?.groups) ? answer.groups : [];
  } catch (error) {
    if (h.generation !== generation) return;
    h.groups = null;
    h.error = error?.status === 404 || error?.status === 403 ? "This list is only available to a platform administrator." : "The list could not be loaded. Try again.";
  } finally {
    if (h.generation === generation) { h.loading = false; render?.(); }
  }
}

export function enterAppHealthSection(render) {
  state.appHealth = { ...emptyAppHealth(), days: state.appHealth?.days || 7 };
  return loadAppHealth(render);
}

// The place of a group: a browser screen or a server route.
export function whereOf(group) {
  return group.source === "client" ? group.screen || "app" : group.routeTemplate || "/unmatched";
}

export function visibleGroups(groups, { role, where }) {
  return (groups || []).filter((g) => (role === "all" || (g.roles || []).includes(role)) && (where === "all" || whereOf(g) === where));
}

export function whereOptions(groups) {
  return [...new Set((groups || []).map(whereOf))].sort().slice(0, 40);
}
