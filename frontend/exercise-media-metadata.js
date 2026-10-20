// Removes the private metadata of an MP4 a phone recorded - location, device,
// software, author, title, XMP, recording dates, every track that is neither
// picture nor sound, and anything appended after the last box - without
// re-encoding and without remuxing the media.
//
// The rule: every box that is kept has a known shape and is rebuilt in its
// canonical form; anything that is not a known shape is refused, so the
// caller remuxes instead of keeping bytes nobody checked.
//
//  - top level: exactly one ftyp (first, small, readable brands), exactly one
//    moov, the mdat boxes; every other box and whatever follows the last box
//    are left out;
//  - the moov is rebuilt from an allowlist: mvhd; one picture track and at
//    most one sound track, each with exactly one tkhd, edts (only its elst),
//    mdia / mdhd / hdlr / minf / vmhd or smhd / dinf / stbl. udta, meta, uuid,
//    iods, tref (one picture and one sound track need no references), free /
//    skip / wide, any vendor box and every other track are left out, not
//    masked; a box that may appear once and appears twice is refused;
//  - fixed-size boxes must have their exact size; their creation and
//    modification times and their reserved / vendor fields are written as 0;
//    the hdlr name is rebuilt empty; dinf is rebuilt as one dref of
//    self-contained `url ` entries (no string, no alias record);
//  - the sample tables must have their exact size (no bytes after their
//    entries); sdtp / stps are left out; any other table is refused;
//  - the sample description: exactly one entry, avc1 / avc3 for the picture,
//    mp4a for the sound; its reserved, vendor and compressorname fields are
//    written as 0; its children must be known codec boxes of a known shape
//    (avcC and esds parsed to their end, colr only nclx / nclc);
//  - the chunk offsets of the kept tracks move by exactly the number of bytes
//    removed in front of their mdat;
//  - inside each mdat, every byte no kept sample uses (a removed track's
//    samples, stale data) is written as zero in the output - raw media
//    payload, so a zero there is correct structure - and nothing of it can be
//    recovered from the file that is sent; the samples of the picture and the
//    sound are the original bytes, untouched.
//
// Only the ftyp, the moov and the zero fills are held in memory; the rest of
// the output is slices of the chosen File. Anything this code cannot account
// for throws MetadataUnsupported (`reason`), and the caller falls back to a
// remux, never to the original. Not covered: data inside the codec bitstream
// itself (for example H.264 SEI user data) and deliberately crafted values in
// numeric fields.

export const METADATA_LIMITS = Object.freeze({
  maxTopBoxes: 256,
  maxFtypBytes: 128,
  maxMoovBytes: 16 * 1024 * 1024,
  maxZeroedBytes: 8 * 1024 * 1024,
  maxHoles: 10_000,
  maxDepth: 12,
  maxTracks: 32,
  // children of one box (a real moov has a few dozen per parent)
  maxChildBoxes: 4096,
  // all kept tracks together; a 30-second phone video has a few thousand
  maxSamples: 200_000,
  maxChunks: 200_000,
  maxDataReferences: 16,
  maxAudioConfigBytes: 64,
});

export class MetadataUnsupported extends Error {
  constructor(reason) {
    super(`metadata_unsupported:${reason}`);
    this.code = "metadata_unsupported";
    this.reason = reason;
  }
}

const unsupported = (reason) => new MetadataUnsupported(reason);
const cancelled = () => Object.assign(new Error("preparation_cancelled"), { code: "preparation_cancelled" });

// What a rebuilt moov keeps, per level (everything else is left out).
const KEEP = Object.freeze({
  moov: new Set(["mvhd", "trak"]),
  trak: new Set(["tkhd", "edts", "mdia"]),
  mdia: new Set(["mdhd", "hdlr", "minf"]),
  minf: new Set(["vmhd", "smhd", "dinf", "stbl"]),
});
// stbl: metadata and tables playback does not need are left out; the tables
// it needs are kept at their exact shape; anything else is refused.
const STBL_DROP = new Set(["udta", "meta", "uuid", "free", "skip", "wide", "sdtp", "stps"]);
const STBL_TABLES = Object.freeze({ stts: 8, ctts: 8, stss: 4, stsc: 12, stco: 4, co64: 8 }); // bytes per entry
const STBL_KEEP = new Set(["stsd", "stsz", "cslg", ...Object.keys(STBL_TABLES)]);
const KEEP_HANDLERS = new Set(["vide", "soun"]);
const KEEP_TOP = new Set(["ftyp", "moov", "mdat"]);

// Fixed-size full boxes: the payload size and the fields written as zero
// (creation / modification times, reserved and QuickTime vendor fields),
// as [from, to) from the start of the payload, per version 0 / 1.
const FIXED = Object.freeze({
  mvhd: { payload: [100, 112], zero: [[[4, 12], [26, 36], [72, 96]], [[4, 20], [38, 48], [84, 108]]], time: [[4, 12], [4, 20]] },
  tkhd: { payload: [84, 96], zero: [[[4, 12], [16, 20], [24, 32], [38, 40]], [[4, 20], [24, 28], [36, 44], [50, 52]]], time: [[4, 12], [4, 20]] },
  mdhd: { payload: [24, 36], zero: [[[4, 12], [22, 24]], [[4, 20], [34, 36]]], time: [[4, 12], [4, 20]] },
});
const TIMED = new Set(Object.keys(FIXED));

// Sample entries: the fixed part, the fields written as zero (from the start
// of the entry), the children allowed and their exact sizes (null: parsed).
const ENTRIES = Object.freeze({
  vide: { types: new Set(["avc1", "avc3"]), fixed: 86, zero: [[8, 14], [16, 32], [44, 48], [50, 82]], children: { avcC: null, btrt: 20, pasp: 16, colr: null, clap: 40, fiel: 10 } },
  soun: { types: new Set(["mp4a"]), fixed: 36, zero: [[8, 14], [16, 24], [28, 32]], children: { esds: null, btrt: 20 } },
});
const COMPRESSORNAME = [50, 82];
const HDLR_FIXED = 24; // version/flags, pre_defined, handler_type, reserved

// Byte patterns that must never appear in a moov that was cleaned.
const MARKERS = [
  "©xyz", "©mak", "©mod", "©swr", "©day", "©nam", "©ART", "©aut", "©too", "©cmt",
  "loci", "XMP_", "<x:xmpmeta", "com.apple.quicktime", "com.android.", "location.ISO6709",
].map((text) => ({ text, bytes: Uint8Array.from(text, (c) => c.charCodeAt(0)) }));
const XMP_UUID = Uint8Array.of(0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac);

const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
const printable = (type) => /^[\x20-\x7e©]{4}$/.test(type);
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const typeBytes = (type) => Uint8Array.from(type, (c) => c.charCodeAt(0));

// A box inside another one: a plain 32-bit size of at least 8 (a 64-bit size
// or a size running "to the end" is for top-level boxes only).
function boxAt(bytes, at, limit) {
  if (at + 8 > limit) return null;
  const size = view(bytes).getUint32(at);
  if (size < 8 || at + size > limit) return null;
  return { type: fourcc(bytes, at + 4), start: at, size, head: 8, end: at + size };
}

function children(bytes, from, to) {
  const list = [];
  let at = from;
  while (at < to) {
    if (list.length >= METADATA_LIMITS.maxChildBoxes) throw unsupported("too_many_boxes");
    const box = boxAt(bytes, at, to);
    if (!box || !printable(box.type)) throw unsupported("broken_box");
    list.push(box);
    at = box.end;
  }
  return list;
}

// A box with an 8-byte header around `payload` (a Uint8Array or a list of them).
function makeBox(type, ...parts) {
  const size = 8 + parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  out.set(typeBytes(type), 4);
  let at = 8;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const payloadOf = (bytes, box) => bytes.subarray(box.start + box.head, box.end);

// The markers found in `bytes`, in one pass: every marker is at least 4
// bytes long, and the 4 bytes ending at each position are looked up as one
// number, so the time does not depend on what the bytes are.
const MARKERS_BY_PREFIX = new Map();
for (const marker of [...MARKERS, { text: "xmp_uuid", bytes: XMP_UUID }]) {
  const key = ((marker.bytes[0] << 24) | (marker.bytes[1] << 16) | (marker.bytes[2] << 8) | marker.bytes[3]) >>> 0;
  if (!MARKERS_BY_PREFIX.has(key)) MARKERS_BY_PREFIX.set(key, []);
  MARKERS_BY_PREFIX.get(key).push(marker);
}
function markersIn(bytes) {
  const found = [];
  let word = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    word = ((word << 8) | bytes[i]) >>> 0;
    if (i < 3) continue;
    const list = MARKERS_BY_PREFIX.get(word);
    if (!list) continue;
    const start = i - 3;
    for (const marker of list) {
      if (!found.includes(marker.text) && start + marker.bytes.length <= bytes.length && marker.bytes.every((b, k) => bytes[start + k] === b)) found.push(marker.text);
    }
  }
  return found;
}

// Each box type may be added once; `require` lists the ones that must be there.
function single() {
  const seen = new Set();
  const add = (type) => {
    if (seen.has(type)) throw unsupported("duplicate_box");
    seen.add(type);
  };
  add.require = (types) => { for (const type of types) if (!seen.has(type)) throw unsupported("box_missing"); };
  return add;
}

// Reads a byte range of the File, counting what was read (the memory proof).
function reader(file, signal) {
  const stats = { bytesRead: 0 };
  const read = async (start, end) => {
    if (signal?.aborted) throw cancelled();
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    stats.bytesRead += bytes.length;
    return bytes;
  };
  return { read, stats };
}

// A top-level box from its first (up to) 16 bytes; `remaining` is what is
// left of the file from the box's start.
function topHeader(head, remaining) {
  if (head.length < 8) return null;
  const v = view(head);
  let size = v.getUint32(0);
  let h = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
    h = 16;
  } else if (size === 0) {
    size = remaining;
  }
  const type = fourcc(head, 4);
  if (!printable(type) || size < h || size > remaining) return null;
  return { type, size, head: h };
}

// The top-level boxes from their headers only (16 bytes each).
async function topLevel(file, read) {
  const top = [];
  let at = 0;
  let trailer = 0;
  while (at < file.size) {
    if (top.length >= METADATA_LIMITS.maxTopBoxes) throw unsupported("too_many_boxes");
    const box = topHeader(await read(at, Math.min(file.size, at + 16)), file.size - at);
    // Not a box: everything from here on is not part of the MP4 and is left out.
    if (!box) { trailer = file.size - at; break; }
    top.push({ ...box, start: at, end: at + box.size });
    at += box.size;
  }
  return { top, trailer };
}

// The ftyp: an 8-byte header, major brand, minor version, whole brands only,
// small, every brand readable. It is copied as it is (it is its own canonical form).
function checkFtyp(bytes) {
  if (bytes.length < 16 || bytes.length > METADATA_LIMITS.maxFtypBytes || (bytes.length - 16) % 4 !== 0) throw unsupported("ftyp");
  if (view(bytes).getUint32(0) !== bytes.length) throw unsupported("ftyp");
  for (let at = 8; at < bytes.length; at += 4) if (at !== 12 && !/^[\x20-\x7e]{4}$/.test(fourcc(bytes, at))) throw unsupported("ftyp");
  return bytes;
}

function readTrack(moov, trak) {
  const track = { trak, id: 0, handler: "", tables: {}, external: false };
  const walk = (box, depth) => {
    if (depth > METADATA_LIMITS.maxDepth) throw unsupported("too_deep");
    for (const child of children(moov, box.start + box.head, box.end)) {
      if (child.type === "tkhd") {
        const p = child.start + child.head;
        if (p + 24 > child.end) throw unsupported("broken_box");
        // One identity per track: a second tkhd or hdlr is refused whatever its order.
        if (track.id || track.tkhdSeen) throw unsupported("duplicate_box");
        track.tkhdSeen = true;
        track.id = moov[p] === 1 ? view(moov).getUint32(p + 20) : view(moov).getUint32(p + 12);
      } else if (child.type === "hdlr") {
        // Only the hdlr directly under mdia names the track; a QuickTime data
        // handler under minf (alis / url) does not.
        const p = child.start + child.head;
        if (box.type === "mdia") {
          if (track.handler) throw unsupported("duplicate_box");
          if (p + 12 <= child.end) track.handler = fourcc(moov, p + 8);
        }
      } else if (["stsz", "stz2", "stsc", "stco", "co64"].includes(child.type)) {
        if (track.tables[child.type] || (child.type === "stco" && track.tables.co64) || (child.type === "co64" && track.tables.stco)) throw unsupported("duplicate_sample_table");
        track.tables[child.type] = child;
      } else if (child.type === "dref") {
        // Every data reference must be the file itself (flag 1); external media is not supported.
        const p = child.start + child.head;
        if (p + 8 > child.end) throw unsupported("broken_box");
        for (const entry of children(moov, p + 8, child.end)) {
          if (entry.start + entry.head + 4 > entry.end || (view(moov).getUint32(entry.start + entry.head) & 1) !== 1) track.external = true;
        }
      } else if (["mdia", "minf", "stbl", "dinf"].includes(child.type)) {
        walk(child, depth + 1);
      }
    }
  };
  walk(trak, 1);
  return track;
}

// --- exact shapes ---------------------------------------------------------

// A full box whose payload is a version/flags word, a 32-bit count and
// count entries of `entry` bytes, nothing after them. Returns the count.
function tableCount(bytes, box, entry, { versions = [0] } = {}) {
  const p = payloadOf(bytes, box);
  if (p.length < 8 || !versions.includes(p[0])) throw unsupported("table_shape");
  const count = view(p).getUint32(4);
  if (p.length !== 8 + entry * count) throw unsupported("table_shape");
  return count;
}

// stsz: version/flags, the uniform size, the count, a size per sample unless uniform.
function stszShape(bytes, box) {
  const p = payloadOf(bytes, box);
  if (p.length < 12 || p[0] !== 0) throw unsupported("table_shape");
  const uniform = view(p).getUint32(4);
  const count = view(p).getUint32(8);
  if (p.length !== 12 + (uniform ? 0 : 4 * count)) throw unsupported("table_shape");
  return { uniform, count };
}

// A fixed-size full box at its exact size, times and reserved fields zero,
// the flags kept only where they mean something (tkhd: enabled / in movie).
function canonFixed(bytes, box) {
  const shape = FIXED[box.type];
  const p = payloadOf(bytes, box);
  const version = p[0];
  if (version !== 0 && version !== 1) throw unsupported("box_version");
  if (p.length !== shape.payload[version]) throw unsupported("box_size");
  const out = p.slice();
  if (box.type !== "tkhd") out.fill(0, 1, 4);
  for (const [from, to] of shape.zero[version]) out.fill(0, from, to);
  return makeBox(box.type, out);
}

function canonVmhd(bytes, box) {
  if (payloadOf(bytes, box).length !== 12) throw unsupported("box_size");
  return makeBox("vmhd", Uint8Array.of(0, 0, 0, 1), new Uint8Array(8));
}

function canonSmhd(bytes, box) {
  const p = payloadOf(bytes, box);
  if (p.length !== 8) throw unsupported("box_size");
  return makeBox("smhd", new Uint8Array(4), p.subarray(4, 6), new Uint8Array(2));
}

// hdlr: only its handler type is kept; flags, pre_defined, reserved and the name are emptied.
function canonHdlr(bytes, box) {
  const p = payloadOf(bytes, box);
  if (p.length < HDLR_FIXED) throw unsupported("broken_box");
  const out = new Uint8Array(HDLR_FIXED + 1);
  out.set(p.subarray(8, 12), 8);
  return makeBox("hdlr", out);
}

// dinf: one dref with the same number of self-contained `url ` entries (12
// bytes each, no location string, no alias record); other children left out.
function canonDinf(bytes, dinf, removed) {
  let dref = null;
  for (const child of children(bytes, dinf.start + dinf.head, dinf.end)) {
    if (child.type === "dref" && !dref) dref = child;
    else removed.boxes.push(child.type);
  }
  if (!dref) throw unsupported("no_data_reference");
  const p = payloadOf(bytes, dref);
  if (p.length < 8 || p[0] !== 0) throw unsupported("box_shape");
  const count = view(p).getUint32(4);
  const entries = children(bytes, dref.start + dref.head + 8, dref.end);
  if (!count || count > METADATA_LIMITS.maxDataReferences || entries.length !== count) throw unsupported("box_shape");
  const url = makeBox("url ", Uint8Array.of(0, 0, 0, 1));
  const drefPayload = new Uint8Array(8 + 12 * count);
  view(drefPayload).setUint32(4, count);
  for (let i = 0; i < count; i += 1) drefPayload.set(url, 8 + 12 * i);
  return makeBox("dinf", makeBox("dref", drefPayload));
}

// edts: only its elst (numbers only), at its exact size; nothing else.
function canonEdts(bytes, edts, removed) {
  let elst = null;
  for (const child of children(bytes, edts.start + edts.head, edts.end)) {
    if (child.type === "elst") {
      if (elst) throw unsupported("edit_lists");
      elst = child;
    } else {
      removed.boxes.push(child.type);
    }
  }
  if (!elst) return null;
  const version = payloadOf(bytes, elst)[0];
  tableCount(bytes, elst, version === 1 ? 20 : 12, { versions: [0, 1] });
  const p = payloadOf(bytes, elst).slice();
  p.fill(0, 1, 4);
  return makeBox("edts", makeBox("elst", p));
}

// A descriptor of an MPEG-4 esds: tag, a 1-4 byte length, its content.
function descriptor(bytes, at, end) {
  if (at + 2 > end) throw unsupported("codec_config");
  const tag = bytes[at];
  let len = 0;
  let p = at + 1;
  for (let i = 0; ; i += 1) {
    if (p >= end || i === 4) throw unsupported("codec_config");
    const b = bytes[p++];
    len = len * 128 + (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  if (p + len > end) throw unsupported("codec_config");
  return { tag, start: p, end: p + len };
}

// esds: one ES descriptor (no dependence, no URL, no OCR stream) holding the
// decoder configuration (with at most its audio specific config) and the
// SL configuration, and nothing else.
function checkEsds(bytes, box) {
  const p = box.start + box.head;
  if (box.end - p < 4 || bytes[p] || bytes[p + 1] || bytes[p + 2] || bytes[p + 3]) throw unsupported("codec_config");
  const es = descriptor(bytes, p + 4, box.end);
  if (es.tag !== 3 || es.end !== box.end || es.end - es.start < 3 || bytes[es.start + 2] & 0xe0) throw unsupported("codec_config");
  const dc = descriptor(bytes, es.start + 3, es.end);
  if (dc.tag !== 4 || dc.end - dc.start < 13) throw unsupported("codec_config");
  if (dc.start + 13 < dc.end) {
    const asc = descriptor(bytes, dc.start + 13, dc.end);
    if (asc.tag !== 5 || asc.end !== dc.end || asc.end - asc.start > METADATA_LIMITS.maxAudioConfigBytes) throw unsupported("codec_config");
  }
  const sl = descriptor(bytes, dc.end, es.end);
  if (sl.tag !== 6 || sl.end !== es.end || sl.end - sl.start !== 1) throw unsupported("codec_config");
}

// avcC: version 1, the SPS and PPS lists (each NAL of its own type), the
// optional High-profile extension, and nothing after them.
function checkAvcC(bytes, box) {
  let p = box.start + box.head;
  const end = box.end;
  if (end - p < 7 || bytes[p] !== 1) throw unsupported("codec_config");
  const profile = bytes[p + 1];
  const sps = bytes[p + 5] & 0x1f;
  p += 6;
  const nal = (type) => {
    if (p + 2 > end) throw unsupported("codec_config");
    const len = (bytes[p] << 8) | bytes[p + 1];
    p += 2;
    if (!len || p + len > end || (bytes[p] & 0x1f) !== type) throw unsupported("codec_config");
    p += len;
  };
  if (!sps) throw unsupported("codec_config");
  for (let i = 0; i < sps; i += 1) nal(7);
  if (p >= end) throw unsupported("codec_config");
  const pps = bytes[p++];
  if (!pps) throw unsupported("codec_config");
  for (let i = 0; i < pps; i += 1) nal(8);
  if (p === end) return;
  if (![100, 110, 122, 144].includes(profile) || end - p < 4) throw unsupported("codec_config");
  const ext = bytes[p + 3];
  p += 4;
  for (let i = 0; i < ext; i += 1) nal(13);
  if (p !== end) throw unsupported("codec_config");
}

function checkEntryChild(bytes, child, allowed) {
  if (!(child.type in allowed)) throw unsupported("sample_entry_box");
  const size = allowed[child.type];
  if (size !== null) {
    if (child.size !== size || child.head !== 8) throw unsupported("sample_entry_box");
  } else if (child.type === "avcC") checkAvcC(bytes, child);
  else if (child.type === "esds") checkEsds(bytes, child);
  else if (child.type === "colr") {
    const kind = child.end - child.start >= 12 ? fourcc(bytes, child.start + 8) : "";
    if (child.head !== 8 || !((kind === "nclx" && child.size === 19) || (kind === "nclc" && child.size === 18))) throw unsupported("sample_entry_box");
  }
}

// stsd of a kept track: exactly one entry of the track's kind, its fixed part
// with the reserved / vendor / name fields zero, known children only.
function canonStsd(bytes, stsd, handler) {
  const spec = ENTRIES[handler];
  const p = payloadOf(bytes, stsd);
  if (p.length < 8 || p[0] !== 0 || view(p).getUint32(4) !== 1) throw unsupported("sample_description");
  const entries = children(bytes, stsd.start + stsd.head + 8, stsd.end);
  if (entries.length !== 1) throw unsupported("sample_description");
  const entry = entries[0];
  if (entry.head !== 8 || !spec.types.has(entry.type) || entry.size < spec.fixed) throw unsupported("sample_description");
  // A QuickTime sound description of version 1 / 2 has another layout.
  if (handler === "soun" && view(bytes).getUint16(entry.start + 16) !== 0) throw unsupported("sample_description");
  const once = single();
  for (const child of children(bytes, entry.start + spec.fixed, entry.end)) {
    once(child.type);
    checkEntryChild(bytes, child, spec.children);
  }
  once.require([handler === "vide" ? "avcC" : "esds"]);
  const out = bytes.slice(entry.start, entry.end);
  for (const [from, to] of spec.zero) out.fill(0, from, to);
  const head = new Uint8Array(8);
  view(head).setUint32(4, 1);
  return makeBox("stsd", head, out);
}

function canonTable(bytes, box) {
  const versions = box.type === "ctts" ? [0, 1] : [0];
  tableCount(bytes, box, STBL_TABLES[box.type], { versions });
  const p = payloadOf(bytes, box).slice();
  p.fill(0, 1, 4);
  return makeBox(box.type, p);
}

function canonStsz(bytes, box) {
  stszShape(bytes, box);
  const p = payloadOf(bytes, box).slice();
  p.fill(0, 1, 4);
  return makeBox("stsz", p);
}

function canonCslg(bytes, box) {
  const p = payloadOf(bytes, box);
  if (!((p[0] === 0 && p.length === 24) || (p[0] === 1 && p.length === 44))) throw unsupported("table_shape");
  const out = p.slice();
  out.fill(0, 1, 4);
  return makeBox("cslg", out);
}

// --- the rebuilt moov: a tree of kept boxes, serialized once -------------

const leaf = (bytes, mark = null) => ({ bytes, mark });
const node = (type, kids) => ({ type, kids });
const sizeOf = (n) => (n.bytes ? n.bytes.length : 8 + n.kids.reduce((sum, kid) => sum + sizeOf(kid), 0));

function serialize(n, out, at, marks) {
  if (n.bytes) {
    out.set(n.bytes, at);
    if (n.mark) marks.push({ ...n.mark, at });
    return at + n.bytes.length;
  }
  const size = sizeOf(n);
  view(out).setUint32(at, size);
  out.set(typeBytes(n.type), at + 4);
  let p = at + 8;
  for (const kid of n.kids) p = serialize(kid, out, p, marks);
  return p;
}

function rebuildMoov(moov, moovBox, kept, removed) {
  const kids = [];
  for (const box of children(moov, moovBox.start + moovBox.head, moovBox.end)) {
    if (!KEEP.moov.has(box.type)) { removed.boxes.push(box.type); continue; }
    if (box.type === "mvhd") { kids.push(leaf(canonFixed(moov, box))); continue; }
    const track = kept.find((t) => t.trak.start === box.start);
    if (track) kids.push(rebuildTrak(moov, box, track, removed));
  }
  return node("moov", kids);
}

function rebuildTrak(moov, trak, track, removed) {
  const kids = [];
  const once = single();
  for (const box of children(moov, trak.start + trak.head, trak.end)) {
    if (!KEEP.trak.has(box.type)) { removed.boxes.push(box.type); continue; }
    once(box.type);
    if (box.type === "tkhd") kids.push(leaf(canonFixed(moov, box)));
    else if (box.type === "mdia") kids.push(rebuildLevel(moov, box, "mdia", track, removed));
    else if (box.type === "edts") { const edts = canonEdts(moov, box, removed); if (edts) kids.push(leaf(edts)); }
  }
  once.require(["tkhd", "mdia"]);
  return node("trak", kids);
}

const MEDIA_HEADER = Object.freeze({ vide: "vmhd", soun: "smhd" });

function rebuildLevel(moov, box, level, track, removed) {
  const kids = [];
  const once = single();
  for (const child of children(moov, box.start + box.head, box.end)) {
    if (!KEEP[level].has(child.type)) { removed.boxes.push(child.type); continue; }
    once(child.type);
    if ((child.type === "vmhd" || child.type === "smhd") && child.type !== MEDIA_HEADER[track.handler]) throw unsupported("media_header");
    if (child.type === "minf") kids.push(rebuildLevel(moov, child, "minf", track, removed));
    else if (child.type === "stbl") kids.push(rebuildStbl(moov, child, track, removed));
    else if (child.type === "hdlr") kids.push(leaf(canonHdlr(moov, child)));
    else if (child.type === "mdhd") kids.push(leaf(canonFixed(moov, child)));
    else if (child.type === "vmhd") kids.push(leaf(canonVmhd(moov, child)));
    else if (child.type === "smhd") kids.push(leaf(canonSmhd(moov, child)));
    else if (child.type === "dinf") kids.push(leaf(canonDinf(moov, child, removed)));
  }
  once.require(level === "mdia" ? ["mdhd", "hdlr", "minf"] : [MEDIA_HEADER[track.handler], "dinf", "stbl"]);
  return node(level, kids);
}

function rebuildStbl(moov, stbl, track, removed) {
  const kids = [];
  const seen = new Set();
  for (const child of children(moov, stbl.start + stbl.head, stbl.end)) {
    if (STBL_DROP.has(child.type)) { removed.boxes.push(child.type); continue; }
    if (child.type === "stz2") throw unsupported("compact_sample_sizes");
    if (!STBL_KEEP.has(child.type)) throw unsupported("unknown_sample_table_box");
    const key = child.type === "co64" ? "stco" : child.type;
    if (seen.has(key)) throw unsupported("duplicate_sample_table");
    seen.add(key);
    if (child.type === "stsd") kids.push(leaf(canonStsd(moov, child, track.handler)));
    else if (child.type === "stsz") kids.push(leaf(canonStsz(moov, child)));
    else if (child.type === "cslg") kids.push(leaf(canonCslg(moov, child)));
    else kids.push(leaf(canonTable(moov, child), child.type === "stco" || child.type === "co64" ? { kind: child.type } : null));
  }
  for (const required of ["stsd", "stts", "stsc", "stsz", "stco"]) if (!seen.has(required)) throw unsupported("sample_table_missing");
  return node("stbl", kids);
}

// The byte range of every chunk of a kept track (the samples of a chunk are
// contiguous), within the shared budget of samples and chunks.
function chunkRanges(moov, tables, budget) {
  if (tables.stz2) throw unsupported("compact_sample_sizes");
  const { stsz, stsc } = tables;
  const co = tables.co64 || tables.stco;
  if (!stsz || !stsc || !co) throw unsupported("sample_table_missing");
  const v = view(moov);
  const { uniform, count } = stszShape(moov, stsz);
  const wide = Boolean(tables.co64);
  const chunks = tableCount(moov, co, wide ? 8 : 4);
  const runs = tableCount(moov, stsc, 12);
  budget.samples += count;
  budget.chunks += chunks;
  if (budget.samples > METADATA_LIMITS.maxSamples) throw unsupported("too_many_samples");
  if (budget.chunks > METADATA_LIMITS.maxChunks) throw unsupported("too_many_chunks");
  const zp = stsz.start + stsz.head;
  const cp = co.start + co.head;
  const sp = stsc.start + stsc.head;
  const chunkOffset = (i) => (wide ? v.getUint32(cp + 8 + 8 * i) * 2 ** 32 + v.getUint32(cp + 12 + 8 * i) : v.getUint32(cp + 8 + 4 * i));
  const ranges = [];
  let sample = 0;
  let bytes = 0;
  for (let r = 0; r < runs; r += 1) {
    const first = v.getUint32(sp + 8 + 12 * r);
    const perChunk = v.getUint32(sp + 12 + 12 * r);
    const next = r + 1 < runs ? v.getUint32(sp + 8 + 12 * (r + 1)) : chunks + 1;
    // ISO 14496-12: the first run starts at chunk 1, runs strictly increase,
    // every run has samples, and the one sample description is number 1 - a
    // map a decoder would read another way is refused, never guessed.
    if ((r === 0 && first !== 1) || first < 1 || next <= first || perChunk === 0 || v.getUint32(sp + 16 + 12 * r) !== 1) throw unsupported("chunk_map_broken");
    for (let c = first; c < next && c <= chunks; c += 1) {
      let size = 0;
      for (let s = 0; s < perChunk && sample < count; s += 1, sample += 1) size += uniform || v.getUint32(zp + 12 + 4 * sample);
      if (size) { const at = chunkOffset(c - 1); ranges.push([at, at + size]); }
      bytes += size;
    }
  }
  if (sample !== count) throw unsupported("sample_count_mismatch");
  return { ranges, bytes };
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

// --- the plan: what the cleaned file is -----------------------------------

async function planCleaning(file, signal) {
  const { read, stats } = reader(file, signal);
  const { top, trailer } = await topLevel(file, read);
  const types = top.map((box) => box.type);
  if (types[0] !== "ftyp") throw unsupported("no_ftyp");
  if (types.filter((t) => t === "ftyp").length !== 1) throw unsupported("ftyp_count");
  if (types.filter((t) => t === "moov").length !== 1) throw unsupported("moov_count");
  if (!types.includes("mdat")) throw unsupported("no_mdat");
  if (types.includes("moof") || types.includes("mfra")) throw unsupported("fragmented");
  const ftypTop = top[0];
  if (ftypTop.size > METADATA_LIMITS.maxFtypBytes || ftypTop.head !== 8) throw unsupported("ftyp");
  const ftyp = checkFtyp(await read(ftypTop.start, ftypTop.end));
  const moovTop = top.find((box) => box.type === "moov");
  if (moovTop.size > METADATA_LIMITS.maxMoovBytes) throw unsupported("moov_too_large");
  const moovBytes = await read(moovTop.start, moovTop.end);
  const moovBox = { ...moovTop, start: 0, end: moovTop.size };
  const moovKids = children(moovBytes, moovBox.head, moovBox.end);
  if (moovKids.some((box) => box.type === "mvex")) throw unsupported("fragmented");
  if (moovKids.filter((box) => box.type === "mvhd").length !== 1) throw unsupported("no_mvhd");
  const traks = moovKids.filter((box) => box.type === "trak");
  if (traks.length > METADATA_LIMITS.maxTracks) throw unsupported("too_many_tracks");

  const tracks = traks.map((trak) => readTrack(moovBytes, trak));
  const kept = tracks.filter((track) => KEEP_HANDLERS.has(track.handler));
  if (kept.filter((track) => track.handler === "vide").length !== 1 || kept.filter((track) => track.handler === "soun").length > 1) throw unsupported("track_count");
  if (kept.some((track) => !track.id) || new Set(kept.map((track) => track.id)).size !== kept.length) throw unsupported("track_ids");
  if (kept.some((track) => track.external)) throw unsupported("external_data");
  const removed = { boxes: [], tracks: tracks.filter((track) => !KEEP_HANDLERS.has(track.handler)).map((track) => track.handler || "unknown"), topBoxes: top.filter((box) => !KEEP_TOP.has(box.type)).map((box) => box.type), trailerBytes: trailer, zeroedBytes: 0 };

  // The rebuilt moov.
  const tree = rebuildMoov(moovBytes, moovBox, kept, removed);
  const newMoov = new Uint8Array(sizeOf(tree));
  const marks = [];
  serialize(tree, newMoov, 0, marks);

  // The new layout: ftyp, moov, mdat(s) in their order; how far each mdat moves.
  const mdats = top.filter((box) => box.type === "mdat");
  const shift = new Map();
  let at = 0;
  for (const box of top) {
    if (!KEEP_TOP.has(box.type)) continue;
    if (box.type === "mdat") shift.set(box, at - box.start);
    at += box.type === "moov" ? newMoov.length : box.size;
  }
  const mdatOf = (offset) => {
    let lo = 0;
    let hi = mdats.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = mdats[mid];
      if (offset < m.start + m.head) hi = mid - 1;
      else if (offset >= m.end) lo = mid + 1;
      else return m;
    }
    return null;
  };

  // The kept chunks: each inside one mdat, no two sharing a byte.
  const budget = { samples: 0, chunks: 0 };
  const used = [];
  let usedBytes = 0;
  for (const track of kept) {
    const { ranges, bytes } = chunkRanges(moovBytes, track.tables, budget);
    usedBytes += bytes;
    for (const [s, e] of ranges) {
      const m = mdatOf(s);
      if (!m || e > m.end) throw unsupported("sample_outside_mdat");
      used.push([s, e]);
    }
  }
  const usedMerged = merge(used);
  if (usedMerged.reduce((sum, [s, e]) => sum + (e - s), 0) !== usedBytes) throw unsupported("sample_overlap");

  // Every chunk offset moved with its mdat (the table's exact size is checked).
  const nv = view(newMoov);
  for (const mark of marks) {
    const p = mark.at + 8;
    const count = nv.getUint32(p + 4);
    for (let i = 0; i < count; i += 1) {
      if (mark.kind === "co64") {
        const old = nv.getUint32(p + 8 + 8 * i) * 2 ** 32 + nv.getUint32(p + 12 + 8 * i);
        const m = mdatOf(old);
        if (!m) throw unsupported("chunk_outside_mdat");
        const moved = old + shift.get(m);
        if (moved < 0 || moved > Number.MAX_SAFE_INTEGER) throw unsupported("offset_overflow");
        nv.setUint32(p + 8 + 8 * i, Math.floor(moved / 2 ** 32));
        nv.setUint32(p + 12 + 8 * i, moved % 2 ** 32);
      } else {
        const old = nv.getUint32(p + 8 + 4 * i);
        const m = mdatOf(old);
        if (!m) throw unsupported("chunk_outside_mdat");
        const moved = old + shift.get(m);
        if (moved < 0 || moved > 0xffffffff) throw unsupported("offset_overflow");
        nv.setUint32(p + 8 + 4 * i, moved);
      }
    }
  }

  // Inside each mdat, every byte no kept sample uses is written as zero.
  const holes = [];
  let next = 0;
  for (const m of mdats) {
    let cursor = m.start + m.head;
    while (next < usedMerged.length && usedMerged[next][0] < m.end) {
      const [s, e] = usedMerged[next];
      if (s > cursor) holes.push([cursor, s]);
      cursor = Math.max(cursor, e);
      next += 1;
    }
    if (cursor < m.end) holes.push([cursor, m.end]);
    if (holes.length > METADATA_LIMITS.maxHoles) throw unsupported("too_many_holes");
  }
  removed.zeroedBytes = holes.reduce((sum, [s, e]) => sum + (e - s), 0);
  if (removed.zeroedBytes > METADATA_LIMITS.maxZeroedBytes) throw unsupported("too_much_unused_data");
  if (signal?.aborted) throw cancelled();
  return { top, trailer, ftyp, moovTop, moovBytes, newMoov, holes, removed, stats, kept, usedBytes, read };
}

// --- the whole step -----------------------------------------------------

// Resolves to { file, report }. Throws MetadataUnsupported or
// preparation_cancelled; never returns the original.
export async function stripPrivateMetadata(file, { signal } = {}) {
  const plan = await planCleaning(file, signal);
  const { top, ftyp, newMoov, holes, removed, stats } = plan;
  // The output: the ftyp, the rebuilt moov, slices of the original and zeros for the holes.
  const parts = [];
  let inMemory = ftyp.length + newMoov.length;
  let h = 0;
  for (const box of top) {
    if (!KEEP_TOP.has(box.type)) continue;
    if (box.type === "ftyp") { parts.push(ftyp); continue; }
    if (box.type === "moov") { parts.push(newMoov); continue; }
    parts.push(file.slice(box.start, box.start + box.head));
    let cursor = box.start + box.head;
    while (h < holes.length && holes[h][0] < box.end) {
      const [s, e] = holes[h];
      if (s > cursor) parts.push(file.slice(cursor, s));
      parts.push(new Uint8Array(e - s));
      inMemory += e - s;
      cursor = e;
      h += 1;
    }
    if (cursor < box.end) parts.push(file.slice(cursor, box.end));
  }
  const out = new File(parts, cleanName(file.name), { type: "video/mp4", lastModified: Date.now() });
  return { file: out, report: { removed, bytesRead: stats.bytesRead, bytesInMemory: inMemory, moovBytes: newMoov.length, outputBytes: out.size } };
}

function cleanName(name) {
  const base = String(name || "").replace(/\.[^.]+$/, "").trim();
  return `${base || "video"}.mp4`;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The sum of a kept track's sample sizes read straight from its stsz (an
// accounting of its own, not through the chunk walk of the cleaning).
function sampleBytes(moov, stsz) {
  const p = stsz.start + stsz.head;
  if (p + 12 > stsz.end) return -1;
  const v = view(moov);
  const uniform = v.getUint32(p + 4);
  const count = v.getUint32(p + 8);
  if (uniform) return uniform * count;
  if (p + 12 + 4 * count > stsz.end) return -1;
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += v.getUint32(p + 12 + 4 * i);
  return sum;
}

const FINDING_OF_REASON = { too_much_unused_data: "unused_data_too_large", sample_outside_mdat: "sample_outside_mdat", chunk_outside_mdat: "sample_outside_mdat" };

// A check of a file that is about to be sent. It reports what it finds by
// its own walk (top-level boxes and what follows them, the boxes inside the
// moov, the tracks, the times, the hdlr names and compressorname, track
// references, metadata markers anywhere in the moov), and then requires the
// file to be a fixed point of the cleaning: the same boxes, a moov the
// cleaning would write byte for byte as it is, every mdat byte no sample uses
// zero (read back), and the used bytes equal to the sample sizes.
// Resolves to { clean, findings }.
export async function inspectPrivacy(file, { signal } = {}) {
  const findings = [];
  const { read } = reader(file, signal);
  let top;
  let trailer;
  try { ({ top, trailer } = await topLevel(file, read)); } catch (error) { if (error?.code === "preparation_cancelled") throw error; return { clean: false, findings: ["structure"] }; }
  if (trailer) findings.push("trailer");
  for (const box of top) if (!KEEP_TOP.has(box.type)) findings.push(`top:${box.type}`);
  if (top.filter((box) => box.type === "ftyp").length !== 1 || top[0]?.type !== "ftyp" || top[0].size > METADATA_LIMITS.maxFtypBytes) findings.push("ftyp");
  const moovs = top.filter((box) => box.type === "moov");
  if (moovs.length !== 1 || moovs[0].size > METADATA_LIMITS.maxMoovBytes) return { clean: false, findings: [...new Set([...findings, "moov"])] };
  const moovTop = moovs[0];
  const moov = await read(moovTop.start, moovTop.end);
  for (const text of markersIn(moov)) findings.push(`marker:${text}`);
  const tracks = [];
  try {
    const box = { type: "moov", start: 0, size: moov.length, head: moovTop.head, end: moov.length };
    const level = (parent, name, depth, handler) => {
      if (depth > METADATA_LIMITS.maxDepth) throw unsupported("too_deep");
      for (const child of children(moov, parent.start + parent.head, parent.end)) {
        if (name === "stbl") {
          if (!STBL_KEEP.has(child.type)) findings.push(`box:${child.type}`);
          if (child.type === "stsd" && handler === "vide") {
            for (const entry of children(moov, child.start + child.head + 8, child.end)) {
              if (entry.size >= ENTRIES.vide.fixed && !moov.subarray(entry.start + COMPRESSORNAME[0], entry.start + COMPRESSORNAME[1]).every((b) => b === 0)) findings.push("text:compressorname");
            }
          }
          continue;
        }
        if (name === "mdia" && child.type === "hdlr" && !moov.subarray(child.start + child.head + HDLR_FIXED, child.end).every((b) => b === 0)) findings.push("text:hdlr");
        if (KEEP[name] && !KEEP[name].has(child.type)) { findings.push(`box:${child.type}`); continue; }
        if (TIMED.has(child.type)) {
          const p = child.start + child.head;
          const [from, to] = FIXED[child.type].time[moov[p] === 1 ? 1 : 0];
          if (p + to > child.end || !moov.subarray(p + from, p + to).every((b) => b === 0)) findings.push(`time:${child.type}`);
        }
        if (child.type === "trak") { const track = readTrack(moov, child); tracks.push(track); level(child, "trak", depth + 1, track.handler); continue; }
        if (["mdia", "minf", "stbl"].includes(child.type)) level(child, child.type, depth + 1, handler);
      }
    };
    level(box, "moov", 0);
    const ids = new Set(tracks.map((track) => track.id));
    for (const track of tracks) if (!KEEP_HANDLERS.has(track.handler)) findings.push(`track:${track.handler || "unknown"}`);
    // tref targets must exist.
    for (const trak of children(moov, box.head, box.end).filter((b) => b.type === "trak")) {
      for (const tref of children(moov, trak.start + trak.head, trak.end).filter((b) => b.type === "tref")) {
        for (const ref of children(moov, tref.start + tref.head, tref.end)) {
          for (let p = ref.start + ref.head; p + 4 <= ref.end; p += 4) if (!ids.has(view(moov).getUint32(p))) findings.push("tref:dangling");
        }
      }
    }
  } catch (error) {
    if (error?.code === "preparation_cancelled") throw error;
    findings.push(`structure:${error?.reason || "unreadable"}`);
  }

  // The fixed point: the cleaning would change nothing in this file.
  try {
    const plan = await planCleaning(file, signal);
    // Anything the cleaning would leave out of the moov changes its bytes; what it
    // would leave out at the top level is found by the walk above.
    if (plan.newMoov.length !== moov.length || !sameBytes(plan.newMoov, moov)) findings.push("moov_not_canonical");
    for (const [s, e] of plan.holes) {
      const bytes = await read(s, e);
      if (!bytes.every((b) => b === 0)) { findings.push("unused_data_not_zero"); break; }
    }
    // The used bytes against the sample sizes, counted on their own.
    const counted = plan.kept.reduce((sum, track) => sum + sampleBytes(plan.moovBytes, track.tables.stsz), 0);
    if (counted !== plan.usedBytes) findings.push("sample_accounting");
  } catch (error) {
    if (error?.code === "preparation_cancelled") throw error;
    findings.push(FINDING_OF_REASON[error?.reason] || `structure:${error?.reason || "unreadable"}`);
  }
  return { clean: findings.length === 0, findings: [...new Set(findings)] };
}
