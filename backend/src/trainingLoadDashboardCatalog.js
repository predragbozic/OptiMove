// Training Load Analysis Dashboard — dashboard lifecycle: list, detail,
// create, update metadata, clone, archive, and active-selection
// get/set/clear. Every WRITE below calls exactly one of the 15 sanctioned
// SQL functions from migrations_v2's v17 migration — never a raw INSERT/
// UPDATE/DELETE against training_load.dashboards/dashboard_active_
// selection — with ONE documented exception: cloneDashboard() below, a
// genuine multi-table composite transaction (1 dashboard + N widgets + N
// series, with live template-binding re-resolution) that cannot be
// expressed as a single set-based function call; see its own header
// comment for the guarantees it upholds in place of a sanctioned function.
// Pure service functions taking an already-resolved req/scope/context —
// routes/trainingLoadDashboard.js resolves workspace exactly once per
// request and threads the SAME snapshot through authorization, read, and
// write.
import { query, pool } from "./db.js";
import {
  canManageDashboardRow, canViewDashboardRow, dashboardVisibilitySql, dataWorkspaceMatches,
  resolveDashboardCreateContext,
} from "./trainingLoadDashboardAccess.js";
import { resolveTemplateSeriesForWorkspace } from "./trainingLoadDashboardWidgets.js";

function httpError(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status;
  if (code) e.code = code;
  return e;
}

// Deliberately the SAME 404 whether a dashboard doesn't exist or merely
// isn't visible to this account — knowing a valid UUID for someone else's
// private dashboard must not distinguish "not found" from "not yours".
async function fetchVisibleDashboard(req, dataWorkspace, dashboardId) {
  const r = await query(`select * from training_load.dashboards where id = $1`, [dashboardId]);
  const row = r.rows[0];
  if (!row || !canViewDashboardRow(req, row, dataWorkspace)) throw httpError(404, "Dashboard not found.");
  return row;
}

// ------------------------------------------------------------
// List / detail
// ------------------------------------------------------------

export async function listDashboards(req, dataWorkspace, { includeTemplates = true, includeArchived = false } = {}) {
  const params = [];
  const visSql = dashboardVisibilitySql(req, dataWorkspace, "d", params);
  const statusSql = includeArchived ? "true" : `d.status = 'active'`;
  const r = await query(
    `select d.id, d.name, d.description, d.owner_scope, d.owner_user_id, d.owner_club_id, d.owner_team_id,
            d.data_workspace_type, d.data_workspace_scope_id, d.is_template, d.status, d.cloned_from_dashboard_id,
            d.revision, d.created_by_user_id, d.created_at, d.updated_at
     from training_load.dashboards d
     where (${visSql}) and (${statusSql}) ${includeTemplates ? "" : "and d.is_template = false"}
     order by d.updated_at desc`,
    params,
  );
  return { dashboards: r.rows };
}

export async function getDashboardDetail(req, dataWorkspace, dashboardId) {
  const dashboard = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  const widgets = await query(
    `select id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, state, display_config, local_filter_override, revision
     from training_load.dashboard_widgets where dashboard_id = $1 order by widget_order`,
    [dashboardId],
  );
  const widgetIds = widgets.rows.map((w) => w.id);
  let seriesByWidget = new Map();
  if (widgetIds.length) {
    const series = await query(
      `select id, widget_id, series_order, metric_definition_id, built_in_series_key, template_metric_key_hints,
              resolution_status, template_resolution_candidates, axis, color, display_label, source_policy,
              source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period
       from training_load.dashboard_widget_series where widget_id = any($1::uuid[]) order by widget_id, series_order`,
      [widgetIds],
    );
    for (const s of series.rows) {
      if (!seriesByWidget.has(s.widget_id)) seriesByWidget.set(s.widget_id, []);
      seriesByWidget.get(s.widget_id).push(s);
    }
  }
  return {
    dashboard,
    widgets: widgets.rows.map((w) => ({ ...w, series: seriesByWidget.get(w.id) || [] })),
  };
}

// ------------------------------------------------------------
// Create / update / archive
// ------------------------------------------------------------

// The filter shape both dashboards.default_filter and dashboard_widgets.
// local_filter_override carry — three optional, independently-clearable
// keys. Validated the same way at every write site (dashboard metadata
// PATCH, widget create/update) so an invalid filter is always a clean 400,
// never a value that silently corrupts the query engine's own effective-
// filter merge (trainingLoadDashboardQuery.js's mergeFilters).
const FILTER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validFilterShape(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["athleteIds", "activityId", "componentId"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  if ("athleteIds" in value && value.athleteIds !== null && !(Array.isArray(value.athleteIds) && value.athleteIds.length <= 500 && value.athleteIds.every((v) => typeof v === "string" && FILTER_UUID_RE.test(v)))) return false;
  if ("activityId" in value && value.activityId !== null && !FILTER_UUID_RE.test(value.activityId)) return false;
  if ("componentId" in value && value.componentId !== null && !FILTER_UUID_RE.test(value.componentId)) return false;
  return true;
}

export async function createDashboard(req, body) {
  const ctx = await resolveDashboardCreateContext(req, body);
  if (ctx.error) throw httpError(ctx.status, ctx.error);
  if (!body?.name || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200) {
    throw httpError(400, "name is required (1-200 characters).");
  }
  const r = await query(
    `select * from training_load.create_dashboard($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [body.name, body.description ?? null, ctx.ownerScope, ctx.ownerUserId, ctx.ownerClubId, ctx.ownerTeamId, ctx.dataWorkspaceType, ctx.dataWorkspaceScopeId, ctx.isTemplate, req.user.id],
  );
  return { dashboard: r.rows[0] };
}

export async function updateDashboardMetadata(req, dataWorkspace, dashboardId, body) {
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  if (!canManageDashboardRow(req, row)) throw httpError(403, "Forbidden.");
  if (typeof body?.expectedRevision !== "number") throw httpError(400, "expectedRevision is required.");
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200)) {
    throw httpError(400, "name must be 1-200 characters.");
  }
  if (body.isTemplate !== undefined && typeof body.isTemplate !== "boolean") {
    throw httpError(400, "isTemplate must be a strict boolean.");
  }
  if (body.isTemplate === false && row.owner_scope === "system") {
    throw httpError(400, "A system dashboard is always a template.");
  }
  if (body.defaultFilter !== undefined && !validFilterShape(body.defaultFilter)) {
    throw httpError(400, "defaultFilter is invalid.");
  }
  try {
    const r = await query(
      `select * from training_load.update_dashboard_metadata($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        dashboardId, body.expectedRevision, body.name ?? null,
        body.description ?? null, body.clearDescription === true,
        body.defaultFilter ? JSON.stringify(body.defaultFilter) : null, body.clearDefaultFilter === true,
        body.isTemplate ?? null,
      ],
    );
    return { dashboard: r.rows[0] };
  } catch (error) {
    if (error?.code === "40001") throw httpError(409, "Stale revision — reload and retry.", "staleRevision");
    throw error;
  }
}

export async function archiveDashboard(req, dataWorkspace, dashboardId, { expectedRevision }) {
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  if (!canManageDashboardRow(req, row)) throw httpError(403, "Forbidden.");
  if (typeof expectedRevision !== "number") throw httpError(400, "expectedRevision is required.");
  const r = await query(`select * from training_load.archive_dashboard($1, $2)`, [dashboardId, expectedRevision]);
  return { dashboard: r.rows[0] };
}

// ------------------------------------------------------------
// Clone — the REAL clone service the design proof explicitly left as
// future application logic (DASHBOARD_MODEL_REPORT.md §0-R4.7): inserts
// the new dashboard (cloned_from_dashboard_id set, firing the real
// snapshot-semantics/lock trigger), copies every widget's layout/content,
// and for each series either copies a workspace-agnostic binding as-is
// (built-in, or a 'system'-scope metric) or genuinely RE-RESOLVES its
// template_metric_key_hints against the NEW dashboard's own data
// workspace (never trusting the template's own binding blindly) — a
// hint resolving to zero/one/many candidates lands the new series in
// 'unresolved'/'resolved'/'ambiguous' exactly like every other binding
// decision in this model. The whole operation is one transaction:
// either every widget/series lands, or none do.
// ------------------------------------------------------------
export async function cloneDashboard(req, dataWorkspace, templateId, body) {
  const template = await query(`select * from training_load.dashboards where id = $1`, [templateId]);
  if (!template.rowCount) throw httpError(404, "Template not found.");
  const templateRow = template.rows[0];
  if (!templateRow.is_template) throw httpError(400, "That dashboard is not a template.");
  if (!canViewDashboardRow(req, templateRow, dataWorkspace)) throw httpError(404, "Template not found.");

  // Pass the ALREADY-RESOLVED dataWorkspace (the route resolved it once,
  // for the canViewDashboardRow check just above) through to
  // resolveDashboardCreateContext, instead of letting its own 'user'
  // branch resolve it AGAIN — resolveActiveWorkspace() must be called
  // exactly once per request (finding #3 of the 3B2 corrective round). A
  // workspace-preference change racing mid-request can therefore never
  // hand this one request two disagreeing snapshots.
  const ctx = await resolveDashboardCreateContext(req, { ...body, ownerScope: body?.ownerScope ?? "user" }, dataWorkspace);
  if (ctx.error) throw httpError(ctx.status, ctx.error);
  const name = body?.name || `${templateRow.name} (copy)`;
  if (name.length > 200) throw httpError(400, "name must be at most 200 characters.");

  const c = await pool.connect();
  try {
    await c.query("begin");
    // The dashboard/widget/series inserts below are ONE documented,
    // explicit composite-transaction exception to the "every write goes
    // through a sanctioned SQL function" rule (see v17's own header note
    // on create_dashboard/update_dashboard_metadata) — clone is
    // inherently a multi-table operation (1 dashboard + N widgets + N
    // series) with live template-binding re-resolution baked in, which
    // cannot be expressed as a single set-based function call. Source-
    // dashboard locking happens via dashboards_validate_clone_provenance's
    // own `FOR SHARE` (fired by THIS insert, before any widget/series row
    // is read below) — genuinely dashboard-first, same lock-order
    // discipline as every sanctioned function. ctx.isTemplate (never a
    // hardcoded false) lets a clone become a NEW template in its own
    // target owner scope, exactly like a fresh create — already gated by
    // the SAME manage-rights check resolveDashboardCreateContext applies
    // to every owner scope.
    const dash = await c.query(
      `insert into training_load.dashboards (name, description, owner_scope, owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id, is_template, created_by_user_id, cloned_from_dashboard_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [name, templateRow.description, ctx.ownerScope, ctx.ownerUserId, ctx.ownerClubId, ctx.ownerTeamId, ctx.dataWorkspaceType, ctx.dataWorkspaceScopeId, ctx.isTemplate, req.user.id, templateId],
    );
    const newDashboard = dash.rows[0];

    const widgets = await c.query(`select * from training_load.dashboard_widgets where dashboard_id = $1 order by widget_order`, [templateId]);
    const widgetIdMap = new Map();
    for (const w of widgets.rows) {
      const nw = await c.query(
        `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, state, display_config, local_filter_override)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [newDashboard.id, w.widget_type, w.title, w.widget_order, w.x, w.y, w.width, w.height, w.mobile_order, w.group_by, w.state, w.display_config, w.local_filter_override],
      );
      widgetIdMap.set(w.id, nw.rows[0].id);
    }

    const series = await c.query(`select * from training_load.dashboard_widget_series where widget_id = any($1::uuid[]) order by series_order`, [widgets.rows.map((w) => w.id)]);
    const cloneReport = [];
    for (const s of series.rows) {
      const newWidgetId = widgetIdMap.get(s.widget_id);
      const common = [newWidgetId, s.series_order, s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period];
      if (s.built_in_series_key) {
        await c.query(
          `insert into training_load.dashboard_widget_series (widget_id, series_order, built_in_series_key, resolution_status, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
           values ($1,$2,$3,'resolved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [newWidgetId, s.series_order, s.built_in_series_key, s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id],
        );
        cloneReport.push({ sourceSeriesId: s.id, resolution: "built_in" });
        continue;
      }
      if (s.template_metric_key_hints) {
        // Genuine re-resolution against the NEW dashboard's own workspace
        // — the template's own (possibly stale, possibly workspace-
        // agnostic) binding is never trusted directly.
        const resolved = await resolveTemplateSeriesForWorkspace(c, {
          hints: s.template_metric_key_hints,
          dataWorkspaceType: ctx.dataWorkspaceType, dataWorkspaceScopeId: ctx.dataWorkspaceScopeId, ownerUserId: ctx.ownerUserId,
        });
        await c.query(
          `insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, template_metric_key_hints, resolution_status, template_resolution_candidates, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            newWidgetId, s.series_order,
            resolved.status === "resolved" ? resolved.candidateIds[0] : null,
            // s.template_metric_key_hints was deserialized to a real JS
            // array by pg on the SELECT above — must be re-stringified
            // before being re-inserted as a jsonb value, or `pg` silently
            // encodes it as a Postgres ARRAY literal instead of JSON
            // (22P02 invalid input syntax for type json). This is exactly
            // the ambiguous/unresolved clone path the 3B2 corrective round
            // added real coverage for — no prior passing test exercised a
            // template_metric_key_hints-based clone.
            JSON.stringify(s.template_metric_key_hints),
            resolved.status,
            resolved.status === "ambiguous" ? JSON.stringify(resolved.candidateIds) : null,
            s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id,
          ],
        );
        cloneReport.push({ sourceSeriesId: s.id, resolution: resolved.status });
        continue;
      }
      // A plain resolved series with no hints at all (e.g. bound to a
      // 'system'-scope metric, visible everywhere) — copy the binding
      // as-is; the metric-visibility/active-state/type-compat triggers
      // still re-validate it live against the NEW dashboard.
      await c.query(
        `insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, resolution_status, axis, color, display_label, source_policy, source_connection_id, data_scope_level, analytical_aggregation, aggregation_role_policy, coverage_policy, comparison_period, created_by_user_id)
         values ($1,$2,$3,'resolved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [newWidgetId, s.series_order, s.metric_definition_id, s.axis, s.color, s.display_label, s.source_policy, s.source_connection_id, s.data_scope_level, s.analytical_aggregation, s.aggregation_role_policy, s.coverage_policy, s.comparison_period, req.user.id],
      );
      cloneReport.push({ sourceSeriesId: s.id, resolution: "copied" });
    }
    await c.query("commit");
    return { dashboard: newDashboard, cloneReport };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

// ------------------------------------------------------------
// Active dashboard selection.
// ------------------------------------------------------------

export async function getActiveDashboard(req, dataWorkspace) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const scopeId = dataWorkspace.dataWorkspaceScopeId ?? null;
  const r = await query(
    `select s.dashboard_id, d.name, d.revision, d.status
     from training_load.dashboard_active_selection s
     join training_load.dashboards d on d.id = s.dashboard_id
     where s.user_id = $1 and s.workspace_type = $2 and s.scope_id is not distinct from $3`,
    [req.user.id, dataWorkspace.dataWorkspaceType, scopeId],
  );
  return { activeDashboard: r.rows[0] || null };
}

export async function setActiveDashboard(req, dataWorkspace, dashboardId) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const row = await fetchVisibleDashboard(req, dataWorkspace, dashboardId);
  if (!dataWorkspaceMatches(dataWorkspace, row)) throw httpError(400, "That dashboard does not belong to your current data workspace.");
  try {
    const r = await query(
      `select * from training_load.set_active_dashboard($1, $2, $3, $4)`,
      [req.user.id, dataWorkspace.dataWorkspaceType, dataWorkspace.dataWorkspaceScopeId ?? null, dashboardId],
    );
    return { selection: r.rows[0] };
  } catch (error) {
    if (error?.code === "P0001") throw httpError(409, "That dashboard cannot be selected as active for this workspace.", "selectionRejected");
    throw error;
  }
}

export async function clearActiveDashboard(req, dataWorkspace) {
  if (dataWorkspace.type === null) throw httpError(403, "No active workspace.");
  const r = await query(
    `select * from training_load.clear_active_dashboard($1, $2, $3)`,
    [req.user.id, dataWorkspace.dataWorkspaceType, dataWorkspace.dataWorkspaceScopeId ?? null],
  );
  return { cleared: r.rows[0]?.cleared === true };
}

export { httpError };
