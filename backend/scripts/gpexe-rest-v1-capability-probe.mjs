// Owner-run, read-only probe of the server3 / rest_v1 capabilities the
// adapter does not implement yet (F3c2b; docs/ai/gpexe-rest-v1-compatibility.md
// section 4). It answers, for Team ID 980 only, which of the importer's
// reads rest_v1 has, in which form, and what shape they answer with.
//
// What it does: ONE credential exchange (the host's confirmed form, taken
// from the application's catalog), then GET requests only, at most
// MAX_REQUESTS in all. Every id it needs - the session, the athlete row,
// the track; in the drill-only run the parent - is taken from an answer it has already received
// and checked; nothing is typed in, nothing is guessed, and a chain stops the
// moment the previous answer gives no safe next id. Every row with a team
// must name 980; a row of another team stops the whole run.
//
// What it prints, and nothing else: per request the method, the masked
// path, the status, the body shape, the top-level field names, counts and
// a few header values from a fixed list; per capability a verdict and
// booleans. Never a name, a value, a result, an id, a token, an address or
// a part of a body. A final guard refuses to print a report that contains
// the credential, the issued token or any value from the environment.
//
// Boundaries, each one tested (backend/tests/gpexe-rest-v1-capability-probe.test.mjs):
// GET only after the one exchange; one host; the family and the URLs from the
// application's catalog, except the drill-only run's two fixed legacy reads
// under `api/` on the same host (LEGACY_API_PATH, owner order 2026-10-01); redirects never followed; a timeout per request;
// an answer larger than 5 MiB refused unread (the adapter's bounded reader);
// no retry; no database; nothing written anywhere.
import { pathToFileURL } from "node:url";
import { assertNoSecretInReport, describeResponse, discoveryProfile, DiscoveryUsageError, maskPath } from "./gpexe-auth-discovery.mjs";
import { readBounded, teamScopedPath } from "../src/gpexeRestV1Adapter.js";
import { redactGpexe } from "../src/gpexeClient.js";

export const PROBE_HOST = "server3";
export const PROBE_FAMILY = "rest_v1";
export const PROBE_TEAM = "980";
export const MAX_REQUESTS = 14; // 1 exchange + at most 13 reads
export const REQUEST_TIMEOUT_MS = 30_000;
export const LIST_LIMIT = 100;
// The exchange answer is one small object; more than this is not a token answer.
export const MAX_EXCHANGE_BYTES = 64 * 1024;
// The drill-only run only (owner order 2026-10-01, from the structure of the owner's legacy
// integration on server3): the legacy `api/` family of the same host, for exactly two read shapes
// on a parent the REST chain confirmed first. Not a host profile, not an adapter family.
export const LEGACY_API_PREFIX = "api/";
export const LEGACY_API_PATH = /^team_session\/(0|[1-9][0-9]{0,11})\/(details\/\?drill=[01])?$/;
// The two drill positions the legacy integration really reads (owner, 2026-10-01): zero-based.
export const DRILL_POSITIONS = Object.freeze([0, 1]);
// The control sequence (owner, 2026-10-01): position 0, position 1, then position 0 again, so a
// source that changes between reads cannot pass for a parameter that is applied.
export const DRILL_READ_SEQUENCE = Object.freeze([0, 1, 0]);
const ID = /^(0|[1-9][0-9]{0,11})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ProbeStop extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeStop";
    this.code = code;
  }
}

// An id is used only when it is a canonical id as a number or a string.
export function safeId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && ID.test(value)) return value;
  return null;
}

// The day of a timestamp, when the timestamp starts with one.
export function dayOf(value) {
  return typeof value === "string" && DAY.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
}

// The probe's own masking on top of the discovery script's: a date window
// value and every id that stands as a path segment, whatever its length.
export function maskProbePath(path, team) {
  // Ids that stand as path segments first, so an id that happens to contain the team's digits is
  // never split by the team masking below and left half printed.
  const segments = path
    .replace(/\/(\d+)(?=\/)/g, (m, d) => (d === team ? m : "/<id>"))
    .replace(/(teamsession=)(\d+)/g, (m, k, d) => (d === team ? m : `${k}<id>`));
  return maskPath(segments, team)
    .replace(/start_timestamp_(gte|lte)=[^&]*/g, "start_timestamp_$1=<date>")
    .replace(/\/\d+\//g, "/<id>/")
    .replace(/(teamsession=)\d+/g, "$1<id>")
    .replace(/limit=<id>/g, "limit=<n>");
}

// A count header is a count only when it is present and a whole number;
// "absent" is never 0.
export function parseTotal(header) {
  if (header === null || header === undefined || header === "") return null;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Does a value name the probe team? null = an unknown shape.
function namesTeam(value, team) {
  const id = safeId(value);
  return id === null ? null : id === team;
}

// Two answers compared whole, in memory: same canonical JSON. Nothing of
// either answer leaves this function.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const fieldNamesOf = (v) => (Array.isArray(v) ? (v[0] && typeof v[0] === "object" ? Object.keys(v[0]).sort() : []) : v && typeof v === "object" ? Object.keys(v).sort() : []);
const rowCount = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" && Array.isArray(v.results) ? v.results.length : null);

// Field names are printed only when each is an identifier (a letter or an underscore first, no
// space, at most 64 characters) and there are at most 200: keys that start with a digit (ids),
// dates and keys with spaces are never printed. A single-word key is printed.
export const printableFieldNames = (names) => names.length <= 200 && names.every((k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k));
// Every list of key names the shared describer prints goes through that rule.
export function sanitizeDescribed(described) {
  for (const key of ["fieldNames", "resultFieldNames"]) {
    if (Array.isArray(described[key]) && !printableFieldNames(described[key])) described[key] = "<unprintable>";
  }
  return described;
}

// An answer that was seen: a parsed object or array. A 200 with an empty or
// unreadable body, or a JSON primitive, is no answer and can never make a verdict.
export const parsedAnswer = (b) => b !== null && b !== undefined && typeof b === "object";
// An answer with content: parsed and carrying at least one row or one field name. An empty
// array or object was seen but shows nothing, so it can never make a verdict either.
export const answerWithContent = (b) => parsedAnswer(b) && ((rowCount(b) ?? 0) > 0 || fieldNamesOf(b).length > 0);

// What the list page already says about its `drills` entries, as types and booleans only.
// No entry is ever used as an id for a request.
export function describeDrillEntries(rows, parentRow) {
  const entries = rows.flatMap((r) => (Array.isArray(r.drills) ? r.drills : []));
  const kinds = new Set(entries.map((d) => (d === null ? "null" : Array.isArray(d) ? "array" : typeof d)));
  const drillsEntryKind = kinds.size === 0 ? null : kinds.size === 1 ? [...kinds][0] : "mixed";
  const firstDrill = parentRow && Array.isArray(parentRow.drills) ? safeId(parentRow.drills[0]) : null;
  // Another row of the same page (never the parent itself) with the id the first entry names.
  const listRowMatchesFirstDrill = firstDrill === null ? null : rows.some((r) => r !== parentRow && safeId(r.id) === firstDrill);
  // The singular `drill` field of the list rows (distinct from `drills`, the list).
  const rowsHaveSingularDrillField = rows.some((r) => "drill" in r);
  const rowsWithNonNullSingularDrill = rowsHaveSingularDrillField ? rows.some((r) => r.drill !== null && r.drill !== undefined) : null;
  return { drillsEntryKind, listRowMatchesFirstDrill, rowsHaveSingularDrillField, rowsWithNonNullSingularDrill };
}

// What the legacy drill answer shows (owner, 2026-10-01): its shape and whether it carries
// player rows and metric fields, as booleans only. Nothing of a row, and no key of the players
// map (those keys are athlete ids), leaves this function. The importer's known `api` details shape
// is `players` as a map keyed by the GPEXE athlete id (gpexeImportMapper.js); a list of rows, at
// the top level or under `players`, is recognised too.
export function describeDrillAnswer(body) {
  const object = parsedAnswer(body) && !Array.isArray(body);
  const container = object ? body.players : undefined;
  const playersContainerKind = Array.isArray(container) ? "array" : parsedAnswer(container) ? "map" : container === undefined ? null : "other";
  const players = Array.isArray(body) ? body : playersContainerKind === "array" ? container : playersContainerKind === "map" ? Object.values(container) : null;
  const rows = players ? players.filter((r) => r && typeof r === "object" && !Array.isArray(r)) : [];
  const metricKey = (o) => Object.keys(o).some((k) => /metric/i.test(k));
  return {
    bodyKind: body === undefined ? null : body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
    hasContent: answerWithContent(body),
    rowsAtTopLevel: Array.isArray(body),
    playersField: object ? "players" in body : false,
    playersContainerKind,
    playerRowsPresent: rows.length > 0,
    playerRowsAreObjects: players && players.length > 0 ? rows.length === players.length : null,
    playerRowsHaveNumbers: rows.length > 0 ? rows.some((r) => Object.values(r).some((v) => typeof v === "number" && Number.isFinite(v))) : null,
    playerRowsHaveNestedValues: rows.length > 0 ? rows.some((r) => Object.values(r).some((v) => v !== null && typeof v === "object")) : null,
    metricFieldPresent: (object && metricKey(body)) || rows.some(metricKey),
  };
}

// The shape of a drill answer's top-level `team`, as a kind word and booleans only (owner,
// 2026-10-02): diagnostics for the report, never a rule. The acceptance rule stays `namesTeam`
// (a canonical id as a number or a string); every other shape still stops the run as
// `team_unknown_shape`, even an object whose `id` is the bound team. No value, key, URL or name
// of the field leaves this function.
export const TEAM_VALUE_KINDS = Object.freeze(["absent", "null", "number", "string", "object", "array", "other"]);
export function describeTeamValue(body, team) {
  if (!parsedAnswer(body) || Array.isArray(body) || !("team" in body)) return { teamValueKind: "absent" };
  const v = body.team;
  const teamValueKind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? "number" : typeof v === "string" ? "string" : typeof v === "object" ? "object" : "other";
  const out = { teamValueKind };
  if (teamValueKind === "object") {
    const teamObjectHasId = Object.prototype.hasOwnProperty.call(v, "id");
    const id = teamObjectHasId ? safeId(v.id) : null;
    out.teamObjectHasId = teamObjectHasId;
    out.teamObjectIdCanonical = teamObjectHasId && id !== null;
    out.teamObjectIdMatchesBoundTeam = id === null ? null : id === team;
  }
  return out;
}

// The link a drill answer may have to the list already received (owner, 2026-10-02):
// diagnostics only, never a rule. For the position read, the parent's `drills[position]` is the
// expected drill; the answer's `teamsession` is compared with it, and that entry is looked up
// among the list rows already received. Four booleans, nothing else: no id, value, name or key.
export function describeDrillLink(body, parentRow, position, rows, team) {
  const expected = parentRow && Array.isArray(parentRow.drills) ? safeId(parentRow.drills[position]) : null;
  const ts = parsedAnswer(body) && !Array.isArray(body) ? safeId(body.teamsession) : null;
  const matching = expected === null ? [] : rows.filter((r) => r && typeof r === "object" && safeId(r.id) === expected);
  return {
    teamsessionCanonical: ts !== null,
    teamsessionMatchesExpectedDrill: ts !== null && expected !== null && ts === expected,
    expectedDrillHasUniqueListRow: matching.length === 1,
    expectedDrillListRowTeamIs980: matching.length === 1 && namesTeam(matching[0].team, team) === true,
  };
}

export const PROBE_MODES = Object.freeze(["full", "drill"]);
// The drill-only run: one exchange and these six reads, nothing else.
export const DRILL_MODE_MAX_REQUESTS = 7;

export function parseArgs(argv) {
  const opts = { host: PROBE_HOST, team: PROBE_TEAM, mode: "full" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--host", "--team", "--mode"].includes(key) || value === undefined) throw new DiscoveryUsageError(`unknown or incomplete argument ${key}`);
    opts[key.slice(2)] = value;
  }
  if (!PROBE_MODES.includes(opts.mode)) throw new DiscoveryUsageError("--mode must be full or drill");
  // This probe is for the one confirmed host and the one bound team: the
  // options exist so that a wrong value is refused loudly, not so that
  // another target can be chosen.
  if (opts.host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (opts.team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  return opts;
}

// maxRequests and timeoutMs exist for the tests; the defaults are the limits.
export async function runCapabilityProbe({ host = PROBE_HOST, team = PROBE_TEAM, mode = "full", maxRequests = MAX_REQUESTS, timeoutMs = REQUEST_TIMEOUT_MS } = {}, env, fetchImpl = globalThis.fetch) {
  if (!PROBE_MODES.includes(mode)) throw new DiscoveryUsageError("mode must be full or drill");
  // The drill-only run never sends more than its own six reads.
  if (mode === "drill") maxRequests = Math.min(maxRequests, DRILL_MODE_MAX_REQUESTS);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS) throw new DiscoveryUsageError(`maxRequests is a whole number from 1 to ${MAX_REQUESTS}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new DiscoveryUsageError(`timeoutMs is a whole number up to ${REQUEST_TIMEOUT_MS}`);
  const profile = discoveryProfile(host, PROBE_FAMILY);
  if (!profile.exchange) throw new DiscoveryUsageError(`host ${host} has no confirmed credential exchange`);
  const username = env.GPEXE_USERNAME;
  const password = env.GPEXE_PASSWORD;
  if (!username || !password) throw new DiscoveryUsageError("GPEXE_USERNAME and GPEXE_PASSWORD are not both set in this terminal");
  const api = profile.apiPrefix;
  const report = {
    source: "gpexe", hostKey: host, apiFamily: profile.apiFamily, teamId: team, mode, ranAt: new Date().toISOString(),
    requests: [], capabilities: {}, stoppedBy: null,
  };
  let requests = 0;
  const countRequest = () => {
    requests += 1;
    if (requests > maxRequests) throw new ProbeStop("request_limit", `more than ${maxRequests} requests would be needed`);
  };
  const verdict = (name, value) => { report.capabilities[name] = value; };
  // The one exit: the drill-only run always names its drill verdict, whatever stopped it.
  const done = () => {
    if (mode === "drill" && report.stoppedBy && !report.capabilities.session_drill_details) verdict("session_drill_details", { verdict: "not_observed", reason: report.stoppedBy });
    return finish(report, env, issued ?? null);
  };

  // 1. The one exchange, in the host's confirmed form, with the same timeout
  //    and a bounded answer like every read. The issued token lives in this
  //    closure and nowhere else.
  countRequest();
  const issued = await (async () => {
    const url = new URL(profile.exchange.path, profile.baseUrl);
    if (!url.href.startsWith(profile.baseUrl)) throw new DiscoveryUsageError("the exchange path left the host");
    const entry = { method: "POST", path: maskProbePath(profile.exchange.path, team), authenticated: false, bodyEncoding: profile.exchange.encoding };
    const form = profile.exchange.encoding === "form";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.href, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams({ username, password }).toString() : JSON.stringify({ username, password }),
      });
      if (res.status >= 300 && res.status < 400) {
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return null;
      }
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      let body;
      try {
        const text = await readBounded(res, header("content-length"), MAX_EXCHANGE_BYTES);
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        report.requests.push({ ...entry, status: res.status, error: "answer_too_large_or_unreadable" });
        return null;
      }
      report.requests.push({ ...entry, ...sanitizeDescribed(describeResponse(res, body, { teamId: team })) });
      const field = profile.exchange.tokenField;
      return res.status === 200 && body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, field) && typeof body[field] === "string" && body[field] ? body[field] : null;
    } catch (e) {
      report.requests.push({ ...entry, error: e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name || "error") });
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (!issued) {
    report.stoppedBy = "exchange_failed";
    return done();
  }

  // The ONLY read: GET, one relative resource path under a prefix of the same
  // host, bounded body, no retry, redirects refused.
  const get = (resourcePath) => read(api, resourcePath);
  // The drill-only run's two legacy reads, and nothing else under `api/`.
  const getLegacy = (resourcePath) => {
    if (mode !== "drill" || !LEGACY_API_PATH.test(resourcePath)) throw new ProbeStop("path_refused", "not one of the two legacy reads of the drill-only run");
    return read(LEGACY_API_PREFIX, resourcePath);
  };
  async function read(prefix, resourcePath) {
    countRequest();
    const url = new URL(`${prefix}${resourcePath}`, profile.baseUrl);
    if (!url.href.startsWith(`${profile.baseUrl}${prefix}`)) throw new ProbeStop("path_refused", "a path left its prefix");
    const entry = { method: "GET", path: maskProbePath(`${prefix}${resourcePath}`, team), authenticated: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url.href, { method: "GET", headers: { Authorization: `${profile.authScheme} ${issued}`, Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      } catch (e) {
        const error = e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name || "error");
        report.requests.push({ ...entry, error });
        return { status: null, body: undefined, error, ...entry };
      }
      if (res.status >= 300 && res.status < 400) {
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return { status: res.status, body: undefined, redirected: true };
      }
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      let body;
      try {
        const text = await readBounded(res, header("content-length"));
        body = text === "" ? undefined : redactGpexe(JSON.parse(text));
      } catch (e) {
        const error = e?.code === "source_answer_unexpected" ? "answer_too_large_or_unreadable" : "answer_unreadable";
        report.requests.push({ ...entry, status: res.status, error });
        return { status: res.status, body: undefined, error };
      }
      // Key names are printed only when every one is an identifier: a body keyed by ids or dates,
      // at the top level or under `results`, prints none of its keys.
      const described = sanitizeDescribed(describeResponse(res, body, { teamId: team }));
      // A count is printed only when it is a count.
      if (described.totalCount !== null && !/^\d{1,9}$/.test(described.totalCount)) described.totalCount = "<unprintable>";
      report.requests.push({ ...entry, ...described });
      return { status: res.status, body, totalCount: header("x-total-count") };
    } finally {
      clearTimeout(timer);
    }
  }

  // Every row with a `team` names 980 as a canonical id, or the whole run
  // stops here: another team, and also a team in a shape this probe cannot
  // read (an object, a URL, a list), because an unreadable team is not a
  // confirmed team.
  function assertTeam(rows, what) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (!("team" in row)) continue;
      const named = namesTeam(row.team, team);
      if (named === false) throw new ProbeStop("team_isolation_failed", `${what}: a row of another team was returned`);
      if (named === null) throw new ProbeStop("team_unknown_shape", `${what}: a row names its team in an unknown shape`);
    }
  }

  try {
    // 2. The unfiltered session list of this run (one page).
    const list = await get(teamScopedPath("team_session/", team, [["limit", LIST_LIMIT]]));
    const rows = Array.isArray(list.body) ? list.body.filter((r) => r && typeof r === "object") : [];
    if (list.status !== 200 || !Array.isArray(list.body)) {
      report.stoppedBy = "session_list_unavailable";
      verdict("session_list", { verdict: "not_observed", status: list.status });
      return done();
    }
    assertTeam(rows, "session list");
    const unfilteredTotal = parseTotal(list.totalCount);
    const haveDrillsField = rows.some((r) => "drills" in r);
    const named = new Set(rows.flatMap((r) => (Array.isArray(r.drills) ? r.drills.map((d) => safeId(d)).filter(Boolean) : [])));
    const firstParent = rows.find((r) => Array.isArray(r.drills) && r.drills.length > 0 && safeId(r.drills[0]) !== null && safeId(r.id) !== null);
    const firstUnnamed = rows.find((r) => safeId(r.id) !== null && !named.has(safeId(r.id)));
    // The drill-only run's parent: a row of team 980 with a readable id and an explicit `drills`
    // list of at least two entries (owner, 2026-10-01), so the reads at positions 0 and 1 both
    // name a drill. `drills_count` alone never chooses a parent: it is not proven that a drill row
    // cannot carry a positive count. The count is checked only on the chosen parent's own REST
    // read. Its `drills` entries are never ids.
    const drillParent = rows.find((r) => safeId(r.id) !== null && namesTeam(r.team, team) === true
      && Array.isArray(r.drills) && r.drills.length >= DRILL_POSITIONS.length);
    const chosen = firstParent ?? firstUnnamed ?? null;
    const sessionId = chosen ? safeId(chosen.id) : null;
    const days = new Set(rows.map((r) => dayOf(r.start_timestamp)).filter(Boolean));
    verdict("session_list", {
      verdict: "proven", status: 200, rowCount: rows.length, totalIsNumber: unfilteredTotal !== null,
      rowsHaveDrillsField: haveDrillsField, parentChosen: Boolean(firstParent), parentUnconfirmed: !firstParent && Boolean(firstUnnamed), sessionIdDerived: sessionId !== null, distinctDays: days.size,
      // The drill-only run's helper facts from the page already received (owner order
      // 2026-10-01): types and booleans only; the full run's report keeps its shape.
      ...(mode === "drill" ? describeDrillEntries(rows, drillParent ?? null) : {}),
    });
    if (sessionId === null) {
      report.stoppedBy = "no_safe_session_id";
      return done();
    }

    // The drill-only run (owner order 2026-10-01). A `drills` entry is not a
    // team_session id on server3 (first drill-only run), and the owner's legacy
    // integration reads a drill as `api/team_session/<parent>/details/?drill=<index>`
    // with a zero-based index. So: the parent is confirmed by the REST chain,
    // then again by the legacy family, and only then are the drill reads sent
    // in the control sequence 0 -> 1 -> 0. Every identity is confirmed before the next read, and the chain
    // stops without a further request at the first identity or team that is
    // not confirmed. No `drills` entry is ever used as an id.
    if (mode === "drill") {
      if (!drillParent) {
        report.stoppedBy = "no_parent_with_drills_in_list";
        return done();
      }
      const parentId = safeId(drillParent.id);
      const stopDrill = (code) => { report.stoppedBy = code; return done(); };
      // 2. The parent's own REST read: the same id, team 980, drills_count >= 2.
      const parent = await get(`team_session/${parentId}/`);
      const pb = parent.body;
      const parentOk = Boolean(parent.status === 200 && pb && typeof pb === "object" && !Array.isArray(pb));
      if (parentOk) assertTeam([pb], "parent session");
      const parentIdOk = parentOk && safeId(pb.id) === parentId;
      const parentTeamOk = parentOk && namesTeam(pb.team, team) === true;
      const parentCount = parentOk && Number.isInteger(pb.drills_count) ? pb.drills_count : null;
      const parentStart = parentOk && dayOf(pb.start_timestamp) !== null;
      const parentConfirmed = parentIdOk && parentTeamOk && parentCount !== null && parentCount >= DRILL_POSITIONS.length;
      verdict("session_read", {
        // The verdict word keeps the full run's meaning (what the importer reads is present);
        // the gate of this run is `parentConfirmed`, printed beside it.
        verdict: parentTeamOk && parentCount !== null && parentStart ? "same" : "not_observed", status: parent.status ?? null, idMatchesList: parentIdOk, teamIs980: parentTeamOk,
        drillsCountPresent: parentCount !== null, drillsCountPositive: parentCount !== null && parentCount > 0, drillsCountAtLeastTwo: parentCount !== null && parentCount >= DRILL_POSITIONS.length,
        startTimestampPresent: parentStart, drillsListPresent: parentOk && Array.isArray(pb.drills), parentConfirmed,
      });
      if (!parentConfirmed) return stopDrill(parentOk && safeId(pb.id) !== null && !parentIdOk ? "parent_id_mismatch" : "parent_not_confirmed");
      // 3. The same parent through the legacy family: the same id and team 980 again.
      const legacy = await getLegacy(`team_session/${parentId}/`);
      const lb = legacy.body;
      const legacyOk = Boolean(legacy.status === 200 && lb && typeof lb === "object" && !Array.isArray(lb));
      if (legacyOk) assertTeam([lb], "legacy parent session");
      const legacyIdOk = legacyOk && safeId(lb.id) === parentId;
      const legacyTeamOk = legacyOk && namesTeam(lb.team, team) === true;
      const legacyConfirmed = legacyIdOk && legacyTeamOk;
      verdict("legacy_api_session_read", {
        // Not an adapter read: the legacy family is not part of the server3 profile.
        verdict: legacyConfirmed ? "observed" : "not_observed", family: "api", status: legacy.status ?? null, idMatchesParent: legacyIdOk, teamIs980: legacyTeamOk,
        drillsCountPositive: legacyOk && Number.isInteger(lb.drills_count) ? lb.drills_count > 0 : null, parentConfirmed: legacyConfirmed,
      });
      if (!legacyConfirmed) return stopDrill(legacyOk && safeId(lb.id) !== null && !legacyIdOk ? "legacy_parent_id_mismatch" : "legacy_parent_not_confirmed");
      // 4. The drill reads the legacy integration really sends, in the control sequence
      //    0 -> 1 -> 0 on the confirmed parent. Each answer, the repeated one included, must name
      //    team 980 and the parent at its top level and carry a non-empty `players` before the
      //    next read; then only the `players` contents are compared, in memory.
      const answers = [];
      const players = [];
      const labels = ["drill0", "drill1", "drill0Repeat"];
      for (const position of DRILL_READ_SEQUENCE) {
        const read = await getLegacy(`team_session/${parentId}/details/?drill=${position}`);
        const b = read.body;
        const object = read.status === 200 && parsedAnswer(b) && !Array.isArray(b);
        // The team rule is unchanged: a canonical id as a number or a string, or a stop. The
        // shape of the field is described first, as a kind word and booleans, so a stop on an
        // unreadable shape still says what kind of shape it was.
        const teamNamed = object && "team" in b ? namesTeam(b.team, team) : null;
        const teamIs980 = teamNamed === true;
        const named = object ? safeId(b.teamsession) : null;
        const namesParent = named === null ? null : named === parentId;
        const answerPlayers = object && answerWithContent(b.players) ? b.players : null;
        answers.push({
          status: read.status ?? null, teamIs980, namesParent, playersPresent: answerPlayers !== null,
          ...describeTeamValue(b, team), ...describeDrillLink(b, drillParent, position, rows, team), ...describeDrillAnswer(b),
        });
        players.push(answerPlayers);
        if (object && "team" in b && teamNamed !== true) {
          const code = teamNamed === false ? "team_isolation_failed" : "team_unknown_shape";
          verdict("session_drill_details", { verdict: "not_observed", family: "api", reason: code, readsMade: answers.length, ...Object.fromEntries(answers.map((a, i) => [labels[i], a])) });
          assertTeam([b], `drill ${position} answer`); // throws the stop; nothing further is read
        }
        const reason = read.status !== 200 ? "drill_not_200"
          : !parsedAnswer(b) ? "drill_answer_unreadable"
          : !answerWithContent(b) ? "drill_answer_empty"
          : namesParent === false ? "drill_parent_mismatch"
          : !teamIs980 || namesParent !== true ? "drill_answer_identity_unconfirmed"
          : answerPlayers === null ? "drill_players_missing"
          : null;
        if (reason) {
          verdict("session_drill_details", { verdict: "not_observed", family: "api", reason, readsMade: answers.length, ...Object.fromEntries(answers.map((a, i) => [labels[i], a])) });
          return stopDrill(reason);
        }
      }
      // 5. Only `players` is compared, whole, in memory; nothing of it is printed. The repeated
      //    position 0 must equal the first one, and position 1 must differ from it.
      const [first, second, repeat] = players.map(canonical);
      const repeatStable = first === repeat;
      const parameterApplied = repeatStable ? first !== second : null;
      const reason = !repeatStable ? "source_changed_during_probe" : !parameterApplied ? "parameter_effect_not_distinguishable" : null;
      verdict("session_drill_details", {
        verdict: reason ? "not_observed" : "same", family: "api", readsMade: answers.length, repeatStable, parameterApplied,
        ...(reason ? { reason } : {}), drill0: answers[0], drill1: answers[1], drill0Repeat: answers[2],
      });
      return done();
    }

    // The list's day is a hint only; the day that is used comes from the
    // session's own confirmed read below.
    const listDay = dayOf(chosen.start_timestamp);

    // 3. The session itself: the parent is confirmed here or not at all.
    const session = await get(`team_session/${sessionId}/`);
    const sb = session.body;
    const sessionOk = session.status === 200 && sb && typeof sb === "object" && !Array.isArray(sb);
    if (sessionOk) assertTeam([sb], "session");
    const sessionTeamOk = sessionOk && namesTeam(sb.team, team) === true;
    const drillsCount = sessionOk && Number.isInteger(sb.drills_count) ? sb.drills_count : null;
    const drillIds = sessionOk && Array.isArray(sb.drills) ? sb.drills.map(safeId) : null;
    const startPresent = sessionOk && dayOf(sb.start_timestamp) !== null;
    // The confirmed day: from the session's own read, and only when that read confirmed team 980.
    const day = sessionTeamOk ? dayOf(sb.start_timestamp) : null;
    const dayChangedSinceList = day !== null && listDay !== null && day !== listDay;
    const parentConfirmed = sessionTeamOk && drillsCount !== null && drillsCount > 0 && Array.isArray(drillIds) && drillIds.length > 0 && drillIds[0] !== null;
    // "same" as the importer's session read: team 980, drills_count and a start timestamp present.
    verdict("session_read", {
      verdict: sessionTeamOk && drillsCount !== null && startPresent ? "same" : "not_observed", status: session.status ?? null, teamIs980: sessionTeamOk || false,
      drillsCountPresent: drillsCount !== null, startTimestampPresent: startPresent || false, drillsListPresent: Array.isArray(drillIds), parentConfirmed,
    });

    // 4. Whole-session details, only for a session whose own read confirmed team 980.
    let whole = { status: null, body: undefined };
    if (sessionTeamOk) {
      whole = await get(`team_session/${sessionId}/details/`);
      verdict("session_details", { verdict: whole.status === 200 ? "same" : "not_observed", status: whole.status ?? null });
    } else {
      verdict("session_details", { verdict: "not_observed", reason: "session_not_confirmed" });
    }

    // 5. No drill read in the full run (owner, 2026-10-01): a `drills` entry is not a
    //    team_session id on server3, and the REST `?drill=` form is withdrawn; the drill
    //    is read only by the drill-only run, through the legacy form on a parent confirmed twice.
    verdict("session_drill_details", { verdict: "not_observed", reason: "drill_read_only_in_drill_mode" });

    // 6. The date window, judged only on a day the unfiltered list can judge.
    if (!sessionTeamOk) {
      verdict("session_list_by_date", { verdict: "not_observed", reason: "session_not_confirmed" });
    } else if (dayChangedSinceList) {
      // The list and the detail disagree about the day: the source changed
      // under the run, and no window is judged on a day that moved.
      verdict("session_list_by_date", { verdict: "not_observed", reason: "source_changed_between_list_and_detail" });
    } else if (day && days.size > 1 && unfilteredTotal !== null) {
      const window = `start_timestamp_gte=${encodeURIComponent(`${day} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${day} 23:59:59`)}`;
      const filtered = await get(`team_session/?team=${team}&${window}&limit=${LIST_LIMIT}`);
      const frows = Array.isArray(filtered.body) ? filtered.body.filter((r) => r && typeof r === "object") : null;
      if (frows) assertTeam(frows, "filtered session list");
      const total = parseTotal(filtered.totalCount);
      const allInside = frows ? frows.every((r) => dayOf(r.start_timestamp) === day) : false;
      const allTeam = frows ? frows.every((r) => namesTeam(r.team, team) === true) : false;
      const chosenAmong = frows ? frows.some((r) => safeId(r.id) === sessionId) : false;
      const smaller = total !== null && total < unfilteredTotal;
      verdict("session_list_by_date", {
        verdict: filtered.status === 200 && frows && allTeam && allInside && chosenAmong && smaller ? "same" : "not_observed",
        status: filtered.status ?? null, allRowsTeam980: allTeam, allRowsInsideWindow: allInside, chosenSessionAmong: chosenAmong,
        filteredCountSmallerThanUnfiltered: smaller, filteredTotalIsNumber: total !== null, rowCount: frows ? frows.length : null,
      });
    } else {
      verdict("session_list_by_date", { verdict: "not_observed", reason: !day ? "no_confirmed_day" : days.size <= 1 ? "list_has_one_day" : "no_unfiltered_total" });
    }

    // 7. Athlete rows of the confirmed session, then one row, its /more/ and its track.
    let athleteId = null;
    let trackId = null;
    if (sessionTeamOk) {
      const athletes = await get(`athlete_session/?teamsession=${sessionId}&limit=${LIST_LIMIT}`);
      const arows = Array.isArray(athletes.body) ? athletes.body.filter((r) => r && typeof r === "object") : null;
      // Three outcomes per row: it names this session, it names ANOTHER
      // session (the run stops), or it names no session in a readable way
      // (the rows are not used; nothing further is read from them).
      const foreign = arows ? arows.some((r) => "teamsession" in r && safeId(r.teamsession) !== null && safeId(r.teamsession) !== sessionId) : false;
      if (foreign) throw new ProbeStop("team_isolation_failed", "athlete rows of another session were returned");
      const allOfSession = Boolean(arows && arows.length > 0 && arows.every((r) => safeId(r.teamsession) === sessionId));
      const first = allOfSession ? arows.find((r) => safeId(r.id) !== null) : null;
      athleteId = first ? safeId(first.id) : null;
      // The list row's `track` is NOT used: the track id comes only from the
      // row's own confirmed detail below.
      verdict("athlete_session_list", {
        verdict: athletes.status === 200 && arows && (arows.length === 0 || allOfSession) ? "same" : "not_observed", status: athletes.status ?? null, rowCount: arows ? arows.length : null,
        ...(arows && arows.length > 0 && !allOfSession ? { reason: "rows_do_not_name_session" } : {}),
        allRowsOfSession: allOfSession, athleteIdDerived: athleteId !== null, listRowHasTrackField: Boolean(first && "track" in first),
      });
    } else {
      verdict("athlete_session_list", { verdict: "not_observed", reason: "session_not_confirmed" });
    }
    if (athleteId !== null) {
      // The row's own detail must answer 200 and name the same canonical
      // session before anything that depends on it is read. Another session
      // stops the run; a missing or unreadable session, or a failed detail,
      // ends this chain with not_observed and no further request.
      const one = await get(`athlete_session/${athleteId}/`);
      const ob = one.body;
      const detailOk = Boolean(one.status === 200 && ob && typeof ob === "object" && !Array.isArray(ob));
      const detailSession = detailOk && "teamsession" in ob ? safeId(ob.teamsession) : null;
      if (detailSession !== null && detailSession !== sessionId) throw new ProbeStop("team_isolation_failed", "an athlete row's detail names another session");
      const oneOk = Boolean(detailOk && detailSession === sessionId);
      trackId = oneOk && "track" in ob ? safeId(ob.track) : null;
      verdict("athlete_session_read", {
        verdict: oneOk ? "same" : "not_observed", status: one.status ?? null, rowOfSession: oneOk,
        ...(detailOk && !oneOk ? { reason: "detail_does_not_name_session" } : {}), trackIdDerived: trackId !== null,
      });
      if (oneOk) {
        const more = await get(`athlete_session/${athleteId}/more/`);
        verdict("athlete_session_more", { verdict: more.status === 200 ? "same" : "not_observed", status: more.status ?? null });
      } else {
        verdict("athlete_session_more", { verdict: "not_observed", reason: "detail_not_confirmed" });
      }
    } else {
      verdict("athlete_session_read", { verdict: "not_observed", reason: "no_safe_athlete_id" });
      verdict("athlete_session_more", { verdict: "not_observed", reason: "no_safe_athlete_id" });
    }
    if (trackId !== null) {
      const track = await get(`track/${trackId}/`);
      const tb = track.body;
      verdict("track_read", { verdict: track.status === 200 ? "same" : "not_observed", status: track.status ?? null, hasTimezoneField: Boolean(tb && typeof tb === "object" && "timezone" in tb) });
    } else {
      verdict("track_read", { verdict: "not_observed", reason: "no_safe_track_id" });
    }

    // 8. Thresholds valid on the CONFIRMED day of the session's own read, and the tags list.
    if (day) {
      const thresholds = await get(`team/${team}/thresholds/?valid_on=${day}`);
      verdict("team_thresholds", { verdict: thresholds.status === 200 ? "same" : "not_observed", status: thresholds.status ?? null });
    } else {
      verdict("team_thresholds", { verdict: "not_observed", reason: sessionTeamOk ? "no_confirmed_day" : "session_not_confirmed" });
    }
    // Tags, asked for team 980 like every other list (whether the endpoint
    // honours the parameter is part of what is observed); a row of another
    // team stops the run like anywhere else.
    const tags = await get(teamScopedPath("team_session_tag/", team, [["limit", 5]]));
    const trows = Array.isArray(tags.body) ? tags.body : Array.isArray(tags.body?.results) ? tags.body.results : null;
    if (trows) assertTeam(trows.filter((r) => r && typeof r === "object"), "tag list");
    verdict("session_tags", { verdict: tags.status === 200 ? "observed" : "not_observed", status: tags.status ?? null, rowsNameATeam: trows ? trows.some((r) => r && typeof r === "object" && "team" in r) : null });
    verdict("units", { verdict: "not_observed", reason: "no endpoint; meanings are compared on a disposable database later" });
  } catch (error) {
    if (error instanceof ProbeStop) {
      report.stoppedBy = error.code;
    } else {
      report.stoppedBy = "unexpected_error";
    }
  }
  return done();
}

function finish(report, env, issued) {
  report.requestCount = report.requests.length;
  const text = assertNoSecretInReport(report, env);
  if (issued && text.includes(issued)) {
    const error = new Error("refusing to print: the report would contain the issued token");
    error.code = "secret_in_report";
    throw error;
  }
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runCapabilityProbe(opts, process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.name || "Error"}${e instanceof DiscoveryUsageError ? `: ${e.message}` : e?.code ? ` (${e.code})` : ""}\n`);
    process.exit(1);
  });
}
