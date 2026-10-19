import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// FE-2: the exercise editor's media fields behind the two guards - the
// production editor unchanged while the transport guard is off, the faces of
// a link, a stored file, an upload with its progress, a cancellation, a
// failure and a verification still pending, Save held during an upload and
// refused while an uploaded file waits for BE-3, the close and unload guards
// - against a fake transport and fake answers.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const guards = await import("../exercise-media-upload.js");
const { STORAGE_ROUTE } = guards;

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = { currentUser: { id: "u1" } };
const rendered = () => content.innerHTML;
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const file = (name, size, type) => ({ name, size, type });
const withGuards = ({ transport = false, save = false } = {}) => { guards.setUploadTransportEnabled(transport); guards.setMediaSaveEnabled(save); };

const account = (overrides = {}) => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000",
  availableBytes: "3800000000", limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1, ...overrides,
});
const detail = (overrides = {}) => ({ id: "e1", ownerScope: "user", canEdit: true, name: "Dead Bug", videoUrl: "", imageUrl: "https://drive.google.com/file/d/IMG_1/view", tags: [], ...overrides });
const storedVideo = { media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "legacy", url: "https://drive.google.com/file/d/IMG_1/view" }, accessContext: { type: "exercise", id: "e1" } } };

// The API fake: storage by `storage` (the targeted and the plain route alike), the detail by `exercise`, every write recorded.
function fakeApi({ storage = { accounts: [account()], selectedStorageAccountId: "acc-1" }, exercise = detail() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith(STORAGE_ROUTE)) {
      if (storage?.status) return { ok: false, status: storage.status, statusText: "Error", json: async () => storage.json };
      return { ok: true, status: 200, json: async () => storage };
    }
    if (call.url.startsWith("/api/exercises/")) return { ok: true, status: 200, json: async () => (call.method === "GET" ? exercise : { id: "e1" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound" }) };
  };
  return calls;
}

// A transport that reports progress, waits at a gate, honours the signal, and
// fails with a given code (and session identity) when asked.
function fakeTransport({ fail = null, uploadId = "up-1" } = {}) {
  const transport = { calls: [], options: [], release: null, progress: null };
  transport.upload = (request, options) => new Promise((resolve, reject) => {
    transport.calls.push(request);
    transport.options.push(options);
    transport.progress = options.onProgress;
    // Like the real transport, the cancellation settles only after the server answered the DELETE.
    options.signal.addEventListener("abort", () => setTimeout(() => reject(Object.assign(new Error("cancelled"), { code: "cancelled", cancelOutcome: "cancelled", uploadId })), 0), { once: true });
    transport.release = () => (fail
      ? reject(Object.assign(new Error(fail), { code: fail, uploadId, idempotencyKey: options.idempotencyKey || "key-from-transport" }))
      : resolve({ uploadId, mediaId: `new-${transport.calls.length}`, status: "completed", media: { source: "asset", mediaId: `new-${transport.calls.length}`, kind: request.slot, status: "ready" } }));
  });
  return transport;
}

const controlsOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button, [data-exercise-media-slot="${slot}"] input`)].map((control) => control.textContent.trim() || `<input ${control.dataset.exerciseMediaFile ? "file" : control.dataset.exerciseEditorField || ""}>`);
const action = (type, slot) => ({ dataset: { action: type, slot }, closest: (selector) => content.querySelector(`[data-exercise-media-slot="${slot}"]`)?.closest(selector) });
const saveButton = () => content.querySelector('[data-action="exercise-editor-save"]');

test("1. production unchanged: with the transport guard off the editor never reads storage, draws the two link fields, and shows a stored file with Preview only", async () => {
  withGuards();
  const calls = fakeApi({ exercise: detail(storedVideo) });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media")).length, 0, "no media request at all");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.doesNotMatch(rendered(), /Upload video|Replace|Storage \(|Remove/);
  assert.equal(content.querySelector('[data-exercise-editor-field="imageUrl"]').value, "https://drive.google.com/file/d/IMG_1/view");
  assert.deepEqual(controlsOf("video"), ["Preview"], "a stored file: Preview through the FE-1 player, nothing else");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] [data-action="open-media"]').dataset.videoMediaId, "vid-1");
  assert.equal(saveButton().disabled, false);
  // The flag off answers the same way even if someone enabled the transport.
  editor.closeExerciseEditor(state, handlers());
  withGuards({ transport: true });
  fakeApi({ storage: { status: 503, json: { code: "media_storage_disabled" } } });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.equal(content.querySelectorAll('[data-exercise-media-slot] button').length, 0);
  editor.closeExerciseEditor(state, handlers());
  withGuards();
});

test("2. the transport guard on: the owner-resolved storage line, Upload and Use a link, a link's Edit link / Replace / Remove, a stored file still Preview only before BE-3", async () => {
  withGuards({ transport: true });
  const calls = fakeApi({ exercise: detail({ ...storedVideo, ownerScope: "system" }) });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.equal(calls.find((call) => call.url.startsWith(STORAGE_ROUTE)).url, `${STORAGE_ROUTE}?exerciseId=e1`, "the target-aware selector");
  assert.equal(content.querySelector("[data-exercise-media-storage]").textContent, "Storage (personal storage (uploading administrator)): 1.2 GB used of 5 GB · 3.8 GB free · one video up to 209.7 MB, one picture up to 10.5 MB");
  assert.deepEqual(controlsOf("video"), ["Preview", "<input file>"], "no Replace / Remove of a stored file until BE-3 can save it");
  assert.deepEqual(controlsOf("image"), ["Preview", "Edit link", "Replace with a file...", "Remove", "<input file>"]);
  assert.equal(content.querySelector('[data-exercise-media-file="video"]').getAttribute("accept"), "video/mp4,video/webm");
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "stored", "Remove of a stored file is refused before BE-3");
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-link", "image"));
  assert.ok(content.querySelector('[data-exercise-media-slot="image"] [data-exercise-editor-field="imageUrl"]'));
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "image"));
  assert.equal(state.exerciseEditor.data.imageUrl, "");
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"]);
  editor.closeExerciseEditor(state, handlers());
  withGuards();
});

test("3. a file the limits refuse is refused locally with the sentence, nothing is sent, Save stays enabled", async () => {
  withGuards({ transport: true });
  const calls = fakeApi();
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  await editor.chooseExerciseMediaFile(state, handlers(), "video", file("big.mp4", 300000000, "video/mp4"));
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, "This file is 300 MB. The limit for one video is 209.7 MB.");
  assert.deepEqual(controlsOf("video"), ["Choose another file", "Use a link", "Clear", "<input file>"]);
  assert.equal(saveButton().disabled, false);
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media/uploads")).length, 0);
  editor.closeExerciseEditor(state, handlers());
  withGuards();
});

test("4. the BE-3 boundary: an uploaded file is never a saved media - Save is refused with the sentence and nothing is sent; once BE-3 is on, the contract's media selection travels and the stored file gains Replace / Remove", async () => {
  withGuards({ transport: true });
  let calls = fakeApi({ exercise: detail({ videoUrl: "https://youtu.be/dQw4w9WgXcQ" }) });
  let transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const chosen = file("clip.mp4", 100, "video/mp4");
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", chosen);
  await settle();
  assert.deepEqual(transport.calls[0], { file: chosen, slot: "video", context: { type: "exercise_edit", exerciseId: "e1" }, purpose: "exercise_video" }, "the upload context, never FE-1's");
  transport.release();
  await uploading;
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(state.exerciseEditor.data.videoUrl, "", "an uploaded file replaces the link of its slot");
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, /Saving it with the exercise is not available yet/);
  assert.equal(saveButton().disabled, true);
  assert.match(rendered(), /can't be saved with the exercise yet/);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0, "never a save that pretends");
  assert.equal(state.exerciseEditor.open, true);
  assert.doesNotMatch(rendered(), /new-1/, "an uploaded id is nowhere in the markup");
  // Remove the uploaded file: the other changes can be saved, the body as before.
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-remove", "video"));
  assert.equal(saveButton().disabled, false);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch);
  assert.equal("media" in patch.body, false);
  assert.equal(patch.body.videoUrl, "");
  // BE-3 on: the uploaded file saves as { source: "asset", mediaId } without the legacy field; a stored file may be replaced or removed.
  withGuards({ transport: true, save: true });
  calls = fakeApi({ exercise: detail(storedVideo) });
  transport = fakeTransport();
  const h2 = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h2, "e1");
  await settle();
  assert.deepEqual(controlsOf("video"), ["Preview", "Replace...", "Remove", "<input file>"]);
  const replacing = editor.chooseExerciseMediaFile(state, h2, "video", chosen);
  await settle();
  transport.release();
  await replacing;
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, /saved with the exercise when you press Save/);
  assert.equal(saveButton().disabled, false);
  await editor.handleExerciseEditorAction(state, h2, action("exercise-media-remove", "image"));
  await editor.handleExerciseEditorAction(state, h2, { dataset: { action: "exercise-editor-save" } });
  const saved = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(saved.body.media, { video: { source: "asset", mediaId: "new-1" } });
  assert.equal("videoUrl" in saved.body, false, "never both formats for one slot");
  assert.equal(saved.body.imageUrl, "", "a link removed without a stored file: the legacy field as before");
  withGuards();
});

test("5. the transport flow in the editor: progress patched in place, Save held, Cancel is 'Cancelling...' until the server answered, a resumable failure retries the same session, a terminal one a new attempt", async () => {
  withGuards({ transport: true });
  fakeApi();
  let transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const chosen = file("clip.mp4", 100, "video/mp4");
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", chosen);
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploading");
  assert.equal(transport.options[0].idempotencyKey, "", "a first attempt: the transport makes the key");
  assert.equal(saveButton().disabled, true);
  const before = content.querySelector(".exercise-media-progress");
  transport.progress({ sent: 50, total: 100 });
  assert.equal(content.querySelector(".exercise-media-progress"), before, "patched in place");
  assert.equal(before.value, 50);
  assert.equal(content.querySelector('[data-exercise-media-progress-text="video"]').textContent, "50 % · 50 B of 100 B");
  assert.equal(saveButton().textContent, "Uploading... 50%");
  assert.equal(editor.handleExerciseMediaBeforeUnload({ preventDefault() {} }, state), true);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-cancel", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "cancelling");
  assert.deepEqual(controlsOf("video"), ["<input file>"], "nothing to press while the server is told");
  assert.equal(saveButton().disabled, true);
  await uploading;
  assert.equal(state.exerciseEditor.media.video.state, "cancelled");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, "Upload cancelled.");
  assert.deepEqual(controlsOf("video"), ["Upload again", "Use a link", "Clear", "<input file>"]);
  assert.equal(editor.handleExerciseMediaBeforeUnload({ preventDefault() {} }, state), false);
  // A resumable failure: Retry continues the same session with the key the transport returned.
  transport = fakeTransport({ fail: "upload_interrupted", uploadId: "up-7" });
  const h2 = handlers({ upload: transport.upload });
  const failing = editor.chooseExerciseMediaFile(state, h2, "video", chosen);
  await settle();
  transport.release();
  await failing;
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(state.exerciseEditor.media.video.idempotencyKey, "key-from-transport");
  assert.deepEqual(controlsOf("video"), ["Retry", "Choose another file", "Use a link", "Clear", "<input file>"]);
  transport = fakeTransport();
  const h3 = handlers({ upload: transport.upload });
  await editor.handleExerciseEditorAction(state, h3, action("exercise-media-retry", "video"));
  await settle();
  assert.equal(transport.calls[0].file, chosen, "the same File");
  assert.equal(transport.options[0].idempotencyKey, "key-from-transport", "the same session");
  transport.release();
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  // A terminal failure: Retry is a new attempt (no key), and a refused file keeps no Retry at all.
  transport = fakeTransport({ fail: "media_verification_failed" });
  const h4 = handlers({ upload: transport.upload });
  const terminal = editor.chooseExerciseMediaFile(state, h4, "image", file("a.png", 10, "image/png"));
  await settle();
  transport.release();
  await terminal;
  assert.match(content.querySelector('[data-exercise-media-slot="image"] .exercise-media-status').textContent, /could not be verified/);
  assert.deepEqual(controlsOf("image"), ["Retry", "Choose another file", "Use a link", "Clear", "<input file>"]);
  transport = fakeTransport();
  const h5 = handlers({ upload: transport.upload });
  await editor.handleExerciseEditorAction(state, h5, action("exercise-media-retry", "image"));
  await settle();
  assert.equal(transport.options[0].idempotencyKey, "", "a new attempt, a new key");
  transport.release();
  await settle();
  editor.closeExerciseEditor(state, h5);
  withGuards();
});

test("6. a verification still pending after the budget: Check again reads the same session, no new upload", async () => {
  withGuards({ transport: true });
  fakeApi();
  const transport = fakeTransport({ fail: "verification_timeout", uploadId: "up-9" });
  let checks = 0;
  const h = handlers({ upload: transport.upload, checkUpload: async (uploadId) => { checks += 1; assert.equal(uploadId, "up-9"); return checks === 1 ? { uploadId, mediaId: "media-9", status: "verifying" } : { uploadId, mediaId: "media-9", status: "completed", media: { source: "asset", mediaId: "media-9", kind: "video", status: "ready" } }; } });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const pending = editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await pending;
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, /taking longer than expected/);
  assert.deepEqual(controlsOf("video"), ["Check again", "Choose another file", "Use a link", "Clear", "<input file>"], "no Retry: the file is on the server");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-check", "video"));
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "failed", "still verifying: the sentence stays");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-check", "video"));
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(state.exerciseEditor.media.video.mediaId, "media-9");
  assert.equal(transport.calls.length, 1, "never a second upload");
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("7. closing with an upload in flight asks first; no cancels, yes closes and aborts; the file input's change starts the upload", async () => {
  withGuards({ transport: true });
  fakeApi();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const input = content.querySelector('[data-exercise-media-file="image"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File([new Uint8Array(10)], "photo.png", { type: "image/png" })] });
  assert.equal(editor.handleExerciseEditorChange(state, h, { target: input }), true);
  await settle();
  assert.equal(state.exerciseEditor.media.image.state, "uploading");
  assert.equal(transport.calls[0].slot, "image");
  globalThis.confirm = () => false;
  assert.equal(editor.closeExerciseEditor(state, h), false);
  assert.equal(state.exerciseEditor.open, true);
  globalThis.confirm = () => true;
  assert.equal(editor.closeExerciseEditor(state, h), true);
  assert.equal(state.exerciseEditor.open, false);
  await settle();
  assert.equal(rendered(), "");
  delete globalThis.confirm;
  assert.equal(editor.handleExerciseEditorChange(state, h, { target: content }), false);
  withGuards();
});

test("8. a new exercise or a copy: links only until BE-3; with BE-3 on, an upload into the user's own quota (exercise_create)", async () => {
  withGuards({ transport: true });
  let calls = fakeApi();
  await editor.openExerciseEditor(state, handlers(), "");
  assert.equal(calls.filter((call) => call.url.startsWith(STORAGE_ROUTE)).length, 0);
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.ok(content.querySelector('[data-exercise-editor-field="videoUrl"]'));
  editor.closeExerciseEditor(state, handlers());
  await editor.openExerciseEditor(state, handlers(), "e1", { copy: true });
  await settle();
  assert.equal(calls.filter((call) => call.url.startsWith(STORAGE_ROUTE)).length, 0);
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.equal(state.exerciseEditor.media.video.state, "none", "a copy starts without the original's file");
  editor.closeExerciseEditor(state, handlers());
  withGuards({ transport: true, save: true });
  calls = fakeApi({ storage: { accounts: [account({ owner: { type: "user", id: "u1" } })] } });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "");
  await settle();
  assert.equal(calls.find((call) => call.url.startsWith(STORAGE_ROUTE)).url, STORAGE_ROUTE, "the plain usage, the user's own row");
  assert.match(content.querySelector("[data-exercise-media-storage]").textContent, /^Storage \(personal storage\)/);
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file("a.mp4", 10, "video/mp4"));
  await settle();
  assert.deepEqual(transport.calls[0].context, { type: "exercise_create" });
  transport.release();
  await uploading;
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("9. a storage read that fails says so and offers Read again; the upload is still offered (the server checks)", async () => {
  withGuards({ transport: true });
  let fail = true;
  let storageReads = 0;
  fakeApi();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(STORAGE_ROUTE)) storageReads += 1;
    return String(url).startsWith(STORAGE_ROUTE) && fail ? { ok: false, status: 500, statusText: "Error", json: async () => ({}) } : base(url, options);
  };
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.match(content.querySelector(".exercise-media-storage").textContent, /could not be read/);
  assert.ok(content.querySelector('[data-exercise-media-file="video"]'));
  fail = false;
  await editor.handleExerciseEditorAction(state, handlers(), { dataset: { action: "exercise-media-storage-reload" } });
  await settle();
  assert.match(content.querySelector("[data-exercise-media-storage]").textContent, /3\.8 GB free/);
  assert.equal(storageReads, 2);
  editor.closeExerciseEditor(state, handlers());
  withGuards();
});
