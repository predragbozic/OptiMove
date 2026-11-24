// The app's own Back (app-history.js): pushAppHistory() records where the user
// was, and Back returns there - the tab, and on the central calendar its view,
// week, day and open panel - instead of falling back to Home.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const history = await import("../app-history.js");
const { emptyCentralCalendarState } = await import("../state.js");
const { restoreCentralCalendarPlace } = await import("../central-calendar-actions.js");
const { state } = await import("../state.js");

const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const sourceOf = (start, end) => {
  const from = appJs.indexOf(start);
  assert.ok(from >= 0, start);
  return appJs.slice(from, appJs.indexOf(end, from) + end.length);
};

beforeEach(() => {
  history.clearAppHistoryEntries();
  history.endAppBack();
});

const calendarState = (overrides = {}) => ({
  ...emptyCentralCalendarState(),
  view: "week", anchor: "2026-11-18", selectedDate: "2026-11-19",
  panel: { open: true, key: "event:e1", date: "2026-11-19", athletes: null, loading: false, error: "" },
  ...overrides,
});

test("1. the entry: the tab, and on the central calendar its view, week, day and open panel by key", () => {
  assert.deepEqual(history.appHistoryEntryOf({ activeTab: "central-calendar", centralCalendar: calendarState() }), {
    tab: "central-calendar",
    calendar: { view: "week", anchor: "2026-11-18", selectedDate: "2026-11-19", panelKey: "event:e1", panelDate: "2026-11-19", panelSections: null },
    athleteCalendar: null,
  });
  // The event panel's opened sections travel with the place (the redesign of 2026-11-23); never another panel's.
  const opened = calendarState({ panelView: { key: "event:e1", sections: { athletes: true, trainings: false }, menu: "session:x" } });
  assert.deepEqual(history.appHistoryEntryOf({ activeTab: "central-calendar", centralCalendar: opened }).calendar.panelSections, { athletes: true, trainings: false });
  const other = calendarState({ panelView: { key: "event:e2", sections: { athletes: true }, menu: "" } });
  assert.equal(history.appHistoryEntryOf({ activeTab: "central-calendar", centralCalendar: other }).calendar.panelSections, null);
  const closed = calendarState({ panel: { open: false, key: "event:e1", date: "2026-11-19" } });
  assert.equal(history.appHistoryEntryOf({ activeTab: "central-calendar", centralCalendar: closed }).calendar.panelKey, "");
  assert.deepEqual(history.appHistoryEntryOf({ activeTab: "builder", centralCalendar: calendarState() }), { tab: "builder", calendar: null, athleteCalendar: null });
});

test("2. push and pop are last in, first out; an empty stack pops null; clear empties it", () => {
  history.pushAppHistoryEntry({ tab: "coach-home", calendar: null });
  history.pushAppHistoryEntry({ tab: "central-calendar", calendar: null });
  assert.equal(history.appHistoryEntryCount(), 2);
  assert.equal(history.popAppHistoryEntry().tab, "central-calendar");
  assert.equal(history.popAppHistoryEntry().tab, "coach-home");
  assert.equal(history.popAppHistoryEntry(), null);
  history.pushAppHistoryEntry({ tab: "builder", calendar: null, athleteCalendar: null });
  history.clearAppHistoryEntries();
  assert.equal(history.appHistoryEntryCount(), 0);
  assert.equal(history.popAppHistoryEntry(), null);
});

test("3. one Back press: only an entry of another tab is taken, once; endAppBack says whether it was", () => {
  history.beginAppBack({ tab: "coach-home", calendar: null });
  assert.equal(history.takeAppBackEntry("coach-home"), null, "the tab the user is on is never a place to return to");
  assert.deepEqual(history.endAppBack(), { entry: { tab: "coach-home", calendar: null }, taken: false });
  history.beginAppBack({ tab: "central-calendar", calendar: null });
  assert.equal(history.takeAppBackEntry("weekly").tab, "central-calendar");
  assert.equal(history.takeAppBackEntry("weekly"), null);
  assert.equal(history.endAppBack().taken, true);
  assert.equal(history.takeAppBackEntry("weekly"), null, "nothing outside a press");
  history.beginAppBack(null);
  assert.equal(history.takeAppBackEntry("weekly"), null);
  // A stale place is only one of the tab the user is on (or of no tab): never another tab's.
  history.beginAppBack({ tab: "central-calendar", calendar: null });
  assert.equal(history.skipStaleAppBackEntry("weekly"), false);
  assert.equal(history.endAppBack().taken, false);
  history.beginAppBack({ tab: "weekly", calendar: null });
  assert.equal(history.skipStaleAppBackEntry("weekly"), true);
  assert.equal(history.skipStaleAppBackEntry("weekly"), false, "once");
  assert.equal(history.endAppBack().taken, true);
});

test("4. the calendar comes back as it was: view, week, day and the panel re-opened by key, never over a form", () => {
  state.centralCalendar = calendarState({ view: "month", anchor: "2026-12-01", selectedDate: "2026-12-02", panel: { open: false, key: "", date: "", athletes: null, loading: false, error: "" } });
  restoreCentralCalendarPlace({ view: "week", anchor: "2026-11-18", selectedDate: "2026-11-19", panelKey: "event:e1", panelDate: "2026-11-19" });
  const cal = state.centralCalendar;
  assert.deepEqual([cal.view, cal.anchor, cal.selectedDate], ["week", "2026-11-18", "2026-11-19"]);
  assert.deepEqual([cal.panel.open, cal.panel.key, cal.panel.date], [true, "event:e1", "2026-11-19"]);
  // A place without a panel closes the one open now.
  restoreCentralCalendarPlace({ view: "day", anchor: "2026-11-18", selectedDate: "2026-11-18", panelKey: "", panelDate: "" });
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(state.centralCalendar.view, "day");
  // An unknown view is not taken; an open form keeps its panel as it is.
  state.centralCalendar = calendarState({ form: { mode: "create" }, panel: { open: false, key: "", date: "" } });
  restoreCentralCalendarPlace({ view: "nonsense", anchor: "2026-11-18", selectedDate: "2026-11-18", panelKey: "event:e1", panelDate: "2026-11-18" });
  assert.equal(state.centralCalendar.view, "week");
  assert.equal(state.centralCalendar.panel.open, false);
});

// handleBrowserBack and handleAppBack from app.js, run against fakes with the
// real app-history.js: every other name they call is recorded.
function backHarness(appState, { leave = true, overlay = null, throwOnce = false } = {}) {
  const calls = [];
  const browserBack = sourceOf("function handleBrowserBack() {", "\n}");
  const restorePlace = sourceOf("function restoreAppPlace(place) {", "\n}");
  const appBack = sourceOf("function handleAppBack() {", "\n}");
  const scope = {
    state: appState,
    BACK_STAYED: "stayed",
    ...history,
    els: { mediaModal: { hidden: true } },
    // The browser's Back: its popstate runs handleBrowserBack again, a moment later.
    window: { history: { pushState: () => calls.push("pushState"), back: () => { calls.push("history.back"); setTimeout(() => fns.handleBrowserBack(), 0); } }, location: { href: "/" }, confirm: () => true },
    isAthleteMode: () => false,
    athleteQuestionsBrowserBack: () => false,
    handleMessagesBack: () => false,
    closeTopExerciseLayer: () => {
      if (throwOnce) { throwOnce = false; throw new Error("a close step failed"); }
      return false;
    },
    closeSpecificProgramOverlay: () => false,
    closeCentralCalendarPanel: () => {
      if (overlay !== "calendar-panel") return false;
      calls.push("closeCentralCalendarPanel");
      overlay = null;
      return true;
    },
    confirmLeaveTrainingLoad: (tab) => { calls.push(`confirmLeave:${tab}`); return leave; },
    restoreCentralCalendarPlace: (place) => calls.push(`restoreCalendar:${place.view}:${place.anchor}:${place.panelKey}`),
    detached: () => calls.push("loadActiveTab"),
  };
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key in target ? target[key] : typeof key === "string" ? () => { calls.push(key); return undefined; } : undefined),
  });
  // eslint-disable-next-line no-new-func
  let fns;
  fns = new Function("scope", `with (scope) { ${restorePlace}\n${appBack}\n${browserBack}\nreturn { handleBrowserBack, handleAppBack }; }`)(proxy);
  // pushAppHistory's own two steps (its pushState is the browser's).
  const push = () => { appState.appHistoryDepth += 1; history.pushAppHistoryEntry(history.appHistoryEntryOf(appState)); };
  return { ...fns, calls, push };
}

const appState = (tab) => ({
  activeTab: tab, appHistoryDepth: 0, navStack: [], athleteExitConfirmOpen: false, mobileNavOpen: false,
  trainingLoad: { section: "" }, centralCalendar: calendarState(),
});

test("5. calendar (panel open) -> weekly plan -> Back: the calendar, the same week, the panel open", () => {
  const s = appState("central-calendar");
  const h = backHarness(s);
  h.push(); // Open the athlete's weekly plan from the event panel.
  s.activeTab = "weekly";
  h.handleBrowserBack();
  assert.equal(s.activeTab, "central-calendar");
  assert.equal(s.appHistoryDepth, 0);
  assert.ok(h.calls.includes("confirmLeave:central-calendar"));
  assert.ok(h.calls.includes("restoreCalendar:week:2026-11-18:event:e1"));
  assert.ok(h.calls.includes("loadActiveTab"));
  assert.ok(!h.calls.includes("pushState"));
  assert.equal(history.appHistoryEntryCount(), 0);
});

test("6. a guard that declines: Back stays, the history state and the entry are put back unchanged", () => {
  const s = appState("central-calendar");
  const h = backHarness(s, { leave: false });
  h.push();
  s.activeTab = "training-load";
  h.handleBrowserBack();
  assert.equal(s.activeTab, "training-load");
  assert.equal(s.appHistoryDepth, 1);
  assert.deepEqual(h.calls.filter((call) => call === "pushState"), ["pushState"]);
  assert.equal(history.appHistoryEntryCount(), 1);
  assert.equal(history.popAppHistoryEntry().tab, "central-calendar");
});

test("7. Builder -> calendar with a panel open -> Back closes the panel and keeps the way back; the next Back returns to the Builder", () => {
  const s = appState("builder");
  const h = backHarness(s, { overlay: "calendar-panel" });
  h.push();
  s.activeTab = "central-calendar";
  h.handleBrowserBack();
  assert.deepEqual(h.calls.slice(0, 2), ["closeCentralCalendarPanel", "pushState"]);
  assert.equal(s.activeTab, "central-calendar");
  assert.equal(s.appHistoryDepth, 1);
  assert.equal(history.appHistoryEntryCount(), 1);
  h.handleBrowserBack();
  assert.equal(s.activeTab, "builder");
  assert.equal(s.appHistoryDepth, 0);
  assert.equal(history.appHistoryEntryCount(), 0);
});

test("8. an entry of the same tab (an exercise detail's) is used up by its overlay, as before; an empty stack still falls back to Home", () => {
  const s = appState("coach-home");
  const h = backHarness(s, { overlay: "calendar-panel" });
  h.push();
  h.handleBrowserBack();
  assert.equal(s.appHistoryDepth, 0);
  assert.equal(history.appHistoryEntryCount(), 0);
  assert.ok(!h.calls.includes("pushState"));
  const t = appState("organization");
  const g = backHarness(t);
  t.appHistoryDepth = 1; // a state pushed before a workspace switch cleared the stack
  g.handleBrowserBack();
  assert.equal(t.activeTab, "coach-home");
  assert.ok(g.calls.includes("confirmLeave:coach-home"));
});

test("9. app.js clears the stack on a workspace switch and on sign-out, and pushAppHistory records one entry per history state", () => {
  assert.match(sourceOf("async function onWorkspaceChanged() {", "\n}"), /clearAppHistoryEntries\(\);/);
  assert.match(sourceOf("async function signOut() {", "\n}"), /clearAppHistoryEntries\(\);/);
  const push = sourceOf("function pushAppHistory() {", "\n}");
  assert.match(push, /state\.appHistoryDepth \+= 1;\n[^]*const entry = appHistoryEntryOf\(state, \{ athleteCalendar: state\.activeTab === "athlete-calendar" \? athleteCalendarPlace\(\) : null \}\);\s*pushAppHistoryEntry\(entry\);/);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("10. a stale place of the same tab (the Athletes list opened and closed by its own toggle) is skipped: Back reaches the older place, never Home in the middle", async () => {
  const s = appState("builder");
  const h = backHarness(s);
  h.push(); // Builder -> the calendar from the rail.
  s.activeTab = "central-calendar";
  h.push(); // The Athletes list opened, then closed by its toggle: nothing popped.
  h.push(); // The calendar -> Settings.
  s.activeTab = "organization";
  h.handleBrowserBack();
  assert.equal(s.activeTab, "central-calendar");
  h.handleBrowserBack(); // The stale entry: one more step back.
  await tick();
  assert.equal(s.activeTab, "builder");
  assert.equal(s.appHistoryDepth, 0);
  assert.equal(history.appHistoryEntryCount(), 0);
  assert.ok(!h.calls.includes("confirmLeave:coach-home"), "never Home in the middle of the trail");
  // With nothing older left, a stale place falls back to Home as before.
  const t = appState("organization");
  const g = backHarness(t);
  g.push();
  g.handleBrowserBack();
  await tick();
  assert.equal(t.activeTab, "coach-home");
});

test("11. a Back press that throws leaves no place behind for a later press outside a popstate (the app's back button)", () => {
  const s = appState("central-calendar");
  const h = backHarness(s, { throwOnce: true });
  h.push();
  s.activeTab = "weekly";
  assert.throws(() => h.handleBrowserBack(), /a close step failed/);
  h.handleAppBack(); // depth 0: the back button calls it directly.
  assert.equal(s.activeTab, "coach-home", "the root fallback, not the popped place");
});
