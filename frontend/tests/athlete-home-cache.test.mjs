import { after, test } from "node:test";
import assert from "node:assert/strict";

// feature/athlete-home-mvp: loadAthleteHome() (athlete-home-data.js) is the
// athlete shell's own Home loader - state.activeTab === "athlete-home".
// GET /api/athlete-home is filtered exclusively by the caller's own session
// (req.authz.athleteId - never a client-supplied id), and the backend
// always computes "today"/"this week" from its own clock, so no filter
// parameter of any kind reaches it - account+workspace is therefore the
// complete context key, the exact same shape as Coach Home
// (coach-home-cache.test.mjs, which this file mirrors).

const { loadAthleteHome, athleteHomeContextKey, invalidateAthleteHomeCache } = await import("../athlete-home-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache, getCacheEntry, hasCachedData, VIEW_CACHE_FRESHNESS_MS } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "u1", activeWorkspace: { type: "athlete", scopeId: null } }) {
  clearAllViewCache();
  state.currentUser = user;
}

function handlers() {
  const loadingCalls = [];
  const renderCalls = [];
  return {
    setLoading: (text) => loadingCalls.push(text),
    renderAthleteHome: (payload) => renderCalls.push(payload),
    loadingCalls,
    renderCalls,
  };
}

function homePayload(overrides = {}) {
  return {
    athlete: { name: "Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: { days: [] },
    programs: { rows: [], total: 0 },
    ...overrides,
  };
}

function mockFetchOnce(payload) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  return () => calls;
}

test("athleteHomeContextKey includes the account+workspace parts, never a filter", () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "athlete", scopeId: null } };
  assert.equal(athleteHomeContextKey(), "u1|athlete|");
});

test("1. a genuine first entry shows loading and fetches exactly once", async () => {
  resetState();
  const callCount = mockFetchOnce(homePayload({ athlete: { name: "First Load", imageUrl: "" } }));
  const h = handlers();
  await loadAthleteHome(h);
  assert.equal(callCount(), 1);
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(h.renderCalls.length, 1);
  assert.equal(h.renderCalls[0].data.athlete.name, "First Load");
  assert.equal(h.renderCalls[0].error, "");
});

test("2. a repeat entry with fresh cached data makes no request and shows no loading screen", async () => {
  resetState();
  const callCount = mockFetchOnce(homePayload());
  await loadAthleteHome(handlers());
  assert.equal(callCount(), 1);

  const h2 = handlers();
  await loadAthleteHome(h2);
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
  assert.equal(h2.loadingCalls.length, 0, "a cached re-entry must never show the blank loading screen again");
  assert.equal(h2.renderCalls.length, 1, "the cached data must still be rendered immediately");
});

test("3. once stale, re-entry renders the cached data first, then refreshes in the background with no blank loading screen", async () => {
  resetState();
  mockFetchOnce(homePayload({ athlete: { name: "stale", imageUrl: "" } }));
  await loadAthleteHome(handlers());
  const entry = getCacheEntry("athlete-home", athleteHomeContextKey());
  assert.ok(entry, "the athlete-home cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchOnce(homePayload({ athlete: { name: "fresh", imageUrl: "" } }));
  const h = handlers();
  await loadAthleteHome(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must render instantly, never the blank loading screen again");
  assert.equal(h.renderCalls.length, 2, "the stale data renders first, then the refreshed result");
  assert.equal(h.renderCalls[0].data.athlete.name, "stale");
  assert.equal(h.renderCalls[1].data.athlete.name, "fresh");
});

test("4. { forceRefresh: true } (invalidateAthleteHomeCache's paired reload, used after a mutation) always bypasses the cache", async () => {
  resetState();
  mockFetchOnce(homePayload({ athlete: { name: "before-mutation", imageUrl: "" } }));
  await loadAthleteHome(handlers());

  mockFetchOnce(homePayload({ athlete: { name: "after-mutation", imageUrl: "" } }));
  const h = handlers();
  await loadAthleteHome({ ...h, forceRefresh: true });
  assert.equal(h.renderCalls.at(-1).data.athlete.name, "after-mutation", "a forced refresh must never be satisfied from the pre-mutation cache");
});

test("5. invalidateAthleteHomeCache clears the cached entry - the next entry fetches again, fresh or not", async () => {
  resetState();
  mockFetchOnce(homePayload());
  await loadAthleteHome(handlers());
  assert.ok(hasCachedData(getCacheEntry("athlete-home", athleteHomeContextKey())));

  invalidateAthleteHomeCache();
  assert.equal(hasCachedData(getCacheEntry("athlete-home", athleteHomeContextKey())), false);

  const callCount = mockFetchOnce(homePayload({ athlete: { name: "post-invalidate", imageUrl: "" } }));
  const h = handlers();
  await loadAthleteHome(h);
  assert.equal(callCount(), 1, "an invalidated entry must not silently be reused");
  assert.equal(h.renderCalls[0].data.athlete.name, "post-invalidate");
});

test("6. two fast entries dedupe into a single real request", async () => {
  resetState();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => homePayload() }), 5));
  };
  await Promise.all([loadAthleteHome(handlers()), loadAthleteHome(handlers())]);
  assert.equal(calls, 1, "two concurrent entries into the same context must issue only one real fetch");
});

test("7. switching workspace mid-flight: a late response for the OLD context must never overwrite the NEW context's render", async () => {
  resetState({ id: "u1", activeWorkspace: { type: "athlete", scopeId: "team-A" } });
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((payload) => ({ ok: true, status: 200, json: async () => payload }));
  const hOld = handlers();
  const pending = loadAthleteHome(hOld);

  state.currentUser = { id: "u1", activeWorkspace: { type: "athlete", scopeId: "team-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => homePayload({ athlete: { name: "team-B-athlete", imageUrl: "" } }) });
  const hNew = handlers();
  await loadAthleteHome(hNew);
  assert.equal(hNew.renderCalls.at(-1).data.athlete.name, "team-B-athlete");

  resolveOld(homePayload({ athlete: { name: "stale-team-A-athlete", imageUrl: "" } }));
  await pending;
  assert.equal(hNew.renderCalls.at(-1).data.athlete.name, "team-B-athlete", "the late team-A response must never overwrite team-B's already-rendered result");
});

test("8. a failed background refresh keeps the last-known-good Home data on screen, never blanks it", async () => {
  resetState();
  mockFetchOnce(homePayload({ athlete: { name: "good", imageUrl: "" } }));
  await loadAthleteHome(handlers());
  const entry = getCacheEntry("athlete-home", athleteHomeContextKey());
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadAthleteHome(h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.renderCalls.length, 1, "only the still-good cached data was rendered");
  assert.equal(h.renderCalls[0].data.athlete.name, "good");
  assert.equal(h.renderCalls[0].error, "");
});

test("9. a failed FIRST load surfaces the existing error display, with the loading screen replaced (never stuck)", async () => {
  resetState();
  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadAthleteHome(h);
  assert.equal(h.loadingCalls.length, 1, "the loading screen is shown first, same as before caching");
  assert.equal(h.renderCalls.length, 1, "a first-load failure must surface via the existing render path, not an uncaught rejection");
  assert.equal(h.renderCalls[0].data, null);
  assert.equal(h.renderCalls[0].error, "network down");
});

test("10. logout/login (clearAllViewCache) fully clears the Home cache", async () => {
  resetState();
  mockFetchOnce(homePayload());
  await loadAthleteHome(handlers());
  assert.ok(hasCachedData(getCacheEntry("athlete-home", athleteHomeContextKey())));

  clearAllViewCache();
  assert.equal(hasCachedData(getCacheEntry("athlete-home", athleteHomeContextKey())), false);
});
