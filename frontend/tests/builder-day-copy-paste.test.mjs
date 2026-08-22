import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 1 of the Builder day-copy/paste feature: copy a whole weekly day and
// paste it onto another day of the same plan. builder-structure.js has no
// document-touching import chain (unlike app.js/athlete-view.js elsewhere in
// this suite), so renderBuilderBlock - the single function that renders both
// a weekly "day" and a program/template "block" (isWeekly branches the
// differences) - is imported and called directly here.
const { renderBuilderBlock } = await import("../builder-structure.js");

function baseContext(overrides = {}) {
  return {
    clipboard: null,
    sessionQuickAdd: {},
    ...overrides,
  };
}

function emptyBlock(overrides = {}) {
  return { id: "day-1", index: 1, name: "", date: "2026-09-07", note: "", sessions: [], ...overrides };
}

test("1. a weekly day (isWeekly=true) with nothing in the clipboard shows a Copy day icon but no Paste icon", () => {
  const html = renderBuilderBlock(emptyBlock(), "", "", true, baseContext());
  assert.match(html, /data-action="builder-copy-day" data-day-id="day-1"/);
  assert.doesNotMatch(html, /data-action="builder-paste-day"/);
});

test("2. once a day is in the clipboard, every OTHER weekly day shows a Paste day icon", () => {
  const html = renderBuilderBlock(emptyBlock({ id: "day-2" }), "", "", true, baseContext({ clipboard: { type: "day", dayId: "day-1", name: "Monday" } }));
  assert.match(html, /data-action="builder-paste-day" data-day-id="day-2"/);
  assert.match(html, /Paste &quot;Monday&quot;|Paste "Monday"/);
});

test("3. the day currently IN the clipboard never shows its own Paste button (pasting a day onto itself is meaningless)", () => {
  const html = renderBuilderBlock(emptyBlock({ id: "day-1" }), "", "", true, baseContext({ clipboard: { type: "day", dayId: "day-1", name: "Monday" } }));
  assert.doesNotMatch(html, /data-action="builder-paste-day"/);
});

test("4. a clipboard holding a different type (e.g. a copied node) never shows a Paste day button on a weekly day", () => {
  const html = renderBuilderBlock(emptyBlock({ id: "day-2" }), "", "", true, baseContext({ clipboard: { type: "section", nodeId: "node-1", name: "Warm-up" } }));
  assert.doesNotMatch(html, /data-action="builder-paste-day"/);
});

test("5. non-weekly blocks (program/template) are completely unaffected - still just Copy block + Delete block, no day-copy actions leaked in", () => {
  const html = renderBuilderBlock(emptyBlock({ id: "block-1" }), "", "", false, baseContext({ clipboard: { type: "day", dayId: "day-1", name: "Monday" } }));
  assert.doesNotMatch(html, /data-action="builder-copy-day"/);
  assert.doesNotMatch(html, /data-action="builder-paste-day"/);
  assert.match(html, /data-action="builder-copy-block" data-block-id="block-1"/);
  assert.match(html, /data-action="builder-delete-block"/);
});

// Phase 2: a clipboard holding a block copied from a DIFFERENT plan
// (Template/Specific Program, picked via builder-modals.js's block picker)
// must be pasteable the exact same way a same-plan copied day is - the
// Paste button doesn't care where the clipboard's content came from.
test("6. a cross-plan-block clipboard shows the Paste day button on every weekly day - no self-exclusion, since its id belongs to a different plan entirely", () => {
  const clipboard = { type: "cross-plan-block", sourcePlanId: "template-1", blockId: "block-9", name: "Ankle rehab" };
  const html = renderBuilderBlock(emptyBlock({ id: "day-2" }), "", "", true, baseContext({ clipboard }));
  assert.match(html, /data-action="builder-paste-day" data-day-id="day-2"/);
  assert.match(html, /Paste &quot;Ankle rehab&quot;|Paste "Ankle rehab"/);
});

test("7. a cross-plan-block clipboard never leaks a Paste button into a non-weekly block", () => {
  const clipboard = { type: "cross-plan-block", sourcePlanId: "template-1", blockId: "block-9", name: "Ankle rehab" };
  const html = renderBuilderBlock(emptyBlock({ id: "block-1" }), "", "", false, baseContext({ clipboard }));
  assert.doesNotMatch(html, /data-action="builder-paste-day"/);
});
