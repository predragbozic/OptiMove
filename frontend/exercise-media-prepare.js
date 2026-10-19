// On-device preparation of a chosen video before it is uploaded (R2, the
// exercise editor): read the file, decide whether the server would take it as
// it is, and when it would not - a phone recording in HEVC, a MOV, an odd
// audio codec, extra tracks - convert it here, in the browser, with the
// device's own codecs (WebCodecs through Mediabunny) into the one shape every
// screen plays and the server's inspection accepts: MP4, H.264 (High, 8-bit
// 4:2:0), AAC-LC, at most 720p on the long side, faststart. Nothing is sent
// anywhere; the server's inspection stays the gate after the upload.
//
// The coach never chooses a codec or a size. The limits are the owner's rules
// of 2026-10-19: an input file of at most 100 MB and a video of at most 30
// seconds (no trimming here; a longer video is refused with its length).

import { formatBytes } from "./utils.js";

export const VIDEO_PREPARE_RULES = Object.freeze({
  maxInputBytes: 100_000_000,
  maxSeconds: 30,
  maxLongSide: 1280,
  bitrate: 4_000_000,
  minBitrate: 1_000_000,
  audioBitrate: 128_000,
});

// The H.264 profiles the server's inspection accepts (profile_idc of
// avc1.PPCCLL): Baseline / Constrained Baseline 66, Main 77, High 100.
const COMPLIANT_AVC_PROFILES = new Set([0x42, 0x4d, 0x64]);

// The library is loaded only when a video is chosen (690 KB), from the
// vendored, pinned copy; tests replace the loader or the whole adapter.
let loadLibrary = () => import("./vendor/mediabunny/mediabunny-1.61.1.min.mjs");
let libraryPromise = null;
let adapter = null;

export function setMediabunnyLoader(loader) {
  loadLibrary = loader;
  libraryPromise = null;
}

// A test seam: { inspect(file, options), convert(file, info, options), canConvert(info) }.
export function setVideoPrepareAdapter(value) {
  adapter = value || null;
}

async function library() {
  if (!libraryPromise) {
    libraryPromise = Promise.resolve().then(() => loadLibrary()).catch((error) => {
      libraryPromise = null;
      throw prepareError("conversion_unavailable", error, { reason: "library" });
    });
  }
  return libraryPromise;
}

export function prepareError(code, cause = null, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  if (detail) error.detail = detail;
  return error;
}

const isAborted = (signal) => Boolean(signal?.aborted);

function containerOf(mimeType, formatName) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("video/quicktime")) return "mov";
  if (mime.startsWith("video/webm")) return "webm";
  const name = String(formatName || "").toLowerCase();
  if (name.includes("mp4")) return "mp4";
  if (name.includes("quicktime")) return "mov";
  if (name.includes("webm")) return "webm";
  return "other";
}

const trackIs = (track, kind) => (typeof track?.[kind === "video" ? "isVideoTrack" : "isAudioTrack"] === "function" ? track[kind === "video" ? "isVideoTrack" : "isAudioTrack"]() : track?.type === kind);

// What the file is: container, codecs, size, rotation, length, tracks, and
// whether this browser can decode it. Throws video_unreadable for anything
// Mediabunny cannot read as a video.
export async function inspectVideo(file, { signal } = {}) {
  if (adapter?.inspect) return adapter.inspect(file, { signal });
  const MB = await library();
  if (isAborted(signal)) throw prepareError("preparation_cancelled");
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  try {
    const format = await input.getFormat();
    const mimeType = await input.getMimeType();
    const tracks = await input.getTracks();
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw prepareError("video_unreadable");
    const audio = await input.getPrimaryAudioTrack();
    const videoTracks = tracks.filter((track) => trackIs(track, "video")).length;
    const audioTracks = tracks.filter((track) => trackIs(track, "audio")).length;
    return {
      container: containerOf(mimeType, format?.name),
      mimeType: String(mimeType || ""),
      trackCount: tracks.length,
      videoTracks,
      audioTracks,
      otherTracks: Math.max(0, tracks.length - videoTracks - audioTracks),
      videoCodec: await video.getCodec(),
      videoCodecString: await video.getCodecParameterString(),
      codedWidth: await video.getCodedWidth(),
      codedHeight: await video.getCodedHeight(),
      rotation: await video.getRotation(),
      displayWidth: await video.getDisplayWidth(),
      displayHeight: await video.getDisplayHeight(),
      durationSeconds: await input.computeDuration(),
      videoBitrate: await videoBitrateOf(video),
      audioCodec: audio ? await audio.getCodec() : null,
      audioCodecString: audio ? await audio.getCodecParameterString() : null,
      canDecodeVideo: await video.canDecode(),
      canDecodeAudio: audio ? await audio.canDecode() : true,
    };
  } catch (error) {
    if (error?.code) throw error;
    throw prepareError("video_unreadable", error);
  }
}

// The source's average video bitrate in bits per second (from the packet
// index, no decoding); 0 when it cannot be told.
async function videoBitrateOf(track) {
  try {
    const stats = await track.computePacketStats();
    return Number(stats?.averageBitrate) > 0 ? Number(stats.averageBitrate) : 0;
  } catch {
    return 0;
  }
}

// The bitrate of a re-encode: the ceiling of the rules, lowered for a source
// that carries fewer bits (H.264 needs about one and a half times HEVC's bits
// for the same picture, scaled by the pixels that remain after resizing), and
// never below the floor - so a small clip does not grow and a phone recording
// still shrinks.
export function targetBitrate(info, rules = VIDEO_PREPARE_RULES) {
  const source = Number(info?.videoBitrate) || 0;
  if (!source) return rules.bitrate;
  const size = preparedSize(info, rules);
  const sourcePixels = (Number(info.displayWidth) || Number(info.codedWidth) || 1) * (Number(info.displayHeight) || Number(info.codedHeight) || 1);
  const pixelRatio = Math.min(1, (size.width * size.height) / sourcePixels);
  const wanted = Math.round(source * 1.5 * pixelRatio);
  return Math.min(rules.bitrate, Math.max(rules.minBitrate, wanted));
}

export function compliantAvcProfile(codecString) {
  const match = /^avc1\.([0-9a-f]{2})/i.exec(String(codecString || ""));
  return match ? COMPLIANT_AVC_PROFILES.has(parseInt(match[1], 16)) : false;
}

export const isAacLc = (codecString) => /^mp4a\.40\.0?2$/i.test(String(codecString || ""));

// Whether the server would accept the file as it is (its inspection: MP4,
// one H.264 video track in an allowed profile, at most one AAC-LC audio track,
// nothing else, at most 4096 px a side) - such a file is never converted.
export function videoCompliance(info) {
  const reasons = [];
  if (info.container !== "mp4") reasons.push("container");
  if (info.videoCodec !== "avc" || !compliantAvcProfile(info.videoCodecString)) reasons.push("video_codec");
  if (info.audioCodec && !(info.audioCodec === "aac" && isAacLc(info.audioCodecString))) reasons.push("audio_codec");
  if (info.videoTracks !== 1 || info.audioTracks > 1 || info.otherTracks > 0) reasons.push("tracks");
  if (Math.max(Number(info.codedWidth) || 0, Number(info.codedHeight) || 0) > 4096) reasons.push("dimensions");
  return { ok: reasons.length === 0, reasons };
}

const audioNeedsEncoding = (info) => Boolean(info.audioCodec) && !(info.audioCodec === "aac" && isAacLc(info.audioCodecString));

// Passthrough first, track by track: an H.264 track the server accepts is
// copied into the new MP4 as it is (a MOV, extra tracks or an odd audio codec
// change nothing about the picture), only another codec or profile is
// re-encoded, and only then at most 720p.
export const videoNeedsTranscode = (info) => !(info.videoCodec === "avc" && compliantAvcProfile(info.videoCodecString));

// Whether this browser can do the conversion: WebCodecs with a decoder for
// the file's video and an H.264 encoder when the picture is re-encoded, an
// AAC encoder only when the audio is not AAC-LC (copied tracks need no codec,
// so a MOV with H.264 / AAC is remuxed even where WebCodecs is missing).
export async function canConvertVideo(info) {
  if (adapter?.canConvert) return adapter.canConvert(info);
  const MB = await library();
  if (videoNeedsTranscode(info)) {
    if (typeof globalThis.VideoDecoder === "undefined" || typeof globalThis.VideoEncoder === "undefined") return false;
    if (!info.canDecodeVideo) return false;
    if (!(await MB.canEncodeVideo("avc"))) return false;
  }
  if (audioNeedsEncoding(info)) {
    if (typeof globalThis.AudioDecoder === "undefined" || typeof globalThis.AudioEncoder === "undefined") return false;
    if (!(info.canDecodeAudio && (await MB.canEncodeAudio("aac")))) return false;
  }
  return true;
}

// The output size: the displayed (rotated) size scaled to at most
// maxLongSide on the long side, even numbers, never upscaled.
export function preparedSize(info, rules = VIDEO_PREPARE_RULES) {
  const width = Number(info.displayWidth) || Number(info.codedWidth) || 0;
  const height = Number(info.displayHeight) || Number(info.codedHeight) || 0;
  const scale = Math.min(1, rules.maxLongSide / Math.max(width, height, 1));
  const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function preparedFileName(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "").trim();
  return `${base || "video"}.mp4`;
}

// Decode, encode H.264, copy (or encode) the audio, mux MP4 with faststart;
// cancellable through the signal.
export async function convertVideo(file, info, { onProgress, signal, rules = VIDEO_PREPARE_RULES } = {}) {
  if (adapter?.convert) return adapter.convert(file, info, { onProgress, signal, rules });
  const MB = await library();
  if (isAborted(signal)) throw prepareError("preparation_cancelled");
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: "in-memory" }), target: new MB.BufferTarget() });
  const size = preparedSize(info, rules);
  // No option at all means "copy the track" to Mediabunny; a codec, quality or size forces the re-encode.
  const video = videoNeedsTranscode(info)
    ? { codec: "avc", quality: new MB.Quality({ bitrate: targetBitrate(info, rules) }), width: size.width, height: size.height, fit: "fill", hardwareAcceleration: "no-preference" }
    : {};
  const audio = audioNeedsEncoding(info) ? { codec: "aac", quality: new MB.Quality({ bitrate: rules.audioBitrate }) } : {};
  let conversion;
  try {
    conversion = await MB.Conversion.init({ input, output, video, audio });
  } catch (error) {
    throw prepareError("conversion_failed", error, { stage: "init" });
  }
  if (!conversion.isValid) throw prepareError("conversion_unavailable", null, { reasons: conversion.discardedTracks.map((entry) => entry.reason) });
  const cancel = () => { void conversion.cancel(); };
  if (isAborted(signal)) { cancel(); throw prepareError("preparation_cancelled"); }
  signal?.addEventListener?.("abort", cancel, { once: true });
  conversion.onProgress = (fraction) => onProgress?.(Math.max(0, Math.min(1, Number(fraction) || 0)));
  try {
    await conversion.execute();
  } catch (error) {
    if (isAborted(signal) || error?.name === "ConversionCanceledError") throw prepareError("preparation_cancelled", error);
    throw prepareError("conversion_failed", error, { stage: "execute" });
  } finally {
    signal?.removeEventListener?.("abort", cancel);
  }
  const buffer = output.target.buffer;
  if (!buffer || !buffer.byteLength) throw prepareError("conversion_failed", null, { stage: "output" });
  return new File([buffer], preparedFileName(file.name), { type: "video/mp4", lastModified: Date.now() });
}

// A compliant file keeps its bytes; only its type is made canonical when the
// browser reported none or a wrong one (a download, a share, a USB copy).
function canonicalFile(file) {
  if (file.type === "video/mp4") return file;
  return new File([file], file.name, { type: "video/mp4", lastModified: file.lastModified });
}

// The whole step. Resolves to { file, converted, info, source, reasons };
// throws an error whose code is one of: input_too_large, video_unreadable,
// video_too_long, conversion_unavailable, conversion_failed,
// preparation_cancelled. `onPhase` gets "checking", "preparing", "verifying".
export async function prepareVideo(file, { onProgress, onPhase, signal, rules = VIDEO_PREPARE_RULES } = {}) {
  if (!file) throw prepareError("video_unreadable");
  if (Number(file.size) > rules.maxInputBytes) throw prepareError("input_too_large", null, { size: Number(file.size), maxInputBytes: rules.maxInputBytes });
  onPhase?.("checking");
  const info = await inspectVideo(file, { signal });
  if (isAborted(signal)) throw prepareError("preparation_cancelled");
  if (!(Number(info.durationSeconds) > 0)) throw prepareError("video_unreadable", null, { reason: "duration" });
  if (info.durationSeconds > rules.maxSeconds + 0.05) throw prepareError("video_too_long", null, { durationSeconds: info.durationSeconds, maxSeconds: rules.maxSeconds });
  const compliance = videoCompliance(info);
  if (compliance.ok) return { file: canonicalFile(file), converted: false, info, source: info, reasons: [] };
  if (!(await canConvertVideo(info))) throw prepareError("conversion_unavailable", null, { reasons: compliance.reasons });
  onPhase?.("preparing");
  const converted = await convertVideo(file, info, { onProgress, signal, rules });
  if (isAborted(signal)) throw prepareError("preparation_cancelled");
  onPhase?.("verifying");
  const check = await inspectVideo(converted, { signal });
  // A copied picture keeps its size; a re-encoded one is at most 720p on the long side.
  const maxLongSide = videoNeedsTranscode(info) ? rules.maxLongSide + 2 : 4096;
  const verified = videoCompliance(check).ok
    && check.durationSeconds <= rules.maxSeconds + 0.05
    && Math.abs(check.durationSeconds - info.durationSeconds) <= 0.5
    && Math.max(check.codedWidth, check.codedHeight) <= maxLongSide;
  if (!verified) throw prepareError("conversion_failed", null, { stage: "verify", check });
  return { file: converted, converted: true, videoReencoded: videoNeedsTranscode(info), info: check, source: info, reasons: compliance.reasons };
}

// One sentence per code, in the coach's words.
export function describePrepareError(code, { detail = null, file = null } = {}) {
  switch (code) {
    case "input_too_large":
      return `This video is ${formatBytes(detail?.size ?? file?.size ?? 0)}. Choose a video under ${formatBytes(detail?.maxInputBytes ?? VIDEO_PREPARE_RULES.maxInputBytes)} (a shorter clip).`;
    case "video_too_long": {
      const seconds = Number(detail?.durationSeconds);
      const max = detail?.maxSeconds ?? VIDEO_PREPARE_RULES.maxSeconds;
      return `${Number.isFinite(seconds) ? `This video is ${Math.round(seconds)} seconds long` : "This video is too long"}. The limit is ${max} seconds. Trim it on your phone and choose it again.`;
    }
    case "video_unreadable":
      return "This file could not be read as a video. Choose an MP4 or MOV video, for example one recorded on your phone.";
    case "conversion_unavailable":
      return "This video can't be prepared on this device. Choose an MP4 (H.264) video, or add it from another device.";
    case "conversion_failed":
      return "The video could not be prepared. Choose another video, or try again.";
    case "preparation_cancelled":
      return "Preparation cancelled.";
    default:
      return "";
  }
}

export const PREPARE_ERROR_CODES = Object.freeze(["input_too_large", "video_too_long", "video_unreadable", "conversion_unavailable", "conversion_failed", "preparation_cancelled"]);
