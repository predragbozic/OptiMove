// Training Load -> Data configuration -> Variables, calculated variables (J21, PR 3; C141, C144, C147, C150): New variable ->
// Calculated by OptiMove, the variables it adds up chosen by name (no formula), the ones that cannot be added up listed with
// the reason (never hidden), the plain sentences (from now on, per team, missing input, overlap, athletes), the exact
// request, a calculated variable's detail and its new version, and the server's own sentences of v78's refusals. Through the
// real handlers and markup in a DOM with a fake fetch.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let confirmAnswer = true;
const confirmQuestions = [];
dom.window.confirm = (question) => { confirmQuestions.push(question); return confirmAnswer; };
dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

let respond = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => respond(call));
after(() => restoreFetch());

const { KEY_SUGGESTION_DELAY_MS, handleVariablesAction, handleVariablesInput, resetVariables, submitVariablesForm, variablesMayBeLeft } = await import("../metric-variables-actions.js");
const { WRITE_BOUND_MS, buildRequest, openForm, variablesContext, variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { confirmLeaveTrainingLoad, handleTrainingLoadAction, handleTrainingLoadBeforeUnload, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { state } = await import("../state.js");
// These tests work on the variables list, as opened from the Data
// configuration start screen (layout C); the start screen itself is proved in
// data-config-home.actions.test.mjs.
const resetToList = () => { resetVariables(); variablesState().view = "variables"; };

const BASE = "/api/training-load/sources/metrics/variables";
const CLUB = "11111111-0000-4000-8000-000000000001";
const VAR_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const VER_ID = "bbbbbbbb-1111-4000-8000-000000000001";
const VER_2 = "bbbbbbbb-1111-4000-8000-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const version = (over = {}) => ({ id: VER_ID, versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: "0", maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z", ...over });
const variable = (over = {}) => ({
  id: VAR_ID, key: "total_distance", label: "Total distance", shortLabel: "TotDist", description: null, ownerScope: "system", state: "active", editable: true,
  levels: ["session", "drill"], currentVersion: version(), mappingTarget: { ready: true, notReadyCode: null },
  createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z", truncated: false,
  // What the server says this caller may do now (R2, J3b.2).
  actions: ["rename", "archive", "newVersion"], labelsToken: "a".repeat(64), ...over,
});
const detail = (over = {}, versions = null) => {
  const v = variable(over);
  return { variable: { ...v, versions: versions || [{ ...v.currentVersion, current: true, reason: null }] }, nextCursor: null };
};

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => handleVariablesInput(event.target, { render }));
content.addEventListener("change", (event) => handleVariablesInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
// The value a fact of one variable (a <dt> / <dd> pair) shows.
const fact = (name) => [...content.querySelectorAll(".metric-variables-facts dt")].find((dt) => dt.textContent === name)?.nextElementSibling?.textContent;
const posts = () => calls.filter((call) => call.method === "POST");
// The variables' own reads; the screen's read of the domains and categories
// (phase 12c) is proved in metric-classification.actions.test.mjs.
const gets = () => calls.filter((call) => call.method === "GET" && !call.url.includes("/metrics/classification")).map((call) => call.url);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
function type(field, value) {
  const element = $(`[data-mv-field="${field}"]`);
  assert.ok(element, `the ${field} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function choose(field, value) {
  const element = $(`[data-mv-field="${field}"]`);
  assert.ok(element, `the ${field} field is on the screen`);
  element.value = value;
  // A browser fires both on a select; after a repaint the old one is detached.
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function tick(level, checked) {
  const box = $(`[data-mv-level="${level}"]`);
  box.checked = checked;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}

beforeEach(() => {
  resetToList();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  respond = () => ({ status: 404, body: { error: "notFound" } });
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

function listing(items, { nextCursor = null } = {}) {
  return (call) => {
    if (call.method === "GET" && call.url.startsWith(`${BASE}?`)) return { status: 200, body: { variables: items, nextCursor } };
    if (call.method === "GET" && call.url.startsWith(`${BASE}/${VAR_ID}`)) return { status: 200, body: detail() };
    return { status: 404, body: { error: "notFound" } };
  };
}

const zone = (n, over = {}) => variable({ id: `aaaaaaaa-2222-4000-8000-00000000000${n}`, key: `pz${n}`, label: `Power zone ${n} distance`, shortLabel: null, ownerScope: "system", levels: ["session", "drill"], currentVersion: version({ id: `bbbbbbbb-2222-4000-8000-00000000000${n}`, unit: "m", dailyAggregationMethod: "sum", minValue: null }), ...over });
const CANDIDATES = [
  zone(3), zone(4), zone(5),
  zone(6, { label: "Session only zone", levels: ["session"] }),
  variable({ id: "aaaaaaaa-2222-4000-8000-000000000007", label: "Top speed", currentVersion: version({ unit: "m/s", dailyAggregationMethod: "max" }) }),
  variable({ id: "aaaaaaaa-2222-4000-8000-000000000008", label: "Longest run", currentVersion: version({ unit: "m", dailyAggregationMethod: "max" }) }),
  variable({ id: "aaaaaaaa-2222-4000-8000-000000000009", label: "Old HMLD", currentVersion: version({ unit: "m", calculation: { kind: "sum", inputs: [] } }) }),
  variable({ id: "aaaaaaaa-2222-4000-8000-00000000000a", label: "Archived zone", state: "archived" }),
];
const Z = (n) => `aaaaaaaa-2222-4000-8000-00000000000${n}`;
function candidatesAnd(extra = () => null) {
  return (call) => extra(call) || (call.method === "GET" && call.url.startsWith(`${BASE}?`) ? { status: 200, body: { variables: CANDIDATES, nextCursor: null } } : { status: 404, body: { error: "notFound" } });
}
function chooseKind(value) {
  const radio = $(`[data-mv-kind][value="${value}"]`);
  assert.ok(radio, `the ${value} choice is on the screen`);
  radio.checked = true;
  radio.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function pick(id, checked = true) {
  const box = $(`[data-mv-input="${id}"]`);
  assert.ok(box, `${id} can be ticked`);
  box.checked = checked;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
}
async function openCalculated() {
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  chooseKind("calculated");
  await settle();
}

test("New variable -> Calculated by OptiMove: no day rule or allowed values; the plain sentences; the variables that can be added up are offered by name, the rest listed with the reason", async () => {
  respond = candidatesAnd();
  await openCalculated();
  assert.equal($('[data-mv-field="dailyAggregationMethod"]'), null, "no day rule to choose");
  assert.equal($('[data-mv-field="minValue"]'), null, "no allowed values");
  for (const sentence of [
    /A day's values are added up \(Sum\)\. A calculated variable has no allowed values\./,
    /Calculated for sessions imported after this variable was made\. Sessions imported earlier stay without it\./,
    /OptiMove calculates it for a team once every variable it adds up is switched on for that team\./,
    /If one of them has no value in a session, this variable has no value there either \(zero is a value; missing is not\)\./,
    /OptiMove does not check whether two of them count the same thing/,
    /Athletes do not see calculated variables\./,
    /It stays calculated\./,
  ]) assert.match(text(), sentence);
  assert.match(text(), /Enter the unit above: the variables of that unit are offered here\./, "before a unit, nothing is offered");
  type("unit", "m");
  const offered = [...content.querySelectorAll(".metric-variables-inputs [data-mv-input]")].map((b) => b.dataset.mvInput);
  assert.deepEqual(offered, [Z(3), Z(4), Z(5), Z(6)], "the zones in m added up by day, by name");
  const why = [...content.querySelectorAll(".metric-variables-unavailable li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(why, [
    "Longest run It is a highest value, not an amount, so it cannot be added up.",
    "Old HMLD Calculated itself; a calculated variable adds up ordinary variables only.",
    "Top speed It is a highest value, not an amount, so it cannot be added up.",
  ], "listed with the reason, never hidden; an archived one is not listed");
  tick("drill", true);
  assert.ok(!$(`.metric-variables-inputs [data-mv-input="${Z(6)}"]`), "a zone without drill values is no longer offered for a drill variable");
  assert.match(text(), /Session only zone Not recorded for drill\./);
});

test("Create sends the calculation in the order ticked, Sum as the day rule, no allowed values; fewer than two is refused before anything is sent", async () => {
  respond = candidatesAnd((call) => (call.method === "POST" && call.url === BASE ? { status: 201, body: { variable: variable({ label: "HMLD" }), replayed: false } }
    : call.url.startsWith(`${BASE}/key-suggestion`) ? { status: 200, body: { key: "hmld", taken: false } } : null));
  await openCalculated();
  type("label", "HMLD");
  type("unit", "m");
  pick(Z(5));
  await submit();
  assert.equal(posts().length, 0, "one variable is not a sum");
  assert.match(text(), /Choose at least 2 variables to add up\./);
  pick(Z(3));
  pick(Z(4));
  assert.deepEqual([...content.querySelectorAll(".metric-variables-inputs .item-badge")].map((b) => b.textContent), ["2", "3", "1"], "each ticked one shows its place");
  await submit();
  await settle();
  assert.equal(posts().length, 1);
  const body = posts()[0].body;
  assert.deepEqual(body.calculation, { kind: "sum", inputs: [Z(5), Z(3), Z(4)] });
  assert.equal(body.dailyAggregationMethod, "sum");
  assert.ok(!("minValue" in body) && !("maxValue" in body), "no allowed values");
  assert.deepEqual(body.levels, ["session"]);
});

test("Measured stays as before: switching back drops nothing of the measured form, and the body carries no calculation", async () => {
  respond = candidatesAnd((call) => (call.method === "POST" && call.url === BASE ? { status: 201, body: { variable: variable(), replayed: false } }
    : call.url.startsWith(`${BASE}/key-suggestion`) ? { status: 200, body: { key: "x", taken: false } } : null));
  await openCalculated();
  chooseKind("measured");
  assert.ok($('[data-mv-field="dailyAggregationMethod"]'));
  type("label", "Total distance");
  type("unit", "m");
  choose("dailyAggregationMethod", "sum");
  await submit();
  await settle();
  assert.equal(posts().length, 1);
  assert.ok(!("calculation" in posts()[0].body));
});

test("club: the variables to add up are its own and OptiMove's, read once each; OptiMove's are marked", async () => {
  asClub();
  respond = (call) => {
    if (call.url.includes("scope=own")) return { status: 200, body: { variables: [zone(3, { ownerScope: "club", label: "Club zone 3" })], nextCursor: null } };
    if (call.url.includes("scope=system")) return { status: 200, body: { variables: [zone(4), zone(5)], nextCursor: null } };
    return { status: 404, body: { error: "notFound" } };
  };
  await openCalculated();
  type("unit", "m");
  const reads = gets().filter((u) => u.includes("state=active"));
  assert.ok(reads.includes(`${BASE}?scope=own&state=active`) && reads.includes(`${BASE}?scope=system&state=active&hidden=include`), JSON.stringify(reads));
  assert.match(text(), /Power zone 4 distance m · OptiMove/);
  assert.doesNotMatch(text(), /Club zone 3 m · OptiMove/);
});

test("a calculated variable's detail says what it adds up and from when; its new version starts from its inputs and sends them", async () => {
  const calc = { kind: "sum", inputs: [3, 4, 5].map((n) => ({ id: Z(n), key: `pz${n}`, label: `Power zone ${n} distance` })) };
  respond = (call) => {
    if (call.method === "GET" && call.url.startsWith(`${BASE}?`)) return { status: 200, body: { variables: [variable({ label: "HMLD", currentVersion: version({ calculation: calc, minValue: null }) }), ...CANDIDATES], nextCursor: null } };
    if (call.method === "GET" && call.url.startsWith(`${BASE}/${VAR_ID}`)) return { status: 200, body: detail({ label: "HMLD", currentVersion: version({ calculation: calc, minValue: null }) }) };
    if (call.method === "POST") return { status: 201, body: { variable: variable(), replayed: false } };
    return { status: 404, body: { error: "notFound" } };
  };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  assert.match(text(), /adds up Power zone 3 distance \+ Power zone 4 distance \+ Power zone 5 distance/);
  await click(`[data-action="metric-variables-open"][data-variable-id="${VAR_ID}"]`);
  await settle();
  assert.match(fact("Calculated"), /Adds up Power zone 3 distance \+ Power zone 4 distance \+ Power zone 5 distance\./);
  assert.match(fact("Calculated"), /Calculated for sessions imported after this variable was made\./);
  assert.equal(fact("Allowed values"), undefined);
  await click('[data-action="metric-variables-version-open"]');
  await settle();
  assert.equal($('[data-mv-kind]'), null, "a variable keeps its kind");
  assert.deepEqual([...content.querySelectorAll(".metric-variables-inputs input:checked")].map((b) => b.dataset.mvInput), [Z(3), Z(4), Z(5)]);
  pick(Z(4), false);
  await submit();
  await settle();
  assert.deepEqual(posts()[0].body.calculation, { kind: "sum", inputs: [Z(3), Z(5)] });
  assert.equal(posts()[0].body.dailyAggregationMethod, "sum");
});

test("v78's refusals show the server's own sentence, which names the variable; a v77 code reads in plain words", async () => {
  const { codeText } = await import("../metric-variables-data.js");
  assert.equal(codeText({ status: 409, code: "calculation_input_archive_in_use", message: "HMLD adds up this variable; it cannot be archived while HMLD uses it." }, "archive"),
    "HMLD adds up this variable; it cannot be archived while HMLD uses it. Nothing was saved.");
  assert.equal(codeText({ status: 409, code: "calculation_unit_mismatch", message: "x" }), "Every chosen variable must have this variable's unit.");
});
