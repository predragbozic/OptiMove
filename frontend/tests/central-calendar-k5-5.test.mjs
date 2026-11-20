// K5-5 (docs/ai/central-calendar-k5-plan.md, K5-5; the manager's R1, R2): "Open in calendar" from Tests' week, the
// Training Load calendar and Coach Home's day - each the central calendar on that place's day. Through the real
// templates (JSDOM for the markup); the opener of app.js runs from its source against recording fakes and the real
// central calendar state.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { emptyCentralCalendarState, emptyTrainingLoadState, state } = await import("../state.js");
const { renderOpenInCalendarHtml } = await import("../open-in-calendar.js");
const { renderCoachTodayWeeklyHtml, renderScheduleWeeklyHtml, renderCoachResultsSectionHtml } = await import("../tests-view.js");
const { renderTrainingLoadCalendarHtml } = await import("../training-load-calendar-view.js");
const { renderCoachHomeDayHtml } = await import("../coach-home.js");
const { emptyCoachHomeState } = await import("../state.js");
const { restoreCentralCalendarPlace } = await import("../central-calendar-actions.js");

const dom = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const openers = (html) => [...dom(html).querySelectorAll('[data-action="open-in-central-calendar"]')].map((node) => ({
  date: node.dataset.date, view: node.dataset.view, text: node.textContent.trim(), quiet: node.classList.contains("is-quiet"),
}));

const WEEK = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const session = { scheduleId: "s1", scheduleStatus: "active", testName: "Wellness", opensTime: "08:00", closesTime: "20:00", resultsCount: 1, status: "open", completedCount: 1, expectedCount: 2 };
const testsWeek = () => ({ weekStart: WEEK[0], weekEnd: WEEK[6], days: WEEK.map((date) => ({ date, sessions: date === WEEK[3] ? [session] : [] })) });

beforeEach(() => {
  state.trainingLoad = emptyTrainingLoadState();
  state.centralCalendar = emptyCentralCalendarState();
  for (const section of ["today", "schedule", "results"]) state.tests.weekly[section] = { weekStart: WEEK[0], selectedDate: "", data: null, loading: false, error: "" };
  state.tests.resultsListFilter = null;
  state.tests.weeklyGroupDetail = null;
  state.tests.weeklyGroupDetailLoading = false;
});

test("K5-5. the button: the date and the view it names, its words, quiet for a day link, nothing without a usable date", () => {
  assert.deepEqual(openers(renderOpenInCalendarHtml("2026-11-19")), [{ date: "2026-11-19", view: "week", text: "Open in calendar", quiet: false }]);
  assert.deepEqual(openers(renderOpenInCalendarHtml("2026-11-19", { view: "day", quiet: true })), [{ date: "2026-11-19", view: "day", text: "Open Thu 19 Nov in calendar", quiet: true }], "a day link names its day (UX review)");
  const label = (html) => dom(html).querySelector("button").getAttribute("aria-label");
  // The long date as Intl writes it (some builds put a comma after the weekday).
  assert.match(label(renderOpenInCalendarHtml("2026-11-19")), /^Open the week of Thursday,? 19 November 2026 in calendar$/);
  assert.match(label(renderOpenInCalendarHtml("2026-11-19", { view: "day" })), /^Open Thursday,? 19 November 2026 in calendar$/);
  assert.equal(openers(renderOpenInCalendarHtml("2026-11-19", { view: "month" }))[0].view, "week", "only week or day");
  for (const bad of ["", null, undefined, "19.11.2026", '2026-11-19" onclick="x']) assert.equal(renderOpenInCalendarHtml(bad), "", String(bad));
  const button = dom(renderOpenInCalendarHtml("2026-11-19")).querySelector("button");
  assert.equal(button.getAttribute("type"), "button");
  assert.equal(button.querySelector("svg").getAttribute("aria-hidden"), "true", "the icon is drawn, the words speak");
});

test("K5-5. Tests' week: each tab's bar opens the selected day's week; under the day's agenda a quiet link opens its Day view", () => {
  const renderers = { today: renderCoachTodayWeeklyHtml, schedule: renderScheduleWeeklyHtml, results: renderCoachResultsSectionHtml };
  for (const [section, render] of Object.entries(renderers)) {
    const nav = state.tests.weekly[section];
    nav.data = testsWeek();
    nav.selectedDate = WEEK[3];
    let doc = dom(render());
    const bar = doc.querySelector('.tests-weekly-nav [data-action="open-in-central-calendar"]');
    assert.deepEqual([bar.dataset.date, bar.dataset.view, bar.textContent.trim()], [WEEK[3], "week", "Open in calendar"], section);
    const link = doc.querySelector('.tests-weekly-day-link [data-action="open-in-central-calendar"]');
    assert.deepEqual([link.dataset.date, link.dataset.view, link.textContent.trim()], [WEEK[3], "day", "Open Thu 19 Nov in calendar"], section);
    assert.ok(link.classList.contains("is-quiet"));
    assert.ok(doc.querySelector(".tests-weekly-agenda").compareDocumentPosition(link) & 4, `${section}: the link follows the agenda`);
    // No day chosen yet: the week's first day, as the agenda shows it.
    nav.selectedDate = "";
    doc = dom(render());
    assert.equal(doc.querySelector('.tests-weekly-nav [data-action="open-in-central-calendar"]').dataset.date, WEEK[0], section);
    assert.equal(doc.querySelector('.tests-weekly-day-link [data-action="open-in-central-calendar"]').dataset.date, WEEK[0], section);
  }
});

test("K5-5. the Training Load calendar: its bar opens the selected day's week, in week and in month mode", () => {
  const cal = state.trainingLoad.calendar;
  cal.weekStart = WEEK[0];
  cal.selectedDate = WEEK[4];
  cal.data = { dateFrom: WEEK[0], dateTo: WEEK[6], days: WEEK.map((date) => ({ date, items: [] })) };
  let found = openers(renderTrainingLoadCalendarHtml());
  assert.deepEqual(found, [{ date: WEEK[4], view: "week", text: "Open in calendar", quiet: false }]);
  assert.ok(dom(renderTrainingLoadCalendarHtml()).querySelector('.tl-calendar-nav [data-action="open-in-central-calendar"]'), "in the calendar's own bar");
  cal.monthMode = true;
  cal.monthCursor = "2026-11-01";
  found = openers(renderTrainingLoadCalendarHtml());
  assert.equal(found[0].date, WEEK[4], "month mode keeps the same selected day");
  cal.selectedDate = "";
  assert.equal(openers(renderTrainingLoadCalendarHtml())[0].date, WEEK[0], "no day chosen: the week's first day");
});

test("K5-5. Coach Home's day: the header opens today's week, or the day the coach picked in the card", () => {
  const today = "2026-11-20";
  const home = emptyCoachHomeState();
  let found = openers(renderCoachHomeDayHtml({ rows: [], home, today }));
  assert.deepEqual(found, [{ date: today, view: "week", text: "Open in calendar", quiet: false }]);
  assert.ok(dom(renderCoachHomeDayHtml({ rows: [], home, today })).querySelector('.coach-home-panel-head .coach-home-day-actions [data-action="open-in-central-calendar"]'));
  home.calendar = { selected: "2026-11-24", cursor: "2026-11-24", expanded: false };
  found = openers(renderCoachHomeDayHtml({ rows: [], home, today }));
  assert.equal(found[0].date, "2026-11-24", "the picked day");
  const doc = dom(renderCoachHomeDayHtml({ rows: [], home, today }));
  const actions = [...doc.querySelectorAll(".coach-home-day-actions button")].map((node) => node.dataset.action);
  assert.deepEqual(actions, ["coach-home-day-today", "open-in-central-calendar"], "beside the Today button");
});

// --- The opener of app.js ---------------------------------------------------------------------------------------------

const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const sourceOf = (start) => {
  const from = appJs.indexOf(start);
  assert.ok(from >= 0, start);
  return appJs.slice(from, appJs.indexOf("\n}\n", from) + 2);
};

function harness({ leave = true, athlete = false } = {}) {
  const calls = [];
  const scope = {
    state,
    isAthleteMode: () => athlete,
    restoreCentralCalendarPlace,
    confirmLeaveTrainingLoad: (tab) => { calls.push(`confirmLeave:${tab}`); return leave; },
    pushAppHistory: () => calls.push(`push@${state.activeTab}`),
    loadActiveTab: () => { calls.push(`load@${state.activeTab}:${state.centralCalendar.view}:${state.centralCalendar.anchor}`); return Promise.resolve(); },
    detached: () => {},
  };
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key in target ? target[key] : typeof key === "string" ? () => { calls.push(key); return undefined; } : undefined),
  });
  const source = [sourceOf("function openCentralCalendarFromRail("), sourceOf("function openCentralCalendarOnDay(")].join("\n");
  // eslint-disable-next-line no-new-func
  const fns = new Function("scope", `with (scope) { ${source}\nreturn { openCentralCalendarOnDay }; }`)(proxy);
  return { ...fns, calls };
}

test("K5-5. the opener: Training Load's check, then the module's Back entry, then the central calendar on that day and view", () => {
  state.activeTab = "tests";
  state.centralCalendar.panel = { open: true, key: "event:old", date: "2026-11-02", athletes: null, loading: false, error: "" };
  const h = harness();
  h.openCentralCalendarOnDay({ date: "2026-11-19", view: "week" });
  assert.deepEqual(h.calls.slice(0, 2), ["confirmLeave:central-calendar", "push@tests"], "the check first; Back's entry is the module's, recorded before the tab changes");
  assert.equal(state.activeTab, "central-calendar");
  assert.deepEqual([state.centralCalendar.view, state.centralCalendar.anchor, state.centralCalendar.selectedDate], ["week", "2026-11-19", "2026-11-19"]);
  assert.equal(state.centralCalendar.panel.open, false, "an earlier panel is not reopened over another day");
  assert.ok(h.calls.includes("load@central-calendar:week:2026-11-19"));
  state.activeTab = "tests";
  harness().openCentralCalendarOnDay({ date: "2026-11-19", view: "day" });
  assert.equal(state.centralCalendar.view, "day", "Tests' day link: the Day view");
});

test("K5-5. a check that keeps the coach where they are pushes nothing and leaves the calendar's place as it was; athlete mode and a bad date do nothing", () => {
  state.activeTab = "training-load";
  Object.assign(state.centralCalendar, { view: "month", anchor: "2026-10-05", selectedDate: "2026-10-06" });
  const panel = { open: true, key: "event:kept", date: "2026-10-06", athletes: null, loading: false, error: "" };
  state.centralCalendar.panel = panel;
  // A half-done step of that panel (code review LOW): it survives a "stay" too.
  state.centralCalendar.alignStep = { kind: "confirm", key: "event:kept" };
  state.centralCalendar.questionStep = { eventKey: "event:kept", revision: 1, error: "" };
  state.centralCalendar.k3 = { eventKey: "event:kept", sheet: true };
  state.centralCalendar.linkMessage = { panelKey: "event:kept", text: "Linked." };
  const stay = harness({ leave: false });
  stay.openCentralCalendarOnDay({ date: "2026-11-19" });
  assert.deepEqual(state.centralCalendar.alignStep, { kind: "confirm", key: "event:kept" });
  assert.equal(state.centralCalendar.questionStep.eventKey, "event:kept");
  assert.equal(state.centralCalendar.k3.eventKey, "event:kept");
  assert.equal(state.centralCalendar.linkMessage.text, "Linked.");
  assert.deepEqual(stay.calls, ["confirmLeave:central-calendar"]);
  assert.equal(state.activeTab, "training-load");
  assert.deepEqual([state.centralCalendar.view, state.centralCalendar.anchor, state.centralCalendar.selectedDate], ["month", "2026-10-05", "2026-10-06"]);
  assert.equal(state.centralCalendar.panel, panel, "the panel the coach left stays");
  for (const [options, label] of [[{ athlete: true }, "athlete"], [{}, "bad date"]]) {
    const h = harness(options);
    h.openCentralCalendarOnDay({ date: label === "bad date" ? "tomorrow" : "2026-11-19" });
    assert.deepEqual(h.calls, [], label);
    assert.equal(state.activeTab, "training-load", label);
  }
});

test("K5-5. app.js dispatches the button's action to the opener with its date and view", () => {
  assert.match(appJs, /if \(type === "open-in-central-calendar"\) \{\s*openCentralCalendarOnDay\(\{ date: action\.dataset\.date, view: action\.dataset\.view \}\);\s*return;\s*\}/);
});
