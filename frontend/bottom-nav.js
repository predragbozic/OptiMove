// The phone's bottom navigation bar (owner, 2026-11-24): the plain side of the React island in react/bottom-nav.jsx.
//
// What the bar offers is read from the existing menu (.sidebar in index.html / athlete.html), never decided again
// here: the same controls, hidden by the same code for the same roles (navigation.js's renderAccessNav and
// renderLibraryNav), so every role sees exactly the sections it saw in the menu. A tap runs that menu control's own
// click, so its handler - the leave guards of unsaved work, the app's history, the reset of a section - runs exactly as
// from the menu. On a phone (<= 760 px) Home is always first on the bar, the next three places are the person's own
// choice (Edit menu, in More) with a default per role, and every other section is in More; wider screens keep the
// rail and never download React. The choice is remembered on this device (no server store for it yet).
import { reportHandlerError } from "./app-errors-capture.js";
import { state } from "./state.js";

export const PHONE_QUERY = "(max-width: 760px)";
export const SLOT_COUNT = 3;
// The default three places after Home, per role (owner, 2026-11-24). A default the role cannot open is skipped and the
// next section of the menu takes its place.
export const DEFAULT_SLOTS = Object.freeze({
  coach: Object.freeze(["central-calendar", "athletes", "training-load"]),
  admin: Object.freeze(["central-calendar", "athletes", "organization"]),
  athlete: Object.freeze(["athlete-calendar", "tests", "messages"]),
});

// Which defaults: the athlete shell; a platform or club workspace (an administrator's); every other coach workspace.
export function navRoleOf(shell, appState = state) {
  if (shell === "athlete") return "athlete";
  return ["platform", "club"].includes(appState.currentUser?.activeWorkspace?.type) ? "admin" : "coach";
}

// The three places: the stored choice where the role can still open it, then the role's defaults, then the menu's order.
export function resolveSlots(stored, defaults, available) {
  const open = new Set(available);
  const slots = [];
  for (const id of [...(Array.isArray(stored) ? stored : []), ...defaults, ...available]) {
    if (slots.length >= SLOT_COUNT) break;
    if (typeof id === "string" && open.has(id) && !slots.includes(id)) slots.push(id);
  }
  return slots;
}

// The person's choice on this device, per user and shell. Every read and write is inside try/catch: without storage
// (a private window, blocked site data) the bar shows the role's defaults.
const slotsKey = (shell, userId) => `optimove.bottomNav.slots.v1.${shell}.${String(userId || "anonymous")}`;
export function readBarSlots(shell, userId) {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(slotsKey(shell, userId)) || "null");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, SLOT_COUNT) : null;
  } catch {
    return null;
  }
}
export function writeBarSlots(shell, userId, slots) {
  try {
    if (slots) globalThis.localStorage?.setItem(slotsKey(shell, userId), JSON.stringify(slots.slice(0, SLOT_COUNT)));
    else globalThis.localStorage?.removeItem(slotsKey(shell, userId));
    return true;
  } catch {
    return false;
  }
}
const HOME_TABS = new Set(["coach-home", "athlete-home"]);
const HOME_ICON = '<svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7"></path><path d="M6 9.5V20h12V9.5"></path><path d="M10 20v-5h4v5"></path></svg>';

const isHidden = (el) => Boolean(el.hidden || el.closest("[hidden]"));
const labelOf = (el) => (el.getAttribute("title") || el.querySelector("span")?.textContent || el.textContent || "").trim();

function idOf(el) {
  if (el.id === "athletesToggle") return "athletes";
  if (el.id === "calendarToggle") return "central-calendar";
  return el.dataset.libraryTab || el.dataset.athleteTab || "";
}

// The bar's model: { shell, role, items, more, slots, defaults, options, targets } - targets maps every id to the
// control a tap runs; options are the sections the three places may hold (never Home, which is fixed first).
export function buildBottomNavModel(doc = globalThis.document, appState = state, stored = undefined) {
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
  // Messages (the header's own button) may hold a place too, where the shell shows it.
  const messages = doc.getElementById("messageToggle");
  if (messages && !isHidden(messages)) {
    targets.set("messages", messages);
    sections.push({ id: "messages", label: "Messages", icon: messages.querySelector("svg")?.outerHTML || "", active: doc.body.classList.contains("messages-open") });
  }
  const role = navRoleOf(shell, appState);
  const options = sections.filter((s) => s.id !== "home");
  const available = options.map((s) => s.id);
  const defaults = resolveSlots([], DEFAULT_SLOTS[role], available);
  const slots = resolveSlots(stored === undefined ? readBarSlots(shell, appState.currentUser?.id) : stored, DEFAULT_SLOTS[role], available);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const items = ["home", ...slots].map((id) => byId.get(id)).filter(Boolean).map(({ children, ...rest }) => rest);
  const more = options.filter((s) => !slots.includes(s.id));
  return { shell, role, items, more, slots, defaults, options: options.map(({ id, label }) => ({ id, label })), targets };
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
const memorySlots = new Map();

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
    // Messages: its header button appears once the inbox is read, and the panel marks the body while open.
    const messages = doc.getElementById("messageToggle");
    if (messages) observer.observe(messages, { attributes: true, attributeFilter: ["hidden"] });
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
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
  // This page's own save wins over storage (which may refuse it); otherwise the device's stored choice.
  const shellNow = doc.body.classList.contains("athlete-mode") ? "athlete" : "coach";
  const memoryKey = `${shellNow}.${state.currentUser?.id}`;
  const stored = memorySlots.has(memoryKey) ? memorySlots.get(memoryKey) : undefined;
  const model = buildBottomNavModel(doc, state, stored);
  if (!model) { teardown(doc); return; }
  if (!host) {
    host = doc.createElement("div");
    host.className = "om-bottom-nav-host";
    doc.body.appendChild(host);
  }
  if (!doc.body.classList.contains("has-bottom-nav")) doc.body.classList.add("has-bottom-nav");
  const userId = state.currentUser?.id;
  islands.mountIsland(host, islands.BottomNav, {
    items: model.items,
    more: model.more.map(({ id, label, icon, active, children }) => ({ id, label, icon, active, children })),
    slots: model.slots,
    defaults: model.defaults,
    options: model.options,
    onSelect: (id) => { runBottomNav(id, buildBottomNavModel(doc, state, stored) || model, doc, state); },
    // Edit menu: the three places after Home; the defaults again removes the stored choice.
    onSaveSlots: (slots) => {
      const isDefault = slots.length === model.defaults.length && slots.every((id, i) => id === model.defaults[i]);
      writeBarSlots(model.shell, userId, isDefault ? null : slots);
      memorySlots.set(memoryKey, isDefault ? null : slots);
      scheduleSync();
    },
  }, { name: "bottom_nav" });
}
