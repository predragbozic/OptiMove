import { after, test } from "node:test";
import assert from "node:assert/strict";

// perf/home-specific-programs-cache: loadCoachHome() (coach-home-data.js) is
// Home's loader - state.activeTab === "coach-home". GET /api/athletes/today
// is filtered per-viewer/workspace only (athleteListAccessFilter in
// backend/src/access.js); the backend always computes "today" from its own
// clock, so no date/athlete/filter parameter of any kind reaches it -
// account+workspace is therefore the complete context key, same shape as
// Coaches (coach-profile-actions.js). These tests exercise the same cache
// mechanics view-cache.test.mjs already covers generically, applied to this
// specific loader/context-key/invalidation shape.

const { loadCoachHome, coachHomeContextKey, invalidateCoachHomeCache } = await import("../coach-home-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache, getCacheEntry, hasCachedData, VIEW_CACHE_FRESHNESS_MS } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } }) {
  clearAllViewCache();
  state.currentUser = user;
}

function handlers() {
  const loadingCalls = [];
  const renderCalls = [];
  return {
    setLoading: (text) => loadingCalls.push(text),
    renderCoachHome: (payload) => renderCalls.push(payload),
    loadingCalls,
    renderCalls,
  };
}

function todayPayload(rows) {
  return { rows };
}

function mockFetchOnce(rows) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => todayPayload(rows) };
  };
  return () => calls;
}

test("coachHomeContextKey includes the account+workspace parts, never a filter", () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-9" } };
  assert.equal(coachHomeContextKey(), "u1|club|club-9");
  state.currentUser = { id: "u1", activeWorkspace: { type: "private_coach", scopeId: null } };
  assert.equal(coachHomeContextKey(), "u1|private_coach|");
});

test("1. a genuine first entry shows loading and fetches exactly once", async () => {
  resetState();
  const callCount = mockFetchOnce([{ athleteId: "a1", hasTrainingToday: true }]);
  const h = handlers();
  await loadCoachHome(h);
  assert.equal(callCount(), 1);
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(h.renderCalls.length, 1);
  assert.equal(h.renderCalls[0].rows.length, 1);
  assert.equal(h.renderCalls[0].error, "");
});

test("2. a repeat entry with fresh cached data makes no request and shows no loading screen", async () => {
  resetState();
  const callCount = mockFetchOnce([{ athleteId: "a1" }]);
  await loadCoachHome(handlers());
  assert.equal(callCount(), 1);

  const h2 = handlers();
  await loadCoachHome(h2);
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
  assert.equal(h2.loadingCalls.length, 0, "a cached re-entry must never show the blank loading screen again");
  assert.equal(h2.renderCalls.length, 1, "the cached data must still be rendered immediately");
});

test("3. once stale, re-entry renders the cached data first, then refreshes in the background with no blank loading screen", async () => {
  resetState();
  mockFetchOnce([{ athleteId: "a1", athlete: "stale" }]);
  await loadCoachHome(handlers());
  const entry = getCacheEntry("coach-home", coachHomeContextKey());
  assert.ok(entry, "the coach-home cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchOnce([{ athleteId: "a1", athlete: "fresh" }]);
  const h = handlers();
  await loadCoachHome(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must render instantly, never the blank loading screen again");
  assert.equal(h.renderCalls.length, 2, "the stale data renders first, then the refreshed result");
  assert.equal(h.renderCalls[0].rows[0].athlete, "stale");
  assert.equal(h.renderCalls[1].rows[0].athlete, "fresh");
});

test("4. { forceRefresh: true } (invalidateCoachHomeCache's paired reload, used after a mutation) always bypasses the cache", async () => {
  resetState();
  mockFetchOnce([{ athleteId: "a1", athlete: "before-mutation" }]);
  await loadCoachHome(handlers());

  mockFetchOnce([{ athleteId: "a1", athlete: "after-mutation" }]);
  const h = handlers();
  await loadCoachHome({ ...h, forceRefresh: true });
  assert.equal(h.renderCalls.at(-1).rows[0].athlete, "after-mutation", "a forced refresh must never be satisfied from the pre-mutation cache");
});

test("5. invalidateCoachHomeCache clears the cached entry - the next entry fetches again, fresh or not", async () => {
  resetState();
  mockFetchOnce([{ athleteId: "a1" }]);
  await loadCoachHome(handlers());
  assert.ok(hasCachedData(getCacheEntry("coach-home", coachHomeContextKey())));

  invalidateCoachHomeCache();
  assert.equal(hasCachedData(getCacheEntry("coach-home", coachHomeContextKey())), false);

  const callCount = mockFetchOnce([{ athleteId: "a1", athlete: "post-invalidate" }]);
  const h = handlers();
  await loadCoachHome(h);
  assert.equal(callCount(), 1, "an invalidated (still fresh-by-TTL, if it hadn't been cleared) entry must not silently be reused");
  assert.equal(h.renderCalls[0].rows[0].athlete, "post-invalidate");
});

test("6. two fast entries dedupe into a single real request", async () => {
  resetState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => todayPayload([{ athleteId: "a1" }]) }), 5));
  };
  await Promise.all([loadCoachHome(handlers()), loadCoachHome(handlers())]);
  assert.equal(calls, 1, "two concurrent entries into the same context must issue only one real fetch");
});

test("7. switching workspace mid-flight: a late response for the OLD workspace must never overwrite the NEW workspace's render", async () => {
  resetState({ id: "u1", activeWorkspace: { type: "club", scopeId: "club-A" } });
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((rows) => ({ ok: true, status: 200, json: async () => todayPayload(rows) }));
  const hOld = handlers();
  const pending = loadCoachHome(hOld);

  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: "club-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => todayPayload([{ athleteId: "b1", athlete: "club-B-athlete" }]) });
  const hNew = handlers();
  await loadCoachHome(hNew);
  assert.equal(hNew.renderCalls.at(-1).rows[0].athlete, "club-B-athlete");

  resolveOld([{ athleteId: "a1", athlete: "stale-club-A-athlete" }]);
  await pending;
  assert.equal(hNew.renderCalls.at(-1).rows[0].athlete, "club-B-athlete", "the late club-A response must never overwrite club-B's already-rendered result");
});

test("8. a failed background refresh keeps the last-known-good Home data on screen, never blanks it", async () => {
  resetState();
  mockFetchOnce([{ athleteId: "a1", athlete: "good" }]);
  await loadCoachHome(handlers());
  const entry = getCacheEntry("coach-home", coachHomeContextKey());
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadCoachHome(h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.renderCalls.length, 1, "only the still-good cached data was rendered - the failed refresh never got to render an error state");
  assert.equal(h.renderCalls[0].rows[0].athlete, "good");
  assert.equal(h.renderCalls[0].error, "");
});

test("9. a failed FIRST load surfaces the existing error display via renderCoachHome, with the loading screen replaced (never stuck)", async () => {
  resetState();
  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadCoachHome(h);
  assert.equal(h.loadingCalls.length, 1, "the loading screen is shown first, same as before caching");
  assert.equal(h.renderCalls.length, 1, "a first-load failure must surface via the existing render path, not an uncaught rejection");
  assert.equal(h.renderCalls[0].rows.length, 0);
  assert.equal(h.renderCalls[0].error, "network down");
});

test("10. logout/login (clearAllViewCache) fully clears the Home cache", async () => {
  resetState();
  mockFetchOnce([{ athleteId: "a1" }]);
  await loadCoachHome(handlers());
  assert.ok(hasCachedData(getCacheEntry("coach-home", coachHomeContextKey())));

  clearAllViewCache();
  assert.equal(hasCachedData(getCacheEntry("coach-home", coachHomeContextKey())), false);
});
