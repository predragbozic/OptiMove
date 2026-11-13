import { escapeAttr, escapeHtml } from "./utils.js";
import { composeDashboardCharts } from './training-load-chart-composer.js';
import { radarChartOption } from './training-load-radar-options.js';

function withReference(plots, model, presentation) {
  const reference = model.series.length === 1 ? model.series[0].chartReference : null;
  const configured = presentation?.chartReference;
  if (!reference || !configured || !Number.isFinite(reference.lower) ||
      reference.lower !== configured.lower || reference.upper !== configured.upper ||
      reference.unit !== configured.unit || reference.metricVersionId !== configured.metricVersionId) return plots;
  const axis = presentation.chartVariant === 'horizontal-bar' ? 'xAxis' : 'yAxis';
  const unit = reference.unit ? ' ' + reference.unit : '';
  const caption = reference.upper === undefined
    ? 'Reference: ' + reference.lower + unit
    : 'Reference range: ' + reference.lower + '–' + reference.upper + unit;
  return plots.map(plot => {
    const [first, ...other] = plot.option.series;
    if (!first) return plot;
    const marks = reference.upper === undefined
      ? { markLine: { silent: true, symbol: 'none', lineStyle: { color: '#0f62fe', type: 'dashed' }, data: [{ [axis]: reference.lower }], label: { show: false } } }
      : { markArea: { silent: true, itemStyle: { color: 'rgba(15, 98, 254, 0.15)' },
          data: [[{ [axis]: reference.lower }, { [axis]: reference.upper }]] } };
    const values = plot.option.series.flatMap(series => series.data.map(point => point?.value).filter(Number.isFinite));
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const upper = reference.upper ?? reference.lower;
    const valueAxis = {
      ...plot.option[axis],
      ...(reference.lower < min ? { min: reference.lower } : {}),
      ...(upper > max ? { max: upper } : {})
    };
    return { ...plot, caption: plot.caption + ' · ' + caption,
      option: { ...plot.option, [axis]: valueAxis, series: [{ ...first, ...marks }, ...other] } };
  });
}

export function dashboardChartPlots(model, labelForSeries, rowContext, options = {}) {
  if (options.presentation != null) return withReference(composeDashboardCharts(model,labelForSeries,rowContext,options).plots, model, options.presentation);
  if (model.status !== "ready" || !["line_chart", "bar_chart"].includes(model.widgetType)) return [];
  const plots = [];
  const precision = model.config.effective.numberFormat.maximumFractionDigits;
  for (const series of model.series) {
    if (series.status !== "ready") continue;
    for (const group of series.chartGroups) {
      if (!group.rows.some(row => row.chartStatus === "value")) continue;
      const rows = [...group.rows];
      if (["day", "week"].includes(model.groupBy)) rows.sort((left, right) => String(left.identity.bucketKey).localeCompare(String(right.identity.bucketKey)));
      const name = labelForSeries(series.definition);
      const unit = group.identity.unit || "";
      const caption = [name, rowContext(rows[0]), unit].filter(Boolean).join(" · ");
      plots.push({
        caption,
        precision,
        option: {
          animation: false,
          color: ["#002d9c"],
          grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
          legend: { show: model.config.effective.legend.visible, type: "scroll", left: 12, right: 12, top: 4 },
          tooltip: { trigger: "axis", renderMode: "richText", confine: true },
          xAxis: { type: "category", data: rows.map(row => row.identity.bucketKey ?? ""), axisLabel: { hideOverlap: true } },
          yAxis: { type: "value", name: unit, nameLocation: "middle", nameGap: 42 },
          series: [{
            name,
            type: model.widgetType === "bar_chart" ? "bar" : "line",
            connectNulls: false,
            showSymbol: true,
            symbolSize: 7,
            barMaxWidth: 48,
            label: { show: model.config.effective.valueLabels.visible, position: "top" },
            data: rows.map(row => row.chartStatus === "value" ? {
              value: row.value,
              label: { formatter: Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(precision) },
            } : null),
          }],
        },
      });
    }
  }
  return plots;
}

export function renderDashboardChartPlots(model, labelForSeries, rowContext, options = {}) {
  if (options.presentation?.chartVariant === 'radar') {
    const snapshot = options.radarSnapshot;
    if (model.status !== 'ready' || !options.queryId || snapshot?.queryId !== options.queryId) {
      return '<p role="status">Radar needs fresh results from the server.</p>';
    }
    const labels = new Map(model.series.map(series => [series.definition.metric_definition_id, labelForSeries(series.definition)]));
    const athletes = new Map((options.athletes ?? []).map(athlete => [athlete.id,
      athlete.display_name || athlete.name || [athlete.first_name, athlete.last_name].filter(Boolean).join(' ')]));
    const option = radarChartOption(snapshot, labels, athletes);
    const radarDetails = ['100% reference', ...snapshot.athletes.filter(athlete => athlete.polygon !== null).map(athlete => [
      athletes.get(athlete.athleteId) || athlete.athleteId,
      ...athlete.axes.map(axis => `${labels.get(axis.metricDefinitionId) ?? axis.metricDefinitionId}: ${axis.measurementValue} / ${axis.referenceValue} ${axis.measurementUnit} · ${axis.value}%`)
    ].join('\n'))];
    const chart = option ? `<figure class="tl-analysis-plot">
      <figcaption>Reference attainment (%)</figcaption>
      <optimove-dashboard-chart data-chart="${escapeAttr(JSON.stringify({ option, radarDetails }))}">
        <div class="tl-analysis-echarts" aria-hidden="true"></div>
        <p class="muted tl-analysis-chart-failure" role="status" hidden>Chart unavailable. The values below are still available.</p>
        <p class="muted" data-radar-selection role="status" hidden></p>
      </optimove-dashboard-chart></figure>` : '<p role="status">No athlete has a complete set of reference values for this result.</p>';
    const details = snapshot.athletes.flatMap(athlete => athlete.axes.map(axis => {
      const name = athletes.get(athlete.athleteId) ?? athlete.athleteId;
      const metric = labels.get(axis.metricDefinitionId) ?? axis.metricDefinitionId;
      const reason = {
        singleDayRequired: 'choose a single day',
        missingDimension: 'historical reference dimensions are unavailable',
        missingMeasurementEvent: 'the daily result has no confirmed measurement event',
        missingMatchEvidence: 'confirmed match history is unavailable',
        missingMatchClassification: 'official or friendly classification is unavailable',
        missingHistoricalRoster: 'historical roster is unavailable',
        missingPlayingMinutes: 'confirmed playing minutes are unavailable'
      }[axis.reason] ?? axis.reason;
      const value = axis.status === 'ready' ? `${axis.value}% (${axis.measurementValue} / ${axis.referenceValue} ${axis.measurementUnit})` : `Unavailable (${reason})`;
      return `<li>${escapeHtml(name)} · ${escapeHtml(metric)} · ${escapeHtml(value)}</li>`;
    })).join('');
    return chart + `<details class="tl-radar-reference-values" open><summary>Reference values and status</summary><ul>${details}</ul></details>`;
  }
  const composition = options.presentation == null ? null : composeDashboardCharts(model,labelForSeries,rowContext,options);
  const plots = composition ? withReference(composition.plots, model, options.presentation) : dashboardChartPlots(model,labelForSeries,rowContext);
  if(composition?.status?.startsWith('boxplot')){
    const messages={boxplotConfigurationRequired:'Box plot needs one numeric metric, day or week grouping, a primary axis and no comparison.',boxplotInsufficientData:'No bucket has at least 5 reliable athlete values and finite statistics.',boxplotIndividualRequired:'Box plot needs individual athlete values, not whole-group aggregates.',boxplotUnitRequired:'Box plot needs a reported unit.',boxplotMixedSources:'Returned source identities differ. Choose one consistent source before comparing athletes.'};
    return `<p role="status">${escapeHtml(messages[composition.status] ?? 'Box plot is unavailable.')} All returned values remain in the table.</p>`;
  }
  const notice = composition && composition.status !== 'ready' ? `<p role="status">${escapeHtml(composition.status === 'requiresChoice' ? 'Select up to 20 athletes or use a table. No athletes have been omitted.' : composition.status === 'scatterPairsRequired' ? 'Scatter needs fresh server-confirmed X/Y pairs. Refresh the data or check Advanced settings. All returned values remain in the table.' : composition.status === 'scatterNoPairs' ? 'No reliable X/Y pairs are available for this selection. Inspect Values and status for missing or problem observations.' : composition.status === 'combinedConfigurationRequired' ? 'Bar + line needs two metrics, one per axis, grouped by day or week. Open Advanced settings. All returned values remain in the table.' : composition.status === 'heatmapConfigurationRequired' ? 'Heatmap needs one numeric metric grouped by day or week. All returned values remain in the table.' : 'Chart settings or the period are unavailable. All returned values remain in the table.')}</p>` : '';
  const referenceNotice = options.presentation?.chartReference && !model.series.some(series => series.chartReference)
    ? '<p role="status">Reference unavailable for these results. Check the metric version, unit and data status.</p>'
    : '';
  return notice + referenceNotice + plots.map(plot => `
    <figure class="tl-analysis-plot">
      <figcaption>${escapeHtml(plot.caption)}</figcaption>
      <optimove-dashboard-chart data-chart="${escapeAttr(JSON.stringify(plot))}">
        <div class="tl-analysis-echarts" aria-hidden="true"${Number.isSafeInteger(plot.renderHeight) && plot.renderHeight >= 320 && plot.renderHeight <= 800 ? ` style="height:${plot.renderHeight}px"` : ''}></div>
        <p class="muted tl-analysis-chart-failure" role="status" hidden>Chart unavailable. The values below are still available.</p>
        ${plot.enhanced ? `<details class="tl-chart-tools"><summary>Chart controls</summary><div class="tl-chart-controls" aria-label="Chart controls"></div></details><p class="tl-chart-interaction-status" role="status"></p><details class="tl-chart-point-details"><summary>Selected point details</summary><pre></pre></details>` : ''}
      </optimove-dashboard-chart>
    </figure>
  `).join("");
}
