import { escapeAttr, escapeHtml } from "./utils.js";
import { composeDashboardCharts } from './training-load-chart-composer.js';

export function dashboardChartPlots(model, labelForSeries, rowContext, options = {}) {
  if (options.presentation != null) return composeDashboardCharts(model,labelForSeries,rowContext,options).plots;
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
  const composition = options.presentation == null ? null : composeDashboardCharts(model,labelForSeries,rowContext,options);
  const plots = composition?.plots ?? dashboardChartPlots(model,labelForSeries,rowContext);
  const notice = composition && composition.status !== 'ready' ? `<p role="status">${escapeHtml(composition.status === 'requiresChoice' ? 'Select up to 20 athletes or use a table. No athletes have been omitted.' : composition.status === 'scatterPairsRequired' ? 'Scatter needs fresh server-confirmed X/Y pairs. Refresh the data or check Advanced settings. All returned values remain in the table.' : composition.status === 'scatterNoPairs' ? 'No reliable X/Y pairs are available for this selection. Inspect Values and status for missing or problem observations.' : composition.status === 'combinedConfigurationRequired' ? 'Bar + line needs two metrics, one per axis, grouped by day or week. Open Advanced settings. All returned values remain in the table.' : composition.status === 'heatmapConfigurationRequired' ? 'Heatmap needs one numeric metric grouped by day or week. All returned values remain in the table.' : 'Chart settings or the period are unavailable. All returned values remain in the table.')}</p>` : '';
  return notice + plots.map(plot => `
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
