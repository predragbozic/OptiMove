// U2 (v56): the actions of the "Imports for this team" panel. Called from
// handleGpexeImportAction for every "training-load-gpexe-switch-*" action.
import { state } from "./state.js";
import { changeTeamImportSwitch, recordImportPrerequisite } from "./team-import-switch-data.js";
import { gpexeTeamOptions } from "./gpexe-import-data.js";

function fieldValue(selector) {
  return globalThis.document?.querySelector?.(selector)?.value || "";
}

function teamName(gx) {
  const team = gpexeTeamOptions().find((t) => String(t.id) === String(gx.teamId));
  return team?.name || "this team";
}

function needReason(gx, render) {
  const reason = fieldValue("[data-gpexe-switch-reason]").trim();
  gx.teamSwitch.draft = reason;
  if (reason) return reason;
  gx.teamSwitch.error = { status: 400, code: "invalid_request", message: "Write a short reason first; it is kept in the history." };
  render();
  return null;
}

export async function handleTeamImportSwitchAction(action, { renderTrainingLoad }) {
  const type = action.dataset.action;
  const gx = state.trainingLoad.gpexe;
  const ts = gx.teamSwitch;
  if (ts.busy) return true;
  if (type === "training-load-gpexe-switch-off") {
    const reason = needReason(gx, renderTrainingLoad);
    if (!reason) return true;
    const who = ts.data?.canChangeMode ? "" : ts.data?.mode === "team" ? "" : " Only a platform administrator can turn them on again.";
    if (!globalThis.window?.confirm?.(`Turn imports off for ${teamName(gx)}? Nobody can approve imports of its sessions until they are turned on again.${who} Sessions already imported stay.`)) return true;
    await changeTeamImportSwitch({ enabled: false, reason }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-switch-on") {
    const reason = needReason(gx, renderTrainingLoad);
    if (!reason) return true;
    const mode = ts.data?.mode === "team" ? "the club administrator and the team's coaches" : "a platform administrator";
    if (!globalThis.window?.confirm?.(`Turn imports on for ${teamName(gx)}? Afterwards ${mode} can approve imports of its GPEXE sessions.`)) return true;
    await changeTeamImportSwitch({ enabled: true, reason }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-switch-mode-team") {
    const reason = needReason(gx, renderTrainingLoad);
    if (!reason) return true;
    if (!globalThis.window?.confirm?.(`Move ${teamName(gx)} to team mode and turn imports on? From then on the club administrator and the team's coaches can approve imports too.`)) return true;
    await changeTeamImportSwitch({ enabled: true, mode: "team", reason }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-switch-mode-pilot") {
    const reason = needReason(gx, renderTrainingLoad);
    if (!reason) return true;
    if (!globalThis.window?.confirm?.(`Move ${teamName(gx)} back to pilot mode? Only a platform administrator can then approve imports.`)) return true;
    await changeTeamImportSwitch({ enabled: ts.data?.enabled === true, mode: "pilot", reason }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-switch-record") {
    const kind = fieldValue("[data-gpexe-switch-kind]");
    const recordedOn = fieldValue("[data-gpexe-switch-date]");
    const note = fieldValue("[data-gpexe-switch-note]").trim();
    if (!kind || !recordedOn) {
      ts.error = { status: 400, code: "invalid_request", message: "Choose what and the date first." };
      renderTrainingLoad();
      return true;
    }
    await recordImportPrerequisite({ kind, recordedOn, note }, renderTrainingLoad);
    return true;
  }
  return false;
}
