// A reopened, published batch member (an edit draft) never sends syncBatch:
// the server ignores it for an edit draft. Step 2
// (docs/ai/builder-batch-edit-plan.md): a reopened WEEKLY member asks at Save
// who gets the changes (all athletes or only this one) and sends batchScope;
// a reopened PROGRAM member keeps "Changes go to this athlete only." A new
// (non-edit) batch draft keeps today's behaviour.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { handleBuilderDraftAction, handleBuilderItemAction } = await import("../builder-actions.js");
const { renderBuilder, renderBuilderBatchSwitcher } = await import("../builder-view.js");

const plans = [
  { id: "A", athleteId: "1", athleteName: "Athlete One" },
  { id: "B", athleteId: "2", athleteName: "Athlete Two" },
  { id: "C", athleteId: "3", athleteName: "Athlete Three" },
];
const freshDraft = () => ({ plan: { id: "A", status: "draft", planType: "weekly", isEditDraft: false, batchId: "batch-1", athleteName: "Athlete One" }, batch: { id: "batch-1", plans }, blocks: [] });
// A reopened plan is an edit draft with its own id; the batch lists the
// published plans only (loadBuilderBatch leaves edit drafts out).
const editDraft = (planType = "weekly") => ({
  plan: { id: "A-edit", name: "Group week", status: "draft", planType, isEditDraft: true, editSourcePlanId: "A", batchId: "batch-1", athleteName: "Athlete One", athleteId: "1", weekStart: "2026-12-07" },
  batch: { id: "batch-1", plans },
  blocks: [],
});

let calls;
let answer;
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: freshDraft() });
  state.builder.batchSync = true;
  state.athletes = [];
  calls = [];
  window.confirm = () => true;
  // Default: record the request, then refuse it, so no handler navigates away.
  answer = () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "Recorded only" }) });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    return answer(String(url), options);
  };
});

const button = (actionName) => ({ dataset: { action: actionName }, disabled: false, innerHTML: "", textContent: "" });
let renders = 0;
const handlers = {
  flushBuilderAutosaves: async () => {}, renderBuilderError() {}, renderBuilder() { renders += 1; renderBuilder(); },
  cancelBuilderItemAutosave: async () => {}, renderTabs() {}, renderLibraryNav() {}, loadWeekly: async () => {},
  loadPrograms: async () => {}, loadTemplates: async () => {},
};
const content = () => document.querySelector("#content");
const posts = () => calls.filter((c) => c.method === "POST");

test("the switcher of a new batch draft still offers the checkbox", () => {
  const html = renderBuilderBatchSwitcher(plans, 0);
  assert.match(html, /data-action="builder-toggle-batch-sync"/);
  assert.match(html, /Apply changes to all athletes/);
});

test("Save of a new batch draft sends syncBatch, as today", async () => {
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, "/api/builder/plans/A/submit");
  assert.equal(posts()[0].body.syncBatch, true);
  assert.equal("batchScope" in posts()[0].body, false);
});

test("a reopened weekly member: Save asks first and sends nothing; All athletes sends batchScope all, never syncBatch", async () => {
  state.builder.draft = editDraft();
  renderBuilder();
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /one of 3 athletes in this group/);
  assert.equal(content().querySelector('[data-action="builder-toggle-batch-sync"]'), null);
  assert.equal(content().querySelector("[data-builder-batch-edit-note]"), null, "step 1's sentence is gone with step 2");

  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(posts().length, 0);
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Apply these changes to all 3 athletes\?/);
  assert.ok(content().querySelector('[data-action="builder-batch-edit-all"]'));
  assert.match(content().querySelector('[data-action="builder-batch-edit-only"]').textContent, /Only Athlete One/);
  // A second Save while the question is open sends nothing either.
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(posts().length, 0);

  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, "/api/builder/plans/A-edit/submit");
  assert.equal(posts()[0].body.batchScope, "all");
  assert.equal("syncBatch" in posts()[0].body, false);
});

test("Only this athlete sends batchScope this; Cancel closes the question", async () => {
  state.builder.draft = editDraft();
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-cancel"), handlers);
  assert.equal(state.builder.batchEditChoice, null);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-only"), handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.batchScope, "this");
  assert.equal("syncBatch" in posts()[0].body, false);
});

test("409 batch_members_need_choice: names what the coach may see, counts the rest, and resends with applyTo and the token", async () => {
  state.builder.draft = editDraft();
  answer = () => ({
    ok: false, status: 409, statusText: "Conflict",
    json: async () => ({
      error: "Some athletes can't take these changes.", code: "batch_members_need_choice", choiceToken: "tok-1",
      applyTo: ["C"], applyCount: 1,
      cannot: { named: [{ name: "Athlete Two", reasons: ["has_results"] }], unnamedCount: 1 },
      notChanged: { named: [], unnamedCount: 0 },
    }),
  });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  const text = content().querySelector("[data-builder-batch-edit]").textContent;
  assert.match(text, /These athletes won't get the changes:/);
  assert.match(text, /Athlete Two/);
  assert.match(text, /a session with results would be removed or moved/);
  assert.match(text, /1 other athlete you can't edit/);
  assert.match(content().querySelector('[data-action="builder-batch-edit-others"]').textContent, /^Apply to Athlete One and 1 other athlete$/);
  assert.doesNotMatch(text, /has_results|tok-1/, "no codes or tokens on screen");
  await handleBuilderDraftAction(button("builder-batch-edit-others"), handlers);
  const resend = posts()[1];
  assert.deepEqual(resend.body.applyTo, ["C"]);
  assert.equal(resend.body.choiceToken, "tok-1");
  assert.equal(resend.body.batchScope, "all");
});

test("a lost answer is not confirmed; Check result only reads, and a closed draft reads as closed", async () => {
  state.builder.draft = editDraft();
  answer = () => ({ ok: false, status: 503, statusText: "Unavailable", json: async () => ({ error: "busy" }) });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(state.builder.batchEditChoice.stage, "unconfirmed");
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Result not confirmed/);
  // Save while not confirmed sends nothing.
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(posts().length, 1);
  answer = () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "Draft program not found" }) });
  await handleBuilderDraftAction(button("builder-batch-edit-check"), handlers);
  assert.equal(posts().length, 1, "Check result never resends the Save");
  assert.equal(calls.at(-1).method, "GET");
  assert.equal(calls.at(-1).url, "/api/builder/plans/A-edit");
  assert.equal(state.builder.batchEditChoice.stage, "closed");
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Your changes may already be saved\. We can't tell which athletes got them\./);
});

test("Check result with the draft still open says Not saved, and Save again asks the question again", async () => {
  state.builder.draft = editDraft();
  state.builder.batchEditChoice = { stage: "unconfirmed" };
  answer = () => ({ ok: true, status: 200, json: async () => editDraft() });
  await handleBuilderDraftAction(button("builder-batch-edit-check"), handlers);
  assert.equal(state.builder.batchEditChoice.stage, "notSaved");
  assert.match(content().querySelector("[data-builder-batch-edit]").textContent, /Not saved\. Your changes are still here\./);
  await handleBuilderDraftAction(button("builder-batch-edit-again"), handlers);
  assert.equal(state.builder.batchEditChoice.stage, "scope");
  assert.equal(posts().length, 0);
});

test("nobody else can take the changes: no group button, only this athlete or cancel", async () => {
  state.builder.draft = editDraft();
  state.builder.batchEditChoice = { stage: "ask", data: { applyTo: [], applyCount: 0, choiceToken: "t", cannot: { named: [{ name: "Athlete Two", reasons: ["being_edited"] }, { name: "Athlete Three", reasons: ["changed_separately"] }], unnamedCount: 0 }, notChanged: { named: [], unnamedCount: 0 } } };
  renderBuilder();
  const panel = content().querySelector("[data-builder-batch-edit]");
  assert.match(panel.textContent, /None of the other athletes can take these changes:/);
  assert.equal(panel.querySelector('[data-action="builder-batch-edit-others"]'), null);
  assert.ok(panel.querySelector('[data-action="builder-batch-edit-only"]'));
});

test("a resent choice that only went out of date (nobody left out now) does not show an empty list", () => {
  state.builder.draft = editDraft();
  state.builder.batchEditChoice = { stage: "ask", data: { applyTo: ["B", "C"], applyCount: 2, choiceToken: "t2", cannot: { named: [], unnamedCount: 0 }, notChanged: { named: [], unnamedCount: 0 } } };
  renderBuilder();
  const text = content().querySelector("[data-builder-batch-edit]").textContent;
  assert.doesNotMatch(text, /won't get the changes/);
  assert.match(text, /Something changed since you chose\./);
  assert.match(content().querySelector('[data-action="builder-batch-edit-others"]').textContent, /^Apply to Athlete One and 2 other athletes$/);
});

test("busy (try_again) and a source saved meanwhile (source_changed) are told apart; nothing is resent by itself", async () => {
  for (const [code, stage, text] of [["try_again", "busy", /Nothing was saved\./], ["source_changed", "sourceChanged", /saved by someone else after you opened it/]]) {
    state.builder.draft = editDraft();
    state.builder.batchEditChoice = null;
    calls = [];
    answer = () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "x", code }) });
    await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
    await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
    assert.equal(state.builder.batchEditChoice.stage, stage, code);
    assert.match(content().querySelector("[data-builder-batch-edit]").textContent, text);
    assert.equal(posts().length, 1, code);
  }
  assert.equal(content().querySelector('[data-action="builder-batch-edit-all"]'), null, "after source_changed only this athlete or cancel");
});

test("409 edit_draft_already_applied reads as closed", async () => {
  state.builder.draft = editDraft();
  answer = () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "x", code: "edit_draft_already_applied" }) });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(state.builder.batchEditChoice.stage, "closed");
});

test("saved for the group: the count and who was not changed, then Done", async () => {
  state.builder.draft = editDraft();
  answer = () => ({ ok: true, status: 200, json: async () => ({ saved: true, plan: { id: "A", planType: "weekly", athleteId: "1" }, batchEdit: { applied: 2, notChanged: { named: [{ name: "Athlete Three", reasons: ["archived"] }], unnamedCount: 0 } } }) });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(state.builder.batchEditChoice.stage, "done");
  const text = content().textContent;
  assert.match(text, /Group week saved for 2 athletes\./);
  assert.match(text, /Athlete Three: archived/);
  assert.equal(content().querySelector('[data-action="builder-submit-plan"]'), null, "the deleted draft's editor is not drawn");
});

test("a reopened PROGRAM member keeps the step 1 sentence and saves for this athlete only, without syncBatch", async () => {
  state.builder.draft = editDraft("program");
  renderBuilder();
  assert.match(content().querySelector("[data-builder-batch-edit-note]")?.textContent || "", /^Changes go to this athlete only\.$/);
  assert.equal(content().querySelector("[data-builder-batch-edit]"), null);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(posts().length, 1);
  assert.equal("syncBatch" in posts()[0].body, false);
  assert.equal("batchScope" in posts()[0].body, false);
});

test("a URL-carried write (remove an exercise) has syncBatch=1 only for a new batch draft", async () => {
  const remove = { dataset: { action: "builder-delete-item", itemId: "item-1" } };
  await handleBuilderItemAction(remove, handlers).catch(() => {});
  state.builder.draft = editDraft();
  await handleBuilderItemAction(remove, handlers).catch(() => {});
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes[0].url, "/api/builder/items/item-1?syncBatch=1");
  assert.equal(deletes[1].url, "/api/builder/items/item-1");
});

test("edit drafts that are not in a group say nothing about groups", () => {
  state.builder.draft = { plan: { id: "S-edit", status: "draft", planType: "weekly", isEditDraft: true, editSourcePlanId: "S" }, blocks: [] };
  renderBuilder();
  assert.equal(content().querySelector("[data-builder-batch-edit]"), null);
  assert.equal(content().querySelector("[data-builder-batch-edit-note]"), null);
  state.builder.draft = { plan: { id: "S-edit", status: "draft", planType: "weekly", isEditDraft: true, editSourcePlanId: "S" }, batch: { id: "batch-1", plans }, blocks: [] };
  renderBuilder();
  assert.equal(content().querySelector("[data-builder-batch-edit]"), null);
});
