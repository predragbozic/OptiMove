import {galleryChartPlot} from './training-load-gallery-options.js';
import { escapeAttr, escapeHtml } from "./utils.js";

import { dashboardGroupLabels } from "./training-load-analysis-group-labels.js";

export function dashboardChartPlots(model, labelForSeries, rowContext, groupLabels = dashboardGroupLabels(model)) {
  if (model.status !== "ready" || !["line_chart", "bar_chart"].includes(model.widgetType)) return [];
  if(model.galleryShape){
    const plot=galleryChartPlot(model.gallery,{
      seriesLabel:id=>labelForSeries(model.series.find(s=>s.id===id)?.definition??{}),
      athleteLabel:id=>rowContext({identity:{athleteId:id}}),bucketLabel:key=>groupLabels.get(key)||'Group',
      legendVisible:model.config.effective.legend.visible,valueLabelsVisible:model.config.effective.valueLabels.visible,
      precision:model.config.effective.numberFormat.maximumFractionDigits,bindings:model.galleryShape.bindings??[],
    });return plot?[configureDashboardPlot(plot,model)]:[];
  }
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
      plots.push({ caption: labelForSeries(series.definition), precision, shortDateAxis: true, bucketKeys:keys, option: {
        animation: false,
        grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
        legend: { show: model.config.effective.legend.visible, type: "scroll", top: 4 },
        tooltip: { trigger: "axis", renderMode: "richText", confine: true },
        xAxis: { type: "category", data: keys.map(key => groupLabels.get(key) || rowContext(series.chartGroups.flatMap(group => group.rows).find(row => row.identity.bucketKey === key))), axisLabel: { hideOverlap: true } },
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
        bucketKeys: rows.map(row => row.identity.bucketKey),
        option: {
          animation: false,
          color: ["#002d9c"],
          grid: { left: 12, right: 20, top: 48, bottom: 12, containLabel: true },
          legend: { show: model.config.effective.legend.visible, type: "scroll", left: 12, right: 12, top: 4 },
          tooltip: { trigger: "axis", renderMode: "richText", confine: true },
          xAxis: { type: "category", data: rows.map(row => groupLabels.get(row.identity.bucketKey ?? "") || rowContext(row)), axisLabel: { hideOverlap: true } },
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
  return plots.map(plot=>configureDashboardPlot(plot,model));
}

export function renderDashboardChartPlots(model, labelForSeries, rowContext, groupLabels = dashboardGroupLabels(model)) {
  const notice=model.galleryShape&&(!model.gallery||['empty','unavailable'].includes(model.gallery.status))
    ? '<p role="status">'+escapeHtml(galleryUnavailableMessage(model.gallery?.reason))+'</p>'
    : model.gallery?.omitted ? '<p role="status">'+Number(model.gallery.omitted)+' groups could not be shown. Review the values below.</p>' : '';
  return notice+dashboardChartPlots(model, labelForSeries, rowContext, groupLabels).map(plot => `
    <figure class="tl-analysis-plot">
      <figcaption>${escapeHtml(plot.caption)}</figcaption>
      <optimove-dashboard-chart data-chart="${escapeAttr(JSON.stringify(plot))}">
        <div class="tl-analysis-echarts" aria-hidden="true"></div>
        <p class="muted tl-analysis-chart-failure" role="status" hidden>Chart unavailable. The values below are still available.</p>
      </optimove-dashboard-chart>
    </figure>
  `).join("");
}

export function galleryUnavailableMessage(reason){return ({
 incompatibleAxisUnit:'These measurements need compatible labelled axes. Review the series units and axes.',
 nonAdditiveComponents:'These measurements cannot be added together. Choose additive components with one unit.',
 chooseTwoSeries:'This scatter plot needs two measurements. Choose its X and Y series.',
 chooseOneSeries:'This chart needs one measurement. Keep one series.',
 chooseDayOrWeek:'This chart needs dates. Group the results by day or week.',
 declareComponents:'The parts must be additive. Confirm the components before stacking.',
 athleteLimitExceeded:'This chart can show up to 20 athletes. Choose fewer athletes in the filter.',
 chartTooLarge:'This selection is too large. Choose fewer athletes or a shorter period.',
 seriesUnavailable:'A measurement is unavailable. Review the selected series.',
 incompatibleScope:'These measurements use different levels. Choose the same measurement level.',
 chooseAxes:'This combination needs a bar and a line. Choose their labelled axes.',
 }[reason]??'No values can be shown for this selection. Review the values or choose another period.');}

export function configureDashboardPlot(plot,model){
 const settings=model.chartInteractions??{};plot.interactions=structuredClone(settings);plot.period=model.period??null;plot.interactionGeneration=model.interactionGeneration??null;
 if(settings.pointSelection?.mode==='disabled'||model.groupBy!=='day'||!plot.bucketKeys?.every(key=>/^\d{4}-\d{2}-\d{2}$/.test(key))) delete plot.bucketKeys;
 if(settings.legend?.toggle===false&&plot.option.legend)plot.option.legend.selectedMode=false;
 const axes=Array.isArray(plot.option.yAxis)?plot.option.yAxis:[plot.option.yAxis];
 if(settings.yAxis?.mode==='fixed'&&axes[0]?.type==='value'){axes[0].min=settings.yAxis.min;axes[0].max=settings.yAxis.max;}
 const category=plot.option.xAxis?.type==='category'?'x':plot.option.yAxis?.type==='category'?'y':null;
 if(settings.zoom?.mode==='local'&&['day','week'].includes(model.groupBy)&&category){
  const axis=category==='x'?plot.option.xAxis:plot.option.yAxis;
  const dates=axis.data.map(value=>/^\d{2}\.\d{2}\.\d{4}$/.test(value)?value.split('.').reverse().join('-'):value);
  if(dates.every(value=>/^\d{4}-\d{2}-\d{2}$/.test(value))){
   plot.zoomDates=dates;
   plot.option.dataZoom=[{type:'inside',filterMode:'none',[category+'AxisIndex']:0},{type:'slider',filterMode:'none',[category+'AxisIndex']:0,orient:category==='y'?'vertical':'horizontal'}];
   if(category==='x')plot.option.grid.bottom=48;else plot.option.grid.right=48;
  }
 }
 return plot;
}
