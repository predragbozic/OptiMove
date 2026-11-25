// Roles V-2 (docs/ai/roles-v-steps-plan.md sections 2.3 and 9): what a view workspace (club_view / team_view) shows of
// Athletes - the sidebar's athlete list and Settings -> Athletes, read only, with no control of any kind. Every route
// still decides again (backend/tests/roles-v-sweep.test.mjs test 7). Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let state;
let renderAthleteListHtml;
let renderViewAthleteListHtml;
let renderOrganizationBrowser;
let viewHiddenMenuSelectors;
let viewSettingsSections;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const TEAM = "22222222-0000-4000-8000-0000000000a1";
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const as = (activeWorkspace, permissions) => {
  state.currentUser = { id: "u1", name: "Viewer A", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], permissions };
};
const ATHLETES = [
  { id: "a1", athlete_id: "17", name: "Mira Testova", image_url: null, is_active: true, club_id: CLUB, club_name: "Test Club",
    team_id: TEAM, team_name: "Test Team", has_active_access: true,
    memberships: [{ membershipType: "club", clubId: CLUB, status: "active" }, { membershipType: "team", clubId: CLUB, teamId: TEAM, status: "active" }] },
  { id: "a2", athlete_id: "18", name: "Lena Probna", image_url: null, is_active: true, club_id: CLUB, club_name: "Test Club",
    team_id: null, team_name: null, has_active_access: true, memberships: [{ membershipType: "club", clubId: CLUB, status: "active" }] },
];
const viewData = () => ({ clubs: [{ id: CLUB, name: "Test Club" }], teams: [{ id: TEAM, club_id: CLUB, name: "Test Team" }], athletes: ATHLETES,
  users: [], accessRequests: [], joinLinks: [], joinApplications: [], archivedTeams: [], manageableClubIds: [], manageableTeamIds: [],
  canCreateAthlete: false, canCreateClub: false, canCreateTeam: false, canCreateUser: false, isPlatformAdmin: false });
const CONTROLS = /data-action="organization-(edit|invite-athlete|archive|toggle-athlete-access|toggle-archived|athlete-login|athlete-account|toggle-add-form|toggle-assign)/;

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  ({ state } = await import("../state.js"));
  ({ renderAthleteListHtml } = await import("../athlete-view.js"));
  ({ renderViewAthleteListHtml, renderOrganizationBrowser } = await import("../organization-view.js"));
  ({ viewHiddenMenuSelectors } = await import("../view-modules.js"));
  ({ viewSettingsSections } = await import("../permission-nav.js"));
});

test("1. the menu place and the Settings section open only with athletes.view", () => {
  as(CLUB_VIEW, ["org.view", "athletes.view"]);
  assert.equal(viewHiddenMenuSelectors().includes("#athleteList"), false, "the sidebar's athlete list opens");
  assert.ok(viewSettingsSections().includes("athletes"), "Settings -> Athletes opens");
  as(CLUB_VIEW, ["org.view", "presets.use"]);
  assert.ok(viewHiddenMenuSelectors().includes("#athleteList"), "without the word the list stays hidden");
  assert.equal(viewSettingsSections().includes("athletes"), false);
});

test("2. the sidebar list read only: plain rows, no button, no plan counts", () => {
  const rows = [{ athlete_uuid: "a1", athlete_id: "17", athlete: "Mira Testova", athlete_image_url: "", weekly_plan_count: null, program_count: null }];
  const html = renderAthleteListHtml(rows, "17", { readOnly: true });
  assert.ok(html.includes("Mira Testova") && html.includes("ID 17"));
  assert.equal(/<button/.test(html), false, "no control");
  assert.equal(/weekly|specific/.test(html), false, "no plan counts");
  assert.ok(/<button/.test(renderAthleteListHtml(rows, "17")), "a coach's list keeps its buttons");
});

test("3. Settings -> Athletes in a view workspace: the read-only list, no control, the athlete's position when read", () => {
  as(CLUB_VIEW, ["org.view", "athletes.view"]);
  state.positions = { ...state.positions, loaded: true, assignmentsLoaded: true, list: [{ id: "p1", name: "Winger" }], assignments: { a1: "p1" } };
  const list = renderViewAthleteListHtml(ATHLETES);
  assert.ok(list.includes("Mira Testova") && list.includes("Lena Probna") && list.includes("Winger"));
  assert.equal(/<button/.test(list), false);
  for (const section of ["athletes", "clubs", "teams"]) {
    state.organization.section = section;
    state.organization.selectedClubId = section === "clubs" ? CLUB : null;
    state.organization.selectedTeamId = section === "teams" ? TEAM : null;
    const html = renderOrganizationBrowser(viewData());
    assert.ok(html.includes("Mira Testova"), `${section}: the athletes are listed`);
    assert.equal(CONTROLS.test(html), false, `${section}: no add, edit, archive, invite, login or access control`);
  }
  state.organization.selectedClubId = null;
  state.organization.selectedTeamId = null;
});

test("4. without athletes.view a chosen club or team shows no roster, as before V-2", () => {
  as(CLUB_VIEW, ["org.view"]);
  state.organization.section = "clubs";
  state.organization.selectedClubId = CLUB;
  const html = renderOrganizationBrowser({ ...viewData(), athletes: [] });
  assert.equal(html.includes("No athletes here yet"), false);
  state.organization.selectedClubId = null;
});
