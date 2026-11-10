import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B1 (owner's Builder plan): the outline's touch targets. CSS only: no markup, data-* or name changes. The browser
// proof is e2e/tests/builder-outline-touch.test.mjs; the drag and autosave guard is builder-drag-autosave.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Builder outline's touch targets (B1)"));
const end = css.indexOf("\n/* =====", start + 10);
const block = css.slice(start, end < 0 ? undefined : end);
const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");

test("the block exists and every selector is the coach's Builder outline (.builder-block-grid), never another screen", () => {
  assert.ok(start > 0);
  const selectors = [...rules.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(",")).map((s) => s.trim());
  assert.ok(selectors.length >= 15, selectors.length);
  for (const selector of selectors) {
    assert.ok(selector.startsWith("body:not(.athlete-mode):not(.login-mode) "), selector);
    assert.ok(/\.builder-block-grid|\.builder-session-actions > \.builder-session-time-inline/.test(selector), selector);
  }
});

test("on a touch screen or a phone the outline's actions and rows are 44 px; their rows wrap", () => {
  const touch = rules.slice(rules.indexOf("@media (pointer: coarse), (max-width: 760px)"), rules.indexOf("@media (pointer: fine) and (min-width: 761px)"));
  assert.ok(touch.length > 100);
  for (const target of [".builder-block-head-actions .builder-icon-action", ".builder-session-actions .builder-icon-action", ".builder-session-quick-add-actions .builder-icon-action", ".builder-inline-add-actions .builder-icon-action", ".builder-node-row-actions .builder-icon-action", ".builder-node-row-actions .builder-node-move-icon", ".builder-section-preview-trigger", ".builder-add-session-trigger", ".builder-add-node-trigger", ".builder-node-button", ".builder-session"]) {
    assert.ok(touch.includes(target), target);
  }
  assert.match(touch, /width: var\(--om-tap-target\);\s*height: var\(--om-tap-target\);\s*min-width: var\(--om-tap-target\);\s*min-height: var\(--om-tap-target\);/);
  assert.match(touch, /\.builder-node-row-actions,[\s\S]*?\{\s*flex-wrap: wrap;/);
  assert.match(css, /:root \{[^}]*--om-tap-target: 44px;/);
});

test("a computer keeps the dense outline at 32 px at least", () => {
  const fine = rules.slice(rules.indexOf("@media (pointer: fine) and (min-width: 761px)"), rules.indexOf("@media (max-width: 380px)"));
  assert.match(fine, /width: 32px;\s*height: 32px;\s*min-width: 32px;\s*min-height: 32px;/);
  assert.match(fine, /\.builder-add-node-trigger \{\s*min-width: 32px;\s*min-height: 32px;/);
});

test("the narrowest phones give the session's selects 24 px back without changing B2's grid", () => {
  const narrow = rules.slice(rules.indexOf("@media (max-width: 380px)"));
  assert.match(narrow, /\.builder-block-grid > \.builder-block \{\s*padding-left: 8px;\s*padding-right: 8px;/);
  assert.match(narrow, /\.builder-block-grid \.builder-session-actions \{\s*padding-left: 0;\s*padding-right: 0;/);
  assert.match(narrow, /column-gap: var\(--om-space-1\);/);
  assert.ok(!/grid-template-(columns|areas)/.test(narrow), "B2's columns and areas stay B2's");
});

test("the add badge stays on its icon's corner in the bigger box (touch, computer and the smaller phone icon)", () => {
  assert.match(rules, /\.builder-add-node-trigger \.builder-add-node-plus \{\s*right: calc\(\(100% - var\(--builder-level-w\)\) \/ 2 - 4px\);\s*bottom: calc\(\(100% - var\(--builder-level-h\)\) \/ 2 - 4px\);/);
  assert.match(rules, /--builder-level-w: 27px;\s*--builder-level-h: 24px;/);
  assert.match(rules, /@media \(max-width: 560px\) \{[^}]*--builder-level-w: 24px;\s*--builder-level-h: 21px;/);
  assert.match(rules, /right: calc\(\(100% - 27px\) \/ 2 - 4px\);\s*bottom: calc\(\(100% - 24px\) \/ 2 - 4px\);/);
});

test("on a short touch screen (a phone on its side) the session row does not stick", () => {
  assert.match(rules, /@media \(pointer: coarse\) and \(max-height: 500px\) \{\s*body:not\(\.athlete-mode\):not\(\.login-mode\) \.builder-block-grid \.builder-session-row \{\s*position: static;/);
});
