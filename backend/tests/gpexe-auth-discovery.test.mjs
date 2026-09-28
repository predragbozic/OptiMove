// The owner-run GPEXE auth discovery script never touches a network here:
// every test drives it with a fake fetch and checks WHAT it would print.
// No database, no environment secret, no request leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoSecretInReport, describeResponse, discoveryBaseUrl, DiscoveryUsageError, maskPath, parseArgs, runDiscovery,
} from "../scripts/gpexe-auth-discovery.mjs";

const FAKE_TOKEN = "FAKE-TOKEN-0123456789abcdef-not-real";
const FAKE_USER = "fake.user@example.invalid";
const FAKE_PASSWORD = "Fake-Password-not-real-42";
const ISSUED = "FAKE-ISSUED-TOKEN-fedcba9876543210-not-real";

function fakeResponse(status, body, headers = {}) {
  const h = new Headers(headers);
  return {
    status,
    headers: h,
    json: async () => body,
  };
}

// A fake GPEXE: records every request, demands the Token scheme, exposes a
// team list, an exchange endpoint, and answers OPTIONS with Allow.
// `scheme` / `tokenField` let the fake stand for a server that speaks Bearer
// and answers the exchange under another field name.
function fakeGpexe({ teams = [{ id: 980, name: "FK Test" }, { id: 12, name: "Other" }], scheme = "Token", tokenField = "token" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect });
    const u = new URL(url);
    const auth = init.headers.Authorization;
    const authed = auth === `${scheme} ${FAKE_TOKEN}` || auth === `${scheme} ${ISSUED}`;
    if (u.pathname === "/api-token-auth/" && init.method === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (!body.username || !body.password) return fakeResponse(400, { username: ["This field is required."], password: ["This field is required."] }, { "content-type": "application/json" });
      if (body.username === FAKE_USER && body.password === FAKE_PASSWORD) return fakeResponse(200, { [tokenField]: ISSUED, token_type: scheme }, { "content-type": "application/json" });
      return fakeResponse(400, { non_field_errors: ["Unable to log in with provided credentials."] }, { "content-type": "application/json" });
    }
    if (u.pathname === "/api/api-token-auth/" || u.pathname === "/api/token/") return fakeResponse(404, { detail: "Not found." }, { "content-type": "application/json" });
    if (!authed) return fakeResponse(401, { detail: "Authentication credentials were not provided." }, { "content-type": "application/json", "www-authenticate": scheme });
    if (init.method === "OPTIONS") return fakeResponse(200, { name: "Team List", renders: [] }, { "content-type": "application/json", allow: u.pathname === "/api/team/" ? "GET, HEAD, OPTIONS" : "GET, POST, HEAD, OPTIONS" });
    if (u.pathname === "/api/team/") return fakeResponse(200, teams, { "content-type": "application/json", "x-total-count": String(teams.length), "x-gpexe-version": "9.11.7" });
    if (u.pathname === "/api/team/980/") return fakeResponse(200, { id: 980, name: "FK Test", secret_note: "should never print" }, { "content-type": "application/json" });
    if (u.pathname === "/api/team/980/thresholds/") return fakeResponse(200, [{ id: 5, valid_from: "2026-01-01" }], { "content-type": "application/json" });
    if (u.pathname === "/api/team_session/") return fakeResponse(200, [{ id: 186942, start_timestamp: "2026-09-14T10:00:00" }], { "content-type": "application/json", "x-total-count": "57", link: `<${u.origin}/api/team_session/?team=980&limit=1&offset=1>; rel="next"` });
    return fakeResponse(404, { detail: "Not found." }, { "content-type": "application/json" });
  };
  return { calls, fetchImpl };
}

test("arguments: host is a key never a URL, team is canonical, mode is one of three, exchange path is relative", () => {
  assert.deepEqual(parseArgs([]), { mode: "anon", host: "e03", team: "980", exchangePath: null, authScheme: "Token", tokenField: "token" });
  assert.throws(() => parseArgs(["--host", "https://e03.gpexe.com/"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--team", "0980"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--mode", "write"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--exchange-path", "https://evil.example/x/"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--exchange-path", "../api-token-auth/"]), DiscoveryUsageError);
  assert.equal(parseArgs(["--exchange-path", "api-token-auth/"]).exchangePath, "api-token-auth/");
  // The scheme and the token field are one word each, exactly as step A reported them.
  assert.equal(parseArgs([]).authScheme, "Token");
  assert.equal(parseArgs([]).tokenField, "token");
  assert.equal(parseArgs(["--auth-scheme", "Bearer", "--token-field", "access_token"]).authScheme, "Bearer");
  for (const bad of ["Token x", "Bearer:", "\"Token\"", "", "Token\nX-Injected: 1", "a".repeat(33)]) assert.throws(() => parseArgs(["--auth-scheme", bad]), DiscoveryUsageError, JSON.stringify(bad));
  for (const bad of ["a.b", "token[0]", "", "9x", "a b"]) assert.throws(() => parseArgs(["--token-field", bad]), DiscoveryUsageError, JSON.stringify(bad));
});

test("a Bearer server with the token under access_token: the given scheme is sent as is, only the named field is read, nothing else is tried", async () => {
  const { calls, fetchImpl } = fakeGpexe({ scheme: "Bearer", tokenField: "access_token" });
  const env = { GPEXE_USERNAME: FAKE_USER, GPEXE_PASSWORD: FAKE_PASSWORD, GPEXE_API_TOKEN: FAKE_TOKEN };
  // Step A's scheme word carried into step C.
  const a = await runDiscovery(parseArgs([]), {}, fetchImpl);
  assert.equal(a.findings.apiDemandsScheme, "Bearer");
  calls.length = 0;
  const report = await runDiscovery(parseArgs(["--mode", "exchange", "--auth-scheme", "Bearer", "--token-field", "access_token"]), env, fetchImpl);
  const text = assertNoSecretInReport(report, env);
  assert.ok(!text.includes(ISSUED));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, `Bearer ${ISSUED}`);
  assert.equal(report.authScheme, "Bearer");
  assert.equal(report.tokenField, "access_token");
  assert.equal(report.findings.exchangeReturnsTokenField, true);
  assert.equal(report.findings.exchangedTokenWorksAsScheme, true);
  assert.deepEqual(report.requests[0].fieldNames, ["access_token", "token_type"]);
  // Step B against the same server with the right scheme.
  calls.length = 0;
  const b = await runDiscovery(parseArgs(["--mode", "token", "--auth-scheme", "Bearer"]), { GPEXE_API_TOKEN: FAKE_TOKEN }, fetchImpl);
  assert.equal(b.findings.tokenAccepted, true);
  assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${FAKE_TOKEN}`));
});

test("a wrong scheme or a wrong token field is a finding, never a retry with another value", async () => {
  const { calls, fetchImpl } = fakeGpexe({ scheme: "Bearer", tokenField: "access_token" });
  // Default Token against a Bearer server: every request 401, exactly one request per path, no second scheme.
  const b = await runDiscovery(parseArgs(["--mode", "token"]), { GPEXE_API_TOKEN: FAKE_TOKEN }, fetchImpl);
  assert.equal(b.findings.tokenAccepted, false);
  assert.ok(calls.every((c) => c.headers.Authorization === `Token ${FAKE_TOKEN}`));
  assert.equal(new Set(calls.map((c) => `${c.method} ${c.url}`)).size, calls.length, "no path was tried twice");
  // Right scheme, default field name: the exchange succeeds but the token is under another name -> reported as no token field, no GET follows.
  calls.length = 0;
  const env = { GPEXE_USERNAME: FAKE_USER, GPEXE_PASSWORD: FAKE_PASSWORD };
  const c = await runDiscovery(parseArgs(["--mode", "exchange", "--auth-scheme", "Bearer"]), env, fetchImpl);
  assertNoSecretInReport(c, env);
  assert.equal(c.findings.exchangeStatus, 200);
  assert.equal(c.findings.exchangeReturnsTokenField, false);
  assert.equal(c.findings.exchangedTokenWorksAsScheme, null);
  assert.equal(calls.length, 1, "the token under another field name is never picked up");
  assert.deepEqual(c.requests[0].fieldNames, ["access_token", "token_type"], "the owner sees the real field name and passes it explicitly");
  assert.ok(!JSON.stringify(c).includes(ISSUED));
});

test("host: only an approved key of the code catalog resolves; server3, a URL and an unknown key are refused before any request", async () => {
  assert.equal(discoveryBaseUrl("e03"), "https://e03.gpexe.com/");
  for (const bad of ["server3", "https://e03.gpexe.com/", "E03", ""]) assert.throws(() => discoveryBaseUrl(bad), DiscoveryUsageError);
  const { calls, fetchImpl } = fakeGpexe();
  await assert.rejects(runDiscovery({ mode: "anon", host: "server3", team: "980", exchangePath: null }, {}, fetchImpl), DiscoveryUsageError);
  assert.equal(calls.length, 0, "no request was sent");
});

test("anon mode: no Authorization header is ever sent, the scheme word and the exchange field names are reported, every request stays on the approved host with redirects manual", async () => {
  const { calls, fetchImpl } = fakeGpexe();
  const report = await runDiscovery(parseArgs([]), {}, fetchImpl);
  assert.ok(calls.length >= 5);
  for (const c of calls) {
    assert.ok(c.url.startsWith("https://e03.gpexe.com/"), c.url);
    assert.equal(c.headers.Authorization, undefined);
    assert.equal(c.redirect, "manual");
  }
  assert.equal(report.findings.apiDemandsScheme, "Token");
  assert.equal(report.findings.unauthenticatedStatusOnTeamList, 401);
  const ex = report.findings.exchangeEndpoints.find((e) => e.path === "api-token-auth/");
  assert.deepEqual(ex, { path: "api-token-auth/", status: 400, fieldNames: ["password", "username"] });
  assert.equal(report.findings.exchangeEndpoints.find((e) => e.path === "api/token/").status, 404);
  // The empty POST carried no credential.
  const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api-token-auth/"));
  assert.equal(post.body, "{}");
});

test("token mode: the token goes only in the Authorization header of requests to the approved host; the report holds status, names, counts and booleans — never a body value, never the token", async () => {
  const { calls, fetchImpl } = fakeGpexe();
  const env = { GPEXE_API_TOKEN: FAKE_TOKEN };
  const report = await runDiscovery(parseArgs(["--mode", "token"]), env, fetchImpl);
  const text = assertNoSecretInReport(report, env);
  assert.ok(!text.includes(FAKE_TOKEN));
  assert.ok(!text.includes("should never print"), "no body value is printed");
  assert.ok(!text.includes("FK Test"), "no team name is printed");
  assert.ok(!text.includes("186942"), "no session id is printed");
  assert.equal(report.findings.tokenAccepted, true);
  assert.equal(report.findings.teamListEndpoint, "exists");
  assert.equal(report.findings.teamCount, 2);
  assert.equal(report.findings.seesTeam, true);
  assert.deepEqual(report.findings.allowedMethods, { team: "GET, HEAD, OPTIONS", teamSession: "GET, POST, HEAD, OPTIONS", athleteSession: "GET, POST, HEAD, OPTIONS" });
  const one = report.requests.find((r) => r.path === "api/team/<team>/");
  assert.deepEqual(one.fieldNames, ["id", "name", "secret_note"], "field NAMES are reported");
  assert.equal(report.requests.find((r) => r.path.startsWith("api/team_session/")).totalCount, "57");
  assert.ok(report.requests.every((r) => r.authenticated === true));
  for (const c of calls) {
    assert.ok(c.url.startsWith("https://e03.gpexe.com/"));
    assert.equal(c.headers.Authorization, `Token ${FAKE_TOKEN}`);
    assert.ok(!c.url.includes(FAKE_TOKEN), "the token is never in a URL");
  }
  // The thresholds date and the team id are masked in the printed path.
  assert.ok(report.requests.some((r) => r.path === "api/team/<team>/thresholds/?valid_on=<date>"));
});

test("token mode without the variable refuses before any request", async () => {
  const { calls, fetchImpl } = fakeGpexe();
  await assert.rejects(runDiscovery(parseArgs(["--mode", "token"]), {}, fetchImpl), DiscoveryUsageError);
  assert.equal(calls.length, 0);
});

test("exchange mode: username and password go only in the body of one POST to the approved host; the issued token is used once for the team list and never printed; equality with the env token is a boolean only", async () => {
  const { calls, fetchImpl } = fakeGpexe();
  const env = { GPEXE_USERNAME: FAKE_USER, GPEXE_PASSWORD: FAKE_PASSWORD, GPEXE_API_TOKEN: FAKE_TOKEN };
  const report = await runDiscovery(parseArgs(["--mode", "exchange"]), env, fetchImpl);
  const text = assertNoSecretInReport(report, env);
  for (const secret of [FAKE_USER, FAKE_PASSWORD, FAKE_TOKEN, ISSUED]) assert.ok(!text.includes(secret), `report must not contain ${secret.slice(0, 6)}…`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/api-token-auth/"));
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].headers.Authorization, `Token ${ISSUED}`);
  assert.deepEqual(report.findings, {
    exchangeStatus: 200, exchangeReturnsTokenField: true, exchangedTokenWorksAsScheme: true, exchangedTokenEqualsEnvToken: false, seesTeam: true,
  });
  assert.deepEqual(report.requests[0].fieldNames, ["token", "token_type"], "only the NAMES of the fields");
});

test("exchange mode with a refused login reports the status and field names only and sends no second request", async () => {
  const { calls, fetchImpl } = fakeGpexe();
  const env = { GPEXE_USERNAME: FAKE_USER, GPEXE_PASSWORD: "wrong-not-real" };
  const report = await runDiscovery(parseArgs(["--mode", "exchange"]), env, fetchImpl);
  assertNoSecretInReport(report, env);
  assert.equal(calls.length, 1);
  assert.equal(report.findings.exchangeStatus, 400);
  assert.equal(report.findings.exchangeReturnsTokenField, false);
  assert.deepEqual(report.requests[0].fieldNames, ["non_field_errors"]);
  assert.ok(!JSON.stringify(report).includes("Unable to log in"), "the server's text is not printed");
});

test("a redirect is reported and never followed; a hanging request ends as a timeout finding; an unparseable body is a shape, not a value", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/api/") return fakeResponse(302, undefined, { location: "https://elsewhere.example/steal" });
    if (u.pathname === "/api/team/") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => { throw new Error("bad json"); } };
  };
  const report = await runDiscovery(parseArgs([]), {}, fetchImpl);
  assert.equal(report.requests[0].redirected, true);
  assert.equal(report.requests[1].error, "timeout");
  assert.equal(report.requests[2].bodyKind, "other");
  assert.ok(calls.every((u) => u.startsWith("https://e03.gpexe.com/")), "the redirect target was never requested");
});

test("a first team page without the team does not hide a 200 on the team itself; a network failure reports undici's cause code", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `T${i}` }));
  const { fetchImpl } = fakeGpexe({ teams: many });
  const report = await runDiscovery(parseArgs(["--mode", "token"]), { GPEXE_API_TOKEN: FAKE_TOKEN }, fetchImpl);
  assert.equal(report.requests[0].containsTeam, false);
  assert.equal(report.findings.seesTeam, true, "the team's own GET answered 200");
  const failing = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
  const r2 = await runDiscovery(parseArgs([]), {}, failing);
  assert.ok(r2.requests.every((r) => r.error === "ENOTFOUND"));
});

test("the runbook never reads a credential unmasked", async () => {
  const { readFile } = await import("node:fs/promises");
  const doc = await readFile(new URL("../../docs/ai/source-connections-f3c2-contract.md", import.meta.url), "utf8");
  const reads = doc.split(/\r?\n/).filter((l) => /Read-Host/.test(l));
  assert.ok(reads.length >= 3);
  for (const l of reads) assert.match(l, /-AsSecureString/, l);
});

test("the output guard refuses a report that would carry an environment value, whatever produced it", () => {
  const env = { GPEXE_API_TOKEN: FAKE_TOKEN };
  assert.throws(() => assertNoSecretInReport({ oops: `x${FAKE_TOKEN}y` }, env), (e) => e.code === "secret_in_report");
  assert.equal(typeof assertNoSecretInReport({ fine: true }, env), "string");
});

test("describeResponse prints only allowlisted header VALUES; other headers appear by name only", () => {
  const res = fakeResponse(200, { a: 1 }, { "content-type": "application/json", "set-cookie": "sessionid=SECRET-COOKIE", authorization: "Token SECRET", "x-gpexe-version": "9.11.7" });
  const d = describeResponse(res, { a: 1 });
  const text = JSON.stringify(d);
  assert.ok(!text.includes("SECRET"));
  assert.deepEqual(d.headerNames, ["authorization", "content-type", "set-cookie", "x-gpexe-version"]);
  assert.equal(d.gpexeVersion, "9.11.7");
  assert.equal(maskPath("api/athlete_session/?teamsession=186942&limit=1", "980"), "api/athlete_session/?teamsession=<id>&limit=1");
});
