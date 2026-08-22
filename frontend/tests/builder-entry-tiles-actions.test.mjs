import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Phase 5 of the Builder feature set: the action-handler side of the new
// entry-tile screen (builder-actions.js's handleBuilderWorkspaceAction).
// builder-actions.js's own import chain touches `document` at module scope
// (same reasoning as builder-day-copy-paste-actions.test.mjs elsewhere in
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

function fakeAction(dataset) {
  return { dataset };
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
});

test("builder-choose-entry-type 'weekly' sets planType weekly, a weekStart default, and leaves the athlete picker closed", async () => {
  const action = fakeAction({ action: "builder-choose-entry-type", entryType: "weekly" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.equal(state.builder.entryType, "weekly");
  assert.equal(state.builder.planType, "weekly");
  assert.ok(state.builder.weekStart, "weekStart must default to something so the create form isn't blank");
  assert.equal(state.builder.athletePickerOpen, false);
});

test("builder-choose-entry-type 'program' sets planType program and opens the athlete picker - a Specific Program is meant to be assigned", async () => {
  const action = fakeAction({ action: "builder-choose-entry-type", entryType: "program" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.entryType, "program");
  assert.equal(state.builder.planType, "program");
  assert.equal(state.builder.athletePickerOpen, true);
});

test("builder-choose-entry-type 'template' sets planType program but leaves the athlete picker closed - defaults to a reusable, unassigned template", async () => {
  const action = fakeAction({ action: "builder-choose-entry-type", entryType: "template" });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(state.builder.entryType, "template");
  assert.equal(state.builder.planType, "program");
  assert.equal(state.builder.athletePickerOpen, false);
});

test("builder-entry-back clears entryType (returning to the tile grid) and closes the athlete picker", async () => {
  state.builder.entryType = "program";
  state.builder.athletePickerOpen = true;
  const action = fakeAction({ action: "builder-entry-back" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.equal(state.builder.entryType, "");
  assert.equal(state.builder.athletePickerOpen, false);
});
