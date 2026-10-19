import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import { createMediaStorageService, MediaStorageError } from '../src/mediaStorage.js';

// Explicit local-only URL; never load application .env or use DATABASE_URL.
// All writes are confined to this uniquely named disposable database.
const input = process.env.MEDIA_TEST_DATABASE_URL;
if (!input) throw new Error('Set MEDIA_TEST_DATABASE_URL to a local disposable-DB-capable PostgreSQL connection.');
const base = new URL(input);
if (!['localhost','127.0.0.1','::1','[::1]'].includes(base.hostname) || base.search) throw new Error('Refusing non-local or URL-option-bearing test connection.');
const runId = randomUUID().replaceAll('-','').slice(0,16);
const dbName = `optimove_media_be1_test_${runId}`;
const roleName = `media_be1_role_${runId}`;
const adminUrl = new URL(base); adminUrl.pathname='/postgres';
const testUrl = new URL(base); testUrl.pathname=`/${dbName}`;
const admin = new pg.Client({connectionString:adminUrl.toString()});
let pool,service,server,root,routerFactory,roleCreated=false,dbCreated=false;
const ownerId=randomUUID(), actorId=randomUUID(), otherId=randomUUID(), clubId=randomUUID();
let accountId;
const fixture = `
create schema library; create schema plans;
create table public.users(id uuid primary key);
create table public.clubs(id uuid primary key);
create table library.exercises(id uuid primary key,video_url text,image_url text);
create table plans.plan_items(id uuid primary key,exercise_id uuid references library.exercises(id),video_url text,image_url text);
`;
const exerciseId=randomUUID(),itemId=randomUUID();
const contexts = {
  admin: {user:{id:actorId},authz:{platformRoles:['platform_admin'],clubRoles:[],capabilities:{coachWorkspace:true}}},
  coach: {user:{id:ownerId},authz:{platformRoles:[],clubRoles:[],capabilities:{coachWorkspace:true}}},
  clubAdmin: {user:{id:ownerId},authz:{platformRoles:[],clubRoles:[{role:'club_admin',clubId}],capabilities:{coachWorkspace:true}}},
  athlete: {user:{id:otherId},authz:{platformRoles:[],clubRoles:[],capabilities:{coachWorkspace:false}}},
  spoof: {user:{id:otherId,role_hint:'platform_admin'},authz:{platformRoles:[],clubRoles:[],capabilities:{coachWorkspace:true}}}
};
let enabled=true;
async function http(path,{actor='admin',method='GET',body}={}) {
  return fetch(root+path,{method,headers:{'Content-Type':'application/json','X-Test-Actor':actor},body:body===undefined?undefined:JSON.stringify(body)});
}
async function setLimit(value) {
  const row=await service.getAccount(accountId);
  return service.updateLimit(actorId,accountId,{limitBytes:value,expectedRevision:row.revision,reason:'test limit'});
}
async function reserve(overrides={}) {
  return service.reserveUpload({storageAccountId:accountId,uploadedByUserId:ownerId,idempotencyKey:randomUUID(),kind:'video',purpose:'exercise_video',sizeBytes:'60',mimeType:'video/mp4',context:{type:'exercise_create'},ttlSeconds:60,...overrides});
}
before(async()=>{
  await admin.connect();
  await admin.query(`create role ${roleName} nologin nosuperuser nocreatedb nocreaterole noinherit`); roleCreated=true;
  await admin.query(`grant ${roleName} to current_user`);
  await admin.query(`create database ${dbName} owner ${roleName}`); dbCreated=true;
  pool=new pg.Pool({connectionString:testUrl.toString(),options:`-c role=${roleName}`,max:12});
  await pool.query(fixture);
  await pool.query('insert into public.users values ($1),($2),($3)',[ownerId,actorId,otherId]);
  await pool.query('insert into public.clubs values ($1)',[clubId]);
  await pool.query('insert into library.exercises values ($1,$2,$3)',[exerciseId,'drive-original','image-original']);
  await pool.query('insert into plans.plan_items values ($1,$2,$3,$4)',[itemId,exerciseId,'intentional-override','plan-image']);
  const migration=await fs.readFile(new URL('../../migrations_v2/202610191100_media_storage_foundation.sql',import.meta.url),'utf8');
  // Runner lexer only; do not run the complete migration history.
  process.env.DATABASE_URL=testUrl.toString();
  const runner=await import('../src/migrate.js'); runner.assertNoTransactionControl(migration);
  const c=await pool.connect(); try {await c.query('begin'); await c.query(migration); await c.query('commit');} catch(e){await c.query('rollback');throw e;}finally{c.release();}
  service=createMediaStorageService(pool);
  accountId=await service.ensureAccount({type:'user',id:ownerId});
  ({createMediaStorageRouter:routerFactory}=await import('../src/routes/mediaStorage.js'));
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{Object.assign(req,contexts[req.headers['x-test-actor']]||{});next();});
  app.use('/api/media',routerFactory({service,enabled:()=>enabled}));
  app.use('/api/admin/media',routerFactory({service,enabled:()=>enabled,admin:true}));
  app.use((_e,_req,res,_next)=>res.status(500).json({code:'unexpected_error'}));
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); root=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{
  if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(pool) await pool.end();
  if(dbCreated) await admin.query(`drop database ${dbName} with (force)`);
  if(roleCreated) await admin.query(`drop role ${roleName}`);
  await admin.end();
});

test('migration works as non-superuser; legacy URLs and program override are untouched',async()=>{
  const role=(await pool.query('select current_user,rolsuper from pg_roles where rolname=current_user')).rows[0]; assert.equal(role.rolsuper,false);
  const e=(await pool.query('select * from library.exercises')).rows[0]; const i=(await pool.query('select * from plans.plan_items')).rows[0];
  assert.equal(e.video_url,'drive-original');assert.equal(e.image_url,'image-original');assert.equal(e.video_source,'legacy');
  assert.equal(i.video_url,'intentional-override');assert.equal(i.image_url,'plan-image');assert.equal(i.video_asset_id,null);
  assert.equal((await service.getAccount(accountId)).limitBytes,'0');
});
test('private schema has RLS, no PUBLIC privileges and no Data API role grants',async()=>{
  const rows=(await pool.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='media' and relkind='r'")).rows;
  assert.equal(rows.length,5);assert.ok(rows.every(r=>r.relrowsecurity));
  const grants=(await pool.query("select * from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where n.nspname='media' and a.grantee=0")).rows;
  assert.equal(grants.length,0);
  const roles=(await pool.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).rows;
  for(const r of roles) assert.equal((await pool.query("select has_schema_privilege($1,'media','USAGE') as allowed",[r.rolname])).rows[0].allowed,false);
});
test('feature disabled performs no service calls and does not require R2 credentials',async()=>{
  const app=express();app.use((req,_res,next)=>{req.user={id:actorId};next();});
  app.use(routerFactory({service:new Proxy({},{get(){throw new Error('must not access service');}}),enabled:()=>false,admin:true}));
  const s=app.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));
  try{const r=await fetch(`http://127.0.0.1:${s.address().port}/storage-policy`);assert.equal(r.status,503);assert.equal((await r.json()).code,'media_storage_disabled');}
  finally{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
});
test('admin routes reject anonymous, athlete, coach and role_hint spoof',async()=>{
  for(const [actor,status] of [['missing',401],['athlete',403],['coach',403],['spoof',403]]) {
    for(const [method,path,body] of [['GET','/storage-policy'],['PATCH','/storage-policy',{}],['POST','/storage-accounts',{owner:{type:'user',id:otherId}}],['GET','/storage-limit-audit'],['PATCH',`/storage-accounts/${accountId}/limit`,{}]]) {
      assert.equal((await http('/api/admin/media'+path,{actor,method,body})).status,status);
    }
  }
});
test('usage is scoped to own user and actual club roles; athletes cannot allocate',async()=>{
  const clubAccount=await service.ensureAccount({type:'club',id:clubId});
  const own=await(await http('/api/media/storage',{actor:'coach'})).json();assert.deepEqual(own.accounts.map(a=>a.storageAccountId),[accountId]);
  const club=await(await http('/api/media/storage',{actor:'clubAdmin'})).json();assert.equal(club.accounts.length,2);assert.ok(club.accounts.some(a=>a.storageAccountId===clubAccount));
  assert.equal((await http('/api/media/storage',{actor:'athlete'})).status,403);
});
test('admin policy/override audit is transactional, revision protected and resettable',async()=>{
  let r=await http('/api/admin/media/storage-policy',{method:'PATCH',body:{changes:{defaultLimitBytes:'500',maxParallelUploads:2},expectedRevision:1,reason:'initial allocation'}});
  assert.equal(r.status,200);assert.equal((await r.json()).revision,2);
  r=await http('/api/admin/media/storage-policy',{method:'PATCH',body:{changes:{defaultLimitBytes:'900'},expectedRevision:1,reason:'stale'}});assert.equal(r.status,409);
  const before=(await service.listAudit()).entries.length;
  await assert.rejects(service.updatePolicy(randomUUID(),{changes:{defaultLimitBytes:'999'},expectedRevision:2,reason:'invalid actor'}),e=>e.code==='23503');
  assert.equal((await service.getPolicy()).policy.defaultLimitBytes,'500');assert.equal((await service.listAudit()).entries.length,before);
  let a=await setLimit('100');assert.equal(a.limitSource,'override');a=await setLimit(null);assert.equal(a.limitBytes,'500');assert.equal(a.limitSource,'default');
});
test('parallel reservations cannot exceed quota; retries do not double reserve',async()=>{
  await setLimit('100');
  const result=await Promise.allSettled([reserve(),reserve()]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.find(r=>r.status==='rejected').reason.code,'storage_quota_exceeded');
  const u=result.find(r=>r.status==='fulfilled').value;
  const same=await reserve({idempotencyKey:u.idempotency_key});assert.equal(same.id,u.id);
  assert.equal((await service.getAccount(accountId)).reservedBytes,'60');
  await assert.rejects(reserve({idempotencyKey:u.idempotency_key,sizeBytes:'61'}),e=>e.code==='idempotency_conflict');
  await assert.rejects(service.releaseAfterCleanup(u.id),e=>e.code==='cleanup_required');
  await Promise.all([service.releaseAfterCleanup(u.id,{cleanupVerified:true}),service.releaseAfterCleanup(u.id,{cleanupVerified:true})]);
  assert.equal((await service.getAccount(accountId)).reservedBytes,'0');
});
test('concurrent identical idempotency keys across accounts produce one reservation',async()=>{
  const key=randomUUID();const r=await Promise.all([reserve({idempotencyKey:key}),reserve({idempotencyKey:key})]);assert.equal(r[0].id,r[1].id);
  const another=await service.ensureAccount({type:'user',id:otherId});
  await assert.rejects(reserve({idempotencyKey:key,storageAccountId:another}),e=>e.code==='idempotency_conflict');
  await service.releaseAfterCleanup(r[0].id,{cleanupVerified:true});
});
test('parallel slot cap includes expired but uncleaned uploads',async()=>{
  await setLimit('500');
  const r=await Promise.allSettled([reserve(),reserve(),reserve()]);assert.equal(r.filter(x=>x.status==='fulfilled').length,2);
  assert.equal(r.find(x=>x.status==='rejected').reason.code,'parallel_upload_limit');
  const uploads=r.filter(x=>x.status==='fulfilled').map(x=>x.value);
  await pool.query("update media.uploads set expires_at=now()-interval '1 hour' where id=any($1::uuid[])",[uploads.map(u=>u.id)]);
  await assert.rejects(reserve(),e=>e.code==='parallel_upload_limit');
  for(const u of uploads) await service.releaseAfterCleanup(u.id,{cleanupVerified:true});
});
test('confirmed accounting is idempotent; reducing limit retains media and blocks new space',async()=>{
  const u=await reserve();await assert.rejects(service.commitVerifiedUpload(u.id,{sizeBytes:'61',mimeType:'video/mp4',metadata:{}}),e=>e.code==='media_verification_failed');
  const verified={sizeBytes:'60',mimeType:'video/mp4',metadata:{durationSeconds:2}};
  await Promise.all([service.commitVerifiedUpload(u.id,verified),service.commitVerifiedUpload(u.id,verified)]);
  const a=await setLimit('20');assert.equal(a.usedBytes,'60');assert.equal(a.reservedBytes,'0');assert.equal(a.availableBytes,'0');assert.equal(a.overLimit,true);
  await assert.rejects(reserve(),e=>e.code==='storage_quota_exceeded');
  assert.equal((await pool.query('select status from media.assets where id=$1',[u.asset_id])).rows[0].status,'ready');
  await assert.rejects(service.releaseAfterCleanup(u.id,{cleanupVerified:true}),e=>e.code==='upload_already_completed');
  await setLimit('500');
});
test('images and thumbnails consume the same account; cancellation cannot be completed',async()=>{
  const u=await reserve({kind:'image',purpose:'automatic_thumbnail',sizeBytes:'10',mimeType:'image/webp'});
  assert.equal((await service.getAccount(accountId)).reservedBytes,'10');
  await service.releaseAfterCleanup(u.id,{cleanupVerified:true});
  await assert.rejects(service.commitVerifiedUpload(u.id,{sizeBytes:'10',mimeType:'image/webp',metadata:{}}),e=>e.code==='state_conflict');
});
test('file limits, unsupported MIME and malformed byte counts fail before reservation',async()=>{
  await assert.rejects(reserve({sizeBytes:'209715201'}),e=>e.code==='file_too_large');
  await assert.rejects(reserve({mimeType:'video/quicktime'}),e=>e.code==='unsupported_media');
  await assert.rejects(reserve({sizeBytes:60}),e=>e.code==='invalid_request');
  await assert.rejects(reserve({sizeBytes:'9223372036854775808'}),e=>e.code==='invalid_request');
  assert.equal((await service.getAccount(accountId)).reservedBytes,'0');
});
test('references prevent physical asset record deletion; no cascade into programs',async()=>{
  const asset=(await pool.query("select id from media.assets where status='ready' limit 1")).rows[0].id;
  await pool.query("update plans.plan_items set video_source='asset',video_asset_id=$2 where id=$1",[itemId,asset]);
  await assert.rejects(pool.query('delete from media.assets where id=$1',[asset]),e=>e.code==='23503');
  assert.equal((await pool.query('select video_url from plans.plan_items where id=$1',[itemId])).rows[0].video_url,'intentional-override');
});
test('audit is append-only and cursor pagination does not lose sub-millisecond rows',async()=>{
  await assert.rejects(pool.query("update media.storage_limit_audit set reason='tampered'"),e=>e.code==='42501');
  await assert.rejects(pool.query('truncate media.storage_limit_audit'),e=>e.code==='42501');
  const expected=(await service.listAudit({limit:100})).entries.map(r=>r.id);let cursor,actual=[];
  do{const page=await service.listAudit({limit:1,cursor});actual.push(...page.entries.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(actual,expected);
  const accounts=await service.listAccounts({limit:1});assert.equal(accounts.accounts.length,1);assert.ok(accounts.nextCursor);
  const next=await service.listAccounts({limit:100,cursor:accounts.nextCursor});assert.ok(next.accounts.every(a=>a.storageAccountId!==accounts.accounts[0].storageAccountId));
});
