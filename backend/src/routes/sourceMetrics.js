// Source metric mapping administration (M2), the canonical-variable admin API
// (M3-0, with R2's rename, archive and restore) and the source-field evidence
// confirmation (M2b), mounted at /api/training-load/sources/metrics behind
// requireAuth, and the source-field revision lifecycle (L1-L5). The contracts
// are sections J1, J3, J3b and J4 of
// docs/ai/gpexe-metric-variable-mapping-discovery.md and J5
// (docs/ai/v39-revision-lifecycle-contract.md):
// a platform admin (platform workspace: the system scope; a club workspace:
// that club's scope) or a club's own active admin in that club's workspace;
// for the variable reads and the three R2 writes also an active coach of an
// active team of the club, in that team's workspace (club variables only);
// everyone and everything else answers the same 404 (ADR-006). Stable codes
// only: a database refusal the service does not know is a sanitized 500,
// never its text. Same-origin JSON only; no body is logged.
import { Router } from "express";
import * as service from "../sourceMetricMappingService.js";
import * as variables from "../canonicalVariableAdminService.js";
import * as fields from "../sourceFieldVerificationService.js";
import * as revisions from "../sourceRevisionLifecycleService.js";
import { isPoolCheckoutTimeout, POOL_CHECKOUT_TIMEOUT } from "../db.js";

const router = Router();

// Every answer of this router (a 404 and a refusal included) is not cached.
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function notFound(res) {
  return res.status(404).json({ error: "notFound" });
}

// The database pool had no free connection within its checkout bound (db.js):
// the source / importer family's answer (routes/sourceConnections.js,
// routes/gpexeImport.js) - try_again, 409, Retry-After 5. Every checkout here
// is the first step of the request, before anything is written.
function poolBusy(req, res) {
  console.error(`[db] ${POOL_CHECKOUT_TIMEOUT}: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")}`);
  res.setHeader("Retry-After", "5");
  return res.status(409).json({ error: "try_again", message: "The server is busy right now. Your request was not carried out; try again in a moment." });
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (isPoolCheckoutTimeout(error)) return poolBusy(req, res);
      if (error instanceof service.SourceMetricMappingError) {
        // Every 404 is the same body, whatever was missing or not visible.
        if (error.status === 404) return notFound(res);
        if (error.code === "try_again") res.setHeader("Retry-After", "5");
        // Only known detail fields; never a body field back.
        const { current, limit, requestKey, clubIds } = error.details || {};
        return res.status(error.status).json({
          error: error.code, message: error.message,
          ...(current ? { current } : {}), ...(limit ? { limit } : {}), ...(requestKey ? { requestKey } : {}),
          ...(clubIds ? { clubIds } : {}),
        });
      }
      console.error(`[source-metric-mappings] internal_error: ${req.method} ${String(req.baseUrl || "")}${String(req.route?.path || "")} (${error?.code ?? error?.name ?? "error"})`);
      return res.status(500).json({ error: "internal_error", message: "Something went wrong." });
    }
  };
}

function jsonObjectBody(req, res) {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "jsonRequired", message: "This request takes a JSON body." });
    return false;
  }
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "invalid_body", message: "A JSON object body is required." });
    return false;
  }
  return true;
}

async function adminContext(req, res) {
  const ctx = await service.resolveMappingAdmin(req);
  if (!ctx) notFound(res);
  return ctx;
}
// The variable reads and the R2 writes (J3b.3): the admins as above, and a
// team's coach in that team's workspace.
async function editorContext(req, res) {
  const ctx = await variables.resolveVariableEditor(req);
  if (!ctx) notFound(res);
  return ctx;
}

router.get("/fields", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  res.json({ fields: await service.listFields({ ctx, query: req.query }) });
}));

router.get("/targets", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  res.json({ targets: await service.listTargets({ ctx }) });
}));

router.get("/conversions", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  res.json({ conversions: await service.listConversions({ ctx }) });
}));

router.get("/mappings", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  // { mappings, nextCursor }: one page; nextCursor is null on the last.
  res.json(await service.listMappings({ ctx, query: req.query }));
}));

router.get("/mappings/:mappingId", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  // { mapping (with one page of versions), nextCursor }.
  const page = await service.getMapping({ ctx, mappingId: req.params.mappingId, query: req.query });
  if (!page) return notFound(res);
  res.json(page);
}));

// A write's answer: 201 for a resource created by this request; 200 for a
// replay (the current state of the earlier request's resource), for a COMMIT
// whose answer was lost but verified, and for every transition.
function writeAnswer(res, result, createdStatus) {
  const status = !result.replayed && !result.commitConfirmation ? createdStatus : 200;
  res.status(status).json(result);
}

router.post("/mappings", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await service.createMapping({ ctx, body: req.body }), 201);
}));

router.post("/mappings/:mappingId/versions", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await service.createVersion({ ctx, mappingId: req.params.mappingId, body: req.body }), 201);
}));

router.post("/mappings/:mappingId/versions/:versionId/submit", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await service.submitVersion({ ctx, mappingId: req.params.mappingId, versionId: req.params.versionId, body: req.body }), 200);
}));

// The canonical-variable admin API (M3-0, section J3): OptiMove's own
// variables of the active workspace's owner, with the same access, 404, error
// and write discipline as the mapping routes above.
router.get("/variables", handle(async (req, res) => {
  const ctx = await editorContext(req, res);
  if (!ctx) return;
  // { variables, nextCursor }: one page; nextCursor is null on the last.
  res.json(await variables.listVariables({ ctx, query: req.query }));
}));

// Before /variables/:variableId, so "key-suggestion" is never taken for an id.
router.get("/variables/key-suggestion", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  res.json(await variables.suggestKey({ ctx, query: req.query }));
}));

router.get("/variables/:variableId", handle(async (req, res) => {
  const ctx = await editorContext(req, res);
  if (!ctx) return;
  // { variable (with one page of versions), nextCursor }.
  const page = await variables.getVariable({ ctx, variableId: req.params.variableId, query: req.query });
  if (!page) return notFound(res);
  res.json(page);
}));

router.post("/variables", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await variables.createVariable({ ctx, body: req.body }), 201);
}));

router.post("/variables/:variableId/versions", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await variables.createVariableVersion({ ctx, variableId: req.params.variableId, body: req.body }), 201);
}));

// R2 (section J3b): rename, archive and restore of a variable. The answer is
// 200 { variable } (a replay adds replayed: true). The order of the answers:
// the identical 404 without the right, 415, a non-object body 400, a malformed
// id the identical 404, a wrong body shape 400, then the write.
router.post("/variables/:variableId/rename", handle(async (req, res) => {
  const ctx = await editorContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await variables.renameVariable({ ctx, variableId: req.params.variableId, body: req.body }), 200);
}));

router.post("/variables/:variableId/archive", handle(async (req, res) => {
  const ctx = await editorContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await variables.archiveVariable({ ctx, variableId: req.params.variableId, body: req.body }), 200);
}));

router.post("/variables/:variableId/restore", handle(async (req, res) => {
  const ctx = await editorContext(req, res);
  if (!ctx) return;
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await variables.restoreVariable({ ctx, variableId: req.params.variableId, body: req.body }), 200);
}));

// Source-field evidence confirmation (M2b, section J4): the field detail for
// the same audience as /fields; the two acts for an active platform admin in
// the platform workspace only - everyone else the same 404, before the body is
// looked at.
router.get("/fields/:fieldId", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  const detail = await fields.getField({ ctx, fieldId: req.params.fieldId, query: req.query });
  if (!detail) return notFound(res);
  res.json(detail);
}));

router.post("/fields/:fieldId/revisions/:revisionId/unit-verification", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!fields.mayVerify(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await fields.verifyUnit({ ctx, fieldId: req.params.fieldId, revisionId: req.params.revisionId, body: req.body }), 201);
}));

router.post("/fields/:fieldId/revisions/:revisionId/meaning-verification", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!fields.mayVerify(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await fields.verifyMeaning({ ctx, fieldId: req.params.fieldId, revisionId: req.params.revisionId, body: req.body }), 201);
}));

// The source-field revision lifecycle (J5): L1 creates a draft revision (201);
// L2 / L5 retire a draft or the active revision, L3 activates a draft and L4
// replaces the active revision by a draft (200). An active platform admin in
// the platform workspace only (O1) - everyone else the same 404, before the
// body is looked at; then 415, a non-object body 400, a malformed id the
// identical 404, a wrong body shape 400, then the write.
router.post("/fields/:fieldId/revisions", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!revisions.mayChangeRevisions(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await revisions.createRevision({ ctx, fieldId: req.params.fieldId, body: req.body }), 201);
}));

router.post("/fields/:fieldId/revisions/:revisionId/retire", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!revisions.mayChangeRevisions(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await revisions.retireRevision({ ctx, fieldId: req.params.fieldId, revisionId: req.params.revisionId, body: req.body }), 200);
}));

router.post("/fields/:fieldId/revisions/:revisionId/activate", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!revisions.mayChangeRevisions(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await revisions.activateRevision({ ctx, fieldId: req.params.fieldId, revisionId: req.params.revisionId, body: req.body }), 200);
}));

router.post("/fields/:fieldId/revisions/:revisionId/replace", handle(async (req, res) => {
  const ctx = await adminContext(req, res);
  if (!ctx) return;
  if (!revisions.mayChangeRevisions(ctx)) return notFound(res);
  if (!jsonObjectBody(req, res)) return;
  writeAnswer(res, await revisions.replaceRevision({ ctx, fieldId: req.params.fieldId, revisionId: req.params.revisionId, body: req.body }), 200);
}));

// Anything else under this prefix is the same 404.
router.use((req, res) => notFound(res));

export default router;
