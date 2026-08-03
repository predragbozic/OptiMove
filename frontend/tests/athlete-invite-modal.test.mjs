import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderOrganizationBrowser } = await import("../organization-view.js");
const { handleOrganizationAction, closeAthleteInviteModal, submitOrganizationForm } = await import("../organization-actions.js");
const { state } = await import("../state.js");

function resetState() {
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
  state.currentUser = null;
}

function baseAthlete(overrides) {
  return {
    id: "unset",
    athlete_id: "AT1",
    source_external_id: "AT1",
    name: "Unset Athlete",
    image_url: "",
    is_active: true,
    user_id: null,
    login_active: null,
    login_is_multi_role: false,
    memberships: [],
    has_my_active_coach_relationship: false,
    has_my_archived_coach_relationship: false,
    has_active_access: true,
    inviteStatus: "none",
    invite: null,
    ...overrides,
  };
}

function fakeAction(dataset, { closestResult = null } = {}) {
  return { dataset, disabled: false, closest: () => closestResult };
}

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.shift();
    if (next?.throwNetworkError) throw new TypeError("Failed to fetch");
    const status = next?.status ?? 200;
    const body = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
  };
  return calls;
}

function stubNavigatorClipboard(clipboard) {
  // globalThis.navigator is a built-in Node global with only a getter, so a
  // plain assignment throws - redefine the property instead.
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
}

function noopCallbacks(overrides = {}) {
  return {
    loadAthletes: async () => {},
    renderOrganizationPanel: async () => {},
    refreshOrganizationData: async () => {},
    ...overrides,
  };
}

// --- render: button visibility per context and login state ---

test("1. the Invite trigger appears for an active club member in a club workspace", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-1", label: "FK Partizan" } };
  const clubId = "club-1";
  const athlete = baseAthlete({
    id: "athlete-club",
    name: "Club Member",
    memberships: [{ id: "m1", membershipType: "club", status: "active", clubId, clubName: "FK Partizan" }],
  });
  const data = { isPlatformAdmin: false, clubs: [{ id: clubId, name: "FK Partizan" }], teams: [], athletes: [athlete], users: [] };
  state.organization.selectedClubId = clubId;

  const html = renderOrganizationBrowser(data);
  assert.ok(html.includes('data-action="organization-invite-athlete"'), "a club workspace must offer Invite for an active club member");
});

test("2. no Invite trigger is offered when the active workspace is 'athlete'", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "athlete", scopeId: null } };
  const athlete = baseAthlete({ id: "athlete-noinvite", name: "No Invite In Athlete Workspace" });
  const data = { isPlatformAdmin: false, clubs: [], teams: [], athletes: [athlete], users: [] };

  const html = renderOrganizationBrowser(data);
  assert.ok(!html.includes('data-action="organization-invite-athlete"'), "the athlete workspace must never offer to send an invite");
});

test("3. no Invite trigger is offered for an athlete who already has a login, regardless of workspace", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  const athlete = baseAthlete({ id: "athlete-haslogin", name: "Has Login Athlete", user_id: "user-1", login_active: true });
  const data = { isPlatformAdmin: true, clubs: [], teams: [], athletes: [athlete], users: [] };

  const html = renderOrganizationBrowser(data);
  assert.ok(!html.includes('data-action="organization-invite-athlete"'), "an athlete that already has a login must never be offered Create invite");
});

test("4. no Invite trigger is offered when there is no resolved active workspace at all", () => {
  resetState();
  state.currentUser = { activeWorkspace: null };
  const athlete = baseAthlete({ id: "athlete-noworkspace", name: "No Workspace Athlete" });
  const data = { isPlatformAdmin: false, clubs: [], teams: [], athletes: [athlete], users: [] };

  const html = renderOrganizationBrowser(data);
  assert.ok(!html.includes('data-action="organization-invite-athlete"'));
});

// --- render: modal context label and status states ---

test("5. the modal displays the real active workspace context", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "team", scopeId: "team-1", label: "U18 Boys" } };
  const athlete = baseAthlete({ id: "athlete-modal-context", name: "Modal Context Athlete" });
  const data = { isPlatformAdmin: false, clubs: [], teams: [{ id: "team-1", club_id: "club-1", name: "U18 Boys" }], athletes: [athlete], users: [] };
  state.organizationInvite = { open: true, athleteId: "athlete-modal-context", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };

  const html = renderOrganizationBrowser(data);
  assert.ok(html.includes("Team · U18 Boys"), "the modal must show the real team name as its context");
});

test("6. the modal shows pending invite details (email and expiry) for an athlete with a pending invite", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-1", label: "FK Partizan" } };
  const athlete = baseAthlete({
    id: "athlete-pending",
    name: "Pending Athlete",
    inviteStatus: "pending",
    invite: { id: "invite-1", email: "pending-athlete@test.local", contextType: "club", contextId: "club-1", expiresAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z" },
  });
  const data = { isPlatformAdmin: false, clubs: [{ id: "club-1", name: "FK Partizan" }], teams: [], athletes: [athlete], users: [] };
  state.organizationInvite = { open: true, athleteId: "athlete-pending", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };

  const html = renderOrganizationBrowser(data);
  assert.ok(html.includes("pending-athlete@test.local"));
  assert.ok(html.includes('data-action="organization-invite-regenerate"'));
  assert.ok(html.includes('data-action="organization-invite-revoke"'));
});

test("7. an expired/revoked invite is shown informatively, with a new create form offered since the athlete still has no login", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  const athlete = baseAthlete({
    id: "athlete-expired",
    name: "Expired Athlete",
    inviteStatus: "expired",
    invite: { id: "invite-2", email: "expired-athlete@test.local", contextType: "platform", contextId: null, expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-12-01T00:00:00.000Z" },
  });
  const data = { isPlatformAdmin: true, clubs: [], teams: [], athletes: [athlete], users: [] };
  state.organizationInvite = { open: true, athleteId: "athlete-expired", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };

  const html = renderOrganizationBrowser(data);
  assert.ok(html.includes("Expired invite sent to expired-athlete@test.local"));
  assert.ok(html.includes('data-organization-form="athleteInvite"'), "a new invite must still be creatable since the athlete has no login");
});

// --- actions: create payload, pending guard, copy, regenerate/revoke confirm, cancel, escape ---

// submitOrganizationForm (used by the Create invite link form) builds its
// payload from `new FormData(form)`, which requires a real HTMLFormElement
// and so isn't exercisable in this jsdom-less suite (no existing test in
// this file touches it either). Regenerate hits the exact same endpoint
// with the exact same payload shape (athleteId/email/contextType/contextId
// derived from state.currentUser.activeWorkspace) via a plain api() call
// instead of a form submit - test 9 below verifies that contract precisely.
test("8. opening the Invite modal itself never makes a network call", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-9", label: "FK Vojvodina" } };
  state.organization.data = { athletes: [baseAthlete({ id: "athlete-x", name: "Athlete X" })] };
  const calls = installFetchMock([]);

  await handleOrganizationAction(fakeAction({ action: "organization-invite-athlete", athleteId: "athlete-x" }), noopCallbacks());
  assert.equal(calls.length, 0, "opening the modal itself must never make a network call");
  assert.equal(state.organizationInvite.open, true);
  assert.equal(state.organizationInvite.athleteId, "athlete-x");
});

test("9. regenerating a pending invite sends the same email/context and a second click while pending is ignored", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-9", label: "FK Vojvodina" } };
  state.organization.data = {
    athletes: [
      baseAthlete({
        id: "athlete-regen",
        inviteStatus: "pending",
        invite: { id: "invite-regen", email: "regen@test.local", contextType: "club", contextId: "club-9", expiresAt: "2026-09-01T00:00:00.000Z" },
      }),
    ],
  };
  state.organizationInvite = { open: true, athleteId: "athlete-regen", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  globalThis.window = { confirm: () => true, alert: () => {} };
  const calls = installFetchMock([{ status: 201, body: { invite: {}, inviteUrl: "https://app/invite?token=new", mailtoUrl: "mailto:y" } }]);

  const action = fakeAction({ action: "organization-invite-regenerate" });
  const first = handleOrganizationAction(action, noopCallbacks());
  const second = handleOrganizationAction(action, noopCallbacks());
  await Promise.all([first, second]);

  assert.equal(calls.length, 1, "a second click while a regenerate is pending must not send a second request");
  assert.equal(calls[0].url, "/api/organization/athlete-invites");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { athleteId: "athlete-regen", email: "regen@test.local", contextType: "club", contextId: "club-9" });
  assert.equal(state.organizationInvite.inviteUrl, "https://app/invite?token=new");
});

test("10. regenerate asks for confirmation, and cancelling makes no network call", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  state.organization.data = {
    athletes: [baseAthlete({ id: "athlete-regen-cancel", inviteStatus: "pending", invite: { id: "i", email: "cancel@test.local", contextType: "platform", contextId: null } })],
  };
  state.organizationInvite = { open: true, athleteId: "athlete-regen-cancel", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return false; }, alert: () => {} };
  const calls = installFetchMock([]);

  await handleOrganizationAction(fakeAction({ action: "organization-invite-regenerate" }), noopCallbacks());
  assert.equal(calls.length, 0, "cancelling the confirmation must never send a request");
  assert.equal(confirmMessages.length, 1);
});

test("11. revoke asks for confirmation, and cancelling makes no network call", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  state.organizationInvite = { open: true, athleteId: "athlete-revoke-cancel", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return false; }, alert: () => {} };
  const calls = installFetchMock([]);

  await handleOrganizationAction(fakeAction({ action: "organization-invite-revoke", inviteId: "invite-1" }), noopCallbacks());
  assert.equal(calls.length, 0);
  assert.equal(confirmMessages.length, 1);
});

test("12. revoke sends a DELETE to the exact endpoint when confirmed", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  state.organizationInvite = { open: true, athleteId: "athlete-revoke", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  globalThis.window = { confirm: () => true, alert: () => {} };
  const calls = installFetchMock([{ status: 200, body: { ok: true } }]);

  await handleOrganizationAction(fakeAction({ action: "organization-invite-revoke", inviteId: "invite-42" }), noopCallbacks());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/athlete-invites/invite-42");
  assert.equal(calls[0].method, "DELETE");
});

test("13. Copy link sets a success confirmation, and a failed/unavailable clipboard leaves the link visible without claiming success", async () => {
  resetState();
  state.organizationInvite = { open: true, athleteId: "athlete-copy", pending: false, error: "", inviteUrl: "https://app/invite?token=copyme", mailtoUrl: "mailto:z", copied: false };
  stubNavigatorClipboard({ writeText: async () => {} });
  await handleOrganizationAction(fakeAction({ action: "organization-copy-invite" }), noopCallbacks());
  assert.equal(state.organizationInvite.copied, true);
  assert.equal(state.organizationInvite.inviteUrl, "https://app/invite?token=copyme", "the link must remain visible after copying");

  state.organizationInvite.copied = false;
  stubNavigatorClipboard({ writeText: async () => { throw new Error("denied"); } });
  await handleOrganizationAction(fakeAction({ action: "organization-copy-invite" }), noopCallbacks());
  assert.equal(state.organizationInvite.copied, false, "a failed clipboard write must not claim success");
  assert.equal(state.organizationInvite.inviteUrl, "https://app/invite?token=copyme", "the link must still be visible for manual copying");
});

test("14. a backend error on regenerate/revoke stays shown in the modal and does not close it", async () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "platform", scopeId: null } };
  state.organizationInvite = { open: true, athleteId: "athlete-error", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  globalThis.window = { confirm: () => true, alert: () => {} };
  installFetchMock([{ status: 409, body: { error: "ATHLETE_ALREADY_HAS_LOGIN" } }]);

  await handleOrganizationAction(fakeAction({ action: "organization-invite-revoke", inviteId: "invite-err" }), noopCallbacks());
  assert.equal(state.organizationInvite.open, true, "the modal must remain open after a failed action");
  assert.ok(state.organizationInvite.error);
  assert.notEqual(state.organizationInvite.error, "ATHLETE_ALREADY_HAS_LOGIN", "the raw error code must never be shown verbatim");
});

// --- close: escape/backdrop never call the API ---

test("15. closeAthleteInviteModal (shared by Escape and backdrop) never makes a network call and resets state", async () => {
  resetState();
  state.organizationInvite = { open: true, athleteId: "athlete-close", pending: false, error: "some error", inviteUrl: "https://app/invite?token=x", mailtoUrl: "mailto:x", copied: true };
  const calls = installFetchMock([]);

  closeAthleteInviteModal(async () => {});
  assert.equal(calls.length, 0);
  assert.equal(state.organizationInvite.open, false);
  assert.equal(state.organizationInvite.error, "");
  assert.equal(state.organizationInvite.inviteUrl, "");
});

test("16. cancel (close) via handleOrganizationAction also makes no network call", async () => {
  resetState();
  state.organizationInvite = { open: true, athleteId: "athlete-cancel", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  const calls = installFetchMock([]);

  const handled = await handleOrganizationAction(fakeAction({ action: "organization-invite-close" }), noopCallbacks());
  assert.equal(handled, true);
  assert.equal(calls.length, 0);
  assert.equal(state.organizationInvite.open, false);
});
