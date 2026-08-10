import { test } from "node:test";
import assert from "node:assert/strict";

// See organization-view.render.test.mjs for why this stub is needed and why
// it must be set before the dynamic import below.
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
    showDisabledUsers: false,
    requestStatus: "all",
    requestAthleteId: "all",
    requestError: "",
    requestMessage: "",
  };
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.athleteAccountManage = { open: false, athleteId: "", userId: "", loading: false, data: null, error: "", message: "", pending: false };
  state.currentUser = { id: "viewer-1" };
}

function baseAthlete(overrides) {
  return {
    id: "athlete-1",
    name: "Test Athlete",
    athlete_id: "AT001",
    user_id: null,
    login_active: null,
    has_my_active_coach_relationship: false,
    is_active: true,
    has_active_access: true,
    ...overrides,
  };
}

function baseData(athletes, overrides) {
  return { isPlatformAdmin: false, clubs: [], teams: [], athletes, ...overrides };
}

// === Visibility of the "Account" trigger button ===

test("the Account button is never shown to a non-platform-admin viewer, even for a login-bearing athlete", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ user_id: "user-1", login_active: true });
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: false }));
  assert.ok(!html.includes(`data-action="organization-athlete-account-open"`), "a coach/club/team admin viewer must never see the Account trigger");
});

test("the Account button is never shown for an athlete with no login, even to a platform admin", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ user_id: null });
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(!html.includes(`data-action="organization-athlete-account-open"`), "there is no account to view/manage before a login exists");
});

test("the Account button is shown to a platform admin for a login-bearing athlete, carrying both athlete and user ids", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-42", user_id: "user-42", login_active: true });
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(html.includes(`data-action="organization-athlete-account-open"`));
  assert.ok(html.includes(`data-athlete-id="athlete-42"`));
  assert.ok(html.includes(`data-user-id="user-42"`));
});

// === Modal content ===

test("the Account modal is not rendered at all when athleteAccountManage is closed", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-1", user_id: "user-1", login_active: true });
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(!html.includes("Account (platform admin)"));
});

test("while loading, the modal shows a loading state, not an error or the form", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-1", user_id: "user-1" });
  state.athleteAccountManage = { open: true, athleteId: "athlete-1", userId: "user-1", loading: true, data: null, error: "", message: "", pending: false };
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(html.includes("Loading account"));
});

test("the loaded modal shows the Login email under an explicit label and never a bare 'Email' label", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-1", name: "Ana Athlete", user_id: "user-1" });
  state.athleteAccountManage = {
    open: true,
    athleteId: "athlete-1",
    userId: "user-1",
    loading: false,
    data: { email: "ana@test.local", loginActive: true, pendingEmailChange: null },
    error: "",
    message: "",
    pending: false,
  };
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(html.includes("Ana Athlete"), "the modal header must identify which athlete this is");
  assert.ok(html.includes("Login email"));
  assert.ok(html.includes("ana@test.local"));
  assert.ok(html.includes("Active login"));
  assert.ok(html.includes(`data-organization-athlete-account-form="email-change-request"`), "no pending change - the start-request form must show");
  assert.ok(!html.includes("Contact email"), "this codebase's athletes table has no separate contact-email column - never fabricate that label");
});

test("a pending admin-initiated request shows the pending banner (not the request form) with Resend/Cancel", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-1", user_id: "user-1" });
  state.athleteAccountManage = {
    open: true,
    athleteId: "athlete-1",
    userId: "user-1",
    loading: false,
    data: {
      email: "old@test.local",
      loginActive: true,
      pendingEmailChange: { newEmail: "new@test.local", expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), requestSource: "platform_admin" },
    },
    error: "",
    message: "",
    pending: false,
  };
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(html.includes("new@test.local"));
  assert.ok(html.includes("Started by a platform admin"));
  assert.ok(html.includes(`data-action="organization-athlete-account-resend"`));
  assert.ok(html.includes(`data-action="organization-athlete-account-cancel"`));
  assert.ok(!html.includes(`data-organization-athlete-account-form="email-change-request"`), "the start-request form must not show while a request is already pending");
});

test("send password reset is disabled when the login is disabled", () => {
  resetOrganizationState();
  const athlete = baseAthlete({ id: "athlete-1", user_id: "user-1" });
  state.athleteAccountManage = {
    open: true,
    athleteId: "athlete-1",
    userId: "user-1",
    loading: false,
    data: { email: "disabled@test.local", loginActive: false, pendingEmailChange: null },
    error: "",
    message: "",
    pending: false,
  };
  const html = renderOrganizationBrowser(baseData([athlete], { isPlatformAdmin: true }));
  assert.ok(html.includes("Login disabled"));
  const buttonStart = html.indexOf(`data-action="organization-athlete-account-password-reset"`);
  const buttonTagStart = html.lastIndexOf("<button", buttonStart);
  const buttonTagEnd = html.indexOf(">", buttonStart);
  const buttonTag = html.slice(buttonTagStart, buttonTagEnd);
  assert.ok(buttonTag.includes("disabled"), "sending a password reset for a login-disabled account must be disabled in the UI");
});
