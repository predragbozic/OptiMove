import { after, test } from "node:test";
import assert from "node:assert/strict";

// Pre-merge audit finding: markTemplateUsed and the access-request approve/
// reject/revoke handlers both replace state.lastTemplates with a NEW array
// via .map() (see updateTemplateAccess/patchTemplatePendingRequestCount in
// program-library-actions.js), which breaks the reference aliasing that
// otherwise keeps the templates view-cache entry (whose data.templates
// still points at the OLD array) implicitly in sync with in-place edits
// like updateProgramTagsInCache's `template.tags = tags`. Without an
// explicit invalidateTemplatesCache() call, a same-TTL re-entry into
// Program Library would silently revert these mutations back to their
// pre-mutation values. These tests prove the fix: the cache entry for the
// current scope is gone (so the next entry, even within the freshness
// window, is forced to re-fetch) immediately after either mutation.

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
const { handleTemplateLibraryAction, markTemplateUsed } = await import("../program-library-actions.js");
const { emptyTemplatePreview, state } = await import("../state.js");
const { clearAllViewCache, getCacheEntry, hasCachedData } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

const CONTEXT_KEY = "u1|private_coach||my_programs";

function resetState(user = { id: "u1", role: "athlete", accessScope: "athlete", activeWorkspace: { type: "private_coach", scopeId: null } }) {
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
  state.templatePreview = emptyTemplatePreview();
}

function handlers() {
  return {
    renderError: () => {},
    renderTemplateLibrary: () => {},
    renderTemplateLibraryResults: () => {},
    restoreTemplateFilterFocus: () => {},
    setStatus: () => {},
    setLoading: () => {},
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("markTemplateUsed invalidates the templates cache so a same-TTL re-entry can never revert the access-status change", async () => {
  resetState();
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/templates?")) {
      return { ok: true, status: 200, json: async () => ({ templates: [{ plan_id: "p1", name: "Program" }], allowedScopes: ["my_programs"] }) };
    }
    if (String(url).includes("/use")) {
      return { ok: true, status: 200, json: async () => ({ access: { status: "used" } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await loadTemplates(handlers());
  assert.ok(hasCachedData(getCacheEntry("templates", CONTEXT_KEY)), "sanity check: the cache entry must exist after the first load");

  await markTemplateUsed("p1", { renderTemplateLibrary: () => {} });
  assert.equal(
    hasCachedData(getCacheEntry("templates", CONTEXT_KEY)),
    false,
    "marking a program as used must invalidate the templates cache entry - otherwise a re-entry within the freshness window would show the pre-mark-as-used access status again",
  );
});

test("approving a program access request invalidates the templates cache so a same-TTL re-entry can never revert the pending-count patch", async () => {
  resetState({ id: "u1", role: "coach", accessScope: "coach", activeWorkspace: { type: "private_coach", scopeId: null } });
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/api/templates?")) {
      return { ok: true, status: 200, json: async () => ({ templates: [{ plan_id: "p1", name: "Program", pending_access_count: 1 }], allowedScopes: ["my_programs"] }) };
    }
    if (requestUrl.includes("/program-access/") && options.method === "POST") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (requestUrl.includes("/access-requests")) {
      return { ok: true, status: 200, json: async () => ({ requests: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await loadTemplates(handlers());
  assert.ok(hasCachedData(getCacheEntry("templates", CONTEXT_KEY)));

  state.selectedTemplateId = "p1";
  const action = { dataset: { action: "template-access-approve", accessId: "req1" } };
  handleTemplateLibraryAction(action, { loadTemplates, renderCoachContext: () => {}, renderTemplateLibrary: () => {} });
  await flush();
  await flush();

  assert.equal(
    hasCachedData(getCacheEntry("templates", CONTEXT_KEY)),
    false,
    "approving an access request must invalidate the templates cache entry - otherwise a re-entry within the freshness window would show the stale pending_access_count again",
  );
});
