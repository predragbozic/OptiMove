import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderExerciseEditorHtml, emptyExerciseEditor, openExerciseEditor, handleExerciseEditorAction } from "../exercise-editor.js";
import { openExerciseCollections } from "../exercise-collections.js";
import { applyClientExerciseFilters } from "../exercise-data.js";
import { state } from "../state.js";

test("system exercise editor names the private copy and retained block restriction", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: "Application squat", ownerScope: "system" }) });
  const state = {};
  await openExerciseEditor(state, { rerender() {} }, "source-id", { copy: true });
  const html = renderExerciseEditorHtml(state.exerciseEditor);
  assert.match(html, /Save private copy/);
  assert.match(html, /original stays unchanged/);
  assert.match(html, /copy is hidden too/);
  assert.doesNotMatch(renderExerciseEditorHtml(emptyExerciseEditor()), /Save private copy/);
});

test("explicit copying clears source media and code and saves only on confirmation", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => options.method === "POST"
      ? { id: "private-copy", exerciseCode: "", sourceExerciseId: "system-source" }
      : { name: "Application squat", exerciseCode: "SYSTEM-001", ownerScope: "system", videoUrl: "https://source.test/video", imageUrl: "https://source.test/image" } };
  };
  const editorState = {};
  let refreshes = 0;
  const handlers = { rerender() {}, async refreshAfterSave() { refreshes++; } };
  await openExerciseEditor(editorState, handlers, "system-source", { copy: true });
  assert.equal(requests.length, 1);
  assert.equal(editorState.exerciseEditor.data.videoUrl, "");
  assert.equal(editorState.exerciseEditor.data.imageUrl, "");
  assert.doesNotMatch(renderExerciseEditorHtml(editorState.exerciseEditor), /https:\/\/source.test/);
  editorState.exerciseEditor.data.instruction = "My instruction";
  await handleExerciseEditorAction(editorState, handlers, { dataset: { action: "exercise-editor-save" } });
  const saved = requests.find((request) => request.method === "POST");
  assert.equal(saved.url, "/api/exercises/system-source/copy");
  assert.equal(JSON.parse(saved.body).exerciseCode, "");
  assert.equal(JSON.parse(saved.body).instruction, "My instruction");
  assert.equal(refreshes, 1);
  assert.equal(editorState.exerciseEditor.open, false);
});

test("Copy Cancel makes no write and a private edit preserves media and its existing identity", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ id: "owned", ownerScope: "user", name: "Owned",
      videoUrl: "https://mine.test/video", imageUrl: "https://mine.test/image", tags: ["skip"] }) };
  };
  const editorState = {};
  const handlers = { rerender() {}, async refreshAfterSave() {} };
  await openExerciseEditor(editorState, handlers, "system", { copy: true });
  await handleExerciseEditorAction(editorState, handlers, { dataset: { action: "exercise-editor-close" } });
  assert.equal(requests.filter((request) => request.method).length, 0);
  assert.equal(editorState.exerciseEditor.open, false);
  await openExerciseEditor(editorState, handlers, "owned");
  assert.equal(editorState.exerciseEditor.data.videoUrl, "https://mine.test/video");
  await handleExerciseEditorAction(editorState, handlers, { dataset: { action: "exercise-editor-save" } });
  const write = requests.find((request) => request.method === "PATCH");
  assert.equal(write.url, "/api/exercises/owned");
  assert.equal(JSON.parse(write.body).imageUrl, "https://mine.test/image");
  assert.equal(Object.hasOwn(JSON.parse(write.body), "tags"), false);
});

test("library exposes Tags and Copy to coaches, Edit original only to administrators", async () => {
  const { renderExerciseLibraryHtml } = await import("../exercise-library.js");
  const props = { exercises: [{ id: "system", owner_scope: "system", name: "Original" }], itemIds: ["item"],
    markedExerciseIds: new Set(), search: { filters: {}, canManageCollections: false }, tagEditor: {} };
  const coach = renderExerciseLibraryHtml(props);
  assert.match(coach, /data-action="exercise-tags"/);
  assert.match(coach, /data-action="exercise-copy-open"/);
  assert.doesNotMatch(coach, /data-action="exercise-edit-open"/);
  assert.doesNotMatch(coach, /Customize/);
  assert.match(renderExerciseLibraryHtml({ ...props, search: { ...props.search, canManageCollections: true } }), /data-action="exercise-edit-open"/);
  assert.match(renderExerciseLibraryHtml({ ...props, exercises: [{ id: "owned", owner_scope: "user" }] }), /data-action="exercise-edit-open"/);
});

test("admin block picker saves selected users and exercises and keeps selections across search", async () => {
  const dom = new JSDOM("<button id='opener'>Blocks</button>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  window.confirm = () => true;
  document.querySelector("#opener").focus();
  const requests = [];
  const exercise = { id: "exercise-id", name: "Application exercise", collectionId: null };
  const user = { id: "user-id", name: "Selected coach" };
  let refreshes = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    let body;
    if (options.method === "POST") body = { collection: { id: "block-id", name: "Private block", revision: 1, exercises: [exercise], users: [user] } };
    else if (String(url).includes("/options")) body = { exercises: [exercise], users: [user] };
    else body = { collections: [] };
    return { ok: true, json: async () => body };
  };
  await openExerciseCollections(async () => { refreshes++; });
  assert.equal(document.activeElement.hasAttribute("data-block-select"), true);
  const name = document.querySelector("[data-block-name]");
  name.value = "Private block";
  name.dispatchEvent(new window.Event("input"));
  document.querySelector("[data-add-kind='exercises']").click();
  document.querySelector("[data-add-kind='users']").click();
  assert.notEqual(document.activeElement, document.body);
  document.querySelector("[data-find-kind='exercises']").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelectorAll("[data-remove-kind]").length, 2);
  document.querySelector("[data-save-block]").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const write = requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(write.body), { name: "Private block", exerciseIds: [exercise.id], userIds: [user.id] });
  assert.equal(refreshes, 1);
  assert.match(document.body.textContent, /Block saved/);
  document.querySelector("[data-close-collections]").click();
  assert.equal(document.querySelector("[role='dialog']"), null);
  assert.equal(document.activeElement.id, "opener");
  dom.window.close();
});

test("revoked marked originals and private copies never reappear from local objects", () => {
  const original = { id: "system", name: "Hidden application exercise" };
  const copy = { id: "copy", name: "Hidden private variation" };
  const allowed = { id: "allowed", name: "Allowed" };
  state.markedExercises = new Map([original, copy, allowed].map((item) => [item.id, item]));
  state.markedExerciseIds = new Set([original.id, copy.id, allowed.id]);
  assert.deepEqual(applyClientExerciseFilters([], { marked: true }, [allowed.id]), [allowed]);
  assert.deepEqual(applyClientExerciseFilters([], { marked: true }), []);
  for (const extra of [{ favorite: true }, { purpose: "Strength" }, { tag: "Rehab" }]) {
    assert.deepEqual(applyClientExerciseFilters([original, copy], { marked: true, ...extra }, []), []);
  }
});

test("Builder system tagging uses the personal tag editor without copying", async () => {
  const { renderBuilderExerciseResults } = await import("../builder-exercises.js");
  const html = renderBuilderExerciseResults([{ id: "system", name: "System squat", owner_scope: "system" }], new Set(), null);
  assert.doesNotMatch(html, /data-action="exercise-edit-open"/);
  assert.match(html, /data-action="exercise-tags"/);
});

test("block choices distinguish accounts with identical display names", async () => {
  const { renderExerciseCollectionsHtml } = await import("../exercise-collections.js");
  const html = renderExerciseCollectionsHtml({ collections: [], draft: { name: "", users: [], exercises: [] }, search: {},
    options: { users: [{ id: "one", name: "Alex", email: "one@example.test" }, { id: "two", name: "Alex", email: "two@example.test" }] } });
  assert.match(html, /Alex \(one@example.test\)/);
  assert.match(html, /Alex \(two@example.test\)/);
});

test("realtime block changes and reconnects request fresh Exercise Library access", async () => {
  const dom = new JSDOM("<div></div>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  let source;
  globalThis.EventSource = class {
    constructor() { this.handlers = {}; source = this; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    close() { this.closed = true; }
  };
  state.currentUser = { id: "coach" };
  const { startRealtimeInbox, stopRealtimeInbox } = await import("../realtime.js");
  let revalidations = 0;
  startRealtimeInbox(() => {}, () => { revalidations++; });
  source.handlers.exercise_library_changed();
  source.onopen();
  assert.equal(revalidations, 2);
  stopRealtimeInbox();
  assert.equal(source.closed, true);
  delete globalThis.EventSource;
  dom.window.close();
});
