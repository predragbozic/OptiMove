import { api } from "./api.js";
import { isAthleteMode } from "./access.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Header workspace switcher for a multi-role account (platform admin,
// independent/private coach, club admin in one or more clubs, team coach in
// one or more teams, athlete). This UI only ever reflects and requests a
// change of PRESENTATION context - it never grants a permission itself; the
// backend (req.authz) remains the real authorization boundary regardless of
// what this renders. See backend/src/workspace.js for the same boundary
// documented server-side.

function sameWorkspace(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && String(a.scopeId || "") === String(b.scopeId || "");
}

function workspaceLabel(workspace) {
  if (!workspace) return "";
  if (workspace.type === "platform") return "Platform administration";
  if (workspace.type === "private_coach") return "Private coaching";
  if (workspace.type === "club") return `Club · ${workspace.label}`;
  if (workspace.type === "team") return `Team · ${workspace.label}`;
  if (workspace.type === "athlete") return "Athlete";
  return workspace.label || "Workspace";
}

export function renderWorkspaceSwitcher() {
  if (!els.workspaceToggle || !els.workspacePanel) return;
  const user = state.currentUser;
  const active = user?.activeWorkspace || null;
  const available = user?.availableWorkspaces || [];
  const isSignedIn = Boolean(user);

  els.workspaceToggle.hidden = !isSignedIn || !active;
  if (!isSignedIn || !active) {
    els.workspacePanel.hidden = true;
    els.workspacePanel.innerHTML = "";
    return;
  }

  const canSwitch = available.length > 1;
  const caret = canSwitch ? `<span class="workspace-toggle-caret" aria-hidden="true">&#9662;</span>` : "";
  els.workspaceToggle.innerHTML = `<span class="workspace-toggle-label">${escapeHtml(workspaceLabel(active))}</span>${caret}`;
  els.workspaceToggle.disabled = Boolean(state.workspaceSwitcher.pending);

  if (canSwitch) {
    els.workspaceToggle.dataset.action = "workspace-toggle";
    els.workspaceToggle.setAttribute("aria-haspopup", "listbox");
    els.workspaceToggle.setAttribute("aria-expanded", state.workspaceSwitcher.open ? "true" : "false");
  } else {
    delete els.workspaceToggle.dataset.action;
    els.workspaceToggle.removeAttribute("aria-haspopup");
    els.workspaceToggle.removeAttribute("aria-expanded");
    state.workspaceSwitcher.open = false;
  }

  const open = canSwitch && state.workspaceSwitcher.open;
  els.workspacePanel.hidden = !open;
  els.workspacePanel.innerHTML = open ? renderWorkspacePanelHtml(available, active) : "";
}

function renderWorkspacePanelHtml(available, active) {
  const error = state.workspaceSwitcher.error
    ? `<p class="form-error workspace-panel-error">${escapeHtml(state.workspaceSwitcher.error)}</p>`
    : "";
  const rows = available
    .map((workspace) => {
      const isActive = sameWorkspace(workspace, active);
      return `
        <button class="workspace-option${isActive ? " is-active" : ""}" type="button" role="option" aria-selected="${isActive ? "true" : "false"}"
          data-action="workspace-select"
          data-workspace-type="${escapeAttr(workspace.type)}"
          data-workspace-scope-id="${escapeAttr(workspace.scopeId || "")}"
          ${state.workspaceSwitcher.pending ? "disabled" : ""}>${escapeHtml(workspaceLabel(workspace))}</button>
      `;
    })
    .join("");
  return `
    <div class="workspace-panel-head">Switch workspace</div>
    ${error}
    <div class="workspace-option-list" role="listbox">${rows}</div>
  `;
}

export async function handleWorkspaceAction(action, handlers = {}) {
  const type = action?.dataset?.action || "";
  if (type === "workspace-toggle") {
    state.workspaceSwitcher.open = !state.workspaceSwitcher.open;
    state.workspaceSwitcher.error = "";
    renderWorkspaceSwitcher();
    return true;
  }
  if (type === "workspace-select") {
    if (state.workspaceSwitcher.pending) return true;
    const nextType = action.dataset.workspaceType || "";
    const nextScopeId = action.dataset.workspaceScopeId || null;
    const current = state.currentUser?.activeWorkspace || null;
    if (sameWorkspace(current, { type: nextType, scopeId: nextScopeId })) {
      state.workspaceSwitcher.open = false;
      renderWorkspaceSwitcher();
      return true;
    }

    state.workspaceSwitcher.pending = true;
    state.workspaceSwitcher.error = "";
    renderWorkspaceSwitcher();
    try {
      const data = await api("/api/auth/workspace", {
        method: "PUT",
        body: JSON.stringify({ type: nextType, scopeId: nextScopeId }),
      });
      state.currentUser = {
        ...state.currentUser,
        activeWorkspace: data.activeWorkspace,
        availableWorkspaces: data.availableWorkspaces,
      };
      state.workspaceSwitcher.pending = false;
      state.workspaceSwitcher.open = false;
      state.workspaceSwitcher.error = "";

      const wasAthleteMode = isAthleteMode();
      const nowAthlete = data.activeWorkspace?.type === "athlete";
      if (nowAthlete && !wasAthleteMode) {
        window.location.assign("/athlete");
        return true;
      }
      if (!nowAthlete && wasAthleteMode) {
        window.location.assign("/");
        return true;
      }
      renderWorkspaceSwitcher();
      await handlers.onWorkspaceChanged?.();
    } catch (error) {
      state.workspaceSwitcher.pending = false;
      state.workspaceSwitcher.error = error?.message === "WORKSPACE_NOT_AVAILABLE"
        ? "That workspace is no longer available."
        : (error?.message || "Could not switch workspace.");
      renderWorkspaceSwitcher();
    }
    return true;
  }
  return false;
}

export function closeWorkspaceSwitcherIfOutside(target) {
  if (!state.workspaceSwitcher.open) return;
  if (target.closest(".workspace-menu")) return;
  state.workspaceSwitcher.open = false;
  renderWorkspaceSwitcher();
}
