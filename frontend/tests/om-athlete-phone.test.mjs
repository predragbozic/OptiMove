import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The athlete's app on a phone (owner, 2026-11-10): the header panels, 44 px header controls, 16 px rating fields,
// and a menu tap made before app.js is ready. The browser proof is e2e/tests/athlete-phone.test.mjs.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("styles.css");
const block = (() => {
  const from = css.indexOf("Design: the athlete's phone header.");
  assert.ok(from > 0, "the block exists");
  const end = css.indexOf("\n/* =====", from + 10);
  // From the comment's own start, so the stripped text holds only rules.
  return css.slice(css.lastIndexOf("/* =====", from), end < 0 ? undefined : end);
})();

test("every rule of the athlete header block is the athlete's own (never the coach's)", () => {
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...rules.matchAll(/([^{};]+)\{/g)].filter((m) => !m[1].trim().startsWith("@")).flatMap((m) => m[1].split(",")).map((s) => s.trim()).filter(Boolean);
  assert.ok(selectors.length >= 7, selectors.join(" | "));
  for (const selector of selectors) assert.ok(selector.startsWith("body.athlete-mode"), selector);
});

test("Messages full screen drops the bar's blur; notifications hang from the bell's right edge on a phone", () => {
  assert.match(block, /body\.athlete-mode\.messages-open:not\(\.login-mode\) \.athlete-topbar \{\s*backdrop-filter: none;\s*-webkit-backdrop-filter: none;/);
  assert.ok(block.indexOf("messages-open") > block.indexOf("@media (max-width: 760px)"), "inside the ≤760 px block");
  // The sticky rows under the bar start at its height (61 px with the 44 px controls), never the old 57 px.
  assert.match(block, /--athlete-topbar-height: 61px;/);
  assert.equal((css.match(/top: calc\(var\(--athlete-topbar-height, 61px\) \+ env\(safe-area-inset-top, 0px\)\);/g) || []).length, 2);
  assert.ok(!css.includes("top: calc(57px + env(safe-area-inset-top"), "no row is left at the old 57 px");
  assert.match(block, /@media \(max-width: 640px\) \{\s*body\.athlete-mode:not\(\.login-mode\) \.notification-panel \{\s*left: auto;\s*right: 0;/);
});

test("the header controls are 44 px", () => {
  for (const control of [".athlete-topbar-brand", ".mobile-nav-toggle", ".notification-toggle", ".message-toggle", ".sign-out-button"]) {
    assert.ok(block.includes(control), control);
  }
  assert.match(block, /min-width: var\(--om-tap-target\);\s*min-height: var\(--om-tap-target\);/);
  assert.match(css, /:root \{[^}]*--om-tap-target: 44px;/);
});

test("the rating form's duration and note fields are 16 px on phones and touch screens", () => {
  assert.match(css, /@media \(max-width: 760px\), \(pointer: coarse\) \{\s*\.training-load-rpe-duration-input,\s*\.training-load-rpe-note-input \{\s*font-size: 16px;/);
});

test("both page shells count menu taps made before app.js is bound, and app.js replays an odd count once", () => {
  for (const shell of ["index.html", "athlete.html"]) {
    const html = read(shell);
    const script = html.indexOf("window.__omEarlyMenuTaps = 0;");
    assert.ok(script > 0 && script < html.indexOf("<body"), `${shell}: in the head, before the body draws the button`);
    assert.match(html, /if \(window\.__omMenuBound\) return;/);
    assert.match(html, /closest\("#mobileNavToggle"\)\) window\.__omEarlyMenuTaps \+= 1;/);
  }
  const app = read("app.js");
  const init = app.slice(app.indexOf("async function init() {"), app.indexOf("applyDefaultInitialTab();", app.indexOf("async function init() {")) + 30);
  // Bound right after bindEvents (so no tap is both counted and handled)...
  assert.match(init, /bindEvents\(\);\s*(\/\/[^\n]*\n\s*)*window\.__omMenuBound = true;/);
  // ...and replayed only in the signed-in shell: after the no-user branch (the sign-in screen) and the athlete redirect.
  const replay = init.indexOf("if ((window.__omEarlyMenuTaps || 0) % 2 === 1) toggleMobileNav();");
  assert.ok(replay > 0, "the replay exists");
  assert.ok(replay > init.indexOf("if (!state.currentUser) {"), "after the sign-in branch");
  assert.ok(replay > init.indexOf('window.location.replace("/athlete");'), "after the athlete redirect");
  assert.ok(replay < init.indexOf("applyDefaultInitialTab();"), "before the first tab is drawn");
});
