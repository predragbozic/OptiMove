import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 5 follow-up: hasOrganizationAccess/canManageCoachProfile/
// accessScopeLabel must be driven by state.currentUser.activeWorkspace, never
// by the role_hint-derived role/accessScope fields - a multi-role account
// whose role_hint says "athlete" but is currently acting as a club_admin (or
// vice versa) must get navigation that matches its ACTIVE workspace, not its
// legacy display label.

const orgButtonEl = { hidden: false };
const orgSubmenuEl = { hidden: false };
const builderButtonEl = { hidden: false };
let athleteMode = false;

globalThis.document = {
  querySelector: (selector) => {
    if (selector === '[data-library-tab="organization"]') return orgButtonEl;
    if (selector === '[data-sidebar-submenu="settings"]') return orgSubmenuEl;
    if (selector === '[data-library-tab="builder"]') return builderButtonEl;
    return null;
  },
  querySelectorAll: () => [],
  body: { classList: { contains: () => athleteMode } },
};

const { renderAccessNav } = await import("../navigation.js");
const { hasOrganizationAccess, canManageCoachProfile, accessScopeLabel } = await import("../access.js");
const { state } = await import("../state.js");

function resetState() {
  athleteMode = false;
  orgButtonEl.hidden = false;
  orgSubmenuEl.hidden = false;
  builderButtonEl.hidden = false;
}

test("1. role_hint='athlete' with a real active club workspace still shows Organization navigation", () => {
  resetState();
  state.currentUser = {
    role_hint: "athlete",
    role: "athlete",
    accessScope: "athlete",
    activeWorkspace: { type: "club", scopeId: "club-1", label: "FK Partizan" },
    availableWorkspaces: [],
  };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, false, "a real active club workspace must show Organization, regardless of role_hint='athlete'");
  assert.equal(orgSubmenuEl.hidden, false);
  assert.equal(hasOrganizationAccess(), true);
});

test("2. role_hint='athlete' with an active private_coach workspace shows staff navigation", () => {
  resetState();
  state.currentUser = { role_hint: "athlete", accessScope: "athlete", activeWorkspace: { type: "private_coach", scopeId: null } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, false);
  assert.equal(canManageCoachProfile(), true);
});

test("3. role_hint='coach' with an active athlete workspace hides Organization navigation", () => {
  resetState();
  state.currentUser = { role_hint: "coach", role: "coach", accessScope: "platform", activeWorkspace: { type: "athlete", scopeId: null } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, true, "an active athlete workspace must hide Organization even though role_hint='coach'");
  assert.equal(hasOrganizationAccess(), false);
  assert.equal(canManageCoachProfile(), false);
});

test("4. a fake staff role_hint with no real workspace never shows Organization navigation", () => {
  resetState();
  state.currentUser = { role_hint: "platform_admin", role: "platform_admin", accessScope: "platform", activeWorkspace: null, availableWorkspaces: [] };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, true, "a null activeWorkspace must hide Organization no matter what role_hint/accessScope claim");
  assert.equal(hasOrganizationAccess(), false);
});

test("5. switching the active workspace immediately re-renders the correct navigation", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "athlete", scopeId: null } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, true);

  state.currentUser = { ...state.currentUser, activeWorkspace: { type: "club", scopeId: "club-1", label: "FK Partizan" } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, false, "Organization must appear as soon as the active workspace switches to a staff context");

  state.currentUser = { ...state.currentUser, activeWorkspace: { type: "team", scopeId: "team-1", label: "U18 Boys" } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, false);

  state.currentUser = { ...state.currentUser, activeWorkspace: { type: "athlete", scopeId: null } };
  renderAccessNav();
  assert.equal(orgButtonEl.hidden, true, "Organization must disappear again the moment the workspace switches back to athlete");
});

test("6. accessScopeLabel is derived from activeWorkspace, using the real club/team name", () => {
  resetState();
  state.currentUser = { accessScope: "athlete", activeWorkspace: { type: "platform", scopeId: null } };
  assert.equal(accessScopeLabel(), "All platform data");

  state.currentUser = { accessScope: "athlete", activeWorkspace: { type: "private_coach", scopeId: null } };
  assert.equal(accessScopeLabel(), "Private coaching");

  state.currentUser = { accessScope: "athlete", activeWorkspace: { type: "club", scopeId: "club-1", label: "FK Partizan" } };
  assert.equal(accessScopeLabel(), "FK Partizan");

  state.currentUser = { accessScope: "athlete", activeWorkspace: { type: "team", scopeId: "team-1", label: "U18 Boys" } };
  assert.equal(accessScopeLabel(), "U18 Boys");

  state.currentUser = { accessScope: "platform", activeWorkspace: { type: "athlete", scopeId: null } };
  assert.equal(accessScopeLabel(), "Athlete view");
});

test("7. before /me has resolved activeWorkspace (bare login response), the legacy accessScope fallback still applies", () => {
  resetState();
  // No "activeWorkspace" key at all - the exact shape returned by /login
  // before the follow-up /me call completes.
  state.currentUser = { accessScope: "platform" };
  assert.equal(hasOrganizationAccess(), true);
  state.currentUser = { accessScope: "athlete" };
  assert.equal(hasOrganizationAccess(), false);
});
