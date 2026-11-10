// Design: the calendar uses the shared tokens, and a week column's card keeps its title near the top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const from = css.indexOf("Design: the calendar uses the shared tokens.");
const end = css.indexOf("\n/* =====", from + 10);
const block = css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined);
const rules = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((x) => x.trim()), body: m[2] }));

test("the calendar's block is scoped to the calendar's own classes", () => {
  assert.ok(from > 0);
  const all = rules(block);
  assert.ok(all.length >= 3);
  for (const rule of all) for (const sel of rule.selectors) assert.match(sel, /^\.cc-/, sel);
});

test("columns, month cells, cards and the Filters button take the .om-card border; columns and cells its radius", () => {
  const all = rules(block);
  const of = (sel) => all.find((r) => r.selectors.includes(sel))?.body || "";
  for (const sel of [".cc-day-column", ".cc-month-cell", ".cc-card", ".cc-filters-toggle"]) assert.match(of(sel), /border-color: var\(--om-border-subtle\);/, sel);
  for (const sel of [".cc-day-column", ".cc-month-cell"]) assert.match(of(sel), /border-radius: var\(--om-radius-lg\);/, sel);
});

test("in a wide week column the type line is clamped to one line without widening the card", () => {
  const rule = rules(block).find((r) => r.selectors.includes(".cc-layout-wide .cc-week > .cc-day-column .cc-card-kind"));
  assert.ok(rule);
  assert.match(rule.body, /-webkit-line-clamp: 1;/);
  assert.match(rule.body, /min-width: 0;/);
  // nowrap would make the card as wide as the whole line and push the title out of its column.
  assert.doesNotMatch(rule.body, /white-space: nowrap/);
  // Which rendered cards it reaches is checked on the real render: central-calendar.actions test 8e.
});

// Design: no mid-word breaks in the week columns (a tablet's columns are about 100 px).
const wrapFrom = css.indexOf("Design: no mid-word breaks in the calendar's week columns");
const wrapEnd = css.indexOf("\n/* =====", wrapFrom + 10);
const wrap = css.slice(css.lastIndexOf("/*", wrapFrom), wrapEnd > 0 ? wrapEnd : undefined);

test("the week-column wrapping block reaches the week columns only (never the phone's day list or the time grid)", () => {
  assert.ok(wrapFrom > 0);
  const all = rules(wrap);
  assert.ok(all.length >= 5);
  for (const rule of all) for (const sel of rule.selectors) assert.match(sel, /^(\.cc-layout-medium )?\.cc-week /, sel);
});

test("a title breaks a word only when it must; pills stay on one line; nothing sizes a card past its column", () => {
  const all = rules(wrap);
  const of = (sel) => all.find((r) => r.selectors.includes(sel))?.body || "";
  assert.match(of(".cc-week .cc-card-title"), /overflow-wrap: break-word;/);
  assert.doesNotMatch(wrap, /overflow-wrap: anywhere/);
  for (const sel of [".cc-week .cc-team-pill-name", ".cc-week .cc-card-meta .cc-badge"]) {
    assert.match(of(sel), /white-space: nowrap;/, sel);
    assert.match(of(sel), /text-overflow: ellipsis;/, sel);
    assert.match(of(sel), /overflow: hidden;/, sel);
  }
  // Without these three tracks a one-line pill or a long word widens the card past its column
  // (seen in the browser at 900 px: the card body's track was 82 px inside a 73 px body).
  for (const sel of [".cc-week .cc-day-column", ".cc-week .cc-day-cards", ".cc-week .cc-card-body"]) {
    assert.match(of(sel), /grid-template-columns: minmax\(0, 1fr\);/, sel);
  }
  assert.match(of(".cc-layout-medium .cc-week .cc-card-title"), /font-size: var\(--om-text-sm\);/);
});
