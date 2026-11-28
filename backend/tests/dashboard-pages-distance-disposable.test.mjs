import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';
import { createDisposableDatabase } from './support/disposable-db.mjs';
import { bootstrapLegacySnapshot } from './support/legacy-bootstrap.mjs';
import { activateOn, bindTeam, ensureMappedSystem, platformAdmin } from './support/mapped-world.mjs';
import { makeBundle, standardAthletes } from './_gpexe-fixtures.mjs';

test('an 84-day club distance table and its draft only query relevant GPEXE sessions', async () => {
  const db = await createDisposableDatabase({ prefix: 'dashboard', label: 'distance_preview' });
  const originalUrl = process.env.DATABASE_URL;
  const originalPagesEnabled = process.env.DASHBOARD_PAGES_ENABLED;
  const client = new pg.Client({ connectionString: db.url });
  let server, pool;
  try {
    const migrationsRoot = fileURLToPath(new URL('../../migrations_v2', import.meta.url));
    const snapshotSql = fs.readFileSync(new URL('./support/legacy-schema.sql', import.meta.url), 'utf8');
    const lastMigration = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
    await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot, lastMigration });
    await runMigrations({ databaseUrl: db.url, migrationsRoot });
    process.env.DATABASE_URL = db.url;
    process.env.DASHBOARD_PAGES_ENABLED = 'true';
    await client.connect();
    const actor = await platformAdmin(client, 'dashboard-distance');
    const { id: clubId } = (await client.query("insert into public.clubs(name) values('Distance Club') returning id")).rows[0];
    const { id: teamId } = (await client.query("insert into public.teams(club_id,name) values($1,'Distance Team') returning id", [clubId])).rows[0];
    await client.query("insert into public.user_club_roles(user_id,club_id,role,is_active) values($1,$2,'club_admin',true)", [actor, clubId]);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'club',$2)", [actor, clubId]);
    const athletes = standardAthletes();
    athletes[2].tracks = [9003];
    athletes[2].parts = athletes[2].parts.slice(0, 1);
    const athleteIds = [];
    for (const [index, athlete] of athletes.entries()) {
      const name = `Distance athlete ${index + 1}`;
      const { id } = (await client.query(
        "insert into public.athletes(athlete_id,first_name,last_name,full_name,display_name,device_timezone) values(nextval('public.athlete_generated_id_seq')::text,$1,'Example',$1,$1,'Europe/Sarajevo') returning id",
        [name],
      )).rows[0];
      await client.query(
        "insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status,starts_at) values($1,$2,null,'club','active','2026-01-01T00:00:00Z'),($1,$2,$3,'team','active','2026-01-01T00:00:00Z')",
        [id, clubId, teamId],
      );
      athleteIds.push(id);
      for (const part of athlete.parts) {
        part.distance = [100, 200, 0][index];
        part.time = 600;
      }
    }
    const mapped = await ensureMappedSystem(client, { platformAdminId: actor });
    const binding = await bindTeam(client, { teamId, clubId, sourceTeamId: '9743', by: actor });
    await activateOn(mapped, { bindingId: binding.bindingId, platformAdminId: actor });
    const { importGpexeBundle } = await import('../src/gpexeImportWriter.js');
    const athleteIdByGpexeId = Object.fromEntries(athleteIds.map((id, i) => [101 + i, id]));
    for (let index = 0; index < 27; index++) {
      const date = new Date(Date.UTC(2026, 6, 3 + index * 2)).toISOString().slice(0, 10);
      const bundle = makeBundle({ gpexeTeamId: 9743, sessionId: 6200 + index, start: date + 'T18:08:12', athletes });
      bundle.teamSession.end_timestamp = date + 'T19:19:35';
      await importGpexeBundle(client, bundle, { ownerTeamId: teamId, performedByUserId: actor, athleteIdByGpexeId, batchFilename: 'dashboard distance' });
    }
    const { id: activityId } = (await client.query(
      "select id from training.activities where owner_team_id=$1 and occurred_local_date='2026-07-03'",
      [teamId],
    )).rows[0];
    await client.query(
      `with unrelated_activities as (
         insert into training.activities(activity_type_key,name,occurred_local_date,timezone_snapshot,owner_scope,owner_team_id,origin,lifecycle_state,created_by_user_id)
         select 'training_session','Unrelated session',date '2026-07-01'+(n%84),'UTC','team',$1,'manual','confirmed',$2
         from generate_series(1,3000) n returning id,occurred_local_date
       )
       insert into training.activity_participants(activity_id,athlete_id,local_date,timezone_snapshot,participation_status)
       select unrelated_activities.id,athlete_id,unrelated_activities.occurred_local_date,'UTC','participated'
       from unrelated_activities cross join unnest($3::uuid[]) athlete_id`,
      [teamId, actor, athleteIds],
    );
    await client.query('analyze');
    await client.query('update training_load.dashboard_pages_activation set enabled=true');

    ({ pool } = await import('../src/db.js'));
    const { app } = await import('../src/server.js');
    const { createSession } = await import('../src/auth.js');
    const cookie = `optimove_session=${await createSession(actor)}`;
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    async function api(path, body, status = 200) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    }
    const base = '/api/training-load/dashboards';
    const { dashboard } = await api(base, { name: 'Distance dashboard' }, 201);
    const { pages: [page] } = await api(`${base}/${dashboard.id}/pages`);
    const path = `${base}/${dashboard.id}/pages/${page.id}`;
    const table = { widgetType: 'table', groupBy: 'athlete', title: 'Total distance' };
    const metric = { metricDefinitionId: mapped.gpexe_total_distance.variableId, analyticalAggregation: 'avg', dataScopeLevel: 'session' };
    const { widgetId } = await api(`${path}/widgets`, {
      ...table, widgetOrder: 0, x: 0, y: 0, width: 6, height: 4, mobileOrder: 0,
      expectedDashboardRevision: dashboard.revision, expectedPageRevision: page.revision,
    });
    await api(`${path}/widgets/${widgetId}/series`, { ...metric, expectedWidgetRevision: 1, seriesOrder: 0 });
    for (const filter of [{}, { activityId }, { athleteIds: [athleteIds[0]] }]) {
      const periodAndFilter = { dateFrom: '2026-07-01', dateTo: '2026-09-22', ...filter };
      const preview = await api(`${path}/query`, { ...periodAndFilter, metricPreview: { ...table, ...metric, widgetId } });
      const saved = await api(`${path}/query`, periodAndFilter);
      const series = saved.widgets[0].series[0];
      assert.equal(series.status, 'ok', JSON.stringify(series));
      assert.deepEqual(preview.result.series[0], series);
      const values = series.data.current.map(row => row.value).sort((a, b) => a - b);
      assert.deepEqual(values, filter.athleteIds ? [100] : [0, 100, 200]);
    }
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool?.end();
    await client.end();
    await db.drop();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalPagesEnabled === undefined) delete process.env.DASHBOARD_PAGES_ENABLED;
    else process.env.DASHBOARD_PAGES_ENABLED = originalPagesEnabled;
  }
});
