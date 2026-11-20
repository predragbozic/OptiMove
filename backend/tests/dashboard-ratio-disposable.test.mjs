import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { queryRatioBuckets } from '../src/dashboardRatios.js';
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from './_gpexe-disposable-db.mjs';
import { platformAdmin, ensureMappedSystem, bindTeam, activateOn } from './support/mapped-world.mjs';
import { makeBundle, standardAthletes } from './_gpexe-fixtures.mjs';
let db, client, server, pool, base, cookie, world, org, ratio, run, importAt;
const original = process.env.DATABASE_URL;
async function api(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: original, label: 'dashboard_ratio', migrations: [...new Set([...GPEXE_TEST_MIGRATIONS, "202611151000_training_load_v71_dashboard_simple_atomic_save.sql"])].sort() });
  client = new pg.Client({ connectionString: db.url }); await client.connect(); process.env.DATABASE_URL = db.url;
  const pa = await platformAdmin(client, 'dashboard-ratio');
  await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)", [pa]);
  const { app } = await import('../src/server.js'); ({ pool } = await import('../src/db.js'));
  const { createSession } = await import('../src/auth.js'); cookie = `optimove_session=${await createSession(pa)}`;
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  world = await ensureMappedSystem(client, { platformAdminId: pa });

  org = await createGpexePilotOrg(client, { athleteNames: ['Alex', 'Bo', 'Cam'] });
  const binding = await bindTeam(client, { teamId: org.teamId, clubId: org.clubId, sourceTeamId: '9743', by: pa });
  await activateOn(world, { bindingId: binding.bindingId, platformAdminId: pa });
  const { importGpexeBundle } = await import('../src/gpexeImportWriter.js');
  const athletes = standardAthletes();
  athletes[2].tracks = [9003]; athletes[2].parts = athletes[2].parts.slice(0, 1);
  for (let i = 0; i < athletes.length; i++) for (const part of athletes[i].parts) { part.distance = [100,100,0][i]; part.time = [600,1800,600][i]; }
  await importGpexeBundle(client, makeBundle({ gpexeTeamId: 9743, sessionId: 5090, start: "2026-09-13T18:08:12", athletes }), { ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: {101:org.athleteIds[0],102:org.athleteIds[1],103:org.athleteIds[2]}, batchFilename: 'dashboard ratio test' });
  const created = await api('/api/training-load/sources/metrics/variables', { requestKey: crypto.randomUUID(), label: 'Dashboard test metres per minute', unit: 'm/min', levels: ['session','drill'], calculation: { kind: 'ratio', scale: 1, inputs: [world.gpexe_total_distance.variableId, world.gpexe_time_min.variableId] } });
  assert.equal(created.status, 201, JSON.stringify(created)); ratio = created.body.variable;
  await importGpexeBundle(client, makeBundle({ gpexeTeamId: 9743, sessionId: 5091, athletes }), { ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: {101:org.athleteIds[0],102:org.athleteIds[1],103:org.athleteIds[2]}, batchFilename: 'dashboard ratio test' });
  importAt = async (sessionId, date, zeroDenominator = false, modify = null) => {
    const values = structuredClone(athletes);
    if (zeroDenominator) for (const part of values[0].parts) part.time=0;
    for (const athlete of values) for (const part of athlete.parts) part.power[2]=10;
    modify?.(values);
    const bundle=makeBundle({gpexeTeamId:9743,sessionId,start:date+'T18:08:12',athletes:values});bundle.teamSession.end_timestamp=date+'T19:19:35';
    await importGpexeBundle(client,bundle,{ownerTeamId:org.teamId,performedByUserId:org.userId,athleteIdByGpexeId:{101:org.athleteIds[0],102:org.athleteIds[1],103:org.athleteIds[2]},batchFilename:'ratio test'});
  };
  ({ runDashboardBatchQuery: run } = await import('../src/trainingLoadDashboardQuery.js'));
});
after(async () => { if(server){server.closeAllConnections();await new Promise(r=>server.close(r));} await pool?.end();await client?.end();await db?.drop();process.env.DATABASE_URL=original; });
async function query(aggregation='ratio', groupBy='cohort', extra={}, range={}) {
  const [result] = await run({ dataWorkspaceType: 'team', dataWorkspaceScopeId: org.teamId, dateFrom:'2026-09-14',dateTo:'2026-09-14',...range },
    [{widgetId:'widget',seriesId:'series',metricDefinitionId:String(ratio.id),dataScopeLevel:'session',aggregationRolePolicy:'all_including_derived',sourcePolicy:'all_with_conflicts',groupBy,analyticalAggregation:aggregation,...extra}], {queryRunner:(sql,params)=>client.query(sql,params)});
  return result;
}
test('ratio created through the admin API pools exact inputs, includes zero and returns coverage', async () => {
  const result=await query(); assert.equal(result.status,'ok',JSON.stringify(result));
  const r=result.data.current[0]; assert.equal(r.numerator,200);assert.equal(r.denominator,50);assert.equal(r.value,4);
  assert.deepEqual(result.coverage,{includedOccasions:3,leftOutOccasions:0});assert.equal(result.calculation.kind,'ratio');
});
test('all grouping modes and allowed aggregations run; highest/latest stay stored, none is per occasion', async()=>{
  for(const group of ['day','week','session','athlete','cohort']){const r=await query('ratio',group);assert.equal(r.status,'ok',JSON.stringify(r));assert.ok(r.data.current.length);}
  const highest=await query('max');assert.equal(highest.data.current[0].value,10);assert.equal(highest.data.current[0].numerator,null);
  const none=await query('none');assert.equal(none.data.current.length,3);assert.ok(none.data.current.some(r=>r.value===0));
  const last=await query('last');assert.equal(last.status,'ok');assert.equal(last.data.current[0].denominator,null);
});
test('forbidden aggregations and role policy are series errors, never sums or averages',async()=>{
  for(const agg of ['sum','avg'])assert.equal((await query(agg)).error,'aggregation_not_allowed');
  assert.equal((await query('ratio','cohort',{aggregationRolePolicy:'standalone_only'})).error,'aggregation_not_allowed');
});

test('ratio series saves through real routes; sum and average refuse with no new series',async()=>{
  const made=await api('/api/training-load/dashboards',{name:'Ratio fixture'});assert.equal(made.status,201,JSON.stringify(made));
  const id=made.body.dashboard.id;
  const widget=await api('/api/training-load/dashboards/'+id+'/widgets',{expectedDashboardRevision:made.body.dashboard.revision,widgetType:'table',title:'Ratio fixture',groupBy:'cohort',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0});assert.equal(widget.status,201,JSON.stringify(widget));
  const endpoint='/api/training-load/dashboards/'+id+'/widgets/'+widget.body.widgetId+'/series';
  for(const agg of ['sum','avg']){const r=await api(endpoint,{expectedWidgetRevision:1,seriesOrder:0,metricDefinitionId:ratio.id,dataScopeLevel:'session',analyticalAggregation:agg,aggregationRolePolicy:'all_including_derived'});assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.error,'aggregation_not_allowed');}
  const allowed=await api(endpoint,{expectedWidgetRevision:1,seriesOrder:0,metricDefinitionId:ratio.id,dataScopeLevel:'session',analyticalAggregation:'ratio',aggregationRolePolicy:'all_including_derived'});assert.equal(allowed.status,201,JSON.stringify(allowed));
});
test('coverage includes entirely omitted old-session buckets, independently of output rows',async()=>{
  const r=await query('ratio','day',{}, {dateFrom:'2026-09-13'});
  assert.equal(r.status,'ok',JSON.stringify(r));assert.deepEqual(r.coverage,{includedOccasions:3,leftOutOccasions:3});
  assert.equal(r.data.current.length,1);assert.equal(r.data.current[0].leftOutOccasions,0);
  const empty=await query('ratio','day',{}, {dateFrom:'2026-09-13',dateTo:'2026-09-13'});
  assert.deepEqual(empty.data.current,[]);assert.deepEqual(empty.coverage,{includedOccasions:0,leftOutOccasions:3});
});

test('zero denominator is left out, component ratios and percentage scale use exact inputs',async()=>{
  const share=await api('/api/training-load/sources/metrics/variables',{requestKey:crypto.randomUUID(),label:'Dashboard share',unit:'%',levels:['session','drill'],calculation:{kind:'ratio',scale:100,inputs:[world.gpexe_power_zone_25_60_distance.variableId,world.gpexe_total_distance.variableId]}});assert.equal(share.status,201,JSON.stringify(share));
  const create=async(body)=>{const r=await api('/api/training-load/sources/metrics/variables',{requestKey:crypto.randomUUID(),levels:['session','drill'],...body});assert.equal(r.status,201,JSON.stringify(r));return r.body.variable;};
  const sum=await create({label:'Dashboard sum input',unit:'m',calculation:{kind:'sum',inputs:[world.gpexe_power_zone_25_60_distance.variableId,world.gpexe_power_zone_60_75_distance.variableId]}});
  const nested=await create({label:'Dashboard ratio over sum',unit:'m/min',calculation:{kind:'ratio',scale:1,inputs:[sum.id,world.gpexe_time_min.variableId]}});
  await importAt(5092,'2026-09-15',true);
  const overSum=await query('ratio','cohort',{metricDefinitionId:nested.id},{dateFrom:'2026-09-15',dateTo:'2026-09-15'});assert.equal(overSum.status,'ok',JSON.stringify(overSum));assert.equal(overSum.data.current[0].numerator,45);assert.equal(overSum.data.current[0].denominator,40);assert.equal(overSum.data.current[0].value,1.125);
  const r=await query('ratio','cohort',{}, {dateFrom:'2026-09-15',dateTo:'2026-09-15'});assert.equal(r.status,'ok',JSON.stringify(r));assert.deepEqual(r.coverage,{includedOccasions:2,leftOutOccasions:1});
  const components=await query('ratio','component',{dataScopeLevel:'component'},{dateFrom:'2026-09-15',dateTo:'2026-09-15'});assert.equal(components.status,'ok',JSON.stringify(components));
  const percent=await query('ratio','cohort',{metricDefinitionId:share.body.variable.id},{dateFrom:'2026-09-15',dateTo:'2026-09-15'});assert.equal(percent.status,'ok',JSON.stringify(percent));assert.equal(percent.calculation.scale,100);assert.equal(percent.data.current[0].value,10);
  const oldShare=await query('ratio','day',{metricDefinitionId:share.body.variable.id});assert.deepEqual(oldShare.data.current,[]);assert.deepEqual(oldShare.coverage,{includedOccasions:0,leftOutOccasions:3});
});
test('numeric rounding is PostgreSQL half-away-from-zero at six places and last uses the occasion tie-break',async()=>{
  await importAt(5095,'2026-09-18',false,values=>{for(const part of values[0].parts){part.distance=2.000001;part.time=120;}});
  const rounded=await query('ratio','athlete',{}, {dateFrom:'2026-09-18',dateTo:'2026-09-18'});assert.equal(rounded.status,'ok',JSON.stringify(rounded));assert.equal(rounded.data.current.find(r=>r.athleteId===org.athleteIds[0]).value,1.000001);
  const expected=(await client.query(`select v.value_numeric::float8 as value from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id=v.occasion_id
    join training_load.metric_event_participants p on p.id=o.event_participant_id
    join training_load.metric_events e on e.id=p.event_id
    where v.metric_definition_id=$1 and e.occurred_date='2026-09-18' and e.scope_level='session' and o.segment_id is null
    order by e.occurred_instant desc,o.id desc limit 1`,[ratio.id])).rows[0].value;
  const last=await query('last','cohort',{}, {dateFrom:'2026-09-18',dateTo:'2026-09-18'});assert.equal(last.data.current[0].value,expected);
});
test('a new version with the same calculation is accepted; changed inputs isolate the series error',async()=>{
  const version=async(inputs)=>{
    const current=(await client.query('select current_version_id from training_load.metric_definitions where id=$1',[ratio.id])).rows[0].current_version_id;
    const r=await api('/api/training-load/sources/metrics/variables/'+ratio.id+'/versions',{requestKey:crypto.randomUUID(),expectedCurrentVersionId:current,unit:'m/min',calculation:{kind:'ratio',scale:1,inputs}});assert.equal(r.status,201,JSON.stringify(r));
  };
  // The admin API correctly refuses a no-op version. Rehearse existing historical
  // same-formula versions directly in this disposable fixture; the ratio itself was API-created.
  const historical=(await client.query(`insert into training_load.metric_definition_versions
    (metric_definition_id,version_number,unit,value_type,daily_aggregation_method,calculation)
    select v.metric_definition_id,v.version_number+1,v.unit,v.value_type,v.daily_aggregation_method,v.calculation
    from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id
    where d.id=$1 returning id`,[ratio.id])).rows[0].id;
  await client.query('update training_load.metric_definitions set current_version_id=$2 where id=$1',[ratio.id,historical]);
  await importAt(5093,'2026-09-16');
  const same=await query('ratio','cohort',{}, {dateTo:'2026-09-16'});assert.equal(same.status,'ok',JSON.stringify(same));
  await version([world.gpexe_power_zone_25_60_distance.variableId,world.gpexe_time_min.variableId]);await importAt(5094,'2026-09-17');
  const changed=await query('max','day',{}, {dateTo:'2026-09-17'});assert.equal(changed.error,'calculation_changed_in_period');
  const compared=await query('ratio','cohort',{comparisonPeriod:'previous_period'},{dateFrom:'2026-09-17',dateTo:'2026-09-17'});assert.equal(compared.error,'calculation_changed_in_period');
});

test('identical ratio widgets share a bounded database query and one bad series leaves others intact',async()=>{
  let queries=0;const spec={widgetId:'w',seriesId:'s',metricDefinitionId:ratio.id,dataScopeLevel:'session',aggregationRolePolicy:'all_including_derived',sourcePolicy:'all_with_conflicts',groupBy:'cohort',analyticalAggregation:'ratio'};
  const results=await run({dataWorkspaceType:'team',dataWorkspaceScopeId:org.teamId,dateFrom:'2026-09-14',dateTo:'2026-09-14'},[{...spec},{...spec,seriesId:'s2'},{...spec,seriesId:'invalid',analyticalAggregation:'sum'}],{queryRunner:(sql,params)=>{if(sql.includes('jsonb_to_recordset'))queries++;return client.query(sql,params);}});
  assert.equal(queries,1);assert.equal(results[0].status,'ok');assert.equal(results[1].status,'ok');assert.equal(results[2].error,'aggregation_not_allowed');
});

test('athlete and source filters narrow both values and counts; missing activity cannot widen scope',async()=>{
  await assert.rejects(queryRatioBuckets((sql,params)=>client.query(sql,params), [], ratio.id, 'ratio', crypto.randomUUID()), /Ratio definition changed during query/);
  const one=await query('ratio','cohort',{athleteIds:[org.athleteIds[0]]});assert.equal(one.status,'ok',JSON.stringify(one));assert.equal(one.data.current[0].value,10);assert.deepEqual(one.coverage,{includedOccasions:1,leftOutOccasions:0});
  for(const extra of [{sourcePolicy:'manual'},{activityId:crypto.randomUUID()},{componentId:crypto.randomUUID()},{sourcePolicy:'source_connection',sourceConnectionId:crypto.randomUUID()}]){
    const empty=await query('ratio','day',extra);assert.equal(empty.status,'ok',JSON.stringify(empty));assert.deepEqual(empty.data.current,[]);assert.deepEqual(empty.coverage,{includedOccasions:0,leftOutOccasions:0});
  }
});

test('a valid ratio template clones without changing aggregation or policy',async()=>{
  const made=await api('/api/training-load/dashboards',{name:'Ratio template',isTemplate:true});assert.equal(made.status,201,JSON.stringify(made));const id=made.body.dashboard.id;
  const widget=await api('/api/training-load/dashboards/'+id+'/widgets',{expectedDashboardRevision:made.body.dashboard.revision,widgetType:'table',title:'Template ratio',groupBy:'cohort',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0});assert.equal(widget.status,201,JSON.stringify(widget));
  const added=await api('/api/training-load/dashboards/'+id+'/widgets/'+widget.body.widgetId+'/series',{expectedWidgetRevision:1,seriesOrder:0,metricDefinitionId:ratio.id,dataScopeLevel:'session',analyticalAggregation:'ratio',aggregationRolePolicy:'all_including_derived'});assert.equal(added.status,201,JSON.stringify(added));
  const clone=await api('/api/training-load/dashboards/'+id+'/clone',{ownerScope:'user',isTemplate:false});assert.equal(clone.status,201,JSON.stringify(clone));
  const detail=await api('/api/training-load/dashboards/'+clone.body.dashboard.id);assert.equal(detail.status,200,JSON.stringify(detail));
  const series=detail.body.widgets[0].series[0];assert.equal(series.resolution_status,'resolved');assert.equal(series.metric_definition_id,ratio.id);assert.equal(series.analytical_aggregation,'ratio');assert.equal(series.aggregation_role_policy,'all_including_derived');
});

test('two sources on one ratio target are conflicts, never pooled or selected',async()=>{
  await client.query('begin');
  try {
    const original=(await client.query(`select r.computed_by_ref,o.id,p.athlete_id,e.source_connection_id,l.activity_id,pl.activity_participant_id
      from training_load.metric_values r join training_load.metric_measurement_occasions o on o.id=r.occasion_id
      join training_load.metric_event_participants p on p.id=o.event_participant_id join training_load.metric_events e on e.id=p.event_id
      join training.activity_metric_event_links l on l.metric_event_id=e.id and l.link_status='confirmed'
      join training.activity_participant_metric_participant_links pl on pl.metric_event_participant_id=p.id and pl.link_status='confirmed'
      where r.metric_definition_id=$1 and e.occurred_date='2026-09-14' and o.segment_id is null and p.athlete_id=$2 limit 1`,[ratio.id,org.athleteIds[0]])).rows[0];
    await client.query('update training_load.metric_definitions set current_version_id=$2 where id=$1',[ratio.id,original.computed_by_ref.formulaVersionId]);
    const connection=(await client.query("insert into training_load.metric_source_connections(source_system,owner_scope,owner_team_id) values('test-import','team',$1) returning id",[org.teamId])).rows[0].id;
    const event=(await client.query("insert into training_load.metric_events(event_name,occurred_date,occurred_instant,scope_level,owner_scope,owner_team_id,source_connection_id,created_by_user_id) values('Second source','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,$3) returning id",[org.teamId,connection,org.userId])).rows[0].id;
    const participant=(await client.query("insert into training_load.metric_event_participants(event_id,athlete_id,athlete_timezone_snapshot) values($1,$2,'UTC') returning id",[event,original.athlete_id])).rows[0].id;
    await client.query("insert into training.activity_metric_event_links(activity_id,metric_event_id,link_method,link_status) values($1,$2,'manual','confirmed')",[original.activity_id,event]);
    await client.query("insert into training.activity_participant_metric_participant_links(activity_participant_id,metric_event_participant_id,link_method,link_status) values($1,$2,'manual','confirmed')",[original.activity_participant_id,participant]);
    const occasion=(await client.query("insert into training_load.metric_measurement_occasions(event_participant_id,entry_method) values($1,'manual') returning id",[participant])).rows[0].id;
    await client.query(`insert into training_load.metric_values(occasion_id,metric_definition_id,metric_definition_version_id,value_numeric,unit_at_capture,is_derived,aggregation_role,coverage)
      select $1,metric_definition_id,metric_definition_version_id,case when metric_definition_id=$3 then value_numeric*2 else value_numeric end,unit_at_capture,false,'standalone','not_applicable' from training_load.metric_values where occasion_id=$2 and not is_derived and value_numeric is not null`,[occasion,original.id,world.gpexe_total_distance.variableId]);
    const {writeCalculatedValues}=await import('../src/calculatedValues.js');await writeCalculatedValues(client,{occasionId:occasion,level:'full',ownerTeamId:org.teamId});
    const stored=(await client.query('select value_numeric::float8 as value from training_load.metric_values where occasion_id=$1 and metric_definition_id=$2',[occasion,ratio.id])).rows[0];assert.ok(stored,'second source has a real stored ratio');
    for(const agg of ['ratio','max','last']){
      const r=await query(agg);assert.equal(r.status,'ok',JSON.stringify(r));assert.equal(r.data.current.length,1);assert.equal(r.data.current[0].conflict,true);assert.equal(r.data.current[0].value,null);assert.deepEqual(r.coverage,{includedOccasions:2,leftOutOccasions:0});
    }
    const none=await query('none','athlete');assert.equal(none.data.current.find(r=>r.athleteId===org.athleteIds[0]).conflict,true);
    const single=await query('ratio','cohort',{athleteIds:[org.athleteIds[0]]});assert.equal(single.data.current[0].conflict,true);assert.deepEqual(single.coverage,{includedOccasions:0,leftOutOccasions:0});
    const selected=await query('ratio','cohort',{sourcePolicy:'source_connection',sourceConnectionId:connection});assert.equal(selected.data.current[0].value,stored.value);assert.deepEqual(selected.coverage,{includedOccasions:1,leftOutOccasions:0});
  } finally {await client.query('rollback');}
});


const reviewSpec=()=>({widgetId:'w',seriesId:'s',metricDefinitionId:ratio.id,dataScopeLevel:'session',aggregationRolePolicy:'all_including_derived',sourcePolicy:'all_with_conflicts',groupBy:'cohort',analyticalAggregation:'ratio'});
test('athlete workspace returns seriesQueryFailed with no row',async()=>{
  const [athlete]=await run({dataWorkspaceType:'athlete',athleteWorkspaceAthleteId:org.athleteIds[0],dateFrom:'2026-09-14',dateTo:'2026-09-14'},[reviewSpec()],{queryRunner:(sql,params)=>client.query(sql,params)});
  assert.deepEqual(athlete,{widgetId:'w',seriesId:'s',status:'error',error:'seriesQueryFailed'});
});
test('ratio cache separates widgets differing only by groupBy',async()=>{
  const spec=reviewSpec();const results=await run({dataWorkspaceType:'team',dataWorkspaceScopeId:org.teamId,dateFrom:'2026-09-14',dateTo:'2026-09-14'},[spec,{...spec,widgetId:'w2',seriesId:'s2',groupBy:'athlete'}],{queryRunner:(sql,params)=>client.query(sql,params)});
  assert.equal(results[0].data.current.length,1);assert.equal(results[0].data.current[0].athleteId,null);assert.equal(results[1].data.current.length,3);assert.deepEqual(new Set(results[1].data.current.map(r=>r.athleteId)),new Set(org.athleteIds));
});
test('ratio query casts scale to integer before min aggregation',async()=>{
  let checked=false;
  const [result]=await run({dataWorkspaceType:'team',dataWorkspaceScopeId:org.teamId,dateFrom:'2026-09-14',dateTo:'2026-09-14'},[reviewSpec()],{queryRunner:(sql,params)=>{if(sql.includes('jsonb_to_recordset')){checked=true;assert.match(sql,/min\(\(calculation->>'scale'\)::int\)/);}return client.query(sql,params);}});
  assert.equal(checked,true);assert.equal(result.status,'ok');
});
