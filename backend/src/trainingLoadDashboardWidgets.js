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
// Real BATCH template-hint resolution against the CURRENT catalog —
// mirrors the design proof's own resolveTemplateHint() (test-harness.mjs)
// semantics per series, but resolves EVERY hint-bearing series of a clone
// in one pass (merge-readiness corrective round, finding #6). `runQuery`
// lets a caller pass either the pooled query() (a standalone resolve
// call) or a transactional client's own bound query (cloneDashboard, so
// resolution participates in the clone's own atomic transaction).
//
// `seriesSpecs` — an array of `{ sourceSeriesId, hints }`, one entry per
// hint-bearing series being cloned. Exactly TWO set-based SQL statements
// resolve the WHOLE batch, regardless of how many series or hints it
// holds: one candidate-definitions query covering every DISTINCT key any
// hint in the batch names, and one scope-capabilities query covering
// every candidate definition that query found. Everything past that is
// pure in-memory filtering — per-series fallback order (try hint[0],
// fall through to hint[1], ... on zero matches) is preserved exactly,
// and a series's OWN candidate set is only ever assembled from
// candidates that already passed the workspace-visibility predicate in
// the first query — never a wider set than the equivalent per-series
// resolution would have produced.
// ------------------------------------------------------------
export async function resolveTemplateSeriesBatchForWorkspace(runQuery, seriesSpecs, { dataWorkspaceType, dataWorkspaceScopeId, ownerUserId }) {
  const q = runQuery.query ? runQuery.query.bind(runQuery) : runQuery;
  const results = new Map();
  const allKeys = new Set();
  for (const spec of seriesSpecs) {
    for (const hint of spec.hints) {
      allKeys.add(typeof hint === "string" ? hint : hint.key);
    }
  }
  if (allKeys.size === 0) {
    for (const spec of seriesSpecs) results.set(spec.sourceSeriesId, { status: "unresolved", candidateIds: [] });
    return results;
  }

  // Statement 1/2: every candidate definition for every distinct key this
  // batch could possibly need, already filtered by workspace visibility.
  const candidateRows = await q(
    `select d.id, d.key, mdv.value_type, mdv.unit
     from training_load.metric_definitions d
     join training_load.metric_definition_versions mdv on mdv.id = d.current_version_id
     where d.key = any($1::text[]) and d.state = 'active'
       and (
         d.owner_scope = 'system'
         or (d.owner_scope = 'club' and $2 = 'club' and d.owner_club_id = $3)
         or (d.owner_scope = 'team' and $2 = 'team' and d.owner_team_id = $3)
         or (d.owner_scope = 'user' and d.owner_user_id = $4)
       )`,
    [[...allKeys], dataWorkspaceType, dataWorkspaceScopeId, ownerUserId],
  );
  const candidatesByKey = new Map();
  for (const row of candidateRows.rows) {
    if (!candidatesByKey.has(row.key)) candidatesByKey.set(row.key, []);
    candidatesByKey.get(row.key).push(row);
  }

  // Statement 2/2: every scope-capability row for every candidate the
  // first query found — one query, not one per hint or per candidate.
  const capsByDefinition = new Map();
  const allCandidateIds = candidateRows.rows.map((r) => r.id);
  if (allCandidateIds.length) {
    const capRows = await q(
      `select metric_definition_id, scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = any($1::uuid[])`,
      [allCandidateIds],
    );
    for (const cap of capRows.rows) {
      if (!capsByDefinition.has(cap.metric_definition_id)) capsByDefinition.set(cap.metric_definition_id, new Set());
      capsByDefinition.get(cap.metric_definition_id).add(cap.scope_level);
    }
  }

  for (const spec of seriesSpecs) {
    let outcome = { status: "unresolved", candidateIds: [] };
    for (const hint of spec.hints) {
      const key = typeof hint === "string" ? hint : hint.key;
      let rows = candidatesByKey.get(key) || [];
      if (typeof hint === "object") {
        if (hint.valueType) rows = rows.filter((r) => r.value_type === hint.valueType);
        if (Object.prototype.hasOwnProperty.call(hint, "unit")) rows = rows.filter((r) => r.unit === hint.unit);
        if (hint.scopeLevel) {
          rows = rows.filter((r) => {
            const caps = capsByDefinition.get(r.id);
            if (!caps || caps.size === 0) return true; // no capability rows configured -> not blocked, same rule as the live DB trigger
            return caps.has(hint.scopeLevel);
          });
        }
      }
      if (rows.length === 0) continue;
      if (rows.length === 1) { outcome = { status: "resolved", candidateIds: [rows[0].id] }; break; }
      // 2+ equally-valid candidates — the DB's own resolution_status CHECK
      // only allows 'resolved'/'unresolved'/'ambiguous' (dashboard_widget_
      // series, v16); this must be 'ambiguous', never a made-up fourth
      // status, and never an auto-picked winner.
      outcome = { status: "ambiguous", candidateIds: rows.map((r) => r.id) };
      break;
    }
    results.set(spec.sourceSeriesId, outcome);
  }
  return results;
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

// resolutionStatus/templateResolutionCandidates are no longer accepted at
// all (see routes/trainingLoadDashboard.js's ADD_SERIES_KEYS — sending
// either is now a plain "unknown field" 400) — training_load.add_series()
// (v17) derives both authoritatively, server-side, every time (finding
// #5). templateMetricKeyHints is likewise rejected by the route whenever
// metricDefinitionId is also present — a metric-backed template series'
// hint is ALWAYS the server's own snapshot of the locked definition, so
// this function never even attempts to forward a client-supplied hint
// alongside a real binding.
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
  try {
    const r = await query(
      `select * from training_load.add_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        widgetId, body.expectedWidgetRevision, body.seriesOrder,
        body.metricDefinitionId ?? null, body.builtInSeriesKey ?? null,
        body.templateMetricKeyHints ? JSON.stringify(body.templateMetricKeyHints) : null,
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
  // PATCH semantics (finding #3): absent = no change, explicit null =
  // clear, value = replace — derived here, never a client-facing flag.
  const hasColor = Object.prototype.hasOwnProperty.call(body, "color");
  const clearColor = hasColor && body.color === null;
  const hasDisplayLabel = Object.prototype.hasOwnProperty.call(body, "displayLabel");
  const clearDisplayLabel = hasDisplayLabel && body.displayLabel === null;
  const hasComparisonPeriod = Object.prototype.hasOwnProperty.call(body, "comparisonPeriod");
  const clearComparisonPeriod = hasComparisonPeriod && body.comparisonPeriod === null;
  try {
    const r = await query(
      `select * from training_load.update_series($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        seriesId, widgetId, body.expectedWidgetRevision,
        body.axis ?? null, body.color ?? null, clearColor,
        body.displayLabel ?? null, clearDisplayLabel,
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
