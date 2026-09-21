// Settings -> Data sources (phase F3b): events and mutations.
//
// Two rules hold everywhere here: opening a form, choosing a coach or typing
// a number sends nothing, and every write goes through a confirmation that
// names both sides first. Cancel only clears the screen.
import {
  grantApprover,
  teamCoachOptions,
  loadDataSourcesTeam,
  resetDataSourcesForms,
  revokeApprover,
  saveGpexeConnection,
  selectDataSourcesTeam,
} from "./data-sources-data.js";
import { validateFilterableSelects } from "./organization-select.js";
import { state } from "./state.js";

function ds() {
  return state.dataSources;
}

// A refusal the screen can answer on its own, in the same shape the server's
// refusals arrive in, so one mapping renders both.
function localError(code) {
  return { status: 400, code, message: "" };
}

export async function handleDataSourcesAction(action, { render }) {
  const type = action.dataset.action;
  if (!type || !type.startsWith("data-sources-")) return false;
  const d = ds();

  if (type === "data-sources-connect-open") {
    resetDataSourcesForms();
    d.connectOpen = true;
    d.notice = "";
    d.noticeFor = "";
    render();
    return true;
  }
  if (type === "data-sources-grant-open") {
    resetDataSourcesForms();
    d.grantOpen = true;
    d.notice = "";
    d.noticeFor = "";
    render();
    return true;
  }
  if (type === "data-sources-revoke-open") {
    resetDataSourcesForms();
    d.revokeConfirm = { grantId: action.dataset.grantId || "", userName: action.dataset.userName || "", reason: "" };
    d.notice = "";
    d.noticeFor = "";
    render();
    return true;
  }
  if (type === "data-sources-cancel") {
    resetDataSourcesForms();
    render();
    return true;
  }
  if (type === "data-sources-toggle-history") {
    d.historyOpen = !d.historyOpen;
    render();
    return true;
  }
  if (type === "data-sources-reload") {
    await loadDataSourcesTeam(render);
    return true;
  }
  if (type === "data-sources-connect-save") {
    await saveGpexeConnection(render);
    return true;
  }
  if (type === "data-sources-grant-save") {
    await grantApprover(render);
    return true;
  }
  return false;
}

// Reads one named field of the form. `form.elements` is what a browser
// gives; the suites drive these handlers with the same shape instead of a
// whole document.
function fieldValue(form, name) {
  const field = form.elements?.[name] ?? form.querySelector?.(`[name="${name}"]`) ?? null;
  return String(field?.value ?? "").trim();
}

export async function submitDataSourcesForm(form, { render }) {
  const kind = form.dataset.dataSourcesForm;
  const d = ds();
  const value = (name) => fieldValue(form, name);

  if (kind === "team") {
    if (form.querySelectorAll && !validateFilterableSelects(form)) return;
    await selectDataSourcesTeam(value("teamId"), render);
    return;
  }

  if (kind === "connect") {
    const gpexeTeamId = value("gpexeTeamId");
    const reason = value("reason");
    const connected = Boolean(d.status?.settings);
    d.connectDraft = { gpexeTeamId, reason };
    if (!/^[0-9]{1,12}$/.test(gpexeTeamId)) {
      d.connectError = localError("invalid_gpexe_team_id");
      render();
      return;
    }
    if (connected && !reason) {
      d.connectError = localError("change_reason_required");
      render();
      return;
    }
    d.connectError = null;
    d.connectOpen = false;
    d.connectConfirm = { gpexeTeamId, reason };
    render();
    return;
  }

  if (kind === "grant") {
    const userId = value("userId");
    const reason = value("reason");
    if (!userId) {
      d.grantError = localError("grantee_not_team_coach");
      render();
      return;
    }
    if (!reason) {
      d.grantError = localError("reason_required");
      render();
      return;
    }
    // The name comes from the same list that built the options, so the
    // confirmation can never name somebody the list does not offer.
    const coach = teamCoachOptions().find((row) => row.value === userId);
    if (!coach) {
      d.grantError = localError("grantee_not_team_coach");
      render();
      return;
    }
    d.grantError = null;
    d.grantOpen = false;
    d.grantConfirm = { userId, userName: coach.label, reason };
    render();
    return;
  }

  if (kind === "revoke") {
    const reason = value("reason");
    if (!d.revokeConfirm) return;
    d.revokeConfirm = { ...d.revokeConfirm, reason };
    if (!reason) {
      d.revokeError = localError("reason_required");
      render();
      return;
    }
    d.revokeError = null;
    await revokeApprover(render);
  }
}
