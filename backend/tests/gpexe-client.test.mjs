// The read-only GPEXE client of the in-app import, against a fake fetch: no
// network, no database. What it must never do: send the token anywhere but
// the fixed GPEXE host, follow a redirect, put the token in an error, or keep
// personal fields the importer does not need.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main as probe } from "../scripts/gpexe-api-probe.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
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

// A page the way GPEXE sends it: a plain array, the total in X-Total-Count,
// the next page in a Link header.
function page(rows, { total = rows.length, next = null } = {}) {
  const headers = { "x-total-count": String(total) };
  if (next) headers.link = `<${GPEXE_API_BASE}${next}>; rel="next", <${GPEXE_API_BASE}x>; rel="last"`;
  return () => response(200, rows, headers);
}

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

test("gpexe client: the session list keeps parent sessions only and refuses another team's rows", async () => {
  // The list is asked from one day before the window (see the drill test below).
  const list = (items) => fakeFetch({ [`team_session/?team=77&start_timestamp_gte=2026-08-31%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=${SESSION_LIST_LIMIT}`]: page(items) });
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
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: list([]).fetchImpl, sleep: noSleep }).listTeamSessions({ ...window, gpexeTeamId: "77&x=1" }), (e) => e.code === "invalid_id");
});

test("gpexe client: a session bundle has the shape the mapper reads, and belongs to the requested team", async () => {
  const routes = {
    "team_session/10/": { id: 10, team: 77, drills_count: 1, start_timestamp: "2026-09-14T18:00:00", category_name: "FULL TRAINING" },
    "athlete_session/?teamsession=10&limit=100": page([{ id: 500, teamsession: 10 }, { id: 501, teamsession: 10 }, { id: 999, teamsession: 11 }]),
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

test("gpexe client: lists are read to the end through every page, and an unclear or incomplete list fails the check", async () => {
  const listPath = "team_session/?team=77&start_timestamp_gte=2026-08-31%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=100";
  const window = { gpexeTeamId: "77", fromDay: "2026-09-01", toDay: "2026-09-14" };
  const sessions = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, team: 77, drills: [], start_timestamp: "2026-09-05T18:00:00" }));
  const list = (routes) => createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep }).listTeamSessions(window);

  // A first page shorter than 100 with a next page: the next page is read.
  const short = await list({
    [listPath]: page(sessions(1, 40), { total: 62, next: "team_session/?page=2" }),
    "team_session/?page=2": page(sessions(41, 22), { total: 62 }),
  });
  assert.equal(short.length, 62);
  // Three pages the way GPEXE really pages (122 rows seen in the pilot).
  const three = await list({
    [listPath]: page(sessions(1, 100), { total: 122, next: "team_session/?offset=100" }),
    "team_session/?offset=100": page(sessions(101, 22), { total: 122 }),
  });
  assert.equal(three.length, 122);
  // Django REST Framework shape, next in the body.
  const drf = await list({
    [listPath]: { count: 3, next: `${GPEXE_API_BASE}team_session/?p=2`, results: sessions(1, 2) },
    "team_session/?p=2": { count: 3, next: null, results: sessions(3, 1) },
  });
  assert.equal(drf.length, 3);

  const refused = async (routes, code, why) => assert.rejects(list(routes), (e) => e.code === code, why);
  await refused({ [listPath]: () => response(200, sessions(1, 5)) }, "list_shape_unclear", "no total at all");
  await refused({ [listPath]: page(sessions(1, 5), { total: 7 }) }, "list_incomplete", "total says more, no next page");
  await refused({ [listPath]: page(sessions(1, 40), { total: 62, next: "team_session/?page=2" }), "team_session/?page=2": page(sessions(41, 22), { total: 63 }) }, "list_changed", "total changed between pages");
  await refused({ [listPath]: page(sessions(1, 40), { total: 80, next: "team_session/?page=2" }), "team_session/?page=2": page(sessions(1, 40), { total: 80 }) }, "list_changed", "the same rows twice");
  await refused({ [listPath]: page(sessions(1, 5), { total: 3 }) }, "list_changed", "more rows than the total");
  await refused({ [listPath]: page(sessions(1, 5), { total: 5, next: "team_session/?page=2" }) }, "list_shape_unclear", "another page after all rows");
  await refused({ [listPath]: { data: sessions(1, 2) } }, "list_shape_unclear", "neither a list nor a paged result");
  await refused({ [listPath]: page([{ team: 77 }], { total: 1 }) }, "list_shape_unclear", "a row without id");
  const outside = fakeFetch({ [listPath]: () => response(200, sessions(1, 5), { "x-total-count": "9", link: '<https://elsewhere.example/api/p2>; rel="next"' }) });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: outside.fetchImpl, sleep: noSleep }).listTeamSessions(window), (e) => e.code === "list_incomplete");
  assert.ok(!outside.calls.some((c) => c.url.includes("elsewhere")), "the token never went to the other host");
  const endless = {};
  for (let n = 0; n <= 25; n += 1) endless[n === 0 ? listPath : `team_session/?page=${n}`] = page(sessions(n * 10 + 1, 10), { total: 1000, next: `team_session/?page=${n + 1}` });
  await refused(endless, "list_incomplete", "more pages than accepted");
});

test("gpexe client: the athlete rows of a session are read through every page", async () => {
  const base = {
    "team_session/10/": { id: 10, team: 77, drills_count: 0, start_timestamp: "2026-09-14T18:00:00" },
    "team_session/10/details/": { players: {} },
  };
  const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, teamsession: 10 }));
  const detail = (ids) => Object.fromEntries(ids.flatMap((id) => [[`athlete_session/${id}/`, { id, athlete: 1, teamsession: 10, drill: null }], [`athlete_session/${id}/more/`, { athletesession_id: id }]]));
  const all = rows(1000, 125);
  const routes = {
    ...base,
    ...detail(all.map((r) => r.id)),
    [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: page(all.slice(0, 60), { total: 125, next: "athlete_session/?teamsession=10&page=2" }),
    "athlete_session/?teamsession=10&page=2": page(all.slice(60), { total: 125 }),
  };
  const bundle = await createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" });
  assert.equal(bundle.athleteSessions.length, 125);
  const cut = fakeFetch({ ...base, [`athlete_session/?teamsession=10&limit=${ATHLETE_SESSION_PAGE}`]: page(rows(1, 100), { total: 125 }) });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: cut.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "list_incomplete");
});

test("gpexe client: a session claiming more drills than accepted is refused before any drill is fetched; progress is reported per request", async () => {
  const many = fakeFetch({ "team_session/10/": { id: 10, team: 77, drills_count: MAX_DRILLS + 1 } });
  await assert.rejects(createGpexeClient({ token: TOKEN, fetchImpl: many.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10" }), (e) => e.code === "drills_count_out_of_range");
  assert.equal(many.calls.length, 1);

  const ok = fakeFetch({
    "team_session/10/": { id: 10, team: 77, drills_count: 1, start_timestamp: "2026-09-14T18:00:00" },
    "athlete_session/?teamsession=10&limit=100": page([]),
    "team_session/10/details/": { players: {} },
    "team_session/10/details/?drill=0": { players: {} },
  });
  let ticks = 0;
  await createGpexeClient({ token: TOKEN, fetchImpl: ok.fetchImpl, sleep: noSleep }).fetchSessionBundle({ gpexeTeamId: "77", sessionId: "10", onProgress: () => { ticks += 1; } });
  // Every request but the thresholds one, which answered 404 and threw first.
  assert.equal(ticks, ok.calls.length - 1);
});

function probeRoutes({ bundle, category = "FULL TRAINING", changeOnSecondFetch = false }) {
  const players = Object.fromEntries(bundle.athleteSessions.map((r) => [`athlete_session/${r.id}/`, r]));
  const more = Object.fromEntries(Object.entries(bundle.more).map(([id, m]) => [`athlete_session/${id}/more/`, m]));
  const tracks = Object.fromEntries(Object.entries(bundle.tracks).map(([id, t]) => [`track/${id}/`, { ...t, athlete_name: "Real Name" }]));
  let detailsCalls = 0;
  return {
    "team_session/?team=980&start_timestamp_gte=2026-09-13%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=100": page([{ id: 186942, team: 980, category_name: category, drills: [], drills_count: 2, start_timestamp: "2026-09-14T18:08:12" }]),
    "team_session/186942/": bundle.teamSession,
    "athlete_session/?teamsession=186942&limit=100": page(bundle.athleteSessions.map((r) => ({ id: r.id, teamsession: r.teamsession }))),
    ...players, ...more, ...tracks,
    "team_session/186942/details/": () => {
      detailsCalls += 1;
      const details = structuredClone(bundle.details.full);
      if (changeOnSecondFetch && detailsCalls === 2) details.players["101"].tot_burst_events.value += 1;
      return response(200, details);
    },
    "team_session/186942/details/?drill=0": bundle.details.drills["0"],
    "team_session/186942/details/?drill=1": { players: {} },
    "team/980/thresholds/?valid_on=2026-09-14": bundle.teamThresholds,
  };
}

test("api probe: content that changes between two fetches is reported by path, with ids masked", async () => {
  const bundle = makeBundle({ sessionId: 186942, gpexeTeamId: 980, athletes: standardAthletes() });
  const client = createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(probeRoutes({ bundle, changeOnSecondFetch: true })).fetchImpl, sleep: noSleep });
  const report = await probe(["--team", "980", "--from", "2026-09-14", "--to", "2026-09-14", "--session", "186942"], { client });
  assert.equal(report.session.sameHashOnTwoFetches, false);
  assert.deepEqual(report.session.pathsThatChangedBetweenFetches, [".details.full.players.<id>.tot_burst_events.value"]);
  assert.ok(!/\b10[1-3]\b/.test(JSON.stringify(report.session.pathsThatChangedBetweenFetches)));
});

test("api probe: a relative next link is reported as such, not a crash; category names are not printed", async () => {
  const bundle = makeBundle({ sessionId: 186942, gpexeTeamId: 980, athletes: standardAthletes() });
  const routes = probeRoutes({ bundle, category: "Individual Real Name" });
  routes["team_session/?team=980&start_timestamp_gte=2026-09-13%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=100"] =
    () => response(200, [{ id: 186942, team: 980, category_name: "Individual Real Name", drills: [], start_timestamp: "2026-09-14T18:08:12" }], { "x-total-count": "2", link: '</api/team_session/?offset=1>; rel="next"' });
  const client = createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep });
  const report = await probe(["--team", "980", "--from", "2026-09-14", "--to", "2026-09-14", "--session", "186942"], { client });
  assert.equal(report.sessionListFirstPage.nextPage.relative, true);
  assert.equal(report.sessionListFirstPage.nextPage.insideApi, false);
  assert.deepEqual([report.sessionList.complete, report.sessionList.error], [false, "list_incomplete"]);
  assert.ok(!JSON.stringify(report).includes("Real Name"));
});

test("gpexe client: the session list reports progress after every page", async () => {
  const listPath = "team_session/?team=77&start_timestamp_gte=2026-08-31%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=100";
  const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, team: 77, drills: [], start_timestamp: "2026-09-05T18:00:00" }));
  const { fetchImpl } = fakeFetch({ [listPath]: page(rows(1, 40), { total: 62, next: "team_session/?page=2" }), "team_session/?page=2": page(rows(41, 22), { total: 62 }) });
  let ticks = 0;
  await createGpexeClient({ token: TOKEN, fetchImpl, sleep: noSleep }).listTeamSessions({ gpexeTeamId: "77", fromDay: "2026-09-01", toDay: "2026-09-14", onProgress: () => { ticks += 1; } });
  assert.equal(ticks, 2);
});

test("api probe: reports the paging shape and a stable hash without any name, athlete id, value or token", async () => {
  const bundle = makeBundle({ sessionId: 186942, gpexeTeamId: 980, athletes: standardAthletes() });
  const players = Object.fromEntries(bundle.athleteSessions.map((r) => [`athlete_session/${r.id}/`, r]));
  const more = Object.fromEntries(Object.entries(bundle.more).map(([id, m]) => [`athlete_session/${id}/more/`, m]));
  const tracks = Object.fromEntries(Object.entries(bundle.tracks).map(([id, t]) => [`track/${id}/`, { ...t, athlete_name: "Real Name" }]));
  const listRows = bundle.athleteSessions.map((r) => ({ id: r.id, teamsession: r.teamsession }));
  const routes = {
    "team_session/?team=980&start_timestamp_gte=2026-09-13%2000:00:00&start_timestamp_lte=2026-09-14%2023:59:59&limit=100": page([{ id: 186942, team: 980, category_name: "FULL TRAINING", drills: [], drills_count: 2, start_timestamp: "2026-09-14T18:08:12" }]),
    "team_session/186942/": bundle.teamSession,
    "athlete_session/?teamsession=186942&limit=100": page(listRows),
    ...players, ...more, ...tracks,
    "team_session/186942/details/": bundle.details.full,
    "team_session/186942/details/?drill=0": bundle.details.drills["0"],
    "team_session/186942/details/?drill=1": { players: {} },
    "team/980/thresholds/?valid_on=2026-09-14": bundle.teamThresholds,
  };
  const client = createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep });
  const report = await probe(["--team", "980", "--from", "2026-09-14", "--to", "2026-09-14"], { client });
  assert.equal(report.sessionListFirstPage.body, "array");
  assert.equal(report.sessionListFirstPage.totalHeader, "1");
  assert.equal(report.sessionList.complete, true);
  assert.equal(report.session.sameHashOnTwoFetches, true);
  assert.equal(report.session.athleteRows, bundle.athleteSessions.length);
  assert.ok(report.session.importerView.participants >= 1);
  const text = JSON.stringify(report);
  for (const secret of [TOKEN, "Real Name", '"101"', '"102"']) assert.ok(!text.includes(secret), secret);
});

test("api probe: every distinct changed field is reported, and a failing request is reported without its row id", async () => {
  const athletes = Array.from({ length: 25 }, (_, i) => ({ id: 300 + i, tracks: [8000 + i], parts: [{ drill: null, time: 600, distance: 1000, maxV: 6, power: [600, 50, 40, 10, 0], acc: 1, dec: 1, burst: 1, brake: 1 }] }));
  const bundle = makeBundle({ sessionId: 186942, gpexeTeamId: 980, athletes, drillsCount: 0, detailsDrills: [] });
  const routes = probeRoutes({ bundle });
  let detailsCalls = 0;
  routes["team_session/186942/details/"] = () => {
    detailsCalls += 1;
    const details = structuredClone(bundle.details.full);
    if (detailsCalls === 2) for (const player of Object.values(details.players)) player.tot_burst_events.value += 1;
    return response(200, details);
  };
  let trackCalls = 0;
  routes["track/8024/"] = () => {
    trackCalls += 1;
    return response(200, { ...bundle.tracks["8024"], timezone: trackCalls === 2 ? "Europe/Belgrade" : bundle.tracks["8024"].timezone });
  };
  const client = createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(routes).fetchImpl, sleep: noSleep });
  const report = await probe(["--team", "980", "--from", "2026-09-14", "--to", "2026-09-14", "--session", "186942"], { client });
  assert.ok(report.session.pathsThatChangedBetweenFetches.includes(".details.full.players.<id>.tot_burst_events.value"));
  assert.ok(report.session.pathsThatChangedBetweenFetches.includes(".tracks.<id>.timezone"));

  const failing = probeRoutes({ bundle: makeBundle({ sessionId: 186942, gpexeTeamId: 980, athletes: standardAthletes() }) });
  const firstRow = Object.keys(failing).find((k) => /^athlete_session\/\d+\/more\/$/.test(k));
  const rowId = firstRow.match(/\d+/)[0];
  failing[firstRow] = () => response(500, "error");
  const failingClient = createGpexeClient({ token: TOKEN, fetchImpl: fakeFetch(failing).fetchImpl, sleep: noSleep });
  const failed = await probe(["--team", "980", "--from", "2026-09-14", "--to", "2026-09-14", "--session", "186942"], { client: failingClient });
  assert.equal(failed.session.error, "server_error");
  assert.ok(!JSON.stringify(failed).includes(rowId));
});
