import { buildMetricStack } from '../../backend/src/dashboardPages/metricStack.js';
import { simpleEditor, openSimpleEditor, handleSimpleEditorAction } from '../training-load-simple-actions.js';
import { clearAllViewCache } from '../view-cache.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { state, emptyTrainingLoadState } from '../state.js';
import { chartPresentation, interactiveChartPresentation } from '../training-load-chart-composer.js';
import { chartGalleryChoices, galleryUnavailable, applyGalleryChoice, renderChartGallery } from '../training-load-chart-gallery.js';
import { analysisEditorDraftFromWidget, analysisEditorProblem, analysisEditorPlan, analysisEditorIsDirty, setEditorDisplayMode, editorIsStacked, editorStackAcknowledged, acknowledgeEditorStack, invalidateEditorStack, stackedRequirements, addEditorSeries, removeEditorSeries, setEditorSeriesMetric, moveEditorSeries, rebaseAnalysisEditorDraft, openAnalysisWidgetEditor, saveAnalysisWidgetEditor } from '../training-load-analysis-data.js';
import { renderTrainingLoadAnalysisHtml } from '../training-load-analysis-view.js';

const ids = Array.from({ length: 9 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const row = i => ({ id: `s${i}`, series_order: i + 1, metric_definition_id: ids[i], resolution_status: 'resolved', axis: 'primary', data_scope_level: 'session', analytical_aggregation: 'sum', source_policy: 'manual', source_connection_id: null, aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null });
const widget = (count = 2) => ({ id: 'widget', title: 'Components', revision: 4, widget_type: 'bar_chart', group_by: 'day', series: Array.from({ length: count }, (_, i) => row(i)) });
const caps = () => ({ capabilities: { stackedCharts: true }, widgetTypes: ['bar_chart', 'line_chart', 'table', 'kpi'] });
function pending(count = 2) { const w = widget(count), d = analysisEditorDraftFromWidget(w); assert.equal(setEditorDisplayMode(d, 'stacked', true), ''); return { w, d }; }
function confirmed(count = 2) { const result = pending(count); assert.equal(acknowledgeEditorStack(result.d, true), ''); return result; }
function saved() { const { w, d } = confirmed(); w.presentation_config = structuredClone(d.presentation.value); return w; }
beforeEach(() => {
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.analysis.metricPicker.definitions = ids.map(id => ({ id, label: 'A component', valueType: 'numeric', unit: 'm', scopeCapabilities: ['session', 'day'] }));
});

test('tenth accessible gallery choice requires both Simple and page readiness and a saved base chart', () => {
  const choice = chartGalleryChoices.at(-1);
  assert.equal(chartGalleryChoices.length, 10); assert.equal(choice.id, 'stacked'); assert.equal(choice.variant, 'stacked');
  const model = { widgetId: 'widget', savedWidgetType: 'line_chart', savedGroupBy: 'day', pageStackedAvailable: true, capabilities: caps(), draft: { view: { type: 'line_chart', groupBy: 'day' } } };
  assert.equal(galleryUnavailable(model, choice), '');
  for (const mutate of [m => { m.widgetId = null; }, m => { m.pageStackedAvailable = false; }, m => { m.capabilities.capabilities.stackedCharts = false; }, m => { m.draft.view.groupBy = 'athlete'; }]) {
    const m = structuredClone(model); mutate(m); assert.ok(galleryUnavailable(m, choice));
  }
  const before = structuredClone(model); applyGalleryChoice(model.draft, model, 'stacked'); assert.deepEqual(model, before);
  const dom = new JSDOM(renderChartGallery(model));
  try { const card = dom.window.document.querySelector('input[value="stacked"]'); assert.equal(card.disabled, false); assert.ok(card.getAttribute('aria-describedby')); assert.equal(card.closest('label').querySelector('svg').getAttribute('aria-hidden'), 'true'); } finally { dom.window.close(); }
});

test('setup is local intent, no definition or inferred acknowledgement; it is dirty even with zero HTTP operations', async () => {
  const { w, d } = pending();
  assert.equal(editorIsStacked(d), true); assert.equal(editorStackAcknowledged(d), false);
  assert.deepEqual(d.presentation, { mode: 'clear' }); assert.equal(d.presentation.value, undefined);
  assert.match(analysisEditorProblem(d), /Confirm.*non-overlapping/);
  const a = state.trainingLoad.analysis; a.dashboard = { id: 'dashboard' }; a.widgets = [w]; a.editor = { open: true, widgetId: w.id, draft: d };
  assert.deepEqual(analysisEditorPlan(w, d), []); assert.equal(analysisEditorIsDirty(a), true);
  assert.equal(await saveAnalysisWidgetEditor(), false); assert.match(a.editor.error, /Confirm/);
});

test('one-series setup stays one series until user adds and selects metric 2; it never inserts RPE', () => {
  const { d } = pending(1), fields = structuredClone(d.series[0].fields);
  assert.equal(d.series.length, 1); assert.match(analysisEditorProblem(d), /Add metric 2/);
  assert.match(acknowledgeEditorStack(d, true), /Add metric 2/); assert.equal(d.presentation.value, undefined);
  addEditorSeries(d); assert.equal(d.series.length, 2); assert.equal(d.series[1].metric, null);
  assert.deepEqual(d.series[0].fields, fields); assert.match(stackedRequirements(d), /catalog metrics/);
});

test('explicit declaration creates components-v1 with UUIDs and nonempty unit; presentation patch is last after reorder', () => {
  const { w, d } = confirmed();
  assert.equal(editorStackAcknowledged(d), true); assert.equal(analysisEditorProblem(d), '');
  assert.equal(chartPresentation(d.presentation.value).mode, 'enhanced');
  assert.equal(d.presentation.value.chartComposition, 'components-v1');
  assert.deepEqual(d.presentation.value.stackDefinition, { schemaVersion: 1, semantics: 'non-overlapping-additive', unit: 'm', components: ids.slice(0, 2) });
  moveEditorSeries(d, d.series[1].key, -1); assert.equal(editorStackAcknowledged(d), true);
  const plan = analysisEditorPlan(w, d); assert.equal(plan.at(-2).type, 'reorder'); assert.deepEqual(plan.at(-1).body.presentation, d.presentation);
});

test('stacked requirements give actionable errors without changing policies', () => {
  for (const [mutate, expected] of [
    [d => { d.series[0].metric = { kind: 'builtin', key: 'rpe' }; }, /catalog metrics/],
    [d => { d.series[1].metric.id = ids[0]; }, /distinct/],
    [d => { d.series[1].resolutionStatus = 'ambiguous'; }, /resolved numeric/],
    [d => { state.trainingLoad.analysis.metricPicker.definitions[1].valueType = 'text'; }, /numeric/],
    [d => { state.trainingLoad.analysis.metricPicker.definitions[1].unit = ''; }, /nonempty unit/],
    [d => { state.trainingLoad.analysis.metricPicker.definitions[0].unit = 'x'.repeat(101); }, /nonempty unit/],
    [d => { d.series[1].fields.dataScopeLevel = 'day'; }, /same scope/],
    [d => { d.series[1].fields.analyticalAggregation = 'avg'; }, /Aggregation to Total/],
    [d => { d.series[1].fields.aggregationRolePolicy = 'standalone_and_source_rollup'; }, /Direct values only/],
    [d => { d.series[1].fields.coveragePolicy = 'complete_and_partial'; }, /Complete totals only/],
    [d => { d.series[1].fields.sourcePolicy = 'all_with_conflicts'; }, /same source/],
    [d => { d.series[1].sourceConnectionId = 'different'; }, /same source/],
    [d => { d.series[1].fields.axis = 'secondary'; }, /primary axis/],
    [d => { d.series[1].fields.comparisonPeriod = 'previous_period'; }, /remove comparisons/],
    [d => { d.groupBy = 'athlete'; }, /day or week/],
  ]) {
    state.trainingLoad.analysis.metricPicker.definitions.forEach(def => { def.valueType = 'numeric'; def.unit = 'm'; });
    const { d } = pending(); mutate(d); const before = structuredClone(d.series);
    assert.match(acknowledgeEditorStack(d, true), expected); assert.deepEqual(d.series, before); assert.equal(d.presentation.value, undefined);
  }
});

test('component set, units and policies bind acknowledgement; display labels and order do not', () => {
  for (const mutate of [d => { d.series[1].metric.id = ids[2]; }, d => { state.trainingLoad.analysis.metricPicker.definitions.slice(0, 2).forEach(def => { def.unit = 'km'; }); }, d => { d.series.forEach(entry => { entry.fields.dataScopeLevel = 'day'; }); }, d => { d.series.forEach(entry => { entry.fields.sourcePolicy = 'all_with_conflicts'; }); }]) {
    state.trainingLoad.analysis.metricPicker.definitions.forEach(def => { def.unit = 'm'; });
    const { d } = confirmed(); mutate(d); assert.equal(editorStackAcknowledged(d), false); assert.match(analysisEditorProblem(d), /Confirm/);
  }
  const { d } = confirmed(); d.title = 'New title'; d.series[0].fields.displayLabel = 'Alias'; moveEditorSeries(d, d.series[0].key, 1); assert.equal(editorStackAcknowledged(d), true);
  invalidateEditorStack(d); assert.equal(editorStackAcknowledged(d), false); assert.equal(acknowledgeEditorStack(d, true), ''); assert.equal(editorStackAcknowledged(d), true);
  acknowledgeEditorStack(d, false); assert.equal(editorStackAcknowledged(d), false);
});

test('known saved stacks allow title-only preserve; mismatch never defaults acknowledgement on', () => {
  const w = saved(), original = structuredClone(w), d = analysisEditorDraftFromWidget(w);
  assert.equal(editorStackAcknowledged(d), true); d.title = 'Renamed'; assert.equal(analysisEditorProblem(d), '');
  assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Renamed' } }]);
  assert.deepEqual(d.presentation, { mode: 'preserve' }); assert.deepEqual(w, original);
  w.series[1].metric_definition_id = ids[2]; assert.equal(editorStackAcknowledged(analysisEditorDraftFromWidget(w)), false);
});

test('known stacked Simple partial state cannot rewrite an ordinary sidecar, including same chooser', () => {
  const w = saved(), model = { widgetId: w.id, savedWidgetType: w.widget_type, savedGroupBy: w.group_by, savedPresentation: w.presentation_config, pageStackedAvailable: true, capabilities: caps(), draft: null };
  assert.equal(galleryUnavailable(model, chartGalleryChoices.at(-1)), '');
  for (const choice of chartGalleryChoices.filter(c => c.id !== 'stacked')) assert.match(galleryUnavailable(model, choice), /Advanced editor/);
  const draft = { view: { type: 'bar_chart', groupBy: 'day' }, presentation: { mode: 'preserve' } }, before = structuredClone(draft);
  model.draft = draft;
  for (const choice of chartGalleryChoices) applyGalleryChoice(draft, model, choice.id);
  assert.deepEqual(draft, before);
});

test('supported stacks cap at eight, remove to two, invalidate acknowledgement, and preserve chosen metric policies', () => {
  const { d } = confirmed(8); assert.equal(addEditorSeries(d), '');
  removeEditorSeries(d, d.series[7].key); assert.equal(d.series.length, 7); assert.equal(editorStackAcknowledged(d), false);
  while (d.series.length > 2) removeEditorSeries(d, d.series.at(-1).key);
  removeEditorSeries(d, d.series.at(-1).key); assert.equal(d.series.length, 2);
  const entry = d.series[0], before = structuredClone(entry.fields);
  setEditorSeriesMetric(entry, { kind: 'builtin', key: 'session_count' }, { preservePolicies: true }); assert.deepEqual(entry.fields, before);
});

test('Separate plots explicitly clears known sidecar and pending intent; conversions remove stack definition', () => {
  for (const mode of ['separate', 'combined', 'scatter']) {
    const w = saved(), d = analysisEditorDraftFromWidget(w);
    assert.equal(setEditorDisplayMode(d, mode, true), ''); assert.equal(d.stackedSetup, undefined); assert.equal(d.stackedAcknowledgement, undefined);
    if (mode === 'separate') assert.deepEqual(d.presentation, { mode: 'clear' });
    else { assert.equal(d.presentation.value.stackDefinition, undefined); assert.equal(chartPresentation(d.presentation.value).mode, 'enhanced'); assert.deepEqual(analysisEditorPlan(w, d).at(-1).body.presentation, d.presentation); }
  }
  const { d } = pending(); assert.equal(setEditorDisplayMode(d, 'separate'), ''); assert.equal(editorIsStacked(d), false);
});

test('opaque v99 stays opaque, has no new stacked minimum or component restrictions, and cannot be cleared', () => {
  const w = widget(1); w.presentation_config = { schemaVersion: 99, chartVariant: 'stacked', chartComposition: 'future', stackDefinition: { future: true } };
  const d = analysisEditorDraftFromWidget(w), original = structuredClone(d);
  for (const mode of ['stacked', 'separate', 'combined']) { assert.match(setEditorDisplayMode(d, mode, true), /preserved/); assert.deepEqual(d, original); }
  d.title = 'Opaque rename'; assert.equal(analysisEditorProblem(d), ''); assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: 'Opaque rename' } }]);
  addEditorSeries(d); assert.equal(d.series.length, 2); assert.equal(d.series[1].metric.key, 'rpe');
});

test('rebase retains local pending setup and acknowledgement intent through a partial save', () => {
  const { w, d } = pending(), base = analysisEditorDraftFromWidget(w), server = structuredClone(w);
  server.title = 'Server title'; rebaseAnalysisEditorDraft(server, d, base);
  assert.equal(d.stackedSetup, true); assert.equal(d.title, 'Server title'); assert.equal(editorStackAcknowledged(d), false);
  acknowledgeEditorStack(d, true); const intent = structuredClone(d.presentation);
  rebaseAnalysisEditorDraft(server, d, base); assert.deepEqual(d.presentation, intent); assert.equal(editorStackAcknowledged(d), true);
});

test('Advanced page gating and pending UI show unchecked declaration and disabled Save', () => {
  const a = state.trainingLoad.analysis, w = widget();
  a.dashboard = { id: 'dashboard', title: 'Dashboard', status: 'active' }; a.widgets = [w]; a.selectedWidgetId = w.id;
  openAnalysisWidgetEditor(w); assert.equal(a.editor.stackedAvailable, false);
  a.pagesMode = true; a.pageCapabilities = { stackedCharts: true }; openAnalysisWidgetEditor(w); assert.equal(a.editor.stackedAvailable, true);
  setEditorDisplayMode(a.editor.draft, 'stacked', true);
  const dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try {
    const checkbox = dom.window.document.querySelector('[data-action="training-load-analysis-stacked-acknowledgement"]');
    assert.ok(checkbox); assert.equal(checkbox.checked, false);
    assert.equal(dom.window.document.querySelector('[data-action="training-load-analysis-editor-save"]').disabled, true);
    assert.match(dom.window.document.body.textContent, /Stacked setup/); assert.match(dom.window.document.body.textContent, /Stacked components/);
  } finally { dom.window.close(); }
});


test('saved legal empty interactions preserve title-only and stacked acknowledgement without generating settings', () => {
  const w = saved(); w.presentation_config.chartInteractions = {};
  const d = analysisEditorDraftFromWidget(w); assert.equal(editorStackAcknowledged(d), true); d.title = 'Empty interactions rename';
  assert.equal(analysisEditorProblem(d), ''); assert.deepEqual(analysisEditorPlan(w, d), [{ type: 'patchWidget', body: { title: d.title } }]);
  assert.deepEqual(d.presentation, { mode: 'preserve' }); assert.deepEqual(d.savedPresentation.chartInteractions, {});
});

test('analysis rendering forwards only the matching server metricStack and never reconstructs absent proof', () => {
  const w = saved(); w.id = ids[3]; w.series.forEach((s, i) => { s.id = ids[i + 4]; });
  const period = { dateFrom: '2026-10-06', dateTo: '2026-10-08', timeZone: 'Europe/Belgrade' }, queryId = ids[7];
  const result = { widgetId: w.id, series: w.series.map((s, i) => ({ seriesId: s.id, status: 'ok', data: { current: [{ athleteId: ids[8], bucketKey: '2026-10-06', unit: 'm', value: i ? 5 : 0 }] } })) };
  const metricStack = buildMetricStack({ widget: w, result, period, queryId }); assert.equal(metricStack.status, 'ready');
  const a = state.trainingLoad.analysis; a.dashboard = { id: 'dashboard', status: 'active' }; a.widgets = [w]; a.period = period;
  a.queryResult = { queryId, resolvedPeriod: period, widgets: [{ widgetId: 'other', metricStack: { invalid: true } }, { ...result, metricStack }] };
  const before = structuredClone(a.queryResult);
  let dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try { const chart = dom.window.document.querySelector('optimove-dashboard-chart'); assert.ok(chart); const plot = JSON.parse(chart.dataset.chart); assert.equal(plot.option.series.length, 2); assert.equal(plot.option.series[0].data[0].value, 0); assert.match(plot.warnings.join(' '), /declared non-overlapping by the author/); } finally { dom.window.close(); }
  assert.deepEqual(a.queryResult, before);
  a.queryResult.widgets[0].metricStack = metricStack; delete a.queryResult.widgets[1].metricStack;
  dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try { assert.equal(dom.window.document.querySelector('optimove-dashboard-chart'), null); assert.ok(dom.window.document.querySelector('.tl-analysis-chart-values')); } finally { dom.window.close(); }
});

test('gallery Stacked handoff opens an unchecked Advanced draft with no HTTP writes', async () => {
  const globals = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
  const dom = new JSDOM('<main></main>'); globalThis.window = dom.window; globalThis.document = dom.window.document; dom.window.confirm = () => true;
  const calls = []; clearAllViewCache();
  state.currentUser = { id: 'coach', activeWorkspace: { type: 'private_coach', scopeId: 'coach' } };
  const a = state.trainingLoad.analysis, w = widget(1);
  Object.assign(a, { pagesMode: true, page: { id: 'page', defaultsRevision: 1 }, selectedPageId: 'page', pageCapabilities: { stackedCharts: true }, dashboard: { id: 'dashboard' }, selectedDashboardId: 'dashboard', widgets: [w], period: { dateFrom: '2026-10-01', dateTo: '2026-10-10', timeZone: 'UTC' } });
  state.trainingLoad.orgPickerData = { athletes: [] };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    let body;
    if (url.endsWith('/capabilities')) body = { ...caps(), capabilities: { ...caps().capabilities, preview: true } };
    else if (url.includes('/simple/metrics?')) body = { metrics: [{ id: ids[0], value_type: 'numeric', unit: 'm' }] };
    else if (url.startsWith('/api/training-load/metrics/')) body = { rows: [], nextCursor: null };
    else assert.fail(`Unexpected request: ${url}`);
    return { ok: true, json: async () => structuredClone(body) };
  };
  try {
    await openSimpleEditor(w, () => {});
    await handleSimpleEditorAction({ dataset: { action: 'training-load-simple-view' }, value: 'stacked' }, () => {});
    assert.equal(simpleEditor.model, null); assert.equal(a.editor.open, true); assert.equal(a.editor.draft.stackedSetup, true);
    assert.equal(a.editor.draft.series.length, 1); assert.equal(editorStackAcknowledged(a.editor.draft), false); assert.equal(a.editor.draft.presentation.value, undefined);
    assert.equal(calls.every(call => call.method === 'GET'), true);
  } finally { simpleEditor.close(); Object.assign(globalThis, globals); dom.window.close(); clearAllViewCache(); }
});


test('user-selected new component saves after add/reorder; lost-add recovery retains the declaration without adding twice', () => {
  const { w, d } = pending(1), base = analysisEditorDraftFromWidget(w);
  const key = addEditorSeries(d), added = d.series.find(entry => entry.key === key);
  setEditorSeriesMetric(added, { kind: 'metric', id: ids[1] }, { preservePolicies: true });
  // These are explicit user choices, not display-mode defaults.
  added.fields = structuredClone(d.series[0].fields);
  assert.equal(acknowledgeEditorStack(d, true), '');
  const plan = analysisEditorPlan(w, d); assert.deepEqual(plan.map(op => op.type), ['addSeries', 'reorder', 'patchWidget']);
  assert.deepEqual(plan.at(-1).body.presentation, d.presentation);
  added.pendingAdd = { knownIds: [w.series[0].id] };
  const server = structuredClone(w); server.series.push({ ...row(1), id: 'landed-series' });
  const intent = structuredClone(d.presentation);
  assert.equal(rebaseAnalysisEditorDraft(server, d, base), true);
  assert.equal(added.id, 'landed-series'); assert.equal(editorStackAcknowledged(d), true); assert.deepEqual(d.presentation, intent);
  assert.equal(analysisEditorPlan(server, d).some(op => op.type === 'addSeries'), false);
});
