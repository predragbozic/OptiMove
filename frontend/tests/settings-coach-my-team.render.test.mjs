import { test } from "node:test";
import assert from "node:assert/strict";

// Same stub as organization-view.render.test.mjs: the view modules read `document` at load time.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const { renderOrganizationPanelHtml } = await import("../organization-view.js");
const { renderSettingsNavHtml, COACH_SETTINGS_SECTIONS } = await import("../navigation.js");
const { state } = await import("../state.js");

const athlete = (n) => ({ id: `a${n}`, athlete_id: `AT${n}`, name: `Athlete ${n}`, is_active: true, club_id: "c1", team_id: "t1", memberships: [{ id: `m${n}`, membershipType: "team", status: "active", clubId: "c1", teamId: "t1" }], has_active_access: true });
const data = (extra = {}) => ({ isPlatformAdmin: false, clubs: [{ id: "c1", name: "Example Club" }], teams: [{ id: "t1", club_id: "c1", name: "First team" }], athletes: [athlete(1), athlete(2)], users: [], canCreateAthlete: true, ...extra });

function asWorkspace(workspace, section = "overview") {
  state.currentUser = { name: "Coach Example", email: "coach@example.invalid", activeWorkspace: workspace };
  state.organization = { ...state.organization, data: null, selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false };
}
const panel = (extra) => renderOrganizationPanelHtml({ currentUser: state.currentUser, data: data(extra), error: "", role: "USER", scope: "First team" });
const tabs = (html) => [...html.matchAll(/data-action="organization-section" data-section="([^"]+)"/g)].map((m) => m[1]);

test("a team coach's Settings is My team: the four coach tabs, the team's name, no organization browser, no Clubs/Teams/Users", () => {
  asWorkspace({ type: "team", scopeId: "t1", label: "First team" });
  const html = panel();
  assert.deepEqual(tabs(html), COACH_SETTINGS_SECTIONS);
  assert.deepEqual(COACH_SETTINGS_SECTIONS, ["athletes", "joinLinks", "presets", "icons"]);
  assert.match(html, /My team/);
  assert.match(html, /<h3>First team<\/h3>/);
  assert.match(html, /2 athletes/);
  assert.doesNotMatch(html, /Organization browser|All accessible organization|clubs - |organization-scope-card|Signed in as/);
  assert.doesNotMatch(html, /data-section="(overview|clubs|teams|users)"/);
  assert.equal(state.organization.section, "athletes", "the default Overview falls back to Athletes");
});

test("a private coach's Settings is My athletes", () => {
  asWorkspace({ type: "private_coach", scopeId: null, label: "Private coaching" });
  const html = panel();
  assert.match(html, /My athletes/);
  assert.match(html, /<h3>Private coaching<\/h3>/);
  assert.deepEqual(tabs(html), COACH_SETTINGS_SECTIONS);
});

test("a hidden section (a stale state or a deep link) falls back to Athletes for a coach; one allowed section is kept", () => {
  asWorkspace({ type: "team", scopeId: "t1", label: "First team" }, "users");
  panel();
  assert.equal(state.organization.section, "athletes");
  asWorkspace({ type: "team", scopeId: "t1", label: "First team" }, "presets");
  panel();
  assert.equal(state.organization.section, "presets");
});

test("a club admin and a platform admin keep every tab and the organization browser", () => {
  asWorkspace({ type: "club", scopeId: "c1", label: "Example Club" });
  const club = panel();
  assert.ok(tabs(club).includes("overview") && tabs(club).includes("clubs") && tabs(club).includes("users"));
  assert.match(club, /Organization browser/);
  assert.match(club, /Signed in as/);
  asWorkspace({ type: "platform", scopeId: null, label: "Platform administration" });
  const platform = renderOrganizationPanelHtml({ currentUser: state.currentUser, data: data({ isPlatformAdmin: true }), error: "", role: "PLATFORM", scope: "All" });
  assert.ok(tabs(platform).includes("clubs") && tabs(platform).includes("users"));
  assert.match(platform, /Organization browser/);
});

test("renderSettingsNavHtml follows the workspace alone", () => {
  asWorkspace({ type: "team", scopeId: "t1", label: "First team" });
  assert.deepEqual(tabs(renderSettingsNavHtml({}, "athletes")), COACH_SETTINGS_SECTIONS);
  asWorkspace({ type: "club", scopeId: "c1", label: "Example Club" });
  assert.ok(tabs(renderSettingsNavHtml({}, "athletes")).includes("users"));
});
