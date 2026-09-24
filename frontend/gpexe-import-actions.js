// Imports (Training Load -> Data & Analysis): actions of the Imports view.
// Called from handleTrainingLoadAction for every "training-load-gpexe-*"
// action. Controls that only carry a value (the check's dates, the athlete
// chosen for a link) have no data-action; the button that uses them reads
// them when it is pressed.
import { state } from "./state.js";
import {
  reloadGpexeCandidates,
  reloadGpexeSourceAthletes,
  approveGpexeCandidate,
  backFromTeamMappingConfirm,
  chooseTeamMapping,
  closeGpexeCandidate,
  closeTeamMapping,
  confirmTeamMapping,
  finishTeamMappingResults,
  linkGpexeAthlete,
  loadGpexeTeam,
  openGpexeCandidate,
  openTeamMapping,
  reviewMadeBeforeLinkChange,
  selectGpexeTeam,
  sendTeamMapping,
  startGpexeCheck,
  unlinkGpexeAthlete,
  verifyGpexeApproval,
} from "./gpexe-import-data.js";

// Names the link being removed (from the loaded link list, or the link just
// made when the list could not be read again); a generic question otherwise.
function unlinkQuestion(gx, linkId) {
  const fromNotice = gx.lastLink && String(gx.lastLink.linkId) === String(linkId) ? { gpexeAthleteId: gx.lastLink.gpexeAthleteId, athleteName: gx.lastLink.athleteName } : null;
  const link = (gx.links || []).find((l) => String(l.id) === String(linkId)) || fromNotice;
  if (!link?.gpexeAthleteId || !link?.athleteName) {
    return "Unlink this GPEXE athlete? Their next GPEXE sessions will be left out until linked again. Results already imported can't be changed here — contact a platform administrator.";
  }
  const id = link.gpexeAthleteId;
  const name = link.athleteName;
  return `Unlink GPEXE athlete ${id} from ${name}? In sessions not imported yet, athlete ${id} will be left out until linked again. Results already imported stay with ${name}; if they are wrong, they can't be changed here — contact a platform administrator.`;
}

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
    const refresh = closeGpexeCandidate();
    renderTrainingLoad();
    // The session was imported but the list still shows it as pending:
    // read the list again so it moves under Imported.
    if (refresh) void reloadGpexeCandidates(renderTrainingLoad);
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
    // A review made before a link change is never approved (the button is
    // not offered either).
    if (reviewMadeBeforeLinkChange(candidate, gx)) return true;
    const athletes = (candidate.preview?.athletes || []).filter((a) => !a.notImported).length;
    const question = `Import this session for ${athletes} ${athletes === 1 ? "athlete" : "athletes"} under the names shown? This writes their results and the activity.${changes ? ` It also changes ${changes} ${changes === 1 ? "result that was" : "results that were"} already imported.` : ""}`;
    if (!globalThis.window?.confirm?.(question)) return true;
    await approveGpexeCandidate({ acceptChanges: Boolean(changes && gx.detail.acceptChanges) }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-verify") {
    await verifyGpexeApproval(renderTrainingLoad);
    return true;
  }
  // Linking is two steps. "Link..." only asks: it shows both sides of the
  // link together and sends nothing; "Confirm link" sends it.
  if (type === "training-load-gpexe-link") {
    const gpexeAthleteId = action.dataset.gpexeAthleteId;
    const athleteId = fieldValue(`[data-gpexe-link-select='${gpexeAthleteId}']`);
    gx.linkOpen = gpexeAthleteId;
    gx.linkError = null;
    if (!athleteId) {
      gx.linkError = { status: 0, code: "choose_athlete", message: "Choose the team athlete first.", data: null };
      renderTrainingLoad();
      return true;
    }
    const names = gx.detail?.candidate?.athletes || {};
    const athleteName = names[athleteId]?.name || "";
    if (!athleteName) {
      gx.linkError = { status: 0, code: "unknown_athlete", message: "This athlete is not in the review any more. Close it and open it again.", data: null };
      renderTrainingLoad();
      return true;
    }
    // A name shared by two team athletes can't confirm who is meant: no
    // confirmation until they can be told apart.
    const sameName = Object.entries(names).filter(([id, a]) => id !== athleteId && a?.name && a.name.trim().toLowerCase() === athleteName.trim().toLowerCase());
    if (sameName.length) {
      gx.linkError = { status: 0, code: "ambiguous_name", message: `More than one athlete of the team is called ${athleteName}. Give them different names in Settings > Athletes first, then link.`, data: null };
      renderTrainingLoad();
      return true;
    }
    gx.linkConfirm = { gpexeAthleteId, athleteId, athleteName };
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-link-cancel") {
    gx.linkConfirm = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-link-confirm") {
    const pending = gx.linkConfirm;
    if (!pending || gx.linkBusy) return true;
    await linkGpexeAthlete(pending, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-unlink") {
    // In the Link athletes screen, not while the list may be out of date: the
    // button is disabled, this only guards a stale click.
    if (gx.mapping.open && gx.sourceAthletesError) return true;
    if (!globalThis.window?.confirm?.(unlinkQuestion(gx, action.dataset.linkId))) return true;
    await unlinkGpexeAthlete(action.dataset.linkId, renderTrainingLoad);
    return true;
  }
  // Whole-team linking (phase 3b). Choosing only stages (the select carries
  // the action, so a repaint never loses a choice); "Confirm" shows every
  // pair; "Link N athletes" sends them one by one.
  if (type === "training-load-gpexe-map-open") {
    // Not without the list, nor while it may be out of date: the button is
    // disabled, this only guards a stale click.
    if (!gx.sourceAthletes || gx.sourceAthletesError) return true;
    openTeamMapping();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-sources-retry") {
    await reloadGpexeSourceAthletes(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-map-close") {
    if (gx.mapping.sending) return true;
    if (Object.keys(gx.mapping.choices).length && !globalThis.window?.confirm?.("Leave without linking the athletes you chose? Nothing was sent.")) return true;
    closeTeamMapping();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-map-choose") {
    // Nothing is staged from a list that may be out of date (the select is disabled).
    if (gx.sourceAthletesError) return true;
    // A click on the select reaches here too: an unchanged value repaints nothing.
    if ((gx.mapping.choices[action.dataset.gpexeAthleteId] || "") === (action.value || "")) return true;
    chooseTeamMapping(action.dataset.gpexeAthleteId, action.value || "");
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-map-confirm") {
    confirmTeamMapping();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-map-back") {
    backFromTeamMappingConfirm();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-map-send") {
    if (!gx.mapping.confirming || gx.mapping.sending) return true;
    await sendTeamMapping(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-map-done") {
    finishTeamMappingResults();
    renderTrainingLoad();
    return true;
  }
  return false;
}
