// Design PR2: the shell's page header. Visual rules only, scoped to the coach / admin shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const start = css.indexOf("Design PR2: the page header");
// Only PR2's own block: it ends where the next design block starts (or at the end of the file).
const next = css.indexOf("/* ==========================================================================", start + 1);
const pr2 = css.slice(start, next > start ? next : undefined);
const S = "body:not(.athlete-mode):not(.login-mode)";
const rule = (sel, from = pr2) => {
  const at = from.indexOf(`${sel} {`);
  assert.ok(at >= 0, `rule ${sel}`);
  return from.slice(at, from.indexOf("}", at));
};

test("the header block exists once, after U4's phone dot, and only for the shell", () => {
  assert.ok(start > css.indexOf('U4: on a phone (up to 640 px) "Online" is a 12 px dot'));
  // Whole selector lists (also multi-line ones), comments and @media headers left out.
  const body = pr2.slice(pr2.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of body.matchAll(/([^{};]+)\{/g)) {
    const list = m[1].trim();
    if (!list || list.startsWith("@")) continue;
    for (const sel of list.split(",").map((x) => x.trim()).filter(Boolean)) { assert.ok(sel.startsWith(S), `scoped: ${sel}`); checked += 1; }
  }
  assert.ok(checked >= 10, `${checked} selectors checked`);
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
  assert.match(css, /--om-tap-target: 44px;/);
  assert.match(phone, /grid-template-columns: var\(--om-tap-target\) minmax\(0, 1fr\) repeat\(3, var\(--om-tap-target\)\);/);
  assert.match(phone, /width: var\(--om-tap-target\);\n\s*min-width: var\(--om-tap-target\);\n\s*min-height: var\(--om-tap-target\);/);
  assert.match(rule(`${S} .topbar .workspace-toggle`, phone), /min-height: var\(--om-tap-target\);/);
});

test("hover colours only for a mouse, and a 44 px switcher on any touch screen", () => {
  const hover = pr2.slice(pr2.indexOf("@media (hover: hover)"));
  assert.ok(pr2.indexOf("@media (hover: hover)") > 0);
  assert.match(hover.slice(0, 300), /workspace-toggle\[data-action="workspace-toggle"\]:hover/);
  assert.equal(pr2.split(":hover").length - 1, 1, "the only :hover rule is inside (hover: hover)");
  assert.match(pr2.slice(pr2.indexOf("@media (pointer: coarse)")), /workspace-toggle \{\n\s*min-height: var\(--om-tap-target\);/);
});

test("every context label the app writes is sentence case (the uppercase style no longer hides it)", () => {
  const dir = new URL("..", import.meta.url);
  const labels = readdirSync(dir).filter((f) => f.endsWith(".js")).flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/els\.context\.textContent = "([^"]+)"/g)].map((m) => m[1]));
  assert.ok(labels.length > 10);
  for (const label of labels) {
    if (label === "OptiMove") continue;
    assert.doesNotMatch(label.split(" ").slice(1).join(" "), /\b[A-Z]/, `"${label}" is sentence case`);
  }
});
