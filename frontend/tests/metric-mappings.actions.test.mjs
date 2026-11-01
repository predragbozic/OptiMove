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
  assert.match(text(), /these 3 teams/);
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
  assert.match(text(), /5 teams were switched off\. The list showed 3\./);
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
  assert.match(text(), /When imports use this mapping — Required: if an athlete the import admits has no value/);
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
  assert.match(text(), /Switched on\. Imports do not use mappings yet; nothing changes in imports until they do\./);
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
