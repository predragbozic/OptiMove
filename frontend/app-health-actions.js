// Settings -> App health (A2): events. Reading only.
import { loadAppHealth } from "./app-health-data.js";
import { state } from "./state.js";

export async function handleAppHealthAction(action, { render }) {
  const type = action.dataset.action;
  if (!type || !type.startsWith("app-health-")) return false;
  const h = state.appHealth;
  if (type === "app-health-refresh") { await loadAppHealth(render); return true; }
  if (type === "app-health-days") {
    const days = Number(action.dataset.days);
    if (![1, 7, 30].includes(days)) return true;
    h.days = days; h.selected = "";
    await loadAppHealth(render);
    return true;
  }
  if (type === "app-health-role") { h.role = action.dataset.role || "all"; h.selected = ""; render(); return true; }
  if (type === "app-health-where") { h.where = action.dataset.where || "all"; h.selected = ""; render(); return true; }
  if (type === "app-health-open") {
    const fp = action.dataset.fingerprint || "";
    h.selected = h.selected === fp ? "" : fp;
    render();
    return true;
  }
  return true;
}
