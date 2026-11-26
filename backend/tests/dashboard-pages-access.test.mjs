import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
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
