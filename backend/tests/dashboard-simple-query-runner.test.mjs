import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("dashboard query runners with an isolated database mock", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  const defaultQuery = mock.fn(async () => { throw new Error("Unexpected default database query"); });
  mock.module("../src/db.js", { namedExports: { query: defaultQuery } });
  const { queryDashboard, runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const workspaceArgs = { dataWorkspaceType: "platform" };
  const period = { dateFrom: "2026-10-29", dateTo: "2026-10-29" };
  const widgets = [
    {
      id: "component-widget", group_by: "day", local_filter_override: { componentId: "component-a" },
      series: [
        { id: "session-series", resolution_status: "resolved", metric_definition_id: "session-metric", data_scope_level: "session", comparison_period: "previous_period" },
        { id: "builtin-series", resolution_status: "resolved", built_in_series_key: "session_count", comparison_period: "previous_period" },
      ],
    },
    {
      id: "day-widget", group_by: "day",
      series: [{ id: "day-series", resolution_status: "resolved", metric_definition_id: "day-metric", data_scope_level: "day", comparison_period: "previous_period" }],
    },
  ];

  function createQueryFixture(value) {
    const calls = [];
    async function queryRunner(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("from training_load.dashboard_builtin_series")) {
        return { rows: [{ key: "session_count", value_type: "numeric", unit: null }] };
      }
      if (sql.includes("select a.id from training.activities")) return { rows: [{ id: "activity-a" }] };
      if (sql.includes("from training.activity_components")) return { rows: [{ activity_id: "activity-a" }] };
      if (sql.includes("training.canonical_activity_results")) {
        return { rows: [{
          activity_id: "activity-a", canonical_activity_id: "activity-a", canonical_participant_id: "participant-a",
          athlete_id: "athlete-a", local_date: "2026-10-29", started_at: null, fact_kind: "metric_value",
          detail: {
            metricDefinitionId: "session-metric", metricDefinitionVersionId: "session-version", occasionId: "session-occasion",
            valueNumeric: value, unitAtCapture: "m", aggregationRole: "standalone", coverage: "complete",
          },
        }] };
      }
      if (sql.includes("from training_load.metric_measurement_occasions")) {
        return { rows: [{ occasion_id: "session-occasion", entry_method: "manual", event_scope_level: "session" }] };
      }
      if (sql.includes("from training_load.metric_definition_versions")) {
        return { rows: params[0].map((id) => ({ id, daily_aggregation_method: "sum", value_type: "numeric" })) };
      }
      if (sql.includes("from training.activity_participants p join")) {
        return { rows: [{ athlete_id: "athlete-a", activity_id: "activity-a", local_date: "2026-10-29" }] };
      }
      if (sql.includes("from training_load.metric_events ev")) {
        return { rows: [{
          metric_definition_id: "day-metric", metric_definition_version_id: "day-version", athlete_id: "athlete-a",
          local_date: "2026-10-29", occasion_id: "day-occasion", entry_method: "manual",
          value_numeric: value * 2, unit_at_capture: "m", aggregation_role: "standalone", coverage: "complete",
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    return { calls, queryRunner };
  }

  test("concurrent dashboards keep every metadata/fact fetch on their own runner across filters and comparison ranges", async () => {
    const fixtures = [createQueryFixture(11), createQueryFixture(29)];
    const defaultCallCount = defaultQuery.mock.callCount();
    const results = await Promise.all(fixtures.map(({ queryRunner }) => queryDashboard(workspaceArgs, widgets, period, {
      defaultFilter: { athleteIds: ["other-athlete"] }, requestFilter: { athleteIds: ["athlete-a"] }, queryRunner,
    })));
    assert.equal(defaultQuery.mock.callCount(), defaultCallCount);
    for (const [index, result] of results.entries()) {
      const expectedValue = index === 0 ? 11 : 29;
      const seriesResults = result.flatMap((widget) => widget.series);
      assert.deepEqual(seriesResults.map((series) => series.status), ["ok", "ok", "ok"]);
      assert.deepEqual(seriesResults.map((series) => series.data.current[0]?.value), [expectedValue, 1, expectedValue * 2]);
      for (const series of seriesResults) {
        assert.deepEqual(series.data.comparison, series.data.current);
        assert.deepEqual(series.data.comparisonRange, { dateFrom: "2026-10-28", dateTo: "2026-10-28" });
      }
      const { calls } = fixtures[index];
      const countQueries = (fragment) => calls.filter(({ sql }) => sql.includes(fragment)).length;
      assert.equal(countQueries("from training_load.dashboard_builtin_series"), 1);
      assert.equal(countQueries("select a.id from training.activities"), 4);
      assert.equal(countQueries("from training.activity_components"), 2);
      assert.equal(countQueries("training.canonical_activity_results"), 4);
      assert.equal(countQueries("from training_load.metric_measurement_occasions"), 4);
      assert.equal(countQueries("from training_load.metric_definition_versions"), 6);
      assert.equal(countQueries("from training.activity_participants p join"), 4);
      assert.equal(countQueries("from training_load.metric_events ev"), 2);
      const versionCalls = calls.filter(({ sql }) => sql.includes("from training_load.metric_definition_versions"));
      assert.equal(versionCalls.filter(({ params }) => params[0].includes("day-version")).length, 2);
      const activityCalls = calls.filter(({ sql }) => sql.includes("select a.id from training.activities"));
      assert.deepEqual(new Set(activityCalls.map(({ params }) => params[0])), new Set(["2026-10-29", "2026-10-28"]));
    }
  });

  test("both public entry points retain the imported query default and accept explicit runners", async () => {
    const defaultFixture = createQueryFixture(17);
    defaultQuery.mock.mockImplementation(defaultFixture.queryRunner);
    try {
      const injectedFixture = createQueryFixture(17);
      const specs = [{ widgetId: "widget-a", seriesId: "series-a", builtInSeriesKey: "session_count", comparisonPeriod: "previous_period" }];
      const defaultBatch = await runDashboardBatchQuery({ ...workspaceArgs, ...period }, specs);
      const defaultCallCount = defaultQuery.mock.callCount();
      assert.ok(defaultCallCount > 0);
      assert.deepEqual(await runDashboardBatchQuery({ ...workspaceArgs, ...period }, specs, { queryRunner: injectedFixture.queryRunner }), defaultBatch);
      assert.equal(defaultQuery.mock.callCount(), defaultCallCount);
      const defaultDashboard = await queryDashboard(workspaceArgs, widgets, period);
      assert.ok(defaultQuery.mock.callCount() > defaultCallCount);
      const dashboardDefaultCallCount = defaultQuery.mock.callCount();
      assert.deepEqual(await queryDashboard(workspaceArgs, widgets, period, { queryRunner: injectedFixture.queryRunner }), defaultDashboard);
      assert.equal(defaultQuery.mock.callCount(), dashboardDefaultCallCount);
      assert.deepEqual(defaultDashboard.flatMap((widget) => widget.series.map((series) => series.status)), ["ok", "ok", "ok"]);
    } finally {
      defaultQuery.mock.mockImplementation(async () => { throw new Error("Unexpected default database query"); });
    }
  });
}
