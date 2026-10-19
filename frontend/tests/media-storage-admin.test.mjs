import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// Settings -> Storage (R2 media, PR 5): the tab for a platform administrator
// in the platform workspace, the defaults and the accounts read from BE-1's
// admin routes, the inline forms that change a limit or the defaults with a
// reason and the revision, the Manage account section, and what a refusal or
// a lost answer does. Fake answers only; the backend is never reached.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.FormData = dom.window.FormData;

const data = await import("../media-storage-admin-data.js");
const view = await import("../media-storage-admin-view.js");
const actions = await import("../media-storage-admin-actions.js");
const { renderSettingsNavHtml } = await import("../navigation.js");
const { renderOrganizationPanelHtml, renderManageAccountModal } = await import("../organization-view.js");
const { handleOrganizationAction, closeManageAccountModal } = await import("../organization-actions.js");
const { state } = await import("../state.js");

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const organizationData = () => ({
  users: [{ id: "u1", name: "Ana Coach", email: "ana@test.local", loginActive: true, globalRoles: [], clubRoles: [], teamRoles: [] }, { id: "u2", name: "Boris Coach", email: "boris@test.local", loginActive: true, globalRoles: [], clubRoles: [], teamRoles: [] }],
  clubs: [{ id: "c1", name: "FK Example" }], teams: [], athletes: [], isPlatformAdmin: true, manageableClubIds: [], manageableTeamIds: [],
});
function reset({ platformAdmin = true, workspace = "platform", section = "storage" } = {}) {
  state.organization = { data: organizationData(), error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false,
    showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showDisabledUsers: false, requestStatus: "all", requestAthleteId: "all", requestError: "", requestMessage: "" };
  state.organization.data.isPlatformAdmin = platformAdmin;
  state.currentUser = { id: "admin-1", activeWorkspace: { type: workspace } };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.organizationUserSelection = { active: false, ids: new Map(), note: "" };
  state.organizationInvite = { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" };
  state.athleteAccountManage = { open: false };
  state.storageAdmin = data.emptyStorageAdmin();
  state.activeTab = "organization";
}
const render = () => { content.innerHTML = state.organization.section === "storage" ? view.renderStorageAdminPanelHtml(state.organization.data) : (state.organizationUserManage.open ? renderManageAccountModal(state.organization.data) : ""); };

const policy = (overrides = {}) => ({ policy: { defaultLimitBytes: "0", maxVideoBytes: "209715200", maxImageBytes: "10485760", maxParallelUploads: 2, allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], ...overrides }, revision: 3 });
const account = (overrides = {}) => ({
  storageAccountId: "acc-u1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000", availableBytes: "3800000000",
  limitSource: "override", overLimit: false, activeUploads: 0, maxParallelUploads: 2, maxVideoBytes: "209715200", maxImageBytes: "10485760",
  allowedMimeTypes: ["video/mp4"], overrideLimitBytes: "5000000000", revision: 2, ...overrides,
});
const clubAccount = () => account({ storageAccountId: "acc-c1", owner: { type: "club", id: "c1" }, usedBytes: "0", limitBytes: "0", availableBytes: "0", limitSource: "default", overrideLimitBytes: null, revision: 1 });

// The admin API fake: a router of (method, path prefix) -> reply; every call recorded.
function fakeApi(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const route = routes.find((entry) => entry.method === call.method && call.url.startsWith(entry.path));
    if (!route) return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "Resource not found.", code: "resource_not_found", retryable: false, details: {} }) };
    const reply = await route.reply(call);
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    if (reply?.networkError) throw new TypeError("Failed to fetch");
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}
const ROUTE = data.STORAGE_ADMIN_ROUTE;
const ok = ({ accounts = [account(), clubAccount()], nextCursor = null, policyReply = policy() } = {}) => [
  { method: "GET", path: `${ROUTE}/storage-policy`, reply: () => policyReply },
  { method: "GET", path: `${ROUTE}/storage-accounts`, reply: (call) => (call.url.includes("cursor=") ? { accounts: [account({ storageAccountId: "acc-u2", owner: { type: "user", id: "u2" } })], nextCursor: null } : { accounts, nextCursor }) },
];
const formOf = (selector) => content.querySelector(selector);
function fill(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = form.querySelector(`[name="${name}"]`);
    field.value = value;
  }
}

test("1. the Storage tab exists for a platform administrator in the platform workspace only; elsewhere the section falls back to Overview", () => {
  reset();
  assert.match(renderSettingsNavHtml(state.organization.data), /data-section="storage">Storage</);
  reset({ workspace: "private_coach" });
  assert.doesNotMatch(renderSettingsNavHtml(state.organization.data), /data-section="storage"/);
  assert.match(renderOrganizationPanelHtml({ currentUser: state.currentUser, data: state.organization.data, error: "", role: "Admin", scope: "Platform" }), /Users/);
  assert.equal(state.organization.section, "overview", "a workspace without the tab never shows the section");
  reset({ platformAdmin: false });
  assert.doesNotMatch(renderSettingsNavHtml(state.organization.data), /Storage/);
  assert.equal(data.storageAdminContext(state.organization.data), false);
});

test("2. the flag off (503 media_storage_disabled) says so and changes nothing; a 403 is the workspace sentence; a failed read offers Read again", async () => {
  reset();
  fakeApi([{ method: "GET", path: ROUTE, reply: () => ({ status: 503, json: { error: "Media storage is disabled.", code: "media_storage_disabled" } }) }]);
  await data.loadStorageAdmin(render);
  assert.match(content.textContent, /switched off in this environment \(MEDIA_STORAGE_ENABLED\)/);
  assert.equal(content.querySelectorAll("form, button").length, 0, "nothing to press");
  reset();
  fakeApi([{ method: "GET", path: ROUTE, reply: () => ({ status: 403, json: { code: "operation_not_allowed" } }) }]);
  await data.loadStorageAdmin(render);
  assert.match(content.textContent, /platform administrator access in the platform workspace/);
  reset();
  fakeApi([{ method: "GET", path: ROUTE, reply: () => ({ status: 500, json: {} }) }]);
  await data.loadStorageAdmin(render);
  assert.ok(content.querySelector('[data-action="storage-admin-reload"]'));
  assert.match(content.textContent, /not available right now/);
});

test("3. the defaults and the accounts: two groups, the owner's name from the organization data, badges, the usage sentence, Load more", async () => {
  reset();
  const calls = fakeApi(ok({ nextCursor: "next-1" }));
  assert.equal(data.storageAdminNeedsLoad(), true);
  await data.loadStorageAdmin(render);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /storage-accounts\?limit=50&sort=used_desc$/);
  assert.match(content.textContent, /Default limit per account\s*0 B \(nothing can be uploaded until an account gets an individual limit\)/);
  assert.match(content.textContent, /Largest video file\s*209\.7 MB/);
  assert.match(content.textContent, /Uploads at once per account\s*2/);
  const rows = [...content.querySelectorAll("[data-storage-account]")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Ana Coach/);
  assert.match(rows[0].textContent, /Individual limit/);
  assert.match(rows[0].querySelector(".storage-admin-usage").textContent, /^1\.2 GB used of 5 GB · 3\.8 GB free$/);
  assert.match(rows[1].textContent, /FK Example/);
  assert.match(rows[1].textContent, /Default limit/);
  assert.match(rows[1].textContent, /No new uploads/);
  assert.equal(content.querySelectorAll('[data-action="storage-admin-limit-edit"][data-mode="remove"]').length, 1, "Remove only where an individual limit exists");
  const visible = content.cloneNode(true);
  visible.querySelectorAll("details").forEach((node) => node.remove());
  assert.doesNotMatch(visible.textContent, /acc-u1|acc-c1/, "ids only under Technical details, never in the open");
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-load-more" } }, { render });
  assert.equal(content.querySelectorAll("[data-storage-account]").length, 3);
  assert.match(content.textContent, /Boris Coach/);
  assert.equal(content.querySelector('[data-action="storage-admin-load-more"]'), null, "no next page");
  assert.equal(data.ownerLabel({ type: "user", id: "ghost" }, state.organization.data), "User account (not in this list)");
  assert.equal(data.usageSentence(account({ reservedBytes: "100000000", activeUploads: 1 })), "1.2 GB used of 5 GB · 3.8 GB free · 100 MB reserved by uploads in progress · 1 upload running");
});

test("4. the numbers: gigabytes and megabytes to exact decimal byte strings and back", () => {
  assert.equal(data.gigabytesToBytes("2.5"), "2500000000");
  assert.equal(data.gigabytesToBytes("5"), "5000000000");
  assert.equal(data.gigabytesToBytes("0"), "0");
  assert.equal(data.gigabytesToBytes("1,5"), "1500000000", "a decimal comma");
  assert.equal(data.gigabytesToBytes("0.000000001"), "1");
  assert.equal(data.gigabytesToBytes("0.0000000001"), null, "finer than a byte");
  assert.equal(data.gigabytesToBytes("abc"), null);
  assert.equal(data.gigabytesToBytes("-1"), null);
  assert.equal(data.gigabytesToBytes(""), null);
  assert.equal(data.megabytesToBytes("200"), "200000000");
  assert.equal(data.bytesToGigabytes("2500000000"), "2.5");
  assert.equal(data.bytesToGigabytes("5000000000"), "5");
  assert.equal(data.bytesToMegabytes("209715200"), "209.72");
  assert.equal(data.validReason("  why  "), "why");
  assert.equal(data.validReason(""), "");
  assert.equal(data.validReason("x".repeat(1001)), "");
});

test("5. changing the defaults: only what changed travels, with the reason and the revision; validation; a revision conflict reads again", async () => {
  reset();
  let calls = fakeApi([...ok(), { method: "PATCH", path: `${ROUTE}/storage-policy`, reply: (call) => ({ policy: { ...policy().policy, ...call.body.changes }, revision: 4 }) }]);
  await data.loadStorageAdmin(render);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-policy-edit" } }, { render });
  let form = formOf('[data-storage-admin-form="policy"]');
  assert.ok(form);
  assert.equal(form.querySelector('[name="defaultLimitGb"]').value, "0");
  assert.equal(form.querySelector('[name="maxVideoMb"]').value, "209.72");
  assert.equal(form.querySelector('[name="expectedRevision"]').value, "3");
  // Invalid numbers and a missing reason are refused locally, nothing sent.
  fill(form, { defaultLimitGb: "abc", reason: "" });
  await actions.submitStorageAdminForm(form, { render });
  assert.match(content.querySelector(".builder-error").textContent, /default limit must be a number/);
  assert.match(content.querySelector(".builder-error").textContent, /reason is required/);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
  form = formOf('[data-storage-admin-form="policy"]');
  fill(form, { defaultLimitGb: "0", maxVideoMb: "209.72", maxImageMb: "10.49", maxParallelUploads: "2", reason: "no change" });
  await actions.submitStorageAdminForm(form, { render });
  assert.match(content.querySelector(".builder-error").textContent, /Nothing changed/);
  form = formOf('[data-storage-admin-form="policy"]');
  fill(form, { defaultLimitGb: "5", maxParallelUploads: "3", reason: "Pilot: 5 GB for every coach" });
  await actions.submitStorageAdminForm(form, { render });
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { changes: { defaultLimitBytes: "5000000000", maxParallelUploads: 3 }, expectedRevision: 3, reason: "Pilot: 5 GB for every coach" });
  assert.equal(state.storageAdmin.revision, 4);
  assert.match(content.textContent, /Defaults saved/);
  assert.match(content.textContent, /Default limit per account\s*5 GB/);
  assert.equal(formOf('[data-storage-admin-form="policy"]'), null);
  // A revision conflict: nothing written; the tab is read again and says so.
  reset();
  calls = fakeApi([...ok(), { method: "PATCH", path: `${ROUTE}/storage-policy`, reply: () => ({ status: 409, json: { code: "revision_conflict" } }) }]);
  await data.loadStorageAdmin(render);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-policy-edit" } }, { render });
  form = formOf('[data-storage-admin-form="policy"]');
  fill(form, { defaultLimitGb: "1", reason: "try" });
  await actions.submitStorageAdminForm(form, { render });
  assert.match(content.textContent, /Another administrator changed this meanwhile/);
  assert.equal(calls.filter((call) => call.method === "GET" && call.url.includes("storage-policy")).length, 2, "read again");
  assert.equal(formOf('[data-storage-admin-form="policy"]'), null);
});

test("6. an account's limit: set in gigabytes, 0 for no new uploads, the override removed with a reason; the row shows the server's answer; a lost answer is 'not confirmed' and read again", async () => {
  reset();
  let calls = fakeApi([...ok(), { method: "PATCH", path: `${ROUTE}/storage-accounts/acc-u1/limit`, reply: (call) => account({ limitBytes: call.body.limitBytes ?? "0", overrideLimitBytes: call.body.limitBytes, limitSource: call.body.limitBytes === null ? "default" : "override", availableBytes: call.body.limitBytes === null ? "0" : String(Number(call.body.limitBytes) - 1200000000), revision: 3 }) }]);
  await data.loadStorageAdmin(render);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "panel", accountId: "acc-u1", mode: "set" } }, { render });
  let form = formOf('[data-storage-admin-form="limit"][data-account-id="acc-u1"]');
  assert.ok(form);
  assert.equal(form.querySelector('[name="limitGb"]').value, "5", "prefilled with the current limit");
  fill(form, { limitGb: "2.5", reason: "Trial limit" });
  await actions.submitStorageAdminForm(form, { render });
  let patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { limitBytes: "2500000000", expectedRevision: 2, reason: "Trial limit" });
  assert.match(content.querySelector('[data-storage-account="acc-u1"] .storage-admin-usage').textContent, /of 2\.5 GB/);
  assert.match(content.textContent, /Limit saved: 2\.5 GB/);
  assert.equal(state.storageAdmin.accounts[0].revision, 3, "the server's row replaces the old one");
  // 0: no new uploads.
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "panel", accountId: "acc-u1", mode: "set" } }, { render });
  form = formOf('[data-storage-admin-form="limit"][data-account-id="acc-u1"]');
  fill(form, { limitGb: "0", reason: "Stop uploads" });
  await actions.submitStorageAdminForm(form, { render });
  patch = calls.filter((call) => call.method === "PATCH").at(-1);
  assert.equal(patch.body.limitBytes, "0");
  assert.match(content.textContent, /can start no new uploads/);
  // Remove the override: null, the reason still required.
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "panel", accountId: "acc-u1", mode: "remove" } }, { render });
  form = formOf('[data-storage-admin-form="limit"][data-mode="remove"]');
  assert.ok(form);
  assert.equal(form.querySelector('[name="limitGb"]'), null);
  fill(form, { reason: "" });
  await actions.submitStorageAdminForm(form, { render });
  assert.match(content.querySelector(".builder-error").textContent, /reason is required/);
  form = formOf('[data-storage-admin-form="limit"][data-mode="remove"]');
  fill(form, { reason: "Back to the default" });
  await actions.submitStorageAdminForm(form, { render });
  patch = calls.filter((call) => call.method === "PATCH").at(-1);
  assert.equal(patch.body.limitBytes, null);
  assert.match(content.textContent, /Individual limit removed/);
  // Cancel closes the form without a request.
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "panel", accountId: "acc-c1", mode: "set" } }, { render });
  assert.ok(formOf('[data-storage-admin-form="limit"][data-account-id="acc-c1"]'));
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-cancel", scope: "panel" } }, { render });
  assert.equal(formOf('[data-storage-admin-form="limit"]'), null);
  // A lost answer: never "nothing changed" - the tab is read again with the sentence.
  reset();
  calls = fakeApi([...ok(), { method: "PATCH", path: `${ROUTE}/storage-accounts/acc-u1/limit`, reply: () => ({ networkError: true }) }]);
  await data.loadStorageAdmin(render);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "panel", accountId: "acc-u1", mode: "set" } }, { render });
  form = formOf('[data-storage-admin-form="limit"]');
  fill(form, { limitGb: "3", reason: "lost" });
  await actions.submitStorageAdminForm(form, { render });
  assert.match(content.textContent, /not confirmed\. The values were read again/);
  assert.equal(calls.filter((call) => call.method === "GET" && call.url.includes("storage-accounts?")).length, 2);
  assert.equal(formOf('[data-storage-admin-form="limit"]'), null);
});

test("7. the history of an account: read on demand, who / when / old -> new / why; hidden again on the second press", async () => {
  reset();
  const calls = fakeApi([...ok(), { method: "GET", path: `${ROUTE}/storage-limit-audit`, reply: () => ({ entries: [{ id: "a1", storageAccountId: "acc-u1", performedByUserId: "u2", oldValues: { limitBytes: null, revision: 1 }, newValues: { limitBytes: "5000000000", revision: 2 }, reason: "Pilot", createdAt: "2026-10-19T10:00:00Z" }], nextCursor: null }) }]);
  await data.loadStorageAdmin(render);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-history", accountId: "acc-u1" } }, { render });
  assert.match(calls.at(-1).url, /storage-limit-audit\?limit=20&storageAccountId=acc-u1$/);
  const history = content.querySelector('[data-storage-account="acc-u1"] .storage-admin-history');
  assert.ok(history);
  assert.match(history.textContent, /Boris Coach: limit default → 5 GB — Pilot/);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-history", accountId: "acc-u1" } }, { render });
  assert.equal(content.querySelector(".storage-admin-history"), null);
});

test("8. Manage account: the user's own account is created with zero use the first time it is read, shows the same form, and the modal's close forgets it", async () => {
  reset({ section: "users" });
  const calls = fakeApi([
    { method: "POST", path: `${ROUTE}/storage-accounts`, reply: (call) => account({ storageAccountId: "acc-u2", owner: call.body.owner, usedBytes: "0", limitBytes: "0", availableBytes: "0", limitSource: "default", overrideLimitBytes: null, revision: 1 }) },
    { method: "PATCH", path: `${ROUTE}/storage-accounts/acc-u2/limit`, reply: (call) => account({ storageAccountId: "acc-u2", owner: { type: "user", id: "u2" }, usedBytes: "0", limitBytes: call.body.limitBytes, availableBytes: call.body.limitBytes, revision: 2 }) },
  ]);
  const renderPanel = async () => render();
  await handleOrganizationAction({ dataset: { action: "organization-manage-account-open", userId: "u2" } }, { renderOrganizationPanel: renderPanel });
  await settle();
  // The modal also reads the account's blocks (a GET); the storage row is the one POST.
  assert.deepEqual(calls.find((call) => call.method === "POST").body, { owner: { type: "user", id: "u2" } });
  const section = content.querySelector("[data-manage-account-storage]");
  assert.ok(section);
  assert.match(section.textContent, /0 B used of 0 B/);
  assert.match(section.textContent, /Default limit/);
  assert.match(section.textContent, /club exercise counts against the club's own account/);
  await actions.handleStorageAdminAction({ dataset: { action: "storage-admin-limit-edit", scope: "manage", accountId: "acc-u2", mode: "set" } }, { render });
  const form = content.querySelector('[data-storage-admin-form="limit"][data-scope="manage"]');
  assert.ok(form);
  fill(form, { limitGb: "5", reason: "First coach of the pilot" });
  await actions.submitStorageAdminForm(form, { render });
  assert.deepEqual(calls.at(-1).body, { limitBytes: "5000000000", expectedRevision: 1, reason: "First coach of the pilot" });
  assert.match(content.querySelector("[data-manage-account-storage]").textContent, /0 B used of 5 GB/);
  assert.match(content.textContent, /Limit saved: 5 GB/);
  closeManageAccountModal(renderPanel);
  assert.equal(state.organizationUserManage.storage, undefined);
  // Outside the platform workspace the section does not exist and nothing is read.
  reset({ section: "users", workspace: "private_coach" });
  const none = fakeApi([]);
  await handleOrganizationAction({ dataset: { action: "organization-manage-account-open", userId: "u2" } }, { renderOrganizationPanel: renderPanel });
  await settle();
  assert.equal(none.length, 0);
  assert.equal(content.querySelector("[data-manage-account-storage]"), null);
});

test("9. styling: 44 px targets for every control, 16 px inputs on phones, one column under 760 px", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.storage-admin-actions \.plain-button, \.storage-admin-actions \.text-action \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.storage-admin-facts > div \{ grid-template-columns: 1fr; \}\s*\.storage-admin-grid \{ grid-template-columns: 1fr; \}\s*\.storage-admin-form \.builder-text-input \{ font-size: 16px; \}/);
});
