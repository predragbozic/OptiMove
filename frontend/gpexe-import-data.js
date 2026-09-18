// GPEXE import from the app, phase F3a: the data side of the "GPEXE imports"
// view in Training Load -> Data & Analysis. Every call goes to the existing
// F1/F2 routes under /api/training-load/gpexe/teams/:teamId (see
// docs/runbooks/gpexe-in-app-import.md); nothing here decides what may be
// imported - the server does, again, on every request.
//
// A response for a team the coach has since switched away from is dropped
// (generation guard), so an older answer never paints over a newer team.
import { api } from "./api.js";
import { state } from "./state.js";
import { loadTrainingLoadOrgPickerData } from "./training-load-data.js";

const BASE = "/api/training-load/gpexe/teams";
export const CHECK_POLL_MS = 2_000;

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

export async function selectGpexeTeam(teamId, render) {
  const gx = g();
  if (String(teamId) === gx.teamId) return;
  resetGpexeTeamState(String(teamId));
  await loadGpexeTeam(render);
}

function resetGpexeTeamState(teamId) {
  const gx = g();
  gx.generation += 1;
  gx.teamId = teamId;
  gx.status = null;
  gx.candidates = null;
  gx.links = null;
  gx.check = null;
  gx.error = null;
  gx.detail = null;
  gx.notice = "";
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
    const [status, candidates, links] = await Promise.all([
      api(teamPath(teamId, "/status")),
      api(teamPath(teamId, `/candidates${gx.includeSuperseded ? "?includeSuperseded=true" : ""}`)),
      api(teamPath(teamId, "/athlete-links")),
    ]);
    if (generation !== gx.generation) return;
    gx.status = status;
    gx.candidates = candidates.candidates;
    gx.links = links.links;
    // The server's lastCheck is the truth: a check left while polling (the
    // coach went to another tab) or whose polling failed is taken over from
    // it, and followed again if it is still running.
    const last = status.lastCheck;
    if (last && (!gx.check || gx.check.id === last.id || gx.check.status !== "running")) gx.check = last;
    else if (!last) gx.check = null;
    if (gx.check?.status === "running") void pollGpexeCheck(render);
  } catch (error) {
    if (generation !== gx.generation) return;
    gx.error = errorInfo(error);
  } finally {
    if (generation === gx.generation) {
      gx.loading = false;
      render();
    }
  }
}

export async function reloadGpexeCandidates(render) {
  const gx = g();
  const generation = gx.generation;
  try {
    const { candidates } = await api(teamPath(gx.teamId, `/candidates${gx.includeSuperseded ? "?includeSuperseded=true" : ""}`));
    if (generation !== gx.generation) return;
    gx.candidates = candidates;
  } catch (error) {
    if (generation !== gx.generation) return;
    gx.error = errorInfo(error);
  }
  render();
}

// "Check for new sessions": starts a background check on the server, then polls it
// until it is no longer running.
export async function startGpexeCheck({ from, to }, render) {
  const gx = g();
  const generation = gx.generation;
  gx.checkError = null;
  gx.checkStarting = true;
  render();
  try {
    const body = {};
    if (from) body.from = from;
    if (to) body.to = to;
    const { check } = await api(teamPath(gx.teamId, "/checks"), { method: "POST", body: JSON.stringify(body) });
    if (generation !== gx.generation) return;
    gx.check = check;
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
        gx.checkError = errorInfo(error);
        // Not known any more: nothing is shown as running (which would keep
        // the check button disabled); the next load takes the state from the server.
        gx.check = null;
        if (gx.status) gx.status.lastCheck = null;
        render();
        return;
      }
      render();
    }
    if (generation === gx.generation && gx.check && gx.check.status !== "running") {
      const [status] = await Promise.all([api(teamPath(gx.teamId, "/status")).catch(() => null), reloadGpexeCandidates(() => {})]);
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
  gx.detail = { id: candidateId, candidate: null, loading: true, error: null, acceptChanges: false, approving: false, outcome: null };
  render();
  try {
    const { candidate } = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidateId)}`));
    if (generation !== gx.generation || gx.detail?.id !== candidateId) return;
    gx.detail.candidate = candidate;
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

export function closeGpexeCandidate() {
  g().detail = null;
}

// The approval, and what its answer means for the coach. The outcome kinds
// are exactly the server's three states: imported, not imported (a refusal
// before anything was written), and unknown (the COMMIT was not confirmed).
export async function approveGpexeCandidate({ acceptChanges }, render) {
  const gx = g();
  const detail = gx.detail;
  const candidate = detail?.candidate;
  if (!candidate || detail.approving) return;
  const generation = gx.generation;
  detail.approving = true;
  detail.verifying = false;
  detail.outcome = null;
  render();
  try {
    const body = { previewHash: candidate.previewHash };
    if (acceptChanges) body.acceptChanges = true;
    const result = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(candidate.id)}/approve`), { method: "POST", body: JSON.stringify(body) });
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.outcome = { kind: "imported", result };
    if (result.candidate) detail.candidate = result.candidate;
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    const info = errorInfo(error);
    if (isDefiniteRefusal(info)) {
      detail.outcome = { kind: "refused", error: info };
      // The candidate may have moved on (imported by someone else, blocked,
      // expired): show it as it is now, so no stale Approve button remains.
      if (info.code !== "preview_changed") await refreshDetailCandidate(detail, generation);
    } else {
      // A lost answer, a gateway error, a 503: the import may or may not be
      // in the database. Never "nothing was imported".
      detail.outcome = { kind: "unknown", error: info, verify: info.data?.verify || null };
    }
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
    const importedBy = approval || candidate.approval;
    if (candidate.status === "imported" && importedBy) detail.outcome = { ...detail.outcome, verified: "imported", approval: importedBy };
    // Never "not imported" here (owner, F3a external review): a missing
    // approval with a pending candidate - after a 503 or after a lost answer
    // alike - only means the import is not visible yet; the first approval
    // may still be finishing. Only a confirmed import is final.
    else if (!approval && candidate.status === "pending" && !candidate.approval) detail.outcome = { ...detail.outcome, verified: "not_visible_yet" };
    else detail.outcome = { ...detail.outcome, verified: "still_unknown" };
  } catch (error) {
    if (generation !== gx.generation || gx.detail !== detail) return;
    detail.outcome = { ...detail.outcome, verified: "still_unknown", verifyError: errorInfo(error) };
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

async function reloadGpexeLinks(generation) {
  const gx = g();
  const { links } = await api(teamPath(gx.teamId, "/athlete-links"));
  if (generation === gx.generation) gx.links = links;
}

export async function linkGpexeAthlete({ gpexeAthleteId, athleteId }, render) {
  const gx = g();
  const generation = gx.generation;
  gx.linkError = null;
  gx.linkBusy = true;
  render();
  try {
    await api(teamPath(gx.teamId, "/athlete-links"), { method: "POST", body: JSON.stringify({ gpexeAthleteId, athleteId }) });
    await reloadGpexeLinks(generation);
    if (generation === gx.generation) gx.notice = `GPEXE athlete ${gpexeAthleteId} is linked. Check for new sessions to see it in the review.`;
  } catch (error) {
    if (generation === gx.generation) gx.linkError = errorInfo(error);
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
    await reloadGpexeLinks(generation);
    if (generation === gx.generation) gx.notice = `The link is removed. Check for new sessions to see it in the review.`;
  } catch (error) {
    if (generation === gx.generation) gx.linkError = errorInfo(error);
  } finally {
    if (generation === gx.generation) {
      gx.linkBusy = false;
      render();
    }
  }
}
