import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// T2: the Tests session, schedule and result screens (coach). Browser proof, on a seeded check-in: e2e/tests/tests-t2.test.mjs.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf("Design T2: the Tests session"), css.indexOf("/* End of design T2. */"));
const view = readFileSync(new URL("../tests-view.js", import.meta.url), "utf8");

test("the T2 block is coach-only", () => {
  assert.ok(block.length > 0);
  const selectors = block.split("\n").filter((l) => /^\s*[^\s/*@].*[{,]$/.test(l)).map((l) => l.trim());
  assert.ok(selectors.length >= 7);
  for (const s of selectors) assert.ok(s.startsWith("body:not(.athlete-mode):not(.login-mode) "), s);
});

test("every Tests button and the reminder's Select all / Clear are 44 px; reminder rows are 44 px with a 20 px box", () => {
  assert.match(block, /\.tests-shell \.plain-button,\nbody:not\(\.athlete-mode\):not\(\.login-mode\) \.tests-reminder-select-actions \.text-action \{\n  min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.tests-reminder-row \{[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.tests-reminder-checkbox \{[^}]*width: 20px;\n  height: 20px;/);
});

test("Today follows the week's arrows; clock times have no seconds", () => {
  const nav = view.slice(view.indexOf('<div class="tests-weekly-nav">'), view.indexOf('<div class="tests-weekly-strip"'));
  assert.ok(nav.indexOf("tests-weekly-next-week") < nav.indexOf("tests-weekly-today-button"), "Today after the next arrow");
  assert.ok(!nav.slice(nav.indexOf("tests-weekly-range"), nav.indexOf("tests-weekly-next-week")).includes("Today"), "not inside the range");
  assert.match(view, /function clockTime\(value\) \{\n  return String\(value \|\| ""\)\.slice\(0, 5\);/);
  assert.equal((view.match(/escapeHtml\(schedule\.opensTime\)/g) || []).length, 0, "every shown opensTime goes through clockTime");
});

test("one noun, check-ins; an empty Results day says when results come and offers Today", () => {
  for (const now of ["New check-in schedule", "Edit check-in schedule", "No check-ins scheduled for this day.", "No check-in results yet.",
    "No results for this day. Results appear here once athletes complete a check-in."]) assert.ok(view.includes(now), now);
  assert.ok(!/wellness schedule|wellness check-ins|wellness results/i.test(view), "no second noun left");
  assert.ok(view.includes('emptyAgendaAction: `<button class="om-btn" type="button" data-action="tests-section" data-section="today">See today\'s check-ins</button>`'));
});

test("the pickers' round Cancel / Confirm stay 44 x 44, and the reminder list has no capped inner scroll", () => {
  assert.match(block, /\.tests-shell \.builder-athlete-picker-continue \{\n  width: var\(--om-tap-target\);\n  min-width: var\(--om-tap-target\);\n  height: var\(--om-tap-target\);/);
  assert.match(block, /\.tests-reminder-list \{\n  max-height: none;\n  overflow: visible;/);
});
