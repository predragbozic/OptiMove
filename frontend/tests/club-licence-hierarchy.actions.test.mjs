// Roles V-5a (the licence hierarchy, v96; docs/ai/roles-v-steps-plan.md 13.1): Settings > Clubs > a club's licence shows
// a child of a part that is not included as closed with it - "Not included", its switch disabled, the note "Closed
// because Training Load is closed" - in the saved licence and in the draft alike; a child also taken out on its own says
// it stays out; putting the parent back draws the child's own state again. Through the real plain side and the COMPILED
// island, against a fake of GET / POST .../ceiling that answers each module's `parent` and `closedByParent` as
// permissionLayersService.js ceilingView does. Invented names only.
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";

let actions;
let data;

const CLUB = "11111111-0000-4000-8000-0000000000d1";
const MODULES = [
  { word: "organization", label: "Organization", parent: null },
  { word: "calendar", label: "Calendar", parent: null },
  { word: "training_load", label: "Training Load", parent: null },
  { word: "dashboards", label: "Dashboards", parent: "training_load" },
  { word: "imports", label: "Imports", parent: "training_load" },
  { word: "data_configuration", label: "Data configuration", parent: "training_load" },
];

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  actions = await import("../club-licence-actions.js");
  data = await import("../club-licence-data.js");
});

let closed;
function newServer() {
  closed = new Set();
  return installFetchMock(async (call) => {
    if (!String(call.url).endsWith(`/api/organization/roles/clubs/${CLUB}/ceiling`)) return { status: 404, body: { error: "notFound" } };
    const view = () => ({
      clubId: CLUB,
      modules: MODULES.map((m) => ({
        module: m.word, label: m.label, closed: closed.has(m.word), ceilingEffective: true, parent: m.parent,
        closedByParent: Boolean(m.parent) && closed.has(m.parent), effectivelyClosed: closed.has(m.word) || (Boolean(m.parent) && closed.has(m.parent)),
      })),
      history: [],
    });
    if (call.method === "GET") return { status: 200, body: view() };
    const toClose = call.body.close.filter((w) => !closed.has(w));
    const toOpen = call.body.open.filter((w) => closed.has(w));
    if (!toClose.length && !toOpen.length) return { status: 409, body: { error: "ceiling_unchanged", message: "x", current: view() } };
    for (const w of toClose) closed.add(w);
    for (const w of toOpen) closed.delete(w);
    return { status: 200, body: { ...view(), closed: toClose, opened: toOpen } };
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 6; i += 1) await tick(); }
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
const box = (root, module) => root.querySelector(`[data-licence-module="${module}"]`);
const note = (root, module) => root.querySelector(`[data-licence-closed-by-parent="${module}"]`);
const row = (root, module) => box(root, module).closest("li");

async function openLicence() {
  document.body.innerHTML = `<main><div class="club-licence-host" data-club-licence-host data-club-id="${CLUB}" data-club-name="Test Club"></div></main>`;
  const root = document.body.querySelector("main");
  await actions.syncClubLicence(root);
  await settle();
  click(button(root, "Show"));
  await settle();
  return root;
}

beforeEach(() => data.resetClubLicence());

test("1. Training Load saved as closed: its three children read Not included, their switches are off and disabled, each says why; Calendar is untouched", async () => {
  newServer();
  closed.add("training_load");
  const root = await openLicence();
  assert.match(root.textContent, /2 of 6 parts included/, "Organization and Calendar");
  for (const child of ["dashboards", "imports", "data_configuration"]) {
    assert.equal(box(root, child).checked, false, child);
    assert.equal(box(root, child).disabled, true, child);
    assert.match(note(root, child).textContent, /^Closed because Training Load is closed\.$/, child);
    assert.match(row(root, child).textContent, /Not included/, child);
    assert.equal(row(root, child).classList.contains("is-closed-by-parent"), true, `${child}: drawn as closed with its parent`);
    assert.equal(box(root, child).getAttribute("aria-describedby"), note(root, child).id, `${child}: the note describes the switch`);
  }
  assert.equal(box(root, "calendar").checked, true);
  assert.equal(box(root, "calendar").disabled, false);
  assert.equal(note(root, "calendar"), null);
  assert.equal(box(root, "training_load").disabled, false, "the parent's own switch stays usable");
  assert.doesNotMatch(row(root, "training_load").textContent, /does not follow the licence yet/, "the parent follows the licence through its children");
});

test("2. the owner's production shape: the children also taken out on their own say they stay out when Training Load is put back", async () => {
  newServer();
  for (const m of ["training_load", "dashboards", "imports", "data_configuration"]) closed.add(m);
  const root = await openLicence();
  for (const child of ["dashboards", "imports", "data_configuration"]) {
    assert.match(note(root, child).textContent, /Closed because Training Load is closed\. It is also taken out on its own, so it stays out when you put it back\./, child);
  }
});

test("3. the draft: taking Training Load out greys its children at once (one change to save); putting it back draws each child's own state again", async () => {
  const calls = newServer();
  closed.add("imports");
  const root = await openLicence();
  assert.equal(box(root, "dashboards").disabled, false);
  click(box(root, "training_load"));
  await settle();
  for (const child of ["dashboards", "imports", "data_configuration"]) {
    assert.equal(box(root, child).checked, false, child);
    assert.equal(box(root, child).disabled, true, child);
  }
  assert.match(note(root, "imports").textContent, /also taken out on its own/);
  assert.doesNotMatch(note(root, "dashboards").textContent, /also taken out/);
  assert.match(root.textContent, /Take out: Training Load\./);
  assert.doesNotMatch(root.textContent, /Take out: .*Dashboards/, "the children are not sent: only the parent's row is stored");
  // A click on a greyed child changes nothing (the switch is disabled; the data side refuses it too).
  data.toggleLicenceModule("dashboards");
  assert.deepEqual(data.licenceChanges(), { close: ["training_load"], open: [] });
  type(root.querySelector("textarea"), "Season end");
  await settle();
  click(button(root, "Save licence (1 change)"));
  await settle();
  const post = calls.filter((c) => c.method === "POST")[0].body;
  assert.deepEqual(post.close, ["training_load"]);
  assert.deepEqual(post.open, []);
  // Put back: Dashboards and Data configuration are included again, Imports keeps its own row.
  click(box(root, "training_load"));
  await settle();
  assert.equal(box(root, "dashboards").checked, true);
  assert.equal(box(root, "dashboards").disabled, false);
  assert.equal(box(root, "imports").checked, false);
  assert.equal(box(root, "imports").disabled, false);
  assert.equal(note(root, "imports"), null);
});
