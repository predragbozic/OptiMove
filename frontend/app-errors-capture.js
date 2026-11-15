// Option A, A2: the browser reports the errors it hits (window error, unhandled rejection, a failed API call) to
// /api/app-errors, in the closed shape the server accepts: screen, action, code, status, stackSig.
//
// Nothing a person typed or the server said is ever sent: no message, no URL, no id, no query string. The screen is the
// app's own tab name, the action the last data-action the person used (a fixed word of the code), the code a stable word
// (js_error, unhandled_rejection, no_response, unexpected_response, http_5xx or the server's own error code), the
// stack only as function@file names. Reporting is best effort: it never throws, never shows anything, never waits,
// is limited in memory (the same error once a minute, at most MAX_PER_MINUTE in all) and sends nothing for a signed-out page.
// No import of state.js on purpose: api.js imports this module and state.js (through the exercise editor) imports api.js; the app passes
// its state in installAppErrorCapture({ getUser, getScreen }).
let context = { getUser: () => null, getScreen: () => "app" };
export function setCaptureContext(next) { context = { ...context, ...next }; }

export const MAX_PER_MINUTE = 10;
export const DEDUPE_MS = 60_000;
const MAX_KEYS = 200;
const LAST_ACTION_MS = 10_000;
const WORD = /^[a-z0-9_.-]{1,60}$/;
const FRAME = "[A-Za-z0-9_$.]{1,40}@[A-Za-z0-9_.-]{1,40}";
const STACK_SIGNATURE = new RegExp(`^${FRAME}( > ${FRAME}){0,3}$`);

// A lower-case word of the closed shape, or the fallback.
export function wordOf(value, fallback = "unknown") {
  const w = String(value ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return WORD.test(w) ? w : fallback;
}

// function@file names of the first frames of an error's stack (Chrome "at fn (url:1:2)", Firefox/Safari "fn@url:1:2"),
// whole frames only, at most 200 characters; null when nothing usable remains.
export function stackSigOf(error) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const headerLines = String(error?.message ?? "").split("\n").length;
  const frames = [];
  for (const line of stack.split("\n").slice(/^\s*at\s/.test(stack.split("\n")[headerLines] || "") || stack.includes("\n    at ") ? headerLines : 0)) {
    let fn = ""; let url = "";
    let m = line.match(/^\s*at\s+(?:async\s+)?(?:(\S+)\s+\()?(.+?)\)?\s*$/);
    if (m) { fn = m[1] || ""; url = m[2]; } else if ((m = line.match(/^([^@\s]*)@(.+)$/))) { fn = m[1]; url = m[2]; } else continue;
    const file = url.replace(/[?#].*$/, "").replace(/:\d+(:\d+)?$/, "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);
    if (!file) continue;
    const name = fn.replace(/[^A-Za-z0-9_$.]/g, "").slice(0, 40) || "anonymous";
    const frame = `${name}@${file}`;
    if ([...frames, frame].join(" > ").length > 200) break;
    frames.push(frame);
    if (frames.length >= 4) break;
  }
  const sig = frames.join(" > ");
  return sig && STACK_SIGNATURE.test(sig) ? sig : null;
}

// What failed, as one word of the server's closed list (backend/src/appErrorTracking.js CLIENT_REASONS): the `name` of
// the error or of the rejection's reason, never its message. A native rejection - an aborted request, a refused
// play() or full screen - carries no script frames, so this word is all it can say about itself.
// The names an error object can report as its own word; every other value falls into one of the fixed words after them.
export const NAMED_REASONS = Object.freeze(["aborterror", "notallowederror", "notsupportederror", "invalidstateerror", "securityerror", "networkerror",
  "timeouterror", "quotaexceedederror", "typeerror", "referenceerror", "rangeerror", "syntaxerror"]);
export const REASONS = Object.freeze([...NAMED_REASONS, "other_error", "non_error", "none", "script_error", "no_error_object"]);
const NAMED = new Set(NAMED_REASONS);
// The word for a thrown or rejected value: none (nothing), non_error (a value that is not an error object), the
// error's own name when it is one of the list, other_error for any other error object.
export function reasonOf(value) {
  if (value === undefined || value === null) return "none";
  if (typeof value !== "object" && typeof value !== "function") return "non_error";
  // Reading a hostile value (a throwing getter, a revoked proxy) never throws out of the capture.
  try {
    const name = typeof value.name === "string" ? value.name.toLowerCase() : "";
    if (NAMED.has(name)) return name;
    return name || value instanceof Error ? "other_error" : "non_error";
  } catch {
    return "non_error";
  }
}
// The word for a window "error" event: its error object's, or - with no object - whether the browser hid the error
// of a script it treats as foreign ("Script error.") or gave nothing at all.
export function reasonOfErrorEvent(event) {
  if (event?.error !== undefined && event?.error !== null) return reasonOf(event.error);
  return event?.message === "Script error." ? "script_error" : "no_error_object";
}

// ---- the device of a report (v70): six facts, each a word of the server's closed lists ----
// Reduced HERE, in the browser: the User-Agent string is read to choose a word and is never sent or stored.
export const DEVICE_LISTS = Object.freeze({
  class: Object.freeze(["phone", "tablet", "desktop", "unknown"]),
  os: Object.freeze(["ios", "android", "windows", "macos", "linux", "chromeos", "other"]),
  browser: Object.freeze(["safari", "chrome", "firefox", "edge", "samsung", "webview", "other"]),
  viewport: Object.freeze(["lt_360", "360_479", "480_767", "768_1023", "1024_1439", "ge_1440"]),
});
export function viewportBucket(width) {
  if (!Number.isFinite(width) || width <= 0) return null;
  if (width < 360) return "lt_360";
  if (width < 480) return "360_479";
  if (width < 768) return "480_767";
  if (width < 1024) return "768_1023";
  if (width < 1440) return "1024_1439";
  return "ge_1440";
}
function majorOf(ua, pattern) {
  const n = Number((ua.match(pattern) || [])[1]);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}
// { class, os, browser, major?, viewport?, touch } from a navigator and a window; never throws, never the UA itself.
export function deviceOf(nav = globalThis.navigator, win = globalThis.window) {
  try {
    const ua = typeof nav?.userAgent === "string" ? nav.userAgent : "";
    const touchPoints = Number(nav?.maxTouchPoints) || 0;
    // An iPad asks for the desktop site as a Mac: a "Mac" with a touch screen is an iPad.
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
    let os = "other";
    if (/iPhone|iPod/.test(ua) || ipad) os = "ios";
    else if (/Android/.test(ua)) os = "android";
    else if (/CrOS/.test(ua)) os = "chromeos";
    else if (/Windows/.test(ua)) os = "windows";
    else if (/Macintosh|Mac OS X/.test(ua)) os = "macos";
    else if (/Linux|X11/.test(ua)) os = "linux";
    let browser = "other"; let major = null;
    // A Chromium browser with its own name and no word in the list is "other", not Chrome.
    if (/OPR\/|YaBrowser\/|UCBrowser\//.test(ua)) { browser = "other"; }
    else if (/SamsungBrowser\//.test(ua)) { browser = "samsung"; major = majorOf(ua, /SamsungBrowser\/(\d+)/); }
    else if (/Edg(?:e|A|iOS)?\//.test(ua)) { browser = "edge"; major = majorOf(ua, /Edg(?:e|A|iOS)?\/(\d+)/); }
    else if (/Firefox\/|FxiOS\//.test(ua)) { browser = "firefox"; major = majorOf(ua, /(?:Firefox|FxiOS)\/(\d+)/); }
    // An app's own in-app browser: Android's "; wv)", or iOS WebKit without the Safari token.
    else if (/; wv\)/.test(ua) || (os === "ios" && /AppleWebKit/.test(ua) && !/Safari\//.test(ua))) { browser = "webview"; }
    else if (/Chrome\/|CriOS\//.test(ua)) { browser = "chrome"; major = majorOf(ua, /(?:Chrome|CriOS)\/(\d+)/); }
    else if (/Safari\//.test(ua) && /Version\//.test(ua)) { browser = "safari"; major = majorOf(ua, /Version\/(\d+)/); }
    let cls = "unknown";
    if (ipad || (os === "android" && !/Mobile/.test(ua))) cls = "tablet";
    else if (/iPhone|iPod/.test(ua) || (os === "android" && /Mobile/.test(ua))) cls = "phone";
    else if (["windows", "macos", "linux", "chromeos"].includes(os)) cls = "desktop";
    const device = { class: cls, os, browser };
    // A browser that does not say how many touch points it has is unknown, not "no touch".
    if (typeof nav?.maxTouchPoints === "number") device.touch = touchPoints > 0;
    if (major) device.major = major;
    const viewport = viewportBucket(Number(win?.innerWidth));
    if (viewport) device.viewport = viewport;
    return device;
  } catch {
    return null;
  }
}
// Exactly the server's shape, or nothing: a value outside a list is dropped whole rather than sent.
function checkedDevice(device) {
  if (!device || typeof device !== "object") return null;
  const out = {};
  for (const key of ["class", "os", "browser", "viewport"]) if (DEVICE_LISTS[key].includes(device[key])) out[key] = device[key];
  if (Number.isInteger(device.major) && device.major >= 1 && device.major <= 999 && out.browser) out.major = device.major;
  if (typeof device.touch === "boolean") out.touch = device.touch;
  return Object.keys(out).length ? out : null;
}

// ---- which request failed (v73): its method and its path as a route pattern, never a URL ----
// The same reduction the server applies to its own routes and applies AGAIN to this one (appErrorTracking.js
// normalizeRoute): the query and the fragment are cut, an id (a UUID, a number, a long hex or any long segment)
// becomes ":id", a segment of other characters ":x". The server then keeps only the words its own routes contain.
export const REQUEST_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export function routeOf(path) {
  if (typeof path !== "string") return null;
  const bare = path.split("?")[0].split("#")[0];
  if (!bare.startsWith("/")) return null;
  const segments = bare.split("/").slice(1).map((seg) => {
    if (seg === "") return "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (/^\d+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
    if (seg.length > 40) return ":id";
    if (!/^[A-Za-z0-9_.:-]+$/.test(seg)) return ":x";
    return seg;
  });
  const out = `/${segments.join("/")}`.slice(0, 120);
  return /^\/[A-Za-z0-9_/:.-]*$/.test(out) ? out : null;
}
function requestOf(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const route = routeOf(request?.path);
  return REQUEST_METHODS.includes(method) && route ? { method, route } : null;
}
// The build this page was made from (the production build's <meta name="optimove-build">), as a commit word, or "".
export function pageBuild(doc = globalThis.document) {
  try {
    const stamp = String(doc?.querySelector?.('meta[name="optimove-build"]')?.getAttribute("content") || "").trim().toLowerCase();
    return /^[0-9a-f]{7,40}$/.test(stamp) ? stamp : "";
  } catch {
    return "";
  }
}
// How long a report was held before it could be delivered, as the server's word.
export const LATE_BUCKETS = Object.freeze(["lt_1m", "lt_10m", "lt_1h", "ge_1h"]);
export const lateBucket = (ms) => (ms < 60_000 ? "lt_1m" : ms < 600_000 ? "lt_10m" : ms < 3_600_000 ? "lt_1h" : "ge_1h");
// At most this many undelivered reports are kept, in memory only, for one later attempt each.
export const MAX_HELD_REPORTS = 5;

// The report body, exactly the keys the server accepts, or null.
export function buildReport({ screen, action, code, status, error, reason, device, request, build }) {
  const body = { screen: wordOf(screen, "app").replace(/[.]/g, "-"), code: wordOf(code, "js_error") };
  if (REASONS.includes(reason)) body.reason = reason;
  if (action) body.action = wordOf(action, "unknown");
  if (Number.isInteger(status) && status >= 100 && status <= 599) body.status = status;
  const sig = stackSigOf(error);
  if (sig) body.stackSig = sig;
  const dev = checkedDevice(device);
  if (dev) body.device = dev;
  const req = request ? requestOf(request) : null;
  if (req) body.request = req;
  if (typeof build === "string" && /^[0-9a-f]{7,40}$/.test(build)) body.release = build;
  return body;
}

export function createReporter({ send: sendIn, isSignedIn: signedIn, now = () => Date.now(), perMinute = MAX_PER_MINUTE, dedupeMs = DEDUPE_MS, getDevice = deviceOf, getBuild = pageBuild } = {}) {
  // The default sender needs a signed-in page; an injected sender (a test) decides for itself.
  const send = sendIn || defaultSend;
  const isSignedIn = signedIn || (sendIn ? () => true : () => Boolean(context.getUser()));
  const seen = new Map();
  let windowStart = 0;
  let inWindow = 0;
  // Reports whose own request failed (the server could not be reached): kept here, in memory, for ONE later attempt.
  const held = [];
  function report(input) {
    try {
      if (!isSignedIn()) return false; // before any slot is spent: an error before sign-in must not hide the same one after it
      const body = buildReport({ ...input, device: getDevice(), build: getBuild() });
      const t = now();
      if (t - windowStart >= 60_000) { windowStart = t; inWindow = 0; }
      if (inWindow >= perMinute) return false;
      const key = [body.screen, body.action || "", body.code, body.reason || "", body.status ?? "", body.stackSig || "", body.request ? `${body.request.method} ${body.request.route}` : ""].join("|");
      if (t - (seen.get(key) ?? -Infinity) < dedupeMs) return false;
      if (seen.size >= MAX_KEYS) for (const [k, ts] of seen) if (t - ts >= dedupeMs) seen.delete(k);
      if (seen.size >= MAX_KEYS) return false;
      seen.set(key, t);
      inWindow += 1;
      // A send that got no answer at all (the same outage, usually) is held; an answer of any kind is final.
      Promise.resolve(send(body)).then(undefined, () => { if (held.length < MAX_HELD_REPORTS) held.push({ body, at: t }); });
      return true;
    } catch {
      return false;
    }
  }
  // Called after a request that DID get an answer: each held report is sent once more, marked late with how long it
  // was held. Whatever happens to that attempt, the report is not kept: never a retry loop.
  report.flushLate = function flushLate() {
    if (!held.length) return 0;
    const due = held.splice(0, held.length);
    try {
      if (!isSignedIn()) return 0;
      for (const { body, at } of due) {
        try { Promise.resolve(send({ ...body, late: lateBucket(Math.max(0, now() - at)) })).then(undefined, () => {}); } catch { /* dropped */ }
      }
      return due.length;
    } catch {
      return 0;
    }
  };
  report.heldCount = () => held.length;
  return report;
}

export function defaultSend(body) {
  return fetch("/api/app-errors", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

let lastAction = { word: "", at: 0 };
export function noteAction(word, at = Date.now()) { lastAction = { word: wordOf(word, ""), at }; }
export function currentAction(at = Date.now()) { return at - lastAction.at <= LAST_ACTION_MS && lastAction.word ? lastAction.word : ""; }
export function currentScreen() { try { return context.getScreen() || "app"; } catch { return "app"; } }

// Reporting is inert until the app installs the capture (app.js init): a page or a test that never installs it sends nothing.
let active = false;
let report = createReporter({ send: defaultSend });
export function setReporterForTests(r) { report = r; active = Boolean(r); }

// A failed API call (api.js calls this; never for the report route itself).
export function reportApiFailure({ code, status, method, path }) {
  if (!active) return;
  report({ screen: currentScreen(), action: currentAction() || "api_call", code, status, request: { method, path } });
}
// api.js calls this after a request that got an answer: reports held during an outage go out now, once.
export function flushLateReports() {
  if (!active) return 0;
  try { return report.flushLate?.() ?? 0; } catch { return 0; }
}

// A click handler that threw or whose promise rejected (app.js wraps its two async click listeners with guardHandler):
// reported with the control that was really used and the handler's own frames, instead of surfacing later as an
// anonymous unhandled rejection labelled with whatever was tapped last.
export function reportHandlerError(error, action) {
  try { globalThis.console?.error?.(error); } catch { /* reporting never throws */ }
  if (!active) return;
  // Only the control of this very click, or none: never the one tapped last, which may be another.
  report({ screen: currentScreen(), action: wordOf(action, ""), code: "handler_error", error: error instanceof Error ? error : null, reason: reasonOf(error) });
}
// A promise nobody waits for (a tab's load started from a click): its rejection is reported, never left unhandled.
export function detached(promise, action = "") {
  Promise.resolve(promise).then(undefined, (error) => reportHandlerError(error, action));
}
// Wraps an event listener, sync or async: a throw or a rejection is reported once and goes no further.
export function guardHandler(handler) {
  return function guarded(event) {
    const action = event?.target?.closest?.("[data-action]")?.dataset?.action || "";
    try {
      const result = handler.call(this, event);
      if (result && typeof result.then === "function") result.then(undefined, (error) => reportHandlerError(error, action));
      return result;
    } catch (error) {
      reportHandlerError(error, action);
      return undefined;
    }
  };
}

export function installAppErrorCapture({ getUser, getScreen } = {}, target = globalThis.window, doc = globalThis.document) {
  if (getUser || getScreen) setCaptureContext({ ...(getUser ? { getUser } : {}), ...(getScreen ? { getScreen } : {}) });
  if (!target?.addEventListener) return;
  active = true;
  target.addEventListener("error", (event) => {
    report({ screen: currentScreen(), action: currentAction(), code: "js_error", error: event?.error, reason: reasonOfErrorEvent(event) });
  });
  target.addEventListener("unhandledrejection", (event) => {
    report({ screen: currentScreen(), action: currentAction(), code: "unhandled_rejection", error: event?.reason instanceof Error ? event.reason : null, reason: reasonOf(event?.reason) });
  });
  doc?.addEventListener?.("click", (event) => {
    const el = event?.target?.closest?.("[data-action]");
    if (el) noteAction(el.dataset.action);
  }, true);
}
