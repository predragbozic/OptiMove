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
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OWNER_SCOPES = new Set(["system", "club", "team", "user"]);

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
function validDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}
// Intl.DateTimeFormat's own constructor is the authoritative validator —
// it accepts every real IANA zone name AND the special value "UTC" (which
// Intl.supportedValuesOf("timeZone") does NOT enumerate, despite being a
// genuinely valid ECMA-402 timeZone value), and throws on garbage like
// "UTC+1" or "Not/AZone". Trying supportedValuesOf() first and only
// falling back to this on failure would silently reject plain "UTC" —
// device_timezone rows and plenty of real client input use it — so this
// is the one and only check, not a fallback.
function validTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function validPositiveInt(value, { max } = {}) {
  if (value === undefined || value === null || value === "") return true; // absent is fine, caller applies a default
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (max !== undefined && n > max) return false;
  return true;
}

// P0001 = a plpgsql RAISE EXCEPTION (every CHECK/trigger violation this
// feature's own migration functions raise) -> a controlled 400 with the
// DB's own message, never an opaque 500. 23505 = unique_violation (a
// genuine double-submit race that slipped past an app-level check) -> 409.
// Everything else falls through to next(error) -> the app's central error
// handler (a real 500, logged) — never silently reclassified as a 400.
function respondToWriteError(res, next, error) {
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

// A coach-capable workspace is required for every catalog-management and
// measurement-write route below. Resolved ONCE per request and reused for
// authorization, the write itself, and idempotency — never re-resolved
// mid-request (see trainingLoadMetricsAccess.js's own header).
//
// §1 fix: this helper existed before but several catalog write routes
// never actually called it, despite their own comments implying they did
// — an athlete-only (or any bare authenticated) account could reach
// createDomain/createCategory/createDefinition/... directly and have
// resolveCatalogOwnerScope's 'user' branch stamp them as the owner with
// no coach-capability check at all. Every catalog write route below now
// calls this first.
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
  const authzContext = { authz: req.authz, user: req.user };
  if (workspace?.type === "athlete") {
    if (!req.authz.athleteId) {
      res.status(403).json({ error: "This account has no athlete profile." });
      return null;
    }
    return { isAthleteSelf: true, athleteId: req.authz.athleteId, scope: { type: null }, authzContext };
  }
  const scope = metricsScopeForWorkspace(workspace, req);
  if (scope.type === null) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { isAthleteSelf: false, athleteId: null, scope, authzContext };
}

function sendServiceResult(res, result, successStatus = 200) {
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.status(successStatus).json(result);
}

// §6 fix: an ownerScope that IS present but not a recognized value must
// 400, never silently fall back to 'user' inside resolveCatalogOwnerScope
// (which only ever sees a value that already passed this gate).
function validOwnerScopeIfPresent(body) {
  if (body?.ownerScope === undefined || body?.ownerScope === null) return true;
  return OWNER_SCOPES.has(body.ownerScope);
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
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    if (!validOwnerScopeIfPresent(req.body)) return res.status(400).json({ error: "Invalid ownerScope." });
    if (req.body?.ownerClubId !== undefined && req.body.ownerClubId !== null && !validUuid(req.body.ownerClubId)) return res.status(400).json({ error: "Invalid ownerClubId." });
    if (req.body?.ownerTeamId !== undefined && req.body.ownerTeamId !== null && !validUuid(req.body.ownerTeamId)) return res.status(400).json({ error: "Invalid ownerTeamId." });
    const result = await createDomain(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/domains/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
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
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    if (!validOwnerScopeIfPresent(req.body)) return res.status(400).json({ error: "Invalid ownerScope." });
    if (req.body?.ownerClubId !== undefined && req.body.ownerClubId !== null && !validUuid(req.body.ownerClubId)) return res.status(400).json({ error: "Invalid ownerClubId." });
    if (req.body?.ownerTeamId !== undefined && req.body.ownerTeamId !== null && !validUuid(req.body.ownerTeamId)) return res.status(400).json({ error: "Invalid ownerTeamId." });
    const result = await createCategory(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/categories/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
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
    if (!validPositiveInt(req.query.limit, { max: 100 })) return res.status(400).json({ error: "Invalid limit." });
    if (req.query.state !== undefined && !["active", "archived"].includes(req.query.state)) return res.status(400).json({ error: "Invalid state." });
    if (req.query.ownerScope !== undefined && !OWNER_SCOPES.has(req.query.ownerScope)) return res.status(400).json({ error: "Invalid ownerScope." });
    if (req.query.cursorId !== undefined && !validUuid(req.query.cursorId)) return res.status(400).json({ error: "Invalid cursorId." });
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
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    if (!validOwnerScopeIfPresent(req.body)) return res.status(400).json({ error: "Invalid ownerScope." });
    if (req.body?.ownerClubId !== undefined && req.body.ownerClubId !== null && !validUuid(req.body.ownerClubId)) return res.status(400).json({ error: "Invalid ownerClubId." });
    if (req.body?.ownerTeamId !== undefined && req.body.ownerTeamId !== null && !validUuid(req.body.ownerTeamId)) return res.status(400).json({ error: "Invalid ownerTeamId." });
    const result = await createDefinition(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.patch("/definitions/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const result = await updateDefinitionCosmetic(req, req.params.id, req.body || {});
    sendServiceResult(res, result);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.post("/definitions/:id/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Metric definition not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
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
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const result = await createDefinitionVersion(req, req.params.id, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

// Hide/unhide is a personal viewing preference, not a catalog-management
// privilege — deliberately NOT gated by requireMetricsScope (any
// authenticated account, including athlete-only, may hide a definition
// from their own default catalog view — same as library.filter_hidden).
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
    if (req.query.domainId !== undefined && !validUuid(req.query.domainId)) return res.status(400).json({ error: "Invalid domainId." });
    if (req.query.categoryId !== undefined && !validUuid(req.query.categoryId)) return res.status(400).json({ error: "Invalid categoryId." });
    if (req.query.definitionId !== undefined && !validUuid(req.query.definitionId)) return res.status(400).json({ error: "Invalid definitionId." });
    const rows = await listStructureLinks(req, { domainId: req.query.domainId, categoryId: req.query.categoryId, definitionId: req.query.definitionId });
    res.json({ rows });
  } catch (error) {
    next(error);
  }
});

router.post("/structure-links", async (req, res, next) => {
  try {
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    if (!validOwnerScopeIfPresent(req.body)) return res.status(400).json({ error: "Invalid ownerScope." });
    for (const field of ["domainId", "categoryId", "metricDefinitionId", "ownerClubId", "ownerTeamId"]) {
      if (req.body?.[field] !== undefined && req.body[field] !== null && !validUuid(req.body[field])) return res.status(400).json({ error: `Invalid ${field}.` });
    }
    const result = await createStructureLink(req, req.body || {});
    sendServiceResult(res, result, 201);
  } catch (error) {
    respondToWriteError(res, next, error);
  }
});

router.delete("/structure-links/:id", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
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

function validateEventBody(body) {
  if (!body?.requestKey || typeof body.requestKey !== "string") return "requestKey is required.";
  if (!validDate(body.occurredDate)) return "occurredDate must be a valid YYYY-MM-DD date.";
  if (body.occurredInstant !== undefined && body.occurredInstant !== null && !validTimestamp(body.occurredInstant)) return "occurredInstant must be a valid timestamp.";
  if (!["session", "day"].includes(body?.scopeLevel)) return "scopeLevel must be 'session' or 'day'.";
  if (!Array.isArray(body?.participants) || body.participants.length === 0) return "At least one participant is required.";
  for (const p of body.participants) {
    if (!validUuid(p?.athleteId)) return "Each participant requires a valid athleteId.";
    if (!validTimezone(p?.timezone)) return "Each participant requires a valid IANA timezone.";
    if (p.logicalSessionId !== undefined && p.logicalSessionId !== null && !validUuid(p.logicalSessionId)) return "Invalid logicalSessionId.";
    if (p.externalAssignmentId !== undefined && p.externalAssignmentId !== null && !validUuid(p.externalAssignmentId)) return "Invalid externalAssignmentId.";
    if (!Array.isArray(p?.values) || p.values.length === 0) return "Each participant requires at least one value.";
    for (const v of p.values) {
      if (!validUuid(v?.metricDefinitionId)) return "Each value requires a valid metricDefinitionId.";
      if (!validUuid(v?.metricDefinitionVersionId)) return "Each value requires a valid metricDefinitionVersionId.";
      if (v.segmentIndex !== undefined && v.segmentIndex !== null && (!Number.isInteger(v.segmentIndex) || v.segmentIndex < 0)) return "Invalid segmentIndex.";
    }
  }
  if (body.segments !== undefined) {
    if (!Array.isArray(body.segments)) return "segments must be an array.";
    for (const s of body.segments) {
      if (!s?.label || typeof s.label !== "string") return "Each segment requires a label.";
    }
  }
  return null;
}

router.post("/events", async (req, res, next) => {
  try {
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    const validationError = validateEventBody(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
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

function validateCorrectionValues(values) {
  if (!Array.isArray(values) || values.length === 0) return "At least one value is required.";
  for (const v of values) {
    if (!validUuid(v?.metricDefinitionId)) return "Each value requires a valid metricDefinitionId.";
    if (!validUuid(v?.metricDefinitionVersionId)) return "Each value requires a valid metricDefinitionVersionId.";
  }
  return null;
}

router.post("/occasions/:id/correct", async (req, res, next) => {
  try {
    if (!validUuid(req.params.id)) return res.status(404).json({ error: "Measurement not found." });
    const scope = await requireMetricsScope(req, res);
    if (!scope) return;
    if (!req.body?.requestKey || typeof req.body.requestKey !== "string") return res.status(400).json({ error: "requestKey is required." });
    const validationError = validateCorrectionValues(req.body?.values);
    if (validationError) return res.status(400).json({ error: validationError });
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
    if (!req.body?.requestKey || typeof req.body.requestKey !== "string") return res.status(400).json({ error: "requestKey is required." });
    if (!validUuid(req.body?.sourceIdentityId)) return res.status(400).json({ error: "sourceIdentityId is required." });
    if (!validUuid(req.body?.expectedCurrentOccasionId)) return res.status(400).json({ error: "expectedCurrentOccasionId is required." });
    const validationError = validateCorrectionValues(req.body?.values);
    if (validationError) return res.status(400).json({ error: validationError });
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
    if (!validDate(req.query.dateFrom)) return res.status(400).json({ error: "Invalid dateFrom." });
    if (!validDate(req.query.dateTo)) return res.status(400).json({ error: "Invalid dateTo." });
    if (!validPositiveInt(req.query.limit, { max: 200 })) return res.status(400).json({ error: "Invalid limit." });
    const athleteIds = req.query.athleteIds ? String(req.query.athleteIds).split(",").filter(Boolean) : null;
    if (athleteIds && athleteIds.some((id) => !validUuid(id))) return res.status(400).json({ error: "Invalid athleteIds." });
    const metricDefinitionIds = req.query.metricDefinitionIds ? String(req.query.metricDefinitionIds).split(",").filter(Boolean) : null;
    if (metricDefinitionIds && metricDefinitionIds.some((id) => !validUuid(id))) return res.status(400).json({ error: "Invalid metricDefinitionIds." });
    if (req.query.eventId && !validUuid(req.query.eventId)) return res.status(400).json({ error: "Invalid eventId." });
    if (req.query.domainId && !validUuid(req.query.domainId)) return res.status(400).json({ error: "Invalid domainId." });
    if (req.query.categoryId && !validUuid(req.query.categoryId)) return res.status(400).json({ error: "Invalid categoryId." });
    if (req.query.cursorOccasionId !== undefined && !validUuid(req.query.cursorOccasionId)) return res.status(400).json({ error: "Invalid cursorOccasionId." });
    if (req.query.cursorValueId !== undefined && !validUuid(req.query.cursorValueId)) return res.status(400).json({ error: "Invalid cursorValueId." });
    if (req.query.cursorDate !== undefined && !validDate(req.query.cursorDate)) return res.status(400).json({ error: "Invalid cursorDate." });
    const cursor = req.query.cursorDate && req.query.cursorOccasionId && req.query.cursorValueId
      ? { occurredDate: req.query.cursorDate, occasionId: req.query.cursorOccasionId, valueId: req.query.cursorValueId }
      : null;

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
