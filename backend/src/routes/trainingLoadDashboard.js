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

async function requireManageableDashboard(req, res, dataWorkspace, dashboardId) {
  const r = await query(`select * from training_load.dashboards where id = $1`, [dashboardId]);
  const row = r.rows[0];
  if (!row) { res.status(404).json({ error: "notFound", message: "Dashboard not found." }); return null; }
  if (!canManageDashboardRow(req, row)) { res.status(404).json({ error: "notFound", message: "Dashboard not found." }); return null; }
  return row;
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
    if (!validUuid(req.body?.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "dashboardId is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await setActiveDashboard(req, dataWorkspace, req.body.dashboardId));
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

router.post("/", async (req, res, next) => {
  try {
    res.status(201).json(await createDashboard(req, req.body || {}));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/:dashboardId/clone", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.status(201).json(await cloneDashboard(req, dataWorkspace, req.params.dashboardId, req.body || {}));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await updateDashboardMetadata(req, dataWorkspace, req.params.dashboardId, req.body || {}));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/:dashboardId/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await archiveDashboard(req, dataWorkspace, req.params.dashboardId, { expectedRevision: req.body?.expectedRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Layout
// ------------------------------------------------------------

router.put("/:dashboardId/layout", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    if (typeof req.body?.expectedRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedRevision is required." });
    if (!Array.isArray(req.body?.layout)) return res.status(400).json({ error: "invalidRequest", message: "layout must be an array." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await replaceLayout(req.params.dashboardId, { expectedRevision: req.body.expectedRevision, layout: req.body.layout }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId/widgets/:widgetId/layout", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
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

router.post("/:dashboardId/widgets", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    if (typeof b.expectedDashboardRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedDashboardRevision is required." });
    if (typeof b.widgetType !== "string") return res.status(400).json({ error: "invalidRequest", message: "widgetType is required." });
    if (typeof b.title !== "string" || !b.title.length) return res.status(400).json({ error: "invalidRequest", message: "title is required." });
    if (b.localFilterOverride !== undefined && !validFilterShape(b.localFilterOverride)) return res.status(400).json({ error: "invalidRequest", message: "localFilterOverride is invalid." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.status(201).json(await createWidget(req.params.dashboardId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId/widgets/:widgetId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
    if (b.localFilterOverride !== undefined && !validFilterShape(b.localFilterOverride)) return res.status(400).json({ error: "invalidRequest", message: "localFilterOverride is invalid." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await updateWidgetContent(req.params.dashboardId, req.params.widgetId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.delete("/:dashboardId/widgets/:widgetId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    if (typeof req.body?.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await deleteWidget(req.params.dashboardId, req.params.widgetId, { expectedWidgetRevision: req.body.expectedWidgetRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

// ------------------------------------------------------------
// Series
// ------------------------------------------------------------

router.post("/:dashboardId/widgets/:widgetId/series", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
    if (typeof b.seriesOrder !== "number") return res.status(400).json({ error: "invalidRequest", message: "seriesOrder is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const dashboardRow = await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId);
    if (!dashboardRow) return;
    res.status(201).json(await addSeries(req.params.dashboardId, req.params.widgetId, b, req.user.id, dashboardRow));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId/widgets/:widgetId/series/:seriesId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
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
    if (typeof req.body?.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await deleteSeries(req.params.dashboardId, req.params.widgetId, req.params.seriesId, { expectedWidgetRevision: req.body.expectedWidgetRevision }));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.put("/:dashboardId/widgets/:widgetId/series/reorder", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
    if (!Array.isArray(b.order)) return res.status(400).json({ error: "invalidRequest", message: "order must be an array." });
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
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "invalidRequest", message: "expectedWidgetRevision is required." });
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

router.post("/:dashboardId/query", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid dashboardId." });
    const b = req.body || {};
    if (!validDate(b.dateFrom)) return res.status(400).json({ error: "invalidRequest", message: "dateFrom is required (YYYY-MM-DD)." });
    if (!validDate(b.dateTo)) return res.status(400).json({ error: "invalidRequest", message: "dateTo is required (YYYY-MM-DD)." });
    if (new Date(`${b.dateTo}T00:00:00Z`) < new Date(`${b.dateFrom}T00:00:00Z`)) return res.status(400).json({ error: "invalidRequest", message: "dateTo cannot be before dateFrom." });
    const spanDays = Math.round((new Date(`${b.dateTo}T00:00:00Z`) - new Date(`${b.dateFrom}T00:00:00Z`)) / 86400000) + 1;
    if (spanDays > MAX_QUERY_PERIOD_DAYS) return res.status(400).json({ error: "invalidRequest", message: `Period cannot exceed ${MAX_QUERY_PERIOD_DAYS} days.` });
    // athleteIds MAY be explicitly null (clears a dashboard default_filter/
    // local_filter_override athleteIds key back to "no restriction") —
    // only a PRESENT-and-not-null-and-not-a-valid-UUID-array value is
    // rejected.
    if (b.athleteIds !== undefined && b.athleteIds !== null && !validUuidArray(b.athleteIds)) return res.status(400).json({ error: "invalidRequest", message: "athleteIds must be an array of valid UUIDs (max 500), or null." });
    if (b.activityId !== undefined && b.activityId !== null && !validUuid(b.activityId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid activityId." });
    if (b.componentId !== undefined && b.componentId !== null && !validUuid(b.componentId)) return res.status(400).json({ error: "invalidRequest", message: "Invalid componentId." });
    if (b.widgetIds !== undefined && !validUuidArray(b.widgetIds)) return res.status(400).json({ error: "invalidRequest", message: "widgetIds must be an array of valid UUIDs (max 500)." });

    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const { dashboard, widgets } = await getDashboardDetail(req, dataWorkspace, req.params.dashboardId);

    // A dashboard's data is bound to ITS OWN data workspace — canViewDashboardRow
    // (used by getDashboardDetail) grants VISIBILITY based on manage rights
    // (e.g. a club admin who manages Club A can always SEE Club A's
    // dashboard), which is a broader condition than "the CURRENT active
    // workspace is the one this dashboard's data is bound to". Querying
    // must additionally require the latter — otherwise a manager of both
    // Club A and Club B could view Club A's dashboard structure while
    // active in Club B and have it silently execute against Club B's own
    // data. A system template (data_workspace_type IS NULL) has no data
    // workspace at all until cloned.
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
    // the dashboard's own default_filter; an EXPLICIT null overrides
    // (clears) it. See trainingLoadDashboardQuery.js's mergeFilters.
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
