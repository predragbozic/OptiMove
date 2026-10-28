// Training Load -> Data configuration: the start screen (layout C, PR-1;
// docs/ai/data-configuration-visual-proposal.md section 4). Driven through the
// real handlers and the real markup in a DOM, with a fake fetch: which cards
// each workspace gets, that their counts come from the reads the screens
// already make (each read once, never a read of its own), what a card says
// while a read runs, fails or holds a filtered list, the way into each screen
// and back, Source fields' way back to the start screen, and the focus moving
// to each new screen's title.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
dom.window.confirm = () => true;
dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

let respond = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => respond(call));
after(() => restoreFetch());

const { handleVariablesAction, loadVariablesSection, resetVariables } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { resetSourceFields } = await import("../source-fields-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { state } = await import("../state.js");

const VB = "/api/training-load/sources/metrics/variables";
const CB = "/api/training-load/sources/metrics/classification";
const FB = "/api/training-load/sources/metrics/fields";
const CLUB = "11111111-0000-4000-8000-000000000001";

const node = (id, name, over = {}) => ({ id, key: id, name, description: null, ownerScope: "system", state: "active", editable: true, actions: [], namesToken: "b".repeat(64), truncated: false, ...over });
const tree = () => ({
  domains: [node("d1", "Endurance <b>"), node("d2", "Speed"), node("d3", "Old", { state: "archived" })],
  categories: [node("c1", "Aerobic capacity"), node("c2", "Sprint", { state: "archived" })],
  categoryDomains: [],
  truncated: false,
});
const variable = (id, label, icon = null) => ({ id, key: id, label, shortLabel: null, description: null, icon, ownerScope: "system", state: "active", editable: true, levels: ["session"], currentVersion: { id: `v-${id}`, versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: null, maxValue: null, condition: null }, mappingTarget: { ready: true, notReadyCode: null }, actions: [], labelsToken: "a".repeat(64), truncated: false });
const field = (id, label) => ({ id, sourceSystem: "gpexe", apiFamily: "rest_v1", key: id, label, state: "active", revisions: [{ id: `r-${id}`, revisionNumber: 1, state: "active", valueShape: "number", parameterKind: "none", expectedSourceUnit: "m", supportsSession: true, supportsDrill: true, evidenceStatus: "observed" }] });

let variables = [];
let nextCursor = null;
let fields = [];
function serve() {
  respond = (call) => {
    if (call.method === "GET" && call.url === CB) return { status: 200, body: tree() };
    if (call.method === "GET" && call.url.startsWith(`${VB}?`)) return { status: 200, body: { variables, nextCursor } };
    if (call.method === "GET" && call.url === FB) return { status: 200, body: { fields } };
    return { status: 404, body: { error: "notFound" } };
  };
}

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
const $ = (selector) => content.querySelector(selector);
const gets = () => calls.filter((call) => call.method === "GET").map((call) => call.url);
const cards = () => [...content.querySelectorAll(".dc-card")].map((card) => ({
  title: card.querySelector(".dc-card-title strong").textContent,
  summary: card.querySelector(".dc-card-title .muted").textContent,
  rows: [...card.querySelectorAll(".dc-card-row")].map((row) => row.textContent.trim()),
}));
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
const asPlatform = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform" } }; };
const asClub = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK <Borac>" } }; };
const asCoach = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "t1", clubId: CLUB, label: "First team" } }; };

beforeEach(() => {
  resetVariables();
  resetSourceFields();
  calls.length = 0;
  variables = [variable("v1", "Total distance", "run"), variable("v2", "Sprint <i>distance</i>"), variable("v3", "Top speed", "speed"), variable("v4", "Accelerations")];
  nextCursor = null;
  fields = [field("f1", "Total time"), field("f2", "Distance <x>")];
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

test("1. Data configuration opens on the start screen: four cards for an administrator, each with its count and its first rows, from one read each", async () => {
  assert.equal(variablesState().view, "home", "a fresh screen starts on the start screen");
  await loadVariablesSection(render);
  assert.deepEqual(gets().sort(), [CB, FB, `${VB}?scope=own&state=active`].sort(), "the tree, the list and the fields: one read each, no read of its own");
  assert.equal($("#metric-variables-title").textContent, "Data configuration");
  assert.deepEqual(cards(), [
    { title: "Variables", summary: "4 active variables", rows: ["Total distance", "Sprint <i>distance</i>", "Top speed"] },
    { title: "Domains", summary: "2 domains · 1 archived", rows: ["Endurance <b>", "Speed"] },
    { title: "Categories", summary: "1 category · 1 archived", rows: ["Aerobic capacity"] },
    { title: "Source fields", summary: "2 fields", rows: ["Total time", "Distance <x>"] },
  ]);
  assert.ok(content.innerHTML.includes("Sprint &lt;i&gt;distance&lt;/i&gt;") && content.innerHTML.includes("Endurance &lt;b&gt;") && content.innerHTML.includes("Distance &lt;x&gt;"), "every name is escaped");
  assert.equal(content.querySelectorAll("i, b, x").length, 0);
  // A variable with an icon shows it; one without shows the neutral tile.
  const rows = content.querySelectorAll(".dc-card")[0].querySelectorAll(".dc-card-row .dc-tile-variable");
  assert.equal(rows[0].classList.contains("is-empty"), false);
  assert.equal(rows[1].classList.contains("is-empty"), true);
  // Every card is one button with the chevron "opens another screen".
  for (const card of content.querySelectorAll(".dc-card")) {
    assert.equal(card.tagName, "BUTTON");
    assert.ok(card.querySelector(".dc-chevron"));
  }
  assert.ok(!$(".metric-variables-segmented") && !$(".training-load-subnav"), "no switch: the start screen replaces both");
});

test("2. a club's administrator gets the same four cards; a team's coach three, never Source fields, and nothing reads the fields", async () => {
  asClub();
  await loadVariablesSection(render);
  assert.deepEqual(cards().map((c) => c.title), ["Variables", "Domains", "Categories", "Source fields"]);
  assert.match(content.textContent, /How FK <Borac>'s training data is described/);
  assert.ok(content.innerHTML.includes("FK &lt;Borac&gt;"), "the club's name is escaped");
  resetVariables();
  resetSourceFields();
  calls.length = 0;
  asCoach();
  await loadVariablesSection(render);
  assert.deepEqual(cards().map((c) => c.title), ["Variables", "Domains", "Categories"]);
  assert.ok(!gets().includes(FB), "a coach's screen never reads the source fields");
  assert.match(content.textContent, /The variables of this team's club and how they are grouped\./);
  // Rendered in Training Load, the coach's start screen has no way to Source fields.
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!html.includes('data-section="source-fields"'));
});

test("3. a card says what it can: loading, a failed read, a list that holds more than its first page, a filtered list, nothing yet", async () => {
  let release;
  const base = respond;
  respond = (call) => (call.url === CB ? new Promise((resolve) => { release = () => resolve({ status: 200, body: tree() }); }) : base(call));
  const pending = loadVariablesSection(render);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cards()[1].summary, "Loading...");
  release();
  await pending;
  assert.equal(cards()[1].summary, "2 domains · 1 archived");

  resetVariables();
  resetSourceFields();
  respond = (call) => (call.url === FB || call.url === CB || call.url.startsWith(`${VB}?`) ? { status: 500, body: { error: "internal_error" } } : base(call));
  await loadVariablesSection(render);
  assert.deepEqual(cards().map((c) => c.summary), ["Could not be loaded. Open the list to try again.", "Could not be loaded. Open to try again.", "Could not be loaded. Open to try again.", "Could not be loaded. Open to try again."]);

  resetVariables();
  resetSourceFields();
  nextCursor = "next";
  variables = [variable("v1", "Total distance")];
  fields = [];
  respond = base;
  await loadVariablesSection(render);
  assert.equal(cards()[0].summary, "More than 1 active variables");
  assert.equal(cards()[3].summary, "No source fields yet");

  // A list read with a filter or another state counts nothing: it is not this workspace's active list.
  variablesState().stateFilter = "archived";
  render();
  assert.deepEqual([cards()[0].summary, cards()[0].rows], ["Open the list", []]);
  variablesState().stateFilter = "active";
  variablesState().filter = { kind: "domain", id: "d1" };
  render();
  assert.equal(cards()[0].summary, "Open the list");

  resetVariables();
  variables = [];
  await loadVariablesSection(render);
  assert.equal(cards()[0].summary, "No active variables yet");
});

test("4. each card opens its screen at its title (the focus goes there); its way back reaches the start screen without a new read", async () => {
  await loadVariablesSection(render);
  const read = gets().length;
  await click('.dc-card[data-view="variables"]');
  assert.equal(variablesState().view, "variables");
  assert.equal(document.activeElement, $("#metric-variables-title"), "the focus moves to the new screen's title");
  assert.equal($("#metric-variables-title").textContent, "Variables");
  assert.equal(gets().length, read, "the list read for the start screen is shown");
  await click('[data-action="metric-classification-view"][data-view="home"]');
  assert.equal(variablesState().view, "home");
  assert.equal(document.activeElement, $("#metric-variables-title"));
  assert.equal(gets().length, read, "back on the start screen: nothing read again");
  await click('.dc-card[data-view="domains"]');
  assert.equal($("#metric-variables-title").textContent, "Domains");
  assert.equal(gets().filter((url) => url === CB).length, 2, "Domains reads the tree again");
  await click('[data-action="metric-classification-view"][data-view="home"]');
  await click('.dc-card[data-view="categories"]');
  assert.equal($("#metric-variables-title").textContent, "Categories");
  assert.equal(document.activeElement, $("#metric-variables-title"));
});

test("5. Source fields opens through Training Load's own section switch; its way back opens the start screen, whatever screen of Variables was last shown", async () => {
  await loadVariablesSection(render);
  const card = $('.dc-card[data-section="source-fields"]');
  assert.equal(card.dataset.action, "training-load-section");
  await handleTrainingLoadAction(card, { renderTrainingLoad: () => {}, openWeeklyPlanForAthleteOnDate: () => {} });
  assert.equal(state.trainingLoad.section, "source-fields");
  const html = renderTrainingLoadCoachHtml();
  const host = document.createElement("div");
  host.innerHTML = html;
  const back = host.querySelector('[data-action="training-load-section"][data-section="variables"][data-dc-home]');
  assert.ok(back, "Source fields has its way back");
  assert.equal(back.textContent, "← Data configuration");
  variablesState().view = "categories";
  variablesState().node = { kind: "category", id: "c1" };
  await handleTrainingLoadAction(back, { renderTrainingLoad: () => {}, openWeeklyPlanForAthleteOnDate: () => {} });
  assert.equal(state.trainingLoad.section, "variables");
  assert.deepEqual([variablesState().view, variablesState().node], ["home", null], "the start screen, not the last screen");
});

test("6. a workspace switch starts again on the start screen; opening a variable from anywhere shows it on the Variables screen", async () => {
  await loadVariablesSection(render);
  await click('.dc-card[data-view="domains"]');
  resetVariables();
  assert.equal(variablesState().view, "home");
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="v1"></button>`;
  respond = (call) => (call.url.startsWith(`${VB}/v1`) ? { status: 200, body: { variable: { ...variable("v1", "Total distance", "run"), versions: [] }, nextCursor: null } } : { status: 200, body: tree() });
  await click('[data-action="metric-variables-open"]');
  assert.equal(variablesState().view, "variables");
  assert.equal($("#metric-variables-title").textContent, "Total distance");
  assert.ok($(".dc-title .dc-tile-variable:not(.is-empty) svg"), "the variable's icon beside its name");
});
