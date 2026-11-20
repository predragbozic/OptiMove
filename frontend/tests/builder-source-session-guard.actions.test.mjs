// Task 5 (docs/ai/builder-batch-edit-plan.md 12.3): the Save of an edit draft
// refused with 409 edit_sessions_locked says which sessions block and why, and
// the way out: put them back, or first remove the link to the event (Open the
// event, the Builder's own hand-off to the calendar). Nothing is sent by itself.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { handleBuilderDraftAction } = await import("../builder-actions.js");
const { renderBuilder } = await import("../builder-view.js");
const { k3SessionKey } = await import("../central-calendar-k3.js");

const MONDAY = "2026-12-07";
const plans = [
  { id: "A", athleteId: "1", athleteName: "Athlete One" },
  { id: "B", athleteId: "2", athleteName: "Athlete Two" },
];
// A reopened weekly plan, alone, or a member of a group of two.
const editDraft = ({ group = false } = {}) => ({
  plan: { id: "A-edit", name: "Week", status: "draft", planType: "weekly", isEditDraft: true, editSourcePlanId: "A", athleteName: "Athlete One", athleteId: "1", weekStart: MONDAY, ...(group ? { batchId: "batch-1" } : {}) },
  batch: group ? { id: "batch-1", plans } : null,
  blocks: [],
});
const locked = (sessions) => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "Some sessions can't be removed or moved.", code: "edit_sessions_locked", sessions }) });
const mainRemoved = (reasons, extra = {}) => ({ name: "Main", day: MONDAY, amPm: "AM", bta: "T", change: "removed", reasons, ...extra });

let calls;
let answer;
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: editDraft() });
  state.athletes = [];
  calls = [];
  window.confirm = () => true;
  answer = () => locked([mainRemoved(["has_results"])]);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    return answer(String(url), options);
  };
});

const button = (actionName) => ({ dataset: { action: actionName }, disabled: false, innerHTML: "<svg></svg>", textContent: "" });
const handlers = {
  flushBuilderAutosaves: async () => {}, renderBuilderError() { throw new Error("no error banner expected"); }, renderBuilder() { renderBuilder(); },
  cancelBuilderItemAutosave: async () => {}, renderTabs() {}, renderLibraryNav() {}, loadWeekly: async () => {},
  loadPrograms: async () => {}, loadTemplates: async () => {},
};
const panel = () => document.querySelector("#content [data-builder-sessions-locked]");
const posts = () => calls.filter((c) => c.method === "POST");
// The Builder's own read of the week (builder-events-row.js): the event that holds Monday's Main.
function weekWith({ managed = true, found = true } = {}) {
  const key = k3SessionKey(MONDAY, { amPm: "AM", bta: "T", name: "Main" });
  state.builder.events = {
    key: "k", loading: false, error: "",
    events: found ? [{ kind: "event", eventId: "ev-1", key: "event:ev-1", title: "Team training", date: MONDAY, canManage: managed }] : [],
    planned: [], conflicts: new Set(),
    placed: found && managed ? new Map([[key, { eventId: "ev-1", linkIds: ["l-1"] }]]) : new Map(),
    other: found && !managed ? new Set([key]) : new Set(),
  };
}

test("1. results: the Save is refused, nothing else is sent, the draft stays, the panel says why and the way out", async () => {
  const save = button("builder-submit-plan");
  await handleBuilderDraftAction(save, handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, "/api/builder/plans/A-edit/submit");
  assert.equal(state.builder.draft.plan.id, "A-edit", "still in the draft");
  assert.equal(save.disabled, false, "Save can be pressed again");
  assert.equal(save.innerHTML, "<svg></svg>");
  const text = panel().textContent.replace(/\s+/g, " ");
  assert.match(text, /Not saved\./);
  assert.match(text, /This session can't be removed or moved:/);
  assert.match(text, /Main · Mon 07\.12 · AM \(removed in this draft\)/);
  assert.match(text, /Has entered results, so it can't be removed or moved\. Its content can still change\./);
  assert.match(text, /Put the session back where it was, or discard your changes, then save again\./);
  assert.equal(panel().getAttribute("role"), "alert");
  assert.equal(panel().querySelector('[data-action="builder-events-open"]'), null, "no event way for results");
  assert.equal(posts().length, 1, "drawing the panel sends nothing");
});

test("2. a link to an event the coach manages: First remove the link, with Open the event on that day and its key", async () => {
  weekWith();
  answer = () => locked([mainRemoved(["linked_to_event"], { change: "moved" })]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  const text = panel().textContent.replace(/\s+/g, " ");
  assert.match(text, /\(moved in this draft\)/);
  assert.match(text, /Linked to the event “Team training” in the calendar\. First remove the link to the event, then save again\./);
  const open = panel().querySelector('[data-action="builder-events-open"]');
  assert.equal(open.textContent, "Open the event");
  assert.equal(open.dataset.date, MONDAY);
  assert.equal(open.dataset.key, "event:ev-1");
});

test("3. an event the coach does not manage: who removes the link, and no button to an event they can't change", async () => {
  weekWith({ managed: false });
  answer = () => locked([mainRemoved(["linked_to_event"])]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(panel().textContent, /Linked by the club's admin from the calendar\. Ask them to remove the link, then save again\./);
  assert.equal(panel().querySelector('[data-action="builder-events-open"]'), null);
});

test("4. the event is not in the week the Builder read: Open the calendar on that day, without a key", async () => {
  weekWith({ found: false });
  answer = () => locked([mainRemoved(["linked_to_event"])]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(panel().textContent, /Linked to an event in the calendar\. First remove the link to the event, then save again\./);
  const open = panel().querySelector('[data-action="builder-events-open"]');
  assert.equal(open.textContent, "Open the calendar");
  assert.equal(open.dataset.date, MONDAY);
  assert.equal(open.dataset.key, undefined);
});

test("5. both reasons and two sessions; names are escaped", async () => {
  weekWith();
  answer = () => locked([mainRemoved(["has_results", "linked_to_event"]), { name: "<b>Gym</b>", day: "2026-12-09", amPm: "PM", bta: "T", change: "moved", reasons: ["has_results"] }]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  const text = panel().textContent.replace(/\s+/g, " ");
  assert.match(text, /These sessions can't be removed or moved:/);
  assert.match(text, /<b>Gym<\/b> · Wed 09\.12 · PM/);
  assert.equal(panel().querySelector("b"), null, "the name is text, not markup");
  assert.equal(panel().querySelectorAll(".builder-sessions-locked-item").length, 2);
  assert.match(text, /Put these sessions back where they were/);
});

test("6. OK closes the panel; another draft clears it; a later successful Save clears it", async () => {
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.ok(panel());
  await handleBuilderDraftAction(button("builder-sessions-locked-close"), handlers);
  assert.equal(panel(), null);
  assert.equal(posts().length, 1, "OK sends nothing");
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.ok(state.builder.sessionsLocked);
  answer = () => ({ ok: true, status: 200, json: async () => ({ plan: { id: "A", planType: "weekly", status: "active" } }) });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(state.builder.sessionsLocked, null);
});

test("7. the group Save (All athletes) refused the same way: the group question closes and the panel shows", async () => {
  state.builder.draft = editDraft({ group: true });
  state.builder.batchEditChoice = { stage: "scope" };
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.batchScope, "all");
  assert.equal(state.builder.batchEditChoice, null);
  assert.match(panel().textContent, /Has entered results/);
});
