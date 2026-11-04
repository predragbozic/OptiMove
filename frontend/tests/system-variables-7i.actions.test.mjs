// Training Load -> Data configuration -> Variables -> From OptiMove (7i-B2,
// J15 section 8.2): a club's administrator uses, copies, hides and shows
// OptiMove's ready-made variables, and moves its teams to a copy. Driven
// through the real handlers and markup in a DOM with a fake server, so what
// the screen sends (exact bodies, one write at a time, one request key per
// attempt) and what it shows (statuses, acts by state, every sentence, a lost
// answer checked by the very same request) are proved.
import { dropSystemReadCache } from "../system-variables-actions.js";
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

let route = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => route(call));
after(() => restoreFetch());

const { handleVariablesAction, handleVariablesInput, resetVariables, submitVariablesForm, variablesMayBeLeft } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { requestMappingsOpen, loadMappingsSection, resetMappings } = await import("../metric-mappings-actions.js");
const { mappingsState } = await import("../metric-mappings-data.js");
const { renderMappingsHtml } = await import("../metric-mappings-view.js");
const { pickable, pickerName } = await import("../metric-picker-visibility.js");
const { state } = await import("../state.js");

const BASE = "/api/training-load/sources/metrics";
const VB = `${BASE}/variables`;
const CLUB = "11111111-0000-4000-8000-000000000001";
const SYS = "aaaaaaaa-1111-4000-8000-000000000001";
const SYS_2 = "aaaaaaaa-1111-4000-8000-000000000002";
const COPY = "aaaaaaaa-1111-4000-8000-000000000009";
const VER = "bbbbbbbb-1111-4000-8000-000000000001";
const M_SYS = "cccccccc-1111-4000-8000-000000000001";
const V_SYS = "dddddddd-1111-4000-8000-000000000001";
const M_COPY = "cccccccc-1111-4000-8000-000000000002";
const V_COPY = "dddddddd-1111-4000-8000-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => handleVariablesInput(event.target, { render }));
content.addEventListener("change", (event) => handleVariablesInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
const act = (dataset) => {
  const element = document.createElement("button");
  Object.assign(element.dataset, dataset);
  return handleVariablesAction(element, { render });
};
function type(field, value) {
  const element = $(`[data-mv-field="${field}"]`);
  assert.ok(element, `the ${field} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });

function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}
function asCoach() {
  state.currentUser = { id: "u2", activeWorkspace: { type: "team", scopeId: "t1", clubId: CLUB, label: "First team", role: "team_coach" } };
}

// ---------------------------------------------------------------------------
// A fake server: OptiMove's variables, a copy, mappings, activations, teams
// ---------------------------------------------------------------------------
const ver = (over = {}) => ({ id: VER, versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: "0", maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z", ...over });
const club = (over = {}) => ({ hidden: false, usedByTeams: false, hasDataSource: true, copyId: null, ...over });
const sys = ({ id = SYS, label = "Total distance", key = "total_distance", clubFacts = {}, actions = ["copy", "hide", "use"], ...over } = {}) => ({
  id, key, label, shortLabel: null, description: null, ownerScope: "system", state: "active", editable: false, levels: ["session"], currentVersion: ver(),
  mappingTarget: { ready: true, notReadyCode: null }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z", truncated: false,
  actions, labelsToken: "a".repeat(64), club: club(clubFacts), ...over,
});
const copyRow = (over = {}) => ({
  id: COPY, key: "total_distance", label: "Total distance", shortLabel: null, description: null, ownerScope: "club", state: "active", editable: true, levels: ["session"],
  currentVersion: ver({ id: "bbbbbbbb-1111-4000-8000-000000000009" }), mappingTarget: { ready: true, notReadyCode: null },
  createdAt: "2026-11-04T08:00:00.000Z", updatedAt: "2026-11-04T08:00:00.000Z", truncated: false, actions: ["rename", "archive", "newVersion"], labelsToken: "b".repeat(64), ...over,
});
const mappingRow = (over = {}) => ({
  id: M_SYS, ownerScope: "system", sourceMetric: { id: "sm1", key: "tot_dist", apiFamily: "rest_v1", label: "Total distance (GPEXE)" },
  metricDefinitionId: SYS, target: { key: "total_distance", label: "Total distance" }, createdAt: "2026-10-20T08:00:00.000Z", latestVersion: null, activeVersionId: V_SYS, versionCounts: {}, ...over,
});

let db;
function freshDb() {
  db = {
    system: [sys()],
    detail: { [SYS]: sys(), [COPY]: copyRow() },
    mappings: [mappingRow()],
    activations: { [V_SYS]: [] },
    teams: [{ id: "t1", name: "First team", club_id: CLUB, club_name: "FK Borac" }, { id: "t2", name: "Juniors", club_id: CLUB, club_name: "FK Borac" }],
    overrides: [],
    seen: new Map(),
  };
}
function serve(call) {
  const hit = db.overrides.findIndex((o) => o.match(call));
  if (hit >= 0) return db.overrides.splice(hit, 1)[0].answer(call);
  const url = new URL(call.url, "http://x");
  const path = url.pathname;
  if (call.method === "GET") {
    if (path === VB) {
      if (url.searchParams.get("scope") === "system") return { status: 200, body: { variables: db.system, nextCursor: null } };
      return { status: 200, body: { variables: [db.detail[COPY]].filter(Boolean), nextCursor: null } };
    }
    if (path.startsWith(`${VB}/`)) {
      const id = path.slice(VB.length + 1);
      return db.detail[id] ? { status: 200, body: { variable: { ...db.detail[id], versions: [{ ...db.detail[id].currentVersion, current: true, reason: null }] }, nextCursor: null } } : { status: 404, body: { error: "notFound" } };
    }
    if (path === `${BASE}/mappings`) return { status: 200, body: { mappings: db.mappings, nextCursor: null } };
    if (path === `${BASE}/activations`) {
      const rows = db.activations[url.searchParams.get("versionId")] || [];
      return { status: 200, body: { activations: rows, nextCursor: null } };
    }
    if (path === "/api/organization") return { status: 200, body: { clubs: [{ id: CLUB, name: "FK Borac" }], teams: db.teams } };
    if (path.startsWith("/api/training-load/classification")) return { status: 200, body: { domains: [], categories: [], categoryDomains: [], truncated: false } };
    return { status: 404, body: { error: "notFound" } };
  }
  // A keyed write replays: the same key and body answers what it answered.
  const key = call.body?.requestKey;
  const sig = `${path}|${call.rawBody}`;
  if (key && db.seen.has(key)) return db.seen.get(key).sig === sig ? db.seen.get(key).answer : { status: 409, body: { error: "request_key_reused" } };
  const answer = db.write?.(call, path) || { status: 404, body: { error: "notFound" } };
  if (key && answer.status < 300) db.seen.set(key, { sig, answer });
  return answer;
}

beforeEach(() => {
  dropSystemReadCache();
  resetVariables();
  resetMappings();
  freshDb();
  route = serve;
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asClub();
  variablesState().view = "variables";
  variablesState().scope = "system";
  content.innerHTML = "";
});

async function openList() {
  const { loadVariablesSection } = await import("../metric-variables-actions.js");
  await loadVariablesSection(render);
}
async function openDetail(id = SYS) {
  await act({ action: "metric-variables-open", variableId: id });
  await settle();
  render();
}
const buttons = () => [...content.querySelectorAll(".metric-variables-actions .plain-button")].map((b) => b.textContent.trim());
const primary = () => [...content.querySelectorAll(".metric-variables-actions .data-sources-primary")].map((b) => b.textContent.trim());

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
test("the From OptiMove list reads with hidden=exclude, shows one status chip per row and the Availability select to an administrator only", async () => {
  db.system = [
    sys({ id: SYS, label: "Used one", clubFacts: { usedByTeams: true, copyId: COPY } }),
    sys({ id: SYS_2, label: "Not used one" }),
    sys({ id: "aaaaaaaa-1111-4000-8000-000000000003", label: "No source one", clubFacts: { hasDataSource: false }, actions: ["copy", "hide"] }),
    sys({ id: "aaaaaaaa-1111-4000-8000-000000000004", label: "Hidden one", clubFacts: { hidden: true }, actions: ["show"] }),
  ];
  await openList();
  assert.equal(calls.find((c) => c.url.startsWith(VB))?.url, `${VB}?scope=system&state=active&hidden=exclude`);
  assert.match(text(), /From OptiMove/);
  const rows = [...content.querySelectorAll(".metric-variables-list li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.match(rows[0], /Used one.*Used by this club's teams.*Copied/);
  assert.match(rows[1], /Not used one.*Not used/);
  assert.match(rows[2], /No source one.*No data source yet/);
  assert.match(rows[3], /Hidden one.*Hidden/);
  const select = $('[data-metric-variables-filter="hidden"]');
  assert.ok(select, "an administrator can choose Available / Hidden by your club / All");
  assert.deepEqual([...select.options].map((o) => o.textContent), ["Available", "Hidden by your club", "All"]);
  select.value = "only";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(calls.filter((c) => c.url.startsWith(VB)).at(-1).url, `${VB}?scope=system&state=active&hidden=only`);
  const again = $('[data-metric-variables-filter="hidden"]');
  assert.equal(again.value, "only", "the choice is kept");
  again.value = "include";
  again.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(calls.filter((c) => c.url.startsWith(VB)).at(-1).url, `${VB}?scope=system&state=active&hidden=include`);
});

test("the own scope never sends hidden, and a coach gets no Availability select and no status of use", async () => {
  variablesState().scope = "own";
  await openList();
  assert.equal(calls.find((c) => c.url.startsWith(VB)).url, `${VB}?scope=own&state=active`);
  assert.ok(!$('[data-metric-variables-filter="hidden"]'));
  resetVariables();
  variablesState().view = "variables";
  variablesState().scope = "system";
  asCoach();
  db.system = [{ ...sys({ id: SYS }), club: { hidden: true }, actions: [] }];
  calls.length = 0;
  await openList();
  assert.ok(!$('[data-metric-variables-filter="hidden"]'), "a coach has no Availability select");
  assert.match(text(), /Hidden by the club/);
  assert.ok(!/Used by this club's teams|Not used|No data source yet/.test(text()), "a coach is shown no status of use");
});

// ---------------------------------------------------------------------------
// The detail: one primary act by state
// ---------------------------------------------------------------------------
test("the detail offers one primary act by state, and says why an act is not offered", async () => {
  // Not used: Use is primary; Copy and Hide are plain.
  await openDetail(SYS);
  assert.deepEqual(primary(), ["Use for your teams"]);
  assert.deepEqual(buttons(), ["Use for your teams", "Copy to my club", "Hide for my club"]);
  // Used and not copied: Copy is primary; Hide is off with its reason.
  db.detail[SYS] = sys({ clubFacts: { usedByTeams: true }, actions: ["copy"] });
  await openDetail(SYS);
  assert.deepEqual(primary(), ["Copy to my club"]);
  assert.match(text(), /Hide is off while teams use it\. Switch it off for your teams first\./);
  assert.ok($('[data-mm-open-mapping]'), "See the teams using it");
  assert.match(text(), /See the teams using it/);
  // Used and copied: Open your copy is primary and Copy is not offered.
  db.detail[SYS] = sys({ clubFacts: { usedByTeams: true, copyId: COPY }, actions: [] });
  await openDetail(SYS);
  assert.deepEqual(primary(), ["Open your copy"]);
  assert.ok(!buttons().includes("Copy to my club"));
  // Hidden: Show again is the only act.
  db.detail[SYS] = sys({ clubFacts: { hidden: true }, actions: ["show"] });
  await openDetail(SYS);
  assert.deepEqual(buttons(), ["Show again"]);
  // No data source yet: no Use; Copy and Hide stay as plain buttons.
  db.detail[SYS] = sys({ clubFacts: { hasDataSource: false }, actions: ["copy", "hide"] });
  await openDetail(SYS);
  assert.deepEqual(primary(), []);
  assert.deepEqual(buttons(), ["Copy to my club", "Hide for my club"]);
  assert.match(text(), /OptiMove has not connected a data source to it yet\./);
  // A data source but no linked team: no Use, and the way to get one.
  db.detail[SYS] = sys({ actions: ["copy", "hide"] });
  await openDetail(SYS);
  assert.ok(!buttons().includes("Use for your teams"));
  assert.match(text(), /Link a team to GPEXE first \(Settings → Source connections\)\./);
  assert.match(text(), /OptiMove changes this variable; your club cannot edit it\./);
});

test("Use for your teams names the mapping and its active version, one button per data source", async () => {
  await openDetail(SYS);
  const use = $('[data-mm-open-mapping]');
  assert.equal(use.dataset.action, "training-load-section");
  assert.equal(use.dataset.section, "mappings");
  assert.equal(use.dataset.mmOpenMapping, M_SYS);
  assert.equal(use.dataset.mmOpenVersion, V_SYS);
  assert.equal(use.dataset.mmFromLabel, "Total distance");
  // Two data sources: one button each, never a silent choice.
  db.mappings = [mappingRow(), mappingRow({ id: "cccccccc-1111-4000-8000-000000000003", activeVersionId: "dddddddd-1111-4000-8000-000000000003", sourceMetric: { id: "sm2", label: "Distance (Catapult)" } })];
  resetVariables();
  variablesState().view = "variables";
  await openDetail(SYS);
  assert.deepEqual([...content.querySelectorAll("[data-mm-open-mapping]")].map((b) => b.textContent.trim()), ["Use for your teams: Total distance (GPEXE)", "Use for your teams: Distance (Catapult)"]);
});

test("the request to open a mapping carries the Mappings screen to the switch-on panel titled Use <name> for your teams, with a way back", async () => {
  db.mappings = [mappingRow()];
  const mapping = {
    ...mappingRow(), mappingId: M_SYS, versions: [{ id: V_SYS, versionNumber: 1, status: "active", createdAt: "2026-10-20T08:00:00.000Z" }], nextCursor: null,
  };
  route = (call) => {
    const url = new URL(call.url, "http://x");
    if (call.method === "GET" && url.pathname === `${BASE}/mappings/${M_SYS}`) return { status: 200, body: { mapping, nextCursor: null } };
    if (call.method === "GET" && url.pathname === `${BASE}/activations`) return { status: 200, body: { activations: [], nextCursor: null } };
    if (call.method === "GET" && url.pathname === "/api/organization") return { status: 200, body: { clubs: [{ id: CLUB, name: "FK Borac" }], teams: db.teams } };
    if (call.method === "GET" && url.pathname.startsWith("/api/training-load/sources/gpexe/connections")) return { status: 200, body: { connections: [] } };
    return { status: 200, body: { fields: [], targets: [], conversions: [], nextCursor: null } };
  };
  requestMappingsOpen({ mappingId: M_SYS, versionId: V_SYS, from: { label: "Total distance" } });
  assert.equal(mappingsState().pending.versionId, V_SYS);
  await loadMappingsSection(() => {});
  const s = mappingsState();
  assert.equal(s.pending, null, "the request is carried out once");
  assert.equal(s.view, "detail");
  assert.equal(s.panel?.kind, "switchOn");
  assert.deepEqual(s.panel.from, { label: "Total distance" });
  const html = renderMappingsHtml();
  assert.match(html, /Use Total distance for your teams/);
  assert.match(html, /← Total distance/);
  assert.match(html, /data-section="variables"/);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
function copyWrites(handler) {
  db.write = (call, path) => (path === `${VB}/${SYS}/copy` ? handler(call) : null);
}

test("Copy to my club: a review card with the name, the number of links and Advanced; an untouched card sends only the key and the version", async () => {
  db.mappings = [mappingRow(), mappingRow({ id: "cccccccc-1111-4000-8000-000000000003", activeVersionId: "dddddddd-1111-4000-8000-000000000003", sourceMetric: { id: "sm2", label: "x" } }), mappingRow({ id: "x", metricDefinitionId: SYS_2 }), mappingRow({ id: "y", activeVersionId: null })];
  await openDetail(SYS);
  await click('[data-action="metric-variables-copy-open"]');
  await settle();
  assert.match(text(), /Copy Total distance to my club/);
  assert.equal($('[data-mv-field="label"]').value, "Total distance");
  assert.equal($('[data-mv-field="key"]').value, "total_distance");
  assert.match(text(), /It comes with 2 links to GPEXE fields, as drafts\. Review and activate them on the copy's page\./);
  assert.match(text(), /It will not follow later changes OptiMove makes\./);
  assert.match(text(), /Keep it unless you have a reason to change it\. It cannot be changed later\./);
  assert.ok($("details.data-sources-tech"), "the key is under Advanced, folded");
  copyWrites(() => ({ status: 201, body: { variable: copyRow(), copiedMappings: [], replayed: false } }));
  await submit();
  await settle();
  const sent = posts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${VB}/${SYS}/copy`);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["expectedSourceVersionId", "requestKey"]);
  assert.equal(sent[0].body.expectedSourceVersionId, VER);
  assert.match(sent[0].body.requestKey, UUID);
  // The copy's detail opens, with the next step.
  assert.match(text(), /Copied\. Next: open each draft link, submit it and activate it\./);
  assert.ok(calls.some((c) => c.method === "GET" && c.url.startsWith(`${VB}/${COPY}`)), "the copy is read");
});

test("an edited name and key go into the request; a name or key the server refuses is shown at its field", async () => {
  await openDetail(SYS);
  await click('[data-action="metric-variables-copy-open"]');
  await settle();
  type("label", "  Our   distance ");
  type("key", "our_distance");
  copyWrites(() => ({ status: 409, body: { error: "key_taken", message: "x" } }));
  await submit();
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, expectedSourceVersionId: VER, label: "Our distance", key: "our_distance" });
  assert.match(text(), /Your club already has a variable with this key\. Change the key under Advanced\./);
  assert.equal($("details.data-sources-tech").open, true, "Advanced opens on a key problem");
  // Fields are checked before anything is sent.
  type("key", "Bad Key");
  const before = posts().length;
  await submit();
  assert.equal(posts().length, before);
  assert.match(text(), /Lower-case letters, digits and underscores/);
  type("key", "total_distance");
  type("label", "");
  await submit();
  assert.equal(posts().length, before);
  assert.match(text(), /Enter a name\./);
});

test("a refusal after the card was opened closes it and reads the variable again, with the sentence for the code", async () => {
  const cases = [
    ["already_copied", /Your club already has a copy of this variable\./],
    ["source_version_changed", /OptiMove changed this variable a moment ago\. Open it again and copy\./],
    ["source_not_active", /OptiMove has archived this variable, so it can't be copied\./],
  ];
  for (const [code, pattern] of cases) {
    resetVariables();
    variablesState().view = "variables";
    freshDb();
    await openDetail(SYS);
    await click('[data-action="metric-variables-copy-open"]');
    await settle();
    copyWrites(() => ({ status: 409, body: { error: code } }));
    const reads = calls.filter((c) => c.method === "GET" && c.url.startsWith(`${VB}/${SYS}`)).length;
    await submit();
    await settle();
    assert.equal($("[data-metric-variables-form]"), null, `${code} closes the card`);
    assert.match(text(), pattern);
    assert.ok(calls.filter((c) => c.method === "GET" && c.url.startsWith(`${VB}/${SYS}`)).length > reads, `${code} reads the variable again`);
  }
  // The codes that stay on the card.
  for (const [code, pattern] of [
    ["copy_mapping_not_reproducible", /One of its GPEXE field links can't be copied now\. Ask a platform administrator\./],
    ["copy_source_unsupported", /This variable can't be copied into a club\. Use it as it is instead\./],
    ["copy_too_large", /It has too many links to copy at once\. Ask a platform administrator\./],
  ]) {
    resetVariables();
    variablesState().view = "variables";
    await openDetail(SYS);
    await click('[data-action="metric-variables-copy-open"]');
    await settle();
    copyWrites(() => ({ status: 409, body: { error: code, current: { sourceMetricId: "11111111-2222-4333-8444-555555555555", code: "x" } } }));
    await submit();
    assert.match(text(), pattern, code);
    assert.ok(!text().includes("11111111-2222"), "no id on the card");
  }
});

test("a lost answer to Copy is Result not confirmed; Check result sends the very same request and a settled answer finishes it", async () => {
  await openDetail(SYS);
  await click('[data-action="metric-variables-copy-open"]');
  await settle();
  db.overrides.push({ match: (c) => c.method === "POST", answer: () => ({ throwNetworkError: true }) });
  await submit();
  assert.match(text(), /Result not confirmed/);
  assert.ok(!/nothing was saved/i.test(text()), "never claims nothing was saved");
  assert.ok($('[data-metric-variables-form] input[data-mv-field="label"]').disabled, "the card is locked");
  confirmQuestions.length = 0;
  assert.equal(variablesMayBeLeft(), true);
  assert.match(confirmQuestions.at(-1) || "", /not confirmed/, "leaving a save that is not confirmed asks first");
  copyWrites(() => ({ status: 200, body: { variable: copyRow(), copiedMappings: [], replayed: false, commitConfirmation: "verified_after_commit_error" } }));
  await click('[data-action="metric-variables-check-result"]');
  await settle();
  const sent = posts();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].rawBody, sent[1].rawBody, "the very same request");
  assert.match(text(), /Copied\. Next:/);
  // A busy check does not settle the first write.
  resetVariables();
  variablesState().view = "variables";
  await openDetail(SYS);
  await click('[data-action="metric-variables-copy-open"]');
  await settle();
  db.overrides.push({ match: (c) => c.method === "POST", answer: () => ({ status: 503, body: { error: "outcome_unknown" } }) });
  await submit();
  assert.match(text(), /Result not confirmed/);
  db.overrides.push({ match: (c) => c.method === "POST", answer: () => ({ status: 409, body: { error: "try_again" } }) });
  await click('[data-action="metric-variables-check-result"]');
  assert.match(text(), /The check could not be done: the server was busy\./);
  assert.match(text(), /Result not confirmed/);
});

// ---------------------------------------------------------------------------
// Hide and show
// ---------------------------------------------------------------------------
test("Hide for my club asks once, sends only a request key, and the variable reads as hidden; Show again undoes it", async () => {
  await openDetail(SYS);
  await click('[data-action="metric-variables-hide-open"]');
  assert.match(text(), /Total distance disappears from this club's lists and pickers, and from those of its teams' coaches\. Recorded values, results and charts already made stay\./);
  db.write = (call, path) => {
    if (path === `${VB}/${SYS}/hide`) { db.detail[SYS] = sys({ clubFacts: { hidden: true }, actions: ["show"] }); return { status: 200, body: { variableId: SYS, hidden: true, hiddenAt: "2026-11-04T09:00:00.000Z", replayed: false } }; }
    if (path === `${VB}/${SYS}/show`) { db.detail[SYS] = sys(); return { status: 200, body: { variableId: SYS, hidden: false, hiddenAt: null, replayed: false } }; }
    return null;
  };
  await submit();
  await settle();
  assert.deepEqual(Object.keys(posts()[0].body), ["requestKey"]);
  assert.match(text(), /Total distance is hidden from this club\./);
  assert.deepEqual(buttons(), ["Show again"]);
  await click('[data-action="metric-variables-show-open"]');
  assert.match(text(), /Total distance is listed again in this club's lists and pickers/);
  await submit();
  await settle();
  assert.match(text(), /Total distance is shown again\./);
  assert.ok(buttons().includes("Hide for my club"));
});

test("hiding a variable teams use is refused by the server: the card closes and says what to do first", async () => {
  await openDetail(SYS);
  await click('[data-action="metric-variables-hide-open"]');
  db.write = () => ({ status: 409, body: { error: "variable_in_use", current: { activationCount: 2 } } });
  await submit();
  await settle();
  assert.equal($("[data-metric-variables-form]"), null);
  assert.match(text(), /Teams of this club still use it\. Switch it off for your teams first\./);
});

test("an act the server did not offer is never started from the screen", async () => {
  db.detail[SYS] = sys({ clubFacts: { usedByTeams: true }, actions: [] });
  await openDetail(SYS);
  await act({ action: "metric-variables-hide-open" });
  await act({ action: "metric-variables-copy-open" });
  assert.equal($("[data-metric-variables-form]"), null);
  assert.equal(posts().length, 0);
});

// ---------------------------------------------------------------------------
// Move your teams to this copy
// ---------------------------------------------------------------------------
function withTeamsOnOriginal({ copyActive = true } = {}) {
  db.system = [sys({ clubFacts: { usedByTeams: true, copyId: COPY }, actions: ["hide"] })];
  db.mappings = [mappingRow(), mappingRow({ id: M_COPY, ownerScope: "club", metricDefinitionId: COPY, activeVersionId: copyActive ? V_COPY : null })];
  db.activations = {
    [V_SYS]: [
      { id: "act-1", teamId: "t1", bindingId: "b1", requirement: "required", endedAt: null },
      { id: "act-2", teamId: "t2", bindingId: "b2", requirement: "optional", endedAt: null },
    ],
  };
}

test("on the copy, the teams still on OptiMove's variable are listed by name; the move is off until the copy's link is active", async () => {
  withTeamsOnOriginal({ copyActive: false });
  await openDetail(COPY);
  assert.match(text(), /Copied from OptiMove's Total distance\. Sessions imported before your teams move stay under OptiMove's Total distance\./);
  assert.match(text(), /First team.*Required.*Juniors.*Optional/);
  assert.match(text(), /Activate the copy's GPEXE field links first\./);
  assert.equal($('[data-action="metric-variables-move-open"]').disabled, true);
  await act({ action: "metric-variables-move-open" });
  assert.ok(!$('[data-action="metric-variables-move-confirm"]'), "the review does not open");
});

test("Move N teams sends one call per team, one at a time, each with its own key, the version of the copy and the reason", async () => {
  withTeamsOnOriginal();
  await openDetail(COPY);
  await click('[data-action="metric-variables-move-open"]');
  assert.match(text(), /Move 2 teams to this copy/);
  assert.match(text(), /Each team keeps its Required or Optional setting\. Sessions already imported stay under OptiMove's Total distance\./);
  assert.match(text(), /Your existing charts of Total distance get no new points after the move\./);
  // The reason is required.
  await click('[data-action="metric-variables-move-confirm"]');
  assert.match(text(), /Required\./);
  assert.equal(posts().length, 0);
  const reason = $("[data-mv-move-reason]");
  reason.value = "Moving to the club's own copy.";
  reason.dispatchEvent(new window.Event("input", { bubbles: true }));
  // The first team's answer is held: the second team is not sent until it
  // arrives, and a second press of the button sends nothing.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  db.write = (call, path) => {
    if (!/\/activations\/act-\d\/switch-to-copy$/.test(path)) return null;
    const answer = { status: 200, body: { ended: {}, activation: {}, replayed: false } };
    return path.includes("/act-1/") ? held.then(() => answer) : answer;
  };
  const moving = click('[data-action="metric-variables-move-confirm"]');
  await settle();
  assert.equal(posts().length, 1, "one team at a time");
  assert.equal($('[data-action="metric-variables-move-confirm"]').disabled, true);
  await act({ action: "metric-variables-move-confirm" });
  assert.equal(posts().length, 1, "a second press sends nothing");
  release();
  await moving;
  const sent = posts();
  assert.deepEqual(sent.map((c) => c.url), [`${BASE}/activations/act-1/switch-to-copy`, `${BASE}/activations/act-2/switch-to-copy`]);
  for (const call of sent) {
    assert.deepEqual(Object.keys(call.body).sort(), ["expectedState", "reason", "requestKey", "toVersionId"]);
    assert.equal(call.body.expectedState, "open");
    assert.equal(call.body.toVersionId, V_COPY);
    assert.equal(call.body.reason, "Moving to the club's own copy.");
  }
  assert.notEqual(sent[0].body.requestKey, sent[1].body.requestKey);
  assert.match(text(), /All 2 teams are on this copy now\./);
  assert.ok($('[data-action="metric-variables-hide-original"]'), "once no team uses OptiMove's variable, Hide it is offered");
});

test("a team the server refuses is Not moved with its sentence; the others are still moved; a lost answer is checked with the same key for that team only", async () => {
  withTeamsOnOriginal();
  await openDetail(COPY);
  await click('[data-action="metric-variables-move-open"]');
  const reason = $("[data-mv-move-reason]");
  reason.value = "Moving.";
  reason.dispatchEvent(new window.Event("input", { bubbles: true }));
  db.write = (call, path) => {
    if (path.includes("/act-1/")) return { status: 409, body: { error: "not_a_copy_of_this_version" } };
    if (path.includes("/act-2/")) return { throwNetworkError: true };
    return null;
  };
  await click('[data-action="metric-variables-move-confirm"]');
  assert.equal(posts().length, 2, "a refusal does not stop the other team");
  assert.match(text(), /First team.*Not moved/);
  assert.match(text(), /This team uses a different OptiMove version than the one your copy was made from\. Switch it off and then on with your copy; there is a short gap in between\./);
  assert.match(text(), /Juniors.*Result not confirmed/);
  assert.ok(!/nothing was changed|was not moved\./i.test(text().split("Juniors")[1] || ""), "a lost answer is never called not moved");
  assert.equal(variablesMayBeLeft(), true, "leaving asks");
  assert.ok(confirmQuestions.at(-1)?.includes("not confirmed"), "leaving with an unconfirmed move asks first");
  const firstKeys = posts().map((c) => c.body.requestKey);
  db.write = (call, path) => (path.includes("/act-2/") ? { status: 200, body: { ended: {}, activation: {}, replayed: true } } : null);
  await click('[data-action="metric-variables-move-check"]');
  const after = posts();
  assert.equal(after.length, 3, "only the team whose answer was lost is sent again");
  assert.equal(after[2].url, `${BASE}/activations/act-2/switch-to-copy`);
  assert.equal(after[2].body.requestKey, firstKeys[1], "the same key");
  assert.equal(after[2].rawBody, posts()[1].rawBody);
  assert.match(text(), /Juniors.*Moved/);
});

test("a copy no team of OptiMove's variable uses offers to hide OptiMove's variable, which opens its hide card", async () => {
  db.system = [sys({ clubFacts: { copyId: COPY }, actions: ["hide", "use"] })];
  db.mappings = [mappingRow()];
  await openDetail(COPY);
  assert.match(text(), /Copied from OptiMove's Total distance\./);
  db.detail[SYS] = sys({ clubFacts: { copyId: COPY }, actions: ["hide", "use"] });
  await click('[data-action="metric-variables-hide-original"]');
  await settle();
  assert.match(text(), /Hide Total distance for my club/);
});

test("a failed lookup of the original on an ordinary club variable shows no error banner", async () => {
  db.overrides.push({ match: (c) => c.method === "GET" && new URL(c.url, "http://x").searchParams.get("scope") === "system", answer: () => ({ status: 500, body: { error: "internal_error" } }) });
  await openDetail(COPY);
  await settle();
  assert.ok(!/could not be read/.test(text()));
});

test("a copy made within the cache window still finds its original (a system write drops the read cache)", async () => {
  db.system = [sys()];
  await openDetail(COPY); // primes the system list: no copy yet
  await openDetail(SYS);
  await click('[data-action="metric-variables-copy-open"]');
  await settle();
  db.system = [sys({ clubFacts: { usedByTeams: true, copyId: COPY }, actions: ["hide"] })];
  copyWrites(() => ({ status: 201, body: { variable: copyRow(), copiedMappings: [], replayed: false } }));
  await submit();
  await settle();
  assert.match(text(), /Copied from OptiMove's Total distance/);
});

test("opening two variables reads the mappings once, not once per variable", async () => {
  withTeamsOnOriginal();
  await openDetail(COPY);
  await openDetail(SYS);
  const mappingReads = calls.filter((c) => c.method === "GET" && new URL(c.url, "http://x").pathname === `${BASE}/mappings`).length;
  assert.equal(mappingReads, 1);
});

test("while a team's result is not confirmed a direct Move confirm sends nothing", async () => {
  withTeamsOnOriginal();
  await openDetail(COPY);
  await click('[data-action="metric-variables-move-open"]');
  const reason = $("[data-mv-move-reason]");
  reason.value = "Moving.";
  reason.dispatchEvent(new window.Event("input", { bubbles: true }));
  db.write = (call, path) => (path.includes("/act-2/") ? { throwNetworkError: true } : { status: 409, body: { error: "not_a_copy_of_this_version" } });
  await click('[data-action="metric-variables-move-confirm"]');
  const before = posts().length;
  await act({ action: "metric-variables-move-confirm" });
  assert.equal(posts().length, before);
});

test("after a partial move the list before the review names only the teams not moved, and the review says what changes", async () => {
  withTeamsOnOriginal();
  await openDetail(COPY);
  await click('[data-action="metric-variables-move-open"]');
  assert.match(text(), /These teams stop getting OptiMove's Total distance and start getting this copy/);
  const reason = $("[data-mv-move-reason]");
  reason.value = "Moving.";
  reason.dispatchEvent(new window.Event("input", { bubbles: true }));
  db.write = (call, path) => (path.includes("/act-1/") ? { status: 200, body: { ended: {}, activation: {}, replayed: false } } : { status: 409, body: { error: "activation_exists" } });
  await click('[data-action="metric-variables-move-confirm"]');
  assert.match(text(), /Not moved yet: 1 team/);
  assert.match(text(), /Try again for 1 team/);
  await click('[data-action="metric-variables-move-back"]');
  const listed = text().split("Teams that still use")[1] || "";
  assert.ok(/Juniors/.test(listed) && !/First team/.test(listed));
});

test("a club's own variable that is not a copy shows nothing about moving", async () => {
  db.system = [sys()];
  await openDetail(COPY);
  assert.ok(!/Copied from|Move your teams/.test(text()));
});

// ---------------------------------------------------------------------------
// The pickers
// ---------------------------------------------------------------------------
test("a picker leaves out what the club hides unless it is already chosen, and marks OptiMove's row when the club has one of the same name", () => {
  const rows = [
    { id: "a", label: "Total distance", ownerScope: "system", hiddenInClub: true },
    { id: "b", label: "Total distance", ownerScope: "club", hiddenInClub: false },
    { id: "c", label: "Top speed", ownerScope: "system", hiddenInClub: false },
  ];
  assert.deepEqual(pickable(rows).map((d) => d.id), ["b", "c"]);
  assert.deepEqual(pickable(rows, { chosen: ["a"] }).map((d) => d.id), ["a", "b", "c"], "a chosen one stays so it can be changed");
  assert.equal(pickerName(rows[0], rows), "Total distance (OptiMove)");
  assert.equal(pickerName(rows[1], rows), "Total distance");
  assert.equal(pickerName(rows[2], rows), "Top speed");
});
