import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createDisposableDatabase} from './support/disposable-db.mjs';
import {createMediaStorageService} from '../src/mediaStorage.js';
import {createMediaUploadService} from '../src/mediaUploads.js';
import {createDriveCopyService,driveFileIdOf} from '../src/driveCopies.js';

const source=process.env.MEDIA_TEST_DATABASE_URL;
const l1='202610291000_media_reference_protection.sql',drive='202610291100_media_drive_copies.sql',bridge='202610291200_media_drive_reference_bridge.sql';
const fixture=`create schema library;create schema plans;
create table public.users(id uuid primary key);
create table public.clubs(id uuid primary key);
create table library.exercises(id uuid primary key default gen_random_uuid(),video_url text,image_url text);
create table plans.plans(id uuid primary key default gen_random_uuid(),created_by_user_id uuid,athlete_id uuid,is_template boolean default true,status text default 'active',is_active boolean default true);
create table plans.plan_days(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade);
create table plans.plan_sessions(id uuid primary key default gen_random_uuid(),plan_day_id uuid references plans.plan_days(id) on delete cascade);
create table plans.plan_items(id uuid primary key default gen_random_uuid(),plan_session_id uuid references plans.plan_sessions(id) on delete cascade,exercise_id uuid references library.exercises(id) on delete set null,video_url text,image_url text);
create table library.program_access(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade,user_id uuid,access_type text,status text,starts_at timestamptz,expires_at timestamptz,source text,license_snapshot jsonb);`;
const fileId=()=>randomUUID().replaceAll('-','');
const urlOf=id=>'https://drive.google.com/file/d/'+id+'/view';
const rejected=(promise,code)=>assert.rejects(promise,error=>error.code===code);

async function setup(order) {
 const database=await createDisposableDatabase({prefix:'drive_l1',label:order[0]===l1?'l1_first':'drive_first',baseDatabaseUrl:source});
 const admin=new pg.Client({connectionString:database.url});await admin.connect();
 const role='drive_l1_'+fileId();await admin.query(`create role ${role} nologin nosuperuser`);await admin.query(`grant ${role} to current_user`);await admin.query(`alter database ${database.name} owner to ${role}`);
 const pool=new pg.Pool({connectionString:database.url,options:'-c role='+role,max:12});
 async function tx(work) {const client=await pool.connect();try{await client.query('begin');await client.query("set local lock_timeout='3s'");await client.query("set local statement_timeout='8s'");const result=await work(client);await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}finally{client.release();}}
 const migration=async name=>tx(async client=>client.query(await readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8')));
 await pool.query(fixture);const actor=randomUUID(),beneficiary=randomUUID();await pool.query('insert into public.users values($1),($2)',[actor,beneficiary]);
 for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql',...order])await migration(name);
 const storage=createMediaStorageService(pool),copies=createDriveCopyService({pool});
 const account=await storage.ensureAccount({type:'platform'});await pool.query('update media.storage_accounts set override_limit_bytes=1000000 where id=$1',[account]);
 const req={user:{id:actor},authz:{platformRoles:['platform_admin'],capabilities:{coachWorkspace:true}}};
 const objects=new Map(),store={assertConfigured(){},async signPut(){return {};},async head(key){return objects.get(key);},async tombstone(key){objects.set(key,{tombstone:true,sizeBytes:'0'});}};
 let service=createMediaUploadService({pool,storage,store,driveCopies:copies,inspect:async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264'})});
 async function plan(id,assigned=true,existingClient=pool) {
  const result=(await existingClient.query('insert into plans.plans(created_by_user_id,athlete_id,is_template) values($1,$2,$3) returning id',[actor,assigned?randomUUID():null,!assigned])).rows[0];
  const day=(await existingClient.query('insert into plans.plan_days(plan_id) values($1) returning id',[result.id])).rows[0].id;
  const session=(await existingClient.query('insert into plans.plan_sessions(plan_day_id) values($1) returning id',[day])).rows[0].id;
  const item=(await existingClient.query('insert into plans.plan_items(plan_session_id,video_url) values($1,$2) returning id',[session,urlOf(id)])).rows[0].id;
  return {id:result.id,session,item};
 }
 async function asset(kind='video',status='ready') {return (await pool.query('insert into media.assets(object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,$3,$4,$5,60,$6) returning id',['fixture/'+fileId(),kind,account,actor,status,kind==='video'?'video/mp4':'image/png'])).rows[0].id;}
 async function map(id,mediaId,kind='video') {await tx(client=>client.query('insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,$2,$3,$4)',[id,kind,mediaId,actor]));}
 async function begin(id) {
  await pool.query('insert into library.exercises(video_url) values($1)',[urlOf(id)]);
  const started=await service.importInitiate(req,{driveFileId:id,kind:'video',file:{name:id+'.mp4',sizeBytes:'60',mimeType:'video/mp4'}},randomUUID());
  const upload=(await pool.query('select * from media.uploads where id=$1',[started.uploadId])).rows[0];objects.set(upload.temporary_object_key,{sizeBytes:'60',mimeType:'video/mp4',etag:'fixture'});return started;
 }
 const holds=async mediaId=>(await pool.query('select * from media.hold_assets where asset_id=$1',[mediaId])).rows;
 async function blocked(fragment) {
  for(let attempt=0;attempt<300;attempt++) {
   const result=await admin.query("select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and position($1 in query)>0",[fragment]);
   if(result.rowCount)return;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('No expected lock waiter: '+fragment);
 }
 async function close(){await pool.end();await admin.end();await database.drop();const maintenance=new pg.Client({connectionString:source});await maintenance.connect();try{await maintenance.query(`drop role ${role}`);}finally{await maintenance.end();}}
 return {pool,tx,migration,plan,asset,map,begin,holds,blocked,close,actor,beneficiary,req,copies,storage,account,get service(){return service;},set service(value){service=value;},store};
}

for(const order of [[l1,drive],[drive,l1]])test('integration '+order.join(' then '),async context=>{
 const env=await setup(order);
 try {
  const seededId=fileId(),seeded=await env.plan(seededId),seededAsset=await env.asset();await env.map(seededId,seededAsset);
  const ordinary=await env.plan(seededId,false);
  const ignoredGrant=await env.plan(seededId,false);
  await env.pool.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'purchased','requested')",[ignoredGrant.id,env.beneficiary]);
  await context.test('bridge migration is runner-compatible and rolls back functions, view and captured evidence atomically',async()=>{
   const sql=await readFile(new URL('../../migrations_v2/'+bridge,import.meta.url),'utf8');
   const {assertNoTransactionControl}=await import('../src/migrate.js');assertNoTransactionControl(sql);
   const before=(await env.pool.query("select pg_get_viewdef('media.asset_reference_matrix'::regclass) as definition")).rows[0].definition;
   const client=await env.pool.connect();
   try {
    await client.query('begin');await client.query(sql);
    assert.equal((await client.query('select count(*) from media.hold_assets where asset_id=$1',[seededAsset])).rows[0].count,'1');
    await client.query('rollback');
    assert.equal((await client.query("select to_regclass('media.l1_item_assets') as name")).rows[0].name,null);
    assert.equal((await client.query("select pg_get_viewdef('media.asset_reference_matrix'::regclass) as definition")).rows[0].definition,before);
    assert.equal((await env.holds(seededAsset)).length,0);
   } finally {await client.query('rollback');client.release();}
  });
  await env.migration(bridge);
  await context.test('existing maps backfill assigned plans only, preserve role privacy and quota',async()=>{
   const manifests=await env.holds(seededAsset);assert.equal(manifests.length,1);assert.equal(manifests[0].plan_item_id,seeded.item);
   assert.equal((await env.pool.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper,false);
   assert.equal((await env.storage.getAccount(env.account)).usedBytes,'0');
   assert.equal((await env.pool.query("select count(*) from information_schema.role_table_grants where table_schema='media' and grantee='PUBLIC'")).rows[0].count,'0');
   assert.equal((await env.pool.query('select count(*) from media.retention_holds where source_plan_id=any($1::uuid[])',[[ordinary.id,ignoredGrant.id]])).rows[0].count,'0');
  });
  await context.test('SQL parser matches legacy forms and rejects invalid ids',async()=>{
   for(const value of [urlOf(seededId),'https://drive.google.com/open?id='+seededId,'https://lh3.googleusercontent.com/d/'+seededId+'=w1000','https://example.com/','https://drive.google.com/file/d/short/view',null]) {
    assert.equal((await env.pool.query('select media.l1_drive_file_id($1) as id',[value])).rows[0].id,driveFileIdOf(value));
   }
  });
  await context.test('new import captures eligible legacy plans, never an unconditional import hold',async()=>{
   const id=fileId(),assigned=await env.plan(id),draft=await env.plan(id,false),upload=await env.begin(id);await env.service.complete(env.req,upload.uploadId);
   const manifests=await env.holds(upload.mediaId);assert.equal(manifests.length,1);assert.equal(manifests[0].plan_item_id,assigned.item);
   assert.equal((await env.pool.query('select count(*) from media.retention_holds where source_plan_id=$1',[draft.id])).rows[0].count,'0');
   await rejected(env.pool.query("update media.assets set status='deleting' where id=$1",[upload.mediaId]),'P7502');
   await rejected(env.pool.query("update media.assets set object_key='changed' where id=$1",[upload.mediaId]),'P7502');
  });
  await context.test('future legacy rows, grants and assignment capture resolved assets without rewriting snapshots',async()=>{
   const target=await env.plan(seededId),granted=await env.plan(seededId,false);
   assert.ok((await env.holds(seededAsset)).some(row=>row.plan_item_id===target.item));
   const grant=(await env.pool.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'downloaded','accessed') returning id",[granted.id,env.beneficiary])).rows[0].id;
   assert.ok((await env.holds(seededAsset)).some(row=>row.plan_item_id===granted.item));
   await env.pool.query('delete from library.program_access where id=$1',[grant]);await env.pool.query('delete from plans.plans where id=$1',[granted.id]);
   assert.ok((await env.holds(seededAsset)).some(row=>row.plan_item_id===granted.item));
   assert.deepEqual((await env.pool.query('select video_source,video_asset_id,video_url from plans.plan_items where id=$1',[target.item])).rows[0],{video_source:'legacy',video_asset_id:null,video_url:urlOf(seededId)});
   const assigned=await env.plan(seededId,false);await env.pool.query("update plans.plans set athlete_id=$2,is_template=false,status='active' where id=$1",[assigned.id,randomUUID()]);
   assert.ok((await env.holds(seededAsset)).some(row=>row.plan_item_id===assigned.item));
  });
  await context.test('mapping rollback preserves legitimate manifests; orphan history creates none',async()=>{
   await env.copies.remove(env.actor,'video',seededId,'integration rollback');
   await env.pool.query('delete from plans.plans where id=$1',[seeded.id]);assert.ok((await env.holds(seededAsset)).some(row=>row.plan_item_id===seeded.item));
   await rejected(env.pool.query("update media.assets set object_key='changed' where id=$1",[seededAsset]),'P7502');
   const id=fileId(),orphan=await env.asset();await env.map(id,orphan);assert.equal((await env.holds(orphan)).length,0);
   await rejected(env.pool.query("update media.assets set status='deleting' where id=$1",[orphan]),'P7502');
   await env.copies.remove(env.actor,'video',id,'orphan rollback');await env.pool.query("update media.assets set status='deleting' where id=$1",[orphan]);
  });
  await context.test('mapped images and subsequent URL changes capture independently by slot',async()=>{
   const videoId=fileId(),imageId=fileId(),target=await env.plan(videoId),image=await env.asset('image');
   await env.map(imageId,image,'image');
   await env.pool.query('update plans.plan_items set image_url=$2 where id=$1',[target.item,'https://lh3.googleusercontent.com/d/'+imageId+'=w1000']);
   const manifests=await env.holds(image);assert.equal(manifests.length,1);assert.equal(manifests[0].slot,'image');assert.equal(manifests[0].plan_item_id,target.item);
   await env.pool.query("update plans.plan_items set image_source='none' where id=$1",[target.item]);
   await env.copies.remove(env.actor,'image',imageId,'image rollback');
   await rejected(env.pool.query("update media.assets set object_key='changed' where id=$1",[image]),'P7502');
  });
  await context.test('repeatable-read cannot hide a newly committed map from a new legacy reference',async()=>{
   const id=fileId(),mediaId=await env.asset(),creator=await env.pool.connect();
   try {
    await creator.query('begin isolation level repeatable read');await creator.query('select count(*) from plans.plan_items');
    await env.map(id,mediaId);
    await rejected(env.plan(id,true,creator),'P7503');
   } finally {await creator.query('rollback');creator.release();}
   assert.equal((await env.holds(mediaId)).length,0);
  });
  await context.test('mapping inserts reject pending and wrong-kind assets',async()=>{
   await rejected(env.map(fileId(),await env.asset('video','pending')),'P7501');
   await rejected(env.map(fileId(),await env.asset('image')),'P7501');
  });
  await context.test('busy plan refuses import before upload or asset; deletion winning creates no ghost hold on retry',async()=>{
   const id=fileId(),target=await env.plan(id),upload=await env.begin(id),writer=await env.pool.connect();let completing;
   try {
    await writer.query('begin');await writer.query('select id from plans.plans where id=$1 for update',[target.id]);
    completing=env.service.complete(env.req,upload.uploadId);await assert.rejects(completing,error=>error.code==='55P03'&&error.message.startsWith('could not obtain lock on row'));
    await env.tx(async client=>{await client.query('select id from media.uploads where id=$1 for update nowait',[upload.uploadId]);await client.query('select id from media.assets where id=$1 for update nowait',[upload.mediaId]);});
    await writer.query('delete from plans.plans where id=$1',[target.id]);await writer.query('commit');assert.equal((await env.service.complete(env.req,upload.uploadId)).httpStatus,200);
    assert.equal((await env.holds(upload.mediaId)).length,0);
   } finally {await writer.query('rollback');writer.release();if(completing)await completing.catch(()=>{});}
  });
  await context.test('import winning preserves manifest through concurrent plan deletion',async()=>{
   const id=fileId(),target=await env.plan(id),upload=await env.begin(id);let arrived,release;
   const entered=new Promise(resolve=>{arrived=resolve;}),gate=new Promise(resolve=>{release=resolve;});
   const original=env.copies.insertCopy;env.copies.insertCopy=async(...args)=>{await original(...args);arrived();await gate;};let completing,deleting;
   try {
    completing=env.service.complete(env.req,upload.uploadId);await entered;
    deleting=env.pool.query('delete from plans.plans where id=$1',[target.id]);await env.blocked('delete from plans.plans');release();
    assert.equal((await completing).httpStatus,200);await deleting;
    assert.ok((await env.holds(upload.mediaId)).some(row=>row.plan_item_id===target.item));
   } finally {release();env.copies.insertCopy=original;if(completing)await completing.catch(()=>{});if(deleting)await deleting.catch(()=>{});}
  });
  await context.test('concurrent plan edit finishes before import and captures its final snapshot',async()=>{
   const id=fileId(),target=await env.plan(id),upload=await env.begin(id),writer=await env.pool.connect();let completing;
   try {
    await writer.query('begin');await writer.query('select id from plans.plans where id=$1 for update',[target.id]);
    completing=env.service.complete(env.req,upload.uploadId);await assert.rejects(completing,error=>error.code==='55P03'&&error.message.startsWith('could not obtain lock on row'));
    await writer.query("update plans.plan_items set video_source='none' where id=$1",[target.item]);await writer.query('commit');
    assert.equal((await env.service.complete(env.req,upload.uploadId)).httpStatus,200);assert.equal((await env.holds(upload.mediaId)).length,0);
   } finally {await writer.query('rollback');writer.release();if(completing)await completing.catch(()=>{});}
  });
  await context.test('new uncommitted plan waits for mapping then captures under READ COMMITTED',async()=>{
   const id=fileId(),upload=await env.begin(id),blocker=await env.pool.connect(),creator=await env.pool.connect();let completing,creating;
   try {
    await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['drive-copy:'+id+':video']);
    completing=env.service.complete(env.req,upload.uploadId);await env.blocked('l1_lock_drive_import');
    await creator.query('begin');creating=env.plan(id,true,creator);await env.blocked('insert into plans.plan_items');
    await blocker.query('commit');assert.equal((await completing).httpStatus,200);const target=await creating;await creator.query('commit');
    assert.ok((await env.holds(upload.mediaId)).some(row=>row.plan_item_id===target.item));
   } finally {await blocker.query('rollback');await creator.query('rollback');blocker.release();creator.release();if(completing)await completing.catch(()=>{});if(creating)await creating.catch(()=>{});}
  });
  await context.test('reference set changing while import waits retries without charging or reversing locks',async()=>{
   const id=fileId(),upload=await env.begin(id),blocker=await env.pool.connect(),creator=await env.pool.connect();let completing,creating;
   try {
    await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['drive-copy:'+id+':video']);
    await creator.query('begin');creating=env.plan(id,true,creator);await env.blocked('insert into plans.plan_items');
    completing=env.service.complete(env.req,upload.uploadId);const refused=rejected(completing,'40001');await env.blocked('l1_lock_drive_import');
    await blocker.query('commit');const target=await creating;await creator.query('commit');await refused;
    assert.equal((await env.pool.query('select status from media.uploads where id=$1',[upload.uploadId])).rows[0].status,'reserved');
    assert.equal((await env.pool.query('select status from media.assets where id=$1',[upload.mediaId])).rows[0].status,'pending');
    assert.equal((await env.pool.query('select count(*) from media.drive_copies where asset_id=$1',[upload.mediaId])).rows[0].count,'0');
    assert.equal((await env.service.complete(env.req,upload.uploadId)).httpStatus,200);
    assert.ok((await env.holds(upload.mediaId)).some(row=>row.plan_item_id===target.item));
   } finally {await blocker.query('rollback');await creator.query('rollback');blocker.release();creator.release();if(completing)await completing.catch(()=>{});if(creating)await creating.catch(()=>{});}
  });
  await context.test('mapped reference wins over waiting status/key transitions and unavailable asset rejects mapping',async()=>{
   for(const column of ['status','object_key']) {
    const id=fileId(),mediaId=await env.asset(),writer=await env.pool.connect(),changer=await env.pool.connect();let changing;
    try {
     await writer.query('begin');await writer.query('insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,\'video\',$2,$3)',[id,mediaId,env.actor]);
     changing=changer.query(`update media.assets set ${column}=$2 where id=$1`,[mediaId,column==='status'?'deleting':'changed']);const refused=rejected(changing,'P7502');
     await env.blocked('update media.assets');await writer.query('commit');await refused;
    } finally {await writer.query('rollback');writer.release();changer.release();if(changing)await changing.catch(()=>{});}
   }
   const id=fileId(),mediaId=await env.asset(),changer=await env.pool.connect();let inserting;
   try {
    await changer.query('begin');await changer.query("update media.assets set status='deleting' where id=$1",[mediaId]);
    inserting=env.map(id,mediaId);const refused=rejected(inserting,'P7501');await env.blocked('insert into media.drive_copies');
    await changer.query('commit');await refused;
   } finally {await changer.query('rollback');changer.release();if(inserting)await inserting.catch(()=>{});}
  });
  await context.test('parallel imports into one assigned plan serialize plans before their different assets',async()=>{
   const first=fileId(),second=fileId(),target=await env.plan(first);
   const secondItem=(await env.pool.query('insert into plans.plan_items(plan_session_id,video_url) values($1,$2) returning id',[target.session,urlOf(second)])).rows[0].id;
   const uploads=await Promise.all([env.begin(first),env.begin(second)]);
   const outcomes=await Promise.all(uploads.map(async upload=>{
    for(let attempt=0;attempt<5;attempt++)try{return await env.service.complete(env.req,upload.uploadId);}catch(error){if(!['55P03','40001'].includes(error.code)||attempt===4)throw error;await new Promise(resolve=>setTimeout(resolve,10));}
   }));assert.ok(outcomes.every(result=>result.httpStatus===200));
   assert.ok((await env.holds(uploads[0].mediaId)).some(row=>row.plan_item_id===target.item));
   assert.ok((await env.holds(uploads[1].mediaId)).some(row=>row.plan_item_id===secondItem));
  });
  await context.test('no measured deadlocks',async()=>{assert.equal((await env.pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks,'0');});
 } finally {await env.close();}
});

// Validate the operator SQL on a non-superuser disposable DB at every possible
// committed prefix. No production connection or production fixture is used.
test('read-only preflight executes at all four migration prefixes',async context=>{
 const database=await createDisposableDatabase({prefix:'drive_preflight',label:'prefixes',baseDatabaseUrl:source});
 const admin=new pg.Client({connectionString:database.url});await admin.connect();
 const role='drive_preflight_'+fileId();let pool;
 try {
  await admin.query(`create role ${role} nologin nosuperuser`);await admin.query(`grant ${role} to current_user`);
  pool=new pg.Pool({connectionString:database.url,options:'-c role='+role});
  await admin.query(`grant all on schema public to ${role}`);
  await admin.query(`grant create on database ${database.name} to ${role}`);
  await pool.query(fixture);
  await pool.query('create table public.schema_migrations(migration_name text,checksum text,execution_time_ms bigint,runner_version text)');
  const migrate=async name=>{const c=await pool.connect();try{await c.query('begin');await c.query(await readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8'));await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
  for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql'])await migrate(name);
  const sql=await readFile(new URL('../../docs/runbooks/r2-l1-preflight.sql',import.meta.url),'utf8');
  const [a,rest]=sql.split('-- STAGE B:'),[b,c]=rest.split('-- STAGE C:');
  for(const [index,name] of [null,l1,drive,bridge].entries()) {
   if(name)await migrate(name);
   if(index===2) {
    const actor=randomUUID(),asset=randomUUID(),driveId=fileId();
    await pool.query('insert into public.users values($1)',[actor]);
    const account=await createMediaStorageService(pool).ensureAccount({type:'platform'});
    await pool.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,'video',$3,$4,'ready',60,'video/mp4')",[asset,'fixture/'+asset,account,actor]);
    const plan=(await pool.query('insert into plans.plans(created_by_user_id,athlete_id,is_template) values($1,$2,false) returning id',[actor,randomUUID()])).rows[0].id;
    const day=(await pool.query('insert into plans.plan_days(plan_id) values($1) returning id',[plan])).rows[0].id;
    const session=(await pool.query('insert into plans.plan_sessions(plan_day_id) values($1) returning id',[day])).rows[0].id;
    await pool.query('insert into plans.plan_items(plan_session_id,video_url) values($1,$2)',[session,urlOf(driveId)]);
    await pool.query("insert into library.program_access(plan_id,user_id,access_type,status) values($1,$2,'assigned','accessed')",[plan,actor]);
    await pool.query("insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,'video',$2,$3)",[driveId,asset,actor]);
   }
   await context.test(['none','L1','L1 + Drive','all three'][index],async()=>{
    const client=await pool.connect();
    try {
     await client.query(a);
     if(index>=2) {
      const results=await client.query(b.slice(b.indexOf('\nbegin read only;')));
      const scale=results.find(result=>result.rows[0]?.effective_item_slots!==undefined).rows[0];
      assert.equal(scale.mapped_legacy_slots,'1');assert.equal(scale.manifest_member_upper_bound,'2');
      assert.equal(scale.largest_plan_manifest_upper_bound,'2');
     }
     await client.query(c.slice(c.indexOf('\nbegin read only;')));
    } finally {await client.query('rollback');client.release();}
   });
  }
 } finally {
  if(pool)await pool.end();await admin.end();await database.drop();
  const maintenance=new pg.Client({connectionString:source});await maintenance.connect();
  try{await maintenance.query(`drop role ${role}`);}finally{await maintenance.end();}
 }
});
