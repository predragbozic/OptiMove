import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

function chartBucketLabel(key, row, index, rowContext) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key ?? "")) return formatDate(key);
  if (/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[{}\[\]]/i.test(String(key))) {
    return row?.identity.athleteId && String(key).toLowerCase() === String(row.identity.athleteId).toLowerCase()
      ? rowContext(row) : `Group ${index + 1}`;
  }
  return key ?? "";
}

export function dashboardChartPlots(model, labelForSeries, rowContext) {
  if (model.status !== "ready" || !["line_chart", "bar_chart"].includes(model.widgetType)) return [];
  const plots = [];
  const precision = model.config.effective.numberFormat.maximumFractionDigits;
  for (const series of model.series) {
    if (series.status !== "ready") continue;
    const athleteLines = model.widgetType === "line_chart" && ["day", "week"].includes(model.groupBy)
      && series.chartGroups.length > 1 && series.chartGroups.every(group => group.identity.athleteId)
      && new Set(series.chartGroups.map(group => group.identity.athleteId)).size === series.chartGroups.length
      && new Set(series.chartGroups.map(group => group.identity.unit)).size === 1;
    if (athleteLines) {
      const keys = [...new Set(series.chartGroups.flatMap(group => group.rows.map(row => row.identity.bucketKey)))].sort();
      const usedNames = new Set();
      const names = series.chartGroups.map(group => {
        const base = rowContext(group.rows[0]) || "Athlete name unavailable";
        let name = base;
        let suffix = 2;
        while (usedNames.has(name)) name = base + " (" + suffix++ + ")";
        usedNames.add(name);
        return name;
      });
      plots.push({ caption: labelForSeries(series.definition), precision, shortDateAxis: true, option: {
        animation: false,
        grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
        legend: { show: model.config.effective.legend.visible, type: "scroll", top: 4 },
        tooltip: { trigger: "axis", renderMode: "richText", confine: true },
        xAxis: { type: "category", data: keys.map((key, index) => chartBucketLabel(key, series.chartGroups.flatMap(group => group.rows).find(row => row.identity.bucketKey === key), index, rowContext)), axisLabel: { hideOverlap: true } },
        yAxis: { type: "value", name: series.chartGroups[0].identity.unit || "" },
        series: series.chartGroups.map((group, index) => {
          const rows = new Map(group.rows.map(row => [row.identity.bucketKey, row]));
          return { name: names[index], id: String(index), type: "line", connectNulls: false,
            data: keys.map(key => rows.get(key)?.chartStatus === "value" ? rows.get(key).value : null) };
        }),
      } });
      continue;
    }
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
        shortDateAxis: true,
        option: {
          animation: false,
          color: ["#002d9c"],
          grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
          legend: { show: model.config.effective.legend.visible, type: "scroll", left: 12, right: 12, top: 4 },
          tooltip: { trigger: "axis", renderMode: "richText", confine: true },
          xAxis: { type: "category", data: rows.map((row, index) => chartBucketLabel(row.identity.bucketKey, row, index, rowContext)), axisLabel: { hideOverlap: true } },
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
