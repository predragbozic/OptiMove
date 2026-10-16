import { test } from "node:test";
import assert from "node:assert/strict";

// Instruction / note fields that grow with their text: the first-paint row
// estimate, the measured height, and the fields that use it.

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { autogrowRows, autosizeTextarea, autosizeTextareas, AUTOGROW_SELECTOR } = await import("../textarea-autosize.js");
const { renderBuilderItems, renderBuilderItemEdit, renderCustomExerciseModal } = await import("../builder-exercises.js");
const { renderNodeEditForm } = await import("../builder-structure.js");

test("1. the first paint shows at least three rows, the text's own lines (long lines wrap), at most twelve", () => {
  assert.equal(autogrowRows(""), 3);
  assert.equal(autogrowRows("one line"), 3);
  assert.equal(autogrowRows("a\nb\nc\nd\ne"), 5);
  assert.equal(autogrowRows("x".repeat(250)), 5, "250 characters at about 60 per line");
  assert.equal(autogrowRows(Array.from({ length: 40 }, () => "line").join("\n")), 12);
});

function fakeTextarea({ scrollHeight, laidOut = true, autogrow = true }) {
  const textarea = { style: {}, offsetHeight: 50, clientHeight: 48, scrollHeight, matches: (selector) => autogrow && selector === AUTOGROW_SELECTOR, getClientRects: () => (laidOut ? [{}] : []) };
  return textarea;
}

test("2. the height follows the text plus the borders; hidden or plain fields are left alone", () => {
  const field = fakeTextarea({ scrollHeight: 140 });
  autosizeTextarea(field);
  assert.equal(field.style.height, "142px");
  const hidden = fakeTextarea({ scrollHeight: 0, laidOut: false });
  autosizeTextarea(hidden);
  assert.equal(hidden.style.height, undefined, "a CSS-hidden list is not measured to zero");
  const plain = fakeTextarea({ scrollHeight: 140, autogrow: false });
  autosizeTextarea(plain);
  assert.equal(plain.style.height, undefined);
  const a = fakeTextarea({ scrollHeight: 80 });
  const b = fakeTextarea({ scrollHeight: 200 });
  autosizeTextareas({ querySelectorAll: (selector) => (selector === AUTOGROW_SELECTOR ? [a, b] : []) });
  assert.deepEqual([a.style.height, b.style.height], ["82px", "202px"]);
});

test("3. every Instruction field of a section and the section note grow with their text", () => {
  const long = "Keep the knee soft on landing.\nPause one second at the bottom.\nExhale on the way up.\nStop if the knee hurts.";
  const node = { id: "s1", name: "Mobility", type: "section", note: long, items: [{ id: "i1", title: "Squat", description: long }, { id: "i2", title: "Lunge", description: "" }] };
  const desktop = renderBuilderItems(node);
  assert.equal([...desktop.matchAll(/<textarea name="description" rows="(\d+)" data-autogrow/g)].map((m) => m[1]).join(","), "4,3");
  assert.match(renderBuilderItemEdit(node, "i1", true), /<textarea name="description" rows="4" data-autogrow/);
  assert.match(renderCustomExerciseModal(node), /<textarea name="instruction" rows="3" data-autogrow/);
  assert.match(renderNodeEditForm(node, "Section", true), /<textarea class="builder-text-input" name="note" rows="4" data-autogrow/);
});

test("4. the app sizes a field on every keystroke wherever it is rendered, and again after each Builder repaint", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /document\.addEventListener\("input", \(event\) => \{\s*if \(event\.target\.matches\?\.\(AUTOGROW_SELECTOR\)\) autosizeTextarea\(event\.target\);\s*\}\);/);
  const view = await readFile(new URL("../builder-view.js", import.meta.url), "utf8");
  assert.equal((view.match(/autosizeTextareas\((els\.content|container)\)/g) || []).length, 2, "renderBuilder and renderBuilderSectionItems");
});
