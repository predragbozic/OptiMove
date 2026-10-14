import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="content"></div>');
globalThis.document = dom.window.document;
const { state, emptyBuilderState } = await import("../state.js");
const { handleBuilderPlanAction } = await import("../builder-actions.js");
const { renderBuilderBatchSwitcher, renderBuilderBatchSwitchProgress } = await import("../builder-view.js");
const plans = [{ id: "A", athleteId: "1", athleteName: "Ana Test" }, { id: "B", athleteId: "2", athleteName: "Marko Test" }, { id: "C", athleteId: "3", athleteName: "Nikola Test" }];
const draft = (id) => ({ plan: { id, status: "draft", planType: "weekly" }, batch: { plans }, blocks: [] });
const action = (id) => ({ dataset: { action: "builder-open-batch-plan", planId: id }, disabled: false });
const response = (body) => ({ ok: true, json: async () => body });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draft("A"), selectedNodeId: "old-section" });
  state.athletes = [{ athlete_id: "1", athlete_image_url: "/avatar.png" }];
  document.querySelector("#content").innerHTML = "";
  globalThis.fetch = async () => { throw new Error("Unexpected request"); };
});
test("switch flushes before GET and redraws the full plan without fetching exercise library", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return response(draft("B")); };
  await handleBuilderPlanAction(action("B"), {
    flushBuilderAutosaves: async () => { calls.push("flush"); },
    renderBuilderBatchSwitchProgress: () => { calls.push(state.builder.batchSwitchPending?.stage || "idle"); },
    renderBuilder: () => { assert.equal(state.builder.draft.plan.id, "B"); calls.push("render"); },
    loadBuilderExercises: () => assert.fail("No exercise request needed to switch plans"),
  });
  assert.deepEqual(calls, ["saving", "flush", "opening", "/api/builder/plans/B", "render", "idle"]);
  assert.equal(state.builder.selectedNodeId, "");
  assert.equal(state.builder.batchSwitchPending, null);
});
test("a fresh repeated click is ignored while autosave is pending, without repainting forms", async () => {
  const flush = deferred(); let gets = 0; let renders = 0;
  globalThis.fetch = async () => { gets++; return response(draft("B")); };
  const handlers = { flushBuilderAutosaves: () => flush.promise, renderBuilder() { renders++; } };
  const pending = handleBuilderPlanAction(action("B"), handlers);
  await handleBuilderPlanAction(action("C"), handlers);
  assert.equal(gets, 0); assert.equal(renders, 0);
  flush.resolve(); await pending;
  assert.equal(gets, 1); assert.equal(renders, 1); assert.equal(state.builder.draft.plan.id, "B");
});
test("autosave failure prevents GET, keeps the original plan and unlocks navigation", async () => {
  const button = action("B");
  await handleBuilderPlanAction(button, { flushBuilderAutosaves: async () => { throw new Error("Save failed"); }, renderBuilder() {} });
  assert.equal(state.builder.draft.plan.id, "A");
  assert.equal(state.builder.error, "Save failed");
  assert.equal(state.builder.batchSwitchPending, null); assert.equal(button.disabled, false);
});
test("network failure keeps the original plan and allows retry", async () => {
  await handleBuilderPlanAction(action("B"), { flushBuilderAutosaves: async () => {}, renderBuilder() {} });
  assert.equal(state.builder.draft.plan.id, "A"); assert.equal(state.builder.batchSwitchPending, null);
  globalThis.fetch = async () => response(draft("B"));
  await handleBuilderPlanAction(action("B"), { flushBuilderAutosaves: async () => {}, renderBuilder() {} });
  assert.equal(state.builder.draft.plan.id, "B");
});
test("404 drops the missing copy rather than leaving a dead navigation button", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "Missing" }) });
  await handleBuilderPlanAction(action("B"), { flushBuilderAutosaves: async () => {}, renderBuilder() {} });
  assert.equal(state.builder.draft.plan.id, "A");
  assert.equal(state.builder.draft.batch.plans.some((p) => p.id === "B"), false);
});
test("late response cannot replace another view or a newly opened Builder", async () => {
  for (const change of [() => { state.activeTab = "coach-home"; }, () => { state.builder = emptyBuilderState({ draft: draft("C") }); }]) {
    state.activeTab = "builder"; state.builder = emptyBuilderState({ draft: draft("A") });
    const request = deferred(); const entered = deferred();
    globalThis.fetch = async () => { entered.resolve(); return request.promise; };
    const pending = handleBuilderPlanAction(action("B"), { flushBuilderAutosaves: async () => {}, renderBuilder: () => assert.fail("Stale render") });
    await entered.promise; change(); request.resolve(response(draft("B"))); await pending;
    assert.notEqual(state.builder.draft.plan.id, "B");
  }
});
test("invalid/current target sends no requests and does not start a switch", async () => {
  for (const id of ["A", "missing", ""]) await handleBuilderPlanAction(action(id), {});
  assert.equal(state.builder.batchSwitchPending, null);
});
test("switcher has photos, initials fallback, short labels and accessible active state", () => {
  const html = renderBuilderBatchSwitcher(plans, 0);
  document.querySelector("#content").innerHTML = html;
  const buttons = document.querySelectorAll(".builder-batch-pill");
  assert.equal(buttons[0].querySelector("img").getAttribute("src"), "/avatar.png");
  assert.equal(buttons[1].querySelector(".builder-batch-avatar").textContent, "MT");
  assert.equal(buttons[1].querySelector(".builder-batch-caption").textContent, "Marko T.");
  assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
  assert.equal(buttons[1].getAttribute("aria-label"), "Marko Test");
});
test("progress disables controls and makes editor inert without destroying unsaved input", () => {
  document.querySelector("#content").innerHTML = `<section class="builder-workspace">${renderBuilderBatchSwitcher(plans, 0)}<form><input value="unfinished"></form></section>`;
  const input = document.querySelector("form input");
  state.builder.batchSwitchPending = { name: "Marko Test", stage: "saving" };
  renderBuilderBatchSwitchProgress();
  assert.equal(document.querySelectorAll('[data-action="builder-open-batch-plan"]:not(:disabled)').length, 0);
  assert.ok(document.querySelector("form").hasAttribute("inert"));
  assert.match(document.querySelector("[role=status]").textContent, /Saving/);
  assert.equal(document.querySelector("form input"), input); assert.equal(input.value, "unfinished");
  state.builder.batchSwitchPending = null; renderBuilderBatchSwitchProgress();
  assert.equal(document.querySelector("form").hasAttribute("inert"), false);
  assert.equal(document.querySelector('[aria-label="Previous athlete"]').disabled, true);
  assert.equal(document.querySelector('[aria-label="Next athlete"]').disabled, false);
});
