// Manager, 2026-11-15: Imports shows no Club/Team/Athletes Filter (it does nothing there) and no line about it; Overview,
// Activities and Athletes keep the working Filter, and Dashboards keeps its disabled one with its note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../training-load-view.js", import.meta.url), "utf8");
// Roles V-1: a view workspace (viewOnly) gets no Filter either.
const start = src.indexOf('${space === "dataConfig" || section === "imports" || viewOnly ? ""');
const block = src.slice(start, src.indexOf("renderDataAnalysisSubNavHtml(section)", start));

test("the Filter: none on Imports or Data configuration, working on Dashboards, working everywhere else", () => {
  assert.ok(start > 0, "the shell's filter control is chosen in one place");
  assert.match(block, /^\$\{space === "dataConfig" \|\| section === "imports" \|\| viewOnly \? ""/, "Imports, Data configuration and a view workspace get nothing");
  assert.match(block, /: `<button type="button" class="plain-button compact-button training-load-filter-button \$\{count \? "is-active" : ""\}" data-action="training-load-filter-open">Filter/, "every other section: the working Filter");
  assert.doesNotMatch(block, /disabled aria-disabled="true"|not available for Dashboards/);
  assert.doesNotMatch(src, /filters do not apply to Imports/, "no line about Imports");
});

test("Overview, Activities and Athletes render the working Filter; Imports renders none", async () => {
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
  globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };
  const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
  const { emptyTrainingLoadState, state } = await import("../state.js");
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  for (const [section, has] of [["overview", true], ["activities", true], ["athletes", true], ["imports", false]]) {
    state.trainingLoad = emptyTrainingLoadState();
    state.trainingLoad.section = section;
    let html = "";
    try { html = renderTrainingLoadCoachHtml(); } catch (error) { assert.fail(`${section}: ${error.message}`); }
    assert.equal(/data-action="training-load-filter-open">Filter/.test(html), has, section);
  }
});
