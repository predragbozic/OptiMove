// Mapping board (manager, 2026-11-15, from the owner's production screenshot): values are rounded for reading only, and
// a column whose unit is not confirmed tells a platform admin the step he can take. Same harness as the board's actions test.
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


const withColumns = (patch) => {
  const answer = structuredClone(FX.board);
  patch(answer.board.columns);
  overrides.push((call) => (call.url.startsWith(`${B}/board?`) ? { status: 200, body: answer } : null));
};

test("display 1: a number is rounded for reading only - whole numbers stay, at most 2 decimals, never -0 or 1e-7, a tiny non-zero value reads <0.01", () => {
  const d = data.displayNumber;
  for (const [v, want] of [
    ["8.047761344372203", "8.05"], [6595.123077392578, "6595.12"], ["3000", "3000"], [12, "12"], ["7.10", "7.1"], ["2.5", "2.5"],
    [0.004, "<0.01"], ["1e-7", "<0.01"], [-0.004, ">-0.01"], [-0, "0"], ["-0.001", ">-0.01"], [0, "0"], ["-3.456", "-3.46"],
    [123456789.987, "123456789.99"], ["abc", "abc"],
  ]) assert.equal(d(v), want, String(v));
  assert.equal(d(null), null);
  assert.equal(d(undefined), undefined);
});

test("display 2: the board shows the rounded value with its unit, the aria-label says the same, and the exact value stays in the board's state", async () => {
  withColumns((cols) => { cols[0].rawA = "8.047761344372203"; cols[0].rawB = "0.000412"; cols[1].rawA = "6595.123077392578"; });
  await open();
  const vals = [...content.querySelectorAll(".mb-col-vals")];
  assert.equal(vals[0].innerHTML.replace(/\s+/g, " "), "8.05 m/s<br>&lt;0.01 m/s");
  assert.match(vals[0].getAttribute("aria-label"), /: 8\.05 m\/s; [^:]+: <0\.01 m\/s$/);
  assert.match(vals[1].textContent, /^6595\.12 m/);
  const shownText = `${text()} ${[...content.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")).join(" ")}`;
  assert.doesNotMatch(shownText, /8\.0477|6595\.123|\d(?:\.\d+)?e-\d/, "no long float or scientific notation on screen or in a label");
  const col = state.trainingLoad.board.board.columns[0];
  assert.equal(col.rawA, "8.047761344372203", "the exact value is kept for the comparison and the checks");
});

test("display 3: a column whose unit is not confirmed - a coach or club admin is told to ask OptiMove support; a platform admin gets the step he can take", async () => {
  // A column the team does not use, whose unit is not confirmed.
  const unconfirmed = (cols) => { const c = cols.find((x) => x.label === "TotDist"); c.unitProven = false; c.placeable = false; c.reason = "field_not_confirmed"; };
  withColumns(unconfirmed);
  await open();
  assert.match(text(), /OptiMove has not confirmed this column yet\. Ask OptiMove support to confirm it\./);
  assert.doesNotMatch(text(), /Source fields/);
  state.trainingLoad.board = null;
  overrides = [];
  withColumns(unconfirmed);
  state.currentUser = { ...state.currentUser, availableWorkspaces: [{ type: "platform" }, { type: "club", scopeId: CLUB }] };
  await open();
  assert.match(text(), /This column's unit is not confirmed yet\. Confirm it in Data configuration › Source fields \(platform workspace\)\./);
  assert.doesNotMatch(text(), /Ask OptiMove support/);
});
