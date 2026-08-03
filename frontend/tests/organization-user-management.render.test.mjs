import { test } from "node:test";
import assert from "node:assert/strict";

// See organization-view.render.test.mjs for why this stub is needed and why
// it must be set before the dynamic import below.
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderOrganizationBrowser, renderManageAccountModal } = await import("../organization-view.js");
const { state } = await import("../state.js");

function resetOrganizationState() {
  state.organization = {
    data: null,
    error: "",
    selectedClubId: "",
    selectedTeamId: "",
    section: "users",
    addFormOpen: false,
    assignOpen: false,
    accessOpen: false,
    showArchivedAthletes: false,
    showArchivedTeamMembers: false,
    showArchivedClubMembers: false,
    showDisabledUsers: false,
    requestStatus: "all",
    requestAthleteId: "all",
    requestError: "",
    requestMessage: "",
  };
  state.organizationInvite = { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.currentUser = { id: "viewer-1" };
}

function baseUser(overrides) {
  return {
    id: "user-unset",
    email: "unset@test.local",
    name: "Unset User",
    role_hint: "user",
    legacyDisplayRole: "user",
    loginActive: true,
    isAthlete: false,
    globalRoles: [],
    clubRoles: [],
    teamRoles: [],
    canManageLogin: true,
    capabilities: { coachWorkspace: false, athleteWorkspace: false, platformAdministration: false },
    ...overrides,
  };
}

function baseData(users, overrides) {
  return { isPlatformAdmin: false, clubs: [], teams: [], athletes: [], manageableClubIds: [], manageableTeamIds: [], users, ...overrides };
}

test("a multi-role account shows every applicable badge at once", () => {
  resetOrganizationState();
  const multiRole = baseUser({
    id: "user-multi",
    name: "Multi Role",
    email: "multi@test.local",
    role_hint: "athlete",
    loginActive: true,
    isAthlete: true,
    globalRoles: [
      { role: "platform_admin", isActive: true },
      { role: "independent_coach", isActive: true },
    ],
    clubRoles: [{ clubId: "club-1", clubName: "FK Borac", role: "club_admin", isActive: true }],
    teamRoles: [{ teamId: "team-1", teamName: "First Team", clubId: "club-1", role: "team_coach", isActive: true }],
  });
  const html = renderOrganizationBrowser(baseData([multiRole]));

  assert.ok(html.includes("Active login"), "must show the login-active badge");
  assert.ok(html.includes(">Athlete<"), "must show the athlete badge");
  assert.ok(html.includes("Platform administrator"), "must show the platform administrator badge");
  assert.ok(html.includes("Independent/private coach"), "must show the independent/private coach badge");
  assert.ok(html.includes("FK Borac"), "must show the club role badge with the club name");
  assert.ok(html.includes("First Team"), "must show the team role badge with the team name");
});

test("role_hint alone (no matching real rows) never produces a role badge", () => {
  resetOrganizationState();
  const fakeAdmin = baseUser({
    id: "user-fake-admin",
    name: "Fake Admin",
    email: "fake-admin@test.local",
    role_hint: "platform_admin",
    legacyDisplayRole: "platform_admin",
    isAthlete: false,
    globalRoles: [],
    clubRoles: [],
    teamRoles: [],
  });
  const html = renderOrganizationBrowser(baseData([fakeAdmin]));

  assert.ok(!html.includes("Platform administrator"), "role_hint='platform_admin' with no real global role row must not show the badge");
  assert.ok(!html.includes(">Athlete<"), "no athlete badge without isAthlete=true");
  assert.ok(!html.includes("Independent/private coach"), "no coach badge without a real independent_coach row");
});

test("a disabled account shows Login disabled and is visually dimmed", () => {
  resetOrganizationState();
  state.organization.showDisabledUsers = true;
  const disabled = baseUser({ id: "user-disabled", name: "Disabled User", email: "disabled@test.local", loginActive: false });
  const html = renderOrganizationBrowser(baseData([disabled]));

  assert.ok(html.includes("Login disabled"), "must show the Login disabled badge");
  assert.ok(html.includes("is-disabled-account"), "the row must carry the dimmed disabled-account class");
});

test("Show disabled filter hides disabled accounts by default and reveals them on toggle", () => {
  resetOrganizationState();
  const active = baseUser({ id: "user-active", name: "Active User", loginActive: true });
  const disabled = baseUser({ id: "user-disabled-2", name: "Hidden Disabled User", loginActive: false });
  const data = baseData([active, disabled]);

  const collapsed = renderOrganizationBrowser(data);
  assert.ok(collapsed.includes("Active User"), "the active account must be shown");
  assert.ok(!collapsed.includes("Hidden Disabled User"), "the disabled account must be hidden by default");
  assert.ok(collapsed.includes("Show disabled (1)"), "a Show disabled toggle with the disabled count must be offered");

  state.organization.showDisabledUsers = true;
  const expanded = renderOrganizationBrowser(data);
  assert.ok(expanded.includes("Hidden Disabled User"), "toggling Show disabled must reveal the disabled account");
  assert.ok(expanded.includes("Hide disabled"), "the toggle must now read Hide disabled");
});

test("the Users list never offers a Delete action for a user row", () => {
  resetOrganizationState();
  const user = baseUser({ id: "user-no-delete", name: "No Delete User" });
  const html = renderOrganizationBrowser(baseData([user]));

  assert.ok(!html.includes('data-action="organization-delete" data-org-type="user"'), "no legacy delete action for a user row");
  assert.ok(!html.includes(">Delete<"), "the word Delete must not appear anywhere in the Users list");
  assert.ok(html.includes("Manage account"), "a Manage account action must be offered instead");
});

test("Manage account modal renders separate sections, never a combined 'Global roles' heading", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-modal",
    name: "Modal User",
    email: "modal@test.local",
    isAthlete: true,
    globalRoles: [{ role: "platform_admin", isActive: true }, { role: "independent_coach", isActive: false }],
    clubRoles: [{ clubId: "club-1", clubName: "FK Partizan", role: "club_admin", isActive: true }],
    teamRoles: [{ teamId: "team-1", teamName: "U17", clubId: "club-1", role: "team_coach", isActive: false }],
  });
  state.organizationUserManage = { open: true, userId: "user-modal", pending: false, error: "" };
  const html = renderManageAccountModal(baseData([user], { isPlatformAdmin: true }));

  assert.ok(html.includes("Account status"), "must have an Account status section");
  assert.ok(html.includes("Platform access"), "must have a Platform access section");
  assert.ok(html.includes("Private coaching"), "must have a Private coaching section");
  assert.ok(html.includes("Club roles"), "must have a Club roles section");
  assert.ok(html.includes("Team roles"), "must have a Team roles section");
  assert.ok(html.includes("Athlete profile"), "must have an Athlete profile section");
  assert.ok(!html.includes("Global roles"), "must never use the combined 'Global roles' heading");
  assert.ok(html.includes("Athlete profile linked"), "isAthlete=true must show the linked message");
  assert.ok(html.includes("FK Partizan"), "the club role row must show the club name");
  assert.ok(html.includes("Club admin"), "the club role row must show the role name");
  assert.ok(html.includes("U17"), "the team role row must show the team name");
});

test("a viewer with real platformAdministration sees Grant/Remove controls; a non-platform viewer does not", () => {
  resetOrganizationState();
  const user = baseUser({ id: "user-perm", name: "Perm User", globalRoles: [{ role: "platform_admin", isActive: true }] });
  state.organizationUserManage = { open: true, userId: "user-perm", pending: false, error: "" };

  const asAdmin = renderManageAccountModal(baseData([user], { isPlatformAdmin: true }));
  assert.ok(asAdmin.includes("Remove access"), "a platform admin viewer must see Remove access for the active platform admin role");
  assert.ok(asAdmin.includes("Grant private coaching"), "a platform admin viewer must see Grant private coaching");

  const asNonAdmin = renderManageAccountModal(baseData([user], { isPlatformAdmin: false }));
  assert.ok(!asNonAdmin.includes("Remove access"), "a non-platform-admin viewer must not see Remove access");
  assert.ok(!asNonAdmin.includes("Grant access"), "a non-platform-admin viewer must not see Grant access");
  assert.ok(!asNonAdmin.includes("Grant private coaching"), "a non-platform-admin viewer must not see Grant private coaching");
  assert.ok(!asNonAdmin.includes("Remove private coaching"), "a non-platform-admin viewer must not see Remove private coaching");
});

test("self-disable is never offered in the Manage account modal", () => {
  resetOrganizationState();
  const self = baseUser({ id: "viewer-1", name: "Myself", loginActive: true });
  state.organizationUserManage = { open: true, userId: "viewer-1", pending: false, error: "" };
  const html = renderManageAccountModal(baseData([self], { isPlatformAdmin: true }));

  assert.ok(!html.includes("Disable login"), "the viewer's own row must never offer Disable login");
  assert.ok(html.includes("You can't disable your own login"), "a clear note must explain why it's unavailable");
});

test("Manage account modal shows an in-modal error banner without hiding the rest of the modal", () => {
  resetOrganizationState();
  const user = baseUser({ id: "user-err", name: "Err User", globalRoles: [{ role: "platform_admin", isActive: true }] });
  state.organizationUserManage = { open: true, userId: "user-err", pending: false, error: "At least one active platform administrator must remain." };
  const html = renderManageAccountModal(baseData([user], { isPlatformAdmin: true }));

  assert.ok(html.includes("At least one active platform administrator must remain."), "the error message must be shown");
  assert.ok(html.includes("Account status"), "the rest of the modal must still render");
});

// --- canManageLogin gating ---

test("a non-self account with canManageLogin=true offers the Enable/Disable login control", () => {
  resetOrganizationState();
  const user = baseUser({ id: "user-managed", name: "Managed User", loginActive: true, canManageLogin: true });
  state.organizationUserManage = { open: true, userId: "user-managed", pending: false, error: "" };
  const html = renderManageAccountModal(baseData([user], { isPlatformAdmin: true }));

  assert.ok(html.includes("Disable login"), "canManageLogin=true must offer the control");
  assert.ok(!html.includes("You don't have permission to change this login."), "no permission note when the control is offered");
});

test("a non-self account with canManageLogin=false shows a neutral permission message instead of a control", () => {
  resetOrganizationState();
  const user = baseUser({ id: "user-unmanaged", name: "Unmanaged User", loginActive: true, canManageLogin: false });
  state.organizationUserManage = { open: true, userId: "user-unmanaged", pending: false, error: "" };
  const html = renderManageAccountModal(baseData([user], { isPlatformAdmin: false }));

  assert.ok(!html.includes("Disable login"), "canManageLogin=false must not offer the control");
  assert.ok(!html.includes("Enable login"), "canManageLogin=false must not offer the control even for a disabled login");
  assert.ok(html.includes("You don't have permission to change this login."), "a neutral permission message must be shown instead");
});

test("the viewer's own account keeps the existing self-disable message even when canManageLogin=true", () => {
  resetOrganizationState();
  const self = baseUser({ id: "viewer-1", name: "Myself", loginActive: true, canManageLogin: true });
  state.organizationUserManage = { open: true, userId: "viewer-1", pending: false, error: "" };
  const html = renderManageAccountModal(baseData([self], { isPlatformAdmin: true }));

  assert.ok(!html.includes("Disable login"), "self must never see the control regardless of canManageLogin");
  assert.ok(html.includes("You can't disable your own login"), "the self message takes priority over the permission message");
  assert.ok(!html.includes("You don't have permission to change this login."), "self gets its own message, not the generic permission one");
});

// --- scoped role badges show the role name, not just the club/team name ---

test("club and team badges show the real role name alongside the club/team name", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-scoped",
    name: "Scoped User",
    clubRoles: [{ clubId: "club-1", clubName: "FK Crvena zvezda", role: "club_admin", isActive: true }],
    teamRoles: [{ teamId: "team-1", teamName: "U17", clubId: "club-1", role: "team_coach", isActive: true }],
  });
  const html = renderOrganizationBrowser(baseData([user]));

  assert.ok(html.includes("Club admin"), "the club badge must show the role name");
  assert.ok(html.includes("FK Crvena zvezda"), "the club badge must still show the club name");
  assert.ok(html.includes("Team coach"), "the team badge must show the role name");
  assert.ok(html.includes("U17"), "the team badge must still show the team name");
});

// --- club/team role Add/Remove controls in the Manage account modal ---

test("a viewer who manages this club sees Add club administrator and Remove role for an active row", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-clubrole",
    name: "Club Role User",
    clubRoles: [{ clubId: "club-1", clubName: "FK Partizan", role: "club_admin", isActive: true }],
  });
  state.organizationUserManage = { open: true, userId: "user-clubrole", pending: false, error: "" };
  const data = baseData([user], {
    clubs: [{ id: "club-1", name: "FK Partizan" }, { id: "club-2", name: "FK Vojvodina" }],
    manageableClubIds: ["club-1", "club-2"],
  });
  const html = renderManageAccountModal(data);

  assert.ok(html.includes("Add club administrator"), "a viewer who manages clubs must see the Add control");
  assert.ok(html.includes("FK Vojvodina"), "the add-select must offer a manageable club the user doesn't already actively hold");
  assert.ok(!html.includes('<option value="club-1">'), "a club the user already actively holds must not be offered again in the add-select");
  assert.ok(html.includes('data-action="organization-club-role-remove"'), "an active club_admin row the viewer manages must offer Remove role");
});

test("a viewer who does not manage this club sees no Add/Remove club controls", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-clubrole-2",
    name: "Club Role User 2",
    clubRoles: [{ clubId: "club-1", clubName: "FK Partizan", role: "club_admin", isActive: true }],
  });
  state.organizationUserManage = { open: true, userId: "user-clubrole-2", pending: false, error: "" };
  const data = baseData([user], {
    clubs: [{ id: "club-1", name: "FK Partizan" }],
    manageableClubIds: [],
  });
  const html = renderManageAccountModal(data);

  assert.ok(!html.includes("Add club administrator"), "a viewer with no manageable clubs must not see the Add control");
  assert.ok(!html.includes('data-action="organization-club-role-remove"'), "a viewer who doesn't manage this club must not see Remove role");
});

test("team roles: Add team coach and Remove role appear only for manageable teams", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-teamrole",
    name: "Team Role User",
    teamRoles: [
      { teamId: "team-1", teamName: "U17", clubId: "club-1", role: "team_coach", isActive: true },
      { teamId: "team-2", teamName: "U19", clubId: "club-2", role: "team_coach", isActive: true },
    ],
  });
  state.organizationUserManage = { open: true, userId: "user-teamrole", pending: false, error: "" };
  const data = baseData([user], {
    teams: [{ id: "team-1", name: "U17", club_name: "FK Partizan" }, { id: "team-3", name: "U15", club_name: "FK Partizan" }],
    manageableTeamIds: ["team-1", "team-3"],
  });
  const html = renderManageAccountModal(data);

  assert.ok(html.includes("Add team coach"), "a viewer who manages teams must see the Add control");
  assert.ok(html.includes("U15"), "the add-select must offer a manageable team not already actively held");
  const removeButtons = html.match(/data-action="organization-team-role-remove"[^>]*data-team-id="([^"]*)"/g) || [];
  assert.ok(removeButtons.some((entry) => entry.includes('data-team-id="team-1"')), "the manageable team-1 row must offer Remove role");
  assert.ok(!removeButtons.some((entry) => entry.includes('data-team-id="team-2"')), "the non-manageable team-2 row must not offer Remove role");
});

test("a legacy/unsupported scoped role (e.g. club_manager) is always read-only, regardless of manageableClubIds", () => {
  resetOrganizationState();
  const user = baseUser({
    id: "user-legacy",
    name: "Legacy Role User",
    clubRoles: [{ clubId: "club-1", clubName: "FK Partizan", role: "club_manager", isActive: true }],
  });
  state.organizationUserManage = { open: true, userId: "user-legacy", pending: false, error: "" };
  const data = baseData([user], {
    clubs: [{ id: "club-1", name: "FK Partizan" }],
    manageableClubIds: ["club-1"],
  });
  const html = renderManageAccountModal(data);

  assert.ok(html.includes("Club manager"), "the legacy role name must still be shown");
  assert.ok(!html.includes('data-action="organization-club-role-remove"'), "a legacy club_manager role must never offer Remove role, even when the viewer manages the club");
});

