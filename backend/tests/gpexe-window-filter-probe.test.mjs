// The window-filter probe (owner order 2026-10-24: does server3's date filter return every session a
// check needs?) against a fake server3 only: no test sends a request to GPEXE, and no real credential
// exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, boundsOf, compareWindow, filteredPath, parseArgs, runWindowFilterProbe, WINDOW_FILTER_MAX_REQUESTS, WINDOW_FILTER_PAUSE_MS, WINDOWS,
} from "../scripts/gpexe-window-filter-probe.mjs";
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

// The team's history: one parent a day from 2026-07-01 to 2026-10-26 at 18:00, every third with two
// drills (the second drill of a late parent starting after midnight), plus one session at 23:30 on the
// day before the 14-day window (a look-back parent) with one drill after midnight.
const MARK = "Marker Session Name";
function history() {
  const rows = [];
  let id = 100000;
  for (let day = "2026-07-01"; day <= "2026-10-26"; day = addDays(day, 1)) {
    const parentId = id++;
    const drills = (Number(day.slice(8)) % 3 === 0) ? [id++, id++] : [];
    rows.push({ id: parentId, team: 980, name: MARK, start_timestamp: `${day}T18:00:00`, drills, drills_count: drills.length, is_stats_valid: true });
    drills.forEach((d, i) => rows.push({ id: d, team: 980, name: MARK, start_timestamp: i === 0 ? `${day}T18:10:00` : `${addDays(day, 1)}T00:20:00`, drills: [], drills_count: 0, is_stats_valid: true }));
  }
  const late = id++;
  const lateDrill = id++;
  rows.push({ id: late, team: 980, name: MARK, start_timestamp: "2026-10-10T23:30:00", drills: [lateDrill], drills_count: 1, is_stats_valid: true });
  rows.push({ id: lateDrill, team: 980, name: MARK, start_timestamp: "2026-10-11T00:05:00", drills: [], drills_count: 0, is_stats_valid: true });
  return rows;
}
const ROWS = history();

// A fake server: the whole list by offset, and the date filter by a rule (exact by default).
const exactFilter = (row, gte, lte) => row.start_timestamp >= gte && row.start_timestamp <= lte;
function fakeServer({ rows = ROWS, filter = exactFilter, over = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    calls.push(key);
    if (over[key]) return over[key];
    if (init.method === "POST" && u.pathname === "/api-token-auth/") return answer(200, { token: ISSUED });
    if (u.pathname !== "/rest/v1/team_session/") return answer(404, {});
    const gte = u.searchParams.get("start_timestamp_gte");
    const lte = u.searchParams.get("start_timestamp_lte");
    const limit = Number(u.searchParams.get("limit"));
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const set = gte === null ? rows : rows.filter((r) => filter(r, gte.replace(" ", "T"), lte.replace(" ", "T")));
    return answer(200, set.slice(offset, offset + limit), { "x-total-count": String(set.length) });
  };
  return { calls, fetchImpl };
}
const wfRun = (fetchImpl, over = {}) => {
  const sleeps = [];
  let t = 0;
  return runWindowFilterProbe({ sleep: async (ms) => { sleeps.push(ms); }, now: () => (t += 1500), ...over }, ENV, fetchImpl).then((report) => ({ report, sleeps }));
};
const noLeak = (report) => {
  const text = JSON.stringify(report);
  for (const leak of [USER, PASSWORD, ISSUED, "Marker", "100000", "2026-10-1", "2026-09", "2026-07", "18:00"]) assert.ok(!text.includes(leak), `the report never carries ${leak}`);
};
const pages = Math.ceil(ROWS.length / 100);

test("WF1 the planned run: one exchange, the whole list page by page, then four filtered reads, a 2 s pause before every read; an exact server filter is `safe` for both windows", async () => {
  const { calls, fetchImpl } = fakeServer();
  const { report, sleeps } = await wfRun(fetchImpl);
  assert.equal(report.stoppedBy, null);
  assert.equal(calls.length, 1 + pages + 4);
  assert.ok(calls.length <= WINDOW_FILTER_MAX_REQUESTS);
  assert.deepEqual(sleeps, Array(pages + 4).fill(WINDOW_FILTER_PAUSE_MS));
  assert.deepEqual(report.wholeList.complete, true);
  assert.deepEqual([report.windowFilter.verdict, report.windowFilter.reason], ["safe", null]);
  const w14 = report.windows.days14.margin;
  assert.equal(w14.windowParents, 14);
  assert.equal(w14.lookBackParents, 2, "the day before the window: its 18:00 parent and its 23:30 parent");
  assert.deepEqual([w14.missingWindowParents, w14.missingLookBackParents, w14.missingDrills, w14.sameWindowParents], [0, 0, 0, true]);
  assert.ok(report.requests.every((r) => r.ms === undefined || Number.isInteger(r.ms)));
  assert.ok(report.requests.slice(1).every((r) => /<date>|limit=<n>/.test(r.path)), "dates and ids masked");
  noLeak(report);
});

test("WF2 a filter that also returns sessions up to a day after the end (as on 2026-10-07): nothing is missing, the extra rows are counted after the end, the verdict stays `safe`", async () => {
  const filter = (row, gte, lte) => row.start_timestamp >= gte && row.start_timestamp <= `${addDays(lte.slice(0, 10), 1)}T23:59:59`;
  const { fetchImpl } = fakeServer({ filter });
  const { report } = await wfRun(fetchImpl);
  assert.equal(report.windowFilter.verdict, "safe");
  const exact = report.windows.days2.exact;
  assert.equal(exact.missingWindowParents + exact.missingDrills + exact.missingLookBackParents, 0);
  assert.ok(exact.outsideAfter.under_24h > 0);
  assert.equal(exact.outsideBefore.under_24h, 0);
});

test("WF3 a filter shifted a day later (it drops the first asked day and adds one after): the exact form misses the look-back day, the margin form misses nothing", async () => {
  const filter = (row, gte, lte) => row.start_timestamp >= `${addDays(gte.slice(0, 10), 1)}T00:00:00` && row.start_timestamp <= `${addDays(lte.slice(0, 10), 1)}T23:59:59`;
  const { fetchImpl } = fakeServer({ filter });
  const { report } = await wfRun(fetchImpl);
  assert.ok(report.windows.days14.exact.missingLookBackParents > 0, "the old form loses the look-back day");
  assert.equal(report.windows.days14.margin.missingLookBackParents, 0);
  assert.equal(report.windowFilter.verdict, "safe", "the verdict is the margin form's");
});

test("WF4 a filter that drops a drill row named by a window parent: `unsafe` (drill_missing)", async () => {
  const parent = ROWS.find((r) => r.start_timestamp.startsWith("2026-10-12") && r.drills.length === 2);
  const drop = parent.drills[1];
  const filter = (row, gte, lte) => row.id !== drop && exactFilter(row, gte, lte);
  const { fetchImpl } = fakeServer({ filter });
  const { report } = await wfRun(fetchImpl);
  assert.deepEqual([report.windowFilter.verdict, report.windowFilter.reason], ["unsafe", "drill_missing"]);
  assert.equal(report.windows.days14.margin.missingDrills, 1);
});

test("WF5 a filter that drops a window parent but keeps its drills: `unsafe`, and the drills it kept would be taken for sessions", async () => {
  const parent = ROWS.find((r) => r.start_timestamp.startsWith("2026-10-15") && r.drills.length === 2);
  const filter = (row, gte, lte) => row.id !== parent.id && exactFilter(row, gte, lte);
  const { fetchImpl } = fakeServer({ filter });
  const { report } = await wfRun(fetchImpl);
  assert.deepEqual([report.windowFilter.verdict, report.windowFilter.reason], ["unsafe", "window_parent_missing"]);
  const m = report.windows.days14.margin;
  assert.equal(m.missingWindowParents, 1);
  assert.equal(m.sameWindowParents, false);
  assert.ok(m.rowsTakenForSession >= 1);
});

test("WF6 a 429 on a filtered read ends the run at once; the verdict is insufficient (rate_limited)", async () => {
  const keyOf = (u) => { const x = new URL(`https://server3.gpexe.com/rest/v1/${u}`); return `GET ${x.pathname}${x.search}`; };
  const { calls, fetchImpl } = fakeServer({ over: { [keyOf(filteredPath(WINDOWS[0], "exact", "980"))]: answer(429, {}, { "retry-after": "30" }) } });
  const { report } = await wfRun(fetchImpl);
  assert.equal(report.stoppedBy, "rate_limited");
  assert.equal(calls.length, 1 + pages + 2, "nothing after the 429");
  assert.equal(report.windowFilter.verdict, "insufficient");
});

test("WF7 the whole list's total changes between pages: the run stops (list_changed) before any filtered read", async () => {
  let n = 0;
  const base = fakeServer();
  const fetchImpl = async (url, init) => {
    const res = await base.fetchImpl(url, init);
    if (init.method === "GET" && !new URL(url).searchParams.get("start_timestamp_gte")) {
      n += 1;
      if (n === 2) return answer(200, [], { "x-total-count": String(ROWS.length + 1) });
    }
    return res;
  };
  const { report } = await wfRun(fetchImpl);
  assert.equal(report.stoppedBy, "list_changed");
  assert.equal(report.requestCount, 3);
});

test("WF8 the bounds: the margin form asks from the look-back day minus two days to the end plus two; the exact form as sent until 2026-10-08", () => {
  assert.deepEqual(boundsOf(WINDOWS[0], "margin"), { gte: "2026-10-08", lte: "2026-10-26" });
  assert.deepEqual(boundsOf(WINDOWS[0], "exact"), { gte: "2026-10-10", lte: "2026-10-24" });
  assert.equal(filteredPath(WINDOWS[1], "exact", "980"), "team_session/?team=980&start_timestamp_gte=2026-10-04%2000%3A00%3A00&start_timestamp_lte=2026-10-06%2023%3A59%3A59&limit=100");
  assert.equal(compareWindow(ROWS, ROWS, WINDOWS[1]).missingWindowParents, 0);
});

test("WF9 arguments and environment: another host or team, a missing credential and an unknown argument are refused before anything is sent", async () => {
  assert.throws(() => parseArgs(["--host", "e03"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--team", "981"]), DiscoveryUsageError);
  assert.throws(() => parseArgs(["--mode", "x"]), DiscoveryUsageError);
  const { calls, fetchImpl } = fakeServer();
  await assert.rejects(runWindowFilterProbe({ sleep: async () => {} }, {}, fetchImpl), DiscoveryUsageError);
  assert.equal(calls.length, 0);
});

test("WF10 a filter that drops the look-back day's late parent but keeps its drill after midnight: no window parent is lost, but that drill would be taken for a session - `unsafe`", async () => {
  const late = ROWS.find((r) => r.start_timestamp === "2026-10-10T23:30:00");
  const filter = (row, gte, lte) => row.id !== late.id && exactFilter(row, gte, lte);
  const { fetchImpl } = fakeServer({ filter });
  const { report } = await wfRun(fetchImpl);
  const m = report.windows.days14.margin;
  assert.deepEqual([m.windowParentsLost, m.rowsTakenForSession, m.sameWindowParents, m.missingLookBackParents], [0, 1, false, 1]);
  assert.equal(report.windowFilter.verdict, "unsafe");
});
