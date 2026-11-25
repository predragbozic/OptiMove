import { api } from "./api.js";

let mountedHost;
let modules;
let observer;

function dispose() {
  if (mountedHost) modules?.unmountIsland(mountedHost);
  mountedHost = null;
  observer?.disconnect();
}

const loadSchedules = signal => api("/api/training-load/external-schedules", { signal });

export async function mountTrainingLoadViewSchedules(root) {
  const host = root.querySelector("[data-training-load-view-schedules]");
  if (host === mountedHost) return;
  dispose();
  if (!host) return;
  try {
    modules ??= await import("./react-build/islands.js");
    if (!host.isConnected || mountedHost === host) return;
    dispose();
    mountedHost = host;
    modules.mountIsland(host, modules.TrainingLoadViewSchedules, { loadSchedules }, { name: "training_load_view_schedules" });
    observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
    observer.observe(root, { childList: true });
  } catch {
    if (host.isConnected) host.textContent = "Schedules could not be loaded. Open this tab again to retry.";
  }
}
