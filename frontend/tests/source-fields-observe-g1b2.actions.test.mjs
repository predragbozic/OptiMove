// G1b-2 (docs/ai/gpexe-field-inventory-plan.md, sections 8.2 and 8.10): "Compare with GPEXE" on a created field's detail,
// over routes 8 (the comparison), O (the tick) and 10 (the stored comparisons). Driven through the real handlers and
// markup in a DOM with a fake fetch: offered only on the active, unproven revision of a whole-session or drill field in
// the platform workspace (never a per-athlete field, a proven one, or a club); the team, then the server's comparison of
// two named athletes with the number GPEXE should show by the word's rule (as_sent, duration, speed); no tick without
// both numbers or when the server says the unit cannot be confirmed; the body exactly; the three outcomes - saved, a coded
// refusal (the comparison read again), a lost answer (Check result sends the same request); and the stored list.
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

const { handleSourceFieldsAction, handleSourceFieldsInput, loadSourceField, resetSourceFields, sourceFieldsMayBeLeft, submitSourceFieldsForm } = await import("../source-fields-actions.js");
const { sourceFieldsState } = await import("../source-fields-data.js");
const { renderSourceFieldsHtml } = await import("../source-fields-view.js");
const { state } = await import("../state.js");

const FB = "/api/training-load/sources/metrics/fields";
const TEAMS = "/api/training-load/sources/metrics/board/teams";
const CLUB = "11111111-0000-4000-8000-000000000001";
const F = "f1f1f1f1-0000-4000-8000-0000000000aa";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const T1 = "7e7e7e7e-0000-4000-8000-000000000001";
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderSourceFieldsHtml(); };
content.addEventListener("input", (event) => handleSourceFieldsInput(event.target));
content.addEventListener("change", (event) => handleSourceFieldsInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const gets = () => calls.filter((call) => call.method === "GET").map((c) => c.url);
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleSourceFieldsAction(element, { render });
}
function choose(name, value) {
  const element = $(`[data-sf-field="${name}"]`);
  assert.ok(element, `the ${name} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function tick(name, checked) {
  const element = $(`[data-sf-field="${name}"]`);
  assert.ok(element, `the ${name} box is on the screen`);
  element.checked = checked;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const submit = () => submitSourceFieldsForm({ render });

const asPlatform = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } }; };
const asClub = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } }; };

const revision = (over = {}) => ({
  id: R1, revisionNumber: 1, state: "active", valueShape: "unit_value_object", parameterKind: "none", supportsSession: true, supportsDrill: false,
  expectedSourceUnit: "J/kg", sourceUnit: null, expectedSourceBoundUnit: null, sourceBoundUnit: null, boundOperator: null,
  evidenceStatus: "unproven", evidenceRef: null, unitEvidenceRef: null, meaningEvidenceRef: null, unitVerifiedAt: null, meaningVerifiedAt: null, ...over,
});
const field = (over = {}) => ({ id: F, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "details.players.metabolic_energy", label: "Metabolic energy", state: "active", revisions: [revision()], ...over });
const observation = (over = {}) => ({
  fieldId: F, revisionId: R1, key: "details.players.metabolic_energy", label: "Metabolic energy", expectedUnit: "J/kg",
  team: { id: T1, name: "First team", clubId: CLUB, clubName: "FK Borac" },
  session: { candidateId: C1, label: "Training", startedAt: "2026-11-10T17:00:00Z" },
  pair: { index: 0, count: 3, positions: [0, 2], labels: ["Ana Petrovic", "Marko Ilic"] },
  confirmable: true, reason: null, word: "energy", unit: "J/kg", displayRule: "as_sent", displayUnit: "J/kg",
  values: { a: { raw: "412.5", shown: "412.5" }, b: { raw: "455.25", shown: "455.25" } },
  placementHash: HASH, ...over,
});

let theField = field();
let observations = [];
let read = () => ({ status: 200, body: { observation: observation() } });
let post = () => ({ status: 404, body: { error: "notFound" } });
function serve() {
  respond = (call) => {
    if (call.method === "POST") return post(call);
    if (call.url === TEAMS) return { status: 200, body: { teams: [{ clubId: CLUB, clubName: "FK Borac", teamId: T1, teamName: "First team" }], truncated: false } };
    if (call.url === `${FB}/${F}`) return { status: 200, body: { field: theField, verifications: [] } };
    if (call.url === `${FB}/${F}/observations`) return { status: 200, body: { observations } };
    if (call.url.startsWith(`${FB}/${F}/observation?`)) return read(call);
    return { status: 404, body: { error: "notFound" } };
  };
}

beforeEach(() => {
  resetSourceFields();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  theField = field();
  observations = [];
  read = () => ({ status: 200, body: { observation: observation() } });
  post = () => ({ status: 404, body: { error: "notFound" } });
  state.trainingLoad.section = "source-fields";
  asPlatform();
  serve();
});

async function openField() {
  await loadSourceField(F, render);
  assert.equal($("#source-fields-title").textContent, "Metabolic energy");
}
async function openComparison() {
  await openField();
  await click('[data-action="source-fields-observe-open"]');
  assert.ok($('[data-source-fields-form="observe"]'), "the comparison form is open");
  choose("teamId", T1);
  await click('[data-action="source-fields-observe-load"]');
}

test("1. Compare with GPEXE is offered only on the active, unproven revision of a whole-session or drill field in the platform workspace - never a per-athlete field, a proven or retired revision, one with parameters, or a club; a forged click opens nothing", async () => {
  await openField();
  assert.equal(content.querySelectorAll('[data-action="source-fields-observe-open"]').length, 1);
  assert.match(text(), /GPEXE sends this value with its unit\. Compare two athletes with the GPEXE screen to confirm the unit and the meaning together\./);
  for (const [label, over] of [
    ["a per-athlete field", { key: "athlete_session.hsr_distance" }],
    ["a proven revision", { revisions: [revision({ evidenceStatus: "source_stated", sourceUnit: "J/kg", unitVerifiedAt: "2026-11-10T00:00:00Z", meaningVerifiedAt: "2026-11-10T00:00:00Z" })] }],
    ["a retired revision", { revisions: [revision({ state: "retired" })] }],
    ["a revision with parameters", { revisions: [revision({ parameterKind: "zone_bounds" })] }],
  ]) {
    resetSourceFields();
    theField = field(over);
    await loadSourceField(F, render);
    assert.equal(content.querySelectorAll('[data-action="source-fields-observe-open"]').length, 0, label);
    content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="source-fields-observe-open" data-revision-id="${R1}"></button>`);
    await handleSourceFieldsAction($("#forged"), { render });
    assert.equal(sourceFieldsState().form, null, label);
  }
  resetSourceFields();
  theField = field();
  asClub();
  const readsBefore = gets().filter((u) => u.endsWith("/observations")).length;
  await loadSourceField(F, render);
  assert.equal(content.querySelectorAll('[data-action="source-fields-observe-open"]').length, 0, "a club");
  assert.equal(gets().filter((u) => u.endsWith("/observations")).length, readsBefore, "a club never reads the comparisons");
});

test("2. the comparison: the team, then two named athletes and the number to compare by the word's rule; as_sent says the plain sentence; no athlete id; Other athletes reads the next pair of the same session", async () => {
  await openComparison();
  assert.ok(gets().includes(TEAMS));
  assert.ok(gets().includes(`${FB}/${F}/observation?teamId=${T1}&pair=0`), JSON.stringify(gets()));
  assert.match(text(), /GPEXE sends the unit word "energy" with this value; OptiMove reads it as J\/kg\./);
  const lines = [...content.querySelectorAll(".source-fields-observe-athletes li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(lines, [
    "Ana Petrovic: GPEXE may show this rounded or in another unit. Compare the number: 412.5 J/kg.",
    "Marko Ilic: GPEXE may show this rounded or in another unit. Compare the number: 455.25 J/kg.",
  ]);
  assert.ok($('[data-sf-field="attested"]'), "the tick is offered with both numbers");
  assert.ok(!content.innerHTML.includes(C1) || $(".data-sources-tech"), "no candidate id outside Technical details");
  read = (call) => ({ status: 200, body: { observation: observation({ pair: { index: 1, count: 3, positions: [1, 2], labels: ["Ivo Ivic", "Marko Ilic"] } }) } });
  await click('[data-action="source-fields-observe-other"]');
  assert.ok(gets().includes(`${FB}/${F}/observation?candidateId=${C1}&pair=1`), JSON.stringify(gets()));
  assert.match(text(), /Ivo Ivic: /);
  assert.match(text(), /Other athletes \(2 of 3\)/);
});

test("3. the word's own rule: a duration shows minutes:seconds and the hours note; a speed shows km/h", async () => {
  read = () => ({ status: 200, body: { observation: observation({ word: "time", unit: "s", displayRule: "duration_mmss", displayUnit: "mm:ss", values: { a: { raw: "5790", shown: "96:30" }, b: { raw: "1200", shown: "20:00" } } }) } });
  await openComparison();
  assert.match(text(), /Ana Petrovic: GPEXE should show 96:30 \(minutes:seconds\)\./);
  assert.match(text(), /For a long value GPEXE may show hours as well: 1:36:30 is 96:30\./);
  resetSourceFields();
  read = () => ({ status: 200, body: { observation: observation({ word: "speed", unit: "m/s", displayRule: "speed_kmh", displayUnit: "km/h", values: { a: { raw: "6.2", shown: "22.3" }, b: { raw: "8.1", shown: "29.2" } } }) } });
  await openComparison();
  assert.match(text(), /Ana Petrovic: GPEXE should show 22\.3 km\/h\./);
});

test("4. no tick when the server says the unit cannot be confirmed (the words disagree, an unknown word, another unit than expected): the reason in plain words, no box, no save button", async () => {
  for (const [reason, words, pattern] of [
    ["words_disagree", ["energy", "power"], /different unit words \("energy" and "power"\)/],
    ["word_unknown", ["furlongs", "furlongs"], /a unit word OptiMove does not know \("furlongs"\)/],
    ["expected_unit_differs", ["power", "power"], /not the unit the field was created with \(J\/kg\)/],
  ]) {
    resetSourceFields();
    read = () => ({ status: 200, body: { observation: observation({ confirmable: false, reason, words, word: null, unit: null, displayRule: null, displayUnit: null, values: { a: { raw: "412.5", shown: null }, b: { raw: "455.25", shown: null } } }) } });
    await openComparison();
    assert.match(text(), pattern, reason);
    assert.equal($('[data-sf-field="attested"]'), null, reason);
    assert.equal($('.source-fields-form button[type="submit"]'), null, reason);
  }
  // A comparison the server cannot read says why.
  resetSourceFields();
  read = () => ({ status: 409, body: { error: "no_comparable_session" } });
  await openComparison();
  assert.match(text(), /None of this team's latest saved sessions has two named athletes/);
});

test("5. the tick: refused until the box is ticked; the last question names the unit and the word; the body is exactly the session, the two positions and the hash, attested; saved, the field is read again with its comparisons", async () => {
  await openComparison();
  await submit();
  assert.equal(posts().length, 0);
  assert.match($("#sf-err-attested").textContent, /only after comparing both athletes/);
  tick("attested", true);
  confirmAnswer = false;
  await submit();
  assert.equal(posts().length, 0, "the last question was declined");
  assert.match(confirmQuestions.at(-1), /Save the unit of Metabolic energy as J\/kg \(GPEXE's word "energy"\) and its meaning as GPEXE's own label/);
  confirmAnswer = true;
  post = () => {
    theField = field({ revisions: [revision({ evidenceStatus: "source_stated", sourceUnit: "J/kg", unitVerifiedAt: "2026-11-17T00:00:00Z", meaningVerifiedAt: "2026-11-17T00:00:00Z" })] });
    observations = [{ id: "o1", revisionId: R1, revisionNumber: 1, confirmedAt: "2026-11-17T00:00:00Z", confirmedBy: "Admin", team: { id: T1, name: "First team", clubName: "FK Borac" }, word: "energy", unit: "J/kg", displayRule: "as_sent", displayUnit: "J/kg", valuesExpireAt: "2027-02-15T00:00:00Z", values: { a: "412.5", b: "455.25" } }];
    return { status: 201, body: { revision: { id: R1 }, confirmationId: "o1" } };
  };
  await submit();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, `${FB}/${F}/revisions/${R1}/observed-confirmation`);
  const body = posts()[0].body;
  assert.match(body.requestKey, UUID);
  assert.deepEqual({ ...body, requestKey: "k" }, { requestKey: "k", session: { candidateId: C1, pairs: [0, 2], placementHash: HASH }, attested: true });
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /The unit \(J\/kg, stated by GPEXE\) and the meaning \(GPEXE's own label\) were saved from the comparison\./);
  assert.match(text(), /J\/kg Unit stated by GPEXE, checked on the board/);
  assert.match(text(), /Compared on the board .*First team \(FK Borac\) · GPEXE's word energy read as J\/kg/);
  assert.match(text(), /Numbers compared: 412\.5 and 455\.25 J\/kg/);
});

test("6. a coded refusal: board_changed reads the comparison again and the tick starts over with a new key; unit_already_verified closes the form and reads the field again", async () => {
  await openComparison();
  tick("attested", true);
  post = () => ({ status: 409, body: { error: "board_changed" } });
  await submit();
  const firstKey = posts()[0].body.requestKey;
  assert.match(text(), /the session or the field changed since you compared/);
  assert.equal($('[data-sf-field="attested"]').checked, false, "the tick starts over");
  assert.equal(gets().filter((u) => u.includes("/observation?")).length, 2, "the comparison was read again");
  tick("attested", true);
  post = () => ({ status: 409, body: { error: "unit_already_verified" } });
  await submit();
  assert.notEqual(posts()[1].body.requestKey, firstKey, "a new key after a refusal that changed the comparison");
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /this field's unit is already confirmed/);
});

test("7. a lost answer: Result not confirmed; Check result sends the very same request; leaving asks first", async () => {
  await openComparison();
  tick("attested", true);
  post = () => { throw new TypeError("network down"); };
  await submit();
  assert.match(text(), /Result not confirmed\. No answer arrived, so it is not known whether the comparison was saved\./);
  confirmAnswer = false;
  assert.equal(sourceFieldsMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /It is not known whether the comparison was saved/);
  confirmAnswer = true;
  post = () => ({ status: 200, body: { revision: { id: R1 }, confirmationId: "o1", replayed: true } });
  await click('[data-action="source-fields-check-result"]');
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].rawBody, posts()[0].rawBody, "the same request, the same key");
  assert.equal(sourceFieldsState().form, null);
});

test("8. another team drops the comparison on the screen (and its tick) until it is read for that team", async () => {
  await openComparison();
  tick("attested", true);
  const select = $('[data-sf-field="teamId"]');
  select.insertAdjacentHTML("beforeend", `<option value="7e7e7e7e-0000-4000-8000-000000000002">Other</option>`);
  choose("teamId", "7e7e7e7e-0000-4000-8000-000000000002");
  assert.equal($(".source-fields-observe"), null, "no comparison of the other team on the screen");
  assert.equal($('[data-sf-field="attested"]'), null);
});
