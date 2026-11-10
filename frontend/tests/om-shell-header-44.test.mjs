import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S6 (shell): the coach and admin header's controls are 44 px on every width, not only on a phone. The "Online" pill
// and the athlete app's header are outside this block. Browser proof: e2e/tests/shell-header-44.test.mjs.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const start = css.indexOf("Design S6 (shell): the header's controls are 44 px on a computer too.");
// Only the S6 block, up to its end marker: rules added after it later do not concern this test.
const block = css.slice(start, css.indexOf("/* End of design S6 (shell). */", start));
const S = "body:not(.athlete-mode):not(.login-mode)";

test("the S6 block is the last word on the header's controls, for the coach and admin shell only", () => {
  assert.ok(start > 0 && block.length > 0 && block.length < 2000, "the block exists, with its end marker");
  assert.ok(start > css.lastIndexOf("@media (max-width: 760px) {\n  body:not(.athlete-mode):not(.login-mode) .topbar-actions {"), "after the phone rules");
  assert.ok(block.includes(`${S} .topbar .workspace-toggle {\n  min-height: var(--om-tap-target);\n}`), "the switcher");
  for (const control of ["notification-toggle", "message-toggle", "sign-out-button"]) assert.ok(block.includes(`${S} .topbar-actions .${control}`), control);
  assert.match(block, /width: var\(--om-tap-target\);\n  min-width: var\(--om-tap-target\);\n  min-height: var\(--om-tap-target\);/);
  assert.ok(!/status-pill|athlete-mode \.|@media/.test(block.replace(/body:not\(\.athlete-mode\)/g, "")), "no status pill, athlete header or breakpoint here");
});
