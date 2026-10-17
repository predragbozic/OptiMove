import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderExerciseLibraryHtml } from "../exercise-library.js";
import { renderExerciseBlocksHtml } from "../exercise-blocks.js";

// The owner's phone round (2026-10-17): Blocks sits beside the view icons in
// one consistent group, and managing application blocks leaves the plain
// library - a gear in the Blocks view, and inside a block a gear that edits
// that block.

const BLOCK = "11111111-1111-1111-1111-111111111111";
function library({ admin = false, collection = "", name = "" } = {}) {
  const filters = collection ? { collection } : {};
  const html = renderExerciseLibraryHtml({ exercises: [], itemIds: [], markedExerciseIds: new Set(), search: { view: "list", term: "", filters, options: {}, collectionName: name, canManageCollections: admin }, tagEditor: { open: false } });
  return new JSDOM(html).window.document;
}

test("1. the plain library: Blocks right before the views in one group, Add apart, and no block management - also for an administrator", () => {
  for (const admin of [false, true]) {
    const doc = library({ admin });
    const group = doc.querySelector(".exercise-results-head > .exercise-browse-controls");
    const blocks = group.querySelector('[data-action="exercise-blocks-open"]');
    assert.ok(blocks.classList.contains("exercise-browse-button"));
    assert.equal(blocks.getAttribute("aria-label"), "Exercise blocks");
    assert.equal(blocks.nextElementSibling, group.querySelector(".exercise-view-switcher"), "Blocks is beside the views");
    assert.equal(doc.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
    assert.doesNotMatch(doc.body.textContent, /Manage application blocks/);
    assert.ok(doc.querySelector('.exercise-results-head > [data-action="exercise-add-open"]'));
    assert.equal(doc.querySelector(".exercise-block-chip"), null);
  }
});

test("2. inside a block: its name is a chip that leaves it, and only an administrator gets the gear that edits that block", () => {
  const coach = library({ collection: BLOCK, name: "Ankle <stiffness>" });
  const chip = coach.querySelector('.exercise-results-filters > .exercise-block-chip[data-action="exercise-blocks-clear"]');
  assert.equal(chip.textContent, "Block: Ankle <stiffness>×");
  assert.equal(chip.getAttribute("aria-label"), "Leave block Ankle <stiffness> and show all exercises");
  assert.equal(coach.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  assert.doesNotMatch(coach.body.innerHTML, /Selected block/);

  const admin = library({ admin: true, collection: BLOCK, name: "Ankle" });
  const gear = admin.querySelector('.exercise-browse-controls.has-block-edit > [data-action="exercise-collections-open"]');
  assert.equal(gear.dataset.collectionId, BLOCK);
  assert.equal(gear.getAttribute("aria-label"), "Edit this block");
  assert.equal(gear.nextElementSibling.dataset.action, "exercise-blocks-open");

  const other = library({ admin: true, collection: "other" });
  assert.equal(other.querySelector(".exercise-block-chip").textContent, "Block: Other×");
  assert.equal(other.querySelectorAll('[data-action="exercise-collections-open"]').length, 0, "Other is no block to edit");
  assert.equal(library({ collection: BLOCK }).querySelector(".exercise-block-chip").textContent, "Block: Selected block×");
});

test("3. the Blocks view: All exercises and, for an administrator, the gear that manages application blocks", () => {
  const data = { blocks: [{ id: BLOCK, name: "Ankle", description: "", exerciseCount: 3, coverImageUrl: "", locked: false }], other: { id: "other", name: "Other", exerciseCount: 0 } };
  const admin = new JSDOM(renderExerciseBlocksHtml({ ...data, canManageCollections: true })).window.document;
  const gear = admin.querySelector('.exercise-blocks-head .exercise-browse-controls > [data-action="exercise-collections-open"]:not([data-collection-id])');
  assert.equal(gear.getAttribute("aria-label"), "Manage application blocks");
  assert.ok(gear.querySelector("svg"));
  assert.ok(admin.querySelector(".exercise-blocks-head [data-block-exercises].exercise-browse-button"));
  assert.doesNotMatch(admin.body.textContent, /Create \/ manage blocks/);
  const coach = new JSDOM(renderExerciseBlocksHtml({ ...data, canManageCollections: false })).window.document;
  assert.equal(coach.querySelectorAll('[data-action="exercise-collections-open"]').length, 0);
  // Opening a block carries its name for the chip.
  assert.ok([...admin.querySelectorAll("[data-open-block]")].every((button) => button.dataset.blockName === "Ankle"));
});

test("4. one look and touch size: the group's buttons match the switcher, phones stack count and Add, the badges, then the group", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-browse-button \{ display: inline-flex;[^}]*min-height: 38px;[^}]*border-radius: 8px; background: var\(--surface-soft\);/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.exercise-results-head \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "count add" "filters filters" "browse browse";[^}]*\}[^]*?\.exercise-block-chip \{ min-height: 44px; \}\s*\.exercise-browse-button \{ min-height: 50px; padding: 0 14px; \}\s*\.exercise-browse-button\.is-icon \{ width: 50px; padding: 0; \}/);
  assert.match(css, /@media \(max-width: 400px\) \{\s*\.exercise-browse-controls\.has-block-edit \.exercise-browse-button \{ width: 50px; padding: 0; \}/);
});
