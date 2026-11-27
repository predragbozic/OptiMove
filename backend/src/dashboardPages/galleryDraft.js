import { randomUUID } from 'node:crypto';
import { validGalleryShape } from '../dashboardGallery/contract.js';
import { galleryAvailable } from '../dashboardGallery/query.js';
import { assertReferenceSource } from '../dashboardReferences/preview.js';
import { resolveReferenceContext } from '../dashboardReferences/access.js';
import { allowedDashboardAggregations } from '../dashboardRatios.js';
import { isMetricVisibleToDashboard } from '../trainingLoadDashboardAccess.js';
import { isUuid } from '../dashboardSimple/schema.js';

function fail(code = 'invalidRequest', httpStatus = 400) {
  throw Object.assign(new Error(code), { code, httpStatus });
}

export async function buildGalleryDraft(query, target, draft) {
  const allowed = ['kind', 'title', 'groupBy', 'series', 'additive', 'teamId'];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !allowed.includes(key))
    || !['area', 'horizontal_bar', 'combined', 'heatmap', 'scatter', 'stacked', 'boxplot', 'radar'].includes(draft.kind)
    || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 200
    || !['day', 'week', 'session', 'component', 'athlete', 'cohort'].includes(draft.groupBy)
    || !Array.isArray(draft.series) || !draft.series.length || draft.series.length > 8) fail();
  const radar = draft.kind === 'radar';
  if (!radar && !await galleryAvailable(query)) fail('notFound', 404);
  const distribution = ['heatmap', 'boxplot'].includes(draft.kind);
  if (distribution && !['day', 'week'].includes(draft.groupBy)) fail();
  if (radar && (draft.groupBy !== 'cohort' || !isUuid(draft.teamId) || draft.series.length < 3)) fail();
  const id = randomUUID();
  const series = [];
  for (const entry of draft.series) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['metricDefinitionId', 'builtInSeriesKey', 'dataScopeLevel', 'analyticalAggregation', 'mark', 'axis'].includes(key))
      || (entry.metricDefinitionId!==undefined)===(entry.builtInSeriesKey!==undefined)
      || !['day', 'session', 'component'].includes(entry.dataScopeLevel)
      || !['primary', 'secondary'].includes(entry.axis ?? 'primary')
      || (draft.kind === 'combined' && !['bar', 'line'].includes(entry.mark))) fail();
    let metadata;
    if(entry.builtInSeriesKey!==undefined){
      if(radar||typeof entry.builtInSeriesKey!=='string'||entry.builtInSeriesKey.length>100)fail();
      metadata=(await query(`select value_type,unit,label,array[fixed_data_scope_level] scopes from training_load.dashboard_builtin_series
        where key=$1 and is_active`,[entry.builtInSeriesKey])).rows[0];
    }else{
      if(!isUuid(entry.metricDefinitionId))fail();
      const {visible,def}=await isMetricVisibleToDashboard(target.dashboard,entry.metricDefinitionId,query);
      if(!visible||def?.state!=='active')fail('notFound',404);
      metadata=(await query(`select v.value_type,v.unit,v.calculation,d.label,
        array(select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id=d.id) scopes
        from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
        where d.id=$1 for share of d,v`,[entry.metricDefinitionId])).rows[0];
    }
    if (metadata?.value_type !== 'numeric' || metadata.scopes.length && !metadata.scopes.includes(entry.dataScopeLevel)
      || !allowedDashboardAggregations('numeric', metadata.calculation?.kind).includes(entry.analyticalAggregation)
      || (entry.analyticalAggregation === 'none') !== distribution
      || ['radar', 'stacked'].includes(draft.kind) && metadata.calculation) fail();
    series.push({
      id: randomUUID(), widget_id: id, series_order: series.length + 1, resolution_status: 'resolved',
      metric_definition_id:entry.metricDefinitionId??null,built_in_series_key:entry.builtInSeriesKey??null,data_scope_level:entry.dataScopeLevel,
      analytical_aggregation: entry.analyticalAggregation, axis: entry.axis ?? 'primary',
      display_label: metadata.label, galleryCalculation: metadata.calculation,
      aggregation_role_policy: metadata.calculation?.kind === 'ratio' ? 'all_including_derived' : 'standalone_and_source_rollup',
      source_policy:entry.builtInSeriesKey?'not_applicable':'all_with_conflicts',coverage_policy:'complete_and_partial',
    });
  }
  if (new Set(series.map(s=>(s.metric_definition_id??s.built_in_series_key).toLowerCase())).size!==series.length) fail();
  let presentation;
  if (radar) {
    const req = { ...target.req, _resolvedDataWorkspacePromise: Promise.resolve(target.workspace) };
    const context = process.env.DASHBOARD_REFERENCES_ENABLED === 'true' ? await resolveReferenceContext(req) : null;
    if (!context || context.readOnly) fail('notFound', 404);
    const referenceConfig = { schemaVersion: 1, source: 'teamAverage', mode: 'radar', clubId: context.owner.clubId,
      teamId: draft.teamId, axes: series.map(s => ({ seriesId: s.id, valueKeys: ['teamAverage'] })) };
    await assertReferenceSource(query, referenceConfig, context.owner.clubId, context.workspace);
    presentation = { schemaVersion: 1, referenceConfig };
  } else {
    const chartShape = { schemaVersion: 1, kind: draft.kind, seriesIds: series.map(s => s.id),
      ...(draft.kind === 'stacked' ? { additive: draft.additive } : {}),
      ...(draft.kind === 'combined' ? { bindings: series.map((s, i) => ({ seriesId: s.id, mark: draft.series[i].mark, axis: s.axis === 'secondary' ? 1 : 0 })) } : {}) };
    if (!validGalleryShape(chartShape)) fail();
    presentation = { schemaVersion: 1, chartShape };
  }
  return { id, widget_type: draft.kind === 'area' ? 'line_chart' : 'bar_chart', title: draft.title.trim(), group_by: draft.groupBy,
    display_config: { schemaVersion: 1 }, presentation_config: presentation, series };
}

export function bindGallerySeries(presentation, ids) {
  const copy = structuredClone(presentation);
  if (copy.referenceConfig) copy.referenceConfig.axes.forEach(axis => { axis.seriesId = ids.get(axis.seriesId); });
  if (copy.chartShape) {
    copy.chartShape.seriesIds = copy.chartShape.seriesIds.map(id => ids.get(id));
    copy.chartShape.bindings?.forEach(binding => { binding.seriesId = ids.get(binding.seriesId); });
  }
  return copy;
}
