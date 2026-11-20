// Task 5 (docs/ai/builder-batch-edit-plan.md section 12): a session that has
// entered results or is linked to an event can't be removed or moved.
// - The Save of an edit draft refused with 409 edit_sessions_locked: a panel
//   with one way out per session (move it back, discard, or first remove the
//   link to the event - Open the event); focus moves to it; nothing is sent by
//   itself.
// - Deleting a published plan refused with 409 plan_sessions_locked: one
//   sentence naming the sessions, not a generic error.
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
const { planSessionsLockedText } = await import("../builder-sessions-locked.js");

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
const refusal = (code, sessions) => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "Refused", code, sessions }) });
const locked = (sessions) => refusal("edit_sessions_locked", sessions);
const mainRemoved = (reasons, extra = {}) => ({ name: "Main", day: MONDAY, amPm: "AM", bta: "T", change: "removed", reasons, ...extra });

let calls;
let answer;
let alerts;
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: editDraft() });
  state.athletes = [];
  calls = [];
  alerts = [];
  window.confirm = () => true;
  window.alert = (text) => { alerts.push(text); };
  answer = () => locked([mainRemoved(["has_results"])]);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    return answer(String(url), options);
  };
});

const button = (actionName, dataset = {}) => ({ dataset: { action: actionName, ...dataset }, disabled: false, innerHTML: "<svg></svg>", textContent: "" });
const handlers = {
  flushBuilderAutosaves: async () => {}, renderBuilderError() { throw new Error("no error banner expected"); }, renderBuilder() { renderBuilder(); },
  cancelBuilderItemAutosave: async () => {}, renderTabs() {}, renderLibraryNav() {}, loadWeekly: async () => {},
  loadPrograms: async () => {}, loadTemplates: async () => {},
};
const panel = () => document.querySelector("#content [data-builder-sessions-locked]");
const text = () => panel().textContent.replace(/\s+/g, " ");
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

test("1. results on a removed session: refused, nothing else sent, the draft stays, focus on the panel; the way out is to discard, never 'put back'", async () => {
  const save = button("builder-submit-plan");
  await handleBuilderDraftAction(save, handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, "/api/builder/plans/A-edit/submit");
  assert.equal(state.builder.draft.plan.id, "A-edit", "still in the draft");
  assert.equal(save.disabled, false, "Save can be pressed again");
  assert.equal(save.innerHTML, "<svg></svg>");
  assert.match(text(), /Not saved\. This session can't be removed or moved:/);
  assert.match(text(), /Main · Mon 07\.12 · AM \(removed in this draft\)/);
  assert.match(text(), /Athletes have already entered results for it \(for example RPE\), so it can't be removed\. You can still change its content\./);
  assert.match(text(), /To keep it, discard your changes, then make your other edits again\./);
  assert.doesNotMatch(text(), /put .* back/i);
  assert.ok(panel().querySelector('[data-action="builder-discard-current-draft"]'), "a Discard changes button in the panel");
  assert.equal(panel().querySelector('[data-action="builder-events-open"]'), null, "no event way for results");
  assert.equal(panel().querySelector("[role=alert]").id, "builder-sessions-locked-title", "only the heading is the alert");
  assert.equal(document.activeElement, panel(), "focus moves to the panel");
  assert.equal(posts().length, 1, "drawing the panel sends nothing");
});

test("2. results on a moved session: move it back to where it was", async () => {
  answer = () => locked([mainRemoved(["has_results"], { change: "moved" })]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(text(), /\(moved in this draft\)/);
  assert.match(text(), /so it can't be moved\./);
  assert.match(text(), /Move it back to Mon 07\.12 · AM, or discard your changes\./);
});

test("3. a link to an event the coach manages: first remove the link, Open the event (primary) with its key, the round trip said", async () => {
  weekWith();
  answer = () => locked([mainRemoved(["linked_to_event"], { change: "moved" })]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(text(), /Linked to the event “Team training” in the calendar\. To keep this change, first remove the link to the event, then save again\./);
  assert.match(text(), /Your draft is kept\. After you remove the link, come back to Builder › Continue where you left off, and save again\./);
  assert.match(text(), /Or: move it back to Mon 07\.12 · AM, or discard your changes\./);
  const open = panel().querySelector('[data-action="builder-events-open"]');
  assert.equal(open.textContent, "Open the event");
  assert.ok(open.classList.contains("builder-sessions-locked-primary"));
  assert.equal(open.dataset.date, MONDAY);
  assert.equal(open.dataset.key, "event:ev-1");
});

test("4. an event the coach does not manage: who removes the link, and no button to an event they can't change", async () => {
  weekWith({ managed: false });
  answer = () => locked([mainRemoved(["linked_to_event"])]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(text(), /Linked to an event you can't change\. Ask whoever manages that event \(usually your club's admin\) to remove the link, then save again\./);
  assert.equal(panel().querySelector('[data-action="builder-events-open"]'), null);
});

test("5. the event is not in the week the Builder read: Open the calendar on that day, without a key", async () => {
  weekWith({ found: false });
  answer = () => locked([mainRemoved(["linked_to_event"])]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(text(), /Linked to an event in the calendar\. To keep this change, first remove the link to the event, then save again\./);
  const open = panel().querySelector('[data-action="builder-events-open"]');
  assert.equal(open.textContent, "Open the calendar");
  assert.equal(open.dataset.date, MONDAY);
  assert.equal(open.dataset.key, undefined);
});

test("6. both reasons and two sessions: a count, results win over the link, names are escaped", async () => {
  weekWith();
  answer = () => locked([mainRemoved(["has_results", "linked_to_event"]), { name: "<b>Gym</b>", day: "2026-12-09", amPm: "PM", bta: "T", change: "moved", reasons: ["has_results"] }]);
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.match(text(), /2 sessions can't be removed or moved:/);
  assert.match(text(), /<b>Gym<\/b> · Wed 09\.12 · PM/);
  assert.equal(panel().querySelector("b"), null, "the name is text, not markup");
  assert.equal(panel().querySelectorAll(".builder-sessions-locked-item").length, 2);
  assert.match(text(), /It is also linked to an event\./);
  assert.equal(panel().querySelector('[data-action="builder-events-open"]'), null, "removing the link would not help a session with results");
});

test("7. Close closes the panel and sends nothing; a later successful Save clears it", async () => {
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.ok(panel());
  assert.equal(panel().querySelector('[data-action="builder-sessions-locked-close"]').textContent, "Close");
  await handleBuilderDraftAction(button("builder-sessions-locked-close"), handlers);
  assert.equal(panel(), null);
  assert.equal(posts().length, 1, "Close sends nothing");
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.ok(state.builder.sessionsLocked);
  answer = () => ({ ok: true, status: 200, json: async () => ({ plan: { id: "A", planType: "weekly", status: "active" } }) });
  await handleBuilderDraftAction(button("builder-submit-plan"), handlers);
  assert.equal(state.builder.sessionsLocked, null);
});

test("8. the group Save (All athletes) refused the same way: the group question closes and the panel shows", async () => {
  state.builder.draft = editDraft({ group: true });
  state.builder.batchEditChoice = { stage: "scope" };
  await handleBuilderDraftAction(button("builder-batch-edit-all"), handlers);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.batchScope, "all");
  assert.equal(state.builder.batchEditChoice, null);
  assert.match(text(), /Athletes have already entered results/);
});

test("9. deleting a published plan refused (409 plan_sessions_locked): one sentence naming the sessions, the button usable again", async () => {
  state.activeTab = "weekly";
  answer = () => refusal("plan_sessions_locked", [mainRemoved(["linked_to_event"]), { name: "Gym", day: "2026-12-09", amPm: "PM", bta: "T", change: "removed", reasons: ["has_results", "linked_to_event"] }]);
  const del = button("builder-delete-source-plan", { planId: "A", objectLabel: "weekly plan" });
  await handleBuilderDraftAction(del, handlers);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  assert.equal(del.disabled, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], planSessionsLockedText([mainRemoved(["linked_to_event"]), { name: "Gym", day: "2026-12-09", amPm: "PM", reasons: ["has_results", "linked_to_event"] }]));
  assert.match(alerts[0], /^This plan can't be deleted\./);
  assert.match(alerts[0], /• Main · Mon 07\.12 · AM: it is linked to an event in the calendar - first remove the link to the event, then delete again\./);
  assert.match(alerts[0], /• Gym · Wed 09\.12 · PM: athletes have already entered results for it\./);
});
