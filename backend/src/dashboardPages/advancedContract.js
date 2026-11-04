import { isUuid, validateContract } from '../dashboardSimple/schema.js';
import { pageJsonIssue } from './contract.js';

const revision = v => Number.isSafeInteger(v) && v >= 1;
const integer = (v, min = 0, max = 1000000) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const enums = {
  groupBy: ['day','week','session','component','athlete','cohort'], state: ['active','collapsed'], axis: ['primary','secondary'],
  sourcePolicy: ['all_with_conflicts','source_connection','manual','api_import','csv_import','derived','not_applicable'],
  dataScopeLevel: ['day','session','component'], analyticalAggregation: ['sum','avg','max','last','none'],
  aggregationRolePolicy: ['standalone_only','standalone_and_source_rollup','all_including_derived'], coveragePolicy: ['complete_only','complete_and_partial','any'], comparisonPeriod: ['previous_period','previous_year'],
};
const layoutKeys = ['x','y','width','height','mobileOrder'];
const contentKeys = ['widgetType','title','groupBy','state','displayConfig','localFilterOverride','presentation'];
const seriesKeys = ['axis','color','displayLabel','sourcePolicy','sourceConnectionId','dataScopeLevel','analyticalAggregation','aggregationRolePolicy','coveragePolicy','comparisonPeriod'];
const definitions = {
  layout: [['expectedPageLayoutRevision','layout'], []],
  widgetCreate: [['expectedPageRevision','widgetType','title','widgetOrder',...layoutKeys], ['groupBy','displayConfig','localFilterOverride','presentation']],
  widgetLayout: [['expectedWidgetRevision'], layoutKeys],
  widgetContent: [['expectedWidgetRevision'], contentKeys],
  widgetDelete: [['expectedWidgetRevision'], []],
  seriesAdd: [['expectedWidgetRevision','seriesOrder'], ['metricDefinitionId','builtInSeriesKey','templateMetricKeyHints',...seriesKeys]],
  seriesUpdate: [['expectedWidgetRevision'], seriesKeys],
  seriesDelete: [['expectedWidgetRevision'], []],
  seriesReorder: [['expectedWidgetRevision','order'], []],
  seriesResolve: [['expectedWidgetRevision','metricDefinitionId'], []],
};
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const known = (v, keys) => plain(v) && Object.keys(v).every(k => keys.includes(k));
const dimensions = (key, value) => key === 'x' ? integer(value,0,11) : key === 'width' ? integer(value,1,12) : key === 'height' ? integer(value,1,32767) : key === 'y' ? integer(value,0,32767) : integer(value);
const distinct = ids => new Set(ids.map(id => typeof id === 'string' ? id.toLowerCase() : id)).size === ids.length;

export function validatePageAdvancedRequest(operation, body) {
  if (!Object.hasOwn(definitions, operation)) return false;
  if (pageJsonIssue(body) || !plain(body)) return false;
  const [required, optional] = definitions[operation];
  if (!known(body, ['contractVersion','requestId',...required,...optional]) || body.contractVersion !== 1 || !isUuid(body.requestId) || required.some(k => !Object.hasOwn(body,k))) return false;
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('expected') && !revision(value)) return false;
    if (layoutKeys.includes(key) && !dimensions(key,value)) return false;
    if (['widgetOrder','seriesOrder'].includes(key) && !integer(value)) return false;
    if (enums[key] && !(key === 'comparisonPeriod' && value === null) && !enums[key].includes(value)) return false;
    if (['widgetType','title','builtInSeriesKey'].includes(key) && !text(value, key === 'builtInSeriesKey' ? 100 : 200)) return false;
    if (['color','displayLabel'].includes(key) && value !== null && !text(value,500)) return false;
    if (['sourceConnectionId','metricDefinitionId'].includes(key) && value !== null && !isUuid(value)) return false;
    if (key === 'displayConfig' && (!plain(value) || !revision(value.schemaVersion))) return false;
    if (key === 'localFilterOverride' && value !== null && !validateContract('runtimeFilter',value).valid) return false;
    if (key === 'presentation' && (!validateContract('presentationMode',value).valid || value.value?.tableFormatting?.rules?.length || operation === 'widgetCreate' && value.mode !== 'replace')) return false;
  }
  if (operation === 'seriesResolve' && !isUuid(body.metricDefinitionId)) return false;
  if (['widgetLayout','widgetContent','seriesUpdate'].includes(operation) && !optional.some(k => Object.hasOwn(body,k))) return false;
  if (operation === 'seriesAdd') {
    const { metricDefinitionId: metric, builtInSeriesKey: builtin, templateMetricKeyHints: hints } = body;
    if (metric && (builtin || hints !== undefined) || builtin && hints !== undefined) return false;
    if (hints !== undefined && (!Array.isArray(hints) || !hints.length || hints.length > 100 || !hints.every(h => known(h,['key','valueType','unit','scopeLevel']) && text(h.key,200) && (h.valueType == null || ['numeric','text','boolean'].includes(h.valueType)) && (h.unit == null || typeof h.unit === 'string' && h.unit.length <= 100) && (h.scopeLevel == null || enums.dataScopeLevel.includes(h.scopeLevel))))) return false;
    if (!metric && !builtin && !hints) return false;
    if (builtin && (body.sourcePolicy !== undefined && body.sourcePolicy !== 'not_applicable' || body.sourceConnectionId != null)) return false;
  }
  if (operation === 'layout') {
    if (!Array.isArray(body.layout) || !body.layout.length || body.layout.length > 200 || !distinct(body.layout.map(e => e?.widgetId))) return false;
    if (!body.layout.every(e => known(e,['widgetId',...layoutKeys]) && isUuid(e.widgetId) && layoutKeys.some(k => Object.hasOwn(e,k)) && layoutKeys.every(k => !Object.hasOwn(e,k) || dimensions(k,e[k])))) return false;
  }
  if (operation === 'seriesReorder') {
    if (!Array.isArray(body.order) || !body.order.length || body.order.length > 200 || !distinct(body.order.map(e => e?.seriesId)) || !distinct(body.order.map(e => e?.seriesOrder))) return false;
    if (!body.order.every(e => known(e,['seriesId','seriesOrder']) && isUuid(e.seriesId) && integer(e.seriesOrder))) return false;
  }
  return true;
}
