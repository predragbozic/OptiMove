import { test } from "node:test";
import assert from "node:assert/strict";
import { installBuilderBarTooltip, LONG_PRESS_MS } from "../builder-bar-tooltip.js";

// B3: a long press on a Builder bar icon shows its tooltip and stops the click that ends it; a short tap and a mouse
// click are untouched; moving away cancels it. A fake window with fake timers drives the real module.
function world() {
  const listeners = {};
  const win = { addEventListener: (type, fn, capture) => { assert.equal(capture, true, `${type} listens in capture`); (listeners[type] ||= []).push(fn); } };
  const classes = new Set();
  const button = { disabled: false, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, closest: (sel) => (sel.includes(".builder-exit-button") ? button : null) };
  const other = { closest: () => null };
  const fire = (type, init = {}) => {
    const event = { type, target: button, clientX: 10, clientY: 10, pointerType: "touch", stopped: false, prevented: false, ...init };
    event.preventDefault = () => { event.prevented = true; };
    event.stopImmediatePropagation = () => { event.stopped = true; };
    for (const fn of listeners[type] || []) fn(event);
    return event;
  };
  installBuilderBarTooltip(win);
  return { fire, button, other, classes };
}

test("a long press shows the tooltip and swallows the click that ends it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.fire("pointerdown");
  t.mock.timers.tick(LONG_PRESS_MS - 1);
  assert.ok(!w.classes.has("is-tooltip-open"), "not before 500 ms");
  t.mock.timers.tick(1);
  assert.ok(w.classes.has("is-tooltip-open"), "shown at 500 ms");
  w.fire("pointerup");
  const click = w.fire("click");
  assert.ok(click.stopped && click.prevented, "the action does not run");
  assert.ok(!w.fire("click").stopped, "only that one click");
  t.mock.timers.tick(2000);
  assert.ok(!w.classes.has("is-tooltip-open"), "the tooltip hides again");
});

test("a short tap, a mouse press and a press that moves away run the action and show nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.fire("pointerdown"); t.mock.timers.tick(200); w.fire("pointerup");
  assert.ok(!w.fire("click").stopped, "a short tap runs");
  w.fire("pointerdown", { pointerType: "mouse" }); t.mock.timers.tick(800);
  assert.ok(!w.classes.has("is-tooltip-open") && !w.fire("click").stopped, "a mouse press is not a long press");
  w.fire("pointerdown"); w.fire("pointermove", { clientX: 40 }); t.mock.timers.tick(800);
  assert.ok(!w.classes.has("is-tooltip-open") && !w.fire("click").stopped, "a press that moves away is cancelled");
});

test("a long press elsewhere does nothing, and the next press clears a swallow no click consumed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.fire("pointerdown", { target: w.other }); t.mock.timers.tick(800);
  assert.ok(!w.classes.has("is-tooltip-open"));
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS); w.fire("pointercancel");
  w.fire("pointerdown"); w.fire("pointerup");
  assert.ok(!w.fire("click").stopped, "a later tap is not swallowed");
  assert.equal(w.fire("contextmenu").prevented, false, "no menu is blocked outside a press");
  w.fire("pointerdown");
  assert.equal(w.fire("contextmenu").prevented, true, "the browser's menu does not open over a press");
});

test("only the pointer click of that press is swallowed: a keyboard click, a key or a second later all run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  // A cancelled long press, then a keyboard activation (detail 0) of the same button.
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS); w.fire("pointercancel");
  assert.ok(!w.fire("click", { detail: 0 }).stopped, "a keyboard click after a cancelled press runs");
  // A long press, then a key: the swallow ends.
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS); w.fire("pointerup");
  w.fire("keydown", { key: "Tab" });
  assert.ok(!w.fire("click", { detail: 1 }).stopped, "a key ends the swallow");
  // A long press with no click for a second: the swallow lapses.
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS); w.fire("pointerup");
  t.mock.timers.tick(1000);
  assert.ok(!w.fire("click", { detail: 1 }).stopped, "the swallow lapses a second after the finger lifts");
  // The click that does end the press, right after it, is still swallowed.
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS); w.fire("pointerup");
  assert.ok(w.fire("click", { detail: 1 }).stopped, "the press's own click is swallowed");
});

test("Escape closes the tooltip until the pointer or focus leaves the button", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.fire("keydown", { key: "Escape" });
  assert.ok(w.classes.has("is-tooltip-dismissed"), "Escape on the button dismisses its tooltip");
  w.fire("focusout");
  assert.ok(!w.classes.has("is-tooltip-dismissed"), "leaving the button lets it show again");
  w.fire("pointerdown"); t.mock.timers.tick(LONG_PRESS_MS);
  assert.ok(w.classes.has("is-tooltip-open"));
  w.fire("keydown", { key: "Escape" });
  assert.ok(!w.classes.has("is-tooltip-open") && w.classes.has("is-tooltip-dismissed"), "Escape closes an open long-press tooltip");
});
