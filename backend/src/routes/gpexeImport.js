// In-app GPEXE import. Mounted at /api/training-load/gpexe behind
// requireAuth. Check, candidates, previews, athlete links, approver grants
// and retention status (phase F1); approving a candidate, the only route
// that writes measurements, an event and an activity (phase F2).
import { Router } from "express";
import { query } from "../db.js";
import { canApproveGpexeImport, resolveGpexeTeamAccess } from "../gpexeImportAccess.js";
import * as service from "../gpexeImportService.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(res) {
  return res.status(404).json({ error: "notFound" });
}

function forbidden(res) {
  return res.status(403).json({ error: "forbidden", message: "Only a platform admin may do this." });
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof service.GpexeImportServiceError) {
        if (error.status === 404) return notFound(res);
        // Only the known detail fields, so a detail can never replace error/message.
        const { reviewAgain, changesToImported } = error.details || {};
        return res.status(error.status).json({
          error: error.code, message: error.message,
          ...(reviewAgain ? { reviewAgain } : {}),
          ...(changesToImported !== undefined ? { changesToImported } : {}),
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
  return access;
}

router.get("/teams/:teamId/status", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const [settings, lastCheck, approval] = await Promise.all([
    service.getTeamSettings(access.teamId),
    service.latestCheck(access.teamId),
    canApproveGpexeImport({ query }, req.user.id, access.teamId),
  ]);
  res.json({
    settings,
    importSwitch: service.applySwitchInfo(),
    lastCheck,
    viewer: { canApprove: approval.canApprove, approvalBasis: approval.basis, isPlatformAdmin: access.platformAdmin },
    approvalAvailable: true,
  });
}));

router.put("/teams/:teamId/settings", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!access.platformAdmin) return forbidden(res);
  res.json({ settings: await service.setTeamSettings(access.teamId, { gpexeTeamId: req.body?.gpexeTeamId, userId: req.user.id }) });
}));

router.post("/teams/:teamId/checks", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const window = service.resolveCheckWindow({ from: req.body?.from, to: req.body?.to });
  const check = await service.startCheck(access.teamId, { userId: req.user.id, window });
  res.status(202).json({ check, importSwitch: service.applySwitchInfo() });
}));

router.get("/teams/:teamId/checks/:checkId", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.checkId)) return notFound(res);
  const check = await service.getCheck(access.teamId, req.params.checkId);
  if (!check) return notFound(res);
  res.json({ check });
}));

router.get("/teams/:teamId/candidates", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  const candidates = await service.listCandidates(access.teamId, { includeSuperseded: req.query.includeSuperseded === "true" });
  res.json({ candidates, importSwitch: service.applySwitchInfo() });
}));

router.get("/teams/:teamId/candidates/:candidateId", handle(async (req, res) => {
  const access = await teamAccess(req, res);
  if (!access) return;
  if (!UUID.test(req.params.candidateId)) return notFound(res);
  const candidate = await service.getCandidate(access.teamId, req.params.candidateId);
  if (!candidate) return notFound(res);
  res.json({ candidate, importSwitch: service.applySwitchInfo() });
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
    userId: req.user.id, previewHash: req.body?.previewHash, acceptChanges: req.body?.acceptChanges,
  });
  res.json({ ...result, candidate: await service.getCandidate(access.teamId, req.params.candidateId) });
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
