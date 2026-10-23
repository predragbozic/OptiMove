// The source's "slow down" (429) during an import check (owner decision
// 2026-10-22): with the rateLimit option the adapter repeats a rate-limited
// request at most once per instance, only after a whole-seconds Retry-After
// within the maximum wait and only when the caller's beforeRetry still allows
// it; any other 429 stops the instance and nothing more is sent. Without the
// option a 429 is what it always was. The administrator's description of a
// stop is a closed-grammar line. Fake fetch only: no network, no database.
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRetryAfter, RATE_LIMIT_MAX_WAIT_CAP_MS } from "../src/gpexeRestV1Adapter.js";
import { rateLimitDiagnostic, rateLimitDiagnosticAccepted, IMPORT_RATE_LIMIT_MAX_WAIT_MS, IMPORT_RATE_LIMIT_WAIT_TICK_MS, RATE_LIMIT_OUTCOMES } from "../src/gpexeCheckRateLimit.js";
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const TEAM_READ = "/rest/v1/team/980/";
const slowDown = (headers = {}) => ({ status: 429, headers: new Headers({ ...json, ...headers }), body: null, text: async () => "slow down" });
// A scripted route: each call takes the next answer, the last one repeats.
const script = (...answers) => { let n = 0; return () => { const a = answers[Math.min(n, answers.length - 1)]; n += 1; return typeof a === "function" ? a() : a; }; };
function limited(over = {}, { maxWaitMs = 60_000, tickMs = 10_000, beforeRetry, onWaitTick } = {}) {
  const sleeps = [];
  const ticks = [];
  const retries = [];
  const options = {
    sleep: async (ms) => { sleeps.push(ms); },
    rateLimit: {
      maxWaitMs, tickMs,
      beforeRetry: beforeRetry ?? (async () => { retries.push("before"); }),
      onWaitTick: onWaitTick ?? (async () => { ticks.push("tick"); }),
    },
  };
  return { options, sleeps, ticks, retries };
}
const teamOk = () => answer(200, { id: 980, name: "FK Marker" });

test("RL1 without the rateLimit option a 429 is what it was: one request, no wait, no repeat, and the instance goes on", async () => {
  const sleeps = [];
  const server = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "1" }), teamOk()) });
  const a = make(server.fetchImpl, { sleep: async (ms) => { sleeps.push(ms); } });
  const e = await errorOf(a.verifyBoundTeam());
  assert.equal(e?.code, "source_unavailable");
  assert.equal(e.message, "The source server asked to slow down.");
  assert.equal(e.reason, undefined, "no rate-limit facts without the option");
  assert.deepEqual(sleeps, []);
  assert.equal(server.calls.length, 1);
  assert.deepEqual(await a.verifyBoundTeam(), { visible: true, sourceTeamId: "980" }, "the next read is sent as before");
  assert.equal(server.calls.length, 2);
});

test("RL2 a 429 with a whole-seconds Retry-After within the maximum: one wait of exactly that long, a tick, beforeRetry, then the SAME GET once more", async () => {
  const l = limited();
  const server = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "5" }), teamOk()) });
  const a = make(server.fetchImpl, l.options);
  assert.deepEqual(await a.verifyBoundTeam(), { visible: true, sourceTeamId: "980" });
  assert.deepEqual(l.sleeps, [5000]);
  assert.deepEqual(l.ticks, ["tick"]);
  assert.deepEqual(l.retries, ["before"]);
  assert.equal(server.calls.length, 2);
  assert.ok(server.calls.every((c) => c.method === "GET" && c.redirect === "manual" && c.headers.Authorization === `Token ${CREDENTIAL}`), "the repeat is the same GET");
  assert.equal(server.calls[0].url, server.calls[1].url);
});

test("RL3 a second 429 after the wait stops the instance: the refusal carries the facts, and no later read sends anything", async () => {
  const l = limited();
  const server = fakeServer({ [TEAM_READ]: slowDown({ "retry-after": "3" }), [LIST]: answer(200, [], { "x-total-count": "0" }) });
  const a = make(server.fetchImpl, l.options);
  const e = await errorOf(a.verifyBoundTeam());
  assert.equal(e?.code, "source_unavailable");
  assert.equal(e.reason, "rate_limited");
  assert.equal(e.status, 429);
  assert.deepEqual({ ...e.rateLimit }, { requestKind: "other", requestsSent: 2, elapsedS: 0, first429Request: 1, first429ElapsedS: 0, retryAfter: "seconds", retryAfterS: 3, retryUsed: true, outcome: "second_429" });
  assert.equal(server.calls.length, 2);
  const after = await errorOf(a.listSessions());
  assert.equal(after, e, "the same stop, without a request");
  assert.equal(server.calls.length, 2, "nothing more was sent");
});

test("RL4 no Retry-After, an HTTP date, a malformed value or one past the maximum: never repeated, the instance stops at once", async () => {
  const cases = [
    [{}, "absent", null, "no_retry_after"],
    [{ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, "date", null, "retry_after_date"],
    [{ "retry-after": "1.5" }, "invalid", null, "retry_after_invalid"],
    [{ "retry-after": "-1" }, "invalid", null, "retry_after_invalid"],
    [{ "retry-after": "abc" }, "invalid", null, "retry_after_invalid"],
    [{ "retry-after": "" }, "invalid", null, "retry_after_invalid"],
    [{ "retry-after": "61" }, "seconds", 61, "retry_after_over_max"],
    [{ "retry-after": "3600" }, "seconds", 3600, "retry_after_over_max"],
  ];
  for (const [headers, kind, seconds, outcome] of cases) {
    const l = limited();
    const server = fakeServer({ [TEAM_READ]: script(slowDown(headers), teamOk()), [LIST]: answer(200, [], { "x-total-count": "0" }) });
    const a = make(server.fetchImpl, l.options);
    const e = await errorOf(a.verifyBoundTeam());
    assert.equal(e?.reason, "rate_limited", JSON.stringify(headers));
    assert.equal(e.rateLimit.retryAfter, kind, JSON.stringify(headers));
    assert.equal(e.rateLimit.retryAfterS, seconds, JSON.stringify(headers));
    assert.equal(e.rateLimit.outcome, outcome, JSON.stringify(headers));
    assert.equal(e.rateLimit.retryUsed, false);
    assert.deepEqual([l.sleeps, l.ticks, l.retries], [[], [], []], `no wait and no beforeRetry: ${JSON.stringify(headers)}`);
    assert.equal(server.calls.length, 1, `exactly one request: ${JSON.stringify(headers)}`);
    assert.equal(await errorOf(a.listSessions()), e);
    assert.equal(server.calls.length, 1, `nothing more: ${JSON.stringify(headers)}`);
  }
});

test("RL5 the boundaries: Retry-After 0 is repeated after one second (never at once); exactly the maximum waits; one second past it does not", async () => {
  const zero = limited();
  const s0 = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "0" }), teamOk()) });
  await make(s0.fetchImpl, zero.options).verifyBoundTeam();
  assert.deepEqual([zero.sleeps, zero.retries, s0.calls.length], [[1000], ["before"], 2]);
  const atMax = limited({}, { maxWaitMs: 20_000 });
  const s1 = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "20" }), teamOk()) });
  await make(s1.fetchImpl, atMax.options).verifyBoundTeam();
  assert.deepEqual(atMax.sleeps, [10_000, 10_000]);
  assert.equal(s1.calls.length, 2);
  const past = limited({}, { maxWaitMs: 20_000 });
  const s2 = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "21" }), teamOk()) });
  const e = await errorOf(make(s2.fetchImpl, past.options).verifyBoundTeam());
  assert.deepEqual([e?.rateLimit?.outcome, past.sleeps, s2.calls.length], ["retry_after_over_max", [], 1]);
});

test("RL14 a caller with more than one attempt: a 5xx on the repeat still waits its backoff before the next attempt (the loop and the backoff share the extended bound)", async () => {
  const l = limited();
  const server = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "1" }), answer(503, {}), teamOk()) });
  const a = make(server.fetchImpl, { ...l.options, attempts: 2, retryDelayMs: 1000 });
  assert.deepEqual(await a.verifyBoundTeam(), { visible: true, sourceTeamId: "980" });
  assert.deepEqual(l.sleeps, [1000, 2000], "the Retry-After wait, then the 5xx backoff of the second attempt");
  assert.equal(server.calls.length, 3);
});

test("RL15 a 429 on a drill read with Retry-After, and beforeRetry refuses during the wait: the caller's error goes on, the drill is not repeated, and no brief, tag or thresholds request follows", async () => {
  class Ended extends Error {}
  const l = limited({}, { beforeRetry: async () => { throw new Ended("binding_ended"); } });
  const { a, calls } = await confirmedAdapter({ [D1]: slowDown({ "retry-after": "2" }) }, (f) => make(f, l.options));
  const e = await errorOf(a.fetchSessionBundle({ sessionId: "100" }));
  assert.ok(e instanceof Ended, "never a failed drill, never a fallback label");
  const paths = pathsOf(calls);
  assert.equal(paths[paths.length - 1], D1);
  assert.equal(paths.filter((p) => p === D1).length, 1, "the drill was not repeated");
  assert.ok(!paths.includes(BRIEF) && !paths.includes(TAGS) && !paths.includes(THRESH));
  assert.deepEqual(l.sleeps, [2000]);
});

test("RL16 the refused answer's body is let go, never read and never waited for: a cancel that never settles (or throws) holds neither the wait nor the repeat", async () => {
  for (const cancel of [() => new Promise(() => {}), () => { throw new Error("cancel failed"); }]) {
    const l = limited();
    let cancelled = 0;
    const neverRead = { cancel: () => { cancelled += 1; return cancel(); }, getReader: () => { throw new Error("the 429 body must never be read"); } };
    const server = fakeServer({ [TEAM_READ]: script({ status: 429, headers: new Headers({ ...json, "retry-after": "1" }), body: neverRead, text: async () => { throw new Error("never read"); } }, teamOk()) });
    const a = make(server.fetchImpl, l.options);
    let timer;
    const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the wait was held by the body's cancel")), 2_000); });
    try {
      assert.deepEqual(await Promise.race([a.verifyBoundTeam(), stuck]), { visible: true, sourceTeamId: "980" });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(cancelled, 1);
    assert.deepEqual([l.sleeps, server.calls.length], [[1000], 2]);
  }
});

// After the repeat was spent (owner, 2026-10-23): the check's adapter has one
// attempt per read, so a repeat that fails for another reason is that failure,
// never a third request; the spent repeat is never given back, and a stop sends
// nothing more.
test("RL17 the check's one attempt: a 5xx on the repeat fails that read as the 5xx (no third request, no second wait, not a rate-limit stop); the repeat stays spent, so a later 429 with a valid Retry-After stops the instance for good", async () => {
  const l = limited();
  const server = fakeServer({
    [TEAM_READ]: script(slowDown({ "retry-after": "1" }), answer(503, { detail: "busy" }), teamOk()),
    [LIST]: script(answer(200, [], { "x-total-count": "0" }), slowDown({ "retry-after": "1" }), answer(200, [], { "x-total-count": "0" })),
  });
  const a = make(server.fetchImpl, l.options);
  const e = await errorOf(a.verifyBoundTeam());
  assert.equal(e?.code, "source_unavailable");
  assert.equal(e.status, 503);
  assert.equal(e.reason, undefined, "a 5xx is not a rate-limit stop");
  assert.deepEqual([server.calls.length, l.sleeps, l.retries], [2, [1000], ["before"]], "the 429 and its one repeat, nothing more");
  await a.listSessions();
  assert.equal(server.calls.length, 3, "a 5xx does not stop the instance: the next read is sent");
  const stop = await errorOf(a.listSessions());
  assert.equal(stop?.reason, "rate_limited");
  assert.deepEqual({ outcome: stop.rateLimit.outcome, retryUsed: stop.rateLimit.retryUsed, requestsSent: stop.rateLimit.requestsSent, first429Request: stop.rateLimit.first429Request }, { outcome: "retry_already_used", retryUsed: true, requestsSent: 4, first429Request: 1 });
  assert.deepEqual([server.calls.length, l.sleeps, l.retries], [4, [1000], ["before"]], "never a second wait or repeat");
  assert.equal(await errorOf(a.verifyBoundTeam()), stop, "the same stop, without a request");
  assert.equal(await errorOf(a.listSessions()), stop);
  assert.equal(server.calls.length, 4);
});

test("RL18 the check's one attempt: no answer to the repeat (a network error) fails that read as no answer, with no third request; the next read is sent, and a 429 after it stops the instance without a second repeat", async () => {
  const l = limited();
  const server = fakeServer({
    [TEAM_READ]: script(slowDown({ "retry-after": "2" }), () => { throw new TypeError("fetch failed"); }, teamOk()),
    [LIST]: script(answer(200, [], { "x-total-count": "0" }), slowDown({ "retry-after": "1" }), answer(200, [], { "x-total-count": "0" })),
  });
  const a = make(server.fetchImpl, l.options);
  const e = await errorOf(a.verifyBoundTeam());
  assert.deepEqual([e?.code, e?.reason, e?.status], ["source_unavailable", "no_answer", undefined]);
  assert.deepEqual([server.calls.length, l.sleeps], [2, [2000]]);
  await a.listSessions();
  assert.equal(server.calls.length, 3);
  const stop = await errorOf(a.listSessions());
  assert.deepEqual([stop?.reason, stop?.rateLimit?.outcome], ["rate_limited", "retry_already_used"]);
  assert.deepEqual([server.calls.length, l.sleeps], [4, [2000]], "never a second wait or repeat");
  assert.equal(await errorOf(a.verifyBoundTeam()), stop);
  assert.equal(server.calls.length, 4);
});

test("RL19 a drill's repeat answers 5xx: the drill set ends there (the next drill is not read); a 429 on the brief that follows stops the bundle without a repeat, and no tag or thresholds request is sent", async () => {
  const l = limited();
  const { a, calls } = await confirmedAdapter({
    [D0]: script(slowDown({ "retry-after": "1" }), answer(502, { detail: "bad gateway" })),
    [BRIEF]: slowDown({ "retry-after": "1" }),
  }, (f) => make(f, l.options));
  const e = await errorOf(a.fetchSessionBundle({ sessionId: "100" }));
  assert.deepEqual([e?.reason, e?.rateLimit?.outcome, e?.rateLimit?.requestKind], ["rate_limited", "retry_already_used", "brief_tags"]);
  const paths = pathsOf(calls);
  assert.deepEqual(paths.slice(paths.indexOf(D0)), [D0, D0, BRIEF], "the 429, its one repeat (5xx), the brief's 429 - and nothing after it");
  assert.ok(!paths.includes(D1) && !paths.includes(TAGS) && !paths.includes(THRESH));
  assert.deepEqual(l.sleeps, [1000], "one wait");
  const sent = calls.length;
  assert.equal(await errorOf(a.getTeamThresholds({ sessionId: "100" })), e, "the instance stays stopped");
  assert.equal(calls.length, sent);
});

test("RL20 a drill's repeat gets no answer: the drill set ends there; the brief, the tag list and the thresholds are the only requests after it, and a 429 on the thresholds stops the bundle without a repeat", async () => {
  const l = limited();
  const { a, calls } = await confirmedAdapter({
    [D0]: script(slowDown({ "retry-after": "1" }), () => { throw new TypeError("fetch failed"); }),
    [THRESH]: slowDown({ "retry-after": "1" }),
  }, (f) => make(f, l.options));
  const e = await errorOf(a.fetchSessionBundle({ sessionId: "100" }));
  assert.deepEqual([e?.reason, e?.rateLimit?.outcome, e?.rateLimit?.requestKind], ["rate_limited", "retry_already_used", "thresholds"]);
  const paths = pathsOf(calls);
  assert.deepEqual(paths.slice(paths.indexOf(D0)), [D0, D0, BRIEF, TAGS, THRESH], "after the failed repeat: the brief, the tag list and the thresholds, and nothing after the stop");
  assert.ok(!paths.includes(D1));
  assert.deepEqual(l.sleeps, [1000]);
  const sent = calls.length;
  assert.equal(await errorOf(a.verifyBoundTeam()), e);
  assert.equal(calls.length, sent);
});

test("RL6 one repeat per instance: after a repeat that succeeded, a later 429 is not repeated and stops the instance", async () => {
  const l = limited();
  const server = fakeServer({
    [TEAM_READ]: script(slowDown({ "retry-after": "1" }), teamOk()),
    [LIST]: script(slowDown({ "retry-after": "1" }), answer(200, [], { "x-total-count": "0" })),
  });
  const a = make(server.fetchImpl, l.options);
  await a.verifyBoundTeam();
  const e = await errorOf(a.listSessions());
  assert.equal(e?.rateLimit?.outcome, "retry_already_used");
  assert.equal(e.rateLimit.retryUsed, true);
  assert.deepEqual({ requestsSent: e.rateLimit.requestsSent, first429Request: e.rateLimit.first429Request }, { requestsSent: 3, first429Request: 1 }, "the counts of the stop and of the check's first 429");
  assert.deepEqual(l.sleeps, [1000], "one wait in the instance's whole life");
  assert.equal(server.calls.length, 3);
  assert.equal(await errorOf(a.verifyBoundTeam()), e);
  assert.equal(server.calls.length, 3);
});

test("RL7 beforeRetry refuses (a binding ended, a reconnect, a check closed elsewhere during the wait): its own error goes on, the repeat is never sent, and the instance sends nothing more", async () => {
  class Ended extends Error {}
  const l = limited({}, { beforeRetry: async () => { throw new Ended("binding_ended"); } });
  const server = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "2" }), teamOk()), [LIST]: answer(200, [], { "x-total-count": "0" }) });
  const a = make(server.fetchImpl, l.options);
  const e = await errorOf(a.verifyBoundTeam());
  assert.ok(e instanceof Ended, "the caller's own refusal, unchanged");
  assert.deepEqual(l.sleeps, [2000]);
  assert.equal(server.calls.length, 1, "the repeat was not sent");
  const after = await errorOf(a.listSessions());
  assert.equal(after?.reason, "rate_limited");
  assert.equal(after.rateLimit.outcome, "stopped_before_retry");
  assert.equal(server.calls.length, 1);
  // A tick that throws stops the same way.
  const t = limited({}, { onWaitTick: async () => { throw new Ended("closed"); } });
  const s2 = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "2" }), teamOk()) });
  const a2 = make(s2.fetchImpl, t.options);
  assert.ok((await errorOf(a2.verifyBoundTeam())) instanceof Ended);
  assert.deepEqual([t.retries, s2.calls.length], [[], 1]);
});

test("RL8 a long wait is cut into ticks, each followed by the caller's tick (the check's heartbeat)", async () => {
  const l = limited();
  const server = fakeServer({ [TEAM_READ]: script(slowDown({ "retry-after": "25" }), teamOk()) });
  await make(server.fetchImpl, l.options).verifyBoundTeam();
  assert.deepEqual(l.sleeps, [10_000, 10_000, 5_000]);
  assert.equal(l.ticks.length, 3);
  assert.ok(l.sleeps.every((ms) => ms <= 10_000));
});

test("RL9 a 429 on a drill read ends the whole bundle with the option: never a failed drill, and no brief, tag or thresholds request after it", async () => {
  const l = limited();
  const { a, calls } = await confirmedAdapter({ [D1]: slowDown() }, (f) => make(f, l.options));
  const e = await errorOf(a.fetchSessionBundle({ sessionId: "100" }));
  assert.equal(e?.reason, "rate_limited");
  assert.equal(e.rateLimit.requestKind, "drill");
  assert.equal(e.rateLimit.outcome, "no_retry_after");
  const paths = pathsOf(calls);
  assert.equal(paths[paths.length - 1], D1, "the 429 was the last request");
  assert.ok(!paths.includes(BRIEF) && !paths.includes(TAGS) && !paths.includes(THRESH), "nothing after the stop");
  // Without the option the same 429 stays a failed drill (unchanged).
  const { a: plain } = await confirmedAdapter({ [D1]: slowDown() });
  const set = await plain.getSessionDrills({ sessionId: "100" });
  assert.deepEqual([set.complete, set.failed?.reason], [false, "source_rate_limited"]);
  // And a 429 on the brief is not a missing brief with the option.
  const l2 = limited();
  const { a: b, calls: calls2 } = await confirmedAdapter({ [BRIEF]: slowDown() }, (f) => make(f, l2.options));
  const e2 = await errorOf(b.getDrillLabels({ sessionId: "100" }));
  assert.equal(e2?.reason, "rate_limited");
  assert.deepEqual(pathsOf(calls2), [BRIEF]);
});

test("RL10 the option is checked: a maximum outside 1000-120000 ms, a tick outside 1-30000 ms, no beforeRetry or a non-function tick is refused", async () => {
  const server = fakeServer({});
  const bad = [
    { maxWaitMs: 999, beforeRetry: async () => {} },
    { maxWaitMs: RATE_LIMIT_MAX_WAIT_CAP_MS + 1, beforeRetry: async () => {} },
    { maxWaitMs: 1.5, beforeRetry: async () => {} },
    { maxWaitMs: 60_000 },
    { maxWaitMs: 60_000, beforeRetry: "no" },
    { maxWaitMs: 60_000, beforeRetry: async () => {}, tickMs: 0 },
    { maxWaitMs: 60_000, beforeRetry: async () => {}, tickMs: 30_001 },
    { maxWaitMs: 60_000, beforeRetry: async () => {}, onWaitTick: 5 },
    [],
    "60000",
  ];
  for (const rateLimit of bad) assert.throws(() => make(server.fetchImpl, { rateLimit }), code("invalid_options"), JSON.stringify(rateLimit));
  assert.doesNotThrow(() => make(server.fetchImpl, { rateLimit: null }));
});

test("RL11 parseRetryAfter: only whole seconds carry a number; an HTTP date is recognised, everything else is invalid", () => {
  assert.deepEqual(parseRetryAfter(null), { kind: "absent", seconds: null });
  assert.deepEqual(parseRetryAfter(undefined), { kind: "absent", seconds: null });
  assert.deepEqual(parseRetryAfter("0"), { kind: "seconds", seconds: 0 });
  assert.deepEqual(parseRetryAfter(" 30 "), { kind: "seconds", seconds: 30 });
  assert.deepEqual(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), { kind: "date", seconds: null });
  for (const v of ["", "1.5", "-1", "+3", "30s", "1e3", "0x1f", "1234567890", "Wed, 21 Oct 2026 07:28:00 UTC", "30, 40"]) assert.equal(parseRetryAfter(v).kind, "invalid", v);
});

test("RL12 the administrator's line: integers and closed words only; the guard refuses anything else", () => {
  const facts = { requestKind: "track", requestsSent: 97, elapsedS: 104, first429Request: 96, first429ElapsedS: 61, retryAfter: "seconds", retryAfterS: 30, retryUsed: true, outcome: "second_429" };
  const line = rateLimitDiagnostic(facts);
  assert.equal(line, "op=rate_limit; request_kind=track; requests_sent=97; elapsed_s=104; first_429_request=96; first_429_elapsed_s=61; retry_after=seconds; retry_after_s=30; retry_used=yes; outcome=second_429.");
  assert.ok(rateLimitDiagnosticAccepted(line));
  assert.match(rateLimitDiagnostic({ ...facts, retryAfterS: 90_000 }), /retry_after_s=over_day;/);
  assert.match(rateLimitDiagnostic({ ...facts, retryAfter: "absent", retryAfterS: null, retryUsed: false, outcome: "no_retry_after" }), /retry_after=absent; retry_after_s=none; retry_used=no; outcome=no_retry_after\.$/);
  assert.match(rateLimitDiagnostic({ ...facts, requestKind: "https://evil.example/" }), /request_kind=other;/, "an unknown kind is `other`, never the text");
  for (const broken of [{ ...facts, requestsSent: -1 }, { ...facts, elapsedS: 1.5 }, { ...facts, requestsSent: 1_000_000 }, { ...facts, outcome: "stopped_before_retry" }, { ...facts, retryAfter: "later" }, { ...facts, retryUsed: "yes" }, null, "x"]) {
    assert.equal(rateLimitDiagnostic(broken), null, JSON.stringify(broken));
  }
  for (const bad of [`${line} `, line.replace("track", "track 4711"), line.replace("97", "97; url=https://x"), line.replace("second_429", "second"), `${line}x`, line.replace(".", ";")]) assert.equal(rateLimitDiagnosticAccepted(bad), false, bad);
  assert.ok(!RATE_LIMIT_OUTCOMES.includes("stopped_before_retry"), "a stop before the repeat keeps the caller's own code, never this line");
});

test("RL13 only a check waits: the import check passes rateLimitRetry, the identity load does not; the wait is far inside the stale bound", () => {
  const service = fs.readFileSync(path.join(SRC, "gpexeImportService.js"), "utf8");
  const identity = fs.readFileSync(path.join(SRC, "gpexeAthleteIdentityService.js"), "utf8");
  assert.equal((service.match(/openImportSource\([^)]*rateLimitRetry: true/g) || []).length, 1);
  assert.ok(/openImportSource\(/.test(identity) && !/rateLimitRetry/.test(identity), "the identity load never waits");
  assert.ok(IMPORT_RATE_LIMIT_MAX_WAIT_MS <= RATE_LIMIT_MAX_WAIT_CAP_MS);
  assert.ok(IMPORT_RATE_LIMIT_WAIT_TICK_MS <= 10_000);
  const staleMinutes = Number(/export const CHECK_STALE_AFTER_MINUTES = (\d+);/.exec(service)?.[1]);
  assert.ok(staleMinutes > 0, "the stale bound is read from the service");
  assert.ok(IMPORT_RATE_LIMIT_MAX_WAIT_MS + IMPORT_RATE_LIMIT_WAIT_TICK_MS < staleMinutes * 60_000 / 5, "a whole wait is a small part of the stale bound");
  const resolver = fs.readFileSync(path.join(SRC, "sourceImportCredentialResolver.js"), "utf8");
  assert.match(resolver, /assertImportSourceStillUsable\(issued\)/, "the facts are checked again before the repeat");
  const adapter = fs.readFileSync(path.join(SRC, "gpexeRestV1Adapter.js"), "utf8");
  assert.equal((adapter.match(/rl\.retryUsed = true/g) || []).length, 1, "one place marks the one repeat");
});
