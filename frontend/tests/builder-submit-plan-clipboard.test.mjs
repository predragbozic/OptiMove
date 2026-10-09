import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Regression coverage for the "Source node or target session not found"
// bug report: applying an edit draft (Finish on an already-published plan)
// deletes that draft's entire day/session/node tree server-side and
// recreates it under the original plan with brand-new ids
// (applyEditDraft, backend/src/routes/builder.js) - a node/section still
// sitting in the clipboard from before that Finish points at rows that no
// longer exist. Saving exits Builder, so the clipboard must be cleared
// for both edit drafts and new plans before another Builder is opened.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", textContent: "", disabled: false, querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { handleBuilderDraftAction } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");

const originalFetch = globalThis.fetch;

function installFetchMock(responseFor) {
  globalThis.fetch = async (url, options = {}) => {
    const status = 200;
    const body = responseFor(url, options.method || "GET");
    return { ok: true, status, statusText: "", json: async () => body };
  };
}

function noopHandlers() {
  return { renderBuilder: () => {}, renderBuilderError: () => {}, renderTabs: () => {}, renderLibraryNav: () => {}, loadWeekly: async () => {} };
}

function fakeAction() {
  return { dataset: { action: "builder-submit-plan" }, disabled: false, innerHTML: "<svg></svg>" };
}

function draftWith(overrides = {}) {
  return {
    plan: { id: "plan-1", planType: "weekly", status: "draft", isEditDraft: false, ...overrides.plan },
    blocks: [{ id: "block-1", sessions: [] }],
    batch: null,
  };
}

beforeEach(() => {
  state.builder = emptyBuilderState();
  fakeElements.clear();
  globalThis.fetch = originalFetch;
});

test("finishing an EDIT DRAFT clears the clipboard - its node/section ids no longer exist after applyEditDraft regenerates the whole tree", async () => {
  state.builder.draft = draftWith({ plan: { id: "editdraft-1", isEditDraft: true } });
  state.builder.clipboard = { type: "section", nodeId: "stale-section-1", name: "Warmup" };
  installFetchMock((url) => {
    assert.equal(url, "/api/builder/plans/editdraft-1/submit");
    return draftWith({ plan: { id: "original-1", isEditDraft: false } });
  });

  await handleBuilderDraftAction(fakeAction(), noopHandlers());

  assert.equal(state.builder.clipboard, null);
});

test("saving a new plan exits Builder and clears its clipboard", async () => {
  state.builder.draft = draftWith({ plan: { id: "plan-1", isEditDraft: false } });
  state.builder.clipboard = { type: "section", nodeId: "section-1", name: "Warmup" };
  installFetchMock((url) => {
    assert.equal(url, "/api/builder/plans/plan-1/submit");
    return draftWith({ plan: { id: "plan-1", status: "active", isEditDraft: false } });
  });

  await handleBuilderDraftAction(fakeAction(), noopHandlers());

  assert.equal(state.builder.clipboard, null);
  assert.equal(state.builder.draft, null);
  assert.equal(state.activeTab, "weekly");
});
