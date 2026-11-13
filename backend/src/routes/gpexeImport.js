// In-app GPEXE import. Mounted at /api/training-load/gpexe behind
// requireAuth. Check, candidates, previews, athlete links, approver grants
// and retention status (phase F1); approving a candidate, the only route
// that writes measurements, an event and an activity (phase F2).
import { Router } from "express";
import { isPoolCheckoutTimeout, POOL_CHECKOUT_TIMEOUT, query } from "../db.js";
import { canApproveGpexeImport, importAudienceOf, resolveGpexeTeamAccess } from "../gpexeImportAccess.js";
import { resolveVariableEditor } from "../canonicalVariableAdminService.js";
import { previewHasClubVariable } from "../gpexeImportAudience.js";
import { holdsClubAdminRole } from "../authz.js";
import * as service from "../gpexeImportService.js";
import * as identity from "../gpexeAthleteIdentityService.js";
import * as teamSwitch from "../teamImportSwitchService.js";
import * as teamTimezone from "../gpexeTeamTimezone.js";
import * as sessionUndo from "../gpexeSessionUndoService.js";
import * as trackChoices from "../gpexeTrackChoiceService.js";
import { decideImportStates } from "../activityRosterCommands.js";
import { RosterError } from "../activityRoster.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(res) {
  return res.status(404).json({ error: "notFound" });
}

function forbidden(res) {
  return res.status(403).json({ error: "forbidden", message: "Only a platform admin may do this." });
}

// F3c2e / F3c2g: an administrator of the platform or of the team's club sees
// the precise connection facts (the refusal `reason`, a failed check's precise
// code); a coach gets the stable code and the sentence to contact an
// administrator. Decided from the resolved team access of this request only:
// since 9-B (D8) from its audience level, so the club's admin is one only in
// the club's workspace (J17 section 6.1).
function adminViewerOf(req) {
  return (req.gpexeImportAudience ?? "other") !== "other";
}

// R17: whether a coach-level viewer may read a club variable's name - C99's
// predicate (an active coach of an active team of that club, in that team's
// workspace; resolveVariableEditor), asked lazily and only when the preview
// names a club variable. Any error reads as "no".
async function namesClubVariablesFor(req, preview) {
  const access = req.gpexeTeamAccess;
  if (!access || req.gpexeImportAudience !== "other" || !previewHasClubVariable(preview)) return false;
  if (access.workspace?.type !== "team" || String(access.workspace.scopeId) !== String(access.teamId)) return false;
  try {
    // R17 (the lock-order pull request): the workspace this request already
    // resolved, never a second resolution that a workspace switch in between
    // could make disagree with the team check above.
    const editor = await resolveVariableEditor(req, access.workspace);
    return Boolean(editor && editor.view === "coach" && editor.owner?.clubId === access.clubId
      && (editor.teamId === undefined || editor.teamId === access.teamId));
  } catch {
    return false;
  }
}

// The database pool had no free connection within its checkout bound (db.js).
// In this module every checkout that is not caught by its own code is the
// first step of the requested operation, before any of it is written or
// sent, so the answer is the module's own try_again; only the code and the
// route template are logged.
function poolBusy(req, res) {
  console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
  res.setHeader("Retry-After", "5");
  return res.status(409).json({ error: "try_again", message: "The server is busy right now. Your request was not carried out; try again in a moment." });
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (isPoolCheckoutTimeout(error) && !res.headersSent) return poolBusy(req, res);
      if (error instanceof service.GpexeImportServiceError) {
        if (error.status === 404) return notFound(res);
        // Only the known detail fields, so a detail can never replace error/message.
        const { reviewAgain, changesToImported, verify, reason, rosterWork, calendarLinks, retrySameRequest, subsetPreview, subsetHash, excludedAthleteIds, currentChoice } = error.details || {};
        // The precise reason of a source-connection refusal names connection
        // and server configuration facts: an administrator of the team's club
        // or of the platform gets it; a coach gets the stable code and the
        // sentence to contact an administrator (the F3c2e contract).
        const adminViewer = adminViewerOf(req);
        // J20-B: a refused subset approval carries the recomputed subset preview in the body only, projected for this request's
        // audience by getCandidate like every other preview; it was never stored.
        let subsetBody = null;
        if (subsetPreview && typeof subsetHash === "string" && req.gpexeTeamAccess && UUID.test(String(req.params.candidateId))) {
          try {
            const projected = await service.getCandidate(req.gpexeTeamAccess.teamId, req.params.candidateId, {
              audience: req.gpexeImportAudience, namesClubVariables: (preview) => namesClubVariablesFor(req, preview), previewOverride: subsetPreview,
            });
            if (projected) subsetBody = { excludedAthleteIds: Array.isArray(excludedAthleteIds) ? excludedAthleteIds : [], subsetHash, preview: projected.preview, athletes: projected.athletes };
          } catch (readError) {
            console.error(`[gpexe] reading the subset preview of ${req.params.candidateId} for a refusal failed: ${service.formatDbError(readError)}`);
          }
        }
        const message = typeof reason === "string" && !adminViewer ? "The team's source connection cannot be used right now; contact an administrator. Nothing was read." : error.message;
        return res.status(error.status).json({
          error: error.code, message,
          ...(typeof reason === "string" && adminViewer ? { reason } : {}),
          ...(reviewAgain ? { reviewAgain } : {}),
          ...(subsetBody ? { subset: subsetBody } : {}),
          // A count only (J17 section 8.2, D11): never the changes themselves.
          ...(Number.isInteger(changesToImported) && changesToImported >= 0 ? { changesToImported } : {}),
          ...(verify ? { verify } : {}),
          // U5 / v60: the roster work an undo would remove (counts, and the bounded list of later changes for a platform
          // admin, the only audience of the undo routes), or that the same request may be repeated.
          ...(rosterWork && typeof rosterWork === "object" ? { rosterWork } : {}),
          ...(Number.isInteger(calendarLinks) ? { calendarLinks } : {}),
          ...(retrySameRequest === true ? { retrySameRequest: true } : {}),
          // MT-A: a stale expectedChoiceId answers with the current choice (ids and the choice only).
          ...(currentChoice !== undefined && error.code === "choice_changed" ? { currentChoice } : {}),
        });
      }
      next(error);
    }
  };
}

// Every team-scoped route: a malformed id, a team that does not exist and a
// team outside the caller's rights or active workspace all get the same 404.
async function teamAccess(req, res) {
  if (!UUID.test(req.params.teamId)) {
    notFound(res);
    return null;
  }
  const access = await resolveGpexeTeamAccess(req, req.params.teamId, { query });
  if (!access) notFound(res);
  else {
    req.gpexeTeamAccess = access;
    // J17 section 6.1: the request's one audience level, from this snapshot.
    req.gpexeImportAudience = importAudienceOf(req.authz, access);
  }
  return access;
}

router.get("/teams/:teamId/status", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  // The change reason is an admin's own audit note (it may name another club
  // or team), so only a platform admin gets it back.
  const [settings, lastCheck, lastSucceededCheck, approval] = await Promise.all([
    service.getTeamSettings(access.teamId),
    service.latestCheck(access.teamId, { adminViewer: adminViewerOf(req) }),
    service.lastSucceededCheck(access.teamId),
    canApproveGpexeImport({ query }, req.user.id, access.teamId),
  ]);
  res.json({
    settings: settings && (access.platformAdmin ? settings : { gpexeTeamId: settings.gpexeTeamId, configuredAt: settings.configuredAt }),
    importSwitch: service.applySwitchInfo(),
    lastCheck,
    lastSucceededCheck,
    // identityAdmin only when true: a coach's answer carries no trace of the
    // administrator-only identity load.
    // U2 (v56): the team's own switch, shown to everyone who sees the team (no condition detail here).
    teamImportSwitch: { enabled: approval.switchOn, mode: approval.switchMode ?? "pilot" },
    viewer: {
      canApprove: approval.canApprove, hasApprovalRight: approval.hasRight, approvalBasis: approval.basis, isPlatformAdmin: access.platformAdmin,
      ...(identity.identityAdminBasis(req, access) ? { identityAdmin: true } : {}),
      // D3: whether this viewer may start the identity load (an administrator; or the team's own coach while the team's
      // switch is on in mode `team`). Only when true, as identityAdmin; the load route decides again.
      ...(identity.identityAdminBasis(req, access) || (identity.identityLoadBasis(req, access) === "team_coach" && approval.switchOn && approval.switchMode === "team") ? { identityLoad: true } : {}),
    },
    approvalAvailable: true,
  });
}));

router.put("/teams/:teamId/settings", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  // J19 U2a (D2): an active platform admin, or the active admin of the team's club acting in that
  // club's own workspace (the service re-checks the right, the club, the team and the club's
  // verified connection inside its transaction). Everyone else keeps the 403 of before.
  const clubAdmin = !access.platformAdmin && access.workspace?.type === "club" && access.clubId
    && String(access.workspace.scopeId) === String(access.clubId) && holdsClubAdminRole(req.authz, access.clubId);
  if (!access.platformAdmin && !clubAdmin) return forbidden(res);
  // `reason` is only required when an existing connection is changed; the
  // service decides that under its own lock.
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
  res.json({ settings: await service.setTeamSettings(access.teamId, { gpexeTeamId: req.body?.gpexeTeamId, reason, userId: req.user.id, clubAdminClubId: clubAdmin ? access.clubId : null }) });
}));

// U2 (v56): who may turn a team's import on or off. An active platform admin, or the active admin of the
// team's club acting in that club's own workspace; the database decides the right again (and a club admin
// cannot change the mode). Everyone else sees the state only.
function importSwitchManager(access, req) {
  if (access.platformAdmin) return true;
  return Boolean(access.workspace?.type === "club" && access.clubId
    && String(access.workspace.scopeId) === String(access.clubId) && holdsClubAdminRole(req.authz, access.clubId));
}

router.get("/teams/:teamId/import-switch", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const manager = importSwitchManager(access, req);
  const state = await teamSwitch.readTeamImportSwitch(access.teamId, { detail: manager, platform: access.platformAdmin });
  // The recorded dates and the history are an administrator's; a coach gets the switch and its mode.
  res.json({ importSwitch: { ...state, canManage: manager, canChangeMode: access.platformAdmin, canRecordPrerequisites: access.platformAdmin } });
}));

router.put("/teams/:teamId/import-switch", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!importSwitchManager(access, req)) return res.status(403).json({ error: "forbidden", message: "Only a platform administrator or the club administrator can change this." });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const result = await teamSwitch.setTeamImportSwitch(access.teamId, req.user.id, { enabled: body.enabled, mode: body.mode, reason: body.reason });
  res.json({ importSwitch: result });
}));

// The two dated prerequisites and the two recorded facts are the platform's, not a club's: a platform admin
// only, and to anyone else the routes do not exist.
router.post("/import-prerequisites", handle(async (req, res) => {
  const admin = await canApproveGpexeImport({ query }, req.user.id, null);
  if (admin.basis !== "platform_admin") return notFound(res);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  res.status(201).json({ record: await teamSwitch.recordImportPrerequisite(req.user.id, { kind: body.kind, recordedOn: body.recordedOn, note: body.note }) });
}));

// What the connection was before, and why it was changed. Read-only, and
// the same admin-only audit note as the reason in /status: a platform admin
// only. Nothing here writes; the table itself is append-only (v22).
router.get("/teams/:teamId/settings/history", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  res.json({ history: await service.listSettingsHistory(access.teamId) });
}));

// v62 (mixed_timezones (b)): the team's session time zone, used by the importer only for a session whose GPS units report
// several zones. A platform admin reads and sets it (with a reason); everyone else who sees the team gets the 403 of the
// settings, and a foreign or archived team the identical 404 of teamAccess.
router.get("/teams/:teamId/session-timezone", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  res.json({ sessionTimezone: await teamTimezone.readTeamSessionTimezone(access.teamId) });
}));

router.put("/teams/:teamId/session-timezone", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const timezone = body.timezone === null ? null : body.timezone;
    if (timezone !== null && typeof timezone !== "string") return res.status(400).json({ error: "invalid_timezone", message: "Choose a time zone from the list (for example Europe/Sarajevo)." });
    res.json({ sessionTimezone: await teamTimezone.setTeamSessionTimezone(access.teamId, { timezone, reason: body.reason, userId: req.user.id }) });
  } catch (error) {
    if (error instanceof teamTimezone.TeamTimezoneError) return res.status(error.status).json({ error: error.code, message: error.message });
    throw error;
  }
}));

router.post("/teams/:teamId/checks", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const window = service.resolveCheckWindow({ from: req.body?.from, to: req.body?.to });
  const check = await service.startCheck(access.teamId, { userId: req.user.id, window, adminViewer: adminViewerOf(req) });
  res.status(202).json({ check, importSwitch: service.applySwitchInfo() });
}));

router.get("/teams/:teamId/checks/:checkId", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.checkId)) return notFound(res);
  const check = await service.getCheck(access.teamId, req.params.checkId, { adminViewer: adminViewerOf(req) });
  if (!check) return notFound(res);
  res.json({ check });
}));

router.get("/teams/:teamId/candidates", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const candidates = await service.listCandidates(access.teamId, { includeSuperseded: req.query.includeSuperseded === "true", audience: req.gpexeImportAudience });
  res.json({ candidates, importSwitch: service.applySwitchInfo() });
}));

router.get("/teams/:teamId/candidates/:candidateId", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  const candidate = await service.getCandidate(access.teamId, req.params.candidateId, {
    audience: req.gpexeImportAudience, namesClubVariables: (preview) => namesClubVariablesFor(req, preview),
  });
  if (!candidate) return notFound(res);
  // J20-C: the review chooses attendance states before the import exists, and "Did not participate" needs a reason: the
  // active reasons of the global catalog (keys and labels only), the ones the roster read offers.
  const participationReasons = (await query(
    `select key, label from training.participation_reasons where is_active order by sort_order, key`,
  )).rows.map((r) => ({ key: r.key, label: r.label }));
  res.json({ candidate, importSwitch: service.applySwitchInfo(), participationReasons });
}));

// Approve a candidate as a whole and import it. Body: { previewHash, the
// hash of the preview the approver reviewed; acceptChanges, true when the
// preview lists changes to already imported results }. Refused, with
// nothing written, when the import switch is off, the caller may not approve
// for this team, the candidate is not pending or its snapshot expired, the
// preview is not the one reviewed, or changes were not accepted. A preview
// that changed under the approval's own locks rolls everything back and
// answers 409 preview_changed with reviewAgain.
router.post("/teams/:teamId/candidates/:candidateId/approve", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  const result = await service.approveCandidate(access.teamId, req.params.candidateId, {
    userId: req.user.id, previewHash: req.body?.previewHash, acceptChanges: req.body?.acceptChanges, expectedClubId: access.clubId,
    excludedAthleteIds: req.body?.excludedAthleteIds, subsetHash: req.body?.subsetHash,
  });
  // The import is committed. Reading the candidate afterwards is only a
  // convenience; if it fails, the answer still says the import happened.
  let candidate = null;
  let candidateReadError = null;
  try {
    candidate = await service.getCandidate(access.teamId, req.params.candidateId, {
      audience: req.gpexeImportAudience, namesClubVariables: (preview) => namesClubVariablesFor(req, preview),
    });
  } catch (error) {
    console.error(`[gpexe] reading candidate ${req.params.candidateId} after its import failed: ${service.formatDbError(error)}`);
    candidateReadError = {
      error: "candidate_read_failed",
      message: "The import was committed; only reading the candidate afterwards failed. Open the candidate again to see it.",
      candidateHref: `/api/training-load/gpexe/teams/${access.teamId}/candidates/${req.params.candidateId}`,
    };
  }
  res.json({ ...result, candidate, ...(candidateReadError ? { candidateReadError } : {}) });
}));

// MT-A (v67): the track choice of an athlete GPEXE recorded on more than one track. The approver's audience only
// (lock_gpexe_import_approver's right, team mode included); everyone else gets the identical 404. Nothing reads the choice
// before MT-B. See gpexeTrackChoiceService.
router.get("/teams/:teamId/candidates/:candidateId/track-choices", handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  res.json(await trackChoices.listTrackChoices(access.teamId, req.params.candidateId, { userId: req.user.id }));
}));

router.put("/teams/:teamId/candidates/:candidateId/track-choices/:gpexeAthleteId", handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  const result = await trackChoices.putTrackChoice(access.teamId, req.params.candidateId, req.params.gpexeAthleteId, {
    userId: req.user.id, body: req.body, expectedClubId: access.clubId,
  });
  res.status(result.status).json({
    ...result.body,
    ...(result.replayed ? { replayed: true } : {}),
    ...(result.verifiedAfterCommitError ? { verifiedAfterCommitError: true } : {}),
  });
}));

// J20-A1: recompute the whole candidate's preview now (a link does not change
// the stored one). Team managers, like GET candidate and the link right; the
// answer is GET candidate's projection. Stores only the candidate's derived
// columns (compare-and-set, same transaction); see service.recomputeCandidatePreview.
router.post("/teams/:teamId/candidates/:candidateId/preview", handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  // J20-B: with excludedAthleteIds this is the SUBSET preview - it stores nothing (service.previewCandidateSubset).
  if (req.body && req.body.excludedAthleteIds !== undefined) {
    const unknown = Object.keys(req.body).filter((key) => key !== "excludedAthleteIds");
    if (unknown.length) return res.status(400).json({ error: "invalid_body", message: "The body must be { excludedAthleteIds: [...] } or empty." });
    const subset = await service.previewCandidateSubset(access.teamId, req.params.candidateId, {
      userId: req.user.id, excludedAthleteIds: req.body.excludedAthleteIds, expectedClubId: access.clubId,
    });
    const projected = await service.getCandidate(access.teamId, req.params.candidateId, {
      audience: req.gpexeImportAudience, namesClubVariables: (preview) => namesClubVariablesFor(req, preview), previewOverride: subset.preview,
    });
    if (!projected) return notFound(res);
    return res.json({
      subset: {
        excludedAthleteIds: subset.excludedAthleteIds, previewHash: subset.fullHash, subsetHash: subset.subsetHash,
        preview: projected.preview, athletes: projected.athletes,
      },
      importSwitch: service.applySwitchInfo(),
    });
  }
  await service.recomputeCandidatePreview(access.teamId, req.params.candidateId, { userId: req.user.id, expectedClubId: access.clubId });
  // The update is committed. Reading the candidate afterwards is only the
  // answer's convenience: if it fails, the answer still says it was stored.
  let candidate = null;
  try {
    candidate = await service.getCandidate(access.teamId, req.params.candidateId, {
      audience: req.gpexeImportAudience, namesClubVariables: (preview) => namesClubVariablesFor(req, preview),
    });
  } catch (error) {
    console.error(`[gpexe] reading candidate ${req.params.candidateId} after its review update failed: ${service.formatDbError(error)}`);
    return res.json({
      candidate: null,
      importSwitch: service.applySwitchInfo(),
      candidateReadError: {
        error: "candidate_read_failed",
        message: "The review was updated; only reading the candidate afterwards failed. Open the candidate again to see it.",
        candidateHref: `/api/training-load/gpexe/teams/${access.teamId}/candidates/${req.params.candidateId}`,
      },
    });
  }
  if (!candidate) return notFound(res);
  res.json({ candidate, importSwitch: service.applySwitchInfo() });
}));

// Approve several clean "Ready" candidates of the team in one request
// (Imports phase 4a). Body: { candidateIds: [...], previewHashes: { id:
// hash } }, 1 to service.BATCH_APPROVE_MAX distinct ids, each with the
// preview hash the approver saw (the list's previewHash); acceptChanges is
// refused. Each candidate is approved on its own, in order, through the
// single approval (its own transaction, locks, recomputed preview and
// COMMIT check); the batch is not all-or-nothing. 200 with one result per candidate
// (imported, already_imported, refused, import_outcome_unknown,
// not_attempted) and a summary; a bad body 400, the switch off 409, a
// caller who may not approve 403, a candidate that is not this team's 404 -
// each with nothing attempted.
router.post("/teams/:teamId/imports", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const { candidates } = service.parseBatchApproveBody(req.body);
  // The batch answers the same neutral result for every level (blockedCode
  // only, J17 section 6.1), so it takes no audience.
  res.json(await service.approveCandidates(access.teamId, candidates, { userId: req.user.id, expectedClubId: access.clubId }));
}));

// One approval of the team, by id. With the candidate, this is how an
// approval whose outcome was uncertain (503 import_outcome_unknown) is
// checked. Another team's approval is the same 404 as a missing one.
router.get("/teams/:teamId/approvals/:approvalId", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.approvalId)) return notFound(res);
  const approval = await service.getApproval(access.teamId, req.params.approvalId);
  if (!approval) return notFound(res);
  res.json({ approval });
}));

// J20-C (v61): the attendance states of an import, saved right after its approval by the same user (the roster bulk
// command bound to the approval; see activityRosterCommands.decideImportStates). The roster rights are checked again for
// this request in the workspace the team access was resolved in (one resolution per request). Stable codes only: a
// database message is logged, never sent. Another user's approval, another team's and a missing one are the same 404.
router.post("/teams/:teamId/approvals/:approvalId/states", async (req, res, next) => {
  // Every answer, the 404 included, is no-store.
  res.set("Cache-Control", "no-store");
  try {
    const access = await teamAccess(req, res);
    if (!access) return;
    if (!UUID.test(req.params.approvalId)) return notFound(res);
    const ctx = { userId: req.user.id, authz: req.authz, workspace: access.workspace };
    const outcome = await decideImportStates(ctx, access.teamId, req.params.approvalId, req.body);
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    if (error instanceof RosterError) {
      if (error.status === 404) return notFound(res);
      return res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ?? {}) });
    }
    if (isPoolCheckoutTimeout(error)) {
      console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
      return res.status(503).json({ error: "roster_busy", message: "The session is being changed. Try again." });
    }
    // The importer's log sinks never print an error's text (architecture test 5): formatDbError only.
    console.error(`[gpexe] import states failed: ${service.formatDbError(error)}`);
    // Everything that reaches here failed before the COMMIT (an unknown COMMIT outcome is a RosterError 503).
    if (!res.headersSent) res.status(500).json({ error: "internal_error", message: "Nothing was saved. Try again." });
    else next(error);
  }
});

// The team's source athletes, once each, from stored data only (phase 3a):
// for a whole-team linking screen. Same readers as the candidates; nothing
// is fetched from GPEXE, nothing is written.
router.get("/teams/:teamId/source-athletes", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  res.json({
    athletes: await service.listSourceAthletes(access.teamId),
    units: service.SOURCE_ATHLETE_UNITS,
    lastSeenRule: "newest session date among the team's available snapshots (not expired, not purged); same date: current version before a replaced one, then the later sighting; a refused session's raw snapshot counts only for an athlete no available preview names (evidence raw_snapshot)",
  });
}));

// GPEXE athlete identity (owner order 2026-10-06, v32): the name and date of
// birth of the team's GPEXE athletes, for a platform admin or the team's club
// admin only, in the platform or the club's workspace. Everyone else - a
// coach included - and a team without an active binding get the router's
// identical 404. Every answer, the 404 included, is no-store.
// `basisOf` picks the audience: the identity administrators (identityAdminBasis) for the stored list; for the load, also the
// team's own coach in that team's workspace (identityLoadBasis), whose right the service holds only while the team's
// import switch is on in mode `team` (the identical 404 otherwise).
function identityHandle(fn, basisOf = identity.identityAdminBasis) {
  return async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    let basis = null;
    try {
      const access = await teamAccess(req, res);
      if (!access) return;
      basis = basisOf(req, access);
      if (!basis) return notFound(res);
      await fn(req, res, access, { userId: String(req.user.id), basis });
    } catch (error) {
      if (isPoolCheckoutTimeout(error) && !res.headersSent) return poolBusy(req, res);
      if (error instanceof identity.GpexeIdentityError) {
        if (error.status === 404) return notFound(res);
        // A team's coach never reads the source connection's precise codes (identity.coachRefusal).
        const shown = basis === "team_coach" ? identity.coachRefusal(error) : { status: error.status, code: error.code, message: error.message, details: error.details };
        const { reason, replayed, requestKey } = shown.details || {};
        return res.status(shown.status).json({
          error: shown.code, message: shown.message,
          ...(typeof reason === "string" ? { reason } : {}),
          ...(replayed ? { replayed: true } : {}),
          ...(typeof requestKey === "string" ? { requestKey } : {}),
        });
      }
      next(error);
    }
  };
}

router.get("/teams/:teamId/athlete-identities", identityHandle(async (req, res, access, ctx) => {
  const answer = await identity.listIdentities(access.teamId, ctx, { expectedClubId: access.clubId });
  if (!answer) return notFound(res);
  res.json(answer);
}));

// Body: { requestKey } and nothing else. The athletes are derived by the
// server; the answer carries counts only.
router.post("/teams/:teamId/athlete-identities/loads", identityHandle(async (req, res, access, ctx) => {
  const answer = await identity.loadIdentities(access.teamId, { ctx, body: req.body });
  res.json(ctx.basis === "team_coach" ? identity.coachResult(answer) : answer);
}, identity.identityLoadBasis));

// U3: suggested pairs. Audience: the identity administrators and the team's
// own coach in that team's workspace (pairSuggestionBasis); the three lists
// only. Identical 404s and no-store as the identity routes.
router.get("/teams/:teamId/athlete-pair-suggestions", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    const access = await teamAccess(req, res);
    if (!access) return;
    const basis = identity.pairSuggestionBasis(req, access);
    if (!basis) return notFound(res);
    const answer = await identity.listPairSuggestions(access.teamId, { userId: String(req.user.id), basis }, { expectedClubId: access.clubId });
    if (!answer) return notFound(res);
    res.json(answer);
  } catch (error) {
    if (isPoolCheckoutTimeout(error) && !res.headersSent) return poolBusy(req, res);
    if (error instanceof identity.GpexeIdentityError) {
      if (error.status === 404) return notFound(res);
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    next(error);
  }
});

// U5 (J19-U5, v57): the in-app undo of one imported session. The first version is for an active platform admin only
// (the owner's Q1; the final state, whoever may make athlete links, is a second step): everyone else - the club's admin
// and a coach included - gets the identical 404, as for a missing candidate. The database function derives and locks the
// right again.
async function undoAccess(req, res) {
  const access = await teamAccess(req, res);
  if (!access) return null;
  if (identity.identityAdminBasis(req, access) !== "platform_admin") { notFound(res); return null; }
  if (!UUID.test(req.params.candidateId)) { notFound(res); return null; }
  return access;
}

router.get("/teams/:teamId/candidates/:candidateId/undo-preview", handle(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const access = await undoAccess(req, res);
  if (!access) return;
  res.json({ undoPreview: await sessionUndo.undoPreview(access.teamId, req.params.candidateId, { userId: String(req.user.id) }) });
}));

router.post("/teams/:teamId/candidates/:candidateId/undo-import", handle(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const access = await undoAccess(req, res);
  if (!access) return;
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const expected = body.expected && typeof body.expected === "object" ? body.expected : {};
  res.json({ undo: await sessionUndo.undoImport(access.teamId, req.params.candidateId, {
    userId: String(req.user.id), requestKey: body.requestKey, reason: body.reason, expectedEventId: expected.eventId ?? null,
    // v60 (O1): later roster changes are removed only with their fingerprint, the confirmation of exactly the listed ones.
    laterRosterFingerprint: body.laterRosterFingerprint,
  }) });
}));

router.get("/teams/:teamId/athlete-links", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  res.json({ links: await service.listAthleteLinks(access.teamId) });
}));

router.post("/teams/:teamId/athlete-links", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const athleteId = req.body?.athleteId;
  if (typeof athleteId !== "string" || !UUID.test(athleteId)) return res.status(400).json({ error: "invalid_athlete_id" });
  const link = await service.linkAthlete(access.teamId, { gpexeAthleteId: req.body?.gpexeAthleteId, athleteId, userId: req.user.id });
  res.status(201).json({ link });
}));

router.post("/teams/:teamId/athlete-links/:linkId/unlink", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.linkId)) return notFound(res);
  const ok = await service.unlinkAthlete(access.teamId, { linkId: req.params.linkId, userId: req.user.id });
  if (!ok) return notFound(res);
  res.json({ ok: true });
}));

router.get("/teams/:teamId/approvers", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  res.json({ approvers: await service.listApprovers(access.teamId) });
}));

router.post("/teams/:teamId/approvers", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  const userId = req.body?.userId;
  if (typeof userId !== "string" || !UUID.test(userId)) return res.status(400).json({ error: "invalid_user_id" });
  const grant = await service.grantApprover(access.teamId, { userId, grantedByUserId: req.user.id, reason: req.body?.reason });
  res.status(201).json({ grant });
}));

router.post("/teams/:teamId/approvers/:grantId/revoke", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  if (!UUID.test(req.params.grantId)) return notFound(res);
  const ok = await service.revokeApprover(access.teamId, { grantId: req.params.grantId, revokedByUserId: req.user.id, reason: req.body?.reason });
  if (!ok) return notFound(res);
  res.json({ ok: true });
}));

// Retention status is not team data: platform admins only, and to anyone
// else it does not exist.
router.get("/retention", handle(async (req, res) => {
  const admin = await canApproveGpexeImport({ query }, req.user.id, null);
  if (admin.basis !== "platform_admin") return notFound(res);
  res.json({ retention: await service.retentionStatus() });
}));

export default router;
