import { test } from "node:test";
import assert from "node:assert/strict";

// Training Activity Integration 2A (Builder side): builder-toggle-session-
// tracking. Mirrors builder-session-rpe-toggle-actions.test.mjs's own
// conventions exactly - same stub/mock/handler shape, one file over
// because this is a genuinely separate action.
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
    blocks: [{ id: "block-1", index: 1, name: "", date: "", note: "", sessions: [{ id: "session-1", amPm: "AM", bta: "T", time: "", rpeEnabled: false, trackingEnabled: false, nodes: [], ...session }] }],
  };
}

let renderCalls;
function handlers() {
  renderCalls = 0;
  return { renderBuilder: () => { renderCalls += 1; } };
}

test("1. toggling tracking OFF->ON sends only trackingEnabled: true - rpeEnabled is left for a separate, explicit request", async () => {
  state.builder = { draft: makeDraft({ trackingEnabled: false, rpeEnabled: false }) };
  const calls = installFetchMock([{ status: 200, body: makeDraft({ trackingEnabled: true, rpeEnabled: false }) }]);
  const h = handlers();

  const result = await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-tracking", sessionId: "session-1" }), h);

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /\/api\/builder\/sessions\/session-1$/);
  assert.equal(calls[0].body.trackingEnabled, true);
  assert.equal("rpeEnabled" in calls[0].body, false, "turning tracking ON must never also silently turn RPE on");
  assert.equal(state.builder.draft.blocks[0].sessions[0].trackingEnabled, true);
  assert.equal(renderCalls, 1);
});

test("2. toggling tracking ON->OFF sends BOTH trackingEnabled: false AND rpeEnabled: false in the same request - the client-side cascade", async () => {
  state.builder = { draft: makeDraft({ trackingEnabled: true, rpeEnabled: true }) };
  const calls = installFetchMock([{ status: 200, body: makeDraft({ trackingEnabled: false, rpeEnabled: false }) }]);
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-tracking", sessionId: "session-1" }), handlers());
  assert.equal(calls[0].body.trackingEnabled, false);
  assert.equal(calls[0].body.rpeEnabled, false, "turning tracking OFF must cascade RPE off in the SAME request");
  assert.equal(state.builder.draft.blocks[0].sessions[0].rpeEnabled, false);
});

test("3. an unknown sessionId (not found in the current draft) is a safe no-op - no request sent", async () => {
  state.builder = { draft: makeDraft({ trackingEnabled: true }) };
  const calls = installFetchMock([]);
  const result = await handleBuilderWorkspaceAction(fakeAction({ action: "builder-toggle-session-tracking", sessionId: "does-not-exist" }), handlers());
  assert.equal(result, true);
  assert.equal(calls.length, 0);
});
