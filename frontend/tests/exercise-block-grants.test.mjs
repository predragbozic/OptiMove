import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// The organization modules are rendered against a stubbed document (as the
// other organization tests do); the Grant blocks dialog against jsdom.
const stubDocument = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.document = stubDocument;
const { renderOrganizationBrowser, renderManageAccountModal, userCanReceiveBlocks } = await import("../organization-view.js");
const { handleOrganizationAction, closeManageAccountModal, syncGrantBlockButton } = await import("../organization-actions.js");
const { openExerciseBlockGrants, renderBlockGrantsHtml } = await import("../exercise-block-grants.js");
const { state } = await import("../state.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const user = (id, overrides = {}) => ({ id, name: `User ${id}`, email: `${id}@test.local`, loginActive: true, globalRoles: [], clubRoles: [], teamRoles: [], isAthlete: false, ...overrides });
const users = () => [
  user("coach", { clubRoles: [{ clubId: "c1", clubName: "Club", role: "club_admin", isActive: true }] }),
  user("team", { teamRoles: [{ teamId: "t1", teamName: "U15", role: "team_coach", isActive: true }] }),
  user("athlete", { isAthlete: true }),
  user("former", { clubRoles: [{ clubId: "c1", clubName: "Club", role: "club_admin", isActive: false }] }),
  user("off", { loginActive: false, globalRoles: [{ role: "independent_coach", isActive: true }] }),
];
const blocks = [
  { id: "block-a", name: "Speed", accessAll: false, exerciseCount: 3 },
  { id: "block-b", name: "Open drills", accessAll: true, exerciseCount: 12 },
];

function resetOrganization({ platformAdmin = true, workspace = "platform", section = "users" } = {}) {
  state.organization = { data: { users: users(), clubs: [], teams: [], athletes: [], isPlatformAdmin: platformAdmin, manageableClubIds: [], manageableTeamIds: [] },
    error: "", selectedClubId: "", selectedTeamId: "", section, addFormOpen: false, assignOpen: false, accessOpen: false,
    showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showDisabledUsers: false,
    requestStatus: "all", requestAthleteId: "all", requestError: "", requestMessage: "" };
  state.organizationInvite = { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" };
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  state.organizationUserSelection = { active: false, ids: new Map(), note: "" };
  state.athleteAccountManage = { open: false };
  state.currentUser = { id: "viewer-1", activeWorkspace: { type: workspace } };
  state.activeTab = "organization";
}

function fetchFake(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const reply = typeof answer === "function" ? answer(calls.at(-1), calls.length) : answer;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status < 300, status, statusText: "", json: async () => reply.body ?? reply };
  };
  return calls;
}
const callbacks = () => ({ loadAthletes: async () => {}, renderOrganizationPanel: async () => {}, refreshOrganizationData: async () => {}, renderAfterOrganizationAccessChange: async () => {} });
const fakeAction = (dataset, extra = {}) => ({ dataset, disabled: false, closest: () => null, ...extra });

test("only the block administrator in the platform workspace gets Select; a mark only on accounts with coach access", () => {
  globalThis.document = stubDocument;
  resetOrganization();
  assert.deepEqual(users().map(userCanReceiveBlocks), [true, true, false, false, false]);
  let html = renderOrganizationBrowser(state.organization.data);
  assert.match(html, /data-action="organization-user-select-mode"[^>]*>Select</);
  assert.equal(html.includes("organization-user-select-toggle"), false);
  state.organizationUserSelection = { active: true, ids: new Map([["team", "User team"], ["gone", "Gone"]]) };
  html = renderOrganizationBrowser(state.organization.data);
  assert.deepEqual([...html.matchAll(/data-action="organization-user-select-toggle" data-user-id="([^"]+)"/g)].map((m) => m[1]), ["coach", "team"]);
  assert.match(html, /data-user-row="team"[^>]*>|is-selected/);
  assert.match(html, /2 selected · 1 not shown here/);
  assert.match(html, /data-action="organization-user-grant-blocks-open"(?! disabled)/);
  // Not the platform workspace, or not an administrator: nothing of it.
  resetOrganization({ workspace: "club" });
  state.organizationUserSelection = { active: true, ids: new Map() };
  assert.equal(renderOrganizationBrowser(state.organization.data).includes("organization-user-select"), false);
  resetOrganization({ platformAdmin: false });
  assert.equal(renderOrganizationBrowser(state.organization.data).includes("organization-user-select"), false);
});

test("Manage account shows Library access with the account's own grants, Grant block for an eligible account, and every read state", () => {
  globalThis.document = stubDocument;
  resetOrganization();
  const manage = (userId, blocksState) => { state.organizationUserManage = { open: true, userId, pending: false, error: "", blocks: blocksState }; return renderManageAccountModal(state.organization.data); };
  assert.match(manage("coach", { loading: true }), /Reading application blocks/);
  assert.match(manage("coach", { unavailable: true }), /can't be managed from this workspace/);
  assert.match(manage("coach", { error: "The blocks could not be read." }), /data-action="organization-block-grants-reload"/);
  const data = { users: [{ id: "coach", name: "User coach", eligible: true, active: true, grants: [{ id: "block-a", name: "Speed", accessAll: false }] }], blocks };
  let html = manage("coach", { data, note: "Block granted. The account can use its exercises now." });
  assert.match(html, /Application blocks/);
  assert.match(html, /Speed<\/span>\s*<button[^>]*data-action="organization-block-grant-remove"[^>]*data-collection-id="block-a"/);
  assert.match(html, /<option value="" selected disabled>Choose a block<\/option><option value="block-b">Open drills — open to all, no grant needed<\/option>/);
  assert.match(html, /data-action="organization-block-grant-add"[^>]*disabled>Grant block/);
  assert.doesNotMatch(html, /<option value="block-a"/);
  assert.match(html, /data-action="organization-block-grant-add" data-user-id="coach"/);
  assert.match(html, /Block granted\./);
  html = manage("athlete", { data: { users: [{ id: "athlete", name: "User athlete", eligible: false, active: true, grants: [] }], blocks } });
  assert.match(html, /No blocks granted to this account/);
  assert.match(html, /no coach access, so blocks can't be granted/);
  assert.equal(html.includes("organization-block-grant-add"), false);
  // Elsewhere than the platform workspace the section is not drawn at all.
  resetOrganization({ workspace: "team" });
  assert.equal(manage("coach", { data }).includes("Library access"), false);
});

test("opening Manage account reads the account's blocks; Grant block and Remove confirm, send one change and read again with a note", async () => {
  globalThis.document = stubDocument;
  resetOrganization();
  const renders = [];
  const panel = { ...callbacks(), renderOrganizationPanel: async () => { renders.push(JSON.stringify(state.organizationUserManage.blocks || null)); } };
  const data = { users: [{ id: "coach", name: "User coach", eligible: true, active: true, grants: [] }], blocks };
  let putAnswer = { changed: true, added: [{ collectionId: "block-a", userId: "coach" }], removed: [], unchanged: 0 };
  const calls = fetchFake((call) => (call.method === "PUT" ? putAnswer : data));
  const prompts = [];
  globalThis.window = { confirm: (text) => { prompts.push(text); return true; } };
  await handleOrganizationAction(fakeAction({ action: "organization-manage-account-open", userId: "coach" }), panel);
  await settle();
  assert.equal(calls[0].url, "/api/exercise-collections/user-grants?userIds=coach");
  assert.equal(state.organizationUserManage.blocks.loading, false);
  assert.deepEqual(state.organizationUserManage.blocks.data, data);
  const select = { value: "block-a", selectedOptions: [{ textContent: "Speed — selected users" }] };
  await handleOrganizationAction(fakeAction({ action: "organization-block-grant-add", userId: "coach", userName: "User coach" }, { closest: () => ({ querySelector: () => select }) }), panel);
  assert.equal(prompts.length, 0, "granting, like the modal's other Add actions, asks nothing");
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body, { userIds: ["coach"], add: ["block-a"] });
  assert.equal(calls.filter((call) => call.method === "GET").length, 2, "read again after the change");
  assert.equal(state.organizationUserManage.blocks.note, "“Speed” granted. The account can use its exercises now.");
  // Grant block waits for a chosen block.
  const button = { disabled: true };
  syncGrantBlockButton({ value: "", closest: () => ({ querySelector: () => button }) });
  assert.equal(button.disabled, true);
  syncGrantBlockButton({ value: "block-b", closest: () => ({ querySelector: () => button }) });
  assert.equal(button.disabled, false);
  assert.equal(state.organizationUserManage.blocks.pending, false);
  // A refusal says that nothing changed; a lost answer says the list shows what is saved.
  putAnswer = { status: 409, body: { error: "blockNotAvailable" } };
  await handleOrganizationAction(fakeAction({ action: "organization-block-grant-remove", userId: "coach", userName: "User coach", collectionId: "block-a", blockName: "Speed" }), panel);
  assert.match(prompts.at(-1), /Remove the block “Speed” from User coach\?/);
  assert.deepEqual(calls.at(-2).body, { userIds: ["coach"], remove: ["block-a"] });
  assert.equal(state.organizationUserManage.blocks.note, "Nothing changed: that block no longer exists.");
  putAnswer = new TypeError("Failed to fetch");
  await handleOrganizationAction(fakeAction({ action: "organization-block-grant-remove", userId: "coach", collectionId: "block-a" }), panel);
  assert.equal(state.organizationUserManage.blocks.note, "The change was not confirmed. The list shows what is saved.");
  // A lost answer and then a failed read: the warning is kept.
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { if ((options.method || "GET") === "PUT") throw new TypeError("Failed to fetch"); return { ok: false, status: 500, statusText: "", json: async () => ({ error: "internalError" }) }; };
  await handleOrganizationAction(fakeAction({ action: "organization-block-grant-remove", userId: "coach", collectionId: "block-a" }), panel);
  assert.match(state.organizationUserManage.blocks.note, /was not confirmed\. The list shows what is saved\. The blocks could not be read; read again/);
  assert.equal(state.organizationUserManage.blocks.error, "The blocks could not be read.");
  globalThis.fetch = fetchBefore;
  // A declined confirmation sends nothing.
  const before = calls.length;
  globalThis.window.confirm = () => false;
  await handleOrganizationAction(fakeAction({ action: "organization-block-grant-remove", userId: "coach", collectionId: "block-a" }), panel);
  assert.equal(calls.length, before);
  // Closing drops the blocks; a late answer for the closed modal is ignored.
  closeManageAccountModal(panel.renderOrganizationPanel);
  assert.equal(state.organizationUserManage.blocks, undefined);
  // Not the platform workspace: no read at all.
  resetOrganization({ workspace: "club" });
  const quiet = fetchFake(data);
  await handleOrganizationAction(fakeAction({ action: "organization-manage-account-open", userId: "coach" }), panel);
  await settle();
  assert.equal(quiet.length, 0);
  assert.equal(state.organizationUserManage.blocks, null);
});

test("Select, a mark, Select all shown, Clear and Done keep the selection in state; Grant blocks… opens the dialog with the selected ids", async () => {
  globalThis.document = stubDocument;
  resetOrganization();
  const panel = callbacks();
  const act = (action, extra) => handleOrganizationAction(fakeAction(action, extra), panel);
  await act({ action: "organization-user-select-mode" });
  assert.equal(state.organizationUserSelection.active, true);
  await act({ action: "organization-user-select-toggle", userId: "coach", userName: "User coach" }, { checked: true });
  assert.deepEqual([...state.organizationUserSelection.ids.entries()], [["coach", "User coach"]]);
  await act({ action: "organization-user-select-all-shown" });
  assert.deepEqual([...state.organizationUserSelection.ids.keys()], ["coach", "team"], "only accounts with coach access, only those shown");
  await act({ action: "organization-user-select-toggle", userId: "team" }, { checked: false });
  assert.deepEqual([...state.organizationUserSelection.ids.keys()], ["coach"]);
  await act({ action: "organization-user-select-clear" });
  assert.equal(state.organizationUserSelection.ids.size, 0);
  // At most a hundred: Select all shown stops there and says so; the next mark is refused.
  state.organization.data.users = Array.from({ length: 101 }, (_, index) => user(`c${index}`, { clubRoles: [{ clubId: "c1", clubName: "Club", role: "club_admin", isActive: true }] }));
  await act({ action: "organization-user-select-all-shown" });
  assert.equal(state.organizationUserSelection.ids.size, 100);
  assert.match(state.organizationUserSelection.note, /At most 100 accounts/);
  assert.match(renderOrganizationBrowser(state.organization.data), /At most 100 accounts can be granted blocks at once/);
  await act({ action: "organization-user-select-toggle", userId: "c100", userName: "User c100" }, { checked: true });
  assert.equal(state.organizationUserSelection.ids.has("c100"), false);
  await act({ action: "organization-user-select-clear" });
  assert.equal(state.organizationUserSelection.note, "");
  await act({ action: "organization-user-select-mode" });
  assert.deepEqual(state.organizationUserSelection, { active: false, ids: new Map(), note: "" });
});

// The Grant blocks dialog against jsdom and a fake of its two routes.
async function openDialog({ lookup, put = async () => ({ changed: true, added: [], removed: [], unchanged: 0 }), ids = ["coach", "team", "athlete", "gone"] }) {
  const dom = new JSDOM("<main><button data-action='organization-user-grant-blocks-open'>Grant blocks…</button></main>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const calls = [];
  let reads = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === "PUT") {
      const reply = await put(calls.at(-1));
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return { ok: status < 300, status, statusText: "", json: async () => reply.body ?? reply };
    }
    reads += 1;
    return { ok: true, json: async () => (typeof lookup === "function" ? lookup(reads) : lookup) };
  };
  let saved = 0;
  const overlay = openExerciseBlockGrants(ids, { onSaved: async () => { saved += 1; } });
  await settle();
  await settle();
  const text = () => document.querySelector(".exercise-block-grants-modal").textContent;
  const tick = async (blockId, checked = true) => {
    const box = document.querySelector(`[data-grants-block="${blockId}"]`);
    box.checked = checked;
    box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
  };
  const mode = async (value) => {
    const radio = document.querySelector(`[data-grants-mode][value="${value}"]`);
    radio.checked = true;
    radio.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
  };
  const press = async (selector) => { document.querySelector(selector).click(); await settle(); await settle(); };
  return { dom, overlay, calls, text, tick, mode, press, saved: () => saved, reads: () => reads };
}
const lookup = {
  users: [
    { id: "coach", name: "User coach", eligible: true, active: true, grants: [{ id: "block-a", name: "Speed", accessAll: false }] },
    { id: "team", name: "User team", eligible: true, active: true, grants: [] },
    { id: "athlete", name: "User athlete", eligible: false, active: true, grants: [] },
  ],
  blocks,
};

test("the dialog names who receives blocks, counts who has each block, and sends the chosen change to the eligible accounts", async () => {
  const { dom, overlay, calls, text, tick, mode, press, saved } = await openDialog({ lookup, put: async () => ({ changed: true, added: [{ collectionId: "block-a", userId: "team" }, { collectionId: "block-b", userId: "coach" }, { collectionId: "block-b", userId: "team" }], removed: [], unchanged: 1 }) });
  assert.equal(calls[0].url, "/api/exercise-collections/user-grants?userIds=coach,team,athlete,gone");
  assert.match(text(), /2 selected accounts can receive blocks: User coach, User team/);
  assert.match(text(), /Left out \(no coach access or login disabled\): User athlete/);
  assert.match(text(), /1 selected account no longer exists and is left out/);
  assert.match(text(), /Speed — selected users · 3 exercises · 1 of 2 has it/);
  assert.match(text(), /Open drills — open to all · 12 exercises · every coach can use it already/);
  assert.match(text(), /^Grant blocks/);
  assert.equal(document.querySelector("[data-grants-submit]").disabled, true, "nothing is sent before a block is chosen");
  await tick("block-a");
  await tick("block-b");
  assert.equal(document.querySelector("[data-grants-submit]").textContent.trim(), "Grant 2 blocks to 2 accounts");
  assert.match(text(), /Granted accounts can use the exercises of these blocks from now on/);
  await mode("remove");
  assert.match(text(), /^Remove blocks/);
  assert.match(text(), /3 selected accounts: User coach, User team, User athlete/, "taking away applies to every existing account");
  assert.match(text(), /User athlete has no coach access; a block can still be removed/);
  assert.equal(document.querySelector("[data-grants-submit]").textContent.trim(), "Remove 2 blocks from 3 accounts");
  await mode("add");
  await press("[data-grants-submit]");
  const sent = calls.find((call) => call.method === "PUT");
  assert.deepEqual(sent.body, { userIds: ["coach", "team"], add: ["block-a", "block-b"] });
  assert.match(text(), /Granted 2 blocks to 2 accounts \(3 new grants, 1 was already granted\)\. They can use the exercises now\./);
  assert.equal(saved(), 1);
  assert.equal(document.querySelector("[data-grants-submit]"), null);
  assert.equal(document.querySelector("main").inert, true);
  await press("[data-grants-close]");
  assert.equal(overlay.isConnected, false);
  assert.notEqual(document.querySelector("main").inert, true);
  assert.equal(document.activeElement, document.querySelector("[data-action='organization-user-grant-blocks-open']"));
  dom.window.close();
});

test("a coded refusal says that nothing was changed; a lost answer is not confirmed until Check again, which recognises a change that landed", async () => {
  let answer = { status: 409, body: { error: "blockNotAvailable" } };
  const landed = { ...lookup, users: lookup.users.map((item) => item.eligible ? { ...item, grants: [{ id: "block-a", name: "Speed", accessAll: false }] } : item) };
  const { dom, text, tick, press, saved, reads } = await openDialog({ lookup: (count) => (count >= 3 ? landed : lookup), put: async () => answer });
  await tick("block-a");
  await press("[data-grants-submit]");
  assert.match(text(), /Nothing was changed: a chosen block no longer exists/);
  assert.equal(document.querySelector("[data-grants-submit]").disabled, false);
  answer = new TypeError("Failed to fetch");
  await press("[data-grants-submit]");
  assert.match(text(), /The change was not confirmed/);
  assert.equal(document.querySelector("[data-grants-submit]").disabled, true);
  assert.equal(saved(), 0);
  await press("[data-grants-check]");
  assert.equal(reads(), 2);
  assert.match(text(), /Checked just now/);
  assert.equal(document.querySelector("[data-grants-submit]").disabled, false);
  answer = { status: 503, body: { error: "outcomeUnknown" } };
  await press("[data-grants-submit]");
  await press("[data-grants-check]");
  assert.match(text(), /The change was saved: every account now has the chosen block/);
  assert.equal(saved(), 1);
  dom.window.close();
});

test("permission gone: the alert and Close only; a change in flight cannot be closed away", async () => {
  const denied = await openDialog({ lookup, put: async () => ({ status: 404, body: { error: "notFound" } }) });
  await denied.tick("block-b");
  await denied.press("[data-grants-submit]");
  assert.match(denied.text(), /Nothing was changed: you no longer have permission to manage application blocks/);
  assert.equal(document.querySelector("[data-grants-submit]"), null);
  denied.dom.window.close();
  let finish;
  const slow = await openDialog({ lookup, put: () => new Promise((resolve) => { finish = resolve; }) });
  await slow.tick("block-b");
  document.querySelector("[data-grants-submit]").click();
  await settle();
  assert.equal(document.querySelector("[data-grants-close]").disabled, true);
  slow.overlay.querySelector(".exercise-editor-backdrop").click();
  assert.equal(slow.overlay.isConnected, true);
  finish({ changed: false, added: [], removed: [], unchanged: 2 });
  await settle();
  await settle();
  assert.match(slow.text(), /Nothing to change: every account already has the chosen blocks/);
  slow.dom.window.close();
});

test("the modal shell is shared with Move to block, and the marks, bar and dialog have touch-size controls", async () => {
  const bulk = await readFile(new URL("../exercise-bulk-move.js", import.meta.url), "utf8");
  assert.match(bulk, /import \{ openModalShell \} from "\.\/modal-shell\.js"/);
  const grants = await readFile(new URL("../exercise-block-grants.js", import.meta.url), "utf8");
  assert.match(grants, /openModalShell\(/);
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.organization-user-select\s*\{[^}]*width:\s*44px;\s*height:\s*44px/);
  assert.match(css, /@media \(min-width: 761px\)\s*\{\s*\.organization-user-selection-bar\s*\{[^}]*position:\s*static/);
  assert.match(css, /\.organization-user-row\.is-selectable \.organization-row-actions\s*\{\s*grid-column:\s*3/);
  assert.match(css, /\.organization-user-select-button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.exercise-block-grants-list label\s*\{[^}]*min-height:\s*44px/);
  assert.match(renderBlockGrantsHtml({ loading: true }), /Reading the selected accounts/);
});
