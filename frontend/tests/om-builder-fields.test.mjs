// Design B2: the Builder's fields. A session's four fields are laid out by their names in two rows
// (no field cut to a few letters), every field is 16 px (iOS zooms below that) and 44 px tall, and the
// cover image URL looks like a field. Names, data-* attributes and forms are untouched (the markup
// test below reads the real render).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const structure = readFileSync(new URL("../builder-structure.js", import.meta.url), "utf8");

function block() {
  const from = css.indexOf("Design: the Builder's fields (B2).");
  assert.ok(from > 0);
  const end = css.indexOf("\n/* =====", from + 10);
  return css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("every rule of the B2 block is a coach's (scoped like the other design blocks)", () => {
  const selectors = [...block().matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith("@")).flatMap((s) => s.split(",").map((x) => x.trim()));
  assert.ok(selectors.length >= 8);
  for (const sel of selectors) assert.ok(sel.startsWith("body:not(.athlete-mode):not(.login-mode) "), sel);
});

test("a session's four fields: two rows placed by field name, each 44 px and 16 px", () => {
  const b = block();
  assert.match(b, /\.builder-session-time-inline \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1\.17fr\) minmax\(0, 1fr\);[^}]*"name ampm"\s*"phase time"/);
  for (const [field, area] of [["name", "name"], ["amPm", "ampm"], ["bta", "phase"], ["time", "time"]]) {
    assert.match(b, new RegExp(`\\.builder-session-time-inline > \\[name="${field}"\\] \\{ grid-area: ${area}; \\}`), field);
  }
  assert.match(b, /\.builder-session-time-inline > \.builder-text-input \{[^}]*min-height: var\(--om-tap-target\);[^}]*font-size: 16px;/);
});

test("the four fields still carry the names the autosave form reads, inside the same autosave form", () => {
  const form = structure.slice(structure.indexOf('<form class="builder-session-time-inline"'), structure.indexOf("</form>", structure.indexOf('<form class="builder-session-time-inline"')));
  assert.match(form, /data-builder-form="update-session" data-builder-autosave data-session-id=/);
  assert.match(form, /name="name"/);
  assert.match(form, /name="time"/);
  assert.match(structure, /<select name="amPm" class="builder-text-input builder-session-select"/);
  assert.match(structure, /<select name="bta" class="builder-text-input builder-session-select"/);
});

test("Block name and the cover image URL are 16 px, the titles and the cover URL 44 px, and the cover URL has a visible frame", () => {
  const b = block();
  assert.match(b, /\.builder-block-title-input \{\s*font-size: 16px;/);
  assert.match(b, /\.builder-block-title-input,\s*body:not\(\.athlete-mode\):not\(\.login-mode\) \.builder-plan-title-input \{\s*min-height: var\(--om-tap-target\);/);
  assert.match(b, /\.builder-plan-cover-input:focus \{[^}]*border-color: var\(--accent\);[^}]*box-shadow:/, "a visible focus frame (the field has no outline)");
  assert.match(b, /\.builder-plan-cover-input:hover \{[^}]*border-color:/);
  assert.match(b, /\.builder-plan-cover-input \{[^}]*min-height: var\(--om-tap-target\);[^}]*border-color: var\(--line, #dfe4e8\);[^}]*background: #fff;[^}]*font-size: 16px;/);
});
