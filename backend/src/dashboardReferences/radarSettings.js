import { randomUUID } from 'node:crypto';
import { isDate, isUuid } from '../dashboardSimple/schema.js';
import { previewError } from '../dashboardSimple/previewTransaction.js';
import { isMetricVisibleToDashboard } from '../trainingLoadDashboardAccess.js';
import { validateRadarConfiguration, validateReferenceDefinition } from './contract.js';

const unique = ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length;

export function validRadarSettings(settings) {
  if (!settings || Object.keys(settings).length !== 4) return false;
  const { athleteIds, axes, dateFrom, dateTo } = settings;
  return isDate(dateFrom) && (dateTo === null || isDate(dateTo) && dateTo >= dateFrom) &&
    Array.isArray(athleteIds) && athleteIds.length >= 1 && athleteIds.length <= 5 &&
    athleteIds.every(isUuid) && unique(athleteIds) &&
    Array.isArray(axes) && axes.length >= 3 && axes.length <= 8 &&
    axes.every(axis => axis && Object.keys(axis).length === 2 && isUuid(axis.metricDefinitionId) &&
      Number.isFinite(axis.value) && axis.value > 0) && unique(axes.map(axis => axis.metricDefinitionId));
}

export async function bindManualRadar(q, target, widget, settings, assertFilterVisible) {
  const teamId = target.workspace.dataWorkspaceScopeId;
  const invalid = () => previewError('invalidRequest', 400);
  if (target.workspace.dataWorkspaceType !== 'team' || widget?.widget_type !== 'table' ||
      widget.group_by !== 'day' || !validRadarSettings(settings)) throw invalid();
  await assertFilterVisible(q, target, { athleteIds: settings.athleteIds });
  const series = (await q('select * from training_load.dashboard_widget_series where widget_id=$1 order by series_order', [widget.id])).rows;
  if (series.length !== settings.axes.length) throw invalid();
  const definitions = [];
  for (const axis of settings.axes) {
    const matches = series.filter(item => item.metric_definition_id === axis.metricDefinitionId);
    if (matches.length !== 1 || matches[0].comparison_period || matches[0].resolution_status !== 'resolved') throw invalid();
    const [item] = matches;
    const metric = (await q(`select v.id, v.unit, v.value_type
      from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
      where d.id=$1 for share of d`, [axis.metricDefinitionId])).rows[0];
    if (metric?.value_type !== 'numeric') throw invalid();
    const access = await isMetricVisibleToDashboard(target.dashboard, axis.metricDefinitionId, q);
    if (!access.visible || access.def?.state !== 'active') throw invalid();
    const definition = {
      schemaVersion: 1, id: randomUUID(), revision: 1, name: 'Manual Radar reference',
      owner: { kind: 'team', id: teamId }, population: { kind: 'team', teamId },
      binding: {
        metricDefinitionId: axis.metricDefinitionId, metricVersionId: metric.id, unit: metric.unit,
        dataScopeLevel: item.data_scope_level, analyticalAggregation: item.analytical_aggregation,
        sourcePolicy: item.source_policy, sourceConnectionId: item.source_connection_id ?? null,
        aggregationRolePolicy: item.aggregation_role_policy, coveragePolicy: item.coverage_policy
      },
      effective: { dateFrom: settings.dateFrom, dateTo: settings.dateTo },
      source: { kind: 'manual', value: axis.value }
    };
    if (!validateReferenceDefinition(definition).valid) throw invalid();
    definitions.push(definition);
  }
  const config = {
    schemaVersion: 1, chartVariant: 'radar', formulaVersion: 'attainment-positive-v1',
    radialScale: { mode: 'auto', minimum: 0 }, missing: 'unavailable',
    athleteIds: settings.athleteIds, axes: definitions.map(definition => ({
      metricDefinitionId: definition.binding.metricDefinitionId,
      referenceId: definition.id, referenceRevision: definition.revision
    }))
  };
  if (!validateRadarConfiguration(config).valid) throw invalid();
  return { config, definitions };
}
