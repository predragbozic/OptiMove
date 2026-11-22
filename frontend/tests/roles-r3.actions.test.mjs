// Settings > Roles and the role assignment in Settings > Users (roles plan R3, parts B and C), through the real
// handlers with a fake fetch: who is offered the tab, what a read-only caller sees, the reasons shown for words that
// can't be ticked, the exact bodies of create / change / archive / copy / assign / revoke, refusals as sentences, and
// that Check result repeats the same request key after a lost answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./support/fetch-mock.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { handleRolesAction, handleRolesInput, rolesRefusalText, submitRolesForm } = await import("../roles-actions.js");
const { loadRoles, loadWho, resetRolesForWorkspaceChange, rolesContext } = await import("../roles-data.js");
const { permissionReason, renderRolesAssignHtml, renderRolesPanelHtml, renderRolesWhoHtml, roleSections } = await import("../roles-view.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
const { state } = await import("../state.js");

const CLUB = "11111111-0000-4000-8000-000000000001";
const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "dddddddd-0000-4000-8000-000000000001";
const ROLE = "rrrrrrrr-0000-4000-8000-000000000001".replace(/r/g, "e");
const BASIC_CLUB_ADMIN = "bbbbbbbb-0000-4000-8000-0000000000a1";
const ASSIGNMENT = "cccccccc-0000-4000-8000-000000000001";

const CATALOG = {
  modules: [{ word: "athletes", label: "Athletes" }, { word: "organization", label: "Organization" }],
  permissions: [
    { word: "athletes.view", module: "athletes", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, honoured: true },
    { word: "athletes.manage", module: "athletes", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, honoured: true },
    { word: "roles.manage", module: "organization", scopeTypes: ["club"], platformOnly: false, systemRoleOnly: true, honoured: true },
    { word: "platform.metrics.manage", module: "organization", scopeTypes: ["global"], platformOnly: true, systemRoleOnly: false, honoured: true },
    { word: "calendar.view", module: "organization", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, honoured: false },
    { word: "exercises.use", module: "organization", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, honoured: true },
  ],
  groups: [
    { key: "athletes", label: "Athletes", permissions: ["athletes.view", "athletes.manage"], levels: [
      { key: "off", label: "Off", permissions: [] }, { key: "view", label: "View", permissions: ["athletes.view"] },
      { key: "edit", label: "Add and edit", permissions: ["athletes.view", "athletes.manage"] }] },
  ],
  held: ["athletes.view", "athletes.manage", "roles.manage", "calendar.view"],
  delegable: ["athletes.view", "athletes.manage", "calendar.view"],
};
const role = (over = {}) => ({
  id: ROLE, owner: { scope: "club", clubId: CLUB }, name: "Assistant", description: "Helps", scopeTypes: ["club"], isBasic: false, basicKey: null,
  revision: 3, archived: false, items: ["athletes.view"], holderCount: 2, actions: { change: true, archive: true, copy: false, assign: true }, ...over,
});
const BASIC = role({ id: BASIC_CLUB_ADMIN, name: "Club admin", isBasic: true, basicKey: "club_admin", owner: { scope: "system", clubId: null }, holderCount: 1, actions: { change: false, archive: false, copy: true, assign: false } });

let calls;
function server({ roles = [role(), BASIC], write = null, assignments = [] } = {}) {
  calls = installFetchMock((call) => {
    const path = call.url.replace(/^\/?/, "/").split("?")[0];
    const write404 = write?.(call);
    if (write404) return write404;
    if (path === "/api/organization/roles/catalog") return { status: 200, body: CATALOG };
    if (path === "/api/organization/roles/assignments" && call.method === "GET") return { status: 200, body: { assignments, nextCursor: null } };
    if (path === "/api/organization/roles" && call.method === "GET") return { status: 200, body: { roles } };
    if (path === `/api/organization/roles/${ROLE}` && call.method === "GET") return { status: 200, body: { ...roles.find((r) => r.id === ROLE), moduleDisplay: {}, copiedFrom: null, history: [{ revision: 1, kind: "create", at: "2026-11-01T10:00:00Z", reason: null }] } };
    return { status: 200, body: {} };
  });
}
const writes = () => calls.filter((c) => c.method === "POST");

function asClubAdmin() {
  state.currentUser = { id: "u1", activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "club_admin" }] };
  state.organization.data = { isPlatformAdmin: false, clubs: [{ id: CLUB, name: "FK Borac" }], manageableClubIds: [CLUB], teams: [{ id: TEAM, name: "First team", club_id: CLUB, club_name: "FK Borac" }], manageableTeamIds: [TEAM], users: [{ id: USER, name: "Ana", email: "ana@example.test" }] };
  resetRolesForWorkspaceChange();
}

// An element that answers closest() for the one data attribute it carries.
function el(attr, dataset, props = {}) {
  return { dataset, ...props, closest: (sel) => (sel === `[${attr}]` ? { dataset, ...props } : null) };
}
const action = (type, extra = {}) => ({ dataset: { action: type, ...extra } });

test("1. the Roles tab is offered to a platform admin and to the club's admin in the club's workspace only", () => {
  state.currentUser = { activeWorkspace: { type: "platform" }, clubs: [] };
  assert.ok(rolesContext({ isPlatformAdmin: true }));
  assert.match(renderSettingsNavHtml({ isPlatformAdmin: true }), />Roles</);
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "club_admin" }] };
  assert.match(renderSettingsNavHtml({ isPlatformAdmin: false }), />Roles</);
  state.currentUser = { activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "member" }] };
  assert.equal(rolesContext({ isPlatformAdmin: false }), null);
  assert.doesNotMatch(renderSettingsNavHtml({ isPlatformAdmin: false }), />Roles</);
  state.currentUser = { activeWorkspace: { type: "team", scopeId: TEAM }, clubs: [{ id: CLUB, role: "club_admin" }] };
  assert.equal(rolesContext({ isPlatformAdmin: false }), null);
});

test("2. the list reads the catalog and every role for the club and shows people counts and the server's buttons", async () => {
  asClubAdmin();
  server();
  await loadRoles();
  assert.ok(calls.some((c) => c.url.includes("/catalog") && c.url.includes(`clubId=${CLUB}`)));
  assert.ok(calls.some((c) => c.url.includes("state=all") && c.url.includes(`clubId=${CLUB}`)));
  const html = renderRolesPanelHtml();
  assert.match(html, /Assistant/);
  assert.match(html, /2 people/);
  assert.match(html, /1 person/);
  assert.match(html, /data-action="roles-archive"/);
  assert.match(html, /data-action="roles-new"/);
  assert.match(html, /data-action="roles-copy"/); // the basic role offers a copy
  assert.doesNotMatch(html, /dddddddd|11111111-0000/); // no id on screen
});

test("3. a caller with no actions reads the list and a role read-only", async () => {
  asClubAdmin();
  server({ roles: [role({ actions: { change: false, archive: false, copy: false, assign: false } })] });
  await loadRoles();
  const list = renderRolesPanelHtml();
  assert.doesNotMatch(list, /roles-new|roles-archive|roles-copy/);
  assert.match(list, />View</);
  await handleRolesAction(action("roles-open", { roleId: ROLE }), {});
  const html = renderRolesPanelHtml();
  assert.match(html, /You can read this role but not change it/);
  assert.doesNotMatch(html, /type="submit"/);
  assert.match(html, /disabled/);
});

test("4. a word the editor can't tick is disabled with the reason as text", async () => {
  asClubAdmin();
  server();
  await loadRoles();
  const form = { mode: "create", role: null, draft: { scopeTypes: ["club"], items: [] } };
  assert.match(permissionReason("platform.metrics.manage", form, state.roles.catalog), /platform administrators/);
  assert.match(permissionReason("roles.manage", form, state.roles.catalog), /Club admin role/);
  assert.match(permissionReason("calendar.view", form, state.roles.catalog), /no effect today/);
  assert.match(permissionReason("exercises.use", form, state.roles.catalog), /don't have this permission yourself/);
  assert.equal(permissionReason("athletes.view", form, state.roles.catalog), "");
  assert.match(permissionReason("athletes.view", { ...form, draft: { scopeTypes: ["global"], items: [] } }, state.roles.catalog), /does not apply/);
  assert.deepEqual(roleSections(["athletes.view"], state.roles.catalog), ["Athletes (view)"]);
  assert.deepEqual(roleSections(["athletes.view", "athletes.manage"], state.roles.catalog), ["Athletes (add and edit)"]);
  await handleRolesAction(action("roles-new"), {});
  const html = renderRolesPanelHtml();
  assert.match(html, /What this role sees/);
  assert.match(html, /Nothing yet/);
});

test("5. create sends the exact body once; a refused name stays on the form as a sentence", async () => {
  asClubAdmin();
  let refuse = true;
  server({ write: (c) => (c.method === "POST" && refuse ? { status: 409, body: { error: "role_name_taken", message: "x" } } : null) });
  await loadRoles();
  await handleRolesAction(action("roles-new"), {});
  handleRolesInput(el("data-roles-field", { rolesField: "name" }, { value: "Fitness coach" }), {});
  handleRolesInput(el("data-roles-word", { rolesWord: "athletes.view" }, { checked: true }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  const sent = writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/organization/roles/");
  assert.deepEqual({ ...sent[0].body, requestKey: "k" }, { requestKey: "k", clubId: CLUB, name: "Fitness coach", scopeTypes: ["club"], items: ["athletes.view"] });
  assert.match(sent[0].body.requestKey, /^[0-9a-f-]{36}$/);
  assert.match(renderRolesPanelHtml(), /A role with this name already exists/);
  assert.ok(state.roles.form, "the form stays open");
  refuse = false;
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.notEqual(writes()[1].body.requestKey, sent[0].body.requestKey, "a refused key is never reused");
  assert.equal(state.roles.form, null);
});

test("6. a lost answer is Result not confirmed and Check result sends the same request key", async () => {
  asClubAdmin();
  let n = 0;
  server({ write: (c) => (c.method === "POST" ? (++n === 1 ? { throwNetworkError: true } : null) : null) });
  await loadRoles();
  await handleRolesAction(action("roles-new"), {});
  handleRolesInput(el("data-roles-field", { rolesField: "name" }, { value: "Fitness coach" }), {});
  handleRolesInput(el("data-roles-word", { rolesWord: "athletes.view" }, { checked: true }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.match(renderRolesPanelHtml(), /Result not confirmed/);
  assert.match(renderRolesPanelHtml(), /roles-check-result/);
  await handleRolesAction(action("roles-check-result"), {});
  const sent = writes();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, sent[0].body);
  assert.doesNotMatch(renderRolesPanelHtml(), /Result not confirmed/);
});

test("7. change sends only what changed with expectedRevision and the reason, and says how many people it affects", async () => {
  asClubAdmin();
  server({ write: (c) => (c.method === "POST" ? { status: 200, body: { role: role({ revision: 4 }), affected: { people: 2, clubs: 1 } } } : null) });
  await loadRoles();
  await handleRolesAction(action("roles-open", { roleId: ROLE }), {});
  assert.match(renderRolesPanelHtml(), /History \(1\)/);
  assert.match(renderRolesPanelHtml(), /applies to all of them/);
  handleRolesInput(el("data-roles-word", { rolesWord: "athletes.manage" }, { checked: true }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.equal(writes().length, 0, "no reason, nothing is sent");
  assert.match(renderRolesPanelHtml(), /Write the reason/);
  handleRolesInput(el("data-roles-field", { rolesField: "reason" }, { value: "More rights" }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  const body = writes()[0].body;
  assert.equal(writes()[0].url, `/api/organization/roles/${ROLE}/change`);
  assert.deepEqual({ ...body, requestKey: "k" }, { requestKey: "k", expectedRevision: 3, reason: "More rights", clubId: CLUB, items: ["athletes.view", "athletes.manage"] });
  assert.match(renderRolesPanelHtml(), /changes what 2 people can do/);
});

test("8. archive sends the reason; a role still held is refused with the count", async () => {
  asClubAdmin();
  server({ write: (c) => (c.method === "POST" ? { status: 409, body: { error: "role_has_assignments", count: 2 } } : null) });
  await loadRoles();
  await handleRolesAction(action("roles-archive", { roleId: ROLE }), {});
  handleRolesInput(el("data-roles-field", { rolesField: "reason" }, { value: "Not needed" }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.equal(writes()[0].url, `/api/organization/roles/${ROLE}/archive`);
  assert.equal(writes()[0].body.expectedRevision, 3);
  assert.match(renderRolesPanelHtml(), /2 people still hold this role/);
});

test("9. a role id the server does not show is the same sentence for everyone: not available", async () => {
  asClubAdmin();
  server({ write: (c) => (c.method === "POST" ? { status: 404, body: { error: "notFound" } } : null) });
  await loadRoles();
  await handleRolesAction(action("roles-copy", { roleId: BASIC_CLUB_ADMIN }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.equal(writes()[0].body.clubId, CLUB);
  assert.match(renderRolesPanelHtml(), /Roles are not available in this workspace/);
  assert.equal(rolesRefusalText({ status: 409, code: "permission_not_held", words: ["athletes.manage"] }), "You do not hold Add and edit athletes yourself, so you can't hand it on.");
});

function assignSetup() {
  asClubAdmin();
  server({ roles: [role({ scopeTypes: ["club", "team"] }), { ...BASIC, scopeTypes: ["club"], actions: { change: false, archive: false, copy: false, assign: false } }] });
}
async function chooseScope(value) {
  const a = state.roles.assign;
  a.draft.userId = USER;
  handleRolesInput({ closest: (s) => (s === "[data-roles-assign-field]" ? { dataset: { rolesAssignField: "scope" }, value, closest: () => ({ elements: { userId: { value: USER } } }) } : null) }, { renderUsers() {} });
  while (!state.roles.assign.byClub[CLUB]?.roles) await new Promise((resolve) => setTimeout(resolve, 0));
}
const assignField = (name, value) => handleRolesInput({ closest: (s) => (s === "[data-roles-assign-field]" ? { dataset: { rolesAssignField: name }, value, closest: () => ({ elements: { userId: { value: USER } } }) } : null) }, { renderUsers() {} });

test("10. one assignment form: a new role goes to P9 with title, end date and reason", async () => {
  assignSetup();
  await chooseScope(`club:${CLUB}`);
  assignField("roleId", ROLE);
  assignField("displayTitle", "Head of fitness");
  assignField("expiresAt", "2999-01-31");
  const html = renderRolesAssignHtml(state.organization.data);
  assert.match(html, /Give a role/);
  assert.match(html, /Assistant/);
  assert.match(html, /Club admin \(basic role\)/);
  await submitRolesForm({ dataset: { rolesForm: "assign" }, elements: { userId: { value: USER } } }, { renderUsers() {} });
  assert.equal(writes().length, 0, "the reason is required");
  assignField("reason", "Needed for the season");
  await submitRolesForm({ dataset: { rolesForm: "assign" }, elements: { userId: { value: USER } } }, { renderUsers() {} });
  const sent = writes()[0];
  assert.equal(sent.url, "/api/organization/roles/assignments");
  assert.deepEqual({ ...sent.body, requestKey: "k", expiresAt: "x" }, { requestKey: "k", userId: USER, roleId: ROLE, scopeType: "club", scopeId: CLUB, reason: "Needed for the season", displayTitle: "Head of fitness", expiresAt: "x" });
  assert.match(sent.body.expiresAt, /^2999-01-31T/);
});

test("11. a basic role in the same form goes to the existing club-roles route, without title, date or reason", async () => {
  assignSetup();
  server({ roles: [role({ scopeTypes: ["club", "team"] }), { ...BASIC, scopeTypes: ["club"], actions: { change: false, archive: false, copy: false, assign: false } }], write: (c) => (c.method === "POST" ? { status: 200, body: {} } : null) });
  await chooseScope(`club:${CLUB}`);
  assignField("roleId", BASIC_CLUB_ADMIN);
  assert.doesNotMatch(renderRolesAssignHtml(state.organization.data), /Ends on/);
  await submitRolesForm({ dataset: { rolesForm: "assign" }, elements: { userId: { value: USER } } }, { renderUsers() {}, refreshOrganization: async () => {} });
  const sent = writes()[0];
  assert.equal(sent.url, "/api/organization/club-roles");
  assert.deepEqual(sent.body, { userId: USER, clubId: CLUB });
});

test("12. who holds what: a role filter, revoke with a reason for a new row, Manage account only for a basic row", async () => {
  assignSetup();
  const rows = [
    { id: ASSIGNMENT, source: "assignment", userId: USER, userName: "Ana", roleId: ROLE, roleName: "Assistant", scopeType: "club", scopeId: CLUB, title: "Head of fitness", expiresAt: null, state: "active" },
    { id: "bbbbbbbb-0000-4000-8000-0000000000b2", source: "basic", userId: "u2", userName: "Boris", roleId: BASIC_CLUB_ADMIN, roleName: "Club admin", scopeType: "club", scopeId: CLUB, title: null, expiresAt: null, state: "active" },
  ];
  server({ roles: [role(), BASIC], assignments: rows, write: (c) => (c.method === "POST" ? { status: 200, body: { assignment: {} } } : null) });
  state.roles.who.clubId = CLUB;
  await loadWho({});
  assert.ok(calls.some((c) => c.url.includes("/assignments") && c.url.includes(`clubId=${CLUB}`)));
  let html = renderRolesWhoHtml(state.organization.data);
  assert.equal((html.match(/roles-revoke-open/g) || []).length, 1);
  assert.equal((html.match(/organization-manage-account-open/g) || []).length, 1);
  await handleRolesAction(action("roles-revoke-open", { assignmentId: ASSIGNMENT }), { renderUsers() {} });
  await submitRolesForm({ dataset: { rolesForm: "revoke" } }, { renderUsers() {} });
  assert.equal(writes().length, 0, "the reason is required");
  handleRolesInput({ closest: (s) => (s === "[data-roles-revoke-reason]" ? { value: "Left the staff" } : null) }, {});
  await submitRolesForm({ dataset: { rolesForm: "revoke" } }, { renderUsers() {} });
  const sent = writes()[0];
  assert.equal(sent.url, `/api/organization/roles/assignments/${ASSIGNMENT}/revoke`);
  assert.deepEqual({ ...sent.body, requestKey: "k" }, { requestKey: "k", reason: "Left the staff", expected: { userId: USER, roleId: ROLE } });
  html = renderRolesWhoHtml(state.organization.data);
  assert.match(html, /Role revoked/);
});

test("13. the Roles API answering 404 to Users leaves the old forms in place", async () => {
  assignSetup();
  server({ write: (c) => (c.url.includes("/assignments") ? { status: 404, body: { error: "notFound" } } : null) });
  await loadWho({});
  const { rolesUsersAvailable } = await import("../roles-data.js");
  assert.equal(rolesUsersAvailable(state.organization.data), false);
  assert.equal(renderRolesWhoHtml(state.organization.data), "");
});

test("14. an older who-holds-what answer never overwrites a newer one and loading always ends", async () => {
  assignSetup();
  const gates = [];
  calls = installFetchMock((call) => {
    if (!call.url.includes("/assignments")) return { status: 200, body: { roles: [], assignments: [] } };
    return new Promise((resolve) => gates.push(() => resolve({ status: 200, body: { assignments: [{ id: `a${gates.length}`, source: "assignment", userId: USER, userName: call.url.includes("roleId") ? "Filtered" : "Everyone", roleId: ROLE, roleName: "Assistant", scopeType: "club", scopeId: CLUB, state: "active" }], nextCursor: null } })));
  });
  const who = state.roles.who;
  who.clubId = CLUB;
  const first = loadWho({});
  who.roleId = ROLE;
  const second = loadWho({});
  gates[1]();
  await second;
  gates[0]();
  await first;
  assert.equal(who.loading, false, "loading is cleared by the newest read");
  assert.equal(who.queryKey, `${CLUB}|${ROLE}`);
  assert.equal(who.rows[0].userName, "Filtered", "the older answer did not replace the newer rows");
});

test("15. Cancel on a revoke whose answer is lost keeps the unconfirmed write; Check result sends the same key", async () => {
  assignSetup();
  let n = 0;
  const rows = [{ id: ASSIGNMENT, source: "assignment", userId: USER, userName: "Ana", roleId: ROLE, roleName: "Assistant", scopeType: "club", scopeId: CLUB, state: "active" }];
  server({ roles: [role(), BASIC], assignments: rows, write: (c) => (c.method === "POST" ? (++n === 1 ? { throwNetworkError: true } : { status: 200, body: { assignment: {} } }) : null) });
  state.roles.who.clubId = CLUB;
  await loadWho({});
  await handleRolesAction(action("roles-revoke-open", { assignmentId: ASSIGNMENT }), { renderUsers() {} });
  handleRolesInput({ closest: (s) => (s === "[data-roles-revoke-reason]" ? { value: "Left" } : null) }, {});
  await submitRolesForm({ dataset: { rolesForm: "revoke" } }, { renderUsers() {} });
  assert.match(renderRolesWhoHtml(state.organization.data), /Result not confirmed/);
  await handleRolesAction(action("roles-revoke-cancel"), { renderUsers() {} });
  assert.ok(state.roles.who.command, "cancel did not drop the unconfirmed write");
  assert.match(renderRolesWhoHtml(state.organization.data), /roles-revoke-check/);
  await handleRolesAction(action("roles-revoke-check"), { renderUsers() {} });
  assert.equal(writes().length, 2);
  assert.deepEqual(writes()[1].body, writes()[0].body);
});

test("16. a lost answer to a basic role is Result not confirmed (no raw transport text) and nothing is sent twice by itself", async () => {
  assignSetup();
  server({ roles: [role({ scopeTypes: ["club", "team"] }), { ...BASIC, scopeTypes: ["club"], actions: { change: false, archive: false, copy: false, assign: false } }], write: (c) => (c.method === "POST" ? { throwNetworkError: true } : null) });
  await chooseScope(`club:${CLUB}`);
  assignField("roleId", BASIC_CLUB_ADMIN);
  await submitRolesForm({ dataset: { rolesForm: "assign" }, elements: { userId: { value: USER } } }, { renderUsers() {}, refreshOrganization: async () => {} });
  assert.equal(writes().length, 1);
  assert.match(state.roles.assign.error, /Result not confirmed/);
  assert.doesNotMatch(state.roles.assign.error, /Failed to fetch/);
});

test("17. a settled role write makes the Users screen's cached roles old; who and what are named after Give role", async () => {
  assignSetup();
  server({ write: (c) => (c.method === "POST" ? { status: 200, body: { role: role(), assignment: {} } } : null) });
  await loadRoles();
  await chooseScope(`club:${CLUB}`);
  assert.ok(state.roles.assign.byClub[CLUB].roles);
  await handleRolesAction(action("roles-archive", { roleId: ROLE }), {});
  handleRolesInput(el("data-roles-field", { rolesField: "reason" }, { value: "Not needed" }), {});
  await submitRolesForm({ dataset: { rolesForm: "role" } }, {});
  assert.deepEqual(state.roles.assign.byClub, {}, "the cache was dropped");
});

test("18. a role that people hold can't be archived from the screen; the dead end is not offered", async () => {
  asClubAdmin();
  server();
  await loadRoles();
  await handleRolesAction(action("roles-archive", { roleId: ROLE }), {});
  const html = renderRolesPanelHtml();
  assert.match(html, /2 people have this role/);
  assert.doesNotMatch(html, /type="submit"/);
});

test("19. app.js guards sign-out, workspace switch and the update watch with rolesMayBeLeft like the calendar's settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const withCalendar = src.match(/calendarSettingsMayBeLeft\(/g).length;
  const withRoles = src.match(/rolesMayBeLeft\(/g).length;
  assert.ok(withRoles >= 3, `rolesMayBeLeft appears ${withRoles} times, calendar's ${withCalendar}`);
});
