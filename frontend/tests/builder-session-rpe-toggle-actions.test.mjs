import { test } from "node:test";
import assert from "node:assert/strict";

// Per-session RPE opt-out (Builder side) action handler:
// builder-toggle-session-rpe. builder-actions.js's own import chain
// touches `document` at module scope, so a minimal stub is installed
// before the dynamic import (same pattern as builder-day-copy-paste-
// actions.test.mjs elsewhere in this suite).
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

function makeDraft(session) {
  return {
    plan: { id: "plan-1", status: "active" },
    batch: null,
    blocks: [{ id: "block-1", index: 1, name: "", date: "", note: "", sessions: [{ id: "session-1", amPm: "AM", bta: "T", time: "", rpeEnabled: true, nodes: [], ...session }] }],
  };
}

let renderCalls;
function handlers() {
  renderCalls = 0;
  return { renderBuilder: () => { renderCalls += 1; } };
}

test("1. toggling ON->OFF sends rpeEnabled: false to PATCH /sessions/:id and updates the draft from the response", async () => {
  state.builder = { draft: makeDraft({ rpeEnabled: true }) };
  const updatedDraft = makeDraft({ rpeEnabled: false });
  const calls = installFetchMock([{ status: 200, body: updatedDraft }]);
  const h = handlers();

  const result = await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-rpe", sessionId: "session-1" }), h);

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /\/api\/builder\/sessions\/session-1$/);
  assert.equal(calls[0].body.rpeEnabled, false);
  assert.equal(state.builder.draft.blocks[0].sessions[0].rpeEnabled, false);
  assert.equal(renderCalls, 1);
});

test("2. toggling OFF->ON sends rpeEnabled: true", async () => {
  state.builder = { draft: makeDraft({ rpeEnabled: false }) };
  const calls = installFetchMock([{ status: 200, body: makeDraft({ rpeEnabled: true }) }]);
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-rpe", sessionId: "session-1" }), handlers());
  assert.equal(calls[0].body.rpeEnabled, true);
});

test("3. an unknown sessionId (not found in the current draft) is a safe no-op - no request sent", async () => {
  state.builder = { draft: makeDraft({ rpeEnabled: true }) };
  const calls = installFetchMock([]);
  const result = await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-rpe", sessionId: "does-not-exist" }), handlers());
  assert.equal(result, true);
  assert.equal(calls.length, 0);
});
