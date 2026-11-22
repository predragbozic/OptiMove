// Weekly program templates (docs/ai/weekly-program-template-plan.md), the
// Builder screen: the week strip (one week on screen, add / duplicate / move /
// delete with a confirmation), the dated assign with its one question
// (Replace / Skip weeks that already have a plan / Cancel, the choice sent with
// the server's token, a lost answer resent with the same key), Save as template
// from chosen weeks, and the Program Library's mark and filter.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");
const { handleWeeklyTemplateAction, updateWeeklyAssignStartDate } = await import("../builder-weekly-template-actions.js");
const { applyTemplateClientFilters, renderProgramLibraryCard, templateKindLabel } = await import("../program-library.js");

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

test("1. the week strip: one template week on screen, Day 1..Day 7, no add-block card, no day rename", async () => {
  renderBuilder();
  assert.match(text(), /Weekly program · 2 weeks/);
  const tabs = [...content().querySelectorAll(".builder-week-tab[role=tab]")];
  assert.deepEqual(tabs.map((t) => t.querySelector("strong").textContent), ["Week 1", "Week 2"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.deepEqual(shownDays(), ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"]);
  assert.match(text(), /Tue easy/);
  assert.doesNotMatch(text(), /W2 Tue/);
  assert.equal(content().querySelector(".builder-add-block-card"), null);
  assert.equal(content().querySelector('[data-builder-form="update-block"]'), null);
  assert.equal(content().querySelector('[data-action="builder-delete-block"]'), null);
  // The template's Assign is the dated assign, never the specific-program copy.
  assert.ok(content().querySelector('[data-action="builder-tw-assign-open"]'));
  assert.equal(content().querySelector('[data-action="builder-duplicate-plan"][data-intent="assign"]'), null);
  await handleWeeklyTemplateAction(button("builder-tw-select-week", { week: "2" }), handlers);
  assert.match(text(), /W2 Tue/);
  assert.doesNotMatch(text(), /Tue easy/);
  assert.match(text(), /Week 2/);
  assert.equal(calls.length, 0);
});

test("2. add, duplicate and move a week: one request each, the server's draft shown on the moved / new week", async () => {
  answers.push({ status: 201, body: template(3) });
  await handleWeeklyTemplateAction(button("builder-tw-duplicate-week", { week: "1" }), handlers);
  assert.deepEqual(calls.at(-1), { url: "/api/builder/plans/T1/weeks", method: "POST", body: { copyFrom: 1 } });
  assert.equal(state.builder.templateWeek, 3);
  answers.push({ status: 200, body: template(3) });
  await handleWeeklyTemplateAction(button("builder-tw-move-week", { week: "3", to: "2" }), handlers);
  assert.deepEqual(calls.at(-1), { url: "/api/builder/plans/T1/weeks/3/move", method: "POST", body: { to: 2 } });
  assert.equal(state.builder.templateWeek, 2);
  answers.push({ status: 201, body: template(4) });
  await handleWeeklyTemplateAction(button("builder-tw-add-week"), handlers);
  assert.deepEqual(calls.at(-1), { url: "/api/builder/plans/T1/weeks", method: "POST", body: {} });
  assert.equal(state.builder.templateWeek, 4);
  // A refusal says the server's sentence and keeps the template.
  answers.push({ status: 400, body: { error: "A weekly program template has at most 52 weeks.", code: "weekly_template_weeks" } });
  await handleWeeklyTemplateAction(button("builder-tw-add-week"), handlers);
  assert.match(content().querySelector(".builder-week-strip [role=alert]").textContent, /at most 52 weeks/);
  assert.equal(state.builder.draft.plan.weekCount, 4);
});

test("3. delete a week asks first; Cancel sends nothing, Delete week sends one DELETE", async () => {
  renderBuilder();
  await handleWeeklyTemplateAction(button("builder-tw-delete-week", { week: "1" }), handlers);
  assert.match(text(), /Delete week 1 and its 1 session\? The weeks after it move up\./);
  assert.equal(calls.length, 0);
  await handleWeeklyTemplateAction(button("builder-tw-delete-week-cancel"), handlers);
  assert.equal(content().querySelector(".builder-week-confirm"), null);
  await handleWeeklyTemplateAction(button("builder-tw-delete-week", { week: "1" }), handlers);
  answers.push({ status: 200, body: template(1, { 2: ["W2 Tue"] }) });
  await handleWeeklyTemplateAction(button("builder-tw-delete-week-confirm", { week: "1" }), handlers);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["DELETE", "/api/builder/plans/T1/weeks/1"]]);
  assert.equal(state.builder.templateWeek, 1);
  // One week left: no delete offered.
  assert.equal(content().querySelector('[data-action="builder-tw-delete-week"]'), null);
});

test("4. assign: date and athletes, a conflict question, the choice resent with the server's token; the result says what happened", async () => {
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
  assert.match(text(), /3 weeks without a plan get a new weekly plan either way\./);
  assert.match(text(), /Main · Wed 09\.12 · AM has results, so it stays\./);
  assert.match(text(), /Someone is editing this week right now\. It stays as it is\./);
  assert.deepEqual([...content().querySelectorAll(".builder-tw-conflict-actions button")].map((b) => b.textContent), ["Replace", "Skip weeks that already have a plan", "Cancel"]);
  answers.push({ status: 201, body: { created: [{}, {}, {}], replaced: [{}], skipped: [{}], kept: 1 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-choice", { choice: "replace" }), handlers);
  const second = calls.at(-1);
  assert.equal(second.body.choice, "replace");
  assert.equal(second.body.choiceToken, "tok-1");
  assert.notEqual(second.body.assignmentRequestId, first.body.assignmentRequestId);
  assert.match(text(), /Assigned\. 3 new weekly plans, 1 week replaced, 1 week left as it was\. 1 session with results or an event link stayed\./);
});

test("5. a lost answer: Assign again resends the same key; Cancel on the question sends nothing", async () => {
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle", { athleteId: "12" }), handlers);
  answers.push(new TypeError("Failed to fetch"));
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.match(text(), /No answer from the server\. Assign again: nothing is written twice\./);
  const key = calls.at(-1).body.assignmentRequestId;
  answers.push({ status: 409, body: { code: "weekly_assign_conflicts", choiceToken: "t", newWeeks: 0, athletes: [{ athleteId: "12", name: "Example Beta", weeks: [{ weekStart: "2026-12-07", days: ["2026-12-07"], contentDays: [], kept: [] }] }] } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.equal(calls.at(-1).body.assignmentRequestId, key);
  const before = calls.length;
  await handleWeeklyTemplateAction(button("builder-tw-assign-back"), handlers);
  assert.equal(calls.length, before);
  assert.ok(content().querySelector("[data-tw-start-date]"));
});

test("6. an edit draft of the template is saved first, so the athletes get the saved template", async () => {
  state.builder.draft = { ...template(), plan: { ...template().plan, id: "T1-edit", isEditDraft: true, status: "draft" } };
  await handleWeeklyTemplateAction(button("builder-tw-assign-open"), handlers);
  await handleWeeklyTemplateAction(button("builder-tw-assign-toggle", { athleteId: "11" }), handlers);
  answers.push({ status: 200, body: template() });
  answers.push({ status: 201, body: { created: [{}], replaced: [], skipped: [], kept: 0 } });
  await handleWeeklyTemplateAction(button("builder-tw-assign-submit"), handlers);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", "/api/builder/plans/T1-edit/submit"], ["POST", "/api/builder/plans/T1/assign-weekly"]]);
});

test("7. save weeks as template: the athlete's weekly plans listed, any chosen, sent in one request, the new template opens", async () => {
  state.builder.draft = { plan: { id: "W1", name: "Week", planType: "weekly", status: "active", athleteId: "11", athleteName: "Example Alpha", weekStart: "2026-12-07" }, blocks: [], batch: null };
  answers.push({ status: 200, body: { plans: [
    { plan_id: "W3", plan_type: "weekly", week_start: "2026-12-21", plan_name: "Late", session_count: 2 },
    { plan_id: "P1", plan_type: "program", plan_name: "A program" },
    { plan_id: "W1", plan_type: "weekly", week_start: "2026-12-07", plan_name: "Week", session_count: 1 },
  ] } });
  await handleWeeklyTemplateAction(button("builder-tw-save-open"), handlers);
  const rows = [...content().querySelectorAll('[data-action="builder-tw-save-toggle"]')];
  assert.deepEqual(rows.map((r) => r.dataset.planId), ["W1", "W3"]);
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  await handleWeeklyTemplateAction(button("builder-tw-save-toggle", { planId: "W3" }), handlers);
  // No name: asked, nothing sent.
  await handleWeeklyTemplateAction(button("builder-tw-save-submit"), handlers);
  assert.match(text(), /Give the template a name\./);
  assert.equal(calls.length, 1);
  content().querySelector("[data-tw-save-name]").value = "Preseason weeks";
  answers.push({ status: 201, body: template(2) });
  await handleWeeklyTemplateAction(button("builder-tw-save-submit"), handlers);
  assert.deepEqual(calls.at(-1), { url: "/api/builder/weekly-templates", method: "POST", body: { name: "Preseason weeks", planIds: ["W1", "W3"] } });
  assert.equal(state.builder.draft.plan.id, "T1");
  assert.equal(state.builder.saveWeeks, null);
});

test("8. the library: Weekly / Blocks mark on each card and the Type filter", () => {
  const weekly = { plan_id: "a", plan_name: "Weekly", template_kind: "weekly", week_count: 6 };
  const blocksOnly = { plan_id: "b", plan_name: "Blocks", template_kind: "blocks", week_count: 0 };
  assert.equal(templateKindLabel(weekly), "Weekly · 6 weeks");
  assert.equal(templateKindLabel({ ...weekly, week_count: 1 }), "Weekly · 1 week");
  assert.equal(templateKindLabel(blocksOnly), "Blocks");
  const card = renderProgramLibraryCard(weekly, new Set(), null, null);
  assert.match(card, /program-kind-chip is-weekly/);
  assert.match(card, /Weekly · 6 weeks/);
  assert.deepEqual(applyTemplateClientFilters([weekly, blocksOnly], { kind: "weekly" }).map((t) => t.plan_id), ["a"]);
  assert.deepEqual(applyTemplateClientFilters([weekly, blocksOnly], { kind: "blocks" }).map((t) => t.plan_id), ["b"]);
  assert.deepEqual(applyTemplateClientFilters([weekly, blocksOnly], { kind: "" }).map((t) => t.plan_id), ["a", "b"]);
});

test("9. the template create form: Weekly program or Blocks; Weekly asks the number of weeks", () => {
  state.builder = emptyBuilderState({ entryType: "template", planType: "program" });
  renderBuilder();
  const kinds = [...content().querySelectorAll('input[name="templateKind"]')];
  assert.deepEqual(kinds.map((k) => [k.value, k.checked]), [["weekly", false], ["blocks", true]]);
  assert.equal(content().querySelector('input[name="weeks"]'), null);
  state.builder.createTemplateKind = "weekly";
  renderBuilder();
  assert.equal(content().querySelector('input[name="templateKind"][value="weekly"]').checked, true);
  const weeks = content().querySelector('input[name="weeks"]');
  assert.deepEqual([weeks.min, weeks.max, weeks.value], ["1", "52", "4"]);
  const form = new window.FormData(content().querySelector('[data-builder-form="create"]'));
  assert.equal(form.get("templateKind"), "weekly");
  assert.equal(form.get("planType"), "program");
});
