// Roles R4-4, PR A (docs/ai/roles-r4-4-screens-contract.md 4.3, roles-r4-contract.md 5.2): the navigation of a view
// workspace (club_view / team_view) through the real index.html menu and the real renderers. Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let nav;
let access;
let permissionNav;
let home;
let orgView;
let state;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const TEAM = "aaaaaaaa-0000-4000-8000-0000000000a1";
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const TEAM_VIEW = { type: "team_view", scopeId: TEAM, clubId: CLUB, label: "Test Team", role: "role_holder" };
const CLUB_WS = { type: "club", scopeId: CLUB, label: "Test Club" };

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  nav = await import("../navigation.js");
  access = await import("../access.js");
  permissionNav = await import("../permission-nav.js");
  home = await import("../coach-home.js");
  orgView = await import("../organization-view.js");
  ({ state } = await import("../state.js"));
});

function as(activeWorkspace, extra = {}) {
  state.currentUser = { id: "u1", name: "Viewer A", email: "viewer@example.invalid", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], ...extra };
}
const hidden = (selector) => {
  const el = document.querySelector(selector);
  return Boolean(el.hidden || el.closest("[hidden]"));
};
const tabs = (html) => [...(html.match(/<nav class="settings-tabs[\s\S]*?<\/nav>/)?.[0] || "").matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
const MODULES = ['#athletesToggle', '#calendarToggle', '[data-library-tab="coaches"]', '[data-library-tab="builder"]', '[data-library-tab="templates"]', '[data-library-tab="exercises"]', '[data-library-tab="tests"]', '[data-library-tab="training-load"]', '#athleteList'];

test("1. a view workspace with org.view: Settings is offered, with only Overview, Clubs and Teams", () => {
  for (const ws of [CLUB_VIEW, TEAM_VIEW]) {
    as(ws, { permissions: ["org.view"] });
    assert.equal(access.isViewWorkspace(), true);
    assert.equal(access.hasOrganizationAccess(), true, ws.type);
    assert.deepEqual(permissionNav.viewSettingsSections(), ["overview", "clubs", "teams"]);
    for (const section of ["athletes", "users", "joinLinks", "presets", "icons", "roles", "calendar", "dataSources"]) {
      assert.equal(permissionNav.permissionTabAllowed(section), false, `${ws.type} ${section}`);
    }
    assert.deepEqual(tabs(nav.renderSettingsNavHtml({ isPlatformAdmin: false })), ["overview", "clubs", "teams"]);
  }
});

test("2. a view workspace without a word list (absent, unavailable) or without org.view: nothing is offered, never the old fallback", () => {
  for (const extra of [{}, { permissions: null }, { permissions: ["org.view"], permissionsUnavailable: true }, { permissions: [] }, { permissions: ["athletes.view"] }]) {
    as(CLUB_VIEW, extra);
    const label = JSON.stringify(extra);
    assert.equal(access.hasOrganizationAccess(), false, label);
    assert.deepEqual(permissionNav.viewSettingsSections(), [], label);
    assert.equal(permissionNav.permissionTabAllowed("overview"), false, label);
    assert.equal(permissionNav.permissionTabAllowed("athletes"), false, label);
  }
});

test("3. the menu hides every module entry in a view workspace and gives them back in a staff workspace", () => {
  as(CLUB_VIEW, { permissions: ["org.view"] });
  state.activeTab = "coach-home";
  nav.renderLibraryNav();
  for (const selector of MODULES) assert.equal(hidden(selector), true, `hidden: ${selector}`);
  assert.equal(hidden("#athleteSearch"), true);
  assert.equal(hidden('[data-library-tab="organization"][data-organization-section="overview"]'), false, "Settings stays");
  assert.equal(hidden('[data-library-tab="coach-account"]'), false, "Account stays");
  for (const section of ["users", "athletes", "presets"]) {
    assert.equal(hidden(`.sidebar-subnav-button[data-organization-section="${section}"]`), true, section);
  }
  for (const section of ["clubs", "teams"]) {
    assert.equal(hidden(`.sidebar-subnav-button[data-organization-section="${section}"]`), false, section);
  }
  // Back in the club admin's own workspace: everything as before.
  as(CLUB_WS, { clubs: [{ id: CLUB, role: "club_admin" }] });
  nav.renderLibraryNav();
  for (const selector of MODULES) assert.equal(hidden(selector), false, `shown again: ${selector}`);
  assert.equal(hidden("#athleteSearch"), false);
});

test("4. a tab a view workspace cannot open falls back to Home; Home, Settings and Account stay", () => {
  as(CLUB_VIEW, { permissions: ["org.view"] });
  for (const tab of ["builder", "training-load", "tests", "exercises", "templates", "central-calendar", "coaches", "weekly"]) {
    state.activeTab = tab;
    nav.renderLibraryNav();
    assert.equal(state.activeTab, "coach-home", tab);
  }
  for (const tab of ["coach-home", "organization", "coach-account"]) {
    state.activeTab = tab;
    nav.renderLibraryNav();
    assert.equal(state.activeTab, tab, tab);
  }
  // Without org.view, Settings is not a place either.
  as(CLUB_VIEW, { permissions: [] });
  state.activeTab = "organization";
  nav.renderLibraryNav();
  assert.equal(state.activeTab, "coach-home");
});

test("5. labels: the scope label, the Settings card and Home name the club or team", () => {
  as(CLUB_VIEW, { permissions: ["org.view"] });
  assert.equal(access.accessScopeLabel(), "Test Club");
  as(TEAM_VIEW, { permissions: ["org.view"] });
  assert.equal(access.accessScopeLabel(), "Test Team");
  const card = orgView.renderWorkspaceScopeCard(CLUB_VIEW);
  assert.match(card, /Test Club/);
  assert.match(card, /role holder \(view\)/);
});

test("6. the short Home: the name, a sentence, one button per section it may open, the other workspaces; nothing else", () => {
  as(CLUB_VIEW, { permissions: ["org.view"], availableWorkspaces: [CLUB_VIEW, { type: "athlete", scopeId: null, label: "Athlete" }] });
  const html = home.renderViewHomeHtml(state.currentUser, permissionNav.viewSettingsSections());
  document.body.insertAdjacentHTML("beforeend", `<div id="probe">${html}</div>`);
  const probe = document.getElementById("probe");
  assert.equal(probe.querySelector("h2").textContent, "Test Club");
  assert.match(probe.textContent, /You can see this club's details/);
  assert.deepEqual([...probe.querySelectorAll('[data-action="view-home-open-settings"]')].map((b) => b.dataset.section), ["overview", "clubs", "teams"]);
  assert.deepEqual([...probe.querySelectorAll('[data-action="workspace-select"]')].map((b) => b.dataset.workspaceType), ["athlete"], "the active one is not listed again");
  assert.ok(!probe.querySelector('[data-action="home-add-athlete"]'), "no coach actions");
  assert.ok(!probe.querySelector(".coach-home-grid"), "no coach cards");
  probe.remove();
  // Without a section: a sentence, no buttons.
  as(TEAM_VIEW, { permissions: [] });
  const empty = home.renderViewHomeHtml(state.currentUser, permissionNav.viewSettingsSections());
  assert.match(empty, /does not open any part of OptiMove in this team yet/);
  assert.doesNotMatch(empty, /view-home-open-settings/);
});

test("8. Clubs and Teams in a view workspace read only: no Edit or Delete on a row (a club admin keeps them)", () => {
  const d = { isPlatformAdmin: false, clubs: [{ id: CLUB, name: "Test Club" }], teams: [{ id: TEAM, club_id: CLUB, name: "Test Team" }], athletes: [], users: [] };
  for (const section of ["clubs", "teams"]) {
    as(CLUB_VIEW, { permissions: ["org.view"] });
    state.organization = { ...state.organization, section, selectedClubId: "", selectedTeamId: "" };
    const html = orgView.renderOrganizationBrowser(d);
    assert.match(html, /organization-select-(club|team)/, section);
    assert.doesNotMatch(html, /data-action="organization-(edit|delete)"/, section);
    as(CLUB_WS, { clubs: [{ id: CLUB, role: "club_admin" }] });
    assert.match(orgView.renderOrganizationBrowser({ ...d, manageableTeamIds: [TEAM] }), /data-action="organization-edit"/, `${section} admin`);
  }
});

test("7. a staff workspace is unchanged: club admin, team coach and the old fallback without a list", () => {
  as(CLUB_WS, { clubs: [{ id: CLUB, role: "club_admin" }] });
  assert.equal(access.isViewWorkspace(), false);
  assert.equal(access.hasOrganizationAccess(), true);
  assert.equal(permissionNav.permissionTabAllowed("athletes"), true, "no list: today's visibility");
  as({ type: "team", scopeId: TEAM, label: "Test Team" }, { permissions: ["org.view"] });
  assert.equal(access.isViewWorkspace(), false);
  assert.equal(access.hasOrganizationAccess(), true);
});
