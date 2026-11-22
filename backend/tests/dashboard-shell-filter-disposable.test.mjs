import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { startDashboardShellFixture } from './support/dashboard-shell-fixture.mjs';
import { draft } from './fixtures/dashboard-simple/contracts.mjs';
let world, db, actor, foreignAthlete;
const empty = () => ({ clubIds: [], teamIds: [], athleteIds: [] });
const shell = (kind, ids) => ({ ...empty(), [kind]: ids });
const period = { dateFrom: '2026-11-01', dateTo: '2026-11-07', timeZone: 'UTC' };
async function api(path, body, method = 'POST') {
  const r = await fetch(world.baseUrl + path, { method, headers: { Cookie: `optimove_session=${actor.sessionToken}`, 'Content-Type': 'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const text = await r.text(); return { status: r.status, text, body: JSON.parse(text), headers:Object.fromEntries([...r.headers].filter(([key])=>!['date','connection','keep-alive','x-request-id'].includes(key))) };
}
async function workspace(type, scope = null) {
  await db.query('update public.user_workspace_preferences set workspace_type=$2,scope_id=$3 where user_id=$1', [actor.id, type, scope]);
}
async function dashboard() {
  const d = await api('/api/training-load/dashboards', { name: 'Shell fixture' }); assert.equal(d.status, 201, d.text);
  const id = d.body.dashboard.id;
  const w = await api(`/api/training-load/dashboards/${id}/widgets`, { expectedDashboardRevision: d.body.dashboard.revision, widgetType:'table',title:'Sessions',groupBy:'athlete',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0 }); assert.equal(w.status,201,w.text);
  const s = await api(`/api/training-load/dashboards/${id}/widgets/${w.body.widgetId}/series`, { expectedWidgetRevision:1, seriesOrder:0, builtInSeriesKey:'session_count',dataScopeLevel:'day',analyticalAggregation:'sum' }); assert.equal(s.status,201,s.text);
  return { id, widgetId:w.body.widgetId };
}
const read = (d, filter, extra={}) => api(`/api/training-load/dashboards/${d.id}/query`,{dateFrom:period.dateFrom,dateTo:period.dateTo,shellFilter:filter,...extra});
const rows = response => response.body.widgets.flatMap(w => w.series.flatMap(s => s.data?.current ?? []));
function assertEmptyOk(response) {
  assert.equal(response.status,200,response.text);
  assert.ok(response.body.widgets.length);
  for (const widget of response.body.widgets) {
    assert.ok(widget.series.length);
    for (const series of widget.series) {
      assert.equal(series.status,'ok',JSON.stringify(series));
      assert.deepEqual(series.data.current,[]);
    }
  }
}
async function activity(type, scopeId, athlete) {
  const a=(await db.query(`insert into training.activities(activity_type_key,name,occurred_local_date,started_at,timezone_snapshot,owner_scope,owner_club_id,owner_team_id,owner_user_id,origin,lifecycle_state,created_by_user_id)
    values('training_session','Shell session','2026-11-03','2026-11-03T10:00:00Z','UTC',$1,$2,$3,$4,'manual','confirmed',$5) returning id`,[type,type==='club'?scopeId:null,type==='team'?scopeId:null,type==='user'?scopeId:null,actor.id])).rows[0].id;
  await db.query("insert into training.activity_participants(activity_id,athlete_id,local_date,timezone_snapshot,participation_status) values($1,$2,'2026-11-03','UTC','participated')",[a,athlete]);
}
before(async()=>{
  Object.assign(process.env,{DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'2',DASHBOARD_SIMPLE_KEY_ID:'shell-test',DASHBOARD_SIMPLE_KEY_BASE64:crypto.randomBytes(32).toString('base64')});
  world=await startDashboardShellFixture();db=new pg.Client({connectionString:world.databaseUrl});await db.connect();actor=world.accounts.find(a=>a.role==='platform_admin');
  foreignAthlete=(await db.query("insert into public.athletes(athlete_id,first_name,last_name,full_name,display_name) values('shell-other','Other','Example','Other Example','Other Example') returning id")).rows[0].id;
  await db.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status) values($1,$2,null,'club','active'),($1,$2,$3,'team','active')",[foreignAthlete,world.ids.clubB,world.ids.teamB]);
  await db.query("insert into public.user_club_roles(user_id,club_id,role,is_active) values($1,$2,'club_admin',true)",[actor.id,world.ids.clubA]);
  await db.query("insert into public.user_team_roles(user_id,team_id,role,is_active) values($1,$2,'team_coach',true)",[actor.id,world.ids.teamA]);
  await db.query("insert into public.user_global_roles(user_id,role,is_active) values($1,'independent_coach',true)",[actor.id]);
  await db.query("insert into public.user_athletes(user_id,athlete_id,is_active) values($1,$2,true)",[actor.id,world.ids.athleteIds[0]]);
  for(const [kind,owner] of [['club',world.ids.clubA],['team',world.ids.teamA],['user',actor.id]])for(const athlete of [world.ids.athleteIds[0],foreignAthlete])await activity(kind,owner,athlete);
  await activity('club',world.ids.clubB,foreignAthlete);
  await activity('club',world.ids.clubB,world.ids.athleteIds[0]);
});
after(async()=>{await db?.end();await world?.stop();});

for(const type of ['platform','club','team','private_coach','athlete'])test(`${type}: union and foreign/missing IDs stay inside the active workspace`,async()=>{
  const pa=world.accounts.find(a=>a.role==='platform_admin'); actor=type==='athlete'?world.accounts.find(a=>a.role==='athlete'):pa;
  const scope=type==='club'?world.ids.clubA:type==='team'?world.ids.teamA:null;await workspace(type,scope);const d=await dashboard();
  const own=await read(d,shell('athleteIds',[world.ids.athleteIds[0]]));assert.equal(own.status,200,own.text);assert.ok(rows(own).length);assert.ok(rows(own).every(r=>r.athleteId===world.ids.athleteIds[0]));assert.equal(rows(own)[0].value,['platform','athlete'].includes(type)?4:1);
  for(const [kind,foreign] of [['clubIds',world.ids.clubB],['teamIds',world.ids.teamB],['athleteIds',foreignAthlete]]){
    const unavailable=await read(d,shell(kind,[crypto.randomUUID()]));assert.equal(unavailable.status,200);assertEmptyOk(unavailable);
    if(type!=='platform') {const hidden=await read(d,shell(kind,[foreign]));assert.equal(hidden.text,unavailable.text);assert.deepEqual(hidden.headers,unavailable.headers);}
    const mixed=await read(d,{...shell(kind,[type==='platform'?crypto.randomUUID():foreign]),athleteIds:[world.ids.athleteIds[0]]});assert.deepEqual(rows(mixed),rows(own));
  }
  const groups=await read(d,{clubIds:[world.ids.clubA],teamIds:[world.ids.teamA],athleteIds:[]});
  if(['private_coach','athlete'].includes(type))assertEmptyOk(groups);else assert.ok(rows(groups).some(r=>r.athleteId===world.ids.athleteIds[0]));
  assertEmptyOk(await read(d,empty()));
});

test('shell ONLY narrows existing dashboard facts, widget overrides cannot replace it',async()=>{
  actor=world.accounts.find(a=>a.role==='platform_admin');await workspace('club',world.ids.clubA);const d=await dashboard();
  assertEmptyOk(await read(d,shell('athleteIds',[foreignAthlete])));
  const base=await read(d,null);assert.ok(rows(base).length);
  const constrained=await read(d,shell('athleteIds',[world.ids.athleteIds[0]]));assert.ok(rows(constrained).every(r=>r.athleteId===world.ids.athleteIds[0]));
  const detail=await api(`/api/training-load/dashboards/${d.id}`,null,'GET');const w=detail.body.widgets[0];
  const patch=await api(`/api/training-load/dashboards/${d.id}/widgets/${w.id}`,{expectedWidgetRevision:w.revision,localFilterOverride:{athleteIds:[foreignAthlete]}},'PATCH');assert.equal(patch.status,200,patch.text);
  assertEmptyOk(await read(d,shell('athleteIds',[world.ids.athleteIds[0]])));
});

test('query/preview combined limit and unknown nested fields have size parity',async()=>{
  actor=world.accounts.find(a=>a.role==='platform_admin');await workspace('platform');const d=await dashboard();
  const input={contractVersion:1,context:{kind:'legacyDashboard',period},draftRef:{draftId:draft().draftId,draftVersion:1},draft:{...draft(),title:'Shell',view:{type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'},metricRef:{kind:'builtin',key:'session_count'}},editTarget:null};
  for(const n of [200,201]) {
    const filter={clubIds:Array.from({length:70},()=>crypto.randomUUID()),teamIds:Array.from({length:70},()=>crypto.randomUUID()),athleteIds:Array.from({length:n-140},()=>crypto.randomUUID())};
    const q=await read(d,filter),p=await api(`/api/training-load/dashboards/${d.id}/simple/preview`,{...input,context:{...input.context,shellFilter:filter}});
    assert.equal(q.status,n===200?200:400,q.text);assert.equal(p.status,n===200?200:400,p.text);if(n>200)assert.equal(p.body.error,'invalidRequest');
  }
  for(const invalid of [{...empty(),hidden:true},{clubIds:[],teamIds:[]},{...empty(),athleteIds:['invalid']}]){assert.equal((await read(d,invalid)).status,400);assert.equal((await api(`/api/training-load/dashboards/${d.id}/simple/preview`,{...input,context:{...input.context,shellFilter:invalid}})).status,400);}
});

test('a shell change invalidates the preview/token; saving never persists shell scope',async()=>{
  actor=world.accounts.find(a=>a.role==='platform_admin');await workspace('platform');const d=await dashboard();
  const input={contractVersion:1,context:{kind:'legacyDashboard',period,shellFilter:shell('athleteIds',[world.ids.athleteIds[0]])},draftRef:{draftId:draft().draftId,draftVersion:1},draft:{...draft(),title:'Saved shell',view:{type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'},metricRef:{kind:'builtin',key:'session_count'}},editTarget:null};
  const p=await api(`/api/training-load/dashboards/${d.id}/simple/preview`,input);assert.equal(p.status,200,p.text);assert.equal(p.body.status,'valid',p.text);assert.ok(p.body.widgetResult.series[0].data.current.every(row=>row.athleteId===world.ids.athleteIds[0]));assert.equal(p.body.widgetResult.series[0].data.current.length,1);
  const saveBody={requestId:crypto.randomUUID(),requestIssuedAt:p.body.requestIssuedAt,resolvedPeriod:p.body.resolvedPeriod,previewToken:p.body.previewToken,input};
  const changed=structuredClone(saveBody);changed.requestId=crypto.randomUUID();changed.input.context.shellFilter={...input.context.shellFilter,clubIds:[crypto.randomUUID()]};
  const refusal=await api(`/api/training-load/dashboards/${d.id}/simple/widgets`,changed);assert.equal(refusal.status,409,refusal.text);assert.equal(refusal.body.error,'previewRequired');
  const saved=await api(`/api/training-load/dashboards/${d.id}/simple/widgets`,saveBody);assert.equal(saved.status,200,saved.text);
  const before=await db.query('select default_filter from training_load.dashboards where id=$1',[d.id]);
  const stored=(await db.query('select widget_type,title,group_by,display_config,presentation_config,local_filter_override from training_load.dashboard_widgets where id=$1',[saved.body.widgetId])).rows[0];
  const plainInput={...input,context:{kind:'legacyDashboard',period}};const plain=await api(`/api/training-load/dashboards/${d.id}/simple/preview`,plainInput);assert.equal(plain.body.status,'valid',plain.text);
  const plainSaved=await api(`/api/training-load/dashboards/${d.id}/simple/widgets`,{requestId:crypto.randomUUID(),requestIssuedAt:plain.body.requestIssuedAt,resolvedPeriod:plain.body.resolvedPeriod,previewToken:plain.body.previewToken,input:plainInput});assert.equal(plainSaved.status,200,plainSaved.text);
  const plainStored=(await db.query('select widget_type,title,group_by,display_config,presentation_config,local_filter_override from training_load.dashboard_widgets where id=$1',[plainSaved.body.widgetId])).rows[0];assert.equal(JSON.stringify(stored),JSON.stringify(plainStored));assert.deepEqual(before.rows,(await db.query('select default_filter from training_load.dashboards where id=$1',[d.id])).rows);
  assert.equal((await api(`/api/training-load/dashboards/${d.id}/simple/widgets`,saveBody)).body.widgetId,saved.body.widgetId);
});

test('current active membership changes a historical shell result; legacy runtime semantics stay independent',async()=>{
  actor=world.accounts.find(a=>a.role==='platform_admin');await workspace('club',world.ids.clubA);const d=await dashboard();
  const own=world.ids.athleteIds[0];assert.ok(rows(await read(d,shell('athleteIds',[own]))).length);
  await db.query("update public.athlete_memberships set status='paused' where athlete_id=$1 and membership_type='club' and club_id=$2",[own,world.ids.clubA]);
  try {assertEmptyOk(await read(d,shell('athleteIds',[own])));} finally {await db.query("update public.athlete_memberships set status='active' where athlete_id=$1 and membership_type='club' and club_id=$2",[own,world.ids.clubA]);}
  const changed=await api(`/api/training-load/dashboards/${d.id}`,{expectedRevision:(await api(`/api/training-load/dashboards/${d.id}`,null,'GET')).body.dashboard.revision,defaultFilter:{athleteIds:[foreignAthlete]}},'PATCH');assert.equal(changed.status,200,changed.text);
  assertEmptyOk(await read(d,shell('athleteIds',[own])));
  assert.ok(rows(await read(d,shell('athleteIds',[own]),{athleteIds:null})).length,'legacy null clears saved default before shell');
  assert.ok(rows(await read(d,shell('athleteIds',[own]),{athleteIds:[]})).length);
  assertEmptyOk(await read(d,shell('athleteIds',[own]),{athleteIds:[foreignAthlete]}));
});
