// U4: on a phone the top bar's "Online" is a dot; every other state keeps the text pill; the state is in the accessible name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statusState } from "../status-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", f), "utf8");

test("statusState: Online is ok, Loading and Connecting are busy, Error is error, anything else is info", () => {
  assert.equal(statusState("Online"), "ok");
  assert.equal(statusState("Loading"), "busy");
  assert.equal(statusState("Connecting"), "busy");
  assert.equal(statusState("Error"), "error");
  for (const t of ["Sign in", "Invite", "Verify email", ""]) assert.equal(statusState(t), "info");
});

test("setStatus writes the text, data-state and an aria-label that contains the state", () => {
  const app = read("app.js");
  const fn = app.match(/function setStatus\(text\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /els\.status\.textContent = text/);
  assert.match(fn, /els\.status\.dataset\.state = statusState\(text\)/);
  assert.match(fn, /setAttribute\("aria-label", `Status: \$\{text\}`\)/);
  assert.match(fn, /els\.status\.title = `Status: \$\{text\}`/, "a long-press / hover hint names the state too");
  assert.match(read("index.html"), /id="apiStatus" data-state="busy" role="status" aria-label="Status: Connecting" title="Status: Connecting"/);
});

test("the phone rule turns only the ok state into a dot of at least 10 px; desktop and other states are untouched", () => {
  const css = read("styles.css");
  const rule = css.match(/\.topbar-actions \.status-pill\[data-state="ok"\] \{([\s\S]*?)\}/);
  assert.ok(rule, "the dot rule exists");
  const width = Number(rule[1].match(/width:\s*(\d+)px/)[1]);
  const height = Number(rule[1].match(/height:\s*(\d+)px/)[1]);
  assert.ok(width >= 10 && height >= 10, `the dot is ${width}x${height}`);
  assert.match(rule[1], /font-size:\s*0/);
  // The rule sits inside the max-width 760px block, never at top level, and no other state is selected.
  const at = css.indexOf('.topbar-actions .status-pill[data-state="ok"]');
  const block = css.lastIndexOf("@media (max-width: 760px)", at);
  assert.ok(block > 0 && css.indexOf("\n}\n", block) > at, "inside @media (max-width: 760px)");
  assert.doesNotMatch(css, /status-pill\[data-state="(busy|error|info)"\]/);
});
