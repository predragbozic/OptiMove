import { after, test } from "node:test";
import assert from "node:assert/strict";

// perf/calendar-and-menu-cache-policy: loadWeekly() (weekly-data.js) is
// Calendar's loader - state.activeTab === "weekly" is both the rail's
// "Calendar" button target and the athlete shell's "calendar" tab. It
// routes through the same loadCachedView primitive as every other cached
// view (see view-cache.test.mjs for the generic mechanics). The cache key
// is [...workspace parts, athleteId] only - week/day/month-picker selection
// never reaches the server (confirmed by reading weekly-actions.js: no
// api()/fetch call anywhere in it), so it deliberately isn't part of the
// key; a "period" in this view is really "which athlete", which these
// tests exercise directly.

const { loadWeekly, weeklyContextKey, invalidateWeeklyCache } = await import("../weekly-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache, getCacheEntry, hasCachedData, VIEW_CACHE_FRESHNESS_MS } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } }, athleteId = "athlete-1") {
  clearAllViewCache();
  state.currentUser = user;
  state.selectedAthleteId = athleteId;
  state.navStack = [];
  state.lastWeeklyData = null;
  state.selectedWeekIndex = 0;
  state.weekSelectorOpen = false;
  state.weekCalendarMonth = "";
  state.openWeekCalendarOnLoad = false;
}

function handlers() {
  const loadingCalls = [];
  const emptyCalls = [];
  const errorCalls = [];
  const headerCalls = [];
  const rootCalls = [];
  return {
    setLoading: (text) => loadingCalls.push(text),
    renderEmpty: (message) => emptyCalls.push(message),
    renderError: (error) => errorCalls.push(error),
    renderAthleteHeader: (data) => headerCalls.push(data),
    renderWeeklyRoot: (data) => rootCalls.push(data),
    loadingCalls,
    emptyCalls,
    errorCalls,
    headerCalls,
    rootCalls,
  };
}

function weeklyPayload(weeks) {
  return { mode: "weekly", weeks, dayGroups: [], microcycles: [], rows: [], adminRows: [], hasWeekly: true, availablePrograms: [] };
}

function mockFetchOnce(weeks) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => weeklyPayload(weeks) };
  };
  return () => calls;
}

test("weeklyContextKey includes the account+workspace parts and the athlete id, never the literal string 'null'/'undefined'", () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-9" } };
  assert.equal(weeklyContextKey("athlete-1"), "u1|club|club-9|athlete-1");
  state.currentUser = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } };
  assert.equal(weeklyContextKey("athlete-1"), "u1|private_coach||athlete-1");
});

test("1. no athlete selected renders the existing empty state and never fetches", async () => {
  resetState(undefined, null);
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.emptyCalls.length, 1);
  assert.equal(h.emptyCalls[0], "No athlete selected.");
});

test("2. a genuine first entry shows loading and fetches exactly once", async () => {
  resetState();
  const callCount = mockFetchOnce([{ weekStart: "2026-08-03" }]);
  const h = handlers();
  await loadWeekly(h);
  assert.equal(callCount(), 1);
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(h.rootCalls.length, 1);
  assert.equal(state.lastWeeklyData.weeks.length, 1);
});

test("3. a repeat entry with fresh cached data makes no request and shows no loading screen", async () => {
  resetState();
  const callCount = mockFetchOnce([{ weekStart: "2026-08-03" }]);
  await loadWeekly(handlers());
  assert.equal(callCount(), 1);

  const h2 = handlers();
  await loadWeekly(h2);
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
  assert.equal(h2.loadingCalls.length, 0, "a cached re-entry must never show the blank loading screen");
  assert.equal(h2.rootCalls.length, 1, "the cached data must still be rendered immediately");
});

test("4. a different athlete gets its own cache entry - never shows the previous athlete's data under the new one's label", async () => {
  resetState(undefined, "athlete-1");
  mockFetchOnce([{ weekStart: "2026-08-03", label: "athlete-1-week" }]);
  await loadWeekly(handlers());
  assert.equal(state.lastWeeklyData.weeks[0].label, "athlete-1-week");

  state.selectedAthleteId = "athlete-2";
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03", label: "athlete-2-week" }]) });
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.loadingCalls.length, 1, "a genuinely different athlete must be treated as a first entry, never served athlete-1's cache");
  assert.equal(state.lastWeeklyData.weeks[0].label, "athlete-2-week");
});

test("5. returning to a previously-visited athlete within the freshness window is instant, no new request", async () => {
  resetState(undefined, "athlete-1");
  const callsForAthlete1 = mockFetchOnce([{ weekStart: "2026-08-03", label: "athlete-1-week" }]);
  await loadWeekly(handlers());
  assert.equal(callsForAthlete1(), 1);

  state.selectedAthleteId = "athlete-2";
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03", label: "athlete-2-week" }]) });
  await loadWeekly(handlers());

  state.selectedAthleteId = "athlete-1";
  globalThis.fetch = async () => { throw new Error("must not be called - athlete-1 should still be cached and fresh"); };
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.loadingCalls.length, 0);
  assert.equal(state.lastWeeklyData.weeks[0].label, "athlete-1-week", "returning to athlete-1 must show its own cached data instantly");
});

test("6. once stale, re-entry renders the cached data first, then refreshes in the background with no blank loading screen", async () => {
  resetState();
  mockFetchOnce([{ weekStart: "2026-08-03", label: "stale" }]);
  await loadWeekly(handlers());
  const entry = getCacheEntry("weekly", weeklyContextKey("athlete-1"));
  assert.ok(entry, "the weekly cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchOnce([{ weekStart: "2026-08-03", label: "fresh" }]);
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must render instantly, never the blank loading screen again");
  assert.equal(h.rootCalls.length, 2, "the stale data renders first, then the refreshed result");
  assert.equal(h.rootCalls[0].weeks[0].label, "stale");
  assert.equal(h.rootCalls[1].weeks[0].label, "fresh");
  assert.equal(state.lastWeeklyData.weeks[0].label, "fresh");
});

test("7. two fast entries into the same athlete dedupe into a single real request", async () => {
  resetState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03" }]) }), 5));
  };
  await Promise.all([loadWeekly(handlers()), loadWeekly(handlers())]);
  assert.equal(calls, 1, "two concurrent entries into the same athlete context must issue only one real fetch");
});

test("8. a late response for a PREVIOUS athlete must never overwrite the state after the user has already switched to a new athlete", async () => {
  resetState(undefined, "athlete-1");
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((weeks) => ({ ok: true, status: 200, json: async () => weeklyPayload(weeks) }));
  const pending = loadWeekly(handlers());

  state.selectedAthleteId = "athlete-2";
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03", label: "athlete-2-week" }]) });
  await loadWeekly(handlers());
  assert.equal(state.lastWeeklyData.weeks[0].label, "athlete-2-week");

  resolveOld([{ weekStart: "2026-08-03", label: "stale-athlete-1-week" }]);
  await pending;
  assert.equal(state.lastWeeklyData.weeks[0].label, "athlete-2-week", "the late athlete-1 response must never overwrite athlete-2's state, even though it resolved last");
});

test("9. switching workspace mid-flight: a late response for the OLD workspace must never overwrite the NEW workspace's state", async () => {
  resetState({ id: "u1", activeWorkspace: { type: "club", scopeId: "club-A" } }, "athlete-1");
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((weeks) => ({ ok: true, status: 200, json: async () => weeklyPayload(weeks) }));
  const pending = loadWeekly(handlers());

  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03", label: "club-B-week" }]) });
  await loadWeekly(handlers());
  assert.equal(state.lastWeeklyData.weeks[0].label, "club-B-week");

  resolveOld([{ weekStart: "2026-08-03", label: "stale-club-A-week" }]);
  await pending;
  assert.equal(state.lastWeeklyData.weeks[0].label, "club-B-week", "the late club-A response must never overwrite club-B's state");
});

test("10. logout/login (clearAllViewCache) fully clears the Calendar cache", async () => {
  resetState();
  mockFetchOnce([{ weekStart: "2026-08-03" }]);
  await loadWeekly(handlers());
  assert.ok(hasCachedData(getCacheEntry("weekly", weeklyContextKey("athlete-1"))));

  clearAllViewCache();
  assert.equal(hasCachedData(getCacheEntry("weekly", weeklyContextKey("athlete-1"))), false);
});

test("11. a failed background refresh keeps the last-known-good Calendar data on screen, never blanks it or shows loading again", async () => {
  resetState();
  mockFetchOnce([{ weekStart: "2026-08-03", label: "good" }]);
  await loadWeekly(handlers());
  const entry = getCacheEntry("weekly", weeklyContextKey("athlete-1"));
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.errorCalls.length, 0, "a background refresh failure must never flip an already-good view into its first-load error state");
  assert.equal(h.rootCalls.length, 1, "only the still-good cached data was rendered - the failed refresh never got to render again");
  assert.equal(state.lastWeeklyData.weeks[0].label, "good");
});

test("12. a failed FIRST load surfaces the existing error display, with the loading screen replaced (never stuck)", async () => {
  resetState();
  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadWeekly(h);
  assert.equal(h.loadingCalls.length, 1, "the loading screen is shown first, same as before caching");
  assert.equal(h.errorCalls.length, 1, "a first-load failure must surface via the existing renderError display, not an uncaught rejection");
  assert.equal(h.errorCalls[0].message, "network down");
});

test("13. { forceRefresh: true } (used after a Calendar-visible mutation) always bypasses the cache", async () => {
  resetState();
  mockFetchOnce([{ weekStart: "2026-08-03", label: "before-mutation" }]);
  await loadWeekly(handlers());

  mockFetchOnce([{ weekStart: "2026-08-03", label: "after-mutation" }]);
  const h = handlers();
  await loadWeekly(h, { forceRefresh: true });
  assert.equal(state.lastWeeklyData.weeks[0].label, "after-mutation", "a forced refresh must never be satisfied from the pre-mutation cache");
  assert.equal(h.loadingCalls.length, 0, "forceRefresh on an already-cached entry still paints the cache instantly first - no blank loading screen");
});

test("14. invalidateWeeklyCache clears every athlete's cached Calendar data", async () => {
  resetState(undefined, "athlete-1");
  mockFetchOnce([{ weekStart: "2026-08-03" }]);
  await loadWeekly(handlers());
  assert.ok(hasCachedData(getCacheEntry("weekly", weeklyContextKey("athlete-1"))));

  invalidateWeeklyCache();
  assert.equal(hasCachedData(getCacheEntry("weekly", weeklyContextKey("athlete-1"))), false);
});

test("15. re-entering the SAME athlete after opening the month picker (openWeekCalendarOnLoad) does not reopen it a second time on a background refresh", async () => {
  resetState();
  mockFetchOnce([{ weekStart: "2026-08-03" }]);
  await loadWeekly(handlers());
  const entry = getCacheEntry("weekly", weeklyContextKey("athlete-1"));
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  state.openWeekCalendarOnLoad = true;
  let resolveFetch;
  globalThis.fetch = async () => new Promise((resolve) => { resolveFetch = resolve; });
  const pending = loadWeekly(handlers());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.weekSelectorOpen, true, "the picker opens on the instant cache paint, same as a genuine first load would");

  // The user closes the picker themselves while the background refresh is
  // still in flight.
  state.weekSelectorOpen = false;
  resolveFetch({ ok: true, status: 200, json: async () => weeklyPayload([{ weekStart: "2026-08-03" }]) });
  await pending;
  assert.equal(state.weekSelectorOpen, false, "the background refresh landing must never reopen a picker the user just closed");
});
