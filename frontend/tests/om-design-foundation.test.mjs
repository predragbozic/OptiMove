import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Design foundation (PR1): the shared tokens and .om-* components, and their one
// adopter in PR1, the Settings tab bar.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderSettingsNavHtml } = await import("../navigation.js");
const { revealActiveTab, refreshTabFades } = await import("../om-tabs.js");
const { state } = await import("../state.js");

const here = new URL("..", import.meta.url);
const css = readFileSync(new URL("styles.css", here), "utf8");

function asWorkspace(workspace, section) {
  state.currentUser = { name: "Example", email: "x@example.invalid", activeWorkspace: workspace };
  state.organization = { ...state.organization, section };
}
const buttons = (html) => [...html.matchAll(/<button class="([^"]+)"[^>]*data-section="([^"]+)"/g)].map((m) => ({ cls: m[1], section: m[2], tag: m[0] }));

test("the Settings tab bar is an .om-tabs row; every tab keeps its old class and exactly the active one says aria-current", () => {
  asWorkspace({ type: "club", scopeId: "c1", label: "Example Club" }, "users");
  const html = renderSettingsNavHtml({ isPlatformAdmin: true }, "users");
  assert.match(html, /<nav class="settings-tabs om-tabs" aria-label="Settings sections">/);
  const all = buttons(html);
  assert.ok(all.length >= 8);
  for (const b of all) assert.match(b.cls, /\bsettings-tab om-tab\b/);
  const current = all.filter((b) => /aria-current="page"/.test(b.tag));
  assert.deepEqual(current.map((b) => b.section), ["users"]);
  assert.match(current[0].cls, /is-active/);
});

test("a coach's Settings tab bar uses the same row", () => {
  asWorkspace({ type: "team", scopeId: "t1", label: "First team" }, "athletes");
  const html = renderSettingsNavHtml({}, "athletes");
  assert.match(html, /class="settings-tabs om-tabs"/);
  const current = buttons(html).filter((b) => /aria-current="page"/.test(b.tag));
  assert.deepEqual(current.map((b) => b.section), ["athletes"]);
});

function row({ width, scrollWidth, scrollLeft = 0, active }) {
  // Boxes are viewport positions: the row starts at x=100; a tab at content offset o is at 100 + o - scrollLeft.
  const r = { clientWidth: width, scrollWidth, scrollLeft, attrs: {}, getBoundingClientRect: () => ({ left: 100 }), setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const tab = active ? { getBoundingClientRect: () => ({ left: 100 + active.offset - r.scrollLeft, width: active.width }) } : null;
  r.querySelector = () => tab;
  return r;
}
const root = (...rows) => ({ querySelectorAll: (sel) => (sel === ".om-tabs" ? rows : []) });

test("revealActiveTab scrolls a too-wide row so the active tab is in view, and only sideways", () => {
  const right = row({ width: 300, scrollWidth: 900, active: { offset: 800, width: 90 } });
  revealActiveTab(root(right));
  assert.equal(right.scrollLeft, 800 + 90 - 300 + 8);
  const left = row({ width: 300, scrollWidth: 900, scrollLeft: 500, active: { offset: 40, width: 90 } });
  revealActiveTab(root(left));
  assert.equal(left.scrollLeft, 32);
  const visible = row({ width: 300, scrollWidth: 900, scrollLeft: 0, active: { offset: 100, width: 90 } });
  revealActiveTab(root(visible));
  assert.equal(visible.scrollLeft, 0);
});

test("data-fade marks the side that has more tabs, and a row that fits has none", () => {
  const start = row({ width: 300, scrollWidth: 900, scrollLeft: 0, active: { offset: 10, width: 90 } });
  revealActiveTab(root(start));
  assert.equal(start.attrs["data-fade"], "end");
  const end = row({ width: 300, scrollWidth: 900, active: { offset: 802, width: 90 } });
  revealActiveTab(root(end));
  assert.equal(end.attrs["data-fade"], "start");
  const middle = row({ width: 300, scrollWidth: 900, scrollLeft: 100, active: { offset: 300, width: 90 } });
  revealActiveTab(root(middle));
  assert.equal(middle.attrs["data-fade"], "both");
  const fits = row({ width: 900, scrollWidth: 900, active: { offset: 10, width: 90 } });
  fits.attrs["data-fade"] = "end";
  revealActiveTab(root(fits));
  assert.equal(fits.attrs["data-fade"], undefined);
});

test("a width change marks the fade again: a row that now fits loses it", () => {
  const r = row({ width: 300, scrollWidth: 900, active: { offset: 10, width: 90 } });
  revealActiveTab(root(r));
  assert.equal(r.attrs["data-fade"], "end");
  r.clientWidth = 900;
  refreshTabFades(root(r));
  assert.equal(r.attrs["data-fade"], undefined);
});

test("revealActiveTab leaves a row that fits, a row without an active tab and a missing root alone", () => {
  const fits = row({ width: 900, scrollWidth: 900, active: { offset: 800, width: 90 } });
  revealActiveTab(root(fits));
  assert.equal(fits.scrollLeft, 0);
  const none = row({ width: 300, scrollWidth: 900 });
  revealActiveTab(root(none));
  assert.equal(none.scrollLeft, 0);
  assert.doesNotThrow(() => revealActiveTab(null));
});

test("styles.css defines the tokens and components once, with a visible focus, after the old Settings tab rules", () => {
  for (const token of ["--om-space-1", "--om-space-7", "--om-text-xs", "--om-text-2xl", "--om-radius-lg", "--om-success-soft", "--om-warning-soft", "--om-info-soft", "--om-focus-ring", "--om-tap-target"]) {
    assert.equal(css.split(`${token}:`).length - 1, 1, `${token} is defined exactly once`);
  }
  for (const cls of [".om-page-header", ".om-card", ".om-empty", ".om-btn", ".om-badge", ".om-tabs", ".om-eyebrow"]) assert.ok(css.includes(`${cls} {`), cls);
  assert.match(css, /\.om-tabs \.om-tab:focus-visible/);
  assert.match(css, /\.om-btn:focus-visible/);
  // The old rules stay (PR1 is additive); the .om-tabs rules come after them, so they win at equal specificity.
  assert.match(css, /\.settings-tabs \{\n  display: flex;\n  flex-wrap: wrap;/);
  assert.ok(css.indexOf(".om-tabs {") > css.indexOf(".settings-tabs {"));
  // A computer wraps the row; a phone keeps one row that scrolls inside itself.
  assert.match(css, /\n\.om-tabs \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /@media \(max-width: 760px\) \{\n  \.om-card[\s\S]*?\.om-tabs \{\n    flex-wrap: nowrap;[^}]*overflow-x: auto;/);
});

test("Training Load is not touched: no Training Load or Imports module uses an .om-* class yet", () => {
  const dir = new URL("..", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^(training-load|gpexe-import|source-connections|data-sources)/.test(f) && f.endsWith(".js"));
  assert.ok(files.length > 5);
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /\bom-(tabs|tab|card|btn|empty|badge|page-header|eyebrow)\b/, f);
});

// WCAG AA (4.5:1) for every text/background pair the components use.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const token = (name) => css.match(new RegExp(`\\n  ${name}: (#[0-9a-f]{6});`))[1];

test("component colors meet WCAG AA contrast", () => {
  const pairs = [["--muted", "--surface"], ["--muted", "--surface-soft"], ["--text", "--surface-soft"], ["--om-accent-strong", "--surface"], ["--om-accent-strong", "--accent-soft"], ["--om-success", "--om-success-soft"], ["--om-warning", "--om-warning-soft"], ["--danger", "--om-danger-soft"], ["--om-info", "--om-info-soft"], ["--danger", "--surface"]];
  for (const [fg, bg] of pairs) assert.ok(ratio(token(fg), token(bg)) >= 4.5, `${fg} on ${bg}: ${ratio(token(fg), token(bg)).toFixed(2)}`);
  assert.ok(ratio("#ffffff", token("--accent")) >= 4.5, "white on the primary button");
});

// Code review of PR1 (HIGH): a new :root token named like an older rule's var(--name, fallback)
// switched that fallback off (the Imports batch results changed colour). Every PR1 token is
// therefore --om- prefixed, appears nowhere before the PR1 block, and is defined once.
test("PR1 tokens never redefine a token or switch on an existing var() fallback", () => {
  const start = css.indexOf("OptiMove design foundation (PR1)");
  assert.ok(start > 0);
  const before = css.slice(0, start);
  const tokens = [...css.slice(start).matchAll(/\n  (--[a-z0-9-]+):/g)].map((m) => m[1]);
  assert.ok(tokens.length > 20);
  const js = readdirSync(new URL("..", import.meta.url)).filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(new URL(f, new URL("..", import.meta.url)), "utf8")).join("\n");
  for (const t of tokens) {
    assert.match(t, /^--om-/, `${t} carries the --om- prefix`);
    assert.doesNotMatch(before, new RegExp(`${t}(?![a-z0-9-])`), `${t} appears before PR1`);
    assert.doesNotMatch(js, new RegExp(`${t}(?![a-z0-9-])`), `${t} is used by a module`);
  }
  // The two names that collided stay undefined, so the Imports rules keep their own fallbacks.
  for (const old of ["--success", "--warning"]) assert.doesNotMatch(css, new RegExp(`\\n\\s*${old}:`));
});
