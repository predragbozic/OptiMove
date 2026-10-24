// The max-speed probe (owner order 2026-10-24: can the details' max_values_speed replace each row's
// max_v?) against a fake server3 only: no test sends a request to GPEXE, and no real credential exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePair, MAX_SPEED_MAX_REQUESTS, MAX_SPEED_PAUSE_MS, maxSpeedVerdict, parseArgs, roundingOf, runMaxSpeedProbe, unitTextOf,
} from "../scripts/gpexe-max-speed-probe.mjs";
import { DiscoveryUsageError } from "../scripts/gpexe-auth-discovery.mjs";

const USER = "fake.user@example.invalid";
const PASSWORD = "Fake-Password-not-real-42";
const ISSUED = "FAKE-ISSUED-TOKEN-fedcba9876543210-not-real";
const ENV = { GPEXE_USERNAME: USER, GPEXE_PASSWORD: PASSWORD };
const bytesOf = (text) => new TextEncoder().encode(text);
function answer(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status, headers: new Headers({ "content-type": "application/json", ...headers }),
    get body() { return new ReadableStream({ start(c) { c.enqueue(bytesOf(text)); c.close(); } }); },
  };
}
function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect });
    const u = new URL(url);
    const route = routes[`${init.method} ${u.pathname}${u.search}`];
    if (route === undefined) return answer(404, { detail: "Not found." });
    return typeof route === "function" ? route(init, u) : route;
  };
  return { calls, fetchImpl };
}
const paths = (calls) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

// Parent 100 of team 980 with drills 101 and 102; four athletes, one row each at the whole session and
// at drills 0 and 1. Every max_v is distinct; the details give it in km/h, exactly 3.6 times.
const MARK = "Marker Athlete Name";
const DAY = "2026-09-14";
const ATHLETES = [4711, 4712, 4713, 4714];
const sess = (id, drills, extra = {}) => ({ id, team: 980, name: "Marker Session", start_timestamp: `${DAY}T10:00:00`, drills, drills_count: drills.length, is_stats_valid: true, ...extra });
const maxV = (id) => 6.25 + (id % 17) * 0.1875; // .1875 steps never meet an ISO time in the leak check
const row = (id, athlete, drill, extra = {}) => ({ id, athlete, track: 70000 + athlete, teamsession: 100, drill, is_stats_valid: true, total_time: 3000, total_distance: 5000, max_v: maxV(id), athlete_name: MARK, ...extra });
const rowId = (a, level) => ({ whole: 8000, drill0: 8010, drill1: 8020 })[level] + ATHLETES.indexOf(a) + 1;
const ROWS = ATHLETES.flatMap((a) => [row(rowId(a, "whole"), a, null), row(rowId(a, "drill0"), a, 0), row(rowId(a, "drill1"), a, 1)]);
const kmh = (r) => ({ unit: "km/h", value: r.max_v * 3.6 });
const detailsOf = (rows, value = kmh) => ({
  teamsession: 100, drills_count: 2, team: { total_distance: { unit: "m", value: 1 } },
  players: Object.fromEntries(rows.map((r) => [String(r.athlete), { athlete: { first_name: MARK }, max_values_speed: value(r), total_distance: { unit: "m", value: r.total_distance } }])),
});
const K = {
  exchange: "POST /api-token-auth/",
  list: "GET /rest/v1/team_session/?team=980&limit=100",
  parent: "GET /rest/v1/team_session/100/",
  athletes: "GET /rest/v1/athlete_session/?teamsession=100&limit=100",
  whole: "GET /rest/v1/team_session/100/details/",
  d0: "GET /api/team_session/100/details/?drill=0",
  d1: "GET /api/team_session/100/details/?drill=1",
  row: (id) => `GET /rest/v1/athlete_session/${id}/`,
};
function routesOf({ rows = ROWS, value = kmh, over = {} } = {}) {
  const level = (d) => rows.filter((r) => (d === null ? r.drill === null : r.drill === d));
  const routes = {
    [K.exchange]: answer(200, { token: ISSUED }),
    [K.list]: answer(200, [sess(100, [101, 102]), sess(101, []), sess(102, []), sess(300, [301, 302, 303]), sess(301, [])], { "x-total-count": "5" }),
    [K.parent]: answer(200, sess(100, [101, 102])),
    [K.athletes]: answer(200, rows, { "x-total-count": String(rows.length) }),
    [K.whole]: answer(200, detailsOf(level(null), value)),
    [K.d0]: answer(200, detailsOf(level(0), value)),
    [K.d1]: answer(200, detailsOf(level(1), value)),
  };
  for (const r of rows) routes[K.row(r.id)] = answer(200, r);
  return { ...routes, ...over };
}
const msRun = (fetchImpl, over = {}) => {
  const sleeps = [];
  return runMaxSpeedProbe({ sleep: async (ms) => { sleeps.push(ms); }, ...over }, ENV, fetchImpl).then((report) => ({ report, sleeps }));
};
const ORDER = [K.exchange, K.list, K.parent, K.athletes, K.whole, K.d0, K.d1,
  ...ATHLETES.slice(0, 3).flatMap((a) => ["whole", "drill0", "drill1"].map((l) => K.row(rowId(a, l))))];
const noLeak = (report) => {
  const text = JSON.stringify(report);
  for (const leak of [USER, PASSWORD, ISSUED, "Marker", "4711", "4713", "8001", "8023", ".1875", DAY]) assert.ok(!text.includes(leak), `the report never carries ${leak}`);
};

test("MS1 the planned run: one exchange, then fifteen GETs in a fixed order with a 2 s pause before every read; the details' km/h is exactly 3.6 x max_v for three athletes at three levels: `same`", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf());
  const { report, sleeps } = await msRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.deepEqual(paths(calls), ORDER);
  assert.equal(MAX_SPEED_MAX_REQUESTS, ORDER.length);
  assert.equal(report.requestCount, 16);
  assert.deepEqual(sleeps, Array(15).fill(MAX_SPEED_PAUSE_MS), "a pause before every read, none before the exchange");
  assert.ok(calls.slice(1).every((c) => c.method === "GET" && c.headers.Authorization === `Token ${ISSUED}` && c.redirect === "manual"));
  const m = report.maxSpeed;
  assert.deepEqual([m.verdict, m.reason, m.relation], ["same", null, "times_3_6"]);
  assert.equal(m.athletesCompared, 3);
  assert.equal(m.drillsDistinguished, true);
  assert.deepEqual(m.pairs.map((p) => [p.athlete, p.level, p.relation, p.detailsUnitText]), [1, 2, 3].flatMap((a) => ["whole", "drill0", "drill1"].map((l) => [a, l, "times_3_6", "km/h"])));
  assert.deepEqual([m.coverage.validRows, m.coverage.validRowsCovered, m.coverage.validRowsNotCovered], [12, 12, 0], "every valid row of the three levels, the fourth athlete's included");
  assert.equal(m.mapping.pageComplete, true);
  assert.equal(m.selection.parentDrills, 2, "the parent with the fewest drills of at least two");
  noLeak(report);
});

test("MS2 the details give the same m/s number with unit m/s: `same` with the relation equal", async () => {
  const { fetchImpl } = fakeServer(routesOf({ value: (r) => ({ unit: "m/s", value: r.max_v }) }));
  const { report } = await msRun(fetchImpl);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.relation], ["same", "equal"]);
});

test("MS3 the details round the km/h to one decimal: `differs` (values_differ), and the rounding is named", async () => {
  const { fetchImpl } = fakeServer(routesOf({ value: (r) => ({ unit: "km/h", value: Math.round(r.max_v * 36) / 10 }) }));
  const { report } = await msRun(fetchImpl);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["differs", "values_differ"]);
  const other = report.maxSpeed.pairs.find((p) => p.relation === "other");
  assert.equal(other.rounding.kmhRounded1, true);
  assert.equal(other.rounding.msRounded3, false);
});

test("MS4 a valid row whose athlete has no max_values_speed in its drill's details: `differs` (not_covered), even when every compared pair is exact", async () => {
  const value = (r) => (r.athlete === 4714 && r.drill === 1 ? null : kmh(r));
  const { calls, fetchImpl } = fakeServer(routesOf({ value }));
  const { report } = await msRun(fetchImpl);
  assert.equal(calls.length, 16);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["differs", "not_covered"]);
  assert.equal(report.maxSpeed.coverage.validRowsNotCovered, 1);
  assert.equal(report.maxSpeed.coverage.levels.drill1.validRowsCovered, 3);
});

test("MS5 a 429 on a row read ends the run at once: nothing more is sent, the verdict is insufficient (rate_limited)", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.row(rowId(4712, "drill0"))]: answer(429, {}, { "retry-after": "30" }) } }));
  const { report } = await msRun(fetchImpl);
  assert.equal(report.stoppedBy, "rate_limited");
  assert.deepEqual(paths(calls), ORDER.slice(0, 12));
  assert.deepEqual(report.rateLimit, { requestNumber: 12, retryAfter: "seconds", retryAfterS: 30 });
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["insufficient", "rate_limited"]);
});

test("MS6 drill 1 answers exactly what drill 0 answers and every drill-1 row repeats drill 0: insufficient (drill_parameter_not_distinguished)", async () => {
  const rows = ROWS.map((r) => (r.drill === 1 ? { ...r, max_v: maxV(r.id - 10) } : r));
  const d0 = routesOf({ rows })[K.d0];
  const { fetchImpl } = fakeServer(routesOf({ rows, over: { [K.d1]: d0 } }));
  const { report } = await msRun(fetchImpl);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["insufficient", "drill_parameter_not_distinguished"]);
});

test("MS7 a row's own read that names another athlete stops the run (row_identity_mismatch); nothing more is read", async () => {
  const r = ROWS.find((x) => x.id === rowId(4711, "drill0"));
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.row(r.id)]: answer(200, { ...r, athlete: 4799 }) } }));
  const { report } = await msRun(fetchImpl);
  assert.equal(report.stoppedBy, "row_identity_mismatch");
  assert.equal(paths(calls).at(-1), K.row(r.id));
  assert.equal(report.maxSpeed.verdict, "insufficient");
});

test("MS8 a refused credential on a drill read stops the run (source_auth_rejected) before any row read", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.d0]: answer(401, { detail: "x" }) } }));
  const { report } = await msRun(fetchImpl);
  assert.equal(report.stoppedBy, "source_auth_rejected");
  assert.deepEqual(paths(calls), ORDER.slice(0, 6));
});

test("MS9 a row without max_v whose details give a speed: `differs` (details_value_where_row_has_none); both missing is no difference", async () => {
  const target = rowId(4712, "drill1");
  const rows = ROWS.map((r) => (r.id === target ? { ...r, max_v: null } : r));
  const { fetchImpl } = fakeServer(routesOf({ rows, value: (r) => (r.id === target ? { unit: "km/h", value: 25 } : kmh(r)) }));
  const { report } = await msRun(fetchImpl);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["differs", "details_value_where_row_has_none"]);
  const both = fakeServer(routesOf({ rows, value: (r) => (r.id === target ? { unit: "km/h", value: null } : kmh(r)) }));
  const second = await msRun(both.fetchImpl);
  assert.equal(second.report.maxSpeed.pairs.find((p) => p.relation === "both_missing").level, "drill1");
  assert.notEqual(second.report.maxSpeed.reason, "details_value_where_row_has_none");
});

test("MS10 exact 3.6 x values under a unit that does not say km/h: insufficient (unit_not_consistent)", async () => {
  const { fetchImpl } = fakeServer(routesOf({ value: (r) => ({ unit: "m/s", value: r.max_v * 3.6 }) }));
  const { report } = await msRun(fetchImpl);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason, report.maxSpeed.relation], ["insufficient", "unit_not_consistent", "times_3_6"]);
});

test("MS11 one athlete with all three levels only: insufficient (fewer_athletes_than_needed), and only its three rows are read", async () => {
  const rows = ROWS.filter((r) => r.athlete === 4711 || r.drill === null);
  const { calls, fetchImpl } = fakeServer(routesOf({ rows }));
  const { report } = await msRun(fetchImpl);
  assert.equal(calls.length, 10);
  assert.deepEqual([report.maxSpeed.verdict, report.maxSpeed.reason], ["insufficient", "fewer_athletes_than_needed"]);
});

test("MS12 an athlete list that does not fit the one page read stops the run before any details read", async () => {
  const { calls, fetchImpl } = fakeServer(routesOf({ over: { [K.athletes]: answer(200, ROWS, { "x-total-count": String(ROWS.length + 1) }) } }));
  const { report } = await msRun(fetchImpl);
  assert.equal(report.stoppedBy, "athlete_list_incomplete");
  assert.deepEqual(paths(calls), ORDER.slice(0, 4));
});

test("MS13 arguments and environment: another host or team, a missing credential and an unknown argument are refused before anything is sent", async () => {
  assert.throws(() => parseArgs(["--host", "e03"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--team", "981"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--mode", "x"]), DiscoveryUsageError);
  assert.deepEqual(parseArgs([]), { host: "server3", team: "980" });
  const { calls, fetchImpl } = fakeServer(routesOf());
  await assert.rejects(runMaxSpeedProbe({ sleep: async () => {} }, {}, fetchImpl), DiscoveryUsageError);
  assert.equal(calls.length, 0);
});

test("MS14 the pure helpers: a unit with a digit is <other>; rounding names only exact roundings; mixed exact relations differ", () => {
  assert.equal(unitTextOf({ max_values_speed: { unit: "km/h", value: 1 } }), "km/h");
  assert.equal(unitTextOf({ max_values_speed: { unit: "4711", value: 1 } }), "<other>");
  assert.equal(unitTextOf({ max_values_speed: 3 }), null);
  assert.deepEqual(roundingOf(7.123456, 25.6), { kmhRounded1: true, kmhRounded2: false, msRounded1: false, msRounded2: false, msRounded3: false });
  assert.equal(comparePair({ max_v: 0 }, { max_values_speed: { unit: "km/h", value: 0 } }).relation, "equal");
  const pair = (relation) => ({ relation, nonZero: true, detailsUnitText: "km/h" });
  assert.deepEqual(maxSpeedVerdict({ pairs: [pair("times_3_6"), pair("equal")], coverage: { validRowsNotCovered: 0 }, athletesCompared: 3, drillsDistinguished: true, stoppedBy: null }).reason, "relations_mixed");
  assert.equal(maxSpeedVerdict({ pairs: [pair("times_3_6")], coverage: { validRowsNotCovered: 0 }, athletesCompared: 3, drillsDistinguished: true, stoppedBy: null }).verdict, "same");
  assert.equal(maxSpeedVerdict({ pairs: [{ relation: "times_3_6", nonZero: false, detailsUnitText: "km/h" }], coverage: { validRowsNotCovered: 0 }, athletesCompared: 3, drillsDistinguished: true, stoppedBy: null }).reason, "only_zero_or_missing_values");
});
