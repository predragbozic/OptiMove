import { escapeAttr, escapeHtml } from "./utils.js";

export function dashboardChartPlots(model, labelForSeries, rowContext) {
  if (model.status !== "ready" || model.widgetType !== "line_chart") return [];
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
          color: ["#0f62fe"],
          grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
          legend: { show: model.config.effective.legend.visible, type: "scroll", left: 12, right: 12, top: 4 },
          tooltip: { trigger: "axis", renderMode: "richText", confine: true },
          xAxis: { type: "category", data: rows.map(row => row.identity.bucketKey ?? ""), axisLabel: { hideOverlap: true } },
          yAxis: { type: "value", name: unit, nameLocation: "middle", nameGap: 42 },
          series: [{
            name,
            type: "line",
            connectNulls: false,
            showSymbol: true,
            symbolSize: 7,
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

export function renderDashboardChartPlots(model, labelForSeries, rowContext) {
  return dashboardChartPlots(model, labelForSeries, rowContext).map(plot => `
    <figure class="tl-analysis-plot">
      <figcaption>${escapeHtml(plot.caption)}</figcaption>
      <optimove-dashboard-chart data-chart="${escapeAttr(JSON.stringify(plot))}">
        <div class="tl-analysis-echarts" aria-hidden="true"></div>
        <p class="muted tl-analysis-chart-failure" role="status" hidden>Chart unavailable. The values below are still available.</p>
      </optimove-dashboard-chart>
    </figure>
  `).join("");
}
