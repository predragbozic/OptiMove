// Central calendar (K1b, docs/ai/central-calendar-k1b-plan.md section 10):
// the screen over GET /api/calendar, through the real handlers, loaders and
// templates with a fake fetch (tests/support/fetch-mock.mjs) and JSDOM for
// the markup. The fake answers the API's own shape (K1a, plan section 2):
// every day of the range, one card per thing, the server's order inside a
// day, `athletes` only with include=athletes.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

let athleteMode = false;
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: (name) => name === "athlete-mode" && athleteMode } },
};
// No matchMedia: the actions module treats the screen as wide.
globalThis.window = { confirm: () => true };

const { emptyCentralCalendarState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const {
  captureCentralCalendarView,
  centralCalendarLayout,
  centralCalendarRosterAthleteId,
  centralCalendarRosterIndex,
  closeCentralCalendarPanel,
  handleCentralCalendarAction,
  restoreCentralCalendarView,
} = await import("../central-calendar-actions.js");
const {
  centralCalendarRange,
  describeCentralCalendarError,
  invalidateCentralCalendarCache,
  loadCentralCalendar,
  readCentralCalendarWeekMode,
  resetCentralCalendarForWorkspaceChange,
} = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { renderLibraryNav } = await import("../navigation.js");
const { addDaysIso, addMonthsIso, localDateIso, monthWeeksIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const TEAMS = [
  { teamId: "11111111-1111-4111-8111-111111111111", name: "U19", athleteCount: 20 },
  { teamId: "22222222-2222-4222-8222-222222222222", name: "U17", athleteCount: 18 },
  { teamId: "33333333-3333-4333-8333-333333333333", name: "U15", athleteCount: 16 },
];
const [U19, U17, U15] = TEAMS.map((team) => team.teamId);
const ATHLETES = [
  { athleteId: "aaaaaaaa-0000-4000-8000-000000000001", name: "Marko Test", teamIds: [U19], rpe: "submitted" },
  { athleteId: "aaaaaaaa-0000-4000-8000-000000000002", name: "Ana Test", teamIds: [U19], rpe: "missing" },
  { athleteId: "aaaaaaaa-0000-4000-8000-000000000003", name: "Luka Test", teamIds: [U19, U17], rpe: "not_asked" },
];

// The fixture: one week around today, every kind and status, in the
// server's order inside a day (planned AM before PM, the activity after).
function baseItem(overrides) {
  return {
    key: "", kind: "planned", date: DAY(0), title: null, slot: null, startTime: null, startsAt: null,
    teamIds: [U19], athleteIds: [], athleteCount: 0, expects: [], status: "none", rpe: null, attendance: null,
    results: null, cancelled: false, projected: false, links: {}, ...overrides,
  };
}
const ITEMS = [
  baseItem({ key: "planned:batch-1", date: DAY(0), title: "Team training", slot: { amPm: "AM", bta: "T", order: 1 }, athleteCount: 20, expects: ["rpe"], status: "awaiting_entry", rpe: { asked: 20, submitted: 17 }, links: { activityIds: ["act-1", "act-2", "act-3"], planIds: [], logicalSessionIds: [] } }),
  baseItem({ key: "planned:batch-2", date: DAY(0), title: "Strength", slot: { amPm: "PM", bta: "B", order: 1 }, startTime: "17:30", teamIds: [U19, U17], athleteCount: 30, expects: ["rpe"], status: "done", rpe: { asked: 30, submitted: 30 }, links: { activityIds: ["act-9"], planIds: [], logicalSessionIds: [] } }),
  baseItem({ key: "activity:act-gps", kind: "activity", date: DAY(0), title: "GPS session", startTime: "19:00", origin: "api_import", activityTypeKey: "training", athleteCount: 20, expects: ["device_data"], status: "awaiting_entry", attendance: { roster: 20, present: 17, needsState: 3 }, links: { activityIds: ["act-gps"], logicalSessionIds: [], externalAssignmentIds: [] } }),
  baseItem({ key: "external:sch-1:d1", kind: "external", date: DAY(1), title: "Cup match", eventType: "match", startTime: "15:00", teamIds: [U17], athleteCount: 18, expects: ["rpe"], status: "done", rpe: { asked: 18, submitted: 18 }, links: { activityIds: [], externalScheduleId: "sch-1", externalOccurrenceId: "occ-1" } }),
  baseItem({ key: "test:tsch-1:d2", kind: "test", date: DAY(2), title: "CMJ", startTime: "09:00", teamIds: [U15], athleteCount: 16, expects: ["test_result"], status: "awaiting_entry", results: { expected: 16, completed: 12 }, links: { testScheduleId: "tsch-1", testOccurrenceId: "tocc-1" } }),
  baseItem({ key: "external:sch-2:d3", kind: "external", date: DAY(3), title: "Travel day", eventType: "travel", teamIds: [U19], athleteCount: 20, expects: [], status: "cancelled", cancelled: true, links: { activityIds: [], externalScheduleId: "sch-2", externalOccurrenceId: null } }),
  baseItem({ key: "test:tsch-2:d4", kind: "test", date: DAY(4), title: null, teamIds: [U15], athleteCount: 16, expects: ["test_result"], status: "not_opened", projected: true, links: { testScheduleId: "tsch-2", testOccurrenceId: null } }),
  baseItem({ key: "external:sch-3:d5", kind: "external", date: DAY(5), title: "Recovery run", eventType: "other", teamIds: [U19], athleteCount: 20, expects: ["rpe"], status: "missed", rpe: { asked: 20, submitted: 0 }, links: { activityIds: [], externalScheduleId: "sch-3", externalOccurrenceId: "occ-3" } }),
  baseItem({ key: "activity:act-manual", kind: "activity", date: DAY(6), title: null, origin: "manual", athleteCount: 2, expects: [], status: "none", links: { activityIds: ["act-manual"], logicalSessionIds: [], externalAssignmentIds: [] } }),
];

function answerFor(url, { items = ITEMS, teams = TEAMS } = {}) {
  const params = new URL(url, "http://localhost").searchParams;
  const from = params.get("from");
  const to = params.get("to");
  const includeAthletes = params.get("include") === "athletes";
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) {
    const dayItems = items.filter((item) => item.date === cursor).map((item) => (includeAthletes ? { ...item, athletes: ATHLETES } : { ...item }));
    days.push({ date: cursor, items: dayItems });
  }
  return { from, to, today: params.get("today"), workspace: { type: "club", scopeId: "club-1" }, teams, days };
}

function okResponder(options) {
  return (call) => (call.url.startsWith("/api/calendar?") ? { status: 200, body: answerFor(call.url, options) } : { status: 404, body: { error: "not found" } });
}

let rendered = "";
let renderCount = 0;
let layout = "wide";
function render() {
  renderCount += 1;
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout, roster: centralCalendarRosterIndex() });
}
function dom(html = rendered) {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}
function params(call) {
  return new URL(call.url, "http://localhost").searchParams;
}
async function act(dataset, handlers = {}) {
  return handleCentralCalendarAction(fakeAction(dataset), { render, ...handlers });
}

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1", label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = [];
  athleteMode = false;
  layout = "wide";
  rendered = "";
  renderCount = 0;
  delete globalThis.localStorage;
});

// --- 1. The range read -----------------------------------------------------

test("1a. the week view reads Monday to Sunday with the browser's date and no filter parameter", async () => {
  const calls = installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  assert.equal(calls.length, 1);
  const query = params(calls[0]);
  assert.equal(query.get("from"), MONDAY);
  assert.equal(query.get("to"), DAY(6));
  assert.equal(query.get("today"), TODAY);
  for (const name of ["kinds", "teamIds", "athleteIds", "clubIds", "include"]) assert.equal(query.get(name), null, `${name} is never sent on the range read`);
  assert.deepEqual(centralCalendarRange("week", TODAY), { from: MONDAY, to: DAY(6) });
  assert.equal(state.centralCalendar.anchor, TODAY);
  assert.equal(state.centralCalendar.data.from, MONDAY);
  assert.equal(state.centralCalendar.loading, false);
});

test("1b. the month view reads the grid's whole weeks (35 or 42 days), the day view its own week", async () => {
  const calls = installFetchMock(okResponder());
  state.centralCalendar.view = "month";
  await loadCentralCalendar({ render });
  const weeks = monthWeeksIso(TODAY.slice(0, 7));
  assert.equal(params(calls[0]).get("from"), weeks[0][0]);
  assert.equal(params(calls[0]).get("to"), weeks[weeks.length - 1][6]);
  // Rounded: a daylight-saving change inside the grid makes one day 23 or 25 hours long.
  const days = Math.round((new Date(`${weeks[weeks.length - 1][6]}T12:00:00`) - new Date(`${weeks[0][0]}T12:00:00`)) / 86400000) + 1;
  assert.ok(days === 35 || days === 42, `a month grid is 35 or 42 days, got ${days}`);
  state.centralCalendar.view = "day";
  await loadCentralCalendar({ render });
  assert.equal(calls.length, 2);
  assert.equal(params(calls[1]).get("from"), MONDAY);
  assert.equal(params(calls[1]).get("to"), DAY(6));
});

// --- 2. Cache and races ----------------------------------------------------

test("2a. the same range again sends nothing; another range sends one request; back again is still cached", async () => {
  const calls = installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  await loadCentralCalendar({ render });
  assert.equal(calls.length, 1, "an unchanged range within the TTL is not read again");
  await act({ action: "central-calendar-next" });
  assert.equal(calls.length, 2);
  assert.equal(params(calls[1]).get("from"), DAY(7));
  assert.equal(state.centralCalendar.anchor, addDaysIso(TODAY, 7));
  await act({ action: "central-calendar-prev" });
  assert.equal(calls.length, 2, "the first week is still fresh in the cache");
  assert.equal(state.centralCalendar.data.from, MONDAY);
});

test("2b. a slower older answer never overwrites the range the coach moved on to", async () => {
  const pending = [];
  installFetchMock((call) => new Promise((resolve) => { pending.push({ call, resolve }); }));
  const first = loadCentralCalendar({ render });
  const second = act({ action: "central-calendar-next" });
  assert.equal(pending.length, 2);
  // The newer range answers first, then the older one lands.
  pending[1].resolve({ status: 200, body: answerFor(pending[1].call.url) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[0].resolve({ status: 200, body: answerFor(pending[0].call.url) });
  await Promise.all([first, second]);
  assert.equal(state.centralCalendar.data.from, DAY(7), "the data on screen is the range the coach is looking at");
  assert.equal(state.centralCalendar.loading, false);
});

test("2c. a workspace switch mid-flight drops the old workspace's answer and clears the slice", async () => {
  const pending = [];
  installFetchMock((call) => new Promise((resolve) => { pending.push({ call, resolve }); }));
  const load = loadCentralCalendar({ render });
  state.centralCalendar.filters.teamIds.push(U19);
  state.centralCalendar.panel = { open: true, key: "planned:batch-1", date: DAY(0), athletes: null, loading: false, error: "" };
  resetCentralCalendarForWorkspaceChange();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "team-9" } };
  pending[0].resolve({ status: 200, body: answerFor(pending[0].call.url) });
  await load;
  assert.deepEqual(state.centralCalendar, emptyCentralCalendarState(), "a fresh slice: no data, no filters, no panel of the old workspace");
});

// --- 3. Chips ----------------------------------------------------------------

test("3a. the Groups and Types chips count the unfiltered answer and a toggle hides whole cards without a request", async () => {
  const calls = installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  let doc = dom();
  const chipCount = (selector) => doc.querySelector(`${selector} .cc-chip-count`).textContent;
  assert.equal(chipCount(`[data-team-id="${U19}"]`), "6");
  assert.equal(chipCount(`[data-team-id="${U17}"]`), "2", "the two-team card counts for both teams");
  assert.equal(chipCount(`[data-team-id="${U15}"]`), "2");
  assert.equal(chipCount('[data-kind="planned"]'), "2");
  assert.equal(chipCount('[data-kind="activity"]'), "2");
  assert.equal(chipCount('[data-kind="external"]'), "3");
  assert.equal(chipCount('[data-kind="test"]'), "2");
  assert.equal(doc.querySelectorAll(".cc-card").length, 9);

  await act({ action: "central-calendar-toggle-team", teamId: U17 });
  doc = dom();
  assert.deepEqual([...doc.querySelectorAll(".cc-card")].map((card) => card.dataset.key), ["planned:batch-2", "external:sch-1:d1"], "only cards carrying U17 stay");
  assert.equal(doc.querySelector(`[data-team-id="${U17}"]`).getAttribute("aria-pressed"), "true");
  assert.equal(chipCount(`[data-team-id="${U19}"]`), "6", "the other chips keep their counts");
  assert.equal(calls.length, 1, "a chip toggle never sends a request");

  await act({ action: "central-calendar-toggle-team", teamId: U17 });
  assert.equal(dom().querySelectorAll(".cc-card").length, 9, "toggled off again");
});

test("3b. the Types chip follows the server's kinds: Activities shows own-card activities and never unfolds a training's RPE activities", async () => {
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-toggle-kind", kind: "activity" });
  const keys = [...dom().querySelectorAll(".cc-card")].map((card) => card.dataset.key);
  assert.deepEqual(keys, ["activity:act-gps", "activity:act-manual"]);
  assert.ok(!keys.includes("planned:batch-1"), "the training that folds three RPE activities is a planned card, not three activity cards");
  await act({ action: "central-calendar-toggle-kind", kind: "test" });
  assert.deepEqual([...dom().querySelectorAll(".cc-card")].map((card) => card.dataset.key), ["activity:act-gps", "test:tsch-1:d2", "test:tsch-2:d4", "activity:act-manual"]);
  await act({ action: "central-calendar-clear-filters" });
  assert.deepEqual(state.centralCalendar.filters, { teamIds: [], kinds: [] });
  assert.equal(dom().querySelectorAll(".cc-card").length, 9);
  await act({ action: "central-calendar-toggle-kind", kind: "bogus" });
  assert.deepEqual(state.centralCalendar.filters.kinds, [], "an unknown kind is ignored");
});

// --- 4. Order and the time grid ----------------------------------------------

test("4a. a day's cards keep exactly the server's order, never re-sorted", async () => {
  const shuffled = [
    baseItem({ key: "p:c", date: DAY(0), title: "C last", slot: { amPm: "AM", bta: "A", order: 3 } }),
    baseItem({ key: "p:a", date: DAY(0), title: "A first", slot: { amPm: "PM", bta: "T", order: 1 }, startTime: "20:00" }),
    baseItem({ key: "p:b", date: DAY(0), title: "B middle", slot: { amPm: "AM", bta: "B", order: 1 } }),
  ];
  installFetchMock(okResponder({ items: shuffled }));
  await loadCentralCalendar({ render });
  const titles = [...dom().querySelectorAll(".cc-card .cc-card-title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["C last", "A first", "B middle"]);
  state.centralCalendar.view = "day";
  state.centralCalendar.anchor = DAY(0);
  await loadCentralCalendar({ render });
  assert.deepEqual([...dom().querySelectorAll(".cc-card .cc-card-title")].map((node) => node.textContent), ["C last", "A first", "B middle"]);
});

test("4b. the time grid (wide, grid mode) places a timed card at its hour and the slot-only ones in the No time band", async () => {
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-mode", mode: "grid" });
  const doc = dom();
  assert.ok(doc.querySelector(".cc-timegrid"), "the grid is drawn");
  assert.equal(doc.querySelector('.cc-timegrid-cell[data-hour="17"] .cc-card').dataset.key, "planned:batch-2");
  assert.equal(doc.querySelector('.cc-timegrid-cell[data-hour="19"] .cc-card').dataset.key, "activity:act-gps");
  assert.equal(doc.querySelector('.cc-timegrid-cell[data-hour="9"] .cc-card').dataset.key, "test:tsch-1:d2");
  const untimed = [...doc.querySelectorAll(".cc-timegrid-untimed .cc-card")].map((card) => card.dataset.key);
  assert.deepEqual(untimed, ["planned:batch-1", "external:sch-2:d3", "test:tsch-2:d4", "external:sch-3:d5", "activity:act-manual"], "every card without a start time, day by day");
  assert.equal(doc.querySelector('.cc-mode-switch [data-mode="grid"]').getAttribute("aria-pressed"), "true");
  // Not on a medium screen: no switch, the list is drawn.
  layout = "medium";
  render();
  assert.equal(dom().querySelector(".cc-mode-switch"), null);
  assert.ok(dom().querySelector(".cc-week"));
  assert.equal(dom().querySelector(".cc-timegrid"), null);
});

// --- 5. The card ---------------------------------------------------------------

test("5a. the status badge per status x expects (D14, D15)", () => {
  const badge = (item) => view.centralCalendarStatusBadge(baseItem(item))?.label ?? null;
  assert.equal(badge({ status: "planned" }), null);
  assert.equal(badge({ status: "none" }), null);
  assert.equal(badge({ status: "done" }), "Done");
  assert.equal(badge({ status: "awaiting_entry", expects: ["rpe"], rpe: { asked: 20, submitted: 17 } }), "Awaiting RPE");
  assert.equal(badge({ status: "awaiting_entry", expects: ["test_result"], results: { expected: 16, completed: 12 } }), "Awaiting result");
  assert.equal(badge({ status: "awaiting_entry", expects: ["device_data"], attendance: { roster: 20, present: 17, needsState: 3 } }), "Awaiting attendance");
  assert.equal(badge({ status: "awaiting_entry", expects: ["rpe"], rpe: { asked: 20, submitted: 20 }, attendance: { roster: 20, present: 20, needsState: 0 } }), "Awaiting entry");
  assert.equal(badge({ status: "missed" }), "Missed");
  assert.equal(badge({ status: "not_opened" }), "Not opened");
  assert.equal(badge({ status: "cancelled", cancelled: true }), "Cancelled");
});

test("5b. the one count per kind, the title fallbacks, the when label and the kind word", () => {
  const count = (item) => view.centralCalendarCountLabel(baseItem(item));
  assert.equal(count({ kind: "planned", rpe: { asked: 20, submitted: 17 } }), "RPE 17/20");
  assert.equal(count({ kind: "external", rpe: { asked: 18, submitted: 18 } }), "RPE 18/18");
  assert.equal(count({ kind: "activity", attendance: { roster: 20, present: 17, needsState: 3 }, rpe: { asked: 2, submitted: 1 } }), "17/20 present");
  assert.equal(count({ kind: "activity", rpe: { asked: 2, submitted: 1 } }), "RPE 1/2");
  assert.equal(count({ kind: "test", results: { expected: 16, completed: 12 } }), "Results 12/16");
  assert.equal(count({ kind: "planned" }), "");
  const title = (item) => view.centralCalendarTitle(baseItem(item));
  assert.equal(title({ kind: "planned" }), "Training session");
  assert.equal(title({ kind: "activity" }), "Activity");
  assert.equal(title({ kind: "external", eventType: "match" }), "Match");
  assert.equal(title({ kind: "external" }), "Event");
  assert.equal(title({ kind: "test" }), "Test");
  assert.equal(title({ kind: "test", title: "CMJ" }), "CMJ");
  const when = (item) => view.centralCalendarWhenLabel(baseItem(item));
  assert.equal(when({ startTime: "17:30" }), "17:30");
  assert.equal(when({ slot: { amPm: "AM", bta: "T", order: 2 } }), "AM · Training");
  assert.equal(when({ slot: { amPm: "PM", bta: null, order: 1 } }), "PM");
  assert.equal(when({ slot: null }), "");
  assert.equal(view.centralCalendarKindLabel(baseItem({ kind: "planned", athleteCount: 20 })), "Training · 20 athletes");
  assert.equal(view.centralCalendarKindLabel(baseItem({ kind: "activity", origin: "api_import", athleteCount: 1 })), "Imported activity · 1 athlete");
  assert.equal(view.centralCalendarKindLabel(baseItem({ kind: "activity", origin: "manual", athleteCount: 0 })), "Activity");
});

test("5c. the rendered card: team colour by position in teams[], a second team as a dot, the badge, the count, a struck cancelled title; no metrics", async () => {
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  const doc = dom();
  const training = doc.querySelector('.cc-card[data-key="planned:batch-1"]');
  assert.match(training.getAttribute("style"), /--cc-team-color: var\(--cc-team-0\)/);
  assert.equal(training.querySelector(".cc-badge").textContent, "Awaiting RPE");
  assert.equal(training.querySelector(".cc-card-count").textContent, "RPE 17/20");
  assert.equal(training.querySelector(".cc-card-when").textContent, "AM · Training");
  assert.equal(training.querySelector(".cc-card-kind").textContent, "Training · 20 athletes");
  const strength = doc.querySelector('.cc-card[data-key="planned:batch-2"]');
  assert.match(strength.getAttribute("style"), /--cc-team-0/);
  assert.equal(strength.querySelectorAll(".cc-card-teams .cc-team-dot").length, 1, "the second team is a dot");
  assert.match(strength.querySelector(".cc-card-teams .cc-team-dot").getAttribute("style"), /--cc-team-1/);
  assert.equal(strength.querySelector(".cc-card-when").textContent, "17:30");
  const cup = doc.querySelector('.cc-card[data-key="external:sch-1:d1"]');
  assert.match(cup.getAttribute("style"), /--cc-team-1/);
  assert.equal(cup.querySelector(".cc-badge").textContent, "Done");
  assert.ok(doc.querySelector('.cc-card[data-key="external:sch-2:d3"]').classList.contains("is-cancelled"));
  assert.equal(doc.querySelector('.cc-card[data-key="external:sch-2:d3"] .cc-badge').textContent, "Cancelled");
  assert.equal(doc.querySelector('.cc-card[data-key="test:tsch-2:d4"] .cc-badge').textContent, "Not opened");
  assert.equal(doc.querySelector('.cc-card[data-key="test:tsch-2:d4"] .cc-card-title').textContent, "Test");
  assert.equal(doc.querySelector('.cc-card[data-key="external:sch-3:d5"] .cc-badge').textContent, "Missed");
  assert.equal(doc.querySelector('.cc-card[data-key="activity:act-manual"] .cc-badge'), null, "status none has no badge");
  assert.equal(doc.querySelector('.cc-card[data-key="activity:act-gps"] .cc-card-count').textContent, "17/20 present");
  assert.doesNotMatch(rendered, /min\b|km\/h|W\/kg|sRPE|duration/i, "no metrics or durations on a card (D14)");
  assert.equal(view.centralCalendarTeamIndex(U15, TEAMS), 2);
  assert.equal(view.centralCalendarTeamIndex("unknown", TEAMS), -1);
});

test("5d. every server value in the markup is escaped, the kind in the class names included", () => {
  const html = view.renderCentralCalendarCardHtml(baseItem({ key: "k", kind: 'x" data-x="y', title: '<b>"T"</b>' }), { teams: TEAMS });
  assert.doesNotMatch(html, / data-x="/, "no attribute is injected through the kind");
  assert.match(html, /cc-card-x&quot; data-x=&quot;y/, "the quotes are escaped inside the class attribute");
  assert.match(html, /&lt;b&gt;&quot;T&quot;&lt;\/b&gt;/);
  const doc = dom(html);
  assert.equal(doc.querySelector(".cc-card").getAttribute("data-x"), null);
  assert.equal(doc.querySelector(".cc-card-title").textContent, '<b>"T"</b>');
});

// --- 6. Navigation, views, the week mode -----------------------------------------

test("6a. the arrows move by the view's unit, Today returns, a view switch keeps the anchor, Day opens the selected day", async () => {
  const calls = installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-view", view: "month" });
  assert.equal(state.centralCalendar.view, "month");
  assert.equal(state.centralCalendar.anchor, TODAY, "a view switch keeps the anchor");
  await act({ action: "central-calendar-prev" });
  assert.equal(state.centralCalendar.anchor, addMonthsIso(TODAY, -1));
  assert.match(dom().querySelector(".cc-period").textContent, /^[A-Z][a-z]+ \d{4}$/);
  await act({ action: "central-calendar-today" });
  assert.equal(state.centralCalendar.anchor, TODAY);
  await act({ action: "central-calendar-view", view: "day" });
  assert.equal(state.centralCalendar.view, "day");
  await act({ action: "central-calendar-next" });
  assert.equal(state.centralCalendar.anchor, addDaysIso(TODAY, 1));
  await act({ action: "central-calendar-view", view: "week" });
  await act({ action: "central-calendar-select-day", date: DAY(6) });
  await act({ action: "central-calendar-view", view: "day" });
  assert.equal(state.centralCalendar.anchor, DAY(6), "Day shows the day the strip or grid pointed at");
  await act({ action: "central-calendar-view", view: "year" });
  assert.equal(state.centralCalendar.view, "day", "no year view (D12)");
  await act({ action: "central-calendar-open-day", date: DAY(2) });
  assert.equal(state.centralCalendar.view, "day");
  assert.equal(state.centralCalendar.anchor, DAY(2));
  assert.equal(dom().querySelector(".cc-period").textContent, view.centralCalendarLongDate(DAY(2)));
  assert.ok(calls.length >= 3);
  await act({ action: "central-calendar-select-day", date: "not-a-date" });
  assert.equal(state.centralCalendar.selectedDate, DAY(2), "a malformed date changes nothing");
});

test("6b. the week mode is kept per device and read on the first load; a throwing storage is harmless", async () => {
  const store = {};
  globalThis.localStorage = { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } };
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.weekMode, "list");
  await act({ action: "central-calendar-mode", mode: "grid" });
  assert.equal(store["optimove.central-calendar.week-mode"], "grid");
  resetCentralCalendarForWorkspaceChange();
  await loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.weekMode, "grid", "read again on a fresh slice");
  globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readCentralCalendarWeekMode(), "list");
  await act({ action: "central-calendar-mode", mode: "list" });
  assert.equal(state.centralCalendar.weekMode, "list");
});

test("6c. the layout word comes from matchMedia; without it the screen is wide", () => {
  assert.equal(centralCalendarLayout(), "wide");
  globalThis.window.matchMedia = (query) => ({ matches: query === "(max-width: 760px)" || query === "(max-width: 1023px)" });
  assert.equal(centralCalendarLayout(), "phone");
  globalThis.window.matchMedia = (query) => ({ matches: query === "(max-width: 1023px)" });
  assert.equal(centralCalendarLayout(), "medium");
  globalThis.window.matchMedia = () => ({ matches: false });
  assert.equal(centralCalendarLayout(), "wide");
  globalThis.window.matchMedia = () => { throw new Error("no"); };
  assert.equal(centralCalendarLayout(), "wide");
  delete globalThis.window.matchMedia;
});

test("6f. a repaint keeps the chip rows' sideways scroll and the focused control (the shell's snapshot)", () => {
  const row = (label, scrollLeft) => ({ scrollLeft, getAttribute: (name) => (name === "aria-label" ? label : null) });
  const focused = { dataset: { action: "central-calendar-toggle-kind", kind: "test" }, focus() { this.focused = true; } };
  const before = { querySelectorAll: () => [row("Groups", 120), row("Types", 0)], contains: () => true };
  globalThis.document.activeElement = focused;
  const snapshot = captureCentralCalendarView(before);
  assert.deepEqual(snapshot.scroll, { Groups: 120 });
  assert.equal(snapshot.focus.action, "central-calendar-toggle-kind");
  assert.equal(snapshot.focus.kind, "test");
  const groups = row("Groups", 0);
  const restoredChip = { focus(options) { this.focusedWith = options; } };
  let asked = "";
  const after = { querySelectorAll: () => [groups, row("Types", 0)], querySelector: (selector) => { asked = selector; return restoredChip; } };
  restoreCentralCalendarView(after, snapshot);
  assert.equal(groups.scrollLeft, 120, "the Groups row is where the coach left it");
  assert.equal(asked, '[data-action="central-calendar-toggle-kind"]:not(.cc-sheet-backdrop)[data-kind="test"]', "never the sheet's backdrop, which shares the close action");
  assert.deepEqual(restoredChip.focusedWith, { preventScroll: true });
  delete globalThis.document.activeElement;
  assert.equal(captureCentralCalendarView(null), null);
  restoreCentralCalendarView(after, null);
});

test("6d. a phone's week is the seven-day strip over the selected day's list; its month cells select a day", async () => {
  installFetchMock(okResponder());
  layout = "phone";
  await loadCentralCalendar({ render });
  let doc = dom();
  assert.equal(doc.querySelectorAll(".cc-strip-day").length, 7);
  assert.equal(doc.querySelector(".cc-strip").getAttribute("role"), "group");
  assert.equal(doc.querySelector(".cc-strip-day.is-selected").getAttribute("aria-pressed"), "true");
  assert.equal(doc.querySelectorAll('.cc-strip-day[aria-pressed="false"]').length, 6);
  assert.equal(doc.querySelector(".cc-week"), null, "no seven columns on a phone");
  assert.equal(doc.querySelector(".cc-mode-switch"), null, "no inert time-grid switch on a phone");
  const selected = doc.querySelector(".cc-strip-day.is-selected");
  assert.equal(selected.dataset.date, TODAY);
  assert.equal(doc.querySelector(".cc-day-list").getAttribute("aria-label"), view.centralCalendarLongDate(TODAY));
  await act({ action: "central-calendar-select-day", date: DAY(1) });
  doc = dom();
  assert.equal(doc.querySelector(".cc-strip-day.is-selected").dataset.date, DAY(1));
  assert.deepEqual([...doc.querySelectorAll(".cc-day-list .cc-card")].map((card) => card.dataset.key), ["external:sch-1:d1"]);
  await act({ action: "central-calendar-view", view: "month" });
  doc = dom();
  const cell = doc.querySelector(`.cc-month-cell[data-date="${DAY(0)}"]`);
  assert.equal(cell.tagName, "BUTTON");
  assert.equal(cell.dataset.action, "central-calendar-select-day");
  assert.equal(cell.querySelector(".cc-month-count").textContent, "3");
  assert.ok(doc.querySelector(".cc-day-list"), "the selected day's list follows the grid");
});

test("6e. a wide month cell holds up to three compact cards and '+n more'; the day number opens the day", async () => {
  const many = [0, 1, 2, 3, 4].map((index) => baseItem({ key: `p:${index}`, date: DAY(0), title: `Session ${index}`, slot: { amPm: "AM", bta: "T", order: index } }));
  installFetchMock(okResponder({ items: many }));
  state.centralCalendar.view = "month";
  await loadCentralCalendar({ render });
  const doc = dom();
  const cell = doc.querySelector(".cc-month-cell:not(.is-outside) .cc-month-number[data-date]")?.closest(".cc-month-cell") || doc.querySelector(`.cc-month-number[data-date="${DAY(0)}"]`).closest(".cc-month-cell");
  const dayCell = doc.querySelector(`.cc-month-number[data-date="${DAY(0)}"]`).closest(".cc-month-cell");
  assert.ok(cell);
  assert.equal(dayCell.querySelectorAll(".cc-mini").length, 3);
  assert.equal(dayCell.querySelector(".cc-month-more").textContent, "+2 more");
  assert.equal(dayCell.querySelector(".cc-month-more").dataset.action, "central-calendar-open-day");
  assert.equal(dayCell.querySelector(".cc-month-number").dataset.action, "central-calendar-open-day");
});

// --- 7. The panel and the drill-ins ------------------------------------------------

test("7a. opening an item reads its day with include=athletes, matches by key, lists the athletes by name with their state", async () => {
  const calls = installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  assert.equal(calls.length, 2);
  const query = params(calls[1]);
  assert.equal(query.get("from"), DAY(0));
  assert.equal(query.get("to"), DAY(0));
  assert.equal(query.get("include"), "athletes");
  assert.equal(query.get("today"), TODAY);
  const panel = state.centralCalendar.panel;
  assert.equal(panel.open, true);
  assert.equal(panel.loading, false);
  assert.equal(panel.athletes.length, 3);
  const doc = dom();
  const aside = doc.querySelector(".cc-panel");
  assert.ok(aside && aside.tagName === "ASIDE");
  assert.equal(aside.querySelector("#ccPanelTitle").textContent, "Team training");
  assert.equal(aside.querySelector(".cc-badge").textContent, "Awaiting RPE");
  assert.match(aside.querySelector(".cc-panel-sentence").textContent, /3 RPE entries are still missing/);
  assert.equal(aside.querySelector(".cc-panel-count").textContent, "RPE 17/20");
  const rows = [...aside.querySelectorAll(".cc-athlete")];
  assert.deepEqual(rows.map((row) => row.querySelector(".cc-athlete-name").textContent), ["Ana Test", "Luka Test", "Marko Test"]);
  assert.deepEqual(rows.map((row) => row.querySelector(".cc-athlete-state").textContent), ["RPE missing", "Not asked", "RPE entered"]);
  assert.match(rows[1].querySelector(".cc-athlete-teams").textContent, /U19, U17/);
  assert.ok(doc.querySelector('.cc-card[data-key="planned:batch-1"]').classList.contains("is-open"));
  assert.ok(doc.querySelector(".central-calendar").classList.contains("cc-panel-open"));
  // The same card again folds the panel; another item opens it on that item.
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  assert.equal(state.centralCalendar.panel.open, false);
  await act({ action: "central-calendar-open-item", key: "external:sch-1:d1", date: DAY(1) });
  assert.equal(state.centralCalendar.panel.key, "external:sch-1:d1");
  assert.equal(calls.length, 3, "another day is another read; the first day stays cached");
  await act({ action: "central-calendar-open-item", key: "planned:batch-2", date: DAY(0) });
  assert.equal(calls.length, 3, "the same day again comes from the cache");
});

test("7b. the Training Load button: one activity opens the detail, several open the day, none shows no button", async () => {
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  const opened = [];
  const openTrainingLoad = async (target) => { opened.push(target); };
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) }, { openTrainingLoad });
  let button = dom().querySelector('.cc-panel [data-action="central-calendar-open-training-load"]');
  assert.equal(button.textContent, "Open the day in Training Load");
  assert.equal(button.dataset.activityId, undefined);
  assert.match(dom().querySelector(".cc-panel").textContent, /3 activities are recorded/);
  await act({ action: button.dataset.action, date: button.dataset.date }, { openTrainingLoad });
  assert.deepEqual(opened, [{ activityId: null, date: DAY(0) }]);
  await act({ action: "central-calendar-open-item", key: "activity:act-gps", date: DAY(0) }, { openTrainingLoad });
  button = dom().querySelector('.cc-panel [data-action="central-calendar-open-training-load"]');
  assert.equal(button.textContent, "Open in Training Load");
  assert.equal(button.dataset.activityId, "act-gps");
  const gpsPanel = dom().querySelector(".cc-panel");
  assert.equal(gpsPanel.querySelector(".cc-panel-subtitle").textContent, "Recorded athletes (20)", "an imported activity lists its recorded participants");
  assert.match(gpsPanel.textContent, /Who still needs an attendance state is on the Roster tab/);
  assert.match(gpsPanel.querySelector(".cc-panel-sentence").textContent, /Attendance is not complete: 3 athletes still need a state\./);
  assert.doesNotMatch(gpsPanel.textContent, /activit(y|ies) (is|are) recorded for this training/, "an activity card is the activity itself");
  await act({ action: button.dataset.action, activityId: button.dataset.activityId, date: button.dataset.date }, { openTrainingLoad });
  assert.deepEqual(opened[1], { activityId: "act-gps", date: DAY(0) });
  await act({ action: "central-calendar-open-item", key: "test:tsch-1:d2", date: DAY(2) }, { openTrainingLoad });
  assert.equal(dom().querySelector('.cc-panel [data-action="central-calendar-open-training-load"]'), null);
});

test("7c. an athlete opens their weekly plan on the item's day by the roster's id only; outside the roster the row has no drill-in (D5)", async () => {
  installFetchMock(okResponder());
  state.athletes = [{ athlete_uuid: ATHLETES[0].athleteId, athlete_id: "A-17", athlete: "Marko Test" }];
  await loadCentralCalendar({ render });
  const opened = [];
  const openWeeklyPlanForAthleteOnDate = async (athleteId, date) => { opened.push([athleteId, date]); };
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  const rows = [...dom().querySelectorAll(".cc-panel .cc-athlete")];
  const marko = rows.find((row) => row.textContent.includes("Marko"));
  const ana = rows.find((row) => row.textContent.includes("Ana"));
  assert.equal(marko.tagName, "BUTTON");
  assert.equal(marko.dataset.action, "central-calendar-open-athlete");
  assert.equal(ana.tagName, "DIV", "an athlete outside the roster is not a button");
  assert.equal(ana.dataset.action, undefined);
  assert.match(ana.textContent, /Not in this workspace's roster/);
  assert.match(ana.textContent, /RPE missing/, "her state is still shown");
  await act({ action: marko.dataset.action, athleteId: marko.dataset.athleteId, date: marko.dataset.date }, { openWeeklyPlanForAthleteOnDate });
  // A forged click with a UUID outside the roster never reaches the weekly plan.
  await act({ action: "central-calendar-open-athlete", athleteId: ATHLETES[1].athleteId, date: DAY(0) }, { openWeeklyPlanForAthleteOnDate });
  assert.deepEqual(opened, [["A-17", DAY(0)]], "never a UUID: the plan route reads the roster id, not the UUID");
  assert.equal(centralCalendarRosterAthleteId("nobody"), null);
  assert.deepEqual([...centralCalendarRosterIndex().entries()], [[ATHLETES[0].athleteId, "A-17"]]);
});

test("7f. an open item that a re-read no longer carries closes its panel with one line, never an empty panel column", async () => {
  let items = ITEMS;
  installFetchMock((call) => ({ status: 200, body: answerFor(call.url, { items }) }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  assert.ok(dom().querySelector(".central-calendar").classList.contains("cc-panel-open"));
  // The plan was deleted elsewhere; the Builder exit (or the TTL) drops the cache.
  items = ITEMS.filter((item) => item.key !== "planned:batch-1");
  invalidateCentralCalendarCache();
  await loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.panel.open, false);
  assert.match(state.centralCalendar.notice, /The item you had open is no longer on this day; the calendar is up to date\./);
  assert.equal(state.centralCalendar.refreshError, "", "a notice, not a failure");
  const doc = dom();
  assert.equal(doc.querySelector(".cc-panel"), null);
  assert.ok(!doc.querySelector(".central-calendar").classList.contains("cc-panel-open"), "no empty panel column");
  assert.match(doc.querySelector(".cc-refresh-note").textContent, /no longer on this day/);
  assert.equal(doc.querySelector(".cc-refresh-note button"), null, "nothing failed, so nothing to try again");
  // A panel whose item is still there survives a re-read.
  await act({ action: "central-calendar-open-item", key: "planned:batch-2", date: DAY(0) });
  invalidateCentralCalendarCache();
  await loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.panel.open, true);
  assert.ok(dom().querySelector(".cc-panel"));
});

test("7d. a failed day read keeps the panel with Try again; a key no longer in the answer says the item changed", async () => {
  let dayFails = true;
  let dayItems = ITEMS;
  installFetchMock((call) => {
    const query = params(call);
    if (query.get("include") === "athletes" && dayFails) return { status: 503, body: { error: "database_busy" } };
    return { status: 200, body: answerFor(call.url, { items: dayItems }) };
  });
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  assert.equal(state.centralCalendar.panel.error, "failed");
  let doc = dom();
  assert.match(doc.querySelector(".cc-panel").textContent, /Athlete names could not be loaded/);
  assert.ok(doc.querySelector('.cc-panel [data-action="central-calendar-retry-athletes"]'));
  assert.equal(doc.querySelector("#ccPanelTitle").textContent, "Team training", "the card's own facts stay");
  dayFails = false;
  dayItems = ITEMS.filter((item) => item.key !== "planned:batch-1");
  await act({ action: "central-calendar-retry-athletes" });
  assert.equal(state.centralCalendar.panel.error, "changed");
  doc = dom();
  assert.match(doc.querySelector(".cc-panel").textContent, /This item has changed/);
  assert.ok(doc.querySelector('.cc-panel [data-action="central-calendar-retry"]'));
});

test("7e. Escape and Back close an open panel first and only on the calendar screen; a range change closes it too", async () => {
  installFetchMock(okResponder());
  await loadCentralCalendar({ render });
  assert.equal(closeCentralCalendarPanel(), false, "nothing to close");
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  state.activeTab = "coach-home";
  assert.equal(closeCentralCalendarPanel(), false, "another screen's Back never touches the calendar");
  state.activeTab = "central-calendar";
  const rendersBefore = renderCount;
  assert.equal(closeCentralCalendarPanel(render), true);
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(renderCount, rendersBefore + 1, "the close draws the screen again");
  assert.equal(dom().querySelector(".cc-panel"), null);
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  await act({ action: "central-calendar-next" });
  assert.equal(state.centralCalendar.panel.open, false);
  await act({ action: "central-calendar-prev" });
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  // Closing gives the focus back to the card the panel was opened from (a
  // week card or a month compact card), never to the sheet's backdrop.
  const focused = [];
  globalThis.document.querySelector = (selector) => (selector.includes('[data-key="planned:batch-1"]') ? { focus: (options) => focused.push([selector, options]) } : null);
  await act({ action: "central-calendar-close-panel" });
  globalThis.document.querySelector = () => null;
  assert.equal(state.centralCalendar.panel.open, false);
  assert.equal(focused.length, 1);
  assert.equal(focused[0][0], '.cc-card[data-key="planned:batch-1"], .cc-mini[data-key="planned:batch-1"]');
  assert.deepEqual(focused[0][1], { preventScroll: true });
  layout = "phone";
  await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
  const doc = dom();
  const sheet = doc.querySelector(".cc-panel.cc-sheet");
  assert.ok(sheet, "below 1024 px the panel is a sheet");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(doc.querySelector(".cc-sheet-backdrop").tagName, "BUTTON");
  assert.equal(doc.querySelector(".cc-sheet-backdrop").dataset.action, "central-calendar-close-panel");
});

// --- 8. States -----------------------------------------------------------------

test("8a. every failed read has its sentence, its code and Try again; 403 adds the workspace sentence", async () => {
  const cases = [
    [{ status: 400, body: { error: "invalid_today", message: "today must be within 2 days of the server's date." } }, "invalid_today", /device's date differs/],
    [{ status: 400, body: { error: "range_too_long", message: "Date range must not exceed 62 days." } }, "range_too_long", /could not be read/],
    [{ status: 401, body: { error: "Unauthorized" } }, "unauthorized", /sign in again/],
    [{ status: 403, body: { error: "Forbidden" } }, "forbidden", /No calendar for this workspace/],
    [{ status: 503, body: { error: "database_busy" } }, "database_busy", /busy/],
    [{ throwNetworkError: true }, "network", /Could not reach the server/],
    [{ status: 500, body: { error: "internal_error" } }, "internal_error", /could not be read/],
  ];
  for (const [response, code, pattern] of cases) {
    clearAllViewCache();
    resetCentralCalendarForWorkspaceChange();
    installFetchMock(() => response);
    await loadCentralCalendar({ render });
    const cal = state.centralCalendar;
    assert.equal(cal.errorCode, code);
    assert.match(cal.error, pattern);
    assert.equal(cal.loading, false);
    assert.equal(cal.data, null);
    const doc = dom();
    assert.ok(doc.querySelector('.cc-state-error [data-action="central-calendar-retry"]'), `${code}: Try again`);
    assert.equal(Boolean(doc.querySelector(".cc-state-hint")), code === "forbidden");
    if (code === "range_too_long") assert.match(doc.querySelector(".cc-technical").textContent, /62 days/);
  }
  assert.equal(describeCentralCalendarError({ status: 400, data: { error: "invalid_today" } }).code, "invalid_today");
  assert.equal(describeCentralCalendarError(new TypeError("Failed to fetch")).code, "network");
});

test("8b. Try again reads past the cache; a failed background refresh keeps the shown calendar with a note", async () => {
  let fail = true;
  const calls = installFetchMock((call) => (fail ? { status: 503, body: { error: "database_busy" } } : { status: 200, body: answerFor(call.url) }));
  await loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.errorCode, "database_busy");
  fail = false;
  await act({ action: "central-calendar-retry" });
  assert.equal(calls.length, 2);
  assert.equal(state.centralCalendar.error, "");
  assert.ok(state.centralCalendar.data);
  fail = true;
  await loadCentralCalendar({ render, forceRefresh: true });
  assert.equal(calls.length, 3);
  assert.ok(state.centralCalendar.data, "the loaded calendar stays");
  assert.equal(state.centralCalendar.error, "");
  assert.match(state.centralCalendar.refreshError, /Could not refresh/);
  assert.match(dom().querySelector(".cc-refresh-note").textContent, /Could not refresh/);
  assert.equal(dom().querySelectorAll(".cc-card").length, 9);
});

test("8b2. a failed read after an invalidation keeps the calendar on screen with the note, never a blank error state", async () => {
  let fail = false;
  installFetchMock((call) => (fail ? { status: 403, body: { error: "Forbidden" } } : { status: 200, body: answerFor(call.url) }));
  await loadCentralCalendar({ render });
  // A plan saved in the Builder drops the cache while the calendar is open.
  invalidateCentralCalendarCache();
  fail = true;
  await loadCentralCalendar({ render });
  assert.ok(state.centralCalendar.data, "the loaded range stays");
  assert.equal(state.centralCalendar.error, "", "no error state over a shown calendar");
  assert.match(state.centralCalendar.refreshError, /No calendar for this workspace\. Showing the last loaded calendar\./);
  assert.equal(dom().querySelectorAll(".cc-card").length, 9);
  assert.equal(dom().querySelector(".cc-state-error"), null);
  assert.ok(dom().querySelector(".cc-refresh-note"));
});

test("8c. empty states: nothing in the period, or nothing matching the filters with Clear filters", async () => {
  installFetchMock(okResponder({ items: [] }));
  await loadCentralCalendar({ render });
  assert.match(dom().querySelector(".cc-empty-text").textContent, /Nothing planned or recorded this week/);
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  installFetchMock(okResponder({ items: ITEMS.filter((item) => item.kind === "planned") }));
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-toggle-kind", kind: "test" });
  const doc = dom();
  assert.match(doc.querySelector(".cc-empty-text").textContent, /Nothing matches these filters/);
  assert.ok(doc.querySelector('.cc-empty [data-action="central-calendar-clear-filters"]'));
  assert.equal(doc.querySelectorAll(".cc-card").length, 0);
});

test("8d. the loading state paints the toolbar at once and the grid area says so", async () => {
  const pending = [];
  installFetchMock((call) => new Promise((resolve) => { pending.push({ call, resolve }); }));
  const load = loadCentralCalendar({ render });
  assert.equal(state.centralCalendar.loading, true);
  const doc = dom();
  assert.ok(doc.querySelector(".cc-toolbar"));
  assert.match(doc.querySelector(".cc-state-loading").textContent, /Loading calendar/);
  assert.equal(doc.querySelector(".cc-filters"), null, "no chips before the data");
  pending[0].resolve({ status: 200, body: answerFor(pending[0].call.url) });
  await load;
  assert.equal(state.centralCalendar.loading, false);
});

// --- 9. Regression guards --------------------------------------------------------

test("9a. no data-tab attribute anywhere, and every control is a <button> (the app.js global [data-tab] trap)", async () => {
  installFetchMock(okResponder());
  for (const currentLayout of ["wide", "medium", "phone"]) {
    layout = currentLayout;
    for (const currentView of ["week", "month", "day"]) {
      clearAllViewCache();
      resetCentralCalendarForWorkspaceChange();
      state.centralCalendar.view = currentView;
      await loadCentralCalendar({ render });
      if (currentLayout === "wide" && currentView === "week") await act({ action: "central-calendar-mode", mode: "grid" });
      await act({ action: "central-calendar-open-item", key: "planned:batch-1", date: DAY(0) });
      assert.doesNotMatch(rendered, /data-tab=/, `${currentLayout} ${currentView}: no data-tab`);
      const doc = dom();
      for (const node of doc.querySelectorAll("[data-action]")) {
        assert.equal(node.tagName, "BUTTON", `${currentLayout} ${currentView}: ${node.dataset.action} on a <${node.tagName.toLowerCase()}>`);
        assert.equal(node.getAttribute("type"), "button");
      }
      assert.equal(doc.querySelectorAll("input, select, textarea").length, 0, "K1b renders no text input");
    }
  }
});

test("9b. a stranger action is not handled; the calendar's own action names all start with central-calendar-", async () => {
  assert.equal(await act({ action: "training-load-calendar-next" }), false);
  assert.equal(await act({ action: "central-calendar-unknown" }), false);
});

// --- 10. The D1 consequences in the shell (manager decision E) -----------------------

test("10a. the coach's Back root is Home and the rail's Calendar highlights the central calendar (app.js and navigation.js sources)", () => {
  const appJs = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appJs, /const rootTab = isAthleteMode\(\) \? "athlete-home" : "coach-home";/);
  assert.match(appJs, /els\.calendarToggle\?\.addEventListener\("click", openCentralCalendarFromRail\);/);
  assert.match(appJs, /if \(state\.activeTab === "central-calendar"\) return loadCentralCalendar\(\);/);
  assert.doesNotMatch(appJs, /openWeeklyCalendarFromRail/, "the rail no longer opens the weekly plan's month picker");
  assert.match(appJs, /if \(type\.startsWith\("central-calendar-"\)\) \{\s*await handleCentralCalendarAction\(action, \{ render: renderCentralCalendar, openWeeklyPlanForAthleteOnDate, openTrainingLoad: openTrainingLoadFromCalendar \}\);/, "the content click dispatch");
  assert.equal((appJs.match(/if \(closeCentralCalendarPanel\(renderCentralCalendar\)\) return/g) || []).length, 2, "Back and Escape both close the panel first and draw the screen again");
  assert.match(appJs, /resetCentralCalendarForWorkspaceChange\(\);\s*invalidateCentralCalendarCache\(\);/, "a workspace switch resets the slice and the cache");
  assert.match(appJs, /if \(state\.activeTab === "central-calendar"\) return loadCentralCalendar\(\{ forceRefresh: true \}\);/, "and reloads an open calendar");
  // The function bodies, by brace matching (the menu-cache-policy-coverage pattern).
  const body = (source, marker) => {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${marker} exists`);
    // The body's brace comes after the parameter list (which may destructure).
    const open = source.indexOf("{", source.indexOf(")", start + marker.length - 1));
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
    }
    return "";
  };
  const handOff = body(appJs, "async function openTrainingLoadFromCalendar(");
  const guard = handOff.indexOf("rosterMayBeLeft()");
  const tabChange = handOff.indexOf('state.activeTab = "training-load"');
  assert.ok(guard >= 0 && tabChange > guard, "Activities' roster question is asked before the tab changes");
  assert.ok(handOff.indexOf("resetActivityRoster(") > guard && handOff.indexOf("resetActivityRoster(") < tabChange, "and the roster state is dropped after a Yes, so the reused branch never asks twice");
  assert.match(handOff, /"training-load-calendar-select-day"/, "the day hand-off reuses Activities' own day selection");
  assert.match(body(appJs, "async function loadAthletes("), /invalidateCentralCalendarCache\(\);/, "the roster reload after a Settings mutation drops the calendar cache");
  assert.match(body(appJs, "function handleAppBack("), /closeCentralCalendarPanel\(renderCentralCalendar\)/, "Back closes the panel");
  assert.match(appJs.slice(appJs.indexOf('document.addEventListener("keydown", (event) => {'), appJs.indexOf('document.addEventListener("keydown", (event) => {') + 1200), /closeCentralCalendarPanel\(renderCentralCalendar\)/, "Escape closes the panel");
  const builderJs = readFileSync(new URL("../builder-actions.js", import.meta.url), "utf8");
  assert.equal((builderJs.match(/invalidateCentralCalendarCache\(\);/g) || []).length, 2, "both weekly-plan exits of the Builder");
  const policyJs = readFileSync(new URL("../menu-cache-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(policyJs, /outside this browser/, "the policy names the in-browser writers the TTL alone covers");
  const navigationJs = readFileSync(new URL("../navigation.js", import.meta.url), "utf8");
  assert.match(navigationJs, /#calendarToggle"\)\?\.classList\.toggle\("is-active", state\.activeTab === "central-calendar"\)/);
});

test("10b. a coach who loses Settings access falls back to Home; the athlete shell keeps its weekly plan", () => {
  state.currentUser = { id: "u", activeWorkspace: { type: "athlete", scopeId: null } };
  state.activeTab = "organization";
  athleteMode = false;
  renderLibraryNav();
  assert.equal(state.activeTab, "coach-home");
  state.activeTab = "organization";
  athleteMode = true;
  renderLibraryNav();
  assert.equal(state.activeTab, "weekly");
  state.activeTab = "builder";
  renderLibraryNav();
  assert.equal(state.activeTab, "weekly", "the athlete shell's Builder fallback is unchanged");
});
