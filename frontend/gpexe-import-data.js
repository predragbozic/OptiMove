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
  gx.calendar = { month: "", day: "" };
  gx.teamId = teamId;
  gx.status = null;
  gx.candidates = null;
  gx.links = null;
  gx.check = null;
  gx.error = null;
  gx.detail = null;
  gx.notice = "";
  gx.uncertain = {};
  gx.linkConfirm = null;
  gx.lastLink = null;
  gx.linkOpen = "";
  gx.linkSeq = 0;
  gx.checkLinkSeq = null;
  gx.linkCheckStartedAt = null;
  gx.sourceAthletes = null;
  gx.sourceAthletesError = null;
  gx.sourceAthletesRetrying = false;
  gx.mapping = emptyMapping();
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
    finishLoad(gx, status, render);
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
  gx.linkError = null;
}

// Returns true when the screen had staged choices (the caller asked first).
export function closeTeamMapping() {
  const gx = g();
  const had = Object.keys(gx.mapping.choices).length > 0;
  gx.mapping = emptyMapping();
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
    if (!choice) return { error: `The athlete chosen for GPEXE athlete ${gpexeAthleteId} is not linkable any more (already linked, or no longer in the team). Choose again.` };
    if (choice.duplicate) return { error: `More than one athlete of the team is called ${choice.name}. Give them different names in Settings > Athletes first, then link.` };
    if (seen.has(athleteId)) return { error: `${choice.name} is chosen for GPEXE athletes ${seen.get(athleteId)} and ${gpexeAthleteId}. One athlete can be linked to one GPEXE athlete only.` };
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
export function candidateGroup(c, gx = g()) {
  if (c.status === "imported") return "imported";
  if (c.status === "superseded") return "replaced";
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
  if (group === "replaced") return "hidden";
  if (group === "imported") return "imported";
  if (group === "excluded") return "out";
  if (isUncertain(c, gx)) return "attention";
  if (group === "notyet") return "attention";
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
export const BATCH_MAX = 10;
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
    const answer = await api(teamPath(gx.teamId, "/imports"), { method: "POST", body: JSON.stringify({ candidateIds, previewHashes }) });
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
      // because the server failed, waits for the reload's verdict.
      if (r.outcome !== "not_attempted" && !(r.outcome === "refused" && r.code === "internal_error")) delete gx.batch.selected[r.candidateId];
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
  const days = (gx.candidates || []).filter((c) => candidateGroup(c, gx) !== "replaced").map((c) => calendarDayKey(c.sessionStartedAt)).filter(Boolean).sort();
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
