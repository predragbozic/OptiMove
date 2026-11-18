// G1b-1 (docs/ai/gpexe-field-inventory-plan.md, section 8.1): "Create field" on Source fields' inventory, over route C
// (POST /fields), and the status words of a source_stated revision (8.4). Driven through the real handlers and markup in
// a DOM with a fake fetch: the button only where the server marked the name creatable, in the platform workspace; the
// form's levels by endpoint; the checks before sending; the body exactly; the three outcomes - created (the new field
// opens), a coded refusal (nothing was created), and a lost answer (Result not confirmed; Check result sends the same
// request); field_exists opening the existing field; and the words a GPEXE-stated revision is shown with.
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

const { handleSourceFieldsAction, handleSourceFieldsInput, loadSourceFieldsSection, resetSourceFields, sourceFieldsMayBeLeft, submitSourceFieldsForm } = await import("../source-fields-actions.js");
const { CREATE_NEXT_STEP, sourceFieldsState } = await import("../source-fields-data.js");
const { renderSourceFieldsHtml } = await import("../source-fields-view.js");
const { state } = await import("../state.js");

const FB = "/api/training-load/sources/metrics/fields";
const INV = "/api/training-load/sources/metrics/field-inventory";
const CLUB = "11111111-0000-4000-8000-000000000001";
const NEW = "f1f1f1f1-0000-4000-8000-0000000000aa";
const OLD = "f1f1f1f1-0000-4000-8000-0000000000bb";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderSourceFieldsHtml(); };
content.addEventListener("input", (event) => handleSourceFieldsInput(event.target));
content.addEventListener("change", (event) => handleSourceFieldsInput(event.target));
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
function tick(name, checked) {
  const element = $(`[data-sf-field="${name}"]`);
  assert.ok(element, `the ${name} box is on the screen`);
  element.checked = checked;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const submit = () => submitSourceFieldsForm({ render });
const createButton = (endpoint, name) => `[data-action="source-fields-create-open"][data-sf-inv-endpoint="${endpoint}"][data-sf-inv-name="${name}"]`;

const asPlatform = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } }; };
const asClub = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } }; };

const item = (over = {}) => ({ endpoint: "details.session", name: "metabolic_power", kind: "unit_value_object", unitWord: "power", answersSeen: 12, lastSeenOn: "2026-11-10", covered: false, connectionCount: 2, creatable: true, ...over });
const inventory = () => [
  item(),
  item({ endpoint: "details.drill", name: "drill_jumps", unitWord: "number" }),
  item({ endpoint: "athlete_session", name: "hsr_distance", kind: "number", unitWord: null }),
  item({ endpoint: "athlete_session", name: "text_thing", kind: "text", unitWord: null, creatable: false }),
  item({ endpoint: "more.complementary_data", name: "zones_x", kind: "zone_list", unitWord: null, creatable: false }),
];
const revision = (over = {}) => ({
  id: R1, revisionNumber: 1, state: "active", valueShape: "unit_value_object", parameterKind: "none", supportsSession: true, supportsDrill: false,
  expectedSourceUnit: "W/kg", sourceUnit: null, expectedSourceBoundUnit: null, sourceBoundUnit: null, boundOperator: null,
  evidenceStatus: "unproven", evidenceRef: null, unitEvidenceRef: null, meaningEvidenceRef: null, unitVerifiedAt: null, meaningVerifiedAt: null, ...over,
});
const field = (over = {}) => ({ id: NEW, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "details.players.metabolic_power", label: "Metabolic power", state: "active", revisions: [revision()], ...over });

let fields = [];
let invItems = inventory();
let invLimits = undefined;
let post = () => ({ status: 404, body: { error: "notFound" } });
function serve() {
  respond = (call) => {
    if (call.method === "POST") return post(call);
    if (call.url === FB) return { status: 200, body: { fields } };
    if (call.url.startsWith(INV)) return { status: 200, body: { fields: invItems, nextCursor: null, zoneThresholds: invLimits } };
    const one = fields.find((f) => call.url === `${FB}/${f.id}`);
    if (one) return { status: 200, body: { field: one, verifications: [] } };
    return { status: 404, body: { error: "notFound" } };
  };
}

beforeEach(() => {
  resetSourceFields();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  fields = [];
  invItems = inventory();
  post = () => ({ status: 404, body: { error: "notFound" } });
  state.trainingLoad.section = "source-fields";
  asPlatform();
  serve();
});

async function openCreate(endpoint = "details.session", name = "metabolic_power") {
  await loadSourceFieldsSection(render);
  await click(createButton(endpoint, name));
  assert.ok($('[data-source-fields-form="create"]'), "the create form is open");
}

test("1. Create field is offered only on a name the server marked creatable, in the platform workspace; never on a covered, text or zone name, never to a club (even with a forged flag), and a forged click opens nothing", async () => {
  await loadSourceFieldsSection(render);
  const offered = [...content.querySelectorAll('[data-action="source-fields-create-open"]')].map((b) => `${b.dataset.sfInvEndpoint}:${b.dataset.sfInvName}`);
  assert.deepEqual(offered, ["details.session:metabolic_power", "details.drill:drill_jumps", "athlete_session:hsr_distance"]);
  assert.match(text(), /Create field, where it is offered, turns a number GPEXE sends into a source field; the other names cannot become a field yet\./);
  // A forged click on a name the server did not mark opens nothing.
  await handleSourceFieldsAction({ dataset: { action: "source-fields-create-open", sfInvEndpoint: "athlete_session", sfInvName: "text_thing" } }, { render });
  assert.equal(sourceFieldsState().form, null);
  // A club: no button, even when an answer carried the flag; a forged click opens nothing.
  resetSourceFields();
  asClub();
  await loadSourceFieldsSection(render);
  assert.equal(content.querySelectorAll('[data-action="source-fields-create-open"]').length, 0);
  assert.match(text(), /There is nothing to do here/);
  await handleSourceFieldsAction({ dataset: { action: "source-fields-create-open", sfInvEndpoint: "details.session", sfInvName: "metabolic_power" } }, { render });
  assert.equal(sourceFieldsState().form, null);
  assert.equal(posts().length, 0);
});

test("2. the form names the GPEXE name, where it comes from and what happens next; its levels follow the endpoint - a per-drill name is always recorded for each drill; Cancel goes back to the button", async () => {
  await openCreate();
  assert.match(text(), /Create a field from metabolic_power/);
  assert.match(text(), /GPEXE · Whole session · number with unit \(GPEXE says: power\)/);
  assert.match(text(), /Tick Each drill only if GPEXE also sends this value for each drill\./);
  assert.ok(text().includes(CREATE_NEXT_STEP), "the next step, said once");
  assert.equal(CREATE_NEXT_STEP, "This field has no values yet. Its unit is confirmed on the board once new sessions carry it.");
  assert.deepEqual([$('[data-sf-field="supportsSession"]').checked, $('[data-sf-field="supportsDrill"]').checked], [true, false]);
  assert.equal($('[data-sf-field="label"]').value, "", "nothing preset");
  await click('[data-action="source-fields-cancel"]');
  assert.equal(sourceFieldsState().form, null);
  assert.equal(document.activeElement, $(createButton("details.session", "metabolic_power")), "focus back on the button");
  await click(createButton("details.drill", "drill_jumps"));
  const drill = $('[data-sf-field="supportsDrill"]');
  assert.deepEqual([drill.checked, drill.disabled, $('[data-sf-field="supportsSession"]').checked], [true, true, false]);
  assert.match(text(), /GPEXE sends this name per drill, so the field is always recorded for each drill\./);
  sourceFieldsState().form = null;
  render();
  await click(createButton("athlete_session", "hsr_distance"));
  assert.deepEqual([$('[data-sf-field="supportsSession"]').checked, $('[data-sf-field="supportsDrill"]').checked], [true, true]);
});

test("3. the checks before sending: a name is required and one line of at most 80 characters, at least one level; nothing is sent, and the marked field is said", async () => {
  await openCreate();
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Check the marked fields\./);
  assert.equal($('[data-sf-field="label"]').getAttribute("aria-invalid"), "true");
  type("label", "x".repeat(81));
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /At most 80 characters\./);
  type("label", "Metabolic power");
  tick("supportsSession", false);
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Choose the session, the drill or both\./);
  assert.equal(confirmQuestions.length, 0, "no last question before the form is right");
});

test("4. created: the last question names the label, the GPEXE name and where it comes from; the body is exactly route C's; the new field opens with the next step, and the list and the names are read again", async () => {
  post = (call) => {
    fields = [field()];
    invItems = inventory().slice(1);
    return { status: 201, body: { field: { id: NEW, key: "details.players.metabolic_power" }, revision: { id: R1 } } };
  };
  await openCreate();
  type("label", "  Metabolic power  ");
  tick("supportsDrill", true);
  confirmAnswer = false;
  await submit();
  assert.equal(posts().length, 0, "a declined last question sends nothing");
  assert.equal(confirmQuestions.at(-1), "Create the source field \"Metabolic power\" from GPEXE's name metabolic_power (Whole session)? Once created, the field cannot be removed here.");
  confirmAnswer = true;
  await submit();
  assert.equal(posts().length, 1);
  const [sent] = posts();
  assert.equal(sent.url, FB);
  assert.deepEqual(Object.keys(sent.body).sort(), ["endpoint", "label", "name", "requestKey", "supportsDrill", "supportsSession"]);
  assert.match(sent.body.requestKey, UUID);
  assert.deepEqual({ ...sent.body, requestKey: "k" }, { requestKey: "k", endpoint: "details.session", name: "metabolic_power", label: "Metabolic power", supportsSession: true, supportsDrill: true });
  assert.equal(sourceFieldsState().form, null);
  assert.equal(sourceFieldsState().detail.id, NEW, "the new field opens");
  assert.ok(calls.some((c) => c.method === "GET" && c.url === `${FB}/${NEW}`));
  assert.match(text(), new RegExp(`The field was created\\. ${CREATE_NEXT_STEP.replaceAll(".", "\\.")}`));
  // Back: the list and the names are read again, and the created name has no button any more.
  calls.length = 0;
  await click('[data-action="source-fields-back"]');
  assert.ok(calls.some((c) => c.url === FB) && calls.some((c) => c.url.startsWith(INV)), "both read again");
  assert.equal($(createButton("details.session", "metabolic_power")), null);
});

test("5. field_exists: nothing was created and the existing field opens; a coded refusal keeps the form and says nothing was created; try_again keeps the same request key", async () => {
  fields = [field({ id: OLD, label: "Metabolic power (older)" })];
  post = () => ({ status: 409, body: { error: "field_exists", message: "x", current: { fieldId: OLD } } });
  await openCreate();
  type("label", "Metabolic power");
  await submit();
  assert.equal(sourceFieldsState().form, null);
  assert.equal(sourceFieldsState().detail.id, OLD);
  assert.match(text(), /This field already exists, so nothing was created\. It is shown below\./);
  resetSourceFields();
  post = () => ({ status: 409, body: { error: "value_not_number", message: "x" } });
  await openCreate();
  type("label", "Metabolic power");
  await submit();
  assert.ok(sourceFieldsState().form, "the form stays");
  assert.match(text(), /Not created: GPEXE sends this name as something other than a number, so a check could not keep it\./);
  const key = posts().at(-1).body.requestKey;
  post = () => ({ status: 409, body: { error: "try_again", message: "busy" } });
  await submit();
  assert.match(text(), /The server was busy\. Nothing was created\. Try again\./);
  assert.equal(posts().at(-1).body.requestKey, key, "the same request key");
  post = () => ({ status: 409, body: { error: "too_many_fields", message: "x" } });
  await submit();
  assert.match(text(), /Not created: a check already keeps the most fields of this kind it can \(64\)\./);
});

test("6. a lost answer: Result not confirmed, the leave guard asks, Check result sends the very same request, and a created answer then opens the field", async () => {
  let lose = true;
  post = () => {
    if (lose) return { throwNetworkError: true };
    fields = [field()];
    return { status: 200, body: { field: { id: NEW }, revision: { id: R1 }, replayed: true } };
  };
  await openCreate();
  type("label", "Metabolic power");
  await submit();
  assert.match(text(), /Result not confirmed\. No answer arrived, so it is not known whether the field was created\./);
  confirmAnswer = false;
  assert.equal(sourceFieldsMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "It is not known whether the new field was created. Leave without checking? Open Source fields later to see.");
  confirmAnswer = true;
  const first = posts()[0];
  lose = false;
  await click('[data-action="source-fields-check-result"]');
  const second = posts()[1];
  assert.deepEqual(second.body, first.body, "the very same request");
  assert.equal(sourceFieldsState().detail.id, NEW);
  assert.match(text(), /The field was created\./);
});

test("7. a Check result answered by a refusal from the body settles it (nothing was created); Close without checking reads the list and the names again", async () => {
  let lose = true;
  post = () => (lose ? { throwNetworkError: true } : { status: 409, body: { error: "name_not_observed", message: "x" } });
  await openCreate();
  type("label", "Metabolic power");
  await submit();
  lose = false;
  await click('[data-action="source-fields-check-result"]');
  assert.equal(sourceFieldsState().form.unconfirmed, false, "settled");
  assert.match(text(), /Not created: GPEXE has not sent this name as a measured value\. Find new sessions first\./);
  // Lost again, then closed without checking: everything is read again.
  resetSourceFields();
  post = () => ({ throwNetworkError: true });
  await openCreate();
  type("label", "Metabolic power");
  await submit();
  calls.length = 0;
  await click('[data-action="source-fields-cancel"]');
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /The result was not checked\. The source fields below are as they are saved now\./);
  assert.ok(calls.some((c) => c.url === FB) && calls.some((c) => c.url.startsWith(INV)));
});

test("8. the status words (8.4): a GPEXE-stated revision is never 'confirmed' - its unit is stated by GPEXE and its meaning is GPEXE's own label, both checked on the board; an athlete-row value without a unit says only a document confirms it", async () => {
  const stated = revision({ evidenceStatus: "source_stated", sourceUnit: "W/kg", unitVerifiedAt: "2026-11-16T10:00:00Z", meaningVerifiedAt: "2026-11-16T10:00:00Z" });
  fields = [
    field({ revisions: [stated] }),
    field({ id: OLD, key: "athlete_session.hsr_distance", label: "HSR distance", revisions: [revision({ valueShape: "number", expectedSourceUnit: null })] }),
  ];
  invItems = [];
  await loadSourceFieldsSection(render);
  const facts = [...content.querySelectorAll(".metric-variables-item-facts")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  assert.ok(facts[0].startsWith("Unit W/kg stated by GPEXE, checked on the board · Meaning: GPEXE's own label, checked on the board"), facts[0]);
  assert.doesNotMatch(facts[0], /confirmed/i);
  assert.ok(facts[1].startsWith("Unit not known yet: GPEXE sends none with this value · Meaning not confirmed"), facts[1]);
  await click(`[data-action="source-fields-open"][data-field-id="${NEW}"]`);
  const detail = text();
  assert.match(detail, /Unit stated by GPEXE, checked on the board/);
  assert.match(detail, /GPEXE's own label, checked on the board/);
  const block = $(".source-fields-revision").textContent.replace(/\s+/g, " ");
  assert.doesNotMatch(block, /\bconfirmed\b/i, "never 'confirmed' for a GPEXE-stated revision");
  await click('[data-action="source-fields-back"]');
  await click(`[data-action="source-fields-open"][data-field-id="${OLD}"]`);
  assert.match(text(), /GPEXE sends no unit with this value, so a platform administrator confirms it with a document\./);
});

test("9. a per-drill name keeps its drill level at every layer: a change event on the locked box changes nothing, and a request built from a draft without the drill still sends it", async () => {
  const { buildSourceFieldRequest } = await import("../source-fields-data.js");
  post = () => ({ status: 409, body: { error: "try_again", message: "busy" } });
  await openCreate("details.drill", "drill_jumps");
  tick("supportsDrill", false);
  assert.equal(sourceFieldsState().form.draft.supportsDrill, true, "the locked box's event is ignored");
  type("label", "Drill jumps");
  await submit();
  assert.equal(posts().at(-1).body.supportsDrill, true);
  const form = { ...sourceFieldsState().form, draft: { label: "Drill jumps", supportsSession: false, supportsDrill: false } };
  assert.equal(buildSourceFieldRequest(form).body.supportsDrill, true, "the request keeps the drill whatever the draft says");
});

test("10. the review fixes: a details name GPEXE sends both for the session and per drill opens with both levels and says so; a per-athlete name says a document confirms its unit; field_exists without the existing field reads again and says it exists", async () => {
  invItems = [item(), item({ endpoint: "details.drill", name: "metabolic_power" }), item({ endpoint: "athlete_session", name: "hsr_distance", kind: "number", unitWord: null })];
  await openCreate();
  assert.deepEqual([$('[data-sf-field="supportsSession"]').checked, $('[data-sf-field="supportsDrill"]').checked], [true, true]);
  assert.match(text(), /GPEXE sends this name for the whole session and per drill; one field records both\./);
  sourceFieldsState().form = null;
  render();
  await click(createButton("athlete_session", "hsr_distance"));
  assert.match(text(), /This field has no values yet\. GPEXE sends no unit with it, so a platform administrator confirms its unit with a document\./);
  assert.doesNotMatch(text(), /confirmed on the board/);
  sourceFieldsState().form = null;
  render();
  post = () => ({ status: 409, body: { error: "field_exists", message: "x" } });
  await click(createButton("details.session", "metabolic_power"));
  type("label", "Metabolic power");
  calls.length = 0;
  await submit();
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /This field already exists, so nothing was created\. The source fields are read again below\./);
  assert.ok(calls.some((c) => c.method === "GET" && c.url === FB), "the list is read again");
});

test("Z (the Rukovodilac, 2026-11-18): Create field on a numbered zone says the range it is expected to cover, from the team's limits, and that it is not confirmed yet; another name says nothing of a range", async () => {
  invItems = [...inventory(), item({ name: "athletesessionpowerzone_distance_4", unitWord: "distance", zone: { family: "power", measure: "distance", number: 4 } })];
  invLimits = { power: { values: [20, 25, 60, 75] }, speed: null, asOf: "2026-11-07T10:00:00Z" };
  try {
    await openCreate("details.session", "athletesessionpowerzone_distance_4");
    assert.match(text(), /Expected range of this zone: 60–75 W\/kg \(the team's zone limits in the newest saved session, 07\.11\.2026\)\. After you create the field, confirm it with “Compare with GPEXE”\./);
    sourceFieldsState().form = null;
    render();
    await openCreate();
    assert.doesNotMatch(text(), /Expected range of this zone/);
  } finally { invLimits = undefined; }
});
