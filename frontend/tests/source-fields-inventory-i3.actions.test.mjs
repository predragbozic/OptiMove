// I3 (docs/ai/gpexe-field-inventory-plan.md, section 7.3): Source fields' second list, "Available in GPEXE, not
// supported yet", over I2's GET /field-inventory. Driven through the real handlers and markup in a DOM with a fake fetch:
// the rows in plain words (never a key or a code), the platform's connection count, a club's own sentence, the endpoint
// chips and "Show supported too" as the read's query, Load more with the cursor, the search narrowing in place, the empty,
// error and busy states, team thresholds in the platform's fold only, a late answer of an older filter dropped, and
// nothing ever written.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

let respond = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => respond(call));
after(() => restoreFetch());

const { handleSourceFieldsAction, handleSourceFieldsInput, loadSourceFieldsSection, resetSourceFields } = await import("../source-fields-actions.js");
const { sourceFieldsState } = await import("../source-fields-data.js");
const { renderSourceFieldsHtml } = await import("../source-fields-view.js");
const { state } = await import("../state.js");

const FB = "/api/training-load/sources/metrics/fields";
const INV = "/api/training-load/sources/metrics/field-inventory";
const CLUB = "11111111-0000-4000-8000-000000000001";

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderSourceFieldsHtml(); };
content.addEventListener("input", (event) => handleSourceFieldsInput(event.target));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const inventoryGets = () => calls.filter((c) => c.method === "GET" && c.url.startsWith(INV)).map((c) => c.url);
const rows = () => [...content.querySelectorAll("[data-sf-inv-row]")];
const shownNames = () => rows().filter((r) => !r.hidden).map((r) => r.querySelector(".metric-variables-item-name").textContent.trim());
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleSourceFieldsAction(element, { render });
}

const item = (over = {}) => ({ endpoint: "details.session", name: "metabolic_power", kind: "unit_value_object", unitWord: "W/kg", answersSeen: 12, lastSeenOn: "2026-11-10", covered: false, ...over });
let pages = {};
let delay = null;
function serve() {
  respond = async (call) => {
    if (call.method !== "GET") return { status: 404, body: { error: "notFound" } };
    if (call.url === FB) return { status: 200, body: { fields: [] } };
    if (call.url.startsWith(INV)) {
      if (delay) await delay(call.url);
      const answer = pages[call.url] ?? pages.default;
      return typeof answer === "function" ? answer(call) : answer;
    }
    return { status: 404, body: { error: "notFound" } };
  };
}
const ok = (fields, nextCursor = null) => ({ status: 200, body: { fields, nextCursor } });

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asClub() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "club_admin" } };
}

beforeEach(() => {
  resetSourceFields();
  calls.length = 0;
  pages = {};
  delay = null;
  state.trainingLoad.section = "source-fields";
  asPlatform();
  serve();
});

test("1. a platform admin: the second list in plain words - where the name comes from, its kind, the unit, the answers, the last day and the connections - never a key, an endpoint code or an id", async () => {
  pages.default = ok([
    item({ connectionCount: 2 }),
    item({ endpoint: "athlete_session", name: "a_b", kind: "number", unitWord: null, answersSeen: 1, lastSeenOn: "2026-11-14", connectionCount: 1 }),
  ]);
  await loadSourceFieldsSection(render);
  assert.deepEqual(inventoryGets(), [INV], "one read, the default filter (not supported)");
  assert.match(text(), /Available in GPEXE, not supported yet/);
  // G1b: the platform admin can act on a name now (Create field); the club's sentence keeps "nothing to do" (test 2).
  assert.match(text(), /GPEXE also sends these values in the clubs' sessions\. OptiMove does not use them yet, so they are not imported\. Create field, where it is offered, turns a number GPEXE sends into a source field; the other names cannot become a field yet\./);
  const facts = rows().map((r) => r.querySelector(".metric-variables-item-facts").textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(facts, [
    "Whole session · number with unit in W/kg · seen 12 times, last 10.11.2026 · in 2 GPEXE accounts",
    "Per athlete · number · seen 1 time, last 14.11.2026 · in 1 GPEXE account",
  ]);
  assert.doesNotMatch(text(), /details\.session|athlete_session|unit_value_object|complementary_data/, "no endpoint or kind code in what is shown (codes live only in data- attributes)");
});

test("2. a club admin: the club's own sentence, no connection count and no team thresholds", async () => {
  asClub();
  // A count in the answer is never shown to a club, even if the server sent one.
  pages.default = ok([item({ unitWord: null, connectionCount: 3 })]);
  await loadSourceFieldsSection(render);
  assert.match(text(), /GPEXE also sends these values in your sessions\./);
  assert.doesNotMatch(text(), /GPEXE account/);
  assert.equal($(".source-fields-inventory-thresholds"), null, "the thresholds fold is the platform's");
  assert.match(rows()[0].textContent, /Whole session · number with unit · seen 12 times/);
});

test("3. the endpoint chips and Show supported too become the read's query; the chosen chip is pressed; supported names carry a badge", async () => {
  pages.default = ok([item()]);
  pages[`${INV}?endpoint=athlete_session`] = ok([item({ endpoint: "athlete_session", name: "only_rows", kind: "number" })]);
  pages[`${INV}?state=all&endpoint=athlete_session`] = ok([item({ endpoint: "athlete_session", name: "total_distance", kind: "number", covered: true }), item({ endpoint: "athlete_session", name: "only_rows", kind: "number" })]);
  await loadSourceFieldsSection(render);
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="athlete_session"]');
  assert.equal(inventoryGets().at(-1), `${INV}?endpoint=athlete_session`);
  assert.equal($('[data-endpoint="athlete_session"]').getAttribute("aria-pressed"), "true");
  assert.equal($('[data-endpoint=""]').getAttribute("aria-pressed"), "false");
  assert.deepEqual(shownNames(), ["only_rows"]);
  await click('[data-action="source-fields-inv-supported"]');
  assert.equal(inventoryGets().at(-1), `${INV}?state=all&endpoint=athlete_session`);
  assert.ok($('[data-action="source-fields-inv-supported"]').checked);
  assert.match(rows()[0].textContent, /total_distance\s*Already used/);
  const before = inventoryGets().length;
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="athlete_session"]');
  assert.equal(inventoryGets().length, before, "the chip already chosen reads nothing again");
});

test("4. Load more sends the cursor and adds the next page; the button goes when there is no next page", async () => {
  pages.default = ok([item({ name: "first" })], "CURSOR_1");
  pages[`${INV}?cursor=CURSOR_1`] = ok([item({ name: "second" })]);
  await loadSourceFieldsSection(render);
  await click('[data-action="source-fields-inv-more"]');
  assert.equal(inventoryGets().at(-1), `${INV}?cursor=CURSOR_1`);
  assert.deepEqual(shownNames(), ["first", "second"]);
  assert.equal($('[data-action="source-fields-inv-more"]'), null);
});

test("5. the search narrows the loaded names in place, ignoring case, keeps its field, and says when nothing matches", async () => {
  pages.default = ok([item({ name: "metabolic_power" }), item({ name: "Speed_Zone_A", endpoint: "more.complementary_data", kind: "zone_list" })]);
  await loadSourceFieldsSection(render);
  const input = $("[data-sf-inv-search]");
  input.value = "speed";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(shownNames(), ["Speed_Zone_A"]);
  assert.equal($("[data-sf-inv-search]"), input, "the same field: it keeps its focus while typing");
  assert.ok($("#sf-inv-no-match").hidden);
  input.value = "nothing-like-it";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(shownNames(), []);
  assert.equal($("#sf-inv-no-match").hidden, false);
  render();
  assert.equal($("[data-sf-inv-search]").value, "nothing-like-it", "a redraw keeps the search and its result");
  assert.deepEqual(shownNames(), []);
});

test("6. the empty list, a refusal with Try again, and a busy server each say so; Try again reads again", async () => {
  pages.default = ok([]);
  await loadSourceFieldsSection(render);
  assert.match(text(), /No names yet\. They appear after the next Find new sessions in Imports\./);
  resetSourceFields();
  pages.default = { status: 409, body: { error: "try_again" } };
  await loadSourceFieldsSection(render);
  assert.match(text(), /The server was busy\. Try again in a moment\./);
  pages.default = ok([item()]);
  await click('[data-action="source-fields-inv-reload"]');
  assert.deepEqual(shownNames(), ["metabolic_power"]);
  resetSourceFields();
  pages.default = { status: 404, body: { error: "notFound" } };
  await loadSourceFieldsSection(render);
  assert.match(text(), /The names GPEXE sent are not available in this workspace\./);
});

test("7. team thresholds: the platform's fold reads them only when asked, with endpoint=team_thresholds", async () => {
  pages.default = ok([item()]);
  pages[`${INV}?endpoint=team_thresholds`] = ok([item({ endpoint: "team_thresholds", name: "max_speed", kind: "number", unitWord: "m/s", covered: null, connectionCount: 1 })]);
  await loadSourceFieldsSection(render);
  assert.deepEqual(inventoryGets(), [INV], "not read before it is asked for");
  assert.match(text(), /Team zone limits \(from GPEXE\)/);
  await click('[data-action="source-fields-inv-thresholds"]');
  assert.equal(inventoryGets().at(-1), `${INV}?endpoint=team_thresholds`);
  const threshold = $("[data-sf-threshold-row]");
  assert.match(threshold.textContent, /max_speed/);
  assert.match(threshold.textContent.replace(/\s+/g, " "), /max_speed number in m\/s · seen 12 times/);
  assert.equal($(".source-fields-inventory-thresholds").open, true, "the fold stays open after its rows load (code review)");
  assert.equal(rows().length, 1, "the thresholds never join the not-supported list");
});

test("8. a late answer of an older filter is dropped: the chosen chip's answer stays", async () => {
  let release;
  pages.default = ok([item({ name: "late_all" })]);
  pages[`${INV}?endpoint=more.events`] = ok([item({ endpoint: "more.events", name: "events_only", kind: "number" })]);
  delay = (url) => (url === INV ? new Promise((resolve) => { release = resolve; }) : Promise.resolve());
  const first = loadSourceFieldsSection(render);
  await new Promise((resolve) => setTimeout(resolve, 0));
  delay = null;
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="more.events"]');
  release();
  await first;
  assert.deepEqual(shownNames(), ["events_only"]);
});

test("9. the list only reads: no write is ever sent", async () => {
  pages.default = ok([item()], "C1");
  pages[`${INV}?cursor=C1`] = ok([item({ name: "more_one" })]);
  await loadSourceFieldsSection(render);
  await click('[data-action="source-fields-inv-more"]');
  await click('[data-action="source-fields-inv-supported"]');
  await click('[data-action="source-fields-inv-thresholds"]');
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(sourceFieldsState().form, null);
});

test("4b. Load more is not sent while Try again reads the list from the start; the reload's answer is the list", async () => {
  pages.default = ok([item({ name: "first" })], "C1");
  pages[`${INV}?cursor=C1`] = { status: 409, body: { error: "try_again" } };
  await loadSourceFieldsSection(render);
  await click('[data-action="source-fields-inv-more"]');
  assert.match(text(), /The server was busy/);
  let release;
  delay = (url) => (url === INV ? new Promise((resolve) => { release = resolve; }) : Promise.resolve());
  pages.default = ok([item({ name: "fresh" })]);
  const reload = handleSourceFieldsAction($('[data-action="source-fields-inv-reload"]'), { render });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = inventoryGets().length;
  const more = $('[data-action="source-fields-inv-more"]');
  if (more) await handleSourceFieldsAction(more, { render });
  assert.equal(inventoryGets().length, before, "no Load more while the list is read again");
  release();
  await reload;
  assert.deepEqual(shownNames(), ["fresh"]);
});

test("4c. a read from the start is not sent while Load more is in flight; the page it loads is appended once", async () => {
  pages.default = ok([item({ name: "first" })], "C1");
  pages[`${INV}?cursor=C1`] = { status: 409, body: { error: "try_again" } };
  await loadSourceFieldsSection(render);
  await click('[data-action="source-fields-inv-more"]');
  assert.match(text(), /The server was busy/);
  let release;
  delay = (url) => (url === `${INV}?cursor=C1` ? new Promise((resolve) => { release = resolve; }) : Promise.resolve());
  pages[`${INV}?cursor=C1`] = ok([item({ name: "second" })]);
  const more = handleSourceFieldsAction($('[data-action="source-fields-inv-more"]'), { render });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = inventoryGets().length;
  const reload = $('[data-action="source-fields-inv-reload"]');
  if (reload) await handleSourceFieldsAction(reload, { render });
  assert.equal(inventoryGets().length, before, "no read from the start while Load more runs");
  release();
  await more;
  assert.deepEqual(shownNames(), ["first", "second"]);
});

test("7b. the team zone limits fold keeps the state the admin left it in across repaints", async () => {
  const { sourceFieldsThresholdsToggled } = await import("../source-fields-actions.js");
  pages.default = ok([item()]);
  await loadSourceFieldsSection(render);
  assert.equal($(".source-fields-inventory-thresholds").open, false);
  sourceFieldsThresholdsToggled(true);
  render();
  assert.equal($(".source-fields-inventory-thresholds").open, true);
  sourceFieldsThresholdsToggled(false);
  render();
  assert.equal($(".source-fields-inventory-thresholds").open, false);
});

test("5b. with more names to load, a search without a match says to load more", async () => {
  pages.default = ok([item({ name: "metabolic_power" })], "C9");
  await loadSourceFieldsSection(render);
  const input = $("[data-sf-inv-search]");
  input.value = "speed";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match($("#sf-inv-no-match").textContent, /No name matches among the names loaded so far\. Load more to search the rest\./);
});
