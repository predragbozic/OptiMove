// Contract tests of the owner-run rest_v1 capability probe (F3c2b). Fake
// fetch only: no network, no database, no environment secret. Every value
// below that looks like a secret or a person is a marker made up here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerWithContent, canonical, dayOf, maskProbePath, printableFieldNames, describeDrillAnswer, describeDrillEntries, DRILL_MODE_MAX_REQUESTS, DRILL_POSITIONS, LEGACY_API_PATH, LEGACY_API_PREFIX, MAX_EXCHANGE_BYTES, MAX_REQUESTS, parseArgs, parseTotal, PROBE_HOST, PROBE_MODES, PROBE_TEAM, runCapabilityProbe, safeId,
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
  assert.deepEqual([...PROBE_MODES], ["full", "drill"]);
  for (const bad of [["--mode", "drills"], ["--mode", ""], ["--mode", "FULL"]]) assert.throws(() => parseArgs(bad), DiscoveryUsageError, bad.join(" "));
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
  assert.match(source, /for \(const position of DRILL_POSITIONS\)/);
  assert.match(source, /DRILL_POSITIONS = Object\.freeze\(\[0, 1\]\)/);
  assert.doesNotMatch(source, /getLegacy\(`[^`]*details\/`\)/, "no legacy details read without a drill position");
  assert.equal((source.match(/read\(LEGACY_API_PREFIX,/g) || []).length, 1, "the legacy prefix is used in one place");
  assert.doesNotMatch(source, /\$\{[^}]*\bdrills?\b[^}]*\}|\$\{(drillIds|drillId|firstDrill)[^}]*\}/, "no drills entry in any path");
  assert.match(source, /if \(mode !== "drill" \|\| !LEGACY_API_PATH\.test\(resourcePath\)\) throw new ProbeStop\("path_refused"/, "the legacy closure refuses outside the drill-only run");
  // Every template path names only confirmed ids, the team, a day or a window.
  for (const m of source.matchAll(/(?:get|getLegacy)\(`([^`]*)`\)/g)) {
    for (const v of m[1].matchAll(/\$\{([^}]*)\}/g)) assert.ok(["parentId", "sessionId", "athleteId", "trackId", "team", "day", "window", "LIST_LIMIT", "position"].includes(v[1].trim()), `${m[1]}: ${v[1]}`);
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
// The importer's known `api` details shape: `players` keyed by the GPEXE athlete id (gpexeImportMapper.js),
// and, as the owner-run answer showed, `team` and `teamsession` at the top level.
const PLAYERS_0 = { 4711: { athlete_name: MARKERS.athleteName, tot_burst_events: 4, total_distance: 1200.25, zones: { z1: 3 } } };
const PLAYERS_1 = { 4711: { athlete_name: MARKERS.athleteName, tot_burst_events: 2, total_distance: 640.5, zones: { z1: 1 } } };
const legacyDrill = (players, extra = {}) => ({ drills_count: 2, players, team: 980, teamsession: 100, ...extra });
function drillRoutes(over = {}) {
  return {
    ...happyRoutes(),
    "GET /rest/v1/team_session/100/": answer(200, { id: 100, team: 980, drills_count: 2, start_timestamp: `${DAY}T10:00:00` }),
    "GET /rest/v1/team_session/101/": answer(200, { id: 777, team: 980, drill: null, drills_count: 0 }),
    "GET /rest/v1/team_session/100/details/?drill=0": answer(200, legacyDrill(PLAYERS_0)),
    "GET /api/team_session/100/": answer(200, { id: 100, team: 980, drills_count: 2, name: MARKERS.sessionName }),
    "GET /api/team_session/101/": answer(200, { id: 101, team: 980 }),
    "GET /api/team_session/100/details/": answer(200, legacyDrill(PLAYERS_0)),
    "GET /api/team_session/100/details/?drill=0": answer(200, legacyDrill(PLAYERS_0)),
    "GET /api/team_session/100/details/?drill=1": answer(200, legacyDrill(PLAYERS_1)),
    ...over,
  };
}
const drillRun = (fetchImpl, over = {}) => runCapabilityProbe({ mode: "drill", ...over }, ENV, fetchImpl);
const paths = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);
const D0 = "GET /api/team_session/100/details/?drill=0";
const D1 = "GET /api/team_session/100/details/?drill=1";

test("12. the drill-only run: one exchange and exactly five reads - the REST parent with two drills, the same parent through the legacy family, the legacy drill reads at positions 0 and 1 - both answers name team 980 and the parent, and only `players` is compared, in memory", async () => {
  const { calls, fetchImpl } = fakeServer(drillRoutes());
  const report = await drillRun(fetchImpl);
  assert.equal(report.mode, "drill");
  assert.equal(report.stoppedBy, null);
  assert.equal(report.requestCount, 6);
  assert.equal(DRILL_MODE_MAX_REQUESTS, 6);
  assert.deepEqual([...DRILL_POSITIONS], [0, 1]);
  assert.deepEqual(paths(calls), [
    "POST /api-token-auth/",
    "GET /rest/v1/team_session/?team=980&limit=100",
    "GET /rest/v1/team_session/100/",
    "GET /api/team_session/100/",
    D0,
    D1,
  ]);
  const base = new URL(calls[0].url).origin;
  assert.ok(calls.every((c) => new URL(c.url).origin === base), "one host");
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.headers.Authorization === `Token ${ISSUED}` && c.redirect === "manual"));
  assert.ok(!calls.some((c) => /\/101\/|\/102\/|rest\/v1\/team_session\/100\/details|api\/team_session\/100\/details\/$|athlete_session|track|thresholds|team_session_tag|start_timestamp_gte/.test(c.url)),
    "no drills entry as an id, no REST drill read, no legacy details read without a position, nothing of the full run");
  assert.deepEqual(verdicts(report), { session_list: "proven", session_read: "same", legacy_api_session_read: "observed", session_drill_details: "same" });
  assert.deepEqual(report.capabilities.session_read, { verdict: "same", status: 200, idMatchesList: true, teamIs980: true, drillsCountPresent: true, drillsCountPositive: true, drillsCountAtLeastTwo: true, startTimestampPresent: true, drillsListPresent: false, parentConfirmed: true });
  assert.deepEqual(report.capabilities.legacy_api_session_read, { verdict: "observed", family: "api", status: 200, idMatchesParent: true, teamIs980: true, drillsCountPositive: true, parentConfirmed: true });
  const answerShape = {
    status: 200, teamIs980: true, namesParent: true, playersPresent: true,
    bodyKind: "object", hasContent: true, rowsAtTopLevel: false, playersField: true, playersContainerKind: "map", playerRowsPresent: true, playerRowsAreObjects: true,
    playerRowsHaveNumbers: true, playerRowsHaveNestedValues: true, metricFieldPresent: false,
  };
  assert.deepEqual(report.capabilities.session_drill_details, { verdict: "same", family: "api", positionsRead: 2, parameterApplied: true, drill0: answerShape, drill1: answerShape });
  assert.deepEqual(report.requests.map((r) => r.path), ["api-token-auth/", "rest/v1/team_session/?team=<team>&limit=<n>", "rest/v1/team_session/<id>/", "api/team_session/<id>/", "api/team_session/<id>/details/?drill=0", "api/team_session/<id>/details/?drill=1"]);
  for (const i of [4, 5]) assert.deepEqual(report.requests[i].fieldNames, ["drills_count", "players", "team", "teamsession"]);
  // Helper facts from the list page: types and booleans only.
  const list = report.capabilities.session_list;
  assert.equal(list.drillsEntryKind, "number");
  assert.equal(list.listRowMatchesFirstDrill, true, "the fake list carries the row the first entry names");
  assert.equal(list.rowsHaveSingularDrillField, false);
  assert.equal(list.rowsWithNonNullSingularDrill, null);
  // Nothing of either answer leaves the run: no key of the players map, no value, no name, no id.
  const text = JSON.stringify({ ...report, ranAt: "" });
  for (const m of [...Object.values(MARKERS).map(String), ISSUED, USER, PASSWORD, DAY, "09-14", "777", "1200.25", "640.5", "total_distance", "tot_burst_events", "4711", "z1"]) assert.ok(!text.includes(m), m);
  const stripped = text.replace(/"(status|rowCount|distinctDays|positionsRead)":\d+/g, "").replace(/"teamId":"980"/, "");
  for (const id of ["100", "101"]) assert.ok(!new RegExp(`"[^"]*\\b${id}\\b`).test(stripped), `no id ${id}`);

  // Identical `players` at both positions: the parameter's effect cannot be told apart.
  for (const second of [legacyDrill(PLAYERS_0), legacyDrill({ ...PLAYERS_0 }, { drills_count: 3, extra: "differs outside players" })]) {
    const f = fakeServer(drillRoutes({ [D1]: answer(200, second) }));
    const r = await drillRun(f.fetchImpl);
    assert.equal(r.stoppedBy, null);
    assert.equal(f.calls.length, 6);
    const d = r.capabilities.session_drill_details;
    assert.equal(d.verdict, "not_observed");
    assert.equal(d.reason, "parameter_effect_not_distinguishable");
    assert.equal(d.parameterApplied, false);
  }
  // The key order of the map does not make two maps differ; a different key set does.
  const reordered = { b: { x: 1, y: 2 }, a: { y: 2, x: 1 } };
  const ordered = { a: { x: 1, y: 2 }, b: { x: 1, y: 2 } };
  const ro = await drillRun(fakeServer(drillRoutes({ [D0]: answer(200, legacyDrill(ordered)), [D1]: answer(200, legacyDrill(reordered)) })).fetchImpl);
  assert.equal(ro.capabilities.session_drill_details.reason, "parameter_effect_not_distinguishable");
  const otherKeys = await drillRun(fakeServer(drillRoutes({ [D1]: answer(200, legacyDrill({ 4712: { tot_burst_events: 4 } })) })).fetchImpl);
  assert.equal(otherKeys.capabilities.session_drill_details.verdict, "same");
  for (const r of [ro, otherKeys]) assert.ok(!["mapped", "missing"].includes(r.capabilities.session_drill_details.verdict));

  // The parent: only a list row with an explicit `drills` list of at least two entries.
  const oneDrillFirst = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(300, 980, DAY, [301]), sess(100, 980, DAY, [101, 102])], { "x-total-count": "2" }) }));
  const of = await drillRun(oneDrillFirst.fetchImpl);
  assert.equal(of.stoppedBy, null);
  assert.ok(!oneDrillFirst.calls.some((c) => c.url.includes("/300/")), "a one-drill parent is never chosen");
  assert.deepEqual(paths(oneDrillFirst.calls).slice(2, 4), ["GET /rest/v1/team_session/100/", "GET /api/team_session/100/"]);
  const oneDrillOnly = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(300, 980, DAY, [301]), sess(100, 980, DAY, [101]), sess(200, 980, OTHER_DAY, [])], { "x-total-count": "3" }) }));
  const oo = await drillRun(oneDrillOnly.fetchImpl);
  assert.equal(oo.stoppedBy, "no_parent_with_drills_in_list");
  assert.equal(oneDrillOnly.calls.length, 2);
  assert.ok(!oneDrillOnly.calls.some((c) => c.url.includes("/api/team_session")), "no legacy request");
  assert.deepEqual(oo.capabilities.session_drill_details, { verdict: "not_observed", reason: "no_parent_with_drills_in_list" });
  // A drill-like row with a positive count but no `drills` list stands before the real parent.
  const dLike = fakeServer(drillRoutes({
    "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [{ id: 101, team: 980, drills_count: 2, drill: 0 }, sess(100, 980, DAY, [101, 102])], { "x-total-count": "2" }),
    "GET /rest/v1/team_session/101/": answer(200, { id: 101, team: 980, drills_count: 2 }),
    "GET /api/team_session/101/details/?drill=0": answer(200, legacyDrill(PLAYERS_0, { teamsession: 101 })),
    "GET /api/team_session/101/details/?drill=1": answer(200, legacyDrill(PLAYERS_1, { teamsession: 101 })),
  }));
  const dl = await drillRun(dLike.fetchImpl);
  assert.equal(dl.stoppedBy, null);
  assert.deepEqual(paths(dLike.calls).slice(2), ["GET /rest/v1/team_session/100/", "GET /api/team_session/100/", D0, D1]);
  assert.ok(!dLike.calls.some((c) => c.url.includes("/101/")), "the count-only row is never read");
  // Only count-only rows: no parent, no legacy request, nothing after the list.
  const countOnly = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [{ id: 300, team: 980, drills_count: 0 }, { id: 100, team: 980, drills_count: 3 }, { id: 101, team: 980, drills_count: 2, drills: [] }], { "x-total-count": "3" }) }));
  const co = await drillRun(countOnly.fetchImpl);
  assert.equal(co.stoppedBy, "no_parent_with_drills_in_list");
  assert.equal(countOnly.calls.length, 2);
  assert.ok(!countOnly.calls.some((c) => c.url.includes("/api/team_session")), "no legacy request");
  // The helper facts on their own.
  assert.deepEqual(describeDrillEntries([{ id: 1, drills: [2] }, { id: 2, drills: [] }], { id: 1, drills: [2] }), { drillsEntryKind: "number", listRowMatchesFirstDrill: true, rowsHaveSingularDrillField: false, rowsWithNonNullSingularDrill: null });
  assert.deepEqual(describeDrillEntries([{ id: 1, drills: [{ id: 2 }], drill: null }, { id: 2, drills: [], drill: 1 }], { id: 1, drills: [{ id: 2 }] }), { drillsEntryKind: "object", listRowMatchesFirstDrill: null, rowsHaveSingularDrillField: true, rowsWithNonNullSingularDrill: true });
  const selfRow = { id: 1, drills: [1] };
  assert.equal(describeDrillEntries([selfRow], selfRow).listRowMatchesFirstDrill, false, "the parent itself is not another row");
});

test("13. the drill reads: each answer must name team 980 and the parent at its top level before the next read; absence, an unreadable shape or a mismatch is not_observed or an isolation stop; never mapped or missing", async () => {
  const P = { players: PLAYERS_0 };
  const cases = [
    // [route, answer, stop, requests sent]
    [D0, answer(404, { detail: "Not found." }), "drill_not_200", 5],
    [D0, answer(500, ""), "drill_not_200", 5],
    [D0, answer(200, ""), "drill_answer_unreadable", 5],
    [D0, answer(200, "<html>interstitial</html>"), "drill_answer_unreadable", 5],
    [D0, answer(200, "42"), "drill_answer_unreadable", 5],
    [D0, answer(200, "null"), "drill_answer_unreadable", 5],
    [D0, answer(200, []), "drill_answer_empty", 5],
    [D0, answer(200, {}), "drill_answer_empty", 5],
    [D0, answer(200, [legacyDrill(PLAYERS_0)]), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, P), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, { ...P, team: 980 }), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, { ...P, teamsession: 100 }), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, { ...P, team: 980, teamsession: "x" }), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, { ...P, team: 980, teamsession: { id: 100 } }), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, legacyDrill(PLAYERS_0, { teamsession: 150 })), "drill_parent_mismatch", 5],
    [D0, answer(200, legacyDrill(PLAYERS_0, { team: 981 })), "team_isolation_failed", 5],
    [D0, answer(200, legacyDrill(PLAYERS_0, { team: { id: 980 } })), "team_unknown_shape", 5],
    [D0, answer(200, { team: 980, teamsession: 100 }), "drill_players_missing", 5],
    [D0, answer(200, legacyDrill({})), "drill_players_missing", 5],
    [D0, answer(200, { 4711: { tot_burst_events: 4 }, [MARKERS.athleteName]: { total_distance: 1 } }), "drill_answer_identity_unconfirmed", 5],
    [D0, answer(200, { results: [{ 4711: { tot_burst_events: 4 } }] }), "drill_answer_identity_unconfirmed", 5],
    // The second position is held to the same rules.
    [D1, answer(404, { detail: "Not found." }), "drill_not_200", 6],
    [D1, answer(200, legacyDrill(PLAYERS_1, { teamsession: 150 })), "drill_parent_mismatch", 6],
    [D1, answer(200, legacyDrill(PLAYERS_1, { team: 981 })), "team_isolation_failed", 6],
    [D1, answer(200, legacyDrill(PLAYERS_1, { team: undefined })), "drill_answer_identity_unconfirmed", 6],
    [D1, answer(200, { team: 980, teamsession: 100 }), "drill_players_missing", 6],
  ];
  for (const [route, resp, stop, n] of cases) {
    const f = fakeServer(drillRoutes({ [route]: resp }));
    const r = await drillRun(f.fetchImpl);
    const d = r.capabilities.session_drill_details;
    assert.equal(r.stoppedBy, stop, `${route} ${stop}`);
    assert.equal(f.calls.length, n, `${route} ${stop}: no request after the failed step`);
    if (route === D0) assert.ok(!f.calls.some((c) => c.url.includes("drill=1")), `${stop}: no second drill read`);
    assert.equal(d.verdict, "not_observed", stop);
    assert.equal(d.reason, stop);
    assert.ok(!["same", "mapped", "missing"].includes(d.verdict));
    const text = JSON.stringify({ ...r, ranAt: "" });
    for (const leak of ["150", "981", "4711", MARKERS.athleteName, "tot_burst_events", "1200.25"]) assert.ok(!text.includes(leak), `${stop}: ${leak}`);
  }
  // A body wrapped in `results` and keyed by ids prints none of those keys.
  const wrapped = await drillRun(fakeServer(drillRoutes({ [D0]: answer(200, { results: [{ 4711: { tot_burst_events: 4 } }] }) })).fetchImpl);
  assert.equal(wrapped.requests[4].resultFieldNames, "<unprintable>");
  assert.deepEqual(wrapped.requests[4].fieldNames, ["results"]);
});

test("14. the drill-only run stops before any drill read at the first parent identity or team that is not confirmed - by REST or by the legacy family - and every stop names the drill verdict", async () => {
  const noDrill = (calls) => !calls.some((c) => c.url.includes("drill="));
  const cases = [
    // The REST parent.
    ["GET /rest/v1/team_session/100/", answer(200, { id: 150, team: 980, drills_count: 2 }), "parent_id_mismatch", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 981, drills_count: 2 }), "team_isolation_failed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: { id: 980 }, drills_count: 2 }), "team_unknown_shape", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 980 }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 980, drills_count: 0 }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, { id: 100, team: 980, drills_count: 1 }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(404, { detail: "Not found." }), "parent_not_confirmed", 3],
    ["GET /rest/v1/team_session/100/", answer(200, [{ id: 100, team: 980, drills_count: 2 }]), "parent_not_confirmed", 3],
    // The same parent through the legacy family.
    ["GET /api/team_session/100/", answer(200, { id: 150, team: 980 }), "legacy_parent_id_mismatch", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100, team: 981 }), "team_isolation_failed", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100, team: "https://server3.gpexe.com/api/team/980/" }), "team_unknown_shape", 4],
    ["GET /api/team_session/100/", answer(200, { id: 100 }), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(200, { team: 980 }), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(404, { detail: "Not found." }), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(200, ""), "legacy_parent_not_confirmed", 4],
    ["GET /api/team_session/100/", answer(200, [{ id: 100, team: 980 }]), "legacy_parent_not_confirmed", 4],
  ];
  for (const [route, resp, stop, n] of cases) {
    const f = fakeServer(drillRoutes({ [route]: resp }));
    const r = await drillRun(f.fetchImpl);
    assert.equal(r.stoppedBy, stop, `${route} ${stop}`);
    assert.equal(f.calls.length, n, `${route} ${stop}: no request after the failed step`);
    assert.ok(noDrill(f.calls), `${route} ${stop}: no drill read`);
    if (n === 3) assert.ok(!f.calls.some((c) => c.url.includes("/api/team_session")), "no legacy read after a REST stop");
    assert.deepEqual(r.capabilities.session_drill_details, { verdict: "not_observed", reason: stop });
    // ranAt is the run's own clock (its milliseconds can hold any digits); everything else must not.
    const text = JSON.stringify({ ...r, ranAt: "" });
    for (const leak of ["150", "981", MARKERS.sessionName]) assert.ok(!text.includes(leak), `${stop}: ${leak}`);
  }
  // No parent in the list: the run stops after the list.
  const noParent = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, []), sess(200, 980, OTHER_DAY, [])], { "x-total-count": "2" }) }));
  const c = await drillRun(noParent.fetchImpl);
  assert.equal(c.stoppedBy, "no_parent_with_drills_in_list");
  assert.equal(noParent.calls.length, 2);
  assert.deepEqual(c.capabilities.session_drill_details, { verdict: "not_observed", reason: "no_parent_with_drills_in_list" });
  // A row without a readable team is never the parent.
  const teamless = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [{ id: 100, drills: [101, 102], drills_count: 2 }], { "x-total-count": "1" }) }));
  const tl = await drillRun(teamless.fetchImpl);
  assert.equal(tl.stoppedBy, "no_parent_with_drills_in_list");
  assert.equal(teamless.calls.length, 2);
  // A foreign row in the list stops it before anything else, as in the full run.
  const foreign = fakeServer(drillRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [sess(100, 980, DAY, [101, 102]), sess(300, 981, DAY, [])], { "x-total-count": "2" }) }));
  const d = await drillRun(foreign.fetchImpl);
  assert.equal(d.stoppedBy, "team_isolation_failed");
  assert.equal(foreign.calls.length, 2);
  assert.deepEqual(d.capabilities.session_drill_details, { verdict: "not_observed", reason: "team_isolation_failed" });
  // Every stop before the drill branch names the drill verdict too (one exit for the whole run).
  for (const [over, stop, n] of [
    [{ "GET /rest/v1/team_session/?team=980&limit=100": answer(500, "") }, "session_list_unavailable", 2],
    [{ "POST /api-token-auth/": answer(400, { non_field_errors: ["refused"] }) }, "exchange_failed", 1],
    [{ "GET /rest/v1/team_session/?team=980&limit=100": answer(200, [{ team: 980, drills: [] }], { "x-total-count": "1" }) }, "no_safe_session_id", 2],
  ]) {
    const fs = fakeServer(drillRoutes(over));
    const rr = await drillRun(fs.fetchImpl);
    assert.equal(rr.stoppedBy, stop);
    assert.equal(fs.calls.length, n, stop);
    assert.deepEqual(rr.capabilities.session_drill_details, { verdict: "not_observed", reason: stop });
  }
  // Full mode is not touched by that exit: a stopped full run carries no drill key it did not compute.
  const fullStop = fakeServer(happyRoutes({ "GET /rest/v1/team_session/?team=980&limit=100": answer(500, "") }));
  const fr = await runCapabilityProbe({}, ENV, fullStop.fetchImpl);
  assert.equal(fr.stoppedBy, "session_list_unavailable");
  assert.equal(fr.capabilities.session_drill_details, undefined);
  // The cap: never more than six requests, whatever maxRequests says.
  const capped = fakeServer(drillRoutes());
  const e = await drillRun(capped.fetchImpl, { maxRequests: 14 });
  assert.equal(capped.calls.length, 6);
  assert.equal(e.stoppedBy, null);
  const tight = fakeServer(drillRoutes());
  const g = await drillRun(tight.fetchImpl, { maxRequests: 4 });
  assert.equal(g.stoppedBy, "request_limit");
  assert.equal(tight.calls.length, 4);
  assert.ok(noDrill(tight.calls));
  assert.deepEqual(g.capabilities.session_drill_details, { verdict: "not_observed", reason: "request_limit" });
  // A cap that allows the first drill read only: the second is never sent, and nothing is compared.
  const five = fakeServer(drillRoutes());
  const h = await drillRun(five.fetchImpl, { maxRequests: 5 });
  assert.equal(h.stoppedBy, "request_limit");
  assert.equal(five.calls.length, 5);
  assert.ok(!five.calls.some((x) => x.url.includes("drill=1")));
  assert.deepEqual(h.capabilities.session_drill_details, { verdict: "not_observed", reason: "request_limit" });
});
