// The browser's error capture (frontend/app-errors-capture.js): what failed is reported as one word of a closed list
// (the error's name, never its message), a failing click handler is reported once with the control really used, and
// a refused full screen is never an unhandled rejection. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { readFile } from "node:fs/promises";

const C = await import("../app-errors-capture.js");
const appJs = await readFile(new URL("../app.js", import.meta.url), "utf8");
const sent = [];
const reporterFor = () => C.createReporter({ send: (body) => { sent.push(body); }, isSignedIn: () => true, dedupeMs: 0, perMinute: 1000 });
const SECRET = "Secret Athlete Name 2001-02-03";

test("1. reasonOf: the error's name as a word of the list, never its message; every other value has its own word", () => {
  const dom = new JSDOM("");
  const DomEx = dom.window.DOMException;
  assert.equal(C.reasonOf(new DomEx(SECRET, "AbortError")), "aborterror");
  assert.equal(C.reasonOf(new DomEx(SECRET, "NotAllowedError")), "notallowederror");
  assert.equal(C.reasonOf(new DomEx(SECRET, "InvalidStateError")), "invalidstateerror");
  assert.equal(C.reasonOf(new TypeError(SECRET)), "typeerror");
  assert.equal(C.reasonOf(new Error(SECRET)), "other_error");
  assert.equal(C.reasonOf(Object.assign(new Error(SECRET), { name: SECRET })), "other_error", "an unknown name is never sent as it is");
  assert.equal(C.reasonOf({ name: "Whatever" }), "other_error");
  assert.equal(C.reasonOf({ message: SECRET }), "non_error");
  assert.equal(C.reasonOf(SECRET), "non_error");
  assert.equal(C.reasonOf(42), "non_error");
  assert.equal(C.reasonOf(undefined), "none");
  assert.equal(C.reasonOf(null), "none");
  assert.equal(C.reasonOf({ get name() { throw new Error("x"); } }), "non_error", "a hostile getter never throws out");
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(C.reasonOf(revoked.proxy), "non_error", "nor does a revoked proxy");
  for (const value of [new DomEx("x", "AbortError"), new TypeError("x"), SECRET, null, { name: "Odd" }]) assert.ok(C.REASONS.includes(C.reasonOf(value)));
  // A window "error" event.
  assert.equal(C.reasonOfErrorEvent({ error: new RangeError("x") }), "rangeerror");
  assert.equal(C.reasonOfErrorEvent({ error: null, message: "Script error." }), "script_error");
  assert.equal(C.reasonOfErrorEvent({ error: null, message: SECRET }), "no_error_object");
  assert.equal(C.reasonOfErrorEvent({}), "no_error_object");
});

test("2. a native rejection has no frames, so the report carries no stack and still says what failed", () => {
  const dom = new JSDOM("");
  const aborted = new dom.window.DOMException("The operation was aborted.", "AbortError");
  assert.equal(C.stackSigOf({ name: "AbortError", message: "The operation was aborted." }), null);
  assert.equal(C.stackSigOf({ name: "AbortError", message: "x", stack: "AbortError: x" }), null, "a header line only is no frame");
  const body = C.buildReport({ screen: "weekly", action: "open-media", code: "unhandled_rejection", error: null, reason: C.reasonOf(aborted) });
  assert.deepEqual(body, { screen: "weekly", code: "unhandled_rejection", reason: "aborterror", action: "open-media" });
  // A word outside the list is left out, never sent.
  assert.equal("reason" in C.buildReport({ screen: "weekly", code: "js_error", reason: SECRET }), false);
  assert.equal("reason" in C.buildReport({ screen: "weekly", code: "js_error" }), false);
  assert.ok(!JSON.stringify(body).includes("aborted."), "no message");
});

test("3. the installed listeners send the word with each kind of error, and two reasons are two reports", () => {
  sent.length = 0;
  const dom = new JSDOM(`<button data-action="open-media">x</button>`);
  C.installAppErrorCapture({ getUser: () => ({ id: "u" }), getScreen: () => "weekly" }, dom.window, dom.window.document);
  C.setReporterForTests(reporterFor());
  dom.window.document.querySelector("button").click();
  const fire = (type, init) => dom.window.dispatchEvent(Object.assign(new dom.window.Event(type), init));
  fire("unhandledrejection", { reason: new dom.window.DOMException(SECRET, "NotAllowedError") });
  fire("unhandledrejection", { reason: new dom.window.DOMException(SECRET, "AbortError") });
  fire("unhandledrejection", { reason: SECRET });
  fire("unhandledrejection", { reason: undefined });
  fire("error", { error: null, message: "Script error." });
  fire("error", { error: null, message: SECRET });
  assert.deepEqual(sent.map((b) => [b.code, b.reason, b.action]), [
    ["unhandled_rejection", "notallowederror", "open-media"], ["unhandled_rejection", "aborterror", "open-media"],
    ["unhandled_rejection", "non_error", "open-media"], ["unhandled_rejection", "none", "open-media"],
    ["js_error", "script_error", "open-media"], ["js_error", "no_error_object", "open-media"]]);
  assert.ok(!JSON.stringify(sent).includes("Secret"), "nothing of a message or a reason's text is sent");
  for (const body of sent) assert.deepEqual(Object.keys(body).filter((k) => !["screen", "action", "code", "status", "stackSig", "reason", "device"].includes(k)), []);
  C.setReporterForTests(null);
});

test("4. guardHandler: a click handler that rejects or throws is reported once as handler_error with the control really used, and is no unhandled rejection", async () => {
  sent.length = 0;
  const dom = new JSDOM(`<div id="content"><button data-action="first-thing">a</button><button data-action="open-media"><span>b</span></button></div>`);
  C.installAppErrorCapture({ getUser: () => ({ id: "u" }), getScreen: () => "weekly" }, dom.window, dom.window.document);
  C.setReporterForTests(reporterFor());
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const content = dom.window.document.getElementById("content");
    let mode = "reject";
    let open;
    const gate = new Promise((r) => { open = r; });
    content.addEventListener("click", C.guardHandler(async () => {
      if (mode === "reject") throw new dom.window.DOMException(SECRET, "AbortError");
      if (mode === "plain") throw new TypeError(SECRET);
      if (mode === "late") { await gate; throw new TypeError(SECRET); }
      return "fine";
    }));
    content.addEventListener("click", C.guardHandler(() => { if (mode === "sync") throw new RangeError(SECRET); }));
    // The last tapped control was another one: the report names the control of THIS click.
    dom.window.document.querySelector('[data-action="first-thing"]').click();
    await new Promise((r) => setTimeout(r, 5));
    sent.length = 0;
    logged.length = 0;
    dom.window.document.querySelector('[data-action="open-media"] span').click();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(sent.map((b) => [b.code, b.reason, b.action, b.screen]), [["handler_error", "aborterror", "open-media", "weekly"]]);
    mode = "plain";
    dom.window.document.querySelector('[data-action="open-media"]').click();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([sent[1].code, sent[1].reason, sent[1].action], ["handler_error", "typeerror", "open-media"]);
    assert.match(sent[1].stackSig, /@app-errors-capture\.test\.mjs/, "a script error keeps its own frames");
    mode = "sync";
    dom.window.document.querySelector('[data-action="open-media"]').click();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([sent[2].code, sent[2].reason], ["handler_error", "rangeerror"]);
    mode = "fine";
    dom.window.document.querySelector('[data-action="open-media"]').click();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 3, "a handler that succeeds reports nothing");
    // A failure that lands after another control was tapped still names the control of its own click.
    mode = "late";
    dom.window.document.querySelector('[data-action="open-media"]').click();
    mode = "fine";
    dom.window.document.querySelector('[data-action="first-thing"]').click();
    open();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([sent.length, sent[3].code, sent[3].action], [4, "handler_error", "open-media"]);
    sent.pop();
    logged.pop();
    assert.deepEqual(unhandled, [], "no rejection is left unhandled");
    const said = logged.filter((args) => args[0] instanceof Error || args[0]?.name === "AbortError");
    assert.equal(said.length, 3, "each failure is still said in the console");
    assert.ok(!JSON.stringify(sent).includes("Secret"));
    // A click on something with no data-action, right after a click with one: the report names no control at all.
    const bare = dom.window.document.createElement("p");
    content.appendChild(bare);
    mode = "plain";
    dom.window.document.querySelector('[data-action="first-thing"]').click();
    await new Promise((r) => setTimeout(r, 5));
    sent.length = 0;
    bare.click();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual([sent.length, sent[0].code, "action" in sent[0]], [1, "handler_error", false], "never the control tapped last");
    // A promise the handler starts and does not wait for: detached() reports its rejection; it is never unhandled.
    sent.length = 0;
    C.detached(Promise.reject(new TypeError(SECRET)), "open-tab");
    C.detached(Promise.resolve("fine"));
    C.detached(undefined);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(sent.map((b) => [b.code, b.reason, b.action]), [["handler_error", "typeerror", "open-tab"]]);
    assert.deepEqual(unhandled, [], "still no rejection left unhandled");
    assert.ok(!JSON.stringify(sent).includes("Secret"));
  } finally {
    console.error = originalError;
    process.off("unhandledRejection", onUnhandled);
    C.setReporterForTests(null);
  }
});

test("5. before the capture is installed nothing is reported, and the guard still swallows nothing silently", async () => {
  sent.length = 0;
  C.setReporterForTests(null);
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    C.reportHandlerError(new Error("x"), "open-media");
    assert.equal(sent.length, 0);
    assert.equal(logged.length, 1);
  } finally { console.error = originalError; }
});

test("6. the lists are one list: the server's, the browser's and the screen's words; app.js guards its two click listeners and leaves no tab load unwatched", async () => {
  // The server's list, read from its source (the module itself needs a database to load).
  const serverSource = await readFile(new URL("../../backend/src/appErrorTracking.js", import.meta.url), "utf8");
  const listed = serverSource.match(/export const CLIENT_REASONS = Object\.freeze\(\[([^\]]+)\]\);/);
  assert.ok(listed, "the server's list is where it is expected");
  assert.deepEqual(listed[1].match(/"([a-z_]+)"/g).map((w) => w.slice(1, -1)), [...C.REASONS], "the server accepts exactly the words the browser sends");
  for (const word of C.NAMED_REASONS) assert.equal(C.reasonOf({ name: word.toUpperCase() }), word);
  for (const word of C.REASONS) assert.match(word, /^[a-z_]{1,30}$/);
  const { codeWords } = await import("../app-health-view.js");
  for (const word of C.REASONS) assert.ok(codeWords(`js_error.${word}`).startsWith("A page crashed: "), `the screen has words for ${word}`);
  assert.match(appJs, /els\.content\.addEventListener\("click", guardHandler\(handleContentClick\)\);/);
  assert.match(appJs, /document\.addEventListener\("click", guardHandler\(handleGlobalClick\)\);/);
  // Every call of the tab loader is waited for, returned, chained or handed to detached().
  const loose = appJs.split("\n").filter((line) => /loadActiveTab\(\)/.test(line) && !/^\s*\/\//.test(line)
    && !/(await |return |detached\(|\.then\(|async function loadActiveTab|=> loadActiveTab\(\)|Promise\.resolve\(loadActiveTab\(\)\))/.test(line));
  assert.deepEqual(loose, [], "no tab load is started and left unwatched");
  // The exercise editor's opening, started from the guarded content listener, is watched too, with its own control.
  assert.equal((appJs.match(/detached\(openExerciseEditor\([^\n]*\), type\);/g) || []).length, 2);
  assert.equal(/void openExerciseEditor\(/.test(appJs), false);
});

const UAS = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneInApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SomeApp/455.0",
  ipadAsMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidWebview: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

test("7. the device: six words of the closed lists chosen in the browser; the User-Agent itself never leaves", async () => {
  const d = (ua, touch, width) => C.deviceOf({ userAgent: ua, maxTouchPoints: touch }, { innerWidth: width });
  assert.deepEqual(d(UAS.iphoneSafari, 5, 390), { class: "phone", os: "ios", browser: "safari", touch: true, major: 17, viewport: "360_479" });
  assert.deepEqual(d(UAS.iphoneChrome, 5, 375), { class: "phone", os: "ios", browser: "chrome", touch: true, major: 126, viewport: "360_479" });
  assert.deepEqual(d(UAS.iphoneInApp, 5, 320), { class: "phone", os: "ios", browser: "webview", touch: true, viewport: "lt_360" });
  assert.deepEqual(d(UAS.ipadAsMac, 5, 820), { class: "tablet", os: "ios", browser: "safari", touch: true, major: 17, viewport: "768_1023" }, "an iPad that says it is a Mac");
  assert.deepEqual(d(UAS.macSafari, 0, 1440), { class: "desktop", os: "macos", browser: "safari", touch: false, major: 17, viewport: "ge_1440" });
  assert.deepEqual(d(UAS.androidChrome, 5, 412), { class: "phone", os: "android", browser: "chrome", touch: true, major: 126, viewport: "360_479" });
  assert.deepEqual(d(UAS.androidTablet, 10, 800), { class: "tablet", os: "android", browser: "chrome", touch: true, major: 125, viewport: "768_1023" });
  assert.deepEqual(d(UAS.androidSamsung, 5, 360), { class: "phone", os: "android", browser: "samsung", touch: true, major: 25, viewport: "360_479" });
  assert.deepEqual(d(UAS.androidWebview, 5, 600), { class: "phone", os: "android", browser: "webview", touch: true, viewport: "480_767" });
  assert.deepEqual(d(UAS.windowsEdge, 0, 1280), { class: "desktop", os: "windows", browser: "edge", touch: false, major: 126, viewport: "1024_1439" });
  assert.deepEqual(d(UAS.windowsFirefox, 10, 1366), { class: "desktop", os: "windows", browser: "firefox", touch: true, major: 127, viewport: "1024_1439" });
  assert.deepEqual(d(UAS.linuxChrome, 0, 1920), { class: "desktop", os: "linux", browser: "chrome", touch: false, major: 126, viewport: "ge_1440" });
  assert.deepEqual(d(UAS.chromeOs, 0, 1366), { class: "desktop", os: "chromeos", browser: "chrome", touch: false, major: 126, viewport: "1024_1439" });
  assert.deepEqual(d("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/111.0.0.0", 0, 1280),
    { class: "desktop", os: "windows", browser: "other", touch: false, viewport: "1024_1439" }, "a Chromium browser outside the list is not called Chrome");
  // Nothing readable: the fallback words, no width, never a throw.
  assert.deepEqual(C.deviceOf({}, {}), { class: "unknown", os: "other", browser: "other" });
  assert.deepEqual(C.deviceOf(null, null), { class: "unknown", os: "other", browser: "other" });
  assert.equal("touch" in C.deviceOf({ userAgent: UAS.iphoneSafari }, { innerWidth: 390 }), false, "no touch-point count is unknown, not no touch");
  assert.deepEqual(d(SECRET, 0, NaN), { class: "unknown", os: "other", browser: "other", touch: false });
  assert.equal(C.deviceOf({ get userAgent() { throw new Error("x"); } }, {}), null, "a hostile navigator gives no device");
  for (const [w, bucket] of [[359, "lt_360"], [360, "360_479"], [479, "360_479"], [480, "480_767"], [767, "480_767"], [768, "768_1023"], [1023, "768_1023"], [1024, "1024_1439"], [1439, "1024_1439"], [1440, "ge_1440"], [0, null], [-5, null]]) {
    assert.equal(C.viewportBucket(w), bucket, String(w));
  }
  // Every word is one of the server's, read from its source; and the lists are the same lists.
  const serverSource = await readFile(new URL("../../backend/src/appErrorTracking.js", import.meta.url), "utf8");
  for (const key of ["class", "os", "browser", "viewport"]) {
    const listed = serverSource.match(new RegExp(`\\b${key}: Object\\.freeze\\(\\[([^\\]]+)\\]\\)`));
    assert.deepEqual(listed[1].match(/"([a-z0-9_]+)"/g).map((w) => w.slice(1, -1)), [...C.DEVICE_LISTS[key]], key);
  }
  // In the report: the checked device only; a word outside a list, an extra key or the User-Agent is never sent.
  for (const ua of Object.values(UAS)) {
    const body = C.buildReport({ screen: "weekly", code: "js_error", device: d(ua, 1, 400) });
    assert.deepEqual(Object.keys(body.device).filter((k) => !["class", "os", "browser", "major", "viewport", "touch"].includes(k)), []);
    assert.ok(!JSON.stringify(body).includes("Mozilla"));
  }
  assert.deepEqual(C.buildReport({ screen: "weekly", code: "js_error", device: { class: UAS.macSafari, os: "ios", ua: UAS.macSafari, major: 17, touch: "yes" } }).device, { os: "ios" }, "the major goes with its family only");
  assert.equal("device" in C.buildReport({ screen: "weekly", code: "js_error", device: { ua: UAS.macSafari } }), false);
  assert.equal("device" in C.buildReport({ screen: "weekly", code: "js_error" }), false);
  // The reporter adds the device itself, read at the time of the error.
  const out = [];
  let width = 390;
  const report = C.createReporter({ send: (b) => { out.push(b); }, isSignedIn: () => true, dedupeMs: 0, getDevice: () => d(UAS.iphoneSafari, 5, width) });
  report({ screen: "weekly", code: "js_error" });
  width = 800;
  report({ screen: "weekly", code: "js_error" });
  assert.deepEqual(out.map((b) => b.device.viewport), ["360_479", "768_1023"]);
  const broken = C.createReporter({ send: (b) => { out.push(b); }, isSignedIn: () => true, getDevice: () => null });
  assert.equal(broken({ screen: "weekly", code: "js_error" }), true, "an unreadable device never stops a report");
  assert.equal("device" in out.at(-1), false);
});

test("8. a tab's load that nobody waits for reports with the fixed word open-tab", () => {
  assert.equal((appJs.match(/detached\(loadActiveTab\(\), "open-tab"\);/g) || []).length, 7);
  assert.equal(/detached\(loadActiveTab\(\)\);/.test(appJs), false);
  assert.match(appJs, /detached\(openLibraryTab\(button\.dataset\), "open-tab"\);/);
  assert.match(appJs, /detached\(loadCoachHomeExtras\(\{ onChange: refreshCoachHomeSection, forceRefresh \}\), "open-tab"\);/);
});
