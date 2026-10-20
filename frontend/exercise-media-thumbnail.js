import { FRAME_PURPOSES } from "./exercise-media-upload.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// ---------------------------------------------------------------------------
// Exercise media thumbnails (PR 3): a frame of the exercise's R2 video as its
// picture - chosen by the coach over the video, or made automatically a
// quarter into the video after a video upload that left the picture empty.
//
// Browser only: a detached HTML5 <video> seeks to the moment and a <canvas>
// draws it (owner decision 2026-10-19: no transcoding, nothing server-side).
// R2 only: a Google Drive or YouTube link has no frame the browser may read.
// The frame is uploaded through the FE-2 transport like any picture, with the
// contract's purposes (docs/backend/r2-upload-api-v1.md Q1): `video_frame`
// or `automatic_thumbnail`, both with the top-level `sourceMediaId` of the
// ready R2 video and a finite, non-negative `frameTimeSeconds`. The editor
// offers a frame only where the picture can be saved (BE-3, the
// MEDIA_SAVE_ENABLED guard) and uploads are offered (the transport guard).
//
// A stored video (an exercise that already has an R2 file) is read through
// its signed playback address with `crossorigin="anonymous"`: the bucket's
// CORS must allow GET from the app origin, or the canvas is tainted and the
// frame cannot be read (`frame_source_cross_origin`) - an activation gate,
// not a code path that guesses.
// ---------------------------------------------------------------------------

export { FRAME_PURPOSES };
export const FRAME_MIME_TYPE = "image/jpeg";
export const FRAME_QUALITY = 0.85;
export const FRAME_MAX_WIDTH = 1280;
export const FRAME_CAPTURE_BOUND_MS = 15_000;
// The automatic thumbnail gives up sooner - the whole attempt, not each of its
// steps: nothing waits for it (the coach may choose a frame at once), and a
// device that cannot make it should not keep "Making a thumbnail from the
// video..." on screen.
export const AUTOMATIC_THUMBNAIL_BOUND_MS = 6_000;
export const AUTOMATIC_THUMBNAIL_FRACTION = 0.25;
// A seek to the very end often gives a black frame: the last moment offered is this much earlier.
export const FRAME_END_MARGIN_SECONDS = 0.1;
// How long a video may take to show a moment by itself before it is woken
// (a muted start, paused at once - see wakeVideo).
export const FRAME_PREVIEW_WAIT_MS = 700;
// The picker's one sentence when a video stays dark (the browser refused even a muted start).
export const FRAME_TAP_HINT = "If the video stays dark, tap play on it once, then move to the moment.";

const FRAME_ERRORS = Object.freeze({
  frame_capture_unsupported: "This browser cannot take a frame from a video. Upload a picture instead.",
  frame_source_unreadable: "The video could not be read for a frame. Upload a picture instead.",
  frame_source_unavailable: "The stored video could not be opened for a frame. Try again later, or upload a picture.",
  frame_source_cross_origin: "The storage does not let this app read frames of the stored video. Upload a picture instead.",
  frame_capture_timeout: "Reading the video for a frame took too long. Try again, or upload a picture.",
  frame_capture_failed: "The frame could not be made. Try another moment, or upload a picture.",
});

export const FRAME_ERROR_CODES = Object.freeze(Object.keys(FRAME_ERRORS));

export function describeFrameError(code) {
  return FRAME_ERRORS[code] || FRAME_ERRORS.frame_capture_failed;
}

function frameError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Moments are kept to a tenth of a second: finite, never negative.
export function roundFrameTime(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 10) / 10;
}

// The automatic thumbnail's moment: a quarter into the video; 0 when the
// duration is unknown (a live or unfinished WebM reports Infinity).
export function automaticThumbnailTime(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return roundFrameTime(duration * AUTOMATIC_THUMBNAIL_FRACTION);
}

// The last moment a picker may offer for a duration.
export function lastFrameTime(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return roundFrameTime(Math.max(0, duration - FRAME_END_MARGIN_SECONDS));
}

// "0:07", "1:05", "0:12.5" - the moment as the coach reads it.
export function formatFrameTime(seconds) {
  const total = roundFrameTime(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const whole = Math.floor(rest);
  const tenth = Math.round((rest - whole) * 10) % 10;
  return `${minutes}:${whole < 10 ? "0" : ""}${whole}${tenth ? `.${tenth}` : ""}`;
}

// "squat-frame-12_5s.jpg" from "squat.mp4" at 12.5 s.
export function frameFileName(videoName, timeSeconds) {
  const base = String(videoName || "video").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video";
  return `${base}-frame-${String(roundFrameTime(timeSeconds)).replace(".", "_")}s.jpg`;
}

// The provenance an image field carries while a frame is uploaded and after:
// the purpose, the ready R2 video it came from and the moment. Null for a
// picture that is not a frame.
export function frameOrigin({ purpose, sourceMediaId, frameTimeSeconds } = {}) {
  if (!FRAME_PURPOSES.includes(purpose) || !sourceMediaId) return null;
  return { purpose, sourceMediaId: String(sourceMediaId), frameTimeSeconds: roundFrameTime(frameTimeSeconds), automatic: purpose === "automatic_thumbnail" };
}

export function describeFrameOrigin(origin) {
  if (!origin || !FRAME_PURPOSES.includes(origin.purpose)) return "";
  const moment = formatFrameTime(origin.frameTimeSeconds);
  return origin.purpose === "automatic_thumbnail"
    ? `Thumbnail made from the video at ${moment}, a quarter in. Choose another frame or upload a picture to change it.`
    : `Frame of the video at ${moment}.`;
}

// ---- Capture ---------------------------------------------------------------

// The capture video is put in the page, out of sight: iOS Safari loads and
// draws no frame for a <video> that is not in the document (on an iPhone the
// automatic thumbnail waited for its whole bound, then failed). 2 px, almost
// transparent, behind everything, never focused or read out; removed again
// when the capture is done (release).
export function createCaptureVideo(doc = globalThis.document) {
  const video = doc?.createElement?.("video") || null;
  if (!video) return null;
  video.setAttribute?.("aria-hidden", "true");
  video.setAttribute?.("tabindex", "-1");
  video.setAttribute?.("data-exercise-media-capture-video", "");
  Object.assign(video.style || {}, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none", zIndex: "-1" });
  (doc.body || doc.documentElement)?.appendChild?.(video);
  return video;
}

const defaultCreateVideo = () => createCaptureVideo();
const defaultCreateCanvas = () => globalThis.document?.createElement?.("canvas") || null;

// A promise bounded in time; the timer never keeps a process alive.
function withBound(promise, bound, code, onTimeout) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(frameError(code));
    }, bound);
    timer?.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function awaitEvent(target, successEvents, failureEvents, code) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const name of successEvents) target.removeEventListener(name, done);
      for (const name of failureEvents) target.removeEventListener(name, failed);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = (event) => { cleanup(); reject(frameError(code, event?.target?.error || event)); };
    for (const name of successEvents) target.addEventListener(name, done);
    for (const name of failureEvents) target.addEventListener(name, failed);
  });
}

// iOS Safari loads no media data for a video that has never played: preload
// is ignored, so a seek alone draws nothing and the video stays dark (Android
// and desktop browsers load and draw at once). It also refuses a blob:
// address that carries a `#t=` fragment altogether - the video fails to load
// (the crossed-out play icon, found in the pilot) - so the picker's address
// has no fragment and the moment is asked of the video instead. A muted, inline video may be started
// without a tap on iOS, and starting it - paused at once - makes it load.
// Only done when the picture is still missing after a short wait.
const HAVE_CURRENT_DATA = 2;
const NETWORK_LOADING = 2;
const hasPicture = (video) => Number(video?.readyState) >= HAVE_CURRENT_DATA;
// The moment last asked of each video: a start that ends late seeks to it, never to an older one.
const wantedTimes = new WeakMap();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
  });
}

// Resolves after one of `events` (or an error of the target) or after `ms`, whichever comes first; never rejects.
function eventOrDelay(target, someEvents, ms) {
  const events = [...someEvents, "error"];
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      for (const name of events) target.removeEventListener?.(name, done);
      resolve();
    };
    for (const name of events) target.addEventListener?.(name, done);
    timer = setTimeout(done, ms);
    timer?.unref?.();
  });
}

// Resolves once the video has a picture or after `ms`, whichever comes first; never rejects.
function pictureOrDelay(video, ms) {
  return new Promise((resolve) => {
    const events = ["loadeddata", "seeked", "canplay", "progress", "error"];
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      for (const name of events) video.removeEventListener?.(name, check);
      resolve();
    };
    function check() { if (hasPicture(video) || video.error) done(); }
    for (const name of events) video.addEventListener?.(name, check);
    timer = setTimeout(done, ms);
    timer?.unref?.();
  });
}

// Starts the video muted and inline and pauses it at once. Resolves to true
// when the browser allowed the start (iOS refuses it in Low Power Mode);
// never throws; bounded by `ms`.
async function wakeVideo(video, ms) {
  try {
    video.muted = true;
    video.playsInline = true;
    const started = video.play?.();
    if (started && typeof started.then === "function") {
      // A start that comes late is paused as well.
      const allowed = started.then(() => { try { video.pause?.(); } catch { /* gone */ } return true; }, () => false);
      return await Promise.race([allowed, delay(ms).then(() => false)]);
    }
    video.pause?.();
    return true;
  } catch {
    return false;
  }
}

// Shows `timeSeconds` in a video on the page (the picker's own). Resolves to
// "shown" (the browser drew it by itself), "woken" (drawn after the muted
// start), "tap" (still no picture: the browser refused even a muted start,
// as iOS does in Low Power Mode, so the coach taps play once) or "error"
// (the browser cannot read the video at all: no start, no tap helps). The
// muted start is tried once per video element. Never rejects.
export async function showFrameAt(video, timeSeconds, { waitMs = FRAME_PREVIEW_WAIT_MS } = {}) {
  if (!video) return "tap";
  const failed = () => Boolean(video.error);
  if (failed()) return "error";
  wantedTimes.set(video, roundFrameTime(timeSeconds));
  const seek = () => { try { video.currentTime = wantedTimes.get(video); } catch { /* no metadata yet */ } };
  seek();
  if (hasPicture(video)) return "shown";
  // A browser already fetching (Android on a slow network) is given longer, until the picture comes, before it is started.
  if (Number(video.networkState) === NETWORK_LOADING) await pictureOrDelay(video, waitMs * 4);
  else await eventOrDelay(video, ["loadeddata", "seeked", "canplay"], waitMs);
  if (failed()) return "error";
  if (hasPicture(video)) return "shown";
  if (video.dataset?.frameWoken === "1") return "tap";
  if (video.dataset) video.dataset.frameWoken = "1";
  if (!(await wakeVideo(video, waitMs))) return failed() ? "error" : "tap";
  seek();
  if (!hasPicture(video)) await eventOrDelay(video, ["loadeddata", "seeked", "canplay"], waitMs);
  if (failed()) return "error";
  return hasPicture(video) ? "woken" : "tap";
}

function release(video) {
  try {
    video.removeAttribute?.("src");
    if (typeof video.load === "function") video.load();
  } catch { /* already released */ }
  try { video.remove?.(); } catch { /* not in a page */ }
}

const isSecurityError = (error) => error?.name === "SecurityError" || /tainted|cross-origin|insecure/i.test(String(error?.message || ""));

// Opens the address in a detached <video> and waits for its metadata.
async function openVideo(src, { createVideo, crossOrigin, bound }) {
  if (!src) throw frameError("frame_source_unavailable");
  const video = createVideo();
  if (!video || typeof video.addEventListener !== "function") throw frameError("frame_capture_unsupported");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  if (crossOrigin) video.crossOrigin = crossOrigin;
  const loaded = awaitEvent(video, ["loadedmetadata"], ["error", "abort"], "frame_source_unreadable");
  video.src = src;
  try {
    await withBound(loaded, bound, "frame_capture_timeout");
  } catch (error) {
    release(video);
    throw error;
  }
  const width = Number(video.videoWidth) || 0;
  const height = Number(video.videoHeight) || 0;
  if (!width || !height) {
    release(video);
    throw frameError("frame_source_unreadable");
  }
  const duration = Number(video.duration);
  return { video, durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0, width, height };
}

// An attempt its caller may stop at any moment (a deadline, the coach taking
// over): on a stop it rejects at once - with the code the stop's reason
// carries, else frame_capture_timeout - and its video is released (it stops
// loading and leaves the page) without waiting for a pending step.
const stopCode = (signal) => (FRAME_ERROR_CODES.includes(signal?.reason?.code) ? signal.reason.code : "frame_capture_timeout");

async function stoppable(signal, createVideo, run) {
  if (signal?.aborted) throw frameError(stopCode(signal));
  let video = null;
  const tracked = () => (video = createVideo());
  const check = () => { if (signal?.aborted) throw frameError(stopCode(signal)); };
  const work = run(tracked, check);
  if (!signal) return work;
  work.catch(() => { /* settled through the race below */ });
  let onStop = null;
  const stopped = new Promise((_, reject) => {
    onStop = () => {
      if (video) release(video);
      reject(frameError(stopCode(signal)));
    };
    signal.addEventListener("abort", onStop, { once: true });
  });
  stopped.catch(() => { /* settled through the race below */ });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", onStop);
  }
}

// The duration and size of a video at an address (an object URL of a chosen
// file, or a signed playback address). Nothing is drawn.
export async function readVideoMetadata(src, { createVideo = defaultCreateVideo, crossOrigin = "", bound = FRAME_CAPTURE_BOUND_MS, signal = null } = {}) {
  return stoppable(signal, createVideo, async (tracked, check) => {
    const opened = await openVideo(src, { createVideo: tracked, crossOrigin, bound });
    release(opened.video);
    check();
    return { durationSeconds: opened.durationSeconds, width: opened.width, height: opened.height };
  });
}

// One frame of the video at `timeSeconds` (clamped to the video) as a JPEG
// File, scaled to at most `maxWidth` wide and named after `videoName` and the
// moment actually captured (`fileName` overrides). Throws an error whose
// `code` is one of FRAME_ERROR_CODES. `createVideo` / `createCanvas` exist
// for tests.
export async function captureVideoFrame(src, timeSeconds, {
  createVideo = defaultCreateVideo, createCanvas = defaultCreateCanvas, crossOrigin = "", bound = FRAME_CAPTURE_BOUND_MS,
  mimeType = FRAME_MIME_TYPE, quality = FRAME_QUALITY, maxWidth = FRAME_MAX_WIDTH, videoName = "video", fileName = "",
  wakeAfterMs = FRAME_PREVIEW_WAIT_MS, signal = null,
} = {}) {
  const canvas = createCanvas();
  const context = canvas?.getContext?.("2d") || null;
  if (!context || typeof canvas.toBlob !== "function") throw frameError("frame_capture_unsupported");
  return stoppable(signal, createVideo, async (tracked, check) => {
    const { video, durationSeconds, width, height } = await openVideo(src, { createVideo: tracked, crossOrigin, bound });
    try {
      check();
      const wanted = roundFrameTime(timeSeconds);
      const target = durationSeconds > 0 ? Math.min(wanted, lastFrameTime(durationSeconds)) : wanted;
      const seeked = awaitEvent(video, ["seeked"], ["error"], "frame_source_unreadable");
      video.currentTime = target;
      await withBound(seeked, bound, "frame_capture_timeout");
      check();
      // Some browsers report the seek before the frame is decoded: wait for data if it is not there yet.
      if (!hasPicture(video)) {
        const data = awaitEvent(video, ["loadeddata", "canplay"], ["error"], "frame_source_unreadable");
        data.catch(() => { /* awaited below when still needed */ });
        await Promise.race([data.catch(() => {}), delay(wakeAfterMs)]);
        check();
        // Still nothing (iOS Safari loads nothing before playback): a muted start, paused at once, then the seek again.
        if (!hasPicture(video) && (await wakeVideo(video, wakeAfterMs))) {
          check();
          const again = awaitEvent(video, ["seeked"], ["error"], "frame_source_unreadable");
          video.currentTime = target;
          await withBound(again, bound, "frame_capture_timeout");
          check();
        }
        if (!hasPicture(video)) await withBound(data, bound, "frame_capture_timeout");
        check();
      }
      const actual = Number.isFinite(Number(video.currentTime)) ? Number(video.currentTime) : target;
      drawScaled(context, canvas, video, width, height, maxWidth);
      return await encodeFrame(canvas, { mimeType, quality, bound, name: fileName || frameFileName(videoName, actual), timeSeconds: actual });
    } finally {
      release(video);
    }
  });
}

function drawScaled(context, canvas, video, width, height, maxWidth) {
  const scale = width > maxWidth ? maxWidth / width : 1;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch (error) {
    throw frameError(isSecurityError(error) ? "frame_source_cross_origin" : "frame_capture_failed", error);
  }
}

async function encodeFrame(canvas, { mimeType, quality, bound, name, timeSeconds }) {
  const blob = await withBound(new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, mimeType, quality);
    } catch (error) {
      reject(frameError(isSecurityError(error) ? "frame_source_cross_origin" : "frame_capture_failed", error));
    }
  }), bound, "frame_capture_timeout");
  if (!blob || !Number(blob.size)) throw frameError("frame_capture_failed");
  const file = typeof globalThis.File === "function" ? new globalThis.File([blob], name, { type: mimeType }) : Object.assign(blob, { name });
  return { file, timeSeconds: roundFrameTime(timeSeconds), width: canvas.width, height: canvas.height };
}

// The frame a video on the page shows right now (the picker's own: the
// frame the coach sees, with no second video to open - which on iOS would
// draw nothing until it had played). The frame is drawn at once, before the
// call returns, so the element may be redrawn while the JPEG is made. Refused
// when the video has no picture.
export function captureFrameFromElement(video, {
  createCanvas = defaultCreateCanvas, bound = FRAME_CAPTURE_BOUND_MS, mimeType = FRAME_MIME_TYPE, quality = FRAME_QUALITY,
  maxWidth = FRAME_MAX_WIDTH, videoName = "video", fileName = "",
} = {}) {
  try {
    const canvas = createCanvas();
    const context = canvas?.getContext?.("2d") || null;
    if (!context || typeof canvas.toBlob !== "function") throw frameError("frame_capture_unsupported");
    if (!hasPicture(video)) throw frameError("frame_capture_failed");
    const width = Number(video.videoWidth) || 0;
    const height = Number(video.videoHeight) || 0;
    if (!width || !height) throw frameError("frame_source_unreadable");
    const actual = Number.isFinite(Number(video.currentTime)) ? Number(video.currentTime) : 0;
    drawScaled(context, canvas, video, width, height, maxWidth);
    return encodeFrame(canvas, { mimeType, quality, bound, name: fileName || frameFileName(videoName, actual), timeSeconds: actual });
  } catch (error) {
    return Promise.reject(error);
  }
}

// ---- The picker ------------------------------------------------------------

// The inline frame picker of the image field: the video with its own
// controls, a slider for the moment, Use this frame / Cancel. The address
// carries no `#t=` fragment - iOS Safari refuses a blob: address with one -
// the editor asks the video for the moment after every redraw instead.
export function renderFramePickerHtml(picker, { slot = "image" } = {}) {
  if (!picker?.open) return "";
  if (picker.loading) {
    return `<div class="exercise-media-frame-picker" data-exercise-media-frame-picker="${escapeAttr(slot)}"><p class="muted exercise-media-status" role="status">Opening the video...</p></div>`;
  }
  const playable = Boolean(picker.src);
  const last = lastFrameTime(picker.durationSeconds);
  const time = Math.min(roundFrameTime(picker.timeSeconds), last || roundFrameTime(picker.timeSeconds));
  const busy = Boolean(picker.busy);
  return `
    <div class="exercise-media-frame-picker" data-exercise-media-frame-picker="${escapeAttr(slot)}">
      ${playable ? `
      <p class="muted exercise-media-status">Move to the moment you want as the picture, then press Use this frame.</p>
      <video class="exercise-media-frame-video" data-exercise-media-frame-video="${escapeAttr(slot)}" controls muted playsinline preload="auto"${picker.crossOrigin ? ` crossorigin="${escapeAttr(picker.crossOrigin)}"` : ""} src="${escapeAttr(picker.src)}"></video>
      <label class="exercise-media-frame-time">
        <span>Moment: <output data-exercise-media-frame-label="${escapeAttr(slot)}">${escapeHtml(formatFrameTime(time))}</output>${last ? ` of ${escapeHtml(formatFrameTime(picker.durationSeconds))}` : ""}</span>
        <input type="range" min="0" max="${escapeAttr(String(last))}" step="0.1" value="${escapeAttr(String(time))}" data-exercise-media-frame-time="${escapeAttr(slot)}" aria-label="Moment of the video"${last ? "" : " disabled"}>
      </label>
      <p class="muted exercise-media-status" role="status" data-exercise-media-frame-hint="${escapeAttr(slot)}">${escapeHtml(picker.needsTap ? FRAME_TAP_HINT : picker.previewError ? describeFrameError("frame_source_unreadable") : "")}</p>` : ""}
      ${picker.error ? `<p class="builder-error exercise-media-status" role="alert">${escapeHtml(picker.error)}</p>` : ""}
      <div class="exercise-media-actions">
        ${playable ? `<button class="plain-button compact-button" type="button" data-action="exercise-media-frame-use" data-slot="${escapeAttr(slot)}"${busy ? " disabled" : ""}>${busy ? "Taking the frame..." : "Use this frame"}</button>` : ""}
        <button class="text-action" type="button" data-action="exercise-media-frame-cancel" data-slot="${escapeAttr(slot)}"${busy ? " disabled" : ""}>${playable ? "Cancel" : "Close"}</button>
      </div>
    </div>`;
}
