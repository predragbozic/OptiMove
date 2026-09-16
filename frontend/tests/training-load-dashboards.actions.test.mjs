// Training Load IA Phase F (feature/training-load-dashboards-v1): Analysis
// becomes the final "Dashboards" view. Covers ONLY what this phase changes:
// the Activities -> Dashboards "Analyze this activity" hand-off as an
// intra-space action transferring the RUNTIME activity/component filter and
// never a dashboard's persisted default_filter; Dashboards' own From/To
// staying independent of the Phase B shared week; the duplicate Filter
// control resolved to the shell's single one. Dashboards' own pre-existing
// contracts (layout, widgets, series, persistence) stay covered by
// training-load-analysis.actions.test.mjs and are not re-tested here.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadAnalysisHtml } = await import("../training-load-analysis-view.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

const dashboardId = "11111111-1111-4111-8111-111111111111";
const activityId = "77777777-7777-4777-8777-777777777777";

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: "coach-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
}
function fakeAction(dataset, value = "") { return { dataset, value }; }
function renderTrainingLoad() {}

function dashboard(overrides = {}) {
  return { id: dashboardId, name: "Load board", description: "", status: "active", is_template: false, revision: 3, default_filter: { athleteIds: ["persisted-athlete"] }, ...overrides };
}
function detail() {
  return { dashboard: dashboard(), widgets: [] };
}
function dashboardsResponder() {
  return (call) => {
    if (call.url === "/api/training-load/dashboards") return { status: 200, body: { dashboards: [dashboard()] } };
    if (call.url === "/api/training-load/dashboards/active") return { status: 200, body: { dashboardId } };
    if (call.url === `/api/training-load/dashboards/${dashboardId}`) return { status: 200, body: detail() };
    if (call.url === `/api/training-load/dashboards/${dashboardId}/query`) return { status: 200, body: { dashboardRevision: 3, widgets: [] } };
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: { dateFrom: "2026-09-07", dateTo: "2026-09-13", days: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: { weekStart: "2026-09-07", weekEnd: "2026-09-13", days: [] } };
    return { status: 404, body: {} };
  };
}

function withActivityOpenInActivities() {
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.selectedActivityId = activityId;
  cal.data = { dateFrom: "2026-09-07", dateTo: "2026-09-13", days: [{ date: "2026-09-09", items: [{ kind: "activity", activityId, name: "Evening Recovery" }] }] };
  cal.activityDetail = { activityId, data: { canonicalActivityId: activityId, components: [{ id: "comp-a", name: "Warm-up" }] }, loading: false, error: "" };
}

// -------------------- Hand-off boundary: runtime filter only --------------------

test("Analyze this activity (no picking mode) hands off ONLY the runtime activity/component filter - never a PATCH, never a defaultFilter, while the query carries the runtime activityId", async () => {
  resetState();
  state.trainingLoad.section = "today";
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  // code-reviewer note: keep a reference to the dashboard object loaded
  // BEFORE the hand-off - the hand-off re-loads the dashboard from the
  // server, so asserting only on the freshly fetched object could never
  // catch a client-side mutation made just before that reload.
  const loadedBefore = dashboard();
  state.trainingLoad.analysis.dashboard = loadedBefore;
  withActivityOpenInActivities();
  installFetchMock(dashboardsResponder());

  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-open-in-analysis" }), { renderTrainingLoad });
  assert.deepEqual(loadedBefore.default_filter, { athleteIds: ["persisted-athlete"] }, "the previously loaded dashboard object was never mutated client-side");
  assert.equal(handled, true);
  assert.equal(state.trainingLoad.section, "analysis");
  assert.equal(state.trainingLoad.analysis.runtimeFilter.activityId, activityId);
  assert.equal(state.trainingLoad.analysis.pickingActivity, false, "works without ever entering Dashboards' picking mode");

  const writes = fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query"));
  assert.equal(writes.length, 0, `the hand-off must never write anything (got ${JSON.stringify(writes.map((c) => `${c.method} ${c.url}`))})`);
  for (const c of fetchCalls) {
    assert.ok(!c.body || !Object.prototype.hasOwnProperty.call(c.body, "defaultFilter"), `no request may carry defaultFilter: ${c.url}`);
  }
  const query = fetchCalls.find((c) => c.url === `/api/training-load/dashboards/${dashboardId}/query`);
  assert.ok(query, "the dashboard is re-queried with the runtime filter");
  assert.equal(query.body.activityId, activityId);
  assert.deepEqual(state.trainingLoad.analysis.dashboard.default_filter, { athleteIds: ["persisted-athlete"] }, "the loaded dashboard's persisted default_filter is untouched client-side too");
});

test("clearing the runtime activity in Dashboards also never touches the persisted default_filter", async () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.runtimeFilter = { athleteIds: [], activityId, componentId: "comp-a" };
  state.trainingLoad.analysis.selectedActivity = { id: activityId, name: "Evening Recovery", date: "2026-09-09" };
  installFetchMock(dashboardsResponder());

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-clear-activity" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.analysis.runtimeFilter.activityId, "");
  const writes = fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/query"));
  assert.equal(writes.length, 0);
  assert.deepEqual(state.trainingLoad.analysis.dashboard.default_filter, { athleteIds: ["persisted-athlete"] });
});

// -------------------- Dashboards' own From/To vs the shared week --------------------

test("moving the shared Data & Analysis week (from Overview, Activities or Athletes) never changes Dashboards' own From/To", async () => {
  resetState();
  state.trainingLoad.analysis.period = { dateFrom: "2026-08-01", dateTo: "2026-08-28" };
  state.trainingLoad.weekly.overview.weekStart = "2026-09-07";
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  state.trainingLoad.calendar.weekStart = "2026-09-07";
  state.trainingLoad.calendar.selectedDate = "2026-09-07";
  installFetchMock(dashboardsResponder());

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "overview" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-next" }), { renderTrainingLoad });

  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-28", "sanity: the shared week really moved three times");
  assert.deepEqual(state.trainingLoad.analysis.period, { dateFrom: "2026-08-01", dateTo: "2026-08-28" });
});

// -------------------- Shell Filter on Dashboards: decision (b) --------------------
// The shell Club/Team/Athletes filter never reaches the Dashboards query
// (runtime activity/component only - see analysisRuntimeFilterPayload), so
// Dashboards must not present it as active; the coach's selection itself
// stays in state for the other views; the runtime filter keeps working.

test("on Dashboards the shell Filter is shown unavailable - disabled, no active count, with the visible note - even while a selection exists", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.dashboards = [dashboard()];
  state.trainingLoad.filter.athleteIds = ["ath-1"];
  state.trainingLoad.filter.clubIds = ["club-1"];
  const html = renderTrainingLoadCoachHtml();
  const button = html.match(/<button[^>]*data-action="training-load-filter-open"[^>]*>[^<]*<\/button>/)[0];
  assert.match(button, /\bdisabled\b/);
  assert.match(button, /aria-disabled="true"/);
  assert.doesNotMatch(button, /is-active/);
  assert.doesNotMatch(button, /Filter \(/, "never a '(n)' count that would read as applied to the Dashboards data");
  assert.match(html, /Club, team and athlete filters are not available for Dashboards yet\./);
});

test("the coach's shell filter selection survives visiting Dashboards and still applies on Overview/Activities/Athletes", async () => {
  resetState();
  state.trainingLoad.filter.athleteIds = ["ath-1"];
  state.trainingLoad.filter.teamIds = ["team-1"];
  installFetchMock(dashboardsResponder());

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "analysis" }), { renderTrainingLoad });
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["ath-1"], "visiting Dashboards must never clear the selection");
  assert.deepEqual(state.trainingLoad.filter.teamIds, ["team-1"]);

  const isDataCall = (c) => c.url.startsWith("/api/training-load/weekly") || c.url.startsWith("/api/training-load/calendar");
  for (const section of ["results", "today", "overview"]) {
    // code-reviewer note: only look at the requests THIS switch fired -
    // `.pop()` over the cumulative list could pass on the previous
    // section's call if a future cache change made this one a hit.
    const before = fetchCalls.length;
    await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section }), { renderTrainingLoad });
    const html = renderTrainingLoadCoachHtml();
    assert.match(html, /training-load-filter-button is-active[^>]*>Filter \(2\)</, `${section}: the shell Filter is active with the preserved count`);
    assert.doesNotMatch(html, /not available for Dashboards/, `${section}: the Dashboards-only note never leaks into other views`);
    const fresh = fetchCalls.slice(before).filter(isDataCall);
    assert.ok(fresh.length, `${section}: fired its own data request`);
    for (const c of fresh) assert.match(c.url, /athleteIds=ath-1/, `${section}: the preserved selection is actually sent on this view's own request`);
  }
});

test("the Dashboards runtime activity/component filter keeps working while the shell filter is set - and the shell selection is never smuggled into the query", async () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.selectedDashboardId = dashboardId;
  state.trainingLoad.analysis.dashboard = dashboard();
  state.trainingLoad.analysis.runtimeFilter = { athleteIds: [], activityId, componentId: "" };
  state.trainingLoad.analysis.selectedActivity = { id: activityId, name: "Evening Recovery", date: "2026-09-09" };
  state.trainingLoad.analysis.componentOptions = [{ id: "comp-a", name: "Warm-up" }];
  state.trainingLoad.filter.athleteIds = ["ath-1"];
  installFetchMock(dashboardsResponder());

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-runtime-component-select" }, "comp-a"), { renderTrainingLoad });
  const query = fetchCalls.filter((c) => c.url === `/api/training-load/dashboards/${dashboardId}/query`).pop();
  assert.ok(query, "the runtime component change re-queries the dashboard");
  assert.equal(query.body.activityId, activityId);
  assert.equal(query.body.componentId, "comp-a");
  assert.equal(query.body.athleteIds, undefined, "the shell selection is not applied to Dashboards (decision (b)) - and never silently half-applied either");
  assert.deepEqual(state.trainingLoad.filter.athleteIds, ["ath-1"], "the shell selection itself is left intact");
});

// -------------------- One Filter control in the shell --------------------

test("Dashboards no longer renders its own Filter button - the Data & Analysis shell's single Filter control is the only one", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.dashboards = [dashboard()];
  const analysisHtml = renderTrainingLoadAnalysisHtml();
  assert.ok(!analysisHtml.includes('data-action="training-load-filter-open"'), "no Filter button inside the Dashboards top bar");
  const shellHtml = renderTrainingLoadCoachHtml();
  assert.equal((shellHtml.match(/data-action="training-load-filter-open"/g) || []).length, 1, "exactly one Filter control on the page");
});

test("the Dashboards top bar groups its controls (dashboard/edit, period, activity context) and keeps the period inputs at their own iOS-safe size", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  state.trainingLoad.analysis.dashboards = [dashboard()];
  const html = renderTrainingLoadAnalysisHtml();
  assert.equal((html.match(/class="tl-analysis-topbar-group"/g) || []).length, 3);
  assert.match(html, /training-load-analysis-period-from/);
  assert.match(html, /training-load-analysis-period-to/);
  assert.match(html, />Choose activity</);
});
