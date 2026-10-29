// S1.1 26162ae: isolated JSON contracts. No routes, database or evaluator.
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const en = (...values) => ({ enum: values });
const str = (maxLength = 200) => ({ type: 'string', minLength: 1, maxLength });
const num = { type: 'number' };
const bool = { type: 'boolean' };
const uuid = { type: 'string', format: 'uuid' };
const date = { type: 'string', format: 'date' };
const unit = { oneOf: [str(100), { type: 'null' }] };
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ids = { type: 'array', items: uuid, minItems: 1, maxItems: 500, uniqueItems: true };
const union = (...oneOf) => ({ oneOf });
const tagged = (key, value, fields = {}, required) => obj({ [key]: { const: value }, ...fields }, required ?? [key, ...Object.keys(fields)]);
export const metricRefSchema = union(tagged('kind', 'metric', { metricDefinitionId: uuid }), tagged('kind', 'builtin', { key: str(100) }));
export const athleteSelectionSchema = union(tagged('mode', 'inherit'), tagged('mode', 'allAuthorized'), tagged('mode', 'selected', { athleteIds: ids }));
export const filterSelectionSchema = union(tagged('mode', 'inherit'), tagged('mode', 'clear'), tagged('mode', 'selected', { id: uuid }));
export const periodConfigSchema = union(
  tagged('mode', 'fixed', { schemaVersion: { const: 1 }, dateFrom: date, dateTo: date, timeZone: { type: 'string', format: 'time-zone' } }),
  tagged('mode', 'relative', { schemaVersion: { const: 1 }, preset: en('today', 'last_7_days', 'last_28_days', 'this_week'), timeZone: { type: 'string', format: 'time-zone' } }),
);
export const periodIntentSchema = union(tagged('mode', 'inherit'), tagged('mode', 'replacePageRuntime', { periodConfig: periodConfigSchema, savePageDefaults: bool }, ['mode', 'periodConfig']));
export const viewSchema = obj({ type: en('kpi', 'line_chart', 'bar_chart', 'table'), groupBy: en('day', 'week', 'session', 'component', 'athlete', 'cohort'), dataScopeLevel: en('day', 'session', 'component'), analyticalAggregation: en('sum', 'avg', 'max', 'last', 'none') });
export const displayV2Schema = obj({ schemaVersion: { const: 2 }, numberFormat: obj({ maximumFractionDigits: { type: 'integer', minimum: 0, maximum: 6 } }, []), legend: obj({ visible: bool }, []), valueLabels: obj({ visible: bool }, []) }, ['schemaVersion']);
export const yAxisSchema = union(tagged('mode', 'auto'), tagged('mode', 'fixed', { min: num, max: num }));
export const chartInteractionsSchema = obj({ tooltip: obj({ mode: en('exact', 'formatted') }), legend: obj({ toggle: bool }), zoom: obj({ mode: en('disabled', 'local'), applyPeriodAction: bool }), pointSelection: obj({ mode: en('disabled', 'details') }), yAxis: yAxisSchema }, []);
export const referenceSchema = union(tagged('kind', 'constant', { value: num, unit }), tagged('kind', 'backendReference', { id: str(200), semanticsVersion: str(200) }));
const target = obj({ series: { const: 'main' }, phase: { const: 'current' }, cell: { const: 'value' }, athletes: union(tagged('mode', 'allReturned'), tagged('mode', 'selected', { athleteIds: ids })) });
const style = obj({ tone: en('neutral', 'positive', 'caution', 'negative'), marker: en('none', 'up', 'down', 'check', 'alert', 'star1', 'star2', 'star3'), label: str(120) });
const baseRule = { id: str(64), priority: integer, enabled: bool, name: str(200), target, operand: en('value', 'referenceDifference', 'referencePercent'), operator: en('gt', 'gte', 'lt', 'lte', 'between', 'outside'), threshold: obj({ value: num, unit }), range: obj({ lower: num, upper: num, lowerInclusive: bool, upperInclusive: bool, unit }), reference: referenceSchema, formulaVersion: { const: 'signed-relative-abs-v1' }, style };
export const ruleSchema = obj(baseRule, ['id', 'priority', 'enabled', 'name', 'target', 'operand', 'operator', 'style']);
export const presentationV1Schema = obj({ schemaVersion: { const: 1 }, chartComposition: { const: 'athletes-v1' }, chartInteractions: chartInteractionsSchema, tableFormatting: obj({ evaluationVersion: { const: 1 }, rules: { type: 'array', items: ruleSchema, maxItems: 20 } }) }, ['schemaVersion']);
export const displayModeSchema = union(tagged('mode', 'preserve'), tagged('mode', 'replace', { value: displayV2Schema }));
export const presentationModeSchema = union(tagged('mode', 'preserve'), tagged('mode', 'clear'), tagged('mode', 'replace', { value: presentationV1Schema }));
export const editorDraftSchema = obj({ contractVersion: { const: 1 }, draftId: uuid, draftVersion: integer, title: str(200), metricRef: metricRefSchema, athleteSelection: athleteSelectionSchema, advancedFilter: obj({ activity: filterSelectionSchema, component: filterSelectionSchema }, []), periodIntent: periodIntentSchema, view: viewSchema, display: displayModeSchema, presentation: presentationModeSchema }, ['contractVersion', 'draftId', 'draftVersion', 'title', 'metricRef', 'athleteSelection', 'periodIntent', 'view']);
export const runtimeFilterSchema = obj({ athleteIds: union({ type: 'null' }, { type: 'array', items: uuid, maxItems: 500, uniqueItems: true }), activityId: union({ type: 'null' }, uuid), componentId: union({ type: 'null' }, uuid) }, []);
const concretePeriod = obj({ dateFrom: date, dateTo: date, timeZone: { type: 'string', format: 'time-zone' } });
export const contextSchema = union(tagged('kind', 'legacyDashboard', { runtimeFilter: runtimeFilterSchema, period: concretePeriod }, ['kind', 'period']), tagged('kind', 'page', { pageId: uuid, expectedPageDefaultsRevision: integer, runtimeFilter: runtimeFilterSchema, period: concretePeriod }, ['kind', 'pageId']));
export const envelopeSchema = obj({ contractVersion: { const: 1 }, context: contextSchema, draftRef: obj({ draftId: uuid, draftVersion: integer }), draft: editorDraftSchema, editTarget: union({ type: 'null' }, obj({ widgetId: uuid, expectedWidgetRevision: integer })), expectedCatalogToken: str(200) }, ['contractVersion', 'context', 'draftRef', 'draft', 'editTarget']);
export const schemas = Object.freeze({ context: contextSchema, envelope: envelopeSchema, runtimeFilter: runtimeFilterSchema, metricRef: metricRefSchema, athleteSelection: athleteSelectionSchema, filterSelection: filterSelectionSchema, periodConfig: periodConfigSchema, periodIntent: periodIntentSchema, view: viewSchema, displayV2: displayV2Schema, displayMode: displayModeSchema, presentationMode: presentationModeSchema, presentationV1: presentationV1Schema, chartInteractions: chartInteractionsSchema, yAxis: yAxisSchema, reference: referenceSchema, rule: ruleSchema, editorDraft: editorDraftSchema });
function freezeTree(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freezeTree); Object.freeze(v); } }
Object.values(schemas).forEach(freezeTree);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isDate(v) { if (typeof v !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(v)) return false; const n = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v; }
function format(v, f) { if (f === 'uuid') return isUuid(v); if (f === 'date') return isDate(v); try { new Intl.DateTimeFormat('en', { timeZone: v }).format(); return true; } catch { return false; } }
// JSON-only, bounded input: do not coerce types, evaluate user code or recurse forever.
function jsonSafe(v, seen = new Set(), depth = 0) {
  if (depth > 25) return false;
  if (v === null || ['string', 'boolean'].includes(typeof v)) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (!Array.isArray(v) && !plain(v)) return false;
  if (seen.has(v) || Object.getOwnPropertySymbols(v).length) return false;
  seen.add(v);
  if (Array.isArray(v) && (v.length > 10000 || Array.from({ length: v.length }, (_, i) => !Object.hasOwn(v, i)).some(Boolean))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  const ok = Object.entries(descriptors).every(([k, d]) => Array.isArray(v) && k === 'length' || ('value' in d && d.enumerable && jsonSafe(d.value, seen, depth + 1)));
  seen.delete(v); return ok;
}
function check(s, v, path, errors) {
  const fail = code => errors.push({ code, path });
  if (s.oneOf) {
    const candidates = s.oneOf.map(x => { const e = []; check(x, v, path, e); return e; });
    if (candidates.filter(x => !x.length).length === 1) return;
    const best = candidates.sort((a, b) => a.length - b.length)[0];
    errors.push(...(best.length ? best : [{ code: 'invalidUnion', path }])); return;
  }
  if ('const' in s && v !== s.const) fail('invalidLiteral');
  if (s.enum && !s.enum.includes(v)) fail('invalidEnum');
  if (!s.type) return;
  const matches = s.type === 'object' ? plain(v) : s.type === 'array' ? Array.isArray(v) : s.type === 'null' ? v === null : s.type === 'integer' ? Number.isSafeInteger(v) : typeof v === s.type;
  if (!matches) { fail('invalidType'); return; }
  if (s.type === 'object') {
    for (const k of s.required) if (!Object.hasOwn(v, k)) errors.push({ code: 'required', path: `${path}.${k}` });
    for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties, k)) errors.push({ code: 'unknownKey', path: `${path}.${k}` }); else check(s.properties[k], v[k], `${path}.${k}`, errors);
  }
  if (s.type === 'array') {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) fail('arrayBounds');
    if (s.uniqueItems && new Set(v.map(x => typeof x === 'string' ? x.toLowerCase() : x)).size !== v.length) fail('duplicate');
    v.forEach((x, i) => check(s.items, x, `${path}[${i}]`, errors));
  }
  if (s.type === 'string' && (v.trim().length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity))) fail('stringBounds');
  if (s.format && !format(v, s.format)) fail('invalidFormat');
  if (['number', 'integer'].includes(s.type) && (!Number.isFinite(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) fail('numberBounds');
}
export function validateContract(name, value) {
  if (!Object.hasOwn(schemas, name)) throw new TypeError('Unknown contract schema');
  if (!jsonSafe(value)) return { valid: false, issues: [{ code: 'invalidJson', path: '$' }] };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) return { valid: false, issues: [{ code: 'payloadTooLarge', path: '$' }] };
  const issues = []; check(schemas[name], value, '$', issues);
  const add = (code, path) => issues.push({ code, path });
  if (!issues.length) {
    if (name === 'envelope') {
      if (value.draftRef.draftId !== value.draft.draftId || value.draftRef.draftVersion !== value.draft.draftVersion) add('draftRefMismatch', '$.draftRef');
      const nested = validateEditorDraft(value.draft, { operation: value.editTarget ? 'update' : 'create' });
      issues.push(...nested.issues.map(i => ({ ...i, path: '$.draft' + i.path.slice(1) })));
      if (value.draft.periodIntent.savePageDefaults && (value.context.kind !== 'page' || !value.context.expectedPageDefaultsRevision)) add('pageDefaultsRevisionRequired', '$.context');
    }
    const concrete = name === 'context' ? value.period : name === 'envelope' ? value.context.period : null;
    if (concrete && (concrete.dateTo < concrete.dateFrom || (Date.parse(concrete.dateTo) - Date.parse(concrete.dateFrom)) / 86400000 >= 400)) add('periodBounds', '$.context.period');
    const periods = name === 'periodConfig' ? [value] : name === 'periodIntent' ? [value.periodConfig] : name === 'editorDraft' ? [value.periodIntent.periodConfig] : [];
    for (const p of periods.filter(Boolean)) if (p.mode === 'fixed' && (p.dateTo < p.dateFrom || (Date.parse(p.dateTo) - Date.parse(p.dateFrom)) / 86400000 >= 400)) add('periodBounds', '$.periodConfig');
    const pres = name === 'editorDraft' ? value.presentation?.value : name === 'presentationMode' ? value.value : name === 'presentationV1' ? value : null;
    const axis = name === 'yAxis' ? value : name === 'chartInteractions' ? value.yAxis : pres?.chartInteractions?.yAxis;
    if (axis?.mode === 'fixed' && axis.min >= axis.max) add('axisBounds', '$.yAxis');
    if ((pres?.chartInteractions || pres?.chartComposition) && pres.tableFormatting) add('incompatiblePresentation', '$');
    const rules = name === 'rule' ? [value] : pres?.tableFormatting?.rules ?? [];
    const priorities = new Set(), ruleIds = new Set();
    rules.forEach((r, i) => {
      const path = name === 'rule' ? '$' : `$.tableFormatting.rules[${i}]`;
      if (priorities.has(r.priority) || ruleIds.has(r.id)) add('duplicateRule', path);
      priorities.add(r.priority); ruleIds.add(r.id);
      const ranged = ['between', 'outside'].includes(r.operator);
      if (ranged ? !r.range || r.threshold : !r.threshold || r.range) add('invalidThresholdUnion', path);
      if (r.range && (r.range.lower > r.range.upper || r.range.lower === r.range.upper && !(r.range.lowerInclusive && r.range.upperInclusive))) add('emptyRange', path + '.range');
      if (r.operand === 'value' ? r.reference || r.formulaVersion : !r.reference) add('invalidReferenceUnion', path);
      if ((r.operand === 'referencePercent') !== Object.hasOwn(r, 'formulaVersion')) add('invalidFormulaUnion', path + '.formulaVersion');
    });
  }
  return { valid: issues.length === 0, issues };
}
export function validateEditorDraft(draft, { operation = 'create', complete = true } = {}) {
  // Incomplete step-three choices are legitimate editing state, not executable configs.
  const result = validateContract('editorDraft', draft);
  if (result.issues.some(i => ['invalidJson', 'payloadTooLarge'].includes(i.code))) return result;
  if (!complete) result.issues = result.issues.filter(i => !(i.code === 'required' && /^\$\.view\.(type|groupBy|dataScopeLevel|analyticalAggregation)$/.test(i.path)));
  for (const key of ['display', 'presentation']) {
    if (operation === 'create' && ['preserve', 'clear'].includes(draft?.[key]?.mode)) result.issues.push({ code: 'noPreserveSource', path: `$.${key}.mode` });
    if (operation === 'update' && !Object.hasOwn(draft ?? {}, key)) result.issues.push({ code: 'explicitUpdateModeRequired', path: `$.${key}` });
  }
  if (!['create', 'update'].includes(operation)) result.issues.push({ code: 'invalidOperation', path: '$' });
  result.valid = !result.issues.length; return result;
}
