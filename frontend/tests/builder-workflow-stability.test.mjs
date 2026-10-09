import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.window = { confirm: () => true };
const { state, emptyBuilderState } = await import("../state.js");
const { handleBuilderPlanAction, handleBuilderDraftAction, handleBuilderItemAction } = await import("../builder-actions.js");
const { rememberBuilderItemEdit, pendingBuilderItemEdit, acknowledgeBuilderItemEdit, preserveBuilderItemEdits, clearBuilderItemEdits } = await import("../builder-item-edits.js");

function draft() {
  return {
    plan: { id: "draft-1", status: "draft", isEditDraft: true, planType: "weekly", athleteId: "athlete-1", weekStart: "2026-10-05" },
    blocks: [{ id: "day-1", sessions: [{ id: "session-1", nodes: [{ id: "section-1", items: [
      { id: "a", sets: "", reps: "" }, { id: "b", sets: "", reps: "" }, { id: "c", sets: "", reps: "" },
    ] }] }] }],
  };
}
const items = (value) => value.blocks[0].sessions[0].nodes[0].items;
const action = (type, data = {}) => ({ dataset: { action: type, ...data }, disabled: false, innerHTML: "<svg></svg>" });
function handlers(extra = {}) {
  return { renderTabs() {}, renderLibraryNav() {}, loadWeekly: async () => {}, renderBuilder() {}, renderBuilderSectionItems: () => true, renderBuilderError(error) { throw error; }, ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  state.builder = emptyBuilderState();
  state.builder.draft = draft();
  state.builder.selectedNodeId = "section-1";
  state.activeTab = "builder";
  clearBuilderItemEdits();
  window.confirm = () => true;
  globalThis.fetch = async () => { throw new Error("Unexpected request"); };
});

test("Exit flushes pending inputs, keeps the edit draft, and returns to its athlete and week", async () => {
  const calls = [];
  await handleBuilderDraftAction(action("builder-cancel"), handlers({
    flushBuilderAutosaves: async () => { calls.push("flush"); },
    loadWeekly: async (options) => { calls.push("weekly"); assert.equal(options.forceRefresh, true); },
  }));
  assert.deepEqual(calls, ["flush", "weekly"]);
  assert.equal(state.builder.draft, null);
  assert.equal(state.activeTab, "weekly");
  assert.equal(state.selectedAthleteId, "athlete-1");
  assert.equal(state.viewedWeekStart, "2026-10-05");
});

test("Save waits for the last input before submitting and exits after success", async () => {
  const flush = deferred();
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options.method }); return response({ ...draft(), plan: { ...draft().plan, id: "original-1", status: "active" } }); };
  const save = handleBuilderDraftAction(action("builder-submit-plan"), handlers({ flushBuilderAutosaves: () => flush.promise }));
  assert.equal(calls.length, 0);
  assert.equal(state.activeTab, "builder");
  flush.resolve();
  await save;
  assert.deepEqual(calls, [{ url: "/api/builder/plans/draft-1/submit", method: "POST" }]);
  assert.equal(state.builder.draft, null);
  assert.equal(state.activeTab, "weekly");
});

test("an input-save failure prevents final submit and leaves Save available to retry", async () => {
  const button = action("builder-submit-plan");
  let error;
  await handleBuilderDraftAction(button, handlers({
    flushBuilderAutosaves: async () => { throw new Error("Input not saved"); },
    renderBuilderError: (value) => { error = value; },
  }));
  assert.equal(error.message, "Input not saved");
  assert.equal(state.builder.draft.plan.id, "draft-1");
  assert.equal(state.activeTab, "builder");
  assert.equal(button.disabled, false);
});

test("X cancels pending input saves, deletes only the draft, then exits", async () => {
  const events = [];
  globalThis.fetch = async (url, options) => { events.push(`${options.method} ${url}`); return response({ deleted: true }); };
  const discard = action("builder-discard-current-draft");
  assert.equal(await handleBuilderPlanAction(discard, handlers()), false, "draft-list actions must not intercept the toolbar X");
  await handleBuilderDraftAction(discard, handlers({ cancelBuilderAutosaves: async () => { events.push("cancel"); } }));
  assert.deepEqual(events, ["cancel", "DELETE /api/builder/plans/draft-1"]);
  assert.equal(state.builder.draft, null);
});

test("canceling X confirmation does not cancel inputs, delete, or leave", async () => {
  window.confirm = () => false;
  await handleBuilderDraftAction(action("builder-discard-current-draft"), handlers({ cancelBuilderAutosaves: async () => { assert.fail("Must not cancel"); } }));
  assert.equal(state.builder.draft.plan.id, "draft-1");
  assert.equal(state.activeTab, "builder");
});

test("X cannot discard an active original plan", async () => {
  state.builder.draft.plan.status = "active";
  await handleBuilderDraftAction(action("builder-discard-current-draft"), handlers());
  assert.equal(state.builder.draft.plan.id, "draft-1");
});

test("a response for another item preserves both locally edited dose fields", () => {
  rememberBuilderItemEdit("a", { sets: "3", reps: "12" });
  rememberBuilderItemEdit("b", { sets: "4", reps: "8" });
  const incoming = preserveBuilderItemEdits(draft());
  assert.deepEqual(items(incoming).slice(0, 2), [{ id: "a", sets: "3", reps: "12" }, { id: "b", sets: "4", reps: "8" }]);
});

test("an older response cannot acknowledge a newer edit of the same item", () => {
  const older = rememberBuilderItemEdit("a", { reps: "1" });
  const newer = rememberBuilderItemEdit("a", { reps: "12" });
  acknowledgeBuilderItemEdit("a", older);
  assert.equal(pendingBuilderItemEdit("a"), newer);
  assert.equal(items(preserveBuilderItemEdits(draft()))[0].reps, "12");
  acknowledgeBuilderItemEdit("a", newer);
  assert.equal(pendingBuilderItemEdit("a"), null);
});

test("pending input values never leak into another plan", () => {
  rememberBuilderItemEdit("a", { reps: "12" });
  const other = draft();
  other.plan.id = "other-plan";
  assert.equal(items(preserveBuilderItemEdits(other))[0].reps, "");
});

test("moving is immediate, remains stable through another response, and ignores a rapid second click", async () => {
  const started = deferred();
  const held = deferred();
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); started.resolve(); return response(await held.promise); };
  const move = handleBuilderItemAction(action("builder-move-item", { itemId: "c", direction: "up" }), handlers());
  assert.deepEqual(items(state.builder.draft).map((item) => item.id), ["a", "c", "b"]);
  await started.promise;
  const incoming = preserveBuilderItemEdits(draft());
  assert.deepEqual(items(incoming).map((item) => item.id), ["a", "c", "b"]);
  await handleBuilderItemAction(action("builder-move-item", { itemId: "c", direction: "up" }), handlers());
  assert.equal(calls.length, 1);
  held.resolve(incoming);
  await move;
  assert.equal(state.builder.itemMovePending, null);
  assert.deepEqual(items(state.builder.draft).map((item) => item.id), ["a", "c", "b"]);
});
