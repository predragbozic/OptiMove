import { test } from "node:test";
import assert from "node:assert/strict";

// S4 (the Settings plan, the manager's GO of 2026-11-10): one frame for Settings dialogs. Manage account, Athlete
// account, Invite and Edit share a head (eyebrow, title, subtitle, a close icon) that stays put while the body
// scrolls, and a saving dialog's footer (Cancel and the filled primary). Manage account's rows read "name, state" then
// the action, and its login switch comes last. Edit athlete is two parts with their own headings and saves. Browser
// proof: e2e/tests/settings-dialogs.test.mjs.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderManageAccountModal, renderAthleteAccountModal, renderOrganizationEditModal, renderOrganizationBrowser } = await import("../organization-view.js");
const { state } = await import("../state.js");

function reset() {
  state.organization = { data: null, error: "", selectedClubId: "", selectedTeamId: "", section: "athletes", addFormOpen: false, assignOpen: false, accessOpen: false };
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.athleteAccountManage = { open: false };
  state.organizationEditor = { open: false, type: "", row: null };
  state.currentUser = { id: "viewer-1", activeWorkspace: { type: "club", scopeId: "c1", label: "Demo Club" } };
}
const user = { id: "u2", name: "Coach Demo", email: "coach@example.invalid", loginActive: true, canManageLogin: true, globalRoles: [], clubRoles: [{ clubId: "c1", clubName: "Demo Club", role: "club_admin", isActive: true }], teamRoles: [] };
const athlete = { id: "a1", name: "Ana Demo", athlete_id: "A1", user_id: "u9", login_active: true, is_active: true, has_active_access: true, memberships: [] };
const data = { isPlatformAdmin: true, clubs: [{ id: "c1", name: "Demo Club" }], teams: [{ id: "t1", club_id: "c1", name: "Demo Team" }], athletes: [athlete], users: [user], manageableClubIds: ["c1"], manageableTeamIds: ["t1"] };
const head = (html, action) => new RegExp(`class="builder-modal-head organization-dialog-head"[\\s\\S]*?<h3>[^<]+</h3>[\\s\\S]*?<button class="plain-button icon-button organization-dialog-close" type="button" data-action="${action}" aria-label="Close"><svg`).test(html);

test("every Settings dialog has the frame's head with a close icon, not an 'x' glyph", () => {
  reset();
  state.organizationUserManage = { open: true, userId: "u2", pending: false, error: "" };
  const manage = renderManageAccountModal(data);
  assert.ok(head(manage, "organization-manage-account-close"), "Manage account");
  assert.match(manage, /<p class="muted">coach@example\.invalid<\/p>/, "its subtitle is the email");
  reset();
  state.athleteAccountManage = { open: true, athleteId: "a1", userId: "", scope: "login", loading: false, data: null, error: "", message: "", pending: false };
  assert.ok(head(renderAthleteAccountModal(data), "organization-athlete-account-close"), "Athlete login");
  reset();
  state.organizationInvite = { ...state.organizationInvite, open: true, athleteId: "a1" };
  assert.ok(head(renderOrganizationBrowser({ ...data, athletes: [{ ...athlete, user_id: null }] }), "organization-invite-close"), "Invite");
  for (const [type, row] of [["club", data.clubs[0]], ["team", data.teams[0]], ["athlete", athlete]]) {
    reset();
    state.organizationEditor = { open: true, type, row };
    const html = renderOrganizationEditModal(data);
    assert.ok(head(html, "organization-edit-close"), `Edit ${type}`);
    assert.ok(!html.includes('<span class="button-icon">x</span>'), `Edit ${type}: no 'x' glyph`);
  }
});

test("Edit club and team save from the footer: Cancel closes, Save changes is the filled primary", () => {
  for (const [type, row] of [["club", data.clubs[0]], ["team", data.teams[0]]]) {
    reset();
    state.organizationEditor = { open: true, type, row };
    assert.match(renderOrganizationEditModal(data), /<div class="organization-form-footer organization-dialog-footer">\s*<button class="plain-button" type="button" data-action="organization-edit-close">Cancel<\/button>\s*<button class="plain-button data-sources-primary" type="submit">Save changes<\/button>/, type);
  }
});

test("Edit athlete is two parts with their own headings and saves: the profile, then the library access", () => {
  reset();
  state.organizationEditor = { open: true, type: "athlete", row: athlete };
  const html = renderOrganizationEditModal(data);
  const profile = html.slice(html.indexOf('data-organization-form="edit-athlete"'), html.indexOf("</form>"));
  const library = html.slice(html.indexOf('data-organization-form="athleteLibraryAccess"'));
  assert.match(profile, /<h4>Profile<\/h4>/);
  assert.match(profile, />Save changes<\/button>/);
  assert.ok(!profile.includes("Save library access"), "the profile's save is its own");
  assert.match(library, /<h4>Library access<\/h4><p class="muted">[^<]*does not change the profile/);
  assert.match(library, /<button class="plain-button data-sources-primary" type="submit">Save library access<\/button>/);
  assert.ok(html.indexOf("<h4>Profile</h4>") < html.indexOf("<h4>Library access</h4>"));
});

test("Manage account: rows read name and state, then the action; the login switch is the last card", () => {
  reset();
  state.organizationUserManage = { open: true, userId: "u2", pending: false, error: "" };
  const html = renderManageAccountModal(data);
  const sections = [...html.matchAll(/<section class="manage-account-section[^"]*"[^>]*>\s*<p class="eyebrow">([^<]+)<\/p>/g)].map((m) => m[1]);
  assert.equal(sections.at(-1), "Account status", sections.join(", "));
  assert.match(html, /manage-account-section manage-account-danger">\s*<p class="eyebrow">Account status<\/p>[\s\S]*?<span class="manage-account-state"><strong>Login<\/strong><span class="user-status-badge is-active">Active login<\/span><\/span>[\s\S]*?>Disable login<\/button>/);
  assert.match(html, /<span class="manage-account-state"><span>Demo Club<\/span>[\s\S]*?Active<\/span><\/span>\s*<button[^>]*data-action="organization-club-role-remove"/);
  assert.match(html, /<span class="manage-account-state"><strong>Platform administrator<\/strong><span class="user-status-badge is-inactive">Not assigned<\/span><\/span>/);
});
