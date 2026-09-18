// Read-only probe of the real GPEXE API, for the owner to run in their own
// terminal before the in-app import (phase F1) is called ready. It exercises
// the app's own client (backend/src/gpexeClient.js) and prints only the SHAPE
// of what GPEXE answers — never a name, an athlete id, a value, or the token:
//
//   * how a list is paged (plain array + X-Total-Count + Link, or
//     {count, next, results}), whether the next page stays inside the API;
//   * whether the whole session list and one session's athlete rows are read
//     complete through every page;
//   * whether the same session fetched twice gives the same content hash
//     (a hash that changes on unchanged data would make every check a
//     "change");
//   * what the importer would make of that session: counts only.
//
// No database connection is opened and nothing is written anywhere.
//
// PowerShell (the token stays in your own terminal):
//   $env:GPEXE_API_TOKEN = $env:GPEXE_TOKEN
//   node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-01 --to 2026-09-17
//   node backend/scripts/gpexe-api-probe.mjs --team 980 --from 2026-09-14 --to 2026-09-14 --session 186942
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createGpexeClient, GPEXE_API_BASE, GpexeClientError } from "../src/gpexeClient.js";
import { buildGpexeImportPlan, GpexeMappingError } from "../src/gpexeImportMapper.js";
import { canonicalJson, sha256Hex } from "../src/gpexeImportPreview.js";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--team", "--from", "--to", "--session"].includes(key) || value === undefined) throw new Error(`unknown or incomplete argument ${key}`);
    opts[key.slice(2)] = value;
  }
  for (const k of ["team", "from", "to"]) if (!opts[k]) throw new Error(`--${k} is required`);
  for (const k of ["team", "session"]) if (opts[k] !== undefined && !/^[0-9]{1,12}$/.test(opts[k])) throw new Error(`--${k} must be a numeric GPEXE id`);
  for (const k of ["from", "to"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new Error(`--${k} must be YYYY-MM-DD`);
  return opts;
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

// Paths whose content differs between two fetches of the same session: keys
// only, no values, and every key that is an id (athlete, athlete_session,
// track, drill index maps) is printed as <id>.
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

function countBy(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}

export async function main(argv, { client = null } = {}) {
  const opts = parseArgs(argv);
  client = client ?? createGpexeClient();
  const report = { team: opts.team, window: { from: opts.from, to: opts.to } };

  // 1. The raw first page of the session list, as GPEXE sends it.
  const lookFrom = new Date(Date.parse(`${opts.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const firstPage = await client.request(`team_session/?team=${opts.team}&start_timestamp_gte=${lookFrom}%2000:00:00&start_timestamp_lte=${opts.to}%2023:59:59&limit=100`);
  report.sessionListFirstPage = pageShape(firstPage);

  // 2. The whole list through the app's own paging rules.
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
    if (!opts.session) opts.session = sessions.find((s) => s.categoryName === "FULL TRAINING")?.id ?? sessions[0]?.id;
  } catch (error) {
    report.sessionList = { complete: false, error: error instanceof GpexeClientError ? error.code : error.name, message: safeMessage(error) };
  }

  // 3. One session: its athlete rows' paging, and whether two fetches hash alike.
  if (opts.session) {
    const athletePage = await client.request(`athlete_session/?teamsession=${opts.session}&limit=100`);
    report.athleteRowsFirstPage = pageShape(athletePage);
    try {
      const first = await client.fetchSessionBundle({ gpexeTeamId: opts.team, sessionId: opts.session });
      const second = await client.fetchSessionBundle({ gpexeTeamId: opts.team, sessionId: opts.session });
      const h1 = sha256Hex(canonicalJson(first));
      const h2 = sha256Hex(canonicalJson(second));
      report.session = {
        id: opts.session,
        athleteRows: first.athleteSessions.length,
        tracks: Object.keys(first.tracks).length,
        drillsFetched: Object.keys(first.details.drills).length,
        thresholdsFound: first.teamThresholds !== null,
        sameHashOnTwoFetches: h1 === h2,
        pathsThatChangedBetweenFetches: h1 === h2 ? [] : differingPaths(first, second),
      };
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
    } catch (error) {
      report.session = { id: opts.session, error: error instanceof GpexeClientError ? error.code : error.name, message: safeMessage(error) };
    }
  }
  return report;
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  main(process.argv.slice(2))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error instanceof GpexeClientError ? `${error.code}: ${error.message}` : error.message);
      process.exitCode = 1;
    });
}
