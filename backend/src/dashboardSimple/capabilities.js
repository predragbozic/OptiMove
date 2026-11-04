// Isolated read port. Caller supplies a server-owned query runner and the
// existing DashboardAccess predicates, not booleans or claims from a request body.
// Deliberately not imported/registered by any production route in S2a.
import { isUuid, validateContract } from './schema.js';
const TYPES = ['numeric', 'boolean', 'text'];
const withAggregations = row => ({ ...row, allowed_aggregations: row.value_type === 'numeric' ? ['sum', 'avg', 'max', 'last', 'none'] : ['last', 'none'] });
export class SimpleContractError extends Error {
  constructor(code, status = 404) { super(code); this.code = code; this.status = status; }
}
export function bindingVisible(target, row) {
  if (!target || !row) return false;
  if (row.owner_scope === 'system') return true;
  if (row.owner_scope === 'user') return target.owner_scope === 'user' && target.owner_user_id != null && row.owner_user_id === target.owner_user_id;
  return ['club', 'team'].some(scope => row.owner_scope === scope && target.data_workspace_type === scope && row[`owner_${scope}_id`] != null && row[`owner_${scope}_id`] === target.data_workspace_scope_id);
}
// IDs belong to an already authorized target. Apply this BEFORE pagination,
// irrespective of the actor's wider catalog or platform administrator rights.
const visibleSql = alias => `(${alias}.owner_scope = 'system'
 or (${alias}.owner_scope = 'user' and $1 = 'user' and ${alias}.owner_user_id = $2)
 or (${alias}.owner_scope = 'club' and $3 = 'club' and ${alias}.owner_club_id = $4)
 or (${alias}.owner_scope = 'team' and $3 = 'team' and ${alias}.owner_team_id = $4))`;
const targetParams = d => [d.owner_scope, d.owner_user_id, d.data_workspace_type, d.data_workspace_scope_id];
export function createSimpleCapabilityReader({ query, canManageDashboardRow, dataWorkspaceMatches }) {
  if (![query, canManageDashboardRow, dataWorkspaceMatches].every(f => typeof f === 'function')) throw new TypeError('Server query and DashboardAccess predicates required');
  async function target(req, dataWorkspace, id) {
    if (!req?.user?.id || !isUuid(id)) throw new SimpleContractError('notFound');
    const { rows } = await query('select * from training_load.dashboards where id = $1', [id]);
    const d = rows[0];
    if (!d || !canManageDashboardRow(req, d) || !dataWorkspaceMatches(dataWorkspace, d)) throw new SimpleContractError('notFound');
    if (d.status !== 'active') throw new SimpleContractError('dashboardArchived', 409);
    if (d.is_template || d.data_workspace_type == null) throw new SimpleContractError('templateRequiresClone', 409);
    return d;
  }
  async function listMetrics({ req, dataWorkspace, dashboardId, search = '', afterId = null, limit = 100, dataScopeLevel = null }) {
    const d = await target(req, dataWorkspace, dashboardId);
    if (typeof search !== 'string' || search.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100 || afterId !== null && !isUuid(afterId) || dataScopeLevel !== null && !['day', 'session', 'component'].includes(dataScopeLevel)) throw new SimpleContractError('invalidRequest', 400);
    const { rows } = await query(`select d.id, d.key, d.label, d.current_version_id, v.value_type, v.unit, v.daily_aggregation_method,
      coalesce((select json_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id=d.id), '[]'::json) as scope_capabilities
      from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
      where d.state='active' and ${visibleSql('d')} and v.value_type = any($5::text[])
      and ($6::text = '' or d.key ilike '%' || $6 || '%' or d.label ilike '%' || $6 || '%')
      and ($7::uuid is null or d.id > $7::uuid)
      and ($9::text is null or not exists(select 1 from training_load.metric_definition_scope_capabilities c where c.metric_definition_id=d.id)
        or exists(select 1 from training_load.metric_definition_scope_capabilities c where c.metric_definition_id=d.id and c.scope_level=$9))
      order by d.id limit $8`, [...targetParams(d), TYPES, search, afterId, limit + 1, dataScopeLevel]);
    const page = rows.slice(0, limit);
    return { metrics: page.map(withAggregations), nextCursor: rows.length > limit ? page.at(-1).id : null };
  }
  async function load({ req, dataWorkspace, dashboardId, metricRef, sourceConnectionId = null }) {
    const d = await target(req, dataWorkspace, dashboardId);
    if (!validateContract('metricRef', metricRef).valid || sourceConnectionId !== null && !isUuid(sourceConnectionId)) throw new SimpleContractError('invalidRequest', 400);
    const widgetTypes = (await query('select * from training_load.dashboard_widget_types where is_active = true order by key', [])).rows;
    // Unit is selected verbatim: an explicit catalog null is never "count".
    const builtins = (await query('select key, label, unit, value_type, default_analytical_aggregation, fixed_data_scope_level, is_active from training_load.dashboard_builtin_series where is_active = true order by key', [])).rows.map(withAggregations);
    let metric;
    if (metricRef.kind === 'builtin') metric = builtins.find(b => b.key === metricRef.key);
    else metric = (await query(`select d.*, v.value_type, v.unit, v.daily_aggregation_method,
      coalesce((select json_agg(c.scope_level order by c.scope_level) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id=d.id), '[]'::json) as scope_capabilities
      from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
      where d.state='active' and ${visibleSql('d')} and d.id=$5`, [...targetParams(d), metricRef.metricDefinitionId])).rows[0];
    if (!metric || !TYPES.includes(metric.value_type)) throw new SimpleContractError('notFound');
    let connection = null;
    if (sourceConnectionId) {
      connection = (await query(`select c.* from training_load.metric_source_connections c where c.state='active' and ${visibleSql('c')} and c.id=$5`, [...targetParams(d), sourceConnectionId])).rows[0];
      if (!connection) throw new SimpleContractError('notFound');
    }
    return { dashboard: d, metric, metricRef: structuredClone(metricRef), connection, widgetTypes, builtins, capabilities: { contractVersion: 1, chartComposition: ['athletes-v1'], maxChartAthletes: 20, pages: false, backendReference: false, referencePercent: false } };
  }
  return { listMetrics, load };
}
