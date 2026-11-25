import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
let db, q, actor, club, position;
before(async () => {
 db=await createPagesDatabase({through:"202611291000",label:"references97"});q=db.client;
 actor=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('reference@test.invalid','Reference','Admin','Reference Admin','Reference Admin') returning id")).rows[0].id;
 club=(await q.query("insert into public.clubs(name) values('Reference Club') returning id")).rows[0].id;
 await q.query("insert into public.user_club_roles(user_id,club_id,role) values($1,$2,'club_admin')",[actor,club]);
 position=(await q.query("select id from public.sport_positions order by sort_order limit 1")).rows[0].id;
});
after(async()=>{await db?.drop();});
async function write(action,{id=null,revision=null,payload={},request=crypto.randomUUID(),hash='a'.repeat(64),user=actor}={}) {
 return (await q.query('select training_load.mutate_dashboard_reference($1,$2,$3,$4,$5,$6,$7,$8) receipt',[user,club,request,hash,id,revision,action,payload])).rows[0].receipt;
}
test('v97 retains the exact v94 helper and adds normalized reference storage',async()=>{
 assert.equal((await q.query("select md5(prosrc) body from pg_proc where oid='training_load.dashboard_reference_legacy_valid(jsonb)'::regprocedure")).rows[0].body,'9ce11aa017244998674f357eac2d8c89');
 assert.equal((await q.query("select count(*)::int n from information_schema.tables where table_schema='training_load' and table_name like 'dashboard_reference_%'")).rows[0].n,9);
});
test('canonical admin creates a club table, retries idempotently, and cannot reuse its key with another payload',async()=>{
 const request=crypto.randomUUID(); const args={request,payload:{name:'Game targets'}};
 const first=await write('create',args); assert.equal(first.revision,1);
 assert.deepEqual(await write('create',args),first);
 await assert.rejects(write('create',{...args,hash:'b'.repeat(64)}),/requestIdReused/);
});
test('no role cannot write and a stale revision cannot archive',async()=>{
 const user=(await q.query("insert into public.users(email,first_name,last_name,full_name) values('outsider@test.invalid','Outside','Tester','Outsider') returning id")).rows[0].id;
 await assert.rejects(write('create',{user,payload:{name:'Unauthorized'}}),/notFound/);
 const table=await write('create',{payload:{name:'Return to play'}});
 await assert.rejects(write('archive',{id:table.id,revision:0}),/staleRevision/);
 const archived=await write('archive',{id:table.id,revision:1});assert.equal(archived.revision,2);
});
test('raw writes and receipt edits are refused outside the sanctioned function',async()=>{
 await assert.rejects(q.query("update training_load.dashboard_reference_tables set name='Raw'"),/referenceWriterRequired/);
 await assert.rejects(q.query("delete from training_load.dashboard_reference_requests"),/referenceWriterRequired/);
});
test('a foreign position cannot be put in a draft and an empty draft cannot publish',async()=>{
 const t=await write('create',{payload:{name:'Draft validation'}});
 await assert.rejects(write('publish',{id:t.id,revision:1}),/referenceEmpty/);
 await assert.rejects(write('draft',{id:t.id,revision:1,payload:{columns:[],rows:[{positionId:crypto.randomUUID(),order:0}],valueKinds:[],cells:[]}}),/notFound/);
});

test('draft stores extensible named values including zero, publishes immutably, and new drafts do not rewrite it', async()=>{
 const definition=(await q.query("insert into training_load.metric_definitions(key,label,owner_scope,state,created_by_user_id) values('p3_distance','Distance','system','active',$1) returning id",[actor])).rows[0].id;
 await q.query("insert into training_load.metric_definition_versions(metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id) values($1,1,'m','numeric','sum',$2)",[definition,actor]);
 await q.query("update training_load.metric_definitions set current_version_id=(select id from training_load.metric_definition_versions where metric_definition_id=$1) where id=$1",[definition]);
 await q.query("insert into training_load.metric_definition_scope_capabilities values($1,'session')",[definition]);
 const t=await write('create',{payload:{name:'Game by position'}});
 const payload={columns:[{definitionId:definition,unit:'m',aggregation:'sum',dataLevel:'session',order:0}],rows:[{positionId:position,order:0}],valueKinds:[{key:'minimum',name:'Minimum',order:0},{key:'return',name:'Return to play',order:1}],cells:[{positionId:position,definitionId:definition,valueKey:'minimum',value:0},{positionId:position,definitionId:definition,valueKey:'return',value:100}]};
 const draft=await write('draft',{id:t.id,revision:1,payload});
 const published=await write('publish',{id:t.id,revision:draft.revision});
 assert.ok(published.publishedVersionId);
 const before=(await q.query('select value::text from training_load.dashboard_reference_cells where version_id=$1 order by value_key',[published.publishedVersionId])).rows;
 assert.deepEqual(before.map(r=>r.value),['0','100']);
 await q.query('begin');await q.query("select set_config('optimove.reference_writer',txid_current()::text,true)");
 await assert.rejects(q.query('update training_load.dashboard_reference_cells set value=42 where version_id=$1',[published.publishedVersionId]),/referenceVersionImmutable/);await q.query('rollback');
 payload.cells[1].value=200;
 await write('draft',{id:t.id,revision:published.revision,payload});
 assert.deepEqual((await q.query('select value::text from training_load.dashboard_reference_cells where version_id=$1 order by value_key',[published.publishedVersionId])).rows,before);
});

test('JS and SQL accept the team-average binding and reject malformed or ambiguous bindings',async()=>{
 const {validReferenceConfig}=await import('../src/dashboardReferences/contract.js');
 const valid={schemaVersion:1,source:'teamAverage',mode:'radar',clubId:club,teamId:crypto.randomUUID(),axes:[{seriesId:crypto.randomUUID(),valueKeys:['teamAverage']}]};
 const variants=[valid,{...valid,source:'preset',tableId:crypto.randomUUID(),versionId:crypto.randomUUID(),teamId:undefined}, {...valid,axes:[{...valid.axes[0],valueKeys:['madeUp']}]},{...valid,axes:[{...valid.axes[0],anchorKey:'target'}]},{...valid,unknown:true},{...valid,clubId:null},{...valid,axes:[valid.axes[0],valid.axes[0]]}];
 for(const [i,input] of variants.entries()){
  const value=JSON.parse(JSON.stringify(input));
  const sql=(await q.query('select training_load.dashboard_reference_config_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid;
  assert.equal(sql,validReferenceConfig(value),'JS/SQL parity for case '+i);
  assert.equal(sql,i===0,'only the complete team-average binding is allowed: '+i);
 }
});
