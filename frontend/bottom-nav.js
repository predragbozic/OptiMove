// The phone's bottom navigation bar (owner, 2026-11-24): the plain side of the React island in react/bottom-nav.jsx.
//
// What the bar offers is read from the existing menu (.sidebar in index.html / athlete.html), never decided again
// here: the same controls, hidden by the same code for the same roles (navigation.js's renderAccessNav and
// renderLibraryNav), so every role sees exactly the sections it saw in the menu. A tap runs that menu control's own
// click, so its handler - the leave guards of unsaved work, the app's history, the reset of a section - runs exactly as
// from the menu. On a phone (<= 760 px) the first four sections of the shell's list sit on the bar and the rest in its
// More sheet; wider screens keep the rail and never download React.
import { reportHandlerError } from "./app-errors-capture.js";
import { state } from "./state.js";

export const PHONE_QUERY = "(max-width: 760px)";
// The bar's own slots, per shell, in order; every other visible menu section goes to More, in the menu's order.
export const BAR_SECTIONS = Object.freeze({
  coach: Object.freeze(["home", "central-calendar", "athletes", "training-load"]),
  athlete: Object.freeze(["home", "athlete-calendar", "calendar", "tests"]),
});
const HOME_TABS = new Set(["coach-home", "athlete-home"]);
const HOME_ICON = '<svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7"></path><path d="M6 9.5V20h12V9.5"></path><path d="M10 20v-5h4v5"></path></svg>';

const isHidden = (el) => Boolean(el.hidden || el.closest("[hidden]"));
const labelOf = (el) => (el.getAttribute("title") || el.querySelector("span")?.textContent || el.textContent || "").trim();

function idOf(el) {
  if (el.id === "athletesToggle") return "athletes";
  if (el.id === "calendarToggle") return "central-calendar";
  return el.dataset.libraryTab || el.dataset.athleteTab || "";
}

// The bar's model: { shell, items, more, targets } - targets maps every id to the menu control a tap runs.
export function buildBottomNavModel(doc = globalThis.document, appState = state) {
  const sidebar = doc?.querySelector?.(".app-shell > .sidebar");
  if (!sidebar) return null;
  const shell = doc.body.classList.contains("athlete-mode") ? "athlete" : "coach";
  const targets = new Map();
  const sections = [];
  // The coach's logo runs "brand-home", the athlete's "home" (athlete.html): both open that shell's Home.
  const home = sidebar.querySelector('.brand button[data-action="brand-home"], .brand button[data-action="home"]');
  if (home) {
    targets.set("home", home);
    sections.push({ id: "home", label: "Home", icon: HOME_ICON, active: HOME_TABS.has(appState.activeTab) });
  }
  for (const el of sidebar.querySelectorAll(".rail-button")) {
    if (el.closest(".sidebar-subnav") || el.closest(".brand") || isHidden(el)) continue;
    const id = idOf(el);
    if (!id || targets.has(id)) continue;
    targets.set(id, el);
    const section = { id, label: labelOf(el), icon: el.querySelector("svg.rail-icon")?.outerHTML || "", active: el.classList.contains("is-active") };
    // The Athletes control opens the athlete list (in the menu drawer), it is not a section of its own.
    if (id === "athletes") section.active = false;
    const children = [];
    el.closest(".sidebar-submenu")?.querySelectorAll(".sidebar-subnav-button").forEach((child, index) => {
      if (isHidden(child)) return;
      const childId = `${id}/${index}`;
      targets.set(childId, child);
      children.push({ id: childId, label: child.textContent.trim(), active: child.classList.contains("is-active") });
    });
    if (children.length) section.children = children;
    sections.push(section);
  }
  const barIds = BAR_SECTIONS[shell];
  const items = barIds.map((id) => sections.find((s) => s.id === id)).filter(Boolean).map(({ children, ...rest }) => rest);
  const more = sections.filter((s) => !barIds.includes(s.id));
  return { shell, items, more, targets };
}

// A tap on the bar or in More: the menu's own control runs. Athletes opens the menu drawer with the athlete list.
export function runBottomNav(id, model, doc = globalThis.document, appState = state) {
  if (id === "athletes") {
    const menu = doc.getElementById("mobileNavToggle");
    if (appState.mobileNavOpen && appState.athletesExpanded) { menu?.click(); return true; }
    if (!appState.athletesExpanded) model.targets.get("athletes")?.click();
    if (!appState.mobileNavOpen) menu?.click();
    return true;
  }
  const target = model?.targets.get(id);
  if (!target) return false;
  target.click();
  return true;
}

let islands = null;
let loading = null;
let host = null;
let watchedSidebar = null;
let observer = null;
let queued = false;
let phoneQuery = null;

function teardown(doc) {
  if (host && islands) islands.unmountIsland(host);
  host?.remove();
  host = null;
  doc?.body?.classList.remove("has-bottom-nav");
}

// The menu's render asks for a sync after it (coalesced; never a nested React render inside the bar's own click).
export function requestBottomNavSync() { scheduleSync(); }

function scheduleSync() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; syncBottomNav(); });
}

// Called after every menu render (navigation.js renderLibraryNav) and by the watchers below; cheap when nothing changed.
export function syncBottomNav({ doc = globalThis.document, win = globalThis.window } = {}) {
  if (!doc?.body || !win) return;
  const sidebar = doc.querySelector(".app-shell > .sidebar");
  const signedIn = Boolean(state.currentUser) && Boolean(sidebar) && !doc.body.classList.contains("login-mode");
  if (!signedIn) { teardown(doc); return; }
  if (!phoneQuery && typeof win.matchMedia === "function") {
    phoneQuery = win.matchMedia(PHONE_QUERY);
    phoneQuery.addEventListener?.("change", scheduleSync);
  }
  // A menu item shown or hidden outside renderLibraryNav (e.g. "My training" once a recorded session exists).
  if (watchedSidebar !== sidebar && typeof win.MutationObserver === "function") {
    observer?.disconnect();
    observer = new win.MutationObserver(scheduleSync);
    observer.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    watchedSidebar = sidebar;
  }
  if (!islands) {
    // React is downloaded only for a phone; the bar stays mounted (hidden by CSS) if the screen later widens.
    if (!phoneQuery?.matches || loading) return;
    loading = import("./react-build/islands.js").then((mod) => { islands = mod; loading = null; scheduleSync(); }, (error) => {
      // Without the island the menu button still opens the full menu.
      loading = null;
      reportHandlerError(error, "bottom_nav_load");
    });
    return;
  }
  const model = buildBottomNavModel(doc, state);
  if (!model) { teardown(doc); return; }
  if (!host) {
    host = doc.createElement("div");
    host.className = "om-bottom-nav-host";
    doc.body.appendChild(host);
  }
  doc.body.classList.add("has-bottom-nav");
  islands.mountIsland(host, islands.BottomNav, {
    items: model.items,
    more: model.more.map(({ id, label, icon, active, children }) => ({ id, label, icon, active, children })),
    onSelect: (id) => { runBottomNav(id, buildBottomNavModel(doc, state) || model, doc, state); },
  }, { name: "bottom_nav" });
}
