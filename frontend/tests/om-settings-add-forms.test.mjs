import { test } from "node:test";
import assert from "node:assert/strict";

// S3 (the Settings plan, the manager's GO of 2026-11-10): a section's add action is a labelled button on its heading's
// row, not a round icon; the form opens under the heading in one column with Cancel and the filled primary in its
// footer; Users is one panel with a tab per kind of form (New account, Give access, Athlete login). Browser proof:
// e2e/tests/settings-add-forms.test.mjs.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderOrganizationPanelHtml } = await import("../organization-view.js");
const { handleOrganizationAction } = await import("../organization-actions.js");
const { state } = await import("../state.js");

function reset(section, extra = {}) {
  state.organization = { data: null, error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false, showArchivedTeams: false, userFormTab: "", ...extra };
  state.organizationInvite = { open: false };
  state.organizationUserManage = { open: false };
  state.athleteAccountManage = { open: false };
  state.organizationEditor = { open: false };
  state.organizationJoinLinks = { pending: false, error: "" };
  state.currentUser = { id: "viewer-1", name: "Demo Admin", activeWorkspace: { type: "club", scopeId: "c1", label: "Demo Club" } };
}
const data = { isPlatformAdmin: true, canCreateClub: true, canCreateTeam: true, canCreateAthlete: true, canCreateUser: true, clubs: [{ id: "c1", name: "Demo Club" }], teams: [{ id: "t1", club_id: "c1", name: "Demo Team" }], athletes: [{ id: "a1", name: "Ana Demo", is_active: true, has_active_access: true, memberships: [] }], users: [{ id: "u1", name: "Coach Demo", email: "coach@example.invalid", loginActive: true }], joinLinks: [], joinApplications: [] };
const panel = () => renderOrganizationPanelHtml({ currentUser: state.currentUser, data, error: "", role: "ADMIN", scope: "Demo Club" });
const toggle = (label) => new RegExp(`<button class="plain-button organization-add-toggle data-sources-primary" type="button" data-action="organization-toggle-add-form" aria-expanded="false">[\\s\\S]*?<span>${label}</span></button>`);

test("each section's add action is a labelled primary button in its heading, not an icon alone", () => {
  for (const [section, label] of [["clubs", "Add club"], ["teams", "Add team"], ["athletes", "Add athlete"], ["users", "Add user"], ["joinLinks", "Create join link"]]) {
    reset(section);
    const html = panel();
    assert.match(html, toggle(label), section);
    const head = html.slice(html.indexOf('class="organization-browser-head"'), html.indexOf('class="organization-lists'));
    assert.match(head, /class="organization-browser-actions">[\s\S]*organization-add-toggle/, `${section}: the button is on the heading's row`);
    assert.ok(!html.includes('aria-label="Add or manage users"'), "no icon whose meaning only an aria-label carries");
  }
  reset("users");
  assert.match(renderOrganizationPanelHtml({ currentUser: state.currentUser, data: { ...data, canCreateUser: false }, error: "", role: "ADMIN", scope: "" }), toggle("Give access"));
});

test("the open form is under the heading, with Cancel and the filled primary in its footer", () => {
  for (const [section, form, submit] of [["clubs", "club", "Add club"], ["teams", "team", "Add team"], ["athletes", "athlete", "Add athlete"], ["joinLinks", "joinLink", "Create join link"]]) {
    reset(section, { addFormOpen: true });
    const html = panel();
    const at = html.indexOf(`data-organization-form="${form}"`);
    assert.ok(at > html.indexOf('class="organization-browser-head"'), `${section}: the form comes after the heading`);
    const formHtml = html.slice(at, html.indexOf("</form>", at));
    assert.match(formHtml, /<div class="organization-form-footer">\s*<button class="plain-button" type="button" data-action="organization-toggle-add-form">Cancel<\/button>\s*<button class="plain-button data-sources-primary" type="submit"[^>]*>/, section);
    assert.ok(formHtml.includes(`>${submit}</button>`), section);
    assert.match(html, /organization-add-toggle is-open" type="button" data-action="organization-toggle-add-form" aria-expanded="true"/);
  }
});

test("Users: one panel with New account, Give access and Athlete login; a tab shows only its forms", async () => {
  reset("users", { addFormOpen: true });
  let html = panel();
  const tabs = [...html.matchAll(/data-action="organization-user-form-tab" data-user-form-tab="([^"]+)">([^<]+)</g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(tabs, ["account:New account", "access:Give access", "athleteLogin:Athlete login"]);
  assert.ok(html.includes('data-organization-form="user"') && !html.includes('data-organization-form="clubRole"'));
  const render = async () => {};
  for (const [tab, forms, not] of [["access", ["clubRole", "teamRole"], ["user", "athleteLogin"]], ["athleteLogin", ["athleteLogin"], ["user", "clubRole", "teamRole"]], ["account", ["user"], ["clubRole", "athleteLogin"]]]) {
    assert.equal(await handleOrganizationAction({ dataset: { action: "organization-user-form-tab", userFormTab: tab } }, { renderOrganizationPanel: render }), true);
    html = panel();
    for (const f of forms) assert.ok(html.includes(`data-organization-form="${f}"`), `${tab} shows ${f}`);
    for (const f of not) assert.ok(!html.includes(`data-organization-form="${f}"`), `${tab} hides ${f}`);
    assert.match(html, new RegExp(`aria-selected="true" data-action="organization-user-form-tab" data-user-form-tab="${tab}"`));
  }
  // Give access holds two forms and one Cancel.
  state.organization.userFormTab = "access";
  html = panel();
  assert.equal(html.match(/>Cancel<\/button>/g).length, 1);
  // Without a new-account right, the panel starts on Give access.
  reset("users", { addFormOpen: true });
  html = renderOrganizationPanelHtml({ currentUser: state.currentUser, data: { ...data, canCreateUser: false }, error: "", role: "ADMIN", scope: "" });
  assert.ok(!html.includes('data-user-form-tab="account"') && html.includes('data-organization-form="clubRole"'));
});

test("Cancel closes the form", async () => {
  reset("clubs", { addFormOpen: true });
  await handleOrganizationAction({ dataset: { action: "organization-toggle-add-form" } }, { renderOrganizationPanel: async () => {} });
  assert.equal(state.organization.addFormOpen, false);
  assert.ok(!panel().includes('data-organization-form="club"'));
});
