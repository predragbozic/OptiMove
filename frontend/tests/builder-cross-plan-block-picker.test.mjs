import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 2 of the Builder day-copy/paste feature: the "copy a block from
// another plan" picker modal (renderBlockPickerModal, builder-modals.js).
// No document-touching import chain (same reasoning as
// builder-day-copy-paste.test.mjs for builder-structure.js), so this is
// imported and called directly, exercising the real wizard-step rendering.
const { renderBlockPickerModal } = await import("../builder-modals.js");
const { emptyBlockPicker, emptyBuilderState } = await import("../state.js");

function baseState(blockPickerOverrides = {}, stateOverrides = {}) {
  return {
    builder: { ...emptyBuilderState(), blockPicker: emptyBlockPicker({ open: true, ...blockPickerOverrides }) },
    athletes: [],
    ...stateOverrides,
  };
}

test("1. closed picker renders nothing", () => {
  const state = { builder: emptyBuilderState(), athletes: [] };
  assert.equal(renderBlockPickerModal(state), "");
});

test("2. step 1 (no sourceType chosen yet) offers Template, Specific program, and Weekly plan as source choices", () => {
  const html = renderBlockPickerModal(baseState());
  assert.match(html, /data-action="builder-block-picker-choose-source-type" data-source-type="template"/);
  assert.match(html, /data-action="builder-block-picker-choose-source-type" data-source-type="program"/);
  assert.match(html, /data-action="builder-block-picker-choose-source-type" data-source-type="weekly"/);
});

test("3. Template step lists state.builder.blockPicker.templates, wired to choose-plan", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "template",
    templates: [{ plan_id: "t1", plan_name: "Rechab template", block_or_day_count: 4, item_count: 40 }],
  }));
  assert.match(html, /data-action="builder-block-picker-choose-plan" data-plan-id="t1" data-plan-name="Rechab template"/);
  assert.match(html, /Rechab template/);
  assert.match(html, /4 blocks - 40 exercises/);
});

test("4. Template step shows a loading state while fetching, not an empty list", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", templatesLoading: true, templates: [] }));
  assert.match(html, /Loading templates/);
  assert.doesNotMatch(html, /No templates found/);
});

test("5. Template step with zero results shows an explicit empty state, not a blank list", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", templates: [] }));
  assert.match(html, /No templates found/);
});

test("6. Specific program step with no athlete chosen yet lists state.athletes, wired to choose-athlete", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "program" }, { athletes: [{ athlete_id: "42", athlete: "Vahan" }] }));
  assert.match(html, /data-action="builder-block-picker-choose-athlete" data-athlete-id="42"/);
  assert.match(html, /Vahan/);
});

test("7. Specific program step, once an athlete is chosen, lists that athlete's programs (state.builder.blockPicker.athletePlans), wired to choose-plan", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "program",
    athleteId: "42",
    athletePlans: [{ plan_id: "p1", plan_name: "Rectus rechab program", block_or_day_count: 5, item_count: 158 }],
  }));
  assert.match(html, /data-action="builder-block-picker-choose-plan" data-plan-id="p1" data-plan-name="Rectus rechab program"/);
  assert.match(html, /158 exercises/);
});

test("8. once a plan is chosen (planId set), the block list (state.builder.blockPicker.blocks) is shown, wired to drill-block", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "template",
    planId: "t1",
    planName: "Rechab template",
    blocks: [{ id: "b1", name: "Phase 1", sessionCount: 2, itemCount: 30 }],
  }));
  assert.match(html, /data-action="builder-block-picker-drill-block" data-block-id="b1" data-block-name="Phase 1"/);
  assert.match(html, /2 sessions - 30 exercises/);
  assert.match(html, /<h3>Rechab template<\/h3>/, "the modal header must name the chosen plan once one is picked");
});

// Session-list step (Phase 2 of "prvo b pa onda a"): picking a day no
// longer sets the clipboard directly - it drills into that day's sessions,
// with "Copy this whole day" staying available for a coach who just wants
// the old whole-day behavior.

test("11. once a day is chosen (blockId set), the session list (state.builder.blockPicker.sessions) is shown, wired to drill-session, alongside a 'Copy this whole day' shortcut", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "template",
    planId: "t1",
    planName: "Rechab template",
    blockId: "b1",
    blockName: "Phase 1",
    sessions: [{ id: "s1", amPm: "AM", bta: "T", name: "", itemCount: 5 }],
  }));
  assert.match(html, /data-action="builder-block-picker-drill-session" data-session-id="s1"/);
  assert.match(html, /data-action="builder-block-picker-copy-whole-block"/);
  assert.match(html, /Copy this whole day/);
});

test("11b. the session list shows a loading state while fetching", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", planId: "t1", blockId: "b1", sessionsLoading: true, sessions: [] }));
  assert.match(html, /Loading sessions/);
});

test("11c. an empty session list shows an explicit empty state", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", planId: "t1", blockId: "b1", sessions: [] }));
  assert.match(html, /This day has no sessions yet\./);
});

// Node-tree step: picking a session shows its domain/category/section tree,
// with "Copy this whole session" as the equivalent whole-thing shortcut.

test("16. once a session is chosen (sessionId set), the node tree (state.builder.blockPicker.nodes) is shown, wired to choose-node, alongside a 'Copy this whole session' shortcut", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "template",
    planId: "t1",
    blockId: "b1",
    sessionId: "s1",
    sessionName: "AM / Training",
    nodes: [
      { id: "d1", parentId: "", type: "domain", name: "Strength", iconUrl: "", itemCount: 0 },
      { id: "sec1", parentId: "d1", type: "section", name: "Squat", iconUrl: "", itemCount: 3 },
    ],
  }));
  assert.match(html, /data-action="builder-block-picker-choose-node" data-node-id="d1" data-node-type="domain" data-node-name="Strength"/);
  assert.match(html, /data-action="builder-block-picker-choose-node" data-node-id="sec1" data-node-type="section" data-node-name="Squat" data-item-count="3"/);
  assert.match(html, /3 exercises/);
  assert.match(html, /data-action="builder-block-picker-copy-whole-session"/);
  assert.match(html, /Copy this whole session/);
});

test("16b. the node tree shows a loading state while fetching", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", planId: "t1", blockId: "b1", sessionId: "s1", nodesLoading: true, nodes: [] }));
  assert.match(html, /Loading structure/);
});

test("16c. an empty node tree shows an explicit empty state, not a blank body", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", planId: "t1", blockId: "b1", sessionId: "s1", nodes: [] }));
  assert.match(html, /This session has no domains, categories, or sections yet\./);
});

test("9. the block list shows a loading state while fetching", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", planId: "t1", planName: "Rechab template", blocksLoading: true, blocks: [] }));
  assert.match(html, /Loading blocks/);
});

test("10. an error (e.g. a failed fetch) is shown, not silently swallowed", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "template", error: "Could not load templates." }));
  assert.match(html, /Could not load templates\./);
});

// "Weekly plan" as a cross-plan source (round 2 of Builder feedback) -
// reuses the exact same athlete-picker step as "Specific program" (test 6
// above); only the wording and, at the action-handler level, the
// plan_type filter differ - see builder-cross-plan-block-picker-actions
// .test.mjs.

test("12. Weekly plan step with no athlete chosen yet lists state.athletes, wired to choose-athlete, same as the Specific program step", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "weekly" }, { athletes: [{ athlete_id: "42", athlete: "Vahan" }] }));
  assert.match(html, /data-action="builder-block-picker-choose-athlete" data-athlete-id="42"/);
  assert.match(html, /Vahan/);
});

test("13. Weekly plan step, once an athlete is chosen, lists that athlete's weekly plans (state.builder.blockPicker.athletePlans), wired to choose-plan, labeled in days not blocks", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "weekly",
    athleteId: "42",
    athletePlans: [{ plan_id: "w1", plan_name: "Weekly plan 2026-11-02", block_or_day_count: 7, item_count: 12 }],
  }));
  assert.match(html, /data-action="builder-block-picker-choose-plan" data-plan-id="w1" data-plan-name="Weekly plan 2026-11-02"/);
  assert.match(html, /7 days - 12 exercises/);
});

test("14. Weekly plan step with zero results shows an explicit, correctly-worded empty state", () => {
  const html = renderBlockPickerModal(baseState({ sourceType: "weekly", athleteId: "42", athletePlans: [] }));
  assert.match(html, /This athlete has no weekly plans\./);
});

test("15. the close button and backdrop are always present, wired to builder-close-block-picker", () => {
  const html = renderBlockPickerModal(baseState());
  const closeCount = (html.match(/data-action="builder-close-block-picker"/g) || []).length;
  assert.equal(closeCount, 2, "backdrop + header close button");
});
