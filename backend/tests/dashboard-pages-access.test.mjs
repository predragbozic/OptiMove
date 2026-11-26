import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {runMigrations} from '../src/migrate.js';
import {startDashboardShellFixture} from './support/dashboard-shell-fixture.mjs';
let world,q,template,foreign;
async function api(actor,path,body,method='GET'){
 const r=await fetch(world.baseUrl+path,{method,headers:{...(actor?{Cookie:`optimove_session=${actor.sessionToken}`}:{}) ,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return{status:r.status,text:await r.text(),headers:Object.fromEntries([...r.headers].filter(([k])=>!['date','connection','keep-alive','x-request-id'].includes(k)))};
}
const request=input=>({requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:1,input});
before(async()=>{
 world=await startDashboardShellFixture({envOverrides:{DASHBOARD_PAGES_ENABLED:'true',DASHBOARD_SIMPLE_MODE:'off'}});q=new pg.Client({connectionString:world.databaseUrl});await q.connect();await q.query('update training_load.dashboard_pages_activation set enabled=true');
 const actor=world.accounts[0];const created=await api(actor,'/api/training-load/dashboards',{name:'Foreign private'},'POST');assert.equal(created.status,201,created.text);foreign=JSON.parse(created.text).dashboard;
 template=(await q.query("select * from training_load.create_dashboard('Shared template',null,'system',null,null,null,null,null,true,$1,null)",[actor.id])).rows[0];
});
after(async()=>{await q?.end();await world?.stop()});
for(const role of ['platform_admin','club_admin','team_coach','independent_coach','athlete'])test(`${role}: inherited own-dashboard Page access; foreign/missing parent identity hidden`,async()=>{
 const actor=world.accounts.find(a=>a.role===role);assert.ok(actor);
 const created=await api(actor,'/api/training-load/dashboards',{name:'Own '+role},'POST');assert.equal(created.status,201,created.text);const dashboard=JSON.parse(created.text).dashboard;
 const root=`/api/training-load/dashboards/${dashboard.id}/pages`;
 const pages=await api(actor,root);assert.equal(pages.status,200,pages.text);assert.equal(JSON.parse(pages.text).canManage,true);
 const added=await api(actor,root,request({name:'Second'}),'POST');assert.equal(added.status,200,added.text);
 const ownId=JSON.parse(added.text).receipt.pageId;
 const foreignPage=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[foreign.id])).rows[0].id;
 const a=await api(actor,root+'/'+foreignPage),b=await api(actor,root+'/'+crypto.randomUUID());assert.equal(a.status,404);assert.deepEqual(a,b);
 const data=await api(actor,root+'/'+ownId+'/query',{dateFrom:'2026-11-01',dateTo:'2026-11-07',shellFilter:{clubIds:[],teamIds:[],athleteIds:[]}},'POST');assert.equal(data.status,200,data.text);assert.deepEqual(JSON.parse(data.text).widgets,[]);
 if(role!=='platform_admin'){
  const invisible=await api(actor,`/api/training-load/dashboards/${foreign.id}/pages/${foreignPage}`),missing=await api(actor,`/api/training-load/dashboards/${crypto.randomUUID()}/pages/${crypto.randomUUID()}`);assert.equal(invisible.status,404);assert.deepEqual(invisible,missing);
  const shared=await api(actor,`/api/training-load/dashboards/${template.id}/pages`);assert.equal(shared.status,200,shared.text);assert.equal(JSON.parse(shared.text).canManage,false);
  const denied=await api(actor,`/api/training-load/dashboards/${template.id}/pages`,request({name:'Cannot manage'}),'POST');assert.equal(denied.status,404,denied.text);
  await q.query("update public.users set role_hint='platform_admin' where id=$1",[actor.id]);
  const hinted=await api(actor,`/api/training-load/dashboards/${foreign.id}/pages/${foreignPage}`);assert.equal(hinted.status,404,hinted.text);
 }
});
test('anonymous Page read and write use the existing router 401',async()=>{
 assert.equal((await api(null,`/api/training-load/dashboards/${foreign.id}/pages`)).status,401);
 assert.equal((await api(null,`/api/training-load/dashboards/${foreign.id}/pages`,request({name:'No session'}),'POST')).status,401);
});

test('Page router enumeration pins every mounted verb/path and closed configuration is default',async()=>{
 const {createPagesRouter,PAGE_ROUTE_MATRIX}=await import('../src/dashboardPages/router.js');
 const {pagesEnabled}=await import('../src/dashboardPages/config.js');
 assert.equal(pagesEnabled({}),false);assert.equal(pagesEnabled({DASHBOARD_PAGES_ENABLED:'false'}),false);assert.equal(pagesEnabled({DASHBOARD_PAGES_ENABLED:'true'}),true);assert.throws(()=>pagesEnabled({DASHBOARD_PAGES_ENABLED:'yes'}));
 const router=createPagesRouter({pool:{query(){throw Error('No database call allowed in route inventory')}}});
 const actual=router.stack.filter(layer=>layer.route).flatMap(layer=>Object.keys(layer.route.methods).map(method=>[method,layer.route.path]));
 const sort=rows=>rows.map(row=>row.join(' ')).sort();assert.deepEqual(sort(actual),sort(PAGE_ROUTE_MATRIX));assert.equal(actual.length,20);
});

test('feature off mounts no Page route, including every write and runtime query',async()=>{
 const closed=await startDashboardShellFixture({envOverrides:{DASHBOARD_PAGES_ENABLED:'false'}});
 try{
  const {PAGE_ROUTE_MATRIX}=await import('../src/dashboardPages/router.js');const actor=closed.accounts[0];
  const missing=await fetch(closed.baseUrl+'/api/training-load/route-that-does-not-exist',{headers:{Cookie:'optimove_session='+actor.sessionToken}});const text=await missing.text();assert.equal(missing.status,404);
  for(const [method,route] of PAGE_ROUTE_MATRIX){
   const path=route.replace(/:[A-Za-z]+/g,()=>crypto.randomUUID());
   const response=await fetch(closed.baseUrl+'/api/training-load/dashboards'+path,{method:method.toUpperCase(),headers:{Cookie:'optimove_session='+actor.sessionToken,'Content-Type':'application/json'},...(method==='get'?{}:{body:'{}'})});
   assert.equal(response.status,404,method+' '+route);assert.deepEqual(await response.json(),{...JSON.parse(text),path:'/api/training-load/dashboards'+path},method+' '+route);
  }
 }finally{await closed.stop()}
});

test('archived dashboards offer Page reading without editing controls and refuse writes',async()=>{
 const actor=world.accounts[0],created=await api(actor,'/api/training-load/dashboards',{name:'Archived Page controls'},'POST');assert.equal(created.status,201);const d=JSON.parse(created.text).dashboard;
 const page=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[d.id])).rows[0].id;await q.query("update training_load.dashboards set status='archived' where id=$1",[d.id]);
 const read=await api(actor,'/api/training-load/dashboards/'+d.id+'/pages/'+page);assert.equal(read.status,200,read.text);assert.equal(JSON.parse(read.text).canManage,false);
 const write=await api(actor,'/api/training-load/dashboards/'+d.id+'/pages',request({name:'No write'}),'POST');assert.equal(write.status,409,write.text);
});

const copyPath=(dashboard,page)=>`/api/training-load/dashboards/${dashboard.id}/pages/${page.id}/copy`;
async function pageSnapshot(dashboardId){
 return (await q.query(`select
  (select to_jsonb(d) from training_load.dashboards d where id=$1) dashboard,
  (select jsonb_agg(to_jsonb(p) order by p.id) from training_load.dashboard_pages p where dashboard_id=$1) pages,
  (select jsonb_agg(to_jsonb(w) order by w.id) from training_load.dashboard_widgets w where dashboard_id=$1) widgets,
  (select jsonb_agg(to_jsonb(s) order by s.id) from training_load.dashboard_widget_series s
    join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=$1) series,
  (select jsonb_agg(to_jsonb(r) order by r.request_id) from training_load.dashboard_page_requests r where dashboard_id=$1) receipts`,[dashboardId])).rows[0];
}
let copyFixture;
test('whole-page copy rejects foreign sources, read-only access and stale revisions without writes',async()=>{
 const actor=world.accounts[0];
 const viewer=world.accounts.find(a=>a.role==='club_admin');
 const created=await api(actor,'/api/training-load/dashboards',{name:'Copy rollback source'},'POST');
 assert.equal(created.status,201,created.text);
 const {dashboard}=JSON.parse(created.text);
 const added=await api(actor,`/api/training-load/dashboards/${dashboard.id}/widgets`,{
  expectedDashboardRevision:dashboard.revision,widgetType:'line_chart',title:'Daily sessions',
  widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0,groupBy:'day'
 },'POST');
 assert.equal(added.status,201,added.text);
 const {widgetId}=JSON.parse(added.text);
 const widget=(await q.query('select id,revision from training_load.dashboard_widgets where id=$1',[widgetId])).rows[0];
 const series=(await q.query("select * from training_load.add_series($1,$2,0,null,'session_count',null,'primary',null,null,'not_applicable',null,'day','sum')",[widget.id,widget.revision])).rows[0];
 const chartShape={schemaVersion:1,kind:'area',seriesIds:[series.series_id]};
 await q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',
  [widget.id,{schemaVersion:1,chartShape}]);
 const snapshot=await pageSnapshot(dashboard.id);
 const page=snapshot.pages[0];
 const input={name:'Copy test',sourceRevision:page.revision,widgetRevisions:{[widget.id]:snapshot.widgets[0].revision}};
 const make=(values=input)=>({...request(values),expectedPagesRevision:snapshot.dashboard.pages_revision});
 const outsider=(await pageSnapshot(foreign.id)).pages[0];
 const missing=await api(actor,copyPath(dashboard,{id:crypto.randomUUID()}),make(),'POST');
 const foreignSource=await api(actor,copyPath(dashboard,outsider),make(),'POST');
 assert.equal(missing.status,404);
 assert.deepEqual(foreignSource,missing);
 const protectedSnapshot=await pageSnapshot(template.id);
 const readOnly=await api(viewer,copyPath(template,protectedSnapshot.pages[0]),make(),'POST');
 assert.equal(readOnly.status,404);
 assert.deepEqual(await pageSnapshot(template.id),protectedSnapshot);
 for(const stale of [
  make({...input,sourceRevision:page.revision+1}),
  make({...input,widgetRevisions:{[widget.id]:snapshot.widgets[0].revision+1}}),
  {...make(),expectedPagesRevision:snapshot.dashboard.pages_revision+1}
 ]){
  const result=await api(actor,copyPath(dashboard,page),stale,'POST');
  assert.equal(result.status,409,result.text);
  assert.equal(JSON.parse(result.text).error,'staleRevision');
 }
 assert.deepEqual(await pageSnapshot(dashboard.id),snapshot);
 copyFixture={actor,dashboard,page,make,snapshot,sourceSeriesId:series.series_id};
});

test('whole-page copy rolls back destination, widgets, series and receipt after a late failure and remaps on retry',async()=>{
 const {actor,dashboard,page,make,snapshot,sourceSeriesId}=copyFixture;
 const body=make();
 await q.query(`create function training_load.test_reject_copy_after_series() returns trigger language plpgsql as $$
  begin
   if exists (select 1 from training_load.dashboard_widgets w
    join training_load.dashboard_pages p on p.id=w.page_id
    join training_load.dashboard_page_requests r on r.dashboard_id=p.dashboard_id and r.receipt->>'pageId'=p.id::text
    where w.id=new.widget_id and p.name='Copy test') then
     raise exception 'forced late failure' using errcode='S2C02';
   end if;
   return null;
  end;
 $$;
 create constraint trigger test_reject_copy_after_series after insert on training_load.dashboard_widget_series deferrable initially deferred
 for each row execute function training_load.test_reject_copy_after_series();`);
 try{
  const failure=await api(actor,copyPath(dashboard,page),body,'POST');
  assert.equal(failure.status,409,failure.text);
  assert.equal(JSON.parse(failure.text).error,'pageCopyConfigurationUnavailable');
  assert.deepEqual(await pageSnapshot(dashboard.id),snapshot);
 }finally{
  await q.query('drop trigger test_reject_copy_after_series on training_load.dashboard_widget_series; drop function training_load.test_reject_copy_after_series()');
 }
 const success=await api(actor,copyPath(dashboard,page),body,'POST');
 assert.equal(success.status,200,success.text);
 const {receipt}=JSON.parse(success.text);
 const final=await pageSnapshot(dashboard.id);
 const widget=final.widgets.find(row=>row.page_id===receipt.pageId);
 const series=final.series.find(row=>row.widget_id===widget.id);
 assert.notEqual(series.id,sourceSeriesId);
 assert.deepEqual(widget.presentation_config.chartShape.seriesIds,[series.id]);
 assert.equal(final.receipts.filter(row=>row.request_id===body.requestId).length,1);
 copyFixture.copied=final;
});

test('v100 rehearsal verifies the writer, rolls back without data loss, and reapplies it',async()=>{
 const {dashboard,copied}=copyFixture;
 const sql=kind=>readFile(new URL(`../../docs/runbooks/dashboard-page-copy-v100-${kind}.sql`,import.meta.url),'utf8');
 const assertChecks=async kind=>{
  const result=await q.query(await sql(kind));
  for(const [name,passed] of Object.entries(result.rows[0]))assert.equal(passed,true,name);
 };
 await assertChecks('postcheck');
 const competingRunner=new pg.Client({connectionString:world.databaseUrl});
 await competingRunner.connect();
 try{
  await competingRunner.query('select pg_advisory_lock(822026)');
  await assert.rejects(q.query(await sql('rollback')),/migration runner is active/);
 }finally{
  await q.query('rollback');
  await competingRunner.end();
 }
 await assertChecks('postcheck');
 await q.query(await sql('rollback'));
 assert.deepEqual(await pageSnapshot(dashboard.id),copied);
 await assertChecks('preflight');
 await runMigrations({databaseUrl:world.databaseUrl,migrationsRoot:fileURLToPath(new URL('../../migrations_v2/',import.meta.url))});
 await assertChecks('postcheck');
 assert.deepEqual(await pageSnapshot(dashboard.id),copied);
});
