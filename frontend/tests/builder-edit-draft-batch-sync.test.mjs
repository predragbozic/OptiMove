// A reopened, published batch (an edit draft) is saved to the athlete on screen
// only: the server never syncs an edit draft's batch (wantsBatchSync and
// syncBatchFromPlan in backend/src/routes/builder.js). The screen must not
// offer "Apply changes to all athletes" for it, and no request may carry
// syncBatch. A new (non-edit) batch draft keeps today's behaviour.
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
// A reopened plan is an edit draft with its own id; the batch lists the
// published plans only (loadBuilderBatch leaves edit drafts out).
const draft = (isEditDraft) => ({
  plan: isEditDraft
    ? { id: "A", status: "draft", planType: "weekly", isEditDraft, editSourcePlanId: "A", batchId: "batch-1" }
    : { id: "A", status: "draft", planType: "weekly", isEditDraft, batchId: "batch-1" },
  batch: { id: "batch-1", plans },
  blocks: [],
});
let calls;
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: draft(false) });
  state.builder.batchSync = true;
  state.athletes = [];
  calls = [];
  window.confirm = () => true;
  // Record the request, then refuse it, so no handler navigates away.
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "Recorded only" }) };
  };
});

const submitButton = () => ({ dataset: { action: "builder-submit-plan" }, disabled: false, innerHTML: "", textContent: "" });
const handlers = { flushBuilderAutosaves: async () => {}, renderBuilderError() {}, renderBuilder() {}, cancelBuilderItemAutosave: async () => {} };

test("a new batch draft offers the checkbox; an edit draft shows the one sentence instead", () => {
  const fresh = renderBuilderBatchSwitcher(plans, 0);
  assert.match(fresh, /data-action="builder-toggle-batch-sync"/);
  assert.match(fresh, /Apply changes to all athletes/);
  assert.doesNotMatch(fresh, /Changes go to this athlete only\./);

  state.builder.draft = draft(true);
  const edit = renderBuilderBatchSwitcher(plans, 0);
  assert.doesNotMatch(edit, /builder-toggle-batch-sync/);
  assert.doesNotMatch(edit, /Apply changes to all athletes/);
  assert.match(edit, /data-builder-batch-edit-note>Changes go to this athlete only\.</);
  // The athlete switcher itself stays.
  assert.match(edit, /data-action="builder-open-batch-plan" data-plan-id="B"/);
});

test("Save of a new batch draft sends syncBatch, as today", async () => {
  await handleBuilderDraftAction(submitButton(), handlers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/plans/A/submit");
  assert.equal(calls[0].body.syncBatch, true);
});

test("Save of an edit draft sends no syncBatch, even with the stored choice on", async () => {
  state.builder.draft = draft(true);
  assert.equal(state.builder.batchSync, true);
  await handleBuilderDraftAction(submitButton(), handlers);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/plans/A/submit");
  assert.equal("syncBatch" in calls[0].body, false);
});

test("a URL-carried write (remove an exercise) has syncBatch=1 only for a new batch draft", async () => {
  const remove = { dataset: { action: "builder-delete-item", itemId: "item-1" } };
  await handleBuilderItemAction(remove, handlers).catch(() => {});
  state.builder.draft = draft(true);
  await handleBuilderItemAction(remove, handlers).catch(() => {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/builder/items/item-1?syncBatch=1");
  assert.equal(calls[1].url, "/api/builder/items/item-1");
});

test("the whole Builder: a new batch draft shows the switcher and the checkbox, a reopened member shows only the sentence", () => {
  const content = document.querySelector("#content");
  renderBuilder();
  assert.ok(content.querySelector(".builder-batch-switcher"));
  assert.ok(content.querySelector('[data-action="builder-toggle-batch-sync"]'));
  assert.equal(content.querySelector("[data-builder-batch-edit-note]"), null);

  // The real edit draft: a new id, its source is a member of the batch.
  state.builder.draft = draft(true);
  state.builder.draft.plan.id = "A-edit";
  renderBuilder();
  assert.equal(content.querySelector('[data-action="builder-toggle-batch-sync"]'), null);
  assert.match(content.querySelector("[data-builder-batch-edit-note]")?.textContent || "", /^Changes go to this athlete only\.$/);

  // An edit draft of a plan that is not in a group says nothing about groups.
  state.builder.draft = { plan: { id: "S-edit", status: "draft", planType: "weekly", isEditDraft: true, editSourcePlanId: "S" }, blocks: [] };
  renderBuilder();
  assert.equal(content.querySelector("[data-builder-batch-edit-note]"), null);
  assert.equal(content.querySelector('[data-action="builder-toggle-batch-sync"]'), null);

  // An edit draft whose source is not a member of the batch held on screen
  // (for example a batch kept from a previous screen) says nothing either.
  state.builder.draft = { plan: { id: "S-edit", status: "draft", planType: "weekly", isEditDraft: true, editSourcePlanId: "S" }, batch: { id: "batch-1", plans }, blocks: [] };
  renderBuilder();
  assert.equal(content.querySelector("[data-builder-batch-edit-note]"), null);

  // A new draft that is not in the batch's list is not an edit draft: no sentence.
  state.builder.draft = { plan: { id: "X", status: "draft", planType: "weekly", isEditDraft: false, editSourcePlanId: "A" }, batch: { id: "batch-1", plans }, blocks: [] };
  renderBuilder();
  assert.equal(content.querySelector("[data-builder-batch-edit-note]"), null);
});
