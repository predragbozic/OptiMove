// Contract tests of the F3c2c reads of the GPEXE rest_v1 adapter: the
// listSessions() parent/drill classification, the eight reads the owner-run
// probe proved, the one narrow legacy drill read and the drill names. Fake
// fetch only: no network, no database, no environment, no real credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceAdapter, SourceAdapterError } from "../src/sourceAdapters.js";
import { MAX_ANSWER_BYTES } from "../src/gpexeRestV1Adapter.js";

const CREDENTIAL = "MARKER-credential-f3c2c-not-real";
const row = (hostKey, state = "approved") => ({ source_system: "gpexe", host_key: hostKey, state });
const code = (c) => (e) => e instanceof SourceAdapterError ? e.code === c : e.code === c;
const json = { "content-type": "application/json" };

function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      const chunk = chunks[i];
      i += 1;
      return controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}
const bytesOf = (text) => new TextEncoder().encode(text);
function answer(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: new Headers({ ...json, ...headers }),
    get body() { return streamOf([bytesOf(text)]); },
    text: async () => { throw new Error("the adapter must not ask for the whole body"); },
    json: async () => { throw new Error("the adapter must not ask for the whole body"); },
  };
}
const session = (id, team = 980, extra = {}) => ({
  id, team, category_name: "Training", start_timestamp: "2026-09-14T10:00:00", end_timestamp: "2026-09-14T11:00:00", updated_on: "2026-09-14T12:00:00",
  drills_count: 0, drills: [], is_stats_valid: true, notes: "a private note", ...extra,
});
const parent = (id, drills, team = 980, extra = {}) => session(id, team, { drills, drills_count: drills.length, ...extra });

function fakeServer(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, redirect: init.redirect });
    const u = new URL(url);
    const key = `${u.pathname}${u.search}`;
    const route = routes[key] ?? routes[u.pathname];
    if (route === undefined) return answer(404, { detail: "Not found." });
    return typeof route === "function" ? route(u, init) : route;
  };
  return { calls, fetchImpl };
}
const make = (fetchImpl, over = {}) => createSourceAdapter({
  sourceSystem: "gpexe", hostKey: "server3", catalogRow: row("server3"), credential: CREDENTIAL, boundSourceTeamId: "980",
  fetchImpl, attempts: 1, sleep: async () => {}, ...over,
});
const LIST = "/rest/v1/team_session/?team=980&limit=100";
// A session read needs the list classification first (a drill row is never read as a session).
const primed = async (fetchImpl, over = {}) => { const a = make(fetchImpl, over); await a.listSessions(); return a; };
const listOf = (rows, over = {}) => fakeServer({ [LIST]: answer(200, rows, { "x-total-count": String(rows.length) }), ...over });
const idsOf = (result) => result.sessions.map((s) => s.id);

// ---------------------------------------------------------------------------
// B1. The parent / drill classification of the session list.
//
// Characterisation of the F3c2a filter (recorded before the fix, 2026-10-03):
// a row whose id appears in ANY row's `drills` was left out, whatever the
// row itself said; a row that no `drills` named stayed, whatever it looked
// like; nothing checked that a named entry exists on the page or that a
// parent's `drills` and `drills_count` agree. The two failure directions:
//   (a) a real parent named in another row's `drills` disappeared silently;
//   (b) a drill-shaped row that nothing named stayed as a session of its own.
// The fixed rule below returns the whole list of parents or refuses an
// ambiguous page with a stable code — never a silent partial list.
// ---------------------------------------------------------------------------
test("B1.1 a real parent stays, its drill rows are left out and counted, and the parent keeps its page-local drill references", async () => {
  const { calls, fetchImpl } = listOf([parent(100, [101, 102]), session(101), session(102), parent(200, [201]), session(201), session(300)]);
  const result = await make(fetchImpl).listSessions();
  assert.deepEqual(idsOf(result), ["100", "200", "300"]);
  assert.equal(result.total, 6);
  assert.equal(result.drillsLeftOut, 3);
  assert.deepEqual(result.sessions[0].drillIds, ["101", "102"]);
  assert.equal(result.sessions[0].drillsCount, 2);
  assert.equal(calls.length, 1);
});

test("B1.2 direction (a): a row named in another row's drills that itself carries drills or a positive drills_count is not a drill for certain — the page is refused, never silently thinned", async () => {
  // A real parent (300, two drills) whose id a sloppy row names in its drills.
  for (const [named, reason] of [[parent(300, [301, 302]), "named_row_has_drills"], [session(300, 980, { drills_count: 2, drills: [301, 302] }), "named_row_has_drills"], [session(300, 980, { drills_count: 2 }), "drills_count_disagrees"]]) {
    const { fetchImpl } = listOf([parent(100, [101, 300]), session(101), named, session(301), session(302)]);
    const error = await make(fetchImpl).listSessions().then(() => null, (e) => e);
    assert.equal(error?.code, "source_list_ambiguous", JSON.stringify(named));
    assert.equal(error.reason, reason, JSON.stringify(named));
    assert.equal(error.sessions, undefined, "nothing of the list is returned");
  }
});

test("B1.3 direction (b): a drill-shaped row that nothing names is a session of its own — the list has no field that says otherwise — and a drill reference never removes an unrelated real session", async () => {
  // 400 looks like a drill (no drills, count 0) but nothing names it: it stays. 500 is a real session nobody names: it stays.
  const { fetchImpl } = listOf([parent(100, [101]), session(101), session(400), parent(500, [501]), session(501)]);
  const result = await make(fetchImpl).listSessions();
  assert.deepEqual(idsOf(result), ["100", "400", "500"]);
  assert.equal(result.drillsLeftOut, 2);
});

test("B1.4 an ambiguous page is refused with a stable code and no partial list: an entry named by two parents, a row naming itself, drills and drills_count that disagree, a non-canonical entry; an entry that names no listed row misclassifies nothing and is only counted", async () => {
  const cases = [
    ["named by two parents", [parent(100, [101]), parent(200, [101]), session(101)], "entry_named_twice"],
    ["a row naming itself", [parent(100, [100, 101]), session(101)], "self_reference"],
    ["drills longer than drills_count", [session(100, 980, { drills: [101, 102], drills_count: 1 }), session(101), session(102)], "drills_count_disagrees"],
    ["drills_count without entries", [session(100, 980, { drills: [], drills_count: 2 })], "drills_count_disagrees"],
  ];
  // A parent whose drill reference is on no row of the whole list (a drill outside the window,
  // or a reference that is not a list id): the parent stays, nothing is dropped, the reference is counted.
  const { fetchImpl: notListed } = listOf([parent(100, [101, 999]), session(101), session(300)]);
  const kept = await make(notListed).listSessions();
  assert.deepEqual(idsOf(kept), ["100", "300"]);
  assert.equal(kept.drillsLeftOut, 1);
  assert.equal(kept.drillReferencesNotListed, 1);
  for (const [label, rows, reason] of cases) {
    const { fetchImpl } = listOf(rows);
    const error = await make(fetchImpl).listSessions().then(() => null, (e) => e);
    assert.equal(error?.code, "source_list_ambiguous", label);
    assert.equal(error.reason, reason, label);
    assert.equal(error.sessions, undefined, "nothing of the list is returned");
  }
  for (const entries of [["x1"], [{ id: 101 }], [null], ["0101"], [1.5]]) {
    const { fetchImpl } = listOf([session(100, 980, { drills: entries, drills_count: 1 }), session(101)]);
    await assert.rejects(make(fetchImpl).listSessions(), code("source_answer_unexpected"), JSON.stringify(entries));
  }
});

test("B1.5 the existing fail-closed rules still come first: a foreign team, an unreadable team or a duplicate row refuse the whole list before any classification", async () => {
  for (const [rows, expected] of [
    [[parent(100, [101]), session(101, 981)], "source_team_mismatch"],
    [[parent(100, [101]), session(101, { id: 980 })], "source_answer_unexpected"],
    [[parent(100, [101]), session(101), session(101)], "source_list_changed"],
  ]) {
    const { fetchImpl } = listOf(rows);
    await assert.rejects(make(fetchImpl).listSessions(), code(expected));
  }
});

test("B1.6 the classification is made over the WHOLE list, across pages: a parent on page 2 whose drills are on page 1 is kept and its drills left out", async () => {
  const page1 = [session(101), session(102)];
  const page2 = [parent(100, [101, 102]), session(300)];
  const { calls, fetchImpl } = fakeServer({
    "/rest/v1/team_session/?team=980&limit=2": answer(200, page1, { "x-total-count": "4", link: '<https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=2&offset=2>; rel="next"' }),
    "/rest/v1/team_session/?team=980&limit=2&offset=2": answer(200, page2, { "x-total-count": "4" }),
  });
  const result = await make(fetchImpl).listSessions({ limit: 2 });
  assert.deepEqual(idsOf(result), ["100", "300"]);
  assert.equal(result.drillsLeftOut, 2);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// B2–B5. The eight proven reads, the narrow legacy drill read and the drill names.
// ---------------------------------------------------------------------------
const PLAYERS = (burst) => ({ 4711: { tot_burst_events: { unit: "number", value: burst }, tot_brake_events: { unit: "number", value: 1 }, total_distance: 1200.5 }, 4712: { tot_burst_events: 2 } });
const OPAQUE_TEAM = { zzzOpaqueKey: "https://evil.example/team/424242/" };
const details = (players, extra = {}) => ({ drills_count: 2, players, team: OPAQUE_TEAM, teamsession: 7777, ...extra });
const athleteRow = (id, athlete, extra = {}) => ({ id, athlete, track: 900 + (id % 10), teamsession: 100, drill: null, total_time: 2400, total_distance: 3000, max_v: 7.5, athlete_name: "Marker Athlete Name", ...extra });
const PARENT = "/rest/v1/team_session/100/";
const ATHLETES = "/rest/v1/athlete_session/?teamsession=100&limit=100";
const WHOLE = "/rest/v1/team_session/100/details/";
const D0 = "/api/team_session/100/details/?drill=0";
const D1 = "/api/team_session/100/details/?drill=1";
const BRIEF = "/api/team_session/100/brief/";
const TAGS = "/rest/v1/team_session_tag/?team=980&limit=100";
const THRESH = "/rest/v1/team/980/thresholds/?valid_on=2026-09-14";
// A date window reads the whole team list (owner decision 2026-10-08): the same request as LIST.
const WINDOW = LIST;
function fullRoutes(over = {}) {
  return {
    "/rest/v1/team/980/": answer(200, { id: 980, name: "FK Marker" }),
    [LIST]: answer(200, [parent(100, [101, 102]), session(101), session(102), session(200, 980, { start_timestamp: "2026-09-20T10:00:00" })], { "x-total-count": "4" }),
    [PARENT]: answer(200, { id: 100, team: 980, category_name: "Training", is_stats_valid: true, drills_count: 2, start_timestamp: "2026-09-14T10:00:00", end_timestamp: "2026-09-14T11:00:00", updated_on: "2026-09-14T12:00:00", drill: null, name: "Marker Session", notes: "private" }),
    [ATHLETES]: answer(200, [athleteRow(500, 4711), athleteRow(501, 4712, { track: 901 })], { "x-total-count": "2" }),
    "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711)),
    "/rest/v1/athlete_session/501/": answer(200, athleteRow(501, 4712, { track: 901 })),
    "/rest/v1/athlete_session/500/more/": answer(200, { athletesession_id: 500, events: { acceleration_events_count: "3" }, complementary_data: {} }),
    "/rest/v1/athlete_session/501/more/": answer(200, { athletesession_id: 501, events: {}, complementary_data: {} }),
    "/rest/v1/track/900/": answer(200, { id: 900, athlete: 4711, timezone: "Europe/Sarajevo", timestamp: "2026-09-14T09:50:00", utc_timestamp: 1789000000 }),
    "/rest/v1/track/901/": answer(200, { id: 901, athlete: 4712, timezone: "Europe/Sarajevo", timestamp: "2026-09-14T09:50:00", utc_timestamp: 1789000000 }),
    [WHOLE]: answer(200, details(PLAYERS(9))),
    [D0]: answer(200, details(PLAYERS(5), { teamsession: 101 })),
    [D1]: answer(200, details(PLAYERS(4), { teamsession: 102 })),
    [BRIEF]: answer(200, { id: 100, drillTags: [31, 32] }),
    [TAGS]: answer(200, [{ id: 31, name: "Rondo", team: 980 }, { id: 32, name: "Small-sided game", team: 980 }, { id: 33, name: "Unused", team: 980 }], { "x-total-count": "3" }),
    [THRESH]: answer(200, { id: 1473, team: 980, power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7] }),
    ...over,
  };
}
const full = (over) => fakeServer(fullRoutes(over));
const pathsOf = (calls) => calls.map((c) => { const u = new URL(c.url); return `${u.pathname}${u.search}`; });
const noNames = (value, extra = []) => {
  const text = JSON.stringify(value);
  for (const leak of ["Marker Athlete Name", "a private note", "private", "someone", "zzzOpaqueKey", "evil.example", "424242", CREDENTIAL, ...extra]) assert.ok(!text.includes(leak), leak);
};
const errorOf = (p) => p.then(() => null, (e) => e);
async function confirmedAdapter(over, make_ = make) {
  const server = full(over);
  const a = make_(server.fetchImpl);
  await a.listSessions();
  await a.getSession({ sessionId: "100" });
  // The rows are listed so that a row read is allowed; a fixture whose list is
  // meant to fail is exercised by the test itself through the operation.
  try { await a.listAthleteSessions({ sessionId: "100" }); } catch {}
  server.calls.length = 0;
  return { ...server, a };
}

test("B2.1 the eight reads, each a GET on server3 under /rest/v1/ for the bound team, hang off a session confirmed first; the bundle has the importer's shape, the drill set is complete, and no athlete name leaves the adapter", async () => {
  const { calls, fetchImpl } = full();
  const a = await primed(fetchImpl);
  const bundle = await a.fetchSessionBundle({ sessionId: "100" });
  assert.deepEqual(pathsOf(calls), [
    LIST, PARENT, ATHLETES, "/rest/v1/athlete_session/500/", "/rest/v1/athlete_session/500/more/", "/rest/v1/track/900/",
    "/rest/v1/athlete_session/501/", "/rest/v1/athlete_session/501/more/", "/rest/v1/track/901/",
    WHOLE, D0, D1, BRIEF, TAGS, THRESH,
  ]);
  assert.ok(calls.every((c) => c.method === "GET" && c.redirect === "manual" && c.headers.Authorization === `Token ${CREDENTIAL}` && new URL(c.url).origin === "https://server3.gpexe.com"));
  assert.equal(bundle.teamSession.id, 100);
  assert.equal(bundle.teamSession.notes, undefined, "the importer's drop list applies");
  assert.deepEqual(bundle.athleteSessions.map((r) => r.id), [500, 501]);
  assert.deepEqual(Object.keys(bundle.more), ["500", "501"]);
  assert.deepEqual(Object.keys(bundle.tracks), ["900", "901"]);
  assert.deepEqual(Object.keys(bundle.details.full.players), ["4711", "4712"]);
  assert.deepEqual(Object.keys(bundle.details.drills), ["0", "1"]);
  assert.equal(bundle.details.drills["0"].players["4711"].tot_burst_events.value, 5);
  assert.deepEqual(bundle.drillsStatus, { complete: true, drillsCount: 2, failed: null });
  assert.deepEqual(bundle.drillLabels, [
    { drillIndex: 0, label: "Rondo", tagId: "31", tagName: "Rondo", labelEvidence: "drill_tags" },
    { drillIndex: 1, label: "Small-sided game", tagId: "32", tagName: "Small-sided game", labelEvidence: "drill_tags" },
  ]);
  assert.equal(bundle.teamThresholds.id, 1473);
  noNames(bundle);
  // The window read: the proved encoding, every row inside the window, the same classification.
  const w = await a.listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.deepEqual(idsOf(w), ["100"]);
  assert.deepEqual([w.drillsLeftOut, w.fromDay, w.toDay, w.total, w.otherParentsLeftOut], [2, "2026-09-14", "2026-09-15", 4, 1]);
  assert.equal(pathsOf(calls).pop(), WINDOW);
});

test("B2.2 nothing without a confirmed parent: details, drills, athlete rows, thresholds, labels and the bundle's dependents refuse before any request; a session of another team never becomes confirmed", async () => {
  const { calls, fetchImpl } = full();
  const a = await primed(fetchImpl);
  const sent = calls.length;
  for (const op of ["getSessionDetails", "getSessionDrills", "listAthleteSessions", "getTeamThresholds", "getDrillLabels"]) {
    await assert.rejects(a[op]({ sessionId: "100" }), code("session_not_confirmed"), op);
  }
  await assert.rejects(a.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 }), code("session_not_confirmed"));
  await assert.rejects(a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("session_not_confirmed"));
  await assert.rejects(a.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(a.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  assert.equal(calls.length, sent, "nothing was sent");
  // A session of another team, or one that answers another id, is refused and does not confirm anything.
  const foreign = full({ [PARENT]: answer(200, { id: 100, team: 981, drills_count: 2, start_timestamp: "2026-09-14T10:00:00" }) });
  const b = await primed(foreign.fetchImpl);
  await assert.rejects(b.getSession({ sessionId: "100" }), code("source_team_mismatch"));
  await assert.rejects(b.getSessionDetails({ sessionId: "100" }), code("session_not_confirmed"));
  const other = full({ [PARENT]: answer(200, { id: 150, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00" }) });
  await assert.rejects((await primed(other.fetchImpl)).getSession({ sessionId: "100" }), code("source_answer_unexpected"));
  for (const team of [{ id: 980 }, "https://server3.gpexe.com/rest/v1/team/980/", null, undefined]) {
    const s = full({ [PARENT]: answer(200, { id: 100, team, drills_count: 2 }) });
    await assert.rejects((await primed(s.fetchImpl)).getSession({ sessionId: "100" }), code("source_answer_unexpected"), JSON.stringify(team));
  }
  // A confirmed session of 980 is not a confirmed session for an adapter bound to 981.
  const other981 = full();
  const bound981 = make(other981.fetchImpl, { boundSourceTeamId: "981" });
  await assert.rejects(bound981.listSessions(), (e) => e instanceof SourceAdapterError, "team 981 has no list here");
  await assert.rejects(bound981.getSession({ sessionId: "100" }), code("session_not_listed"));
  assert.ok(!other981.calls.some((c) => c.url.includes("/team_session/100/")), "the session of 980 is never asked for");
  // Ids are canonical or refused; a team option is refused everywhere.
  for (const bad of ["", "0100", "100 ", "x", null, {}, 1.5, "100&team=981"]) await assert.rejects(a.getSession({ sessionId: bad }), code("invalid_id"), JSON.stringify(bad));
  for (const op of ["getSession", "getSessionDetails", "getSessionDrills", "listAthleteSessions", "getTeamThresholds", "getDrillLabels", "fetchSessionBundle", "listSessionsByDay", "listSessionTags"]) {
    await assert.rejects(a[op]({ sessionId: "100", team: "981" }), code("team_param_not_allowed"), op);
    await assert.rejects(a[op]({ sessionId: "100", TeamId: "981" }), code("team_param_not_allowed"), op);
  }
  await assert.rejects(a.getSession({ sessionId: "100", url: "https://evil.example/" }), code("invalid_options"));
});

test("B2.3 athlete rows: whole or refused, every row of the confirmed session; a row of another session, a foreign next page, an unknown athlete id, a detail of another row or session, events of another row, a track not named by a confirmed row — all refused", async () => {
  const { a } = await confirmedAdapter();
  const rows = await a.listAthleteSessions({ sessionId: "100" });
  assert.deepEqual(rows.rows.map((r) => r.id), [500, 501]);
  assert.equal(rows.rows[0].athlete_name, undefined);
  const cases = [
    ["a row of another session", { [ATHLETES]: answer(200, [athleteRow(500, 4711), athleteRow(502, 4713, { teamsession: 200 })], { "x-total-count": "2" }) }, "listAthleteSessions", { sessionId: "100" }, "source_answer_unexpected"],
    ["an athlete id in an unknown shape", { [ATHLETES]: answer(200, [athleteRow(500, { id: 4711 })], { "x-total-count": "1" }) }, "listAthleteSessions", { sessionId: "100" }, "source_answer_unexpected"],
    ["no total", { [ATHLETES]: answer(200, [athleteRow(500, 4711)]) }, "listAthleteSessions", { sessionId: "100" }, "source_answer_unexpected"],
    ["a foreign next page", { [ATHLETES]: answer(200, [athleteRow(500, 4711)], { "x-total-count": "2", link: '<https://server3.gpexe.com/rest/v1/athlete_session/?teamsession=200&limit=100&offset=1>; rel="next"' }) }, "listAthleteSessions", { sessionId: "100" }, "source_answer_unexpected"],
    ["a detail of another row", { "/rest/v1/athlete_session/500/": answer(200, athleteRow(501, 4712)) }, "getAthleteSession", { sessionId: "100", athleteSessionId: "500" }, "source_answer_unexpected"],
    ["a detail of another session", { "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711, { teamsession: 200 })) }, "getAthleteSession", { sessionId: "100", athleteSessionId: "500" }, "source_answer_unexpected"],
    ["a track in an unknown shape", { "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711, { track: "https://evil.example/track/900/" })) }, "getAthleteSession", { sessionId: "100", athleteSessionId: "500" }, "source_answer_unexpected"],
  ];
  for (const [label, over, op, options, expected] of cases) {
    const { a: b } = await confirmedAdapter(over);
    await assert.rejects(b[op](options), code(expected), label);
  }
  // The chain: a row read under the session makes its events and its track readable; nothing else.
  const { a: c, calls } = await confirmedAdapter();
  await assert.rejects(c.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  const row = await c.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  assert.equal(row.athlete_name, undefined);
  const more = await c.getAthleteSessionMore({ athleteSessionId: "500" });
  assert.equal(more.athletesession_id, 500);
  await assert.rejects(c.getAthleteSessionMore({ athleteSessionId: "501" }), code("athlete_row_not_confirmed"));
  assert.equal((await c.getTrack({ trackId: "900" })).timezone, "Europe/Sarajevo");
  await assert.rejects(c.getTrack({ trackId: "901" }), code("track_not_confirmed"));
  await assert.rejects(c.getTrack({ trackId: "999" }), code("track_not_confirmed"));
  // Events that name another row, a track that answers another id.
  const { a: d } = await confirmedAdapter({ "/rest/v1/athlete_session/500/more/": answer(200, { athletesession_id: 501 }) });
  await d.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  await assert.rejects(d.getAthleteSessionMore({ athleteSessionId: "500" }), code("source_answer_unexpected"));
  const { a: e } = await confirmedAdapter({ "/rest/v1/track/900/": answer(200, { id: 901 }) });
  await e.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  await assert.rejects(e.getTrack({ trackId: "900" }), code("source_answer_unexpected"));
  // A paged athlete list on the same session is followed; a second page of another session is not.
  const paged = fakeServer(fullRoutes({
    [ATHLETES]: answer(200, [athleteRow(500, 4711)], { "x-total-count": "2", link: '<https://server3.gpexe.com/rest/v1/athlete_session/?teamsession=100&limit=100&offset=1>; rel="next"' }),
    "/rest/v1/athlete_session/?teamsession=100&limit=100&offset=1": answer(200, [athleteRow(501, 4712)], { "x-total-count": "2" }),
  }));
  const f = await primed(paged.fetchImpl);
  await f.getSession({ sessionId: "100" });
  assert.deepEqual((await f.listAthleteSessions({ sessionId: "100" })).rows.map((r) => r.id), [500, 501]);
  assert.ok(!calls.some((x) => x.url.includes("teamsession=200")));
});

test("B2.4 the date window: two calendar days, forward, at most 31 days; the WHOLE team list is read (never a server-side date filter) and the window is picked out locally; the same parent/drill classification and the same team rules apply", async () => {
  const { a, calls } = await confirmedAdapter();
  for (const bad of [{ fromDay: "2026-09-14" }, { toDay: "2026-09-14" }, { fromDay: "2026-9-14", toDay: "2026-09-15" }, { fromDay: "2026-02-30", toDay: "2026-03-01" }, { fromDay: "2026-09-15", toDay: "2026-09-14" }, { fromDay: "2026-09-01", toDay: "2026-10-02" }, { fromDay: "2026-09-14", toDay: "2026-09-15", limit: 5 }, { fromDay: "2026-09-14 00:00:00", toDay: "2026-09-15" }, { fromDay: "2026-09-14%2000", toDay: "2026-09-15" }]) {
    await assert.rejects(a.listSessionsByDay(bad), code("invalid_options"), JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, "nothing was sent for a bad window");
  const ok = await a.listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.deepEqual(idsOf(ok), ["100"]);
  const sent = new URL(calls[calls.length - 1].url);
  assert.equal(sent.search, "?team=980&limit=100", "no date bound is ever sent");
  assert.ok(!calls.some((c) => c.url.includes("start_timestamp")), "the server-side date filter is never used");
  // Exactly 31 days is allowed, 32 is not (the whole list either way).
  assert.deepEqual(idsOf(await make(full().fetchImpl).listSessionsByDay({ fromDay: "2026-09-01", toDay: "2026-10-01" })), ["100", "200"]);
  // A row outside the window is left out locally, not refused.
  const outside = full({ [WINDOW]: answer(200, [parent(100, [101, 102]), session(101), session(102), session(200, 980, { start_timestamp: "2026-09-20T10:00:00" })], { "x-total-count": "4" }) });
  const o = await make(outside.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.deepEqual([idsOf(o), o.otherParentsLeftOut], [["100"], 1]);
  const noDay = full({ [WINDOW]: answer(200, [session(300, 980, { start_timestamp: null })], { "x-total-count": "1" }) });
  await assert.rejects(make(noDay.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" }), code("source_session_start_unreadable"));
  const foreign = full({ [WINDOW]: answer(200, [session(300, 981)], { "x-total-count": "1" }) });
  await assert.rejects(make(foreign.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" }), code("source_team_mismatch"));
  const ambiguousPage = full({ [WINDOW]: answer(200, [parent(100, [101]), parent(200, [101]), session(101)], { "x-total-count": "3" }) });
  await assert.rejects(make(ambiguousPage.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" }), code("source_list_ambiguous"));
  // A next page: the page size and the offset only.
  const paged = fakeServer(fullRoutes({
    [WINDOW]: answer(200, [parent(100, [101, 102]), session(101)], { "x-total-count": "3", link: '<https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=100&offset=2>; rel="next"' }),
    [`${WINDOW}&offset=2`]: answer(200, [session(102)], { "x-total-count": "3" }),
  }));
  assert.deepEqual(idsOf(await make(paged.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" })), ["100"]);
  assert.equal(paged.calls.length, 4, "two complete reads of two pages");
});

test("B2.5 thresholds: read for the confirmed session's day only, null on 404, refused for another team or an unknown shape; and a 404 elsewhere stays a refusal", async () => {
  const { a, calls } = await confirmedAdapter();
  assert.equal((await a.getTeamThresholds({ sessionId: "100" })).id, 1473);
  assert.ok(calls.some((c) => c.url.endsWith(THRESH)));
  const none = await confirmedAdapter({ [THRESH]: answer(404, { detail: "Not found." }) });
  assert.equal(await none.a.getTeamThresholds({ sessionId: "100" }), null);
  const foreign = await confirmedAdapter({ [THRESH]: answer(200, { id: 1, team: 981 }) });
  await assert.rejects(foreign.a.getTeamThresholds({ sessionId: "100" }), code("source_team_mismatch"));
  const odd = await confirmedAdapter({ [THRESH]: answer(200, [{ id: 1 }]) });
  await assert.rejects(odd.a.getTeamThresholds({ sessionId: "100" }), code("source_answer_unexpected"));
  const noDay = await confirmedAdapter({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 2 }) });
  await assert.rejects(noDay.a.getTeamThresholds({ sessionId: "100" }), code("source_answer_unexpected"));
  const missingDetails = await confirmedAdapter({ [WHOLE]: answer(404, { detail: "Not found." }) });
  await assert.rejects(missingDetails.a.getSessionDetails({ sessionId: "100" }), code("source_not_found"));
});

test("B3.1 the legacy drill URL builder: exactly one host, one path, one query parameter; the first and the last index pass; every other input is refused and nothing else can be built", async () => {
  const { legacyDrillDetailsUrl, legacyBriefUrl } = await import("../src/gpexeRestV1Adapter.js");
  const base = { hostKey: "server3", catalogRow: row("server3"), parentId: "100", drillsCount: 3 };
  assert.equal(legacyDrillDetailsUrl({ ...base, drillIndex: 0 }), "https://server3.gpexe.com/api/team_session/100/details/?drill=0");
  assert.equal(legacyDrillDetailsUrl({ ...base, drillIndex: 2 }), "https://server3.gpexe.com/api/team_session/100/details/?drill=2");
  assert.equal(legacyDrillDetailsUrl({ ...base, parentId: 100, drillIndex: 1 }), "https://server3.gpexe.com/api/team_session/100/details/?drill=1");
  assert.equal(legacyBriefUrl({ hostKey: "server3", catalogRow: row("server3"), parentId: "100" }), "https://server3.gpexe.com/api/team_session/100/brief/");
  const refused = [
    [{ ...base, drillsCount: 0, drillIndex: 0 }, "drills_count_out_of_range", "drills_count = 0"],
    [{ ...base, drillsCount: 31, drillIndex: 0 }, "drills_count_out_of_range", "more than MAX_DRILLS"],
    [{ ...base, drillsCount: "3", drillIndex: 0 }, "drills_count_out_of_range", "a count as text"],
    [{ ...base, drillIndex: -1 }, "invalid_drill_index", "negative"],
    [{ ...base, drillIndex: 3 }, "invalid_drill_index", "index == drills_count"],
    [{ ...base, drillIndex: 1.5 }, "invalid_drill_index", "decimal"],
    [{ ...base, drillIndex: "0" }, "invalid_drill_index", "a string"],
    [{ ...base, drillIndex: null }, "invalid_drill_index", "null"],
    [{ ...base, drillIndex: undefined }, "invalid_drill_index", "undefined"],
    [{ ...base, drillIndex: {} }, "invalid_drill_index", "an object"],
    [{ ...base, drillIndex: 1e9 }, "invalid_drill_index", "too large"],
    [{ ...base, drillIndex: Number.NaN }, "invalid_drill_index", "NaN"],
    [{ ...base, parentId: "0100", drillIndex: 0 }, "invalid_id", "a leading zero"],
    [{ ...base, parentId: "100/../101", drillIndex: 0 }, "invalid_id", "a dotted parent"],
    [{ ...base, parentId: "100?drill=1", drillIndex: 0 }, "invalid_id", "a query in the parent"],
    [{ ...base, parentId: "100#x", drillIndex: 0 }, "invalid_id", "a fragment in the parent"],
    [{ ...base, parentId: "https://evil.example/100", drillIndex: 0 }, "invalid_id", "an absolute URL as parent"],
    [{ ...base, parentId: "//evil.example/100", drillIndex: 0 }, "invalid_id", "a protocol-relative URL as parent"],
    [{ ...base, parentId: "100%2F..%2F101", drillIndex: 0 }, "invalid_id", "an encoded traversal"],
    [{ ...base, parentId: ["100"], drillIndex: 0 }, "invalid_id", "a list"],
    [{ ...base, hostKey: "e03", catalogRow: row("e03"), drillIndex: 0 }, "path_not_allowed", "another host key"],
    [{ ...base, hostKey: "server4", catalogRow: row("server4"), drillIndex: 0 }, "host_not_allowed", "an unknown host"],
    [{ ...base, hostKey: "https://server3.gpexe.com/", catalogRow: row("https://server3.gpexe.com/"), drillIndex: 0 }, "host_not_allowed", "a URL as host key"],
    [{ ...base, catalogRow: row("server3", "retired"), drillIndex: 0 }, "host_not_allowed", "a retired row"],
    [{ ...base, catalogRow: null, drillIndex: 0 }, "host_not_allowed", "no row"],
    [{ ...base, catalogRow: row("e03"), drillIndex: 0 }, "host_not_allowed", "another key's row"],
  ];
  for (const [input, expected, label] of refused) {
    assert.throws(() => legacyDrillDetailsUrl(input), code(expected), label);
  }
  for (const [input, expected] of [[{ hostKey: "e03", catalogRow: row("e03"), parentId: "100" }, "path_not_allowed"], [{ hostKey: "server3", catalogRow: row("server3"), parentId: "x" }, "invalid_id"], [{ hostKey: "server3", catalogRow: null, parentId: "100" }, "host_not_allowed"]]) {
    assert.throws(() => legacyBriefUrl(input), code(expected));
  }
  // The builders take no path, no URL, no family and no extra query: there is no parameter for them.
  assert.equal(legacyDrillDetailsUrl({ ...base, drillIndex: 0, path: "../../", url: "https://evil.example/", family: "api", query: "&x=1" }), "https://server3.gpexe.com/api/team_session/100/details/?drill=0");
});

test("B3.2 the adapter sends the legacy reads only through the builders: never for an index outside drills_count, never with a drills entry, never with a caller's path", async () => {
  const { a, calls } = await confirmedAdapter();
  await assert.rejects(a.getSessionDrillDetails({ sessionId: "100", drillIndex: 2 }), code("invalid_drill_index"));
  await assert.rejects(a.getSessionDrillDetails({ sessionId: "100", drillIndex: "0" }), code("invalid_drill_index"));
  await assert.rejects(a.getSessionDrillDetails({ sessionId: "100", drillIndex: 0, path: "../" }), code("invalid_options"));
  assert.ok(!calls.some((c) => c.url.includes("/api/")), "no legacy request yet");
  const d1 = await a.getSessionDrillDetails({ sessionId: "100", drillIndex: 1 });
  assert.equal(pathsOf(calls).pop(), D1);
  assert.equal(d1.players["4711"].tot_burst_events.value, 4);
  // A confirmed parent with no drills: no drill read at all.
  const none = await confirmedAdapter({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 0, start_timestamp: "2026-09-14T10:00:00" }) });
  await assert.rejects(none.a.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 }), code("invalid_drill_index"));
  assert.deepEqual(await none.a.getSessionDrills({ sessionId: "100" }), { complete: true, drillsCount: 0, drills: [], failed: null });
  assert.deepEqual(await none.a.getDrillLabels({ sessionId: "100" }), []);
  assert.ok(!none.calls.some((c) => c.url.includes("/api/")));
  // One drill: index 0 is the last.
  const one = await confirmedAdapter({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 1, start_timestamp: "2026-09-14T10:00:00" }), [D0]: answer(200, details(PLAYERS(5), { drills_count: 1 })) });
  const set = await one.a.getSessionDrills({ sessionId: "100" });
  assert.deepEqual([set.complete, set.drills.map((d) => d.drillIndex)], [true, [0]]);
  assert.ok(!one.calls.some((c) => c.url.includes("drill=1")));
  // drills_count beyond the bound is refused at the session read.
  const many = full({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 31, start_timestamp: "2026-09-14T10:00:00" }) });
  await assert.rejects((await primed(many.fetchImpl)).getSession({ sessionId: "100" }), code("drills_count_out_of_range"));
});

test("B4.1 a drill answer is accepted only as a 200 JSON object whose players is a map of canonical athlete ids with metric values; its team and teamsession are not read as identity; since 2026-10-09 it is projected like the whole session: only the consumed fields leave, an unconsumed metric of any shape is dropped", async () => {
  const good = details(PLAYERS(5), { team: OPAQUE_TEAM, teamsession: 424242 });
  const { a } = await confirmedAdapter({ [D0]: answer(200, good) });
  const d = await a.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 });
  assert.deepEqual(Object.keys(d.players), ["4711", "4712"]);
  for (const values of Object.values(d.players)) assert.ok(Object.keys(values).every((k) => DETAILS_CONSUMED_FIELDS.includes(k)), JSON.stringify(values));
  noNames(d, ["Marker"]);
  // An unconsumed metric that is free text, nested, a list or an object of other keys is dropped, not refused.
  for (const [label, extra] of [["free text", { note: "Marker Athlete Name scored" }], ["nested", { zones: { z1: { v: 1 } } }], ["a list", { zones: [1, 2] }], ["an object of other keys", { obj: { k1: null, k2: 2, k3: "ok", k4: "free text", k5: 5 } }]]) {
    const { a: b } = await confirmedAdapter({ [D0]: answer(200, details({ 4711: { tot_burst_events: { unit: "number", value: 3 }, ...extra } })) });
    assert.deepEqual((await b.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 })).players, { 4711: { tot_burst_events: { unit: "number", value: 3 } } }, label);
  }
  const refused = [
    ["no players", { drills_count: 2, team: 980 }, "players_missing"],
    ["players a list", { players: [{ id: 4711 }] }, "players_missing"],
    ["a non-canonical athlete key", { players: { "0471": { a: 1 } } }, "athlete_id_not_canonical"],
    ["a name as athlete key", { players: { "Marker Athlete Name": { a: 1 } } }, "athlete_id_not_canonical"],
    ["a URL as athlete key", { players: { "https://evil.example/4711": { a: 1 } } }, "athlete_id_not_canonical"],
    ["a too long numeric key", { players: { "4711471147114": { a: 1 } } }, "athlete_id_not_canonical"],
    ["an athlete without values", { players: { 4711: {} } }, "player_values_missing"],
    ["an athlete with a list", { players: { 4711: [1, 2] } }, "player_values_missing"],
    ["a metric with a bad name", { players: { 4711: { "tot burst": 1 } } }, "metric_name_unknown"],
    ["a consumed field as free text", { players: { 4711: { tot_burst_events: "Marker Athlete Name" } } }, "consumed_field_shape_unknown"],
    ["a consumed field as a list", { players: { 4711: { tot_brake_events: [1, 2] } } }, "consumed_field_shape_unknown"],
    ["a consumed field nested too deep", { players: { 4711: { tot_burst_events: { unit: "number", value: { v: 1 } } } } }, "consumed_field_shape_unknown"],
  ];
  for (const [label, body, reason] of refused) {
    const { a: b } = await confirmedAdapter({ [D0]: answer(200, body) });
    const error = await errorOf(b.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 }));
    assert.equal(error?.code, "source_answer_unexpected", label);
    assert.equal(error.reason, reason, label);
    noNames({ ...error, message: error.message });
  }
  // A list body, invalid JSON, an empty body, a JSON primitive.
  for (const [label, resp] of [["a list body", answer(200, [details(PLAYERS(1))])], ["invalid JSON", answer(200, "{not json")], ["an empty body", answer(200, "")], ["a JSON primitive", answer(200, "42")]]) {
    const { a: b } = await confirmedAdapter({ [D0]: resp });
    await assert.rejects(b.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 }), code("source_answer_unexpected"), label);
  }
  // The same validation guards the whole-session details.
  const { a: w } = await confirmedAdapter({ [WHOLE]: answer(200, { players: [] }) });
  await assert.rejects(w.getSessionDetails({ sessionId: "100" }), code("source_answer_unexpected"));
});

test("B4.2 statuses and transport on a drill read: 401 and 403 end the whole operation; 404, 429, 5xx, a redirect, a timeout, an oversized or broken body end that drill only — the set is then not complete, nothing of a body leaks, no other index, host or form is tried", async () => {
  const MiB = 1024 * 1024;
  const streamedBody = (chunks, headers = {}) => ({ status: 200, headers: new Headers({ ...json, ...headers }), body: streamOf(chunks), text: async () => { throw new Error("whole body"); } });
  const bigChunks = () => [bytesOf('{"players":{"4711":{"a":'), new Uint8Array(5 * MiB).fill(0x31), bytesOf("}}}")];
  const perDrill = [
    ["404", () => answer(404, { detail: "Not found. Marker Athlete Name" }), "source_not_found"],
    ["429", () => answer(429, "slow down"), "source_unavailable"],
    ["500", () => answer(500, "<html>Marker Athlete Name</html>"), "source_unavailable"],
    ["503", () => answer(503, ""), "source_unavailable"],
    ["a redirect", () => ({ status: 302, headers: new Headers({ location: "https://evil.example/" }), body: null }), "source_answer_unexpected"],
    ["418", () => answer(418, ""), "source_answer_unexpected"],
    ["an announced oversize", () => answer(200, "{}", { "content-length": String(MAX_ANSWER_BYTES + 1) }), "source_answer_unexpected"],
    ["one byte over the limit, chunked", () => streamedBody(bigChunks()), "source_answer_unexpected"],
    ["a falsely small content-length", () => streamedBody(bigChunks(), { "content-length": "10" }), "source_answer_unexpected"],
    ["a body without a stream", () => ({ status: 200, headers: new Headers(json), body: "{}", text: async () => "{}" }), "source_answer_unexpected"],
    ["a broken stream", () => ({ status: 200, headers: new Headers(json), body: new ReadableStream({ pull(c) { c.error(new Error("reset Marker Athlete Name")); } }) }), "source_unavailable"],
    ["a timeout", () => (u, init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }), "source_unavailable"],
  ];
  for (const [label, resp, expected] of perDrill) {
    const { a, calls } = await confirmedAdapter({ [D0]: resp() }, (f) => make(f, { timeoutMs: 50 }));
    const single = await errorOf(a.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 }));
    assert.equal(single?.code, expected, label);
    noNames({ ...single, message: single.message });
    const { a: b, calls: calls2 } = await confirmedAdapter({ [D0]: resp() }, (f) => make(f, { timeoutMs: 50 }));
    const set = await b.getSessionDrills({ sessionId: "100" });
    assert.deepEqual([set.complete, set.drills.length, set.failed], [false, 0, { drillIndex: 0, code: expected }], label);
    assert.ok(!calls.some((c) => c.url.includes("drill=1")) && !calls2.some((c) => c.url.includes("drill=1")), `${label}: the next index is not tried`);
    assert.ok([...calls, ...calls2].every((c) => new URL(c.url).origin === "https://server3.gpexe.com" && !c.url.includes("/rest/v1/team_session/100/details/?drill")), `${label}: no other host or form`);
    // The whole-session data are untouched by the drill failure; the labels are still read.
    const { a: c } = await confirmedAdapter({ [D0]: resp() }, (f) => make(f, { timeoutMs: 50 }));
    const bundle = await c.fetchSessionBundle({ sessionId: "100" });
    assert.deepEqual(bundle.drillsStatus, { complete: false, drillsCount: 2, failed: { drillIndex: 0, code: expected } }, label);
    assert.deepEqual(Object.keys(bundle.details.full.players), ["4711", "4712"]);
    assert.deepEqual(bundle.details.drills, {});
    assert.equal(bundle.drillLabels.length, 2);
    noNames(bundle);
  }
  // A failure on the second drill keeps the first and is not complete.
  const { a: second } = await confirmedAdapter({ [D1]: answer(503, "") });
  const set2 = await second.getSessionDrills({ sessionId: "100" });
  assert.deepEqual([set2.complete, set2.drills.map((d) => d.drillIndex), set2.failed], [false, [0], { drillIndex: 1, code: "source_unavailable" }]);
  // A body exactly at the limit is read whole.
  // Padding is JSON whitespace between tokens, so the body is valid at exactly the limit.
  const head = '{"players":{"4711":{"tot_burst_events":{"unit":"number","value":1}}}';
  const tail = "}";
  const exact = `${head}${" ".repeat(MAX_ANSWER_BYTES - head.length - tail.length)}${tail}`;
  assert.equal(new TextEncoder().encode(exact).byteLength, MAX_ANSWER_BYTES);
  const { a: atLimit } = await confirmedAdapter({ [D0]: streamedBody([bytesOf(exact.slice(0, MiB)), bytesOf(exact.slice(MiB))]) });
  const okAtLimit = await atLimit.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 });
  assert.equal(okAtLimit.players["4711"].tot_burst_events.value, 1);
  // Global refusals end the whole operation and the bundle.
  for (const [status, expected] of [[401, "source_auth_rejected"], [403, "source_access_refused"]]) {
    const { a } = await confirmedAdapter({ [D0]: answer(status, "") });
    await assert.rejects(a.getSessionDrills({ sessionId: "100" }), code(expected));
    await assert.rejects(a.fetchSessionBundle({ sessionId: "100" }), code(expected));
  }
});

test("B5.1 drill names: drillTags of the parent's brief, mapped by zero-based position and translated through the bound team's tag catalogue; everything else is Drill N — never a tag of another team, never a guess, never the day's other sessions", async () => {
  const label = (labels) => labels.map((l) => [l.drillIndex, l.label, l.tagId, l.labelEvidence]);
  const fb = (n) => Array.from({ length: n }, (_, i) => [i, `Drill ${i + 1}`, null, "index_fallback"]);
  // Shape A, positional.
  const { a, calls } = await confirmedAdapter();
  assert.deepEqual(label(await a.getDrillLabels({ sessionId: "100" })), [[0, "Rondo", "31", "drill_tags"], [1, "Small-sided game", "32", "drill_tags"]]);
  assert.deepEqual(pathsOf(calls).slice(-2), [BRIEF, TAGS]);
  // Shape B, explicit { drill, tag }, in any order.
  const b = await confirmedAdapter({ [BRIEF]: answer(200, { drillTags: [{ drill: 1, tag: 32 }, { drill: 0, tag: "31" }] }) });
  assert.deepEqual(label(await b.a.getDrillLabels({ sessionId: "100" })), [[0, "Rondo", "31", "drill_tags"], [1, "Small-sided game", "32", "drill_tags"]]);
  // A position without a tag falls back on its own.
  const partial = await confirmedAdapter({ [BRIEF]: answer(200, { drillTags: [31, null] }) });
  assert.deepEqual(label(await partial.a.getDrillLabels({ sessionId: "100" })), [[0, "Rondo", "31", "drill_tags"], [1, "Drill 2", null, "index_fallback"]]);
  const fallbacks = [
    ["drillTags missing", { id: 100 }],
    ["drillTags null", { drillTags: null }],
    ["drillTags an object", { drillTags: { 0: 31, 1: 32 } }],
    ["a string", { drillTags: "31,32" }],
    ["fewer than drills_count", { drillTags: [31] }],
    ["more than drills_count", { drillTags: [31, 32, 33] }],
    ["a duplicate tag at two positions", { drillTags: [31, 31] }],
    ["an unreadable entry", { drillTags: [31, { name: "Rondo" }] }],
    ["shape B with an index out of range", { drillTags: [{ drill: 2, tag: 31 }] }],
    ["shape B with a decimal index", { drillTags: [{ drill: 0.5, tag: 31 }] }],
    ["shape B with the same drill twice", { drillTags: [{ drill: 0, tag: 31 }, { drill: 0, tag: 32 }] }],
    ["shape B without a tag", { drillTags: [{ drill: 0 }] }],
    ["an unknown tag id", { drillTags: [34, 35] }],
  ];
  // A tag id that is there but not canonical, or a brief of another session, is a refusal, never a label (external review 2026-10-03).
  for (const [what, brief, reason] of [
    ["a URL entry", { drillTags: ["https://evil.example/tag/31", 32] }, "tag_id_not_canonical"],
    ["shape B with a name instead of an id", { drillTags: [{ drill: 0, tag: "Rondo" }] }, "tag_id_not_canonical"],
    ["a brief of another session", { id: 150, drillTags: [31, 32] }, "brief_of_another_session"],
  ]) {
    const s = await confirmedAdapter({ [BRIEF]: answer(200, brief) });
    const e = await errorOf(s.a.getDrillLabels({ sessionId: "100" }));
    assert.equal(e?.code, "source_answer_unexpected", what);
    assert.equal(e.reason, reason, what);
  }
  for (const [what, brief] of fallbacks) {
    const s = await confirmedAdapter({ [BRIEF]: answer(200, brief) });
    assert.deepEqual(label(await s.a.getDrillLabels({ sessionId: "100" })), fb(2), what);
  }
  // A missing or unreachable brief is a fallback; an unreadable or wrong-shaped brief and a refused credential are errors (external review 2026-10-03).
  for (const [what, resp] of [["404", answer(404, {})], ["500", answer(500, "")]]) {
    const s = await confirmedAdapter({ [BRIEF]: resp });
    assert.deepEqual(label(await s.a.getDrillLabels({ sessionId: "100" })), fb(2), what);
  }
  for (const [what, resp] of [["not JSON", answer(200, "<html>")], ["a list", answer(200, [31, 32])]]) {
    const s = await confirmedAdapter({ [BRIEF]: resp });
    await assert.rejects(s.a.getDrillLabels({ sessionId: "100" }), code("source_answer_unexpected"), what);
  }
  const denied = await confirmedAdapter({ [BRIEF]: answer(401, "") });
  await assert.rejects(denied.a.getDrillLabels({ sessionId: "100" }), code("source_auth_rejected"));
  // The tag catalogue: a tag of another team refuses the list; a tag without a usable name falls back; a tag in an unknown team shape refuses.
  const foreignTag = await confirmedAdapter({ [TAGS]: answer(200, [{ id: 31, name: "Rondo", team: 981 }], { "x-total-count": "1" }) });
  await assert.rejects(foreignTag.a.getDrillLabels({ sessionId: "100" }), code("source_team_mismatch"));
  const oddTag = await confirmedAdapter({ [TAGS]: answer(200, [{ id: 31, name: "Rondo", team: { id: 980 } }], { "x-total-count": "1" }) });
  await assert.rejects(oddTag.a.getDrillLabels({ sessionId: "100" }), code("source_answer_unexpected"));
  const blankTag = await confirmedAdapter({ [TAGS]: answer(200, [{ id: 31, name: "   ", team: 980 }, { id: 32, name: "x".repeat(81), team: 980 }], { "x-total-count": "2" }) });
  assert.deepEqual(label(await blankTag.a.getDrillLabels({ sessionId: "100" })), fb(2));
  const tagList = await a.listSessionTags();
  assert.deepEqual([...tagList.tags.entries()], [["31", "Rondo"], ["32", "Small-sided game"], ["33", "Unused"]]);
  // Never the day's other sessions: the labels come from one brief and one tag list, and no other session is read.
  const dayWithTaggedSessions = await confirmedAdapter({ [LIST]: answer(200, [parent(100, [101, 102]), session(101), session(102), session(300, 980, { tags: [31] }), session(301, 980, { tags: [32] })], { "x-total-count": "5" }) });
  await dayWithTaggedSessions.a.getDrillLabels({ sessionId: "100" });
  assert.ok(!dayWithTaggedSessions.calls.some((c) => /team_session\/(300|301)\//.test(c.url) || c.url.includes("start_timestamp")));
  assert.deepEqual(pathsOf(dayWithTaggedSessions.calls), [BRIEF, TAGS]);
  // The labels carry no name of an athlete and no source text.
  noNames(await a.getDrillLabels({ sessionId: "100" }));
});

test("B5.2 parseDrillTags on its own: the two candidate shapes and nothing else", async () => {
  const { parseDrillTags } = await import("../src/gpexeRestV1Adapter.js");
  const m = (v, n) => { const r = parseDrillTags(v, n); return r === null ? null : [...r.entries()]; };
  assert.deepEqual(m([31, 32], 2), [[0, "31"], [1, "32"]]);
  assert.deepEqual(m(["31", null], 2), [[0, "31"]]);
  assert.deepEqual(m([null, null], 2), []);
  assert.deepEqual(m([{ drill: 1, tag: 32 }], 2), [[1, "32"]]);
  assert.deepEqual(m([], 0), []);
  for (const [v, n] of [[[31], 2], [[31, 32, 33], 2], [[31, 31], 2], [[{ drill: 0, tag: 31 }, { drill: 1, tag: 31 }], 2], [[{ drill: "0", tag: 31 }], 2], [[{ drill: 0, tag: 31 }, 32], 2], ["31", 1], [{ 0: 31 }, 1], [null, 1], [[31], -1], [[31], 1.5]]) {
    assert.equal(m(v, n), null, JSON.stringify([v, n]));
  }
  // A non-canonical tag id in either shape is a refusal, not an unknown shape.
  for (const [v, n] of [[[0.5], 1], [[-1], 1], [["007"], 1], [[{ drill: 0, tag: "x" }], 1]]) {
    assert.throws(() => parseDrillTags(v, n), (e) => e.code === "source_answer_unexpected" && e.reason === "tag_id_not_canonical", JSON.stringify([v, n]));
  }
});

test("B6. regression: the capabilities say what is implemented, the e03 importer and the host allowlist are untouched, and nothing writes", async () => {
  const { a } = await confirmedAdapter();
  const declared = a.capabilities();
  assert.deepEqual(declared.session_list, { status: "proven", available: true });
  assert.deepEqual(declared.session_list_by_date, { status: "unknown", available: false }, "the server-side date filter is not trusted (owner decision 2026-10-08)");
  for (const name of ["session_read", "session_details", "athlete_session_list", "athlete_session_read", "athlete_session_more", "track_read", "team_thresholds"]) assert.deepEqual(declared[name], { status: "proven", available: true }, name);
  assert.deepEqual(declared.session_drill_details, { status: "observed", available: true });
  assert.deepEqual(declared.session_tags, { status: "observed", available: true });
  assert.deepEqual(declared.units, { status: "unknown", available: false });
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hosts = await fsp.readFile(path.resolve(ROOT, "backend/src/sourceHosts.js"), "utf8");
  assert.match(hosts, /server3: Object\.freeze\(\{\s*baseUrl: "https:\/\/server3\.gpexe\.com\/", label: "GPEXE server3",\s*apiFamily: "rest_v1"/);
  assert.doesNotMatch(hosts, /brief|drill/, "the host profile knows nothing of drills");
  const client = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeClient.js"), "utf8");
  assert.match(client, /export const GPEXE_API_BASE = "https:\/\/e03\.gpexe\.com\/api\/";/);
  assert.match(client, /team_session\/\$\{id\}\/details\/\?drill=\$\{index\}/, "the e03 importer's own drill form is unchanged");
  assert.doesNotMatch(client, /sourceAdapters|gpexeRestV1Adapter|sourceHosts|legacyDrill/);
  const adapterSource = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8");
  assert.doesNotMatch(adapterSource, /\bpg\b|pool\.query|INSERT|UPDATE|DELETE FROM|process\.env|require\(/, "no database, no environment");
});

test("B6b. the one widening of the host path rule is exactly two percent sequences in a query value, %20 and %3A: every other percent sequence, in a value or a segment, is still refused", async () => {
  const { sourceApiUrl } = await import("../src/sourceHosts.js");
  const r = row("server3");
  assert.equal(sourceApiUrl("gpexe", "server3", r, "team_session/?team=980&start_timestamp_gte=2026-09-13%2000%3A00%3A00&limit=100"), "https://server3.gpexe.com/rest/v1/team_session/?team=980&start_timestamp_gte=2026-09-13%2000%3A00%3A00&limit=100");
  for (const bad of ["team/?a=%2F", "team/?a=%25", "team/?a=%00", "team/?a=%2e%2e", "team/?a=%20%2F", "team/?a=%3a", "team/?a=%2520", "team/?a=%", "team/?a=%2", "team%20/?a=1", "team/%2e%2e/?a=1", "team/?a%20b=1"]) {
    assert.throws(() => sourceApiUrl("gpexe", "server3", r, bad), (e) => e.code === "path_not_allowed", bad);
  }
  const { teamScopedPath } = await import("../src/gpexeRestV1Adapter.js");
  assert.equal(teamScopedPath("team_session/", "980", [["start_timestamp_gte", "2026-09-14%2000%3A00%3A00"]]), "team_session/?team=980&start_timestamp_gte=2026-09-14%2000%3A00%3A00");
  for (const bad of ["2026-09-14 00:00:00", "a%2Fb", "%25", "x%3a", "a&b=1", "a#b"]) assert.throws(() => teamScopedPath("team_session/", "980", [["v", bad]]), (e) => e.code === "path_not_allowed", bad);
});

// ---------------------------------------------------------------------------
// B7. Review fixes of 2026-10-03 (code-reviewer HIGH/MEDIUM/LOW, security-reviewer MEDIUM/LOW).
// ---------------------------------------------------------------------------
test("B7.1 the one-day look-back on the whole list: a drill row inside the window whose parent started the evening before is not listed as a session and the parent of that extra day is left out; a row two or more days earlier is classified with the rest and left out too; month and year boundaries", async () => {
  const rows = [
    parent(100, [101, 102], 980, { start_timestamp: "2026-09-13T23:30:00" }),
    session(101, 980, { start_timestamp: "2026-09-14T00:05:00" }),
    session(102, 980, { start_timestamp: "2026-09-14T00:20:00" }),
    session(300, 980, { start_timestamp: "2026-09-14T10:00:00" }),
  ];
  const server = full({ [WINDOW]: answer(200, rows, { "x-total-count": "4" }) });
  const r = await make(server.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.deepEqual(idsOf(r), ["300"]);
  assert.deepEqual([r.drillsLeftOut, r.lookBackParentsLeftOut, r.otherParentsLeftOut, r.lookBackDays], [2, 1, 0, 1]);
  assert.deepEqual(pathsOf(server.calls), [WINDOW, WINDOW], "two complete reads");
  const quiet = full({ [WINDOW]: answer(200, [session(99, 980, { start_timestamp: "2026-09-13T18:00:00" }), session(300)], { "x-total-count": "2" }) });
  assert.deepEqual(idsOf(await make(quiet.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" })), ["300"]);
  const early = full({ [WINDOW]: answer(200, [session(98, 980, { start_timestamp: "2026-09-12T23:59:59" }), session(300)], { "x-total-count": "2" }) });
  const e = await make(early.fetchImpl).listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.deepEqual([idsOf(e), e.lookBackParentsLeftOut, e.otherParentsLeftOut], [["300"], 0, 1]);
  const jan = full({ [WINDOW]: answer(200, [session(1, 980, { start_timestamp: "2025-12-31T22:00:00" }), session(2, 980, { start_timestamp: "2026-01-01T09:00:00" }), session(3, 980, { start_timestamp: "2026-01-02T00:00:00" })], { "x-total-count": "3" }) });
  const j = await make(jan.fetchImpl).listSessionsByDay({ fromDay: "2026-01-01", toDay: "2026-01-01" });
  assert.deepEqual([idsOf(j), j.lookBackParentsLeftOut, j.otherParentsLeftOut], [["2"], 1, 1]);
});

const { projectSessionDetails: projectDetails } = await import("../src/gpexeRestV1Adapter.js");
const fsp = (await import("node:fs/promises")).default;
const path = (await import("node:path")).default;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");

test("B7.2 an empty players map is a valid answer (a drill not yet computed): the drill set stays complete and the whole-session details are accepted; a missing, null, array, string, number or boolean players still fails", async () => {
  const { a } = await confirmedAdapter({ [D1]: answer(200, { drills_count: 2, players: {} }), [WHOLE]: answer(200, { drills_count: 2, players: {} }) });
  const set = await a.getSessionDrills({ sessionId: "100" });
  assert.equal(set.complete, true);
  assert.equal(set.failed, null);
  assert.deepEqual(set.drills[1].details, { players: {}, drills_count: 2 });
  assert.deepEqual(await a.getSessionDetails({ sessionId: "100" }), { players: {}, drills_count: 2 });
  for (const [label, players] of [["missing", undefined], ["null", null], ["an array", []], ["an array of players", [{ 4711: { a: 1 } }]], ["a string", "4711"], ["a number", 1], ["a boolean", true]]) {
    const body = players === undefined ? { drills_count: 2 } : { drills_count: 2, players };
    const { a: b } = await confirmedAdapter({ [D1]: answer(200, body) });
    const s = await b.getSessionDrills({ sessionId: "100" });
    assert.equal(s.complete, false, label);
    assert.deepEqual(s.failed, { drillIndex: 1, code: "source_answer_unexpected" }, label);
    assert.throws(() => projectDetails(body, null, { what: "x" }), code("source_answer_unexpected"), label);
  }
  // The prototype-named metrics are refused; a details drill count that disagrees with the confirmed one is refused.
  for (const metric of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => projectDetails({ players: { 4711: JSON.parse(`{"${metric}": 1}`) } }, null, { what: "x" }), code("source_answer_unexpected"), metric);
  }
  assert.throws(() => projectDetails({ players: { 4711: { a: 1 } }, drills_count: 3 }, 2, { what: "x" }), code("source_answer_unexpected"));
  assert.deepEqual(projectDetails({ players: { 4711: { a: 1 } }, drills_count: 2 }, 2, { what: "x" }), { players: { 4711: {} }, drills_count: 2 }, "an unconsumed metric is dropped");
});

test("B7.3 no retry by default: a 5xx and a network failure each cost exactly one request with the default adapter; a caller may ask for at most three attempts; and a programming error inside a drill read propagates instead of becoming a failed drill", async () => {
  const five = full({ [PARENT]: answer(503, { detail: "x" }) });
  const dflt = createSourceAdapter({ sourceSystem: "gpexe", hostKey: "server3", catalogRow: row("server3"), credential: CREDENTIAL, boundSourceTeamId: "980", fetchImpl: five.fetchImpl, sleep: async () => {} });
  await dflt.listSessions();
  const listed = five.calls.length;
  await assert.rejects(dflt.getSession({ sessionId: "100" }), code("source_unavailable"));
  assert.equal(five.calls.length - listed, 1);
  const down = { calls: 0, fetchImpl: async () => { down.calls += 1; throw new TypeError("fetch failed"); } };
  const dflt2 = createSourceAdapter({ sourceSystem: "gpexe", hostKey: "server3", catalogRow: row("server3"), credential: CREDENTIAL, boundSourceTeamId: "980", fetchImpl: down.fetchImpl, sleep: async () => {} });
  await assert.rejects(dflt2.listSessions(), code("source_unavailable"));
  assert.equal(down.calls, 1);
  assert.throws(() => make(five.fetchImpl, { attempts: 4 }), code("invalid_options"));
  const three = full({ [PARENT]: answer(503, { detail: "x" }) });
  const t3 = await primed(three.fetchImpl, { attempts: 3 });
  const listed3 = three.calls.length;
  await assert.rejects(t3.getSession({ sessionId: "100" }), code("source_unavailable"));
  assert.equal(three.calls.length - listed3, 3);
  // A TypeError thrown while reading a drill answer is not a failed drill.
  const broken = { ...answer(200, { players: { 4711: { a: 1 } } }), get body() { throw new TypeError("boom"); } };
  const { a } = await confirmedAdapter({ [D1]: broken });
  await assert.rejects(a.getSessionDrills({ sessionId: "100" }), TypeError);
});

test("B7.4 an athlete row is read only when the confirmed session's own list named it: a never-listed id sends no request and answers a stable code; a list read again replaces the named set; a session confirmed again starts over", async () => {
  const { a, calls } = await confirmedAdapter();
  await assert.rejects(a.getAthleteSession({ sessionId: "100", athleteSessionId: "777" }), code("athlete_row_not_listed"));
  assert.equal(calls.length, 0, "nothing was sent for a row the list did not name");
  const row = await a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  assert.equal(row.id, 500);
  // A list that no longer names 500 replaces the named set in the same instance.
  const again = await confirmedAdapter({ [ATHLETES]: answer(200, [athleteRow(501, 4712, { track: 901 })], { "x-total-count": "1" }) });
  await assert.rejects(again.a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("athlete_row_not_listed"));
  // A session read again that now fails withdraws the earlier confirmation in the same instance.
  let parentAnswer = fullRoutes()[PARENT];
  const flip = fakeServer({ ...fullRoutes(), [PARENT]: () => parentAnswer });
  const b = make(flip.fetchImpl);
  await b.listSessions();
  await b.getSession({ sessionId: "100" });
  await b.listAthleteSessions({ sessionId: "100" });
  parentAnswer = answer(200, { id: 100, team: 981, drills_count: 2, start_timestamp: "2026-09-14T10:00:00" });
  await assert.rejects(b.getSession({ sessionId: "100" }), code("source_team_mismatch"));
  await assert.rejects(b.listAthleteSessions({ sessionId: "100" }), code("session_not_confirmed"));
  await assert.rejects(b.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("session_not_confirmed"));
  // More than MAX_ATHLETE_ROWS rows for one session is refused.
  const many = Array.from({ length: 201 }, (_, i) => athleteRow(1000 + i, 5000 + i));
  const big = await confirmedAdapter({ [ATHLETES]: answer(200, many, { "x-total-count": "201" }) });
  const tooMany = await errorOf(big.a.listAthleteSessions({ sessionId: "100" }));
  assert.equal(tooMany.code, "source_answer_unexpected");
  assert.equal(tooMany.reason, "athlete_rows_too_many");
});

test("B7.5 next-page links carry only limit and offset (and the window bounds) as the adapter re-sends them; any team-like key in any spelling and any other parameter is refused on both list kinds; listSessionTags refuses an unknown option without a request", async () => {
  const link = (q) => ({ "x-total-count": "2", link: `<https://server3.gpexe.com/rest/v1/athlete_session/?teamsession=100&${q}>; rel="next"` });
  for (const q of ["team_id=981&limit=100&offset=1", "teamId=981&limit=100&offset=1", "TEAM=981&limit=100&offset=1", "limit=100&offset=1&cursor=abc", "limit=100&offset=-1", "limit=abc&offset=1", "limit=100&offset=1&page=2"]) {
    const s = full({ [ATHLETES]: answer(200, [athleteRow(500, 4711)], link(q)) });
    const a = await primed(s.fetchImpl);
    await a.getSession({ sessionId: "100" });
    await assert.rejects(a.listAthleteSessions({ sessionId: "100" }), code("source_answer_unexpected"), q);
    assert.ok(!s.calls.some((c) => c.url.includes("offset=")), `nothing followed for ${q}`);
  }
  const good = fakeServer(fullRoutes({
    [ATHLETES]: answer(200, [athleteRow(500, 4711)], link("limit=100&offset=1")),
    "/rest/v1/athlete_session/?teamsession=100&limit=100&offset=1": answer(200, [athleteRow(501, 4712, { track: 901 })], { "x-total-count": "2" }),
  }));
  const g = await primed(good.fetchImpl);
  await g.getSession({ sessionId: "100" });
  assert.equal((await g.listAthleteSessions({ sessionId: "100" })).rows.length, 2);
  for (const q of ["team=980&limit=2&offset=2&page=3", "team=980&limit=2&offset=x", "team=980&limit=2&offset=2&team_id=980"]) {
    const s = listOf([session(1)], { [LIST]: answer(200, [session(1)], { "x-total-count": "3", link: `<https://server3.gpexe.com/rest/v1/team_session/?${q}>; rel="next"` }) });
    await assert.rejects(make(s.fetchImpl).listSessions(), (e) => e.code === "source_answer_unexpected" || e.code === "source_team_mismatch", q);
    assert.equal(s.calls.length, 1, q);
  }
  const { a, calls } = await confirmedAdapter();
  await assert.rejects(a.listSessionTags({ url: "https://evil.example/" }), code("invalid_options"));
  assert.equal(calls.length, 0);
});

test("B7.6 doc lint: the compatibility document no longer carries the F3c2a sentences the adapter column contradicts", async () => {
  const doc = await fsp.readFile(path.resolve(ROOT, "docs/ai/gpexe-rest-v1-compatibility.md"), "utf8");
  assert.doesNotMatch(doc, /adapter column has not moved|drills left out as the importer does/);
  assert.match(doc, /exactly one day earlier/);
  assert.match(doc, /an empty map is valid/);
  assert.doesNotMatch(doc, /is listed as a session by `listSessionsByDay`|, or widened,/);
  const currentState = await fsp.readFile(path.resolve(ROOT, "docs/ai/CURRENT_STATE.md"), "utf8");
  assert.match(currentState, /non-empty\s+map keyed by canonical athlete ids[^.]*relaxed by the owner/);
});

// ---------------------------------------------------------------------------
// B8. External review of PR #133 (2026-10-03): the parent classification as the
// precondition of a session read, explicit projections, revocation under
// refresh, strict drill labels, canonical tag ids.
// ---------------------------------------------------------------------------
const { BUNDLE_FIELDS, projectMore } = await import("../src/gpexeRestV1Adapter.js");

test("B8.1 a session is read only when a session list of this instance classified it as a parent: no list → no request; a drill row is refused as a session and as a bundle; a later list that reclassifies a parent as a drill withdraws its confirmation", async () => {
  const server = full();
  const a = make(server.fetchImpl);
  await assert.rejects(a.getSession({ sessionId: "100" }), code("session_not_listed"));
  await assert.rejects(a.fetchSessionBundle({ sessionId: "100" }), code("session_not_listed"));
  assert.equal(server.calls.length, 0, "nothing was sent");
  await a.listSessions();
  // 101 and 102 are drill rows of 100 on that page: never a session, never a bundle, no request.
  const sent = server.calls.length;
  for (const drill of ["101", "102"]) {
    await assert.rejects(a.getSession({ sessionId: drill }), code("session_not_listed"), drill);
    await assert.rejects(a.fetchSessionBundle({ sessionId: drill }), code("session_not_listed"), drill);
  }
  assert.equal(server.calls.length, sent);
  // A parent of the list is readable. A window list classifies the whole list,
  // but only the parents of the window become readable: a look-back parent,
  // another day's parent and a drill row stay unreadable, with no request.
  assert.equal((await a.getSession({ sessionId: "100" })).id, 100);
  const windowed = full({ [WINDOW]: answer(200, [parent(300, [301], 980, { start_timestamp: "2026-09-13T23:30:00" }), session(301, 980, { start_timestamp: "2026-09-14T00:05:00" }), session(302, 980, { start_timestamp: "2026-09-14T10:00:00" }), session(303, 980, { start_timestamp: "2026-09-20T10:00:00" })], { "x-total-count": "4" }), "/rest/v1/team_session/302/": answer(200, { id: 302, team: 980, drills_count: 0, start_timestamp: "2026-09-14T10:00:00" }) });
  const w = make(windowed.fetchImpl);
  await w.listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  assert.equal((await w.getSession({ sessionId: "302" })).id, 302);
  const listed = windowed.calls.length;
  for (const id of ["300", "301", "303"]) await assert.rejects(w.getSession({ sessionId: id }), code("session_not_listed"), id);
  assert.equal(windowed.calls.length, listed, "nothing was sent for a session outside the window");
  // Reclassification: a page on which 100 is named as a drill of 900 withdraws 100 and everything under it.
  let page = fullRoutes()[LIST];
  const flip = fakeServer({ ...fullRoutes(), [LIST]: () => page });
  const b = make(flip.fetchImpl);
  await b.listSessions();
  await b.getSession({ sessionId: "100" });
  await b.listAthleteSessions({ sessionId: "100" });
  await b.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  page = answer(200, [parent(900, [100]), session(100), session(200)], { "x-total-count": "3" });
  await b.listSessions();
  const before = flip.calls.length;
  await assert.rejects(b.getSession({ sessionId: "100" }), code("session_not_listed"));
  await assert.rejects(b.getSessionDetails({ sessionId: "100" }), code("session_not_confirmed"));
  await assert.rejects(b.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(b.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  assert.equal(flip.calls.length, before, "nothing was sent after the reclassification");
});

test("B8.2 explicit projections: every read returns exactly the fields the importer reads and nothing the source adds, in any spelling or nesting; the lists of fields cover every field the mapper source reads", async () => {
  const extra = { first_name: "Marker Athlete Name", athlete_obj: { name: "someone" }, notes: "a private note", zzzOpaqueKey: 1, submitted_by: "someone" };
  const { a } = await confirmedAdapter({
    [PARENT]: answer(200, { id: 100, team: 980, category_name: "Training", start_timestamp: "2026-09-14T10:00:00", end_timestamp: "2026-09-14T11:00:00", updated_on: "2026-09-14T12:00:00", drills_count: 2, is_stats_valid: true, total_time: 3600, total_distance: 5000, max_v: 8, drills: [101, 102], ...extra }),
    [ATHLETES]: answer(200, [athleteRow(500, 4711, extra), athleteRow(501, 4712, { track: 901, ...extra })], { "x-total-count": "2" }),
    "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711, { is_stats_valid: true, ...extra })),
    "/rest/v1/athlete_session/500/more/": answer(200, { athletesession_id: 500, events: { acceleration_events_count: 3, acceleration_events_threshold_value: 2.5, acceleration_events_duration: 0.3, deceleration_events_count: 2, deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, first_name: "Marker Athlete Name", zzzOpaqueKey: 1 }, complementary_data: { power: [{ extremes: [25, 60], distance: 100, is_ready: true, label: "someone" }, "not a zone"], speed: [{ extremes: [7, null], distance: 50, is_ready: true }], heart: [{ extremes: [1, 2] }] }, ...extra }),
    "/rest/v1/track/900/": answer(200, { id: 900, athlete: 4711, timezone: "Europe/Sarajevo", timestamp: "2026-09-14T09:50:00", utc_timestamp: 1789000000, lat: 1, lng: 2, ...extra }),
    [THRESH]: answer(200, { id: 1473, team: 980, validity_start: "2026-01-01T00:00:00", validity_end: null, power_thresholds: [20, 25, 60, 75], speed_thresholds: [5.5, 7], acceleration_events_threshold: 2.5, acceleration_events_duration: 0.3, deceleration_events_threshold: -2.5, deceleration_events_duration: 0.3, ...extra }),
  });
  const s = await a.getSession({ sessionId: "100" });
  assert.deepEqual(Object.keys(s).sort(), [...BUNDLE_FIELDS.teamSession].sort());
  const { rows } = await a.listAthleteSessions({ sessionId: "100" });
  for (const r of rows) assert.ok(Object.keys(r).every((k) => BUNDLE_FIELDS.athleteSession.includes(k)) && Object.keys(r).length === BUNDLE_FIELDS.athleteSession.length - 1, "a listed row carries only projected fields (the fixture has no is_stats_valid)");
  const r = await a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  assert.deepEqual(Object.keys(r).sort(), [...BUNDLE_FIELDS.athleteSession].sort());
  const m = await a.getAthleteSessionMore({ athleteSessionId: "500" });
  assert.deepEqual(m, {
    athletesession_id: 500,
    events: { acceleration_events_count: 3, acceleration_events_threshold_value: 2.5, acceleration_events_duration: 0.3, deceleration_events_count: 2, deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3 },
    complementary_data: { power: [{ extremes: [25, 60], distance: 100, is_ready: true }], speed: [{ extremes: [7, null], distance: 50, is_ready: true }] },
  });
  const tr = await a.getTrack({ trackId: "900" });
  assert.deepEqual(Object.keys(tr).sort(), [...BUNDLE_FIELDS.track].sort());
  const th = await a.getTeamThresholds({ sessionId: "100" });
  assert.deepEqual(Object.keys(th).sort(), [...BUNDLE_FIELDS.teamThresholds].sort());
  // A field the source leaves out is simply absent — never invented.
  const sparse = await confirmedAdapter({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00" }) });
  assert.deepEqual(await sparse.a.getSession({ sessionId: "100" }), { id: 100, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00" });
  assert.deepEqual(projectMore({ athletesession_id: 1 }), { athletesession_id: 1, events: {}, complementary_data: {} });
  assert.deepEqual(projectMore({ events: null, complementary_data: "x" }), { events: {}, complementary_data: {} });
  // The whole bundle, as the importer gets it, carries no unknown key anywhere.
  const bundle = await a.fetchSessionBundle({ sessionId: "100" });
  noNames(bundle, ["first_name", "athlete_obj", "zzzOpaqueKey", "heart", "\"lat\"", "\"lng\""]);
  // Every field the mapper reads from a session, row, track, threshold set, events or zone is in the lists.
  const mapper = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeImportMapper.js"), "utf8");
  const reads = (re) => new Set([...mapper.matchAll(re)].map((m) => m[1]));
  const subset = (set, list, what) => { for (const k of set) assert.ok(list.includes(k), `${what}.${k} is read by the mapper but not projected`); };
  subset(reads(/\bsession\.([a-z_]+)\b/g), BUNDLE_FIELDS.teamSession, "teamSession");
  subset(reads(/\b(?:row|r)\.([a-z_]+)\b/g), BUNDLE_FIELDS.athleteSession, "athleteSession");
  subset(reads(/\btrack\.([a-z_]+)\b/g), BUNDLE_FIELDS.track, "track");
  subset(reads(/\bthresholds\.([a-z_]+)\b/g), BUNDLE_FIELDS.teamThresholds, "teamThresholds");
  subset(reads(/\bmore\?\.([a-z_]+)\b/g), BUNDLE_FIELDS.more, "more");
  subset(reads(/complementary_data\?\.([a-z_]+)\b/g), BUNDLE_FIELDS.complementaryData, "complementary_data");
  subset(new Set([...reads(/\bz\??\.([a-z_]+)\b/g), ...reads(/matching\[0\]\.([a-z_]+)\b/g)]), BUNDLE_FIELDS.zone, "zone");
  const suffixes = [...reads(/events\[`\$\{prefix\}_([a-z_]+)`\]/g)];
  assert.ok(suffixes.length >= 3, "the event suffixes the mapper reads were found");
  for (const prefix of ["acceleration_events", "deceleration_events"]) subset(new Set(suffixes.map((x) => `${prefix}_${x}`)), BUNDLE_FIELDS.moreEvents, "more.events");
  // The candidate service reads two session fields and two row fields from the stored bundle.
  for (const k of ["category_name", "drills_count"]) assert.ok(BUNDLE_FIELDS.teamSession.includes(k));
  for (const k of ["athlete", "teamsession"]) assert.ok(BUNDLE_FIELDS.athleteSession.includes(k));
  // And the other way round: every projected field is read by a consumer (mapper, or the service's four fields).
  const consumed = (re, extra) => new Set([...reads(re), ...extra]);
  const sessionReads = consumed(/\bsession\.([a-z_]+)\b/g, ["category_name", "drills_count"]);
  for (const k of BUNDLE_FIELDS.teamSession) assert.ok(sessionReads.has(k), `teamSession.${k} is projected but nothing reads it`);
  const rowReads = consumed(/\b(?:row|r)\.([a-z_]+)\b/g, ["athlete", "teamsession", "total_time", "total_distance", "max_v"]);
  for (const k of BUNDLE_FIELDS.athleteSession) assert.ok(rowReads.has(k), `athleteSession.${k} is projected but nothing reads it`);
  for (const k of BUNDLE_FIELDS.track) assert.ok(reads(/\btrack\.([a-z_]+)\b/g).has(k), `track.${k}`);
  for (const k of BUNDLE_FIELDS.teamThresholds) assert.ok(reads(/\bthresholds\.([a-z_]+)\b/g).has(k), `teamThresholds.${k}`);
});

test("B8.3 a refresh of the session or of its athlete list withdraws every row and track confirmed under it, and an answer that started before the refresh is discarded unrecorded (concurrent stale answers)", async () => {
  // Sequential: re-read of the session, then of the list.
  const { a } = await confirmedAdapter();
  await a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  await a.getAthleteSession({ sessionId: "100", athleteSessionId: "501" });
  await a.getSession({ sessionId: "100" });
  await assert.rejects(a.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(a.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  await assert.rejects(a.getTrack({ trackId: "901" }), code("track_not_confirmed"));
  await assert.rejects(a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("athlete_row_not_listed"));
  await a.listAthleteSessions({ sessionId: "100" });
  await a.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  await a.listAthleteSessions({ sessionId: "100" });
  await assert.rejects(a.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(a.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  // Concurrent: the list answer is held while the session is re-read; the stale list records nothing.
  const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
  const hold = gate();
  const routes = fullRoutes();
  const slow = fakeServer({ ...routes, [ATHLETES]: async () => { await hold.p; return routes[ATHLETES]; } });
  const b = make(slow.fetchImpl);
  await b.listSessions();
  await b.getSession({ sessionId: "100" });
  const staleList = b.listAthleteSessions({ sessionId: "100" });
  await new Promise((r) => setTimeout(r, 5));
  await b.getSession({ sessionId: "100" });
  hold.release();
  await assert.rejects(staleList, code("session_refreshed"));
  await assert.rejects(b.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("athlete_row_not_listed"));
  // Concurrent: the row answer is held while the list is re-read; the stale row confirms nothing.
  const hold2 = gate();
  const slow2 = fakeServer({ ...routes, "/rest/v1/athlete_session/500/": async () => { await hold2.p; return routes["/rest/v1/athlete_session/500/"]; } });
  const c = make(slow2.fetchImpl);
  await c.listSessions();
  await c.getSession({ sessionId: "100" });
  await c.listAthleteSessions({ sessionId: "100" });
  const staleRow = c.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
  await new Promise((r) => setTimeout(r, 5));
  await c.listAthleteSessions({ sessionId: "100" });
  hold2.release();
  await assert.rejects(staleRow, code("session_refreshed"));
  await assert.rejects(c.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(c.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  // Concurrent: a stale session answer does not confirm either.
  const hold3 = gate();
  let first = true;
  const slow3 = fakeServer({ ...routes, [PARENT]: async () => { if (first) { first = false; await hold3.p; } return routes[PARENT]; } });
  const d = make(slow3.fetchImpl);
  await d.listSessions();
  const staleSession = d.getSession({ sessionId: "100" });
  await new Promise((r) => setTimeout(r, 5));
  await d.getSession({ sessionId: "100" });
  hold3.release();
  await assert.rejects(staleSession, code("session_refreshed"));
  assert.equal((await d.getSessionDetails({ sessionId: "100" })).drills_count, 2, "the fresh confirmation stands");
});

test("B8.4 drill labels: only a missing or unreachable brief means the neutral name; a brief of another session, a brief that is not an object, a non-canonical tag or a programming error is never turned into a label", async () => {
  const labelsOf = (over) => confirmedAdapter(over).then(({ a }) => a.getDrillLabels({ sessionId: "100" }));
  assert.deepEqual((await labelsOf({ [BRIEF]: answer(404, { detail: "x" }) })).map((l) => l.labelEvidence), ["index_fallback", "index_fallback"]);
  assert.deepEqual((await labelsOf({ [BRIEF]: answer(503, { detail: "x" }) })).map((l) => l.labelEvidence), ["index_fallback", "index_fallback"]);
  await assert.rejects(labelsOf({ [BRIEF]: answer(200, { id: 150, drillTags: [31, 32] }) }), (e) => e.code === "source_answer_unexpected" && e.reason === "brief_of_another_session");
  await assert.rejects(labelsOf({ [BRIEF]: answer(200, [31, 32]) }), (e) => e.code === "source_answer_unexpected" && e.reason === "brief_shape_unknown");
  await assert.rejects(labelsOf({ [BRIEF]: answer(200, { id: 100, drillTags: ["007", 32] }) }), (e) => e.code === "source_answer_unexpected" && e.reason === "tag_id_not_canonical");
  await assert.rejects(labelsOf({ [BRIEF]: answer(200, { id: 100, drillTags: [{ drill: 0, tag: -1 }] }) }), (e) => e.code === "source_answer_unexpected" && e.reason === "tag_id_not_canonical");
  await assert.rejects(labelsOf({ [BRIEF]: answer(200, "not json at all") }), code("source_answer_unexpected"));
  await assert.rejects(labelsOf({ [BRIEF]: answer(401, "") }), code("source_auth_rejected"));
  const broken = { ...answer(200, { id: 100, drillTags: [31, 32] }), get body() { throw new TypeError("boom"); } };
  await assert.rejects(labelsOf({ [BRIEF]: broken }), TypeError);
  // A brief without an id, or whose drillTags are an unknown shape, still falls back (documented rule).
  assert.deepEqual((await labelsOf({ [BRIEF]: answer(200, { drillTags: [31, 32] }) })).map((l) => l.tagName), ["Rondo", "Small-sided game"]);
  assert.deepEqual((await labelsOf({ [BRIEF]: answer(200, { id: 100, drillTags: "Rondo, SSG" }) })).map((l) => l.labelEvidence), ["index_fallback", "index_fallback"]);
});

test("B8.5 a tag row with a non-canonical id refuses the whole tag list; parseDrillTags refuses a non-canonical tag id in both shapes and still answers null for an unknown shape", async () => {
  const { a } = await confirmedAdapter({ [TAGS]: answer(200, [{ id: 31, name: "Rondo", team: 980 }, { id: "007", name: "Bad", team: 980 }], { "x-total-count": "2" }) });
  const e = await errorOf(a.listSessionTags());
  assert.equal(e.code, "source_answer_unexpected");
  assert.ok(e.reason === "tag_id_not_canonical" || e.reason === "row_id_not_canonical", e.reason);
  const { parseDrillTags } = await import("../src/gpexeRestV1Adapter.js");
  for (const bad of [["007", 32], [1.5, 32], [-1, 32], ["31 ", 32], [{ drill: 0, tag: "007" }, { drill: 1, tag: 32 }], [{ drill: 0, tag: 1.5 }]]) {
    assert.throws(() => parseDrillTags(bad, 2), (x) => x.code === "source_answer_unexpected" && x.reason === "tag_id_not_canonical", JSON.stringify(bad));
  }
  assert.equal(parseDrillTags([31, 32, 33], 2), null);
  assert.equal(parseDrillTags([{ drill: 0 }], 2), null);
  assert.equal(parseDrillTags([{ drill: 0, tag: null }], 2), null);
  assert.equal(parseDrillTags([true, 32], 2), null);
  assert.deepEqual([...parseDrillTags([31, null], 2).entries()], [[0, "31"]]);
  const src = await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8");
  assert.doesNotMatch(src, /is a non-empty map keyed by canonical athlete ids/);
});

test("B8.6 round-2 hardening: an older session list answering after a newer one records nothing; a dependent read (details, drill, more, track, brief) that lands after its session was refreshed is discarded; a projected field of an unexpected shape refuses the answer", async () => {
  const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
  const routes = fullRoutes();
  // Stale list: list 1 is held, list 2 (which names 100 as a drill of 900) answers first.
  let held = true;
  const hold = gate();
  const server = fakeServer({ ...routes, [LIST]: async () => { if (held) { held = false; await hold.p; return routes[LIST]; } return answer(200, [parent(900, [100]), session(100), session(200)], { "x-total-count": "3" }); } });
  const a = make(server.fetchImpl);
  const stale = a.listSessions();
  await new Promise((r) => setTimeout(r, 5));
  await a.listSessions();
  hold.release();
  await assert.rejects(stale, code("session_list_refreshed"));
  await assert.rejects(a.getSession({ sessionId: "100" }), code("session_not_listed"));
  assert.equal((await a.getSession({ sessionId: "900" }).catch((e) => e)).code, "source_not_found", "900 is a known parent of the newer list (its own read has no fixture here)");
  // Dependent reads after a refresh mid-flight.
  for (const [what, route, op, args, setup] of [
    ["details", WHOLE, "getSessionDetails", { sessionId: "100" }, null],
    ["drill", D0, "getSessionDrills", { sessionId: "100" }, null],
    ["more", "/rest/v1/athlete_session/500/more/", "getAthleteSessionMore", { athleteSessionId: "500" }, "row"],
    ["track", "/rest/v1/track/900/", "getTrack", { trackId: "900" }, "row"],
    ["brief", BRIEF, "getDrillLabels", { sessionId: "100" }, null],
  ]) {
    const h = gate();
    let first = true;
    const slow = fakeServer({ ...routes, [route]: async () => { if (first) { first = false; await h.p; } return routes[route]; } });
    const b = make(slow.fetchImpl);
    await b.listSessions();
    await b.getSession({ sessionId: "100" });
    await b.listAthleteSessions({ sessionId: "100" });
    if (setup === "row") await b.getAthleteSession({ sessionId: "100", athleteSessionId: "500" });
    const pending = b[op](args);
    await new Promise((r) => setTimeout(r, 5));
    await b.getSession({ sessionId: "100" });
    h.release();
    await assert.rejects(pending, code("session_refreshed"), what);
  }
  // Projected fields must be scalars (or the number lists): an object, a long text or a nested array refuses the answer.
  for (const [what, over, op, args] of [
    ["a session category as an object", { [PARENT]: answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00", category_name: { name: "Training" } }) }, "getSession", { sessionId: "100" }],
    ["a long session text", { [PARENT]: answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00", category_name: "x".repeat(65) }) }, "getSession", { sessionId: "100" }],
    ["a row with an object athlete field value", { "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711, { total_time: { value: 1 } })) }, "getAthleteSession", { sessionId: "100", athleteSessionId: "500" }],
    ["thresholds with a nested list", { [THRESH]: answer(200, { id: 1473, team: 980, power_thresholds: [[20], 25] }) }, "getTeamThresholds", { sessionId: "100" }],
    ["thresholds with a string in the list", { [THRESH]: answer(200, { id: 1473, team: 980, speed_thresholds: ["5.5", 7] }) }, "getTeamThresholds", { sessionId: "100" }],
  ]) {
    const c = op === "getSession" ? await primed(full(over).fetchImpl) : (await confirmedAdapter(over)).a;
    const e = await errorOf(c[op](args));
    assert.equal(e?.code, "source_answer_unexpected", what);
    assert.equal(e.reason, "field_shape_unknown", what);
  }
  const { a: ok } = await confirmedAdapter({ [THRESH]: answer(200, { id: 1473, team: 980, validity_end: null, power_thresholds: [20, null, 60], speed_thresholds: [] }) });
  assert.deepEqual(await ok.getTeamThresholds({ sessionId: "100" }), { id: 1473, team: 980, validity_end: null, power_thresholds: [20, null, 60], speed_thresholds: [] });
});

test("B8.7 a row this instance already classified as a drill never comes back as a parent through a later list that lacks its parent: the contradicting list is refused and the id stays unreadable", async () => {
  let page = answer(200, [parent(100, [101]), session(101)], { "x-total-count": "2" });
  const server = fakeServer({
    ...fullRoutes(),
    [LIST]: () => page,
    "/rest/v1/team_session/101/": answer(200, { id: 101, team: 980, drills_count: 0, start_timestamp: "2026-09-14T00:05:00" }),
  });
  const a = make(server.fetchImpl);
  await a.listSessions();
  page = answer(200, [session(101, 980, { start_timestamp: "2026-09-14T00:05:00" })], { "x-total-count": "1" });
  const e = await errorOf(a.listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" }));
  assert.equal(e?.code, "source_list_ambiguous");
  assert.equal(e.reason, "classification_conflict");
  await assert.rejects(a.getSession({ sessionId: "101" }), code("session_not_listed"));
  assert.ok(!server.calls.some((c) => c.url.includes("/team_session/101/")), "the drill row was never read as a session");
  // The other direction stays as before: a parent later named as a drill is withdrawn (B8.1).
});

test("B8.8 a refused answer confirms nothing: after a session, a row list or a row is refused for its shape, every dependent read is refused without a request", async () => {
  const bad = full({ [PARENT]: answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: "2026-09-14T10:00:00", category_name: { name: "Training" } }) });
  const a = await primed(bad.fetchImpl);
  assert.equal((await errorOf(a.getSession({ sessionId: "100" }))).reason, "field_shape_unknown");
  let sent = bad.calls.length;
  for (const op of ["getSessionDetails", "getSessionDrills", "listAthleteSessions", "getTeamThresholds", "getDrillLabels"]) await assert.rejects(a[op]({ sessionId: "100" }), code("session_not_confirmed"), op);
  assert.equal(bad.calls.length, sent);
  const badList = full({ [ATHLETES]: answer(200, [athleteRow(500, 4711, { total_time: {} })], { "x-total-count": "1" }) });
  const b = await primed(badList.fetchImpl);
  await b.getSession({ sessionId: "100" });
  assert.equal((await errorOf(b.listAthleteSessions({ sessionId: "100" }))).reason, "field_shape_unknown");
  sent = badList.calls.length;
  await assert.rejects(b.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }), code("athlete_row_not_listed"));
  assert.equal(badList.calls.length, sent);
  const badRow = full({ "/rest/v1/athlete_session/500/": answer(200, athleteRow(500, 4711, { total_time: { value: 1 } })) });
  const c = await primed(badRow.fetchImpl);
  await c.getSession({ sessionId: "100" });
  await c.listAthleteSessions({ sessionId: "100" });
  assert.equal((await errorOf(c.getAthleteSession({ sessionId: "100", athleteSessionId: "500" }))).reason, "field_shape_unknown");
  sent = badRow.calls.length;
  await assert.rejects(c.getAthleteSessionMore({ athleteSessionId: "500" }), code("athlete_row_not_confirmed"));
  await assert.rejects(c.getTrack({ trackId: "900" }), code("track_not_confirmed"));
  assert.equal(badRow.calls.length, sent);
});

test("B8.9 last started wins, fail-closed: with two held lists, the older one finishing FIRST is discarded (session_list_refreshed), its candidate stays session_not_listed without a request, and only the newer list, once it finishes, classifies", async () => {
  const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
  const routes = fullRoutes();
  const older = gate();
  const newer = gate();
  let n = 0;
  // Older list: 900 is a parent and 100 its drill. Newer list: 100 is a parent (the fixture page).
  const server = fakeServer({ ...routes, [LIST]: async () => {
    n += 1;
    if (n === 1) { await older.p; return answer(200, [parent(900, [100]), session(100), session(200)], { "x-total-count": "3" }); }
    await newer.p; return routes[LIST];
  } });
  const a = make(server.fetchImpl);
  const first = a.listSessions();
  await new Promise((r) => setTimeout(r, 5));
  const second = a.listSessions();
  await new Promise((r) => setTimeout(r, 5));
  older.release();
  await assert.rejects(first, code("session_list_refreshed"));
  const sent = server.calls.length;
  await assert.rejects(a.getSession({ sessionId: "900" }), code("session_not_listed"), "the older list's parent was never recorded");
  await assert.rejects(a.getSession({ sessionId: "100" }), code("session_not_listed"), "nothing is classified until the newer list finishes");
  assert.equal(server.calls.length, sent, "no request for an unclassified id");
  newer.release();
  assert.deepEqual(idsOf(await second), ["100", "200"]);
  assert.equal((await a.getSession({ sessionId: "100" })).id, 100);
  await assert.rejects(a.getSession({ sessionId: "900" }), code("session_not_listed"));
  // The other order (newer finishes first, older later) is still discarded too.
  const older2 = gate();
  let m = 0;
  const server2 = fakeServer({ ...routes, [LIST]: async () => { m += 1; if (m === 1) { await older2.p; return answer(200, [parent(900, [100]), session(100), session(200)], { "x-total-count": "3" }); } return routes[LIST]; } });
  const b = make(server2.fetchImpl);
  const stale = b.listSessions();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(idsOf(await b.listSessions()), ["100", "200"]);
  older2.release();
  await assert.rejects(stale, code("session_list_refreshed"));
  assert.equal((await b.getSession({ sessionId: "100" })).id, 100);
  await assert.rejects(b.getSession({ sessionId: "900" }), code("session_not_listed"));
});

const { DETAILS_CONSUMED_FIELDS, DIAGNOSTIC_MARK } = await import("../src/gpexeRestV1Adapter.js");
const { GPEXE_METRIC_SPECS } = await import("../src/gpexeImportMapper.js");

test("B7.5 the administrator's description of a refused details answer: fixed words only (the operation, a consumed field's constant name and kind, or the kind of a bad name), never an athlete id, another metric name, a value or a text; the full validator of 2026-10-05 is gone and nothing can call it", async () => {
  // The consumed fields are exactly the mapper's details fields.
  const mapperDetailsFields = GPEXE_METRIC_SPECS.map((s) => /^details\.players\[athlete\]\.(\w+)$/.exec(s.sourceContext?.field ?? "")?.[1]).filter(Boolean).sort();
  assert.deepEqual([...DETAILS_CONSUMED_FIELDS].sort(), mapperDetailsFields);
  assert.equal(DIAGNOSTIC_MARK, " Diagnostic: ");
  const mod = await import("../src/gpexeRestV1Adapter.js");
  for (const gone of ["validatePlayersAnswer", "describePlayersShape", "formatPlayersShape"]) assert.equal(mod[gone], undefined, `${gone} is not exported any more`);

  // Marker values that must never appear in a description.
  const ID = "987654321";
  const SECRET_NAME = "markerMetricNameZq";
  const SECRET_NUMBER = 13579.2468;

  // Through the adapter: since the projections (B7.6; drills since 2026-10-09) an unconsumed metric
  // refuses neither read - it is dropped; a consumed field in an unknown shape still refuses a drill,
  // and the drill set keeps the sanitized description (field and kind only).
  const { a } = await confirmedAdapter({ [WHOLE]: answer(200, details({ [ID]: { tot_burst_events: { unit: "number", value: 1 }, [SECRET_NAME]: [SECRET_NUMBER] } })) });
  assert.deepEqual(await a.getSessionDetails({ sessionId: "100" }), { players: { [ID]: { tot_burst_events: { unit: "number", value: 1 } } }, drills_count: 2 });
  const { a: b0 } = await confirmedAdapter({ [D0]: answer(200, details({ [ID]: { tot_burst_events: { unit: "number", value: 2 }, [SECRET_NAME]: [1] } })) });
  const ok = await b0.getSessionDrills({ sessionId: "100" });
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.drills[0].details.players, { [ID]: { tot_burst_events: { unit: "number", value: 2 } } });
  const { a: b } = await confirmedAdapter({ [D0]: answer(200, details({ [ID]: { tot_burst_events: [SECRET_NUMBER], [SECRET_NAME]: [1] } })) });
  const set = await b.getSessionDrills({ sessionId: "100" });
  assert.deepEqual([set.complete, set.failed.drillIndex, set.failed.code], [false, 0, "source_answer_unexpected"]);
  assert.equal(set.failed.diagnosticText, "op=session_drill_details; field=tot_burst_events; kind=array.");
  for (const leak of [ID, SECRET_NAME, "13579"]) assert.ok(!set.failed.diagnosticText.includes(leak), leak);
  // A bad metric name in a drill is described by its kind of name only.
  const { a: bn } = await confirmedAdapter({ [D0]: answer(200, JSON.parse(`{"players":{"${ID}":{"${SECRET_NAME} with spaces":1}}}`)) });
  const named = await bn.getSessionDrills({ sessionId: "100" });
  assert.equal(named.failed.diagnosticText, "op=session_drill_details; names=other_chars.");
  // Any other drill failure keeps its code alone.
  const { a: c } = await confirmedAdapter({ [D0]: answer(200, details({ [ID]: {} })) });
  assert.deepEqual((await c.getSessionDrills({ sessionId: "100" })).failed, { drillIndex: 0, code: "source_answer_unexpected" });

  // The capability catalog says what the probe proved for row 7: the status only.
  const { REST_V1_CAPABILITIES } = await import("../src/gpexeRestV1Adapter.js");
  assert.match(REST_V1_CAPABILITIES.session_details.evidence, /status only/);
});

const { projectSessionDetails } = await import("../src/gpexeRestV1Adapter.js");
const { buildGpexeImportPlan } = await import("../src/gpexeImportMapper.js");
const { makeBundle, standardAthletes } = await import("./_gpexe-fixtures.mjs");

test("B7.6 the whole-session projection (op=session_details only): the container, ids, bounds and metric-name guard are as before; of the values only tot_burst_events / tot_brake_events are read, validated by the same rule and copied into fresh objects; every other metric is neither read nor returned; the drill read keeps the full check", async () => {
  const OK = { unit: "number", value: 3 };
  // An unconsumed metric whose value must never be read: its getter throws.
  const values = { tot_burst_events: { ...OK, extra: 9 }, tot_brake_events: { unit: "number", value: 1 } };
  Object.defineProperty(values, "markerUnreadMetricZq", { enumerable: true, get() { throw new Error("an unconsumed metric value was read"); } });
  const out = projectSessionDetails({ drills_count: 2, players: { 4711: values, 4712: { other: { a: 1, b: { c: 2 } } }, 4713: { tot_burst_events: null, tot_brake_events: {} } } }, 2);
  assert.deepEqual(out, { players: { 4711: { tot_burst_events: OK, tot_brake_events: { unit: "number", value: 1 } }, 4712: {}, 4713: { tot_burst_events: null, tot_brake_events: {} } }, drills_count: 2 }, "only unit / value of the consumed fields; an athlete without them keeps {}; null and {} stay as they were (the mapper skips them as before)");
  assert.equal(Object.getPrototypeOf(out.players[4711]), Object.prototype);
  assert.notEqual(out.players[4711].tot_burst_events, values.tot_burst_events, "a fresh object, not the source's");
  // The mapper's semantics on the projected output are the ones it had before.
  for (const [label, players] of [["documented", { 1: { tot_burst_events: OK } }], ["unit other", { 1: { tot_burst_events: { unit: "count", value: 3 } } }]]) {
    assert.deepEqual(projectSessionDetails({ players }).players, players, label);
  }

  // Still refused, as before: containers, ids, bounds, names, dangerous keys, the drill count.
  const reason = (body, expected = null) => { try { projectSessionDetails(body, expected); return null; } catch (e) { assert.equal(e.code, "source_answer_unexpected"); return e.reason ?? "no_reason"; } };
  assert.equal(reason(null), "no_reason");
  assert.equal(reason([]), "no_reason");
  for (const players of [undefined, null, [], "x", 1]) assert.equal(reason({ players }), "players_missing", String(players));
  assert.equal(reason({ players: { "04711": OK } }), "athlete_id_not_canonical");
  assert.equal(reason({ players: { 4711: {} } }), "player_values_missing");
  assert.equal(reason({ players: { 4711: [] } }), "player_values_missing");
  assert.equal(reason({ players: { 4711: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`m${i}`, 1])) } }), "player_values_too_many");
  for (const name of ["__proto__", "constructor", "prototype", "bad name", "x".repeat(65), "9starts_with_digit"]) {
    assert.equal(reason(JSON.parse(`{"players":{"4711":{"${name}":1,"tot_burst_events":{"unit":"number","value":1}}}}`)), "metric_name_unknown", name);
  }
  // A name refusal says which kind of name, as fixed words - never the name itself.
  for (const [names, flags] of [[["__proto__"], "prototype_key"], [["markerBad Name"], "other_chars"], [["x".repeat(65), "constructor"], "prototype_key/too_long"]]) {
    const body = JSON.parse(`{"players":{"987654321":{${names.map((n) => `"${n}":1`).join(",")}}}}`);
    const e = (() => { try { projectSessionDetails(body); return null; } catch (err) { return err; } })();
    assert.equal(e.message, `The source answer to the whole-session details names a metric in an unknown way. Diagnostic: op=session_details; names=${flags}.`, flags);
    assert.ok(!e.message.includes("markerBad") && !e.message.includes("987654321") && !e.message.includes("xxxx"));
  }
  assert.equal(reason({ players: { 4711: { tot_burst_events: OK } }, drills_count: 3 }, 2), "drills_count_disagrees");

  // A malformed consumed field fails, naming only that field and its kind.
  for (const [field, value, kind] of [
    ["tot_burst_events", [1, 2], "array"], ["tot_burst_events", { unit: "number", value: { n: 1 } }, "object"], ["tot_brake_events", "a free text that is long", "text_long"],
    ["tot_burst_events", Infinity, "number_not_finite"], ["tot_brake_events", -Infinity, "number_not_finite"], ["tot_burst_events", NaN, "number_not_finite"],
    ["tot_brake_events", { unit: "number", value: Infinity }, "object"], ["tot_burst_events", Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])), "object"],
  ]) {
    const e = (() => { try { projectSessionDetails({ players: { 987654321: { [field]: value } } }); return null; } catch (err) { return err; } })();
    assert.deepEqual([e?.code, e?.reason, e?.field], ["source_answer_unexpected", "consumed_field_shape_unknown", field], `${field} ${kind}`);
    assert.equal(e.message, `The source answer to the whole-session details carries a consumed metric in an unknown shape. Diagnostic: op=session_details; field=${field}; kind=${kind}.`, "the sentence before the mark stays generic; the field is named after it");
    assert.ok(!e.message.includes("987654321"));
  }

  // Through the adapter: the whole-session read projects, and since 2026-10-09 the drill read of the same answer too.
  const unrelated = { k1: null, k2: 2, k3: "ok", k4: "free text with spaces", k5: 5, k6: null, k7: "a-b", k8: 8 };
  const { a } = await confirmedAdapter({ [WHOLE]: answer(200, details({ 4711: { tot_burst_events: OK, tot_brake_events: OK, markerObj: unrelated } })) });
  assert.deepEqual((await a.getSessionDetails({ sessionId: "100" })).players, { 4711: { tot_burst_events: OK, tot_brake_events: OK } });
  const { a: d } = await confirmedAdapter({ [D0]: answer(200, details({ 4711: { tot_burst_events: OK, markerObj: unrelated } })) });
  assert.deepEqual((await d.getSessionDrillDetails({ sessionId: "100", drillIndex: 0 })).players, { 4711: { tot_burst_events: OK } }, "the drill answer is projected the same way");
});

test("B7.6b projectStoredDetails: a stored bundle keeps, for every athlete of the whole session and of every drill, only the consumed fields (an object only its unit / value); the input is untouched; an empty players map stays empty; the rest of the bundle is unchanged", async () => {
  const { projectStoredDetails } = await import("../src/gpexeRestV1Adapter.js");
  const marker = { k1: null, k2: 13579.2468, k3: "free text value" };
  const stored = {
    teamSession: { id: 100, team: 980 },
    athleteSessions: [{ id: 500, athlete: 4711 }],
    details: {
      full: { players: { 4711: { tot_burst_events: { unit: "number", value: 1, extra: 7 }, markerMetricNameZq: marker } }, drills_count: 2, team: { markerTeamAggregateZq: 1 } },
      drills: { 0: { players: { 4711: { tot_brake_events: { unit: "number", value: 2 }, markerMetricNameZq: marker } }, drills_count: 2 }, 1: { players: {}, drills_count: 2 } },
    },
  };
  const before = JSON.stringify(stored);
  const out = projectStoredDetails(stored);
  assert.equal(JSON.stringify(stored), before, "the input is untouched");
  assert.deepEqual(out.details.full.players, { 4711: { tot_burst_events: { unit: "number", value: 1 } } });
  assert.deepEqual(out.details.drills["0"].players, { 4711: { tot_brake_events: { unit: "number", value: 2 } } });
  assert.deepEqual(out.details.drills["1"], { players: {}, drills_count: 2 });
  assert.deepEqual([out.teamSession, out.athleteSessions, out.details.full.drills_count], [stored.teamSession, stored.athleteSessions, 2]);
  for (const leak of ["markerMetricNameZq", "13579", "free text value", "extra", "markerTeamAggregateZq"]) assert.ok(!JSON.stringify(out).includes(leak), leak);
  assert.deepEqual(Object.keys(out.details.full).sort(), ["drills_count", "players"], "a details part keeps only players and drills_count (a legacy top-level aggregate is dropped)");
  // Idempotent: an already projected bundle, and a part without players, come back exactly as they are.
  const { canonicalJson } = await import("../src/gpexeImportPreview.js");
  assert.equal(canonicalJson(projectStoredDetails(out)), canonicalJson(out));
  const noPlayers = { details: { full: { players: {} }, drills: { 0: { drills_count: 2 } } } };
  assert.equal(canonicalJson(projectStoredDetails(noPlayers)), canonicalJson(noPlayers), "a part without players gets no players key");
  assert.equal(projectStoredDetails(null), null);
  assert.deepEqual(projectStoredDetails({ teamSession: { id: 1 } }), { teamSession: { id: 1 } }, "a bundle without details is returned as it is");
});

test("B7.7 architecture guard: the whole-session consumer (the mapper, through buildGpexeImportPlan) reads no player metric but tot_burst_events / tot_brake_events - every other key access, enumeration or descriptor read on a whole-session athlete's details fails this test", () => {
  const bundle = makeBundle({ sessionId: 5001, gpexeTeamId: 77, athletes: standardAthletes(), detailsDrills: [0] });
  const touched = new Set();
  for (const [id, values] of Object.entries(bundle.details.full.players)) {
    bundle.details.full.players[id] = new Proxy(values, {
      get(target, prop, receiver) { if (typeof prop !== "string" || !DETAILS_CONSUMED_FIELDS.includes(prop)) touched.add(`get:${String(prop)}`); return Reflect.get(target, prop, receiver); },
      has(target, prop) { touched.add(`has:${String(prop)}`); return Reflect.has(target, prop); },
      ownKeys(target) { touched.add("ownKeys"); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { touched.add(`descriptor:${String(prop)}`); return Reflect.getOwnPropertyDescriptor(target, prop); },
    });
  }
  const plan = buildGpexeImportPlan(bundle);
  assert.ok(plan.participants.some((p) => p.results.some((r) => r.level === "full" && r.values.some((v) => v.metricKey === "gpexe_burst_events"))), "the consumed fields were read");
  assert.deepEqual([...touched], [], "no other whole-session metric is read");
});

test("B7.7b architecture guard for drills: the mapper reads no drill player metric but tot_burst_events / tot_brake_events - every other key access, enumeration or descriptor read on a drill athlete's details fails this test", () => {
  const bundle = makeBundle({ sessionId: 5001, gpexeTeamId: 77, athletes: standardAthletes(), detailsDrills: [0] });
  const touched = new Set();
  let wrapped = 0;
  for (const drill of Object.values(bundle.details.drills)) {
    for (const [id, values] of Object.entries(drill.players)) {
      wrapped += 1;
      drill.players[id] = new Proxy(values, {
        get(target, prop, receiver) { if (typeof prop !== "string" || !DETAILS_CONSUMED_FIELDS.includes(prop)) touched.add(`get:${String(prop)}`); return Reflect.get(target, prop, receiver); },
        has(target, prop) { touched.add(`has:${String(prop)}`); return Reflect.has(target, prop); },
        ownKeys(target) { touched.add("ownKeys"); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, prop) { touched.add(`descriptor:${String(prop)}`); return Reflect.getOwnPropertyDescriptor(target, prop); },
      });
    }
  }
  assert.ok(wrapped > 0, "the bundle carries drill details");
  const plan = buildGpexeImportPlan(bundle);
  assert.ok(plan.participants.some((p) => p.results.some((r) => r.level !== "full" && r.values.some((v) => v.metricKey === "gpexe_burst_events"))), "the consumed drill fields were read");
  assert.deepEqual([...touched], [], "no other drill metric is read");
});

test("B7.8 static architecture guard: no consumer outside the adapter and the mapper reads the stored details (JS or SQL), and the mapper's own reads are exactly the whole-session / drill player lookup and detailsNumber's one field read", async () => {
  const srcDir = path.resolve(ROOT, "backend/src");
  const files = (await fsp.readdir(srcDir, { recursive: true })).filter((f) => f.endsWith(".js")).map((f) => path.join(srcDir, f));
  const DETAILS_READ = /\bdetails\??\.(full|drills|players)\b|->>?\s*'details'|\[\s*['"]details['"]\s*\]/;
  for (const file of files) {
    if (/gpexeRestV1Adapter\.js$|gpexeImportMapper\.js$/.test(file)) continue;
    assert.doesNotMatch(await fsp.readFile(file, "utf8"), DETAILS_READ, `${path.relative(ROOT, file)} reads the stored details`);
  }
  const mapper = await fsp.readFile(path.resolve(srcDir, "gpexeImportMapper.js"), "utf8");
  const count = (re) => (mapper.match(re) || []).length;
  assert.equal(count(/\bdetails\?\.full\b/g), 1, "one whole-session lookup");
  assert.equal(count(/\bdetails\?\.drills\b/g), 1, "one drill lookup");
  assert.equal(count(/\bdetails\?\.players\b/g), 1, "one athlete lookup");
  assert.equal(count(/\bplayerDetails\[/g), 1, "detailsNumber's one field read");
  assert.equal(count(/\bplayerDetails\??\./g), 0, "no other property of an athlete's details is read");
  assert.equal(count(/detailsNumber\(playerDetails, "/g), DETAILS_CONSUMED_FIELDS.length, "detailsNumber is called only for the consumed fields");
  for (const field of DETAILS_CONSUMED_FIELDS) assert.ok(mapper.includes(`detailsNumber(playerDetails, "${field}")`), field);
  // Since 2026-10-09 both details reads are projected: no comment claims the old drill contract, and
  // the full validator is on no read path (only its own definition names it).
  const adapterSrc = await fsp.readFile(path.resolve(srcDir, "gpexeRestV1Adapter.js"), "utf8");
  assert.doesNotMatch(adapterSrc, /drills keep the full check|op=session_details only/);
  assert.doesNotMatch(adapterSrc, /validatePlayersAnswer|describePlayersShape|formatPlayersShape/, "the full validator is not reintroduced");
  // The stored-snapshot projections never touch an imported candidate: both SQL statements of each path name only unimported statuses.
  const svc = await fsp.readFile(path.resolve(srcDir, "gpexeImportService.js"), "utf8");
  const supersedeBlock = svc.slice(svc.indexOf("const superseded = (await client.query("), svc.indexOf("const projected = projectStoredDetails(row.raw_bundle);") + 300);
  assert.equal((supersedeBlock.match(/status = 'superseded'/g) || []).length, 2, "the supersede projection selects and writes superseded rows only");
  const retentionBlock = svc.slice(svc.indexOf("export async function projectUnimportedSnapshots"), svc.indexOf("export const RETENTION_INTERVAL_HOURS"));
  assert.equal((retentionBlock.match(/status in \('pending', 'blocked', 'superseded'\)/g) || []).length, 2, "the retention projection selects and writes unimported rows only");
  assert.doesNotMatch(supersedeBlock + retentionBlock, /'imported'/, "no projection names the imported status");
  assert.match(retentionBlock, /and raw_bundle = \$3::jsonb/, "the retention write is conditional on the snapshot it read");
  assert.match(retentionBlock, /for update skip locked/, "the retention write never waits on a row another session holds");
  assert.match(svc.slice(svc.indexOf("export async function runRetention"), svc.indexOf("export const RETENTION_INTERVAL_HOURS")), /await projectUnimportedSnapshots()/, "every retention run projects");
});

// ---------------------------------------------------------------------------
// Option (c) (owner decision 2026-10-08, after the owner-run check of
// 05.10–06.10.2026 whose date-filtered answer carried five rows after the
// window): a date window reads the WHOLE team list, header paged with
// limit=100, every page checked, at most SESSION_LIST_MAX_ROWS rows, and picks
// the window out locally after the parent/drill classification. Any failed
// check refuses the whole list: never a part of it.
const { SESSION_LIST_MAX_ROWS } = await import("../src/gpexeRestV1Adapter.js");
const NEXT = (offset, extra = "") => `<https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=100&offset=${offset}${extra}>; rel="next"`;
// The whole list as the server pages it: 100 rows a page, X-Total-Count on every page.
function pagedList(rows, { total: totalGiven, totals = [], links = [], pages = null } = {}) {
  const routes = {};
  const chunks = pages ?? Array.from({ length: Math.max(1, Math.ceil(rows.length / 100)) }, (_, i) => rows.slice(i * 100, i * 100 + 100));
  const total = totalGiven ?? chunks.reduce((n, c) => n + c.length, 0);
  let offset = 0;
  chunks.forEach((chunk, i) => {
    const key = i === 0 ? LIST : `${LIST}&offset=${offset}`;
    offset += chunk.length;
    const last = i === chunks.length - 1;
    const headers = {};
    const t = totals[i] === undefined ? total : totals[i];
    if (t !== null) headers["x-total-count"] = String(t);
    const link = links[i] === undefined ? (last ? null : NEXT(offset)) : links[i];
    if (link !== null) headers.link = link;
    routes[key] = answer(200, chunk, headers);
  });
  return routes;
}
// N sessions, one a day from a start day, every third a parent of the next two.
function history(n, startDay = "2026-06-01") {
  const rows = [];
  const base = Date.parse(`${startDay}T10:00:00Z`);
  for (let i = 0; i < n; i += 1) rows.push(session(5000 + i, 980, { start_timestamp: new Date(base + i * 86_400_000).toISOString().slice(0, 19) }));
  return rows;
}
const byDay = (a, w = { fromDay: "2026-10-05", toDay: "2026-10-06" }) => a.listSessionsByDay(w);
const listCalls = (calls) => pathsOf(calls).filter((p) => p.startsWith("/rest/v1/team_session/?"));

test("C1. four and more pages: the whole list is read page by page (limit=100, offset = rows read so far) and the result is exactly the parents of the window - complete, nothing from another day", async () => {
  // 350 sessions from 2026-01-01, one a day: 2026-10-05 and 2026-10-06 are rows 277 and 278.
  const rows = history(350, "2026-01-01");
  const server = fakeServer({ ...fullRoutes(), ...pagedList(rows) });
  const r = await byDay(make(server.fetchImpl));
  assert.deepEqual(idsOf(r), ["5277", "5278"]);
  assert.deepEqual([r.total, r.drillsLeftOut, r.lookBackParentsLeftOut, r.otherParentsLeftOut], [350, 0, 1, 347]);
  const onePass = [LIST, `${LIST}&offset=100`, `${LIST}&offset=200`, `${LIST}&offset=300`];
  assert.deepEqual(listCalls(server.calls), [...onePass, ...onePass], "snapshot A, then snapshot B, each first to last page");
  assert.equal(r.listReads, 2);
  assert.ok(server.calls.every((c) => c.method === "GET" && new URL(c.url).origin === "https://server3.gpexe.com" && !c.url.includes("start_timestamp")));
});

test("C2. the five rows after the period of the owner-run check are left out locally, and the parents inside it are returned; nothing is refused for them", async () => {
  const rows = [
    session(1, 980, { start_timestamp: "2026-10-05T09:00:00" }),
    parent(2, [3, 4], 980, { start_timestamp: "2026-10-06T17:00:00" }),
    session(3, 980, { start_timestamp: "2026-10-06T17:10:00" }),
    session(4, 980, { start_timestamp: "2026-10-06T17:40:00" }),
    ...[10, 11, 12, 13, 14].map((id, i) => session(id, 980, { start_timestamp: `2026-10-07T0${i + 3}:00:00` })),
  ];
  const server = fakeServer({ ...fullRoutes(), ...pagedList(rows) });
  const r = await byDay(make(server.fetchImpl));
  assert.deepEqual(idsOf(r), ["1", "2"]);
  assert.deepEqual([r.drillsLeftOut, r.otherParentsLeftOut], [2, 5]);
});

test("C3. the classification runs on the whole list before the window is picked out: a drill row inside the window whose parent started days earlier is never a session, and a parent outside the window still makes its drills drill rows", async () => {
  const rows = [
    parent(20, [21, 22], 980, { start_timestamp: "2026-10-02T23:00:00" }),
    session(21, 980, { start_timestamp: "2026-10-05T00:10:00" }),
    session(22, 980, { start_timestamp: "2026-10-05T00:30:00" }),
    session(23, 980, { start_timestamp: "2026-10-05T11:00:00" }),
  ];
  const r = await byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(rows) }).fetchImpl));
  assert.deepEqual(idsOf(r), ["23"], "the two drill rows of an earlier parent are not sessions of the window");
  assert.deepEqual([r.drillsLeftOut, r.otherParentsLeftOut], [2, 1]);
  // The same parent named on another page than its drills: still one classification.
  const split = fakeServer({ ...fullRoutes(), ...pagedList([], { pages: [[...history(99, "2025-01-01"), rows[0]], [rows[1], rows[2], rows[3]]] }) });
  assert.deepEqual(idsOf(await byDay(make(split.fetchImpl))), ["23"]);
});

test("C4. a parent of the look-back day is classified and left out; its drill rows inside the window are drill rows, not sessions", async () => {
  const rows = [
    parent(30, [31], 980, { start_timestamp: "2026-10-04T23:40:00" }),
    session(31, 980, { start_timestamp: "2026-10-05T00:15:00" }),
    session(32, 980, { start_timestamp: "2026-10-06T08:00:00" }),
  ];
  const r = await byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(rows) }).fetchImpl));
  assert.deepEqual(idsOf(r), ["32"]);
  assert.deepEqual([r.lookBackParentsLeftOut, r.drillsLeftOut, r.otherParentsLeftOut], [1, 1, 0]);
});

test("C5. X-Total-Count must be there and stable on every page: missing on the first or a later page, changed between pages, or more or fewer rows than it says - the whole list is refused, with no partial result", async () => {
  const rows = history(250);
  const cases = [
    ["missing on the first page", { totals: [null] }, "source_answer_unexpected"],
    ["missing on a later page", { totals: [250, null] }, "source_answer_unexpected"],
    ["not a number", { totals: [250, "abc"] }, "source_answer_unexpected"],
    ["changed between pages", { totals: [250, 251] }, "source_list_changed"],
    ["more rows than it says", { total: 249 }, "source_list_changed"],
  ];
  for (const [name, opts, expected] of cases) {
    const server = fakeServer({ ...fullRoutes(), ...pagedList(rows, opts) });
    await assert.rejects(byDay(make(server.fetchImpl)), code(expected), name);
  }
  // Fewer rows than it says: the last page has no next link.
  const short = fakeServer({ ...fullRoutes(), ...pagedList(rows, { total: 260 }) });
  await assert.rejects(byDay(make(short.fetchImpl)), code("source_list_incomplete"));
});

test("C6. a row repeated, skipped or added between pages refuses the whole list", async () => {
  const rows = history(250);
  // Repeated: the second page starts with the last row of the first.
  const repeated = fakeServer({ ...fullRoutes(), ...pagedList([], { total: 250, pages: [rows.slice(0, 100), [rows[99], ...rows.slice(100, 199)], rows.slice(199)] }) });
  await assert.rejects(byDay(make(repeated.fetchImpl)), code("source_list_changed"), "repeated");
  // Skipped: the server's next link jumps past a row.
  const skipped = fakeServer({ ...fullRoutes(), ...pagedList(rows, { links: [NEXT(101)] }), [`${LIST}&offset=101`]: answer(200, rows.slice(101, 201), { "x-total-count": "250", link: NEXT(201) }) });
  await assert.rejects(byDay(make(skipped.fetchImpl)), code("source_list_changed"), "skipped by the link");
  // Skipped silently: the right links, but one row missing - fewer rows than the total.
  const silent = fakeServer({ ...fullRoutes(), ...pagedList([], { total: 250, pages: [rows.slice(0, 100), rows.slice(101, 200), rows.slice(200)] }) });
  await assert.rejects(byDay(make(silent.fetchImpl)), code("source_list_incomplete"), "skipped silently");
  // Added between pages: the total changes.
  const added = fakeServer({ ...fullRoutes(), ...pagedList([], { totals: [250, 251, 251], pages: [rows.slice(0, 100), rows.slice(100, 200), [...rows.slice(200), session(9999, 980, { start_timestamp: "2026-10-05T10:00:00" })]] }) });
  await assert.rejects(byDay(make(added.fetchImpl)), code("source_list_changed"), "added");
});

test("C7. an unsafe next link refuses the whole list before it is followed: another host, scheme, family or resource, another team, a server-side date bound, another page size, an unknown parameter, a repeated one", async () => {
  const rows = history(150);
  const links = [
    ["another host", '<https://e03.gpexe.com/rest/v1/team_session/?team=980&limit=100&offset=100>; rel="next"', "source_answer_unexpected"],
    ["plain http", '<http://server3.gpexe.com/rest/v1/team_session/?team=980&limit=100&offset=100>; rel="next"', "source_answer_unexpected"],
    ["another family", '<https://server3.gpexe.com/api/team_session/?team=980&limit=100&offset=100>; rel="next"', "source_answer_unexpected"],
    ["another resource", '<https://server3.gpexe.com/rest/v1/athlete_session/?team=980&limit=100&offset=100>; rel="next"', "source_answer_unexpected"],
    ["another team", '<https://server3.gpexe.com/rest/v1/team_session/?team=981&limit=100&offset=100>; rel="next"', "source_team_mismatch"],
    ["a date bound", NEXT(100, "&start_timestamp_gte=2026-10-04%2000%3A00%3A00"), "source_answer_unexpected"],
    ["another page size", '<https://server3.gpexe.com/rest/v1/team_session/?team=980&limit=50&offset=100>; rel="next"', "source_answer_unexpected"],
    ["no page size", '<https://server3.gpexe.com/rest/v1/team_session/?team=980&offset=100>; rel="next"', "source_answer_unexpected"],
    ["an unknown parameter", NEXT(100, "&cursor=abc"), "source_answer_unexpected"],
    ["a repeated parameter", NEXT(100, "&offset=100"), "source_answer_unexpected"],
    ["user info", '<https://x:y@server3.gpexe.com/rest/v1/team_session/?team=980&limit=100&offset=100>; rel="next"', "source_answer_unexpected"],
  ];
  for (const [name, link, expected] of links) {
    const server = fakeServer({ ...fullRoutes(), ...pagedList(rows, { links: [link] }) });
    await assert.rejects(byDay(make(server.fetchImpl)), code(expected), name);
    assert.deepEqual(listCalls(server.calls), [LIST], `${name}: the link was not followed`);
  }
  // A next link after the last row.
  const extra = fakeServer({ ...fullRoutes(), ...pagedList(history(100), { links: [NEXT(100)] }) });
  await assert.rejects(byDay(make(extra.fetchImpl)), code("source_answer_unexpected"));
});

test("C8. a row of another team, or a team in an unreadable shape, anywhere in the whole list refuses it", async () => {
  const rows = history(150);
  for (const [team, expected] of [[981, "source_team_mismatch"], ["980x", "source_answer_unexpected"], [{ id: 980 }, "source_answer_unexpected"], [null, "source_answer_unexpected"]]) {
    const bad = rows.map((r, i) => (i === 120 ? { ...r, team } : r));
    await assert.rejects(byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(bad) }).fetchImpl)), code(expected), JSON.stringify(team));
  }
});

test("C9. a start that is not a real date and time anywhere in the list - a parent, a drill row or another day's row - refuses the whole list (where it belongs is never guessed); a real leap day is read", async () => {
  const rows = [parent(40, [41], 980, { start_timestamp: "2026-10-05T10:00:00" }), session(41, 980, { start_timestamp: "2026-10-05T10:20:00" }), session(42, 980, { start_timestamp: "2026-03-01T10:00:00" })];
  for (const [at, value] of [[0, null], [0, "yesterday"], [1, "2026-10-05T24:00:00"], [1, "2026-10-05"], [2, "2026-02-29T10:00:00"], [2, "2026-13-01T10:00:00"], [2, "2026-09-31T10:00:00"], [2, "2026-03-01T10:60:00"], [2, 1789000000], [2, "0099-03-01T10:00:00"]]) {
    const bad = rows.map((r, i) => (i === at ? { ...r, start_timestamp: value } : r));
    await assert.rejects(byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(bad) }).fetchImpl)), code("source_session_start_unreadable"), JSON.stringify(value));
  }
  const leap = rows.map((r, i) => (i === 2 ? { ...r, start_timestamp: "2024-02-29T10:00:00" } : r));
  assert.deepEqual(idsOf(await byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(leap) }).fetchImpl))), ["40"]);
});

test("C10. the hard cap: a list whose X-Total-Count is above SESSION_LIST_MAX_ROWS is refused at the first page, before any further request; exactly the cap is read whole", async () => {
  assert.equal(SESSION_LIST_MAX_ROWS, 2000);
  const over = fakeServer({ ...fullRoutes(), ...pagedList(history(100), { total: 2001, links: [NEXT(100)] }) });
  await assert.rejects(byDay(make(over.fetchImpl)), code("source_list_too_large"));
  assert.deepEqual(listCalls(over.calls), [LIST], "one request only");
  const atCap = fakeServer({ ...fullRoutes(), ...pagedList(history(2000, "2021-01-01")) });
  const r = await byDay(make(atCap.fetchImpl), { fromDay: "2026-06-01", toDay: "2026-06-02" });
  assert.equal(r.total, 2000);
  assert.equal(listCalls(atCap.calls).length, 40, "20 pages, read twice");
  // A list that keeps announcing pages past the page cap is refused too.
  const endless = fakeServer({ ...fullRoutes(), ...pagedList([], { total: 2000, pages: Array.from({ length: 21 }, (_, i) => history(95, "2021-01-01").map((r) => ({ ...r, id: 100000 + i * 100 + (r.id - 5000) }))), links: Array.from({ length: 21 }, (_, i) => NEXT((i + 1) * 95)) }) });
  await assert.rejects(byDay(make(endless.fetchImpl)), code("source_list_incomplete"));
  assert.equal(listCalls(endless.calls).length, 20, "never more than the page cap; snapshot B is not sent after A failed");
});

test("C12. the whole history is classified: an ambiguous pair of rows long before the window refuses every window (source_list_ambiguous), never a thinned list", async () => {
  const rows = [
    parent(1, [3], 980, { start_timestamp: "2025-03-01T10:00:00" }),
    parent(2, [3], 980, { start_timestamp: "2025-03-01T11:00:00" }),
    session(3, 980, { start_timestamp: "2025-03-01T10:10:00" }),
    session(4, 980, { start_timestamp: "2026-10-05T10:00:00" }),
  ];
  const e = await errorOf(byDay(make(fakeServer({ ...fullRoutes(), ...pagedList(rows) }).fetchImpl)));
  assert.deepEqual([e?.code, e?.reason], ["source_list_ambiguous", "entry_named_twice"]);
});

test("C13. after a window list exactly that list's window parents are readable: a parent made readable by an earlier whole list of the same instance is withdrawn when a window list leaves it out", async () => {
  const server = full({ "/rest/v1/team_session/200/": answer(200, { id: 200, team: 980, drills_count: 0, start_timestamp: "2026-09-20T10:00:00" }) });
  const a = make(server.fetchImpl);
  await a.listSessions();
  assert.equal((await a.getSession({ sessionId: "200" })).id, 200);
  await a.listSessionsByDay({ fromDay: "2026-09-14", toDay: "2026-09-15" });
  const sent = server.calls.length;
  await assert.rejects(a.getSession({ sessionId: "200" }), code("session_not_listed"));
  await assert.rejects(a.getSessionDetails({ sessionId: "200" }), code("session_not_confirmed"));
  assert.equal(server.calls.length, sent, "nothing was sent");
  assert.equal((await a.getSession({ sessionId: "100" })).id, 100);
});

test("C14. the runbook's window section names every whole-list fail-closed cause, the unobserved next-link form and the offset-paging residual risk", async () => {
  const runbook = await fsp.readFile(path.resolve(ROOT, "docs/runbooks/gpexe-in-app-import.md"), "utf8");
  const start = runbook.indexOf("## How a check finds the sessions of its window");
  assert.ok(start >= 0);
  const section = runbook.slice(start, runbook.indexOf("\n## ", start + 3));
  for (const c of ["source_list_too_large", "source_session_start_unreadable", "source_list_ambiguous", "source_list_changed", "source_list_incomplete", "source_team_mismatch", "source_answer_unexpected"]) assert.ok(section.includes(c), c);
  assert.match(section, /next link[^.]*never been observed/i);
  assert.match(section, /residual risk/i);
  assert.doesNotMatch(section, /nothing wrong is written/i, "the residual risk is not played down");
  assert.match(section, /twice/i);
  assert.match(section, /not a transactional snapshot/i, "the two reads are not claimed to be a snapshot");
  assert.match(section, /eight GET requests/i, "the request budget is stated");
  assert.match(section, /condition 6/i, "the candidate-withdrawal blocker is referenced");
  const state = await fsp.readFile(path.resolve(ROOT, "docs/ai/CURRENT_STATE.md"), "utf8");
  const next = state.slice(state.indexOf("## Most likely next step"));
  assert.match(next, /conditions 1–3 and 6/i, "the closing summary names condition 6 as a switch blocker");
});

// A list that lives on the fake server and can change between any two
// requests: `rowsAt(n)` gives the rows the n-th list request sees (1-based),
// `totalAt(n)` the X-Total-Count it reports. Pages of 100, offset links.
function liveList({ rowsAt, totalAt = null, extra = {} }) {
  let n = 0;
  const serve = (offset) => () => {
    n += 1;
    const rows = rowsAt(n);
    const page = rows.slice(offset, offset + 100);
    const headers = { "x-total-count": String(totalAt ? totalAt(n) : rows.length) };
    if (offset + 100 < rows.length) headers.link = NEXT(offset + 100);
    return answer(200, page, headers);
  };
  const routes = { ...fullRoutes(), ...extra, [LIST]: serve(0) };
  for (let off = 100; off < 3000; off += 100) routes[`${LIST}&offset=${off}`] = serve(off);
  return fakeServer(routes);
}
const WIN = { fromDay: "2026-10-05", toDay: "2026-10-06" };
// 350 sessions from 2026-01-01 (2026-10-05 is index 277), one a parent with two drills.
function stable350() {
  const rows = history(350, "2026-01-01");
  rows[180] = parent(8000, [8001, 8002], 980, { start_timestamp: "2026-06-30T09:00:00" });
  rows[181] = session(8001, 980, { start_timestamp: "2026-06-30T09:10:00" });
  rows[182] = session(8002, 980, { start_timestamp: "2026-06-30T09:40:00" });
  return rows;
}
const changedCopy = (rows, index, patch) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r));

test("C15. the delete+insert race of offset paging is now refused: a row deleted before the second page and another created at the end of the list (the total unchanged) makes snapshot A miss a parent with drills; snapshot B differs from A and the whole list is refused - the drill rows are never returned as sessions", async () => {
  // L0: P (7000) with drills 7001 / 7002 inside the window at index 100. After
  // the first page of A, row 50 is deleted and 7999 created: L1. A = L0[0..99]
  // + L1[100..] misses P; B is all of L1. A and B differ.
  const L0 = history(250, "2025-01-01");
  L0[100] = parent(7000, [7001, 7002], 980, { start_timestamp: "2026-10-05T09:00:00" });
  L0[101] = session(7001, 980, { start_timestamp: "2026-10-05T09:10:00" });
  L0[102] = session(7002, 980, { start_timestamp: "2026-10-05T09:40:00" });
  const L1 = [...L0.slice(0, 50), ...L0.slice(51), session(7999, 980, { start_timestamp: "2026-11-01T10:00:00" })];
  const server = liveList({ rowsAt: (n) => (n === 1 ? L0 : L1) });
  const a = make(server.fetchImpl);
  const e = await errorOf(a.listSessionsByDay(WIN));
  assert.equal(e?.code, "source_list_changed");
  for (const id of ["7000", "7001", "7002"]) await assert.rejects(a.getSession({ sessionId: id }), code("session_not_listed"), id);
  assert.equal(listCalls(server.calls).length, 6, "A and B read whole (3 pages each), no retry");
});

test("D1. a stable list of 350 rows on four pages is read whole twice and gives exactly the window's parents", async () => {
  const rows = stable350();
  const server = liveList({ rowsAt: () => rows });
  const r = await byDay(make(server.fetchImpl), WIN);
  assert.deepEqual(idsOf(r), ["5277", "5278"]);
  assert.deepEqual([r.total, r.listReads, listCalls(server.calls).length], [350, 2, 8]);
});

test("D2. a change on page 2 or later between the two reads refuses the whole list (source_list_changed)", async () => {
  const rows = stable350();
  for (const index of [150, 250, 320, 349]) {
    const changed = changedCopy(rows, index, { updated_on: "2026-12-31T23:59:59" });
    const server = liveList({ rowsAt: (n) => (n <= 4 ? rows : changed) });
    await assert.rejects(byDay(make(server.fetchImpl), WIN), code("source_list_changed"), `row ${index}`);
    assert.equal(listCalls(server.calls).length, 8, `row ${index}: B read whole, no retry`);
  }
});

test("D3. the same ids in another order in snapshot B refuse the whole list", async () => {
  const rows = stable350();
  const swapped = [...rows];
  [swapped[120], swapped[121]] = [swapped[121], swapped[120]];
  await assert.rejects(byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : swapped) }).fetchImpl), WIN), code("source_list_changed"));
  const rotated = [...rows.slice(300), ...rows.slice(0, 300)];
  await assert.rejects(byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : rotated) }).fetchImpl), WIN), code("source_list_changed"));
});

test("D4. a change of any classification or candidate field between the two reads refuses the whole list: team, drills (order), drills_count, start_timestamp, category_name, end_timestamp, updated_on, is_stats_valid", async () => {
  const { SNAPSHOT_FIELDS } = await import("../src/gpexeRestV1Adapter.js");
  const rows = stable350();
  const changes = {
    team: [200, { team: "980" }],
    drills: [180, { drills: [8002, 8001] }],
    drills_count: [200, { drills_count: null }],
    start_timestamp: [200, { start_timestamp: "2026-07-20T10:00:01" }],
    category_name: [200, { category_name: "Match" }],
    end_timestamp: [200, { end_timestamp: "2026-07-20T12:00:00" }],
    updated_on: [200, { updated_on: "2026-07-21T12:00:00" }],
    is_stats_valid: [200, { is_stats_valid: false }],
  };
  assert.deepEqual(Object.keys(changes).sort(), [...SNAPSHOT_FIELDS].sort(), "every compared field has a case");
  for (const [field, [index, patch]] of Object.entries(changes)) {
    const changed = changedCopy(rows, index, patch);
    await assert.rejects(byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : changed) }).fetchImpl), WIN), code("source_list_changed"), field);
  }
  // A field outside the list (one the importer never reads) may differ.
  const noted = changedCopy(rows, 200, { notes: "another private note" });
  assert.deepEqual(idsOf(await byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : noted) }).fetchImpl), WIN)), ["5277", "5278"]);
});

test("D5. snapshot A fails: snapshot B is not sent and nothing changes in the adapter", async () => {
  const rows = stable350();
  const server = liveList({ rowsAt: () => rows, totalAt: (n) => (n === 3 ? 351 : 350) });
  const a = make(server.fetchImpl);
  await assert.rejects(a.listSessionsByDay(WIN), code("source_list_changed"));
  assert.equal(listCalls(server.calls).length, 3, "B never started");
  await assert.rejects(a.getSession({ sessionId: "5277" }), code("session_not_listed"));
});

test("D6. snapshot B fails or differs: no partial result - no session of the window, and none an earlier list made readable, stays readable, and no bundle request is sent", async () => {
  const rows = stable350();
  const readable = { "/rest/v1/team_session/5277/": answer(200, { id: 5277, team: 980, drills_count: 0, start_timestamp: "2026-10-05T10:00:00" }) };
  for (const [name, opts, expected] of [
    ["B differs", { rowsAt: (n) => (n <= 12 ? rows : changedCopy(rows, 10, { updated_on: "x" })) }, "source_list_changed"],
    ["B total changes inside B", { rowsAt: () => rows, totalAt: (n) => (n === 14 ? 351 : 350) }, "source_list_changed"],
    ["B has an unreadable start", { rowsAt: (n) => (n <= 12 ? rows : changedCopy(rows, 10, { start_timestamp: null })) }, "source_session_start_unreadable"],
    ["B has a row of another team", { rowsAt: (n) => (n <= 12 ? rows : changedCopy(rows, 10, { team: 981 })) }, "source_team_mismatch"],
  ]) {
    const server = liveList({ ...opts, extra: readable });
    const a = make(server.fetchImpl);
    // A first successful window list (requests 1-8) makes 5277 readable and
    // confirmed; the second list is A = requests 9-12, B = 13-16.
    await byDay(a, WIN);
    assert.equal((await a.getSession({ sessionId: "5277" })).id, 5277);
    const sent = server.calls.length;
    await assert.rejects(byDay(a, WIN), code(expected), name);
    const afterList = server.calls.length;
    await assert.rejects(a.getSession({ sessionId: "5277" }), code("session_not_listed"), `${name}: nothing stays readable`);
    await assert.rejects(a.fetchSessionBundle({ sessionId: "5277" }), code("session_not_listed"), `${name}: no bundle`);
    await assert.rejects(a.getSessionDetails({ sessionId: "5277" }), code("session_not_confirmed"), `${name}: the confirmation is gone`);
    assert.equal(server.calls.length, afterList, `${name}: no request after the refused list`);
    assert.ok(server.calls.slice(sent).every((c) => new URL(c.url).pathname === "/rest/v1/team_session/"), `${name}: only list requests`);
  }
});

test("D7. the cap and the page cap hold for each snapshot on its own: B over the cap is refused at its first page, B with more pages than allowed is refused at the page cap, A over the cap sends nothing more", async () => {
  const rows = history(300, "2026-01-01");
  const overB = liveList({ rowsAt: () => rows, totalAt: (n) => (n <= 3 ? 300 : 2001) });
  await assert.rejects(byDay(make(overB.fetchImpl), WIN), code("source_list_too_large"));
  assert.equal(listCalls(overB.calls).length, 4, "A whole, then one request of B");
  const overA = liveList({ rowsAt: () => rows, totalAt: () => 2001 });
  await assert.rejects(byDay(make(overA.fetchImpl), WIN), code("source_list_too_large"));
  assert.equal(listCalls(overA.calls).length, 1);
  // B announces a next page after its last counted row (2100 rows served while it says 2000).
  const big = history(2100, "2021-01-01");
  const endlessB = liveList({ rowsAt: (n) => (n <= 3 ? rows : big), totalAt: (n) => (n <= 3 ? 300 : 2000) });
  await assert.rejects(byDay(make(endlessB.fetchImpl), WIN), code("source_answer_unexpected"));
  assert.equal(listCalls(endlessB.calls).length, 3 + 20, "a next link after the last counted row of B is refused");
  const twentyOne = liveList({ rowsAt: (n) => (n <= 3 ? rows : big.slice(0, 2000)), totalAt: (n) => (n <= 3 ? 300 : 2000) });
  const pagesOfB = await errorOf(byDay(make(twentyOne.fetchImpl), WIN));
  assert.equal(pagesOfB?.code, "source_list_changed", "B (2000 rows, 20 pages) is read whole and differs from A");
  assert.equal(listCalls(twentyOne.calls).length, 3 + 20);
});

test("D7b. snapshot B over the page cap itself: pages of 95 rows, consistent links and a total of 2000 announce a 21st page - B is refused at the page cap (source_list_incomplete) after exactly 20 requests of its own", async () => {
  const rows = history(300, "2026-01-01");
  const big = history(2000, "2021-01-01");
  let n = 0;
  const serve = (offset) => () => {
    n += 1;
    if (n <= 3) {
      const page = rows.slice(offset, offset + 100);
      return answer(200, page, { "x-total-count": "300", ...(offset + 100 < 300 ? { link: NEXT(offset + 100) } : {}) });
    }
    return answer(200, big.slice(offset, offset + 95), { "x-total-count": "2000", link: NEXT(offset + 95) });
  };
  const routes = { ...fullRoutes(), [LIST]: serve(0) };
  for (let off = 1; off < 3000; off += 1) routes[`${LIST}&offset=${off}`] = serve(off);
  const server = fakeServer(routes);
  await assert.rejects(byDay(make(server.fetchImpl), WIN), code("source_list_incomplete"));
  assert.equal(listCalls(server.calls).length, 3 + 20, "A whole, then exactly the page cap of B");
});

test("D10. the caller's facts are re-checked between the two complete reads: beforeSecondRead runs after A and before B; when it refuses, B is never sent, the error is the caller's own, and nothing stays readable", async () => {
  const rows = stable350();
  const server = liveList({ rowsAt: () => rows });
  const a = make(server.fetchImpl);
  let calledAfter = null;
  await byDay(a, { ...WIN, beforeSecondRead: async () => { calledAfter = listCalls(server.calls).length; } });
  assert.equal(calledAfter, 4, "after the four pages of A, before B");
  const refusing = liveList({ rowsAt: () => rows });
  const b = make(refusing.fetchImpl);
  await byDay(b, WIN);
  const before = listCalls(refusing.calls).length;
  const err = Object.assign(new Error("binding ended"), { code: "binding_ended" });
  const e = await errorOf(b.listSessionsByDay({ ...WIN, beforeSecondRead: async () => { throw err; } }));
  assert.equal(e, err);
  assert.equal(listCalls(refusing.calls).length - before, 4, "A only; B never sent");
  await assert.rejects(b.getSession({ sessionId: "5277" }), code("session_not_listed"));
  await assert.rejects(b.listSessionsByDay({ ...WIN, beforeSecondRead: "yes" }), code("invalid_options"));
});

test("D8. neither snapshot records anything before A and B are confirmed equal: a refused pair leaves no drill classification behind, so a later list in which that row is a parent is accepted", async () => {
  const P = parent(9000, [9001], 980, { start_timestamp: "2026-10-05T09:00:00" });
  const D = session(9001, 980, { start_timestamp: "2026-10-05T09:20:00" });
  const X = (updated) => session(9002, 980, { start_timestamp: "2026-10-05T12:00:00", updated_on: updated });
  // Read 1 (A) and read 2 (B) both see 9001 as a drill of 9000 and differ only in 9002;
  // reads 3 and 4 see the list after 9000 was deleted: 9001 is a parent now.
  const server = liveList({ rowsAt: (n) => (n === 1 ? [P, D, X("v1")] : n === 2 ? [P, D, X("v2")] : [D, X("v2")]) });
  const a = make(server.fetchImpl);
  await assert.rejects(a.listSessionsByDay(WIN), code("source_list_changed"));
  const r = await a.listSessionsByDay(WIN);
  assert.deepEqual(idsOf(r), ["9001", "9002"], "no classification_conflict: the refused reads recorded nothing");
});

test("D9. snapshot B with one more row at the end (or one fewer), every common row equal, refuses the whole list: the totals and lengths are compared, not only the rows of A", async () => {
  const rows = stable350();
  const longer = [...rows, session(9999, 980, { start_timestamp: "2026-12-01T10:00:00" })];
  await assert.rejects(byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : longer) }).fetchImpl), WIN), code("source_list_changed"), "one row more in B");
  const shorter = rows.slice(0, 349);
  await assert.rejects(byDay(make(liveList({ rowsAt: (n) => (n <= 4 ? rows : shorter) }).fetchImpl), WIN), code("source_list_changed"), "one row fewer in B");
});

test("C11. any failed check returns nothing: no session of the window is returned or made readable when a later page fails, and the window result never falls back to a server-side date filter", async () => {
  const rows = history(250, "2026-08-01");
  const routes = { ...fullRoutes(), ...pagedList(rows, { totals: [250, 250, 251] }) };
  const server = fakeServer(routes);
  const a = make(server.fetchImpl);
  const e = await errorOf(a.listSessionsByDay({ fromDay: "2026-08-01", toDay: "2026-08-02" }));
  assert.equal(e?.code, "source_list_changed");
  await assert.rejects(a.getSession({ sessionId: "5000" }), code("session_not_listed"), "nothing of the refused list became readable");
  assert.ok(!server.calls.some((c) => c.url.includes("start_timestamp")), "no fallback to the date filter");
  assert.equal(listCalls(server.calls).length, 3, "no retry, and snapshot B is not sent after A failed");
});
