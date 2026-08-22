import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 2 of Builder feedback, Phase C: two performance issues.
//
// 1. Typing quickly through a section's Sets/Reps/Load fields (tabbing
//    between them) could feel like it "kicks out" mid-keystroke - each
//    field's own blur independently fires an autosave (change event on
//    [data-builder-autosave]), and the resulting DOM rebuild
//    (renderBuilderSectionItems, builder-view.js) can land while the coach
//    has already moved on to typing in the NEXT field, resetting it back to
//    its last-saved value. Debouncing update-item's autosave per item
//    coalesces a whole Sets->Reps->Load pass into one save+rebuild after the
//    coach actually pauses, and since FormData is only read once the
//    debounced call fires, it always picks up whatever's currently in the
//    DOM - never a stale snapshot.
// 2. Clicking Edit/Copy on a plan took 5-10s to show anything: both handlers
//    awaited loadBuilderExercises() (two of its own serial network calls)
//    BEFORE the Builder shell was ever painted - nothing rendered until
//    loadBuilderExercises() itself fell through to a renderBuilder() call.
//    Now renderBuilder() is called immediately after the draft is set, and
//    the exercise-library panel fills in right after/in parallel.
//
// app.js/builder-actions.js touch `document`/state at module scope through
// their import chains, so - same as every other app.js/builder-actions.js-
// adjacent test in this suite - checked via source-pattern-guard tests over
// the raw file text, never imported directly.

function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const appJsSource = readSource("../app.js");
const builderActionsSource = readSource("../builder-actions.js");

function sliceFunction(source, name, windowSize = 1200) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

test("handleContentChange debounces update-item autosave, keyed per item, instead of saving on every single field's blur", () => {
  const body = sliceFunction(appJsSource, "handleContentChange", 5000);
  assert.match(body, /if \(form\.dataset\.builderForm === "update-item"\) \{/);
  assert.match(body, /const key = form\.dataset\.itemId \|\| form;/);
  assert.match(body, /clearTimeout\(builderAutosaveTimers\.get\(key\)\);/);
  assert.match(body, /builderAutosaveTimers\.set\(key, setTimeout\(\(\) => \{/);
});

test("the update-item debounce delay is a small, named constant, not a magic number", () => {
  assert.match(appJsSource, /const BUILDER_ITEM_AUTOSAVE_DEBOUNCE_MS = 500;/);
});

test("other autosave forms (update-block, update-node, update-session, update-plan) are NOT debounced - only update-item has the sibling-field tabbing problem", () => {
  const body = sliceFunction(appJsSource, "handleContentChange", 5000);
  // The non-debounced fallback path must still exist right after the
  // update-item branch's early return, for every other data-builder-form.
  assert.match(body, /return;\s*\}\s*try \{\s*await submitBuilderFormAction\(form,/);
});

test("a debounced update-item save still surfaces errors the same way an immediate one would", () => {
  const body = sliceFunction(appJsSource, "handleContentChange", 5000);
  assert.match(body, /submitBuilderFormAction\(form, \{ loadBuilderExercises, renderBuilder, renderBuilderSectionItems, renderBuilderAddFeedback \}\)\.catch\(renderBuilderError\);/);
});

test("builder-edit-plan renders the Builder shell before awaiting loadBuilderExercises(), not after", () => {
  const start = builderActionsSource.indexOf('if (type === "builder-edit-plan")');
  assert.ok(start >= 0);
  const body = builderActionsSource.slice(start, start + 3200);
  const renderIndex = body.indexOf("handlers.renderBuilder();");
  const loadIndex = body.indexOf("await handlers.loadBuilderExercises();");
  assert.ok(renderIndex >= 0, "handlers.renderBuilder() must be called in this handler");
  assert.ok(loadIndex >= 0, "loadBuilderExercises() must still be awaited");
  assert.ok(renderIndex < loadIndex, "the Builder shell must render BEFORE the exercise-library panel's own fetches are awaited, not after");
});

test("builder-confirm-duplicate-plan (the non-assign 'Copy' path) also renders the Builder shell before awaiting loadBuilderExercises()", () => {
  const dupStart = builderActionsSource.indexOf('if (type === "builder-confirm-duplicate-plan")');
  assert.ok(dupStart >= 0);
  // The isAssign branch (a different, earlier "return true" path in this
  // same handler) has its own renderBuilder() call too - anchor the search
  // to the non-assign branch's own setBuilderDraft(created, ...) call, not
  // just the handler's start, or this would match the wrong renderBuilder().
  const setDraftIndex = builderActionsSource.indexOf("setBuilderDraft(created, { preserveBatch: false });", dupStart);
  assert.ok(setDraftIndex >= 0, "the non-assign branch's setBuilderDraft call must exist");
  const afterSetDraft = builderActionsSource.slice(setDraftIndex, setDraftIndex + 900);
  const renderIndex = afterSetDraft.indexOf("handlers.renderBuilder();");
  const loadIndex = afterSetDraft.indexOf("await handlers.loadBuilderExercises();");
  assert.ok(renderIndex >= 0 && loadIndex >= 0, "both calls must be present shortly after setBuilderDraft");
  assert.ok(renderIndex < loadIndex, "the Builder shell must render before the exercise-library panel's own fetches are awaited");
});
