import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { classificationFields, renderClassificationHtml, openExerciseClassification } from "../exercise-classification.js";
import { renderExerciseDetailHtml } from "../exercise-view.js";
import { renderExerciseLibraryHtml, renderExerciseVisibilityFilters } from "../exercise-library.js";
import { exerciseSearchUrl } from "../exercise-data.js";

test("detail Edit is fail-closed and Copy is a distinct capability with the actual exercise ID", () => {
  const render = (item) => renderExerciseDetailHtml({ item, itemId: "item", ids: [], getItemById() {} });
  assert.doesNotMatch(render({ id: "system", owner_scope: "system" }), /exercise-edit-open/);
  assert.doesNotMatch(render({ id: "system", can_edit: false, can_copy: true }), /exercise-edit-open/);
  assert.match(render({ id: "system", can_edit: false, can_copy: true }), /exercise-copy-open/);
  const admin = render({ id: "plan-item", exercise_id: "actual-exercise", can_edit: true, can_copy: true });
  assert.match(admin, /exercise-edit-open/);
  assert.match(admin, /data-exercise-id="actual-exercise"/);
});

test("classification reuses nine existing fields and distinguishes empty personal arrays from inherited values", () => {
  const system = Object.fromEntries(classificationFields.map((field) => [field.key, field.multiple ? ["Original"] : "Original"]));
  const html = renderClassificationHtml({ system, overrides: { bodyParts: [] } });
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelectorAll("[data-classification-override]").length, 9);
  assert.equal(dom.window.document.querySelector('[data-classification-override="bodyParts"]').checked, true);
  assert.equal(dom.window.document.querySelectorAll("fieldset[disabled]").length, 8);
  assert.match(html, /Reset all to system/);
  assert.doesNotMatch(html, /Video URL|Image URL|exerciseCode/);
  dom.window.close();
});

test("classification opening and Cancel do not write; Save preserves deliberate empty lists", async () => {
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const system = Object.fromEntries(classificationFields.map((field) => [field.key, field.multiple ? ["Original"] : "Original"]));
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.method) writes.push({ url, ...options });
    return { ok: true, json: async () => ({ system, overrides: {} }) };
  };
  let refreshes = 0;
  await openExerciseClassification("source", {}, async () => { refreshes++; });
  document.querySelector("[data-classification-close]").click();
  assert.equal(writes.length, 0);
  await openExerciseClassification("source", {}, async () => { refreshes++; });
  const checkbox = document.querySelector('[data-classification-override="bodyParts"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
  document.querySelector('[data-action="classification-remove-value"][data-field="bodyParts"]').click();
  document.querySelector("[data-classification-save]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.deepEqual(JSON.parse(writes[0].body), { overrides: { bodyParts: [] } });
  assert.equal(refreshes, 1);
  assert.equal(document.querySelector('[aria-label="My classification"]'), null);
  dom.window.close();
});

test("per-field and whole-classification Reset remove overrides rather than store original snapshots", async () => {
  const dom = new JSDOM("<body></body>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const system = Object.fromEntries(classificationFields.map((field) => [field.key, field.multiple ? [] : "System"]));
  let saved;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method) saved = JSON.parse(options.body);
    return { ok: true, json: async () => ({ system, overrides: { place: "Mine", purposes: [] } }) };
  };
  await openExerciseClassification("source", {}, async () => {});
  document.querySelector('[data-classification-reset="place"]').click();
  assert.equal(document.querySelector('[data-classification-override="place"]').checked, false);
  document.querySelector("[data-classification-reset-all]").click();
  document.querySelector("[data-classification-save]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, { overrides: {} });
  dom.window.close();
});

test("visibility filters distinguish personal Hidden from global Archive and owner controls are admin-only", () => {
  const coach = renderExerciseVisibilityFilters({});
  assert.match(coach, /Personal visibility/);
  assert.match(coach, /Archive status/);
  assert.match(coach, /My private exercises/);
  assert.doesNotMatch(coach, /data-exercise-filter="owner"/);
  const admin = renderExerciseVisibilityFilters({}, { owners: [{ id: "owner", name: "Owner" }] });
  assert.match(admin, /data-exercise-filter="owner"/);
  assert.match(exerciseSearchUrl("", 30, { hidden: "hidden", visibility: "archived", kind: "private", owner: "owner" }), /hidden=hidden/);
  assert.match(exerciseSearchUrl("", 30, { visibility: "archived" }), /visibility=archived/);
});

test("cards expose classification separately and Restore replaces archive/edit for archived owned rows", () => {
  const props = { exercises: [{ id: "copy", owner_scope: "user", can_edit: true, is_active: false, is_hidden: true }],
    itemIds: ["item"], markedExerciseIds: new Set(), search: { filters: {} }, tagEditor: {} };
  const html = renderExerciseLibraryHtml(props);
  assert.match(html, /My classification/);
  assert.match(html, /Unhide/);
  assert.match(html, /exercise-restore/);
  assert.doesNotMatch(html, /exercise-edit-open|exercise-copy-open/);
});

test("video-only effective media can be opened without requiring an image", () => {
  const html = renderExerciseLibraryHtml({ exercises: [{ id: "copy", video_url: "https://source.test/video" }], itemIds: ["item"],
    markedExerciseIds: new Set(), search: { filters: {}, view: "details" }, tagEditor: {} });
  assert.match(html, /data-video="https:\/\/source.test\/video"/);
  assert.match(html, /media-fallback/);
});

test("Tile, Big, List and Details retain personal actions and the same Edit/Copy/archive permissions", () => {
  for (const view of ["tile", "big", "list", "details"]) {
    const render = (exercise, admin = false) => renderExerciseLibraryHtml({ exercises: [exercise], itemIds: ["item"],
      markedExerciseIds: new Set(), search: { filters: {}, view, canManageCollections: admin }, tagEditor: {} });
    const system = render({ id: "system", owner_scope: "system", can_edit: false, is_active: true });
    assert.match(system, /exercise-classification/, view);
    assert.match(system, /exercise-hide/, view);
    assert.match(system, /exercise-copy-open/, view);
    assert.doesNotMatch(system, /exercise-edit-open|exercise-archive/, view);
    const privateExercise = render({ id: "own", owner_scope: "user", can_edit: true, is_active: true });
    assert.match(privateExercise, /exercise-copy-open/, view);
    assert.match(privateExercise, /exercise-edit-open/, view);
    assert.match(privateExercise, /exercise-archive/, view);
    const archived = render({ id: "archived", owner_scope: "user", can_edit: true, is_active: false, is_hidden: true });
    assert.match(archived, /exercise-restore/, view);
    assert.match(archived, /Unhide/, view);
    assert.doesNotMatch(archived, /exercise-edit-open|exercise-copy-open/, view);
    assert.match(render({ id: "system", owner_scope: "system", can_edit: true }, true), /exercise-edit-open/, view);
  }
});
