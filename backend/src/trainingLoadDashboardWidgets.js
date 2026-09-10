// Training Load Analysis Dashboard — widgets, series, and layout. Every
// WRITE below calls exactly one of the 13 sanctioned SQL functions
// (migrations_v2 v17) — never a raw INSERT/UPDATE/DELETE against
// dashboard_widgets/dashboard_widget_series. Pure service functions
// taking an already-resolved dashboard row (the caller — routes/
// trainingLoadDashboard.js — has already authorized it via
// canManageDashboardRow before any of these are reached).
import { query } from "./db.js";

function httpError(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status;
  if (code) e.code = code;
  return e;
}

// Every sanctioned function's own stale-revision RAISE explicitly sets
// `errcode = '40001'` (a real SQLSTATE, "serialization_failure" family) —
// deliberately distinct from the generic 'P0001' (plain RAISE EXCEPTION)
// every OTHER business-rule violation in this schema uses, so the two
// can be told apart here without any string matching on the message.
function toStaleOrRaise(error) {
  if (error?.code === "40001") throw httpError(409, error.message, "STALE_REVISION");
  if (error?.code === "P0001") throw httpError(400, error.message);
  throw error;
}

async function assertOwnsWidget(dashboardId, widgetId) {
  const r = await query(`select 1 from training_load.dashboard_widgets where id = $1 and dashboard_id = $2`, [widgetId, dashboardId]);
  if (!r.rowCount) throw httpError(404, "Widget not found on this dashboard.");
}

// ------------------------------------------------------------
// Real template-hint resolution against the CURRENT catalog — mirrors
// the design proof's own resolveTemplateHint() (test-harness.mjs) byte-
// faithfully, now against the real training_load.metric_definitions /
// metric_definition_versions / metric_definition_scope_capabilities
// tables. `runQuery` lets a caller pass either the pooled query() (a
// standalone resolve call) or a transactional client's own bound query
// (cloneDashboard, so resolution participates in the clone's own
// atomic transaction).
// ------------------------------------------------------------
export async function resolveTemplateSeriesForWorkspace(runQuery, { hints, dataWorkspaceType, dataWorkspaceScopeId, ownerUserId }) {
  const q = runQuery.query ? runQuery.query.bind(runQuery) : runQuery;
  for (const hint of hints) {
    const key = typeof hint === "string" ? hint : hint.key;
    const candidates = await q(
      `select d.id, d.owner_scope, d.owner_club_id, d.owner_team_id, d.owner_user_id, mdv.value_type, mdv.unit
       from training_load.metric_definitions d
       join training_load.metric_definition_versions mdv on mdv.id = d.current_version_id
       where d.key = $1 and d.state = 'active'
         and (
           d.owner_scope = 'system'
           or (d.owner_scope = 'club' and $2 = 'club' and d.owner_club_id = $3)
           or (d.owner_scope = 'team' and $2 = 'team' and d.owner_team_id = $3)
           or (d.owner_scope = 'user' and d.owner_user_id = $4)
         )`,
      [key, dataWorkspaceType, dataWorkspaceScopeId, ownerUserId],
    );
    let rows = candidates.rows;
    if (typeof hint === "object") {
      if (hint.valueType) rows = rows.filter((r) => r.value_type === hint.valueType);
      if (Object.prototype.hasOwnProperty.call(hint, "unit")) rows = rows.filter((r) => r.unit === hint.unit);
      if (hint.scopeLevel) {
        const kept = [];
        for (const r of rows) {
          const hasAny = await q(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 limit 1`, [r.id]);
          if (hasAny.rowCount === 0) { kept.push(r); continue; }
          const matches = await q(`select 1 from training_load.metric_definition_scope_capabilities where metric_definition_id=$1 and scope_level=$2`, [r.id, hint.scopeLevel]);
          if (matches.rowCount > 0) kept.push(r);
        }
        rows = kept;
      }
    }
    if (rows.length === 0) continue;
    if (rows.length === 1) return { status: "resolved", candidateIds: [rows[0].id] };
    return { status: "needs_resolution", candidateIds: rows.map((r) => r.id) };
  }
  return { status: "unresolved", candidateIds: [] };
}

// ------------------------------------------------------------
// Layout.
// ------------------------------------------------------------

export async function replaceLayout(dashboardId, { expectedRevision, layout }) {
  try {
    const r = await query(`select * from training_load.replace_dashboard_layout($1, $2, $3)`, [dashboardId, expectedRevision, JSON.stringify(layout)]);
    return { widgets: r.rows };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function updateWidgetLayout(dashboardId, widgetId, { expectedWidgetRevision, x, y, width, height, mobileOrder }) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(`select * from training_load.update_widget_layout($1,$2,$3,$4,$5,$6,$7)`, [widgetId, expectedWidgetRevision, x, y, width, height, mobileOrder]);
    return { widget: r.rows[0] };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

// ------------------------------------------------------------
// Widgets.
// ------------------------------------------------------------

export async function createWidget(dashboardId, { expectedDashboardRevision, widgetType, title, widgetOrder, x, y, width, height, mobileOrder, groupBy, displayConfig, localFilterOverride }) {
  try {
    const r = await query(
      `select * from training_load.create_widget($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [dashboardId, expectedDashboardRevision, widgetType, title, widgetOrder, x, y, width, height, mobileOrder, groupBy ?? "day", displayConfig ? JSON.stringify(displayConfig) : null, localFilterOverride ? JSON.stringify(localFilterOverride) : null],
    );
    return { widgetId: r.rows[0].widget_id, dashboardRevision: r.rows[0].dashboard_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function updateWidgetContent(dashboardId, widgetId, body) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(
      `select * from training_load.update_widget_content($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        widgetId, body.expectedWidgetRevision, body.widgetType ?? null, body.title ?? null, body.groupBy ?? null,
        body.state ?? null, body.displayConfig ? JSON.stringify(body.displayConfig) : null,
        body.localFilterOverride ? JSON.stringify(body.localFilterOverride) : null, body.clearLocalFilterOverride === true,
      ],
    );
    return { widget: r.rows[0] };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function deleteWidget(dashboardId, widgetId, { expectedWidgetRevision }) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(`select * from training_load.delete_widget($1, $2)`, [widgetId, expectedWidgetRevision]);
    return { dashboard: r.rows[0] };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

// ------------------------------------------------------------
// Series.
// ------------------------------------------------------------

export async function addSeries(dashboardId, widgetId, body, createdByUserId) {
  await assertOwnsWidget(dashboardId, widgetId);
  // A built-in series has no Metrics-Core provenance concept at all — the
  // table's own CHECK requires source_policy='not_applicable' (and no
  // source_connection_id) whenever built_in_series_key is set, so the
  // general 'all_with_conflicts' default is wrong specifically for this
  // case and must never be applied to it.
  const defaultSourcePolicy = body.builtInSeriesKey ? "not_applicable" : "all_with_conflicts";
  try {
    const r = await query(
      `select * from training_load.add_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        widgetId, body.expectedWidgetRevision, body.seriesOrder,
        body.metricDefinitionId ?? null, body.builtInSeriesKey ?? null,
        body.templateMetricKeyHints ? JSON.stringify(body.templateMetricKeyHints) : null,
        body.resolutionStatus ?? "resolved", body.templateResolutionCandidates ? JSON.stringify(body.templateResolutionCandidates) : null,
        body.axis ?? "primary", body.color ?? null, body.displayLabel ?? null,
        body.sourcePolicy ?? defaultSourcePolicy, body.sourceConnectionId ?? null,
        body.dataScopeLevel ?? "session", body.analyticalAggregation ?? "sum",
        body.aggregationRolePolicy ?? "standalone_and_source_rollup", body.coveragePolicy ?? "complete_and_partial",
        body.comparisonPeriod ?? null, createdByUserId,
      ],
    );
    return { seriesId: r.rows[0].series_id, widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function updateSeries(dashboardId, widgetId, seriesId, body) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(
      `select * from training_load.update_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        seriesId, widgetId, body.expectedWidgetRevision,
        body.axis ?? null, body.color ?? null, body.displayLabel ?? null,
        body.sourcePolicy ?? null, body.sourceConnectionId ?? null,
        body.dataScopeLevel ?? null, body.analyticalAggregation ?? null,
        body.aggregationRolePolicy ?? null, body.coveragePolicy ?? null,
        body.comparisonPeriod ?? null, body.clearComparisonPeriod === true,
      ],
    );
    return { seriesId: r.rows[0].series_id, widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function deleteSeries(dashboardId, widgetId, seriesId, { expectedWidgetRevision }) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(`select * from training_load.delete_series($1, $2, $3)`, [seriesId, widgetId, expectedWidgetRevision]);
    return { widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function reorderSeries(dashboardId, widgetId, { expectedWidgetRevision, order }) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(`select * from training_load.reorder_series($1, $2, $3)`, [widgetId, expectedWidgetRevision, JSON.stringify(order)]);
    return { widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}

export async function resolveSeriesBinding(dashboardId, widgetId, seriesId, { expectedWidgetRevision, metricDefinitionId }) {
  await assertOwnsWidget(dashboardId, widgetId);
  try {
    const r = await query(`select * from training_load.resolve_series_binding($1, $2, $3, $4)`, [seriesId, widgetId, expectedWidgetRevision, metricDefinitionId]);
    return { seriesId: r.rows[0].series_id, widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}
