import { calculateReferenceValue } from './calculations.js';
import { validReferenceBinding, validateRadarConfiguration, validateReferenceDefinition, validateReferenceObservation } from './contract.js';

function sameBinding(left, right) {
  return validReferenceBinding(left) && Object.keys(right).every(key => left[key] === right[key]);
}

/** Compose one Radar snapshot from measurements and references authorized by the server. */
export function buildRadarSnapshot(config, { queryId, bucketKey, measurements, observations }) {
  const validation = validateRadarConfiguration(config);
  if (!validation.valid) return { status: 'invalid', issues: validation.issues };

  const references = observations.filter(observation =>
    validateReferenceObservation(observation).valid &&
    observation.queryId === queryId && observation.bucketKey === bucketKey);

  const athletes = config.athleteIds.map(athleteId => {
    const axes = config.axes.map(axis => {
      const match = references.filter(reference =>
        reference.athleteId === athleteId && reference.referenceId === axis.referenceId &&
        reference.referenceRevision === axis.referenceRevision &&
        reference.binding.metricDefinitionId === axis.metricDefinitionId);
      const readings = measurements.filter(reading =>
        reading.athleteId === athleteId && reading.queryId === queryId && reading.bucketKey === bucketKey &&
        reading.binding?.metricDefinitionId === axis.metricDefinitionId);
      const [reference] = match;
      const [reading] = readings;
      if (match.length !== 1 || readings.length !== 1) {
        return { metricDefinitionId: axis.metricDefinitionId, status: 'unavailable',
          reason: match.length > 1 || readings.length > 1 ? 'ambiguousResult' : 'missingResult' };
      }
      if (reference.status !== 'ready' || reading.status !== 'ready' || !sameBinding(reading.binding, reference.binding)) {
        return { metricDefinitionId: axis.metricDefinitionId, status: 'unavailable',
          reason: reference.reason ?? 'incompatibleResult' };
      }
      const attainment = calculateReferenceValue({
        value: reading.value, unit: reading.binding.unit,
        referenceValue: reference.value, referenceUnit: reference.binding.unit,
        operand: 'referenceAttainment', formulaVersion: config.formulaVersion
      });
      return { metricDefinitionId: axis.metricDefinitionId, ...attainment,
        measurementValue: reading.value, referenceValue: reference.value, measurementUnit: reading.binding.unit };
    });
    const complete = axes.every(axis => axis.status === 'ready');
    return { athleteId, axes, polygon: complete ? axes.map(axis => axis.value) : null };
  });

  const polygons = athletes.flatMap(athlete => athlete.polygon ? [athlete.polygon] : []);
  return {
    status: polygons.length ? 'ready' : 'unavailable',
    queryId, bucketKey, athletes,
    radialMaximum: Math.max(100, ...polygons.flat())
  };
}

/** Inputs come from a server query and reference definitions already scoped to its caller. */
export function buildManualRadarSnapshot(config, { queryId, bucketKey, evaluatedAt, measurements, definitions }) {
  const validation = validateRadarConfiguration(config);
  if (!validation.valid) return { status: 'invalid', issues: validation.issues };

  const manual = definitions.filter(definition =>
    validateReferenceDefinition(definition).valid && definition.source.kind === 'manual');
  const observations = [];
  for (const reading of measurements) {
    if (reading.queryId !== queryId || reading.bucketKey !== bucketKey ||
        !config.athleteIds.includes(reading.athleteId)) continue;
    const axis = config.axes.find(item => item.metricDefinitionId === reading.binding?.metricDefinitionId);
    if (!axis) continue;
    const matches = manual.filter(definition =>
      definition.id === axis.referenceId && definition.revision === axis.referenceRevision &&
      definition.binding.metricDefinitionId === axis.metricDefinitionId);
    const [definition] = matches;
    if (!definition) continue;

    let reason = null;
    if (matches.length !== 1) reason = 'ambiguousReference';
    else if (!sameBinding(reading.binding, definition.binding)) reason = 'incompatibleBinding';
    else if (reading.measurementDate < definition.effective.dateFrom ||
             (definition.effective.dateTo && reading.measurementDate > definition.effective.dateTo)) reason = 'outOfValidity';
    else if (definition.population.kind === 'position') reason = 'missingDimension';
    else if (definition.population.kind === 'team' &&
             definition.population.teamId !== reading.teamId) reason = 'notAuthorized';

    observations.push({
      schemaVersion: 1, queryId, bucketKey, evaluatedAt,
      referenceId: definition.id, referenceRevision: definition.revision,
      athleteId: reading.athleteId, binding: definition.binding,
      measurementDate: reading.measurementDate, measurementInstant: reading.measurementInstant, timeZone: reading.timeZone,
      status: reason ? 'unavailable' : 'ready',
      value: reason ? null : definition.source.value, reason, sample: null
    });
  }
  return buildRadarSnapshot(config, { queryId, bucketKey, measurements, observations });
}
