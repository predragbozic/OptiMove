// The read-only GPEXE client of the in-app import, against a fake fetch: no
// network, no database. What it must never do: send the token anywhere but
// the fixed GPEXE host, follow a redirect, put the token in an error, or keep
// personal fields the importer does not need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATHLETE_SESSION_PAGE, createGpexeClient, GPEXE_API_BASE, GpexeClientError, MAX_DRILLS, SESSION_LIST_LIMIT } from "../src/gpexeClient.js";

const TOKEN = "test-token-7f3a9c";

function response(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// routes: { "path?query": body | (() => response) }
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = String(url).slice(GPEXE_API_BASE.length);
    const route = routes[key];
    if (route === undefined) return response(404, { detail: "not found" });
    return typeof route === "function" ? route(calls.length) : response(200, route);
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test("gpexe client: no token on the server means no client", () => {
  assert.throws(() => createGpexeClient({ token: "", fetchImpl: async () => {} }), (e) => e instanceof GpexeClientError && e.code === "token_missing");
});

test("gpexe client: every request goes to the fixed host, GET only, redirects not followed, token in the header only", async () => {
  const { fetchImpl, calls } = fakeFetch({ "team_session/5/": { id: 5, team: 77 } });
  const client = createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep });
  await client.get("team_session/5/");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GPEXE_API_BASE}team_session/5/`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, `Token ${TOKEN}`);
  assert.ok(!calls[0].url.includes(TOKEN));
});

test("gpexe client: only relative API paths are accepted", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const client = createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep });
  for (const bad of ["https://evil.example/api/", "//evil.example/x", "/api/team/", "team/../../x", "http:team"]) {
    await assert.rejects(client.get(bad), (e) => e.code === "invalid_path", bad);
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("gpexe client: a redirect is refused, and no error message carries the token", async () => {
  const { fetchImpl } = fakeFetch({ "team/": () => response(302, "", { location: "https://elsewhere.example/" }) });
  const client = createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep });
  await assert.rejects(client.get("team/"), (e) => e.code === "redirect_refused" && !e.message.includes(TOKEN));
});

test("gpexe client: a rejected token stops at once; a server error or a timeout is retried three times", async () => {
  const unauthorized = fakeFetch({ "team/": () => response(401, { detail: "Invalid token." }) });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: unauthorized.fetchImpl, sleep: noSleep }).get("team/"), (e) => e.code === "unauthorized" && !e.message.includes(TOKEN));
  assert.equal(unauthorized.calls.length, 1);

  const flaky = fakeFetch({ "team/": (n) => (n < 3 ? response(502, "bad gateway") : response(200, [{ id: 1 }])) });
  assert.deepEqual(await createGpexeClient({ token: TOKEN, fetchImpl: flaky.fetchImpl, sleep: noSleep }).get("team/"), [{ id: 1 }]);
  assert.equal(flaky.calls.length, 3);

  let attempts = 0;
  const hanging = async () => {
    attempts += 1;
    const error = new Error(`timed out with Token ${TOKEN}`);
    error.name = "TimeoutError";
    throw error;
  };
  await assert.rejects(
    createGpexeClient({ token: TOKEN, fetchImpl: hanging, sleep: noSleep }).get("team/"),
    (e) => e.code === "unreachable" && /TimeoutError/.test(e.message) && !e.message.includes(TOKEN),
  );
  assert.equal(attempts, 3);
});

test("gpexe client: personal fields the importer does not need are removed from every response", async () => {
  const { fetchImpl } = fakeFetch({
    "track/9/": { id: 9, athlete: 101, athlete_name: "Real Name", timezone: "Europe/Sarajevo", notes: "private", weather: { lat: 1, lng: 2 }, nested: [{ email: "x@y", birthdate: "2000-01-01", keep: 1 }] },
  });
  const body = await createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep }).get("track/9/");
  assert.deepEqual(body, { id: 9, athlete: 101, timezone: "Europe/Sarajevo", nested: [{ keep: 1 }] });
});

test("gpexe client: the session list keeps parent sessions only, refuses another team's rows and a full page", async () => {
  // The list is asked from one day before the window (see the drill test below).
  const list = (items) => fakeFetch({ [`team_session/?team=77&start_timestamp_gte=2026-08-31%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=${SESSION_LIST_LIMIT}`]: items });
  const window = { gpexeTeamId: "77", fromDay: "2026-09-01", toDay: "2026-09-14" };
  const parents = await createGpexeClient({ token: TOKEN, fetchImpl: list([
    { id: 10, team: 77, category_name: "FULL TRAINING", drills: [11, 12], drills_count: 2, start_timestamp: "2026-09-14T18:00:00", is_stats_valid: true },
    { id: 11, team: 77, drills: [], start_timestamp: "2026-09-14T18:00:00" },
    { id: 12, team: 77, drills: [], start_timestamp: "2026-09-14T18:30:00" },
    { id: 20, team: 77, category_name: "OFFICIAL MATCH", drills: [], drills_count: 0, start_timestamp: "2026-09-10T17:00:00" },
  ]).fetchImpl, sleep: noSleep }).listTeamSessions(window);
  assert.deepEqual(parents.map((s) => s.id), ["10", "20"]);
  assert.equal(parents[0].drillsCount, 2);

  await assert.rejects(
    createGpexeClient({ token: TOKEN, fetchImpl: list([{ id: 10, team: 78, drills: [] }]).fetchImpl, sleep: noSleep }).listTeamSessions(window),
    (e) => e.code === "team_filter_ignored",
  );
  // A drill that starts inside the window whose parent started the evening
  // before: neither is a candidate of this window.
  const straddling = await createGpexeClient({ token: TOKEN, fetchImpl: list([
    { id: 30, team: 77, drills: [31], drills_count: 1, start_timestamp: "2026-08-31T23:40:00" },
    { id: 31, team: 77, drills: [], start_timestamp: "2026-09-01T00:05:00" },
  ]).fetchImpl, sleep: noSleep }).listTeamSessions(window);
  assert.deepEqual(straddling, []);
  const full = Array.from({ length: SESSION_LIST_LIMIT }, (_, i) => ({ id: i + 1, team: 77, drills: [] }));
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: list(full).fetchImpl, sleep: noSleep }).listTeamSessions(window), (e) => e.code === "window_too_large");
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: list([]).fetchImpl, sleep: noSleep }).listTeamSessions({ ...window, gpexeTeamId: "77&x=1" }), (e) => e.code === "invalid_id");
});

test("gpexe client: a session bundle has the shape the mapper reads, and belongs to the requested team", async () => {
  const routes = {
    "team_session/10/": { id: 10, team: 77, drills_count: 1, start_timestamp: "2026-09-14T18:00:00", category_name: "FULL TRAINING" },
    "athlete_session/?teamsession=10&limit=100": [{ id: 500, teamsession: 10 }, { id: 501, teamsession: 10 }, { id: 999, teamsession: 11 }],
    "athlete_session/500/": { id: 500, athlete: 101, track: 9, teamsession: 10, drill: null },
    "athlete_session/501/": { id: 501, athlete: 101, track: 9, teamsession: 10, drill: 0 },
    "athlete_session/500/more/": { athletesession_id: 500 },
    "athlete_session/501/more/": { athletesession_id: 501 },
    "track/9/": { id: 9, athlete: 101, athlete_name: "Real Name", timezone: "Europe/Sarajevo" },
    "team_session/10/details/": { players: { 101: {} } },
    "team_session/10/details/?drill=0": { players: { 101: {} } },
    // thresholds endpoint answers 404 here: the bundle carries null and the
    // mapper refuses the session with its own reason.
  };
  const { fetchImpl, calls } = fakeFetch(routes);
  const bundle = await createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" });
  assert.deepEqual(Object.keys(bundle).sort(), ["athleteSessions", "details", "more", "teamSession", "teamThresholds", "tracks"]);
  assert.deepEqual(bundle.athleteSessions.map((r) => r.id), [500, 501], "rows of another session are not fetched");
  assert.deepEqual(Object.keys(bundle.more).sort(), ["500", "501"]);
  assert.deepEqual(bundle.tracks["9"], { id: 9, athlete: 101, timezone: "Europe/Sarajevo" });
  assert.deepEqual(Object.keys(bundle.details.drills), ["0"]);
  assert.equal(bundle.teamThresholds, null);
  assert.equal(calls.filter((c) => c.url.endsWith("track/9/")).length, 1, "a shared track is fetched once");

  const other = fakeFetch({ "team_session/10/": { id: 10, team: 78 } });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: other.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "team_mismatch");
});

test("gpexe client: the athlete rows of a session are paged to the end, and a list that cannot be completed is refused", async () => {
  const base = {
    "team_session/10/": { id: 10, team: 77, drills_count: 0, start_timestamp: "2026-09-14T18:00:00" },
    "team_session/10/details/": { players: {} },
  };
  const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, teamsession: 10 }));
  const detail = (ids) => Object.fromEntries(ids.flatMap((id) => [[`athlete_session/${id}/`, { id, athlete: 1, teamsession: 10, drill: null }], [`athlete_session/${id}/more/`, { athletesession_id: id }]]));
  const all = rows(1000, 125);
  const paged = fakeFetch({
    ...base,
    ...detail(all.map((r) => r.id)),
    [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: { count: 125, next: `${GPEXE_API_BASE}athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}&offset=100`, results: all.slice(0, 100) },
    [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}&offset=100`]: { count: 125, next: null, results: all.slice(100) },
  });
  const bundle = await createGpexeClient({ token: TOKEN, fetchImpl: paged.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" });
  assert.equal(bundle.athleteSessions.length, 125);

  const fullArray = fakeFetch({ ...base, [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: rows(1, ATHLETE_SESSION_PAGE) });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: fullArray.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "list_incomplete");

  const short = fakeFetch({ ...base, [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: { count: 125, next: null, results: rows(1, 100) } });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: short.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "list_incomplete");

  const elsewhere = fakeFetch({ ...base, [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: { count: 125, next: "https://elsewhere.example/api/page2", results: rows(1, 100) } });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: elsewhere.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "list_incomplete");
  assert.ok(!elsewhere.calls.some((c) => c.url.includes("elsewhere")), "the token never went to the other host");
});

test("gpexe client: a session claiming more drills than accepted is refused before any drill is fetched; progress is reported per request", async () => {
  const many = fakeFetch({ "team_session/10/": { id: 10, team: 77, drills_count: MAX_DRILLS + 1 } });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: many.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "drills_count_out_of_range");
  assert.equal(many.calls.length, 1);

  const ok = fakeFetch({
    "team_session/10/": { id: 10, team: 77, drills_count: 1, start_timestamp: "2026-09-14T18:00:00" },
    "athlete_session/?teamsession=10&limit=100": [],
    "team_session/10/details/": { players: {} },
    "team_session/10/details/?drill=0": { players: {} },
  });
  let ticks = 0;
  await createGpexeClient({ token: TOKEN, fetchImpl: ok.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10", onProgress: () => { ticks += 1; } });
  // Every request but the thresholds one, which answered 404 and threw first.
  assert.equal(ticks, ok.calls.length - 1);
});
