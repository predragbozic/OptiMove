// Training Load -> Data configuration -> Mappings (phase 8, J16), driven
// through the real handlers and the real markup in a DOM, against a fake
// server that keeps the routes' contracts (the request-key replay, the
// request_key_reused refusal, pages with a cursor, the scope of a workspace).
// It proves what the screen sends (never an owner, an actor or a basis) and
// what it shows: who is offered it, the guided flow's choosability and its
// reasons, the exact bound in the field's unit, the two-write save with a lost
// answer on each write, the acts by state, the teams a replacement or a
// disable switches off, switching teams on and off by name, the preview's
// fail-closed mark, hostile names, the refusal sentences and the guards.
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

let overrides = [];
const calls = installFetchMock((call) => route(call));
after(() => restoreFetch());

const actions = await import("../metric-mappings-actions.js");
const data = await import("../metric-mappings-data.js");
const { renderMappingsHtml } = await import("../metric-mappings-view.js");
const { renderDataConfigHomeHtml } = await import("../data-config-home-view.js");
const { trainingLoadTopLevelSpace } = await import("../training-load-view.js");
const { confirmLeaveTrainingLoad, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { state } = await import("../state.js");

const B = "/api/training-load/sources/metrics";
const CLUB = "c0c0c0c0-0000-4000-8000-000000000001";
const CLUB2 = "c0c0c0c0-0000-4000-8000-000000000002";
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FA = id("f0f0f0f0", 1), FZ = id("f0f0f0f0", 2), FN = id("f0f0f0f0", 3), FU = id("f0f0f0f0", 4);
const RA = id("a0a0a0a0", 1), RZ = id("a0a0a0a0", 2), RN = id("a0a0a0a0", 3), RU = id("a0a0a0a0", 4);
const TD = id("d0d0d0d0", 1), TK = id("d0d0d0d0", 2), TX = id("d0d0d0d0", 3), TZ = id("d0d0d0d0", 4);
const M1 = id("e0e0e0e0", 1), M2 = id("e0e0e0e0", 2);
const V1 = id("b0b0b0b0", 1), V2 = id("b0b0b0b0", 2), V3 = id("b0b0b0b0", 3);
const TEAM1 = id("70707070", 1), TEAM2 = id("70707070", 2), TEAM3 = id("70707070", 3);
const B1 = id("b1b1b1b1", 1), B2 = id("b1b1b1b1", 2), B3 = id("b1b1b1b1", 3);
const CONN = id("cccccccc", 1);
const CAND1 = id("ca000000", 1), CAND2 = id("ca000000", 2), CAND3 = id("ca000000", 3);

const rev = (over) => ({ revisionNumber: 1, state: "active", valueShape: "number", parameterKind: "none", supportsSession: true, supportsDrill: true,
  expectedSourceUnit: null, sourceUnit: "m", expectedSourceBoundUnit: null, sourceBoundUnit: null, boundOperator: null, evidenceStatus: "verified", ...over });
let db;
function freshDb() {
  db = {
    fields: [
      { id: FA, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "athlete_session.total_distance", label: "Total distance", state: "active", extractorAvailable: true, revisions: [rev({ id: RA })] },
      { id: FZ, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "more.complementary_data.speed.distance", label: "Speed zone distance", state: "active", extractorAvailable: true,
        revisions: [rev({ id: RZ, valueShape: "zone_distance", parameterKind: "zone_bounds", sourceBoundUnit: "m/s", boundOperator: ">=", evidenceStatus: "observed", state: "draft" })] },
      { id: FN, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "x.unknown", label: "Unknown field", state: "active", extractorAvailable: false, revisions: [rev({ id: RN })] },
      { id: FU, sourceSystem: "gpexe", apiFamily: "rest_v1", key: "athlete_session.total_time", label: "Total time", state: "active", extractorAvailable: true, revisions: [rev({ id: RU, sourceUnit: null, evidenceStatus: "observed" })] },
    ],
    targets: [
      { id: TX, ownerScope: "system", key: "time", label: "Time", currentVersion: { id: "tv-x", versionNumber: 1, unit: "min", canonicalParameters: null }, scopes: ["session"], versionReady: true, notReadyCode: null },
      { id: TK, ownerScope: "system", key: "distance_km", label: "Distance (km)", currentVersion: { id: "tv-k", versionNumber: 1, unit: "km", canonicalParameters: null }, scopes: ["session", "component"], versionReady: true, notReadyCode: null },
      { id: TD, ownerScope: "system", key: "distance", label: "Distance", currentVersion: { id: "tv-d", versionNumber: 1, unit: "m", canonicalParameters: null }, scopes: ["session", "component"], versionReady: true, notReadyCode: null },
      { id: TZ, ownerScope: "system", key: "hsr", label: "High-speed distance", currentVersion: { id: "tv-z", versionNumber: 1, unit: "m", canonicalParameters: { operator: ">=", lower: "25.2", upper: null, unit: "km/h" } }, scopes: ["session"], versionReady: true, notReadyCode: null },
    ],
    conversions: [
      { id: "cv1", fromUnit: "m", toUnit: "km", scale: "0.001", scaleDivisor: "1", offset: "0", evidenceRef: "docs/x.md#a", seeded: true },
      { id: "cv2", fromUnit: "km/h", toUnit: "m/s", scale: "1", scaleDivisor: "3.6", offset: "0", evidenceRef: "docs/x.md#b", seeded: true },
      { id: "cv3", fromUnit: "m/s", toUnit: "km/h", scale: "3.6", scaleDivisor: "1", offset: "0", evidenceRef: "docs/x.md#c", seeded: true },
    ],
    mappings: [
      { id: M1, ownerScope: "system", sourceMetric: { id: FA, key: "athlete_session.total_distance", apiFamily: "rest_v1", label: "Total distance" }, metricDefinitionId: TD,
        target: { key: "distance", label: "Distance", truncated: false }, createdAt: "2026-10-30T10:00:00Z",
        versions: [
          ver({ id: V2, versionNumber: 2, status: "needs_review", metricDefinitionVersionId: "tv-d", parameterFingerprint: "fp-a" }),
          ver({ id: V1, versionNumber: 1, status: "active", metricDefinitionVersionId: "tv-d", parameterFingerprint: "fp-a" }),
        ] },
    ],
    activations: [
      act({ id: id("ac000000", 1), versionId: V1, bindingId: B1, teamId: TEAM1, requirement: "required" }),
      act({ id: id("ac000000", 2), versionId: V1, bindingId: B3, teamId: TEAM3, requirement: "optional", bindingState: "ended" }),
    ],
    org: { clubs: [{ id: CLUB, name: "FK Borac" }, { id: CLUB2, name: "FK Drina" }],
      teams: [{ id: TEAM1, name: "First team", club_id: CLUB, club_name: "FK Borac" }, { id: TEAM2, name: "U19", club_id: CLUB, club_name: "FK Borac" }, { id: TEAM3, name: "U17", club_id: CLUB, club_name: "FK Borac" }],
      athletes: [{ id: "x", first_name: "Secret", last_name: "Athlete" }], users: [{ id: "u", email: "secret@example.com" }], joinApplications: [{ id: "j" }] },
    connections: { [CLUB]: [{ id: CONN, hostLabel: "GPEXE server3", accountLabel: "Borac account", boundTeams: [
      { bindingId: B1, teamId: TEAM1, teamName: "First team", sourceTeamId: "980", state: "active", teamActive: true },
      { bindingId: B2, teamId: TEAM2, teamName: "U19", sourceTeamId: "981", state: "active", teamActive: true },
    ] }] },
    candidates: { [TEAM1]: [
      cand({ id: CAND1, label: "Training 05.10", approvalBlockers: ["import_switch_off"], status: "pending" }),
      cand({ id: CAND2, label: "Training 06.10", approvalBlockers: ["import_switch_off", "not_confirmed_for_import"], status: "pending" }),
      cand({ id: CAND3, label: "Match 04.10", approvalBlockers: ["import_switch_off", "superseded_by_newer_data"], status: "superseded" }),
    ] },
    writes: new Map(),
  };
}
function ver(over) {
  return { mappingId: M1, sourceRevisionId: RA, sourceUnit: "m", targetUnit: "m", scale: "1", scaleDivisor: "1", offset: "0", parameterKind: "none",
    sourceParameters: null, appliesToSession: true, appliesToDrill: true, conversionNote: null, createdAt: "2026-10-30T10:00:00Z", ...over };
}
function act(over) {
  return { mappingId: M1, bindingState: "active", appliesToSession: true, appliesToDrill: true, basis: "platform_admin", activatedAt: "2026-10-31T10:00:00Z", endedAt: null, endReason: null, ...over };
}
function cand(over) {
  return { gpexeTeamSessionId: "1", sessionStartedAt: "2026-10-05T08:00:00Z", snapshot: { available: true, reason: null }, ...over };
}
const summary = (m) => {
  const active = m.versions.find((v) => v.status === "active");
  const counts = { draft: 0, needs_review: 0, active: 0, disabled: 0 };
  for (const v of m.versions) counts[v.status] += 1;
  return { id: m.id, ownerScope: m.ownerScope, sourceMetric: m.sourceMetric, metricDefinitionId: m.metricDefinitionId, target: m.target, createdAt: m.createdAt,
    latestVersion: m.versions[0] ? { id: m.versions[0].id, versionNumber: m.versions[0].versionNumber, status: m.versions[0].status } : null,
    activeVersionId: active?.id || null, versionCounts: counts };
};
const ok = (body, status = 200) => ({ status, body });
// The request-key contract of every write: a replay answers the saved answer;
// the same key with another body is request_key_reused.
function keyed(call, make) {
  const prior = db.writes.get(call.body?.requestKey);
  if (prior) return prior.rawBody === call.rawBody ? { ...prior.answer, body: { ...prior.answer.body, replayed: true } } : ok({ error: "request_key_reused" }, 409);
  const answer = make();
  if (answer.status < 300) db.writes.set(call.body.requestKey, { rawBody: call.rawBody, answer });
  return answer;
}
function route(call) {
  for (const o of overrides) { const r = o(call); if (r) return r; }
  const url = new URL(call.url, "http://x");
  const p = url.pathname;
  if (call.method === "GET") {
    if (p === `${B}/fields`) return ok({ fields: db.fields });
    if (p === `${B}/targets`) return ok({ targets: db.targets });
    if (p === `${B}/conversions`) return ok({ conversions: db.conversions, nextCursor: null });
    if (p === `${B}/mappings`) return ok({ mappings: db.mappings.map(summary), nextCursor: null });
    const m = p.match(/^\/api\/training-load\/sources\/metrics\/mappings\/([^/]+)$/);
    if (m) { const mapping = db.mappings.find((x) => x.id === m[1]); return mapping ? ok({ mapping, nextCursor: null }) : ok({ error: "notFound" }, 404); }
    if (p === `${B}/activations`) {
      const q = url.searchParams;
      const rows = db.activations.filter((a) => (!q.get("versionId") || a.versionId === q.get("versionId")) && (!q.get("bindingId") || a.bindingId === q.get("bindingId"))
        && (q.get("state") === "all" || (q.get("state") === "open" ? !a.endedAt : a.endedAt)));
      return ok({ activations: rows, nextCursor: null });
    }
    if (p === "/api/organization") return ok(db.org);
    if (p === "/api/training-load/sources/gpexe/connections") return ok({ connections: db.connections[url.searchParams.get("clubId")] || [] });
    const c = p.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)\/candidates$/);
    if (c) return ok({ candidates: db.candidates[c[1]] || [], importSwitch: {} });
    const pv = p.match(/\/versions\/([^/]+)\/preview$/);
    if (pv) return ok({ preview: { candidateId: url.searchParams.get("candidateId"), versionId: pv[1], sourceUnit: "m", targetUnit: "m", minimumAthletes: 3,
      levels: { session: { athletesWithValue: 12, min: "3100", max: "7400.5", minCanonical: "3100", maxCanonical: "7400.5" }, drill: { athletesWithValue: 2, min: null, max: null, minCanonical: null, maxCanonical: null } } } });
  }
  if (call.method === "POST") {
    if (p === `${B}/mappings`) return keyed(call, () => {
      const mapping = { id: M2, ownerScope: "system", sourceMetric: { id: call.body.sourceMetricId, label: "Total distance" }, metricDefinitionId: call.body.metricDefinitionId, target: { label: "Distance (km)" }, versions: [] };
      db.mappings.push(mapping);
      return ok({ mapping: summary(mapping), replayed: false }, 201);
    });
    const v = p.match(/\/mappings\/([^/]+)\/versions$/);
    if (v) return keyed(call, () => {
      const mapping = db.mappings.find((x) => x.id === v[1]);
      const version = ver({ id: V3, mappingId: v[1], versionNumber: mapping.versions.length + 1, status: "draft", sourceRevisionId: call.body.sourceRevisionId });
      mapping.versions.unshift(version);
      return ok({ version, replayed: false }, 201);
    });
    if (/\/(submit|activate|disable)$/.test(p)) return keyed(call, () => ok({ version: {}, replaced: null, activationsEnded: 0, activations: [], replayed: false }));
    if (p === `${B}/activations`) return keyed(call, () => ok({ activations: call.body.bindings.map((b) => act({ versionId: call.body.versionId, ...b })), replayed: false }, 201));
    if (/\/activations\/[^/]+\/end$/.test(p)) return keyed(call, () => ok({ activation: {}, replayed: false }));
  }
  return ok({ error: "notFound" }, 404);
}

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderMappingsHtml(); };
const $ = (selector) => content.querySelector(selector);
const $$ = (selector) => [...content.querySelectorAll(selector)];
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((c) => c.method === "POST");
const gets = () => calls.filter((c) => c.method === "GET").map((c) => c.url);
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await actions.handleMappingsAction(element, { render });
}
// Wait for the input handler's reads (it is not awaited by app.js).
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function input(selector, value) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  if (element.type === "checkbox" || element.type === "radio") element.checked = value; else element.value = value;
  actions.handleMappingsInput(element, { render });
  for (let i = 0; i < 6; i += 1) await settle();
  render();
}
const asPlatform = () => { state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform" }, availableWorkspaces: [{ type: "platform" }] }; };
const asClub = (alsoPlatform = false) => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac" },
    availableWorkspaces: [...(alsoPlatform ? [{ type: "platform" }] : []), { type: "club", scopeId: CLUB }] };
};
async function open(view = "list") {
  state.activeTab = "training-load";
  state.trainingLoad.section = "mappings";
  await actions.loadMappingsSection(render);
  if (view === "detail") await click(`[data-action="metric-mappings-open"][data-mapping-id="${M1}"]`);
  render();
}

beforeEach(() => {
  freshDb();
  overrides = [];
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  actions.resetMappings();
  asPlatform();
});

test("1. who is offered the screen: the platform and a club workspace, never a team workspace; a 404 is a neutral sentence", async () => {
  assert.equal(trainingLoadTopLevelSpace("mappings"), "dataConfig");
  assert.ok(data.mappingsContext());
  asClub();
  assert.equal(data.mappingsContext().owner, "club");
  assert.equal(data.mappingsContext().isPlatformAdmin, false);
  asClub(true);
  assert.equal(data.mappingsContext().isPlatformAdmin, true);
  state.currentUser = { id: "u", activeWorkspace: { type: "team", scopeId: TEAM1, clubId: CLUB, label: "First team" } };
  assert.equal(data.mappingsContext(), null);
  render();
  assert.match(text(), /available to administrators in the platform workspace and in a club workspace/);
  const home = renderDataConfigHomeHtml(variablesState(), { view: "coach" });
  assert.doesNotMatch(home, /Mappings/);
  asPlatform();
  overrides.push((c) => (c.url.startsWith(`${B}/mappings`) ? ok({ error: "notFound" }, 404) : null));
  await open();
  assert.match(text(), /Mappings are not available in this workspace\./);
});

test("2. the start screen card counts the section's own first page, with More than N when a page follows", async () => {
  overrides.push((c) => (c.url === `${B}/mappings` ? ok({ mappings: db.mappings.map(summary), nextCursor: "next" }) : null));
  await actions.ensureMappingsList(() => {});
  const home = renderDataConfigHomeHtml(variablesState(), { owner: "system", view: "admin" });
  assert.match(home, /data-section="mappings"/);
  assert.match(home, /More than 1 mappings/);
  assert.equal(gets().filter((u) => u.startsWith(`${B}/mappings`)).length, 1);
});

test("3. step 1: a field is choosable only when readable and its unit is confirmed; every other field stays listed with its reason", async () => {
  await open();
  await click('[data-action="metric-mappings-new"]');
  render();
  assert.match(text(), /Step 1 of 4/);
  const row = (fid) => $(`[data-action="metric-mappings-flow-field"][data-field-id="${fid}"]`);
  assert.equal(row(FA).getAttribute("aria-disabled"), null);
  assert.equal(row(FN).getAttribute("aria-disabled"), "true");
  assert.match(row(FN).textContent, /OptiMove cannot read this field yet\./);
  assert.match(row(FU).textContent, /Its unit is not confirmed yet\./);
  // A draft revision with a confirmed unit: choosable, with the meaning note.
  assert.equal(row(FZ).getAttribute("aria-disabled"), null);
  assert.match(row(FZ).textContent, /it can be activated only once the field's meaning is confirmed/);
  // A forged click on a field that is not choosable changes nothing.
  await actions.handleMappingsAction(row(FN), { render });
  assert.equal(actions.flowFacts().field, null);
  assert.equal(data.mappingsState().flow.step, 1);
});

test("4. no field ready: the empty state names the next step (a link for the platform, a sentence for a club)", async () => {
  db.fields = db.fields.map((f) => ({ ...f, extractorAvailable: false }));
  db.mappings = [];
  await open();
  assert.match(text(), /Confirm a field's unit first in Source fields/);
  assert.ok($('[data-action="training-load-section"][data-section="source-fields"]'));
  actions.resetMappings();
  asClub();
  await open();
  assert.match(text(), /A platform administrator confirms a field's unit in the platform workspace first\./);
});

test("5. step 2: the same unit first, then a conversion; a variable that cannot work is not choosable, with its reason", async () => {
  await open();
  await click('[data-action="metric-mappings-new"]');
  render();
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  render();
  const order = $$('[data-action="metric-mappings-flow-target"]').map((b) => b.dataset.targetId);
  assert.deepEqual(order.slice(0, 2), [TD, TK]);
  const t = (tid) => $(`[data-action="metric-mappings-flow-target"][data-target-id="${tid}"]`);
  assert.match(t(TD).textContent, /Same unit/);
  assert.match(t(TK).textContent, /Converted from m/);
  assert.match(t(TX).textContent, /There is no conversion from m to min yet\./);
  assert.match(t(TZ).textContent, /Its condition does not match this field's\./);
  assert.match(text(), /Unit conversions cannot be added on this screen yet\./);
  // Another mapping of this field already has an active version.
  assert.match(text(), /This field already fills Distance\. Only one of them can be active at a time\./);
});

test("6. exact decimals: the variable's bound in the field's unit, or none when it has no exact value", () => {
  const kmh2ms = db?.conversions?.[2] || { scale: "3.6", scaleDivisor: "1", offset: "0" };
  assert.equal(data.sourceValueFor("25.2", kmh2ms), "7");
  assert.equal(data.sourceValueFor("20", kmh2ms), null);
  assert.equal(data.sourceValueFor("5", null), "5");
  assert.equal(data.decText(data.ratOf("-0.5")), "-0.5");
  assert.equal(data.decText(data.ratOf("1234567890123")), null);
  // The zone variable: choosable for the zone field, with the value shown in m/s.
  const status = data.targetStatus(db.targets[3], db.fields[1].revisions[0], db.conversions);
  assert.equal(status.choosable, true);
  const twenty = { ...db.targets[3], currentVersion: { ...db.targets[3].currentVersion, canonicalParameters: { operator: ">=", lower: "20", upper: null, unit: "km/h" } } };
  assert.equal(data.targetStatus(twenty, db.fields[1].revisions[0], db.conversions).reason, "Its bound has no exact value in this field's unit.");
});

test("7. the flow: a draft through a conversion and a zone field's bound, sent as the server expects (never an owner, actor or basis)", async () => {
  await open();
  await click('[data-action="metric-mappings-new"]');
  render();
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FZ}"]`);
  render();
  await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TZ}"]`);
  render();
  assert.match(text(), /The variable's 25\.2 km\/h is 7 m\/s\./);
  assert.match(text(), /Session only/);
  await click('[data-action="metric-mappings-flow-review"]');
  render();
  assert.match(text(), /Check the marked fields\./);
  assert.equal($('[data-mm-field="flow.lower"]').getAttribute("aria-invalid"), "true");
  await input('[data-mm-field="flow.lower"]', "7");
  await click('[data-action="metric-mappings-flow-review"]');
  render();
  assert.match(text(), /Review the draft/);
  await click('[data-action="metric-mappings-flow-save"]');
  const [create, draft] = posts();
  assert.equal(create.url, `${B}/mappings`);
  assert.deepEqual(Object.keys(create.body).sort(), ["metricDefinitionId", "requestKey", "sourceMetricId"]);
  assert.equal(draft.url, `${B}/mappings/${M2}/versions`);
  assert.deepEqual(draft.body.sourceParameters, { lower: "7", upper: null });
  assert.equal(draft.body.appliesToSession, true);
  assert.equal(draft.body.appliesToDrill, false);
  assert.equal("conversionNote" in draft.body, false);
  assert.notEqual(draft.body.requestKey, create.body.requestKey);
  for (const body of [create.body, draft.body]) for (const k of ["owner", "ownerScope", "actor", "basis"]) assert.equal(k in body, false);
  assert.match(text(), /The draft is saved\./);
});

test("8. a lost answer on each write is Result not confirmed; Check result sends the very same request", async () => {
  for (const lost of [{ throwNetworkError: true }, ok({ error: "outcome_unknown", requestKey: "k" }, 503), { status: 502, text: "bad gateway", body: null }]) {
    freshDb();
    actions.resetMappings();
    calls.length = 0;
    let first = true;
    overrides = [(c) => (c.method === "POST" && c.url === `${B}/mappings` && first ? ((first = false), lost) : null)];
    await open();
    await click('[data-action="metric-mappings-new"]');
    render();
    await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
    await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TK}"]`);
    render();
    await input('[data-mm-field="flow.conversionNote"]', "GPEXE gives metres; the variable is in km.");
    await input('[data-mm-field="flow.session"]', true);
    await click('[data-action="metric-mappings-flow-review"]');
    render();
    await click('[data-action="metric-mappings-flow-save"]');
    render();
    assert.match(text(), /Result not confirmed\./);
    assert.equal(posts().length, 1);
    await click('[data-action="metric-mappings-check-result"]');
    const [a, b, draft] = posts();
    assert.equal(b.rawBody, a.rawBody, "the check sends the same body and key");
    assert.equal(draft.body.conversionNote, "GPEXE gives metres; the variable is in km.");
    assert.match(text(), /The draft is saved\./);
  }
});

test("9. mapping_exists continues with the existing mapping; a refused draft leaves the mapping with the sentence", async () => {
  overrides.push((c) => (c.method === "POST" && c.url === `${B}/mappings` ? ok({ error: "mapping_exists", current: { mappingId: M1 } }, 409) : null));
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/versions") ? ok({ error: "unit_not_proven" }, 409) : null));
  const saved = db.mappings;
  db.mappings = [];
  await open();
  db.mappings = saved;
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TD}"]`);
  render();
  await input('[data-mm-field="flow.drill"]', true);
  await click('[data-action="metric-mappings-flow-review"]');
  render();
  await click('[data-action="metric-mappings-flow-save"]');
  render();
  assert.equal(posts()[1].url, `${B}/mappings/${M1}/versions`);
  assert.match(text(), /The mapping is saved, but its draft was not: The field's unit \(or its bound\) is not confirmed yet\. Use New version to try again\./);
});

test("10. the detail: one primary act by state, the acts each caller may use, and the club's waiting-version sentences", async () => {
  await open("detail");
  const primary = $$(".data-sources-primary").map((b) => b.textContent.trim());
  assert.ok(primary.includes("Replace version 1"), primary.join("|"));
  assert.ok($(`[data-action="metric-mappings-disable-open"][data-version-id="${V1}"]`));
  assert.match(text(), /Activating approves a version as the mapping's current one\./);
  // A club admin on a system mapping: no activate, the platform sentence.
  actions.resetMappings();
  asClub();
  await open("detail");
  assert.equal($('[data-action="metric-mappings-activate-open"]'), null);
  assert.equal($('[data-action="metric-mappings-disable-open"]'), null);
  assert.match(text(), /A platform administrator activates system mappings in the platform workspace\./);
  assert.equal($('[data-action="metric-mappings-new-version"]'), null);
  // A club's own mapping, read by its admin.
  db.mappings[0].ownerScope = "club";
  actions.resetMappings();
  await open("detail");
  assert.match(text(), /Ask a platform administrator who also administers FK Borac to activate it in this workspace\./);
  assert.ok($('[data-action="metric-mappings-new-version"]'));
  // A platform admin in a club workspace on a system version.
  db.mappings[0].ownerScope = "system";
  actions.resetMappings();
  asClub(true);
  await open("detail");
  assert.match(text(), /Activate it in the platform workspace\./);
});

test("11. replace: every page of the teams switched off, named, the ended link and the archived-club sentence; each kept team keeps its requirement", async () => {
  db.activations.push(act({ id: id("ac000000", 3), versionId: V1, bindingId: B2, teamId: TEAM2, requirement: "optional" }));
  let page = 0;
  overrides.push((c) => {
    if (!c.url.startsWith(`${B}/activations?`) || !c.url.includes(`versionId=${V1}`) || !c.url.includes("state=open")) return null;
    const open = db.activations.filter((a) => a.versionId === V1 && !a.endedAt);
    if (!c.url.includes("cursor=")) { page += 1; return ok({ activations: open.slice(0, 1), nextCursor: "p2" }); }
    return ok({ activations: open.slice(1), nextCursor: null });
  });
  db.activations[1].endedAt = null; // the ended link is still open on the version
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  render();
  assert.match(text(), /No change from version 1 in the unit, the levels or the bound\./);
  // Two of the three can be kept (the third's link ended): the lead says so.
  assert.match(text(), /These 3 teams use version 1\. 2 of them move to version 2 in the same step; the other one is switched off:/);
  // Keep is the first control of the list, above the teams it governs.
  const panelHtml = $(".metric-mappings-panel").innerHTML;
  assert.ok(panelHtml.indexOf('data-mm-field="keep"') < panelHtml.indexOf('data-mm-field="keptRequirement"'));
  await input('[data-mm-field="keep"]', false);
  assert.match(text(), /It switches off these 3 teams:/);
  assert.equal($('[data-mm-field="keptRequirement"]'), null);
  await input('[data-mm-field="keep"]', true);
  assert.match(text(), /on version 2 as/);
  assert.match(text(), /First team — linked to GPEXE team 980/);
  assert.match(text(), /U17 — no longer linked to GPEXE/);
  assert.match(text(), /Teams of archived clubs that use this version are switched off too; they are not listed\./);
  assert.match(text(), /is switched off and not kept/);
  assert.equal($(`[data-mm-field="keptRequirement"][data-binding-id="${B2}"]`).value, "optional");
  assert.equal($(`[data-mm-field="keptRequirement"][data-binding-id="${B1}"]`).value, "required");
  await input('[data-mm-field="reason"]', "Version 2 uses the confirmed unit.");
  await click('[data-action="metric-mappings-review"]');
  render();
  assert.match(text(), /Replace and keep 2 teams/);
  assert.match(text(), /GPEXE server3/);
  await click('[data-action="metric-mappings-confirm"]');
  const post = posts().at(-1);
  assert.equal(post.url, `${B}/mappings/${M1}/versions/${V2}/activate`);
  assert.equal(post.body.expectedActiveVersionId, V1);
  assert.equal(post.body.reason, "Version 2 uses the confirmed unit.");
  assert.equal(post.body.activationReason, post.body.reason);
  assert.deepEqual(post.body.activations.map((a) => `${a.bindingId}:${a.requirement}`).sort(), [`${B1}:required`, `${B2}:optional`].sort());
});

test("12. the count is read again at the button; activationsEnded above the listed count is named", async () => {
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  await input('[data-mm-field="reason"]', "Replace it.");
  await click('[data-action="metric-mappings-review"]');
  db.activations.push(act({ id: id("ac000000", 9), versionId: V1, bindingId: B2, teamId: TEAM2, requirement: "optional" }));
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.equal(posts().length, 0);
  assert.match(text(), /The teams of the active version changed meanwhile\. Check the list again\./);
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/activate") ? ok({ version: {}, replaced: V1, activationsEnded: 5, activations: [] }) : null));
  await click('[data-action="metric-mappings-review"]');
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.match(text(), /5 teams were switched off; the list showed fewer\./);
});

test("13. switch on: the club's teams by name, the ones that cannot be chosen, every team of a connection, one requirement, the review card", async () => {
  // U19 already gets this field through another version of another mapping.
  db.mappings.push({ id: id("e0e0e0e0", 7), ownerScope: "system", sourceMetric: { id: FA }, metricDefinitionId: TK, versions: [ver({ id: id("b0b0b0b0", 7), status: "active", parameterFingerprint: "fp-a" })] });
  db.activations.push(act({ id: id("ac000000", 7), mappingId: id("e0e0e0e0", 7), versionId: id("b0b0b0b0", 7), bindingId: B2, teamId: TEAM2 }));
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  render();
  await input('[data-mm-field="club"]', CLUB);
  const row = (bid) => $(`[data-mm-field="team"][data-binding-id="${bid}"]`).closest(".metric-mappings-team-row").textContent.replace(/\s+/g, " ");
  assert.match(row(B1), /Already on\./);
  assert.match(row(B2), /Already gets this field\./);
  await click(`[data-action="metric-mappings-every-team"][data-connection-id="${CONN}"]`);
  assert.deepEqual(Object.keys(data.mappingsState().panel.chooser.selected), []);
  // A team that can be chosen: a third team.
  db.connections[CLUB][0].boundTeams.push({ bindingId: id("b1b1b1b1", 4), teamId: id("70707070", 4), teamName: "U15 <b>bold</b>‮", sourceTeamId: "982", state: "active", teamActive: true },
    { bindingId: id("b1b1b1b1", 5), teamId: id("70707070", 5), teamName: "Old team", sourceTeamId: "983", state: "active", teamActive: false });
  data.mappingsState().connections = {};
  await input('[data-mm-field="club"]', CLUB);
  assert.match(row(id("b1b1b1b1", 5)), /This team is archived\./);
  // A name in a team row is cleaned too: a bidi control never reorders the GPEXE link beside it.
  assert.match(row(id("b1b1b1b1", 4)), /U15 <b>bold<\/b> — linked to GPEXE team 982/);
  assert.doesNotMatch($(".metric-mappings-panel").innerHTML, /‮|<b>bold/);
  await click(`[data-action="metric-mappings-every-team"][data-connection-id="${CONN}"]`);
  render();
  assert.deepEqual(Object.keys(data.mappingsState().panel.chooser.selected), [id("b1b1b1b1", 4)]);
  await input('[data-mm-field="reason"]', "First import.");
  await click('[data-action="metric-mappings-review"]');
  render();
  assert.match(text(), /Choose Required or Optional\./);
  assert.match(text(), /Required: if GPEXE has no value for an athlete the import takes in, only that value is left out for that athlete and named “required value missing”/);
  assert.doesNotMatch(text(), /the whole session is not imported/);
  await input('[data-mm-field="requirement"][value="required"]', true);
  await click('[data-action="metric-mappings-review"]');
  render();
  const card = $(".metric-mappings-review-card").innerHTML;
  assert.match(card, /GPEXE server3/);
  assert.match(card, /“Distance” from “Total distance”, version 1/);
  assert.match(card, /linked to GPEXE team 982/);
  assert.doesNotMatch(card, /<b>bold<\/b>/);
  assert.doesNotMatch(card, /‮/);
  await click('[data-action="metric-mappings-confirm"]');
  const post = posts().at(-1);
  assert.equal(post.url, `${B}/activations`);
  assert.deepEqual(post.body.bindings, [{ bindingId: id("b1b1b1b1", 4), requirement: "required" }]);
  assert.deepEqual(Object.keys(post.body).sort(), ["bindings", "mappingId", "reason", "requestKey", "versionId"]);
  render();
  assert.match(text(), /Switched on\./);
  assert.doesNotMatch(text(), /Imports do not use mappings|nothing changes in imports/);
});

test("D31: no screen says that imports do not use mappings, and Required / Optional say what an import does with a missing value (C110 form B)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = fs.readdirSync(dir).filter((name) => name.endsWith(".js"));
  assert.ok(sources.includes("metric-mappings-actions.js") && sources.includes("gpexe-import-view.js"), "the scan sees the frontend modules");
  for (const name of sources) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    assert.doesNotMatch(source, /do not use mappings|nothing changes in imports until/i, name);
  }
  assert.match(data.REQUIREMENT_MEANING, /only that value is left out for that athlete and named “required value missing”; the session and the athlete's other values are still imported/);
  assert.match(data.REQUIREMENT_MEANING, /Optional: a missing value is simply left out\./);
  assert.doesNotMatch(data.REQUIREMENT_MEANING, /whole session is not imported|When imports use this mapping/);
});

test("14. a batch refused for one team names it (never its id) and offers the others", async () => {
  db.connections[CLUB][0].boundTeams.push({ bindingId: id("b1b1b1b1", 4), teamId: id("70707070", 4), teamName: "U15", sourceTeamId: "982", state: "active", teamActive: true });
  db.activations = db.activations.filter((a) => a.bindingId !== B1);
  let first = true;
  overrides.push((c) => (c.method === "POST" && c.url === `${B}/activations` && first ? ((first = false), ok({ error: "variable_taken_on_binding", current: { bindingId: B1 } }, 409)) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="club"]', CLUB);
  await click(`[data-action="metric-mappings-every-team"][data-connection-id="${CONN}"]`);
  await input('[data-mm-field="requirement"][value="optional"]', true);
  await input('[data-mm-field="reason"]', "Start.");
  await click('[data-action="metric-mappings-review"]');
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.match(text(), /“First team” already has this variable at this level, so nothing was saved\./);
  assert.doesNotMatch(text(), new RegExp(B1));
  assert.match($('[data-action="metric-mappings-confirm"]').textContent, /Switch on for the other 2/);
  await click('[data-action="metric-mappings-confirm"]');
  const [firstPost, second] = posts();
  assert.notEqual(second.body.requestKey, firstPost.body.requestKey);
  assert.deepEqual(second.body.bindings.map((b) => b.bindingId).sort(), [B2, id("b1b1b1b1", 4)].sort());
});

test("15. switch off: one confirmation naming the team, its link and the version, then the body", async () => {
  await open("detail");
  await click(`[data-action="metric-mappings-switch-off-open"][data-activation-id="${id("ac000000", 1)}"]`);
  await input('[data-mm-field="reason"]', "Not this season.");
  await click('[data-action="metric-mappings-review"]');
  assert.match(confirmQuestions.at(-1), /Switch off version 1 of "Distance" for "First team" \(linked to GPEXE team 980\)\?/);
  const post = posts().at(-1);
  assert.equal(post.url, `${B}/activations/${id("ac000000", 1)}/end`);
  assert.deepEqual(Object.keys(post.body).sort(), ["expectedState", "reason", "requestKey"]);
  assert.equal(post.body.expectedState, "open");
});

test("16. the preview: the fail-closed mark (no blockers, the word, newer data, imported), the re-read through the list, fewer than 3", async () => {
  assert.equal(data.notForImport({ status: "pending" }), true, "no blockers array counts");
  assert.equal(data.notForImport({ status: "pending", approvalBlockers: ["import_switch_off"] }), false);
  assert.equal(data.notForImport({ status: "superseded", approvalBlockers: ["superseded_by_newer_data"] }), true);
  assert.equal(data.notForImportBadge({ status: "imported" }), "Already imported");
  await open("detail");
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="previewClub"]', CLUB);
  await input('[data-mm-field="previewTeam"]', TEAM1);
  const label = (cid) => $(`[data-mm-field="previewCandidate"][value="${cid}"]`).closest("label").textContent;
  assert.doesNotMatch(label(CAND1), /Not confirmed for import/);
  assert.match(label(CAND2), /Not confirmed for import/);
  assert.match(label(CAND3), /Not confirmed for import/);
  // The session is replaced by newer data meanwhile: the re-read marks it.
  await input(`[data-mm-field="previewCandidate"][value="${CAND1}"]`, true);
  db.candidates[TEAM1][0] = { ...db.candidates[TEAM1][0], status: "superseded", approvalBlockers: ["import_switch_off", "superseded_by_newer_data"] };
  await click('[data-action="metric-mappings-preview-run"]');
  render();
  const result = $(".metric-mappings-panel .metric-mappings-review-card").textContent.replace(/\s+/g, " ");
  assert.match(result, /Not confirmed for import This session cannot be imported as it stands\./);
  assert.match(result, /12 athletes have a value/);
  assert.match(result, /Fewer than 3 athletes have a value, so no range is shown\./);
  assert.ok(gets().some((u) => u.endsWith(`/teams/${TEAM1}/candidates?includeSuperseded=true`)));
  assert.equal(gets().some((u) => new RegExp(`/candidates/${CAND1}`).test(u)), false, "never the single-session route");
  assert.doesNotMatch(JSON.stringify(data.mappingsState()), /Secret|secret@example\.com|joinApplications/);
});

test("17. a failed re-read keeps the list's mark and says so; a preview refusal is a sentence with the code under Technical details", async () => {
  await open("detail");
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="previewClub"]', CLUB);
  await input('[data-mm-field="previewTeam"]', TEAM1);
  await input(`[data-mm-field="previewCandidate"][value="${CAND2}"]`, true);
  overrides.push((c) => (c.url.includes("includeSuperseded=true") ? { status: 500, body: { error: "internal_error" } } : null));
  await click('[data-action="metric-mappings-preview-run"]');
  render();
  assert.match(text(), /Could not be checked again\./);
  assert.match(text(), /Not confirmed for import This session cannot be imported as it stands/);
  overrides.unshift((c) => (c.url.includes("/preview?") ? ok({ error: "snapshot_expired", current: { reason: "purged" } }, 409) : null));
  await click('[data-action="metric-mappings-preview-run"]');
  render();
  assert.match(text(), /The saved session is no longer available\. Find it again in Imports\./);
  assert.match($(".metric-mappings-panel details").textContent, /snapshot_expired/);
});

test("18. refusals: a stale mapping is read again with its sentence; an unknown 4xx has the fallback; a 404 on a write never says nothing was saved", async () => {
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/submit") ? ok({ error: "version_not_draft", current: { status: "needs_review" } }, 409) : null));
  db.mappings[0].versions.unshift(ver({ id: V3, versionNumber: 3, status: "draft", metricDefinitionVersionId: "tv-d" }));
  await open("detail");
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(confirmQuestions.at(-1), /Submit version 3 of "Distance" from "Total distance" for review\?/);
  assert.match(text(), /This version changed meanwhile\./);
  overrides = [(c) => (c.method === "POST" && c.url.endsWith("/submit") ? ok({ error: "something_new" }, 409) : null)];
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /It was not saved: the server refused it\./);
  assert.match($("details.data-sources-tech").textContent, /something_new/);
  data.mappingsState().write = null;
  overrides = [(c) => (c.method === "POST" && c.url.endsWith("/submit") ? ok({ error: "notFound" }, 404) : null)];
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /Whether it was saved is not known: open the mapping again to see\./);
  assert.equal(data.refusalText("activate", { code: "canonical_version_changed", status: 409 }), "The variable has a newer version: make a new version.");
  assert.equal(data.refusalText("switchOff", { code: "notFound", status: 404 }), "It is not available in this workspace now. Whether it was saved is not known: open the version's teams again to see.");
});

test("19. the guards: a write in flight, a result not confirmed or unsaved choices are asked about; a workspace switch resets the section", async () => {
  await open();
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  confirmAnswer = false;
  assert.equal(actions.mappingsMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /Discard the choices you have not saved\?/);
  assert.equal(actions.mappingsUnloadShouldWarn(), true);
  assert.equal(confirmLeaveTrainingLoad("athletes"), false);
  data.mappingsState().write = { unconfirmed: true };
  actions.mappingsMayBeLeft();
  assert.match(confirmQuestions.at(-1), /The result of the last change is not known\./);
  confirmAnswer = true;
  resetTrainingLoadForWorkspaceChange();
  assert.equal(data.mappingsState().flow, null);
  assert.equal(data.mappingsState().write, null);
  assert.notEqual(state.trainingLoad.section, "mappings");
});

test("20. the organization read keeps only the clubs' and teams' ids and names; names in a confirm are cleaned", () => {
  const facts = data.orgFacts(db.org);
  assert.deepEqual(Object.keys(facts), ["clubs", "teams"]);
  assert.doesNotMatch(JSON.stringify(facts), /Secret|secret@example/);
  assert.equal(data.cleanName("A‮B\u0007  C\n D"), "AB C D");
  assert.equal([...data.cleanName("x".repeat(200))].length, 80);
});

test("21. a failed clubs read is said in the switch-on chooser and in the preview, with Try again; the retry fills the club picker", async () => {
  let failOrg = true;
  overrides.push((c) => (c.url === "/api/organization" && failOrg ? ok({ error: "internal_error" }, 500) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  render();
  const panel = () => $(".metric-mappings-panel").textContent.replace(/\s+/g, " ");
  assert.match(panel(), /The clubs and teams could not be loaded\./);
  assert.equal($$('select[data-mm-field="club"] option').length, 1);
  failOrg = false;
  const orgReads = () => calls.filter((c) => c.url === "/api/organization").length;
  const before = orgReads();
  await click('[data-action="metric-mappings-org-reload"]');
  render();
  assert.doesNotMatch(panel(), /could not be loaded/);
  assert.deepEqual($$('select[data-mm-field="club"] option').map((o) => o.textContent), ["Choose a club...", "FK Borac", "FK Drina"]);
  assert.equal(orgReads(), before + 1);
  assert.equal(posts().length, 0);
  // The preview's club picker says the same while the read fails.
  await click('[data-action="metric-mappings-panel-close"]');
  actions.resetMappings();
  failOrg = true;
  await open("detail");
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  render();
  assert.match(panel(), /The clubs and teams could not be loaded\./);
  assert.ok($('[data-action="metric-mappings-org-reload"]'));
});

test("22. after a change the mapping is read again: until that read answers, every act and New version is off and a click sends nothing", async () => {
  db.mappings[0].versions.unshift(ver({ id: V3, versionNumber: 3, status: "draft", metricDefinitionVersionId: "tv-d" }));
  await open("detail");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holdNext = true;
  overrides.push((c) => {
    if (c.method === "GET" && c.url === `${B}/mappings/${M1}` && holdNext) {
      holdNext = false;
      return held.then(() => ok({ mapping: db.mappings[0], nextCursor: null }));
    }
    return null;
  });
  const submitted = click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  for (let i = 0; i < 6; i += 1) await settle();
  render();
  assert.match(text(), /Submitted for review\./);
  const acts = $$('.metric-variables-version button[data-action^="metric-mappings-"], [data-action="metric-mappings-new-version"], [data-action="metric-mappings-switch-off-open"]');
  assert.ok(acts.length >= 4);
  assert.ok(acts.every((b) => b.disabled), acts.filter((b) => !b.disabled).map((b) => b.dataset.action).join(","));
  const before = posts().length;
  await actions.handleMappingsAction($(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`), { render });
  await actions.handleMappingsAction($(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`), { render });
  assert.equal(posts().length, before);
  assert.equal(data.mappingsState().panel, null);
  release();
  await submitted;
  render();
  assert.ok($(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`).disabled === false);
});

test("23. every row of the refusal table (J16 section 8) has its own sentence; read-again codes close the form; the team codes name the team", () => {
  const rows = [
    ["create", ["target_scope_mismatch", "target_not_active"], "This variable cannot be used here now.", true],
    ["create", ["source_metric_retired"], "This field is retired.", true],
    ["draft", ["unit_not_proven", "parameters_not_proven"], "The field's unit (or its bound) is not confirmed yet.", false],
    ["draft", ["source_metric_unsupported", "parameters_unsupported"], "OptiMove cannot read this field with these settings.", false],
    ["draft", ["level_not_allowed"], "The field or the variable does not allow this level.", false],
    ["draft", ["conversion_unavailable", "bound_conversion_unavailable", "conversion_not_normal"], "There is no usable conversion between these units now.", false],
    ["draft", ["parameters_not_equivalent", "condition_description_unsupported"], "The bound does not match the variable's bound.", false],
    ["draft", ["canonical_not_numeric", "canonical_unit_missing", "canonical_unit_not_a_token", "target_not_active"], "This variable cannot be the target of a mapping now.", true],
    ["draft", ["revision_not_usable"], "The field changed; choose it again.", true],
    ["submit", ["version_not_draft", "revision_not_usable"], "This version changed meanwhile.", true],
    ["activate", ["version_not_submitted", "active_version_changed"], "This mapping changed meanwhile.", true],
    ["activate", ["revision_not_verified"], "The field's unit and meaning must be confirmed first.", false],
    ["activate", ["canonical_version_changed"], "The variable has a newer version: make a new version.", true],
    ["disable", ["version_status_changed"], "This version changed meanwhile.", true],
    ["switchOn", ["version_not_active", "field_retired"], "This version is no longer active.", true],
    ["switchOff", ["activation_not_open"], "This team was already switched off.", true],
  ];
  for (const [act, codes, sentence, readAgain] of rows) {
    for (const code of codes) {
      assert.equal(data.refusalText(act, { code, status: 409 }), sentence, `${act} ${code}`);
      assert.equal(data.READ_AGAIN.has(code), readAgain || ["target_not_active", "revision_not_usable"].includes(code), `${act} ${code} read again`);
    }
  }
  for (const code of ["target_not_active", "conversion_unavailable", "bound_conversion_unavailable", "level_not_allowed", "source_metric_unsupported", "parameters_unsupported"]) {
    assert.match(data.refusalText("activate", { code, status: 409 }), /^This version cannot be activated now: /, code);
  }
  assert.match(data.refusalText("activate", { code: "source_metric_target_taken", status: 409 }), /already fills .+\. Only one of them can be active at a time\./);
  assert.deepEqual([...data.TEAM_CODES].sort(), ["activation_exists", "binding_not_active", "binding_source_mismatch", "variable_taken_on_binding"]);
  for (const code of data.TEAM_CODES) assert.ok(data.TEAM_CODE_TEXT[code], code);
  for (const act of ["create", "draft", "submit", "activate", "disable", "switchOn", "switchOff"]) {
    assert.equal(data.refusalText(act, { code: "invalid_body", status: 400 }), "The screen sent something the server does not accept. Nothing was saved.");
    assert.equal(data.refusalText(act, { code: "invalid_query", status: 400 }), "The screen sent something the server does not accept. Nothing was saved.");
    assert.equal(data.refusalText(act, { code: "brand_new_code", status: 409 }), "It was not saved: the server refused it.");
  }
});

test("24. switch on: the same field with another fingerprint stays choosable, a drill-only row of the variable does not block a session-only version; a check loading or failed", async () => {
  // Version 1 fills the session level only.
  db.mappings[0].versions.find((v) => v.id === V1).appliesToDrill = false;
  const B4 = id("b1b1b1b1", 4), B5 = id("b1b1b1b1", 5), B6 = id("b1b1b1b1", 6), B7 = id("b1b1b1b1", 7);
  db.connections[CLUB][0].boundTeams.push(
    { bindingId: B4, teamId: id("70707070", 4), teamName: "U17", sourceTeamId: "984", state: "active", teamActive: true },
    { bindingId: B5, teamId: id("70707070", 5), teamName: "U15", sourceTeamId: "985", state: "active", teamActive: true },
    { bindingId: B6, teamId: id("70707070", 6), teamName: "U13", sourceTeamId: "986", state: "active", teamActive: true },
    { bindingId: B7, teamId: id("70707070", 7), teamName: "Women", sourceTeamId: "987", state: "active", teamActive: true },
  );
  // B2: the same field with another fingerprint into another variable (choosable).
  const MO = id("e0e0e0e0", 8), VO = id("b0b0b0b0", 8);
  db.mappings.push({ id: MO, ownerScope: "system", sourceMetric: { id: FA }, metricDefinitionId: TK, versions: [ver({ id: VO, mappingId: MO, status: "active", parameterFingerprint: "fp-b" })] });
  db.activations.push(act({ id: id("ac000000", 8), mappingId: MO, versionId: VO, bindingId: B2, teamId: TEAM2 }));
  // B4: the same variable at the drill level only (choosable for a session-only version).
  const MD = id("e0e0e0e0", 9), VD = id("b0b0b0b0", 9);
  db.mappings.push({ id: MD, ownerScope: "system", sourceMetric: { id: FU }, metricDefinitionId: TD, versions: [ver({ id: VD, mappingId: MD, status: "active", appliesToSession: false, appliesToDrill: true, parameterFingerprint: "fp-c" })] });
  db.activations.push(act({ id: id("ac000000", 10), mappingId: MD, versionId: VD, bindingId: B4, teamId: id("70707070", 4), appliesToSession: false }));
  // B7: the same variable at the session level (not choosable).
  const MS = id("e0e0e0e0", 10), VS = id("b0b0b0b0", 10);
  db.mappings.push({ id: MS, ownerScope: "system", sourceMetric: { id: FZ }, metricDefinitionId: TD, versions: [ver({ id: VS, mappingId: MS, status: "active", appliesToDrill: false, parameterFingerprint: "fp-d" })] });
  db.activations.push(act({ id: id("ac000000", 11), mappingId: MS, versionId: VS, bindingId: B7, teamId: id("70707070", 7) }));
  // B5's check never answers while the screen is looked at; B6's fails.
  let releaseB5;
  const heldB5 = new Promise((resolve) => { releaseB5 = resolve; });
  overrides.push((c) => {
    if (c.method !== "GET" || !c.url.startsWith(`${B}/activations?`)) return null;
    const q = new URL(c.url, "http://x").searchParams;
    if (q.get("bindingId") === B5) return heldB5.then(() => ok({ activations: [], nextCursor: null }));
    if (q.get("bindingId") === B6) return ok({ error: "internal_error" }, 500);
    return null;
  });
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  render();
  const choosing = actions.handleMappingsInput(Object.assign($('[data-mm-field="club"]'), { value: CLUB }), { render });
  assert.equal(choosing, true);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  const row = (bid) => $(`[data-mm-field="team"][data-binding-id="${bid}"]`).closest(".metric-mappings-team-row").textContent.replace(/\s+/g, " ");
  const off = (bid) => $(`[data-mm-field="team"][data-binding-id="${bid}"]`).disabled;
  assert.match(row(B5), /Checking…/);
  assert.equal(off(B5), true);
  releaseB5();
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  assert.equal(off(B2), false, row(B2));
  assert.doesNotMatch(row(B2), /Already/);
  assert.equal(off(B4), false, row(B4));
  assert.match(row(B7), /Already has this variable at this level\./);
  assert.equal(off(B7), true);
  assert.equal(off(B5), false, row(B5));
  assert.match(row(B6), /Could not be checked; the server decides\./);
  assert.equal(off(B6), false);
});

test("25. Every team of this connection checks at most 50 teams and says so", async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ bindingId: id("b2b2b2b2", i + 1), teamId: id("71717171", i + 1), teamName: `Team ${i + 1}`, sourceTeamId: String(2000 + i), state: "active", teamActive: true }));
  db.connections[CLUB][0].boundTeams = many;
  db.activations = [];
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  render();
  await input('[data-mm-field="club"]', CLUB);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  await click(`[data-action="metric-mappings-every-team"][data-connection-id="${CONN}"]`);
  render();
  assert.equal(Object.keys(data.mappingsState().panel.chooser.selected).length, 50);
  assert.match(text(), /Only the first 50 teams are checked: one change takes at most 50\./);
  assert.equal(posts().length, 0);
});

test("26. the teams a disable switches off: rows of two clubs with the same team name are told apart by their club", async () => {
  const TEAM4 = id("70707070", 4), B4 = id("b1b1b1b1", 4);
  db.org.teams.push({ id: TEAM4, name: "First team", club_id: CLUB2, club_name: "FK Drina" });
  db.activations.push(act({ id: id("ac000000", 12), versionId: V1, bindingId: B4, teamId: TEAM4, requirement: "optional" }));
  await open("detail");
  await click(`[data-action="metric-mappings-disable-open"][data-version-id="${V1}"]`);
  for (let i = 0; i < 6; i += 1) await settle();
  render();
  const rows = $$(".metric-mappings-panel .metric-mappings-team-row").map((r) => r.textContent.replace(/\s+/g, " ").trim());
  assert.ok(rows.some((r) => /^FK Borac · First team/.test(r)), rows.join(" | "));
  assert.ok(rows.some((r) => /^FK Drina · First team/.test(r)), rows.join(" | "));
  assert.match($(".metric-mappings-panel").textContent, /Teams of archived clubs that use this version are switched off too; they are not listed\./);
});

test("27. result_too_large on the fields or the variables is a sentence naming who can help, never an empty step", async () => {
  overrides.push((c) => (c.url === `${B}/fields` ? ok({ error: "result_too_large" }, 409) : null));
  await open();
  await click('[data-action="metric-mappings-new"]');
  render();
  assert.match(text(), /There are too many source fields to list here\. Ask a platform administrator\./);
  assert.ok($('[data-action="metric-mappings-refs-reload"]'));
  assert.equal($$('[data-action="metric-mappings-flow-field"]').length, 0);
  overrides = [(c) => (c.url === `${B}/targets` ? ok({ error: "result_too_large" }, 409) : null)];
  await click('[data-action="metric-mappings-refs-reload"]');
  render();
  assert.match(text(), /There are too many variables to list here\. Ask a platform administrator\./);
});

test("28. source_metric_target_taken names the variable the field already fills (same owner only); a club's flow is not warned about a system mapping", async () => {
  const M7 = id("e0e0e0e0", 11);
  db.mappings.push({ id: M7, ownerScope: "system", sourceMetric: { id: FA, label: "Total distance" }, metricDefinitionId: TK, target: { key: "distance_km", label: "Distance (km)" },
    versions: [ver({ id: id("b0b0b0b0", 11), mappingId: M7, status: "active", parameterFingerprint: "fp-a" })] });
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/activate") ? ok({ error: "source_metric_target_taken" }, 409) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  await input('[data-mm-field="reason"]', "Replace it.");
  await click('[data-action="metric-mappings-review"]');
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.match(text(), /This field already fills “Distance \(km\)”\. Only one of them can be active at a time\./);
  // A club's new mapping of the same field: the system mapping is another owner's, so no warning.
  actions.resetMappings();
  asClub();
  await open();
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  render();
  assert.doesNotMatch(text(), /already fills/);
  // The platform's own flow is warned.
  actions.resetMappings();
  asPlatform();
  await open();
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TD}"]`);
  render();
  assert.equal(data.mappingsState().flow.step, 3);
  data.mappingsState().flow.step = 2;
  render();
  assert.match(text(), /This field already fills Distance \(km\)\. Only one of them can be active at a time\./);
});

test("29. a write refused with a stated reason can be sent again from the same form: switch on after try_again, Save draft after try_again", async () => {
  let refuse = true;
  overrides.push((c) => (c.method === "POST" && c.url === `${B}/activations` && refuse ? ((refuse = false), ok({ error: "try_again" }, 409)) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="club"]', CLUB);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  await input(`[data-mm-field="team"][data-binding-id="${B2}"]`, true);
  await input('[data-mm-field="requirement"][value="optional"]', true);
  await input('[data-mm-field="reason"]', "U19 too.");
  await click('[data-action="metric-mappings-review"]');
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.match(text(), /The server was busy\. Nothing was saved\. Try again\./);
  assert.equal($('[data-action="metric-mappings-confirm"]').disabled, false);
  await click('[data-action="metric-mappings-confirm"]');
  render();
  const sent = posts().filter((c) => c.url === `${B}/activations`);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].body.requestKey, sent[1].body.requestKey);
  assert.deepEqual({ ...sent[0].body, requestKey: "" }, { ...sent[1].body, requestKey: "" });
  assert.match(text(), /Switched on\./);
  // The flow: Save draft refused, then sent again.
  actions.resetMappings();
  calls.length = 0;
  let refuseCreate = true;
  overrides = [(c) => (c.method === "POST" && c.url === `${B}/mappings` && refuseCreate ? ((refuseCreate = false), ok({ error: "try_again" }, 409)) : null)];
  await open();
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TK}"]`);
  await input('[data-mm-field="flow.conversionNote"]', "GPEXE gives metres; the variable is in km.");
  await click('[data-action="metric-mappings-flow-review"]');
  await click('[data-action="metric-mappings-flow-save"]');
  render();
  assert.match(text(), /The server was busy\. Nothing was saved\. Try again\./);
  await click('[data-action="metric-mappings-flow-save"]');
  render();
  assert.equal(posts().filter((c) => c.url === `${B}/mappings`).length, 2);
  assert.equal(posts().filter((c) => /\/mappings\/[^/]+\/versions$/.test(c.url)).length, 1);
  assert.match(text(), /The draft is saved\./);
});

test("30. the teams a replacement switches off are compared by identity at the button: one team swapped for another with the same count is caught", async () => {
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  await input('[data-mm-field="reason"]', "Replace it.");
  await click('[data-action="metric-mappings-review"]');
  // Meanwhile First team is switched off and U19 switched on: still one open row.
  db.activations[0].endedAt = "2026-11-01T10:00:00Z";
  db.activations.push(act({ id: id("ac000000", 20), versionId: V1, bindingId: B2, teamId: TEAM2, requirement: "optional" }));
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.equal(posts().length, 0);
  assert.match(text(), /The teams of the active version changed meanwhile\. Check the list again\./);
  assert.match(text(), /U19 — linked to GPEXE team 981/);
});

test("31. the preview: a late answer for the team chosen before never replaces the chosen team's sessions", async () => {
  const TEAM2_CANDIDATE = cand({ id: id("ca000000", 9), label: "U19 training", approvalBlockers: ["import_switch_off"], status: "pending" });
  db.candidates[TEAM2] = [TEAM2_CANDIDATE];
  let releaseFirst;
  const heldFirst = new Promise((resolve) => { releaseFirst = resolve; });
  overrides.push((c) => (c.url === `/api/training-load/gpexe/teams/${TEAM1}/candidates` ? heldFirst.then(() => ok({ candidates: db.candidates[TEAM1] })) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="previewClub"]', CLUB);
  const panel = data.mappingsState().panel;
  const firstChoice = Object.assign($('[data-mm-field="previewTeam"]'), { value: TEAM1 });
  actions.handleMappingsInput(firstChoice, { render });
  await settle();
  await input('[data-mm-field="previewTeam"]', TEAM2);
  assert.deepEqual(panel.candidates.map((c) => c.id), [TEAM2_CANDIDATE.id]);
  releaseFirst();
  for (let i = 0; i < 6; i += 1) await settle();
  render();
  assert.deepEqual(data.mappingsState().panel.candidates.map((c) => c.id), [TEAM2_CANDIDATE.id]);
  assert.match(text(), /U19 training/);
  assert.doesNotMatch(text(), /Training 05\.10/);
});

test("32. an unknown refusal keeps its sentence and code and reads the mapping again; a check answered with an unknown code stays not confirmed (per-route list)", async () => {
  db.mappings[0].versions.unshift(ver({ id: V3, versionNumber: 3, status: "draft", metricDefinitionVersionId: "tv-d" }));
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/submit") ? ok({ error: "brand_new_refusal" }, 409) : null));
  await open("detail");
  const reads = () => calls.filter((c) => c.method === "GET" && c.url === `${B}/mappings/${M1}`).length;
  const before = reads();
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /It was not saved: the server refused it\./);
  assert.match($("details.data-sources-tech").textContent, /brand_new_refusal/);
  assert.equal(reads(), before + 1);
  // A settled refusal does not hold the screen: the acts stay usable.
  assert.equal($(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`).disabled, false);
  assert.equal($('[data-action="metric-mappings-new-version"]').disabled, false);
  // Per route: a code another route settles on does not settle a submit check.
  assert.equal(data.checkSettles("submit", { code: "version_not_draft", status: 409 }), true);
  assert.equal(data.checkSettles("submit", { code: "activation_not_open", status: 409 }), false);
  assert.equal(data.checkSettles("switchOn", { code: "activation_exists", status: 409 }), true);
  assert.equal(data.checkSettles("switchOff", { code: "activation_exists", status: 409 }), false);
  assert.equal(data.checkSettles("draft", { code: "unit_not_proven", status: 409 }), true);
  assert.equal(data.checkSettles("activate", { code: "brand_new_refusal", status: 409 }), false);
  assert.equal(data.checkSettles("create", { code: "invalid_body", status: 400 }), true);
  assert.equal(data.checkSettles("create", { code: "try_again", status: 409 }), false);
  // A lost submit, then a check answered with an unknown code: still not confirmed.
  overrides = [];
  let lose = true;
  overrides.push((c) => {
    if (c.method !== "POST" || !c.url.endsWith("/submit")) return null;
    if (lose) { lose = false; return { throwNetworkError: true }; }
    return ok({ error: "brand_new_refusal" }, 409);
  });
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /Result not confirmed/);
  await click('[data-action="metric-mappings-check-result"]');
  render();
  assert.match(text(), /Result not confirmed/);
});

test("33. an old outcome's sentence never stands above a new act; a lone club is chosen; the levels both allow start ticked", async () => {
  db.org.clubs = [{ id: CLUB, name: "FK Borac" }];
  await open("detail");
  data.mappingsState().notice = "Switched off.";
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  assert.doesNotMatch(text(), /Switched off\./);
  assert.equal(data.mappingsState().panel.chooser.clubId, CLUB);
  assert.equal($('select[data-mm-field="club"]').value, CLUB);
  assert.ok($(`[data-mm-field="team"][data-binding-id="${B2}"]`));
  // The preview with the club's teams already read: the handler itself paints the
  // chosen club's team picker (no render by the test).
  await click('[data-action="metric-mappings-panel-close"]');
  render();
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  assert.equal(data.mappingsState().panel.clubId, CLUB);
  assert.ok($('select[data-mm-field="previewTeam"]'), "the team picker is painted");
  // The flow: both levels ticked when the variable allows both; the body sends them.
  actions.resetMappings();
  await open();
  await click('[data-action="metric-mappings-new"]');
  await click(`[data-action="metric-mappings-flow-field"][data-field-id="${FA}"]`);
  await click(`[data-action="metric-mappings-flow-target"][data-target-id="${TK}"]`);
  render();
  assert.equal($('[data-mm-field="flow.session"]').checked, true);
  assert.equal($('[data-mm-field="flow.drill"]').checked, true);
});

test("34. labels written by others are cleaned wherever they are shown: list row, heading, conversion note; the platform's step 4 names its own next step", async () => {
  db.mappings[0].target.label = "Dist‮ance\u0007";
  db.mappings[0].sourceMetric.label = "Total‮ distance";
  db.mappings[0].versions[1].conversionNote = "Metres‮ to km";
  await open();
  assert.doesNotMatch(content.innerHTML, /‮|\u0007/);
  assert.match(text(), /Distance/);
  await click(`[data-action="metric-mappings-open"][data-mapping-id="${M1}"]`);
  render();
  assert.doesNotMatch(content.innerHTML, /‮|\u0007/);
  assert.match($("#metric-mappings-title").textContent, /Distance/);
  assert.match(text(), /Metres to km/);
  // Step 4 for a platform admin; and the sentence after Submit.
  db.mappings[0].versions.unshift(ver({ id: V3, versionNumber: 3, status: "draft", metricDefinitionVersionId: "tv-d" }));
  actions.resetMappings();
  await open("detail");
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /Submitted for review\. You can activate it now\./);
  // A club admin submitting the club's own mapping is not told to activate it.
  db.mappings[0].ownerScope = "club";
  db.mappings[0].versions[0].status = "draft";
  asClub();
  actions.resetMappings();
  await open("detail");
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.doesNotMatch(text(), /You can activate it now/);
});

test("35. the preview says the two ranges as one; a New version's steps read 3. and 4.", async () => {
  await open("detail");
  await click(`[data-action="metric-mappings-preview-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="previewClub"]', CLUB);
  await input('[data-mm-field="previewTeam"]', TEAM1);
  await input('[data-mm-field="previewCandidate"]', CAND1);
  data.mappingsState().panel.candidateId = CAND1;
  await click('[data-action="metric-mappings-preview-run"]');
  render();
  assert.match(text(), /3100–7400\.5 m in GPEXE = 3100–7400\.5 m in “Distance”/);
  await click('[data-action="metric-mappings-panel-close"]');
  await click('[data-action="metric-mappings-new-version"]');
  render();
  assert.deepEqual($$(".metric-mappings-step-no").map((e) => e.textContent), ["3.", "4."]);
  assert.match(text(), /Step 3 of 4/);
});

test("36. the R8 re-read at the button: a second click while it runs sends nothing, Back meanwhile sends nothing; the notice after a replace", async () => {
  let release = null;
  overrides.push((c) => {
    if (!release || c.method !== "GET" || !c.url.startsWith(`${B}/activations?`) || !c.url.includes(`versionId=${V1}`)) return null;
    const held = new Promise((resolve) => { const r = release; release = null; r.wait = resolve; });
    return held.then(() => ok({ activations: db.activations.filter((a) => a.versionId === V1 && !a.endedAt), nextCursor: null }));
  });
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/activate") ? ok({ version: {}, replaced: V1, activationsEnded: 2, activations: [act({ versionId: V2, bindingId: B1, teamId: TEAM1 })] }) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  await input('[data-mm-field="reason"]', "Replace it.");
  await click('[data-action="metric-mappings-review"]');
  render();
  // Hold the re-read; click twice.
  const gate = {};
  release = gate;
  const button = $('[data-action="metric-mappings-confirm"]');
  const first = actions.handleMappingsAction(button, { render });
  for (let i = 0; i < 4; i += 1) await settle();
  render();
  assert.equal($('[data-action="metric-mappings-confirm"]').disabled, true);
  assert.match($('[data-action="metric-mappings-confirm"]').textContent, /Checking the teams\.\.\./);
  const rereads = () => calls.filter((c) => c.method === "GET" && c.url.startsWith(`${B}/activations?`) && c.url.includes(`versionId=${V1}`)).length;
  const readsBefore = rereads();
  await actions.handleMappingsAction(button, { render });
  // The second click started no read and no write while the first is held.
  assert.equal(rereads(), readsBefore);
  assert.equal(posts().length, 0);
  gate.wait();
  await first;
  render();
  assert.equal(posts().filter((c) => c.url.endsWith("/activate")).length, 1);
  assert.match(text(), /Version 2 is active\. 2 teams were switched off\. 1 team is switched on for version 2\./);
  assert.doesNotMatch(text(), /Imports do not use mappings/);
  // Back while the re-read runs: nothing is sent.
  actions.resetMappings();
  calls.length = 0;
  db.mappings[0].versions.find((v) => v.id === V2).status = "needs_review";
  await open("detail");
  await click(`[data-action="metric-mappings-activate-open"][data-version-id="${V2}"]`);
  await input('[data-mm-field="reason"]', "Replace it.");
  await click('[data-action="metric-mappings-review"]');
  render();
  const gate2 = {};
  release = gate2;
  const second = actions.handleMappingsAction($('[data-action="metric-mappings-confirm"]'), { render });
  for (let i = 0; i < 4; i += 1) await settle();
  data.mappingsState().panel.review = false;
  gate2.wait();
  await second;
  assert.equal(posts().length, 0);
});

test("37. text written by another administrator or a source is escaped and cleaned on every screen: list, detail, chooser and review card", async () => {
  const P = "<img src=x onerror=alert(1)>‮";
  db.mappings[0].target.label = `${P}Distance`;
  db.mappings[0].sourceMetric.label = `${P}Total distance`;
  db.mappings[0].versions.find((v) => v.id === V1).conversionNote = `${P}Metres, as GPEXE gives them.`;
  db.org.clubs[0].name = `${P}FK Borac`;
  const u19 = db.connections[CLUB][0].boundTeams.find((t) => t.bindingId === B2);
  u19.teamName = `${P}U19`;
  u19.sourceTeamId = `${P}981`;
  db.org.teams.find((t) => t.id === TEAM2).name = `${P}U19`;
  const safe = (where) => {
    const html = content.innerHTML;
    assert.doesNotMatch(html, /<img/, `${where}: no element from the text`);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${where}: the text is shown escaped`);
    assert.doesNotMatch(html, /‮/, `${where}: no bidi control`);
  };
  await open();
  safe("list");
  await click(`[data-action="metric-mappings-open"][data-mapping-id="${M1}"]`);
  render();
  safe("detail");
  assert.match(text(), /Metres, as GPEXE gives them\./);
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="club"]', CLUB);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  safe("chooser");
  await input(`[data-mm-field="team"][data-binding-id="${B2}"]`, true);
  await input('[data-mm-field="requirement"][value="required"]', true);
  await input('[data-mm-field="reason"]', "U19 too.");
  await click('[data-action="metric-mappings-review"]');
  render();
  const card = $(".metric-mappings-panel .metric-mappings-review-card").innerHTML;
  assert.doesNotMatch(card, /<img/);
  assert.match(card, /U19” — linked to GPEXE team &lt;img src=x onerror=alert\(1\)&gt;981/);
  assert.doesNotMatch(card, /‮/);
  safe("review card");
});

test("38. after request_key_reused the next attempt is a new request with a new key, never the refused key", async () => {
  let refuse = true;
  overrides.push((c) => (c.method === "POST" && c.url === `${B}/activations` && refuse ? ((refuse = false), ok({ error: "request_key_reused" }, 409)) : null));
  await open("detail");
  await click(`[data-action="metric-mappings-switch-on-open"][data-version-id="${V1}"]`);
  await input('[data-mm-field="club"]', CLUB);
  for (let i = 0; i < 12; i += 1) await settle();
  render();
  await input(`[data-mm-field="team"][data-binding-id="${B2}"]`, true);
  await input('[data-mm-field="requirement"][value="optional"]', true);
  await input('[data-mm-field="reason"]', "U19 too.");
  await click('[data-action="metric-mappings-review"]');
  await click('[data-action="metric-mappings-confirm"]');
  render();
  assert.match(text(), /An earlier save of this form may already be stored\. Close it and look at the mapping before saving again\./);
  await click('[data-action="metric-mappings-confirm"]');
  render();
  const sent = posts().filter((c) => c.url === `${B}/activations`);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].body.requestKey, sent[0].body.requestKey);
  assert.match(text(), /Switched on\./);
});

test("39. while a result is not confirmed every act that writes is off in the markup: the version's acts, New version, Switch off, New mapping", async () => {
  db.mappings[0].versions.unshift(ver({ id: V3, versionNumber: 3, status: "draft", metricDefinitionVersionId: "tv-d" }));
  overrides.push((c) => (c.method === "POST" && c.url.endsWith("/submit") ? { throwNetworkError: true } : null));
  await open("detail");
  await click(`[data-action="metric-mappings-submit"][data-version-id="${V3}"]`);
  render();
  assert.match(text(), /Result not confirmed/);
  const acts = $$('.metric-variables-version .metric-variables-actions button, [data-action="metric-mappings-new-version"], [data-action="metric-mappings-switch-off-open"]');
  assert.ok(acts.length >= 5);
  assert.ok(acts.every((b) => b.disabled), acts.filter((b) => !b.disabled).map((b) => b.dataset.action).join(","));
  assert.equal($('[data-action="metric-mappings-check-result"]').disabled, false);
  // The list's New mapping too, while the result is not confirmed.
  data.mappingsState().view = "list";
  render();
  assert.equal($('[data-action="metric-mappings-new"]').disabled, true);
});
