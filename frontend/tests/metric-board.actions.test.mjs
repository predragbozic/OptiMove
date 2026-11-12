// Training Load -> Data configuration -> Map by drag and drop (J18, 18-4), driven through the real handlers and the
// real markup in a DOM, against a fake server that answers what the real routes answered in a disposable world (the
// fixture was captured from the e2e scenario; invented names). It proves who is offered the board, what the screen
// sends (identities and the display unit only - never a value, an athlete or an owner), the tick that gates the save,
// the lost answer with its one request key, the refusal sentences, the leave guards and the Mappings sentence.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let confirmAnswer = true;
const confirmQuestions = [];
dom.window.confirm = (question) => { confirmQuestions.push(question); return confirmAnswer; };
globalThis.confirm = dom.window.confirm;
let phone = false;
dom.window.matchMedia = (q) => ({ matches: /max-width/.test(q) ? phone : !phone, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.matchMedia = dom.window.matchMedia;

const FX = JSON.parse(readFileSync(new URL("./support/metric-board-fixture.json", import.meta.url), "utf8"));
const TEAM = FX.board.board.team.id;
const CLUB = FX.connections.connections[0].ownerClubId;
const FIELD = FX.placement.placement.fieldId;
const TARGET = FX.placement.placement.targetId;
const B = "/api/training-load/sources/metrics";

let overrides = [];
let saved = false;
const calls = installFetchMock((call) => {
  for (const o of overrides) { const r = o(call); if (r) return r; }
  const url = call.url;
  if (url.startsWith("/api/training-load/sources/gpexe/connections?")) return { status: 200, body: FX.connections };
  if (url.startsWith(`${B}/board/placement?`)) return { status: 200, body: FX.placement };
  if (url.startsWith(`${B}/board?`)) return { status: 200, body: saved ? FX.boardAfter : FX.board };
  if (url === `${B}/confirmations` && call.method === "POST") { saved = true; return { status: 200, body: FX.saveAnswer }; }
  if (url.startsWith(`${B}/confirmations?`)) return { status: 200, body: FX.confirmations };
  if (/\/activations\/[^/]+\/end$/.test(url)) return { status: 200, body: FX.endAnswer };
  return { status: 404, body: { error: "not_found" } };
});
after(() => restoreFetch());

const actions = await import("../metric-board-actions.js");
const data = await import("../metric-board-data.js");
const { renderBoardHtml } = await import("../metric-board-view.js");
const { renderDataConfigHomeHtml } = await import("../data-config-home-view.js");
const mappings = await import("../metric-mappings-data.js");
const { variablesState } = await import("../metric-variables-data.js");
const { state } = await import("../state.js");
const home = () => renderDataConfigHomeHtml(variablesState(), { owner: "club" });

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderBoardHtml(); };
const asUser = (type, scopeId = CLUB) => { state.currentUser = { id: "u1", activeWorkspace: { type, scopeId, label: "Example Club" } }; };
const click = async (selector) => {
  const el = content.querySelector(selector);
  assert.ok(el, `no element for ${selector}`);
  await actions.handleBoardAction(el, { render });
};
const tick = (selector, checked) => {
  const el = content.querySelector(selector);
  assert.ok(el, `no element for ${selector}`);
  el.checked = checked;
  actions.handleBoardInput(el, { render });
};
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((c) => c.method === "POST");

beforeEach(async () => {
  calls.length = 0;
  overrides = [];
  saved = false;
  phone = false;
  confirmAnswer = true;
  confirmQuestions.length = 0;
  asUser("club");
  state.activeTab = "training-load";
  state.trainingLoad.section = "board";
  state.trainingLoad.board = null;
});

async function open() {
  await actions.loadBoardSection(render);
  assert.ok(content.querySelector("[data-mb-board]"), "the board is drawn");
}
async function place() {
  await click(`[data-action="metric-board-pick"][data-field-id="${FIELD}"]`);
  await click(`[data-action="metric-board-place"][data-variable-id="${TARGET}"]`);
  assert.ok(content.querySelector("[data-mb-tick]"), "the panel with the tick is open");
}

test("1. the board is offered in a club workspace only: no card, no context and no request elsewhere", async () => {
  for (const type of ["team", "platform", "private_coach", "athlete"]) {
    asUser(type);
    assert.equal(data.boardContext(), null, type);
    assert.ok(!home().includes('data-section="board"'), `${type}: no card`);
    state.trainingLoad.board = null;
    await actions.loadBoardSection(render);
    assert.equal(calls.length, 0, `${type}: nothing is asked`);
    assert.ok(!content.querySelector("[data-mb-board]"), `${type}: no board`);
  }
  asUser("club");
  assert.deepEqual(data.boardContext(), { clubId: CLUB, clubName: "Example Club" });
  assert.ok(home().includes('data-section="board"'));
});

test("2. one team: the board opens at once, with the columns, the two athletes and what is on", async () => {
  await open();
  assert.deepEqual(calls.map((c) => c.url), [`/api/training-load/sources/gpexe/connections?clubId=${CLUB}`, `${B}/board?teamId=${TEAM}`]);
  const t = text();
  assert.ok(t.includes("Ana Example") && t.includes("Bojan Example"));
  assert.ok(t.includes("On for First team"));
  assert.ok(t.includes("Total distance (km)"));
  assert.equal(content.querySelector('[data-action="metric-board-review"]').disabled, true, "nothing to save yet");
  assert.equal(content.querySelectorAll('[data-mb-drag-field]').length, 1, "only the free column drags");
});

test("3. two teams: the screen asks which team and reads the board of the chosen one", async () => {
  const two = structuredClone(FX.connections);
  two.connections[0].boundTeams.push({ ...two.connections[0].boundTeams[0], teamId: "70707070-0000-4000-8000-000000000002", teamName: "Second team", sourceTeamId: "7002" });
  two.connections[0].boundTeams.push({ ...two.connections[0].boundTeams[0], teamId: "70707070-0000-4000-8000-000000000003", teamName: "Ended team", state: "ended" });
  overrides.push((c) => (c.url.includes("/gpexe/connections?") ? { status: 200, body: two } : null));
  await actions.loadBoardSection(render);
  assert.ok(text().includes("Which team?"));
  assert.equal(content.querySelectorAll('[data-action="metric-board-team"]').length, 2, "an ended binding is not offered");
  assert.equal(calls.length, 1);
  await click(`[data-action="metric-board-team"][data-team-id="${TEAM}"]`);
  assert.equal(calls.at(-1).url, `${B}/board?teamId=${TEAM}`);
});

test("4. tap a column, then a variable: one placement read, the proposed conversion and both athletes' values", async () => {
  await open();
  await place();
  const q = new URL(`http://x${calls.at(-1).url}`).searchParams;
  assert.deepEqual([...q.keys()].sort(), ["candidateId", "fieldId", "pair", "targetId", "teamId"].sort());
  assert.equal(q.get("fieldId"), FIELD);
  assert.equal(q.get("targetId"), TARGET);
  const t = text();
  assert.ok(t.includes("m → km (× 0.001)"));
  assert.ok(t.includes("3000 m") && t.includes("3 km") && t.includes("3000.0 m"));
  assert.ok(t.includes("1500 m") && t.includes("1.5 km") && t.includes("1500.0 m"));
  assert.equal(content.querySelector("[data-mb-tick]").checked, false, "never ticked for the admin");
  assert.equal(content.querySelector("[data-mb-required]").checked, true);
});

test("5. the save is not offered until every new row is ticked; the body carries identities only", async () => {
  await open();
  await place();
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  const save = content.querySelector('[data-action="metric-board-save"]');
  assert.ok(!save || save.disabled, "an unticked row cannot be saved");
  await actions.handleBoardAction({ dataset: { action: "metric-board-save" }, getAttribute: () => null }, { render });
  assert.equal(posts().length, 0, "the handler itself refuses an unticked row");
  await click(`[data-action="metric-board-compare"][data-field-id="${FIELD}"]`);
  tick("[data-mb-tick]", true);
  tick("[data-mb-required]", false);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  await click('[data-action="metric-board-save"]');
  assert.equal(posts().length, 1);
  const body = posts()[0].body;
  assert.equal(posts()[0].url, `${B}/confirmations`);
  assert.deepEqual(Object.keys(body).sort(), ["candidateId", "pair", "requestKey", "rows", "teamId"]);
  assert.match(body.requestKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.rows, [{ ...FX.saveRequest.rows[0], requirement: "optional" }]);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ["checked", "displayUnit", "expectedTargetVersionId", "fieldId", "kind", "placementHash", "replaces", "requirement", "targetId"]);
  const raw = JSON.stringify(body);
  for (const leak of ["Ana", "Bojan", "3000", "1500", "0.001", CLUB]) assert.ok(!raw.includes(leak), `the body carries no ${leak}`);
  const t = text();
  assert.ok(t.includes("Saved.") && t.includes("Switched on for First team"));
  assert.ok(content.querySelector(".mb-slot.is-on")?.textContent.includes("On for First team"));
  assert.equal(data.unsavedCount(), 0);
});

test("6. a lost answer: Result not confirmed, and Check result sends the very same request", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  let lose = true;
  overrides.push((c) => (c.method === "POST" && lose ? { throwNetworkError: true } : null));
  await click('[data-action="metric-board-save"]');
  assert.ok(text().includes("Result not confirmed"));
  assert.equal(actions.boardUnloadShouldWarn(), true);
  confirmAnswer = false;
  assert.equal(actions.boardMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /not known/);
  lose = false;
  await click('[data-action="metric-board-check-result"]');
  assert.equal(posts().length, 2);
  assert.deepEqual(posts()[1].body, posts()[0].body, "the same key and the same rows");
  assert.ok(text().includes("Saved."));
  assert.equal(actions.boardUnloadShouldWarn(), false);
});

test("7. a stated refusal saves nothing, says so, keeps the placement and takes its tick away", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  overrides.push((c) => (c.method === "POST" ? { status: 409, body: { error: "board_changed", current: { rowIndex: 0 } } } : null));
  await click('[data-action="metric-board-save"]');
  assert.ok(text().includes(data.BOARD_ERROR.board_changed));
  const p = state.trainingLoad.board.placements[FIELD];
  assert.ok(p, "the placement is kept");
  assert.equal(p.checked, false, "the marked row is compared again");
  assert.equal(state.trainingLoad.board.write, null);
});

test("8. a placement the server refuses is explained and never becomes a row", async () => {
  await open();
  overrides.push((c) => (c.url.includes("/board/placement?") ? { status: 200, body: { placement: { placeable: false, code: "conversion_unavailable", sourceUnit: "m", targetUnit: "min" } } } : null));
  await click(`[data-action="metric-board-pick"][data-field-id="${FIELD}"]`);
  await click(`[data-action="metric-board-place"][data-variable-id="${TARGET}"]`);
  assert.ok(text().includes("The units do not match: GPEXE sends values in m, and the variable is in min."));
  assert.equal(content.querySelector("[data-mb-tick]"), null);
  assert.equal(data.unsavedCount(), 0);
});

test("9. Switch off asks first, sends the activation's end once, and reads the board again", async () => {
  await open();
  const on = FX.board.board.on[0];
  await click(`[data-action="metric-board-switch-off-open"][data-activation-id="${on.activationId}"]`);
  assert.equal(posts().length, 0);
  await click('[data-action="metric-board-switch-off"]');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, `${B}/activations/${on.activationId}/end`);
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["expectedState", "reason", "requestKey"]);
  assert.equal(posts()[0].body.expectedState, "open");
  assert.equal(calls.at(-1).url, `${B}/board?teamId=${TEAM}`);
});

test("10. leaving with an unsaved placement asks; Cancel removes it; Escape closes the panel", async () => {
  await open();
  await place();
  assert.equal(data.unsavedCount(), 1);
  confirmAnswer = false;
  assert.equal(actions.boardMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /Discard the 1 change/);
  assert.equal(actions.closeBoardOverlay(render), true);
  assert.equal(content.querySelector("[data-mb-tick]"), null);
  assert.equal(data.unsavedCount(), 0, "a placement never kept goes with its panel");
  assert.equal(actions.boardMayBeLeft(), true);
  assert.equal(actions.closeBoardOverlay(render), false, "nothing left to close");
});

test("11. History is the second tab: who confirmed, the session, the rows - and no athlete name", async () => {
  await open();
  await click('[data-action="metric-board-tab"][data-board-tab="history"]');
  assert.equal(calls.at(-1).url, `${B}/confirmations?teamId=${TEAM}`);
  const t = text();
  assert.ok(t.includes("Club Admin Example"));
  assert.ok(t.includes("TotDist → Total distance (km)"));
  assert.ok(t.includes("Compared with two athletes"));
  assert.ok(!t.includes("Ana Example") && !t.includes("Bojan Example"));
});

test("12. the board's 404 reads as not available; a phone gets the sheet instead of the side panel", async () => {
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 404, body: { error: "not_found" } } : null));
  await actions.loadBoardSection(render);
  assert.ok(text().includes(data.BOARD_ERROR.notFound));
  overrides = [];
  state.trainingLoad.board = null;
  phone = true;
  await open();
  assert.equal(content.querySelectorAll("[data-mb-drag-field]").length, 0, "nothing drags on a phone");
  await click(`[data-action="metric-board-pick"][data-field-id="${FIELD}"]`);
  assert.ok(content.querySelector(".mb-sheet")?.textContent.includes("Fill which variable?"));
  assert.equal(content.querySelectorAll(".mb-sheet").length, 1, "one sheet at a time");
  await click(`.mb-sheet [data-action="metric-board-place"][data-variable-id="${TARGET}"]`);
  assert.equal(content.querySelectorAll(".mb-sheet").length, 1);
  assert.ok(content.querySelector(".mb-sheet [data-mb-tick]"));
});

test("13. Mappings: a club admin's refused activation names the board", () => {
  assert.equal(mappings.refusalText("activate", { code: "confirmation_required", status: 409 }), "Switch this version on from Map by drag and drop.");
});

test("14. hostile names are escaped", async () => {
  const evil = structuredClone(FX.board);
  evil.board.columns.find((c) => c.fieldId === FIELD).label = `<img src=x onerror=alert(1)>`;
  evil.board.pair.labels = [`<b>A</b>`, `"><script>x</script>`];
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 200, body: evil } : null));
  await open();
  assert.equal(content.querySelector("img"), null);
  assert.equal(content.querySelector("script"), null);
  assert.equal(content.querySelector(".mb-pair b"), null);
});
