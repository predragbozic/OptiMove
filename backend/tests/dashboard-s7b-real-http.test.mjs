import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { draft } from './fixtures/dashboard-simple/contracts.mjs';
import { operationalFixture } from './support/dashboard-simple-operational-fixture.mjs';

test('S7b preview, atomic save and fresh query on local PostgreSQL', { timeout: 180000 }, async t => {
  const f = await operationalFixture(t);
  const capabilities = await f.request(f.base + '/capabilities', undefined, 'GET');
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities.body));
  assert.equal(capabilities.body.capabilities.lowerThresholdSave, true);
  await t.test('built-in upper and lower thresholds', async () => {
    await checkThreshold(f);
    await checkThreshold(f, null, null, 'lt');
  });
  await t.test('chart reference line and range survive save and fresh query', async () => {
    for (const reference of [{ lower: 1, unit: null }, { lower: 0, upper: 2, unit: null, validFrom: f.period.dateFrom, validTo: f.period.dateTo }]) {
      await checkThreshold(f, null, reference);
    }
  });
  await t.test('catalog threshold ignores a bucket with mixed metric versions', async () => {
    const metric = await f.one(
      "insert into training_load.metric_definitions (key,label,owner_scope,owner_team_id,state,created_by_user_id) values ('s7b-synthetic','S7b synthetic','team',$1,'active',$2) returning id",
      [f.team.id, f.coach.id]
    );
    const version = async number => (await f.one(
      "insert into training_load.metric_definition_versions (metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id,superseded_reason) values ($1,$2,'m','numeric','sum',$3,$4) returning id",
      [metric.id, number, f.coach.id, number === 2 ? 'Synthetic version change' : null]
    )).id;
    const previous = await version(1);
    const current = await version(2);
    await f.pool.query('update training_load.metric_definitions set current_version_id=$1 where id=$2', [current, metric.id]);
    await f.pool.query("insert into training_load.metric_definition_scope_capabilities (metric_definition_id,scope_level) values ($1,'day')", [metric.id]);
    for (const [date, versionId] of [['2026-10-22', current], ['2026-10-26', previous], ['2026-10-28', current]]) {
      const event = await f.one(
        "insert into training_load.metric_events (event_name,occurred_date,scope_level,owner_scope,owner_team_id,created_by_user_id) values ('Synthetic',$1,'day','team',$2,$3) returning id",
        [date, f.team.id, f.coach.id]
      );
      const participant = await f.one("insert into training_load.metric_event_participants (event_id,athlete_id,athlete_timezone_snapshot) values ($1,$2,'Europe/Belgrade') returning id", [event.id, f.athlete.id]);
      const occasion = await f.one("insert into training_load.metric_measurement_occasions (event_participant_id,entry_method) values ($1,'manual') returning id", [participant.id]);
      await f.pool.query("insert into training_load.metric_values (occasion_id,metric_definition_id,metric_definition_version_id,value_numeric,unit_at_capture,aggregation_role,coverage) values ($1,$2,$3,10,'m','standalone','not_applicable')", [occasion.id, metric.id, versionId]);
    }
    await checkThreshold(f, { metricDefinitionId: metric.id, versionId: current });
  });
});

async function checkThreshold(f, catalog, reference, operator = 'gt') {
  const isLower = operator === 'lt';
  const label = isLower ? 'Below threshold' : 'Above threshold';
  const config = draft();
  config.draftId = randomUUID();
  config.title = 'Synthetic threshold';
  config.metricRef = catalog ? { kind: 'metric', metricDefinitionId: catalog.metricDefinitionId } : { kind: 'builtin', key: 'session_count' };
  config.view = { type: reference ? 'line_chart' : 'table', groupBy: catalog ? 'week' : 'day', dataScopeLevel: 'day', analyticalAggregation: 'sum' };
  const input = {
    contractVersion: 1,
    context: { kind: 'legacyDashboard', period: f.period },
    draftRef: { draftId: config.draftId, draftVersion: config.draftVersion },
    draft: config, editTarget: null
  };
  input.draft.presentation = { mode: 'replace', value: {
    schemaVersion: 1,
    tableFormatting: { evaluationVersion: 1, ...(catalog ? { metricVersionId: catalog.versionId } : {}), rules: [{
      id: 'simple-above', priority: 1, enabled: true, name: isLower ? 'Lower threshold' : 'Upper threshold',
      target: { series: 'main', phase: 'current', cell: 'value', athletes: { mode: 'allReturned' } },
      operand: 'value', operator, threshold: { value: isLower ? 2 : 0, unit: catalog ? 'm' : null },
      style: { tone: 'caution', marker: isLower ? 'down' : 'up', label }
    }] }
  }};
  if (reference) config.presentation.value = { schemaVersion: 1, chartReference: reference };
  const preview = await f.request(f.base + '/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.status, 'valid', JSON.stringify(preview.body));
  if (reference) assert.deepEqual(preview.body.widgetResult.series[0].data.chartReference, reference);
  else assert.ok(preview.body.presentationAnnotations.some(row => row.style.label === label));
  assert.ok(preview.body.previewToken);
  const saved = await f.request(f.base + '/widgets', {
    requestId: randomUUID(), requestIssuedAt: preview.body.requestIssuedAt,
    resolvedPeriod: preview.body.resolvedPeriod, previewToken: preview.body.previewToken, input
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const widgetId = saved.body.widgetId;
  assert.ok(widgetId, JSON.stringify(saved.body));
  const widget = await f.one('select * from training_load.dashboard_widgets where id=$1', [widgetId]);
  widget.series = (await f.pool.query('select * from training_load.dashboard_widget_series where widget_id=$1', [widgetId])).rows;
  assert.deepEqual(widget.presentation_config, input.draft.presentation.value);
  const { queryDashboard } = await import('../src/trainingLoadDashboardQuery.js');
  const [result] = await queryDashboard(
    { dataWorkspaceType: 'team', dataWorkspaceScopeId: f.team.id },
    [widget], input.context.period
  );
  if (reference) {
    assert.deepEqual(result.series[0].data.chartReference, reference);
    const { buildDashboardWidgetDisplayModel } = await import('../../frontend/training-load-analysis-display-model.js');
    const { dashboardChartPlots } = await import('../../frontend/training-load-analysis-echarts-options.js');
    const model = buildDashboardWidgetDisplayModel(widget, result, { period: input.context.period });
    const plots = dashboardChartPlots(model, () => 'Sessions', () => '', { presentation: widget.presentation_config });
    assert.ok(plots.length, JSON.stringify({ status: model.status, period: model.period, series: model.series.map(series => series.status) }));
    const marks = plots[0].option.series[0];
    if (reference.upper === undefined) assert.deepEqual(marks.markLine.data, [{ yAxis: reference.lower }]);
    else assert.deepEqual(marks.markArea.data, [[{ yAxis: reference.lower }, { yAxis: reference.upper }]]);
  } else {
    assert.ok(result.series[0].data.current.some(row => row.thresholdLabel === label));
  }
  if (catalog) {
    const rows = result.series[0].data.current;
    assert.equal(rows.filter(row => row.thresholdLabel).length, 1);
    assert.ok(rows.some(row => row.value === 20 && !row.thresholdLabel), JSON.stringify(rows));
    assert.equal(preview.body.presentationAnnotations.length, 1);
  }
}
