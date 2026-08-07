import { after, test } from "node:test";
import assert from "node:assert/strict";

// perf/main-navigation-cache: loadTemplates() (program-library-data.js) must
// render instantly from cache on re-entry to the same scope, only fetch a
// scope it hasn't cached (or that's gone stale), and never mix scopes -
// switching between My Programs/OptiMove/Marketplace must never show one
// scope's list under another's label. A minimal flat document/element stub
// (same convention as the rest of this suite) is enough since
// program-library-data.js never reaches for a real DOM tree.

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

const { loadTemplates } = await import("../program-library-data.js");
const { state } = await import("../state.js");
const { clearAllViewCache, VIEW_CACHE_FRESHNESS_MS, getCacheEntry } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

function resetState(user = { id: "u1", role: "coach", activeWorkspace: { type: "private_coach", scopeId: null } }) {
  clearAllViewCache();
  state.currentUser = user;
  state.navStack = [];
  state.templateScope = "my_programs";
  state.templateAllowedScopes = ["my_programs", "optimove", "marketplace"];
  state.templateFilters = { search: "", category: "", tag: "", creator: "", club: "", ownerType: "", visibility: "", lifecycle: "", pricing: "all" };
  state.templateOptions = { categories: [], tags: [], creators: [], clubs: [], loaded: true };
  state.lastTemplates = [];
  state.selectedTemplateId = null;
  state.programLibrarySection = "programs";
}

function handlers() {
  const renderCalls = [];
  const loadingCalls = [];
  const errorCalls = [];
  return {
    renderError: (error) => errorCalls.push(error),
    renderTemplateLibrary: (templates) => renderCalls.push(templates),
    renderTemplateLibraryResults: () => {},
    restoreTemplateFilterFocus: () => {},
    setStatus: () => {},
    setLoading: (text) => loadingCalls.push(text),
    renderCalls,
    loadingCalls,
    errorCalls,
  };
}

function mockFetchByScope(templatesByScope) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const scope = new URL(url, "http://x").searchParams.get("scope");
    return { ok: true, status: 200, json: async () => ({ templates: templatesByScope[scope] || [], allowedScopes: ["my_programs", "optimove", "marketplace"] }) };
  };
  return calls;
}

test("1. a genuine first entry fetches the requested scope once and shows loading", async () => {
  resetState();
  const calls = mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Program One" }] });
  const h = handlers();
  await loadTemplates(h);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("scope=my_programs"));
  assert.equal(h.loadingCalls.length, 1);
  assert.equal(state.lastTemplates.length, 1);
});

test("2. a repeat entry into the SAME scope with fresh cached data makes no request", async () => {
  resetState();
  const calls = mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Program One" }] });
  await loadTemplates(handlers());
  assert.equal(calls.length, 1);

  const h2 = handlers();
  await loadTemplates(h2);
  assert.equal(calls.length, 1, "the same scope, still fresh, must not trigger a second fetch");
  assert.equal(h2.loadingCalls.length, 0);
  assert.equal(h2.renderCalls.length, 1);
});

test("3. switching scope never returns the previous scope's results, and returning to a previously-seen scope is instant", async () => {
  resetState();
  const calls = mockFetchByScope({
    my_programs: [{ plan_id: "p1", name: "My Program" }],
    optimove: [{ plan_id: "p2", name: "OptiMove Program" }],
  });
  await loadTemplates(handlers());
  assert.deepEqual(state.lastTemplates.map((t) => t.plan_id), ["p1"]);

  state.templateScope = "optimove";
  const h2 = handlers();
  await loadTemplates(h2);
  assert.equal(calls.length, 2, "a genuinely different scope must be fetched");
  assert.deepEqual(state.lastTemplates.map((t) => t.plan_id), ["p2"], "switching scope must never show the previous scope's programs under the new label");

  state.templateScope = "my_programs";
  const h3 = handlers();
  await loadTemplates(h3);
  assert.equal(calls.length, 2, "returning to a scope already cached and fresh must be instant, no new request");
  assert.equal(h3.loadingCalls.length, 0);
  assert.deepEqual(state.lastTemplates.map((t) => t.plan_id), ["p1"]);
});

test("4. once stale, re-entry into the same scope renders the cached list first, then refreshes in the background", async () => {
  resetState();
  mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Program One" }] });
  await loadTemplates(handlers());
  const entry = getCacheEntry("templates", "u1|private_coach||my_programs");
  assert.ok(entry, "the templates cache entry must exist under the expected context key");
  entry.loadedAt = Date.now() - (VIEW_CACHE_FRESHNESS_MS + 5000);

  mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Program One" }, { plan_id: "p2", name: "Program Two" }] });
  const h = handlers();
  await loadTemplates(h);
  assert.equal(h.loadingCalls.length, 0, "a stale-but-present cache must never show the loading screen again");
  assert.equal(h.renderCalls.length, 2);
  assert.equal(state.lastTemplates.length, 2);
});

test("5. options.forceRefresh always bypasses the cache, even when fresh (post-mutation reload)", async () => {
  resetState();
  const calls = mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Old Name" }] });
  await loadTemplates(handlers());
  assert.equal(calls.length, 1);

  mockFetchByScope({ my_programs: [{ plan_id: "p1", name: "Renamed" }] });
  const h = handlers();
  await loadTemplates(h, { forceRefresh: true });
  assert.equal(state.lastTemplates[0].name, "Renamed", "a forced refresh must never be satisfied from the pre-mutation cache");
});
