// Training Load Analysis Dashboard — widgets, series, and layout. Every
// WRITE below calls exactly one of the 15 sanctioned SQL functions
// (migrations_v2 v17) — never a raw INSERT/UPDATE/DELETE against
// dashboard_widgets/dashboard_widget_series. Pure service functions
// taking an already-resolved dashboard row (the caller — routes/
// trainingLoadDashboard.js — has already authorized it via
// canManageDashboardRow before any of these are reached).
import { query } from "./db.js";
import { isMetricVisibleToDashboard, isSourceConnectionVisibleToDashboard } from "./trainingLoadDashboardAccess.js";

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
// Deliberately NEVER forwards the raw DB message to the caller — every
// trigger/function message in this schema can name internal ids, table
// names, or another workspace's owner_scope/club/team, none of which may
// ever reach an HTTP client (see routes/trainingLoadDashboard.js's
// respondToServiceError, which applies the same rule to every OTHER raw
// pg error that reaches the route layer without having gone through this
// function first).
function toStaleOrRaise(error) {
  if (error?.code === "40001") throw httpError(409, "Stale revision — reload and retry.", "staleRevision");
  // '40002' — training_load.assert_dashboard_writable() (v17), the archived-
  // dashboard read-only gate every dashboard-hierarchy-mutating sanctioned
  // function now calls right after locking the dashboard row.
  if (error?.code === "40002") throw httpError(409, "This dashboard is archived and is read-only.", "dashboardArchived");
  if (error?.code === "P0001") throw httpError(400, "Invalid request.", "invalidRequest");
  throw error;
}

async function assertOwnsWidget(dashboardId, widgetId) {
  const r = await query(`select 1 from training_load.dashboard_widgets where id = $1 and dashboard_id = $2`, [widgetId, dashboardId]);
  if (!r.rowCount) throw httpError(404, "Widget not found on this dashboard.");
}

// Application-layer pre-checks (finding #7 of the 3B2 corrective round) —
// mirror the exact DB trigger visibility predicate so a foreign or
// nonexistent metric/source-connection reference maps to a clean,
// info-hiding 404 HERE, before ever reaching the trigger (whose own
// message must never reach the client). A metric must also be ACTIVE —
// same "may only be NEWLY bound to an active metric" rule the trigger
// itself enforces.
async function assertMetricReferenceOk(dashboardRow, metricDefinitionId) {
  if (!metricDefinitionId) return;
  const { visible, def } = await isMetricVisibleToDashboard(dashboardRow, metricDefinitionId);
  if (!visible || !def || def.state !== "active") throw httpError(404, "Metric not found.");
}
async function assertSourceConnectionReferenceOk(dashboardRow, sourceConnectionId) {
  if (!sourceConnectionId) return;
  const { visible, conn } = await isSourceConnectionVisibleToDashboard(dashboardRow, sourceConnectionId);
  // Nonexistent, foreign, AND inactive/archived all collapse to the SAME
  // info-hiding 404 — an inactive connection's mere existence (and its
  // active/inactive state) is not something a caller who can't otherwise
  // see it should be able to distinguish either.
  if (!visible || !conn || conn.state !== "active") throw httpError(404, "Source connection not found.");
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
      // SET-BASED scope-capability filter — ONE query for every remaining
      // candidate's own capability rows, never one (or two) queries PER
      // candidate. This used to be the resolver's own N+1: a template
      // hint with scopeLevel set, matching K candidates, issued up to 2*K
      // extra queries here; now it issues exactly one, regardless of K
      // (merge-readiness corrective round, finding #9).
      if (hint.scopeLevel && rows.length) {
        const capRows = await q(
          `select metric_definition_id, scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = any($1::uuid[])`,
          [rows.map((r) => r.id)],
        );
        const capsByDefinition = new Map();
        for (const cap of capRows.rows) {
          if (!capsByDefinition.has(cap.metric_definition_id)) capsByDefinition.set(cap.metric_definition_id, new Set());
          capsByDefinition.get(cap.metric_definition_id).add(cap.scope_level);
        }
        rows = rows.filter((r) => {
          const caps = capsByDefinition.get(r.id);
          if (!caps || caps.size === 0) return true; // no capability rows configured -> not blocked, same rule as the live DB trigger
          return caps.has(hint.scopeLevel);
        });
      }
    }
    if (rows.length === 0) continue;
    if (rows.length === 1) return { status: "resolved", candidateIds: [rows[0].id] };
    // 2+ equally-valid candidates — the DB's own resolution_status CHECK
    // only allows 'resolved'/'unresolved'/'ambiguous' (dashboard_widget_
    // widget_series, v16); this must be 'ambiguous', never a made-up
    // fourth status, and never an auto-picked winner.
    return { status: "ambiguous", candidateIds: rows.map((r) => r.id) };
  }
  return { status: "unresolved", candidateIds: [] };
}

// Portable template-series contract (merge-readiness corrective round,
// finding #6). A metric-backed series added to a TEMPLATE dashboard
// (system/club/team is_template=true) always carries a structured
// template_metric_key_hints snapshot ALONGSIDE its real metric_
// definition_id — the template keeps working immediately (the real
// binding resolves it), but a later clone into a DIFFERENT workspace can
// genuinely re-resolve the metric there instead of raw-copying a source
// UUID that may not even exist in the target workspace (previously: a
// direct metric_definition_id with no hints was copied as-is by
// cloneDashboard() and could only ever fail with a generic, detail-
// leaking DB trigger 400 in the target workspace). The table's own CHECK
// on dashboard_widget_series does not forbid metric_definition_id and
// template_metric_key_hints being set together — only the ABSENCE of
// both requires hints (v16) — so this is a legal 'resolved' row.
async function snapshotMetricHint(metricDefinitionId, scopeLevel) {
  const r = await query(
    `select d.key, mdv.value_type, mdv.unit
     from training_load.metric_definitions d
     join training_load.metric_definition_versions mdv on mdv.id = d.current_version_id
     where d.id = $1`,
    [metricDefinitionId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return [{ key: row.key, valueType: row.value_type, unit: row.unit, scopeLevel: scopeLevel ?? "session" }];
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
  // PATCH semantics (merge-readiness corrective round, finding #7) —
  // exactly one rule, no client-facing clear flag: an ABSENT key means no
  // change; an explicit `null` means clear; any other value means
  // replace. The SQL function's own p_clear_local_filter_override
  // parameter stays (an internal JS<->SQL contract, not a client-facing
  // field) — it is DERIVED here from hasOwnProperty+null, never read
  // directly off the request body.
  const hasLocalFilterOverride = Object.prototype.hasOwnProperty.call(body, "localFilterOverride");
  const clearLocalFilterOverride = hasLocalFilterOverride && body.localFilterOverride === null;
  try {
    const r = await query(
      `select * from training_load.update_widget_content($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        widgetId, body.expectedWidgetRevision, body.widgetType ?? null, body.title ?? null, body.groupBy ?? null,
        body.state ?? null, body.displayConfig ? JSON.stringify(body.displayConfig) : null,
        body.localFilterOverride ? JSON.stringify(body.localFilterOverride) : null, clearLocalFilterOverride,
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

export async function addSeries(dashboardId, widgetId, body, createdByUserId, dashboardRow) {
  await assertOwnsWidget(dashboardId, widgetId);
  await assertMetricReferenceOk(dashboardRow, body.metricDefinitionId);
  await assertSourceConnectionReferenceOk(dashboardRow, body.sourceConnectionId);
  // A built-in series has no Metrics-Core provenance concept at all — the
  // table's own CHECK requires source_policy='not_applicable' (and no
  // source_connection_id) whenever built_in_series_key is set, so the
  // general 'all_with_conflicts' default is wrong specifically for this
  // case and must never be applied to it.
  const defaultSourcePolicy = body.builtInSeriesKey ? "not_applicable" : "all_with_conflicts";
  let templateMetricKeyHints = body.templateMetricKeyHints ?? null;
  if (dashboardRow?.is_template && body.metricDefinitionId && !templateMetricKeyHints) {
    templateMetricKeyHints = await snapshotMetricHint(body.metricDefinitionId, body.dataScopeLevel);
  }
  try {
    const r = await query(
      `select * from training_load.add_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        widgetId, body.expectedWidgetRevision, body.seriesOrder,
        body.metricDefinitionId ?? null, body.builtInSeriesKey ?? null,
        templateMetricKeyHints ? JSON.stringify(templateMetricKeyHints) : null,
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

export async function updateSeries(dashboardId, widgetId, seriesId, body, dashboardRow) {
  await assertOwnsWidget(dashboardId, widgetId);
  if (body.sourceConnectionId) await assertSourceConnectionReferenceOk(dashboardRow, body.sourceConnectionId);
  // Same absent/null/value PATCH semantics as updateWidgetContent above —
  // derived, never client-facing.
  const hasComparisonPeriod = Object.prototype.hasOwnProperty.call(body, "comparisonPeriod");
  const clearComparisonPeriod = hasComparisonPeriod && body.comparisonPeriod === null;
  try {
    const r = await query(
      `select * from training_load.update_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        seriesId, widgetId, body.expectedWidgetRevision,
        body.axis ?? null, body.color ?? null, body.displayLabel ?? null,
        body.sourcePolicy ?? null, body.sourceConnectionId ?? null,
        body.dataScopeLevel ?? null, body.analyticalAggregation ?? null,
        body.aggregationRolePolicy ?? null, body.coveragePolicy ?? null,
        body.comparisonPeriod ?? null, clearComparisonPeriod,
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

export async function resolveSeriesBinding(dashboardId, widgetId, seriesId, { expectedWidgetRevision, metricDefinitionId }, dashboardRow) {
  await assertOwnsWidget(dashboardId, widgetId);
  await assertMetricReferenceOk(dashboardRow, metricDefinitionId);
  try {
    const r = await query(`select * from training_load.resolve_series_binding($1, $2, $3, $4)`, [seriesId, widgetId, expectedWidgetRevision, metricDefinitionId]);
    return { seriesId: r.rows[0].series_id, widgetRevision: r.rows[0].widget_revision };
  } catch (error) {
    return toStaleOrRaise(error);
  }
}
