// Training Load metrics — catalog, classification, manual measurement
// entry/correction, and the read-only results API. Mounted at
// /api/training-load/metrics (see server.js), alongside the existing
// /api/training-load router — a separate file/router (per this feature's
// own scope: "odvojeni, razumljivi moduli... povezani sa postojećim
// Training Load modulom"), not folded into trainingLoad.js itself.
//
// No frontend, no GPEXE/CSV connector, and no public import endpoint are
// part of this router — see the source-identity correction/resend
// functions exported from trainingLoadMetricsMeasurements.js, which exist
// as tested service code only, ready for a future connector to call.
import { Router } from "express";
import { resolveActiveWorkspace } from "../workspace.js";
import {
  resolveMetricsWorkspaceScope,
  metricsScopeForWorkspace,
} from "../trainingLoadMetricsAccess.js";
import {
  listDomains, createDomain, archiveDomain,
  listCategories, createCategory, archiveCategory,
  listDefinitions, getDefinition, createDefinition, updateDefinitionCosmetic, archiveDefinition,
  createDefinitionVersion, listDefinitionVersions,
  hideDefinitionForUser, unhideDefinitionForUser,
  listStructureLinks, createStructureLink, deleteStructureLink,
} from "../trainingLoadMetricsCatalog.js";
import {
  createGroupEvent, correctManualOccasion, correctImportedOccasionManually,
  getOccasionDetail, getOccasionHistory, queryResults,
} from "../trainingLoadMetricsMeasurements.js";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// P0001 = a plpgsql RAISE EXCEPTION (every CHECK/trigger violation this
// feature's own migration functions raise) -> a controlled 400 with the
// DB's own message, never an opaque 500. 23505 = unique_violation (a
// genuine double-submit race that slipped past an app-level check) -> 409.
// Same pattern as trainingLoad.js's/tests.js's own respondToWriteError.
function respondToWriteError(res, next, error) {
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

// A coach-capable workspace is required for every catalog-management and
// measurement-write route below. Resolved ONCE per request and reused for
// authorization, the write itself, and idempotency — never re-resolved
// mid-request (see trainingLoadMetricsAccess.js's own header).
async function requireMetricsScope(req, res) {
  const scope = await resolveMetricsWorkspaceScope(req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return scope;
}

// Resolves the ACTIVE workspace once (never req.authz.isAthlete alone —
// that is a raw capability flag, "does this account have an athlete
// profile at all", not "is it currently presenting as that athlete
// workspace". A dual-role account currently acting as a coach must get
// coach-scoped results, exactly like GET /weekly in trainingLoad.js
// branches on workspace.type === "athlete", never on the bare capability).
async function resolveReadContext(req, res) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (workspace?.type === "athlete") {
    if (!req.authz.athleteId) {
      res.status(403).json({ error: "This account has no athlete profile." });
      return null;
    }
    return { isAthleteSelf: true, athleteId: req.authz.athleteId, scope: { type: null } };
  }
  const scope = metricsScopeForWorkspace(workspace, req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { isAthleteSelf: false, athleteId: null, scope };
}

function sendServiceResult(res, result, successStatus = 200) {
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.status(successStatus).json(result);
}

// ------------------------------------------------------------
// Catalog: domains / categories
// ------------------------------------------------------------

router.get("/domains", async (req, res, next) => {
  try {
    const rows = await listDomains(req);
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/domains", async (req, res, next) => {
  try {
    const result = await createDomain(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/domains/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const result = await archiveDomain(req, req.params.id);
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.get("/categories", async (req, res, next) => {
  try {
    const rows = await listCategories(req);
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/categories", async (req, res, next) => {
  try {
    const result = await createCategory(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/categories/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const result = await archiveCategory(req, req.params.id);
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

// ------------------------------------------------------------
// Catalog: definitions + versions
// ------------------------------------------------------------

router.get("/definitions", async (req, res, next) => {
  try {
    const cursor = req.query.cursorLabel && req.query.cursorId ? { label: req.query.cursorLabel, id: req.query.cursorId } : null;
    const { rows, nextCursor } = await listDefinitions(req, {
      search: req.query.search, ownerScope: req.query.ownerScope, state: req.query.state, cursor, limit: req.query.limit,
    });
    res.json({ rows, nextCursor });
  } catch (error) {
    next(error);
  }
});

router.get("/definitions/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const row = await getDefinition(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Metric definition not found." });
    res.json({ row });
  } catch (error) {
    next(error);
  }
});

router.post("/definitions", async (req, res, next) => {
  try {
    const result = await createDefinition(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.patch("/definitions/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const result = await updateDefinitionCosmetic(req, req.params.id, req.body || {});
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/definitions/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const result = await archiveDefinition(req, req.params.id);
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.get("/definitions/:id/versions", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const rows = await listDefinitionVersions(req, req.params.id);
    if (rows === null) return res.status(404).json({ error: "Metric definition not found." });
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/definitions/:id/versions", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const result = await createDefinitionVersion(req, req.params.id, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/definitions/:id/hide", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const result = await hideDefinitionForUser(req, req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete("/definitions/:id/hide", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const result = await unhideDefinitionForUser(req, req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------
// Catalog: structure links
// ------------------------------------------------------------

router.get("/structure-links", async (req, res, next) => {
  try {
    const rows = await listStructureLinks(req, { domainId: req.query.domainId, categoryId: req.query.categoryId, definitionId: req.query.definitionId });
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/structure-links", async (req, res, next) => {
  try {
    const result = await createStructureLink(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.delete("/structure-links/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const result = await deleteStructureLink(req, req.params.id);
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

// ------------------------------------------------------------
// Measurements: group/solo event creation, occasion detail/history,
// corrections
// ------------------------------------------------------------

router.post("/events", async (req, res, next) => {
  try {
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const result = await createGroupEvent(req, scope, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.get("/occasions/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Measurement not found." });
    const readContext = await resolveReadContext(req, res);
    if (!readContext) return;
    const detail = await getOccasionDetail(readContext, req.params.id);
    if (!detail) return res.status(404).json({ error: "Measurement not found." });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

router.get("/occasions/:id/history", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Measurement not found." });
    const readContext = await resolveReadContext(req, res);
    if (!readContext) return;
    const chain = await getOccasionHistory(readContext, req.params.id);
    if (!chain.length) return res.status(404).json({ error: "Measurement not found." });
    res.json({ rows: chain });
  } catch (error) {
    next(error);
  }
});

router.post("/occasions/:id/correct", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Measurement not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const result = await correctManualOccasion(req, scope, { ...req.body, targetOccasionId: req.params.id });
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

// Manual correction of a currently-imported measurement. No public import
// endpoint exists in this phase — this route only ever EDITS an occasion
// that some (future) connector already wrote via the service-level
// correctSourceIdentityOccasion/importResendSynthetic functions.
router.post("/occasions/imported-correction", async (req, res, next) => {
  try {
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const result = await correctImportedOccasionManually(req, scope, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

// ------------------------------------------------------------
// Results (read-only)
// ------------------------------------------------------------

router.get("/results", async (req, res, next) => {
  try {
    const readContext = await resolveReadContext(req, res);
    if (!readContext) return;
    const athleteIds = req.query.athleteIds ? String(req.query.athleteIds).split(",").filter(Boolean) : null;
    if (athleteIds && athleteIds.some((id) => !validUuid(id))) return res.status(400).json({ error: "Invalid athleteIds." });
    const metricDefinitionIds = req.query.metricDefinitionIds ? String(req.query.metricDefinitionIds).split(",").filter(Boolean) : null;
    if (metricDefinitionIds && metricDefinitionIds.some((id) => !validUuid(id))) return res.status(400).json({ error: "Invalid metricDefinitionIds." });
    if (req.query.eventId && !validUuid(req.query.eventId)) return res.status(400).json({ error: "Invalid eventId." });
    if (req.query.domainId && !validUuid(req.query.domainId)) return res.status(400).json({ error: "Invalid domainId." });
    if (req.query.categoryId && !validUuid(req.query.categoryId)) return res.status(400).json({ error: "Invalid categoryId." });
    const cursor = req.query.cursorDate && req.query.cursorOccasionId ? { occurredDate: req.query.cursorDate, occasionId: req.query.cursorOccasionId } : null;

    const result = await queryResults(readContext, {
      dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
      athleteIds, metricDefinitionIds, domainId: req.query.domainId, categoryId: req.query.categoryId, eventId: req.query.eventId,
      cursor, limit: req.query.limit,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
