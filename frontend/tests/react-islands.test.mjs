// React islands (owner, 2026-11-24): the mount helper and the phone's bottom bar, through the COMPILED file the app
// itself loads (react-build/islands.js; react-islands-build.test.mjs proves it is a fresh build of react/*.jsx).
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let islands;
let capture;
let dom;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  islands = await import("../react-build/islands.js");
  capture = await import("../app-errors-capture.js");
});

beforeEach(() => { document.body.innerHTML = ""; });

const host = () => document.body.appendChild(document.createElement("div"));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const key = (el, k, extra = {}) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function Hello({ name }) {
  // No JSX in a .mjs test: React's element objects through the island's own React would need its createElement, so
  // the probe component returns DOM text through a tiny wrapper the bar does not need.
  return name;
}

test("mountIsland renders synchronously; mounting the same container again updates it (one root, same DOM)", () => {
  const el = host();
  const handle = islands.mountIsland(el, Hello, { name: "first" });
  assert.equal(el.textContent, "first");
  assert.equal(islands.isIslandMounted(el), true);
  const node = el.firstChild;
  islands.mountIsland(el, Hello, { name: "second" });
  assert.equal(el.textContent, "second");
  assert.ok(el.firstChild === node, "the same text node: React updated it, no second root");
  handle.update({ name: "third" });
  assert.equal(el.textContent, "third");
});

test("unmountIsland removes the island's DOM and root; a second unmount is a no-op", () => {
  const el = host();
  const handle = islands.mountIsland(el, Hello, { name: "x" });
  assert.equal(handle.unmount(), true);
  assert.equal(el.textContent, "");
  assert.equal(islands.isIslandMounted(el), false);
  assert.equal(islands.unmountIsland(el), false);
  // A new mount after an unmount works again.
  islands.mountIsland(el, Hello, { name: "again" });
  assert.equal(el.textContent, "again");
});

test("onError runs after React's own render error removed the tree (the bar's fallback path), never inside React's work", async () => {
  capture.setReporterForTests(() => {});
  const originalError = console.error;
  console.error = () => {};
  try {
    const el = host();
    let got = null;
    // A real render error (not a fake mountIsland that throws): mountIsland returns normally.
    islands.mountIsland(el, () => { throw new TypeError("boom"); }, {}, { name: "probe", onError: (e) => { got = e; } });
    assert.equal(got, null, "not called inside React's work");
    await new Promise((r) => queueMicrotask(r));
    assert.equal(got?.message, "boom");
    assert.equal(el.childElementCount, 0, "the tree is gone");
  } finally {
    console.error = originalError;
    capture.setReporterForTests(null);
  }
});

test("mountIsland refuses anything but an element", () => {
  for (const bad of [null, undefined, {}, document.createTextNode("t")]) assert.throws(() => islands.mountIsland(bad, Hello, {}), TypeError);
});

test("an error inside an island is reported through the app's own capture module (shared, not a bundled copy)", () => {
  const reports = [];
  capture.setReporterForTests((r) => reports.push(r));
  const originalError = console.error;
  console.error = () => {};
  try {
    const el = host();
    const Boom = () => { throw new TypeError("boom"); };
    islands.mountIsland(el, Boom, {}, { name: "probe" });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].action, "react_probe");
    assert.equal(reports[0].code, "handler_error");
    assert.equal(reports[0].reason, "typeerror");
  } finally {
    console.error = originalError;
    capture.setReporterForTests(null);
  }
});

const ICON = '<svg class="rail-icon" viewBox="0 0 24 24"><path d="M1 1"></path></svg>';
function renderBar(props) {
  const el = host();
  const selected = [];
  islands.mountIsland(el, islands.BottomNav, { onSelect: (id) => selected.push(id), ...props });
  return { el, selected };
}
const ITEMS = [
  { id: "home", label: "Home", icon: ICON, active: true },
  { id: "central-calendar", label: "Calendar", icon: ICON, active: false },
];
const MORE = [
  { id: "builder", label: "Builder", icon: ICON, active: false },
  { id: "organization", label: "Settings", icon: ICON, active: false, children: [{ id: "organization/0", label: "Users", active: false }] },
];

test("the bar: one button per section, the current one aria-current, labelled navigation", () => {
  const { el } = renderBar({ items: ITEMS, more: MORE });
  const nav = el.querySelector("nav.om-bottom-nav");
  assert.equal(nav.getAttribute("aria-label"), "Main");
  const buttons = [...nav.querySelectorAll(".om-bottom-nav-item")];
  assert.deepEqual(buttons.map((b) => b.dataset.navId), ["home", "central-calendar", "more"]);
  assert.deepEqual(buttons.map((b) => b.getAttribute("aria-current")), ["page", null, null]);
  assert.ok(buttons[0].classList.contains("is-active"));
  assert.equal(buttons[0].querySelector(".om-bottom-nav-icon").getAttribute("aria-hidden"), "true");
  assert.equal(buttons[2].getAttribute("aria-haspopup"), "dialog");
  assert.equal(buttons[2].getAttribute("aria-expanded"), "false");
});

test("a count on a section shows on the bar and in More, with words for a screen reader", async () => {
  const { el } = renderBar({ items: [{ ...ITEMS[0] }, { id: "tests", label: "Tests", icon: ICON, active: false, badge: "2" }], more: [{ ...MORE[0], badge: "5" }] });
  const tests = el.querySelector('[data-nav-id="tests"]');
  assert.equal(tests.querySelector('.om-bottom-nav-badge [aria-hidden="true"]').textContent, "2");
  assert.equal(tests.querySelector(".om-bottom-nav-badge .visually-hidden").textContent, ", 2 waiting");
  assert.ok(!el.querySelector('[data-nav-id="home"] .om-bottom-nav-badge'), "no badge without a count");
  click(el.querySelector('[data-nav-id="more"]'));
  await tick();
  assert.equal(el.querySelector(".om-bottom-sheet-item .om-bottom-nav-badge [aria-hidden]").textContent, "5");
});

test("the bar without anything for More shows no More button", () => {
  const { el } = renderBar({ items: ITEMS, more: [] });
  assert.ok(!el.querySelector('[data-nav-id="more"]'));
});

test("a tap on a section calls onSelect with its id", () => {
  const { el, selected } = renderBar({ items: ITEMS, more: MORE });
  click(el.querySelector('[data-nav-id="central-calendar"]'));
  assert.deepEqual(selected, ["central-calendar"]);
});

test("More opens a modal sheet with the other sections and their sections; a choice closes it and is passed on", async () => {
  const { el, selected } = renderBar({ items: ITEMS, more: MORE });
  const more = el.querySelector('[data-nav-id="more"]');
  click(more);
  await tick();
  const sheet = el.querySelector('.om-bottom-sheet[role="dialog"]');
  assert.ok(sheet, "the sheet is open");
  assert.equal(sheet.getAttribute("aria-modal"), "true");
  // Outside the fixed bar's stacking context, so its own z-index puts it over the header and the drawer.
  assert.ok(!sheet.closest("nav.om-bottom-nav"), "the sheet is not inside the bar");
  assert.ok(!el.querySelector(".om-bottom-sheet-backdrop").closest("nav"), "nor its backdrop");
  assert.equal(document.getElementById(sheet.getAttribute("aria-labelledby")).textContent, "More");
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(document.getElementById(more.getAttribute("aria-controls"))?.contains(sheet), true);
  assert.deepEqual([...sheet.querySelectorAll(".om-bottom-sheet-item")].map((b) => b.textContent), ["Builder", "Settings"]);
  assert.deepEqual([...sheet.querySelectorAll(".om-bottom-sheet-subitem")].map((b) => b.textContent), ["Users"]);
  assert.equal(document.activeElement?.textContent, "Builder", "focus moves into the sheet, on its first item");
  click(sheet.querySelector(".om-bottom-sheet-subitem"));
  assert.deepEqual(selected, ["organization/0"]);
  await tick();
  assert.ok(!el.querySelector(".om-bottom-sheet"), "the sheet closed");
});

test("Escape, the close button and the backdrop close More and give focus back to the More button", async () => {
  const { el } = renderBar({ items: ITEMS, more: MORE });
  const more = el.querySelector('[data-nav-id="more"]');
  for (const how of ["escape", "close", "backdrop"]) {
    click(more);
    await tick();
    const sheet = el.querySelector(".om-bottom-sheet");
    if (how === "escape") key(sheet.querySelector(".om-bottom-sheet-item"), "Escape");
    if (how === "close") click(sheet.querySelector(".om-bottom-sheet-close"));
    if (how === "backdrop") click(el.querySelector(".om-bottom-sheet-backdrop"));
    await tick();
    assert.ok(!el.querySelector(".om-bottom-sheet"), how);
    assert.ok(document.activeElement === more, `${how}: focus is back on More`);
  }
});

test("Tab stays inside the open sheet (first <-> last)", async () => {
  const { el } = renderBar({ items: ITEMS, more: MORE });
  click(el.querySelector('[data-nav-id="more"]'));
  await tick();
  const sheet = el.querySelector(".om-bottom-sheet");
  const focusables = [...sheet.querySelectorAll("button")];
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  last.focus();
  key(last, "Tab");
  assert.ok(document.activeElement === first, "Tab on the last goes to the first");
  key(first, "Tab", { shiftKey: true });
  assert.ok(document.activeElement === last, "Shift+Tab on the first goes to the last");
});

test("a current section inside More marks the More button and names it for a screen reader", () => {
  const more = [MORE[0], { ...MORE[1], children: [{ id: "organization/0", label: "Users", active: true }] }];
  const { el } = renderBar({ items: ITEMS.map((i) => ({ ...i, active: false })), more });
  const button = el.querySelector('[data-nav-id="more"]');
  assert.ok(button.classList.contains("is-active"));
  assert.equal(button.getAttribute("aria-current"), null, "More is not itself a page");
  assert.equal(button.querySelector(".visually-hidden").textContent, ", current: Users");
});

const OPTIONS = [
  { id: "central-calendar", label: "Calendar" }, { id: "athletes", label: "Athletes" }, { id: "training-load", label: "Training load" },
  { id: "builder", label: "Builder" }, { id: "tests", label: "Tests" },
];
const SLOTS = ["central-calendar", "athletes", "training-load"];
const pick = (select, value) => {
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};
async function openEdit(props) {
  const saved = [];
  const r = renderBar({ items: ITEMS, more: MORE, slots: SLOTS, defaults: SLOTS, options: OPTIONS, onSaveSlots: (s) => saved.push(s), ...props });
  click(r.el.querySelector('[data-nav-id="more"]'));
  await tick();
  const edit = [...r.el.querySelectorAll(".om-bottom-sheet-head button")].find((b) => b.textContent === "Edit menu");
  assert.ok(edit, "More offers Edit menu in its header, above the list");
  click(edit);
  await tick();
  return { ...r, saved };
}
const selects = (el) => [...el.querySelectorAll(".om-bottom-sheet-field select")];

test("Edit menu: three labelled choices after Home, the current ones chosen, only the offered sections", async () => {
  const { el } = await openEdit();
  const sheet = el.querySelector('.om-bottom-sheet[role="dialog"]');
  assert.equal(document.getElementById(sheet.getAttribute("aria-labelledby")).textContent, "Edit menu");
  assert.match(sheet.textContent, /Home stays first/);
  const list = selects(el);
  assert.deepEqual(list.map((s) => s.closest("label").querySelector("span").textContent), ["Second button", "Third button", "Fourth button"]);
  assert.deepEqual(list.map((s) => s.value), SLOTS);
  assert.deepEqual([...list[0].options].map((o) => o.textContent), OPTIONS.map((o) => o.label));
  assert.ok(document.activeElement === list[0], "focus on the first choice");
  // The draft equals the default: no "Use the default".
  assert.ok(![...sheet.querySelectorAll("button")].some((b) => b.textContent === "Use the default"));
});

test("Edit menu: a section another place holds swaps places (never twice on the bar); Save passes the order and closes", async () => {
  const { el, saved } = await openEdit();
  pick(selects(el)[0], "tests");
  await tick();
  assert.deepEqual(selects(el).map((s) => s.value), ["tests", "athletes", "training-load"]);
  pick(selects(el)[2], "tests");
  await tick();
  assert.deepEqual(selects(el).map((s) => s.value), ["training-load", "athletes", "tests"], "chosen again elsewhere: the two swap");
  assert.deepEqual(saved, [], "nothing is kept before Save");
  click([...el.querySelectorAll(".om-bottom-sheet button")].find((b) => b.textContent === "Save"));
  await tick();
  assert.deepEqual(saved, [["training-load", "athletes", "tests"]]);
  assert.ok(!el.querySelector(".om-bottom-sheet"), "the sheet closed");
  assert.ok(document.activeElement === el.querySelector('[data-nav-id="more"]'), "focus back on More");
});

test("Edit menu: Cancel goes back to More without saving; Use the default resets the draft", async () => {
  const { el, saved } = await openEdit({ slots: ["tests", "builder", "athletes"] });
  const sheet = () => el.querySelector(".om-bottom-sheet");
  const reset = [...sheet().querySelectorAll("button")].find((b) => b.textContent === "Use the default");
  assert.ok(reset, "offered while the choice differs from the default");
  click(reset);
  await tick();
  assert.deepEqual(selects(el).map((s) => s.value), SLOTS);
  click([...sheet().querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
  await tick();
  assert.ok(sheet().querySelector(".om-bottom-sheet-list"), "back on the More list");
  assert.deepEqual(saved, []);
});

test("no Edit menu without a choice to make (as many sections as places) or without a save callback", async () => {
  for (const props of [{ options: OPTIONS.slice(0, 3) }, { onSaveSlots: undefined }]) {
    const { el } = renderBar({ items: ITEMS, more: MORE, slots: SLOTS, defaults: SLOTS, options: OPTIONS, onSaveSlots: () => {}, ...props });
    click(el.querySelector('[data-nav-id="more"]'));
    await tick();
    assert.ok(![...el.querySelectorAll(".om-bottom-sheet button")].some((b) => b.textContent === "Edit menu"));
  }
});
