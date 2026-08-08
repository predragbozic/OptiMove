import { after, test } from "node:test";
import assert from "node:assert/strict";

// perf/main-navigation-cache: searchExercises() must key its cache by every
// server-relevant parameter (search term, filters, favorite, limit/paging)
// so returning to an already-seen filter combination is instant and a
// different one is never accidentally shown the previous combination's
// results - but `marked` (a purely client-side filter never sent to the
// server - see exerciseSearchUrl) must never fragment the cache.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", value: "", textContent: "" };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { searchExercises } = await import("../exercise-actions.js");
const { state, EXERCISE_FILTERS } = await import("../state.js");
const { buildContextKey, clearAllViewCache, getCacheEntry, VIEW_CACHE_FRESHNESS_MS } = await import("../view-cache.js");
const { currentUserWorkspaceContextParts } = await import("../access.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } }) {
  clearAllViewCache();
  state.currentUser = user;
  state.exerciseSearch = {
    term: "",
    limit: 30,
    hasMore: false,
    filters: { purpose: "", quality: "", group: "", bodyPart: "", movementPattern: "", startingPosition: "", place: "", complexity: "", attractor: "", tag: "", favorite: false, marked: false },
    options: { purposes: [], qualities: [], groups: [], bodyParts: [], movementPatterns: [], startingPositions: [], places: [], complexities: [], attractors: [], tags: [] },
  };
  state.markedExerciseIds = new Set();
  state.markedExercises = new Map();
}

function handlers() {
  const renderCalls = [];
  const loadingCalls = [];
  return {
    renderExercises: (rows) => renderCalls.push(rows),
    setLoading: (text) => loadingCalls.push(text),
    renderCalls,
    loadingCalls,
  };
}

function mockFetchBySearch(resultsByKey) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const params = new URL(url, "http://x").searchParams;
    const key = `${params.get("search") || ""}|${params.get("purpose") || ""}|${params.get("favorite") || ""}`;
    return { ok: true, status: 200, json: async () => ({ exercises: resultsByKey[key] || [], hasMore: false }) };
  };
  return calls;
}

test("1. returning to an already-seen search/filter combination is instant, no new request", async () => {
  resetState();
  const calls = mockFetchBySearch({ "squat||": [{ id: "e1", name: "Squat" }] });
  const h1 = handlers();
  await searchExercises("squat", h1);
  assert.equal(calls.length, 1);

  state.exerciseSearch.filters.purpose = "strength";
  const h2 = handlers();
  await searchExercises("squat", h2);
  assert.equal(calls.length, 2, "a different purpose filter is a genuinely different context");

  state.exerciseSearch.filters.purpose = "";
  const h3 = handlers();
  await searchExercises("squat", h3);
  assert.equal(calls.length, 2, "returning to the original (search, no filter) combination must not fetch again");
  assert.equal(h3.loadingCalls.length, 0);
  assert.deepEqual(h3.renderCalls[0], [{ id: "e1", name: "Squat" }]);
});

test("2. a different filter never shows the previous filter's results under its own label", async () => {
  resetState();
  mockFetchBySearch({
    "|purpose_a|": [{ id: "e1", name: "Purpose A Exercise" }],
    "|purpose_b|": [{ id: "e2", name: "Purpose B Exercise" }],
  });
  state.exerciseSearch.filters.purpose = "purpose_a";
  const h1 = handlers();
  await searchExercises("", h1);
  assert.deepEqual(h1.renderCalls[0].map((e) => e.id), ["e1"]);

  state.exerciseSearch.filters.purpose = "purpose_b";
  const h2 = handlers();
  await searchExercises("", h2);
  assert.deepEqual(h2.renderCalls[0].map((e) => e.id), ["e2"], "switching filters must never leak the previous filter's results");
});

test("3. toggling `marked` (client-only, never sent to the server) never triggers a new fetch, and the render still reflects it", async () => {
  resetState();
  const calls = mockFetchBySearch({ "||": [{ id: "e1", name: "Squat" }, { id: "e2", name: "Bench" }] });
  await searchExercises("", handlers());
  assert.equal(calls.length, 1);

  state.markedExerciseIds.add("e1");
  state.markedExercises.set("e1", { id: "e1", name: "Squat" });
  state.exerciseSearch.filters.marked = true;
  const h = handlers();
  await searchExercises("", h);
  assert.equal(calls.length, 1, "toggling `marked` must be served entirely from the already-cached raw exercise list, no new fetch");
  assert.deepEqual(h.renderCalls[0].map((e) => e.id), ["e1"], "the render must still reflect the current marked set, even though no fetch happened");
});

test("4. toggling `favorite` (a real server filter) DOES trigger a new fetch", async () => {
  resetState();
  const calls = mockFetchBySearch({ "||": [{ id: "e1", name: "Squat" }], "||true": [{ id: "e3", name: "Favorite Exercise" }] });
  await searchExercises("", handlers());
  assert.equal(calls.length, 1);

  state.exerciseSearch.filters.favorite = true;
  const h = handlers();
  await searchExercises("", h);
  assert.equal(calls.length, 2, "favorite is sent to the server (see exerciseSearchUrl) and must be part of the cache key");
  assert.deepEqual(h.renderCalls[0].map((e) => e.id), ["e3"]);
});

test("5. a different limit (\"load more\") always fetches fresh, never a short cached page", async () => {
  resetState();
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const limit = Number(new URL(url, "http://x").searchParams.get("limit"));
    const rows = Array.from({ length: Math.min(limit, 45) }, (_, i) => ({ id: `e${i}`, name: `Exercise ${i}` }));
    return { ok: true, status: 200, json: async () => ({ exercises: rows, hasMore: limit < 45 }) };
  };
  await searchExercises("", handlers());
  assert.equal(calls, 1);
  assert.equal(state.exerciseSearch.hasMore, true);

  state.exerciseSearch.limit = 60;
  const h = handlers();
  await searchExercises(state.exerciseSearch.term, h);
  assert.equal(calls, 2, "a bumped limit (load more) must always be a fresh fetch, never satisfied from the 30-row cache");
  assert.equal(h.renderCalls[0].length, 45);
});

test("6. a failed background refresh keeps the last-known-good exercise list on screen, never blanks it or shows loading again", async () => {
  resetState();
  mockFetchBySearch({ "||": [{ id: "e1", name: "Squat" }] });
  await searchExercises("", handlers());
  const contextKey = buildContextKey([
    ...currentUserWorkspaceContextParts(),
    "",
    state.exerciseSearch.limit,
    ...EXERCISE_FILTERS.map((filter) => state.exerciseSearch.filters[filter.key]),
    state.exerciseSearch.filters.favorite,
  ]);
  const entry = getCacheEntry("exercises", contextKey);
  assert.ok(entry, "sanity check: the cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await searchExercises("", h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.renderCalls.length, 1, "only the still-good cached list was rendered - the failed refresh never got to render again");
  assert.deepEqual(h.renderCalls[0].map((e) => e.id), ["e1"], "the last-known-good results must survive the failed background refresh untouched");
});
