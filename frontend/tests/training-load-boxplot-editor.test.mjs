import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { state, emptyTrainingLoadState } from '../state.js';
import { interactiveChartPresentation, chartPresentation } from '../training-load-chart-composer.js';
import { applyGalleryChoice, gallerySelection, renderChartGallery } from '../training-load-chart-gallery.js';
import { createSimpleEditorController, simpleDraftFromWidget } from '../training-load-simple-controller.js';
import { renderTrainingLoadAnalysisHtml } from '../training-load-analysis-view.js';
import { openAnalysisWidgetEditor, analysisEditorDraftFromWidget, analysisEditorProblem, analysisEditorPlan, setEditorDisplayMode, addEditorSeries, setEditorSeriesMetric } from '../training-load-analysis-data.js';

const presentation = () => interactiveChartPresentation('day', 'boxplot').value;
const capabilities = () => ({ capabilities: { preview: true, atomicSave: true, chartVariants: ['area', 'horizontal-bar', 'heatmap', 'boxplot'] }, widgetTypes: ['table', 'kpi', 'line_chart', 'bar_chart'], builtins: [{ key: 'rpe', label: 'RPE', value_type: 'numeric', fixed_data_scope_level: 'session', default_analytical_aggregation: 'avg' }] });
const widget = () => ({ id: 'widget', revision: 7, title: 'Effort', widget_type: 'bar_chart', group_by: 'day', presentation_config: presentation(), series: [{ id: 'series', built_in_series_key: 'rpe', axis: 'primary', resolution_status: 'resolved', data_scope_level: 'session', analytical_aggregation: 'avg', source_policy: 'not_applicable', aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null }] });
const model = () => ({ draft: { view: { type: 'table', groupBy: 'day' } }, selectedMetric: { value_type: 'numeric' }, capabilities: capabilities() });
beforeEach(() => { state.trainingLoad = emptyTrainingLoadState(); });

test('boxplot is the eleventh original accessible card and requires the advertised DB capability, numeric metric and day/week', () => {
  const m = model(), dom = new JSDOM(renderChartGallery(m));
  try {
    const cards = [...dom.window.document.querySelectorAll('input')];
    assert.ok(cards.length === 11); assert.equal(cards[10].value, 'boxplot');
    const card = cards[10].closest('label');
    assert.equal(cards[10].disabled, false);
    assert.match(card.textContent, /distribution across returned athlete values/);
    assert.equal(card.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(card.querySelectorAll('svg rect, svg path, svg circle').length > 1, true);
  } finally { dom.window.close(); }
  for (const mutate of [
    m => { delete m.capabilities.capabilities.chartVariants; },
    m => { m.capabilities.capabilities.chartVariants = ['area', 'horizontal-bar']; },
    m => { m.capabilities.widgetTypes = ['line_chart']; },
    m => { m.selectedMetric.value_type = 'text'; },
    m => { m.selectedMetric.value_type = 'boolean'; },
    m => { delete m.selectedMetric.value_type; },
    m => { m.draft.view.groupBy = 'athlete'; },
    m => { m.draft.view.groupBy = 'session'; },
  ]) {
    const blocked = model(); mutate(blocked); const before = structuredClone(blocked);
    applyGalleryChoice(blocked.draft, blocked, 'boxplot'); assert.deepEqual(blocked, before);
    assert.match(renderChartGallery(blocked), /value="boxplot"[^>]* disabled/);
  }
  m.draft.view.groupBy = 'week'; applyGalleryChoice(m.draft, m, 'boxplot');
  assert.equal(gallerySelection(m), 'boxplot');
  assert.equal(chartPresentation(m.draft.presentation.value).mode, 'enhanced');
  assert.match(renderChartGallery(m), /not session samples or inferred raw observations/);
  assert.match(renderChartGallery(m), /5 valid athletes/);
});

test('switches replace compositions and force automatic distribution axes while preserving supported interactions exactly', () => {
  for (const id of ['line_chart', 'bar_chart', 'area', 'horizontal-bar', 'heatmap']) {
    const m = model(); m.widgetId = 'widget'; m.draft.view.type = 'line_chart';
    m.savedPresentation = interactiveChartPresentation('day', 'area').value;
    Object.assign(m.savedPresentation.chartInteractions, { tooltip: { mode: 'formatted' }, legend: { toggle: false }, pointSelection: { mode: 'disabled' }, yAxis: { mode: 'fixed', min: -20, max: 100 } });
    const saved = structuredClone(m.savedPresentation), interactions = { ...structuredClone(saved.chartInteractions), yAxis: { mode: 'auto' } };
    m.draft.presentation = { mode: 'preserve' };
    applyGalleryChoice(m.draft, m, 'boxplot');
    assert.equal(m.draft.view.type, 'bar_chart');
    assert.equal(m.draft.presentation.value.chartComposition, 'distribution-v1');
    assert.deepEqual(m.draft.presentation.value.chartInteractions, interactions);
    const before = structuredClone(m); applyGalleryChoice(m.draft, m, 'boxplot'); assert.deepEqual(m, before);
    applyGalleryChoice(m.draft, m, id);
    assert.equal(m.draft.presentation.value.chartComposition, id === 'heatmap' ? 'matrix-v1' : 'athletes-v1');
    assert.notEqual(m.draft.presentation.value.chartVariant, 'boxplot');
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

test('new and reopened Simple boxplots preview and save the exact existing request envelope', async () => {
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
      controller.change(draft => applyGalleryChoice(draft, controller.model, 'boxplot'));
    }
    assert.equal(gallerySelection(controller.model), 'boxplot');
    controller.change(draft => { draft.title = 'Renamed distribution'; });
    assert.deepEqual(controller.model.savedPresentation, savedWidget?.presentation_config ?? null);
    await controller.preview(); assert.equal(controller.model.canSave, true);
    const preview = calls.at(-1).body;
    assert.equal(preview.draft.title, 'Renamed distribution');
    assert.equal(preview.draft.view.type, 'bar_chart');
    assert.deepEqual(preview.draft.presentation, savedWidget ? { mode: 'preserve' } : { mode: 'replace', value: presentation() });
    if (savedWidget) assert.deepEqual(preview.editTarget, { widgetId: 'widget', expectedWidgetRevision: 7 });
    await controller.save();
    const save = calls.at(-1);
    assert.equal(save.method, savedWidget ? 'PUT' : 'POST');
    assert.deepEqual(save.body.input, preview); assert.equal(save.body.previewToken, 'token');
    assert.equal(controller.model.saveState, 'recorded'); assert.equal(receipts.length, 1);
    controller.close();
    const reopened = { ...widget(), revision: 8, title: 'Renamed distribution' };
    await controller.open(reopened);
    assert.equal(gallerySelection(controller.model), 'boxplot');
    assert.deepEqual(controller.model.draft.presentation, { mode: 'preserve' });
    await controller.preview();
    assert.deepEqual(calls.at(-1).body.draft.presentation, { mode: 'preserve' });
    assert.deepEqual(controller.model.savedPresentation, reopened.presentation_config);
    controller.close();
  }
});

test('Advanced known boxplot supports title only and enforces type, group, one numeric metric and automatic axes', () => {
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
    [d => { d.series[0].fields.axis = 'secondary'; }, /primary axis/],
    [d => { d.series[0].fields.comparisonPeriod = 'previous_period'; }, /comparisons/],
    [d => { d.presentation = { mode: 'replace', value: presentation() }; d.presentation.value.chartInteractions.yAxis = { mode: 'fixed', min: 0, max: 10 }; }, /Unsupported|automatic axes/],
  ]) { const d = analysisEditorDraftFromWidget(w); mutate(d); assert.match(analysisEditorProblem(d), reason); }
  draft.groupBy = 'week'; assert.equal(analysisEditorProblem(draft), '');
  const beforeAdd = structuredClone(draft);
  assert.equal(addEditorSeries(draft), ''); assert.deepEqual(draft, beforeAdd);
  assert.equal(setEditorDisplayMode(draft, 'separate'), '');
  assert.deepEqual(draft.presentation, { mode: 'clear' });
  assert.ok(addEditorSeries(draft)); assert.equal(draft.series.length, 2);
});

test('Advanced boxplot title-only edit accepts omitted yAxis as automatic without rewriting the saved sidecar', () => {
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

test('Advanced opaque v99 boxplot stays opaque with no new metric/group limits, including Separate plots helper calls', () => {
  const w = widget(); w.widget_type = 'line_chart'; w.group_by = 'session';
  w.presentation_config = { schemaVersion: 99, chartVariant: 'boxplot', chartComposition: 'future', future: ['keep'] };
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

// Model each HTTP mutation as a separate commit, including both requests
// inside replaceSeries. Checking only the final plan state misses the guard.
function simulateBoxplotCommits(widget, draft, plan) {
  const saved = structuredClone(widget), commits = [];
  const entries = new Map(draft.series.map(entry => [entry.key, entry]));
  const columns = { axis: 'axis', comparisonPeriod: 'comparison_period', displayLabel: 'display_label', color: 'color' };
  const commit = (label, mutate) => {
    mutate();
    saved.revision += 1;
    commits.push(label);
    if (saved.presentation_config?.schemaVersion !== 1 || saved.presentation_config.chartVariant !== 'boxplot') return;
    assert.equal(saved.widget_type, 'bar_chart', label);
    assert.ok(['day', 'week'].includes(saved.group_by), label);
    assert.equal(saved.series.length, 1, `${label}: boxplot requires exactly one series at commit`);
    assert.equal(saved.series[0].axis, 'primary', label);
    assert.equal(saved.series[0].comparison_period, null, label);
    assert.equal(saved.series[0].resolution_status, 'resolved', label);
    assert.ok(['rpe', 'srpe'].includes(saved.series[0].built_in_series_key), `${label}: resolved numeric metric`);
  };
  const add = entry => commit('ADD', () => {
    const row = { id: `added-${entry.key}`, built_in_series_key: entry.metric.key, resolution_status: entry.resolutionStatus || 'resolved' };
    for (const [field, column] of Object.entries(columns)) row[column] = entry.fields[field] ?? null;
    saved.series.push(row);
  });
  for (const op of plan) {
    if (op.type === 'patchWidget') commit('PATCH widget', () => {
      for (const [field, column] of Object.entries({ title: 'title', widgetType: 'widget_type', groupBy: 'group_by' })) {
        if (field in op.body) saved[column] = op.body[field];
      }
      if (op.body.presentation) saved.presentation_config = op.body.presentation.mode === 'clear' ? null : structuredClone(op.body.presentation.value);
    });
    else if (op.type === 'deleteSeries' || op.type === 'replaceSeries') {
      commit('DELETE', () => { saved.series = saved.series.filter(row => row.id !== op.seriesId); });
      if (op.type === 'replaceSeries') add(entries.get(op.key));
    } else if (op.type === 'addSeries') add(entries.get(op.key));
    else if (op.type === 'patchSeries') commit('PATCH series', () => {
      const row = saved.series.find(row => row.id === op.seriesId);
      for (const [field, value] of Object.entries(op.body)) {
        assert.ok(columns[field], `Simulate field ${field}`);
        row[columns[field]] = value;
      }
    });
    else if (op.type === 'reorder') commit('REORDER', () => {});
    else assert.fail(`Unsimulated operation ${op.type}`);
  }
  return { saved, commits };
}

test('Advanced metric replacement clears boxplot before DELETE and restores the intended sidecar after ADD', () => {
  for (const intent of ['preserve', 'replace']) {
    const w = widget(), draft = analysisEditorDraftFromWidget(w);
    if (intent === 'replace') {
      draft.presentation = { mode: 'replace', value: presentation() };
      draft.presentation.value.chartInteractions.tooltip = { mode: 'formatted' };
    }
    setEditorSeriesMetric(draft.series[0], { kind: 'builtin', key: 'srpe' });
    assert.equal(analysisEditorProblem(draft), '');
    const original = structuredClone({ w, draft }), plan = analysisEditorPlan(w, draft);
    assert.deepEqual(plan[0], { type: 'patchWidget', body: { presentation: { mode: 'clear' } } });
    const target = intent === 'preserve' ? w.presentation_config : draft.presentation.value;
    assert.deepEqual(plan.at(-1), { type: 'patchWidget', body: { presentation: { mode: 'replace', value: target } } });
    // Prove the simulated invariant detects the old request ordering.
    assert.throws(() => simulateBoxplotCommits(w, draft, plan.slice(1)), /exactly one series at commit/);
    const { saved, commits } = simulateBoxplotCommits(w, draft, plan);
    assert.deepEqual(commits, ['PATCH widget', 'DELETE', 'ADD', 'PATCH widget']);
    assert.equal(saved.revision, w.revision + commits.length);
    assert.equal(saved.series[0].built_in_series_key, 'srpe');
    assert.deepEqual(saved.presentation_config, target);
    assert.deepEqual(analysisEditorPlan(saved, analysisEditorDraftFromWidget(saved)), []);
    assert.deepEqual({ w, draft }, original, 'planning must not mutate inputs');
  }
});

test('Advanced Separate plots clears boxplot before adding or patching a second series', () => {
  for (const existingSecond of [false, true]) {
    const w = widget();
    // Older saved boxplots may already have multiple attached series.
    if (existingSecond) w.series.push({ ...structuredClone(w.series[0]), id: 'second' });
    const draft = analysisEditorDraftFromWidget(w);
    assert.equal(setEditorDisplayMode(draft, 'separate'), '');
    if (!existingSecond) addEditorSeries(draft);
    draft.series[1].fields.axis = 'secondary';
    if (!existingSecond) draft.series[0].fields.displayLabel = 'First metric';
    assert.equal(analysisEditorProblem(draft), '');
    const plan = analysisEditorPlan(w, draft);
    assert.deepEqual(plan[0], { type: 'patchWidget', body: { presentation: { mode: 'clear' } } });
    assert.equal(plan.filter(op => op.body?.presentation).length, 1, 'clear is already the target');
    assert.throws(() => simulateBoxplotCommits(w, draft, plan.slice(1)), /exactly one series at commit/);
    const { saved } = simulateBoxplotCommits(w, draft, plan);
    assert.equal(saved.presentation_config, null);
    assert.equal(saved.series.length, 2);
    assert.equal(saved.series[1].axis, 'secondary');
    assert.deepEqual(analysisEditorPlan(saved, analysisEditorDraftFromWidget(saved)), []);
  }
});

test('Advanced boxplot to combined adds the second series after replacing the supported presentation', () => {
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
    const { saved } = simulateBoxplotCommits(w, draft, plan);
    assert.equal(saved.widget_type, 'line_chart');
    assert.equal(saved.series.length, 2);
    assert.deepEqual(saved.presentation_config, draft.presentation.value);
    const converted = structuredClone(draft);
    assert.equal(setEditorDisplayMode(draft, 'combined', true), '');
    assert.deepEqual(draft, converted, 'reselection must not dirty the converted draft again');
  }
});


test('Advanced saved Box plot UI names the display, caps one primary series and explains distribution semantics', () => {
  const a = state.trainingLoad.analysis, w = widget();
  a.dashboard = { id: 'dashboard', status: 'active' }; a.widgets = [w];
  openAnalysisWidgetEditor(w);
  const before = structuredClone(a.editor.draft), dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try {
    const editor = dom.window.document.querySelector('.tl-analysis-editor');
    assert.match(editor.querySelector('[data-action="training-load-analysis-widget-display-mode"] option:checked').textContent, /Box plot/);
    assert.equal(editor.querySelector('[data-action="training-load-analysis-add-series"]').disabled, true);
    assert.deepEqual([...editor.querySelector('[data-action="training-load-analysis-series-axis"]').options].map(o => o.value), ['primary']);
    assert.deepEqual([...editor.querySelector('[data-action="training-load-analysis-widget-group"]').options].map(o => o.value), ['day', 'week']);
    for (const meaning of [/returned athlete values/, /existing aggregation/, /not session samples/, /5 valid athletes/, /type 7 interpolation/, /Tukey 1.5 IQR/, /Units and source provenance/, /table remains available/]) assert.match(editor.textContent, meaning);
    assert.deepEqual(a.editor.draft, before);
  } finally { dom.window.close(); }
});

test('insufficient returned athletes keep the values table and explain the five-athlete threshold', () => {
  const a = state.trainingLoad.analysis, w = widget();
  a.dashboard = { id: 'dashboard', status: 'active' }; a.widgets = [w];
  a.period = { dateFrom: '2026-10-01', dateTo: '2026-10-02', timeZone: 'UTC' };
  a.queryResult = { widgets: [{ widgetId: w.id, series: [{ seriesId: 'series', status: 'ok', data: { current: [
    { athleteId: 'athlete-1', bucketKey: '2026-10-01', unit: 'AU', value: 12.25 }
  ] } }] }] };
  const original = structuredClone(a.queryResult), dom = new JSDOM(renderTrainingLoadAnalysisHtml());
  try {
    const body = dom.window.document.querySelector('.tl-analysis-widget-body');
    assert.match(body.textContent, /5 valid athletes/);
    assert.ok(body.querySelector('.tl-analysis-chart-values[open] table'));
    assert.match(body.querySelector('table').textContent, /12.3/);
    assert.match(body.querySelector('table').textContent, /AU/);
    assert.deepEqual(a.queryResult, original);
  } finally { dom.window.close(); }
});
