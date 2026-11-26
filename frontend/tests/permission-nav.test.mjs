// Settings tabs, the sidebar's Settings entries and the Roles tab built from the permissions /me returns (roles plan R3,
// section 3.2), through the real renderers. The fallback is the point: without the field everything is as it was.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const { renderOrganizationPanelHtml } = await import("../organization-view.js");
const { renderSettingsNavHtml, COACH_SETTINGS_SECTIONS } = await import("../navigation.js");
const { coachSettingsSections, heldPermissions, holdsPermission, permissionTabAllowed } = await import("../permission-nav.js");
const { rolesContext } = await import("../roles-data.js");
const { state } = await import("../state.js");

const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const data = (extra = {}) => ({ isPlatformAdmin: false, clubs: [{ id: CLUB, name: "Example Club" }], teams: [{ id: TEAM, club_id: CLUB, name: "First team" }], athletes: [], users: [{ id: "u2", name: "Someone", email: "s@example.invalid", loginActive: true }], canCreateAthlete: true, ...extra });
const tabs = (html) => [...(html.match(/<nav class="settings-tabs[\s\S]*?<\/nav>/)?.[0] || "").matchAll(/data-action="organization-section" data-section="([^"]+)"/g)].map((m) => m[1]);

function as(activeWorkspace, extra = {}, section = "overview") {
  state.currentUser = { id: "u1", name: "Example", email: "e@example.invalid", activeWorkspace, clubs: [], teams: [], ...extra };
  state.organization = { ...state.organization, data: null, selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false };
}
const panel = (d = data()) => renderOrganizationPanelHtml({ currentUser: state.currentUser, data: d, error: "", role: "USER", scope: "Example" });
const CLUB_WS = { type: "club", scopeId: CLUB, label: "Example Club" };
const TEAM_WS = { type: "team", scopeId: TEAM, label: "First team" };
const PLATFORM_WS = { type: "platform", scopeId: null, label: "Platform administration" };
const ADMIN = { clubs: [{ id: CLUB, role: "club_admin" }] };
const ALL_WORDS = ["org.view", "org.teams.manage", "org.club.edit", "athletes.manage", "athletes.remove", "staff.assign", "roles.manage", "platform.admin", "platform.metrics.manage", "accounts.manage", "calendar.events.manage", "calendar.settings.manage"];
const PLATFORM_TABS = ["dataSources", "sourceConnections", "storage", "appHealth"];
const CLUB_ADMIN_WORDS = ["org.view", "org.teams.manage", "org.club.edit", "athletes.manage", "athletes.remove", "staff.assign", "calendar.settings.manage"];
const COACH_WORDS = ["org.view", "athletes.manage", "athletes.remove"];

test("1. FALLBACK: legacy /me keeps its tabs; an explicit permission outage hides Calendar Settings", () => {
  as(CLUB_WS, ADMIN);
  const clubBaseline = tabs(panel());
  assert.ok(["overview", "clubs", "teams", "athletes", "users", "calendar", "roles"].every((t) => clubBaseline.includes(t)));
  as(PLATFORM_WS, { clubs: [] });
  const platformBaseline = tabs(panel(data({ isPlatformAdmin: true })));
  assert.ok(platformBaseline.includes("roles") && platformBaseline.includes("dataSources") && platformBaseline.includes("appHealth"));
  assert.deepEqual(COACH_SETTINGS_SECTIONS, ["athletes", "joinLinks", "presets", "icons"]);
  for (const extra of [{}, { permissions: undefined }, { permissions: null }, { permissions: "org.view" }, { permissions: { a: 1 } }, { permissions: ["org.view"], permissionsUnavailable: true }, { permissions: [], permissionsUnavailable: true }]) {
    const label = JSON.stringify(extra);
    assert.equal(heldPermissions(), null, label || "no user yet");
    as(TEAM_WS, extra);
    assert.equal(heldPermissions(), null, label);
    assert.deepEqual(tabs(panel()), COACH_SETTINGS_SECTIONS, label);
    assert.deepEqual(coachSettingsSections(), COACH_SETTINGS_SECTIONS, label);
    as({ type: "private_coach" }, extra);
    assert.deepEqual(tabs(panel()), COACH_SETTINGS_SECTIONS, label);
    as(CLUB_WS, { ...ADMIN, ...extra });
    const expected = extra.permissionsUnavailable ? clubBaseline.filter((tab) => tab !== "calendar") : clubBaseline;
    assert.deepEqual(tabs(panel()), expected, label);
    assert.deepEqual(rolesContext(data()), { clubId: CLUB, platform: false }, label);
    as(PLATFORM_WS, { clubs: [], ...extra });
    assert.deepEqual(tabs(panel(data({ isPlatformAdmin: true }))), platformBaseline, label);
    assert.deepEqual(rolesContext(data({ isPlatformAdmin: true })), { clubId: "", platform: true }, label);
    // A club member who is not its admin: no Roles tab, as before.
    as(CLUB_WS, { clubs: [{ id: CLUB, role: "member" }], ...extra });
    assert.equal(rolesContext(data()), null, label);
    assert.equal(holdsPermission("staff.assign", true), true, "the legacy answer is returned without a list");
    assert.equal(holdsPermission("staff.assign", false), false);
    for (const section of ["overview", "clubs", "teams", "users"]) assert.equal(permissionTabAllowed(section), true);
  }
});

test("2. a team coach's My team keeps today's four tabs whatever words are held: never Clubs, Teams, Overview, Users or Roles", () => {
  for (const permissions of [COACH_WORDS, ["athletes.manage"], [], ALL_WORDS]) {
    as(TEAM_WS, { permissions, permissionsUnavailable: false });
    const html = panel();
    assert.deepEqual(tabs(html), ["athletes", "joinLinks", "presets", "icons"], permissions.join());
    assert.match(html, /My team/);
    assert.doesNotMatch(html, /data-section="(roles|users|overview|clubs|teams)"/);
    assert.equal(rolesContext(data()), null, "a team workspace never offers Roles");
  }
});

test("3. an independent coach holds no word in /me and keeps today's four tabs", () => {
  as({ type: "private_coach" }, { permissions: [], permissionsUnavailable: false });
  assert.deepEqual(tabs(panel()), COACH_SETTINGS_SECTIONS);
});

test("4. a coach on a section outside My team falls back to Athletes; an allowed one is kept", () => {
  for (const section of ["clubs", "teams", "users", "roles"]) {
    as(TEAM_WS, { permissions: ALL_WORDS }, section);
    panel();
    assert.equal(state.organization.section, "athletes", section);
  }
  as(TEAM_WS, { permissions: COACH_WORDS }, "presets");
  panel();
  assert.equal(state.organization.section, "presets");
});

test("4b. the Overview summary offers no Users tile when staff.assign is not held (no dead control)", () => {
  as(CLUB_WS, { ...ADMIN, permissions: ["org.view", "athletes.manage"] });
  const html = panel();
  assert.doesNotMatch(html, /data-section="users"/);
  assert.match(html, /data-section="clubs"/);
  as(CLUB_WS, { ...ADMIN, permissions: CLUB_ADMIN_WORDS });
  assert.match(panel(), /organization-section-summary-tile" type="button" data-action="organization-section" data-section="users"/);
});

test("5. a club admin's tabs follow the granted words; Calendar Settings requires its own Manage permission", () => {
  as(CLUB_WS, { ...ADMIN, permissions: [...CLUB_ADMIN_WORDS, "roles.manage"] });
  assert.deepEqual(tabs(panel()), ["overview", "clubs", "teams", "athletes", "users", "joinLinks", "presets", "icons", "calendar", "roles"]);
  as(CLUB_WS, { ...ADMIN, permissions: CLUB_ADMIN_WORDS });
  assert.ok(tabs(panel()).includes("roles"), "org.view reads the roles; the server's actions decide any button");
  as(CLUB_WS, { ...ADMIN, permissions: CLUB_ADMIN_WORDS.filter((w) => w !== "staff.assign") });
  assert.ok(!tabs(panel()).includes("users"), "no staff.assign: no Users tab");
  as(CLUB_WS, { ...ADMIN, permissions: ["roles.manage", "athletes.manage", "calendar.events.manage"] });
  const noOrg = panel();
  assert.deepEqual(tabs(noOrg), ["athletes", "joinLinks", "presets", "icons", "roles"], "missing org.view and calendar.settings.manage hide their own tabs");
  assert.doesNotMatch(noOrg, /lock|Locked/i);
  as(CLUB_WS, { ...ADMIN, permissions: ["athletes.manage"] });
  assert.ok(!tabs(panel()).includes("roles"));
  assert.equal(rolesContext(data()), null);
  as(CLUB_WS, { ...ADMIN, permissions: ["roles.manage"] });
  assert.deepEqual(rolesContext(data()), { clubId: CLUB, platform: false });
});

test("6. a section the words no longer give falls back (Users without staff.assign, Overview without org.view)", () => {
  as(CLUB_WS, { ...ADMIN, permissions: ["org.view"] }, "users");
  panel();
  assert.equal(state.organization.section, "overview");
  as(CLUB_WS, { ...ADMIN, permissions: ["athletes.manage"] }, "overview");
  panel();
  assert.equal(state.organization.section, "athletes");
});

test("7. LOW-1: every word in a club or team workspace never shows a platform tab; those follow the workspace and the account fact", () => {
  for (const ws of [CLUB_WS, TEAM_WS]) {
    as(ws, { ...ADMIN, permissions: ALL_WORDS });
    const shown = tabs(panel(data({ isPlatformAdmin: false })));
    for (const tab of PLATFORM_TABS) assert.ok(!shown.includes(tab), `${ws.type}: ${tab}`);
  }
  // The same tabs as without the list: the list opens none of them.
  as(CLUB_WS, { ...ADMIN, permissions: ALL_WORDS });
  const withWords = tabs(panel(data({ isPlatformAdmin: true })));
  as(CLUB_WS, ADMIN);
  const without = tabs(panel(data({ isPlatformAdmin: true })));
  assert.deepEqual(withWords.filter((t) => PLATFORM_TABS.includes(t)), without.filter((t) => PLATFORM_TABS.includes(t)));
  // A platform admin in the platform workspace keeps the platform tabs.
  as(PLATFORM_WS, { clubs: [], permissions: ALL_WORDS });
  const platform = tabs(panel(data({ isPlatformAdmin: true })));
  for (const tab of ["dataSources", "appHealth", "roles", "clubs", "teams", "users", "overview"]) assert.ok(platform.includes(tab), tab);
});

test("8. renderSettingsNavHtml marks the active tab and drops what the words do not give", () => {
  as(CLUB_WS, { ...ADMIN, permissions: ["org.view", "athletes.manage"] });
  const html = renderSettingsNavHtml(data(), "clubs");
  assert.ok(!tabs(html).includes("users"));
  assert.match(html, /aria-current="page" data-action="organization-section" data-section="clubs"/);
});
