import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// perf/main-navigation-cache: loadCoaches() must render instantly from
// cache on re-entry, only fetch when needed, and never mix data between two
// different (account, workspace) contexts. coach-profile-actions.js is a
// standalone, already-exported module (loadCoaches doesn't touch
// document/els at all - only the render callbacks it's handed do), so this
// drives it directly, unlike app.js. It does, however, import
// openTemplatePreviewFromCoachProgram from program-library-actions.js
// (pre-merge audit fix: that file now also imports invalidateTemplatesCache
// from program-library-data.js, which touches `document` at module load via
// dom.js) - the minimal stub below exists purely to satisfy that transitive
// import chain, not because loadCoaches itself needs a DOM.
const fakeElements = new Map();
function fakeElement() {
  return { textContent: "", innerHTML: "", classList: { contains: () => false } };
}
globalThis.document = {
  body: fakeElement(),
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { loadCoaches, submitCoachProfileForm } = await import("../coach-profile-actions.js");
const { state } = await import("../state.js");
const { clearAllViewCache, VIEW_CACHE_FRESHNESS_MS, getCacheEntry } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "coach-1", activeWorkspace: { type: "private_coach", scopeId: null } }) {
  clearAllViewCache();
  state.coaches = { rows: [], selected: null, detail: null, editOpen: false, contactOpen: false, error: "" };
  state.currentUser = user;
  state.navStack = [];
}

function mockFetchOnce(coaches) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ coaches }) };
  };
  return () => calls;
}

function handlers() {
  const loadingCalls = [];
  const renderCalls = [];
  return {
    setLoading: (text) => loadingCalls.push(text),
    renderCoaches: () => renderCalls.push(state.coaches.rows),
    loadingCalls,
    renderCalls,
  };
}

test("1. a genuine first entry into Coaches shows loading and fetches once", async () => {
  resetState();
  const callCount = mockFetchOnce([{ id: "c1", name: "Coach One" }]);
  const h = handlers();
  await loadCoaches(h);
  assert.equal(callCount(), 1);
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(state.coaches.rows.length, 1);
});

test("2. a repeat entry with fresh cached data makes no request and shows no loading screen", async () => {
  resetState();
  const callCount = mockFetchOnce([{ id: "c1", name: "Coach One" }]);
  await loadCoaches(handlers());
  assert.equal(callCount(), 1);

  const h2 = handlers();
  await loadCoaches(h2);
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
  assert.equal(h2.loadingCalls.length, 0);
  assert.equal(h2.renderCalls.length, 1, "the cached data must still be rendered immediately");
});

test("3. once the cache goes stale, re-entry renders the cached list instantly, then refreshes in the background", async () => {
  resetState();
  mockFetchOnce([{ id: "c1", name: "Coach One" }]);
  await loadCoaches(handlers());
  const entry = getCacheEntry("coaches", "coach-1|private_coach|");
  assert.ok(entry, "the coaches cache entry must exist under the expected (user, workspace) context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ coaches: [{ id: "c1", name: "Coach One" }, { id: "c2", name: "Coach Two" }] }) });
  const h = handlers();
  await loadCoaches(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must never show the blank loading screen again");
  assert.equal(h.renderCalls.length, 2, "the stale list renders first, then the refreshed one");
  assert.equal(state.coaches.rows.length, 2);
});

test("4. switching to a different workspace never shows the previous workspace's cached coach list", async () => {
  resetState({ id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-A" } });
  mockFetchOnce([{ id: "c1", name: "Club A Coach" }]);
  await loadCoaches(handlers());
  assert.equal(state.coaches.rows[0].id, "c1");

  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ coaches: [{ id: "c9", name: "Club B Coach" }] }) });
  const h = handlers();
  await loadCoaches(h);
  assert.equal(h.loadingCalls.length, 1, "a genuinely new workspace context must be treated as a first entry, never served club A's cache");
  assert.equal(state.coaches.rows[0].id, "c9");
});

test("6. a failed background refresh keeps the last-known-good coach list on screen, never blanks it or shows loading again", async () => {
  resetState();
  mockFetchOnce([{ id: "c1", name: "Coach One" }]);
  await loadCoaches(handlers());
  const entry = getCacheEntry("coaches", "coach-1|private_coach|");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const h = handlers();
  await loadCoaches(h);
  assert.equal(h.loadingCalls.length, 0, "a background refresh failure must never show the loading screen over good data");
  assert.equal(h.renderCalls.length, 1, "only the still-good cached data was rendered - the failed refresh never got to call renderCoaches again");
  assert.equal(state.coaches.rows.length, 1, "the last-known-good rows must survive the failed background refresh untouched");
  assert.equal(state.coaches.error, "", "a background failure must not flip the view into its first-load error state");
});

test("7. a genuine in-flight race: a late response for the OLD workspace must never overwrite state after the user has already switched to a NEW workspace", async () => {
  resetState({ id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-A" } });
  let resolveOld;
  const oldFetchPromise = new Promise((resolve) => { resolveOld = resolve; });
  globalThis.fetch = async () => oldFetchPromise.then((coaches) => ({ ok: true, status: 200, json: async () => ({ coaches }) }));
  const pending = loadCoaches(handlers());

  // The workspace switch happens WHILE the club-A request is still in flight
  // - onWorkspaceChanged's own forceRefresh:true call is simulated here by
  // firing a second, independent loadCoaches() for the new workspace before
  // the first one has resolved.
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-B" } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ coaches: [{ id: "c9", name: "Club B Coach" }] }) });
  const hB = handlers();
  await loadCoaches(hB);
  assert.equal(state.coaches.rows[0].id, "c9", "club B's own request must win first since it's the one the user is actually looking at");

  // Now the slow club-A response finally arrives, long after the switch.
  resolveOld([{ id: "c1", name: "Club A Coach" }]);
  await pending;
  assert.equal(state.coaches.rows[0].id, "c9", "the late club-A response must never overwrite club B's state, even though it resolved last");
  assert.equal(state.coaches.rows.length, 1);
});

test("8. saving the account's own coach profile forces a real refetch even though the directory was already cached and fresh", async () => {
  resetState();
  mockFetchOnce([{ id: "c1", name: "Old Headline" }]);
  await loadCoaches(handlers());

  let fetchCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls += 1;
    if (options.method === "PATCH") return { ok: true, status: 200, json: async () => ({ profile: {} }) };
    return { ok: true, status: 200, json: async () => ({ coaches: [{ id: "c1", name: "New Headline" }] }) };
  };
  const form = {
    querySelector: () => null,
    dataset: {},
  };
  const formDataEntries = new Map([["headline", "New Headline"]]);
  globalThis.FormData = class {
    constructor() {}
    get(key) { return formDataEntries.get(key) ?? ""; }
  };
  const h = handlers();
  await submitCoachProfileForm(form, { loadCoaches: (opts) => loadCoaches({ ...h, ...opts }) });
  assert.equal(fetchCalls, 2, "PATCH + a forced refetch, never satisfied from the pre-edit cache");
  assert.equal(state.coaches.rows[0].name, "New Headline");
});
