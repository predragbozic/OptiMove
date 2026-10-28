// The shared icon picker (PR-1, proposal section 3.3) as the new-variable form
// uses it. Driven through the real handlers and the real markup in a DOM,
// with a fake fetch: the picker opens on the form's own choice with nothing
// preselected otherwise, the search and the chips narrow the grid in place
// (the focus stays), a choice names its stored value, Use icon / Use no icon /
// Cancel hand back exactly that, the picker is modal (the form inert, Tab kept
// inside, a submit refused), the focus returns to the button that opened
// it, a forged or locked click changes nothing, and the create body carries
// iconKey only when one is chosen (a create without one is the same request
// as before icons existed).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock, restoreFetch } from "./support/fetch-mock.mjs";

const dom = new JSDOM(`<!doctype html><body><section id="content"></section></body>`);
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
dom.window.confirm = () => true;
dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

let respond = () => ({ status: 404, body: { error: "notFound" } });
const calls = installFetchMock((call) => respond(call));
after(() => restoreFetch());

const { handleVariablesAction, handleVariablesInput, resetVariables, submitVariablesForm } = await import("../metric-variables-actions.js");
const { buildRequest, openForm, variablesState } = await import("../metric-variables-data.js");
const { renderVariablesHtml } = await import("../metric-variables-view.js");
const { closeIconPicker, handleIconPickerInput } = await import("../icon-picker.js");
const { ICONS, searchIcons } = await import("../icon-render.js");
const { state } = await import("../state.js");

const VB = "/api/training-load/sources/metrics/variables";
const content = document.getElementById("content");
const render = () => { content.innerHTML = renderVariablesHtml(); };
content.addEventListener("input", (event) => {
  if (handleIconPickerInput(event.target)) return;
  handleVariablesInput(event.target, { render });
});
const $ = (selector) => content.querySelector(selector);
const posts = () => calls.filter((call) => call.method === "POST");
async function click(selector) {
  const element = $(selector);
  assert.ok(element, `${selector} is on the screen`);
  await handleVariablesAction(element, { render });
}
function type(field, value) {
  const element = $(`[data-mv-field="${field}"]`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function choose(field, value) {
  const element = $(`[data-mv-field="${field}"]`);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const gridKeys = () => [...content.querySelectorAll("[data-icon-picker-grid] [data-icon-key]")].map((b) => b.dataset.iconKey);

beforeEach(() => {
  resetVariables();
  closeIconPicker();
  calls.length = 0;
  respond = (call) => (call.url.startsWith(`${VB}/key-suggestion`) ? { status: 200, body: { key: "total_distance", taken: false } } : { status: 404, body: { error: "notFound" } });
  state.activeTab = "training-load";
  state.trainingLoad.section = "variables";
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform" } };
  variablesState().view = "variables";
  variablesState().list.loaded = true;
  render();
});

async function openCreate() {
  await click('[data-action="metric-variables-create-open"]');
  type("label", "Total distance");
  type("unit", "m");
  choose("dailyAggregationMethod", "sum");
}

test("1. the create form offers an optional icon; the picker opens as a dialog with the focus in its search and nothing preselected", async () => {
  await openCreate();
  const field = $(".dc-icon-choice");
  assert.match(field.textContent.replace(/\s+/g, " "), /No icon Choose icon/);
  assert.match($("#mv-hint-iconKey").textContent, /Choose it now: after the variable is created its icon cannot be changed yet\./);
  await click('[data-action="metric-variables-icon-open"]');
  const dialog = $('[data-icon-picker] [role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement, $("[data-icon-picker-search]"), "the focus is in the search");
  assert.equal(gridKeys().length, ICONS.length, "every icon at first");
  assert.equal(content.querySelectorAll('[data-icon-picker] [aria-pressed="true"].icon-picker-option').length, 0, "nothing preselected");
  assert.equal($('[data-action="icon-picker-use"]').disabled, true, "Use icon waits for a choice");
  assert.match($("[data-icon-picker-choice]").textContent, /No icon chosen yet\./);
  for (const option of content.querySelectorAll(".icon-picker-option")) assert.match(option.getAttribute("aria-label"), /^[a-z0-9-]+: /, "each icon is named for a screen reader");
});

test("2. the search and the chips narrow the grid in place; the focus stays in the search", async () => {
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  const search = $("[data-icon-picker-search]");
  search.focus();
  search.value = "heart";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(document.activeElement, search, "typing never repaints the search away");
  assert.deepEqual(gridKeys(), searchIcons({ query: "heart" }).map((icon) => icon.key));
  assert.ok(gridKeys().includes("heart-rate"));
  search.value = "zzzz-nothing";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match($("[data-icon-picker-grid]").textContent, /No icon matches\./);
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await click('[data-action="icon-picker-category"][data-icon-category="sport"]');
  assert.ok(gridKeys().length > 5 && gridKeys().every((key) => ICONS.find((icon) => icon.key === key).category === "sport"));
  assert.equal($('[data-icon-category="sport"]').getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement, $('[data-icon-category="sport"]'), "the chip keeps the focus");
});

test("3. a choice is named with its stored value; Use icon puts it in the form, closes the picker and gives the focus back; the body carries iconKey", async () => {
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  await click('[data-action="icon-picker-choose"][data-icon-key="run"]');
  assert.equal($('[data-icon-key="run"]').getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement, $('[data-icon-key="run"]'));
  assert.match($("[data-icon-picker-choice]").textContent.replace(/\s+/g, " "), /Chosen: run · stored as icon:run/);
  assert.equal($('[data-action="icon-picker-use"]').disabled, false);
  await click('[data-action="icon-picker-use"]');
  assert.equal($("[data-icon-picker]"), null, "the picker is closed");
  assert.equal(variablesState().form.draft.iconKey, "run");
  assert.equal(variablesState().form.dirty, true);
  assert.match($(".dc-icon-choice").textContent.replace(/\s+/g, " "), /Chosen: run Change icon Remove icon/);
  assert.equal(document.activeElement, $('[data-action="metric-variables-icon-open"]'), "the focus is back on the button that opened it");
  respond = (call) => (call.method === "POST" ? { status: 201, body: { replayed: false, variable: { id: "v1", label: "Total distance", icon: "run" } } } : { status: 200, body: { variable: { id: "v1", label: "Total distance", icon: "run", versions: [] }, nextCursor: null } });
  await submitVariablesForm($("[data-metric-variables-form]"), { render });
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.iconKey, "run");
});

test("4. reopening starts on the form's choice; No icon clears it; Cancel changes nothing; Remove icon clears without the picker", async () => {
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  await click('[data-action="icon-picker-choose"][data-icon-key="bike"]');
  await click('[data-action="icon-picker-use"]');
  await click('[data-action="metric-variables-icon-open"]');
  assert.equal($('[data-icon-key="bike"]').getAttribute("aria-pressed"), "true", "the current choice is shown chosen");
  await click('[data-action="icon-picker-choose"][data-icon-key="swim"]');
  await click('[data-action="icon-picker-cancel"]');
  assert.equal(variablesState().form.draft.iconKey, "bike", "Cancel keeps the earlier choice");
  await click('[data-action="metric-variables-icon-open"]');
  await click('[data-action="icon-picker-none"]');
  assert.equal(variablesState().form.draft.iconKey, "", "No icon clears it");
  assert.match($(".dc-icon-choice").textContent, /No icon/);
  await click('[data-action="metric-variables-icon-open"]');
  await click('[data-action="icon-picker-choose"][data-icon-key="flame"]');
  await click('[data-action="icon-picker-use"]');
  await click('[data-action="metric-variables-icon-clear"]');
  assert.equal(variablesState().form.draft.iconKey, "");
  assert.equal(document.activeElement, $('[data-action="metric-variables-icon-open"]'));
});

test("5. a forged or locked click changes nothing: an unknown key, a category that is none, a sent form, no open picker", async () => {
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  content.insertAdjacentHTML("beforeend", `<button id="forged" data-action="icon-picker-choose" data-icon-key="&quot;><img src=x>"></button><button id="alias" data-action="icon-picker-choose" data-icon-key="dumbbell"></button><button id="chip" data-action="icon-picker-category" data-icon-category="nope"></button>`);
  await handleVariablesAction($("#forged"), { render });
  await handleVariablesAction($("#alias"), { render });
  await handleVariablesAction($("#chip"), { render });
  assert.equal(state.iconPicker.selected, null, "only a key of the library is taken (never an alias)");
  assert.equal(state.iconPicker.category, "");
  // Even a choice that got into the picker some other way reaches the form only as a key of the library.
  state.iconPicker.selected = "dumbbell";
  await click('.icon-picker [data-action="icon-picker-use"]');
  assert.equal(variablesState().form.draft.iconKey, "", "an alias never lands in the form");
  await click('[data-action="metric-variables-icon-open"]');
  await click('.icon-picker [data-action="icon-picker-cancel"]');
  // A picker action with no picker open is not this screen's.
  content.insertAdjacentHTML("beforeend", `<button id="late" data-action="icon-picker-use"></button>`);
  assert.equal(await handleVariablesAction($("#late"), { render }), false);
  // Once the form is sent, its icon is fixed until the result is known.
  variablesState().form.unconfirmed = true;
  render();
  assert.equal($('[data-action="metric-variables-icon-open"]').disabled, true);
  content.insertAdjacentHTML("beforeend", `<button id="open" data-action="metric-variables-icon-open"></button>`);
  await handleVariablesAction($("#open"), { render });
  assert.equal(state.iconPicker, null, "a sent form opens no picker");
});

test("6. the body: no iconKey without a choice (the request before icons existed); an iconKey that is not a key is a field error, never sent", () => {
  const form = openForm("create");
  Object.assign(form.draft, { label: "Total distance", unit: "m", dailyAggregationMethod: "sum" });
  const plain = buildRequest(form).body;
  assert.ok(plain && !("iconKey" in plain), "no iconKey key at all");
  form.draft.iconKey = "run";
  assert.equal(buildRequest(form).body.iconKey, "run");
  form.draft.iconKey = "dumbbell";
  const wrong = buildRequest(form);
  assert.equal(wrong.body, null);
  assert.equal(wrong.errors.iconKey, "Choose the icon again.");
});

test("7. leaving the form or the workspace closes the picker", async () => {
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  assert.ok(state.iconPicker);
  resetVariables();
  assert.equal(state.iconPicker, null, "a workspace switch closes it");
  variablesState().view = "variables";
  variablesState().list.loaded = true;
  render();
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  // The picker covers the form; its Cancel, then the form's, leave cleanly.
  await click('[data-action="icon-picker-cancel"]');
  await click('[data-action="metric-variables-cancel"]');
  assert.equal(state.iconPicker, null);
  assert.equal(variablesState().form, null);
});

test("8. the picker is modal: the form behind it is inert, Enter never sends it, and Tab stays inside the dialog", async () => {
  const { trapIconPickerTab } = await import("../icon-picker.js");
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  await click('[data-action="icon-picker-choose"][data-icon-key="run"]');
  const form = $("[data-metric-variables-form]");
  assert.equal(form.hasAttribute("inert"), true, "the form is out of reach behind the picker");
  calls.length = 0;
  await submitVariablesForm(form, { render });
  assert.equal(posts().length, 0, "a submit reached behind the picker sends nothing");
  assert.equal(variablesState().form.busy, false);
  // Tab from the last control comes back to the first; Shift+Tab from the
  // first (or from the title) goes to the last; focus outside comes back in.
  const dialog = $("[data-icon-picker] .icon-picker");
  const controls = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled)")];
  const key = (shiftKey) => ({ key: "Tab", shiftKey, prevented: false, preventDefault() { this.prevented = true; } });
  controls.at(-1).focus();
  let event = key(false);
  assert.equal(trapIconPickerTab(event), true);
  assert.equal(event.prevented, true);
  assert.equal(document.activeElement, controls[0]);
  event = key(true);
  assert.equal(trapIconPickerTab(event), true);
  assert.equal(document.activeElement, controls.at(-1));
  $("#icon-picker-title").focus();
  assert.equal(trapIconPickerTab(key(true)), true);
  assert.equal(document.activeElement, controls.at(-1));
  document.body.focus();
  assert.equal(trapIconPickerTab(key(false)), true);
  assert.equal(document.activeElement, controls[0]);
  controls[0].focus();
  event = key(false);
  assert.equal(trapIconPickerTab(event), false, "inside the dialog Tab moves on by itself");
  assert.equal(event.prevented, false);
  // Use icon puts the choice in the form; the form is reachable again and sends it.
  await click('[data-action="icon-picker-use"]');
  assert.equal($("[data-metric-variables-form]").hasAttribute("inert"), false);
  assert.equal(trapIconPickerTab(key(false)), false, "no picker, no trap");
});

test("9. on a touch screen the picker opens with the focus on its title, so the keyboard does not cover it", async () => {
  const before = window.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: query === "(pointer: coarse)" });
  try {
    await openCreate();
    await click('[data-action="metric-variables-icon-open"]');
    assert.equal(document.activeElement, $("#icon-picker-title"));
  } finally {
    delete globalThis.matchMedia;
    window.matchMedia = before;
  }
});

test("10. leaving Data configuration by a section switch or leaving Training Load closes the picker with the form", async () => {
  const { confirmLeaveTrainingLoad, handleTrainingLoadAction } = await import("../training-load-actions.js");
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  const tab = document.createElement("button");
  tab.dataset.action = "training-load-section";
  tab.dataset.section = "today";
  await handleTrainingLoadAction(tab, { renderTrainingLoad: () => {}, openWeeklyPlanForAthleteOnDate: () => {} });
  assert.equal(state.iconPicker, null, "the section switch closes it");
  assert.equal(variablesState().form, null);
  state.trainingLoad.section = "variables";
  render();
  await openCreate();
  await click('[data-action="metric-variables-icon-open"]');
  assert.equal(confirmLeaveTrainingLoad("calendar", { discard: true }), true);
  assert.equal(state.iconPicker, null, "leaving Training Load closes it");
  assert.equal(variablesState().form, null);
});
