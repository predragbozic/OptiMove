// Weekly program templates, part WT-A (docs/ai/weekly-program-template-plan.md):
// the Builder's week strip (one week on screen, add / duplicate / move / delete
// with a confirmation, a lost answer read again), the template create form's
// type choice, and the Program Library's mark and filter.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");
const { handleWeeklyTemplateAction } = await import("../builder-weekly-template-actions.js");
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

test("4. the library: Weekly / Blocks mark on each card and the Type filter", () => {
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

test("5. the template create form: Weekly program or Blocks; Weekly asks the number of weeks", () => {
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

test("6. a week change with no answer reads the template again and says so; a saved change answered with reload reads it too", async () => {
  answers.push(new TypeError("Failed to fetch"));
  answers.push({ status: 200, body: template(3) });
  await handleWeeklyTemplateAction(button("builder-tw-add-week"), handlers);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", "/api/builder/plans/T1/weeks"], ["GET", "/api/builder/plans/T1"]]);
  assert.equal(state.builder.draft.plan.weekCount, 3);
  assert.match(text(), /No answer from the server\. The template is shown as it is now: check the weeks before trying again\./);
  answers.push({ status: 201, body: { planId: "T1", reload: true } });
  answers.push({ status: 200, body: template(4) });
  await handleWeeklyTemplateAction(button("builder-tw-add-week"), handlers);
  assert.equal(state.builder.draft.plan.weekCount, 4);
  assert.equal(state.builder.templateWeekError, "");
});
