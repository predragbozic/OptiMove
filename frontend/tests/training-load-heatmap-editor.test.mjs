import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { state, emptyTrainingLoadState } from '../state.js';
import { interactiveChartPresentation, chartPresentation } from '../training-load-chart-composer.js';
import { applyGalleryChoice, gallerySelection, renderChartGallery } from '../training-load-chart-gallery.js';
import { createSimpleEditorController, simpleDraftFromWidget } from '../training-load-simple-controller.js';
import { analysisEditorDraftFromWidget, analysisEditorProblem, analysisEditorPlan, setEditorDisplayMode, addEditorSeries } from '../training-load-analysis-data.js';

const presentation = () => interactiveChartPresentation('day', 'heatmap').value;
const capabilities = () => ({ capabilities: { preview: true, atomicSave: true, chartVariants: ['area', 'horizontal-bar', 'heatmap'] }, widgetTypes: ['table', 'kpi', 'line_chart', 'bar_chart'], builtins: [{ key: 'rpe', label: 'RPE', value_type: 'numeric', fixed_data_scope_level: 'session', default_analytical_aggregation: 'avg' }] });
const widget = () => ({ id: 'widget', revision: 7, title: 'Effort', widget_type: 'bar_chart', group_by: 'day', presentation_config: presentation(), series: [{ id: 'series', built_in_series_key: 'rpe', axis: 'primary', resolution_status: 'resolved', data_scope_level: 'session', analytical_aggregation: 'avg', source_policy: 'not_applicable', aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null }] });
const model = () => ({ draft: { view: { type: 'table', groupBy: 'day' } }, selectedMetric: { value_type: 'numeric' }, capabilities: capabilities() });
beforeEach(() => { state.trainingLoad = emptyTrainingLoadState(); });

test('heatmap is the eighth original accessible card and requires the advertised DB capability, numeric metric and day/week', () => {
  const m = model(), dom = new JSDOM(renderChartGallery(m));
  try {
    const cards = [...dom.window.document.querySelectorAll('input')];
    assert.equal(cards.length, 8); assert.equal(cards.at(-1).value, 'heatmap');
    const card = cards.at(-1).closest('label');
    assert.equal(cards.at(-1).disabled, false);
    assert.match(card.textContent, /Color shows magnitude only/);
    assert.equal(card.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(card.querySelectorAll('svg rect, svg path').length > 1, true);
  } finally { dom.window.close(); }
  for (const mutate of [
    m => { delete m.capabilities.capabilities.chartVariants; },
    m => { m.capabilities.capabilities.chartVariants = ['area', 'horizontal-bar']; },
    m => { m.capabilities.widgetTypes = ['line_chart']; },
    m => { m.selectedMetric.value_type = 'text'; },
    m => { m.selectedMetric.value_type = 'boolean'; },
    m => { m.draft.view.groupBy = 'athlete'; },
    m => { m.draft.view.groupBy = 'session'; },
  ]) {
    const blocked = model(); mutate(blocked); const before = structuredClone(blocked);
    applyGalleryChoice(blocked.draft, blocked, 'heatmap'); assert.deepEqual(blocked, before);
    assert.match(renderChartGallery(blocked), /value="heatmap"[^>]* disabled/);
  }
  m.draft.view.groupBy = 'week'; applyGalleryChoice(m.draft, m, 'heatmap');
  assert.equal(gallerySelection(m), 'heatmap');
  assert.equal(chartPresentation(m.draft.presentation.value).mode, 'enhanced');
});

test('switches replace compositions and force automatic matrix axes while preserving supported interactions exactly', () => {
  for (const id of ['line_chart', 'bar_chart', 'area', 'horizontal-bar']) {
    const m = model(); m.widgetId = 'widget'; m.draft.view.type = 'line_chart';
    m.savedPresentation = interactiveChartPresentation('day', 'area').value;
    Object.assign(m.savedPresentation.chartInteractions, { tooltip: { mode: 'formatted' }, legend: { toggle: false }, pointSelection: { mode: 'disabled' }, yAxis: { mode: 'fixed', min: -20, max: 100 } });
    const saved = structuredClone(m.savedPresentation), interactions = { ...structuredClone(saved.chartInteractions), yAxis: { mode: 'auto' } };
    m.draft.presentation = { mode: 'preserve' };
    applyGalleryChoice(m.draft, m, 'heatmap');
    assert.equal(m.draft.view.type, 'bar_chart');
    assert.equal(m.draft.presentation.value.chartComposition, 'matrix-v1');
    assert.deepEqual(m.draft.presentation.value.chartInteractions, interactions);
    const before = structuredClone(m); applyGalleryChoice(m.draft, m, 'heatmap'); assert.deepEqual(m, before);
    applyGalleryChoice(m.draft, m, id);
    assert.equal(m.draft.presentation.value.chartComposition, 'athletes-v1');
    assert.notEqual(m.draft.presentation.value.chartVariant, 'heatmap');
    assert.deepEqual(m.draft.presentation.value.chartInteractions, interactions);
    assert.equal(chartPresentation(m.draft.presentation.value).mode, 'enhanced');
    assert.deepEqual(m.savedPresentation, saved);
  }
  for (const id of ['table', 'kpi']) {
    const m = model(); m.widgetId = 'widget'; m.savedPresentation = presentation();
    m.draft = simpleDraftFromWidget(widget(), () => 'draft');
    applyGalleryChoice(m.draft, m, id);
    assert.equal(m.draft.view.type, id); assert.deepEqual(m.draft.presentation, { mode: 'clear' });
  }
});

test('new and reopened Simple heatmaps preview and save the exact existing request envelope', async () => {
  for (const savedWidget of [null, widget()]) {
    const calls = [], receipts = [], context = { dashboardId: 'dashboard', identity: ['coach'], period: { dateFrom: '2026-10-01', dateTo: '2026-10-31', timeZone: 'UTC' } };
    const controller = createSimpleEditorController({ getContext: () => context, uuid: () => 'request', schedule: () => 0, cancel: () => {}, saved: receipt => receipts.push(receipt), request: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null; calls.push({ url, method: options?.method, body });
      if (url.endsWith('/capabilities')) return capabilities();
      if (url.includes('/metrics?')) return { metrics: [] };
      if (url.endsWith('/preview')) return { status: 'valid', previewToken: 'token', requestIssuedAt: '2026-11-05T10:00:00Z', resolvedPeriod: context.period };
      if (/\/widgets(?:\/widget)?$/.test(url)) return { widgetId: 'widget', widgetRevision: 8 };
      assert.fail(`Unexpected request: ${url}`);
    } });
    await controller.open(savedWidget);
    if (!savedWidget) {
      controller.selectMetric('builtin', 'rpe');
      controller.change(draft => applyGalleryChoice(draft, controller.model, 'heatmap'));
    }
    assert.equal(gallerySelection(controller.model), 'heatmap');
    await controller.preview(); assert.equal(controller.model.canSave, true);
    const preview = calls.at(-1).body;
    assert.equal(preview.draft.view.type, 'bar_chart');
    assert.deepEqual(preview.draft.presentation, savedWidget ? { mode: 'preserve' } : { mode: 'replace', value: presentation() });
    if (savedWidget) assert.deepEqual(preview.editTarget, { widgetId: 'widget', expectedWidgetRevision: 7 });
    await controller.save();
    const save = calls.at(-1);
    assert.equal(save.method, savedWidget ? 'PUT' : 'POST');
    assert.deepEqual(save.body.input, preview); assert.equal(save.body.previewToken, 'token');
    assert.equal(controller.model.saveState, 'recorded'); assert.equal(receipts.length, 1);
    controller.close();
  }
});

test('Advanced known heatmap supports title only and enforces type, group, one numeric metric and automatic axes', () => {
  const w = widget(), draft = analysisEditorDraftFromWidget(w);
  draft.title = 'Renamed'; assert.equal(analysisEditorProblem(draft), '');
  assert.deepEqual(analysisEditorPlan(w, draft), [{ type: 'patchWidget', body: { title: 'Renamed' } }]);
  assert.deepEqual(draft.presentation, { mode: 'preserve' });
  for (const [mutate, reason] of [
    [d => { d.widgetType = 'line_chart'; }, /compatible chart type/],
    [d => { d.groupBy = 'session'; }, /day or week/],
    [d => { d.groupBy = 'athlete'; }, /day or week/],
    [d => { d.series.push(structuredClone(d.series[0])); }, /exactly one numeric/],
    [d => { d.series[0].metric = { kind: 'builtin', key: 'last_session_date' }; }, /numeric/],
    [d => { d.series[0].resolutionStatus = 'ambiguous'; }, /resolved numeric/],
    [d => { d.presentation = { mode: 'replace', value: presentation() }; d.presentation.value.chartInteractions.yAxis = { mode: 'fixed', min: 0, max: 10 }; }, /Unsupported|automatic axes/],
  ]) { const d = analysisEditorDraftFromWidget(w); mutate(d); assert.match(analysisEditorProblem(d), reason); }
  draft.groupBy = 'week'; assert.equal(analysisEditorProblem(draft), '');
  const beforeAdd = structuredClone(draft);
  assert.equal(addEditorSeries(draft), ''); assert.deepEqual(draft, beforeAdd);
  assert.equal(setEditorDisplayMode(draft, 'separate'), '');
  assert.deepEqual(draft.presentation, { mode: 'clear' });
  assert.ok(addEditorSeries(draft)); assert.equal(draft.series.length, 2);
});

test('Advanced heatmap title-only edit accepts omitted yAxis as automatic without rewriting the saved sidecar', () => {
  const w = widget();
  w.presentation_config.chartInteractions = {};
  const original = structuredClone(w), draft = analysisEditorDraftFromWidget(w);
  assert.equal(chartPresentation(w.presentation_config).axis.mode, 'auto');
  draft.title = 'Implicit auto rename';
  assert.equal(analysisEditorProblem(draft), '');
  assert.deepEqual(analysisEditorPlan(w, draft), [{ type: 'patchWidget', body: { title: 'Implicit auto rename' } }]);
  assert.deepEqual(draft.presentation, { mode: 'preserve' });
  assert.deepEqual(draft.savedPresentation, original.presentation_config);
  assert.deepEqual(w, original);
});

test('Advanced opaque v99 heatmap stays opaque with no new metric/group limits, including Separate plots helper calls', () => {
  const w = widget(); w.widget_type = 'line_chart'; w.group_by = 'session';
  w.presentation_config = { schemaVersion: 99, chartVariant: 'heatmap', chartComposition: 'future', future: ['keep'] };
  const original = structuredClone(w), draft = analysisEditorDraftFromWidget(w);
  draft.title = 'Opaque rename'; addEditorSeries(draft);
  assert.equal(draft.series.length, 2); assert.equal(analysisEditorProblem(draft), '');
  draft.series.pop();
  assert.deepEqual(analysisEditorPlan(w, draft), [{ type: 'patchWidget', body: { title: 'Opaque rename' } }]);
  assert.deepEqual(draft.presentation, { mode: 'preserve' }); assert.deepEqual(w, original);
  const before = structuredClone(draft);
  assert.match(setEditorDisplayMode(draft, 'separate'), /will be preserved/);
  assert.deepEqual(draft, before);
  assert.deepEqual(draft.presentation, { mode: 'preserve' });
  assert.deepEqual(analysisEditorPlan(w, draft), [{ type: 'patchWidget', body: { title: 'Opaque rename' } }]);
});

test('Advanced heatmap to combined adds the second series after replacing the supported presentation', () => {
  for (const intent of ['preserve', 'replace']) {
    const w = widget(); w.series[0].built_in_series_key = 'srpe';
    Object.assign(w.presentation_config.chartInteractions, { tooltip: { mode: 'formatted' }, legend: { toggle: false }, pointSelection: { mode: 'disabled' } });
    const draft = analysisEditorDraftFromWidget(w);
    if (intent === 'replace') draft.presentation = { mode: 'replace', value: structuredClone(w.presentation_config) };
    const original = structuredClone(w), previousValue = intent === 'replace' ? draft.presentation.value : draft.savedPresentation;
    const before = structuredClone(draft);
    assert.match(setEditorDisplayMode(draft, 'combined', false), /not available/);
    assert.deepEqual(draft, before, 'unavailable conversion must stay clean');
    assert.equal(setEditorDisplayMode(draft, 'combined', true), '');
    assert.equal(draft.widgetType, 'line_chart');
    assert.equal(draft.series.length, 2);
    assert.deepEqual(draft.series.map(entry => entry.metric.key), ['srpe', 'rpe']);
    assert.deepEqual(draft.series.map(entry => entry.fields.axis), ['primary', 'secondary']);
    assert.equal(analysisEditorProblem(draft), '');
    assert.equal(draft.presentation.mode, 'replace');
    assert.equal(draft.presentation.value.chartVariant, 'combined');
    assert.equal(draft.presentation.value.chartComposition, 'metrics-v1');
    assert.deepEqual(draft.presentation.value.chartInteractions, w.presentation_config.chartInteractions);
    assert.notEqual(draft.presentation.value, previousValue);
    assert.deepEqual(previousValue, original.presentation_config);
    assert.deepEqual(w, original);
    const plan = analysisEditorPlan(w, draft);
    assert.equal(plan.filter(op => op.type === 'addSeries').length, 1);
    assert.deepEqual(plan.at(-1).body, { presentation: draft.presentation });
    const converted = structuredClone(draft);
    assert.equal(setEditorDisplayMode(draft, 'combined', true), '');
    assert.deepEqual(draft, converted, 'reselection must not dirty the converted draft again');
  }
});
