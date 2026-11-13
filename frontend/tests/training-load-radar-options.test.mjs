import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from '../vendor/echarts/echarts-6.1.0.min.mjs';
import { radarChartOption } from '../training-load-radar-options.js';
import { JSDOM } from 'jsdom';
import { state, emptyTrainingLoadState } from '../state.js';
import { renderTrainingLoadAnalysisHtml } from '../training-load-analysis-view.js';
import { handleTrainingLoadAction } from '../training-load-actions.js';
import { analysisEditorPlan, analysisEditorProblem, openAnalysisWidgetEditor } from '../training-load-analysis-data.js';

test('Radar renders a reference outline and preserves attainment above 100%', () => {
  const axes = ['distance', 'speed', 'effort'].map(metricDefinitionId => ({ metricDefinitionId }));
  const option = radarChartOption({
    status: 'ready', radialMaximum: 120,
    athletes: [{ athleteId: 'a', axes, polygon: [80, 100, 120] }, { athleteId: 'b', axes, polygon: null }]
  }, new Map(), new Map([['a', 'Synthetic athlete']]));
  assert.deepEqual(option.series[0].data.map(row => row.value), [[100, 100, 100], [80, 100, 120]]);
  const chart = init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
  try {
    chart.setOption(option);
    assert.match(chart.renderToSVGString(), /100% reference/);
  } finally { chart.dispose(); }
});

test('Radar widget requires a matching query and retains unavailable axis details', async () => {
  const { renderDashboardChartPlots } = await import('../training-load-analysis-echarts-options.js');
  const model = { status: 'ready', series: [{ definition: { metric_definition_id: 'distance' } }] };
  const options = {
    presentation: { chartVariant: 'radar' }, queryId: 'active-query',
    athletes: [{ id: 'a', name: 'Athlete <A>' }],
    radarSnapshot: {
      status: 'unavailable', queryId: 'active-query', radialMaximum: 100,
      athletes: [{ athleteId: 'a', polygon: null, axes: [
        { metricDefinitionId: 'distance', status: 'unavailable', reason: 'outOfValidity' }
      ] }]
    }
  };
  const render = opts => renderDashboardChartPlots(model, () => 'Distance', () => '', opts);
  assert.match(render(options), /Athlete &lt;A&gt; · Distance · Unavailable \(outOfValidity\)/);
  assert.doesNotMatch(render(options), /data-chart=/);
  assert.match(render({ ...options, queryId: 'another-query' }), /Radar needs fresh results/);
});

test('Advanced Radar controls produce a save patch and restore saved values', async () => {
  const previous = state.trainingLoad;
  state.trainingLoad = emptyTrainingLoadState();
  const a = state.trainingLoad.analysis;
  const ids = ['distance', 'duration', 'effort'];
  const widget = {
    id: 'widget', revision: 1, title: 'Radar', widget_type: 'table', group_by: 'day',
    series: ids.map((id, index) => ({
      id: 'series-' + id, metric_definition_id: id, series_order: index, resolution_status: 'resolved',
      axis: 'primary', data_scope_level: 'day', analytical_aggregation: 'sum', source_policy: 'manual',
      aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only'
    }))
  };
  a.dashboard = { id: 'dashboard', status: 'active', data_workspace_type: 'team' };
  a.pagesMode = true;
  a.pageCapabilities = { pageWidgetEditing: true };
  a.widgets = [widget];
  a.metricPicker.definitions = ids.map((id, index) => ({ id, label: id, unit: ['m', 'min', 'AU'][index], value_type: 'numeric' }));
  state.trainingLoad.orgPickerData = { athletes: [{ id: 'athlete', display_name: 'Athlete' }] };
  openAnalysisWidgetEditor(widget);
  const action = async (field, values) => {
    const dom = new JSDOM(renderTrainingLoadAnalysisHtml());
    try {
      const control = dom.window.document.querySelector(`[data-action="training-load-analysis-radar-${field}"]${values.selector ?? ''}`);
      assert.ok(control, field);
      if (values.checked !== undefined) control.checked = values.checked;
      if (values.value !== undefined) control.value = values.value;
      await handleTrainingLoadAction(control, { renderTrainingLoad() {} });
    } finally { dom.window.close(); }
  };
  try {
    await action('enabled', { checked: true });
    await action('athletes', { value: 'athlete' });
    await action('from', { value: '2026-10-28' });
    for (const id of ids) await action('value', { selector: `[data-metric-id="${id}"]`, value: '10' });
    assert.equal(analysisEditorProblem(a.editor.draft), '');
    const [patch] = analysisEditorPlan(widget, a.editor.draft);
    assert.equal(patch.type, 'patchWidget');
    const saved = { ...widget, display_config: patch.body.displayConfig };
    openAnalysisWidgetEditor(saved);
    assert.deepEqual(analysisEditorPlan(saved, a.editor.draft), []);
    assert.deepEqual(a.editor.draft.radarSettings, {
      athleteIds: ['athlete'], dateFrom: '2026-10-28', dateTo: null,
      axes: ids.map(metricDefinitionId => ({ metricDefinitionId, value: 10 }))
    });
  } finally { state.trainingLoad = previous; }
});
