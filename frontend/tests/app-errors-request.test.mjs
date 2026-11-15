// App health, AH-2b: which request failed (a method and a route pattern, never a URL), the build of the page, a
// report that could not be delivered and goes out late - once, never in a loop - and what the screen says about it.
// Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const C = await import("../app-errors-capture.js");
const { api } = await import("../api.js");
const { state } = await import("../state.js");
const D = await import("../app-health-data.js");
const V = await import("../app-health-view.js");
const BUILD = "0123456789abcdef0123456789abcdef01234567";
const ID = "3f2b8c1e-1111-4222-8333-444455556666";
const tick = () => new Promise((r) => setTimeout(r, 0));

test("1. routeOf: the path as a pattern - the query and the fragment cut, an id ':id', a segment of other characters ':x'; never a URL", () => {
  for (const [path, route] of [
    ["/api/x", "/api/x"],
    [`/api/athletes/${ID}/plans?token=abc&name=Ana`, "/api/athletes/:id/plans"],
    ["/api/exercises/12#top", "/api/exercises/:id"],
    ["/api/media/0123456789abcdef0123", "/api/media/:id"],
    [`/api/x/${"a".repeat(41)}`, "/api/x/:id"],
    ["/api/athletes/Ana%20Example/plans", "/api/athletes/:x/plans"],
    ["/api/users/ana.example@example.invalid", "/api/users/:x"],
    ["/api/x/", "/api/x/"],
    ["/", "/"],
  ]) assert.equal(C.routeOf(path), route, path);
  for (const bad of ["api/x", "https://app.example/api/x", "", null, undefined, 12, { path: "/api/x" }]) assert.equal(C.routeOf(bad), null, String(bad));
  assert.ok(C.routeOf(`/${"ab/".repeat(100)}`).length <= 120);
  // In the report: the method of five (GET when the call names none), the route; anything else leaves the request out.
  const report = (request) => C.buildReport({ screen: "weekly", code: "no_response", request });
  assert.deepEqual(report({ method: "post", path: `/api/athletes/${ID}/plans?token=abc` }).request, { method: "POST", route: "/api/athletes/:id/plans" });
  assert.deepEqual(report({ path: "/api/x" }).request, { method: "GET", route: "/api/x" });
  for (const request of [{ method: "HEAD", path: "/api/x" }, { method: "GET", path: "api/x" }, { method: "GET" }, null, undefined]) assert.equal("request" in report(request), false, JSON.stringify(request));
  assert.deepEqual(Object.keys(report({ method: "GET", path: "/api/x" }).request), ["method", "route"], "two keys, never the path");
  assert.deepEqual(C.REQUEST_METHODS, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
});

test("2. the page's build: the commit word of the build's own meta tag, or nothing; sent as `release` only in that shape", () => {
  const doc = (content) => new JSDOM(`<meta name="optimove-build" content="${content}">`).window.document;
  assert.equal(C.pageBuild(doc(BUILD)), BUILD);
  assert.equal(C.pageBuild(doc(` ${BUILD.slice(0, 7).toUpperCase()} `)), BUILD.slice(0, 7));
  for (const odd of ["dev", "", "v1.2.3", "abc", "g".repeat(40), "a".repeat(41), "abcdef1 <b>"]) assert.equal(C.pageBuild(doc(odd)), "", odd);
  assert.equal(C.pageBuild(new JSDOM("").window.document), "");
  assert.equal(C.pageBuild(null), "");
  assert.equal(C.pageBuild({ querySelector() { throw new Error("x"); } }), "", "never throws");
  assert.equal(C.buildReport({ screen: "weekly", code: "js_error", build: BUILD }).release, BUILD);
  for (const odd of ["dev", "", null, 12, "ABCDEF1", "abc def"]) assert.equal("release" in C.buildReport({ screen: "weekly", code: "js_error", build: odd }), false, String(odd));
  // The reporter stamps every report with it.
  const sent = [];
  const report = C.createReporter({ send: (b) => { sent.push(b); }, getDevice: () => null, getBuild: () => BUILD, dedupeMs: 0 });
  report({ screen: "weekly", code: "js_error" });
  report({ screen: "weekly", code: "no_response", request: { method: "GET", path: "/api/x" } });
  assert.deepEqual(sent, [{ screen: "weekly", code: "js_error", release: BUILD }, { screen: "weekly", code: "no_response", request: { method: "GET", route: "/api/x" }, release: BUILD }]);
});

test("3. the same failure on two requests is two reports; the same request once a minute", () => {
  const sent = [];
  const report = C.createReporter({ send: (b) => { sent.push(b); }, getDevice: () => null, getBuild: () => "" });
  const fail = (method, path) => report({ screen: "weekly", action: "api_call", code: "no_response", request: { method, path } });
  assert.deepEqual([fail("GET", "/api/x"), fail("GET", "/api/y"), fail("POST", "/api/x"), fail("GET", "/api/x?again=1"), fail("GET", "/api/y")], [true, true, true, false, false]);
  assert.deepEqual(sent.map((b) => `${b.request.method} ${b.request.route}`), ["GET /api/x", "GET /api/y", "POST /api/x"]);
});

test("4. a report that got no answer is held in memory - five at most - and sent once more, marked late, after a call that did get one; never again", async () => {
  let time = 1_000_000;
  let online = false;
  const attempts = [];
  const send = async (body) => { attempts.push(body); if (!online) throw new TypeError("Failed to fetch"); return { ok: true }; };
  const report = C.createReporter({ send, getDevice: () => null, getBuild: () => BUILD, now: () => time, dedupeMs: 0, perMinute: 1000 });
  const fail = (n) => report({ screen: "weekly", action: "api_call", code: "no_response", request: { method: "GET", path: `/api/r${n}` } });
  assert.equal(report.flushLate(), 0, "nothing held, nothing sent");
  for (let n = 1; n <= 7; n += 1) fail(n);
  await tick();
  assert.equal(attempts.length, 7);
  assert.equal(report.heldCount(), C.MAX_HELD_REPORTS, "the first five; the rest are dropped");
  assert.equal(C.MAX_HELD_REPORTS, 5);
  // Still offline: the one later attempt fails too, and nothing is held again.
  time += 30_000;
  assert.equal(report.flushLate(), 5);
  await tick();
  assert.equal(attempts.length, 12);
  assert.equal(report.heldCount(), 0, "never a retry loop");
  assert.equal(report.flushLate(), 0);
  assert.deepEqual(attempts.slice(7).map((b) => [b.request.route, b.late]), [1, 2, 3, 4, 5].map((n) => [`/api/r${n}`, "lt_1m"]));
  // An answer of any kind is final: a report the server answered - even with a refusal - is not held.
  online = true;
  attempts.length = 0;
  fail(8);
  await tick();
  assert.equal(report.heldCount(), 0);
  // How late, as a word.
  online = false;
  fail(9);
  await tick();
  online = true;
  time += 20 * 60_000;
  attempts.length = 0;
  assert.equal(report.flushLate(), 1);
  await tick();
  assert.deepEqual(attempts, [{ screen: "weekly", code: "no_response", action: "api_call", request: { method: "GET", route: "/api/r9" }, release: BUILD, late: "lt_1h" }]);
  assert.deepEqual([0, 59_999, 60_000, 599_999, 600_000, 3_599_999, 3_600_000, 9e9].map(C.lateBucket), ["lt_1m", "lt_1m", "lt_10m", "lt_10m", "lt_1h", "lt_1h", "ge_1h", "ge_1h"]);
  assert.deepEqual(C.LATE_BUCKETS, ["lt_1m", "lt_10m", "lt_1h", "ge_1h"]);
  // A sender that throws at once, and a person who signed out meanwhile: dropped, silently.
  let signedIn = true;
  const thrower = C.createReporter({ send: () => { throw new Error("x"); }, isSignedIn: () => signedIn, getDevice: () => null, getBuild: () => "", dedupeMs: 0 });
  assert.equal(thrower({ screen: "weekly", code: "js_error" }), false);
  assert.equal(thrower.heldCount(), 0);
  const out = [];
  let reach = false;
  const leaver = C.createReporter({ send: async (b) => { out.push(b); if (!reach) throw new TypeError("x"); }, isSignedIn: () => signedIn, getDevice: () => null, getBuild: () => "", dedupeMs: 0 });
  leaver({ screen: "weekly", code: "no_response" });
  await tick();
  assert.equal(leaver.heldCount(), 1);
  signedIn = false; reach = true; out.length = 0;
  assert.equal(leaver.flushLate(), 0);
  await tick();
  assert.deepEqual([out.length, leaver.heldCount()], [0, 0], "a signed-out page sends nothing, and keeps nothing");
});

test("5. api.js: a call that got an answer sends what was held; a failed call, a refusal and the report route do not", async () => {
  let online = false;
  const attempts = [];
  C.setReporterForTests(C.createReporter({ send: async (b) => { attempts.push(b); if (!online) throw new TypeError("Failed to fetch"); }, getDevice: () => null, getBuild: () => "" }));
  state.activeTab = "weekly";
  const reply = (status, body) => { globalThis.fetch = async () => ({ ok: status < 300, status, statusText: "", json: async () => body }); };
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(api("/api/media/access", { method: "POST", body: "{}" }));
  await tick();
  assert.deepEqual(attempts.map((b) => [b.code, b.request.method, b.request.route, b.late]), [["no_response", "POST", "/api/media/access", undefined]]);
  // Another failed call, a refusal, the report route answering: nothing is flushed.
  await assert.rejects(api("/api/media/access", { method: "POST", body: "{}" }));
  reply(403, { error: "forbidden" });
  await assert.rejects(api("/api/x"));
  reply(200, { ok: true });
  await api("/api/app-errors/groups?days=7");
  await tick();
  assert.equal(attempts.length, 1);
  // The server answers an ordinary call: the held report goes out, late, once.
  online = true;
  await api("/api/x");
  await tick();
  assert.deepEqual(attempts.slice(1).map((b) => [b.code, b.request.route, b.late]), [["no_response", "/api/media/access", "lt_1m"]]);
  await api("/api/x");
  await tick();
  assert.equal(attempts.length, 2, "once");
  // Before the capture is installed nothing is flushed, and a reporter without the queue does not throw.
  C.setReporterForTests(null);
  assert.equal(C.flushLateReports(), 0);
  C.setReporterForTests(() => true);
  assert.equal(C.flushLateReports(), 0);
  C.setReporterForTests(null);
});

test("6. the screen: the request beside the code; 'around a server restart' and 'page older than the server' with a glyph and a count; nothing invented when unknown", async () => {
  const { requestWords, timingParts } = V;
  assert.equal(requestWords({ request: { method: "POST", route: "/api/media/access" } }), "POST /api/media/access");
  for (const g of [{}, { request: null }, { request: { method: "HEAD", route: "/api/x" } }, { request: { method: "GET", route: "/api/x?token=1" } }, { request: { method: "GET", route: "<img>" } },
    { request: { method: "GET", route: `/${"a".repeat(130)}` } }, { request: { method: "GET" } }, { request: "GET /api/x" }]) assert.equal(requestWords(g), "", JSON.stringify(g).slice(0, 60));
  assert.deepEqual(timingParts({ occurrences: 6, aroundRestart: 3, deliveredLate: 1, pageBehindServer: 2 }), ["↻ Around a server restart · 3 of 6 times (1 delivered late)", "⇅ Page older than the server · 2 of 6 times"]);
  assert.deepEqual(timingParts({ occurrences: 4, aroundRestart: 4, deliveredLate: 0, pageBehindServer: 0 }), ["↻ Around a server restart · 4 times"]);
  assert.deepEqual(timingParts({ occurrences: 1, aroundRestart: 1, pageBehindServer: 1 }), ["↻ Around a server restart · 1 time", "⇅ Page older than the server · 1 time"]);
  for (const g of [{}, null, { occurrences: 5 }, { occurrences: 5, aroundRestart: 0, pageBehindServer: 0, deliveredLate: 0 }, { occurrences: 5, aroundRestart: "3", pageBehindServer: -1 }, { occurrences: 5, aroundRestart: 1.5 }]) assert.deepEqual(timingParts(g), [], JSON.stringify(g));

  const group = (over) => ({ fingerprint: "a".repeat(64), source: "client", screen: "weekly", routeTemplate: null, action: "open-media", code: "no_response", status: null, release: null, stackSignature: null,
    occurrences: 6, users: 2, firstSeenAt: "2026-11-14T08:00:00Z", lastSeenAt: "2026-11-15T07:30:00Z", roles: ["coach"], devices: [], otherDevices: 0, otherDeviceOccurrences: 0, deviceNotRecorded: 0, ...over });
  const show = async (groups, selected = null) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "", json: async () => ({ days: 7, people: "keyed", groups }) });
    state.appHealth = D.emptyAppHealth();
    await D.loadAppHealth(() => {});
    state.appHealth.selected = selected;
    return V.renderAppHealthPanelHtml();
  };
  let html = await show([group({ request: { method: "POST", route: "/api/media/access" }, aroundRestart: 3, deliveredLate: 1, pageBehindServer: 2 }), group({ fingerprint: "b".repeat(64), code: "js_error", request: null, aroundRestart: 0, deliveredLate: 0, pageBehindServer: 0 })]);
  assert.match(html, /<small class="app-health-code">no_response · POST \/api\/media\/access<\/small>/);
  assert.match(html, /<small class="app-health-code">js_error<\/small>/, "no request: the code alone, as before");
  assert.match(html, /<span class="app-health-devices app-health-timing"><span class="app-health-device">↻ Around a server restart · 3 of 6 times \(1 delivered late\)<\/span><span class="app-health-device">⇅ Page older than the server · 2 of 6 times<\/span><\/span>/);
  assert.equal(html.split("app-health-timing").length - 1, 1, "only the kind that has something to say");
  // The detail names the request on its own line - or says it was not recorded.
  html = await show([group({ request: { method: "POST", route: "/api/media/access" } })], "a".repeat(64));
  assert.match(html, /<dt>Request<\/dt><dd>POST \/api\/media\/access<\/dd>/);
  // A hostile or broken value from the wire is never rendered.
  html = await show([group({ request: { method: "GET", route: "/api/<img src=x onerror=alert(1)>" }, aroundRestart: "<b>", pageBehindServer: { a: 1 } })], "a".repeat(64));
  assert.ok(!html.includes("<img") && !html.includes("<b>") && !html.includes("app-health-timing"));
});
