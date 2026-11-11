import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// T3a: the coach's Test Library and the way back from a result. Browser proof: e2e/tests/tests-t3a.test.mjs.
const dom = new JSDOM("<!doctype html><body><main id=content></main></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { handleTestsLibraryInput, renderWellnessFormPageHtml, renderTestsSectionHtml } = await import("../tests-view.js");
const { state } = await import("../state.js");
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

function renderLibrary(library, search = "") {
  dom.window.document.body.className = "";
  state.tests.form = null;
  state.tests.section = "library";
  state.tests.library = library;
  state.tests.librarySearch = search;
  const root = dom.window.document.getElementById("content");
  root.innerHTML = renderTestsSectionHtml();
  return root;
}

test("read-only is said once; the note names what can be scheduled and where; only those tests carry a pill", () => {
  let root = renderLibrary({ tests: [{ name: "WELLNESS", schedulable: true }, { name: "Deep Squat" }], batteries: [{ name: "FMS" }] });
  assert.equal(root.querySelector(".tests-library-note").textContent,
    "The library is read-only. WELLNESS can be scheduled from the Schedule tab; the other tests and batteries are here for reference.");
  assert.deepEqual([...root.querySelectorAll(".tests-status-pill")].map((p) => p.textContent), ["Can be scheduled"]);
  assert.equal(root.querySelector(".tests-status-pill").className, "tests-status-pill", "a neutral pill, not a completed status");
  assert.ok(!root.innerHTML.includes("Read-only</span>"), "no Read-only badge on a row");
  root = renderLibrary({ tests: [{ name: "A", schedulable: true }, { name: "B", schedulable: true }, { name: "C", schedulable: true }], batteries: [] });
  assert.match(root.querySelector(".tests-library-note").textContent, /^The library is read-only\. A, B and C can be scheduled from the Schedule tab;/);
  root = renderLibrary({ tests: [{ name: "Deep Squat" }], batteries: [{ name: "FMS", schedulable: true }] });
  assert.equal(root.querySelector(".tests-library-note").textContent, "The library is read-only. Nothing here can be scheduled yet.");
  assert.equal(root.querySelectorAll(".tests-status-pill").length, 0, "a battery never carries the pill");
});

test("the headings carry only the count, and the empty line is announced", () => {
  const root = renderLibrary({ tests: [{ name: "Deep Squat" }, { name: "Shoulder Mobility" }], batteries: [{ name: "FMS" }] }, "squat");
  const headings = [...root.querySelectorAll("[data-tests-library-group] > h3")].map((h) => h.textContent.trim());
  assert.deepEqual(headings, ["Tests \u00b7 1", "Batteries \u00b7 0"]);
  assert.equal(root.querySelectorAll("[data-tests-library-group]")[1].hidden, true);
  const empty = root.querySelector("[data-tests-library-empty]");
  assert.equal(empty.getAttribute("aria-live"), "polite");
  assert.equal(empty.getAttribute("role"), "status");
  state.tests.librarySearch = "";
});

test("the search narrows the rows in place, updates the counts and says when nothing matches", () => {
  const root = dom.window.document.getElementById("content");
  root.innerHTML = `<div data-tests-library>
    <input data-tests-library-search>
    <section data-tests-library-group><span data-tests-library-count>· 3</span>
      <li data-tests-library-row data-search-text="deep squat "></li><li data-tests-library-row data-search-text="shoulder mobility "></li><li data-tests-library-row data-search-text="wellness daily check-in"></li></section>
    <section data-tests-library-group><span data-tests-library-count>· 1</span>
      <li data-tests-library-row data-search-text="functional movement screen "></li></section>
    <p data-tests-library-empty hidden></p></div>`;
  const input = root.querySelector("[data-tests-library-search]");
  input.value = "Shoulder";
  assert.equal(handleTestsLibraryInput(input), true);
  const rows = [...root.querySelectorAll("[data-tests-library-row]")];
  assert.deepEqual(rows.map((r) => r.hidden), [true, false, true, true]);
  const counts = [...root.querySelectorAll("[data-tests-library-count]")].map((c) => c.textContent);
  assert.deepEqual(counts, ["\u00b7 1", "\u00b7 0"]);
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
  // Through the real section render: a coach on Results reads "Back to results", elsewhere "Back"; an athlete the icon.
  state.tests.form = form;
  state.tests.section = "results";
  dom.window.document.body.className = "";
  assert.match(renderTestsSectionHtml(), /tests-result-back" data-action="tests-close-assignment">&larr; Back to results<\/button>/);
  state.tests.section = "today";
  assert.match(renderTestsSectionHtml(), /tests-result-back" data-action="tests-close-assignment">&larr; Back<\/button>/);
  dom.window.document.body.className = "athlete-mode";
  const athleteSection = renderTestsSectionHtml();
  assert.match(athleteSection, /wellness-back" data-action="tests-close-assignment" aria-label="Back">&larr;/);
  assert.ok(!athleteSection.includes("tests-result-back"));
  dom.window.document.body.className = "";
  state.tests.form = null;
});
