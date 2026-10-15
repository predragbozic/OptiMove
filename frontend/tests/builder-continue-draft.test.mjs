import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { handleBuilderPlanAction } = await import("../builder-actions.js");
const { renderBuilder, renderBuilderDraftOpenProgress } = await import("../builder-view.js");
const action = (planId = "draft-a") => ({ dataset: { action: "builder-open-draft", planId }, disabled: false });
const draft = (id = "draft-a") => ({ plan: { id, name: "Resumed plan", planType: "weekly", status: "draft", athleteName: "Ana Test" }, blocks: [] });
const response = (body) => ({ ok: true, json: async () => body });
const handlers = { renderBuilder, renderBuilderDraftOpenProgress, loadBuilderExercises: () => assert.fail("Opening a draft must not wait for exercise search") };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  state.activeTab = "builder";
  state.athletes = [];
  state.builder = emptyBuilderState({ draftsOpen: true, drafts: [{ groupKey: "a", openPlanId: "draft-a", name: "Saved draft", planIds: ["draft-a"] }, { groupKey: "b", openPlanId: "draft-b", name: "Another draft", planIds: ["draft-b"] }] });
  globalThis.fetch = async () => { throw new Error("Unexpected request"); };
  renderBuilder();
});
test("Continue opens the actual draft on the first click without exercise requests", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return response(draft()); };
  await handleBuilderPlanAction(action(), handlers);
  assert.deepEqual(calls, ["/api/builder/plans/draft-a"]);
  assert.ok(document.querySelector(".builder-workspace"));
  assert.equal(document.querySelector('[aria-label="Weekly plan name"]').value, "Resumed plan");
  assert.equal(document.querySelector(".builder-drafts-panel"), null);
  assert.equal(state.builder.openingDraftId, "");
});
test("progress is immediate, survives a list re-render and blocks a fresh second Continue", async () => {
  const request = deferred(); let calls = 0;
  globalThis.fetch = async () => { calls++; return request.promise; };
  const pending = handleBuilderPlanAction(action(), handlers);
  assert.equal(document.querySelector('[data-plan-id="draft-a"]').textContent, "Opening...");
  assert.equal(document.querySelector("[role=status]").hidden, false);
  assert.ok(document.querySelector(".builder-entry-tiles").hasAttribute("inert"));
  renderBuilder();
  assert.equal(document.querySelectorAll('[data-action="builder-open-draft"]:disabled').length, 2);
  await handleBuilderPlanAction(action("draft-b"), handlers);
  request.resolve(response(draft())); await pending;
  assert.equal(calls, 1);
  assert.equal(state.builder.draft.plan.id, "draft-a");
});
test("failure restores Continue and entry controls, surfaces the error and permits retry", async () => {
  globalThis.fetch = async () => { throw new Error("Offline"); };
  await assert.rejects(handleBuilderPlanAction(action(), handlers), /Offline/);
  assert.equal(state.builder.draft, null);
  assert.equal(state.builder.openingDraftId, "");
  assert.equal(document.querySelectorAll('[data-action="builder-open-draft"]:disabled').length, 0);
  assert.equal(document.querySelector(".builder-entry-tiles").hasAttribute("inert"), false);
  assert.equal(document.querySelector("[role=status]").hidden, true);
  globalThis.fetch = async () => response(draft());
  await handleBuilderPlanAction(action(), handlers);
  assert.equal(state.builder.draft.plan.id, "draft-a");
});
test("late response cannot replace another view or another Builder", async () => {
  for (const change of [() => { state.activeTab = "coach-home"; }, () => { state.builder = emptyBuilderState({ draft: draft("other") }); }]) {
    state.activeTab = "builder"; state.builder = emptyBuilderState();
    const request = deferred(); const entered = deferred();
    globalThis.fetch = async () => { entered.resolve(); return request.promise; };
    const pending = handleBuilderPlanAction(action(), { renderBuilder: () => assert.fail("Stale render") });
    await entered.promise; change(); request.resolve(response(draft())); await pending;
    assert.notEqual(state.builder.draft?.plan.id, "draft-a");
  }
});
test("group draft preserves its own batch navigation on resume", async () => {
  const data = { ...draft(), batch: { id: "group", plans: [{ id: "draft-a", athleteName: "Ana Test", athleteId: "a" }, { id: "draft-b", athleteName: "Marko Test", athleteId: "b" }] } };
  globalThis.fetch = async () => response(data);
  await handleBuilderPlanAction(action(), handlers);
  assert.equal(document.querySelectorAll(".builder-batch-pill").length, 2);
  assert.equal(document.querySelector("#screenTitle").textContent, "Group builder");
});
