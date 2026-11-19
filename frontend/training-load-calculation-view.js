import { escapeHtml } from './utils.js';
export const calculationErrors = {
  ratioOnAmount: 'Ratio is only for a calculated ratio. Choose another way to combine values.',
  aggregation_not_allowed: 'This metric cannot be totalled or averaged. Choose Ratio, Highest or Latest.',
  calculation_changed_in_period: 'The calculation changed during this period. Choose a shorter period.',
  calculationInputUnavailable: 'An input you cannot see is needed. Choose another metric.',
};
export function renderCalculationFormula(metric) {
  const calculation = metric?.calculation;
  if (!calculation) return '';
  const safe = value => typeof value === 'string' && !/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(value) ? value : '';
  const names = (calculation.inputs ?? []).map(input => (safe(input.name) || safe(input.shortName)) ? (safe(input.name) || safe(input.shortName)) + (safe(input.unit) ? ' (' + safe(input.unit) + ')' : '') : 'an input you cannot see');
  const separator = calculation.kind === 'sum' ? ' + ' : calculation.kind === 'difference' ? ' − ' : ' ÷ ';
  const formula = names.join(separator) + (calculation.kind === 'ratio' && calculation.scale === 100 ? ' × 100' : '');
  return `<span class="tl-calculated-badge">Calculated</span>${formula ? `<details><summary>How it is calculated</summary><p>${escapeHtml(formula)}</p></details>` : ''}`;
}
export function renderRatioCoverage(series, scope) {
  if (series.calculation?.kind !== 'ratio' || !series.coverage) return '';
  const noun = scope === 'component' ? 'drills' : 'sessions';
  const count = series.coverage.leftOutOccasions;
  return `${series.coverage.includedOccasions === 0 ? `<p class="muted">No ${noun} with a value.</p>` : ''}${Number.isSafeInteger(count) && count > 0 ? `<p class="muted">${count} ${count === 1 ? noun.slice(0, -1) : noun} without a value</p>` : ''}`;
}
