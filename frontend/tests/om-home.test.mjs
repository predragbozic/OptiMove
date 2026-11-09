// Design PR3: Home for the three roles, U1b, and the workspace switcher's name on a narrow phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderCoachHomeHtml } = await import("../coach-home.js");
const { renderWorkspaceScopeCard } = await import("../organization-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const pr3 = css.slice(css.indexOf("Design PR3: Home for the three roles"));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("U1b: the scope card says where and in which role, in plain words, from the active workspace", () => {
  assert.equal(text(renderWorkspaceScopeCard({ type: "club", label: "Example Club" }, { role: "User", scope: "Example Club" })), "Working in Example Club as Club administrator");
  assert.equal(text(renderWorkspaceScopeCard({ type: "team", label: "First team" }, { role: "User" })), "Working in First team as Team coach");
  assert.equal(text(renderWorkspaceScopeCard({ type: "platform" }, { role: "User", scope: "All platform data" })), "Working in All clubs and teams as Platform administrator");
  assert.equal(text(renderWorkspaceScopeCard({ type: "private_coach" }, {})), "Working in Private coaching as Private coach");
  // Never the legacy "User" label, and a name is escaped.
  assert.equal(text(renderWorkspaceScopeCard(null, { role: "User", scope: "Workspace" })), "Working in Workspace");
  assert.doesNotMatch(renderWorkspaceScopeCard({ type: "club", label: "A <b>B</b>" }), /<b>B<\/b>/);
});

test("the platform administrator's Home: the clubs as cards with a count and the club icon", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [] };
  const html = renderCoachHomeHtml({ rows: [], user, clubs: [{ id: "c1", name: "Alpha", teamCount: 2, athleteCount: 12 }, { id: "c2", name: "Beta", teamCount: 1, athleteCount: 0 }] });
  assert.match(html, /<h3 id="coachHomeClubsTitle">Clubs <span class="coach-home-clubs-count">2<\/span><\/h3>/);
  assert.equal(html.split('class="coach-home-workspace-icon"').length - 1, 2);
  assert.match(pr3, /\.coach-home-clubs \.coach-home-club-list \{\n\s*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 280px\), 1fr\)\);/);
  assert.match(pr3, /\.coach-home-clubs h3 \{[^}]*text-transform: none;/);
});

test("a narrow phone hides the switcher's extra words and lets a long name take two lines", () => {
  const phone = pr3.slice(pr3.indexOf("@media (max-width: 420px)"));
  assert.ok(pr3.indexOf("@media (max-width: 420px)") > 0);
  assert.match(phone, /\.topbar \.workspace-toggle-extra \{ display: none; \}/);
  assert.match(phone, /\.topbar \.workspace-toggle-label \{[^}]*-webkit-line-clamp: 2;[^}]*white-space: normal;/);
  // The chevron is an icon with a size on every surface (an SVG without one would fill its box).
  assert.match(pr3, /\.workspace-toggle-caret \{\n\s*width: 16px;\n\s*height: 16px;/);
});

test("an empty day or library is a quiet empty state, a loading line is not", () => {
  assert.match(pr3, /p\.coach-home-day-note\.muted,\np\.coach-home-library-note\.muted:not\(\[role="status"\]\) \{[^}]*border: 1px dashed/);
});
