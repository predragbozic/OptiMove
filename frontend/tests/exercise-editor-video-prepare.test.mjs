import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The on-device preparation of a chosen video (exercise-media-prepare.js in
// the editor): a compliant phone MP4 goes up as it is; HEVC, MOV, an odd
// audio codec or extra tracks are converted here first with the progress and
// the Cancel of an upload; the owner's limits (100 MB in, 30 seconds) refuse
// before anything is converted or sent; a device that cannot convert says so.
// Node has no WebCodecs, so the conversion itself is a fake adapter answering
// from the fake file's facts; the real conversion runs in the browser harness.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const guards = await import("../exercise-media-upload.js");
const prepare = await import("../exercise-media-prepare.js");
const { installVideoPrepareFake, inspectionOf } = await import("./support/video-prepare-fake.mjs");
const { STORAGE_ROUTE } = guards;

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = { currentUser: { id: "u1" } };
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const file = (name, size, type, video = null) => ({ name, size, type, ...(video ? { video } : {}) });
const account = (overrides = {}) => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000", reservedBytes: "0", limitBytes: "1000000000",
  availableBytes: "998800000", limitSource: "override", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1, ...overrides,
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

// A transport that waits at a gate and honours the signal (like the real one).
function fakeTransport({ fail = null } = {}) {
  const transport = { calls: [], options: [], release: null };
  transport.upload = (request, options) => new Promise((resolve, reject) => {
    transport.calls.push(request); transport.options.push(options);
    options.signal.addEventListener("abort", () => setTimeout(() => reject(Object.assign(new Error("cancelled"), { code: "cancelled", cancelOutcome: "cancelled", uploadId: "up-1" })), 0), { once: true });
    transport.release = () => (fail ? reject(Object.assign(new Error(fail), { code: fail, uploadId: "up-1" })) : resolve({ uploadId: "up-1", mediaId: "new-1", status: "completed", media: { source: "asset", mediaId: "new-1", kind: "video", status: "ready" } }));
  });
  return transport;
}

const status = (slot = "video") => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] .exercise-media-status`)].map((p) => p.textContent.trim());
const buttons = (slot = "video") => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button`)].map((b) => b.textContent.trim());
const saveButton = () => content.querySelector('[data-action="exercise-editor-save"]');
const action = (type, slot) => ({ dataset: { action: type, slot }, closest: (selector) => content.querySelector(`[data-exercise-media-slot="${slot}"]`)?.closest(selector) });
const phoneHevc = (size = 88_000_000) => file("20261015_161141.mp4", size, "video/mp4", { videoCodec: "hevc", width: 1080, height: 1920, durationSeconds: 28.4 });

async function openEditor(h, { exercise = detail() } = {}) {
  fakeApi({ exercise });
  await editor.openExerciseEditor(state, h, "e1");
  await settle();
}

// ---- the pure rules -------------------------------------------------------

test("0. the rules: what the server takes as it is (MP4, H.264 Baseline / Main / High, AAC-LC or no audio, one video and at most one audio track) is compliant; everything else needs the conversion; the output size and name", () => {
  const ok = inspectionOf(file("a.mp4", 10, "video/mp4"));
  assert.deepEqual(prepare.videoCompliance(ok), { ok: true, reasons: [] });
  assert.deepEqual(prepare.videoCompliance(inspectionOf(phoneHevc())).reasons, ["video_codec"]);
  assert.deepEqual(prepare.videoCompliance(inspectionOf(file("a.mov", 10, "video/quicktime"))).reasons, ["container"]);
  assert.deepEqual(prepare.videoCompliance({ ...ok, videoCodecString: "avc1.6e0028" }).reasons, ["video_codec"], "High 10 is not taken");
  assert.deepEqual(prepare.videoCompliance({ ...ok, audioCodecString: "mp4a.40.5" }).reasons, ["audio_codec"], "HE-AAC is not taken");
  assert.deepEqual(prepare.videoCompliance({ ...ok, audioCodec: null, audioCodecString: null }).ok, true, "no audio is fine");
  assert.deepEqual(prepare.videoCompliance({ ...ok, otherTracks: 1 }).reasons, ["tracks"]);
  assert.deepEqual(prepare.videoCompliance({ ...ok, codedWidth: 5000 }).reasons, ["dimensions"]);
  // Track by track: an H.264 track the server accepts is copied even when the file needs a new container.
  assert.equal(prepare.videoNeedsTranscode(inspectionOf(file("a.mov", 10, "video/quicktime"))), false);
  assert.equal(prepare.videoNeedsTranscode(inspectionOf(phoneHevc())), true);
  assert.equal(prepare.videoNeedsTranscode({ ...ok, videoCodecString: "avc1.6e0028" }), true);
  assert.equal(prepare.compliantAvcProfile("avc1.42E01E"), true);
  assert.equal(prepare.compliantAvcProfile("avc1.4D401F"), true);
  assert.equal(prepare.compliantAvcProfile("hev1.1.6.L120.B0"), false);
  assert.equal(prepare.isAacLc("mp4a.40.2"), true);
  assert.equal(prepare.isAacLc("mp4a.40.29"), false);
  // Portrait phone video: the displayed size scaled to 720 on the short side, even numbers, never upscaled.
  assert.deepEqual(prepare.preparedSize({ displayWidth: 1080, displayHeight: 1920 }), { width: 720, height: 1280 });
  assert.deepEqual(prepare.preparedSize({ displayWidth: 1920, displayHeight: 1080 }), { width: 1280, height: 720 });
  assert.deepEqual(prepare.preparedSize({ displayWidth: 640, displayHeight: 360 }), { width: 640, height: 360 });
  assert.deepEqual(prepare.preparedSize({ codedWidth: 1920, codedHeight: 1080, displayWidth: 1080, displayHeight: 1920, rotation: 90 }), { width: 720, height: 1280 }, "a rotated recording keeps its displayed orientation");
  assert.equal(prepare.preparedFileName("IMG_0042.MOV"), "IMG_0042.mp4");
  assert.equal(prepare.preparedFileName(""), "video.mp4");
  assert.deepEqual(prepare.VIDEO_PREPARE_RULES, { maxInputBytes: 100_000_000, maxSeconds: 30, maxLongSide: 1280, bitrate: 4_000_000, minBitrate: 1_000_000, audioBitrate: 128_000 });
  // The re-encode bitrate: a phone recording (14 Mbps HEVC, 1080×1920 → 720×1280) gets the 4 Mbps ceiling,
  // a small clip (1.5 Mbps, 640×360, not resized) about 1.5× its own bits, nothing below 1 Mbps, unknown = the ceiling.
  assert.equal(prepare.targetBitrate({ videoBitrate: 14_000_000, displayWidth: 1080, displayHeight: 1920 }), 4_000_000);
  assert.equal(prepare.targetBitrate({ videoBitrate: 1_500_000, displayWidth: 640, displayHeight: 360 }), 2_250_000);
  assert.equal(prepare.targetBitrate({ videoBitrate: 300_000, displayWidth: 640, displayHeight: 360 }), 1_000_000);
  assert.equal(prepare.targetBitrate({ videoBitrate: 0, displayWidth: 640, displayHeight: 360 }), 4_000_000);
  assert.equal(prepare.targetBitrate({ videoBitrate: 6_000_000, displayWidth: 1920, displayHeight: 1080 }), 4_000_000, "1080p at 6 Mbps → 720p: 6 × 1.5 × 0.444 = 4 Mbps");
});

test("1. prepareVideo on its own: the input cap before any read, the length before any conversion, an unreadable file, a compliant file handed back with the canonical type, a device that cannot convert, a conversion whose result is not what was asked", async () => {
  const calls = installVideoPrepareFake();
  await assert.rejects(prepare.prepareVideo(file("big.mp4", 100_000_001, "video/mp4")), (e) => e.code === "input_too_large" && e.detail.maxInputBytes === 100_000_000);
  assert.equal(calls.inspect.length, 0, "nothing is read over the cap");
  await assert.rejects(prepare.prepareVideo(file("long.mp4", 10, "video/mp4", { durationSeconds: 30.4 })), (e) => e.code === "video_too_long" && e.detail.durationSeconds === 30.4);
  assert.equal(calls.convert.length, 0, "a long video is never converted");
  const exact = await prepare.prepareVideo(file("edge.mp4", 10, "video/mp4", { durationSeconds: 30.0 }));
  assert.equal(exact.converted, false, "exactly 30 seconds passes");
  await assert.rejects(prepare.prepareVideo(file("x.bin", 10, "", { unreadable: true })), (e) => e.code === "video_unreadable");
  const same = file("clip.mp4", 10, "video/mp4");
  const passed = await prepare.prepareVideo(same);
  assert.notEqual(passed.file, same, "never the chosen file itself");
  assert.equal(passed.file.of, same, "the cleaned copy of it (its media unchanged, its metadata removed)");
  assert.equal(passed.converted, false);
  const untyped = await prepare.prepareVideo(file("clip.mp4", 10, "application/octet-stream"));
  assert.equal(untyped.metadataRemoved, true, "a compliant file still goes through the metadata removal");
  assert.equal(calls.strip.length >= 1, true);
  // Passthrough first: a compliant H.264 / AAC MP4 recorded upright on a phone
  // (rotation metadata 90°, coded 1920×1080 shown as 1080×1920) is never re-encoded.
  const rotated = file("portrait.mp4", 3_550_000, "video/mp4", { rotation: 90, width: 1920, height: 1080, durationSeconds: 12 });
  const kept = await prepare.prepareVideo(rotated);
  assert.equal(kept.converted, false);
  assert.notEqual(kept.file, rotated);
  assert.equal(kept.file.of, rotated, "the cleaned copy of the rotated file");
  assert.equal(kept.info.rotation, 90);
  assert.equal(calls.convert.length, 0, "a compliant rotated file is not converted");
  // The same facts in a 1080p file: compliant, kept at 1080p (the 720p rule is for conversions only).
  const full = await prepare.prepareVideo(file("fullhd.mp4", 60_000_000, "video/mp4", { width: 1920, height: 1080, durationSeconds: 29 }));
  assert.equal(full.converted, false);
  installVideoPrepareFake({ canConvert: () => false });
  await assert.rejects(prepare.prepareVideo(phoneHevc()), (e) => e.code === "conversion_unavailable" && e.detail.reasons.includes("video_codec"));
  installVideoPrepareFake({ convert: async (f) => ({ name: "out.mp4", size: 5, type: "video/mp4", video: { videoCodec: "hevc" } }) });
  await assert.rejects(prepare.prepareVideo(phoneHevc()), (e) => e.code === "conversion_failed" && e.detail.stage === "verify");
  installVideoPrepareFake({ convert: async (f, info) => ({ name: "out.mp4", size: 5, type: "video/mp4", video: { width: 720, height: 1280, durationSeconds: info.durationSeconds - 2 } }) });
  await assert.rejects(prepare.prepareVideo(phoneHevc()), (e) => e.code === "conversion_failed", "a shorter result is refused");
  const good = installVideoPrepareFake();
  const phases = [];
  const result = await prepare.prepareVideo(phoneHevc(), { onPhase: (p) => phases.push(p) });
  assert.deepEqual(phases, ["checking", "preparing", "verifying"]);
  assert.equal(result.converted, true);
  assert.equal(result.videoReencoded, true);
  assert.equal(result.file.type, "video/mp4");
  assert.equal(good.inspect.length, 3, "the original, the converted result, and the cleaned copy are each read before it is accepted");
  assert.equal(good.strip.length, 1, "the converted file is cleaned too");
  assert.equal(good.privacy.length, 1);
  assert.deepEqual(result.reasons, ["video_codec"]);
  // A 1080p H.264 MOV: remuxed, the picture copied, so its full size stays (the 720p rule is for re-encodes).
  const remux = installVideoPrepareFake({ convert: async (f, info) => ({ name: "clip.mp4", size: f.size, type: "video/mp4", video: { width: 1920, height: 1080, durationSeconds: info.durationSeconds } }) });
  const movResult = await prepare.prepareVideo(file("clip.mov", 20_000_000, "video/quicktime", { width: 1920, height: 1080 }));
  assert.equal(movResult.converted, true);
  assert.equal(movResult.videoReencoded, false);
  assert.equal(movResult.info.codedWidth, 1920);
  assert.equal(remux.convert.length, 1);
});

// ---- the editor flow ------------------------------------------------------

test("2. a compliant phone MP4: no conversion, its cleaned copy (never the chosen file) goes up at once, the sentences of an upload", async () => {
  const calls = installVideoPrepareFake();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const clip = file("IMG_0042.mp4", 4_000_000, "video/mp4");
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", clip);
  await settle(); await settle();
  assert.equal(calls.convert.length, 0);
  assert.equal(transport.calls.length, 1);
  assert.notEqual(transport.calls[0].file, clip, "never the chosen file itself");
  assert.equal(transport.calls[0].file.of, clip, "the cleaned copy of the chosen file");
  assert.equal(state.exerciseEditor.media.video.state, "uploading");
  assert.match(status()[0], /^Uploading the video\.\.\. 0 %/);
  transport.release(); await chosen; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(status()[0], "Uploaded and verified. It is saved with the exercise when you press Save.");
  assert.doesNotMatch(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-file').textContent, /prepared from/);
});

test("3. an HEVC phone recording: checked, prepared with its progress patched in place and Save held, then the prepared MP4 (not the original) goes up; the file line names both sizes", async () => {
  let releaseConvert = null;
  const calls = installVideoPrepareFake({ convert: (f, info, options) => new Promise((resolve) => { releaseConvert = () => { options.onProgress(0.45); resolve({ name: "20261015_161141.mp4", size: 27_000_000, type: "video/mp4", video: { width: 720, height: 1280, durationSeconds: info.durationSeconds } }); }; }) });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  await settle(); await settle();
  assert.equal(state.exerciseEditor.media.video.state, "preparing");
  assert.equal(status()[0], "Preparing the video... 0 %");
  assert.equal(saveButton().disabled, true);
  assert.equal(saveButton().textContent, "Preparing... 0%");
  assert.deepEqual(buttons(), ["Cancel"]);
  assert.equal(transport.calls.length, 0, "nothing is sent while preparing");
  assert.equal(calls.convert[0].options.rules.maxLongSide, 1280);
  releaseConvert();
  await settle(); await settle(); await settle();
  assert.equal(content.querySelector('[data-exercise-media-progress-text="video"]')?.textContent.startsWith("Uploading the video") || state.exerciseEditor.media.video.state === "uploading", true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].file.name, "20261015_161141.mp4");
  assert.equal(transport.calls[0].file.size, 27_000_000, "the prepared file, a quarter of the original");
  assert.equal(transport.calls[0].file.type, "video/mp4");
  transport.release(); await chosen; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
  assert.equal(state.exerciseEditor.media.video.prepare.converted, true);
  assert.match(content.querySelector('[data-exercise-media-slot="video"] .exercise-media-file').textContent, /27 MB · prepared from 88 MB/);
  assert.equal(state.exerciseEditor.media.video.fileSize, 27_000_000);
});

test("4. a MOV from an iPhone with H.264 inside: the container alone sends it through the preparation (a remux), and the result goes up as MP4", async () => {
  const calls = installVideoPrepareFake();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", file("IMG_0042.MOV", 20_000_000, "video/quicktime"));
  await settle(); await settle(); await settle();
  assert.equal(calls.convert.length, 1);
  assert.deepEqual(prepare.videoCompliance(calls.convert[0].info).reasons, ["container"]);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].file.name, "IMG_0042.mp4");
  assert.equal(transport.calls[0].file.type, "video/mp4");
  transport.release(); await chosen; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "uploaded");
});

test("5. Cancel during the preparation: the conversion stops on the device, nothing is sent, 'Preparation cancelled.' with Choose a video; a cancelled Replace keeps the stored file", async () => {
  installVideoPrepareFake({ convert: (f, info, options) => new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("preparation_cancelled"), { code: "preparation_cancelled" })), { once: true }); }) });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  await settle(); await settle();
  assert.equal(state.exerciseEditor.media.video.state, "preparing");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-cancel", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "cancelling");
  assert.equal(status()[0], "Cancelling...");
  await chosen; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "cancelled");
  assert.equal(status()[0], "Preparation cancelled.");
  assert.ok(buttons().includes("Choose a video"), "nothing was uploaded and no file is kept: the coach chooses again");
  assert.equal(transport.calls.length, 0);
  assert.equal(state.exerciseEditor.media.video.file, null);
  assert.equal(saveButton().disabled, false);
  // A Replace of a stored file, cancelled while preparing: the stored file stays.
  installVideoPrepareFake({ convert: (f, info, options) => new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("preparation_cancelled"), { code: "preparation_cancelled" })), { once: true }); }) });
  await openEditor(h, { exercise: detail(storedVideo) });
  assert.equal(state.exerciseEditor.media.video.state, "stored");
  const replace = editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  await settle(); await settle();
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-cancel", "video"));
  await replace; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "stored");
  assert.equal(state.exerciseEditor.media.video.mediaId, "vid-1");
  assert.equal(transport.calls.length, 0);
});

test("6. the limits refuse before anything is read, converted or sent: over 100 MB, longer than 30 seconds (with its length), unreadable - the sentence, Choose another file, Save stays possible", async () => {
  const calls = installVideoPrepareFake();
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  await editor.chooseExerciseMediaFile(state, h, "video", phoneHevc(100_000_001));
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(status()[0], "This video is 100 MB. Choose a video under 100 MB (a shorter clip).");
  assert.equal(calls.inspect.length, 0, "not even read");
  assert.ok(buttons().includes("Choose another file") && !buttons().includes("Retry"));
  assert.equal(saveButton().disabled, false);
  await editor.chooseExerciseMediaFile(state, h, "video", file("long.mp4", 50_000_000, "video/mp4", { videoCodec: "hevc", durationSeconds: 51.2 }));
  assert.equal(status()[0], "This video is 51 seconds long. The limit is 30 seconds. Trim it on your phone and choose it again.");
  assert.equal(calls.convert.length, 0, "a long video is not converted");
  await editor.chooseExerciseMediaFile(state, h, "video", file("odd.bin", 5_000, "application/octet-stream", { unreadable: true }));
  assert.match(status()[0], /could not be read as a video/);
  assert.equal(transport.calls.length, 0);
  assert.equal(state.exerciseEditor.media.video.file, null);
});

test("7. a device that cannot convert, and a conversion that fails: one sentence each, nothing sent, another file offered", async () => {
  installVideoPrepareFake({ canConvert: () => false });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  await editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(status()[0], "This video can't be prepared on this device. Choose an MP4 (H.264) video, or add it from another device.");
  assert.equal(transport.calls.length, 0);
  installVideoPrepareFake({ convert: async () => { throw Object.assign(new Error("boom"), { code: "conversion_failed" }); } });
  await editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  assert.equal(status()[0], "The video could not be prepared. Choose another video, or try again.");
  assert.ok(!buttons().includes("Retry"));
  assert.equal(transport.calls.length, 0);
  assert.equal(saveButton().disabled, false);
});

test("8. while a video is being prepared: Save is held, the editor asks before closing and a reload asks first; a second file is not taken; the close cancels the preparation", async () => {
  let abortedSignal = null;
  installVideoPrepareFake({ convert: (f, info, options) => new Promise((resolve, reject) => { abortedSignal = options.signal; options.signal.addEventListener("abort", () => reject(Object.assign(new Error("preparation_cancelled"), { code: "preparation_cancelled" })), { once: true }); }) });
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  await settle(); await settle();
  assert.equal(editor.uploadInFlight(state.exerciseEditor), true);
  await editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
  assert.equal(state.exerciseEditor.error, "Wait for the upload to finish, or cancel it, before saving.");
  const event = { preventDefault() { this.prevented = true; }, returnValue: "" };
  assert.equal(editor.handleExerciseMediaBeforeUnload(event, state), true);
  assert.equal(event.prevented, true);
  await editor.chooseExerciseMediaFile(state, h, "video", file("second.mp4", 10, "video/mp4"));
  assert.equal(state.exerciseEditor.media.video.fileName, "20261015_161141.mp4", "the second file is ignored while busy");
  // The picture's controls are shown disabled while the video is prepared (they would do nothing); only Cancel is live.
  h.rerender();
  const imageButtons = [...content.querySelectorAll('[data-exercise-media-slot="image"] button')];
  assert.ok(imageButtons.length > 0);
  assert.ok(imageButtons.every((b) => b.disabled), "Upload picture / Use a link are disabled");
  assert.deepEqual([...content.querySelectorAll('[data-exercise-media-slot="video"] button')].map((b) => [b.textContent.trim(), b.disabled]), [["Cancel", false]]);
  globalThis.confirm = () => false;
  assert.equal(editor.closeExerciseEditor(state, h), false, "declined: the editor stays");
  assert.equal(abortedSignal.aborted, false);
  globalThis.confirm = () => true;
  assert.equal(editor.closeExerciseEditor(state, h), true);
  assert.equal(abortedSignal.aborted, true, "the close cancels the preparation");
  await chosen;
  delete globalThis.confirm;
});

test("10. Cancel while the prepared file is read back: the result is dropped, nothing is uploaded, a Replace keeps the stored file", async () => {
  // The real prepareVideo with an adapter whose second read (the check of the converted file) waits at a gate.
  let releaseCheck = null;
  const reads = [];
  prepare.setVideoPrepareAdapter({
    async inspect(f) {
      reads.push(f);
      if (reads.length === 2) await new Promise((resolve) => { releaseCheck = resolve; });
      return inspectionOf(f);
    },
    async canConvert() { return true; },
    async convert(f, info, options) { options.onProgress(1); return { name: "out.mp4", size: 1_000, type: "video/mp4", video: { width: 720, height: 1280, durationSeconds: info.durationSeconds } }; },
  });
  // A transport that answers at once, so a wrongful upload shows as a call (and a finished field), never as a hang.
  const transport = { calls: [], upload: async (request) => { transport.calls.push(request); return { uploadId: "up-1", mediaId: "new-1", status: "completed", media: { source: "asset", mediaId: "new-1", kind: "video", status: "ready" } }; } };
  const h = handlers({ upload: transport.upload });
  await openEditor(h, { exercise: detail(storedVideo) });
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", phoneHevc());
  for (let i = 0; i < 20 && !releaseCheck; i++) await settle();
  assert.ok(releaseCheck, "the converted file is being read back");
  assert.equal(state.exerciseEditor.media.video.state, "preparing");
  await editor.handleExerciseEditorAction(state, h, action("exercise-media-cancel", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "cancelling");
  releaseCheck();
  await chosen; await settle();
  assert.equal(transport.calls.length, 0, "no upload after a Cancel");
  assert.equal(state.exerciseEditor.media.video.state, "stored");
  assert.equal(state.exerciseEditor.media.video.mediaId, "vid-1");
  assert.equal(state.exerciseEditor.media.video.file, null);
});

test("11. the preparation tool that fails to load says so (not 'this device'), and a compliant MP4 is not blamed on the device", async () => {
  prepare.setVideoPrepareAdapter(null);
  prepare.setMediabunnyLoader(() => Promise.reject(new Error("chunk failed")));
  const transport = fakeTransport();
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  await editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 10, "video/mp4"));
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(status()[0], "The video tool could not be loaded. Check the connection and choose the video again.");
  assert.equal(transport.calls.length, 0);
  // The next choice loads it again (the failed load is not cached).
  let loads = 0;
  prepare.setMediabunnyLoader(() => { loads += 1; return Promise.reject(new Error("still offline")); });
  await editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 10, "video/mp4"));
  assert.equal(loads, 1);
  prepare.setMediabunnyLoader(() => import("../vendor/mediabunny/mediabunny-1.61.1.min.mjs"));
});

test("9. the server's own 30-second rule after an upload (video_too_long): the sentence, no Retry of the same bytes", async () => {
  installVideoPrepareFake();
  const transport = fakeTransport({ fail: "video_too_long" });
  const h = handlers({ upload: transport.upload });
  await openEditor(h);
  const chosen = editor.chooseExerciseMediaFile(state, h, "video", file("clip.mp4", 10, "video/mp4"));
  await settle(); await settle();
  transport.release(); await chosen; await settle();
  assert.equal(state.exerciseEditor.media.video.state, "failed");
  assert.equal(status()[0], "This video is too long. The limit is 30 seconds. Trim it on your phone and choose it again.");
  assert.ok(!buttons().includes("Retry"));
  assert.ok(buttons().includes("Choose another file"));
});
