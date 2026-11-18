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

test("1. the board is offered in a club workspace and (S) the platform workspace only: no card, no context and no request elsewhere", async () => {
  for (const type of ["team", "private_coach", "athlete"]) {
    asUser(type);
    assert.equal(data.boardContext(), null, type);
    assert.ok(!home().includes('data-section="board"'), `${type}: no card`);
    state.trainingLoad.board = null;
    await actions.loadBoardSection(render);
    assert.equal(calls.length, 0, `${type}: nothing is asked`);
    assert.ok(!content.querySelector("[data-mb-board]"), `${type}: no board`);
  }
  asUser("club");
  assert.deepEqual(data.boardContext(), { clubId: CLUB, clubName: "Example Club", isPlatformAdmin: false });
  assert.ok(home().includes('data-section="board"'));
  asUser("platform", null);
  assert.deepEqual(data.boardContext(), { platform: true, clubId: null, clubName: "", isPlatformAdmin: true });
  assert.ok(home().includes('data-section="board"'));
  assert.match(home(), /onto an OptiMove variable, for any linked team/);
});

// S: the platform board (the owner, 2026-11-17).
function platformWorld(board) {
  overrides.push((call) => {
    if (call.url === `${B}/board/teams`) return { status: 200, body: { teams: [
      { clubId: "c-1", clubName: "North Club", teamId: TEAM, teamName: "First Team" },
      { clubId: "c-2", clubName: "South Club", teamId: "t-2", teamName: "Juniors" },
    ], truncated: false } };
    if (call.url.startsWith(`${B}/board?`)) return { status: 200, body: { board } };
    return null;
  });
}
const platformBoard = () => {
  const b = structuredClone(FX.board.board);
  b.owner = "system";
  b.variables = b.variables.filter((v) => v.ownerScope === "system").map((v) => ({ ...v, placeable: true }));
  return b;
};

test("S1. the platform board asks one question - which team - over every club's linked teams, named club and team; never the club's connection list", async () => {
  asUser("platform", null);
  platformWorld(platformBoard());
  await actions.loadBoardSection(render);
  assert.ok(calls.some((c) => c.url === `${B}/board/teams`), "the platform board's team list");
  assert.ok(!calls.some((c) => c.url.startsWith("/api/training-load/sources/gpexe/connections")), "no club connection list");
  const teams = [...content.querySelectorAll('[data-action="metric-board-team"]')].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(teams, ["North Club · First Team", "South Club · Juniors"]);
  await click(`[data-action="metric-board-team"][data-team-id="${TEAM}"]`);
  assert.ok(calls.some((c) => c.url.startsWith(`${B}/board?`) && c.url.includes(`teamId=${TEAM}`)));
});

test("S2. the platform board's variables are OptiMove's only, with New variable; the club's sentences are not shown", async () => {
  asUser("platform", null);
  platformWorld(platformBoard());
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  const t = text();
  assert.match(t, /OptiMove's variables\. What you save here becomes OptiMove's mapping\. It is switched on for this team only/);
  assert.ok(content.querySelector('[data-action="training-load-section"][data-section="variables"]'), "New variable leads to Variables");
  assert.match(t, /New variable/);
  assert.doesNotMatch(t, /Your club's variables|Your club has no variable/);
  assert.match(t, /onto an OptiMove variable|then an OptiMove variable/);
  assert.equal(data.placementRefusal({ code: "source_metric_target_taken" }), "This column already fills another OptiMove variable. Change that in Mappings.");
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
  assert.ok(t.includes("3000 m") && t.includes("3 km") && t.includes("1500 m") && t.includes("1.5 km"));
  // What GPEXE sends, what OptiMove stores, what the GPEXE screen should show (whole metres, the server's rule).
  const cells = [...content.querySelectorAll(".mb-table tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
  assert.deepEqual(cells, [["Ana Example", "3000 m", "3 km", "3000 m"], ["Bojan Example", "1500 m", "1.5 km", "1500 m"]]);
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
  assert.match(content.querySelector("#mb-outcome").textContent.replace(/\s+/g, " "), /Switched off\. .+ → .+ is off for First team\./);
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

// ---- After the internal reviews of 8c1fad8e ----
const { resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
async function toUnconfirmedSave() {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  overrides.push((c) => (c.method === "POST" && c.url === `${B}/confirmations` && posts().length <= 1 ? { throwNetworkError: true } : null));
  await click('[data-action="metric-board-save"]');
  assert.equal(state.trainingLoad.board.write?.unconfirmed, true);
}

test("15. Check result that gets no verdict (signed out, no access, busy, a failed server) stays not confirmed and keeps the key", async () => {
  await toUnconfirmedSave();
  for (const [status, body, note] of [[401, { error: "unauthorized" }, /signed out/], [404, { error: "not_found" }, /no access/], [409, { error: "try_again" }, /still not confirmed/], [500, { error: "internal_error" }, /still not confirmed/]]) {
    overrides = [(c) => (c.method === "POST" ? { status, body } : null)];
    await click('[data-action="metric-board-check-result"]');
    assert.equal(state.trainingLoad.board.write?.unconfirmed, true, `${status} settles nothing`);
    assert.ok(text().includes("Result not confirmed"), String(status));
    assert.match(text(), note);
    assert.ok(!text().includes("Nothing was saved"), String(status));
    assert.equal(actions.boardUnloadShouldWarn(), true);
  }
  overrides = [];
  await click('[data-action="metric-board-check-result"]');
  const sent = posts().map((c) => JSON.stringify(c.body));
  assert.equal(new Set(sent).size, 1, "every attempt was the same request");
  assert.ok(text().includes("Saved."));
});

test("16. Check result that the service refuses by name says nothing was saved", async () => {
  await toUnconfirmedSave();
  overrides = [(c) => (c.method === "POST" ? { status: 409, body: { error: "board_changed" } } : null)];
  await click('[data-action="metric-board-check-result"]');
  assert.equal(state.trainingLoad.board.write, null);
  assert.ok(text().includes(data.BOARD_ERROR.board_changed));
});

test("17. on a phone a lost answer is shown inside the review sheet, with Check result in reach", async () => {
  phone = true;
  await open();
  await click(`[data-action="metric-board-pick"][data-field-id="${FIELD}"]`);
  await click(`.mb-sheet [data-action="metric-board-place"][data-variable-id="${TARGET}"]`);
  tick(".mb-sheet [data-mb-tick]", true);
  await click('.mb-sheet [data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  let lose = true;
  overrides.push((c) => (c.method === "POST" && lose ? { throwNetworkError: true } : null));
  await click('.mb-sheet [data-action="metric-board-save"]');
  const sheet = content.querySelector(".mb-sheet");
  assert.ok(sheet.textContent.includes("Result not confirmed"));
  assert.ok(sheet.querySelector('[data-action="metric-board-check-result"]'));
  assert.equal(content.querySelectorAll('[data-action="metric-board-check-result"]').length, 1, "said once");
  lose = false;
  await click('.mb-sheet [data-action="metric-board-check-result"]');
  assert.equal(content.querySelector(".mb-sheet"), null);
  assert.ok(text().includes("Saved."));
});

test("18. Other athletes takes every tick away at once and holds the save until each placement is read again", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  let release;
  const held = new Promise((r) => { release = r; });
  overrides.push((c) => (c.url.includes("/board/placement?") ? held.then(() => ({ status: 200, body: FX.placement })) : null));
  const going = actions.handleBoardAction({ dataset: { action: "metric-board-other-athletes" }, getAttribute: () => null }, { render });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(calls.at(-1).url, /board\/placement\?/);
  assert.match(calls.at(-2).url, /board\?teamId=.*&pair=1/);
  assert.equal(state.trainingLoad.board.placements[FIELD].checked, false, "the tick is gone before the answer");
  assert.equal(content.querySelector('[data-action="metric-board-review"]').disabled, true, "nothing is sent meanwhile");
  release();
  await going;
  assert.equal(state.trainingLoad.board.placements[FIELD].again, true);
  assert.equal(content.querySelector('[data-action="metric-board-review"]').disabled, false);
  assert.ok(text().includes("Compare again"));
  assert.match(confirmQuestions.at(-1), /two other athletes/);
});

test("19. Switch off keeps the admin's unsaved placement (read again, unticked); its lost answer is checked with the same request", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  const on = FX.board.board.on[0];
  await click(`[data-action="metric-board-switch-off-open"][data-activation-id="${on.activationId}"]`);
  let lose = true;
  overrides.push((c) => (c.method === "POST" && lose ? { throwNetworkError: true } : null));
  await click('[data-action="metric-board-switch-off"]');
  assert.ok(text().includes("Result not confirmed"));
  assert.equal(content.querySelectorAll('[data-action="metric-board-check-result"]').length, 1);
  lose = false;
  await click('[data-action="metric-board-check-result"]');
  assert.deepEqual(posts()[1].body, posts()[0].body);
  assert.equal(state.trainingLoad.board.switchOff, null);
  const p = state.trainingLoad.board.placements[FIELD];
  assert.ok(p, "the placement survives the Switch off");
  assert.equal(p.checked, false);
});

test("20. a save holds at most 20 rows: a 21st is not added and more than 20 is not sent", async () => {
  await open();
  const s = state.trainingLoad.board;
  const many = structuredClone(FX.board.board);
  many.replaceable = Array.from({ length: 21 }, (_, i) => ({ mappingVersionId: `b0b0b0b0-0000-4000-8000-${String(i).padStart(12, "0")}`, fieldId: FIELD, variableId: `d0d0d0d0-0000-4000-8000-${String(i).padStart(12, "0")}`, placementHash: "h", badge: "club_mapping", replaces: [] }));
  s.board = many;
  for (const r of many.replaceable.slice(0, 20)) await actions.handleBoardAction({ dataset: { action: "metric-board-pre-add", versionId: r.mappingVersionId }, getAttribute: () => null }, { render });
  assert.equal(data.preplacedRows(s).length, 20);
  await actions.handleBoardAction({ dataset: { action: "metric-board-pre-add", versionId: many.replaceable[20].mappingVersionId }, getAttribute: () => null }, { render });
  assert.equal(data.preplacedRows(s).length, 20, "no 21st row");
  assert.ok(text().includes("A save holds at most 20 rows"));
  s.preplaced[many.replaceable[20].mappingVersionId] = { added: true };
  render();
  assert.equal(content.querySelector('[data-action="metric-board-review"]').disabled, true);
  await actions.handleBoardAction({ dataset: { action: "metric-board-save" }, getAttribute: () => null }, { render });
  assert.equal(posts().length, 0);
});

test("21. leaving drops what was read (names, values, the Saved notice); a workspace change drops everything and a late answer", async () => {
  await open();
  await place();
  actions.dropBoardForms();
  let s = state.trainingLoad.board;
  assert.equal(s.board, null);
  assert.equal(s.teamId, TEAM, "the team stays chosen");
  assert.equal(data.unsavedCount(s), 0);
  assert.ok(!JSON.stringify(s).includes("Ana Example"));
  calls.length = 0;
  await actions.loadBoardSection(render);
  assert.deepEqual(calls.map((c) => c.url), [`${B}/board?teamId=${TEAM}`], "the next visit reads the board again");
  let release;
  const held = new Promise((r) => { release = r; });
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? held.then(() => ({ status: 200, body: FX.board })) : null));
  actions.requestBoardOpen({ teamId: TEAM });
  const reading = actions.handleBoardAction({ dataset: { action: "metric-board-reload" }, getAttribute: () => null }, { render });
  resetTrainingLoadForWorkspaceChange();
  release();
  await reading;
  s = state.trainingLoad.board;
  assert.equal(s.board, null, "an answer for the old workspace is dropped");
  assert.equal(s.teamId, null);
  overrides = [(c) => (c.url.includes("/gpexe/connections?") ? { status: 200, body: { connections: [] } } : null)];
  calls.length = 0;
  asUser("club", "c0c0c0c0-0000-4000-8000-00000000000b");
  await actions.loadBoardSection(render);
  assert.ok(!calls.some((c) => c.url.includes(TEAM)), "the old workspace's team id is sent nowhere");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/training-load/sources/gpexe/connections?clubId=c0c0c0c0-0000-4000-8000-00000000000b", "a team asked for in the old workspace is not carried over");
});

test("22. the team list's 404 is the same neutral sentence, with nothing to retry", async () => {
  overrides.push((c) => (c.url.includes("/gpexe/connections?") ? { status: 404, body: { error: "not_found" } } : null));
  await actions.loadBoardSection(render);
  assert.ok(text().includes(data.BOARD_ERROR.notFound));
  assert.equal(content.querySelector('[data-action="metric-board-reload"]'), null);
});

test("23. a used column says why it does not move; a ticked row offers View check, not Compare", async () => {
  await open();
  assert.ok(text().includes("Already on for the team. Switch it off under Variables to place it again."));
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  assert.equal(content.querySelector(`[data-action="metric-board-compare"][data-field-id="${FIELD}"]`).textContent.trim(), "View check");
  assert.ok(text().includes("Placed. Remove it under Variables to place it elsewhere."));
});

test("24. a placement that cannot be read again for now is kept, unticked; only a 404 removes it; a refusal closes the open panel", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  const on = FX.board.board.on[0];
  await click(`[data-action="metric-board-switch-off-open"][data-activation-id="${on.activationId}"]`);
  overrides = [(c) => (c.method === "POST" ? { status: 409, body: { error: "activation_not_open" } } : null), (c) => (c.url.includes("/board/placement?") ? { status: 409, body: { error: "try_again" } } : null)];
  await click('[data-action="metric-board-switch-off"]');
  let s = state.trainingLoad.board;
  assert.equal(s.panel, null, "the panel with the values read before does not stay open");
  assert.ok(s.placements[FIELD], "a busy re-read keeps the row");
  assert.equal(s.placements[FIELD].checked, false);
  overrides = [(c) => (c.url.includes("/board/placement?") ? { status: 404, body: { error: "not_found" } } : null)];
  await actions.handleBoardAction({ dataset: { action: "metric-board-reload" }, getAttribute: () => null }, { render });
  assert.equal(state.trainingLoad.board.placements[FIELD], undefined, "a 404 removes it");
});

test("25. Other athletes that fails leaves the pair on record: Try again reads that pair, with the placement kept", async () => {
  await open();
  await place();
  await click('[data-action="metric-board-keep"]');
  overrides = [(c) => (c.url.startsWith(`${B}/board?`) ? { status: 500, body: { error: "internal_error" } } : null)];
  await actions.handleBoardAction({ dataset: { action: "metric-board-other-athletes" }, getAttribute: () => null }, { render });
  assert.match(calls.at(-1).url, /pair=1/);
  overrides = [];
  await click('[data-action="metric-board-reload"]');
  const boardRead = calls.filter((c) => c.url.startsWith(`${B}/board?`)).at(-1);
  assert.ok(!boardRead.url.includes("pair="), "the first pair again, not the next one");
  assert.ok(state.trainingLoad.board.placements[FIELD], "the unsaved placement is kept");
  assert.equal(state.trainingLoad.board.placements[FIELD].again, true);
});

test("26. leaving after a save drops the Saved notice too", async () => {
  await open();
  await place();
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  await click('[data-action="metric-board-save"]');
  assert.ok(state.trainingLoad.board.saved);
  actions.dropBoardForms();
  assert.equal(state.trainingLoad.board.saved, null);
  render();
  assert.ok(!text().includes("Saved."));
});

test("27. keys, codes and the GPEXE team's number are shown to a platform admin only; a club's admin gets one sentence and the next step", async () => {
  await open();
  for (const internal of ["Technical details", "athlete_session.", "linked to GPEXE team", "7001"]) assert.ok(!content.innerHTML.includes(internal), `a club admin sees no "${internal}"`);
  overrides.push((c) => (c.url.includes("/board/placement?") ? { status: 200, body: { placement: { placeable: false, code: "conversion_unavailable", sourceUnit: "m", targetUnit: "min" } } } : null));
  await click(`[data-action="metric-board-pick"][data-field-id="${FIELD}"]`);
  await click(`[data-action="metric-board-place"][data-variable-id="${TARGET}"]`);
  assert.ok(text().includes("The units do not match"));
  assert.ok(!content.innerHTML.includes("conversion_unavailable"), "the code stays out");
  // The same screen for a platform admin working in the club.
  state.currentUser = { id: "u2", activeWorkspace: { type: "club", scopeId: CLUB, label: "Example Club" }, availableWorkspaces: [{ type: "platform" }, { type: "club", scopeId: CLUB }] };
  render();
  for (const internal of ["Technical details", "athlete_session.total_distance", "linked to GPEXE team 7001", "conversion_unavailable"]) assert.ok(content.innerHTML.includes(internal), `a platform admin sees "${internal}"`);
});

test("28. which session the board shows, and what it says when none can be used: the date and label, the newer ones passed by, one sentence by reason with Open Imports - never 'cannot read'", async () => {
  // The header line of the board.
  const dt = () => "07.11.2026 18:00";
  assert.equal(data.sessionWords({ startedAt: "x", label: "Training", newerNotUsable: 0 }, dt), "From the session of 07.11.2026 18:00 (Training).");
  assert.equal(data.sessionWords({ startedAt: "x", label: null }, dt), "From the session of 07.11.2026 18:00.");
  assert.equal(data.sessionWords({ startedAt: "x", label: "Training", newerNotUsable: 1 }, dt), "From the session of 07.11.2026 18:00 (Training). 1 newer session cannot be used for mapping.");
  assert.equal(data.sessionWords({ startedAt: "x", label: "", newerNotUsable: 2 }, dt), "From the session of 07.11.2026 18:00. 2 newer sessions cannot be used for mapping.");
  assert.equal(data.sessionWords({ startedAt: "x", newerNotUsable: "3" }, dt), "From the session of 07.11.2026 18:00.", "only a whole number is said");
  // On the screen, from the server's answer (escaped).
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 200, body: { board: { ...FX.board.board, session: { ...FX.board.board.session, label: "<b>Evening</b> training", newerNotUsable: 2 } } } } : null));
  await open();
  assert.match(text(), /From the session of \d\d\.\d\d\.\d{4} \d\d:\d\d \(<b>Evening<\/b> training\)\. 2 newer sessions cannot be used for mapping\./);
  assert.equal(content.querySelector(".mb-note b"), null, "the label is text");
  overrides = [];
  state.trainingLoad.board = null;

  // None usable: the sentence by reason, the way to Imports, no code for a club admin.
  const none = (current) => { overrides = [(c) => (c.url.startsWith(`${B}/board?`) ? { status: 409, body: { error: "no_usable_session", message: "server words", current } } : null)]; state.trainingLoad.board = null; return actions.loadBoardSection(render); };
  await none({ reason: "unsupported_category", tried: 2 });
  assert.ok(text().includes("None of the sessions found so far can be used for mapping: the latest ones are of a type OptiMove does not import. Find a training session in Imports first."));
  assert.equal(content.querySelector('[data-action="training-load-section"][data-section="imports"]')?.textContent.trim(), "Open Imports to search");
  assert.equal(/cannot read|unsupported_category|no_usable_session|server words/.test(text()), false);
  for (const [reason, sentence] of [["candidate_too_large", "The sessions found so far are too large to read here. Run a search in Imports for a smaller session."],
    ["board_too_large", "The sessions found so far have too many athletes and columns to compare at once. Run a search in Imports for a smaller session."]]) {
    await none({ reason, tried: 1 });
    assert.ok(text().includes(sentence), reason);
    assert.ok(content.querySelector('[data-action="training-load-section"][data-section="imports"]'));
  }
  for (const current of [{ reason: "mixed", tried: 4 }, { reason: "session_stats_invalid", tried: 1 }, { reason: "constructor" }, null]) {
    await none(current);
    assert.ok(text().includes("None of the sessions found so far can be used for mapping. Run a search in Imports for another session."), JSON.stringify(current));
    assert.equal(/latest ones|cannot read|training session/.test(text()), false, "'a training session' is said only where the type is the reason");
    assert.ok(content.querySelector('[data-action="training-load-section"][data-section="imports"]'));
  }
  // A session named by the request that the import would not take: its own sentence, also never "cannot read".
  overrides = [(c) => (c.url.startsWith(`${B}/board?`) ? { status: 409, body: { error: "candidate_not_importable", current: { reason: "unsupported_category" } } } : null)];
  state.trainingLoad.board = null;
  await actions.loadBoardSection(render);
  assert.ok(text().includes("This session cannot be used for mapping. Run a search in Imports for another session."));
  assert.equal(/cannot read/.test(text()), false);
  for (const sentence of Object.values(data.BOARD_ERROR)) assert.equal(/cannot read/i.test(sentence), false, sentence);
});

test("S3. one click to the other board of the same team: a platform admin's club board offers \"Switch to OptiMove's variables\", the platform board \"Switch to the club's variables\" where the club's workspace is theirs; never when that workspace is not", async () => {
  // The club board, a platform admin working in the club.
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "Example Club" }, availableWorkspaces: [{ type: "platform", scopeId: null }, { type: "club", scopeId: CLUB }] };
  const clubBoard = structuredClone(FX.board);
  clubBoard.board.team.clubId = CLUB;
  overrides.push((call) => (call.url.startsWith(`${B}/board?`) ? { status: 200, body: clubBoard } : null));
  await open();
  const toPlatform = content.querySelector('[data-action="workspace-select"][data-mb-switch-team-id]');
  assert.ok(toPlatform, "the link is offered");
  assert.equal(toPlatform.textContent.trim(), "Switch to OptiMove's variables");
  assert.deepEqual([toPlatform.dataset.workspaceType, toPlatform.dataset.workspaceScopeId, toPlatform.dataset.mbSwitchTeamId], ["platform", "", TEAM]);
  // A club admin who is no platform admin: no link.
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "Example Club" }, availableWorkspaces: [{ type: "club", scopeId: CLUB }] };
  render();
  assert.equal(content.querySelector("[data-mb-switch-team-id]"), null);
  // The platform board: the club's workspace is theirs, then not.
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null }, availableWorkspaces: [{ type: "platform", scopeId: null }, { type: "club", scopeId: CLUB, label: "North Club" }] };
  state.trainingLoad.board = null;
  overrides = [];
  const b = platformBoard();
  b.team.clubId = CLUB;
  platformWorld(b);
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  const toClub = content.querySelector('[data-action="workspace-select"][data-mb-switch-team-id]');
  assert.equal(toClub?.textContent.trim(), "Switch to North Club's variables");
  assert.equal(toClub.getAttribute("title"), "Opens the North Club workspace on this team.");
  assert.deepEqual([toClub.dataset.workspaceType, toClub.dataset.workspaceScopeId, toClub.dataset.mbSwitchTeamId], ["club", CLUB, TEAM]);
  state.currentUser.availableWorkspaces = [{ type: "platform", scopeId: null }];
  render();
  assert.equal(content.querySelector("[data-mb-switch-team-id]"), null, "not a club admin there: no link");
});

test("S4. the switch remembers the team for the workspace the link named only: the board of the same team opens after that switch; a failed or another switch opens nothing", () => {
  actions.rememberBoardAfterSwitch({ teamId: TEAM, type: "platform", scopeId: "" });
  assert.equal(actions.takeBoardAfterSwitch({ type: "platform", scopeId: null }), TEAM);
  assert.equal(actions.takeBoardAfterSwitch({ type: "platform", scopeId: null }), null, "taken once");
  actions.rememberBoardAfterSwitch({ teamId: TEAM, type: "club", scopeId: CLUB });
  assert.equal(actions.takeBoardAfterSwitch({ type: "club", scopeId: "another-club" }), null, "another workspace became active");
  assert.equal(actions.takeBoardAfterSwitch({ type: "club", scopeId: CLUB }), null, "and nothing is left for a later switch");
  actions.rememberBoardAfterSwitch({ teamId: TEAM, type: "club", scopeId: CLUB });
  assert.equal(actions.takeBoardAfterSwitch(null), null, "a failed switch");
});

test("S5. New variable leads to Variables' create form and keeps one click back to the same team's board; back on the board it is read again", async () => {
  asUser("platform", null);
  platformWorld(platformBoard());
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  const button = content.querySelector("[data-mb-new-variable]");
  assert.ok(button);
  assert.deepEqual([button.dataset.section, button.dataset.dcView, button.dataset.mbReturnTeamId], ["variables", "variables", TEAM]);
  // What the Variables screen shows when it was opened from the board.
  const { renderVariablesHtml } = await import("../metric-variables-view.js");
  const v = variablesState();
  v.boardReturn = { teamId: TEAM, teamName: "North Club · First Team" };
  v.form = null;
  const host = document.createElement("div");
  host.innerHTML = renderVariablesHtml();
  const back = host.querySelector("[data-mb-board-return]");
  assert.ok(back, "the way back is offered");
  assert.deepEqual([back.dataset.action, back.dataset.section, back.dataset.mbTeamId], ["training-load-section", "board", TEAM]);
  assert.match(back.textContent, /Back to Map by drag and drop · North Club · First Team/);
  v.boardReturn = null;
  // Leaving the board keeps the team and drops what was read, so the next visit reads the board again.
  const before = calls.filter((c) => c.url.startsWith(`${B}/board?`)).length;
  actions.dropBoardForms();
  await actions.loadBoardSection(render);
  assert.equal(calls.filter((c) => c.url.startsWith(`${B}/board?`)).length, before + 1, "read again");
  assert.equal(data.boardState().teamId, TEAM);
});

test("S6. on the platform board a column the club fills with its own variable says so and points to the club's variables, never to a variable that is not there", async () => {
  asUser("platform", null);
  const b = platformBoard();
  b.on = [{ activationId: "a-1", mappingVersionId: "v-1", fieldId: FIELD, variableId: "club-var", requirement: "required", badge: "club_mapping", levels: { session: true, drill: true } }];
  platformWorld(b);
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  assert.match(text(), /On for the team as the club's own variable\. To change it, switch to the club's variables\./);
  assert.doesNotMatch(text(), /Switch it off under Variables to place it again/);
  assert.equal(data.placementRefusal({ code: "variable_hidden" }), "This team's club hides this OptiMove variable. It must be shown in that club's Variables first.");
});

test("S7. the platform board stores no check: its review says so, never that the athletes' values are kept, and it has no History tab", async () => {
  asUser("platform", null);
  const b = platformBoard();
  if (!b.variables.some((v) => v.id === TARGET)) b.variables.push({ ...FX.board.board.variables.find((v) => v.id === TARGET), ownerScope: "system", placeable: true });
  platformWorld(b);
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  assert.equal(content.querySelector('[data-action="metric-board-tab"]'), null, "no Map / History tabs");
  await place();
  await click(`[data-action="metric-board-compare"][data-field-id="${FIELD}"]`);
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  const note = content.querySelector("#mb-review-note").textContent;
  assert.match(note, /Saving switches OptiMove's mapping on for this team\. OptiMove records who switched it on and when\. Your tick and the two athletes' values are not kept\./);
  assert.doesNotMatch(note, /evidence|90 days/);
  // The club board keeps its tabs.
  asUser("club");
  overrides = [];
  state.trainingLoad.board = null;
  await open();
  assert.equal(content.querySelectorAll('[data-action="metric-board-tab"]').length, 2);
});

test("S8. the workspace switch's hooks: a switch that failed forgets the remembered team, and a switch through any other link replaces it with nothing", async () => {
  const { handleWorkspaceAction } = await import("../workspace-actions.js");
  const hooks = { beforeSwitch: actions.boardBeforeSwitch, afterSwitchFailed: actions.boardSwitchFailed, onWorkspaceChanged: async () => {} };
  const link = (extra = {}) => ({ dataset: { action: "workspace-select", workspaceType: "platform", workspaceScopeId: "", ...extra }, getAttribute: () => null });
  asUser("club");
  state.workspaceSwitcher = { open: false, pending: false, error: "" };
  overrides.push((c) => (c.url === "/api/auth/workspace" ? { status: 409, body: { error: "WORKSPACE_NOT_AVAILABLE" } } : null));
  await handleWorkspaceAction(link({ mbSwitchTeamId: TEAM }), hooks);
  assert.equal(state.workspaceSwitcher.pending, false);
  assert.ok(calls.some((c) => c.url === "/api/auth/workspace"), "the switch was sent");
  assert.equal(actions.takeBoardAfterSwitch({ type: "platform", scopeId: null }), null, "the failed switch left nothing behind");
  // A board link, then the ordinary workspace menu: the second switch remembers nothing.
  actions.boardBeforeSwitch(link({ mbSwitchTeamId: TEAM }));
  actions.boardBeforeSwitch(link());
  assert.equal(actions.takeBoardAfterSwitch({ type: "platform", scopeId: null }), null);
  actions.boardBeforeSwitch(link({ mbSwitchTeamId: TEAM }));
  assert.equal(actions.takeBoardAfterSwitch({ type: "platform", scopeId: null }), TEAM);
});

test("S9. S-2: a platform save that replaces the club's own mapping says so by name - the club, the column and the club's variable, which is not on the platform board - and never with an empty name", async () => {
  const { replacesPhrase } = await import("../metric-board-view.js");
  asUser("platform", null);
  const b = platformBoard();
  if (!b.variables.some((v) => v.id === TARGET)) b.variables.push({ ...FX.board.board.variables.find((v) => v.id === TARGET), ownerScope: "system", placeable: true });
  b.team = { ...b.team, clubId: "c-1", clubName: "North Club" };
  platformWorld(b);
  const collision = { activationId: "a-9", fieldId: FIELD, variableId: "club-var-not-on-this-board", owner: "club", variableLabel: "Club distance" };
  overrides.push((c) => (c.url.startsWith(`${B}/board/placement?`) ? { status: 200, body: { placement: { ...FX.placement.placement, collisions: [collision] } } } : null));
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  await place();
  const column = data.cleanName(FX.board.board.columns.find((c) => c.fieldId === FIELD).label);
  const panelText = text();
  assert.ok(panelText.includes(`replaces what is on for`) && panelText.includes(`North Club's own mapping: ${column} → Club distance`), panelText.slice(0, 600));
  assert.doesNotMatch(panelText, /→ [.;,]|→ $/, "never an empty name");
  // The review names it too.
  await click(`[data-action="metric-board-compare"][data-field-id="${FIELD}"]`);
  tick("[data-mb-tick]", true);
  await click('[data-action="metric-board-keep"]');
  await click('[data-action="metric-board-review"]');
  assert.match(text(), new RegExp(`Replaces North Club's own mapping: ${column} → Club distance\\.`));
  // A name that cannot be read: a readable column is still named, "this column" only when no column name can be read;
  // never an empty arrow.
  assert.equal(replacesPhrase(b, { ...collision, variableLabel: null }), `North Club's own mapping of ${column}`);
  assert.equal(replacesPhrase(b, { ...collision, fieldId: "no-such-column" }), "the club's own mapping of this column");
  assert.equal(replacesPhrase({ ...b, team: { ...b.team, clubName: null } }, collision), `the club's own mapping: ${column} → Club distance`);
  assert.equal(replacesPhrase(b, { activationId: "x", fieldId: "no-such-column", variableId: TARGET, owner: "system" }), "OptiMove's mapping of this column");
});

test("S10. S-2: on the club board, the club's own mapping that OptiMove's replaced reads when, and can still be put back", async () => {
  const b = structuredClone(FX.board.board);
  const own = { ...(b.preplaced[0] ?? {}), mappingVersionId: "e1e1e1e1-0000-4000-8000-000000000001", fieldId: FIELD, variableId: TARGET, badge: "club_mapping", placementHash: "h",
    replaces: [{ activationId: "a-sys", fieldId: FIELD, variableId: TARGET, owner: "system", variableLabel: "OptiMove distance" }], replacedBy: { owner: "system", at: "2026-11-17T15:30:00Z" } };
  b.preplaced = [];
  b.on = [];
  b.replaceable = [own];
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 200, body: { board: b } } : null));
  await open();
  assert.match(text(), /Replaced by OptiMove's mapping on 17\.11\.2026 · From .* · Add puts it back for First team instead of OptiMove's mapping/);
  assert.ok(content.querySelector(`[data-action="metric-board-pre-add"][data-version-id="${own.mappingVersionId}"]`), "Add puts it back");
});

test("S11. S-2: once OptiMove's mapping that replaced it is off again, the club's own mapping comes back pre-placed and still says when it was replaced", async () => {
  const b = structuredClone(FX.board.board);
  const own = { ...(b.preplaced[0] ?? {}), mappingVersionId: "e1e1e1e1-0000-4000-8000-000000000002", fieldId: FIELD, variableId: TARGET, badge: "club_mapping", placementHash: "h",
    replaces: [], replacedBy: { owner: "system", at: "2026-11-16T09:00:00Z" } };
  b.preplaced = [own];
  b.on = [];
  b.replaceable = [];
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 200, body: { board: b } } : null));
  await open();
  assert.match(text(), /Replaced by OptiMove's mapping on 16\.11\.2026 · From .* · no check needed/);
});

test("Z (the Rukovodilac, 2026-11-18): a zone or threshold column never points to Mappings, which cannot finish it today; the platform admin gets the numbered-field step, everyone else support", () => {
  const platform = data.columnReasonText("field_has_parameters", { platformAdmin: true });
  const club = data.columnReasonText("field_has_parameters");
  assert.equal(platform, "Zones and thresholds cannot be placed yet: their unit and limits need a document first. For one zone, create its numbered GPEXE field in Data configuration > Source fields and compare it with GPEXE.");
  assert.equal(club, "OptiMove cannot place zones and thresholds yet. Ask OptiMove support.");
  for (const text of [platform, club]) assert.doesNotMatch(text, /Mappings/);
});

test("Z2 (the Rukovodilac, 2026-11-18): zone and threshold columns leave the list for one closed 'Not available yet (N)' group with one sentence and a real next step - never Mappings; it keeps its open state across a repaint", async () => {
  const zone = { fieldId: "f-zone", revisionId: "r-zone", key: "more.complementary_data.power.distance", label: "Example zone set", unit: "m", unitProven: false, expectedUnit: "m", placeable: false, reason: "field_has_parameters", displayRule: null, displayUnits: [], rawA: null, rawB: null };
  const club = structuredClone(FX.board);
  club.board.columns.push(zone, { ...zone, fieldId: "f-acc", key: "more.events.acceleration", label: "Example threshold events" });
  overrides.push((c) => (c.url.startsWith(`${B}/board?`) ? { status: 200, body: club } : null));
  await open();
  const group = content.querySelector("details.mb-parked");
  assert.ok(group && !group.open, "one closed group");
  assert.equal(group.querySelector("summary").textContent.trim(), "Not available yet (2)");
  assert.match(group.textContent, /These need a zone or threshold choice that OptiMove does not offer yet\. For a single zone, ask OptiMove support to add its numbered GPEXE field\./);
  assert.ok(group.textContent.includes("Example zone set") && group.textContent.includes("Example threshold events"));
  const main = [...content.querySelectorAll(".mb-list")].find((ul) => !ul.closest(".mb-parked"));
  assert.ok(!main.textContent.includes("Example zone set"), "not in the main column list");
  assert.ok(main.textContent.includes("Power zone distance"), "a zone column that is already on stays in the list, with what is on");
  assert.doesNotMatch(text(), /Mappings/);
  actions.metricBoardParkedToggled(true);
  render();
  assert.equal(content.querySelector("details.mb-parked").open, true, "a repaint keeps it open");
  actions.metricBoardParkedToggled(false);

  asUser("platform", null);
  const b = platformBoard();
  b.columns.push(zone);
  platformWorld(b);
  state.trainingLoad.board = { ...data.emptyBoardState(), teamId: TEAM };
  await actions.loadBoardSection(render);
  assert.match(content.querySelector("details.mb-parked").textContent, /For a single zone, create its numbered GPEXE field in Data configuration > Source fields\./);
});
