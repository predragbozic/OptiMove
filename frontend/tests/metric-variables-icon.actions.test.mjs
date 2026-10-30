// Training Load -> Data configuration -> Variables, I1 (PR-1b, J3b.11):
// changing the icon of an existing variable. Driven through the real handlers
// and markup in a DOM with a fake fetch: the button follows the server's
// `actions`, Change icon opens the shared picker at once, the exact body
// (the icon the coach saw and the new one, or null for none), every refusal, a
// lost answer checked by the very same request, and the guards on leaving.
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

const { handleVariablesAction, resetVariables, submitVariablesForm, variablesMayBeLeft } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { state } = await import("../state.js");
const resetToList = () => { resetVariables(); variablesState().view = "variables"; };

const BASE = "/api/training-load/sources/metrics/variables";
const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "22222222-0000-4000-8000-000000000001";
const VAR_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const reduced = (over = {}) => ({
  id: VAR_ID, key: "total_distance", label: "Total distance", shortLabel: null, description: null, icon: null,
  ownerScope: "club", state: "active", editable: true, actions: ["rename", "archive", "icon"], labelsToken: "c".repeat(64), truncated: false, ...over,
});

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const gets = () => calls.filter((call) => call.method === "GET" && !call.url.includes("/metrics/classification")).map((call) => call.url);
const buttons = () => [...content.querySelectorAll(".metric-variables-actions button")].map((b) => b.textContent.trim());

async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });
const choose = async (key) => {
  await click(`[data-action="icon-picker-choose"][data-icon-key="${key}"]`);
  await click('[data-action="icon-picker-use"]');
};

let current = reduced();
function serve(answer = () => ({ status: 404, body: { error: "notFound" } })) {
  respond = (call) => {
    if (call.method === "GET" && call.url.startsWith(`${BASE}?`)) return { status: 200, body: { variables: [current], nextCursor: null } };
    if (call.method === "GET" && call.url.startsWith(`${BASE}/${VAR_ID}`)) return { status: 200, body: { variable: current, nextCursor: null } };
    return answer(call);
  };
}
async function openVariable() {
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
}

beforeEach(() => {
  resetToList();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  current = reduced();
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" } };
  content.innerHTML = "";
});

test("Change icon follows the server's actions only: offered with icon, never without; a pinned variable's coach sees it as the only action", async () => {
  await openVariable();
  assert.deepEqual(buttons(), ["Rename", "Change icon", "Archive"]);
  resetToList();
  current = reduced({ actions: ["rename", "archive"] });
  await openVariable();
  assert.ok(!buttons().includes("Change icon"));
  resetToList();
  current = reduced({ actions: ["icon"] });
  await openVariable();
  assert.deepEqual(buttons(), ["Change icon"]);
  assert.ok($('[data-action="metric-variables-icon-change-open"]').classList.contains("data-sources-primary"));
  // A button the server did not offer opens nothing.
  resetToList();
  current = reduced({ actions: [] });
  await openVariable();
  content.insertAdjacentHTML("beforeend", '<button data-action="metric-variables-icon-change-open"></button>');
  await click('[data-action="metric-variables-icon-change-open"]');
  assert.equal(variablesState().form, null);
});

test("Change icon opens the shared picker at once over an inert form; Use icon puts the choice in the form; Save icon sends the icon seen and the new one, then reads the variable again", async () => {
  serve((call) => (call.method === "POST" ? { status: 200, body: { variable: { ...current, icon: "run" }, replayed: false } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  assert.ok($("[data-icon-picker] [role=dialog]"), "the picker is open");
  assert.match($("#icon-picker-title").textContent, /^Choose an icon for Total distance$/);
  assert.ok($("[data-metric-variables-form]").hasAttribute("inert"), "the form is inert behind the picker");
  await choose("run");
  assert.ok(!$("[data-icon-picker]"), "the picker closed");
  assert.ok(!$("[data-metric-variables-form]").hasAttribute("inert"));
  assert.match(text(), /Change the icon of Total distance/);
  assert.match(text(), /Chosen: run Saved now: no icon\./);
  assert.match(text(), /Only the icon changes, for every team of the club\./);
  assert.ok(!/Do not enter athlete names/.test(text()), "an icon form has no text to warn about");
  const before = gets().length;
  await submit();
  const [sent] = posts();
  assert.equal(sent.url, `${BASE}/${VAR_ID}/icon`);
  const body = JSON.parse(sent.rawBody);
  assert.deepEqual(Object.keys(body).sort(), ["expectedIconKey", "iconKey", "requestKey"]);
  assert.match(body.requestKey, UUID);
  assert.deepEqual([body.expectedIconKey, body.iconKey], [null, "run"]);
  assert.equal(variablesState().form, null);
  assert.match(text(), /The icon was changed\./);
  assert.equal(gets().length, before + 1, "the variable is read again");
  assert.equal(variablesState().list.loaded, false, "the list is read again when it is shown");
});

test("Remove icon (and the picker's Use no icon) sends null with the icon seen; nothing changed is said before sending", async () => {
  current = reduced({ icon: "run" });
  serve((call) => (call.method === "POST" ? { status: 200, body: { variable: { ...current, icon: null }, replayed: false } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await click('[data-action="icon-picker-cancel"]');
  assert.match(text(), /Chosen: run/);
  assert.ok(!/Saved now/.test(text()), "the choice is the saved icon");
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Nothing changed: this is the icon already saved\. Choose another one, or Cancel\./);
  await click('[data-action="metric-variables-icon-clear"]');
  assert.match(text(), /No icon Saved now: run\./);
  await submit();
  assert.deepEqual(JSON.parse(posts()[0].rawBody).iconKey, null);
  assert.deepEqual(JSON.parse(posts()[0].rawBody).expectedIconKey, "run");
  assert.match(text(), /The icon was removed\./);
  // The picker's Use no icon.
  resetToList();
  calls.length = 0;
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await click('[data-action="icon-picker-none"]');
  await submit();
  assert.deepEqual(JSON.parse(posts()[0].rawBody), { ...JSON.parse(posts()[0].rawBody), expectedIconKey: "run", iconKey: null });
});

test("refusals: variable_changed and variable_not_active close the form and read the variable again with the icon's own sentence; icon_unchanged and a refused body keep it open", async () => {
  let answer;
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  for (const [code, sentence] of [
    ["variable_changed", /Someone changed this variable's icon in the meantime, so your choice was not saved\./],
    ["variable_not_active", /This variable is archived now, so its icon cannot be changed\. Nothing was saved\./],
  ]) {
    resetToList();
    answer = { status: 409, body: { error: code, ...(code === "variable_changed" ? { current: reduced({ icon: "walk" }) } : {}) } };
    await openVariable();
    await click('[data-action="metric-variables-icon-change-open"]');
    await choose("run");
    const before = gets().length;
    await submit();
    assert.equal(variablesState().form, null, code);
    assert.match(text(), sentence);
    assert.equal(gets().length, before + 1, `${code}: the variable is read again`);
  }
  for (const [code, sentence] of [["icon_unchanged", /Nothing changed: this icon is the one already saved\./], ["invalid_body", /Not saved: the server refused a value\./]]) {
    resetToList();
    answer = { status: code === "invalid_body" ? 400 : 409, body: { error: code } };
    await openVariable();
    await click('[data-action="metric-variables-icon-change-open"]');
    await choose("run");
    await submit();
    assert.ok(variablesState().form, `${code} keeps the form`);
    assert.match(text(), sentence);
  }
});

test("a lost answer is Result not confirmed and the choice is locked; Check result sends the very same request; a saved replay answers it as changed, icon_unchanged settles it as not saved; Close without checking reads the variable again", async () => {
  let answer = { throwNetworkError: true };
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await choose("run");
  await submit();
  assert.match(text(), /Result not confirmed\./);
  assert.ok($('[data-action="metric-variables-icon-open"]').disabled, "the choice is locked");
  await click('[data-action="metric-variables-icon-open"]');
  assert.ok(!$("[data-icon-picker]"), "no picker on a sent form");
  answer = { status: 409, body: { error: "try_again" } };
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, true, "busy settles nothing");
  answer = { status: 200, body: { variable: { ...current, icon: "run" }, replayed: true } };
  await click('[data-action="metric-variables-check-result"]');
  const sent = posts().map((p) => p.rawBody);
  assert.deepEqual([sent.length, new Set(sent).size], [3, 1], "every check is the very same request");
  assert.match(text(), /The icon was changed\./);

  // icon_unchanged on a check comes after the server read its request record:
  // nothing was saved under the key, so it settles the outcome.
  resetToList();
  calls.length = 0;
  answer = { throwNetworkError: true };
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await choose("swim");
  await submit();
  answer = { status: 409, body: { error: "icon_unchanged" } };
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, false, "icon_unchanged settles it");
  assert.match(text(), /Nothing changed: this icon is the one already saved\./);
  assert.ok(!$('[data-action="metric-variables-icon-open"]').disabled, "the form is unlocked again");

  resetToList();
  answer = { throwNetworkError: true };
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await choose("walk");
  await submit();
  const before = gets().length;
  await click('[data-action="metric-variables-cancel"]');
  assert.match(text(), /The result was not checked\. The variable below is as it is saved now\./);
  assert.equal(gets().length, before + 1);
});

test("leaving: an icon chosen and not saved is asked about; an untouched form (the picker cancelled) leaves freely and the picker goes with it", async () => {
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  await click('[data-action="icon-picker-cancel"]');
  assert.equal(variablesMayBeLeft(), true);
  await click('[data-action="metric-variables-icon-open"]');
  await choose("bike");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "Discard the icon you have not saved?");
  confirmAnswer = true;
  await click('[data-action="metric-variables-icon-open"]');
  assert.ok($("[data-icon-picker]"));
  // Cancel with the picker open (the form behind it is inert to a pointer, not to a script).
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(confirmQuestions.at(-1), "Discard the icon you have not saved?");
  assert.equal(variablesState().form, null);
  assert.ok(!state.iconPicker, "the picker went with the form");
});

test("the variable's name is escaped in the form's title and the picker's", async () => {
  current = reduced({ label: "<img src=x onerror=alert(1)>" });
  await openVariable();
  await click('[data-action="metric-variables-icon-change-open"]');
  assert.ok(!content.querySelector("img"), "nothing is parsed as markup");
  assert.equal($("#icon-picker-title").textContent, "Choose an icon for <img src=x onerror=alert(1)>");
  await click('[data-action="icon-picker-cancel"]');
  assert.ok(!content.querySelector("img"));
  assert.match($("#metric-variables-title").textContent, /Change the icon of <img src=x onerror=alert\(1\)>/);
});
