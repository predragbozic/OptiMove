// Training Load IA Phase B (feature/training-load-shared-week-v1): the
// shared Monday-anchored week (state.trainingLoad.dataAnalysisWeekStart)
// between Data & Analysis's Activities (calendar nav) and Athletes
// (weekly.results nav). Schedule (weekly.schedule) and Dashboards
// (analysis.period) are deliberately untouched by any of this - see
// syncDataAnalysisSharedWeek's own header in training-load-actions.js.
//
// This file only tests the shared-week propagation/normalization logic
// itself; Activities/Athletes' own render/data-fetch contracts (unchanged
// by this phase) stay covered by their own existing suites (training-
// load-calendar.actions.test.mjs, training-load.actions.test.mjs,
// training-load-shell.actions.test.mjs for the Phase A shell).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

function defaultResponder(call) {
  if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: { dateFrom: "2026-09-01", dateTo: "2026-09-07", days: [] } };
  if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: { weekStart: "2026-09-01", weekEnd: "2026-09-07", days: [] } };
  if (call.url.startsWith("/api/training-load/dashboards")) return { status: 200, body: { dashboards: [] } };
  if (call.url.startsWith("/api/training-load/planned-rpe-setting")) return { status: 200, body: { enabled: false, enabledAt: null } };
  return { status: 404, body: { error: "unexpectedUrl:" + call.url } };
}

const { handleTrainingLoadAction, syncDataAnalysisSharedWeek } = await import("../training-load-actions.js");
const { renderTrainingLoadHomeCardHtml, renderRpeFormHtml, renderTrainingLoadAthleteWeeklyHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, emptyRpeForm, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

function fakeAction(dataset, value) {
  return { dataset, value };
}

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

// -------------------- 1/2. Sub-view switches keep the same week --------------------

test("Activities moving the week propagates to Athletes' own weekStart, and switching to Athletes fetches that same week", async () => {
  resetState();
  state.trainingLoad.calendar.weekStart = "2026-09-14";
  state.trainingLoad.calendar.selectedDate = "2026-09-15";
  installFetchMock(defaultResponder);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-21");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-21");
  assert.equal(state.trainingLoad.weekly.results.weekStart, "2026-09-21", "Athletes' own weekStart already matches, even before Athletes is opened");

  fetchCalls.length = 0;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "results" }), { renderTrainingLoad });
  const weeklyCall = fetchCalls.find((c) => c.url.startsWith("/api/training-load/weekly"));
  assert.ok(weeklyCall, "switching to Athletes must fetch");
  assert.match(weeklyCall.url, /weekStart=2026-09-21/, "Athletes must fetch the SAME week Activities just moved to");
});

test("Athletes moving the week propagates to Activities' own weekStart, and switching to Activities fetches that same week", async () => {
  resetState();
  state.trainingLoad.weekly.results.weekStart = "2026-09-14";
  state.trainingLoad.weekly.results.selectedDate = "2026-09-16";
  installFetchMock(defaultResponder);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.weekly.results.weekStart, "2026-09-21");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-21");
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-21", "Activities' own weekStart already matches, even before Activities is opened");

  fetchCalls.length = 0;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "today" }), { renderTrainingLoad });
  const calendarCall = fetchCalls.find((c) => c.url.startsWith("/api/training-load/calendar"));
  assert.ok(calendarCall, "switching to Activities must fetch");
  assert.match(calendarCall.url, /dateFrom=2026-09-21/, "Activities must fetch the SAME week Athletes just moved to");
});

// -------------------- 3. Athletes' own Prev/Next/Today change the shared week --------------------

test("Athletes' Prev/Next/Today week controls change the shared week", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.weekly.results.weekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-prev-week", section: "results" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-07");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-14");

  state.trainingLoad.dataAnalysisWeekStart = "";
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-today", section: "results" }), { renderTrainingLoad });
  assert.ok(state.trainingLoad.dataAnalysisWeekStart, "Today must set the shared week too");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, state.trainingLoad.weekly.results.weekStart);
});

test("the SAME week-nav actions with section='schedule' (or the unreachable legacy 'today' weekly slot) never touch the shared week", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.weekly.schedule.weekStart = "2026-09-14";
  state.trainingLoad.weekly.today.weekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "", "schedule's own week nav must never touch the shared week");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-today", section: "today" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "", "the unreachable legacy weekly.today slot must never touch the shared week either");
});

// -------------------- 4/5. Activities month view --------------------

test("clicking a day cell in a different week (month view) changes the shared week", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.calendar.weekStart = "2026-09-14";
  state.trainingLoad.calendar.monthMode = true;

  // A day in a later month, a genuinely different week (2026-10-07 is a
  // Wednesday whose Monday-anchored week starts 2026-10-05).
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-day", date: "2026-10-07" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-10-05");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-10-05");
  assert.equal(state.trainingLoad.weekly.results.weekStart, "2026-10-05");
});

test("browsing the month with Prev/Next month alone (no day click) never changes the shared week", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.calendar.weekStart = "2026-09-14";
  state.trainingLoad.calendar.monthMode = true;
  state.trainingLoad.calendar.monthCursor = "2026-09-01";
  state.trainingLoad.dataAnalysisWeekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.calendar.monthCursor, "2026-10-01", "month cursor moved");
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-14", "week-mode's own weekStart is untouched by month browsing");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-14", "the shared week must not change just from paging the month");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-prev" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.calendar.monthCursor, "2026-09-01");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-14", "no fallback to the first day of a browsed month, in either direction");
});

// -------------------- 6. selectedDate normalization --------------------

test("normalizing into a new shared week preserves each consumer's OWN prior weekday offset, never adopting the mover's", () => {
  resetState();
  // Athletes was on Friday (offset 4) of week 2026-09-14; Activities was on
  // Tuesday (offset 1) of the SAME week. Athletes moves the week forward.
  state.trainingLoad.weekly.results.weekStart = "2026-09-14";
  state.trainingLoad.weekly.results.selectedDate = "2026-09-18"; // Friday
  state.trainingLoad.calendar.weekStart = "2026-09-14";
  state.trainingLoad.calendar.selectedDate = "2026-09-15"; // Tuesday

  syncDataAnalysisSharedWeek("2026-09-21", "results");

  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-21");
  assert.equal(state.trainingLoad.calendar.selectedDate, "2026-09-22", "Activities keeps ITS OWN Tuesday offset in the new week, not Athletes' Friday");
});

test("normalizing a side that was never visited (no prior selectedDate) lands on the new week's Monday, still a valid member of the shared week", () => {
  resetState();
  state.trainingLoad.calendar.weekStart = "2026-09-14";
  state.trainingLoad.calendar.selectedDate = "2026-09-16";
  // Athletes has literally never been opened - both fields still empty defaults.
  assert.equal(state.trainingLoad.weekly.results.weekStart, "");
  assert.equal(state.trainingLoad.weekly.results.selectedDate, "");

  syncDataAnalysisSharedWeek("2026-09-21", "calendar");

  assert.equal(state.trainingLoad.weekly.results.weekStart, "2026-09-21");
  assert.equal(state.trainingLoad.weekly.results.selectedDate, "2026-09-21", "no prior offset to preserve - defaults to the new week's own Monday");
});

// -------------------- 7. Schedule independence, both directions --------------------

test("a shared-week change from Activities or Athletes never touches Schedule's own independent week", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.weekly.schedule.weekStart = "2026-08-03";
  state.trainingLoad.calendar.weekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.weekly.schedule.weekStart, "2026-08-03", "Schedule's own week must be completely unaffected");
});

// -------------------- 8. Dashboards independence --------------------

test("a shared-week change never touches Dashboards' own local From/To period or its default_filter", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.analysis.period = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
  state.trainingLoad.analysis.dashboard = { id: "d1", default_filter: null };
  state.trainingLoad.calendar.weekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.analysis.period, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  assert.equal(state.trainingLoad.analysis.dashboard.default_filter, null);
});

// -------------------- 9. Phase A sub-view preservation still works --------------------

test("Phase A's Data & Analysis sub-view preservation across Schedule is unaffected by the shared-week addition", async () => {
  resetState();
  installFetchMock(defaultResponder);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "analysis" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "analysis");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: state.trainingLoad.lastDataAnalysisSection }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "analysis", "still restores Dashboards, unaffected by the shared week's own bookkeeping");
});

// -------------------- 10. Notification hand-off --------------------

test("app.js's openTrainingLoadResults still routes through setTrainingLoadSection AND now also syncs the shared week", () => {
  const appJsSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const fnMatch = appJsSource.match(/async function openTrainingLoadResults\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "could not find openTrainingLoadResults in app.js");
  assert.match(fnMatch[0], /setTrainingLoadSection\("results"\)/, "Phase A fix must still be in place");
  assert.doesNotMatch(fnMatch[0], /state\.trainingLoad\.section\s*=/, "must never assign state.trainingLoad.section directly");
  assert.match(fnMatch[0], /syncDataAnalysisSharedWeek\(/, "Phase B: this real entry point into Athletes' week must also sync the shared week");
});

// -------------------- 11. Athlete-facing views unaffected --------------------

test("athlete-facing Home card, RPE form, and This-week overlay are unaffected by the shared-week change", () => {
  resetState();
  const homeHtml = renderTrainingLoadHomeCardHtml({ sessions: [{ sessionId: "s1", rated: false, sessionName: "Gym" }] });
  assert.match(homeHtml, /data-action="training-load-home-card-open"/);
  assert.match(homeHtml, /Rate today's session: Gym/);

  state.trainingLoad.athleteWeekly = { weekStart: "2026-09-01", selectedDate: "2026-09-01", data: null, loading: true, error: "" };
  const weeklyHtml = renderTrainingLoadAthleteWeeklyHtml();
  assert.match(weeklyHtml, /data-action="training-load-athlete-weekly-close"/);

  const rpeHtml = renderRpeFormHtml(emptyRpeForm({ sessionId: "s1", sessionName: "Gym", rpe: 5, durationMinutes: "" }));
  assert.match(rpeHtml, /data-action="training-load-rpe-submit"/);
});

// -------------------- 12. No new/changed API contracts --------------------

test("every fetch triggered by shared-week navigation still hits only the pre-existing endpoints with their existing param names", async () => {
  resetState();
  installFetchMock(defaultResponder);
  state.trainingLoad.calendar.weekStart = "2026-09-14";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "results" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "today" }), { renderTrainingLoad });

  assert.ok(fetchCalls.length > 0);
  for (const call of fetchCalls) {
    assert.ok(
      call.url.startsWith("/api/training-load/calendar?dateFrom=") || call.url.startsWith("/api/training-load/weekly?weekStart="),
      `unexpected endpoint/param shape: ${call.url}`,
    );
  }
});
