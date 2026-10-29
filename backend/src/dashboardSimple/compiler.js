// S1.1 pure compiler: consumes server-loaded capabilities/context. It does not
// query measurements, execute rules, save widgets, mint tokens or mutate inputs.
import { createHash } from 'node:crypto';
import { validateEditorDraft, validateContract } from './schema.js';
import { bindingVisible } from './capabilities.js';
const charts = new Set(['line_chart', 'bar_chart']);
const composed = new Set(['day', 'week', 'athlete']);
const aggs = ['sum', 'avg', 'max', 'last', 'none'];
const sourcePolicies = ['all_with_conflicts', 'source_connection', 'manual', 'api_import', 'csv_import', 'derived', 'not_applicable'];
const own = (o, k) => Object.hasOwn(o ?? {}, k);
const clone = v => structuredClone(v);
export function canonicalKey(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalKey).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalKey(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const fingerprint = v => createHash('sha256').update(canonicalKey(v)).digest('hex');
const idFor = (draftId, slot) => { const h = fingerprint([draftId, slot]); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function resolvePeriod(config, evaluatedAt) {
  if (config.mode === 'fixed') return { dateFrom: config.dateFrom, dateTo: config.dateTo, timeZone: config.timeZone };
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('Server evaluatedAt required');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(evaluatedAt)).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (config.preset === 'this_week') { const n = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; return { dateFrom: shift(today, -n), dateTo: shift(today, 6 - n), timeZone: config.timeZone }; }
  return { dateFrom: shift(today, config.preset === 'last_28_days' ? -27 : config.preset === 'last_7_days' ? -6 : 0), dateTo: today, timeZone: config.timeZone };
}
function preservedField(mode, key, existing, fallback) {
  if (!mode) return clone(fallback);
  if (mode.mode === 'preserve') return clone(existing[key]);
  if (mode.mode === 'clear') return null;
  return clone(mode.value);
}
export function compileSimpleDraft(draft, snapshot, context = {}, existing = null) {
  const operation = existing ? 'update' : 'create';
  const structural = validateEditorDraft(draft, { operation, complete: false });
  if (!structural.valid) return { status: 'invalid', issues: structural.issues };
  const issues = [], choices = [];
  const issue = (code, path) => issues.push({ code, path });
  const choice = path => choices.push({ code: 'requiresChoice', path });
  const builtin = draft.metricRef.kind === 'builtin';
  const m = snapshot?.metric;
  // Not an authorization entry point: snapshots must come from the authorized
  // reader. Binding checks are repeated here against their target, never global
  // catalog visibility. No caller-selected owner/workspace fields enter a draft.
  if (!snapshot?.dashboard || !m || canonicalKey(snapshot.metricRef) !== canonicalKey(draft.metricRef) || (builtin ? m.key !== draft.metricRef.key || m.is_active !== true : m.id?.toLowerCase() !== draft.metricRef.metricDefinitionId.toLowerCase() || m.state !== 'active' || !bindingVisible(snapshot.dashboard, m))) return { status: 'invalid', issues: [{ code: 'notFound', path: '$.metricRef' }] };
  if (!own(m, 'unit') || !['numeric', 'text', 'boolean'].includes(m.value_type)) issue('invalidCatalogMetadata', '$.metricRef');
  if (existing && (existing.series?.length !== 1 || existing.series[0].resolution_status !== 'resolved')) return { status: 'advancedRequired', issues: [{ code: 'advancedRequired', path: '$' }] };
  const previous = existing?.series[0];
  if (previous?.template_metric_key_hints || previous?.template_resolution_candidates) return { status: 'advancedRequired', issues: [{ code: 'advancedRequired', path: '$.metricRef' }] };
  if (existing && Object.keys(existing.local_filter_override ?? {}).some(k => !['athleteIds', 'activityId', 'componentId'].includes(k))) return { status: 'advancedRequired', issues: [{ code: 'advancedRequired', path: '$.advancedFilter' }] };
  const view = clone(draft.view);
  const scopes = builtin ? [m.fixed_data_scope_level] : m.scope_capabilities;
  if (!Array.isArray(scopes) || scopes.some(scope => !['day', 'session', 'component'].includes(scope))) return { status: 'invalid', issues: [{ code: 'invalidCatalogMetadata', path: '$.metricRef' }] };
  if (!view.dataScopeLevel && scopes.length === 1) view.dataScopeLevel = scopes[0];
  if (!view.analyticalAggregation && builtin) view.analyticalAggregation = m.default_analytical_aggregation;
  // Daily metric aggregation is Stage 1, never an inferred analytical default.
  for (const key of ['type', 'groupBy', 'dataScopeLevel', 'analyticalAggregation']) if (!own(view, key)) choice(`$.view.${key}`);
  if (choices.length) return { status: 'requiresChoice', issues: choices };
  const complete = validateEditorDraft({ ...draft, view }, { operation });
  if (!complete.valid) return { status: 'invalid', issues: complete.issues };
  if (!snapshot.widgetTypes?.some(t => t.key === view.type && t.is_active === true)) issue('inactiveWidgetType', '$.view.type');
  if (scopes.length && !scopes.includes(view.dataScopeLevel)) issue('scopeCapability', '$.view.dataScopeLevel');
  if (m.value_type !== 'numeric' && !['last', 'none'].includes(view.analyticalAggregation)) issue('aggregationType', '$.view.analyticalAggregation');
  if (!aggs.includes(view.analyticalAggregation)) issue('aggregationType', '$.view.analyticalAggregation');
  if (charts.has(view.type) && m.value_type !== 'numeric') issue('numericChartRequired', '$.view.type');
  if (draft.periodIntent.savePageDefaults && !snapshot.capabilities.pages) issue('unsupportedCapability', '$.periodIntent.savePageDefaults');
  const localFilter = clone(existing?.local_filter_override ?? {});
  if (draft.athleteSelection.mode === 'inherit') delete localFilter.athleteIds;
  else localFilter.athleteIds = draft.athleteSelection.mode === 'allAuthorized' ? null : [...draft.athleteSelection.athleteIds].map(x => x.toLowerCase()).sort();
  for (const [field, selection] of Object.entries(draft.advancedFilter ?? {})) {
    const key = `${field}Id`;
    if (selection.mode === 'inherit') delete localFilter[key]; else localFilter[key] = selection.mode === 'clear' ? null : selection.id.toLowerCase();
  }
  const effectiveFilter = { ...(context.defaultFilter ?? {}), ...(context.pageDefaultFilter ?? {}), ...(context.runtimeFilter ?? {}), ...localFilter };
  // Authorization is supplied by the future context resolver, never by body data.
  const authorized = context.authorizedAthleteIds;
  if (!Array.isArray(authorized)) issue('authorizedContextRequired', '$.athleteSelection');
  const allowed = new Set((authorized ?? []).map(x => x.toLowerCase()));
  if (Array.isArray(effectiveFilter.athleteIds) && effectiveFilter.athleteIds.some(id => !allowed.has(id.toLowerCase()))) issue('notFound', '$.athleteSelection');
  const athleteIds = (effectiveFilter.athleteIds?.length ? effectiveFilter.athleteIds : [...allowed]).map(x => x.toLowerCase()).sort();
  if (context.athleteWorkspaceAthleteId) {
    const id = context.athleteWorkspaceAthleteId.toLowerCase();
    if (!allowed.has(id)) issue('notFound', '$.athleteSelection');
    effectiveFilter.athleteIds = [id];
  } else effectiveFilter.athleteIds = athleteIds;
  for (const field of ['activityId', 'componentId']) if (effectiveFilter[field] != null && !context.authorizedFilterIds?.[field]?.includes(effectiveFilter[field])) issue('notFound', `$.advancedFilter.${field}`);
  if (effectiveFilter.componentId && context.componentActivityId !== effectiveFilter.activityId) issue('componentActivityMismatch', '$.advancedFilter.component');
  const sourcePolicy = builtin ? previous?.source_policy ?? 'not_applicable' : previous?.source_policy ?? 'all_with_conflicts';
  const connectionId = previous?.source_connection_id ?? null;
  if (!sourcePolicies.includes(sourcePolicy) || builtin && sourcePolicy !== 'not_applicable' || !builtin && sourcePolicy === 'not_applicable') issue('sourcePolicy', '$.metricRef');
  if ((sourcePolicy === 'source_connection') !== (connectionId !== null)) issue('sourceConnectionRequired', '$.metricRef');
  if (connectionId && (snapshot.connection?.id !== connectionId || snapshot.connection.state !== 'active' || !bindingVisible(snapshot.dashboard, snapshot.connection))) issue('notFound', '$.metricRef');
  const rolePolicy = previous?.aggregation_role_policy ?? 'standalone_and_source_rollup';
  const coveragePolicy = previous?.coverage_policy ?? 'complete_and_partial';
  if (!['standalone_only', 'standalone_and_source_rollup', 'all_including_derived'].includes(rolePolicy)) issue('aggregationRolePolicy', '$.metricRef');
  if (!['complete_only', 'complete_and_partial', 'any'].includes(coveragePolicy)) issue('coveragePolicy', '$.metricRef');
  const type = snapshot.widgetTypes?.find(t => t.key === view.type);
  if (previous?.comparison_period && (!type?.supports_comparison_period || !['previous_period', 'previous_year'].includes(previous.comparison_period))) issue('comparisonPeriod', '$.view.type');
  if (previous?.axis && !['primary', 'secondary'].includes(previous.axis)) issue('axis', '$.metricRef');
  if (draft.display?.mode === 'preserve' && existing.display_config != null && existing.display_config.schemaVersion !== 1 && !validateContract('displayV2', existing.display_config).valid) return { status: 'advancedRequired', issues: [{ code: 'unsupportedDisplay', path: '$.display' }] };
  const display = preservedField(draft.display, 'display_config', existing, { schemaVersion: 2 });
  const presentation = preservedField(draft.presentation, 'presentation_config', existing, charts.has(view.type) ? { schemaVersion: 1, ...(composed.has(view.groupBy) ? { chartComposition: 'athletes-v1' } : {}), chartInteractions: { tooltip: { mode: 'exact' }, legend: { toggle: true }, zoom: { mode: ['day', 'week'].includes(view.groupBy) ? 'local' : 'disabled', applyPeriodAction: ['day', 'week'].includes(view.groupBy) }, pointSelection: { mode: 'details' }, yAxis: { mode: 'auto' } } } : null);
  const supportedPresentation = presentation?.schemaVersion === 1;
  if (supportedPresentation && !validateContract('presentationV1', presentation).valid) return { status: 'advancedRequired', issues: [{ code: 'invalidStoredPresentation', path: '$.presentation' }] };
  const semanticChanged = existing && (existing.widget_type !== view.type || existing.group_by !== view.groupBy || previous.metric_definition_id !== (builtin ? null : m.id) || previous.built_in_series_key !== (builtin ? m.key : null) || previous.data_scope_level !== view.dataScopeLevel || previous.analytical_aggregation !== view.analyticalAggregation || canonicalKey(existing.local_filter_override ?? {}) !== canonicalKey(localFilter));
  if (draft.presentation?.mode === 'preserve' && presentation && (presentation.schemaVersion !== 1 || presentation.tableFormatting?.rules?.length) && semanticChanged) return { status: 'advancedRequired', issues: [{ code: 'presentationRevalidationRequired', path: '$.presentation' }] };
  if (supportedPresentation && presentation?.chartComposition && !composed.has(view.groupBy)) issue('unsupportedComposition', '$.presentation.chartComposition');
  if (supportedPresentation && presentation?.chartComposition && (!charts.has(view.type) || !snapshot.capabilities.chartComposition.includes(presentation.chartComposition))) issue('unsupportedCapability', '$.presentation.chartComposition');
  if (supportedPresentation && (presentation?.chartInteractions && !charts.has(view.type) || presentation?.tableFormatting && view.type !== 'table')) issue('incompatiblePresentation', '$.presentation');
  if (supportedPresentation && !['day', 'week'].includes(view.groupBy) && (presentation?.chartInteractions?.zoom?.mode === 'local' || presentation?.chartInteractions?.zoom?.applyPeriodAction)) issue('temporalZoomRequired', '$.presentation.chartInteractions.zoom');
  if (supportedPresentation && presentation?.chartComposition === 'athletes-v1' && effectiveFilter.athleteIds.length > 20) choices.push({ code: 'requiresChoice', path: '$.athleteSelection', reason: 'maxChartAthletes', limit: 20 });
  for (const [index, rule] of (supportedPresentation ? presentation?.tableFormatting?.rules ?? [] : []).entries()) {
    const path = `$.presentation.tableFormatting.rules[${index}]`;
    if (m.value_type !== 'numeric') issue('numericRuleRequired', path);
    const thresholdUnit = (rule.threshold ?? rule.range)?.unit;
    if (thresholdUnit !== (rule.operand === 'referencePercent' ? '%' : m.unit)) issue('unitMismatch', path);
    if (rule.reference?.kind === 'constant' && rule.reference.unit !== m.unit) issue('referenceUnitMismatch', path + '.reference');
    if (rule.reference?.kind === 'backendReference' && !snapshot.capabilities.backendReference || rule.operand === 'referencePercent' && !snapshot.capabilities.referencePercent) issue('unsupportedCapability', path);
    if (rule.target.athletes.mode === 'selected' && rule.target.athletes.athleteIds.some(id => !effectiveFilter.athleteIds.includes(id.toLowerCase()))) issue('notFound', path + '.target');
  }
  let period = context.period;
  if (draft.periodIntent.mode === 'replacePageRuntime') {
    if (draft.periodIntent.periodConfig.mode === 'relative' && (typeof context.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(context.evaluatedAt)))) issue('serverTimeRequired', '$.periodIntent');
    else period = resolvePeriod(draft.periodIntent.periodConfig, context.evaluatedAt);
  }
  if (!period || !validateContract('context', { kind: 'legacyDashboard', period }).valid) issue('periodRequired', '$.periodIntent');
  if (issues.length) return { status: 'invalid', issues };
  if (choices.length) return { status: 'requiresChoice', issues: choices };
  const series = { ...(previous ? clone(previous) : {}), id: previous?.id ?? idFor(draft.draftId, 'series'), metric_definition_id: builtin ? null : m.id, built_in_series_key: builtin ? m.key : null, resolution_status: 'resolved', series_order: previous?.series_order ?? 0, axis: previous?.axis ?? 'primary', source_policy: sourcePolicy, source_connection_id: connectionId, data_scope_level: view.dataScopeLevel, analytical_aggregation: view.analyticalAggregation, aggregation_role_policy: rolePolicy, coverage_policy: coveragePolicy, comparison_period: previous?.comparison_period ?? null };
  const widget = { ...(existing ? clone(existing) : {}), id: existing?.id ?? idFor(draft.draftId, 'widget'), widget_type: view.type, title: draft.title.trim(), group_by: view.groupBy, display_config: display, presentation_config: presentation, local_filter_override: localFilter, series: [series] };
  return { status: 'valid', issues: [], widget, resolvedPeriod: clone(period), effectiveFilter, catalogToken: fingerprint({ metric: m, connection: snapshot.connection, type }), semanticBinding: { metricRef: clone(draft.metricRef), unit: m.unit, valueType: m.value_type, versionId: m.current_version_id ?? null, fingerprint: fingerprint({ metricRef: draft.metricRef, version: m.current_version_id ?? null, unit: m.unit, valueType: m.value_type, view, sourcePolicy, connectionId, rolePolicy, coveragePolicy, period, effectiveFilter }), proof: 'catalogOnly', requiresResultSemanticProof: true }, chartPlan: supportedPresentation && presentation?.chartComposition === 'athletes-v1' ? { mode: 'athletes-v1', seriesBy: ['day', 'week'].includes(view.groupBy) ? 'athleteId' : null, categoryBy: view.groupBy === 'athlete' ? 'athleteId' : 'bucketKey', maxAthletes: 20, gap: 'noObservation' } : null, requiresPreview: true };
}
