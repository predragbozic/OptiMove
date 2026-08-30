import { test } from "node:test";
import assert from "node:assert/strict";

// Per-session RPE opt-out (Builder side): a small "Collect RPE" toggle
// button next to each Weekly-plan session's existing name/AM-PM/BTA
// controls. Weekly plans only - a Program/Template session never collects
// RPE, so the control must not render there at all. renderBuilderBlock has
// no document-touching import chain, so it's imported and called directly
// (same pattern as builder-session-name.test.mjs).
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
  return { id: "block-1", index: 1, name: "", date: "", note: "", sessions: [{ id: "session-1", amPm: "AM", bta: "T", time: "", rpeEnabled: true, nodes: [], ...session }] };
}

test("1. a weekly session with RPE enabled shows the toggle in its ON state", () => {
  const html = renderBuilderBlock(blockWithSession({ rpeEnabled: true }), "", "", true, baseContext());
  assert.match(html, /builder-session-rpe-toggle is-on/);
  assert.match(html, /data-action="builder-toggle-session-rpe" data-session-id="session-1"/);
  assert.match(html, /aria-pressed="true"/);
});

test("2. a weekly session with RPE disabled shows the toggle in its OFF state", () => {
  const html = renderBuilderBlock(blockWithSession({ rpeEnabled: false }), "", "", true, baseContext());
  assert.match(html, /builder-session-rpe-toggle is-off/);
  assert.match(html, /aria-pressed="false"/);
});

test("3. the toggle is absent entirely for a Program/Template session (isWeekly=false) - RPE only applies to Weekly-plan sessions", () => {
  const html = renderBuilderBlock(blockWithSession({ rpeEnabled: true }), "", "", false, baseContext());
  assert.doesNotMatch(html, /builder-toggle-session-rpe/);
});

test("4. rpeEnabled defaults to treated-as-on when the session object doesn't carry the field at all (e.g. an older cached draft) - never silently reads as off", () => {
  const session = { id: "session-1", amPm: "AM", bta: "T", time: "", nodes: [] };
  const html = renderBuilderBlock({ id: "block-1", index: 1, name: "", date: "", note: "", sessions: [session] }, "", "", true, baseContext());
  assert.match(html, /builder-session-rpe-toggle is-on/);
});
