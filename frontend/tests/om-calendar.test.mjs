// Design: the calendar uses the shared tokens, and a week column's card keeps its title near the top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

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

test("in a week column the type line is clamped to one line without widening the card", () => {
  const rule = rules(block).find((r) => r.selectors.includes(".cc-week .cc-card-kind"));
  assert.ok(rule);
  assert.match(rule.body, /-webkit-line-clamp: 1;/);
  assert.match(rule.body, /min-width: 0;/);
  // nowrap would make the card as wide as the whole line and push the title out of its column.
  assert.doesNotMatch(rule.body, /white-space: nowrap/);
  // The selector reaches the week columns only, never the phone's day list or the time grid.
  const dom = new JSDOM('<div class="cc-week"><span class="cc-card-kind" id="a"></span></div><div class="cc-day-list"><span class="cc-card-kind" id="b"></span></div>');
  assert.equal(dom.window.document.querySelector("#a").matches(".cc-week .cc-card-kind"), true);
  assert.equal(dom.window.document.querySelector("#b").matches(".cc-week .cc-card-kind"), false);
});
