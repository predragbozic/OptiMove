import { test } from "node:test";
import assert from "node:assert/strict";

// UX correction round: the two bulk TURN-OFF actions (builder-bulk-turn-
// off-before-after, builder-bulk-turn-off-all-rpe) now require an
// explicit window.confirm() before firing - Apply is unchanged (it can
// turn things ON just as easily as off, depending on the plan's own
// current defaults, so it never asks). This file only exercises the
// ACTION layer (handleBuilderWorkspaceAction) - the render layer's own
// conditional visibility is covered separately in
// builder-training-load-settings-panel.test.mjs. Same stub/mock/handler
// shape as builder-session-tracking-toggle-actions.test.mjs.
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = { confirm: () => true };

const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { state } = await import("../state.js");

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || "GET", body });
    const next = queue.shift();
    const status = next?.status ?? 200;
    const responseBody = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => responseBody };
  };
  return calls;
}

function fakeAction(dataset) {
  return { dataset, disabled: false };
}

function makeDraft() {
  return {
    plan: { id: "plan-1", status: "draft" },
    batch: null,
    blocks: [{ id: "block-1", index: 1, name: "", date: "", note: "", sessions: [] }],
  };
}

let renderCalls;
function handlers() {
  renderCalls = 0;
  return { renderBuilder: () => { renderCalls += 1; } };
}

function withConfirm(returnValue, fn) {
  const original = globalThis.window.confirm;
  let called = false;
  globalThis.window.confirm = (...args) => { called = true; return typeof returnValue === "function" ? returnValue(...args) : returnValue; };
  return Promise.resolve(fn()).finally(() => {
    globalThis.window.confirm = original;
  }).then((result) => ({ result, called }));
}

test("1. Apply (builder-bulk-apply-training-sessions) sends its request immediately, with no confirm step at all", async () => {
  state.builder = { draft: makeDraft() };
  const calls = installFetchMock([{ status: 200, body: makeDraft() }]);
  let confirmCalled = false;
  const original = globalThis.window.confirm;
  globalThis.window.confirm = () => { confirmCalled = true; return true; };
  try {
    const result = await handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-apply-training-sessions" }), handlers());
    assert.equal(result, true);
    assert.equal(confirmCalled, false, "Apply must never ask for confirmation");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/api\/builder\/plans\/plan-1\/training-load-settings\/apply-to-training-sessions$/);
    assert.equal(renderCalls, 1);
  } finally {
    globalThis.window.confirm = original;
  }
});

test("2. Exclude Before/After (builder-bulk-turn-off-before-after) asks for confirmation, and sends nothing if the coach cancels", async () => {
  state.builder = { draft: makeDraft() };
  const calls = installFetchMock([]);
  const { result, called } = await withConfirm(false, () =>
    handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-before-after" }), handlers()));
  assert.equal(result, true, "a cancelled confirm is still a handled, no-op action - never falls through unhandled");
  assert.equal(called, true);
  assert.equal(calls.length, 0, "cancelling the confirm must send zero requests");
});

test("3. Exclude Before/After sends the EXACT SAME request as before (POST, no body) once confirmed - the confirm step changes nothing about the request itself", async () => {
  state.builder = { draft: makeDraft() };
  const calls = installFetchMock([{ status: 200, body: makeDraft() }]);
  const { called } = await withConfirm(true, () =>
    handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-before-after" }), handlers()));
  assert.equal(called, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/api\/builder\/plans\/plan-1\/training-load-settings\/turn-off-before-after$/);
  assert.equal(calls[0].body, null, "no request body - unchanged from before this round");
  assert.equal(renderCalls, 1);
});

test("4. Exclude Before/After's confirm message explains that already-collected results are NOT deleted", async () => {
  state.builder = { draft: makeDraft() };
  installFetchMock([{ status: 200, body: makeDraft() }]);
  let confirmMessage = "";
  const original = globalThis.window.confirm;
  globalThis.window.confirm = (message) => { confirmMessage = message; return true; };
  try {
    await handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-before-after" }), handlers());
  } finally {
    globalThis.window.confirm = original;
  }
  assert.match(confirmMessage, /results already collected stay saved and visible/i);
});

test("5. Turn off RPE for all (builder-bulk-turn-off-all-rpe) asks for confirmation, and sends nothing if the coach cancels", async () => {
  state.builder = { draft: makeDraft() };
  const calls = installFetchMock([]);
  const { result, called } = await withConfirm(false, () =>
    handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-all-rpe" }), handlers()));
  assert.equal(result, true);
  assert.equal(called, true);
  assert.equal(calls.length, 0);
});

test("6. Turn off RPE for all sends the EXACT SAME request as before (POST, no body) once confirmed", async () => {
  state.builder = { draft: makeDraft() };
  const calls = installFetchMock([{ status: 200, body: makeDraft() }]);
  const { called } = await withConfirm(true, () =>
    handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-all-rpe" }), handlers()));
  assert.equal(called, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/api\/builder\/plans\/plan-1\/training-load-settings\/turn-off-all-rpe$/);
  assert.equal(calls[0].body, null);
  assert.equal(renderCalls, 1);
});

test("7. Turn off RPE for all's confirm message also explains that already-collected results are NOT deleted", async () => {
  state.builder = { draft: makeDraft() };
  installFetchMock([{ status: 200, body: makeDraft() }]);
  let confirmMessage = "";
  const original = globalThis.window.confirm;
  globalThis.window.confirm = (message) => { confirmMessage = message; return true; };
  try {
    await handleBuilderWorkspaceAction(fakeAction({ action: "builder-bulk-turn-off-all-rpe" }), handlers());
  } finally {
    globalThis.window.confirm = original;
  }
  assert.match(confirmMessage, /results already collected stay saved and visible/i);
});

test("8. an unknown planId (no open draft) is a safe no-op for every one of the three actions - no request, no confirm", async () => {
  state.builder = { draft: null };
  const calls = installFetchMock([]);
  for (const action of ["builder-bulk-apply-training-sessions", "builder-bulk-turn-off-before-after", "builder-bulk-turn-off-all-rpe"]) {
    let confirmCalled = false;
    const original = globalThis.window.confirm;
    globalThis.window.confirm = () => { confirmCalled = true; return true; };
    try {
      const result = await handleBuilderWorkspaceAction(fakeAction({ action }), handlers());
      assert.equal(result, true);
      assert.equal(confirmCalled, false, `${action}: must never ask for confirmation with no open draft`);
    } finally {
      globalThis.window.confirm = original;
    }
  }
  assert.equal(calls.length, 0);
});
