// Weekly program templates, part WT-B (docs/ai/weekly-program-template-plan.md):
// the dated assign with its one question (Replace / Skip weeks that already have
// a plan / Back), the choice sent with the server's token, a lost answer resent
// with the same key, plain sentences, and the library's Assign to athletes.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");
const { handleWeeklyAssignAction: handleWeeklyTemplateAction, updateWeeklyAssignStartDate } = await import("../builder-weekly-assign-actions.js");

const blocks = (weeks, sessions = {}) => Array.from({ length: weeks * 7 }, (_, i) => ({
  id: `d${i + 1}`, index: i + 1, name: `Week ${Math.floor(i / 7) + 1} - Day ${(i % 7) + 1}`, type: "template_week_day", date: "", note: null,
  sessions: (sessions[i + 1] || []).map((name, n) => ({ id: `s${i + 1}-${n}`, name, amPm: "", bta: "T", time: "", nodes: [] })),
}));
const template = (weeks = 2, sessions = { 2: ["Tue easy"], 9: ["W2 Tue"] }) => ({
  plan: { id: "T1", name: "Base block", planType: "program", templateKind: "weekly", weekCount: weeks, isTemplate: true, status: "draft", athleteId: "", athleteName: "" },
  blocks: blocks(weeks, sessions),
  batch: null,
});

let calls;
let answers;
beforeEach(() => {
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ draft: template() });
  state.athletes = [
    { athlete_id: "11", athlete: "Example Alpha" },
    { athlete_id: "12", athlete: "Example Beta" },
  ];
  calls = [];
  answers = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
    if (next instanceof Error) throw next;
    return { ok: next.status < 300, status: next.status, statusText: "", json: async () => next.body };
  };
});

const button = (action, dataset = {}) => ({ dataset: { action, ...dataset }, disabled: false });
const handlers = { renderBuilder() { renderBuilder(); }, flushBuilderAutosaves: async () => {} };
const content = () => document.querySelector("#content");
const text = () => content().textContent.replace(/\s+/g, " ");
const shownDays = () => [...content().querySelectorAll(".builder-block-kicker")].map((el) => el.textContent.trim());

test("1. assign: date and athletes, a conflict question, the choice resent with the server's token; the result says what happened", async () => {
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  const date = content().querySelector("[data-tw-start-date]");
  date.value = "2026-12-09";
  updateWeeklyAssignStartDate(date);
  assert.match(content().querySelector("[data-tw-start-preview]").textContent, /Day 1 is Wed 09\.12, the last day Tue 22\.12 2026/);
  assert.ok(content().querySelector('[data-action="builder-tw-assign-submit"]').disabled);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle-all"), handlers);
  assert.deepEqual(state.builder.weeklyAssign.athleteIds.sort(), ["11", "12"]);
  answers.push({ status: 409, body: {
    error: "Some athletes already have plans in these weeks.", code: "weekly_assign_conflicts", choiceToken: "tok-1", newWeeks: 3,
    athletes: [{ athleteId: "11", name: "Example Alpha", weeks: [
      { weekStart: "2026-12-07", days: ["2026-12-09"], contentDays: ["2026-12-09"], draft: false, kept: [{ name: "Main", day: "2026-12-09", amPm: "AM", bta: "T", reasons: ["has_results"] }] },
      { weekStart: "2026-12-14", days: ["2026-12-14"], cannot: "being_edited" },
    ] }],
  } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  const first = calls.at(-1);
  assert.equal(first.url, "/api/builder/plans/T1/assign-weekly");
  assert.deepEqual({ ...first.body, assignmentRequestId: "x" }, { athleteIds: ["11", "12"], startDate: "2026-12-09", assignmentRequestId: "x" });
  assert.match(text(), /1 athlete already has plans in these weeks\./);
  assert.match(text(), /3 new weekly plans are created either way, where there is no plan yet\./);
  // While asking, the dialog scrolls as a whole (the answers stay reachable on a short phone).
  assert.ok(content().querySelector(".builder-tw-assign-modal.is-question"));
  assert.equal(content().querySelector(".builder-tw-assign-modal").classList.contains("builder-copy-plan-modal"), false);
  assert.match(text(), /Main · Wed 09\.12 · AM has results, so it stays\./);
  assert.match(text(), /Someone is editing this week right now\. It stays as it is\./);
  assert.deepEqual([...content().querySelectorAll(".builder-tw-conflict-actions button")].map((b) => b.textContent), ["Replace", "Skip weeks that already have a plan", "Back"]);
  assert.ok(content().querySelector('[data-choice="replace"]').classList.contains("danger-action"));
  answers.push({ status: 201, body: { created: [{}, {}, {}], replaced: [{}], skipped: [{}], kept: 1 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-choice", { choice: "replace" }), handlers);
  const second = calls.at(-1);
  assert.equal(second.body.choice, "replace");
  assert.equal(second.body.choiceToken, "tok-1");
  assert.notEqual(second.body.assignmentRequestId, first.body.assignmentRequestId);
  assert.match(text(), /Assigned\. 3 new weekly plans, 1 week replaced, 1 week left as it was\. 1 session with results or an event link stayed\./);
});

test("2. a lost answer: Assign again resends the same key; Cancel on the question sends nothing", async () => {
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle", { athleteId: "12" }), handlers);
  answers.push(new TypeError("Failed to fetch"));
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.match(text(), /No answer from the server\. Press Assign again: nothing is written twice\./);
  const key = calls.at(-1).body.assignmentRequestId;
  answers.push({ status: 409, body: { code: "weekly_assign_conflicts", choiceToken: "t", newWeeks: 0, athletes: [{ athleteId: "12", name: "Example Beta", weeks: [{ weekStart: "2026-12-07", days: ["2026-12-07"], contentDays: [], kept: [] }] }] } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.equal(calls.at(-1).body.assignmentRequestId, key);
  const before = calls.length;
  await handleWeeklyTemplateAction(button("builder-tw-assign-back"), handlers);
  assert.equal(calls.length, before);
  assert.ok(content().querySelector("[data-tw-start-date]"));
});

test("3. an edit draft of the template is saved first, so the athletes get the saved template", async () => {
  state.builder.draft = { ...template(), plan: { ...template().plan, id: "T1-edit", isEditDraft: true, status: "draft" } };
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle", { athleteId: "11" }), handlers);
  answers.push({ status: 200, body: template() });
  answers.push({ status: 201, body: { created: [{}], replaced: [], skipped: [], kept: 0 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", "/api/builder/plans/T1-edit/submit"], ["POST", "/api/builder/plans/T1/assign-weekly"]]);
});

test("4. review fixes: nothing assigned says so; a refusal is a plain sentence; a lost choice is resent with its key, another choice gets a new key; asked again after a choice says the plans changed", async () => {
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle", { athleteId: "11" }), handlers);
  answers.push({ status: 403, body: { error: "Athlete 11 is outside your current workspace." } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.match(text(), /One of the athletes is not in your current workspace/);
  assert.doesNotMatch(text(), /Athlete 11/);
  const conflict = { code: "weekly_assign_conflicts", choiceToken: "t1", newWeeks: 0, athletes: [{ athleteId: "11", name: "Example Alpha", weeks: [{ weekStart: "2026-12-07", days: ["2026-12-07"], contentDays: ["2026-12-07"], kept: [] }] }] };
  answers.push({ status: 409, body: conflict });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  answers.push(new TypeError("Failed to fetch"));
  await handleWeeklyTemplateAction(button("builder-tw-assign-choice", { choice: "skip" }), handlers);
  assert.match(text(), /Press Skip weeks that already have a plan again/);
  const lostKey = calls.at(-1).body.assignmentRequestId;
  answers.push({ status: 409, body: { ...conflict, choiceToken: "t2" } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-choice", { choice: "skip" }), handlers);
  assert.equal(calls.at(-1).body.assignmentRequestId, lostKey);
  assert.match(text(), /The plans changed since you looked\. Check again\./);
  answers.push({ status: 201, body: { created: [], replaced: [], skipped: [{}], kept: 0 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-choice", { choice: "replace" }), handlers);
  assert.notEqual(calls.at(-1).body.assignmentRequestId, lostKey);
  assert.equal(calls.at(-1).body.choiceToken, "t2");
  assert.match(text(), /Nothing was assigned: every week already had a plan and was left as it was\./);
  assert.doesNotMatch(text(), /Assigned\./);
});

test("5. opened from the library: the saved template is assigned (the edit copy is not applied), and Close removes that edit copy", async () => {
  state.builder.draft = { ...template(), plan: { ...template().plan, id: "T1-edit", isEditDraft: true, editSourcePlanId: "T1" } };
  state.builder.weeklyAssign = { planId: "T1-edit", open: true, fromLibrary: true, startDate: "2026-12-07", athleteIds: ["11"], requestId: "", sending: false, conflict: null, error: "", result: null };
  answers.push({ status: 201, body: { created: [{}], replaced: [], skipped: [], kept: 0 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", "/api/builder/plans/T1/assign-weekly"]]);
  answers.push({ status: 200, body: { deleted: true } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-close"), handlers);
  assert.deepEqual(calls.at(-1), { url: "/api/builder/plans/T1-edit", method: "DELETE", body: null });
  assert.equal(state.builder.draft, null);
});
