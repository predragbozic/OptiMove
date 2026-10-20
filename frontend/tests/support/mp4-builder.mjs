// Builds small MP4 / MOV files byte by byte for the metadata tests, with the
// structures phones write (location, device, software, title, dates, XMP,
// timed-metadata / timecode / caption tracks, track references, stale padding,
// data appended after the last box), the moov before or after the media, one
// or several mdat boxes, 32- or 64-bit chunk offsets - and an independent
// reader that extracts every track's samples from a file, so a test can prove
// the picture and the sound are byte for byte what they were. The sample
// entries are opaque (no real codec); playable files are covered by the
// fixtures in backend/tests/fixtures/media.

const enc = new TextEncoder();
const C = "©";

export function bytesOf(...parts) {
  const list = parts.flat().map((p) => (typeof p === "string" ? Uint8Array.from([...p].map((c) => c.charCodeAt(0) & 255)) : p));
  const out = new Uint8Array(list.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of list) { out.set(p, at); at += p.length; }
  return out;
}
export const u8 = (...values) => Uint8Array.from(values);
export function u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value); return b; }
export function u64(value) { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Math.floor(value / 2 ** 32)); v.setUint32(4, value % 2 ** 32); return b; }
export const box = (type, ...payload) => { const body = bytesOf(...payload); return bytesOf(u32(8 + body.length), type, body); };
const full = (type, version, flags, ...payload) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);

export const MARKERS = {
  gps: "+12.3456+065.4321/",
  make: "samsung",
  model: "SM-S721B",
  software: "S721BXXU2AXK1",
  title: "Recorded by QA Test Author",
  author: "QA Test Author",
  xmp: 'exif:GPSLatitude="12,20.736N"',
  appleLocation: "com.apple.quicktime.location.ISO6709",
  caption: "SECRET-CAPTION Gym Testtown",
  stale: "STALE-PRIVATE-DATA in an unused part of the media",
  trailer: "SEFH Image_UTC_Data1729008701000 MCC_Data220 SEFT",
  padding: "OLD-PADDING with a leftover location +12.3456",
};

const qtString = (type, text) => { const t = enc.encode(text); return box(type, u8(t.length >> 8, t.length & 255, 0x15, 0xc7), t); };
export const privateUdta = () => box("udta", qtString(`${C}xyz`, MARKERS.gps), qtString(`${C}mak`, MARKERS.make), qtString(`${C}mod`, MARKERS.model), qtString(`${C}swr`, MARKERS.software), qtString(`${C}aut`, MARKERS.author));
export const privateMeta = () => full("meta", 0, 0,
  full("hdlr", 0, 0, u32(0), "mdir", "appl", u32(0), u32(0), u8(0)),
  box("keys", u32(0), u32(1), box("mdta", MARKERS.appleLocation)),
  box("ilst", box(`${C}nam`, box("data", u32(1), u32(0), MARKERS.title))),
);
const XMP_UUID = u8(0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac);
export const xmpUuid = () => box("uuid", XMP_UUID, `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description ${MARKERS.xmp} tiff:Model="${MARKERS.model}"/></x:xmpmeta>`);

// An avcC with one SPS and one PPS (opaque bodies, real NAL types).
export function avcC({ trailing = null } = {}) {
  const sps = u8(0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40);
  const pps = u8(0x68, 0xeb, 0xe3, 0xcb);
  return box("avcC", u8(1, 0x64, 0x00, 0x1f, 0xff, 0xe1), u8(0, sps.length), sps, u8(1), u8(0, pps.length), pps, ...(trailing ? [trailing] : []));
}

// A VisualSampleEntry as the specification lays it out (86 bytes, then its
// children): reserved, data_reference_index 1, pre_defined (the QuickTime
// vendor and quality fields), 640x360, 72 dpi, frame_count 1, compressorname
// (a Pascal string in 32 bytes), depth 0x18, -1.
export function visualEntry(compressor = "", kids = [avcC()], { vendor = null } = {}) {
  const name = new Uint8Array(32);
  const text = enc.encode(compressor).subarray(0, 31);
  name[0] = text.length;
  name.set(text, 1);
  const predefined = new Uint8Array(16);
  if (vendor) predefined.set(enc.encode(vendor).subarray(0, 12), 4);
  return box("avc1", new Uint8Array(6), u8(0, 1), predefined, u8(2, 128, 1, 104), u32(0x00480000), u32(0x00480000), u32(0), u8(0, 1), name, u8(0, 0x18, 0xff, 0xff), ...kids);
}

// An esds for AAC-LC: an ES descriptor (no dependence, no URL, no OCR stream
// unless `flags` says so) with the decoder configuration, its audio specific
// config and the SL configuration; `extra` adds a descriptor after them.
export function esds({ flags = 0, url = null, extra = null } = {}) {
  const asc = u8(0x12, 0x10);
  const dsi = bytesOf(u8(5, asc.length), asc);
  const dcd = bytesOf(u8(4, 13 + dsi.length), u8(0x40, 0x15, 0, 0, 0, 0, 1, 0xf4, 0, 0, 1, 0xf4, 0), dsi);
  const sl = u8(6, 1, 2);
  const head = url ? bytesOf(u8(0, 1, flags | 0x40, url.length), url) : u8(0, 1, flags);
  const body = bytesOf(head, dcd, sl, ...(extra ? [extra] : []));
  return full("esds", 0, 0, u8(3, body.length), body);
}

// An AudioSampleEntry (36 bytes, then its children): reserved, data_reference_index 1,
// version / revision / vendor (zero for MP4), 2 channels, 16 bits, 48 kHz.
export function audioEntry(kids = [esds()], { vendor = null } = {}) {
  const qt = new Uint8Array(8);
  if (vendor) qt.set(enc.encode(vendor).subarray(0, 4), 4);
  return box("mp4a", new Uint8Array(6), u8(0, 1), qt, u8(0, 2), u8(0, 16), u8(0, 0), u8(0, 0), u32(48000 * 65536), ...kids);
}

// The matrix of a picture turned 90 degrees (rotation metadata).
const ROTATE_90 = bytesOf(u32(0), u32(0x00010000), u32(0), u32(0xffff0000), u32(0), u32(0), u32(0), u32(0), u32(0x40000000));
const IDENTITY = bytesOf(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

/**
 * tracks: [{ id, handler, samples: Uint8Array[], perChunk = 1, co64 = false, rotate = false, tref = null | [{ type, ids }], udta = false, stblExtra = [],
 *            hdlrName = "<handler>Handler", compressor = "" (the video entry's compressorname), entry = null (a whole sample entry instead of the default),
 *            minfHdlr = false (a QuickTime data handler in minf), uniform = false (one stsz size for all samples),
 *            slack = { tkhd, mdhd, stts, stsz, stco, ... } (bytes appended after a box's fields), hdlrReserved = null (12 bytes),
 *            drefText = null (a string after a self-contained url entry), dinfExtra = [], edtsExtra = [],
 *            stscEntries = null ([[first_chunk, samples_per_chunk, sample_description_index], ...]),
 *            leadingChunks = 0 (extra chunk offsets in front, pointing at the first real chunk),
 *            trakExtra = [], mdiaExtra = [], minfExtra = [] (boxes appended at that level) }]
 * options: { brand = "isom", moovFirst = false, moovPrivate = true, topBeforeMdat = [], topAfter = [], trailer = null,
 *            staleInMdat = null, mdatSplit = false, mvex = false, stz2 = false, externalData = false, times = 0x5f5e1000,
 *            largeMdat = false (64-bit mdat headers: size 1 + a 64-bit size), mdatToEnd = false (size 0: the mdat runs
 *            to the end of the file; moov first, nothing after), timesVersion = 0 (1: 64-bit times in mvhd / tkhd / mdhd),
 *            interleave = false (chunks of all tracks round-robin), mvhdSlack = null, iods = null (bytes of an iods payload), ftyp = null (whole ftyp bytes),
 *            zeroTimes = false (creation and modification times 0, as a cleaned file has them), moovExtra = [] }
 */
export function buildMp4(tracks, options = {}) {
  const o = { brand: "isom", moovFirst: false, moovPrivate: true, topBeforeMdat: [], topAfter: [], trailer: null, staleInMdat: null, mdatSplit: false, mvex: false, stz2: false, externalData: false, times: 0x5f5e1000, largeMdat: false, mdatToEnd: false, timesVersion: 0, interleave: false, mvhdSlack: null, iods: null, ftyp: null, ...options };
  if (o.mdatToEnd && (!o.moovFirst || o.mdatSplit || o.topAfter.length || o.trailer)) throw new Error("mdatToEnd needs the moov first and nothing after the mdat");
  const tv = o.timesVersion === 1 ? 1 : 0;
  const T = (value) => (tv ? u64(value) : u32(value));
  const C = (k) => T(o.zeroTimes ? 0 : o.times + k);
  const mdatHead = o.largeMdat ? 16 : 8;
  // The media: every track's chunks one after another; stale bytes first when asked.
  const chunks = tracks.map((t) => { const list = []; for (let i = 0; i < t.samples.length; i += t.perChunk || 1) list.push(t.samples.slice(i, i + (t.perChunk || 1))); return list; });
  const mdatParts = [[], []];
  const chunkPlace = tracks.map(() => []); // [mdatIndex, offsetInPayload]
  const sizes = [0, 0];
  const put = (m, bytes) => { const at = sizes[m]; mdatParts[m].push(bytes); sizes[m] += bytes.length; return at; };
  if (o.staleInMdat) put(0, enc.encode(o.staleInMdat));
  const placeChunk = (ti, ci) => {
    const m = o.mdatSplit && ci % 2 === 1 ? 1 : 0;
    chunkPlace[ti].push([m, put(m, bytesOf(chunks[ti][ci]))]);
  };
  if (o.interleave) {
    const most = Math.max(...chunks.map((list) => list.length));
    for (let ci = 0; ci < most; ci += 1) tracks.forEach((t, ti) => { if (ci < chunks[ti].length) placeChunk(ti, ci); });
  } else {
    tracks.forEach((t, ti) => chunks[ti].forEach((chunk, ci) => placeChunk(ti, ci)));
  }
  const mdatBox = (parts) => {
    const body = bytesOf(...parts);
    if (o.largeMdat) return bytesOf(u32(1), "mdat", u64(16 + body.length), body);
    if (o.mdatToEnd) return bytesOf(u32(0), "mdat", body);
    return box("mdat", body);
  };
  const mdats = [mdatBox(mdatParts[0]), ...(o.mdatSplit ? [mdatBox(mdatParts[1])] : [])];

  const makeMoov = (offsetOf) => {
    const traks = tracks.map((t, ti) => {
      const S = (type) => (t.slack?.[type] ? [t.slack[type]] : []);
      const entry = t.entry ?? (t.handler === "vide" ? visualEntry(t.compressor ?? "") : t.handler === "soun" ? audioEntry() : box("wvtt", new Uint8Array(16)));
      const stsz = t.uniform
        ? full("stsz", 0, 0, u32(t.samples[0].length), u32(t.samples.length), ...S("stsz"))
        : full("stsz", 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.length)), ...S("stsz"));
      const stbl = box("stbl",
        full("stsd", 0, 0, u32(1), entry),
        full("stts", 0, 0, u32(1), u32(t.samples.length), u32(1000), ...S("stts")),
        t.stscEntries ? full("stsc", 0, 0, u32(t.stscEntries.length), ...t.stscEntries.flat().map(u32)) : full("stsc", 0, 0, u32(1), u32(1), u32(t.perChunk || 1), u32(1), ...S("stsc")),
        o.stz2 && ti === 0 ? full("stz2", 0, 0, u8(0, 0, 0, 8), u32(t.samples.length), ...t.samples.map((s) => u8(s.length))) : stsz,
        t.co64 ? full("co64", 0, 0, u32(chunks[ti].length), ...chunkPlace[ti].map(([m, at]) => u64(offsetOf(m, at))), ...S("co64")) : full("stco", 0, 0, u32(chunks[ti].length + (t.leadingChunks || 0)), ...new Array(t.leadingChunks || 0).fill(u32(offsetOf(...chunkPlace[ti][0]))), ...chunkPlace[ti].map(([m, at]) => u32(offsetOf(m, at))), ...S("stco")),
        ...(t.stblExtra || []),
      );
      const mhd = t.handler === "vide" ? full("vmhd", 0, 1, new Uint8Array(8)) : t.handler === "soun" ? full("smhd", 0, 0, new Uint8Array(4)) : full("nmhd", 0, 0);
      const external = o.externalData && t.handler === "vide";
      const dref = full("dref", 0, 0, u32(1), full("url ", 0, external ? 0 : 1, ...(external ? ["http://example.invalid/media"] : t.drefText ? [t.drefText] : [])));
      return box("trak",
        full("tkhd", tv, 7, C(0), C(1), u32(t.id), u32(0), T(t.samples.length * 1000), new Uint8Array(8), u8(0, 0, 0, 0), u8(0, 0, 0, 0), t.rotate ? ROTATE_90 : IDENTITY, u32(640 << 16), u32(360 << 16), ...S("tkhd")),
        ...(t.tref ? [box("tref", ...t.tref.map((ref) => box(ref.type, ...ref.ids.map(u32))))] : []),
        box("edts", full("elst", 0, 0, u32(1), u32(t.samples.length * 1000), u32(0), u32(0x00010000), ...S("elst")), ...(t.edtsExtra || [])),
        box("mdia",
          full("mdhd", tv, 0, C(0), C(2), u32(1000), T(t.samples.length * 1000), u8(0x55, 0xc4, 0, 0), ...S("mdhd")),
          full("hdlr", 0, 0, u32(0), t.handler, t.hdlrReserved ?? new Uint8Array(12), t.hdlrName ?? `${t.handler}Handler`, u8(0)),
          box("minf", mhd, ...(t.minfHdlr ? [full("hdlr", 0, 0, "dhlr", "alis", "appl", u32(0), u32(0), u8(0))] : []), box("dinf", dref, ...(t.dinfExtra || [])), stbl, ...(t.minfExtra || [])),
          ...(t.mdiaExtra || []),
        ),
        ...(t.udta ? [privateUdta()] : []),
        ...(t.trakExtra || []),
      );
    });
    return box("moov",
      full("mvhd", tv, 0, C(0), C(3), u32(1000), T(tracks[0].samples.length * 1000), u32(0x00010000), u8(1, 0), new Uint8Array(10), IDENTITY, new Uint8Array(24), u32(tracks.length + 1), ...(o.mvhdSlack ? [o.mvhdSlack] : [])),
      ...(o.iods ? [full("iods", 0, 0, o.iods)] : []),
      ...(o.moovExtra || []),
      ...traks,
      ...(o.mvex ? [box("mvex", full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)))] : []),
      ...(o.moovPrivate ? [privateUdta(), privateMeta(), xmpUuid(), box("free", MARKERS.padding)] : []),
    );
  };
  const ftyp = o.ftyp ?? box("ftyp", o.brand, u32(0x200), o.brand, "mp42", "iso2");
  // Two passes: the moov's size does not depend on the offset values.
  const draft = makeMoov(() => 0);
  const before = bytesOf(ftyp, ...o.topBeforeMdat);
  const order = o.moovFirst ? [before, draft, ...mdats] : [before, ...mdats, draft];
  const mdatStart = [];
  let at = 0;
  for (const part of order) {
    if (part === mdats[0]) mdatStart[0] = at;
    if (part === mdats[1]) mdatStart[1] = at;
    at += part.length;
  }
  const moov = makeMoov((m, offset) => mdatStart[m] + mdatHead + offset);
  const layout = o.moovFirst ? [before, moov, ...mdats] : [before, ...mdats, moov];
  return bytesOf(...layout, ...o.topAfter, ...(o.trailer ? [enc.encode(o.trailer)] : []));
}

// ---- an independent reader (does not share code with the module under test) ----

function boxes(bytes, from, to) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let at = from;
  while (at + 8 <= to) {
    let size = v.getUint32(at);
    let head = 8;
    if (size === 1) { size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12); head = 16; }
    if (size === 0) size = to - at;
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), at, size, head, end: at + size });
    at += size;
  }
  return out;
}
const find = (bytes, parent, type) => boxes(bytes, parent.at + parent.head, parent.end).find((b) => b.type === type);

// Top-level box types, in order.
export const topTypes = (bytes) => boxes(bytes, 0, bytes.length).map((b) => b.type);

// { [trackId]: { handler, samples: Uint8Array[], tkhd, mdhd, edts, stsd } } of a file's bytes.
export function readSamples(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(bytes, 0, bytes.length).find((b) => b.type === "moov");
  const out = {};
  for (const trak of boxes(bytes, moov.at + moov.head, moov.end).filter((b) => b.type === "trak")) {
    const tkhd = find(bytes, trak, "tkhd");
    const id = v.getUint32(tkhd.at + 8 + (bytes[tkhd.at + 8] === 1 ? 20 : 12));
    const mdia = find(bytes, trak, "mdia");
    const hdlr = find(bytes, mdia, "hdlr");
    const minf = find(bytes, mdia, "minf");
    const stbl = find(bytes, minf, "stbl");
    const stsz = find(bytes, stbl, "stsz");
    const stsc = find(bytes, stbl, "stsc");
    const co = find(bytes, stbl, "stco") || find(bytes, stbl, "co64");
    const wide = co.type === "co64";
    const count = v.getUint32(stsz.at + 16);
    const sizes = Array.from({ length: count }, (_, i) => v.getUint32(stsz.at + 20 + 4 * i));
    const perChunk = v.getUint32(stsc.at + 20);
    const chunks = v.getUint32(co.at + 12);
    const samples = [];
    let s = 0;
    for (let c = 0; c < chunks; c += 1) {
      let at = wide ? v.getUint32(co.at + 16 + 8 * c) * 2 ** 32 + v.getUint32(co.at + 20 + 8 * c) : v.getUint32(co.at + 16 + 4 * c);
      for (let k = 0; k < perChunk && s < count; k += 1, s += 1) { samples.push(bytes.slice(at, at + sizes[s])); at += sizes[s]; }
    }
    const slice = (b) => (b ? bytes.slice(b.at, b.end) : null);
    out[id] = { handler: String.fromCharCode(...bytes.subarray(hdlr.at + 16, hdlr.at + 20)), samples, tkhd: slice(tkhd), mdhd: slice(find(bytes, mdia, "mdhd")), edts: slice(find(bytes, trak, "edts")), stsd: slice(find(bytes, stbl, "stsd")), tref: slice(find(bytes, trak, "tref")) };
  }
  return out;
}

// How many times a text occurs anywhere in the bytes.
export function occurrences(bytes, text) {
  const needle = typeof text === "string" ? Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 255)) : text;
  let n = 0;
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let k = 0; k < needle.length; k += 1) if (bytes[i + k] !== needle[k]) continue outer;
    n += 1;
  }
  return n;
}
