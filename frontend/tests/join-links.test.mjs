import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderOrganizationPanelHtml, renderOrganizationActions } = await import("../organization-view.js");
const { handleOrganizationAction } = await import("../organization-actions.js");
const { state } = await import("../state.js");

// feature/group-athlete-join-links frontend: Join link management + Join
// requests review inside the Organization view. A separate, context-level
// system from the per-athlete Invite modal (athlete-invite-modal.test.mjs) -
// see backend/src/joinLinkContext.js for the backend counterpart.
//
// Note: the public /join?token=... page (frontend/join-actions.js) directly
// manipulates `els.content.innerHTML` via the real DOM, exactly like the
// existing /invite page in auth-actions.js - and, matching that existing
// file, has no dedicated render tests in this jsdom-less suite (there is no
// precedent test file for auth-actions.js's renderInviteAccept either). Its
// logic is a close mirror of the already-covered invite-accept flow (new
// email -> pending application; existing email -> requiresLogin -> login
// form -> authenticated apply-existing), and is exercised end-to-end by the
// backend integration tests instead.

function resetState() {
  state.organization = {
    data: null,
    error: "",
    selectedClubId: "",
    selectedTeamId: "",
    section: "joinLinks",
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
  state.organizationJoinLinks = { pending: false, error: "", justCreatedId: "", justCreatedUrl: "", copiedId: "", reviewPendingId: "" };
  state.organizationEditor = { open: false, type: "", row: null };
  state.currentUser = null;
}

function baseData(overrides = {}) {
  return {
    isPlatformAdmin: false,
    canCreateClub: false,
    canCreateTeam: false,
    canCreateAthlete: true,
    canCreateUser: false,
    manageableClubIds: [],
    manageableTeamIds: [],
    clubs: [],
    teams: [],
    athletes: [],
    users: [],
    accessRequests: [],
    joinLinks: [],
    joinApplications: [],
    activeWorkspace: null,
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

// --- render: create-toggle visibility per workspace ---

test("1. the Create join link trigger appears for private_coach/club/team workspaces", () => {
  for (const type of ["private_coach", "club", "team"]) {
    resetState();
    state.currentUser = { activeWorkspace: { type, scopeId: type === "private_coach" ? null : "scope-1" } };
    const html = renderOrganizationActions(baseData());
    assert.ok(html.includes('data-organization-form="joinLink"') === false, "the trigger itself, not the form, should be present when addFormOpen is false");
    assert.ok(html.includes("organization-add-toggle"), `a ${type} workspace must offer a Create join link trigger`);
  }
});

test("2. no Create join link trigger for a platform or athlete workspace", () => {
  for (const type of ["platform", "athlete"]) {
    resetState();
    state.currentUser = { activeWorkspace: { type, scopeId: null } };
    const html = renderOrganizationActions(baseData());
    assert.ok(!html.includes("organization-add-toggle"), `a ${type} workspace must never offer to create a join link`);
  }
});

test("2b. no Create join link trigger when there is no resolved active workspace at all", () => {
  resetState();
  state.currentUser = { activeWorkspace: null };
  const html = renderOrganizationActions(baseData());
  assert.ok(!html.includes("organization-add-toggle"));
});

test("3. the create form itself renders once the toggle is open", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "private_coach", scopeId: null } };
  state.organization.addFormOpen = true;
  const html = renderOrganizationActions(baseData());
  assert.ok(html.includes('data-organization-form="joinLink"'));
  assert.ok(html.includes('name="expiresInDays"'));
  assert.ok(html.includes('name="maxUses"'));
});

// --- render: link status/uses/pending count, and the just-created copy box ---

test("4. active/expired/revoked/full statuses and uses/pending counts are shown per link", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-1" } };
  const data = baseData({
    joinLinks: [
      { id: "l-active", label: "Active Link", contextType: "club", contextId: "club-1", status: "active", approvedUses: 2, maxUses: 10, pendingCount: 3, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "l-expired", label: "Expired Link", contextType: "club", contextId: "club-1", status: "expired", approvedUses: 1, maxUses: null, pendingCount: 0, expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-01-01T00:00:00.000Z" },
      { id: "l-revoked", label: "Revoked Link", contextType: "club", contextId: "club-1", status: "revoked", approvedUses: 0, maxUses: 5, pendingCount: 0, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "l-full", label: "Full Link", contextType: "club", contextId: "club-1", status: "full", approvedUses: 5, maxUses: 5, pendingCount: 1, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const html = renderOrganizationPanelHtml({ currentUser: state.currentUser, data, error: "", role: "club_admin", scope: "FK Partizan" });
  assert.ok(html.includes("Active Link") && html.includes("Active"));
  assert.ok(html.includes("Expired Link") && html.includes("Expired"));
  assert.ok(html.includes("Revoked Link") && html.includes("Revoked"));
  assert.ok(html.includes("Full Link") && html.includes("Full"));
  assert.ok(html.includes("2/10 used"));
  assert.ok(html.includes("3 pending"));
  const revokedRowDisabled = html.match(/Revoked Link[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(revokedRowDisabled.includes('data-action="organization-join-link-revoke"') && revokedRowDisabled.includes("disabled"), "a revoked link's own Revoke/Generate controls must be disabled");
});

test("5. a just-created/regenerated link shows the Copy link box with the raw join URL", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "private_coach", scopeId: null } };
  state.organizationJoinLinks.justCreatedId = "l-new";
  state.organizationJoinLinks.justCreatedUrl = "https://app.local/join?token=abc123";
  const data = baseData({ joinLinks: [{ id: "l-new", label: "Brand New", contextType: "private_coach", contextId: null, status: "active", approvedUses: 0, maxUses: null, pendingCount: 0, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }] });
  const html = renderOrganizationPanelHtml({ currentUser: state.currentUser, data, error: "", role: "independent_coach", scope: "Private coaching" });
  assert.ok(html.includes("https://app.local/join?token=abc123"));
  assert.ok(html.includes('data-action="organization-join-link-copy"'));
});

// --- render: Join requests, Approve/Reject only for pending ---

test("6. Join requests lists every application passed in, and offers Approve/Reject only while pending", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-1" } };
  const data = baseData({
    joinApplications: [
      { id: "a-pending", joinLinkId: "l1", email: "pending@test.local", name: "Pending Person", accountType: "new", status: "pending", submittedAt: "2026-01-01T00:00:00.000Z" },
      { id: "a-approved", joinLinkId: "l1", email: "approved@test.local", name: "Approved Person", accountType: "existing", status: "approved", submittedAt: "2026-01-01T00:00:00.000Z" },
      { id: "a-rejected", joinLinkId: "l1", email: "rejected@test.local", name: "Rejected Person", accountType: "new", status: "rejected", submittedAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  const html = renderOrganizationPanelHtml({ currentUser: state.currentUser, data, error: "", role: "club_admin", scope: "FK Partizan" });
  assert.ok(html.includes("Pending Person") && html.includes("Approved Person") && html.includes("Rejected Person"));
  assert.ok(html.includes("1 pending"));
  const pendingRow = html.match(/Pending Person[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(pendingRow.includes('data-action="organization-join-application-approve"') && pendingRow.includes('data-action="organization-join-application-reject"'));
  const approvedRow = html.match(/Approved Person[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(!approvedRow.includes('data-action="organization-join-application-approve"'), "an already-approved request must never show Approve/Reject again");
  const rejectedRow = html.match(/Rejected Person[\s\S]*?<\/article>/)?.[0] || "";
  assert.ok(!rejectedRow.includes('data-action="organization-join-application-reject"'));
});

test("6b. an error banner in organizationJoinLinks stays visible in the Join links panel", () => {
  resetState();
  state.currentUser = { activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.organizationJoinLinks.error = "Could not revoke this link.";
  const html = renderOrganizationPanelHtml({ currentUser: state.currentUser, data: baseData(), error: "", role: "club_admin", scope: "FK Partizan" });
  assert.ok(html.includes("Could not revoke this link."));
});

// --- actions: copy ---

test("7. copying a just-created link writes to the clipboard and shows confirmation", async () => {
  resetState();
  state.organizationJoinLinks.justCreatedId = "l-copy";
  state.organizationJoinLinks.justCreatedUrl = "https://app.local/join?token=xyz";
  let written = "";
  stubNavigatorClipboard({ writeText: async (text) => { written = text; } });
  globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => "" };

  const handled = await handleOrganizationAction(fakeAction({ action: "organization-join-link-copy", linkId: "l-copy" }), noopCallbacks());
  assert.equal(handled, true);
  assert.equal(written, "https://app.local/join?token=xyz");
  assert.equal(state.organizationJoinLinks.copiedId, "l-copy");
});

test("7b. copy silently no-ops (no throw) when the clipboard API is unavailable", async () => {
  resetState();
  state.organizationJoinLinks.justCreatedId = "l-copy2";
  state.organizationJoinLinks.justCreatedUrl = "https://app.local/join?token=xyz2";
  stubNavigatorClipboard(undefined);
  globalThis.window = { confirm: () => true, alert: () => {} };

  const handled = await handleOrganizationAction(fakeAction({ action: "organization-join-link-copy", linkId: "l-copy2" }), noopCallbacks());
  assert.equal(handled, true);
  assert.equal(state.organizationJoinLinks.copiedId, "");
});

// --- actions: regenerate ---

test("8. regenerate asks for confirmation; cancelling makes no network call", async () => {
  resetState();
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return false; }, alert: () => {} };
  const calls = installFetchMock([]);

  const handled = await handleOrganizationAction(fakeAction({ action: "organization-join-link-regenerate", linkId: "l1" }), noopCallbacks());
  assert.equal(handled, true);
  assert.equal(calls.length, 0, "cancelling the confirmation must never send a request");
  assert.equal(confirmMessages.length, 1);
});

test("9. confirmed regenerate calls the endpoint once, and a second click while pending is ignored", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  const calls = installFetchMock([{ status: 200, body: { link: { id: "l1", status: "active" }, joinUrl: "https://app.local/join?token=new" } }]);

  const action = fakeAction({ action: "organization-join-link-regenerate", linkId: "l1" });
  const [first, second] = await Promise.all([
    handleOrganizationAction(action, noopCallbacks()),
    handleOrganizationAction(action, noopCallbacks()),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls.length, 1, "a second click while a regenerate is pending must not send a second request");
  assert.equal(calls[0].url, "/api/organization/athlete-join-links/l1/regenerate");
  assert.equal(calls[0].method, "POST");
  assert.equal(state.organizationJoinLinks.justCreatedUrl, "https://app.local/join?token=new");
});

test("10. a failed regenerate leaves an error visible in state", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  installFetchMock([{ status: 403, body: { error: "You are not a club admin for this club." } }]);

  await handleOrganizationAction(fakeAction({ action: "organization-join-link-regenerate", linkId: "l1" }), noopCallbacks());
  assert.equal(state.organizationJoinLinks.pending, false);
  assert.equal(state.organizationJoinLinks.error, "You are not a club admin for this club.");
});

// --- actions: revoke ---

test("11. revoke asks for confirmation; cancelling makes no network call", async () => {
  resetState();
  globalThis.window = { confirm: () => false, alert: () => {} };
  const calls = installFetchMock([]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-link-revoke", linkId: "l1" }), noopCallbacks());
  assert.equal(calls.length, 0);
});

test("12. confirmed revoke calls DELETE once", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  const calls = installFetchMock([{ status: 200, body: { ok: true } }]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-link-revoke", linkId: "l1" }), noopCallbacks());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/athlete-join-links/l1");
  assert.equal(calls[0].method, "DELETE");
});

// --- actions: approve/reject ---

test("13. approve asks for confirmation with clear context; cancelling makes no network call", async () => {
  resetState();
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return false; }, alert: () => {} };
  const calls = installFetchMock([]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-application-approve", applicationId: "a1" }), noopCallbacks());
  assert.equal(calls.length, 0);
  assert.equal(confirmMessages.length, 1);
  assert.ok(confirmMessages[0].toLowerCase().includes("approve"));
});

test("14. confirmed approve calls the endpoint once, and a second click while pending is ignored", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  const calls = installFetchMock([{ status: 200, body: { ok: true, userId: "u1", athleteId: "ath1" } }]);
  const action = fakeAction({ action: "organization-join-application-approve", applicationId: "a1" });
  const [first, second] = await Promise.all([
    handleOrganizationAction(action, noopCallbacks()),
    handleOrganizationAction(action, noopCallbacks()),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls.length, 1, "a second click while an approval is pending must not send a second request");
  assert.equal(calls[0].url, "/api/organization/athlete-join-applications/a1/approve");
  assert.equal(calls[0].method, "POST");
});

test("15. a failed approve (e.g. JOIN_LINK_FULL) surfaces a readable error, not the raw code", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  installFetchMock([{ status: 409, body: { error: "JOIN_LINK_FULL" } }]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-application-approve", applicationId: "a1" }), noopCallbacks());
  assert.equal(state.organizationJoinLinks.reviewPendingId, "");
  assert.ok(state.organizationJoinLinks.error.length > 0);
  assert.notEqual(state.organizationJoinLinks.error, "JOIN_LINK_FULL");
});

test("16. reject prompts for an optional reason; cancelling the prompt makes no network call", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => null };
  const calls = installFetchMock([]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-application-reject", applicationId: "a1" }), noopCallbacks());
  assert.equal(calls.length, 0, "cancelling the reject prompt must never send a request");
});

test("17. confirmed reject sends the typed reason, and a second click while pending is ignored", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => "Not a fit" };
  const calls = installFetchMock([{ status: 200, body: { ok: true } }]);
  const action = fakeAction({ action: "organization-join-application-reject", applicationId: "a1" });
  const [first, second] = await Promise.all([
    handleOrganizationAction(action, noopCallbacks()),
    handleOrganizationAction(action, noopCallbacks()),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/athlete-join-applications/a1/reject");
  assert.deepEqual(calls[0].body, { reason: "Not a fit" });
});

test("18. a failed reject leaves the error visible and does not clear reviewPendingId incorrectly", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => "" };
  installFetchMock([{ status: 404, body: { error: "Request not found." } }]);
  await handleOrganizationAction(fakeAction({ action: "organization-join-application-reject", applicationId: "a1" }), noopCallbacks());
  assert.equal(state.organizationJoinLinks.reviewPendingId, "");
  assert.equal(state.organizationJoinLinks.error, "Request not found.");
});
