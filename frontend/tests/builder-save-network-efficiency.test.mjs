import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Builder performance/UX fixes:
// 1. opening an existing program for editing (POST /plans/:id/edit) sends
//    exactly one request - no duplicate fetch of the same plan.
// 2. Save (builder-submit-plan) shows a "Saving…" state immediately (before
//    the request resolves) and never fires a second, parallel submit if
//    clicked again while the first is still in flight.
// 3. a failed save never looks like a success (no navigation away, no
//    "Saved" state) and never loses the coach's in-memory draft - it stays
//    exactly as it was before the attempt, with the button restored so a
//    retry is immediately available.
// 4. deleting a block/session/node/item reuses the DELETE response's
//    already-fresh draft instead of discarding it and firing a second GET
//    for the exact same plan.

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
globalThis.window = { confirm: () => true };

const { handleBuilderPlanAction, handleBuilderDraftAction, handleBuilderItemAction } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");

const originalFetch = globalThis.fetch;

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    const next = queue.shift();
    if (next?.throwNetworkError) throw new TypeError("Failed to fetch");
    const status = next?.status ?? 200;
    const body = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
  };
  return calls;
}

// A fetch mock whose single response only resolves once the test explicitly
// releases it - lets a test inspect UI state WHILE the request is still in
// flight (e.g. the "Saving…" label must appear before the response lands).
function installHeldFetchMock() {
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    const body = await held;
    return { ok: true, status: 200, statusText: "", json: async () => body };
  };
  return { calls, release: (body = {}) => release(body) };
}

function fakeAction(dataset, { disabled = false, textContent = "" } = {}) {
  return { dataset, disabled, textContent };
}

function makeDraft(planId = "plan-1", overrides = {}) {
  return { plan: { id: planId, status: "draft", ...overrides }, batch: null, blocks: [{ id: "block-1", sessions: [] }] };
}

function noopHandlers(overrides = {}) {
  return {
    renderBuilder: () => {},
    renderBuilderSectionItems: () => false,
    renderBuilderError: () => {},
    renderTabs: () => {},
    renderLibraryNav: () => {},
    loadBuilderExercises: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  state.builder = emptyBuilderState();
  globalThis.fetch = originalFetch;
});

test("1. opening an existing program for editing sends exactly one request", async () => {
  // loadBuilderNodePresets() (a separate, already-cached-after-first-use
  // endpoint, unrelated to this fix) is fired without awaiting as part of
  // this same action - pre-seed its cache so this test isolates exactly
  // what it's checking: that opening THIS plan doesn't fetch it twice, not
  // whatever node-presets prefetch already exists independently of this fix.
  state.builder.nodePresets = [{ id: "preset-1" }];
  const calls = installFetchMock([{ status: 200, body: makeDraft("plan-1") }]);
  const action = fakeAction({ action: "builder-edit-plan", planId: "plan-1" });

  const handled = await handleBuilderPlanAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 1, "opening a program for editing must fire exactly one request, not a fetch-then-refetch");
  assert.equal(calls[0].url, "/api/builder/plans/plan-1/edit");
  assert.equal(calls[0].method, "POST");
});

test("2. Save shows a 'Saving…' state immediately, before the request resolves", async () => {
  state.builder.draft = makeDraft();
  const { release } = installHeldFetchMock();
  const action = fakeAction({ action: "builder-submit-plan" }, { textContent: "Save and finish" });

  const pending = handleBuilderDraftAction(action, noopHandlers());
  await Promise.resolve(); // let the synchronous part of the handler run before the fetch settles
  assert.equal(action.disabled, true, "the button must be disabled the instant Save is clicked, not after the response lands");
  assert.equal(action.textContent, "Saving…", "the coach must see immediate feedback that a save is in progress");

  release(makeDraft());
  await pending;
});

test("3. a second Save click while the first request is genuinely still unresolved does not send a second request", async () => {
  state.builder.draft = makeDraft();
  const { calls, release } = installHeldFetchMock();
  const action = fakeAction({ action: "builder-submit-plan" }, { textContent: "Save and finish" });

  // Fire the first click and let it run up to (and including) the fetch
  // call, WITHOUT awaiting it - the mock's single fetch is now genuinely
  // pending (it won't resolve until release() below), a real concurrent
  // situation, not one call finishing before the next starts.
  const firstCall = handleBuilderDraftAction(action, noopHandlers());
  await Promise.resolve();
  assert.equal(action.disabled, true, "the button must already be disabled before the second click can even be dispatched");
  assert.equal(calls.length, 1, "the first click must have already reached the fetch call");

  // The second click happens WHILE the first request is still in flight -
  // a real <button disabled> physically cannot dispatch this, but the
  // handler itself must also refuse it, not rely solely on the DOM.
  const secondCall = handleBuilderDraftAction(action, noopHandlers());
  const handledAgain = await secondCall;
  assert.equal(handledAgain, true, "the action type is still recognized (so no unrelated fallback path runs)");
  assert.equal(calls.length, 1, "a click while the first request is still genuinely unresolved must never fire a second, parallel submit");

  release(makeDraft());
  await firstCall;
});

test("4. a failed save leaves the in-memory draft completely untouched, shows an error, and restores the button for a retry", async () => {
  const originalDraft = makeDraft("plan-1", { name: "My Program" });
  originalDraft.blocks[0].sessions.push({ id: "session-unsaved-local-edit" }); // stand-in for an in-progress local edit
  state.builder.draft = originalDraft;
  installFetchMock([{ status: 500, body: { error: "Server error" } }]);
  let errorSeen = null;
  let renderedAfterFailure = false;
  const action = fakeAction({ action: "builder-submit-plan" }, { textContent: "Save and finish" });

  await handleBuilderDraftAction(action, noopHandlers({
    renderBuilderError: (error) => { errorSeen = error; },
    renderBuilder: () => { renderedAfterFailure = true; },
  }));

  assert.ok(errorSeen, "a failed save must surface an error, not silently do nothing");
  assert.equal(state.builder.draft, originalDraft, "the exact same in-memory draft object must survive a failed save - no local edits lost, nothing replaced with a partial/empty response");
  assert.equal(state.builder.draft.blocks[0].sessions[0].id, "session-unsaved-local-edit", "the local edit that hadn't been confirmed saved yet must still be there");
  assert.equal(action.disabled, false, "the button must be usable again for a retry");
  assert.equal(action.textContent, "Save and finish", "the button label must be restored, not left stuck on 'Saving…'");
  // A failed save must not act like a success: no full-page render/navigation was forced by the failure path itself.
  assert.equal(renderedAfterFailure, false, "a failed save must not trigger the same re-render a successful one does - that would read as the save having gone through");
});

test("5. deleting a node reuses the DELETE response's fresh draft instead of firing a second GET for the same plan", async () => {
  state.builder.draft = makeDraft();
  const freshDraftAfterDelete = makeDraft("plan-1", { name: "Updated after delete" });
  const calls = installFetchMock([{ status: 200, body: freshDraftAfterDelete }]);
  const action = fakeAction({ action: "builder-delete-node", nodeId: "node-1" });

  const handled = await handleBuilderDraftAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 1, "deleting a node must not fetch the plan a second time when the DELETE response already carries the fresh draft");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(state.builder.draft.plan.name, "Updated after delete", "the DELETE response's draft must actually be the one applied");
});

test("6. deleting an item reuses the DELETE response's fresh draft instead of firing a second GET for the same plan", async () => {
  state.builder.draft = makeDraft();
  const freshDraftAfterDelete = makeDraft("plan-1", { name: "Updated after item delete" });
  const calls = installFetchMock([{ status: 200, body: freshDraftAfterDelete }]);
  const action = fakeAction({ action: "builder-delete-item", itemId: "item-1" });

  const handled = await handleBuilderItemAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 1, "deleting an item must not fetch the plan a second time when the DELETE response already carries the fresh draft");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(state.builder.draft.plan.name, "Updated after item delete");
});
