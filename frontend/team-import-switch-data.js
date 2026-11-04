// U2 (v56): the import switch of one team, its conditions and the recorded
// prerequisite dates. Data side. Every call goes to the routes of
// backend/src/routes/gpexeImport.js; nothing here decides what may be turned
// on - the database does, again, inside the sanctioned function.
//
// An answer for a team the viewer has since left is dropped (the generation
// of the Imports state), so an older answer never paints over a newer team.
import { api } from "./api.js";
import { state } from "./state.js";

const BASE = "/api/training-load/gpexe";

export const emptyTeamSwitchState = () => ({ data: null, loading: false, busy: false, error: null, notice: "" });

function g() {
  return state.trainingLoad.gpexe;
}

function describe(error) {
  return { status: error?.status ?? 0, code: error?.data?.error || error?.message || "error", message: error?.data?.message || "" };
}

// What a refusal says to the administrator. The server's own sentence is used
// where it is written for this (the conditions); the rest is fixed here.
export function teamSwitchErrorText(info) {
  if (!info) return "";
  if (info.code === "team_import_condition_unmet" && info.message) return `${info.message} Nothing was changed.`;
  if (info.code === "forbidden") return "This needs a platform administrator. Nothing was changed.";
  if (info.code === "try_again") return "The server was busy or another change was running. Nothing was changed; try again in a moment.";
  if (info.code === "invalid_request") return info.message || "Check the values you entered. Nothing was changed.";
  if (info.code === "notFound") return "This team is not available any more. Nothing was changed.";
  if (info.status === 0 || info.status >= 500) return "The answer did not arrive, so the result is not confirmed. The current state was read again below; check it before trying again.";
  return "It could not be done right now. Nothing was changed.";
}

export async function loadTeamImportSwitch(render) {
  const gx = g();
  const ts = gx.teamSwitch;
  if (!gx.teamId) return;
  const generation = gx.generation;
  const teamId = gx.teamId;
  ts.loading = true;
  render();
  try {
    const answer = await api(`${BASE}/teams/${encodeURIComponent(teamId)}/import-switch`);
    if (generation !== gx.generation) return;
    ts.data = answer.importSwitch;
  } catch (error) {
    if (generation !== gx.generation) return;
    // The status line (for everyone) does not depend on this read.
    ts.data = null;
  } finally {
    if (generation === gx.generation) {
      ts.loading = false;
      render();
    }
  }
}

// One change: { enabled, mode?, reason }. The reason is required by the server.
export async function changeTeamImportSwitch({ enabled, mode, reason }, render) {
  const gx = g();
  const ts = gx.teamSwitch;
  if (ts.busy || !gx.teamId) return false;
  const generation = gx.generation;
  const teamId = gx.teamId;
  ts.busy = true;
  ts.error = null;
  ts.notice = "";
  render();
  let ok = false;
  try {
    await api(`${BASE}/teams/${encodeURIComponent(teamId)}/import-switch`, { method: "PUT", body: JSON.stringify({ enabled, ...(mode ? { mode } : {}), reason }) });
    ok = true;
  } catch (error) {
    if (generation === gx.generation) ts.error = describe(error);
  }
  if (generation !== gx.generation) return ok;
  ts.busy = false;
  // Success or not, the state shown is the server's: read it again, and the status line with it.
  try {
    const [sw, status] = await Promise.all([
      api(`${BASE}/teams/${encodeURIComponent(teamId)}/import-switch`),
      api(`${BASE}/teams/${encodeURIComponent(teamId)}/status`),
    ]);
    if (generation !== gx.generation) return ok;
    ts.data = sw.importSwitch;
    gx.status = status;
  } catch {
    // The old state stays; the error above (if any) says what is known.
    if (ok && generation === gx.generation) ts.error = { status: 0, code: "reread_failed", message: "" };
  }
  if (ok && !ts.error) ts.notice = enabled ? "Imports are on for this team." : "Imports are off for this team.";
  render();
  return ok;
}

// A platform administrator records a date (backup, restore probe) or an attestation.
export async function recordImportPrerequisite({ kind, recordedOn, note }, render) {
  const gx = g();
  const ts = gx.teamSwitch;
  if (ts.busy || !gx.teamId) return false;
  const generation = gx.generation;
  ts.busy = true;
  ts.error = null;
  ts.notice = "";
  render();
  let ok = false;
  try {
    await api(`${BASE}/import-prerequisites`, { method: "POST", body: JSON.stringify({ kind, recordedOn, ...(note ? { note } : {}) }) });
    ok = true;
  } catch (error) {
    if (generation === gx.generation) ts.error = describe(error);
  }
  if (generation !== gx.generation) return ok;
  ts.busy = false;
  try {
    const sw = await api(`${BASE}/teams/${encodeURIComponent(gx.teamId)}/import-switch`);
    if (generation === gx.generation) ts.data = sw.importSwitch;
  } catch {
    // The old state stays.
  }
  if (ok && !ts.error) ts.notice = "The date was recorded.";
  render();
  return ok;
}
