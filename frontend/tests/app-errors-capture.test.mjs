// The browser's error capture (frontend/app-errors-capture.js): what failed is reported as one word of a closed list
// (the error's name, never its message), a failing click handler is reported once with the control really used, and
// a refused full screen is never an unhandled rejection. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const C = await import("../app-errors-capture.js");
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
  for (const body of sent) assert.deepEqual(Object.keys(body).filter((k) => !["screen", "action", "code", "status", "stackSig", "reason"].includes(k)), []);
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
