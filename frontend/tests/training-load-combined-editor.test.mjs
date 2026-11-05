import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, emptyTrainingLoadState } from '../state.js';
import { interactiveChartPresentation } from '../training-load-chart-composer.js';
import { analysisEditorDraftFromWidget, editorIsCombined, analysisEditorPlan, analysisEditorProblem, setEditorDisplayMode, addEditorSeries, removeEditorSeries, rebaseAnalysisEditorDraft, openAnalysisWidgetEditor, loadAnalysisEditorCombinedCapability } from '../training-load-analysis-data.js';

const row = (id, key, axis = 'primary') => ({ id, series_order: id === 'a' ? 1 : 2, built_in_series_key: key, axis, resolution_status: 'resolved', data_scope_level: 'session', analytical_aggregation: 'avg', source_policy: 'not_applicable', aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null });
const widget = () => ({ id: 'widget', title: 'Load', widget_type: 'line_chart', group_by: 'day', series: [row('a', 'srpe')] });
function reset() { state.trainingLoad = emptyTrainingLoadState(); state.currentUser = { id: 'coach', activeWorkspace: { type: 'private_coach', scopeId: 'coach' } }; }
function combined() { const w = widget(), d = analysisEditorDraftFromWidget(w); assert.equal(setEditorDisplayMode(d, 'combined', true), ''); return { w, d }; }

test('combined draft keeps per-series policies and different units, enforces exactly two rows, and config is last', () => {
  reset(); const { w, d } = combined();
  assert.equal(d.series[1].metric.key, 'rpe');
  assert.deepEqual(d.series[0].fields, analysisEditorDraftFromWidget(w).series[0].fields);
  assert.equal(addEditorSeries(d), ''); removeEditorSeries(d, d.series[0].key); assert.equal(d.series.length, 2);
  assert.equal(analysisEditorProblem(d), '');
  const plan = analysisEditorPlan(w, d);
  assert.deepEqual(plan.map(op => op.type), ['addSeries', 'reorder', 'patchWidget']);
  assert.deepEqual(plan.at(-1).body.presentation, interactiveChartPresentation('day', 'combined'));
  assert.equal(d.series[0].fields.coveragePolicy, 'complete_only');
  assert.equal(d.series[1].fields.coveragePolicy, 'complete_and_partial');
});

test('combined validation catches group, axis, numeric metadata, resolution, comparison and automatic-axis violations', () => {
  reset();
  for (const [change, expected] of [
    [d => { d.groupBy = 'athlete'; }, /day or week/],
    [d => { d.series.pop(); }, /exactly two/],
    [d => { d.series[1].fields.axis = 'primary'; }, /one metric per axis/],
    [d => { d.series[1].metric = { kind: 'builtin', key: 'last_session_date' }; }, /numeric/],
    [d => { d.series[1].metric = { kind: 'template', hints: ['pending'] }; }, /numeric/],
    [d => { d.series[0].resolutionStatus = 'ambiguous'; }, /numeric/],
    [d => { d.series[1].fields.comparisonPeriod = 'previous_period'; }, /Only a KPI/],
    [d => { d.presentation.value.chartInteractions.yAxis = { mode: 'fixed', min: 0, max: 5 }; }, /Unsupported/],
  ]) { const { d } = combined(); change(d); assert.match(analysisEditorProblem(d), expected); }
  const { d } = combined(); d.groupBy = 'week'; assert.equal(analysisEditorProblem(d), '');
  state.trainingLoad.analysis.metricPicker.definitions = [{ id: 'm', valueType: 'numeric', unit: 'm', scopeCapabilities: ['session'] }];
  d.series[1].metric = { kind: 'metric', id: 'm' }; d.series[1].fields.sourcePolicy = 'manual';
  assert.equal(analysisEditorProblem(d), '');
  for (const valueType of ['boolean', 'text', undefined]) {
    state.trainingLoad.analysis.metricPicker.definitions[0].valueType = valueType;
    assert.match(analysisEditorProblem(d), /numeric/);
  }
});

test('untouched presentations remain preserve; opaque future config cannot be converted or silently follow a type change', () => {
  reset();
  for (const presentation of [null, interactiveChartPresentation('day', 'area').value, { schemaVersion: 99, opaque: { future: true } }]) {
    const w = widget(); w.presentation_config = presentation;
    const d = analysisEditorDraftFromWidget(w);
    assert.deepEqual(analysisEditorPlan(w, d), []);
    d.title = 'Renamed'; assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Renamed' } }]);
    assert.deepEqual(d.presentation, { mode: 'preserve' });
  }
  const w = widget(); w.presentation_config = { schemaVersion: 99, opaque: true };
  const d = analysisEditorDraftFromWidget(w), before = structuredClone(d);
  assert.match(setEditorDisplayMode(d, 'combined', true), /preserved/); assert.deepEqual(d, before);
  d.widgetType = 'table'; assert.match(analysisEditorProblem(d), /compatible chart type/);
});

test('presentation-only changes are dirty and rebase adopts only untouched presentation intent', () => {
  reset(); const w = widget(); w.series.push(row('b', 'rpe', 'secondary'));
  const base = analysisEditorDraftFromWidget(w), d = structuredClone(base);
  setEditorDisplayMode(d, 'combined', true);
  assert.equal(analysisEditorPlan(w, d).length, 1);
  const server = structuredClone(w); server.title = 'Server title'; server.presentation_config = interactiveChartPresentation('week', 'area').value;
  rebaseAnalysisEditorDraft(server, d, base);
  assert.equal(d.title, 'Server title'); assert.equal(d.presentation.value.chartVariant, 'combined');
  const untouched = structuredClone(base); untouched.title = 'Local title';
  rebaseAnalysisEditorDraft(server, untouched, base);
  assert.equal(untouched.savedPresentation.chartVariant, 'area'); assert.deepEqual(untouched.presentation, { mode: 'preserve' });
  assert.deepEqual(analysisEditorPlan(server, untouched), [{ type: 'patchWidget', body: { title: 'Local title' } }]);
  const committed = structuredClone(w); committed.presentation_config = d.presentation.value; committed.title = d.title;
  assert.deepEqual(analysisEditorPlan(committed, d), []);
  const savedCombined = analysisEditorDraftFromWidget(committed);
  setEditorDisplayMode(savedCombined, 'separate');
  assert.deepEqual(analysisEditorPlan(committed, savedCombined).at(-1).body, { presentation: { mode: 'clear' } });
});

test('missing readiness is disabled and a late readiness response cannot enable another context', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const capabilities of [{}, { combinedCharts: false }, { combinedCharts: true }]) {
      reset(); const a = state.trainingLoad.analysis; a.dashboard = { id: 'dashboard' }; a.selectedDashboardId = 'dashboard'; openAnalysisWidgetEditor(widget());
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ capabilities }) });
      await loadAnalysisEditorCombinedCapability();
      assert.equal(a.editor.combinedAvailable, capabilities.combinedCharts === true);
    }
    reset(); const a = state.trainingLoad.analysis; a.dashboard = { id: 'dashboard' }; a.selectedDashboardId = 'dashboard'; openAnalysisWidgetEditor(widget());
    let resolve; globalThis.fetch = () => new Promise(done => { resolve = done; });
    const pending = loadAnalysisEditorCombinedCapability(); state.currentUser.id = 'other';
    resolve({ ok: true, status: 200, json: async () => ({ capabilities: { combinedCharts: true } }) }); await pending;
    assert.equal(Boolean(a.editor.combinedAvailable), false);
    a.pagesMode = true; a.pageCapabilities = {}; openAnalysisWidgetEditor(widget()); assert.equal(a.editor.combinedAvailable, false);
    a.pageCapabilities.combinedCharts = true; openAnalysisWidgetEditor(widget()); assert.equal(a.editor.combinedAvailable, true);
  } finally { globalThis.fetch = originalFetch; }
});


test('opaque v99 combined hint preserves future presentation and allows title-only edits without combined row restrictions', () => {
  reset();
  const w = widget(); w.widget_type = 'bar_chart';
  w.presentation_config = { schemaVersion: 99, chartVariant: 'combined', chartComposition: 'future-v2', future: { keep: ['opaque'] } };
  const before = structuredClone(w.presentation_config), d = analysisEditorDraftFromWidget(w);
  assert.equal(editorIsCombined(d), false);
  d.title = 'Only title changed';
  assert.equal(analysisEditorProblem(d), '');
  assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Only title changed' } }]);
  assert.deepEqual(d.presentation, { mode: 'preserve' }); assert.deepEqual(d.savedPresentation, before);
  const second = addEditorSeries(d), third = addEditorSeries(d);
  assert.ok(second); assert.ok(third); assert.equal(d.series.length, 3, 'opaque variant does not impose a two-row maximum');
  removeEditorSeries(d, third); removeEditorSeries(d, second); assert.equal(d.series.length, 1, 'opaque variant does not impose a two-row minimum');
  assert.equal(analysisEditorProblem(d), '');
  assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Only title changed' } }]);
  assert.deepEqual(w.presentation_config, before);
});
