import { test } from "node:test";
import assert from "node:assert/strict";

// S2 (the Settings plan, the owner's GO of 2026-11-10): one section, one list. Each section draws only its own list
// under one heading with its count, and Overview is a summary whose tiles open those sections. A selected club still
// opens its teams and roster in Clubs, and a selected team its roster in Teams. Browser proof:
// e2e/tests/settings-sections.test.mjs.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderOrganizationBrowser } = await import("../organization-view.js");
const { state } = await import("../state.js");

function reset(section, pick = {}) {
  state.organization = { data: null, error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showDisabledUsers: false, showArchivedTeams: false, ...pick };
  state.organizationInvite = { open: false };
  state.organizationUserManage = { open: false };
  state.athleteAccountManage = { open: false };
  state.currentUser = { id: "viewer-1", activeWorkspace: { type: "club", scopeId: "c1", label: "Demo Club" } };
}
const member = { id: "a1", name: "Ana Athlete", athlete_id: "A1", user_id: "u9", login_active: true, is_active: true, has_active_access: true, memberships: [{ status: "active", membershipType: "team", clubId: "c1", teamId: "t1" }] };
const data = { isPlatformAdmin: false, clubs: [{ id: "c1", name: "Demo Club" }, { id: "c2", name: "Other Club" }], teams: [{ id: "t1", club_id: "c1", club_name: "Demo Club", name: "Demo Team" }], athletes: [member], users: [{ id: "u1", name: "Coach Demo", email: "coach@example.invalid", loginActive: true, roles: [] }], manageableTeamIds: ["t1"] };
const has = (html, action) => html.includes(`data-action="${action}"`);
const h2 = (html) => [...html.matchAll(/<h2 class="organization-section-title">([^<]*)<\/h2>/g)].map((m) => m[1]);

test("Overview is a summary: one heading and a tile per section, no list", () => {
  reset("overview");
  const html = renderOrganizationBrowser(data);
  assert.deepEqual(h2(html), ["All accessible organization"]);
  assert.ok(html.includes('aria-label="1 user"><strong>1</strong><span>User</span>'), "one is singular");
  assert.ok(html.includes('aria-label="2 clubs"><strong>2</strong><span>Clubs</span>'));
  for (const [section, count] of [["users", 1], ["clubs", 2], ["teams", 1], ["athletes", 1]]) {
    assert.match(html, new RegExp(`data-action="organization-section" data-section="${section}" aria-label="${count} [a-z]+"><strong>${count}</strong><span>[A-Z][a-z]+</span>`));
  }
  for (const action of ["organization-select-club", "organization-select-team", "organization-edit", "organization-manage-account-open", "organization-athlete-login-open"]) {
    assert.ok(!has(html, action), `Overview draws no list (${action})`);
  }
});

test("each section draws its own list under one heading with its count", () => {
  const cases = {
    clubs: { title: "Clubs", count: "2 clubs", own: ["organization-select-club"], not: ["organization-select-team", "organization-athlete-login-open", "organization-manage-account-open"] },
    teams: { title: "Teams", count: "1 team", own: ["organization-select-team"], not: ["organization-select-club", "organization-athlete-login-open", "organization-manage-account-open"] },
    athletes: { title: "Athletes", count: "1 athlete", own: ["organization-athlete-login-open"], not: ["organization-select-club", "organization-select-team", "organization-manage-account-open"] },
    users: { title: "Users", count: "1 active user", own: ["organization-manage-account-open"], not: ["organization-select-club", "organization-select-team", "organization-athlete-login-open"] },
  };
  for (const [section, c] of Object.entries(cases)) {
    reset(section);
    const html = renderOrganizationBrowser(data);
    assert.deepEqual(h2(html), [c.title], section);
    assert.ok(html.includes(c.count), `${section}: ${c.count}`);
    assert.ok(!html.includes("Organization browser"), `${section}: the browser card is Overview's only`);
    for (const action of c.own) assert.ok(has(html, action), `${section} keeps ${action}`);
    for (const action of c.not) assert.ok(!has(html, action), `${section} does not draw ${action}`);
  }
});

test("a selected club opens its teams and roster in Clubs; a selected team its roster in Teams; Show all clears", () => {
  reset("clubs", { selectedClubId: "c1" });
  let html = renderOrganizationBrowser(data);
  assert.deepEqual(h2(html), ["Demo Club"]);
  assert.ok(html.includes("Teams - Demo Club") && has(html, "organization-select-team") && html.includes("Club roster"));
  assert.ok(has(html, "organization-clear-selection"));
  reset("teams", { selectedClubId: "c1", selectedTeamId: "t1" });
  html = renderOrganizationBrowser(data);
  assert.deepEqual(h2(html), ["Demo Team"]);
  assert.ok(html.includes("Team roster") && has(html, "organization-toggle-assign-athlete") && has(html, "organization-clear-selection"));
  assert.ok(!has(html, "organization-select-club"));
});

test("review fixes: Users' own controls sit in the section heading; Clubs with a team is headed by the team; Athletes keeps its name", () => {
  reset("users", { showDisabledUsers: false });
  const users = { ...data, users: [...data.users, { id: "u2", name: "Gone Demo", email: "gone@example.invalid", loginActive: false, roles: [] }] };
  let html = renderOrganizationBrowser(users);
  const head = html.slice(html.indexOf('class="organization-browser-head"'), html.indexOf('class="organization-lists'));
  assert.match(head, /data-action="organization-toggle-disabled-users">Show disabled \(1\)</, "Show disabled is in the heading");
  assert.ok(!html.includes('class="organization-list-head"'), "the Users list has no head of its own");
  reset("clubs", { selectedClubId: "c1", selectedTeamId: "t1" });
  html = renderOrganizationBrowser(data);
  assert.deepEqual(h2(html), ["Demo Team"]);
  assert.ok(html.includes("1 athlete in team"));
  reset("teams", { selectedClubId: "c1", selectedTeamId: "t1" });
  assert.ok(renderOrganizationBrowser(data).includes('<p class="eyebrow">Teams - Demo Club</p>'), "a list narrowed to one club says so");
  reset("athletes", { selectedClubId: "c1" });
  assert.deepEqual(h2(renderOrganizationBrowser(data)), ["Athletes - Demo Club"]);
  reset("athletes", { selectedClubId: "c1", selectedTeamId: "t1" });
  assert.deepEqual(h2(renderOrganizationBrowser(data)), ["Athletes - Demo Team"]);
});
