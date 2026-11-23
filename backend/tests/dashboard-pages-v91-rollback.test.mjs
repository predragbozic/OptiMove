import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
import {PAGE_CATALOG_SQL} from './support/dashboard-pages-catalog.mjs';

test('v91 apply → guarded rollback → identical v90 catalog → reapply',async()=>{
 const db=await createPagesDatabase({through:'202611231000',label:'pages_b_rollback'}),q=db.client;
 try{
  const before=(await q.query(PAGE_CATALOG_SQL)).rows[0];
  const file='202611231100_training_load_v91_dashboard_page_writers.sql';
  const sql=fs.readFileSync(new URL('../../migrations_v2/'+file,import.meta.url),'utf8');
  const hash=crypto.createHash('sha256').update(sql).digest('hex');
  const apply=async()=>{await q.query('begin');try{await q.query(sql);await q.query('insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values($1,$2,0,\'p1-test\')',['migrations_v2/'+file,hash]);await q.query('commit')}catch(e){await q.query('rollback');throw e}};
  await apply();
  const rollback=fs.readFileSync(new URL('../../docs/runbooks/dashboard-pages-v91-rollback.sql',import.meta.url),'utf8');
  await q.query('update training_load.dashboard_pages_activation set enabled=true');
  await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/Page use or receipts/.test(e.message));await q.query('rollback');
  await q.query('update training_load.dashboard_pages_activation set enabled=false');
  await q.query("insert into public.schema_migrations(migration_name,checksum,execution_time_ms,runner_version) values('migrations_v2/202611231200_p1_test_future.sql',repeat('b',64),0,'p1-test')");
  await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/later migration/.test(e.message));await q.query('rollback');
  await q.query("delete from public.schema_migrations where migration_name='migrations_v2/202611231200_p1_test_future.sql'");
  await q.query("with actor as (insert into public.users(email,first_name,last_name,full_name,display_name) values('receipt-refusal@test.invalid','Receipt','Refusal','Receipt Refusal','Receipt Refusal') returning id) insert into training_load.dashboard_page_requests(initiator_user_id,request_id,dashboard_id,workspace,operation,payload_hash,receipt,request_issued_at,retain_until) select id,gen_random_uuid(),gen_random_uuid(),'{}','create',repeat('a',64),'{}','2000-01-01T00:00:00Z'::timestamptz,'2000-01-01T00:00:00Z'::timestamptz+interval '168 hours 10 minutes' from actor");
  await assert.rejects(q.query(rollback),e=>e.code==='23514'&&/Page use or receipts/.test(e.message));await q.query('rollback');
  assert.equal((await q.query('select count(*)::int n from training_load.dashboard_page_requests')).rows[0].n,1,'refused rollback leaves the receipt intact');
  assert.equal((await q.query('select training_load.cleanup_dashboard_page_requests(100) n')).rows[0].n,1);

  await q.query(rollback);assert.deepEqual((await q.query(PAGE_CATALOG_SQL)).rows[0],before);
  await apply();assert.notEqual((await q.query("select to_regclass('training_load.dashboard_page_requests') ledger")).rows[0].ledger,null);
 }finally{await db.drop()}
});
