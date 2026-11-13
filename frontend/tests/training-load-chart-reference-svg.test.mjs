import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from '../vendor/echarts/echarts-6.1.0.min.mjs';
import { buildDashboardWidgetDisplayModel } from '../training-load-analysis-display-model.js';
import { dashboardChartPlots } from '../training-load-analysis-echarts-options.js';

test('ECharts draws reference markers beyond the observation range on the value axis', () => {
  const period = { dateFrom: '2026-11-01', dateTo: '2026-11-02' };
  for (const [variant, reference, axis] of [
    [undefined, { lower: 20, unit: 'm' }, 'yAxis'],
    ['horizontal-bar', { lower: 15, upper: 20, unit: 'm' }, 'xAxis']
  ]) {
    const presentation = {
      schemaVersion: 1, chartReference: reference, chartInteractions: {},
      ...(variant ? { chartVariant: variant } : {})
    };
    const widget = {
      id: 'widget', widget_type: variant ? 'bar_chart' : 'line_chart', group_by: 'day',
      series: [{ id: 'series', resolution_status: 'resolved' }]
    };
    const data = { chartReference: reference, current: [
      { bucketKey: '2026-11-01', value: 1, unit: 'm' },
      { bucketKey: '2026-11-02', value: 2, unit: 'm' }
    ] };
    const result = { widgetId: widget.id, series: [{ seriesId: 'series', status: 'ok', data }] };
    const model = buildDashboardWidgetDisplayModel(widget, result, { period });
    const [plot] = dashboardChartPlots(model, () => 'Metric', () => '', { presentation });
    assert.equal(plot.option[axis].max, 20);
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 });
    try {
      chart.setOption(plot.option);
      const svg = chart.renderToSVGString();
      if (variant) assert.match(svg, /fill="(?:#0f62fe|rgb\(15,98,254\))"[^>]*fill-opacity="0\.15"/i);
      else assert.match(svg, /stroke="#0f62fe"[^>]*stroke-dasharray=/i);
      assert.match(plot.caption, /Reference/);
    } finally {
      chart.dispose();
    }
  }
});
