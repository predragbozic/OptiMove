// Training Load IA shell (Phase A - feature/training-load-ia-v1): the new
// two-space top-level navigation (Schedule / Data & Analysis) and Data &
// Analysis's own three-view sub-navigation (Activities/Athletes/Dashboards).
// This is a routing/shell reorganization ONLY - the actual Calendar/
// Results/Analysis render functions and their data-fetch contracts are
// covered by their own existing suites (training-load-calendar.actions.
// test.mjs, training-load.actions.test.mjs, training-load-analysis.actions.
// test.mjs) and are deliberately not re-tested here; this file only proves
// the new shell reaches the right existing content from the right place,
// without changing what that content does.
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

const { handleTrainingLoadAction, setTrainingLoadSection } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml, trainingLoadTopLevelSpace } = await import("../training-load-view.js");
const { renderTrainingLoadAthleteWeeklyHtml, renderTrainingLoadHomeCardHtml, renderRpeFormHtml } = await import("../training-load-view.js");
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

// -------------------- Pure space-mapping helper --------------------

test("trainingLoadTopLevelSpace: only 'schedule' is its own space, every other section is Data & Analysis", () => {
  assert.equal(trainingLoadTopLevelSpace("schedule"), "schedule");
  assert.equal(trainingLoadTopLevelSpace("today"), "dataAnalysis");
  assert.equal(trainingLoadTopLevelSpace("results"), "dataAnalysis");
  assert.equal(trainingLoadTopLevelSpace("analysis"), "dataAnalysis");
});

// -------------------- Top-level space rendering --------------------

test("Schedule space: Schedule tab active, no Data & Analysis sub-nav, existing Schedule content renders unchanged", () => {
  resetState();
  state.trainingLoad.section = "schedule";
  const html = renderTrainingLoadCoachHtml();
  const scheduleButton = html.split("</button>").find((b) => b.includes('data-section="schedule"'));
  assert.ok(scheduleButton, "could not find the Schedule space tab");
  assert.match(scheduleButton, /is-active/, "Schedule tab carries is-active in its own button markup");
  assert.doesNotMatch(html, /training-load-subnav/, "Schedule space must never show the Data & Analysis sub-nav");
  assert.match(html, /training-load-schedule-toolbar/, "existing Schedule toolbar (New RPE session) still renders");
  assert.match(html, />New RPE session</);
  assert.doesNotMatch(html, /tl-analysis-topbar/, "Dashboards content must not leak into the Schedule space");
});

test("Data & Analysis space: space tab active, sub-nav present with exactly three views", () => {
  resetState();
  state.trainingLoad.section = "today";
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /training-load-subnav/, "Data & Analysis space renders its own sub-nav");
  assert.match(html, />Activities</);
  assert.match(html, />Athletes</);
  assert.match(html, />Dashboards</);
});

test("Activities sub-view (section='today') renders the existing Calendar content in the new location", () => {
  resetState();
  state.trainingLoad.section = "today";
  state.trainingLoad.calendar.loading = true;
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /Loading calendar/, "Calendar's own render function is reached, unchanged");
  assert.doesNotMatch(html, /training-load-schedule-toolbar/);
  assert.doesNotMatch(html, /tl-analysis-topbar/);
});

test("Athletes sub-view (section='results') renders the existing Results content in the new location", () => {
  resetState();
  state.trainingLoad.section = "results";
  state.trainingLoad.weekly.results.loading = true;
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /Loading results/, "Results' own render function is reached, unchanged");
  assert.doesNotMatch(html, /training-load-schedule-toolbar/);
  assert.doesNotMatch(html, /tl-analysis-topbar/);
});

test("Dashboards sub-view (section='analysis') renders the existing Analysis content in the new location", () => {
  resetState();
  state.trainingLoad.section = "analysis";
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /class="tl-analysis"/, "Analysis's own top-level wrapper is reached, unchanged");
  assert.doesNotMatch(html, /training-load-schedule-toolbar/);
});

test("each Data & Analysis sub-nav button carries is-active only for the currently active section", () => {
  resetState();
  for (const [section, label] of [["today", "Activities"], ["results", "Athletes"], ["analysis", "Dashboards"]]) {
    state.trainingLoad.section = section;
    const html = renderTrainingLoadCoachHtml();
    const activeMatch = html.match(/<button[^>]*training-load-subnav-tab is-active"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(activeMatch, `expected exactly one active sub-nav tab while on ${section}`);
    assert.match(activeMatch[1], new RegExp(label), `the active sub-nav tab while on ${section} must be labeled ${label}`);
  }
});

// -------------------- Preserving the sub-view across space switches --------------------

test("switching Data & Analysis -> Schedule -> Data & Analysis restores the sub-view that was active before leaving, not Activities by default", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/dashboards")) return { status: 200, body: { dashboards: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: { weekStart: "2026-09-01", weekEnd: "2026-09-07", days: [] } };
    if (call.url.startsWith("/api/training-load/planned-rpe-setting")) return { status: 200, body: { enabled: false, enabledAt: null } };
    return { status: 404, body: { error: "unexpectedUrl:" + call.url } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "analysis" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "analysis");
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "analysis");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "schedule" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "schedule");
  // lastDataAnalysisSection must survive a trip through Schedule untouched.
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "analysis");

  // The rendered "Data & Analysis" space tab's own data-section must now
  // target "analysis" (Dashboards), not fall back to "today" (Activities).
  // Split on </button> first so the two top-level tabs (Schedule and Data &
  // Analysis) can never be confused with each other by a regex scanning
  // across button boundaries.
  const htmlOnSchedule = renderTrainingLoadCoachHtml();
  const dataAnalysisButton = htmlOnSchedule.split("</button>").find((b) => b.includes("Data &amp; Analysis"));
  assert.ok(dataAnalysisButton, "could not find the Data & Analysis space tab");
  const sectionMatch = dataAnalysisButton.match(/data-section="([^"]+)"/);
  assert.ok(sectionMatch, "the Data & Analysis tab must carry its own data-section attribute");
  assert.equal(sectionMatch[1], "analysis", "the Data & Analysis tab must remember Dashboards was last active, not reset to Activities");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: sectionMatch[1] }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "analysis", "clicking the restored Data & Analysis tab lands back on Dashboards");
});

test("a fresh session defaults lastDataAnalysisSection to Activities (today), matching the pre-existing default section", () => {
  resetState();
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "today");
});

test("the Calendar->Analysis 'Choose activity' hand-off (which sets section directly, not via the generic action) still keeps lastDataAnalysisSection in sync", async () => {
  resetState();
  installFetchMock(async () => ({ status: 200, body: { rows: [], days: [] } }));
  state.trainingLoad.section = "analysis";
  state.trainingLoad.lastDataAnalysisSection = "analysis";

  await handleTrainingLoadAction(fakeAction({ action: "training-load-analysis-choose-activity" }), { renderTrainingLoad });
  assert.equal(state.trainingLoad.section, "today");
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "today", "the hand-off's own direct section change must also update lastDataAnalysisSection");
});

// Code-review finding: app.js's notification-driven openTrainingLoadResults
// (Final digest click -> Training Load -> Results) assigned
// state.trainingLoad.section = "results" directly, bypassing
// setTrainingLoadSection() - a coach on Dashboards who then opened Results
// via a notification and switched Schedule -> Data & Analysis would land
// back on Dashboards (stale lastDataAnalysisSection), not Results. Fixed by
// exporting setTrainingLoadSection and routing app.js's call site through
// it. app.js itself is never imported directly by any test in this project
// (it has import-time DOM/bootstrap side effects - see the total absence of
// "../app.js" imports anywhere under tests/), so this is proven two ways:
// the exported helper's own behavior, and a source-level check (the same
// technique training-load-analysis.actions.test.mjs already uses for a
// different app.js invariant) that the real call site was actually fixed.
test("setTrainingLoadSection is exported and keeps lastDataAnalysisSection correct even when called with 'results' from outside training-load-actions.js", () => {
  resetState();
  state.trainingLoad.lastDataAnalysisSection = "analysis";
  setTrainingLoadSection("results");
  assert.equal(state.trainingLoad.section, "results");
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "results", "a non-Data-and-Analysis-tab entry point into 'results' must still update lastDataAnalysisSection");
});

test("app.js's openTrainingLoadResults (final-digest notification click) routes through setTrainingLoadSection, never a direct assignment", () => {
  const appJsSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const fnMatch = appJsSource.match(/async function openTrainingLoadResults\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, "could not find openTrainingLoadResults in app.js");
  assert.match(fnMatch[0], /setTrainingLoadSection\("results"\)/, "must route through the single-writer helper");
  assert.doesNotMatch(fnMatch[0], /state\.trainingLoad\.section\s*=/, "must never assign state.trainingLoad.section directly - that bypasses lastDataAnalysisSection bookkeeping");
});

// -------------------- No new/changed API calls from the shell reorg --------------------

test("switching to each Data & Analysis sub-view still calls exactly the same pre-existing endpoints, nothing new", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: { dateFrom: "2026-09-01", dateTo: "2026-09-07", days: [] } };
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: { weekStart: "2026-09-01", weekEnd: "2026-09-07", days: [] } };
    if (call.url.startsWith("/api/training-load/dashboards")) return { status: 200, body: { dashboards: [] } };
    return { status: 404, body: { error: "unexpectedUrl:" + call.url } };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "today" }), { renderTrainingLoad });
  assert.ok(fetchCalls.every((c) => c.url.startsWith("/api/training-load/")), "every call stays under the existing /api/training-load/ surface");
  assert.ok(fetchCalls.some((c) => c.url.startsWith("/api/training-load/calendar")), "Activities still hits the existing calendar endpoint");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "results" }), { renderTrainingLoad });
  assert.ok(fetchCalls.some((c) => c.url.startsWith("/api/training-load/weekly")), "Athletes still hits the existing weekly endpoint");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "analysis" }), { renderTrainingLoad });
  assert.ok(fetchCalls.some((c) => c.url.startsWith("/api/training-load/dashboards")), "Dashboards still hits the existing dashboards endpoint");

  assert.ok(!fetchCalls.some((c) => c.url.includes("/overview") || c.url.includes("/space") || c.url.includes("/shell")), "no new shell-specific endpoint was invented");
});

// -------------------- Athlete-facing views untouched --------------------

test("athlete-facing Home card and This-week overlay are unaffected by the coach-side IA shell change", () => {
  resetState();
  const homeHtml = renderTrainingLoadHomeCardHtml({ sessions: [{ sessionId: "s1", rated: false, sessionName: "Gym" }] });
  assert.match(homeHtml, /data-action="training-load-home-card-open"/);
  assert.match(homeHtml, /Rate today's session: Gym/);

  state.trainingLoad.athleteWeekly = { weekStart: "2026-09-01", selectedDate: "2026-09-01", data: null, loading: true, error: "" };
  const weeklyHtml = renderTrainingLoadAthleteWeeklyHtml();
  assert.match(weeklyHtml, /data-action="training-load-athlete-weekly-close"/);
  assert.match(weeklyHtml, /Loading\.\.\./);

  const rpeHtml = renderRpeFormHtml(emptyRpeForm({ sessionId: "s1", sessionName: "Gym", rpe: 5, durationMinutes: "" }));
  assert.match(rpeHtml, /data-action="training-load-rpe-slider-input"/);
  assert.match(rpeHtml, /data-action="training-load-rpe-submit"/);
});
