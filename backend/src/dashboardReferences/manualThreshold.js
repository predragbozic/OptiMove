import { validateContract } from '../dashboardSimple/schema.js';
import { calculateReferenceValue } from './calculations.js';

export const dashboardRowMetricVersion = Symbol('dashboardRowMetricVersion');

function matchesThreshold(value, rule) {
  switch (rule.operator) {
    case 'gt': return value > rule.threshold.value;
    case 'gte': return value >= rule.threshold.value;
    case 'lt': return value < rule.threshold.value;
    case 'lte': return value <= rule.threshold.value;
    case 'between':
    case 'outside': {
      const { lower, upper, lowerInclusive, upperInclusive } = rule.range;
      const aboveLower = value > lower || (lowerInclusive && value === lower);
      const belowUpper = value < upper || (upperInclusive && value === upper);
      const withinRange = aboveLower && belowUpper;
      return rule.operator === 'between' ? withinRange : !withinRange;
    }
  }
}

/** Evaluate a table rule against a server-verified current value for the main series. */
export function evaluateManualThreshold(rule, observation) {
  if (!validateContract('rule', rule).valid) {
    return { status: 'unavailable', reason: 'invalidRule' };
  }
  return evaluateValidatedRule(rule, observation);
}

function evaluateValidatedRule(rule, { value, unit, athleteId }) {
  const athletes = rule.target.athletes;
  if (!rule.enabled || (athletes.mode === 'selected' &&
      !athletes.athleteIds.some(id => id.toLowerCase() === (typeof athleteId === 'string' ? athleteId.toLowerCase() : null)))) {
    return { status: 'notApplicable' };
  }
  if (!Number.isFinite(value)) return { status: 'unavailable', reason: 'invalidValue' };

  let result = { status: 'ready', value, unit };
  if (rule.operand !== 'value') {
    if (rule.reference.kind !== 'constant') {
      return { status: 'unavailable', reason: 'unsupportedReference' };
    }
    result = calculateReferenceValue({
      operand: rule.operand,
      value,
      unit,
      referenceValue: rule.reference.value,
      referenceUnit: rule.reference.unit,
      ...(rule.formulaVersion && { formulaVersion: rule.formulaVersion })
    });
  }
  if (result.status !== 'ready') return result;
  if ((rule.threshold ?? rule.range).unit !== result.unit) {
    return { status: 'unavailable', reason: 'unitMismatch' };
  }
  if (!matchesThreshold(result.value, rule)) return { status: 'noMatch' };
  return { status: 'match', ruleId: rule.id, value: result.value, unit: result.unit, style: { ...rule.style } };
}

/** Row indexes refer only to the returned current rows of the main series. */
export function annotateManualThresholds(rules, rows, unit) {
  const orderedRules = rules.filter(rule => validateContract('rule', rule).valid).sort((a, b) => a.priority - b.priority);
  return rows.flatMap((row, rowIndex) => {
    if (!row || !Object.hasOwn(row, 'unit') || row.unit !== unit || row.error ||
        row.conflict || row.typeConflict || row.semanticConflict || row.unitConflict ||
        row.missing || row.missingKind || row.missing_kind || !Number.isFinite(row.value)) return [];
    for (const rule of orderedRules) {
      const evaluation = evaluateValidatedRule(rule, row);
      if (evaluation.status === 'match') return [{ rowIndex, ...evaluation }];
    }
    return [];
  });
}

export async function canSaveManualThreshold(query, presentation) {
  const marker = presentation.tableFormatting.rules[0]?.operator === 'lt'
    ? 'training_load.dashboard_lower_threshold_v1()'
    : presentation.tableFormatting.metricVersionId
    ? 'training_load.dashboard_catalog_threshold_v1()'
    : 'training_load.dashboard_manual_threshold_v1()';
  const capability = await query('select to_regprocedure($1) is not null as ready', [marker]);
  if (capability.rows[0]?.ready !== true) return false;
  const validation = await query('select training_load.dashboard_presentation_valid($1::jsonb) as valid', [
    JSON.stringify(presentation)
  ]);
  return validation.rows[0]?.valid === true;
}

export function verifiedChartReference(reference, rows, builtin, period) {
  if (!reference || !Number.isFinite(reference.lower) || !rows.length ||
      (reference.upper !== undefined && (!Number.isFinite(reference.upper) || reference.upper <= reference.lower)) || (builtin
    ? builtin.valueType !== 'numeric' || builtin.unit !== reference.unit || reference.metricVersionId
    : !reference.metricVersionId)) return null;
  if ((reference.validFrom && (!period?.dateFrom || period.dateFrom < reference.validFrom)) ||
      (reference.validTo && (!period?.dateTo || period.dateTo > reference.validTo))) return null;
  return rows.every(row => row.unit === reference.unit && Number.isFinite(row.value) &&
    !row.error && !row.conflict && !row.typeConflict && !row.semanticConflict && !row.unitConflict &&
    !row.missing && !row.missingKind && !row.missing_kind &&
    (builtin || row[dashboardRowMetricVersion] === reference.metricVersionId)) ? reference : null;
}
