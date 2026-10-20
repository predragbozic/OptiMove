import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The removal of a phone video's private metadata (exercise-media-metadata.js)
// on real bytes: MP4 / MOV files built box by box with what phones write
// (location, device, software, author, title, dates, XMP, Apple keys, a
// caption / timecode / timed-metadata track, track references, stale padding
// and stale media bytes, a vendor trailer), the moov before or after the
// media, one or two mdat boxes, 32- or 64-bit chunk offsets. An independent
// reader proves every kept sample is byte for byte the original and the
// structure is rebuilt (boxes left out, offsets moved), not masked; the
// playable fixtures are checked with the real Mediabunny demuxer, packet by
// packet.

const meta = await import("../exercise-media-metadata.js");
const { buildMp4, readSamples, topTypes, occurrences, MARKERS, box, bytesOf, xmpUuid, u32, u8, visualEntry, audioEntry, avcC, esds, privateUdta } = await import("./support/mp4-builder.mjs");

const sample = (seed, size) => Uint8Array.from({ length: size }, (_, i) => (seed * 31 + i * 7) & 255);
const video = (overrides = {}) => ({ id: 1, handler: "vide", samples: [sample(1, 400), sample(2, 120), sample(3, 90), sample(4, 300)], perChunk: 2, rotate: true, ...overrides });
const audio = (overrides = {}) => ({ id: 2, handler: "soun", samples: [sample(5, 60), sample(6, 64), sample(7, 58)], ...overrides });
const caption = (overrides = {}) => ({ id: 3, handler: "text", samples: [new TextEncoder().encode(MARKERS.caption)], ...overrides });
const timecode = (overrides = {}) => ({ id: 4, handler: "tmcd", samples: [Uint8Array.of(0, 0, 0, 7)], ...overrides });
const gpsTrack = (overrides = {}) => ({ id: 5, handler: "meta", samples: [new TextEncoder().encode(`GPS ${MARKERS.gps}`)], ...overrides });
const asFile = (bytes, name = "clip.mp4", type = "video/mp4") => new File([bytes], name, { type });
const bytesOfFile = async (file) => new Uint8Array(await file.arrayBuffer());

const PRIVATE_TEXTS = [MARKERS.gps, MARKERS.make, MARKERS.model, MARKERS.software, MARKERS.title, MARKERS.author, MARKERS.xmp, MARKERS.appleLocation, MARKERS.caption, MARKERS.stale, MARKERS.trailer, MARKERS.padding, "+12.3456"];

async function stripAndRead(bytes, options) {
  const { file, report } = await meta.stripPrivateMetadata(asFile(bytes), options);
  const out = await bytesOfFile(file);
  return { file, report, out, before: readSamples(bytes), after: readSamples(out) };
}

function assertSameMedia(before, after, keptIds) {
  assert.deepEqual(Object.keys(after).map(Number).sort(), [...keptIds].sort());
  for (const id of keptIds) {
    assert.equal(after[id].samples.length, before[id].samples.length, `track ${id}: same number of samples`);
    after[id].samples.forEach((s, i) => assert.deepEqual(s, before[id].samples[i], `track ${id} sample ${i} byte for byte`));
    assert.deepEqual(after[id].stsd, before[id].stsd, `track ${id}: the codec description untouched`);
    assert.deepEqual(after[id].edts, before[id].edts, `track ${id}: the edit list untouched`);
  }
}

async function assertNothingPrivate(out) {
  for (const text of PRIVATE_TEXTS) assert.equal(occurrences(out, text), 0, `no "${text}" anywhere in the file that is sent`);
  for (const type of ["udta", "keys", "ilst", "©xyz", "©mak", "©mod", "©swr", "©aut"]) assert.equal(occurrences(out, type), 0, `no ${type} box`);
  const privacy = await meta.inspectPrivacy(asFile(out));
  assert.deepEqual(privacy, { clean: true, findings: [] });
}

test("1. a phone-like MP4 with the moov at the end: location, device, software, author, title, Apple keys, XMP, padding, a caption, a timecode and a GPS track, a vendor trailer - all gone; picture and sound byte for byte; rotation, edit lists and codec descriptions kept; the times zeroed", async () => {
  const bytes = buildMp4([video({ udta: true, tref: [{ type: "tmcd", ids: [4] }, { type: "cdsc", ids: [5] }] }), audio({ udta: true }), caption(), timecode(), gpsTrack()], { topAfter: [xmpUuid()], trailer: MARKERS.trailer });
  const before = await meta.inspectPrivacy(asFile(bytes));
  assert.equal(before.clean, false);
  for (const finding of ["trailer", "top:uuid", "marker:©xyz", "box:udta", "box:meta", "track:text", "track:tmcd", "track:meta", "time:mvhd"]) assert.ok(before.findings.includes(finding), `the original shows ${finding}`);
  const { report, out, before: b, after: a } = await stripAndRead(bytes);
  assertSameMedia(b, a, [1, 2]);
  await assertNothingPrivate(out);
  assert.deepEqual(topTypes(out), ["ftyp", "mdat", "moov"], "only ftyp, mdat and moov, nothing after them");
  assert.deepEqual(report.removed.tracks.sort(), ["meta", "text", "tmcd"]);
  assert.ok(report.removed.boxes.includes("udta") && report.removed.boxes.includes("meta") && report.removed.boxes.includes("uuid") && report.removed.boxes.includes("free"));
  assert.equal(report.removed.trailerBytes, MARKERS.trailer.length);
  assert.equal(a[1].tref, null, "references to removed tracks are dropped (here the whole tref)");
  // Rotation (the tkhd matrix) stays; only the two times are zero.
  const tkhdBefore = b[1].tkhd, tkhdAfter = a[1].tkhd;
  assert.deepEqual(tkhdAfter.subarray(20), tkhdBefore.subarray(20), "track id, duration, matrix (rotation 90) and size untouched");
  assert.deepEqual([...tkhdAfter.subarray(12, 20)], [0, 0, 0, 0, 0, 0, 0, 0], "creation and modification times zeroed");
  assert.deepEqual(a[1].mdhd.subarray(20), b[1].mdhd.subarray(20), "timescale, duration and language untouched");
  assert.ok(out.length < bytes.length);
});

test("2. the moov before the media (faststart) with private boxes in front of the mdat: the mdat moves and every chunk offset moves with it, exactly", async () => {
  const bytes = buildMp4([video(), audio(), caption()], { moovFirst: true, topBeforeMdat: [box("free", MARKERS.padding), xmpUuid()] });
  const { out, before: b, after: a, report } = await stripAndRead(bytes);
  assert.deepEqual(topTypes(out), ["ftyp", "moov", "mdat"]);
  assertSameMedia(b, a, [1, 2]);
  await assertNothingPrivate(out);
  assert.ok(report.removed.topBoxes.includes("free") && report.removed.topBoxes.includes("uuid"));
});

test("3. 64-bit chunk offsets (co64) and two mdat boxes: each chunk moves with its own mdat", async () => {
  const bytes = buildMp4([video({ co64: true, perChunk: 1 }), audio({ perChunk: 1 }), gpsTrack()], { mdatSplit: true, topBeforeMdat: [xmpUuid()] });
  assert.equal(topTypes(bytes).filter((t) => t === "mdat").length, 2);
  const { out, before: b, after: a } = await stripAndRead(bytes);
  assertSameMedia(b, a, [1, 2]);
  await assertNothingPrivate(out);
});

test("4. track references are left out entirely (one picture and one sound track need none), whatever their type", async () => {
  const bytes = buildMp4([video({ tref: [{ type: "cdsc", ids: [2, 5] }, { type: "meta", ids: [2] }] }), audio(), gpsTrack()]);
  const { report, out, before, after: a } = await stripAndRead(bytes);
  assert.equal(a[1].tref, null, "no tref in the file that is sent");
  assert.equal(occurrences(out, "tref"), 0);
  assert.ok(report.removed.boxes.includes("tref"));
  assertSameMedia(before, a, [1, 2]);
  assert.ok((await meta.inspectPrivacy(asFile(bytes))).findings.includes("box:tref"), "the check flags a tref in the raw file");
});

test("5. stale private data in an unused part of the mdat and the removed tracks' samples are written as zero: nothing of them can be recovered from the file that is sent", async () => {
  const bytes = buildMp4([video(), audio(), caption(), gpsTrack()], { staleInMdat: MARKERS.stale });
  assert.equal(occurrences(bytes, MARKERS.stale), 1);
  const { out, report, before: b, after: a } = await stripAndRead(bytes);
  assert.equal(occurrences(out, MARKERS.stale), 0);
  assert.equal(occurrences(out, MARKERS.caption), 0);
  assert.equal(occurrences(out, MARKERS.gps), 0);
  assert.ok(report.removed.zeroedBytes >= MARKERS.stale.length + MARKERS.caption.length);
  assertSameMedia(b, a, [1, 2]);
});

test("6. a QuickTime (MOV) structure is cleaned the same way (the app remuxes a MOV first; the cleaning itself is not MP4-only)", async () => {
  const bytes = buildMp4([video({ udta: true }), audio(), timecode()], { brand: "qt  ", topAfter: [xmpUuid()] });
  const { out, before: b, after: a } = await stripAndRead(bytes);
  assertSameMedia(b, a, [1, 2]);
  await assertNothingPrivate(out);
});

test("7. a file that is already clean comes out the same media, still clean (idempotent)", async () => {
  const bytes = buildMp4([video(), audio(), caption()], { topAfter: [xmpUuid()], trailer: MARKERS.trailer });
  const first = await stripAndRead(bytes);
  const second = await stripAndRead(first.out);
  assert.deepEqual(second.out, first.out, "a second pass changes nothing");
  assert.deepEqual(second.report.removed.tracks, []);
  assert.deepEqual(second.report.removed.boxes, []);
});

test("8. structures the cleaning does not handle are refused with a reason (the caller then remuxes or refuses - it never sends the original)", async () => {
  const cases = [
    ["fragmented", buildMp4([video(), audio()], { mvex: true })],
    ["fragmented", bytesOf(buildMp4([video(), audio()]), box("moof", new Uint8Array(8)))],
    ["compact_sample_sizes", buildMp4([video(), audio()], { stz2: true })],
    ["external_data", buildMp4([video(), audio()], { externalData: true })],
    ["track_count", buildMp4([audio({ id: 1 })])],
    ["no_ftyp", buildMp4([video(), audio()]).subarray(24)],
    // More media no kept sample uses than the bound (a large removed track): not zeroed in memory.
    ["too_much_unused_data", buildMp4([video(), audio(), { id: 3, handler: "meta", samples: [new Uint8Array(8 * 1024 * 1024 + 1)] }])],
    // A sample-table child this code does not know (it is not kept unchecked), and one that points into the file by itself.
    ["unknown_sample_table_box", buildMp4([video({ stblExtra: [box("zzzz", MARKERS.gps)] }), audio()])],
    ["unknown_sample_table_box", buildMp4([video({ stblExtra: [box("saio", u32(0), u32(1), u32(4))] }), audio()])],
  ];
  for (const [reason, bytes] of cases) {
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.code === "metadata_unsupported" && e.reason === reason, reason);
  }
  // A chunk offset that points outside every mdat.
  const good = buildMp4([video({ perChunk: 1 }), audio()]);
  const bad = good.slice();
  const at = occurrences(bad, "stco") && bad.findIndex((_, i) => bad[i] === 0x73 && bad[i + 1] === 0x74 && bad[i + 2] === 0x63 && bad[i + 3] === 0x6f);
  new DataView(bad.buffer).setUint32(at + 4 + 8, 3); // the first chunk offset -> inside ftyp
  await assert.rejects(meta.stripPrivateMetadata(asFile(bad)), (e) => e.reason === "chunk_outside_mdat" || e.reason === "sample_outside_mdat");
  // The last sample starts inside the mdat but its size runs past the mdat's end (into the moov).
  const long = good.slice();
  const stszAt = (from) => long.findIndex((_, i) => i >= from && long[i] === 0x73 && long[i + 1] === 0x74 && long[i + 2] === 0x73 && long[i + 3] === 0x7a);
  const audioStsz = stszAt(stszAt(0) + 4) - 4;
  const lv = new DataView(long.buffer);
  const count = lv.getUint32(audioStsz + 16);
  lv.setUint32(audioStsz + 20 + 4 * (count - 1), lv.getUint32(audioStsz + 20 + 4 * (count - 1)) + 100);
  await assert.rejects(meta.stripPrivateMetadata(asFile(long)), (e) => e.reason === "sample_outside_mdat");
  assert.ok((await meta.inspectPrivacy(asFile(long))).findings.includes("sample_outside_mdat"));
  // A broken box size inside the moov.
  const broken = good.slice();
  const trak = broken.findIndex((_, i) => broken[i] === 0x74 && broken[i + 1] === 0x72 && broken[i + 2] === 0x61 && broken[i + 3] === 0x6b);
  new DataView(broken.buffer).setUint32(trak - 4, 0xffffff);
  await assert.rejects(meta.stripPrivateMetadata(asFile(broken)), (e) => e.code === "metadata_unsupported");
  // Garbage that is not an MP4 at all.
  await assert.rejects(meta.stripPrivateMetadata(asFile(new TextEncoder().encode("not a video at all, just text"))), (e) => e.code === "metadata_unsupported");
});

test("9. a Cancel stops the cleaning (before it starts and between reads)", async () => {
  const bytes = buildMp4([video(), audio()]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(meta.stripPrivateMetadata(asFile(bytes), { signal: controller.signal }), (e) => e.code === "preparation_cancelled");
  // Aborted after the first read: the next read stops it.
  const late = new AbortController();
  const file = asFile(bytes);
  const slice = file.slice.bind(file);
  let reads = 0;
  file.slice = (...args) => { reads += 1; if (reads === 2) late.abort(); return slice(...args); };
  await assert.rejects(meta.stripPrivateMetadata(file, { signal: late.signal }), (e) => e.code === "preparation_cancelled");
});

test("10. memory: a 40 MB file is cleaned reading only its box headers and its moov - the media is never read into memory", async () => {
  const big = Uint8Array.from({ length: 40 * 1024 * 1024 }, (_, i) => i & 255);
  const bytes = buildMp4([video({ samples: [big.subarray(0, 20 * 1024 * 1024), big.subarray(20 * 1024 * 1024)], perChunk: 1 }), audio(), caption()], { topAfter: [xmpUuid()] });
  const file = asFile(bytes);
  const t0 = performance.now();
  const { file: out, report } = await meta.stripPrivateMetadata(file);
  const ms = performance.now() - t0;
  assert.ok(report.bytesRead < 64 * 1024, `read ${report.bytesRead} bytes of a ${bytes.length}-byte file`);
  assert.ok(report.bytesInMemory < 64 * 1024, `held ${report.bytesInMemory} bytes`);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  assert.ok(out.size < bytes.length && out.size > 40 * 1024 * 1024, "the media is all there, the private parts are not");
  const after = readSamples(await bytesOfFile(out));
  assert.equal(after[1].samples[1].length, 20 * 1024 * 1024);
  assert.equal(after[1].samples[1][12345], (20 * 1024 * 1024 + 12345) & 255);
});

test("11. the independent check names each kind of leftover it finds", async () => {
  const dirty = buildMp4([video({ tref: [{ type: "cdsc", ids: [9] }] }), audio(), caption()], { staleInMdat: MARKERS.stale, topAfter: [xmpUuid()], trailer: MARKERS.trailer });
  const { findings } = await meta.inspectPrivacy(asFile(dirty));
  for (const finding of ["trailer", "top:uuid", "box:udta", "box:meta", "track:text", "time:mvhd", "time:tkhd", "time:mdhd", "tref:dangling", "unused_data_not_zero", "marker:©xyz", "marker:xmp_uuid"]) {
    assert.ok(findings.includes(finding), `finds ${finding} (got ${findings.join(", ")})`);
  }
  assert.deepEqual(await meta.inspectPrivacy(asFile(new TextEncoder().encode("garbage"))), { clean: false, findings: ["trailer", "ftyp", "moov"] });
  // A sample-table child outside the kept tables is a finding.
  const odd = await meta.inspectPrivacy(asFile(buildMp4([video({ stblExtra: [box("zzzz", u32(1))] }), audio()], { moovPrivate: false, times: 0 })));
  assert.ok(odd.findings.includes("box:zzzz"), odd.findings.join(", "));
  // Unused media larger than the bound is not read in full: it is a finding of its own.
  const large = await meta.inspectPrivacy(asFile(buildMp4([video(), audio()], { staleInMdat: "x".repeat(8 * 1024 * 1024 + 1), moovPrivate: false, times: 0 })));
  assert.ok(large.findings.includes("unused_data_too_large"), large.findings.join(", "));
  assert.equal(large.clean, false);
});

test("12. real playable phone-like files (made in Chrome): every packet of the picture and the sound is the same after the cleaning, read by the real Mediabunny demuxer; rotation kept; nothing private left", async () => {
  const MB = await import("../vendor/mediabunny/mediabunny-1.61.1.min.mjs");
  const fixtures = new URL("../../backend/tests/fixtures/media/", import.meta.url);
  const packets = async (file) => {
    const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
    const out = {};
    for (const track of await input.getTracks()) {
      const list = [];
      for await (const p of new MB.EncodedPacketSink(track).packets()) list.push([p.timestamp, p.duration, p.type, Buffer.from(p.data).toString("hex")]);
      out[track.isVideoTrack() ? "video" : "audio"] = { list, rotation: track.isVideoTrack() ? await track.getRotation() : null, codec: await track.getCodecParameterString() };
    }
    input.dispose();
    return out;
  };
  for (const name of ["phone-like-gps-moov-end.mp4", "h264-aac-text-track.mp4", "converted-hevc-rot90.mp4"]) {
    const original = asFile(new Uint8Array(await readFile(new URL(name, fixtures))), name);
    const { file } = await meta.stripPrivateMetadata(original);
    const before = await packets(original);
    const after = await packets(file);
    assert.deepEqual(after, before, `${name}: the same packets, timestamps, rotation and codecs`);
    const privacy = await meta.inspectPrivacy(file);
    assert.deepEqual(privacy, { clean: true, findings: [] }, name);
  }
});

test("13. the sample tables playback needs (sync samples, composition offsets) are kept byte for byte; the dependency flags (sdtp, one free byte per sample) and metadata placed inside the sample table are left out", async () => {
  const { privateUdta } = await import("./support/mp4-builder.mjs");
  const stss = box("stss", u32(0), u32(2), u32(1), u32(3));
  const ctts = box("ctts", u32(0), u32(1), u32(4), u32(500));
  const sdtp = box("sdtp", u32(0), Uint8Array.of(0x20, 0x10, 0x10, 0x10));
  const bytes = buildMp4([video({ stblExtra: [stss, ctts, sdtp, privateUdta()] }), audio()]);
  const { report, out, before, after } = await stripAndRead(bytes);
  assertSameMedia(before, after, [1, 2]);
  for (const table of [stss, ctts]) assert.equal(occurrences(out, table), 1, "kept exactly once, unchanged");
  assert.equal(occurrences(out, "sdtp"), 0, "sdtp left out");
  assert.ok(report.removed.boxes.includes("udta") && report.removed.boxes.includes("sdtp"));
  await assertNothingPrivate(out);
});

test("14. a camera-like file whose encoder writes its name into the handler names and the video sample description, with a QuickTime data handler in minf: the names are gone (the hdlr rebuilt shorter, the fixed compressorname zeroed), the video track stays a video track, the rest of the codec description is untouched", async () => {
  const { visualEntry } = await import("./support/mp4-builder.mjs");
  const bytes = buildMp4([video({ compressor: "GoPro AVC encoder", hdlrName: "GoPro AVC  ", minfHdlr: true }), audio({ hdlrName: "GoPro AAC  " })], { moovPrivate: false });
  const before = await meta.inspectPrivacy(asFile(bytes));
  for (const finding of ["text:hdlr", "text:compressorname"]) assert.ok(before.findings.includes(finding), `the original shows ${finding}`);
  const { report, out, before: b, after: a } = await stripAndRead(bytes);
  assert.equal(occurrences(out, "GoPro"), 0, "no encoder name anywhere in the file that is sent");
  assert.equal(a[1].handler, "vide", "the data handler in minf did not rename the video track");
  assert.equal(a[2].handler, "soun");
  assert.ok(report.removed.boxes.includes("hdlr"), "the minf data handler is left out");
  assert.equal(occurrences(out, "hdlr"), 2, "one handler per kept track");
  a[1].samples.forEach((s, i) => assert.deepEqual(s, b[1].samples[i]));
  a[2].samples.forEach((s, i) => assert.deepEqual(s, b[2].samples[i]));
  // The video sample description: identical except the 32 bytes of compressorname (at 50 in the entry, the entry at 16 in stsd).
  assert.equal(a[1].stsd.length, b[1].stsd.length);
  assert.deepEqual(a[1].stsd.subarray(0, 66), b[1].stsd.subarray(0, 66));
  assert.deepEqual([...a[1].stsd.subarray(66, 98)], new Array(32).fill(0));
  assert.deepEqual(a[1].stsd.subarray(98), b[1].stsd.subarray(98));
  assert.equal(visualEntry("x", []).length, 86, "the fixed part of a VisualSampleEntry");
  assert.deepEqual(a[2].stsd, b[2].stsd, "the sound description untouched");
  await assertNothingPrivate(out);
  // A second pass changes nothing.
  const again = await stripAndRead(out);
  assert.deepEqual(again.out, out);
});

test("15. a 64-bit mdat header (moov first and last), an mdat that runs to the end of the file, and version-1 (64-bit) times: cleaned, the media byte for byte, the mdat header as it was, the times zero, the rest of each header untouched", async () => {
  const cases = [
    { largeMdat: true, moovFirst: true, topBeforeMdat: [xmpUuid()] },
    { largeMdat: true, topAfter: [xmpUuid()], trailer: MARKERS.trailer },
    { mdatToEnd: true, moovFirst: true, topBeforeMdat: [box("free", MARKERS.padding)] },
  ];
  for (const options of cases) {
    const bytes = buildMp4([video({ co64: true }), audio(), gpsTrack()], { ...options, timesVersion: 1 });
    const { out, before, after } = await stripAndRead(bytes);
    assertSameMedia(before, after, [1, 2]);
    await assertNothingPrivate(out);
    const mdatIn = bytes.findIndex((_, i) => bytes[i] === 0x6d && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x61 && bytes[i + 3] === 0x74) - 4;
    const mdatOut = out.findIndex((_, i) => out[i] === 0x6d && out[i + 1] === 0x64 && out[i + 2] === 0x61 && out[i + 3] === 0x74) - 4;
    const head = options.largeMdat ? 16 : 8;
    assert.deepEqual(out.subarray(mdatOut, mdatOut + head), bytes.subarray(mdatIn, mdatIn + head), "the mdat header (64-bit size or size 0) as it was");
    for (const id of [1, 2]) {
      assert.equal(after[id].tkhd[8], 1, "still a version-1 tkhd");
      assert.deepEqual([...after[id].tkhd.subarray(12, 28)], new Array(16).fill(0), "both 64-bit times zero");
      assert.deepEqual(after[id].tkhd.subarray(28), before[id].tkhd.subarray(28), "track id, duration, matrix and size untouched");
      assert.deepEqual([...after[id].mdhd.subarray(12, 28)], new Array(16).fill(0));
      assert.deepEqual(after[id].mdhd.subarray(28), before[id].mdhd.subarray(28), "timescale, 64-bit duration and language untouched");
    }
  }
});

// A private text hidden where the reviews said a careless cleaning would keep
// it. Each place is either rebuilt without it, or the file is refused (the
// caller then remuxes); the check flags the raw file either way.
const CANARY = "CANARY-PRIVATE-TEXT";
const canary = new TextEncoder().encode(CANARY);
// A file the cleaning would not change (zero times, empty handler names, no
// private boxes), so the canary is the only thing a check can find.
const plain = (overrides = {}, options = {}) => buildMp4([video({ hdlrName: "", ...overrides.video }), audio({ hdlrName: "", ...overrides.audio })], { moovPrivate: false, zeroTimes: true, ...options });

test("16. a private text hidden in a kept box: rebuilt without it, or the file refused - never sent; the check flags the raw file", async () => {
  assert.deepEqual(await meta.inspectPrivacy(asFile(plain())), { clean: true, findings: [] }, "the base file is clean, so each finding below comes from the canary");
  const dropped = [
    ["a location string after a self-contained data reference", plain({ video: { drefText: CANARY } }), "moov_not_canonical"],
    ["a udta inside dinf", plain({ video: { dinfExtra: [box("udta", CANARY)] } }), "moov_not_canonical"],
    ["a udta inside edts", plain({ video: { edtsExtra: [box("udta", CANARY)] } }), "moov_not_canonical"],
    ["an iods with text", plain({}, { iods: canary }), "box:iods"],
    ["the hdlr's reserved bytes", plain({ video: { hdlrReserved: canary.subarray(0, 12) } }), "moov_not_canonical"],
    ["the video entry's vendor and quality fields", plain({ video: { entry: visualEntry("", [avcC()], { vendor: CANARY }) } }), "moov_not_canonical"],
    ["the sound entry's vendor field", plain({ audio: { entry: audioEntry([esds()], { vendor: "CNRY" }) } }), "moov_not_canonical"],
  ];
  for (const [label, bytes, finding] of dropped) {
    const marker = label.includes("sound entry") ? "CNRY" : label.includes("hdlr") || label.includes("vendor") ? "CANARY-PRIVA" : CANARY;
    assert.ok(occurrences(bytes, marker) > 0, `${label}: the canary is in the input`);
    const raw = await meta.inspectPrivacy(asFile(bytes));
    assert.ok(!raw.clean && raw.findings.includes(finding), `${label}: the check flags the raw file with ${finding} (got ${raw.findings.join(", ")})`);
    const { out, before, after } = await stripAndRead(bytes);
    assert.equal(occurrences(out, marker), 0, `${label}: not in the file that is sent`);
    for (const id of [1, 2]) after[id].samples.forEach((s, i) => assert.deepEqual(s, before[id].samples[i], `${label}: track ${id} sample ${i}`));
    assert.deepEqual(await meta.inspectPrivacy(asFile(out)), { clean: true, findings: [] }, label);
  }
  const refused = [
    ["ftyp", "text after the brands", plain({}, { ftyp: box("ftyp", "isom", u32(0x200), "isom", CANARY) })],
    ["ftyp", "an oversized ftyp", plain({}, { ftyp: box("ftyp", "isom", u32(0x200), ...new Array(40).fill("isom")) })],
    ["ftyp_count", "a second ftyp after the moov", bytesOf(plain(), box("ftyp", "isom", u32(0), "CANARY-PRIVATE-TEXTX"))],
    ["box_size", "bytes after the mvhd's fields", plain({}, { mvhdSlack: canary })],
    ["box_size", "bytes after the tkhd's fields", plain({ video: { slack: { tkhd: canary } } })],
    ["box_size", "bytes after the mdhd's fields", plain({ video: { slack: { mdhd: canary } } })],
    ["table_shape", "bytes after the stts entries", plain({ video: { slack: { stts: canary } } })],
    ["table_shape", "bytes after the stsz entries", plain({ video: { slack: { stsz: canary } } })],
    ["table_shape", "bytes after the stco entries", plain({ video: { slack: { stco: canary } } })],
    ["table_shape", "bytes after the elst entries", plain({ video: { slack: { elst: canary } } })],
    ["sample_entry_box", "a udta inside the video entry", plain({ video: { entry: visualEntry("", [avcC(), box("udta", CANARY)]) } })],
    ["sample_entry_box", "an ICC profile (colr prof) with a description", plain({ video: { entry: visualEntry("", [avcC(), box("colr", "prof", CANARY)]) } })],
    ["codec_config", "text after the avcC's parameter sets", plain({ video: { entry: visualEntry("", [avcC({ trailing: canary })]) } })],
    ["codec_config", "an esds with a URL", plain({ audio: { entry: audioEntry([esds({ url: canary })]) } })],
    ["codec_config", "an esds with another descriptor", plain({ audio: { entry: audioEntry([esds({ extra: bytesOf(u8(0x0e, canary.length), canary) })]) } })],
    ["sample_entry_box", "a udta inside the sound entry", plain({ audio: { entry: audioEntry([esds(), box("udta", CANARY)]) } })],
    ["sample_description", "a QuickTime sound description of version 1", plain({ audio: { entry: box("mp4a", new Uint8Array(6), u8(0, 1), u8(0, 1, 0, 0), new Uint8Array(4), u8(0, 2), u8(0, 16), u8(0, 0), u8(0, 0), u32(48000 * 65536), new Uint8Array(16), esds()) } })],
    ["track_count", "a second video track", buildMp4([video(), audio(), video({ id: 3, rotate: false })], { moovPrivate: false })],
    ["duplicate_sample_table", "two chunk-offset tables", plain({ video: { stblExtra: [box("stco", u32(0), u32(1), u32(1000))] } })],
  ];
  for (const [reason, label, bytes] of refused) {
    const raw = await meta.inspectPrivacy(asFile(bytes));
    assert.equal(raw.clean, false, `${label}: the check flags the raw file`);
    if (!["ftyp_count", "track_count", "duplicate_sample_table"].includes(reason)) assert.ok(raw.findings.includes(`structure:${reason}`), `${label}: structure:${reason} (got ${raw.findings.join(", ")})`);
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.code === "metadata_unsupported" && e.reason === reason, `${label}: refused as ${reason}`);
  }
});

test("17. hostile sizes are refused quickly, not worked through: too many samples behind a constant-size table, too many gaps, two tracks sharing bytes", async () => {
  const one = Uint8Array.of(7);
  const timed = async (bytes, reason) => {
    const started = performance.now();
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.reason === reason, reason);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${reason} in ${ms.toFixed(0)} ms`);
  };
  // 200,001 samples of one size in one chunk: the stsz is 20 bytes.
  await timed(buildMp4([video({ samples: new Array(meta.METADATA_LIMITS.maxSamples + 1).fill(one), perChunk: meta.METADATA_LIMITS.maxSamples + 1, uniform: true }), audio()], { moovPrivate: false }), "too_many_samples");
  // 10,001 one-byte video chunks interleaved with a removed track's chunks: as many gaps.
  const n = meta.METADATA_LIMITS.maxHoles + 1;
  await timed(buildMp4([video({ samples: new Array(n).fill(one), perChunk: 1 }), { id: 5, handler: "meta", samples: new Array(n).fill(one) }], { moovPrivate: false, interleave: true }), "too_many_holes");
  // The sound's chunk offsets pointing into the picture's bytes.
  const shared = plain();
  const stcos = [];
  for (let i = 0; i + 4 <= shared.length; i += 1) if (shared[i] === 0x73 && shared[i + 1] === 0x74 && shared[i + 2] === 0x63 && shared[i + 3] === 0x6f) stcos.push(i - 4);
  const sv = new DataView(shared.buffer);
  const firstVideoChunk = sv.getUint32(stcos[0] + 16);
  for (let k = 0; k < sv.getUint32(stcos[1] + 12); k += 1) sv.setUint32(stcos[1] + 16 + 4 * k, firstVideoChunk);
  await timed(shared, "sample_overlap");
  assert.equal((await meta.inspectPrivacy(asFile(shared))).clean, false);
});

test("18. a chunk map a decoder would read another way is refused, never cleaned: a first run that does not start at chunk 1, a run without samples, a sample description other than 1", async () => {
  const samples = video().samples;
  const cases = [
    ["first run at chunk 2", video({ perChunk: 1, leadingChunks: 1, stscEntries: [[2, 1, 1]] })],
    ["a run of 0 samples", video({ perChunk: 1, leadingChunks: 1, stscEntries: [[1, 0, 1], [2, 1, 1]] })],
    ["sample description 2", video({ perChunk: 1, stscEntries: [[1, 1, 2]] })],
  ];
  for (const [label, track] of cases) {
    assert.equal(track.samples.length, samples.length);
    const bytes = buildMp4([track, audio()], { moovPrivate: false });
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.code === "metadata_unsupported" && e.reason === "chunk_map_broken", label);
    assert.ok((await meta.inspectPrivacy(asFile(bytes))).findings.includes("structure:chunk_map_broken"), label);
  }
  // The same samples in the standard map are cleaned as usual.
  const { before, after } = await stripAndRead(buildMp4([video({ perChunk: 1, stscEntries: [[1, 1, 1]] }), audio()], { moovPrivate: false }));
  assertSameMedia(before, after, [1, 2]);
});

test("19. a box that may appear once and appears twice is refused, one that must be there is required, the media header must match the track", async () => {
  const fixed = (type, length) => box(type, new Uint8Array(length));
  const dref = box("dinf", box("dref", u32(0), u32(1), box("url ", u32(1))));
  const cases = [
    ["duplicate_box", "a second tkhd (same track id)", plain({ video: { trakExtra: [box("tkhd", new Uint8Array(12), u32(1), new Uint8Array(68))] } })],
    ["duplicate_box", "a second edts", plain({ video: { trakExtra: [box("edts", box("elst", u32(0), u32(0)))] } })],
    ["duplicate_box", "a second mdhd", plain({ video: { mdiaExtra: [fixed("mdhd", 24)] } })],
    ["duplicate_box", "a second hdlr naming another handler", plain({ video: { mdiaExtra: [box("hdlr", u32(0), u32(0), "GPS!", new Uint8Array(12), u8(0))] } })],
    ["duplicate_box", "a second hdlr before the real one", plain({ video: { mdiaExtra: [box("hdlr", u32(0), u32(0), "vide", new Uint8Array(12), u8(0))], hdlrName: "GPS!" } })],
    ["duplicate_box", "a second dinf", plain({ video: { minfExtra: [dref] } })],
    ["duplicate_box", "a second vmhd", plain({ video: { minfExtra: [box("vmhd", u32(1), new Uint8Array(8))] } })],
    ["duplicate_box", "a second avcC", plain({ video: { entry: visualEntry("", [avcC(), avcC()]) } })],
    ["duplicate_box", "a second esds", plain({ audio: { entry: audioEntry([esds(), esds()]) } })],
    ["box_missing", "no avcC", plain({ video: { entry: visualEntry("", []) } })],
    ["box_missing", "no esds", plain({ audio: { entry: audioEntry([]) } })],
    ["media_header", "a sound header in the picture track", plain({ video: { minfExtra: [box("smhd", new Uint8Array(8))] } })],
  ];
  for (const [reason, label, bytes] of cases) {
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.code === "metadata_unsupported" && e.reason === reason, `${label}: ${reason}`);
    assert.ok((await meta.inspectPrivacy(asFile(bytes))).findings.includes(`structure:${reason}`), label);
  }
  assert.equal(occurrences(plain({ video: { mdiaExtra: [box("hdlr", u32(0), u32(0), "GPS!", new Uint8Array(12), u8(0))] } }), "GPS!"), 1, "the canary is in the refused input");
});

test("20. nested boxes have plain 32-bit sizes, and a box holds at most 4096 children: a size-0 or 64-bit box inside the moov, and a million padding boxes, are refused quickly", async () => {
  const zeroSized = avcC();
  zeroSized.set([0, 0, 0, 0], 0); // the last child of the entry, "to the end"
  const wide = bytesOf(u32(1), "btrt", u32(0), u32(20), new Uint8Array(12)); // a 64-bit size inside the entry
  for (const [label, entry] of [["a size-0 avcC", visualEntry("", [zeroSized])], ["a 64-bit btrt", visualEntry("", [avcC(), wide])]]) {
    const bytes = plain({ video: { entry } });
    await assert.rejects(meta.stripPrivateMetadata(asFile(bytes)), (e) => e.reason === "broken_box", label);
    assert.ok((await meta.inspectPrivacy(asFile(bytes))).findings.includes("structure:broken_box"), label);
  }
  const padding = new Uint8Array(8 * 1_000_000);
  const pv = new DataView(padding.buffer);
  for (let i = 0; i < 1_000_000; i += 1) { pv.setUint32(8 * i, 8); padding.set([0x66, 0x72, 0x65, 0x65], 8 * i + 4); }
  const crowded = plain({}, { moovExtra: [padding] });
  let started = performance.now();
  await assert.rejects(meta.stripPrivateMetadata(asFile(crowded)), (e) => e.reason === "too_many_boxes");
  assert.ok(performance.now() - started < 1500, `refused in ${(performance.now() - started).toFixed(0)} ms`);
  started = performance.now();
  assert.equal((await meta.inspectPrivacy(asFile(crowded))).clean, false);
  assert.ok(performance.now() - started < 1500, `checked in ${(performance.now() - started).toFixed(0)} ms`);
});

test("21. the marker search takes the same time whatever the moov holds: a valid 15 MB composition table full of 0xA9 (the first byte of ten markers) is checked quickly, and a real marker inside numbers is still found", async () => {
  const n = Math.floor((15 * 1024 * 1024) / 8);
  const ctts = box("ctts", u32(0), u32(n), new Uint8Array(8 * n).fill(0xa9));
  const { out } = await stripAndRead(plain({ video: { stblExtra: [ctts] } }));
  const started = performance.now();
  assert.deepEqual(await meta.inspectPrivacy(asFile(out)), { clean: true, findings: [] });
  const ms = performance.now() - started;
  assert.ok(ms < 1500, `checked in ${ms.toFixed(0)} ms`);
  const marked = new Uint8Array(8 * 4);
  marked.set([0xa9, 0x78, 0x79, 0x7a], 9); // "©xyz" across two entries
  const found = await meta.inspectPrivacy(asFile(plain({ video: { stblExtra: [box("ctts", u32(0), u32(4), marked)] } })));
  assert.ok(found.findings.includes("marker:©xyz"), found.findings.join(", "));
});
