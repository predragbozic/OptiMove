import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 2 of Builder feedback, Phase A: the create form's Program name field
// used to be uncontrolled (no value= binding), so opening the athlete picker
// - which triggers a full re-render - wiped whatever the coach had typed.
// Also: the Icon field is gone (never rendered anywhere), Color is now the
// shared pastel-swatch palette (taxonomy-view.js's renderPastelSwatches,
// already used for domain/category/section preset colors), and the cover
// image URL is now editable from inside an already-open draft, not just at
// creation. builder-view.js/app.js touch `els`/`document` at module scope
// through their import chains, so - same as every other builder-view.js-
// adjacent test in this suite - checked via source-pattern-guard tests over
// the raw file text, never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const builderViewSource = readSource("../builder-view.js");
const appJsSource = readSource("../app.js");
const stateSource = readSource("../state.js");

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

function sliceCreateFormBranch(windowSize) {
  const start = builderViewSource.indexOf("if (!draft) {");
  assert.ok(start >= 0, "the create-form `if (!draft) {` branch must exist");
  return builderViewSource.slice(start, start + windowSize);
}

test("state.js defaults createName/createColor so the create form has something to bind to", () => {
  assert.match(stateSource, /createName: "",/);
  assert.match(stateSource, /createColor: "#C2F0E6",/);
});

test("the create form's name input is bound to state.builder.createName - no longer uncontrolled", () => {
  const formBody = sliceCreateFormBranch(2300);
  assert.match(formBody, /<input name="name" \$\{isWeekly \? "" : "required"\} value="\$\{escapeAttr\(state\.builder\.createName\)\}"/);
});

test("the create form no longer has an Icon select field", () => {
  const formBody = sliceCreateFormBranch(2700);
  assert.doesNotMatch(formBody, /<select name="iconUrl">/);
  assert.doesNotMatch(formBody, />Icon</);
});

test("the create form's Color field uses the shared pastel-swatch palette, not a native color input", () => {
  const formBody = sliceCreateFormBranch(2500);
  assert.doesNotMatch(formBody, /<input name="color" type="color"/);
  assert.match(formBody, /renderPastelSwatches\("color", state\.builder\.createColor, \{ allowCustom: true \}\)/);
});

test("builder-view.js imports renderPastelSwatches from taxonomy-view.js - reusing the existing palette component, not a new one", () => {
  assert.match(builderViewSource, /import \{ renderPastelSwatches \} from "\.\/taxonomy-view\.js";/);
});

test("an already-open draft's header form (update-plan) now includes an editable Cover image URL field for non-weekly plans", () => {
  const start = builderViewSource.indexOf('data-builder-form="update-plan"');
  assert.ok(start >= 0, "the update-plan form must exist");
  const body = builderViewSource.slice(start - 200, start + 600);
  assert.match(body, /name="coverImageUrl"/);
  assert.match(body, /value="\$\{escapeAttr\(draft\.plan\.coverImageUrl \|\| ""\)\}"/);
  assert.match(body, /isWeekly \? "" : `<input name="coverImageUrl"/, "must be hidden for weekly plans, same as the create-form's own field");
});

test("submitBuilderForm's create branch resets createName/createColor after a successful create, so the next new-plan form starts blank", () => {
  const body = sliceFunction(readSource("../builder-actions.js"), "submitBuilderForm", 1300);
  assert.match(body, /state\.builder\.createName = "";/);
  assert.match(body, /state\.builder\.createColor = "#C2F0E6";/);
});

test("handleContentInput mirrors every keystroke in the create form's name input into state.builder.createName, no network call", () => {
  const body = sliceFunction(appJsSource, "handleContentInput", 700);
  assert.match(body, /event\.target\.closest\(".builder-create-form input\[name='name'\]"\)/);
  assert.match(body, /state\.builder\.createName = createNameInput\.value;/);
});

test("handleContentChange mirrors the create form's color-palette hidden input into state.builder.createColor", () => {
  const body = sliceFunction(appJsSource, "handleContentChange", 900);
  assert.match(body, /event\.target\.closest\(".builder-create-form input\[name='color'\]"\)/);
  assert.match(body, /state\.builder\.createColor = createColorInput\.value;/);
});
