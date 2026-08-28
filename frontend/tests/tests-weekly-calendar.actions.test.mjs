import { test } from "node:test";
import assert from "node:assert/strict";

// Tests weekly calendar (shared across Today/Schedule/Results) - frontend
// state/action/render coverage. Same minimal-DOM-double pattern already
// established for this module (tests-schedule-management.actions.test.mjs,
// tests-manual-reminder.actions.test.mjs).

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

// Item 2: a controllable-resolution-order fetch mock, for deterministically
// proving the request-race guard - each call's own resolution is held
// until the test explicitly releases it, in whatever order the test
// chooses (never relying on real timing/setTimeout).
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

const { handleTestsAction } = await import("../tests-actions.js");
const { loadTestsWeekly } = await import("../tests-data.js");
const {
  renderCoachTodayWeeklyHtml,
  renderScheduleWeeklyHtml,
  renderCoachResultsSectionHtml,
  reminderSelectedSet,
} = await import("../tests-view.js");
const { emptyTestsState, state } = await import("../state.js");

function fakeAction(dataset) {
  return { dataset };
}

function resetState() {
  state.tests = emptyTestsState();
  queried = {};
}

// A one-week payload shape matching GET /api/tests/weekly's own response.
function weekPayload(weekStart, sessionsByDate = {}) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    days.push({ date, sessions: sessionsByDate[date] || [] });
  }
  const end = new Date(`${weekStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart, weekEnd: end.toISOString().slice(0, 10), days };
}

function session(overrides = {}) {
  return {
    scheduleId: "sched-1",
    testName: "WELLNESS",
    scheduleKind: "one_time",
    scheduleStatus: "active",
    opensTime: "06:00:00",
    closesTime: "22:00:00",
    occurrenceExists: false,
    counts: null,
    resultsCount: 0,
    targetSummary: { athleteTargetCount: 0, teamTargetNames: "", clubTargetNames: "" },
    ...overrides,
  };
}

// ------------------------------------------------------------
// A. Per-tab independent week/date state
// ------------------------------------------------------------

test("A1. each tab (today/schedule/results) keeps its OWN week/date, switching tabs never bleeds one into another", async () => {
  resetState();
  installFetchMock((call) => (call.url.includes("weekStart=2026-08-24") ? { status: 200, body: weekPayload("2026-08-24") } : { status: 200, body: weekPayload("2026-09-07") }));
  await loadTestsWeekly("today", {});
  state.tests.weekly.today.weekStart = "2026-08-24";
  await loadTestsWeekly("today", {});
  await handleTestsAction(fakeAction({ action: "tests-weekly-next-week", section: "schedule" }), { renderTests: () => {} });
  assert.equal(state.tests.weekly.today.weekStart, "2026-08-24", "Today's own week must be untouched by a Schedule-tab navigation");
  assert.notEqual(state.tests.weekly.schedule.weekStart, "2026-08-24", "Schedule's own week moved independently");
});

test("A2. the first-ever visit to a tab seeds today's date/week; a later visit preserves whatever was last selected", async () => {
  resetState();
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  assert.equal(state.tests.weekly.results.weekStart, "");
  await loadTestsWeekly("results", { includeCancelled: true });
  const seededWeekStart = state.tests.weekly.results.weekStart;
  assert.ok(seededWeekStart, "seeded to some real week on first visit");
  state.tests.weekly.results.selectedDate = "2026-08-26";
  await loadTestsWeekly("results", { includeCancelled: true }); // a second "visit"
  assert.equal(state.tests.weekly.results.weekStart, seededWeekStart, "never re-seeded once already set");
  assert.equal(state.tests.weekly.results.selectedDate, "2026-08-26", "the previously-picked date survives a fresh data reload");
});

// ------------------------------------------------------------
// B. Week navigation - no premature materialization from the frontend's own side
// ------------------------------------------------------------

test("B1. prev/next week re-fetch with the shifted weekStart, exactly 7 days apart", async () => {
  resetState();
  state.tests.weekly.schedule.weekStart = "2026-08-24";
  state.tests.weekly.schedule.selectedDate = "2026-08-24";
  state.tests.weekly.schedule.data = weekPayload("2026-08-24");
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-31") }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-next-week", section: "schedule" }), { renderTests: () => {} });
  assert.equal(state.tests.weekly.schedule.weekStart, "2026-08-31");
  assert.ok(fetchCalls[0].url.includes("weekStart=2026-08-31"));
  assert.equal(fetchCalls[0].method, "GET", "browsing a week is always a pure GET, never a POST/PATCH that could create anything");
});

test("B2. selecting a different day within the SAME already-loaded week never issues a new fetch", async () => {
  resetState();
  state.tests.weekly.today.weekStart = "2026-08-24";
  state.tests.weekly.today.selectedDate = "2026-08-24";
  state.tests.weekly.today.data = weekPayload("2026-08-24");
  installFetchMock(() => { throw new Error("must not fetch"); });
  await handleTestsAction(fakeAction({ action: "tests-weekly-select-day", section: "today", date: "2026-08-26" }), { renderTests: () => {} });
  assert.equal(state.tests.weekly.today.selectedDate, "2026-08-26");
});

test("B3. the Today button jumps back to today's real date/week and re-fetches", async () => {
  resetState();
  state.tests.weekly.schedule.weekStart = "2026-09-21";
  state.tests.weekly.schedule.selectedDate = "2026-09-21";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-today", section: "schedule" }), { renderTests: () => {} });
  assert.notEqual(state.tests.weekly.schedule.weekStart, "2026-09-21");
});

// Item 2 correction: deterministic request-race tests. Real timing
// (setTimeout races) would be flaky by construction - these use a fetch
// mock whose responses are resolved in an order the test itself controls,
// so "the older request's response arrives after the newer one" is a fact
// guaranteed by the test, not a hope about scheduling.
test("B4. a rapid double Next-week click - the SECOND request's response resolving before the FIRST's still leaves the newer week applied, and the stale older response is dropped", async () => {
  resetState();
  state.tests.weekly.schedule.weekStart = "2026-08-24";
  state.tests.weekly.schedule.selectedDate = "2026-08-24";
  state.tests.weekly.schedule.data = weekPayload("2026-08-24");
  const deferreds = installDeferredFetchMock();

  const firstClick = handleTestsAction(fakeAction({ action: "tests-weekly-next-week", section: "schedule" }), { renderTests: () => {} });
  const secondClick = handleTestsAction(fakeAction({ action: "tests-weekly-next-week", section: "schedule" }), { renderTests: () => {} });

  assert.equal(deferreds.length, 2, "both clicks issued their own fetch");
  assert.equal(state.tests.weekly.schedule.weekStart, "2026-09-07", "state already reflects two +7 shifts synchronously, before either response lands");

  // Resolve the NEWER (second) request first, then the older/stale one -
  // the literal "obrnutim redom" (reverse order) scenario the user asked for.
  deferreds[1].resolve({ status: 200, body: weekPayload("2026-09-07") });
  await secondClick;
  assert.equal(state.tests.weekly.schedule.data.weekStart, "2026-09-07");
  assert.equal(state.tests.weekly.schedule.loading, false);

  deferreds[0].resolve({ status: 200, body: weekPayload("2026-08-31") });
  await firstClick;
  assert.equal(state.tests.weekly.schedule.data.weekStart, "2026-09-07", "the stale first response must never overwrite the already-applied newer week");
  assert.equal(state.tests.weekly.schedule.loading, false, "the stale response must never leave loading incorrectly toggled");
  assert.equal(state.tests.weekly.schedule.error, "", "the stale response must never surface an error either");
});

test("B5. rapid Show-cancelled toggle on/off - a late-arriving stale response (including a stale ERROR) must never surface once a newer response already landed", async () => {
  resetState();
  state.tests.weekly.results.weekStart = "2026-08-24";
  state.tests.weekly.results.selectedDate = "2026-08-24";
  const deferreds = installDeferredFetchMock();

  const toggleOn = loadTestsWeekly("results", { includeCancelled: true });
  const toggleOff = loadTestsWeekly("results", { includeCancelled: false });

  assert.equal(deferreds.length, 2);
  assert.ok(deferreds[0].call.url.includes("includeCancelled=true"));
  assert.ok(!deferreds[1].call.url.includes("includeCancelled=true"));

  // The NEWER (toggle-off) request resolves first with real data; the OLDER
  // (toggle-on) request resolves afterward as a stale ERROR - must never
  // surface, and must never re-flip loading back on.
  deferreds[1].resolve({ status: 200, body: weekPayload("2026-08-24") });
  await toggleOff;
  assert.equal(state.tests.weekly.results.data.weekStart, "2026-08-24");
  assert.equal(state.tests.weekly.results.loading, false);
  assert.equal(state.tests.weekly.results.error, "");

  deferreds[0].resolve({ status: 500, body: { error: "boom" } });
  await toggleOn;
  assert.equal(state.tests.weekly.results.error, "", "a stale error response must never surface once a newer response already succeeded");
  assert.equal(state.tests.weekly.results.loading, false, "a stale response must never leave loading stuck/re-toggled");
  assert.ok(state.tests.weekly.results.data, "the newer successful data must remain in place");
});

// ------------------------------------------------------------
// C. Rendering: 7 real, keyboard/screen-reader-accessible day buttons
// ------------------------------------------------------------

test("C1. the strip always renders exactly 7 real <button> day cells with role=tab and a real aria-label - never a bare <div>", () => {
  resetState();
  state.tests.weekly.today.data = weekPayload("2026-08-24");
  state.tests.weekly.today.selectedDate = "2026-08-24";
  const html = renderCoachTodayWeeklyHtml();
  const dayButtons = [...html.matchAll(/<button type="button" class="tests-weekly-day[^"]*" role="tab"/g)];
  assert.equal(dayButtons.length, 7);
  assert.ok(html.includes('role="tab"') && html.includes('aria-selected='));
});

test("C2. no data yet (still loading) never throws and shows a stable loading/empty state, not a crash", () => {
  resetState();
  assert.doesNotThrow(() => renderCoachTodayWeeklyHtml());
  assert.doesNotThrow(() => renderScheduleWeeklyHtml());
  assert.doesNotThrow(() => renderCoachResultsSectionHtml());
});

// ------------------------------------------------------------
// D. Today tab: multiple different tests same day, same test twice same
// day, active-only filtering, click-through detail + manual reminder reuse
// ------------------------------------------------------------

test("D1. two different tests the same day both render as separate agenda rows, sorted by time", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [
      session({ scheduleId: "s2", testName: "CMJ", opensTime: "08:30:00" }),
      session({ scheduleId: "s1", testName: "WELLNESS", opensTime: "06:00:00" }),
    ],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  const wellnessIndex = html.indexOf("WELLNESS");
  const cmjIndex = html.indexOf("CMJ");
  assert.ok(wellnessIndex >= 0 && cmjIndex >= 0 && wellnessIndex < cmjIndex, "06:00 WELLNESS must render before 08:30 CMJ");
});

test("D2. the SAME test scheduled twice the same day stays two separate agenda rows, never merged into one", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ scheduleId: "s1", opensTime: "06:00:00" }), session({ scheduleId: "s1b", opensTime: "16:30:00" })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.equal((html.match(/data-action="tests-weekly-open-today-session"/g) || []).length, 2, "two distinct session rows, never merged into one");
});

test("D3. a paused or cancelled schedule's session never shows on the Today agenda, matching the old GET /today scope", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ scheduleId: "s1", scheduleStatus: "active" }), session({ scheduleId: "s2", scheduleStatus: "paused" }), session({ scheduleId: "s3", scheduleStatus: "cancelled" })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.equal((html.match(/data-action="tests-weekly-open-today-session"/g) || []).length, 1);
});

test("D4a. no assignment materialized at all shows 'Scheduled', never 'Upcoming' or a fabricated per-athlete breakdown", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, { [date]: [session({ occurrenceExists: false, counts: null })] });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes(">Scheduled<"));
  assert.ok(!html.includes(">Upcoming<"));
});

// Item 3 correction: THIS is the exact bug being fixed - assignments that
// DO exist but haven't opened yet used to render as a fractional
// "0/N completed" instead of the honest "Upcoming".
test("D4b. assignments exist but none of them have opened yet shows 'Upcoming', never a fabricated 0/N completed fraction", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ occurrenceExists: true, counts: { total: 3, completed: 0, notYetOpen: 3, openPending: 0, missed: 0, skipped: 0 } })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes(">Upcoming<"));
  assert.ok(!html.includes("0/3"));
});

test("D5. a fully-completed session shows Completed; a mixed (still-actionable) session shows a completed/total fraction; a fully-closed-and-incomplete session shows Missed - status is always text, never color alone", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [
      session({ scheduleId: "s1", occurrenceExists: true, counts: { total: 3, completed: 3, notYetOpen: 0, openPending: 0, missed: 0, skipped: 0 } }),
      session({ scheduleId: "s2", occurrenceExists: true, counts: { total: 4, completed: 1, notYetOpen: 0, openPending: 3, missed: 0, skipped: 0 } }),
      session({ scheduleId: "s3", occurrenceExists: true, counts: { total: 2, completed: 0, notYetOpen: 0, openPending: 0, missed: 2, skipped: 0 } }),
    ],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes(">Completed<"));
  assert.ok(html.includes("1/4 completed"));
  assert.ok(html.includes(">Missed<"));
});

// Correction: `skipped` (excused/cancelled) assignments are never
// something an athlete could have completed - they must never count
// against the completion denominator, and must never be reported as
// "Missed" (missed === 0 there).
test("D5b. every assignment skipped (excused/cancelled) shows Skipped - never Missed (missed === 0), never a misleading Completed", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ occurrenceExists: true, counts: { total: 2, completed: 0, notYetOpen: 0, openPending: 0, missed: 0, skipped: 2 } })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes(">Skipped<"));
  assert.ok(!html.includes(">Missed<"));
  assert.ok(!html.includes(">Completed<"));
});

test("D5c. completed + skipped, no missed, shows Completed - skipped athletes are excluded from the completion denominator", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ occurrenceExists: true, counts: { total: 3, completed: 2, notYetOpen: 0, openPending: 0, missed: 0, skipped: 1 } })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes(">Completed<"));
  assert.ok(!html.includes(">Missed<"));
});

test("D5d. completed + missed (no skipped) still shows the missed fraction against the real total, unchanged", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ occurrenceExists: true, counts: { total: 3, completed: 1, notYetOpen: 0, openPending: 0, missed: 2, skipped: 0 } })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes("1/3"));
  assert.ok(html.includes(">Missed<") || html.includes("· missed"));
});

test("D5e. skipped + currently open (still actionable) shows the completed/denominator fraction against only the real assignments, excluding the skipped one", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [session({ occurrenceExists: true, counts: { total: 3, completed: 0, notYetOpen: 0, openPending: 2, missed: 0, skipped: 1 } })],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes("0/2 completed"), "the denominator must exclude the skipped assignment (2 real, actionable ones - not 3)");
  assert.ok(!html.includes(">Missed<"));
  assert.ok(!html.includes(">Skipped<"));
});

test("D6. clicking a session opens the group detail via GET /schedules/:id/group?date=, reusing the existing per-athlete/manual-reminder rendering; a Back button returns to the calendar", async () => {
  resetState();
  const date = "2026-08-24";
  installFetchMock((call) => (call.url === `/api/tests/schedules/s1/group?date=${date}`
    ? { status: 200, body: { group: { schedule: { id: "s1", testName: "WELLNESS", opensTime: "06:00", closesTime: "22:00" }, anyOpen: true, allClosed: false, counts: { total: 1, completed: 0, missed: 0, pending: 1, injuries: 0 }, athletes: [{ assignmentId: "asg-1", athleteId: "ath-1", athleteName: "Ana Anić", status: "pending", wellnessScore: null, injury: false, opensAt: "", closesAt: "" }] } } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-open-today-session", scheduleId: "s1", date }), { renderTests: () => {} });
  assert.equal(state.tests.weeklyGroupDetail.scheduleId, "s1");
  assert.equal(state.tests.weeklyGroupDetail.date, date);
  const detailHtml = renderCoachTodayWeeklyHtml();
  assert.ok(detailHtml.includes("Ana Anić"), "the existing per-athlete table is reused, showing the real athlete row");
  assert.ok(detailHtml.includes('data-action="tests-weekly-close-detail"'));

  await handleTestsAction(fakeAction({ action: "tests-weekly-close-detail" }), { renderTests: () => {} });
  assert.equal(state.tests.weeklyGroupDetail, null);
});

test("D7. the manual-reminder action suite (toggle/select-all/send) works against the weekly click-through detail exactly as it does against the old bulk coachToday list", async () => {
  resetState();
  state.tests.weeklyGroupDetail = {
    scheduleId: "sched-1",
    date: "2026-08-24",
    group: {
      schedule: { id: "sched-1", testName: "WELLNESS", opensTime: "00:00", closesTime: "23:59" },
      anyOpen: true,
      allClosed: false,
      counts: { total: 2, completed: 0, missed: 0, pending: 2, injuries: 0 },
      athletes: [
        { assignmentId: "asg-1", athleteId: "ath-1", athleteName: "Ana Anić", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString() },
        { assignmentId: "asg-2", athleteId: "ath-2", athleteName: "Bojan Bojić", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString() },
      ],
    },
  };
  await handleTestsAction(fakeAction({ action: "tests-reminder-toggle-athlete", scheduleId: "sched-1", assignmentId: "asg-1" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.reminderSelection["sched-1"].ids, ["asg-2"]);
});

// Item 3 correction: a future or already-closed weekly session must never
// default to an active "select all" reminder send - the backend already
// skips a non-open assignment as a no-op, so pre-arming Send for it would
// just be offering to send a useless reminder.
test("D8. the default reminder selection excludes an incomplete athlete whose own window is NOT currently open (future not-yet-open, or already-closed) - never a blind select-all", () => {
  resetState();
  const notYetOpen = { assignmentId: "asg-future", athleteId: "a1", athleteName: "Future Athlete", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() + 3600000).toISOString(), closesAt: new Date(Date.now() + 7200000).toISOString() };
  const alreadyClosed = { assignmentId: "asg-closed", athleteId: "a2", athleteName: "Closed Athlete", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() - 7200000).toISOString(), closesAt: new Date(Date.now() - 3600000).toISOString() };
  const currentlyOpen = { assignmentId: "asg-open", athleteId: "a3", athleteName: "Open Athlete", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString() };
  const group = { schedule: { id: "sched-future" }, athletes: [notYetOpen, alreadyClosed, currentlyOpen] };
  const selected = reminderSelectedSet(group);
  assert.deepEqual([...selected], ["asg-open"], "only the currently-open athlete is pre-selected by default");
});

test("D9. a session where NOTHING is currently open defaults the reminder selection to fully empty - Send is never pre-armed for a useless send", () => {
  resetState();
  const notYetOpen = { assignmentId: "asg-future", athleteId: "a1", athleteName: "Future Athlete", status: "pending", wellnessScore: null, injury: false, opensAt: new Date(Date.now() + 3600000).toISOString(), closesAt: new Date(Date.now() + 7200000).toISOString() };
  const group = { schedule: { id: "sched-future2" }, athletes: [notYetOpen] };
  const selected = reminderSelectedSet(group);
  assert.equal(selected.size, 0);
});

// ------------------------------------------------------------
// D-target. Item 1 correction: same-time same-day sessions are
// distinguished by a compact recipient subtitle, per tab
// ------------------------------------------------------------

test("two same-time same-day Today sessions for different teams render distinguishable subtitles", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.today.data = weekPayload(date, {
    [date]: [
      session({ scheduleId: "s1", opensTime: "06:00:00", targetSummary: { athleteTargetCount: 0, teamTargetNames: "First team", clubTargetNames: "" }, occurrenceExists: true, counts: { total: 18, completed: 0, notYetOpen: 0, openPending: 18, missed: 0, skipped: 0 } }),
      session({ scheduleId: "s2", opensTime: "06:00:00", targetSummary: { athleteTargetCount: 0, teamTargetNames: "Recovery group", clubTargetNames: "" } }),
    ],
  });
  state.tests.weekly.today.selectedDate = date;
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(html.includes("First team · 18 athletes"), "the real materialized total, not a static target count, is what 'N athletes' means here");
  assert.ok(html.includes("Recovery group"));
});

test("the Schedule tab's subtitle combines the recurrence kind with the recipient", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.schedule.data = weekPayload(date, {
    [date]: [session({ scheduleKind: "recurring", targetSummary: { athleteTargetCount: 0, teamTargetNames: "First team", clubTargetNames: "" } })],
  });
  state.tests.weekly.schedule.selectedDate = date;
  const html = renderScheduleWeeklyHtml();
  assert.ok(html.includes("Daily · First team"));
});

test("the Results tab's subtitle combines the recipient with the results count", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.results.data = weekPayload(date, {
    [date]: [session({ resultsCount: 14, targetSummary: { athleteTargetCount: 0, teamTargetNames: "First team", clubTargetNames: "" } })],
  });
  state.tests.weekly.results.selectedDate = date;
  const html = renderCoachResultsSectionHtml();
  assert.ok(html.includes("First team · 14 results"));
});

test("an individually-targeted session (no team/club) falls back to an athlete-count recipient label", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.schedule.data = weekPayload(date, {
    [date]: [session({ targetSummary: { athleteTargetCount: 3, teamTargetNames: "", clubTargetNames: "" } })],
  });
  state.tests.weekly.schedule.selectedDate = date;
  const html = renderScheduleWeeklyHtml();
  assert.ok(html.includes("3 athletes"));
});

// ------------------------------------------------------------
// D-message. Item 3 correction: the zero-athletes detail message is date-aware
// ------------------------------------------------------------

test("clicking a NOT-yet-materialized FUTURE date's session shows a date-specific message, never the hardcoded 'No check-in window today.'", async () => {
  resetState();
  const futureDate = "2026-09-15";
  installFetchMock((call) => (call.url === `/api/tests/schedules/s1/group?date=${futureDate}`
    ? { status: 200, body: { group: { schedule: { id: "s1", testName: "WELLNESS", opensTime: "06:00", closesTime: "22:00" }, anyOpen: false, allClosed: false, counts: { total: 0, completed: 0, missed: 0, pending: 0, injuries: 0 }, athletes: [] } } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-open-today-session", scheduleId: "s1", date: futureDate }), { renderTests: () => {} });
  const html = renderCoachTodayWeeklyHtml();
  assert.ok(!html.includes("No check-in window today."), "must never claim this is 'today' for an arbitrary future date");
  assert.ok(html.includes("have not been created"));
});

// ------------------------------------------------------------
// E. Schedule tab: click opens the EXISTING schedule detail; Show cancelled re-fetches both directions
// ------------------------------------------------------------

test("E1. clicking a schedule session opens the EXISTING schedule-detail view (tests-open-schedule, unchanged), with Edit/Pause/Schedule again/Delete all still there", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/tests/schedules/sched-9"
    ? { status: 200, body: { schedule: { id: "sched-9", testName: "WELLNESS", scheduleKind: "one_time", status: "active", opensTime: "06:00", closesTime: "22:00", timezone: "UTC" }, targets: [], link: null, notificationRules: [] } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-open-schedule", scheduleId: "sched-9" }), { renderTests: () => {} });
  assert.equal(state.tests.scheduleDetail.schedule.id, "sched-9");
});

test("E2. checking or unchecking 'Show cancelled' always re-fetches the weekly projection with the matching includeCancelled - both directions, not just turning it on", async () => {
  resetState();
  state.tests.section = "schedule";
  state.tests.weekly.schedule.weekStart = "2026-08-24";
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await handleTestsAction({ dataset: { action: "tests-toggle-show-cancelled" }, checked: true }, { renderTests: () => {} });
  assert.ok(fetchCalls.some((c) => c.url.includes("includeCancelled=true")));
  fetchCalls.length = 0;
  await handleTestsAction({ dataset: { action: "tests-toggle-show-cancelled" }, checked: false }, { renderTests: () => {} });
  assert.ok(fetchCalls.length > 0, "unchecking must also re-fetch, not just rely on a stale over-fetched list");
  assert.ok(!fetchCalls[0].url.includes("includeCancelled=true"));
});

test("E3. a paused schedule still renders on the Schedule-tab calendar with its own real status pill", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.schedule.data = weekPayload(date, { [date]: [session({ scheduleStatus: "paused" })] });
  state.tests.weekly.schedule.selectedDate = date;
  const html = renderScheduleWeeklyHtml();
  assert.ok(html.includes('tests-status-paused">paused<'));
});

// ------------------------------------------------------------
// F. Results tab: grouped by session, single vs multi-result click-through, filters to resultsCount>0 only
// ------------------------------------------------------------

test("F1. the Results calendar only shows sessions that actually have a result - an upcoming/resultless session is never listed there", () => {
  resetState();
  const date = "2026-08-24";
  state.tests.weekly.results.data = weekPayload(date, {
    [date]: [session({ scheduleId: "has-results", resultsCount: 2 }), session({ scheduleId: "no-results", resultsCount: 0 })],
  });
  state.tests.weekly.results.selectedDate = date;
  const html = renderCoachResultsSectionHtml();
  assert.equal((html.match(/data-action="tests-weekly-open-results"/g) || []).length, 1);
  assert.ok(html.includes("2 results"));
});

test("F2. a single-result session opens the existing single-result view directly - no intermediate list screen", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/tests/results?scheduleId=s1&date=2026-08-24"
    ? { status: 200, body: { results: [{ assessmentId: "asm-1", athleteName: "Ana", wellnessScore: 4, injury: false, completedAt: "2026-08-24T10:00:00Z", localScheduledDate: "2026-08-24", scheduleId: "s1" }] } }
    : call.url === "/api/tests/results/asm-1"
      ? { status: 200, body: { athleteName: "Ana", wellnessScore: 4, values: {}, scheduleId: "s1" } }
      : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-open-results", scheduleId: "s1", date: "2026-08-24" }), { renderTests: () => {} });
  assert.equal(state.tests.form?.athleteName, "Ana", "the single result opened directly into the existing result-detail view");
  assert.equal(state.tests.resultsListFilter, null, "never shows the intermediate filtered-list screen for exactly one result");
});

test("F3. a multi-result session opens the EXISTING flat results list, pre-filtered to that schedule+date; a Back button returns to the calendar", async () => {
  resetState();
  installFetchMock((call) => (call.url === "/api/tests/results?scheduleId=s1&date=2026-08-24"
    ? { status: 200, body: { results: [
      { assessmentId: "asm-1", athleteName: "Ana", wellnessScore: 4, injury: false, completedAt: "2026-08-24T10:00:00Z", localScheduledDate: "2026-08-24", scheduleId: "s1" },
      { assessmentId: "asm-2", athleteName: "Bojan", wellnessScore: 6, injury: false, completedAt: "2026-08-24T11:00:00Z", localScheduledDate: "2026-08-24", scheduleId: "s1" },
    ] } }
    : { status: 404, body: {} }));
  await handleTestsAction(fakeAction({ action: "tests-weekly-open-results", scheduleId: "s1", date: "2026-08-24" }), { renderTests: () => {} });
  assert.deepEqual(state.tests.resultsListFilter, { scheduleId: "s1", date: "2026-08-24" });
  assert.equal(state.tests.results.length, 2);
  const html = renderCoachResultsSectionHtml();
  assert.ok(html.includes("Ana") && html.includes("Bojan"));
  assert.ok(html.includes('data-action="tests-weekly-close-results-list"'));

  await handleTestsAction(fakeAction({ action: "tests-weekly-close-results-list" }), { renderTests: () => {} });
  assert.equal(state.tests.resultsListFilter, null);
});

test("F4. historical results of a since-cancelled schedule are still fetched with includeCancelled - the Results tab never silently drops them", async () => {
  resetState();
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await loadTestsWeekly("results", { includeCancelled: true });
  assert.ok(fetchCalls[0].url.includes("includeCancelled=true"));
});

// ------------------------------------------------------------
// G. Switching tabs never leaks a detail/filter view from one tab into another
// ------------------------------------------------------------

test("G1. switching tabs clears any open weeklyGroupDetail/resultsListFilter, so a coach never lands on a stale detail screen for the wrong tab", async () => {
  resetState();
  state.tests.weeklyGroupDetail = { scheduleId: "s1", date: "2026-08-24", group: {} };
  state.tests.resultsListFilter = { scheduleId: "s1", date: "2026-08-24" };
  installFetchMock(() => ({ status: 200, body: weekPayload("2026-08-24") }));
  await handleTestsAction(fakeAction({ action: "tests-section", section: "schedule" }), { renderTests: () => {} });
  assert.equal(state.tests.weeklyGroupDetail, null);
  assert.equal(state.tests.resultsListFilter, null);
});
