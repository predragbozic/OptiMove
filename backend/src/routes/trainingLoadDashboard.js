// Training Load Analysis Dashboard — HTTP routes. Mounted at
// /api/training-load/dashboards (see server.js), alongside the existing
// /api/training-load, /api/training-load/metrics, and /api/training-
// activity routers — a separate module, not folded into any of them.
//
// Every write route below resolves the active data workspace EXACTLY
// ONCE (resolveActiveDataWorkspace), and threads that SAME snapshot
// through authorization, the write itself, and (for query/active-
// selection routes) the read — never a second, independent
// resolveActiveWorkspace call later in the same request, which is
// exactly the kind of race a workspace switch mid-request could exploit.
//
// No frontend code, no drag/resize UI, no CSV/API connector routes, no
// AC/CH, no ML — this router is the backend surface only, per this
// delivery's own explicit scope boundary.
import { Router } from "express";
import { resolveActiveDataWorkspace, canManageDashboardRow, dataWorkspaceMatches } from "../trainingLoadDashboardAccess.js";
import {
  listDashboards, getDashboardDetail, createDashboard, updateDashboardMetadata, archiveDashboard, cloneDashboard,
  getActiveDashboard, setActiveDashboard, clearActiveDashboard, httpError, validFilterShape,
} from "../trainingLoadDashboardCatalog.js";
import {
  replaceLayout, updateWidgetLayout, createWidget, updateWidgetContent, deleteWidget,
  addSeries, updateSeries, deleteSeries, reorderSeries, resolveSeriesBinding,
} from "../trainingLoadDashboardWidgets.js";
import { queryDashboard } from "../trainingLoadDashboardQuery.js";
import { query } from "../db.js";

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_QUERY_PERIOD_DAYS = 400;
const MAX_WIDGETS_PER_QUERY = 200;
const MAX_ORDER_VALUE = 1_000_000;

const GROUP_BY_VALUES = new Set(["day", "week", "session", "component", "athlete", "cohort"]);
const WIDGET_STATE_VALUES = new Set(["active", "collapsed"]);
const AXIS_VALUES = new Set(["primary", "secondary"]);
const SOURCE_POLICY_VALUES = new Set(["all_with_conflicts", "source_connection", "manual", "api_import", "csv_import", "derived", "not_applicable"]);
const DATA_SCOPE_LEVEL_VALUES = new Set(["day", "session", "component"]);
const ANALYTICAL_AGGREGATION_VALUES = new Set(["sum", "avg", "max", "last", "none"]);
const AGGREGATION_ROLE_POLICY_VALUES = new Set(["standalone_only", "standalone_and_source_rollup", "all_including_derived"]);
const COVERAGE_POLICY_VALUES = new Set(["complete_only", "complete_and_partial", "any"]);
const COMPARISON_PERIOD_VALUES = new Set(["previous_period", "previous_year"]);
const HINT_VALUE_TYPE_VALUES = new Set(["numeric", "boolean", "text"]);
const HINT_SCOPE_LEVEL_VALUES = new Set(["day", "session", "component"]);

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
function validDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  if (value.slice(0, 4) === "0000") return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validUuidArray(value) {
  return Array.isArray(value) && value.length <= 500 && value.every(validUuid);
}
// Strict Node-side validation (finding #4 of the final merge-readiness
// round) — this app never relies on a PostgreSQL CHECK/FK as the PRIMARY
// validator for ordinary client input; the DB's own constraints remain a
// last-resort integrity backstop for bugs in this code, never the first
// line of defense.
function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}
function validNonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ORDER_VALUE;
}
function validPositiveInt(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_ORDER_VALUE;
}
function validX(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 11;
}
function validWidth(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 12;
}
function validNonEmptyTrimmedString(value, maxLength) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= maxLength;
}
function validEnum(value, allowedSet) {
  return typeof value === "string" && allowedSet.has(value);
}
function validDescription(value) {
  return typeof value === "string" && value.length <= 2000;
}
// color/displayLabel: nullable strings — when a string, non-whitespace.
function validNullableLabelString(value, maxLength) {
  if (value === null) return true;
  return typeof value === "string" && value.trim().length >= 1 && value.length <= (maxLength ?? 500);
}
function validDisplayConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "schemaVersion")) return false;
  return Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 1;
}
// Mirrors the DB's own validate_template_metric_key_hints_shape trigger
// (v16) at the Node layer — a bare string element, a missing/empty `key`,
// or an out-of-enum valueType/scopeLevel is rejected here, before ever
// reaching the sanctioned function.
function validTemplateHints(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const allowedHintKeys = new Set(["key", "valueType", "unit", "scopeLevel"]);
  return value.every((hint) => {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) return false;
    for (const k of Object.keys(hint)) if (!allowedHintKeys.has(k)) return false;
    if (typeof hint.key !== "string" || hint.key.trim().length === 0) return false;
    if (Object.prototype.hasOwnProperty.call(hint, "valueType") && hint.valueType != null && !HINT_VALUE_TYPE_VALUES.has(hint.valueType)) return false;
    if (Object.prototype.hasOwnProperty.call(hint, "scopeLevel") && hint.scopeLevel != null && !HINT_SCOPE_LEVEL_VALUES.has(hint.scopeLevel)) return false;
    if (Object.prototype.hasOwnProperty.call(hint, "unit") && hint.unit != null && typeof hint.unit !== "string") return false;
    return true;
  });
}
// `unknown fields ... must not be silently accepted` — a field this route
// doesn't recognize (including a now-retired one like the old
// clearDescription/clearLocalFilterOverride/clearComparisonPeriod client
// flags, or resolutionStatus/templateResolutionCandidates, now always
// server-derived — finding #5) is a loud 400, never a silent no-op.
function rejectUnknownKeys(body, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(body || {})) {
    if (!allowed.has(key)) return key;
  }
  return null;
}
// A PATCH body carrying ONLY its required revision token (and nothing
// else) would be a genuine no-op write — rejected outright rather than
// silently bumping revision for zero real change.
function hasAnyOtherKey(body, excludeKeys) {
  const exclude = new Set(excludeKeys);
  return Object.keys(body || {}).some((k) => !exclude.has(k));
}
function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

// Central error mapper — the ONE place a raw pg error (SQLSTATE) or an
// explicit service-layer httpError() becomes an HTTP response. An
// httpError() has ALREADY been vetted safe by whoever threw it (a
// hand-written, client-safe message) — everything else below is a RAW pg
// error that must never leak its own message (constraint/table names,
// owner_scope/club/team ids, SQLSTATEs) to the client; only a small,
// stable, generic {error: code} body is returned for those.
const SAFE_CLIENT_INPUT_SQLSTATES = new Set(["23502", "23503", "23514", "22P02", "22003"]);
// A default STABLE code per HTTP status, used whenever an httpError() call
// site didn't pass an explicit one — this is what lets every EXISTING
// httpError(404, "human text") / httpError(403, "...") call across access/
// catalog/widgets automatically get a stable `error` code (notFound/
// forbidden/invalidRequest/conflict) without having to touch every call
// site individually. `message` carries the hand-authored, already-vetted-
// safe human text for debugging/UX — never a raw DB message (only
// httpError()-origin errors ever reach this branch; a raw pg error is
// handled by the SQLSTATE branches below and never carries a `message`
// field to the client at all).
const DEFAULT_CODE_FOR_STATUS = { 400: "invalidRequest", 403: "forbidden", 404: "notFound", 409: "conflict" };
function respondToServiceError(res, next, error) {
  if (error?.httpStatus) {
    const code = error.code || DEFAULT_CODE_FOR_STATUS[error.httpStatus] || "requestFailed";
    return res.status(error.httpStatus).json({ error: code, message: error.message });
  }
  if (error?.code === "40001") return res.status(409).json({ error: "staleRevision" });
  // '40002' — training_load.assert_dashboard_writable() (v17). Every
  // service-layer call site that can realistically hit this already
  // catches it explicitly and throws a vetted httpError (so the branch
  // above handles it in practice) — this is defense-in-depth for any raw
  // 40002 that reaches the route layer unwrapped.
  if (error?.code === "40002") return res.status(409).json({ error: "dashboardArchived" });
  if (error?.code === "23505") return res.status(409).json({ error: "conflict" });
  if (SAFE_CLIENT_INPUT_SQLSTATES.has(error?.code)) return res.status(400).json({ error: "invalidRequest" });
  // A P0001 (plain RAISE EXCEPTION) is always a business-rule violation
  // the caller can plausibly fix by changing their request (not a stale
  // revision, which is 40001) — but its own message can name internal
  // ids/scopes, so it is NEVER forwarded raw. Genuinely known cases (e.g.
  // metric-not-visible) are pre-checked at the application layer BEFORE
  // reaching the trigger (see trainingLoadDashboardWidgets.js's
  // assertMetricReferenceOk) and surface as a clean 404 via httpError
  // instead of ever reaching this branch.
  if (error?.code === "P0001") return res.status(400).json({ error: "invalidRequest" });
  return next(error);
}

// Resolved ONCE per request, reused everywhere below.
async function requireDataWorkspace(req, res) {
  const dataWorkspace = await resolveActiveDataWorkspace(req);
  if (dataWorkspace.type === null) {
    res.status(403).json({ error: "forbidden", message: "No active workspace." });
    return null;
  }
  return dataWorkspace;
}

function dataWorkspaceQueryArgs(dataWorkspace) {
  return {
    dataWorkspaceType: dataWorkspace.dataWorkspaceType,
    dataWorkspaceScopeId: dataWorkspace.dataWorkspaceScopeId ?? null,
    dataWorkspaceUserId: dataWorkspace.dataWorkspaceUserId ?? null,
    athleteWorkspaceAthleteId: dataWorkspace.athleteWorkspaceAthleteId ?? null,
  };
}

// The ROUTE-LEVEL half of the archived-dashboard gate (finding #1 of the
// merge-readiness round) — an early, nice-to-have reject for every
// layout/widget/series write route below, all of which share this
// helper. This is explicitly NOT the sole guard: the AUTHORITATIVE check
// is training_load.assert_dashboard_writable(), called by every
// sanctioned function immediately after it locks the dashboard row (see
// v17) — that DB-level check is what closes the real race (a concurrent
// archive landing between this read and the eventual write), this
// route-level check only saves a wasted round trip for the common,
// non-racing case.
async function requireManageableDashboard(req, res, dataWorkspace, dashboardId) {
  const r = await query(`select * from training_load.dashboards where id = $1`, [dashboardId]);
  const row = r.rows[0];
  if (!row) { res.status(404).json({ error: "notFound", message: "Dashboard not found." }); return null; }
  if (!canManageDashboardRow(req, row)) { res.status(404).json({ error: "notFound", message: "Dashboard not found." }); return null; }
  if (row.status === "archived") { res.status(409).json({ error: "dashboardArchived" }); return null; }
  return row;
}

async function widgetTypeIsActive(widgetType) {
  const r = await query(`select is_active from training_load.dashboard_widget_types where key = $1`, [widgetType]);
  return r.rowCount > 0 && r.rows[0].is_active === true;
}
async function builtinSeriesKeyIsActive(key) {
  const r = await query(`select is_active from training_load.dashboard_builtin_series where key = $1`, [key]);
  return r.rowCount > 0 && r.rows[0].is_active === true;
}

// Contextual owner-field validation shared by POST / and POST /:id/clone
// — an irrelevant owner field for the requested ownerScope (e.g.
// ownerTeamId alongside ownerScope='club') is a loud 400, never silently
// ignored (finding #4).
function ownerFieldsError(b) {
  const scope = b.ownerScope ?? "user";
  if (scope === "club") {
    if (!validUuid(b.ownerClubId)) return "ownerClubId must be a valid UUID for ownerScope=club.";
    if (b.ownerTeamId !== undefined) return "ownerTeamId is not applicable for ownerScope=club.";
  } else if (scope === "team") {
    if (!validUuid(b.ownerTeamId)) return "ownerTeamId must be a valid UUID for ownerScope=team.";
    if (b.ownerClubId !== undefined) return "ownerClubId is not applicable for ownerScope=team.";
  } else {
    if (b.ownerClubId !== undefined) return "ownerClubId is not applicable for this ownerScope.";
    if (b.ownerTeamId !== undefined) return "ownerTeamId is not applicable for this ownerScope.";
  }
  return null;
}

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const includeTemplates = req.query.includeTemplates !== "false";
    const includeArchived = req.query.includeArchived === "true";
    res.json(await listDashboards(req, dataWorkspace, { includeTemplates, includeArchived }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.get("/active", async (req, res, next) => {
  try {
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await getActiveDashboard(req, dataWorkspace));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/active", async (req, res, next) => {
  try {
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["dashboardId"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validUuid(b.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "dashboardId is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await setActiveDashboard(req, dataWorkspace, b.dashboardId));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.delete("/active", async (req, res, next) => {
  try {
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await clearActiveDashboard(req, dataWorkspace));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// GET a single dashboard is deliberately NOT gated on status='active' — an
// archived dashboard stays visible for historical review (finding #1);
// only WRITE and QUERY operations on it are refused.
router.get("/:dashboardId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await getDashboardDetail(req, dataWorkspace, req.params.dashboardId));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const CREATE_DASHBOARD_KEYS = ["name", "description", "ownerScope", "ownerClubId", "ownerTeamId", "isTemplate", "defaultFilter"];
router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, CREATE_DASHBOARD_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (b.description !== undefined && b.description !== null && !validDescription(b.description)) {
      return res.status(400).json({ error: "invalidRequest", message: "description must be a string of at most 2000 characters, or null." });
    }
    const ownerErr = ownerFieldsError(b);
    if (ownerErr) return res.status(400).json({ error: "invalidRequest", message: ownerErr });
    res.status(201).json(await createDashboard(req, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const CLONE_DASHBOARD_KEYS = ["name", "ownerScope", "ownerClubId", "ownerTeamId", "isTemplate"];
router.post("/:dashboardId/clone", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, CLONE_DASHBOARD_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    const ownerErr = ownerFieldsError(b);
    if (ownerErr) return res.status(400).json({ error: "invalidRequest", message: ownerErr });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.status(201).json(await cloneDashboard(req, dataWorkspace, req.params.dashboardId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const UPDATE_DASHBOARD_METADATA_KEYS = ["expectedRevision", "name", "description", "defaultFilter", "isTemplate"];
router.patch("/:dashboardId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, UPDATE_DASHBOARD_METADATA_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown} (clearing a field is done by sending it as null, not a separate clear flag).` });
    if (!validRevision(b.expectedRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedRevision must be a positive integer." });
    if (!hasAnyOtherKey(b, ["expectedRevision"])) return res.status(400).json({ error: "invalidRequest", message: "This PATCH carries no actual change." });
    if (b.description !== undefined && b.description !== null && !validDescription(b.description)) {
      return res.status(400).json({ error: "invalidRequest", message: "description must be a string of at most 2000 characters, or null." });
    }
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await updateDashboardMetadata(req, dataWorkspace, req.params.dashboardId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/:dashboardId/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedRevision"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedRevision must be a positive integer." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await archiveDashboard(req, dataWorkspace, req.params.dashboardId, { expectedRevision: b.expectedRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Layout
// ------------------------------------------------------------

const LAYOUT_ENTRY_KEYS = new Set(["widgetId", "x", "y", "width", "height", "mobileOrder"]);
function validLayoutEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  for (const k of Object.keys(entry)) if (!LAYOUT_ENTRY_KEYS.has(k)) return false;
  if (!validUuid(entry.widgetId)) return false;
  if (entry.x !== undefined && !validX(entry.x)) return false;
  if (entry.y !== undefined && !validNonNegInt(entry.y)) return false;
  if (entry.width !== undefined && !validWidth(entry.width)) return false;
  if (entry.height !== undefined && !validPositiveInt(entry.height)) return false;
  if (entry.mobileOrder !== undefined && !validNonNegInt(entry.mobileOrder)) return false;
  return true;
}

router.put("/:dashboardId/layout", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedRevision", "layout"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedRevision must be a positive integer." });
    if (!Array.isArray(b.layout) || b.layout.length === 0) return res.status(400).json({ error: "invalidRequest", message: "layout must be a non-empty array of {widgetId, x?, y?, width?, height?, mobileOrder?}." });
    if (!b.layout.every(validLayoutEntry)) return res.status(400).json({ error: "invalidRequest", message: "layout contains an invalid entry (bad range, or an unknown nested field)." });
    if (hasDuplicates(b.layout.map((e) => e.widgetId))) return res.status(400).json({ error: "invalidRequest", message: "layout must not repeat the same widgetId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await replaceLayout(req.params.dashboardId, { expectedRevision: b.expectedRevision, layout: b.layout }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId/widgets/:widgetId/layout", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedWidgetRevision", "x", "y", "width", "height", "mobileOrder"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    // At least one position/size field must be present — an empty body
    // (only the revision token) would be a no-op write (finding #2).
    if (!hasAnyOtherKey(b, ["expectedWidgetRevision"])) {
      return res.status(400).json({ error: "invalidRequest", message: "At least one of x/y/width/height/mobileOrder is required." });
    }
    if (b.x !== undefined && !validX(b.x)) return res.status(400).json({ error: "invalidRequest", message: "x must be an integer 0-11." });
    if (b.y !== undefined && !validNonNegInt(b.y)) return res.status(400).json({ error: "invalidRequest", message: "y must be a non-negative integer." });
    if (b.width !== undefined && !validWidth(b.width)) return res.status(400).json({ error: "invalidRequest", message: "width must be an integer 1-12." });
    if (b.height !== undefined && !validPositiveInt(b.height)) return res.status(400).json({ error: "invalidRequest", message: "height must be a positive integer." });
    if (b.mobileOrder !== undefined && !validNonNegInt(b.mobileOrder)) return res.status(400).json({ error: "invalidRequest", message: "mobileOrder must be a non-negative integer." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await updateWidgetLayout(req.params.dashboardId, req.params.widgetId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Widgets
// ------------------------------------------------------------

const CREATE_WIDGET_KEYS = ["expectedDashboardRevision", "widgetType", "title", "widgetOrder", "x", "y", "width", "height", "mobileOrder", "groupBy", "displayConfig", "localFilterOverride"];
router.post("/:dashboardId/widgets", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, CREATE_WIDGET_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedDashboardRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedDashboardRevision must be a positive integer." });
    if (typeof b.widgetType !== "string" || !b.widgetType.length) return res.status(400).json({ error: "invalidRequest", message: "widgetType is required." });
    if (!validNonEmptyTrimmedString(b.title, 200)) return res.status(400).json({ error: "invalidRequest", message: "title is required (1-200 characters, not whitespace-only)." });
    if (!validNonNegInt(b.widgetOrder)) return res.status(400).json({ error: "invalidRequest", message: "widgetOrder is required and must be a non-negative integer." });
    if (!validX(b.x)) return res.status(400).json({ error: "invalidRequest", message: "x is required and must be an integer 0-11." });
    if (!validNonNegInt(b.y)) return res.status(400).json({ error: "invalidRequest", message: "y is required and must be a non-negative integer." });
    if (!validWidth(b.width)) return res.status(400).json({ error: "invalidRequest", message: "width is required and must be an integer 1-12." });
    if (!validPositiveInt(b.height)) return res.status(400).json({ error: "invalidRequest", message: "height is required and must be a positive integer." });
    if (!validNonNegInt(b.mobileOrder)) return res.status(400).json({ error: "invalidRequest", message: "mobileOrder is required and must be a non-negative integer." });
    if (b.groupBy !== undefined && !validEnum(b.groupBy, GROUP_BY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `groupBy must be one of ${[...GROUP_BY_VALUES].join("|")}.` });
    if (b.displayConfig !== undefined && !validDisplayConfig(b.displayConfig)) return res.status(400).json({ error: "invalidRequest", message: "displayConfig must be a plain object with a positive integer schemaVersion." });
    if (b.localFilterOverride !== undefined && !validFilterShape(b.localFilterOverride)) return res.status(400).json({ error: "invalidRequest", message: "localFilterOverride is invalid." });
    if (!(await widgetTypeIsActive(b.widgetType))) return res.status(400).json({ error: "invalidRequest", message: "Unknown or inactive widgetType." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.status(201).json(await createWidget(req.params.dashboardId, { ...b, title: b.title.trim() }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const UPDATE_WIDGET_CONTENT_KEYS = ["expectedWidgetRevision", "widgetType", "title", "groupBy", "state", "displayConfig", "localFilterOverride"];
router.patch("/:dashboardId/widgets/:widgetId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, UPDATE_WIDGET_CONTENT_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown} (clearing localFilterOverride is done by sending it as null, not a separate clear flag).` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    if (!hasAnyOtherKey(b, ["expectedWidgetRevision"])) return res.status(400).json({ error: "invalidRequest", message: "This PATCH carries no actual change." });
    // widgetType/title/groupBy/state/displayConfig are all NON-nullable —
    // an explicit null for any of them is a controlled 400, never a
    // silent no-op (finding #3).
    if (Object.prototype.hasOwnProperty.call(b, "widgetType")) {
      if (b.widgetType === null || typeof b.widgetType !== "string" || !b.widgetType.length) return res.status(400).json({ error: "invalidRequest", message: "widgetType cannot be null; it must be a non-empty string." });
      if (!(await widgetTypeIsActive(b.widgetType))) return res.status(400).json({ error: "invalidRequest", message: "Unknown or inactive widgetType." });
    }
    if (Object.prototype.hasOwnProperty.call(b, "title")) {
      if (b.title === null || !validNonEmptyTrimmedString(b.title, 200)) return res.status(400).json({ error: "invalidRequest", message: "title cannot be null; it must be 1-200 characters, not whitespace-only." });
    }
    if (Object.prototype.hasOwnProperty.call(b, "groupBy")) {
      if (b.groupBy === null || !validEnum(b.groupBy, GROUP_BY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `groupBy cannot be null; it must be one of ${[...GROUP_BY_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "state")) {
      if (b.state === null || !validEnum(b.state, WIDGET_STATE_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `state cannot be null; it must be one of ${[...WIDGET_STATE_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "displayConfig")) {
      if (b.displayConfig === null || !validDisplayConfig(b.displayConfig)) return res.status(400).json({ error: "invalidRequest", message: "displayConfig cannot be null; it must be a plain object with a positive integer schemaVersion." });
    }
    if (b.localFilterOverride !== undefined && b.localFilterOverride !== null && !validFilterShape(b.localFilterOverride)) return res.status(400).json({ error: "invalidRequest", message: "localFilterOverride is invalid." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await updateWidgetContent(req.params.dashboardId, req.params.widgetId, b.title !== undefined ? { ...b, title: b.title.trim() } : b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.delete("/:dashboardId/widgets/:widgetId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedWidgetRevision"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await deleteWidget(req.params.dashboardId, req.params.widgetId, { expectedWidgetRevision: b.expectedWidgetRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Series
// ------------------------------------------------------------

// resolutionStatus/templateResolutionCandidates are DELIBERATELY absent
// from this allowlist — training_load.add_series() (v17) now derives
// both authoritatively, server-side, every time; a client sending either
// gets a plain "unknown field" 400 (finding #5).
const ADD_SERIES_KEYS = [
  "expectedWidgetRevision", "seriesOrder", "metricDefinitionId", "builtInSeriesKey", "templateMetricKeyHints",
  "axis", "color", "displayLabel", "sourcePolicy",
  "sourceConnectionId", "dataScopeLevel", "analyticalAggregation", "aggregationRolePolicy", "coveragePolicy", "comparisonPeriod",
];
router.post("/:dashboardId/widgets/:widgetId/series", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ADD_SERIES_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown} (resolutionStatus/templateResolutionCandidates are always server-derived and never accepted).` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    if (!validNonNegInt(b.seriesOrder)) return res.status(400).json({ error: "invalidRequest", message: "seriesOrder must be a non-negative integer." });
    if (b.metricDefinitionId !== undefined && b.metricDefinitionId !== null && !validUuid(b.metricDefinitionId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid metricDefinitionId." });
    // Finding #5: a client may never pair a REAL metricDefinitionId with
    // its OWN templateMetricKeyHints claim — the hint for a metric-backed
    // template series is always the server's own snapshot of the LOCKED
    // definition. Sending both is rejected outright, not silently
    // overridden, so a caller can never mistake "my hint was honored" for
    // what actually happened.
    if (b.metricDefinitionId && b.templateMetricKeyHints !== undefined) {
      return res.status(400).json({ error: "invalidRequest", message: "templateMetricKeyHints cannot be provided together with metricDefinitionId — it is always derived server-side." });
    }
    if (!b.metricDefinitionId && !b.builtInSeriesKey && !validTemplateHints(b.templateMetricKeyHints)) {
      return res.status(400).json({ error: "invalidRequest", message: "A series with neither metricDefinitionId nor builtInSeriesKey requires templateMetricKeyHints: a non-empty array of {key, valueType?, unit?, scopeLevel?} objects." });
    }
    if (b.builtInSeriesKey !== undefined && (typeof b.builtInSeriesKey !== "string" || !b.builtInSeriesKey.length)) return res.status(400).json({ error: "invalidRequest", message: "Invalid builtInSeriesKey." });
    if (b.builtInSeriesKey && !(await builtinSeriesKeyIsActive(b.builtInSeriesKey))) return res.status(400).json({ error: "invalidRequest", message: "Unknown or inactive builtInSeriesKey." });
    if (b.axis !== undefined && !validEnum(b.axis, AXIS_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `axis must be one of ${[...AXIS_VALUES].join("|")}.` });
    if (b.color !== undefined && !validNullableLabelString(b.color, 50)) return res.status(400).json({ error: "invalidRequest", message: "color must be a non-whitespace string, or null." });
    if (b.displayLabel !== undefined && !validNullableLabelString(b.displayLabel, 200)) return res.status(400).json({ error: "invalidRequest", message: "displayLabel must be a non-whitespace string, or null." });
    if (b.sourcePolicy !== undefined && !validEnum(b.sourcePolicy, SOURCE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `sourcePolicy must be one of ${[...SOURCE_POLICY_VALUES].join("|")}.` });
    if (b.sourceConnectionId !== undefined && b.sourceConnectionId !== null && !validUuid(b.sourceConnectionId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid sourceConnectionId." });
    if (b.dataScopeLevel !== undefined && !validEnum(b.dataScopeLevel, DATA_SCOPE_LEVEL_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `dataScopeLevel must be one of ${[...DATA_SCOPE_LEVEL_VALUES].join("|")}.` });
    if (b.analyticalAggregation !== undefined && !validEnum(b.analyticalAggregation, ANALYTICAL_AGGREGATION_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `analyticalAggregation must be one of ${[...ANALYTICAL_AGGREGATION_VALUES].join("|")}.` });
    if (b.aggregationRolePolicy !== undefined && !validEnum(b.aggregationRolePolicy, AGGREGATION_ROLE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `aggregationRolePolicy must be one of ${[...AGGREGATION_ROLE_POLICY_VALUES].join("|")}.` });
    if (b.coveragePolicy !== undefined && !validEnum(b.coveragePolicy, COVERAGE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `coveragePolicy must be one of ${[...COVERAGE_POLICY_VALUES].join("|")}.` });
    if (b.comparisonPeriod !== undefined && b.comparisonPeriod !== null && !validEnum(b.comparisonPeriod, COMPARISON_PERIOD_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `comparisonPeriod must be one of ${[...COMPARISON_PERIOD_VALUES].join("|")}, or null.` });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const dashboardRow = await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId);
    if (!dashboardRow) return;
    res.status(201).json(await addSeries(req.params.dashboardId, req.params.widgetId, b, req.user.id, dashboardRow));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const UPDATE_SERIES_KEYS = [
  "expectedWidgetRevision", "axis", "color", "displayLabel", "sourcePolicy", "sourceConnectionId",
  "dataScopeLevel", "analyticalAggregation", "aggregationRolePolicy", "coveragePolicy", "comparisonPeriod",
];
router.patch("/:dashboardId/widgets/:widgetId/series/:seriesId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, UPDATE_SERIES_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown} (clearing color/displayLabel/comparisonPeriod is done by sending it as null, not a separate clear flag).` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    if (!hasAnyOtherKey(b, ["expectedWidgetRevision"])) return res.status(400).json({ error: "invalidRequest", message: "This PATCH carries no actual change." });
    // axis/sourcePolicy/dataScopeLevel/analyticalAggregation/
    // aggregationRolePolicy/coveragePolicy are all NON-nullable —
    // explicit null is a controlled 400 (finding #3).
    if (Object.prototype.hasOwnProperty.call(b, "axis")) {
      if (b.axis === null || !validEnum(b.axis, AXIS_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `axis cannot be null; it must be one of ${[...AXIS_VALUES].join("|")}.` });
    }
    if (b.color !== undefined && !validNullableLabelString(b.color, 50)) return res.status(400).json({ error: "invalidRequest", message: "color must be a non-whitespace string, or null." });
    if (b.displayLabel !== undefined && !validNullableLabelString(b.displayLabel, 200)) return res.status(400).json({ error: "invalidRequest", message: "displayLabel must be a non-whitespace string, or null." });
    if (Object.prototype.hasOwnProperty.call(b, "sourcePolicy")) {
      if (b.sourcePolicy === null || !validEnum(b.sourcePolicy, SOURCE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `sourcePolicy cannot be null; it must be one of ${[...SOURCE_POLICY_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "sourceConnectionId")) {
      if (b.sourceConnectionId === null) {
        // Clearing the pin while STAYING on source_policy='source_connection'
        // (i.e. not also switching policy away in this SAME request) would
        // leave an illegal source_policy='source_connection' + NULL
        // connection row — refused outright rather than left to the DB's
        // own CHECK to catch as a generic 23514 (finding #3).
        if (b.sourcePolicy === undefined || b.sourcePolicy === "source_connection") {
          return res.status(400).json({ error: "invalidRequest", message: "sourceConnectionId cannot be cleared while sourcePolicy stays 'source_connection' — change sourcePolicy in the same request." });
        }
      } else if (!validUuid(b.sourceConnectionId)) {
        return res.status(400).json({ error: "invalidRequest", message: "Invalid sourceConnectionId." });
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, "dataScopeLevel")) {
      if (b.dataScopeLevel === null || !validEnum(b.dataScopeLevel, DATA_SCOPE_LEVEL_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `dataScopeLevel cannot be null; it must be one of ${[...DATA_SCOPE_LEVEL_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "analyticalAggregation")) {
      if (b.analyticalAggregation === null || !validEnum(b.analyticalAggregation, ANALYTICAL_AGGREGATION_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `analyticalAggregation cannot be null; it must be one of ${[...ANALYTICAL_AGGREGATION_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "aggregationRolePolicy")) {
      if (b.aggregationRolePolicy === null || !validEnum(b.aggregationRolePolicy, AGGREGATION_ROLE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `aggregationRolePolicy cannot be null; it must be one of ${[...AGGREGATION_ROLE_POLICY_VALUES].join("|")}.` });
    }
    if (Object.prototype.hasOwnProperty.call(b, "coveragePolicy")) {
      if (b.coveragePolicy === null || !validEnum(b.coveragePolicy, COVERAGE_POLICY_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `coveragePolicy cannot be null; it must be one of ${[...COVERAGE_POLICY_VALUES].join("|")}.` });
    }
    if (b.comparisonPeriod !== undefined && b.comparisonPeriod !== null && !validEnum(b.comparisonPeriod, COMPARISON_PERIOD_VALUES)) return res.status(400).json({ error: "invalidRequest", message: `comparisonPeriod must be one of ${[...COMPARISON_PERIOD_VALUES].join("|")}, or null.` });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const dashboardRow = await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId);
    if (!dashboardRow) return;
    res.json(await updateSeries(req.params.dashboardId, req.params.widgetId, req.params.seriesId, b, dashboardRow));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.delete("/:dashboardId/widgets/:widgetId/series/:seriesId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedWidgetRevision"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await deleteSeries(req.params.dashboardId, req.params.widgetId, req.params.seriesId, { expectedWidgetRevision: b.expectedWidgetRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

const REORDER_ENTRY_KEYS = new Set(["seriesId", "seriesOrder"]);
function validReorderEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  for (const k of Object.keys(entry)) if (!REORDER_ENTRY_KEYS.has(k)) return false;
  return validUuid(entry.seriesId) && validNonNegInt(entry.seriesOrder);
}

router.put("/:dashboardId/widgets/:widgetId/series/reorder", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedWidgetRevision", "order"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    if (!Array.isArray(b.order) || b.order.length === 0) return res.status(400).json({ error: "invalidRequest", message: "order must be a non-empty array of {seriesId, seriesOrder}." });
    if (!b.order.every(validReorderEntry)) return res.status(400).json({ error: "invalidRequest", message: "order contains an invalid entry (bad range, or an unknown nested field)." });
    if (hasDuplicates(b.order.map((e) => e.seriesId))) return res.status(400).json({ error: "invalidRequest", message: "order must not repeat the same seriesId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await reorderSeries(req.params.dashboardId, req.params.widgetId, { expectedWidgetRevision: b.expectedWidgetRevision, order: b.order }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/:dashboardId/widgets/:widgetId/series/:seriesId/resolve", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, ["expectedWidgetRevision", "metricDefinitionId"]);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validRevision(b.expectedWidgetRevision)) return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision must be a positive integer." });
    if (!validUuid(b.metricDefinitionId)) return res.status(400).json({ error: "invalidRequest", message: "metricDefinitionId is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const dashboardRow = await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId);
    if (!dashboardRow) return;
    res.json(await resolveSeriesBinding(req.params.dashboardId, req.params.widgetId, req.params.seriesId, { expectedWidgetRevision: b.expectedWidgetRevision, metricDefinitionId: b.metricDefinitionId }, dashboardRow));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Query — the one batch endpoint: loads the whole dashboard, or a
// requested subset of widgets, for a period/athlete/activity/component
// filter, using the current active data workspace.
// ------------------------------------------------------------

const QUERY_DASHBOARD_KEYS = ["dateFrom", "dateTo", "athleteIds", "activityId", "componentId", "widgetIds"];
router.post("/:dashboardId/query", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    const unknown = rejectUnknownKeys(b, QUERY_DASHBOARD_KEYS);
    if (unknown) return res.status(400).json({ error: "invalidRequest", message: `Unknown field: ${unknown}.` });
    if (!validDate(b.dateFrom)) return res.status(400).json({ error: "invalidRequest", message: "dateFrom is required (YYYY-MM-DD)." });
    if (!validDate(b.dateTo)) return res.status(400).json({ error: "invalidRequest", message: "dateTo is required (YYYY-MM-DD)." });
    if (new Date(`${b.dateTo}T00:00:00Z`) < new Date(`${b.dateFrom}T00:00:00Z`)) return res.status(400).json({ error: "invalidRequest", message: "dateTo cannot be before dateFrom." });
    const spanDays = Math.round((new Date(`${b.dateTo}T00:00:00Z`) - new Date(`${b.dateFrom}T00:00:00Z`)) / 86400000) + 1;
    if (spanDays > MAX_QUERY_PERIOD_DAYS) return res.status(400).json({ error: "invalidRequest", message: `Period cannot exceed ${MAX_QUERY_PERIOD_DAYS} days.` });
    // athleteIds MAY be explicitly null OR an empty array — both mean
    // "clear back to no athlete restriction" (finding #8 of the previous
    // round) — only a PRESENT, non-null, non-empty value that isn't a
    // valid UUID array is rejected.
    if (b.athleteIds !== undefined && b.athleteIds !== null && !validUuidArray(b.athleteIds)) return res.status(400).json({ error: "invalidRequest", message: "athleteIds must be an array of valid UUIDs (max 500), or null/[]." });
    if (b.activityId !== undefined && b.activityId !== null && !validUuid(b.activityId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid activityId." });
    if (b.componentId !== undefined && b.componentId !== null && !validUuid(b.componentId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid componentId." });
    if (b.widgetIds !== undefined && !validUuidArray(b.widgetIds)) return res.status(400).json({ error: "invalidRequest", message: "widgetIds must be an array of valid UUIDs (max 500)." });

    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const { dashboard, widgets } = await getDashboardDetail(req, dataWorkspace, req.params.dashboardId);

    // An ARCHIVED dashboard is read-only — GET may still show it, but a
    // query must not execute against it (finding #1 of the previous
    // round).
    if (dashboard.status === "archived") {
      return res.status(409).json({ error: "dashboardArchived" });
    }

    // A dashboard's data is bound to ITS OWN data workspace — canViewDashboardRow
    // (used by getDashboardDetail) grants VISIBILITY based on manage rights
    // (e.g. a club admin who manages Club A can always SEE Club A's
    // dashboard, or a platform admin can always see ANY dashboard's
    // structure), which is a broader condition than "the CURRENT active
    // workspace is the one this dashboard's data is bound to". Querying
    // must additionally require the latter — otherwise a manager of both
    // Club A and Club B (or a platform admin in their OWN private_coach/
    // athlete workspace) could view another dashboard's structure while
    // active elsewhere and have it silently execute against the WRONG
    // workspace's own data (finding #1 of THIS round — private_coach/
    // athlete account-identity matching). A system template (data_
    // workspace_type IS NULL) has no data workspace at all until cloned.
    if (dashboard.data_workspace_type === null) {
      return res.status(409).json({ error: "templateRequiresClone" });
    }
    if (!dataWorkspaceMatches(dataWorkspace, dashboard)) {
      return res.status(404).json({ error: "notFound" });
    }

    const targetWidgets = b.widgetIds ? widgets.filter((w) => b.widgetIds.includes(w.id)) : widgets;
    if (targetWidgets.length > MAX_WIDGETS_PER_QUERY) return res.status(400).json({ error: "invalidRequest", message: `Cannot query more than ${MAX_WIDGETS_PER_QUERY} widgets at once.` });

    // The runtime filter carries ONLY the keys the request body actually
    // set (hasOwnProperty, not `!== undefined`) — an ABSENT key inherits
    // the dashboard's own default_filter; an EXPLICIT null (or [] for
    // athleteIds) overrides (clears) it. See trainingLoadDashboardQuery.js's
    // mergeFilters.
    const requestFilter = {};
    if (Object.prototype.hasOwnProperty.call(b, "athleteIds")) requestFilter.athleteIds = b.athleteIds;
    if (Object.prototype.hasOwnProperty.call(b, "activityId")) requestFilter.activityId = b.activityId;
    if (Object.prototype.hasOwnProperty.call(b, "componentId")) requestFilter.componentId = b.componentId;

    const result = await queryDashboard(dataWorkspaceQueryArgs(dataWorkspace), targetWidgets, { dateFrom: b.dateFrom, dateTo: b.dateTo }, { defaultFilter: dashboard.default_filter, requestFilter });
    res.json({ dashboardRevision: dashboard.revision, widgets: result });
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

export default router;
