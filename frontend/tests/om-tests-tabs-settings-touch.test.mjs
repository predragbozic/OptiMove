// Design: the Tests module's coach tabs use the shared tab row (.om-tabs), and every control in a
// Settings row or list header is a 44 px touch target on a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderTestsTabsHtml } = await import("../tests-view.js");
const { state } = await import("../state.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../tests-view.js", import.meta.url), "utf8");
const block = (start) => { const from = css.indexOf(start); assert.ok(from > 0, start); const next = css.indexOf("/* ====", from + start.length); const nextDesign = css.indexOf("\n/* Design", from + start.length); const ends = [next, nextDesign].filter((i) => i > 0); return css.slice(from, ends.length ? Math.min(...ends) : undefined); };

const tabs = (section) => {
  state.tests.section = section;
  const host = document.createElement("div");
  host.innerHTML = renderTestsTabsHtml();
  return host.querySelector("nav");
};

test("the coach's Tests tabs are a shared .om-tabs row with the active tab marked", () => {
  document.body.classList.remove("athlete-mode");
  const nav = tabs("results");
  assert.equal(nav.className, "tests-section-tabs om-tabs");
  const buttons = [...nav.querySelectorAll("button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Today", "Schedule", "Results", "Test Library"]);
  assert.ok(buttons.every((b) => b.classList.contains("om-tab") && !b.classList.contains("tab")));
  assert.ok(buttons.every((b) => b.dataset.action === "tests-section"));
  assert.deepEqual(buttons.filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.dataset.section), ["results"]);
  assert.equal(nav.querySelector("svg"), null, "no icon cards any more");
  assert.doesNotMatch(view, /TESTS_TAB_ICONS|tests-tab-icon/);
  assert.doesNotMatch(css, /tests-section-tabs-icon \.tab \{|\n\.tests-tab-icon \{/);
});

test("the athlete's Tests tabs keep their own look", () => {
  document.body.classList.add("athlete-mode");
  const nav = tabs("upcoming");
  document.body.classList.remove("athlete-mode");
  assert.equal(nav.className, "tabs tests-section-tabs");
  const buttons = [...nav.querySelectorAll("button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Today", "Upcoming", "History"]);
  assert.ok(buttons.every((b) => b.classList.contains("tab") && !b.classList.contains("om-tab")));
  assert.ok(nav.querySelector('[data-section="upcoming"]').classList.contains("is-active"));
});

test("renderTests keeps the active tab in view on a phone", () => {
  assert.match(view, /import \{ revealActiveTab \} from "\.\/om-tabs\.js";/);
  assert.match(view, /revealActiveTab\(els\.content\);\n\}/);
});

test("on a phone every control in a Settings row or list header is a 44 px touch target", () => {
  const touch = block("/* Design: on a phone every control in a Settings row and list header");
  assert.match(touch, /@media \(max-width: 760px\)/);
  for (const sel of [
    ".organization-view .organization-row-main {\n    min-height: var(--om-tap-target);",
    ".organization-view .organization-row-actions .plain-button,",
    ".organization-view .organization-browser-actions .plain-button,",
    ".organization-view .organization-row-actions .text-action,",
    ".organization-view .tag-chip-head .text-action {\n    min-height: var(--om-tap-target);",
    ".organization-view .organization-row-actions .icon-button {\n    min-width: var(--om-tap-target);",
  ]) assert.ok(touch.includes(sel), sel);
  assert.match(touch, /\.athlete-login-toggle::after \{\n\s+content: "";\n\s+position: absolute;\n\s+inset: calc\(\(var\(--om-tap-target\) - 100%\) \/ -2\) -4px;/);
});
