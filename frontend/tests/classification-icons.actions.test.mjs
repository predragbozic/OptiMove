// Training Load -> Data configuration, V4 (PR-1c, J6.1): the icons of domains
// and categories. Driven through the real handlers and markup in a DOM with a
// fake fetch: a node's icon drawn wherever it is shown (the start screen's
// cards, the Domains and Categories lists, a node's detail, a variable's
// domains and categories, the list's filter note), the icon field of the create
// forms, Change icon in a node's detail (offered only where the server's
// `actions` names it, opening the shared picker at once), the exact bodies,
// every refusal, a lost answer checked by the very same request, and the guards
// on leaving.
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

const { handleVariablesAction, handleVariablesInput, loadVariablesSection, resetVariables, submitVariablesForm, variablesMayBeLeft } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { renderIconSvg } = await import("../icon-render.js");
const { state } = await import("../state.js");

const VB = "/api/training-load/sources/metrics/variables";
const CB = "/api/training-load/sources/metrics/classification";
const FB = "/api/training-load/sources/metrics/fields";
const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "22222222-0000-4000-8000-000000000001";
const VAR_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const L1 = "eeeeeeee-0000-4000-8000-000000000001";
const LV = "eeeeeeee-0000-4000-8000-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const node = (over = {}) => ({ id: D1, key: "endurance", name: "Endurance", description: null, icon: null, ownerScope: "system", state: "active", editable: true, actions: ["rename", "archive", "icon"], namesToken: "b".repeat(64), truncated: false, ...over });
// Endurance (heart) with Aerobic capacity (flame) in it; Sprint without an icon, in no domain.
const iconTree = () => ({
  domains: [node({ icon: "heart" })],
  categories: [node({ id: C1, key: "aerobic_capacity", name: "Aerobic capacity", icon: "flame" }), node({ id: C2, key: "sprint", name: "Sprint" })],
  categoryDomains: [{ id: L1, variableId: null, categoryId: C1, domainId: D1, ownerScope: "system", editable: true, actions: ["remove"] }],
  truncated: false,
});
const variable = (over = {}) => ({
  id: VAR_ID, key: "total_distance", label: "Total distance", shortLabel: null, description: null, icon: null, ownerScope: "system", state: "active", editable: true,
  levels: ["session"], currentVersion: { id: "v1", versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: null, maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z" },
  mappingTarget: { ready: true, notReadyCode: null }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z", truncated: false,
  actions: ["rename", "archive", "newVersion", "icon"], labelsToken: "a".repeat(64),
  classification: {
    categories: [{ linkId: LV, id: C1, key: "aerobic_capacity", name: "Aerobic capacity", icon: "flame", state: "active", ownerScope: "system" }],
    domains: [{ linkId: null, id: D1, key: "endurance", name: "Endurance", icon: "heart", state: "active", ownerScope: "system", viaCategoryId: C1 }],
    truncated: false,
  },
  ...over,
});

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => handleVariablesInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const $$ = (selector) => [...content.querySelectorAll(selector)];
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const treeReads = () => calls.filter((call) => call.method === "GET" && call.url === CB).length;
// The icon a tile draws: its svg is exactly the library's drawing of that key.
const drawn = (tile) => tile?.innerHTML.trim();
const svg = (key) => {
  const box = document.createElement("div");
  box.innerHTML = renderIconSvg(key);
  return box.innerHTML.trim();
};

async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
function type(field, value) {
  const element = $(`[data-mc-field="${field}"]`);
  assert.ok(element, `the ${field} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });
const choose = async (key) => {
  await click(`[data-action="icon-picker-choose"][data-icon-key="${key}"]`);
  await click('[data-action="icon-picker-use"]');
};
const buttons = () => $$(".metric-variables-actions button").map((b) => b.textContent.trim());

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asClubAdmin() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB, label: "Club A", role: "club_admin" } };
}
function asCoach() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" } };
}

let tree = iconTree();
let current = variable();
function serve(post = () => ({ status: 404, body: { error: "notFound" } })) {
  respond = (call) => {
    if (call.method === "GET" && call.url === CB) return { status: 200, body: tree };
    if (call.method === "GET" && call.url === FB) return { status: 200, body: { fields: [] } };
    if (call.method === "GET" && call.url.startsWith(`${VB}?`)) return { status: 200, body: { variables: [current], nextCursor: null } };
    if (call.method === "GET" && call.url.startsWith(`${VB}/${VAR_ID}`)) return { status: 200, body: { variable: { ...current, versions: [{ ...current.currentVersion, current: true, reason: null }] }, nextCursor: null } };
    if (call.method === "POST") return post(call);
    return { status: 404, body: { error: "notFound" } };
  };
}
async function openNode(kind, id) {
  await loadVariablesSection(render);
  await click(`[data-action="metric-classification-view"][data-view="${kind === "domain" ? "domains" : "categories"}"]`);
  await click(`[data-action="metric-classification-open"][data-kind="${kind}"][data-node-id="${id}"]`);
}
const changed = (kind, id, icon) => ({ status: 200, body: { [kind]: { ...(tree[kind === "domain" ? "domains" : "categories"].find((n) => n.id === id)), icon }, replayed: false } });

beforeEach(() => {
  resetVariables();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  tree = iconTree();
  current = variable();
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

// ---------------------------------------------------------------------------
test("a node's icon is drawn wherever the node is shown: the start screen's cards, the Domains and Categories lists, a node's detail and its domain or categories, a variable's domains and categories, the list's filter note; a node without one keeps its kind's symbol and its tile's shape", async () => {
  await loadVariablesSection(render);
  const cardRows = (title) => $$(".dc-card").find((card) => card.querySelector(".dc-card-title strong").textContent === title).querySelectorAll(".dc-card-row .dc-tile");
  assert.deepEqual([...cardRows("Domains")].map(drawn), [svg("heart")]);
  assert.deepEqual([...cardRows("Categories")].map(drawn), [svg("flame"), svg("folder")], "a category without an icon keeps the folder");
  const heads = $$(".dc-card-head > .dc-tile").map(drawn);
  assert.deepEqual(heads.slice(1, 3), [svg("stack"), svg("folder")], "the cards' own tiles stay the kind's symbols");

  await click('[data-action="metric-classification-view"][data-view="domains"]');
  const domainTile = $(`.metric-classification-item[data-node-id="${D1}"] .dc-tile`);
  assert.deepEqual([drawn(domainTile), domainTile.classList.contains("dc-tile-domain")], [svg("heart"), true], "the domain keeps its filled tile");
  await click(`[data-action="metric-classification-open"][data-kind="domain"][data-node-id="${D1}"]`);
  assert.equal(drawn($(".dc-title .dc-tile")), svg("heart"), "the detail's large tile");
  assert.equal(drawn($(".metric-classification-place .dc-tile")), svg("flame"), "its categories");

  await click('[data-action="metric-classification-back"]');
  await click('[data-action="metric-classification-view"][data-view="home"]');
  await click('[data-action="metric-classification-view"][data-view="categories"]');
  assert.deepEqual([C1, C2].map((id) => drawn($(`.metric-classification-item[data-node-id="${id}"] .dc-tile`))), [svg("flame"), svg("folder")]);
  assert.ok($(`.metric-classification-item[data-node-id="${C1}"] .dc-tile`).classList.contains("dc-tile-category"), "the category keeps its outlined tile");
  await click(`[data-action="metric-classification-open"][data-kind="category"][data-node-id="${C1}"]`);
  assert.equal(drawn($(".dc-title .dc-tile")), svg("flame"));
  assert.equal(drawn($(".metric-classification-place .dc-tile")), svg("heart"), "its domain");

  // A variable's domains and categories.
  await click('[data-action="metric-classification-back"]');
  await click('[data-action="metric-classification-view"][data-view="home"]');
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
  const chips = $$(".metric-classification-links li").map((li) => [li.textContent.replace(/\s+/g, " ").trim(), drawn(li.querySelector(".dc-tile"))]);
  assert.deepEqual(chips, [["Category: Aerobic capacity Remove", svg("flame")], ["Domain: Endurance (through Aerobic capacity)", svg("heart")]]);

  // The list's filter note: from the domain's own Show its variables.
  await click('[data-action="metric-variables-back"]');
  await click('[data-action="metric-classification-view"][data-view="home"]');
  await click('[data-action="metric-classification-view"][data-view="domains"]');
  await click(`[data-action="metric-classification-open"][data-kind="domain"][data-node-id="${D1}"]`);
  await click(`[data-action="metric-classification-show-variables"][data-kind="domain"][data-node-id="${D1}"]`);
  const note = $(".metric-classification-filter-note");
  assert.match(note.textContent.replace(/\s+/g, " "), /Showing the variables in the domain Endurance, directly or through one of its categories\./);
  assert.equal(drawn(note.querySelector(".dc-tile")), svg("heart"));

  // A value that is not a library key is never drawn: the kind's symbol is.
  resetVariables();
  tree = { ...iconTree(), domains: [node({ icon: "no-such-icon" })] };
  await loadVariablesSection(render);
  assert.deepEqual([...cardRows("Domains")].map(drawn), [svg("stack")]);
});

test("a new domain or category may carry an icon: the field shows the kind's symbol until one is chosen; Choose icon opens the picker over an inert form; the body names iconKey only when one is chosen; Remove icon clears it", async () => {
  serve((call) => ({ status: 201, body: { [call.url.endsWith("/domains") ? "domain" : "category"]: node({ id: D1, name: "Speed", icon: JSON.parse(call.rawBody).iconKey ?? null }), replayed: false } }));
  await loadVariablesSection(render);
  await click('[data-action="metric-classification-view"][data-view="domains"]');
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  assert.match(text(), /Icon \(optional\) No icon Choose icon Shown beside the domain in lists\. You can change it later\./);
  assert.equal(drawn($(".dc-icon-choice .dc-tile")), svg("stack"));
  await click('[data-action="metric-classification-icon-open"]');
  assert.ok($("[data-icon-picker] [role=dialog]"));
  assert.equal($("#icon-picker-title").textContent, "Choose an icon for the domain");
  assert.ok($("[data-metric-variables-form]").hasAttribute("inert"), "the form is inert behind the picker");
  await choose("bolt");
  assert.ok(!$("[data-icon-picker]") && !$("[data-metric-variables-form]").hasAttribute("inert"));
  assert.match(text(), /Chosen: bolt/);
  assert.equal(drawn($(".dc-icon-choice .dc-tile")), svg("bolt"));
  type("name", "Speed");
  await submit();
  const body = JSON.parse(posts()[0].rawBody);
  assert.equal(posts()[0].url, `${CB}/domains`);
  assert.deepEqual([Object.keys(body).sort(), body.iconKey, body.name], [["iconKey", "name", "requestKey"], "bolt", "Speed"]);
  assert.match(body.requestKey, UUID);
  assert.match(text(), /The domain was created\./);

  // A category with an icon chosen and then removed: the create of before.
  calls.length = 0;
  await click('[data-action="metric-classification-back"]');
  await click('[data-action="metric-classification-view"][data-view="home"]');
  await click('[data-action="metric-classification-view"][data-view="categories"]');
  await click('[data-action="metric-classification-create-open"][data-kind="category"]');
  assert.equal(drawn($(".dc-icon-choice .dc-tile")), svg("folder"));
  await click('[data-action="metric-classification-icon-open"]');
  assert.equal($("#icon-picker-title").textContent, "Choose an icon for the category");
  await choose("target");
  await click('[data-action="metric-classification-icon-clear"]');
  assert.match(text(), /No icon Choose icon/);
  type("name", "Agility");
  await submit();
  assert.deepEqual(Object.keys(JSON.parse(posts()[0].rawBody)).sort(), ["name", "requestKey"]);
});

test("Change icon follows the server's actions only: offered with icon after Rename, never without, never to a coach; a forged click opens nothing", async () => {
  await openNode("domain", D1);
  assert.deepEqual(buttons(), ["Rename", "Change icon", "Archive"]);
  assert.ok(!$('[data-action="metric-classification-icon-change-open"]').classList.contains("data-sources-primary"));
  resetVariables();
  tree = { ...iconTree(), domains: [node({ actions: ["rename", "archive"] })] };
  await openNode("domain", D1);
  assert.ok(!buttons().includes("Change icon"));
  content.insertAdjacentHTML("beforeend", `<button data-action="metric-classification-icon-change-open" data-kind="domain" data-node-id="${D1}"></button>`);
  await click('[data-action="metric-classification-icon-change-open"]');
  assert.equal(variablesState().form, null);
  assert.ok(!state.iconPicker);
  // An archived node offers Restore only.
  resetVariables();
  tree = { ...iconTree(), domains: [node({ state: "archived", actions: ["restore"] })] };
  await openNode("domain", D1);
  assert.deepEqual(buttons(), ["Restore"]);
  // A coach reads the icons and changes nothing.
  resetVariables();
  asCoach();
  tree = { ...iconTree(), domains: [node({ icon: "heart", editable: false, actions: [] })] };
  await openNode("domain", D1);
  assert.deepEqual(buttons(), []);
  assert.equal(drawn($(".dc-title .dc-tile")), svg("heart"));
  content.insertAdjacentHTML("beforeend", `<button data-action="metric-classification-icon-change-open" data-kind="domain" data-node-id="${D1}"></button>`);
  await click('[data-action="metric-classification-icon-change-open"]');
  assert.equal(variablesState().form, null);
});

test("Change icon opens the shared picker at once over an inert form; Save icon sends the icon seen and the new one, then reads the tree again and keeps the node open", async () => {
  asClubAdmin();
  tree = { ...iconTree(), categories: [node({ id: C2, key: "sprint", name: "Sprint", ownerScope: "club" })], categoryDomains: [] };
  serve((call) => changed("category", C2, "bolt"));
  await openNode("category", C2);
  await click('[data-action="metric-classification-icon-change-open"]');
  assert.ok($("[data-icon-picker] [role=dialog]"));
  assert.equal($("#icon-picker-title").textContent, "Choose an icon for Sprint");
  assert.ok($("[data-metric-variables-form]").hasAttribute("inert"));
  await choose("bolt");
  assert.match(text(), /Change the icon of Sprint/);
  assert.match(text(), /Only the icon changes\. The name, the key, its links and its variables stay as they are\./);
  assert.match(text(), /Chosen: bolt Saved now: no icon\./);
  assert.ok($(".dc-icon-choice .dc-tile").classList.contains("is-club"), "the club's colour");
  assert.ok(!/Do not enter athlete names/.test(text()), "an icon form has no text to warn about");
  const reads = treeReads();
  await submit();
  const [sent] = posts();
  assert.equal(sent.url, `${CB}/categories/${C2}/icon`);
  const body = JSON.parse(sent.rawBody);
  assert.deepEqual(Object.keys(body).sort(), ["expectedIconKey", "iconKey", "requestKey"]);
  assert.match(body.requestKey, UUID);
  assert.deepEqual([body.expectedIconKey, body.iconKey], [null, "bolt"]);
  assert.equal(variablesState().form, null);
  assert.match(text(), /The icon was changed\./);
  assert.equal(treeReads(), reads + 1, "the tree is read again");
  assert.deepEqual(variablesState().node, { kind: "category", id: C2 }, "the node stays open");
});

test("Remove icon (and the picker's Use no icon) sends null with the icon seen; nothing changed is said before sending", async () => {
  serve(() => changed("domain", D1, null));
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  await click('[data-action="icon-picker-cancel"]');
  assert.match(text(), /Chosen: heart/);
  assert.ok(!/Saved now/.test(text()));
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Nothing changed: this is the icon already saved\. Choose another one, or Cancel\./);
  await click('[data-action="metric-classification-icon-clear"]');
  assert.match(text(), /No icon Saved now: heart\./);
  assert.equal(drawn($(".dc-icon-choice .dc-tile")), svg("stack"), "no icon: the domain's own symbol");
  await submit();
  assert.deepEqual([JSON.parse(posts()[0].rawBody).expectedIconKey, JSON.parse(posts()[0].rawBody).iconKey], ["heart", null]);
  assert.match(text(), /The icon was removed\./);
  resetVariables();
  calls.length = 0;
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  await click('[data-action="icon-picker-none"]');
  await submit();
  assert.deepEqual([JSON.parse(posts()[0].rawBody).expectedIconKey, JSON.parse(posts()[0].rawBody).iconKey], ["heart", null]);
});

test("refusals: node_changed and node_not_active close the form and read the tree again with the icon's own sentence; icon_unchanged and a refused body keep it open", async () => {
  let answer;
  serve(() => answer);
  for (const [code, sentence] of [
    ["node_changed", /Someone changed its icon in the meantime, so your choice was not saved\./],
    ["node_not_active", /It is archived now, so its icon cannot be changed\. Nothing was saved\./],
  ]) {
    resetVariables();
    answer = { status: 409, body: { error: code, ...(code === "node_changed" ? { current: node({ icon: "flame" }) } : {}) } };
    await openNode("domain", D1);
    await click('[data-action="metric-classification-icon-change-open"]');
    await choose("bolt");
    const reads = treeReads();
    await submit();
    assert.equal(variablesState().form, null, code);
    assert.match(text(), sentence);
    assert.equal(treeReads(), reads + 1, `${code}: the tree is read again`);
  }
  for (const [code, sentence] of [["icon_unchanged", /Nothing changed: this icon is the one already saved\./], ["invalid_body", /Not saved: the server refused a value\./]]) {
    resetVariables();
    answer = { status: code === "invalid_body" ? 400 : 409, body: { error: code } };
    await openNode("domain", D1);
    await click('[data-action="metric-classification-icon-change-open"]');
    await choose("bolt");
    await submit();
    assert.ok(variablesState().form, `${code} keeps the form`);
    assert.match(text(), sentence);
  }
});

test("a lost answer is Result not confirmed and the choice is locked; Check result sends the very same request; a saved replay answers it, icon_unchanged settles it as not saved", async () => {
  let answer = { throwNetworkError: true };
  serve(() => answer);
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  await choose("bolt");
  await submit();
  assert.match(text(), /Result not confirmed\./);
  assert.ok($('[data-action="metric-classification-icon-open"]').disabled, "the choice is locked");
  await click('[data-action="metric-classification-icon-open"]');
  assert.ok(!$("[data-icon-picker]"), "no picker on a sent form");
  answer = { status: 409, body: { error: "try_again" } };
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, true, "busy settles nothing");
  answer = { ...changed("domain", D1, "bolt"), body: { ...changed("domain", D1, "bolt").body, replayed: true } };
  await click('[data-action="metric-variables-check-result"]');
  const sent = posts().map((p) => p.rawBody);
  assert.deepEqual([sent.length, new Set(sent).size], [3, 1], "every check is the very same request");
  assert.match(text(), /The icon was changed\./);

  resetVariables();
  calls.length = 0;
  answer = { throwNetworkError: true };
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  await choose("target");
  await submit();
  answer = { status: 409, body: { error: "icon_unchanged" } };
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, false, "icon_unchanged settles it");
  assert.match(text(), /Nothing changed: this icon is the one already saved\./);
  assert.ok(!$('[data-action="metric-classification-icon-open"]').disabled, "the form is unlocked again");
});

test("leaving: an icon chosen and not saved is asked about; an untouched form leaves freely and the picker goes with the form; a node's name is escaped in the titles", async () => {
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  await click('[data-action="icon-picker-cancel"]');
  assert.equal(variablesMayBeLeft(), true);
  await click('[data-action="metric-classification-icon-open"]');
  await choose("bolt");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.equal(confirmQuestions.at(-1), "Discard the icon you have not saved?");
  confirmAnswer = true;
  await click('[data-action="metric-classification-icon-open"]');
  assert.ok($("[data-icon-picker]"));
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
  assert.ok(!state.iconPicker, "the picker went with the form");

  resetVariables();
  tree = { ...iconTree(), domains: [node({ name: "<img src=x onerror=alert(1)>" })] };
  await openNode("domain", D1);
  await click('[data-action="metric-classification-icon-change-open"]');
  assert.ok(!content.querySelector("img"), "nothing is parsed as markup");
  assert.equal($("#icon-picker-title").textContent, "Choose an icon for <img src=x onerror=alert(1)>");
  await click('[data-action="icon-picker-cancel"]');
  assert.match($("#metric-variables-title").textContent, /Change the icon of <img src=x onerror=alert\(1\)>/);
});
