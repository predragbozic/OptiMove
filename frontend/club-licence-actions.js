// The plain side of the Club licence island (roles R4-4, docs/ai/roles-r4-4-screens-contract.md 5.1): Settings >
// Clubs draws an empty host for the chosen club (a platform administrator only); after every paint of Settings,
// syncClubLicence() reads the licence once, mounts the island into the host (React is imported lazily, only when a
// host exists) and passes the state and callbacks. Every redraw of the licence itself updates only the island.
import {
  cancelClubLicence, licence, licenceChanges, licenceDraftClosed, licenceNeedsLoad, loadClubLicence,
  saveClubLicence, setLicenceReason, toggleLicenceModule,
} from "./club-licence-data.js";

export const LICENCE_HOST_SELECTOR = "[data-club-licence-host]";

let islands = null;
let loadingIslands = null;
let lastHost = null;

function loadIslands() {
  if (islands) return Promise.resolve(islands);
  loadingIslands ??= import("./react-build/islands.js").then((mod) => { islands = mod; return mod; }).finally(() => { loadingIslands = null; });
  return loadingIslands;
}

function propsFor(host) {
  return {
    clubName: host.dataset.clubName || "",
    open: licence.open,
    loading: licence.loading,
    error: licence.error,
    view: licence.view,
    draftClosed: licenceDraftClosed(),
    changes: licenceChanges(),
    reason: licence.reason,
    command: licence.command,
    notice: licence.notice,
    noticeTone: licence.noticeTone,
    onOpen: (open) => { licence.open = open; rerender(); },
    onToggle: (module) => { toggleLicenceModule(module); rerender(); },
    onReason: (text) => { setLicenceReason(text); rerender(); },
    onCancel: () => { cancelClubLicence(); rerender(); },
    onSave: () => { void saveClubLicence(rerender); },
    onCheck: () => { void saveClubLicence(rerender, { check: true }); },
    onRetry: () => { licence.error = ""; licence.view = null; void loadClubLicence(licence.clubId, rerender); },
  };
}

function rerender() {
  if (lastHost?.isConnected) void mountInto(lastHost);
}

async function mountInto(host) {
  const mod = await loadIslands();
  if (!host.isConnected) return;
  mod.mountIsland(host, mod.ClubLicence, propsFor(host), { name: "club_licence" });
}

// After each paint of Settings: mount into the host the panel drew, or unmount the island the panel no longer shows.
export function syncClubLicence(root = globalThis.document) {
  const host = root?.querySelector?.(LICENCE_HOST_SELECTOR) || null;
  if (lastHost && lastHost !== host && islands) islands.unmountIsland(lastHost);
  lastHost = host;
  if (!host) return Promise.resolve();
  const clubId = host.dataset.clubId || "";
  if (licenceNeedsLoad(clubId)) void loadClubLicence(clubId, rerender);
  return mountInto(host);
}

// A workspace switch, a sign-out, the app's reload and closing the tab ask about an open licence write through the
// roles guards (roles-actions.js rolesMayBeLeft / handleRolesBeforeUnload count this write as a role-layer write).
