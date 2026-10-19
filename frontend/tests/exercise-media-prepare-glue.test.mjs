import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The Mediabunny glue of the on-device preparation (exercise-media-prepare.js)
// through a fake of the library module itself, not through the adapter seam:
// what is passed to Conversion.init (a track copied when it can be, re-encoded
// only when it must, never any metadata), the abort wiring, isValid, the
// output buffer, and that every Input is disposed on every path. Node has no
// WebCodecs, so VideoDecoder / VideoEncoder / AudioDecoder / AudioEncoder are
// stubs here; the real library runs in the browser harness and its real
// output passes the server's real parser (backend media-upload-be2 tests).

const prepare = await import("../exercise-media-prepare.js");

// Facts per source file (a fake File carries `video`); the converted output's
// facts come from the options the conversion was given.
function sourceFacts(file) {
  const v = file.video || {};
  return {
    format: v.container === "mov" ? "QuickTime File Format" : v.container === "webm" ? "WebM" : "MP4",
    mimeType: v.container === "mov" ? "video/quicktime" : v.container === "webm" ? "video/webm" : "video/mp4",
    videoCodec: v.videoCodec || "avc", videoCodecString: v.videoCodecString || (v.videoCodec === "hevc" ? "hev1.1.6.L120.B0" : "avc1.640028"),
    width: v.width || 1920, height: v.height || 1080, rotation: v.rotation || 0, duration: v.durationSeconds ?? 5, bitrate: v.bitrate ?? 14_000_000,
    audioCodec: v.audioCodec === null ? null : v.audioCodec || "aac", audioCodecString: v.audioCodecString || "mp4a.40.2",
  };
}

const fake = { inits: [], inputs: 0, disposed: 0, cancels: 0, executeGate: null, valid: true, outputs: new WeakMap(), lastOutputFacts: null };
const display = (f) => (f.rotation === 90 || f.rotation === 270 ? { w: f.height, h: f.width } : { w: f.width, h: f.height });

class FakeTrack {
  constructor(kind, facts) { this.kind = kind; this.facts = facts; }
  isVideoTrack() { return this.kind === "video"; }
  isAudioTrack() { return this.kind === "audio"; }
  async getCodec() { return this.kind === "video" ? this.facts.videoCodec : this.facts.audioCodec; }
  async getCodecParameterString() { return this.kind === "video" ? this.facts.videoCodecString : this.facts.audioCodecString; }
  async getCodedWidth() { return this.facts.width; }
  async getCodedHeight() { return this.facts.height; }
  async getRotation() { return this.facts.rotation; }
  async getDisplayWidth() { return display(this.facts).w; }
  async getDisplayHeight() { return display(this.facts).h; }
  async computePacketStats() { return { averageBitrate: this.facts.bitrate, packetCount: 1, averagePacketRate: 30 }; }
  async canDecode() { return true; }
}

const MB = {
  ALL_FORMATS: ["all"],
  BlobSource: class { constructor(blob) { this.blob = blob; } },
  Input: class {
    constructor({ source }) {
      fake.inputs += 1;
      this.facts = source.blob.video ? sourceFacts(source.blob) : fake.outputs.get(source.blob) || fake.lastOutputFacts;
      this.disposed = false;
    }
    async getFormat() { return { name: this.facts.format }; }
    async getMimeType() { return this.facts.mimeType; }
    async getTracks() { return [new FakeTrack("video", this.facts), ...(this.facts.audioCodec ? [new FakeTrack("audio", this.facts)] : [])]; }
    async getPrimaryVideoTrack() { return new FakeTrack("video", this.facts); }
    async getPrimaryAudioTrack() { return this.facts.audioCodec ? new FakeTrack("audio", this.facts) : null; }
    async computeDuration() { return this.facts.duration; }
    dispose() { if (!this.disposed) { this.disposed = true; fake.disposed += 1; } }
  },
  Output: class { constructor({ format, target }) { this.format = format; this.target = target; } },
  Mp4OutputFormat: class { constructor(options) { this.options = options; } },
  BufferTarget: class { constructor() { this.buffer = null; } },
  Quality: class { constructor(options) { this.options = options; } },
  Conversion: {
    async init(options) {
      fake.inits.push(options);
      const source = options.input.facts;
      return {
        isValid: fake.valid,
        discardedTracks: fake.valid ? [] : [{ track: { type: "video" }, reason: "no_encodable_target_codec" }],
        onProgress: null,
        async execute() {
          this.onProgress?.(0.5);
          if (fake.executeGate) await fake.executeGate(this);
          if (this.canceled) { const error = new Error("canceled"); error.name = "ConversionCanceledError"; throw error; }
          this.onProgress?.(1);
          // The output: the options decide the codec and the size; copied tracks keep the source's.
          const v = options.video || {};
          const a = options.audio || {};
          const reencoded = Boolean(v.codec);
          const outFacts = {
            ...source, format: "MP4", mimeType: "video/mp4",
            videoCodec: "avc", videoCodecString: reencoded ? "avc1.64001f" : source.videoCodecString,
            width: reencoded ? (source.rotation === 90 || source.rotation === 270 ? v.height : v.width) : source.width,
            height: reencoded ? (source.rotation === 90 || source.rotation === 270 ? v.width : v.height) : source.height,
            audioCodec: source.audioCodec ? "aac" : null, audioCodecString: source.audioCodec ? (a.codec ? "mp4a.40.2" : source.audioCodecString) : null,
          };
          options.output.target.buffer = new ArrayBuffer(1234);
          fake.lastOutputFacts = outFacts;
        },
        async cancel() { fake.cancels += 1; this.canceled = true; },
      };
    },
  },
  canEncodeVideo: async (codec) => codec === "avc",
  canEncodeAudio: async (codec) => codec === "aac",
};

globalThis.VideoDecoder = class {};
globalThis.VideoEncoder = class {};
globalThis.AudioDecoder = class {};
globalThis.AudioEncoder = class {};

const file = (name, size, type, video) => ({ name, size, type, video });

beforeEach(() => {
  Object.assign(fake, { inits: [], inputs: 0, disposed: 0, cancels: 0, executeGate: null, valid: true, lastOutputFacts: null });
  prepare.setVideoPrepareAdapter(null);
  prepare.setMediabunnyLoader(async () => MB);
});

test("1. a compliant H.264 / AAC-LC MP4 (rotation 90) is never handed to a conversion; its Input is disposed", async () => {
  const clip = file("portrait.mp4", 3_550_000, "video/mp4", { rotation: 90, bitrate: 2_000_000 });
  const result = await prepare.prepareVideo(clip);
  assert.equal(result.converted, false);
  assert.equal(result.file, clip);
  assert.equal(fake.inits.length, 0, "no Conversion.init at all");
  assert.equal(fake.disposed, fake.inputs);
});

test("2. an H.264 MOV: the picture and the AAC-LC sound are copied (option-less entries), no metadata; MP4 out", async () => {
  const result = await prepare.prepareVideo(file("IMG_0042.MOV", 20_000_000, "video/quicktime", { container: "mov", width: 1920, height: 1080 }));
  assert.equal(fake.inits.length, 1);
  const options = fake.inits[0];
  assert.deepEqual(options.video, {}, "the H.264 track is copied, not re-encoded");
  assert.deepEqual(options.audio, {}, "AAC-LC is copied");
  assert.deepEqual(options.tags, {}, "no descriptive metadata is carried over");
  assert.equal(options.output.format.options.fastStart, "in-memory");
  assert.equal(result.converted, true);
  assert.equal(result.videoReencoded, false);
  assert.equal(result.file.name, "IMG_0042.mp4");
  assert.equal(result.file.type, "video/mp4");
  assert.equal(result.info.codedWidth, 1920, "a copied picture keeps its size");
  assert.equal(fake.disposed, fake.inputs, "the source, and the read-back of the result, are disposed");
});

test("3. an HEVC phone recording (1080×1920, 14 Mbps): re-encoded to H.264 at 720×1280, 4 Mbps; AAC-LC still copied", async () => {
  const result = await prepare.prepareVideo(file("20261015_161141.mp4", 88_000_000, "video/mp4", { videoCodec: "hevc", width: 1080, height: 1920, durationSeconds: 28 }));
  const options = fake.inits[0];
  assert.equal(options.video.codec, "avc");
  assert.equal(options.video.width, 720);
  assert.equal(options.video.height, 1280);
  assert.equal(options.video.fit, "fill");
  assert.equal(options.video.quality.options.bitrate, 4_000_000);
  assert.deepEqual(options.audio, {});
  assert.deepEqual(options.tags, {});
  assert.equal(result.videoReencoded, true);
  assert.equal(result.info.videoCodecString, "avc1.64001f");
});

test("4. a rotated HEVC recording (coded 1920×1080, rotation 90): the size is taken from the shown orientation", async () => {
  await prepare.prepareVideo(file("rot.mp4", 50_000_000, "video/mp4", { videoCodec: "hevc", width: 1920, height: 1080, rotation: 90, durationSeconds: 10 }));
  assert.equal(fake.inits[0].video.width, 720);
  assert.equal(fake.inits[0].video.height, 1280);
});

test("5. a sound that is not AAC-LC (Opus in a WebM) is encoded to AAC; a small VP8 clip gets a bitrate from its own (no growth to 4 Mbps)", async () => {
  await prepare.prepareVideo(file("clip.webm", 300_000, "video/webm", { container: "webm", videoCodec: "vp8", videoCodecString: "vp8", width: 640, height: 360, bitrate: 400_000, audioCodec: "opus", audioCodecString: "opus" }));
  const options = fake.inits[0];
  assert.equal(options.audio.codec, "aac");
  assert.equal(options.audio.quality.options.bitrate, 128_000);
  assert.equal(options.video.codec, "avc");
  assert.equal(options.video.quality.options.bitrate, 1_000_000, "1.5 × 400 kbps is under the 1 Mbps floor");
});

test("6. Cancel during the conversion: Conversion.cancel() is called, preparation_cancelled, the Inputs are disposed", async () => {
  const controller = new AbortController();
  fake.executeGate = async () => { controller.abort(); await new Promise((resolve) => setTimeout(resolve, 0)); };
  await assert.rejects(prepare.prepareVideo(file("p.mp4", 1_000, "video/mp4", { videoCodec: "hevc" }), { signal: controller.signal }), (e) => e.code === "preparation_cancelled");
  assert.equal(fake.cancels, 1);
  assert.equal(fake.disposed, fake.inputs);
});

test("7. a conversion the library declares invalid is conversion_unavailable; its Input is disposed", async () => {
  fake.valid = false;
  await assert.rejects(prepare.prepareVideo(file("p.mp4", 1_000, "video/mp4", { videoCodec: "hevc" })), (e) => e.code === "conversion_unavailable" && e.detail.reasons[0] === "no_encodable_target_codec");
  assert.equal(fake.disposed, fake.inputs);
});

test("8. an aborted signal before the result is accepted: preparation_cancelled, never the converted file", async () => {
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(prepare.prepareVideo(file("p.mp4", 1_000, "video/mp4", { videoCodec: "hevc" }), {
    signal: controller.signal,
    onPhase: (phase) => { phases.push(phase); if (phase === "verifying") controller.abort(); },
  }), (e) => e.code === "preparation_cancelled");
  assert.deepEqual(phases, ["checking", "preparing", "verifying"]);
});

test("10. the vendored bundle is exactly the one recorded in VENDOR.md (SHA-256), and the module imports it", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const bundle = await readFile(new URL("../vendor/mediabunny/mediabunny-1.61.1.min.mjs", import.meta.url));
  const vendor = await readFile(new URL("../vendor/mediabunny/VENDOR.md", import.meta.url), "utf8");
  const recorded = /SHA-256 \| `([0-9a-f]{64})`/.exec(vendor)?.[1];
  assert.ok(recorded, "VENDOR.md records the SHA-256");
  // A checkout must not change the bytes: .gitattributes marks the bundle -text (no line-ending conversion).
  assert.equal(createHash("sha256").update(bundle).digest("hex"), recorded);
  const source = await readFile(new URL("../exercise-media-prepare.js", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/vendor\/mediabunny\/mediabunny-1\.61\.1\.min\.mjs"\)/);
});

test("9. the library that fails to load: preparation_unavailable with its own sentence; the next attempt loads again", async () => {
  let attempts = 0;
  prepare.setMediabunnyLoader(() => { attempts += 1; return Promise.reject(new Error("chunk 404")); });
  await assert.rejects(prepare.prepareVideo(file("c.mp4", 10, "video/mp4", {})), (e) => e.code === "preparation_unavailable");
  await assert.rejects(prepare.prepareVideo(file("c.mp4", 10, "video/mp4", {})), (e) => e.code === "preparation_unavailable");
  assert.equal(attempts, 2, "a failed load is not cached");
  assert.equal(prepare.describePrepareError("preparation_unavailable"), "The video tool could not be loaded. Check the connection and choose the video again.");
});
