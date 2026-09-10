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
import { resolveActiveDataWorkspace, canManageDashboardRow } from "../trainingLoadDashboardAccess.js";
import {
  listDashboards, getDashboardDetail, createDashboard, updateDashboardMetadata, archiveDashboard, cloneDashboard,
  getActiveDashboard, setActiveDashboard, clearActiveDashboard, httpError,
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

function respondToServiceError(res, next, error) {
  if (error?.httpStatus) return res.status(error.httpStatus).json({ error: error.message, code: error.code });
  if (error?.code === "P0001") return res.status(400).json({ error: error.message });
  if (error?.code === "23505") return res.status(409).json({ error: "This was already submitted." });
  return next(error);
}

// Resolved ONCE per request, reused everywhere below.
async function requireDataWorkspace(req, res) {
  const dataWorkspace = await resolveActiveDataWorkspace(req);
  if (dataWorkspace.type === null) {
    res.status(403).json({ error: "No active workspace." });
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
  if (!row) { res.status(404).json({ error: "Dashboard not found." }); return null; }
  if (!canManageDashboardRow(req, row)) { res.status(404).json({ error: "Dashboard not found." }); return null; }
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
    if (!validUuid(req.body?.dashboardId)) return res.status(400).json({ error: "dashboardId is required." });
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
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
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
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.status(201).json(await cloneDashboard(req, dataWorkspace, req.params.dashboardId, req.body || {}));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    res.json(await updateDashboardMetadata(req, dataWorkspace, req.params.dashboardId, req.body || {}));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.post("/:dashboardId/archive", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
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
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
    if (typeof req.body?.expectedRevision !== "number") return res.status(400).json({ error: "expectedRevision is required." });
    if (!Array.isArray(req.body?.layout)) return res.status(400).json({ error: "layout must be an array." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
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
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
    const b = req.body || {};
    if (typeof b.expectedDashboardRevision !== "number") return res.status(400).json({ error: "expectedDashboardRevision is required." });
    if (typeof b.widgetType !== "string") return res.status(400).json({ error: "widgetType is required." });
    if (typeof b.title !== "string" || !b.title.length) return res.status(400).json({ error: "title is required." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "Invalid id." });
    if (typeof req.body?.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
    if (typeof b.seriesOrder !== "number") return res.status(400).json({ error: "seriesOrder is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.status(201).json(await addSeries(req.params.dashboardId, req.params.widgetId, b, req.user.id));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.patch("/:dashboardId/widgets/:widgetId/series/:seriesId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await updateSeries(req.params.dashboardId, req.params.widgetId, req.params.seriesId, b));
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

router.delete("/:dashboardId/widgets/:widgetId/series/:seriesId", async (req, res, next) => {
  try {
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "Invalid id." });
    if (typeof req.body?.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
    if (!Array.isArray(b.order)) return res.status(400).json({ error: "order must be an array." });
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
    if (!validUuid(req.params.dashboardId) || !validUuid(req.params.widgetId) || !validUuid(req.params.seriesId)) return res.status(400).json({ error: "Invalid id." });
    const b = req.body || {};
    if (typeof b.expectedWidgetRevision !== "number") return res.status(400).json({ error: "expectedWidgetRevision is required." });
    if (!validUuid(b.metricDefinitionId)) return res.status(400).json({ error: "metricDefinitionId is required." });
    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    if (!(await requireManageableDashboard(req, res, dataWorkspace, req.params.dashboardId))) return;
    res.json(await resolveSeriesBinding(req.params.dashboardId, req.params.widgetId, req.params.seriesId, { expectedWidgetRevision: b.expectedWidgetRevision, metricDefinitionId: b.metricDefinitionId }));
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
    if (!validUuid(req.params.dashboardId)) return res.status(400).json({ error: "Invalid dashboardId." });
    const b = req.body || {};
    if (!validDate(b.dateFrom)) return res.status(400).json({ error: "dateFrom is required (YYYY-MM-DD)." });
    if (!validDate(b.dateTo)) return res.status(400).json({ error: "dateTo is required (YYYY-MM-DD)." });
    if (new Date(`${b.dateTo}T00:00:00Z`) < new Date(`${b.dateFrom}T00:00:00Z`)) return res.status(400).json({ error: "dateTo cannot be before dateFrom." });
    const spanDays = Math.round((new Date(`${b.dateTo}T00:00:00Z`) - new Date(`${b.dateFrom}T00:00:00Z`)) / 86400000) + 1;
    if (spanDays > MAX_QUERY_PERIOD_DAYS) return res.status(400).json({ error: `Period cannot exceed ${MAX_QUERY_PERIOD_DAYS} days.` });
    if (b.athleteIds !== undefined && !validUuidArray(b.athleteIds)) return res.status(400).json({ error: "athleteIds must be an array of valid UUIDs (max 500)." });
    if (b.activityId !== undefined && b.activityId !== null && !validUuid(b.activityId)) return res.status(400).json({ error: "Invalid activityId." });
    if (b.componentId !== undefined && b.componentId !== null && !validUuid(b.componentId)) return res.status(400).json({ error: "Invalid componentId." });
    if (b.widgetIds !== undefined && !validUuidArray(b.widgetIds)) return res.status(400).json({ error: "widgetIds must be an array of valid UUIDs (max 500)." });

    const dataWorkspace = await requireDataWorkspace(req, res);
    if (!dataWorkspace) return;
    const { dashboard, widgets } = await getDashboardDetail(req, dataWorkspace, req.params.dashboardId);
    const targetWidgets = b.widgetIds ? widgets.filter((w) => b.widgetIds.includes(w.id)) : widgets;
    if (targetWidgets.length > MAX_WIDGETS_PER_QUERY) return res.status(400).json({ error: `Cannot query more than ${MAX_WIDGETS_PER_QUERY} widgets at once.` });

    const result = await queryDashboard(dataWorkspaceQueryArgs(dataWorkspace), targetWidgets, {
      dateFrom: b.dateFrom, dateTo: b.dateTo, athleteIds: b.athleteIds, activityId: b.activityId ?? null, componentId: b.componentId ?? null,
    });
    res.json({ dashboardRevision: dashboard.revision, widgets: result });
  } catch (error) {
    respondToServiceError(res, next, error);
  }
});

export default router;
