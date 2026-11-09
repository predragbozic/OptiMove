// Design PR4: Settings (the organization browser) and App health.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };
const { state } = await import("../state.js");
const D = await import("../app-health-data.js");
const { renderAppHealthPanelHtml, APP_HEALTH_GROUP_CAP } = await import("../app-health-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const pr4 = css.slice(css.indexOf("Design PR4: Settings"));
const view = readFileSync(new URL("../organization-view.js", import.meta.url), "utf8");

const group = (i, occurrences = 1) => ({ fingerprint: String(i).padStart(64, "0"), source: "server", screen: null, routeTemplate: "/api/x", action: null, code: "internal_error", status: 500, release: "abc", stackSignature: null, occurrences, users: 1, firstSeenAt: "2026-11-09T10:00:00Z", lastSeenAt: "2026-11-09T10:00:00Z", roles: ["coach"] });
const show = (groups) => { state.appHealth = { ...D.emptyAppHealth(), groups }; return renderAppHealthPanelHtml(); };

test("App health counts one occurrence as \"1 time\"", () => {
  assert.match(show([group(1)]), /1 kind of error · 1 time · most recent first/);
  assert.match(show([group(1), group(2, 2)]), /2 kinds of errors · 3 times ·/);
});

test("App health says when the list may be cut at the read's cap, and only then", () => {
  assert.equal(APP_HEALTH_GROUP_CAP, 100);
  const full = show(Array.from({ length: 100 }, (_, i) => group(i)));
  assert.match(full, /class="muted app-health-note app-health-truncated" role="note">Showing the 100 most recently seen kinds of error\. Older ones in this period may not be listed\./);
  assert.doesNotMatch(show(Array.from({ length: 99 }, (_, i) => group(i))), /app-health-truncated/);
});

test("the backend's read still caps at 100 by default (the note's number)", () => {
  const backend = readFileSync(new URL("../../backend/src/appErrorTracking.js", import.meta.url), "utf8");
  assert.match(backend, /export async function listErrorGroups\(\{ days = 7, limit = 100 \}/);
  const route = readFileSync(new URL("../../backend/src/routes/appErrors.js", import.meta.url), "utf8");
  assert.match(route, /listErrorGroups\(\{ days \}\)/);
});

test("organization rows show the name's initials, not the row type", () => {
  assert.doesNotMatch(view, /type\.slice\(0, 2\)\.toUpperCase\(\)/);
  assert.match(view, /<span class="organization-avatar" aria-hidden="true">\$\{escapeHtml\(programInitials\(title\)\)\}<\/span>/);
});

test("the Settings rules stay inside the hero and the organization browser (never Data sources or Source connections)", () => {
  const body = pr4.slice(pr4.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of body.matchAll(/([^{};]+)\{/g)) {
    for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      assert.ok(sel.startsWith(".organization-view .organization-") || sel.startsWith(".app-health-"), `scoped: ${sel}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `${checked} selectors checked`);
  assert.match(pr4, /\.organization-view \.organization-row strong \{\n\s*white-space: normal;\n\s*overflow-wrap: break-word;/);
  assert.match(pr4, /\.organization-view \.organization-browser \.organization-row:not\(\.is-selectable\) > \.organization-row-actions \{\n\s*grid-column: 2;/);
  assert.match(pr4, /\.organization-view \.organization-hero \.eyebrow,[\s\S]*?text-transform: none;/);
});
