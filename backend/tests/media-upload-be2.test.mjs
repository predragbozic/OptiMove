import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import sharp from 'sharp';
import {createMediaStorageService,MediaStorageError} from '../src/mediaStorage.js';
import {createMediaUploadService} from '../src/mediaUploads.js';
import {createR2UploadStore} from '../src/r2UploadStore.js';
import {inspectMedia,validateVideoTracks,MAX_VIDEO_SECONDS} from '../src/mediaInspection.js';
const input=process.env.MEDIA_TEST_DATABASE_URL;
if(!input)throw new Error('Set local MEDIA_TEST_DATABASE_URL.');
const base=new URL(input);if(!['localhost','127.0.0.1','::1','[::1]'].includes(base.hostname)||base.search)throw new Error('Refusing remote test database.');
const suffix=randomUUID().replaceAll('-','').slice(0,16),dbName='optimove_media_be2_test_'+suffix,roleName='media_be2_role_'+suffix;
let roleCreated=false;
const adminUrl=new URL(base);adminUrl.pathname='/postgres';const testUrl=new URL(base);testUrl.pathname='/'+dbName;
const dbAdmin=new pg.Client({connectionString:adminUrl.toString()});
let pool,storage,uploads,store,server,root,req,otherReq,adminReq,accountId,exerciseId,inspectImpl,created=false,enabled=true;
const adminId=randomUUID(),otherId=randomUUID(),clubId=randomUUID();
const fixture=`create schema library;create schema plans;
create table public.users(id uuid primary key);create table public.clubs(id uuid primary key,is_active boolean default true);
create table public.user_global_roles(user_id uuid,role text,is_active boolean default true);
create table public.user_workspace_preferences(user_id uuid,workspace_type text);
create table library.exercises(id uuid primary key,owner_scope text default 'user',owner_user_id uuid,owner_club_id uuid,is_active boolean default true,source_exercise_id uuid,copy_parent_id uuid,video_url text,image_url text);
create table plans.plan_items(id uuid primary key,exercise_id uuid references library.exercises(id),video_url text,image_url text);
create table library.exercise_collections(id uuid primary key,access_all boolean default false,deleted_at timestamptz);
create table library.exercise_collection_items(exercise_id uuid,collection_id uuid);
create table library.exercise_collection_users(collection_id uuid,user_id uuid);`;
const fakeMetadata={durationSeconds:2,width:320,height:240,videoCodec:'h264',audioCodec:null};
function memoryStore(){const objects=new Map();let configured=true,cleanupFailure=false;return {objects,
 assertConfigured(){if(!configured)throw new MediaStorageError(503,'media_storage_unavailable');},setConfigured(v){configured=v;},setCleanupFailure(v){cleanupFailure=v;},
 async signPut(u){return {method:'PUT',url:'https://private.invalid/'+u.id,headers:{'Content-Type':u.expected_mime_type,'If-None-Match':'*'},expiresAt:u.expires_at};},
 put(key,data,mime){if(objects.has(key))throw new Error('PreconditionFailed');objects.set(key,{data:Buffer.from(data),mime,tombstone:false});},
 async head(key){const o=objects.get(key);return o?{sizeBytes:String(o.data.length),mimeType:o.mime,etag:'"'+createHash('sha256').update(o.data).digest('hex')+'"',tombstone:o.tombstone}:null;},
 async read(key,offset,length,etag){const h=await this.head(key);if(!h||h.etag!==etag)throw new MediaStorageError(422,'media_verification_failed');return objects.get(key).data.subarray(offset,offset+length);},
 async tombstone(key){if(cleanupFailure)throw new MediaStorageError(503,'media_storage_unavailable');objects.set(key,{data:Buffer.alloc(0),mime:'application/octet-stream',tombstone:true});}};}
const body=overrides=>({context:{type:'exercise_create'},kind:'video',purpose:'exercise_video',file:{name:'test.mp4',sizeBytes:'60',mimeType:'video/mp4'},...overrides});
const start=(b=body(),actor=req,key=randomUUID())=>uploads.initiate(actor,b,key);
const row=async id=>(await pool.query('select * from media.uploads where id=$1',[id])).rows[0];
async function put(u,data=Buffer.alloc(60),mime='video/mp4'){const r=await row(u.uploadId);store.put(r.temporary_object_key,data,mime);return r;}
async function http(path,{actor='owner',method='GET',body:b,key}={}){return fetch(root+path,{method,headers:{'Content-Type':'application/json','X-Test-Actor':actor,...(key?{'Idempotency-Key':key}:{})},body:b===undefined?undefined:JSON.stringify(b)});}
before(async()=>{
 await dbAdmin.connect();await dbAdmin.query(`create role ${roleName} nologin nosuperuser nocreatedb nocreaterole noinherit`);roleCreated=true;await dbAdmin.query(`grant ${roleName} to current_user`);await dbAdmin.query(`create database ${dbName} owner ${roleName}`);created=true;pool=new pg.Pool({connectionString:testUrl.toString(),options:'-c role='+roleName,max:12});await pool.query(fixture);
 await pool.query('insert into public.users values($1),($2)',[adminId,otherId]);await pool.query('insert into public.clubs(id) values($1)',[clubId]);await pool.query("insert into public.user_global_roles values($1,'platform_admin',true)",[adminId]);
 for(const name of ['202610191100_media_storage_foundation.sql','202610191300_media_upload_lifecycle.sql']){const sql=await fs.readFile(new URL('../../migrations_v2/'+name,import.meta.url),'utf8');const c=await pool.connect();try{await c.query('begin');await c.query(sql);await c.query('commit');}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
 storage=createMediaStorageService(pool);await storage.updatePolicy(adminId,{expectedRevision:1,reason:'test allocation',changes:{defaultLimitBytes:'1000000',maxParallelUploads:2}});
 process.env.DATABASE_URL=testUrl.toString();const {createMediaStorageRouter}=await import('../src/routes/mediaStorage.js');
 const app=express();app.use(express.json());app.use((r,_s,next)=>{Object.assign(r,{owner:req,other:otherReq,admin:adminReq,athlete:{user:{id:otherId},authz:{capabilities:{coachWorkspace:false},platformRoles:[]}}}[r.headers['x-test-actor']]||{});next();});
 app.use('/api/media',createMediaStorageRouter({service:storage,uploads:new Proxy({},{get:(_t,k)=>(...a)=>uploads[k](...a)}),enabled:()=>enabled}));
 app.use((_e,_r,s,_n)=>s.status(500).json({code:'unexpected_error'}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));root=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{const id=randomUUID();await pool.query('insert into public.users values($1)',[id]);const authz={platformRoles:[],clubRoles:[],capabilities:{coachWorkspace:true}};req={user:{id},authz};otherReq={user:{id:otherId},authz};adminReq={user:{id:adminId},authz:{...authz,platformRoles:['platform_admin']}};accountId=await storage.ensureAccount({type:'user',id});exerciseId=randomUUID();await pool.query('insert into library.exercises(id,owner_user_id,video_url) values($1,$2,$3)',[exerciseId,id,'drive-original']);store=memoryStore();inspectImpl=async()=>({...fakeMetadata});uploads=createMediaUploadService({pool,storage,store,inspect:(...a)=>inspectImpl(...a)});enabled=true;});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(created)await dbAdmin.query(`drop database ${dbName} with(force)`);if(roleCreated)await dbAdmin.query(`drop role ${roleName}`);await dbAdmin.end();});
test('disabled feature/missing credentials are safe, do not reserve or affect startup',async()=>{enabled=false;store.setConfigured(false);const r=await http('/api/media/uploads',{method:'POST',body:body(),key:randomUUID()});assert.equal(r.status,503);assert.equal((await r.json()).code,'media_storage_disabled');assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');assert.doesNotThrow(()=>createR2UploadStore({}));assert.throws(()=>createR2UploadStore({}).assertConfigured(),e=>e.code==='media_storage_unavailable');enabled=true;assert.equal((await http('/api/media/uploads',{method:'POST',body:body(),key:randomUUID()})).status,503);});
test('anonymous/athlete/spoofed-role/foreign ownership cannot obtain upload permission',async()=>{for(const [actor,status] of [['none',401],['athlete',403]])assert.equal((await http('/api/media/uploads',{actor,method:'POST',body:body(),key:randomUUID()})).status,status);await assert.rejects(start(body({context:{type:'exercise_edit',exerciseId}}),otherReq),e=>e.code==='resource_not_found');await assert.rejects(start(body({context:{type:'exercise_edit',exerciseId}}),{...otherReq,user:{...otherReq.user,role_hint:'platform_admin'}}),e=>e.code==='resource_not_found');assert.ok((await start(body({context:{type:'exercise_edit',exerciseId}}))).mediaId);});
test('system/club uploads retain existing administrator and workspace gates',async()=>{const sys=randomUUID(),club=randomUUID();await pool.query("insert into library.exercises(id,owner_scope,owner_club_id) values($1,'system',null),($2,'club',$3)",[sys,club,clubId]);await assert.rejects(start(body({context:{type:'exercise_edit',exerciseId:sys}})),e=>e.code==='operation_not_allowed');const a=await start(body({context:{type:'exercise_edit',exerciseId:sys}}),adminReq);const c=await start(body({context:{type:'exercise_edit',exerciseId:club}}),adminReq);assert.equal((await storage.getAccount((await row(c.uploadId)).storage_account_id)).owner.id,clubId);await uploads.cancel(adminReq,a.uploadId);await uploads.cancel(adminReq,c.uploadId);await pool.query("insert into public.user_workspace_preferences values($1,'private_coach')",[adminId]);await assert.rejects(start(body({context:{type:'exercise_edit',exerciseId:sys}}),adminReq),e=>e.code==='operation_not_allowed');await pool.query('delete from public.user_workspace_preferences where user_id=$1',[adminId]);});
test('MIME/size and quota validation precede issuing a permission',async()=>{await assert.rejects(start(body({file:{name:'bad.mov',sizeBytes:'60',mimeType:'video/quicktime'}})),e=>e.code==='unsupported_media');await assert.rejects(start(body({file:{name:'large.mp4',sizeBytes:'209715201',mimeType:'video/mp4'}})),e=>e.code==='file_too_large');await storage.updateLimit(adminId,accountId,{limitBytes:'59',expectedRevision:1,reason:'quota race'});await assert.rejects(start(),e=>e.code==='storage_quota_exceeded');assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');});
test('concurrent initiation with one idempotency key reserves once',async()=>{const key=randomUUID(),r=await Promise.all([start(body(),req,key),start(body(),req,key)]);assert.equal(r[0].uploadId,r[1].uploadId);assert.equal((await storage.getAccount(accountId)).reservedBytes,'60');await assert.rejects(start(body({file:{name:'other.mp4',sizeBytes:'61',mimeType:'video/mp4'}}),req,key),e=>e.code==='idempotency_conflict');});
test('concurrent quota admission cannot oversubscribe',async()=>{await storage.updateLimit(adminId,accountId,{limitBytes:'100',expectedRevision:1,reason:'quota race'});const r=await Promise.allSettled([start(),start()]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'storage_quota_exceeded');});
test('completion cannot access foreign upload and commits bytes/audit only once',async()=>{const u=await start();await put(u);await assert.rejects(uploads.complete(otherReq,u.uploadId),e=>e.code==='resource_not_found');const r=await Promise.all([uploads.complete(req,u.uploadId),uploads.complete(req,u.uploadId)]);assert.ok(r.some(x=>x.httpStatus===200));assert.ok(r.every(x=>[200,202].includes(x.httpStatus)));const again=await uploads.complete(req,u.uploadId);assert.equal(again.body.media.mediaId,u.mediaId);assert.equal(again.body.media.url,undefined);const a=await storage.getAccount(accountId);assert.equal(a.usedBytes,'60');assert.equal(a.reservedBytes,'0');assert.equal((await pool.query('select object_key from media.assets where id=$1',[u.mediaId])).rows[0].object_key,(await row(u.uploadId)).temporary_object_key);assert.equal((await pool.query("select count(*) from media.upload_events where upload_id=$1 and event='completed'",[u.uploadId])).rows[0].count,'1');});
test('actual size and spoofed MIME reject, tombstone and release reservation',async()=>{for(const [data,mime] of [[Buffer.alloc(61),'video/mp4'],[Buffer.alloc(60),'video/webm']]){const u=await start(),r=await put(u,data,mime);await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='media_verification_failed');assert.equal((await row(u.uploadId)).status,'failed');assert.equal((await store.head(r.temporary_object_key)).tombstone,true);}assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');});
test('missing object can retry; unsupported codec cleans up',async()=>{const u=await start();await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='upload_not_present');assert.equal((await row(u.uploadId)).status,'reserved');await put(u);inspectImpl=async()=>{throw new MediaStorageError(415,'unsupported_media');};await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='unsupported_media');assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');});
test('cancel fences verifier, duplicate cancel and late create-only browser writes',async()=>{const u=await start(),r=await put(u);let release,entered;const waiting=new Promise(resolve=>entered=resolve);inspectImpl=async()=>{entered();await new Promise(resolve=>release=resolve);return {...fakeMetadata};};const completion=uploads.complete(req,u.uploadId);await waiting;await uploads.cancel(req,u.uploadId);release();await assert.rejects(completion,e=>e.code==='state_conflict');assert.throws(()=>store.put(r.temporary_object_key,Buffer.alloc(60),'video/mp4'),/PreconditionFailed/);await uploads.cancel(req,u.uploadId);assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');assert.equal((await storage.getAccount(accountId)).usedBytes,'0');});
test('failed cleanup retains reserved bytes until successful retry',async()=>{const u=await start();await put(u);store.setCleanupFailure(true);await assert.rejects(uploads.cancel(req,u.uploadId),e=>e.code==='media_storage_unavailable');assert.equal((await storage.getAccount(accountId)).reservedBytes,'60');store.setCleanupFailure(false);assert.ok((await uploads.cleanupExpired()).cleaned>=1);assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');assert.equal((await uploads.cleanupExpired()).failed,0);});
test('expired and crashed-verifier sessions are reclaimed safely',async()=>{const u=await start();await put(u);await pool.query("update media.uploads set expires_at=now()-interval '1 second' where id=$1",[u.uploadId]);await assert.rejects(uploads.renew(req,u.uploadId),e=>e.code==='upload_expired');await uploads.cleanupExpired();assert.equal((await row(u.uploadId)).status,'failed');const v=await start();await put(v);await pool.query("update media.uploads set status='verifying',verification_token=$2,verification_until=now()-interval '1 second' where id=$1",[v.uploadId,randomUUID()]);await uploads.cleanupExpired();assert.equal((await row(v.uploadId)).status,'failed');assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');});
test('revoked exercise block access denies renewal/completion but permits cleanup',async()=>{const u=await start(body({context:{type:'exercise_edit',exerciseId}}));await put(u);const block=randomUUID();await pool.query('insert into library.exercise_collections(id) values($1)',[block]);await pool.query('insert into library.exercise_collection_items values($1,$2)',[exerciseId,block]);await assert.rejects(uploads.renew(req,u.uploadId),e=>e.code==='resource_not_found');await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='resource_not_found');await uploads.cancel(req,u.uploadId);assert.equal((await pool.query('select video_url from library.exercises where id=$1',[exerciseId])).rows[0].video_url,'drive-original');});
test('thumbnail source requires ownership and charges image bytes once',async()=>{const u=await start();await put(u);await uploads.complete(req,u.uploadId);const b=body({kind:'image',purpose:'video_frame',sourceMediaId:u.mediaId,frameTimeSeconds:0.5,file:{name:'frame.png',sizeBytes:'10',mimeType:'image/png'}});await assert.rejects(start(b,otherReq),e=>e.code==='resource_not_found');const image=await start(b);await put(image,Buffer.alloc(10),'image/png');inspectImpl=async()=>({width:4,height:4});const r=await uploads.complete(req,image.uploadId);assert.equal(r.body.media.metadata.origin,'frame');assert.equal(r.body.media.metadata.sourceVideoMediaId,u.mediaId);assert.equal((await storage.getAccount(accountId)).usedBytes,'70');});
test('real isolated image parser decodes PNG and rejects malformed content',async()=>{const png=await sharp({create:{width:4,height:3,channels:3,background:'#ff0000'}}).png().toBuffer();const u=await start(body({kind:'image',purpose:'exercise_image',file:{name:'real.png',sizeBytes:String(png.length),mimeType:'image/png'}}));await put(u,png,'image/png');inspectImpl=inspectMedia;const r=await uploads.complete(req,u.uploadId);assert.equal(r.body.media.metadata.width,4);assert.equal(r.body.media.metadata.height,3);const bad=await start(body({kind:'image',purpose:'exercise_image',file:{name:'bad.png',sizeBytes:'10',mimeType:'image/png'}}));await put(bad,Buffer.alloc(10),'image/png');await assert.rejects(uploads.complete(req,bad.uploadId),e=>e.code==='media_verification_failed');});
test('codec allowlist rejects HEVC, unsupported profiles and wrong containers',()=>{const track={media:{track:[{'@type':'General',Format:'MPEG-4'},{'@type':'Video',Format:'AVC',Format_Profile:'High@L4',BitDepth:8,ChromaSubsampling:'4:2:0',Duration:2,Width:320,Height:240}]}};assert.equal(validateVideoTracks(track,'video/mp4').videoCodec,'h264');for(const patch of [{Format:'HEVC'},{BitDepth:10},{Format_Profile:'High 10@L4'}]){const changed=structuredClone(track);Object.assign(changed.media.track[1],patch);assert.throws(()=>validateVideoTracks(changed,'video/mp4'),e=>e.code==='unsupported_media');}assert.throws(()=>validateVideoTracks(track,'video/webm'),e=>e.code==='unsupported_media');});

// The owner's rule of 2026-10-19: at most 30 seconds (the client refuses a longer
// one before converting it; the server checks the longest of the container's declared durations).
test('a video longer than 30 seconds is refused as video_too_long (415); exactly 30 passes',()=>{const base={media:{track:[{'@type':'General',Format:'MPEG-4'},{'@type':'Video',Format:'AVC',Format_Profile:'High@L4',BitDepth:8,ChromaSubsampling:'4:2:0',Duration:30,Width:720,Height:1280},{'@type':'Audio',Format:'AAC',Format_AdditionalFeatures:'LC'}]}};assert.equal(MAX_VIDEO_SECONDS,30);assert.equal(validateVideoTracks(base,'video/mp4').durationSeconds,30);const long=structuredClone(base);long.media.track[1].Duration=30.5;assert.throws(()=>validateVideoTracks(long,'video/mp4'),e=>e.code==='video_too_long' && e.status===415);const fromGeneral=structuredClone(base);delete fromGeneral.media.track[1].Duration;fromGeneral.media.track[0].Duration=51.2;assert.throws(()=>validateVideoTracks(fromGeneral,'video/mp4'),e=>e.code==='video_too_long');
// The file plays until its longest track ends: a short picture with a long sound, a long ignored track or a long container is too long too.
const longAudio=structuredClone(base);longAudio.media.track[1].Duration=5;longAudio.media.track[2].Duration=600;assert.throws(()=>validateVideoTracks(longAudio,'video/mp4'),e=>e.code==='video_too_long');
const longContainer=structuredClone(base);longContainer.media.track[1].Duration=5;longContainer.media.track[0].Duration=45;assert.throws(()=>validateVideoTracks(longContainer,'video/mp4'),e=>e.code==='video_too_long');
const longMeta=structuredClone(base);longMeta.media.track[1].Duration=5;longMeta.media.track.push({'@type':'Other',Type:'meta',Duration:120});assert.throws(()=>validateVideoTracks(longMeta,'video/mp4'),e=>e.code==='video_too_long');
const allShort=structuredClone(base);allShort.media.track[1].Duration=5;allShort.media.track[2].Duration=5.02;allShort.media.track[0].Duration=5.02;assert.equal(validateVideoTracks(allShort,'video/mp4').durationSeconds,5);});

// MEDIA_MAX_VIDEO_SECONDS is read at import: it may lower the limit for a test, never raise the owner's 30 seconds.
test('the duration override can only lower the 30-second limit',async()=>{const {execFileSync}=await import('node:child_process');const read=value=>Number(execFileSync(process.execPath,['--input-type=module','-e',`import('${new URL('../src/mediaInspection.js',import.meta.url).href}').then(m=>process.stdout.write(String(m.MAX_VIDEO_SECONDS)))`],{env:{...process.env,MEDIA_MAX_VIDEO_SECONDS:value}}).toString());assert.equal(read('600'),30);assert.equal(read('5'),5);assert.equal(read('abc'),30);assert.equal(read('-1'),30);});

// Phones add timed-metadata, timecode or chapter tracks beside the picture and
// the sound; they are ignored, while a second video or audio track still refuses.
test('metadata tracks of a phone recording are ignored; a second video or audio track is still refused',()=>{const base={media:{track:[{'@type':'General',Format:'MPEG-4'},{'@type':'Video',Format:'AVC',Format_Profile:'High@L4',BitDepth:8,ChromaSubsampling:'4:2:0',Duration:5,Width:1080,Height:1920},{'@type':'Audio',Format:'AAC',Format_AdditionalFeatures:'LC'}]}};for(const extra of [{'@type':'Other',Type:'meta'},{'@type':'Text',Format:'Timed Text'},{'@type':'Menu'}]){const withExtra=structuredClone(base);withExtra.media.track.push(extra);assert.equal(validateVideoTracks(withExtra,'video/mp4').videoCodec,'h264');}for(const extra of [{'@type':'Video',Format:'AVC',Format_Profile:'High@L4',BitDepth:8,ChromaSubsampling:'4:2:0',Duration:5,Width:320,Height:240},{'@type':'Audio',Format:'AAC',Format_AdditionalFeatures:'LC'},{'@type':'Subtitle'},{'@type':'Image',Format:'JPEG'}]){const withExtra=structuredClone(base);withExtra.media.track.push(extra);assert.throws(()=>validateVideoTracks(withExtra,'video/mp4'),e=>e.code==='unsupported_media');}
// At most eight ignored tracks.
const eight=structuredClone(base);for(let i=0;i<8;i++)eight.media.track.push({'@type':'Other',Type:'meta'});assert.equal(validateVideoTracks(eight,'video/mp4').videoCodec,'h264');const nine=structuredClone(eight);nine.media.track.push({'@type':'Menu'});assert.throws(()=>validateVideoTracks(nine,'video/mp4'),e=>e.code==='unsupported_media');});
test('presigner binds actual size, MIME and create-only header without exposing secret',async()=>{const secret='not-a-real-secret-key';const adapter=createR2UploadStore({R2_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'test-key-id',R2_SECRET_ACCESS_KEY:secret,R2_BUCKET:'optimove-exercise-videos'});const signed=await adapter.signPut({temporary_object_key:'pending/test',expected_mime_type:'video/mp4',expected_size_bytes:'60',expires_at:new Date(Date.now()+600000)});const url=new URL(signed.url),headers=url.searchParams.get('X-Amz-SignedHeaders');for(const h of ['content-length','content-type','if-none-match'])assert.ok(headers.includes(h));assert.equal(signed.headers['If-None-Match'],'*');assert.ok(!signed.url.includes(secret));assert.equal(url.searchParams.get('X-Amz-Expires'),'600');});
test('HTTP response follows contract and lifecycle audit is append-only',async()=>{const r=await http('/api/media/uploads',{method:'POST',body:body(),key:randomUUID()});assert.equal(r.status,201);const u=await r.json();assert.equal(u.mediaId.length,36);assert.equal(u.upload.headers['If-None-Match'],'*');assert.equal((await(await http('/api/media/uploads/'+u.uploadId)).json()).status,'pending');await assert.rejects(pool.query("update media.upload_events set event='failed'"),e=>e.code==='42501');assert.equal((await http('/api/media/uploads',{method:'POST',body:body(),key:'bad'})).status,400);});

// A real WebM VP8 file built by hand (16x16), with its declared duration in milliseconds.
async function webmClip(durationMs=1000){
  const webp=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).webp().toBuffer();
  let vp8;for(let p=12;p+8<=webp.length;){const n=webp.readUInt32LE(p+4);if(webp.toString('ascii',p,p+4)==='VP8 ')vp8=webp.subarray(p+8,p+8+n);p+=8+n+(n%2);}
  assert.ok(vp8);
  const e=(id,data)=>{let width=1;while(data.length>=2**(7*width)-1)width++;const size=Buffer.alloc(width);let n=BigInt(data.length)|(1n<<BigInt(7*width));for(let i=width-1;i>=0;i--){size[i]=Number(n&255n);n>>=8n;}return Buffer.concat([Buffer.from(id,'hex'),size,data]);};
  const uint=(id,n)=>{const data=Buffer.alloc(n>65535?4:n>255?2:1);data.writeUIntBE(n,0,data.length);return e(id,data);};
  const text=(id,s)=>e(id,Buffer.from(s));
  const header=e('1a45dfa3',Buffer.concat([uint('4286',1),uint('42f7',1),uint('42f2',4),uint('42f3',8),text('4282','webm'),uint('4287',4),uint('4285',2)]));
  const duration=Buffer.alloc(8);duration.writeDoubleBE(durationMs);
  const info=e('1549a966',Buffer.concat([uint('2ad7b1',1000000),e('4489',duration),text('4d80','OptiMove test'),text('5741','OptiMove test')]));
  const tracks=e('1654ae6b',e('ae',Buffer.concat([uint('d7',1),uint('73c5',1),uint('83',1),text('86','V_VP8'),e('e0',Buffer.concat([uint('b0',16),uint('ba',16)]))])));
  const cluster=e('1f43b675',Buffer.concat([uint('e7',0),e('a3',Buffer.concat([Buffer.from([0x81,0,0,0x80]),vp8]))]));
  return Buffer.concat([header,e('18538067',Buffer.concat([info,tracks,cluster]))]);
}

// Real outputs of the on-device preparation, made in Chrome with the vendored Mediabunny 1.61.1
// (tests/fixtures/media): the server's real parser must accept exactly what the client sends.
const mediaFixture=name=>fs.readFile(new URL(`./fixtures/media/${name}`,import.meta.url));
async function completeReal(data,name){const u=await start(body({file:{name,sizeBytes:String(data.length),mimeType:'video/mp4'}}));await put(u,data,'video/mp4');inspectImpl=inspectMedia;return {u,r:await uploads.complete(req,u.uploadId)};}

test('a converted phone video (HEVC with rotation 90 prepared into H.264 High + AAC-LC) passes the real inspection',async()=>{
  const data=await mediaFixture('converted-hevc-rot90.mp4');
  const {r}=await completeReal(data,'converted.mp4');
  assert.equal(r.httpStatus,200);assert.equal(r.body.media.status,'ready');
  assert.equal(r.body.media.metadata.videoCodec,'h264');assert.equal(r.body.media.metadata.audioCodec,'aac');
  assert.ok(r.body.media.metadata.durationSeconds>0.5 && r.body.media.metadata.durationSeconds<1);
  assert.equal((await storage.getAccount(accountId)).usedBytes,String(data.length));
});

test('a compliant MP4 sent as it is with a text track beside the picture and the sound passes the real inspection',async()=>{
  // The client keeps this file untouched (Mediabunny does not list the text track); the parser labels it Text and it is ignored.
  // Synthetic: its only descriptive tags are a title and a date written by the test page (no location, no device).
  const data=await mediaFixture('h264-aac-text-track.mp4');
  const {r}=await completeReal(data,'passthrough.mp4');
  assert.equal(r.httpStatus,200);assert.equal(r.body.media.metadata.videoCodec,'h264');assert.equal(r.body.media.metadata.audioCodec,'aac');
});

// The client's metadata removal (frontend/exercise-media-metadata.js, run here in Node on the same
// bytes) checked by the real parser: a phone-like recording with location, device, software,
// author, title, dates, XMP, a caption track and a vendor trailer comes out with none of them,
// no conformance error, and passes the inspection.
const PRIVATE_FIELDS=/^(Title|Movie|Performer|Composer|Copyright|Comment|Description|Recorded_Date|Encoded_Date|Tagged_Date|Mastered_Date|Recorded_Location|Encoded_Application|Encoded_Library_Name|Make|Model|xyz|Location)$/i;
async function mediaInfoOf(buffer){const {default:factory}=await import('mediainfo.js');const info=await factory({format:'object',chunkSize:65536});try{const r=await info.analyzeData(buffer.length,(size,offset)=>buffer.subarray(offset,offset+size));const general=r.media.track.find(t=>t['@type']==='General');const fields=[...Object.keys(general),...Object.keys(general.extra||{})];return {types:r.media.track.map(t=>t['@type']),private:fields.filter(k=>PRIVATE_FIELDS.test(k)),extra:Object.keys(general.extra||{})};}finally{info.close();}}

test('the real parser sees no private metadata in a phone-like recording cleaned by the client, and the inspection passes',async()=>{
  const {stripPrivateMetadata}=await import('../../frontend/exercise-media-metadata.js');
  const original=await mediaFixture('phone-like-gps-moov-end.mp4');
  const before=await mediaInfoOf(original);
  // The fixture really carries what a phone writes (the check below would otherwise prove nothing).
  for(const field of ['Title','Performer','Recorded_Date','Recorded_Location','Encoded_Application','Make','Model'])assert.ok(before.private.includes(field),`the original shows ${field}`);
  assert.deepEqual(before.types,['General','Video','Audio','Text']);
  const {file}=await stripPrivateMetadata(new File([original],'phone.mp4',{type:'video/mp4'}));
  const cleaned=Buffer.from(await file.arrayBuffer());
  const after=await mediaInfoOf(cleaned);
  assert.deepEqual(after.private,[],'no title, author, dates, location, software, make or model');
  assert.deepEqual(after.types,['General','Video','Audio'],'no caption track');
  assert.deepEqual(after.extra,[],'no conformance error, nothing truncated');
  const {r}=await completeReal(cleaned,'phone.mp4');
  assert.equal(r.httpStatus,200);assert.equal(r.body.media.metadata.videoCodec,'h264');assert.equal(r.body.media.metadata.audioCodec,'aac');
});

// The 30-second refusal travels through the real worker as its own code: the session is cancelled and nothing is charged.
test('the real parser refuses a 31-second video as video_too_long and charges nothing',async()=>{
  const data=await webmClip(31000);
  const u=await start(body({file:{name:'long.webm',sizeBytes:String(data.length),mimeType:'video/webm'}}));await put(u,data,'video/webm');inspectImpl=inspectMedia;
  await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='video_too_long' && e.status===415);
  const r=await row(u.uploadId);assert.equal(r.status,'failed');assert.equal(r.error_code,'video_too_long');
  const a=await storage.getAccount(accountId);assert.equal(a.usedBytes,'0');assert.equal(a.reservedBytes,'0');
  assert.equal((await store.head(r.temporary_object_key)).tombstone,true);
});

test('actual WebM VP8 parser runs with bounded R2 range reads',async()=>{
  const webp=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).webp().toBuffer();
  let vp8;for(let p=12;p+8<=webp.length;){const n=webp.readUInt32LE(p+4);if(webp.toString('ascii',p,p+4)==='VP8 ')vp8=webp.subarray(p+8,p+8+n);p+=8+n+(n%2);}
  assert.ok(vp8);
  const e=(id,data)=>{let width=1;while(data.length>=2**(7*width)-1)width++;const size=Buffer.alloc(width);let n=BigInt(data.length)|(1n<<BigInt(7*width));for(let i=width-1;i>=0;i--){size[i]=Number(n&255n);n>>=8n;}return Buffer.concat([Buffer.from(id,'hex'),size,data]);};
  const uint=(id,n)=>{const data=Buffer.alloc(n>65535?4:n>255?2:1);data.writeUIntBE(n,0,data.length);return e(id,data);};
  const text=(id,s)=>e(id,Buffer.from(s));
  const header=e('1a45dfa3',Buffer.concat([uint('4286',1),uint('42f7',1),uint('42f2',4),uint('42f3',8),text('4282','webm'),uint('4287',4),uint('4285',2)]));
  const duration=Buffer.alloc(8);duration.writeDoubleBE(1000);
  const info=e('1549a966',Buffer.concat([uint('2ad7b1',1000000),e('4489',duration),text('4d80','OptiMove test'),text('5741','OptiMove test')]));
  const tracks=e('1654ae6b',e('ae',Buffer.concat([uint('d7',1),uint('73c5',1),uint('83',1),text('86','V_VP8'),e('e0',Buffer.concat([uint('b0',16),uint('ba',16)]))])));
  const cluster=e('1f43b675',Buffer.concat([uint('e7',0),e('a3',Buffer.concat([Buffer.from([0x81,0,0,0x80]),vp8]))]));
  const data=Buffer.concat([header,e('18538067',Buffer.concat([info,tracks,cluster]))]);
  const u=await start(body({file:{name:'real.webm',sizeBytes:String(data.length),mimeType:'video/webm'}}));await put(u,data,'video/webm');inspectImpl=inspectMedia;
  const result=await uploads.complete(req,u.uploadId);assert.equal(result.body.media.metadata.videoCodec,'vp8');assert.equal(result.body.media.metadata.width,16);
});

test('renewal retains identity/quota, foreign sessions stay private and rate limit is durable',async()=>{
  const u=await start();const before=await storage.getAccount(accountId);
  await assert.rejects(uploads.status(otherReq,u.uploadId),e=>e.code==='resource_not_found');
  await assert.rejects(uploads.cancel(otherReq,u.uploadId),e=>e.code==='resource_not_found');
  const renewed=await uploads.renew(req,u.uploadId);assert.equal(renewed.mediaId,u.mediaId);assert.equal(renewed.uploadId,u.uploadId);assert.ok(new Date(renewed.upload.expiresAt)>=new Date(u.upload.expiresAt));
  assert.equal((await storage.getAccount(accountId)).reservedBytes,before.reservedBytes);
  for(let i=0;i<18;i++)await uploads.renew(req,u.uploadId);
  await assert.rejects(uploads.renew(req,u.uploadId),e=>e.code==='upload_rate_limit');
  await uploads.cancel(req,u.uploadId);
});

test('initiation retry of completed media returns original identity without another permission',async()=>{
  const key=randomUUID(),u=await start(body(),req,key);await put(u);await uploads.complete(req,u.uploadId);
  const repeated=await start(body(),req,key);assert.equal(repeated.uploadId,u.uploadId);assert.equal(repeated.mediaId,u.mediaId);assert.equal(repeated.status,'completed');assert.equal(repeated.upload,undefined);assert.equal((await storage.getAccount(accountId)).usedBytes,'60');
});


test('target-aware usage resolves private/system/club owners with existing edit rights',async()=>{
 const own=await http('/api/media/storage?exerciseId='+exerciseId);assert.equal(own.status,200);const usage=await own.json();assert.equal(usage.selectedStorageAccountId,accountId);assert.equal(usage.accounts.length,1);
 assert.equal((await http('/api/media/storage?exerciseId='+exerciseId,{actor:'other'})).status,404);
 const sys=randomUUID(),club=randomUUID();await pool.query("insert into library.exercises(id,owner_scope,owner_club_id) values($1,'system',null),($2,'club',$3)",[sys,club,clubId]);
 for(const [id,type,ownerId] of [[sys,'user',adminId],[club,'club',clubId]]){const r=await http('/api/media/storage?exerciseId='+id,{actor:'admin'});assert.equal(r.status,200);const v=await r.json();assert.equal(v.accounts[0].owner.type,type);assert.equal(v.accounts[0].owner.id,ownerId);assert.equal(v.selectedStorageAccountId,v.accounts[0].storageAccountId);}
 assert.equal((await http('/api/media/storage?exerciseId=bad')).status,400);
 const legacy=await(await http('/api/media/storage')).json();assert.equal(legacy.selectedStorageAccountId,undefined);assert.equal(legacy.accounts[0].owner.id,req.user.id);
});

test('duplicate completion after PUT expiry preserves an active verification claim',async()=>{
 const u=await start();await put(u);let release,entered;const waiting=new Promise(resolve=>entered=resolve);
 inspectImpl=async()=>{entered();await new Promise(resolve=>release=resolve);return {...fakeMetadata};};
 const completion=uploads.complete(req,u.uploadId);await waiting;
 try {await pool.query("update media.uploads set expires_at=now()-interval '1 second' where id=$1",[u.uploadId]);const duplicate=await uploads.complete(req,u.uploadId);assert.equal(duplicate.httpStatus,202);assert.equal((await row(u.uploadId)).status,'verifying');}
 finally {release();}
 assert.equal((await completion).httpStatus,200);assert.equal((await storage.getAccount(accountId)).usedBytes,'60');
});

test('completion of an expired pending upload fences its object before releasing quota',async()=>{
 const u=await start(),r=await put(u);await pool.query("update media.uploads set expires_at=now()-interval '1 second' where id=$1",[u.uploadId]);
 await assert.rejects(uploads.complete(req,u.uploadId),e=>e.code==='upload_expired');assert.equal((await row(u.uploadId)).status,'failed');assert.equal((await store.head(r.temporary_object_key)).tombstone,true);assert.equal((await storage.getAccount(accountId)).reservedBytes,'0');
});
