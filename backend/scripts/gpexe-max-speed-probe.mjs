#!/usr/bin/env node
// Owner-run, read-only: can the grouped details' `max_values_speed` replace each athlete row's own
// `max_v` (owner order 2026-10-24, the last check of the GPEXE request reduction)?
//
// It reads exactly what a check reads, for one parent session of Team ID 980 with at least two drills:
// the parent, its athlete list, the whole-session details (rest/v1), the details of drills 0 and 1 in
// the api/ form a check sends, and the own read of every row of up to three athletes at those three
// levels. Then, in memory only, it compares each row's `max_v` with the same athlete's
// `max_values_speed` at the same level: the same number, or exactly 3.6 times it (km/h), and nothing
// rounded counts. It also counts, over the whole athlete list, which valid rows the details cover.
//
// 1 exchange + at most 15 GET (cap 16), a 2 s pause before every read, no repeat, redirects refused,
// the first 429 ends the run, a refused credential (401, 403) too. The report holds only closed words,
// counts and booleans: no id, name, date, value or credential (the final guard refuses them).
import { pathToFileURL } from "node:url";
import { assertNoSecretInReport, describeResponse, discoveryProfile, DiscoveryUsageError } from "./gpexe-auth-discovery.mjs";
import { readBounded, teamScopedPath } from "../src/gpexeRestV1Adapter.js";
import { redactGpexe } from "../src/gpexeClient.js";
import { LIST_LIMIT, MAX_EXCHANGE_BYTES, maskProbePath, PROBE_HOST, PROBE_TEAM, REQUEST_TIMEOUT_MS, safeId } from "./gpexe-rest-v1-capability-probe.mjs";
import { detailsValue, LEGACY_API_PREFIX, PRINTABLE_KEYS, retryAfterOf, scalarRelation } from "./gpexe-details-coverage-probe.mjs";

// 1 exchange + list, parent, athlete list, whole details, 2 drill details, 3 athletes x 3 rows = 16.
export const MAX_SPEED_MAX_REQUESTS = 16;
export const MAX_SPEED_PAUSE_MS = 2_000;
export const MAX_SPEED_ATHLETES = 3;
export const MAX_SPEED_MIN_ATHLETES = 2;
export const MAX_SPEED_DRILLS = Object.freeze([0, 1]);
export const MAX_SPEED_LEVELS = Object.freeze(["whole", "drill0", "drill1"]);
export const DETAILS_MAX_SPEED = "max_values_speed";
// The drill reads a check sends (gpexeRestV1Adapter.js legacyDrillDetailsUrl), for drills 0 and 1 only.
export const MAX_SPEED_DRILL_PATH = /^team_session\/(0|[1-9][0-9]{0,11})\/details\/\?drill=[01]$/;
// A relation that keeps the importer's value exactly: the same m/s number, or the km/h number it computes.
export const EXACT_RELATIONS = Object.freeze({ equal: "m/s", times_3_6: "km/h" });
const AUTH_SCHEMES = Object.freeze(["Token", "Bearer", "Basic", "Digest"]);

class ProbeStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// The importer's own number rule (gpexeImportMapper.js finiteNumber).
const finite = (raw) => {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// A details unit as printable text: letters and unit signs only, at most 12 characters, else "<other>".
export function unitTextOf(player, key = DETAILS_MAX_SPEED) {
  const v = isPlainObject(player) ? player[key] : undefined;
  if (!isPlainObject(v) || !Object.prototype.hasOwnProperty.call(v, "unit")) return null;
  return typeof v.unit === "string" && /^[A-Za-z%/²³ .-]{1,12}$/.test(v.unit) ? v.unit : "<other>";
}

// When a value is not exactly related: does it equal the row's value rounded to 1 or 2 decimals in
// km/h, or to 1, 2 or 3 decimals in m/s? Booleans only; none of them makes a pair equal.
export function roundingOf(rowMps, detailsNumber) {
  if (rowMps === null || detailsNumber === null) return null;
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  const eq = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return {
    kmhRounded1: eq(round(rowMps * 3.6, 1), detailsNumber), kmhRounded2: eq(round(rowMps * 3.6, 2), detailsNumber),
    msRounded1: eq(round(rowMps, 1), detailsNumber), msRounded2: eq(round(rowMps, 2), detailsNumber), msRounded3: eq(round(rowMps, 3), detailsNumber),
  };
}

// One row against the same athlete's details entry at the same level.
export function comparePair(row, player) {
  const rowValue = finite(row?.max_v);
  const d = detailsValue(player, DETAILS_MAX_SPEED);
  const detailsNumber = d.kind === "number" || d.kind === "bare_number" ? d.value : null;
  const relation = rowValue === null && detailsNumber === null ? "both_missing"
    : rowValue === null ? "details_only"
      : detailsNumber === null ? "row_only"
        : scalarRelation(rowValue, detailsNumber);
  return {
    relation, detailsKind: d.kind, detailsUnit: d.unit, detailsUnitText: unitTextOf(player),
    nonZero: rowValue !== null && rowValue !== 0,
    rounding: relation === "other" ? roundingOf(rowValue, detailsNumber) : null,
  };
}

// The verdict: `same` only when every compared pair keeps the importer's value exactly through one
// relation with its own unit, the details cover every valid row of the three levels, at least two
// athletes were compared at all three levels with a non-zero value, and drill 0 and drill 1 gave
// different values to at least one athlete (a server that ignores ?drill= cannot pass).
export function maxSpeedVerdict({ pairs, coverage, athletesCompared, drillsDistinguished, stoppedBy }) {
  const result = (verdict, reason = null, extra = {}) => ({ verdict, reason, ...extra });
  const compared = pairs.filter((p) => p.relation !== "both_missing");
  if (compared.some((p) => !Object.prototype.hasOwnProperty.call(EXACT_RELATIONS, p.relation))) {
    const relation = compared.find((p) => !Object.prototype.hasOwnProperty.call(EXACT_RELATIONS, p.relation)).relation;
    return result("differs", relation === "details_only" ? "details_value_where_row_has_none" : relation === "row_only" ? "not_covered" : "values_differ");
  }
  const relations = [...new Set(compared.map((p) => p.relation))];
  if (relations.length > 1) return result("differs", "relations_mixed");
  if (coverage && coverage.validRowsNotCovered > 0) return result("differs", "not_covered");
  if (stoppedBy) return result("insufficient", stoppedBy);
  if (athletesCompared < MAX_SPEED_MIN_ATHLETES) return result("insufficient", "fewer_athletes_than_needed");
  if (relations.length === 0 || !compared.some((p) => p.nonZero)) return result("insufficient", "only_zero_or_missing_values");
  if (!drillsDistinguished) return result("insufficient", "drill_parameter_not_distinguished");
  const relation = relations[0];
  const units = [...new Set(compared.map((p) => p.detailsUnitText))];
  if (units.length !== 1 || (units[0] !== EXACT_RELATIONS[relation] && !(relation === "equal" && units[0] === null))) {
    return result("insufficient", "unit_not_consistent", { relation });
  }
  return result("same", null, { relation });
}

function describeSafely(res, body) {
  const d = describeResponse(res, body);
  const out = {
    status: d.status, bodyKind: d.bodyKind, arrayLength: d.arrayLength, headerCount: d.headerNames.length,
    authScheme: d.authScheme === null ? null : AUTH_SCHEMES.includes(d.authScheme) ? d.authScheme : "<other>",
    contentTypeJson: typeof d.contentType === "string" ? /^application\/json\b/i.test(d.contentType) : null,
    totalCount: typeof d.totalCount === "string" && /^\d{1,9}$/.test(d.totalCount) ? Number(d.totalCount) : d.totalCount === null ? null : "<unprintable>",
  };
  if (Array.isArray(d.fieldNames)) {
    out.fieldNames = d.fieldNames.filter((k) => PRINTABLE_KEYS.includes(k));
    if (out.fieldNames.length < d.fieldNames.length) out.otherFieldCount = d.fieldNames.length - out.fieldNames.length;
  }
  return out;
}
const maskPath = (path, team) => maskProbePath(path, team);
const namesTeam = (value, team) => (safeId(value) === null ? null : safeId(value) === team);
const errorWord = (e) => {
  const w = e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name);
  return typeof w === "string" && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(w) ? w : "error";
};
// A details answer kept in memory without the players' athlete objects (names).
const withoutAthletes = (body) => ({ ...body, players: Object.fromEntries(Object.entries(body.players).map(([k, p]) => [k, isPlainObject(p) ? Object.fromEntries(Object.entries(p).filter(([f]) => f !== "athlete")) : p])) });

export function parseArgs(argv) {
  const opts = { host: PROBE_HOST, team: PROBE_TEAM };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--host", "--team"].includes(key) || value === undefined) throw new DiscoveryUsageError(`unknown or incomplete argument ${key}`);
    opts[key.slice(2)] = value;
  }
  if (opts.host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (opts.team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  return opts;
}

// timeoutMs and sleep exist for the tests; the pause itself is fixed.
export async function runMaxSpeedProbe({ host = PROBE_HOST, team = PROBE_TEAM, timeoutMs = REQUEST_TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}, env, fetchImpl = globalThis.fetch) {
  if (host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new DiscoveryUsageError(`timeoutMs is a whole number up to ${REQUEST_TIMEOUT_MS}`);
  const profile = discoveryProfile(host, "rest_v1");
  if (!profile.exchange) throw new DiscoveryUsageError(`host ${host} has no confirmed credential exchange`);
  const username = env.GPEXE_USERNAME;
  const password = env.GPEXE_PASSWORD;
  if (!username || !password) throw new DiscoveryUsageError("GPEXE_USERNAME and GPEXE_PASSWORD are not both set in this terminal");
  const api = profile.apiPrefix;
  const report = {
    source: "gpexe", hostKey: host, apiFamily: profile.apiFamily, teamId: team, mode: "max-speed", ranAt: new Date().toISOString(),
    pauseMs: MAX_SPEED_PAUSE_MS, maxRequests: MAX_SPEED_MAX_REQUESTS, requests: [], stoppedBy: null,
  };
  let requests = 0;
  const countRequest = () => {
    requests += 1;
    if (requests > MAX_SPEED_MAX_REQUESTS) throw new ProbeStop("request_limit", `more than ${MAX_SPEED_MAX_REQUESTS} requests would be needed`);
  };
  const run = { selection: {}, mapping: {}, coverage: null, pairs: [], athletesCompared: 0, drillsDistinguished: false };
  let issued = null;
  const letGo = (res) => {
    try {
      Promise.resolve(res?.body?.cancel?.()).catch(() => {});
    } catch {
      // A cancel that throws changes nothing.
    }
  };

  const done = () => {
    report.maxSpeed = {
      ...maxSpeedVerdict({ pairs: run.pairs.map((p) => p.result), coverage: run.coverage, athletesCompared: run.athletesCompared, drillsDistinguished: run.drillsDistinguished, stoppedBy: report.stoppedBy }),
      athletesCompared: run.athletesCompared, drillsDistinguished: run.drillsDistinguished,
      selection: run.selection, mapping: run.mapping, coverage: run.coverage,
      pairs: run.pairs.map(({ athlete, level, result }) => ({ athlete, level, ...result })),
    };
    report.requestCount = report.requests.length;
    const text = assertNoSecretInReport(report, env);
    if (issued && text.includes(issued)) {
      const error = new Error("refusing to print: the report would contain the issued token");
      error.code = "secret_in_report";
      throw error;
    }
    return report;
  };

  // 1. The one exchange, in the host's confirmed form; a 429 on it ends the run like any other.
  countRequest();
  issued = await (async () => {
    const url = new URL(profile.exchange.path, profile.baseUrl);
    if (!url.href.startsWith(profile.baseUrl)) throw new DiscoveryUsageError("the exchange path left the host");
    const entry = { method: "POST", path: maskPath(profile.exchange.path, team), authenticated: false, bodyEncoding: profile.exchange.encoding };
    const form = profile.exchange.encoding === "form";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.href, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams({ username, password }).toString() : JSON.stringify({ username, password }),
      });
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      if (res.status === 429) {
        letGo(res);
        report.requests.push({ ...entry, status: 429 });
        report.rateLimit = { requestNumber: requests, ...retryAfterOf(header("retry-after")) };
        return null;
      }
      if (res.status >= 300 && res.status < 400) {
        letGo(res);
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return null;
      }
      let body;
      try {
        const text = await readBounded(res, header("content-length"), MAX_EXCHANGE_BYTES);
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        report.requests.push({ ...entry, status: res.status, error: "answer_too_large_or_unreadable" });
        return null;
      }
      report.requests.push({ ...entry, ...describeSafely(res, body) });
      const field = profile.exchange.tokenField;
      return res.status === 200 && isPlainObject(body) && typeof body[field] === "string" && body[field] ? body[field] : null;
    } catch (e) {
      report.requests.push({ ...entry, error: errorWord(e) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (!issued) {
    report.stoppedBy = report.rateLimit ? "rate_limited" : "exchange_failed";
    return done();
  }

  // The ONLY read: GET, one relative resource path under a prefix of the same host, a pause before it,
  // a bounded body, no repeat, redirects refused, the first 429 the end of the run, a refused credential
  // too. Under `api/` only the two drill reads a check sends, for the confirmed parent.
  const get = (resourcePath) => read(api, resourcePath);
  const getDrill = (parentId, index) => {
    const resourcePath = `team_session/${parentId}/details/?drill=${index}`;
    if (!MAX_SPEED_DRILL_PATH.test(resourcePath) || !MAX_SPEED_DRILLS.includes(index)) throw new ProbeStop("path_refused", "not a drill read of a check for the confirmed parent");
    return read(LEGACY_API_PREFIX, resourcePath);
  };
  async function read(prefix, resourcePath) {
    countRequest();
    await sleep(MAX_SPEED_PAUSE_MS);
    const url = new URL(`${prefix}${resourcePath}`, profile.baseUrl);
    if (!url.href.startsWith(`${profile.baseUrl}${prefix}`)) throw new ProbeStop("path_refused", "a path left its prefix");
    const entry = { method: "GET", path: maskPath(`${prefix}${resourcePath}`, team), authenticated: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url.href, { method: "GET", headers: { Authorization: `${profile.authScheme} ${issued}`, Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      } catch (e) {
        report.requests.push({ ...entry, error: errorWord(e) });
        return { status: null };
      }
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      if (res.status === 429) {
        letGo(res);
        report.requests.push({ ...entry, status: 429 });
        report.rateLimit = { requestNumber: requests, ...retryAfterOf(header("retry-after")) };
        throw new ProbeStop("rate_limited", "the source asked to slow down; nothing more is sent");
      }
      if (res.status === 401 || res.status === 403) {
        letGo(res);
        report.requests.push({ ...entry, status: res.status });
        throw new ProbeStop("source_auth_rejected", "the source refused the credential");
      }
      if (res.status >= 300 && res.status < 400) {
        letGo(res);
        report.requests.push({ ...entry, status: res.status, redirected: true });
        return { status: res.status };
      }
      let body;
      try {
        const text = await readBounded(res, header("content-length"));
        body = text === "" ? undefined : redactGpexe(JSON.parse(text));
      } catch {
        report.requests.push({ ...entry, status: res.status, error: "answer_too_large_or_unreadable" });
        return { status: res.status };
      }
      report.requests.push({ ...entry, ...describeSafely(res, body) });
      return { status: res.status, body, totalCount: header("x-total-count") };
    } finally {
      clearTimeout(timer);
    }
  }
  const assertTeam = (rows, what) => {
    for (const row of rows) {
      if (!isPlainObject(row) || !("team" in row)) continue;
      const named = namesTeam(row.team, team);
      if (named === false) throw new ProbeStop("team_isolation_failed", `${what}: a row of another team was returned`);
      if (named === null) throw new ProbeStop("team_unknown_shape", `${what}: a row names its team in an unknown shape`);
    }
  };

  try {
    // 2. The session list of team 980 (one page). A parent: team 980, a readable id, named in no other
    //    row's `drills`, an explicit `drills` list of at least two entries, valid statistics; repeats of
    //    one id count once; the one with the fewest drills, so its athlete list most likely fits a page.
    const list = await get(teamScopedPath("team_session/", team, [["limit", LIST_LIMIT]]));
    if (list.status !== 200 || !Array.isArray(list.body)) throw new ProbeStop("session_list_unavailable", "the session list could not be read");
    const rows = list.body.filter(isPlainObject);
    assertTeam(rows, "session list");
    const named = new Set(rows.flatMap((r) => (Array.isArray(r.drills) ? r.drills.map(safeId).filter(Boolean) : [])));
    const candidates = rows.filter((r) => safeId(r.id) !== null && namesTeam(r.team, team) === true && !named.has(safeId(r.id))
      && Array.isArray(r.drills) && r.drills.length >= 2 && r.is_stats_valid === true);
    const seen = new Set();
    const distinct = candidates.filter((r) => !seen.has(safeId(r.id)) && seen.add(safeId(r.id)));
    run.selection = { listRows: rows.length, parentCandidates: distinct.length, repeatedParentIds: candidates.length - distinct.length };
    if (distinct.length === 0) throw new ProbeStop("no_parent_session", "the list page holds no parent with two drills and valid statistics");
    const parentRow = distinct.reduce((best, r) => (r.drills.length < best.drills.length ? r : best));
    const parentId = safeId(parentRow.id);
    run.selection.parentDrills = parentRow.drills.length;

    // 3. The parent's own read: the same id, team 980, a drill count from 2 to 30, valid statistics.
    const own = await get(`team_session/${parentId}/`);
    if (own.status !== 200 || !isPlainObject(own.body)) throw new ProbeStop("parent_not_confirmed", "the session's own read failed");
    assertTeam([own.body], "session");
    if (safeId(own.body.id) !== parentId) throw new ProbeStop("parent_id_mismatch", "the session's own read named another id");
    const drillsCount = own.body.drills_count;
    if (namesTeam(own.body.team, team) !== true || !Number.isInteger(drillsCount) || drillsCount < 2 || drillsCount > 30 || own.body.is_stats_valid !== true) {
      throw new ProbeStop("parent_not_confirmed", "the session's own read did not confirm team 980, two or more drills and valid statistics");
    }

    // 4. Its athlete list (the first page, which must be the whole list): every row names this
    //    session, a readable id and athlete, and a drill that is none or an index of this session.
    const athletes = await get(`athlete_session/?teamsession=${parentId}&limit=${LIST_LIMIT}`);
    if (athletes.status !== 200 || !Array.isArray(athletes.body)) throw new ProbeStop("athlete_list_unavailable", "the athlete list could not be read");
    const arows = athletes.body.filter(isPlainObject);
    if (arows.length !== athletes.body.length) throw new ProbeStop("athlete_rows_unreadable", "an athlete row is not an object");
    if (arows.length === 0) throw new ProbeStop("athlete_list_empty", "the parent's athlete list holds no row");
    const levelOf = (r) => (r.drill === null || r.drill === undefined ? "whole" : Number.isInteger(r.drill) && r.drill >= 0 && r.drill < drillsCount ? `drill${r.drill}` : null);
    for (const r of arows) {
      const ts = safeId(r.teamsession);
      if (ts === null) throw new ProbeStop("rows_do_not_name_session", "an athlete row names no session in a readable way");
      if (ts !== parentId) throw new ProbeStop("team_isolation_failed", "athlete rows of another session were returned");
      if (safeId(r.id) === null || safeId(r.athlete) === null) throw new ProbeStop("row_identity_unreadable", "an athlete row's id or athlete is not readable");
      if (levelOf(r) === null) throw new ProbeStop("row_drill_unreadable", "an athlete row names a drill this session does not have");
    }
    const ids = arows.map((r) => safeId(r.id));
    if (new Set(ids).size !== ids.length) throw new ProbeStop("row_ids_repeated", "the athlete list names one row twice");
    const total = typeof athletes.totalCount === "string" && /^\d{1,9}$/.test(athletes.totalCount) ? Number(athletes.totalCount) : null;
    run.mapping = { pageComplete: total !== null && total === arows.length, rowsOnPage: arows.length };
    if (!run.mapping.pageComplete) throw new ProbeStop("athlete_list_incomplete", "the athlete list does not fit the one page read");

    // 5. to 7. The whole-session details (rest/v1) and the details of drills 0 and 1 (api/), the
    //    forms a check reads, kept in memory without the players' names.
    const asDetails = (answer) => (answer.status === 200 && isPlainObject(answer.body) && isPlainObject(answer.body.players) ? withoutAthletes(answer.body) : null);
    const details = { whole: asDetails(await get(`team_session/${parentId}/details/`)) };
    if (!details.whole) throw new ProbeStop("details_unavailable", "the whole session's details could not be read as players");
    for (const index of MAX_SPEED_DRILLS) {
      details[`drill${index}`] = asDetails(await getDrill(parentId, index));
      if (!details[`drill${index}`]) throw new ProbeStop("drill_details_unavailable", "a drill's details could not be read as players");
    }
    const keysCanonical = Object.values(details).every((d) => Object.keys(d.players).every((k) => safeId(k) === k));
    Object.assign(run.mapping, { playerKeysCanonical: keysCanonical, wholeDetailsNamesParent: safeId(details.whole.teamsession) === parentId });
    if (!keysCanonical) throw new ProbeStop("player_keys_unreadable", "a details answer names an athlete in an unreadable way");

    // Coverage over the whole athlete list, in memory: every row at the three levels, by its validity,
    // against the same athlete's details entry at the same level.
    const coverage = { levels: {}, validRows: 0, validRowsCovered: 0, validRowsNotCovered: 0, rowsNotValid: 0 };
    for (const level of MAX_SPEED_LEVELS) {
      const atLevel = arows.filter((r) => levelOf(r) === level);
      const players = details[level].players;
      const kindOf = (r) => detailsValue(players[safeId(r.athlete)], DETAILS_MAX_SPEED).kind;
      const valid = atLevel.filter((r) => r.is_stats_valid === true);
      const covered = valid.filter((r) => ["number", "bare_number"].includes(kindOf(r)));
      const rowAthletes = new Set(atLevel.map((r) => safeId(r.athlete)));
      const withoutRow = Object.keys(players).filter((k) => !rowAthletes.has(k));
      coverage.levels[level] = {
        rows: atLevel.length, validRows: valid.length, validRowsCovered: covered.length,
        notValidRowKinds: [...new Set(atLevel.filter((r) => r.is_stats_valid !== true).map(kindOf))].sort(),
        detailsPlayers: Object.keys(players).length, detailsPlayersWithoutRow: withoutRow.length,
        withoutRowKinds: [...new Set(withoutRow.map((k) => detailsValue(players[k], DETAILS_MAX_SPEED).kind))].sort(),
      };
      coverage.validRows += valid.length;
      coverage.validRowsCovered += covered.length;
      coverage.rowsNotValid += atLevel.length - valid.length;
    }
    coverage.validRowsNotCovered = coverage.validRows - coverage.validRowsCovered;
    run.coverage = coverage;

    // The athletes compared: in the list's order, exactly one valid row at each of the three levels and
    // an entry in each of the three details answers; at most three.
    const order = [...new Set(arows.filter((r) => levelOf(r) === "whole").map((r) => safeId(r.athlete)))];
    const chosen = [];
    for (const athlete of order) {
      const at = (level) => arows.filter((r) => safeId(r.athlete) === athlete && levelOf(r) === level);
      const byLevel = Object.fromEntries(MAX_SPEED_LEVELS.map((level) => [level, at(level)]));
      if (MAX_SPEED_LEVELS.some((level) => byLevel[level].length !== 1 || byLevel[level][0].is_stats_valid !== true || !isPlainObject(details[level].players[athlete]))) continue;
      chosen.push({ athlete, rows: Object.fromEntries(MAX_SPEED_LEVELS.map((level) => [level, byLevel[level][0]])) });
      if (chosen.length === MAX_SPEED_ATHLETES) break;
    }
    run.selection.athletesEligible = chosen.length;
    if (chosen.length === 0) throw new ProbeStop("no_comparable_athlete", "no athlete has one valid row at the whole session and at drills 0 and 1 with all three details entries");

    // 8. to 16. Each chosen row's own read: the same id, athlete, session and level as its list row;
    //    compared as soon as it arrives.
    for (const [i, c] of chosen.entries()) {
      const values = {};
      for (const level of MAX_SPEED_LEVELS) {
        const listed = c.rows[level];
        const rowId = safeId(listed.id);
        const own2 = await get(`athlete_session/${rowId}/`);
        if (own2.status !== 200 || !isPlainObject(own2.body)) throw new ProbeStop("row_unavailable", "a row's own read failed");
        const body = own2.body;
        if (safeId(body.id) !== rowId || safeId(body.athlete) !== c.athlete || safeId(body.teamsession) !== parentId || levelOf(body) !== level) {
          throw new ProbeStop("row_identity_mismatch", "a row's own read named another row, athlete, session or level");
        }
        const player = details[level].players[c.athlete];
        run.pairs.push({ athlete: i + 1, level, result: comparePair(body, player) });
        values[level] = detailsValue(player, DETAILS_MAX_SPEED).value;
      }
      run.athletesCompared = i + 1;
      if (values.drill0 !== null && values.drill1 !== null && values.drill0 !== values.drill1) run.drillsDistinguished = true;
    }
  } catch (e) {
    if (e instanceof ProbeStop) report.stoppedBy = e.code;
    else if (e instanceof DiscoveryUsageError) throw e;
    else report.stoppedBy = "unexpected_error";
  }
  return done();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runMaxSpeedProbe(opts, process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.name || "Error"}${e instanceof DiscoveryUsageError ? `: ${e.message}` : e?.code ? ` (${e.code})` : ""}\n`);
    process.exit(1);
  });
}
