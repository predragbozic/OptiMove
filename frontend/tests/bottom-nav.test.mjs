// The phone's bottom bar, plain side (frontend/bottom-nav.js): the bar's sections are read from the real menu of
// index.html / athlete.html, so a section the menu hides for a role is never on the bar or in More, and a tap runs the
// menu control's own click (its leave guards included). The browser proof per role is e2e/tests/bottom-nav-phone.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DEFAULT_SLOTS, FALLBACK_MS, PHONE_QUERY, buildBottomNavModel, navRoleOf, readBarSlots, resolveSlots, runBottomNav, syncBottomNav, writeBarSlots } from "../bottom-nav.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function shell(file) {
  // The page as served, without running its scripts.
  return new JSDOM(read(file), { url: "http://localhost/" }).window.document;
}
const ids = (list) => list.map((s) => s.id);

test("coach shell: Home, Calendar, Athletes and Training load on the bar; the rest of the menu in More, in the menu's order", () => {
  const doc = shell("index.html");
  const model = buildBottomNavModel(doc, { activeTab: "coach-home" });
  assert.equal(model.shell, "coach");
  assert.deepEqual(ids(model.items), ["home", "central-calendar", "athletes", "training-load"]);
  assert.deepEqual(ids(model.more), ["coaches", "builder", "templates", "exercises", "tests", "coach-account"], "Settings is hidden in the page until the menu shows it");
  assert.deepEqual(model.items.map((i) => i.label), ["Home", "Calendar", "Athletes", "Training load"]);
  assert.equal(model.items[0].active, true, "Home is current on the coach's Home");
  assert.match(model.items[1].icon, /^<svg class="rail-icon"/, "the menu's own icon");
  // Program Library keeps its sections.
  assert.deepEqual(model.more.find((s) => s.id === "templates").children.map((c) => c.label), ["My Programs", "Requests", "OptiMove", "Marketplace"]);
});

test("a section the menu hides (by role) is neither on the bar nor in More; shown again, it comes back with its sections", () => {
  const doc = shell("index.html");
  doc.querySelector('[data-library-tab="builder"]').hidden = true;
  doc.querySelector('[data-library-tab="training-load"]').hidden = true;
  let model = buildBottomNavModel(doc, {});
  assert.ok(!ids(model.items).includes("training-load"));
  assert.ok(!ids(model.more).includes("builder"));
  assert.ok(!model.targets.has("builder"));
  // Settings: its submenu is hidden for a role without organization access; renderAccessNav shows it.
  doc.querySelector('[data-sidebar-submenu="settings"]').hidden = false;
  doc.querySelector('.sidebar-subnav-button[data-organization-section="clubs"]').hidden = true;
  model = buildBottomNavModel(doc, {});
  const settings = model.more.find((s) => s.id === "organization");
  assert.equal(settings.label, "Settings");
  assert.deepEqual(settings.children.map((c) => c.label), ["Users", "Teams", "Athletes", "Tags & Presets"], "a hidden Settings section stays hidden");
});

test("the current section follows the menu's own is-active marks, sections included", () => {
  const doc = shell("index.html");
  doc.querySelector('[data-library-tab="training-load"]').classList.add("is-active");
  doc.querySelector('.sidebar-subnav-button[data-program-library-section="requests"]').classList.add("is-active");
  const model = buildBottomNavModel(doc, { activeTab: "training-load" });
  assert.equal(model.items.find((i) => i.id === "home").active, false);
  assert.equal(model.items.find((i) => i.id === "training-load").active, true);
  assert.equal(model.more.find((s) => s.id === "templates").children.find((c) => c.label === "Requests").active, true);
  // The Athletes control opens a list; it is never the current section.
  doc.getElementById("athletesToggle").classList.add("is-active");
  assert.equal(buildBottomNavModel(doc, {}).items.find((i) => i.id === "athletes").active, false);
  // Its button says whether the list is open (aria-expanded).
  assert.equal(buildBottomNavModel(doc, {}).items.find((i) => i.id === "athletes").expanded, false);
  assert.equal(buildBottomNavModel(doc, { mobileNavOpen: true, athletesExpanded: true }).items.find((i) => i.id === "athletes").expanded, true);
});

test("athlete shell: Home, Calendar, Tests and Messages by default; Weekly plan fills in while Messages is not shown", () => {
  const doc = shell("athlete.html");
  let model = buildBottomNavModel(doc, { activeTab: "athlete-home" }, null);
  assert.equal(model.shell, "athlete");
  assert.equal(model.role, "athlete");
  assert.deepEqual([...DEFAULT_SLOTS.athlete], ["athlete-calendar", "tests", "messages"]);
  // The page as served hides Messages until the inbox is read: the next section of the menu takes its place.
  assert.deepEqual(ids(model.items), ["home", "athlete-calendar", "tests", "calendar"]);
  doc.getElementById("messageToggle").hidden = false;
  model = buildBottomNavModel(doc, { activeTab: "athlete-home" }, null);
  assert.deepEqual(ids(model.items), ["home", "athlete-calendar", "tests", "messages"]);
  assert.deepEqual(model.items.map((i) => i.label), ["Home", "Calendar", "Tests", "Messages"]);
  assert.ok(ids(model.more).includes("calendar"), "Weekly plan is under More");
  doc.body.classList.add("messages-open");
  assert.equal(buildBottomNavModel(doc, {}, null).items.find((i) => i.id === "messages").active, true);
  doc.getElementById("messageToggle").hidden = true;
  doc.body.classList.remove("messages-open");
  model = buildBottomNavModel(doc, { activeTab: "athlete-home" }, null);
  assert.equal(model.items[0].active, true);
  assert.ok(!ids(model.more).includes("my-training"), "hidden in the page");
  assert.ok(!ids(model.more).includes("exercises"), "hidden in the page");
  doc.querySelector('[data-athlete-tab="my-training"]').hidden = false;
  model = buildBottomNavModel(doc, {}, null);
  assert.ok(ids(model.more).includes("my-training"));
  // The athlete's logo opens her Home (data-action="home").
  assert.equal(model.targets.get("home").dataset.action, "home");
});

test("a tap runs the menu control's own click; an unknown id runs nothing", () => {
  const doc = shell("index.html");
  const model = buildBottomNavModel(doc, {});
  const clicked = [];
  doc.addEventListener("click", (e) => clicked.push(e.target.closest("button")?.dataset.libraryTab || e.target.closest("button")?.dataset.action || e.target.closest("button")?.id));
  assert.equal(runBottomNav("training-load", model, doc, {}), true);
  assert.equal(runBottomNav("home", model, doc, {}), true);
  assert.equal(runBottomNav("templates/1", model, doc, {}), true);
  assert.equal(runBottomNav("no-such", model, doc, {}), false);
  assert.deepEqual(clicked, ["training-load", "brand-home", "templates"]);
  assert.equal(model.targets.get("templates/1").dataset.programLibrarySection, "requests");
});

test("Athletes opens the menu drawer with the athlete list; tapped again while both are open, it closes the drawer", () => {
  const doc = shell("index.html");
  const model = buildBottomNavModel(doc, {});
  const clicked = [];
  doc.addEventListener("click", (e) => clicked.push(e.target.closest("button").id));
  runBottomNav("athletes", model, doc, { mobileNavOpen: false, athletesExpanded: false });
  assert.deepEqual(clicked, ["athletesToggle", "mobileNavToggle"]);
  clicked.length = 0;
  runBottomNav("athletes", model, doc, { mobileNavOpen: false, athletesExpanded: true });
  assert.deepEqual(clicked, ["mobileNavToggle"], "the list already unfolded is not folded");
  clicked.length = 0;
  runBottomNav("athletes", model, doc, { mobileNavOpen: true, athletesExpanded: true });
  assert.deepEqual(clicked, ["mobileNavToggle"]);
});

test("the defaults by role: a coach Calendar, Athletes, Training load; an administrator Calendar, Athletes, Settings", () => {
  assert.equal(navRoleOf("coach", { currentUser: { activeWorkspace: { type: "team" } } }), "coach");
  assert.equal(navRoleOf("coach", { currentUser: { activeWorkspace: { type: "private_coach" } } }), "coach");
  assert.equal(navRoleOf("coach", { currentUser: { activeWorkspace: { type: "club" } } }), "admin");
  assert.equal(navRoleOf("coach", { currentUser: { activeWorkspace: { type: "platform" } } }), "admin");
  assert.equal(navRoleOf("athlete", {}), "athlete");
  const doc = shell("index.html");
  doc.querySelector('[data-sidebar-submenu="settings"]').hidden = false;
  const admin = buildBottomNavModel(doc, { currentUser: { activeWorkspace: { type: "club" } } }, null);
  assert.deepEqual(ids(admin.items), ["home", "central-calendar", "athletes", "organization"]);
  assert.ok(ids(admin.more).includes("training-load"));
  // An administrator without Settings in the menu: the next section of the menu takes the place.
  doc.querySelector('[data-sidebar-submenu="settings"]').hidden = true;
  assert.deepEqual(ids(buildBottomNavModel(doc, { currentUser: { activeWorkspace: { type: "club" } } }, null).items), ["home", "central-calendar", "athletes", "coaches"]);
});

test("a stored choice: kept where the role can open it, filled from the defaults, never twice, never Home", () => {
  const available = ["central-calendar", "athletes", "training-load", "builder", "tests"];
  assert.deepEqual(resolveSlots(["tests", "builder", "athletes"], DEFAULT_SLOTS.coach, available), ["tests", "builder", "athletes"]);
  assert.deepEqual(resolveSlots(["organization", "tests", "tests"], DEFAULT_SLOTS.coach, available), ["tests", "central-calendar", "athletes"], "a section the role cannot open and a repeat are dropped");
  assert.deepEqual(resolveSlots(["home", 7, null], DEFAULT_SLOTS.coach, available), ["central-calendar", "athletes", "training-load"]);
  assert.deepEqual(resolveSlots("garbage", DEFAULT_SLOTS.coach, available), ["central-calendar", "athletes", "training-load"]);
  const doc = shell("index.html");
  const model = buildBottomNavModel(doc, {}, ["tests", "builder", "training-load"]);
  assert.deepEqual(ids(model.items), ["home", "tests", "builder", "training-load"]);
  assert.deepEqual(model.defaults, ["central-calendar", "athletes", "training-load"]);
  assert.ok(ids(model.more).includes("central-calendar") && ids(model.more).includes("athletes"), "the sections moved off the bar are under More");
  assert.ok(!model.options.some((o) => o.id === "home"), "Home is not a choice: it is always first");
});

test("the choice is stored per user and shell on this device; storage that throws or holds garbage gives the defaults", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } });
  try {
    assert.equal(writeBarSlots("coach", "u1", ["tests", "builder", "athletes"]), true);
    assert.deepEqual(readBarSlots("coach", "u1"), ["tests", "builder", "athletes"]);
    assert.equal(readBarSlots("coach", "u2"), null, "another user's choice is not read");
    assert.equal(readBarSlots("athlete", "u1"), null, "nor another shell's");
    assert.deepEqual(ids(buildBottomNavModel(shell("index.html"), { currentUser: { id: "u1" } }).items), ["home", "tests", "builder", "athletes"]);
    writeBarSlots("coach", "u1", null);
    assert.equal(readBarSlots("coach", "u1"), null, "back to the defaults removes the stored choice");
    store.set("optimove.bottomNav.slots.v1.coach.u1", "{not json");
    assert.equal(readBarSlots("coach", "u1"), null);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } });
    assert.equal(readBarSlots("coach", "u1"), null);
    assert.equal(writeBarSlots("coach", "u1", ["tests"]), false);
    assert.deepEqual(ids(buildBottomNavModel(shell("index.html"), { currentUser: { id: "u1" } }).items), ["home", "central-calendar", "athletes", "training-load"]);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved); else delete globalThis.localStorage;
  }
});

test("Messages: a tap runs the header's own Messages button", () => {
  const doc = shell("athlete.html");
  doc.getElementById("messageToggle").hidden = false;
  const model = buildBottomNavModel(doc, {}, null);
  let clicked = "";
  doc.addEventListener("click", (e) => { clicked = e.target.closest("button")?.id; });
  runBottomNav("messages", model, doc, {});
  assert.equal(clicked, "messageToggle");
});

test("a count on the menu's item (the athlete's pending tests) is carried to the bar; a hidden one is not", () => {
  const doc = shell("athlete.html");
  const badge = doc.querySelector("[data-tests-count]");
  assert.equal(buildBottomNavModel(doc, {}, null).items.find((i) => i.id === "tests").badge, undefined, "hidden 0: no badge");
  badge.hidden = false;
  badge.textContent = "3";
  assert.equal(buildBottomNavModel(doc, {}, null).items.find((i) => i.id === "tests").badge, "3");
  // In More as well, when Tests is not one of the three places.
  assert.equal(buildBottomNavModel(doc, {}, ["athlete-calendar", "calendar", "programs"]).more.find((s) => s.id === "tests").badge, "3");
});

test("the header's menu button is hidden on a phone from the first paint, and comes back only when the bar cannot load", () => {
  const css = read("styles.css");
  const block = css.slice(css.indexOf("React island: the phone's bottom navigation"));
  const phone = block.slice(block.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /body:not\(\.login-mode\):not\(\.bottom-nav-unavailable\) \.mobile-nav-toggle \{ display: none !important; \}/);
  assert.match(read("bottom-nav.js"), /\.add\("bottom-nav-unavailable"\)/);
  // A drawer closed on a phone gives focus back to the bar's Athletes (its opener there).
  assert.match(read("app.js"), /document\.querySelector\('\.om-bottom-nav \[data-nav-id="athletes"\]'\)/);
});

test("a phone is never left without navigation: no bar in time -> the menu button comes back; the bar on screen -> it goes again", async () => {
  const dom = new JSDOM(read("index.html"), { url: "http://localhost/", pretendToBeVisual: true });
  const win = dom.window;
  const saved = {};
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: key === "window" ? win : win[key], configurable: true, writable: true });
  }
  const timers = [];
  win.matchMedia = (query) => ({ matches: query === PHONE_QUERY, addEventListener() {} });
  win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const { state } = await import("../state.js");
  const previousUser = state.currentUser;
  state.currentUser = { id: "u-fallback", activeWorkspace: { type: "team" } };
  try {
    syncBottomNav({ doc: win.document, win });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, FALLBACK_MS);
    // The bar is not on screen yet (its code still loading): the timer brings the menu button back.
    timers[0].fn();
    assert.equal(win.document.body.classList.contains("bottom-nav-unavailable"), true);
    // The code arrives and the bar is drawn: the fallback goes.
    for (let i = 0; i < 200 && !win.document.querySelector(".om-bottom-nav"); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(win.document.querySelector(".om-bottom-nav"), "the bar is drawn");
    assert.equal(win.document.body.classList.contains("has-bottom-nav"), true);
    assert.equal(win.document.body.classList.contains("bottom-nav-unavailable"), false, "the menu button goes again");
    // Signed out in place (no reload): the bar goes and the watchers settle. A class write on every sync used to make
    // the body watcher sync again forever (a frozen tab); a few tasks must be enough to settle.
    state.currentUser = null;
    syncBottomNav({ doc: win.document, win });
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    assert.ok(!win.document.querySelector(".om-bottom-nav"), "the bar is gone");
    assert.equal(win.document.body.classList.contains("has-bottom-nav"), false);
  } finally {
    state.currentUser = previousUser;
    // Back to a signed-out page: the bar unmounts and its watchers stop, so nothing keeps the test process alive.
    syncBottomNav({ doc: win.document, win });
    win.close();
    for (const [key, desc] of Object.entries(saved)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  }
});

test("no menu, no bar: a page without the app shell (sign-in, invite) gives no model", () => {
  const doc = new JSDOM("<!doctype html><body><form class='login-form'></form></body>").window.document;
  assert.equal(buildBottomNavModel(doc, {}), null);
});

test("the bar is a phone's: the query and the CSS agree on 760 px, and wider screens hide its host", () => {
  assert.equal(PHONE_QUERY, "(max-width: 760px)");
  const css = read("styles.css");
  const block = css.slice(css.indexOf("React island: the phone's bottom navigation"));
  assert.match(block, /^\s*\.om-bottom-nav-host \{ display: none; \}/m);
  assert.match(block, /@media \(max-width: 760px\) \{\s*body\.has-bottom-nav:not\(\.login-mode\) \{/);
  assert.match(block, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(block, /\.app-shell \{ padding-bottom: var\(--om-bottom-nav-space\); \}/);
  assert.match(block, /min-width: var\(--om-tap-target\);/);
});

test("the menu's render asks the bar to follow, and React is loaded only through a lazy import", () => {
  const nav = read("navigation.js");
  const render = nav.slice(nav.indexOf("export function renderLibraryNav()"), nav.indexOf("export function renderRailState()"));
  assert.match(render, /requestBottomNavSync\(\);\s*\}\s*$/);
  const bridge = read("bottom-nav.js");
  assert.match(bridge, /import\("\.\/react-build\/islands\.js"\)/);
  assert.doesNotMatch(bridge, /^import .*react-build/m, "never a static import: a computer never downloads React");
});
