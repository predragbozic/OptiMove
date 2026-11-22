import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

// Import into a program or block template from a weekly plan (the "Copy from
// another plan" dialog) and the pictures button of each section in that
// dialog. Same document stub as builder-cross-plan-block-picker-actions.test.mjs.
const fakeElements = new Map();
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] });
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};
globalThis.window = { confirm: () => true };

const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { renderBlockPickerModal } = await import("../builder-modals.js");
const { renderBuilderBlock } = await import("../builder-structure.js");
const { state, emptyBuilderState, emptyBlockPicker } = await import("../state.js");

const originalFetch = globalThis.fetch;
const fakeAction = (dataset) => ({ dataset, disabled: false });
const handlers = () => ({ renderBuilder: () => {}, renderBuilderError: () => {}, renderTabs: () => {}, renderLibraryNav: () => {}, loadBuilderExercises: async () => {} });

function viewState(planType, pickerOverrides = {}) {
  return {
    builder: { ...emptyBuilderState(), draft: { plan: { planType } }, blockPicker: emptyBlockPicker({ open: true, ...pickerOverrides }) },
    athletes: [{ athlete_id: "42", athlete: "Example Athlete" }],
  };
}

beforeEach(() => {
  state.builder = emptyBuilderState();
  globalThis.fetch = originalFetch;
});

test("1. a program or template target offers only the weekly source and no way back to the others; a weekly target keeps all three", () => {
  const weekly = renderBlockPickerModal(viewState("weekly"));
  for (const kind of ["template", "program", "weekly"]) assert.match(weekly, new RegExp(`data-source-type="${kind}"`));
  const program = renderBlockPickerModal(viewState("program"));
  assert.match(program, /data-source-type="weekly"/);
  assert.doesNotMatch(program, /data-source-type="template"|data-source-type="program"/);
  const athletes = renderBlockPickerModal(viewState("program", { sourceType: "weekly" }));
  assert.match(athletes, /builder-block-picker-choose-athlete/);
  assert.doesNotMatch(athletes, /builder-block-picker-back-to-source/);
  assert.match(renderBlockPickerModal(viewState("weekly", { sourceType: "weekly" })), /builder-block-picker-back-to-source/);
});

test("2. opening the dialog on a program starts at the weekly source; on a weekly plan it starts empty", async () => {
  state.builder.draft = { plan: { planType: "program" } };
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-open-block-picker" }), handlers());
  assert.equal(state.builder.blockPicker.open, true);
  assert.equal(state.builder.blockPicker.sourceType, "weekly");
  state.builder.draft = { plan: { planType: "weekly" } };
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-open-block-picker" }), handlers());
  assert.equal(state.builder.blockPicker.sourceType, "");
});

const programBlock = { id: "b1", index: 1, name: "Block A", note: "", sessions: [] };
const ctx = (clipboard) => ({ clipboard, sessionLabel: () => "", blockAddOpen: false });

test("3. a program block shows paste buttons for imported content only (a day or a session from another plan), never for a same-plan day", () => {
  assert.match(renderBuilderBlock(programBlock, "", "", false, ctx({ type: "cross-plan-block", name: "Mon" })), /data-action="builder-paste-day" data-day-id="b1"/);
  assert.match(renderBuilderBlock(programBlock, "", "", false, ctx({ type: "cross-plan-session", name: "Main" })), /data-action="builder-paste-session" data-day-id="b1"/);
  for (const clipboard of [null, { type: "day", dayId: "other", name: "x" }]) {
    const html = renderBuilderBlock(programBlock, "", "", false, ctx(clipboard));
    assert.doesNotMatch(html, /builder-paste-day|builder-paste-session/);
  }
});

const nodes = [
  { id: "d1", parentId: "", type: "domain", name: "Strength", itemCount: 0, iconUrl: "" },
  { id: "s1", parentId: "d1", type: "section", name: "Lower body", itemCount: 14, iconUrl: "", items: [{ id: "i1", title: "Squat" }, { id: "i2", title: "Lunge" }] },
  { id: "s2", parentId: "d1", type: "section", name: "Core", itemCount: 0, iconUrl: "", items: [] },
];

test("4. each section has its own pictures button (a sibling of the copy button, named, with its state); only the open section shows thumbnails", () => {
  const closed = renderBlockPickerModal(viewState("weekly", { sessionId: "x", sessionName: "Main", nodes }));
  assert.equal((closed.match(/builder-block-picker-toggle-thumbs/g) || []).length, 2, "sections only, not the domain");
  assert.match(closed, /aria-label="Show pictures of the exercises in Lower body" aria-expanded="false"/);
  assert.doesNotMatch(closed, /builder-block-picker-thumbs"/);
  // never nested inside the copy button
  assert.doesNotMatch(closed, /<button[^>]*choose-node[^>]*>(?:(?!<\/button>)[\s\S])*toggle-thumbs/);

  const open = renderBlockPickerModal(viewState("weekly", { sessionId: "x", sessionName: "Main", nodes, thumbSectionId: "s1" }));
  assert.match(open, /aria-label="Hide pictures of the exercises in Lower body" aria-expanded="true"/);
  assert.match(open, /Squat/);
  assert.match(open, /Lunge/);
  assert.match(open, /\+12 more/);
  assert.doesNotMatch(open, /No exercises in this section yet/);

  const emptyOpen = renderBlockPickerModal(viewState("weekly", { sessionId: "x", sessionName: "Main", nodes, thumbSectionId: "s2" }));
  assert.match(emptyOpen, /No exercises in this section yet/);
});

test("5. the pictures button toggles one section at a time; choosing a session asks the nodes read for its items and starts closed", async () => {
  state.builder.blockPicker = emptyBlockPicker({ open: true, sessionId: "x", nodes });
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-block-picker-toggle-thumbs", nodeId: "s1" }), handlers());
  assert.equal(state.builder.blockPicker.thumbSectionId, "s1");
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-block-picker-toggle-thumbs", nodeId: "s2" }), handlers());
  assert.equal(state.builder.blockPicker.thumbSectionId, "s2");
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-block-picker-toggle-thumbs", nodeId: "s2" }), handlers());
  assert.equal(state.builder.blockPicker.thumbSectionId, "");

  state.builder.blockPicker.thumbSectionId = "s1";
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, status: 200, statusText: "", json: async () => ({ nodes }) }; };
  await handleBuilderWorkspaceAction(fakeAction({ action: "builder-block-picker-drill-session", sessionId: "sess1", sessionName: "Main" }), handlers());
  assert.deepEqual(calls, ["/api/builder/sessions/sess1/nodes?items=1"]);
  assert.equal(state.builder.blockPicker.thumbSectionId, "");
  assert.deepEqual(state.builder.blockPicker.nodes, nodes);
});
