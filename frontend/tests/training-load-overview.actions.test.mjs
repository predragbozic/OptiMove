// Training Load IA Phase E (feature/training-load-overview-v1): Overview,
// the first real Data & Analysis sub-view - two explicitly separate data
// blocks (training load/RPE feedback from GET /weekly + the existing
// computeWeeklyAggregates(), and activity/data coverage from GET
// /calendar), the shared week extended to a third side, and Overview's own
// in-flight staleness guard for its new coverage nav slot. Pre-existing
// Activities/Athletes/Schedule contracts are untouched and stay covered by
// their own existing suites (training-load.actions.test.mjs,
// training-load-athletes.actions.test.mjs, training-load-calendar.actions.
// test.mjs) - not re-tested here.
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
const { renderTrainingLoadOverviewHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
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
    sessionId: "sess-1", sessionName: "Session", athleteId: "ath-1", athleteName: "Ana",
    sessionTime: "08:00:00", rated: false, feedback: null, historical: false, rpeEnabled: true,
    trainingLoadEnabled: true, workspacePlannedRpeEnabled: true, actionable: true, source: "planned",
    ...overrides,
  };
}

function calendarPayload(dateFrom, dateTo, itemsByDate = {}) {
  const days = [];
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const last = new Date(`${dateTo}T00:00:00Z`);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({ date, items: itemsByDate[date] || [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { dateFrom, dateTo, days };
}

function activityItem(overrides = {}) {
  return {
    kind: "activity", activityId: "act-1", name: "Morning Strength", activityTypeKey: "training_session",
    occurredLocalDate: "2026-09-09", startedAt: null, origin: "manual", lifecycleState: "confirmed",
    participantCount: 1, rpe: null, metrics: null, conflictCount: 0, openSuggestionCount: 0,
    ...overrides,
  };
}

// -------------------- Two blocks, never merged --------------------

test("opening Overview fetches BOTH /weekly and /calendar exactly once each, and renders two distinctly labeled blocks, never one merged KPI", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) {
      return { status: 200, body: weekPayload("2026-09-07", { "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })] }) };
    }
    if (call.url.startsWith("/api/training-load/calendar")) {
      return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", { "2026-09-09": [activityItem({ rpe: { requested: 2, rated: 1 }, metrics: { total: 4, withData: 2 } })] }) };
    }
    return { status: 404, body: {} };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });

  const weeklyCalls = fetchCalls.filter((c) => c.url.startsWith("/api/training-load/weekly"));
  const calendarCalls = fetchCalls.filter((c) => c.url.startsWith("/api/training-load/calendar"));
  assert.equal(weeklyCalls.length, 1, "exactly one /weekly call, never N+1");
  assert.equal(calendarCalls.length, 1, "exactly one /calendar call, never N+1");

  const html = renderTrainingLoadOverviewHtml();
  assert.match(html, /Training load &amp; RPE feedback/);
  assert.match(html, /Activity &amp; data coverage/);
  assert.match(html, /300 AU/, "block 1 shows the real weekly sRPE value");
  assert.match(html, /1<\/span><span class="training-load-summary-label">Activities recorded/, "block 2 shows the real activity count");
  assert.match(html, /1\/2/, "block 2 shows RPE coverage as rated\\/requested");

  // The two blocks must render as two separate <section> elements, never
  // one shared grid - a coverage count must never sit inside the same
  // tile grid as a training-load value.
  const sectionCount = (html.match(/<section class="training-load-overview-block">/g) || []).length;
  assert.equal(sectionCount, 2, "exactly two independent block sections");
});

test("block 2's coverage numbers never leak into block 1's own summary grid", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) {
      return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", { "2026-09-09": [activityItem({ conflictCount: 3, openSuggestionCount: 2 })] }) };
    }
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });
  const html = renderTrainingLoadOverviewHtml();
  assert.match(html, /3 conflicts to resolve/);
  assert.match(html, /2 candidate matches to review/);
  // Block 1 (no sessions this week, real 0/-/0 state) must never mention
  // conflicts/suggestions - those numbers belong ONLY to block 2.
  const block1Html = html.slice(html.indexOf("Training load &amp; RPE feedback"), html.indexOf("Activity &amp; data coverage"));
  assert.doesNotMatch(block1Html, /conflict/i, "block 1 must never show block 2's conflict count");
  assert.doesNotMatch(block1Html, /candidate match/i, "block 1 must never show block 2's open-suggestion count");
});

// -------------------- Shared week: Overview is a third side --------------------

test("Overview's own Prev/Next moves the shared week, and Activities/Athletes' own week-nav moves Overview's week right back", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-14", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: calendarPayload("2026-09-14", "2026-09-20", {}) };
    return { status: 404, body: {} };
  });
  state.trainingLoad.weekly.overview.weekStart = "2026-09-07";
  state.trainingLoad.calendar.weekStart = "2026-09-07";
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "overview" }), { renderTrainingLoad });

  assert.equal(state.trainingLoad.weekly.overview.weekStart, "2026-09-14");
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-14", "Activities' own week moves too - Overview is a real side of the shared week");
  assert.equal(state.trainingLoad.weekly.results.weekStart, "2026-09-14", "Athletes' own week moves too");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-14");

  // Now move Athletes' own week-nav and confirm Overview follows.
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.weekly.overview.weekStart, "2026-09-21", "Overview follows a move initiated from Athletes too");
});

test("Schedule's own week-nav never touches Overview's week - Schedule stays fully independent of the shared week", async () => {
  resetState();
  installFetchMock(async () => ({ status: 200, body: weekPayload("2026-09-21", {}) }));
  state.trainingLoad.weekly.overview.weekStart = "2026-09-07";
  state.trainingLoad.weekly.schedule.weekStart = "2026-09-07";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "schedule" }), { renderTrainingLoad });

  assert.equal(state.trainingLoad.weekly.schedule.weekStart, "2026-09-14");
  assert.equal(state.trainingLoad.weekly.overview.weekStart, "2026-09-07", "Overview's week must never move because Schedule moved");
});

// -------------------- In-flight staleness guard (coverage nav) --------------------

test("in-flight fetch window: navigating weeks on Overview never renders the OLD week's coverage before the NEW week's /calendar response resolves", async () => {
  resetState();
  state.trainingLoad.weekly.overview.weekStart = "2026-09-07";
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar") && call.url.includes("dateFrom=2026-09-07")) {
      return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", { "2026-09-09": [activityItem({ name: "Week1 Activity" })] }) };
    }
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });
  assert.match(renderTrainingLoadOverviewHtml(), /1<\/span><span class="training-load-summary-label">Activities recorded/, "sanity: week 1's one activity is counted before navigating");

  const deferreds = installDeferredFetchMock();
  const navPromise = handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "overview" }), { renderTrainingLoad });

  const midFlightHtml = renderTrainingLoadOverviewHtml();
  assert.match(midFlightHtml, /Activity &amp; data coverage.*Loading/s, "coverage block shows its own loading state during the in-flight window");
  assert.doesNotMatch(midFlightHtml, /Week1 Activity/, "the old week's activity must never leak into the new week's coverage count while in flight");

  for (const d of deferreds) {
    if (d.call.url.startsWith("/api/training-load/weekly")) d.resolve({ status: 200, body: weekPayload("2026-09-14", {}) });
    else if (d.call.url.startsWith("/api/training-load/calendar")) d.resolve({ status: 200, body: calendarPayload("2026-09-14", "2026-09-20", {}) });
  }
  await navPromise;

  const finalHtml = renderTrainingLoadOverviewHtml();
  assert.match(finalHtml, /0<\/span><span class="training-load-summary-label">Activities recorded/, "week 2 genuinely has zero activities");
});

// -------------------- Filter confirm reloads Overview's coverage too --------------------

test("confirming a GENUINE Club/Team/Athletes filter change drops and reloads Overview's coverage block when Overview has been visited", async () => {
  resetState();
  let calendarCallCount = 0;
  installFetchMock(async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: { clubs: [], teams: [], athletes: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) { calendarCallCount += 1; return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", {}) }; }
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });
  assert.equal(calendarCallCount, 1);

  // Same pattern as the existing suite's own H1/H2 filter-confirm tests -
  // the filter must genuinely CHANGE (open + toggle) before Confirm, or
  // the unchanged (workspace, week, filter) context key is a legitimate
  // cache hit and correctly issues no new network call at all.
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "ath-9" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  assert.equal(calendarCallCount, 2, "a genuine filter change must re-fetch Overview's coverage, never leave it showing data fetched under the old filter");
});

// code-reviewer finding (Phase E): overviewCoverage.weekStart is
// deliberately NOT kept in sync by syncDataAnalysisSharedWeek (to avoid
// reopening the Phase D staleness-bug class), but the filter-confirm
// handler was using THAT possibly-stale field as the reload TARGET, not
// just as a "has Overview ever been visited" gate - so a week move that
// happened via a DIFFERENT tab while Overview wasn't open left a
// subsequent filter-confirm re-fetching the WRONG (old) week's coverage.
test("filter-confirm reloads Overview's coverage for the CURRENT shared week, even if the week moved via a different tab while Overview was closed", async () => {
  resetState();
  let lastCalendarUrl = "";
  installFetchMock(async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: { clubs: [], teams: [], athletes: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) { lastCalendarUrl = call.url; return { status: 200, body: calendarPayload("2026-09-07", "2026-09-20", {}) }; }
    return { status: 404, body: {} };
  });
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  state.trainingLoad.weekly.overview.weekStart = "2026-09-07";

  // Visit Overview at week 2026-09-07 - overviewCoverage.weekStart is now "2026-09-07".
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.overviewCoverage.weekStart, "2026-09-07");

  // The shared week now moves via Athletes ("results"), NOT via Overview -
  // weekly.overview.weekStart follows (it's a real side of the sync), but
  // overviewCoverage.weekStart is untouched by design and now lags behind.
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.weekly.overview.weekStart, "2026-09-14");
  assert.equal(state.trainingLoad.overviewCoverage.weekStart, "2026-09-07", "sanity: overviewCoverage's own field genuinely lags, by design");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-open" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-toggle", kind: "athlete", id: "ath-9" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });

  assert.match(lastCalendarUrl, /dateFrom=2026-09-14/, "must reload the CURRENT shared week, never the stale week overviewCoverage's own field lagged at");
});

test("confirming the filter is a no-op for Overview's coverage block if Overview was never visited this session", async () => {
  resetState();
  let calendarCallCount = 0;
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) { calendarCallCount += 1; return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", {}) }; }
    return { status: 404, body: {} };
  });
  state.trainingLoad.section = "results";
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "results" }), { renderTrainingLoad });
  assert.equal(calendarCallCount, 0);

  state.trainingLoad.filterPicker.open = true;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-filter-confirm" }), { renderTrainingLoad });
  assert.equal(calendarCallCount, 0, "never a background fetch for a block that was never opened this session");
});

// -------------------- Workspace-switch reset --------------------

test("resetTrainingLoadForWorkspaceChange clears the overviewCoverage nav slot too", () => {
  resetState();
  state.trainingLoad.overviewCoverage = { weekStart: "2026-09-07", data: { dateFrom: "2026-09-07", dateTo: "2026-09-13", days: [] }, loading: false, error: "" };
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.overviewCoverage.weekStart, "");
  assert.equal(state.trainingLoad.overviewCoverage.data, null);
});

// -------------------- Tab order --------------------

test("Overview is the FIRST Data & Analysis sub-nav tab, before Activities/Athletes/Dashboards", async () => {
  resetState();
  installFetchMock(async () => ({ status: 200, body: weekPayload("2026-09-07", {}) }));
  const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
  state.trainingLoad.section = "overview";
  const html = renderTrainingLoadCoachHtml();
  const overviewIndex = html.indexOf(">Overview<");
  const activitiesIndex = html.indexOf(">Activities<");
  const athletesIndex = html.indexOf(">Athletes<");
  const dashboardsIndex = html.indexOf(">Dashboards<");
  assert.ok(overviewIndex >= 0 && overviewIndex < activitiesIndex && activitiesIndex < athletesIndex && athletesIndex < dashboardsIndex);
});

// -------------------- No new API contracts --------------------

test("Overview only ever uses the pre-existing /weekly and /calendar endpoints - no new endpoint", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-07", {}) };
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: calendarPayload("2026-09-07", "2026-09-13", {}) };
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "overview" }), { renderTrainingLoad });
  for (const call of fetchCalls) {
    assert.match(call.url, /^\/api\/training-load\/(weekly|calendar)\?/, `unexpected endpoint shape: ${call.url}`);
  }
});
