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
// GPEXE's own name, small under the readable one (2026-11-18).
// The names of the rows shown, by the row's index into the loaded list (the plain view shows no GPEXE name).
const shownNames = () => rows().filter((r) => !r.hidden).map((r) => sourceFieldsState().inventory.items[Number(r.dataset.sfInvRow)].name);
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleSourceFieldsAction(element, { render });
}

// The technical view (one click away): GPEXE's own names, the counts, the sources and the names that are not values.
async function loadTech() {
  await loadSourceFieldsSection(render);
  if (!sourceFieldsState().inventory.technical) await click('[data-action="source-fields-inv-technical"]');
}

const item = (over = {}) => ({ endpoint: "details.session", name: "metabolic_power", kind: "unit_value_object", unitWord: "power", unit: "W/kg", isValue: true, zone: null, answersSeen: 12, lastSeenOn: "2026-11-10", covered: false, ...over });
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
    item({ endpoint: "athlete_session", name: "a_b", kind: "number", unitWord: null, unit: null, answersSeen: 1, lastSeenOn: "2026-11-14", connectionCount: 1 }),
  ]);
  await loadTech();
  assert.deepEqual(inventoryGets(), [INV], "one read, the default filter (not supported)");
  assert.match(text(), /More values GPEXE sends/);
  // G1b: the platform admin can act on a name now (Create field); the club's sentence keeps "nothing to do" (test 2).
  assert.match(text(), /GPEXE also sends these values in the clubs' sessions\. OptiMove does not import them yet\. Use this value adds it to OptiMove; once new sessions bring it and you have checked it against GPEXE, you can put it on a variable\./);
  // 2026-11-18: the readable name and the unit first (never GPEXE's word), GPEXE's name small, the counts last.
  const lines = rows().map((r) => [r.querySelector(".metric-variables-item-name"), r.querySelector(".source-fields-inventory-raw"), r.querySelector(".metric-variables-item-facts")].map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  assert.deepEqual(lines, [
    ["Metabolic power (W/kg)", "metabolic_power", "Whole session · seen 12 times, last 10.11.2026 · in 2 GPEXE accounts"],
    ["A b (no unit from GPEXE)", "a_b", "Per athlete · seen 1 time, last 14.11.2026 · in 1 GPEXE account"],
  ]);
  assert.doesNotMatch(text(), /number with unit in|\bpower\b · /, "GPEXE's word is never shown as the unit");
  assert.doesNotMatch(text(), /details\.session|athlete_session|unit_value_object|complementary_data/, "no endpoint or kind code in what is shown (codes live only in data- attributes)");
});

test("2. a club admin: the club's own sentence, no connection count and no team thresholds", async () => {
  asClub();
  // A count in the answer is never shown to a club, even if the server sent one.
  pages.default = ok([item({ unitWord: null, connectionCount: 3 })]);
  // The unit is the seed's (never the account's own data), so a club sees it too.
  await loadSourceFieldsSection(render);
  assert.match(text(), /GPEXE also sends these values in your sessions\./);
  assert.doesNotMatch(text(), /GPEXE account/);
  assert.equal($(".source-fields-inventory-thresholds"), null, "the thresholds fold is the platform's");
  // The plain view: the name, the unit and one state; never a count or a source.
  assert.equal(rows()[0].textContent.replace(/\s+/g, " ").trim(), "Metabolic power (W/kg) Not imported yet");
});

test("3. the endpoint chips and Show supported too become the read's query; the chosen chip is pressed; supported names carry a badge", async () => {
  pages.default = ok([item()]);
  pages[`${INV}?endpoint=athlete_session`] = ok([item({ endpoint: "athlete_session", name: "only_rows", kind: "number" })]);
  pages[`${INV}?state=all&endpoint=athlete_session`] = ok([item({ endpoint: "athlete_session", name: "total_distance", kind: "number", covered: true }), item({ endpoint: "athlete_session", name: "only_rows", kind: "number" })]);
  await loadTech();
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="athlete_session"]');
  assert.equal(inventoryGets().at(-1), `${INV}?endpoint=athlete_session`);
  assert.equal($('[data-endpoint="athlete_session"]').getAttribute("aria-pressed"), "true");
  assert.equal($('[data-endpoint=""]').getAttribute("aria-pressed"), "false");
  assert.deepEqual(shownNames(), ["only_rows"]);
  await click('[data-action="source-fields-inv-supported"]');
  assert.equal(inventoryGets().at(-1), `${INV}?state=all&endpoint=athlete_session`);
  assert.ok($('[data-action="source-fields-inv-supported"]').checked);
  const used = rows().find((r) => r.querySelector(".source-fields-inventory-raw").textContent.trim() === "total_distance");
  assert.match(used.textContent.replace(/\s+/g, " "), /Total distance .*In use/);
  const before = inventoryGets().length;
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="athlete_session"]');
  assert.equal(inventoryGets().length, before, "the chip already chosen reads nothing again");
});

test("3b (the re-review's MEDIUM): an already used family of objects that the server calls a value is drawn in a group with its badge, never in the not-values fold", async () => {
  pages.default = ok([item({ endpoint: "more.complementary_data", name: "power", kind: "object", unitWord: null, unit: null, covered: true, isValue: true })]);
  await loadTech();
  const row = rows().find((r) => r.querySelector(".source-fields-inventory-raw")?.textContent.trim() === "power");
  assert.ok(row, "the family is listed");
  assert.equal(row.closest(".source-fields-inventory-other"), null, "not folded under the names that are not values");
  assert.ok(row.closest("[data-sf-inv-group]"), "in a value group");
  assert.match(row.textContent, /In use/);
});

test("4. Load more sends the cursor and adds the next page; the button goes when there is no next page", async () => {
  pages.default = ok([item({ name: "first" })], "CURSOR_1");
  pages[`${INV}?cursor=CURSOR_1`] = ok([item({ name: "second" })]);
  await loadTech();
  await click('[data-action="source-fields-inv-more"]');
  assert.equal(inventoryGets().at(-1), `${INV}?cursor=CURSOR_1`);
  assert.deepEqual(shownNames(), ["first", "second"]);
  assert.equal($('[data-action="source-fields-inv-more"]'), null);
});

test("5. the search narrows the loaded names in place, ignoring case, keeps its field, and says when nothing matches", async () => {
  pages.default = ok([item({ name: "metabolic_power" }), item({ name: "Speed_Zone_A", endpoint: "more.complementary_data", kind: "zone_list" })]);
  await loadTech();
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
  await loadTech();
  assert.match(text(), /Nothing yet\. Values appear after the next Find new sessions in Imports\./);
  resetSourceFields();
  pages.default = { status: 409, body: { error: "try_again" } };
  await loadTech();
  assert.match(text(), /The server was busy\. Try again in a moment\./);
  pages.default = ok([item()]);
  await click('[data-action="source-fields-inv-reload"]');
  assert.deepEqual(shownNames(), ["metabolic_power"]);
  resetSourceFields();
  pages.default = { status: 404, body: { error: "notFound" } };
  await loadTech();
  assert.match(text(), /The names GPEXE sent are not available in this workspace\./);
});

test("7. team thresholds: the platform's fold reads them only when asked, with endpoint=team_thresholds", async () => {
  pages.default = ok([item()]);
  pages[`${INV}?endpoint=team_thresholds`] = ok([item({ endpoint: "team_thresholds", name: "max_speed", kind: "number", unitWord: "m/s", covered: null, connectionCount: 1 })]);
  await loadTech();
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
  await click('[data-action="source-fields-inv-technical"]');
  await click('[data-action="source-fields-inv-endpoint"][data-endpoint="more.events"]');
  release();
  await first;
  assert.deepEqual(shownNames(), ["events_only"]);
});

test("9. the list only reads: no write is ever sent", async () => {
  pages.default = ok([item()], "C1");
  pages[`${INV}?cursor=C1`] = ok([item({ name: "more_one" })]);
  await loadTech();
  await click('[data-action="source-fields-inv-more"]');
  await click('[data-action="source-fields-inv-supported"]');
  await click('[data-action="source-fields-inv-thresholds"]');
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(sourceFieldsState().form, null);
});

test("4b. Load more is not sent while Try again reads the list from the start; the reload's answer is the list", async () => {
  pages.default = ok([item({ name: "first" })], "C1");
  pages[`${INV}?cursor=C1`] = { status: 409, body: { error: "try_again" } };
  await loadTech();
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
  await loadTech();
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
  await loadTech();
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
  await loadTech();
  const input = $("[data-sf-inv-search]");
  input.value = "speed";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match($("#sf-inv-no-match").textContent, /Nothing matches among the values loaded so far\. Load more to search the rest\./);
});

test("R1 (the owner's first use, 2026-11-18): values grouped by quantity with zones in zone order, each row's readable name with its unit (never GPEXE's word) and the zone's team thresholds; the names that are not values in one closed fold; the search finds both", async () => {
  pages.default = { status: 200, body: { nextCursor: null, zoneThresholds: { power: { values: [20, 25, 60, 75] }, speed: { differ: true }, asOf: "2026-11-07T10:00:00Z" }, fields: [
    item({ name: "athletesessionpowerzone_distance_4", unitWord: "distance", unit: "m", zone: { family: "power", measure: "distance", number: 4 }, connectionCount: 1 }),
    item({ name: "athletesessionpowerzone_distance_2", unitWord: "distance", unit: "m", zone: { family: "power", measure: "distance", number: 2 }, connectionCount: 1 }),
    item({ name: "athletesessionspeedzone_distance_3", unitWord: "distance", unit: "m", zone: { family: "speed", measure: "distance", number: 3 }, connectionCount: 1 }),
    item({ name: "metabolic_power", connectionCount: 1 }),
    item({ name: "mystery", unitWord: "furlongs", unit: null, connectionCount: 1 }),
    item({ endpoint: "details.drill", name: "athlete", kind: "object", unitWord: null, unit: null, isValue: false, answersSeen: 9, connectionCount: 1 }),
    item({ endpoint: "details.drill", name: "athlete_session_id", kind: "number", unitWord: null, unit: null, isValue: false, answersSeen: 9, connectionCount: 1 }),
  ] } };
  await loadSourceFieldsSection(render);
  const groups = [...content.querySelectorAll(".source-fields-inventory-group")].map((h) => h.textContent.trim());
  assert.deepEqual(groups, ["Distance", "Power", "Other values"]);
  const names = (list) => [...list.querySelectorAll("[data-sf-inv-row] .metric-variables-item-name")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  const [distance, power, other] = [...content.querySelectorAll("[data-sf-inv-group] ul")];
  // The plain view (the owner's rule): the name, the unit, a zone's expected range and one state; no GPEXE name.
  assert.deepEqual(names(distance), ["Power zone 2 distance (m) · Expected 20–25 W/kg", "Power zone 4 distance (m) · Expected 60–75 W/kg", "Speed zone 3 distance (m)"]);
  assert.equal(content.querySelectorAll(".source-fields-inventory-raw, .source-fields-inventory-facts").length, 0, "no GPEXE name or count by default");
  assert.equal($(".source-fields-inventory-other"), null, "the names that are not values are out of sight by default");
  // The team limits once per zone family in the whole list, with the day of the session they come from; each zone row
  // shows its expected range, always marked expected (the Rukovodilac's order of 2026-11-18). Differing limits: no range.
  const notes = [...content.querySelectorAll(".source-fields-inventory-note")].map((e) => e.textContent.trim());
  assert.deepEqual(notes, [
    "Power zone limits of the team: 20 · 25 · 60 · 75 W/kg, from the newest saved session (07.11.2026). The range beside each zone is expected, not confirmed. To confirm it, use the value, then Compare with GPEXE.",
    "Speed zone limits differ between teams, so no zone's range is shown.",
  ]);
  assert.deepEqual(names(power), ["Metabolic power (W/kg)"]);
  assert.deepEqual(names(other), ["Mystery (no unit from GPEXE)"]);
  assert.doesNotMatch(text(), /furlongs|in distance/, "GPEXE's word is never shown as the unit");
  // One click away: GPEXE's own names and the counts, and the names that are not values in a closed fold.
  await click('[data-action="source-fields-inv-technical"]');
  const [distanceT] = [...content.querySelectorAll("[data-sf-inv-group] ul")];
  assert.deepEqual([...distanceT.querySelectorAll(".source-fields-inventory-raw")].map((e) => e.textContent), ["athletesessionpowerzone_distance_2", "athletesessionpowerzone_distance_4", "athletesessionspeedzone_distance_3"]);
  assert.match(distanceT.querySelector(".source-fields-inventory-facts").textContent, /^Whole session · seen 12 times/);
  const fold = $(".source-fields-inventory-other");
  assert.ok(fold && !fold.open, "the names that are not values are folded away, closed");
  assert.match(fold.querySelector("summary").textContent, /Other things GPEXE sends \(not values\) · 2/);
  assert.deepEqual([...fold.querySelectorAll(".metric-variables-item-name")].map((e) => e.textContent.replace(/\s+/g, " ").trim()), ["athlete group of values", "athlete_session_id number"], "GPEXE's own name and what it holds, no made-up name");
  // The search narrows by GPEXE's name or the readable one; a group with no match is hidden whole.
  handleSourceFieldsInput(Object.assign($("[data-sf-inv-search]"), { value: "zone 4" }));
  assert.deepEqual(shownNames(), ["athletesessionpowerzone_distance_4"]);
  const visibleGroups = () => [...content.querySelectorAll("[data-sf-inv-group]")].filter((g) => !g.hidden).map((g) => g.querySelector("h4").textContent.trim());
  assert.deepEqual(visibleGroups(), ["Distance"]);
  // A match only in the fold opens it.
  handleSourceFieldsInput(Object.assign($("[data-sf-inv-search]"), { value: "athlete_session_id" }));
  assert.deepEqual(shownNames(), ["athlete_session_id"]);
  assert.equal($(".source-fields-inventory-other").open, true);
  assert.deepEqual(visibleGroups(), []);
});

test("R2: a club's admin sees the unit and the zone's own name, never the team thresholds (the platform's, P1)", async () => {
  asClub();
  pages.default = { status: 200, body: { nextCursor: null, zoneThresholds: { power: { values: [20, 25, 60, 75] } }, fields: [
    item({ name: "athletesessionpowerzone_distance_4", unitWord: null, unit: "m", zone: { family: "power", measure: "distance", number: 4 } }),
  ] } };
  await loadSourceFieldsSection(render);
  assert.equal(rows()[0].querySelector(".metric-variables-item-name").textContent.replace(/\s+/g, " ").trim(), "Power zone 4 distance (m)");
  assert.doesNotMatch(text(), /thresholds|team limits|xpected/);
});

test("R3 (#601's LOW-1): a platform admin working in a club's workspace is told to switch to the platform workspace, never to ask a platform administrator", async () => {
  const { refusalText } = await import("../metric-mappings-data.js");
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "FK Borac", role: "platform_admin" }, availableWorkspaces: [{ type: "platform" }, { type: "club", scopeId: CLUB }] };
  const message = refusalText("draft", { status: 409, code: "unit_word_ambiguous" });
  assert.match(message, /Switch to the platform workspace, then retire this revision/);
  assert.doesNotMatch(message, /Ask a platform administrator/);
});

test("T (the code review's MEDIUM): leaving the technical view clears a source filter chosen there and reads the whole list again - never a filter with no visible control", async () => {
  pages.default = ok([item()]);
  pages[`${INV}?endpoint=athlete_session`] = ok([item({ endpoint: "athlete_session", name: "only_rows", kind: "number" })]);
  await loadTech();
  await click('[data-endpoint="athlete_session"]');
  assert.deepEqual(shownNames(), ["only_rows"]);
  await click('[data-action="source-fields-inv-technical"]');
  assert.equal(inventoryGets().at(-1), INV);
  assert.equal(sourceFieldsState().inventory.technical, false);
  assert.deepEqual(shownNames(), ["metabolic_power"]);
});

test("M (the after-screenshots): a name GPEXE sends for the whole session and per drill is one row in the plain view - the one in use if any, else the whole session's - and two in the technical view", async () => {
  pages.default = ok([
    item({ endpoint: "details.drill", name: "metabolic_power" }),
    item({ endpoint: "details.session", name: "metabolic_power", creatable: true }),
    item({ endpoint: "details.drill", name: "hsr", kind: "number", unit: "m", covered: true }),
    item({ endpoint: "details.session", name: "hsr", kind: "number", unit: "m" }),
  ]);
  await loadSourceFieldsSection(render);
  const shown = () => rows().filter((r) => !r.hidden).map((r) => sourceFieldsState().inventory.items[Number(r.dataset.sfInvRow)]);
  assert.deepEqual(shown().map((i) => `${i.endpoint}:${i.name}`).sort(), ["details.drill:hsr", "details.session:metabolic_power"]);
  assert.match(rows().find((r) => /Hsr/.test(r.textContent)).textContent, /In use/);
  await click('[data-action="source-fields-inv-technical"]');
  assert.equal(shown().length, 4, "the technical view lists each source");
});
