// Owner-run, read-only discovery of the GPEXE server-to-server authentication
// contract (F3c2 discovery; docs/ai/source-connections-f3c2-contract.md,
// section 1). It answers the open questions of the F3c discovery document,
// section 8b, WITHOUT ever printing a credential:
//
//   * which approved host issues the server-to-server credential;
//   * whether that credential is an official API token or one obtained from a
//     controlled username/password exchange, and the exact auth endpoint;
//   * the header scheme (the WWW-Authenticate scheme word);
//   * whether the dedicated account sees Team ID 980;
//   * whether a read-only team-list endpoint exists;
//   * the smallest scope the account needs (which methods each resource allows).
//
// What it prints, and nothing else: the host key, each request's method and
// masked path, the HTTP status, the auth scheme word, the Allow header, the
// response's content type and shape (array / object), the top-level FIELD
// NAMES, the array length, the X-Total-Count header, whether the team list
// contains the team asked for, and a few booleans. Never a value from a body,
// never a header value outside that fixed list, never anything from the
// environment. Errors print an error name and code only, never the server's
// text.
//
// Modes (see the runbook for the exact PowerShell lines):
//   --mode anon      no credential at all: which auth scheme the API demands
//                    and whether an exchange endpoint exists (an EMPTY POST
//                    only shows the field names the endpoint expects).
//   --mode token     GPEXE_API_TOKEN in the environment (an official API
//                    token pasted by the owner): the team list, the team, its
//                    thresholds, one session-list page, and the methods each
//                    resource allows (OPTIONS).
//   --mode exchange  GPEXE_USERNAME + GPEXE_PASSWORD in the environment: one
//                    POST to the exchange endpoint; the returned token is used
//                    for one GET of the team list and then dropped. If
//                    GPEXE_API_TOKEN is also set the script only says whether
//                    the exchanged token EQUALS it (true/false), which answers
//                    "one stable token per account vs a new token per login".
//
// Safety: the host comes only from the approved catalog in
// backend/src/sourceHosts.js (key, never a URL); every path is relative to
// that host; redirects are never followed; each request has a timeout; no
// database is opened; nothing is written anywhere; the process exits 0 even
// when GPEXE refuses, because a refusal IS a finding.
import { pathToFileURL } from "node:url";
import { resolvableHostKeys, sourceHost } from "../src/sourceHosts.js";

export const DISCOVERY_SOURCE = "gpexe";
export const REQUEST_TIMEOUT_MS = 30_000;
// Header VALUES that may be printed. Everything else is reduced to its name.
const PRINTABLE_HEADERS = new Set(["content-type", "allow", "x-total-count", "x-gpexe-version"]);

export class DiscoveryUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryUsageError";
  }
}

export function parseArgs(argv) {
  const opts = { mode: "anon", host: "e03", team: "980", exchangePath: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--mode", "--host", "--team", "--exchange-path"].includes(key) || value === undefined) throw new DiscoveryUsageError(`unknown or incomplete argument ${key}`);
    if (key === "--exchange-path") opts.exchangePath = value;
    else opts[key.slice(2)] = value;
  }
  if (!["anon", "token", "exchange"].includes(opts.mode)) throw new DiscoveryUsageError("--mode must be anon, token or exchange");
  if (!/^(0|[1-9][0-9]{0,11})$/.test(opts.team)) throw new DiscoveryUsageError("--team must be a canonical GPEXE team id");
  if (!/^[a-z0-9]{1,16}$/.test(opts.host)) throw new DiscoveryUsageError("--host is a catalog KEY (for example e03), never a URL");
  if (opts.exchangePath !== null && !/^[a-z0-9_\-/]{1,64}\/$/.test(opts.exchangePath)) throw new DiscoveryUsageError("--exchange-path must be a relative path ending in / (letters, digits, - _ /)");
  return opts;
}

// The only host resolver: an approved key of the code catalog, nothing else.
// The database catalog cannot be read here (no database is opened), so this
// script is stricter than the application, not looser: server3 is refused.
export function discoveryBaseUrl(hostKey) {
  if (!resolvableHostKeys(DISCOVERY_SOURCE).includes(hostKey)) {
    throw new DiscoveryUsageError(`host key ${JSON.stringify(hostKey)} is not approved; approved keys: ${resolvableHostKeys(DISCOVERY_SOURCE).join(", ")}`);
  }
  return sourceHost(DISCOVERY_SOURCE, hostKey).baseUrl;
}

// A path with every id replaced, so the report never carries a session or
// athlete id; the team id asked for is the one exception and is printed once
// at the top of the report.
export function maskPath(path, teamId) {
  return path
    .split(teamId).join("<team>")
    .replace(/valid_on=\d{4}-\d{2}-\d{2}/, "valid_on=<date>")
    .replace(/\b\d{3,}\b/g, "<id>");
}

function schemeWord(wwwAuthenticate) {
  if (typeof wwwAuthenticate !== "string" || !wwwAuthenticate.trim()) return null;
  const word = wwwAuthenticate.trim().split(/[\s,]+/)[0];
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(word) ? word : "<unprintable>";
}

function fieldNames(value) {
  if (Array.isArray(value)) return value.length && value[0] && typeof value[0] === "object" ? Object.keys(value[0]).sort() : [];
  if (value && typeof value === "object") return Object.keys(value).sort();
  return [];
}

// Describes one response by names, shapes and counts only.
export function describeResponse(res, body, { teamId } = {}) {
  const headerNames = [];
  const printable = {};
  if (res.headers && typeof res.headers.forEach === "function") {
    res.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      headerNames.push(name);
      if (PRINTABLE_HEADERS.has(name)) printable[name] = String(v).slice(0, 80);
    });
  }
  headerNames.sort();
  const out = {
    status: res.status,
    authScheme: schemeWord(typeof res.headers?.get === "function" ? res.headers.get("www-authenticate") : null),
    allow: printable.allow ?? null,
    contentType: printable["content-type"] ?? null,
    totalCount: printable["x-total-count"] ?? null,
    gpexeVersion: printable["x-gpexe-version"] ?? null,
    bodyKind: Array.isArray(body) ? "array" : body && typeof body === "object" ? "object" : body === undefined ? "none" : "other",
    fieldNames: fieldNames(body),
    arrayLength: Array.isArray(body) ? body.length : null,
    headerNames,
  };
  if (body && typeof body === "object" && !Array.isArray(body) && Array.isArray(body.results)) {
    out.resultsLength = body.results.length;
    out.resultFieldNames = fieldNames(body.results);
    out.count = typeof body.count === "number" ? body.count : null;
  }
  if (teamId) {
    const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
    if (rows) out.containsTeam = rows.some((r) => r && String(r.id) === String(teamId));
  }
  return out;
}

async function readBody(res) {
  const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") ?? "" : "";
  if (!/json/i.test(type)) return undefined;
  try {
    return await res.json();
  } catch {
    return "unparseable";
  }
}

export async function probe({ fetchImpl, baseUrl, method, path, token = null, jsonBody = undefined, teamId }) {
  const url = new URL(path, baseUrl);
  if (!url.href.startsWith(baseUrl)) throw new DiscoveryUsageError("a path may not leave the approved host");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Token ${token}`;
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const entry = { method, path: maskPath(path, teamId), authenticated: Boolean(token) };
  try {
    const res = await fetchImpl(url.href, { method, headers, body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody), redirect: "manual", signal: controller.signal });
    if (res.status >= 300 && res.status < 400) return { ...entry, status: res.status, redirected: true, note: "redirect not followed" };
    const body = await readBody(res);
    return { ...entry, ...describeResponse(res, body, { teamId }), _body: body };
  } catch (e) {
    // undici puts the useful code (ENOTFOUND, ECONNREFUSED, a TLS code) in error.cause.code.
    return { ...entry, error: e?.name === "AbortError" ? "timeout" : (e?.code || e?.cause?.code || e?.name || "error") };
  } finally {
    clearTimeout(timer);
  }
}

const strip = (entry) => {
  const { _body, ...rest } = entry;
  return rest;
};

export async function runDiscovery({ mode, host, team, exchangePath }, env, fetchImpl = globalThis.fetch) {
  const baseUrl = discoveryBaseUrl(host);
  const today = new Date().toISOString().slice(0, 10);
  const report = { source: DISCOVERY_SOURCE, hostKey: host, mode, teamId: team, ranAt: new Date().toISOString(), requests: [], findings: {} };
  const push = async (args) => {
    const entry = await probe({ fetchImpl, baseUrl, teamId: team, ...args });
    report.requests.push(strip(entry));
    return entry;
  };

  if (mode === "anon") {
    const root = await push({ method: "GET", path: "api/" });
    const teams = await push({ method: "GET", path: "api/team/" });
    await push({ method: "GET", path: `api/team_session/?team=${team}&limit=1` });
    await push({ method: "OPTIONS", path: "api/team/" });
    // Where is the exchange endpoint, if any? An EMPTY body only reveals the
    // field names the endpoint expects; no credential is involved.
    const candidates = exchangePath ? [exchangePath] : ["api-token-auth/", "api/api-token-auth/", "api/token/"];
    for (const p of candidates) await push({ method: "POST", path: p, jsonBody: {} });
    report.findings = {
      apiDemandsScheme: teams.authScheme ?? root.authScheme ?? null,
      unauthenticatedStatusOnTeamList: teams.status ?? null,
      exchangeEndpoints: report.requests.filter((r) => r.method === "POST").map((r) => ({ path: r.path, status: r.status ?? null, fieldNames: r.fieldNames ?? [] })),
    };
  }

  if (mode === "token") {
    const token = env.GPEXE_API_TOKEN;
    if (!token) throw new DiscoveryUsageError("GPEXE_API_TOKEN is not set in this terminal (mode token)");
    const teams = await push({ method: "GET", path: "api/team/", token });
    const one = await push({ method: "GET", path: `api/team/${team}/`, token });
    await push({ method: "GET", path: `api/team/${team}/thresholds/?valid_on=${today}`, token });
    await push({ method: "GET", path: `api/team_session/?team=${team}&limit=1`, token });
    const optTeam = await push({ method: "OPTIONS", path: "api/team/", token });
    const optSession = await push({ method: "OPTIONS", path: "api/team_session/", token });
    const optAthlete = await push({ method: "OPTIONS", path: "api/athlete_session/", token });
    report.findings = {
      tokenAccepted: [teams.status, one.status].some((s) => s === 200),
      teamListEndpoint: teams.status === 200 ? "exists" : teams.status === 404 ? "absent" : `status ${teams.status ?? "error"}`,
      teamCount: teams.status === 200 ? (teams.arrayLength ?? teams.count ?? teams.resultsLength ?? null) : null,
      // The list is header-paged: a first page without the team proves nothing; the team's own GET does.
      seesTeam: teams.containsTeam === true || one.status === 200 ? true : teams.containsTeam === false && [403, 404].includes(one.status) ? false : null,
      allowedMethods: { team: optTeam.allow ?? null, teamSession: optSession.allow ?? null, athleteSession: optAthlete.allow ?? null },
    };
  }

  if (mode === "exchange") {
    const username = env.GPEXE_USERNAME;
    const password = env.GPEXE_PASSWORD;
    if (!username || !password) throw new DiscoveryUsageError("GPEXE_USERNAME and GPEXE_PASSWORD are not both set in this terminal (mode exchange)");
    const path = exchangePath ?? "api-token-auth/";
    const ex = await push({ method: "POST", path, jsonBody: { username, password } });
    const issued = ex._body && typeof ex._body === "object" && typeof ex._body.token === "string" ? ex._body.token : null;
    const findings = {
      exchangeStatus: ex.status ?? null,
      exchangeReturnsTokenField: Boolean(issued),
      exchangedTokenWorksAsTokenScheme: null,
      exchangedTokenEqualsEnvToken: null,
    };
    if (issued) {
      const teams = await push({ method: "GET", path: "api/team/", token: issued });
      findings.exchangedTokenWorksAsTokenScheme = teams.status === 200;
      findings.seesTeam = teams.containsTeam ?? null;
      if (env.GPEXE_API_TOKEN) findings.exchangedTokenEqualsEnvToken = issued === env.GPEXE_API_TOKEN;
    }
    report.findings = findings;
  }
  return report;
}

// A last guard on the way out: nothing that was in the environment may appear
// in the printed report, whatever a future edit of the code above does.
export function assertNoSecretInReport(report, env) {
  const text = JSON.stringify(report);
  for (const name of ["GPEXE_API_TOKEN", "GPEXE_USERNAME", "GPEXE_PASSWORD"]) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0 && text.includes(value)) {
      const error = new Error(`refusing to print: the report would contain the value of ${name}`);
      error.code = "secret_in_report";
      throw error;
    }
  }
  return text;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runDiscovery(opts, process.env);
  process.stdout.write(`${assertNoSecretInReport(report, process.env)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Never the server's text, never an environment value: name and code only.
    process.stderr.write(`${e?.name || "Error"}${e instanceof DiscoveryUsageError ? `: ${e.message}` : e?.code ? ` (${e.code})` : ""}\n`);
    process.exit(1);
  });
}
