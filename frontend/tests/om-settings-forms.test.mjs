import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S1 (the design plan): the Settings forms. Fields, selects and buttons are 44 px, the selects look like the
// fields (16 px on a phone), a colour swatch is a 28 px circle with a 44 px target. Only Settings: swatches and
// selects are shared with the Builder and other screens. Browser proof: e2e/tests/settings-forms.test.mjs.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Settings forms (S1)"));
const end = css.indexOf("\n/* =====", start + 10);
const block = css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");

test("every rule is inside Settings, with shared colours", () => {
  assert.ok(start > 0, "the S1 block exists");
  const selectors = [...block.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(/,(?![^(]*\))/)).map((s) => s.trim());
  assert.ok(selectors.length >= 14, selectors.length);
  for (const selector of selectors) assert.match(selector, /^body:not\(\.athlete-mode\):not\(\.login-mode\) \.organization-view /, selector);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), "no literal colour");
});

test("fields, selects and buttons are 44 px; a select looks like a field and is 16 px on a phone", () => {
  assert.match(block, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="color"\]\):not\(\[type="hidden"\]\),\s*body:not\(\.athlete-mode\):not\(\.login-mode\) \.organization-view select \{[^}]*height: var\(--om-tap-target\);/);
  assert.match(block, /\.organization-view select \{[^}]*border: 1px solid var\(--line\);[^}]*border-radius: var\(--radius\);/);
  assert.match(block, /\.organization-view \.plain-button \{[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.organization-view \.text-action \{[^}]*min-width: var\(--om-tap-target\);[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.organization-view select\[aria-invalid="true"\] \{\s*border-color: var\(--danger\);/, "an invalid select stays red");
  assert.match(block, /\.organization-view \.data-sources select \{\s*font-size: 16px;/, "Data sources keeps 16 px");
  assert.match(block, /@media \(max-width: 760px\) \{\s*body:not\(\.athlete-mode\):not\(\.login-mode\) \.organization-view select \{\s*font-size: 16px;/);
});

test("a swatch is a 28 px circle whose ::after and custom input make a 44 px target", () => {
  assert.match(block, /\.pastel-swatch \{[^}]*box-sizing: border-box;[^}]*width: 28px;[^}]*height: 28px;/);
  assert.match(block, /\.pastel-swatch::after \{[^}]*position: absolute;[^}]*inset: -10px;[^}]*\}/);
  assert.doesNotMatch(block.match(/\.pastel-swatch::after \{[^}]*\}/)[0], /border-radius/, "a square target, so neighbours tile");
  assert.match(block, /\.pastel-swatch-custom input\[type="color"\] \{[^}]*inset: -10px;[^}]*width: var\(--om-tap-target\);/);
  assert.match(block, /\.pastel-palette-options \{[^}]*gap: var\(--om-space-4, 16px\);/);
});
