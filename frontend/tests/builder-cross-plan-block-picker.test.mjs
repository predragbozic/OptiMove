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

test("8. once a plan is chosen (planId set), the block list (state.builder.blockPicker.blocks) is shown, wired to choose-block", () => {
  const html = renderBlockPickerModal(baseState({
    sourceType: "template",
    planId: "t1",
    planName: "Rechab template",
    blocks: [{ id: "b1", name: "Phase 1", sessionCount: 2, itemCount: 30 }],
  }));
  assert.match(html, /data-action="builder-block-picker-choose-block" data-block-id="b1" data-block-name="Phase 1"/);
  assert.match(html, /2 sessions - 30 exercises/);
  assert.match(html, /<h3>Rechab template<\/h3>/, "the modal header must name the chosen plan once one is picked");
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
