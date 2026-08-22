import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Phase 2 of the Builder day-copy/paste feature: the action-handler side of
// the "copy a block from another plan" picker (handleBuilderWorkspaceAction
// in builder-actions.js). Same document stub as
// builder-day-copy-paste-actions.test.mjs - builder-actions.js's own import
// chain touches `document` at module scope.

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

const originalFetch = globalThis.fetch;

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    const next = queue.shift();
    const status = next?.status ?? 200;
    const body = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
  };
  return calls;
}

function fakeAction(dataset) {
  return { dataset, disabled: false };
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
  state.athletes = [];
  globalThis.fetch = originalFetch;
});

test("1. builder-open-block-picker opens the picker fresh (no leftover sourceType/plan from a previous run)", async () => {
  state.builder.blockPicker.sourceType = "program";
  state.builder.blockPicker.planId = "stale-plan";
  const action = fakeAction({ action: "builder-open-block-picker" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.blockPicker.open, true);
  assert.equal(state.builder.blockPicker.sourceType, "");
  assert.equal(state.builder.blockPicker.planId, "");
});

test("2. builder-close-block-picker resets the whole picker back to closed/empty", async () => {
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "template", planId: "t1" };
  const action = fakeAction({ action: "builder-close-block-picker" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.blockPicker.open, false);
  assert.equal(state.builder.blockPicker.sourceType, "");
});

test("3. choosing 'template' fetches /api/templates and stores the result on blockPicker.templates", async () => {
  const calls = installFetchMock([{ status: 200, body: { templates: [{ plan_id: "t1", plan_name: "My template" }] } }]);
  state.builder.blockPicker.open = true;
  const action = fakeAction({ action: "builder-block-picker-choose-source-type", sourceType: "template" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/api\/templates\?scope=my_programs$/);
  assert.equal(state.builder.blockPicker.sourceType, "template");
  assert.deepEqual(state.builder.blockPicker.templates, [{ plan_id: "t1", plan_name: "My template" }]);
  assert.equal(state.builder.blockPicker.templatesLoading, false);
});

test("4. choosing 'program' does NOT fetch anything yet - it waits for an athlete to be chosen first", async () => {
  const calls = installFetchMock([]);
  state.builder.blockPicker.open = true;
  const action = fakeAction({ action: "builder-block-picker-choose-source-type", sourceType: "program" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls.length, 0);
  assert.equal(state.builder.blockPicker.sourceType, "program");
});

test("5. choosing an athlete fetches their plans and keeps only real (non-template) Specific Programs", async () => {
  const calls = installFetchMock([{
    status: 200,
    body: {
      plans: [
        { plan_id: "p1", plan_name: "Real program", plan_type: "program", is_template: false },
        { plan_id: "tpl1", plan_name: "A template", plan_type: "program", is_template: true },
        { plan_id: "w1", plan_name: "A weekly plan", plan_type: "weekly", is_template: false },
      ],
    },
  }]);
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "program" };
  const action = fakeAction({ action: "builder-block-picker-choose-athlete", athleteId: "42" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls[0].url, "/api/athletes/42/plans");
  assert.equal(state.builder.blockPicker.athleteId, "42");
  assert.deepEqual(state.builder.blockPicker.athletePlans.map((plan) => plan.plan_id), ["p1"], "must filter out templates and weekly plans - only real Specific Programs belong in this step");
});

test("6. choosing a plan fetches its lightweight block list", async () => {
  const calls = installFetchMock([{ status: 200, body: { blocks: [{ id: "b1", name: "Phase 1", sessionCount: 2, itemCount: 20 }] } }]);
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "template" };
  const action = fakeAction({ action: "builder-block-picker-choose-plan", planId: "t1", planName: "My template" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(calls[0].url, "/api/builder/plans/t1/blocks");
  assert.equal(state.builder.blockPicker.planId, "t1");
  assert.equal(state.builder.blockPicker.planName, "My template");
  assert.deepEqual(state.builder.blockPicker.blocks, [{ id: "b1", name: "Phase 1", sessionCount: 2, itemCount: 20 }]);
});

test("7. choosing a block sets the clipboard to a cross-plan-block entry and closes the whole picker", async () => {
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "template", planId: "t1", planName: "My template", blocks: [{ id: "b1", name: "Phase 1" }] };
  const action = fakeAction({ action: "builder-block-picker-choose-block", blockId: "b1", blockName: "Phase 1" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.deepEqual(state.builder.clipboard, { type: "cross-plan-block", sourcePlanId: "t1", blockId: "b1", name: "Phase 1" });
  assert.equal(state.builder.blockPicker.open, false, "the picker must close once a block is chosen - the coach is done with it");
});

test("8. a failed fetch during any step surfaces on blockPicker.error instead of throwing or silently doing nothing", async () => {
  installFetchMock([{ status: 500, body: { error: "Server error" } }]);
  state.builder.blockPicker.open = true;
  const action = fakeAction({ action: "builder-block-picker-choose-source-type", sourceType: "template" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.ok(state.builder.blockPicker.error, "a failed fetch must leave a visible error message on the picker");
  assert.equal(state.builder.blockPicker.templatesLoading, false, "loading state must be cleared even on failure, or the spinner would be stuck forever");
});

test("9. builder-block-picker-back-to-plans clears planId/blocks but keeps the chosen source type/athlete", async () => {
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "program", athleteId: "42", athletePlans: [{ plan_id: "p1" }], planId: "p1", planName: "X", blocks: [{ id: "b1" }] };
  const action = fakeAction({ action: "builder-block-picker-back-to-plans" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.blockPicker.planId, "");
  assert.equal(state.builder.blockPicker.blocks.length, 0);
  assert.equal(state.builder.blockPicker.athleteId, "42", "stepping back to the plan list must not also lose the already-chosen athlete");
});

test("10. builder-block-picker-back-to-source resets everything back to the source-type choice", async () => {
  state.builder.blockPicker = { ...state.builder.blockPicker, open: true, sourceType: "program", athleteId: "42", planId: "p1" };
  const action = fakeAction({ action: "builder-block-picker-back-to-source" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.blockPicker.sourceType, "");
  assert.equal(state.builder.blockPicker.athleteId, "");
  assert.equal(state.builder.blockPicker.open, true, "stepping back must stay open, not close the whole picker");
});
