// Weekly program templates, part WT-C (docs/ai/weekly-program-template-plan.md):
// Save as template from an athlete's chosen weeks.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="contextLabel"></div><h2 id="screenTitle"></h2><div id="viewToolbar"></div><div id="content"></div>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.requestAnimationFrame = (callback) => callback();
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");
const { handleSaveWeeksAction: handleWeeklyTemplateAction } = await import("../builder-weekly-save-actions.js");

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

test("1. save weeks as template: the athlete's weekly plans listed, any chosen, sent in one request, the new template opens", async () => {
  state.builder.draft = { plan: { id: "W1", name: "Week", planType: "weekly", status: "active", athleteId: "11", athleteName: "Example Alpha", weekStart: "2026-12-07" }, blocks: [], batch: null };
  answers.push({ status: 200, body: { plans: [
    { plan_id: "W3", plan_type: "weekly", week_start: "2026-12-21", plan_name: "Late", session_count: 2 },
    { plan_id: "P1", plan_type: "program", plan_name: "A program" },
    { plan_id: "W1", plan_type: "weekly", week_start: "2026-12-07", plan_name: "Week", session_count: 1 },
  ] } });
  await handleWeeklyTemplateAction(button("builder-tw-save-open"), handlers);
  const rows = [...content().querySelectorAll('[data-action="builder-tw-save-toggle"]')];
  // Newest first; the week on screen is chosen to start with.
  assert.deepEqual(rows.map((r) => r.dataset.planId), ["W3", "W1"]);
  assert.equal(rows[1].getAttribute("aria-pressed"), "true");
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

test("2. save weeks: newest first, the open week marked, and a sentence after the save", async () => {
  state.builder.draft = { plan: { id: "W1-edit", isEditDraft: true, editSourcePlanId: "W1", name: "Week", planType: "weekly", status: "draft", athleteId: "11", athleteName: "Example Alpha", weekStart: "2026-12-07" }, blocks: [], batch: null };
  answers.push({ status: 200, body: { plans: [
    { plan_id: "W1", plan_type: "weekly", week_start: "2026-12-07", plan_name: "Week", session_count: 1 },
    { plan_id: "W3", plan_type: "weekly", week_start: "2026-12-21", plan_name: "Late", session_count: 2 },
  ] } });
  await handleWeeklyTemplateAction(button("builder-tw-save-open"), handlers);
  const rows = [...content().querySelectorAll('[data-action="builder-tw-save-toggle"]')];
  assert.deepEqual(rows.map((r) => r.dataset.planId), ["W3", "W1"]);
  assert.match(rows[1].textContent, /\(open now\)/);
  assert.equal(rows[1].getAttribute("aria-pressed"), "true");
  content().querySelector("[data-tw-save-name]").value = "Two weeks";
  answers.push({ status: 201, body: template(1) });
  await handleWeeklyTemplateAction(button("builder-tw-save-submit"), handlers);
  assert.deepEqual(calls.at(-1).body, { name: "Two weeks", planIds: ["W1"] });
  assert.match(text(), /Saved as the template “Two weeks”\. It is a draft: change it here, then save it\./);
});
