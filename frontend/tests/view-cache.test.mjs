import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextKey,
  clearAllViewCache,
  dedupeRequest,
  getCacheEntry,
  getCacheRevision,
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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

// ------------------------------------------------------------
// 17-22. Correction round 2: a mutation invalidates an in-flight key's
// cache entry and starts a fresh refetch (B) - the OLDER, still-in-flight
// response (A, fetched before the mutation) must never win the race and
// clobber B's genuinely fresh write once it finally resolves. Reproduces
// the exact sequence reported: A starts -> invalidate + start B -> B
// resolves and writes -> A resolves last.
// ------------------------------------------------------------

test("17. a late-resolving response (A) from BEFORE a mid-flight invalidation must never overwrite a fresher response (B) that already landed", async () => {
  clearAllViewCache();
  const a = deferred();
  const b = deferred();
  let call = 0;
  const fetcher = () => (++call === 1 ? a.promise : b.promise);

  const dataCallsA = [];
  const pendingA = loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher,
    applyData: (data, meta) => dataCallsA.push({ data, meta }),
    showLoading: () => {},
  });
  // Wait a real microtask so A's own dedupeRequest call has actually
  // registered its pendingPromise before the mutation below invalidates it.
  await Promise.resolve();

  // The mutation: invalidate, then start a fresh request B for the SAME key.
  invalidateCacheEntry("coaches", "ctx-1");
  const dataCallsB = [];
  const pendingB = loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher,
    applyData: (data, meta) => dataCallsB.push({ data, meta }),
    showLoading: () => {},
  });
  await Promise.resolve();

  assert.equal(call, 2, "B must be a genuinely SEPARATE fetch, never reusing A's now-orphaned in-flight promise");

  // B resolves first (the fresh, mutation-triggered data)...
  b.resolve({ rows: ["fresh-from-B"] });
  const resultB = await pendingB;
  assert.equal(resultB.outcome, "loaded");
  assert.deepEqual(getCacheEntry("coaches", "ctx-1").data, { rows: ["fresh-from-B"] });

  // ...then A (started before the mutation) finally resolves, last, with
  // stale pre-mutation data.
  a.resolve({ rows: ["stale-from-A"] });
  const resultA = await pendingA;

  assert.equal(resultA.outcome, "stale-ignored", "A's own response must be recognized as void once it resolves after the invalidation");
  assert.equal(dataCallsA.length, 0, "A's stale data must never reach its own caller's applyData either");
  assert.deepEqual(getCacheEntry("coaches", "ctx-1").data, { rows: ["fresh-from-B"] }, "B's fresh write must survive A's later, stale write attempt - the shared cache must never be clobbered");
});

test("18. the same late-response race also applies when A ends in an ERROR after the invalidation - it must never inject a phantom error over B's fresh good data", async () => {
  clearAllViewCache();
  const a = deferred();
  const b = deferred();
  let call = 0;
  const fetcher = () => (++call === 1 ? a.promise : b.promise);

  const errorCallsA = [];
  const pendingA = loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher,
    applyData: () => {},
    applyError: (error) => errorCallsA.push(error),
    showLoading: () => {},
  });
  await Promise.resolve();

  invalidateCacheEntry("coaches", "ctx-1");
  const pendingB = loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher,
    applyData: () => {},
    showLoading: () => {},
  });
  await Promise.resolve();

  b.resolve({ rows: ["fresh-from-B"] });
  await pendingB;
  assert.deepEqual(getCacheEntry("coaches", "ctx-1").data, { rows: ["fresh-from-B"] });

  a.reject(new Error("stale network failure"));
  const resultA = await pendingA;

  assert.equal(resultA.outcome, "stale-ignored");
  assert.equal(errorCallsA.length, 0, "A's now-void error must never reach applyError");
  const entry = getCacheEntry("coaches", "ctx-1");
  assert.deepEqual(entry.data, { rows: ["fresh-from-B"] }, "B's good data must survive untouched");
  assert.equal(entry.error, null, "no phantom error may be attached to an otherwise-fresh, successfully-loaded entry");
});

test("19. dedupeRequest's own cleanup never clears a NEWER request's pendingPromise - a second caller while B is still in flight must reuse B, not fire a THIRD fetch", async () => {
  clearAllViewCache();
  const a = deferred();
  const b = deferred();
  let call = 0;
  const fetcher = () => (++call === 1 ? a.promise : b.promise);

  const firstA = dedupeRequest("coaches", "ctx-1", fetcher);
  invalidateCacheEntry("coaches", "ctx-1"); // orphans A's own pendingPromise tracking
  const firstB = dedupeRequest("coaches", "ctx-1", fetcher); // a genuinely new fetch
  assert.equal(call, 2);

  // A finally settles (after B started, while B is STILL pending) - its own
  // cleanup must not touch B's pendingPromise tracking.
  a.resolve({ rows: ["stale-A"] });
  await firstA;

  // A third caller, while B is still genuinely in flight, must reuse B -
  // never start a third fetch just because A's cleanup wiped B's tracking.
  const thirdCall = dedupeRequest("coaches", "ctx-1", fetcher);
  assert.equal(call, 2, "B is still pending - a third caller must join it, not trigger a new fetch");

  b.resolve({ rows: ["fresh-B"] });
  const [bResult, thirdResult] = await Promise.all([firstB, thirdCall]);
  assert.deepEqual(bResult, { rows: ["fresh-B"] });
  assert.deepEqual(thirdResult, { rows: ["fresh-B"] }, "the third caller must have joined B's own promise and gotten B's result");
});

test("20. getCacheRevision starts at 0 for a never-touched key and is bumped by invalidateCacheEntry/invalidateCacheNamespace/clearAllViewCache, never by a plain cache write - and is monotonic, never reset, so a stale in-flight request from before a clear can never be mistaken for current again", () => {
  // Dedicated, never-touched-elsewhere-in-this-file keys - getCacheRevision
  // is a MODULE-LEVEL, ever-increasing counter by design (see the
  // `revisions` Map's own header in view-cache.js: it must survive
  // clearAllViewCache/invalidateCacheEntry deleting the entry itself, so a
  // response from before the clear can still be told apart from one after
  // it) - it is never expected to read back to a shared absolute baseline
  // across unrelated tests reusing "coaches"/"ctx-1" elsewhere in this file.
  clearAllViewCache();
  assert.equal(getCacheRevision("coaches", "ctx-rev-1"), 0);
  setCacheData("coaches", "ctx-rev-1", { rows: [] });
  assert.equal(getCacheRevision("coaches", "ctx-rev-1"), 0, "a plain successful cache write is not itself an invalidation");
  invalidateCacheEntry("coaches", "ctx-rev-1");
  assert.equal(getCacheRevision("coaches", "ctx-rev-1"), 1);
  // A key already invalidated (and with nothing newly cached/pending for
  // it since) has nothing left to protect - a namespace-wide invalidation
  // is a no-op for it specifically, only bumping keys it actually still
  // holds a live entry for (see invalidateCacheNamespace's own comment).
  setCacheData("coaches", "ctx-rev-1", { rows: ["refetched"] });
  setCacheData("coaches", "ctx-rev-2", { rows: [] });
  invalidateCacheNamespace("coaches");
  assert.equal(getCacheRevision("coaches", "ctx-rev-1"), 2, "a live entry re-created after the first invalidation is bumped again by the namespace-wide clear");
  assert.equal(getCacheRevision("coaches", "ctx-rev-2"), 1, "a namespace-wide invalidation bumps every OTHER key it actually held too, including one never explicitly invalidated before");
  setCacheData("organization", "ctx-rev-1", { clubs: [] });
  clearAllViewCache();
  assert.equal(getCacheRevision("organization", "ctx-rev-1"), 1, "clearAllViewCache bumps revisions across every namespace, not just the one most recently touched");
});

test("21. dedupeRequest coalescing for genuinely-concurrent, non-invalidated calls is completely unaffected by the revision guard - the normal payload-sharing case still works", async () => {
  clearAllViewCache();
  let fetchCount = 0;
  const fetcher = () => { fetchCount += 1; return new Promise((resolve) => setTimeout(() => resolve({ rows: ["shared"] }), 5)); };
  const dataCalls1 = [];
  const dataCalls2 = [];
  await Promise.all([
    loadCachedView({ namespace: "coaches", contextKey: "ctx-1", fetcher, applyData: (d, m) => dataCalls1.push({ d, m }), showLoading: () => {} }),
    loadCachedView({ namespace: "coaches", contextKey: "ctx-1", fetcher, applyData: (d, m) => dataCalls2.push({ d, m }), showLoading: () => {} }),
  ]);
  assert.equal(fetchCount, 1, "no invalidation happened - two concurrent callers must still share exactly one real fetch");
  assert.deepEqual(dataCalls1[0].d, { rows: ["shared"] });
  assert.deepEqual(dataCalls2[0].d, { rows: ["shared"] });
});

test("22. an invalidation that happens BEFORE loadCachedView is even called (not mid-flight) is captured correctly too - the resulting fetch still writes normally", async () => {
  clearAllViewCache();
  setCacheData("coaches", "ctx-1", { rows: ["old"] });
  invalidateCacheEntry("coaches", "ctx-1");
  const result = await loadCachedView({
    namespace: "coaches",
    contextKey: "ctx-1",
    fetcher: () => Promise.resolve({ rows: ["new"] }),
    applyData: () => {},
    showLoading: () => {},
  });
  assert.equal(result.outcome, "loaded");
  assert.deepEqual(getCacheEntry("coaches", "ctx-1").data, { rows: ["new"] }, "a request starting AFTER an invalidation (nothing changes further during its own flight) must write normally, never be treated as stale against itself");
});
