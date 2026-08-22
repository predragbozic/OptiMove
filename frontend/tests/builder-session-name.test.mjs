import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 3 of the Builder additions: an optional custom session name, shown
// ADDITIONALLY alongside the existing AM/PM + Before/Training/After badges
// (frontend/builder-helpers.js's sessionLabel()), never replacing them.
// renderBuilderBlock (builder-structure.js) has no document-touching import
// chain, so it's imported and called directly (same pattern as
// builder-day-copy-paste.test.mjs).
const { renderBuilderBlock } = await import("../builder-structure.js");
const { exerciseNodeLabel, sessionLabel } = await import("../builder-helpers.js");

function baseContext(overrides = {}) {
  return {
    clipboard: null,
    sessionQuickAdd: {},
    sessionLabel,
    exerciseNodeLabel,
    ...overrides,
  };
}

function blockWithSession(session) {
  return { id: "block-1", index: 1, name: "", date: "", note: "", sessions: [{ id: "session-1", amPm: "AM", bta: "T", time: "", nodes: [], ...session }] };
}

test("1. a session with a name shows it as its own line (builder-session-name), separate from the badge row", () => {
  const html = renderBuilderBlock(blockWithSession({ name: "MD-1" }), "", "", true, baseContext());
  assert.match(html, /<strong class="builder-session-name">MD-1<\/strong>/);
});

test("2. a session with no name shows no name line at all - not an empty <strong>, nothing", () => {
  const html = renderBuilderBlock(blockWithSession({ name: "" }), "", "", true, baseContext());
  assert.doesNotMatch(html, /<strong class="builder-session-name">/, "no <strong> name line at all when there's no name (the -name-input field is a separate, always-present form control, not this)");
});

test("3. the AM/PM + training-phase badge row is unchanged whether or not a name is present", () => {
  const withName = renderBuilderBlock(blockWithSession({ name: "MD-1", amPm: "AM", bta: "T" }), "", "", true, baseContext());
  const withoutName = renderBuilderBlock(blockWithSession({ name: "", amPm: "AM", bta: "T" }), "", "", true, baseContext());
  assert.match(withName, /<span class="builder-session-badge-row"><span>AM \/ Training<\/span>/);
  assert.match(withoutName, /<span class="builder-session-badge-row"><span>AM \/ Training<\/span>/);
});

test("4. the update-session form carries a name input pre-filled with the session's current name, alongside the existing time input", () => {
  const html = renderBuilderBlock(blockWithSession({ name: "Match day", time: "09:30" }), "", "", true, baseContext());
  assert.match(html, /data-builder-form="update-session"[^>]*data-session-id="session-1"/);
  assert.match(html, /<input type="text" name="name" class="builder-text-input builder-session-name-input" value="Match day"/);
  assert.match(html, /<input type="time" name="time" class="builder-text-input builder-session-time-input" value="09:30"/, "the existing time field must still be in the SAME form, untouched");
});

test("5. sessionLabel() itself (the shared badge-text helper, reused for aria-labels/modal titles elsewhere) is untouched by the name field - still badge-only", () => {
  assert.equal(sessionLabel({ amPm: "AM", bta: "T", time: "", name: "MD-1" }), "AM / Training", "sessionLabel must stay badge-only - the name is an additive DISPLAY line at the render call site, not merged into the shared label string every caller (aria-labels, modal eyebrow) would otherwise inherit");
});
