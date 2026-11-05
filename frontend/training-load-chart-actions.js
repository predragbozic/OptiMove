import { state } from './state.js';
import { currentUserWorkspaceContextParts } from './access.js';
import { resetAnalysisDashboardQuery, queryAnalysisDashboard } from './training-load-analysis-data.js';
import { isChartDate } from './training-load-chart-composer.js';

export function dashboardChartContext() {
  const a=state.trainingLoad.analysis;
  return JSON.stringify([currentUserWorkspaceContextParts(),a.selectedDashboardId,...(a.pagesMode?[a.selectedPageId]:[]),a.period,a.runtimeFilter]);
}

export async function applyDashboardChartPeriod(detail, render) {
  const a=state.trainingLoad.analysis;
  const current=()=>state.activeTab==='training-load' && state.trainingLoad.section==='analysis' && !a.queryLoading && !a.simpleEditor && !a.editor?.open && !a.layoutDraft && a.dashboard?.status==='active' && !a.dashboard?.is_template && detail?.queryId && a.queryResult?.queryId===detail.queryId && detail.contextId===dashboardChartContext() && a.widgets.some(widget=>widget.id===detail.widgetId);
  if(!current() || detail.confirmed!==true || !isChartDate(detail.dateFrom) || !isChartDate(detail.dateTo) || detail.dateFrom>detail.dateTo || detail.dateFrom<a.period.dateFrom || detail.dateTo>a.period.dateTo) return false;
  if(detail.dateFrom===a.period.dateFrom && detail.dateTo===a.period.dateTo)return false;
  resetAnalysisDashboardQuery();
  a.period={...a.period,dateFrom:detail.dateFrom,dateTo:detail.dateTo};
  if(a.pagesMode)a.pageRuntimeUsesDefaults=false;
  await queryAnalysisDashboard(render,{force:true});
  render?.();
  return true;
}
