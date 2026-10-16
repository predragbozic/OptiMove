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
  assert.match(compact, /\.builder-item-edit-head \.icon-button \{\s*min-width: 44px;\s*min-height: 44px;/, "Back, Previous and Next are 44 px");
  assert.match(compact, /\.builder-item-instruction-preview \{[^}]*-webkit-line-clamp: 3;/, "a folded Instruction shows three lines");
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
  // The Added column is about 260 px wide there: the card's number, picture,
  // Edit details and Remove fit from 568 px up (measured: no overflow).
  assert.match(landscape, /\.builder-added-card \{ column-gap: 4px; \}/);
  assert.match(landscape, /\.builder-added-card-edit \{ padding: 0 4px; \}/);
  assert.match(landscape, /\.builder-exercise-view\.is-tile \.builder-exercise-preview \{[^}]*min-height: 44px;/);
  assert.doesNotMatch(mediaBlock("(max-width: 560px), (max-height: 520px)"), /max-height: calc\(5\.8em/, "a phone held upright keeps the taller Instruction");
});

test("6. phones held upright: in Tile and Big, Add shares the row of Favorite, Mark and Tags; in List it is level with that row", () => {
  const upright = mediaBlock("(max-width: 560px)");
  assert.match(upright, /\.builder-exercise-view\.is-tile \.builder-exercise-result \{ grid-template-columns: 96px minmax\(0, 1fr\) auto;[^}]*grid-template-areas: "media title title" "media meta meta" "actions actions add";/);
  assert.match(upright, /\.builder-exercise-view\.is-big \.builder-exercise-result \{[^}]*grid-template-areas: "media media" "title title" "meta meta" "actions add";/);
  assert.match(upright, /\.builder-exercise-view\.is-tile \.builder-exercise-result-text,\s*\.builder-exercise-view\.is-big \.builder-exercise-result-text \{ display: contents; \}/);
  assert.match(upright, /\.builder-exercise-view\.is-tile \.builder-exercise-add,\s*\.builder-exercise-view\.is-big \.builder-exercise-add \{ grid-area: add;/);
  assert.match(upright, /\.builder-exercise-view\.is-list \.builder-exercise-add \{ align-self: end; \}/);
});

test("7. landscape phones: the Added column scrolls on its own beside the library", () => {
  const landscape = mediaBlock("(min-width: 561px) and (max-height: 520px)");
  assert.match(landscape, /\.builder-section-added \{ position: sticky; top: -10px; align-self: start; max-height: calc\(100dvh - 18px\); overflow-y: auto; overscroll-behavior: contain; \}/);
});

test("8. a dialog's scroll never runs on into the page, and on a touch screen an open dialog locks the page - a hidden one does not", () => {
  assert.match(css, /^\[aria-modal="true"\], \.exercise-detail \{ overscroll-behavior: contain; \}/m);
  const touch = mediaBlock("(pointer: coarse)");
  // The roster's phone sheet has its own lock and stays in the page, hidden
  // by CSS, after a turn to landscape - it must never lock the page.
  assert.match(touch, /html:has\(\[aria-modal="true"\]:not\(\[hidden\], \[hidden\] \*, \.tl-roster-sheet\), \.exercise-detail-overlay\),\s*html:has\(\[aria-modal="true"\]:not\(\[hidden\], \[hidden\] \*, \.tl-roster-sheet\), \.exercise-detail-overlay\) body \{ overflow: hidden; \}/);
  assert.doesNotMatch(css, /html:has\(\[aria-modal="true"\]\)/, "the always-present, hidden media dialog would lock the page for good");
});
