import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { handleOrganizationAction, closeManageAccountModal } = await import("../organization-actions.js");
const { state } = await import("../state.js");

function resetState() {
  state.organizationUserManage = { open: true, userId: "user-1", pending: false, error: "" };
  state.organization = { data: { users: [{ id: "user-1", globalRoles: [] }] }, showDisabledUsers: false };
  state.currentUser = { id: "viewer-1" };
  state.activeTab = "organization";
}

function fakeAction(dataset, { closestResult = null } = {}) {
  return { dataset, disabled: false, closest: () => closestResult };
}

// Stands in for the <div data-manage-account-add="club|team"> wrapper the
// Add button's action.closest(...) looks up to read the sibling <select>'s
// chosen value - a minimal DOM double, not a real element.
function fakeAddContainer(selectValue) {
  return { querySelector: () => ({ value: selectValue }) };
}

// A minimal fetch mock: queues one response object per call, records every
// call's url/method/body so tests can assert exactly what was sent.
function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.shift();
    if (next?.throwNetworkError) throw new TypeError("Failed to fetch");
    const status = next?.status ?? 200;
    const body = next?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: async () => body,
    };
  };
  return calls;
}

function noopCallbacks(overrides = {}) {
  return {
    loadAthletes: async () => {},
    renderOrganizationPanel: async () => {},
    refreshOrganizationData: async () => {},
    renderAfterOrganizationAccessChange: async () => {},
    ...overrides,
  };
}

test("granting platform_admin sends a PUT to the exact global-roles endpoint", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, globalRoles: [] } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };

  const handled = await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "platform_admin", nextActive: "true" }),
    noopCallbacks(),
  );
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/global-roles/platform_admin");
  assert.equal(calls[0].method, "PUT");
});

test("revoking platform_admin sends a DELETE and asks for the exact required confirmation", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, globalRoles: [] } }]);
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "platform_admin", nextActive: "false" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/global-roles/platform_admin");
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(confirmMessages, ["Remove platform administrator access from this account? Other roles and login access will remain unchanged."]);
});

test("revoking independent_coach sends a DELETE to the correct endpoint without any confirmation prompt", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, globalRoles: [] } }]);
  let confirmCalled = false;
  globalThis.window = { confirm: () => { confirmCalled = true; return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "independent_coach", nextActive: "false" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/global-roles/independent_coach");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(confirmCalled, false, "removing private coaching must never prompt for confirmation");
});

test("disabling a login sends PUT { active: false } and the exact required confirmation", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, active: false, disabled: true } }]);
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-user-login-toggle", userId: "user-1", nextActive: "false" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/login-status");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(calls[0].body, { active: false });
  assert.deepEqual(confirmMessages, ["Disable sign-in for this account? All current sessions will end. Roles, athlete profile, memberships, plans and history will remain unchanged."]);
});

test("enabling a login sends PUT { active: true } with no confirmation prompt", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, active: true, disabled: false } }]);
  let confirmCalled = false;
  globalThis.window = { confirm: () => { confirmCalled = true; return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-user-login-toggle", userId: "user-1", nextActive: "true" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/login-status");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(calls[0].body, { active: true });
  assert.equal(confirmCalled, false, "enabling a login must never prompt for confirmation");
});

test("a second click while a request is pending is ignored (no second network call)", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  let releaseFirstCall;
  const firstCallStarted = new Promise((resolve) => {
    globalThis.fetch = async () => {
      resolve();
      await new Promise((releaseResolve) => { releaseFirstCall = releaseResolve; });
      return { ok: true, status: 200, json: async () => ({ ok: true, globalRoles: [] }) };
    };
  });

  const firstCallPromise = handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "independent_coach", nextActive: "true" }),
    noopCallbacks(),
  );
  await firstCallStarted;
  assert.equal(state.organizationUserManage.pending, true, "pending must be true while the first request is in flight");

  let secondCallMade = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    secondCallMade = true;
    return originalFetch(...args);
  };
  const secondHandled = await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "independent_coach", nextActive: "true" }),
    noopCallbacks(),
  );
  assert.equal(secondHandled, true, "the action type is still recognized (short-circuited, not unhandled)");
  assert.equal(secondCallMade, false, "a second click while pending must not trigger a second network request");

  releaseFirstCall();
  await firstCallPromise;
  assert.equal(state.organizationUserManage.pending, false, "pending must clear once the first request finishes");
});

test("after a successful action, organization data is refreshed and the panel is re-rendered", async () => {
  resetState();
  installFetchMock([{ status: 200, body: { ok: true, globalRoles: [] } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };
  let refreshed = false;
  let rendered = false;

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "independent_coach", nextActive: "true" }),
    noopCallbacks({
      refreshOrganizationData: async () => { refreshed = true; },
      renderOrganizationPanel: async () => { rendered = true; },
    }),
  );
  assert.equal(refreshed, true, "organization data must be refreshed after success");
  assert.equal(rendered, true, "the panel must be re-rendered after success");
  assert.equal(state.organizationUserManage.error, "", "no error should remain after a successful action");
});

test("LAST_PLATFORM_ADMIN is shown as the required friendly message, with no state corruption", async () => {
  resetState();
  const originalRow = state.organization.data.users[0];
  installFetchMock([{ status: 409, body: { error: "LAST_PLATFORM_ADMIN" } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };
  let refreshCalled = false;

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "platform_admin", nextActive: "false" }),
    noopCallbacks({ refreshOrganizationData: async () => { refreshCalled = true; } }),
  );

  assert.equal(state.organizationUserManage.error, "At least one active platform administrator must remain.");
  assert.equal(refreshCalled, false, "a failed action must not trigger a data refresh");
  assert.equal(state.organization.data.users[0], originalRow, "the previous known-good user row must be untouched (no optimistic mutation)");
  assert.equal(state.organizationUserManage.pending, false, "pending must clear after a failed action");
});

test("a 403 error surfaces the backend's message without changing prior state", async () => {
  resetState();
  installFetchMock([{ status: 403, body: { error: "Only a platform admin can grant global roles." } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "independent_coach", nextActive: "true" }),
    noopCallbacks(),
  );
  assert.equal(state.organizationUserManage.error, "Only a platform admin can grant global roles.");
});

test("a network failure is handled gracefully with a fallback message and no state corruption", async () => {
  resetState();
  installFetchMock([{ throwNetworkError: true }]);
  globalThis.window = { confirm: () => true, alert: () => {} };
  let refreshCalled = false;

  await handleOrganizationAction(
    fakeAction({ action: "organization-user-login-toggle", userId: "user-1", nextActive: "false" }),
    noopCallbacks({ refreshOrganizationData: async () => { refreshCalled = true; } }),
  );

  assert.ok(state.organizationUserManage.error, "an error message must be set");
  assert.equal(refreshCalled, false, "a network failure must not trigger a data refresh");
  assert.equal(state.organizationUserManage.pending, false);
});

test("a cancelled confirmation makes no network call at all", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: {} }]);
  globalThis.window = { confirm: () => false, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-global-role-toggle", userId: "user-1", role: "platform_admin", nextActive: "false" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 0, "declining the confirmation must not call the API at all");
});

// closeManageAccountModal is the exact function app.js's global Escape
// handler calls (only when the modal is open) - this is the unit worth
// testing directly, since app.js itself is a bootstrap entry point with no
// exports to exercise in isolation.
test("closeManageAccountModal resets the modal state and makes no network call", async () => {
  resetState();
  const calls = installFetchMock([]);
  let rendered = false;

  closeManageAccountModal(async () => { rendered = true; });

  assert.deepEqual(state.organizationUserManage, { open: false, userId: "", pending: false, error: "" });
  assert.equal(rendered, true, "the panel must be re-rendered so the modal actually disappears");
  assert.equal(calls.length, 0, "closing via Escape must never call the API");
});

test("closeManageAccountModal clears a stale pending/error state left over from a failed action", async () => {
  resetState();
  state.organizationUserManage = { open: true, userId: "user-1", pending: true, error: "Something went wrong. Please try again." };

  closeManageAccountModal(async () => {});

  assert.equal(state.organizationUserManage.open, false);
  assert.equal(state.organizationUserManage.pending, false);
  assert.equal(state.organizationUserManage.error, "");
});

// --- club/team scoped-role actions ---

test("adding a club administrator sends a PUT to the exact club-roles endpoint with the selected club", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, clubRoles: [] } }]);

  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-add", userId: "user-1" }, { closestResult: fakeAddContainer("club-5") }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/club-roles/club-5/club_admin");
  assert.equal(calls[0].method, "PUT");
});

test("removing a club administrator sends a DELETE and asks for the exact required confirmation naming the person and club", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, clubRoles: [] } }]);
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-remove", userId: "user-1", clubId: "club-5", userName: "Ana Anić", clubName: "FK Partizan" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/club-roles/club-5/club_admin");
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(confirmMessages, ["Remove club administrator access for Ana Anić in FK Partizan?"]);
});

test("a cancelled club-role removal confirmation makes no network call", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: {} }]);
  globalThis.window = { confirm: () => false, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-remove", userId: "user-1", clubId: "club-5", userName: "Ana Anić", clubName: "FK Partizan" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 0);
});

test("adding a team coach sends a PUT to the exact team-roles endpoint with the selected team", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, teamRoles: [] } }]);

  await handleOrganizationAction(
    fakeAction({ action: "organization-team-role-add", userId: "user-1" }, { closestResult: fakeAddContainer("team-9") }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/team-roles/team-9/team_coach");
  assert.equal(calls[0].method, "PUT");
});

test("removing a team coach sends a DELETE and asks for the exact required confirmation naming the person and team", async () => {
  resetState();
  const calls = installFetchMock([{ status: 200, body: { ok: true, teamRoles: [] } }]);
  const confirmMessages = [];
  globalThis.window = { confirm: (message) => { confirmMessages.push(message); return true; }, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-team-role-remove", userId: "user-1", teamId: "team-9", userName: "Ana Anić", teamName: "U17" }),
    noopCallbacks(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/organization/users/user-1/team-roles/team-9/team_coach");
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(confirmMessages, ["Remove team coach access for Ana Anić in U17?"]);
});

test("a second click on an add-club-role button while a request is pending is ignored", async () => {
  resetState();
  globalThis.window = { confirm: () => true, alert: () => {} };
  let releaseFirstCall;
  const firstCallStarted = new Promise((resolve) => {
    globalThis.fetch = async () => {
      resolve();
      await new Promise((releaseResolve) => { releaseFirstCall = releaseResolve; });
      return { ok: true, status: 200, json: async () => ({ ok: true, clubRoles: [] }) };
    };
  });

  const firstCallPromise = handleOrganizationAction(
    fakeAction({ action: "organization-club-role-add", userId: "user-1" }, { closestResult: fakeAddContainer("club-5") }),
    noopCallbacks(),
  );
  await firstCallStarted;
  assert.equal(state.organizationUserManage.pending, true);

  let secondCallMade = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { secondCallMade = true; return originalFetch(...args); };
  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-add", userId: "user-1" }, { closestResult: fakeAddContainer("club-5") }),
    noopCallbacks(),
  );
  assert.equal(secondCallMade, false, "a second click while pending must not trigger a second network request");

  releaseFirstCall();
  await firstCallPromise;
  assert.equal(state.organizationUserManage.pending, false);
});

test("LAST_CLUB_ADMIN is shown as the required friendly message on a rejected club-role removal", async () => {
  resetState();
  installFetchMock([{ status: 409, body: { error: "LAST_CLUB_ADMIN" } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-remove", userId: "user-1", clubId: "club-5", userName: "Ana", clubName: "FK Partizan" }),
    noopCallbacks(),
  );
  assert.equal(state.organizationUserManage.error, "At least one active club administrator must remain.");
});

test("after a successful club-role change, organization data is refreshed and the panel re-rendered without a page reload", async () => {
  resetState();
  installFetchMock([{ status: 200, body: { ok: true, clubRoles: [] } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };
  let refreshed = false;
  let rendered = false;

  await handleOrganizationAction(
    fakeAction({ action: "organization-club-role-add", userId: "user-1" }, { closestResult: fakeAddContainer("club-5") }),
    noopCallbacks({
      refreshOrganizationData: async () => { refreshed = true; },
      renderOrganizationPanel: async () => { rendered = true; },
    }),
  );
  assert.equal(refreshed, true);
  assert.equal(rendered, true);
  assert.equal(state.organizationUserManage.error, "");
  // The modal itself stays open - only the underlying data changes, so
  // re-rendering with { refresh: false } is what redraws it with fresh state.
  assert.equal(state.organizationUserManage.open, true);
});

test("a failed team-role removal leaves state untouched and does not close the modal", async () => {
  resetState();
  installFetchMock([{ status: 403, body: { error: "Only a platform admin, or this team's club admin, can remove team coach access." } }]);
  globalThis.window = { confirm: () => true, alert: () => {} };

  await handleOrganizationAction(
    fakeAction({ action: "organization-team-role-remove", userId: "user-1", teamId: "team-9", userName: "Ana", teamName: "U17" }),
    noopCallbacks(),
  );
  assert.equal(state.organizationUserManage.error, "Only a platform admin, or this team's club admin, can remove team coach access.");
  assert.equal(state.organizationUserManage.open, true, "a failed action must never close the modal");
});
