// Roles V-0 (docs/ai/roles-v-steps-plan.md section 3): the frontend twin of the backend's view helper - which menu
// places, tabs, Settings sections and notification links a view workspace (club_view / team_view) may open. V-0 opens no
// module, so a view workspace sees exactly what R4-4 gave it; with a module opened inside the test, its place opens only
// with its word. The module keys, words and open list must equal backend/src/moduleView.js. Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let vm;
let nav;
let permissionNav;
let state;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const as = (activeWorkspace, permissions = ["org.view"]) => {
  state.currentUser = { id: "u1", name: "Viewer A", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], permissions };
};

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  vm = await import("../view-modules.js");
  nav = await import("../navigation.js");
  permissionNav = await import("../permission-nav.js");
  ({ state } = await import("../state.js"));
});

test("1. the module keys, words and open list are the backend's (moduleView.js)", () => {
  const src = readFileSync(new URL("../../backend/src/moduleView.js", import.meta.url), "utf8");
  const words = Object.fromEntries([...src.match(/MODULE_VIEW_WORDS = Object\.freeze\(\{([\s\S]*?)\}\);/)[1].matchAll(/(\w+): "([\w.]+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(vm.MODULE_VIEW_WORDS, words);
  const open = src.match(/OPEN_VIEW_MODULES = Object\.freeze\(\[([^\]]*)\]\)/)[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual([...vm.OPEN_VIEW_MODULES], open);
  assert.deepEqual(open, ["data_configuration", "presets", "athletes", "calendar", "tests", "tests_results", "dashboards", "programs", "exercises"], "V-1 opens Data configuration and Tags & Presets, V-2 Athletes, V-3 the calendar, V-4 Tests, V-6 Dashboards");
  for (const place of vm.VIEW_NAV_PLACES) for (const m of place.modules) assert.ok(Object.hasOwn(vm.MODULE_VIEW_WORDS, m), m);
});

test("2. the places cover exactly the menu R4-4 hides in a view workspace", () => {
  assert.deepEqual(vm.VIEW_NAV_PLACES.flatMap((p) => p.selectors).sort(), [...nav.VIEW_WORKSPACE_MENU_HIDDEN].sort());
  assert.deepEqual([...vm.VIEW_BASE_TABS], [...nav.VIEW_WORKSPACE_TABS]);
});

test("3. V-1, V-2, V-3, V-4, V-6: a view workspace holding every view word sees Home, the athlete list, Settings (Overview, Clubs, Teams, Tags & Presets, Athletes), the Calendar, Tests, Training Load and Account; nothing else", () => {
  as(CLUB_VIEW, ["org.view", ...Object.values(vm.MODULE_VIEW_WORDS)]);
  for (const module of Object.keys(vm.MODULE_VIEW_WORDS)) {
    assert.equal(vm.viewModuleOpen(module), ["data_configuration", "presets", "athletes", "calendar", "tests", "tests_results", "dashboards", "programs", "exercises"].includes(module), module);
  }
  const shown = ['[data-library-tab="training-load"]', "#athletesToggle", "#athleteSearch", "#athleteList", "#calendarToggle", '[data-library-tab="tests"]', '[data-sidebar-submenu="program-library"]', '[data-library-tab="exercises"]'];
  assert.deepEqual(vm.viewHiddenMenuSelectors().sort(), nav.VIEW_WORKSPACE_MENU_HIDDEN.filter((s) => !shown.includes(s)).sort());
  assert.deepEqual(vm.viewWorkspaceTabs(), [...nav.VIEW_WORKSPACE_TABS, "central-calendar", "templates", "weekly", "programs", "exercises", "tests", "training-load"]);
  assert.deepEqual(permissionNav.viewSettingsSections(), ["overview", "clubs", "teams", "presets", "athletes"]);
  assert.deepEqual(vm.viewTrainingLoadSections(), ["analysis", "variables"]);
  nav.renderAccessNav();
  for (const selector of nav.VIEW_WORKSPACE_MENU_HIDDEN) {
    const el = document.querySelector(selector);
    const target = el.id === "athleteSearch" ? el.closest(".search-field") || el : el;
    assert.equal(target.hidden, !shown.includes(selector), selector);
  }
  // Without the words, the V-0 picture: only Home, Settings (Overview, Clubs, Teams) and Account.
  as(CLUB_VIEW, ["org.view"]);
  assert.deepEqual(vm.viewHiddenMenuSelectors().sort(), [...nav.VIEW_WORKSPACE_MENU_HIDDEN].sort());
  assert.deepEqual(vm.viewWorkspaceTabs(), [...nav.VIEW_WORKSPACE_TABS]);
  assert.deepEqual(permissionNav.viewSettingsSections(), ["overview", "clubs", "teams"]);
  assert.deepEqual(vm.viewTrainingLoadSections(), []);
});

test("3b. V-1: Training Load in a view workspace stays on Data configuration's Variables; other workspaces keep their section", () => {
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  for (const s of ["schedule", "today", "analysis", "imports", "source-fields", "mappings", "board", "variables"]) {
    assert.equal(vm.viewSafeTrainingLoadSection(s), "variables", s);
  }
  as({ type: "club", scopeId: CLUB }, ["variables.view"]);
  assert.equal(vm.viewTrainingLoadSections(), null);
  assert.equal(vm.viewSafeTrainingLoadSection("schedule"), "schedule", "a coach workspace keeps its own rules");
});

test("3c. V-6: dashboards.view alone opens Training Load on Data & Analysis -> Dashboards only; with variables.view too, both", () => {
  as(CLUB_VIEW, ["org.view", "dashboards.view"]);
  assert.deepEqual(vm.viewTrainingLoadSections(), ["analysis"]);
  assert.ok(vm.viewWorkspaceTabs().includes("training-load"));
  for (const s of ["schedule", "today", "results", "overview", "imports", "variables", "mappings", "analysis"]) {
    assert.equal(vm.viewSafeTrainingLoadSection(s), "analysis", s);
  }
  as(CLUB_VIEW, ["org.view", "dashboards.view", "variables.view"]);
  assert.equal(vm.viewSafeTrainingLoadSection("variables"), "variables");
  assert.equal(vm.viewSafeTrainingLoadSection("today"), "analysis", "the first open section");
});

test("4. an opened module (inside the test): its place, tab and Settings section open only with its word; other places stay hidden", () => {
  as(CLUB_VIEW, ["org.view", "calendar.view", "presets.use"]);
  const open = ["calendar", "presets", "tests"];
  assert.equal(vm.viewModuleOpen("calendar", state.currentUser, open), true);
  assert.equal(vm.viewModuleOpen("tests", state.currentUser, open), false, "open, but the word is not held");
  assert.equal(vm.viewModuleOpen("dashboards", state.currentUser, open), false, "held nowhere, not open");
  const hidden = vm.viewHiddenMenuSelectors(state.currentUser, open);
  assert.ok(!hidden.includes("#calendarToggle"));
  assert.ok(hidden.includes('[data-library-tab="tests"]'));
  assert.ok(hidden.includes('[data-library-tab="coaches"]'), "a place with no module never opens");
  assert.deepEqual(vm.viewWorkspaceTabs(state.currentUser, open), [...nav.VIEW_WORKSPACE_TABS, "central-calendar"]);
  assert.deepEqual(vm.viewModuleSettingsSections(state.currentUser, open), ["presets"]);
  // Training Load opens with any of its modules' words.
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  assert.ok(!vm.viewHiddenMenuSelectors(state.currentUser, ["data_configuration"]).includes('[data-library-tab="training-load"]'));
});

test("5. outside a view workspace nothing here applies; a view workspace without the word list holds nothing", () => {
  as({ type: "club", scopeId: CLUB }, ["calendar.view"]);
  assert.equal(vm.viewModuleOpen("calendar", state.currentUser, ["calendar"]), false, "a coach workspace keeps its own rules");
  as(CLUB_VIEW, undefined);
  state.currentUser.permissions = undefined;
  assert.equal(vm.viewModuleOpen("calendar", state.currentUser, ["calendar"]), false);
  state.currentUser.permissionsUnavailable = true;
  state.currentUser.permissions = ["calendar.view"];
  assert.equal(vm.viewModuleOpen("calendar", state.currentUser, ["calendar"]), false, "unavailable words hold nothing");
  assert.equal(vm.viewModuleOpen("nope", state.currentUser, ["nope"]), false, "an unknown module");
});

test("6. every notification opener in app.js that a view workspace may follow is mapped to a module", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const wrapped = [...src.matchAll(/notInViewWorkspace\((\w+)\)/g)].map((m) => m[1]).filter((name) => name !== "open");
  const body = src.match(/function viewModuleOfOpener\(open\) \{([\s\S]*?)\n\}/)[1];
  for (const name of new Set(wrapped)) assert.ok(new RegExp(`open === ${name}\\b`).test(body), `${name} has a module`);
  for (const m of body.matchAll(/return "(\w+)"/g)) assert.ok(Object.hasOwn(vm.MODULE_VIEW_WORDS, m[1]), m[1]);
});

test("7. V-4: tests.results.view alone opens no Tests place (every Tests read needs tests.view first)", () => {
  as(CLUB_VIEW, ["org.view", "tests.results.view"]);
  assert.equal(vm.viewModuleOpen("tests_results"), true);
  assert.ok(vm.viewHiddenMenuSelectors().includes('[data-library-tab="tests"]'));
  assert.ok(!vm.viewWorkspaceTabs().includes("tests"));
  as(CLUB_VIEW, ["org.view", "tests.view"]);
  assert.ok(vm.viewWorkspaceTabs().includes("tests"));
});
