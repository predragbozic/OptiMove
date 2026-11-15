// Option A, A2: the browser's error capture and Settings -> App health.
//   1. what is sent is a closed shape: no message, URL, id, name or e-mail, ever;
//   2. in-memory limits: the same error once a minute, at most N a minute, nothing when signed out, a failed send is silent;
//   3. api.js reports a 5xx, no answer, an unreadable answer - and nothing for an ordinary refusal or for the report route;
//   4. the screen: groups, filters, details, empty and error states, escaping; the tab only for a platform admin.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const SECRET = "ana.example@example.invalid";

const C = await import("../app-errors-capture.js");
const { api } = await import("../api.js");
const { state } = await import("../state.js");
const D = await import("../app-health-data.js");
const { renderAppHealthPanelHtml } = await import("../app-health-view.js");
const { handleAppHealthAction } = await import("../app-health-actions.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
C.setCaptureContext({ getUser: () => state.currentUser, getScreen: () => state.activeTab });

const KEYS = new Set(["screen", "action", "code", "status", "stackSig", "release"]);
// The device of a report has its own test (app-errors-capture.test.mjs, 7); the reporters here leave it out.
let sent;
const capture = () => { sent = []; C.setReporterForTests(C.createReporter({ send: async (b) => { sent.push(b); }, getDevice: () => null })); };

test("1. the report is a closed shape", () => {
  const err = new Error(`failed for ${SECRET} token=abc`);
  err.stack = `Error: failed for ${SECRET} token=abc\n    at renderImports (https://app.example/assets/app-Ba80peD.js?v=1:10:20)\n    at start (https://app.example/app.js:3:4)\n    at https://app.example/x/y.js:1:1`;
  const body = C.buildReport({ screen: "Training Load", action: "training-load-gpexe-open", code: "js_error", status: undefined, error: err });
  assert.deepEqual(Object.keys(body).sort(), ["action", "code", "screen", "stackSig"]);
  assert.equal(body.screen, "training_load");
  assert.equal(body.stackSig, "renderImports@app-Ba80peD.js > start@app.js > anonymous@y.js");
  assert.ok(!JSON.stringify(body).match(/example|token|abc|failed/));
  assert.ok(Object.keys(body).every((k) => KEYS.has(k)));
  // the Firefox / Safari shape
  const ff = new Error("x"); ff.stack = "renderImports@https://app.example/app.js:10:20\nstart@https://app.example/app.js:3:4";
  assert.equal(C.stackSigOf(ff), "renderImports@app.js > start@app.js");
  assert.equal(C.stackSigOf({ message: "x", stack: "Error: x" }), null);
  assert.equal(C.stackSigOf(null), null);
  // a message line that looks like a frame is not read as one
  const tricky = new Error("x\n    at secret-ana-example (file.js:1:1)"); tricky.stack = "Error: x\n    at secret-ana-example (file.js:1:1)\n    at real (a.js:1:1)";
  assert.equal(C.stackSigOf(tricky), "real@a.js");
  assert.equal(C.wordOf("A b/c?d=e@f", "x"), "a_b_c_d_e_f");
  assert.equal(C.wordOf("", "fallback"), "fallback");
  assert.deepEqual(C.buildReport({ screen: "home", code: "http_500", status: 500 }), { screen: "home", code: "http_500", status: 500 });
  assert.equal(C.buildReport({ screen: "home", code: "x", status: 99 }).status, undefined);
  const long = new Error("x"); long.stack = "Error: x\n" + ["queryBuiltInSeriesFromContext@trainingLoadDashboardQuery.js", "resolveFactsToRowsAndShiftRanges@trainingLoadDashboardQuery.js", "executeDashboardQueryForWidgets@trainingLoadDashboardWidgets.js", "handler@trainingLoadDashboard.js"].map((f) => `    at ${f.split("@")[0]} (https://a/${f.split("@")[1]}:1:1)`).join("\n");
  const sig = C.stackSigOf(long);
  assert.ok(sig && sig.length <= 200 && sig.startsWith("queryBuiltInSeriesFromContext@"));
});

test("2. limits: repeat once a minute, N a minute, signed out sends nothing, a failed send is silent", async () => {
  let t = 1_000_000;
  const out = [];
  const r = C.createReporter({ send: async (b) => { out.push(b); }, now: () => t, perMinute: 3, getDevice: () => null });
  assert.equal(r({ screen: "home", code: "js_error" }), true);
  assert.equal(r({ screen: "home", code: "js_error" }), false, "the same error within a minute");
  for (const code of ["a", "b"]) assert.equal(r({ screen: "home", code }), true);
  assert.equal(r({ screen: "home", code: "c" }), false, "more than N a minute");
  t += 61_000;
  assert.equal(r({ screen: "home", code: "js_error" }), true, "a new minute");
  assert.equal(out.length, 4);
  const failing = C.createReporter({ send: async () => { throw new Error("offline"); } });
  assert.equal(failing({ screen: "home", code: "x" }), true);
  await new Promise((res) => setTimeout(res, 5));
  const throwing = C.createReporter({ send: () => { throw new Error("sync"); } });
  assert.equal(throwing({ screen: "home", code: "x" }), false);
  // an error before sign-in spends no slot: the same error after sign-in is still sent
  let earlySignedIn = false; const sent2 = [];
  const early = C.createReporter({ send: async (b) => { sent2.push(b); }, isSignedIn: () => earlySignedIn, getDevice: () => null });
  assert.equal(early({ screen: "home", code: "boot_error" }), false);
  earlySignedIn = true;
  assert.equal(early({ screen: "home", code: "boot_error" }), true);
  assert.equal(sent2.length, 1);
  // the default sender: nothing when signed out; a POST of the closed body when signed in
  let calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 204 }; };
  state.currentUser = null;
  const signedOut = C.createReporter({});
  signedOut({ screen: "home", code: "js_error" });
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(calls.length, 0, "a signed-out page sends nothing");
  state.currentUser = { id: "u" };
  const signedIn = C.createReporter({});
  signedIn({ screen: "home", code: "js_error" });
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/app-errors");
  assert.equal(calls[0].options.method, "POST");
  // The default reporter adds the device it reads itself: here this process's own navigator, which is no browser.
  assert.deepEqual(JSON.parse(calls[0].options.body), { screen: "home", code: "js_error", device: { class: "unknown", os: "other", browser: "other" } });
  state.currentUser = null;
});

test("3. api.js reports a 5xx, no answer and an unreadable answer; nothing for a refusal or for the report route", async () => {
  capture();
  state.activeTab = "training-load";
  const reply = (status, body, { json = true } = {}) => { globalThis.fetch = async () => ({ ok: status < 300, status, statusText: "", json: async () => { if (!json) throw new SyntaxError("<html>"); return body; } }); };
  reply(500, { error: "internal_error", message: `boom ${SECRET}` });
  await assert.rejects(api("/api/athletes/3f2b8c1e-1111-4222-8333-444455556666/plans?token=abc"));
  assert.deepEqual(sent, [{ screen: "training-load", action: "api_call", code: "internal_error", status: 500 }]);
  capture(); reply(502, { error: "Bad Gateway & more" }); await assert.rejects(api("/api/x"));
  assert.deepEqual(sent, [{ screen: "training-load", action: "api_call", code: "http_502", status: 502 }]);
  capture(); globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); }; await assert.rejects(api("/api/x"));
  assert.deepEqual(sent, [{ screen: "training-load", action: "api_call", code: "no_response" }]);
  capture(); reply(200, null, { json: false }); await assert.rejects(api("/api/x"));
  assert.deepEqual(sent.map((b) => b.code), ["unexpected_response"]);
  capture(); reply(502, null, { json: false }); await assert.rejects(api("/api/x2"));
  assert.deepEqual(sent.map((b) => b.code), ["http_502"], "a 5xx page that is not JSON");
  capture(); reply(418, null, { json: false }); await assert.rejects(api("/api/x3"));
  assert.deepEqual(sent.map((b) => b.code), ["unexpected_response"], "a refusal that is not JSON");
  for (const [status, body] of [[400, { error: "invalid" }], [403, { error: "forbidden" }], [404, { error: "Not found" }], [409, { error: "try_again" }]]) { capture(); reply(status, body); await assert.rejects(api("/api/x")); assert.deepEqual(sent, [], `${status} is an ordinary refusal`); }
  capture(); reply(401, null, { json: false }); await assert.rejects(api("/api/x")); assert.deepEqual(sent, [], "a signed-out answer is not an error of the app");
  capture(); reply(500, { error: "internal_error" }); await assert.rejects(api("/api/app-errors")); assert.deepEqual(sent, [], "the report route is never reported");
  capture(); globalThis.fetch = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }; await assert.rejects(api("/api/x")); assert.deepEqual(sent, [], "an abort is the page's own choice");
  capture(); globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "", json: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } }); await assert.rejects(api("/api/x")); assert.deepEqual(sent, [], "an abort while the body is read too");
  capture(); C.noteAction("training-load-gpexe-open"); reply(500, { error: "internal_error" }); await assert.rejects(api("/api/x"));
  assert.equal(sent[0].action, "training-load-gpexe-open");
  assert.ok(!JSON.stringify(sent).match(/token|example|3f2b8c1e|plans/));
});

const GROUPS = [
  { fingerprint: "a".repeat(64), source: "server", screen: null, routeTemplate: "/api/athletes/:id/plans", action: null, code: "internal_error", status: 500, release: "0123456789abcdef", stackSignature: "handler@athletes.js > query@db.js", occurrences: 14, users: 3, firstSeenAt: "2026-11-08T08:00:00Z", lastSeenAt: "2026-11-09T07:30:00Z", roles: ["coach", "athlete"] },
  { fingerprint: "b".repeat(64), source: "client", screen: "training-load", routeTemplate: null, action: "training-load-gpexe-open", code: "js_error", status: null, release: null, stackSignature: "renderImports@app.js", occurrences: 2, users: 1, firstSeenAt: "2026-11-09T06:00:00Z", lastSeenAt: "2026-11-09T06:30:00Z", roles: ["platform_admin"] },
  { fingerprint: "c".repeat(64), source: "client", screen: "<img src=x onerror=alert(1)>", routeTemplate: null, action: null, code: "no_response", status: null, release: null, stackSignature: null, occurrences: 1, users: 1, firstSeenAt: "2026-11-09T06:00:00Z", lastSeenAt: "2026-11-09T06:30:00Z", roles: ["user"] },
];
function serveGroups(groups, status = 200) {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return { ok: status < 300, status, statusText: "", json: async () => (status < 300 ? { days: 7, groups } : { error: "Not found" }) }; };
  return calls;
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test("4. the screen: groups, filters, details, empty and error states, escaping, and the tab only for a platform admin", async () => {
  let calls = serveGroups(GROUPS);
  state.appHealth = D.emptyAppHealth();
  const renders = [];
  const render = () => renders.push(renderAppHealthPanelHtml());
  await D.loadAppHealth(render);
  assert.deepEqual(calls, ["/api/app-errors/groups?days=7"]);
  let html = renderAppHealthPanelHtml();
  assert.match(html, /\/api\/athletes\/:id\/plans/);
  assert.match(html, /14 times · 3 people/);
  // Design PR4: the row says what happened in words; the code and the status are a small second line.
  assert.match(html, /<span class="app-health-what">Server error<small class="app-health-code">internal_error · HTTP 500<\/small><\/span>/);
  assert.match(html, /3 kinds of errors · 17 times · most recent first/);
  assert.match(html, /Since 08\.11\.2026/);
  assert.ok(!/stack|renderImports@app\.js/.test(html), "the details are folded until a group is opened");
  assert.ok(!html.includes("<img src=x"), "a stored word is escaped");
  // details
  await handleAppHealthAction({ dataset: { action: "app-health-open", fingerprint: "b".repeat(64) } }, { render });
  html = renderAppHealthPanelHtml();
  assert.match(html, /renderImports@app\.js/);
  assert.match(html, /training-load-gpexe-open/);
  assert.match(html, /Platform admin/);
  assert.match(html, /bbbbbbbbbbbb/);
  assert.ok(!html.replace(/<[^>]*>/g, "").includes("bbbbbbbbbbbbb"), "only a short group id is shown");
  await handleAppHealthAction({ dataset: { action: "app-health-open", fingerprint: "b".repeat(64) } }, { render });
  assert.ok(!/renderImports@app\.js/.test(renderAppHealthPanelHtml()), "a second tap folds it");
  // filters
  await handleAppHealthAction({ dataset: { action: "app-health-role", role: "platform_admin" } }, { render });
  html = renderAppHealthPanelHtml();
  const listOf = (h) => h.split('class="app-health-list')[1] || "";
  assert.match(listOf(html), /training-load/); assert.ok(!/\/api\/athletes/.test(listOf(html)));
  await handleAppHealthAction({ dataset: { action: "app-health-role", role: "all" } }, { render });
  await handleAppHealthAction({ dataset: { action: "app-health-where", where: "/api/athletes/:id/plans" } }, { render });
  html = renderAppHealthPanelHtml();
  assert.match(listOf(html), /14 times/); assert.ok(!/training-load/.test(listOf(html)));
  await handleAppHealthAction({ dataset: { action: "app-health-role", role: "none" } }, { render });
  assert.match(renderAppHealthPanelHtml(), /No errors match these filters\./);
  assert.match(renderAppHealthPanelHtml(), /Showing groups where at least one affected person is Signed out\. The counts cover everyone in the group\./);
  await handleAppHealthAction({ dataset: { action: "app-health-clear" } }, { render });
  assert.equal(state.appHealth.role, "all"); assert.equal(state.appHealth.where, "all");
  assert.match(listOf(renderAppHealthPanelHtml()), /14 times/, "Clear filters brings the groups back");
  // a place that has no group in the new period stops being a filter
  state.appHealth.where = "/api/athletes/:id/plans";
  serveGroups([GROUPS[1]]);
  await D.loadAppHealth(render);
  assert.equal(state.appHealth.where, "all");
  calls = serveGroups(GROUPS); await D.loadAppHealth(render);
  // period reads again
  await handleAppHealthAction({ dataset: { action: "app-health-days", days: "30" } }, { render });
  assert.equal(calls.at(-1), "/api/app-errors/groups?days=30");
  await handleAppHealthAction({ dataset: { action: "app-health-days", days: "999" } }, { render });
  assert.equal(calls.length, 2, "an unknown period sends nothing");
  // empty and error
  serveGroups([]); state.appHealth = D.emptyAppHealth(); await D.loadAppHealth(render);
  assert.match(renderAppHealthPanelHtml(), /No errors recorded in the last 7 days\./);
  serveGroups([], 404); state.appHealth = D.emptyAppHealth(); await D.loadAppHealth(render);
  assert.match(renderAppHealthPanelHtml(), /only available to a platform administrator/);
  serveGroups([], 500); state.appHealth = D.emptyAppHealth(); await D.loadAppHealth(render);
  assert.match(renderAppHealthPanelHtml(), /could not be loaded/);
  // a newer read wins
  state.appHealth = D.emptyAppHealth();
  let release; const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (url) => { if (url.includes("days=7")) await gate; return { ok: true, status: 200, statusText: "", json: async () => ({ groups: url.includes("days=7") ? [GROUPS[0]] : [GROUPS[1]] }) }; };
  const older = D.loadAppHealth(render);
  state.appHealth.days = 1; const newer = D.loadAppHealth(render); await newer; release(); await older; await flush();
  assert.equal(state.appHealth.groups[0].fingerprint, "b".repeat(64), "the older answer never replaces the newer one");
  // nothing loaded yet is said, not blank
  state.appHealth = D.emptyAppHealth();
  assert.match(renderAppHealthPanelHtml(), /Press Refresh/);
  // a late answer never repaints Settings over another screen
  const { handleOrganizationAction } = await import("../organization-actions.js");
  let painted = 0; let releaseLate; const lateGate = new Promise((r) => { releaseLate = r; });
  globalThis.fetch = async () => { await lateGate; return { ok: true, status: 200, statusText: "", json: async () => ({ groups: [] }) }; };
  state.organization = { ...(state.organization || {}), section: "overview" }; state.activeTab = "organization";
  await handleOrganizationAction({ dataset: { action: "organization-section", section: "appHealth" } }, { renderOrganizationPanel: () => { painted += 1; } });
  const afterEntry = painted;
  state.activeTab = "weekly"; releaseLate(); await flush(); await flush();
  assert.equal(painted, afterEntry, "no repaint once the person is on another tab");
  // the server cannot tell people apart (its hashing key is not set): said in one line, with the glyph, and gone once it can
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "", json: async () => ({ people: "not_configured", groups: [GROUPS[0]] }) });
  state.activeTab = "organization"; state.appHealth = D.emptyAppHealth();
  await D.loadAppHealth(() => {});
  assert.equal(state.appHealth.people, "not_configured");
  assert.match(renderAppHealthPanelHtml(), /app-health-people-off[^>]*>⚠ People are not counted for new errors/);
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "", json: async () => ({ people: "keyed", groups: [GROUPS[0]] }) });
  await D.loadAppHealth(() => {});
  assert.ok(!/app-health-people-off/.test(renderAppHealthPanelHtml()));
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "", json: async () => ({ groups: [GROUPS[0]] }) });
  await D.loadAppHealth(() => {});
  assert.ok(!/app-health-people-off/.test(renderAppHealthPanelHtml()), "an older server says nothing and nothing is claimed");
  // the tab
  assert.match(renderSettingsNavHtml({ isPlatformAdmin: true }), /data-section="appHealth"/);
  assert.ok(!/appHealth/.test(renderSettingsNavHtml({ isPlatformAdmin: false })));
});

test("the words for an error that says what failed: the kind in plain words, the code beside it as before; an unknown second part falls back", async () => {
  const { codeWords } = await import("../app-health-view.js");
  assert.equal(codeWords("unhandled_rejection.aborterror"), "A background task failed: a request or playback was stopped");
  assert.equal(codeWords("js_error.script_error"), "A page crashed: the browser hid the error of a foreign script");
  assert.equal(codeWords("handler_error.typeerror"), "An action failed: a value was missing");
  assert.equal(codeWords("handler_error"), "An action failed");
  assert.equal(codeWords("unhandled_rejection"), "A background task failed");
  assert.equal(codeWords("unhandled_rejection.__proto__"), "Error");
  // A code is a word a signed-in browser chose: a name every object has is never read as a label.
  for (const planted of ["constructor", "__proto__", "toString", "constructor.aborterror", "__proto__.aborterror", "hasOwnProperty.typeerror"]) {
    assert.equal(codeWords(planted), "Error", planted);
    assert.equal(codeWords(planted, 500), "Server error", planted);
  }
  assert.equal(codeWords("some.server.code", 503), "Server error");
  assert.equal(codeWords("some.server.code", 409), "Error");
});

test("AH-2. the devices of an error: at most three in words with their counts, one phrase each, the others counted, 'Device not recorded' when none was; nothing for a server error", async () => {
  const { deviceWords, deviceParts, MAX_DEVICE_LINES } = await import("../app-health-view.js");
  assert.equal(deviceWords({ class: "phone", os: "ios", browser: "safari", major: 17 }), "iPhone · Safari 17");
  assert.equal(deviceWords({ class: "tablet", os: "ios", browser: "webview" }), "iPad · In-app browser");
  assert.equal(deviceWords({ class: "phone", os: "android", browser: "chrome", major: 142 }), "Android phone · Chrome 142");
  assert.equal(deviceWords({ class: "tablet", os: "android", browser: "samsung", major: 25 }), "Android tablet · Samsung Internet 25");
  assert.equal(deviceWords({ class: "desktop", os: "windows", browser: "edge", major: 126 }), "Windows · Edge 126");
  assert.equal(deviceWords({ class: "desktop", os: "macos", browser: "safari", major: 17 }), "Mac · Safari 17");
  assert.equal(deviceWords({ class: "desktop", os: "linux", browser: "firefox", major: 127 }), "Linux · Firefox 127");
  assert.equal(deviceWords({ class: "desktop", os: "chromeos", browser: "chrome", major: 126 }), "Chromebook · Chrome 126");
  assert.equal(deviceWords({ class: "desktop", os: "other", browser: "other" }), "Computer · Other browser");
  assert.equal(deviceWords({ class: "unknown", os: "other", browser: null }), "Unknown device");
  assert.equal(deviceWords({ class: "unknown", os: "ios" }), "Apple device");
  assert.equal(deviceWords({}), "Unknown device");
  assert.equal(deviceWords(null), "Unknown device");
  // A word the lists do not hold is never shown as it is: own keys only, a version only as a small whole number.
  assert.equal(deviceWords({ class: "constructor", os: "__proto__", browser: "toString", major: "17<b>" }), "Unknown device");
  assert.equal(deviceWords({ class: "<img src=x>", os: "<script>", browser: "chrome", major: 1000 }), "Unknown device · Chrome");

  const base = { fingerprint: "d".repeat(64), source: "client", screen: "weekly", code: "js_error", occurrences: 9, users: 2, firstSeenAt: "2026-11-09T06:00:00Z", lastSeenAt: "2026-11-09T07:00:00Z", roles: ["coach"] };
  const three = [{ class: "phone", os: "ios", browser: "safari", major: 17, occurrences: 3 }, { class: "phone", os: "android", browser: "chrome", major: 142, occurrences: 1 }, { class: "desktop", os: "windows", browser: "edge", major: 126, occurrences: 1 }];
  assert.deepEqual(deviceParts({ ...base, devices: three.slice(0, 2) }), ["iPhone · Safari 17 · 3 times", "Android phone · Chrome 142 · 1 time"]);
  assert.deepEqual(deviceParts({ ...base, devices: three, otherDevices: 2, otherDeviceOccurrences: 5, deviceNotRecorded: 4 }),
    ["iPhone · Safari 17 · 3 times", "Android phone · Chrome 142 · 1 time", "Windows · Edge 126 · 1 time", "2 other device types · 5 times", "device not recorded · 4 times"]);
  assert.deepEqual(deviceParts({ ...base, devices: three.slice(0, 1), otherDevices: 1, otherDeviceOccurrences: 1, deviceNotRecorded: 1 }), ["iPhone · Safari 17 · 3 times", "1 other device type · 1 time", "device not recorded · 1 time"]);
  assert.deepEqual(deviceParts({ ...base, devices: three.slice(0, 1), otherDevices: 2 }), ["iPhone · Safari 17 · 3 times", "2 other device types"], "without their count the others are still said");
  assert.equal(deviceParts({ ...base, devices: [...three, ...three] }).length, MAX_DEVICE_LINES, "never more than three devices, whatever the server sends");
  assert.deepEqual(deviceParts({ ...base, devices: [], deviceNotRecorded: 9 }), ["Device not recorded"]);
  assert.deepEqual(deviceParts(base), ["Device not recorded"], "an older server sends no devices");
  assert.deepEqual(deviceParts({ ...base, devices: "iPhone" }), ["Device not recorded"]);
  assert.deepEqual(deviceParts({ ...base, devices: [{ class: "phone", os: "ios", occurrences: "many" }], otherDevices: -3, otherDeviceOccurrences: "x", deviceNotRecorded: "x" }), ["iPhone · 0 times"]);
  assert.deepEqual(deviceParts({ ...base, source: "server", devices: three }), [], "a server error has no device");

  // On the screen: one phrase per device inside the row, escaped, for a browser error only.
  serveGroups([{ ...base, devices: three.slice(0, 2), otherDevices: 0, deviceNotRecorded: 1 }, GROUPS[0], { ...GROUPS[1], devices: [{ class: "<img src=x onerror=alert(1)>", os: "other", browser: "<b>", occurrences: 2 }] }, GROUPS[2]]);
  state.activeTab = "organization"; state.appHealth = D.emptyAppHealth();
  await D.loadAppHealth(() => {});
  const html = renderAppHealthPanelHtml();
  assert.match(html, /<span class="app-health-devices"><span class="app-health-device">iPhone · Safari 17 · 3 times<\/span><span class="app-health-device">Android phone · Chrome 142 · 1 time<\/span><span class="app-health-device">device not recorded · 1 time<\/span><\/span>/);
  assert.equal((html.match(/class="app-health-devices"/g) || []).length, 3, "three browser errors, one server error");
  assert.match(html, /<span class="app-health-devices"><span class="app-health-device">Unknown device · 2 times<\/span><\/span>/);
  assert.match(html, /<span class="app-health-devices"><span class="app-health-device">Device not recorded<\/span><\/span>/);
  assert.ok(!html.includes("<img src=x onerror") && !html.includes("<b>"));
  // The phrases are inside the row's button, so they are read with the row and add no control.
  const row = html.slice(html.indexOf('data-fingerprint="' + "d".repeat(64)), html.indexOf("</button>", html.indexOf('data-fingerprint="' + "d".repeat(64))));
  assert.ok(row.includes("app-health-devices"));
});
