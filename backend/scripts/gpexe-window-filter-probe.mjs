#!/usr/bin/env node
// Owner-run, read-only: does server3's date filter on the session list return every session a check
// needs (owner order 2026-10-24, before any change to how a check finds the sessions of its window)?
//
// It reads the whole session list of Team ID 980 (the ground truth, as a check reads it today), then
// the date-filtered list for two windows, each in two forms: with a margin of two days on both sides
// (the candidate), and exactly as the importer sent it until 2026-10-08 (the look-back day and the
// window, no margin). In memory only, for each filtered answer, against the whole list:
//   - the window's parents, the look-back day's parents and every drill row they name: how many are
//     missing (a check needs all of them);
//   - whether the filtered rows alone give the same window parents (a drill row whose parent is
//     missing would be taken for a session of its own);
//   - how many rows lie outside the look-back day and the window, and how far.
// It also times every request.
//
// 1 exchange + at most 9 GET (cap 10), a 2 s pause before every read, no repeat, redirects refused,
// the first 429 ends the run, a refused credential (401, 403) too. The report holds only closed words,
// counts, booleans and durations: no id, name, date, value or credential (the final guard refuses them).
import { pathToFileURL } from "node:url";
import { assertNoSecretInReport, describeResponse, discoveryProfile, DiscoveryUsageError } from "./gpexe-auth-discovery.mjs";
import { readBounded, teamScopedPath } from "../src/gpexeRestV1Adapter.js";
import { redactGpexe } from "../src/gpexeClient.js";
import { dayOf, LIST_LIMIT, MAX_EXCHANGE_BYTES, maskProbePath, PROBE_HOST, PROBE_TEAM, safeId } from "./gpexe-rest-v1-capability-probe.mjs";
import { retryAfterOf } from "./gpexe-details-coverage-probe.mjs";

export const WINDOW_FILTER_MAX_REQUESTS = 10;
export const WINDOW_FILTER_PAUSE_MS = 2_000;
// A whole-list page took about 18 s in the check of 2026-10-24; a read gets 60 s.
export const WINDOW_FILTER_TIMEOUT_MS = 60_000;
export const WHOLE_LIST_MAX_PAGES = 5;
export const MARGIN_DAYS = 2;
export const LOOK_BACK_DAYS = 1;
// The two windows the owner approved: the 14-day check of 2026-10-24 and the window whose filtered
// answer carried rows after its end on 2026-10-07.
export const WINDOWS = Object.freeze([
  Object.freeze({ key: "days14", from: "2026-10-11", to: "2026-10-24" }),
  Object.freeze({ key: "days2", from: "2026-10-05", to: "2026-10-06" }),
]);
export const FORMS = Object.freeze(["margin", "exact"]);
const AUTH_SCHEMES = Object.freeze(["Token", "Bearer", "Basic", "Digest"]);

class ProbeStop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
// The bounds a form asks for, as the importer sent them until 2026-10-08 (a space and colons in the value).
export function boundsOf(window, form) {
  const margin = form === "margin" ? MARGIN_DAYS : 0;
  return { gte: addDays(window.from, -LOOK_BACK_DAYS - margin), lte: addDays(window.to, margin) };
}
export function filteredPath(window, form, team) {
  const { gte, lte } = boundsOf(window, form);
  return teamScopedPath("team_session/", team, [["start_timestamp_gte", `${gte}%2000%3A00%3A00`], ["start_timestamp_lte", `${lte}%2023%3A59%3A59`], ["limit", LIST_LIMIT]]);
}

// Parents and drills of a set of rows, by the list's own structure (as the adapter tells them apart):
// a row named in another row's `drills` is a drill row; every other row is a parent.
export function classify(rows) {
  const byId = new Map();
  for (const r of rows) if (safeId(r.id) !== null) byId.set(safeId(r.id), r);
  const drillParent = new Map();
  for (const r of rows) {
    if (!Array.isArray(r.drills)) continue;
    for (const d of r.drills) if (safeId(d) !== null) drillParent.set(safeId(d), safeId(r.id));
  }
  const parents = [...byId.keys()].filter((id) => !drillParent.has(id));
  return { byId, drillParent, parents };
}

// Hours between a naive start and a bound (both read as UTC, as the importer reads them).
const hoursBetween = (a, b) => (Date.parse(`${a}Z`) - Date.parse(`${b}Z`)) / 3_600_000;
export const DISTANCE_BUCKETS = Object.freeze(["under_24h", "24h_to_48h", "48h_to_72h", "over_72h", "unreadable"]);
const bucketOf = (h) => (!Number.isFinite(h) ? "unreadable" : h < 24 ? "under_24h" : h < 48 ? "24h_to_48h" : h < 72 ? "48h_to_72h" : "over_72h");
const naiveStart = (r) => (typeof r.start_timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(r.start_timestamp) ? r.start_timestamp.slice(0, 19) : null);

// One filtered answer against the whole list, for one window.
export function compareWindow(whole, filtered, window) {
  const lookBack = addDays(window.from, -LOOK_BACK_DAYS);
  const w = classify(whole);
  const f = classify(filtered);
  const dayOfId = (byId, id) => dayOf(byId.get(id)?.start_timestamp);
  const windowParents = w.parents.filter((id) => { const d = dayOfId(w.byId, id); return d !== null && d >= window.from && d <= window.to; });
  const lookBackParents = w.parents.filter((id) => dayOfId(w.byId, id) === lookBack);
  const neededDrills = [...w.drillParent].filter(([d, p]) => w.byId.has(d) && (windowParents.includes(p) || lookBackParents.includes(p))).map(([d]) => d);
  const missing = (ids) => ids.filter((id) => !f.byId.has(id)).length;
  // The window's parents as a check would find them from the filtered rows alone.
  const filteredWindowParents = f.parents.filter((id) => { const d = dayOfId(f.byId, id); return d !== null && d >= window.from && d <= window.to; });
  const takenForSession = filteredWindowParents.filter((id) => !windowParents.includes(id)).length;
  const lost = windowParents.filter((id) => !filteredWindowParents.includes(id)).length;
  // Rows outside the look-back day and the window: how many, and how far from the bound.
  const before = Object.fromEntries(DISTANCE_BUCKETS.map((b) => [b, 0]));
  const after = Object.fromEntries(DISTANCE_BUCKETS.map((b) => [b, 0]));
  let outside = 0;
  for (const r of filtered) {
    const d = dayOf(r.start_timestamp);
    if (d !== null && d >= lookBack && d <= window.to) continue;
    outside += 1;
    const s = naiveStart(r);
    if (d === null || s === null) { after.unreadable += 1; continue; }
    if (d < lookBack) before[bucketOf(hoursBetween(`${lookBack}T00:00:00`, s))] += 1;
    else after[bucketOf(hoursBetween(s, `${window.to}T23:59:59`))] += 1;
  }
  return {
    windowParents: windowParents.length, lookBackParents: lookBackParents.length, neededDrills: neededDrills.length,
    filteredRows: filtered.length,
    missingWindowParents: missing(windowParents), missingLookBackParents: missing(lookBackParents), missingDrills: missing(neededDrills),
    sameWindowParents: lost === 0 && takenForSession === 0, windowParentsLost: lost, rowsTakenForSession: takenForSession,
    notInWholeList: filtered.filter((r) => !w.byId.has(safeId(r.id))).length,
    outsideRows: outside, outsideBefore: before, outsideAfter: after,
  };
}

// The verdict: `safe` only when, for both windows, the margin form misses no window parent, no
// look-back parent and no drill, gives exactly the window's parents from its rows alone, and every
// answer was read whole; `unsafe` when any of those fails; `insufficient` when the run stopped first.
export function windowFilterVerdict(results, stoppedBy) {
  const margin = WINDOWS.map((w) => results?.[w.key]?.margin ?? null);
  const unsafe = margin.find((r) => r && (r.missingWindowParents > 0 || r.missingLookBackParents > 0 || r.missingDrills > 0 || !r.sameWindowParents || !r.pageComplete));
  if (unsafe) return { verdict: "unsafe", reason: !unsafe.pageComplete ? "filtered_answer_incomplete" : unsafe.missingWindowParents > 0 || unsafe.windowParentsLost > 0 ? "window_parent_missing" : unsafe.missingDrills > 0 ? "drill_missing" : unsafe.missingLookBackParents > 0 ? "look_back_parent_missing" : "drill_taken_for_session" };
  if (stoppedBy) return { verdict: "insufficient", reason: stoppedBy };
  if (margin.some((r) => r === null)) return { verdict: "insufficient", reason: "window_not_compared" };
  if (margin.every((r) => r.windowParents === 0)) return { verdict: "insufficient", reason: "no_session_in_windows" };
  return { verdict: "safe", reason: null };
}

function describeSafely(res, body) {
  const d = describeResponse(res, body);
  return {
    status: d.status, bodyKind: d.bodyKind, arrayLength: d.arrayLength,
    authScheme: d.authScheme === null ? null : AUTH_SCHEMES.includes(d.authScheme) ? d.authScheme : "<other>",
    totalCount: typeof d.totalCount === "string" && /^\d{1,9}$/.test(d.totalCount) ? Number(d.totalCount) : d.totalCount === null ? null : "<unprintable>",
  };
}
const errorWord = (e) => {
  const w = e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name);
  return typeof w === "string" && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(w) ? w : "error";
};

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

// timeoutMs, sleep and now exist for the tests; the pause itself is fixed.
export async function runWindowFilterProbe({ host = PROBE_HOST, team = PROBE_TEAM, timeoutMs = WINDOW_FILTER_TIMEOUT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now() } = {}, env, fetchImpl = globalThis.fetch) {
  if (host !== PROBE_HOST) throw new DiscoveryUsageError(`this probe reads host ${PROBE_HOST} only`);
  if (team !== PROBE_TEAM) throw new DiscoveryUsageError(`this probe reads Team ID ${PROBE_TEAM} only`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WINDOW_FILTER_TIMEOUT_MS) throw new DiscoveryUsageError(`timeoutMs is a whole number up to ${WINDOW_FILTER_TIMEOUT_MS}`);
  const profile = discoveryProfile(host, "rest_v1");
  if (!profile.exchange) throw new DiscoveryUsageError(`host ${host} has no confirmed credential exchange`);
  const username = env.GPEXE_USERNAME;
  const password = env.GPEXE_PASSWORD;
  if (!username || !password) throw new DiscoveryUsageError("GPEXE_USERNAME and GPEXE_PASSWORD are not both set in this terminal");
  const api = profile.apiPrefix;
  const report = {
    source: "gpexe", hostKey: host, apiFamily: profile.apiFamily, teamId: team, mode: "window-filter", ranAt: new Date().toISOString(),
    pauseMs: WINDOW_FILTER_PAUSE_MS, maxRequests: WINDOW_FILTER_MAX_REQUESTS, marginDays: MARGIN_DAYS, lookBackDays: LOOK_BACK_DAYS,
    requests: [], stoppedBy: null,
  };
  let requests = 0;
  const countRequest = () => {
    requests += 1;
    if (requests > WINDOW_FILTER_MAX_REQUESTS) throw new ProbeStop("request_limit", `more than ${WINDOW_FILTER_MAX_REQUESTS} requests would be needed`);
  };
  const results = {};
  const whole = { rows: null, total: null, pages: 0, ms: 0 };
  let issued = null;
  const letGo = (res) => {
    try {
      Promise.resolve(res?.body?.cancel?.()).catch(() => {});
    } catch {
      // A cancel that throws changes nothing.
    }
  };
  const roundMs = (ms) => Math.round(ms / 100) * 100;

  const done = () => {
    report.wholeList = whole.rows === null ? null : { rows: whole.rows.length, total: whole.total, pages: whole.pages, complete: whole.total === whole.rows.length, ms: roundMs(whole.ms) };
    report.windows = results;
    report.windowFilter = windowFilterVerdict(results, report.stoppedBy);
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
    const entry = { method: "POST", path: maskProbePath(profile.exchange.path, team), authenticated: false };
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
      report.requests.push({ ...entry, status: res.status });
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

  // The ONLY read: GET of the session list of team 980 under the host's own prefix, a pause before it,
  // a bounded body, no repeat, redirects refused, the first 429 or a refused credential the end.
  async function readList(resourcePath, what) {
    countRequest();
    await sleep(WINDOW_FILTER_PAUSE_MS);
    const url = new URL(`${api}${resourcePath}`, profile.baseUrl);
    if (!url.href.startsWith(`${profile.baseUrl}${api}team_session/?team=${team}&`)) throw new ProbeStop("path_refused", "a path left the team's session list");
    const entry = { method: "GET", path: maskProbePath(`${api}${resourcePath}`, team).replace(/offset=\d+/, "offset=<n>"), what, authenticated: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();
    try {
      let res;
      try {
        res = await fetchImpl(url.href, { method: "GET", headers: { Authorization: `${profile.authScheme} ${issued}`, Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      } catch (e) {
        report.requests.push({ ...entry, ms: roundMs(now() - started), error: errorWord(e) });
        throw new ProbeStop("list_unavailable", "a list read failed");
      }
      const header = (name) => (typeof res.headers?.get === "function" ? res.headers.get(name) : null);
      if (res.status === 429) {
        letGo(res);
        report.requests.push({ ...entry, ms: roundMs(now() - started), status: 429 });
        report.rateLimit = { requestNumber: requests, ...retryAfterOf(header("retry-after")) };
        throw new ProbeStop("rate_limited", "the source asked to slow down; nothing more is sent");
      }
      if (res.status === 401 || res.status === 403) {
        letGo(res);
        report.requests.push({ ...entry, ms: roundMs(now() - started), status: res.status });
        throw new ProbeStop("source_auth_rejected", "the source refused the credential");
      }
      let body;
      try {
        const text = await readBounded(res, header("content-length"));
        body = text === "" ? undefined : redactGpexe(JSON.parse(text));
      } catch {
        report.requests.push({ ...entry, ms: roundMs(now() - started), status: res.status, error: "answer_too_large_or_unreadable" });
        throw new ProbeStop("list_unavailable", "a list answer could not be read");
      }
      const ms = now() - started;
      report.requests.push({ ...entry, ms: roundMs(ms), ...describeSafely(res, body) });
      if (res.status !== 200 || !Array.isArray(body) || !body.every(isPlainObject)) throw new ProbeStop("list_unavailable", "a list answer is not a list of sessions");
      for (const row of body) {
        if (safeId(row.team) !== team) throw new ProbeStop(safeId(row.team) === null ? "team_unknown_shape" : "team_isolation_failed", "a list row names another team or none");
      }
      const total = header("x-total-count");
      return { rows: body, total: typeof total === "string" && /^\d{1,9}$/.test(total) ? Number(total) : null, ms };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // 2. The whole list, page by page (offset paging, as a check's next links), until X-Total-Count.
    whole.rows = [];
    for (let page = 0; page < WHOLE_LIST_MAX_PAGES; page += 1) {
      const pairs = [["limit", LIST_LIMIT], ...(page === 0 ? [] : [["offset", whole.rows.length]])];
      const answer = await readList(teamScopedPath("team_session/", team, pairs), "whole_list");
      whole.pages += 1;
      whole.ms += answer.ms;
      if (answer.total === null) throw new ProbeStop("list_total_unreadable", "the whole list carries no readable total");
      if (whole.total !== null && answer.total !== whole.total) throw new ProbeStop("list_changed", "the whole list's total changed between pages");
      whole.total = answer.total;
      whole.rows.push(...answer.rows);
      if (whole.rows.length >= whole.total || answer.rows.length === 0) break;
    }
    if (whole.rows.length !== whole.total) throw new ProbeStop("whole_list_too_large", "the whole list does not fit the pages this probe reads");
    if (new Set(whole.rows.map((r) => safeId(r.id))).size !== whole.rows.length || whole.rows.some((r) => safeId(r.id) === null)) {
      throw new ProbeStop("list_ids_unreadable", "the whole list names a session twice or in an unreadable way");
    }
    // 3. The filtered list for each window, with the margin and exactly (the form sent until 2026-10-08).
    for (const window of WINDOWS) {
      results[window.key] = {};
      for (const form of FORMS) {
        const answer = await readList(filteredPath(window, form, team), `${window.key}_${form}`);
        results[window.key][form] = { ...compareWindow(whole.rows, answer.rows, window), totalCount: answer.total, pageComplete: answer.total !== null && answer.total === answer.rows.length, ms: roundMs(answer.ms) };
      }
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
  const report = await runWindowFilterProbe(opts, process.env);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.name || "Error"}${e instanceof DiscoveryUsageError ? `: ${e.message}` : e?.code ? ` (${e.code})` : ""}\n`);
    process.exit(1);
  });
}
