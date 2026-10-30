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
      frames.bounds = [...(frames.bounds || []), options.bound];
      frames.signals = [...(frames.signals || []), options.signal];
      if (frames.gate) {
        // Waits like a slow device; a stop ends it the way the real capture does.
        await Promise.race([frames.gate, new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { code: options.signal.reason?.code || "frame_capture_timeout" })), { once: true }))]);
      }
      if (frames.fail) throw Object.assign(new Error(frames.fail), { code: frames.fail });
      return { file: new File(["jpg"], frameFileName(options.videoName, time), { type: "image/jpeg" }), timeSeconds: time, width: 1280, height: 720 };
    },
    readVideoMetadata: async (src, options = {}) => {
      frames.reads.push({ src, crossOrigin: options.crossOrigin || "" });
      return { durationSeconds: duration, width: 1920, height: 1080 };
    },
    // The real one starts a video; jsdom has none.
    showFrameAt: async () => "shown",
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
  assert.equal(video.getAttribute("src"), "blob:preview", "no #t= fragment: iOS Safari refuses a blob: address with one");
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
  assert.equal(video.getAttribute("src"), "https://r2.example/signed/vid-1?sig=1");
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

test("8. a phone that draws nothing before playback (iPhone): the picker asks its own video for the moment on open and on every slide; a moment it cannot show asks for one tap on play, in place, and the sentence goes once the moment shows; Use this frame takes the frame the coach sees from that video, drawn before the picker redraws; a video with no picture falls back to the capture of its own", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const shows = [];
  let answer = "tap";
  const fromElement = [];
  const h = handlers({
    upload: transport.upload,
    ...frames.handlers,
    showFrameAt: async (video, time) => { shows.push({ video, time, inPage: content.contains(video) }); return answer; },
    captureFrameFromElement: (video, options) => {
      fromElement.push({ video, inPage: content.contains(video), videoName: options.videoName });
      return Promise.resolve({ file: new File(["jpg"], frameFileName(options.videoName, video.currentTime), { type: "image/jpeg" }), timeSeconds: 22.3, width: 1280, height: 720 });
    },
  });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await settle();
  const video = picker().querySelector("video");
  assert.deepEqual(shows.map(({ time, inPage }) => ({ time, inPage })), [{ time: 10, inPage: true }], "asked for the opening moment in its own video");
  assert.equal(shows[0].video, video);
  const hint = () => picker().querySelector("[data-exercise-media-frame-hint]");
  assert.equal(hint().textContent, "If the video stays dark, tap play on it once, then move to the moment.", "the tap sentence shows");
  assert.equal(hint().hidden, false);
  assert.equal(hint().getAttribute("role"), "status");
  assert.equal(image().framePicker.needsTap, true);
  // A slide: asked again, in place; once the moment shows the sentence goes, without a redraw.
  answer = "woken";
  const before = picker();
  const slider = picker().querySelector("[data-exercise-media-frame-time]");
  slider.value = "22.3";
  editor.handleExerciseEditorInput(state, { target: slider });
  await settle();
  await settle();
  assert.equal(picker(), before, "no redraw");
  assert.equal(shows.at(-1).time, 22.3);
  assert.equal(hint().textContent, "", "the sentence goes; the status region stays");
  assert.equal(image().framePicker.needsTap, false);
  // Use this frame: the picker's video shows the moment, so the frame comes from it - drawn while it is still in the page.
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 22.34, writable: true, configurable: true });
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.deepEqual(fromElement.map(({ video: v, inPage, videoName }) => ({ same: v === video, inPage, videoName })), [{ same: true, inPage: true, videoName: "clip.mp4" }]);
  assert.equal(frames.captures.length, 0, "no second video opened");
  const request = transport.calls[1];
  assert.deepEqual({ purpose: request.purpose, sourceMediaId: request.sourceMediaId, frameTimeSeconds: request.frameTimeSeconds }, { purpose: "video_frame", sourceMediaId: "new-1", frameTimeSeconds: 22.3 });
  transport.release();
  await settle();
  // A picker whose video has no picture yet: Use this frame reads the moment from a video of its own, as before.
  answer = "shown";
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.equal(fromElement.length, 1, "nothing taken from a video without a picture");
  assert.equal(frames.captures.length, 1);
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("9. the tap sentence goes by itself once the video shows a picture (a tap on its own play, its scrubber, late data); an older answer ending late changes nothing; a video still seeking is not drawn - its moment is read from a video of its own", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const pending = [];
  const fromElement = [];
  const h = handlers({
    upload: transport.upload,
    ...frames.handlers,
    showFrameAt: (video, time) => new Promise((resolve) => pending.push({ time, resolve })),
    captureFrameFromElement: (video) => { fromElement.push(video); return Promise.resolve({ file: new File(["jpg"], "f.jpg", { type: "image/jpeg" }), timeSeconds: 5, width: 1280, height: 720 }); },
  });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await settle();
  const hint = () => picker().querySelector("[data-exercise-media-frame-hint]");
  const video = picker().querySelector("video");
  // An older answer ending after a newer one: the newer one counts.
  const slider = picker().querySelector("[data-exercise-media-frame-time]");
  slider.value = "12";
  editor.handleExerciseEditorInput(state, { target: slider });
  await settle();
  assert.deepEqual(pending.map((p) => p.time), [10, 12]);
  pending[1].resolve("shown");
  await settle();
  pending[0].resolve("tap");
  await settle();
  assert.equal(hint().textContent, "", "the late, older 'tap' is ignored");
  assert.equal(image().framePicker.needsTap, false);
  // A 'tap' answer: the sentence shows - and goes by itself when the video gets a picture, no slide needed.
  slider.value = "13";
  editor.handleExerciseEditorInput(state, { target: slider });
  await settle();
  pending[2].resolve("tap");
  await settle();
  await settle();
  assert.equal(hint().textContent, "If the video stays dark, tap play on it once, then move to the moment.");
  video.dispatchEvent(new Event("timeupdate"));
  await settle();
  assert.notEqual(hint().textContent, "", "no picture yet: the sentence stays");
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  video.dispatchEvent(new Event("playing"));
  await settle();
  assert.equal(hint().textContent, "");
  assert.equal(image().framePicker.needsTap, false);
  // A video still seeking: its picture may be the previous moment, so the frame is read from a video of its own.
  Object.defineProperty(video, "seeking", { value: true, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 13, writable: true, configurable: true });
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  assert.equal(fromElement.length, 0);
  assert.deepEqual(frames.captures.map((c) => c.time), [13]);
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("10. a picker video the browser cannot read: the unreadable-video sentence, not the tap one - from the answer, and from a failure after it", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  let answer = "error";
  const h = handlers({ upload: transport.upload, ...frames.handlers, showFrameAt: async () => answer });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await settle();
  const hint = () => picker().querySelector("[data-exercise-media-frame-hint]");
  assert.equal(hint().textContent, "The video could not be read for a frame. Upload a picture instead.");
  assert.deepEqual([image().framePicker.previewError, image().framePicker.needsTap], [true, false]);
  // A later slide that shows the moment clears it.
  answer = "shown";
  const slider = picker().querySelector("[data-exercise-media-frame-time]");
  slider.value = "12";
  editor.handleExerciseEditorInput(state, { target: slider });
  await settle();
  await settle();
  assert.equal(hint().textContent, "");
  // The video fails after the answer: the sentence comes from its error event.
  picker().querySelector("video").dispatchEvent(new Event("error"));
  await settle();
  assert.equal(hint().textContent, "The video could not be read for a frame. Upload a picture instead.");
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("11. any redraw of the editor while the picker is open asks the new video for the chosen moment again (a slot's Preview, any other redraw); the read-failure listener is attached once per video, however often it is asked", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  const transport = fakeTransport();
  const calls = [];
  const h = handlers({ upload: transport.upload, ...frames.handlers, showFrameAt: async (video, time) => { calls.push({ video, time, inPage: content.contains(video) }); return "shown"; } });
  fakeApi({ exercise: detail({ imageUrl: "https://drive.google.com/file/d/IMG_1/view" }) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await uploadVideo(h, transport);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await settle();
  const slider = picker().querySelector("[data-exercise-media-frame-time]");
  slider.value = "22.3";
  editor.handleExerciseEditorInput(state, { target: slider });
  await settle();
  const before = calls.length;
  const oldVideo = picker().querySelector("video");
  // The video slot's Preview redraws the whole editor: the picker's video is a new element.
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-preview-local", "video"));
  await settle();
  const newVideo = picker().querySelector("video");
  assert.notEqual(newVideo, oldVideo, "the redraw replaced the video");
  assert.equal(calls.length, before + 1, "asked once more, after the redraw");
  assert.deepEqual({ same: calls.at(-1).video === newVideo, inPage: calls.at(-1).inPage, time: calls.at(-1).time }, { same: true, inPage: true, time: 22.3 });
  // Any other redraw (the app's own) does the same.
  h.rerender();
  await settle();
  assert.equal(calls.at(-1).video, picker().querySelector("video"));
  assert.equal(calls.at(-1).time, 22.3);
  // No redraw while the picker is closed asks anything.
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-cancel", "image"));
  const closed = calls.length;
  h.rerender();
  await settle();
  assert.equal(calls.length, closed);
  // One read-failure listener per video, however many slides.
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await settle();
  const video = picker().querySelector("video");
  let errorListeners = 0;
  const add = video.addEventListener.bind(video);
  video.addEventListener = (name, ...rest) => { if (name === "error") errorListeners += 1; return add(name, ...rest); };
  const s = picker().querySelector("[data-exercise-media-frame-time]");
  for (const value of ["1", "2", "3", "4", "5"]) { s.value = value; editor.handleExerciseEditorInput(state, { target: s }); }
  await settle();
  assert.equal(errorListeners, 0, "already listening since it was first asked");
  editor.closeExerciseEditor(state, h);
  withGuards();
});

test("12. while the automatic thumbnail is made, Choose a frame of the video is there at once; choosing drops the automatic attempt (its result is never uploaded); the automatic attempt gives up after 6 s; the capture video is put in the page out of sight and removed afterwards", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  let open;
  frames.gate = new Promise((resolve) => { open = resolve; });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await uploading;
  await settle();
  // The automatic thumbnail is being made (the capture waits): the button is already there.
  assert.equal(image().capturing, true);
  assert.match(statusesOf("image"), /Making a thumbnail from the video\.\.\./);
  assert.ok(controlsOf("image").includes("Choose a frame of the video..."), controlsOf("image").join(", "));
  assert.equal(frames.bounds.at(-1), 6000, "the automatic attempt's own bound");
  // The coach chooses at once: the automatic attempt is stopped (its video stops loading), not only ignored.
  const attempt = frames.signals.at(-1);
  assert.equal(attempt.aborted, false);
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  assert.equal(attempt.aborted, true, "stopped");
  assert.equal(image().capturing, false);
  assert.equal(image().note, "", "no failure sentence for a stopped attempt");
  assert.ok(image().framePicker, "the picker is open");
  assert.doesNotMatch(statusesOf("image"), /Making a thumbnail/);
  // The automatic capture finishes late: nothing is uploaded, the picker stays.
  open();
  await settle();
  await settle();
  assert.equal(transport.calls.length, 1, "only the video");
  assert.ok(image().framePicker);
  assert.equal(image().state, "none");
  editor.closeExerciseEditor(state, h);
  withGuards();
  // The capture video: in the page, out of sight, never read out; removed when done.
  const thumb = await import("../exercise-media-thumbnail.js");
  const video = thumb.createCaptureVideo(document);
  assert.equal(video.isConnected, true);
  assert.equal(video.getAttribute("aria-hidden"), "true");
  assert.equal(video.getAttribute("tabindex"), "-1");
  assert.deepEqual([video.style.position, video.style.width, video.style.height, video.style.opacity, video.style.pointerEvents], ["fixed", "2px", "2px", "0.01", "none"]);
  const read = thumb.readVideoMetadata("blob:never", { createVideo: () => video, bound: 30 });
  await assert.rejects(read, (e) => e.code === "frame_capture_timeout");
  assert.equal(video.isConnected, false, "removed after the attempt");
  assert.equal(document.querySelectorAll("[data-exercise-media-capture-video]").length, 0);
});

test("13. the automatic attempt has one deadline for the whole of it: past it the attempt is stopped and the picture field says why; closing the editor or changing the video stops it too", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  frames.gate = new Promise(() => {}); // a device that never makes the frame
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers, automaticThumbnailBoundMs: 40 });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await uploading;
  await settle();
  assert.equal(image().capturing, true);
  assert.equal(frames.bounds.at(-1), 40);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await settle();
  assert.equal(frames.signals.at(-1).aborted, true, "stopped at the deadline");
  assert.equal(image().capturing, false);
  assert.equal(image().note, "No thumbnail was made from the video. Reading the video for a frame took too long. Try again, or upload a picture.");
  assert.ok(controlsOf("image").includes("Choose a frame of the video..."));
  editor.closeExerciseEditor(state, h);
  // Closing the editor while it runs stops it.
  const h2 = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h2, "e1");
  await settle();
  const second = editor.chooseExerciseMediaFile(state, h2, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await second;
  await settle();
  const running = frames.signals.at(-1);
  assert.equal(running.aborted, false);
  editor.closeExerciseEditor(state, h2);
  assert.equal(running.aborted, true, "closing the editor stops it");
  withGuards();
});

test("14. uploading a picture while the automatic thumbnail is made stops the automatic attempt at once; only the coach's picture is uploaded", async () => {
  withGuards({ transport: true, save: true });
  const frames = fakeFrames({ duration: 40 });
  let open;
  frames.gate = new Promise((resolve) => { open = resolve; });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  const uploading = editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  transport.release();
  await uploading;
  await settle();
  assert.equal(image().capturing, true);
  const attempt = frames.signals.at(-1);
  assert.equal(attempt.aborted, false);
  const picture = editor.chooseExerciseMediaFile(state, h, "image", file("p.jpg", 10, "image/jpeg"));
  assert.equal(attempt.aborted, true, "stopped at once, not at the deadline");
  await settle();
  transport.release();
  await picture;
  await settle();
  // The automatic capture would have finished late: nothing more is uploaded.
  open();
  await settle();
  await settle();
  assert.equal(transport.calls.length, 2, "the video and the coach's picture");
  assert.equal(transport.calls[1].slot, "image");
  assert.equal(image().note, "", "no failure sentence for a stopped attempt");
  assert.equal(image().origin, null, "the coach's own picture, not a frame");
  editor.closeExerciseEditor(state, h);
  withGuards();
});

// Owner, 2026-10-30: a frame of a video that is a Drive -> R2 copy (stored in
// the platform's storage, not the coach's) is refused by the server as a frame
// - 404 at the reservation, before any byte. It is saved as a plain picture,
// once, without its moment. A transport that answers each call from a script.
function scriptedTransport(answers) {
  const transport = { calls: [] };
  transport.upload = async (request) => {
    const n = transport.calls.push(request);
    const answer = answers[n - 1] ?? "ok";
    if (answer !== "ok") throw Object.assign(new Error(answer.code), answer);
    return { uploadId: `up-${n}`, mediaId: `new-${n}`, status: "completed", media: { source: "asset", mediaId: `new-${n}`, kind: request.slot, status: "ready" } };
  };
  return transport;
}
const refusedFrame = { code: "resource_not_found", uploadId: "", idempotencyKey: "k" };
async function frameOfStored(transport) {
  const frames = fakeFrames({ duration: 40 });
  const h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi({ exercise: detail(storedVideo) });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-pick", "image"));
  await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-frame-use", "image"));
  await settle();
  await settle();
  return { h, frames };
}
const requestOf = (call) => ({ slot: call.slot, purpose: call.purpose, ...("sourceMediaId" in call ? { sourceMediaId: call.sourceMediaId } : {}), ...("frameTimeSeconds" in call ? { frameTimeSeconds: call.frameTimeSeconds } : {}), fileName: call.file?.name });

test("15. a frame of a stored video the server refuses as a frame (a Drive copy) is saved as a plain picture - once, the same file, no moment, no 'can't be found'; a second refusal, a refusal after the reservation and a frame of a just-uploaded video are not retried", async () => {
  withGuards({ transport: true, save: true });
  // The copy: the frame is refused before any reservation, then goes up as a picture.
  let transport = scriptedTransport([refusedFrame, "ok"]);
  let { h } = await frameOfStored(transport);
  assert.equal(transport.calls.length, 2, "one retry");
  const [asFrame, asPicture] = transport.calls.map(requestOf);
  assert.deepEqual(asFrame, { slot: "image", purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 10, fileName: frameFileName("Dead Bug", 10) });
  assert.deepEqual(asPicture, { slot: "image", purpose: "exercise_image", fileName: frameFileName("Dead Bug", 10) }, "a plain picture of the same file, without source or moment");
  assert.equal(transport.calls[0].file, transport.calls[1].file, "the capture itself is unchanged");
  assert.equal(image().state, "uploaded");
  assert.equal(image().mediaId, "new-2");
  assert.equal(image().origin, null, "no frame provenance");
  assert.equal(originLine(), "Taken from the video and saved as a picture.");
  assert.doesNotMatch(rendered(), /can't be found/, "the first refusal is never shown");
  editor.closeExerciseEditor(state, h);

  // A second refusal (the exercise itself is gone): no second retry, the usual sentence.
  transport = scriptedTransport([refusedFrame, refusedFrame]);
  ({ h } = await frameOfStored(transport));
  assert.equal(transport.calls.length, 2, "no second retry");
  assert.equal(image().state, "failed");
  assert.match(statusesOf("image"), /can't be found/);
  editor.closeExerciseEditor(state, h);

  // Another refusal before the reservation (no right, storage off): not retried as a picture.
  for (const code of ["operation_not_allowed", "media_storage_disabled"]) {
    transport = scriptedTransport([{ ...refusedFrame, code }]);
    ({ h } = await frameOfStored(transport));
    assert.equal(transport.calls.length, 1, `${code}: no retry`);
    assert.equal(image().state, "failed");
    editor.closeExerciseEditor(state, h);
  }

  // Refused after the reservation (bytes may have gone up): not repeated.
  transport = scriptedTransport([{ ...refusedFrame, uploadId: "up-1" }]);
  ({ h } = await frameOfStored(transport));
  assert.equal(transport.calls.length, 1, "nothing is uploaded twice");
  assert.equal(image().state, "failed");
  editor.closeExerciseEditor(state, h);

  // A frame of a video uploaded in this editor (the coach's own storage): a refusal is not retried.
  const frames = fakeFrames({ duration: 40 });
  transport = scriptedTransport(["ok", refusedFrame]);
  h = handlers({ upload: transport.upload, ...frames.handlers });
  fakeApi();
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
  await editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 100, "video/mp4"));
  await settle();
  await settle();
  assert.equal(transport.calls.length, 2, "the video, then its automatic thumbnail");
  assert.equal(transport.calls[1].purpose, "automatic_thumbnail");
  assert.equal(image().origin?.purpose, "automatic_thumbnail", "kept as it was");
  assert.notEqual(image().state, "uploaded");
  editor.closeExerciseEditor(state, h);
  withGuards();
});
