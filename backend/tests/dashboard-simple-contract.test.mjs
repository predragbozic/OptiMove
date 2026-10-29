import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemas, validateContract, validateEditorDraft } from '../src/dashboardSimple/schema.js';
import { draft, id, rule, presentation } from './fixtures/dashboard-simple/contracts.mjs';
const valid = (name, v) => assert.equal(validateContract(name, v).valid, true, JSON.stringify(validateContract(name, v)));
const invalid = (name, v) => assert.equal(validateContract(name, v).valid, false, name);
const samples = {
  runtimeFilter: [{}, { athleteIds: null, activityId: null, componentId: null }],
  context: [{ kind: 'legacyDashboard', period: { dateFrom: '2026-01-01', dateTo: '2026-01-02', timeZone: 'UTC' } }, { kind: 'page', pageId: id(8) }],
  envelope: [{ contractVersion: 1, context: { kind: 'legacyDashboard', period: { dateFrom: '2026-01-01', dateTo: '2026-01-02', timeZone: 'UTC' } }, draftRef: { draftId: id(1), draftVersion: 1 }, draft: draft(), editTarget: null }],
  metricRef: [{ kind: 'metric', metricDefinitionId: id(5) }, { kind: 'builtin', key: 'rpe' }],
  athleteSelection: [{ mode: 'inherit' }, { mode: 'allAuthorized' }, { mode: 'selected', athleteIds: [id(7)] }],
  filterSelection: [{ mode: 'inherit' }, { mode: 'clear' }, { mode: 'selected', id: id(9) }],
  periodConfig: [{ schemaVersion: 1, mode: 'fixed', dateFrom: '2026-01-01', dateTo: '2026-01-02', timeZone: 'Europe/Belgrade' }, { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'UTC' }],
  periodIntent: [{ mode: 'inherit' }, { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'relative', preset: 'this_week', timeZone: 'UTC' } }],
  view: [draft().view], displayV2: [{ schemaVersion: 2 }, { schemaVersion: 2, numberFormat: { maximumFractionDigits: 6 }, legend: { visible: true }, valueLabels: { visible: false } }],
  displayMode: [{ mode: 'preserve' }, { mode: 'replace', value: { schemaVersion: 2 } }],
  presentationMode: [{ mode: 'preserve' }, { mode: 'clear' }, { mode: 'replace', value: presentation() }],
  presentationV1: [presentation(), { schemaVersion: 1, chartComposition: 'athletes-v1' }],
  chartInteractions: [{ tooltip: { mode: 'exact' }, legend: { toggle: true }, zoom: { mode: 'local', applyPeriodAction: true }, pointSelection: { mode: 'details' }, yAxis: { mode: 'fixed', min: -2, max: 10 } }],
  yAxis: [{ mode: 'auto' }, { mode: 'fixed', min: 0, max: 1 }],
  reference: [{ kind: 'constant', value: 0, unit: null }, { kind: 'backendReference', id: 'opaque', semanticsVersion: 'v1' }], rule: [rule()], editorDraft: [draft()],
};
for (const name of Object.keys(schemas)) for (const [i, value] of samples[name].entries()) {
  test(`${name} variant ${i}: accepts exact shape and rejects unknown keys`, () => { valid(name, value); invalid(name, { ...value, owner: 'forged' }); });
  test(`${name} variant ${i}: required keys and scalar substitution`, () => { invalid(name, null); invalid(name, false); invalid(name, []); invalid(name, 1); });
}
test('metric discriminators cannot be mixed', () => { invalid('metricRef', { kind: 'metric', metricDefinitionId: id(1), key: 'rpe' }); invalid('metricRef', { kind: 'builtin', key: 'rpe', metricDefinitionId: id(1) }); });
test('athlete selected empty/duplicates/501 rejected, 500 accepted', () => {
  for (const athleteIds of [[], [id(1), id(1)], [id(1), id(1).toUpperCase()], Array.from({ length: 501 }, (_, i) => id(i))]) invalid('athleteSelection', { mode: 'selected', athleteIds });
  valid('athleteSelection', { mode: 'selected', athleteIds: Array.from({ length: 500 }, (_, i) => id(i)) });
});
test('actual calendar dates, IANA zones and inclusive 400-day bounds', () => {
  const p = { schemaVersion: 1, mode: 'fixed', dateFrom: '2025-01-01', dateTo: '2026-02-04', timeZone: 'UTC' };valid('periodConfig', p);
  for (const bad of [{ dateTo: '2026-02-05' }, { dateTo: '2024-02-30' }, { dateTo: '0000-01-01' }, { timeZone: 'Mars/Olympus' }, { dateTo: '2024-12-31' }]) invalid('periodConfig', { ...p, ...bad });
});
test('finite bounds, strict booleans and V2-only replace', () => {
  invalid('yAxis', { mode: 'fixed', min: 1, max: 1 });invalid('yAxis', { mode: 'auto', min: 0 });invalid('yAxis', { mode: 'fixed', min: 0, max: Infinity });
  invalid('displayV2', { schemaVersion: 2, legend: { visible: 1 } });invalid('displayV2', { schemaVersion: 2, numberFormat: { maximumFractionDigits: 7 } });invalid('displayMode', { mode: 'replace', value: { schemaVersion: 1 } });
});
test('rule operator/operand unions and interval boundaries', () => {
  for (const operator of ['gt', 'gte', 'lt', 'lte']) valid('rule', { ...rule(), operator });
  for (const operator of ['between', 'outside']) { const r = rule();delete r.threshold;r.operator = operator;r.range = { lower: 0, upper: 1, lowerInclusive: false, upperInclusive: true, unit: 'AU' };valid('rule', r);r.range.upper = 0;invalid('rule', r);r.range.lowerInclusive = true;valid('rule', r); }
  invalid('rule', { ...rule(), operator: 'between' });invalid('rule', { ...rule(), reference: { kind: 'constant', value: 1, unit: 'AU' } });
  valid('rule', { ...rule(), operand: 'referenceDifference', reference: { kind: 'constant', value: 1, unit: 'AU' } });
  invalid('rule', { ...rule(), operand: 'referencePercent', reference: { kind: 'constant', value: 1, unit: 'AU' } });
  valid('rule', { ...rule(), operand: 'referencePercent', formulaVersion: 'signed-relative-abs-v1', reference: { kind: 'constant', value: 1, unit: 'AU' }, threshold: { value: 20, unit: '%' } });
});
test('rule count/identity/priority and combined presentation shape', () => {
  const p = presentation();p.tableFormatting.rules.push(rule());invalid('presentationV1', p);
  p.tableFormatting.rules = Array.from({ length: 21 }, (_, i) => ({ ...rule(), id: `r${i}`, priority: i + 1 }));invalid('presentationV1', p);
  invalid('presentationV1', { ...presentation(), chartInteractions: {} });
  invalid('presentationV1', { ...presentation(), schemaVersion: 2 });
});
test('create/update preserve/clear modes are explicit and lossless', () => {
  assert.equal(validateEditorDraft({ ...draft(), display: { mode: 'preserve' } }).valid, false);
  assert.equal(validateEditorDraft({ ...draft(), presentation: { mode: 'clear' } }).valid, false);
  assert.equal(validateEditorDraft(draft(), { operation: 'update' }).valid, false);
  assert.equal(validateEditorDraft({ ...draft(), display: { mode: 'preserve' }, presentation: { mode: 'preserve' } }, { operation: 'update' }).valid, true);
});
test('safe JSON rejects getters, cycles, prototype objects, functions and nonfinite', () => {
  let calls = 0; const d = draft();Object.defineProperty(d, 'evil', { enumerable: true, get() { calls++;throw Error('not executed'); } });assert.equal(validateEditorDraft(d).valid, false);assert.equal(calls, 0);
  const cyc = draft();cyc.cycle = cyc;assert.equal(validateEditorDraft(cyc).valid, false);
  for (const extra of [new Date(), () => 1, NaN, undefined]) assert.equal(validateEditorDraft({ ...draft(), extra }).valid, false);
});

test('envelope context/draft reference and shared defaults revision', () => { const e = structuredClone(samples.envelope[0]);e.draftRef.draftVersion = 2;invalid('envelope', e);e.draftRef.draftVersion = 1;e.draft.periodIntent = { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'UTC' }, savePageDefaults: true };invalid('envelope', e);e.context = { kind: 'page', pageId: id(8), expectedPageDefaultsRevision: 1 };valid('envelope', e); });
test('all required properties and nested unknown fields are rejected', () => {
  for (const [name, values] of Object.entries(samples)) for (const value of values) {
    // Removing each key either selects another legitimate variant, or must fail
    // when the schema declares that key required. The explicit common contracts
    // below avoid pretending optional sections are mandatory.
    for (const key of ['mode', 'kind', 'schemaVersion', 'contractVersion']) if (Object.hasOwn(value, key)) { const copy = structuredClone(value);delete copy[key];invalid(name, copy); }
  }
  const d = draft();d.view.sourcePolicy = 'manual';invalid('editorDraft', d);
  d.view = draft().view;d.advancedFilter.activity.dateFrom = '2026-01-01';invalid('editorDraft', d);
});
test('JSON sparse arrays, deep values, oversized payload and lazy getters fail closed', () => {
  invalid('athleteSelection', { mode: 'selected', athleteIds: Array(1) });
  const d = draft();Object.defineProperty(d, 'display', { enumerable: true, get() { throw new Error('must not execute'); } });assert.equal(validateEditorDraft(d).valid, false);
  invalid('editorDraft', { ...draft(), huge: 'x'.repeat(65537) });
});
