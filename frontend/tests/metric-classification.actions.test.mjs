// Training Load -> Data configuration -> Variables -> Domains & categories
// (phase 12c, J6 3.4): the screen over the classification API (PR #247).
// Driven through the real handlers and the real markup in a DOM, with a fake
// fetch, so both what the screen sends and what it shows are proved: the tree
// and its one read, the node panel and the buttons the server's `actions`
// name, the exact create / rename / archive / restore / link / remove bodies
// (never an owner, actor or basis), the field checks before anything is sent,
// the refusals that close a form, a lost answer checked by the very same
// request, a variable's links in its detail, the list's filter, a coach's
// read-only view and the guards on leaving.
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

const { handleVariablesAction, handleVariablesInput, loadVariablesSection, resetVariables, submitVariablesForm, variablesMayBeLeft, variablesUnloadShouldWarn } = await import("../metric-variables-actions.js");
const { variablesState } = await import("../metric-variables-data.js");
const { treeOf } = await import("../metric-classification-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { state } = await import("../state.js");

const VB = "/api/training-load/sources/metrics/variables";
const CB = "/api/training-load/sources/metrics/classification";
const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "22222222-0000-4000-8000-000000000001";
const VAR_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const D2 = "dddddddd-0000-4000-8000-000000000002";
const D3 = "dddddddd-0000-4000-8000-000000000003";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const L1 = "eeeeeeee-0000-4000-8000-000000000001";
const LV = "eeeeeeee-0000-4000-8000-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = "b".repeat(64);

const node = (over = {}) => ({ id: D1, key: "endurance", name: "Endurance", description: null, ownerScope: "system", state: "active", editable: true, actions: ["rename", "archive"], namesToken: TOKEN, truncated: false, ...over });
// The platform's tree: Endurance with Aerobic capacity in it, Speed archived,
// and a category in no domain whose name carries markup.
const platformTree = () => ({
  domains: [node(), node({ id: D2, key: "speed", name: "Speed", state: "archived", actions: ["restore"] })],
  categories: [
    node({ id: C1, key: "aerobic_capacity", name: "Aerobic capacity", description: "Long <i>steady</i> work" }),
    node({ id: C2, key: "sprint", name: "Sprint <b>", actions: ["rename", "archive"] }),
  ],
  categoryDomains: [{ id: L1, variableId: null, categoryId: C1, domainId: D1, ownerScope: "system", editable: true, actions: ["remove"] }],
  truncated: false,
});
const variable = (over = {}) => ({
  id: VAR_ID, key: "total_distance", label: "Total distance", shortLabel: null, description: null, ownerScope: "system", state: "active", editable: true,
  levels: ["session"], currentVersion: { id: "v1", versionNumber: 1, unit: "m", valueType: "numeric", dailyAggregationMethod: "sum", minValue: null, maxValue: null, condition: null, createdAt: "2026-10-20T08:00:00.000Z" },
  mappingTarget: { ready: true, notReadyCode: null }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z", truncated: false,
  actions: ["rename", "archive", "newVersion"], labelsToken: "a".repeat(64),
  // C6: the variable's own links, and a domain it reaches through a category.
  classification: {
    categories: [{ linkId: LV, id: C1, key: "aerobic_capacity", name: "Aerobic capacity", state: "active", ownerScope: "system" }],
    domains: [{ linkId: null, id: D1, key: "endurance", name: "Endurance", state: "active", ownerScope: "system", viaCategoryId: C1 }],
    truncated: false,
  },
  ...over,
});

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => handleVariablesInput(event.target, { render }));
content.addEventListener("change", (event) => handleVariablesInput(event.target, { render }));
const $ = (selector) => content.querySelector(selector);
const text = () => content.textContent.replace(/\s+/g, " ");
const posts = () => calls.filter((call) => call.method === "POST");
const gets = () => calls.filter((call) => call.method === "GET").map((call) => call.url);
const treeReads = () => gets().filter((url) => url === CB).length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const options = (field) => [...content.querySelectorAll(`[data-mc-field="${field}"] option`)].map((o) => [o.value, o.textContent]).filter(([value]) => value);

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
function choose(field, value) {
  const element = $(`[data-mc-field="${field}"]`);
  assert.ok(element, `the ${field} field is on the screen`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const submit = () => submitVariablesForm($("[data-metric-variables-form]"), { render });

function asPlatform() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform", role: "platform_admin" } };
}
function asCoach() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: TEAM, clubId: CLUB, label: "First team", role: "team_coach" } };
}

// The reads answer from `tree` / `current`; the writes from `post(call)`.
let tree = platformTree();
let current = variable();
let listItems = [variable()];
function serve(post = () => ({ status: 404, body: { error: "notFound" } })) {
  respond = (call) => {
    if (call.method === "GET" && call.url === CB) return { status: 200, body: tree };
    if (call.method === "GET" && call.url.startsWith(`${VB}?`)) return { status: 200, body: { variables: listItems, nextCursor: null } };
    if (call.method === "GET" && call.url.startsWith(`${VB}/${VAR_ID}`)) return { status: 200, body: { variable: { ...current, versions: [{ ...current.currentVersion, current: true, reason: null }] }, nextCursor: null } };
    if (call.method === "POST") return post(call);
    return { status: 404, body: { error: "notFound" } };
  };
}
async function openTree() {
  await loadVariablesSection(render);
  await click('[data-action="metric-classification-view"][data-view="classification"]');
}
async function openNode(kind, id) {
  await click(`[data-action="metric-classification-open"][data-kind="${kind}"][data-node-id="${id}"]`);
}
async function openVariable() {
  await loadVariablesSection(render);
  content.innerHTML = `<button data-action="metric-variables-open" data-variable-id="${VAR_ID}"></button>`;
  await click('[data-action="metric-variables-open"]');
}

beforeEach(() => {
  resetVariables();
  calls.length = 0;
  confirmQuestions.length = 0;
  confirmAnswer = true;
  tree = platformTree();
  current = variable();
  listItems = [variable()];
  serve();
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  asPlatform();
  content.innerHTML = "";
});

// ---------------------------------------------------------------------------
// The tree (C1)
// ---------------------------------------------------------------------------
test("the screen reads the domains and categories once with the list; the switch shows the tree, read again; back to the variables reads nothing", async () => {
  await loadVariablesSection(render);
  assert.deepEqual(gets(), [CB, `${VB}?scope=own&state=active`], "one read of the tree beside the list");
  assert.equal($('[data-view="variables"]').getAttribute("aria-pressed"), "true");
  await click('[data-action="metric-classification-view"][data-view="classification"]');
  assert.equal(treeReads(), 2, "opening the tree reads it again");
  assert.equal($('[data-view="classification"]').getAttribute("aria-pressed"), "true");
  assert.match(text(), /System domains and categories group the system variables/);
  const domains = [...content.querySelectorAll(".metric-classification-domain")];
  assert.equal(domains.length, 2);
  assert.match(domains[0].textContent, /Endurance/);
  assert.match(domains[0].querySelector(".metric-classification-categories").textContent, /Aerobic capacity/, "a placed category sits under its domain");
  assert.match(domains[1].textContent.replace(/\s+/g, " "), /Speed Archived/);
  assert.match(domains[1].textContent, /No categories in it yet\./);
  const loose = $('[aria-labelledby="mc-loose-title"]');
  assert.match(loose.textContent, /Sprint <b>/);
  assert.ok(content.innerHTML.includes("Sprint &lt;b&gt;"), "a name is escaped");
  assert.ok(content.innerHTML.includes("Long &lt;i&gt;steady&lt;/i&gt; work"), "a description is escaped");
  assert.ok($('[data-action="metric-classification-create-open"][data-kind="domain"]'));
  assert.ok($('[data-action="metric-classification-create-open"][data-kind="category"]'));
  const before = calls.length;
  await click('[data-action="metric-classification-view"][data-view="variables"]');
  assert.equal(calls.length, before, "the loaded list is shown without a read");
  assert.match(text(), /Total distance/);
});

test("the tree's helper places a category under its first domain only, and names a placement whose domain is not in the read", () => {
  const t = treeOf({
    domains: [node()],
    categories: [node({ id: C1 }), node({ id: C2 })],
    categoryDomains: [
      { id: L1, categoryId: C1, domainId: D1 },
      { id: "x", categoryId: C1, domainId: D2 },
      { id: "y", categoryId: C2, domainId: D3 },
    ],
    truncated: true,
  });
  assert.deepEqual(t.domains[0].categories.map((c) => c.category.id), [C1]);
  assert.deepEqual(t.unplaced.map((c) => c.id), []);
  assert.deepEqual(t.placedElsewhere.map((c) => c.id), [C2]);
  assert.equal(t.linkOf(C1).id, L1);
  assert.equal(t.truncated, true);
});

test("a tree that cannot be read offers Try again; a 404 says the workspace has none; an empty tree says what to do", async () => {
  respond = (call) => (call.url === CB ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: { variables: [], nextCursor: null } });
  await openTree();
  assert.match(text(), /The domains and categories could not be loaded\./);
  respond = (call) => (call.url === CB ? { status: 404, body: { error: "notFound" } } : { status: 404, body: {} });
  await click('[data-action="metric-classification-reload"]');
  assert.match(text(), /Domains and categories are not available in this workspace\./);
  tree = { domains: [], categories: [], categoryDomains: [], truncated: false };
  serve();
  await click('[data-action="metric-classification-reload"]');
  assert.match(text(), /No domains or categories yet\. Create a domain \(for example Endurance\), then categories, and place the categories in it\./);
});

test("an answer for a workspace that was left is dropped", async () => {
  let release;
  respond = () => new Promise((resolve) => { release = () => resolve({ status: 200, body: platformTree() }); });
  const { loadClassification } = await import("../metric-classification-actions.js");
  const pending = loadClassification(render);
  resetVariables();
  release();
  await pending;
  assert.equal(variablesState().classification.tree, null, "nothing of the old answer is kept");
});

// ---------------------------------------------------------------------------
// One domain or category: the actions are the server's
// ---------------------------------------------------------------------------
test("a node panel shows its facts and only the actions the server names; ids only under Technical details", async () => {
  await openTree();
  await openNode("domain", D1);
  assert.equal($("#metric-variables-title").textContent, "Endurance");
  assert.deepEqual([...content.querySelectorAll(".metric-variables-actions button")].map((b) => b.textContent), ["Rename", "Archive"]);
  assert.match($(".metric-classification-place").textContent, /Aerobic capacity/, "the categories in the domain");
  const visible = [...content.querySelector("section.metric-variables").children].filter((n) => !n.classList.contains("data-sources-tech")).map((n) => n.textContent).join(" ");
  assert.ok(!visible.includes(D1), "the id is not in the visible text");
  assert.ok($(".data-sources-tech").textContent.includes(D1));
  assert.ok($(".data-sources-tech").textContent.includes("endurance"));
  await click('[data-action="metric-classification-back"]');
  await openNode("domain", D2);
  assert.deepEqual([...content.querySelectorAll(".metric-variables-actions button")].map((b) => b.textContent), ["Restore"]);
  assert.match(text(), /Archived: its links stay as they are/);
  await click('[data-action="metric-classification-back"]');
  await openNode("category", C1);
  assert.match($(".metric-classification-place").textContent.replace(/\s+/g, " "), /Endurance/);
  assert.ok($('[data-action="metric-classification-link-remove-open"]'), "Remove from the domain, as the link is editable");
  assert.ok(!$('[data-action="metric-classification-place-open"]'), "a placed category is not offered a second domain");
  await click('[data-action="metric-classification-back"]');
  await openNode("category", C2);
  assert.match(text(), /In no domain\./);
  assert.ok($('[data-action="metric-classification-place-open"]'));
});

test("a node the server makes read only shows no buttons, and its handlers open nothing", async () => {
  tree.domains[0] = node({ editable: false, actions: [] });
  tree.categoryDomains[0].editable = false;
  await openTree();
  await openNode("domain", D1);
  assert.equal(content.querySelectorAll(".metric-variables-actions button").length, 0);
  assert.match(text(), /Read only here: system domains and categories are changed in the platform workspace\./);
  // A forged click is refused too: only the actions the server names open a form.
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="metric-classification-rename-open" data-kind="domain" data-node-id="${D1}"></button>`);
  await handleVariablesAction($("#forged"), { render });
  assert.equal(variablesState().form, null);
  await click('[data-action="metric-classification-back"]');
  await openNode("category", C1);
  assert.ok(!$('[data-action="metric-classification-link-remove-open"]'), "a link the server does not let change has no Remove");
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
test("create a domain: the fields are checked before anything is sent; the body is exactly the form's; the new domain opens", async () => {
  serve((call) => {
    tree.domains.push(node({ id: D3, key: "power", name: "Power and speed" }));
    return { status: 201, body: { domain: node({ id: D3, key: "power", name: "Power and speed" }) } };
  });
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  assert.equal($("#metric-variables-title").textContent, "New system domain");
  await submit();
  assert.equal(posts().length, 0, "an empty name sends nothing");
  assert.equal($('[data-mc-field="name"]').getAttribute("aria-invalid"), "true");
  assert.match(text(), /Required\./);
  type("name", "Bad" + String.fromCodePoint(0x200b));
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Contains a character that cannot be saved\./);
  type("name", "  Power   and speed ");
  type("key", "Power Key");
  await submit();
  assert.equal(posts().length, 0, "a key outside the rule sends nothing");
  assert.ok($("details.data-sources-tech").open, "the key's error opens Technical details");
  type("key", "power");
  type("description", " Short  efforts ");
  await submit();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, `${CB}/domains`);
  const body = posts()[0].body;
  assert.match(body.requestKey, UUID);
  assert.deepEqual(body, { requestKey: body.requestKey, name: "Power and speed", description: "Short efforts", key: "power" }, "no owner, actor or basis");
  assert.equal(variablesState().form, null);
  assert.deepEqual(variablesState().node, { kind: "domain", id: D3 });
  assert.equal($("#metric-variables-title").textContent, "Power and speed");
  assert.match(text(), /The domain was created\./);
  assert.equal(treeReads(), 3, "the tree is read again after the save");
});

test("create: key_taken keeps the form with the key's error; a category without a key sends none", async () => {
  let answer = { status: 409, body: { error: "key_taken" } };
  serve(() => answer);
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="category"]');
  assert.equal($("#metric-variables-title").textContent, "New system category");
  type("name", "Sprint");
  await submit();
  assert.deepEqual(Object.keys(posts()[0].body).sort(), ["name", "requestKey"]);
  assert.equal(posts()[0].url, `${CB}/categories`);
  assert.ok(variablesState().form, "the form stays");
  assert.ok($("details.data-sources-tech").open);
  assert.match($("#mc-err-key").textContent, /Another one here already uses this key/);
  answer = { status: 409, body: { error: "try_again" } };
  type("key", "sprint_2");
  await submit();
  assert.match(text(), /The server was busy\. Nothing was saved\. Try again\./);
  assert.equal(posts()[1].body.requestKey, posts()[0].body.requestKey, "the same form keeps its request key");
});

test("rename: only a changed field and the names token are sent; nothing changed sends nothing; node_changed closes the form and reads the tree again", async () => {
  let answer = { status: 200, body: { domain: node({ name: "Stamina" }) } };
  serve(() => answer);
  await openTree();
  await openNode("domain", D1);
  await click('[data-action="metric-classification-rename-open"]');
  assert.equal($('[data-mc-field="name"]').value, "Endurance");
  await submit();
  assert.equal(posts().length, 0);
  assert.match(text(), /Nothing changed: change the name or the description, or Cancel\./);
  type("name", "Stamina");
  await submit();
  assert.equal(posts()[0].url, `${CB}/domains/${D1}/rename`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, namesToken: TOKEN, name: "Stamina" });
  assert.match(text(), /The domain was renamed\./);
  assert.deepEqual(variablesState().node, { kind: "domain", id: D1 }, "the node stays open");

  answer = { status: 409, body: { error: "node_changed", current: node({ name: "Someone else's" }) } };
  await click('[data-action="metric-classification-rename-open"]');
  type("description", "Aerobic work");
  const reads = treeReads();
  await submit();
  assert.deepEqual(posts()[1].body, { requestKey: posts()[1].body.requestKey, namesToken: TOKEN, description: "Aerobic work" });
  assert.equal(variablesState().form, null);
  assert.match(text(), /Someone changed it in the meantime, so your change was not saved\./);
  assert.equal(treeReads(), reads + 1);
});

test("rename: emptying the description sends null; a cut name says so", async () => {
  tree.categories[0] = node({ id: C1, name: "Aerobic capacity", description: "Old", truncated: true });
  serve(() => ({ status: 200, body: {} }));
  await openTree();
  await openNode("category", C1);
  await click('[data-action="metric-classification-rename-open"]');
  assert.match(text(), /The saved name or description may be longer than shown here\./);
  type("description", "   ");
  await submit();
  assert.equal(posts()[0].url, `${CB}/categories/${C1}/rename`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, namesToken: TOKEN, description: null });
});

test("archive needs a reason; restore takes an optional one; node_active and node_not_active close the form", async () => {
  let answer = { status: 200, body: {} };
  serve(() => answer);
  await openTree();
  await openNode("domain", D1);
  await click('[data-action="metric-classification-archive-open"]');
  assert.match(text(), /Its links stay as they are and its variables keep their values\. Until it is restored, no new variable or category can be placed in it\./);
  await submit();
  assert.equal(posts().length, 0);
  assert.match($("#mc-err-reason").textContent, /Required\./);
  type("reason", " Merged into  Speed ");
  await submit();
  assert.equal(posts()[0].url, `${CB}/domains/${D1}/archive`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, reason: "Merged into Speed" });
  assert.match(text(), /The domain was archived\./);

  await click('[data-action="metric-classification-back"]');
  await openNode("domain", D2);
  await click('[data-action="metric-classification-restore-open"]');
  await submit();
  assert.equal(posts()[1].url, `${CB}/domains/${D2}/restore`);
  assert.deepEqual(posts()[1].body, { requestKey: posts()[1].body.requestKey }, "no reason, no field");

  answer = { status: 409, body: { error: "node_active" } };
  await click('[data-action="metric-classification-restore-open"]');
  await submit();
  assert.equal(variablesState().form, null);
  assert.match(text(), /It is active \(perhaps restored in the meantime\), so there is nothing to restore\./);

  answer = { status: 409, body: { error: "node_not_active" } };
  await click('[data-action="metric-classification-back"]');
  await openNode("domain", D1);
  await click('[data-action="metric-classification-archive-open"]');
  type("reason", "Again");
  await submit();
  assert.match(text(), /It is already archived\./);
});

test("place a category in a domain: only active domains are offered; the body names the two; category_has_domain closes and reads again", async () => {
  let answer = { status: 201, body: { link: { id: "new", categoryId: C2, domainId: D1, present: true } } };
  serve(() => answer);
  await openTree();
  await openNode("category", C2);
  await click('[data-action="metric-classification-place-open"]');
  assert.deepEqual(options("targetId"), [[D1, "Endurance"]], "the archived domain is not offered");
  await submit();
  assert.equal(posts().length, 0, "nothing chosen sends nothing");
  assert.match($("#mc-err-targetId").textContent, /Choose one\./);
  choose("targetId", D1);
  await submit();
  assert.equal(posts()[0].url, `${CB}/links`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, categoryId: C2, domainId: D1 });
  assert.match(text(), /The category was placed in the domain\./);

  answer = { status: 409, body: { error: "category_has_domain" } };
  await click('[data-action="metric-classification-place-open"]');
  choose("targetId", D1);
  const reads = treeReads();
  await submit();
  assert.equal(variablesState().form, null);
  assert.match(text(), /This category is already in a domain \(perhaps placed in the meantime\)\./);
  assert.equal(treeReads(), reads + 1);
});

test("remove a category from its domain: the link's own route, an optional reason; the form names both", async () => {
  serve(() => ({ status: 200, body: { link: { id: L1, present: false } } }));
  await openTree();
  await openNode("category", C1);
  await click('[data-action="metric-classification-link-remove-open"]');
  assert.equal($("#metric-variables-title").textContent, "Remove Aerobic capacity from Endurance");
  type("reason", "Moved");
  await submit();
  assert.equal(posts()[0].url, `${CB}/links/${L1}/remove`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, reason: "Moved" });
  assert.match(text(), /The link was removed\./);
});

// ---------------------------------------------------------------------------
// A lost answer is checked by the very same request
// ---------------------------------------------------------------------------
for (const [name, lost] of [
  ["no answer", { throwNetworkError: true }],
  ["503 outcome_unknown", { status: 503, body: { error: "outcome_unknown" } }],
  ["an uncoded 502", { status: 502, body: {} }],
]) {
  test(`${name}: Result not confirmed; Check result sends the same body; a busy check stays unconfirmed; a replayed save settles it`, async () => {
    const answers = [lost, { status: 409, body: { error: "try_again" } }, { status: 201, body: { replayed: true, domain: node({ id: D3, name: "Power" }) } }];
    serve(() => {
      const answer = answers.shift();
      if (answer.status === 201) tree.domains.push(node({ id: D3, name: "Power" }));
      return answer;
    });
    await openTree();
    await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
    type("name", "Power");
    await submit();
    assert.match(text(), /Result not confirmed\./);
    assert.ok($('[data-mc-field="name"]').disabled, "the fields are locked");
    assert.equal(variablesUnloadShouldWarn(), true);
    await submit();
    assert.equal(posts().length, 1, "a submit cannot send again while unconfirmed");
    await click('[data-action="metric-variables-check-result"]');
    assert.equal(posts()[1].rawBody, posts()[0].rawBody, "the same request key and body");
    assert.match(text(), /The check could not be done: the server was busy\. The result is still not confirmed/);
    await click('[data-action="metric-variables-check-result"]');
    assert.equal(posts()[2].rawBody, posts()[0].rawBody);
    assert.equal(variablesState().form, null);
    assert.match(text(), /The domain was created\./);
    assert.equal($("#metric-variables-title").textContent, "Power", "the created domain opens");
  });
}

test("a saved node the tree no longer holds still says what was saved", async () => {
  serve(() => ({ status: 201, body: { domain: node({ id: D3, name: "Power" }) } }));
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  type("name", "Power");
  await submit();
  assert.match(text(), /The domain was created\./);
  assert.match(text(), /This domain is not in the list any more\./);
});

test("a check answered by a refusal from the body settles it; Close without checking reads the tree again", async () => {
  const answers = [{ throwNetworkError: true }, { status: 409, body: { error: "key_taken" } }];
  serve(() => answers.shift());
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  type("name", "Power");
  await submit();
  await click('[data-action="metric-variables-check-result"]');
  assert.equal(variablesState().form.unconfirmed, false, "key_taken comes from the body itself");
  assert.match($("#mc-err-key").textContent, /Another one here already uses this key/);

  serve(() => ({ throwNetworkError: true }));
  await click('[data-action="metric-variables-cancel"]');
  await click('[data-action="metric-classification-create-open"][data-kind="category"]');
  type("name", "Sprint 2");
  await submit();
  assert.match(text(), /Result not confirmed\./);
  confirmAnswer = false;
  await click('[data-action="metric-variables-cancel"]');
  assert.deepEqual(confirmQuestions.slice(-1), ["The last save is not confirmed. Leave without checking? Look for it in the list later."]);
  assert.ok(variablesState().form, "declined: the form stays");
  confirmAnswer = true;
  const reads = treeReads();
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(variablesState().form, null);
  assert.match(text(), /The result was not checked\. What is shown below is as it is saved now\./);
  assert.equal(treeReads(), reads + 1);
});

// ---------------------------------------------------------------------------
// A variable's domains and categories (C6)
// ---------------------------------------------------------------------------
test("a variable's detail lists its categories and domains, a domain reached through a category, and offers only what can be added", async () => {
  tree.categories.push(node({ id: "cccccccc-0000-4000-8000-000000000009", name: "Archived cat", state: "archived", actions: ["restore"] }));
  serve(() => ({ status: 201, body: { link: { id: "n", present: true } } }));
  await openVariable();
  const block = $(".metric-classification-variable");
  assert.ok(block, "the block is in the detail");
  const rows = [...block.querySelectorAll("li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(rows, ["Category: Aerobic capacity Remove", "Domain: Endurance (through Aerobic capacity)"]);
  await click('[data-action="metric-classification-variable-link-open"][data-link-kind="category"]');
  assert.equal($("#metric-variables-title").textContent, "Add Total distance to a category");
  assert.deepEqual(options("targetId"), [[C2, "Sprint <b>"]], "a linked or archived category is not offered");
  choose("targetId", C2);
  const variableReads = gets().filter((url) => url.startsWith(`${VB}/${VAR_ID}`)).length;
  await submit();
  assert.equal(posts()[0].url, `${CB}/links`);
  assert.deepEqual(posts()[0].body, { requestKey: posts()[0].body.requestKey, variableId: VAR_ID, categoryId: C2 });
  assert.match(text(), /The variable was added to the category\./);
  assert.equal(gets().filter((url) => url.startsWith(`${VB}/${VAR_ID}`)).length, variableReads + 1, "the variable is read again");
  assert.ok($(".metric-classification-variable"), "back on the variable");

  await click('[data-action="metric-classification-variable-link-open"][data-link-kind="domain"]');
  assert.deepEqual(options("targetId"), [[D1, "Endurance"]], "a domain reached only through a category can still be linked directly");
  choose("targetId", D1);
  await submit();
  assert.deepEqual(posts()[1].body, { requestKey: posts()[1].body.requestKey, variableId: VAR_ID, domainId: D1 });

  await click('[data-action="metric-classification-link-remove-open"]');
  assert.equal($("#metric-variables-title").textContent, "Remove Total distance from Aerobic capacity");
  await submit();
  assert.equal(posts()[2].url, `${CB}/links/${LV}/remove`);
  assert.deepEqual(posts()[2].body, { requestKey: posts()[2].body.requestKey });
});

test("an archived variable, or one in every container, is offered no Add; variable_not_active closes the form", async () => {
  current = variable({ state: "archived", actions: ["restore"] });
  await openVariable();
  assert.ok(!$('[data-action="metric-classification-variable-link-open"]'));
  resetVariables();
  calls.length = 0;
  current = variable();
  serve(() => ({ status: 409, body: { error: "variable_not_active" } }));
  await openVariable();
  await click('[data-action="metric-classification-variable-link-open"][data-link-kind="category"]');
  choose("targetId", C2);
  await submit();
  assert.equal(variablesState().form, null);
  assert.match(text(), /This variable is archived, so it cannot be linked\. Nothing was saved\./);
  resetVariables();
  current = variable({ classification: { categories: [{ linkId: LV, id: C1, name: "Aerobic capacity", state: "active", ownerScope: "system" }, { linkId: "l2", id: C2, name: "Sprint", state: "active", ownerScope: "system" }], domains: [{ linkId: "l3", id: D1, name: "Endurance", state: "active", ownerScope: "system", viaCategoryId: null }], truncated: false } });
  await openVariable();
  assert.ok(!$('[data-action="metric-classification-variable-link-open"]'), "nothing left to add");
  assert.match(text(), /In no domain or category yet\.|Category: Aerobic capacity/);
});

// ---------------------------------------------------------------------------
// The list's filter (C6)
// ---------------------------------------------------------------------------
test("the filter reads the list for one domain or category; the note says which; Show all reads all again", async () => {
  await loadVariablesSection(render);
  const select = $('[data-metric-variables-filter="classification"]');
  assert.ok(select, "the filter is offered once the tree is read");
  assert.deepEqual([...select.querySelectorAll("optgroup")].map((g) => g.label), ["Domains", "Categories"]);
  assert.match(select.textContent, /Speed \(archived\)/);
  select.value = `d:${D1}`;
  select.dispatchEvent(new window.Event("input", { bubbles: true }));
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(gets().at(-1), `${VB}?scope=own&state=active&domainId=${D1}`);
  assert.equal(gets().filter((url) => url.includes("domainId")).length, 1, "input and change read once");
  assert.match(text(), /Showing the variables in the domain Endurance, directly or through one of its categories\./);
  listItems = [];
  const category = $('[data-metric-variables-filter="classification"]');
  category.value = `c:${C1}`;
  category.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle();
  assert.equal(gets().at(-1), `${VB}?scope=own&state=active&categoryId=${C1}`);
  assert.match(text(), /Showing the variables in the category Aerobic capacity\./);
  assert.match(text(), /No variables here yet\./);
  await click('[data-action="metric-classification-filter-clear"]');
  assert.equal(gets().at(-1), `${VB}?scope=own&state=active`);
  assert.equal(variablesState().filter, null);
});

test("Show its variables on a node switches to the list filtered by it", async () => {
  await openTree();
  await openNode("category", C1);
  await click('[data-action="metric-classification-show-variables"]');
  assert.equal(variablesState().view, "variables");
  assert.equal(gets().at(-1), `${VB}?scope=own&state=active&categoryId=${C1}`);
  assert.equal($('[data-metric-variables-filter="classification"]').value, `c:${C1}`);
});

// ---------------------------------------------------------------------------
// A coach reads only
// ---------------------------------------------------------------------------
test("coach: the tree, a node and a variable's links read only; no create, change, place, add or remove", async () => {
  asCoach();
  tree = {
    domains: [node({ ownerScope: "club", editable: false, actions: [] })],
    categories: [node({ id: C1, name: "Aerobic capacity", ownerScope: "system", editable: false, actions: [] }), node({ id: C2, name: "Sprint", ownerScope: "club", editable: false, actions: [] })],
    categoryDomains: [{ id: L1, categoryId: C1, domainId: D1, ownerScope: "club", editable: false, actions: [] }],
    truncated: false,
  };
  current = variable({ ownerScope: "club", actions: [] });
  await openTree();
  assert.match(text(), /The domains and categories of this team's club and the system's, for reference\./);
  assert.ok(!$('[data-action="metric-classification-create-open"]'));
  assert.match(text(), /Aerobic capacity System/, "a system category is marked in a club's tree");
  await openNode("category", C2);
  assert.equal(content.querySelectorAll(".metric-variables-actions button").length, 0);
  assert.ok(!$('[data-action="metric-classification-place-open"]'));
  assert.ok(!/Read only here/.test(text()), "the admin's note is not a coach's");
  for (const forged of [
    `<button data-action="metric-classification-create-open" data-kind="domain"></button>`,
    `<button data-action="metric-classification-place-open" data-node-id="${C2}"></button>`,
    `<button data-action="metric-classification-link-remove-open" data-link-id="${L1}"></button>`,
  ]) {
    content.innerHTML = forged;
    await handleVariablesAction(content.firstElementChild, { render });
    assert.equal(variablesState().form, null, "a coach's handler opens no form");
  }
  resetVariables();
  await openVariable();
  const block = $(".metric-classification-variable");
  assert.ok(block, "the coach sees the variable's links");
  assert.ok(!block.querySelector("button"), "no Add or Remove");
  assert.equal(posts().length, 0);
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
test("leaving asks about unsaved values and a save in flight, with the classification's own words", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = () => resolve({ status: 201, body: { domain: node({ id: D3 }) } }); }));
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  assert.equal(variablesMayBeLeft(), true, "an untouched form is left without a question");
  type("name", "Power");
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.deepEqual(confirmQuestions.slice(-1), ["Discard the domain or category you have not saved?"]);
  confirmAnswer = true;
  const pending = submit();
  await settle();
  assert.ok(variablesState().form.busy);
  confirmAnswer = false;
  assert.equal(variablesMayBeLeft(), false);
  assert.deepEqual(confirmQuestions.slice(-1), ["A change is still being saved. Leave anyway? Its result will not be shown."]);
  release();
  await pending;
  assert.equal(variablesState().form, null);
});

test("an answer that lands after the workspace was left changes nothing", async () => {
  let release;
  serve(() => new Promise((resolve) => { release = () => resolve({ status: 201, body: { domain: node({ id: D3 }) } }); }));
  await openTree();
  await click('[data-action="metric-classification-create-open"][data-kind="domain"]');
  type("name", "Power");
  const pending = submit();
  await settle();
  resetVariables();
  const before = calls.length;
  release();
  await pending;
  assert.equal(variablesState().form, null);
  assert.equal(variablesState().node, null, "the new domain is not opened in the new workspace");
  assert.equal(calls.length, before, "nothing is read for the old workspace");
});
