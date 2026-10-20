import { test } from "node:test";
import assert from "node:assert/strict";

// PR 3: a frame of the exercise's R2 video as its picture - the capture
// against a fake <video> and <canvas> (the moment, the clamp, the scale, the
// JPEG, the name, every refusal and the release), the moment rules and the
// sentences, the picker's markup, and the transport's two extra top-level
// facts for the frame purposes (contract Q1). Nothing here reaches a server.

const thumb = await import("../exercise-media-thumbnail.js");
const upload = await import("../exercise-media-upload.js");

// A <video> that loads its metadata and seeks on the next tick, or fails, or
// stays silent; records what the capture did to it.
class FakeVideo {
  constructor({ duration = 40, width = 1920, height = 1080, fail = false, silent = false, seekSilent = false, readyState = 2 } = {}) {
    Object.assign(this, { duration: NaN, videoWidth: 0, videoHeight: 0, readyState: 0, listeners: {}, seeks: [], released: 0, _src: "", _time: 0 });
    this.options = { duration, width, height, fail, silent, seekSilent, readyState };
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((entry) => entry !== fn); }
  emit(name, event = { target: this }) { for (const fn of [...(this.listeners[name] || [])]) fn(event); }
  set src(value) {
    this._src = value;
    const { duration, width, height, fail, silent } = this.options;
    if (silent || !value) return;
    setTimeout(() => {
      if (fail) {
        this.error = { code: 4 };
        this.emit("error");
        return;
      }
      Object.assign(this, { duration, videoWidth: width, videoHeight: height, readyState: 1 });
      this.emit("loadedmetadata");
    }, 0);
  }
  get src() { return this._src; }
  set currentTime(value) {
    this._time = value;
    this.seeks.push(value);
    if (this.options.seekSilent) return;
    setTimeout(() => {
      if (this.options.readyState >= 2) this.readyState = this.options.readyState;
      this.emit("seeked");
      if (this.options.readyState < 2) setTimeout(() => { this.readyState = 2; this.emit("loadeddata"); }, 0);
    }, 0);
  }
  get currentTime() { return this._time; }
  removeAttribute(name) { if (name === "src") this._src = ""; }
  load() { this.released += 1; }
}

class FakeCanvas {
  constructor({ context = true, blob = "jpeg-bytes", drawError = null, blobError = null } = {}) {
    Object.assign(this, { width: 0, height: 0, draws: [], blobs: [] });
    this.options = { context, blob, drawError, blobError };
  }
  getContext() {
    if (!this.options.context) return null;
    return { drawImage: (...args) => { if (this.options.drawError) throw this.options.drawError; this.draws.push(args); } };
  }
  toBlob(callback, type, quality) {
    this.blobs.push({ type, quality });
    if (this.options.blobError) throw this.options.blobError;
    callback(this.options.blob === null ? null : new Blob([this.options.blob], { type }));
  }
}

const securityError = () => Object.assign(new Error("Tainted canvases may not be exported."), { name: "SecurityError" });
const codeOf = (promise) => promise.then(() => "resolved", (error) => error.code);

test("1. the moments: a quarter in, kept to a tenth, never past the video, as the coach reads them; the file name; the origin and its sentence", () => {
  assert.equal(thumb.automaticThumbnailTime(40), 10);
  assert.equal(thumb.automaticThumbnailTime(7.33), 1.8);
  assert.equal(thumb.automaticThumbnailTime(Infinity), 0);
  assert.equal(thumb.automaticThumbnailTime(0), 0);
  assert.equal(thumb.automaticThumbnailTime("nonsense"), 0);
  assert.equal(thumb.lastFrameTime(40), 39.9);
  assert.equal(thumb.lastFrameTime(0.05), 0);
  assert.equal(thumb.lastFrameTime(Infinity), 0);
  assert.equal(thumb.roundFrameTime(-1), 0);
  assert.equal(thumb.roundFrameTime(12.46), 12.5);
  assert.equal(thumb.roundFrameTime("x"), 0);
  assert.equal(thumb.formatFrameTime(7), "0:07");
  assert.equal(thumb.formatFrameTime(65), "1:05");
  assert.equal(thumb.formatFrameTime(12.5), "0:12.5");
  assert.equal(thumb.formatFrameTime(0), "0:00");
  assert.equal(thumb.formatFrameTime(59.96), "1:00");
  assert.equal(thumb.frameFileName("Squat Jump.mp4", 12.5), "Squat-Jump-frame-12_5s.jpg");
  assert.equal(thumb.frameFileName("", 0), "video-frame-0s.jpg");
  assert.equal(thumb.frameFileName("čć.webm", 3), "video-frame-3s.jpg", "a name with nothing safe in it falls back");
  assert.deepEqual(thumb.frameOrigin({ purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 12.46 }), { purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 12.5, automatic: false });
  assert.equal(thumb.frameOrigin({ purpose: "automatic_thumbnail", sourceMediaId: "vid-1", frameTimeSeconds: 10 }).automatic, true);
  assert.equal(thumb.frameOrigin({ purpose: "exercise_image", sourceMediaId: "vid-1" }), null);
  assert.equal(thumb.frameOrigin({ purpose: "video_frame", sourceMediaId: "" }), null);
  assert.equal(thumb.frameOrigin(), null);
  assert.equal(thumb.describeFrameOrigin(thumb.frameOrigin({ purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 22.3 })), "Frame of the video at 0:22.3.");
  assert.equal(thumb.describeFrameOrigin(thumb.frameOrigin({ purpose: "automatic_thumbnail", sourceMediaId: "vid-1", frameTimeSeconds: 10 })), "Thumbnail made from the video at 0:10, a quarter in. Choose another frame or upload a picture to change it.");
  assert.equal(thumb.describeFrameOrigin(null), "");
  assert.deepEqual([...thumb.FRAME_PURPOSES], ["video_frame", "automatic_thumbnail"]);
});

test("2. the capture: the video opened detached and muted, the seek to the moment, the frame drawn scaled to 1280 wide, a JPEG File with the name, the video released; the clamp, an unknown duration, a small video, a late frame", async () => {
  const video = new FakeVideo();
  const canvas = new FakeCanvas();
  const result = await thumb.captureVideoFrame("blob:clip", 12.5, { createVideo: () => video, createCanvas: () => canvas, fileName: "clip-frame-12_5s.jpg" });
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, "auto");
  assert.equal(video.crossOrigin, undefined, "a local file needs no CORS");
  assert.equal(video.src, "", "released: the address removed");
  assert.equal(video.released, 1);
  assert.deepEqual(video.seeks, [12.5]);
  assert.deepEqual([canvas.width, canvas.height], [1280, 720]);
  assert.deepEqual(canvas.draws[0].slice(1), [0, 0, 1280, 720]);
  assert.deepEqual(canvas.blobs, [{ type: "image/jpeg", quality: 0.85 }]);
  assert.equal(result.file.name, "clip-frame-12_5s.jpg");
  assert.equal(result.file.type, "image/jpeg");
  assert.ok(result.file.size > 0);
  assert.deepEqual([result.timeSeconds, result.width, result.height], [12.5, 1280, 720]);
  // A moment past the end lands a tenth before it, and the name says the moment actually captured.
  const late = new FakeVideo({ duration: 40 });
  const clamped = await thumb.captureVideoFrame("blob:clip", 99, { createVideo: () => late, createCanvas: () => new FakeCanvas(), videoName: "Squat Jump.mp4" });
  assert.deepEqual(late.seeks, [39.9]);
  assert.equal(clamped.timeSeconds, 39.9);
  assert.equal(clamped.file.name, "Squat-Jump-frame-39_9s.jpg");
  // An unknown duration seeks to the asked moment; a small video is not scaled up.
  const endless = new FakeVideo({ duration: Infinity, width: 640, height: 360 });
  const small = new FakeCanvas();
  const named = await thumb.captureVideoFrame("blob:clip", 3, { createVideo: () => endless, createCanvas: () => small });
  assert.deepEqual(endless.seeks, [3]);
  assert.deepEqual([small.width, small.height], [640, 360]);
  assert.equal(named.file.name, "video-frame-3s.jpg", "a name when none was given");
  // The stored file: CORS asked for.
  const stored = new FakeVideo();
  await thumb.captureVideoFrame("https://r2.example/v?sig=1", 1, { createVideo: () => stored, createCanvas: () => new FakeCanvas(), crossOrigin: "anonymous" });
  assert.equal(stored.crossOrigin, "anonymous");
  // A browser that reports the seek before the frame is decoded: the capture waits for the data.
  const slow = new FakeVideo({ readyState: 1 });
  const slowCanvas = new FakeCanvas();
  await thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => slow, createCanvas: () => slowCanvas });
  assert.equal(slow.readyState, 2);
  assert.equal(slowCanvas.draws.length, 1);
  // The metadata alone.
  const meta = new FakeVideo({ duration: 12.25, width: 1280, height: 720 });
  assert.deepEqual(await thumb.readVideoMetadata("blob:clip", { createVideo: () => meta }), { durationSeconds: 12.25, width: 1280, height: 720 });
  assert.equal(meta.released, 1);
});

test("3. every refusal has its code and sentence, and the video is released: no canvas, no video, no address, an unreadable source, a flat one, a silent one and a stuck seek (timeout), a tainted canvas, a failed draw, an empty blob", async () => {
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => new FakeVideo(), createCanvas: () => new FakeCanvas({ context: false }) })), "frame_capture_unsupported");
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => new FakeVideo(), createCanvas: () => null })), "frame_capture_unsupported");
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => null, createCanvas: () => new FakeCanvas() })), "frame_capture_unsupported");
  assert.equal(await codeOf(thumb.captureVideoFrame("", 1, { createVideo: () => new FakeVideo(), createCanvas: () => new FakeCanvas() })), "frame_source_unavailable");
  const broken = new FakeVideo({ fail: true });
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => broken, createCanvas: () => new FakeCanvas() })), "frame_source_unreadable");
  assert.equal(broken.released, 1);
  const flat = new FakeVideo({ width: 0, height: 0 });
  assert.equal(await codeOf(thumb.readVideoMetadata("blob:clip", { createVideo: () => flat })), "frame_source_unreadable");
  assert.equal(flat.released, 1);
  const silent = new FakeVideo({ silent: true });
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => silent, createCanvas: () => new FakeCanvas(), bound: 20 })), "frame_capture_timeout");
  assert.equal(silent.released, 1);
  const stuck = new FakeVideo({ seekSilent: true });
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => stuck, createCanvas: () => new FakeCanvas(), bound: 20 })), "frame_capture_timeout");
  assert.equal(stuck.released, 1);
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => new FakeVideo(), createCanvas: () => new FakeCanvas({ drawError: securityError() }) })), "frame_source_cross_origin");
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => new FakeVideo(), createCanvas: () => new FakeCanvas({ blobError: securityError() }) })), "frame_source_cross_origin");
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => new FakeVideo(), createCanvas: () => new FakeCanvas({ drawError: new Error("boom") }) })), "frame_capture_failed");
  const empty = new FakeVideo();
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 1, { createVideo: () => empty, createCanvas: () => new FakeCanvas({ blob: null }) })), "frame_capture_failed");
  assert.equal(empty.released, 1);
  for (const code of thumb.FRAME_ERROR_CODES) assert.ok(thumb.describeFrameError(code).length > 20, code);
  assert.equal(thumb.describeFrameError("whatever"), thumb.describeFrameError("frame_capture_failed"));
  assert.equal(thumb.describeFrameError("frame_source_cross_origin"), "The storage does not let this app read frames of the stored video. Upload a picture instead.");
});

test("4. the picker's markup: the video at the moment with its own controls, the slider bounded a tenth before the end, the stored file's crossorigin, the busy and failed faces; nothing while closed", () => {
  assert.equal(thumb.renderFramePickerHtml(null), "");
  assert.equal(thumb.renderFramePickerHtml({ open: false }), "");
  assert.match(thumb.renderFramePickerHtml({ open: true, loading: true }), /Opening the video\.\.\./);
  const html = thumb.renderFramePickerHtml({ open: true, loading: false, src: "https://r2.example/v?sig=1&x=2", crossOrigin: "anonymous", durationSeconds: 40, timeSeconds: 10 });
  assert.match(html, /<video class="exercise-media-frame-video" data-exercise-media-frame-video="image" controls muted playsinline preload="auto" crossorigin="anonymous" src="https:\/\/r2\.example\/v\?sig=1&amp;x=2#t=10"><\/video>/);
  assert.match(html, /<input type="range" min="0" max="39.9" step="0.1" value="10" data-exercise-media-frame-time="image" aria-label="Moment of the video">/);
  assert.match(html, /Moment: <output data-exercise-media-frame-label="image">0:10<\/output> of 0:40/);
  assert.match(html, /data-action="exercise-media-frame-use" data-slot="image">Use this frame</);
  assert.match(html, /data-action="exercise-media-frame-cancel" data-slot="image">Cancel</);
  const local = thumb.renderFramePickerHtml({ open: true, src: "blob:clip", durationSeconds: 40, timeSeconds: 55 });
  assert.match(local, /src="blob:clip#t=39.9"/, "a moment past the end is clamped");
  assert.doesNotMatch(local, /crossorigin/);
  const busy = thumb.renderFramePickerHtml({ open: true, src: "blob:clip", durationSeconds: 40, timeSeconds: 10, busy: true });
  assert.match(busy, /data-slot="image" disabled>Taking the frame\.\.\.</);
  assert.match(busy, /exercise-media-frame-cancel" data-slot="image" disabled>Cancel</);
  const failed = thumb.renderFramePickerHtml({ open: true, src: "", error: "The stored video could not be opened for a frame." });
  assert.doesNotMatch(failed, /<video|range|frame-use/);
  assert.match(failed, /role="alert">The stored video could not be opened for a frame\.</);
  assert.match(failed, />Close</);
  const endless = thumb.renderFramePickerHtml({ open: true, src: "blob:clip", durationSeconds: 0, timeSeconds: 0 });
  assert.match(endless, /max="0" step="0.1" value="0"[^>]* disabled>/);
  assert.doesNotMatch(endless, / of 0:00/);
});

test("5. the transport sends a frame's two extra facts top level on the initiation, a plain picture never, and refuses a frame without them before any request", async () => {
  upload.setUploadTransportEnabled(true);
  const calls = [];
  const media = { source: "asset", mediaId: "img-1", kind: "image", status: "ready", mimeType: "image/jpeg", sizeBytes: "3", metadata: { width: 1280, height: 720, origin: "frame", sourceVideoMediaId: "vid-1", frameTimeSeconds: 12.5 } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 201, json: async () => ({ uploadId: "up-9", mediaId: "img-1", status: "completed", expiresAt: new Date(Date.now() + 600000).toISOString(), errorCode: null, media }) };
  };
  const frame = { name: "clip-frame-12_5s.jpg", size: 3, type: "image/jpeg" };
  const edit = { type: "exercise_edit", exerciseId: "e1" };
  const result = await upload.startUpload({ file: frame, slot: "image", context: edit, purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 12.5 });
  assert.equal(result.mediaId, "img-1");
  assert.equal(result.media.metadata.origin, "frame");
  assert.equal(calls[0].url, upload.UPLOADS_ROUTE);
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.ok(calls[0].headers["Idempotency-Key"]);
  assert.deepEqual(calls[0].body, { context: edit, kind: "image", purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 12.5, file: { name: "clip-frame-12_5s.jpg", mimeType: "image/jpeg", sizeBytes: "3" } });
  await upload.startUpload({ file: frame, slot: "image", context: { type: "exercise_create" }, purpose: "automatic_thumbnail", sourceMediaId: "vid-1", frameTimeSeconds: 0 });
  assert.equal(calls[1].body.purpose, "automatic_thumbnail");
  assert.equal(calls[1].body.frameTimeSeconds, 0, "a moment of 0 is a moment");
  assert.deepEqual(calls[1].body.context, { type: "exercise_create" });
  // A plain picture never carries them, even when a caller passes them.
  await upload.startUpload({ file: frame, slot: "image", context: edit, sourceMediaId: "vid-1", frameTimeSeconds: 1 });
  assert.equal(calls[2].body.purpose, "exercise_image");
  assert.equal("sourceMediaId" in calls[2].body, false);
  assert.equal("frameTimeSeconds" in calls[2].body, false);
  // Refusals, before any request: the wrong slot, no video, no moment, a negative or unreadable one.
  const refused = (request) => codeOf(upload.startUpload(request));
  const before = calls.length;
  assert.equal(await refused({ file: frame, slot: "video", context: edit, purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 1 }), "invalid_request");
  assert.equal(await refused({ file: frame, slot: "image", context: edit, purpose: "video_frame", frameTimeSeconds: 1 }), "invalid_request");
  assert.equal(await refused({ file: frame, slot: "image", context: edit, purpose: "video_frame", sourceMediaId: "vid-1" }), "invalid_request");
  assert.equal(await refused({ file: frame, slot: "image", context: edit, purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: -1 }), "invalid_request");
  assert.equal(await refused({ file: frame, slot: "image", context: edit, purpose: "automatic_thumbnail", sourceMediaId: "vid-1", frameTimeSeconds: "soon" }), "invalid_request");
  assert.equal(calls.length, before, "nothing was sent");
  upload.setUploadTransportEnabled(false);
  assert.equal(await refused({ file: frame, slot: "image", context: edit, purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 1 }), "upload_transport_disabled");
  assert.equal(calls.length, before, "the guard first");
});

// A <video> on a page that, like iOS Safari, loads nothing before it has
// played: a seek is acknowledged but no frame comes until play() was called
// (or play() is refused, as in Low Power Mode, or never answers).
class PhoneVideo {
  constructor({ play = "allowed", time = 0, width = 1920, height = 1080 } = {}) {
    Object.assign(this, { readyState: 1, videoWidth: width, videoHeight: height, duration: 40, dataset: {}, listeners: {}, seeks: [], plays: 0, pauses: 0, played: false, _time: time });
    this.mode = play;
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((entry) => entry !== fn); }
  emit(name) { for (const fn of [...(this.listeners[name] || [])]) fn({ target: this }); }
  set currentTime(value) {
    this._time = value;
    this.seeks.push(value);
    setTimeout(() => {
      if (this.played) this.readyState = 2;
      this.emit("seeked");
      if (this.played) this.emit("loadeddata");
    }, 0);
  }
  get currentTime() { return this._time; }
  play() {
    this.plays += 1;
    if (this.mode === "refused") return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }));
    if (this.mode === "silent") return new Promise(() => {});
    this.played = true;
    return Promise.resolve();
  }
  pause() { this.pauses += 1; }
  removeAttribute(name) { if (name === "src") this._src = ""; }
  load() {}
  set src(value) {
    this._src = value;
    if (!value) return;
    setTimeout(() => { this.emit("loadedmetadata"); }, 0);
  }
  get src() { return this._src; }
}

test("6. a phone that draws nothing before playback (iOS Safari): the picker's video is woken by a muted start, paused at once, and then shows the moment; a refused or silent start asks for a tap; a browser that draws by itself is never started; the frame the coach sees is taken from that video; the detached capture wakes its video too", async () => {
  // Android / desktop: the moment is drawn by itself - never started.
  const android = new PhoneVideo();
  android.readyState = 2;
  assert.equal(await thumb.showFrameAt(android, 12.34, { waitMs: 20 }), "shown");
  assert.deepEqual([android.seeks, android.plays], [[12.3], 0]);
  // A browser that draws after the seek (the data arrives a moment later): still never started.
  const late = new PhoneVideo();
  late.played = true; // it loads by itself
  assert.equal(await thumb.showFrameAt(late, 3, { waitMs: 200 }), "shown");
  assert.equal(late.plays, 0);
  // iOS: nothing until a muted start; then the moment shows; the start is paused at once and tried once per video.
  const iphone = new PhoneVideo();
  assert.equal(await thumb.showFrameAt(iphone, 10, { waitMs: 20 }), "woken");
  assert.equal(iphone.plays, 1);
  assert.ok(iphone.pauses >= 1, "paused at once");
  assert.equal(iphone.muted, true);
  assert.equal(iphone.playsInline, true);
  assert.equal(iphone.readyState, 2);
  assert.deepEqual(iphone.seeks, [10, 10], "the moment asked for again after the start");
  assert.equal(await thumb.showFrameAt(iphone, 22.3, { waitMs: 20 }), "shown");
  assert.equal(iphone.plays, 1, "not started again");
  // Low Power Mode: the start is refused - the coach is asked to tap play; not tried twice.
  const lowPower = new PhoneVideo({ play: "refused" });
  assert.equal(await thumb.showFrameAt(lowPower, 10, { waitMs: 20 }), "tap");
  assert.equal(await thumb.showFrameAt(lowPower, 11, { waitMs: 20 }), "tap");
  assert.equal(lowPower.plays, 1);
  // A start that never answers is bounded.
  const silent = new PhoneVideo({ play: "silent" });
  const started = Date.now();
  assert.equal(await thumb.showFrameAt(silent, 10, { waitMs: 20 }), "tap");
  assert.ok(Date.now() - started < 1000);
  assert.equal(await thumb.showFrameAt(null, 1), "tap", "no video: nothing to show");

  // The frame the coach sees: drawn from the page's video at once (before the call returns), as a JPEG named for its moment.
  const shown = new PhoneVideo({ time: 22.34 });
  shown.readyState = 2;
  const canvas = new FakeCanvas();
  const pending = thumb.captureFrameFromElement(shown, { createCanvas: () => canvas, videoName: "Squat Jump.mp4" });
  assert.equal(canvas.draws.length, 1, "drawn before the call returns");
  assert.equal(canvas.draws[0][0], shown);
  const frame = await pending;
  assert.deepEqual([frame.timeSeconds, frame.width, frame.height, frame.file.name, frame.file.type], [22.3, 1280, 720, "Squat-Jump-frame-22_3s.jpg", "image/jpeg"]);
  // No picture yet, a tainted canvas, no canvas: refused with their codes.
  assert.equal(await codeOf(thumb.captureFrameFromElement(new PhoneVideo(), { createCanvas: () => new FakeCanvas() })), "frame_capture_failed");
  assert.equal(await codeOf(thumb.captureFrameFromElement(shown, { createCanvas: () => new FakeCanvas({ drawError: securityError() }) })), "frame_source_cross_origin");
  assert.equal(await codeOf(thumb.captureFrameFromElement(shown, { createCanvas: () => null })), "frame_capture_unsupported");

  // The detached capture (the automatic thumbnail, or a moment not shown yet) on iOS: woken, then drawn.
  const detached = new PhoneVideo();
  const detachedCanvas = new FakeCanvas();
  const captured = await thumb.captureVideoFrame("blob:clip", 7, { createVideo: () => detached, createCanvas: () => detachedCanvas, wakeAfterMs: 20 });
  assert.equal(detached.plays, 1);
  assert.deepEqual(detached.seeks, [7, 7]);
  assert.equal(detachedCanvas.draws.length, 1);
  assert.equal(captured.timeSeconds, 7);
  // Refused there too: it waits for data as before and ends in the timeout sentence, not a dark picture.
  const refused = new PhoneVideo({ play: "refused" });
  assert.equal(await codeOf(thumb.captureVideoFrame("blob:clip", 7, { createVideo: () => refused, createCanvas: () => new FakeCanvas(), wakeAfterMs: 20, bound: 60 })), "frame_capture_timeout");

  // The picker's markup: the status region is always there (a screen reader reads a change of its text), empty until the video cannot show the moment.
  const open = { open: true, loading: false, src: "blob:clip", durationSeconds: 40, timeSeconds: 10 };
  const quiet = thumb.renderFramePickerHtml(open);
  assert.match(quiet, /role="status" data-exercise-media-frame-hint="image"><\/p>/);
  assert.doesNotMatch(quiet, /frame-hint="image" hidden/);
  assert.match(thumb.renderFramePickerHtml({ ...open, needsTap: true }), /data-exercise-media-frame-hint="image">If the video stays dark, tap play on it once, then move to the moment\.<\/p>/);
  assert.equal(thumb.FRAME_TAP_HINT, "If the video stays dark, tap play on it once, then move to the moment.");
  assert.doesNotMatch(thumb.renderFramePickerHtml({ ...open, src: "" }), /frame-hint/, "no sentence without a video");
});

test("6b. a slide while the video is being started wins: the late start seeks to the latest moment, never back to the older one; a browser already fetching is given longer and is not started when its data comes", async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // iOS: the start answers only when released by hand.
  const v = new PhoneVideo();
  let releasePlay = null;
  v.play = function () { this.plays += 1; return new Promise((resolve) => { releasePlay = () => { this.played = true; resolve(); }; }); };
  const opening = thumb.showFrameAt(v, 10, { waitMs: 300 });
  await sleep(80); // the seek was acknowledged without a picture: waiting on the start now (bounded at 300 ms)
  assert.equal(v.plays, 1);
  const slide = thumb.showFrameAt(v, 22, { waitMs: 300 });
  await sleep(20);
  releasePlay(); // the start answers late, after the slide
  assert.equal(await opening, "woken");
  await Promise.all([opening, slide]);
  await sleep(10);
  assert.equal(v.currentTime, 22, "the latest moment, not the opening one");
  assert.equal(v.seeks.at(-1), 22);
  // Android on a slow network: fetching (networkState 2), the picture comes after 50 ms - more than one wait, less than the longer one.
  const slow = new PhoneVideo();
  slow.networkState = 2;
  setTimeout(() => { slow.played = true; slow.readyState = 2; slow.emit("loadeddata"); }, 50);
  assert.equal(await thumb.showFrameAt(slow, 5, { waitMs: 20 }), "shown");
  assert.equal(slow.plays, 0, "not started");
});
