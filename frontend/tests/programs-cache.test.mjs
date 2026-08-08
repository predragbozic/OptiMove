import { after, test } from "node:test";
import assert from "node:assert/strict";

// perf/home-specific-programs-cache: loadPrograms() (programs-data.js) is
// Specific programs' loader - state.activeTab === "programs", shared as-is
// by the athlete shell's own "Specific programs" tab (data-athlete-tab=
// "programs" in athlete.html sets this exact same state.activeTab - see
// navigation.js/app.js's els.athleteTabs click handler). Same endpoint
// family and same athleteId-scoped context-key shape as Calendar
// (weekly-data.js) - GET /api/athletes/:id/program-data?program=
// __all_programs__ returns every specific-program plan for one athlete in
// one request. state.selectedProgramId (which of the already-fetched
// programs is on screen) is picked entirely client-side by the
// program-toolbar click handler in app.js (reads back from
// state.lastProgramBundle, issues no request) and is deliberately excluded
// from the cache key for that reason - these tests exercise the athlete-key
// half of that claim directly; program-selection-never-refetches is already
// evident from loadPrograms' own signature (it takes no program id at all).

const { loadPrograms, programsContextKey, invalidateProgramsCache } = await import("../programs-data.js");
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
  state.selectedProgramId = null;
  state.navStack = [];
  state.lastProgramBundle = null;
}

function handlers() {
  const loadingCalls = [];
  const emptyCalls = [];
  const errorCalls = [];
  const headerCalls = [];
  const toolbarCalls = [];
  const rootCalls = [];
  return {
    setLoading: (text) => loadingCalls.push(text),
    renderEmpty: (message) => emptyCalls.push(message),
    renderError: (error) => errorCalls.push(error),
    renderAthleteHeader: (data) => headerCalls.push(data),
    renderProgramToolbar: (programs) => toolbarCalls.push(programs),
    renderProgramRoot: (program) => rootCalls.push(program),
    loadingCalls,
    emptyCalls,
    errorCalls,
    headerCalls,
    toolbarCalls,
    rootCalls,
  };
}

function programsPayload(programs) {
  return { programs };
}

function mockFetchOnce(programs) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => programsPayload(programs) };
  };
  return () => calls;
}

test("programsContextKey includes the account+workspace parts and the athlete id, never selectedProgramId", () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-9" } };
  assert.equal(programsContextKey("athlete-1"), "u1|club|club-9|athlete-1");
  state.currentUser = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } };
  assert.equal(programsContextKey("athlete-1"), "u1|private_coach||athlete-1");
});

test("1. no athlete selected renders the existing empty state and never fetches", async () => {
  resetState(undefined, null);
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.emptyCalls.length, 1);
  assert.equal(h.emptyCalls[0], "No athlete selected.");
});

test("2. a genuine first entry shows loading, fetches exactly once, and selects the first program by default", async () => {
  resetState();
  const callCount = mockFetchOnce([{ id: "p1", name: "Program A" }, { id: "p2", name: "Program B" }]);
  const h = handlers();
  await loadPrograms(h);
  assert.equal(callCount(), 1);
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(h.rootCalls.length, 1);
  assert.equal(state.selectedProgramId, "p1");
  assert.equal(h.rootCalls[0].id, "p1");
});

test("3. returning to the same athlete/program context is instant - no request, no loading screen", async () => {
  resetState();
  const callCount = mockFetchOnce([{ id: "p1", name: "Program A" }]);
  await loadPrograms(handlers());
  assert.equal(callCount(), 1);

  const h2 = handlers();
  await loadPrograms(h2);
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
  assert.equal(h2.loadingCalls.length, 0, "a cached re-entry must never show the blank loading screen again");
  assert.equal(h2.rootCalls.length, 1, "the cached data must still be rendered immediately");
});

test("4. a different athlete gets its own cache entry - never shows the previous athlete's programs under the new one's label", async () => {
  resetState(undefined, "athlete-1");
  mockFetchOnce([{ id: "p1", name: "athlete-1-program" }]);
  await loadPrograms(handlers());
  assert.equal(state.lastProgramBundle.programs[0].name, "athlete-1-program");

  state.selectedAthleteId = "athlete-2";
  state.selectedProgramId = null;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => programsPayload([{ id: "p2", name: "athlete-2-program" }]) });
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.loadingCalls.length, 1, "a genuinely different athlete must be treated as a first entry, never served athlete-1's cache");
  assert.equal(state.lastProgramBundle.programs[0].name, "athlete-2-program");
});

test("5. returning to a previously-visited athlete within the freshness window is instant, no new request", async () => {
  resetState(undefined, "athlete-1");
  const callsForAthlete1 = mockFetchOnce([{ id: "p1", name: "athlete-1-program" }]);
  await loadPrograms(handlers());
  assert.equal(callsForAthlete1(), 1);

  state.selectedAthleteId = "athlete-2";
  state.selectedProgramId = null;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => programsPayload([{ id: "p2", name: "athlete-2-program" }]) });
  await loadPrograms(handlers());

  state.selectedAthleteId = "athlete-1";
  state.selectedProgramId = null;
  globalThis.fetch = async () => { throw new Error("must not be called - athlete-1 should still be cached and fresh"); };
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.loadingCalls.length, 0);
  assert.equal(state.lastProgramBundle.programs[0].name, "athlete-1-program", "returning to athlete-1 must show its own cached data instantly");
});

test("6. once stale, re-entry renders the cached data first, then refreshes in the background with no blank loading screen", async () => {
  resetState();
  mockFetchOnce([{ id: "p1", name: "stale" }]);
  await loadPrograms(handlers());
  const entry = getCacheEntry("programs", programsContextKey("athlete-1"));
  assert.ok(entry, "the programs cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchOnce([{ id: "p1", name: "fresh" }]);
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must render instantly, never the blank loading screen again");
  assert.equal(h.rootCalls.length, 2, "the stale data renders first, then the refreshed result");
  assert.equal(h.rootCalls[0].name, "stale");
  assert.equal(h.rootCalls[1].name, "fresh");
});

test("7. { forceRefresh: true } (Builder exit/delete after a mutation) always bypasses the cache", async () => {
  resetState();
  mockFetchOnce([{ id: "p1", name: "before-mutation" }]);
  await loadPrograms(handlers());

  mockFetchOnce([{ id: "p1", name: "after-mutation" }]);
  const h = handlers();
  await loadPrograms(h, { forceRefresh: true });
  assert.equal(state.lastProgramBundle.programs[0].name, "after-mutation", "a forced refresh must never be satisfied from the pre-mutation cache");
});

test("8. invalidateProgramsCache invalidates only the affected athlete, not other athletes' cached programs", async () => {
  resetState(undefined, "athlete-1");
  mockFetchOnce([{ id: "p1", name: "athlete-1-program" }]);
  await loadPrograms(handlers());

  state.selectedAthleteId = "athlete-2";
  state.selectedProgramId = null;
  mockFetchOnce([{ id: "p2", name: "athlete-2-program" }]);
  await loadPrograms(handlers());

  invalidateProgramsCache("athlete-1");
  assert.equal(hasCachedData(getCacheEntry("programs", programsContextKey("athlete-1"))), false, "athlete-1's entry must be gone");
  assert.ok(hasCachedData(getCacheEntry("programs", programsContextKey("athlete-2"))), "athlete-2's entry must be untouched by an athlete-1-scoped invalidation");
});

test("9. two fast entries into the same athlete dedupe into a single real request", async () => {
  resetState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => programsPayload([{ id: "p1" }]) }), 5));
  };
  await Promise.all([loadPrograms(handlers()), loadPrograms(handlers())]);
  assert.equal(calls, 1, "two concurrent entries into the same athlete context must issue only one real fetch");
});

test("10. a late response for a PREVIOUS athlete must never overwrite the state after the user has already switched to a new athlete", async () => {
  resetState(undefined, "athlete-1");
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((programs) => ({ ok: true, status: 200, json: async () => programsPayload(programs) }));
  const pending = loadPrograms(handlers());

  state.selectedAthleteId = "athlete-2";
  state.selectedProgramId = null;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => programsPayload([{ id: "p2", name: "athlete-2-program" }]) });
  await loadPrograms(handlers());
  assert.equal(state.lastProgramBundle.programs[0].name, "athlete-2-program");

  resolveOld([{ id: "p1", name: "stale-athlete-1-program" }]);
  await pending;
  assert.equal(state.lastProgramBundle.programs[0].name, "athlete-2-program", "the late athlete-1 response must never overwrite athlete-2's state, even though it resolved last");
});

test("11. switching workspace mid-flight: a late response for the OLD workspace must never overwrite the NEW workspace's state", async () => {
  resetState({ id: "u1", activeWorkspace: { type: "club", scopeId: "club-A" } }, "athlete-1");
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((programs) => ({ ok: true, status: 200, json: async () => programsPayload(programs) }));
  const pending = loadPrograms(handlers());

  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => programsPayload([{ id: "p2", name: "club-B-program" }]) });
  await loadPrograms(handlers());
  assert.equal(state.lastProgramBundle.programs[0].name, "club-B-program");

  resolveOld([{ id: "p1", name: "stale-club-A-program" }]);
  await pending;
  assert.equal(state.lastProgramBundle.programs[0].name, "club-B-program", "the late club-A response must never overwrite club-B's state");
});

test("12. a failed background refresh keeps the last-known-good programs data on screen, never blanks it or shows loading again", async () => {
  resetState();
  mockFetchOnce([{ id: "p1", name: "good" }]);
  await loadPrograms(handlers());
  const entry = getCacheEntry("programs", programsContextKey("athlete-1"));
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.errorCalls.length, 0, "a background refresh failure must never flip an already-good view into its first-load error state");
  assert.equal(h.rootCalls.length, 1, "only the still-good cached data was rendered - the failed refresh never got to render again");
  assert.equal(state.lastProgramBundle.programs[0].name, "good");
});

test("13. a failed FIRST load surfaces the existing error display, with the loading screen replaced (never stuck)", async () => {
  resetState();
  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadPrograms(h);
  assert.equal(h.loadingCalls.length, 1, "the loading screen is shown first, same as before caching");
  assert.equal(h.errorCalls.length, 1, "a first-load failure must surface via the existing renderError display, not an uncaught rejection");
  assert.equal(h.errorCalls[0].message, "network down");
});

test("14. logout/login (clearAllViewCache) fully clears the Specific programs cache", async () => {
  resetState();
  mockFetchOnce([{ id: "p1" }]);
  await loadPrograms(handlers());
  assert.ok(hasCachedData(getCacheEntry("programs", programsContextKey("athlete-1"))));

  clearAllViewCache();
  assert.equal(hasCachedData(getCacheEntry("programs", programsContextKey("athlete-1"))), false);
});

test("15. a Specific programs cache read/background-refresh never touches an open Builder draft (state.builder.draft)", async () => {
  resetState();
  mockFetchOnce([{ id: "p1", name: "first" }]);
  await loadPrograms(handlers());
  const entry = getCacheEntry("programs", programsContextKey("athlete-1"));
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  // Builder's own state slice (state.builder.draft) is a completely
  // separate cache namespace ("builderDrafts", "local-draft" policy in
  // menu-cache-policy.js) that loadPrograms/programs-data.js never reads or
  // writes at all - this asserts that structural separation directly: an
  // in-flight background refresh of "programs" must never touch it, even
  // if a draft happened to be sitting in memory (e.g. the user switched
  // away from Builder without formally exiting).
  state.builder = { draft: { plan: { id: "in-progress-draft" }, unsavedMarker: "do-not-touch" } };
  mockFetchOnce([{ id: "p1", name: "background-refreshed" }]);
  await loadPrograms(handlers());
  assert.deepEqual(state.builder.draft, { plan: { id: "in-progress-draft" }, unsavedMarker: "do-not-touch" }, "an open Builder draft must be completely untouched by a programs cache refresh");
});
