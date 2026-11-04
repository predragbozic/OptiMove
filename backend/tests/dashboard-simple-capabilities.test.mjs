import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimpleCapabilityReader, bindingVisible } from '../src/dashboardSimple/capabilities.js';
import { target, id, metric, builtins } from './fixtures/dashboard-simple/contracts.mjs';
const req = { user: { id: id(3) } };
const workspace = { dataWorkspaceType: 'club', dataWorkspaceScopeId: id(4) };
const args = { req, dataWorkspace: workspace, dashboardId: id(2), metricRef: { kind: 'metric', metricDefinitionId: id(5) } };
function setup({ denied = false, mismatch = false, dashboard = target(), item = metric() } = {}) {
  const calls = [];
  const query = async (sql, params) => { calls.push({ sql, params });
    if (sql.startsWith('select * from training_load.dashboards')) return { rows: dashboard ? [dashboard] : [] };
    if (sql.includes('from training_load.dashboard_widget_types')) return { rows: [{ key: 'table', is_active: true }] };
    if (sql.includes('from training_load.dashboard_builtin_series')) return { rows: builtins() };
    if (sql.includes('from training_load.metric_definitions')) return { rows: item ? [item] : [] };
    if (sql.includes('from training_load.metric_source_connections')) return { rows: [] };
    throw new Error('Unexpected read');
  };
  return { calls, reader: createSimpleCapabilityReader({ query, canManageDashboardRow: () => !denied, dataWorkspaceMatches: () => !mismatch }) };
}
test('mandatory server authorization ports, no silent allow callback', () => { assert.throws(() => createSimpleCapabilityReader({ query() {} }), TypeError); });
for (const config of [{ denied: true }, { mismatch: true }, { dashboard: null }]) test(`missing/foreign/visible-without-manage target same denial ${JSON.stringify(config)}`, async () => {
  const { reader, calls } = setup(config);await assert.rejects(reader.load(args), e => e.code === 'notFound' && e.status === 404);assert.equal(calls.length, 1);
});
test('target eligibility SQL is independent of actor wider permissions', async () => {
  const { reader, calls } = setup();const s = await reader.load(args);assert.equal(s.metric.id, id(5));
  const q = calls.find(c => c.sql.includes('from training_load.metric_definitions'));
  assert.ok(q.sql.includes("d.state='active'"));assert.ok(q.sql.includes("d.owner_scope = 'club' and $3 = 'club'"));assert.ok(q.sql.includes('d.owner_user_id = $2'));assert.ok(q.sql.includes('join training_load.metric_definition_versions'));
  assert.deepEqual(q.params.slice(0, 4), ['user', id(3), 'club', id(4)]);assert.equal(q.params[4], id(5));
});
test('SQL applies target/scope predicate before cursor/limit, parameters never interpolation', async () => {
  const { reader, calls } = setup();await reader.listMetrics({ ...args, search: "' or true --", afterId: id(1), limit: 1, dataScopeLevel: 'component' });const q = calls.at(-1);
  assert.ok(q.sql.indexOf('d.owner_scope') < q.sql.indexOf('order by d.id limit'));assert.ok(q.sql.includes('not exists(select 1 from training_load.metric_definition_scope_capabilities'));
  assert.ok(!q.sql.includes("' or true --"));assert.equal(q.params[5], "' or true --");assert.equal(q.params[7], 2);
});
test('unknown/hidden/inactive metric and source give generic notFound', async () => {
  const { reader } = setup({ item: null });await assert.rejects(reader.load(args), e => e.code === 'notFound');
  const other = setup().reader;await assert.rejects(other.load({ ...args, sourceConnectionId: id(99) }), e => e.code === 'notFound');
});
test('builtins are a distinct DB-read catalog with exact null and no metric query', async () => {
  const { reader, calls } = setup();const s = await reader.load({ ...args, metricRef: { kind: 'builtin', key: 'session_count' } });assert.equal(s.metric.unit, null);assert.equal(s.metric.fixed_data_scope_level, 'day');assert.equal(s.capabilities.backendReference, false);assert.ok(!calls.some(c => c.sql.includes('from training_load.metric_definitions')));
});
test('archived/template context cannot issue catalog reads', async () => {
  for (const d of [{ ...target(), status: 'archived' }, { ...target(), is_template: true }]) { const { reader, calls } = setup({ dashboard: d });await assert.rejects(reader.load(args), e => e.status === 409);assert.equal(calls.length, 1); }
});
test('binding predicate matches owner/data-workspace distinction and denies null ownership', () => {
  assert.equal(bindingVisible(target(), { owner_scope: 'system' }), true);
  assert.equal(bindingVisible(target(), { owner_scope: 'user', owner_user_id: id(3) }), true);
  assert.equal(bindingVisible(target(), { owner_scope: 'club', owner_club_id: id(4) }), true);
  assert.equal(bindingVisible(target(), { owner_scope: 'club', owner_club_id: id(99) }), false);
  assert.equal(bindingVisible(target(), { owner_scope: 'team', owner_team_id: id(4) }), false);
  assert.equal(bindingVisible({ ...target(), owner_user_id: null }, { owner_scope: 'user', owner_user_id: null }), false);
});
