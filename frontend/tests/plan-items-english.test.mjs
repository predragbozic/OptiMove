import { test } from "node:test";
import assert from "node:assert/strict";

// English for plan items (owner, 2026-11-03: "ako trener postavi da vidi
// svoje vezbe na engleskom onda vidi i u builderu vidi vezbe na engleskom,
// osim ako vezba ima samo srpski naziv vidi samo to sto ima. Ako mu je profil
// postavljen na srpski vidi vezbe na srpskom."). The server sends the
// exercise's English beside an item's stored text only while the item still
// carries that exercise's text; planItemText picks by the reader's language.
// The Builder shows the same text in its fields and sends the Instruction
// back only once the coach has changed it, so an English text shown there is
// never written over the stored Serbian.

const fakeElements = new Map();
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] });
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { state, emptyBuilderState } = await import("../state.js");
const { planItemText } = await import("../exercise-text.js");
const { renderExerciseDetailHtml, renderExerciseItemHtml } = await import("../exercise-view.js");
const { renderBuilderAddedList, renderBuilderItemEdit, renderBuilderItems } = await import("../builder-exercises.js");
const { submitBuilderForm } = await import("../builder-actions.js");
const { rememberBuilderItemEdit, clearBuilderItemEdits } = await import("../builder-item-edits.js");

const EN = { contentLanguage: "en" };
const SR = { contentLanguage: "sr" };
const as = (user, fn) => { const before = state.currentUser; state.currentUser = user; try { return fn(); } finally { state.currentUser = before; } };
const asAsync = async (user, fn) => { const before = state.currentUser; state.currentUser = user; try { return await fn(); } finally { state.currentUser = before; } };

// A view row (toPlanItem, snake_case) and a Builder item (camelCase).
const row = (overrides = {}) => ({
  plan_item_id: "pi-1", item_type: "exercise", exercise_id: "ex-1", title: "Iskorak", description: "Korak napred.",
  title_en: "Lunge", description_en: "Step forward.", sets: "3", reps: "8", load: "", ...overrides,
});
const builderItem = (overrides = {}) => ({
  id: `item-${Math.random().toString(36).slice(2)}`, exerciseId: "ex-1", title: "Iskorak", description: "Korak napred.",
  titleEn: "Lunge", descriptionEn: "Step forward.", sets: "", reps: "", load: "", imageUrl: "", videoUrl: "", ...overrides,
});
const draftWith = (items) => ({
  plan: { id: "plan-1", status: "draft" }, batch: null,
  blocks: [{ id: "block-1", sessions: [{ id: "session-1", nodes: [{ id: "section-1", type: "section", name: "S", items }] }] }],
});
function useDraft(items) {
  state.builder = emptyBuilderState();
  state.builder.draft = draftWith(items);
  state.builder.selectedNodeId = "section-1";
}
function formData(entries) {
  globalThis.FormData = class { [Symbol.iterator]() { return entries[Symbol.iterator](); } };
}
function fetchAnswering(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const body = typeof answer === "function" ? answer(calls.at(-1)) : answer;
    return { ok: true, status: 200, statusText: "", json: async () => body };
  };
  return calls;
}
const handlers = () => ({ renderBuilder: () => {}, renderBuilderSectionItems: () => false, renderBuilderAddFeedback: () => false, renderBuilderError: () => {}, refreshBuilderDraft: async () => {} });
const updateForm = (itemId) => ({ dataset: { builderForm: "update-item", itemId } });

test("1. planItemText: an English reader sees the English the server sent, otherwise the stored text; a Serbian reader always the stored text", () => {
  assert.equal(planItemText(row(), "title", EN), "Lunge");
  assert.equal(planItemText(row(), "description", EN), "Step forward.");
  assert.equal(planItemText(builderItem(), "title", EN), "Lunge", "the Builder's camelCase keys");
  assert.equal(planItemText(row(), "title", SR), "Iskorak");
  assert.equal(planItemText(row(), "description", SR), "Korak napred.");
  assert.equal(planItemText(row(), "title", null), "Iskorak", "no user: the stored text");
  assert.equal(planItemText(row({ title: "Moj iskorak", title_en: null }), "title", EN), "Moj iskorak", "a coach's own title: as stored");
  assert.equal(planItemText(row({ title_en: "  " }), "title", EN), "Iskorak", "a blank English: the stored text");
  assert.equal(planItemText(row({ description: null, description_en: null }), "description", EN), "");
});

test("2. the athlete's plan rows and the detail opened from a plan item, for an English and a Serbian reader", () => {
  const en = as(EN, () => renderExerciseItemHtml(row(), "pi-1", "horizontal"));
  assert.match(en, /class="item-title">Lunge</);
  assert.match(en, /class="item-description">Step forward\.</);
  assert.doesNotMatch(en, /Iskorak|Korak napred/);
  const vertical = as(EN, () => renderExerciseItemHtml(row(), "pi-1", "vertical"));
  assert.match(vertical, /class="item-title">Lunge</);
  const sr = as(SR, () => renderExerciseItemHtml(row(), "pi-1", "horizontal"));
  assert.match(sr, /class="item-title">Iskorak</);
  assert.match(sr, /class="item-description">Korak napred\.</);
  const renamed = as(EN, () => renderExerciseItemHtml(row({ title: "Moj iskorak", title_en: null, description: "Moje.", description_en: null }), "pi-1", "horizontal"));
  assert.match(renamed, /class="item-title">Moj iskorak</);
  assert.match(renamed, /class="item-description">Moje\.</);
  const detail = as(EN, () => renderExerciseDetailHtml({ item: row(), itemId: "pi-1", ids: ["pi-1"], getItemById: () => row() }));
  assert.match(detail, /<h3>Lunge<\/h3>/);
  assert.match(detail, /<p>Step forward\.<\/p>/);
  const detailSr = as(SR, () => renderExerciseDetailHtml({ item: row(), itemId: "pi-1", ids: ["pi-1"], getItemById: () => row() }));
  assert.match(detailSr, /<h3>Iskorak<\/h3>/);
});

test("3. the Builder shows the same text in its title and its Instruction field, the hidden one included", () => {
  const item = builderItem({ id: "item-render" });
  const desktop = as(EN, () => renderBuilderItems({ items: [item] }));
  assert.match(desktop, /<strong>Lunge<\/strong>/);
  assert.match(desktop, /<textarea name="description"[^>]*>Step forward\.<\/textarea>/);
  const card = as(EN, () => renderBuilderAddedList({ items: [item] }));
  assert.match(card, /data-clamp-title>Lunge</);
  assert.match(card, /<input type="hidden" name="description" value="Step forward\.">/);
  const edit = as(EN, () => renderBuilderItemEdit({ items: [item] }, "item-render", false));
  assert.match(edit, /<strong>Lunge<\/strong>/);
  assert.match(edit, /builder-item-instruction-preview[^>]*>Step forward\.</);
  const sr = as(SR, () => renderBuilderItems({ items: [item] }));
  assert.match(sr, /<strong>Iskorak<\/strong>/);
  assert.match(sr, /<textarea name="description"[^>]*>Korak napred\.<\/textarea>/);
});

test("4. the save rule for an English reader: an Instruction left as shown is not sent; a typed one is, and is then shown as typed", async () => {
  clearBuilderItemEdits();
  const item = builderItem({ id: "item-save" });
  useDraft([item]);
  await asAsync(EN, async () => {
    // Sets edited, the Instruction shown in English left alone.
    formData([["sets", "3"], ["reps", "8"], ["load", ""], ["description", "Step forward."]]);
    let calls = fetchAnswering({ planId: "plan-1", item: { id: "item-save", sets: "3", reps: "8", load: "", description: "Korak napred.", titleEn: "Lunge", descriptionEn: "Step forward." } });
    await submitBuilderForm(updateForm("item-save"), handlers());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(Object.hasOwn(calls[0].body, "description"), false, "the English shown is never sent back");
    assert.equal(calls[0].body.sets, "3");
    // The coach types over it: what was typed is sent.
    formData([["sets", "3"], ["reps", "8"], ["load", ""], ["description", "Step forward slowly."]]);
    calls = fetchAnswering({ planId: "plan-1", item: { id: "item-save", sets: "3", reps: "8", load: "", description: "Step forward slowly.", titleEn: "Lunge", descriptionEn: null } });
    await submitBuilderForm(updateForm("item-save"), handlers());
    assert.equal(calls[0].body.description, "Step forward slowly.");
    const saved = state.builder.draft.blocks[0].sessions[0].nodes[0].items[0];
    assert.equal(planItemText(saved, "description"), "Step forward slowly.", "from then on shown as stored");
    assert.equal(planItemText(saved, "title"), "Lunge");
    // A later dose edit leaves the now-own Instruction alone again.
    formData([["sets", "4"], ["reps", "8"], ["load", ""], ["description", "Step forward slowly."]]);
    calls = fetchAnswering({ planId: "plan-1", item: { id: "item-save", sets: "4", reps: "8", load: "", description: "Step forward slowly.", descriptionEn: null } });
    await submitBuilderForm(updateForm("item-save"), handlers());
    assert.equal(Object.hasOwn(calls[0].body, "description"), false);
  });
});

test("5. a Serbian reader: an untouched Instruction is not sent either, and line ends or outer spaces are no change", async () => {
  clearBuilderItemEdits();
  const item = builderItem({ id: "item-sr", description: "Prvi red\r\nDrugi red", descriptionEn: null });
  useDraft([item]);
  await asAsync(SR, async () => {
    // A textarea or an attribute reads the stored "\r\n" back as "\n".
    formData([["sets", "2"], ["reps", ""], ["load", ""], ["description", "Prvi red\nDrugi red "]]);
    let calls = fetchAnswering({ planId: "plan-1", item: { id: "item-sr", sets: "2", reps: "", load: "", description: "Prvi red\r\nDrugi red", descriptionEn: null } });
    await submitBuilderForm(updateForm("item-sr"), handlers());
    assert.equal(Object.hasOwn(calls[0].body, "description"), false);
    formData([["sets", "2"], ["reps", ""], ["load", ""], ["description", "Treći red"]]);
    calls = fetchAnswering({ planId: "plan-1", item: { id: "item-sr", sets: "2", reps: "", load: "", description: "Treći red", descriptionEn: null } });
    await submitBuilderForm(updateForm("item-sr"), handlers());
    assert.equal(calls[0].body.description, "Treći red");
  });
});

test("6. while a typed Instruction waits for its save, it is shown as typed, never the English; an untouched pending edit carries none", () => {
  clearBuilderItemEdits();
  const typed = builderItem({ id: "item-typed" });
  const untouched = builderItem({ id: "item-untouched" });
  useDraft([typed, untouched]);
  as(EN, () => {
    const edit = rememberBuilderItemEdit("item-typed", { sets: "", reps: "", load: "", description: "My own words" });
    assert.equal(edit.data.description, "My own words");
    const shown = state.builder.draft.blocks[0].sessions[0].nodes[0].items[0];
    assert.equal(planItemText(shown, "description"), "My own words");
    assert.match(renderBuilderItems({ items: [shown] }), /<textarea name="description"[^>]*>My own words<\/textarea>/);
    const other = rememberBuilderItemEdit("item-untouched", { sets: "5", reps: "", load: "", description: "Step forward." });
    assert.equal(Object.hasOwn(other.data, "description"), false);
    const otherShown = state.builder.draft.blocks[0].sessions[0].nodes[0].items[1];
    assert.equal(otherShown.description, "Korak napred.", "the stored text stays in the draft");
    assert.equal(planItemText(otherShown, "description"), "Step forward.");
  });
  clearBuilderItemEdits();
});

test("7. an Instruction typed in and back again within the autosave pause is not sent, and the draft shows its own text again", async () => {
  clearBuilderItemEdits();
  useDraft([builderItem({ id: "item-revert" })]);
  await asAsync(EN, async () => {
    rememberBuilderItemEdit("item-revert", { sets: "", reps: "", load: "", description: "Step forward.x" });
    const reverted = rememberBuilderItemEdit("item-revert", { sets: "3", reps: "", load: "", description: "Step forward." });
    assert.equal(Object.hasOwn(reverted.data, "description"), false);
    const shown = state.builder.draft.blocks[0].sessions[0].nodes[0].items[0];
    assert.equal(shown.description, "Korak napred.", "the stored text, not the earlier pending one");
    assert.equal(planItemText(shown, "description"), "Step forward.");
    formData([["sets", "3"], ["reps", ""], ["load", ""], ["description", "Step forward."]]);
    const calls = fetchAnswering({ planId: "plan-1", item: { id: "item-revert", sets: "3", reps: "", load: "", description: "Korak napred.", descriptionEn: "Step forward." } });
    await submitBuilderForm(updateForm("item-revert"), handlers());
    assert.equal(Object.hasOwn(calls[0].body, "description"), false, "the English shown is never sent back");
  });
});

test("8. once a changed Instruction is on its way, what the coach types next is their own text, even the text that was shown", async () => {
  clearBuilderItemEdits();
  useDraft([builderItem({ id: "item-sent" })]);
  await asAsync(EN, async () => {
    rememberBuilderItemEdit("item-sent", { sets: "", reps: "", load: "", description: "Step forward slowly." });
    let release;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push(JSON.parse(options.body));
      if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
      const sent = calls.at(-1);
      return { ok: true, status: 200, statusText: "", json: async () => ({ planId: "plan-1", item: { id: "item-sent", sets: "", reps: "", load: "", description: sent.description ?? "Step forward slowly.", descriptionEn: null } }) };
    };
    const first = submitBuilderForm(updateForm("item-sent"), handlers());
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(calls[0].description, "Step forward slowly.");
    // While that save is in flight the coach types the shown text back: now their own.
    const back = rememberBuilderItemEdit("item-sent", { sets: "", reps: "", load: "", description: "Step forward." });
    assert.equal(back.data.description, "Step forward.");
    release();
    await first;
    formData([["sets", ""], ["reps", ""], ["load", ""], ["description", "Step forward."]]);
    await submitBuilderForm(updateForm("item-sent"), handlers());
    assert.equal(calls[1].description, "Step forward.");
  });
  clearBuilderItemEdits();
});

test("9. a plan item's thumbnail initials follow the title it shows", () => {
  const item = row({ image: "https://example.com/lunge.png" });
  assert.match(as(EN, () => renderExerciseItemHtml(item, "pi-1", "horizontal")), /data-fallback-initials="L"/);
  assert.match(as(SR, () => renderExerciseItemHtml(item, "pi-1", "horizontal")), /data-fallback-initials="I"/);
  const builder = builderItem({ id: "item-thumb", imageUrl: "https://example.com/lunge.png" });
  assert.match(as(EN, () => renderBuilderItems({ items: [builder] })), /data-fallback-initials="L"/);
});
