// Central calendar K5-1 and K5-2 (docs/ai/central-calendar-k5-12-contract.md section 4): the `gps` icon, the H4 marks,
// the H5 day chips, *Show only* with GPS imports and Other activities, and *Go there* with its three openers. Through
// the real handlers, loaders and templates with a fake fetch that honours `kinds` as the route does (the FE-D16
// pattern) and JSDOM for the markup; the openers of app.js run from its source against recording fakes.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";
import { fakeAction } from "./support/dom.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { centralCalendarRosterIndex, handleCentralCalendarAction, handleCentralCalendarKeydown, revealCentralCalendarShowOnly } = await import("../central-calendar-actions.js");
const { centralCalendarServerKinds, loadCentralCalendar, resetCentralCalendarForWorkspaceChange } = await import("../central-calendar-data.js");
const view = await import("../central-calendar-view.js");
const { renderIconSvg } = await import("../icon-render.js");
const { addDaysIso, localDateIso, weekMondayIso } = await import("../utils.js");

const TODAY = localDateIso();
const MONDAY = weekMondayIso(TODAY);
const DAY = (offset) => addDaysIso(MONDAY, offset);
const U19 = "11111111-1111-4111-8111-111111111111";
const TEAMS = [{ teamId: U19, name: "U19", athleteCount: 20 }];

function item(overrides) {
  return {
    key: "", kind: "planned", date: DAY(0), title: null, slot: null, startTime: null, startsAt: null, teamIds: [U19], athleteIds: [],
    athleteCount: 0, expects: [], status: "none", rpe: null, attendance: null, results: null, cancelled: false, projected: false, links: {},
    ...overrides,
  };
}

// A coach's week: an event that holds an import and folds an RPE request; a planned training holding an import
// through its session; an RPE request holding one through its assignment; a lone import; a coach-made activity; a
// test; a planned training without one. An item folded into the event carries `foldedInto` and is its own card only
// in a read whose kinds leave `event` out (the server's rule).
const EVENT = item({
  key: "event:ev-1:d1", kind: "event", eventId: "ev-1", eventKind: "training", eventTypeLabel: "Training", date: DAY(1), title: "Team training",
  startTime: "10:00", expects: ["rpe", "device_data"], holdsImport: true, scheduleFold: { external: "folded", test: null }, canManage: true,
  links: { activityIds: ["act-ev"], externalScheduleId: "sch-ev", testScheduleId: "tsch-ev" }, rpe: { asked: 18, submitted: 12 },
});
const FOLDED_RPE = item({ key: "external:sch-ev:d1", kind: "external", date: DAY(1), title: "Gym", foldedInto: true, links: { activityIds: [], externalScheduleId: "sch-ev" } });
const PLANNED_GPS = item({ key: "planned:p-gps", kind: "planned", date: DAY(2), title: "Speed", slot: { amPm: "AM", bta: "T", order: 1 }, holdsImport: true, links: { activityIds: ["act-p"], planIds: ["plan-1"] } });
const RPE_GPS = item({ key: "external:sch-2:d2", kind: "external", date: DAY(2), title: "Gym", startTime: "16:00", holdsImport: true, status: "planned", links: { activityIds: ["act-r"], externalScheduleId: "sch-2" } });
const LONE_GPS = item({ key: "activity:act-gps", kind: "activity", date: DAY(3), title: "GPS session", startTime: "10:05", origin: "source_import", attendance: { roster: 18, present: 15, needsState: 3 }, status: "awaiting_entry", links: { activityIds: ["act-gps"] } });
const MANUAL = item({ key: "activity:act-man", kind: "activity", date: DAY(3), title: null, origin: "manual", links: { activityIds: ["act-man"] } });
const TEST = item({ key: "test:tsch-1:d4", kind: "test", date: DAY(4), title: "CMJ test", startTime: "08:30", status: "awaiting_entry", expects: ["test_result"], results: { expected: 18, completed: 7 }, links: { testScheduleId: "tsch-1" } });
const PLANNED = item({ key: "planned:p-1", kind: "planned", date: DAY(4), title: "Strength", slot: { amPm: "PM", bta: "T", order: 1 }, holdsImport: false, links: { activityIds: [], planIds: ["plan-2"] } });
const WEEK = [EVENT, FOLDED_RPE, PLANNED_GPS, RPE_GPS, LONE_GPS, MANUAL, TEST, PLANNED];

function server(items = WEEK) {
  return (call) => {
    if (!call.url.startsWith("/api/calendar?")) return { status: 404, body: { error: "not found" } };
    const params = new URL(call.url, "http://localhost").searchParams;
    const raw = params.get("kinds");
    const kinds = raw ? raw.split(",") : null;
    if (kinds && kinds.some((kind) => !["event", "planned", "activity", "external", "test"].includes(kind))) return { status: 400, body: { error: "invalid_kinds" } };
    const from = params.get("from");
    const to = params.get("to");
    const days = [];
    for (let date = from; date <= to; date = addDaysIso(date, 1)) {
      const dayItems = items
        .filter((entry) => entry.date === date)
        .filter((entry) => !kinds || kinds.includes(entry.kind))
        .filter((entry) => !(entry.foldedInto && (!kinds || kinds.includes("event"))))
        .map(({ foldedInto, ...entry }) => entry);
      days.push({ date, items: dayItems });
    }
    return { status: 200, body: { from, to, today: params.get("today"), workspace: { type: "club", scopeId: "club-1" }, teams: TEAMS, days } };
  };
}
const kindsOf = (calls) => calls.filter((call) => call.url.startsWith("/api/calendar?")).map((call) => new URL(call.url, "http://localhost").searchParams.get("kinds"));

let rendered = "";
let layout = "wide";
function render() {
  rendered = view.renderCentralCalendarHtml(state.centralCalendar, { today: TODAY, layout, roster: centralCalendarRosterIndex() });
}
const dom = (html = rendered) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
const shownKeys = () => [...dom().querySelectorAll(".cc-card, .cc-daychip")].map((node) => node.dataset.key);
const act = (dataset, handlers = {}) => handleCentralCalendarAction(fakeAction(dataset), { render, ...handlers });

beforeEach(() => {
  clearAllViewCache();
  resetCentralCalendarForWorkspaceChange();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1", label: "First Club" } };
  state.activeTab = "central-calendar";
  state.athletes = [];
  layout = "wide";
  rendered = "";
});

// --- 2.1 Imported and its icon --------------------------------------------------------------------------------------

test("K5-1. imported: api_import and source_import are `gps`; manual and the self-report origins are `activity`; an event, planned or RPE card uses holdsImport", () => {
  for (const origin of ["api_import", "source_import"]) {
    assert.equal(view.centralCalendarItemImported(item({ kind: "activity", origin })), true, origin);
    assert.equal(view.centralCalendarItemIconKey(item({ kind: "activity", origin })), "gps", origin);
  }
  for (const origin of ["manual", "planned_session", "external_assignment", undefined]) {
    assert.equal(view.centralCalendarItemImported(item({ kind: "activity", origin })), false, String(origin));
    assert.equal(view.centralCalendarItemIconKey(item({ kind: "activity", origin })), "activity", String(origin));
  }
  for (const kind of ["event", "planned", "external"]) {
    assert.equal(view.centralCalendarItemImported(item({ kind, holdsImport: true })), true, kind);
    assert.equal(view.centralCalendarItemImported(item({ kind, holdsImport: false })), false, kind);
    assert.equal(view.centralCalendarItemImported(item({ kind })), false, `${kind} without the key (the athlete's answer)`);
  }
  assert.equal(view.centralCalendarItemImported(item({ kind: "test", holdsImport: true })), false, "a test card never holds an import");
  assert.equal(view.centralCalendarItemIconKey(item({ kind: "test" })), "clipboard", "Q7: a test is clipboard everywhere");
  assert.equal(view.CENTRAL_CALENDAR_SHOW_ONLY_ICONS.test, "clipboard");
  assert.equal(view.centralCalendarKindLabel(item({ kind: "activity", origin: "source_import" })), "Imported activity");
});

// --- 2.3 H4 marks ---------------------------------------------------------------------------------------------------

test("K5-2. marks: each row of the H4 table, both separate cases, a cancelled card, the GPS mark on a planned and an RPE card, the order and the words", () => {
  const marks = (overrides) => view.centralCalendarCardMarks(item({ kind: "event", ...overrides }));
  assert.deepEqual(marks({ scheduleFold: { external: "folded", test: null } }), ["rpe"], "a folded RPE request");
  assert.deepEqual(marks({ expects: ["rpe"] }), ["rpe"], "RPE expected, nothing beside it");
  assert.deepEqual(marks({ expects: ["rpe"], scheduleFold: { external: "separate", test: null } }), [], "RPE separate: its own chip, no mark");
  assert.deepEqual(marks({ holdsImport: true }), ["gps"]);
  assert.deepEqual(marks({ expects: ["device_data"] }), [], "waiting for device data is not an import");
  assert.deepEqual(marks({ scheduleFold: { external: null, test: "folded" } }), ["test"]);
  assert.deepEqual(marks({ expects: ["test_result"] }), ["test"]);
  assert.deepEqual(marks({ expects: ["test_result"], scheduleFold: { external: null, test: "separate" } }), [], "test separate: no mark");
  assert.deepEqual(marks({ expects: ["test_result", "rpe"], holdsImport: true }), ["rpe", "gps", "test"], "the order is RPE, GPS, test");
  assert.deepEqual(marks({ expects: ["rpe"], holdsImport: true, cancelled: true }), [], "Q6: no marks on a cancelled event");
  for (const kind of ["planned", "external"]) {
    assert.deepEqual(view.centralCalendarCardMarks(item({ kind, holdsImport: true, expects: ["rpe", "test_result"] })), ["gps"], `${kind}: only the GPS mark`);
    assert.deepEqual(view.centralCalendarCardMarks(item({ kind, holdsImport: false, expects: ["rpe"] })), [], kind);
  }
  assert.deepEqual(view.centralCalendarCardMarks(item({ kind: "activity", origin: "api_import" })), [], "an activity is its icon, not a mark");
  assert.deepEqual(view.centralCalendarCardMarks(item({ kind: "test", expects: ["test_result"] })), []);
  // The athlete's reduced event card has none of the fields.
  assert.deepEqual(view.centralCalendarCardMarks({ kind: "event", key: "event:x", date: DAY(0), title: "Match" }), []);
  assert.equal(view.centralCalendarMarksLabel(["rpe", "gps", "test"]), "Holds RPE, GPS data and a test");
  assert.equal(view.centralCalendarMarksLabel(["gps", "test"]), "Holds GPS data and a test");
  assert.equal(view.centralCalendarMarksLabel(["gps"]), "Holds GPS data");
  assert.equal(view.centralCalendarMarksLabel([]), "");
});

test("K5-2. the marks on the card: after the type's icon and before the time, role=img with the words, the icons hidden; the same words in the card's label; the month's mini card at 12 px", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const card = dom().querySelector(`.cc-card[data-key="${EVENT.key}"]`);
  const top = card.querySelector(".cc-card-top");
  const marks = top.querySelector(".cc-card-marks");
  assert.equal(marks.getAttribute("role"), "img");
  assert.equal(marks.getAttribute("aria-label"), "Holds RPE and GPS data");
  assert.deepEqual([...marks.querySelectorAll("svg")].map((svg) => [...svg.classList].find((name) => name.startsWith("cc-mark-"))), ["cc-mark-rpe", "cc-mark-gps"]);
  assert.ok([...marks.querySelectorAll("svg")].every((svg) => svg.getAttribute("aria-hidden") === "true"), "the icons are hidden; the span speaks");
  const order = [...top.children].map((node) => node.classList.contains("cc-card-marks") ? "marks" : node.classList.contains("cc-card-when") ? "when" : node.matches("svg, .cc-type-tint") ? "icon" : "other");
  assert.ok(order.indexOf("icon") < order.indexOf("marks") && order.indexOf("marks") < order.indexOf("when"), `icon, marks, time: ${order}`);
  assert.match(card.getAttribute("aria-label"), /Holds RPE and GPS data/);
  assert.equal(dom().querySelector(`.cc-card[data-key="${PLANNED_GPS.key}"] .cc-card-marks`).getAttribute("aria-label"), "Holds GPS data", "Q11: a planned card that holds an import");
  assert.equal(dom().querySelector(`.cc-card[data-key="${PLANNED.key}"] .cc-card-marks`), null);
  await act({ action: "central-calendar-view", view: "month" });
  const mini = dom().querySelector(`.cc-mini[data-key="${EVENT.key}"] .cc-card-marks`);
  assert.ok(mini, "the month's mini card shows the marks too");
  assert.equal(mini.querySelector("svg").getAttribute("width"), "12");
});

// --- 2.4 H5 chips ---------------------------------------------------------------------------------------------------

test("K5-2. chips: a test, an RPE request and an activity are chips, an event and a planned training stay cards; a folded item is never a chip; the text per kind", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const doc = dom();
  const chips = [...doc.querySelectorAll(".cc-daychip")].map((node) => node.dataset.key);
  assert.deepEqual(chips, [RPE_GPS.key, LONE_GPS.key, MANUAL.key, TEST.key]);
  assert.ok(!chips.includes(FOLDED_RPE.key), "the RPE request folded into the event is not a chip");
  assert.equal(doc.querySelector(`[data-key="${FOLDED_RPE.key}"]`), null);
  assert.deepEqual([...doc.querySelectorAll(".cc-card")].map((node) => node.dataset.key), [EVENT.key, PLANNED_GPS.key, PLANNED.key]);
  const text = (key) => doc.querySelector(`.cc-daychip[data-key="${key}"] .cc-daychip-text`).textContent;
  assert.equal(text(TEST.key), "CMJ test");
  assert.equal(text(RPE_GPS.key), "RPE · Gym");
  assert.equal(text(LONE_GPS.key), "GPS 10:05");
  assert.equal(text(MANUAL.key), "Activity");
  assert.equal(view.centralCalendarDayChipText(item({ kind: "activity", origin: "api_import" })), "GPS", "an import without a time");
  const gps = doc.querySelector(`.cc-daychip[data-key="${LONE_GPS.key}"]`);
  assert.equal(gps.dataset.action, "central-calendar-open-item", "a click opens its panel, never the module");
  assert.ok(gps.classList.contains("is-imported"));
  assert.match(gps.getAttribute("aria-label"), /GPS session, Imported activity, 10:05, Awaiting attendance, 15\/18 present, U19/);
  assert.ok(gps.querySelector(".cc-daychip-status.cc-mini-status-awaiting"), "the status as a dot");
  assert.equal(gps.getAttribute("title"), "GPS 10:05 · Awaiting attendance", "the tooltip: the whole name and what the dot means");
  assert.equal(doc.querySelector(`.cc-daychip[data-key="${RPE_GPS.key}"] .cc-card-marks`).getAttribute("aria-label"), "Holds GPS data", "the GPS mark after the chip's icon");
  // A schedule shown beside its event is its own card, so a chip.
  assert.equal(view.centralCalendarIsDayChip(item({ kind: "external" })), true);
  assert.equal(view.centralCalendarIsDayChip(item({ kind: "event" })), false);
});

test("K5-2. chips come after the day's cards in the list layouts, sit in their hour in the time grid, and the month shows the gps icon", async () => {
  const mixed = [
    item({ key: "activity:a-first", kind: "activity", date: DAY(0), title: "Early", startTime: "07:00", origin: "api_import", links: { activityIds: ["a-first"] } }),
    item({ key: "planned:p-late", kind: "planned", date: DAY(0), title: "Late", startTime: "18:00", links: { activityIds: [] } }),
  ];
  installFetchMock(server(mixed));
  await loadCentralCalendar({ render });
  assert.deepEqual(shownKeys(), ["planned:p-late", "activity:a-first"], "the server's order puts the import first; the chip goes after the card");
  layout = "phone";
  state.centralCalendar.selectedDate = DAY(0);
  render();
  assert.deepEqual(shownKeys(), ["planned:p-late", "activity:a-first"], "the phone's selected day too");
  layout = "wide";
  await act({ action: "central-calendar-mode", mode: "grid" });
  // K7: a chip with a time is a box at its minute (07:00 with the grid opening at 06:00 -> 60 minutes down).
  const chipBox = dom().querySelector('.cc-tg-col .cc-daychip[data-key="activity:a-first"]').closest(".cc-tg-box");
  assert.match(chipBox.getAttribute("style"), /--cc-tg-top:60;/, "at its minute");
  assert.ok(chipBox.classList.contains("is-chip"));
  await act({ action: "central-calendar-view", view: "month" });
  // The month's line draws the `gps` icon's own paths.
  const paths = (html) => [...dom(html).querySelectorAll("path")].map((path) => path.getAttribute("d")).join("|");
  const mini = dom().querySelector('.cc-mini[data-key="activity:a-first"] svg.cc-mini-icon');
  assert.equal(paths(mini.outerHTML), paths(renderIconSvg("gps")));
  assert.notEqual(paths(renderIconSvg("gps")), paths(renderIconSvg("activity")));
});

// --- 2.5 Show only --------------------------------------------------------------------------------------------------

test("K5-2. Show only: each pill's match, one at a time, a second tap switches over, All resets; GPS imports holds the event, planned and RPE cards with holdsImport (Q11)", async () => {
  const calls = installFetchMock(server());
  await loadCentralCalendar({ render });
  const expected = {
    event: [EVENT.key],
    planned: [PLANNED_GPS.key, PLANNED.key],
    gps: [EVENT.key, PLANNED_GPS.key, RPE_GPS.key, LONE_GPS.key],
    other_activity: [MANUAL.key],
    external: [FOLDED_RPE.key, RPE_GPS.key],
    test: [TEST.key],
  };
  for (const [kind, keys] of Object.entries(expected)) {
    await act({ action: "central-calendar-show-only", kind });
    assert.deepEqual(state.centralCalendar.filters.kinds, [kind], `${kind}: one kind, never added to the last`);
    assert.deepEqual(shownKeys().sort(), [...keys].sort(), kind);
    const checked = [...dom().querySelectorAll('.cc-showonly [aria-checked="true"]')].map((node) => node.dataset.kind);
    assert.deepEqual(checked, [kind]);
  }
  await act({ action: "central-calendar-show-only", kind: "test" });
  assert.deepEqual(state.centralCalendar.filters.kinds, ["test"], "a tap on the chosen pill keeps it");
  await act({ action: "central-calendar-show-only", kind: "" });
  assert.deepEqual(state.centralCalendar.filters.kinds, []);
  assert.equal(shownKeys().length, WEEK.length - 1, "All: everything the unfiltered answer holds");
  assert.deepEqual(kindsOf(calls), [null, "planned", "activity", "external", "test"], "Events and GPS imports read unfiltered; the others their server kind");
  assert.equal(centralCalendarServerKinds({ kinds: ["gps"] }), "", "gps never reads kinds=event,activity");
  assert.equal(centralCalendarServerKinds({ kinds: ["other_activity"] }), "activity");
});

test("K5-2. the counts: GPS imports counts imported activities and the cards that hold one; Other activities the rest; a planned or RPE card without holdsImport is not counted (Q11)", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const count = (kind) => dom().querySelector(`.cc-showonly [data-kind="${kind}"] .cc-chip-count`).textContent;
  assert.equal(count("gps"), "4", "the event, the planned card, the RPE card and the lone import");
  assert.equal(count("other_activity"), "1");
  assert.equal(count("planned"), "2");
  assert.equal(count("external"), "1", "the folded request is inside the event in the unfiltered answer");
  const counts = view.centralCalendarChipCounts(new Map([[DAY(0), [item({ kind: "planned" }), item({ kind: "external" })]]]), [DAY(0)]);
  assert.equal(counts.kinds.gps, 0, "without holdsImport they are not GPS imports");
  // The green line: the chosen kind's own count, "this week".
  await act({ action: "central-calendar-show-only", kind: "gps" });
  assert.match(dom().querySelector(".cc-showonly-line").textContent, /Showing only GPS imports · 4 this week\s*Show all/);
  assert.equal(dom().querySelector(".cc-filters-bar .cc-clear-filters"), null, "Show only alone: Show all is its one reset, no Clear filters beside More filters");
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  assert.ok(dom().querySelector(".cc-filters-bar .cc-clear-filters"), "a group chosen: Clear filters is back");
  await act({ action: "central-calendar-toggle-team", teamId: U19 });
  // RPE requests read on their own: the folded request is counted once it is its own card.
  await act({ action: "central-calendar-show-only", kind: "external" });
  assert.equal(count("external"), "2");
  assert.match(dom().querySelector(".cc-showonly-line").textContent, /Showing only RPE requests · 2 this week/);
});

test("K5-2. the radio group has one tab stop and moves with the arrow keys, Home and End, choosing through the same click", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const doc = dom();
  const pills = [...doc.querySelectorAll(".cc-showonly-pill")];
  assert.deepEqual(pills.map((pill) => pill.getAttribute("tabindex")), ["0", "-1", "-1", "-1", "-1", "-1", "-1"], "only the checked pill is a tab stop");
  const clicked = [];
  for (const pill of pills) pill.addEventListener("click", () => clicked.push(pill.dataset.kind));
  const key = (target, name) => {
    let prevented = false;
    const handled = handleCentralCalendarKeydown({ key: name, target, preventDefault: () => { prevented = true; } });
    return handled && prevented;
  };
  assert.ok(key(pills[0], "ArrowRight"));
  assert.ok(key(pills[0], "ArrowLeft"));
  assert.ok(key(pills[2], "Home"));
  assert.ok(key(pills[2], "End"));
  assert.ok(key(pills[3], "ArrowUp"));
  assert.deepEqual(clicked, ["event", "test", "", "test", "planned"]);
  assert.equal(handleCentralCalendarKeydown({ key: "Tab", target: pills[0], preventDefault() {} }), false, "Tab leaves the group");
  assert.equal(handleCentralCalendarKeydown({ key: "ArrowRight", target: doc.body, preventDefault() {} }), false, "only on a pill");
});

test("K5-2. the chosen pill is brought into view inside its row after a paint; the row moves sideways only", () => {
  const pill = { offsetLeft: 600, offsetWidth: 120 };
  const listeners = [];
  const row = { scrollLeft: 0, clientWidth: 360, scrollWidth: 900, dataset: {}, addEventListener: (name, fn) => listeners.push([name, fn]), querySelector: (selector) => (selector === '[aria-checked="true"]' ? pill : null) };
  const root = { querySelector: (selector) => (selector === ".cc-showonly" ? row : null) };
  revealCentralCalendarShowOnly(root);
  assert.equal(row.scrollLeft, 360, "the pill's right edge at the row's right edge");
  assert.equal(row.dataset.more, "true", "more pills past the right edge: the fade is on");
  row.scrollLeft = 540;
  listeners.find(([name]) => name === "scroll")[1]();
  assert.equal(row.dataset.more, undefined, "scrolled to the end: no fade");
  pill.offsetLeft = 40;
  revealCentralCalendarShowOnly(root);
  assert.equal(row.scrollLeft, 40, "a pill left of the view: its left edge");
  pill.offsetLeft = 100;
  revealCentralCalendarShowOnly(root);
  assert.equal(row.scrollLeft, 40, "a pill already in view: nothing moves");
  revealCentralCalendarShowOnly({ querySelector: () => null });
});

test("K5-2. closing a chip's panel gives the focus back to the chip; All's focus is named by its empty kind", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: RPE_GPS.key, date: RPE_GPS.date });
  const asked = [];
  const chip = { focus(options) { this.focusedWith = options; } };
  const before = globalThis.document.querySelector;
  globalThis.document.querySelector = (selector) => { asked.push(selector); return selector.includes(`.cc-daychip[data-key="${RPE_GPS.key}"]`) ? chip : null; };
  try {
    await act({ action: "central-calendar-close-panel" });
  } finally {
    globalThis.document.querySelector = before;
  }
  assert.ok(asked.some((selector) => selector.includes(`.cc-daychip[data-key="${RPE_GPS.key}"]`)), asked.join(" | "));
  assert.deepEqual(chip.focusedWith, { preventScroll: true });
  // A repaint after All was chosen.
  let allSelector = "";
  const { captureCentralCalendarView, restoreCentralCalendarView } = await import("../central-calendar-actions.js");
  globalThis.document.activeElement = { dataset: { action: "central-calendar-show-only", kind: "" } };
  const snapshot = captureCentralCalendarView({ querySelectorAll: () => [], contains: () => true });
  delete globalThis.document.activeElement;
  restoreCentralCalendarView({ querySelectorAll: () => [], querySelector: (selector) => { allSelector = selector; return null; } }, snapshot);
  assert.match(allSelector, /\[data-action="central-calendar-show-only"\].*\[data-kind=""\]/);
});

// --- 1.2 K5-1 Go there ----------------------------------------------------------------------------------------------

test("K5-1. a manager's event lists what it holds under In this event, RPE, Tests then the activity, each with its button; a reader's event only the activity", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  await act({ action: "central-calendar-open-item", key: EVENT.key, date: EVENT.date });
  const section = dom().querySelector(".cc-panel .cc-go-event");
  assert.equal(section.querySelector(".cc-panel-subtitle").textContent, "In this event");
  const rows = [...section.querySelectorAll(".cc-go-row")];
  assert.deepEqual(rows.map((row) => row.querySelector(".cc-go-name").textContent), ["RPE request · RPE 12/18", "Test", "GPS data"]);
  assert.deepEqual(rows.map((row) => row.querySelector("button").dataset.action), ["central-calendar-open-rpe-schedule", "central-calendar-open-tests", "central-calendar-open-training-load"]);
  assert.deepEqual(rows.map((row) => row.querySelector("button").textContent), ["Open in Training Load", "Open in Tests", "Open in Training Load"]);
  assert.equal(rows[0].querySelector("button").dataset.scheduleId, "sch-ev");
  assert.equal(rows[1].querySelector("button").dataset.scheduleId, "tsch-ev");
  assert.equal(rows[2].querySelector("button").dataset.activityId, "act-ev");
  assert.equal(rows[0].querySelector("button").getAttribute("aria-label"), "Open in Training Load: RPE request");
  assert.equal(dom().querySelector('.cc-panel [data-action="builder-edit-plan"]'), null, "Q1: no Builder entry");
  // A reader of the same event: the server sends no schedule ids.
  const reader = view.centralCalendarGoTargets({ ...EVENT, canManage: false, links: { activityIds: ["act-ev"] } });
  assert.deepEqual(reader.map((target) => target.key), ["activity"]);
});

test("K5-1. each other card's way there: a test opens Tests on its day, an RPE request its schedule then its activity, an activity with a Roster button, a planned card no Builder", async () => {
  installFetchMock(server());
  await loadCentralCalendar({ render });
  const opened = [];
  const handlers = {
    openTests: async (target) => opened.push(["tests", target]),
    openTrainingLoadSchedule: async (target) => opened.push(["schedule", target]),
    openTrainingLoad: async (target) => opened.push(["activity", target]),
  };
  const go = () => dom().querySelector(".cc-panel .cc-go");
  const click = async (button) => act({ ...Object.fromEntries(Object.entries(button.dataset)) }, handlers);

  await act({ action: "central-calendar-open-item", key: TEST.key, date: TEST.date }, handlers);
  let buttons = [...go().querySelectorAll("button")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["Open in Tests"]);
  assert.ok(buttons[0].classList.contains("cc-primary"), "full width and primary");
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(`${TEST.date}T12:00:00`));
  assert.equal(go().querySelector(".cc-go-hint").textContent, `Opens Tests on ${weekday}, to see who has answered.`, "Q4");
  await click(buttons[0]);
  assert.deepEqual(opened.at(-1), ["tests", { scheduleId: "tsch-1", date: TEST.date }]);

  await act({ action: "central-calendar-open-item", key: RPE_GPS.key, date: RPE_GPS.date }, handlers);
  buttons = [...go().querySelectorAll("button")];
  assert.deepEqual(buttons.map((button) => button.dataset.action), ["central-calendar-open-rpe-schedule", "central-calendar-open-training-load"], "Q2: the schedule first, then its activity");
  assert.ok(buttons[0].classList.contains("cc-primary") && !buttons[1].classList.contains("cc-primary"));
  await click(buttons[0]);
  assert.deepEqual(opened.at(-1), ["schedule", { scheduleId: "sch-2", date: RPE_GPS.date }]);

  await act({ action: "central-calendar-open-item", key: LONE_GPS.key, date: LONE_GPS.date }, handlers);
  buttons = [...go().querySelectorAll("button")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["Open in Training Load", "Roster · 3 need a state"]);
  await click(buttons[1]);
  assert.deepEqual(opened.at(-1), ["activity", { activityId: "act-gps", date: LONE_GPS.date, tab: "roster" }]);
  await click(buttons[0]);
  assert.deepEqual(opened.at(-1), ["activity", { activityId: "act-gps", date: LONE_GPS.date }], "the plain button asks for no tab");

  await act({ action: "central-calendar-open-item", key: PLANNED.key, date: PLANNED.date }, handlers);
  assert.equal(go(), null, "a planned card without activities has no way there: no Builder (Q1)");
  // A forged tab without an activity, or a bad date, opens nothing.
  const before = opened.length;
  await act({ action: "central-calendar-open-tests", scheduleId: "", date: TEST.date }, handlers);
  await act({ action: "central-calendar-open-rpe-schedule", scheduleId: "sch-2", date: "not-a-date" }, handlers);
  assert.equal(opened.length, before);
  await act({ action: "central-calendar-open-training-load", date: TEST.date, tab: "roster" }, handlers);
  assert.deepEqual(opened.at(-1), ["activity", { activityId: null, date: TEST.date }], "the Roster tab needs an activity");
});

// --- The openers of app.js ------------------------------------------------------------------------------------------

const appJs = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const sourceOf = (start) => {
  const from = appJs.indexOf(start);
  assert.ok(from >= 0, start);
  return appJs.slice(from, appJs.indexOf("\n}\n", from) + 2);
};

// The three openers against recording fakes: every name they call that the scope does not name is recorded; the
// state each step sees is recorded with it.
// `afterHandOff`: the activity Training Load holds once the hand-off returns (another one: the coach chose it meanwhile).
function openerHarness({ leave = true, rosterLeave = true, staysOnTab = true, afterHandOff = null } = {}) {
  const calls = [];
  const appState = {
    activeTab: "central-calendar", navStack: ["x"], selectedProgramId: "p", selectedTemplateId: "t",
    trainingLoad: { section: "today", calendar: { selectedActivityId: null, activityDetailTab: "overview", roster: null }, weekly: { schedule: { weekStart: "", selectedDate: "" } } },
    tests: { section: "schedule", scheduleDetail: {}, form: {}, weekly: { today: { weekStart: "", selectedDate: "" } } },
  };
  const scope = {
    state: appState,
    els: { context: {}, title: {}, toolbar: {} },
    weekMondayIso,
    confirmLeaveTrainingLoad: (tab) => { calls.push(`confirmLeave:${tab}`); return leave; },
    rosterMayBeLeft: () => { calls.push("rosterMayBeLeft"); return rosterLeave; },
    pushAppHistory: () => calls.push(`pushAppHistory@${appState.activeTab}`),
    setTrainingLoadSection: (section) => { calls.push(`section:${section}`); appState.trainingLoad.section = section; },
    handleTrainingLoadAction: async ({ dataset }) => {
      calls.push(`tl:${dataset.action}:${dataset.scheduleId || dataset.activityId || dataset.date}`);
      if (dataset.action === "training-load-results-view-activity-in-calendar") {
        appState.trainingLoad.calendar.selectedActivityId = afterHandOff || dataset.activityId;
        appState.trainingLoad.calendar.roster = { userPickedTab: false };
      }
    },
    handleTestsAction: async ({ dataset }) => calls.push(`tests:${dataset.action}:${dataset.scheduleId}:${dataset.date}@${appState.tests.weekly.today.weekStart}`),
    loadTests: async () => { calls.push(`loadTests@${appState.tests.section}`); if (!staysOnTab) appState.activeTab = "coach-home"; },
    loadTrainingLoadSectionData: async (section) => { calls.push(`load:${section}@${appState.trainingLoad.weekly.schedule.weekStart}`); if (!staysOnTab) appState.activeTab = "coach-home"; },
  };
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key in target ? target[key] : typeof key === "string" ? (...args) => { calls.push(key); return undefined; } : undefined),
  });
  const source = [
    sourceOf("async function openTrainingLoadFromCalendar("),
    sourceOf("async function openTrainingLoadScheduleFromCalendar("),
    sourceOf("async function openTestsDayFromCalendar("),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  const fns = new Function("scope", `with (scope) { ${source}\nreturn { openTrainingLoadFromCalendar, openTrainingLoadScheduleFromCalendar, openTestsDayFromCalendar }; }`)(proxy);
  return { ...fns, calls, appState };
}

test("K5-1. Open in Tests: the calendar's place is recorded first, then Tests › Today on the day's week and that schedule's day group", async () => {
  const h = openerHarness();
  await h.openTestsDayFromCalendar({ scheduleId: "tsch-1", date: "2026-11-19" });
  assert.equal(h.calls[0], "pushAppHistory@central-calendar", "Back's entry is the calendar's, recorded before the tab changes");
  assert.deepEqual(h.calls.filter((call) => /^(loadTests|tests:)/.test(call)), ["loadTests@today", "tests:tests-weekly-open-today-session:tsch-1:2026-11-19@2026-11-16"]);
  assert.equal(h.appState.activeTab, "tests");
  assert.deepEqual(h.appState.tests.weekly.today, { weekStart: "2026-11-16", selectedDate: "2026-11-19" });
  assert.equal(h.appState.tests.scheduleDetail, null);
  // Left Tests while it loaded: the day group is not opened over another screen.
  const gone = openerHarness({ staysOnTab: false });
  await gone.openTestsDayFromCalendar({ scheduleId: "tsch-1", date: "2026-11-19" });
  assert.ok(!gone.calls.some((call) => call.startsWith("tests:")));
});

test("K5-1. Open the RPE request: Training Load's guard first; a guard that says stay pushes nothing; then Schedule on the day's week and the schedule's detail", async () => {
  const stay = openerHarness({ leave: false });
  await stay.openTrainingLoadScheduleFromCalendar({ scheduleId: "sch-2", date: "2026-11-19" });
  assert.deepEqual(stay.calls, ["confirmLeave:training-load"], "nothing pushed, nothing changed");
  assert.equal(stay.appState.activeTab, "central-calendar");
  const h = openerHarness();
  await h.openTrainingLoadScheduleFromCalendar({ scheduleId: "sch-2", date: "2026-11-19" });
  assert.deepEqual(h.calls.slice(0, 2), ["confirmLeave:training-load", "pushAppHistory@central-calendar"]);
  assert.ok(h.calls.indexOf("section:schedule") > 1);
  assert.ok(h.calls.includes("load:schedule@2026-11-16"), "the Schedule week is the day's");
  assert.equal(h.calls.at(-1), "tl:training-load-open-external-schedule:sch-2");
  assert.deepEqual([h.appState.activeTab, h.appState.trainingLoad.weekly.schedule.selectedDate], ["training-load", "2026-11-19"]);
});

test("K5-1. Open in Training Load: the guards come before the push; the Roster option sets the Roster tab as the coach's own pick", async () => {
  const stay = openerHarness({ rosterLeave: false });
  await stay.openTrainingLoadFromCalendar({ activityId: "act-gps", date: "2026-11-19", tab: "roster" });
  assert.deepEqual(stay.calls, ["confirmLeave:training-load", "rosterMayBeLeft"], "a roster that says stay: nothing pushed");
  const h = openerHarness();
  await h.openTrainingLoadFromCalendar({ activityId: "act-gps", date: "2026-11-19", tab: "roster" });
  assert.ok(h.calls.indexOf("pushAppHistory@central-calendar") > h.calls.indexOf("rosterMayBeLeft"));
  assert.equal(h.appState.trainingLoad.calendar.activityDetailTab, "roster");
  assert.equal(h.appState.trainingLoad.calendar.roster.userPickedTab, true);
  const plain = openerHarness();
  await plain.openTrainingLoadFromCalendar({ activityId: "act-gps", date: "2026-11-19" });
  assert.equal(plain.appState.trainingLoad.calendar.activityDetailTab, "overview", "without the option the tab is Training Load's own choice");
});

// The Nezavisni revizor's LOW 2 on #688: the Roster option applies only to the activity it was asked for.
test("K5-1. the Roster option sets no tab when another activity is chosen after the hand-off", async () => {
  const h = openerHarness({ afterHandOff: "act-other" });
  await h.openTrainingLoadFromCalendar({ activityId: "act-gps", date: "2026-11-19", tab: "roster" });
  assert.equal(h.appState.trainingLoad.calendar.selectedActivityId, "act-other");
  assert.equal(h.appState.trainingLoad.calendar.activityDetailTab, "overview", "another activity keeps its own tab");
  assert.equal(h.appState.trainingLoad.calendar.roster.userPickedTab, false, "and is not marked as the coach's pick");
});

// The Nezavisni revizor's LOW 1 on #688: only `holdsImport === true` is an import - a truthy string or number is not.
test("K5-2. holdsImport \"true\" or 1 gives no GPS mark and stays out of GPS imports and its count", () => {
  for (const value of ["true", 1]) {
    for (const kind of ["event", "planned", "external"]) {
      const card = item({ key: `${kind}:x`, kind, holdsImport: value });
      assert.equal(view.centralCalendarItemImported(card), false, `${kind} ${JSON.stringify(value)}`);
      assert.ok(!view.centralCalendarCardMarks(card).includes("gps"), `${kind} ${JSON.stringify(value)}: no GPS mark`);
      assert.equal(view.centralCalendarVisibleItems([card], { teamIds: [], kinds: ["gps"], eventKinds: [] }).length, 0, `${kind} ${JSON.stringify(value)}: not under GPS imports`);
      const counts = view.centralCalendarChipCounts(new Map([[DAY(0), [card]]]), [DAY(0)]);
      assert.equal(counts.kinds.gps, 0, `${kind} ${JSON.stringify(value)}: not counted`);
    }
  }
});
