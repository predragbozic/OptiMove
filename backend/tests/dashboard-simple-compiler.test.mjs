import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSimpleDraft, resolvePeriod } from '../src/dashboardSimple/compiler.js';
import { draft, snapshot, context, metric, id, rule, presentation, builtins } from './fixtures/dashboard-simple/contracts.mjs';
const compile = (d = draft(), s = snapshot(), c = context(), e = null) => compileSimpleDraft(d, s, c, e);
function metricCase() { const d = draft(), s = snapshot();d.metricRef = { kind: 'metric', metricDefinitionId: id(5) };s.metricRef = d.metricRef;s.metric = metric();return { d, s }; }
const has = (r, code) => assert.ok(r.issues.some(i => i.code === code), JSON.stringify(r));
test('deterministic single widget, one DB series, no mutation', () => {
  const d = draft(), s = snapshot(), c = context();const before = structuredClone({ d, s, c });const a = compile(d, s, c);assert.equal(a.status, 'valid');assert.deepEqual(a, compile(d, s, c));assert.deepEqual({ d, s, c }, before);
  assert.equal(a.widget.series.length, 1);assert.equal(a.widget.series[0].source_policy, 'not_applicable');assert.equal(a.chartPlan.seriesBy, 'athleteId');assert.equal(a.widget.presentation_config.chartComposition, 'athletes-v1');
});
test('does not invent metric analytical aggregation from daily aggregation', () => {
  const { d, s } = metricCase();delete d.view.analyticalAggregation;assert.equal(compile(d, s).status, 'requiresChoice');d.view.analyticalAggregation = 'avg';assert.equal(compile(d, s).status, 'valid');
  delete d.view.dataScopeLevel;s.metric.scope_capabilities = [];assert.equal(compile(d, s).status, 'requiresChoice');s.metric.scope_capabilities = ['session'];assert.equal(compile(d, s).status, 'valid');
});
for (const b of builtins()) test(`built-in ${b.key} uses DB-loaded unit, fixed scope, default aggregation`, () => {
  const d = draft(), s = snapshot();d.metricRef.key = b.key;s.metricRef = d.metricRef;s.metric = b;d.view = { type: 'table', groupBy: 'athlete' };const r = compile(d, s);assert.equal(r.status, 'valid');assert.equal(r.semanticBinding.unit, b.unit);assert.equal(r.widget.series[0].data_scope_level, b.fixed_data_scope_level);assert.equal(r.widget.series[0].analytical_aggregation, b.default_analytical_aggregation);
  d.view.dataScopeLevel = b.fixed_data_scope_level === 'day' ? 'session' : 'day';has(compile(d, s), 'scopeCapability');
});
for (const owner_scope of ['club', 'team', 'user']) test(`foreign ${owner_scope} binding not authorized by broad catalog`, () => {
  const { d, s } = metricCase();s.metric.owner_scope = owner_scope;s.metric[`owner_${owner_scope === 'user' ? 'user' : owner_scope}_id`] = id(999);has(compile(d, s), 'notFound');
});
test('inactive metric/type and type/aggregation/scope incompatibilities', () => {
  const { d, s } = metricCase();s.metric.state = 'archived';has(compile(d, s), 'notFound');s.metric.state = 'active';s.metric.value_type = 'text';has(compile(d, s), 'aggregationType');has(compile(d, s), 'numericChartRequired');
  d.view = { type: 'table', groupBy: 'day', dataScopeLevel: 'component', analyticalAggregation: 'last' };has(compile(d, s), 'scopeCapability');s.metric.scope_capabilities = [];assert.equal(compile(d, s).status, 'valid');s.widgetTypes = [];has(compile(d, s), 'inactiveWidgetType');
});
test('20 athletes is not 20 rows; 25 never silently first20', () => {
  const c = context();c.authorizedAthleteIds = Array.from({ length: 20 }, (_, i) => id(i));assert.equal(compile(draft(), snapshot(), c).status, 'valid');c.authorizedAthleteIds.push(...Array.from({ length: 5 }, (_, i) => id(i + 20)));const r = compile(draft(), snapshot(), c);assert.equal(r.status, 'requiresChoice');assert.equal(r.widget, undefined);const d = draft();d.view.type = 'table';assert.equal(compile(d, snapshot(), c).effectiveFilter.athleteIds.length, 25);
});
test('athlete categories, temporal zoom and non-numeric charts', () => {
  const d = draft();d.view.groupBy = 'athlete';const r = compile(d);assert.equal(r.chartPlan.categoryBy, 'athleteId');assert.equal(r.chartPlan.seriesBy, null);assert.equal(r.widget.presentation_config.chartInteractions.zoom.mode, 'disabled');d.presentation = { mode: 'replace', value: { schemaVersion: 1, chartInteractions: { zoom: { mode: 'local', applyPeriodAction: true } } } };has(compile(d), 'temporalZoomRequired');
});
test('filters respect inheritance/clear/allAuthorized and foreign athlete denial', () => {
  const d = draft(), c = context();c.defaultFilter = { athleteIds: [id(7)] };assert.deepEqual(compile(d, snapshot(), c).effectiveFilter.athleteIds, [id(7)]);
  d.athleteSelection = { mode: 'allAuthorized' };assert.equal(compile(d, snapshot(), c).effectiveFilter.athleteIds.length, 2);d.athleteSelection = { mode: 'selected', athleteIds: [id(999)] };has(compile(d), 'notFound');
  d.athleteSelection = { mode: 'inherit' };c.athleteWorkspaceAthleteId = id(7);assert.deepEqual(compile(d, snapshot(), c).effectiveFilter.athleteIds, [id(7)]);
});
test('component parent and foreign activity are checked, not auto-reparented', () => {
  const d = draft(), c = context();d.advancedFilter = { activity: { mode: 'selected', id: id(11) }, component: { mode: 'selected', id: id(12) } };has(compile(d), 'notFound');c.authorizedFilterIds = { activityId: [id(11)], componentId: [id(12)] };c.componentActivityId = id(13);has(compile(d, snapshot(), c), 'componentActivityMismatch');c.componentActivityId = id(11);assert.equal(compile(d, snapshot(), c).status, 'valid');
});
test('unit:null is explicit, never wildcard; reference capabilities stay disabled', () => {
  const d = draft(), s = snapshot();d.metricRef.key = 'rpe';s.metricRef = d.metricRef;s.metric = builtins()[0];d.view.type = 'table';d.view.analyticalAggregation = 'avg';const p = presentation();p.tableFormatting.rules[0].threshold.unit = null;d.presentation = { mode: 'replace', value: p };assert.equal(compile(d, s).status, 'valid');p.tableFormatting.rules[0].threshold.unit = 'AU';has(compile(d, s), 'unitMismatch');p.tableFormatting.rules[0] = { ...rule(), operand: 'referenceDifference', threshold: { value: 2, unit: null }, reference: { kind: 'backendReference', id: 'opaque', semanticsVersion: '1' } };has(compile(d, s), 'unsupportedCapability');
});
test('constant reference units and selected rule targets validated without evaluating data', () => {
  const d = draft();d.view.type = 'table';const p = presentation();p.tableFormatting.rules[0] = { ...rule(), operand: 'referenceDifference', reference: { kind: 'constant', value: 1000, unit: 'm' } };d.presentation = { mode: 'replace', value: p };has(compile(d), 'referenceUnitMismatch');p.tableFormatting.rules[0].reference.unit = 'AU';const r = compile(d);assert.equal(r.status, 'valid');assert.equal(r.semanticBinding.requiresResultSemanticProof, true);assert.equal(r.presentationAnnotations, undefined);
});
test('legacy preserve retains exact V1/unknown fields and rejects semantic rewriting of rules', () => {
  const first = compile();const e = first.widget;e.display_config = { schemaVersion: 1, custom: { x: 1 } };e.presentation_config = { schemaVersion: 99, opaque: 'keep' };const d = draft();d.display = { mode: 'preserve' };d.presentation = { mode: 'preserve' };const r = compile(d, snapshot(), context(), e);assert.equal(r.status, 'valid');assert.deepEqual(r.widget.display_config, e.display_config);assert.deepEqual(r.widget.presentation_config, e.presentation_config);
  d.view.groupBy = 'week';assert.equal(compile(d, snapshot(), context(), e).status, 'advancedRequired');e.series.push(structuredClone(e.series[0]));assert.equal(compile(d, snapshot(), context(), e).status, 'advancedRequired');
});
test('source policy and pinned connection are never silently swapped', () => {
  const { d, s } = metricCase();const e = compile(d, s).widget;e.series[0].source_policy = 'source_connection';e.series[0].source_connection_id = id(22);d.display = { mode: 'preserve' };d.presentation = { mode: 'preserve' };has(compile(d, s, context(), e), 'notFound');s.connection = { id: id(22), owner_scope: 'club', owner_club_id: id(4), state: 'active' };assert.equal(compile(d, s, context(), e).status, 'valid');s.connection.owner_club_id = id(999);has(compile(d, s, context(), e), 'notFound');
});
test('server date resolver distinguishes Monday week, rolling7, DST and fixed activity dates', () => {
  const relative = { schemaVersion: 1, mode: 'relative', preset: 'this_week', timeZone: 'Europe/Belgrade' };assert.deepEqual(resolvePeriod(relative, '2026-10-29T12:00:00Z'), { dateFrom: '2026-10-26', dateTo: '2026-11-01', timeZone: relative.timeZone });assert.equal(resolvePeriod({ ...relative, preset: 'last_7_days' }, '2026-10-29T12:00:00Z').dateFrom, '2026-10-23');assert.equal(resolvePeriod({ ...relative, preset: 'today' }, '2026-10-24T22:30:00Z').dateFrom, '2026-10-25');
  const d = draft();d.periodIntent = { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'fixed', dateFrom: '2026-10-22', dateTo: '2026-10-28', timeZone: 'Pacific/Auckland' } };assert.equal(compile(d).resolvedPeriod.dateFrom, '2026-10-22');
});
test('all relevant preserved binding enums, source combination and comparison gates reject', () => {
  const { d, s } = metricCase();const seed = compile(d, s).widget;d.display = { mode: 'preserve' };d.presentation = { mode: 'preserve' };
  for (const [field, value, code] of [['source_policy', 'invented', 'sourcePolicy'], ['source_policy', 'not_applicable', 'sourcePolicy'], ['aggregation_role_policy', 'invented', 'aggregationRolePolicy'], ['coverage_policy', 'invented', 'coveragePolicy'], ['axis', 'wrong', 'axis'], ['comparison_period', 'previous_period', 'comparisonPeriod']]) {
    const existing = structuredClone(seed);existing.series[0][field] = value;has(compile(d, s, context(), existing), code);
  }
  const existing = structuredClone(seed);existing.series[0].source_connection_id = id(55);has(compile(d, s, context(), existing), 'sourceConnectionRequired');
});
test('metadata unavailable, unknown display, unsupported presentation and Pages fail closed', () => {
  const { d, s } = metricCase();delete s.metric.scope_capabilities;has(compile(d, s), 'invalidCatalogMetadata');
  const e = compile().widget;e.display_config = { schemaVersion: 99 };const upd = { ...draft(), display: { mode: 'preserve' }, presentation: { mode: 'preserve' } };assert.equal(compile(upd, snapshot(), context(), e).status, 'advancedRequired');
  const x = draft();x.periodIntent = { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'UTC' }, savePageDefaults: true };has(compile(x), 'unsupportedCapability');
});
test('preserve maintains existing unrelated content and layout', () => {
  const e = { ...compile().widget, x: 3, y: 9, width: 6, height: 4, state: 'collapsed', revision: 8 };
  const d = { ...draft(), title: 'New title', display: { mode: 'preserve' }, presentation: { mode: 'preserve' } };const r = compile(d, snapshot(), context(), e);
  assert.equal(r.status, 'valid');for (const k of ['x', 'y', 'width', 'height', 'state', 'revision']) assert.equal(r.widget[k], e[k]);
});
test('unsupported grouping never silently opts into athletes-v1 composition', () => {
  const d = draft();d.view.groupBy = 'session';const r = compile(d);assert.equal(r.status, 'valid');assert.equal(r.chartPlan, null);assert.equal(r.widget.presentation_config.chartComposition, undefined);
  d.presentation = { mode: 'replace', value: { schemaVersion: 1, chartComposition: 'athletes-v1' } };has(compile(d), 'unsupportedComposition');
});

test('relative compilation with absent or invalid server time returns a controlled issue', () => {
  const d = draft();d.periodIntent = { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'UTC' } };
  for (const evaluatedAt of [undefined, null, 'not-a-date']) { const c = context();c.evaluatedAt = evaluatedAt;const r = compile(d, snapshot(), c);assert.equal(r.status, 'invalid');has(r, 'serverTimeRequired'); }
});
