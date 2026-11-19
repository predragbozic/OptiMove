// The batch switcher shows only the members the coach may open; the server
// sends the rest as hiddenCount (a number), said in one sentence so the
// on-screen count never claims the group is smaller than it is.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");

const two = [{ id: "A", athleteId: "1", athleteName: "Athlete One" }, { id: "B", athleteId: "2", athleteName: "Athlete Two" }];
const draft = (plans, hiddenCount) => ({ plan: { id: "A", status: "draft", planType: "weekly", batchId: "g" }, batch: { id: "g", plans, hiddenCount }, blocks: [] });
const content = () => document.querySelector("#content");
beforeEach(() => { state.activeTab = "builder"; state.athletes = []; });

test("1. two visible members and one hidden: the switcher counts the two and says one more is not shown", () => {
  state.builder = emptyBuilderState({ draft: draft(two, 1) });
  renderBuilder();
  const switcher = content().querySelector(".builder-batch-switcher");
  assert.match(switcher.textContent, /1 \/ 2/);
  assert.equal(content().querySelector("[data-builder-batch-hidden]").textContent, "1 other athlete in this group has a plan you can't open.");
  assert.equal(switcher.querySelectorAll(".builder-batch-pill").length, 2, "only the visible members are drawn");
  assert.equal(document.querySelector("#screenTitle").textContent, "Group builder");
});

test("2. only this member visible and two hidden: no switcher, the sentence alone, still a group", () => {
  state.builder = emptyBuilderState({ draft: draft([two[0]], 2) });
  renderBuilder();
  assert.equal(content().querySelector(".builder-batch-switcher"), null);
  assert.equal(content().querySelector("[data-builder-batch-hidden]").textContent, "2 other athletes in this group have plans you can't open.");
  assert.equal(document.querySelector("#screenTitle").textContent, "Group builder");
});

test("3. nothing hidden (or an older answer without the field): exactly as before", () => {
  for (const hidden of [0, undefined]) {
    state.builder = emptyBuilderState({ draft: draft(two, hidden) });
    renderBuilder();
    assert.equal(content().querySelector("[data-builder-batch-hidden]"), null);
    assert.match(content().querySelector(".builder-batch-switcher").textContent, /1 \/ 2/);
  }
  state.builder = emptyBuilderState({ draft: draft([two[0]], 0) });
  renderBuilder();
  assert.equal(content().querySelector("[data-builder-batch-hidden]"), null);
});
