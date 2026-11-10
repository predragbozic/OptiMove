import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B4 (owner's Builder plan): the start screen. Every control of "Continue where you left off" is 44 px and both
// Discards are buttons, not 12 px words. data-* unchanged. Browser proof: e2e/tests/builder-start-screen.test.mjs.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const view = read("builder-view.js");
const css = read("styles.css");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Builder's start screen (B4)"));
const end = css.indexOf("\n/* =====", start + 10);
const rules = css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");

test("both Discards are buttons with their actions unchanged", () => {
  assert.match(view, /<button class="plain-button builder-draft-discard danger-action" type="button" data-action="builder-discard-selected-drafts">/);
  assert.match(view, /<button class="plain-button builder-draft-discard danger-action" type="button" data-action="builder-discard-draft" data-plan-ids="/);
  assert.ok(!/text-action danger-action" type="button" data-action="builder-discard-(selected-drafts|draft)"/.test(view));
});

test("every rule is the drafts panel's own (the shared check box keeps its size elsewhere)", () => {
  const selectors = [...rules.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(",")).map((s) => s.trim());
  assert.ok(selectors.length >= 12, selectors.length);
  for (const selector of selectors) assert.ok(selector.startsWith("body:not(.athlete-mode):not(.login-mode) .builder-drafts-panel "), selector);
});

test("44 px controls; on a phone a draft's actions take their own row", () => {
  assert.match(rules, /\.builder-drafts-toggle \{\s*min-height: var\(--om-tap-target\);/);
  assert.match(rules, /\.checkbox-toggle-all \{\s*width: var\(--om-tap-target\);\s*height: var\(--om-tap-target\);/);
  assert.match(rules, /\.builder-draft-discard \{\s*min-height: var\(--om-tap-target\);/);
  const phone = rules.slice(rules.indexOf("@media (max-width: 560px)"));
  assert.match(phone, /\.builder-draft-actions \{\s*grid-column: 1 \/ -1;/);
});
