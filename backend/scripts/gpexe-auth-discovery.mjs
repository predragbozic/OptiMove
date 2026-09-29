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
//   --auth-scheme    the header scheme word step A reported (default Token);
//                    modes token and exchange send exactly this one scheme,
//                    never try another, never fall back.
//   --token-field    the name of the field the exchange answer carries the
//                    token in (default token); only that field is read.
//   --mode exchange  GPEXE_USERNAME + GPEXE_PASSWORD in the environment: one
//                    POST to the exchange endpoint; the returned token is used
//                    for one GET of the team list and then dropped. If
//                    GPEXE_API_TOKEN is also set the script only says whether
//                    the exchanged token EQUALS it (true/false), which answers
//                    "one stable token per account vs a new token per login".
//
// Safety: the host comes only from a discovery profile in this file (a key,
// never a URL): e03 from the application's approved catalog in
// backend/src/sourceHosts.js, server3 as a discovery-only profile with its
// exact URL and its own API family (rest/v1); every path is relative to
// that host and carries that family's prefix; redirects are never followed; each request has a timeout; no
// database is opened; nothing is written anywhere; the process exits 0 even
// when GPEXE refuses, because a refusal IS a finding.
import { pathToFileURL } from "node:url";
import { resolvableHostKeys, sourceHost } from "../src/sourceHosts.js";

export const DISCOVERY_SOURCE = "gpexe";

// One PROFILE per host key. A host key alone never implies paths: each
// profile names its exact base URL, its API family (the path prefix every
// data request uses), its exchange path and its auth scheme. Changing the
// host never silently changes the family, and a family is never tried on a
// host whose profile does not name it.
//   e03      the host the application's catalog approves; base URL taken
//            from backend/src/sourceHosts.js; family "api".
//   server3  DISCOVERY ONLY: not in the application's allowlist and not in
//            the database catalog. The owner confirmed (2026-09-29) that
//            their existing integration reads this account through
//            server3 /rest/v1/ after POST /api-token-auth/. The exact URL
//            is fixed here; no option can change it.
export const DISCOVERY_PROFILES = Object.freeze({
  // exchangeStopped: the owner stopped every credential exchange on e03
  // (2026-09-29) after one refused attempt; mode exchange refuses this host.
  e03: Object.freeze({ appApproved: true, exchangeStopped: true, baseUrl: null, apiFamily: "api", apiPrefix: "api/", exchangePath: "api-token-auth/", exchangeCandidates: Object.freeze(["api-token-auth/", "api/api-token-auth/", "api/token/"]), thresholds: true }),
  server3: Object.freeze({ appApproved: false, exchangeStopped: false, baseUrl: "https://server3.gpexe.com/", apiFamily: "rest_v1", apiPrefix: "rest/v1/", exchangePath: "api-token-auth/", exchangeCandidates: Object.freeze(["api-token-auth/", "rest/v1/api-token-auth/"]), thresholds: false }),
});
const EXACT_HTTPS_HOST = /^https:\/\/[a-z0-9.-]+\/$/;
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
  const opts = { mode: "anon", host: "e03", team: "980", exchangePath: null, authScheme: "Token", tokenField: "token", apiFamily: null, bodyEncoding: "json" };
  const names = { "--mode": "mode", "--host": "host", "--team": "team", "--exchange-path": "exchangePath", "--auth-scheme": "authScheme", "--token-field": "tokenField", "--api-family": "apiFamily", "--body-encoding": "bodyEncoding" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!names[key] || value === undefined) throw new DiscoveryUsageError(`unknown or incomplete argument ${key}`);
    opts[names[key]] = value;
  }
  if (!["anon", "token", "exchange"].includes(opts.mode)) throw new DiscoveryUsageError("--mode must be anon, token or exchange");
  if (!/^(0|[1-9][0-9]{0,11})$/.test(opts.team)) throw new DiscoveryUsageError("--team must be a canonical GPEXE team id");
  if (!/^[a-z0-9]{1,16}$/.test(opts.host)) throw new DiscoveryUsageError("--host is a catalog KEY (for example e03), never a URL");
  if (opts.exchangePath !== null && !/^[a-z0-9_\-/]{1,64}\/$/.test(opts.exchangePath)) throw new DiscoveryUsageError("--exchange-path must be a relative path ending in / (letters, digits, - _ /)");
  // One RFC 7235 scheme token, exactly as step A reported it: a word, no
  // space, no colon, no quotes, at most 32 characters. Only this scheme is
  // sent; a wrong word gives a 401 finding, never a second attempt.
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(opts.authScheme)) throw new DiscoveryUsageError("--auth-scheme must be one scheme word (for example Token or Bearer)");
  // One top-level JSON field name of the exchange answer.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(opts.tokenField)) throw new DiscoveryUsageError("--token-field must be one field name (for example token or access_token)");
  if (opts.apiFamily !== null && !["api", "rest_v1"].includes(opts.apiFamily)) throw new DiscoveryUsageError("--api-family must be api or rest_v1");
  // How the exchange body is written on the wire: json, or form
  // (application/x-www-form-urlencoded, what the owner's working integration
  // sends). Exactly one per run; the other is never tried.
  if (!["json", "form"].includes(opts.bodyEncoding)) throw new DiscoveryUsageError("--body-encoding must be json or form");
  return opts;
}

// The only host resolver: a key with a profile above, nothing else — never
// a URL, never an unknown key. For a host the application approves the base
// URL comes from the application's own catalog; for a discovery-only host
// it is the exact URL of its profile, and the application still does not
// know the key (checked, so the two lists cannot drift silently).
export function discoveryProfile(hostKey, apiFamily = null) {
  const profile = typeof hostKey === "string" && Object.prototype.hasOwnProperty.call(DISCOVERY_PROFILES, hostKey) ? DISCOVERY_PROFILES[hostKey] : null;
  if (!profile) {
    throw new DiscoveryUsageError(`host key ${JSON.stringify(hostKey)} has no discovery profile; keys: ${Object.keys(DISCOVERY_PROFILES).join(", ")}`);
  }
  const inApp = resolvableHostKeys(DISCOVERY_SOURCE).includes(hostKey);
  if (profile.appApproved !== inApp) {
    throw new DiscoveryUsageError(`host key ${hostKey}: the discovery profile and the application's allowlist disagree; fix the profile before any request`);
  }
  const baseUrl = profile.appApproved ? sourceHost(DISCOVERY_SOURCE, hostKey).baseUrl : profile.baseUrl;
  if (!EXACT_HTTPS_HOST.test(baseUrl)) throw new DiscoveryUsageError(`host key ${hostKey}: the base URL must be an exact https host`);
  if (apiFamily !== null && apiFamily !== profile.apiFamily) {
    throw new DiscoveryUsageError(`host key ${hostKey} speaks the ${profile.apiFamily} family; ${apiFamily} is not tried on it (a host never implies another family's paths)`);
  }
  return { ...profile, hostKey, baseUrl };
}

export function discoveryBaseUrl(hostKey) {
  return discoveryProfile(hostKey).baseUrl;
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

export async function probe({ fetchImpl, baseUrl, method, path, token = null, authScheme = "Token", jsonBody = undefined, bodyEncoding = "json", teamId }) {
  const url = new URL(path, baseUrl);
  if (!url.href.startsWith(baseUrl)) throw new DiscoveryUsageError("a path may not leave the approved host");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `${authScheme} ${token}`;
  const form = bodyEncoding === "form";
  if (jsonBody !== undefined) headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
  const wireBody = jsonBody === undefined ? undefined : form ? new URLSearchParams(jsonBody).toString() : JSON.stringify(jsonBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const entry = { method, path: maskPath(path, teamId), authenticated: Boolean(token) };
  if (jsonBody !== undefined) entry.bodyEncoding = form ? "form" : "json";
  try {
    const res = await fetchImpl(url.href, { method, headers, body: wireBody, redirect: "manual", signal: controller.signal });
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

export async function runDiscovery({ mode, host, team, exchangePath, authScheme = "Token", tokenField = "token", apiFamily = null, bodyEncoding = "json" }, env, fetchImpl = globalThis.fetch) {
  const profile = discoveryProfile(host, apiFamily);
  // An exchange path is one of the profile's known candidates, never a
  // resource path: a credential is never POSTed anywhere else on the host.
  if (exchangePath !== null && exchangePath !== undefined && !profile.exchangeCandidates.includes(exchangePath)) {
    throw new DiscoveryUsageError(`--exchange-path ${JSON.stringify(exchangePath)} is not an exchange path of host ${host}; known: ${profile.exchangeCandidates.join(", ")}`);
  }
  if (mode === "exchange" && profile.exchangeStopped) {
    throw new DiscoveryUsageError(`credential exchange on host ${host} is stopped by the owner's decision; nothing was sent`);
  }
  const baseUrl = profile.baseUrl;
  const api = profile.apiPrefix;
  const today = new Date().toISOString().slice(0, 10);
  const report = {
    source: DISCOVERY_SOURCE, hostKey: host, apiFamily: profile.apiFamily, apiPrefix: api, discoveryOnlyHost: !profile.appApproved,
    mode, teamId: team, authScheme, tokenField, ranAt: new Date().toISOString(), requests: [], findings: {},
  };
  const push = async (args) => {
    const entry = await probe({ fetchImpl, baseUrl, teamId: team, authScheme, bodyEncoding, ...args });
    report.requests.push(strip(entry));
    return entry;
  };

  if (mode === "anon") {
    const root = await push({ method: "GET", path: api });
    const teams = await push({ method: "GET", path: `${api}team/` });
    await push({ method: "GET", path: `${api}team_session/?team=${team}&limit=1` });
    await push({ method: "OPTIONS", path: `${api}team/` });
    // Where is the exchange endpoint, if any? An EMPTY body only reveals the
    // field names the endpoint expects; no credential is involved.
    const candidates = exchangePath ? [exchangePath] : profile.exchangeCandidates;
    for (const p of candidates) await push({ method: "POST", path: p, jsonBody: {} });
    report.findings = {
      apiDemandsScheme: teams.authScheme ?? root.authScheme ?? null,
      unauthenticatedStatusOnTeamList: teams.status ?? null,
      // An EMPTY POST can only show the REQUEST fields the endpoint requires
      // (username, password); it says nothing about the field a successful
      // answer carries the token in.
      exchangeEndpoints: report.requests.filter((r) => r.method === "POST").map((r) => ({ path: r.path, status: r.status ?? null, requestFieldNames: r.fieldNames ?? [] })),
    };
  }

  if (mode === "token") {
    const token = env.GPEXE_API_TOKEN;
    if (!token) throw new DiscoveryUsageError("GPEXE_API_TOKEN is not set in this terminal (mode token)");
    const teams = await push({ method: "GET", path: `${api}team/`, token });
    const one = await push({ method: "GET", path: `${api}team/${team}/`, token });
    // Thresholds are only known to exist in the api family.
    if (profile.thresholds) await push({ method: "GET", path: `${api}team/${team}/thresholds/?valid_on=${today}`, token });
    await push({ method: "GET", path: `${api}team_session/?team=${team}&limit=1`, token });
    const optTeam = await push({ method: "OPTIONS", path: `${api}team/`, token });
    const optSession = await push({ method: "OPTIONS", path: `${api}team_session/`, token });
    const optAthlete = await push({ method: "OPTIONS", path: `${api}athlete_session/`, token });
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
    const path = exchangePath ?? profile.exchangePath;
    const ex = await push({ method: "POST", path, jsonBody: { username, password } });
    // Only the named field is read; a token under another name is reported as
    // "no token field" (its NAME still appears in fieldNames), never guessed.
    const body = ex._body && typeof ex._body === "object" && !Array.isArray(ex._body) ? ex._body : null;
    const issued = body && Object.prototype.hasOwnProperty.call(body, tokenField) && typeof body[tokenField] === "string" && body[tokenField] ? body[tokenField] : null;
    const findings = {
      exchangeStatus: ex.status ?? null,
      // The NAMES of a successful answer's fields, so the owner can confirm
      // the token field from documentation and repeat step C once with it.
      successResponseFieldNames: ex.status >= 200 && ex.status < 300 ? (ex.fieldNames ?? []) : null,
      tokenFieldUsed: tokenField,
      exchangeReturnsTokenField: Boolean(issued),
      // A 2xx answer without the named field: the answer is dropped here,
      // unread beyond its field names; nothing is guessed, no GET follows.
      successWithoutNamedField: ex.status >= 200 && ex.status < 300 && !issued,
      exchangedTokenWorksAsScheme: null,
      exchangedTokenEqualsEnvToken: null,
    };
    if (issued) {
      // Three read-only GETs with the issued token, then it is dropped: the
      // team list, the team itself, one page of one session row.
      const teams = await push({ method: "GET", path: `${api}team/`, token: issued });
      const one = await push({ method: "GET", path: `${api}team/${team}/`, token: issued });
      const page = await push({ method: "GET", path: `${api}team_session/?team=${team}&limit=1`, token: issued });
      findings.exchangedTokenWorksAsScheme = [teams.status, one.status, page.status].some((st) => st === 200);
      const pageRows = page.arrayLength ?? page.resultsLength ?? null;
      findings.teamListEndpoint = teams.status === 200 ? "exists" : teams.status === 404 ? "absent" : `status ${teams.status ?? "error"}`;
      findings.teamCount = teams.status === 200 ? (teams.arrayLength ?? teams.count ?? teams.resultsLength ?? null) : null;
      findings.teamStatus = one.status ?? null;
      findings.sessionPageStatus = page.status ?? null;
      // Supporting evidence only: a 200 page may be empty, or the server may
      // ignore the team filter; neither proves access to the team.
      findings.sessionPageHasRows = page.status === 200 && pageRows !== null ? pageRows > 0 : null;
      // Access to the team is proven only by the team list naming it or by
      // the team's own read. A first list page without it proves nothing, so
      // "false" needs the team's own read refused; anything else is unknown.
      findings.seesTeam = teams.containsTeam === true || one.status === 200
        ? true
        : [403, 404].includes(one.status) && teams.containsTeam !== true && teams.status === 200 ? false : null;
      if (env.GPEXE_API_TOKEN) findings.exchangedTokenEqualsEnvToken = issued === env.GPEXE_API_TOKEN;
    }
    report.findings = findings;
    // The issued token is the one secret the environment guard cannot know.
    if (issued && JSON.stringify(report).includes(issued)) {
      const error = new Error("refusing to return: the report would contain the issued token");
      error.code = "secret_in_report";
      throw error;
    }
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
