// Settings -> Icons (PR-1, proposal section 3.2): a read-only gallery for
// everyone who sees Settings. Its tab is offered without any admin right, it
// lists every icon of the library grouped by category with its key and search
// words, the search and the chips narrow it in place, and Copy key copies the
// stored value (or says it when the browser cannot copy). It sends nothing.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const calls = installFetchMock(() => ({ status: 404, body: {} }));
after(() => restoreFetch());

const { handleIconGalleryAction, handleIconGalleryInput, renderIconGalleryHtml } = await import("../icon-gallery.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
const { ICONS, ICON_CATEGORIES } = await import("../icon-render.js");
const { state } = await import("../state.js");

const content = document.getElementById("content");
const render = () => { content.innerHTML = renderIconGalleryHtml(); };
content.addEventListener("input", (event) => handleIconGalleryInput(event.target));
const $ = (selector) => content.querySelector(selector);
const shownKeys = () => [...content.querySelectorAll(".icon-gallery-item strong")].map((n) => n.textContent);
let copied = [];
let copyFails = false;

beforeEach(() => {
  state.iconGallery = null;
  calls.length = 0;
  copied = [];
  copyFails = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (value) => { if (copyFails) throw new Error("denied"); copied.push(value); } } },
  });
  state.currentUser = { id: "u1", activeWorkspace: { type: "team", scopeId: "t1", clubId: "c1", label: "First team" } };
  render();
});

test("1. the Icons tab is in Settings for everyone, without any admin right", () => {
  const nav = document.createElement("div");
  nav.innerHTML = renderSettingsNavHtml({ isPlatformAdmin: false }, "icons");
  const tab = nav.querySelector('[data-section="icons"]');
  assert.ok(tab);
  assert.equal(tab.textContent, "Icons");
  assert.ok(tab.classList.contains("is-active"));
});

test("2. every icon is listed once, grouped by category in the library's order, with its key, its words and Copy key; nothing is sent", () => {
  assert.deepEqual(shownKeys(), ICON_CATEGORIES.flatMap((c) => ICONS.filter((icon) => icon.category === c.id).map((icon) => icon.key)));
  assert.equal(shownKeys().length, ICONS.length);
  assert.deepEqual([...content.querySelectorAll(".icon-gallery-group h3")].map((h) => h.firstChild.textContent.trim()), ICON_CATEGORIES.map((c) => c.label));
  const run = [...content.querySelectorAll(".icon-gallery-item")].find((li) => li.querySelector("strong").textContent === "run");
  assert.match(run.textContent, /running, sprint, jog/);
  assert.equal(run.querySelector("button").getAttribute("aria-label"), "Copy the key of run");
  assert.match($(".icon-gallery-credit").textContent, /Tabler Icons 3\.50\.0, MIT licence/);
  assert.match($("[data-icon-gallery-count]").textContent, new RegExp(`^${ICONS.length} icons$`));
  assert.equal(content.querySelectorAll("input:not([type=search]), select, textarea, form").length, 0, "nothing to change here");
  assert.equal(calls.length, 0);
});

test("3. the search and a chip narrow the list in place; the focus stays", async () => {
  const search = $("[data-icon-gallery-search]");
  search.focus();
  search.value = "ball";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(document.activeElement, search);
  assert.ok(shownKeys().includes("football") && shownKeys().every((key) => ICONS.find((icon) => icon.key === key)));
  assert.ok(shownKeys().length < ICONS.length);
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await handleIconGalleryAction($('[data-icon-category="recovery"]'));
  assert.ok(shownKeys().every((key) => ICONS.find((icon) => icon.key === key).category === "recovery"));
  assert.match($("[data-icon-gallery-count]").textContent, /in Recovery and wellness$/);
  assert.equal(document.activeElement, $('[data-icon-category="recovery"]'));
  search.value = "zzzz-nothing";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match($("[data-icon-gallery-list]").textContent, /No icon matches\./);
});

test("4. Copy key copies the stored value and says so on the pressed card (the button reads Copied, a screen reader hears it); when the browser cannot copy, that card shows the key to select; a search, a chip or coming back clears it; an unknown key copies nothing", async () => {
  const { enterIconGallery } = await import("../icon-gallery.js");
  const button = (key) => $(`[data-action="icon-gallery-copy"][data-icon-key="${key}"]`);
  const status = () => $("[data-icon-gallery-status]");
  button("run").focus();
  await handleIconGalleryAction(button("run"));
  assert.deepEqual(copied, ["icon:run"]);
  assert.equal(button("run").textContent, "Copied", "the pressed button says it");
  assert.equal(document.activeElement, button("run"), "the focus stays on it");
  assert.equal(status().textContent, "Copied icon:run.");
  assert.equal(status().getAttribute("role"), "status");
  copyFails = true;
  await handleIconGalleryAction(button("bike"));
  assert.equal(button("run").textContent, "Copy key", "the earlier result goes");
  assert.equal(button("bike").textContent, "Copy key");
  const refused = button("bike").closest(".icon-gallery-item").querySelector("[data-icon-gallery-refused]");
  assert.equal(refused?.textContent, "Could not copy. The key is icon:bike.", "the card itself shows the key");
  assert.equal(refused.querySelector("code.icon-gallery-key").textContent, "icon:bike");
  assert.equal(content.querySelectorAll("[data-icon-gallery-refused]").length, 1);
  assert.equal(status().textContent, "Could not copy. The key is icon:bike.");
  render();
  assert.equal(button("bike").closest(".icon-gallery-item").querySelector("[data-icon-gallery-refused]")?.textContent, "Could not copy. The key is icon:bike.", "a repaint keeps it");
  // Coming back to Settings -> Icons shows no earlier result as new: through
  // the Settings sub-tab (Icons -> Overview -> Icons) and on entering Settings.
  const { handleOrganizationAction } = await import("../organization-actions.js");
  for (const section of ["overview", "icons"]) {
    const tab = document.createElement("button");
    tab.dataset.action = "organization-section";
    tab.dataset.section = section;
    assert.equal(await handleOrganizationAction(tab, { renderOrganizationPanel: async () => {}, loadAthletes: async () => {}, refreshOrganizationData: async () => {}, renderAfterOrganizationAccessChange: () => {} }), true);
  }
  render();
  assert.equal(content.querySelectorAll("[data-icon-gallery-refused]").length, 0, "the sub-tab clears it");
  assert.equal(status().textContent, "");
  await handleIconGalleryAction(button("bike"));
  enterIconGallery();
  render();
  assert.equal(content.querySelectorAll("[data-icon-gallery-refused]").length, 0, "entering Settings clears it");
  // A search clears a result too.
  await handleIconGalleryAction(button("bike"));
  const search = $("[data-icon-gallery-search]");
  search.value = "bik";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(content.querySelectorAll("[data-icon-gallery-refused]").length, 0, "a search clears it");
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="icon-gallery-copy" data-icon-key="&lt;b&gt;"></button>`);
  copyFails = false;
  await handleIconGalleryAction($("#forged"));
  assert.deepEqual(copied, ["icon:run"]);
  assert.equal(await handleIconGalleryAction(document.createElement("button")), false, "not the gallery's click");
});
