// Imports (Training Load -> Data & Analysis), the data side. GPEXE is the
// first data source; every call here goes to its routes. Every call goes to the existing
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

// Athlete links changed here, and this session's review was made before a
// check that started after the change saw it: it was made with the old links
// and must not be approved as it is. Per session, because a check only
// refreshes the sessions inside its dates; both times are the server's.
export function reviewMadeBeforeLinkChange(c, gx = state.trainingLoad.gpexe) {
  if (!gx?.linkSeq) return false;
  if (!gx.linkCheckStartedAt || !c?.lastSeenAt) return true;
  return new Date(c.lastSeenAt).getTime() < new Date(gx.linkCheckStartedAt).getTime();
}

// Every link change: no check has seen it yet.
function linksChanged() {
  const gx = g();
  gx.linkSeq += 1;
  gx.linkCheckStartedAt = null;
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
  gx.blockedReasons = {};
  gx.blockedReasonErrors = {};
  gx.uncertain = {};
  gx.linkConfirm = null;
  gx.lastLink = null;
  gx.linkOpen = "";
  gx.linkSeq = 0;
  gx.checkLinkSeq = null;
  gx.linkCheckStartedAt = null;
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
    forgetConfirmedImports();
    void loadBlockedReasons(render);
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

// The list answer does not say why a session is blocked; its detail does.
// For each blocked session whose reason is not known for this sighting
// (id + lastSeenAt), the detail is read once, so the list can group it and
// show the same next step as the detail.
const reasonsInFlight = new Set();

export async function loadBlockedReasons(render) {
  const gx = g();
  const generation = gx.generation;
  const keyOf = (c) => `${c.id}|${c.lastSeenAt || ""}`;
  const missing = (gx.candidates || []).filter((c) => c.status === "blocked" && c.snapshot?.available
    && !gx.blockedReasons[keyOf(c)] && !gx.blockedReasonErrors[keyOf(c)] && !reasonsInFlight.has(`${generation}|${keyOf(c)}`));
  if (!missing.length) return;
  await Promise.all(missing.map(async (c) => {
    const key = keyOf(c);
    reasonsInFlight.add(`${generation}|${key}`);
    try {
      const { candidate } = await api(teamPath(gx.teamId, `/candidates/${encodeURIComponent(c.id)}`));
      if (generation !== gx.generation) return;
      const blocked = candidate?.preview?.blocked;
      if (blocked?.code) gx.blockedReasons[key] = { code: blocked.code, categoryName: candidate.preview.session?.categoryName || null };
      else gx.blockedReasonErrors[key] = true;
    } catch {
      if (generation === gx.generation) gx.blockedReasonErrors[key] = true;
    } finally {
      reasonsInFlight.delete(`${generation}|${key}`);
    }
  }));
  if (generation === gx.generation) render();
}

// A session the list now shows as imported is confirmed: its "result not
// confirmed" mark goes.
function forgetConfirmedImports() {
  const gx = g();
  for (const c of gx.candidates || []) if (c.status === "imported") delete gx.uncertain[c.id];
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
    void loadBlockedReasons(render);
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
      // Reviews made by a check that started after the last link change
      // reflect the links as they are now.
      // A check that started after the last link change: the sessions it saw
      // (lastSeenAt from then on) have reviews made with the current links.
      if (gx.check.status === "succeeded" && gx.linkSeq && gx.checkLinkSeq === gx.linkSeq && !gx.linkCheckStartedAt) gx.linkCheckStartedAt = gx.check.startedAt || null;
      gx.checkLinkSeq = null;
      const [status] = await Promise.all([api(teamPath(gx.teamId, "/status")).catch(() => null), reloadGpexeCandidates(render)]);
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
  gx.detail = { id: candidateId, candidate: null, loading: true, error: null, acceptChanges: false, approving: false, outcome: uncertain };
  gx.linkConfirm = null;
  gx.linkOpen = "";
  gx.notice = "";
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
export async function approveGpexeCandidate({ acceptChanges }, render) {
  const gx = g();
  const detail = gx.detail;
  const candidate = detail?.candidate;
  if (!candidate || detail.approving) return;
  const generation = gx.generation;
  const checks = detail.outcome?.checks || 0;
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
    rememberOutcome(detail.id, detail.outcome);
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
      detail.outcome = { kind: "unknown", error: info, verify: info.data?.verify || null, checks };
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

async function reloadGpexeLinks(generation) {
  const gx = g();
  const { links } = await api(teamPath(gx.teamId, "/athlete-links"));
  if (generation === gx.generation) gx.links = links;
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
