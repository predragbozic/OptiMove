import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S5 (the Settings plan, the owner's GO of 2026-11-10): an athlete's login state is a plain badge, not a button that
// switches the login on a tap. The switch is in a dialog behind the row's button: "Account" for a platform admin (the
// full account dialog, which stays the platform admin's only), "Manage login" for everyone else who could switch it from the
// row before (the switch alone). Browser proof: e2e/tests/settings-athlete-login.test.mjs.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderOrganizationBrowser } = await import("../organization-view.js");
const { state } = await import("../state.js");

function reset(section = "athletes") {
  state.organization = { data: null, error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showDisabledUsers: false, requestStatus: "all", requestAthleteId: "all", requestError: "", requestMessage: "" };
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.athleteAccountManage = { open: false, athleteId: "", userId: "", loading: false, data: null, error: "", message: "", pending: false };
  state.currentUser = { id: "viewer-1" };
}
const athlete = (overrides) => ({ id: "athlete-1", name: "Ana Athlete", athlete_id: "A1", user_id: "user-1", login_active: true, is_active: true, has_active_access: true, ...overrides });
const data = (athletes, isPlatformAdmin) => ({ isPlatformAdmin, clubs: [], teams: [], athletes });

test("a row shows the login state as a badge and holds no switch, for every viewer", () => {
  for (const isPlatformAdmin of [true, false]) for (const login_active of [true, false]) {
    reset();
    const html = renderOrganizationBrowser(data([athlete({ login_active })], isPlatformAdmin));
    assert.ok(!html.includes('data-action="organization-toggle-athlete-login"'), "no switch on a row");
    assert.ok(!html.includes("athlete-login-toggle"), "no pill that switches");
    assert.match(html, new RegExp(`<span class="athlete-login-status ${login_active ? "is-active" : "is-disabled"}">${login_active ? "Login active" : "Login disabled"}</span>`));
  }
});

test("the platform admin opens the Account dialog; everyone else who could switch the login opens Login", () => {
  reset();
  let html = renderOrganizationBrowser(data([athlete()], true));
  assert.match(html, /data-action="organization-athlete-account-open" data-athlete-id="athlete-1" data-user-id="user-1">Account<\/button>/);
  assert.ok(!html.includes('data-action="organization-athlete-login-open"'));
  reset();
  html = renderOrganizationBrowser(data([athlete()], false));
  assert.match(html, /data-action="organization-athlete-login-open" data-athlete-id="athlete-1">Manage login<\/button>/);
  assert.ok(!html.includes('data-action="organization-athlete-account-open"'), "Account stays the platform admin's");
  // A multi-role login can't be switched from an athlete, and an athlete with no login has nothing to switch.
  for (const row of [athlete({ login_is_multi_role: true }), athlete({ user_id: null, login_active: null })]) {
    reset();
    html = renderOrganizationBrowser(data([row], false));
    assert.ok(!html.includes('data-action="organization-athlete-login-open"'));
  }
});

test("the Login dialog holds the switch alone; disabling and enabling are named buttons", () => {
  for (const login_active of [true, false]) {
    reset();
    state.athleteAccountManage = { open: true, athleteId: "athlete-1", userId: "", scope: "login", loading: false, data: null, error: "", message: "Login enabled.", pending: false };
    const html = renderOrganizationBrowser(data([athlete({ login_active })], false));
    assert.match(html, /aria-label="Athlete login"/);
    assert.match(html, new RegExp(`data-action="organization-toggle-athlete-login" data-athlete-id="athlete-1" data-current-active="${login_active}" data-athlete-name="Ana Athlete"[^>]*>${login_active ? "Disable login" : "Enable login"}</button>`));
    assert.ok(html.includes("Login enabled."), "the dialog says what happened");
    assert.ok(!html.includes("Login email"), "no account detail for a club admin or a coach");
  }
});

test("the platform admin's Account dialog reads the switch's state from the fetched account", () => {
  reset();
  state.athleteAccountManage = { open: true, athleteId: "athlete-1", userId: "user-1", scope: "full", loading: false, data: { email: "ana@test.local", loginActive: false, pendingEmailChange: null }, error: "", message: "", pending: false };
  const html = renderOrganizationBrowser(data([athlete({ login_active: true })], true));
  assert.match(html, /data-current-active="false"[^>]*>Enable login<\/button>/);
  assert.ok(html.includes("Login email"));
});

test("the S5 block: badge colours from tokens, 44 px row controls, a join link's text block is plain", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = css.lastIndexOf("/* =====", css.indexOf("Design: Settings rows (S5)"));
  const end = css.indexOf("\n/* =====", start + 10);
  const block = css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(start > 0);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), "no literal colour");
  assert.match(block, /\.athlete-login-status\.is-active \{\s*background: var\(--om-success-soft\);\s*color: var\(--om-success\);/);
  assert.match(block, /\.organization-row-actions \.plain-button,\s*[^{]*\.organization-row-actions \.text-action \{\s*min-height: var\(--om-tap-target\);/);
  assert.match(block, /\.organization-join-link-row > \.organization-row-main \{\s*display: block;/);
  assert.match(block, /\.organization-row-main \{\s*min-height: var\(--om-tap-target\);/);
});

// The row is drawn by three renderers: the flat list (above), a selected club's list and a selected team's table. Each
// keeps the badge and the dialog button for each viewer (code review of S5).
test("a selected club's list and a selected team's table keep the badge and the dialog button", () => {
  const member = athlete({ memberships: [{ status: "active", clubId: "club-1", teamId: "team-1" }] });
  const withOrg = (isPlatformAdmin) => ({ isPlatformAdmin, clubs: [{ id: "club-1", name: "Demo Club" }], teams: [{ id: "team-1", club_id: "club-1", name: "Demo Team" }], athletes: [member] });
  for (const pick of [{ selectedClubId: "club-1" }, { selectedClubId: "club-1", selectedTeamId: "team-1" }]) for (const isPlatformAdmin of [true, false]) {
    // S2: a selected club's roster is in Clubs, a selected team's in Teams.
    reset(pick.selectedTeamId ? "teams" : "clubs");
    Object.assign(state.organization, pick);
    const html = renderOrganizationBrowser(withOrg(isPlatformAdmin));
    const where = `${pick.selectedTeamId ? "team" : "club"}, ${isPlatformAdmin ? "platform admin" : "other"}`;
    assert.ok(html.includes(pick.selectedTeamId ? "organization-table-row" : "Demo Club"), where);
    assert.match(html, /<span class="athlete-login-status is-active">Login active<\/span>/, where);
    assert.ok(!html.includes('data-action="organization-toggle-athlete-login"'), `${where}: no switch on the row`);
    assert.ok(html.includes(isPlatformAdmin ? 'data-action="organization-athlete-account-open"' : 'data-action="organization-athlete-login-open"'), `${where}: the dialog button`);
  }
});
