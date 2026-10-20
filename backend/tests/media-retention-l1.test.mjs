import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import {createDisposableDatabase} from './support/disposable-db.mjs';
import {createMediaReferenceService,mediaRetentionDatabaseError} from '../src/mediaReferences.js';
const input=process.env.MEDIA_TEST_DATABASE_URL;
if(!input)throw new Error('Local MEDIA_TEST_DATABASE_URL required');
const url=new URL(input);if(!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)||url.search)throw new Error('Refusing remote/URL-option-bearing test database');
const suffix=randomUUID().replaceAll('-','').slice(0,16),role='media_l1_owner_'+suffix,outsider='media_l1_outside_'+suffix;
const adminUrl=new URL(url);adminUrl.pathname='/postgres';let dbUrl,database;
const admin=new pg.Client({connectionString:adminUrl.toString()});let pool,roleCreated=false,outsiderCreated=false,migration,account;
const owner=randomUUID(),viewer=randomUUID(),athlete=randomUUID(),club=randomUUID();let seededAsset,seededPlan;
const fixture=`create schema library;create schema plans;
create table public.users(id uuid primary key,is_active boolean default true);
create table public.clubs(id uuid primary key,is_active boolean default true);
create table public.athletes(id uuid primary key,user_id uuid references public.users(id),is_active boolean default true);
create table library.exercises(id uuid primary key default gen_random_uuid(),owner_user_id uuid references public.users(id) on delete cascade,is_active boolean default true,video_url text,image_url text);
create table plans.plans(id uuid primary key default gen_random_uuid(),created_by_user_id uuid references public.users(id) on delete cascade,athlete_id uuid references public.athletes(id) on delete cascade,is_template boolean default true,status text default 'active',is_active boolean default true);
create table plans.plan_days(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade);
create table plans.plan_sessions(id uuid primary key default gen_random_uuid(),plan_day_id uuid references plans.plan_days(id) on delete cascade);
create table plans.plan_items(id uuid primary key default gen_random_uuid(),plan_session_id uuid references plans.plan_sessions(id) on delete cascade,exercise_id uuid references library.exercises(id) on delete set null,video_url text,image_url text,note text);
create table library.program_access(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade,user_id uuid references public.users(id) on delete cascade,access_type text,status text,starts_at timestamptz default now(),expires_at timestamptz,source text,license_snapshot jsonb default '{}'::jsonb,related_plan_id uuid);
create table library.program_usage_events(id uuid primary key default gen_random_uuid(),program_access_id uuid references library.program_access(id) on delete cascade,event_type text);
`;
async function asset(status='ready',kind='video') {return (await pool.query("insert into media.assets(object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,$3,$4,$5,10,$6) returning id",['test/'+randomUUID(),kind,account,owner,status,kind==='video'?'video/mp4':'image/png'])).rows[0].id;}
async function plan(assigned=false){const id=(await pool.query('insert into plans.plans(created_by_user_id,athlete_id,is_template) values($1,$2,$3) returning id',[owner,assigned?athlete:null,!assigned])).rows[0].id;const day=(await pool.query('insert into plans.plan_days(plan_id) values($1) returning id',[id])).rows[0].id;const session=(await pool.query('insert into plans.plan_sessions(plan_day_id) values($1) returning id',[day])).rows[0].id;return {id,session};}
async function item(p,a,kind='video'){return (await pool.query(`insert into plans.plan_items(plan_session_id,${kind}_source,${kind}_asset_id) values($1,'asset',$2) returning id`,[p.session,a])).rows[0].id;}
async function grant(p,type='downloaded',status='accessed',expiry=null,user=viewer){return (await pool.query('insert into library.program_access(plan_id,user_id,access_type,status,expires_at) values($1,$2,$3,$4,$5) returning id',[p.id,user,type,status,expiry])).rows[0].id;}
const holds=async p=>(await pool.query('select * from media.retention_holds where source_plan_id=$1',[p.id])).rows;
const rejectCode=(promise,code)=>assert.rejects(promise,e=>e.code===code);
async function transaction(work){const c=await pool.connect();try{await c.query('begin');await c.query("set local lock_timeout='2s'");const r=await work(c);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
before(async()=>{
 database=await createDisposableDatabase({prefix:'media_l1',label:'primary',baseDatabaseUrl:input});dbUrl=new URL(database.url);
 await admin.connect();await admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit`);roleCreated=true;await admin.query(`grant ${role} to current_user`);
 await admin.query(`create role ${outsider} nologin nosuperuser nocreatedb nocreaterole noinherit`);outsiderCreated=true;await admin.query(`grant ${outsider} to current_user`);
 await admin.query(`alter database ${database.name} owner to ${role}`);pool=new pg.Pool({connectionString:dbUrl.toString(),options:'-c role='+role,max:10});await pool.query(fixture);
 await pool.query('insert into public.users(id) values($1),($2)',[owner,viewer]);await pool.query('insert into public.clubs(id) values($1)',[club]);await pool.query('insert into public.athletes(id,user_id) values($1,$2)',[athlete,viewer]);
 for(const file of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql'])await transaction(async c=>c.query(await fs.readFile(new URL('../../migrations_v2/'+file,import.meta.url),'utf8')));
 account=(await pool.query('insert into media.storage_accounts(owner_user_id) values($1) returning id',[owner])).rows[0].id;
 seededAsset=await asset();seededPlan=await plan();await item(seededPlan,seededAsset);await grant(seededPlan,'purchased');
 migration=await fs.readFile(new URL('../../migrations_v2/202610201100_media_reference_protection.sql',import.meta.url),'utf8');
 process.env.DATABASE_URL=dbUrl.toString();const {assertNoTransactionControl}=await import('../src/migrate.js');assertNoTransactionControl(migration);
 // Rehearse runner-style failure rollback, including seeded rows/DDL.
 const c=await pool.connect();try{await c.query('begin');await c.query(migration);assert.equal((await c.query('select count(*) from media.retention_holds')).rows[0].count,'1');await c.query('rollback');assert.equal((await c.query("select to_regclass('media.retention_holds') as name")).rows[0].name,null);}finally{c.release();}
 // Corrupt pre-existing references stop migration before additive objects remain.
 const invalid=await asset('pending');const badItem=await item(seededPlan,invalid);
 const bad=await pool.connect();try{await bad.query('begin');await rejectCode(bad.query(migration),'P7501');await bad.query('rollback');assert.equal((await bad.query("select to_regclass('media.retention_holds') as name")).rows[0].name,null);}finally{bad.release();}
 await pool.query('delete from plans.plan_items where id=$1',[badItem]);
 await transaction(c=>c.query(migration));
});
after(async()=>{if(pool)await pool.end();if(database)await database.drop();if(outsiderCreated)await admin.query(`drop role ${outsider}`);if(roleCreated)await admin.query(`drop role ${role}`);await admin.end();});

test('migration/backfill works as non-superuser and rolls back atomically without touching quotas',async()=>{
 assert.equal((await pool.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper,false);
 const h=await holds(seededPlan);assert.equal(h.length,1);assert.equal(h[0].basis_type,'unverified_commercial');assert.equal(h[0].review_required,true);assert.equal((await pool.query('select count(*) from media.hold_assets where hold_id=$1',[h[0].id])).rows[0].count,'1');
 const a=(await pool.query('select used_bytes,reserved_bytes,override_limit_bytes from media.storage_accounts where id=$1',[account])).rows[0];assert.deepEqual(a,{used_bytes:'0',reserved_bytes:'0',override_limit_bytes:null});
});
test('raw SQL and bulk new references reject pending/failed/deleting/deleted and wrong kinds',async()=>{
 const p=await plan();for(const status of ['pending','verifying','failed','deleting','deleted']){const a=await asset(status);await rejectCode(item(p,a),'P7501');await rejectCode(pool.query("insert into library.exercises(video_source,video_asset_id) values('asset',$1)",[a]),'P7501');}
 await rejectCode(item(p,await asset('ready','image')),'P7501');
 const good=await asset(),bad=await asset('pending');await rejectCode(pool.query("insert into plans.plan_items(plan_session_id,video_source,video_asset_id) values($1,'asset',$2),($1,'asset',$3)",[p.session,good,bad]),'P7501');assert.equal((await pool.query('select count(*) from plans.plan_items where plan_session_id=$1',[p.session])).rows[0].count,'0');
});
test('reference matrix derives Library, plan snapshot, thumbnail ancestry and upload history separately',async()=>{
 const a=await asset(),p=await plan(),i=await item(p,a);const e=(await pool.query("insert into library.exercises(owner_user_id,video_source,video_asset_id) values($1,'asset',$2) returning id",[owner,a])).rows[0].id;
 const image=await asset('ready','image');await pool.query('update media.assets set source_video_asset_id=$2 where id=$1',[image,a]);
 const rows=(await pool.query('select * from media.asset_reference_matrix where asset_id=$1',[a])).rows;assert.ok(rows.some(r=>r.reference_type==='exercise'&&r.reference_id===e));assert.ok(rows.some(r=>r.reference_type==='plan_item'&&r.reference_id===i&&r.plan_id===p.id));assert.ok(rows.some(r=>r.reference_type==='derived_image'&&r.reference_id===image));
});
test('assigned plan captures independent manifest and source removal/revoke never releases it',async()=>{
 const a=await asset(),p=await plan(true),i=await item(p,a),h=await holds(p);assert.equal(h[0].basis_type,'assigned_plan');
 await pool.query("update plans.plan_items set video_asset_id=null,video_source='none' where id=$1",[i]);await pool.query('update plans.plans set is_active=false,status=\'archived\' where id=$1',[p.id]);
 assert.equal((await pool.query('select count(*) from media.hold_assets where hold_id=$1 and asset_id=$2',[h[0].id,a])).rows[0].count,'1');await rejectCode(pool.query("update media.assets set status='deleting' where id=$1",[a]),'P7502');await pool.query('delete from plans.plans where id=$1',[p.id]);assert.equal((await holds(p)).length,1);
});
test('existing grants preserve media through revoke/deletion and distinguish commercial uncertainty',async()=>{
 for(const type of ['downloaded','coach_assigned','assigned','purchased','copied']){const a=await asset(),p=await plan();await item(p,a);const g=await grant(p,type),h=await holds(p);assert.equal(h.length,1);assert.equal(h[0].review_required,['purchased','copied'].includes(type));
 await pool.query("update library.program_access set status='revoked' where id=$1",[g]);await pool.query('delete from library.program_access where id=$1',[g]);assert.equal((await holds(p))[0].id,h[0].id);await pool.query('delete from plans.plans where id=$1',[p.id]);assert.equal((await holds(p)).length,1);}
});
test('requested/rejected/revoked/expired grants and own copy receipts are not permanent entitlement proof',async()=>{
 for(const [type,status,expiry,user] of [['purchased','requested',null,viewer],['downloaded','rejected',null,viewer],['purchased','revoked',null,viewer],['downloaded','completed','2000-01-01',viewer],['copied','accessed',null,owner]]){const p=await plan(),a=await asset();await item(p,a);await grant(p,type,status,expiry,user);assert.equal((await holds(p)).length,0);}
});
test('unknown grant type and missing source owner preserve ambiguity instead of dropping protection',async()=>{
 const p=await plan(),a=await asset();await item(p,a);await pool.query('update plans.plans set created_by_user_id=null where id=$1',[p.id]);await grant(p,'copied');assert.equal((await holds(p))[0].review_required,true);
 const q=await plan();await item(q,await asset());await grant(q,null);assert.equal((await holds(q))[0].basis_type,'ambiguous_grant');
});

test('reassignment and grant transfer create separate immutable beneficiary/plan manifests',async()=>{
 const a=await asset(),p=await plan(true),q=await plan();await item(p,a);await item(q,a);
 const secondAthlete=(await pool.query('insert into public.athletes(id,user_id) values($1,$2) returning id',[randomUUID(),owner])).rows[0].id;
 await pool.query('update plans.plans set athlete_id=$2 where id=$1',[p.id,secondAthlete]);const assigned=await holds(p);assert.equal(assigned.length,2);assert.equal(new Set(assigned.map(h=>h.assigned_athlete_id)).size,2);
 const g=await grant(p);await pool.query('update library.program_access set plan_id=$2,user_id=$3 where id=$1',[g,q.id,owner]);const target=await holds(q);assert.equal(target.length,1);assert.equal(target[0].beneficiary_user_id,owner);assert.equal(target[0].source_plan_id,q.id);assert.equal((await holds(p)).length,3);
});

test('grant inserted before media captures newly added snapshot; repeated calls do not duplicate manifests',async()=>{
 const p=await plan();await grant(p);assert.equal((await holds(p)).length,0);const a=await asset(),i=await item(p,a);await pool.query("update plans.plan_items set note='changed' where id=$1",[i]);await transaction(async c=>{await c.query('select media.l1_capture_plan($1)',[p.id]);await c.query('select media.l1_capture_plan($1)',[p.id]);});const h=await holds(p);assert.equal(h.length,1);assert.equal((await pool.query('select count(*) from media.hold_assets where hold_id=$1',[h[0].id])).rows[0].count,'1');
});
test('source exercise deletion and inactive owner/club do not remove legitimate plan media',async()=>{
 const p=await plan(true),a=await asset(),e=(await pool.query("insert into library.exercises(owner_user_id,video_source,video_asset_id) values($1,'asset',$2) returning id",[owner,a])).rows[0].id,i=await item(p,a);await pool.query('update plans.plan_items set exercise_id=$2 where id=$1',[i,e]);await pool.query('delete from library.exercises where id=$1',[e]);await pool.query('update public.users set is_active=false where id=$1',[owner]);await pool.query('update public.clubs set is_active=false where id=$1',[club]);assert.equal((await pool.query('select video_asset_id from plans.plan_items where id=$1',[i])).rows[0].video_asset_id,a);await assert.rejects(pool.query('delete from public.users where id=$1',[viewer]),e=>['23503','P7502'].includes(e.code));await assert.rejects(pool.query('delete from public.users where id=$1',[owner]),e=>['23503','P7502'].includes(e.code));
});
test('new snapshot copy preserves IDs, while status/key changes fail for live references',async()=>{
 const a=await asset(),p=await plan(),i=await item(p,a),q=await plan();await pool.query('insert into plans.plan_items(plan_session_id,video_source,video_asset_id) select $1,video_source,video_asset_id from plans.plan_items where id=$2',[q.session,i]);await rejectCode(pool.query("update media.assets set status='deleted' where id=$1",[a]),'P7502');await rejectCode(pool.query("update media.assets set object_key='replaced-key' where id=$1",[a]),'P7502');await rejectCode(pool.query("update media.assets set kind='image' where id=$1",[a]),'P7502');await pool.query("update plans.plan_items set note='retained snapshot edit' where id=$1",[i]);
});
test('private tables/view/functions are closed; holds and audit are append-only',async()=>{
 assert.ok((await pool.query("select relrowsecurity from pg_class where oid in ('media.retention_holds'::regclass,'media.hold_assets'::regclass,'media.retention_events'::regclass)")).rows.every(r=>r.relrowsecurity));
 const c=new pg.Client({connectionString:dbUrl.toString(),options:'-c role='+outsider});await c.connect();try{await rejectCode(c.query('select * from media.asset_reference_matrix'),'42501');await rejectCode(c.query('select media.l1_capture_plan($1)',[seededPlan.id]),'42501');}finally{await c.end();}
 for(const table of ['retention_holds','hold_assets','retention_events']){await rejectCode(pool.query('delete from media.'+table),'42501');}
 await rejectCode(pool.query('truncate media.retention_holds,media.hold_assets,media.retention_events'),'42501');
 const service=createMediaReferenceService(pool);await assert.rejects(service.inspect({},seededAsset),e=>e.status===401);
 await assert.rejects(service.inspect({user:{id:viewer},authz:{platformRoles:[]}},seededAsset),e=>e.status===403);const result=await service.inspect({user:{id:owner},authz:{platformRoles:['platform_admin']}},seededAsset);assert.equal(result.protected,true);assert.ok(!JSON.stringify(result).includes('test/'));assert.equal(mediaRetentionDatabaseError({code:'P7501'}).status,409);
});

async function waitBlocked(pid) {
 for(let n=0;n<100;n++) {const r=await pool.query('select cardinality(pg_blocking_pids($1))>0 as blocked',[pid]);if(r.rows[0].blocked)return;await new Promise(r=>setTimeout(r,10));}
 throw new Error('Expected blocking transaction was not observed');
}
async function race(first,second,expected,tag) {
 const a=await pool.connect(),b=await pool.connect();let pending;
 try {await a.query('begin');await b.query('begin');await b.query("set local lock_timeout='5s'");const pid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;await first(a);
 pending=second(b,tag).then(r=>({result:r}),error=>({error}));await waitBlocked(pid);await a.query('commit');const r=await pending;assert.equal(r.error?.code,expected);await b.query('rollback');
 } finally {await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending;a.release();b.release();}
}
test('concurrency: a committed new reference wins over a waiting unavailable-status transition',async()=>{
 const a=await asset(),p=await plan();await race(c=>c.query("insert into plans.plan_items(plan_session_id,video_source,video_asset_id) values($1,'asset',$2)",[p.session,a]),
 (c,t)=>c.query(`/* ${t} */ update media.assets set status='deleting' where id=$1`,[a]),'P7502','l1_ref_wins');assert.equal((await pool.query('select status from media.assets where id=$1',[a])).rows[0].status,'ready');
});
test('concurrency: an unavailable-status transition wins and the waiting new reference is rejected',async()=>{
 const a=await asset(),p=await plan();await race(c=>c.query("update media.assets set status='deleting' where id=$1",[a]),
 (c,t)=>c.query(`/* ${t} */ insert into plans.plan_items(plan_session_id,video_source,video_asset_id) values($1,'asset',$2)`,[p.session,a]),'P7501','l1_status_wins');assert.equal((await pool.query('select count(*) from plans.plan_items where video_asset_id=$1',[a])).rows[0].count,'0');
});
test('concurrency: a waiting plan deletion succeeds without removing the committed grant manifest',async()=>{
 const a=await asset(),p=await plan();await item(p,a);await race(c=>c.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'downloaded','accessed')",[p.id,viewer]),
 (c,t)=>c.query(`/* ${t} */ delete from plans.plans where id=$1`,[p.id]),undefined,'l1_grant_wins');assert.equal((await holds(p)).length,1);
});
test('concurrency: deleted plan cannot receive a successful grant or partial manifest',async()=>{
 const a=await asset(),p=await plan();await item(p,a);await race(c=>c.query('delete from plans.plans where id=$1',[p.id]),
 (c,t)=>c.query(`/* ${t} */ insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'downloaded','accessed')`,[p.id,viewer]),'23503','l1_delete_wins');assert.equal((await holds(p)).length,0);
});
test('concurrency: grant and new item serialize plan before assets without a lock inversion',async()=>{
 const a=await asset(),p=await plan();await item(p,a);const b=await asset();
 await race(c=>c.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'downloaded','accessed')",[p.id,viewer]),
 c=>c.query("insert into plans.plan_items(plan_session_id,video_source,video_asset_id) values($1,'asset',$2)",[p.session,b]),undefined,'l1_grant_item');
 await item(p,b);const h=await holds(p);assert.equal((await pool.query('select count(distinct asset_id) from media.hold_assets where hold_id=$1',[h[0].id])).rows[0].count,'2');
});

test('revoke/reject never wait for a plan lock held by a concurrent plan DELETE',async()=>{
 for(const action of ['delete','reject']){const p=await plan(),a=await asset();await item(p,a);const g=await grant(p),h=await holds(p),deleter=await pool.connect(),revoker=await pool.connect();
 try{await deleter.query('begin');await deleter.query('select id from plans.plans where id=$1 for update',[p.id]);await revoker.query('begin');await revoker.query("set local lock_timeout='250ms'");
 if(action==='delete')await revoker.query('delete from library.program_access where id=$1',[g]);else await revoker.query("update library.program_access set status='rejected' where id=$1",[g]);
 await revoker.query('commit');await deleter.query('delete from plans.plans where id=$1',[p.id]);await deleter.query('commit');assert.equal((await holds(p))[0].id,h[0].id);
 }finally{await deleter.query('rollback');await revoker.query('rollback');deleter.release();revoker.release();}}
});

test('repeatable-read cannot use a stale snapshot to bypass new-reference/status checks',async()=>{
 const a=await asset(),p=await plan();const c=await pool.connect();try{await c.query('begin isolation level repeatable read');await rejectCode(c.query("insert into plans.plan_items(plan_session_id,video_source,video_asset_id) values($1,'asset',$2)",[p.session,a]),'P7503');await c.query('rollback');await c.query('begin isolation level repeatable read');await rejectCode(c.query("update media.assets set status='deleting' where id=$1",[a]),'P7503');}finally{await c.query('rollback');c.release();}
});
test('item/session/day relocation captures the receiving assigned-plan right and preserves prior manifests',async()=>{
 for(const level of ['item','session','day']){const a=await asset(),p=await plan(),target=await plan(true),i=await item(p,a);assert.equal((await holds(target)).length,0);
 if(level==='item')await pool.query('update plans.plan_items set plan_session_id=$2 where id=$1',[i,target.session]);
 if(level==='session')await pool.query('update plans.plan_sessions set plan_day_id=(select plan_day_id from plans.plan_sessions where id=$2) where id=$1',[p.session,target.session]);
 if(level==='day')await pool.query('update plans.plan_days set plan_id=$2 where id=(select plan_day_id from plans.plan_sessions where id=$1)',[p.session,target.id]);
 const h=await holds(target);assert.equal(h.length,1);assert.equal((await pool.query('select count(*) from media.hold_assets where hold_id=$1 and asset_id=$2',[h[0].id,a])).rows[0].count,'1');}
});
test('historical usage events alone do not create retention holds; ordinary unassigned draft remains deletable',async()=>{
 const p=await plan(),a=await asset();await item(p,a);const g=await grant(p,'downloaded','rejected');await pool.query("insert into library.program_usage_events(program_access_id,event_type) values($1,'completed')",[g]);assert.equal((await holds(p)).length,0);await pool.query('delete from plans.plans where id=$1',[p.id]);assert.equal((await pool.query('select status from media.assets where id=$1',[a])).rows[0].status,'ready');
});

test('detached manifests survive deletion of beneficiary, athlete and source owner business rows',async()=>{
 const beneficiary=randomUUID();await pool.query('insert into public.users(id) values($1)',[beneficiary]);
 const p=await plan();await item(p,await asset());await grant(p,'downloaded','accessed',null,beneficiary);await pool.query('delete from public.users where id=$1',[beneficiary]);assert.equal((await holds(p))[0].beneficiary_user_id,beneficiary);
 const sport=randomUUID();await pool.query('insert into public.athletes(id) values($1)',[sport]);const q=await plan();await pool.query('update plans.plans set athlete_id=$2,is_template=false where id=$1',[q.id,sport]);await item(q,await asset());await pool.query('delete from public.athletes where id=$1',[sport]);assert.equal((await holds(q))[0].assigned_athlete_id,sport);assert.equal((await pool.query('select count(*) from plans.plans where id=$1',[q.id])).rows[0].count,'0');
 const sourceOwner=randomUUID();await pool.query('insert into public.users(id) values($1)',[sourceOwner]);const r=await plan(true);await pool.query('update plans.plans set created_by_user_id=$2 where id=$1',[r.id,sourceOwner]);await item(r,await asset());await pool.query('delete from public.users where id=$1',[sourceOwner]);assert.equal((await holds(r))[0].source_owner_user_id,sourceOwner);
});

test('bulk item copy invokes delta membership capture once per item, not once per existing item',async()=>{
 // Transactional instrumentation exists only in this disposable fixture and is rolled back.
 const p=await plan(true),a=await asset(),c=await pool.connect();try{await c.query('begin');
 await c.query('create table media.l1_test_visits(id uuid)');
 await c.query('alter function media.l1_capture_members(uuid,uuid,uuid,uuid) rename to l1_capture_members_impl');
 await c.query(`create function media.l1_capture_members(h uuid,i uuid,v uuid,m uuid) returns void language plpgsql as $$ begin insert into media.l1_test_visits values(i);perform media.l1_capture_members_impl(h,i,v,m);end; $$`);
 const n=40;await c.query("insert into plans.plan_items(plan_session_id,video_source,video_asset_id) select $1,'asset',$2 from generate_series(1,$3)",[p.session,a,n]);assert.equal((await c.query('select count(*) from media.l1_test_visits')).rows[0].count,String(n));
 }finally{await c.query('rollback');c.release();}
});

test('BE-2 upload completion and cancellation retain their existing quota lifecycle with L1 guards',async()=>{
 const {createMediaStorageService}=await import('../src/mediaStorage.js'),{createMediaUploadService}=await import('../src/mediaUploads.js');
 const storage=createMediaStorageService(pool);const policy=await storage.getPolicy();await storage.updatePolicy(owner,{expectedRevision:policy.revision,reason:'Disposable upload fixture',changes:{defaultLimitBytes:'1000'}});
 const objects=new Map(),store={assertConfigured(){},async signPut(){return {url:'https://local.test/put',method:'PUT',headers:{}};},async head(key){return objects.get(key)||null;},async tombstone(key){objects.set(key,{sizeBytes:'0',mimeType:'application/octet-stream',etag:'zero',tombstone:true});}};
 const uploads=createMediaUploadService({pool,storage,store,inspect:async()=>({width:16,height:16,durationSeconds:1,videoCodec:'h264'})}),req={user:{id:owner},authz:{capabilities:{coachWorkspace:true}}};
 const start=()=>uploads.initiate(req,{context:{type:'exercise_create'},kind:'video',purpose:'exercise_video',file:{name:'test.mp4',mimeType:'video/mp4',sizeBytes:'20'}},randomUUID());
 const first=await start();const key=(await pool.query('select temporary_object_key from media.uploads where id=$1',[first.uploadId])).rows[0].temporary_object_key;objects.set(key,{sizeBytes:'20',mimeType:'video/mp4',etag:'valid',tombstone:false});assert.equal((await uploads.complete(req,first.uploadId)).body.media.status,'ready');
 const second=await start();assert.equal((await uploads.cancel(req,second.uploadId)).body.status,'cancelled');const usage=await storage.getAccount(account);assert.equal(usage.usedBytes,'20');assert.equal(usage.reservedBytes,'0');
});
