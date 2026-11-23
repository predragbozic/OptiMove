import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
import {createPageService} from '../src/dashboardPages/service.js';
import {validPageWidgetBody} from '../src/dashboardPages/widgetValidation.js';
let db,q,pool,user,req;
before(async()=>{
 db=await createPagesDatabase({through:'202611231100',label:'pages_concurrency'});q=db.client;pool=new pg.Pool({connectionString:db.url,max:6});
 user=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('page-race@test.invalid','Page','Race','Page Race','Page Race') returning id")).rows[0].id;
 await q.query("insert into public.user_global_roles(user_id,role,is_active) values($1,'platform_admin',true)",[user]);
 await q.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)",[user]);
 await q.query('update training_load.dashboard_pages_activation set enabled=true');req={user:{id:user},app:{locals:{dashboardSimpleMode:'off'}}};
});
after(async()=>{await pool?.end();await db?.drop()});
const service=()=>createPageService({pool,validateWidgetBody:validPageWidgetBody});
async function setup(){
 const d=(await q.query("select * from training_load.create_dashboard('Race',null,'user',$1,null,null,'platform',null,false,$1,null)",[user])).rows[0];
 const home=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1 and is_home',[d.id])).rows[0];
 const receipt=(await q.query("select training_load.mutate_dashboard_page($1,$2,'{}',$3,$4,1,'create',null,'{\"name\":\"Second\"}',date_trunc('milliseconds',clock_timestamp())) receipt",[d.id,user,crypto.randomUUID(),'a'.repeat(64)])).rows[0].receipt;
 const body={expectedPageRevision:home.revision,widgetType:'table',title:'Race widget',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0,groupBy:'athlete'};
 const created=await service().writeWidget({req,dashboardId:d.id,pageId:home.id,operation:'create',body});
 return{dashboardId:d.id,pageId:home.id,otherPageId:receipt.pageId,widgetId:created.widgetId};
}
function oneStale(results){assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failed=results.find(r=>r.status==='rejected');assert.ok(failed);assert.equal(failed.reason.code,'40001');}
test('two content/layout writers with one widget revision give one success and one stale refusal',async()=>{
 const target=await setup(),api=service();
 const before=(await q.query('select revision from training_load.dashboard_pages where id=$1',[target.pageId])).rows[0].revision;
 const results=await Promise.allSettled([
 api.writeWidget({...target,req,operation:'content',body:{expectedWidgetRevision:1,title:'Content won'}}),
 api.writeWidget({...target,req,operation:'widgetLayout',body:{expectedWidgetRevision:1,y:2}})
 ]);oneStale(results);
 assert.equal((await q.query('select revision from training_load.dashboard_pages where id=$1',[target.pageId])).rows[0].revision,before+1);
});
test('two whole-Page layouts with one Page revision give one success and one stale refusal',async()=>{
 const target=await setup(),api=service();const revision=(await q.query('select revision from training_load.dashboard_pages where id=$1',[target.pageId])).rows[0].revision;
 const payload=y=>({...target,req,operation:'layout',body:{expectedPageRevision:revision,layout:[{widgetId:target.widgetId,x:0,y,width:6,height:4,mobileOrder:0}]}});
 oneStale(await Promise.allSettled([api.writeWidget(payload(2)),api.writeWidget(payload(3))]));
});
test('opposite Page copies finish without deadlock and preserve both source widgets',async()=>{
 const target=await setup(),api=service();
 const second=await api.writeWidget({...target,req,pageId:target.otherPageId,operation:'create',widgetId:null,body:{expectedPageRevision:1,widgetType:'table',title:'Other source',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0}});
 const pages=(await q.query('select id,revision from training_load.dashboard_pages where dashboard_id=$1',[target.dashboardId])).rows;const revisions=new Map(pages.map(p=>[p.id,p.revision]));
 const copy=(sourcePage,widgetId,destination)=>api.copy({req,dashboardId:target.dashboardId,pageId:sourcePage,widgetId,body:{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId:destination,expectedWidgetRevision:1,expectedPageRevision:revisions.get(destination)}});
 const results=await Promise.all([copy(target.pageId,target.widgetId,target.otherPageId),copy(target.otherPageId,second.widgetId,target.pageId)]);assert.equal(new Set(results.map(r=>r.receipt.widgetId)).size,2);
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_widgets where dashboard_id=$1',[target.dashboardId])).rows[0].n,4);
});
test('recorded SQL acquires dashboard → Pages → widget → series before content write',async()=>{
 const target=await setup(),statements=[];
 const recordedPool={async connect(){const c=await pool.connect();return{query(sql,args){statements.push(sql);return c.query(sql,args)},release(){c.release()}}}};
 const api=createPageService({pool:recordedPool,validateWidgetBody:validPageWidgetBody});
 await api.writeWidget({...target,req,operation:'content',body:{expectedWidgetRevision:1,title:'Recorded'}});
 const index=pattern=>statements.findIndex(sql=>pattern.test(sql));
 const d=index(/from training_load\.dashboards where id=\$1 for update/),p=index(/from training_load\.dashboard_pages.*order by id for update/),w=index(/from training_load\.dashboard_widgets.*for update/),s=index(/from training_load\.dashboard_widget_series.*for update/),write=index(/select training_load\.write_dashboard_page_widget/);
 assert.ok(d>=0&&d<p&&p<w&&w<s&&s<write,JSON.stringify(statements));
 assert.equal(statements.slice(write+1).some(sql=>/\bfor (share|update)\b/i.test(sql)),false);assert.equal(statements.at(-1),'commit');
});

test('simultaneous retries of one copy return one receipt and one copied widget',async()=>{
 const target=await setup(),api=service();const page=(await q.query('select revision from training_load.dashboard_pages where id=$1',[target.otherPageId])).rows[0];
 const args={req,dashboardId:target.dashboardId,pageId:target.pageId,widgetId:target.widgetId,body:{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId:target.otherPageId,expectedWidgetRevision:1,expectedPageRevision:page.revision}};
 const [a,b]=await Promise.all([api.copy(args),api.copy(args)]);assert.deepEqual(a,b);
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_widgets where page_id=$1',[target.otherPageId])).rows[0].n,1);
});
test('deactivation that holds the actor lock wins before a waiting Page write',async()=>{
 const target=await setup(),locker=await pool.connect();let writing;
 try{await locker.query('begin');await locker.query('select id from public.users where id=$1 for update',[user]);await locker.query('update public.users set is_active=false where id=$1',[user]);
  writing=service().writeWidget({...target,req,operation:'content',body:{expectedWidgetRevision:1,title:'Must not write'}}).then(value=>({value}),error=>({error}));
  const deadline=Date.now()+1500;let waiting=false;
  while(Date.now()<deadline){waiting=Number((await q.query("select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select id from public.users%'")).rows[0].n)>0;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(waiting,true,'Page writer waits for the user lock before reading live authority');
  await locker.query('commit');const result=await writing;assert.equal(result.error?.httpStatus,404);
  assert.equal((await q.query('select revision from training_load.dashboard_widgets where id=$1',[target.widgetId])).rows[0].revision,1);
 }finally{await locker.query('rollback');locker.release();await writing;await q.query('update public.users set is_active=true where id=$1',[user])}
});
