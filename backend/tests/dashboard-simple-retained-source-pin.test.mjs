import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileSimpleDraft } from '../src/dashboardSimple/compiler.js';
import { createSimpleCapabilityReader } from '../src/dashboardSimple/capabilities.js';
import { draft, snapshot, context, metric, id } from './fixtures/dashboard-simple/contracts.mjs';

function retainedFixture() {
  const d = draft();
  d.metricRef = { kind: 'metric', metricDefinitionId: id(5) };
  d.display = { mode: 'preserve' };
  d.presentation = { mode: 'preserve' };
  d.view = { type: 'table', groupBy: 'day', dataScopeLevel: 'session', analyticalAggregation: 'sum' };
  const s = snapshot();
  s.metric = metric();
  s.metricRef = d.metricRef;
  s.connection = { id: id(9), state: 'inactive', owner_scope: 'club', owner_club_id: id(4) };
  const pin = { id: id(10), widget_id: id(11), metric_definition_id: id(5), built_in_series_key: null, resolution_status: 'resolved', source_policy: 'source_connection', source_connection_id: id(9) };
  s.retainedPin = structuredClone(pin);
  return { d, s, existing: { id: id(11), dashboard_id: s.dashboard.id, widget_type: 'table', group_by: 'day', series: [pin] } };
}

test('compiler permits an unchanged DB-derived ended pin and rejects missing or mismatched evidence', () => {
  const { d, s, existing } = retainedFixture();
  for (const edit of [d, { ...d, title: 'Renamed' }, { ...d, presentation: { mode: 'replace', value: { schemaVersion: 1 } } }, { ...d, view: { ...d.view, analyticalAggregation: 'avg' } }]) {
    const result = compileSimpleDraft(edit, s, context(), existing);
    assert.equal(result.status, 'valid', JSON.stringify(result));
  }
  for (const mutate of [
    x => { x.s.retainedPin = null; },
    x => { x.existing.dashboard_id = id(99); },
    x => { x.s.retainedPin.widget_id = id(99); },
    x => { x.s.retainedPin.id = id(99); },
    x => { x.s.retainedPin.metric_definition_id = id(99); },
    x => { x.s.retainedPin.source_policy = 'manual'; },
    x => { x.s.connection.owner_club_id = id(99); },
    x => { x.s.connection.state = 'archived'; },
    x => { x.existing = null; },
  ]) {
    const f = retainedFixture();
    mutate(f);
    assert.equal(compileSimpleDraft(f.d, f.s, context(), f.existing).status, 'invalid');
  }
});

test('table avg to line chart sum keeps the authorized ended pin and series identity', () => {
  const f = retainedFixture();
  f.existing.series[0].analytical_aggregation = 'avg';
  f.existing.presentation_config = { schemaVersion: 1, tableFormatting: { evaluationVersion: 1, rules: [] } };
  f.d.view = { ...f.d.view, type: 'line_chart', analyticalAggregation: 'sum' };
  f.d.presentation = { mode: 'replace', value: { schemaVersion: 1, chartComposition: 'athletes-v1' } };
  const result = compileSimpleDraft(f.d, f.s, context(), f.existing);
  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.widget.widget_type, 'line_chart');
  assert.equal(result.widget.series[0].analytical_aggregation, 'sum');
  for (const field of ['id', 'metric_definition_id', 'built_in_series_key', 'source_policy', 'source_connection_id']) {
    assert.equal(result.widget.series[0][field], f.existing.series[0][field]);
  }
});

test('reader derives retained eligibility from the authorized stored single series, never a request claim', async () => {
  const f = retainedFixture();
  const calls = [];
  let stored = [f.existing.series[0]];
  const reader = createSimpleCapabilityReader({
    canManageDashboardRow: () => true, dataWorkspaceMatches: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('select * from training_load.dashboards')) return { rows: [f.s.dashboard] };
      if (sql.includes('dashboard_widget_types')) return { rows: f.s.widgetTypes };
      if (sql.includes('dashboard_builtin_series')) return { rows: f.s.builtins };
      if (sql.includes('metric_definitions')) return { rows: [f.s.metric] };
      if (sql.includes('dashboard_widget_series s')) {
        assert.deepEqual(params, [f.existing.id, f.s.dashboard.id]);
        assert.ok(sql.includes('w.dashboard_id=$2'));
        return { rows: stored };
      }
      if (sql.includes('metric_source_connections')) return { rows: params[5] ? [f.s.connection] : [] };
      throw new Error(sql);
    },
  });
  const args = { req: { user: { id: id(3) } }, dataWorkspace: {}, dashboardId: f.s.dashboard.id, metricRef: f.d.metricRef, sourceConnectionId: id(9) };
  await assert.rejects(reader.load({ ...args, retainedPin: f.s.retainedPin }), e => e.code === 'notFound');
  assert.equal((await reader.load({ ...args, existingWidgetId: f.existing.id })).retainedPin.id, id(10));
  for (const pins of [[], [stored[0], stored[0]], [{ ...stored[0], metric_definition_id: id(99) }], [{ ...stored[0], source_connection_id: id(99) }]]) {
    stored = pins;
    await assert.rejects(reader.load({ ...args, existingWidgetId: f.existing.id }), e => e.code === 'notFound');
  }
  assert.ok(calls.some(c => c.sql.includes("c.state='active' or c.state='inactive' and $6::boolean")));
});

for (const [label, change] of [
  ['another widget in the same dashboard', f => { f.existing.id = id(12); }],
  ['another series in the same widget', f => { f.existing.series[0].id = id(12); }],
  ['another dashboard', f => { f.existing.dashboard_id = id(12); }],
  ['another source connection', f => { f.existing.series[0].source_connection_id = id(12); }],
  ['another metric', f => { f.existing.series[0].metric_definition_id = id(12); }],
]) test(`retainedPin cannot authorize ${label}`, () => {
  const f = retainedFixture();
  change(f);
  const result = compileSimpleDraft(f.d, f.s, context(), f.existing);
  assert.equal(result.status, 'invalid', JSON.stringify(result));
  assert.ok(result.issues.some(issue => issue.code === 'notFound' && issue.path === '$.metricRef'));
});

test('a body-only retainedPin claim fails draft validation without becoming server evidence', () => {
  const f = retainedFixture();
  f.d.retainedPin = structuredClone(f.s.retainedPin);
  delete f.s.retainedPin;
  const result = compileSimpleDraft(f.d, f.s, context(), f.existing);
  assert.equal(result.status, 'invalid');
  assert.ok(result.issues.some(issue => issue.path === '$.retainedPin'));
});

test('reader ignores forged retainedPin and existing series claims when the DB has no matching pin', async () => {
  const f = retainedFixture();
  const storedWidgets = new Map([
    [f.existing.id, { dashboardId: f.s.dashboard.id, series: [f.existing.series[0]] }],
    [id(12), { dashboardId: f.s.dashboard.id, series: [{ ...f.existing.series[0], id: id(13), widget_id: id(12), source_connection_id: id(14) }] }],
    [id(15), { dashboardId: id(16), series: [{ ...f.existing.series[0], id: id(17), widget_id: id(15) }] }],
  ]);
  const sourceChecks = [];
  const reader = createSimpleCapabilityReader({
    canManageDashboardRow: () => true, dataWorkspaceMatches: () => true,
    query: async (sql, params) => {
      if (sql.includes('select * from training_load.dashboards')) return { rows: [f.s.dashboard] };
      if (sql.includes('dashboard_widget_types')) return { rows: f.s.widgetTypes };
      if (sql.includes('dashboard_builtin_series')) return { rows: f.s.builtins };
      if (sql.includes('metric_definitions')) return { rows: [f.s.metric] };
      if (sql.includes('dashboard_widget_series s')) {
        assert.ok(sql.includes('w.id=$1 and w.dashboard_id=$2'));
        const widget = storedWidgets.get(params[0]);
        return { rows: widget?.dashboardId === params[1] ? widget.series : [] };
      }
      if (sql.includes('metric_source_connections')) {
        sourceChecks.push(params[5]);
        return { rows: params[5] ? [f.s.connection] : [] };
      }
      throw new Error(sql);
    },
  });
  const args = { req: { user: { id: id(3) } }, dataWorkspace: {}, dashboardId: f.s.dashboard.id, metricRef: f.d.metricRef, sourceConnectionId: f.s.connection.id };
  const forged = { retainedPin: f.s.retainedPin, existing: f.existing, series: f.existing.series };
  for (const existingWidgetId of [null, id(12), id(15), id(99)]) {
    await assert.rejects(reader.load({ ...args, ...forged, existingWidgetId }), e => e.code === 'notFound');
    assert.equal(sourceChecks.at(-1), false);
  }
  const valid = await reader.load({ ...args, existingWidgetId: f.existing.id, retainedPin: { ...f.s.retainedPin, id: id(99) } });
  assert.equal(valid.retainedPin.id, f.existing.series[0].id);
  assert.equal(sourceChecks.at(-1), true);
  const otherWidget = { ...f.existing, id: id(12), series: storedWidgets.get(id(12)).series };
  const result = compileSimpleDraft(f.d, valid, context(), otherWidget);
  assert.equal(result.status, 'invalid');
  assert.ok(result.issues.some(issue => issue.code === 'notFound'));
});
