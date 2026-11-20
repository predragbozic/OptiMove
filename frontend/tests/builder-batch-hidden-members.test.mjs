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

// #653, #664 and the batch edit (step 2) together. A reopened, published
// WEEKLY member of a group asks at Save who gets the changes (step 2's panel
// replaces #653's sentence); a reopened PROGRAM member keeps "Changes go to
// this athlete only."; the hidden members are still counted in both.
const editDraft = (plans, hiddenCount, planType = "weekly") => ({
  plan: { id: "A-edit", status: "draft", planType, isEditDraft: true, editSourcePlanId: "A", batchId: "g", athleteName: "Athlete One" },
  batch: { id: "g", plans, hiddenCount }, blocks: [],
});

test("4. a reopened weekly member with another visible member and one hidden: the step 2 panel counts the group, and the hidden sentence follows", () => {
  state.builder = emptyBuilderState({ draft: editDraft(two, 1) });
  renderBuilder();
  assert.equal(content().querySelector(".builder-batch-switcher"), null);
  assert.equal(content().querySelector('[data-action="builder-toggle-batch-sync"]'), null);
  assert.equal(content().querySelector("[data-builder-batch-edit-note]"), null);
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Athlete One is one of 3 athletes in this group\./);
  assert.equal(content().querySelector("[data-builder-batch-hidden]")?.textContent, "1 other athlete in this group has a plan you can't open.");
  // The question counts only the athletes the change can reach.
  state.builder.batchEditChoice = { stage: "scope" };
  renderBuilder();
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Apply these changes to all 2 athletes you can edit\?/);
});

test("5. a reopened member that is the only one this coach may open: no group question, both sentences", () => {
  for (const planType of ["weekly", "program"]) {
    state.builder = emptyBuilderState({ draft: editDraft([two[0]], 2, planType) });
    renderBuilder();
    assert.equal(content().querySelector("[data-builder-batch-edit]"), null, planType);
    assert.equal(content().querySelector("[data-builder-batch-edit-note]")?.textContent, "Changes go to this athlete only.", planType);
    assert.equal(content().querySelector("[data-builder-batch-hidden]")?.textContent, "2 other athletes in this group have plans you can't open.", planType);
  }
});

test("6. nothing hidden: a weekly member gets the step 2 panel as before; a program member keeps #653's sentence; a plan alone gets neither", () => {
  state.builder = emptyBuilderState({ draft: editDraft(two, 0) });
  renderBuilder();
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /is one of 2 athletes in this group/);
  assert.equal(content().querySelector("[data-builder-batch-hidden]"), null);
  state.builder = emptyBuilderState({ draft: editDraft(two, 1, "program") });
  renderBuilder();
  assert.equal(content().querySelector("[data-builder-batch-edit-note]")?.textContent, "Changes go to this athlete only.");
  assert.equal(content().querySelector("[data-builder-batch-hidden]")?.textContent, "1 other athlete in this group has a plan you can't open.");
  state.builder = emptyBuilderState({ draft: editDraft([two[0]], 0) });
  renderBuilder();
  assert.equal(content().querySelector("[data-builder-batch-edit]"), null);
  assert.equal(content().querySelector("[data-builder-batch-edit-note]"), null);
  assert.equal(content().querySelector("[data-builder-batch-hidden]"), null);
});
