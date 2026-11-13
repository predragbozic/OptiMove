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

// The report body, exactly the keys the server accepts, or null.
export function buildReport({ screen, action, code, status, error, reason }) {
  const body = { screen: wordOf(screen, "app").replace(/[.]/g, "-"), code: wordOf(code, "js_error") };
  if (REASONS.includes(reason)) body.reason = reason;
  if (action) body.action = wordOf(action, "unknown");
  if (Number.isInteger(status) && status >= 100 && status <= 599) body.status = status;
  const sig = stackSigOf(error);
  if (sig) body.stackSig = sig;
  return body;
}

export function createReporter({ send: sendIn, isSignedIn: signedIn, now = () => Date.now(), perMinute = MAX_PER_MINUTE, dedupeMs = DEDUPE_MS } = {}) {
  // The default sender needs a signed-in page; an injected sender (a test) decides for itself.
  const send = sendIn || defaultSend;
  const isSignedIn = signedIn || (sendIn ? () => true : () => Boolean(context.getUser()));
  const seen = new Map();
  let windowStart = 0;
  let inWindow = 0;
  return function report(input) {
    try {
      if (!isSignedIn()) return false; // before any slot is spent: an error before sign-in must not hide the same one after it
      const body = buildReport(input);
      const t = now();
      if (t - windowStart >= 60_000) { windowStart = t; inWindow = 0; }
      if (inWindow >= perMinute) return false;
      const key = [body.screen, body.action || "", body.code, body.reason || "", body.status ?? "", body.stackSig || ""].join("|");
      if (t - (seen.get(key) ?? -Infinity) < dedupeMs) return false;
      if (seen.size >= MAX_KEYS) for (const [k, ts] of seen) if (t - ts >= dedupeMs) seen.delete(k);
      if (seen.size >= MAX_KEYS) return false;
      seen.set(key, t);
      inWindow += 1;
      Promise.resolve(send(body)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
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
export function reportApiFailure({ code, status }) {
  if (!active) return;
  report({ screen: currentScreen(), action: currentAction() || "api_call", code, status });
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
