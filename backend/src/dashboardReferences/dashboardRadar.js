import { calculateReferenceValue } from './calculations.js';
import { validateRadarConfiguration, validateReferenceDefinition } from './contract.js';
import { dashboardRowMetricVersion } from './manualThreshold.js';

function dailyAxis(axis, athleteId, widget, result, references, date) {
  const unavailable = reason => ({ metricDefinitionId: axis.metricDefinitionId, status: 'unavailable', reason });
  const definitions = references.filter(reference =>
    reference.id === axis.referenceId && reference.revision === axis.referenceRevision &&
    reference.binding.metricDefinitionId === axis.metricDefinitionId);
  if (definitions.length !== 1) return unavailable(definitions.length ? 'ambiguousReference' : 'missingReference');
  const [reference] = definitions;
  if (date < reference.effective.dateFrom || (reference.effective.dateTo && date > reference.effective.dateTo)) {
    return unavailable('outOfValidity');
  }
  if (reference.population.kind === 'position') return unavailable('missingDimension');
  const definitionsForAxis = widget.series.filter(series => series.metric_definition_id === axis.metricDefinitionId);
  if (definitionsForAxis.length !== 1) return unavailable('incompatibleBinding');
  const [series] = definitionsForAxis;
  const binding = reference.binding;
  if (series.data_scope_level !== binding.dataScopeLevel ||
      series.analytical_aggregation !== binding.analyticalAggregation ||
      series.source_policy !== binding.sourcePolicy ||
      (series.source_connection_id ?? null) !== binding.sourceConnectionId ||
      series.aggregation_role_policy !== binding.aggregationRolePolicy ||
      series.coverage_policy !== binding.coveragePolicy || series.comparison_period) return unavailable('incompatibleBinding');

  const seriesResult = result.series.find(item => item.seriesId === series.id && item.status === 'ok');
  const rows = seriesResult?.data?.current?.filter(row => row.athleteId === athleteId && row.bucketKey === date) ?? [];
  if (rows.length !== 1) return unavailable(rows.length ? 'ambiguousResult' : 'missingResult');
  const [row] = rows;
  if (row[dashboardRowMetricVersion] !== binding.metricVersionId || row.unit !== binding.unit) return unavailable('incompatibleBinding');
  if (row.error || row.conflict || row.semanticConflict || row.typeConflict || row.unitConflict ||
      row.missing || row.missingKind || row.missing_kind || !Number.isFinite(row.value)) return unavailable('problemData');
  if (reference.source.kind === 'referenceTable') return unavailable('missingDimension');
  if (reference.source.kind === 'rollingMatches') return unavailable('missingMeasurementEvent');
  const attainment = calculateReferenceValue({
    operand: 'referenceAttainment', formulaVersion: 'attainment-positive-v1',
    value: row.value, unit: row.unit, referenceValue: reference.source.value, referenceUnit: binding.unit
  });
  return { metricDefinitionId: axis.metricDefinitionId, ...attainment, measurementValue: row.value,
    referenceValue: reference.source.value, measurementUnit: row.unit };
}

/** Evaluate one authorized daily Dashboard result with already scoped manual definitions. */
export function buildDashboardRadar({ widget, result, period, queryId, config, definitions, teamId }) {
  if (!validateRadarConfiguration(config).valid) return null;
  const date = period?.dateFrom;
  const supported = widget.group_by === 'day' && typeof date === 'string' && date === period?.dateTo && result.widgetId === widget.id;
  const references = definitions.filter(reference => validateReferenceDefinition(reference).valid &&
    reference.owner.kind === 'team' && reference.owner.id === teamId &&
    reference.population.kind === 'team' && reference.population.teamId === teamId);
  const athletes = config.athleteIds.map(athleteId => {
    const axes = config.axes.map(axis => supported ? dailyAxis(axis, athleteId, widget, result, references, date) :
      { metricDefinitionId: axis.metricDefinitionId, status: 'unavailable', reason: 'singleDayRequired' });
    return { athleteId, axes, polygon: axes.every(axis => axis.status === 'ready') ? axes.map(axis => axis.value) : null };
  });
  const polygons = athletes.flatMap(athlete => athlete.polygon ? [athlete.polygon] : []);
  return { status: polygons.length ? 'ready' : 'unavailable', queryId, bucketKey: date, athletes,
    radialMaximum: Math.max(100, ...polygons.flat()) };
}
