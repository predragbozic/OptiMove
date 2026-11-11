import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// T1: the Tests week pager and Schedule toolbar (coach). Browser proof: e2e/tests/tests-t1.test.mjs.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf("Design T1: the Tests week pager"), css.indexOf("/* End of design T1. */"));
const view = readFileSync(new URL("../tests-view.js", import.meta.url), "utf8");

test("the T1 block is coach-only", () => {
  assert.ok(block.length > 0);
  const selectors = block.split("\n").filter((l) => /^\s*[^\s/*@].*[{,]$/.test(l)).map((l) => l.trim());
  assert.ok(selectors.length >= 8);
  for (const s of selectors) assert.ok(s.startsWith("body:not(.athlete-mode):not(.login-mode) "), s);
});

test("the arrows sit next to the week, and every pager and toolbar control is 44 px", () => {
  assert.match(block, /\.tests-weekly-nav \{\n  justify-content: center;\n\}/);
  assert.match(block, /\.tests-weekly-range \{\n  flex: 0 1 auto;\n\}/);
  for (const s of [".tests-weekly-arrow,", ".tests-weekly-today-button,", ".tests-schedule-toolbar .plain-button,", ".tests-shell .om-btn {"]) assert.ok(block.includes(s), s);
  assert.match(block, /\.tests-shell \.om-btn \{\n  min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.tests-show-cancelled-toggle \{\n  min-height: var\(--om-tap-target\);/);
});

test("Show cancelled stays a native checkbox (its handler reads .checked), drawn as a switch", () => {
  assert.ok(view.includes('<input type="checkbox" role="switch" data-action="tests-toggle-show-cancelled"'));
  assert.ok(view.includes("<span>Show cancelled schedules</span>"));
  assert.match(block, /\.tests-show-cancelled-toggle input \{\n  -webkit-appearance: none;\n  appearance: none;/);
  assert.match(block, /border: 1px solid var\(--muted\);/, "the off track's edge is readable (3:1)");
  assert.match(block, /input:checked \{\n  border-color: var\(--accent\);/);
});

test("one title: the coach's eyebrow names the area; the hard-coded labels say wellness, not WELLNESS", () => {
  assert.ok(view.includes('els.context.textContent = isAthleteMode() ? "Tests" : "Testing and wellness";'));
  for (const old of ["New WELLNESS schedule", "No WELLNESS scheduled", "Edit WELLNESS schedule", "No WELLNESS results"]) assert.ok(!view.includes(old), old);
  // T2 settled the noun: "check-ins" for the wellness questionnaire.
  for (const now of ["New check-in schedule", "No check-ins scheduled for this day.", "Edit check-in schedule", "No check-in results yet."]) assert.ok(view.includes(now), now);
});
