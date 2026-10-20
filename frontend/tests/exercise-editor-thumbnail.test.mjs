import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// PR 3: thumbnails in the exercise editor, against a fake transport and
// fake frame helpers - nothing without BE-3 or over a link video, the
// automatic thumbnail after a video upload (the server's duration first),
// the sentence when none could be made, the picker (open, slide, use,
// cancel, fail), the stored video through its signed address, and what goes
// with the video. The capture itself is tested in exercise-media-thumbnail.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const guards = await import("../exercise-media-upload.js");
// Node has no WebCodecs: the on-device preparation answers from the fake file's facts (a compliant MP4 here).
const { installVideoPrepareFake } = await import("./support/video-prepare-fake.mjs");
installVideoPrepareFake();
const { frameFileName } = await import("../exercise-media-thumbnail.js");
const { STORAGE_ROUTE } = guards;

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = { currentUser: { id: "u1" } };
const rendered = () => content.innerHTML;
const withGuards = ({ transport = false, save = false } = {}) => { guards.setUploadTransportEnabled(transport); guards.setMediaSaveEnabled(save); };
const file = (name, size, type) => ({ name, size, type });

const account = () => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000",
  availableBytes: "3800000000", limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1,
});
const detail = (overrides = {}) => ({ id: "e1", ownerScope: "user", canEdit: true, name: "Dead Bug", videoUrl: "", imageUrl: "", tags: [], ...overrides });
const storedVideo = { media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "none" }, accessContext: { type: "exercise", id: "e1" } } };

function fakeApi({ exercise = detail() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith(STORAGE_ROUTE)) return { ok: true, status: 200, json: async () => ({ accounts: [account()], selectedStorageAccountId: "acc-1" }) };
    if (call.url.startsWith("/api/exercises/")) return { ok: true, status: 200, json: async () => (call.method === "GET" ? exercise : { id: "e1" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound" }) };
  };
  return calls;
}

// A transport that completes each upload when released, in order; a video's
// completion may carry the server's verified metadata.
function fakeTransport({ metadata = null } = {}) {
  const transport = { calls: [], releases: [] };
  transport.upload = (request, options) => new Promise((resolve, reject) => {
    const n = transport.calls.push(request);
    options.signal.addEventListener("abort", () => setTimeout(() => reject(Object.assign(new Error("cancelled"), { code: "cancelled", cancelOutcome: "cancelled", uploadId: `up-${n}` })), 0), { once: true });
    transport.releases.push(() => resolve({
      uploadId: `up-${n}`, mediaId: `new-${n}`, status: "completed",
      media: { source: "asset", mediaId: `new-${n}`, kind: request.slot, status: "ready", ...(request.slot === "video" && metadata ? { metadata } : {}) },
    }));
  });
  transport.release = () => transport.releases.shift()?.();
  return transport;
}

// The frame helpers the editor takes from its handlers (the real ones need a browser).
function fakeFrames({ duration = 40 } = {}) {
  const frames = { captures: [], reads: [], playbacks: [], fail: "", playbackFail: "" };
  frames.handlers = {
    captureFrame: async (src, time, options = {}) => {
      frames.captures.push({ src, time, crossOrigin: options.crossOrigin || "", videoName: options.videoName });
      if (frames.fail) throw Object.assign(new Error(frames.fail), { code: frames.fail });
      return { file: new File(["jpg"], frameFileName(options.videoName, time), { type: "image/jpeg" }), timeSeconds: time, width: 1280, height: 720 };
    },
    readVideoMetadata: async (src, options = {}) => {
      frames.reads.push({ src, crossOrigin: options.crossOrigin || "" });
      return { durationSeconds: duration, width: 1920, height: 1080 };
    },
    loadPlayback: async (context) => {
      frames.playbacks.push(context);
      if (frames.playbackFail) throw Object.assign(new Error(frames.playbackFail), { code: frames.playbackFail });
      return { url: "https://r2.example/signed/vid-1?sig=1", mediaId: "vid-1", expiresAt: "", poster: "" };
    },
  };
  return frames;
}

const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const controlsOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button, [data-exercise-media-slot="${slot}"] input`)].map((control) => control.textContent.trim() || `<input ${control.dataset.exerciseMediaFile ? "file" : control.dataset.exerciseEditorField || control.type || ""}>`);
const action = (type, slot) => ({ dataset: { action: type, slot }, closest: (selector) => content.querySelector(`[data-exercise-media-slot="${slot}"]`)?.closest(selector) });
const statusesOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] .exercise-media-status`)].map((p) => p.textContent.trim()).join(" | ");
const originLine = () => content.querySelector('[data-exercise-media-slot="image"] .exercise-media-origin')?.textContent.trim();
const picker = () => content.querySelector('[data-exercise-media-frame-picker="image"]');
const image = () => state.exerciseEditor.media.image;

async function uploadVideo(h, transport, name = "clip.mp4") {
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file(name, 100, "video/mp4"));
  await settle();
  transport.release();
  await uploading;
  await settle();
}

test("1. nothing without BE-3: with the save guard off an uploaded video makes no thumbnail and offers no frame, a stored video neither; with both guards off the editor is as before; a YouTube link has no frame even with BE-3", async () => {
  withGuards({ transport: true });
  const frames = fakeFrames();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(frames.captures.length + frames.reads.length, 0, "nothing read, nothing captured");
  assert.equal(transport.calls.length, 1, "no second upload");
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"]);
  assert.doesNotMatch(rendered(), /frame/i);
  editor.closeExerciseEditor(state, h);
  fakeApi({ exercise: detail(storedVideo) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  assert.deepEqual(controlsOf("video"), ["Preview", "<input file>"], "a stored file: Preview only before BE-3, as FE-2 left it");
  assert.doesNotMatch(rendered(), /frame/i);
  editor.closeExerciseEditor(state, h);
  withGuards();
  const calls = fakeApi({ exercise: detail(storedVideo) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media")).length, 0, "production: no media request");
  assert.doesNotMatch(rendered(), /frame/i);
  assert.equal(picker(), null);
  editor.closeExerciseEditor(state, h);
  withGuards({ transport: true, save: true });
  fakeApi({ exercise: detail({ videoUrl: "https://youtu.be/dQw4w9WgXcQ" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"], "a link has no frame the browser may read");
  assert.doesNotMatch(rendered(), /frame/i);
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("2. after a video upload that left the picture empty: a thumbnail a quarter in, through the transport as automatic_thumbnail with the video and the moment; the server's duration first, else the file's; the save body carries both assets", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport({ metadata: { durationSeconds: 36, width: 1920, height: 1080, videoCodec: "h264", audioCodec: null } });
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  const calls = fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file("Squat Jump.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await uploading;
  await settle();
  // The server's 36 s wins over the file's 40 s: the moment is 9 s.
  assert.equal(frames.reads.length, 0, "the server's duration is known: the file is not read");
  assert.deepEqual(frames.captures, [{ src: "blob:preview", time: 9, crossOrigin: "", videoName: "Squat Jump.mp4" }]);
  assert.equal(transport.calls.length, 2);
  const request = transport.calls[1];
  assert.deepEqual({ slot: request.slot, purpose: request.purpose, sourceMediaId: request.sourceMediaId, frameTimeSeconds: request.frameTimeSeconds, context: request.context }, { slot: "image", purpose: "automatic_thumbnail", sourceMediaId: "new-1", frameTimeSeconds: 9, context: { type: "exercise_edit", exerciseId: "e1" } });
  assert.equal(request.file.type, "image/jpeg");
  assert.equal(request.file.name, "Squat-Jump-frame-9s.jpg");
  assert.equal(image().state, "uploading");
  assert.equal(image().capturing, false);
  transport.release();
  await settle();
  assert.equal(image().state, "uploaded");
  assert.equal(originLine(), "Thumbnail made from the video at 0:09, a quarter in. Choose another frame or upload a picture to change it.");
  assert.deepEqual(controlsOf("image"), ["Preview", "Replace...", "Choose another frame...", "Remove", "<input file>"]);
  assert.doesNotMatch(rendered(), /new-[12]/, "no id in the markup");
  assert.equal(content.querySelector('[data-action="exercise-editor-save"]').disabled, false);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body.media, { video: { source: "asset", mediaId: "new-1" }, image: { source: "asset", mediaId: "new-2" } });
  assert.equal("videoUrl" in patch.body, false);
  assert.equal("imageUrl" in patch.body, false);
  assert.equal(state.exerciseEditor.open, false);
  // Without the server's duration the file's own metadata is read.
  const frames2 = fakeFrames({ duration: 40 });
  const transport2 = fakeTransport();
  const h2 = handlers({ upload: transport2.upload, ...frames2.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h2, "e1");
  await settle();
  await uploadVideo(h2, transport2);
  assert.deepEqual(frames2.reads, [{ src: "blob:preview", crossOrigin: "" }]);
  assert.equal(frames2.captures[0].time, 10);
  assert.equal(transport2.calls[1].frameTimeSeconds, 10);
  assert.equal(image().state, "uploading");
  editor.closeExerciseEditor(state, h2);
  withGuards();
});

test("3. no automatic thumbnail over a link the coach has; a failed capture leaves one sentence, the picture empty and Save possible, and the coach may still choose a frame", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames();
  let transport = fakeTransport();
  let h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  assert.equal(frames.captures.length, 0);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(controlsOf("image"), ["Preview", "Edit link", "Replace with a file...", "Replace with a frame...", "Remove", "<input file>"]);
  editor.closeExerciseEditor(state, h);
  frames.fail = "frame_capture_unsupported";
  transport = fakeTransport();
  h = handlers({ upload: transport.upload, ...frames.handlers });
  const calls = fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  assert.equal(frames.captures.length, 1);
  assert.equal(transport.calls.length, 1, "nothing uploaded for the picture");
  assert.equal(image().state, "none");
  assert.equal(image().capturing, false);
  assert.equal(statusesOf("image"), "No picture yet. | No thumbnail was made from the video. This browser cannot take a frame from a video. Upload a picture instead.");
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Choose a frame of the video...", "Use a link", "<input file>"]);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body.media, { video: { source: "asset", mediaId: "new-1" } });
  assert.equal(patch.body.imageUrl, "", "the empty picture travels as before");
  assert.equal(state.exerciseEditor.open, false);
  withGuards();
});

test("4. the picker: the video a quarter in with the slider to the end, the slider moves the moment without a redraw, Use this frame captures that moment and uploads it as video_frame; Cancel closes; a failed capture keeps the picker with the sentence", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  const p = image().framePicker;
  assert.deepEqual({ src: p.src, duration: p.durationSeconds, time: p.timeSeconds, crossOrigin: p.crossOrigin, sourceMediaId: p.sourceMediaId, loading: p.loading }, { src: "blob:preview", duration: 40, time: 10, crossOrigin: "", sourceMediaId: "new-1", loading: false });
  const video = picker().querySelector("video");
  assert.equal(video.getAttribute("src"), "blob:preview#t=10");
  assert.ok(video.hasAttribute("controls"));
  assert.ok(video.hasAttribute("muted"));
  assert.equal(video.hasAttribute("crossorigin"), false);
  const slider = picker().querySelector("[data-exercise-media-frame-time]");
  assert.equal(slider.max, "39.9");
  assert.equal(slider.value, "10");
  assert.equal(picker().querySelector("[data-exercise-media-frame-label]").textContent, "0:10");
  const before = picker();
  slider.value = "22.3";
  assert.equal(editor.handleExerciseEditorInput(state, { target: slider }), true);
  assert.equal(p.timeSeconds, 22.3);
  assert.equal(picker(), before, "no redraw on a slide");
  assert.equal(picker().querySelector("[data-exercise-media-frame-label]").textContent, "0:22.3");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-cancel", "image"));
  assert.equal(image().framePicker, null);
  assert.equal(picker(), null);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  const again = picker().querySelector("[data-exercise-media-frame-time]");
  again.value = "22.3";
  editor.handleExerciseEditorInput(state, { target: again });
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.deepEqual(frames.captures, [{ src: "blob:preview", time: 22.3, crossOrigin: "", videoName: "clip.mp4" }]);
  assert.equal(image().framePicker, null, "the picker closes once the frame is taken");
  assert.equal(image().state, "uploading");
  const request = transport.calls[1];
  assert.deepEqual({ slot: request.slot, purpose: request.purpose, sourceMediaId: request.sourceMediaId, frameTimeSeconds: request.frameTimeSeconds }, { slot: "image", purpose: "video_frame", sourceMediaId: "new-1", frameTimeSeconds: 22.3 });
  transport.release();
  await settle();
  assert.equal(image().state, "uploaded");
  assert.equal(state.exerciseEditor.data.imageUrl, "", "the frame replaces the link of its slot");
  assert.equal(originLine(), "Frame of the video at 0:22.3.");
  assert.deepEqual(controlsOf("image"), ["Preview", "Replace...", "Choose another frame...", "Remove", "<input file>"]);
  frames.fail = "frame_capture_failed";
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.equal(picker().querySelector('[role="alert"]').textContent, "The frame could not be made. Try another moment, or upload a picture.");
  assert.equal(image().framePicker.busy, false);
  assert.equal(image().state, "uploaded");
  assert.equal(originLine(), "Frame of the video at 0:22.3.");
  assert.equal(transport.calls.length, 2, "nothing uploaded for a failed frame");
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("5. a stored video with BE-3: the picker opens the signed playback address with CORS, reads it, and the frame uploads as video_frame of the stored file; nothing automatic; an address that cannot be opened is the stored-video sentence", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi({ exercise: detail(storedVideo) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  assert.deepEqual(controlsOf("video"), ["Preview", "Replace...", "Remove", "<input file>"]);
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Choose a frame of the video...", "Use a link", "<input file>"]);
  assert.equal(frames.captures.length, 0, "nothing automatic for a stored video");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  assert.match(picker().textContent, /Opening the video/);
  await settle();
  assert.deepEqual(frames.playbacks, [{ type: "exercise", id: "e1" }]);
  assert.deepEqual(frames.reads, [{ src: "https://r2.example/signed/vid-1?sig=1", crossOrigin: "anonymous" }]);
  const video = picker().querySelector("video");
  assert.equal(video.getAttribute("crossorigin"), "anonymous");
  assert.equal(video.getAttribute("src"), "https://r2.example/signed/vid-1?sig=1#t=10");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.deepEqual(frames.captures, [{ src: "https://r2.example/signed/vid-1?sig=1", time: 10, crossOrigin: "anonymous", videoName: "Dead Bug" }]);
  const request = transport.calls[0];
  assert.deepEqual({ purpose: request.purpose, sourceMediaId: request.sourceMediaId, frameTimeSeconds: request.frameTimeSeconds }, { purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 10 });
  transport.release();
  await settle();
  assert.equal(image().state, "uploaded");
  assert.equal(originLine(), "Frame of the video at 0:10.");
  frames.playbackFail = "refused";
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  assert.equal(picker().querySelector('[role="alert"]').textContent, "The stored video could not be opened for a frame. Try again later, or upload a picture.");
  assert.equal(picker().querySelector("video"), null);
  assert.deepEqual([...picker().querySelectorAll("button")].map((button) => button.textContent), ["Close"]);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-cancel", "image"));
  assert.equal(picker(), null);
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("6. a thumbnail made automatically goes with its video (removed or replaced); a frame the coach chose stays; a new video closes the picker and makes its own thumbnail only over an empty picture", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  transport.release();
  await settle();
  assert.equal(image().origin?.automatic, true);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-remove", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "none");
  assert.equal(image().state, "none", "the automatic thumbnail went with its video");
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"]);
  await uploadVideo(h, transport);
  transport.release();
  await settle();
  assert.equal(transport.calls.length, 4, "video, thumbnail, video, thumbnail");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  transport.release();
  await settle();
  assert.equal(image().origin.purpose, "video_frame");
  assert.equal(image().origin.sourceMediaId, "new-3");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  assert.ok(picker());
  await uploadVideo(h, transport, "other.mp4");
  assert.equal(picker(), null, "a new video closes the picker over the old one");
  assert.equal(image().state, "uploaded");
  assert.equal(image().origin.sourceMediaId, "new-3", "the coach's frame stays");
  assert.equal(transport.calls.length, 6, "no automatic thumbnail over the coach's frame");
  assert.equal(frames.captures.length, 3);
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("7. the picker's CSS: a 44 px slider row at 16 px, 44 px actions, the video bounded", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.exercise-media-frame-time input\[type="range"\] \{[^}]*min-height: 44px;[^}]*font-size: 16px;/);
  assert.match(css, /\.exercise-media-frame-video \{[^}]*max-height: 280px;/);
  assert.match(css, /\.exercise-media-actions \.plain-button, \.exercise-media-actions \.text-action \{ min-height: 44px; min-width: 44px; \}/);
});
