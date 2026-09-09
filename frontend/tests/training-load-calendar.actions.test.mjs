// Training Load Frontend 3A — Calendar → Activity → Results. Same minimal-
// DOM-double pattern as training-load.actions.test.mjs (this feature's own
// sibling suite for the OLD Today/Schedule/Results tabs) — a real
// module-level view-cache shared across every test in this file, cleared
// via resetState() between tests exactly the same way.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, json: async () => result.body };
  };
}

// Matches by URL substring; anything unmatched gets a harmless empty-rows
// 200 — most tests only care about the calendar/activity endpoint they're
// actually exercising, not the background metric-catalog fetches
// select-activity also fires.
function rulesResponder(rules) {
  return async (call) => {
    const rule = rules.find((r) => call.url.includes(r[0]));
    if (rule) return { status: rule[2] || 200, body: rule[1] };
    return { status: 200, body: { rows: [] } };
  };
}

// Deferred-resolution mock, same shape as training-load.actions.test.mjs's
// own installDeferredFetchMock — for deterministic fast-switching race
// tests (rapid week/month/activity navigation).
function installDeferredFetchMock() {
  const deferreds = [];
  fetchCalls = [];
  globalThis.fetch = (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    deferreds.push({ call, resolve: (result) => resolve({ ok: result.status < 300, status: result.status, json: async () => result.body }) });
    return promise;
  };
  return deferreds;
}

const { handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const {
  loadTrainingLoadCalendarWeek,
  loadTrainingLoadCalendarMonth,
  loadActivityDetail,
  captureTrainingLoadCalendarMutationContext,
  invalidateTrainingLoadCalendarContext,
} = await import("../training-load-calendar-data.js");
const { renderTrainingLoadCalendarHtml } = await import("../training-load-calendar-view.js");
const { addDaysIso, weekMondayIso, monthStartIso } = await import("../utils.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
}

let renderCount;
function renderTrainingLoad() {
  renderCount += 1;
}

function fakeAction(dataset, value) {
  return { dataset, value };
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

function activityItem(overrides = {}) {
  return {
    kind: "activity",
    activityId: "act-1",
    name: "Morning Strength",
    activityTypeKey: "training_session",
    occurredLocalDate: "2026-09-09",
    startedAt: "2026-09-09T09:00:00.000Z",
    timezoneSnapshot: "Europe/Belgrade",
    origin: "planned_session",
    lifecycleState: "confirmed",
    participantCount: 1,
    rpe: { requested: 1, rated: 1 },
    metrics: { total: 1, withData: 1 },
    conflictCount: 0,
    openSuggestionCount: 0,
    ...overrides,
  };
}
function plannedItem(overrides = {}) {
  return {
    kind: "planned", sessionId: "sess-1", logicalSessionId: "log-1", planId: "plan-1",
    sessionName: "Recovery Run", sessionTime: "09:00:00", rpeEnabled: true,
    athleteId: "ath-3", athleteName: "Petra Z", ...overrides,
  };
}
function externalItem(overrides = {}) {
  return {
    kind: "external", externalAssignmentId: "ext-1", scheduleId: "sch-1", eventName: "Camp",
    scheduleStatus: "active", assignmentStatus: "pending", opensAt: "2026-09-09T07:00:00.000Z",
    closesAt: null, athleteId: "ath-4", athleteName: "Marko M", ...overrides,
  };
}
function calendarPayload(weekStart, itemsByDate = {}) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(weekStart, i);
    days.push({ date, items: itemsByDate[date] || [] });
  }
  return { dateFrom: weekStart, dateTo: addDaysIso(weekStart, 6), days };
}
function monthGridPayload(gridStart, gridEnd, itemsByDate = {}) {
  const days = [];
  let d = gridStart;
  while (d <= gridEnd) {
    days.push({ date: d, items: itemsByDate[d] || [] });
    d = addDaysIso(d, 1);
  }
  return { dateFrom: gridStart, dateTo: gridEnd, days };
}
function rpeFact(athleteId, overrides = {}) {
  return { canonicalActivityId: "act-1", canonicalParticipantId: `p-${athleteId}`, athleteId, factKind: "rpe", detail: { sessionFeedbackId: "fb-1", rpe: 7, durationMinutes: 60, srpe: 420, source: "planned", ...overrides } };
}
function metricValueFact(athleteId, overrides = {}) {
  return {
    canonicalActivityId: "act-1", canonicalParticipantId: `p-${athleteId}`, athleteId, factKind: "metric_value",
    detail: {
      occasionId: "occ-1", sourceIdentityId: null, entryMethod: "manual", metricDefinitionId: "def-distance",
      metricDefinitionVersionId: "defv-1", valueNumeric: 5000, valueBoolean: null, valueText: null,
      unitAtCapture: "m", aggregationRole: "standalone", coverage: "full", isDerived: false, computedByRef: null,
      segmentId: null, ...overrides,
    },
  };
}
function componentLinkFact(componentId, segmentId) {
  return { canonicalActivityId: "act-1", canonicalParticipantId: null, athleteId: null, factKind: "component_metric_segment_link", detail: { componentId, metricEventSegmentId: segmentId, linkStatus: "confirmed" } };
}
function activityDetailPayload(overrides = {}) {
  return { canonicalActivityId: "act-1", facts: [], athleteNamesById: {}, components: [], ...overrides };
}
function withActivitySelected(cal, { weekStart = "2026-09-07", selectedDate = "2026-09-09", item = activityItem(), detail = activityDetailPayload() } = {}) {
  cal.weekStart = weekStart;
  cal.selectedDate = selectedDate;
  cal.data = calendarPayload(weekStart, { [selectedDate]: [item] });
  cal.selectedActivityId = item.activityId;
  cal.activityDetail = { activityId: item.activityId, data: detail, loading: false, error: "" };
}

// ------------------------------------------------------------
// 1. Week/month expand-collapse — selection is never touched by presentation
// ------------------------------------------------------------

test("toggle-month expands to month view, fetches the month grid, and preserves the current selection", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.selectedActivityId = "act-1";
  installFetchMock(rulesResponder([["/api/training-load/calendar", monthGridPayload("2026-08-31", "2026-10-11")]]));
  renderCount = 0;
  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-toggle-month" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(cal.monthMode, true);
  assert.equal(cal.monthCursor, "2026-09-01");
  assert.equal(cal.selectedDate, "2026-09-09", "expanding must never change the selected date");
  assert.equal(cal.selectedActivityId, "act-1", "expanding must never clear the selected activity");
  assert.ok(cal.monthData, "month grid data was fetched");
});

test("collapsing back to week view keeps the same selection and does not re-fetch week data", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.selectedActivityId = "act-1";
  cal.monthMode = true;
  cal.monthCursor = "2026-09-01";
  installFetchMock(rulesResponder([]));
  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-toggle-month" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(cal.monthMode, false);
  assert.equal(cal.selectedDate, "2026-09-09");
  assert.equal(cal.selectedActivityId, "act-1");
  assert.equal(fetchCalls.length, 0, "collapsing to week view must not trigger any network request");
});

// ------------------------------------------------------------
// 2. Prev/next/Today, and no UTC drift
// ------------------------------------------------------------

test("next/prev in week mode shift weekStart and selectedDate by exactly 7 days, including across a DST boundary", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  // 2026-10-25 is the last Sunday of October — Central European DST ends
  // that night. Crossing it must still land on exactly the right date.
  cal.weekStart = "2026-10-19";
  cal.selectedDate = "2026-10-25";
  installFetchMock(rulesResponder([["/api/training-load/calendar", calendarPayload("2026-10-26")]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.equal(cal.weekStart, "2026-10-26");
  assert.equal(cal.selectedDate, "2026-11-01");

  installFetchMock(rulesResponder([["/api/training-load/calendar", calendarPayload("2026-10-19")]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-prev" }), { renderTrainingLoad });
  assert.equal(cal.weekStart, "2026-10-19");
  assert.equal(cal.selectedDate, "2026-10-25");
});

test("next/prev in month mode shift monthCursor by exactly one calendar month and never touch weekStart/selectedDate", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.monthMode = true;
  cal.monthCursor = "2026-09-01";
  installFetchMock(rulesResponder([["/api/training-load/calendar", monthGridPayload("2026-09-28", "2026-11-08")]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.equal(cal.monthCursor, "2026-10-01");
  assert.equal(cal.weekStart, "2026-09-07");
  assert.equal(cal.selectedDate, "2026-09-09");
});

test("today resets to the current week/date and clears any activity selection", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2020-01-06";
  cal.selectedDate = "2020-01-08";
  cal.selectedActivityId = "act-1";
  cal.selectedComponentId = "comp-1";
  installFetchMock(rulesResponder([["/api/training-load/calendar", calendarPayload(weekMondayIso(new Date().toISOString().slice(0, 10)))]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-today" }), { renderTrainingLoad });
  assert.equal(cal.selectedActivityId, null);
  assert.equal(cal.selectedComponentId, null);
  assert.equal(cal.weekStart, weekMondayIso(cal.selectedDate));
});

// ------------------------------------------------------------
// 3. Date selection: same-week vs. cross-week, no UTC drift, and clearing
//    a stale activity/component selection from a different day.
// ------------------------------------------------------------

test("selecting a day within the already-loaded week does not re-fetch", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07");
  installFetchMock(rulesResponder([]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-day", date: "2026-09-11" }), { renderTrainingLoad });
  assert.equal(cal.selectedDate, "2026-09-11");
  assert.equal(cal.weekStart, "2026-09-07");
  assert.equal(fetchCalls.length, 0);
});

test("selecting a day in a different week updates weekStart and refetches, exactly (no off-by-one)", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07");
  cal.selectedActivityId = "act-old";
  cal.selectedComponentId = "comp-old";
  installFetchMock(rulesResponder([["/api/training-load/calendar", calendarPayload("2026-09-14")]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-day", date: "2026-09-16" }), { renderTrainingLoad });
  assert.equal(cal.selectedDate, "2026-09-16");
  assert.equal(cal.weekStart, "2026-09-14", "Monday of the week containing 2026-09-16");
  assert.equal(cal.selectedActivityId, null, "a day on a different week must clear the stale activity selection");
  assert.equal(cal.selectedComponentId, null);
  assert.equal(fetchCalls.length, 1);
});

// ------------------------------------------------------------
// 4. Activity selection and returning to whole day
// ------------------------------------------------------------

test("selecting an activity narrows the context, loads its detail, and resets per-activity view state", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", { "2026-09-09": [activityItem()] });
  cal.selectedComponentId = "stale-comp";
  cal.activityDetailTab = "sources";
  cal.metricPicker.selectedIds = ["stale"];
  cal.resultsSort = { column: "rpe", direction: "desc" };
  installFetchMock(rulesResponder([["/api/training-activity/act-1", activityDetailPayload({ facts: [rpeFact("ath-1")] })]]));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-activity", activityId: "act-1" }), { renderTrainingLoad });
  assert.equal(cal.selectedActivityId, "act-1");
  assert.equal(cal.selectedComponentId, null);
  assert.equal(cal.activityDetailTab, "overview");
  assert.equal(cal.metricPicker.selectedIds, null);
  assert.deepEqual(cal.resultsSort, { column: "athlete", direction: "asc" });
  assert.equal(cal.activityDetail.data.canonicalActivityId, "act-1");
  assert.ok(fetchCalls.some((c) => c.url.includes("/api/training-activity/act-1")));
});

test("'All activities that day' clears the activity selection and returns to the day agenda", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal);
  cal.selectedComponentId = "comp-1";
  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-clear-activity" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(cal.selectedActivityId, null);
  assert.equal(cal.selectedComponentId, null);
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(!html.includes("All activities that day"), "the clear-activity command itself only shows when an activity IS selected");
  assert.ok(html.includes("tl-agenda-list") || html.includes("training-load-empty"), "back to the whole-day agenda");
});

// ------------------------------------------------------------
// 5. Reserved-attribute regression: the detail tab switch must use its own
//    data attribute, never the app-wide reserved "data-tab".
// ------------------------------------------------------------

test("select-detail-tab reads its OWN dataset key (tlCalendarDetailTab), not the reserved app-wide 'tab' key", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-detail-tab", tlCalendarDetailTab: "components" }), { renderTrainingLoad });
  assert.equal(cal.activityDetailTab, "components");
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(!html.includes('data-tab='), "must never emit a bare data-tab attribute anywhere in the calendar markup — see project_reserved_data_tab_attribute");
  assert.ok(html.includes("data-tl-calendar-detail-tab"));
});

// ------------------------------------------------------------
// 6. Whole-session / component filtering
// ------------------------------------------------------------

test("selecting a component filters results to that component, hides session-level RPE, and 'Whole session' returns everything", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, {
    detail: activityDetailPayload({
      components: [{ id: "comp-main", name: "Main Set", componentTypeKey: "block", sortOrder: 1, plannedDurationSeconds: null, actualDurationSeconds: null }],
      facts: [
        rpeFact("ath-1"),
        metricValueFact("ath-1", { segmentId: "seg-1" }),
        componentLinkFact("comp-main", "seg-1"),
      ],
    }),
  });
  let html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes(">RPE<"), "whole-session view shows session-level RPE");
  assert.ok(html.includes("Session results"));

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-component", componentId: "comp-main" }), { renderTrainingLoad });
  html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Component results"));
  assert.ok(!html.includes(">RPE<"), "component view must never falsely attribute session-level RPE to one component");
  assert.ok(html.includes("5000"), "the component-linked metric value still shows");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-component", componentId: "" }), { renderTrainingLoad });
  assert.equal(cal.selectedComponentId, null);
  html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Session results"));
  assert.ok(html.includes(">RPE<"), "back to whole session restores RPE");
});

// ------------------------------------------------------------
// 7. RPE + metric values in the same table
// ------------------------------------------------------------

test("RPE/sRPE/duration and a metric value render together in one results row", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, { detail: activityDetailPayload({ facts: [rpeFact("ath-1"), metricValueFact("ath-1")], athleteNamesById: { "ath-1": "Ana Zzzqa" } }) });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Ana Zzzqa"));
  assert.ok(html.includes(">7<"), "RPE value");
  assert.ok(html.includes("60 min"), "duration");
  assert.ok(html.includes("5000"), "metric value");
});

// ------------------------------------------------------------
// 8. Conflict from two sources — never silently picked
// ------------------------------------------------------------

test("two effective values for the same athlete/metric render a conflict indicator, never an auto-picked single value", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, {
    detail: activityDetailPayload({
      facts: [
        metricValueFact("ath-1", { occasionId: "occ-a", valueNumeric: 4800 }),
        metricValueFact("ath-1", { occasionId: "occ-b", valueNumeric: 5100 }),
      ],
    }),
  });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("2 values"));
  assert.ok(html.includes('data-action="training-load-calendar-view-conflict"'));
  assert.ok(!html.includes(">4800<") && !html.includes(">5100<"), "the results cell itself must show the conflict button, never one of the two raw numbers picked silently");

  const handled = handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-view-conflict", values: JSON.stringify([{ valueNumeric: 4800, unitAtCapture: "m", entryMethod: "manual" }, { valueNumeric: 5100, unitAtCapture: "m", entryMethod: "manual" }]) }), { renderTrainingLoad });
  return handled.then(() => {
    const panel = renderTrainingLoadCalendarHtml();
    assert.ok(panel.includes("4800") && panel.includes("5100"), "the conflict panel shows BOTH values");
    assert.ok(panel.includes("Nothing is chosen automatically"));
  });
});

test("closing the conflict panel clears it", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal);
  cal.conflictValues = [{ valueNumeric: 1, entryMethod: "manual" }];
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-conflict-close" }), { renderTrainingLoad });
  assert.equal(cal.conflictValues, null);
});

// ------------------------------------------------------------
// 9. Metric picker — search, domain grouping, icon fallback
// ------------------------------------------------------------

test("metric picker groups by domain, shows an icon or a fallback, and search filters by label", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal);
  cal.metricPicker.open = true;
  cal.metricPicker.definitions = [
    { id: "def-distance", label: "Total Distance", shortLabel: "Distance", unit: "m", iconUrl: "https://example.test/distance.png", domainLabel: "Speed" },
    { id: "def-hr", label: "Heart Rate Avg", shortLabel: "HR Avg", unit: "bpm", iconUrl: null, domainLabel: null },
  ];
  let html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Speed"), "definitions with a domain label are grouped under it");
  assert.ok(html.includes("Other"), "a definition with no domain/category label falls back to 'Other'");
  assert.ok(html.includes('<img src="https://example.test/distance.png"'), "a definition with an icon renders it");
  assert.ok(html.includes("tl-metric-icon-fallback"), "a definition with no icon renders the fallback glyph");

  cal.metricPicker.search = "heart";
  html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Heart Rate Avg"));
  assert.ok(!html.includes("Total Distance"), "search narrows to matching definitions only");
});

test("toggling a metric in the picker materializes the smart default and then adds/removes explicitly", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, { detail: activityDetailPayload({ facts: [metricValueFact("ath-1", { metricDefinitionId: "def-a" })] }) });
  cal.metricPicker.open = true;
  cal.metricPicker.definitions = [{ id: "def-a", label: "A", shortLabel: "A", unit: "", iconUrl: null, domainLabel: null }, { id: "def-b", label: "B", shortLabel: "B", unit: "", iconUrl: null, domainLabel: null }];
  assert.equal(cal.metricPicker.selectedIds, null);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-metric-toggle", metricId: "def-b" }), { renderTrainingLoad });
  assert.ok(cal.metricPicker.selectedIds.includes("def-a"), "materializing the smart default preserves what was already implicitly shown");
  assert.ok(cal.metricPicker.selectedIds.includes("def-b"));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-metric-toggle", metricId: "def-a" }), { renderTrainingLoad });
  assert.ok(!cal.metricPicker.selectedIds.includes("def-a"));
});

// ------------------------------------------------------------
// 10. A large number of metrics — never rendered all at once by default
// ------------------------------------------------------------

test("more than 4 distinct metrics on one activity start with NO metric columns shown by default", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  const facts = [rpeFact("ath-1")];
  for (let i = 0; i < 5; i += 1) facts.push(metricValueFact("ath-1", { occasionId: `occ-${i}`, metricDefinitionId: `def-${i}`, valueNumeric: 100 + i }));
  withActivitySelected(cal, { detail: activityDetailPayload({ facts }) });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes(">RPE<"), "RPE/sRPE/duration always show");
  for (let i = 0; i < 5; i += 1) assert.ok(!html.includes(`>10${i}<`), `metric def-${i}'s value must not render until explicitly picked`);
});

test("4 or fewer distinct metrics on one activity show all of them by default", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  const facts = [rpeFact("ath-1"), metricValueFact("ath-1", { metricDefinitionId: "def-only", valueNumeric: 4242, unitAtCapture: "m" })];
  withActivitySelected(cal, { detail: activityDetailPayload({ facts }) });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("4242"));
});

// ------------------------------------------------------------
// 11. Multiple activities the same day
// ------------------------------------------------------------

test("multiple activities/planned/external items on the same day each render their own card with only known facts", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", {
    "2026-09-09": [
      activityItem({ activityId: "act-1", name: "Morning Strength" }),
      activityItem({ activityId: "act-2", name: "Gym Session", rpe: null, metrics: { total: 1, withData: 1 }, conflictCount: 0 }),
      plannedItem({ sessionName: "Recovery Run" }),
    ],
  });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Morning Strength"));
  assert.ok(html.includes("Gym Session"));
  assert.ok(html.includes("Recovery Run"));
  assert.ok(html.includes("No data yet"), "the untracked/no-submission planned item shows 'No data yet', never a fabricated status");
  assert.equal((html.match(/tl-agenda-card/g) || []).length >= 3, true);
});

// ------------------------------------------------------------
// 12. Day/session/component — never double-summed
// ------------------------------------------------------------

test("the day view with no activity selected lists each activity separately and never sums metrics across them", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.selectedActivityId = null;
  cal.data = calendarPayload("2026-09-07", {
    "2026-09-09": [activityItem({ activityId: "act-1" }), activityItem({ activityId: "act-2", name: "Gym Session" })],
  });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(!/total/i.test(html), "no ad-hoc daily total anywhere in this phase");
  assert.ok(html.includes("Morning Strength") && html.includes("Gym Session"));
});

// ------------------------------------------------------------
// 13. Provisional / needs-review state
// ------------------------------------------------------------

test("a provisional activity with open suggestions is marked 'Needs review' and shows its suggestion count", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", {
    "2026-09-09": [activityItem({ lifecycleState: "provisional", openSuggestionCount: 2, rpe: null, metrics: null })],
  });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Needs review"));
  assert.ok(html.includes("2 to review") || html.includes("2 candidate"));
});

// ------------------------------------------------------------
// 14. Canonical alias activity — one item, one canonical id, never a
//     frontend-invented identity.
// ------------------------------------------------------------

test("a canonical (possibly merged/alias) activity renders exactly once, keyed by its real activityId", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", { "2026-09-09": [activityItem({ activityId: "act-canonical", participantCount: 2 })] });
  const html = renderTrainingLoadCalendarHtml();
  const occurrences = (html.match(/data-activity-id="act-canonical"/g) || []).length;
  assert.equal(occurrences, 1, "one canonical activity must render exactly one agenda card, however many sources/participants merged into it");
});

// ------------------------------------------------------------
// 15. Accessibility of the 7 summarized days
// ------------------------------------------------------------

test("the summarized week strip is a real tablist with aria-selected reflecting the current selection", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", { "2026-09-09": [activityItem(), activityItem({ activityId: "act-2" })] });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes('role="tablist"'));
  assert.ok(html.includes('role="tab"'));
  assert.ok(html.includes('data-date="2026-09-09"') && html.includes('aria-selected="true"'));
  assert.ok(html.includes("2 activities") || html.includes(", 2 activit"), "a day's own item count is exposed in its accessible label");
});

// ------------------------------------------------------------
// 16. Month grid — at most 2 labels then "+N"
// ------------------------------------------------------------

test("a month-grid day with more than 2 items shows only the first 2 labels plus a '+N' overflow badge", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.monthMode = true;
  cal.monthCursor = "2026-09-01";
  cal.data = calendarPayload("2026-09-07");
  cal.monthData = monthGridPayload("2026-08-31", "2026-10-11", {
    "2026-09-09": [
      activityItem({ activityId: "act-1", name: "First" }),
      activityItem({ activityId: "act-2", name: "Second" }),
      activityItem({ activityId: "act-3", name: "Third" }),
      activityItem({ activityId: "act-4", name: "Fourth" }),
    ],
  });
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("First"));
  assert.ok(html.includes("Second"));
  assert.ok(!html.includes("Third"), "only the first 2 labels render as text badges");
  assert.ok(html.includes("+2"), "the remaining 2 items collapse into a '+N' badge");
});

// ------------------------------------------------------------
// 17. Fast-switching / stale-response races
// ------------------------------------------------------------

test("a stale week response that resolves AFTER a newer week request never overwrites the newer context", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  const deferreds = installDeferredFetchMock();

  const first = loadTrainingLoadCalendarWeek(renderTrainingLoad); // fetches week of 2026-09-07
  await Promise.resolve();
  cal.weekStart = "2026-09-14";
  cal.selectedDate = "2026-09-16";
  const second = loadTrainingLoadCalendarWeek(renderTrainingLoad); // fetches week of 2026-09-14
  await Promise.resolve();

  assert.equal(deferreds.length, 2);
  // Resolve the OLDER (first) request LAST — after the newer one already landed.
  deferreds[1].resolve({ status: 200, body: calendarPayload("2026-09-14") });
  await second;
  deferreds[0].resolve({ status: 200, body: calendarPayload("2026-09-07") });
  await first;

  assert.equal(cal.data.dateFrom, "2026-09-14", "the stale, later-arriving response for the OLD week must never win over the newer context");
});

test("a stale month response never overwrites a newer month context", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.monthCursor = "2026-09-01";
  const deferreds = installDeferredFetchMock();

  const first = loadTrainingLoadCalendarMonth(renderTrainingLoad);
  await Promise.resolve();
  cal.monthCursor = "2026-10-01";
  const second = loadTrainingLoadCalendarMonth(renderTrainingLoad);
  await Promise.resolve();

  assert.equal(deferreds.length, 2);
  deferreds[1].resolve({ status: 200, body: monthGridPayload("2026-09-28", "2026-11-08") });
  await second;
  deferreds[0].resolve({ status: 200, body: monthGridPayload("2026-08-31", "2026-10-11") });
  await first;

  assert.equal(cal.monthData.dateFrom, "2026-09-28", "the stale month response must never win over the newer one");
});

test("a stale activity-detail response never overwrites a newer, DIFFERENT activity's detail", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  const deferreds = installDeferredFetchMock();

  const first = loadActivityDetail("act-1", renderTrainingLoad);
  await Promise.resolve();
  const second = loadActivityDetail("act-2", renderTrainingLoad);
  await Promise.resolve();

  assert.equal(deferreds.length, 2);
  deferreds[1].resolve({ status: 200, body: activityDetailPayload({ canonicalActivityId: "act-2" }) });
  await second;
  deferreds[0].resolve({ status: 200, body: activityDetailPayload({ canonicalActivityId: "act-1" }) });
  await first;

  assert.equal(cal.activityDetail.activityId, "act-2");
  assert.equal(cal.activityDetail.data.canonicalActivityId, "act-2", "a stale response for the PREVIOUS activity must never land on top of the one now open");
});

// ------------------------------------------------------------
// 18. Invalidation after a relevant mutation
// ------------------------------------------------------------

test("invalidating the captured mutation context forces the next week load to refetch instead of serving stale cache", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  installFetchMock(rulesResponder([["/api/training-load/calendar", calendarPayload("2026-09-07")]]));
  await loadTrainingLoadCalendarWeek(renderTrainingLoad);
  assert.equal(fetchCalls.length, 1);

  await loadTrainingLoadCalendarWeek(renderTrainingLoad);
  assert.equal(fetchCalls.length, 1, "second load within the freshness window is served from cache");

  const mutationContext = captureTrainingLoadCalendarMutationContext();
  assert.ok(mutationContext);
  invalidateTrainingLoadCalendarContext(mutationContext);

  await loadTrainingLoadCalendarWeek(renderTrainingLoad);
  assert.equal(fetchCalls.length, 2, "after invalidation, the same week must be refetched rather than served stale");
});

// ------------------------------------------------------------
// 19. Workspace switch resets the whole calendar slice
// ------------------------------------------------------------

test("resetTrainingLoadForWorkspaceChange clears every calendar field, including selection and activity detail", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.data = calendarPayload("2026-09-07");
  cal.monthMode = true;
  cal.monthData = monthGridPayload("2026-08-31", "2026-10-11");
  cal.selectedActivityId = "act-1";
  cal.selectedComponentId = "comp-1";
  cal.selectedResultsAthleteId = "ath-1";
  cal.activityDetail = { activityId: "act-1", data: activityDetailPayload(), loading: false, error: "" };
  cal.metricPicker = { open: true, search: "x", selectedIds: ["a"], definitions: [{ id: "a" }], loading: false, error: "" };

  resetTrainingLoadForWorkspaceChange();

  assert.equal(cal.data, null);
  assert.equal(cal.monthMode, false);
  assert.equal(cal.monthData, null);
  assert.equal(cal.selectedActivityId, null);
  assert.equal(cal.selectedComponentId, null);
  assert.equal(cal.selectedResultsAthleteId, null);
  assert.equal(cal.activityDetail.activityId, null);
  assert.equal(cal.metricPicker.open, false);
  assert.equal(cal.metricPicker.selectedIds, null);
});

// ------------------------------------------------------------
// 20. Athlete drawer keeps date/activity/component context
// ------------------------------------------------------------

test("opening the athlete drawer never loses the current date/activity/component context", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, { detail: activityDetailPayload({ facts: [rpeFact("ath-1")], athleteNamesById: { "ath-1": "Ana Zzzqa" } }) });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  assert.equal(cal.selectedResultsAthleteId, "ath-1");
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Ana Zzzqa"));
  assert.equal(cal.selectedActivityId, "act-1", "the drawer is an overlay, not a navigation away from the activity");
  assert.equal(cal.selectedDate, "2026-09-09");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-close-athlete" }), { renderTrainingLoad });
  assert.equal(cal.selectedResultsAthleteId, null);
  assert.equal(cal.selectedActivityId, "act-1", "closing the drawer keeps the activity context");
});

// ------------------------------------------------------------
// 21. Sort toggling
// ------------------------------------------------------------

test("clicking a sortable column toggles asc/desc, and a different column resets to asc", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-sort", column: "rpe" }), { renderTrainingLoad });
  assert.deepEqual(cal.resultsSort, { column: "rpe", direction: "asc" });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-sort", column: "rpe" }), { renderTrainingLoad });
  assert.deepEqual(cal.resultsSort, { column: "rpe", direction: "desc" });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-sort", column: "athlete" }), { renderTrainingLoad });
  assert.deepEqual(cal.resultsSort, { column: "athlete", direction: "asc" });
});

// ------------------------------------------------------------
// 22. Components tab: full activity component hierarchy shows regardless
//     of performance/link facts (the backend's additive `components` field)
// ------------------------------------------------------------

test("the Components tab lists every component from the activity's own hierarchy, even one with no performance or metric link at all", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  withActivitySelected(cal, {
    detail: activityDetailPayload({
      components: [
        { id: "comp-warmup", name: "Warm-up", componentTypeKey: "block", sortOrder: 1, plannedDurationSeconds: null, actualDurationSeconds: null },
        { id: "comp-main", name: "Main Set", componentTypeKey: "block", sortOrder: 2, plannedDurationSeconds: null, actualDurationSeconds: 600 },
      ],
      facts: [componentLinkFact("comp-main", "seg-1")],
    }),
  });
  cal.activityDetailTab = "components";
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.includes("Warm-up"), "a component with neither performance nor a metric link still shows, from the activity's own hierarchy");
  assert.ok(html.includes("Main Set"));
  assert.ok(html.includes("10 min"), "a component's own duration renders when present");
});
