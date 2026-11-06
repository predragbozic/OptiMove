import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReferenceValue as calculate } from '../src/dashboardReferences/calculations.js';

const relative = 'signed-relative-abs-v1';
const attainment = 'attainment-positive-v1';
const raw = { value: 10, unit: 'm', operand: 'value' };
const difference = { ...raw, operand: 'referenceDifference', referenceValue: 5, referenceUnit: 'm' };
const percent = { ...difference, operand: 'referencePercent', formulaVersion: relative };
const radar = { ...difference, operand: 'referenceAttainment', formulaVersion: attainment };
const unavailable = (input, reason) => assert.deepEqual(calculate(input), { status: 'unavailable', reason });
const ready = (input, value, unit, formulaVersion) => assert.deepEqual(calculate(input), {
  status: 'ready', value, unit, ...(formulaVersion === undefined ? {} : { formulaVersion }),
});

test('raw values preserve finite numbers and expose only required fields', () => {
  for (const value of [0, -0, -12, 1.5, Number.MAX_VALUE]) ready({ ...raw, value }, value, 'm');
});

test('difference accepts zero and signed references without clamping', () => {
  for (const [value, referenceValue, expected] of [[10, 0, 10], [10, -5, 15], [-10, -5, -5], [5, 5, 0], [0, 5, -5]]) {
    ready({ ...difference, value, referenceValue }, expected, 'm');
  }
});

test('signed relative percent uses the absolute reference denominator', () => {
  for (const [value, referenceValue, expected] of [[15, 10, 50], [5, 10, -50], [-5, -10, 50], [-15, -10, -50], [0, -10, 100], [-10, -10, 0]]) {
    ready({ ...percent, value, referenceValue }, expected, '%', relative);
  }
  for (const referenceValue of [0, -0]) unavailable({ ...percent, referenceValue }, 'zeroReference');
});

test('equality is zero percent change and 100 percent attainment', () => {
  ready({ ...percent, value: 5 }, 0, '%', relative);
  ready({ ...radar, value: 5 }, 100, '%', attainment);
  ready({ ...radar, value: 0 }, 0, '%', attainment);
  ready({ ...radar, value: 20 }, 400, '%', attainment);
});

test('attainment requires a positive reference and nonnegative quantity', () => {
  for (const referenceValue of [0, -0, -5]) unavailable({ ...radar, referenceValue }, 'nonPositiveReference');
  unavailable({ ...radar, value: -1 }, 'negativeAttainment');
});

test('numbers must be finite primitives; strings and other coercible values are invalid', () => {
  const invalid = [undefined, null, '10', '', 'NaN', true, false, NaN, Infinity, -Infinity, 1n, new Number(10), [], {}];
  for (const value of invalid) {
    for (const input of [raw, difference, percent, radar]) unavailable({ ...input, value }, 'invalidValue');
    for (const input of [difference, percent, radar]) unavailable({ ...input, referenceValue: value }, 'invalidReference');
  }
  unavailable({}, 'invalidValue');
  unavailable(null, 'invalidValue');
  unavailable(undefined, 'invalidValue');
});

test('units must be nonempty strings and reference units match exactly', () => {
  for (const unit of [undefined, null, '', ' ', '\t', 1, new String('m')]) {
    unavailable({ ...raw, unit }, 'unitMismatch');
    unavailable({ ...difference, referenceUnit: unit }, 'unitMismatch');
  }
  for (const referenceUnit of ['M', 'km', ' m', 'm ']) {
    for (const input of [difference, percent, radar]) unavailable({ ...input, referenceUnit }, 'unitMismatch');
  }
  unavailable({ ...difference, unit: ' m ', referenceUnit: ' m ' }, 'unitMismatch');
});

test('raw operand forbids either reference field even when explicitly undefined', () => {
  for (const field of ['referenceValue', 'referenceUnit']) {
    for (const value of [undefined, null, 0, 'm']) unavailable({ ...raw, [field]: value }, 'invalidReference');
  }
});

test('operand and formula unions reject missing, unknown, and cross-assigned versions', () => {
  for (const input of [raw, difference]) {
    for (const formulaVersion of [undefined, null, '', relative, attainment]) {
      unavailable({ ...input, formulaVersion }, 'unsupportedFormula');
    }
  }
  for (const input of [percent, radar]) {
    const { formulaVersion, ...withoutFormula } = input;
    unavailable(withoutFormula, 'unsupportedFormula');
    for (const version of [undefined, null, '', 'v2', input === percent ? attainment : relative]) {
      unavailable({ ...input, formulaVersion: version }, 'unsupportedFormula');
    }
  }
  for (const operand of [undefined, null, '', 'REFERENCEPERCENT', 'unknown', 0]) {
    unavailable({ ...raw, operand }, 'unsupportedFormula');
  }
});

test('reference operands require both reference fields', () => {
  for (const input of [difference, percent, radar]) {
    const { referenceValue, ...withoutValue } = input;
    const { referenceUnit, ...withoutUnit } = input;
    unavailable(withoutValue, 'invalidReference');
    unavailable(withoutUnit, 'unitMismatch');
  }
});

test('overflow is unavailable, including finite-input intermediate overflow', () => {
  unavailable({ ...difference, value: Number.MAX_VALUE, referenceValue: -Number.MAX_VALUE }, 'nonFiniteResult');
  unavailable({ ...percent, value: Number.MAX_VALUE, referenceValue: -Number.MAX_VALUE }, 'nonFiniteResult');
  for (const input of [percent, radar]) {
    unavailable({ ...input, value: Number.MAX_VALUE, referenceValue: 1 }, 'nonFiniteResult');
    unavailable({ ...input, referenceValue: Number.MIN_VALUE }, 'nonFiniteResult');
  }
});

test('successful and unavailable calculations do not mutate their inputs', () => {
  for (const input of [raw, difference, percent, radar, { ...radar, value: -1 }, { ...percent, referenceValue: 0 }]) {
    const frozen = Object.freeze({ ...input });
    const before = { ...frozen };
    const result = calculate(frozen);
    assert.deepEqual(frozen, before);
    assert.notEqual(result, frozen);
    assert.deepEqual(calculate(frozen), result);
  }
});
