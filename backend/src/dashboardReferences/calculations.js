const RELATIVE_FORMULA = 'signed-relative-abs-v1';
const ATTAINMENT_FORMULA = 'attainment-positive-v1';
const unavailable = (reason) => ({ status: 'unavailable', reason });
const validUnit = (unit) => typeof unit === 'string' && unit===unit.trim() && unit.length>0 && unit.length<=100;

/** Pure reference arithmetic. Inputs are never coerced, clamped, or mutated. */
export function calculateReferenceValue(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key,d])=>!['value','unit','referenceValue','referenceUnit','operand','formulaVersion'].includes(key) || !('value' in d) || !d.enumerable)) return unavailable('invalidValue');
  const { value, unit, referenceValue, referenceUnit, operand, formulaVersion } = input;
  if (!Number.isFinite(value)) return unavailable('invalidValue');
  if (!validUnit(unit)) return unavailable('unitMismatch');

  const expectedFormula = operand === 'referencePercent' ? RELATIVE_FORMULA
    : operand === 'referenceAttainment' ? ATTAINMENT_FORMULA : undefined;
  if (!['value', 'referenceDifference', 'referencePercent', 'referenceAttainment'].includes(operand)) {
    return unavailable('unsupportedFormula');
  }
  if (expectedFormula === undefined ? 'formulaVersion' in input : formulaVersion !== expectedFormula) {
    return unavailable('unsupportedFormula');
  }

  if (operand === 'value') {
    if ('referenceValue' in input || 'referenceUnit' in input) return unavailable('invalidReference');
    return { status: 'ready', value, unit };
  }
  if (!Number.isFinite(referenceValue)) return unavailable('invalidReference');
  if (!validUnit(referenceUnit) || unit !== referenceUnit) return unavailable('unitMismatch');

  let result;
  if (operand === 'referenceDifference') {
    result = value - referenceValue;
  } else if (operand === 'referencePercent') {
    if (referenceValue === 0) return unavailable('zeroReference');
    result = (value - referenceValue) / Math.abs(referenceValue) * 100;
  } else {
    if (referenceValue <= 0) return unavailable('nonPositiveReference');
    if (value < 0) return unavailable('negativeAttainment');
    result = value / referenceValue * 100;
  }
  if (!Number.isFinite(result)) return unavailable('nonFiniteResult');
  return expectedFormula === undefined
    ? { status: 'ready', value: result, unit }
    : { status: 'ready', value: result, unit: '%', formulaVersion: expectedFormula };
}
