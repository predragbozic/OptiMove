import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// perf/main-navigation-cache Builder decision (see the comment on
// loadBuilder() in app.js): a draft already open in state.builder.draft is
// NEVER re-fetched/overwritten on mere tab re-entry - every structural/
// content edit already autosaves via queuedBuilderApi/setBuilderDraft (see
// builder-actions.js), so the local copy is already the freshest known-good
// state, and a background refetch here could only ever race an in-flight
// autosave and revert a just-made edit. Only the drafts LIST (the empty-
// state picker shown when nothing is open) is folded into the generic view
// cache - loadBuilderDrafts() is a real, standalone, already-exported
// function, tested directly here; loadBuilder() itself lives in app.js
// (runs init() at import time) and is covered by the source-pattern guards
// below, same convention as organization-panel-cache.test.mjs.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

const { loadBuilderDrafts } = await import("../builder-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache, getCacheEntry, VIEW_CACHE_FRESHNESS_MS } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "u1" };
  state.builder = { ...state.builder, draft: null, drafts: [], draftsLoading: false };
}

function mockFetchOnce(drafts) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ drafts }) };
  };
  return () => calls;
}

test("1. a genuine first entry into the drafts picker fetches once and sets draftsLoading around it", async () => {
  resetState();
  const callCount = mockFetchOnce([{ groupKey: "g1", name: "Draft One" }]);
  await loadBuilderDrafts();
  assert.equal(callCount(), 1);
  assert.equal(state.builder.draftsLoading, false, "must be false again once the load settles");
  assert.equal(state.builder.drafts.length, 1);
});

test("2. a repeat entry with fresh cached drafts makes no request", async () => {
  resetState();
  const callCount = mockFetchOnce([{ groupKey: "g1", name: "Draft One" }]);
  await loadBuilderDrafts();
  assert.equal(callCount(), 1);

  await loadBuilderDrafts();
  assert.equal(callCount(), 1, "a second entry with fresh cached data must not trigger another fetch");
});

test("3. loadBuilderDrafts is a no-op while a draft is already open, regardless of cache state", async () => {
  resetState();
  state.builder.draft = { plan: { id: "p1" } };
  const callCount = mockFetchOnce([{ groupKey: "g1", name: "Draft One" }]);
  await loadBuilderDrafts();
  assert.equal(callCount(), 0, "must never fetch the drafts list while a specific draft is open");
});

test("4. { forceRefresh: true } (used after create/delete/submit) always bypasses the cache", async () => {
  resetState();
  mockFetchOnce([{ groupKey: "g1", name: "Old" }]);
  await loadBuilderDrafts();
  assert.equal(state.builder.drafts[0].name, "Old");

  mockFetchOnce([{ groupKey: "g2", name: "New" }]);
  await loadBuilderDrafts({ forceRefresh: true });
  assert.equal(state.builder.drafts[0].name, "New", "a forced refresh must never be satisfied from the pre-mutation cache");
});

test("5. once stale, the cached drafts list is applied first, then refreshed in the background", async () => {
  resetState();
  mockFetchOnce([{ groupKey: "g1", name: "Draft One" }]);
  await loadBuilderDrafts();
  const entry = getCacheEntry("builderDrafts", "u1");
  assert.ok(entry, "the builderDrafts cache entry must exist under the expected user-only context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchOnce([{ groupKey: "g1", name: "Draft One" }, { groupKey: "g2", name: "Draft Two" }]);
  await loadBuilderDrafts();
  assert.equal(state.builder.drafts.length, 2);
});

test("6. a failed first load propagates the error (matches the pre-cache contract - the caller's own .catch(renderBuilderError) handles it)", async () => {
  resetState();
  globalThis.fetch = async () => { throw new Error("network down"); };
  await assert.rejects(() => loadBuilderDrafts(), /network down/);
  assert.equal(state.builder.draftsLoading, false, "the loading flag must still be cleared even on failure");
});

// --- source-pattern guards for app.js/builder-actions.js glue ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsSource = await readFile(path.resolve(__dirname, "../app.js"), "utf8");
const builderActionsSource = await readFile(path.resolve(__dirname, "../builder-actions.js"), "utf8");

test("7. loadBuilder() in app.js never re-fetches/overwrites an already-open draft on mere re-entry", () => {
  const start = appJsSource.indexOf("async function loadBuilder()");
  assert.ok(start >= 0, "loadBuilder must still exist in app.js");
  const end = appJsSource.indexOf("\nfunction renderCopyPlanSource", start);
  const body = appJsSource.slice(start, end >= 0 ? end : start + 1500);
  assert.ok(!/api\(`\/api\/builder\/plans\/\$\{encodeURIComponent\(state\.builder\.draft/.test(body), "must never re-GET the currently-open draft's own plan just because the tab was re-entered");
  assert.ok(!/state\.builder\.draft\s*=\s*data/.test(body), "must never blindly overwrite state.builder.draft with a fresh GET's response on re-entry");
  assert.ok(body.includes("renderBuilder()"), "an already-open draft must still be re-rendered from whatever's already in memory");
});

test("8. draft-list-membership mutations (create/delete/submit) still invalidate the cached drafts list", () => {
  assert.ok(builderActionsSource.includes("invalidateBuilderDraftsCache"), "builder-actions.js must import/use invalidateBuilderDraftsCache");
  const createIndex = builderActionsSource.indexOf('await api("/api/builder/plans", { method: "POST"');
  assert.ok(createIndex >= 0);
  assert.ok(builderActionsSource.slice(createIndex, createIndex + 500).includes("invalidateBuilderDraftsCache()"), "creating a new draft must invalidate the cached drafts list");
  const submitIndex = builderActionsSource.indexOf("/submit`");
  assert.ok(submitIndex >= 0);
  assert.ok(builderActionsSource.slice(submitIndex, submitIndex + 500).includes("invalidateBuilderDraftsCache()"), "submitting a draft (it leaves 'draft' status) must invalidate the cached drafts list");
});
