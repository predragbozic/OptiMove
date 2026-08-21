// Regression tests for the Weekly view's "default to today / current week on
// first open" fix (weekly-data.js's loadWeekly()).
//
// Root cause: loadWeekly()'s applyData() unconditionally re-derived
// selectedWeekIndex from defaultWeekIndex() (the LAST week in the payload,
// not today's) EVERY time it ran - including every re-entry into the Weekly
// tab (app.js's loadActiveTab() calls loadWeekly() on every tab switch) and
// every background cache refresh, silently discarding whatever week the
// user had manually navigated to. The fix seeds today's week/date only when
// state.viewedWeekStart is still empty (the true "never opened this
// session" signal, mirrored from renderWeeklyRoot's own fallback in
// app.js) - once anything (this seed, "Today", manual navigation) has set
// it, later loadWeekly() calls must leave it alone.
import { test } from "node:test";
import assert from "node:assert/strict";

const { loadWeekly } = await import("../weekly-data.js");
const { handleWeeklyAction } = await import("../weekly-actions.js");
const { state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { localDateIso, weekMondayIso } = await import("../utils.js");
const { todayWeekIndex, weekIndexForDate } = await import("../weekly-plan.js");

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } };
  state.selectedAthleteId = "athlete-1";
  state.navStack = [];
  state.lastWeeklyData = null;
  state.selectedWeekIndex = 0;
  state.selectedWeekDay = "";
  state.viewedWeekStart = "";
  state.weekSelectorOpen = false;
  state.weekCalendarMonth = "";
  state.openWeekCalendarOnLoad = false;
  state.pendingScrollDate = "";
}

function handlers() {
  const rootCalls = [];
  return {
    setLoading: () => {},
    renderEmpty: () => {},
    renderError: () => {},
    renderAthleteHeader: () => {},
    renderWeeklyRoot: (data) => rootCalls.push(data),
    rootCalls,
  };
}

function weeklyPayload(weeks) {
  return { mode: "weekly", weeks, dayGroups: [], microcycles: [], rows: [], adminRows: [], hasWeekly: true, availablePrograms: [] };
}

// Three real weeks around "today" (mocked below) so a wrong index is
// observable - a payload with a single week can't distinguish "picked
// today's week" from "picked whatever's left".
function addDaysIsoLocal(iso, amount) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return localDateIso(d);
}
function weekWithDays(weekStart) {
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) days.push({ date: addDaysIsoLocal(weekStart, offset), slots: {} });
  return { weekStart, days };
}
function threeWeekPayload(todayMonday) {
  return weeklyPayload([
    weekWithDays(weekMondayIso(addWeeksIso(todayMonday, -1))),
    weekWithDays(todayMonday),
    weekWithDays(weekMondayIso(addWeeksIso(todayMonday, 1))),
  ]);
}
function addWeeksIso(iso, weeks) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + weeks * 7);
  return localDateIso(d);
}

function mockFetch(weeks) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => weeklyPayload(weeks) });
}

test("1. a genuine first open defaults to today's date and the week containing it, not the last week in the payload", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-19T09:00:00").getTime() }); // Wed 2026-08-19
  try {
    resetState();
    const todayMonday = weekMondayIso(localDateIso());
    assert.equal(todayMonday, "2026-08-17");
    mockFetch(threeWeekPayload(todayMonday).weeks);
    const h = handlers();
    await loadWeekly(h);

    assert.equal(state.viewedWeekStart, "2026-08-17", "must land on today's Mon-Sun week, not the last week in the payload (2026-08-24)");
    assert.equal(state.selectedWeekDay, "2026-08-19");
    assert.equal(state.lastWeeklyData.weeks[state.selectedWeekIndex].weekStart, "2026-08-17");
  } finally {
    t.mock.timers.reset();
  }
});

test("2. re-entering the Weekly tab after manually picking another week does not reset it back to today", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-19T09:00:00").getTime() });
  try {
    resetState();
    const todayMonday = "2026-08-17";
    const payload = threeWeekPayload(todayMonday);
    mockFetch(payload.weeks);

    await loadWeekly(handlers());
    assert.equal(state.viewedWeekStart, todayMonday);

    // Manual navigation to the next week (mirrors clicking the "next week" arrow).
    state.lastWeeklyData = payload;
    handleWeeklyAction({ dataset: { action: "week-next" } }, {
      moveWeek: (delta) => {
        state.viewedWeekStart = addWeeksIso(state.viewedWeekStart, delta);
        state.navStack = [];
      },
      renderWeeklyRoot: () => {},
    });
    const manuallyPicked = state.viewedWeekStart;
    assert.equal(manuallyPicked, "2026-08-24", "manual navigation must move off today's week");

    // Re-entering the tab (e.g. switching away and back) calls loadWeekly()
    // again - a background refresh or a fresh cache-miss fetch, either way
    // applyData() runs again.
    mockFetch(payload.weeks);
    await loadWeekly(handlers(), { forceRefresh: true });

    assert.equal(state.viewedWeekStart, manuallyPicked, "the manually selected week must survive a loadWeekly() re-run, not silently revert to today's week");
  } finally {
    t.mock.timers.reset();
  }
});

test("3. the Today button restores both the date and the week view after manual navigation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-19T09:00:00").getTime() });
  try {
    resetState();
    const todayMonday = "2026-08-17";
    const payload = threeWeekPayload(todayMonday);
    mockFetch(payload.weeks);
    await loadWeekly(handlers());

    // Navigate away manually.
    state.viewedWeekStart = "2026-08-03";
    state.selectedWeekDay = "2026-08-05";
    state.selectedWeekIndex = 99; // deliberately wrong, to prove week-today recomputes it

    const handled = handleWeeklyAction({ dataset: { action: "week-today" } }, {
      moveWeek: () => {},
      renderWeeklyRoot: () => {},
    });
    assert.equal(handled, true);
    assert.equal(state.viewedWeekStart, todayMonday);
    assert.equal(state.selectedWeekDay, "2026-08-19");
    assert.equal(state.selectedWeekIndex, todayWeekIndex(payload.weeks));
  } finally {
    t.mock.timers.reset();
  }
});

test("4. week-day-select (tapping a specific day) still works normally and is preserved across a loadWeekly() re-run", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-19T09:00:00").getTime() });
  try {
    resetState();
    const todayMonday = "2026-08-17";
    const payload = threeWeekPayload(todayMonday);
    mockFetch(payload.weeks);
    await loadWeekly(handlers());

    state.lastWeeklyData = payload;
    handleWeeklyAction({ dataset: { action: "week-day-select", date: "2026-08-25" } }, {
      moveWeek: () => {},
      renderWeeklyRoot: () => {},
    });
    assert.equal(state.selectedWeekDay, "2026-08-25");
    assert.equal(state.viewedWeekStart, "2026-08-24");
    assert.equal(state.selectedWeekIndex, weekIndexForDate(payload.weeks, "2026-08-25"));

    mockFetch(payload.weeks);
    await loadWeekly(handlers(), { forceRefresh: true });
    assert.equal(state.viewedWeekStart, "2026-08-24", "the manually selected day/week must survive the re-run");
    assert.equal(state.selectedWeekDay, "2026-08-25");
  } finally {
    t.mock.timers.reset();
  }
});
