import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import {createMediaStorageService,MediaStorageError} from '../src/mediaStorage.js';
import {createMediaUploadService} from '../src/mediaUploads.js';
import {createDriveCopyService,driveFileIdOf} from '../src/driveCopies.js';
import {inspectMedia,validateVideoTracks,DRIVE_IMPORT_MAX_VIDEO_SECONDS} from '../src/mediaInspection.js';

// The Drive import (migration 202610291100): a platform administrator copies a
// Google Drive file that exercises or plan items name in a legacy slot into the
// platform storage account; the copy row commits with its asset or not at all.
const input=process.env.MEDIA_TEST_DATABASE_URL;
if(!input)throw new Error('Set local MEDIA_TEST_DATABASE_URL.');
const base=new URL(input);if(!['localhost','127.0.0.1','::1','[::1]'].includes(base.hostname)||base.search)throw new Error('Refusing remote test database.');
const suffix=randomUUID().replaceAll('-','').slice(0,16),dbName='optimove_media_drive_test_'+suffix,roleName='media_drive_role_'+suffix;
let roleCreated=false,created=false;
const adminUrl=new URL(base);adminUrl.pathname='/postgres';const testUrl=new URL(base);testUrl.pathname='/'+dbName;
const dbAdmin=new pg.Client({connectionString:adminUrl.toString()});
let pool,storage,uploads,driveCopies,store,server,root,coachReq,adminReq,inspectImpl,inspectCalls;
const adminId=randomUUID(),coachId=randomUUID();
// A 40 s, 16x16, 1 fps H.264 MP4 (2 KB), made with ffmpeg: the real inspection reads it.
const LONG_40S_MP4='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';
const VIDEO_ID='1DriveVideoFile0000000000AB',IMAGE_ID='1DriveImageFile0000000000CD',PLAN_ONLY_ID='1PlanItemOnly00000000000EF',LH3_ID='1Lh3Picture000000000000GH';
const fixture=`create schema library;create schema plans;
create table public.users(id uuid primary key);create table public.clubs(id uuid primary key,is_active boolean default true);
create table public.user_global_roles(user_id uuid,role text,is_active boolean default true);
create table public.user_workspace_preferences(user_id uuid,workspace_type text);
create table library.exercises(id uuid primary key default gen_random_uuid(),owner_scope text default 'user',owner_user_id uuid,owner_club_id uuid,is_active boolean default true,source_exercise_id uuid,copy_parent_id uuid,video_url text,image_url text);
create table plans.plans(id uuid primary key default gen_random_uuid(),created_by_user_id uuid,athlete_id uuid,is_template boolean default true,status text default 'active',is_active boolean default true);
create table plans.plan_days(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade);
create table plans.plan_sessions(id uuid primary key default gen_random_uuid(),plan_day_id uuid references plans.plan_days(id) on delete cascade);
create table plans.plan_items(id uuid primary key default gen_random_uuid(),plan_session_id uuid references plans.plan_sessions(id) on delete cascade,exercise_id uuid references library.exercises(id),video_url text,image_url text);
create table library.program_access(id uuid primary key default gen_random_uuid(),plan_id uuid references plans.plans(id) on delete cascade,user_id uuid,access_type text,status text,starts_at timestamptz,expires_at timestamptz,source text,license_snapshot jsonb);
create table library.exercise_collections(id uuid primary key,access_all boolean default false,deleted_at timestamptz);
create table library.exercise_collection_items(exercise_id uuid,collection_id uuid);
create table library.exercise_collection_users(collection_id uuid,user_id uuid);`;
function memoryStore(){const objects=new Map();return {objects,
 assertConfigured(){},
 async signPut(u){return {method:'PUT',url:'https://private.invalid/'+u.id,headers:{'Content-Type':u.expected_mime_type,'If-None-Match':'*'},expiresAt:u.expires_at};},
 put(key,data,mime){if(objects.has(key))throw new Error('PreconditionFailed');objects.set(key,{data:Buffer.from(data),mime,tombstone:false});},
 async head(key){const o=objects.get(key);return o?{sizeBytes:String(o.data.length),mimeType:o.mime,etag:'"'+createHash('sha256').update(o.data).digest('hex')+'"',tombstone:o.tombstone}:null;},
 async read(key,offset,length){return objects.get(key).data.subarray(offset,offset+length);},
 async tombstone(key){objects.set(key,{data:Buffer.alloc(0),mime:'application/octet-stream',tombstone:true});}};}
const importBody=overrides=>({kind:'video',driveFileId:VIDEO_ID,file:{name:VIDEO_ID+'.mp4',sizeBytes:'60',mimeType:'video/mp4'},...overrides});
const start=(b=importBody(),actor=adminReq,key=randomUUID())=>uploads.importInitiate(actor,b,key);
const row=async id=>(await pool.query('select * from media.uploads where id=$1',[id])).rows[0];
async function put(u,size=60,mime='video/mp4'){const r=await row(u.uploadId);store.put(r.temporary_object_key,Buffer.alloc(size),mime);return r;}
async function platform(){return storage.getAccount(await storage.ensureAccount({type:'platform'}));}
async function http(path,{actor='admin',method='GET',body,key}={}){return fetch(root+path,{method,headers:{'Content-Type':'application/json','X-Test-Actor':actor,...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});}

before(async()=>{
 await dbAdmin.connect();await dbAdmin.query(`create role ${roleName} nologin nosuperuser nocreatedb nocreaterole noinherit`);roleCreated=true;await dbAdmin.query(`grant ${roleName} to current_user`);await dbAdmin.query(`create database ${dbName} owner ${roleName}`);created=true;
 pool=new pg.Pool({connectionString:testUrl.toString(),options:'-c role='+roleName,max:12});await pool.query(fixture);
 await pool.query('insert into public.users values($1),($2)',[adminId,coachId]);await pool.query("insert into public.user_global_roles values($1,'platform_admin',true)",[adminId]);
 for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql','202610291000_media_reference_protection.sql','202610291100_media_drive_copies.sql','202610291200_media_drive_reference_bridge.sql']){const sql=await fs.readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8');const c=await pool.connect();try{await c.query('begin');await c.query(sql);await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
 storage=createMediaStorageService(pool);await storage.updatePolicy(adminId,{expectedRevision:1,reason:'test allocation',changes:{defaultLimitBytes:'1000000',maxParallelUploads:2}});
 process.env.DATABASE_URL=testUrl.toString();const {createMediaStorageRouter}=await import('../src/routes/mediaStorage.js');
 const app=express();app.use(express.json());app.use((r,_s,next)=>{Object.assign(r,{admin:adminReq,coach:coachReq,athlete:{user:{id:coachId},authz:{capabilities:{coachWorkspace:false},platformRoles:[]}}}[r.headers['x-test-actor']]||{});next();});
 const lazy=name=>new Proxy({},{get:(_t,k)=>(...a)=>({uploads,driveCopies})[name][k](...a)});
 app.use('/api/admin/media',createMediaStorageRouter({service:storage,admin:true,uploads:lazy('uploads'),driveCopies:lazy('driveCopies'),enabled:()=>true}));
 app.use((_e,_r,s,_n)=>s.status(500).json({code:'unexpected_error'}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));root=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{
 // Each test starts with no copy and no import in flight (the event log is append-only and stays).
 await pool.query('delete from media.drive_copies');await pool.query("update media.uploads set status='cancelled' where status in ('reserved','verifying','cancelling')");
 await pool.query('delete from plans.plan_items');await pool.query('delete from library.exercises');
 await pool.query("insert into library.exercises(owner_scope,video_url,image_url) values('system',$1,$2)",[`https://drive.google.com/file/d/${VIDEO_ID}/view?usp=drive_link`,`https://drive.google.com/open?id=${IMAGE_ID}`]);
 const ex=(await pool.query("insert into library.exercises(owner_scope,owner_user_id,image_url) values('user',$1,$2) returning id",[coachId,`https://lh3.googleusercontent.com/d/${LH3_ID}=w1000`])).rows[0].id;
 await pool.query('insert into plans.plan_items(exercise_id,video_url) values($1,$2),($1,$3)',[ex,`https://drive.google.com/file/d/${PLAN_ONLY_ID}/view`,`https://drive.google.com/file/d/${VIDEO_ID}/view`]);
 const authz={platformRoles:[],clubRoles:[],capabilities:{coachWorkspace:true}};
 coachReq={user:{id:coachId},authz};adminReq={user:{id:adminId},authz:{...authz,platformRoles:['platform_admin']}};
 store=memoryStore();inspectCalls=[];inspectImpl=async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264',audioCodec:null});
 driveCopies=createDriveCopyService({pool});
 uploads=createMediaUploadService({pool,storage,store,driveCopies,inspect:(...a)=>{inspectCalls.push(a[3]);return inspectImpl(...a);}});
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(created)await dbAdmin.query(`drop database ${dbName} with(force)`);if(roleCreated)await dbAdmin.query(`drop role ${roleName}`);await dbAdmin.end();});

test('1. Drive links: every form the frontend reads names its file; anything else names none',()=>{
 assert.equal(driveFileIdOf(`https://drive.google.com/file/d/${VIDEO_ID}/view?usp=sharing`),VIDEO_ID);
 assert.equal(driveFileIdOf(`https://drive.google.com/open?id=${IMAGE_ID}`),IMAGE_ID);
 assert.equal(driveFileIdOf(`https://drive.google.com/uc?export=view&id=${IMAGE_ID}`),IMAGE_ID);
 assert.equal(driveFileIdOf(`https://lh3.googleusercontent.com/d/${LH3_ID}=w1000`),LH3_ID);
 for(const other of ['','https://youtu.be/dQw4w9WgXcQ','https://example.com/file/d/abc','https://drive.google.com/file/d/short/view','https://drive.google.com/file/d/bad%20id%20here000/view',null])assert.equal(driveFileIdOf(other),null);
});

test('2. the platform account: exactly one, owned by the platform, never a user or a club',async()=>{
 const a=await storage.ensureAccount({type:'platform'}),b=await storage.ensureAccount({type:'platform'});
 assert.equal(a,b);
 assert.deepEqual((await storage.getAccount(a)).owner,{type:'platform',id:null});
 assert.equal((await pool.query('select count(*)::int as n from media.storage_accounts where owner_platform')).rows[0].n,1);
});

test('3. only a platform administrator may import: a coach, an athlete and a spoofed role are refused, over the service and over HTTP',async()=>{
 await assert.rejects(start(importBody(),coachReq),e=>e.code==='operation_not_allowed');
 await assert.rejects(start(importBody(),{...coachReq,user:{...coachReq.user,role_hint:'platform_admin'}}),e=>e.code==='operation_not_allowed');
 for(const [actor,status] of [['none',401],['athlete',403],['coach',403]])assert.equal((await http('/api/admin/media/drive-import/status',{actor})).status,status);
 assert.equal((await http('/api/admin/media/drive-import/uploads',{actor:'coach',method:'POST',body:importBody(),key:randomUUID()})).status,403);
 assert.equal((await pool.query('select count(*)::int as n from media.uploads')).rows[0].n,0,'nothing reserved');
});

test('4. the file must be one a legacy slot names; malformed ids, kinds and types are refused before anything is reserved',async()=>{
 await assert.rejects(start(importBody({driveFileId:'1NotUsedAnywhere000000000ZZ'})),e=>e.code==='resource_not_found');
 await assert.rejects(start(importBody({driveFileId:'bad id'})),e=>e.code==='invalid_request');
 await assert.rejects(start(importBody({kind:'audio'})),e=>e.code==='invalid_request');
 await assert.rejects(start(importBody({file:{name:'x.mov',sizeBytes:'60',mimeType:'video/quicktime'}})),e=>e.code==='unsupported_media');
 await assert.rejects(start(importBody({kind:'image',driveFileId:VIDEO_ID,file:{name:'x.jpg',sizeBytes:'60',mimeType:'image/jpeg'}})),e=>e.code==='resource_not_found','a video link is not an image');
 await pool.query("update library.exercises set video_source='none' where video_url like $1",[`%${VIDEO_ID}%`]);await pool.query('delete from plans.plan_items where video_url like $1',[`%${VIDEO_ID}%`]);
 await assert.rejects(start(),e=>e.code==='resource_not_found','a slot that is not legacy any more does not count');
 assert.equal((await pool.query('select count(*)::int as n from media.uploads')).rows[0].n,0);
 assert.ok((await start(importBody({driveFileId:PLAN_ONLY_ID}))).uploadId,'a plan item alone is enough');
});

test('5. an import is charged to the platform account, outside the coach rate limit, and its completion writes the copy with the asset',async()=>{
 const before=await platform();
 const u=await start();await put(u);
 const done=await uploads.complete(adminReq,u.uploadId);
 assert.equal(done.httpStatus,200);assert.equal(done.body.media.metadata.origin,'drive_import');
 const copy=(await pool.query('select * from media.drive_copies')).rows;
 assert.equal(copy.length,1);assert.equal(copy[0].drive_file_id,VIDEO_ID);assert.equal(copy[0].kind,'video');assert.equal(copy[0].asset_id,u.mediaId);assert.equal(copy[0].created_by_user_id,adminId);
 assert.equal((await pool.query("select event from media.drive_copy_events where asset_id=$1",[u.mediaId])).rows[0].event,'created');
 const p=await platform();assert.equal(BigInt(p.usedBytes)-BigInt(before.usedBytes),60n);assert.equal(p.reservedBytes,before.reservedBytes);
 assert.equal((await pool.query('select count(*)::int as n from media.storage_accounts where owner_user_id=$1',[adminId])).rows[0].n,0,'the administrator\'s own quota is never touched');
 assert.equal((await pool.query("select count(*)::int as n from media.upload_events where performed_by_user_id=$1 and event='requested'",[adminId])).rows[0].n,0,'no coach rate-limit request is counted');
 assert.deepEqual((await driveCopies.status()).videos.find(v=>v.driveFileId===VIDEO_ID),{driveFileId:VIDEO_ID,rows:2,copied:true,mediaId:u.mediaId});
});

test('6. an import allows a video up to 180 s; a coach upload keeps its 30 s',async()=>{
 const u=await start();await put(u);await uploads.complete(adminReq,u.uploadId);
 assert.deepEqual(inspectCalls.at(-1),{maxVideoSeconds:180});assert.equal(DRIVE_IMPORT_MAX_VIDEO_SECONDS,180);
 const video=seconds=>({media:{track:[{'@type':'General',Format:'MPEG-4'},{'@type':'Video',Format:'AVC',Format_Profile:'High@L3.1',BitDepth:8,ChromaSubsampling:'4:2:0',Duration:seconds,Width:720,Height:1280}]}});
 assert.equal(validateVideoTracks(video(154),'video/mp4',{maxSeconds:180}).durationSeconds,154);
 assert.throws(()=>validateVideoTracks(video(181),'video/mp4',{maxSeconds:180}),e=>e.code==='video_too_long');
 assert.throws(()=>validateVideoTracks(video(31),'video/mp4'),e=>e.code==='video_too_long','the coach default is unchanged');
});

test('7. one copy per file and kind: a copied file and an import in flight are refused; a copy that appears first rolls the completion back',async()=>{
 const first=await start();
 await assert.rejects(start(),e=>e.code==='import_in_progress');
 const again=await start(importBody(),adminReq,(await row(first.uploadId)).idempotency_key);assert.equal(again.uploadId,first.uploadId,'the same key is the same import');
 await put(first);
 // A copy of this file lands between this import's initiation and completion.
 const other=randomUUID();
 await pool.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,'video',$3,$4,'ready',5,'video/mp4')",[other,'assets/'+other,await storage.ensureAccount({type:'platform'}),adminId]);
 await pool.query('insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,$2,$3,$4)',[VIDEO_ID,'video',other,adminId]);
 await assert.rejects(uploads.complete(adminReq,first.uploadId),e=>e.code==='already_copied');
 assert.equal((await row(first.uploadId)).status,'failed','ended at once: its reservation and parallel-upload slot are freed');
 assert.equal((await pool.query('select status from media.assets where id=$1',[first.mediaId])).rows[0].status,'failed','its asset never became ready');
 assert.equal((await pool.query('select asset_id from media.drive_copies where drive_file_id=$1',[VIDEO_ID])).rows[0].asset_id,other,'the first copy stays');
 await assert.rejects(start(),e=>e.code==='already_copied');
});

test('8. a revoked administrator cannot complete; cancelling releases the reservation',async()=>{
 const before=await platform();
 const u=await start();await put(u);
 const revoked={...adminReq,authz:{...adminReq.authz,platformRoles:[]}};
 await assert.rejects(uploads.complete(revoked,u.uploadId),e=>e.code==='operation_not_allowed');
 assert.equal((await pool.query('select count(*)::int as n from media.drive_copies')).rows[0].n,0);
 await uploads.cancel(adminReq,u.uploadId);
 assert.equal((await platform()).reservedBytes,before.reservedBytes);assert.equal((await row(u.uploadId)).status,'cancelled');
});

test('9. removing a copy needs a reason, records who and why, falls back to Drive, and the record cannot be changed',async()=>{
 const u=await start();await put(u);await uploads.complete(adminReq,u.uploadId);
 await assert.rejects(driveCopies.remove(adminId,'video',VIDEO_ID,' '),e=>e.code==='invalid_request');
 await assert.rejects(driveCopies.remove(adminId,'image',VIDEO_ID,'wrong kind'),e=>e.code==='resource_not_found');
 assert.deepEqual(await driveCopies.remove(adminId,'video',VIDEO_ID,'pilot rollback'),{driveFileId:VIDEO_ID,kind:'video',removed:true});
 assert.equal((await pool.query('select count(*)::int as n from media.drive_copies')).rows[0].n,0);
 const events=(await pool.query('select event,reason,performed_by_user_id from media.drive_copy_events where asset_id=$1 order by created_at,event',[u.mediaId])).rows;
 assert.deepEqual(events.map(e=>[e.event,e.reason]),[['created',null],['removed','pilot rollback']]);
 await assert.rejects(pool.query('delete from media.drive_copy_events'),e=>e.code==='42501');
 assert.equal((await pool.query('select status from media.assets where id=$1',[u.mediaId])).rows[0].status,'ready','the object stays, charged to the platform account');
});

test('10. the status lists every Drive file a legacy slot names, with how many rows and whether it is copied',async()=>{
 const status=await driveCopies.status();
 assert.deepEqual(status.videos.map(v=>[v.driveFileId,v.rows,v.copied]),[[PLAN_ONLY_ID,1,false],[VIDEO_ID,2,false]].sort());
 assert.deepEqual(status.images.map(v=>[v.driveFileId,v.rows]),[[IMAGE_ID,1],[LH3_ID,1]].sort());
 const r=await http('/api/admin/media/drive-import/status');assert.equal(r.status,200);assert.equal((await r.json()).videos.length,2);
});

test('11. the whole import over HTTP: start, complete, remove; an image too',async()=>{
 const started=await http('/api/admin/media/drive-import/uploads',{method:'POST',body:importBody({kind:'image',driveFileId:IMAGE_ID,file:{name:'p.jpg',sizeBytes:'40',mimeType:'image/jpeg'}}),key:randomUUID()});
 assert.equal(started.status,201);const u=await started.json();assert.ok(u.upload.url);
 await put(u,40,'image/jpeg');inspectImpl=async()=>({width:4,height:4});
 const completed=await http(`/api/admin/media/drive-import/uploads/${u.uploadId}/complete`,{method:'POST'});assert.equal(completed.status,200);
 assert.equal((await pool.query("select kind from media.drive_copies where drive_file_id=$1",[IMAGE_ID])).rows[0].kind,'image');
 const removed=await http(`/api/admin/media/drive-import/copies/image/${IMAGE_ID}`,{method:'DELETE',body:{reason:'check'}});assert.equal(removed.status,200);
 assert.equal((await http(`/api/admin/media/drive-import/copies/image/${IMAGE_ID}`,{method:'DELETE',body:{reason:'again'}})).status,404);
});

// ---- Review fixes (code-, security- and db-reviewer, 2026-10-21) --------------

// A storage service whose COMMIT of the completion misbehaves: 'lands' commits
// and then loses the answer, 'refused' rolls back and errors, 'hangs' never answers.
function trappedStorage(mode) {
 const wrapped={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(target,key){
  if(key==='query')return (sql,...rest)=>{
   if(mode.armed && typeof sql==='string' && sql.trim().toLowerCase()==='commit') {
    mode.armed=false;
    if(mode.kind==='lands')return target.query('commit').then(()=>{throw new Error('connection terminated');});
    if(mode.kind==='refused')return target.query('rollback').then(()=>{throw new Error('connection terminated');});
    return new Promise(()=>{});
   }
   return target.query(sql,...rest);
  };
  const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
 return createMediaStorageService(wrapped);
}

test('12. a lost COMMIT answer is never a generic error: written is 200 verifiedAfterCommitError, not written is retryable and the upload can be completed again',async()=>{
 for(const kind of ['lands','refused','hangs']) {
  await pool.query('delete from media.drive_copies');await pool.query("update media.uploads set status='cancelled' where status in ('reserved','verifying','cancelling')");
  const mode={kind,armed:false},trapped=trappedStorage(mode);
  const service=createMediaUploadService({pool,storage:trapped,store,driveCopies,inspect:async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264',audioCodec:null}),commitBoundMs:200});
  const u=await service.importInitiate(adminReq,importBody(),randomUUID());await put(u);
  mode.armed=true;
  if(kind==='lands') {
   const r=await service.complete(adminReq,u.uploadId);
   assert.equal(r.httpStatus,200);assert.equal(r.body.verifiedAfterCommitError,true);
   assert.equal((await pool.query('select count(*)::int as n from media.drive_copies where asset_id=$1',[u.mediaId])).rows[0].n,1);
  } else {
   await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='media_storage_unavailable' && e.retryable===true,kind);
   assert.equal((await row(u.uploadId)).status,'reserved',`${kind}: not written, the upload can be completed again`);
   assert.equal((await pool.query('select count(*)::int as n from media.drive_copies')).rows[0].n,0);
   const again=await service.complete(adminReq,u.uploadId);assert.equal(again.httpStatus,200,`${kind}: completed on retry`);
  }
 }
});

test('13. two imports of one file started at once: exactly one reserves; the database refuses a second one in flight too',async()=>{
 const r=await Promise.allSettled([start(),start()]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(r.find(x=>x.status==='rejected').reason.code,'import_in_progress');
 assert.equal((await pool.query("select count(*)::int as n from media.uploads where purpose='drive_import_video' and status in ('reserved','verifying','cancelling')")).rows[0].n,1);
 const accountId=await storage.ensureAccount({type:'platform'}),asset=randomUUID();
 await pool.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id) values($1,$2,'video',$3,$4)",[asset,'assets/'+asset,accountId,adminId]);
 await assert.rejects(pool.query(`insert into media.uploads(asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,expires_at)
  values($1,$2,$3,gen_random_uuid(),'f',$4,'drive_import_video',$5,1,'video/mp4',1,now()+interval '1 minute')`,[asset,accountId,adminId,JSON.stringify({type:'drive_import',driveFileId:VIDEO_ID}),'pending/'+asset]),e=>e.code==='23505');
});

test('14. over HTTP: a copy that lands first ends the upload (409, nothing charged, slot freed); a repeated completion writes nothing twice',async()=>{
 const before=await platform();
 const started=await (await http('/api/admin/media/drive-import/uploads',{method:'POST',body:importBody(),key:randomUUID()})).json();
 await put(started);
 const accountId=await storage.ensureAccount({type:'platform'}),other=randomUUID();
 await pool.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id,status,size_bytes,mime_type) values($1,$2,'video',$3,$4,'ready',5,'video/mp4')",[other,'assets/'+other,accountId,adminId]);
 await pool.query('insert into media.drive_copies(drive_file_id,kind,asset_id,created_by_user_id) values($1,$2,$3,$4)',[VIDEO_ID,'video',other,adminId]);
 const conflict=await http(`/api/admin/media/drive-import/uploads/${started.uploadId}/complete`,{method:'POST'});
 assert.equal(conflict.status,409);const body=await conflict.json();assert.equal(body.code,'already_copied');assert.equal(body.retryable,false);
 const after=await platform();assert.equal(after.usedBytes,before.usedBytes);assert.equal(after.reservedBytes,before.reservedBytes);
 assert.equal((await row(started.uploadId)).status,'failed','ended at once, its parallel-upload slot freed');
 await pool.query('delete from media.drive_copies');
 const second=await (await http('/api/admin/media/drive-import/uploads',{method:'POST',body:importBody(),key:randomUUID()})).json();
 await put(second);
 assert.equal((await http(`/api/admin/media/drive-import/uploads/${second.uploadId}/complete`,{method:'POST'})).status,200);
 const charged=(await platform()).usedBytes;
 assert.equal((await http(`/api/admin/media/drive-import/uploads/${second.uploadId}/complete`,{method:'POST'})).status,200);
 assert.equal((await platform()).usedBytes,charged,'charged once');
 assert.equal((await pool.query('select count(*)::int as n from media.drive_copies where asset_id=$1',[second.mediaId])).rows[0].n,1);
 assert.equal((await pool.query("select count(*)::int as n from media.drive_copy_events where asset_id=$1 and event='created'",[second.mediaId])).rows[0].n,1);
});

test('15. an import purpose belongs to an import alone: a coach cannot use one, and the database refuses the pair either way',async()=>{
 await assert.rejects(uploads.initiate(coachReq,{context:{type:'exercise_create'},kind:'video',purpose:'drive_import_video',file:{name:'x.mp4',sizeBytes:'60',mimeType:'video/mp4'}},randomUUID()),e=>e.code==='invalid_request');
 assert.equal((await pool.query("select count(*)::int as n from media.uploads where uploaded_by_user_id=$1",[coachId])).rows[0].n,0);
 const accountId=await storage.ensureAccount({type:'platform'}),asset=randomUUID();
 await pool.query("insert into media.assets(id,object_key,kind,storage_account_id,uploaded_by_user_id) values($1,$2,'video',$3,$4)",[asset,'assets/'+asset,accountId,adminId]);
 for(const [purpose,context] of [['drive_import_video',{type:'exercise_create'}],['exercise_video',{type:'drive_import',driveFileId:VIDEO_ID}]])
  await assert.rejects(pool.query(`insert into media.uploads(asset_id,storage_account_id,uploaded_by_user_id,idempotency_key,request_fingerprint,context,purpose,temporary_object_key,expected_size_bytes,expected_mime_type,reserved_bytes,expires_at)
   values($1,$2,$3,gen_random_uuid(),'f',$4,$5,$6,1,'video/mp4',1,now())`,[asset,accountId,adminId,JSON.stringify(context),purpose,'pending/x'+purpose]),e=>e.code==='23514');
});

test('16. a revoked administrator can neither read nor cancel an import in flight',async()=>{
 const u=await start();const revoked={...adminReq,authz:{...adminReq.authz,platformRoles:[]}};
 await assert.rejects(uploads.status(revoked,u.uploadId),e=>e.code==='operation_not_allowed');
 await assert.rejects(uploads.cancel(revoked,u.uploadId),e=>e.code==='operation_not_allowed');
 assert.equal((await row(u.uploadId)).status,'reserved');
 assert.equal((await http(`/api/admin/media/drive-import/uploads/${u.uploadId}`,{method:'DELETE'})).status,200,'the administrator cancels it over HTTP');
 assert.equal((await row(u.uploadId)).status,'cancelled');
});

test('17. the real inspection: a 40 s H.264 file passes an import (180 s) and is refused at the coach limit (30 s)',async()=>{
 const mp4=Buffer.from(LONG_40S_MP4,'base64'),objects=memoryStore();objects.put('pending/long',mp4,'video/mp4');
 const head=await objects.head('pending/long'),upload={expected_mime_type:'video/mp4',temporary_object_key:'pending/long'};
 assert.equal(Math.round((await inspectMedia(objects,upload,head,{maxVideoSeconds:DRIVE_IMPORT_MAX_VIDEO_SECONDS})).durationSeconds),40);
 await assert.rejects(inspectMedia(objects,upload,head),e=>e.code==='video_too_long');
});

test('18. the new tables are private like the rest of media, a copy row is never changed and a removal always has a reason',async()=>{
 const tables=(await pool.query("select relname,relrowsecurity from pg_class where relnamespace='media'::regnamespace and relkind='r' order by relname")).rows;
 assert.ok(tables.some(t=>t.relname==='drive_copies') && tables.some(t=>t.relname==='drive_copy_events'));
 assert.deepEqual(tables.filter(t=>!t.relrowsecurity).map(t=>t.relname),[]);
 assert.equal((await pool.query("select count(*)::int as n from information_schema.role_table_grants where table_schema='media' and grantee='PUBLIC'")).rows[0].n,0);
 const u=await start();await put(u);await uploads.complete(adminReq,u.uploadId);
 await assert.rejects(pool.query("update media.drive_copies set created_at=now()"),e=>e.code==='42501');
 await assert.rejects(pool.query("insert into media.drive_copy_events(drive_file_id,kind,asset_id,event,performed_by_user_id) values($1,'video',$2,'removed',$3)",[VIDEO_ID,u.mediaId,adminId]),e=>e.code==='23514');
});

// Faults on the claim transaction, rather than the final asset transaction.
// Only injected after initiation; every reconciliation uses a new checkout.
function claimPool(mode) {
 return {query:(...a)=>pool.query(...a),connect:async()=>{
  const c=await pool.connect();mode.connections=(mode.connections||0)+1;
  return new Proxy(c,{get(target,key){
   if(key==='query')return async(sql,...rest)=>{
    if(mode.failRead && String(sql).startsWith('select * from media.uploads where id=$1 for update')) {
     mode.failRead=false;throw new Error('outcome read unavailable');
    }
    if(mode.armed && String(sql).trim().toLowerCase()==='commit') {
     mode.armed=false;
     if(mode.kind==='lands'){await target.query('commit');mode.afterCommit?.();mode.failRead=!!mode.unreadable;throw new Error('lost claim COMMIT');}
     if(mode.kind==='refused'){await target.query('rollback');throw new Error('refused claim COMMIT');}
     if(mode.kind==='lands-hangs'){await target.query('commit');return new Promise(()=>{});}
     return new Promise(()=>{});
    }
    return target.query(sql,...rest);
   };
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
 }};
}
function claimService(mode,inspect=async()=>({durationSeconds:2,width:320,height:240,videoCodec:'h264',audioCodec:null})) {
 return createMediaUploadService({pool:claimPool(mode),storage,store,driveCopies,inspect,commitBoundMs:100});
}

test('19. lost claim COMMIT, including a missing response, reconciles its own token and completes exactly once',async()=>{
 for(const kind of ['lands','lands-hangs']) {
  await pool.query('delete from media.drive_copies');
  const mode={kind},service=claimService(mode),u=await service.importInitiate(adminReq,importBody(),randomUUID());await put(u);
  mode.armed=true;const before=mode.connections;
  assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);
  assert.ok(mode.connections>=before+2,'fresh checkout reconciles the COMMIT');
  const charged=(await platform()).usedBytes;
  assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);
  assert.equal((await platform()).usedBytes,charged);
  assert.equal((await pool.query('select count(*)::int n from media.drive_copies where asset_id=$1',[u.mediaId])).rows[0].n,1);
 }
});

test('20. uncommitted claim COMMIT is bounded and retryable; retry obtains a real verifier',async()=>{
 for(const kind of ['refused','hangs']) {
  await pool.query('delete from media.drive_copies');
  const mode={kind},service=claimService(mode),u=await service.importInitiate(adminReq,importBody(),randomUUID());await put(u);
  mode.armed=true;
  await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='verification_outcome_unknown'&&e.retryable===true);
  assert.equal((await row(u.uploadId)).status,'reserved');
  assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);
 }
});

test('21. unreadable claim outcome is explicit; an abandoned lease is recoverable without cleanup cron',async()=>{
 const mode={kind:'lands',unreadable:true},service=claimService(mode),u=await service.importInitiate(adminReq,importBody(),randomUUID());await put(u);
 mode.armed=true;
 await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='verification_outcome_unknown'&&e.retryable===true);
 const old=await row(u.uploadId);assert.equal(old.status,'verifying');
 assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,202,'unexpired claim is not stolen');
 await pool.query("update media.uploads set verification_until=now()-interval '1 second' where id=$1",[u.uploadId]);
 assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);
 assert.notEqual((await row(u.uploadId)).verification_token,old.verification_token);
});

test('22. parallel completion cannot inspect while the reconciled verifier owns the lease',async()=>{
 let entered,finish;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);let inspections=0;
 const mode={kind:'lands'},service=claimService(mode,async()=>{inspections++;entered();await gate;return {durationSeconds:2,width:320,height:240,videoCodec:'h264',audioCodec:null};});
 const u=await service.importInitiate(adminReq,importBody(),randomUUID());await put(u);mode.armed=true;
 const first=service.complete(adminReq,u.uploadId);await started;
 try {assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,202);assert.equal(inspections,1);}
 finally {finish();}
 assert.equal((await first).httpStatus,200);
 assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);
});

test('23. reconciliation cannot continue inspection under another token or a revoked role',async()=>{
 const u=await start();await put(u);let inspected=false;
 const mode={kind:'lands'};
 const wrapped=claimPool(mode),original=wrapped.connect;
 wrapped.connect=async()=>{
  const c=await original();
  if(mode.armed && !mode.hooked){mode.hooked=true;
   return new Proxy(c,{get(target,key){
    if(key==='query')return async(sql,...a)=>{
     try{return await target.query(sql,...a);}catch(e){
      if(String(sql)==='commit')await pool.query('update media.uploads set verification_token=$2 where id=$1',[u.uploadId,randomUUID()]);
      throw e;
     }
    };
    const v=target[key];return typeof v==='function'?v.bind(target):v;
   }});
  }return c;
 };
 const service=createMediaUploadService({pool:wrapped,storage,store,driveCopies,inspect:async()=>{inspected=true;return {};},commitBoundMs:100});mode.armed=true;
 await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='verification_outcome_unknown'&&e.retryable);
 assert.equal(inspected,false);
 const revoked={...adminReq,authz:{...adminReq.authz,platformRoles:[]}};
 await assert.rejects(service.complete(revoked,u.uploadId),e=>e.code==='operation_not_allowed');
});

test('24. final COMMIT with unreadable reconciliation replays one charged completion',async()=>{
 const mode={kind:'lands',armed:false},trapped=trappedStorage(mode);let refuse=false;
 const commitStorage={...trapped,commitVerifiedUpload:async(...a)=>{try{return await trapped.commitVerifiedUpload(...a);}catch(e){refuse=true;throw e;}}};
 const wrapped={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(t,k){
  if(k==='query')return (sql,...args)=>{
   if(refuse&&sql==='select * from media.uploads where id=$1 for update'){refuse=false;return Promise.reject(new Error('reconciliation unavailable'));}
   return t.query(sql,...args);
  };
  const v=t[k];return typeof v==='function'?v.bind(t):v;
 }});}};
 const service=createMediaUploadService({pool:wrapped,storage:commitStorage,store,driveCopies,inspect:async()=>({durationSeconds:2,width:320,height:240}),commitBoundMs:100});
 const u=await start();await put(u);mode.armed=true;
 await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='import_outcome_unknown'&&e.retryable);
 assert.equal((await row(u.uploadId)).status,'completed');const before=(await platform()).usedBytes;
 assert.equal((await service.complete(adminReq,u.uploadId)).httpStatus,200);assert.equal((await platform()).usedBytes,before);
 assert.equal((await pool.query('select count(*)::int n from media.drive_copies where asset_id=$1',[u.mediaId])).rows[0].n,1);
});

test('25. lost claim COMMIT and unavailable fresh connection never starts inspection',async()=>{
 const mode={kind:'lands'},wrapped=claimPool(mode),connect=wrapped.connect;
 wrapped.connect=async()=>{if(mode.hadClaim&&!mode.armed)throw new Error('fresh connection unavailable');mode.hadClaim=true;return connect();};
 let inspected=false;
 const service=createMediaUploadService({pool:wrapped,storage,store,driveCopies,inspect:async()=>{inspected=true;return {};},commitBoundMs:100});
 const u=await start();await put(u);mode.armed=true;
 await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='verification_outcome_unknown'&&e.retryable);
 assert.equal(inspected,false);assert.equal((await row(u.uploadId)).status,'verifying');
});

test('26. authorization is rechecked after recovering a committed claim',async()=>{
 let inspected=false;
 const mode={kind:'lands',afterCommit:()=>{adminReq.authz.platformRoles=[];}};
 const service=claimService(mode,async()=>{inspected=true;return {};});const u=await start();await put(u);mode.armed=true;
 await assert.rejects(service.complete(adminReq,u.uploadId),e=>e.code==='operation_not_allowed');
 assert.equal(inspected,false);
 assert.equal((await pool.query('select count(*)::int n from media.drive_copies where asset_id=$1',[u.mediaId])).rows[0].n,0);
});
