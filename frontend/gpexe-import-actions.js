// GPEXE import from the app, phase F3a: actions of the "GPEXE imports" view.
// Called from handleTrainingLoadAction for every "training-load-gpexe-*"
// action. Controls that only carry a value (the check's dates, the athlete
// chosen for a link) have no data-action; the button that uses them reads
// them when it is pressed.
import { state } from "./state.js";
import {
  approveGpexeCandidate,
  closeGpexeCandidate,
  linkGpexeAthlete,
  loadGpexeTeam,
  openGpexeCandidate,
  selectGpexeTeam,
  startGpexeCheck,
  unlinkGpexeAthlete,
  verifyGpexeApproval,
} from "./gpexe-import-data.js";

function fieldValue(selector) {
  return globalThis.document?.querySelector?.(selector)?.value || "";
}

export async function handleGpexeImportAction(action, { renderTrainingLoad }) {
  const type = action.dataset.action;
  const gx = state.trainingLoad.gpexe;

  if (type === "training-load-gpexe-team") {
    await selectGpexeTeam(action.value, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-check") {
    gx.notice = "";
    await startGpexeCheck({ from: fieldValue("[data-gpexe-field='from']"), to: fieldValue("[data-gpexe-field='to']") }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-superseded") {
    gx.includeSuperseded = !gx.includeSuperseded;
    await loadGpexeTeam(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-open") {
    await openGpexeCandidate(action.dataset.candidateId, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-close") {
    // While an approval is running its answer must be seen - it may be the
    // only place an uncertain outcome is reported.
    if (gx.detail?.approving || gx.detail?.verifying) return true;
    closeGpexeCandidate();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-accept") {
    // Fired by both click and change on the same checkbox: idempotent, and
    // no re-render (it would replace the box under the pointer).
    if (gx.detail) gx.detail.acceptChanges = Boolean(action.checked);
    return true;
  }
  if (type === "training-load-gpexe-approve") {
    const candidate = gx.detail?.candidate;
    if (!candidate) return true;
    const changes = candidate.changesToImported || 0;
    if (changes && !gx.detail.acceptChanges) {
      gx.detail.outcome = { kind: "refused", error: { code: "changes_need_acceptance", status: 0, data: null } };
      renderTrainingLoad();
      return true;
    }
    const athletes = (candidate.preview?.athletes || []).filter((a) => !a.notImported).length;
    const question = `Import this session for ${athletes} athlete(s)? This writes their results and the activity.${changes ? ` It also changes ${changes} result(s) that were already imported.` : ""}`;
    if (!globalThis.window?.confirm?.(question)) return true;
    await approveGpexeCandidate({ acceptChanges: Boolean(changes && gx.detail.acceptChanges) }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-verify") {
    await verifyGpexeApproval(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-link") {
    const gpexeAthleteId = action.dataset.gpexeAthleteId;
    const athleteId = fieldValue(`[data-gpexe-link-select='${gpexeAthleteId}']`);
    if (!athleteId) {
      gx.linkError = { status: 0, code: "choose_athlete", message: "Choose the team athlete first.", data: null };
      renderTrainingLoad();
      return true;
    }
    await linkGpexeAthlete({ gpexeAthleteId, athleteId }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-unlink") {
    if (!globalThis.window?.confirm?.("Unlink this GPEXE athlete? Their next GPEXE sessions will be left out until linked again.")) return true;
    await unlinkGpexeAthlete(action.dataset.linkId, renderTrainingLoad);
    return true;
  }
  return false;
}
