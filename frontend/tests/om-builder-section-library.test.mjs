import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B5 (owner's Builder plan): the section editor's exercise library on a computer. With a mouse, Favourite, Mark,
// Tags and Add of a library card are 44 px targets; phones and touch screens already were. No markup change: the
// card keeps draggable and every data-*. Browser proof: e2e/tests/builder-section-library.test.mjs.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("styles.css");
const exercises = read("builder-exercises.js");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Builder's section editor on a computer (B5)"));
const end = css.indexOf("\n/* =====", start + 10);
const block = css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");

test("the block applies only to a computer with a mouse, and only to the library cards", () => {
  assert.ok(start > 0, "the B5 block exists");
  assert.match(block, /@media \(pointer: fine\) and \(min-width: 761px\) \{/);
  const selectors = [...block.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(",")).map((s) => s.trim());
  assert.ok(selectors.length >= 8, selectors.length);
  for (const selector of selectors) assert.match(selector, /^body:not\(\.athlete-mode\):not\(\.login-mode\) \.builder-exercise-view(\.is-tile)? \./, selector);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), "colours come from the shared tokens");
});

test("Favourite, Mark, Tags and Add take the 44 px target; Favourite and Mark keep a small frame", () => {
  assert.match(block, /\.builder-mini-toggle \{[^}]*width: var\(--om-tap-target\);[^}]*height: var\(--om-tap-target\);/);
  assert.match(block, /\.builder-mini-toggle::before \{[^}]*position: absolute;[^}]*inset: 7px;[^}]*border: 1px solid var\(--line\);/);
  assert.match(block, /\.builder-exercise-mini-actions \.text-action \{[^}]*min-height: var\(--om-tap-target\);[^}]*font-size: var\(--om-text-sm\);/);
  assert.match(block, /\.builder-exercise-add \{[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.builder-mini-toggle:focus-visible::before \{[^}]*outline: 2px solid var\(--accent\);/);
  assert.match(block, /\.builder-mini-toggle:focus-visible \{[^}]*box-shadow: none;/, "one focus ring, on the frame");
});

test("a short window keeps the compact tile's 22 px \"+\" Add", () => {
  assert.match(block, /@media \(max-height: 520px\) \{\s*body:not\(\.athlete-mode\):not\(\.login-mode\) \.builder-exercise-view\.is-tile \.builder-exercise-add \{[^}]*padding: 0;[^}]*font-size: 22px;/);
});

test("the card markup is unchanged: draggable and every data-* stay", () => {
  assert.match(exercises, /draggable="true" data-builder-library-drag data-exercise-id="/);
  for (const action of ["exercise-toggle-favorite", "exercise-toggle-mark", "exercise-tags", "builder-pick-exercise"]) {
    assert.match(exercises, new RegExp(`data-action="${action}" data-exercise-id="`), action);
  }
});
