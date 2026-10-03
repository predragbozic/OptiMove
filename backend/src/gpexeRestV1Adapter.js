// Read-only adapter profile for GPEXE, API family rest_v1 (the family
// server3 speaks). F3c2a built the frame; F3c2c (this file's current form)
// implements the eight reads the owner-run probe proved on server3
// (2026-10-01) and the one drill read the official GPEXE REST handbook
// documents. No route, no database, no credential storage; the caller hands
// in a credential it already holds and the connection's approved catalog row.
//
// Boundaries, each one tested (backend/tests/gpexe-rest-v1-adapter.test.mjs,
// backend/tests/gpexe-rest-v1-adapter-reads.test.mjs):
//   * every rest_v1 URL is built by sourceApiUrl() with the approved catalog
//     row — this file holds no host, no base URL and no family prefix;
//   * ONE exception, as narrow as it can be: the drill results and the drill
//     tags live in the legacy `api/` family on the same server3 host
//     (handbook pages 31-33: GET api/team_session/<parent>/details/?drill=<i>,
//     i zero-based from 0 to drills_count - 1; GET api/team_session/<parent>/brief/).
//     legacyDrillDetailsUrl() and legacyBriefUrl() build exactly those two
//     URLs for the approved server3 host and nothing else: no other path, no
//     other query, no other family, no fallback. They are not a generic
//     `api/` family;
//   * GET only. The one function that talks to the network is a closure; it
//     is not exported or returned, and there is no generic request helper;
//   * every operation reads for the BOUND source team only. The team id is
//     fixed when the adapter is created; no operation accepts one, and an
//     option that names a team in any spelling is refused;
//   * a returned team, session or next-page link that names another team is
//     refused; nothing of that answer is returned. Resources without a team
//     parameter (details, athlete rows, /more/, tracks, drills, tags) are
//     reachable only from a session this adapter instance has first read and
//     found to belong to the bound team (session_not_confirmed otherwise);
//   * a list is whole or refused; a page whose parent/drill structure is
//     ambiguous is refused with source_list_ambiguous, never thinned;
//   * the top-level `team` of a details answer is the team's aggregated
//     parameters (handbook), not an identity field: it is never read as one.
//     `drills` entries and a drill answer's `teamsession` are used neither to
//     build a URL nor as an identity guard;
//   * errors carry a stable code and OptiMove's own sentence, never the
//     source's text; the credential is only ever in the Authorization header;
//     the importer's drop list of personal fields (redactGpexe) is applied to
//     every answer before anything is kept, so no athlete name is returned.
//
// The existing e03 importer (backend/src/gpexeClient.js) is not changed and
// does not use this file.
import { redactGpexe } from "./gpexeClient.js";
import { resolveApprovedSourceHost, sourceApiUrl, sourceHost } from "./sourceHosts.js";

export const ADAPTER_SOURCE = "gpexe";
export const ADAPTER_API_FAMILY = "rest_v1";
export const SESSION_PAGE_LIMIT_MAX = 100;
export const MAX_PAGES = 20;
// One answer is at most this many BYTES (5 MiB). A larger one is refused:
// unread when it is announced, cancelled when it is counted.
export const MAX_ANSWER_BYTES = 5 * 1024 * 1024;
// A session with more drills than this is refused (the e03 importer's own
// bound): drills_count comes from the source and drives one request per drill.
export const MAX_DRILLS = 30;
// The most athlete rows one session's list may carry (a team has at most a
// few dozen athletes; a larger answer is not a session of the bound team).
export const MAX_ATHLETE_ROWS = 200;
// A date window is at most this many days, inclusive (the Imports screen
// clips to 31 days; the adapter holds the same line).
export const MAX_WINDOW_DAYS = 31;
// The only query parameters a server-given next-page link may carry back.
const NEXT_LINK_KEYS = new Set(["limit", "offset", "start_timestamp_gte", "start_timestamp_lte"]);
// The legacy drill reads: the only `api/` host key and the only two shapes.
export const LEGACY_DRILL_HOST_KEY = "server3";
export const LEGACY_API_PREFIX = "api/";

const TEAM_ID = /^(0|[1-9][0-9]{0,11})$/;
// The canonical GPEXE athlete id, the same pattern the importer enforces
// (gpexeImportMapper.js GPEXE_ATHLETE_ID_PATTERN); the keys of a `players`
// map must match it.
export const ATHLETE_ID = /^(0|[1-9][0-9]{0,11})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A bound team id is given as its canonical string (or as that whole number);
// a list, an object or anything that only LOOKS like the id when printed is not.
const canonicalId = (value) => {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return text !== null && TEAM_ID.test(text) ? text : null;
};
const boundTeam = canonicalId;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validDay = (value) => {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
};
const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const dayOf = (timestamp) => (typeof timestamp === "string" && DAY.test(timestamp.slice(0, 10)) ? timestamp.slice(0, 10) : null);

export class SourceAdapterError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "SourceAdapterError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// What is known about each resource of rest_v1, and how it is known.
//   proven      an owner-run read-only probe read it on server3: status 200,
//               body shape and field names (2026-09-29; 2026-10-01 full run);
//   observed    answered 200 with a known shape, but not an importer read of
//               rest_v1 as such: the legacy `api/` drill read (owner-run
//               2026-10-01, handbook pages 31-33) and the tag list;
//   unknown     nothing is known.
// "proven" and "observed" are implemented; "unknown" is source_capability_unavailable.
export const REST_V1_CAPABILITIES = Object.freeze({
  team_list: Object.freeze({ status: "proven", importerUse: "verify the bound team is visible", e03: "not used", evidence: "probe 2026-09-29: GET team/ 200, array, X-Total-Count" }),
  team_read: Object.freeze({ status: "proven", importerUse: "verify the bound team is visible", e03: "not used", evidence: "probe 2026-09-29: GET team/<id>/ 200, object" }),
  session_list: Object.freeze({ status: "proven", importerUse: "none as it is: the importer always lists with a date window", e03: "not sent without a date window", evidence: "probe 2026-09-29: GET team_session/?team=&limit=1 200, array, X-Total-Count, Link" }),
  session_list_by_date: Object.freeze({ status: "proven", importerUse: "team sessions of a date window", e03: "team_session/?team=&start_timestamp_gte=&start_timestamp_lte=&limit=", evidence: "probe 2026-10-01: the filter applied (every row inside the window, filtered count smaller than unfiltered)" }),
  session_read: Object.freeze({ status: "proven", importerUse: "one session, its team and drills_count", e03: "team_session/<id>/", evidence: "probe 2026-10-01: 200, object, team, drills_count, start_timestamp; no drills list on this read" }),
  session_details: Object.freeze({ status: "proven", importerUse: "whole-session values per athlete", e03: "team_session/<id>/details/", evidence: "probe 2026-10-01: 200" }),
  session_drill_details: Object.freeze({ status: "observed", importerUse: "values per drill", e03: "team_session/<id>/details/?drill=<n>", evidence: "legacy api family on server3 (owner-run 2026-10-01: 200, object, players map); form per the GPEXE REST handbook pages 31-33; read through legacyDrillDetailsUrl() only" }),
  athlete_session_list: Object.freeze({ status: "proven", importerUse: "athlete rows of a session", e03: "athlete_session/?teamsession=<id>&limit=", evidence: "probe 2026-10-01: 200, every row of the asked session" }),
  athlete_session_read: Object.freeze({ status: "proven", importerUse: "one athlete row", e03: "athlete_session/<id>/", evidence: "probe 2026-10-01: 200, names the same session" }),
  athlete_session_more: Object.freeze({ status: "proven", importerUse: "burst and brake events", e03: "athlete_session/<id>/more/", evidence: "probe 2026-10-01: 200" }),
  track_read: Object.freeze({ status: "proven", importerUse: "time zone, device restarts", e03: "track/<id>/", evidence: "probe 2026-10-01: 200, id from the confirmed athlete detail" }),
  team_thresholds: Object.freeze({ status: "proven", importerUse: "threshold set valid on the session day", e03: "team/<team>/thresholds/?valid_on=", evidence: "probe 2026-10-01: 200 on the confirmed session's day" }),
  units: Object.freeze({ status: "unknown", importerUse: "none (numbers are SI on e03)", e03: "no endpoint used", evidence: "none; that rest_v1 numbers are SI is not verified" }),
  session_tags: Object.freeze({ status: "observed", importerUse: "drill names through drillTags", e03: "not used", evidence: "probe 2026-10-01: team_session_tag/?team=&limit= 200, asked for the bound team" }),
});
const AVAILABLE_STATUSES = new Set(["proven", "observed"]);

function unavailable(capability) {
  return new SourceAdapterError(
    "source_capability_unavailable",
    "This source server has not been verified for that read yet.",
    { capability, capabilityStatus: REST_V1_CAPABILITIES[capability]?.status ?? "unknown" },
  );
}
const unexpected = (message, extra = {}) => new SourceAdapterError("source_answer_unexpected", message, extra);
const ambiguous = (reason) => new SourceAdapterError("source_list_ambiguous", "The source server's session list cannot be told apart into sessions and drills; nothing of it is used.", { reason });

// No operation takes a team. An option that names one, in any spelling, is
// a caller's mistake or an attempt to read another team: refused.
function refuseTeamOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SourceAdapterError("invalid_options", "The options of a source read are a plain object.");
  }
  for (const key of Object.keys(options)) {
    if (/team/i.test(key)) throw new SourceAdapterError("team_param_not_allowed", "A source read is always for the bound team; a team cannot be passed.");
  }
  return options;
}
// The options of a read, with exactly the keys it knows.
function only(options, allowed) {
  const given = refuseTeamOptions(options);
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) throw new SourceAdapterError("invalid_options", "That option is not known to this source read.");
  }
  return given;
}
const requireId = (value, what) => {
  const id = canonicalId(value);
  if (id === null) throw new SourceAdapterError("invalid_id", `${what} is not a canonical source id.`);
  return id;
};

// The query of a team-scoped list: the bound team first, then the given
// pairs. A pair may not name the team, and no key may come twice. A value
// is plain text; the only percent-encoded characters it may carry are the
// space (%20) and the colon (%3A) of a timestamp, the exact form the probe
// proved for the date window.
const QUERY_VALUE = /^(?:[A-Za-z0-9_.:-]|%20|%3A)+$/;
export function teamScopedPath(resource, boundTeamId, pairs = []) {
  const boundId = boundTeam(boundTeamId);
  if (boundId === null) throw new SourceAdapterError("invalid_bound_team", "The bound source team id is not a canonical id.");
  if (typeof resource !== "string" || !/^[a-z_]+\/$/.test(resource)) throw new SourceAdapterError("path_not_allowed", "A list resource is one lower-case segment.");
  const seen = new Set(["team"]);
  const parts = [`team=${boundId}`];
  for (const pair of pairs) {
    const [key, value] = Array.isArray(pair) ? pair : [];
    if (typeof key !== "string" || !/^[a-z_]+$/.test(key)) throw new SourceAdapterError("path_not_allowed", "A query key is lower-case letters and underscores.");
    if (/team/i.test(key)) throw new SourceAdapterError("team_param_not_allowed", "A source read is always for the bound team; a team cannot be passed.");
    if (seen.has(key)) throw new SourceAdapterError("duplicate_param", "A query key may be given once.");
    seen.add(key);
    const text = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
    if (text === null || !QUERY_VALUE.test(text)) throw new SourceAdapterError("path_not_allowed", "A query value is a plain string or a whole number.");
    parts.push(`${key}=${text}`);
  }
  return `${resource}?${parts.join("&")}`;
}

// The two legacy URLs, and nothing else under `api/`. Both go through the
// catalog gate like every rest_v1 URL; both refuse any host key but server3.
function legacyBase(hostKey, catalogRow) {
  const host = resolveApprovedSourceHost(ADAPTER_SOURCE, hostKey, catalogRow);
  if (hostKey !== LEGACY_DRILL_HOST_KEY || host !== sourceHost(ADAPTER_SOURCE, LEGACY_DRILL_HOST_KEY)) {
    throw new SourceAdapterError("path_not_allowed", "The legacy drill read exists for the approved server3 host only.");
  }
  return host.baseUrl;
}
function legacyUrl(base, parentId, suffix) {
  const url = new URL(`${LEGACY_API_PREFIX}team_session/${parentId}/${suffix}`, base);
  if (url.origin !== new URL(base).origin || url.pathname !== `/${LEGACY_API_PREFIX}team_session/${parentId}/${suffix.split("?")[0]}` || url.hash || url.username || url.password) {
    throw new SourceAdapterError("path_not_allowed", "The legacy drill URL left its one allowed shape.");
  }
  return url.href;
}
// GET api/team_session/<confirmed parent id>/details/?drill=<index>, the
// drill at a zero-based position from 0 to drills_count - 1 (handbook). The
// parent id must already be a confirmed session of the bound team — this
// function cannot know that, the adapter's reads enforce it.
export function legacyDrillDetailsUrl({ hostKey, catalogRow, parentId, drillIndex, drillsCount } = {}) {
  const base = legacyBase(hostKey, catalogRow);
  const parent = canonicalId(parentId);
  if (parent === null) throw new SourceAdapterError("invalid_id", "The parent session id is not a canonical source id.");
  if (!Number.isInteger(drillsCount) || drillsCount < 1 || drillsCount > MAX_DRILLS) throw new SourceAdapterError("drills_count_out_of_range", `A session has between 1 and ${MAX_DRILLS} drills to read.`);
  if (typeof drillIndex !== "number" || !Number.isInteger(drillIndex) || drillIndex < 0 || drillIndex >= drillsCount) {
    throw new SourceAdapterError("invalid_drill_index", "A drill index is a whole number from 0 to drills_count - 1.");
  }
  const href = legacyUrl(base, parent, `details/?drill=${drillIndex}`);
  if (new URL(href).search !== `?drill=${drillIndex}`) throw new SourceAdapterError("path_not_allowed", "The legacy drill URL carries one query parameter, drill.");
  return href;
}
// GET api/team_session/<confirmed parent id>/brief/ (handbook: Team Session Brief, drillTags).
export function legacyBriefUrl({ hostKey, catalogRow, parentId } = {}) {
  const base = legacyBase(hostKey, catalogRow);
  const parent = canonicalId(parentId);
  if (parent === null) throw new SourceAdapterError("invalid_id", "The parent session id is not a canonical source id.");
  const href = legacyUrl(base, parent, "brief/");
  if (new URL(href).search !== "") throw new SourceAdapterError("path_not_allowed", "The legacy brief URL carries no query.");
  return href;
}

function nextFromLinkHeader(link) {
  if (typeof link !== "string") return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

// A team value of an answer names the bound team only when it is that id as
// a number or as a canonical string. Any other shape (an object, a URL, a
// list) is not interpreted: the answer is refused.
function namesBoundTeam(value, boundTeamId) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value) === boundTeamId;
  if (typeof value === "string" && TEAM_ID.test(value)) return value === boundTeamId;
  return null;
}

const tooLarge = () => new SourceAdapterError("source_answer_unexpected", "The source server answered with more than can be read.");

// The body of an answer, as text, or a refusal — never part of it.
// MAX_ANSWER_BYTES is a limit in BYTES on what is really received: the body
// is read from its stream chunk by chunk, the bytes are counted as they
// arrive, and the stream is cancelled the moment the count passes the limit.
// Content-Length is only an early guard: an answer that announces too much
// is refused unread, but an answer that announces little, or nothing, is
// still counted. The whole body is never asked for in one piece.
export async function readBounded(res, contentLength = null, limit = MAX_ANSWER_BYTES) {
  const announced = contentLength === null || contentLength === undefined || contentLength === "" ? NaN : Number(contentLength);
  const stream = res?.body;
  // Letting go of the stream is asked for, never waited for: the refusal
  // stands whether or not, and whenever, the source lets go.
  const cancel = (target) => {
    try {
      Promise.resolve(target?.cancel?.()).catch(() => {});
    } catch {
      // A cancel that throws changes nothing.
    }
  };
  if (Number.isFinite(announced) && announced > limit) {
    cancel(stream);
    throw tooLarge();
  }
  if (stream === null || stream === undefined) return "";
  if (typeof stream.getReader !== "function") {
    throw new SourceAdapterError("source_answer_unexpected", "The source server's answer cannot be read as a stream.");
  }
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        cancel(reader);
        throw new SourceAdapterError("source_answer_unexpected", "The source server's answer did not arrive as bytes.");
      }
      received += value.byteLength;
      if (received > limit) {
        cancel(reader);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceAdapterError) throw error;
    cancel(reader);
    throw new SourceAdapterError("source_unavailable", "The source server's answer stopped before its end.");
  }
  try {
    reader.releaseLock();
  } catch {
    // The stream is closed; nothing depends on the lock.
  }
  // Decoded once, over all the bytes: a character split between two chunks
  // stays one character.
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// A `players` answer (whole session or one drill): an object whose `players`
// is a non-empty map keyed by canonical athlete ids, each value a plain
// object of metric values — a finite number, null, or an object whose own
// values are finite numbers, null or short unit strings (the importer's
// known shape, e.g. { unit, value }). Nothing else, nothing deeper: a name,
// a free text or an unknown nesting refuses the answer. The top-level `team`
// is not read and not returned: the handbook documents it as aggregated
// parameters, and on server3 it is an opaque object.
const SHORT_TEXT = /^[A-Za-z0-9_./%-]{1,16}$/;
function metricLeaf(v) {
  return v === null || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && SHORT_TEXT.test(v)) || typeof v === "boolean";
}
function metricValue(v) {
  if (metricLeaf(v)) return true;
  if (isPlainObject(v)) return Object.values(v).every(metricLeaf) && Object.keys(v).length <= 32;
  return false;
}
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validatePlayersAnswer(body, what = "the details answer", expectedDrillsCount = null) {
  if (!isPlainObject(body)) throw unexpected(`The source server did not answer ${what} as an object.`);
  const players = body.players;
  if (!isPlainObject(players)) throw unexpected(`The source answer to ${what} carries no players map.`, { reason: "players_missing" });
  // An empty map is a valid answer: a drill whose details are not yet
  // computed (the e03 pilot fixtures carry it, the importer skips such
  // values). Only a missing, null, array or otherwise wrong `players` fails.
  const keys = Object.keys(players);
  for (const key of keys) {
    if (!ATHLETE_ID.test(key)) throw unexpected(`The source answer to ${what} names an athlete in an unknown way.`, { reason: "athlete_id_not_canonical" });
    const values = players[key];
    if (!isPlainObject(values) || Object.keys(values).length === 0) throw unexpected(`The source answer to ${what} has an athlete without metric values.`, { reason: "player_values_missing" });
    if (Object.keys(values).length > 256) throw unexpected(`The source answer to ${what} has too many metric values for one athlete.`, { reason: "player_values_too_many" });
    for (const [metric, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(metric) || PROTOTYPE_KEYS.has(metric) || !metricValue(value)) {
        throw unexpected(`The source answer to ${what} carries a metric value in an unknown shape.`, { reason: "metric_shape_unknown" });
      }
    }
  }
  // Only what the importer reads leaves the adapter: the players map and the
  // drill count. The top-level `team` (aggregated parameters, an opaque
  // object on server3) and `teamsession` are neither identity nor needed,
  // and are not returned.
  if (expectedDrillsCount !== null && body.drills_count !== undefined && body.drills_count !== null && body.drills_count !== expectedDrillsCount) {
    throw unexpected(`The source answer to ${what} reports another number of drills than the confirmed session.`, { reason: "drills_count_disagrees" });
  }
  return { players, ...(Number.isInteger(body.drills_count) ? { drills_count: body.drills_count } : {}) };
}

// drillTags → a position-to-tag mapping, or null when the shape is not one
// of the two explicit candidate shapes (neither has been observed on a
// server yet; the handbook names the field, not its shape). Shape A: an array
// of exactly drillsCount entries, entry i a canonical tag id or null for the
// drill at position i. Shape B: an array of plain objects { drill: <index>,
// tag: <tag id> }, each drill at most once. A tag id used at two positions,
// a length that disagrees with drills_count, an index out of range or
// anything else is ambiguous: null, and every drill falls back to Drill N.
export function parseDrillTags(drillTags, drillsCount) {
  if (!Array.isArray(drillTags) || !Number.isInteger(drillsCount) || drillsCount < 0) return null;
  const byIndex = new Map();
  if (drillTags.every((e) => e === null || canonicalId(e) !== null)) {
    if (drillTags.length !== drillsCount) return null;
    drillTags.forEach((e, i) => { if (e !== null) byIndex.set(i, canonicalId(e)); });
  } else if (drillTags.every((e) => isPlainObject(e))) {
    if (drillTags.length > drillsCount) return null;
    for (const e of drillTags) {
      const index = e.drill;
      const tag = canonicalId(e.tag);
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= drillsCount || tag === null || byIndex.has(index)) return null;
      byIndex.set(index, tag);
    }
  } else {
    return null;
  }
  const tags = [...byIndex.values()];
  if (new Set(tags).size !== tags.length) return null;
  return byIndex;
}

export function createGpexeRestV1Adapter({
  hostKey,
  catalogRow,
  credential,
  boundSourceTeamId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  attempts = 1,
  retryDelayMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // The gate: the key's own approved catalog row, and the family this file is for.
  const probeUrl = sourceApiUrl(ADAPTER_SOURCE, hostKey, catalogRow, "team/");
  const host = sourceHost(ADAPTER_SOURCE, hostKey);
  if (host.apiFamily !== ADAPTER_API_FAMILY) {
    throw new SourceAdapterError("adapter_not_available", "This adapter is for another API family than the host speaks.");
  }
  const team = boundTeam(boundSourceTeamId);
  if (team === null) throw new SourceAdapterError("invalid_bound_team", "The bound source team id is not a canonical id.");
  if (typeof credential !== "string" || !credential || /[\r\n]/.test(credential)) {
    throw new SourceAdapterError("credential_missing", "No usable credential was given to the source adapter.");
  }
  if (typeof fetchImpl !== "function") throw new SourceAdapterError("invalid_options", "The source adapter needs a fetch implementation.");
  // No retry unless the caller asks for one, and then at most three attempts:
  // a credential travels with every attempt, and a failing source is never
  // asked the same thing again by default (F3c2c security review).
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new SourceAdapterError("invalid_options", "The number of attempts is a whole number from 1 to 3.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new SourceAdapterError("invalid_options", "The timeout is a whole number of milliseconds up to 120000.");
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) throw new SourceAdapterError("invalid_options", "The retry delay is a whole number of milliseconds up to 10000.");
  if (typeof sleep !== "function") throw new SourceAdapterError("invalid_options", "The source adapter needs a sleep function.");
  const root = probeUrl.slice(0, -"team/".length);
  const authorization = `${host.authScheme} ${credential}`;

  // What this instance has confirmed: sessions whose own read named the
  // bound team (id → drills count and day), athlete rows read under such a
  // session (id → its track id), and the tracks those rows named.
  const confirmedSessions = new Map();
  const listedAthleteRows = new Map(); // session id → Set of row ids its own list named
  const confirmedAthleteRows = new Map();
  const confirmedTracks = new Set();

  // The ONLY network function. GET, one URL that a builder of this file
  // made, nothing else. Every rest_v1 read goes through sourceApiUrl(); the
  // two legacy reads go through legacyDrillDetailsUrl() / legacyBriefUrl().
  async function fetchBuilt(url) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { Authorization: authorization, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        last = new SourceAdapterError("source_unavailable", "The source server did not answer.");
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      const status = res.status;
      if (status >= 300 && status < 400) throw new SourceAdapterError("source_answer_unexpected", "The source server answered with a redirect, which is refused.", { status });
      // 401: the credential itself was refused. 403: the credential was read
      // but may not do this; the two are told apart for the administrator.
      if (status === 401) throw new SourceAdapterError("source_auth_rejected", "The source server refused the credential.", { status });
      if (status === 403) throw new SourceAdapterError("source_access_refused", "The source server does not allow this credential to read that.", { status });
      if (status === 404) throw new SourceAdapterError("source_not_found", "The source server has nothing at that place.", { status });
      // Asked to slow down: not repeated, so a rate limit is never made worse.
      if (status === 429) throw new SourceAdapterError("source_unavailable", "The source server asked to slow down.", { status });
      if (status >= 500) {
        last = new SourceAdapterError("source_unavailable", "The source server is not available.", { status });
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
        continue;
      }
      if (status !== 200) throw new SourceAdapterError("source_answer_unexpected", "The source server answered in a way that is not expected.", { status });
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      const text = await readBounded(res, header("content-length"));
      let body;
      try {
        body = redactGpexe(JSON.parse(text));
      } catch {
        throw new SourceAdapterError("source_answer_unexpected", "The source server answered with something that cannot be read as JSON.");
      }
      return { body, totalCount: header("x-total-count"), link: header("link") };
    }
    throw last ?? new SourceAdapterError("source_unavailable", "The source server did not answer.");
  }
  const read = (resourcePath) => fetchBuilt(sourceApiUrl(ADAPTER_SOURCE, hostKey, catalogRow, resourcePath));
  const readDrill = (parentId, drillIndex, drillsCount) => fetchBuilt(legacyDrillDetailsUrl({ hostKey, catalogRow, parentId, drillIndex, drillsCount }));
  const readBrief = (parentId) => fetchBuilt(legacyBriefUrl({ hostKey, catalogRow, parentId }));

  // A next-page link of a team-scoped list, as the server gave it: it must
  // stay on this host and family, on the same resource, and name the bound
  // team exactly once. It is then rebuilt as a relative path and goes
  // through sourceApiUrl() like every other read.
  function nextPath(next, resource) {
    if (typeof next !== "string" || !next.startsWith(root)) {
      throw unexpected("The source server pointed to a next page outside its own API.");
    }
    let url;
    try {
      url = new URL(next);
    } catch {
      throw unexpected("The source server pointed to a next page that cannot be read.");
    }
    if (url.href.slice(root.length).split("?")[0] !== resource || url.hash || url.username || url.password) {
      throw unexpected("The source server pointed to a next page of another resource.");
    }
    const keys = [...url.searchParams.keys()];
    const teams = url.searchParams.getAll("team");
    if (teams.length !== 1 || teams[0] !== team || keys.some((k) => k !== "team" && /team/i.test(k))) {
      throw new SourceAdapterError("source_team_mismatch", "The source server pointed to a next page of another team.");
    }
    if (new Set(keys).size !== keys.length) {
      throw unexpected("The source server pointed to a next page with a repeated parameter.");
    }
    // A timestamp value comes back decoded; it goes out in the one proved encoding.
    // Only the page position and the two window bounds may travel in a link.
    const pairs = keys.filter((k) => k !== "team").map((k) => [k, url.searchParams.get(k).replace(/ /g, "%20").replace(/:/g, "%3A")]);
    for (const [k, v] of pairs) {
      if (!NEXT_LINK_KEYS.has(k) || (k !== "start_timestamp_gte" && k !== "start_timestamp_lte" && !/^(0|[1-9][0-9]{0,5})$/.test(v))) {
        throw unexpected("The source server pointed to a next page with a parameter this adapter does not follow.");
      }
    }
    try {
      return teamScopedPath(resource, team, pairs);
    } catch {
      throw unexpected("The source server pointed to a next page that cannot be read.");
    }
  }
  // A list of a session's athlete rows pages with teamsession=<id>, not team=.
  function nextAthletePath(next, sessionId) {
    if (typeof next !== "string" || !next.startsWith(root)) throw unexpected("The source server pointed to a next page outside its own API.");
    let url;
    try {
      url = new URL(next);
    } catch {
      throw unexpected("The source server pointed to a next page that cannot be read.");
    }
    if (url.href.slice(root.length).split("?")[0] !== "athlete_session/" || url.hash || url.username || url.password) throw unexpected("The source server pointed to a next page of another resource.");
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((k) => k !== "teamsession" && /team/i.test(k))) throw unexpected("The source server pointed to a next page with a repeated or unknown parameter.");
    if (url.searchParams.getAll("teamsession").join(",") !== sessionId) throw unexpected("The source server pointed to a next page of another session.");
    const parts = [`teamsession=${sessionId}`];
    for (const k of keys.filter((k) => k !== "teamsession")) {
      const v = url.searchParams.get(k);
      if ((k !== "limit" && k !== "offset") || !/^(0|[1-9][0-9]{0,5})$/.test(v)) throw unexpected("The source server pointed to a next page with a parameter this adapter does not follow.");
      parts.push(`${k}=${v}`);
    }
    return `athlete_session/?${parts.join("&")}`;
  }

  // One page of a header-paged list, whole or refused; `follow` builds the
  // next relative path from the server's link.
  async function wholeList(firstPath, follow, what, maxPages = MAX_PAGES) {
    const rows = [];
    const ids = new Set();
    let total = null;
    let path = firstPath;
    for (let page = 1; page <= maxPages; page += 1) {
      const res = await read(path);
      if (!Array.isArray(res.body)) throw unexpected(`The source server did not answer ${what} as a list.`);
      const pageTotal = Number(res.totalCount);
      if (res.totalCount === null || res.totalCount === undefined || res.totalCount === "" || !Number.isInteger(pageTotal) || pageTotal < 0) {
        throw unexpected(`The source server did not say how many rows ${what} has.`);
      }
      if (total === null) total = pageTotal;
      else if (total !== pageTotal) throw new SourceAdapterError("source_list_changed", `The number of rows of ${what} changed while it was read; read it again.`);
      for (const row of res.body) {
        if (!isPlainObject(row)) throw unexpected(`A row of ${what} is not an object.`);
        const id = canonicalId(row.id);
        if (id === null) throw unexpected(`A row of ${what} has no usable id.`);
        if (ids.has(id)) throw new SourceAdapterError("source_list_changed", `A row of ${what} came twice while it was read; read it again.`);
        ids.add(id);
        rows.push(row);
      }
      if (rows.length > total) throw new SourceAdapterError("source_list_changed", `The source returned more rows of ${what} than it reported; read it again.`);
      const next = nextFromLinkHeader(res.link);
      if (next === null) {
        if (rows.length !== total) throw new SourceAdapterError("source_list_incomplete", `The source reported more rows of ${what} than could be read.`);
        return { rows, total };
      }
      if (rows.length === total) throw unexpected(`The source announced another page of ${what} after the last row.`);
      path = follow(next);
    }
    throw new SourceAdapterError("source_list_incomplete", `${what} has more pages than the allowed number.`);
  }

  // Every session row names the bound team and has a usable id; its drills
  // list, when present, is a list of canonical ids; its drills_count, when
  // present, is a whole number.
  function checkSessionRows(rows) {
    for (const row of rows) {
      const named = namesBoundTeam(row.team, team);
      if (named === null) throw unexpected("A session of the source answer does not name its team in a known way.");
      if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned a session of another team.");
      if (row.drills !== undefined && row.drills !== null) {
        if (!Array.isArray(row.drills) || row.drills.some((d) => canonicalId(d) === null)) throw unexpected("A session of the source answer lists its drills in an unknown way.");
      }
      if (row.drills_count !== undefined && row.drills_count !== null && (!Number.isInteger(row.drills_count) || row.drills_count < 0)) {
        throw unexpected("A session of the source answer counts its drills in an unknown way.");
      }
    }
  }

  // The whole list, told apart into parents and drills, or refused. The
  // meaning used is the one the e03 responses and the list fixtures confirm:
  // a drill is listed as a row of its own, named in exactly one parent's
  // `drills`, and carries no drills itself. Anything that does not fit —
  // a named row that has drills of its own, an entry named twice, a row
  // naming itself, an entry that is on no row of the whole list, a `drills`
  // list that disagrees with `drills_count` — is ambiguous: refused with a
  // stable code, never a thinned list. An entry that names no row of the list
  // (a drill outside the window, or a reference that is not a list id at all)
  // misclassifies nothing: the parent stays a parent and the reference is
  // counted as not listed. `drills` entries are page-local references only;
  // they are never read as resource ids and never put into a URL.
  function classifyParents(rows) {
    const byId = new Map(rows.map((r) => [canonicalId(r.id), r]));
    const namedBy = new Map();
    let notListed = 0;
    for (const row of rows) {
      const id = canonicalId(row.id);
      const entries = Array.isArray(row.drills) ? row.drills.map(canonicalId) : [];
      const count = Number.isInteger(row.drills_count) ? row.drills_count : null;
      if ((count !== null && count !== entries.length) || (count === null && entries.length > 0)) throw ambiguous("drills_count_disagrees");
      for (const entry of entries) {
        if (entry === id) throw ambiguous("self_reference");
        if (!byId.has(entry)) { notListed += 1; continue; }
        if (namedBy.has(entry)) throw ambiguous("entry_named_twice");
        namedBy.set(entry, id);
      }
    }
    for (const entry of namedBy.keys()) {
      const row = byId.get(entry);
      const ownEntries = Array.isArray(row.drills) ? row.drills.length : 0;
      const ownCount = Number.isInteger(row.drills_count) ? row.drills_count : 0;
      if (ownEntries > 0 || ownCount > 0) throw ambiguous("named_row_has_drills");
    }
    const parents = rows.filter((r) => !namedBy.has(canonicalId(r.id)));
    return { parents, drillsLeftOut: rows.length - parents.length, drillReferencesNotListed: notListed };
  }

  const summary = (s) => ({
    id: canonicalId(s.id),
    categoryName: s.category_name ?? null,
    startTimestamp: s.start_timestamp ?? null,
    endTimestamp: s.end_timestamp ?? null,
    updatedOn: s.updated_on ?? null,
    drillsCount: Number.isInteger(s.drills_count) ? s.drills_count : 0,
    isStatsValid: s.is_stats_valid === true,
    // Page-local references, as the source lists them: never resource ids.
    drillIds: Array.isArray(s.drills) ? s.drills.map(canonicalId) : [],
  });

  async function sessionList(firstPath, maxPages) {
    const { rows, total } = await wholeList(firstPath, (next) => nextPath(next, "team_session/"), "the session list", maxPages);
    checkSessionRows(rows);
    const { parents, drillsLeftOut, drillReferencesNotListed } = classifyParents(rows);
    return { sessions: parents.map(summary), total, drillsLeftOut, drillReferencesNotListed };
  }

  const confirmed = (sessionId) => {
    const id = requireId(sessionId, "The session id");
    const known = confirmedSessions.get(id);
    if (!known) throw new SourceAdapterError("session_not_confirmed", "That session was not first read as a session of the bound team by this adapter.");
    return { id, ...known };
  };
  // Errors that end a whole operation whatever it was reading: the credential
  // or the team is the problem, not one resource.
  const isGlobal = (e) => ["source_auth_rejected", "source_access_refused", "source_team_mismatch", "host_not_allowed", "path_not_allowed", "credential_missing"].includes(e?.code);

  const adapter = {
    sourceSystem: ADAPTER_SOURCE,
    apiFamily: ADAPTER_API_FAMILY,
    hostKey,
    boundSourceTeamId: team,

    capabilities() {
      return Object.fromEntries(Object.entries(REST_V1_CAPABILITIES).map(([name, c]) => [name, { status: c.status, available: AVAILABLE_STATUSES.has(c.status) }]));
    },

    // Is the bound team readable with this credential? The team's own read
    // decides; the list is not needed and the other teams are never returned.
    async verifyBoundTeam(options) {
      refuseTeamOptions(options);
      let res;
      try {
        res = await read(`team/${team}/`);
      } catch (error) {
        if (error.code === "source_not_found" || error.code === "source_access_refused") {
          throw new SourceAdapterError("source_team_not_visible", "The bound team is not visible with this credential.", { status: error.status });
        }
        throw error;
      }
      const body = res.body;
      if (!isPlainObject(body)) throw unexpected("The source server did not answer the team as an object.");
      const named = namesBoundTeam(body.id, team);
      if (named === null) throw unexpected("The source answer does not name the team in a known way.");
      if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned another team.");
      return { visible: true, sourceTeamId: team };
    },

    // How many teams the credential sees. A count and a boolean only: no
    // other team leaves here. The boolean is about the FIRST page and says
    // so; whether the bound team is readable is verifyBoundTeam()'s answer.
    async countVisibleTeams(options) {
      refuseTeamOptions(options);
      const res = await read("team/");
      if (!Array.isArray(res.body)) throw unexpected("The source server did not answer the team list as a list.");
      const total = Number(res.totalCount);
      if (res.totalCount === null || res.totalCount === undefined || res.totalCount === "" || !Number.isInteger(total) || total < 0) {
        throw unexpected("The source server did not say how many teams there are.");
      }
      return {
        teamCount: total,
        boundTeamOnFirstPage: res.body.some((t) => t && namesBoundTeam(t.id, team) === true),
        firstPageOnly: res.body.length < total,
      };
    },

    // Every parent session of the bound team, in the order the source gives
    // them: the whole list or a refusal, never part of it.
    async listSessions(options) {
      const { limit = SESSION_PAGE_LIMIT_MAX, maxPages = MAX_PAGES, ...rest } = refuseTeamOptions(options);
      const unknownOption = Object.keys(rest)[0];
      if (unknownOption !== undefined) {
        if (/day|date|from|to|start|end|since|until/i.test(unknownOption)) throw new SourceAdapterError("invalid_options", "A date window is read with listSessionsByDay.");
        throw new SourceAdapterError("invalid_options", "That option is not known to the session list.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_PAGE_LIMIT_MAX) throw new SourceAdapterError("invalid_options", "The page size is a whole number from 1 to 100.");
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new SourceAdapterError("invalid_options", "The number of pages is a whole number from 1 to 20.");
      return sessionList(teamScopedPath("team_session/", team, [["limit", limit]]), maxPages);
    },

    // The parent sessions of the bound team that start inside a date window
    // (naive source timestamps, the window inclusive on both days, at most
    // 31 days). Every returned row must lie inside the window: a source that
    // ignores the filter is refused, never passed on as the window.
    async listSessionsByDay(options) {
      const { fromDay, toDay } = only(options, ["fromDay", "toDay"]);
      const from = validDay(fromDay);
      const to = validDay(toDay);
      if (from === null || to === null) throw new SourceAdapterError("invalid_options", "A date window is two days as YYYY-MM-DD.");
      const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (span < 0 || span + 1 > MAX_WINDOW_DAYS) throw new SourceAdapterError("invalid_options", `A date window runs forward and covers at most ${MAX_WINDOW_DAYS} days.`);
      // Exactly one day earlier than asked, as the e03 importer reads: a drill
      // that starts inside the window can belong to a parent that started the
      // evening before, and is told apart only through that parent's `drills`.
      // The parents of that extra day are left out again after the
      // classification; a drill row is never returned as a session.
      const lookFrom = dayBefore(from);
      const path = teamScopedPath("team_session/", team, [["start_timestamp_gte", `${lookFrom}%2000%3A00%3A00`], ["start_timestamp_lte", `${to}%2023%3A59%3A59`], ["limit", SESSION_PAGE_LIMIT_MAX]]);
      const { rows, total } = await wholeList(path, (next) => nextPath(next, "team_session/"), "the session list");
      checkSessionRows(rows);
      for (const row of rows) {
        const day = dayOf(row.start_timestamp);
        if (day === null || day < lookFrom || day > to) throw new SourceAdapterError("source_filter_ignored", "The source server returned sessions outside the asked window; the window cannot be trusted.");
      }
      const { parents, drillsLeftOut, drillReferencesNotListed } = classifyParents(rows);
      const inWindow = parents.filter((p) => dayOf(p.start_timestamp) >= from);
      return { sessions: inWindow.map(summary), total, drillsLeftOut, drillReferencesNotListed, lookBackParentsLeftOut: parents.length - inWindow.length, lookBackDays: 1, fromDay: from, toDay: to };
    },

    // One session, read by its id: its answer must name the bound team and
    // the same id, or nothing of it is returned. A session read here becomes
    // a confirmed parent for the reads below.
    async getSession(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const id = requireId(sessionId, "The session id");
      // Read again means confirmed again: an earlier confirmation does not
      // survive a read that fails or names another team.
      confirmedSessions.delete(id);
      listedAthleteRows.delete(id);
      const { body } = await read(`team_session/${id}/`);
      if (!isPlainObject(body)) throw unexpected("The source server did not answer the session as an object.");
      if (canonicalId(body.id) !== id) throw unexpected("The source server answered another session than the one asked.");
      const named = namesBoundTeam(body.team, team);
      if (named === null) throw unexpected("The source answer does not name the session's team in a known way.");
      if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned a session of another team.");
      const drillsCount = body.drills_count === undefined || body.drills_count === null ? 0 : body.drills_count;
      if (!Number.isInteger(drillsCount) || drillsCount < 0 || drillsCount > MAX_DRILLS) {
        throw new SourceAdapterError("drills_count_out_of_range", `The session reports a number of drills outside 0 to ${MAX_DRILLS}.`);
      }
      const day = dayOf(body.start_timestamp);
      confirmedSessions.set(id, { drillsCount, day });
      return body;
    },

    // Whole-session values per athlete, for a confirmed parent.
    async getSessionDetails(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const parent = confirmed(sessionId);
      const { body } = await read(`team_session/${parent.id}/details/`);
      return validatePlayersAnswer(body, "the whole-session details", parent.drillsCount);
    },

    // The drill at one zero-based position of a confirmed parent, through the
    // narrow legacy builder. The answer is accepted only as a players map of
    // canonical athlete ids with metric values; its `team` and `teamsession`
    // are not read as identity.
    async getSessionDrillDetails(options) {
      const { sessionId, drillIndex } = only(options, ["sessionId", "drillIndex"]);
      const parent = confirmed(sessionId);
      if (parent.drillsCount < 1) throw new SourceAdapterError("invalid_drill_index", "That session has no drills.");
      const { body } = await readDrill(parent.id, drillIndex, parent.drillsCount);
      return validatePlayersAnswer(body, "the drill details", parent.drillsCount);
    },

    // Every drill of a confirmed parent, in position order. One drill that
    // cannot be read ends the reading there: what was read is returned with
    // complete: false and the failed position's stable code — never as a
    // complete set, and never with another index, host or form tried instead.
    // A refused credential or a team mismatch is not a per-drill failure: it
    // ends the whole operation.
    async getSessionDrills(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const parent = confirmed(sessionId);
      const drills = [];
      for (let index = 0; index < parent.drillsCount; index += 1) {
        try {
          const { body } = await readDrill(parent.id, index, parent.drillsCount);
          drills.push({ drillIndex: index, details: validatePlayersAnswer(body, "the drill details", parent.drillsCount) });
        } catch (error) {
          if (!(error instanceof SourceAdapterError) || isGlobal(error)) throw error;
          return { complete: false, drillsCount: parent.drillsCount, drills, failed: { drillIndex: index, code: error.code ?? "source_drill_unavailable" } };
        }
      }
      return { complete: true, drillsCount: parent.drillsCount, drills, failed: null };
    },

    // The athlete rows of a confirmed parent: every row must name that
    // session; whole or refused.
    async listAthleteSessions(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const parent = confirmed(sessionId);
      const { rows, total } = await wholeList(`athlete_session/?teamsession=${parent.id}&limit=${SESSION_PAGE_LIMIT_MAX}`, (next) => nextAthletePath(next, parent.id), "the athlete rows");
      if (rows.length > MAX_ATHLETE_ROWS) throw unexpected("The source server returned more athlete rows for one session than this adapter reads.", { reason: "athlete_rows_too_many" });
      const ids = new Set();
      for (const row of rows) {
        if (canonicalId(row.teamsession) !== parent.id) throw unexpected("The source server returned an athlete row of another session.", { reason: "row_of_another_session" });
        if (canonicalId(row.athlete) === null) throw unexpected("An athlete row of the source answer names its athlete in an unknown way.");
        const rowId = canonicalId(row.id);
        if (rowId === null) throw unexpected("An athlete row of the source answer names itself in an unknown way.");
        ids.add(rowId);
      }
      listedAthleteRows.set(parent.id, ids);
      return { rows, total };
    },

    // One athlete row, read under a confirmed parent: the detail must name
    // that session and the asked id. The row's track becomes readable.
    async getAthleteSession(options) {
      const { sessionId, athleteSessionId } = only(options, ["sessionId", "athleteSessionId"]);
      const parent = confirmed(sessionId);
      const id = requireId(athleteSessionId, "The athlete row id");
      // A row id is never typed in: it must come from the confirmed parent's own
      // athlete list, read by this instance. Otherwise no request is sent, so an
      // answer of another team's row is never fetched and never told apart.
      if (!listedAthleteRows.get(parent.id)?.has(id)) throw new SourceAdapterError("athlete_row_not_listed", "That athlete row was not named by the confirmed session's own athlete list read by this adapter.");
      const { body } = await read(`athlete_session/${id}/`);
      if (!isPlainObject(body) || canonicalId(body.id) !== id) throw unexpected("The source server answered another athlete row than the one asked.");
      if (canonicalId(body.teamsession) !== parent.id) throw unexpected("The source server's athlete row names another session.", { reason: "row_of_another_session" });
      if (canonicalId(body.athlete) === null) throw unexpected("The source server's athlete row names its athlete in an unknown way.");
      const trackId = body.track === undefined || body.track === null ? null : canonicalId(body.track);
      if (body.track !== undefined && body.track !== null && trackId === null) throw unexpected("The source server's athlete row names its track in an unknown way.");
      confirmedAthleteRows.set(id, { sessionId: parent.id, trackId });
      if (trackId !== null) confirmedTracks.add(trackId);
      return body;
    },

    // The burst and brake events of an athlete row read above.
    async getAthleteSessionMore(options) {
      const { athleteSessionId } = only(options, ["athleteSessionId"]);
      const id = requireId(athleteSessionId, "The athlete row id");
      if (!confirmedAthleteRows.has(id)) throw new SourceAdapterError("athlete_row_not_confirmed", "That athlete row was not first read under a confirmed session by this adapter.");
      const { body } = await read(`athlete_session/${id}/more/`);
      if (!isPlainObject(body)) throw unexpected("The source server did not answer the athlete row's events as an object.");
      if (body.athletesession_id !== undefined && canonicalId(body.athletesession_id) !== id) throw unexpected("The source server's events name another athlete row.");
      return body;
    },

    // A track named by an athlete row read above.
    async getTrack(options) {
      const { trackId } = only(options, ["trackId"]);
      const id = requireId(trackId, "The track id");
      if (!confirmedTracks.has(id)) throw new SourceAdapterError("track_not_confirmed", "That track was not named by an athlete row this adapter read under a confirmed session.");
      const { body } = await read(`track/${id}/`);
      if (!isPlainObject(body) || canonicalId(body.id) !== id) throw unexpected("The source server answered another track than the one asked.");
      return body;
    },

    // The threshold set of the bound team valid on a confirmed session's day;
    // null when the source has none for that day (as the importer treats it).
    async getTeamThresholds(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const parent = confirmed(sessionId);
      if (parent.day === null) throw unexpected("The confirmed session carries no day to read thresholds for.");
      let res;
      try {
        res = await read(`team/${team}/thresholds/?valid_on=${parent.day}`);
      } catch (error) {
        if (error.code === "source_not_found") return null;
        throw error;
      }
      const body = res.body;
      if (!isPlainObject(body)) throw unexpected("The source server did not answer the thresholds as an object.");
      if (body.team !== undefined && body.team !== null) {
        const named = namesBoundTeam(body.team, team);
        if (named === null) throw unexpected("The source server's thresholds name their team in an unknown way.");
        if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned thresholds of another team.");
      }
      return body;
    },

    async getUnits(options) { refuseTeamOptions(options); throw unavailable("units"); },

    // The bound team's session tags, as a map id → name. Every row must name
    // the bound team; a row of another team refuses the whole list. A name
    // is kept only when it is short plain text.
    async listSessionTags(options) {
      only(options, []);
      const { rows, total } = await wholeList(teamScopedPath("team_session_tag/", team, [["limit", SESSION_PAGE_LIMIT_MAX]]), (next) => nextPath(next, "team_session_tag/"), "the tag list");
      const tags = new Map();
      for (const row of rows) {
        const named = namesBoundTeam(row.team, team);
        if (named === null) throw unexpected("A tag of the source answer does not name its team in a known way.");
        if (named === false) throw new SourceAdapterError("source_team_mismatch", "The source server returned a tag of another team.");
        const name = typeof row.name === "string" ? row.name.trim() : "";
        tags.set(canonicalId(row.id), name !== "" && name.length <= 80 && !/[\r\n\t]/.test(name) ? name : null);
      }
      return { tags, total };
    },

    // The label of every drill of a confirmed parent: from the parent's
    // drillTags (the brief read) when the mapping is unambiguous and the tag
    // is a tag of the bound team, otherwise "Drill <index + 1>". Never from
    // other sessions of the day, never a guessed tag.
    async getDrillLabels(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const parent = confirmed(sessionId);
      const fallback = (index) => ({ drillIndex: index, label: `Drill ${index + 1}`, tagId: null, tagName: null, labelEvidence: "index_fallback" });
      if (parent.drillsCount < 1) return [];
      let mapping = null;
      try {
        const { body } = await readBrief(parent.id);
        if (isPlainObject(body) && (body.id === undefined || canonicalId(body.id) === parent.id)) mapping = parseDrillTags(body.drillTags, parent.drillsCount);
      } catch (error) {
        if (isGlobal(error)) throw error;
        mapping = null;
      }
      if (mapping === null || mapping.size === 0) return Array.from({ length: parent.drillsCount }, (_, i) => fallback(i));
      const { tags } = await adapter.listSessionTags();
      return Array.from({ length: parent.drillsCount }, (_, i) => {
        const tagId = mapping.get(i);
        if (tagId === undefined || !tags.has(tagId) || tags.get(tagId) === null) return fallback(i);
        return { drillIndex: i, label: tags.get(tagId), tagId, tagName: tags.get(tagId), labelEvidence: "drill_tags" };
      });
    },

    // Everything the importer's mapper reads for one parent session, in the
    // shape of the e03 bundle, plus the drills' completeness and labels. The
    // session is confirmed first; every other read hangs off it.
    async fetchSessionBundle(options) {
      const { sessionId } = only(options, ["sessionId"]);
      const teamSession = await adapter.getSession({ sessionId });
      const id = canonicalId(teamSession.id);
      const { rows } = await adapter.listAthleteSessions({ sessionId: id });
      const athleteSessions = [];
      const more = {};
      const tracks = {};
      for (const listed of rows) {
        const row = await adapter.getAthleteSession({ sessionId: id, athleteSessionId: canonicalId(listed.id) });
        athleteSessions.push(row);
        more[canonicalId(row.id)] = await adapter.getAthleteSessionMore({ athleteSessionId: canonicalId(row.id) });
        const trackId = row.track === undefined || row.track === null ? null : canonicalId(row.track);
        if (trackId !== null && !tracks[trackId]) tracks[trackId] = await adapter.getTrack({ trackId });
      }
      const full = await adapter.getSessionDetails({ sessionId: id });
      const drillSet = await adapter.getSessionDrills({ sessionId: id });
      const drills = Object.fromEntries(drillSet.drills.map((d) => [String(d.drillIndex), d.details]));
      const labels = await adapter.getDrillLabels({ sessionId: id });
      const teamThresholds = await adapter.getTeamThresholds({ sessionId: id });
      return {
        teamSession, teamThresholds, athleteSessions, more, tracks,
        details: { full, drills },
        drillsStatus: { complete: drillSet.complete, drillsCount: drillSet.drillsCount, failed: drillSet.failed },
        drillLabels: labels,
      };
    },
  };
  return Object.freeze(adapter);
}
