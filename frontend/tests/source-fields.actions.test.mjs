// Training Load -> Data configuration -> Source fields (phase 6, J4): the
// screen over GET /fields, F1 and the two acts F2 / F3. Driven through the
// real handlers and the real markup in a DOM, with a fake fetch, so both what
// the screen sends and what it shows are proved: who is offered it, the list
// and one field with its revisions and confirmations, units and references
// always escaped text, the exact act bodies (never an owner, actor or basis),
// the checks before anything is sent, a zone's meaning shown as not yet
// possible (C89), the refusals, a lost answer checked by the very same
// request, a club administrator's read-only view and the guards on leaving.
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

const { handleSourceFieldsAction, handleSourceFieldsInput, loadSourceFieldsSection, resetSourceFields, sourceFieldsMayBeLeft, sourceFieldsUnloadShouldWarn, submitSourceFieldsForm } = await import("../source-fields-actions.js");
const { sourceFieldsContext, sourceFieldsState, buildSourceFieldRequest, openSourceFieldForm } = await import("../source-fields-data.js");
const { renderSourceFieldsHtml } = await import("../source-fields-view.js");
const { renderTrainingLoadCoachHtml, trainingLoadTopLevelSpace } = await import("../training-load-view.js");
const { confirmLeaveTrainingLoad, handleTrainingLoadAction, handleTrainingLoadBeforeUnload, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { state } = await import("../state.js");

const FB = "/api/training-load/sources/metrics/fields";
const CLUB = "11111111-0000-4000-8000-000000000001";
const F1 = "f1f1f1f1-0000-4000-8000-000000000001";
const F2 = "f1f1f1f1-0000-4000-8000-000000000002";
const F3 = "f1f1f1f1-0000-4000-8000-000000000003";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const R2 = "a1a1a1a1-0000-4000-8000-000000000002";
const R3 = "a1a1a1a1-0000-4000-8000-000000000003";
const R0 = "a1a1a1a1-0000-4000-8000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const revision = (over = {}) => ({
  id: R1, revisionNumber: 1, state: "active", valueShape: "number", parameterKind: "none", supportsSession: true, supportsDrill: true,
  expectedSourceUnit: "min", sourceUnit: null, expectedSourceBoundUnit: null, sourceBoundUnit: null, boundOperator: null,
  evidenceStatus: "observed", evidenceRef: null, unitEvidenceRef: null, meaningEvidenceRef: null, unitVerifiedAt: null, meaningVerifiedAt: null,
  ...over,
});
const field = (over = {}) => ({ id: F1, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "athlete_session.total_time", label: "Total time", state: "active", revisions: [revision()], ...over });
// Three fields: a plain one, a zone and an event threshold.
const allFields = () => [
  field(),
  field({ id: F2, key: "more.complementary_data.power.distance", label: "Power zone <distance>", revisions: [revision({ id: R2, valueShape: "zone_distance", parameterKind: "zone_bounds", expectedSourceUnit: "m", expectedSourceBoundUnit: "W/kg" })] }),
  field({ id: F3, key: "more.events.acceleration_events_count", label: "Accelerations", revisions: [revision({ id: R3, valueShape: "event_count", parameterKind: "event_threshold", expectedSourceUnit: "count", supportsDrill: false })] }),
];

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderSourceFieldsHtml(); };
content.addEventListener("input", (event) => handleSourceFieldsInput(event.target));
content.addEventListener("change", (event) => handleSourceFieldsInput(event.target));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
// The value one fact of a revision (a <dt> / <dd> pair) shows.
const fact = (root, name) => [...root.querySelectorAll(".metric-variables-facts dt")].find((dt) => dt.textContent === name)?.nextElementSibling?.textContent.replace(/\s+/g, " ").trim();
const gets = () => calls.filter((call) => call.method === "GET").map((call) => call.url);

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
function choose(name, value) {
  const element = $(`[data-sf-field="${name}"]`);
  element.value = value;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const submit = () => submitSourceFieldsForm({ render });

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}

// The reads answer from `fields` (and `verifications` per field); the acts from `post(call)`.
let fields = allFields();
let verifications = {};
function serve(post = () => ({ status: 404, body: { error: "notFound" } })) {
  respond = (call) => {
    if (call.method === "GET" && call.url === FB) return { status: 200, body: { fields } };
    const one = call.method === "GET" && fields.find((f) => call.url === `${FB}/${f.id}`);
    if (one) return { status: 200, body: { field: one, verifications: verifications[one.id] || [] } };
    if (call.method === "POST") return post(call);
    return { status: 404, body: { error: "notFound" } };
  };
}
async function openField(id) {
  await loadSourceFieldsSection(render);
  await click(`[data-action="source-fields-open"][data-field-id="${id}"]`);
}

beforeEach(() => {
  resetSourceFields();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  fields = allFields();
  verifications = {};
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "source-fields";
  asPlatform();
  content.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Who is offered the screen (C80, C94, C99)
// ---------------------------------------------------------------------------
test("Source fields is a Data configuration view for the platform and a club workspace; a team workspace gets Variables only", () => {
  assert.equal(trainingLoadTopLevelSpace("source-fields"), "dataConfig");
  for (const [workspace, offered, mayVerify] of [
    [{ type: "platform", scopeId: null, label: "Platform" }, true, true],
    [{ type: "club", scopeId: CLUB, label: "FK Borac" }, true, false],
    [{ type: "team", scopeId: "t1", clubId: CLUB, label: "First team" }, false, false],
    [{ type: "private_coach", scopeId: "u1", label: "Me" }, false, false],
    [{ type: "athlete", scopeId: "a1", label: "Me" }, false, false],
  ]) {
    state.currentUser = { id: "u1", activeWorkspace: workspace };
    state.trainingLoad.section = "variables";
    const html = renderTrainingLoadCoachHtml();
    assert.equal(html.includes('data-section="source-fields"'), offered, `${workspace.type}: Source fields offered = ${offered}`);
    assert.equal(Boolean(sourceFieldsContext()), offered);
    if (offered) assert.equal(sourceFieldsContext().mayVerify, mayVerify);
  }
  asPlatform();
  state.trainingLoad.section = "source-fields";
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /aria-label="Data configuration views"/);
  assert.match(html, /data-section="source-fields">Source fields</);
  assert.match(html, /class="training-load-subnav-tab is-active" role="tab" aria-selected="true" data-action="training-load-section" data-section="source-fields"/);
});

test("a workspace without the screen reads nothing and says where it is", async () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "t1", clubId: CLUB, label: "First team" } };
  await loadSourceFieldsSection(render);
  assert.equal(calls.length, 0);
  assert.match(text(), /available to administrators in the platform workspace and in a club workspace/);
});

// ---------------------------------------------------------------------------
// The list and one field
// ---------------------------------------------------------------------------
test("the list groups the fields by source, shows the unit (expected units marked not proven) and the evidence; names are escaped", async () => {
  fields[0].revisions = [revision({ sourceUnit: "s<b>", unitVerifiedAt: "2026-10-20T08:00:00.000Z", evidenceStatus: "observed" })];
  await loadSourceFieldsSection(render);
  assert.deepEqual(gets(), [FB]);
  assert.match(text(), /GPEXE · REST v1/);
  const items = [...content.querySelectorAll(".metric-variables-item")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(items.length, 3);
  assert.match(items[0], /Total time Unit s<b> \(confirmed\) · Meaning not confirmed · Session and Drill Evidence: Observed/);
  assert.match(items[1], /Expected unit m \(not proven\)/);
  assert.match(items[1], /Meaning waits for the zone decision/);
  assert.match(items[2], /Session Evidence: Observed/);
  assert.match(text(), /Evidence: Not proven, no evidence yet · Documented, described in a document · Observed, seen in the source's answers, its unit and meaning not confirmed · Verified, its unit and meaning confirmed\./);
  assert.ok(content.innerHTML.includes("Power zone &lt;distance&gt;"), "a label is escaped");
  assert.ok(content.innerHTML.includes("Unit s&lt;b&gt;"), "a unit is escaped");
  assert.ok(!content.querySelector("a"), "nothing is a link");
});

test("a list that cannot be read offers Try again; 404 and result_too_large say why", async () => {
  respond = () => ({ status: 500, body: { error: "internal_error" } });
  await loadSourceFieldsSection(render);
  assert.match(text(), /The source fields could not be loaded\./);
  respond = () => ({ status: 409, body: { error: "result_too_large", limit: 500 } });
  await click('[data-action="source-fields-reload"]');
  assert.match(text(), /There are more source fields than this screen shows at once\./);
  respond = () => ({ status: 404, body: { error: "notFound" } });
  await click('[data-action="source-fields-reload"]');
  assert.match(text(), /Source fields are not available in this workspace\./);
});

test("one field: its revisions with facts, expected units marked not proven, confirmations with their evidence as text; ids only under Technical details", async () => {
  fields[0].revisions = [
    revision({ id: R1, revisionNumber: 2, sourceUnit: "s", unitVerifiedAt: "2026-10-20T08:00:00.000Z", unitEvidenceRef: "docs/ai/evidence.md#total-time", evidenceRef: "docs/ai/evidence.md#total-time" }),
    revision({ id: R0, revisionNumber: 1, state: "retired" }),
  ];
  verifications[F1] = [{ revisionId: R1, act: "unit", at: "2026-10-20T08:00:00.000Z", evidenceRef: "docs/ai/evidence.md#total-time" }];
  await openField(F1);
  assert.equal(gets().at(-1), `${FB}/${F1}`);
  assert.equal($("#source-fields-title").textContent, "Total time");
  const revisions = [...content.querySelectorAll(".source-fields-revision")];
  assert.equal(revisions.length, 2);
  assert.match(revisions[0].textContent.replace(/\s+/g, " "), /Revision 2 Active Evidence: Observed/);
  assert.equal(fact(revisions[0], "Unit"), "s confirmed 20.10.2026");
  assert.equal(fact(revisions[0], "Unit evidence"), "docs/ai/evidence.md#total-time");
  assert.equal(fact(revisions[0], "Recorded for"), "Session and Drill");
  assert.match(revisions[1].textContent.replace(/\s+/g, " "), /Revision 1 Retired/);
  assert.equal(fact(revisions[1], "Unit"), "Not confirmed (expected min, not proven)");
  assert.match(text(), /Revision 2 · Unit confirmed · 20\.10\.2026 Evidence docs\/ai\/evidence\.md#total-time/);
  const visible = [...content.querySelector("section.source-fields").children].filter((n) => !n.classList.contains("data-sources-tech")).map((n) => n.textContent).join(" ");
  assert.ok(!visible.includes(F1) && !visible.includes(R1), "no id in the visible text");
  assert.ok($(".data-sources-tech").textContent.includes(R1));
  assert.ok(!content.querySelector("a"), "an evidence reference is never a link");
});

test("the acts the platform admin is offered follow the revision: a confirmed unit, a retired revision and a zone's meaning are not offered", async () => {
  await openField(F1);
  assert.deepEqual([...content.querySelectorAll('[data-action="source-fields-act-open"]')].map((b) => b.dataset.act), ["unit", "meaning"]);
  await click('[data-action="source-fields-back"]');
  await click(`[data-action="source-fields-open"][data-field-id="${F2}"]`);
  assert.deepEqual([...content.querySelectorAll('[data-action="source-fields-act-open"]')].map((b) => b.dataset.act), ["unit"], "a zone: the unit only");
  const blocked = [...content.querySelectorAll(".source-fields-acts button[disabled]")];
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].textContent, "Confirm the meaning");
  assert.match(text(), /The meaning of a zone cannot be confirmed yet: how closed and open zones share one bound operator is not decided\. Code: verification_model_unresolved/);
  // A forged click for a zone's meaning, a retired revision or a confirmed unit opens nothing.
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="source-fields-act-open" data-act="meaning" data-revision-id="${R2}"></button>`);
  await handleSourceFieldsAction($("#forged"), { render });
  assert.equal(sourceFieldsState().form, null);
  resetSourceFields();
  fields[0].revisions = [revision({ sourceUnit: "s", unitVerifiedAt: "2026-10-20T08:00:00.000Z" }), revision({ id: R0, revisionNumber: 0, state: "retired" })];
  await openField(F1);
  for (const [act, id] of [["unit", R1], ["unit", R0], ["meaning", R0]]) {
    content.insertAdjacentHTML("beforeend", `<button id="f-${act}-${id}" data-action="source-fields-act-open" data-act="${act}" data-revision-id="${id}"></button>`);
    await handleSourceFieldsAction($(`#f-${act}-${id}`), { render });
    assert.equal(sourceFieldsState().form, null, `${act} on ${id}`);
  }
  assert.equal(posts().length, 0);
});

test("club admin: reads the fields and revisions, is offered no act, and a forged click opens nothing", async () => {
  asClub();
  await openField(F1);
  assert.match(text(), /Read only here: a platform administrator confirms units and meanings in the platform workspace\./);
  assert.equal(content.querySelectorAll('[data-action="source-fields-act-open"]').length, 0);
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="source-fields-act-open" data-act="unit" data-revision-id="${R1}"></button>`);
  await handleSourceFieldsAction($("#forged"), { render });
  assert.equal(sourceFieldsState().form, null);
  await click('[data-action="source-fields-back"]');
  assert.match(text(), /A platform administrator confirms their units and meanings in the platform workspace\./);
});

// ---------------------------------------------------------------------------
// The two acts
// ---------------------------------------------------------------------------
test("confirm a unit: the fields are checked before anything is sent; the body is exactly the form's; the field is read again", async () => {
  serve((call) => {
    fields[0].revisions = [revision({ sourceUnit: "s", unitVerifiedAt: "2026-10-28T10:00:00.000Z", unitEvidenceRef: "docs/ai/evidence.md#total-time" })];
    return { status: 201, body: { revision: fields[0].revisions[0], replayed: false } };
  });
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  assert.equal($("#source-fields-title").textContent, "Confirm the unit of Total time (revision 1)");
  assert.match(text(), /Expected, not proven: min\. Enter what the evidence shows\./);
  assert.equal($('[data-sf-field="sourceUnit"]').value, "", "the expected unit is never filled in for the admin");
  assert.ok(!$('[data-sf-field="sourceBoundUnit"]'), "no bound for a plain field");
  await submit();
  assert.equal(posts().length, 0, "nothing is sent while a field is wrong");
  assert.equal($('[data-sf-field="sourceUnit"]').getAttribute("aria-invalid"), "true");
  type("sourceUnit", "m in");
  type("evidenceRef", "https://example.com/#x");
  await submit();
  assert.equal(posts().length, 0);
  assert.match($("#sf-err-sourceUnit").textContent, /No spaces/);
  assert.match($("#sf-err-evidenceRef").textContent, /A path under docs\//);
  type("sourceUnit", " s ");
  type("evidenceRef", " docs/ai/evidence.md#total-time ");
  await submit();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, `${FB}/${F1}/revisions/${R1}/unit-verification`);
  const body = posts()[0].body;
  assert.match(body.requestKey, UUID);
  assert.deepEqual(body, { requestKey: body.requestKey, sourceUnit: "s", evidenceRef: "docs/ai/evidence.md#total-time" }, "no owner, actor or basis");
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /The unit was confirmed\./);
  assert.equal($(".metric-variables-notice").getAttribute("role"), "status");
  assert.ok(!$(".metric-variables-notice").classList.contains("is-warning"));
  assert.equal(fact($(".source-fields-revision"), "Unit"), "s confirmed 28.10.2026");
  assert.deepEqual(confirmQuestions.slice(-1), ['Confirm the unit of Total time (revision 1) as "s", with the evidence docs/ai/evidence.md#total-time? It is saved once and never changed; a correction is a new revision.']);
});

test("a declined last question sends nothing and keeps the form with its values", async () => {
  serve(() => ({ status: 201, body: { revision: revision() } }));
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  assert.match($(".source-fields-summary").textContent.replace(/\s+/g, " "), /Total time · athlete_session\.total_time · GPEXE · REST v1 · A number · Session and Drill · Parameter: None/);
  type("sourceUnit", "s");
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  confirmAnswer = false;
  await submit();
  assert.equal(posts().length, 0);
  assert.ok(sourceFieldsState().form);
  assert.equal($('[data-sf-field="sourceUnit"]').value, "s");
  confirmAnswer = true;
  await submit();
  assert.equal(posts().length, 1);
});

test("a field whose re-read failed may be out of date: it says so, offers Try again and no act", async () => {
  await openField(F1);
  respond = () => ({ status: 500, body: { error: "internal_error" } });
  const { loadSourceField } = await import("../source-fields-actions.js");
  await loadSourceField(F1, render);
  assert.match(text(), /The field could not be loaded\. The field below may be out of date\./);
  assert.ok($('[data-action="source-fields-detail-reload"]'));
  assert.equal(content.querySelectorAll('[data-action="source-fields-act-open"]').length, 0, "no act on a field that may be out of date");
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="source-fields-act-open" data-act="unit" data-revision-id="${R1}"></button>`);
  await handleSourceFieldsAction($("#forged"), { render });
  assert.equal(sourceFieldsState().form, null, "the handler refuses it too");
  serve();
  await click('[data-action="source-fields-detail-reload"]');
  assert.ok($('[data-action="source-fields-act-open"]'), "after Try again the acts are back");
});

test("a club admin sees why a zone's meaning is not confirmed; the detail names the bound and operator as the forms do", async () => {
  asClub();
  fields[2].revisions = [revision({ id: R3, valueShape: "event_count", parameterKind: "event_threshold", boundOperator: ">=", meaningVerifiedAt: "2026-10-20T08:00:00.000Z", sourceBoundUnit: "m/s2", sourceUnit: "count", unitVerifiedAt: "2026-10-20T08:00:00.000Z" })];
  await openField(F2);
  assert.equal(fact($(".source-fields-revision"), "Meaning"), "Not confirmed yet: waits for a decision on zones");
  assert.equal(fact($(".source-fields-revision"), "Unit of the zone bounds"), "Not confirmed (expected W/kg, not proven)");
  await click('[data-action="source-fields-back"]');
  await click(`[data-action="source-fields-open"][data-field-id="${F3}"]`);
  assert.equal(fact($(".source-fields-revision"), "Operator"), "At least (>=)");
  assert.equal(fact($(".source-fields-revision"), "Unit of the threshold"), "m/s2");
});

test("confirm a unit with a bound: a zone or an event threshold sends the bound unit too", async () => {
  serve(() => ({ status: 201, body: { revision: revision({ id: R2 }) } }));
  await openField(F2);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  assert.match(text(), /Unit of the zone bounds/);
  type("sourceUnit", "m");
  type("evidenceRef", "docs/ai/evidence.md#power");
  await submit();
  assert.equal(posts().length, 0, "the bound unit is required");
  assert.match($("#sf-err-sourceBoundUnit").textContent, /Required\./);
  type("sourceBoundUnit", "W/kg");
  await submit();
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, sourceUnit: "m", sourceBoundUnit: "W/kg", evidenceRef: "docs/ai/evidence.md#power" });
});

test("confirm a meaning: an event threshold needs its one-sided operator; a plain field sends the reference only", async () => {
  serve(() => ({ status: 201, body: { revision: revision() } }));
  await openField(F3);
  await click('[data-action="source-fields-act-open"][data-act="meaning"]');
  assert.deepEqual([...content.querySelectorAll('[data-sf-field="boundOperator"] option')].map((o) => o.value).filter(Boolean), [">=", ">", "<=", "<"], "never between");
  type("evidenceRef", "docs/ai/evidence.md#accelerations");
  await submit();
  assert.equal(posts().length, 0);
  assert.match($("#sf-err-boundOperator").textContent, /Choose one\./);
  choose("boundOperator", ">=");
  await submit();
  assert.equal(posts()[0].url, `${FB}/${F3}/revisions/${R3}/meaning-verification`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, boundOperator: ">=", evidenceRef: "docs/ai/evidence.md#accelerations" });
  assert.match(text(), /The meaning was confirmed\./);
  await click('[data-action="source-fields-back"]');
  await click(`[data-action="source-fields-open"][data-field-id="${F1}"]`);
  await click('[data-action="source-fields-act-open"][data-act="meaning"]');
  assert.ok(!$('[data-sf-field="boundOperator"]'));
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  await submit();
  assert.deepEqual(posts()[1].body, { requestKey: posts()[1].body.requestKey, evidenceRef: "docs/ai/evidence.md#total-time" });
});

test("typing in a Source fields form is never swallowed by the Variables screen's input handler (app.js asks it first)", async () => {
  const { handleVariablesInput } = await import("../metric-variables-actions.js");
  const { variablesState } = await import("../metric-variables-data.js");
  variablesState();
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  const input = $('[data-sf-field="sourceUnit"]');
  input.value = "s";
  assert.equal(handleVariablesInput(input, { render }), false, "the Variables handler leaves it alone");
  assert.equal(handleSourceFieldsInput(input), true);
  assert.equal(sourceFieldsState().form.draft.sourceUnit, "s");
});

test("the request builder: a 301-character reference and a unit of 31 characters are refused before sending", () => {
  const form = openSourceFieldForm("unit", { field: field(), revision: revision() });
  form.draft = { sourceUnit: "x".repeat(31), sourceBoundUnit: "", evidenceRef: `docs/${"a".repeat(291)}.md#x` };
  const { body, errors } = buildSourceFieldRequest(form);
  assert.equal(body, null);
  assert.match(errors.sourceUnit, /At most 30 characters/);
  assert.match(errors.evidenceRef, /At most 300 characters/);
});

for (const [code, sentence] of [
  ["unit_already_verified", /Not saved: this unit was already confirmed, perhaps by someone else in the meantime\. Check the confirmed unit below; if it is wrong, the correction is a new revision\./],
  ["revision_retired", /Not saved: this revision is retired and is never changed\./],
  ["bound_unit_required", /Not saved: this revision has a bound, so the bound's unit is confirmed together with the unit\./],
  ["notFound", /It is not available in this workspace now\. Whether the confirmation was saved is not known: open the field from the platform workspace to see\./],
]) {
  test(`${code}: the form closes, the field is read again and the screen says why`, async () => {
    serve(() => ({ status: code === "notFound" ? 404 : 409, body: { error: code } }));
    await openField(F1);
    await click('[data-action="source-fields-act-open"][data-act="unit"]');
    type("sourceUnit", "s");
    type("evidenceRef", "docs/ai/evidence.md#total-time");
    const reads = gets().filter((url) => url === `${FB}/${F1}`).length;
    await submit();
    assert.equal(sourceFieldsState().form, null);
    assert.match(text(), sentence);
    assert.doesNotMatch(text(), /Nothing was saved/, "a refusal after a possible COMMIT never says nothing was saved");
    const notice = $(".metric-variables-notice");
    assert.ok(notice.classList.contains("is-warning"), "a refusal is a warning, never the saved notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(gets().filter((url) => url === `${FB}/${F1}`).length, reads + 1);
  });
}

test("invalid_unit and invalid_evidence_ref keep the form with the field marked; try_again keeps it and its key", async () => {
  let answer = { status: 400, body: { error: "invalid_unit" } };
  serve(() => answer);
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  type("sourceUnit", "s");
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  await submit();
  assert.ok(sourceFieldsState().form);
  assert.equal($('[data-sf-field="sourceUnit"]').getAttribute("aria-invalid"), "true");
  assert.match(text(), /Not saved: the server does not take this unit\./);
  answer = { status: 409, body: { error: "try_again" } };
  type("sourceUnit", "sec");
  await submit();
  assert.match(text(), /The server was busy\. Nothing was saved\. Try again\./);
  assert.equal(posts()[1].body.requestKey, posts()[0].body.requestKey, "the same form keeps its key");
});

// ---------------------------------------------------------------------------
// A lost answer is checked by the very same request
// ---------------------------------------------------------------------------
for (const [name, lost] of [
  ["no answer", { throwNetworkError: true }],
  ["503 outcome_unknown", { status: 503, body: { error: "outcome_unknown" } }],
  ["an uncoded 502", { status: 502, body: {} }],
]) {
  test(`${name}: Result not confirmed; Check result sends the same body; a busy check stays unconfirmed; a replay settles it`, async () => {
    const answers = [lost, { status: 409, body: { error: "try_again" } }, { status: 200, body: { revision: revision(), replayed: true } }];
    serve(() => answers.shift());
    await openField(F1);
    await click('[data-action="source-fields-act-open"][data-act="unit"]');
    type("sourceUnit", "s");
    type("evidenceRef", "docs/ai/evidence.md#total-time");
    await submit();
    assert.match(text(), /Result not confirmed\./);
    assert.ok($('[data-sf-field="sourceUnit"]').disabled, "the fields are locked");
    assert.equal(sourceFieldsUnloadShouldWarn(), true);
    await submit();
    assert.equal(posts().length, 1, "a submit cannot send again while unconfirmed");
    await click('[data-action="source-fields-check-result"]');
    assert.equal(posts()[1].rawBody, posts()[0].rawBody, "the same request key and body");
    assert.match(text(), /The check could not be done: the server was busy\./);
    await click('[data-action="source-fields-check-result"]');
    assert.equal(posts()[2].rawBody, posts()[0].rawBody);
    assert.equal(sourceFieldsState().form, null);
    assert.match(text(), /The unit was confirmed\./);
  });
}

test("a check answered by a refusal from the body settles it; Close without checking reads the field again", async () => {
  const answers = [{ throwNetworkError: true }, { status: 409, body: { error: "unit_already_verified" } }];
  serve(() => answers.shift());
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  type("sourceUnit", "s");
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  await submit();
  await click('[data-action="source-fields-check-result"]');
  assert.equal(sourceFieldsState().form, null, "unit_already_verified settles the check and closes the form");
  assert.match(text(), /Not saved: this unit was already confirmed/);

  serve(() => ({ throwNetworkError: true }));
  await click('[data-action="source-fields-act-open"][data-act="meaning"]');
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  await submit();
  confirmAnswer = false;
  await click('[data-action="source-fields-cancel"]');
  assert.deepEqual(confirmQuestions.slice(-1), ["The result of the last confirmation is not known. Leave without checking? Open the field later to see whether it was saved."]);
  assert.ok(sourceFieldsState().form, "declined: the form stays");
  confirmAnswer = true;
  const reads = gets().filter((url) => url === `${FB}/${F1}`).length;
  await click('[data-action="source-fields-cancel"]');
  assert.equal(sourceFieldsState().form, null);
  assert.match(text(), /The result was not checked\. The field below is as it is saved now\./);
  assert.equal(gets().filter((url) => url === `${FB}/${F1}`).length, reads + 1);
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
test("leaving asks about unsaved values and an act in flight; the Training Load guards and the unload warning include it", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = () => resolve({ status: 201, body: { revision: revision() } }); }));
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  assert.equal(sourceFieldsMayBeLeft(), true, "an untouched form is left without a question");
  type("sourceUnit", "s");
  confirmAnswer = false;
  assert.equal(sourceFieldsMayBeLeft(), false);
  assert.deepEqual(confirmQuestions.slice(-1), ["Discard the confirmation you have not saved?"]);
  assert.equal(confirmLeaveTrainingLoad("calendar"), false, "leaving Training Load asks too");
  const event = { preventDefault() { this.prevented = true; }, returnValue: "" };
  assert.equal(handleTrainingLoadBeforeUnload(event), true);
  assert.ok(event.prevented);
  content.innerHTML = `<button data-action="training-load-section" data-section="variables"></button>`;
  await handleTrainingLoadAction(content.firstElementChild, { renderTrainingLoad: () => {}, openWeeklyPlanForAthleteOnDate: () => {} });
  assert.equal(state.trainingLoad.section, "source-fields", "declined: the view stays");
  confirmAnswer = true;
  render();
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  const pending = submit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  confirmAnswer = false;
  assert.equal(sourceFieldsMayBeLeft(), false);
  assert.deepEqual(confirmQuestions.slice(-1), ["A confirmation is still being saved. Leave anyway? Its result will not be shown."]);
  release();
  await pending;
  assert.equal(sourceFieldsState().form, null);
});

test("an answer that lands after the workspace was left changes nothing; a workspace switch leaves the view", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = () => resolve({ status: 201, body: { revision: revision() } }); }));
  await openField(F1);
  await click('[data-action="source-fields-act-open"][data-act="unit"]');
  type("sourceUnit", "s");
  type("evidenceRef", "docs/ai/evidence.md#total-time");
  const pending = submit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetTrainingLoadForWorkspaceChange();
  assert.notEqual(state.trainingLoad.section, "source-fields", "the view is left: the new workspace may not offer it");
  const before = calls.length;
  release();
  await pending;
  assert.equal(sourceFieldsState().form, null);
  assert.equal(sourceFieldsState().detail.id, null);
  assert.equal(calls.length, before, "nothing is read for the old workspace");
});
