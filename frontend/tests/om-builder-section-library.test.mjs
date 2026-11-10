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

// B5b: the library toolbar. The Builder's view switches (with a mouse) and the big "Add custom exercise" button are
// 44 px; phones and short windows keep their own rules; the Exercise Library's switches are not touched.
const startB = css.lastIndexOf("/* =====", css.indexOf("Design: the section editor's library toolbar (B5b)"));
const endB = css.indexOf("\n/* =====", startB + 10);
const toolbar = css.slice(startB, endB < 0 ? undefined : endB).replace(/\/\*[\s\S]*?\*\//g, "");

test("B5b: the switches and Add custom exercise are 44 px, only in the Builder and only where the big controls show", () => {
  assert.ok(startB > 0, "the B5b block exists");
  assert.match(toolbar, /@media \(pointer: fine\) and \(min-width: 761px\) and \(min-height: 521px\) \{/);
  assert.match(toolbar, /@media \(min-width: 561px\) and \(min-height: 521px\) \{/);
  assert.match(toolbar, /\.builder-library-toolbar \.exercise-view-button \{[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(toolbar, /\.builder-library-toolbar \.exercise-view-switcher \{[^}]*padding: 1px;/);
  assert.match(toolbar, /\.builder-library-toolbar \.builder-exercise-search input \{[^}]*height: 48px;/);
  assert.match(toolbar, /\.builder-section-library \.builder-custom-exercise-button \{[^}]*min-height: var\(--om-tap-target\);[^}]*font-size: var\(--om-text-sm\);/);
  const selectors = [...toolbar.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(",")).map((s) => s.trim());
  assert.equal(selectors.length, 4);
  for (const selector of selectors) assert.match(selector, /^body:not\(\.athlete-mode\):not\(\.login-mode\) \.builder-(library-toolbar|section-library) \./, selector);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(toolbar), "no literal colour");
});
