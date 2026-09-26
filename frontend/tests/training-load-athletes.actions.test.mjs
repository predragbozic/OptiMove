// Training Load IA Phase D (feature/training-load-athletes-v1): Athletes
// consolidation (canonical-activities-this-week deep-link section, added;
// rated/expected removed) + the same collection-status count relocated
// into Schedule. Athletes/Schedule's own pre-existing rendering/data-fetch
// contracts beyond these two changes stay covered by their own existing
// suites (training-load.actions.test.mjs) and are not re-tested here.
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

// Deferred-resolution mock, same shape as training-load.actions.test.mjs's
// installDeferredFetchMock - lets a test inspect the render DURING the
// fetch-in-flight window, not just after resolution (code-reviewer's narrow
// re-review finding: a synchronous mock can never catch a bug that only
// exists during real network latency).
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

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadResultsHtml, renderTrainingLoadScheduleHtml } = await import("../training-load-view.js");
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

function calendarActivityPayload(dateFrom, dateTo, itemsByDate = {}) {
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

// -------------------- Athletes: rated/expected removed --------------------

test("Athletes overview cards no longer render a rated/expected count", () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  const html = renderTrainingLoadResultsHtml();
  assert.match(html, /300 AU/);
  assert.doesNotMatch(html, /rated \/ expected/i);
});

test("Athletes athlete-detail no longer renders a rated/expected tile", () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  state.trainingLoad.resultsAthleteId = "ath-1";
  const html = renderTrainingLoadResultsHtml();
  assert.match(html, /Weekly sRPE/);
  assert.doesNotMatch(html, /Rated \/ expected/);
});

// -------------------- Schedule: collection status added --------------------

test("Schedule shows a rated/expected collection-status line using its OWN weekly payload", () => {
  resetState();
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-09-07", {
    "2026-09-09": [
      session({ sessionId: "s1", rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } }),
      session({ sessionId: "s2", rated: false }),
    ],
  });
  const html = renderTrainingLoadScheduleHtml();
  assert.match(html, /1\/2/);
  assert.match(html, /sessions rated this week/);
});

test("Schedule renders no collection-status line at all when there is nothing planned (0/0)", () => {
  resetState();
  state.trainingLoad.weekly.schedule.data = weekPayload("2026-09-07", {});
  const html = renderTrainingLoadScheduleHtml();
  assert.doesNotMatch(html, /sessions rated this week/);
});

// -------------------- Athletes: canonical activities this week --------------------

test("opening an athlete fetches their canonical activities for the shared week in exactly ONE batched /calendar call, never per-activity", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar")) {
      return { status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", { "2026-09-09": [{ kind: "activity", activityId: "act-1", name: "Morning Strength" }] }) };
    }
    return { status: 404, body: {} };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });

  const calendarCalls = fetchCalls.filter((c) => c.url.startsWith("/api/training-load/calendar"));
  assert.equal(calendarCalls.length, 1, "exactly one batched call, never one per activity");
  assert.match(calendarCalls[0].url, /athleteIds=ath-1/, "scoped server-side to this athlete via the EXISTING filter param, no new endpoint");
  assert.match(calendarCalls[0].url, /dateFrom=2026-09-07/, "uses the shared week, not an independent one");

  const html = renderTrainingLoadResultsHtml();
  assert.match(html, /Canonical activities this week/);
  assert.match(html, /Morning Strength/);
  assert.match(html, /data-action="training-load-results-view-activity-in-calendar" data-activity-id="act-1"/);
});

// code-reviewer finding: Prev/Next/Today while an athlete's detail is open
// must re-fetch this section too, or it silently keeps showing the OLD
// week's activities under a "this week" heading while the summary tiles
// above it (which read the live weekly payload) already moved on.
test("Next-week while an athlete's detail is open re-fetches their canonical activities for the NEW week, never leaving the old week's list showing", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar") && call.url.includes("dateFrom=2026-09-07")) {
      return { status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", { "2026-09-09": [{ kind: "activity", activityId: "act-week1", name: "Week1 Activity" }] }) };
    }
    if (call.url.startsWith("/api/training-load/calendar") && call.url.includes("dateFrom=2026-09-14")) {
      return { status: 200, body: calendarActivityPayload("2026-09-14", "2026-09-20", {}) };
    }
    if (call.url.startsWith("/api/training-load/weekly")) return { status: 200, body: weekPayload("2026-09-14", {}) };
    return { status: 404, body: {} };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  assert.match(renderTrainingLoadResultsHtml(), /Week1 Activity/, "sanity: week 1's activity shows before navigating");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });
  const html = renderTrainingLoadResultsHtml();
  assert.doesNotMatch(html, /Week1 Activity/, "the OLD week's activity must never keep showing under the new week's heading");
});

// code-reviewer finding (narrow re-review, round 2): the fix above sets
// nav.weekStart to the NEW week synchronously before the fetch starts, but
// never cleared nav.data - so during the real in-flight window (before the
// new /calendar response resolves), nav.weekStart already equals the new
// week while nav.data still holds the OLD week's payload, and the render
// guard (which only compares nav.weekStart) incorrectly let it through. A
// synchronous mock can never exercise this window; only a deferred mock can.
test("in-flight fetch window: navigating weeks never renders the OLD week's stale activities before the NEW week's fetch resolves - shows loading instead", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar") && call.url.includes("dateFrom=2026-09-07")) {
      return { status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", { "2026-09-09": [{ kind: "activity", activityId: "act-week1", name: "Week1 Activity" }] }) };
    }
    return { status: 404, body: {} };
  });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  assert.match(renderTrainingLoadResultsHtml(), /Week1 Activity/, "sanity: week 1's activity is visible before navigating");

  const deferreds = installDeferredFetchMock();
  const navPromise = handleTrainingLoadAction(fakeAction({ action: "training-load-weekly-next-week", section: "results" }), { renderTrainingLoad });

  // Mid-flight: nav.weekStart has already moved to the new week
  // synchronously, but neither the new weekly payload nor the new
  // /calendar response has resolved yet.
  const midFlightHtml = renderTrainingLoadResultsHtml();
  assert.doesNotMatch(midFlightHtml, /Week1 Activity/, "the OLD week's activity must never render once nav.weekStart already reads as the NEW week");
  assert.match(midFlightHtml, /Loading activities/i, "must show a loading indicator instead of stale content during the in-flight window");

  for (const d of deferreds) {
    if (d.call.url.startsWith("/api/training-load/weekly")) {
      d.resolve({ status: 200, body: weekPayload("2026-09-14", {}) });
    } else if (d.call.url.startsWith("/api/training-load/calendar")) {
      d.resolve({ status: 200, body: calendarActivityPayload("2026-09-14", "2026-09-20", {}) });
    }
  }
  await navPromise;

  const finalHtml = renderTrainingLoadResultsHtml();
  assert.doesNotMatch(finalHtml, /Week1 Activity/, "still correct once the fetch actually resolves");
  assert.doesNotMatch(finalHtml, /Loading activities/i, "loading indicator clears once resolved");
});

// code-reviewer finding (narrow re-review, round 3): the week-only isNewWeek
// check missed the OTHER independent dimension of this nav slot's identity -
// athleteId. Closing one athlete's detail and opening a DIFFERENT one in the
// SAME week never changed nav.weekStart, so nav.data (the first athlete's
// stale payload) was never cleared, and it rendered under the second
// athlete's page during the in-flight window - same bug class, different key.
test("in-flight fetch window: switching to a different athlete in the SAME week never renders the PREVIOUS athlete's stale activities before the new fetch resolves", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [
      session({ sessionId: "s1", athleteId: "ath-1", athleteName: "Ana", rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } }),
      session({ sessionId: "s2", athleteId: "ath-2", athleteName: "Marko", rated: true, feedback: { rpe: 5, durationMinutes: 40, srpe: 200 } }),
    ],
  });
  state.trainingLoad.weekly.results.weekStart = "2026-09-07";
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar") && call.url.includes("athleteIds=ath-1")) {
      return { status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", { "2026-09-09": [{ kind: "activity", activityId: "act-ana", name: "Ana Activity" }] }) };
    }
    return { status: 404, body: {} };
  });

  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  assert.match(renderTrainingLoadResultsHtml(), /Ana Activity/, "sanity: athlete 1's own activity shows before switching");

  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-close-athlete" }), { renderTrainingLoad });

  const deferreds = installDeferredFetchMock();
  const openPromise = handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-2" }), { renderTrainingLoad });

  const midFlightHtml = renderTrainingLoadResultsHtml();
  assert.doesNotMatch(midFlightHtml, /Ana Activity/, "athlete 1's activity must never render under athlete 2's now-open detail during the in-flight window");

  for (const d of deferreds) {
    if (d.call.url.startsWith("/api/training-load/calendar")) {
      d.resolve({ status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", { "2026-09-09": [{ kind: "activity", activityId: "act-marko", name: "Marko Activity" }] }) });
    }
  }
  await openPromise;

  const finalHtml = renderTrainingLoadResultsHtml();
  assert.match(finalHtml, /Marko Activity/, "athlete 2's own real activity shows once resolved");
  assert.doesNotMatch(finalHtml, /Ana Activity/, "athlete 1's activity never leaks into athlete 2's page");
});

test("the activities-this-week section is defensive against a malformed/empty payload shape, never crashes", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  installFetchMock(async () => ({ status: 200, body: { rows: [] } })); // no `days` at all
  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  assert.doesNotThrow(() => renderTrainingLoadResultsHtml());
});

// -------------------- Deep-link hand-off into Activities --------------------

test("'View in Activities' switches to Activities already on the right day/activity, using the SAME shared week - not a new independent one", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", {}) };
    if (call.url.endsWith("/roster")) return { status: 200, body: { activity: { id: "act-1", name: "Activity" }, canonicalActivityId: "act-1", athletes: [], recordedOutsideRoster: [], counts: { total: 0, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 }, completion: { status: "not_complete" }, reasons: [] } };
    if (call.url.startsWith("/api/training-activity/")) return { status: 200, body: { facts: [], components: [] } };
    return { status: 404, body: {} };
  });

  const handled = await handleTrainingLoadAction(fakeAction({ action: "training-load-results-view-activity-in-calendar", activityId: "act-1", date: "2026-09-09" }), { renderTrainingLoad });
  assert.equal(handled, true);
  assert.equal(state.trainingLoad.section, "today");
  assert.equal(state.trainingLoad.calendar.selectedActivityId, "act-1");
  assert.equal(state.trainingLoad.calendar.selectedDate, "2026-09-09");
  assert.equal(state.trainingLoad.calendar.weekStart, "2026-09-07", "Monday-anchored week containing the target date");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "2026-09-07", "the shared week is kept in sync by this hand-off too");

  const activityDetailCalls = fetchCalls.filter((c) => c.url === "/api/training-activity/act-1");
  const rosterCalls = fetchCalls.filter((c) => c.url === "/api/training-activity/act-1/roster");
  assert.equal(activityDetailCalls.length, 1, "exactly one activity-detail fetch for the ONE target activity, never N+1");
  assert.equal(rosterCalls.length, 1, "the hand-off loads the target roster too");
});

test("Athletes hand-off clears the previous roster immediately and only accepts the target roster", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.roster.activityId = "act-old";
  cal.roster.data = { activity: { id: "act-old" }, canonicalActivityId: "act-old", athletes: [{ athleteId: "old", name: "Old athlete" }], counts: { total: 1, needsState: 0, needsReview: 0 } };
  cal.roster.applicable = true;
  const deferreds = installDeferredFetchMock();

  const handoff = handleTrainingLoadAction(fakeAction({ action: "training-load-results-view-activity-in-calendar", activityId: "act-new", date: "2026-09-09" }), { renderTrainingLoad });
  assert.equal(cal.selectedActivityId, "act-new");
  assert.equal(cal.roster.activityId, "act-new");
  assert.equal(cal.roster.data, null, "the old roster is gone before any target response arrives");

  for (const d of deferreds) {
    if (d.call.url.startsWith("/api/training-load/calendar")) d.resolve({ status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", {}) });
    else if (d.call.url.endsWith("/roster")) d.resolve({ status: 200, body: { activity: { id: "act-new", name: "New" }, canonicalActivityId: "act-new", athletes: [], recordedOutsideRoster: [], counts: { total: 0, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 }, completion: { status: "not_complete" }, reasons: [] } });
    else d.resolve({ status: 200, body: { facts: [], components: [] } });
  }
  await handoff;
  assert.equal(cal.roster.data.activity.id, "act-new");
});

// -------------------- Workspace-switch reset covers the new state --------------------

test("resetTrainingLoadForWorkspaceChange clears the athlete-activities nav slot too", async () => {
  resetState();
  const { resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
  state.trainingLoad.resultsAthleteActivities = { athleteId: "ath-1", weekStart: "2026-09-07", data: { days: [] }, loading: false, error: "" };
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.resultsAthleteActivities.athleteId, "");
  assert.equal(state.trainingLoad.resultsAthleteActivities.data, null);
});

// -------------------- No new/changed API contracts --------------------

test("the new fetches only ever use the pre-existing /calendar endpoint and its existing athleteIds param - no new endpoint", async () => {
  resetState();
  state.trainingLoad.weekly.results.data = weekPayload("2026-09-07", {
    "2026-09-09": [session({ rated: true, feedback: { rpe: 6, durationMinutes: 50, srpe: 300 } })],
  });
  installFetchMock(async () => ({ status: 200, body: calendarActivityPayload("2026-09-07", "2026-09-13", {}) }));
  await handleTrainingLoadAction(fakeAction({ action: "training-load-results-open-athlete", athleteId: "ath-1" }), { renderTrainingLoad });
  for (const call of fetchCalls) {
    assert.match(call.url, /^\/api\/training-load\/calendar\?dateFrom=/, `unexpected endpoint shape: ${call.url}`);
  }
});
