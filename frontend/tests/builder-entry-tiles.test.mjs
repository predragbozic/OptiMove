import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Phase 5 of the Builder feature set: the entry screen (shown before any
// draft is open) is redesigned from a two-button plan-type toggle into three
// icon tiles - Weekly plan / Program / Template - each jumping straight into
// that type's setup form. builder-view.js touches `els`/`document` at module
// scope through its import chain, so - same as every other builder-view.js-
// adjacent test in this suite - it's checked via source-pattern-guard tests
// over the raw file text, never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const builderViewSource = readSource("../builder-view.js");
const cssSource = readSource("../styles.css");

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

test("BUILDER_ENTRY_TILES lists exactly three tiles - weekly, program, template - each with its own icon", () => {
  assert.match(builderViewSource, /const BUILDER_ENTRY_TILES = \[\s*\["weekly", "Weekly plan", ICON_ENTRY_WEEKLY\],\s*\["program", "Program", ICON_ENTRY_PROGRAM\],\s*\["template", "Template", ICON_ENTRY_TEMPLATE\],\s*\];/);
});

test("renderBuilderEntryTiles renders each tile as a button with data-action=builder-choose-entry-type and data-entry-type", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderEntryTiles", 1200);
  assert.match(body, /data-action="builder-choose-entry-type"/);
  assert.match(body, /data-entry-type="\$\{entryType\}"/);
});

test("the entry tiles reuse the existing .athlete-home-quick-action/.athlete-home-quick-actions-grid classes, not a new parallel class set", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderEntryTiles", 1200);
  assert.match(body, /class="athlete-home-quick-actions-grid builder-entry-tiles-grid"/);
  assert.match(body, /class="athlete-home-quick-action" type="button"/);
  assert.match(body, /class="athlete-home-quick-action-label"/);
});

test("each entry-tile icon carries the athlete-home-quick-action-icon class so it inherits the same stroke/size styling as the reused tile", () => {
  assert.match(builderViewSource, /const ICON_ENTRY_WEEKLY = `<svg class="athlete-home-quick-action-icon"/);
  assert.match(builderViewSource, /const ICON_ENTRY_PROGRAM = `<svg class="athlete-home-quick-action-icon"/);
  assert.match(builderViewSource, /const ICON_ENTRY_TEMPLATE = `<svg class="athlete-home-quick-action-icon"/);
});

test("renderBuilderInner shows the tile grid (not the create form) when no draft is open and no entry type has been chosen yet", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderInner", 900);
  assert.match(body, /if \(!draft && !state\.builder\.entryType\) \{/);
  assert.match(body, /\$\{renderBuilderEntryTiles\(\)\}/);
});

function sliceCreateFormBranch(windowSize) {
  const start = builderViewSource.indexOf("if (!draft) {");
  assert.ok(start >= 0, "the create-form `if (!draft) {` branch must exist");
  return builderViewSource.slice(start, start + windowSize);
}

test("renderBuilderInner falls through to the create form once entryType is chosen, and the form no longer contains the old two-way plan-type toggle", () => {
  const formBody = sliceCreateFormBranch(3600);
  assert.match(formBody, /data-builder-form="create"/);
  assert.doesNotMatch(formBody, /builder-plan-type-control/);
  assert.doesNotMatch(formBody, /data-action="builder-set-plan-type"/);
});

test("the create-form heading and subtitle distinguish Program from Template even though both share planType=\"program\"", () => {
  const formBody = sliceCreateFormBranch(1600);
  assert.match(formBody, /const isTemplate = state\.builder\.entryType === "template";/);
  assert.match(formBody, /isTemplate \? "Create template" : "Create program"/);
});

test("a Back control returns from the create form to the tile grid via builder-entry-back", () => {
  const formBody = sliceCreateFormBranch(1600);
  assert.match(formBody, /data-action="builder-entry-back"/);
});

test("styles.css defines the entry-tiles grid layout without redefining .athlete-home-quick-action's own tile styling", () => {
  assert.match(cssSource, /\.builder-entry-tiles-grid \{/);
  assert.doesNotMatch(cssSource, /\.builder-entry-tiles \.athlete-home-quick-action \{/);
});
