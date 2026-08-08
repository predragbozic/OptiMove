import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextKey,
  clearAllViewCache,
  dedupeRequest,
  getCacheEntry,
  hasCachedData,
  invalidateCacheEntry,
  invalidateCacheNamespace,
  isEntryFresh,
  loadCachedView,
  setCacheData,
  setCacheError,
  VIEW_CACHE_FRESHNESS_MS,
  __debugCacheSize,
} from "../view-cache.js";

// perf/main-navigation-cache: view-cache.js is the single generic primitive
// every navigation-cached view (Coaches, Settings/Organization, Program
// Library, Exercise Library, Builder's drafts list) is built on. These
// tests exercise it directly, with no DOM at all, since it's pure
// data/Promise bookkeeping - the per-view wiring tests (organization,
// coaches, templates, exercises, builder) only need to prove each view
// calls this correctly, not re-prove these invariants themselves.

test("clears the whole store between tests", () => {
  clearAllViewCache();
  assert.equal(__debugCacheSize(), 0);
});

test("1. buildContextKey normalizes null/undefined to empty string, never the literal text", () => {
  assert.equal(buildContextKey(["user-1", "club", "club-9"]), "user-1|club|club-9");
  assert.equal(buildContextKey(["user-1", "platform", null]), "user-1|platform|");
  assert.equal(buildContextKey(["user-1", "platform", undefined]), "user-1|platform|");
  assert.notEqual(buildContextKey(["a", null]), buildContextKey(["a", "null"]), "a real filter value of the string 'null' must never collide with an absent one");
});

test("2. setCacheData/getCacheEntry round-trip, and isEntryFresh respects the ttl", () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-1", { rows: [1, 2, 3] });
  const entry = getCacheEntry("coaches", "ctx-1");
  assert.deepEqual(entry.data, { rows: [1, 2, 3] });
  assert.equal(hasCachedData(entry), true);
  assert.equal(isEntryFresh(entry), true);
  assert.equal(isEntryFresh(entry, -1), false, "a ttl in the past must never read as fresh");
  assert.equal(isEntryFresh(undefined), false);
});

test("3. setCacheError on an entry with no prior data records a real error entry (existing error/retry UI applies)", () => {
  clearAllViewCache();
  const result = setCacheError("coaches", "ctx-1", new Error("boom"));
  assert.equal(result.keptCache, false);
  const entry = getCacheEntry("coaches", "ctx-1");
  assert.equal(entry.status, "error");
  assert.equal(hasCachedData(entry), false);
});

test("4. setCacheError on an entry that already has good data keeps that data untouched (background refresh failure)", () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-1", { rows: ["good"] });
  const result = setCacheError("coaches", "ctx-1", new Error("network down"));
  assert.equal(result.keptCache, true);
  const entry = getCacheEntry("coaches", "ctx-1");
  assert.deepEqual(entry.data, { rows: ["good"] }, "the previously-cached good data must survive a failed background refresh untouched");
  assert.ok(entry.error);
});

test("5. dedupeRequest collapses two concurrent identical requests into one real fetch", async () => {
  clearAllViewCache();
  let fetchCount = 0;
  const fetcher = () => {
    fetchCount += 1;
    return new Promise((resolve) => setTimeout(() => resolve({ n: fetchCount }), 10));
  };
  const [a, b] = await Promise.all([
    dedupeRequest("coaches", "ctx-1", fetcher),
    dedupeRequest("coaches", "ctx-1", fetcher),
  ]);
  assert.equal(fetchCount, 1, "only one real fetch must have been issued for two concurrent identical requests");
  assert.deepEqual(a, b);
});

test("6. dedupeRequest for a DIFFERENT contextKey is never deduped against another key", async () => {
  clearAllViewCache();
  let fetchCount = 0;
  const fetcher = () => {
    fetchCount += 1;
    return Promise.resolve(fetchCount);
  };
  await Promise.all([dedupeRequest("coaches", "ctx-A", fetcher), dedupeRequest("coaches", "ctx-B", fetcher)]);
  assert.equal(fetchCount, 2);
});

test("7. invalidateCacheEntry removes just that one context key, invalidateCacheNamespace removes every entry in a namespace", () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-A", { rows: [] });
  setCacheData("coaches", "ctx-B", { rows: [] });
  setCacheData("organization", "ctx-A", { clubs: [] });
  invalidateCacheEntry("coaches", "ctx-A");
  assert.equal(hasCachedData(getCacheEntry("coaches", "ctx-A")), false);
  assert.equal(hasCachedData(getCacheEntry("coaches", "ctx-B")), true, "a different context key in the same namespace must be untouched");
  assert.equal(hasCachedData(getCacheEntry("organization", "ctx-A")), true, "a different namespace must be untouched");

  invalidateCacheNamespace("organization");
  assert.equal(hasCachedData(getCacheEntry("organization", "ctx-A")), false);
  assert.equal(hasCachedData(getCacheEntry("coaches", "ctx-B")), true, "invalidating one namespace must never touch a different one");
});

test("8. clearAllViewCache (logout) wipes every namespace and every context key", () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-A", { rows: [] });
  setCacheData("organization", "ctx-A", { clubs: [] });
  setCacheData("templates", "ctx-A|my_programs", { templates: [] });
  clearAllViewCache();
  assert.equal(__debugCacheSize(), 0);
  assert.equal(hasCachedData(getCacheEntry("coaches", "ctx-A")), false);
  assert.equal(hasCachedData(getCacheEntry("organization", "ctx-A")), false);
  assert.equal(hasCachedData(getCacheEntry("templates", "ctx-A|my_programs")), false);
});

test("9. VIEW_CACHE_FRESHNESS_MS is the single centralized freshness constant, a positive finite number", () => {
  assert.equal(typeof VIEW_CACHE_FRESHNESS_MS, "number");
  assert.ok(VIEW_CACHE_FRESHNESS_MS > 0 && Number.isFinite(VIEW_CACHE_FRESHNESS_MS));
});

// --- loadCachedView: the actual call sites' entry point ---

test("10. loadCachedView on a genuine first entry shows loading, then applies the fetched data", async () => {
  clearAllViewCache();
  const loadingCalls = [];
  const dataCalls = [];
  const result = await loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher: () => Promise.resolve({ rows: [1] }),
    applyData: (data, meta) => dataCalls.push({ data, meta }),
    showLoading: () => loadingCalls.push(true),
  });
  assert.equal(loadingCalls.length, 1);
  assert.equal(dataCalls.length, 1);
  assert.equal(dataCalls[0].meta.fromCache, false);
  assert.equal(result.outcome, "loaded");
});

test("11. loadCachedView on a re-entry with fresh cached data applies instantly and makes no request", async () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-1", { rows: ["cached"] });
  let fetchCalled = false;
  const dataCalls = [];
  const loadingCalls = [];
  const result = await loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher: () => { fetchCalled = true; return Promise.resolve({ rows: ["fresh"] }); },
    applyData: (data, meta) => dataCalls.push({ data, meta }),
    showLoading: () => loadingCalls.push(true),
  });
  assert.equal(fetchCalled, false, "fresh cached data must never trigger a request");
  assert.equal(loadingCalls.length, 0, "a cached re-entry must never show the empty loading screen");
  assert.equal(dataCalls.length, 1);
  assert.deepEqual(dataCalls[0].data, { rows: ["cached"] });
  assert.equal(dataCalls[0].meta.fromCache, true);
  assert.equal(result.outcome, "fresh-cache");
});

test("12. loadCachedView on a re-entry with STALE cached data applies it immediately, then background-refreshes without a loading screen", async () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-1", { rows: ["stale"] });
  invalidateCacheEntry("coaches", "ctx-1"); // rebuild an entry with a forced-old loadedAt below
  const key = "coaches::ctx-1";
  // Directly age the entry past the ttl (setCacheData always stamps "now").
  setCacheData("coaches", "ctx-1", { rows: ["stale"] });
  const entry = getCacheEntry("coaches", "ctx-1");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  const dataCalls = [];
  const loadingCalls = [];
  const result = await loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher: () => Promise.resolve({ rows: ["refreshed"] }),
    applyData: (data, meta) => dataCalls.push({ data, meta }),
    showLoading: () => loadingCalls.push(true),
  });
  assert.equal(loadingCalls.length, 0, "a stale-but-present cache must render instantly, never the blank loading screen");
  assert.equal(dataCalls.length, 2, "stale data first, then the refreshed result");
  assert.deepEqual(dataCalls[0].data, { rows: ["stale"] });
  assert.equal(dataCalls[0].meta.fromCache, true);
  assert.deepEqual(dataCalls[1].data, { rows: ["refreshed"] });
  assert.equal(dataCalls[1].meta.fromCache, false);
  assert.equal(result.outcome, "background-refreshed");
  void key;
});

test("13. loadCachedView drops a late response once the context has moved on (workspace/account switch mid-request)", async () => {
  clearAllViewCache();
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const dataCalls = [];
  let currentContextKey = "ctx-old";
  const pending = loadCachedView({
    namespace: "organization",
    contextKey: "ctx-old",
    fetcher: () => fetchPromise,
    applyData: (data, meta) => dataCalls.push({ data, meta }),
    showLoading: () => {},
    getCurrentContextKey: () => currentContextKey,
  });
  // The user switches workspace before the in-flight request resolves.
  currentContextKey = "ctx-new";
  resolveFetch({ clubs: ["stale-workspace-data"] });
  const result = await pending;
  assert.equal(dataCalls.length, 0, "a response for a context the user has already navigated away from must never be applied");
  assert.equal(result.outcome, "stale-ignored");
  assert.equal(hasCachedData(getCacheEntry("organization", "ctx-old")), false, "the stale response must not even be cached under the old key once it's known to be stale");
});

test("14. a failed background refresh keeps serving the last-known-good cached data and reports background-refresh-failed", async () => {
  clearAllViewCache();
  setCacheData("templates", "ctx-1", { templates: ["good"] });
  const entry = getCacheEntry("templates", "ctx-1");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 1000);
  const dataCalls = [];
  const errorCalls = [];
  const result = await loadCachedView({
    namespace: "templates",
    contextKey: "ctx-1",
    fetcher: () => Promise.reject(new Error("500")),
    applyData: (data, meta) => dataCalls.push({ data, meta }),
    applyError: (error) => errorCalls.push(error),
    showLoading: () => {},
  });
  assert.equal(result.outcome, "background-refresh-failed");
  assert.equal(errorCalls.length, 0, "an existing-data view must never be flipped into the error state by a background refresh failure");
  assert.equal(dataCalls.length, 1, "the stale-but-good data was still applied once, from cache");
  assert.deepEqual(getCacheEntry("templates", "ctx-1").data, { templates: ["good"] });
});

test("15. a failed FIRST load (nothing cached yet) still surfaces the error via applyError, existing retry behavior", async () => {
  clearAllViewCache();
  const errorCalls = [];
  const loadingCalls = [];
  const result = await loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher: () => Promise.reject(new Error("network down")),
    applyData: () => {},
    applyError: (error) => errorCalls.push(error),
    showLoading: () => loadingCalls.push(true),
  });
  assert.equal(loadingCalls.length, 1);
  assert.equal(errorCalls.length, 1);
  assert.equal(result.outcome, "error");
});

test("16. loadCachedView also dedupes through dedupeRequest - two concurrent calls for the same empty context issue only one fetch", async () => {
  clearAllViewCache();
  let fetchCount = 0;
  const fetcher = () => { fetchCount += 1; return new Promise((resolve) => setTimeout(() => resolve({ rows: [] }), 5)); };
  await Promise.all([
    loadCachedView({ namespace: "coaches", contextKey: "ctx-1", fetcher, applyData: () => {}, showLoading: () => {} }),
    loadCachedView({ namespace: "coaches", contextKey: "ctx-1", fetcher, applyData: () => {}, showLoading: () => {} }),
  ]);
  assert.equal(fetchCount, 1);
});
