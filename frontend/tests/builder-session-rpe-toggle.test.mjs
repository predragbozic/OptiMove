import { test } from "node:test";
import assert from "node:assert/strict";

// Training Activity Integration 2A: "Track this session in Training Load"
// and "Request RPE from athletes" are two separate toggle buttons next to
// each Weekly-plan session's existing name/AM-PM/BTA controls (Builder
// side). Weekly plans only - a Program/Template session never tracks
// Training Load or collects RPE, so neither control renders there.
// renderBuilderBlock has no document-touching import chain, so it's
// imported and called directly (same pattern as builder-session-name.test.mjs).
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
  return { id: "block-1", index: 1, name: "", date: "", note: "", sessions: [{ id: "session-1", amPm: "AM", bta: "T", time: "", rpeEnabled: true, trackingEnabled: true, nodes: [], ...session }] };
}

test("1. a weekly session tracked with RPE enabled shows BOTH toggles in their ON state, RPE not disabled", () => {
  const html = renderBuilderBlock(blockWithSession({ trackingEnabled: true, rpeEnabled: true }), "", "", true, baseContext());
  assert.match(html, /builder-session-tracking-toggle is-on/);
  assert.match(html, /data-action="builder-toggle-session-tracking" data-session-id="session-1"/);
  assert.match(html, /data-action="builder-toggle-session-rpe" data-session-id="session-1"/);
  assert.doesNotMatch(html, /data-action="builder-toggle-session-rpe"[^>]*disabled/);
  const rpeButtonMatch = html.match(/<button[^>]*data-action="builder-toggle-session-rpe"[^>]*>/);
  assert.match(rpeButtonMatch[0], /builder-session-rpe-toggle is-on/);
  assert.match(rpeButtonMatch[0], /aria-pressed="true"/);
});

test("2. a tracked session with RPE disabled shows tracking ON, RPE OFF (but still enabled/clickable)", () => {
  const html = renderBuilderBlock(blockWithSession({ trackingEnabled: true, rpeEnabled: false }), "", "", true, baseContext());
  assert.match(html, /builder-session-tracking-toggle is-on/);
  const rpeButtonMatch = html.match(/<button[^>]*data-action="builder-toggle-session-rpe"[^>]*>/);
  assert.match(rpeButtonMatch[0], /builder-session-rpe-toggle is-off/);
  assert.doesNotMatch(rpeButtonMatch[0], /disabled/);
});

test("3. a session with tracking OFF shows the RPE toggle disabled and an explanatory hint, regardless of its own stored rpeEnabled value", () => {
  const html = renderBuilderBlock(blockWithSession({ trackingEnabled: false, rpeEnabled: false }), "", "", true, baseContext());
  assert.match(html, /builder-session-tracking-toggle is-off/);
  const rpeButtonMatch = html.match(/<button[^>]*data-action="builder-toggle-session-rpe"[^>]*>/);
  assert.match(rpeButtonMatch[0], /disabled/);
  assert.match(rpeButtonMatch[0], /builder-session-rpe-toggle is-off/);
  assert.match(html, /builder-session-tracking-hint/);
  assert.match(html, /won't automatically expect Training Load data or RPE/);
});

test("4. both toggles are absent entirely for a Program/Template session (isWeekly=false) - Training Load only applies to Weekly-plan sessions", () => {
  const html = renderBuilderBlock(blockWithSession({ trackingEnabled: true, rpeEnabled: true }), "", "", false, baseContext());
  assert.doesNotMatch(html, /builder-toggle-session-rpe/);
  assert.doesNotMatch(html, /builder-toggle-session-tracking/);
});

test("5. a session object missing trackingEnabled entirely (e.g. an older cached draft, from before this feature) is treated as NOT tracked - never guessed as on", () => {
  const session = { id: "session-1", amPm: "AM", bta: "T", time: "", nodes: [] };
  const html = renderBuilderBlock({ id: "block-1", index: 1, name: "", date: "", note: "", sessions: [session] }, "", "", true, baseContext());
  assert.match(html, /builder-session-tracking-toggle is-off/);
  const rpeButtonMatch = html.match(/<button[^>]*data-action="builder-toggle-session-rpe"[^>]*>/);
  assert.match(rpeButtonMatch[0], /disabled/);
});
