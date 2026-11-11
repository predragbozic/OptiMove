import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// T3a: the coach's Test Library and the way back from a result. Browser proof: e2e/tests/tests-t3a.test.mjs.
const dom = new JSDOM("<!doctype html><body><main id=content></main></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { handleTestsLibraryInput, renderWellnessFormPageHtml } = await import("../tests-view.js");
const { state } = await import("../state.js");
const view = readFileSync(new URL("../tests-view.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf("Design T3a: the coach's Test Library"), css.indexOf("/* End of design T3a. */"));

test("the T3a block is coach-only and makes the search field and the rows 44 px", () => {
  assert.ok(block.length > 0);
  // Every T3a selector starts at the line's start (there is no @media in it); comment lines are indented.
  const selectors = block.split("\n").slice(1).filter((l) => /^[^\s/*@].*[{,]$/.test(l));
  assert.ok(selectors.length >= 8);
  for (const s of selectors) assert.ok(s.startsWith("body:not(.athlete-mode):not(.login-mode) "), s);
  assert.match(block, /\.tests-library-search input \{\n  min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.tests-library-row \{[^}]*min-height: var\(--om-tap-target\);/);
});

test("read-only is said once; only the schedulable test carries a pill", () => {
  assert.ok(!view.includes('<span class="tests-status-pill">Read-only</span>'), "no Read-only badge on a row");
  assert.ok(view.includes("The library is read-only. You can schedule the wellness check-in; the other tests and batteries are here for reference."));
  assert.match(view, /kind === "test" && item\.schedulable \? `<span class="tests-status-pill tests-status-completed">Can be scheduled<\/span>` : ""/);
});

test("the search narrows the rows in place, updates the counts and says when nothing matches", () => {
  const root = dom.window.document.getElementById("content");
  root.innerHTML = `<div data-tests-library>
    <input data-tests-library-search>
    <section data-tests-library-group><span data-tests-library-count data-kind="test">3 tests</span>
      <li data-tests-library-row data-search-text="deep squat "></li><li data-tests-library-row data-search-text="shoulder mobility "></li><li data-tests-library-row data-search-text="wellness daily check-in"></li></section>
    <section data-tests-library-group><span data-tests-library-count data-kind="battery">1 battery</span>
      <li data-tests-library-row data-search-text="functional movement screen "></li></section>
    <p data-tests-library-empty hidden></p></div>`;
  const input = root.querySelector("[data-tests-library-search]");
  input.value = "Shoulder";
  assert.equal(handleTestsLibraryInput(input), true);
  const rows = [...root.querySelectorAll("[data-tests-library-row]")];
  assert.deepEqual(rows.map((r) => r.hidden), [true, false, true, true]);
  const counts = [...root.querySelectorAll("[data-tests-library-count]")].map((c) => c.textContent);
  assert.deepEqual(counts, ["1 test", "0 batteries"]);
  assert.equal(root.querySelectorAll("[data-tests-library-group]")[1].hidden, true, "a group with no match is hidden");
  input.value = "nothing like this";
  handleTestsLibraryInput(input);
  assert.equal(root.querySelector("[data-tests-library-empty]").hidden, false);
  input.value = "";
  handleTestsLibraryInput(input);
  assert.ok(rows.every((r) => !r.hidden));
  assert.equal(state.tests.librarySearch, "");
  assert.equal(handleTestsLibraryInput(root), false, "any other input is not this handler's");
});

test("a coach's result says where back goes; an athlete and the check-in page keep the icon", () => {
  const form = { result: { wellnessScore: 3.2 }, athleteName: "Ana Example", testName: "WELLNESS" };
  const coach = renderWellnessFormPageHtml(form, { backLabel: "Back to results" });
  assert.match(coach, /<button type="button" class="plain-button compact-button tests-result-back" data-action="tests-close-assignment">&larr; Back to results<\/button>/);
  assert.ok(!coach.includes('aria-label="Back">&larr;'));
  const athlete = renderWellnessFormPageHtml(form);
  assert.match(athlete, /class="plain-button icon-button wellness-back" data-action="tests-close-assignment" aria-label="Back">&larr;<\/button>/);
  assert.ok(!athlete.includes("tests-result-back"));
  assert.match(view, /backLabel: isAthleteMode\(\) \? "" : state\.tests\.section === "results" \? "Back to results" : "Back"/);
});
