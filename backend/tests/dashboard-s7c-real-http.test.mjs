import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationalFixture } from './support/dashboard-simple-operational-fixture.mjs';

test('Radar binds three mixed-unit metrics, saves, reloads and queries the persisted references', { timeout: 180000 }, async t => {
  const f = await operationalFixture(t, { pages: true });
  const call = async (path, method, body, status = 200) => {
    const response = await f.request(f.pagesBase + path, body, method);
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body;
  };
  const { pages } = await call('', 'GET');
  const [page] = pages;
  const pagePath = '/' + page.id;
  const advanced = pagePath + '/advanced/widgets';
  const request = payload => ({ contractVersion: 1, requestId: randomUUID(), ...payload });
  await call(advanced, 'POST', request({
    expectedPageRevision: page.revision, widgetType: 'table', title: 'Synthetic Radar',
    groupBy: 'day', widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0
  }), 201);
  const detail = async () => (await call(pagePath, 'GET')).widgets[0];
  let widget = await detail();
  const axes = [];
  const date = '2026-10-28';
  const event = await f.one(`insert into training_load.metric_events
    (event_name,occurred_date,scope_level,owner_scope,owner_team_id,created_by_user_id)
    values ('Radar',$1,'day','team',$2,$3) returning id`, [date, f.team.id, f.coach.id]);
  const participant = await f.one(`insert into training_load.metric_event_participants (event_id,athlete_id,athlete_timezone_snapshot)
    values ($1,$2,'Europe/Belgrade') returning id`, [event.id, f.athlete.id]);
  const occasion = await f.one(`insert into training_load.metric_measurement_occasions (event_participant_id,entry_method)
    values ($1,'manual') returning id`, [participant.id]);
  for (const [index, unit] of ['m', 'min', 'AU'].entries()) {
    const metric = await f.one(`insert into training_load.metric_definitions (key,label,owner_scope,owner_team_id,state,created_by_user_id)
      values ($1,$1,'team',$2,'active',$3) returning id`, [`radar-${index}`, f.team.id, f.coach.id]);
    const version = await f.one(`insert into training_load.metric_definition_versions
      (metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id)
      values ($1,1,$2,'numeric','sum',$3) returning id`, [metric.id, unit, f.coach.id]);
    await f.pool.query('update training_load.metric_definitions set current_version_id=$1 where id=$2', [version.id, metric.id]);
    await f.pool.query("insert into training_load.metric_definition_scope_capabilities (metric_definition_id,scope_level) values ($1,'day')", [metric.id]);
    await f.pool.query(`insert into training_load.metric_values
      (occasion_id,metric_definition_id,metric_definition_version_id,value_numeric,unit_at_capture,aggregation_role,coverage)
      values ($1,$2,$3,12,$4,'standalone','not_applicable')`, [occasion.id, metric.id, version.id, unit]);
    await call(`${advanced}/${widget.id}/series`, 'POST', request({
      expectedWidgetRevision: widget.revision, metricDefinitionId: metric.id, seriesOrder: index,
      dataScopeLevel: 'day', analyticalAggregation: 'sum', sourcePolicy: 'manual',
      aggregationRolePolicy: 'standalone_only', coveragePolicy: 'complete_only'
    }), 201);
    widget = await detail();
    axes.push({ metricDefinitionId: metric.id, value: 10 });
  }
  const route = `${advanced}/${widget.id}`;
  const radarSettings = { athleteIds: [f.athlete.id], axes, dateFrom: date, dateTo: date };
  await call(route, 'PATCH', request({
    expectedWidgetRevision: widget.revision, displayConfig: { schemaVersion: 1, radarSettings: { ...radarSettings, athleteIds: [randomUUID()] } }
  }), 404);
  const input = request({ expectedWidgetRevision: widget.revision, displayConfig: { schemaVersion: 1, radarSettings } });
  await call(route, 'PATCH', input);
  assert.equal((await call(route, 'PATCH', input)).verification, 'replayed');
  widget = await detail();
  assert.deepEqual(widget.display_config.radarSettings, radarSettings);
  const query = async dateTo => call(pagePath + '/query', 'POST', {
    period: { ...f.period, dateFrom: date, dateTo }, widgetIds: [widget.id]
  });
  const result = await query(date);
  assert.equal(result.widgets[0].radarSnapshot.queryId, result.queryId);
  assert.deepEqual(result.widgets[0].radarSnapshot.athletes[0].polygon, [120, 120, 120]);
  assert.equal((await query('2026-10-29')).widgets[0].radarSnapshot.athletes[0].axes[0].reason, 'singleDayRequired');

  await t.test('copies a widget across pages and replays without a second copy', async () => {
    const listed = await call('', 'GET');
    assert.equal(listed.capabilities.widgetCopy, true);
    await call('', 'POST', request({ name: 'Copy destination', expectedPagesRevision: listed.pagesRevision,
      periodConfig: { schemaVersion: 1, mode: 'fixed', dateFrom: date, dateTo: date, timeZone: f.period.timeZone },
      defaultFilter: {} }), 201);
    const destination = (await call('', 'GET')).pages.find(item => item.name === 'Copy destination');
    const copyInput = request({ destinationPageId: destination.id, expectedWidgetRevision: widget.revision });
    const copied = await call(route + '/copy', 'POST', copyInput, 201);
    assert.equal((await call(route + '/copy', 'POST', copyInput, 201)).verification, 'replayed');
    const { widgets } = await call('/' + destination.id, 'GET');
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].id, copied.result.widgetId);
    assert.deepEqual(widgets[0].display_config, widget.display_config);
    assert.deepEqual(widgets[0].series.map(series => series.metric_definition_id), widget.series.map(series => series.metric_definition_id));
    assert.ok(widgets[0].series.every(series => !widget.series.some(original => original.id === series.id)));
    assert.equal((await call('/' + destination.id + '/query', 'POST', {})).widgets[0].radarSnapshot.status, 'ready');
  });

  await t.test('team-scoped table revision resolves an exact historical match and is immutable', async () => {
    const { resolveTableReference } = await import('../src/dashboardReferences/referenceSources.js');
    const definition = structuredClone(widget.display_config.radar.definitions[0]);
    definition.source = {
      kind: 'referenceTable', tableId: randomUUID(), tableRevision: 1, dimensions: ['position'],
      dimensionBasis: 'measurementDate', ambiguity: 'unavailable'
    };
    const row = { id: randomUUID(), value: 14, provenance: { source: 'synthetic' },
      dimensions: { position: 'defender' }, valid_from: date, valid_to: date };
    const q = (sql, params) => f.pool.query(sql, params);
    const insert = async (revision, rows) => q(`insert into training_load.dashboard_reference_table_revisions
      (team_id, table_id, revision, binding, rows) values ($1,$2,$3,$4,$5)`,
    [f.team.id, definition.source.tableId, revision, definition.binding, JSON.stringify(rows)]);
    await insert(1, [row]);
    assert.equal((await resolveTableReference(q, definition, date, null, f.team.id)).reason, 'missingDimension');
    assert.equal((await resolveTableReference(q, definition, date, row.dimensions, randomUUID())).reason, 'notAuthorized');
    const match = await resolveTableReference(q, definition, date, row.dimensions, f.team.id);
    assert.equal(match.value, 14);
    assert.equal(match.provenance.rowId, row.id);
    await insert(2, [row, { ...row, id: randomUUID() }]);
    definition.source.tableRevision = 2;
    assert.equal((await resolveTableReference(q, definition, date, row.dimensions, f.team.id)).reason, 'ambiguousReference');
    await assert.rejects(q('update training_load.dashboard_reference_table_revisions set rows=rows where team_id=$1', [f.team.id]), { code: '23514' });
  });
});
