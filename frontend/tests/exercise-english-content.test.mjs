import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// English names and instructions of exercises, shown by the reader's language
// (owner, 2026-11-03): the display rule (exercise-text.js), the editor's two
// English fields, Account -> Exercise language, and the screens that show the
// current exercise row - the library card and view card, the exercise
// detail, the Builder's exercise picker and the Coach Home strip - for an
// English and a Serbian reader. A plan item keeps its own title.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;

const { state } = await import("../state.js");
const { exerciseCardDescription, exerciseText, readsEnglish } = await import("../exercise-text.js");
const { renderExerciseLibraryHtml } = await import("../exercise-library.js");
const { renderExerciseDetailHtml } = await import("../exercise-view.js");
const { renderBuilderExerciseResult } = await import("../builder-exercises.js");
const { renderCoachHomeExerciseItemsHtml } = await import("../coach-home.js");
const { renderContentLanguageSectionHtml, saveContentLanguage } = await import("../account-language.js");
const editor = await import("../exercise-editor.js");
const { renderCoachAccountHtml } = await import("../coach-account.js");
const { renderAthleteSettingsHtml } = await import("../athlete-view.js");

const EN = { contentLanguage: "en" };
const SR = { contentLanguage: "sr" };
// A library list row (the server's snake_case row) and the detail's shape.
const row = (overrides = {}) => ({
  id: "ex-1", name: "Iskorak", name_en: "Forward lunge", aim: "Snaga",
  execution_notes: "Leđa prava.", instruction: "Korak napred.", instruction_en: "Step forward.",
  owner_scope: "system", is_active: true, tags: [], ...overrides,
});
const as = (user, fn) => { const before = state.currentUser; state.currentUser = user; try { return fn(); } finally { state.currentUser = before; } };
const doc = (html) => new JSDOM(html).window.document;

test("1. the display rule: English for an English reader when the exercise has it, otherwise Serbian; Serbian readers always see Serbian", () => {
  assert.equal(exerciseText(row(), "name", EN), "Forward lunge");
  assert.equal(exerciseText(row(), "instruction", EN), "Step forward.");
  assert.equal(exerciseText(row(), "name", SR), "Iskorak");
  assert.equal(exerciseText(row(), "instruction", SR), "Korak napred.");
  // No user, or a user from before the language existed: Serbian.
  assert.equal(exerciseText(row(), "name", null), "Iskorak");
  assert.equal(exerciseText(row(), "name", {}), "Iskorak");
  assert.equal(exerciseText(row(), "name", { contentLanguage: "EN" }), "Iskorak", "only the exact value counts");
  // No English text (missing, empty, blank, not text): the Serbian one.
  for (const missing of [undefined, null, "", "   ", 5]) {
    assert.equal(exerciseText(row({ name_en: missing }), "name", EN), "Iskorak", JSON.stringify(missing));
    assert.equal(exerciseText(row({ instruction_en: missing }), "instruction", EN), "Korak napred.", JSON.stringify(missing));
  }
  // The detail's camelCase shape reads the same.
  const detail = { name: "Iskorak", nameEn: "Forward lunge", instruction: "Korak napred.", instructionEn: "Step forward." };
  assert.equal(exerciseText(detail, "name", EN), "Forward lunge");
  assert.equal(exerciseText(detail, "instruction", EN), "Step forward.");
  assert.equal(exerciseText({}, "name", EN), "");
  // The default reader is the signed-in user.
  as(EN, () => { assert.equal(readsEnglish(), true); assert.equal(exerciseText(row(), "name"), "Forward lunge"); });
  as(SR, () => { assert.equal(readsEnglish(), false); assert.equal(exerciseText(row(), "name"), "Iskorak"); });
  // The card's line: the English instruction for an English reader, else the notes, else the instruction.
  assert.equal(exerciseCardDescription(row(), EN), "Step forward.");
  assert.equal(exerciseCardDescription(row({ instruction_en: null }), EN), "Leđa prava.");
  assert.equal(exerciseCardDescription(row(), SR), "Leđa prava.");
  assert.equal(exerciseCardDescription(row({ execution_notes: "" }), SR), "Korak napred.");
});

test("2. the library: the details card and the view card show the reader's language, in the title, the picture's title and the line under it", () => {
  const exercise = row({ image_url: "https://example.test/a.jpg" });
  for (const view of ["details", "tile", "list"]) {
    const render = () => renderExerciseLibraryHtml({ exercises: [exercise], itemIds: ["item-1"], markedExerciseIds: new Set(),
      search: { view, term: "", filters: {}, options: {} }, tagEditor: { open: false } });
    const english = doc(as(EN, render));
    const serbian = doc(as(SR, render));
    const title = view === "details" ? ".exercise-title" : ".exercise-view-title";
    assert.equal(english.querySelector(title).textContent, "Forward lunge", view);
    assert.equal(serbian.querySelector(title).textContent, "Iskorak", view);
    assert.equal(english.querySelector('[data-action="open-media"]').dataset.title, "Forward lunge", `${view}: the media viewer's title`);
    assert.equal(serbian.querySelector('[data-action="open-media"]').dataset.title, "Iskorak");
    if (view === "details") {
      assert.equal(english.querySelector(".item-description").textContent, "Step forward.");
      assert.equal(serbian.querySelector(".item-description").textContent, "Leđa prava.");
    }
  }
  // An exercise without English text stays Serbian for an English reader.
  const plain = doc(as(EN, () => renderExerciseLibraryHtml({ exercises: [row({ name_en: null, instruction_en: null })], itemIds: ["item-1"],
    markedExerciseIds: new Set(), search: { view: "details", term: "", filters: {}, options: {} }, tagEditor: { open: false } })));
  assert.equal(plain.querySelector(".exercise-title").textContent, "Iskorak");
  assert.equal(plain.querySelector(".item-description").textContent, "Leđa prava.");
});

test("3. the detail: a library exercise in the reader's language; a plan item keeps the title it was written with", () => {
  const detail = (item) => doc(renderExerciseDetailHtml({ item, itemId: "item-1", ids: ["item-1"], getItemById: () => item }));
  const english = as(EN, () => detail(row()));
  assert.equal(english.querySelector(".drill-header h3").textContent, "Forward lunge");
  const notes = [...english.querySelectorAll(".detail-notes section")].map((section) => section.textContent.replace(/\s+/g, " ").trim());
  assert.ok(notes.includes("Instruction Step forward."), notes.join(" | "));
  assert.ok(notes.includes("Execution notes Leđa prava."), "the notes have no English field and stay as they are");
  const serbian = as(SR, () => detail(row()));
  assert.equal(serbian.querySelector(".drill-header h3").textContent, "Iskorak");
  assert.ok([...serbian.querySelectorAll(".detail-notes section")].some((section) => section.textContent.includes("Korak napred.")));
  // A plan item (its own title, written when it was added) is shown as it is.
  const planItem = { id: "pi-1", exercise_id: "ex-1", item_type: "exercise", title: "Iskorak (iz plana)", name_en: "Forward lunge" };
  assert.equal(as(EN, () => detail(planItem)).querySelector(".drill-header h3").textContent, "Iskorak (iz plana)");
});

test("4. the Builder's exercise picker and the Coach Home strip show the reader's language", () => {
  const pick = (user) => doc(as(user, () => renderBuilderExerciseResult(row(), new Set())));
  assert.equal(pick(EN).querySelector("strong").textContent, "Forward lunge");
  assert.equal(pick(EN).querySelector('[data-action="exercise-tags"]').dataset.exerciseName, "Forward lunge");
  assert.equal(pick(SR).querySelector("strong").textContent, "Iskorak");
  const strip = (user) => doc(`<ul>${as(user, () => renderCoachHomeExerciseItemsHtml([row()]))}</ul>`);
  assert.equal(strip(EN).querySelector(".coach-home-strip-label").textContent, "Forward lunge");
  assert.equal(strip(SR).querySelector(".coach-home-strip-label").textContent, "Iskorak");
  // The initials of a picture-less thumb follow the shown name.
  assert.equal(strip(EN).querySelector(".exercise-thumb-fallback").textContent, "FL");
  assert.equal(strip(SR).querySelector(".exercise-thumb-fallback").textContent, "I");
});

test("5. the editor: Name (English) and Instruction (English) under the Serbian fields, filled from the detail, saved as typed (the server trims)", async () => {
  const content = document.querySelector("#content");
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith("/api/exercises/")) {
      return { ok: true, status: 200, json: async () => (call.method === "GET"
        ? { id: "e1", ownerScope: "user", canEdit: true, name: "Iskorak", nameEn: "Forward lunge", instruction: "Korak napred.", instructionEn: "Step <forward>.", tags: [] }
        : { id: "e1" }) };
    }
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound" }) };
  };
  const editorState = { currentUser: { id: "u1" } };
  const handlers = { rerender() { content.innerHTML = editorState.exerciseEditor?.open ? editor.renderExerciseEditorHtml(editorState.exerciseEditor) : ""; }, async refreshList() {} };
  assert.equal(editor.emptyExerciseEditorData().nameEn, "");
  assert.equal(editor.emptyExerciseEditorData().instructionEn, "");
  await editor.openExerciseEditor(editorState, handlers, "e1");
  handlers.rerender();
  const fields = [...content.querySelectorAll("[data-exercise-editor-field]")].map((field) => field.dataset.exerciseEditorField);
  assert.equal(fields.indexOf("nameEn"), fields.indexOf("name") + 1, "Name (English) right under Name");
  assert.equal(fields.indexOf("instructionEn"), fields.indexOf("instruction") + 1, "Instruction (English) right under Instruction");
  const nameEn = content.querySelector('[data-exercise-editor-field="nameEn"]');
  const instructionEn = content.querySelector('[data-exercise-editor-field="instructionEn"]');
  assert.equal(nameEn.closest("label").querySelector("span").textContent, "Name (English)");
  assert.equal(instructionEn.closest("label").querySelector("span").textContent, "Instruction (English)");
  assert.equal(nameEn.value, "Forward lunge");
  assert.equal(instructionEn.value, "Step <forward>.", "escaped and read back as typed");
  assert.equal(nameEn.getAttribute("lang"), "en");
  assert.equal(nameEn.required, false, "the English name is optional");
  nameEn.value = "  Walking lunge ";
  editor.handleExerciseEditorInput(editorState, { target: nameEn });
  instructionEn.value = "";
  editor.handleExerciseEditorInput(editorState, { target: instructionEn });
  await editor.handleExerciseEditorAction(editorState, handlers, { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "saved");
  assert.equal(patch.body.nameEn, "  Walking lunge ", "the server trims");
  assert.equal(patch.body.instructionEn, "", "an emptied field is sent, so the server clears it");
  assert.equal(patch.body.name, "Iskorak");
});

test("6. Account -> Exercise language: on the coach's and the athlete's page, showing the saved choice; saving sends only the language and keeps the answer on the user", async () => {
  for (const html of [renderCoachAccountHtml(EN, null), renderAthleteSettingsHtml(null, EN, null, null)]) {
    const select = doc(html).querySelector('[data-account-form="content-language"] select[name="contentLanguage"]');
    assert.ok(select, "the section is on the page");
    assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["sr", "Srpski"], ["en", "English"]]);
    assert.equal(select.value, "en");
  }
  // The section names where the choice shows, and that programs keep their names.
  const intro = doc(renderContentLanguageSectionHtml(EN)).querySelector("p.muted").textContent;
  assert.match(intro, /^The Exercise Library, an exercise's details, the Builder's exercise list and Home show/);
  assert.match(intro, /Exercises already added to programs keep their names.$/);
  for (const user of [SR, {}, null]) {
    assert.equal(doc(renderContentLanguageSectionHtml(user)).querySelector("select").value, "sr");
  }

  const form = () => {
    const page = doc(renderContentLanguageSectionHtml(SR));
    return page.querySelector("form");
  };
  // Saved: the user now reads in English.
  const sent = [];
  const user = { id: "u1", contentLanguage: "sr" };
  const saved = form();
  saved.querySelector("select").value = "en";
  await saveContentLanguage(saved, { currentUser: user, api: async (url, options) => { sent.push({ url, method: options.method, body: JSON.parse(options.body) }); return { contentLanguage: "en" }; } });
  assert.deepEqual(sent, [{ url: "/api/auth/me/content-language", method: "PUT", body: { contentLanguage: "en" } }]);
  assert.equal(user.contentLanguage, "en");
  const savedText = saved.querySelector(".builder-success").textContent;
  assert.match(savedText, /^Saved: English. The Exercise Library, the Builder's exercise list and Home show it/);
  assert.doesNotMatch(savedText, /Exercises are shown in English/, "no promise beyond the screens that read the exercise itself");
  assert.equal(saved.querySelector(".builder-error").textContent, "");
  assert.equal(saved.querySelector("button").disabled, false);
  // Refused: nothing changes on the user, the reason is shown.
  const refused = form();
  refused.querySelector("select").value = "en";
  const unchanged = { id: "u1", contentLanguage: "sr" };
  await saveContentLanguage(refused, { currentUser: unchanged, api: async () => { throw new Error("Choose Srpski or English."); } });
  assert.equal(unchanged.contentLanguage, "sr");
  assert.equal(refused.querySelector(".builder-error").textContent, "Choose Srpski or English.");
  assert.equal(refused.querySelector(".builder-success").textContent, "");
  assert.equal(refused.querySelector("button").disabled, false);
});

test("7. Settings -> Athletes: the athlete form shows the login's exercise language, only for an athlete with a login; it is sent only when changed", async () => {
  const { renderOrganizationEditModal } = await import("../organization-view.js");
  const { submitOrganizationForm } = await import("../organization-actions.js");
  const content = document.querySelector("#content");
  const row = { id: "a-1", name: "Ana QA", user_id: "u-ana", content_language: "en", athlete_id: "", image_url: "", club_id: "", team_id: "" };
  const open = (athleteRow) => {
    state.organizationEditor = { open: true, type: "athlete", row: athleteRow };
    content.innerHTML = renderOrganizationEditModal({ clubs: [], teams: [] });
    return content.querySelector('[data-organization-form="edit-athlete"]');
  };
  const select = open(row).querySelector('select[name="contentLanguage"]');
  assert.ok(select, "an athlete with a login has the field");
  assert.equal(select.closest("label").querySelector("span").textContent, "Exercise language");
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["sr", "Srpski"], ["en", "English"]]);
  assert.equal(select.value, "en");
  assert.equal(open({ ...row, content_language: null }).querySelector('select[name="contentLanguage"]').value, "sr");
  assert.equal(open({ ...row, user_id: null }).querySelector('select[name="contentLanguage"]'), null, "no login, no field");
  // A login that also holds coach or administrator access: no select, the
  // login switch's wording instead.
  const multiRole = open({ ...row, login_is_multi_role: true });
  assert.equal(multiRole.querySelector('select[name="contentLanguage"]'), null, "a multi-role login, no select");
  assert.match(multiRole.textContent, /Multi-role account/);
  assert.match(multiRole.textContent, /This login also has coach or administrator access - its exercise language can't be changed from here\./);

  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), method: options.method, body: JSON.parse(options.body || "{}") });
    return { ok: true, status: 200, json: async () => ({ athlete: { id: "a-1" } }) };
  };
  const handlers = { loadAthletes: async () => {}, renderOrganizationPanel: async () => {} };
  globalThis.FormData = dom.window.FormData; // the submit reads the form through the DOM's FormData
  // Unchanged: a name change does not send it.
  const unchanged = open(row);
  unchanged.querySelector('input[name="fullName"]').value = "Ana QA renamed";
  await submitOrganizationForm(unchanged, handlers);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/organization/athletes/a-1");
  assert.equal(sent[0].method, "PUT");
  assert.equal(sent[0].body.fullName, "Ana QA renamed");
  assert.equal(Object.hasOwn(sent[0].body, "contentLanguage"), false, "an unchanged language is not sent");
  // Changed: it is sent.
  const changed = open(row);
  changed.querySelector('select[name="contentLanguage"]').value = "sr";
  await submitOrganizationForm(changed, handlers);
  assert.equal(sent[1].body.contentLanguage, "sr");
  // The server refuses a login that became multi-role meanwhile: its sentence, never the bare code.
  const refusal = "This user also has coach or administrator access. Their exercise language cannot be changed from the athlete profile; they set it in their own Account.";
  globalThis.fetch = async () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "MULTI_ROLE_ACCOUNT", message: refusal }) });
  const refused = open(row);
  refused.querySelector('select[name="contentLanguage"]').value = "sr";
  await submitOrganizationForm(refused, handlers);
  assert.equal(refused.querySelector(".builder-error").textContent, refusal);
});
