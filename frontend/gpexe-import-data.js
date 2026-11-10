// Imports (Training Load -> Data & Analysis), the data side. GPEXE is the
// first data source; every call here goes to its routes. Every call goes to the existing
// F1/F2 routes under /api/training-load/gpexe/teams/:teamId (see
// docs/runbooks/gpexe-in-app-import.md); nothing here decides what may be
// imported - the server does, again, on every request.
//
// A response for a team the coach has since switched away from is dropped
// (generation guard), so an older answer never paints over a newer team.
import { api } from "./api.js";
import { emptyGpexeIdentityState, state } from "./state.js";
import { loadTrainingLoadOrgPickerData } from "./training-load-data.js";
import { emptyTeamSwitchState, loadTeamImportSwitch } from "./team-import-switch-data.js";
import { emptyGuideState, loadGuide } from "./gpexe-guide-data.js";
import { saveImportStates, statesOf } from "./gpexe-import-states-data.js";

const BASE = "/api/training-load/gpexe/teams";
export const CHECK_POLL_MS = 2_000;
// J19 U1: failed polls tolerated in a row before polling stops (the check is never cleared).
export const CHECK_POLL_RETRIES = 3;

function g() {
  return state.trainingLoad.gpexe;
}

function teamPath(teamId, rest = "") {
  return `${BASE}/${encodeURIComponent(teamId)}${rest}`;
}

function errorInfo(error) {
  return { status: error?.status ?? 0, code: error?.data?.error || error?.message || "error", message: error?.data?.message || "", data: error?.data || null };
}

// The teams this view can show: in a team workspace only that team; in a
// club or platform workspace the teams GET /api/organization returns for it.
// The server still answers 404 for a team the caller may not manage.
export function gpexeTeamOptions() {
  const workspace = state.currentUser?.activeWorkspace;
  const teams = state.trainingLoad.orgPickerData?.teams || [];
  if (workspace?.type === "team") return teams.filter((team) => String(team.id) === String(workspace.scopeId));
  return teams;
}

function defaultTeamId() {
  const options = gpexeTeamOptions();
  const workspace = state.currentUser?.activeWorkspace;
  if (workspace?.type === "team" && workspace.scopeId) return String(workspace.scopeId);
  return options.length ? String(options[0].id) : "";
}

// Entering the view: pick the team, then load its status, candidates and
// athlete links together.
export async function loadGpexeImports(render) {
  const gx = g();
  if (!state.trainingLoad.orgPickerData) {
    gx.loading = true;
    render();
    try {
      await loadTrainingLoadOrgPickerData();
    } catch (error) {
      gx.loading = false;
      gx.error = errorInfo(error);
      render();
      return;
    }
  }
  if (!gx.teamId || !gpexeTeamOptions().some((team) => String(team.id) === gx.teamId)) gx.teamId = defaultTeamId();
  await loadGpexeTeam(render);
}

// Athlete links changed here, and this session's review was made before a
// check that started after the change saw it: it was made with the old links
// and must not be approved as it is. Per session, because a check only
// refreshes the sessions inside its dates; both times are the server's.
export function reviewMadeBeforeLinkChange(c, gx = state.trainingLoad.gpexe) {
  if (!gx?.linkSeq) return false;
  // J20-A2: a review recomputed by the server after the last link change is current.
  if (c?.id && gx.recomputedAtLinkSeq?.[c.id] === gx.linkSeq) return false;
  if (!gx.linkCheckStartedAt || !c?.lastSeenAt) return true;
  return new Date(c.lastSeenAt).getTime() < new Date(gx.linkCheckStartedAt).getTime();
}

// Every link change: no check has seen it yet.
function linksChanged() {
  const gx = g();
  gx.linkSeq += 1;
  gx.linkCheckStartedAt = null;
  pruneBatchSelection(gx);
}

export async function selectGpexeTeam(teamId, render) {
  const gx = g();
  if (String(teamId) === gx.teamId) return;
  resetGpexeTeamState(String(teamId));
  await loadGpexeTeam(render);
}

function resetGpexeTeamState(teamId) {
  const gx = g();
  gx.generation += 1;
  gx.batch = emptyBatch();
  gx.calendar = { month: "", day: "", open: null };
  gx.teamId = teamId;
  gx.status = null;
  gx.candidates = null;
  gx.links = null;
  gx.check = null;
  gx.error = null;
  gx.detail = null;
  gx.undo = null;
  gx.notice = "";
  gx.uncertain = {};
  gx.linkConfirm = null;
  gx.lastLink = null;
  gx.linkOpen = "";
  gx.linkSeq = 0;
  gx.recomputedAtLinkSeq = {};
  gx.checkLinkSeq = null;
  gx.linkCheckStartedAt = null;
  gx.sourceAthletes = null;
  gx.sourceAthletesError = null;
  gx.sourceAthletesRetrying = false;
  gx.mapping = emptyMapping();
  identityEpoch += 1;
  gx.identity = emptyGpexeIdentityState();
  clearPairSuggestions();
  gx.extraOrdinals = {};
  gx.teamSwitch = emptyTeamSwitchState();
  gx.guide = { ...emptyGuideState(), open: gx.guide?.open ?? null };
}

function emptyMapping() {
  return { open: false, choices: {}, confirming: false, sending: false, results: null, error: null };
}

function emptyBatch() {
  return { selected: {}, confirming: false, sending: false, checking: false, results: null, summary: null, unknown: null, dropped: "", error: null };
}

export async function loadGpexeTeam(render) {
  const gx = g();
  if (!gx.teamId) {
    gx.loading = false;
    render();
    return;
  }
  const generation = gx.generation;
  const teamId = gx.teamId;
  gx.loading = true;
  gx.error = null;
  render();
  try {
    // The source athletes (the Link athletes screen) are a helper read: a
    // failure there degrades that screen only and never takes the inbox down.
    const sourceAthletesRead = api(teamPath(teamId, "/source-athletes"))
      .then((answer) => ({ athletes: answer.athletes }))
      .catch((error) => ({ error: errorInfo(error) }));
    const [status, candidates, links] = await Promise.all([
      api(teamPath(teamId, "/status")),
      api(teamPath(teamId, `/candidates${gx.includeSuperseded ? "?includeSuperseded=true" : ""}`)),
      api(teamPath(teamId, "/athlete-links")),
    ]);
    if (generation !== gx.generation) return;
    gx.status = status;
    gx.candidates = candidates.candidates;
    gx.links = links.links;
    // The inbox is painted as soon as the mandatory data is here: a slow
    // helper read must not hold it back either.
    gx.loading = false;
    // A status without the identity right (a role revoked meanwhile) drops
    // any name the view still held before anything is painted.
    if (!identityViewer(gx)) {
      clearGpexeIdentities({ keepOutcome: false });
      dropPendingIdentityLoad(teamId);
    } else {
      // The team's own name load whose result is not confirmed comes back
      // with its key (a team or workspace change kept it).
      restorePendingIdentityLoad(gx);
    }
    finishLoad(gx, status, render);
    // U2 (v56): the team's switch panel (administrators); the status line needs no extra read.
    void loadTeamImportSwitch(render);
    // U4: the setup guide's two administrator reads (the connections and the variables).
    void loadGuide(render);
    // An administrator's Imports view also holds the stored GPEXE names (no
    // GPEXE request): every screen of it names athletes without their id.
    if (identityViewer(gx)) void loadGpexeIdentities(render);
    const sourceAthletes = await sourceAthletesRead;
    if (generation !== gx.generation) return;
    applySourceAthletesRead(gx, sourceAthletes);
    render();
    return;
  } catch (error) {
    if (generation !== gx.generation) return;
    gx.error = errorInfo(error);
  } finally {
    // The error path: the try painted nothing yet.
    if (generation === gx.generation && gx.loading) {
      gx.loading = false;
      render();
    }
  }
}

// What follows a successful mandatory load: the check bookkeeping and the
// first paint.
function finishLoad(gx, status, render) {
  forgetConfirmedImports();
  pruneBatchSelection(gx);
  // The server's lastCheck is the truth: a check left while polling (the
  // coach went to another tab) or whose polling failed is taken over from
  // it, and followed again if it is still running.
  const last = status.lastCheck;
  if (last && (!gx.check || gx.check.id === last.id || gx.check.status !== "running")) gx.check = last;
  else if (!last) gx.check = null;
  render();
  if (gx.check?.status === "running") void pollGpexeCheck(render);
}

// A session the list now shows as imported is confirmed: its "result not
// confirmed" mark goes.
function forgetConfirmedImports() {
  const gx = g();
  // A replaced session (a later search found other content) was never
  // imported either: its mark is resolved as well.
  for (const c of gx.candidates || []) if (c.status === "imported" || c.status === "superseded") delete gx.uncertain[c.id];
  // The link notice's "find new sessions" is done once its session's
  // review is current; the link list keeps Unlink.
  const linked = gx.lastLink && (gx.candidates || []).find((c) => c.id === gx.lastLink.candidateId);
  if (linked && !reviewMadeBeforeLinkChange(linked, gx)) gx.lastLink = null;
}

export async function reloadGpexeCandidates(render) {
  const gx = g();
  const generation = gx.generation;
  try {
    const { candidates } = await api(teamPath(gx.teamId, `/candidates${gx.includeSuperseded ? "?includeSuperseded=true" : ""}`));
    if (generation !== gx.generation) return;
    gx.candidates = candidates;
    forgetConfirmedImports();
    pruneBatchSelection(gx);
  } catch (error) {
    if (generation !== gx.generation) return;
    gx.error = errorInfo(error);
  }
  render();
}

// "Find new sessions": starts a background check on the server, then polls it
// until it is no longer running.
export async function startGpexeCheck({ from, to }, render) {
  const gx = g();
  const generation = gx.generation;
  gx.checkError = null;
  gx.pollFailures = 0;
  gx.pollNote = "";
  gx.pollStopped = false;
  gx.checkStarting = true;
  render();
  try {
    const body = {};
    if (from) body.from = from;
    if (to) body.to = to;
    const linkSeq = gx.linkSeq;
    const { check } = await api(teamPath(gx.teamId, "/checks"), { method: "POST", body: JSON.stringify(body) });
    if (generation !== gx.generation) return;
    gx.check = check;
    gx.checkLinkSeq = linkSeq;
  } catch (error) {
    if (generation !== gx.generation) return;
    gx.checkError = errorInfo(error);
  } finally {
    if (generation === gx.generation) {
      gx.checkStarting = false;
      render();
    }
  }
  if (generation === gx.generation && gx.check?.status === "running") await pollGpexeCheck(render);
}

// "Refresh status" (J19 U1): after polling gave up, read the team's status once more. It never
// starts a search; if the search is still running, polling starts again, and if it ended the
// finished state and the sessions are read.
export async function refreshGpexeStatus(render) {
  const gx = g();
  const generation = gx.generation;
  try {
    const status = await api(teamPath(gx.teamId, "/status"));
    if (generation !== gx.generation) return;
    gx.status = status;
    gx.pollFailures = 0;
    gx.pollNote = "";
    gx.pollStopped = false;
    gx.check = status.lastCheck || null;
    if (gx.check && gx.check.status !== "running") {
      render();
      await reloadGpexeCandidates(render);
      return;
    }
  } catch {
    if (generation !== gx.generation) return;
    gx.pollNote = "Progress is no longer refreshing. The search may still be running - do not start another one; use Refresh status.";
    gx.pollStopped = true;
  }
  render();
  if (generation === gx.generation && gx.check?.status === "running") await pollGpexeCheck(render);
}

// Tests replace the wait between polls.
let pollDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function setGpexePollDelayForTests(delay) {
  pollDelay = delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export async function pollGpexeCheck(render) {
  const gx = g();
  const generation = gx.generation;
  const checkId = gx.check?.id;
  if (!checkId || gx.polling === checkId) return;
  gx.polling = checkId;
  // Every (re)start of the loop begins with the full retry allowance and no stale note.
  gx.pollFailures = 0;
  gx.pollNote = "";
  gx.pollStopped = false;
  try {
    while (generation === gx.generation && gx.check?.id === checkId && gx.check.status === "running") {
      await pollDelay(CHECK_POLL_MS);
      if (generation !== gx.generation || state.trainingLoad.section !== "imports") return;
      try {
        const { check } = await api(teamPath(gx.teamId, `/checks/${encodeURIComponent(checkId)}`));
        if (generation !== gx.generation) return;
        gx.check = check;
      } catch (error) {
        if (generation !== gx.generation) return;
        // J19 U1: one failed poll does not make the screen forget a search that
        // may still be running. The last known state stays, the failure is
        // shown as a note, the poll is tried again a bounded number of times,
        // and after that polling stops WITHOUT clearing the check (a reload
        // reads the real state from the server).
        gx.pollFailures = (gx.pollFailures || 0) + 1;
        if (gx.pollFailures > CHECK_POLL_RETRIES) {
          gx.pollNote = "Progress is no longer refreshing. The search may still be running - do not start another one; use Refresh status.";
          gx.pollStopped = true;
          render();
          return;
        }
        gx.pollNote = "Could not refresh the progress. Trying again...";
        render();
        continue;
      }
      gx.pollFailures = 0;
      gx.pollNote = "";
      gx.pollStopped = false;
      render();
    }
    if (generation === gx.generation && gx.check && gx.check.status !== "running") {
      // Reviews made by a check that started after the last link change
      // reflect the links as they are now.
      // A check that started after the last link change: the sessions it saw
      // (lastSeenAt from then on) have reviews made with the current links.
      if (gx.check.status === "succeeded" && gx.linkSeq && gx.checkLinkSeq === gx.linkSeq && !gx.linkCheckStartedAt) gx.linkCheckStartedAt = gx.check.startedAt || null;
      gx.checkLinkSeq = null;
      // The links and the source athletes are read again too: a finished search may have shown new GPEXE athletes, and
      // "Link athletes (N)" and the next step must be right without a reload. A failed read marks the list as possibly
      // out of date (reloadGpexeLinks), like after a link change.
      const [status] = await Promise.all([api(teamPath(gx.teamId, "/status")).catch(() => null), reloadGpexeCandidates(render), reloadGpexeLinks(generation)]);
      if (generation !== gx.generation) return;
      if (status) gx.status = status;
      render();
    }
  } finally {
    if (gx.polling === checkId) gx.polling = "";
  }
}

// ---------------------------------------------------------------------------
// Candidate detail and approval
// ---------------------------------------------------------------------------

export async function openGpexeCandidate(candidateId, render) {
  const gx = g();
  const generation = gx.generation;
  // An approval whose result is still not confirmed is shown again as such.
  const uncertain = gx.uncertain[candidateId] ? { ...gx.uncertain[candidateId] } : null;
  // J20-B: an unconfirmed subset approval keeps the set it was sent with; a reopened review restores it, so the whole session can never be
  // offered (and sent) in its place. The reviewed hash is not kept: the review is made again.
  const keptSet = Array.isArray(uncertain?.chosenExcluded) ? uncertain.chosenExcluded.map(String) : [];
  gx.detail = { id: candidateId, candidate: null, loading: true, error: null, acceptChanges: false, approving: false, outcome: uncertain, leaveOut: keptSet, subset: null };
  gx.linkConfirm = null;
  gx.linkOpen = "";
  gx.notice = "";
  render();
  try {
    const { candidate, participationReasons } = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidateId)}`));
    if (generation !== gx.generation || gx.detail?.id !== candidateId) return;
    gx.detail.candidate = candidate;
    // J20-C: the reasons "Did not participate" takes, for the states chosen before the import.
    gx.detail.participationReasons = Array.isArray(participationReasons) ? participationReasons : [];
    statesOf(gx.detail, gx);
    // J20-A2 follow-up (J20 section 4): U3's suggested pair comes first in a row's chooser.
    if ((candidate?.preview?.athletes || []).some((a) => a.notImported?.code === "athlete_not_linked") && gx.suggestions?.status !== "ready") void loadPairSuggestions(render, { inReview: true });
  } catch (error) {
    if (generation !== gx.generation || gx.detail?.id !== candidateId) return;
    gx.detail.error = errorInfo(error);
  } finally {
    if (generation === gx.generation && gx.detail?.id === candidateId) {
      gx.detail.loading = false;
      render();
    }
  }
}

// Returns true when the list should be read again: the session was imported
// from this review but the list on screen does not show it as imported yet.
export function closeGpexeCandidate() {
  const gx = g();
  // A session imported from this review moves to the collapsed Imported
  // bucket: say so, or its row seems to vanish. The sentence only claims the
  // list shows it when the list really does.
  const d = gx.detail;
  let refresh = false;
  if (d?.outcome?.kind === "imported" || d?.outcome?.verified === "imported" || d?.outcome?.error?.code === "already_imported") {
    const label = (d.candidate?.label || "The session").replace(/\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/, "");
    const row = (gx.candidates || []).find((c) => c.id === d.id);
    if (row?.status === "imported") gx.notice = `${label} is imported - listed under Imported below.`;
    else {
      gx.notice = `${label} is imported. The list is being refreshed.`;
      refresh = true;
    }
  }
  gx.detail = null;
  gx.linkConfirm = null;
  gx.linkOpen = "";
  return refresh;
}

// An unknown outcome is kept for the list and a reopened review until an
// answer or a check confirms the import.
function rememberOutcome(candidateId, outcome) {
  const gx = g();
  if (outcome?.kind === "unknown" && outcome.verified !== "imported") gx.uncertain[candidateId] = { ...outcome };
  else if (outcome?.kind === "imported" || outcome?.verified === "imported" || outcome?.error?.code === "already_imported") delete gx.uncertain[candidateId];
}

// The approval, and what its answer means for the coach. The outcome kinds
// are exactly the server's three states: imported, not imported (a refusal
// before anything was written), and unknown (the COMMIT was not confirmed).
// J20-B: the ticked athletes. A change of the set makes the subset review stale, so it is dropped (the coach reviews again).
export function setGpexeLeaveOut(gpexeAthleteId, checked) {
  const gx = g();
  const detail = gx.detail;
  if (!detail || detail.approving || detail.subset?.status === "loading") return false;
  const id = String(gpexeAthleteId);
  const set = new Set(detail.leaveOut || []);
  if (checked) set.add(id); else set.delete(id);
  const next = [...set].sort((a, b) => Number(a) - Number(b));
  if (next.join(",") === (detail.leaveOut || []).join(",")) return false;
  detail.leaveOut = next;
  detail.subset = null;
  return true;
}

// The deliberate Review step: ONE request that asks the server for the preview without the ticked athletes. It stores nothing
// on the server; the answer is only used by the Import button that follows it.
export async function reviewGpexeSubset(ids, render) {
  const gx = g();
  const detail = gx.detail;
  const candidate = detail?.candidate;
  if (!candidate || detail.approving || detail.subset?.status === "loading" || !ids.length) return;
  const generation = gx.generation;
  const sub = { status: "loading", ids: [...ids] };
  detail.subset = sub;
  render();
  try {
    const answer = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidate.id)}/preview`), { method: "POST", body: JSON.stringify({ excludedAthleteIds: ids }) });
    if (generation !== gx.generation || gx.detail !== detail || detail.subset !== sub) return;
    const s = answer?.subset;
    if (!s || typeof s.subsetHash !== "string" || !s.preview) {
      detail.subset = { status: "error", ids: [...ids], error: { code: "bad_answer" } };
    } else {
      detail.subset = { status: "ready", ids: [...(s.excludedAthleteIds || ids)], subsetHash: s.subsetHash, previewHash: s.previewHash, preview: s.preview };
    }
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail || detail.subset !== sub) return;
    detail.subset = { status: "error", ids: [...ids], error: errorInfo(error) };
  } finally {
    if (generation === gx.generation && gx.detail === detail) render();
  }
}

export async function approveGpexeCandidate({ acceptChanges }, render) {
  const gx = g();
  const detail = gx.detail;
  const candidate = detail?.candidate;
  if (!candidate || detail.approving) return;
  const generation = gx.generation;
  const checks = detail.outcome?.checks || 0;
  // J20-B: a subset approval sends exactly the reviewed set and its hash; nothing else ever carries them.
  const subset = detail.subset?.status === "ready" ? detail.subset : null;
  detail.approving = true;
  detail.verifying = false;
  detail.outcome = null;
  render();
  try {
    const body = { previewHash: candidate.previewHash };
    if (acceptChanges) body.acceptChanges = true;
    if (subset) {
      body.previewHash = subset.previewHash;
      body.excludedAthleteIds = subset.ids;
      body.subsetHash = subset.subsetHash;
    }
    const result = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidate.id)}/approve`), { method: "POST", body: JSON.stringify(body) });
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.outcome = { kind: "imported", result };
    detail.subset = null;
    rememberOutcome(detail.id, detail.outcome);
    if (result.candidate) detail.candidate = result.candidate;
    // J20-C: the import is confirmed; its attendance states follow (a second step, never part of the import).
    if (result.approval?.id && result.import?.activityId) void saveImportStates(detail, { id: result.approval.id, activityId: result.import.activityId }, render);
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    const info = errorInfo(error);
    if (isDefiniteRefusal(info)) {
      detail.outcome = { kind: "refused", error: info };
      // The subset review belongs to a world that moved: it is made again, never reused.
      if (subset) detail.subset = null;
      // The candidate may have moved on (imported by someone else, blocked,
      // expired): show it as it is now, so no stale Approve button remains.
      if (info.code !== "preview_changed") await refreshDetailCandidate(detail, generation);
    } else {
      // A lost answer, a gateway error, a 503: the import may or may not be
      // in the database. Never "nothing was imported".
      detail.outcome = { kind: "unknown", error: info, verify: info.data?.verify || null, checks, chosenExcluded: subset ? [...subset.ids] : [] };
    }
    rememberOutcome(detail.id, detail.outcome);
  } finally {
    if (generation === gx.generation && gx.detail === detail) {
      detail.approving = false;
      render();
    }
  }
  if (generation === gx.generation) void reloadGpexeCandidates(render);
}

// A refusal the server answered for certain, before anything was written:
// a 4xx with a JSON error body, or its own 500 internal_error. Everything
// else (no answer, a gateway error without a JSON body, 503) is unknown.
export function isDefiniteRefusal(info) {
  if (!info?.data || typeof info.data.error !== "string") return false;
  if (info.status >= 400 && info.status < 500) return true;
  return info.status === 500 && info.data.error === "internal_error";
}

async function refreshDetailCandidate(detail, generation) {
  const gx = g();
  try {
    const { candidate } = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(detail.id)}`));
    if (generation === gx.generation && gx.detail === detail) detail.candidate = candidate;
  } catch {
    // The refusal stands on its own; the list reload below shows the rest.
  }
}

// After an unknown outcome: the check the runbook describes. With the
// server's `verify` (503) both the approval and the candidate are read; after
// a lost answer only the candidate can be. Approving again is safe either
// way - the server refuses a second import of the same candidate.
export async function verifyGpexeApproval(render) {
  const gx = g();
  const detail = gx.detail;
  if (detail?.outcome?.kind !== "unknown") return;
  const verify = detail.outcome.verify;
  const candidateId = verify?.candidateId || detail.id;
  const generation = gx.generation;
  detail.verifying = true;
  render();
  try {
    let approval = null;
    if (verify?.approvalId) {
      try {
        approval = (await api(teamPath(gx.teamId, `/approvals/${encodeURIComponent(verify.approvalId)}`))).approval;
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    const { candidate } = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidateId)}`));
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.candidate = candidate;
    const checks = (detail.outcome.checks || 0) + 1;
    const importedBy = approval || candidate.approval;
    if (candidate.status === "imported" && importedBy) {
      detail.outcome = { ...detail.outcome, checks, verified: "imported", approval: importedBy };
      void reloadGpexeCandidates(render);
      // J20-C: only now is the activity known; the states chosen before the import follow.
      if (importedBy.id && importedBy.import?.activityId) void saveImportStates(detail, { id: importedBy.id, activityId: importedBy.import.activityId }, render);
    }
    // Never "not imported" here (owner, F3a external review): a missing
    // approval with a pending candidate - after a 503 or after a lost answer
    // alike - only means the import is not visible yet; the first approval
    // may still be finishing. Only a confirmed import is final.
    else if (!approval && candidate.status === "pending" && !candidate.approval) detail.outcome = { ...detail.outcome, checks, verified: "not_visible_yet" };
    else detail.outcome = { ...detail.outcome, checks, verified: "still_unknown" };
    rememberOutcome(detail.id, detail.outcome);
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.outcome = { ...detail.outcome, checks: (detail.outcome.checks || 0) + 1, verified: "still_unknown", verifyError: errorInfo(error) };
    rememberOutcome(detail.id, detail.outcome);
  } finally {
    if (generation === gx.generation && gx.detail === detail) {
      detail.verifying = false;
      render();
    }
  }
  if (generation === gx.generation) void reloadGpexeCandidates(render);
}

// ---------------------------------------------------------------------------
// Athlete links
// ---------------------------------------------------------------------------

// A successful read replaces the list and clears the error; a failed one
// keeps whatever list there was and records the error, so the way in is
// disabled with a reason until a read succeeds.
function applySourceAthletesRead(gx, read) {
  if (read.error) {
    gx.sourceAthletesError = read.error;
    return;
  }
  gx.sourceAthletes = read.athletes;
  gx.sourceAthletesError = null;
  gx.extraOrdinals = {};
}

// "Try again" on the links panel or in the Link athletes screen: the links
// and the source athletes are read again; the button is busy meanwhile, so
// the click is seen and never doubled. A success clears the error, drops the
// choices the fresh list no longer supports and gives the actions back.
export async function reloadGpexeSourceAthletes(render) {
  const gx = g();
  const generation = gx.generation;
  if (!gx.teamId || gx.sourceAthletesRetrying) return;
  gx.sourceAthletesRetrying = true;
  render();
  await reloadGpexeLinks(generation);
  if (generation !== gx.generation) return;
  gx.sourceAthletesRetrying = false;
  render();
}

// While the list may be out of date (a re-read failed after a change), no
// new link, unlink, review or send is accepted: a just-linked athlete could
// still look "not linked" and be linked again from stale state.
const STALE_LIST_MESSAGE = "The list could not be refreshed after the last change, so it may be out of date. Press Try again first.";

function sourceListStale(gx) {
  return Boolean(gx.sourceAthletesError);
}

// The links and the source athletes change together and are read again
// together. A failed re-read of either leaves the list as it was, marked:
// the error is recorded, so the way in and every new linking action are off
// until a read succeeds (the caller says what happened to the change itself).
async function reloadGpexeLinks(generation) {
  const gx = g();
  const [links, sourceAthletes] = await Promise.all([
    api(teamPath(gx.teamId, "/athlete-links")).then((answer) => ({ links: answer.links })).catch((error) => ({ error: errorInfo(error) })),
    api(teamPath(gx.teamId, "/source-athletes")).then((answer) => ({ athletes: answer.athletes })).catch((error) => ({ error: errorInfo(error) })),
  ]);
  if (generation !== gx.generation) return;
  if (!links.error) gx.links = links.links;
  applySourceAthletesRead(gx, sourceAthletes);
  if (identityViewer(gx)) void loadGpexeIdentities(() => {});
  if (links.error) gx.sourceAthletesError = links.error;
  if (gx.mapping?.open) {
    pruneTeamMappingChoices(gx);
    // The "press Try again first" reason is gone with the fresh list.
    if (!sourceListStale(gx) && gx.mapping.error === STALE_LIST_MESSAGE) gx.mapping = { ...gx.mapping, error: null };
  }
}

// ---------------------------------------------------------------------------
// Whole-team linking ("Link athletes", phase 3b)
// ---------------------------------------------------------------------------

// The team's athletes a GPEXE athlete can be linked to: active members of
// the team (from the organization data the page already has) who are not
// linked yet. Two athletes with the same name are marked: they cannot be
// told apart here, so neither can be chosen.
function teamActiveAthletes(gx) {
  const teamId = String(gx.teamId || "");
  return (state.trainingLoad.orgPickerData?.athletes || []).filter((a) =>
    (a.memberships || []).some((m) => m.membershipType === "team" && String(m.teamId) === teamId && m.status === "active"));
}

export function teamHasActiveAthletes(gx = g()) {
  return teamActiveAthletes(gx).length > 0;
}

export function teamAthleteChoices(gx = g()) {
  const all = teamActiveAthletes(gx);
  const names = new Map();
  for (const a of all) {
    const key = String(a.name || "").trim().toLowerCase();
    names.set(key, (names.get(key) || 0) + 1);
  }
  const linked = new Set((gx.links || []).map((l) => String(l.athleteId)));
  return all
    .filter((a) => !linked.has(String(a.id)))
    .map((a) => ({ id: String(a.id), name: a.name || "Athlete", duplicate: (names.get(String(a.name || "").trim().toLowerCase()) || 0) > 1 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function openTeamMapping() {
  const gx = g();
  gx.mapping = { ...emptyMapping(), open: true };
  clearPairSuggestions();
  gx.linkError = null;
  gx.identity = keepIdentityList(gx.identity);
}

// The stored names stay for the open Imports view. A load's confirmation, its
// result and its error belong to the Link athletes screen and go with it; a
// load in flight, its key and an unconfirmed result stay (identityOutcome), so
// closing never starts over.
function keepIdentityList(identity) {
  const fresh = { ...emptyGpexeIdentityState(), ...identityOutcome(identity) };
  return identity?.available ? { ...fresh, available: true, list: identity.list } : fresh;
}

// The state of a name load of this team (a request in flight, its key, a
// result not confirmed): no name, date or id, so it outlives a clear - a lost
// answer keeps its key for Check result, never a new one.
function identityOutcome(identity) {
  return { sending: Boolean(identity?.sending), requestKey: identity?.requestKey ?? null, unconfirmed: identity?.unconfirmed ?? null };
}

// Leaving the Imports view (or Training Load) drops every GPEXE name and date
// of birth it held; an identity answer still in flight never brings one back.
// A viewer who lost the identity right (keepOutcome false) keeps nothing.
export function clearGpexeIdentities({ keepOutcome = true } = {}) {
  identityEpoch += 1;
  const gx = g();
  if (gx) gx.identity = { ...emptyGpexeIdentityState(), ...(keepOutcome ? identityOutcome(gx.identity) : {}) };
  clearPairSuggestions();
}

// Returns true when the screen had staged choices (the caller asked first).
// The GPEXE names and dates of birth held for the screen go with it.
export function closeTeamMapping() {
  const gx = g();
  const had = Object.keys(gx.mapping.choices).length > 0;
  gx.mapping = emptyMapping();
  clearPairSuggestions();
  gx.identity = keepIdentityList(gx.identity);
  return had;
}

// A choice is only staged; nothing is sent.
// Staged choices that the re-read list no longer supports (the GPEXE
// athlete is not unlinked any more, or the athlete is not linkable any
// more - e.g. another coach linked one of them first) are dropped: the list
// is the truth, and "Review N links" never counts an invisible choice.
export function pruneTeamMappingChoices(gx = g()) {
  const unlinked = new Set((gx.sourceAthletes || []).filter((a) => a.status === "unlinked").map((a) => a.gpexeAthleteId));
  const linkable = new Set(teamAthleteChoices(gx).map((c) => c.id));
  const choices = {};
  for (const [id, athleteId] of Object.entries(gx.mapping.choices || {})) if (unlinked.has(id) && linkable.has(athleteId)) choices[id] = athleteId;
  gx.mapping = { ...gx.mapping, choices };
}

export function chooseTeamMapping(gpexeAthleteId, athleteId) {
  const gx = g();
  const choices = { ...gx.mapping.choices };
  if (athleteId) choices[gpexeAthleteId] = String(athleteId);
  else delete choices[gpexeAthleteId];
  gx.mapping = { ...gx.mapping, choices, error: null, results: null };
}

// The pairs to confirm, checked against the team's roster: every chosen
// athlete must still be linkable, tell-apart-able by name, and chosen once.
// Returns { pairs } or { error } - nothing is sent here.
export function stagedTeamMapping(gx = g()) {
  const choices = gx.mapping.choices || {};
  const ids = Object.keys(choices).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  if (!ids.length) return { error: "Choose at least one athlete first." };
  const byId = new Map(teamAthleteChoices(gx).map((c) => [c.id, c]));
  const pairs = [];
  const seen = new Map();
  for (const gpexeAthleteId of ids) {
    const athleteId = choices[gpexeAthleteId];
    const choice = byId.get(athleteId);
    const label = gpexeAthleteSentence(gpexeAthleteId, gx);
    if (!choice) return { error: `The athlete chosen for ${label} is not linkable any more (already linked, or no longer in the team). Choose again.` };
    if (choice.duplicate) return { error: `More than one athlete of the team is called ${choice.name}. Give them different names in Settings > Athletes first, then link.` };
    if (seen.has(athleteId)) return { error: maskGpexeIds(gx) ? `${choice.name} is chosen for ${gpexeAthleteSentence(seen.get(athleteId), gx)} and ${gpexeAthleteSentence(gpexeAthleteId, gx)}. One athlete can be linked to one GPEXE athlete only.` : `${choice.name} is chosen for GPEXE athletes ${seen.get(athleteId)} and ${gpexeAthleteId}. One athlete can be linked to one GPEXE athlete only.` };
    seen.set(athleteId, gpexeAthleteId);
    pairs.push({ gpexeAthleteId, athleteId, athleteName: choice.name });
  }
  return { pairs };
}

export function confirmTeamMapping() {
  const gx = g();
  if (sourceListStale(gx)) {
    gx.mapping = { ...gx.mapping, error: STALE_LIST_MESSAGE, confirming: false };
    return false;
  }
  const staged = stagedTeamMapping(gx);
  if (staged.error) {
    gx.mapping = { ...gx.mapping, error: staged.error, confirming: false };
    return false;
  }
  gx.mapping = { ...gx.mapping, error: null, confirming: true, results: null };
  return true;
}

export function backFromTeamMappingConfirm() {
  const gx = g();
  gx.mapping = { ...gx.mapping, confirming: false };
}

// Sends the confirmed pairs one by one through the existing link route, and
// keeps one result per pair: linked, refused (a clear answer from the
// server), or unknown (no clear answer - the link may exist). A pair that
// was linked or is unknown leaves the staged choices; a refused one stays,
// so the coach can choose again. Any link made or possibly made marks every
// review on screen as made with the old links.
export async function sendTeamMapping(render) {
  const gx = g();
  const generation = gx.generation;
  if (gx.mapping.sending) return;
  const staged = sourceListStale(gx) ? { error: STALE_LIST_MESSAGE } : stagedTeamMapping(gx);
  if (staged.error) {
    // The choices changed under the sheet (or the list went stale): back to
    // the list, with the reason.
    gx.mapping = { ...gx.mapping, error: staged.error, confirming: false, sending: false };
    render();
    return;
  }
  gx.mapping = { ...gx.mapping, sending: true, error: null };
  gx.linkError = null;
  render();
  const results = [];
  let changed = false;
  for (const pair of staged.pairs) {
    try {
      const answer = await api(teamPath(gx.teamId, "/athlete-links"), { method: "POST", body: JSON.stringify({ gpexeAthleteId: pair.gpexeAthleteId, athleteId: pair.athleteId }) });
      results.push({ ...pair, outcome: "linked", linkId: answer?.link?.id || "" });
      changed = true;
    } catch (error) {
      const info = errorInfo(error);
      if (isDefiniteRefusal(info)) results.push({ ...pair, outcome: "refused", error: info });
      else {
        results.push({ ...pair, outcome: "unknown", error: info });
        changed = true;
      }
    }
    if (generation !== gx.generation) return;
  }
  if (changed) {
    linksChanged();
    gx.lastLink = null;
  }
  if (results.length) {
    // A refusal too: the server's list is the truth about what is linkable.
    await reloadGpexeLinks(generation).catch(() => {});
    if (generation !== gx.generation) return;
  }
  const choices = { ...gx.mapping.choices };
  for (const r of results) if (r.outcome !== "refused") delete choices[r.gpexeAthleteId];
  const linkedCount = results.filter((r) => r.outcome === "linked").length;
  const unknownCount = results.filter((r) => r.outcome === "unknown").length;
  gx.mapping = { ...gx.mapping, choices, confirming: false, sending: false, results };
  pruneTeamMappingChoices(gx);
  const findAgain = "Find new sessions to update the reviews - approving waits until then.";
  const notConfirmed = unknownCount === 1 ? "1 link is not confirmed" : `${unknownCount} links are not confirmed`;
  if (linkedCount && unknownCount) gx.notice = `${linkedCount === 1 ? "1 athlete is" : `${linkedCount} athletes are`} linked; ${notConfirmed} - open Link athletes to check. ${findAgain}`;
  else if (linkedCount) gx.notice = `${linkedCount === 1 ? "1 athlete is" : `${linkedCount} athletes are`} linked. ${findAgain}`;
  else if (unknownCount) gx.notice = `${notConfirmed} (the answer was lost) - open Link athletes to check whether it was made. ${findAgain}`;
  render();
}

export function finishTeamMappingResults() {
  const gx = g();
  gx.mapping = { ...gx.mapping, results: null };
}

// J20-A2 (J20 section 4): after a link, the server recomputes THIS review once
// (one POST, the answer is the new candidate with its new hash). A refusal
// ("try again", 429, a lost answer) leaves the review as it was and offers
// "Update the review"; a find-new-sessions check stays the fallback.
export async function recomputeGpexeReview(render) {
  const gx = g();
  const generation = gx.generation;
  const detail = gx.detail;
  if (!detail?.id || !detail.candidate || detail.updating) return;
  const candidateId = detail.id;
  const seq = gx.linkSeq;
  detail.updating = true;
  detail.updateError = null;
  render();
  try {
    const answer = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidateId)}/preview`), { method: "POST", body: JSON.stringify({}) });
    // The review object this update belongs to: a closed and reopened review is another object.
    if (generation !== gx.generation || gx.detail !== detail) return;
    if (!answer?.candidate) {
      detail.updateError = { status: 200, code: "candidate_read_failed", message: answer?.candidateReadError?.message || "The review was updated; open it again to see it." };
      return;
    }
    detail.candidate = answer.candidate;
    // What the coach ticked was for the old list of changes, and a subset review was for the old preview.
    detail.acceptChanges = false;
    detail.subset = null;
    gx.recomputedAtLinkSeq = { ...(gx.recomputedAtLinkSeq || {}), [candidateId]: seq, ...(answer.candidate.id ? { [answer.candidate.id]: seq } : {}) };
    // The inbox row still holds the old summary and hash: read the list again.
    void reloadGpexeCandidates(render);
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.updateError = errorInfo(error);
  } finally {
    detail.updating = false;
    if (generation === gx.generation && gx.detail === detail) render();
  }
}

// Only called from "Confirm link": choosing an athlete sends nothing.
export async function linkGpexeAthlete({ gpexeAthleteId, athleteId, athleteName }, render) {
  const gx = g();
  const generation = gx.generation;
  gx.linkError = null;
  gx.linkBusy = true;
  render();
  try {
    const answer = await api(teamPath(gx.teamId, "/athlete-links"), { method: "POST", body: JSON.stringify({ gpexeAthleteId, athleteId }) });
    if (generation !== gx.generation) return;
    // Every review on screen was made with the old links from here on.
    linksChanged();
    gx.linkConfirm = null;
    gx.notice = "";
    gx.lastLink = { linkId: answer?.link?.id || "", gpexeAthleteId, athleteId, athleteName, candidateId: gx.detail?.id || "", sessionDate: gx.detail?.candidate?.sessionStartedAt || null };
    // The change is made; a failed re-read of the list only leaves it stale.
    await reloadGpexeLinks(generation).catch(() => {});
    // J20-A2: update the review on screen with one server recompute.
    if (generation === gx.generation && gx.detail?.candidate) {
      gx.linkBusy = false;
      await recomputeGpexeReview(render);
    }
  } catch (error) {
    if (generation === gx.generation) {
      const info = errorInfo(error);
      gx.linkError = info;
      // No clear refusal (a lost answer): the change may have been made, so
      // the reviews on screen are treated as made with the old links.
      if (!isDefiniteRefusal(info)) {
        linksChanged();
        gx.linkConfirm = null;
        gx.linkError = { ...info, message: "We can't tell whether the link was made. Check the list \"GPEXE athletes linked to this team\" on the Imports page, and unlink it there if it is wrong." };
        await reloadGpexeLinks(generation).catch(() => {});
      }
    }
  } finally {
    if (generation === gx.generation) {
      gx.linkBusy = false;
      render();
    }
  }
}

export async function unlinkGpexeAthlete(linkId, render) {
  const gx = g();
  const generation = gx.generation;
  gx.linkError = null;
  gx.linkBusy = true;
  render();
  try {
    await api(teamPath(gx.teamId, `/athlete-links/${encodeURIComponent(linkId)}/unlink`), { method: "POST" });
    if (generation !== gx.generation) return;
    linksChanged();
    if (gx.lastLink?.linkId === linkId) gx.lastLink = null;
    gx.notice = "The link is removed. Find new sessions to update the review.";
    // The change is made; a failed re-read of the list only leaves it stale.
    await reloadGpexeLinks(generation).catch(() => {});
  } catch (error) {
    if (generation === gx.generation) {
      const info = errorInfo(error);
      gx.linkError = info;
      // No clear refusal (a lost answer): the change may have been made, so
      // the reviews on screen are treated as made with the old links.
      if (!isDefiniteRefusal(info)) {
        linksChanged();
        gx.linkError = { ...info, message: "We can't tell whether the link was removed. Check the list \"GPEXE athletes linked to this team\" on the Imports page." };
        await reloadGpexeLinks(generation).catch(() => {});
      }
    }
  } finally {
    if (generation === gx.generation) {
      gx.linkBusy = false;
      render();
    }
  }
}

// ---------------------------------------------------------------------------
// The inbox's rules (shared by the view and the batch selection)
// ---------------------------------------------------------------------------

// Which group a session belongs in, from what the coach actually has to do:
//   decision - it can be reviewed and approved;
//   notyet   - it can't be imported until a step is taken (the step is the
//              same one the detail shows);
//   excluded - it stays out of OptiMove for good (e.g. a match): no action;
//   uptodate / imported / replaced.
// A blocked session's reason comes with the list (blockedCode, phase 2b), so
// the list is sorted without reading any session's detail.
// v33 (PR #153): the server's one word for a candidate the last successful
// search did not confirm - its search is still running or did not succeed,
// or fewer than two of its drills carried data (not_observed), so its drill
// results could not be confirmed. The word is the same for a coach and an
// administrator; it carries no proof or reason.
export function notConfirmedForImport(c) {
  // Fail-closed: a summary without the server's blockers is not "confirmed".
  if (!Array.isArray(c?.approvalBlockers)) return true;
  return c.approvalBlockers.includes("not_confirmed_for_import");
}

// v33: a candidate withdrawn by a complete, successful search that no longer
// found its session in GPEXE (superseded by the search, not by newer content).
export function withdrawnByCheck(c) {
  return c?.status === "superseded" && Boolean(c.supersededByCheckId) && !c.supersededByCandidateId;
}

// A version the list does not show: replaced by newer content, or withdrawn.
export function isHiddenVersion(c, gx = g()) {
  const group = candidateGroup(c, gx);
  return group === "replaced" || group === "withdrawn" || group === "undone";
}

// U5b: an import that was undone stays `imported` on the server (the approval is history) and carries
// importUndoneAt. It is history, never "Imported": its data is no longer in OptiMove.
export function isImportUndone(c) {
  return c?.status === "imported" && Boolean(c.importUndoneAt);
}

export function candidateGroup(c, gx = g()) {
  if (isImportUndone(c)) return "undone";
  if (c.status === "imported") return "imported";
  if (c.status === "superseded") return withdrawnByCheck(c) ? "withdrawn" : "replaced";
  if (!c.snapshot?.available) return "notyet";
  if (c.status === "blocked") return c.blockedCode === "unsupported_session_type" ? "excluded" : "notyet";
  if (c.previewStatus === "no_changes" || c.preview?.status === "no_changes") return "uptodate";
  return "decision";
}

// An approval whose result is not confirmed yet stays marked until a check
// (or a later answer) confirms it - also after the review is closed.
export function isUncertain(c, gx = g()) {
  return Boolean(gx?.uncertain?.[c.id]) && c.status !== "imported";
}

// The list's reasons (one per kind, with a count). A summary without them
// (an answer from before phase 2b) falls back to the counts it does carry.
export function rowReasons(c) {
  if (Array.isArray(c.reasons)) return c.reasons;
  const out = [];
  if (c.counts?.athletesNotImported) out.push({ code: "athletes_left_out", count: c.counts.athletesNotImported });
  if (c.changesToImported) out.push({ code: "changes_to_imported_results", count: c.changesToImported });
  return out;
}

// Which bucket a session is in. Built on candidateGroup (which the review
// still uses) plus the two facts the list already carries: athletes left
// out and changes to imported results.
//   ready     - nothing to decide; importable as found (from its review, or
//               in a batch);
//   attention - the coach has one step to take, named on the row;
//   out       - stays out of OptiMove for good; nothing to do;
//   imported  - in OptiMove, or nothing new for it;
//   hidden    - a replaced version (listed only with the switch under the
//               source's Technical details).
export function inboxBucket(c, gx = g()) {
  const group = candidateGroup(c, gx);
  if (group === "replaced" || group === "withdrawn" || group === "undone") return "hidden";
  if (group === "imported") return "imported";
  if (group === "excluded") return "out";
  if (isUncertain(c, gx)) return "attention";
  if (group === "notyet") return "attention";
  // v33: not confirmed by a successful search - never Ready, never "up to
  // date"; the row says the one step (find new sessions again).
  if (notConfirmedForImport(c)) return "attention";
  // A review made before a link change (owner decision 2026-09-25): the
  // session needs a new search, so it is an attention item on its own - also
  // when that old review said "nothing new", which the new links may change.
  // The other, fresh Ready sessions stay importable.
  if (reviewMadeBeforeLinkChange(c, gx)) return "attention";
  // What keeps a session out of Ready comes with the list (reasons). "Nothing
  // new" is true only when somebody was imported; a session in which no
  // athlete is linked yet writes nothing and must not read as done.
  if (group === "uptodate") return rowReasons(c).length ? "attention" : "imported";
  if (rowReasons(c).length) return "attention";
  return "ready";
}

// ---------------------------------------------------------------------------
// Batch import (Imports phase 4b)
// ---------------------------------------------------------------------------

// The server's own ceiling (BATCH_APPROVE_MAX in gpexeImportService.js).
export const BATCH_MAX = 50;
export const BATCH_REQUEST_BOUND_MS = 90_000;
const PREVIEW_HASH = /^[0-9a-f]{64}$/;

// Whether this coach may import at all right now: the switch is on and
// the server says they may approve. Otherwise the Ready bucket is review
// only, and nothing can be chosen.
export function batchAllowed(gx = g()) {
  const status = gx.status;
  return Boolean(status?.importSwitch?.enabled && status?.viewer?.canApprove);
}

// A session that can go into a batch: a clean Ready one whose review is
// current (no link change since) and whose list row carries the preview
// hash the server binds the import to. Anything else is reviewed one by
// one, or not at all.
export function batchSelectable(c, gx = g()) {
  if (!batchAllowed(gx)) return false;
  if (notConfirmedForImport(c)) return false;
  if (inboxBucket(c, gx) !== "ready") return false;
  if (c.status !== "pending" || reviewMadeBeforeLinkChange(c, gx)) return false;
  return typeof c.previewHash === "string" && PREVIEW_HASH.test(c.previewHash);
}

// Every session that can be chosen, in the order the list shows them.
export function batchSelectableList(gx = g()) {
  return (gx.candidates || []).filter((c) => batchSelectable(c, gx));
}

// The rows the list shows under the local date filter (all of them without one).
export function calendarFiltered(list, gx = g()) {
  const day = gx.calendar?.day;
  if (!day) return list;
  return list.filter((c) => calendarDayKey(c.sessionStartedAt) === day);
}

// The chosen sessions in the list's order, each with the hash chosen with
// it (never a hash read later: a changed session is dropped, not resent).
export function batchSelection(gx = g()) {
  const selected = gx.batch?.selected || {};
  return (gx.candidates || []).filter((c) => Object.hasOwn(selected, c.id)).map((c) => ({ candidateId: c.id, previewHash: selected[c.id], candidate: c }));
}

export function batchSelectedCount(gx = g()) {
  return Object.keys(gx.batch?.selected || {}).length;
}

// Checking a row: staged only, nothing is sent. Refused (false) when the
// session cannot be chosen or the batch is full.
export function toggleBatchPick(candidateId, checked) {
  const gx = g();
  const selected = gx.batch.selected;
  if (!checked) {
    if (!Object.hasOwn(selected, candidateId)) return false;
    delete selected[candidateId];
  } else {
    if (Object.hasOwn(selected, candidateId)) return false;
    const c = (gx.candidates || []).find((x) => x.id === candidateId);
    if (!c || !batchSelectable(c, gx) || batchSelectedCount(gx) >= BATCH_MAX) return false;
    selected[candidateId] = c.previewHash;
  }
  gx.batch.dropped = "";
  gx.batch.error = null;
  return true;
}

// "Select all" / "Select first N": the visible sessions that can be chosen
// (a local date filter never adds a hidden one), in the list's order, until
// the batch is full. Already chosen ones stay chosen.
export function selectBatchVisible(visible) {
  const gx = g();
  let room = BATCH_MAX - batchSelectedCount(gx);
  let added = 0;
  for (const c of visible) {
    if (room <= 0) break;
    if (Object.hasOwn(gx.batch.selected, c.id) || !batchSelectable(c, gx)) continue;
    gx.batch.selected[c.id] = c.previewHash;
    room -= 1;
    added += 1;
  }
  if (added) {
    gx.batch.dropped = "";
    gx.batch.error = null;
  }
  return added;
}

export function clearBatchSelection() {
  const gx = g();
  const had = batchSelectedCount(gx);
  gx.batch.selected = {};
  gx.batch.dropped = "";
  gx.batch.error = null;
  return had;
}

// After a load, a reload or a link change: a chosen session that is no
// longer Ready, or whose preview was recomputed (another hash), leaves the
// selection - with a sentence, never silently. Nothing chosen is ever
// resent with a newer hash.
export function pruneBatchSelection(gx = g()) {
  const selected = gx.batch?.selected;
  if (!selected) return 0;
  const byId = new Map((gx.candidates || []).map((c) => [c.id, c]));
  let dropped = 0;
  for (const [id, hash] of Object.entries(selected)) {
    const c = byId.get(id);
    if (!c || !batchSelectable(c, gx) || c.previewHash !== hash) {
      delete selected[id];
      dropped += 1;
    }
  }
  if (dropped) {
    gx.batch.dropped = `${dropped === 1 ? "1 selected session was" : `${dropped} selected sessions were`} removed from the selection: ${dropped === 1 ? "it" : "they"} changed or ${dropped === 1 ? "is" : "are"} no longer ready. Choose again if needed.`;
    if (!batchSelectedCount(gx)) gx.batch.confirming = false;
  }
  return dropped;
}

export function openBatchReview() {
  const gx = g();
  if (!batchSelectedCount(gx) || gx.batch.sending) return false;
  gx.batch.confirming = true;
  gx.batch.error = null;
  return true;
}

// Back (and closing the confirmation): the selection stays, and so does a
// refusal's reason - shown under the Ready bucket until the next choice.
export function closeBatchReview() {
  const gx = g();
  if (gx.batch.sending) return false;
  gx.batch.confirming = false;
  return true;
}

// One request for the whole selection, in the list's order, each session
// with the hash it was chosen with. The answer is one result per session;
// then the list is read again ONCE, and the selection is checked against it
// (imported and already imported sessions leave it; a refused one stays
// only while it is still Ready with the same hash - a changed one is
// never resent).
export async function sendBatch(render) {
  const gx = g();
  if (gx.batch.sending || !gx.batch.confirming) return;
  const generation = gx.generation;
  const items = batchSelection(gx);
  if (!items.length) {
    gx.batch.confirming = false;
    render();
    return;
  }
  const candidateIds = items.map((i) => i.candidateId);
  const previewHashes = Object.fromEntries(items.map((i) => [i.candidateId, i.previewHash]));
  gx.batch.sending = true;
  gx.batch.error = null;
  gx.batch.results = null;
  gx.batch.summary = null;
  gx.batch.unknown = null;
  render();
  try {
    // J19 U1 (R5): the server's batch time budget is 45 s and one approval adds at most its 15 s COMMIT wait, so the answer arrives
    // before this 90 s client bound, which is below the hosting proxy's 100 s. An aborted request is a lost answer ("Result not
    // confirmed" - Check again), never "nothing was imported".
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(BATCH_REQUEST_BOUND_MS) : undefined;
    const answer = await api(teamPath(gx.teamId, "/imports"), { method: "POST", body: JSON.stringify({ candidateIds, previewHashes }), ...(signal ? { signal } : {}) });
    if (generation !== gx.generation) return;
    const results = Array.isArray(answer?.results) ? answer.results : [];
    gx.batch.results = results;
    gx.batch.summary = answer?.summary || null;
    for (const r of results) {
      // The same marks the single review uses: an unconfirmed result stays
      // marked on the row and in a reopened review until it is confirmed.
      if (r.outcome === "import_outcome_unknown") {
        gx.uncertain[r.candidateId] = { kind: "unknown", error: { status: 503, code: r.code || "import_outcome_unknown", message: "", data: { verify: r.verify || null } }, verify: r.verify || null, checks: 0 };
      } else if (r.outcome === "imported" || r.outcome === "already_imported") delete gx.uncertain[r.candidateId];
      // The server has decided about every session it tried: it leaves the
      // selection here, whatever the reload says (a refused session is only
      // chosen again from the fresh list). A session not tried, or refused
      // because the server failed or was busy (try_again: nothing written),
      // waits for the reload's verdict.
      if (r.outcome !== "not_attempted" && !(r.outcome === "refused" && (r.code === "internal_error" || r.code === "try_again"))) delete gx.batch.selected[r.candidateId];
    }
    gx.batch.confirming = false;
  } catch (error) {
    if (generation !== gx.generation) return;
    const info = errorInfo(error);
    if (isDefiniteRefusal(info)) {
      // The whole request was refused before anything was tried: the
      // confirmation stays open with the reason, Back closes it, and the
      // reason stays under the Ready bucket until the next choice.
      gx.batch.error = info;
    } else {
      // No answer: the sessions may or may not be imported, some or all.
      // Never "failed". Every one is marked as not confirmed; the list is
      // read again once and only what it shows as imported is confirmed.
      gx.batch.unknown = { candidateIds, error: info, checks: 0 };
      for (const id of candidateIds) gx.uncertain[id] = { kind: "unknown", error: info, verify: null, checks: 0 };
      gx.batch.confirming = false;
    }
  } finally {
    if (generation === gx.generation) {
      gx.batch.sending = false;
      render();
    }
  }
  // A refusal because a session is not available any more (404) or the
  // selection is out of date (400) is followed by one reload too, so the
  // stale row leaves the selection with its sentence; the other refusals
  // (the switch, the right) change nothing in the list.
  if (generation !== gx.generation) return;
  if (gx.batch.error && gx.batch.error.status !== 404 && gx.batch.error.status !== 400) return;
  // Once: the list decides what stays selected and which unconfirmed
  // sessions are now shown as imported.
  await reloadGpexeCandidates(render);
}

// "Check again" after a lost answer: the list is read once more; sessions
// it shows as imported are confirmed, the rest stay unconfirmed. No batch
// is ever sent again by itself.
export async function checkBatchAgain(render) {
  const gx = g();
  if (!gx.batch.unknown || gx.batch.checking) return;
  const generation = gx.generation;
  gx.batch.checking = true;
  render();
  await reloadGpexeCandidates(render);
  if (generation !== gx.generation) return;
  gx.batch.unknown = { ...gx.batch.unknown, checks: (gx.batch.unknown.checks || 0) + 1 };
  gx.batch.checking = false;
  render();
}

// The result panel closes; the per-session "not confirmed" marks stay
// (the rows and a reopened review still show them) until confirmed.
export function finishBatchResults() {
  const gx = g();
  if (gx.batch.sending || gx.batch.checking) return false;
  gx.batch.results = null;
  gx.batch.summary = null;
  gx.batch.unknown = null;
  gx.batch.error = null;
  gx.batch.confirming = false;
  return true;
}

// ---------------------------------------------------------------------------
// The local sessions calendar (Imports phase 4b)
// ---------------------------------------------------------------------------

// The day a session belongs to, on the same local clock the row's date and
// time use (never toISOString, which can move a late session to the next
// UTC day). "" when the value is not a date.
export function calendarDayKey(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function calendarMonthKey(value) {
  const key = calendarDayKey(value);
  return key ? key.slice(0, 7) : "";
}

// The month on screen: the one chosen with Prev/Next, else the month of the
// newest session found, else this month.
export function calendarMonthShown(gx = g(), now = new Date()) {
  if (gx.calendar?.month) return gx.calendar.month;
  const days = (gx.candidates || []).filter((c) => !isHiddenVersion(c, gx)).map((c) => calendarDayKey(c.sessionStartedAt)).filter(Boolean).sort();
  if (days.length) return days[days.length - 1].slice(0, 7);
  return calendarMonthKey(now);
}

// Prev/Next: local only, no request.
export function moveCalendarMonth(delta) {
  const gx = g();
  const [y, m] = calendarMonthShown(gx).split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  gx.calendar.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// A marked day filters the list to that day; the same day again, or "Show
// all dates", removes the filter. Never the dates of "Find new sessions".
export function setCalendarDay(day) {
  const gx = g();
  gx.calendar.day = gx.calendar.day === day ? "" : day;
}

export function clearCalendarDay() {
  g().calendar.day = "";
}

// Whether the calendar panel is open: as the coach left it; otherwise open
// on a desktop, folded on a phone (the list is the day's work), and open
// while a day is filtered so the "Show all dates" line is in sight.
export function calendarOpen(gx = g()) {
  const open = gx.calendar?.open;
  if (open === true || open === false) return open;
  if (gx.calendar?.day) return true;
  return !globalThis.window?.matchMedia?.("(max-width: 760px)")?.matches;
}

// The panel was opened or folded (the <details> element's own "toggle"
// event, app.js): its state is kept for the next repaint. Local only - no
// request, no change to the search dates, the shared week or the filtered day.
export function calendarToggled(open) {
  g().calendar.open = Boolean(open);
}

// Leaving the page (reload, close, another site) while an import is running
// or an outcome is not confirmed would lose the only local view of that
// outcome: the browser is asked to warn first. Never while nothing is
// pending. (The server still never imports a session twice.)
export function importsUnloadShouldWarn(gx = g()) {
  // The app's own navigations (sign-out, a switch to or from athlete mode)
  // are deliberate and already done on the server: never asked about.
  if (state.deliberateNavigation) return false;
  if (gx?.batch?.sending || gx?.batch?.unknown) return true;
  // U4: "Use OptiMove variables" in flight, or its last answer not confirmed.
  if (gx?.guide?.write?.sending || gx?.guide?.write?.unknown) return true;
  // U5b: an undo in flight, or its last answer not confirmed.
  if (gx?.undo?.step === "sending" || gx?.undo?.step === "unknown") return true;
  // A mark counts while its session is listed and still unresolved; a mark
  // whose session the list no longer shows (replaced by newer data, hidden)
  // cannot be resolved on this screen and must not block leaving forever.
  const marked = Object.keys(gx?.uncertain || {});
  if (!marked.length) return false;
  return (gx.candidates || []).some((c) => marked.includes(c.id) && c.status !== "imported" && c.status !== "superseded");
}

// ---------------------------------------------------------------------------
// U3: suggested athlete pairs (J19). The team's coach and the two identity
// administrators read three lists from the server - exact pairs (same name,
// same date of birth, one athlete on each side), names that need a choice and
// date-of-birth conflicts. "Review all" only STAGES the exact pairs into the
// ordinary Link athletes review; the links are made by the existing route, one
// pair at a time, after the one confirmation. Nothing is stored in the browser.
// ---------------------------------------------------------------------------
export const SUGGESTION_MAX_PAIRS = 60;
let suggestionEpoch = 0;
let suggestionSeq = 0;

export function clearPairSuggestions() {
  suggestionEpoch += 1;
  const gx = g();
  if (gx) gx.suggestions = { status: "idle", data: null };
}

const str = (v) => (typeof v === "string" ? v : null);
function suggestionData(answer) {
  const person = (x) => ({ gpexeAthleteId: str(x?.gpexeAthleteId) || "", gpexeName: str(x?.gpexeName), birthDate: str(x?.birthDate) });
  return {
    state: answer?.state === "ok" ? "ok" : "no_identities_loaded",
    exact: (Array.isArray(answer?.exact) ? answer.exact : []).map((x) => ({ ...person(x), athleteId: str(x?.athleteId) || "", athleteName: str(x?.athleteName) || "" })).filter((x) => x.gpexeAthleteId && x.athleteId),
    ambiguous: (Array.isArray(answer?.ambiguous) ? answer.ambiguous : []).map((x) => ({ ...person(x), candidates: (Array.isArray(x?.candidates) ? x.candidates : []).map((c) => ({ athleteId: str(c?.athleteId) || "", athleteName: str(c?.athleteName) || "" })) })).filter((x) => x.gpexeAthleteId),
    dateConflicts: (Array.isArray(answer?.dateConflicts) ? answer.dateConflicts : []).map((x) => ({ ...person(x), athleteId: str(x?.athleteId) || "", athleteName: str(x?.athleteName) || "" })).filter((x) => x.gpexeAthleteId),
  };
}

// 404: not available here (no binding, no right) - the screen shows nothing of it.
export async function loadPairSuggestions(render, { inReview = false } = {}) {
  const gx = g();
  // The Link athletes screen asks when it opens; the session review asks when a row needs a link.
  if (!gx.teamId || (!gx.mapping?.open && !inReview)) return;
  const generation = gx.generation;
  const epoch = suggestionEpoch;
  const seq = ++suggestionSeq;
  gx.suggestions = { status: "loading", data: null };
  render();
  try {
    const answer = await identityRequest(teamPath(gx.teamId, "/athlete-pair-suggestions"));
    if (generation !== gx.generation || epoch !== suggestionEpoch || seq !== suggestionSeq) return;
    gx.suggestions = { status: "ready", data: suggestionData(answer) };
  } catch (error) {
    if (generation !== gx.generation || epoch !== suggestionEpoch || seq !== suggestionSeq) return;
    gx.suggestions = { status: errorInfo(error).status === 404 ? "unavailable" : "error", data: null };
  }
  render();
}

// The exact pairs the screen can still stage: the GPEXE athlete is unlinked in
// the list the screen holds and the athlete is linkable now. Nothing else.
export function stageableSuggestedPairs(gx = g()) {
  const data = gx.suggestions?.data;
  if (gx.suggestions?.status !== "ready" || !data) return [];
  const unlinked = new Set((gx.sourceAthletes || []).filter((a) => a.status === "unlinked").map((a) => a.gpexeAthleteId));
  const linkable = new Set(teamAthleteChoices(gx).filter((c) => !c.duplicate).map((c) => c.id));
  return data.exact.filter((p) => unlinked.has(p.gpexeAthleteId) && linkable.has(p.athleteId));
}

// The name and date of birth that justified a staged pair, for the review step
// of a viewer who has no identity list (the team's coach): only the exact pair
// the server suggested, never another athlete's.
export function suggestedIdentity(gpexeAthleteId, athleteId, gx = g()) {
  const data = gx.suggestions?.status === "ready" ? gx.suggestions.data : null;
  const p = data?.exact.find((x) => x.gpexeAthleteId === String(gpexeAthleteId) && x.athleteId === String(athleteId));
  return p ? { name: p.gpexeName, birthDate: p.birthDate } : null;
}

// Stages the ticked exact pairs (at most 60) and opens the ordinary review.
export function reviewSuggestedPairs() {
  const gx = g();
  if (sourceListStale(gx) || identityBusy(gx)) return false;
  const pairs = stageableSuggestedPairs(gx).slice(0, SUGGESTION_MAX_PAIRS);
  if (!pairs.length) return false;
  const choices = { ...gx.mapping.choices };
  for (const p of pairs) choices[p.gpexeAthleteId] = p.athleteId;
  gx.mapping = { ...gx.mapping, choices, error: null, results: null };
  return confirmTeamMapping();
}

// ---------------------------------------------------------------------------
// GPEXE athlete identity (administrators only, v32): the name and date of
// birth of the team's GPEXE athletes on the Link athletes screen.
// ---------------------------------------------------------------------------

// Moved by every clear of the identities (leaving Imports or Training Load, a
// team or workspace change): an identity answer that started before it is
// dropped, so a read in flight never repopulates a cleared view.
let identityEpoch = 0;

// The server's own bound of one load (45 s of network plus its database
// steps) stays below this: a request still open after it is a lost answer.
export const IDENTITY_REQUEST_BOUND_MS = 90_000;

// Only an administrator's status says so; a coach's carries nothing, so a
// coach's screen never asks for an identity at all.
export function identityViewer(gx = g()) {
  return gx.status?.viewer?.identityAdmin === true;
}

// Nothing of an identity answer may be kept by the browser: no HTTP cache
// (the server says no-store too), no storage of any kind — the answer lives
// in gx.identity until the screen closes.
function identityRequest(path, options = {}) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(IDENTITY_REQUEST_BOUND_MS) : undefined;
  return api(path, { ...options, cache: "no-store", ...(signal ? { signal } : {}) });
}

function identityList(answer) {
  const byId = {};
  for (const i of answer.identities || []) byId[String(i.gpexeAthleteId)] = { name: typeof i.name === "string" ? i.name : null, birthDate: typeof i.birthDate === "string" ? i.birthDate : null };
  return {
    byId,
    pendingCount: Number.isInteger(answer.pendingCount) ? answer.pendingCount : 0,
    retryLaterCount: Number.isInteger(answer.retryLaterCount) ? answer.retryLaterCount : 0,
    maxPerLoad: Number.isInteger(answer.maxPerLoad) ? answer.maxPerLoad : 50,
    retentionDays: Number.isInteger(answer.retentionDays) ? answer.retentionDays : 14,
    conflicts: new Set((answer.birthDateConflicts || []).map((c) => `${c.gpexeAthleteId}|${c.athleteId}`)),
  };
}

// The stored identities of the open screen (no GPEXE request). A 404 means
// the identity is not available here (no active binding, no right): the
// screen shows nothing of it, without an error.
export async function loadGpexeIdentities(render) {
  const gx = g();
  if (!identityViewer(gx) || !gx.teamId) return;
  const generation = gx.generation;
  const epoch = identityEpoch;
  const teamId = gx.teamId;
  // The outcome of a load (result / error) stays while the list is read again.
  gx.identity = { ...gx.identity, loading: true, readError: null };
  render();
  try {
    const answer = await identityRequest(teamPath(teamId, "/athlete-identities"));
    if (generation !== gx.generation || epoch !== identityEpoch || !identityViewer(gx)) return;
    gx.identity = { ...gx.identity, available: true, loading: false, list: identityList(answer) };
  } catch (error) {
    if (generation !== gx.generation || epoch !== identityEpoch) return;
    const info = errorInfo(error);
    if (info.status === 404) dropPendingIdentityLoad(teamId);
    gx.identity = info.status === 404 ? { ...emptyGpexeIdentityState(), error: gx.identity.error } : { ...gx.identity, loading: false, readError: info };
  }
  render();
}

// Locked while another change runs: a link or unlink, the Link N athletes
// batch, or its confirmation step. And the other way round (identityBusy).
export function identityLocked(gx = g()) {
  return Boolean(gx.linkBusy || gx.mapping.sending || gx.mapping.confirming || gx.sourceAthletesError);
}
export function identityBusy(gx = g()) {
  return Boolean(gx.identity?.sending || gx.identity?.unconfirmed);
}

export function openIdentityConfirm() {
  const gx = g();
  if (!gx.identity.available || identityBusy(gx) || identityLocked(gx)) return false;
  gx.identity = { ...gx.identity, confirming: true, result: null, error: null };
  return true;
}

export function cancelIdentityConfirm() {
  const gx = g();
  if (gx.identity.sending) return false;
  gx.identity = { ...gx.identity, confirming: false };
  return true;
}

// The counts of a load, never a name, a date or an id.
function identityResult(answer) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { loaded: n(answer.loaded), notFound: n(answer.notFound), notRead: n(answer.notRead), stopped: Boolean(answer.stopCode), unrecognised: Number.isInteger(answer.unrecognisedBirthDates) ? answer.unrecognisedBirthDates : null, replayed: answer.replayed === true };
}

// The unconfirmed name loads of this sign-in, by OptiMove team, in memory
// only (never browser storage): the request key and the Check result count -
// never a name, a date of birth or a GPEXE id. A team or workspace change
// keeps the entry, so Check result back on the same team repeats the same key;
// another team never sees or sends it; nothing is sent by itself; a settled
// load (an answer, a stated refusal, the 404) removes it; sign-out reloads the
// page and clearPendingIdentityLoads() drops them all.
const pendingIdentityLoads = new Map();
function pendingIdentityKey(teamId) {
  return `${state.currentUser?.id || ""}|${teamId}`;
}
function savePendingIdentityLoad(teamId, requestKey, unconfirmed) {
  pendingIdentityLoads.set(pendingIdentityKey(teamId), {
    requestKey,
    unconfirmed: { checks: Number.isInteger(unconfirmed?.checks) ? unconfirmed.checks : 0, running: unconfirmed?.running === true },
  });
}
function dropPendingIdentityLoad(teamId) {
  pendingIdentityLoads.delete(pendingIdentityKey(teamId));
}
export function clearPendingIdentityLoads() {
  pendingIdentityLoads.clear();
}
// A copy for the tests (the entries hold a key and a count only).
export function pendingIdentityLoadsSnapshot() {
  return [...pendingIdentityLoads.entries()].map(([key, value]) => ({ key, ...value, unconfirmed: { ...value.unconfirmed } }));
}
// The open team's own unconfirmed load, if any, back into the view.
function restorePendingIdentityLoad(gx) {
  const saved = pendingIdentityLoads.get(pendingIdentityKey(gx.teamId));
  if (!saved || gx.identity.sending || gx.identity.unconfirmed) return;
  gx.identity = { ...gx.identity, requestKey: saved.requestKey, unconfirmed: { ...saved.unconfirmed } };
}

// One POST with one requestKey: the confirmed load, or Check result (the
// same key again after a lost answer). A double click sends one request; a
// lost answer is never resent by itself.
async function postIdentityLoad(render, { check }) {
  const gx = g();
  if (gx.identity.sending) return;
  if (!check && (!gx.identity.confirming || gx.identity.unconfirmed || identityLocked(gx))) return;
  if (check && !gx.identity.unconfirmed) return;
  const generation = gx.generation;
  const teamId = gx.teamId;
  const requestKey = gx.identity.requestKey || globalThis.crypto.randomUUID();
  const priorChecks = gx.identity.unconfirmed?.checks || 0;
  const priorRunning = gx.identity.unconfirmed?.running === true;
  gx.identity = { ...gx.identity, sending: true, confirming: false, requestKey, error: null, result: null };
  // Until the answer arrives the load is not confirmed: a team change in the
  // meantime keeps its key for this team.
  savePendingIdentityLoad(teamId, requestKey, { checks: priorChecks, running: true });
  render();
  let answer = null;
  let info = null;
  try {
    answer = await identityRequest(teamPath(teamId, "/athlete-identities/loads"), { method: "POST", body: JSON.stringify({ requestKey }) });
  } catch (error) {
    info = errorInfo(error);
  }
  // The outcome, decided once: settled (an answer, a stated refusal, the
  // 404) or not confirmed (the key stays for Check result).
  const checks = priorChecks + (check ? 1 : 0);
  const code = info?.data?.error;
  let outcome;
  if (answer) outcome = { settled: true, fields: { result: identityResult(answer) }, reread: true };
  else if (info.status === 404) outcome = { settled: true, gone: true, fields: { error: info } };
  else if (code === "identity_load_running" && !check && info.data?.replayed !== true) outcome = { settled: true, fields: { error: info } };
  else if (code === "identity_load_running") outcome = { settled: false, unconfirmed: { checks, running: true } };
  // Check result asks about the ORIGINAL load: only the server's saved
  // outcome of that key (a refusal it marks as replayed) settles it. Any
  // other refusal - a busy server's try_again, a busy database, a coded 5xx -
  // says nothing about the original load: it stays not confirmed, key kept.
  // (request_key_reused - the key belongs to another binding or team - can
  // never be answered here, so it settles like any stated refusal.)
  // The refusal itself is shown in the box (its stable status, code and
  // reason only - never a name or an id), and what was known of the load
  // (still running or not) is kept: the refusal says nothing new about it.
  // A refusal the server STATED (a coded 4xx, or a coded 5xx other than
  // outcome_unknown) names its cause in the box. No answer, an abort, an
  // uncoded 5xx or outcome_unknown says nothing about whether the request ran
  // - it may itself have been the load - so it stays not confirmed with no
  // claim at all.
  else if (check && info.data?.replayed !== true && code !== "request_key_reused") {
    const stated = isDefiniteRefusal(info) || (info.status >= 500 && typeof code === "string" && code !== "outcome_unknown");
    const reason = typeof info.data?.reason === "string" && /^[a-z_]{1,64}$/.test(info.data.reason) ? info.data.reason : null;
    outcome = stated
      ? { settled: false, unconfirmed: { checks, running: priorRunning, lastRefusal: { status: Number(info.status) || 0, code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null, reason } } }
      : { settled: false, unconfirmed: { checks, running: false } };
  }
  else if (isDefiniteRefusal(info) || (info.status >= 500 && typeof code === "string" && code !== "outcome_unknown")) {
    outcome = { settled: true, fields: { error: info }, reread: code === "identity_load_abandoned" || code === "source_auth_rejected" };
  } else outcome = { settled: false, unconfirmed: { checks, running: false } };
  if (outcome.settled) dropPendingIdentityLoad(teamId);
  else savePendingIdentityLoad(teamId, requestKey, outcome.unconfirmed);

  // The view to show it in: the one that sent it, or - after a team or
  // workspace change and a return - the view of the same team open now.
  // Another team's view is never touched.
  const view = generation === gx.generation ? gx : g();
  if (!view || view.teamId !== teamId || !identityViewer(view)) return;
  if (view !== gx && view.identity.sending) return;
  // The names are read again only while an Imports view of this team is open
  // now (loadGpexeIdentities takes its own epoch, so a later clear still drops
  // that read).
  const viewOpen = () => identityViewer(view) && view.teamId === teamId && g() === view && state.activeTab === "training-load" && state.trainingLoad?.section === "imports";
  if (outcome.gone) {
    // Not available any more (the binding ended, the right changed): nothing
    // of it stays on screen.
    view.identity = { ...emptyGpexeIdentityState(), error: info };
    render();
    return;
  }
  if (outcome.settled) {
    view.identity = { ...view.identity, sending: false, requestKey: null, unconfirmed: null, ...outcome.fields };
    render();
    if (outcome.reread && viewOpen()) await loadGpexeIdentities(render);
    return;
  }
  view.identity = { ...view.identity, sending: false, requestKey, unconfirmed: outcome.unconfirmed };
  render();
}

export function sendIdentityLoad(render) {
  return postIdentityLoad(render, { check: false });
}

export function checkIdentityLoad(render) {
  return postIdentityLoad(render, { check: true });
}

// Duplicate GPEXE names among the identities on screen (case and spacing
// folded): each gets a warning, none is chosen or hidden for it.
export function duplicateIdentityNames(gx = g()) {
  const counts = new Map();
  for (const i of Object.values(gx.identity?.list?.byId || {})) {
    if (!i.name) continue;
    const key = identityNameKey(i.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
}

export function identityNameKey(name) {
  return String(name || "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

// How a GPEXE athlete is named on every Imports screen of an administrator
// (owner decisions 2026-10-07): the GPEXE id is shown only under Technical
// details.
//   * a valid stored identity: its GPEXE name ("Name not provided" when GPEXE
//     gave none);
//   * the team has stored identities, this athlete none (never loaded,
//     expired, GPEXE had no record): "Name not loaded (GPEXE athlete N)";
//   * no stored identity at all: "GPEXE athlete N".
// N is the athlete's position in the GPEXE athlete list on screen (stable for
// that list, never stored, never the id). A coach - who gets no identity and
// no sign that one exists - keeps the id, as before.
export function gpexeAthleteLabel(gpexeAthleteId, gx = g()) {
  if (!identityViewer(gx)) return `GPEXE athlete ${gpexeAthleteId}`;
  const ordinal = `GPEXE athlete ${gpexeAthleteOrdinal(gpexeAthleteId, gx)}`;
  const who = identityOf(gpexeAthleteId, gx);
  // A GPEXE name shared by two athletes carries the position too.
  if (who?.name) return duplicateIdentityNames(gx).has(identityNameKey(who.name)) ? `${who.name} (${ordinal})` : who.name;
  if (who) return `Name not provided (${ordinal})`;
  return hasStoredIdentities(gx) ? `Name not loaded (${ordinal})` : ordinal;
}

// The same athlete inside a sentence: "the GPEXE athlete <name>", "GPEXE
// athlete N (name not provided)", "GPEXE athlete N (name not loaded)" or
// "GPEXE athlete N" - for a coach "GPEXE athlete <id>", as before.
export function gpexeAthleteSentence(gpexeAthleteId, gx = g()) {
  if (!identityViewer(gx)) return `GPEXE athlete ${gpexeAthleteId}`;
  const ordinal = `GPEXE athlete ${gpexeAthleteOrdinal(gpexeAthleteId, gx)}`;
  const who = identityOf(gpexeAthleteId, gx);
  if (who?.name) return duplicateIdentityNames(gx).has(identityNameKey(who.name)) ? `the GPEXE athlete ${who.name} (${ordinal})` : `the GPEXE athlete ${who.name}`;
  if (who) return `${ordinal} (name not provided)`;
  return hasStoredIdentities(gx) ? `${ordinal} (name not loaded)` : ordinal;
}

// The athlete's position in the team's GPEXE athlete list (the server orders
// it). An athlete the list does not hold yet (found by a check after the list
// was read) gets the next free position, kept in memory until the list is
// read again; never stored, never the id.
export function gpexeAthleteOrdinal(gpexeAthleteId, gx = g()) {
  const list = gx.sourceAthletes || [];
  const index = list.findIndex((a) => String(a.gpexeAthleteId) === String(gpexeAthleteId));
  if (index >= 0) return index + 1;
  if (!gx.extraOrdinals) gx.extraOrdinals = {};
  const key = String(gpexeAthleteId);
  if (!gx.extraOrdinals[key]) gx.extraOrdinals[key] = list.length + Object.keys(gx.extraOrdinals).length + 1;
  return gx.extraOrdinals[key];
}

function hasStoredIdentities(gx) {
  return Object.keys(gx.identity?.list?.byId || {}).length > 0;
}

// True when the screen must not show a GPEXE id outside Technical details.
export function maskGpexeIds(gx = g()) {
  return identityViewer(gx);
}

export function identityOf(gpexeAthleteId, gx = g()) {
  // Never for a viewer without the identity right, whatever the state holds.
  if (!identityViewer(gx)) return null;
  return gx.identity?.list?.byId?.[String(gpexeAthleteId)] || null;
}

// A known GPEXE date of birth that differs from the OptiMove athlete's (the
// server compares; the OptiMove date never reaches the browser).
export function birthDateConflict(gpexeAthleteId, athleteId, gx = g()) {
  return Boolean(athleteId && gx.identity?.list?.conflicts?.has(`${gpexeAthleteId}|${athleteId}`));
}
