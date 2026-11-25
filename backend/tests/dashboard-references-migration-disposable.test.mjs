import {REFERENCE_DATA_DIGEST_SQL} from '../src/dashboardReferences/evidence.js';
import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';import {PAGE_CATALOG_SQL} from './support/dashboard-pages-catalog.mjs';
let db,q;const file='migrations_v2/202611291000_training_load_v97_references.sql';
const sql=kind=>fs.readFileSync(new URL('../../docs/runbooks/dashboard-references-v97-'+kind+'.sql',import.meta.url),'utf8');
before(async()=>{db=await createPagesDatabase({through:'202611271000',label:'reference_rollback'});q=db.client;});after(async()=>{await db?.drop();});
async function allTrue(text){const result=await q.query(text);for(const part of Array.isArray(result)?result:[result])for(const row of part.rows??[])for(const [key,value]of Object.entries(row))if(typeof value==='boolean'||key.endsWith('_exact')||['v97_absent','triggers_enabled'].includes(key))assert.equal(value,true,JSON.stringify(row));}
test('v97 preflight, apply, postcheck, actual rollback, identical catalog and reapply',async()=>{
 const actor=(await q.query("insert into public.users(email,first_name,last_name,full_name) values('before-references@test.local','Before','Refs','Before Refs') returning id")).rows[0].id;
 const dashboard=(await q.query("select * from training_load.create_dashboard('Before references',null,'user',$1,null,null,'platform',null,false,$1,null)",[actor])).rows[0];
 const widget=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,'bar_chart','Before references',0,0,0,6,4,0,'day') returning *",[dashboard.id])).rows[0];
 await q.query("select * from training_load.add_series($1,$2,0,null,'duration_minutes',null,'primary',null,null,'not_applicable',null,'session','sum')",[widget.id,widget.revision]);
 const dataBefore=(await q.query(REFERENCE_DATA_DIGEST_SQL)).rows;
 const before=(await q.query(PAGE_CATALOG_SQL)).rows[0];await allTrue(sql('preflight'));await db.applyThrough('202611291000');await allTrue(sql('postcheck'));assert.deepEqual((await q.query(REFERENCE_DATA_DIGEST_SQL)).rows,dataBefore);await q.query(sql('rollback'));assert.deepEqual((await q.query(PAGE_CATALOG_SQL)).rows[0],before);await db.applyThrough('202611291000');await allTrue(sql('postcheck'));
});
test('rollback refuses a changed function or a later recorded migration',async()=>{
 const def=(await q.query("select pg_get_functiondef('training_load.dashboard_reference_config_valid(jsonb)'::regprocedure) definition")).rows[0].definition;
 await q.query('create or replace function training_load.dashboard_reference_config_valid(v jsonb) returns boolean language plpgsql immutable as $$begin return true;end $$');
 await assert.rejects(q.query(sql('rollback')),/body changed/);await q.query('rollback');await q.query(def);
 const future='migrations_v2/202611301000_reference_test_only.sql';await q.query("insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values($1,repeat('a',64),0,'test')",[future]);await assert.rejects(q.query(sql('rollback')),/later migration/);await q.query('rollback');await q.query('delete from public.schema_migrations where migration_name=$1',[future]);await allTrue(sql('postcheck'));
});
test('rollback refuses once a real reference table has been created, even with no widget',async()=>{
 const actor=(await q.query("insert into public.users(email,first_name,last_name,full_name) values('rollback-ref@test.local','Ref','Admin','Ref Admin') returning id")).rows[0].id;
 const club=(await q.query("insert into public.clubs(name) values('Rollback reference club') returning id")).rows[0].id;await q.query("insert into public.user_club_roles(user_id,club_id,role) values($1,$2,'club_admin')",[actor,club]);
 await q.query("select training_load.mutate_dashboard_reference($1,$2,gen_random_uuid(),repeat('a',64),null,null,'create','{\"name\":\"Real targets\"}')",[actor,club]);await assert.rejects(q.query(sql('rollback')),/real reference writes/);await q.query('rollback');await allTrue(sql('postcheck'));
});

test('postcheck refuses a missing function as false, never as an ignored null',async()=>{
 await q.query('begin');try{await q.query('drop function training_load.dashboard_reference_column_available(uuid,uuid,text,text,text)');await assert.rejects(allTrue(sql('postcheck')),error=>error.code==='ERR_ASSERTION');}finally{await q.query('rollback');}await allTrue(sql('postcheck'));
});
