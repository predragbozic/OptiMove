// Contract tests of the read-only GPEXE rest_v1 adapter (F3c2a). Fake fetch
// only: no network, no database, no environment. Every "credential" is a
// marker made up for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_API_FAMILY, createGpexeRestV1Adapter, MAX_ANSWER_BYTES, readBounded, REST_V1_CAPABILITIES, teamScopedPath,
} from "../src/gpexeRestV1Adapter.js";
import { adapterFamilies, createSourceAdapter, SOURCE_ADAPTERS, SourceAdapterError } from "../src/sourceAdapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CREDENTIAL = "MARKER-credential-f3c2a-not-real";
const row = (hostKey, state = "approved") => ({ source_system: "gpexe", host_key: hostKey, state });
const code = (c) => (e) => e instanceof SourceAdapterError ? e.code === c : e.code === c;
const json = { "content-type": "application/json" };

// A body as a stream of byte chunks; `seen` counts what was really pulled and
// whether the reader cancelled. An answer has NO text() and no json(): the
// adapter may only read the stream.
function streamOf(chunks, seen = {}) {
  seen.pulled = 0;
  seen.bytes = 0;
  seen.cancelled = false;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      const chunk = chunks[i];
      i += 1;
      seen.pulled += 1;
      seen.bytes += chunk.byteLength ?? 0;
      return controller.enqueue(chunk);
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
}
const bytesOf = (text) => new TextEncoder().encode(text);
function answer(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: new Headers({ ...json, ...headers }),
    // A fresh stream for every request that gets this answer.
    get body() { return streamOf([bytesOf(text)]); },
    text: async () => { throw new Error("the adapter must not ask for the whole body"); },
    json: async () => { throw new Error("the adapter must not ask for the whole body"); },
  };
}
const streamed = (chunks, headers = {}, seen = {}) => ({
  status: 200,
  headers: new Headers({ ...json, ...headers }),
  body: streamOf(chunks, seen),
  text: async () => { throw new Error("the adapter must not ask for the whole body"); },
});
const without = (object, key) => { const copy = { ...object }; delete copy[key]; return copy; };
const session = (id, team = 980, extra = {}) => ({
  id, team, category_name: "Training", start_timestamp: "2026-09-14T10:00:00", updated_on: "2026-09-14T12:00:00",
  drills_count: 2, drills: [id + 1, id + 2], is_stats_valid: true, notes: "a private note", submitted_by: "someone", ...extra,
});

// A fake server3: the rest/v1 family, Token scheme, records every request.
function fakeServer({ routes = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect });
    const u = new URL(url);
    const key = `${u.pathname}${u.search}`;
    if (routes[key]) return typeof routes[key] === "function" ? routes[key](u, init) : routes[key];
    if (routes[u.pathname]) return typeof routes[u.pathname] === "function" ? routes[u.pathname](u, init) : routes[u.pathname];
    return answer(404, { detail: "Not found." });
  };
  return { calls, fetchImpl };
}
const make = (fetchImpl, over = {}) => createSourceAdapter({
  sourceSystem: "gpexe", hostKey: "server3", catalogRow: row("server3"), credential: CREDENTIAL, boundSourceTeamId: "980",
  fetchImpl, attempts: 1, sleep: async () => {}, ...over,
});

test("1. the adapter is selected by (source, API family): server3 gets the rest_v1 adapter, e03 (api) has none here, nothing is rewritten", () => {
  assert.deepEqual(adapterFamilies("gpexe"), ["rest_v1"]);
  assert.deepEqual(Object.keys(SOURCE_ADAPTERS), ["gpexe"]);
  const { fetchImpl } = fakeServer();
  const a = make(fetchImpl);
  assert.equal(a.apiFamily, "rest_v1");
  assert.equal(a.hostKey, "server3");
  assert.equal(a.boundSourceTeamId, "980");
  assert.equal(ADAPTER_API_FAMILY, "rest_v1");
  assert.throws(() => make(fetchImpl, { hostKey: "e03", catalogRow: row("e03") }), code("adapter_not_available"), "the api family has no adapter in this registry");
  assert.throws(() => createGpexeRestV1Adapter({ hostKey: "e03", catalogRow: row("e03"), credential: CREDENTIAL, boundSourceTeamId: "980", fetchImpl }), code("adapter_not_available"), "the rest_v1 adapter refuses a host of another family");
  for (const source of ["catapult", "", "__proto__", null]) assert.throws(() => make(fetchImpl, { sourceSystem: source }), code("host_not_allowed"));
});

test("2. the gate: without the key's own approved catalog row, an approved host or a usable credential there is no adapter", () => {
  const { calls, fetchImpl } = fakeServer();
  for (const bad of [null, undefined, row("server3", "retired"), row("e03"), { host_key: "server3", state: "approved" }]) {
    assert.throws(() => make(fetchImpl, { catalogRow: bad }), code("host_not_allowed"), JSON.stringify(bad));
  }
  for (const host of ["server4", "https://server3.gpexe.com/", "SERVER3", "", "__proto__"]) assert.throws(() => make(fetchImpl, { hostKey: host, catalogRow: row(host) }), code("host_not_allowed"), host);
  for (const bad of ["", null, undefined, 5, {}, "line\nbreak", "cr\rlf"]) assert.throws(() => make(fetchImpl, { credential: bad }), code("credential_missing"));
  for (const bad of ["", null, undefined, "0980", "980 ", "98o", "-1", "9".repeat(13), {}, ["980"], "980,981", "980&team=981"]) assert.throws(() => make(fetchImpl, { boundSourceTeamId: bad }), code("invalid_bound_team"), JSON.stringify(bad));
  assert.equal(calls.length, 0, "nothing was sent");
});

test("3. every request is a GET to server3 under /rest/v1/, with the Token scheme, redirects manual; the credential is only in the header", async () => {
  const { calls, fetchImpl } = fakeServer({ routes: {
    "/rest/v1/team/980/": answer(200, { id: 980, name: "FK Test" }),
    "/rest/v1/team/": answer(200, [{ id: 12 }, { id: 980 }], { "x-total-count": "8" }),
    "/rest/v1/team_session/": answer(200, [session(186942)], { "x-total-count": "1" }),
  } });
  const a = make(fetchImpl);
  assert.deepEqual(await a.verifyBoundTeam(), { visible: true, sourceTeamId: "980" });
  assert.deepEqual(await a.countVisibleTeams(), { teamCount: 8, boundTeamOnFirstPage: true, firstPageOnly: true });
  const list = await a.listSessions({ limit: 1 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.url), [
    "https://server3.gpexe.com/rest/v1/team/980/",
    "https://server3.gpexe.com/rest/v1/team/",
    "https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=1",
  ]);
  for (const c of calls) {
    assert.equal(c.method, "GET");
    assert.equal(c.body, undefined);
    assert.equal(c.redirect, "manual");
    assert.equal(c.headers.Authorization, `Token ${CREDENTIAL}`);
    assert.ok(!c.url.includes(CREDENTIAL), "never in a URL");
    assert.ok(!new URL(c.url).pathname.startsWith("/api/"), "the api family's paths are never used");
  }
  // What comes back carries no credential and no personal field the importer does not need.
  const text = JSON.stringify(list);
  assert.ok(!text.includes(CREDENTIAL));
  assert.ok(!text.includes("a private note") && !text.includes("someone"));
  assert.deepEqual(list, { total: 1, drillsLeftOut: 0, sessions: [{
    id: "186942", categoryName: "Training", startTimestamp: "2026-09-14T10:00:00", updatedOn: "2026-09-14T12:00:00",
    drillsCount: 2, isStatsValid: true, drillIds: ["186943", "186944"],
  }] });
});

test("4. GET only: the adapter exposes named reads and nothing generic — no request, get, post, put, patch or delete, and no way to pass a method, a URL or a path", async () => {
  const { calls, fetchImpl } = fakeServer({ routes: { "/rest/v1/team/980/": answer(200, { id: 980 }) } });
  const a = make(fetchImpl);
  assert.ok(Object.isFrozen(a));
  const names = Object.keys(a).filter((k) => typeof a[k] === "function").sort();
  assert.deepEqual(names, [
    "capabilities", "countVisibleTeams", "fetchSessionBundle", "getAthleteSession", "getAthleteSessionMore", "getSession", "getSessionDetails",
    "getSessionDrillDetails", "getTeamThresholds", "getTrack", "getUnits", "listAthleteSessions", "listSessionTags", "listSessions",
    "listSessionsByDay", "verifyBoundTeam",
  ]);
  for (const forbidden of ["request", "get", "read", "fetch", "post", "put", "patch", "delete", "send", "call", "getAllPages"]) assert.equal(a[forbidden], undefined, forbidden);
  // An option that tries to carry a method, a URL or a path changes nothing.
  await a.verifyBoundTeam({ method: "POST", url: "https://evil.example/", path: "team/981/", body: "{}" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "https://server3.gpexe.com/rest/v1/team/980/");
  assert.equal(calls[0].body, undefined);
  // The source of the adapter holds no write method and no host.
  const source = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8");
  const body = source.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.deepEqual([...new Set([...body.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]))], ["GET"]);
  assert.doesNotMatch(body, /https?:\/\//, "no URL in the adapter");
  assert.doesNotMatch(body, /gpexe\.com|rest\/v1|"api\/"/, "no host and no family prefix in the adapter");
  assert.equal((body.match(/fetchImpl\(/g) || []).length, 1, "one place talks to the network");
});

test("5. no team can be passed: an option that names a team in any spelling is refused before any request, on every operation", async () => {
  const { calls, fetchImpl } = fakeServer();
  const a = make(fetchImpl);
  const operations = Object.keys(a).filter((k) => typeof a[k] === "function" && k !== "capabilities");
  for (const op of operations) {
    for (const options of [{ team: "981" }, { teamId: "981" }, { team_id: 981 }, { gpexeTeamId: "981" }, { sourceTeamId: "981" }, { TEAM: "981" }, { boundSourceTeamId: "981" }, { teams: ["980", "981"] }]) {
      await assert.rejects(a[op](options), code("team_param_not_allowed"), `${op} ${JSON.stringify(options)}`);
    }
    for (const options of [null, "team=981", ["981"], 981]) await assert.rejects(a[op](options), code("invalid_options"), `${op} ${JSON.stringify(options)}`);
  }
  assert.equal(calls.length, 0, "nothing was sent");
  assert.equal(a.boundSourceTeamId, "980");
  assert.throws(() => { "use strict"; a.boundSourceTeamId = "981"; }, TypeError, "the bound team cannot be changed");
});

test("6. duplicate or conflicting team parameters are refused when a path is built", () => {
  assert.equal(teamScopedPath("team_session/", "980", [["limit", 100]]), "team_session/?team=980&limit=100");
  for (const pairs of [[["team", "981"]], [["team", "980"]], [["limit", 1], ["team", "981"]], [["team_id", "981"]], [["teamsession", "5"]], [["TEAM", "981"]]]) {
    assert.throws(() => teamScopedPath("team_session/", "980", pairs), (e) => ["team_param_not_allowed", "path_not_allowed"].includes(e.code), JSON.stringify(pairs));
  }
  assert.throws(() => teamScopedPath("team_session/", "980", [["limit", 1], ["limit", 2]]), code("duplicate_param"));
  for (const bad of ["981&team=980", "980&team=981", "0980", "", null, "980/../981"]) assert.throws(() => teamScopedPath("team_session/", bad, []), code("invalid_bound_team"), JSON.stringify(bad));
  for (const bad of [[["limit", "1&team=981"]], [["limit", "1#x"]], [["limit", "a b"]], [["li mit", "1"]], [["limit", "../x"]], [["limit", undefined]], [["limit", null]], [["limit", ""]], [["limit", 1.5]], [["limit", {}]], [["limit", ["1"]]]]) assert.throws(() => teamScopedPath("team_session/", "980", bad), code("path_not_allowed"), JSON.stringify(bad));
  for (const bad of ["team_session", "/team_session/", "team_session/../team/", "https://evil.example/", "team/981/", ""]) assert.throws(() => teamScopedPath(bad, "980", []), code("path_not_allowed"), JSON.stringify(bad));
});

test("7. Team 981: an adapter bound to 980 cannot read it, and an adapter bound to 981 reads 981 only — the binding decides, never the caller", async () => {
  const routes = {
    "/rest/v1/team/980/": answer(200, { id: 980 }),
    "/rest/v1/team/981/": answer(200, { id: 981 }),
    "/rest/v1/team_session/": (u) => answer(200, [session(1, Number(u.searchParams.get("team")))], { "x-total-count": "1" }),
  };
  const { calls, fetchImpl } = fakeServer({ routes });
  const a980 = make(fetchImpl);
  await a980.verifyBoundTeam();
  await a980.listSessions({ limit: 5 });
  assert.ok(calls.every((c) => !c.url.includes("981")), "980's adapter never names 981");
  // The same server, a connection bound to 981: it reads 981 only.
  const n = calls.length;
  const a981 = make(fetchImpl, { boundSourceTeamId: "981" });
  assert.deepEqual(await a981.verifyBoundTeam(), { visible: true, sourceTeamId: "981" });
  await a981.listSessions({ limit: 5 });
  assert.equal(calls.length, n + 2);
  assert.ok(calls.slice(n).every((c) => /team[=/]981/.test(c.url) && !/team[=/]980/.test(c.url)), "981's adapter never names 980");
  // The server answers team 981 where 980 was asked: refused.
  const swapped = fakeServer({ routes: { "/rest/v1/team/980/": answer(200, { id: 981, name: "Other team" }) } });
  await assert.rejects(make(swapped.fetchImpl).verifyBoundTeam(), code("source_team_mismatch"));
  // The bound team is not visible with this credential.
  const hidden = fakeServer({ routes: {} });
  await assert.rejects(make(hidden.fetchImpl).verifyBoundTeam(), code("source_team_not_visible"));
  // A 403 on the team is "this credential may not read that team", not "the credential is wrong".
  const forbidden = fakeServer({ routes: { "/rest/v1/team/980/": answer(403, { detail: "You do not have permission." }) } });
  await assert.rejects(make(forbidden.fetchImpl).verifyBoundTeam(), code("source_team_not_visible"));
  const wrong = fakeServer({ routes: { "/rest/v1/team/980/": answer(401, { detail: "Invalid token." }) } });
  await assert.rejects(make(wrong.fetchImpl).verifyBoundTeam(), code("source_auth_rejected"));
});

test("8. a returned session of another team is refused, and nothing of that answer is returned — also when only one row of many is foreign or the team is in an unknown shape", async () => {
  const cases = {
    "a foreign team": [session(1), session(2, 981), session(3)],
    "every row foreign (the filter was ignored)": [session(1, 981), session(2, 981)],
    "the team as a string of another id": [session(1, "981")],
  };
  for (const [what, rows] of Object.entries(cases)) {
    const { fetchImpl } = fakeServer({ routes: { "/rest/v1/team_session/": answer(200, rows, { "x-total-count": String(rows.length) }) } });
    const error = await make(fetchImpl).listSessions({ limit: 10 }).then(() => null, (e) => e);
    assert.ok(error, what);
    assert.equal(error.code, "source_team_mismatch", what);
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes("981"), "the refusal names no foreign team");
  }
  const shapes = {
    "no team at all": [without(session(1), "team")],
    "a null team": [session(1, null)],
    "a team object": [session(1, { id: 980 })],
    "a team URL": [session(1, "https://server3.gpexe.com/rest/v1/team/980/")],
    "a team list": [session(1, [980])],
    "a non-canonical team": [session(1, "0980")],
    "a fractional team": [session(1, 980.5)],
    "a row that is not an object": ["186942"],
    "a row without an id": [without(session(1), "id")],
    "drills in an unknown shape": [session(1, 980, { drills: "1,2" })],
  };
  for (const [what, rows] of Object.entries(shapes)) {
    const { fetchImpl } = fakeServer({ routes: { "/rest/v1/team_session/": answer(200, rows, { "x-total-count": String(rows.length) }) } });
    await assert.rejects(make(fetchImpl).listSessions({ limit: 10 }), code("source_answer_unexpected"), what);
  }
  // The team as the canonical string of the bound id is the bound team.
  const ok = fakeServer({ routes: { "/rest/v1/team_session/": answer(200, [session(1, "980")], { "x-total-count": "1" }) } });
  assert.equal((await make(ok.fetchImpl).listSessions({ limit: 1 })).sessions.length, 1);
});

test("9. a next page is followed only on the same host, family, resource and team; a link that names another team, a second team, another resource or another host is refused", async () => {
  const page = (rows, total, link) => answer(200, rows, { "x-total-count": String(total), ...(link ? { link } : {}) });
  const R = "https://server3.gpexe.com/rest/v1/";
  // Two good pages.
  const good = fakeServer({ routes: {
    "/rest/v1/team_session/?team=980&limit=2": page([session(1), session(4)], 3, `<${R}team_session/?limit=2&offset=2&team=980>; rel="next"`),
    "/rest/v1/team_session/?team=980&limit=2&offset=2": page([session(7)], 3),
  } });
  const list = await make(good.fetchImpl).listSessions({ limit: 2, maxPages: 5 });
  assert.deepEqual(list.sessions.map((s) => s.id), ["1", "4", "7"]);
  assert.equal(list.total, 3);
  assert.deepEqual(good.calls.map((c) => c.url), [`${R}team_session/?team=980&limit=2`, `${R}team_session/?team=980&limit=2&offset=2`]);
  // Fewer pages allowed than the list has: refused, never part of the list.
  const capped = fakeServer({ routes: { "/rest/v1/team_session/?team=980&limit=2": page([session(1), session(4)], 3, `<${R}team_session/?limit=2&offset=2&team=980>; rel="next"`) } });
  await assert.rejects(make(capped.fetchImpl).listSessions({ limit: 2, maxPages: 1 }), code("source_list_incomplete"));
  assert.equal(capped.calls.length, 1);
  const bad = {
    "another team": [`<${R}team_session/?team=981&limit=2&offset=2>; rel="next"`, "source_team_mismatch"],
    "two teams": [`<${R}team_session/?team=980&team=981&limit=2>; rel="next"`, "source_team_mismatch"],
    "the bound team twice": [`<${R}team_session/?team=980&team=980&limit=2>; rel="next"`, "source_team_mismatch"],
    "no team": [`<${R}team_session/?limit=2&offset=2>; rel="next"`, "source_team_mismatch"],
    "a second team key": [`<${R}team_session/?team=980&team_id=981&limit=2>; rel="next"`, "source_team_mismatch"],
    "another resource": [`<${R}athlete_session/?team=980&limit=2>; rel="next"`, "source_answer_unexpected"],
    "another family": [`<https://server3.gpexe.com/api/team_session/?team=980&limit=2>; rel="next"`, "source_answer_unexpected"],
    "another host": [`<https://e03.gpexe.com/rest/v1/team_session/?team=980&limit=2>; rel="next"`, "source_answer_unexpected"],
    "a foreign host": [`<https://evil.example/rest/v1/team_session/?team=980>; rel="next"`, "source_answer_unexpected"],
    "a look-alike host": [`<https://server3.gpexe.com.evil.example/rest/v1/team_session/?team=980>; rel="next"`, "source_answer_unexpected"],
    "a repeated parameter": [`<${R}team_session/?team=980&limit=2&limit=50>; rel="next"`, "source_answer_unexpected"],
    "an encoded value": [`<${R}team_session/?team=980&cursor=a%2Fb>; rel="next"`, "source_answer_unexpected"],
    "a relative link": [`</rest/v1/team_session/?team=980&offset=2>; rel="next"`, "source_answer_unexpected"],
  };
  for (const [what, [link, expected]] of Object.entries(bad)) {
    const s = fakeServer({ routes: { "/rest/v1/team_session/?team=980&limit=2": page([session(1), session(4)], 3, link) } });
    await assert.rejects(make(s.fetchImpl).listSessions({ limit: 2, maxPages: 5 }), code(expected), what);
    assert.equal(s.calls.length, 1, `${what}: the link was never requested`);
  }
});

test("9b. a session named in another session's drills is a drill, not a session of its own (as the e03 importer treats it)", async () => {
  const rows = [session(10, 980, { drills: [11, 12], drills_count: 2 }), session(11, 980, { drills: [] }), session(12, 980, { drills: [] }), session(20, 980, { drills: [] })];
  const { fetchImpl } = fakeServer({ routes: { "/rest/v1/team_session/": answer(200, rows, { "x-total-count": "4" }) } });
  const list = await make(fetchImpl).listSessions({ limit: 10 });
  assert.deepEqual(list.sessions.map((s) => s.id), ["10", "20"]);
  assert.deepEqual(list.sessions[0].drillIds, ["11", "12"]);
  assert.equal(list.total, 4);
  assert.equal(list.drillsLeftOut, 2);
});

test("10. a list is whole or refused: no total, a changing total, a repeated row, more rows than reported, or a body of another shape", async () => {
  const R = "https://server3.gpexe.com/rest/v1/";
  const next = `<${R}team_session/?team=980&limit=1&offset=1>; rel="next"`;
  const cases = {
    "no total": [{ "/rest/v1/team_session/": answer(200, [session(1)]) }, "source_answer_unexpected"],
    "a total that is not a number": [{ "/rest/v1/team_session/": answer(200, [session(1)], { "x-total-count": "many" }) }, "source_answer_unexpected"],
    "an object instead of a list": [{ "/rest/v1/team_session/": answer(200, { count: 1, results: [session(1)] }, { "x-total-count": "1" }) }, "source_answer_unexpected"],
    "more rows than reported": [{ "/rest/v1/team_session/": answer(200, [session(1), session(4)], { "x-total-count": "1" }) }, "source_list_changed"],
    "fewer rows than reported and no next page": [{ "/rest/v1/team_session/": answer(200, [session(1)], { "x-total-count": "2" }) }, "source_list_incomplete"],
    "a next page after the last row": [{ "/rest/v1/team_session/": answer(200, [session(1)], { "x-total-count": "1", link: next }) }, "source_answer_unexpected"],
    "a total that changes": [{
      "/rest/v1/team_session/?team=980&limit=1": answer(200, [session(1)], { "x-total-count": "2", link: next }),
      "/rest/v1/team_session/?team=980&limit=1&offset=1": answer(200, [session(4)], { "x-total-count": "3" }),
    }, "source_list_changed"],
    "a row that comes twice": [{
      "/rest/v1/team_session/?team=980&limit=1": answer(200, [session(1)], { "x-total-count": "2", link: next }),
      "/rest/v1/team_session/?team=980&limit=1&offset=1": answer(200, [session(1)], { "x-total-count": "2" }),
    }, "source_list_changed"],
    "not JSON": [{ "/rest/v1/team_session/": answer(200, "<html>login</html>", { "x-total-count": "1" }) }, "source_answer_unexpected"],
  };
  for (const [what, [routes, expected]] of Object.entries(cases)) {
    await assert.rejects(make(fakeServer({ routes }).fetchImpl).listSessions({ limit: 1, maxPages: 5 }), code(expected), what);
  }
  const a = make(fakeServer().fetchImpl);
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: "5" }, { limit: 1.5 }, { maxPages: 0 }, { maxPages: 21 }, { unknown: 1 }]) await assert.rejects(a.listSessions(options), code("invalid_options"), JSON.stringify(options));
});

test("11. stable codes, never the source's text: refused credential, missing, unavailable, redirect, unexpected status, timeout", async () => {
  const sentence = "SERVER-SENTENCE-that-must-not-leak";
  const cases = {
    source_auth_rejected: [answer(401, { detail: sentence })],
    source_access_refused: [answer(403, { detail: sentence })],
    source_not_found: [answer(404, { detail: sentence })],
    source_unavailable: [answer(500, { detail: sentence }), answer(503, sentence), answer(429, { detail: sentence })],
    source_answer_unexpected: [answer(302, "", { location: "https://evil.example/" }), answer(301, ""), answer(400, { detail: sentence }), answer(201, { id: 1 }), answer(204, "")],
  };
  for (const [expected, answers] of Object.entries(cases)) {
    for (const res of answers) {
      const s = fakeServer({ routes: { "/rest/v1/team/": res } });
      const error = await make(s.fetchImpl).countVisibleTeams().then(() => null, (e) => e);
      assert.ok(error, `${expected} ${res.status}`);
      assert.equal(error.code, expected, String(res.status));
      const text = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      assert.ok(!text.includes(sentence) && !text.includes(CREDENTIAL) && !text.includes("evil.example"), `${res.status}: nothing of the source or the credential is in the error`);
      assert.equal(s.calls.length, 1, "a redirect is never followed");
    }
  }
  const down = async () => { throw Object.assign(new TypeError(`fetch failed ${CREDENTIAL}`), { cause: { code: "ECONNREFUSED" } }); };
  const error = await make(down).countVisibleTeams().then(() => null, (e) => e);
  assert.equal(error.code, "source_unavailable");
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(CREDENTIAL));
  // A server error is retried as often as asked and no more; a refusal is not retried.
  const flaky = fakeServer({ routes: { "/rest/v1/team/": answer(503, "") } });
  await assert.rejects(make(flaky.fetchImpl, { attempts: 3 }).countVisibleTeams(), code("source_unavailable"));
  assert.equal(flaky.calls.length, 3);
  const refused = fakeServer({ routes: { "/rest/v1/team/": answer(401, "") } });
  await assert.rejects(make(refused.fetchImpl, { attempts: 3 }).countVisibleTeams(), code("source_auth_rejected"));
  assert.equal(refused.calls.length, 1);
  // "Slow down" is never repeated.
  const limited = fakeServer({ routes: { "/rest/v1/team/": answer(429, "") } });
  await assert.rejects(make(limited.fetchImpl, { attempts: 3 }).countVisibleTeams(), code("source_unavailable"));
  assert.equal(limited.calls.length, 1);
});

test("11b. attempts, timeout and delay are bounded, and a team list without a total is refused", async () => {
  const { calls, fetchImpl } = fakeServer({ routes: { "/rest/v1/team/": answer(200, [{ id: 980 }]) } });
  for (const over of [{ attempts: 0 }, { attempts: 6 }, { attempts: Infinity }, { attempts: 1.5 }, { attempts: "3" }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: 120_001 }, { retryDelayMs: -1 }, { retryDelayMs: 10_001 }, { sleep: null }, { fetchImpl: null }]) {
    assert.throws(() => make(fetchImpl, over), code("invalid_options"), JSON.stringify(Object.keys(over)));
  }
  await assert.rejects(make(fetchImpl).countVisibleTeams(), code("source_answer_unexpected"), "no X-Total-Count: the count is not invented from the page");
  assert.equal(calls.length, 1);
});

test("11c. the answer size limit is a real limit in bytes: the stream is read chunk by chunk, counted, and cancelled the moment it passes 5 MiB; a header is only an early guard", async () => {
  assert.equal(MAX_ANSWER_BYTES, 5 * 1024 * 1024);
  const MiB = 1024 * 1024;
  const chunk = new Uint8Array(MiB).fill(0x20); // one MiB of spaces: valid JSON whitespace
  const teams = (seen, chunks, headers) => make(async () => streamed(chunks, { "x-total-count": "1", ...headers }, seen)).countVisibleTeams();

  // (a) announced as too large: refused before one byte is pulled.
  const a = {};
  await assert.rejects(teams(a, [bytesOf("[]")], { "content-length": String(5 * MiB + 1) }), code("source_answer_unexpected"));
  assert.equal(a.pulled, 0, "nothing was read");
  assert.equal(a.cancelled, true, "the stream was let go");

  // (b) a chunked body with no Content-Length at all, 8 MiB long: stopped early.
  const b = {};
  await assert.rejects(teams(b, Array.from({ length: 8 }, () => chunk)), code("source_answer_unexpected"));
  assert.equal(b.pulled, 6, "the sixth MiB passed the limit; the seventh and eighth were never pulled");
  assert.equal(b.bytes, 6 * MiB);
  assert.equal(b.cancelled, true);

  // (c) a header that lies small: the real bytes are counted all the same.
  const c = {};
  await assert.rejects(teams(c, Array.from({ length: 8 }, () => chunk), { "content-length": "2" }), code("source_answer_unexpected"));
  assert.equal(c.pulled, 6);
  assert.equal(c.cancelled, true);
  for (const lie of ["0", "-5", "abc", "", "1e3", "Infinity"]) {
    const s = {};
    await assert.rejects(teams(s, Array.from({ length: 7 }, () => chunk), { "content-length": lie }), code("source_answer_unexpected"), JSON.stringify(lie));
    assert.equal(s.cancelled, true, JSON.stringify(lie));
  }

  // (d) bytes, not characters: 2 MiB characters of three bytes each are 6 MiB and are refused,
  // although their character count is far below the limit.
  const euro = bytesOf("€".repeat(MiB)); // 3 MiB of bytes, 1 MiB of characters
  assert.equal(euro.byteLength, 3 * MiB);
  const d = {};
  await assert.rejects(teams(d, [bytesOf('["'), euro, euro, bytesOf('"]')]), code("source_answer_unexpected"));
  assert.equal(d.cancelled, true);
  assert.equal(d.pulled, 3, "stopped at the chunk that passed the limit");
  // The same characters within the limit are read, also when a character is split between chunks.
  const original = '[{"id":980,"name":"\u00dcn\u00efc\u00f6d\u00e9 \u20ac"}]';
  const small = bytesOf(original);
  const inU = small.indexOf(0xc3) + 1; // inside the two bytes of the first letter with an umlaut
  const inEuro = small.indexOf(0xe2) + 1; // inside the three bytes of the euro sign
  assert.ok((small[inU] & 0xc0) === 0x80 && (small[inEuro] & 0xc0) === 0x80, "both cuts are inside a multi-byte character");
  const split = () => [small.slice(0, inU), small.slice(inU, inEuro), small.slice(inEuro)];
  const e = {};
  assert.deepEqual(await teams(e, split()), { teamCount: 1, boundTeamOnFirstPage: true, firstPageOnly: false });
  assert.equal(e.cancelled, false);
  assert.equal(await readBounded({ body: streamOf(split(), {}) }), original, "the text is whole, no replacement character");
  assert.equal(await readBounded({ body: streamOf([new Uint8Array([0xe2]), new Uint8Array([0x82, 0xac])], {}) }), "\u20ac");

  // (e) exactly the limit is allowed (whitespace around a list), one byte more is not.
  const exact = [bytesOf("["), new Uint8Array(5 * MiB - 2).fill(0x20), bytesOf("]")];
  assert.deepEqual(await teams({}, exact.concat()), { teamCount: 1, boundTeamOnFirstPage: false, firstPageOnly: true });
  await assert.rejects(teams({}, [bytesOf("["), new Uint8Array(5 * MiB - 1).fill(0x20), bytesOf("]")]), code("source_answer_unexpected"));
});

test("11d. never part of an answer: a stream that breaks, a chunk that is not bytes, a body without a stream and an oversized session list all refuse, and nothing of them is returned", async () => {
  const MiB = 1024 * 1024;
  // A valid JSON prefix followed by too much: the parsed prefix is never returned.
  const seen = {};
  const rows = bytesOf(JSON.stringify([session(1)]).slice(0, -1));
  const list = make(async () => streamed([rows, ...Array.from({ length: 6 }, () => new Uint8Array(MiB).fill(0x20)), bytesOf("]")], { "x-total-count": "1" }, seen)).listSessions({ limit: 1 });
  const error = await list.then((value) => ({ value }), (e) => e);
  assert.equal(error.code, "source_answer_unexpected");
  assert.equal(error.value, undefined);
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes("Training"), "nothing of the body is in the refusal");
  assert.equal(seen.cancelled, true);
  // The stream errors half way.
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error("connection reset CREDENTIAL-LIKE-TEXT")); } });
  const half = await make(async () => ({ status: 200, headers: new Headers(json), body: broken })).countVisibleTeams().then(() => null, (e) => e);
  assert.equal(half.code, "source_unavailable");
  assert.ok(!JSON.stringify({ ...half, message: half.message }).includes("CREDENTIAL-LIKE-TEXT"));
  // A chunk that is not bytes.
  await assert.rejects(make(async () => ({ status: 200, headers: new Headers(json), body: streamOf(["[]"]) })).countVisibleTeams(), code("source_answer_unexpected"));
  // A body that is not a stream is never read through text().
  let asked = false;
  await assert.rejects(make(async () => ({ status: 200, headers: new Headers(json), body: "[]", text: async () => { asked = true; return "[]"; } })).countVisibleTeams(), code("source_answer_unexpected"));
  await assert.rejects(make(async () => ({ status: 200, headers: new Headers(json), text: async () => { asked = true; return "[]"; } })).countVisibleTeams(), code("source_answer_unexpected"));
  assert.equal(asked, false, "text() is never called");
  // The helper itself, with a small limit: counted, cancelled, nothing returned.
  const s = {};
  await assert.rejects(readBounded({ body: streamOf([bytesOf("abcd"), bytesOf("efgh"), bytesOf("ijkl")], s) }, null, 6), code("source_answer_unexpected"));
  assert.deepEqual({ pulled: s.pulled, cancelled: s.cancelled }, { pulled: 2, cancelled: true });
  assert.equal(await readBounded({ body: streamOf([bytesOf("abc"), bytesOf("def")], {}) }, "5", 6), "abcdef");
  assert.equal(await readBounded({ body: null }, null, 6), "");
  // The platform's own Response class, no network: counted and cancelled the same way; an empty one is refused.
  const real = {};
  const mib = new Uint8Array(MiB).fill(0x20);
  await assert.rejects(make(async () => new Response(streamOf(Array.from({ length: 8 }, () => mib), real), { status: 200, headers: { ...json, "x-total-count": "1" } })).countVisibleTeams(), code("source_answer_unexpected"));
  assert.equal(real.cancelled, true);
  assert.ok(real.pulled <= 7, "the rest was never pulled");
  await assert.rejects(make(async () => new Response(null, { status: 200, headers: { ...json, "x-total-count": "0" } })).countVisibleTeams(), code("source_answer_unexpected"));
  await assert.rejects(make(async () => new Response("", { status: 200, headers: { ...json, "x-total-count": "0" } })).countVisibleTeams(), code("source_answer_unexpected"));
  assert.deepEqual(await make(async () => new Response("[]", { status: 200, headers: { ...json, "x-total-count": "0" } })).countVisibleTeams(), { teamCount: 0, boundTeamOnFirstPage: false, firstPageOnly: false });
  // A stream whose cancel never settles does not hold the refusal back.
  const stuck = { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(7) }), cancel: () => new Promise(() => {}), releaseLock() {} }) };
  await assert.rejects(readBounded({ body: stuck }, null, 6), code("source_answer_unexpected"));
  // After a whole read the stream is not left locked.
  const whole = { body: streamOf([bytesOf("[]")], {}) };
  assert.equal(await readBounded(whole), "[]");
  assert.equal(whole.body.locked, false);
  // Section 4 of the compatibility document names only capabilities the adapter knows.
  const doc = await fsp.readFile(path.resolve(ROOT, "docs/ai/gpexe-rest-v1-compatibility.md"), "utf8");
  const section4 = doc.slice(doc.indexOf("## 4."), doc.indexOf("## 5."));
  const named = [...section4.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]);
  assert.ok(named.length >= 9);
  for (const name of named) assert.ok(Object.prototype.hasOwnProperty.call(REST_V1_CAPABILITIES, name), `${name} is a capability of the adapter`);
  // drill=0 and drill=1 appear only in the one row that names the legacy form on a parent confirmed
  // twice (owner, 2026-10-01): never the REST form, never a read by a drill id, never another position.
  for (const position of ["0", "1"]) {
    const rows = section4.split(/\r?\n/).filter((l) => new RegExp(`drill=${position}\\b`).test(l));
    assert.equal(rows.length, 1, `drill=${position} appears in exactly one table row`);
    assert.ok(rows[0].startsWith("| `session_drill_details` |"));
  }
  const row = section4.split(/\r?\n/).find((l) => l.startsWith("| `session_drill_details` |"));
  assert.match(row, /`api\/team_session\/<parent id>\/details\/\?drill=0`/);
  assert.match(row, /`api\/team_session\/<parent id>\/details\/\?drill=1`/);
  assert.match(row, /zero-based/);
  assert.match(row, /drills_count >= 2/);
  assert.match(row, /same `id`/);
  assert.match(row, /team 980/);
  assert.match(row, /`teamsession`/);
  assert.match(row, /`source_changed_during_probe`/);
  assert.match(row, /`drill_link_not_confirmed`/);
  assert.match(row, /`drill_repeat_index_changed`/);
  assert.match(row, /`diagnosticLinkConfirmed`/);
  assert.match(row, /0 → 1 → 0/);
  assert.match(row, /not an identity rule/);
  assert.doesNotMatch(row, /\*\*same\*\*/, "this run never says same either: the identity contract is decided after its result");
  assert.match(row, /Never \*\*missing\*\*/);
  assert.doesNotMatch(row, /rest\/v1\/team_session\/[^`]*\?drill=|`team_session\/<id>\/details\/\?drill=0`/, "never the REST form");
  assert.doesNotMatch(row, /`api\/team_session\/<parent id>\/details\/`/, "never a legacy details read without a position");
  assert.doesNotMatch(row, /\*\*mapped\*\*/, "this run never says mapped");
  assert.doesNotMatch(section4, /<drill id>/, "no read by a drill id anywhere in section 4");
  assert.doesNotMatch(section4, /drill=([2-9]|1[0-9])/, "no other drill position");
  assert.doesNotMatch(doc.replace(/history, not a reference value/g, ""), /unfiltered 308|than the unfiltered 308/);
  // The source of the adapter asks for no whole body anywhere.
  const source = (await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8")).split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(source, /\.text\(\)|\.json\(\)|\.arrayBuffer\(\)|\.blob\(\)/);
});

test("12. what is not proven is source_capability_unavailable: no request is sent, no path is guessed, and the refusal names the capability and how much is known", async () => {
  const { calls, fetchImpl } = fakeServer({ routes: { "/rest/v1/team_session/1/": answer(200, session(1)) } });
  const a = make(fetchImpl);
  const expected = {
    listSessionsByDay: ["session_list_by_date", "legacy_attested"],
    getSession: ["session_read", "legacy_attested"],
    getSessionDetails: ["session_details", "legacy_attested"],
    getSessionDrillDetails: ["session_drill_details", "unknown"],
    listAthleteSessions: ["athlete_session_list", "unknown"],
    getAthleteSession: ["athlete_session_read", "unknown"],
    getAthleteSessionMore: ["athlete_session_more", "unknown"],
    getTrack: ["track_read", "unknown"],
    getTeamThresholds: ["team_thresholds", "unknown"],
    getUnits: ["units", "unknown"],
    listSessionTags: ["session_tags", "legacy_attested"],
    fetchSessionBundle: ["session_read", "legacy_attested"],
  };
  for (const [op, [capability, status]] of Object.entries(expected)) {
    for (const options of [undefined, {}, { sessionId: "1" }, { id: "1", fromDay: "2026-09-01", toDay: "2026-09-14" }]) {
      const error = await a[op](options).then(() => null, (e) => e);
      assert.ok(error, op);
      assert.equal(error.code, "source_capability_unavailable", op);
      assert.equal(error.capability, capability, op);
      assert.equal(error.capabilityStatus, status, op);
    }
  }
  // A date window on the proven list is the unproven capability, not a silent full list.
  for (const options of [{ fromDay: "2026-09-01" }, { toDay: "2026-09-14" }, { from: "2026-09-01", to: "2026-09-14" }, { startTimestampGte: "2026-09-01" }, { date: "2026-09-14" }, { since: "2026-09-01" }]) {
    const error = await a.listSessions(options).then(() => null, (e) => e);
    assert.equal(error.code, "source_capability_unavailable", JSON.stringify(options));
    assert.equal(error.capability, "session_list_by_date");
  }
  assert.equal(calls.length, 0, "nothing was sent for an unproven capability");
  assert.deepEqual(a.capabilities(), Object.fromEntries(Object.entries(REST_V1_CAPABILITIES).map(([k, v]) => [k, { status: v.status, available: v.status === "proven" }])));
  assert.deepEqual(Object.entries(REST_V1_CAPABILITIES).filter(([, v]) => v.status === "proven").map(([k]) => k), ["team_list", "team_read", "session_list"]);
  // The table says what the e03 client really sends: it never lists sessions without a date window.
  const client = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeClient.js"), "utf8");
  assert.doesNotMatch(client, /team_session\/\?team=\$\{team\}&limit=/);
  assert.match(client, /team_session\/\?team=\$\{team\}&start_timestamp_gte=/);
  assert.equal(REST_V1_CAPABILITIES.session_list.e03, "not sent without a date window");
  // The adapter's code builds a request only for the proven resources.
  const source = (await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8")).split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  const code_ = source.slice(source.indexOf("export function createGpexeRestV1Adapter"));
  for (const unproven of ["athlete_session/", "track/", "thresholds/", "/details", "team_session_tag", "start_timestamp_gte", "/more", "valid_on", "teamsession="]) assert.ok(!code_.includes(unproven), `no request is built for ${unproven}`);
});

test("13. the existing e03 importer is untouched: its client still names its own root and the rest_v1 adapter is not imported by it", async () => {
  const client = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeClient.js"), "utf8");
  assert.match(client, /export const GPEXE_API_BASE = "https:\/\/e03\.gpexe\.com\/api\/";/);
  assert.doesNotMatch(client, /sourceAdapters|gpexeRestV1Adapter|sourceHosts/);
  const service = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeImportService.js"), "utf8");
  assert.doesNotMatch(service, /sourceAdapters|gpexeRestV1Adapter/);
  // No route uses the adapter.
  for (const f of await fsp.readdir(path.resolve(ROOT, "backend/src/routes"))) {
    assert.doesNotMatch(await fsp.readFile(path.resolve(ROOT, "backend/src/routes", f), "utf8"), /sourceAdapters|gpexeRestV1Adapter/, f);
  }
});

test("14. no credential, account address or token value is in the files of this change", async () => {
  const files = [
    "backend/src/gpexeRestV1Adapter.js", "backend/src/sourceAdapters.js", "backend/tests/gpexe-rest-v1-adapter.test.mjs",
    "docs/ai/source-connections-f3c2-contract.md", "docs/ai/CURRENT_STATE.md", "docs/ai/gpexe-rest-v1-compatibility.md",
  ];
  const allowedAddress = /@(test\.local|example\.invalid|example\.com|anthropic\.com)$/i;
  for (const f of files) {
    const text = await fsp.readFile(path.resolve(ROOT, f), "utf8");
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) assert.match(m[0], allowedAddress, `${f}: an e-mail address of a real domain`);
    assert.doesNotMatch(text, /\bToken\s+[0-9a-f]{20,}\b/i, `${f}: a token value`);
    assert.doesNotMatch(text, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, `${f}: a JWT`);
    // Documents may name a Git commit by its full id; code files may not carry any 40-hex value.
    if (f.startsWith("backend/")) assert.doesNotMatch(text, /\b[0-9a-f]{40}\b/i, `${f}: a 40-hex value`);
  }
});
