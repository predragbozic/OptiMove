// The details-coverage probe (owner order 2026-10-23, docs/ai/gpexe-details-coverage-plan.md) against
// a fake server3 only: no test sends a request to GPEXE, and no real credential exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bandStatus, detailsReadiness, drillLevelVerdict, LEGACY_DRILL_PATH, DETAILS_COVERAGE_ATHLETES, DETAILS_COVERAGE_MAX_REQUESTS, DETAILS_COVERAGE_PAUSE_MS, DETAILS_EVENT_FIELDS, DETAILS_ROW_SCALARS,
  DETAILS_ZONE_PREFIX, detailsValue, IMPORTED_MORE_RULES, IMPORTED_ROW_SCALARS, overallVerdict, parseArgs, PRINTABLE_KEYS, retryAfterOf,
  runDetailsCoverageProbe, scalarRelation, zoneFamilyVerdict,
} from "../scripts/gpexe-details-coverage-probe.mjs";
import { DiscoveryUsageError } from "../scripts/gpexe-auth-discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER = "fake.user@example.invalid";
const PASSWORD = "Fake-Password-not-real-42";
const ISSUED = "FAKE-ISSUED-TOKEN-fedcba9876543210-not-real";
const ENV = { GPEXE_USERNAME: USER, GPEXE_PASSWORD: PASSWORD };
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
function answer(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: new Headers({ ...json, ...headers }), json: async () => JSON.parse(text), get body() { return streamOf([bytesOf(text)]); } };
}
function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect, signal: init.signal });
    const u = new URL(url);
    const route = routes[`${init.method} ${u.pathname}${u.search}`];
    if (route === undefined) return answer(404, { detail: "Not found." });
    return typeof route === "function" ? route(init, u) : route;
  };
  return { calls, fetchImpl };
}
const paths = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

// Fixtures: parent 100 of team 980 with two drills (101, 102), a second parent 300; two athletes, one
// row each for the whole session and for each drill. Power and speed zones follow the team thresholds;
// the details number its zones from one, as the hypothesis under test.
const MARK = { first: "Marker First", last: "Marker Last", athleteName: "Marker Athlete Name", session: "Marker Session Name", note: "marker private note" };
const DAY = "2026-09-14";
const POWER_T = [10, 20, 25, 60, 75];
const SPEED_T = [2, 4, 5.5, 7];
const zonesOf = (t) => [[0, t[0]], ...t.slice(0, -1).map((lo, i) => [lo, t[i + 1]]), [t[t.length - 1], null]];
const zoneDist = (rowId, family, pos) => (family === "power" ? 1000 : 2000) + pos * 111 + (rowId % 5) + 0.3125; // .3125 never occurs in an ISO time, so the leak check cannot meet ranAt
const acc = (rowId) => (rowId % 9) + 3;
const dec = (rowId) => (rowId % 7) + 2;
const sess = (id, drills, extra = {}) => ({ id, team: 980, name: MARK.session, notes: MARK.note, start_timestamp: `${DAY}T10:00:00`, drills, drills_count: drills.length, category_name: "FULL TRAINING", is_stats_valid: true, ...extra });
const row = (id, athlete, drill, extra = {}) => ({ id, athlete, track: 70000 + athlete, teamsession: 100, drill, is_stats_valid: true, total_time: 3000 + id, total_distance: 5000.5 + id, max_v: 7.75 + (id % 3), athlete_name: MARK.athleteName, ...extra });
const ROWS = [row(8001, 4711, null), row(8002, 4712, null), row(8003, 4711, 0), row(8004, 4712, 0), row(8005, 4711, 1), row(8006, 4712, 1)];
const moreOf = (r, over = {}) => ({
  athletesession_id: r.id, athlete_name: MARK.athleteName,
  events: { acceleration_events_count: acc(r.id), acceleration_events_threshold_value: 2.5, acceleration_events_duration: 0.3, deceleration_events_count: dec(r.id), deceleration_events_threshold_value: -2.5, deceleration_events_duration: 0.3, ...over.events },
  complementary_data: {
    power: zonesOf(POWER_T).map((extremes, pos) => ({ extremes, distance: zoneDist(r.id, "power", pos), is_ready: true })),
    speed: zonesOf(SPEED_T).map((extremes, pos) => ({ extremes, distance: zoneDist(r.id, "speed", pos), is_ready: true })),
    ...over.complementary_data,
  },
});
function playerOf(r, { base = 1, ready = true, over = {} } = {}) {
  const p = {
    athlete: { first_name: MARK.first, last_name: MARK.last }, athlete_role: "MF",
    acceleration_events: { unit: "number", value: acc(r.id) }, deceleration_events: { unit: "number", value: dec(r.id) },
    tot_burst_events: { unit: "number", value: 4 }, tot_brake_events: { unit: "number", value: 5 },
    average_time: { unit: "s", value: r.total_time }, total_distance: { unit: "m", value: r.total_distance }, max_values_speed: { unit: "m/s", value: r.max_v },
  };
  const zone = (value) => (ready === null ? { unit: "m", value } : { unit: "m", value, is_ready: ready });
  zonesOf(POWER_T).forEach((_, pos) => { p[`athletesessionpowerzone_distance_${pos + base}`] = zone(zoneDist(r.id, "power", pos)); });
  zonesOf(SPEED_T).forEach((_, pos) => { p[`athletesessionspeedzone_distance_${pos + base}`] = zone(zoneDist(r.id, "speed", pos)); });
  return { ...p, ...over };
}
const detailsOf = (rows, teamsession, player = (r) => playerOf(r)) => ({ teamsession, drills_count: 2, team: { total_distance: { unit: "m", value: 1 } }, players: Object.fromEntries(rows.map((r) => [String(r.athlete), player(r)])) });
const THRESHOLDS = { id: 55, team: 980, validity_start: `${DAY}T00:00:00`, validity_end: null, power_thresholds: POWER_T, speed_thresholds: SPEED_T, acceleration_events_threshold: 2.5, acceleration_events_duration: 0.3, deceleration_events_threshold: -2.5, deceleration_events_duration: 0.3 };
const K = {
  exchange: "POST /api-token-auth/",
  list: "GET /rest/v1/team_session/?team=980&limit=100",
  parent: "GET /rest/v1/team_session/100/",
  athletes: "GET /rest/v1/athlete_session/?teamsession=100&limit=100",
  whole: "GET /rest/v1/team_session/100/details/",
  drill: "GET /rest/v1/team_session/100/details/?drill=0",
  thresholds: `GET /rest/v1/team/980/thresholds/?valid_on=${DAY}`,
  more: (id) => `GET /rest/v1/athlete_session/${id}/more/`,
  legacyDrill: "GET /api/team_session/100/details/?drill=0",
};
function routesOf({ rows = ROWS, more = (r) => moreOf(r), player, base = 1, ready = true, over = {} } = {}) {
  const pl = player ?? ((r) => playerOf(r, { base, ready }));
  const routes = {
    [K.exchange]: answer(200, { token: ISSUED }),
    [K.list]: answer(200, [sess(100, [101, 102]), sess(101, []), sess(102, []), sess(300, [301]), sess(301, [])], { "x-total-count": "5" }),
    [K.parent]: answer(200, sess(100, [101, 102])),
    [K.athletes]: answer(200, rows, { "x-total-count": String(rows.length) }),
    [K.whole]: answer(200, detailsOf(rows.filter((r) => r.drill === null), 100, pl)),
    [K.drill]: answer(200, detailsOf(rows.filter((r) => r.drill === 0), 101, pl)),
    [K.thresholds]: answer(200, THRESHOLDS),
  };
  for (const r of rows) routes[K.more(r.id)] = answer(200, more(r));
  return { ...routes, ...over };
}
const dcRun = (fetchImpl, over = {}) => {
  const sleeps = [];
  return runDetailsCoverageProbe({ sleep: async (ms) => { sleeps.push(ms); }, ...over }, ENV, fetchImpl).then((report) => ({ report, sleeps }));
};
const ORDER = [K.exchange, K.list, K.parent, K.athletes, K.whole, K.drill, K.thresholds, K.more(8001), K.more(8003), K.more(8002), K.more(8004)];
const noLeak = (report) => {
  const text = JSON.stringify(report);
  for (const leak of [USER, PASSWORD, ISSUED, "Marker", "marker", "4711", "4712", "8001", "8004", ".3125", "11001", "13001.5", DAY, "MF"]) assert.ok(!text.includes(leak), `the report never carries ${leak}`);
};
const cov = (report) => report.coverage;

test("DC1 the planned run: one exchange, then ten GETs in a fixed order with a 2 s pause before every read; every family `same`; nothing but words, counts and booleans", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf());
  const { report, sleeps } = await dcRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), ORDER);
  assert.equal(DETAILS_COVERAGE_MAX_REQUESTS, ORDER.length + 1, "the cap is the plan plus the drill's api/ form, read only when its rest/v1 form fails");
  assert.equal(report.requestCount, 11);
  assert.deepEqual(sleeps, Array(10).fill(DETAILS_COVERAGE_PAUSE_MS), "a pause before every read, none before the exchange");
  assert.equal(DETAILS_COVERAGE_PAUSE_MS, 2000);
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.headers.Authorization === `Token ${ISSUED}` && c.redirect === "manual"));
  assert.equal(calls[0].body, new URLSearchParams({ username: USER, password: PASSWORD }).toString(), "the exchange in the host's confirmed form");
  const c = cov(report);
  assert.equal(c.verdict, "same");
  assert.deepEqual(Object.fromEntries(Object.entries(c.families).map(([k, v]) => [k, v.verdict])), { events: "same", powerZones: "same", speedZones: "same", mapping: "same", drillLevel: "same" });
  assert.deepEqual([c.families.powerZones.indexBase, c.families.speedZones.indexBase], ["one", "one"]);
  assert.equal(c.rowScalars.verdict, "same");
  assert.deepEqual(c.rowScalars.relations, { total_time: ["equal"], total_distance: ["equal"], max_v: ["equal"] });
  assert.deepEqual(c.rowScalars.detailsUnits, { total_time: ["s"], total_distance: ["m"], max_v: ["m/s"] });
  assert.deepEqual(c.pairs.map((p) => [p.athlete, p.level]), [[1, "whole"], [1, "drill"], [2, "whole"], [2, "drill"]]);
  assert.ok(c.pairs.every((p) => p.bands.length === 4 && p.bands.every((b) => b.status === "ok")));
  assert.deepEqual(c.pairs[0].bands.map((b) => `${b.family}:${b.band}`), ["power:25-60", "power:60-75", "power:75-open", "speed:7-open"]);
  assert.ok(c.pairs.every((p) => p.zones.power.boundsFollowThresholds === true && p.zones.power.moreZoneCount === 6 && p.zones.power.detailsZoneCount === 6));
  assert.deepEqual(c.mapping, {
    pageComplete: true, rowsOnPage: 6, rowsNameParent: true, rowIdsUnique: true, wholePlayerKeysCanonical: true, drillPlayerKeysCanonical: true,
    wholePlayersEmpty: false, drillPlayersEmpty: false, wholeMissingInDetails: 0, drillMissingInDetails: 0, wholeExtraInDetails: 0, drillExtraInDetails: 0,
    wholeDetailsNamesParent: true, drillDetailsNamesParent: false, wholeDetailsDrillsCountMatches: true,
  });
  assert.deepEqual(c.thresholds, { eventRuleAsImported: true, accelerationRuleAsImported: true, decelerationRuleAsImported: true, powerThresholdsReadable: true, speedThresholdsReadable: true });
  assert.deepEqual(c.readiness, { parentStatsValid: true, detailsHasReadinessKey: false, detailsHasThresholdLikeKey: false, rowsWithStatsNotValid: 0, zonesNotReady: 0 });
  assert.deepEqual(c.selection, { listRows: 5, parentCandidates: 1, repeatedParentIds: 0, parentDrills: 2, drillForm: "rest_v1" });
  assert.ok(c.pairs.every((p) => Object.values(p.zones).every((f) => f.zones.every((z) => z.moreReady === true && z.detailsReady1 === true && z.readinessLevel1 === "zone" && z.detailsKind1 === "number" && z.detailsUnit1 === "m"))));
  noLeak(report);
});

test("DC2 what is compared comes from the importer itself; the details' names are the old script's hypotheses", () => {
  assert.deepEqual(IMPORTED_MORE_RULES.events.map((e) => [e.metric, e.threshold, e.duration]), [["acceleration", 2.5, 0.3], ["deceleration", -2.5, 0.3]]);
  assert.deepEqual(IMPORTED_MORE_RULES.zones.map((z) => [z.family, z.band, z.thresholdField]), [["power", [25, 60], "power_thresholds"], ["power", [60, 75], "power_thresholds"], ["power", [75, null], "power_thresholds"], ["speed", [7, null], "speed_thresholds"]]);
  assert.deepEqual([...IMPORTED_ROW_SCALARS], ["total_time", "total_distance", "max_v"]);
  assert.deepEqual(DETAILS_EVENT_FIELDS, { acceleration: "acceleration_events", deceleration: "deceleration_events" });
  assert.deepEqual(DETAILS_ZONE_PREFIX, { power: "athletesessionpowerzone_distance_", speed: "athletesessionspeedzone_distance_" });
  assert.deepEqual(DETAILS_ROW_SCALARS, { total_time: "average_time", total_distance: "total_distance", max_v: "max_values_speed" });
  assert.equal(DETAILS_COVERAGE_ATHLETES, 2);
});

test("DC3 a confirmed difference is `differs` and names only the metric, the level and the athlete's place; a rounding-only difference is still a difference", async () => {
  // The drill's acceleration count of the first athlete differs by one.
  const r1 = await dcRun(fakeServer(routesOf({ player: (r) => playerOf(r, { over: r.id === 8003 ? { acceleration_events: { unit: "number", value: acc(8003) + 1 } } : {} }) })).fetchImpl);
  const c1 = cov(r1.report);
  assert.deepEqual([c1.verdict, c1.families.events.verdict], ["differs", "differs"]);
  assert.deepEqual(c1.pairs.find((p) => p.athlete === 1 && p.level === "drill").events.map((e) => [e.metric, e.status, e.withinRounding]), [["acceleration", "differs", false], ["deceleration", "equal", null]]);
  noLeak(r1.report);
  // A power zone rounded to two decimals in the details: neither numbering reproduces /more/.
  const r2 = await dcRun(fakeServer(routesOf({ player: (r) => playerOf(r, { over: r.id === 8002 ? { athletesessionpowerzone_distance_5: { unit: "m", value: Math.round(zoneDist(8002, "power", 4) * 100) / 100 } } : {} }) })).fetchImpl);
  const c2 = cov(r2.report);
  assert.deepEqual([c2.verdict, c2.families.powerZones.verdict, c2.families.powerZones.reason, c2.families.speedZones.verdict], ["differs", "differs", "no_numbering_reproduces_more", "same"]);
  const zone = c2.pairs.find((p) => p.athlete === 2 && p.level === "whole").zones.power.zones[4];
  assert.deepEqual([zone.base1, zone.withinRounding1], ["differs", true]);
  // Top speed reported in km/h: a consistent conversion, reported, never `same`; it does not decide.
  const r3 = await dcRun(fakeServer(routesOf({ player: (r) => playerOf(r, { over: { max_values_speed: { unit: "km/h", value: r.max_v * 3.6 } } }) })).fetchImpl);
  const c3 = cov(r3.report);
  assert.deepEqual([c3.rowScalars.verdict, c3.rowScalars.reason, c3.rowScalars.relations.max_v, c3.rowScalars.detailsUnits.max_v, c3.verdict], ["insufficient", "consistent_unit_conversion", ["times_3_6"], ["km/h"], "same"]);
  // Time under no fixed relation: a difference of the row scalars, still not deciding.
  const r4 = await dcRun(fakeServer(routesOf({ player: (r) => playerOf(r, { over: { average_time: { unit: "s", value: r.total_time / 2 } } }) })).fetchImpl);
  assert.deepEqual([cov(r4.report).rowScalars.verdict, cov(r4.report).rowScalars.relations.total_time, cov(r4.report).verdict], ["differs", ["other"], "same"]);
});

test("DC4 the zone numbering is found, never assumed: from zero works, all-zero zones or two matching numberings are `insufficient`, a missing key too", async () => {
  const zero = await dcRun(fakeServer(routesOf({ base: 0 })).fetchImpl);
  assert.deepEqual([cov(zero.report).verdict, cov(zero.report).families.powerZones.indexBase, cov(zero.report).families.speedZones.indexBase], ["same", "zero", "zero"]);
  const flat = (r) => moreOf(r, { complementary_data: { power: zonesOf(POWER_T).map((extremes) => ({ extremes, distance: 0, is_ready: true })), speed: zonesOf(SPEED_T).map((extremes) => ({ extremes, distance: 0, is_ready: true })) } });
  const zeros = (r) => playerOf(r, { over: Object.fromEntries([...Array(7).keys()].flatMap((i) => [[`athletesessionpowerzone_distance_${i}`, { unit: "m", value: 0 }], [`athletesessionspeedzone_distance_${i}`, { unit: "m", value: 0 }]])) });
  const amb = await dcRun(fakeServer(routesOf({ more: flat, player: zeros })).fetchImpl);
  assert.deepEqual([cov(amb.report).verdict, cov(amb.report).families.powerZones.verdict, cov(amb.report).families.powerZones.reason, cov(amb.report).families.powerZones.indexBase], ["insufficient", "insufficient", "numbering_ambiguous", "ambiguous"]);
  const missing = await dcRun(fakeServer(routesOf({ player: (r) => { const p = playerOf(r); delete p.athletesessionspeedzone_distance_3; return p; } })).fetchImpl);
  assert.deepEqual([cov(missing.report).families.speedZones.verdict, cov(missing.report).families.speedZones.reason, cov(missing.report).verdict], ["insufficient", "values_missing_or_not_ready", "insufficient"]);
});

test("DC5 the importer's guards stay in force: its event rule in /more/ and in the team thresholds, a split band, a zone not ready", async () => {
  const otherRule = await dcRun(fakeServer(routesOf({ more: (r) => moreOf(r, { events: { acceleration_events_threshold_value: 3 } }) })).fetchImpl);
  assert.deepEqual([cov(otherRule.report).families.events.verdict, cov(otherRule.report).families.events.reason], ["insufficient", "more_rule_not_as_imported"]);
  const team = await dcRun(fakeServer(routesOf({ over: { [K.thresholds]: answer(200, { ...THRESHOLDS, deceleration_events_duration: 0.5 }) } })).fetchImpl);
  assert.deepEqual([cov(team.report).families.events.verdict, cov(team.report).families.events.reason, cov(team.report).thresholds.decelerationRuleAsImported], ["insufficient", "team_event_rule_not_as_imported", false]);
  const split = await dcRun(fakeServer(routesOf({ over: { [K.thresholds]: answer(200, { ...THRESHOLDS, power_thresholds: [10, 20, 25, 50, 60, 75] }) } })).fetchImpl);
  assert.deepEqual([cov(split.report).families.powerZones.verdict, cov(split.report).families.powerZones.reason], ["insufficient", "band_team_threshold_split"]);
  const notReady = (r) => moreOf(r, { complementary_data: { speed: zonesOf(SPEED_T).map((extremes, pos) => ({ extremes, distance: zoneDist(r.id, "speed", pos), is_ready: r.id !== 8004 })) } });
  const nr = await dcRun(fakeServer(routesOf({ more: notReady })).fetchImpl);
  assert.deepEqual([cov(nr.report).families.speedZones.verdict, cov(nr.report).readiness.zonesNotReady], ["insufficient", 5]);
  // Equal zeros prove nothing: every event count zero, or every zone distance zero under the one numbering that fits.
  const noEvents = await dcRun(fakeServer(routesOf({
    more: (r) => moreOf(r, { events: { acceleration_events_count: 0, deceleration_events_count: 0 } }),
    player: (r) => playerOf(r, { over: { acceleration_events: { unit: "number", value: 0 }, deceleration_events: { unit: "number", value: 0 } } }),
  })).fetchImpl);
  assert.deepEqual([cov(noEvents.report).families.events.verdict, cov(noEvents.report).families.events.reason, cov(noEvents.report).verdict], ["insufficient", "only_zero_values", "insufficient"]);
  const flatPower = (r) => moreOf(r, { complementary_data: { power: zonesOf(POWER_T).map((extremes) => ({ extremes, distance: 0, is_ready: true })) } });
  const zeroPower = (r) => playerOf(r, { over: Object.fromEntries(zonesOf(POWER_T).map((_, pos) => [`athletesessionpowerzone_distance_${pos + 1}`, { unit: "m", value: 0 }])) });
  const noZones = await dcRun(fakeServer(routesOf({ more: flatPower, player: zeroPower })).fetchImpl);
  assert.deepEqual([cov(noZones.report).families.powerZones.verdict, cov(noZones.report).families.powerZones.reason, cov(noZones.report).families.powerZones.indexBase], ["insufficient", "only_zero_values", "one"]);
});

test("DC6 the mapping: players that are not the list's athletes, a non-canonical key, or an incomplete page", async () => {
  const lost = await dcRun(fakeServer(routesOf({ over: { [K.whole]: answer(200, detailsOf(ROWS.filter((r) => r.drill === null), 100, (r) => playerOf(r))) } , rows: [...ROWS, row(8007, 4713, null)] })).fetchImpl);
  assert.deepEqual([cov(lost.report).families.mapping.verdict, cov(lost.report).families.mapping.reason, cov(lost.report).mapping.wholeMissingInDetails, cov(lost.report).verdict], ["differs", "players_missing_for_rows", 1, "differs"]);
  // An athlete whose row the importer skips (statistics not valid) need not be in the details.
  const skipped = await dcRun(fakeServer(routesOf({ rows: [...ROWS, row(8008, 4714, null, { is_stats_valid: false })], over: { [K.whole]: answer(200, detailsOf(ROWS.filter((r) => r.drill === null), 100)) } })).fetchImpl);
  assert.deepEqual([cov(skipped.report).families.mapping.verdict, cov(skipped.report).mapping.wholeMissingInDetails, cov(skipped.report).readiness.rowsWithStatsNotValid, cov(skipped.report).verdict], ["same", 0, 1, "same"]);
  const key = await dcRun(fakeServer(routesOf({ over: { [K.drill]: answer(200, { ...detailsOf(ROWS.filter((r) => r.drill === 0), 101), players: { ...detailsOf(ROWS.filter((r) => r.drill === 0), 101).players, "04711": {} } }) } })).fetchImpl);
  assert.deepEqual([cov(key.report).families.mapping.verdict, cov(key.report).families.mapping.reason], ["differs", "player_key_not_canonical"]);
  // An empty players map is a drill not computed yet: never a difference, and nothing to compare.
  const empty = await dcRun(fakeServer(routesOf({ over: { [K.drill]: answer(200, { ...detailsOf([], 101), players: {} }) } })).fetchImpl);
  assert.deepEqual([empty.report.stoppedBy, cov(empty.report).verdict, cov(empty.report).families.mapping.verdict, cov(empty.report).families.mapping.reason], ["no_comparable_athlete", "insufficient", "insufficient", "details_players_empty"]);
  const page = await dcRun(fakeServer(routesOf({ over: { [K.athletes]: answer(200, ROWS, { "x-total-count": "140" }) } })).fetchImpl);
  assert.deepEqual([cov(page.report).families.mapping.verdict, cov(page.report).families.mapping.reason, cov(page.report).mapping.pageComplete], ["insufficient", "athlete_list_page_incomplete", false]);
  // One comparable athlete only: nine requests, never `same`.
  const one = fakeServer(routesOf({ rows: ROWS.map((r) => (r.athlete === 4712 && r.drill === 0 ? { ...r, is_stats_valid: false } : r)) }));
  const r1 = await dcRun(one.fetchImpl);
  assert.equal(one.calls.length, 9);
  assert.deepEqual([cov(r1.report).verdict, cov(r1.report).families.mapping.reason, cov(r1.report).families.events.reason, cov(r1.report).families.drillLevel.reason, cov(r1.report).readiness.rowsWithStatsNotValid], ["insufficient", "fewer_athletes_than_planned", "fewer_pairs_than_planned", "fewer_athletes_than_planned", 1]);
});

test("DC7 the first 429 ends the run without a repeat, the exchange's included: Retry-After as a kind word and bounded seconds, nothing sent after it", async () => {
  for (const [at, headers, expected] of [
    [K.exchange, { "retry-after": "30" }, { requestNumber: 1, retryAfter: "seconds", retryAfterS: 30 }],
    [K.list, { "retry-after": "90000" }, { requestNumber: 2, retryAfter: "seconds", retryAfterS: "over_day" }],
    [K.drill, {}, { requestNumber: 6, retryAfter: "absent", retryAfterS: null }],
    [K.more(8002), { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, { requestNumber: 10, retryAfter: "other", retryAfterS: null }],
  ]) {
    const { calls, fetchImpl } = fakeServer(routesOf({ over: { [at]: answer(429, { detail: "Request was throttled." }, headers) } }));
    const { report, sleeps } = await dcRun(fetchImpl);
    assert.equal(report.stoppedBy, "rate_limited", at);
    assert.deepEqual(report.rateLimit, expected, at);
    assert.equal(calls.length, expected.requestNumber, `${at}: nothing after the 429`);
    assert.equal(paths(calls).filter((p) => p === at).length, 1, `${at}: never repeated`);
    assert.equal(sleeps.length, calls.length - 1);
    assert.deepEqual([cov(report).verdict, cov(report).reason], ["insufficient", "rate_limited"], at);
    noLeak(report);
  }
  // A confirmed difference seen before the stop stays `differs`.
  const { fetchImpl } = fakeServer(routesOf({ player: (r) => playerOf(r, { over: r.id === 8001 ? { deceleration_events: { unit: "number", value: 99 } } : {} }), over: { [K.more(8002)]: answer(429, {}, { "retry-after": "5" }) } }));
  const { report } = await dcRun(fetchImpl);
  assert.deepEqual([report.stoppedBy, cov(report).verdict, cov(report).families.events.verdict], ["rate_limited", "differs", "differs"]);
});

test("DC8 every identity, session, team and answer is confirmed before the next request; a stop names its code and sends nothing more", async () => {
  const cases = [
    ["session_list_unavailable", { over: { [K.list]: answer(500, { detail: "error" }) } }, 2],
    ["team_isolation_failed", { over: { [K.list]: answer(200, [sess(100, [101, 102]), sess(400, [401], { team: 981 })]) } }, 2],
    ["team_unknown_shape", { over: { [K.list]: answer(200, [sess(100, [101, 102], { team: { id: 980 } })]) } }, 2],
    ["no_parent_session", { over: { [K.list]: answer(200, [sess(100, [101, 102], { is_stats_valid: false }), sess(200, [])]) } }, 2],
    ["no_parent_session", { over: { [K.list]: answer(200, [sess(300, [301]), sess(301, [])]) } }, 2],
    ["session_list_unavailable", { over: { [K.list]: answer(302, {}, { location: "https://elsewhere.example/" }) } }, 2],
    ["parent_not_confirmed", { over: { [K.parent]: answer(200, sess(100, [101])) } }, 3],
    ["athlete_list_unavailable", { over: { [K.athletes]: answer(200, ROWS, { "content-length": String(6 * 1024 * 1024) }) } }, 4],
    ["details_unavailable", { over: { [K.whole]: answer(200, "{not json") } }, 5],
    ["parent_id_mismatch", { over: { [K.parent]: answer(200, sess(300, [101, 102])) } }, 3],
    ["parent_not_confirmed", { over: { [K.parent]: answer(200, sess(100, [101, 102], { is_stats_valid: false })) } }, 3],
    ["athlete_list_empty", { over: { [K.athletes]: answer(200, [], { "x-total-count": "0" }) } }, 4],
    ["team_isolation_failed", { rows: [...ROWS, row(8009, 4719, null, { teamsession: 777 })] }, 4],
    ["row_ids_repeated", { rows: [...ROWS, ROWS[1]] }, 4],
    ["row_drill_unreadable", { rows: [...ROWS, row(8010, 4719, 5)] }, 4],
    ["row_identity_unreadable", { rows: [...ROWS, row(8011, "04719", null)] }, 4],
    ["details_unavailable", { over: { [K.whole]: answer(200, { teamsession: 100, players: [] }) } }, 5],
    ["drill_details_unavailable", { over: { [K.drill]: answer(404, { detail: "Not found." }) } }, 7],
    ["thresholds_unavailable", { over: { [K.thresholds]: answer(500, { detail: "error" }) } }, 7],
    ["team_isolation_failed", { over: { [K.thresholds]: answer(200, { ...THRESHOLDS, team: 981 }) } }, 7],
    ["no_comparable_athlete", { rows: ROWS.map((r) => (r.drill === 0 ? { ...r, is_stats_valid: false } : r)) }, 7],
    ["more_unavailable", { over: { [K.more(8003)]: answer(404, { detail: "Not found." }) } }, 9],
    ["more_id_mismatch", { more: (r) => ({ ...moreOf(r), athletesession_id: r.id === 8001 ? 8002 : r.id }) }, 8],
  ];
  for (const [code, config, sent] of cases) {
    const { calls, fetchImpl } = fakeServer(routesOf(config));
    const { report } = await dcRun(fetchImpl);
    assert.equal(report.stoppedBy, code, `${code} after ${sent}`);
    assert.equal(calls.length, sent, `${code}: nothing after the request that failed`);
    assert.deepEqual([cov(report).verdict, cov(report).reason], ["insufficient", code], code);
    noLeak(report);
  }
  // A failed exchange (refused, timed out, redirected): nothing more is sent, nothing paused.
  const hang = (init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
  for (const exchange of [answer(400, { non_field_errors: ["Unable to log in."] }), hang, answer(302, {}, { location: "https://elsewhere.example/" })]) {
    const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.exchange]: exchange } }));
    const { report, sleeps } = await dcRun(fetchImpl, { timeoutMs: 50 });
    assert.deepEqual([report.stoppedBy, calls.length, sleeps.length, cov(report).reason], ["exchange_failed", 1, 0, "exchange_failed"]);
  }
});

test("DC9 nothing personal or raw leaves: the players' names are dropped, only closed key names and unit words are printed, no header text", async () => {
  const headers = { allow: "GET, HEAD, OPTIONS, Marker Person", "x-gpexe-version": "Marker build", "x-total-count": "5" };
  const { fetchImpl } = fakeServer(routesOf({
    over: { [K.list]: answer(200, [sess(100, [101, 102], { Marker_Person_Key: 1 }), sess(101, []), sess(102, [])], headers) },
    player: (r) => playerOf(r, { over: { max_values_speed: { unit: "Marker unit", value: r.max_v } } }),
  }));
  const { report } = await dcRun(fetchImpl);
  const text = JSON.stringify(report);
  noLeak(report);
  for (const s of ["first_name", "last_name", "athlete_role", "athlete_name", "Marker_Person_Key", "GET, HEAD", "\"name\"", "notes"]) assert.ok(!text.includes(s), s);
  for (const r of report.requests) for (const key of ["fieldNames", "resultFieldNames"]) if (Array.isArray(r[key])) assert.ok(r[key].every((k) => PRINTABLE_KEYS.includes(k)), `${r.path}: ${r[key]}`);
  const listEntry = report.requests[1];
  // The first list row's keys outside the closed list are counted: `name` and the person-like key (`notes` is dropped on reading).
  assert.deepEqual([listEntry.gpexeVersion, listEntry.contentTypeJson, typeof listEntry.headerCount, listEntry.otherFieldCount], ["<unprintable>", true, "number", 2]);
  assert.ok(!("allow" in listEntry) && !("headerNames" in listEntry) && !("contentType" in listEntry));
  assert.deepEqual(cov(report).rowScalars.detailsUnits.max_v, ["<other>"]);
  assert.ok(report.requests.every((r) => !/\d{3,}/.test(r.path.replace("980", ""))), "no id in a path");
});

test("DC10 the limits: one host and one team, the cap, a fixed pause, a repeated parent read once, and no other probe file changed", async () => {
  assert.throws(() => parseArgs(["--host", "e03"]), /server3 only|unknown/);
  assert.throws(() => parseArgs(["--mode", "full"]), DiscoveryUsageError);
  await assert.rejects(runDetailsCoverageProbe({ host: "e03" }, ENV, async () => { throw new Error("never"); }), DiscoveryUsageError);
  await assert.rejects(runDetailsCoverageProbe({ team: "981" }, ENV, async () => { throw new Error("never"); }), DiscoveryUsageError);
  await assert.rejects(runDetailsCoverageProbe({ timeoutMs: 60_001 }, ENV, async () => { throw new Error("never"); }), DiscoveryUsageError);
  await assert.rejects(runDetailsCoverageProbe({}, {}, async () => { throw new Error("never"); }), DiscoveryUsageError);
  // A pause cannot be configured away: the only option is the sleep function the tests replace.
  const source = await fsp.readFile(path.join(__dirname, "../scripts/gpexe-details-coverage-probe.mjs"), "utf8");
  assert.match(source, /await sleep\(DETAILS_COVERAGE_PAUSE_MS\)/);
  assert.ok(!/pauseMs\s*=/.test(source.split("export async function runDetailsCoverageProbe")[1].split("{")[1]), "no pause option");
  assert.match(source, /if \(requests > DETAILS_COVERAGE_MAX_REQUESTS\) throw new ProbeStop\("request_limit"/);
  // Under api/ only the drill read of a check, checked before every such request.
  assert.match(source, /if \(!LEGACY_DRILL_PATH\.test\(resourcePath\) \|\| resourcePath !== `team_session\/\$\{parentId\}\/details\/\?drill=\$\{DETAILS_COVERAGE_DRILL_INDEX\}`\)/);
  assert.ok(LEGACY_DRILL_PATH.test("team_session/186942/details/?drill=0"));
  for (const bad of ["team_session/186942/details/?drill=1", "team_session/186942/", "team_session/186942/brief/", "athlete/7/", "team_session/0186942/details/?drill=0"]) assert.ok(!LEGACY_DRILL_PATH.test(bad), bad);
  // The page names parent 100 twice: it is one parent, read once.
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.list]: answer(200, [sess(100, [101, 102]), sess(100, [101, 102]), sess(101, []), sess(102, [])]) } }));
  const { report } = await dcRun(fetchImpl);
  assert.deepEqual([paths(calls).filter((p) => p === K.parent).length, cov(report).selection.repeatedParentIds, cov(report).verdict], [1, 1, "same"]);
});

test("DC11 the helpers: Retry-After, detail values, scalar relations, the band guard and the verdict order", () => {
  assert.deepEqual(retryAfterOf(" 7 "), { retryAfter: "seconds", retryAfterS: 7 });
  assert.deepEqual(retryAfterOf("1.5"), { retryAfter: "other", retryAfterS: null });
  assert.deepEqual(retryAfterOf(null), { retryAfter: "absent", retryAfterS: null });
  assert.deepEqual(detailsValue({ a: { unit: "m", value: 3 } }, "a"), { kind: "number", value: 3, unit: "m" });
  assert.deepEqual(detailsValue({ a: 3 }, "a"), { kind: "bare_number", value: 3, unit: null });
  assert.deepEqual(detailsValue({ a: { unit: "Marker", value: null } }, "a"), { kind: "null_value", value: null, unit: "<other>" });
  assert.deepEqual(detailsValue({ a: { unit: "m" } }, "a"), { kind: "object_without_value", value: null, unit: "m" });
  assert.deepEqual(detailsValue({}, "a"), { kind: "absent", value: null, unit: null });
  assert.deepEqual(detailsValue({ a: "5" }, "a"), { kind: "other", value: null, unit: null });
  assert.deepEqual([scalarRelation(10, 10), scalarRelation(10, 36), scalarRelation(120, 2), scalarRelation(5000, 5), scalarRelation(10, 11), scalarRelation(null, 1)], ["equal", "times_3_6", "divided_by_60", "divided_by_1000", "other", "missing"]);
  const zones = zonesOf(POWER_T).map(([lower, upper]) => ({ readable: true, lower, upper, distance: 1, ready: true }));
  assert.deepEqual([bandStatus(zones, POWER_T, [25, 60]), bandStatus(zones, [10, 20, 25, 75], [25, 60]), bandStatus(zones, [10, 20, 25, 40, 60, 75], [25, 60]), bandStatus(zones.filter((z) => z.lower !== 25), POWER_T, [25, 60]), bandStatus([...zones, zones[3]], POWER_T, [25, 60])],
    ["ok", "team_threshold_missing", "team_threshold_split", "zone_boundary_missing", "zone_boundary_ambiguous"]);
  const same = { verdict: "same" };
  const all = { events: same, powerZones: same, speedZones: same, mapping: same, drillLevel: same };
  assert.deepEqual(overallVerdict(all, null), { verdict: "same" });
  assert.deepEqual(overallVerdict(all, "rate_limited"), { verdict: "insufficient", reason: "rate_limited" });
  assert.deepEqual(overallVerdict({ ...all, events: { verdict: "differs" } }, "rate_limited"), { verdict: "differs" });
  assert.deepEqual(overallVerdict({ ...all, powerZones: { verdict: "insufficient" } }, null), { verdict: "insufficient", reason: "powerZones_not_same" });
  assert.deepEqual(overallVerdict({ ...all, drillLevel: { verdict: "insufficient" } }, null), { verdict: "insufficient", reason: "drillLevel_not_same" });
  assert.deepEqual([drillLevelVerdict([]), drillLevelVerdict([true, false]), drillLevelVerdict([true]), drillLevelVerdict([true, true])].map((v) => v.reason ?? v.verdict), ["not_compared", "drill_not_distinguished", "fewer_athletes_than_planned", "same"]);
  assert.deepEqual([detailsReadiness({ k: { value: 1, is_ready: false } }, "k"), detailsReadiness({ is_ready: true, k: { value: 1 } }, "k"), detailsReadiness({ k: { value: 1 } }, "k")],
    [{ ready: false, level: "zone" }, { ready: null, level: "player" }, { ready: null, level: "none" }]);
  assert.deepEqual(zoneFamilyVerdict([], "power"), { verdict: "insufficient", reason: "not_compared", indexBase: "none", notReadyCaseObserved: false });
});

test("DC12 zones are `same` only when the importer's zone guards can run without /more/: bounds placed by the thresholds, readiness carried by the details", async () => {
  // The thresholds of the day no longer give /more/'s zone bounds: a details zone could not be placed by its number.
  const bounds = await dcRun(fakeServer(routesOf({ over: { [K.thresholds]: answer(200, { ...THRESHOLDS, power_thresholds: [20, 25, 60, 75] }) } })).fetchImpl);
  assert.deepEqual([cov(bounds.report).families.powerZones.verdict, cov(bounds.report).families.powerZones.reason, cov(bounds.report).pairs[0].bands.every((b) => b.status === "ok"), cov(bounds.report).verdict], ["insufficient", "bounds_not_derivable_from_thresholds", true, "insufficient"]);
  // The details carry no readiness: the importer's `zones_not_ready` guard could not run.
  const none = await dcRun(fakeServer(routesOf({ ready: null })).fetchImpl);
  assert.deepEqual([cov(none.report).families.powerZones.reason, cov(none.report).families.speedZones.reason, cov(none.report).verdict], ["details_readiness_not_carried", "details_readiness_not_carried", "insufficient"]);
  // The details call a ready zone not ready: a confirmed difference.
  const notReady = await dcRun(fakeServer(routesOf({ player: (r) => playerOf(r, { over: r.id === 8004 ? { athletesessionspeedzone_distance_5: { unit: "m", value: zoneDist(8004, "speed", 4), is_ready: false } } : {} }) })).fetchImpl);
  assert.deepEqual([cov(notReady.report).families.speedZones.verdict, cov(notReady.report).families.speedZones.reason, cov(notReady.report).verdict], ["differs", "details_readiness_differs", "differs"]);
  // A flag on the player is not a zone's readiness: it cannot say that one zone is not ready.
  const playerLevel = await dcRun(fakeServer(routesOf({ player: (r) => ({ ...playerOf(r, { ready: null }), is_ready: true }) })).fetchImpl);
  const pz = cov(playerLevel.report).families.powerZones;
  assert.deepEqual([pz.verdict, pz.reason, cov(playerLevel.report).verdict, cov(playerLevel.report).readiness.detailsHasReadinessKey], ["insufficient", "details_readiness_player_level_only", "insufficient", true]);
  // `same` proves the readiness of ready zones only: the not-ready case was not observed.
  assert.deepEqual([cov((await dcRun(fakeServer(routesOf()).fetchImpl)).report).families.powerZones.notReadyCaseObserved], [false]);
});

test("DC13 a server that ignores `?drill=` cannot pass for a drill: when the drill's answers equal the whole session's, the drill level is `insufficient`", async () => {
  const wholeOf = (r) => ROWS.find((w) => w.athlete === r.athlete && w.drill === null);
  const { fetchImpl } = fakeServer(routesOf({
    more: (r) => (r.drill === 0 ? { ...moreOf(wholeOf(r)), athletesession_id: r.id } : moreOf(r)),
    over: { [K.drill]: answer(200, detailsOf(ROWS.filter((r) => r.drill === null), 101)) },
  }));
  const { report } = await dcRun(fetchImpl);
  const c = cov(report);
  assert.deepEqual([c.families.events.verdict, c.families.powerZones.verdict, c.families.drillLevel.verdict, c.families.drillLevel.reason, c.verdict, c.reason], ["same", "same", "insufficient", "drill_not_distinguished", "insufficient", "drillLevel_not_same"]);
});

test("DC14 the parent with the fewest drills (at least two) is read, so its athlete list most likely fits the one page", async () => {
  const sessions = [sess(500, [501, 502, 503, 504, 505]), ...[501, 502, 503, 504, 505].map((id) => sess(id, [])), sess(100, [101, 102]), sess(101, []), sess(102, [])];
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.list]: answer(200, sessions) } }));
  const { report } = await dcRun(fetchImpl);
  assert.ok(!paths(calls).some((p) => p.includes("/500/") || p.includes("teamsession=500")));
  assert.deepEqual([cov(report).selection.parentCandidates, cov(report).selection.parentDrills, cov(report).verdict], [2, 2, "same"]);
});

test("DC15 the drill's rest/v1 form that does not answer is read once in the api/ form a check reads today; nothing else goes under api/", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.drill]: answer(404, { detail: "Not found." }), [K.legacyDrill]: answer(200, detailsOf(ROWS.filter((r) => r.drill === 0), 101)) } }));
  const { report, sleeps } = await dcRun(fetchImpl);
  assert.deepEqual(paths(calls), [...ORDER.slice(0, 6), K.legacyDrill, ...ORDER.slice(6)]);
  assert.deepEqual([report.requestCount, sleeps.length, cov(report).selection.drillForm, cov(report).verdict], [DETAILS_COVERAGE_MAX_REQUESTS, 11, "api", "same"]);
  assert.equal(report.requests[6].path, "api/team_session/<id>/details/?drill=0");
  assert.equal(paths(calls).filter((p) => p.startsWith("GET /api/")).length, 1);
  // A refused credential on the rest/v1 drill read ends the run: no api/ read follows it.
  for (const status of [401, 403]) {
    const refused = fakeServer(routesOf({ over: { [K.drill]: answer(status, { detail: "Invalid token." }), [K.legacyDrill]: answer(200, detailsOf(ROWS.filter((r) => r.drill === 0), 101)) } }));
    const r = await dcRun(refused.fetchImpl);
    assert.deepEqual([r.report.stoppedBy, refused.calls.length, paths(refused.calls).some((p) => p.startsWith("GET /api/"))], ["source_auth_rejected", 6, false], String(status));
  }
});

test("DC16 the final guards refuse a report that would carry the issued token or a credential; a request error is a closed word", async () => {
  await assert.rejects(dcRun(fakeServer(routesOf({ over: { [K.exchange]: answer(200, { token: "token" }) } })).fetchImpl), (e) => e.code === "secret_in_report");
  await assert.rejects(runDetailsCoverageProbe({ sleep: async () => {} }, { GPEXE_USERNAME: USER, GPEXE_PASSWORD: "POST" }, fakeServer(routesOf()).fetchImpl), (e) => e.code === "secret_in_report");
  for (const [code, word] of [["ECONNRESET", "ECONNRESET"], ["bad code: Marker text", "error"]]) {
    const routes = routesOf({ over: { [K.list]: () => { throw Object.assign(new Error("boom"), { code }); } } });
    const { report } = await dcRun(fakeServer(routes).fetchImpl);
    assert.deepEqual([report.stoppedBy, report.requests[1].error], ["session_list_unavailable", word]);
  }
});
