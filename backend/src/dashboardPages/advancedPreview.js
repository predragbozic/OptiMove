import { isUuid } from '../dashboardSimple/schema.js';
import { isMetricVisibleToDashboard, isSourceConnectionVisibleToDashboard } from '../trainingLoadDashboardAccess.js';
import { allowedDashboardAggregations } from '../dashboardRatios.js';
import { validGalleryShape } from '../dashboardGallery/contract.js';

const refuse = (code = 'invalidRequest', httpStatus = 400) => {
  throw Object.assign(new Error(code), { code, httpStatus });
};
const hasOnly = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const fields = {
  analyticalAggregation: 'analytical_aggregation',
  aggregationRolePolicy: 'aggregation_role_policy',
  coveragePolicy: 'coverage_policy',
  dataScopeLevel: 'data_scope_level',
  sourcePolicy: 'source_policy',
  sourceConnectionId: 'source_connection_id',
  comparisonPeriod: 'comparison_period',
  displayLabel: 'display_label',
  color: 'color',
  axis: 'axis',
};
const settingsKeys = ['seriesOrder','metricDefinitionId','builtInSeriesKey',...Object.keys(fields)];

export async function buildAdvancedPreviewWidget(query, dashboard, widget, draft, validateWidgetBody) {
  if (!hasOnly(draft, ['widgetId','expectedWidgetRevision','title','widgetType','groupBy','localFilterOverride','series','chartShape'])
    || !isUuid(draft.widgetId) || !Number.isSafeInteger(draft.expectedWidgetRevision)
    || !['kpi','table','line_chart','bar_chart'].includes(draft.widgetType)
    || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 200
    || !Array.isArray(draft.series) || draft.series.length > 20) refuse();
  if (!widget) refuse('notFound', 404);
  if (widget.revision !== draft.expectedWidgetRevision) refuse('staleRevision', 409);

  const { widgetType, title, groupBy, localFilterOverride } = draft;
  if (!validateWidgetBody('content', { expectedWidgetRevision: widget.revision, widgetType, title, groupBy, localFilterOverride }, {})) refuse();
  const type = (await query('select max_series from training_load.dashboard_widget_types where key=$1 and is_active',[widgetType])).rows[0];
  if (!type || type.max_series != null && draft.series.length > type.max_series) refuse();

  const draftIds = new Set();
  const priorIds = new Set();
  const series = [];
  for (const item of draft.series) {
    if (!hasOnly(item, ['draftId','previousSeriesId','settings']) || !isUuid(item.draftId) || draftIds.has(item.draftId.toLowerCase())
      || !hasOnly(item.settings, settingsKeys) || item.settings.seriesOrder !== series.length + 1
      || !validateWidgetBody('addSeries', { ...item.settings, expectedWidgetRevision: widget.revision }, {})) refuse();
    const s = item.settings;
    draftIds.add(item.draftId.toLowerCase());
    let prior;
    if (item.previousSeriesId !== undefined) {
      if (!isUuid(item.previousSeriesId) || priorIds.has(item.previousSeriesId.toLowerCase())) refuse();
      prior = widget.series.find(row => row.id === item.previousSeriesId.toLowerCase());
      if (!prior) refuse('notFound', 404);
      priorIds.add(item.previousSeriesId.toLowerCase());
    }

    let metadata;
    if (s.metricDefinitionId) {
      const { visible, def } = await isMetricVisibleToDashboard(dashboard, s.metricDefinitionId, query);
      if (!visible || !def || def.state !== 'active' && prior?.metric_definition_id !== s.metricDefinitionId.toLowerCase()) refuse('notFound', 404);
      metadata = (await query(`select v.value_type,v.unit,v.calculation,
        array(select scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id=d.id) scopes
        from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
        where d.id=$1`, [s.metricDefinitionId])).rows[0];
      if (s.sourcePolicy === 'not_applicable') refuse();
    } else {
      metadata = (await query(`select value_type,unit,array[fixed_data_scope_level] scopes
        from training_load.dashboard_builtin_series where key=$1 and is_active`,[s.builtInSeriesKey])).rows[0];
      if (s.sourcePolicy !== 'not_applicable') refuse();
    }
    if (!metadata || metadata.scopes.length && !metadata.scopes.includes(s.dataScopeLevel)
      || !allowedDashboardAggregations(metadata.value_type, metadata.calculation?.kind).includes(s.analyticalAggregation)
      || metadata.calculation?.kind === 'ratio' && s.aggregationRolePolicy !== 'all_including_derived'
      || s.comparisonPeriod && widgetType !== 'kpi') refuse();
    if (s.sourcePolicy === 'source_connection') {
      if (!isUuid(s.sourceConnectionId)) refuse();
      const {visible,conn}=await isSourceConnectionVisibleToDashboard(dashboard,s.sourceConnectionId,query);
      if (!visible || !conn || conn.state !== 'active' && prior?.source_connection_id !== s.sourceConnectionId.toLowerCase()) refuse('notFound', 404);
    } else if (s.sourceConnectionId != null) refuse();

    series.push({
      id: item.draftId, widget_id: widget.id, series_order: s.seriesOrder, resolution_status: 'resolved',
      metric_definition_id: s.metricDefinitionId?.toLowerCase() ?? null, built_in_series_key: s.builtInSeriesKey ?? null,
      ...Object.fromEntries(Object.entries(fields).map(([key,column]) => [column,s[key] ?? null])),
      galleryCalculation: metadata.calculation,
    });
  }
  if (draft.chartShape && (!['line_chart','bar_chart'].includes(widgetType) || !validGalleryShape(draft.chartShape)
    || !draft.chartShape.seriesIds.every(id => draftIds.has(id.toLowerCase())))) refuse();
  const presentation = widget.presentation_config?.schemaVersion === 1 ? { ...widget.presentation_config } : {};
  delete presentation.chartShape;
  delete presentation.referenceConfig;
  if (!['line_chart','bar_chart'].includes(widgetType)) {
    delete presentation.chartInteractions;
    delete presentation.chartComposition;
  }
  return {
    id: widget.id, title, widget_type: widgetType, group_by: groupBy,
    display_config: widget.display_config, local_filter_override: localFilterOverride, series,
    presentation_config: { ...presentation, schemaVersion: 1, ...(draft.chartShape ? { chartShape: draft.chartShape } : {}) },
  };
}
