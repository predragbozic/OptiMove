// Imports (Training Load -> Data & Analysis): actions of the Imports view.
// Called from handleTrainingLoadAction for every "training-load-gpexe-*"
// action. Controls that only carry a value (the check's dates, the athlete
// chosen for a link) have no data-action; the button that uses them reads
// them when it is pressed.
import { choiceReviewOf, importableAthleteCount, keptLinkPick, leaveOutIds, leaveOutOffered, sessionTypeChoice, stateAthleteIds, useGpexeIds } from "./gpexe-import-view.js";
import { chooseState, chosenStateCount, prepareStateKeys, retryStates, saveImportStates } from "./gpexe-import-states-data.js";
import { state } from "./state.js";
import { groupItems, nextInGroup, reviewMustStay } from "./gpexe-attention-groups.js";
import { fixMustStay, fixWriteInFlight, newFix, noteFixSteps, skipFixAthlete } from "./gpexe-fix-data.js";
import { chooseFixTrack, loadFixTracks, savedChoiceNotShown, sendFixTrack, tracksNeedReading } from "./gpexe-fix-tracks-data.js";
import { handleTeamImportSwitchAction } from "./team-import-switch-actions.js";
import { ensurePeriodData,
  reloadGpexeCandidates,
  refreshGpexeStatus,
  reloadGpexeSourceAthletes,
  approveGpexeCandidate,
  reviewGpexeSubset,
  setGpexeLeaveOut,
  setGpexeUseGpexe,
  loadSessionTypes,
  setGpexeSessionType,
  backFromTeamMappingConfirm,
  batchSelectableList,
  checkBatchAgain,
  clearBatchSelection,
  closeBatchReview,
  finishBatchResults,
  openBatchReview,
  selectBatchVisible,
  sendBatch,
  stopBatchSeries,
  toggleBatchPick,
  chooseTeamMapping,
  closeGpexeCandidate,
  closeTeamMapping,
  confirmTeamMapping,
  finishTeamMappingResults,
  linkGpexeAthlete,
  recomputeGpexeReview,
  loadGpexeTeam,
  openGpexeCandidate,
  openTeamMapping,
  reviewMadeBeforeLinkChange,
  notConfirmedForImport,
  withdrawnByCheck,
  selectGpexeTeam,
  sendTeamMapping,
  startGpexeCheck,
  inboxBucket,
  unlinkGpexeAthlete,
  verifyGpexeApproval,
  cancelIdentityConfirm,
  checkIdentityLoad,
  gpexeAthleteSentence,
  identityBusy,
  identityNameViewer,
  loadGpexeIdentities,
  loadPairSuggestions,
  loadGuidePairs,
  reviewSuggestedPairs,
  openIdentityConfirm,
  sendIdentityLoad,
} from "./gpexe-import-data.js";
import { clearPeriod, periodOf, pickDay, setPeriodOpen, turnMonth } from "./gpexe-period-data.js";
import { takePeriodDragClick } from "./gpexe-period-drag.js";
import { bringBack, clearLaterNotice, isLater, laterOpen, putLater, setLaterOpen } from "./gpexe-later-data.js";

// P4b: a second "Later" within this time of the first is a repeat tap, not a choice.
const LATER_REPEAT_MS = 400;
let laterTappedAt = 0;
export function resetLaterTapForTests() { laterTappedAt = 0; }
import { changeTimezone, checkTimezone, closeTimezone, leaveTimezoneReview, openTimezone, saveTimezone, timezoneBusy, timezoneHeld } from "./gpexe-timezone-data.js";
import { cancelUndo, checkUndo, laterChangeCount, laterRosterWork, manualToRemove, normalizeUndoReason, openUndo, sendUndo, undoBusy, undoLaterProblem, undoManualProblem, undoOffered, undoReasonProblem } from "./gpexe-undo-data.js";
import { cancelVariablesConfirm, loadGuide, openVariablesConfirm, sendVariables, setGuideOpen } from "./gpexe-guide-data.js";

// Names the link being removed (from the loaded link list, or the link just
// made when the list could not be read again); a generic question otherwise.
function unlinkQuestion(gx, linkId) {
  const fromNotice = gx.lastLink && String(gx.lastLink.linkId) === String(linkId) ? { gpexeAthleteId: gx.lastLink.gpexeAthleteId, athleteName: gx.lastLink.athleteName } : null;
  const link = (gx.links || []).find((l) => String(l.id) === String(linkId)) || fromNotice;
  // O5: who to ask by audience (a coach their club administrator, a club admin OptiMove support).
  const viewer = gx.status?.viewer;
  const ask = viewer?.isPlatformAdmin === true ? "contact a platform administrator" : viewer?.identityAdmin === true ? "contact OptiMove support" : "ask your club administrator";
  if (!link?.gpexeAthleteId || !link?.athleteName) {
    return `Unlink this GPEXE athlete? Their next GPEXE sessions will be left out until linked again. Results already imported can't be changed here — ${ask}.`;
  }
  const name = link.athleteName;
  // P2: no viewer sees a GPEXE id outside Technical details; the athlete is named by its list position.
  // The link just made keeps the name the viewer confirmed (a coach's re-read list no longer names a linked athlete).
  const who = fromNotice && gx.lastLink.gpexeSentence ? gx.lastLink.gpexeSentence : gpexeAthleteSentence(link.gpexeAthleteId, gx);
  return `Unlink ${who} from ${name}? In sessions not imported yet, that GPEXE athlete will be left out until linked again. Results already imported stay with ${name}; if they are wrong, they can't be changed here — ${ask}.`;
}

function fieldValue(selector) {
  return globalThis.document?.querySelector?.(selector)?.value || "";
}

// Fix flow: while the sheet is open, the focus stays in it after any of its actions (a repaint replaces its buttons).
export async function handleGpexeImportAction(action, ctx) {
  const handled = await handleGpexeImportActionInner(action, ctx);
  const gx = state.trainingLoad.gpexe;
  if (gx?.detail?.fix) {
    // A link's recompute or a search can bring an athlete on more than one track: the recordings are read for them.
    if (tracksNeedReading(gx.detail, gx)) await loadFixTracks(gx.detail, ctx.renderTrainingLoad);
    if (gx.detail?.fix) noteFixSteps(gx.detail, gx);
    keepFocusInFix();
  }
  return handled;
}

function keepFocusInFix() {
  const doc = globalThis.document;
  const sheet = doc?.querySelector?.(".imports-fix.is-open");
  if (!sheet || sheet.contains?.(doc.activeElement)) return;
  const target = sheet.querySelector?.(".imports-fix-actions .primary-button:not(:disabled)")
    || sheet.querySelector?.(".imports-fix-body select:not(:disabled)")
    || sheet.querySelector?.(".imports-fix-body .primary-button:not(:disabled)")
    || sheet.querySelector?.(".imports-fix-close");
  target?.focus?.({ preventScroll: true });
}

// The Fix sheet closes; the focus goes back to what opened it (its row, else its group's button, else the Needs you tab).
function closeFixSheet(renderTrainingLoad) {
  const gx = state.trainingLoad.gpexe;
  const opener = gx.detail?.fix?.opener || {};
  const refresh = closeGpexeCandidate();
  renderTrainingLoad();
  if (refresh) void reloadGpexeCandidates(renderTrainingLoad);
  const doc = globalThis.document;
  const esc = (v) => (globalThis.CSS?.escape ? CSS.escape(String(v)) : String(v));
  const target = (opener.candidateId && doc?.querySelector?.(`[data-action="training-load-gpexe-fix"][data-candidate-id="${esc(opener.candidateId)}"]`))
    || (opener.group && doc?.querySelector?.(`[data-attention-group="${esc(opener.group)}"] .gpexe-button`))
    || doc?.querySelector?.('[data-action="training-load-gpexe-tab"][data-import-tab="attention"]');
  target?.focus?.({ preventScroll: true });
}

// Escape and the phone's Back (app.js): the sheet closes like ×; true when it was open (handled, also when it stays).
export function closeFixFromKey(renderTrainingLoad) {
  const gx = state.trainingLoad.gpexe;
  if (!gx?.detail?.fix) return false;
  if (fixMustStay(gx)) return true;
  if (fixWriteInFlight(gx) && !globalThis.window?.confirm?.(FIX_LEAVE_QUESTION)) return true;
  closeFixSheet(renderTrainingLoad);
  return true;
}

const FIX_LEAVE_QUESTION = "A change is still on its way. Close anyway? Its result shows in the list when it arrives.";

async function openFix(candidateId, group, groupIds, opener, renderTrainingLoad) {
  const gx = state.trainingLoad.gpexe;
  setPeriodOpen(false);
  gx.helpOpen = false;
  await openGpexeCandidate(candidateId, renderTrainingLoad, { group, groupIds, fix: newFix(opener) });
  const detail = gx.detail;
  if (detail?.id !== candidateId || !detail.fix) return;
  noteFixSteps(detail, gx);
  renderTrainingLoad();
  // Slice 2: an approver reads the recordings of athletes GPEXE recorded on more than one track (the step needs them).
  await loadFixTracks(detail, renderTrainingLoad);
  if (gx.detail === detail) noteFixSteps(detail, gx);
  // The coach reads the GPEXE names of the athletes to link (no GPEXE request): the stored names, as on Link athletes.
  if (identityNameViewer(gx)) void loadGpexeIdentities(renderTrainingLoad);
}

async function handleGpexeImportActionInner(action, { renderTrainingLoad }) {
  const type = action.dataset.action;
  const gx = state.trainingLoad.gpexe;
  if (type.startsWith("training-load-gpexe-switch-")) return handleTeamImportSwitchAction(action, { renderTrainingLoad });

  if (type === "training-load-gpexe-team") {
    // A team change resets the batch state: not while an import is running
    // (the select is disabled; this guards a stale change), and only after
    // a question while sessions are chosen but not imported.
    if (String(action.value) === gx.teamId) return true;
    if (gx.batch.sending || gx.guide?.write?.sending || gx.guide?.write?.unknown || undoBusy(gx) || timezoneHeld(gx)) {
      renderTrainingLoad();
      return true;
    }
    const chosen = Object.keys(gx.batch.selected).length;
    if (chosen && !gx.batch.results && !gx.batch.unknown && !globalThis.window?.confirm?.(`You selected ${chosen} ${chosen === 1 ? "session" : "sessions"} for import but did not import ${chosen === 1 ? "it" : "them"} yet. Change the team anyway? The selection is lost.`)) {
      renderTrainingLoad();
      return true;
    }
    await selectGpexeTeam(action.value, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-refresh-status") {
    // Reads the status again; never starts a search.
    await refreshGpexeStatus(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-check") {
    gx.notice = "";
    // On a computer the calendar sits below the work list (owner, 2026-11-16) while a search's outcome (progress, a refusal)
    // is shown in the banner at the top: a search started from the calendar brings the banner into view (code review). A
    // phone's sheet is open here and closes, which leaves the banner where it is.
    const fromCalendar = Boolean(action.closest?.(".imports-period")) && !periodOf(gx).open;
    // P4: the phone's sheet closes and the chosen days are cleared once a search starts (the month stays), so the
    // chooser next shows what is still missing or what a session needs (code review).
    setPeriodOpen(false);
    clearPeriod();
    // U6a-2: the "Needs a new search" button carries the dates its label names, so the label and the search agree.
    const own = action.dataset.from && action.dataset.to ? { from: action.dataset.from, to: action.dataset.to } : null;
    // Once, on the first render (the search is starting): the same render goes on to the poll and the reads after the search,
    // which run for minutes and must never pull the page back while the person reads the list (code review, HIGH). The
    // progress and a refusal are drawn in that banner, so it is already in view when they come.
    let scrolled = !fromCalendar;
    const renderAndShowOnce = () => {
      renderTrainingLoad();
      if (scrolled) return;
      scrolled = true;
      globalThis.document?.querySelector?.(".imports-banner")?.scrollIntoView?.({ block: "nearest" });
    };
    // P4: the days come with the button (the period chooser's "Search ..." or a step's own dates); none = the server's 14 days.
    await startGpexeCheck(own || {}, renderAndShowOnce);
    return true;
  }
  if (type === "training-load-gpexe-superseded") {
    gx.includeSuperseded = !gx.includeSuperseded;
    await loadGpexeTeam(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-open") {
    clearLaterNotice(gx);
    // U6a-2: a session opened from an attention group (its button or one of its rows) steps through that group.
    // The group's sessions are kept as they are now, so a link that moves the others to "Review out of date" does not end it.
    const group = action.dataset.group || "";
    const groupIds = group ? groupItems(group, gx.candidates || [], gx).map((c) => c.id) : [];
    // P4: a session opened from the phone's sheet opens over the screen, not under the sheet.
    setPeriodOpen(false);
    await openGpexeCandidate(action.dataset.candidateId, renderTrainingLoad, { group, groupIds });
    return true;
  }
  // Fix flow (slice 1): one problem per screen, through the review's own actions.
  if (type === "training-load-gpexe-fix") {
    clearLaterNotice(gx);
    const group = action.dataset.group || "";
    const groupIds = group ? groupItems(group, gx.candidates || [], gx).map((c) => c.id) : [];
    await openFix(action.dataset.candidateId, group, groupIds, { candidateId: action.dataset.candidateId, group }, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-fix-close") {
    closeFixFromKey(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-fix-full") {
    // "See why": the same review, in full.
    if (!gx.detail?.fix || fixMustStay(gx)) return true;
    gx.detail.fix = null;
    renderTrainingLoad();
    globalThis.document?.querySelector?.(".gpexe-detail .builder-athlete-picker-cancel")?.focus?.({ preventScroll: true });
    return true;
  }
  if (type === "training-load-gpexe-fix-skip") {
    const detail = gx.detail;
    if (!detail?.fix || fixMustStay(gx) || gx.linkBusy) return true;
    // On a link step only that GPEXE athlete is skipped; on any other step the session is left for now.
    const id = action.dataset.gpexeAthleteId;
    if (id) {
      gx.linkConfirm = null;
      gx.linkError = null;
      gx.linkOpen = "";
      // "Not now" for this athlete: its pick is not kept for later (code review).
      if (gx.linkPicks) delete gx.linkPicks[id];
      if (detail.fix.trackWrite?.sending || detail.fix.trackWrite?.unknown) return true;
      detail.fix.trackPick = null;
      detail.fix.trackError = null;
      skipFixAthlete(detail, id);
      renderTrainingLoad();
      return true;
    }
    if (fixWriteInFlight(gx) && !globalThis.window?.confirm?.(FIX_LEAVE_QUESTION)) return true;
    const next = detail.group ? nextInGroup(detail, gx.candidates || [], gx) : null;
    if (!next) {
      closeFixSheet(renderTrainingLoad);
      return true;
    }
    const refresh = closeGpexeCandidate();
    await openFix(next.id, detail.group, detail.groupIds, detail.fix.opener, renderTrainingLoad);
    if (refresh) void reloadGpexeCandidates(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-fix-next") {
    const detail = gx.detail;
    if (!detail?.fix || fixMustStay(gx)) return true;
    const next = detail.group ? nextInGroup(detail, gx.candidates || [], gx) : null;
    if (!next || next.id === detail.id) return true;
    const refresh = closeGpexeCandidate();
    await openFix(next.id, detail.group, detail.groupIds, detail.fix.opener, renderTrainingLoad);
    if (refresh) void reloadGpexeCandidates(renderTrainingLoad);
    return true;
  }
  // Slice 2: the recording of an athlete GPEXE recorded on more than one track - a local choice, then Save (one PUT).
  if (type === "training-load-gpexe-fix-track-pick") {
    if (chooseFixTrack(gx.detail, action.dataset.gpexeAthleteId, action.value)) {
      renderTrainingLoad();
      // The repaint replaces the radios: the focus goes back to the one chosen, so the arrow keys keep working (code review).
      const id = `fix-track-${action.dataset.gpexeAthleteId}-${action.value}`;
      globalThis.document?.getElementById?.(id)?.focus?.({ preventScroll: true });
    }
    return true;
  }
  if (type === "training-load-gpexe-fix-track-save") {
    if (!gx.detail?.fix || fixMustStay(gx)) return true;
    await sendFixTrack(gx.detail, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-fix-track-check") {
    // The same request with the same key again: the server answers the saved choice, never a second one.
    if (!gx.detail?.fix) return true;
    await sendFixTrack(gx.detail, renderTrainingLoad, { again: true });
    return true;
  }
  if (type === "training-load-gpexe-fix-tracks-reload") {
    if (!gx.detail?.fix) return true;
    await loadFixTracks(gx.detail, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-fix-accept") {
    // Slice 2: the changes to imported results are accepted here (local); the import sends acceptChanges, as the review does.
    if (!gx.detail?.fix || gx.detail.approving) return true;
    gx.detail.acceptChanges = true;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-fix-search") {
    // d) the session's own day, through the screen's one search (the same request as "Find new sessions").
    const detail = gx.detail;
    const c = detail?.candidate;
    if (!detail?.fix || !c?.sessionStartedAt || detail.fix.searching || gx.checkStarting || gx.check?.status === "running") return true;
    const when = new Date(c.sessionStartedAt);
    if (Number.isNaN(when.getTime())) return true;
    const day = when.toISOString().slice(0, 10);
    detail.fix.searching = true;
    detail.fix.searchError = null;
    gx.notice = "";
    renderTrainingLoad();
    await startGpexeCheck({ from: day, to: day }, renderTrainingLoad);
    if (gx.detail !== detail) return true;
    detail.fix.searching = false;
    if (gx.checkError) {
      detail.fix.searchError = gx.checkError;
    } else if (gx.pollStopped) {
      detail.fix.searchError = { code: "poll_stopped", status: 0, data: null };
    } else if (gx.check?.status !== "succeeded") {
      detail.fix.searchError = { code: "check_failed", status: 0, data: null, message: gx.check?.error?.message || "" };
    } else {
      // The search may have written a newer version of this session: the sheet goes on with it, in the same group.
      const sid = String(c.gpexeTeamSessionId || "");
      const now = (gx.candidates || []).find((x) => sid && String(x.gpexeTeamSessionId || "") === sid && inboxBucket(x, gx) !== "hidden") || null;
      const nextId = now?.id || detail.id;
      const groupIds = (detail.groupIds || []).map((x) => (x === detail.id ? nextId : x));
      await openFix(nextId, detail.group, groupIds, detail.fix.opener, renderTrainingLoad);
      return true;
    }
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-group-next") {
    // U6a-2 (J20 section 8): the next session of the same group, as the list is now. Never while something of this review
    // must still be seen (the same guards as Close).
    const detail = gx.detail;
    if (!detail?.group || reviewMustStay(gx, detail)) return true;
    const next = nextInGroup(detail, gx.candidates || [], gx);
    if (!next || next.id === detail.id) return true;
    const refresh = closeGpexeCandidate();
    if (gx.undo && gx.undo.step !== "unknown") gx.undo = null;
    leaveTimezoneReview(gx);
    await openGpexeCandidate(next.id, renderTrainingLoad, { group: detail.group, groupIds: detail.groupIds });
    if (refresh) void reloadGpexeCandidates(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-close") {
    // While an approval is running its answer must be seen - it may be the
    // only place an uncertain outcome is reported.
    if (gx.detail?.approving || gx.detail?.verifying) return true;
    // U5b: an undo in flight must be seen; a result not confirmed stays for Check the result when the session is reopened.
    if (gx.undo?.step === "sending") return true;
    // PR #587: a time zone save in flight is seen to its end; a result not confirmed stays for Check.
    if (timezoneBusy(gx)) return true;
    const refresh = closeGpexeCandidate();
    if (gx.undo && gx.undo.step !== "unknown") gx.undo = null;
    leaveTimezoneReview(gx);
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
  // J20-B: "Leave out" on a row. Fired by click and by change on the same checkbox: idempotent. A re-render replaces the box, so
  // the focus goes back to the same athlete's checkbox.
  if (type === "training-load-gpexe-leave-out") {
    const id = action.dataset.gpexeAthleteId;
    if (!id || !leaveOutOffered(gx.detail?.candidate, gx.detail, gx.status)) return true;
    if (setGpexeLeaveOut(id, Boolean(action.checked))) {
      renderTrainingLoad();
      const again = globalThis.document?.querySelector?.(`[data-action="training-load-gpexe-leave-out"][data-gpexe-athlete-id="${id}"]`);
      again?.focus?.();
    }
    return true;
  }
  // ST-4: "Use GPEXE's values" for an athlete with values entered or corrected on the roster (unticked: keep them).
  if (type === "training-load-gpexe-use-gpexe") {
    const id = action.dataset.athleteId;
    const listed = (gx.detail?.candidate?.preview?.manualValues?.athletes || []).some((a) => String(a.athleteId) === String(id) && a.replaceAvailable === true);
    if (!id || !listed || gx.status?.viewer?.canApprove !== true) return true;
    if (setGpexeUseGpexe(id, Boolean(action.checked))) {
      renderTrainingLoad();
      globalThis.document?.querySelector?.(`[data-action="training-load-gpexe-use-gpexe"][data-athlete-id="${id}"]`)?.focus?.();
    }
    return true;
  }
  if (type === "training-load-gpexe-subset-review") {
    const candidate = gx.detail?.candidate;
    // Offered like the boxes, or (after an unconfirmed answer) for the set that was sent: the review is how a retry is made.
    const retrying = gx.detail?.outcome?.kind === "unknown" && gx.detail.outcome.verified === "not_visible_yet" && ((gx.detail.leaveOut || []).length > 0 || Boolean(gx.detail.typeChoice) || (gx.detail.useGpexe || []).length > 0);
    const choosing = useGpexeIds(candidate, gx.detail).length > 0 && gx.status?.viewer?.canApprove === true;
    if (!candidate || !(leaveOutOffered(candidate, gx.detail, gx.status) || choosing || (retrying && candidate.status === "pending" && gx.status?.viewer?.canApprove === true))) return true;
    const ids = leaveOutIds(candidate, gx.detail);
    // ST-4: GPEXE's values over roster values are part of the same reviewed choice.
    const replace = useGpexeIds(candidate, gx.detail);
    // ST-5: a chosen session type is a choice to review too, with or without athletes left out.
    if (!ids.length && !replace.length && !sessionTypeChoice(candidate, gx.detail)) return true;
    await reviewGpexeSubset(ids, renderTrainingLoad, replace);
    return true;
  }
  // ST-5: the session type chosen in the review. The choice is reviewed at once (one request, nothing stored) unless athletes
  // are ticked as left out - then the one Review step covers both.
  if (type === "training-load-gpexe-session-type") {
    const candidate = gx.detail?.candidate;
    if (!candidate || !leaveOutOffered(candidate, gx.detail, gx.status)) return true;
    if (!setGpexeSessionType(action.value)) return true;
    renderTrainingLoad();
    globalThis.document?.querySelector?.("[data-gpexe-session-type]")?.focus?.();
    if (sessionTypeChoice(candidate, gx.detail) && !leaveOutIds(candidate, gx.detail).length && !useGpexeIds(candidate, gx.detail).length) await reviewGpexeSubset([], renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-session-types-again") {
    await loadSessionTypes(renderTrainingLoad, { again: true });
    return true;
  }
  if (type === "training-load-gpexe-approve") {
    const candidate = gx.detail?.candidate;
    if (!candidate) return true;
    // J20-B: with athletes left out only the reviewed subset is approved - never the whole session behind their backs.
    const leave = leaveOutIds(candidate, gx.detail);
    const replace = useGpexeIds(candidate, gx.detail);
    // ST-5: so it is with a chosen session type - only the reviewed choice is approved; and a session without a type is
    // never sent without one. ST-4: with GPEXE's values chosen over roster values, too.
    const typeKey = sessionTypeChoice(candidate, gx.detail);
    const reviewed = choiceReviewOf(candidate, gx.detail, leave);
    if ((leave.length || typeKey || replace.length) && reviewed?.status !== "ready") return true;
    if (!typeKey && (candidate.approvalBlockers || []).includes("session_type_required")) return true;
    const changes = candidate.changesToImported || 0;
    if (changes && !gx.detail.acceptChanges) {
      gx.detail.outcome = { kind: "refused", error: { code: "changes_need_acceptance", status: 0, data: null } };
      renderTrainingLoad();
      return true;
    }
    // A review made before a link change is never approved (the button is
    // not offered either); nor is a session the last successful search did
    // not confirm or no longer found (v33) - the server would refuse it too.
    if (reviewMadeBeforeLinkChange(candidate, gx)) return true;
    if (notConfirmedForImport(candidate) || withdrawnByCheck(candidate)) return true;
    const athletes = reviewed ? importableAthleteCount(reviewed.preview) : importableAthleteCount(candidate.preview);
    // J20-C: the attendance states chosen on the rows are saved after the import (their keys are made now, before anything is sent).
    const stateIds = stateAthleteIds(candidate, gx.detail);
    const states = chosenStateCount(gx.detail, stateIds);
    const question = `Import this session for ${athletes} ${athletes === 1 ? "athlete" : "athletes"} under the names shown${leave.length ? `, leaving out ${leave.length} ${leave.length === 1 ? "athlete" : "athletes"}` : ""}${replace.length ? `, with GPEXE's values for ${replace.length} ${replace.length === 1 ? "athlete" : "athletes"} instead of the values entered on the roster` : ""}? This writes their results and the activity.${changes ? ` It also changes ${changes} ${changes === 1 ? "result that was" : "results that were"} already imported.` : ""}${states ? ` Then it saves ${states} ${states === 1 ? "attendance state" : "attendance states"}.` : ""}`;
    if (!globalThis.window?.confirm?.(question)) return true;
    if (states) prepareStateKeys(gx.detail, stateIds);
    await approveGpexeCandidate({ acceptChanges: Boolean(changes && gx.detail.acceptChanges) }, renderTrainingLoad);
    return true;
  }
  // J20-C: an attendance state chosen on a row of the review (kept in the browser until the import).
  if (type === "training-load-gpexe-state") {
    if (chooseState(gx.detail, action.dataset.athleteId, action.value)) renderTrainingLoad();
    return true;
  }
  // J20-C: Check the result repeats the same requests with the same keys; Save them (again) prepares the not sent and refused ones.
  if (type === "training-load-gpexe-states-check" || type === "training-load-gpexe-states-again") {
    const approval = importedApprovalOf(gx.detail);
    if (!approval) return true;
    if (type === "training-load-gpexe-states-again") retryStates(gx.detail);
    await saveImportStates(gx.detail, approval, renderTrainingLoad);
    return true;
  }
  // PR #587: the team's session time zone, from the review of a mixed-time-zones session (the server decides again).
  if (type === "training-load-gpexe-tz-open") {
    await openTimezone(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-tz-change") {
    if (changeTimezone()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-tz-cancel") {
    if (closeTimezone()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-tz-save") {
    await saveTimezone(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-tz-check") {
    await checkTimezone(renderTrainingLoad);
    return true;
  }
  // U5b: undoing an imported session (platform admin; the server decides again).
  if (type === "training-load-gpexe-undo-open") {
    const candidate = gx.detail?.candidate;
    if (!undoOffered(candidate, gx)) return true;
    await openUndo(candidate.id, renderTrainingLoad, { label: candidate.label || "", day: candidate.sessionStartedAt || "" });
    return true;
  }
  if (type === "training-load-gpexe-undo-cancel") {
    if (cancelUndo()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-undo-confirm") {
    const u = gx.undo;
    if (!u || u.step !== "ready") return true;
    const reason = fieldValue("[data-gpexe-undo-reason]");
    // Keep what was typed even when the question is refused locally.
    u.reason = reason;
    // The whole reason is checked BEFORE the question: a destructive question is never asked for an input that is refused anyway.
    const laterBox = globalThis.document?.querySelector?.("[data-gpexe-undo-later-confirm]");
    if (laterBox) u.laterConfirmed = laterBox.checked === true;
    const manualBox = globalThis.document?.querySelector?.("[data-gpexe-undo-manual-confirm]");
    if (manualBox) u.manualConfirmed = manualBox.checked === true;
    const reasonProblem = undoReasonProblem(reason);
    const laterProblem = reasonProblem ? "" : undoLaterProblem(u, u.laterConfirmed);
    const manualProblem = reasonProblem ? "" : undoManualProblem(u, u.manualConfirmed);
    if (reasonProblem || laterProblem || manualProblem) {
      u.reasonProblem = reasonProblem;
      u.laterProblem = laterProblem;
      u.manualProblem = manualProblem;
      renderTrainingLoad();
      return true;
    }
    u.laterProblem = "";
    u.manualProblem = "";
    const label = u.label || gx.detail?.candidate?.label || "this session";
    const later = laterRosterWork(u);
    const manual = manualToRemove(u);
    const versions = Array.isArray(u.preview?.undoneCandidateIds) ? u.preview.undoneCandidateIds.length : 1;
    const changes = laterChangeCount(later);
    const laterText = later ? ` This also removes ${changes === 1 ? "1 later attendance change" : `${changes} later attendance changes`} made in the Roster tab.` : "";
    const manualList = manual && Array.isArray(manual.list) ? manual.list : [];
    const manualAthletes = new Set(manualList.map((i) => i.athleteId).filter(Boolean)).size || manualList.length;
    const manualText = manual
      ? ` This also removes the values coaches entered or corrected${manualAthletes ? ` for ${manualAthletes === 1 ? "1 athlete" : `${manualAthletes} athletes`}` : ""}; importing the session again does not bring them back.`
      : "";
    const question = `Delete the imported data of ${label}${versions > 1 ? `, all ${versions} imports of this session` : ""}? The session leaves the calendar.${laterText}${manualText} Deleted data can't be restored; to get ${manual ? "the imported data" : "it"} back, import the session again from Imports.`;
    u.reasonProblem = "";
    if (!globalThis.window?.confirm?.(question)) return true;
    await sendUndo(normalizeUndoReason(reason), renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-undo-check") {
    await checkUndo(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-verify") {
    await verifyGpexeApproval(renderTrainingLoad);
    return true;
  }
  // Linking is two steps. "Link..." only asks: it shows both sides of the
  // link together and sends nothing; "Confirm link" sends it.
  if (type === "training-load-gpexe-link") {
    if (gx.detail?.updating) return true;
    const gpexeAthleteId = action.dataset.gpexeAthleteId;
    // The pick kept in state (it survives a repaint) while it is still one of the choices; a pick that left them is dropped.
    // The select itself only when no pick is kept.
    const kept = keptLinkPick(gpexeAthleteId);
    if (!kept && gx.linkPicks?.[gpexeAthleteId]) delete gx.linkPicks[gpexeAthleteId];
    const athleteId = kept || fieldValue(`[data-gpexe-link-select='${gpexeAthleteId}']`);
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
  if (type === "training-load-gpexe-review-update") {
    if (gx.detail?.updating || gx.linkBusy) return true;
    const detail = gx.detail;
    // Fix's "a recording is chosen but not shown": after the update the recordings are read again, so a choice cleared
    // elsewhere meanwhile becomes a choice to make, not the same step again (#570 follow-up).
    const applying = Boolean(detail?.fix && savedChoiceNotShown(detail));
    await recomputeGpexeReview(renderTrainingLoad);
    if (applying && gx.detail === detail && !detail.updateError) await loadFixTracks(detail, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-review-filter") {
    gx.reviewFilter = action.dataset.filter || "";
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-link-pick") {
    // The chooser's pick, kept by GPEXE athlete id so a repaint never drops it. Nothing is sent.
    const id = action.dataset.gpexeAthleteId;
    if (!id) return true;
    // The select is reached by a click too (opening it): an unchanged value changes nothing and never repaints, or the repaint
    // would close the list it opens (code review).
    const value = String(action.value || "");
    if ((gx.linkPicks?.[id] || "") === value) return true;
    gx.linkPicks = { ...(gx.linkPicks || {}), [id]: value };
    if (!value) delete gx.linkPicks[id];
    // "Choose the team athlete first" is answered by a pick itself.
    if (value && gx.linkError?.code === "choose_athlete" && String(gx.linkOpen) === String(id)) {
      gx.linkError = null;
      renderTrainingLoad();
    }
    return true;
  }
  if (type === "training-load-gpexe-link-cancel") {
    gx.linkConfirm = null;
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-link-confirm") {
    const pending = gx.linkConfirm;
    if (!pending || gx.linkBusy || gx.detail?.updating) return true;
    await linkGpexeAthlete(pending, renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-unlink") {
    // In the Link athletes screen, not while the list may be out of date or a
    // name load runs or is not confirmed: the button is disabled, this only
    // guards a stale click.
    if (gx.mapping.open && (gx.sourceAthletesError || identityBusy(gx))) return true;
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
    // The stored GPEXE names (no GPEXE request): an administrator's with dates of birth, the team's own coach's of the
    // unlinked athletes only.
    if (identityNameViewer(gx)) await loadGpexeIdentities(renderTrainingLoad);
    // U3: the suggested pairs - for the team's coach and the identity administrators alike (the server decides).
    await loadPairSuggestions(renderTrainingLoad);
    return true;
  }
  // IMP1: a tab of the Imports screen. Local only: nothing is read or sent.
  if (type === "training-load-gpexe-tab") {
    const tab = action.dataset.importTab || "";
    if (["attention", "ready", "imported", "out", "athletes", "search"].includes(tab)) gx.tab = tab;
    renderTrainingLoad();
    return true;
  }
  // U4: the setup guide. Every button here is an existing action or the one "Use OptiMove variables" write.
  if (type === "training-load-gpexe-guide-toggle") {
    setGuideOpen(gx.guide?.open === true ? false : true);
    renderTrainingLoad();
    return true;
  }
  // U6b: open one step of the setup stepper (never while the variables write is running or unconfirmed).
  if (type === "training-load-gpexe-guide-step") {
    const step = Number(action.dataset.step);
    if (gx.guide && !gx.guide.write?.sending && !gx.guide.write?.unknown && !gx.guide.confirm && Number.isInteger(step) && step >= 1 && step <= 5) {
      gx.guide = { ...gx.guide, step };
      renderTrainingLoad();
    }
    return true;
  }
  if (type === "training-load-gpexe-guide-reload") {
    if (gx.guide?.conn?.status !== "loading") await loadGuide(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-guide-vars-open") {
    if (openVariablesConfirm()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-guide-vars-cancel") {
    if (cancelVariablesConfirm()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-guide-vars-close") {
    if (!gx.guide.write?.sending && !gx.guide.write?.unknown) {
      gx.guide = { ...gx.guide, confirm: false, write: null };
      renderTrainingLoad();
    }
    return true;
  }
  if (type === "training-load-gpexe-guide-vars-send") {
    if (!gx.guide.confirm || gx.guide.write?.sending || gx.guide.write?.unknown) return true;
    await sendVariables(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-guide-vars-check") {
    if (!gx.guide.write?.unknown || gx.guide.write?.sending) return true;
    await sendVariables(renderTrainingLoad, { resume: true });
    return true;
  }
  // U3: stage the exact suggested pairs into the ordinary review (one confirmation, then the existing link route, one pair at a time).
  if (type === "training-load-gpexe-map-suggest-all") {
    if (gx.mapping.sending || gx.mapping.confirming || gx.sourceAthletesError || identityBusy(gx) || gx.identity.confirming) return true;
    reviewSuggestedPairs();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-sources-retry") {
    await reloadGpexeSourceAthletes(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-map-close") {
    if (gx.mapping.sending || gx.identity.sending) return true;
    if (gx.identity.unconfirmed && !globalThis.window?.confirm?.("The result of the last name load is not confirmed. Close anyway? Nothing is read from GPEXE again; the result stays unconfirmed, and Check result on Link athletes asks OptiMove what happened.")) return true;
    if (Object.keys(gx.mapping.choices).length && !globalThis.window?.confirm?.("Leave without linking the athletes you chose? Nothing was sent.")) return true;
    closeTeamMapping();
    renderTrainingLoad();
    // U6b: back to the stepper with counts that follow what was linked (names may have been loaded meanwhile).
    await loadGuidePairs(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-map-choose") {
    // Nothing is staged from a list that may be out of date, nor while a name
    // load runs (the select is disabled).
    if (gx.sourceAthletesError || identityBusy(gx)) return true;
    // A click on the select reaches here too: an unchanged value repaints nothing.
    if ((gx.mapping.choices[action.dataset.gpexeAthleteId] || "") === (action.value || "")) return true;
    chooseTeamMapping(action.dataset.gpexeAthleteId, action.value || "");
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-map-confirm") {
    if (identityBusy(gx) || gx.identity.confirming) return true;
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
    if (!gx.mapping.confirming || gx.mapping.sending || identityBusy(gx)) return true;
    await sendTeamMapping(renderTrainingLoad);
    return true;
  }
  // GPEXE names and dates of birth (administrators only): the explicit,
  // read-only load. "Load…" only opens the confirmation; "Load names" sends
  // one request; "Check result" repeats the same request after a lost answer.
  if (type === "training-load-gpexe-identity-open") {
    if (openIdentityConfirm()) {
      renderTrainingLoad();
      // On a phone the list may be scrolled: bring the confirmation (its
      // read-only and 14-day sentences) into view.
      try {
        globalThis.document?.querySelector?.(".gpexe-identity .gpexe-link-confirm")?.scrollIntoView?.({ block: "nearest" });
      } catch {
        // Scrolling is a convenience only.
      }
    }
    return true;
  }
  if (type === "training-load-gpexe-identity-cancel") {
    if (cancelIdentityConfirm()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-identity-send") {
    if (gx.identity.sending || !gx.identity.confirming) return true;
    await sendIdentityLoad(renderTrainingLoad);
    await loadPairSuggestions(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-identity-reload") {
    if (gx.identity.loading || gx.identity.sending) return true;
    await loadGpexeIdentities(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-identity-check") {
    if (gx.identity.sending || !gx.identity.unconfirmed) return true;
    await checkIdentityLoad(renderTrainingLoad);
    await loadPairSuggestions(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-map-done") {
    finishTeamMappingResults();
    renderTrainingLoad();
    await loadPairSuggestions(renderTrainingLoad);
    return true;
  }
  // Batch import (phase 4b). A checkbox fires click, input and change with
  // the same value: the first one changes the selection, the others find
  // nothing to change. Nothing is sent before "Import N sessions".
  if (type === "training-load-gpexe-pick") {
    const id = action.dataset.candidateId;
    const checked = Boolean(action.checked);
    const changed = toggleBatchPick(id, checked);
    // A refused pick (the batch is full, a stale row) leaves the box
    // ticked in the DOM: repaint so it shows the real selection.
    if (changed || checked !== Object.hasOwn(gx.batch.selected, id)) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-select") {
    if (gx.batch.sending) return true;
    // P4b: never a session put aside for later on this device.
    selectBatchVisible(batchSelectableList(gx).filter((c) => !isLater(c, gx)));
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-clear") {
    if (gx.batch.sending) return true;
    clearBatchSelection();
    renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-import-ready") {
    // J19 U1: "Import N ready" = select the clean Ready sessions (the whole
    // list, P4b: but none put aside for later) and open the one
    // review and confirmation; nothing is sent before the confirmation.
    if (gx.batch.sending) return true;
    // P4b: never a session put aside for later on this device.
    selectBatchVisible(batchSelectableList(gx).filter((c) => !isLater(c, gx)));
    if (openBatchReview()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-review") {
    if (openBatchReview()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-back") {
    if (closeBatchReview()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-send") {
    // A second click while the request runs sends nothing (sendBatch
    // refuses it too).
    if (gx.batch.sending || !gx.batch.confirming) return true;
    await sendBatch(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-batch-stop") {
    if (stopBatchSeries()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-check") {
    await checkBatchAgain(renderTrainingLoad);
    return true;
  }
  if (type === "training-load-gpexe-batch-done") {
    if (finishBatchResults()) renderTrainingLoad();
    return true;
  }
  if (type === "training-load-gpexe-batch-open") {
    // The result stays; the review opens over it and it is back on close.
    await openGpexeCandidate(action.dataset.candidateId, renderTrainingLoad);
    return true;
  }
  // P4b, "Later": local only, no request for any of these.
  if (type === "training-load-gpexe-later") {
    // Never while an import is being sent; and a second tap right after the first (the list moves under the thumb) is
    // not a second "Later" (mobile review).
    const now = Date.now();
    if (gx.batch?.sending || now - laterTappedAt < LATER_REPEAT_MS) return true;
    if (putLater(action.dataset.candidateId || "")) {
      laterTappedAt = now;
      renderTrainingLoad();
      const notice = globalThis.document?.querySelector?.(".imports-later-notice button");
      notice?.focus?.({ preventScroll: true });
      notice?.scrollIntoView?.({ block: "nearest" });
    }
    return true;
  }
  if (type === "training-load-gpexe-later-back") {
    const id = action.dataset.candidateId || "";
    if (bringBack(id)) {
      renderTrainingLoad();
      // The session is back in the list: focus its row (reviews: focus is not left on a button that is gone).
      globalThis.document?.querySelector?.(`[data-action="training-load-gpexe-open"][data-candidate-id="${globalThis.CSS?.escape ? CSS.escape(id) : id}"]`)?.focus?.();
    }
    return true;
  }
  if (type === "training-load-gpexe-later-show") {
    setLaterOpen(!laterOpen(gx));
    renderTrainingLoad();
    return true;
  }
  // P4, the period chooser: local only, no request for any of these.
  if (type === "training-load-gpexe-help") {
    // P5: "How importing works" - local only. Focus moves into the dialog and back to the button that opened it.
    gx.helpOpen = !gx.helpOpen;
    if (gx.helpOpen) setPeriodOpen(false);
    renderTrainingLoad();
    globalThis.document?.querySelector?.(gx.helpOpen ? ".imports-help .imports-help-close" : ".imports-help-open")?.focus?.({ preventScroll: true });
    return true;
  }
  if (type === "training-load-gpexe-period-toggle") {
    // The phone's sheet (on a computer the chooser is always on the page). Focus moves into the sheet and back.
    const open = !periodOf(gx).open;
    setPeriodOpen(open);
    // P5: one modal at a time.
    if (open) gx.helpOpen = false;
    renderTrainingLoad();
    globalThis.document?.querySelector?.(open ? ".imports-period .period-close" : ".imports-find-phone")?.focus?.({ preventScroll: true });
    return true;
  }
  if (type === "training-load-gpexe-period-day") {
    if (takePeriodDragClick()) return true;
    const day = action.dataset.day || "";
    if (pickDay(day)) {
      const repaint = () => repaintPeriod(renderTrainingLoad, `[data-action="training-load-gpexe-period-day"][data-day="${day}"]`);
      repaint();
      // #540: older chosen days the list does not hold are read on their own (GET only, only when the list was cut).
      void ensurePeriodData(repaint);
    }
    return true;
  }
  if (type === "training-load-gpexe-period-month") {
    const delta = Number(action.dataset.delta) < 0 ? -1 : 1;
    turnMonth(delta);
    const repaint = () => repaintPeriod(renderTrainingLoad, `.imports-period [data-action="training-load-gpexe-period-month"][data-delta="${delta}"]`);
    repaint();
    // #540: an older month's calendar comes from the server when the list was cut.
    void ensurePeriodData(repaint);
    return true;
  }
  if (type === "training-load-gpexe-period-clear") {
    clearPeriod();
    repaintPeriod(renderTrainingLoad, ".imports-period .period-missing");
    return true;
  }

  return false;
}

// P4: a repaint of the chooser keeps the phone's sheet where it was scrolled (it is its own scroll container, rebuilt
// by every repaint) and puts the focus back on the control just used (mobile-qa).
function repaintPeriod(render, focusSelector) {
  const doc = globalThis.document;
  const top = doc?.querySelector?.(".imports-period.is-open")?.scrollTop;
  render();
  const sheet = doc?.querySelector?.(".imports-period.is-open");
  if (sheet && typeof top === "number") sheet.scrollTop = top;
  doc?.querySelector?.(focusSelector)?.focus?.({ preventScroll: true });
}

// J20-C: the confirmed import of the open review (its approval and activity), or null while it is not confirmed.
function importedApprovalOf(detail) {
  const o = detail?.outcome;
  if (o?.kind === "imported" && o.result?.approval?.id && o.result?.import?.activityId) return { id: o.result.approval.id, activityId: o.result.import.activityId };
  const a = o?.verified === "imported" ? o.approval : detail?.candidate?.status === "imported" ? detail.candidate.approval : null;
  return a?.id && a?.import?.activityId ? { id: a.id, activityId: a.import.activityId } : null;
}
