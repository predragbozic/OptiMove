// Read-only probe of the real GPEXE API, for the owner to run in their own
// terminal before the in-app import (phase F1) is called ready. It uses the
// app's own client (backend/src/gpexeClient.js) and prints only the SHAPE of
// what GPEXE answers — never a name, an athlete id, a value, or the token.
// No database connection is opened and nothing is written anywhere.
//
// Two separate checks, so the quick one answers in seconds:
//
//   --mode paging (default, a handful of requests)
//     how the session list and one session's athlete rows are paged, and
//     whether both are read complete through every page.
//
//   --mode hash (one full session fetched twice: 2 requests per athlete row
//   plus tracks and drills — can take minutes on a slow GPEXE)
//     whether the same session hashes alike on two fetches (changed paths
//     with ids masked) and what the importer makes of it (counts only).
//
// Progress goes to stderr: the phase, each request as it starts and ends
// (paths with ids masked), requests done, seconds elapsed, and a line every
// 10 s while a request is still waiting. The whole run stops at
// --max-seconds (default 90 for paging, 600 for hash); what was found until
// then is still printed, with "timedOut": true, and the exit code is 2.
//
// PowerShell (the token stays in your own terminal):
//   $env:GPEXE_API_TOKEN = $env:GPEXE_TOKEN
//   node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-14 --to 2026-09-14 --session 186942
//   node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-14 --to 2026-09-14 --session 186942 --mode hash
//   node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-08-01 --to 2026-09-17 --paging-only
//
// --paging-only reads just the session list for exactly [from, to] (no
// day-before widening, no session fetched) through the app's paging rules and
// reports the total GPEXE announced, the rows read, the pages it took and
// whether the list ended complete. Rows are counted, never printed.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createGpexeClient, GPEXE_API_BASE, GpexeClientError } from "../src/gpexeClient.js";
import { buildGpexeImportPlan, GpexeMappingError } from "../src/gpexeImportMapper.js";
import { canonicalJson, sha256Hex } from "../src/gpexeImportPreview.js";

const DEFAULT_MAX_SECONDS = { paging: 90, hash: 600, list: 60 };
// Per request, shorter than the app's 90 s x 3: the probe is meant to answer.
const PROBE_REQUEST_TIMEOUT_MS = 30_000;
const PROBE_ATTEMPTS = 2;

function parseArgs(argv) {
  const opts = { mode: "paging" };
  argv = [...argv];
  const flag = argv.indexOf("--paging-only");
  if (flag !== -1) {
    argv.splice(flag, 1);
    opts.mode = "list";
  }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--team", "--from", "--to", "--session", "--mode", "--max-seconds"].includes(key) || value === undefined) throw new Error(`unknown or incomplete argument ${key}`);
    opts[key.slice(2)] = value;
  }
  for (const k of ["team", "from", "to"]) if (!opts[k]) throw new Error(`--${k} is required`);
  for (const k of ["team", "session"]) if (opts[k] !== undefined && !/^[0-9]{1,12}$/.test(opts[k])) throw new Error(`--${k} must be a numeric GPEXE id`);
  for (const k of ["from", "to"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new Error(`--${k} must be YYYY-MM-DD`);
  if (!["paging", "hash", "list"].includes(opts.mode)) throw new Error("--mode must be paging or hash");
  const max = opts["max-seconds"] === undefined ? DEFAULT_MAX_SECONDS[opts.mode] : Number(opts["max-seconds"]);
  if (!Number.isFinite(max) || max <= 0 || max > 3600) throw new Error("--max-seconds must be between 1 and 3600");
  opts.maxSeconds = max;
  return opts;
}

// A request path for the progress lines: API-relative, every number masked,
// query values dropped.
export function maskPath(url) {
  const u = new URL(String(url));
  const rel = u.pathname.startsWith("/api/") ? u.pathname.slice(5) : u.pathname;
  const keys = [...u.searchParams.keys()];
  return `${rel.replace(/\d+/g, "<id>")}${keys.length ? `?${keys.join("&")}` : ""}`;
}

class ProbeDeadline extends Error {
  constructor() {
    super("the probe reached its time limit");
    this.name = "ProbeDeadline";
  }
}

// Wraps fetch: counts requests, logs progress, and stops everything at the
// deadline (the client's own retries then fail at once too).
function instrumentedFetch(fetchImpl, state, log) {
  return async (url, init = {}) => {
    const remaining = state.deadlineAt - Date.now();
    if (remaining <= 0) {
      state.timedOut = true;
      throw new ProbeDeadline();
    }
    const label = maskPath(url);
    const started = Date.now();
    state.started += 1;
    const n = state.started;
    log(`[${state.phase}] #${n} → ${label}`);
    const waiting = setInterval(() => log(`[${state.phase}] #${n} still waiting on ${label} (${Math.round((Date.now() - started) / 1000)} s)`), 10_000);
    waiting.unref?.();
    const signals = [AbortSignal.timeout(remaining)];
    if (init.signal) signals.push(init.signal);
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
      state.done += 1;
      log(`[${state.phase}] #${n} ✓ ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s — ${state.done} done, ${((Date.now() - state.startedAt) / 1000).toFixed(0)} s total`);
      return res;
    } catch (error) {
      if (Date.now() >= state.deadlineAt) {
        state.timedOut = true;
        throw new ProbeDeadline();
      }
      log(`[${state.phase}] #${n} ✗ ${error?.name ?? "error"} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      throw error;
    } finally {
      clearInterval(waiting);
    }
  };
}

function pageShape(res) {
  const body = res.body;
  const isArray = Array.isArray(body);
  const next = isArray ? (/<([^>]+)>\s*;\s*rel="?next"?/i.exec(res.link ?? "")?.[1] ?? null) : (body?.next ?? null);
  let nextUrl = null;
  try {
    nextUrl = next ? new URL(next, GPEXE_API_BASE) : null;
  } catch {
    nextUrl = null;
  }
  return {
    body: isArray ? "array" : body && typeof body === "object" ? `object with keys [${Object.keys(body).sort().join(", ")}]` : typeof body,
    rowsOnPage: isArray ? body.length : Array.isArray(body?.results) ? body.results.length : null,
    totalHeader: res.totalCount ?? null,
    totalInBody: isArray ? null : body?.count ?? null,
    linkHeaderPresent: Boolean(res.link),
    nextPage: next
      ? { insideApi: typeof next === "string" && next.startsWith(GPEXE_API_BASE), relative: !/^[a-z]+:/i.test(String(next)), scheme: nextUrl?.protocol ?? null, host: nextUrl?.host ?? null }
      : null,
  };
}

// Distinct paths only (after masking, one field changing for every athlete is
// one path), at most 20.
function differingPaths(a, b, prefix = "", out = new Set()) {
  if (out.size >= 20) return [...out];
  if (canonicalJson(a) === canonicalJson(b)) return [...out];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differingPaths(a[k], b[k], `${prefix}.${/^\d+$/.test(k) ? "<id>" : k}`, out);
  } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => differingPaths(x, b[i], `${prefix}[*]`, out));
  } else {
    out.add(prefix || "(root)");
  }
  return [...out];
}

// Client error messages name request paths, which carry row ids.
function safeMessage(error) {
  return String(error?.message ?? "").replace(/\b\d+\b/g, "<id>");
}

function errorReport(error) {
  return { error: error instanceof GpexeClientError ? error.code : error?.name ?? "error", message: safeMessage(error) };
}

function countBy(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}

async function pagingChecks(client, opts, report, setPhase) {
  setPhase("session-list");
  const lookFrom = new Date(Date.parse(`${opts.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  report.sessionListFirstPage = pageShape(await client.request(`team_session/?team=${opts.team}&start_timestamp_gte=${lookFrom}%2000:00:00&start_timestamp_lte=${opts.to}%2023:59:59&limit=100`));
  try {
    const sessions = await client.listTeamSessions({ gpexeTeamId: opts.team, fromDay: opts.from, toDay: opts.to });
    // Category names are free text a team types in GPEXE: counted, not printed.
    report.sessionList = {
      complete: true,
      parentSessions: sessions.length,
      importableCategory: sessions.filter((s) => s.categoryName === "FULL TRAINING").length,
      otherCategories: sessions.filter((s) => s.categoryName !== "FULL TRAINING").length,
    };
    report.sessionIdsForNextStep = sessions.filter((s) => s.categoryName === "FULL TRAINING").slice(0, 5).map((s) => s.id);
    if (!opts.session) opts.session = report.sessionIdsForNextStep[0];
  } catch (error) {
    if (error instanceof ProbeDeadline) throw error;
    report.sessionList = { complete: false, ...errorReport(error) };
  }
  if (!opts.session) return;
  setPhase("athlete-rows");
  const athleteList = `athlete_session/?teamsession=${opts.session}&limit=100`;
  report.athleteRowsFirstPage = pageShape(await client.request(athleteList));
  try {
    const rows = await client.getAllPages(athleteList);
    report.athleteRows = { complete: true, session: opts.session, rows: rows.length, rowsOfThisSession: rows.filter((r) => String(r.teamsession) === String(opts.session)).length };
  } catch (error) {
    if (error instanceof ProbeDeadline) throw error;
    report.athleteRows = { complete: false, session: opts.session, ...errorReport(error) };
  }
}

// --paging-only: the session list for exactly [from, to], every page, counts only.
async function listOnly(client, opts, report, setPhase, state) {
  setPhase("session-list");
  const listPath = `team_session/?team=${opts.team}&start_timestamp_gte=${opts.from}%2000:00:00&start_timestamp_lte=${opts.to}%2023:59:59&limit=100`;
  const first = await client.request(listPath);
  report.firstPage = pageShape(first);
  const before = state.done;
  try {
    const rows = await client.getAllPages(listPath);
    report.sessionList = {
      complete: true,
      totalReported: Number(first.totalCount ?? first.body?.count),
      rowsRead: rows.length,
      pagesRead: state.done - before,
      readThroughMoreThanOnePage: state.done - before > 1,
    };
  } catch (error) {
    if (error instanceof ProbeDeadline) throw error;
    report.sessionList = { complete: false, pagesRead: state.done - before, ...errorReport(error) };
  }
}

async function hashCheck(client, opts, report, setPhase) {
  if (!opts.session) throw new Error("--mode hash needs --session");
  setPhase("fetch-1");
  const first = await client.fetchSessionBundle({ gpexeTeamId: opts.team, sessionId: opts.session });
  report.session = {
    id: opts.session,
    athleteRows: first.athleteSessions.length,
    tracks: Object.keys(first.tracks).length,
    drillsFetched: Object.keys(first.details.drills).length,
    thresholdsFound: first.teamThresholds !== null,
  };
  setPhase("fetch-2");
  const second = await client.fetchSessionBundle({ gpexeTeamId: opts.team, sessionId: opts.session });
  const same = sha256Hex(canonicalJson(first)) === sha256Hex(canonicalJson(second));
  report.session.sameHashOnTwoFetches = same;
  report.session.pathsThatChangedBetweenFetches = same ? [] : differingPaths(first, second);
  setPhase("importer-view");
  try {
    const plan = buildGpexeImportPlan(first);
    report.session.importerView = {
      participants: plan.participants.length,
      results: plan.participants.reduce((n, p) => n + p.results.length, 0),
      anomalies: countBy(plan.anomalies, "kind"),
      skippedValuesByReason: countBy(plan.metricSkips, "reason"),
    };
  } catch (error) {
    report.session.importerView = { blocked: error instanceof GpexeMappingError ? error.code : error.name };
  }
}

export async function main(argv, { fetchImpl = globalThis.fetch, token = process.env.GPEXE_API_TOKEN, log = (line) => console.error(line), sleep } = {}) {
  const opts = parseArgs(argv);
  const state = { phase: "start", started: 0, done: 0, startedAt: Date.now(), deadlineAt: Date.now() + opts.maxSeconds * 1000, timedOut: false };
  const client = createGpexeClient({
    token,
    fetchImpl: instrumentedFetch(fetchImpl, state, log),
    timeoutMs: PROBE_REQUEST_TIMEOUT_MS,
    attempts: PROBE_ATTEMPTS,
    retryDelayMs: 500,
    ...(sleep ? { sleep } : {}),
  });
  const setPhase = (phase) => {
    state.phase = phase;
    log(`[${phase}] started — ${state.done} requests done, ${((Date.now() - state.startedAt) / 1000).toFixed(0)} s elapsed`);
  };
  const report = { mode: opts.mode, team: opts.team, window: { from: opts.from, to: opts.to }, maxSeconds: opts.maxSeconds };
  try {
    if (opts.mode === "paging") await pagingChecks(client, opts, report, setPhase);
    else if (opts.mode === "list") await listOnly(client, opts, report, setPhase, state);
    else await hashCheck(client, opts, report, setPhase);
  } catch (error) {
    if (state.timedOut || error instanceof ProbeDeadline) {
      report.timedOut = true;
      report.stoppedInPhase = state.phase;
    } else {
      report.failedInPhase = state.phase;
      Object.assign(report, errorReport(error));
    }
  }
  report.requests = { started: state.started, done: state.done };
  report.seconds = Number(((Date.now() - state.startedAt) / 1000).toFixed(1));
  report.timedOut = Boolean(report.timedOut || state.timedOut);
  return report;
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  main(process.argv.slice(2))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.timedOut) process.exitCode = 2;
      else if (report.error) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof GpexeClientError ? `${error.code}: ${safeMessage(error)}` : safeMessage(error));
      process.exitCode = 1;
    });
}
