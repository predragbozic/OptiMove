// Contract tests of the owner-run rest_v1 capability probe (F3c2b). Fake
// fetch only: no network, no database, no environment secret. Every value
// below that looks like a secret or a person is a marker made up here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATHLETE_LIST_FIELDS, ATHLETE_LIST_MODE_MAX_REQUESTS, ATHLETE_LIST_PRINTABLE_KEYS, athleteListFilterDescribed, projectableValue, ATHLETE_LIST_PAUSE_MS, ATHLETE_LIST_ROWS_PER_SESSION, ATHLETE_LIST_SESSIONS, retryAfterOf, valueKind,
  answerWithContent, canonical, dayOf, maskProbePath, printableFieldNames, describeDrillAnswer, describeDrillEntries, describeDrillLink, describeTeamValue, diagnosticLinkConfirmed, DRILL_MODE_MAX_REQUESTS, DRILL_POSITIONS, DRILL_READ_SEQUENCE, LEGACY_API_PATH, LEGACY_API_PREFIX, assertNoIdentityValueInReport, reportVocabulary, IDENTITY_CHILD_KEYS, IDENTITY_NAME_FIELDS, IDENTITY_BIRTH_FIELDS, IDENTITY_SCHEMA_FIELDS, IDENTITY_HEADER_NAMES, IDENTITY_HEADER_VALUE_SHAPES, IDENTITY_AUTH_SCHEMES, identityFilterDescribed, describeAthleteTeams, describeIdentityFields, describeResourceIndex, IDENTITY_BIRTH_KEY, IDENTITY_CONTAINER_KEYS, IDENTITY_MAX_DEPTH, IDENTITY_MAX_ITEMS, IDENTITY_MAX_PATHS, IDENTITY_MODE_MAX_REQUESTS, IDENTITY_NAME_KEY, MAX_EXCHANGE_BYTES, MAX_REQUESTS, parseArgs, parseTotal, PROBE_HOST, PROBE_MODES, PROBE_TEAM, runCapabilityProbe, safeId, TEAM_VALUE_KINDS,
} from "../scripts/gpexe-rest-v1-capability-probe.mjs";
import { DiscoveryUsageError } from "../scripts/gpexe-auth-discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const USER = "fake.user@example.invalid";
const PASSWORD = "Fake-Password-not-real-42";
const ISSUED = "FAKE-ISSUED-TOKEN-fedcba9876543210-not-real";
const ENV = { GPEXE_USERNAME: USER, GPEXE_PASSWORD: PASSWORD };
const R = "https://server3.gpexe.com/rest/v1/";
const json = { "content-type": "application/json" };
const bytesOf = (text) => new TextEncoder().encode(text);

function streamOf(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(chunks[i]);
      i += 1;
    },
  }, { highWaterMark: 0 });
}
// An answer the exchange reads with json() and every GET reads from its stream.
function answer(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status, headers: new Headers({ ...json, ...headers }),
    json: async () => JSON.parse(text),
    get body() { return streamOf([bytesOf(text)]); },
    text: async () => { throw new Error("the probe must not ask for the whole body"); },
  };
}

// Markers that must never appear in a report.
const MARKERS = {
  athleteName: "Marker Athlete Name", sessionName: "Marker Session Name", note: "marker private note", tz: "Europe/Marker",
  tagName: "marker tag", value: 1234.5678, trackSerial: "MARKER-DEVICE-SERIAL",
};
const DAY = "2026-09-14";
const OTHER_DAY = "2026-09-10";
const sess = (id, team, day, drills, extra = {}) => ({ id, team, name: MARKERS.sessionName, notes: MARKERS.note, start_timestamp: `${day}T10:00:00`, drills, drills_count: drills.length, category_name: "Training", is_stats_valid: true, ...extra });
const WHOLE = { athlete_sessions: [{ athlete_name: MARKERS.athleteName, total_distance: 5000.5 }], session: 100 };
const DRILL = { athlete_sessions: [{ athlete_name: MARKERS.athleteName, total_distance: 1200.25 }], session: 100, drill: 0 };

// The happy server3 for the full run: every capability present; the full run reads no drill.
function happyRoutes(over = {}) {
  return {
    "POST /api-token-auth/": (init) => {
      const b = Object.fromEntries(new URLSearchParams(init.body));
      return init.headers["Content-Type"] === "application/x-www-form-urlencoded" && b.username === USER && b.password === PASSWORD
        ? answer(200, { token: ISSUED }) : answer(400, { non_field_errors: ["Unable to log in."] });
    },
    "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, []), sess(200, 980, OTHER_DAY, [])], { "x-total-count": "4" }),
    "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DAY, [101, 102])),
    "GET /rest/v1/team_session/100/details/": answer(200, WHOLE),
    [`GET /rest/v1/team_session/?team=980&start_timestamp_gte=${encodeURIComponent(`${DAY} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${DAY} 23:59:59`)}&limit=100`]:
      answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, [])], { "x-total-count": "3" }),
    "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [{ id: 500, teamsession: 100, track: 900, athlete_name: MARKERS.athleteName, max_v: MARKERS.value }], { "x-total-count": "1" }),
    "GET /rest/v1/athlete_session/500/": answer(200, { id: 500, teamsession: 100, track: 900, athlete_name: MARKERS.athleteName, max_v: MARKERS.value }),
    "GET /rest/v1/athlete_session/500/more/": answer(200, { id: 500, bursts: 7, brakes: 3 }),
    "GET /rest/v1/track/900/": answer(200, { id: 900, timezone: MARKERS.tz, device: MARKERS.trackSerial }),
    [`GET /rest/v1/team/980/thresholds/?valid_on=${DAY}`]: answer(200, [{ id: 5, valid_from: "2026-01-01", sprint_speed: MARKERS.value }]),
    "GET /rest/v1/team_session_tag/?team=980&limit=5": answer(200, [{ id: 1, name: MARKERS.tagName, team: 980 }], { "x-total-count": "1" }),
    ...over,
  };
}
function fakeServer(routes = happyRoutes()) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect, signal: init.signal });
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    const route = routes[key];
    if (route === undefined) return answer(404, { detail: "Not found." });
    return typeof route === "function" ? route(init, u) : route;
  };
  return { calls, fetchImpl };
}
const run = (fetchImpl, over = {}) => runCapabilityProbe({ ...over }, ENV, fetchImpl);
const verdicts = (report) => Object.fromEntries(Object.entries(report.capabilities).map(([k, v]) => [k, v.verdict]));

test("1. the happy run: one exchange, then GET only, 11 requests in a fixed order, every capability classified, every id derived from the previous answer, no drill read", async () => {
  const { calls, fetchImpl } = fakeServer({
    ...happyRoutes(),
    // Even when a drill route exists, the full run never asks for it.
    "GET /rest/v1/team_session/100/details/?drill=0": answer(200, DRILL),
    "GET /rest/v1/team_session/101/details/": answer(200, DRILL),
    "GET /rest/v1/team_session/101/": answer(200, sess(101, 980, DAY, [])),
  });
  const report = await run(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.equal(report.requestCount, 11);
  assert.ok(!calls.some((c) => c.url.includes("drill=") || c.url.includes("/101/") || c.url.includes("/api/team_session")), "no drill read, no drills entry as an id, no legacy read");
  assert.ok(report.requestCount <= MAX_REQUESTS);
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`), [
    "POST /api-token-auth/",
    "GET /rest/v1/team_session/?team=980&limit=100",
    "GET /rest/v1/team_session/100/",
    "GET /rest/v1/team_session/100/details/",
    `GET /rest/v1/team_session/?team=980&start_timestamp_gte=${encodeURIComponent(`${DAY} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${DAY} 23:59:59`)}&limit=100`,
    "GET /rest/v1/athlete_session/?teamsession=100&limit=100",
    "GET /rest/v1/athlete_session/500/",
    "GET /rest/v1/athlete_session/500/more/",
    "GET /rest/v1/track/900/",
    `GET /rest/v1/team/980/thresholds/?valid_on=${DAY}`,
    "GET /rest/v1/team_session_tag/?team=980&limit=5",
  ]);
  assert.deepEqual(verdicts(report), {
    session_list: "proven", session_read: "same", session_details: "same", session_drill_details: "not_observed", session_list_by_date: "same",
    athlete_session_list: "same", athlete_session_read: "same", athlete_session_more: "same", track_read: "same", team_thresholds: "same",
    session_tags: "observed", units: "not_observed",
  });
  assert.deepEqual(report.capabilities.session_drill_details, { verdict: "not_observed", reason: "drill_read_only_in_drill_mode" });
  assert.deepEqual(report.capabilities.session_list_by_date, { verdict: "same", status: 200, allRowsTeam980: true, allRowsInsideWindow: true, chosenSessionAmong: true, filteredCountSmallerThanUnfiltered: true, filteredTotalIsNumber: true, rowCount: 3 });
  assert.equal(report.capabilities.session_read.parentConfirmed, true);
  assert.equal(report.capabilities.session_read.drillsCountPresent, true);
  assert.equal(report.capabilities.session_read.startTimestampPresent, true);
  assert.equal(report.capabilities.session_list.totalIsNumber, true);
  assert.ok(!("listRowMatchesFirstDrill" in report.capabilities.session_list), "the drill-only helper facts are not in the full run");
  assert.equal(report.capabilities.track_read.hasTimezoneField, true);
  assert.equal(report.capabilities.athlete_session_read.trackIdDerived, true);
  assert.equal(report.capabilities.athlete_session_read.rowOfSession, true);
  assert.equal(report.capabilities.session_tags.rowsNameATeam, true);
});

test("2. GET only after the one form-encoded exchange; the token only in the Authorization header; one host, one family; redirects manual", async () => {
  const { calls, fetchImpl } = fakeServer();
  await run(fetchImpl);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 1, "exactly one non-GET request: the exchange");
  for (const c of calls.slice(1)) {
    assert.equal(c.method, "GET");
    assert.equal(c.body, undefined);
    assert.equal(c.headers.Authorization, `Token ${ISSUED}`);
    assert.equal(c.redirect, "manual");
    assert.ok(c.url.startsWith(R), c.url);
    assert.ok(!c.url.includes(ISSUED) && !c.url.includes(PASSWORD) && !c.url.includes(USER));
    assert.ok(c.signal instanceof AbortSignal, "every read has a timeout signal");
  }
});

test("3. the report holds statuses, shapes, field names, counts and booleans only: no name, value, result, id, token, address or password", async () => {
  const { fetchImpl } = fakeServer();
  const report = await run(fetchImpl);
  const text = JSON.stringify(report);
  for (const m of [...Object.values(MARKERS).map(String), ISSUED, USER, PASSWORD, "5000.5", "1200.25", "fedcba"]) assert.ok(!text.includes(m), `report must not contain ${m}`);
  for (const id of ["100", "101", "102", "500", "900", "200"]) assert.ok(!new RegExp(`\\b${id}\\b`).test(text.replace(/"status":\d+/g, "").replace(/"ordinalStatus":\d+|"byIdStatus":\d+/g, "").replace(/"rowCount":\d+/g, "")), `no id ${id} in the report`);
  assert.ok(!text.includes(DAY) && !text.includes("09-14") && !text.includes("23:59"), "the window's day is masked");
  assert.ok(report.requests.some((r) => r.path === "rest/v1/team_session/?team=<team>&start_timestamp_gte=<date>&start_timestamp_lte=<date>&limit=<n>"), JSON.stringify(report.requests.map((r) => r.path)));
  assert.ok(report.requests.some((r) => r.path === "rest/v1/athlete_session/?teamsession=<id>&limit=<n>"));
  assert.ok(!text.includes("limit=<id>"), "a page size is not an id");
  for (const d of [DAY, OTHER_DAY, DAY.slice(5), OTHER_DAY.slice(5)]) assert.ok(!text.includes(d), `no day ${d}`);
  assert.ok(!text.includes("980") || text.includes('"teamId":"980"'), "the team id appears only as the declared target");
  assert.ok(text.includes("<team>") && text.includes("<id>"), "paths are masked");
  for (const r of report.requests) {
    assert.ok(!("_body" in r) && !("body" in r), "no body travels in the report");
    for (const k of Object.keys(r)) assert.ok(["method", "path", "authenticated", "bodyEncoding", "status", "authScheme", "allow", "contentType", "totalCount", "gpexeVersion", "bodyKind", "fieldNames", "arrayLength", "headerNames", "resultsLength", "resultFieldNames", "count", "containsTeam", "error", "redirected", "note"].includes(k), k);
  }
  // Field NAMES are allowed and useful; the importer's drop list of personal fields applies first,
  // so a field like athlete_name is not even named.
  assert.ok(report.requests.some((r) => Array.isArray(r.fieldNames) && r.fieldNames.includes("teamsession")));
  assert.ok(!report.requests.some((r) => Array.isArray(r.fieldNames) && r.fieldNames.includes("athlete_name")), "personal fields are dropped before anything is described");
});

test("4. team isolation: a session row of another team stops the whole run after that answer; athlete rows of another session stop it as well", async () => {
  const foreign = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101]), sess(300, 981, DAY, [])], { "x-total-count": "2" }),
  }));
  const a = await run(foreign.fetchImpl);
  assert.equal(a.stoppedBy, "team_isolation_failed");
  assert.equal(foreign.calls.length, 2, "nothing was requested after the foreign row");
  assert.ok(!JSON.stringify(a).includes("981"), "the foreign team is not named");
  const other = fakeServer(happyRoutes({
    "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [{ id: 500, teamsession: 100 }, { id: 501, teamsession: 777 }], { "x-total-count": "2" }),
  }));
  const b = await run(other.fetchImpl);
  assert.equal(b.stoppedBy, "team_isolation_failed");
  assert.ok(!other.calls.some((c) => c.url.includes("/athlete_session/500/") || c.url.includes("/track/")), "no athlete row or track was read after the mixed list");
  // Athlete rows that name no session in a readable way are not foreign: they are simply not used.
  const unnamed = fakeServer(happyRoutes({
    "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [{ id: 500, track: 900 }], { "x-total-count": "1" }),
  }));
  const u = await run(unnamed.fetchImpl);
  assert.equal(u.stoppedBy, null);
  assert.equal(u.capabilities.athlete_session_list.verdict, "not_observed");
  assert.equal(u.capabilities.athlete_session_list.reason, "rows_do_not_name_session");
  assert.equal(u.capabilities.athlete_session_read.reason, "no_safe_athlete_id");
  assert.equal(u.capabilities.track_read.reason, "no_safe_track_id");
  assert.ok(!unnamed.calls.some((c) => c.url.includes("/athlete_session/500/") || c.url.includes("/track/")));
  assert.equal(u.capabilities.team_thresholds.verdict, "same", "the independent reads still run");
  // A team in a shape the probe cannot read stops the run as well: an unreadable team is not a confirmed team.
  for (const shape of [{ id: 980 }, "https://server3.gpexe.com/rest/v1/team/980/", [980]]) {
    const odd = fakeServer(happyRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101]), sess(300, shape, DAY, [])], { "x-total-count": "2" }) }));
    const r = await run(odd.fetchImpl);
    assert.equal(r.stoppedBy, "team_unknown_shape", JSON.stringify(shape));
    assert.equal(odd.calls.length, 2);
  }
  // A tag row of another team stops the run; the tag list is asked for team 980.
  const tagForeign = fakeServer(happyRoutes({ "GET /rest/v1/team_session_tag/?team=980&limit=5": answer(200, [{ id: 1, team: 981 }], { "x-total-count": "1" }) }));
  const t = await run(tagForeign.fetchImpl);
  assert.equal(t.stoppedBy, "team_isolation_failed");
  assert.ok(tagForeign.calls.every((x) => !x.url.includes("team_session_tag/?limit=")), "the tag list is never read unscoped");
  // A filtered list with a foreign row stops too.
  const filteredForeign = fakeServer(happyRoutes({
    [`GET /rest/v1/team_session/?team=980&start_timestamp_gte=${encodeURIComponent(`${DAY} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${DAY} 23:59:59`)}&limit=100`]: answer(200, [sess(100, 981, DAY, [])], { "x-total-count": "1" }),
  }));
  const c = await run(filteredForeign.fetchImpl);
  assert.equal(c.stoppedBy, "team_isolation_failed");
  assert.ok(!filteredForeign.calls.some((x) => x.url.includes("athlete_session")));
});

test("5. the chain stops as soon as the previous answer gives no safe next id: no athlete row, no track, no drill, no parent", async () => {
  // No athlete rows: the row read, /more/ and the track are never requested.
  const empty = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [], { "x-total-count": "0" }) }));
  const a = await run(empty.fetchImpl);
  assert.equal(a.capabilities.athlete_session_read.reason, "no_safe_athlete_id");
  assert.equal(a.capabilities.athlete_session_more.reason, "no_safe_athlete_id");
  assert.equal(a.capabilities.track_read.reason, "no_safe_track_id");
  assert.ok(!empty.calls.some((c) => /athlete_session\/\d+\/|\/track\//.test(c.url)));
  assert.equal(a.capabilities.team_thresholds.verdict, "same", "independent reads still run");
  // The confirmed detail has no track field: no track request, whatever the list row said.
  const noTrack = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, { id: 500, teamsession: 100 }) }));
  const b = await run(noTrack.fetchImpl);
  assert.equal(b.capabilities.athlete_session_read.trackIdDerived, false);
  assert.equal(b.capabilities.track_read.reason, "no_safe_track_id");
  assert.ok(!noTrack.calls.some((c) => c.url.includes("/track/")));
  // A track id in the detail that is not a canonical id is not used.
  const badTrack = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, { id: 500, teamsession: 100, track: "https://evil.example/900" }) }));
  const c = await run(badTrack.fetchImpl);
  assert.equal(c.capabilities.track_read.reason, "no_safe_track_id");
  assert.ok(!badTrack.calls.some((x) => x.url.includes("/track/") || x.url.includes("evil")));
  // No session has a drill: the chosen session is the first unnamed row, the drill rows are not requested.
  const noDrills = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, []), sess(200, 980, OTHER_DAY, [])], { "x-total-count": "2" }),
    "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DAY, [])),
  }));
  const d = await run(noDrills.fetchImpl);
  assert.equal(d.capabilities.session_list.parentChosen, false);
  assert.equal(d.capabilities.session_list.parentUnconfirmed, true);
  assert.equal(d.capabilities.session_read.parentConfirmed, false);
  assert.deepEqual(d.capabilities.session_drill_details, { verdict: "not_observed", reason: "drill_read_only_in_drill_mode" });
  assert.ok(!noDrills.calls.some((c) => c.url.includes("drill=") || c.url.includes("/101/")));
  // A session whose own read does not confirm team 980: no details, no athlete rows.
  const unconfirmedTeam = fakeServer(happyRoutes({ "GET /rest/v1/team_session/100/": answer(200, { id: 100, drills_count: 2, drills: [101, 102] }) }));
  const g = await run(unconfirmedTeam.fetchImpl);
  assert.equal(g.capabilities.session_read.teamIs980, false);
  assert.deepEqual(g.capabilities.session_details, { verdict: "not_observed", reason: "session_not_confirmed" });
  assert.deepEqual(g.capabilities.athlete_session_list, { verdict: "not_observed", reason: "session_not_confirmed" });
  assert.deepEqual(g.capabilities.session_list_by_date, { verdict: "not_observed", reason: "session_not_confirmed" });
  assert.ok(!unconfirmedTeam.calls.some((c) => c.url.includes("start_timestamp")));
  // A session read without drills_count or a start timestamp is not the importer's session read.
  const thin = fakeServer(happyRoutes({ "GET /rest/v1/team_session/100/": answer(200, { id: 100, team: 980, drills: [101, 102] }) }));
  const th = await run(thin.fetchImpl);
  assert.equal(th.capabilities.session_read.verdict, "not_observed");
  assert.equal(th.capabilities.session_read.teamIs980, true);
  assert.equal(th.capabilities.session_read.drillsCountPresent, false);
  assert.ok(!unconfirmedTeam.calls.some((c) => c.url.includes("/details/") || c.url.includes("athlete_session") || c.url.includes("thresholds")));
  assert.deepEqual(g.capabilities.team_thresholds, { verdict: "not_observed", reason: "session_not_confirmed" }, "no confirmed day, so no thresholds");
  assert.equal(g.capabilities.session_tags.verdict, "observed", "the tag list still runs");
  // The list row says it has drills but the session's own read does not confirm it: still no drill request.
  const unconfirmed = fakeServer(happyRoutes({ "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DAY, [], { drills_count: 0 })) }));
  const e = await run(unconfirmed.fetchImpl);
  assert.equal(e.capabilities.session_drill_details.reason, "drill_read_only_in_drill_mode");
  assert.ok(!unconfirmed.calls.some((c) => c.url.includes("drill=")));
  // No usable session id at all: the run stops after the list.
  const noIds = fakeServer(happyRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [{ team: 980, drills: [] }], { "x-total-count": "1" }) }));
  const f = await run(noIds.fetchImpl);
  assert.equal(f.stoppedBy, "no_safe_session_id");
  assert.equal(noIds.calls.length, 2);
});

test("5b. the athlete chain depends on the row's own confirmed detail: /more/ and the track are read only after a 200 detail that names the same session, and the track id comes from that detail only", async () => {
  // The list says track 900, the confirmed detail says track 901: the detail decides.
  const differs = fakeServer(happyRoutes({
    "GET /rest/v1/athlete_session/500/": answer(200, { id: 500, teamsession: 100, track: 901 }),
    "GET /rest/v1/track/901/": answer(200, { id: 901, timezone: MARKERS.tz }),
  }));
  const a = await run(differs.fetchImpl);
  assert.equal(a.stoppedBy, null);
  assert.equal(a.capabilities.track_read.verdict, "same");
  assert.ok(differs.calls.some((c) => c.url.endsWith("/rest/v1/track/901/")), "the detail's track was read");
  assert.ok(!differs.calls.some((c) => c.url.endsWith("/rest/v1/track/900/")), "the list's track was never read");
  assert.equal(a.capabilities.athlete_session_list.listRowHasTrackField, true);
  // The detail answers 404: no /more/, no track.
  const missing = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(404, { detail: "Not found." }) }));
  const b = await run(missing.fetchImpl);
  assert.equal(b.stoppedBy, null);
  assert.equal(b.capabilities.athlete_session_read.verdict, "not_observed");
  assert.deepEqual(b.capabilities.athlete_session_more, { verdict: "not_observed", reason: "detail_not_confirmed" });
  assert.equal(b.capabilities.track_read.reason, "no_safe_track_id");
  assert.ok(!missing.calls.some((c) => c.url.includes("/more/") || c.url.includes("/track/")));
  assert.equal(b.capabilities.team_thresholds.verdict, "same", "the fixed-team reads still run");
  // The detail names another session: the whole run stops, nothing dependent is read.
  const other = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, { id: 500, teamsession: 777, track: 900 }) }));
  const c = await run(other.fetchImpl);
  assert.equal(c.stoppedBy, "team_isolation_failed");
  assert.ok(!other.calls.some((x) => x.url.includes("/more/") || x.url.includes("/track/") || x.url.includes("thresholds")));
  assert.ok(!JSON.stringify(c).includes("777"));
  // The detail names no session in a readable way: not_observed, no /more/, no track.
  for (const detail of [{ id: 500, track: 900 }, { id: 500, teamsession: { id: 100 }, track: 900 }, { id: 500, teamsession: "https://server3.gpexe.com/rest/v1/team_session/100/", track: 900 }]) {
    const unreadable = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, detail) }));
    const d = await run(unreadable.fetchImpl);
    assert.equal(d.stoppedBy, null, JSON.stringify(detail));
    assert.deepEqual(d.capabilities.athlete_session_read, { verdict: "not_observed", status: 200, rowOfSession: false, reason: "detail_does_not_name_session", trackIdDerived: false });
    assert.equal(d.capabilities.athlete_session_more.reason, "detail_not_confirmed");
    assert.equal(d.capabilities.track_read.reason, "no_safe_track_id");
    assert.ok(!unreadable.calls.some((x) => x.url.includes("/more/") || x.url.includes("/track/")));
  }
  // A detail of the wrong shape (a list) is not confirmed either.
  const listShaped = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, [{ id: 500, teamsession: 100, track: 900 }]) }));
  const e = await run(listShaped.fetchImpl);
  assert.equal(e.capabilities.athlete_session_read.verdict, "not_observed");
  assert.ok(!listShaped.calls.some((x) => x.url.includes("/more/") || x.url.includes("/track/")));
  // The track read fails: not_observed, nothing else changes.
  const trackGone = fakeServer(happyRoutes({ "GET /rest/v1/track/900/": answer(404, { detail: "Not found." }) }));
  const f = await run(trackGone.fetchImpl);
  assert.equal(f.capabilities.track_read.verdict, "not_observed");
  assert.equal(f.capabilities.track_read.status, 404);
  assert.equal(f.stoppedBy, null);
});

test("5c. the day comes from the session's own confirmed read: the date window is not judged when the list and the detail disagree, and thresholds use the detail's day only", async () => {
  const DETAIL_DAY = "2026-09-12";
  const moved = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DETAIL_DAY, [101, 102])),
    [`GET /rest/v1/team/980/thresholds/?valid_on=${DETAIL_DAY}`]: answer(200, [{ id: 5 }]),
  }));
  const a = await run(moved.fetchImpl);
  assert.equal(a.stoppedBy, null);
  assert.deepEqual(a.capabilities.session_list_by_date, { verdict: "not_observed", reason: "source_changed_between_list_and_detail" });
  assert.ok(!moved.calls.some((c) => c.url.includes("start_timestamp_gte")), "no window request on a day that moved");
  assert.ok(moved.calls.some((c) => c.url.endsWith(`/rest/v1/team/980/thresholds/?valid_on=${DETAIL_DAY}`)), "thresholds use the detail's day");
  assert.ok(!moved.calls.some((c) => c.url.includes(`valid_on=${DAY}`)), "never the list's day");
  assert.equal(a.capabilities.team_thresholds.verdict, "same");
  assert.ok(!JSON.stringify(a).includes(DETAIL_DAY) && !JSON.stringify(a).includes("09-12"));
  // The detail has no readable start timestamp: no day, so no window and no thresholds request.
  const noStart = fakeServer(happyRoutes({ "GET /rest/v1/team_session/100/": answer(200, { id: 100, team: 980, drills_count: 2, drills: [101, 102] }) }));
  const b = await run(noStart.fetchImpl);
  assert.equal(b.capabilities.session_read.startTimestampPresent, false);
  assert.deepEqual(b.capabilities.team_thresholds, { verdict: "not_observed", reason: "no_confirmed_day" });
  assert.ok(!noStart.calls.some((c) => c.url.includes("thresholds") || c.url.includes("start_timestamp_gte")));
  assert.equal(b.capabilities.session_list_by_date.reason, "no_confirmed_day");
  // A 200 detail with an empty body is not confirmed either, and the report's shape stays stable.
  const emptyDetail = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, "") }));
  const r = await run(emptyDetail.fetchImpl);
  assert.deepEqual(r.capabilities.athlete_session_read, { verdict: "not_observed", status: 200, rowOfSession: false, trackIdDerived: false });
  assert.ok(!emptyDetail.calls.some((x) => x.url.includes("/more/") || x.url.includes("/track/")));
});

test("6. the drill answer is described as a shape and booleans only; an answer needs content; the full run never reads a drill, even when the parent's own read lists drills", async () => {
  const P = { players: [{ athlete_name: MARKERS.athleteName, total_distance: 1200.25, zones: { z1: 3 } }], metrics: ["total_distance"], drill: 0 };
  assert.deepEqual(describeDrillAnswer(P), {
    bodyKind: "object", hasContent: true, rowsAtTopLevel: false, playersField: true, playersContainerKind: "array", playerRowsPresent: true, playerRowsAreObjects: true,
    playerRowsHaveNumbers: true, playerRowsHaveNestedValues: true, metricFieldPresent: true,
  });
  // The importer's known api shape: players keyed by the athlete id; the keys never leave.
  const MAP = { players: { 4711: { tot_burst_events: 4, total_distance: 812.5 }, 4712: { tot_burst_events: 2 } } };
  assert.deepEqual(describeDrillAnswer(MAP), {
    bodyKind: "object", hasContent: true, rowsAtTopLevel: false, playersField: true, playersContainerKind: "map", playerRowsPresent: true, playerRowsAreObjects: true,
    playerRowsHaveNumbers: true, playerRowsHaveNestedValues: false, metricFieldPresent: false,
  });
  assert.ok(!JSON.stringify(describeDrillAnswer(MAP)).includes("4711"));
  assert.equal(describeDrillAnswer({ players: {} }).playerRowsPresent, false);
  assert.equal(describeDrillAnswer({ players: { 1: 5 } }).playerRowsAreObjects, false);
  assert.equal(describeDrillAnswer({ players: "x" }).playersContainerKind, "other");
  assert.deepEqual(describeDrillAnswer([{ metric_id: 1, value: 2 }]), {
    bodyKind: "array", hasContent: true, rowsAtTopLevel: true, playersField: false, playersContainerKind: null, playerRowsPresent: true, playerRowsAreObjects: true,
    playerRowsHaveNumbers: true, playerRowsHaveNestedValues: false, metricFieldPresent: true,
  });
  assert.deepEqual(describeDrillAnswer({ detail: "x" }), {
    bodyKind: "object", hasContent: true, rowsAtTopLevel: false, playersField: false, playersContainerKind: null, playerRowsPresent: false, playerRowsAreObjects: null,
    playerRowsHaveNumbers: null, playerRowsHaveNestedValues: null, metricFieldPresent: false,
  });
  assert.deepEqual(describeDrillAnswer({ players: ["a", 1] }).playerRowsAreObjects, false);
  // Field names are printed only when every one is an identifier.
  assert.equal(printableFieldNames(["drill", "players", "KPI_completed"]), true);
  // Real GPEXE shapes keep their names: a 41-character key, many keys.
  assert.equal(printableFieldNames(["are_relative_speed_distance_zones_visible", "are_relative_speed_distance_zones_visible_x"]), true);
  assert.equal(printableFieldNames(Array.from({ length: 120 }, (_, i) => `k${i}`)), true);
  for (const bad of [["12345"], ["2026-09-14"], ["Marker Athlete Name"], ["ok", "4711"], ["a".repeat(65)], Array.from({ length: 201 }, (_, i) => `k${i}`)]) assert.equal(printableFieldNames(bad), false, JSON.stringify(bad).slice(0, 40));
  // An id that contains the team's digits is masked whole.
  assert.equal(maskProbePath("api/team_session/19805/details/?drill=0", "980"), "api/team_session/<id>/details/?drill=0");
  assert.equal(maskProbePath("rest/v1/team/980/thresholds/?valid_on=2026-09-14", "980"), "rest/v1/team/<team>/thresholds/?valid_on=<date>");
  assert.equal(maskProbePath("api/team_session/12/34/", "980"), "api/team_session/<id>/<id>/");
  assert.equal(maskProbePath("rest/v1/athlete_session/?teamsession=198057&limit=100", "980"), "rest/v1/athlete_session/?teamsession=<id>&limit=<n>");
  assert.ok(!maskProbePath("rest/v1/team_session/98012/", "980").match(/\d{2,}/));
  for (const b of [undefined, null, "x", 42, true]) assert.equal(describeDrillAnswer(b).hasContent, false, String(b));
  assert.equal(describeDrillAnswer(undefined).bodyKind, null);
  assert.equal(describeDrillAnswer("x").bodyKind, "string");
  for (const b of [[], {}, undefined, null, "x", 0]) assert.equal(answerWithContent(b), false, JSON.stringify(b));
  for (const b of [[{}], { a: 1 }]) assert.equal(answerWithContent(b), true, JSON.stringify(b));
  // Nothing of a row leaves the description.
  const text = JSON.stringify(describeDrillAnswer(P));
  for (const m of [MARKERS.athleteName, "1200.25", "total_distance", "z1"]) assert.ok(!text.includes(m), m);
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // The full run, even when the parent's own read lists drills: no drill request, no drills entry as an id.
  const listed = fakeServer({
    ...happyRoutes(),
    "GET /rest/v1/team_session/100/details/?drill=0": answer(200, DRILL),
    "GET /rest/v1/team_session/101/details/": answer(200, DRILL),
  });
  const r = await run(listed.fetchImpl);
  assert.equal(r.capabilities.session_read.drillsListPresent, true);
  assert.deepEqual(r.capabilities.session_drill_details, { verdict: "not_observed", reason: "drill_read_only_in_drill_mode" });
  assert.ok(!listed.calls.some((c) => c.url.includes("drill=") || c.url.includes("/101/") || c.url.includes("/api/team_session")));
  // The legacy reads are refused to the full run by construction (no full-mode caller exists, and
  // the closure refuses outside the drill-only run): the source has exactly two legacy call sites.
  assert.equal(LEGACY_API_PREFIX, "api/");
  for (const ok of ["team_session/1/", "team_session/0/details/?drill=0", "team_session/0/details/?drill=1", "team_session/123456789012/"]) assert.ok(LEGACY_API_PATH.test(ok), ok);
  for (const bad of ["team_session/01/", "team_session/1/details/?drill=2", "team_session/1/details/?drill=01", "team_session/1/details/?drill=10", "team_session/1/details/", "team_session/?team=980", "team_session/1/details/?drill=0&x=1", "athlete_session/1/", "team_session/1234567890123/", "../team_session/1/", "team_session/1"]) assert.ok(!LEGACY_API_PATH.test(bad), bad);
});

test("7. the date window: proven only when every row is team 980, inside the window, the chosen session among them and the filtered count smaller than the unfiltered count of the same run; a single-day list is not judged", async () => {
  const sameCount = fakeServer(happyRoutes({
    [`GET /rest/v1/team_session/?team=980&start_timestamp_gte=${encodeURIComponent(`${DAY} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${DAY} 23:59:59`)}&limit=100`]:
      answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, []), sess(200, 980, OTHER_DAY, [])], { "x-total-count": "4" }),
  }));
  const a = (await run(sameCount.fetchImpl)).capabilities.session_list_by_date;
  assert.equal(a.verdict, "not_observed");
  assert.equal(a.allRowsInsideWindow, false);
  assert.equal(a.filteredCountSmallerThanUnfiltered, false);
  // A missing count header is "no total", never 0.
  assert.equal(parseTotal(null), null);
  assert.equal(parseTotal(""), null);
  assert.equal(parseTotal("0"), 0);
  assert.equal(parseTotal("many"), null);
  const noTotal = fakeServer(happyRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, []), sess(200, 980, OTHER_DAY, [])]) }));
  const n1 = await run(noTotal.fetchImpl);
  assert.equal(n1.capabilities.session_list.totalIsNumber, false);
  assert.deepEqual(n1.capabilities.session_list_by_date, { verdict: "not_observed", reason: "no_unfiltered_total" });
  assert.ok(!noTotal.calls.some((c) => c.url.includes("start_timestamp_gte")));
  const noFilteredTotal = fakeServer(happyRoutes({
    [`GET /rest/v1/team_session/?team=980&start_timestamp_gte=${encodeURIComponent(`${DAY} 00:00:00`)}&start_timestamp_lte=${encodeURIComponent(`${DAY} 23:59:59`)}&limit=100`]:
      answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, [])]),
  }));
  const n2 = (await run(noFilteredTotal.fetchImpl)).capabilities.session_list_by_date;
  assert.equal(n2.verdict, "not_observed");
  assert.equal(n2.filteredTotalIsNumber, false);
  assert.equal(n2.filteredCountSmallerThanUnfiltered, false);
  const oneDay = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, [])], { "x-total-count": "3" }),
  }));
  const b = await run(oneDay.fetchImpl);
  assert.deepEqual(b.capabilities.session_list_by_date, { verdict: "not_observed", reason: "list_has_one_day" });
  assert.ok(!oneDay.calls.some((c) => c.url.includes("start_timestamp_gte")), "no filtered request on a one-day list");
});

test("8. limits: the request cap stops the run, a hanging read ends as a timeout, an oversized answer is refused unread, a redirect is never followed, a refused exchange sends nothing more", async () => {
  const capped = fakeServer();
  const a = await run(capped.fetchImpl, { maxRequests: 3 });
  assert.equal(a.stoppedBy, "request_limit");
  assert.equal(capped.calls.length, 3, "the fourth request was never sent");
  assert.equal(MAX_REQUESTS, 14);
  for (const bad of [{ maxRequests: 0 }, { maxRequests: 15 }, { timeoutMs: 0 }, { timeoutMs: 30_001 }]) await assert.rejects(run(capped.fetchImpl, bad), DiscoveryUsageError);

  const hanging = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/100/details/": (init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }),
  }));
  const b = await run(hanging.fetchImpl, { timeoutMs: 50 });
  assert.equal(b.requests.find((r) => r.path === "rest/v1/team_session/<id>/details/").error, "timeout");
  assert.equal(b.capabilities.session_details.verdict, "not_observed");
  assert.equal(b.capabilities.session_drill_details.reason, "drill_read_only_in_drill_mode");
  assert.equal(b.stoppedBy, null, "independent reads still run after a timeout");

  const MiB = 1024 * 1024;
  const huge = fakeServer(happyRoutes({
    "GET /rest/v1/team_session/?team=980&limit=100": { status: 200, headers: new Headers({ ...json, "x-total-count": "1" }), body: streamOf(Array.from({ length: 8 }, () => new Uint8Array(MiB).fill(0x20))), json: async () => { throw new Error("no"); } },
  }));
  const c = await run(huge.fetchImpl);
  assert.equal(c.stoppedBy, "session_list_unavailable");
  assert.equal(c.requests[1].error, "answer_too_large_or_unreadable");
  assert.equal(huge.calls.length, 2);

  const redirect = fakeServer(happyRoutes({ "GET /rest/v1/track/900/": answer(302, "", { location: "https://evil.example/" }) }));
  const d = await run(redirect.fetchImpl);
  assert.equal(d.capabilities.track_read.verdict, "not_observed");
  // A header that is not a count is not printed as one.
  const oddCount = fakeServer(happyRoutes({ "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [{ id: 500, teamsession: 100 }], { "x-total-count": "many MARKER" }) }));
  const h = await run(oddCount.fetchImpl);
  assert.equal(h.requests.find((r) => r.path.startsWith("rest/v1/athlete_session/?")).totalCount, "<unprintable>");
  assert.ok(!JSON.stringify(h).includes("MARKER"));
  assert.ok(!redirect.calls.some((x) => x.url.includes("evil")));
  assert.ok(!JSON.stringify(d).includes("evil.example"));

  // The exchange answer is bounded and timed like every read.
  assert.equal(MAX_EXCHANGE_BYTES, 64 * 1024);
  const bigExchange = fakeServer(happyRoutes({ "POST /api-token-auth/": { status: 200, headers: new Headers(json), body: streamOf(Array.from({ length: 8 }, () => new Uint8Array(MiB).fill(0x20))), json: async () => { throw new Error("no"); } } }));
  const x = await run(bigExchange.fetchImpl);
  assert.equal(x.stoppedBy, "exchange_failed");
  assert.equal(x.requests[0].error, "answer_too_large_or_unreadable");
  assert.equal(bigExchange.calls.length, 1);
  const slowExchange = fakeServer(happyRoutes({ "POST /api-token-auth/": (init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) }));
  const y = await run(slowExchange.fetchImpl, { timeoutMs: 50 });
  assert.equal(y.stoppedBy, "exchange_failed");
  assert.equal(y.requests[0].error, "timeout");
  const refused = fakeServer(happyRoutes({ "POST /api-token-auth/": answer(400, { non_field_errors: ["Unable to log in."] }) }));
  const e = await run(refused.fetchImpl);
  assert.equal(e.stoppedBy, "exchange_failed");
  assert.equal(refused.calls.length, 1);
  assert.deepEqual(e.capabilities, {});
  assert.ok(!JSON.stringify(e).includes("Unable to log in"));
});

test("9. the target cannot be changed: only server3 and Team ID 980 are accepted, and the credentials come from the environment only", async () => {
  assert.deepEqual(parseArgs([]), { host: PROBE_HOST, team: PROBE_TEAM, mode: "full" });
  assert.deepEqual(parseArgs(["--host", "server3", "--team", "980", "--mode", "drill"]), { host: "server3", team: "980", mode: "drill" });
  assert.deepEqual(parseArgs(["--mode", "identity"]), { host: PROBE_HOST, team: PROBE_TEAM, mode: "identity" });
  assert.deepEqual([...PROBE_MODES], ["full", "drill", "identity", "athlete-list"]);
  assert.deepEqual(parseArgs(["--mode", "athlete-list"]), { host: PROBE_HOST, team: PROBE_TEAM, mode: "athlete-list" });
  for (const bad of [["--mode", "drills"], ["--mode", ""], ["--mode", "FULL"], ["--mode", "IDENTITY"], ["--mode", "names"]]) assert.throws(() => parseArgs(bad), DiscoveryUsageError, bad.join(" "));
  await assert.rejects(runCapabilityProbe({ mode: "all" }, ENV, fakeServer().fetchImpl), DiscoveryUsageError);
  for (const bad of [["--host", "e03"], ["--team", "981"], ["--host", "https://server3.gpexe.com/"], ["--team", "980", "--extra", "x"]]) assert.throws(() => parseArgs(bad), DiscoveryUsageError, bad.join(" "));
  const { calls, fetchImpl } = fakeServer();
  await assert.rejects(runCapabilityProbe({}, {}, fetchImpl), DiscoveryUsageError);
  await assert.rejects(runCapabilityProbe({}, { GPEXE_USERNAME: USER }, fetchImpl), DiscoveryUsageError);
  await assert.rejects(runCapabilityProbe({ host: "e03" }, ENV, fetchImpl), DiscoveryUsageError, "e03 has no confirmed exchange");
  assert.equal(calls.length, 0);
  assert.equal(safeId("980"), "980");
  for (const bad of ["0980", "", null, {}, ["980"], 1.5, -1, "980 ", "https://x/980/"]) assert.equal(safeId(bad), null, JSON.stringify(bad));
  assert.equal(dayOf("2026-09-14T10:00:00"), "2026-09-14");
  assert.equal(dayOf("yesterday"), null);
});

test("10. the issued token can never be printed, even when the source echoes it as a field name or in a printed header", async () => {
  // Echoed as a field name: the key is not an identifier, so no field name of that answer is printed.
  for (const secret of [ISSUED, USER]) {
    const echo = fakeServer(happyRoutes({ "GET /rest/v1/track/900/": answer(200, { id: 900, [secret]: 1 }) }));
    const r = await run(echo.fetchImpl);
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.equal(r.requests.find((x) => x.path === "rest/v1/track/<id>/").fieldNames, "<unprintable>");
  }
  // Echoed in a header the report prints: the final guard refuses to print the report at all.
  for (const secret of [ISSUED, USER]) {
    const echo = fakeServer(happyRoutes({ "GET /rest/v1/track/900/": answer(200, { id: 900 }, { "x-gpexe-version": secret }) }));
    await assert.rejects(run(echo.fetchImpl), (e) => e.code === "secret_in_report");
  }
});

test("11. the probe changes nothing else: the adapter, the discovery script and the routes are untouched by it, and the probe's source builds requests for the documented paths only", async () => {
  const source = (await fsp.readFile(path.resolve(ROOT, "backend/scripts/gpexe-rest-v1-capability-probe.mjs"), "utf8")).split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.deepEqual([...new Set([...source.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]))].sort(), ["GET", "POST"]);
  assert.equal((source.match(/fetchImpl\(/g) || []).length, 2, "two places talk to the network: the exchange and the one GET closure");
  assert.equal((source.match(/method:\s*"POST",\s*redirect/g) || []).length, 1, "the one POST sent is the exchange");
  assert.doesNotMatch(source, /https?:\/\//, "no URL in the probe");
  assert.doesNotMatch(source, /\.text\(\)|\.json\(\)|\.arrayBuffer\(\)/, "no whole-body read");
  assert.doesNotMatch(source, /drill=[1-9]/, "no invented drill position");
  // The legacy family is reached only through the guarded closure, at exactly two call sites, both
  // on the confirmed parent; no `drills` entry is ever put into a path.
  assert.equal((source.match(/getLegacy\(`/g) || []).length, 2, "two legacy call sites: the parent and the drill reads");
  assert.match(source, /getLegacy\(`team_session\/\$\{parentId\}\/`\)/);
  assert.match(source, /getLegacy\(`team_session\/\$\{parentId\}\/details\/\?drill=\$\{position\}`\)/);
  assert.match(source, /for \(const position of DRILL_READ_SEQUENCE\)/);
  assert.match(source, /DRILL_POSITIONS = Object\.freeze\(\[0, 1\]\)/);
  assert.match(source, /DRILL_READ_SEQUENCE = Object\.freeze\(\[0, 1, 0\]\)/);
  assert.doesNotMatch(source, /getLegacy\(`[^`]*details\/`\)/, "no legacy details read without a drill position");
  assert.equal((source.match(/read\(LEGACY_API_PREFIX,/g) || []).length, 1, "the legacy prefix is used in one place");
  assert.doesNotMatch(source, /\$\{[^}]*\bdrills?\b[^}]*\}|\$\{(drillIds|drillId|firstDrill)[^}]*\}/, "no drills entry in any path");
  assert.match(source, /if \(mode !== "drill" \|\| !LEGACY_API_PATH\.test\(resourcePath\)\) throw new ProbeStop\("path_refused"/, "the legacy closure refuses outside the drill-only run");
  // Every template path names only confirmed ids, the team, a day or a window.
  for (const m of source.matchAll(/(?:get|getLegacy)\(`([^`]*)`\)/g)) {
    for (const v of m[1].matchAll(/\$\{([^}]*)\}/g)) assert.ok(["parentId", "sessionId", "athleteId", "trackId", "team", "day", "window", "LIST_LIMIT", "position", "gpexeAthleteId"].includes(v[1].trim()), `${m[1]}: ${v[1]}`);
  }
  assert.doesNotMatch(source, /get\(`[^`]*\?drill=/, "no REST drill read");
  for (const f of await fsp.readdir(path.resolve(ROOT, "backend/src/routes"))) {
    assert.doesNotMatch(await fsp.readFile(path.resolve(ROOT, "backend/src/routes", f), "utf8"), /capability-probe|runCapabilityProbe/, f);
  }
  assert.doesNotMatch(await fsp.readFile(path.resolve(ROOT, "backend/src/gpexeRestV1Adapter.js"), "utf8"), /capability-probe/);
});

// ---------------------------------------------------------------------------
// The drill-only run (owner, 2026-10-01): the full run saw a parent whose own
// read has drills_count > 0 but no drills list; the first drill-only run saw
// that a `drills` entry is not a team_session id. The corrected run reads the
// importer's drill form by position on the confirmed parent, nothing by id.
// ---------------------------------------------------------------------------
// A server3 as the runs saw it: the list carries `drills`, the parent's own REST read does not,
// and a `drills` entry is not a team_session id. The legacy family answers the same parent and the
// drill by its zero-based position (the structure of the owner's legacy integration).
// The importer's known `api` details shape: `players` keyed by the GPEXE athlete id (gpexeImportMapper.js).
// As the owner-run answers showed on server3: top-level `drills_count`, `players`, `team` and
// `teamsession`; `team` an opaque object without an id; `teamsession` a canonical id that is not
// the parent's. The fake's parent 100 has drills [101, 102], both rows of the list page, team 980.
const PLAYERS_0 = { 4711: { athlete_name: MARKERS.athleteName, tot_burst_events: 4, total_distance: 1200.25, zones: { z1: 3 } } };
const PLAYERS_1 = { 4711: { athlete_name: MARKERS.athleteName, tot_burst_events: 2, total_distance: 640.5, zones: { z1: 1 } } };
const PLAYERS_0_CHANGED = { 4711: { athlete_name: MARKERS.athleteName, tot_burst_events: 5, total_distance: 1333.75, zones: { z1: 3 } } };
const OPAQUE_TEAM = { zzzOpaqueKey: "https://evil.example/team/424242/", label: MARKERS.tagName };
const legacyDrill = (players, extra = {}) => ({ drills_count: 2, players, team: OPAQUE_TEAM, teamsession: 101, ...extra });
// A route that answers the first read of position 0 with `first` and its repeat with `repeat`.
const zeroThen = (first, repeat) => { let n = 0; return () => (n++ === 0 ? first : repeat); };
function drillRoutes(over = {}) {
  return {
    ...happyRoutes(),
    "GET /rest/v1/team_session/100/": answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: `${DAY}T10:00:00` }),
    "GET /rest/v1/team_session/101/": answer(200, { id: 777, team: 980, drill: null, drills_count: 0 }),
    "GET /rest/v1/team_session/100/details/?drill=0": answer(200, legacyDrill(PLAYERS_0)),
    "GET /api/team_session/100/": answer(200, { id: 100, team: 980, drills_count: 2, name: MARKERS.sessionName }),
    "GET /api/team_session/101/": answer(200, { id: 101, team: 980 }),
    "GET /api/team_session/100/details/": answer(200, legacyDrill(PLAYERS_0)),
    "GET /api/team_session/100/details/?drill=0": answer(200, legacyDrill(PLAYERS_0, { teamsession: 101 })),
    "GET /api/team_session/100/details/?drill=1": answer(200, legacyDrill(PLAYERS_1, { teamsession: 102 })),
    ...over,
  };
}
const drillRun = (fetchImpl, over = {}) => runCapabilityProbe({ mode: "drill", ...over }, ENV, fetchImpl);
const paths = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);
const D0 = "GET /api/team_session/100/details/?drill=0";
const D1 = "GET /api/team_session/100/details/?drill=1";
const LIST = "GET /rest/v1/team_session/?team=980&limit=100";
const listOf = (rowsOver) => ({ [LIST]: answer(200, rowsOver, { "x-total-count": String(rowsOver.length) }) });
const LINK_KEYS = ["teamsessionCanonical", "teamsessionIsAnyParentDrillEntry", "teamsessionParentDrillMatchCount", "teamsessionMatchedDrillIndex", "teamsessionHasUniqueListRow", "teamsessionListRowTeamIs980", "diagnosticLinkConfirmed"];
const linkOf = (entry) => Object.fromEntries(LINK_KEYS.map((k) => [k, entry[k]]));
const noLeak = (report, extra = []) => {
  const text = JSON.stringify({ ...report, ranAt: "" }).replace(/"teamId":"980"/, "").replace(/"(status|rowCount|distinctDays|readsMade|teamsessionParentDrillMatchCount|teamsessionMatchedDrillIndex|drill0|drill1|drill0Repeat)":\d+/g, "");
  for (const m of [...Object.values(MARKERS).map(String), ISSUED, USER, PASSWORD, DAY, "09-14", "777", "1200.25", "640.5", "1333.75", "total_distance", "tot_burst_events", "4711", "z1", "zzzOpaqueKey", "evil.example", "424242", ...extra]) assert.ok(!text.includes(m), m);
  for (const id of ["100", "101", "102", "150", "980"]) assert.ok(!new RegExp(`"[^"]*\\b${id}\\b`).test(text), `no id ${id} as a value`);
};

test("12. the drill-only run: one exchange and exactly six reads in the control sequence 0, 1, 0; a drill answer's opaque team is never evidence; the probe goes on only under the diagnostic link; the sequence ends as observed with indexes and booleans only", async () => {
  const { calls, fetchImpl } = fakeServer(drillRoutes());
  const report = await drillRun(fetchImpl);
  assert.equal(report.mode, "drill");
  assert.equal(report.stoppedBy, null);
  assert.equal(report.requestCount, 7);
  assert.equal(DRILL_MODE_MAX_REQUESTS, 7);
  assert.deepEqual([...DRILL_READ_SEQUENCE], [0, 1, 0]);
  assert.deepEqual(paths(calls), [
    "POST /api-token-auth/",
    LIST,
    "GET /rest/v1/team_session/100/",
    "GET /api/team_session/100/",
    D0,
    D1,
    D0,
  ]);
  const base = new URL(calls[0].url).origin;
  assert.ok(calls.every((c) => new URL(c.url).origin === base), "one host");
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.headers.Authorization === `Token ${ISSUED}` && c.redirect === "manual"));
  assert.ok(!calls.some((c) => /\/101\/|\/102\/|rest\/v1\/team_session\/100\/details|api\/team_session\/100\/details\/$|athlete_session|track|thresholds|team_session_tag|start_timestamp_gte/.test(c.url)),
    "no drills entry as an id, no REST drill read, no legacy details read without a position, nothing of the full run");
  assert.deepEqual(verdicts(report), { session_list: "proven", session_read: "same", legacy_api_session_read: "observed", session_drill_details: "observed" });
  const d = report.capabilities.session_drill_details;
  // Observed, never same: the identity contract is decided after this result, not by it.
  assert.equal(d.verdict, "observed");
  assert.equal(d.diagnosticLinkConfirmed, true);
  assert.equal(d.repeatStable, true);
  assert.equal(d.parameterApplied, true);
  assert.deepEqual(d.drillIndexes, { drill0: 0, drill1: 1, drill0Repeat: 0 });
  assert.equal(d.reason, undefined);
  // Per answer: the opaque team described but not accepted, the link confirmed, the shape booleans.
  for (const [label, index] of [["drill0", 0], ["drill1", 1], ["drill0Repeat", 0]]) {
    const e = d[label];
    assert.deepEqual([e.status, e.teamIs980, e.namesParent, e.playersPresent, e.teamValueKind, e.teamObjectHasId], [200, false, false, true, "object", false], label);
    assert.deepEqual(linkOf(e), { teamsessionCanonical: true, teamsessionIsAnyParentDrillEntry: true, teamsessionParentDrillMatchCount: 1, teamsessionMatchedDrillIndex: index, teamsessionHasUniqueListRow: true, teamsessionListRowTeamIs980: true, diagnosticLinkConfirmed: true }, label);
    assert.deepEqual([e.playersContainerKind, e.playerRowsPresent, e.playerRowsHaveNumbers], ["map", true, true], label);
  }
  assert.deepEqual(report.requests.map((r) => r.path), ["api-token-auth/", "rest/v1/team_session/?team=<team>&limit=<n>", "rest/v1/team_session/<id>/", "api/team_session/<id>/", "api/team_session/<id>/details/?drill=0", "api/team_session/<id>/details/?drill=1", "api/team_session/<id>/details/?drill=0"]);
  for (const i of [4, 5, 6]) assert.deepEqual(report.requests[i].fieldNames, ["drills_count", "players", "team", "teamsession"]);
  const list = report.capabilities.session_list;
  assert.deepEqual([list.drillsEntryKind, list.listRowMatchesFirstDrill, list.rowsHaveSingularDrillField, list.rowsWithNonNullSingularDrill], ["number", true, false, null]);
  noLeak(report);

  // Reversed order: position 0 maps to drills[1], position 1 to drills[0]; still observed, indexes 1, 0, 1.
  const reversed = await drillRun(fakeServer(drillRoutes({ [D0]: answer(200, legacyDrill(PLAYERS_0, { teamsession: 102 })), [D1]: answer(200, legacyDrill(PLAYERS_1, { teamsession: 101 })) })).fetchImpl);
  assert.equal(reversed.stoppedBy, null);
  assert.deepEqual([reversed.capabilities.session_drill_details.verdict, reversed.capabilities.session_drill_details.drillIndexes], ["observed", { drill0: 1, drill1: 0, drill0Repeat: 1 }]);
  // Both positions map to the same index: the sequence completes, the indexes say so, parameterApplied is what players say.
  const sameIdx = await drillRun(fakeServer(drillRoutes({ [D1]: answer(200, legacyDrill(PLAYERS_1, { teamsession: 101 })) })).fetchImpl);
  assert.equal(sameIdx.stoppedBy, null);
  assert.deepEqual([sameIdx.capabilities.session_drill_details.verdict, sameIdx.capabilities.session_drill_details.drillIndexes, sameIdx.capabilities.session_drill_details.parameterApplied], ["observed", { drill0: 0, drill1: 0, drill0Repeat: 0 }, true]);
  // All three players identical: observed, parameterApplied false (the identity contract is not decided here).
  const flat = await drillRun(fakeServer(drillRoutes({ [D1]: answer(200, legacyDrill(PLAYERS_0, { teamsession: 102 })) })).fetchImpl);
  assert.deepEqual([flat.capabilities.session_drill_details.verdict, flat.capabilities.session_drill_details.repeatStable, flat.capabilities.session_drill_details.parameterApplied], ["observed", true, false]);
  // The repeated position 0 with changed players: source changed during the probe.
  const changed = await drillRun(fakeServer(drillRoutes({ [D0]: zeroThen(answer(200, legacyDrill(PLAYERS_0, { teamsession: 101 })), answer(200, legacyDrill(PLAYERS_0_CHANGED, { teamsession: 101 }))) })).fetchImpl);
  assert.deepEqual([changed.stoppedBy, changed.capabilities.session_drill_details.verdict, changed.capabilities.session_drill_details.reason, changed.capabilities.session_drill_details.repeatStable, changed.capabilities.session_drill_details.parameterApplied], [null, "not_observed", "source_changed_during_probe", false, null]);
  // The repeated position 0 that maps to another index: stopped after the third read, nothing compared.
  const moved = fakeServer(drillRoutes({ [D0]: zeroThen(answer(200, legacyDrill(PLAYERS_0, { teamsession: 101 })), answer(200, legacyDrill(PLAYERS_0, { teamsession: 102 }))) }));
  const mv = await drillRun(moved.fetchImpl);
  assert.deepEqual([mv.stoppedBy, mv.capabilities.session_drill_details.reason, mv.capabilities.session_drill_details.readsMade, moved.calls.length], ["drill_repeat_index_changed", "drill_repeat_index_changed", 3, 7]);
  assert.equal(mv.capabilities.session_drill_details.repeatStable, undefined);
  // A reordered map is the same players.
  const ordered = { a: { x: 1, y: 2 }, b: { x: 1, y: 2 } };
  const reordered = { b: { y: 2, x: 1 }, a: { y: 2, x: 1 } };
  const ro = await drillRun(fakeServer(drillRoutes({ [D0]: zeroThen(answer(200, legacyDrill(ordered, { teamsession: 101 })), answer(200, legacyDrill(reordered, { teamsession: 101 }))) })).fetchImpl);
  assert.equal(ro.capabilities.session_drill_details.repeatStable, true);
  for (const r of [reversed, sameIdx, flat, changed, mv, ro]) {
    assert.ok(!["same", "mapped", "missing"].includes(r.capabilities.session_drill_details.verdict));
    noLeak(r);
  }
});

test("13. the diagnostic link gates every next drill read: a teamsession that is not canonical, not exactly one parent drill entry, not exactly one row of the list page, a row not of team 980, or an answer without players stops the run without the next request; a canonical foreign team is an isolation stop; the opaque team is described, never accepted", async () => {
  const link = (teamsession, extra = {}) => legacyDrill(PLAYERS_0, { teamsession, ...extra });
  const probeOf = (over) => fakeServer(drillRoutes(over));
  // [label, routes, stop, requests sent, expected link of the stopping answer]
  const cases = [
    ["teamsession is the parent (not a drill entry)", { [D0]: answer(200, link(100)) }, "drill_link_not_confirmed", 5, { c: true, any: false, n: 0, i: null, u: true, t: true }],
    ["teamsession is no parent drill entry", { [D0]: answer(200, link(200)) }, "drill_link_not_confirmed", 5, { c: true, any: false, n: 0, i: null, u: true, t: true }],
    ["teamsession not canonical (URL)", { [D0]: answer(200, link("https://evil.example/team_session/101/")) }, "drill_link_not_confirmed", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["teamsession absent", { [D0]: answer(200, { drills_count: 2, players: PLAYERS_0, team: OPAQUE_TEAM }) }, "drill_link_not_confirmed", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["teamsession an object", { [D0]: answer(200, link({ id: 101 })) }, "drill_link_not_confirmed", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["duplicate entry in the parent's drills", { ...listOf([sess(100, 980, DAY, [101, 101]), sess(101, 980, DAY, []), sess(200, 980, OTHER_DAY, [])]) }, "drill_link_not_confirmed", 5, { c: true, any: true, n: 2, i: null, u: true, t: true }],
    ["no list row for the entry", { ...listOf([sess(100, 980, DAY, [101, 102]), sess(200, 980, OTHER_DAY, [])]) }, "drill_link_not_confirmed", 5, { c: true, any: true, n: 1, i: 0, u: false, t: false }],
    ["two list rows for the entry", { ...listOf([sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(101, 980, DAY, []), sess(102, 980, DAY, [])]) }, "drill_link_not_confirmed", 5, { c: true, any: true, n: 1, i: 0, u: false, t: false }],
    ["list row without a readable team", { ...listOf([sess(100, 980, DAY, [101, 102]), { id: 101, drills: [] }, sess(102, 980, DAY, [])]) }, "drill_link_not_confirmed", 5, { c: true, any: true, n: 1, i: 0, u: true, t: false }],
    ["no players", { [D0]: answer(200, { drills_count: 2, team: OPAQUE_TEAM, teamsession: 101 }) }, "drill_players_missing", 5, { c: true, any: true, n: 1, i: 0, u: true, t: true }],
    ["empty players", { [D0]: answer(200, link(101, { players: {} })) }, "drill_players_missing", 5, { c: true, any: true, n: 1, i: 0, u: true, t: true }],
    ["canonical foreign team", { [D0]: answer(200, link(101, { team: 981 })) }, "team_isolation_failed", 5, { c: true, any: true, n: 1, i: 0, u: true, t: true, ok: true }],
    ["not 200", { [D0]: answer(404, { detail: "Not found." }) }, "drill_not_200", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["unreadable", { [D0]: answer(200, "<html>interstitial</html>") }, "drill_answer_unreadable", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["empty object", { [D0]: answer(200, {}) }, "drill_answer_empty", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    ["list-shaped answer", { [D0]: answer(200, [link(101)]) }, "drill_answer_identity_unconfirmed", 5, { c: false, any: false, n: 0, i: null, u: false, t: false }],
    // Position 1 and the repeated position 0 are held to the same link.
    ["position 1 names no drill entry", { [D1]: answer(200, link(200)) }, "drill_link_not_confirmed", 6, { c: true, any: false, n: 0, i: null, u: true, t: true }],
    ["position 1 foreign team", { [D1]: answer(200, link(102, { team: 981 })) }, "team_isolation_failed", 6, { c: true, any: true, n: 1, i: 1, u: true, t: true, ok: true }],
    ["repeat names the parent", { [D0]: zeroThen(answer(200, link(101)), answer(200, link(100))) }, "drill_link_not_confirmed", 7, { c: true, any: false, n: 0, i: null, u: true, t: true }],
    ["repeat without players", { [D0]: zeroThen(answer(200, link(101)), answer(200, { drills_count: 2, team: OPAQUE_TEAM, teamsession: 101 })) }, "drill_players_missing", 7, { c: true, any: true, n: 1, i: 0, u: true, t: true }],
    ["repeat foreign team", { [D0]: zeroThen(answer(200, link(101)), answer(200, link(101, { team: 981 }))) }, "team_isolation_failed", 7, { c: true, any: true, n: 1, i: 0, u: true, t: true, ok: true }],
  ];
  for (const [label, over, stop, n, L] of cases) {
    const f = probeOf(over);
    const r = await drillRun(f.fetchImpl);
    const d = r.capabilities.session_drill_details;
    assert.equal(r.stoppedBy, stop, label);
    assert.equal(d.verdict, "not_observed", label);
    assert.equal(d.reason, stop, label);
    assert.equal(f.calls.length, n, `${label}: no request after the failed step`);
    assert.equal(d.readsMade, n - 4, label);
    if (n === 5) assert.ok(!f.calls.some((c) => c.url.includes("drill=1")), `${label}: no second drill read`);
    if (n < 7) assert.equal(f.calls.filter((c) => c.url.includes("drill=0")).length, 1, `${label}: no repeated position 0`);
    const entry = d[["drill0", "drill1", "drill0Repeat"][n - 5]];
    assert.deepEqual(linkOf(entry), { teamsessionCanonical: L.c, teamsessionIsAnyParentDrillEntry: L.any, teamsessionParentDrillMatchCount: L.n, teamsessionMatchedDrillIndex: L.i, teamsessionHasUniqueListRow: L.u, teamsessionListRowTeamIs980: L.t, diagnosticLinkConfirmed: Boolean(L.ok) }, label);
    // A confirmed link never outranks a foreign team: the isolation stop comes first.
    if (L.ok) assert.equal(stop, "team_isolation_failed", label);
    assert.equal(d.repeatStable, undefined, label);
    assert.ok(!["same", "mapped", "missing"].includes(d.verdict));
    noLeak(r, ["981"]);
  }
  // A foreign team in a list row stops the run at the list, as before.
  const foreign = probeOf(listOf([sess(100, 980, DAY, [101, 102]), sess(300, 981, DAY, [])]));
  const fr = await drillRun(foreign.fetchImpl);
  assert.deepEqual([fr.stoppedBy, foreign.calls.length], ["team_isolation_failed", 2]);
  // The function on its own.
  const rows = [{ id: 1, team: 980, drills: [2, 3, 2] }, { id: 2, team: 980 }, { id: 3, team: 981 }];
  assert.deepEqual(describeDrillLink({ teamsession: 2 }, rows[0], rows, "980"), { teamsessionCanonical: true, teamsessionIsAnyParentDrillEntry: true, teamsessionParentDrillMatchCount: 2, teamsessionMatchedDrillIndex: null, teamsessionHasUniqueListRow: true, teamsessionListRowTeamIs980: true });
  assert.deepEqual(describeDrillLink({ teamsession: "3" }, rows[0], rows, "980"), { teamsessionCanonical: true, teamsessionIsAnyParentDrillEntry: true, teamsessionParentDrillMatchCount: 1, teamsessionMatchedDrillIndex: 1, teamsessionHasUniqueListRow: true, teamsessionListRowTeamIs980: false });
  assert.deepEqual(describeDrillLink({ teamsession: 2 }, { id: 1, team: 980 }, rows, "980"), { teamsessionCanonical: true, teamsessionIsAnyParentDrillEntry: false, teamsessionParentDrillMatchCount: 0, teamsessionMatchedDrillIndex: null, teamsessionHasUniqueListRow: true, teamsessionListRowTeamIs980: true });
  assert.deepEqual(describeDrillLink([{ teamsession: 2 }], rows[0], rows, "980"), { teamsessionCanonical: false, teamsessionIsAnyParentDrillEntry: false, teamsessionParentDrillMatchCount: 0, teamsessionMatchedDrillIndex: null, teamsessionHasUniqueListRow: false, teamsessionListRowTeamIs980: false });
  const ok = describeDrillLink({ teamsession: 2 }, rows[0].drills ? { ...rows[0], drills: [2, 3] } : rows[0], rows, "980");
  assert.equal(diagnosticLinkConfirmed(ok, true), true);
  assert.equal(diagnosticLinkConfirmed(ok, false), false);
  assert.equal(diagnosticLinkConfirmed({ ...ok, teamsessionListRowTeamIs980: false }, true), false);
  assert.equal(diagnosticLinkConfirmed({ ...ok, teamsessionParentDrillMatchCount: 2, teamsessionMatchedDrillIndex: null }, true), false);
});

test("13b. the shape of a drill answer's top-level `team` is described as a kind word and booleans only; a canonical foreign team stops the run; every other shape is described and never accepted as the team; no value, key, URL, name or id of that field is printed", async () => {
  assert.deepEqual([...TEAM_VALUE_KINDS], ["absent", "null", "number", "string", "object", "array", "other"]);
  const MARK_ID = 424242;
  const MARK_URL = "https://evil.example/team/424242/";
  const body = (team) => legacyDrill(PLAYERS_0, { team, teamsession: 101 });
  const absent = { players: PLAYERS_0, teamsession: 101, drills_count: 2 };
  const cases = [
    ["absent", absent, null, { teamValueKind: "absent" }],
    ["null", body(null), null, { teamValueKind: "null" }],
    ["number", body(980), null, { teamValueKind: "number" }],
    ["string", body("980"), null, { teamValueKind: "string" }],
    ["object with the bound id", body({ id: 980, zzzOpaqueKey: MARK_URL }), null, { teamValueKind: "object", teamObjectHasId: true, teamObjectIdCanonical: true, teamObjectIdMatchesBoundTeam: true }],
    ["object without id", body({ zzzOpaqueKey: MARK_URL }), null, { teamValueKind: "object", teamObjectHasId: false, teamObjectIdCanonical: false, teamObjectIdMatchesBoundTeam: null }],
    ["object with a non-canonical id", body({ id: MARK_URL }), null, { teamValueKind: "object", teamObjectHasId: true, teamObjectIdCanonical: false, teamObjectIdMatchesBoundTeam: null }],
    ["object with another canonical id", body({ id: MARK_ID }), null, { teamValueKind: "object", teamObjectHasId: true, teamObjectIdCanonical: true, teamObjectIdMatchesBoundTeam: false }],
    ["array", body([980]), null, { teamValueKind: "array" }],
    ["URL string", body(MARK_URL), null, { teamValueKind: "string" }],
    ["boolean", body(true), null, { teamValueKind: "other" }],
    ["another canonical team", body(MARK_ID), "team_isolation_failed", { teamValueKind: "number" }],
  ];
  for (const [label, first, stop, diag] of cases) {
    const f = fakeServer(drillRoutes({ [D0]: answer(200, first) }));
    const r = await drillRun(f.fetchImpl);
    const d = r.capabilities.session_drill_details;
    if (stop === null) {
      // Not evidence of the team, but no longer a stop in itself: the diagnostic link carries the run.
      assert.equal(r.stoppedBy, null, label);
      assert.equal(f.calls.length, 7, label);
      assert.equal(d.verdict, "observed", label);
    } else {
      assert.equal(r.stoppedBy, stop, label);
      assert.equal(f.calls.length, 5, `${label}: no request after the first drill read`);
      assert.equal(d.readsMade, 1, label);
    }
    assert.equal(d.drill0.teamIs980, ["number", "string"].includes(label), label);
    const picked = Object.fromEntries(Object.entries(d.drill0).filter(([k]) => k.startsWith("teamValue") || k.startsWith("teamObject")));
    assert.deepEqual(picked, diag, label);
    assert.ok(TEAM_VALUE_KINDS.includes(d.drill0.teamValueKind), label);
    noLeak(r, [String(MARK_ID), MARK_URL]);
  }
  assert.deepEqual(describeTeamValue(undefined, "980"), { teamValueKind: "absent" });
  assert.deepEqual(describeTeamValue([{ team: 980 }], "980"), { teamValueKind: "absent" });
  assert.deepEqual(describeTeamValue({ team: { id: "0980" } }, "980"), { teamValueKind: "object", teamObjectHasId: true, teamObjectIdCanonical: false, teamObjectIdMatchesBoundTeam: null });
  // The full run is not touched: its session reads carry no drill diagnostics.
  const full = await runCapabilityProbe({}, ENV, fakeServer().fetchImpl);
  for (const k of ["teamValueKind", "teamsessionMatchedDrillIndex", "diagnosticLinkConfirmed"]) assert.ok(!JSON.stringify(full).includes(k), k);
});

test("14. the drill-only run stops before any drill read at the first parent identity or team that is not confirmed - by REST or by the legacy family - every stop names the drill verdict, and the cap is seven", async () => {
  const noDrill = (calls) => !calls.some((c) => c.url.includes("drill="));
  const cases = [
    ["GET /rest/v1/team_session/100/", answer(200, { id: 150, team: 980, drills_count: 2 }), "parent_id_mismatch", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 981, drills_count: 2 }), "team_isolation_failed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: { id: 980 }, drills_count: 2 }), "team_unknown_shape", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 980 }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 980, drills_count: 1 }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(404, { detail: "Not found." }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, [{ id: 100, team: 980, drills_count: 2 }]), "parent_not_confirmed", 3],
    ["GET /api/team_session/100/", answer(200, { id: 150, team: 980 }), "legacy_parent_id_mismatch", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100, team: 981 }), "team_isolation_failed", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100, team: "https://server3.gpexe.com/api/team/980/" }), "team_unknown_shape", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100 }), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(404, { detail: "Not found." }), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(200, ""), "legacy_parent_not_confirmed", 4],
  ];
  for (const [route, resp, stop, n] of cases) {
    const f = fakeServer(drillRoutes({ [route]: resp }));
    const r = await drillRun(f.fetchImpl);
    assert.equal(r.stoppedBy, stop, `${route} ${stop}`);
    assert.equal(f.calls.length, n, `${route} ${stop}: no request after the failed step`);
    assert.ok(noDrill(f.calls), `${route} ${stop}: no drill read`);
    if (n === 3) assert.ok(!f.calls.some((c) => c.url.includes("/api/team_session")), "no legacy read after a REST stop");
    assert.deepEqual(r.capabilities.session_drill_details, { verdict: "not_observed", reason: stop });
    noLeak(r, ["981"]);
  }
  // No parent with two drills, only count-only rows, a one-drill parent first, a drill-like row first.
  const noParent = fakeServer(drillRoutes(listOf([sess(100, 980, DAY, [101]), sess(200, 980, OTHER_DAY, [])])));
  const c = await drillRun(noParent.fetchImpl);
  assert.deepEqual([c.stoppedBy, noParent.calls.length, c.capabilities.session_drill_details], ["no_parent_with_drills_in_list", 2, { verdict: "not_observed", reason: "no_parent_with_drills_in_list" }]);
  const countOnly = fakeServer(drillRoutes(listOf([{ id: 300, team: 980, drills_count: 0 }, { id: 100, team: 980, drills_count: 3 }, { id: 101, team: 980, drills_count: 2, drills: [] }])));
  const co = await drillRun(countOnly.fetchImpl);
  assert.deepEqual([co.stoppedBy, countOnly.calls.length], ["no_parent_with_drills_in_list", 2]);
  assert.ok(!countOnly.calls.some((x) => x.url.includes("/api/team_session")));
  const dLike = fakeServer(drillRoutes({ ...listOf([{ id: 101, team: 980, drills_count: 2, drill: 0 }, sess(100, 980, DAY, [101, 102]), sess(102, 980, DAY, [])]), "GET /rest/v1/team_session/101/": answer(200, { id: 101, team: 980, drills_count: 2 }) }));
  const dl = await drillRun(dLike.fetchImpl);
  assert.equal(dl.stoppedBy, null);
  assert.ok(!dLike.calls.some((x) => x.url.includes("/101/")), "the count-only row is never read");
  // Every stop before the drill branch names the drill verdict too.
  for (const [over, stop, n] of [
    [{ [LIST]: answer(500, "") }, "session_list_unavailable", 2],
    [{ "POST /api-token-auth/": answer(400, { non_field_errors: ["refused"] }) }, "exchange_failed", 1],
    [{ [LIST]: answer(200, [{ team: 980, drills: [] }], { "x-total-count": "1" }) }, "no_safe_session_id", 2],
  ]) {
    const fs = fakeServer(drillRoutes(over));
    const rr = await drillRun(fs.fetchImpl);
    assert.deepEqual([rr.stoppedBy, fs.calls.length, rr.capabilities.session_drill_details], [stop, n, { verdict: "not_observed", reason: stop }]);
  }
  const fullStop = fakeServer(happyRoutes({ [LIST]: answer(500, "") }));
  const fr = await runCapabilityProbe({}, ENV, fullStop.fetchImpl);
  assert.deepEqual([fr.stoppedBy, fr.capabilities.session_drill_details], ["session_list_unavailable", undefined]);
  // The cap: never more than seven requests, whatever maxRequests says; a smaller cap stops before the repeat.
  const capped = fakeServer(drillRoutes());
  const e = await drillRun(capped.fetchImpl, { maxRequests: 14 });
  assert.deepEqual([capped.calls.length, e.stoppedBy], [7, null]);
  for (const [cap, drill0Reads] of [[6, 1], [5, 1], [4, 0]]) {
    const t = fakeServer(drillRoutes());
    const g = await drillRun(t.fetchImpl, { maxRequests: cap });
    assert.deepEqual([g.stoppedBy, t.calls.length, t.calls.filter((x) => x.url.includes("drill=0")).length, g.capabilities.session_drill_details], ["request_limit", cap, drill0Reads, { verdict: "not_observed", reason: "request_limit" }], String(cap));
  }
});

// ---------------------------------------------------------------------------
// The identity run (owner order 2026-10-06): where do an athlete's name and date of birth appear in
// the bound team's answers? Every person below is a made-up marker; the report may carry key paths,
// kinds, counts and booleans, never one of these values, an id or a URL.
const PEOPLE = {
  given: "Markergiven", family: "Markerfamily", full: "Markergiven Markerfamily", dob: "1901-02-03",
  otherGiven: "Markerother", otherFamily: "Markersecond", otherFull: "Markerother Markersecond",
  email: "marker.person@example.invalid", teamName: "Marker Team Name",
};
const ROOT_INDEX = { team: `${R}team/`, team_session: `${R}team_session/`, athlete_session: `${R}athlete_session/`, track: `${R}track/`, athlete: `${R}athlete/` };
const ROOT_INDEX_ROUTE = { "GET /rest/v1/": answer(200, ROOT_INDEX), "GET /rest/v1/athlete/4711/": answer(200, { id: 4711 }) };
const IDENTITY_PATHS = [
  "POST /api-token-auth/",
  "GET /rest/v1/team/980/",
  "GET /rest/v1/",
  LIST,
  "GET /rest/v1/team_session/100/",
  "GET /rest/v1/athlete_session/?teamsession=100&limit=100",
  "GET /rest/v1/athlete_session/500/",
  "GET /rest/v1/track/900/",
  "GET /rest/v1/athlete/4711/",
];
const aRow = (id, athlete, extra = {}) => ({ id, teamsession: 100, track: 900 + (id - 500), athlete, drill: null, total_distance: 5000.5, ...extra });
function identityRoutes(over = {}) {
  return {
    "POST /api-token-auth/": happyRoutes()["POST /api-token-auth/"],
    "GET /rest/v1/team/980/": answer(200, {
      id: 980, name: PEOPLE.teamName,
      athletes: [
        { id: 4711, first_name: PEOPLE.given, last_name: PEOPLE.family, birthdate: PEOPLE.dob },
        { id: 4712, first_name: PEOPLE.otherGiven, last_name: PEOPLE.otherFamily, birthdate: null },
      ],
    }),
    "GET /rest/v1/": answer(200, ROOT_INDEX),
    [LIST]: answer(200, [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, [])], { "x-total-count": "3" }),
    "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DAY, [101, 102])),
    "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [aRow(500, 4711, { athlete_name: PEOPLE.full }), aRow(501, 4712, { athlete_name: PEOPLE.otherFull })], { "x-total-count": "2" }),
    "GET /rest/v1/athlete_session/500/": answer(200, aRow(500, 4711, { athlete_name: PEOPLE.full })),
    "GET /rest/v1/track/900/": answer(200, { id: 900, athlete: 4711, athlete_name: PEOPLE.full, timezone: MARKERS.tz }),
    "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: PEOPLE.given, last_name: PEOPLE.family, birthdate: PEOPLE.dob, email: PEOPLE.email, weight: 77.5, team: 980, teams: [980, 981] }),
    ...over,
  };
}
const identityRun = (fetchImpl, over = {}) => runCapabilityProbe({ mode: "identity", ...over }, ENV, fetchImpl);
const fieldAt = (cap, p) => cap.fields.find((f) => f.path === p);
function identityNoLeak(report) {
  const text = JSON.stringify({ ...report, ranAt: "" });
  for (const v of [...Object.values(PEOPLE), ...Object.values(MARKERS).map(String), ISSUED, USER, PASSWORD, DAY, "09-14", "1901", "02-03", "77.5", "5000.5", "Training", "https://", "server3.gpexe.com"]) {
    assert.ok(!text.includes(v), `no ${v} in the report`);
  }
  for (const id of ["4711", "4712", "500", "501", "900", "901", "981"]) assert.ok(!new RegExp(`\\b${id}\\b`).test(text.replace(/"status":\d+/g, "")), `no id ${id}`);
  for (const id of ["100", "101", "102"]) assert.ok(!new RegExp(`"[^"]*\\b${id}\\b`).test(text), `no id ${id} as a value`);
  assert.ok(!text.replace('"teamId":"980"', "").replace(/"teamIs980"/g, "").includes("980"), "the team id appears only as the declared target");
}

test("15. the identity run: one exchange, then exactly eight GETs in a fixed order; every person field is described by path, kind, counts and booleans only; the one athlete read follows the API's own index and a row confirmed twice", async () => {
  const { calls, fetchImpl } = fakeServer(identityRoutes());
  const report = await identityRun(fetchImpl);
  assert.equal(report.mode, "identity");
  assert.equal(report.stoppedBy, null);
  assert.equal(IDENTITY_MODE_MAX_REQUESTS, 9);
  assert.deepEqual(paths(calls), IDENTITY_PATHS);
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.body === undefined && c.redirect === "manual" && c.headers.Authorization === `Token ${ISSUED}`));
  assert.ok(calls.every((c) => new URL(c.url).origin === "https://server3.gpexe.com"));
  // No athlete list, no filter on athletes, no other team, no drill, no legacy family.
  assert.ok(!calls.some((c) => /\/athlete\/\?|athletes\/|team=981|\/981\/|drill=|\/api\//.test(c.url)), paths(calls).join(" | "));
  const caps = report.capabilities;
  assert.deepEqual(Object.keys(caps), [
    "identity_team_read", "identity_api_index", "identity_session_list", "identity_session_read", "identity_athlete_session_list",
    "identity_athlete_session_read", "identity_track_read", "identity_athlete_read", "identity_fields",
  ]);
  assert.deepEqual(caps.identity_fields, {
    verdict: "observed", readsDescribed: 8,
    nameLikeFieldIn: ["identity_team_read", "identity_session_list", "identity_session_read", "identity_athlete_session_list", "identity_athlete_session_read", "identity_track_read", "identity_athlete_read"],
    birthLikeFieldIn: ["identity_team_read", "identity_athlete_read"],
  });
  assert.deepEqual(caps.identity_api_index, {
    verdict: "described", status: 200, bodyIsObject: true,
    athleteResourceListed: true, athleteResourceUrlCanonical: true, athleteResourceUrlParsable: true, athleteResourceUrlHttps: true,
    athleteResourceUrlSameHost: true, athleteResourceUrlPathMatches: true,
  });
  const ar = caps.identity_athlete_read;
  assert.deepEqual([ar.verdict, ar.idMatchesRequested, ar.teamFieldKind, ar.teamNamesBoundTeam, ar.teamsFieldKind, ar.teamsIncludesBoundTeam], ["described", true, "number", true, "array", true]);
  assert.deepEqual(fieldAt(ar, "birthdate"), { path: "birthdate", category: "birth", present: 1, of: 1, kinds: ["string"], nullCount: 0, allIsoDate: true, allIsoDateTimePrefix: false, allValidCalendarDate: true, allYearPlausible: true });
  assert.deepEqual(fieldAt(ar, "first_name"), { path: "first_name", category: "name", present: 1, of: 1, kinds: ["string"], allNonEmptyText: true, anyContainsSpace: false, allContainLetter: true, allDistinct: true });
  assert.ok(fieldAt(ar, "last_name") && !ar.fields.some((f) => /email|weight/.test(f.path)), "only identity keys are described");
  const tr = caps.identity_team_read;
  assert.equal(tr.teamConfirmed, true);
  assert.deepEqual(fieldAt(tr, "athletes[].birthdate"), { path: "athletes[].birthdate", category: "birth", present: 2, of: 2, kinds: ["null", "string"], nullCount: 1, allIsoDate: true, allIsoDateTimePrefix: false, allValidCalendarDate: true, allYearPlausible: true });
  assert.equal(fieldAt(tr, "athletes[].first_name").present, 2);
  assert.ok(fieldAt(tr, "name"), "the team's own name is reported as a name-like key; which field is the athlete's is the owner's decision");
  const al = caps.identity_athlete_session_list;
  assert.deepEqual([al.rowCount, al.athleteFieldKinds, al.athleteIdDerived], [2, ["number"], true]);
  assert.deepEqual(fieldAt(al, "[].athlete_name"), { path: "[].athlete_name", category: "name", present: 2, of: 2, kinds: ["string"], allNonEmptyText: true, anyContainsSpace: true, allContainLetter: true, allDistinct: true });
  assert.deepEqual([caps.identity_athlete_session_read.rowOfSession, caps.identity_athlete_session_read.athleteMatchesListRow], [true, true]);
  assert.equal(caps.identity_track_read.athleteMatchesRow, true);
  assert.ok(fieldAt(caps.identity_session_list, "[].category_name") && fieldAt(caps.identity_session_list, "[].name"));
  // The per-request field names still come from the importer's drop list: personal fields are not
  // named there; only the identity descriptions name them.
  assert.ok(!report.requests.some((r) => Array.isArray(r.fieldNames) && (r.fieldNames.includes("athlete_name") || r.fieldNames.includes("birthdate") || r.fieldNames.includes("email"))));
  identityNoLeak(report);
});

test("16. the identity run's one athlete read happens only when the index lists `athlete` at the family's own place and the row's athlete is confirmed by its own detail; otherwise nothing is guessed and nothing more is sent", async () => {
  const eight = IDENTITY_PATHS.slice(0, 8);
  const cases = [
    [{ "GET /rest/v1/": answer(200, { team: ROOT_INDEX.team, team_session: ROOT_INDEX.team_session }) }, "athlete_resource_not_listed"],
    [{ "GET /rest/v1/": answer(200, { ...ROOT_INDEX, athlete: "https://server3.gpexe.com/api/athlete/" }) }, "athlete_resource_url_unexpected"],
    [{ "GET /rest/v1/": answer(200, { ...ROOT_INDEX, athlete: "https://elsewhere.example.invalid/rest/v1/athlete/" }) }, "athlete_resource_url_unexpected"],
    [{ "GET /rest/v1/": answer(200, { ...ROOT_INDEX, athlete: { url: ROOT_INDEX.athlete } }) }, "athlete_resource_url_unexpected"],
    [{ "GET /rest/v1/": answer(404, { detail: "Not found." }) }, "api_index_unavailable"],
    [{ "GET /rest/v1/": answer(302, "", { location: ROOT_INDEX.athlete }) }, "api_index_unavailable"],
    [{ "GET /rest/v1/": answer(200, "<html>not json</html>", { "content-type": "text/html" }) }, "api_index_unavailable"],
    [{ "GET /rest/v1/athlete_session/500/": answer(200, aRow(500, 4799, { athlete_name: PEOPLE.full })) }, "athlete_id_not_confirmed"],
    [{ "GET /rest/v1/athlete_session/500/": answer(200, aRow(500, "4711x")) }, "athlete_id_not_confirmed"],
  ];
  for (const [over, reason] of cases) {
    const { calls, fetchImpl } = fakeServer(identityRoutes(over));
    const report = await identityRun(fetchImpl);
    assert.deepEqual(paths(calls), eight, reason);
    assert.deepEqual(report.capabilities.identity_athlete_read, { verdict: "not_observed", reason }, reason);
    assert.equal(report.stoppedBy, null);
    identityNoLeak(report);
  }
  const redirected = await identityRun(fakeServer(identityRoutes({ "GET /rest/v1/": answer(302, "", { location: ROOT_INDEX.athlete }) })).fetchImpl);
  assert.deepEqual(redirected.capabilities.identity_api_index, { verdict: "not_observed", status: 302, reason: "redirected" });
  // An answer naming another athlete, or no answer: nothing of it is described.
  for (const [route, reason, idMatches] of [
    [answer(200, { id: 4712, first_name: PEOPLE.otherGiven, birthdate: PEOPLE.dob }), "athlete_answer_identity_unconfirmed", false],
    [answer(200, [{ id: 4711, first_name: PEOPLE.given }]), "athlete_read_failed", null],
    [answer(404, { detail: "Not found." }), "athlete_read_failed", null],
    [answer(403, { detail: "You do not have permission." }), "athlete_read_failed", null],
  ]) {
    const { calls, fetchImpl } = fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": route }));
    const report = await identityRun(fetchImpl);
    assert.deepEqual(paths(calls), IDENTITY_PATHS);
    const ar = report.capabilities.identity_athlete_read;
    assert.deepEqual([ar.verdict, ar.reason, ar.idMatchesRequested, "fields" in ar], ["not_observed", reason, idMatches, false]);
    assert.deepEqual(report.capabilities.identity_fields.birthLikeFieldIn, ["identity_team_read"]);
    identityNoLeak(report);
  }
  // An athlete record that names another team is reported by booleans only; nothing further is read.
  const moved = fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: PEOPLE.given, team: 981, teams: [{ id: 981 }] }) }));
  const mr = await identityRun(moved.fetchImpl);
  assert.deepEqual(paths(moved.calls), IDENTITY_PATHS);
  const m = mr.capabilities.identity_athlete_read;
  assert.deepEqual([m.teamFieldKind, m.teamNamesBoundTeam, m.teamsFieldKind, m.teamsIncludesBoundTeam], ["number", false, "array", false]);
  identityNoLeak(mr);
});

test("17. the identity run keeps the team boundary: another team, an unconfirmed session or rows of another session stop the chain before the next request; the cap is nine whatever is asked", async () => {
  const stops = [
    [{ "GET /rest/v1/team/980/": answer(200, { id: 981, name: PEOPLE.teamName }) }, "team_isolation_failed", 2],
    [{ [LIST]: answer(200, [sess(100, 980, DAY, [101]), sess(300, 981, DAY, [])], { "x-total-count": "2" }) }, "team_isolation_failed", 4],
    [{ "GET /rest/v1/team_session/100/": answer(200, sess(100, 981, DAY, [101, 102])) }, "team_isolation_failed", 5],
    [{ "GET /rest/v1/team_session/100/": answer(200, { id: 100, drills: [101, 102] }) }, "session_not_confirmed", 5],
    [{ "GET /rest/v1/team_session/100/": answer(404, { detail: "Not found." }) }, "session_not_confirmed", 5],
    [{ "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [aRow(500, 4711, { teamsession: 777 })]) }, "team_isolation_failed", 6],
    [{ "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, [aRow(500, 4711, { teamsession: null })]) }, "no_safe_athlete_row", 6],
    [{ "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(200, []) }, "no_safe_athlete_row", 6],
    [{ "GET /rest/v1/athlete_session/500/": answer(200, aRow(500, 4711, { teamsession: 777 })) }, "team_isolation_failed", 7],
    [{ [LIST]: answer(500, "") }, "session_list_unavailable", 4],
  ];
  for (const [over, stop, n] of stops) {
    const { calls, fetchImpl } = fakeServer(identityRoutes(over));
    const report = await identityRun(fetchImpl);
    assert.deepEqual([report.stoppedBy, calls.length], [stop, n], stop);
    assert.deepEqual(paths(calls), IDENTITY_PATHS.slice(0, n), stop);
    assert.ok(report.capabilities.identity_fields, "the summary is always there");
    identityNoLeak(report);
  }
  // A team read without a readable id is not a confirmed team: not described, the run goes on.
  const noId = await identityRun(fakeServer(identityRoutes({ "GET /rest/v1/team/980/": answer(200, { name: PEOPLE.teamName, athletes: [{ first_name: PEOPLE.given }] }) })).fetchImpl);
  assert.deepEqual(noId.capabilities.identity_team_read, { verdict: "not_observed", status: 200, teamConfirmed: false, reason: "team_id_unreadable" });
  assert.equal(noId.stoppedBy, null);
  // A track that is not the confirmed one: no track fields; the athlete read still follows the confirmed row.
  const badTrack = fakeServer(identityRoutes({ "GET /rest/v1/track/900/": answer(200, { id: 901, athlete: 4711, athlete_name: PEOPLE.full }) }));
  const bt = await identityRun(badTrack.fetchImpl);
  assert.deepEqual(bt.capabilities.identity_track_read, { verdict: "not_observed", status: 200, reason: "track_not_confirmed" });
  assert.deepEqual(paths(badTrack.calls), IDENTITY_PATHS);
  // The cap: never more than nine requests, whatever maxRequests says; a smaller cap stops early.
  const capped = fakeServer(identityRoutes());
  const c = await identityRun(capped.fetchImpl, { maxRequests: 14 });
  assert.deepEqual([capped.calls.length, c.stoppedBy], [9, null]);
  const small = fakeServer(identityRoutes());
  const s = await identityRun(small.fetchImpl, { maxRequests: 5 });
  assert.deepEqual([small.calls.length, s.stoppedBy], [5, "request_limit"]);
  identityNoLeak(s);
});

test("18. describeIdentityFields: key paths through id-keyed maps and unknown containers never print a key that could be a value; kinds, counts and the date checks are booleans; the values stay apart", () => {
  const raw = {
    players: { 4711: { athlete_name: PEOPLE.full, dateOfBirth: "1901-02-03T00:00:00Z" }, 4712: { athlete_name: PEOPLE.otherFull, dateOfBirth: null } },
    Markerkey: { first_name: PEOPLE.given },
    zzopaque: { surname: PEOPLE.family },
    "first name": PEOPLE.given,
    "birth date": PEOPLE.dob,
    firstName: "Markercamel",
    name: { first: PEOPLE.given, last: PEOPLE.family },
    roster: [{ dob: "1901-02-30" }, { dob: "3001-01-01" }, { dob: "1901/02/03" }, { dob: 19010203 }],
  };
  const d = describeIdentityFields(raw, { nowYear: 2026 });
  assert.deepEqual(d.fields.map((f) => f.path), [
    "<birth_key>", "<key>.first_name", "<key>.surname", "<name_key>", "firstName", "name", "name.first", "name.last", "players.<id>.athlete_name", "players.<id>.dateOfBirth", "roster[].dob",
  ]);
  assert.deepEqual(d.fields.find((f) => f.path === "players.<id>.dateOfBirth"), { path: "players.<id>.dateOfBirth", category: "birth", present: 2, of: 2, kinds: ["null", "string"], nullCount: 1, allIsoDate: false, allIsoDateTimePrefix: true, allValidCalendarDate: true, allYearPlausible: true });
  assert.deepEqual(d.fields.find((f) => f.path === "roster[].dob"), { path: "roster[].dob", category: "birth", present: 4, of: 4, kinds: ["number", "string"], nullCount: 0, allIsoDate: false, allIsoDateTimePrefix: false, allValidCalendarDate: false, allYearPlausible: false });
  assert.deepEqual(d.fields.find((f) => f.path === "name").kinds, ["object"]);
  assert.deepEqual([d.nameLike, d.birthLike, d.fieldsTruncated, d.walkTruncated], [true, true, false, false]);
  const printed = JSON.stringify({ ...d, values: undefined });
  for (const v of [...Object.values(PEOPLE), "Markercamel", "Markerkey", "zzopaque", "4711", "4712", "1901", "3001", "19010203"]) assert.ok(!printed.includes(v), `no ${v}`);
  for (const v of [PEOPLE.full, PEOPLE.given, PEOPLE.family, "1901-02-03T00:00:00Z", "3001-01-01", "19010203"]) assert.ok(d.values.has(v), `the guard keeps ${v}`);
  // Each date check on its own.
  const one = (v) => describeIdentityFields({ birthdate: v }, { nowYear: 2026 }).fields[0];
  assert.deepEqual([one("1901-02-03").allIsoDate, one("1901-02-03").allValidCalendarDate, one("1901-02-03").allYearPlausible], [true, true, true]);
  assert.deepEqual([one("1901-02-30").allIsoDate, one("1901-02-30").allValidCalendarDate], [true, false]);
  assert.deepEqual([one("1899-12-31").allYearPlausible, one("2027-01-01").allYearPlausible], [false, false]);
  assert.deepEqual([one(null).allIsoDate, one(null).nullCount, one("").allValidCalendarDate], [null, 1, false]);
  // Names: empty text, a single word, duplicates.
  const names = describeIdentityFields([{ athlete_name: PEOPLE.full }, { athlete_name: " " }, { athlete_name: "markergiven markerfamily" }]).fields[0];
  assert.deepEqual([names.present, names.of, names.allNonEmptyText, names.anyContainsSpace, names.allDistinct], [3, 3, false, true, false]);
  // Bounds: depth, array length and the number of printed paths.
  let deep = { first_name: PEOPLE.given };
  for (let i = 0; i < 6; i += 1) deep = { athlete: deep };
  assert.equal(describeIdentityFields(deep).walkTruncated, true);
  assert.equal(describeIdentityFields(Array.from({ length: 201 }, () => ({ athlete_name: PEOPLE.full }))).walkTruncated, true);
  // Invented name-like keys all collapse into one masked path; more than 40 distinct closed paths are cut.
  const invented = describeIdentityFields(Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}_name`, "Markerv"])));
  assert.deepEqual(invented.fields.map((f) => [f.path, f.present]), [["<name_key>", 45]]);
  const many = Object.fromEntries(IDENTITY_CONTAINER_KEYS.slice(0, 10).map((c) => [c, Object.fromEntries(["first_name", "last_name", "full_name", "nickname", "surname"].map((k) => [k, "Markerv"]))]));
  const m = describeIdentityFields(many);
  assert.deepEqual([m.fields.length, m.fieldsTruncated], [40, true]);
  // A primitive answer describes nothing.
  assert.deepEqual(describeIdentityFields("text").fields, []);
  assert.deepEqual(describeResourceIndex([1, 2], `${R}athlete/`), { bodyIsObject: false, athleteResourceListed: false, athleteResourceUrlCanonical: false, athleteResourceUrlParsable: false, athleteResourceUrlHttps: false, athleteResourceUrlSameHost: false, athleteResourceUrlPathMatches: false });
  assert.ok(!("resourceNames" in describeResourceIndex({ "Marker Person": `${R}x/` }, `${R}athlete/`)), "the index prints no resource name");
  assert.deepEqual(describeAthleteTeams({ teams: [{ id: "980" }] }, "980"), { teamFieldKind: "absent", teamNamesBoundTeam: null, teamsFieldKind: "array", teamsIncludesBoundTeam: true });
  assert.ok(IDENTITY_NAME_KEY.test("athlete_name") && IDENTITY_BIRTH_KEY.test("birthdate") && IDENTITY_BIRTH_KEY.test("date_of_birth") && IDENTITY_BIRTH_KEY.test("dob") && !IDENTITY_BIRTH_KEY.test("doble"));
  assert.ok(IDENTITY_CONTAINER_KEYS.includes("athlete") && !IDENTITY_CONTAINER_KEYS.includes("<key>"));
  assert.deepEqual([IDENTITY_MAX_DEPTH, IDENTITY_MAX_ITEMS, IDENTITY_MAX_PATHS], [4, 200, 40]);
});

test("19. the identity guard refuses to print a report that would carry a value seen under an identity field, quoted or as a bare word; words of the report itself and parts of longer words do not trip it; the other runs never describe identity", async () => {
  assert.throws(() => assertNoIdentityValueInReport('{"a":"Markergiven"}', new Set(["Markergiven"])), (e) => e.code === "identity_value_in_report");
  assert.throws(() => assertNoIdentityValueInReport('{"a":"x Markergiven y"}', new Set(["Markergiven"])), (e) => e.code === "identity_value_in_report");
  assert.throws(() => assertNoIdentityValueInReport('{"a":"1901-02-03"}', new Set(["1901-02-03"])), (e) => e.code === "identity_value_in_report");
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"teamNamesBoundTeam":true}', new Set(["Team", "Bound"])));
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"kinds":["null","string"]}', new Set(["null", "string", "None"])));
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"a":"Markergivenx"}', new Set(["Markergiven"])));
  assert.throws(() => assertNoIdentityValueInReport('{"a":"Ana"}', new Set(["Ana"])), (e) => e.code === "identity_value_in_report", "a short value quoted");
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"a":"Analysis"}', new Set(["Ana"])), "a short value is checked quoted only");
  // End to end: a source whose identity value equals a word the report prints standalone makes the
  // whole run refuse to print, rather than print that value.
  // A source that echoes an athlete's name into a header the report prints (the GPEXE version):
  // the whole run refuses, and the error names only the masked path of the read.
  // A name-like value printed through a header (a person string there is a placeholder since test 25,
  // so this one has the header's own shape): the guard still refuses, naming only the masked path.
  const echo = fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, nickname: "7.7.7", birthdate: PEOPLE.dob }, { "x-gpexe-version": "7.7.7" }) }));
  await assert.rejects(identityRun(echo.fetchImpl), (e) => e.code === "identity_value_in_report" && e.where === "rest/v1/athlete/<id>/" && !String(e.message).includes("7.7.7"));
  // A person string in the same header is a placeholder: the report prints without it.
  const named = await identityRun(fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: "Markerecho", birthdate: PEOPLE.dob }, { "x-gpexe-version": "Markerecho" }) })).fetchImpl);
  assert.ok(!JSON.stringify(named).includes("Markerecho"));
  // A value that is a word the report prints for its own reasons does not refuse it.
  const vocab = await identityRun(fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: "described", last_name: "athlete", birthdate: PEOPLE.dob }) })).fetchImpl);
  assert.equal(vocab.stoppedBy, null);
  identityNoLeak(vocab);
  // The full and drill runs never describe identity fields and never ask for the index or an athlete.
  const full = fakeServer({ ...happyRoutes(), ...ROOT_INDEX_ROUTE });
  const fr = await runCapabilityProbe({}, ENV, full.fetchImpl);
  assert.equal(fr.stoppedBy, null);
  assert.ok(!Object.keys(fr.capabilities).some((k) => k.startsWith("identity_")));
  assert.ok(!full.calls.some((c) => /\/rest\/v1\/$|\/athlete\/\d/.test(new URL(c.url).pathname)));
  const dr = fakeServer(drillRoutes(ROOT_INDEX_ROUTE));
  const drr = await runCapabilityProbe({ mode: "drill" }, ENV, dr.fetchImpl);
  assert.ok(!Object.keys(drr.capabilities).some((k) => k.startsWith("identity_")));
  assert.ok(!dr.calls.some((c) => /\/rest\/v1\/$|\/athlete\/\d/.test(new URL(c.url).pathname)));
  // The source: the identity description is computed only in the identity run, the index and the
  // athlete read have one call site each, and no athlete list or athlete filter is ever built.
  const source = (await fsp.readFile(path.resolve(ROOT, "backend/scripts/gpexe-rest-v1-capability-probe.mjs"), "utf8")).split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal((source.match(/describeIdentityFields\(raw\)/g) || []).length, 1);
  assert.match(source, /if \(mode === "identity" && raw !== undefined\) \{\n\s+identity = describeIdentityFields\(raw\);/);
  assert.equal((source.match(/get\(""\)/g) || []).length, 1, "one index read");
  assert.equal((source.match(/get\(`athlete\//g) || []).length, 1, "one athlete read");
  assert.match(source, /get\(`athlete\/\$\{gpexeAthleteId\}\/`\)/);
  assert.doesNotMatch(source, /`athlete\/\?|"athlete\/\?|athletes\//, "no athlete list and no athlete filter");
  assert.match(source, /if \(mode === "identity"\) return await runIdentity\(\);/);
});

test("20. ordinary session and team names never refuse the identity run: a word of the report's own paths, codes and key names is not a person, and `_` is part of a word", async () => {
  const sessions = [
    sess(100, 980, DAY, [101, 102], { name: "recovery session", category_name: "team" }),
    sess(101, 980, DAY, [], { name: "rest day track work", category_name: "team training" }),
    sess(102, 980, DAY, [], { name: "athlete testing" }),
  ];
  const { calls, fetchImpl } = fakeServer(identityRoutes({ [LIST]: answer(200, sessions, { "x-total-count": "3" }) }));
  const report = await identityRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), IDENTITY_PATHS);
  const text = JSON.stringify(report);
  for (const v of ["recovery", "testing", "rest day", "track work", "team training"]) assert.ok(!text.includes(v), v);
  identityNoLeak(report);
  // The word rule: inside an identifier a value is not found; standing alone it is.
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"p":"rest/v1/team_session/"}', new Set(["session"])));
  assert.throws(() => assertNoIdentityValueInReport('{"p":"rest/v1/team_session/"}', new Set(["rest"])), (e) => e.code === "identity_value_in_report");
  assert.doesNotThrow(() => assertNoIdentityValueInReport('{"p":"rest/v1/team_session/"}', new Set(["rest"]), reportVocabulary({ requests: [{ path: "rest/v1/team_session/" }] })));
  // Header VALUES are not vocabulary: a value printed there is still refused.
  const req = { path: "rest/v1/athlete/<id>/", fieldNames: ["first_name"], headerNames: ["x-gpexe-version"], gpexeVersion: "Markergiven", contentType: "application/json" };
  const v = reportVocabulary({ requests: [req, { ...req, path: "rest/v1/track/<id>/" }] });
  assert.ok(v.has("rest") && v.has("first_name") && v.has("gpexeVersion") && v.has("x") && !v.has("Markergiven") && !v.has("application"));
  // A source key outside the closed lists never joins the vocabulary, however often it recurs.
  const twice = reportVocabulary({ requests: ["rest/v1/athlete/<id>/", "rest/v1/track/<id>/", "rest/v1/team/<team>/"].map((p) => ({ path: p, fieldNames: ["markerlower"], headerNames: ["x-markerlower"] })) });
  assert.ok(!twice.has("markerlower") && twice.has("athlete"));
  // A session called "drills" still prints: `drills` is a field of the closed schema list.
  const drillsNamed = await identityRun(fakeServer(identityRoutes({ [LIST]: answer(200, [sess(100, 980, DAY, [101, 102], { name: "drills" }), sess(101, 980, DAY, []), sess(102, 980, DAY, [])], { "x-total-count": "3" }) })).fetchImpl);
  assert.equal(drillsNamed.stoppedBy, null);
  identityNoLeak(drillsNamed);
});

test("21. the athlete read: a proxy-style http link on the same host and path still allows it; another host or path never does; the index URL is described by booleans only; a row that already shows both fields makes the record unnecessary", async () => {
  const proxied = fakeServer(identityRoutes({ "GET /rest/v1/": answer(200, { ...ROOT_INDEX, athlete: "http://server3.gpexe.com/rest/v1/athlete/" }) }));
  const pr = await identityRun(proxied.fetchImpl);
  assert.deepEqual(paths(proxied.calls), IDENTITY_PATHS);
  const ix = pr.capabilities.identity_api_index;
  assert.deepEqual([ix.athleteResourceUrlCanonical, ix.athleteResourceUrlParsable, ix.athleteResourceUrlHttps, ix.athleteResourceUrlSameHost, ix.athleteResourceUrlPathMatches], [false, true, false, true, true]);
  assert.equal(pr.capabilities.identity_athlete_read.verdict, "described");
  identityNoLeak(pr);
  for (const [url, expect] of [
    ["https://server3.gpexe.com/api/athlete/", [true, true, true, false]],
    ["https://elsewhere.example.invalid/rest/v1/athlete/", [true, true, false, true]],
    ["https://server3.gpexe.com/rest/v1/athlete/?team=981", [true, true, true, false]],
    ["not a url", [false, false, false, false]],
  ]) {
    const d = describeResourceIndex({ athlete: url }, `${R}athlete/`);
    assert.deepEqual([d.athleteResourceUrlParsable, d.athleteResourceUrlHttps, d.athleteResourceUrlSameHost, d.athleteResourceUrlPathMatches], expect, url);
    assert.ok(!JSON.stringify(d).includes("elsewhere") && !JSON.stringify(d).includes("http"), "no URL printed");
  }
  // The row's own read already carries a name-like and a birth-like key: no athlete record is read.
  const both = fakeServer(identityRoutes({ "GET /rest/v1/athlete_session/500/": answer(200, aRow(500, 4711, { athlete_name: PEOPLE.full, birthdate: PEOPLE.dob })) }));
  const br = await identityRun(both.fetchImpl);
  assert.deepEqual(paths(both.calls), IDENTITY_PATHS.slice(0, 8));
  assert.deepEqual(br.capabilities.identity_athlete_read, { verdict: "not_observed", reason: "already_observed" });
  assert.ok(br.capabilities.identity_athlete_session_read.fields.some((f) => f.path === "birthdate" && f.category === "birth"));
  identityNoLeak(br);
});

test("22. a key that could be a person is never printed: capitalised keys and name-keyed maps are masked; the vocabulary covers the usual name and date variants; a run that read nothing says not_read", async () => {
  const d = describeIdentityFields({ roster: { Borna: { x: 1 }, Luka: { last: PEOPLE.family } }, Bornstein: "Markerv", Markername: "Markerw", bday: "1901-02-03", yob: 1901, given: PEOPLE.given });
  const printed = JSON.stringify(d.fields);
  for (const k of ["Borna", "Luka", "Bornstein", "Markername"]) assert.ok(!printed.includes(k), k);
  assert.ok(d.fields.some((f) => f.path === "<name_key>") && d.fields.some((f) => f.path === "bday" && f.category === "birth") && d.fields.some((f) => f.path === "yob" && f.category === "birth") && d.fields.some((f) => f.path === "given" && f.category === "name"));
  for (const k of ["birthdate", "BirthDate", "dateOfBirth", "date_of_birth", "dob", "DOB", "athlete_dob", "bdate", "born", "born_on", "bornOn", "yob"]) assert.ok(IDENTITY_BIRTH_KEY.test(k), k);
  for (const k of ["Borna", "borna", "Bornstein", "doble", "adobe", "stubborn", "yobbo"]) assert.ok(!IDENTITY_BIRTH_KEY.test(k), k);
  for (const k of ["first", "last", "given_name", "family", "middle_name", "surname", "athlete_name"]) assert.ok(IDENTITY_NAME_KEY.test(k), k);
  // Nested name parts and a list under a name key feed the guard; the parts are described.
  const n = describeIdentityFields({ name: { first: "Markergiven", last: "Markerfamily" }, aliases_name: ["Markeralias"], birth: { year: 1901, month: 2, day: 3 }, athlete_name: { markerlower: 1, markerother: { x: 1 } } });
  assert.ok(n.fields.some((f) => f.path === "name.first" && f.category === "name") && n.fields.some((f) => f.path === "birth.year" && f.category === "birth"));
  // A child outside the closed list is never printed, nor any key below it.
  assert.ok(n.fields.some((f) => f.path === "athlete_name.<name_key>") && !JSON.stringify(n.fields).includes("markerlower") && !JSON.stringify(n.fields).includes("markerother"));
  assert.ok(IDENTITY_CHILD_KEYS.includes("first") && IDENTITY_CHILD_KEYS.includes("year") && !IDENTITY_CHILD_KEYS.includes("y"));
  assert.ok(n.values.has("Markergiven") && n.values.has("Markeralias"));
  assert.ok(!JSON.stringify({ ...n, values: undefined }).includes("Markergiven"));
  // Nothing read: the summary says so.
  const none = await identityRun(fakeServer(identityRoutes({ "GET /rest/v1/team/980/": answer(500, ""), "GET /rest/v1/": answer(500, ""), [LIST]: answer(500, "") })).fetchImpl);
  assert.deepEqual(none.capabilities.identity_fields, { verdict: "not_read", readsDescribed: 0, nameLikeFieldIn: [], birthLikeFieldIn: [] });
});

test("23. a capitalised source key equal to a person's name is neither printed nor an exemption from the guard", async () => {
  // In the identity run a capitalised key never reaches fieldNames: the report prints without it.
  const keyed = fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: PEOPLE.given, birthdate: PEOPLE.dob, [PEOPLE.given]: { x: 1 } }) }));
  const report = await identityRun(keyed.fetchImpl);
  assert.deepEqual(paths(keyed.calls), IDENTITY_PATHS);
  const last = report.requests.at(-1);
  assert.ok(Array.isArray(last.fieldNames) && !last.fieldNames.includes(PEOPLE.given) && last.otherFieldCount === 1, JSON.stringify(last.fieldNames));
  identityNoLeak(report);
  // The vocabulary never takes a source key name outside the closed lists, so the guard still refuses it.
  const r = { path: "rest/v1/athlete/<id>/", fieldNames: [PEOPLE.given, "first_name"], resourceNames: ["Markerres", "athlete"], authScheme: "markerscheme" };
  const v = reportVocabulary({ requests: [r, { ...r }] });
  assert.ok(v.has("first_name") && v.has("athlete") && !v.has(PEOPLE.given) && !v.has("Markerres") && !v.has("markerscheme"));
  // An identity key path is the source's: its words never join the vocabulary.
  const paths2 = reportVocabulary({ requests: [{ path: "rest/v1/athlete/<id>/" }], capabilities: { identity_athlete_read: { fields: [{ path: "athletes[].markerlower_name", category: "name" }] } } });
  assert.ok(!paths2.has("markerlower_name") && !paths2.has("athletes") && paths2.has("category") && paths2.has("name"));
  // A lower-case key that is also a name value (an object keyed by user names) is never printed.
  const lower = fakeServer(identityRoutes({ "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, username: "markerlower", birthdate: PEOPLE.dob, markerlower: { x: 1 } }) }));
  const lr = await identityRun(lower.fetchImpl);
  assert.equal(lr.stoppedBy, null);
  assert.ok(!JSON.stringify(lr).includes("markerlower"));
  identityNoLeak(lr);
  assert.throws(() => assertNoIdentityValueInReport(`{"fieldNames":["${PEOPLE.given}"]}`, new Map([[PEOPLE.given, "rest/v1/athlete/<id>/"]]), v), (e) => e.code === "identity_value_in_report" && e.where === "rest/v1/athlete/<id>/");
  // The index prints no resource name at all.
  assert.ok(!JSON.stringify(describeResourceIndex({ athlete: `${R}athlete/`, Markerperson: `${R}x/` }, `${R}athlete/`)).includes("Marker"));
});

test("24. the identity run prints no source key outside its closed lists: a person-like key at the top, nested, repeated in two answers or as a resource name of the index never appears; harmless session names still print", async () => {
  const routes = identityRoutes({
    // The exchange answer is filtered too: a field and a header outside the closed lists are only counted.
    "POST /api-token-auth/": answer(200, { token: ISSUED, markerfield: 1 }, { "x-markerperson": "1" }),
    "GET /rest/v1/team/980/": answer(200, {
      id: 980, name: PEOPLE.teamName, markerrepeat: { x: 1 },
      profile: { markernested: { first_name: PEOPLE.given } },
      players: { markerplayer: { athlete_name: PEOPLE.full, markerdeep_name: "Markerv" } },
    }),
    "GET /rest/v1/": answer(200, { ...ROOT_INDEX, markerresource: `${R}markerresource/` }),
    [LIST]: answer(200, [sess(100, 980, DAY, [101, 102], { name: "team training" }), sess(101, 980, DAY, [], { name: "rest day" }), sess(102, 980, DAY, [])], { "x-total-count": "3" }),
    "GET /rest/v1/athlete/4711/": answer(200, { id: 4711, first_name: PEOPLE.given, username: "markerrepeat", markerrepeat: { x: 1 }, markerlower: "Markerv", markerkey_name: "Markerw", birthdate: PEOPLE.dob, team: 980 }),
  });
  const { calls, fetchImpl } = fakeServer(routes);
  const report = await identityRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), IDENTITY_PATHS);
  const text = JSON.stringify(report);
  for (const k of ["markerrepeat", "markernested", "markerplayer", "markerdeep_name", "markerresource", "markerlower", "markerkey_name", "markerfield", "markerperson", "team training", "rest day"]) assert.ok(!text.includes(k), k);
  assert.deepEqual([report.requests[0].fieldNames, report.requests[0].otherFieldCount, report.requests[0].otherHeaderCount], [["token"], 1, 1]);
  identityNoLeak(report);
  // The index: booleans only, and its request entry prints none of its keys, only how many.
  assert.ok(!("resourceNames" in report.capabilities.identity_api_index) && !("resourceCount" in report.capabilities.identity_api_index));
  const indexEntry = report.requests.find((r) => r.path === "rest/v1/");
  assert.deepEqual([indexEntry.fieldNames, indexEntry.otherFieldCount], ["<omitted>", 6]);
  // Every source key the report names is from a closed list or a placeholder.
  const closedPath = new Set([...IDENTITY_NAME_FIELDS, ...IDENTITY_BIRTH_FIELDS, ...IDENTITY_CHILD_KEYS, ...IDENTITY_CONTAINER_KEYS, "<key>", "<id>", "<name_key>", "<birth_key>", "[]"]);
  for (const r of report.requests) {
    for (const key of ["fieldNames", "resultFieldNames"]) if (Array.isArray(r[key])) for (const k of r[key]) assert.ok(IDENTITY_SCHEMA_FIELDS.includes(k), `${r.path}: ${k}`);
    if (Array.isArray(r.headerNames)) for (const h of r.headerNames) assert.ok(IDENTITY_HEADER_NAMES.includes(h), h);
  }
  for (const [name, cap] of Object.entries(report.capabilities)) {
    for (const f of cap.fields ?? []) for (const seg of f.path.split(".")) assert.ok(closedPath.has(seg) || closedPath.has(seg.replace(/\[\]$/, "")), `${name}: ${f.path}`);
  }
  const tf = report.capabilities.identity_team_read.fields.map((f) => f.path);
  assert.ok(tf.includes("profile.<key>.first_name") && tf.includes("players.<key>.athlete_name") && tf.includes("players.<key>.<name_key>"), tf.join(" | "));
  const af = report.capabilities.identity_athlete_read.fields.map((f) => f.path);
  assert.ok(af.includes("username") && af.includes("<name_key>") && af.includes("birthdate"), af.join(" | "));
  assert.ok(report.requests.at(-1).otherFieldCount >= 2, String(report.requests.at(-1).otherFieldCount));
  // The filter itself: a key or header outside the closed lists is counted, never named.
  assert.deepEqual(identityFilterDescribed({ headerNames: ["content-type", "x-markerperson"], fieldNames: ["id", "markerlower"] }), { headerNames: ["content-type"], otherHeaderCount: 1, fieldNames: ["id"], otherFieldCount: 1 });
  assert.deepEqual(identityFilterDescribed({ fieldNames: ["athlete", "markerresource"] }, { index: true }), { fieldNames: "<omitted>", otherFieldCount: 2 });
  // The full run is unchanged: no identity filter and no counts there.
  const full = await runCapabilityProbe({}, ENV, fakeServer(happyRoutes()).fetchImpl);
  assert.ok(!full.requests.some((r) => "otherFieldCount" in r || "otherHeaderCount" in r));
  assert.ok(full.requests.some((r) => Array.isArray(r.fieldNames) && r.fieldNames.includes("teamsession")));
});

test("25. the identity run prints the source's header values and scheme word only in their expected shape: a person string in Allow, Content-Type, the GPEXE version or WWW-Authenticate becomes a placeholder, never a leak and never a refusal", async () => {
  const odd = { allow: "Markerperson", "content-type": "application/json; name=Markerperson", "x-gpexe-version": "Markerperson", "www-authenticate": "Markerscheme realm=x" };
  const { calls, fetchImpl } = fakeServer(identityRoutes({ "GET /rest/v1/track/900/": answer(200, { id: 900, athlete: 4711, athlete_name: PEOPLE.full, timezone: MARKERS.tz }, odd) }));
  const report = await identityRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), IDENTITY_PATHS);
  const t = report.requests.find((r) => r.path === "rest/v1/track/<id>/");
  assert.deepEqual([t.allow, t.contentType, t.gpexeVersion, t.authScheme], ["<unprintable>", "<unprintable>", "<unprintable>", "<other>"]);
  assert.ok(!JSON.stringify(report).includes("Marker" + "person") && !JSON.stringify(report).includes("Markerscheme"));
  identityNoLeak(report);
  // Every header value and scheme word of the identity report is in its shape or a placeholder.
  for (const r of report.requests) {
    for (const [key, shape] of Object.entries(IDENTITY_HEADER_VALUE_SHAPES)) if (typeof r[key] === "string") assert.ok(shape.test(r[key]) || r[key] === "<unprintable>", `${r.path}: ${key}`);
    if (typeof r.authScheme === "string") assert.ok(IDENTITY_AUTH_SCHEMES.includes(r.authScheme) || r.authScheme === "<other>", r.path);
  }
  // Strings that only look like the header's kind are placeholders too.
  assert.deepEqual(identityFilterDescribed({ allow: "MARKERPERSON, MARKERFAMILY", contentType: "application/markerperson", gpexeVersion: "19900512", totalCount: "12", count: 1.5 }), { allow: "<unprintable>", contentType: "<unprintable>", gpexeVersion: "<unprintable>", totalCount: "12", count: "<unprintable>" });
  assert.deepEqual(identityFilterDescribed({ gpexeVersion: "1990.05.12", count: 308 }), { gpexeVersion: "<unprintable>", count: 308 });
  // The usual values keep their shape.
  assert.deepEqual(identityFilterDescribed({ allow: "GET, HEAD, OPTIONS", contentType: "application/json; charset=utf-8", gpexeVersion: "9.11.8", totalCount: "308", authScheme: "Token" }), { allow: "GET, HEAD, OPTIONS", contentType: "application/json; charset=utf-8", gpexeVersion: "9.11.8", totalCount: "308", authScheme: "Token" });
  assert.deepEqual(identityFilterDescribed({ allow: "GET,POST,HEAD,OPTIONS", contentType: "application/json;charset=UTF-8" }), { allow: "GET,POST,HEAD,OPTIONS", contentType: "application/json;charset=UTF-8" });
  // The full run is unchanged: it prints those values as before.
  const full = fakeServer({ ...happyRoutes(), "GET /rest/v1/track/900/": answer(200, { id: 900, timezone: MARKERS.tz }, { "x-gpexe-version": "9.11.8" }) });
  const fr = await runCapabilityProbe({}, ENV, full.fetchImpl);
  assert.equal(fr.requests.find((r) => r.path === "rest/v1/track/<id>/").gpexeVersion, "9.11.8");
});

// ---------------------------------------------------------------------------
// The athlete-list run (owner order 2026-10-23): do the rows of a session's athlete list carry the
// importer's nine row fields with the same values as each row's own read? Fake server only. Two
// parents of team 980 (100 with two drills, 300 with one), the drill rows of the session list
// (101, 102, 301) named by their parents and never chosen; one athlete row per athlete for the whole
// session and one per drill (2 athletes: 6 rows for 100, 4 for 300).
// ---------------------------------------------------------------------------
const AL_EXCHANGE = "POST /api-token-auth/";
const AL_LIST = "GET /rest/v1/team_session/?team=980&limit=100";
const alRow = (id, athlete, session, drill, extra = {}) => ({ id, athlete, track: 70000 + id, teamsession: session, drill, is_stats_valid: true, total_time: 3000 + id, total_distance: 5000.25 + id, max_v: 7.75, athlete_name: MARKERS.athleteName, ...extra });
const AL_ROWS = {
  100: [alRow(8001, 4711, 100, null), alRow(8002, 4712, 100, null), alRow(8003, 4711, 100, 0), alRow(8004, 4712, 100, 0), alRow(8005, 4711, 100, 1), alRow(8006, 4712, 100, 1)],
  300: [alRow(9001, 4711, 300, null), alRow(9002, 4712, 300, null), alRow(9003, 4711, 300, 0), alRow(9004, 4712, 300, 0)],
};
const alSessionRows = [sess(100, 980, DAY, [101, 102]), sess(101, 980, DAY, []), sess(102, 980, DAY, []), sess(200, 980, OTHER_DAY, []), sess(300, 980, DAY, [301]), sess(301, 980, DAY, [])];
function athleteListRoutes({ rows = AL_ROWS, detail = (r) => ({ ...r, more_field: MARKERS.note }), sessions = alSessionRows, over = {} } = {}) {
  const routes = {
    [AL_EXCHANGE]: happyRoutes()[AL_EXCHANGE],
    [AL_LIST]: answer(200, sessions, { "x-total-count": String(sessions.length) }),
    "GET /rest/v1/team_session/100/": answer(200, sess(100, 980, DAY, [101, 102])),
    "GET /rest/v1/team_session/300/": answer(200, sess(300, 980, DAY, [301])),
  };
  for (const [sid, list] of Object.entries(rows)) {
    routes[`GET /rest/v1/athlete_session/?teamsession=${sid}&limit=100`] = answer(200, list, { "x-total-count": String(list.length) });
    for (const r of list) routes[`GET /rest/v1/athlete_session/${r.id}/`] = answer(200, detail(r));
  }
  return { ...routes, ...over };
}
const alRun = (fetchImpl, over = {}) => {
  const sleeps = [];
  const promise = runCapabilityProbe({ mode: "athlete-list", sleep: async (ms) => { sleeps.push(ms); }, ...over }, ENV, fetchImpl);
  return promise.then((report) => ({ report, sleeps }));
};
const AL_EXPECTED_ORDER = [
  AL_EXCHANGE, AL_LIST,
  "GET /rest/v1/team_session/100/", "GET /rest/v1/athlete_session/?teamsession=100&limit=100",
  "GET /rest/v1/athlete_session/8001/", "GET /rest/v1/athlete_session/8003/", "GET /rest/v1/athlete_session/8006/",
  "GET /rest/v1/team_session/300/", "GET /rest/v1/athlete_session/?teamsession=300&limit=100",
  "GET /rest/v1/athlete_session/9001/", "GET /rest/v1/athlete_session/9003/", "GET /rest/v1/athlete_session/9004/",
];
const alNoLeak = (report) => {
  const text = JSON.stringify(report);
  for (const leak of [USER, PASSWORD, ISSUED, MARKERS.athleteName, MARKERS.note, MARKERS.sessionName, "4711", "4712", "8001", "8006", "9004", "70000", "78006", "11001", "13001.25", "14006.25", "7.75"]) assert.ok(!text.includes(leak), `the report never carries ${leak}`);
};

test("AL1 the athlete-list run: one exchange, then eleven GETs in a fixed order with a pause before every read; two parents, three rows each; every field present and equal is `same`; nothing but kinds, counts and booleans", async () => {
  const { calls, fetchImpl } = fakeServer(athleteListRoutes());
  const { report, sleeps } = await alRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), AL_EXPECTED_ORDER);
  assert.equal(ATHLETE_LIST_MODE_MAX_REQUESTS, AL_EXPECTED_ORDER.length, "the cap is exactly the plan");
  assert.equal(report.requestCount, 12);
  assert.deepEqual(sleeps, Array(11).fill(ATHLETE_LIST_PAUSE_MS), "a pause before every read, none before the exchange");
  assert.equal(ATHLETE_LIST_PAUSE_MS, 2000);
  assert.equal(report.pauseMs, 2000);
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.headers.Authorization === `Token ${ISSUED}` && c.redirect === "manual"));
  const v = report.capabilities.athlete_list_fields;
  assert.equal(v.verdict, "same");
  assert.deepEqual([v.sessionsCompared, v.rowsCompared, v.allProjectedEqual], [ATHLETE_LIST_SESSIONS, ATHLETE_LIST_SESSIONS * ATHLETE_LIST_ROWS_PER_SESSION, true]);
  assert.deepEqual(Object.keys(v.fields), [...ATHLETE_LIST_FIELDS]);
  assert.deepEqual([...ATHLETE_LIST_FIELDS], ["id", "athlete", "track", "teamsession", "drill", "is_stats_valid", "total_time", "total_distance", "max_v"]);
  for (const f of ATHLETE_LIST_FIELDS) assert.deepEqual([v.fields[f].inListAll, v.fields[f].inDetailAll, v.fields[f].equalAll, v.fields[f].projectableAll], [true, true, true, true], f);
  assert.deepEqual(v.fields.drill.kindsList, ["null", "number"]);
  assert.deepEqual(v.fields.total_distance.kindsDetail, ["number"]);
  assert.deepEqual(v.sessions.map((x) => [x.drillsCount, x.listTotal, x.rowsOnPage, x.pageComplete, x.wholeRows, x.drillRows, x.distinctAthletes, x.rowsMatchOnePerAthleteAndDrill, x.listRowsHaveTrackField]),
    [[2, 6, 6, true, 2, 4, 2, true, true], [1, 4, 4, true, 2, 2, 2, true, true]]);
  assert.deepEqual(v.sessions.map((x) => x.rows.map((r) => r.rowKind)), [["whole", "drill", "drill"], ["whole", "drill", "drill"]]);
  assert.ok(v.sessions.every((x) => x.rows.every((r) => r.projectedEqual && r.differingFields.length === 0)));
  assert.deepEqual(report.capabilities.session_list, { verdict: "proven", status: 200, rowCount: 6, totalIsNumber: true, parentsChosen: 2 });
  alNoLeak(report);
});

test("AL2 a value that differs, or a field the list does not carry, makes the verdict `differs` and names only the field (from the closed list of nine)", async () => {
  // The list's distance rounded on one drill row of session 100.
  const rounded = { ...AL_ROWS, 100: AL_ROWS[100].map((r) => (r.id === 8006 ? { ...r, total_distance: Math.round(r.total_distance) } : r)) };
  const one = fakeServer(athleteListRoutes({ rows: rounded, detail: (r) => ({ ...(r.id === 8006 ? AL_ROWS[100][5] : r) }) }));
  const { report } = await alRun(one.fetchImpl);
  const v = report.capabilities.athlete_list_fields;
  assert.equal(v.verdict, "differs");
  assert.equal(v.allProjectedEqual, false);
  assert.equal(v.fields.total_distance.equalAll, false);
  assert.ok(ATHLETE_LIST_FIELDS.filter((f) => f !== "total_distance").every((f) => v.fields[f].equalAll), "only that field");
  assert.deepEqual(v.sessions[0].rows.map((r) => r.differingFields), [[], [], ["total_distance"]]);
  alNoLeak(report);
  // The list carries no `track` at all: every row differs in exactly that field.
  const noTrack = Object.fromEntries(Object.entries(AL_ROWS).map(([sid, list]) => [sid, list.map(({ track, ...r }) => r)]));
  const two = fakeServer(athleteListRoutes({ rows: noTrack, detail: (r) => ({ ...r, track: 70000 + r.id }) }));
  const { report: r2 } = await alRun(two.fetchImpl);
  const v2 = r2.capabilities.athlete_list_fields;
  assert.equal(v2.verdict, "differs");
  assert.deepEqual([v2.fields.track.inListAll, v2.fields.track.inDetailAll, v2.fields.track.equalAll, v2.fields.track.kindsList], [false, true, false, ["absent"]]);
  assert.ok(v2.sessions.every((x) => !x.listRowsHaveTrackField && x.rows.every((r) => r.differingFields.length === 1 && r.differingFields[0] === "track")));
  // Both reads lack a field: the same projection (nothing), not a difference.
  const neither = Object.fromEntries(Object.entries(AL_ROWS).map(([sid, list]) => [sid, list.map(({ max_v, ...r }) => r)]));
  const three = fakeServer(athleteListRoutes({ rows: neither, detail: (r) => ({ ...r }) }));
  const v3 = (await alRun(three.fetchImpl)).report.capabilities.athlete_list_fields;
  assert.deepEqual([v3.verdict, v3.fields.max_v.inListAll, v3.fields.max_v.inDetailAll, v3.fields.max_v.equalAll], ["same", false, false, true]);
  for (const x of [v, v2, v3]) for (const s of x.sessions) for (const r of s.rows) assert.ok(r.differingFields.every((f) => ATHLETE_LIST_FIELDS.includes(f)));
});

test("AL3 the first 429 ends the run at once, without a repeat: its Retry-After as a kind word and bounded seconds, the request number, and no further request", async () => {
  for (const [at, headers, expected] of [
    ["GET /rest/v1/athlete_session/?teamsession=100&limit=100", { "retry-after": "30" }, { requestNumber: 4, retryAfter: "seconds", retryAfterS: 30 }],
    ["GET /rest/v1/athlete_session/8003/", {}, { requestNumber: 6, retryAfter: "absent", retryAfterS: null }],
    ["GET /rest/v1/team_session/300/", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, { requestNumber: 8, retryAfter: "other", retryAfterS: null }],
    [AL_LIST, { "retry-after": "90000" }, { requestNumber: 2, retryAfter: "seconds", retryAfterS: "over_day" }],
  ]) {
    const { calls, fetchImpl } = fakeServer(athleteListRoutes({ over: { [at]: answer(429, { detail: "Request was throttled." }, headers) } }));
    const { report, sleeps } = await alRun(fetchImpl);
    assert.equal(report.stoppedBy, "rate_limited", at);
    assert.deepEqual(report.rateLimit, expected, at);
    assert.equal(paths(calls)[calls.length - 1], at, `${at}: the 429 was the last request`);
    assert.equal(paths(calls).filter((p) => p === at).length, 1, `${at}: never repeated`);
    assert.equal(calls.length, expected.requestNumber);
    assert.equal(sleeps.length, calls.length - 1, "only the pauses before each read");
    assert.equal(report.capabilities.athlete_list_fields.verdict, "not_observed");
    assert.equal(report.capabilities.athlete_list_fields.reason, "rate_limited");
    alNoLeak(report);
  }
  assert.deepEqual(retryAfterOf(" 7 "), { retryAfter: "seconds", retryAfterS: 7 });
  assert.deepEqual(retryAfterOf("1.5"), { retryAfter: "other", retryAfterS: null });
  assert.deepEqual(retryAfterOf(""), { retryAfter: "absent", retryAfterS: null });
});

test("AL4 every identity, session and team is confirmed before the next request: a foreign team, a row of another session, a row or a parent answering another id, or an unconfirmed parent stops the run there", async () => {
  const cases = [
    ["team_isolation_failed", { sessions: [...alSessionRows, sess(400, 981, DAY, [401])] }, 2],
    ["team_isolation_failed", { rows: { ...AL_ROWS, 100: [...AL_ROWS[100], alRow(8007, 4713, 777, null)] } }, 4],
    ["row_id_mismatch", { detail: (r) => ({ ...r, id: r.id === 8003 ? 8004 : r.id }) }, 6],
    ["team_isolation_failed", { detail: (r) => ({ ...r, teamsession: r.id === 9003 ? 100 : r.teamsession }) }, 11],
    ["detail_does_not_name_session", { detail: (r) => ({ ...r, teamsession: r.id === 8001 ? null : r.teamsession }) }, 5],
    ["parent_id_mismatch", { over: { "GET /rest/v1/team_session/100/": answer(200, sess(101, 980, DAY, [101, 102])) } }, 3],
    ["parent_not_confirmed", { over: { "GET /rest/v1/team_session/100/": answer(200, { ...sess(100, 980, DAY, []), drills_count: 0 }) } }, 3],
    ["team_isolation_failed", { over: { "GET /rest/v1/team_session/300/": answer(200, sess(300, 981, DAY, [301])) } }, 8],
    ["parent_not_confirmed", { over: { "GET /rest/v1/team_session/300/": answer(404, { detail: "Not found." }) } }, 8],
    ["rows_do_not_name_session", { rows: { ...AL_ROWS, 300: AL_ROWS[300].map((r) => ({ ...r, teamsession: undefined })) } }, 9],
    ["row_identity_unreadable", { rows: { ...AL_ROWS, 100: AL_ROWS[100].map((r) => (r.id === 8004 ? { ...r, athlete: "04712" } : r)) } }, 4],
    ["row_ids_repeated", { rows: { ...AL_ROWS, 100: [...AL_ROWS[100], AL_ROWS[100][1]] } }, 4],
    ["athlete_list_unavailable", { over: { "GET /rest/v1/athlete_session/?teamsession=100&limit=100": answer(500, { detail: "error" }) } }, 4],
    ["row_detail_unavailable", { over: { "GET /rest/v1/athlete_session/8006/": answer(404, { detail: "Not found." }) } }, 7],
  ];
  for (const [code, config, sent] of cases) {
    const { calls, fetchImpl } = fakeServer(athleteListRoutes(config));
    const { report } = await alRun(fetchImpl);
    assert.equal(report.stoppedBy, code, `${code} after ${sent}`);
    assert.equal(calls.length, sent, `${code}: nothing after the request that failed`);
    assert.equal(report.capabilities.athlete_list_fields.verdict, "not_observed", code);
    alNoLeak(report);
  }
});

test("AL5 the parents come from the list page only: a row named in another row's drills is never a parent, a row without drills is not chosen, one parent is read alone, none ends the run after the list", async () => {
  // No row with drills: nothing but the exchange and the list.
  const none = fakeServer(athleteListRoutes({ sessions: [sess(200, 980, OTHER_DAY, []), sess(201, 980, DAY, [])] }));
  const { report } = await alRun(none.fetchImpl);
  assert.equal(report.stoppedBy, "no_parent_session");
  assert.deepEqual(paths(none.calls), [AL_EXCHANGE, AL_LIST]);
  assert.equal(report.capabilities.athlete_list_fields.verdict, "not_observed");
  // A named drill row with drills of its own is still never a parent; only 300 is left.
  const named = fakeServer(athleteListRoutes({ sessions: [sess(101, 980, DAY, [102]), sess(300, 980, DAY, [301, 101]), sess(301, 980, DAY, []), sess(102, 980, DAY, [])] }));
  const r2 = await alRun(named.fetchImpl);
  assert.equal(r2.report.capabilities.session_list.parentsChosen, 1);
  assert.deepEqual(paths(named.calls).slice(2), ["GET /rest/v1/team_session/300/", "GET /rest/v1/athlete_session/?teamsession=300&limit=100", "GET /rest/v1/athlete_session/9001/", "GET /rest/v1/athlete_session/9003/", "GET /rest/v1/athlete_session/9004/"]);
  // One parent is not the plan's evidence: its facts are printed, the verdict is never `same`.
  assert.deepEqual([r2.report.capabilities.athlete_list_fields.verdict, r2.report.capabilities.athlete_list_fields.reason], ["not_observed", "fewer_parents_than_planned"]);
  assert.equal(r2.report.capabilities.athlete_list_fields.sessionsCompared, 1);
  assert.equal(r2.report.capabilities.athlete_list_fields.allProjectedEqual, true);
  // Only the first two parents of the page are read, whatever follows.
  const many = fakeServer(athleteListRoutes({ sessions: [...alSessionRows, sess(500, 980, DAY, [501]), sess(501, 980, DAY, [])] }));
  await alRun(many.fetchImpl);
  assert.ok(!paths(many.calls).some((p) => p.includes("/500/") || p.includes("teamsession=500")));
});

test("AL6 the rows read: the first whole-session row, the first drill row and the last row, then the next in order; a short list is read whole; the formula is judged only on a complete page", async () => {
  // No drill row in the list although the parent has two drills: three rows in order, the formula fails.
  const wholeOnly = { ...AL_ROWS, 100: [alRow(8001, 4711, 100, null), alRow(8002, 4712, 100, null), alRow(8008, 4713, 100, null), alRow(8009, 4714, 100, null)] };
  const a = fakeServer(athleteListRoutes({ rows: wholeOnly }));
  const ra = await alRun(a.fetchImpl);
  assert.deepEqual(paths(a.calls).slice(4, 7), ["GET /rest/v1/athlete_session/8001/", "GET /rest/v1/athlete_session/8009/", "GET /rest/v1/athlete_session/8002/"]);
  assert.equal(ra.report.capabilities.athlete_list_fields.sessions[0].rowsMatchOnePerAthleteAndDrill, false);
  // Two rows: both read, no third; a page whose total says more rows exist is not judged.
  const short = { ...AL_ROWS, 300: AL_ROWS[300].slice(0, 2) };
  const routes = athleteListRoutes({ rows: short });
  routes["GET /rest/v1/athlete_session/?teamsession=300&limit=100"] = answer(200, short[300], { "x-total-count": "250" });
  const b = fakeServer(routes);
  const rb = await alRun(b.fetchImpl);
  assert.equal(rb.report.requestCount, 11);
  const s300 = rb.report.capabilities.athlete_list_fields.sessions[1];
  assert.deepEqual([s300.rows.length, s300.pageComplete, s300.rowsMatchOnePerAthleteAndDrill, s300.listTotal], [2, false, null, 250]);
  assert.equal(rb.report.capabilities.athlete_list_fields.verdict, "same");
});

test("AL7 the limits: the run's cap, a pause that cannot be turned into a burst, and the probe's other boundaries unchanged", async () => {
  const { calls, fetchImpl } = fakeServer(athleteListRoutes());
  const { report } = await alRun(fetchImpl, { maxRequests: 5 });
  assert.equal(report.stoppedBy, "request_limit");
  assert.equal(calls.length, 5);
  for (const bad of [-1, 1.5, 10_001, "2000"]) await assert.rejects(runCapabilityProbe({ mode: "athlete-list", pauseMs: bad }, ENV, fetchImpl), DiscoveryUsageError, String(bad));
  await assert.rejects(runCapabilityProbe({ mode: "athlete-list", sleep: "no" }, ENV, fetchImpl), DiscoveryUsageError);
  // A larger maxRequests never lifts the run's own cap.
  const big = fakeServer(athleteListRoutes());
  const r2 = await alRun(big.fetchImpl, { maxRequests: 14 });
  assert.equal(big.calls.length, ATHLETE_LIST_MODE_MAX_REQUESTS);
  assert.equal(r2.report.stoppedBy, null);
  // The flow sends exactly the cap; the cap itself is the backstop should the flow ever grow.
  const source = await fsp.readFile(path.resolve(ROOT, "backend/scripts/gpexe-rest-v1-capability-probe.mjs"), "utf8");
  assert.match(source, /if \(mode === "athlete-list"\) maxRequests = Math\.min\(maxRequests, ATHLETE_LIST_MODE_MAX_REQUESTS\);/);
  // The other runs never pause.
  const full = fakeServer();
  const sleeps = [];
  await runCapabilityProbe({ sleep: async (ms) => { sleeps.push(ms); } }, ENV, full.fetchImpl);
  assert.deepEqual(sleeps, []);
  assert.equal(valueKind({ a: null }, "a"), "null");
  assert.equal(valueKind({}, "a"), "absent");
  assert.equal(valueKind({ a: [1] }, "a"), "array");
});

test("AL8 a failed exchange in the athlete-list run (refused, timed out or redirected) is reported as exchange_failed with its request entry, nothing more is sent, nothing paused", async () => {
  const hang = (init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
  for (const [label, exchange, entry] of [
    ["refused", answer(400, { non_field_errors: ["Unable to log in."] }), { status: 400 }],
    ["timeout", hang, { error: "timeout" }],
    ["redirect", answer(302, {}, { location: "https://elsewhere.example/" }), { status: 302, redirected: true }],
  ]) {
    const { calls, fetchImpl } = fakeServer(athleteListRoutes({ over: { [AL_EXCHANGE]: exchange } }));
    const { report, sleeps } = await alRun(fetchImpl, { timeoutMs: 50 });
    assert.equal(report.stoppedBy, "exchange_failed", label);
    assert.equal(calls.length, 1, `${label}: only the exchange`);
    assert.deepEqual(sleeps, [], `${label}: no pause before the exchange`);
    assert.deepEqual(report.capabilities.athlete_list_fields.verdict, "not_observed", label);
    assert.equal(report.capabilities.athlete_list_fields.reason, "exchange_failed", label);
    for (const [k, value] of Object.entries(entry)) assert.equal(report.requests[0][k], value, `${label}: ${k}`);
    assert.equal(report.rateLimit, undefined, label);
    alNoLeak(report);
  }
});

test("AL9 the athlete-list run prints only the closed list of an answer's key names; every other key is only counted", async () => {
  const { fetchImpl } = fakeServer(athleteListRoutes({ detail: (r) => ({ ...r, more_field: MARKERS.note, zzz_unknown_key: 1 }) }));
  const { report } = await alRun(fetchImpl);
  assert.equal(report.capabilities.athlete_list_fields.verdict, "same");
  for (const r of report.requests) {
    for (const key of ["fieldNames", "resultFieldNames"]) if (Array.isArray(r[key])) assert.ok(r[key].every((k) => ATHLETE_LIST_PRINTABLE_KEYS.includes(k)), `${r.path}: ${r[key]}`);
  }
  const text = JSON.stringify(report);
  for (const key of ["more_field", "zzz_unknown_key", "\"notes\"", "\"name\"", "athlete_name", "\"token\""]) assert.ok(!text.includes(key), key);
  const row = report.requests.find((r) => r.path === "rest/v1/athlete_session/<id>/");
  assert.equal(row.otherFieldCount, 2, "the detail's two other keys are counted, not named");
  // The session read: the drop list removes its notes; its name is a key outside the closed list, so it is only counted.
  const own = report.requests.find((r) => r.path === "rest/v1/team_session/<id>/");
  assert.deepEqual([own.fieldNames.includes("drills_count"), own.fieldNames.includes("name"), own.otherFieldCount], [true, false, 1]);
  assert.deepEqual(athleteListFilterDescribed({ fieldNames: ["id", "secret_key"], resultFieldNames: ["max_v"], count: 1e300 }), { fieldNames: ["id"], otherFieldCount: 1, resultFieldNames: ["max_v"], count: "<unprintable>" });
  // The other runs keep their description.
  const full = await runCapabilityProbe({}, ENV, fakeServer().fetchImpl);
  assert.ok(full.requests.some((r) => Array.isArray(r.fieldNames) && r.fieldNames.includes("notes") === false && r.fieldNames.length > 0));
});

test("AL10 a parent whose athlete list is empty stops the run (athlete_list_empty) after that list: an empty list is never a vacuous `same`", async () => {
  const { calls, fetchImpl } = fakeServer(athleteListRoutes({ rows: { ...AL_ROWS, 300: [] } }));
  const { report } = await alRun(fetchImpl);
  assert.equal(report.stoppedBy, "athlete_list_empty");
  assert.equal(calls.length, 9, "nothing after the empty list of the second parent");
  assert.deepEqual([report.capabilities.athlete_list_fields.verdict, report.capabilities.athlete_list_fields.reason, report.capabilities.athlete_list_fields.rowsCompared], ["not_observed", "athlete_list_empty", 3]);
});

test("AL11 a 429 on the exchange in the athlete-list run is named as the source's rate limit: request 1, its Retry-After as a kind word, nothing more sent", async () => {
  const { calls, fetchImpl } = fakeServer(athleteListRoutes({ over: { [AL_EXCHANGE]: answer(429, { detail: "Request was throttled." }, { "retry-after": "30" }) } }));
  const { report, sleeps } = await alRun(fetchImpl);
  assert.equal(report.stoppedBy, "rate_limited");
  assert.deepEqual(report.rateLimit, { requestNumber: 1, retryAfter: "seconds", retryAfterS: 30 });
  assert.deepEqual([calls.length, sleeps], [1, []]);
  assert.equal(report.capabilities.athlete_list_fields.reason, "rate_limited");
  // The other runs keep exchange_failed for the same answer.
  const other = fakeServer(happyRoutes({ "POST /api-token-auth/": answer(429, {}, { "retry-after": "30" }) }));
  assert.equal((await run(other.fetchImpl)).stoppedBy, "exchange_failed");
});

test("AL12 a list value the adapter would not accept (a long or multi-line text, a non-canonical track) is never `same`, even when both reads carry it", async () => {
  for (const [field, value] of [["total_time", "x".repeat(65)], ["max_v", "7.75\n"], ["track", "0123"], ["is_stats_valid", { ok: true }]]) {
    const rows = Object.fromEntries(Object.entries(AL_ROWS).map(([sid, list]) => [sid, list.map((r) => ({ ...r, [field]: value }))]));
    const { fetchImpl } = fakeServer(athleteListRoutes({ rows }));
    const v = (await alRun(fetchImpl)).report.capabilities.athlete_list_fields;
    assert.equal(v.allProjectedEqual, true, field);
    assert.deepEqual([v.verdict, v.reason, v.fields[field].projectableAll], ["not_observed", "value_shape_not_projectable", false], field);
  }
  assert.equal(projectableValue("track", 70001), true);
  assert.equal(projectableValue("track", null), true);
  assert.equal(projectableValue("total_distance", 5000.25), true);
  assert.equal(projectableValue("total_distance", Infinity), false);
});

test("AL13 a list total is printed only as a bounded whole number; an unreadable one is null and the page is not judged complete", async () => {
  const routes = athleteListRoutes();
  routes["GET /rest/v1/athlete_session/?teamsession=100&limit=100"] = answer(200, AL_ROWS[100], { "x-total-count": "1e300" });
  const { report } = await alRun(fakeServer(routes).fetchImpl);
  const s100 = report.capabilities.athlete_list_fields.sessions[0];
  assert.deepEqual([s100.listTotal, s100.pageComplete, s100.rowsMatchOnePerAthleteAndDrill], [null, false, null]);
});

test("AL14 a count header on the exchange's answer is printed only as a bounded whole number", async () => {
  const exchange = (init) => { const a = happyRoutes()[AL_EXCHANGE](init); a.headers.set("x-total-count", "MARKER-free-text"); return a; };
  const { report } = await alRun(fakeServer(athleteListRoutes({ over: { [AL_EXCHANGE]: exchange } })).fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.equal(report.requests[0].totalCount, "<unprintable>");
  assert.ok(!JSON.stringify(report).includes("MARKER-free-text"));
  assert.deepEqual(athleteListFilterDescribed({ totalCount: "308" }), { totalCount: "308" });
});

test("AL15 a compared row that differs is `differs` even when the page held one parent: the difference is already the answer", async () => {
  const sessions = [sess(300, 980, DAY, [301]), sess(301, 980, DAY, [])];
  const rows = { 300: AL_ROWS[300].map((r) => (r.id === 9003 ? { ...r, max_v: 8.5 } : r)) };
  const { report } = await alRun(fakeServer(athleteListRoutes({ sessions, rows, detail: (r) => ({ ...(r.id === 9003 ? AL_ROWS[300][2] : r) }) })).fetchImpl);
  const v = report.capabilities.athlete_list_fields;
  assert.deepEqual([v.verdict, v.reason, v.sessionsCompared, v.fields.max_v.equalAll], ["differs", undefined, 1, false]);
});
