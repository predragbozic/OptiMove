// Owner-run, read-only probe of the server3 / rest_v1 capabilities the
// adapter does not implement yet (F3c2b; docs/ai/gpexe-rest-v1-compatibility.md
// section 4). It answers, for Team ID 980 only, which of the importer's
// reads rest_v1 has, in which form, and what shape they answer with.
//
// What it does: ONE credential exchange (the host's confirmed form, taken
// from the application's catalog), then GET requests only, at most
// MAX_REQUESTS in all. Every id it needs - the session, the drill, the
// athlete row, the track - is taken from an answer it has already received
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
// GET only after the one exchange; one host, one family, URLs from the
// application's catalog; redirects never followed; a timeout per request;
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
  return maskPath(path, team)
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
export const sameAnswer = (a, b) => canonical(a) === canonical(b);
const fieldNamesOf = (v) => (Array.isArray(v) ? (v[0] && typeof v[0] === "object" ? Object.keys(v[0]).sort() : []) : v && typeof v === "object" ? Object.keys(v).sort() : []);
const rowCount = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" && Array.isArray(v.results) ? v.results.length : null);
// Equivalent = same top-level field names, same row count, same values.
export const equivalentAnswers = (a, b) => canonical(fieldNamesOf(a)) === canonical(fieldNamesOf(b)) && rowCount(a) === rowCount(b) && sameAnswer(a, b);

// The drill matrix of the compatibility document (owner, 2026-10-01).
//   ordinal: status of details/?drill=0 on the parent, by position
//   byId:    status of team_session/<drill id>/details/
//   whole:   the parent's whole-session details
export function classifyDrill({ ordinalStatus, ordinalBody, byIdStatus, byIdBody, wholeBody }) {
  const ordinalOk = ordinalStatus === 200;
  const byIdOk = byIdStatus === 200;
  const parameterApplied = ordinalOk ? !sameAnswer(ordinalBody, wholeBody) : null;
  const equivalent = ordinalOk && byIdOk ? equivalentAnswers(ordinalBody, byIdBody) : null;
  const idDiffersFromWhole = byIdOk ? !sameAnswer(byIdBody, wholeBody) : null;
  let verdict = "not_observed";
  if (ordinalOk && parameterApplied === true && (byIdOk ? equivalent === true : true)) verdict = "same";
  else if (!ordinalOk && byIdOk && idDiffersFromWhole === true) verdict = "mapped";
  return { verdict, ordinalStatus: ordinalStatus ?? null, byIdStatus: byIdStatus ?? null, parameterApplied, equivalent, idDiffersFromWhole };
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
      report.requests.push({ ...entry, ...describeResponse(res, body, { teamId: team }) });
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
    return finish(report, env, null);
  }

  // The ONLY read: GET, one relative resource path under the family prefix,
  // bounded body, no retry, redirects refused.
  async function get(resourcePath) {
    countRequest();
    const url = new URL(`${api}${resourcePath}`, profile.baseUrl);
    if (!url.href.startsWith(`${profile.baseUrl}${api}`)) throw new ProbeStop("path_refused", "a path left the family prefix");
    const entry = { method: "GET", path: maskProbePath(`${api}${resourcePath}`, team), authenticated: true };
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
      const described = describeResponse(res, body, { teamId: team });
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
      return finish(report, env, issued);
    }
    assertTeam(rows, "session list");
    const unfilteredTotal = parseTotal(list.totalCount);
    const haveDrillsField = rows.some((r) => "drills" in r);
    const named = new Set(rows.flatMap((r) => (Array.isArray(r.drills) ? r.drills.map((d) => safeId(d)).filter(Boolean) : [])));
    const firstParent = rows.find((r) => Array.isArray(r.drills) && r.drills.length > 0 && safeId(r.drills[0]) !== null && safeId(r.id) !== null);
    const firstUnnamed = rows.find((r) => safeId(r.id) !== null && !named.has(safeId(r.id)));
    const chosen = firstParent ?? firstUnnamed ?? null;
    const sessionId = chosen ? safeId(chosen.id) : null;
    const days = new Set(rows.map((r) => dayOf(r.start_timestamp)).filter(Boolean));
    verdict("session_list", {
      verdict: "proven", status: 200, rowCount: rows.length, totalIsNumber: unfilteredTotal !== null,
      rowsHaveDrillsField: haveDrillsField, parentChosen: Boolean(firstParent), parentUnconfirmed: !firstParent && Boolean(firstUnnamed), sessionIdDerived: sessionId !== null, distinctDays: days.size,
    });
    if (sessionId === null) {
      report.stoppedBy = "no_safe_session_id";
      return finish(report, env, issued);
    }

    // The drill-only run (owner, 2026-10-01, after the full run found the
    // parent's own read without a `drills` list). Every identity is confirmed
    // before the next read, and the chain stops without a further request
    // at the first identity or team that is not confirmed.
    if (mode === "drill") {
      if (!firstParent) {
        report.stoppedBy = "no_parent_with_drills_in_list";
        return finish(report, env, issued);
      }
      const drillId = safeId(firstParent.drills[0]);
      // Every early stop still names the drill verdict, as the full run does.
      const stopDrill = (code) => {
        report.stoppedBy = code;
        verdict("session_drill_details", { verdict: "not_observed", reason: code });
        return finish(report, env, issued);
      };
      // A row that names itself as its own drill is not a parent for certain.
      if (drillId === sessionId) return stopDrill("drill_is_parent");
      // 2. The parent's own read: the same id, team 980, drills_count > 0.
      const parent = await get(`team_session/${sessionId}/`);
      const pb = parent.body;
      const parentOk = Boolean(parent.status === 200 && pb && typeof pb === "object" && !Array.isArray(pb));
      if (parentOk) assertTeam([pb], "parent session");
      const parentIdOk = parentOk && safeId(pb.id) === sessionId;
      const parentTeamOk = parentOk && namesTeam(pb.team, team) === true;
      const parentCount = parentOk && Number.isInteger(pb.drills_count) ? pb.drills_count : null;
      const parentStart = parentOk && dayOf(pb.start_timestamp) !== null;
      const parentConfirmed = parentIdOk && parentTeamOk && parentCount !== null && parentCount > 0;
      verdict("session_read", {
        // The verdict word keeps the full run's meaning (what the importer reads is present);
        // the gate of this run is `parentConfirmed`, printed beside it.
        verdict: parentTeamOk && parentCount !== null && parentStart ? "same" : "not_observed", status: parent.status ?? null, idMatchesList: parentIdOk, teamIs980: parentTeamOk,
        drillsCountPresent: parentCount !== null, drillsCountPositive: parentCount !== null && parentCount > 0, startTimestampPresent: parentStart, drillsListPresent: parentOk && Array.isArray(pb.drills), parentConfirmed,
      });
      if (!parentConfirmed) return stopDrill(parentOk && safeId(pb.id) !== null && !parentIdOk ? "parent_id_mismatch" : "parent_not_confirmed");
      // 3. The drill session's own read: the same drill id, team 980.
      const drill = await get(`team_session/${drillId}/`);
      const db = drill.body;
      const drillOk = Boolean(drill.status === 200 && db && typeof db === "object" && !Array.isArray(db));
      if (drillOk) assertTeam([db], "drill session");
      const drillIdOk = drillOk && safeId(db.id) === drillId;
      const drillTeamOk = drillOk && namesTeam(db.team, team) === true;
      // A drill whose own read names another parent contradicts the list: stop.
      const drillParent = drillOk && "teamsession" in db ? safeId(db.teamsession) : null;
      const namesParent = drillParent === null ? null : drillParent === sessionId;
      const drillConfirmed = drillIdOk && drillTeamOk && namesParent !== false;
      verdict("drill_session_read", {
        // Not an importer read: the importer never reads a drill session by its id, so the word
        // is `observed`, never `same`.
        verdict: drillConfirmed ? "observed" : "not_observed", status: drill.status ?? null, idMatchesParentList: drillIdOk, teamIs980: drillTeamOk, namesParent, drillConfirmed,
      });
      if (!drillConfirmed) {
        return stopDrill(namesParent === false ? "drill_parent_mismatch" : drillOk && safeId(db.id) !== null && !drillIdOk ? "drill_id_mismatch" : "drill_not_confirmed");
      }
      // 4. The parent's whole-session details, the reference.
      const whole = await get(`team_session/${sessionId}/details/`);
      verdict("session_details", { verdict: whole.status === 200 ? "same" : "not_observed", status: whole.status ?? null });
      if (whole.status !== 200) return stopDrill("whole_session_details_unavailable");
      // 5. and 6. The drill by position on the parent, then by its own id; 7. the matrix.
      const ordinal = await get(`team_session/${sessionId}/details/?drill=0`);
      const byId = await get(`team_session/${drillId}/details/`);
      verdict("session_drill_details", classifyDrill({ ordinalStatus: ordinal.status, ordinalBody: ordinal.body, byIdStatus: byId.status, byIdBody: byId.body, wholeBody: whole.body }));
      return finish(report, env, issued);
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

    // 4. Whole-session details (the reference for the drill matrix), only
    //    for a session whose own read confirmed team 980.
    let whole = { status: null, body: undefined };
    if (sessionTeamOk) {
      whole = await get(`team_session/${sessionId}/details/`);
      verdict("session_details", { verdict: whole.status === 200 ? "same" : "not_observed", status: whole.status ?? null });
    } else {
      verdict("session_details", { verdict: "not_observed", reason: "session_not_confirmed" });
    }

    // 5. The drill, by the importer's form (position 0) and by its real id.
    if (parentConfirmed && whole.status === 200) {
      const ordinal = await get(`team_session/${sessionId}/details/?drill=0`);
      const byId = await get(`team_session/${drillIds[0]}/details/`);
      verdict("session_drill_details", classifyDrill({ ordinalStatus: ordinal.status, ordinalBody: ordinal.body, byIdStatus: byId.status, byIdBody: byId.body, wholeBody: whole.body }));
    } else {
      verdict("session_drill_details", { verdict: "not_observed", reason: parentConfirmed ? "whole_session_details_unavailable" : "no_confirmed_parent" });
    }

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
  return finish(report, env, issued);
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
