// v80 step C (docs/ai/v80-condition-match-plan.md, section 10): the screen of the condition match, through the real
// handlers and markup in a DOM with a fake fetch.
// C1 - Source fields: GPEXE's events setting of an events column. The block says each state in plain words (the gate
//      stays closed until the comparison and the confirmation exist); only a platform administrator gets the form; the
//      form shows no value of its own (the owner types what GPEXE shows); a comma is read as the decimal point; the body
//      exactly; setting_differs keeps the typed numbers and shows the server's sentence; a lost answer is Result not
//      confirmed and Check result sends the very same request; a club admin reads the block without a form.
// C2 - the board: a variable whose column waits for the confirmation says so; a variable with a condition takes a drop
//      only from the columns the server listed as matching; a refused placement shows the server's sentence.
// C3 - Imports: a session blocked by team_setting_changed shows the server's sentence naming both settings to an
//      administrator; a coach reads the one coach sentence.
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

const { handleSourceFieldsAction, handleSourceFieldsInput, loadSourceField, resetSourceFields, submitSourceFieldsForm } = await import("../source-fields-actions.js");
const { renderSourceFieldsHtml } = await import("../source-fields-view.js");
const { typedDecimal } = await import("../source-fields-data.js");
const { placementRefusal } = await import("../metric-board-data.js");
const { overSourceFieldDrag, dropSourceFieldDrag } = await import("../metric-board-drag.js");
const { blockedCoachText } = await import("../gpexe-import-view.js");
const { TEAM_CODES, TEAM_CODE_TEXT } = await import("../metric-mappings-data.js");
const { state } = await import("../state.js");

const FB = "/api/training-load/sources/metrics/fields";
const CLUB = "11111111-0000-4000-8000-000000000001";
const F = "f1f1f1f1-0000-4000-8000-0000000000ac";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderSourceFieldsHtml(); };
content.addEventListener("input", (event) => handleSourceFieldsInput(event.target));
content.addEventListener("change", (event) => handleSourceFieldsInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleSourceFieldsAction(element, { render });
}
function type(name, value) {
  const element = $(`[data-sf-field="${name}"]`);
  assert.ok(element, `the ${name} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const submit = () => submitSourceFieldsForm({ render });
const asPlatform = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } }; };
const asClub = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } }; };

const revision = { id: R1, revisionNumber: 1, state: "active", valueShape: "number", parameterKind: "none", supportsSession: true, supportsDrill: true,
  expectedSourceUnit: "count", sourceUnit: "count", evidenceStatus: "source_stated", unitVerifiedAt: "2026-11-17T10:00:00Z", meaningVerifiedAt: "2026-11-17T10:00:00Z" };
const theField = { id: F, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "details.players.acceleration_events", label: "Acceleration events", state: "active", revisions: [revision] };
let eventSetting = null;
let post = () => ({ status: 404, body: { error: "notFound" } });
function serve() {
  respond = (call) => {
    if (call.method === "POST") return post(call);
    if (call.url === `${FB}/${F}`) return { status: 200, body: { field: theField, verifications: [], ...(eventSetting ? { eventSetting } : {}) } };
    if (call.url === `${FB}/${F}/observations`) return { status: 200, body: { observations: [] } };
    return { status: 404, body: { error: "notFound" } };
  };
}
const waiting = (over = {}) => ({ event: "acceleration", revisionId: R1, compared: true, sessionKept: true, confirmation: null, ...over });

beforeEach(() => {
  resetSourceFields();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  eventSetting = waiting();
  post = () => ({ status: 404, body: { error: "notFound" } });
  state.trainingLoad.section = "source-fields";
  asPlatform();
  serve();
});

test("C1-1. the block says every state in plain words and keeps the gate closed; only the 'form' state of a platform administrator offers Confirm", async () => {
  const cases = [
    [waiting({ compared: false, sessionKept: false, revisionId: R1 }), /Compare this value with GPEXE first .* Until then this column fills no variable with a condition\./, false],
    [waiting({ sessionKept: false }), /The session you compared is no longer kept\. Compare this value with GPEXE again first\./, false],
    [waiting(), /In GPEXE, open the team's settings and enter the acceleration events threshold and duration it shows\. Until then/, true],
    [waiting({ confirmation: { thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: "2026-11-19T08:00:00Z" } }), /Confirmed: acceleration events at or above 2\.5 m\/s² lasting 0\.3 s\./, false],
  ];
  for (const [es, words, offered] of cases) {
    resetSourceFields();
    eventSetting = es;
    await loadSourceField(F, render);
    assert.match(text(), words);
    assert.equal(Boolean($('[data-action="source-fields-event-open"]')), offered, JSON.stringify(es));
  }
  // A field without the block (not an events column): nothing of it.
  resetSourceFields();
  eventSetting = null;
  await loadSourceField(F, render);
  assert.equal($(".source-fields-event-setting"), null);
});

test("C1-2. a club admin reads the block without the form; a forged click opens nothing", async () => {
  asClub();
  eventSetting = waiting({ sessionKept: null });
  await loadSourceField(F, render);
  assert.match(text(), /Compared with GPEXE\. A platform administrator still confirms GPEXE's acceleration events setting\./);
  assert.equal($('[data-action="source-fields-event-open"]'), null);
  const forged = document.createElement("button");
  forged.dataset.action = "source-fields-event-open";
  await handleSourceFieldsAction(forged, { render });
  assert.equal($('[data-source-fields-form="event"]'), null);
  // Even an answer that says the session is kept opens no form for a club admin (the screen's own guard).
  resetSourceFields();
  eventSetting = waiting({ sessionKept: true });
  await loadSourceField(F, render);
  assert.equal($('[data-action="source-fields-event-open"]'), null);
  await handleSourceFieldsAction(forged, { render });
  assert.equal($('[data-source-fields-form="event"]'), null);
});

test("C1-3. the form shows no value of its own, reads a comma as the decimal point, and sends the body exactly; saved, the field is read again", async () => {
  await loadSourceField(F, render);
  await click('[data-action="source-fields-event-open"]');
  assert.ok($('[data-source-fields-form="event"]'));
  assert.equal($('[data-sf-field="thresholdValue"]').value, "");
  assert.equal($('[data-sf-field="durationSeconds"]').value, "");
  assert.equal($('[data-sf-field="thresholdValue"]').getAttribute("inputmode"), "decimal");
  assert.equal(/2\.5|0\.3/.test(text().replace(/for example 2\.5|for example 0\.3/g, "")), false, "no value of OptiMove's own before Confirm");
  // Required, then not a number.
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Required\./);
  type("thresholdValue", "abc");
  type("durationSeconds", "-1");
  await submit();
  assert.equal(posts().length, 0);
  type("thresholdValue", "2,5");
  type("durationSeconds", " 0,3 ");
  post = (call) => ({ status: 201, body: { confirmation: { id: "x", event: "acceleration", thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: "2026-11-20T09:00:00Z" } } });
  eventSetting = waiting();
  const sent = submit();
  eventSetting = waiting({ confirmation: { thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: "2026-11-20T09:00:00Z" } });
  await sent;
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, `${FB}/${F}/revisions/${R1}/event-setting-confirmation`);
  const body = posts()[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["durationSeconds", "requestKey", "thresholdValue"]);
  assert.deepEqual([body.thresholdValue, body.durationSeconds], ["2.5", "0.3"]);
  assert.match(body.requestKey, UUID);
  assert.match(confirmQuestions.at(-1), /Confirm that GPEXE shows acceleration events at or above 2\.5 m\/s² lasting 0\.3 s/);
  assert.equal($('[data-source-fields-form="event"]'), null, "the form closes");
  assert.match(text(), /Confirmed: acceleration events at or above 2\.5 m\/s² lasting 0\.3 s\. The column can now fill a variable with this setting\./);
});

test("C1-4. setting_differs keeps the typed numbers and shows the server's sentence (the one place GPEXE's value is shown); request_key_reused takes a new key", async () => {
  await loadSourceField(F, render);
  await click('[data-action="source-fields-event-open"]');
  type("thresholdValue", "2.5");
  type("durationSeconds", "0.5");
  const message = "GPEXE's setting for the session you compared is at or above 2.5 m/s² lasting 0.3 s. Check the team's settings in GPEXE and enter what it shows.";
  post = () => ({ status: 409, body: { error: "setting_differs", message } });
  await submit();
  assert.ok($('[data-source-fields-form="event"]'), "the form stays");
  assert.equal($('[data-sf-field="durationSeconds"]').value, "0.5");
  assert.match(text(), new RegExp(`Not saved\\. ${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const firstKey = posts()[0].body.requestKey;
  post = () => ({ status: 409, body: { error: "request_key_reused" } });
  type("durationSeconds", "0.3");
  await submit();
  post = () => ({ status: 409, body: { error: "try_again" } });
  await submit();
  assert.notEqual(posts()[2].body.requestKey, firstKey);
});

test("C1-5. a lost answer is Result not confirmed; Check result sends the very same request, and a replay settles it", async () => {
  await loadSourceField(F, render);
  await click('[data-action="source-fields-event-open"]');
  type("thresholdValue", "2.5");
  type("durationSeconds", "0.3");
  post = () => { throw new TypeError("network down"); };
  await submit();
  assert.match(text(), /Result not confirmed\./);
  assert.equal($('[data-sf-field="thresholdValue"]').disabled, true, "the numbers are locked while the result is not known");
  post = () => ({ status: 200, body: { confirmation: { id: "x", event: "acceleration", thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: "2026-11-20T09:00:00Z" } } });
  eventSetting = waiting({ confirmation: { thresholdValue: "2.5", durationSeconds: "0.3", confirmedAt: "2026-11-20T09:00:00Z" } });
  await click('[data-action="source-fields-check-result"]');
  assert.equal(posts().length, 2);
  assert.deepEqual(posts()[1].body, posts()[0].body, "the same key and body");
  assert.match(text(), /Confirmed: acceleration events/);
});

test("C1-6. typedDecimal: the server's number rule; a comma is a decimal point; anything else is refused before sending", () => {
  assert.equal(typedDecimal("2,5"), "2.5");
  assert.equal(typedDecimal(" -2.5 "), "-2.5");
  assert.equal(typedDecimal("0.3"), "0.3");
  for (const bad of ["", "2.", ".5", "1e3", "2.5.1", "1234567", "0.1234567", "abc"]) assert.equal(typedDecimal(bad), null, bad);
});

test("C2-1. a refused placement shows the server's sentence naming both settings; the other match refusals have their own sentence", () => {
  const message = "This column counts events at or above 2.5 m/s² lasting 0.3 s (First team's setting in GPEXE); Long accelerations counts events at or above 2.5 m/s² lasting 0.5 s. Choose a variable with the same setting, or change the team's setting in GPEXE.";
  assert.equal(placementRefusal({ code: "team_setting_mismatch", message }), message);
  assert.match(placementRefusal({ code: "event_setting_not_confirmed" }), /waits for GPEXE's events setting to be confirmed in Source fields/);
  assert.match(placementRefusal({ code: "team_setting_missing" }), /Find new sessions first/);
  assert.equal(placementRefusal({ code: "conversion_unavailable" }), "OptiMove cannot compare this column's unit with the variable's.");
  // The Mappings screen names the team for S1 / A1's per-team refusals.
  for (const code of ["team_setting_mismatch", "team_setting_missing", "event_setting_not_confirmed"]) {
    assert.ok(TEAM_CODES.has(code), code);
    assert.ok(TEAM_CODE_TEXT[code], code);
  }
});

test("C2-2. the drop filter: a variable with a condition takes a drop only from a column the server listed as matching; any other variable takes every column (help only - the server judges again)", async () => {
  const { startSourceFieldDrag, SOURCE_FIELD_DRAG_TYPE } = await import("../metric-board-drag.js");
  const media = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const board = document.createElement("div");
    board.setAttribute("data-mb-board", "");
    board.innerHTML = `
      <span data-mb-drag-field data-field-id="ok">ok</span><span data-mb-drag-field data-field-id="other">other</span>
      <ul><li data-mb-drop-variable data-variable-id="cond" data-mb-only-fields="ok,ok2"><button>c</button></li>
          <li data-mb-drop-variable data-variable-id="free"><button>f</button></li></ul>`;
    document.body.append(board);
    const transfer = () => {
      const data = new Map();
      return { types: [SOURCE_FIELD_DRAG_TYPE], clearData: () => data.clear(), setData: (t, v) => data.set(t, v), getData: (t) => data.get(t) || "", dropEffect: "none", effectAllowed: "" };
    };
    const drops = [];
    for (const [fieldId, variableId, takes] of [["ok", "cond", true], ["other", "cond", false], ["other", "free", true]]) {
      const dataTransfer = transfer();
      startSourceFieldDrag({ target: board.querySelector(`[data-field-id="${fieldId}"]`), dataTransfer, preventDefault() {} });
      const target = board.querySelector(`[data-variable-id="${variableId}"] button`);
      const over = { target, currentTarget: board, dataTransfer, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      overSourceFieldDrag(over);
      assert.equal(over.defaultPrevented, takes, `${fieldId} over ${variableId}`);
      dropSourceFieldDrag({ target, currentTarget: board, dataTransfer, preventDefault() {} }, { onDrop: (f, v) => drops.push(`${f}>${v}`) });
    }
    assert.deepEqual(drops, ["ok>cond", "other>free"]);
    board.remove();
  } finally {
    globalThis.matchMedia = media;
  }
});

test("C3-1. Imports: team_setting_changed shows an administrator the server's sentence naming both settings, with the step; a coach reads the one coach sentence", () => {
  const message = "First team's setting in GPEXE counts the zone 25–65 W/kg for this session; Power zone 3 counts the zone 25–60 W/kg. Nothing of this session is imported. Set it back in GPEXE, or switch Power zone 3 off for First team.";
  const admin = blockedCoachText({ status: "blocked", blockedCode: "team_setting_changed", blockedSourceCode: "team_setting_changed", preview: { blocked: { code: "team_setting_changed", message } } });
  assert.equal(admin.reason, message);
  assert.match(admin.step, /Set the team's setting back in GPEXE and find new sessions again, or switch that variable off for this team/);
  // The list row (no review yet): the fixed sentence.
  const row = blockedCoachText({ status: "blocked", blockedCode: "team_setting_changed", blockedSourceCode: "team_setting_changed" });
  assert.match(row.reason, /The team's setting in GPEXE for this session is not the one a column was matched with/);
  const coach = blockedCoachText({ status: "blocked", blockedCode: "data_setup_incomplete", preview: { blocked: { code: "data_setup_incomplete", message: "This session can't be imported until an administrator finishes its data setup." } } });
  assert.equal(coach.reason, "This session can't be imported until an administrator finishes its data setup.");
});
