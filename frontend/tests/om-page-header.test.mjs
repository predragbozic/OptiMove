// Design PR2: the shell's page header. Visual rules only, scoped to the coach / admin shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const start = css.indexOf("Design PR2: the page header");
const pr2 = css.slice(start);
const S = "body:not(.athlete-mode):not(.login-mode)";
const rule = (sel, from = pr2) => {
  const at = from.indexOf(`${sel} {`);
  assert.ok(at >= 0, `rule ${sel}`);
  return from.slice(at, from.indexOf("}", at));
};

test("the header block exists once, after U4's phone dot, and only for the shell", () => {
  assert.ok(start > css.indexOf('U4: on a phone (up to 640 px) "Online" is a 12 px dot'));
  for (const m of pr2.matchAll(/\n\s*([^\n{}@/][^{}\n]*)\{/g)) {
    for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) assert.ok(sel.startsWith(S), `scoped: ${sel}`);
  }
});

test("the context label and the workspace switcher are in sentence case", () => {
  assert.match(rule(`${S} .topbar #contextLabel`), /text-transform: none;/);
  assert.match(rule(`${S} .topbar .workspace-toggle`), /text-transform: none;/);
});

test("the status pill is left as U4 set it (the e2e header-status test pins it)", () => {
  assert.doesNotMatch(pr2, /status-pill/);
});

test("on a phone every header control is a 44 px target", () => {
  const phone = pr2.slice(pr2.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /grid-template-columns: 44px minmax\(0, 1fr\) repeat\(3, 44px\);/);
  assert.match(phone, /width: 44px;\n\s*min-width: 44px;\n\s*min-height: 44px;/);
  assert.match(rule(`${S} .topbar .workspace-toggle`, phone), /min-height: 44px;/);
});
