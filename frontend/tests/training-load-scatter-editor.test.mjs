import { buildMetricPairs } from '../../backend/src/dashboardPages/metricPairs.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { state, emptyTrainingLoadState } from '../state.js';
import { interactiveChartPresentation } from '../training-load-chart-composer.js';
import { chartGalleryChoices, renderChartGallery, applyGalleryChoice, galleryUnavailable } from '../training-load-chart-gallery.js';
import { analysisEditorDraftFromWidget, analysisEditorPlan, analysisEditorProblem, editorIsScatter, openAnalysisWidgetEditor, setEditorDisplayMode, addEditorSeries, removeEditorSeries } from '../training-load-analysis-data.js';
import { renderTrainingLoadAnalysisHtml } from '../training-load-analysis-view.js';

const row = (id, metric = 'srpe', axis = 'primary') => ({ id, series_order: id === 'a' ? 1 : 2, built_in_series_key: metric, axis, resolution_status: 'resolved', data_scope_level: 'session', analytical_aggregation: 'avg', source_policy: 'not_applicable', aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null, display_label: id, color: '#123456' });
const widget = () => ({ id: 'widget', title: 'Load', widget_type: 'line_chart', group_by: 'day', series: [row('a')] });
const scatter = () => { const w = widget(); w.presentation_config = interactiveChartPresentation('day', 'scatter').value; w.series.push(row('b', 'rpe', 'secondary')); return w; };
beforeEach(() => { state.trainingLoad = emptyTrainingLoadState(); state.currentUser = { id: 'coach', activeWorkspace: { type: 'private_coach', scopeId: 'coach' } }; });

test('ninth Scatter card requires a saved base chart and both Page and Simple capabilities; selection never writes a Simple sidecar', () => {
  const m = { widgetId: 'widget', savedWidgetType: 'bar_chart', pageScatterAvailable: true, draft: { view: { type: 'bar_chart', groupBy: 'day' } }, selectedMetric: { value_type: 'numeric' }, capabilities: { widgetTypes: ['line_chart', 'bar_chart'], capabilities: { scatterCharts: true } } };
  const choice = chartGalleryChoices.find(choice => choice.id === 'scatter');
  assert.deepEqual([chartGalleryChoices.indexOf(choice) + 1, choice.id, choice.variant, choice.type], [9, 'scatter', 'scatter', 'line_chart']);
  assert.equal(galleryUnavailable(m, choice), '');
  const dom = new JSDOM(renderChartGallery(m));
  try { const input = dom.window.document.querySelector('[value="scatter"]'); assert.equal(input.disabled, false); assert.equal(dom.window.document.getElementById(input.getAttribute('aria-labelledby')).textContent, 'Scatter'); assert.equal(input.closest('label').querySelector('svg').getAttribute('aria-hidden'), 'true'); } finally { dom.window.close(); }
  const before = structuredClone(m); applyGalleryChoice(m.draft, m, 'scatter'); assert.deepEqual(m, before);
  for (const mutate of [m => { delete m.widgetId; }, m => { m.pageScatterAvailable = false; }, m => { delete m.capabilities.capabilities.scatterCharts; }, m => { m.capabilities.capabilities.scatterCharts = false; }, m => { m.draft.view.groupBy = 'athlete'; }, m => { m.selectedMetric.value_type = 'text'; }, m => { m.savedWidgetType = 'table'; }, m => { m.savedPresentation = { schemaVersion: 99, chartVariant: 'scatter' }; }]) { const blocked = structuredClone(m); mutate(blocked); assert.ok(galleryUnavailable(blocked, choice)); }
});

test('Scatter conversion stages exactly two numeric axes, retains policies and metadata, and saves presentation last', () => {
  for (const count of [1, 2]) {
    const w = widget(); if (count === 2) w.series.push(row('b', 'duration_minutes', 'secondary'));
    const original = structuredClone(w), d = analysisEditorDraftFromWidget(w), fields = d.series.map(s => structuredClone(s.fields));
    assert.equal(setEditorDisplayMode(d, 'scatter', true), '');
    assert.equal(editorIsScatter(d), true); assert.equal(d.series.length, 2);
    assert.deepEqual(d.series.map(s => s.fields.axis), ['primary', 'secondary']);
    fields.forEach((f, i) => assert.deepEqual(d.series[i].fields, f));
    assert.deepEqual(d.presentation, interactiveChartPresentation('day', 'scatter'));
    assert.equal(analysisEditorProblem(d), '');
    assert.equal(addEditorSeries(d), ''); removeEditorSeries(d, d.series[0].key); assert.equal(d.series.length, 2);
    const plan = analysisEditorPlan(w, d); assert.deepEqual(plan.at(-1), { type: 'patchWidget', body: { presentation: d.presentation } });
    if (count === 1) assert.deepEqual(plan.map(o => o.type), ['addSeries', 'reorder', 'patchWidget']);
    assert.deepEqual(w, original);
    const before = structuredClone(d); assert.equal(setEditorDisplayMode(d, 'scatter', false), ''); assert.deepEqual(d, before);
  }
});

test('Heatmap target sidecar is replaced before adding the second series; Combined conversions use mode-specific zoom', () => {
  for (const variant of ['heatmap', 'combined']) {
    const w = variant === 'combined' ? scatter() : widget();
    w.widget_type = variant === 'heatmap' ? 'bar_chart' : 'line_chart';
    w.presentation_config = interactiveChartPresentation('week', variant).value;
    Object.assign(w.presentation_config.chartInteractions, { tooltip: { mode: 'formatted' }, legend: { toggle: false }, pointSelection: { mode: 'disabled' } });
    const d = analysisEditorDraftFromWidget(w), original = structuredClone(w);
    assert.equal(setEditorDisplayMode(d, 'scatter', true), ''); assert.equal(d.series.length, 2); assert.equal(analysisEditorProblem(d), '');
    for (const key of ['tooltip', 'legend', 'pointSelection']) assert.deepEqual(d.presentation.value.chartInteractions[key], original.presentation_config.chartInteractions[key]);
    assert.deepEqual(d.presentation.value.chartInteractions.zoom, { mode: 'disabled', applyPeriodAction: false });
    const plan = analysisEditorPlan(w, d);
    if (variant === 'heatmap') assert.deepEqual(plan.find(op => op.body?.widgetType).body, { widgetType: 'line_chart', presentation: { mode: 'clear' } });
    assert.deepEqual(plan.at(-1).body.presentation, d.presentation);
    const policies = structuredClone(d.series);
    assert.equal(setEditorDisplayMode(d, 'combined', true), ''); assert.equal(d.presentation.value.chartComposition, 'metrics-v1');
    assert.deepEqual(d.presentation.value.chartInteractions.zoom, { mode: 'local', applyPeriodAction: true });
    assert.deepEqual(d.series, policies); assert.equal(analysisEditorProblem(d), ''); assert.deepEqual(w, original);
  }
});

test('known Scatter validates numeric resolution, axes, comparisons, grouping, composition and interaction limits', () => {
  for (const mutate of [d => { d.series.pop(); }, d => { d.series[1].fields.axis = 'primary'; }, d => { d.groupBy = 'session'; }, d => { d.series[1].metric = { kind: 'builtin', key: 'last_session_date' }; }, d => { d.series[1].metric = { kind: 'metric', id: 'unknown' }; }, d => { d.series[1].resolutionStatus = 'ambiguous'; }, d => { d.series[1].fields.comparisonPeriod = 'previous_period'; }, d => { d.presentation.value.chartInteractions.yAxis = { mode: 'fixed', min: 0, max: 10 }; }, d => { d.presentation.value.chartInteractions.zoom = { mode: 'local', applyPeriodAction: true }; }, d => { d.presentation.value.chartComposition = 'metrics-v1'; }]) {
    const d = analysisEditorDraftFromWidget(scatter()); d.presentation = { mode: 'replace', value: structuredClone(d.savedPresentation) }; mutate(d); assert.ok(analysisEditorProblem(d));
  }
  const d = analysisEditorDraftFromWidget(scatter()); d.groupBy = 'week';
  state.trainingLoad.analysis.metricPicker.definitions = [{ id: 'm', valueType: 'numeric', unit: 'm' }]; d.series[1].metric = { kind: 'metric', id: 'm' }; d.series[1].fields.sourcePolicy = 'manual';
  assert.equal(analysisEditorProblem(d), '');
  for (const valueType of ['boolean', 'text', undefined]) { state.trainingLoad.analysis.metricPicker.definitions[0].valueType = valueType; assert.match(analysisEditorProblem(d), /numeric/); }
});

test('legal title-only Scatter with empty interactions uses effective defaults and preserves the sidecar', () => {
  const w = scatter(); w.presentation_config.chartInteractions = {}; const original = structuredClone(w), d = analysisEditorDraftFromWidget(w);
  d.title = 'Renamed'; assert.equal(editorIsScatter(d), true); assert.equal(analysisEditorProblem(d), '');
  assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Renamed' } }]); assert.deepEqual(d.presentation, { mode: 'preserve' }); assert.deepEqual(w, original);
});

test('opaque schema99 Scatter hint has no new limits and cannot be converted', () => {
  const w = widget(); w.group_by = 'session'; w.presentation_config = { schemaVersion: 99, chartVariant: 'scatter', opaque: ['keep'] };
  const d = analysisEditorDraftFromWidget(w); d.title = 'Renamed'; assert.equal(editorIsScatter(d), false);
  const second = addEditorSeries(d), third = addEditorSeries(d); assert.ok(second); assert.ok(third); removeEditorSeries(d, second); removeEditorSeries(d, third);
  assert.equal(analysisEditorProblem(d), ''); assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Renamed' } }]);
  const before = structuredClone(d); assert.match(setEditorDisplayMode(d, 'scatter', true), /preserved/); assert.match(setEditorDisplayMode(d, 'separate'), /preserved/); assert.deepEqual(d, before);
});

test('Separate plots clears known presentation and type changes clear it atomically with the type patch', () => {
  for (const type of ['line_chart', 'table']) {
    const w = scatter(), d = analysisEditorDraftFromWidget(w); assert.equal(setEditorDisplayMode(d, 'separate'), ''); d.widgetType = type;
    const plan = analysisEditorPlan(w, d), patch = plan.find(op => op.type === 'patchWidget');
    assert.deepEqual(patch.body, { ...(type === 'table' ? { widgetType: 'table' } : {}), presentation: { mode: 'clear' } });
    assert.equal(plan.filter(op => op.type === 'patchWidget').length, 1); assert.ok(addEditorSeries(d));
  }
});

test('partial known Scatter Simple state cannot be converted into any ordinary gallery sidecar', () => {
  const m = { widgetId: 'widget', draft: { view: { type: 'line_chart', groupBy: 'day' }, presentation: { mode: 'preserve' } }, savedPresentation: scatter().presentation_config, capabilities: { widgetTypes: ['table', 'kpi', 'line_chart', 'bar_chart'], capabilities: { chartVariants: ['area', 'horizontal-bar', 'heatmap'], combinedCharts: true } } };
  for (const choice of chartGalleryChoices.filter(c => c.id !== 'scatter')) { const before = structuredClone(m); assert.match(galleryUnavailable(m, choice), /Advanced editor/); applyGalleryChoice(m.draft, m, choice.id); assert.deepEqual(m, before); }
});

test('Advanced Scatter UI shows X/Y assignments, disables add/remove at two, and is capability gated on Pages only', () => {
  const a = state.trainingLoad.analysis, w = scatter(); a.dashboard = { id: 'dashboard', status: 'active' }; a.widgets = [w];
  for (const pagesMode of [false, true]) { a.pagesMode = pagesMode; a.pageCapabilities = { scatterCharts: true, pageWidgetEditing: true }; openAnalysisWidgetEditor(w); assert.equal(a.editor.scatterAvailable, pagesMode); }
  const dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try { const doc = dom.window.document; assert.equal(doc.querySelector('[data-action="training-load-analysis-widget-display-mode"]').value, 'scatter'); const axis = doc.querySelector('[data-action="training-load-analysis-series-axis"]'); assert.deepEqual([...axis.options].map(o => o.textContent), ['X axis', 'Y axis']); assert.equal(doc.querySelector('[data-action="training-load-analysis-add-series"]').disabled, true); assert.equal(doc.querySelector('[data-action="training-load-analysis-delete-series"]').disabled, true); assert.match(doc.querySelector('.tl-analysis-series-list').textContent, /X axis/); assert.match(doc.querySelector('.tl-analysis-series-list').textContent, /Y axis/); } finally { dom.window.close(); }
});


test('analysis view passes only the matching widget server metricPairs to the renderer without rebuilding missing proof', () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const period = { dateFrom: '2026-10-06', dateTo: '2026-10-08', timeZone: 'Europe/Belgrade' }, queryId = id(6);
  const w = { ...scatter(), id: id(3), series: [{ ...row(id(4)), metric_definition_id: id(10), built_in_series_key: null, source_policy: 'manual' }, row(id(5), 'duration_minutes', 'secondary')] };
  const result = { widgetId: w.id, series: w.series.map((s, index) => ({ seriesId: s.id, status: 'ok', data: { current: [{ athleteId: id(1), bucketKey: '2026-10-06', unit: index ? 'min' : 'm', value: index ? 67.123456 : 0 }] } })) };
  const metricPairs = buildMetricPairs({ widget: w, result, request: { schemaVersion: 1, widgetId: w.id, xSeriesId: id(4), ySeriesId: id(5) }, period, queryId });
  const a = state.trainingLoad.analysis; a.dashboard = { id: 'dashboard', status: 'active' }; a.widgets = [w]; a.period = period;
  a.queryResult = { queryId, resolvedPeriod: period, widgets: [{ widgetId: id(90), metricPairs: { invalid: true } }, { ...result, metricPairs }] };
  const before = structuredClone(a.queryResult);
  let dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try { const chart = dom.window.document.querySelector('optimove-dashboard-chart'); assert.ok(chart); const plot = JSON.parse(chart.dataset.chart); assert.equal(plot.option.series[0].type, 'scatter'); assert.deepEqual(plot.option.series[0].data[0].value, [0, 67.123456]); } finally { dom.window.close(); }
  assert.deepEqual(a.queryResult, before);
  delete a.queryResult.widgets[1].metricPairs;
  a.queryResult.widgets[0].metricPairs = metricPairs;
  dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try { assert.equal(dom.window.document.querySelector('optimove-dashboard-chart'), null); assert.ok(dom.window.document.querySelector('.tl-analysis-chart-values')); } finally { dom.window.close(); }
});


test('Horizontal bar conversion clears its incompatible sidecar atomically and enables Scatter only after series exist', () => {
  const w = widget(); w.widget_type = 'bar_chart'; w.presentation_config = interactiveChartPresentation('day', 'horizontal-bar').value;
  const d = analysisEditorDraftFromWidget(w); assert.equal(setEditorDisplayMode(d, 'scatter', true), '');
  const plan = analysisEditorPlan(w, d);
  assert.deepEqual(plan[0], { type: 'patchWidget', body: { widgetType: 'line_chart', presentation: { mode: 'clear' } } });
  assert.deepEqual(plan.slice(1).map(op => op.type), ['addSeries', 'reorder', 'patchWidget']);
  assert.deepEqual(plan.at(-1).body.presentation, interactiveChartPresentation('day', 'scatter'));
});
