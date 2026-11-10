import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S6 (Settings): App health's chips are 44 px on every width; Calendar's "Add …" button is hidden (and stays disabled)
// while its own form is open; a dialog's eyebrow is escaped inside renderDialogHead. Browser proof:
// e2e/tests/settings-s6.test.mjs.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const block = css.slice(css.indexOf("Design S6 (Settings)"), css.indexOf("/* End of design S6 (Settings). */"));
const view = readFileSync(new URL("../organization-view.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../calendar-settings-view.js", import.meta.url), "utf8");

test("App health's chips are 44 px on every width", () => {
  assert.ok(block.length > 0);
  assert.match(block, /\.app-health-chip \{\n  min-height: var\(--om-tap-target\);\n\}/);
  assert.ok(!block.includes("@media"), "not only on a phone");
});

test("Calendar's Add button is hidden while its own form is open, and stays disabled", () => {
  assert.match(calendar, /\$\{disabledIf\(locked\(\) \|\| formOpen\)\}\$\{formOpen \? " hidden" : ""\}/);
  assert.match(block, /\[data-action="calendar-settings-new"\]\[hidden\] \{\n  display: none;\n\}/);
});

test("a dialog's eyebrow is escaped inside renderDialogHead, so no caller escapes it", async () => {
  assert.match(view, /<p class="eyebrow">\$\{escapeHtml\(eyebrow\)\}<\/p>/);
  assert.ok(!view.includes("Athlete invite${contextLabel ? ` · ${escapeHtml(contextLabel)}`"), "the invite passes the raw label");
  const { renderOrganizationBrowser } = await import("../organization-view.js");
  const { state } = await import("../state.js");
  state.organization = { section: "athletes", selectedClubId: "", selectedTeamId: "", addFormOpen: false };
  state.organizationUserManage = { open: false };
  state.athleteAccountManage = { open: false };
  state.organizationEditor = { open: false };
  state.organizationInvite = { open: true, athleteId: "a1", pending: false, error: "" };
  state.currentUser = { id: "v", activeWorkspace: { type: "club", scopeId: "c1", label: "Club <b>&</b> Co" } };
  const html = renderOrganizationBrowser({ clubs: [], teams: [], users: [], athletes: [{ id: "a1", name: "Ana Demo", is_active: true, has_active_access: true, memberships: [] }] });
  assert.ok(!html.includes("<b>&</b>"), "the label is never raw HTML");
  assert.ok(!html.includes("&amp;lt;b&amp;gt;"), "and never escaped twice");
});
