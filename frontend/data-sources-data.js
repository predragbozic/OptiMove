// Settings -> Data sources, the data side (phase F3b). One administrative
// screen for connecting an OptiMove team to the system its data comes from,
// and for deciding who may approve what that system sends. Today the only
// source is GPEXE.
//
// Every call goes to the existing F1/F2/F3a routes under
// /api/training-load/gpexe/teams/:teamId, plus one read-only history route
// added with this phase. Nothing here decides who may do what - the server
// does, again, on every request; a platform admin is the only writer it
// accepts, and the database refuses a change of a connection something
// already depends on (migration v24).
//
// The teams and the coaches come from the Settings data the screen already
// has (GET /api/organization), so this phase adds no second source of teams.
import { api } from "./api.js";
import { state } from "./state.js";

const BASE = "/api/training-load/gpexe/teams";
// The same page size the route applies (SETTINGS_HISTORY_LIMIT in
// backend/src/gpexeImportService.js): a full page may have older values
// behind it, and the screen says so instead of implying it is everything.
export const SETTINGS_HISTORY_LIMIT = 50;

function ds() {
  return state.dataSources;
}

function teamPath(teamId, rest = "") {
  return `${BASE}/${encodeURIComponent(teamId)}${rest}`;
}

export function errorInfo(error) {
  return {
    status: error?.status ?? 0,
    code: error?.data?.error || error?.message || "error",
    message: error?.data?.message || "",
  };
}

// The teams a platform admin may pick from: the ones Settings already
// loaded. The server still answers 404 for a team outside the caller's
// rights or active workspace, so this list is a convenience, not the rule.
export function dataSourcesTeamOptions() {
  const teams = state.organization?.data?.teams || [];
  return teams.map((team) => ({
    value: String(team.id),
    label: team.club_name ? `${team.name} (${team.club_name})` : team.name,
    name: team.name,
    clubName: team.club_name || "",
  }));
}

export function selectedTeam() {
  const teamId = ds().teamId;
  if (!teamId) return null;
  return dataSourcesTeamOptions().find((team) => team.value === String(teamId)) || null;
}

// Who may be given approval rights. Every condition the database itself
// checks on the grant (v22 validate_gpexe_import_approver: an ACTIVE
// team_coach role for THIS team and an ACTIVE account), plus the ones the
// route answers 409 for (a right already held), so the list never offers a
// name the server would refuse.
export function teamCoachOptions() {
  const teamId = String(ds().teamId || "");
  if (!teamId) return [];
  const granted = new Set((ds().approvers || []).filter((row) => row.active).map((row) => String(row.userId)));
  return (state.organization?.data?.users || [])
    .filter((user) => !granted.has(String(user.id)))
    .filter((user) => user.loginActive !== false)
    .filter((user) => (user.teamRoles || []).some((role) => String(role.teamId) === teamId && role.role === "team_coach" && role.isActive))
    .map((user) => ({ value: String(user.id), label: user.name || user.email || "Coach" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function resetDataSourcesForms() {
  const d = ds();
  d.connectOpen = false;
  d.connectConfirm = null;
  d.connectError = null;
  d.connectDraft = { gpexeTeamId: "", reason: "" };
  d.grantOpen = false;
  d.grantConfirm = null;
  d.grantError = null;
  d.revokeConfirm = null;
  d.revokeError = null;
  d.historyOpen = false;
}

function resetTeamState(teamId) {
  const d = ds();
  d.generation += 1;
  // A write in flight when the team changes never gets to clear its own flag
  // through the generation guard, and a stuck one would disable the screen's
  // primary action for good. It is cleared here, on the context change only:
  // closing a form must NOT unlock a write that is still running.
  d.connectBusy = false;
  d.grantBusy = false;
  d.revokeBusy = false;
  d.teamId = String(teamId || "");
  d.status = null;
  d.history = null;
  d.approvers = null;
  d.error = null;
  d.notice = "";
  d.noticeFor = "";
  resetDataSourcesForms();
}

// The Data sources tab was opened: the team on screen is read again, because
// another admin (or another tab) may have changed its connection or a grant
// since it was last read. Dropping the loaded status is what makes the lazy
// load in app.js run again; it cannot loop, because nothing clears the status
// once that load has filled it.
export function enterDataSourcesSection() {
  ds().status = null;
  // app.js only reads again when nothing is loaded AND nothing failed, so a
  // failed read has to be cleared here as well. The guard itself must keep
  // the error check: without it a failing read would retry forever.
  ds().error = null;
}

export async function selectDataSourcesTeam(teamId, render) {
  if (String(teamId || "") === ds().teamId) return;
  resetTeamState(teamId);
  await loadDataSourcesTeam(render);
}

// Entering the tab. Without a chosen team nothing is loaded: the screen
// asks for one first.
export async function loadDataSources(render) {
  const d = ds();
  const options = dataSourcesTeamOptions();
  if (d.teamId && !options.some((team) => team.value === d.teamId)) resetTeamState("");
  if (!d.teamId) {
    d.loading = false;
    return;
  }
  await loadDataSourcesTeam(render);
}

// A response for a team the admin has since switched away from is dropped
// (generation guard), so an older answer never paints over a newer team.
export async function loadDataSourcesTeam(render) {
  const d = ds();
  if (!d.teamId) return;
  const generation = d.generation;
  const teamId = d.teamId;
  d.loading = true;
  d.error = null;
  render();
  try {
    const [status, history, approvers] = await Promise.all([
      api(teamPath(teamId, "/status")),
      api(teamPath(teamId, "/settings/history")),
      api(teamPath(teamId, "/approvers")),
    ]);
    if (generation !== d.generation) return;
    d.status = status;
    d.history = history.history || [];
    d.approvers = approvers.approvers || [];
  } catch (error) {
    if (generation !== d.generation) return;
    d.error = errorInfo(error);
  } finally {
    if (generation === d.generation) {
      d.loading = false;
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// The GPEXE connection
// ---------------------------------------------------------------------------

// Only called from "Confirm": opening the form or typing sends nothing.
export async function saveGpexeConnection(render) {
  const d = ds();
  const confirm = d.connectConfirm;
  if (!confirm || d.connectBusy) return;
  const generation = d.generation;
  const wasConnected = Boolean(d.status?.settings);
  const sameValue = String(d.status?.settings?.gpexeTeamId || "") === String(confirm.gpexeTeamId);
  d.connectBusy = true;
  d.connectError = null;
  render();
  try {
    const body = { gpexeTeamId: confirm.gpexeTeamId };
    if (confirm.reason) body.reason = confirm.reason;
    await api(teamPath(d.teamId, "/settings"), { method: "PUT", body: JSON.stringify(body) });
    if (generation !== d.generation) return;
    resetDataSourcesForms();
    d.noticeFor = "connect";
    d.notice = sameValue
      ? "Nothing changed: this team was already connected to that GPEXE team."
      : wasConnected
        ? "The GPEXE team is changed."
        : "The team is connected to GPEXE.";
  } catch (error) {
    if (generation !== d.generation) return;
    d.connectError = errorInfo(error);
  } finally {
    d.connectBusy = false;
    if (generation === d.generation) render();
  }
  if (generation === d.generation) await loadDataSourcesTeam(render);
}

// ---------------------------------------------------------------------------
// Who may approve an import
// ---------------------------------------------------------------------------

export async function grantApprover(render) {
  const d = ds();
  const confirm = d.grantConfirm;
  if (!confirm || d.grantBusy) return;
  const generation = d.generation;
  d.grantBusy = true;
  d.grantError = null;
  render();
  try {
    await api(teamPath(d.teamId, "/approvers"), { method: "POST", body: JSON.stringify({ userId: confirm.userId, reason: confirm.reason }) });
    if (generation !== d.generation) return;
    resetDataSourcesForms();
    d.noticeFor = "approvers";
    d.notice = `${confirm.userName} can now approve GPEXE imports for this team.`;
  } catch (error) {
    if (generation !== d.generation) return;
    d.grantError = errorInfo(error);
  } finally {
    d.grantBusy = false;
    if (generation === d.generation) render();
  }
  if (generation === d.generation) await loadDataSourcesTeam(render);
}

export async function revokeApprover(render) {
  const d = ds();
  const confirm = d.revokeConfirm;
  if (!confirm || d.revokeBusy) return;
  const generation = d.generation;
  d.revokeBusy = true;
  d.revokeError = null;
  render();
  try {
    await api(teamPath(d.teamId, `/approvers/${encodeURIComponent(confirm.grantId)}/revoke`), { method: "POST", body: JSON.stringify({ reason: confirm.reason }) });
    if (generation !== d.generation) return;
    resetDataSourcesForms();
    d.noticeFor = "approvers";
    d.notice = `${confirm.userName} can no longer approve GPEXE imports for this team.`;
  } catch (error) {
    if (generation !== d.generation) return;
    d.revokeError = { ...errorInfo(error), scope: "grant" };
  } finally {
    d.revokeBusy = false;
    if (generation === d.generation) render();
  }
  if (generation === d.generation) await loadDataSourcesTeam(render);
}
