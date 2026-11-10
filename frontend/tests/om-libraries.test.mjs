// Design: the Exercise Library and the Program Library (scope tabs, fields, cards, touch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderProgramScopeTabsHtml } = await import("../program-library.js");
const { renderExerciseLibraryHtml } = await import("../exercise-library.js");
const { emptyExerciseFilters, emptyExerciseOptions } = await import("../state.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const block = (() => { const from = css.indexOf("Design: the Exercise Library and the Program Library."); assert.ok(from > 0); const end = css.indexOf("\n/* =====", from + 10); return css.slice(from, end > 0 ? end : undefined); })();
const html = (markup) => { const host = document.createElement("div"); host.innerHTML = markup; return host; };

test("the Program Library scope buttons are an .om-tabs row with the active one marked", () => {
  const scopes = ["my_programs", "optimove", "marketplace"];
  const nav = html(renderProgramScopeTabsHtml({ scopes, activeScope: "optimove", scopeLabel: (s) => s, showRequests: true, requestCount: 2 })).querySelector("nav");
  assert.equal(nav.className, "program-scope-tabs om-tabs");
  assert.equal(nav.getAttribute("aria-label"), "Program library scope");
  const buttons = [...nav.querySelectorAll("button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["my_programs", "Requests (2)", "optimove", "marketplace"]);
  assert.ok(buttons.every((b) => b.classList.contains("om-tab") && b.classList.contains("program-scope-button")));
  assert.deepEqual(buttons.filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.dataset.scope), ["optimove"]);
  assert.equal(buttons[1].dataset.action, "program-library-section");
  const requests = html(renderProgramScopeTabsHtml({ scopes, activeScope: "optimove", activeSection: "requests", scopeLabel: (s) => s, showRequests: true })).querySelectorAll('[aria-current="page"]');
  assert.deepEqual([...requests].map((b) => b.dataset.programLibrarySection), ["requests"], "only Requests is current in its section");
  assert.match(app, /restorePreviewScroll\(keptScroll, document\);\n  \/\/ The scope tabs scroll sideways on a phone: keep the active one in view\.\n  revealActiveTab\(els\.content\);/);
});

test("the Program Library's selects look like its inputs, and a phone gets 44 px fields with 16 px text", () => {
  assert.match(block, /\.program-filter-panel select \{\n\s+height: 42px;[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?font: inherit;/);
  const phone = block.slice(block.indexOf("@media (max-width: 760px)"));
  assert.ok(phone.length > 30);
  for (const sel of [".program-filter-panel input,", ".program-filter-panel select,", ".program-paid-filter,", "#exerciseSearch,", ".exercise-filter-strip .builder-text-input {"]) assert.ok(phone.includes(sel), sel);
  assert.match(phone, /\.exercise-filter-strip \.builder-text-input \{\n\s+min-height: var\(--om-tap-target\);\n\s+font-size: 16px;/);
});

test("the cards use the .om-card border, radius and surface", () => {
  assert.match(block, /\.program-filter-panel,\n\.program-library-card,\n\.exercise-card \{\n\s+border-color: var\(--om-border-subtle\);\n\s+border-radius: var\(--om-radius-lg\);\n\s+background: var\(--om-surface-raised\);/);
  assert.match(block, /\.program-library-info-button::after \{\n\s+content: "";\n\s+position: absolute;\n\s+inset: -8px;/, "28 + 2 x 8 = 44 px");
});

test("on a phone every action of an exercise card is a 44 px touch target, and Delete reads as destructive", () => {
  const exercise = { id: "e1", name: "Box jump", owner_scope: "user", can_edit: true, is_active: true, tags: [] };
  const host = html(renderExerciseLibraryHtml({
    exercises: [exercise], itemIds: ["i1"], markedExerciseIds: new Set(),
    search: { term: "", view: "details", filters: emptyExerciseFilters(), options: emptyExerciseOptions(), lockedPreviews: [] },
    tagEditor: { open: false },
  }));
  const actions = host.querySelector(".exercise-card .exercise-card-actions");
  assert.ok(actions.querySelector('.text-action[data-action="exercise-delete"]'), "the selector matches the real card");
  assert.match(block, /\.exercise-card-actions \[data-action="exercise-delete"\] \{\n\s+color: var\(--danger\);/);
  const phone = block.slice(block.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.exercise-card-actions \.text-action \{\n\s+display: inline-flex;\n\s+align-items: center;\n\s+min-height: var\(--om-tap-target\);/);
});
