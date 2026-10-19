import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// The pilot (owner's decision 2026-10-19): the shipped defaults are the
// transport ON and the save OFF. This suite pins what the pilot must not
// change - an exercise's existing media in the library editor, in the
// Builder's editor (the same module) and in the Builder's custom-exercise
// modal - and that the guards are build-time constants, not runtime
// configuration. No setter is called before the first assertions: the
// defaults are read as the bundle ships them.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const guards = await import("../exercise-media-upload.js");
const builder = await import("../builder-exercises.js");
const { STORAGE_ROUTE } = guards;

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = { currentUser: { id: "u1" } };
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const controlsOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button, [data-exercise-media-slot="${slot}"] input`)].map((control) => control.textContent.trim() || `<input ${control.dataset.exerciseMediaFile ? "file" : control.dataset.exerciseEditorField || ""}>`);
const save = () => editor.handleExerciseEditorAction(state, handlers(), { dataset: { action: "exercise-editor-save" } });
const account = () => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "0", reservedBytes: "0", limitBytes: "5000000000", availableBytes: "5000000000",
  limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2, maxVideoBytes: "209715200", maxImageBytes: "10485760",
  allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1,
});
const detail = (overrides = {}) => ({ id: "e1", ownerScope: "user", canEdit: true, name: "Dead Bug", exerciseCode: "DB-1", aim: "Core control", purposes: ["Stability"], tags: ["core"], videoUrl: "", imageUrl: "", ...overrides });
const DRIVE = "https://drive.google.com/file/d/VID_1/view";
const YOUTUBE = "https://youtu.be/dQw4w9WgXcQ";

function fakeApi({ exercise = detail() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith(STORAGE_ROUTE)) return { ok: true, status: 200, json: async () => ({ accounts: [account()], selectedStorageAccountId: "acc-1" }) };
    if (call.url.startsWith("/api/exercises/")) return { ok: true, status: 200, json: async () => (call.method === "GET" ? exercise : { id: "e1" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound", code: "resource_not_found" }) };
  };
  return calls;
}

test("1. the shipped defaults: the transport on, the save off; module constants compiled by the build, fed by no runtime source", () => {
  assert.equal(guards.isUploadTransportEnabled(), true, "the pilot's transport");
  assert.equal(guards.isMediaSaveEnabled(), false, "the save waits for the second flip");
  const source = readFileSync(new URL("../exercise-media-upload.js", import.meta.url), "utf8");
  assert.match(source, /const DEFAULT_UPLOAD_TRANSPORT_ENABLED = true;/);
  assert.match(source, /const DEFAULT_MEDIA_SAVE_ENABLED = false;/);
  assert.doesNotMatch(source, /import\.meta\.env|process\.env|VITE_|localStorage|sessionStorage/, "no environment variable, storage or runtime value feeds the guards: a change is a code change and a build");
});

test("2. a legacy exercise (a Drive video, a YouTube picture) saved with a name change: the links exactly as loaded, no media key, the body byte-identical to the one with the transport off; the pilot reads the storage and nothing else of media", async () => {
  const legacy = detail({ videoUrl: DRIVE, imageUrl: YOUTUBE });
  const bodies = [];
  for (const transport of [true, false]) {
    guards.setUploadTransportEnabled(transport);
    const calls = fakeApi({ exercise: legacy });
    await editor.openExerciseEditor(state, handlers(), "e1");
    await settle();
    assert.equal(calls.filter((call) => call.url.startsWith(STORAGE_ROUTE)).length, transport ? 1 : 0);
    assert.equal(calls.filter((call) => call.url.startsWith("/api/media/uploads") || call.url.startsWith("/api/media/access")).length, 0);
    state.exerciseEditor.data.name = "Dead Bug (renamed)";
    await save();
    const patch = calls.find((call) => call.method === "PATCH");
    assert.ok(patch, "saved");
    bodies.push(patch.body);
    assert.equal(state.exerciseEditor.open, false);
  }
  guards.setUploadTransportEnabled(true);
  assert.deepEqual(bodies[0], bodies[1], "the transport changes nothing of the body");
  assert.equal(bodies[0].videoUrl, DRIVE);
  assert.equal(bodies[0].imageUrl, YOUTUBE);
  assert.equal("media" in bodies[0], false, "no media selection: BE-3 binds nothing");
  assert.equal("tags" in bodies[0], false, "as before");
});

test("3. the Builder: Edit on a result or an added item opens this same editor (the body of test 2 is the Builder's body); the custom-exercise modal keeps its two link fields and offers no upload", () => {
  const html = builder.renderCustomExerciseModal({ id: "n1", name: "Warm-up" });
  assert.match(html, /name="imageUrl" type="url"/);
  assert.match(html, /name="videoUrl" type="url"/);
  assert.doesNotMatch(html, /data-exercise-media|exercise-media-|Upload|frame/i);
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /exerciseEditorHandlers/);
  assert.match(app, /openExerciseEditor\(/);
  assert.equal((app.match(/from "\.\/exercise-editor\.js"/g) || []).length, 1, "one editor module for the library and the Builder");
});

test("4. a stored R2 file (BE-3 binds one only once the save guard is on; none exists for the pilot) is safe anyway: Preview only, no Replace / Remove, the stored slot's legacy key omitted, no media key - BE-3 keeps the asset", async () => {
  const stored = detail({ imageUrl: YOUTUBE, media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "legacy", url: YOUTUBE }, accessContext: { type: "exercise", id: "e1" } } });
  const calls = fakeApi({ exercise: stored });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.deepEqual(controlsOf("video"), ["Preview", "<input file>"], "no Replace / Remove of a stored file before the second flip");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] [data-action="open-media"]').dataset.videoMediaId, "vid-1");
  await save();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal("videoUrl" in patch.body, false, "H1: the stored slot's legacy key is omitted");
  assert.equal(patch.body.imageUrl, YOUTUBE);
  assert.equal("media" in patch.body, false);
});

test("5. an upload during the pilot is never saved: 'not available yet', Save refused with the sentence and nothing sent; after Remove the body is the one of today", async () => {
  const calls = fakeApi({ exercise: detail({ videoUrl: DRIVE }) });
  const transport = (request) => Promise.resolve({ uploadId: "up-1", mediaId: "new-1", status: "completed", media: { source: "asset", mediaId: "new-1", kind: request.slot, status: "ready" } });
  const h = handlers({ upload: transport });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await editor.chooseExerciseMediaFile(state, h, "video", { name: "clip.mp4", size: 100, type: "video/mp4" });
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, /Saving it with the exercise is not available yet/);
  assert.equal(content.querySelector('[data-action="exercise-editor-save"]').disabled, true);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "never a save that pretends");
  assert.equal(state.exerciseEditor.open, true);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-media-remove", slot: "video" } });
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal("media" in patch.body, false);
  assert.equal(patch.body.videoUrl, "", "the link the upload replaced is gone, as FE-2 always did; nothing of R2 travels");
});

test("6. Cancel during verification is honoured at the end of the current poll sleep (1, 2, 4 s), never lost: the server is told and the outcome is 'cancelled'", async () => {
  const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const envelope = (status, extra = {}) => ({ uploadId: "up-1", mediaId: "media-1", status, expiresAt: minutesFromNow(10), errorCode: null, ...extra });
  const reply = (body, status = 200) => ({ ok: status < 400, status, statusText: "", json: async () => body });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push(`${method} ${String(url)}`);
    if (String(url) === guards.UPLOADS_ROUTE && method === "POST") {
      return reply(envelope("pending", { upload: { method: "PUT", url: "https://r2.example/pending/up-1?sig=1", headers: { "Content-Type": "video/mp4", "If-None-Match": "*" }, expiresAt: minutesFromNow(10) }, reservation: { bytes: "100", expiresAt: minutesFromNow(10) } }), 201);
    }
    if (String(url).endsWith("/complete")) return reply(envelope("verifying"), 202);
    if (method === "DELETE") return reply(envelope("cancelled"));
    return reply(envelope("verifying"));
  };
  class FakeXHR {
    constructor() { this.headers = {}; this.upload = {}; }
    open() {}
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() { setTimeout(() => { this.status = 200; this.onload?.(); }, 0); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeXHR;
  const controller = new AbortController();
  const sleeps = [];
  let releaseSleep = null;
  const sleep = (ms) => new Promise((resolve) => { sleeps.push(ms); releaseSleep = resolve; });
  const pending = guards.startUpload({ file: { name: "a.mp4", size: 100, type: "video/mp4" }, slot: "video", context: { type: "exercise_edit", exerciseId: "e1" } }, { signal: controller.signal, sleep });
  for (let i = 0; i < 50 && !sleeps.length; i += 1) await settle();
  assert.deepEqual(sleeps, [1000], "the first poll sleep of the verification");
  assert.deepEqual(calls, ["POST /api/media/uploads", "POST /api/media/uploads/up-1/complete", "GET /api/media/uploads/up-1"]);
  controller.abort();
  await settle();
  assert.equal(calls.includes("DELETE /api/media/uploads/up-1"), false, "the cancel waits for the current sleep to end: the 'Cancelling...' of up to 4 s");
  releaseSleep();
  await assert.rejects(pending, (error) => error.code === "cancelled" && error.cancelOutcome === "cancelled" && error.uploadId === "up-1");
  assert.equal(calls.at(-1), "DELETE /api/media/uploads/up-1", "then the server is told, nothing is lost");
  assert.deepEqual([...guards.VERIFICATION_POLL_DELAYS_MS], [1000, 2000, 4000], "the sleeps: 1, 2, then 4 s each");
  delete globalThis.XMLHttpRequest;
});
