import pg from 'pg';
import {PAGE_CATALOG_SQL as catalogSql} from './support/dashboard-pages-catalog.mjs';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPagesDatabase } from './support/dashboard-pages-db.mjs';
let db,c,user,dashboard,widget,baselineRows;
const sql=fs.readFileSync(new URL('../../migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql',import.meta.url),'utf8');
const snapshot=async()=>({
 dashboards:(await c.query('select id,to_jsonb(d) - \'pages_revision\' as row from training_load.dashboards d order by id')).rows,
 widgets:(await c.query('select id,to_jsonb(w) - \'page_id\' as row from training_load.dashboard_widgets w order by id')).rows,
 series:(await c.query('select id,to_jsonb(s) as row from training_load.dashboard_widget_series s order by id')).rows
});
async function transaction(fn){await c.query('begin');try{const r=await fn();await c.query('commit');return r}catch(e){await c.query('rollback');throw e}}
before(async()=>{
 db=await createPagesDatabase({label:'pages_migration'});c=db.client;
 user=(await c.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('pages@test.invalid','Pages','Test','Pages Test','Pages Test') returning id")).rows[0].id;
 dashboard=(await c.query(`insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,created_by_user_id,default_filter)
 values('Existing','user',$1,'private_coach', $1,'{"athleteIds":[]}'::jsonb) returning id`,[user])).rows[0].id;
 widget=(await c.query(`insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order)
 values($1,'table','Before Pages',0,0,0,6,4,0) returning id`,[dashboard])).rows[0].id;
 await c.query("select * from training_load.add_series($1,1,0,null,'session_count',null,'primary',null,null,'not_applicable',null,'day','sum')",[widget]);
 baselineRows=await snapshot();
 await transaction(()=>c.query(sql));
});
after(async()=>{await db?.drop()});
test('backfill changes only widget page_id, never revisions/timestamps, data or trigger enabled state',async()=>{
 assert.deepEqual(await snapshot(),baselineRows);
 const rows=(await c.query('select * from training_load.dashboard_pages')).rows;
 assert.equal(rows.length,baselineRows.dashboards.length);
 assert.equal(rows.find(p=>p.dashboard_id===dashboard).name,'Home');
 assert.deepEqual(rows.find(p=>p.dashboard_id===dashboard).default_filter,{athleteIds:[]});
 assert.equal((await c.query('select count(*)::int n from pg_trigger where tgrelid=$1::regclass and not tgisinternal and tgenabled<>\'O\'',['training_load.dashboard_widgets'])).rows[0].n,0);
});
test('old raw clone insert copies dashboard defaults into exactly one Home; old widget insert gets Home',async()=>{
 const id=await transaction(async()=>{
  const id=(await c.query(`insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,created_by_user_id,default_filter)
   select 'Legacy clone',owner_scope,owner_user_id,data_workspace_type,created_by_user_id,default_filter from training_load.dashboards where id=$1 returning id`,[dashboard])).rows[0].id;
  await c.query(`insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order)
   select $1,widget_type,title,widget_order,x,y,width,height,mobile_order from training_load.dashboard_widgets where dashboard_id=$2`,[id,dashboard]);return id;
 });
 const result=(await c.query(`select p.id,p.default_filter,w.page_id from training_load.dashboard_pages p join training_load.dashboard_widgets w on w.dashboard_id=p.dashboard_id where p.dashboard_id=$1`,[id])).rows;
 assert.equal(result.length,1);assert.equal(result[0].page_id,result[0].id);assert.deepEqual(result[0].default_filter,{athleteIds:[]});
});
test('database refuses a second Page independently of HTTP and direct Home deletion',async()=>{
 await assert.rejects(transaction(()=>c.query("insert into training_load.dashboard_pages(dashboard_id,name,position) values($1,'Second',1)",[dashboard])),e=>e.code==='23514'&&e.message==='dashboardPagesDisabled');
 await assert.rejects(transaction(()=>c.query('delete from training_load.dashboard_pages where dashboard_id=$1',[dashboard])),e=>e.code==='23514'&&e.message==='homePageRequired');
});
test('whole v19 dashboard deletion removes Home and writes exactly one deletion log row',async()=>{
 const rev=(await c.query('select revision from training_load.dashboards where id=$1',[dashboard])).rows[0].revision;
 await transaction(()=>c.query("select * from training_load.delete_dashboard($1,$2,$3,'owner')",[dashboard,rev,user]));
 assert.equal((await c.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[dashboard])).rows[0].n,0);
 assert.equal((await c.query('select count(*)::int n from training_load.dashboard_deletion_log where dashboard_id=$1',[dashboard])).rows[0].n,1);
});



test('legacy metadata keeps Home defaults synchronized',async()=>{
 const id=(await c.query('select id from training_load.dashboards order by id limit 1')).rows[0].id;
 await transaction(()=>c.query(`update training_load.dashboards set default_filter='{"athleteIds":null}'::jsonb where id=$1`,[id]));
 assert.deepEqual((await c.query('select default_filter from training_load.dashboard_pages where dashboard_id=$1 and is_home',[id])).rows[0].default_filter,{athleteIds:null});
});

test('changed or additional user trigger fails the SQL gate before any schema change',async()=>{
 const other=await createPagesDatabase({label:'pages_gate'});
 try {
  await other.client.query(`create function training_load.p1_unreviewed() returns trigger language plpgsql as $$begin return new;end;$$;
   create trigger p1_unreviewed before update on training_load.dashboard_widgets for each row execute function training_load.p1_unreviewed()`);
  await other.client.query('begin');
  await assert.rejects(other.client.query(sql),e=>e.code==='23514'&&e.message==='v90: widget trigger manifest changed');
  await other.client.query('rollback');
  assert.equal((await other.client.query("select to_regclass('training_load.dashboard_pages') as p")).rows[0].p,null);
  await other.client.query('drop trigger p1_unreviewed on training_load.dashboard_widgets;drop function training_load.p1_unreviewed()');
  await other.client.query(`create or replace function training_load.dashboard_widgets_bump_revision() returns trigger language plpgsql as $$begin new.revision:=old.revision+1;return new;end;$$`);
  await other.client.query('begin');
  await assert.rejects(other.client.query(sql),e=>e.code==='23514'&&e.message==='v90: widget trigger manifest changed');
  await other.client.query('rollback');
 }finally{await other.drop()}
});

test('stage A apply → rollback → identical catalog → reapply; refuses a later migration and an activated database',async()=>{
 const other=await createPagesDatabase({label:'pages_rollback'}),q=other.client;
 try{
 const beforeCatalog=(await q.query(catalogSql)).rows[0];
 await q.query('begin');await q.query(sql);await q.query('commit');
 await q.query(`insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values('migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql','${crypto.createHash('sha256').update(sql).digest('hex')}',0,1)`);
 const rollback=fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v90-rollback.sql',import.meta.url),'utf8');
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/Page state/.test(e.message));await q.query('rollback');
 await q.query('update training_load.dashboard_pages_activation set enabled=false');
 await q.query(`insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values('migrations_v2/202611231100_later_test.sql','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0,1)`);
 await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/later migration/.test(e.message));await q.query('rollback');
 await q.query(`delete from public.schema_migrations where migration_name='migrations_v2/202611231100_later_test.sql'`);
 await q.query(rollback);assert.deepEqual((await q.query(catalogSql)).rows[0],beforeCatalog);
 await q.query('begin');await q.query(sql);await q.query('commit');
 assert.notEqual((await q.query("select to_regclass('training_load.dashboard_pages') p")).rows[0].p,null);
 } finally{await other.drop()}
});

test('non-superuser table owner applies Home backfill with all triggers enabled',async()=>{
 const other=await createPagesDatabase({label:'pages_owner'}),q=other.client;
 const role='p1_owner_'+Date.now();
 try{
 await q.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole`);
 await q.query(`grant usage,create on schema training_load to ${role};grant usage on schema public to ${role}`);
 await q.query(`grant select on all tables in schema training_load,public to ${role}`);
 for(const name of ['dashboards','dashboard_widgets','dashboard_widget_series']) await q.query(`alter table training_load.${name} owner to ${role}`);
 for(const row of JSON.parse(fs.readFileSync(new URL('./fixtures/dashboard-pages/v85-functions.json',import.meta.url),'utf8'))) await q.query(`alter function ${row.signature} owner to ${role}`);
 await q.query(`alter function ${JSON.parse(fs.readFileSync(new URL('./fixtures/dashboard-pages/v85-simple-save.json',import.meta.url),'utf8')).signature} owner to ${role}`);
 await q.query(`set role ${role}`);
 assert.equal((await q.query("select rolsuper from pg_roles where rolname=current_user")).rows[0].rolsuper,false);
 await q.query('begin');await q.query(sql);await q.query('commit');
 assert.equal((await q.query("select count(*)::int n from pg_trigger where tgrelid='training_load.dashboard_widgets'::regclass and not tgisinternal and tgenabled<>'O'")).rows[0].n,0);
 }finally{
 await q.query('rollback').catch(()=>{});await q.query('reset role');
 // DROP OWNED is restricted to this disposable database and the unique test role.
 await q.query(`drop owned by ${role} cascade`);await q.query(`drop role ${role}`);
 await other.drop();
 }
});

test('every production-reported dashboard function matches the disposable pre-P1 baseline',async()=>{
 const other=await createPagesDatabase({label:'pages_production_gate'});
 try{
 const expected=JSON.parse(fs.readFileSync(new URL('./fixtures/dashboard-pages/v85-production-function-md5s.json',import.meta.url),'utf8'));
 for(const [signature,bodyMd5] of Object.entries(expected)){
  const row=(await other.client.query('select md5(prosrc) body_md5 from pg_proc where oid=to_regprocedure($1)',[signature])).rows[0];
  assert.equal(row?.body_md5,bodyMd5,signature);
 }
 }finally{await other.drop()}
});

test('whole-dashboard cascade still works when FK trigger order is reversed as after restore',async()=>{
 // Recreate the old widget->dashboard FK after the newer page->dashboard FK.
 // A RESTRICT widget->page FK would now reject a perfectly valid dashboard delete.
 await c.query('alter table training_load.dashboard_widgets drop constraint dashboard_widgets_dashboard_id_fkey');
 await c.query('alter table training_load.dashboard_widgets add constraint dashboard_widgets_dashboard_id_fkey foreign key(dashboard_id) references training_load.dashboards(id) on delete cascade');
 const id=(await c.query("insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,created_by_user_id) values('Cascade order','user',$1,'private_coach',$1) returning id",[user])).rows[0].id;
 await c.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order) values($1,'table','Cascade widget',0,0,0,6,4,0)",[id]);
 const revision=(await c.query('select revision from training_load.dashboards where id=$1',[id])).rows[0].revision;
 await transaction(()=>c.query("select * from training_load.delete_dashboard($1,$2,$3,'owner')",[id,revision,user]));
 assert.equal((await c.query('select count(*)::int n from training_load.dashboard_pages where dashboard_id=$1',[id])).rows[0].n,0);
 assert.equal((await c.query('select count(*)::int n from training_load.dashboard_deletion_log where dashboard_id=$1',[id])).rows[0].n,1);
});

test('owner preflight/postcheck SQL executes read-only on its exact A and B stages',async()=>{
 const rehearsal=await createPagesDatabase({label:'pages_runbooks'});
 try{
  const run=async(name)=>{const results=await rehearsal.client.query(fs.readFileSync(new URL('../../docs/runbooks/'+name,import.meta.url),'utf8'));for(const result of Array.isArray(results)?results:[results])for(const row of result.rows??[])for(const [key,value] of Object.entries(row))if(typeof value==='boolean')assert.equal(value,true,name+': '+key)};
  await run('dashboard-pages-v90-preflight.sql');
  await rehearsal.applyThrough('202611231000');await run('dashboard-pages-v90-postcheck.sql');await run('dashboard-pages-v91-preflight.sql');
  await rehearsal.applyThrough('202611231100');await run('dashboard-pages-v91-postcheck.sql');
 }finally{await rehearsal.drop()}
});

test('A-only owner command records the canonical identity and never applies B',async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const target=await createPagesDatabase({label:'pages_stage_a'});
 try{const result=spawnSync(process.execPath,['backend/scripts/dashboard-pages-stage-a.mjs','--apply','202611231000_training_load_v90_dashboard_pages_home.sql'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,DATABASE_URL:target.url,DASHBOARD_PAGES_ENABLED:'false'},encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.equal((await target.client.query("select count(*)::int n from public.schema_migrations where migration_name='migrations_v2/202611231000_training_load_v90_dashboard_pages_home.sql'")).rows[0].n,1);
 assert.equal((await target.client.query("select to_regclass('training_load.dashboard_page_requests') ledger")).rows[0].ledger,null);
 assert.equal((await target.client.query("select count(*)::int n from public.schema_migrations where migration_name ~ '_v(87|88|89)_'")).rows[0].n,0,'A order never applies another optional migration');
 const catalog=(await target.client.query(catalogSql)).rows[0];await target.client.query("delete from public.schema_migrations where migration_name='migrations_v2/202611201500_training_load_v85_session_types.sql'");
 const refused=spawnSync(process.execPath,['backend/scripts/dashboard-pages-stage-a.mjs','--apply','202611231000_training_load_v90_dashboard_pages_home.sql'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,DATABASE_URL:target.url,DASHBOARD_PAGES_ENABLED:'false'},encoding:'utf8',windowsHide:true});assert.notEqual(refused.status,0);assert.match(refused.stdout+refused.stderr,/refuses to apply another unrecorded migration/);assert.deepEqual((await target.client.query(catalogSql)).rows[0],catalog);


 }finally{await target.drop()}
});

for(const scenario of [
 {name:'neither optional',through:'202611221200'},
 {name:'v88 only',through:'202611221300'},
 {name:'v89 only',through:'202611221400',omit:['202611221300_training_load_v88_manual_values.sql']},
 {name:'v88 then v89',through:'202611221400'},
 {name:'v89 then v88',through:'202611221400',omit:['202611221300_training_load_v88_manual_values.sql'],finish:true}
])test('A/B optional registry: '+scenario.name+' → apply → rollback → same catalog → reapply',async()=>{
 const target=await createPagesDatabase({...scenario,label:'pages_registry'}),q=target.client;
 try{if(scenario.finish)await target.applyThrough('202611221400');const before=(await q.query(catalogSql)).rows[0];
 const apply=async file=>{const bytes=fs.readFileSync(new URL('../../migrations_v2/'+file,import.meta.url));await q.query('begin');try{await q.query(bytes.toString());await q.query("insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values($1,$2,0,'p1-registry')",['migrations_v2/'+file,crypto.createHash('sha256').update(bytes).digest('hex')]);await q.query('commit')}catch(e){await q.query('rollback');throw e}};
 const a='202611231000_training_load_v90_dashboard_pages_home.sql',b='202611231100_training_load_v91_dashboard_page_writers.sql';
 const check=async file=>{
  // Execute the owner's SQL byte-for-byte. In a loaded test run quiet_moment may
  // correctly refuse; assert it reflects the activity rows instead of rewriting
  // its predicate or pretending the database was quiet. All other gates stay true.
  const text=fs.readFileSync(new URL('../../docs/runbooks/'+file,import.meta.url),'utf8');
  const response=await q.query(text),results=Array.isArray(response)?response:[response];
  const active=results.flatMap(result=>result.rows??[]).filter(row=>Object.hasOwn(row,'pid')&&Object.hasOwn(row,'xact_start'));
  for(const result of results)for(const row of result.rows??[])for(const [key,value]of Object.entries(row))if(typeof value==='boolean'){
   assert.equal(value,key==='quiet_moment'?active.length===0:true,scenario.name+': '+file+': '+key);
  }
 };
 await check('dashboard-pages-v90-preflight.sql');await apply(a);await check('dashboard-pages-v90-postcheck.sql');await check('dashboard-pages-v91-preflight.sql');await apply(b);await check('dashboard-pages-v91-postcheck.sql');
 await q.query(fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v91-rollback.sql',import.meta.url),'utf8'));await q.query(fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v90-rollback.sql',import.meta.url),'utf8'));assert.deepEqual((await q.query(catalogSql)).rows[0],before);
 await apply(a);await apply(b);
 }finally{await target.drop()}
});

test('v90 rollback independently refuses a non-Home Page even with legacy-looking name and position',async()=>{
 const other=await createPagesDatabase({through:'202611231000',label:'pages_a_nonhome'}),q=other.client;
 try{
  const actor=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('a-nonhome@test.invalid','Page','Guard','Page Guard','Page Guard') returning id")).rows[0].id;
  const parent=(await q.query("insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,created_by_user_id) values('Guard','user',$1,'private_coach',$1) returning id",[actor])).rows[0].id;
  // Isolate the rollback's own not-is_home predicate in this disposable transaction:
  // remove only name uniqueness and leave position uniqueness deferred until COMMIT.
  // No widget refers to the extra Page; the valid Home and defaults still exist.
  await q.query('begin');await q.query('drop index training_load.dashboard_pages_name_unique');
  await q.query('update training_load.dashboard_pages_activation set enabled=true');
  await q.query("insert into training_load.dashboard_pages(dashboard_id,name,position,is_home) values($1,'Home',0,false)",[parent]);
  await q.query('update training_load.dashboard_pages_activation set enabled=false');
  const rollback=fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v90-rollback.sql',import.meta.url),'utf8');
  // Execute the exact state guard from the real rollback, before its DDL.
  // This isolates the guard from deferred duplicate-position events in the fixture.
  const guards=[...rollback.matchAll(/do \$guard\$[\s\S]*?\$guard\$;/g)];
  assert.equal(guards.length,2);
  await assert.rejects(q.query(guards[1][0]),e=>e.code==='23514'&&/Page state/.test(e.message));
  await q.query('rollback');
  assert.equal((await q.query('select count(*)::int n from training_load.dashboard_pages where not is_home')).rows[0].n,0);
 }finally{await q.query('rollback');await other.drop()}
});

test('unaltered owner preflight reports an actual other transaction as not quiet',async()=>{
 const target=await createPagesDatabase({through:'202611201500',label:'pages_raw_preflight'}),other=new pg.Client({connectionString:target.url});
 try{
  await other.connect();await other.query('begin');const pid=(await other.query('select pg_backend_pid() pid')).rows[0].pid;
  const text=fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v90-preflight.sql',import.meta.url),'utf8');
  const results=await target.client.query(text),rows=results.flatMap(result=>result.rows??[]);
  assert.ok(rows.some(row=>row.pid===pid&&row.xact_start));assert.equal(rows.find(row=>Object.hasOwn(row,'quiet_moment')).quiet_moment,false);
 }finally{await other.query('rollback').catch(()=>{});await other.end();await target.drop()}
});
