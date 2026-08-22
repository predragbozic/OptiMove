import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 2 of Builder feedback, Phase D: the domain/category/section preset
// pickers (add-node and edit-node forms) used to be native <datalist>s -
// text-only by construction, a coach had no idea what a preset would look
// like (icon/color) until after placing it. Replaced with a small
// collapsible list (same collapsed-until-clicked interaction as the pastel
// color picker right next to it) where each row shows the preset's real
// icon via the same renderBuilderNodeIcon-style rendering used once it's
// actually in the tree/seen on the Calendar.
//
// builder-actions.js's own import chain touches `document` at module scope
// (same reasoning as builder-day-copy-paste-actions.test.mjs elsewhere in
// this suite), so a minimal stub is installed before the dynamic import.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};
globalThis.window = { confirm: () => true };

const { handleBuilderWorkspaceAction } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const builderStructureSource = readSource("../builder-structure.js");

function noopHandlers(overrides = {}) {
  return {
    renderBuilder: () => {},
    renderBuilderSectionItems: () => false,
    renderBuilderError: () => {},
    renderTabs: () => {},
    renderLibraryNav: () => {},
    loadBuilderExercises: async () => {},
    ...overrides,
  };
}

function makeFakeInput(initial = "") {
  return {
    value: initial,
    dispatchedEvents: [],
    dispatchEvent(event) { this.dispatchedEvents.push(event.type); },
  };
}

// Mirrors just enough of the real DOM shape builder-pick-preset walks:
// action -> closest("form") -> querySelector for each named field, and
// separately action -> closest(".builder-preset-picker") to close it, plus
// colorInput -> closest(".pastel-palette") -> querySelector(".pastel-current-swatch")
// for the visual swatch sync.
function makeFakePresetForm() {
  const nameInput = makeFakeInput("");
  const iconInput = makeFakeInput("");
  const colorInput = makeFakeInput("");
  const currentSwatch = {
    style: {},
    classList: { toggleCalls: [], toggle(cls, on) { this.toggleCalls.push([cls, on]); } },
  };
  const pastelPalette = { querySelector: (sel) => (sel === ".pastel-current-swatch" ? currentSwatch : null) };
  colorInput.closest = (sel) => (sel === ".pastel-palette" ? pastelPalette : null);
  const fields = { '[name="name"]': nameInput, '[name="color"]': colorInput, '[name="iconUrl"]': iconInput };
  const form = { querySelector: (sel) => fields[sel] || null };
  return { form, nameInput, colorInput, iconInput, currentSwatch };
}

function makePresetPickAction({ name, color, iconUrl, form, pickerWrapper }) {
  return {
    dataset: { action: "builder-pick-preset", name, color, iconUrl },
    closest(sel) {
      if (sel === "form") return form;
      if (sel === ".builder-preset-picker") return pickerWrapper;
      return null;
    },
  };
}

function makePickerWrapper() {
  return { classList: { toggleCalls: [], removeCalls: [], toggle(cls) { this.toggleCalls.push(cls); }, remove(cls) { this.removeCalls.push(cls); } } };
}

beforeEach(() => {
  state.builder = emptyBuilderState();
});

test("builder-toggle-preset-picker toggles is-open on the closest .builder-preset-picker - pure DOM, no state, no re-render", async () => {
  const pickerWrapper = makePickerWrapper();
  const action = { dataset: { action: "builder-toggle-preset-picker" }, closest: (sel) => (sel === ".builder-preset-picker" ? pickerWrapper : null) };

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.deepEqual(pickerWrapper.classList.toggleCalls, ["is-open"]);
});

test("builder-pick-preset fills name/color/iconUrl straight from the clicked preset's own data attributes", async () => {
  const { form, nameInput, colorInput, iconInput } = makeFakePresetForm();
  const pickerWrapper = makePickerWrapper();
  const action = makePresetPickAction({ name: "Squat", color: "#C2F0E6", iconUrl: "https://example.com/squat.png", form, pickerWrapper });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(handled, true);
  assert.equal(nameInput.value, "Squat");
  assert.equal(iconInput.value, "https://example.com/squat.png");
  assert.equal(colorInput.value, "#C2F0E6");
});

test("builder-pick-preset dispatches input on the name field (so applyBuilderNodePresetMatch's typed-text auto-fill still runs in the add form) and change on the color field (so the edit form's autosave picks up the whole thing in one save)", async () => {
  const { form, nameInput, colorInput } = makeFakePresetForm();
  const pickerWrapper = makePickerWrapper();
  const action = makePresetPickAction({ name: "Squat", color: "#C2F0E6", iconUrl: "", form, pickerWrapper });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.deepEqual(nameInput.dispatchedEvents, ["input"]);
  assert.deepEqual(colorInput.dispatchedEvents, ["change"]);
});

test("builder-pick-preset also syncs the visual pastel-current-swatch (background + is-empty) and closes the picker", async () => {
  const { form, colorInput, currentSwatch } = makeFakePresetForm();
  const pickerWrapper = makePickerWrapper();
  const action = makePresetPickAction({ name: "Squat", color: "#C2F0E6", iconUrl: "", form, pickerWrapper });

  await handleBuilderWorkspaceAction(action, noopHandlers());

  assert.equal(currentSwatch.style.background, "#C2F0E6");
  assert.deepEqual(currentSwatch.classList.toggleCalls, [["is-empty", false]]);
  assert.deepEqual(pickerWrapper.classList.removeCalls, ["is-open"]);
});

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

test("renderPresetPicker renders one row per matching-type preset, each with an icon and the preset's name", () => {
  const body = sliceFunction(builderStructureSource, "renderPresetPicker", 900);
  assert.match(body, /data-action="builder-pick-preset"/);
  assert.match(body, /data-name="\$\{escapeAttr\(preset\.name\)\}"/);
  assert.match(body, /data-color="\$\{escapeAttr\(preset\.color \|\| ""\)\}"/);
  assert.match(body, /data-icon-url="\$\{escapeAttr\(preset\.icon_url \|\| ""\)\}"/);
  assert.match(body, /renderPresetPickerIcon\(preset\.icon_url\)/);
});

test("renderPresetPicker returns nothing when there are no presets of that node type - no empty picker shown", () => {
  const body = sliceFunction(builderStructureSource, "renderPresetPicker", 900);
  assert.match(body, /if \(!typePresets\.length\) return "";/);
});

test("the add-node form no longer uses a native <datalist> for presets - it uses renderPresetPicker instead", () => {
  const start = builderStructureSource.indexOf("function renderBuilderInlineAddForm(");
  assert.ok(start >= 0);
  const body = builderStructureSource.slice(start, start + 1400);
  assert.doesNotMatch(body, /<datalist/);
  assert.doesNotMatch(body, /\blist="/);
  assert.match(body, /\$\{renderPresetPicker\(type, presets\)\}/);
});

test("the edit-node form no longer uses a native <datalist> for presets - it uses renderPresetPicker instead", () => {
  const start = builderStructureSource.indexOf("export function renderNodeEditForm(");
  assert.ok(start >= 0);
  const body = builderStructureSource.slice(start, start + 1400);
  assert.doesNotMatch(body, /<datalist/);
  assert.doesNotMatch(body, /\blist="/);
  assert.match(body, /\$\{renderPresetPicker\(node\.type, presets\)\}/);
});
