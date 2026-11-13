import { isDate, isUuid } from '../dashboardSimple/schema.js';
import { validReferenceBinding, validateReferenceDefinition } from './contract.js';

const unavailable = reason => ({ status: 'unavailable', reason, value: null });
const sameBinding = (actual, expected) => validReferenceBinding(actual) &&
  Object.keys(expected).every(key => actual[key] === expected[key]);

// Inputs are supplied by trusted server repositories. A current profile or
// caller-supplied position cannot substitute for an as-of measurement fact.
export async function resolveTableReference(q, definition, date, historicalDimensions, teamId) {
  if (!validateReferenceDefinition(definition).valid || definition.source.kind !== 'referenceTable' ||
      definition.owner.kind !== 'team' || definition.owner.id !== teamId || definition.population.teamId !== teamId) {
    return unavailable('notAuthorized');
  }
  if (!isDate(date) || date < definition.effective.dateFrom || definition.effective.dateTo && date > definition.effective.dateTo) {
    return unavailable('outOfValidity');
  }
  const source = definition.source;
  const dimensions = source.dimensions;
  if (!isDate(date) || dimensions.some(key => typeof historicalDimensions?.[key] !== 'string' ||
      !historicalDimensions[key].trim())) return unavailable('missingDimension');
  const lookup = Object.fromEntries(dimensions.map(key => [key, historicalDimensions[key]]));
  const rows = (await q(`select r.id, r.value, r.provenance, t.binding
    from training_load.dashboard_reference_table_revisions t
    cross join lateral jsonb_to_recordset(t.rows)
      as r(id uuid, value double precision, provenance jsonb, dimensions jsonb, valid_from date, valid_to date)
    where t.team_id=$1 and t.table_id=$2 and t.revision=$3 and r.dimensions=$4::jsonb
      and r.valid_from <= $5::date and (r.valid_to is null or r.valid_to >= $5::date)
    limit 2`, [definition.owner.id, source.tableId, source.tableRevision, JSON.stringify(lookup), date])).rows;
  if (rows.length !== 1) return unavailable(rows.length ? 'ambiguousReference' : 'missingReference');
  const [row] = rows;
  if (!sameBinding(row.binding, definition.binding)) return unavailable('incompatibleBinding');
  if (!isUuid(row.id) || !Number.isFinite(row.value) || !row.provenance) return unavailable('problemData');
  return { status: 'ready', value: row.value, provenance: { tableId: source.tableId,
    revision: source.tableRevision, rowId: row.id, source: row.provenance } };
}

// A provider must attest a complete candidate window, historical membership,
// participation and match classification before any sample can be used.
export function resolveRollingReference(definition, { measurementInstant, measurementDate, evaluatedEventId, athleteId, teamId, evidence } = {}) {
  if (!validateReferenceDefinition(definition).valid || definition.source.kind !== 'rollingMatches') return unavailable('problemData');
  if (definition.owner.kind !== 'team' || definition.owner.id !== teamId ||
      definition.population.teamId && definition.population.teamId !== teamId) return unavailable('notAuthorized');
  if (!Number.isFinite(Date.parse(measurementInstant)) || !isDate(measurementDate) ||
      !isUuid(evaluatedEventId) || !isUuid(athleteId)) return unavailable('missingMeasurementEvent');
  if (measurementDate < definition.effective.dateFrom || definition.effective.dateTo && measurementDate > definition.effective.dateTo) {
    return unavailable('outOfValidity');
  }
  if (!evidence?.complete || !Array.isArray(evidence.events)) return unavailable('missingMatchEvidence');
  const source = definition.source;
  const individual = definition.population.kind === 'individual';
  const byPosition = definition.population.kind === 'position';
  if (byPosition && !evidence.measurementPosition) return unavailable('missingDimension');
  const events = [];
  const ids = new Set();
  for (const event of evidence.events) {
    if (!isUuid(event.id) || ids.has(event.id.toLowerCase()) || !Number.isFinite(Date.parse(event.instant))) return unavailable('problemData');
    ids.add(event.id.toLowerCase());
    if (event.id.toLowerCase() === evaluatedEventId.toLowerCase() || Date.parse(event.instant) >= Date.parse(measurementInstant)) continue;
    if (event.teamId !== teamId) return unavailable('notAuthorized');
    if (!['official', 'friendly'].includes(event.matchType)) return unavailable('missingMatchClassification');
    if (source.matchTypes === 'official' && event.matchType !== 'official') continue;
    if (!event.rosterConfirmed || !Array.isArray(event.players) ||
        event.players.some(player => !isUuid(player?.athleteId))) return unavailable('missingHistoricalRoster');
    const measured = event.players.filter(player => player.athleteId === athleteId);
    if (source.selection === 'athleteParticipatedMatches') {
      if (!measured.length) continue;
      if (measured.length !== 1) return unavailable('problemData');
      if (!Number.isFinite(measured[0].minutes) || measured[0].minutes < 0 || measured[0].minutes > 300) return unavailable('missingPlayingMinutes');
      if (measured[0].minutes < source.minimumParticipationMinutes) continue;
    }
    if (byPosition && event.players.some(player => !player.positionAtMatch)) return unavailable('missingDimension');
    const players = individual ? measured : byPosition
      ? event.players.filter(player => player.positionAtMatch === evidence.measurementPosition) : event.players;
    if (players.some(player => !Number.isFinite(player.minutes) || player.minutes < 0 || player.minutes > 300)) {
      return unavailable('missingPlayingMinutes');
    }
    events.push({ ...event, players: players.filter(player => player.minutes >= source.minimumParticipationMinutes) });
  }
  events.sort((a, b) => Date.parse(b.instant) - Date.parse(a.instant) || a.id.localeCompare(b.id));
  const selected = events.slice(0, source.requestedMatches);
  const usable = [];
  const valuesByAthlete = new Map();
  for (const event of selected) {
    const players = new Set();
    if (!event.players.length) continue;
    for (const player of event.players) {
      if (!isUuid(player.athleteId) || players.has(player.athleteId) || !Number.isFinite(player.value) ||
          !sameBinding(player.binding, definition.binding)) return unavailable('problemData');
      players.add(player.athleteId);
      if (!valuesByAthlete.has(player.athleteId)) valuesByAthlete.set(player.athleteId, []);
      valuesByAthlete.get(player.athleteId).push(player.value);
    }
    usable.push(event.id);
  }
  const sample = { requestedMatches: source.requestedMatches, usedMatches: usable.length,
    partial: usable.length < source.requestedMatches, eventIds: usable };
  if (usable.length < source.minimumMatches || sample.partial && source.partialPolicy !== 'allowPartial') {
    return { ...unavailable('insufficientSample'), sample };
  }
  const mean = values => values.reduce((sum, value) => sum + value / values.length, 0);
  const groups = [...valuesByAthlete.values()];
  const value = mean(source.weighting === 'athleteMeansEqual' ? groups.map(mean) : groups.flat());
  return Number.isFinite(value) ? { status: 'ready', value, sample } : unavailable('problemData');
}
