import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("legacy presentation writers with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  const dashboardId = "10000000-0000-4000-8000-000000000001";
  const widgetId = "20000000-0000-4000-8000-000000000001";
  const ownerId = "30000000-0000-4000-8000-000000000001";
  const workspace = { type: "private_coach", dataWorkspaceType: "private_coach", dataWorkspaceUserId: ownerId };
  const dashboard = { id: dashboardId, name: "Dashboard", owner_scope: "user", owner_user_id: ownerId, status: "active", revision: 7, data_workspace_type: "private_coach", default_filter: { athleteIds: [ownerId] } };
  const chartPresentation = { schemaVersion: 1, chartComposition: "athletes-v1", chartInteractions: { tooltip: { mode: "exact" }, yAxis: { mode: "fixed", min: -10, max: 100 } } };
  const opaquePresentation = { schemaVersion: 17, future: { rules: [{ foreignShape: true }], preserve: [null, false, "9007199254740993"] } };
  const queryCalls = [];
  let queryHandler;
  let connectHandler;
  let batchQueryHandler;

  mock.module("../src/db.js", { namedExports: {
    query: async (sql, parameters) => { queryCalls.push({ sql, parameters }); return queryHandler(sql, parameters); },
    pool: { connect: async () => connectHandler() },
  } });
  mock.module("../src/trainingLoadDashboardAccess.js", { namedExports: {
    resolveActiveDataWorkspace: async () => workspace,
    canManageDashboardRow: (request, row) => row.owner_user_id === request.user.id,
    canViewDashboardRow: (request, row) => row.owner_scope === "system" || row.owner_user_id === request.user.id,
    dashboardManageBasis: () => "owner",
    dashboardVisibilitySql: () => "true",
    dataWorkspaceMatches: () => true,
    resolveDashboardCreateContext: async (request, body, suppliedWorkspace) => {
      assert.equal(suppliedWorkspace, workspace);
      return { ownerScope: "user", ownerUserId: ownerId, ownerClubId: null, ownerTeamId: null, dataWorkspaceType: "private_coach", dataWorkspaceScopeId: null, isTemplate: body.isTemplate === true };
    },
    isMetricVisibleToDashboard: async () => ({ visible: true, def: { state: "active" } }),
    isSourceConnectionVisibleToDashboard: async () => ({ visible: true, conn: { state: "active" } }),
  } });
  mock.module("../src/trainingLoadDashboardQuery.js", { namedExports: {
    queryDashboard: async (...args) => batchQueryHandler(...args),
  } });
  const widgets = await import("../src/trainingLoadDashboardWidgets.js");
  const catalog = await import("../src/trainingLoadDashboardCatalog.js");
  const { default: router } = await import("../src/routes/trainingLoadDashboard.js");
  const { validateContract } = await import("../src/dashboardSimple/schema.js");

  beforeEach(() => {
    queryCalls.length = 0;
    queryHandler = async sql => {
      if (sql.includes("select is_active")) return { rowCount: 1, rows: [{ is_active: true }] };
      if (sql.includes("from training_load.dashboards")) return { rowCount: 1, rows: [dashboard] };
      if (sql.startsWith("select 1")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("training_load.create_widget")) return { rows: [{ widget_id: widgetId, dashboard_revision: 8 }] };
      if (sql.includes("training_load.update_widget_content")) return { rows: [{ widget_id: widgetId, widget_revision: 4, dashboard_id: dashboardId }] };
      throw new Error(`Unexpected pooled query: ${sql}`);
    };
    connectHandler = () => { throw new Error("Unexpected database checkout"); };
    batchQueryHandler = () => { throw new Error("Unexpected batch query"); };
  });

  const createBody = () => ({ expectedDashboardRevision: 7, widgetType: "line_chart", title: " Chart ", widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0 });
  const updateBody = () => ({ expectedWidgetRevision: 3, title: " Updated " });
  const request = body => ({ user: { id: ownerId }, params: { dashboardId, widgetId }, body });

  async function invokeRoute(method, routePath, body, requestOverrides = {}) {
    const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
    assert.ok(layer, `Missing ${method} ${routePath}`);
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await layer.route.stack[0].handle({ ...request(body), ...requestOverrides }, response, error => { throw error; });
    assert.ok(response.body);
    return response;
  }

  test("legacy creates keep thirteen parameters and explicit replace uses the atomic fourteen-parameter port", async () => {
    const body = createBody();
    const legacy = await invokeRoute("post", "/:dashboardId/widgets", body);
    assert.equal(legacy.statusCode, 201);
    assert.deepEqual(legacy.body, { widgetId, dashboardRevision: 8 });
    const legacyCall = queryCalls.at(-1);
    assert.match(legacyCall.sql, /training_load\.create_widget\(/);
    assert.deepEqual(legacyCall.parameters, [dashboardId, 7, "line_chart", "Chart", 0, 0, 0, 6, 4, 0, "day", null, null]);
    const replaced = await invokeRoute("post", "/:dashboardId/widgets", { ...body, presentation: { mode: "replace", value: chartPresentation } });
    assert.deepEqual(replaced.body, legacy.body);
    assert.match(queryCalls.at(-1).sql, /create_widget_with_presentation\(/);
    assert.deepEqual(queryCalls.at(-1).parameters, [...legacyCall.parameters, JSON.stringify(chartPresentation)]);
  });

  test("absent presentation uses the legacy update and preserves the original revision response", async () => {
    const response = await invokeRoute("patch", "/:dashboardId/widgets/:widgetId", updateBody());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { widget: { widget_id: widgetId, widget_revision: 4, dashboard_id: dashboardId } });
    assert.match(queryCalls.at(-1).sql, /training_load\.update_widget_content\(/);
    assert.deepEqual(queryCalls.at(-1).parameters, [widgetId, 3, null, "Updated", null, null, null, null, false]);
  });

  for (const presentation of [{ mode: "preserve" }, { mode: "clear" }, { mode: "replace", value: chartPresentation }]) {
    test(`sidecar-only ${presentation.mode} uses the atomic eleven-parameter update with the revision token`, async () => {
      const response = await invokeRoute("patch", "/:dashboardId/widgets/:widgetId", { expectedWidgetRevision: 3, presentation });
      assert.equal(response.statusCode, 200);
      assert.match(queryCalls.at(-1).sql, /update_widget_content_with_presentation\(/);
      assert.deepEqual(queryCalls.at(-1).parameters, [widgetId, 3, null, null, null, null, null, null, false, presentation.mode, presentation.mode === "replace" ? JSON.stringify(chartPresentation) : null]);
      assert.equal(queryCalls.filter(call => /select \* from training_load\.update_widget/.test(call.sql)).length, 1);
    });
  }

  test("local filter clear remains independent of explicit presentation preserve", async () => {
    await widgets.updateWidgetContent(dashboardId, widgetId, { expectedWidgetRevision: 3, localFilterOverride: null, presentation: { mode: "preserve" } });
    assert.deepEqual(queryCalls.at(-1).parameters.slice(7), [null, true, "preserve", null]);
  });

  test("strict shared validation rejects invalid modes, unknown keys, unsupported versions and bad axis bounds before any write", async () => {
    const invalidPresentations = [
      null,
      {},
      { mode: "unknown" },
      { mode: "replace" },
      { mode: "replace", value: null },
      { mode: "preserve", value: chartPresentation },
      { mode: "clear", extra: true },
      { mode: "replace", value: { schemaVersion: 2 } },
      { mode: "replace", value: { schemaVersion: 1, unknown: true } },
      { mode: "replace", value: { schemaVersion: 1, chartInteractions: { tooltip: { mode: "exact", unknown: true } } } },
      { mode: "replace", value: { schemaVersion: 1, chartInteractions: { yAxis: { mode: "fixed", min: 10, max: 10 } } } },
    ];
    for (const presentation of invalidPresentations) {
      assert.equal(validateContract("presentationMode", presentation).valid, false);
      for (const [method, routePath, body] of [["post", "/:dashboardId/widgets", createBody()], ["patch", "/:dashboardId/widgets/:widgetId", updateBody()]]) {
        queryCalls.length = 0;
        const response = await invokeRoute(method, routePath, { ...body, presentation });
        assert.equal(response.statusCode, 400, JSON.stringify(presentation));
        assert.equal(response.body.error, "invalidRequest");
        assert.equal(queryCalls.length, 0);
      }
    }
    for (const mode of ["preserve", "clear"]) {
      const response = await invokeRoute("post", "/:dashboardId/widgets", { ...createBody(), presentation: { mode } });
      assert.equal(response.statusCode, 400);
    }
  });

  test("well-formed nonempty table rules remain gated while empty table formatting can be saved", async () => {
    const rule = {
      id: "distance", priority: 1, enabled: false, name: "Distance",
      target: { series: "main", phase: "current", cell: "value", athletes: { mode: "allReturned" } },
      operand: "value", operator: "gt", threshold: { value: 100, unit: "m" },
      style: { tone: "positive", marker: "check", label: "Above threshold" },
    };
    const presentation = { mode: "replace", value: { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [rule] } } };
    assert.equal(validateContract("presentationMode", presentation).valid, true);
    for (const [method, routePath, body] of [["post", "/:dashboardId/widgets", { ...createBody(), widgetType: "table" }], ["patch", "/:dashboardId/widgets/:widgetId", updateBody()]]) {
      const response = await invokeRoute(method, routePath, { ...body, presentation });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error, "invalidRequest");
    }
    assert.equal(queryCalls.length, 0);
    const response = await invokeRoute("post", "/:dashboardId/widgets", { ...createBody(), widgetType: "table", presentation: { mode: "replace", value: { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [] } } } });
    assert.equal(response.statusCode, 201);
  });

  test("unknown top-level aliases are refused and presentation does not bypass ownership", async () => {
    for (const alias of ["presentationConfig", "presentation_config", "clearPresentation"]) {
      const response = await invokeRoute("patch", "/:dashboardId/widgets/:widgetId", { ...updateBody(), [alias]: chartPresentation });
      assert.equal(response.statusCode, 400);
    }
    queryHandler = async () => ({ rows: [{ ...dashboard, owner_user_id: "another-owner" }] });
    const response = await invokeRoute("patch", "/:dashboardId/widgets/:widgetId", { ...updateBody(), presentation: { mode: "clear" } });
    assert.equal(response.statusCode, 404);
    assert.equal(queryCalls.filter(call => /update_widget/.test(call.sql)).length, 0);
  });

  test("new SQL ports keep existing stale, archive, invalid-input and conflict responses sanitized", async () => {
    const expectedStatuses = { "40001": 409, "40002": 409, P0001: 400, "23514": 400, "23505": 409, S2C02: 400, S2C03: 400, S2C05: 400, S2C07: 400 };
    const expectedCodes = { "40001": "staleRevision", "40002": "dashboardArchived", P0001: "invalidRequest", "23514": "invalidRequest", "23505": "conflict", S2C02: "invalidRequest", S2C03: "invalidRequest", S2C05: "invalidRequest", S2C07: "invalidRequest" };
    const defaultHandler = queryHandler;
    for (const [code, expectedStatus] of Object.entries(expectedStatuses)) {
      queryHandler = async (sql, parameters) => {
        if (/training_load\.(create_widget|update_widget_content)_with_presentation/.test(sql)) throw Object.assign(new Error("private table and owner details"), { code });
        return defaultHandler(sql, parameters);
      };
      for (const [method, routePath, body] of [["post", "/:dashboardId/widgets", createBody()], ["patch", "/:dashboardId/widgets/:widgetId", updateBody()]]) {
        const response = await invokeRoute(method, routePath, { ...body, presentation: { mode: "replace", value: chartPresentation } });
        assert.equal(response.statusCode, expectedStatus);
        assert.equal(response.body.error, expectedCodes[code]);
        assert.ok(!JSON.stringify(response.body).includes("private table"));
      }
    }
  });

  test("legacy content and series semantic edits rejected by opaque guards remain controlled generic 400s", async () => {
    const defaultHandler = queryHandler;
    queryHandler = async (sql, parameters) => {
      if (/training_load\.(update_widget_content|update_series)\(/.test(sql)) throw Object.assign(new Error("private opaque configuration details"), { code: "S2C03" });
      return defaultHandler(sql, parameters);
    };
    for (const [routePath, body, params] of [
      ["/:dashboardId/widgets/:widgetId", { expectedWidgetRevision: 3, groupBy: "week" }, { dashboardId, widgetId }],
      ["/:dashboardId/widgets/:widgetId/series/:seriesId", { expectedWidgetRevision: 3, analyticalAggregation: "avg" }, { dashboardId, widgetId, seriesId: ownerId }],
    ]) {
      const response = await invokeRoute("patch", routePath, body, { params });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { error: "invalidRequest" });
    }
  });

  function readFixture() {
    const rows = [chartPresentation, opaquePresentation, null].map((presentation_config, index) => ({ id: `20000000-0000-4000-8000-00000000000${index + 1}`, widget_type: "line_chart", presentation_config, revision: 3 }));
    queryHandler = async sql => {
      if (sql.includes("from training_load.dashboards")) return { rows: [dashboard] };
      if (sql.includes("from training_load.dashboard_widgets")) {
        assert.match(sql, /display_config, presentation_config, local_filter_override/);
        return { rows };
      }
      if (sql.includes("from training_load.dashboard_widget_series")) return { rows: [{ id: "source-series", widget_id: rows[0].id }] };
      throw new Error(`Unexpected read: ${sql}`);
    };
    return rows;
  }

  test("detail includes known, unknown and null sidecars without evaluating or writing them", async () => {
    const rows = readFixture();
    const detail = await catalog.getDashboardDetail(request(), workspace, dashboardId);
    assert.deepEqual(detail.widgets.map(widget => widget.presentation_config), rows.map(widget => widget.presentation_config));
    assert.equal(detail.widgets[1].presentation_config, opaquePresentation);
    assert.equal(detail.widgets[0].series[0].id, "source-series");
    assert.ok(queryCalls.every(call => call.sql.startsWith("select")));
  });

  test("saved query projects sidecars by widget identity while preserving raw query results and subset selection", async () => {
    const rows = readFixture();
    const seriesResult = [{ seriesId: "result-series", status: "ok", data: { current: [{ value: 1999.96 }] } }];
    batchQueryHandler = async (suppliedWorkspace, suppliedWidgets, period, filters) => {
      assert.equal(suppliedWorkspace.dataWorkspaceType, "private_coach");
      assert.deepEqual(suppliedWidgets.map(widget => widget.id), rows.slice(0, 2).map(widget => widget.id));
      assert.deepEqual(period, { dateFrom: "2026-10-29", dateTo: "2026-10-29" });
      assert.equal(filters.defaultFilter, dashboard.default_filter);
      assert.deepEqual(filters.requestFilter, { athleteIds: null });
      return [{ widgetId: rows[1].id, series: seriesResult }, { widgetId: rows[0].id, series: [] }];
    };
    const response = await invokeRoute("post", "/:dashboardId/query", { dateFrom: "2026-10-29", dateTo: "2026-10-29", widgetIds: rows.slice(0, 2).map(widget => widget.id), athleteIds: null });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.dashboardRevision, 7);
    assert.equal(response.body.widgets[0].presentation_config, opaquePresentation);
    assert.equal(response.body.widgets[1].presentation_config, chartPresentation);
    assert.equal(response.body.widgets[0].series, seriesResult);
    assert.ok(queryCalls.every(call => call.sql.startsWith("select")));
  });

  function cloneFixture({ failCopy = false } = {}) {
    const statements = [];
    const sourceWidgets = [chartPresentation, opaquePresentation, null].map((presentation_config, index) => ({ id: `source-${index}`, widget_type: "line_chart", title: `Widget ${index}`, widget_order: index, x: 0, y: index * 4, width: 6, height: 4, mobile_order: index, group_by: "day", state: "active", display_config: { schemaVersion: 2 }, presentation_config, local_filter_override: { athleteIds: [ownerId] } }));
    const seriesBase = { series_order: 0, axis: "primary", color: "#123456", display_label: "Original label", source_policy: "all_with_conflicts", source_connection_id: null, data_scope_level: "session", analytical_aggregation: "sum", aggregation_role_policy: "standalone_and_source_rollup", coverage_policy: "complete_and_partial", comparison_period: "previous_period" };
    const sourceSeries = [
      { ...seriesBase, id: "built-in", widget_id: "source-0", built_in_series_key: "session_count", source_policy: "not_applicable" },
      { ...seriesBase, id: "hinted", widget_id: "source-1", template_metric_key_hints: [{ key: "distance", valueType: "numeric", unit: "m", scopeLevel: "session" }] },
      { ...seriesBase, id: "legacy", widget_id: "source-2", metric_definition_id: "original-metric" },
    ];
    let released = false;
    connectHandler = () => ({
      query: async (sql, parameters) => {
        statements.push({ sql, parameters });
        if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
        if (sql.includes("from training_load.dashboards")) return { rows: [{ ...dashboard, is_template: true }] };
        if (sql.startsWith("insert into training_load.dashboards")) return { rows: [{ ...dashboard, id: "cloned-dashboard" }] };
        if (sql.startsWith("select * from training_load.dashboard_widgets")) return { rows: sourceWidgets };
        if (sql.startsWith("insert into training_load.dashboard_widgets")) return { rows: [{ id: `cloned-${parameters[3]}` }] };
        if (sql.startsWith("select * from training_load.dashboard_widget_series")) return { rows: sourceSeries };
        if (sql.includes("from training_load.metric_definitions d")) return { rows: [{ id: "resolved-metric", key: "distance", value_type: "numeric", unit: "m" }] };
        if (sql.includes("from training_load.metric_definition_scope_capabilities")) return { rows: [{ metric_definition_id: "resolved-metric", scope_level: "session" }] };
        if (sql.startsWith("insert into training_load.dashboard_widget_series")) return { rows: [] };
        if (sql.startsWith("update training_load.dashboard_widgets as cloned_widget")) {
          if (failCopy) throw Object.assign(new Error("Guard refused incompatible target"), { code: "23514" });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected clone query: ${sql}`);
      },
      release: () => { released = true; },
    });
    return { statements, sourceWidgets, get released() { return released; } };
  }

  test("clone copies exact sidecars in SQL after all series and template resolutions, within the same transaction", async () => {
    const fixture = cloneFixture();
    const response = await catalog.cloneDashboard(request(), workspace, dashboardId, { name: "Clone" });
    assert.deepEqual(response.cloneReport, [{ sourceSeriesId: "built-in", resolution: "built_in" }, { sourceSeriesId: "hinted", resolution: "resolved" }, { sourceSeriesId: "legacy", resolution: "copied" }]);
    const { statements } = fixture;
    assert.equal(statements[0].sql, "begin");
    assert.equal(statements.at(-1).sql, "commit");
    const widgetInserts = statements.filter(call => call.sql.startsWith("insert into training_load.dashboard_widgets"));
    assert.equal(widgetInserts.length, 3);
    for (const statement of widgetInserts) {
      assert.match(statement.sql, /local_filter_override, presentation_config\)/);
      assert.match(statement.sql, /\$13,null\) returning id/);
      assert.equal(statement.parameters.length, 13);
      assert.deepEqual(statement.parameters[12], { athleteIds: [ownerId] });
    }
    const lastSeriesInsert = statements.findLastIndex(call => call.sql.startsWith("insert into training_load.dashboard_widget_series"));
    const copyStatements = statements.filter(call => call.sql.startsWith("update training_load.dashboard_widgets as cloned_widget"));
    assert.equal(copyStatements.length, 3);
    for (const [index, statement] of copyStatements.entries()) {
      assert.ok(statements.indexOf(statement) > lastSeriesInsert);
      assert.match(statement.sql, /set presentation_config = source_widget\.presentation_config/);
      assert.deepEqual(statement.parameters, [`cloned-${index}`, `source-${index}`]);
    }
    const resolvedInsert = statements.find(call => call.sql.startsWith("insert into training_load.dashboard_widget_series") && call.parameters[0] === "cloned-1");
    assert.equal(resolvedInsert.parameters[2], "resolved-metric");
    assert.deepEqual(JSON.parse(resolvedInsert.parameters[3]), [{ key: "distance", valueType: "numeric", unit: "m", scopeLevel: "session" }]);
    assert.deepEqual(resolvedInsert.parameters.slice(6, 9), ["primary", "#123456", "Original label"]);
    assert.equal(fixture.released, true);
    assert.equal(queryCalls.length, 0);
    assert.ok(statements.every(call => !/set_config|set local/i.test(call.sql)));
  });

  test("a DB compatibility rejection during final clone copy rolls back every widget and series", async () => {
    const fixture = cloneFixture({ failCopy: true });
    await assert.rejects(catalog.cloneDashboard(request(), workspace, dashboardId, { name: "Clone" }), error => error.code === "23514");
    assert.equal(fixture.statements.at(-1).sql, "rollback");
    assert.ok(!fixture.statements.some(call => call.sql === "commit"));
    assert.equal(fixture.released, true);
  });

  test("layout and series writers keep their original sanctioned ports without sending sidecar parameters", async () => {
    const functions = [
      ["replace_dashboard_layout", () => widgets.replaceLayout(dashboardId, { expectedRevision: 7, layout: [] }), 3],
      ["update_widget_layout", () => widgets.updateWidgetLayout(dashboardId, widgetId, { expectedWidgetRevision: 3, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0 }), 7],
      ["add_series", () => widgets.addSeries(dashboardId, widgetId, { expectedWidgetRevision: 3, seriesOrder: 0, builtInSeriesKey: "session_count" }, ownerId, dashboard), 17],
      ["update_series", () => widgets.updateSeries(dashboardId, widgetId, "series-id", { expectedWidgetRevision: 3, color: null }, dashboard), 16],
      ["delete_series", () => widgets.deleteSeries(dashboardId, widgetId, "series-id", { expectedWidgetRevision: 3 }), 3],
      ["reorder_series", () => widgets.reorderSeries(dashboardId, widgetId, { expectedWidgetRevision: 3, order: [] }), 3],
      ["resolve_series_binding", () => widgets.resolveSeriesBinding(dashboardId, widgetId, "series-id", { expectedWidgetRevision: 3, metricDefinitionId: "metric-id" }, dashboard), 4],
    ];
    queryHandler = async () => ({ rowCount: 1, rows: [{ id: widgetId, series_id: "series-id", widget_revision: 4, presentation_config: opaquePresentation }] });
    for (const [functionName, operation, parameterCount] of functions) {
      await operation();
      assert.ok(queryCalls.at(-1).sql.includes(`training_load.${functionName}(`));
      assert.equal(queryCalls.at(-1).parameters.length, parameterCount);
      assert.ok(!queryCalls.at(-1).sql.includes("presentation"));
    }
  });
}
