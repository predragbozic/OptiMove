// The plain side of the Club licence island (roles R4-4, docs/ai/roles-r4-4-screens-contract.md 5.1): Settings >
// Clubs draws an empty host for the chosen club (a platform administrator only); after every paint of Settings,
// syncClubLicence() reads that club's licence, mounts the island into the host (React is imported lazily, only when a
// host exists) and passes the state and callbacks. Every redraw of the licence itself updates only the island.
//
// The state belongs to ONE club (licence.clubId) and the host names the club on screen. The island shows and writes
// the state only when the two are the same club; otherwise it shows the read of the host's club, or - while a write of
// the earlier club is open - that write alone, under that club's own name, so it can be checked. Nothing is ever shown
// under one club's name with another club's parts, and Save never goes to a club that is not on screen.
import {
  cancelClubLicence, licence, licenceChanges, licenceDraftClosed, licenceNeedsLoad, licenceWriteOpen, loadClubLicence,
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

const hostClub = (host) => host?.dataset.clubId || "";
const onScreen = (host) => hostClub(host) !== "" && hostClub(host) === licence.clubId;

function propsFor(host) {
  const same = onScreen(host);
  const common = {
    open: licence.open,
    onOpen: (open) => { licence.open = open; rerender(); },
    onRetry: () => { licence.error = ""; licence.view = null; void loadClubLicence(hostClub(host), rerender, host.dataset.clubName || ""); },
  };
  if (!same && !licenceWriteOpen()) {
    // Another club is on screen: its read is under way (ensureLoaded); nothing of the earlier club is shown.
    return { ...common, clubName: host.dataset.clubName || "", loading: true, view: null };
  }
  return {
    ...common,
    // An open write of another club stays on screen under THAT club's name, so it can be checked.
    clubName: same ? host.dataset.clubName || licence.clubName : licence.clubName,
    elsewhere: !same,
    loading: licence.loading,
    error: licence.error,
    view: licence.view,
    draftClosed: licenceDraftClosed(),
    changes: licenceChanges(),
    reason: licence.reason,
    command: licence.command,
    notice: licence.notice,
    noticeTone: licence.noticeTone,
    onToggle: (module) => { if (onScreen(host)) toggleLicenceModule(module); rerender(); },
    onReason: (text) => { if (onScreen(host)) setLicenceReason(text); rerender(); },
    onCancel: () => { cancelClubLicence(); rerender(); },
    onSave: () => { if (onScreen(host)) void saveClubLicence(rerender); },
    onCheck: () => { void saveClubLicence(rerender, { check: true }); },
  };
}

// The club on screen is read when it is not the state's club (and no write of the earlier club is open) or when the
// state is out of date after a write.
function ensureLoaded(host) {
  const clubId = hostClub(host);
  if (licenceNeedsLoad(clubId)) void loadClubLicence(clubId, rerender, host.dataset.clubName || "");
}

function rerender() {
  if (!lastHost?.isConnected) return;
  ensureLoaded(lastHost);
  void mountInto(lastHost);
}

async function mountInto(host) {
  const mod = await loadIslands();
  if (!host.isConnected) return;
  mod.mountIsland(host, mod.ClubLicence, propsFor(host), { name: "club_licence" });
}

// After each paint of the content area (Settings and every other tab): mount into the host the panel drew, or unmount
// the island when the content no longer shows it.
export function syncClubLicence(root = globalThis.document) {
  const host = root?.querySelector?.(LICENCE_HOST_SELECTOR) || null;
  if (lastHost && lastHost !== host && islands) islands.unmountIsland(lastHost);
  lastHost = host;
  if (!host) return Promise.resolve();
  ensureLoaded(host);
  return mountInto(host);
}

// Leaving Settings: the island is unmounted at once (its host goes with the content), not at the next Settings paint.
export function leaveClubLicence() {
  if (lastHost && islands) islands.unmountIsland(lastHost);
  lastHost = null;
}

// A workspace switch, a sign-out, the app's reload and closing the tab ask about an open licence write through the
// roles guards (roles-actions.js rolesMayBeLeft / handleRolesBeforeUnload count this write as a role-layer write).
