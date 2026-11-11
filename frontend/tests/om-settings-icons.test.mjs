import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S7: Icons on a phone. The gallery's markup is unchanged (icon-gallery.actions pins it); only a phone block of CSS
// turns the list into a grid of tiles and keeps the category chips at the top. Browser proof:
// e2e/tests/settings-icons.test.mjs.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf("Design S7: Icons on a phone"), css.indexOf("/* End of design S7. */"));

test("the S7 block is phone-only and scoped to the coach app", () => {
  assert.ok(block.length > 0);
  assert.match(block, /@media \(max-width: 760px\) \{/);
  const selectors = block.split("\n").filter((l) => /^\s+[^\s/*].*\{$/.test(l) && !l.includes("@media"));
  assert.ok(selectors.length >= 6);
  for (const s of selectors) assert.ok(s.trim().startsWith("body:not(.athlete-mode):not(.login-mode) "), s);
});

test("the chips stick to the top and scroll sideways; the panel clips without breaking the stick", () => {
  assert.match(block, /\[data-icon-gallery-chips\] \{[^}]*position: sticky;[^}]*top: 0;[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;[^}]*overscroll-behavior-x: contain;/);
  assert.match(block, /\.icon-gallery\.panel \{\n    overflow: clip;\n  \}/);
});

test("the gallery is a grid of tiles whose Copy key fills the tile; the search words are not repeated on a tile", () => {
  assert.match(block, /\.icon-gallery-grid \{\n    grid-template-columns: repeat\(auto-fill, minmax\(84px, 1fr\)\);/);
  assert.match(block, /@media \(max-width: 359px\) \{\n    body:not\(\.athlete-mode\):not\(\.login-mode\) \.icon-gallery-grid \{\n      grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, "a 320 px phone keeps three to a row");
  assert.match(block, /\.icon-gallery-item \{\n    flex-direction: column;/);
  assert.match(block, /\.icon-gallery-text > small \{\n    display: none;\n  \}/);
  assert.match(block, /\.icon-gallery-item \.plain-button \{\n    width: 100%;/);
  assert.match(block, /\.icon-gallery-refused code \{\n    overflow-wrap: anywhere;\n  \}/, "a refused key wraps inside its tile");
  assert.ok(!/icon-gallery-refused[^{]*\{[^}]*display: none/.test(block), "and is never hidden");
});

test("a chip brings the start of its result under the chips, only when the count line is hidden", async () => {
  const scrolls = [];
  const rects = { chips: { top: 0, height: 60 }, count: { top: -900 } };
  const chips = { getBoundingClientRect: () => rects.chips };
  const count = { getBoundingClientRect: () => rects.count };
  const root = { querySelector: (s) => (s === "[data-icon-gallery-chips]" ? chips : s === "[data-icon-gallery-count]" ? count : null), querySelectorAll: () => [] };
  globalThis.document = { querySelector: (s) => (s === "[data-icon-gallery]" ? root : null), querySelectorAll: () => [] };
  globalThis.scrollBy = (x, y) => scrolls.push(y);
  globalThis.getComputedStyle = () => ({ position: "sticky" });
  const { handleIconGalleryAction } = await import("../icon-gallery.js");
  const { ICON_CATEGORIES } = await import("../icon-render.js");
  const chip = (id) => ({ dataset: { action: "icon-gallery-category", iconCategory: id } });
  await handleIconGalleryAction(chip(ICON_CATEGORIES[1].id));
  assert.deepEqual(scrolls, [-960], "the count line lands right under the 60 px of chips");
  rects.count = { top: 200 };
  await handleIconGalleryAction(chip(""));
  assert.deepEqual(scrolls, [-960], "nothing moves when the result's start is already in view");
  rects.count = { top: -50 };
  globalThis.getComputedStyle = () => ({ position: "static" });
  await handleIconGalleryAction(chip(ICON_CATEGORIES[0].id));
  assert.deepEqual(scrolls, [-960, -50], "on a computer (chips not sticky) it lands at the top of the screen");
});
