// Training Load -> Data configuration -> Variables, phase 2c (R2): renaming,
// archiving and restoring a canonical variable, and a team coach's reduced view
// (C99, J3b; the API is PR #227). Driven through the real handlers and markup in
// a DOM with a fake fetch: who is offered the screen, the buttons the server's
// `actions` name, the exact rename / archive / restore bodies (a rename sends
// only what changed, with the token it read), every R2 refusal, a lost answer
// checked by the very same request, and the guards on leaving.
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

const { handleVariablesAction, handleVariablesInput, loadVariablesSection, resetVariables, submitVariablesForm, variablesMayBeLeft } = await import("../metric-variables-actions.js");
const { variablesContext, variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { state } = await import("../state.js");
// These tests work on the variables list, as opened from the Data
// configuration start screen (layout C); the start screen itself is proved in
// data-config-home.actions.test.mjs.
const resetToList = () => { resetVariables(); variablesState().view = "variables"; };

const BASE = "/api/training-load/sources/metrics/variables";
const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "22222222-0000-4000-8000-000000000001";
const VAR_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const TOKEN = "c".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ch = (cp) => String.fromCodePoint(cp);

// The reduced view a team workspace reads (Q7): never versions, levels or
// mapping readiness.
const reduced = (over = {}) => ({
  id: VAR_ID, key: "total_distance", label: "Total distance", shortLabel: "TotDist", description: "Whole session",
  ownerScope: "club", state: "active", editable: true, actions: ["rename", "archive"], labelsToken: TOKEN, truncated: false, ...over,
});
// An admin's full view of a club variable.
const full = (over = {}) => ({
  ...reduced(over.reducedOver || {}),
  actions: ["rename", "archive", "newVersion"], levels: ["session"], mappingTarget: { ready: true, notReadyCode: null },
  currentVersion: { id: "bbbbbbbb-1111-4000-8000-000000000001", versionNumber: 1, unit: "m", dailyAggregationMethod: "sum", minValue: null, maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z" },
  createdAt: "2026-10-20T08:00:00.000Z", versions: [], ...over,
});

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => handleVariablesInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
// The variables' own reads; the screen's read of the domains and categories
// (phase 12c) is proved in metric-classification.actions.test.mjs.
const gets = () => calls.filter((call) => call.method === "GET" && !call.url.includes("/metrics/classification")).map((call) => call.url);
const buttons = () => [...content.querySelectorAll(".metric-variables-actions button")].map((b) => b.textContent.trim());

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
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });

function asCoach() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" } };
}
function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}

// One variable on the detail route, `answer(call)` for the writes.
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
  asCoach();
  content.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Who is offered the screen, and what a team workspace reads
// ---------------------------------------------------------------------------
test("a team workspace of a club is offered the screen in the coach's view; a team without a club is not", () => {
  assert.ok(renderTrainingLoadCoachHtml().includes('data-section="variables"'));
  assert.deepEqual(variablesContext(), { owner: "club", clubId: CLUB, clubName: "", view: "coach", teamName: "First team", basis: null });
  // C99: a team workspace is offered the Variables view only, never Source
  // fields or Mappings.
  const space = renderTrainingLoadCoachHtml();
  assert.ok(!/Source fields|>\s*Mappings\s*</.test(space), "no Source fields or Mappings view in a team workspace");
  assert.deepEqual([...space.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]).filter((section) => !["schedule", "today", "variables"].includes(section)), [], "Data configuration holds only the Variables section");
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: null, label: "Loose team" } };
  assert.equal(variablesContext(), null);
  assert.ok(!renderTrainingLoadCoachHtml().includes('data-section="variables"'));
  asClub();
  assert.equal(variablesContext().view, "admin");
});

test("coach: the list says what a coach may do, offers This club and System (reference), and no New variable", async () => {
  await loadVariablesSection(render);
  assert.deepEqual(gets(), [`${BASE}?scope=own&state=active`]);
  assert.match(text(), /Variables of this team's club, shared by all its teams\. As a coach of the team you can rename, archive and restore them/);
  assert.ok(!$('[data-action="metric-variables-create-open"]'), "a coach never creates");
  assert.equal(content.querySelectorAll('[data-action="metric-variables-scope"]').length, 2);
  assert.match(text(), /Total distance \(TotDist\)/);
  assert.match(text(), /shared by all its teams\. As a coach of the team you can rename, archive and restore them; each change applies to every team of the club\./);
  await click('[data-action="metric-variables-scope"][data-scope="system"]');
  assert.match(text(), /System variables, for reference: shared by all clubs and changed only by a platform administrator\./);
  current = reduced();
  respond = (call) => (call.url.startsWith(`${BASE}?`) ? { status: 200, body: { variables: [], nextCursor: null } } : { status: 404, body: { error: "notFound" } });
  resetToList();
  await loadVariablesSection(render);
  assert.match(text(), /This club has no variables of its own yet\. An administrator of the club creates them\./);
});

test("coach: a variable reads in the reduced view - names and description, the actions the server names, no facts or versions", async () => {
  await openVariable();
  assert.deepEqual(gets(), [`${BASE}/${VAR_ID}`]);
  assert.match(text(), /Total distance/);
  assert.match(text(), /Whole session/);
  assert.deepEqual(buttons(), ["Rename", "Archive"]);
  assert.ok(!$(".metric-variables-facts"), "no facts: the server sends none");
  assert.ok(!$(".metric-variables-versions"), "no versions");
  assert.ok(!$('[data-action="metric-variables-version-open"]'));
  assert.ok($(".data-sources-tech").textContent.includes(VAR_ID), "the id only under Technical details");
  assert.ok(!$(".metric-variables-head").textContent.includes(VAR_ID));
});

test("the buttons and their notes follow the server's actions only", async () => {
  const cases = [
    [{ actions: [] }, [], /A data source is mapped to this variable \(an active mapping\), so it cannot be archived now, and only an administrator of the club can rename it\./],
    // A club admin working in a team workspace (basis club_admin) keeps Rename on a pinned variable.
    [{ actions: ["rename"] }, ["Rename"], /A data source is mapped to this variable \(an active mapping\), so it cannot be archived now\.(?! and)/],
    [{ state: "archived", actions: ["restore"] }, ["Restore"], /Archived: kept with its recorded values and its history; no new values can be entered for it until it is restored\./],
    [{ state: "archived", actions: [] }, [], /An administrator archived this variable, so only an administrator can restore it\./],
    [{ ownerScope: "system", editable: false, actions: [] }, [], /Read only: system variables are shared by all clubs and changed only by a platform administrator\./],
  ];
  for (const [over, expected, note] of cases) {
    resetToList();
    current = reduced(over);
    await openVariable();
    assert.deepEqual(buttons(), expected, JSON.stringify(over));
    assert.match(text(), note, JSON.stringify(over));
  }
  // An admin on a pinned variable: Rename stays, Archive does not.
  asClub();
  resetToList();
  current = full({ actions: ["rename"] });
  await openVariable();
  assert.deepEqual(buttons(), ["Rename"]);
  assert.match(text(), /An active mapping uses this variable, so it cannot get a new version or be archived now\./);
  resetToList();
  current = full();
  await openVariable();
  assert.deepEqual(buttons(), ["Rename", "New version", "Archive"], "an admin's full set, Archive last");
  assert.ok($('[data-action="metric-variables-rename-open"]').classList.contains("data-sources-primary"));
  assert.ok($('[data-action="metric-variables-archive-open"]').classList.contains("ghost"), "Archive is never the primary button");
  // A form the server does not offer never opens.
  resetToList();
  current = reduced({ actions: [] });
  await openVariable();
  content.insertAdjacentHTML("beforeend", `<button data-action="metric-variables-rename-open" id="forged"></button>`);
  await handleVariablesAction($("#forged"), { render });
  assert.equal(variablesState().form, null);
});

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------
test("rename: the form starts from the names read; only a changed name is sent, with the token; an emptied short name or description is null", async () => {
  serve((call) => (call.url.endsWith("/rename") ? { status: 200, body: { variable: { ...current, label: call.body.label ?? current.label } } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.equal($('[data-mv-field="label"]').value, "Total distance");
  assert.equal($('[data-mv-field="shortLabel"]').value, "TotDist");
  assert.equal($('[data-mv-field="description"]').value, "Whole session");
  assert.match(text(), /Only the names change, for every team of the club\. The key, how the variable is measured and every recorded value stay as they are\./);
  type("label", "  Total   running distance ");
  type("shortLabel", "");
  await submit();
  assert.equal(posts().length, 1);
  const [post] = posts();
  assert.equal(post.url, `${BASE}/${VAR_ID}/rename`);
  assert.deepEqual(Object.keys(post.body).sort(), ["label", "labelsToken", "requestKey", "shortLabel"]);
  assert.deepEqual([post.body.label, post.body.shortLabel, post.body.labelsToken], ["Total running distance", null, TOKEN]);
  assert.match(post.body.requestKey, UUID);
  for (const forbidden of ["owner", "ownerScope", "actor", "basis", "userId", "description", "key", "state"]) assert.ok(!(forbidden in post.body), forbidden);
  assert.equal(variablesState().form, null);
  assert.match(text(), /The variable was renamed\./);
  assert.equal(gets().at(-1), `${BASE}/${VAR_ID}`, "the variable is read again");
});

test("rename: nothing changed is said before sending; a changed name is checked, an unchanged stored one is not (Q10)", async () => {
  // A stored label with a character the server now refuses, written before Q10.
  current = reduced({ label: `Legacy${ch(0x3164)}name` });
  serve((call) => (call.url.endsWith("/rename") ? { status: 200, body: { variable: current } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Nothing changed: change a name, or Cancel\./);
  type("label", `Other${ch(0x3164)}name`);
  await submit();
  assert.equal(posts().length, 0, "a changed name with a hidden character is refused before sending");
  assert.equal($('[data-mv-field="label"]').getAttribute("aria-invalid"), "true");
  type("label", "");
  await submit();
  assert.equal(posts().length, 0, "the name is required");
  type("label", `Legacy${ch(0x3164)}name`);
  type("description", "Only the description");
  await submit();
  assert.equal(posts().length, 1);
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["description", "labelsToken", "requestKey"], "the unchanged stored name is not sent");
});

test("rename: a name cut at its limit is read only and never sent until the coach replaces it", async () => {
  const longDescription = "d".repeat(500);
  current = reduced({ truncated: true, description: longDescription });
  serve((call) => (call.url.endsWith("/rename") ? { status: 200, body: { variable: current } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.ok(!$('[data-mv-field="description"]'), "no field for the cut description");
  assert.equal($("#mv-locked-description").textContent, `${longDescription}…`);
  assert.match(text(), /The saved description may be longer than the 500 characters shown here\. It stays as it is unless you replace it\./);
  assert.equal($('[data-action="metric-variables-name-replace"]').getAttribute("aria-describedby"), "mv-why-description", "Replace is described by why, never by the whole saved text");
  assert.ok($('[data-mv-field="label"]'), "a name below its limit stays editable");
  // An input event for the locked name (no such field is on the screen) changes nothing that is sent.
  const forged = document.createElement("input");
  forged.dataset.mvField = "description";
  $(".metric-variables-form").append(forged);
  forged.value = "Forged";
  forged.dispatchEvent(new window.Event("input", { bubbles: true }));
  type("shortLabel", "TD");
  await submit();
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["labelsToken", "requestKey", "shortLabel"], "the cut description is not sent");

  resetToList();
  calls.length = 0;
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  await click('[data-action="metric-variables-name-replace"][data-mv-name="description"]');
  assert.equal($('[data-mv-field="description"]').value, longDescription, "Replace starts from the text shown");
  assert.match(text(), /This field holds only the first 500 characters; if the saved description is longer, the rest is not in it\. Saving replaces the whole saved description, any hidden part too, with what you type here\./);
  assert.equal(variablesState().form.dirty, false, "choosing Replace alone changes nothing");
  await submit();
  assert.equal(posts().length, 0, "replaced but unchanged is still not sent");
  assert.match(text(), /Nothing changed/);
  type("description", "Whole session, both halves");
  await submit();
  assert.deepEqual([Object.keys(posts()[0].body).sort(), posts()[0].body.description], [["description", "labelsToken", "requestKey"], "Whole session, both halves"]);
});

test("rename: a name or short name exactly at its limit while the read says truncated is locked too; truncated false locks nothing", async () => {
  current = reduced({ truncated: true, label: "L".repeat(80), shortLabel: "S".repeat(20) });
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.deepEqual([!!$('[data-mv-field="label"]'), !!$('[data-mv-field="shortLabel"]'), !!$('[data-mv-field="description"]')], [false, false, true]);
  assert.equal(content.querySelectorAll('[data-action="metric-variables-name-replace"]').length, 2);
  resetToList();
  current = reduced({ truncated: false, label: "L".repeat(80) });
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.equal($('[data-mv-field="label"]').value, "L".repeat(80), "a name at its limit that was not cut is editable");
});

test("rename: a saved name on several lines is shown, read only and never sent until replaced; Replace offers it as one line", async () => {
  current = reduced({ description: "Line one\nLine two" });
  serve((call) => (call.url.endsWith("/rename") ? { status: 200, body: { variable: current } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.ok(!$('[data-mv-field="description"]'));
  assert.equal($("#mv-locked-description").textContent, "Line one\nLine two");
  assert.match(text(), /The saved description is on several lines\. It stays as it is unless you replace it with one line\./);
  type("label", "Total running distance");
  await submit();
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["label", "labelsToken", "requestKey"], "the multi-line description is not sent");

  resetToList();
  calls.length = 0;
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  await click('[data-action="metric-variables-name-replace"][data-mv-name="description"]');
  assert.equal($('[data-mv-field="description"]').value, "Line one Line two");
  assert.match(text(), /The lines are joined into one here\. Saving replaces the whole saved description with what you type here\./);
  assert.equal(content.ownerDocument.activeElement, $('[data-mv-field="description"]'), "the field gets the focus");
  await submit();
  assert.equal(posts().length, 0, "replaced but left as shown is not sent (the saved text stays on its lines)");
  assert.match(text(), /Nothing changed/);
  type("description", "Line one and two");
  await submit();
  assert.equal(posts()[0].body.description, "Line one and two");
});

// ---------------------------------------------------------------------------
// variable_changed: other names saved meanwhile (the form stays open)
// ---------------------------------------------------------------------------
const NEW_TOKEN = "d".repeat(64);
test("variable_changed: the form stays open on the names saved now, keeps the coach's changes, and saves again with the new token and a new key", async () => {
  const saved = reduced({ shortLabel: "TD", description: "Changed by the admin", labelsToken: NEW_TOKEN });
  let answer = { status: 409, body: { error: "variable_changed", message: "x", current: saved } };
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Total running distance");
  await submit();
  const form = variablesState().form;
  assert.ok(form, "the form stays open");
  assert.match(text(), /Someone changed this variable while you were editing, so nothing was saved\. The changes you made are kept; every other name below is the one saved now\. Check them and save again\./);
  assert.equal($('[data-mv-field="label"]').value, "Total running distance", "the coach's change is kept");
  assert.equal($('[data-mv-field="shortLabel"]').value, "TD", "an untouched name shows the saved value");
  assert.equal($('[data-mv-field="description"]').value, "Changed by the admin");
  assert.match(text(), /Changed meanwhile: this is the saved value now\./);
  assert.equal(form.dirty, true);
  const firstKey = posts()[0].body.requestKey;
  answer = { status: 200, body: { variable: { ...saved, label: "Total running distance" } } };
  await submit();
  const second = posts()[1].body;
  assert.deepEqual(Object.keys(second).sort(), ["label", "labelsToken", "requestKey"], "only the coach's change is sent");
  assert.equal(second.labelsToken, NEW_TOKEN);
  assert.notEqual(second.requestKey, firstKey, "a new attempt, a new key");
  assert.match(text(), /The variable was renamed\./);
});

test("variable_changed: a name both changed says what is saved now and that the coach's text replaces it; a change equal to the saved one is not sent again", async () => {
  serve((call) => (call.method === "POST" ? { status: 409, body: { error: "variable_changed", current: reduced({ label: "Admin's <name>", labelsToken: NEW_TOKEN }) } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Coach's name");
  type("shortLabel", "TD");
  await submit();
  assert.match(text(), /Saved now: "Admin's <name>"\. Your text replaces it when you save\./);
  assert.ok(!content.querySelector("name"), "the saved name is escaped");
  assert.equal($('[data-mv-field="label"]').value, "Coach's name");
  type("label", "Admin's <name>");
  await submit();
  assert.deepEqual(Object.keys(posts()[1].body).sort(), ["labelsToken", "requestKey", "shortLabel"], "the name now equal to the saved one is not sent");
});

test("variable_changed: a name now saved cut or on several lines is locked again unless the coach changed it", async () => {
  serve((call) => (call.method === "POST" ? { status: 409, body: { error: "variable_changed", current: reduced({ description: "Two\nlines", labelsToken: NEW_TOKEN }) } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Total running distance");
  await submit();
  assert.ok(!$('[data-mv-field="description"]'), "the untouched description is locked");
  assert.match(text(), /The saved description is on several lines\./);
  resetToList();
  calls.length = 0;
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("description", "Mine");
  await submit();
  assert.equal($('[data-mv-field="description"]').value, "Mine", "the coach's change stays editable");
  assert.match(text(), /Saved now: "Two lines"\. Your text replaces it when you save\. The lines are joined into one here\. Saving replaces the whole saved description with what you type here\./);
});

test("variable_changed: a name someone saved exactly as the coach typed says so; the explanation gets the focus", async () => {
  serve((call) => (call.method === "POST" ? { status: 409, body: { error: "variable_changed", current: reduced({ label: "Total running distance", labelsToken: NEW_TOKEN }) } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Total running  distance");
  await submit();
  assert.match(text(), /Saved now: the same as your text\./);
  assert.doesNotMatch(text(), /Your text replaces it/);
  assert.equal(content.ownerDocument.activeElement, $(".metric-variables-conflict"));
  assert.equal($(".metric-variables-conflict").getAttribute("tabindex"), "-1");
});

test("variable_changed: when the user may no longer rename (no rename in `actions`) or the answer has no `current`, the form closes and the variable is read again", async () => {
  for (const body of [{ error: "variable_changed", current: reduced({ labelsToken: NEW_TOKEN, actions: [] }) }, { error: "variable_changed" }]) {
    resetToList();
    calls.length = 0;
    serve((call) => (call.method === "POST" ? { status: 409, body } : { status: 404, body: { error: "notFound" } }));
    await openVariable();
    await click('[data-action="metric-variables-rename-open"]');
    type("label", "Another");
    await submit();
    assert.equal(variablesState().form, null);
    assert.match(text(), /Someone changed this variable in the meantime, so your change was not saved\./);
    assert.equal(gets().length, 2, "the variable is read again");
  }
});

test("variable_changed, then a lost answer: Close without checking still says the result was not checked", async () => {
  let answer = { status: 409, body: { error: "variable_changed", current: reduced({ labelsToken: NEW_TOKEN }) } };
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Another");
  await submit();
  answer = { throwNetworkError: true };
  await submit();
  assert.equal(variablesState().form.unconfirmed, true);
  const before = gets().length;
  await click('[data-action="metric-variables-cancel"]');
  assert.match(text(), /The result was not checked\. The variable below is as it is saved now\./);
  assert.equal(gets().length, before + 1);
});

test("variable_changed: Cancel after the conflict reads the variable again", async () => {
  serve((call) => (call.method === "POST" ? { status: 409, body: { error: "variable_changed", current: reduced({ shortLabel: "TD", labelsToken: NEW_TOKEN }) } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Another");
  await submit();
  current = reduced({ shortLabel: "TD", labelsToken: NEW_TOKEN });
  const before = gets().length;
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(confirmQuestions.at(-1), "Discard the new names you have not saved?");
  assert.equal(variablesState().form, null);
  assert.equal(gets().length, before + 1);
  assert.match(text(), /TD/);
});

test("rename: spacing a field would tidy locks a name with its own reason; a cut name on several lines keeps the ellipsis and the cut reason", async () => {
  current = reduced({ description: "Two  spaces" });
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.doesNotMatch(text(), /on several lines/);
  assert.match(text(), /The saved description has spacing the form cannot keep \(such as two spaces in a row\)\. It stays as it is unless you replace it\./);
  assert.equal($("#mv-locked-description").textContent, "Two  spaces", "shown with its spacing");
  await click('[data-action="metric-variables-name-replace"][data-mv-name="description"]');
  assert.match(text(), /The spacing is tidied here\./);
  resetToList();
  const cutLines = `${"x".repeat(250)}\n${"y".repeat(249)}`;
  current = reduced({ truncated: true, description: cutLines });
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.ok($("#mv-locked-description").textContent.endsWith("…"), "a cut text says so even with a line break");
  assert.match(text(), /may be longer than the 500 characters shown here/);
  await click('[data-action="metric-variables-name-replace"][data-mv-name="description"]');
  assert.match(text(), /if the saved description is longer, the rest is not in it, and its lines are joined into one here\./, "Replace says the lines are joined too");
});

// ---------------------------------------------------------------------------
// Archive and restore
// ---------------------------------------------------------------------------
test("archive: a reason is required; the form says what stays and who can restore it (coach and admin); the body is the key and the reason", async () => {
  serve((call) => (call.url.endsWith("/archive") ? { status: 200, body: { variable: { ...current, state: "archived", actions: ["restore"] } } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-archive-open"]');
  assert.match(text(), /Archiving affects every team of the club: until it is restored, no new values can be entered for it and it cannot be added to a dashboard\. Values already recorded, its history and the dashboards that already show it stay as they are\./);
  assert.doesNotMatch(text(), /It also gets no new version/, "the coach is not told about versions and mappings");
  assert.match(text(), /Archived by a coach, it can be restored by a coach of this club's teams or an administrator; archived by an administrator of the club, only by an administrator\./, "roles unknown: both cases");
  await submit();
  assert.equal(posts().length, 0);
  assert.equal($('[data-mv-field="reason"]').getAttribute("aria-invalid"), "true");
  type("reason", "Replaced by the drill variable");
  await submit();
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["reason", "requestKey"]);
  assert.equal(posts()[0].url, `${BASE}/${VAR_ID}/archive`);
  assert.equal(posts()[0].body.reason, "Replaced by the drill variable");
  assert.match(text(), /The variable was archived\./);

  asClub();
  resetToList();
  current = full();
  await openVariable();
  await click('[data-action="metric-variables-archive-open"]');
  assert.match(text(), /Only an administrator can restore it later; a coach cannot\./);
  assert.match(text(), /It also gets no new version, and no new mapping can use it\./);
});

test("archive: the restore promise follows the basis the server will write (Q8): a coach alone, the club's admin or a platform admin in a team workspace", async () => {
  const promise = async (availableWorkspaces) => {
    asCoach();
    state.currentUser.availableWorkspaces = availableWorkspaces;
    resetToList();
    await openVariable();
    await click('[data-action="metric-variables-archive-open"]');
    return text();
  };
  const team = { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" };
  assert.match(await promise([team]), /A coach of this club's teams or an administrator can restore it later\./);
  assert.match(await promise([team, { type: "club", scopeId: "33333333-0000-4000-8000-000000000001", label: "Other club", role: "club_admin" }]), /A coach of this club's teams or an administrator can restore it later\./, "another club's admin is a coach here");
  for (const extra of [{ type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" }, { type: "platform", scopeId: null, label: "Platform administration", role: "platform_admin" }]) {
    const said = await promise([team, extra]);
    assert.match(said, /Only an administrator can restore it later; a coach cannot\./, extra.type);
    assert.doesNotMatch(said, /A coach of this club's teams or an administrator can restore it later/, extra.type);
  }
});

test("restore: the reason is optional and left out when empty", async () => {
  current = reduced({ state: "archived", actions: ["restore"] });
  serve((call) => (call.url.endsWith("/restore") ? { status: 200, body: { variable: { ...current, state: "active" } } } : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-restore-open"]');
  await submit();
  assert.equal(posts()[0].url, `${BASE}/${VAR_ID}/restore`);
  assert.deepEqual(Object.keys(posts()[0].body), ["requestKey"]);
  assert.match(text(), /The variable was restored\./);
  resetToList();
  calls.length = 0;
  await openVariable();
  await click('[data-action="metric-variables-restore-open"]');
  assert.match(text(), /The variable becomes active again for every team of the club: new values can be entered for it and it can be added to dashboards\./);
  type("reason", "Needed again");
  await submit();
  assert.equal(posts()[0].body.reason, "Needed again");
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------
const REFUSALS = [
  // Without `current` (the server always sends it; the client does not rely on it).
  ["rename", { error: "variable_changed" }, "close", /Someone changed this variable in the meantime, so your change was not saved\./],
  ["rename", { error: "rename_unchanged" }, "stay", /Nothing changed: these names are the ones already saved\./],
  ["rename", { error: "variable_pinned" }, "close", /A data source is now mapped to this variable \(an active mapping\), so only an administrator of the club can rename it\. Nothing was saved\./],
  ["rename", { error: "variable_not_active" }, "close", /This variable is archived now, so it cannot be renamed\./],
  ["archive", { error: "variable_pinned" }, "close", /A data source is now mapped to this variable \(an active mapping\), so it cannot be archived now\. Nothing was saved\./],
  ["archive", { error: "variable_not_active" }, "close", /This variable is already archived\./],
  ["restore", { error: "variable_active" }, "close", /This variable is active \(perhaps restored in the meantime\), so there is nothing to restore\./],
  ["restore", { error: "restore_by_admin" }, "close", /An administrator archived this variable, so only an administrator can restore it\./],
  ["restore", { error: "variable_pinned" }, "close", /A data source is now mapped to this variable \(an active mapping\), so it cannot be restored now\. Nothing was saved\./],
  ["rename", { error: "invalid_body" }, "stay", /Not saved: the server refused a value\./],
  ["archive", { error: "try_again" }, "stay", /The server was busy\. Nothing was saved\. Try again\./],
];
for (const [mode, answer, outcome, message] of REFUSALS) {
  test(`${mode}: ${answer.error} ${outcome === "close" ? "closes the form and reads the variable again" : "keeps the form"}`, async () => {
    current = mode === "restore" ? reduced({ state: "archived", actions: ["restore"] }) : reduced();
    serve((call) => (call.method === "POST" ? { status: answer.error === "invalid_body" ? 400 : 409, body: answer } : { status: 404, body: { error: "notFound" } }));
    await openVariable();
    await click(`[data-action="metric-variables-${mode}-open"]`);
    if (mode === "rename") type("label", "Another name");
    if (mode === "archive") type("reason", "Old");
    const before = gets().length;
    await submit();
    assert.match(text(), message);
    if (outcome === "close") {
      assert.equal(variablesState().form, null);
      assert.equal(gets().length, before + 1, "the variable is read again");
    } else {
      assert.ok(variablesState().form, "the form stays");
      assert.equal(variablesState().form.unconfirmed, false);
    }
  });
}

// ---------------------------------------------------------------------------
// A lost answer, Check result and leaving
// ---------------------------------------------------------------------------
test("a lost answer is Result not confirmed; Check result sends the very same request; an R2 refusal on the check settles it", async () => {
  let answer = { throwNetworkError: true };
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  type("label", "Total running distance");
  await submit();
  assert.match(text(), /Result not confirmed\./);
  assert.ok($('[data-mv-field="label"]').disabled, "the form is locked");
  answer = { status: 409, body: { error: "try_again" } };
  await click('[data-action="metric-variables-check-result"]');
  assert.match(text(), /The check could not be done: the server was busy\./);
  assert.equal(variablesState().form.unconfirmed, true, "busy settles nothing");
  answer = { status: 409, body: { error: "variable_changed", current: reduced({ labelsToken: NEW_TOKEN }) } };
  await click('[data-action="metric-variables-check-result"]');
  const sent = posts().map((p) => p.rawBody);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 1, "every check is the very same request");
  const form = variablesState().form;
  assert.equal(form.unconfirmed, false, "variable_changed settles it: nothing was saved under the key");
  assert.equal(form.labelsToken, NEW_TOKEN);
  assert.notEqual(form.requestKey, JSON.parse(sent[0]).requestKey, "the next save is a new attempt");
  assert.equal($('[data-mv-field="label"]').value, "Total running distance");
  assert.ok(!$('[data-mv-field="label"]').disabled, "the form is unlocked again");
  assert.match(text(), /Someone changed this variable while you were editing/);
});

test("a check that finds the saved write answers it as saved; Close without checking reads the variable again", async () => {
  let answer = { throwNetworkError: true };
  serve((call) => (call.method === "POST" ? answer : { status: 404, body: { error: "notFound" } }));
  await openVariable();
  await click('[data-action="metric-variables-archive-open"]');
  type("reason", "Old");
  await submit();
  answer = { status: 200, body: { variable: { ...current, state: "archived" }, replayed: true } };
  await click('[data-action="metric-variables-check-result"]');
  assert.match(text(), /The variable was archived\./);

  resetToList();
  answer = { throwNetworkError: true };
  await openVariable();
  await click('[data-action="metric-variables-archive-open"]');
  type("reason", "Old");
  await submit();
  const before = gets().length;
  await click('[data-action="metric-variables-cancel"]');
  assert.match(text(), /The result was not checked\. The variable below is as it is saved now\./);
  assert.equal(gets().length, before + 1);
});

test("leaving: unsaved names, an archive in progress or an unconfirmed result are asked about", async () => {
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.equal(variablesMayBeLeft(), true, "an untouched form leaves freely");
  type("label", "Changed");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "Discard the new names you have not saved?");
  confirmAnswer = true;
  await click('[data-action="metric-variables-cancel"]');
  await click('[data-action="metric-variables-archive-open"]');
  type("reason", "x");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "Discard the archive you have not confirmed?");
});

test("every text from the server is escaped in the coach's view and the forms", async () => {
  current = reduced({ label: "<img src=x onerror=alert(1)>", shortLabel: "<b>", description: "<script>x</script>", key: "<k>" });
  await openVariable();
  assert.ok(!content.querySelector("img, b, script"), "nothing is parsed as markup");
  await click('[data-action="metric-variables-rename-open"]');
  assert.ok(!content.querySelector("img, b, script"));
  assert.equal($('[data-mv-field="label"]').value, "<img src=x onerror=alert(1)>");
  resetToList();
  current = reduced({ description: "<img src=x onerror=alert(1)>\n<b>two</b>" });
  await openVariable();
  await click('[data-action="metric-variables-rename-open"]');
  assert.ok(!content.querySelector("img, b, script"), "a locked name is escaped");
  assert.equal($("#mv-locked-description").textContent, "<img src=x onerror=alert(1)>\n<b>two</b>");
});
