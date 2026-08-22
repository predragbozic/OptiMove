import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 2 of Builder feedback, Phase B: the open-draft toolbar's Exit/Save/
// Finish/Delete cluster is unified into icon-only buttons (tooltip-only,
// no text labels) - autosave stays fully automatic and invisible, so the
// old passive "Saved" indicator is removed entirely rather than becoming a
// fourth button. Exit uses a new door+arrow icon instead of a bare X.
// The shared paste icon (used by every paste button in the app) is also
// redesigned to read more clearly as "paste" (a clipboard with a page
// peeking out) instead of a plain page-with-lines.
//
// builder-view.js/builder-structure.js touch `els`/`document` at module
// scope through their import chains, so - same as every other builder-
// view.js-adjacent test in this suite - checked via source-pattern-guard
// tests over the raw file text, never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const builderViewSource = readSource("../builder-view.js");
const builderStructureSource = readSource("../builder-structure.js");

function sliceToolbar(windowSize = 1900) {
  const start = builderViewSource.indexOf('class="builder-program-actions"');
  assert.ok(start >= 0, "the builder-program-actions toolbar must exist");
  return builderViewSource.slice(start, start + windowSize);
}

test("builder-structure.js exports ICON_DOOR_EXIT - a door+arrow icon, not a bare X", () => {
  assert.match(builderStructureSource, /export const ICON_DOOR_EXIT = `<svg/);
});

test("the toolbar's Exit button is icon-only (no text label), uses ICON_DOOR_EXIT, and keeps the edit-draft vs normal tooltip distinction", () => {
  const toolbar = sliceToolbar();
  assert.match(toolbar, /class="plain-button icon-button builder-exit-button"/);
  assert.match(toolbar, /\$\{ICON_DOOR_EXIT\}<\/button>/);
  assert.match(toolbar, /isEditDraft \? "Discard edit draft" : "Exit"/);
  assert.match(toolbar, /Discard this edit draft and keep the original unchanged\./);
});

test("there is no separate Cancel button or passive Saved indicator anymore - Exit is the single unified button for both modes", () => {
  const toolbar = sliceToolbar();
  assert.doesNotMatch(toolbar, /builder-cancel-button/);
  assert.doesNotMatch(toolbar, /builder-saved-indicator/);
  assert.doesNotMatch(toolbar, />Cancel<\/span>/);
});

test("the Finish button is icon-only (no text label) but keeps its tooltip wording and the isEditDraft-aware saveLabel", () => {
  const toolbar = sliceToolbar();
  assert.match(toolbar, /class="plain-button icon-button builder-finish-button"/);
  assert.match(toolbar, /aria-label="\$\{saveLabel\}"/);
  assert.match(toolbar, /\$\{ICON_CHECK\}<\/button>/);
  assert.doesNotMatch(toolbar, /<span>\$\{saveLabel\}<\/span>/);
});

test("the Delete button is unchanged - still icon-only with ICON_TRASH and its own tooltip", () => {
  const toolbar = sliceToolbar();
  assert.match(toolbar, /data-action="builder-delete-plan"/);
  assert.match(toolbar, /\$\{ICON_TRASH\}<\/button>/);
});

test("Assign to athlete keeps its own text label - it's not one of the three unified icon-only buttons", () => {
  const toolbar = sliceToolbar();
  assert.match(toolbar, /<span>Assign to athlete<\/span>/);
});

test("ICON_PASTE is redesigned as a clipboard-with-a-page icon, still a single shared constant used by every paste button", () => {
  assert.match(builderStructureSource, /const ICON_PASTE = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><rect x="4" y="5" width="12" height="16" rx="2">/);
});

test("styles.css no longer defines .builder-saved-indicator or .builder-cancel-button - both are dead now", () => {
  const cssSource = readSource("../styles.css");
  assert.doesNotMatch(cssSource, /\.builder-saved-indicator/);
  assert.doesNotMatch(cssSource, /\.builder-cancel-button/);
});

test("the Exit and Finish buttons share the same compact icon-button sizing rule", () => {
  const cssSource = readSource("../styles.css");
  assert.match(cssSource, /\.builder-finish-button, \.builder-exit-button \{ width: 32px; min-width: 32px; height: 32px; min-height: 32px; padding: 0; \}/);
});
