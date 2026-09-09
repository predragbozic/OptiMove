import { test } from "node:test";
import assert from "node:assert/strict";

// UX correction round: the Weekly plan's own "New session defaults" panel
// (Builder side) - copy text, the neutral (non-text-action) bulk-action
// button styling, and conditional visibility of the three bulk actions
// based on whether they'd actually change anything. renderBuilderTrainingLoadSettings
// has no document-touching import chain (same as renderBuilderBlock - see
// builder-session-rpe-toggle.test.mjs), so it's imported and called
// directly.
const { renderBuilderTrainingLoadSettings } = await import("../builder-structure.js");

function makeSession(overrides = {}) {
  return { id: "session-1", bta: "T", trackingEnabled: false, rpeEnabled: false, ...overrides };
}

function makeDraft({ trackTrainingLoadDefault = false, requestRpeDefault = false, sessions = [] } = {}) {
  return {
    plan: { id: "plan-1", trackTrainingLoadDefault, requestRpeDefault },
    blocks: [{ id: "block-1", sessions }],
  };
}

test("1. renders the new copy: Include.../Request RPE from athletes/the neutral GPS-metrics note", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft());
  assert.match(html, /Include main Training sessions in Training Load/);
  assert.match(html, /Request RPE from athletes/);
  assert.doesNotMatch(html, /Track main Training sessions/, "the old copy must be gone");
  assert.doesNotMatch(html, /Request RPE for tracked sessions/, "the old copy must be gone");
  assert.match(html, /Including a session in Training Load does not automatically request GPS or other metrics\./);
});

test("2. with no sessions at all, none of the three bulk actions render - and neither does the 'Existing sessions' label", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({ sessions: [] }));
  assert.doesNotMatch(html, /data-action="builder-bulk-apply-training-sessions"/);
  assert.doesNotMatch(html, /data-action="builder-bulk-turn-off-before-after"/);
  assert.doesNotMatch(html, /data-action="builder-bulk-turn-off-all-rpe"/);
  assert.doesNotMatch(html, /Existing sessions/);
});

test("3. Apply renders only when a real Training session differs from the CURRENTLY selected defaults - never when every Training session already matches", () => {
  const matching = renderBuilderTrainingLoadSettings(makeDraft({
    trackTrainingLoadDefault: true, requestRpeDefault: true,
    sessions: [makeSession({ bta: "T", trackingEnabled: true, rpeEnabled: true })],
  }));
  assert.doesNotMatch(matching, /data-action="builder-bulk-apply-training-sessions"/, "every Training session already matches the defaults - nothing for Apply to do");

  const differing = renderBuilderTrainingLoadSettings(makeDraft({
    trackTrainingLoadDefault: true, requestRpeDefault: true,
    sessions: [makeSession({ bta: "T", trackingEnabled: false, rpeEnabled: false })],
  }));
  assert.match(differing, /data-action="builder-bulk-apply-training-sessions"/);
  assert.match(differing, /Apply these settings to existing Training sessions/);
});

test("4. Apply is never shown/counted for a Before/After session, even if it differs from the Training defaults - only bta='T' is ever a candidate", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({
    trackTrainingLoadDefault: true, requestRpeDefault: true,
    sessions: [makeSession({ bta: "B", trackingEnabled: false, rpeEnabled: false })],
  }));
  assert.doesNotMatch(html, /data-action="builder-bulk-apply-training-sessions"/);
});

test("5. Exclude Before/After renders with the exact affected count, and only counts a B/A session with tracking OR rpe currently on", () => {
  const zero = renderBuilderTrainingLoadSettings(makeDraft({
    sessions: [makeSession({ bta: "B", trackingEnabled: false, rpeEnabled: false }), makeSession({ bta: "A", trackingEnabled: false, rpeEnabled: false })],
  }));
  assert.doesNotMatch(zero, /data-action="builder-bulk-turn-off-before-after"/, "no B/A session has anything on - nothing to exclude");

  const two = renderBuilderTrainingLoadSettings(makeDraft({
    sessions: [
      makeSession({ bta: "B", trackingEnabled: true, rpeEnabled: false }),
      makeSession({ bta: "A", trackingEnabled: false, rpeEnabled: true }),
      makeSession({ bta: "T", trackingEnabled: true, rpeEnabled: true }), // a Training session must never be counted here
    ],
  }));
  assert.match(two, /data-action="builder-bulk-turn-off-before-after"/);
  assert.match(two, /Exclude existing Before\/After sessions \(2\)/);
});

test("6. Turn off RPE for all renders with the exact affected count, across EVERY bta (not just Training)", () => {
  const zero = renderBuilderTrainingLoadSettings(makeDraft({
    sessions: [makeSession({ bta: "T", trackingEnabled: true, rpeEnabled: false })],
  }));
  assert.doesNotMatch(zero, /data-action="builder-bulk-turn-off-all-rpe"/, "no session has rpe on - nothing to turn off");

  const three = renderBuilderTrainingLoadSettings(makeDraft({
    sessions: [
      makeSession({ bta: "T", trackingEnabled: true, rpeEnabled: true }),
      makeSession({ bta: "B", trackingEnabled: true, rpeEnabled: true }),
      makeSession({ bta: "A", trackingEnabled: true, rpeEnabled: true }),
    ],
  }));
  assert.match(three, /data-action="builder-bulk-turn-off-all-rpe"/);
  assert.match(three, /Turn off RPE for all existing sessions \(3\)/);
});

test("7. all three bulk actions render together, each independently, when each has real work to do", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({
    trackTrainingLoadDefault: true, requestRpeDefault: true,
    sessions: [
      makeSession({ bta: "T", trackingEnabled: false, rpeEnabled: false }),
      makeSession({ bta: "B", trackingEnabled: true, rpeEnabled: true }),
    ],
  }));
  assert.match(html, /Existing sessions/);
  assert.match(html, /data-action="builder-bulk-apply-training-sessions"/);
  assert.match(html, /data-action="builder-bulk-turn-off-before-after"/);
  assert.match(html, /data-action="builder-bulk-turn-off-all-rpe"/);
});

test("8. the bulk-action buttons use the app's neutral plain-button surface, never the old green .text-action styling", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({
    trackTrainingLoadDefault: true, requestRpeDefault: true,
    sessions: [makeSession({ bta: "T", trackingEnabled: false, rpeEnabled: false })],
  }));
  const button = html.match(/<button[^>]*data-action="builder-bulk-apply-training-sessions"[^>]*>/)[0];
  assert.match(button, /plain-button/);
  assert.match(button, /compact-button/);
  assert.doesNotMatch(button, /class="text-action"/);
  assert.match(html, /builder-icon-svg/, "a real SVG line icon must be present, not just a bare text link");
});

test("9. when Include is OFF, Request RPE renders disabled with a visible explanatory hint (not just a hover title)", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({ trackTrainingLoadDefault: false }));
  const rpeButton = html.match(/<button[^>]*data-action="builder-toggle-plan-rpe-default"[^>]*>/)[0];
  assert.match(rpeButton, /disabled/);
  assert.match(html, /builder-session-tracking-hint/);
  assert.match(html, /Include sessions in Training Load first/);
});

test("10. when Include is ON, Request RPE renders enabled and the OFF hint is absent", () => {
  const html = renderBuilderTrainingLoadSettings(makeDraft({ trackTrainingLoadDefault: true }));
  const rpeButton = html.match(/<button[^>]*data-action="builder-toggle-plan-rpe-default"[^>]*>/)[0];
  assert.doesNotMatch(rpeButton, /disabled/);
  assert.doesNotMatch(html, /Include sessions in Training Load first/);
});
