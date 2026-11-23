import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
import {previousDashboardServer} from './support/dashboard-pages-old-server.mjs';
import {createSession} from '../src/auth.js';
import {draft} from './fixtures/dashboard-simple/contracts.mjs';
let db,q,old,user,session;
async function api(path,body,method='POST'){
 const response=await fetch(old.baseUrl+path,{method,headers:{Cookie:`optimove_session=${session}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const text=await response.text();return{status:response.status,text,body:JSON.parse(text)};
}
async function dashboard(name,options={}){const r=await api('/api/training-load/dashboards',{name,...options});assert.equal(r.status,201,r.text);return r.body.dashboard;}
async function widget(d){const r=await api(`/api/training-load/dashboards/${d.id}/widgets`,{expectedDashboardRevision:d.revision,widgetType:'table',title:'Legacy widget',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0,groupBy:'athlete'});assert.equal(r.status,201,r.text);const id=r.body.widgetId;
 const s=await api(`/api/training-load/dashboards/${d.id}/widgets/${id}/series`,{expectedWidgetRevision:1,seriesOrder:0,builtInSeriesKey:'session_count',dataScopeLevel:'day',analyticalAggregation:'sum'});assert.equal(s.status,201,s.text);return id;}
const detail=async id=>{const r=await api(`/api/training-load/dashboards/${id}`,null,'GET');assert.equal(r.status,200,r.text);return r.body;};
async function prepareSimple(d,title){const value=draft();value.title=title;value.metricRef={kind:'builtin',key:'session_count'};value.view={type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'};
 const input={contractVersion:1,context:{kind:'legacyDashboard',period:{dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'}},draftRef:{draftId:value.draftId,draftVersion:value.draftVersion},draft:value,editTarget:null};
 const preview=await api(`/api/training-load/dashboards/${d.id}/simple/preview`,input);assert.equal(preview.status,200,preview.text);assert.equal(preview.body.status,'valid',preview.text);
 return{requestId:crypto.randomUUID(),requestIssuedAt:preview.body.requestIssuedAt,resolvedPeriod:preview.body.resolvedPeriod,previewToken:preview.body.previewToken,input};}
before(async()=>{
 db=await createPagesDatabase({label:'pages_previous_build'});q=db.client;
 user=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('previous-pages@test.invalid','Previous','Build','Previous Build','Previous Build') returning id")).rows[0].id;
 await q.query("insert into public.user_global_roles(user_id,role,is_active) values($1,'platform_admin',true)",[user]);
 await q.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)",[user]);
 session=await createSession(user,q);
 old=await previousDashboardServer(db.url,{DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'1',DASHBOARD_SIMPLE_KEY_ID:'old-build-rehearsal',DASHBOARD_SIMPLE_KEY_BASE64:crypto.randomBytes(32).toString('base64'),DASHBOARD_PAGES_ENABLED:'false'});
 console.log('Previous build under test:',old.commit);
});
after(async()=>{await old?.stop();await db?.drop()});
for(const [stage,boundary] of [['v90','202611231000'],['v91','202611231100']])test(`previous build seven flows against ${stage}`,async t=>{
 const stable=await dashboard(stage+' stable');await widget(stable);
 const before=await detail(stable.id);
 const beforeQuery=await api(`/api/training-load/dashboards/${stable.id}/query`,{dateFrom:'2026-11-01',dateTo:'2026-11-07'});assert.equal(beforeQuery.status,200,beforeQuery.text);
 const simple=await dashboard(stage+' Simple');const savedBody=await prepareSimple(simple,'Already saved');
 const already=await api(`/api/training-load/dashboards/${simple.id}/simple/widgets`,savedBody);assert.equal(already.status,200,already.text);
 const storedBefore=(await q.query('select receipt::text receipt from training_load.dashboard_simple_requests where initiator_user_id=$1 and request_id=$2',[user,savedBody.requestId])).rows[0].receipt;
 const pending=await prepareSimple(simple,'Preview before migration');
 await db.applyThrough(boundary);
 let fresh,w;
 await t.test('1. old create-dashboard gets exactly one Home from the database',async()=>{
  fresh=await dashboard(stage+' new');const homes=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1',[fresh.id])).rows;assert.equal(homes.length,1);assert.equal(homes[0].is_home,true);
 });
 await t.test('2. old widget insert without page_id lands on Home',async()=>{
  w=await widget(fresh);const row=(await q.query('select p.is_home from training_load.dashboard_widgets w join training_load.dashboard_pages p on p.id=w.page_id where w.id=$1',[w])).rows[0];assert.equal(row.is_home,true);
 });
 await t.test('3. old layout revision sequence succeeds and refuses the stale request',async()=>{
  const read=await detail(fresh.id);const body={expectedRevision:read.dashboard.revision,layout:[{widgetId:w,x:0,y:2,width:6,height:4,mobileOrder:0}]};
  const result=await api(`/api/training-load/dashboards/${fresh.id}/layout`,body,'PUT');assert.equal(result.status,200,result.text);
  const stale=await api(`/api/training-load/dashboards/${fresh.id}/layout`,body,'PUT');assert.equal(stale.status,409,stale.text);
 });
 await t.test('4. old raw clone inserts preserve Home and default_filter',async()=>{
  const template=await dashboard(stage+' template',{isTemplate:true,defaultFilter:{athleteIds:[]}});await widget(template);
  const result=await api(`/api/training-load/dashboards/${template.id}/clone`,{name:stage+' old clone',ownerScope:'user'});assert.equal(result.status,201,result.text);
  const rows=(await q.query('select p.default_filter,p.is_home,count(w.id)::int widgets from training_load.dashboard_pages p left join training_load.dashboard_widgets w on w.page_id=p.id where p.dashboard_id=$1 group by p.id',[result.body.dashboard.id])).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].is_home,true);assert.deepEqual(rows[0].default_filter,{athleteIds:[]});assert.equal(rows[0].widgets,1);
 });
 await t.test('5. old v19 delete removes Home and leaves exactly one deletion log',async()=>{
  const read=await detail(fresh.id);const deleted=await api(`/api/training-load/dashboards/${fresh.id}`,{expectedRevision:read.dashboard.revision},'DELETE');assert.equal(deleted.status,200,deleted.text);
  assert.equal((await q.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[fresh.id])).rows[0].n,0);
  assert.equal((await q.query('select count(*)::int n from training_load.dashboard_deletion_log where dashboard_id=$1',[fresh.id])).rows[0].n,1);
 });
 await t.test('6. old receipt replay is byte-identical; an old preview token still saves and replays',async()=>{
  const replay=await api(`/api/training-load/dashboards/${simple.id}/simple/widgets`,savedBody);assert.equal(replay.status,200,replay.text);assert.equal(replay.body.widgetId,already.body.widgetId);assert.equal(replay.body.verification,'replayed');
  assert.equal((await q.query('select receipt::text receipt from training_load.dashboard_simple_requests where initiator_user_id=$1 and request_id=$2',[user,savedBody.requestId])).rows[0].receipt,storedBefore);
  const save=await api(`/api/training-load/dashboards/${simple.id}/simple/widgets`,pending);assert.equal(save.status,200,save.text);assert.equal(Object.hasOwn(save.body,'pageId'),false);
  const again=await api(`/api/training-load/dashboards/${simple.id}/simple/widgets`,pending);assert.equal(again.status,200,again.text);assert.equal(again.body.widgetId,save.body.widgetId);
 });
 await t.test('7. old frontend read/query returns the same widget IDs, layout and data',async()=>{
  assert.deepEqual((await detail(stable.id)).widgets,before.widgets);
  const query=await api(`/api/training-load/dashboards/${stable.id}/query`,{dateFrom:'2026-11-01',dateTo:'2026-11-07'});assert.equal(query.status,200,query.text);assert.deepEqual(query.body,beforeQuery.body);
  assert.equal((await q.query('select enabled from training_load.dashboard_pages_activation where singleton')).rows[0].enabled,false);
  await assert.rejects(q.query("insert into training_load.dashboard_pages(dashboard_id,name,position) values($1,'Forbidden second',1)",[stable.id]),e=>e.code==='23514'&&e.message==='dashboardPagesDisabled');
 });
});
