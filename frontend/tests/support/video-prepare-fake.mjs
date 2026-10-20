// A fake of the on-device video preparation (exercise-media-prepare.js) for
// the editor suites: Node has no WebCodecs and no Mediabunny decode, so the
// adapter answers the inspection from the fake file's own facts and converts
// by handing back a new fake file. The real conversion is exercised in the
// browser harness (see docs/runbooks/exercise-media-r2-activation.md).
import { setMetadataTools, setVideoPrepareAdapter } from "../../exercise-media-prepare.js";

// A compliant phone MP4 unless the fake file says otherwise through `video`
// (container, codec, audio, duration, size, tracks) - a plain object a test
// attaches to its file.
export function inspectionOf(file) {
  const v = file?.video || {};
  const container = v.container || (file?.type === "video/quicktime" || /\.mov$/i.test(file?.name || "") ? "mov" : "mp4");
  return {
    container, mimeType: container === "mov" ? "video/quicktime" : "video/mp4",
    trackCount: 2 + (v.otherTracks || 0), videoTracks: v.videoTracks ?? 1, audioTracks: v.audioTracks ?? 1, otherTracks: v.otherTracks || 0,
    videoCodec: v.videoCodec || "avc", videoCodecString: v.videoCodecString || (v.videoCodec === "hevc" ? "hev1.1.6.L120.B0" : "avc1.640028"),
    codedWidth: v.width || 1920, codedHeight: v.height || 1080, rotation: v.rotation || 0,
    displayWidth: v.rotation === 90 || v.rotation === 270 ? (v.height || 1080) : (v.width || 1920), displayHeight: v.rotation === 90 || v.rotation === 270 ? (v.width || 1920) : (v.height || 1080),
    durationSeconds: v.durationSeconds ?? 5, audioCodec: v.audioCodec === null ? null : v.audioCodec || "aac", audioCodecString: v.audioCodecString || "mp4a.40.2",
    canDecodeVideo: v.canDecodeVideo ?? true, canDecodeAudio: v.canDecodeAudio ?? true,
  };
}

// Installs the fake. `convert` may be a gate: it receives (file, info, options)
// and must resolve to the converted fake file; by default it answers at once
// with a compliant 720p MP4 a quarter of the size, reporting 0.5 then 1.
export function installVideoPrepareFake({ convert = null, canConvert = () => true, strip = null, privacy = null } = {}) {
  const calls = { inspect: [], convert: [], strip: [], privacy: [] };
  // The metadata removal: by default a new object - the cleaned copy - with the
  // same facts, found clean; never the file it was given, so a test can tell the
  // copy that goes up from the chosen original (the real removal is tested in
  // exercise-media-metadata.test.mjs on real bytes).
  setMetadataTools({
    async strip(file, options) {
      calls.strip.push(file);
      if (strip) return strip(file, options);
      const copy = { __cleaned: true, of: file, name: String(file?.name || "video").replace(/\.[^.]+$/, "") + ".mp4", size: file?.size, type: "video/mp4", ...(file?.video ? { video: file.video } : {}) };
      return { file: copy, report: { fake: true } };
    },
    async privacy(file, options) { calls.privacy.push(file); if (privacy) return privacy(file, options); return { clean: true, findings: [] }; },
  });
  setVideoPrepareAdapter({
    async inspect(file) { calls.inspect.push(file); if (file?.video?.unreadable) { const e = new Error("video_unreadable"); e.code = "video_unreadable"; throw e; } return inspectionOf(file); },
    async canConvert(info) { return canConvert(info); },
    async convert(file, info, options) {
      calls.convert.push({ file, info, options });
      if (convert) return convert(file, info, options);
      options?.onProgress?.(0.5);
      options?.onProgress?.(1);
      return { name: file.name.replace(/\.[^.]+$/, "") + ".mp4", size: Math.max(1, Math.round((file.size || 0) / 4)), type: "video/mp4", video: { container: "mp4", videoCodec: "avc", width: 720, height: 1280, durationSeconds: info.durationSeconds } };
    },
  });
  return calls;
}

export function uninstallVideoPrepareFake() { setVideoPrepareAdapter(null); setMetadataTools(null); }
