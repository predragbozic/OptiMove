import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
let db,q,user,d,home,request;
const hash='a'.repeat(64);const issued=new Map();
async function mutate(operation,input={},pageId=null,requestId=crypto.randomUUID(),payloadHash=hash){
 if(!issued.has(requestId))issued.set(requestId,new Date().toISOString());
 const rev=(await q.query('select pages_revision from training_load.dashboards where id=$1',[d])).rows[0].pages_revision;
 return (await q.query('select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) receipt',[d,user,{type:'private_coach',scopeId:null},requestId,payloadHash,rev,operation,pageId,input,issued.get(requestId)])).rows[0].receipt;
}
before(async()=>{
 db=await createPagesDatabase({through:'202611231100',label:'page_writers'});q=db.client;
 user=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('pages-writer@test.invalid','Page','Writer','Page Writer','Page Writer') returning id")).rows[0].id;
 d=(await q.query("insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,created_by_user_id) values('Writer','user',$1,'private_coach',$1) returning id",[user])).rows[0].id;
 home=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[d])).rows[0].id;
});
after(async()=>{await db?.drop()});
test('Page writer is closed at the database before activation',async()=>{
 await assert.rejects(mutate('create',{name:'Closed'}),e=>e.code==='23514'&&e.message==='dashboardPagesDisabled');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_page_requests')).rows[0].n,0);
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
});
test('create and replay are atomic; changed input with same request refuses',async()=>{
 request=crypto.randomUUID();
 const result=await mutate('create',{name:'Performance'},null,request);
 assert.equal(result.operation,'create');assert.notEqual(result.pageId,home);
 assert.deepEqual(await mutate('create',{name:'Performance'},null,request),result);
 await assert.rejects(mutate('create',{name:'Other'},null,request,'b'.repeat(64)),e=>e.code==='S2C01');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[d])).rows[0].n,2);
});
test('name validation/duplicate and Home reorder/delete are refused in the database',async()=>{
 await assert.rejects(mutate('create',{name:'performance'}),e=>e.code==='23505');
 await assert.rejects(mutate('create',{name:'Bad\u200bName'}),e=>e.code==='23514');
 await assert.rejects(mutate('delete',{},home),e=>e.code==='23514');
 const pages=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1 order by position desc',[d])).rows.map(r=>r.id);
 await assert.rejects(mutate('reorder',{pageIds:pages}),e=>e.code==='22023');
});
test('young receipts cannot update, delete or truncate; bounded cleanup leaves them alone',async()=>{
 for(const sql of ['update training_load.dashboard_page_requests set receipt=\'{}\'::jsonb','delete from training_load.dashboard_page_requests','truncate training_load.dashboard_page_requests']){
  await assert.rejects(q.query(sql),e=>e.code==='23514'&&e.message==='dashboardPageReceiptImmutable');
 }
 assert.equal((await q.query('select training_load.cleanup_dashboard_page_requests(100) deleted')).rows[0].deleted,0);
});

test('Home default changes bump dashboard and Page/defaults once; an identical save is a no-op',async()=>{
 const before=(await q.query('select * from training_load.dashboard_pages where id=$1',[home])).rows[0];
 const parent=(await q.query('select revision,pages_revision from training_load.dashboards where id=$1',[d])).rows[0];
 await mutate('defaults',{expectedDefaultsRevision:before.defaults_revision,defaultFilter:{athleteIds:[]},period:null},home);
 const after=(await q.query('select * from training_load.dashboard_pages where id=$1',[home])).rows[0];
 const dashboard=(await q.query('select revision,pages_revision,default_filter from training_load.dashboards where id=$1',[d])).rows[0];
 assert.equal(after.revision,before.revision+1);assert.equal(after.defaults_revision,before.defaults_revision+1);
 assert.equal(dashboard.revision,parent.revision+1);assert.equal(dashboard.pages_revision,parent.pages_revision);assert.deepEqual(dashboard.default_filter,{athleteIds:[]});
 await mutate('defaults',{expectedDefaultsRevision:after.defaults_revision,defaultFilter:{athleteIds:[]},period:null},home);
 assert.deepEqual((await q.query('select * from training_load.dashboard_pages where id=$1',[home])).rows[0],after);
});

test('the database rejects invalid dates/timezones and enforces the 20-Page limit',async()=>{
 await assert.rejects(mutate('create',{name:'Impossible date',period:{schemaVersion:1,mode:'fixed',dateFrom:'2026-02-30',dateTo:'2026-03-01',timeZone:'UTC'}}),e=>e.code==='23514');
 await assert.rejects(mutate('create',{name:'Unknown zone',period:{schemaVersion:1,mode:'relative',preset:'today',timeZone:'No/Such_Zone'}}),e=>e.code==='23514');
 let count=(await q.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[d])).rows[0].n;
 for(let n=count;n<20;n++)await mutate('create',{name:'Extra '+n});
 await assert.rejects(mutate('create',{name:'Twenty first'}),e=>e.code==='23514'&&e.message==='pageLimit');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[d])).rows[0].n,20);
});
