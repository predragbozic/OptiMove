import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The owner's phone round (2026-10-16): exercise names cut to two lines with
// a tap to show them whole; on a landscape phone the Added column uses the
// same compact cards and single-exercise view as a phone held upright
// (Edit details with a pencil, Instruction folded, about four lines when
// open); and the library's Tile cards are short enough for two columns.

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { toggleClampedTitle, CLAMP_TITLE_SELECTOR } = await import("../title-clamp.js");
const { renderBuilderExerciseResult, renderBuilderAddedList } = await import("../builder-exercises.js");

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

// The @media blocks whose query is exactly `query`, joined.
function mediaBlock(query) {
  const blocks = [];
  for (let start = css.indexOf(`@media ${query} {`); start !== -1; start = css.indexOf(`@media ${query} {`, start + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { blocks.push(css.slice(start, i + 1)); break; }
    }
  }
  assert.ok(blocks.length, `no @media ${query} block`);
  return blocks.join("\n");
}

function fakeTitle({ scrollHeight, clientHeight, expanded = false }) {
  const classes = new Set(expanded ? ["is-expanded"] : []);
  const title = {
    scrollHeight, clientHeight,
    classList: { contains: (c) => classes.has(c), toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)) },
  };
  title.closest = (selector) => (selector === CLAMP_TITLE_SELECTOR ? title : null);
  return title;
}

test("1. a tap on a cut name shows it whole and a second tap folds it; a name that fits or another element is left alone", () => {
  const cut = fakeTitle({ scrollHeight: 60, clientHeight: 40 });
  assert.equal(toggleClampedTitle(cut), true);
  assert.equal(cut.classList.contains("is-expanded"), true);
  cut.clientHeight = 60;
  assert.equal(toggleClampedTitle(cut), true, "an unfolded name folds again");
  assert.equal(cut.classList.contains("is-expanded"), false);
  const fits = fakeTitle({ scrollHeight: 40, clientHeight: 40 });
  assert.equal(toggleClampedTitle(fits), false);
  assert.equal(fits.classList.contains("is-expanded"), false);
  assert.equal(toggleClampedTitle({ closest: () => null }), false);
  assert.equal(toggleClampedTitle(null), false);
});

test("2. the result and Added card names can be cut, Edit details carries a pencil, Add keeps its word for screen readers", () => {
  const result = renderBuilderExerciseResult({ id: "e1", name: "Brza promena nogu u skipu sa vučenjem gume", tags: [] }, new Set(), 1);
  assert.match(result, /<strong data-clamp-title>Brza promena nogu u skipu sa vučenjem gume<\/strong>/);
  assert.match(result, /<span class="builder-exercise-add-plus" aria-hidden="true">\+<\/span><span class="builder-exercise-add-label">Add again<\/span>/);
  const added = renderBuilderAddedList({ items: [{ id: "i1", title: "Hod sa zaključavanjem kuka" }, { id: "i2", title: "Skip" }] });
  assert.match(added, /<strong class="builder-added-card-title" data-clamp-title>Hod sa zaključavanjem kuka<\/strong>/);
  assert.match(added, /data-action="builder-open-edit-item" data-item-id="i1"><svg[^>]*class="builder-icon-svg"[\s\S]*?<\/svg><span>Edit details<\/span><\/button>/);
});

test("3. the app unfolds a cut name on a tap in the content area", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ toggleClampedTitle \} from "\.\/title-clamp\.js";/);
  assert.match(app, /els\.content\.addEventListener\("click", \(event\) => \{ toggleClampedTitle\(event\.target\); \}\);/);
});

test("4. phones and landscape phones: two-line names, compact Added cards and the single-exercise view instead of the desktop forms", () => {
  const compact = mediaBlock("(max-width: 560px), (max-height: 520px)");
  assert.match(compact, /\.builder-section-panel \[data-clamp-title\] \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(compact, /\.builder-section-panel \[data-clamp-title\]\.is-expanded \{[^}]*-webkit-line-clamp: unset;/);
  assert.match(compact, /\.builder-added-list-desktop \{\s*display: none;\s*\}/);
  assert.match(compact, /\.builder-added-list-compact \{\s*display: flex;/);
  assert.match(compact, /\.builder-item-edit \{\s*display: block;\s*\}/);
  assert.match(compact, /\.builder-item-edit \.builder-item-dose \{\s*margin-left: 0;\s*\}/);
  // The sticky Added bar and Add / Added mode switching stay phone-upright only.
  assert.doesNotMatch(compact, /\.builder-mobile-sticky-bar \{\s*display: flex;/);
  assert.match(mediaBlock("(max-width: 560px)"), /\.builder-mobile-sticky-bar \{\s*display: flex;/);
});

test("5. landscape phones: about four lines of Instruction, and short two-column Tile cards", () => {
  const landscape = mediaBlock("(min-width: 561px) and (max-height: 520px)");
  assert.match(landscape, /\.builder-item-edit textarea\[data-autogrow\] \{ max-height: calc\(5\.8em \+ 18px\); \}/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-result \{[^}]*grid-template-areas: "media title title" "media meta meta" "actions actions add";/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-result-text \{ display: contents; \}/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-mini-actions \{[^}]*flex-wrap: nowrap;/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-add-label \{ position: absolute;[^}]*clip: rect\(0 0 0 0\);/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-add-plus \{ display: inline; \}/);
  assert.match(css, /^\.builder-exercise-add-plus \{ display: none; \}/m, "elsewhere Add says its word");
  assert.doesNotMatch(mediaBlock("(max-width: 560px), (max-height: 520px)"), /max-height: calc\(5\.8em/, "a phone held upright keeps the taller Instruction");
});
