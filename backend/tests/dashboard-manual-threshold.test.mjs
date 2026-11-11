import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateManualThresholds, evaluateManualThreshold, dashboardRowMetricVersion, verifiedChartReference } from '../src/dashboardReferences/manualThreshold.js';
import { id, rule } from './fixtures/dashboard-simple/contracts.mjs';

test('manual threshold preserves text and requires a numeric value with matching units', () => {
  const config = rule();
  assert.deepEqual(evaluateManualThreshold(config, { value: 2100, unit: 'AU' }), {
    status: 'match', ruleId: config.id, value: 2100, unit: 'AU', style: config.style
  });
  assert.equal(evaluateManualThreshold(config, { value: 2000, unit: 'AU' }).status, 'noMatch');
  assert.equal(evaluateManualThreshold(config, { value: '2100', unit: 'AU' }).reason, 'invalidValue');
  assert.equal(evaluateManualThreshold(config, { value: 2100, unit: 'm' }).reason, 'unitMismatch');
});

test('manual range honors boundaries and the selected athlete scope', () => {
  const { threshold, ...config } = rule();
  config.target.athletes = { mode: 'selected', athleteIds: [id(7)] };
  config.operator = 'outside';
  config.range = { lower: 1000, upper: 2000, lowerInclusive: true, upperInclusive: false, unit: 'AU' };
  assert.equal(evaluateManualThreshold(config, { value: 1000, unit: 'AU', athleteId: id(7) }).status, 'noMatch');
  assert.equal(evaluateManualThreshold(config, { value: 2000, unit: 'AU', athleteId: id(7) }).status, 'match');
  assert.equal(evaluateManualThreshold(config, { value: 2000, unit: 'AU', athleteId: id(8) }).status, 'notApplicable');
});

test('relative change uses the constant and rejects zero references', () => {
  const config = {
    ...rule(), operand: 'referencePercent', formulaVersion: 'signed-relative-abs-v1',
    reference: { kind: 'constant', value: 1000, unit: 'AU' },
    threshold: { value: 10, unit: '%' }
  };
  const observation = { value: 1250, unit: 'AU' };
  assert.equal(evaluateManualThreshold(config, observation).value, 25);
  config.reference.value = 0;
  assert.equal(evaluateManualThreshold(config, observation).reason, 'zeroReference');
});

test('annotations use priority and skip rows with insufficient result evidence', () => {
  const higher = { ...rule(), id: 'higher', priority: 1 };
  const row = { value: 2100, unit: 'AU', athleteId: id(7) };
  const rows = [row, { ...row, unitConflict: true }, { ...row, unit: 'm' }, { ...row, missing: true }];
  const annotations = annotateManualThresholds([{ ...rule(), priority: 2 }, higher], rows, 'AU');
  assert.deepEqual(annotations.map(({ rowIndex, ruleId }) => ({ rowIndex, ruleId })), [
    { rowIndex: 0, ruleId: 'higher' }
  ]);
});

test('chart references require compatible evidence across every returned row', () => {
  const version = id(7);
  const reference = { lower: 0, upper: 12, unit: 'm', metricVersionId: version };
  const row = { value: 10, unit: 'm', [dashboardRowMetricVersion]: version };
  assert.equal(verifiedChartReference(reference, [row], null), reference);
  assert.equal(verifiedChartReference(reference, [row, { ...row, [dashboardRowMetricVersion]: id(8) }], null), null);
  assert.equal(verifiedChartReference(reference, [row, { ...row, conflict: true }], null), null);
});

test('a chart reference is withheld unless the query period is within its validity dates', () => {
  const reference = { lower: 1, unit: null, validFrom: '2026-10-22', validTo: '2026-10-29' };
  const rows = [{ value: 2, unit: null }];
  const builtin = { valueType: 'numeric', unit: null };
  assert.equal(verifiedChartReference(reference, rows, builtin, { dateFrom: '2026-10-22', dateTo: '2026-10-29' }), reference);
  assert.equal(verifiedChartReference(reference, rows, builtin, { dateFrom: '2026-10-21', dateTo: '2026-10-29' }), null);
  assert.equal(verifiedChartReference(reference, rows, builtin, { dateFrom: '2026-10-22', dateTo: '2026-10-30' }), null);
});
