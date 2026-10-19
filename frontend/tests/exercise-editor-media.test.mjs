import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// FE-2: the exercise editor's media fields - offered only while the server
// offers storage, the faces of a link, a stored file, an upload with its
// progress, a failure and a cancellation, Save held during an upload, the
// close and unload guards - against a fake transport and fake answers. The
// real seam (no BE-2 contract yet) refuses and sends nothing.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const { STORAGE_ROUTE } = await import("../exercise-media-upload.js");

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = {};
const rendered = () => content.innerHTML;
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const file = (name, size, type) => ({ name, size, type });

const account = (overrides = {}) => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000",
  availableBytes: "3800000000", limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1, ...overrides,
});
const detail = (overrides = {}) => ({ id: "e1", ownerScope: "user", canEdit: true, name: "Dead Bug", videoUrl: "", imageUrl: "https://drive.google.com/file/d/IMG_1/view", tags: [], ...overrides });

// The API fake: storage by `storage`, the detail by `exercise`, every write recorded.
function fakeApi({ storage = { accounts: [account()] }, exercise = detail() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url === STORAGE_ROUTE) {
      if (storage?.status) return { ok: false, status: storage.status, statusText: "Error", json: async () => storage.json };
      return { ok: true, status: 200, json: async () => storage };
    }
    if (call.url.startsWith("/api/exercises/")) return { ok: true, status: 200, json: async () => (call.method === "GET" ? exercise : { id: "e1" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound" }) };
  };
  return calls;
}

// A transport that reports progress, waits at a gate, and honours the signal.
function fakeTransport({ fail = null } = {}) {
  const transport = { calls: [], release: null, progress: null };
  transport.upload = (request, { onProgress, signal }) => new Promise((resolve, reject) => {
    transport.calls.push(request);
    transport.progress = onProgress;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    transport.release = () => (fail ? reject(Object.assign(new Error(fail), { code: fail })) : resolve({ mediaId: `new-${transport.calls.length}`, uploadId: "u1" }));
  });
  return transport;
}

const controlsOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button, [data-exercise-media-slot="${slot}"] input, [data-exercise-media-slot="${slot}"] select`)].map((control) => control.textContent.trim() || `<${control.tagName.toLowerCase()} ${control.dataset.exerciseMediaFile ? "file" : control.dataset.exerciseEditorField || ""}>`);
const action = (type, slot) => ({ dataset: { action: type, slot }, closest: (selector) => content.querySelector(`[data-exercise-media-slot="${slot}"]`)?.closest(selector) });

test("1. the flag off (503 media_storage_disabled): the editor is exactly as before - the two links, no file control, no storage line", async () => {
  const calls = fakeApi({ storage: { status: 503, json: { error: "Media storage is disabled.", code: "media_storage_disabled" } } });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.equal(calls.filter((call) => call.url === STORAGE_ROUTE).length, 1, "storage read once at open");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.doesNotMatch(rendered(), /Upload video|Replace with a file|Storage \(/);
  assert.ok(content.querySelector('[data-exercise-editor-field="videoUrl"]'), "the video link field as before");
  assert.equal(content.querySelector('[data-exercise-editor-field="imageUrl"]').value, "https://drive.google.com/file/d/IMG_1/view");
  assert.equal(content.querySelectorAll('[data-exercise-media-slot] button').length, 0, "no Preview / Replace / Remove: the plain fields");
  assert.equal(content.querySelector('[data-action="exercise-editor-save"]').disabled, false);
  editor.closeExerciseEditor(state, handlers());
});

test("2. the flag on: Upload and Use a link, the storage line, a stored file's Preview through the FE-1 player, a link's Edit link / Replace / Remove", async () => {
  fakeApi({ exercise: detail({ media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "legacy", url: "https://drive.google.com/file/d/IMG_1/view" }, accessContext: { type: "exercise", id: "e1" } } }) });
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "stored");
  assert.equal(state.exerciseEditor.media.video.mediaId, "vid-1");
  const video = content.querySelector('[data-exercise-media-slot="video"]');
  const preview = video.querySelector('[data-action="open-media"]');
  assert.equal(preview.dataset.videoMediaId, "vid-1");
  assert.deepEqual(JSON.parse(preview.dataset.mediaAccessContext), { type: "exercise", id: "e1" });
  assert.equal(preview.dataset.video, "", "never a URL for a stored file");
  assert.deepEqual(controlsOf("video"), ["Preview", "Replace...", "Remove", "<input file>"]);
  assert.match(video.querySelector(".exercise-media-technical code").textContent, /vid-1/);
  assert.deepEqual(controlsOf("image"), ["Preview", "Edit link", "Replace with a file...", "Remove", "<input file>"]);
  assert.equal(content.querySelector('[data-exercise-media-slot="image"] [data-action="open-media"]').dataset.image, "https://drive.google.com/file/d/IMG_1/view");
  assert.equal(content.querySelector('[data-exercise-media-file="video"]').getAttribute("accept"), "video/mp4,video/webm");
  assert.equal(content.querySelector('[data-exercise-media-file="image"]').getAttribute("accept"), "image/jpeg,image/png,image/webp");
  assert.equal(content.querySelector("[data-exercise-media-storage]").textContent, "Storage (personal storage): 1.2 GB used of 5 GB · 3.8 GB free · one video up to 209.7 MB, one picture up to 10.5 MB");
  // Edit link reveals the field; Remove clears the link at once.
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-link", "image"));
  assert.ok(content.querySelector('[data-exercise-media-slot="image"] [data-exercise-editor-field="imageUrl"]'));
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "image"));
  assert.equal(state.exerciseEditor.data.imageUrl, "");
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"]);
  // Remove on the stored file: dropped on Save (recorded for the field BE-2 names), the save body as before.
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "none");
  assert.equal(state.exerciseEditor.media.video.removedMediaId, "vid-1");
  const calls = fakeApi();
  await editor.handleExerciseEditorAction(state, handlers(), { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch);
  assert.equal(patch.body.videoUrl, "");
  assert.equal(Object.keys(patch.body).some((key) => /media/i.test(key)), false, "the contract is pending: nothing new in the save body");
  assert.equal(state.exerciseEditor.open, false);
});

test("3. a file the limits refuse is refused locally with the sentence, nothing is sent, Save stays enabled", async () => {
  const calls = fakeApi();
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  await editor.chooseExerciseMediaFile(state, handlers(), "video", file("big.mp4", 300000000, "video/mp4"));
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, "This file is 300 MB. The limit for one video is 209.7 MB.");
  assert.deepEqual(controlsOf("video"), ["Choose another file", "Use a link", "Clear", "<input file>"], "no Retry for a file that can never pass");
  assert.equal(content.querySelector('[data-action="exercise-editor-save"]').disabled, false);
  await editor.chooseExerciseMediaFile(state, handlers(), "image", file("a.gif", 10, "image/gif"));
  assert.equal(content.querySelector('[data-exercise-media-slot="image"] .exercise-media-status').textContent, "Only JPG, PNG or WebP pictures can be uploaded.");
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media")).length, 1, "only the storage read at open");
  editor.closeExerciseEditor(state, handlers());
});

test("4. a valid file uploads through the transport: progress patched in place, Save held, Cancel, Retry with the same file, then uploaded replaces the link", async () => {
  fakeApi({ exercise: detail({ videoUrl: "https://youtu.be/dQw4w9WgXcQ" }) });
  let transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const chosen = file("clip.mp4", 100, "video/mp4");
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", chosen);
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploading");
  assert.deepEqual(transport.calls[0], { file: chosen, slot: "video", context: { type: "exercise", id: "e1" } });
  const save = content.querySelector('[data-action="exercise-editor-save"]');
  assert.equal(save.disabled, true);
  assert.equal(save.textContent, "Uploading... 0%");
  assert.deepEqual(controlsOf("video"), ["Cancel", "<input file>"]);
  // A progress tick patches the bar, the text and the Save button, without a rerender.
  const before = content.querySelector(".exercise-media-progress");
  transport.progress({ sent: 50, total: 100 });
  assert.equal(content.querySelector(".exercise-media-progress"), before, "the same element");
  assert.equal(before.value, 50);
  assert.equal(content.querySelector('[data-exercise-media-progress-text="video"]').textContent, "50 % · 50 B of 100 B");
  assert.equal(save.textContent, "Uploading... 50%");
  // Save during an upload is refused with a sentence, and the editor stays open.
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  assert.match(state.exerciseEditor.error, /Wait for the upload/);
  assert.equal(state.exerciseEditor.open, true);
  assert.equal(editor.handleExerciseMediaBeforeUnload({ preventDefault() {} }, state), true, "a reload asks");
  // Cancel.
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-cancel", "video"));
  await uploading;
  assert.equal(state.exerciseEditor.media.video.state, "cancelled");
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, "Upload cancelled.");
  assert.deepEqual(controlsOf("video"), ["Upload again", "Use a link", "Clear", "<input file>"]);
  assert.equal(state.exerciseEditor.data.videoUrl, "https://youtu.be/dQw4w9WgXcQ", "the link stays until a file is really uploaded");
  assert.equal(editor.handleExerciseMediaBeforeUnload({ preventDefault() {} }, state), false);
  // A failure keeps the File for Retry; Retry sends the very same File.
  transport = fakeTransport({ fail: "media_storage_busy" });
  const h2 = handlers({ upload: transport.upload });
  const failing = editor.chooseExerciseMediaFile(state, h2, "video", chosen);
  await settle();
  transport.release();
  await failing;
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-status').textContent, /did not finish/);
  assert.deepEqual(controlsOf("video"), ["Retry", "Choose another file", "Use a link", "Clear", "<input file>"]);
  transport = fakeTransport();
  const h3 = handlers({ upload: transport.upload });
  await editor.handleExerciseEditorAction(state, h3, action("exercise-media-retry", "video"));
  await settle();
  assert.equal(transport.calls[0].file, chosen, "the same File, never asked for again");
  transport.release();
  await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(state.exerciseEditor.media.video.mediaId, "new-1");
  assert.equal(state.exerciseEditor.data.videoUrl, "", "an uploaded file replaces the link of its slot");
  assert.deepEqual(controlsOf("video"), ["Preview", "Replace...", "Remove", "<input file>"]);
  assert.equal(content.querySelector('[data-action="exercise-editor-save"]').disabled, false);
  await editor.handleExerciseEditorAction(state, h3, action("exercise-media-preview-local", "video"));
  assert.equal(content.querySelector(".exercise-media-preview-local video").getAttribute("src"), "blob:preview");
  assert.doesNotMatch(rendered(), /new-1/, "an uploaded id is nowhere in the markup");
  editor.closeExerciseEditor(state, h3);
});

test("5. the real seam: Upload fails at once with the not-yet sentence, no Retry, nothing sent; the file input's change starts it", async () => {
  const calls = fakeApi();
  const h = handlers();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const input = content.querySelector('[data-exercise-media-file="image"]');
  const picked = new File([new Uint8Array(10)], "photo.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [picked] });
  assert.equal(editor.handleExerciseEditorChange(state, h, { target: input }), true);
  await settle();
  assert.equal(state.exerciseEditor.media.image.state, "failed");
  assert.equal(state.exerciseEditor.media.image.error.code, "upload_contract_pending");
  assert.equal(content.querySelector('[data-exercise-media-slot="image"] .exercise-media-status').textContent, "Uploading files is not available yet in this version. Use a link for now.");
  assert.deepEqual(controlsOf("image"), ["Choose another file", "Use a link", "Clear", "<input file>"], "no Retry: it would fail the same way");
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media")).length, 1, "only the storage read");
  assert.equal(editor.handleExerciseEditorChange(state, h, { target: content.querySelector('[data-exercise-editor-field="name"]') }), false, "any other change is not ours");
  editor.closeExerciseEditor(state, h);
});

test("6. closing with an upload in flight asks first; no cancels, yes closes and aborts", async () => {
  fakeApi();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const uploading = editor.chooseExerciseMediaFile(state, h, "image", file("a.png", 10, "image/png"));
  await settle();
  globalThis.confirm = () => false;
  assert.equal(editor.closeExerciseEditor(state, h), false);
  assert.equal(state.exerciseEditor.open, true);
  assert.equal(state.exerciseEditor.media.image.state, "uploading");
  globalThis.confirm = () => true;
  assert.equal(editor.closeExerciseEditor(state, h), true);
  assert.equal(state.exerciseEditor.open, false);
  await uploading;
  assert.equal(rendered(), "");
  delete globalThis.confirm;
});

test("7. a new exercise or a copy: links only, no storage read, no file control", async () => {
  const calls = fakeApi();
  await editor.openExerciseEditor(state, handlers(), "");
  assert.equal(calls.filter((call) => call.url === STORAGE_ROUTE).length, 0);
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.ok(content.querySelector('[data-exercise-editor-field="videoUrl"]'));
  assert.doesNotMatch(rendered(), /Upload|Storage \(/);
  editor.closeExerciseEditor(state, handlers());
  await editor.openExerciseEditor(state, handlers(), "e1", { copy: true });
  await settle();
  assert.equal(calls.filter((call) => call.url === STORAGE_ROUTE).length, 0);
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.equal(state.exerciseEditor.media.video.state, "none", "a copy starts without the original's file");
  editor.closeExerciseEditor(state, handlers());
});

test("8. a storage read that fails says so and offers Read again; the upload is still offered (the server checks)", async () => {
  let fail = true;
  let storageReads = 0;
  fakeApi();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === STORAGE_ROUTE) storageReads += 1;
    return String(url) === STORAGE_ROUTE && fail ? { ok: false, status: 500, statusText: "Error", json: async () => ({}) } : base(url, options);
  };
  await editor.openExerciseEditor(state, handlers(), "e1");
  await settle();
  assert.match(content.querySelector(".exercise-media-storage").textContent, /could not be read/);
  assert.ok(content.querySelector('[data-action="exercise-media-storage-reload"]'));
  assert.ok(content.querySelector('[data-exercise-media-file="video"]'), "offered: the server is the guard");
  fail = false;
  await editor.handleExerciseEditorAction(state, handlers(), { dataset: { action: "exercise-media-storage-reload" } });
  await settle();
  assert.match(content.querySelector("[data-exercise-media-storage]").textContent, /3\.8 GB free/);
  assert.equal(storageReads, 2);
  editor.closeExerciseEditor(state, handlers());
});
