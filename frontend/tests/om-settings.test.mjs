// Design PR4: Settings (the organization browser) and App health.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };
const { state } = await import("../state.js");
const D = await import("../app-health-data.js");
const { renderAppHealthPanelHtml, APP_HEALTH_GROUP_CAP } = await import("../app-health-view.js");
const { renderProgramAccessRequests } = await import("../organization-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
// The PR4 block only: it ends where the next design block starts.
const pr4Start = css.indexOf("Design PR4: Settings");
const pr4End = css.indexOf("\n/* =====", pr4Start);
const pr4 = css.slice(pr4Start, pr4End > 0 ? pr4End : undefined);
const view = readFileSync(new URL("../organization-view.js", import.meta.url), "utf8");

const group = (i, occurrences = 1) => ({ fingerprint: String(i).padStart(64, "0"), source: "server", screen: null, routeTemplate: "/api/x", action: null, code: "internal_error", status: 500, release: "abc", stackSignature: null, occurrences, users: 1, firstSeenAt: "2026-11-09T10:00:00Z", lastSeenAt: "2026-11-09T10:00:00Z", roles: ["coach"] });
const show = (groups) => { state.appHealth = { ...D.emptyAppHealth(), groups }; return renderAppHealthPanelHtml(); };

test("App health counts one occurrence as \"1 time\"", () => {
  assert.match(show([group(1)]), /1 kind of error · 1 time · most recent first/);
  assert.match(show([group(1), group(2, 2)]), /2 kinds of errors · 3 times ·/);
  assert.match(show([group(1)]), /1 time · 1 person/, "the row says it the same way");
});

test("the cap note also shows when the filters match nothing", () => {
  state.appHealth = { ...D.emptyAppHealth(), role: "athlete", groups: Array.from({ length: 100 }, (_, i) => group(i)) };
  const html = renderAppHealthPanelHtml();
  assert.match(html, /No errors match these filters/);
  assert.match(html, /app-health-truncated/);
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

test("organization rows show the name's initials, not the row type or the id", () => {
  assert.doesNotMatch(view, /type\.slice\(0, 2\)\.toUpperCase\(\)/);
  assert.doesNotMatch(view, /organization-avatar">AT</);
  assert.doesNotMatch(view, /\|\| "AT"\)\.slice\(0, 2\)/);
  assert.doesNotMatch(view, /title\.slice\(0, 2\)\.toUpperCase\(\)/);
  assert.doesNotMatch(view, /<span class="organization-avatar">/, "every text avatar is aria-hidden");
  assert.match(view, /<span class="organization-avatar" aria-hidden="true">\$\{escapeHtml\(programInitials\(title\)\)\}<\/span>/);
});

test("the Settings rules stay inside the hero and the organization browser (never Data sources or Source connections)", () => {
  const body = pr4.slice(pr4.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");
  let checked = 0;
  for (const m of body.matchAll(/([^{};]+)\{/g)) {
    if (m[1].trim().startsWith("@")) continue;
    for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      assert.ok(sel.startsWith(".organization-view .organization-") || sel.startsWith(".app-health-"), `scoped: ${sel}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `${checked} selectors checked`);
  assert.match(pr4, /\.organization-view \.organization-row strong \{\n\s*white-space: normal;\n\s*overflow-wrap: break-word;/);
  // Only a narrow list card stacks the actions; a wide list keeps them on the right.
  const narrow = pr4.slice(pr4.indexOf("@container (max-width: 480px)"));
  assert.ok(pr4.indexOf("@container (max-width: 480px)") > 0);
  assert.match(pr4, /\.organization-browser \.organization-list-card \{\n\s*container-type: inline-size;/);
  assert.match(narrow, /^@container \(max-width: 480px\) \{\n\s*\.organization-view \.organization-browser \.organization-row:not\(\.is-selectable\) \{\n\s*grid-template-columns: 42px minmax\(0, 1fr\);/);
  assert.doesNotMatch(pr4.slice(0, pr4.indexOf("@container")), /grid-template-columns/, "no stacking outside the container query");
  assert.match(pr4, /\.organization-view \.organization-hero \.eyebrow,[\s\S]*?text-transform: none;/);
});

test("Data sources and Source connections use none of the classes the PR4 block styles", () => {
  for (const f of ["data-sources-view.js", "source-connections-view.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /organization-(row|list-head|list-card|avatar|hero|browser)\b/, f);
  }
});

// Manager's NO-GO on 39d1210: one initials change named a variable its function does not have
// (renderProgramAccessRequestRow has only `row`), so the row without a picture threw a ReferenceError.
test("a program access request without a picture renders, with the athlete's initials", () => {
  const html = renderProgramAccessRequests([{ id: "r1", status: "requested", athlete_name: "Demo Athlete", template_name: "Plan", requested_at: "2026-11-09T10:00:00Z" }]);
  assert.match(html, /<span class="organization-avatar" aria-hidden="true">DA<\/span>/);
  assert.match(html, /Demo Athlete/);
});

test("every programInitials(...) in organization-view.js names a variable of its own function", () => {
  const lines = view.split("\n");
  lines.forEach((line, n) => {
    for (const m of line.matchAll(/programInitials\(([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      let k = n;
      while (k >= 0 && !/^(export )?function /.test(lines[k])) k -= 1;
      assert.ok(k >= 0, `line ${n + 1}: no enclosing function`);
      const head = lines[k];
      const body = lines.slice(k, n + 1).join("\n");
      const declared = new RegExp(`function [\\w$]+\\([^)]*\\b${name}\\b`).test(head) || new RegExp(`(const|let|var) ${name}\\b`).test(body);
      assert.ok(declared, `line ${n + 1}: "${name}" is not a parameter or a local of ${head.trim()}`);
    }
  });
});
