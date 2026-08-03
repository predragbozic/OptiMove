import { test } from "node:test";
import assert from "node:assert/strict";

function fakeElement() {
  const attrs = {};
  return {
    hidden: false,
    disabled: false,
    innerHTML: "",
    dataset: {},
    setAttribute(name, value) {
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    getAttribute(name) {
      return attrs[name];
    },
  };
}

const workspaceToggleEl = fakeElement();
const workspacePanelEl = fakeElement();
let athleteMode = false;

globalThis.document = {
  querySelector: (selector) => {
    if (selector === "#workspaceToggle") return workspaceToggleEl;
    if (selector === "#workspacePanel") return workspacePanelEl;
    return null;
  },
  querySelectorAll: () => [],
  body: { classList: { contains: () => athleteMode } },
};

const { handleWorkspaceAction, closeWorkspaceSwitcherIfOutside, renderWorkspaceSwitcher } = await import("../workspace-actions.js");
const { state } = await import("../state.js");

function resetState() {
  athleteMode = false;
  workspaceToggleEl.hidden = false;
  workspaceToggleEl.innerHTML = "";
  workspaceToggleEl.disabled = false;
  workspaceToggleEl.dataset = {};
  workspacePanelEl.hidden = true;
  workspacePanelEl.innerHTML = "";
  state.workspaceSwitcher = { open: false, pending: false, error: "" };
}

function fakeAction(dataset) {
  return { dataset, closest: (selector) => (selector === ".workspace-menu" ? { matched: true } : null) };
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

const platformWorkspace = { type: "platform", scopeId: null, label: "Platform administration", role: "platform_admin" };
const clubWorkspace = { type: "club", scopeId: "club-1", label: "FK Partizan", role: "club_admin" };
const teamWorkspace = { type: "team", scopeId: "team-1", label: "U18 Boys", role: "team_coach" };
const athleteWorkspace = { type: "athlete", scopeId: null, label: "Athlete", role: "athlete" };

test("1. a single available workspace shows its name with no dropdown affordance", () => {
  resetState();
  state.currentUser = { activeWorkspace: platformWorkspace, availableWorkspaces: [platformWorkspace] };
  renderWorkspaceSwitcher();

  assert.equal(workspaceToggleEl.hidden, false);
  assert.ok(workspaceToggleEl.innerHTML.includes("Platform administration"));
  assert.equal(workspaceToggleEl.dataset.action, undefined, "a single workspace must not be given a toggle action");
  assert.equal(workspacePanelEl.hidden, true);
});

test("2. multiple available workspaces render a switcher toggle that opens a dropdown", async () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  renderWorkspaceSwitcher();
  assert.equal(workspaceToggleEl.dataset.action, "workspace-toggle");

  await handleWorkspaceAction(fakeAction({ action: "workspace-toggle" }));
  assert.equal(state.workspaceSwitcher.open, true);
  assert.equal(workspacePanelEl.hidden, false);
});

test("3. club and team workspace options render their real club/team names", () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  state.workspaceSwitcher.open = true;
  renderWorkspaceSwitcher();
  assert.ok(workspacePanelEl.innerHTML.includes("Club · FK Partizan"));
  assert.ok(workspacePanelEl.innerHTML.includes("Team · U18 Boys"));
});

test("4. selecting a workspace sends PUT with the exact type/scopeId, shows pending, and a second click is ignored", async () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  const calls = installFetchMock([{ status: 200, body: { activeWorkspace: teamWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] } }]);

  const action = fakeAction({ action: "workspace-select", workspaceType: "team", workspaceScopeId: "team-1" });
  const first = handleWorkspaceAction(action);
  // Fire a second click synchronously while the first is still pending.
  const second = handleWorkspaceAction(action);
  await Promise.all([first, second]);

  assert.equal(calls.length, 1, "a second click while pending must not send a second request");
  assert.equal(calls[0].url, "/api/auth/workspace");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(calls[0].body, { type: "team", scopeId: "team-1" });
  assert.equal(state.currentUser.activeWorkspace.type, "team");
  assert.equal(state.workspaceSwitcher.pending, false);
});

test("5. selecting the currently active workspace again makes no network call (idempotent no-op) and just closes the panel", async () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  state.workspaceSwitcher.open = true;
  const calls = installFetchMock([]);

  await handleWorkspaceAction(fakeAction({ action: "workspace-select", workspaceType: "club", workspaceScopeId: "club-1" }));
  assert.equal(calls.length, 0);
  assert.equal(state.workspaceSwitcher.open, false);
});

test("6. a failed workspace switch leaves the previous workspace in place and surfaces an error", async () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  installFetchMock([{ status: 403, body: { error: "WORKSPACE_NOT_AVAILABLE" } }]);

  await handleWorkspaceAction(fakeAction({ action: "workspace-select", workspaceType: "team", workspaceScopeId: "team-1" }));
  assert.equal(state.currentUser.activeWorkspace.type, "club", "activeWorkspace must be unchanged after a rejected switch");
  assert.ok(state.workspaceSwitcher.error);
  assert.equal(state.workspaceSwitcher.pending, false);
});

test("7. a network failure also leaves the previous workspace unchanged", async () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  installFetchMock([{ throwNetworkError: true }]);

  await handleWorkspaceAction(fakeAction({ action: "workspace-select", workspaceType: "team", workspaceScopeId: "team-1" }));
  assert.equal(state.currentUser.activeWorkspace.type, "club");
  assert.ok(state.workspaceSwitcher.error);
});

test("8. selecting the athlete workspace from the staff shell navigates to /athlete", async () => {
  resetState();
  athleteMode = false;
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, athleteWorkspace] };
  installFetchMock([{ status: 200, body: { activeWorkspace: athleteWorkspace, availableWorkspaces: [clubWorkspace, athleteWorkspace] } }]);
  const assigned = [];
  globalThis.window = { location: { assign: (url) => assigned.push(url) } };

  await handleWorkspaceAction(fakeAction({ action: "workspace-select", workspaceType: "athlete", workspaceScopeId: "" }));
  assert.deepEqual(assigned, ["/athlete"]);
});

test("9. selecting a staff workspace from the athlete shell navigates to /", async () => {
  resetState();
  athleteMode = true;
  state.currentUser = { activeWorkspace: athleteWorkspace, availableWorkspaces: [clubWorkspace, athleteWorkspace] };
  installFetchMock([{ status: 200, body: { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, athleteWorkspace] } }]);
  const assigned = [];
  globalThis.window = { location: { assign: (url) => assigned.push(url) } };

  await handleWorkspaceAction(fakeAction({ action: "workspace-select", workspaceType: "club", workspaceScopeId: "club-1" }));
  assert.deepEqual(assigned, ["/"]);
});

test("10. the switcher renders purely from availableWorkspaces - an empty list (e.g. a fake role_hint with no real role) shows nothing, regardless of any role_hint-like field", () => {
  resetState();
  state.currentUser = { role_hint: "platform_admin", role: "platform_admin", activeWorkspace: null, availableWorkspaces: [] };
  renderWorkspaceSwitcher();
  assert.equal(workspaceToggleEl.hidden, true, "with no real activeWorkspace, the toggle must stay hidden even if role_hint claims something");
});

test("11. closeWorkspaceSwitcherIfOutside closes the panel on an outside click but not a click inside the menu", () => {
  resetState();
  state.currentUser = { activeWorkspace: clubWorkspace, availableWorkspaces: [clubWorkspace, teamWorkspace] };
  state.workspaceSwitcher.open = true;
  renderWorkspaceSwitcher();

  const insideTarget = { closest: (selector) => (selector === ".workspace-menu" ? {} : null) };
  closeWorkspaceSwitcherIfOutside(insideTarget);
  assert.equal(state.workspaceSwitcher.open, true, "a click inside the workspace menu must not close it");

  const outsideTarget = { closest: () => null };
  closeWorkspaceSwitcherIfOutside(outsideTarget);
  assert.equal(state.workspaceSwitcher.open, false, "a click outside the workspace menu must close it");
});

test("12. after a workspace is revoked and a fallback takes over, the switcher reflects the new active workspace and drops the old one from the list", () => {
  resetState();
  // Simulates the state right after GET /api/auth/me resolved a new fallback
  // because the previously active club workspace was revoked.
  state.currentUser = { activeWorkspace: teamWorkspace, availableWorkspaces: [teamWorkspace] };
  renderWorkspaceSwitcher();
  assert.ok(workspaceToggleEl.innerHTML.includes("Team · U18 Boys"));
  assert.equal(workspaceToggleEl.dataset.action, undefined, "only one workspace remains, so no dropdown is needed");
});
