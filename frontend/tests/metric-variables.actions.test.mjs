// Training Load -> Data configuration -> Variables (M3a): the administrator's
// screen over the canonical-variable admin API (M3-0, J3). Driven through the
// real handlers and the real markup in a DOM, with a fake fetch, so both what
// the screen sends and what it shows are proved: who is offered the screen,
// the list / scope / state filter, one variable with its versions, the exact
// create and new-version bodies (never an owner, actor or basis), the field
// checks before anything is sent, every refusal code, a lost answer checked by
// the very same request, and the guards on leaving.
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
const gets = () => calls.filter((call) => call.method === "GET").map((call) => call.url);
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
  resetVariables();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  respond = () => ({ status: 404, body: { error: "notFound" } });
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

// A list route answering `items` for the first page.
function listing(items, { nextCursor = null } = {}) {
  return (call) => {
    if (call.method === "GET" && call.url.startsWith(`${BASE}?`)) return { status: 200, body: { variables: items, nextCursor } };
    if (call.method === "GET" && call.url.startsWith(`${BASE}/${VAR_ID}`)) return { status: 200, body: detail() };
    return { status: 404, body: { error: "notFound" } };
  };
}

// ---------------------------------------------------------------------------
// Who is offered the screen (C80)
// ---------------------------------------------------------------------------
test("the Data configuration tab is offered in the platform and a club workspace only; the filter is not shown there", () => {
  for (const [workspace, offered] of [
    [{ type: "platform", scopeId: null, label: "Platform" }, true],
    [{ type: "club", scopeId: CLUB, label: "FK Borac" }, true],
    [{ type: "team", scopeId: "t1", label: "First team" }, false],
    [{ type: "private_coach", scopeId: "u1", label: "Me" }, false],
    [{ type: "athlete", scopeId: "a1", label: "Me" }, false],
  ]) {
    state.currentUser = { id: "u1", activeWorkspace: workspace };
    const html = renderTrainingLoadCoachHtml();
    assert.equal(html.includes('data-section="variables"'), offered, `${workspace.type}: tab offered = ${offered}`);
    assert.equal(Boolean(variablesContext()), offered);
    assert.ok(!html.includes("training-load-filter-button"), "no shell filter in Data configuration");
  }
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: null, label: "?" } };
  assert.equal(variablesContext(), null, "a club workspace without a club id offers nothing");
  state.currentUser = null;
  assert.equal(variablesContext(), null);
});

test("a workspace without the screen reads nothing and says where variables are", async () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "t1", label: "First team" } };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  assert.equal(calls.length, 0);
  assert.match(text(), /available in the platform workspace, in a club workspace and in a team workspace of a club/);
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
test("platform: the system variables are listed with their facts; New variable is offered; no scope control", async () => {
  respond = listing([variable(), variable({ id: "v2", label: "Max <b>speed</b>", shortLabel: null, state: "archived", levels: ["session"], currentVersion: version({ unit: "km/h", dailyAggregationMethod: "max", versionNumber: 3 }) })]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  assert.deepEqual(gets(), [`${BASE}?scope=own&state=active`]);
  assert.match(text(), /System variables: shared by all clubs\. A platform administrator can map any club's source data to them\./);
  assert.match(text(), /Total distance \(TotDist\)/);
  assert.match(text(), /m · Session and Drill · per day: Sum · version 1/);
  assert.match(text(), /km\/h · Session · per day: Highest · version 3/);
  assert.ok($('[data-action="metric-variables-create-open"]'));
  assert.ok(!$('[data-action="metric-variables-scope"]'));
  assert.ok(content.innerHTML.includes("Max &lt;b&gt;speed&lt;/b&gt;"), "a name is escaped");
  assert.equal(content.querySelectorAll(".metric-variables-item .item-badge").length, 1, "the archived one is marked");
});

test("club: This club and System (reference); the reference cannot be created in, and an empty list says why", async () => {
  asClub();
  respond = (call) => (call.url.includes("scope=own") ? { status: 200, body: { variables: [variable({ ownerScope: "club" })], nextCursor: null } } : { status: 200, body: { variables: [], nextCursor: null } });
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  assert.match(text(), /Variables of FK Borac/);
  assert.ok($('[data-action="metric-variables-create-open"]'));
  assert.equal($('[data-scope="own"]').getAttribute("aria-pressed"), "true");
  await click('[data-scope="system"]');
  assert.deepEqual(gets(), [`${BASE}?scope=own&state=active`, `${BASE}?scope=system&state=active`]);
  assert.ok(!$('[data-action="metric-variables-create-open"]'), "no New variable in the system reference");
  assert.match(text(), /managed in the platform workspace; this club's own mappings cannot target them/);
  assert.match(text(), /There are no system variables yet\./);
  await click('[data-scope="system"]');
  assert.equal(gets().length, 2, "the same scope again reads nothing");
});

test("the state filter reads the list again; Show more appends the next page with its cursor", async () => {
  respond = (call) => {
    if (call.url.includes("cursor=c2")) return { status: 200, body: { variables: [variable({ id: "v3", label: "Third" })], nextCursor: null } };
    return { status: 200, body: { variables: [variable()], nextCursor: "c2" } };
  };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-more"]');
  assert.equal(gets().at(-1), `${BASE}?scope=own&state=active&cursor=c2`);
  assert.equal(content.querySelectorAll(".metric-variables-item").length, 2);
  assert.ok(!$('[data-action="metric-variables-more"]'), "no Show more after the last page");
  const select = $("[data-metric-variables-filter]");
  select.value = "archived";
  select.dispatchEvent(new window.Event("input", { bubbles: true }));
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(gets().at(-1), `${BASE}?scope=own&state=archived`);
  assert.equal(gets().filter((url) => url.includes("state=archived")).length, 1, "input and change read once");
});

test("a list that cannot be read offers Try again; a 404 says the workspace has no variables", async () => {
  respond = () => ({ status: 500, body: { error: "internal_error" } });
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  assert.match(text(), /The variables could not be loaded\./);
  respond = () => ({ status: 404, body: { error: "notFound" } });
  await click('[data-action="metric-variables-reload"]');
  assert.match(text(), /Variables are not available in this workspace\./);
});

test("an answer for a workspace that was left is dropped", async () => {
  let release;
  respond = () => new Promise((resolve) => { release = () => resolve({ status: 200, body: { variables: [variable({ label: "Old workspace" })], nextCursor: null } }); });
  const { loadVariables } = await import("../metric-variables-actions.js");
  const pending = loadVariables(render);
  resetVariables();
  release();
  await pending;
  assert.deepEqual(variablesState().list.items, [], "nothing of the old answer is kept");
});

// ---------------------------------------------------------------------------
// One variable
// ---------------------------------------------------------------------------
test("opening a variable shows its facts, versions and Technical details; New version only when the server's actions name it", async () => {
  respond = (call) => (call.url.includes("cursor=v-older")
    ? { status: 200, body: { variable: { ...variable(), versions: [{ ...version({ id: "old", versionNumber: 1 }), current: false, reason: null }] }, nextCursor: null } }
    : { status: 200, body: { ...detail({ currentVersion: version({ id: VER_2, versionNumber: 2, condition: { kind: "zone", operator: "between", lower: "19.8", upper: "25.2", unit: "km/h" } }) }, [{ ...version({ id: VER_2, versionNumber: 2 }), current: true, reason: "Zone corrected <now>" }]), nextCursor: "v-older" } });
  render();
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
  assert.equal(gets()[0], `${BASE}/${VAR_ID}`);
  assert.equal(fact("Unit"), "m");
  assert.equal(fact("Recorded for"), "Session and Drill");
  assert.equal(fact("Allowed values"), "At least 0");
  assert.equal(fact("Condition"), "Zone 19.8–25.2 km/h");
  assert.equal(fact("Mapping"), "Ready to be the target of a mapping.");
  assert.match(text(), /Version 2 Current/);
  assert.ok(content.innerHTML.includes("Reason: Zone corrected &lt;now&gt;"));
  assert.ok($(".data-sources-tech").textContent.includes(VAR_ID), "the id only under Technical details");
  assert.ok(!$(".metric-variables-head").textContent.includes(VAR_ID));
  assert.ok($('[data-action="metric-variables-version-open"]'));
  await click('[data-action="metric-variables-more-versions"]');
  assert.equal(gets().at(-1), `${BASE}/${VAR_ID}?cursor=v-older`);
  assert.equal(content.querySelectorAll(".metric-variables-version").length, 2);

  for (const over of [{ editable: false, actions: [] }, { actions: ["rename"] }, { state: "archived", actions: ["restore"] }]) {
    resetVariables();
    respond = () => ({ status: 200, body: detail(over) });
    content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
    await click('[data-action="metric-variables-open"]');
    assert.ok(!$('[data-action="metric-variables-version-open"]'), `no New version: ${JSON.stringify(over)}`);
  }
  assert.match(text(), /Archived: kept with its recorded values and its history; until it is restored, no new values can be entered for it, it gets no new version and no new mapping can use it\./);
});

test("a variable that is not available reads as such, with Try again", async () => {
  respond = () => ({ status: 404, body: { error: "notFound" } });
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
  assert.match(text(), /This variable is not available in this workspace\./);
  assert.ok($('[data-action="metric-variables-open"]'), "Try again");
  respond = listing([variable()]);
  await click('[data-action="metric-variables-back"]');
  assert.equal(gets().at(-1), `${BASE}?scope=own&state=active`);
  assert.ok($(".metric-variables-list"));
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
test("create: nothing is sent while a field is wrong; the wrong fields are marked and the first one gets focus", async () => {
  respond = listing([]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  assert.match(text(), /New system variable/);
  assert.match(text(), /Do not enter athlete names, ids, dates of birth or measured values\./);
  await submit();
  assert.equal(posts().length, 0);
  for (const field of ["label", "unit", "dailyAggregationMethod"]) {
    assert.equal($(`[data-mv-field="${field}"]`).getAttribute("aria-invalid"), "true", field);
    assert.ok(document.getElementById(`mv-err-${field}`), `${field} error`);
  }
  assert.equal(document.activeElement, $('[data-mv-field="label"]'));
  assert.match($(".metric-variables-form > .error").textContent, /Check the marked fields\./);
  type("label", "Total distance");
  assert.equal($('[data-mv-field="label"]').hasAttribute("aria-invalid"), false, "typing clears the field's error");
  assert.equal($(".metric-variables-form > .error"), null, "and the form's message, which no longer describes the values");
  assert.equal(variablesState().form.error, "");
  type("unit", "km h");
  type("minValue", "1e3");
  type("maxValue", "5");
  type("key", "Bad-Key");
  tick("session", false);
  choose("dailyAggregationMethod", "sum");
  await submit();
  assert.equal(posts().length, 0);
  const errors = variablesState().form.errors;
  assert.deepEqual(Object.keys(errors).sort(), ["key", "levels", "minValue", "unit"]);
});

test("create: the exact body - texts on one line, decimals as exact text (comma accepted), levels in order, the zone; no owner, actor or basis", async () => {
  respond = (call) => {
    if (call.method === "POST" && call.url === BASE) return { status: 201, body: { variable: variable({ id: VAR_ID, label: "Sprint distance" }), replayed: false } };
    if (call.url.startsWith(`${BASE}/key-suggestion`)) return { status: 200, body: { key: "sprint_distance", taken: false } };
    return listing([])(call);
  };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  type("label", "  Sprint   distance ");
  type("shortLabel", "Sprint");
  type("unit", "m");
  choose("dailyAggregationMethod", "sum");
  type("minValue", "0");
  type("maxValue", "12500,5");
  tick("drill", true);
  choose("conditionKind", "zone_between");
  assert.equal($('[data-mv-field="label"]').value, "  Sprint   distance ", "a repaint keeps what was typed");
  assert.equal(document.activeElement, $('[data-mv-field="conditionKind"]'), "focus stays on the condition");
  type("conditionLower", "25,2");
  type("conditionUpper", "40");
  type("conditionUnit", "km/h");
  await submit();
  assert.equal(posts().length, 1);
  const { url, body } = posts()[0];
  assert.equal(url, BASE);
  assert.match(body.requestKey, UUID);
  assert.deepEqual({ ...body, requestKey: "K" }, {
    requestKey: "K", label: "Sprint distance", shortLabel: "Sprint", levels: ["session", "drill"], unit: "m", dailyAggregationMethod: "sum",
    minValue: "0", maxValue: "12500.5", condition: { kind: "zone", operator: "between", lower: "25.2", upper: "40", unit: "km/h" },
  });
  for (const forbidden of ["owner", "ownerScope", "ownerClubId", "clubId", "actor", "basis", "userId"]) assert.ok(!(forbidden in body), forbidden);
  assert.match(text(), /The variable Sprint distance was created\./);
  assert.equal(gets().at(-1), `${BASE}/${VAR_ID}`, "the new variable is opened");
  assert.equal(variablesState().form, null);
});

test("create: an event threshold carries its operator and seconds; empty optional fields are left out", () => {
  const form = openForm("create");
  Object.assign(form.draft, { label: "Accelerations", unit: "count", dailyAggregationMethod: "sum", conditionKind: "event_threshold", conditionOperator: ">", conditionValue: "3", conditionDuration: "0.5", conditionUnit: "m/s2" });
  const { body, errors } = buildRequest(form);
  assert.deepEqual(errors, {});
  assert.deepEqual(Object.keys(body).sort(), ["condition", "dailyAggregationMethod", "label", "levels", "requestKey", "unit"]);
  assert.deepEqual(body.condition, { kind: "event_threshold", operator: ">", value: "3", durationSeconds: "0.5", unit: "m/s2" });
  form.draft.conditionDuration = "-1";
  assert.equal(buildRequest(form).errors.conditionDuration, "Zero or more.");
  for (const [typed, sent] of [["-0", "0"], ["-0,000", "0.000"]]) {
    form.draft.conditionDuration = typed;
    const zero = buildRequest(form);
    assert.equal(zero.errors.conditionDuration, undefined, `${typed} is zero, as the server reads it`);
    assert.equal(zero.body.condition.durationSeconds, sent);
  }
  form.draft.conditionDuration = "-0.5";
  assert.equal(buildRequest(form).errors.conditionDuration, "Zero or more.");
  Object.assign(form.draft, { conditionKind: "zone_between", conditionLower: "5", conditionUpper: "5" });
  assert.ok(buildRequest(form).errors.conditionUpper, "a zone's upper value is above its lower one");
  Object.assign(form.draft, { conditionKind: "none", minValue: "10", maxValue: "2" });
  assert.equal(buildRequest(form).errors.maxValue, "Not below the minimum.");
  Object.assign(form.draft, { minValue: "", maxValue: "", label: "Bad​name" });
  assert.ok(buildRequest(form).errors.label, "an invisible character is refused before sending");
  // Q10: every group the server adds is refused here first (an astral tag
  // character too); a name made only of blanks is an empty name.
  for (const cp of [0x034f, 0x115f, 0x17b4, 0x180b, 0x2065, 0x2800, 0x3164, 0xfe0f, 0xffa0, 0xfff9, 0x1bca0, 0x1d173, 0xe0041]) {
    form.draft.label = `Bad${String.fromCodePoint(cp)}name`;
    assert.equal(buildRequest(form).errors.label, "Contains a character that cannot be saved.", cp.toString(16));
  }
  form.draft.label = String.fromCodePoint(0x3000, 0xa0, 0x2003);
  assert.equal(buildRequest(form).errors.label, "Required.", "a name of blanks only is empty");
  Object.assign(form.draft, { label: "Accelerations", unit: `m${String.fromCodePoint(0x3164)}` });
  assert.equal(buildRequest(form).errors.unit, "No spaces, '|', '=' or hidden characters.", "a unit with a Hangul filler");
  form.draft.unit = "count";
  assert.deepEqual(buildRequest(form).errors, {});
});

test("create: the key is suggested from the name a moment after typing stops; a taken or impossible key opens Technical details", async () => {
  const answers = { "Total distance": { status: 200, body: { key: "total_distance", taken: true } }, "!!!": { status: 400, body: { error: "key_required" } } };
  respond = (call) => {
    if (call.url.startsWith(`${BASE}/key-suggestion`)) return answers[new URL(call.url, "http://x").searchParams.get("label")] || { status: 200, body: { key: "x", taken: false } };
    return listing([])(call);
  };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  type("label", "Tot");
  type("label", "Total distance");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  const suggestions = gets().filter((url) => url.includes("key-suggestion"));
  assert.deepEqual(suggestions, [`${BASE}/key-suggestion?label=Total%20distance`], "one read, for what the field holds");
  assert.match($("[data-mv-key-hint]").textContent, /Key: total_distance - already used here/);
  assert.equal($("[data-mv-key-hint]").closest("details").open, true);
  type("label", "!!!");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.match($("[data-mv-key-hint]").textContent, /No key can be made from this name/);
});

test("create: a key suggestion that answers after the name changed is never shown", async () => {
  const pending = {};
  respond = (call) => {
    if (!call.url.startsWith(`${BASE}/key-suggestion`)) return listing([])(call);
    const label = new URL(call.url, "http://x").searchParams.get("label");
    return new Promise((resolve) => { pending[label] = () => resolve({ status: 200, body: { key: label.toLowerCase(), taken: false } }); });
  };
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  type("label", "Alpha");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.ok(pending.Alpha, "the read for Alpha is in flight");
  type("label", "Beta");
  pending.Alpha();
  await settle();
  assert.ok(!$("[data-mv-key-hint]").textContent.includes("alpha"), "the answer for Alpha is not shown under Beta");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  pending.Beta();
  await settle();
  assert.match($("[data-mv-key-hint]").textContent, /Key: beta/);
});

test("create: once the form is sent, no key suggestion is read or shown (a lost save never reads as 'already used')", async () => {
  // Saved within the suggestion delay: the pending read is cancelled.
  await openCreateFilled();
  respond = (call) => {
    if (call.url.startsWith(`${BASE}/key-suggestion`)) return { status: 200, body: { key: "total_distance", taken: true } };
    return call.method === "POST" ? { throwNetworkError: true } : listing([])(call);
  };
  await submit();
  assert.equal(variablesState().form.unconfirmed, true);
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.deepEqual(gets().filter((url) => url.includes("key-suggestion")), [], "no suggestion read after the save");
  assert.ok(!/already used here/.test($("[data-mv-key-hint]")?.textContent || ""));

  // A read already in flight when the form is sent is not shown when it answers.
  resetVariables();
  calls.length = 0;
  let answerSuggestion;
  await openCreateFilled();
  respond = (call) => {
    if (call.url.startsWith(`${BASE}/key-suggestion`)) return new Promise((resolve) => { answerSuggestion = () => resolve({ status: 200, body: { key: "total_distance", taken: true } }); });
    return call.method === "POST" ? { throwNetworkError: true } : listing([])(call);
  };
  type("label", "Total distance");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.ok(answerSuggestion, "the suggestion read is in flight");
  await submit();
  assert.equal(variablesState().form.unconfirmed, true);
  answerSuggestion();
  await settle();
  assert.ok(!/already used here/.test($("[data-mv-key-hint]")?.textContent || ""), "the late answer is dropped");
});

test("create: a suggestion dropped by a send never leaves 'Making the key...'; after a definite refusal suggestions work again", async () => {
  let answerSuggestion;
  let answerSave;
  await openCreateFilled();
  respond = (call) => {
    if (call.url.startsWith(`${BASE}/key-suggestion`)) return new Promise((resolve) => { answerSuggestion = () => resolve({ status: 200, body: { key: "total_distance", taken: true } }); });
    if (call.method === "POST") return new Promise((resolve) => { answerSave = () => resolve({ status: 400, body: { error: "invalid_unit" } }); });
    return listing([])(call);
  };
  type("label", "Total distance");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.ok(answerSuggestion, "the suggestion read is in flight");
  const saving = submit();
  await settle();
  assert.equal(variablesState().form.busy, true, "the save is in flight");
  answerSuggestion();
  await settle();
  answerSave();
  await saving;
  await settle();
  assert.equal(variablesState().form.unconfirmed, false, "a definite refusal unlocks the form");
  assert.equal(variablesState().form.busy, false);
  assert.doesNotMatch($("[data-mv-key-hint]")?.textContent || "", /Making the key/);
  respond = (call) => (call.url.startsWith(`${BASE}/key-suggestion`) ? { status: 200, body: { key: "total_distance_2", taken: false } } : listing([])(call));
  type("label", "Total distance 2");
  await new Promise((resolve) => setTimeout(resolve, KEY_SUGGESTION_DELAY_MS + 50));
  assert.match($("[data-mv-key-hint]").textContent, /Key: total_distance_2/);
});

// ---------------------------------------------------------------------------
// A new version
// ---------------------------------------------------------------------------
async function openDetailWith(over = {}) {
  respond = () => ({ status: 200, body: detail(over) });
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
}

test("new version: it starts from the whole current semantics and sends all of it with the version it was made from", async () => {
  await openDetailWith({ currentVersion: version({ unit: "km/h", dailyAggregationMethod: "max", minValue: "0", maxValue: "45", condition: { kind: "event_threshold", operator: ">=", value: "3", durationSeconds: "1", unit: "m/s2" } }) });
  await click('[data-action="metric-variables-version-open"]');
  assert.match(text(), /New version of Total distance/);
  assert.equal($('[data-mv-field="unit"]').value, "km/h");
  assert.equal($('[data-mv-field="conditionDuration"]').value, "1");
  assert.ok(!$("[data-mv-level]"), "levels never change in a version");
  assert.ok(!$('[data-mv-field="label"]'), "the name is not part of a version");
  respond = (call) => (call.method === "POST" ? { status: 201, body: { variable: variable(), version: { id: VER_2, versionNumber: 2 } } } : { status: 200, body: detail() });
  type("maxValue", "50");
  type("reason", "Faster athletes");
  await submit();
  assert.equal(posts().length, 1);
  const { url, body } = posts()[0];
  assert.equal(url, `${BASE}/${VAR_ID}/versions`);
  assert.deepEqual({ ...body, requestKey: "K" }, {
    requestKey: "K", expectedCurrentVersionId: VER_ID, unit: "km/h", dailyAggregationMethod: "max", minValue: "0", maxValue: "50",
    condition: { kind: "event_threshold", operator: ">=", value: "3", durationSeconds: "1", unit: "m/s2" }, reason: "Faster athletes",
  });
  assert.match(text(), /Version 2 was saved\./);
});

test("new version: a condition stored in another shape must be chosen again, never cleared silently", async () => {
  await openDetailWith({ currentVersion: version({ condition: { kind: "unsupported" } }) });
  await click('[data-action="metric-variables-version-open"]');
  assert.equal($('[data-mv-field="conditionKind"]').value, "unsupported");
  await submit();
  assert.equal(posts().length, 0);
  assert.equal(variablesState().form.errors.conditionKind, "Choose the condition again.");
  choose("conditionKind", "none");
  respond = (call) => (call.method === "POST" ? { status: 201, body: { variable: variable(), version: { id: VER_2, versionNumber: 2 } } } : { status: 200, body: detail() });
  await submit();
  assert.ok(!("condition" in posts()[0].body), "None sends no condition");
});

test("new version: a version saved meanwhile closes the form and reads the variable again", async () => {
  await openDetailWith();
  await click('[data-action="metric-variables-version-open"]');
  type("unit", "km");
  respond = (call) => (call.method === "POST" ? { status: 409, body: { error: "current_version_changed", current: { id: VER_2 } } } : { status: 200, body: detail({ currentVersion: version({ id: VER_2, versionNumber: 2 }) }) });
  await submit();
  await settle();
  assert.equal(variablesState().form, null);
  assert.match(text(), /A new version was saved in the meantime \(perhaps your own earlier one\)/);
  assert.equal(gets().at(-1), `${BASE}/${VAR_ID}`);
});

// ---------------------------------------------------------------------------
// Refusals and a lost answer
// ---------------------------------------------------------------------------
async function openCreateFilled() {
  respond = listing([]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  type("label", "Total distance");
  type("unit", "m");
  choose("dailyAggregationMethod", "sum");
}

test("each refusal reads as a sentence at its field or the form, and the form stays as typed", async () => {
  const cases = [
    ["invalid_unit", 400, "unit", /The unit must be 1-30 characters/],
    ["invalid_condition", 400, "conditionKind", /The condition is not complete/],
    ["key_taken", 409, "key", /Another variable here already uses this key/],
    ["key_required", 400, "key", /No key can be made from this name/],
  ];
  for (const [code, status, field, sentence] of cases) {
    resetVariables();
    calls.length = 0;
    await openCreateFilled();
    respond = (call) => (call.method === "POST" ? { status, body: { error: code } } : listing([])(call));
    await submit();
    assert.match(variablesState().form.errors[field], sentence, code);
    assert.equal($(`[data-mv-field="${field}"]`).getAttribute("aria-invalid"), "true", code);
    assert.equal($('[data-mv-field="label"]').value, "Total distance");
    if (field === "key") assert.equal($(".metric-variables-form details").open, true, `${code} opens Technical details`);
  }
  for (const [code, status, sentence] of [
    ["try_again", 409, /The server was busy\. Nothing was saved\./],
    ["internal_error", 500, /could not save it\. Nothing was saved\./],
    ["version_unchanged", 409, /Nothing changed/],
    ["variable_pinned", 409, /An active mapping uses the current version/],
    ["invalid_body", 400, /Not saved: the server refused a value\. Check the fields and save again\./],
  ]) {
    resetVariables();
    await openCreateFilled();
    respond = (call) => (call.method === "POST" ? { status, body: { error: code, message: code === "invalid_body" ? "label is one line of 1-80 visible characters." : undefined } } : listing([])(call));
    await submit();
    assert.match($(".metric-variables-form .error").textContent, sentence, code);
    assert.equal(variablesState().form.unconfirmed, false, `${code} is a stated outcome`);
  }
});

test("a reused request key takes a new key for the next save", async () => {
  await openCreateFilled();
  respond = (call) => (call.method === "POST" ? { status: 409, body: { error: "request_key_reused" } } : listing([])(call));
  await submit();
  respond = (call) => (call.method === "POST" ? { status: 201, body: { variable: variable() } } : { status: 200, body: detail() });
  await submit();
  assert.equal(posts().length, 2);
  assert.notEqual(posts()[0].body.requestKey, posts()[1].body.requestKey);
});

for (const [name, answer] of [
  ["no answer", { throwNetworkError: true }],
  ["503 outcome_unknown", { status: 503, body: { error: "outcome_unknown" } }],
  ["an uncoded 502", { status: 502, text: "Bad gateway", body: null }],
]) {
  test(`${name}: Result not confirmed; the form is locked; Check result sends the very same request; the replay is shown as saved`, async () => {
    await openCreateFilled();
    respond = (call) => (call.method === "POST" ? answer : listing([])(call));
    await submit();
    assert.equal(variablesState().form.unconfirmed, true);
    assert.match(text(), /Result not confirmed\./);
    assert.ok(!$('button[type="submit"]'), "no second save while not confirmed");
    assert.ok($('[data-mv-field="label"]').disabled);
    type("label", "Changed");
    assert.equal(variablesState().form.draft.label, "Total distance", "a locked form keeps what was sent");
    await submitVariablesForm($("[data-metric-variables-form]"), { render });
    assert.equal(posts().length, 1, "a submit while not confirmed sends nothing");
    respond = (call) => (call.method === "POST" ? { status: 200, body: { variable: variable(), replayed: true } } : { status: 200, body: detail() });
    await click('[data-action="metric-variables-check-result"]');
    assert.equal(posts().length, 2);
    assert.deepEqual(posts()[1].body, posts()[0].body, "the same key and body");
    assert.equal(variablesState().form, null);
    assert.match(text(), /The variable Total distance was created\./);
  });
}

test("Close without checking asks first and keeps the result marker when the coach stays", async () => {
  await openCreateFilled();
  respond = (call) => (call.method === "POST" ? { throwNetworkError: true } : listing([])(call));
  await submit();
  confirmAnswer = false;
  await click('[data-action="metric-variables-cancel"]');
  assert.match(confirmQuestions.at(-1), /The last save is not confirmed/);
  assert.equal(variablesState().form.unconfirmed, true);
  confirmAnswer = true;
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
});

test("one save at a time: a second submit while the first is in flight sends nothing", async () => {
  await openCreateFilled();
  let release;
  respond = (call) => (call.method === "POST" ? new Promise((resolve) => { release = () => resolve({ status: 201, body: { variable: variable() } }); }) : { status: 200, body: detail() });
  const first = submit();
  await settle();
  assert.match(text(), /Saving\.\.\./);
  await submit();
  assert.equal(posts().length, 1);
  release();
  await first;
  assert.equal(posts().length, 1);
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
test("leaving with an unsaved form asks; staying keeps it, leaving drops it", async () => {
  await openCreateFilled();
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmLeaveTrainingLoad("athletes"), false);
  assert.match(confirmQuestions.at(-1), /Discard the variable you have not saved\?/);
  // A switch to another Training Load section is asked about too.
  const renders = [];
  await handleTrainingLoadAction({ dataset: { action: "training-load-section", section: "schedule" } }, { renderTrainingLoad: () => renders.push(1), openWeeklyPlanForAthleteOnDate: () => {} });
  assert.equal(state.trainingLoad.section, "variables");
  assert.ok(variablesState().form, "the form stays");
  const unload = { preventDefault() { this.prevented = true; } };
  assert.equal(handleTrainingLoadBeforeUnload(unload), true);
  assert.equal(unload.prevented, true);
  confirmAnswer = true;
  assert.equal(confirmLeaveTrainingLoad("athletes"), true);
  assert.equal(variablesState().form, null, "a form left is not shown again");
  assert.equal(handleTrainingLoadBeforeUnload({ preventDefault() {} }), false);
});

test("a clean form is left without a question", async () => {
  respond = listing([]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  assert.equal(variablesMayBeLeft(), true);
  assert.equal(confirmQuestions.length, 0);
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
});

test("a workspace switch drops the old workspace's variables and leaves the screen; an answer still in flight is dropped", async () => {
  await openCreateFilled();
  let release;
  respond = (call) => (call.method === "POST" ? new Promise((resolve) => { release = () => resolve({ status: 201, body: { variable: variable() } }); }) : { status: 200, body: detail() });
  const pending = submit();
  await settle();
  state.trainingLoad.lastDataAnalysisSection = "imports";
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.section, "imports");
  assert.equal(variablesState().form, null);
  assert.deepEqual(variablesState().list.items, []);
  release();
  await pending;
  assert.equal(variablesState().form, null);
  assert.equal(variablesState().notice, "", "the old answer shows nothing in the new workspace");
  assert.equal(gets().filter((url) => url.startsWith(`${BASE}/`)).length, 0, "nothing is read for it");
});

// ---------------------------------------------------------------------------
// Review round 1 (code, UX, mobile)
// ---------------------------------------------------------------------------
test("Check result answered before the server read its request record keeps Result not confirmed; only an answer that settles it unlocks the form", async () => {
  await openCreateFilled();
  respond = (call) => (call.method === "POST" ? { throwNetworkError: true } : listing([])(call));
  await submit();
  assert.equal(variablesState().form.unconfirmed, true);
  for (const [status, code, note] of [
    [409, "try_again", /the server was busy\. The result is still not confirmed/],
    [500, "internal_error", /The check could not be done\. The result is still not confirmed/],
    [404, "notFound", /no access to variables now\. The result is still not confirmed/],
    [401, "Authentication required", /you are signed out\. Sign in again in a new tab, then Check result here\./],
    [409, "request_key_reused", /already stored with other values\. Close without checking and look for it in the list\./],
    [502, null, /No answer again/],
  ]) {
    respond = (call) => (call.method === "POST" ? { status, body: code ? { error: code } : null, text: code ? undefined : "Bad gateway" } : listing([])(call));
    await click('[data-action="metric-variables-check-result"]');
    const form = variablesState().form;
    assert.equal(form.unconfirmed, true, `${status} ${code} keeps the outcome open`);
    assert.doesNotMatch(text(), /Nothing was saved/, `${code} never says nothing was saved`);
    assert.match(text(), note, `${code}: the reason the check did not settle it`);
    if (code === "request_key_reused") assert.doesNotMatch(text(), /Check result again/, "a check that cannot settle is not offered again as the way out");
    assert.deepEqual(posts().at(-1).body, posts()[0].body, "the same key and body every time");
    assert.ok($('[data-mv-field="label"]').disabled, "the form stays locked");
    assert.ok($('[data-action="metric-variables-check-result"]'));
  }
  // An answer given after the record showed no saved write settles it.
  respond = (call) => (call.method === "POST" ? { status: 409, body: { error: "key_taken" } } : listing([])(call));
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, false);
  assert.match(variablesState().form.errors.key, /Another variable here already uses this key/);
  assert.equal($('[data-mv-field="label"]').disabled, false);
  assert.equal(variablesState().form.checkNote, "");
});

test("a first save refused as busy says nothing was saved and unlocks the form (it is not a check)", async () => {
  await openCreateFilled();
  respond = (call) => (call.method === "POST" ? { status: 409, body: { error: "try_again" } } : listing([])(call));
  await submit();
  assert.equal(variablesState().form.unconfirmed, false);
  assert.match(text(), /The server was busy\. Nothing was saved\. Try again\./);
});

test("a save whose answer never comes becomes Result not confirmed at the client bound", async () => {
  await openCreateFilled();
  const originalTimeout = AbortSignal.timeout;
  const mockFetch = globalThis.fetch;
  let bound = null;
  const controller = new AbortController();
  AbortSignal.timeout = (ms) => { bound = ms; return controller.signal; };
  // The POST never answers; only the signal fetch itself received can end it.
  globalThis.fetch = (url, options = {}) => {
    if ((options.method || "GET") !== "POST") return mockFetch(url, options);
    return new Promise((resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError"))));
  };
  try {
    void submit();
    await settle();
    assert.equal(variablesState().form.busy, true);
    assert.equal(bound, WRITE_BOUND_MS);
    assert.ok(WRITE_BOUND_MS >= 60_000, "above the server's own worst case");
    controller.abort();
    await settle();
    await settle();
  } finally {
    AbortSignal.timeout = originalTimeout;
    globalThis.fetch = mockFetch;
  }
  assert.equal(variablesState().form.busy, false, "the bound ended the wait");
  assert.equal(variablesState().form.unconfirmed, true);
  assert.ok($('[data-action="metric-variables-check-result"]'));
});

test("zone levels and allowed values are compared exactly, beyond what a float holds", () => {
  const form = openForm("create");
  Object.assign(form.draft, { label: "Zone", unit: "m", dailyAggregationMethod: "sum", conditionKind: "zone_between", conditionUnit: "km/h",
    conditionLower: "123456789012.000000001", conditionUpper: "123456789012.000000002" });
  assert.equal(buildRequest(form).errors.conditionUpper, undefined, "a valid 21-digit zone is accepted");
  Object.assign(form.draft, { conditionLower: "123456789012.000000002", conditionUpper: "123456789012.000000001" });
  assert.ok(buildRequest(form).errors.conditionUpper);
  Object.assign(form.draft, { conditionKind: "none", minValue: "-0.5", maxValue: "-0.49" });
  assert.deepEqual(buildRequest(form).errors, {}, "negatives in order");
  Object.assign(form.draft, { minValue: "100000000000.000000002", maxValue: "100000000000.000000001" });
  assert.equal(buildRequest(form).errors.maxValue, "Not below the minimum.");
});

test("Close without checking reads the list again and says where a saved variable would be", async () => {
  await openCreateFilled();
  respond = (call) => (call.method === "POST" ? { throwNetworkError: true } : listing([variable({ label: "Total distance" })])(call));
  await submit();
  const before = gets().length;
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
  assert.equal(gets().length, before + 1);
  assert.equal(gets().at(-1), `${BASE}?scope=own&state=active`);
  assert.match(text(), /The result was not checked\. If the variable was saved, it is in the list below\./);
  assert.ok($(".metric-variables-item"));
});

test("phones: units and the key are never capitalised or corrected; only the seconds get the decimal pad (no minus sign there)", async () => {
  respond = listing([]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  choose("conditionKind", "event_threshold");
  for (const field of ["unit", "conditionUnit", "key"]) {
    const input = $(`[data-mv-field="${field}"]`);
    assert.equal(input.getAttribute("autocapitalize"), "none", field);
    assert.equal(input.getAttribute("autocorrect"), "off", field);
    assert.equal(input.getAttribute("spellcheck"), "false", field);
  }
  for (const field of ["minValue", "maxValue", "conditionValue"]) assert.equal($(`[data-mv-field="${field}"]`).hasAttribute("inputmode"), false, `${field} may be negative`);
  assert.equal($('[data-mv-field="conditionDuration"]').getAttribute("inputmode"), "decimal");
});

test("the create form names what can never change; a version form says the name stays, and its leave question names the version", async () => {
  respond = listing([]);
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
  await click('[data-action="metric-variables-create-open"]');
  assert.match(text(), /After you create it, the name, short name, description, key and Recorded for cannot be changed, and the variable cannot be deleted\./);
  await click('[data-action="metric-variables-cancel"]');
  await openDetailWith();
  await click('[data-action="metric-variables-version-open"]');
  assert.match(text(), /The name and Recorded for stay as they are\./);
  type("unit", "km");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "Discard the new version you have not saved?");
});
