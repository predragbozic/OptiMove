import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Phase 1 of the Builder day-copy/paste feature: the action-handler side
// (builder-actions.js's handleBuilderWorkspaceAction) and the overwrite
// confirm dialog (builder-modals.js's renderOverwriteDayConfirmHtml).
// builder-actions.js's own import chain touches `document` at module scope
// (same reasoning as builder-save-network-efficiency.test.mjs elsewhere in
// this suite), so a minimal stub is installed before the dynamic import.

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

const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");
const { renderOverwriteDayConfirmHtml } = await import("../builder-modals.js");

const originalFetch = globalThis.fetch;

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

function fakeAction(dataset, { disabled = false } = {}) {
  return { dataset, disabled };
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

test("1. builder-copy-day puts the day in the clipboard with type 'day' and its dayId/name", async () => {
  state.builder.draft = { blocks: [{ id: "day-2", name: "MD-1" }] };
  const action = fakeAction({ action: "builder-copy-day", dayId: "day-2" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.deepEqual(state.builder.clipboard, { type: "day", dayId: "day-2", name: "MD-1" });
});

test("2. builder-copy-day falls back to the day's date when it has no custom label", async () => {
  state.builder.draft = { blocks: [{ id: "day-2", name: "", date: "2026-09-10" }] };
  const action = fakeAction({ action: "builder-copy-day", dayId: "day-2" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.clipboard.name, "2026-09-10");
});

test("3. builder-paste-day on success POSTs to the copy-into endpoint and applies the returned draft", async () => {
  state.builder.clipboard = { type: "day", dayId: "day-1", name: "Monday" };
  const calls = installFetchMock([{ status: 200, body: makeDraft("plan-1", { name: "Updated" }) }]);
  const action = fakeAction({ action: "builder-paste-day", dayId: "day-2" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/days/day-1/copy-into/day-2");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.confirmOverwrite, undefined, "the first attempt must not send confirmOverwrite - that's only for the confirm-dialog retry");
  assert.equal(state.builder.draft.plan.name, "Updated");
});

// "Copy this whole session" (Phase F2's block picker) sets a
// "cross-plan-session" clipboard - unlike day paste, session paste is
// always an append (a day can already hold multiple sessions), so there is
// no self-collision guard and no overwrite-confirm path to test here.

test("3b. builder-paste-session on success POSTs to the session copy-into endpoint and applies the returned draft", async () => {
  state.builder.clipboard = { type: "cross-plan-session", sessionId: "session-1", name: "AM / Training" };
  const calls = installFetchMock([{ status: 200, body: makeDraft("plan-1", { name: "Updated" }) }]);
  const action = fakeAction({ action: "builder-paste-session", dayId: "day-2" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/sessions/session-1/copy-into/day-2");
  assert.equal(calls[0].method, "POST");
  assert.equal(state.builder.draft.plan.name, "Updated");
});

test("3c. builder-paste-session does nothing if the clipboard isn't holding a cross-plan-session", async () => {
  state.builder.clipboard = { type: "day", dayId: "day-1", name: "Monday" };
  const calls = installFetchMock([]);
  const action = fakeAction({ action: "builder-paste-session", dayId: "day-2" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls.length, 0);
});

test("4. builder-paste-day refuses to paste a day onto itself without ever calling the API", async () => {
  state.builder.clipboard = { type: "day", dayId: "day-1", name: "Monday" };
  const calls = installFetchMock([]);
  const action = fakeAction({ action: "builder-paste-day", dayId: "day-1" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls.length, 0);
});

test("5. a 409 from paste opens the overwrite-confirm dialog (state.builder.overwriteDayConfirm) instead of surfacing a plain error", async () => {
  state.builder.clipboard = { type: "day", dayId: "day-1", name: "Monday" };
  installFetchMock([{ status: 409, body: { error: "This day already has content." } }]);
  let errorSeen = false;
  const action = fakeAction({ action: "builder-paste-day", dayId: "day-2" });

  await handleBuilderWorkspaceAction(action, noopHandlers({ renderBuilderError: () => { errorSeen = true; } }));

  assert.deepEqual(state.builder.overwriteDayConfirm, { sourceType: "day", sourceId: "day-1", targetDayId: "day-2" });
  assert.equal(errorSeen, false, "a 409 here is an expected, handled case (needs confirmation) - not a surfaced error");
});

test("6. builder-overwrite-day-cancel clears the pending confirm without any network call", async () => {
  state.builder.overwriteDayConfirm = { sourceType: "day", sourceId: "day-1", targetDayId: "day-2" };
  const calls = installFetchMock([]);
  const action = fakeAction({ action: "builder-overwrite-day-cancel" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.overwriteDayConfirm, null);
  assert.equal(calls.length, 0);
});

test("7. builder-overwrite-day-confirm re-sends the SAME paste with confirmOverwrite: true and clears the pending state", async () => {
  state.builder.overwriteDayConfirm = { sourceType: "day", sourceId: "day-1", targetDayId: "day-2" };
  const calls = installFetchMock([{ status: 200, body: makeDraft("plan-1", { name: "Replaced" }) }]);
  const action = fakeAction({ action: "builder-overwrite-day-confirm" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/days/day-1/copy-into/day-2");
  assert.equal(calls[0].body.confirmOverwrite, true);
  assert.equal(state.builder.overwriteDayConfirm, null);
  assert.equal(state.builder.draft.plan.name, "Replaced");
});

test("7b. builder-overwrite-day-confirm re-sends against /blocks/... when the pending source was a cross-plan block, not /days/...", async () => {
  state.builder.overwriteDayConfirm = { sourceType: "cross-plan-block", sourceId: "block-9", targetDayId: "day-2" };
  const calls = installFetchMock([{ status: 200, body: makeDraft("plan-1", { name: "Replaced" }) }]);
  const action = fakeAction({ action: "builder-overwrite-day-confirm" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls[0].url, "/api/builder/blocks/block-9/copy-into/day-2");
  assert.equal(calls[0].body.confirmOverwrite, true);
});

test("8. renderOverwriteDayConfirmHtml renders nothing when there is no pending confirm, and the dialog when there is", () => {
  state.builder = emptyBuilderState();
  assert.equal(renderOverwriteDayConfirmHtml(state), "");

  state.builder.overwriteDayConfirm = { sourceType: "day", sourceId: "day-1", targetDayId: "day-2" };
  const html = renderOverwriteDayConfirmHtml(state);
  assert.match(html, /exit-confirm-modal/, "must reuse the app's existing styled confirm modal classes, not a one-off style or window.confirm");
  assert.match(html, /data-action="builder-overwrite-day-cancel"/);
  assert.match(html, /data-action="builder-overwrite-day-confirm"/);
});
