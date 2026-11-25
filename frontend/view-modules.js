// Roles V-0 (docs/ai/roles-v-steps-plan.md section 3): which parts of the app a view workspace (club_view / team_view)
// may open. The frontend twin of backend/src/moduleView.js: the same module keys, the same view words, the same list of
// OPEN modules (frontend/tests/view-modules.test.mjs compares the two). A module opens only in its own V pull request;
// until then nothing here shows anything new. It only hides: every route still decides again (the entry gate).
import { state } from "./state.js";

export const MODULE_VIEW_WORDS = Object.freeze({
  data_configuration: "variables.view",
  presets: "presets.use",
  athletes: "athletes.view",
  calendar: "calendar.view",
  tests: "tests.view",
  tests_results: "tests.results.view",
  load_team: "load.view.team",
  load_athlete: "load.view.athlete",
  dashboards: "dashboards.view",
  programs: "programs.view",
  exercises: "exercises.use",
});

// The modules a view workspace may read (the same list as the backend's OPEN_VIEW_MODULES). V-1: Data configuration
// (Training Load -> Data configuration, the Variables list, read only) and Tags, presets and session types (Settings ->
// Tags & Presets, read only).
// V-2: Athletes (the sidebar's athlete list and Settings -> Athletes, read only). V-3: the calendar (the central
// calendar, read only: no New event, events in their reduced view, no athlete names without athletes.view).
// V-4: Tests (the Schedule, Results and Test Library sections, read only; no Today, which writes occurrences).
// V-6 opens Dashboards read-only.
export const OPEN_VIEW_MODULES = Object.freeze(["data_configuration", "presets", "athletes", "calendar", "tests", "tests_results", "dashboards"]);

// The menu places of a view workspace: each opens when ANY of its modules is open and its word is held. A place with
// no module (Coaches) never opens there.
export const VIEW_NAV_PLACES = Object.freeze([
  { key: "athletes", selectors: ["#athletesToggle", "#athleteSearch", "#athleteList"], tabs: [], modules: ["athletes"] },
  { key: "calendar", selectors: ["#calendarToggle"], tabs: ["central-calendar"], modules: ["calendar"] },
  { key: "coaches", selectors: ['[data-library-tab="coaches"]'], tabs: [], modules: [] },
  { key: "programs", selectors: ['[data-library-tab="builder"]', '[data-sidebar-submenu="program-library"]'], tabs: ["builder", "templates"], modules: ["programs"] },
  { key: "exercises", selectors: ['[data-library-tab="exercises"]'], tabs: ["exercises"], modules: ["exercises"] },
  // V-4: results alone open nothing (every Tests read needs tests.view first, routes/tests.js).
  { key: "tests", selectors: ['[data-library-tab="tests"]'], tabs: ["tests"], modules: ["tests"] },
  { key: "training-load", selectors: ['[data-library-tab="training-load"]'], tabs: ["training-load"], modules: ["load_team", "load_athlete", "dashboards", "data_configuration"] },
].map((place) => Object.freeze({ ...place, selectors: Object.freeze(place.selectors), tabs: Object.freeze(place.tabs), modules: Object.freeze(place.modules) })));

// The Settings sections a module opens in a view workspace (besides Overview, Clubs and Teams, which org.view opens).
export const VIEW_SETTINGS_SECTIONS = Object.freeze({ presets: Object.freeze(["presets"]), athletes: Object.freeze(["athletes"]) });

// The labels of every Settings section a view workspace can open (org.view's three and the open modules').
export const VIEW_SETTINGS_LABELS = Object.freeze({ overview: "Overview", clubs: "Clubs", teams: "Teams", presets: "Tags & Presets", athletes: "Athletes" });

// The tabs a view workspace may always stay on.
export const VIEW_BASE_TABS = Object.freeze(["coach-home", "organization", "coach-account"]);

const VIEW_TYPES = new Set(["club_view", "team_view"]);
const isView = (user) => VIEW_TYPES.has(user?.activeWorkspace?.type);
// The words of /me; a view workspace without the list holds nothing (a role holder has no "before").
function held(user) {
  if (!user || user.permissionsUnavailable === true || !Array.isArray(user.permissions)) return new Set();
  return new Set(user.permissions.filter((word) => typeof word === "string"));
}

// May this view workspace open `module`? False outside a view workspace (other workspaces keep their own rules), for an
// unknown module, for a module not open yet, and without the word.
export function viewModuleOpen(module, user = state.currentUser, open = OPEN_VIEW_MODULES) {
  if (!isView(user) || !Object.hasOwn(MODULE_VIEW_WORDS, module) || !open.includes(module)) return false;
  return held(user).has(MODULE_VIEW_WORDS[module]);
}

const placeOpen = (place, user, open) => place.modules.some((module) => viewModuleOpen(module, user, open));

// The menu entries a view workspace hides: every place none of whose modules is open.
export function viewHiddenMenuSelectors(user = state.currentUser, open = OPEN_VIEW_MODULES) {
  return VIEW_NAV_PLACES.filter((place) => !placeOpen(place, user, open)).flatMap((place) => place.selectors);
}

// The tabs a view workspace may be on.
export function viewWorkspaceTabs(user = state.currentUser, open = OPEN_VIEW_MODULES) {
  return [...VIEW_BASE_TABS, ...VIEW_NAV_PLACES.filter((place) => placeOpen(place, user, open)).flatMap((place) => place.tabs)];
}

// The Training Load sections a module opens in a view workspace (V-1: Data configuration's start screen and Variables,
// which is one section, "variables"; V-6: Dashboards, the "analysis" view of Data & Analysis). Schedule and the other
// Data & Analysis views open with their own modules in later V steps.
export const VIEW_TRAINING_LOAD_SECTIONS = Object.freeze({
  dashboards: Object.freeze(["analysis"]),
  data_configuration: Object.freeze(["variables"]),
});

// The Training Load sections this view workspace may be on; null outside a view workspace (other workspaces keep their
// own rules).
export function viewTrainingLoadSections(user = state.currentUser, open = OPEN_VIEW_MODULES) {
  if (!isView(user)) return null;
  return Object.entries(VIEW_TRAINING_LOAD_SECTIONS).filter(([module]) => viewModuleOpen(module, user, open)).flatMap(([, sections]) => sections);
}

// The section to show: unchanged outside a view workspace; in one, the asked section when it is open there, else the
// first open one (a view workspace never lands on Schedule or Data & Analysis it cannot read).
export function viewSafeTrainingLoadSection(section, user = state.currentUser, open = OPEN_VIEW_MODULES) {
  const allowed = viewTrainingLoadSections(user, open);
  if (!allowed || allowed.length === 0 || allowed.includes(section)) return section;
  return allowed[0];
}

// The Settings sections of open modules (permission-nav.js adds them to org.view's).
export function viewModuleSettingsSections(user = state.currentUser, open = OPEN_VIEW_MODULES) {
  return Object.entries(VIEW_SETTINGS_SECTIONS).filter(([module]) => viewModuleOpen(module, user, open)).flatMap(([, sections]) => sections);
}
