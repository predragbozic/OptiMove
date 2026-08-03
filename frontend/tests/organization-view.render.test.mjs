import { test } from "node:test";
import assert from "node:assert/strict";

// organization-view.js pulls in navigation.js -> dom.js, which reads
// `document.querySelector`/`querySelectorAll` at module load time (it's a
// browser-only file with no test runner of its own). A minimal stub is
// enough since none of the rendering paths exercised here ever call methods
// on the returned elements - it only needs to exist so the import chain
// doesn't throw in plain Node. Must be set before the dynamic import below
// (a static top-level import would be hoisted ahead of this and see no
// `document` at all).
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderOrganizationBrowser } = await import("../organization-view.js");
const { state } = await import("../state.js");

function resetOrganizationState() {
  state.organization = {
    data: null,
    error: "",
    selectedClubId: "",
    selectedTeamId: "",
    section: "athletes",
    addFormOpen: false,
    assignOpen: false,
    accessOpen: false,
    showArchivedAthletes: false,
    showArchivedTeamMembers: false,
    showArchivedClubMembers: false,
    requestStatus: "all",
    requestAthleteId: "all",
    requestError: "",
    requestMessage: "",
  };
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
}

function baseAthlete(overrides) {
  return {
    id: "unset",
    athlete_id: "AT1",
    source_external_id: "AT1",
    name: "Unset Athlete",
    image_url: "",
    is_active: true,
    club_id: null,
    club_name: null,
    team_id: null,
    team_name: null,
    user_id: null,
    login_active: null,
    login_is_multi_role: false,
    memberships: [],
    has_my_active_coach_relationship: false,
    has_my_archived_coach_relationship: false,
    has_active_access: false,
    can_view_coach_library: true,
    can_view_team_library: false,
    can_view_club_library: false,
    can_view_optimove_library: false,
    can_view_marketplace: false,
    free_only: true,
    require_approval: true,
    selected_programs_only: false,
    ...overrides,
  };
}

test("team coach: an athlete whose only tie is an archived team membership is excluded from the roster but shown under Show archived", () => {
  resetOrganizationState();
  const teamId = "team-1";
  const clubId = "club-1";

  const activeOnTeam = baseAthlete({
    id: "athlete-active",
    name: "Active Roster Athlete",
    has_active_access: true,
    memberships: [{ id: "m1", membershipType: "team", status: "active", clubId, clubName: "Club One", teamId, teamName: "Team One" }],
  });
  const archivedOnTeam = baseAthlete({
    id: "athlete-archived",
    name: "Archived Roster Athlete",
    has_active_access: false,
    memberships: [{ id: "m2", membershipType: "team", status: "archived", clubId, clubName: "Club One", teamId, teamName: "Team One" }],
  });

  const data = {
    isPlatformAdmin: false,
    clubs: [{ id: clubId, name: "Club One" }],
    teams: [{ id: teamId, club_id: clubId, club_name: "Club One", name: "Team One" }],
    athletes: [activeOnTeam, archivedOnTeam],
    users: [],
  };

  state.organization.selectedTeamId = teamId;
  state.organization.showArchivedTeamMembers = true;
  const html = renderOrganizationBrowser(data);

  const activeRosterSection = html.split("organization-archived-athletes")[0];
  assert.ok(activeRosterSection.includes("Active Roster Athlete"), "the actively-on-team athlete must be in the roster table");
  assert.ok(!activeRosterSection.includes("Archived Roster Athlete"), "the archived-only athlete must NOT be in the active roster table");

  assert.ok(html.includes("Archived Roster Athlete"), "the archived-only athlete must still appear somewhere (the Show archived section)");
  assert.ok(html.includes(`data-action="organization-restore-team-membership" data-team-id="${teamId}" data-athlete-id="athlete-archived"`), "a Restore action for this specific team must be offered");

  state.organization.showArchivedTeamMembers = false;
  const collapsed = renderOrganizationBrowser(data);
  assert.ok(!collapsed.includes("Archived Roster Athlete"), "collapsing Show archived must hide the archived-only athlete entirely");
  assert.ok(collapsed.includes("Active Roster Athlete"), "the active athlete must still be shown regardless of the archived toggle");
});

test("team coach: after restore, the athlete moves back into the roster and out of Show archived", () => {
  resetOrganizationState();
  const teamId = "team-1";
  const clubId = "club-1";
  const restored = baseAthlete({
    id: "athlete-restored",
    name: "Restored Roster Athlete",
    has_active_access: true,
    memberships: [{ id: "m3", membershipType: "team", status: "active", clubId, clubName: "Club One", teamId, teamName: "Team One" }],
  });
  const data = {
    isPlatformAdmin: false,
    clubs: [{ id: clubId, name: "Club One" }],
    teams: [{ id: teamId, club_id: clubId, club_name: "Club One", name: "Team One" }],
    athletes: [restored],
    users: [],
  };
  state.organization.selectedTeamId = teamId;
  state.organization.showArchivedTeamMembers = true;
  const html = renderOrganizationBrowser(data);

  const activeRosterSection = html.split("organization-archived-athletes")[0];
  assert.ok(activeRosterSection.includes("Restored Roster Athlete"), "must be back in the active roster");

  const archivedSection = html.split("organization-archived-athletes")[1] || "";
  assert.ok(!archivedSection.includes("Restored Roster Athlete"), "must no longer appear in Show archived for this team");
});

test("club admin: an athlete whose only tie is an archived club membership is excluded from the roster but shown under Show archived", () => {
  resetOrganizationState();
  const clubId = "club-2";

  const activeInClub = baseAthlete({
    id: "athlete-club-active",
    name: "Active Club Athlete",
    has_active_access: true,
    memberships: [{ id: "m4", membershipType: "club", status: "active", clubId, clubName: "Club Two", teamId: null, teamName: null }],
  });
  const archivedInClub = baseAthlete({
    id: "athlete-club-archived",
    name: "Archived Club Athlete",
    has_active_access: false,
    memberships: [{ id: "m5", membershipType: "club", status: "archived", clubId, clubName: "Club Two", teamId: null, teamName: null }],
  });

  const data = {
    isPlatformAdmin: false,
    clubs: [{ id: clubId, name: "Club Two" }],
    teams: [],
    athletes: [activeInClub, archivedInClub],
    users: [],
  };

  state.organization.selectedClubId = clubId;
  state.organization.showArchivedClubMembers = true;
  const html = renderOrganizationBrowser(data);

  const archivedMarkerIndex = html.indexOf("organization-archived-athletes");
  const rosterSection = archivedMarkerIndex === -1 ? html : html.slice(0, archivedMarkerIndex);
  assert.ok(rosterSection.includes("Active Club Athlete"), "the active club member must be in the roster");
  assert.ok(!rosterSection.includes("Archived Club Athlete"), "the archived-only club member must NOT be in the roster");

  assert.ok(html.includes("Archived Club Athlete"), "the archived-only club member must still appear under Show archived");
  assert.ok(html.includes(`data-action="organization-restore-club-membership" data-club-id="${clubId}" data-athlete-id="athlete-club-archived"`), "a Restore action for this specific club must be offered");

  state.organization.showArchivedClubMembers = false;
  const collapsed = renderOrganizationBrowser(data);
  assert.ok(!collapsed.includes("Archived Club Athlete"), "collapsing Show archived must hide the archived-only club member entirely");
});

test("club admin: after restore, the athlete moves back into the roster and out of Show archived", () => {
  resetOrganizationState();
  const clubId = "club-2";
  const restored = baseAthlete({
    id: "athlete-club-restored",
    name: "Restored Club Athlete",
    has_active_access: true,
    memberships: [{ id: "m6", membershipType: "club", status: "active", clubId, clubName: "Club Two", teamId: null, teamName: null }],
  });
  const data = {
    isPlatformAdmin: false,
    clubs: [{ id: clubId, name: "Club Two" }],
    teams: [],
    athletes: [restored],
    users: [],
  };
  state.organization.selectedClubId = clubId;
  state.organization.showArchivedClubMembers = true;
  const html = renderOrganizationBrowser(data);

  const archivedMarkerIndex = html.indexOf("organization-archived-athletes");
  const rosterSection = archivedMarkerIndex === -1 ? html : html.slice(0, archivedMarkerIndex);
  assert.ok(rosterSection.includes("Restored Club Athlete"), "must be back in the club roster");
  const archivedSection = archivedMarkerIndex === -1 ? "" : html.slice(archivedMarkerIndex);
  assert.ok(!archivedSection.includes("Restored Club Athlete"), "must no longer appear in Show archived for this club");
});

test("an archived-only athlete is never offered by the Invite modal", () => {
  resetOrganizationState();
  const archivedOnly = baseAthlete({
    id: "athlete-no-invite",
    name: "No Invite Athlete",
    has_active_access: false,
    has_my_archived_coach_relationship: true,
  });
  const data = { isPlatformAdmin: false, clubs: [], teams: [], athletes: [archivedOnly], users: [] };

  state.organizationInvite = { open: true, athleteId: "athlete-no-invite", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  const html = renderOrganizationBrowser(data);
  assert.ok(!html.includes("No Invite Athlete"), "the Invite modal must not render for an athlete with no active access");
});

test("an archived-only athlete's id is excluded from the Access control modal's bulk selection", () => {
  resetOrganizationState();
  const active = baseAthlete({ id: "athlete-access-active", name: "Access Active Athlete", has_active_access: true });
  const archivedOnly = baseAthlete({ id: "athlete-access-archived", name: "Access Archived Athlete", has_active_access: false, has_my_archived_coach_relationship: true });
  const data = { isPlatformAdmin: false, clubs: [], teams: [], athletes: [active, archivedOnly], users: [] };

  state.organization.accessOpen = true;
  const html = renderOrganizationBrowser(data);
  const idsMatch = html.match(/data-athlete-ids="([^"]*)"/);
  assert.ok(idsMatch, "the access control modal must render with a bulk athlete-ids attribute");
  const ids = idsMatch[1].split(",");
  assert.ok(ids.includes("athlete-access-active"), "the active athlete must be selectable");
  assert.ok(!ids.includes("athlete-access-archived"), "the archived-only athlete must not be offered for bulk access control");
});
