import { randomUUID } from 'node:crypto';
import { MediaStorageError, bytes, uuid } from './mediaStorage.js';
import { exerciseLibraryScopeSql, hasExerciseAdministration } from './exerciseAccess.js';
import { inspectMedia } from './mediaInspection.js';
const fail=(status,code,retryable=false)=>{const e=new MediaStorageError(status,code);e.retryable=retryable;throw e;};
const sourcePurposes=new Set(['video_frame','automatic_thumbnail']);
const terminal=new Set(['completed','cancelled','failed']);
const dto=u=>({uploadId:u.id,mediaId:u.asset_id,status:u.status==='reserved'?'pending':u.status,expiresAt:u.expires_at,errorCode:u.error_code || null});

export function createMediaUploadService({pool,storage,store,inspect=inspectMedia}) {
  async function tx(work) {
    const c=await pool.connect();
    try {await c.query('begin');await c.query("set local lock_timeout='5s'");await c.query("set local statement_timeout='15s'");const r=await work(c);await c.query('commit');return r;}
    catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
  }
  async function audit(c,u,event,errorCode=null) {
    await c.query('insert into media.upload_events(upload_id,performed_by_user_id,event,error_code) values($1,$2,$3,$4)',[u?.id || null,u.uploaded_by_user_id,event,errorCode]);
  }
  async function locked(c,id) {
    const first=(await c.query('select storage_account_id from media.uploads where id=$1',[id])).rows[0];
    if(!first)fail(404,'resource_not_found');
    await c.query('select id from media.storage_accounts where id=$1 for update',[first.storage_account_id]);
    return (await c.query('select * from media.uploads where id=$1 for update',[id])).rows[0];
  }
  async function owned(req,id) {
    const u=(await pool.query('select * from media.uploads where id=$1 and uploaded_by_user_id=$2',[uuid(id),req.user.id])).rows[0];
    if(!u)fail(404,'resource_not_found');return u;
  }
  async function owner(req,context) {
    if(!req.authz?.capabilities?.coachWorkspace)fail(403,'operation_not_allowed');
    if(!context || !['exercise_create','exercise_edit'].includes(context.type))fail(400,'invalid_request');
    if(context.type==='exercise_create')return {type:'user',id:req.user.id}; // Existing POST /exercises always creates user-owned content.
    const id=uuid(context.exerciseId);
    const q=(sql,params)=>pool.query(sql,params);
    const admin=await hasExerciseAdministration(req.user.id,req.authz,q);
    const e=(await q(`select e.id,e.owner_scope,e.owner_user_id,e.owner_club_id from library.exercises e
      where e.id=$2 and (${exerciseLibraryScopeSql}) and e.is_active=true`,[req.user.id,id])).rows[0];
    if(!e)fail(404,'resource_not_found');
    if(e.owner_scope==='system') {if(!admin)fail(403,'operation_not_allowed');return {type:'user',id:req.user.id};}
    if(e.owner_scope==='user' && e.owner_user_id && (e.owner_user_id===req.user.id || admin))return {type:'user',id:e.owner_user_id};
    // Current exercise edit rules expose club rows only to exercise admins.
    // Do NOT introduce new edit grants for club/team roles here.
    if(e.owner_scope==='club' && e.owner_club_id && admin) {
      const club=(await q('select id from public.clubs where id=$1 and is_active=true',[e.owner_club_id])).rows[0];
      if(club)return {type:'club',id:club.id};
    }
    fail(403,'operation_not_allowed');
  }
  async function authorize(req,u) {
    const actual=await owner(req,u.context);
    const a=(await pool.query('select owner_user_id,owner_club_id from media.storage_accounts where id=$1',[u.storage_account_id])).rows[0];
    if(!a || (actual.type==='user'?a.owner_user_id:a.owner_club_id)!==actual.id)fail(403,'operation_not_allowed');
  }
  async function rate(req) {
    await tx(async c=>{
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['media-rate:'+req.user.id]);
      const counts=(await c.query("select count(*) as daily,count(*) filter(where created_at>now()-interval '1 minute') as minute from media.upload_events where performed_by_user_id=$1 and event='requested' and created_at>now()-interval '1 day'",[req.user.id])).rows[0];
      if(Number(counts.minute)>=20 || Number(counts.daily)>=200)fail(429,'upload_rate_limit');
      await audit(c,{uploaded_by_user_id:req.user.id},'requested');
    });
  }
  async function issue(req,u,event) {
    return tx(async c=>{
      const current=await locked(c,u.id);
      if(current.status!=='reserved')return {...dto(current),...(current.status==='completed'?{media:await media(current,c)}:{})};
      if(new Date(current.expires_at)<=new Date())fail(409,'upload_expired');
      const upload=await store.signPut(current); // Signature generation is local: no R2 I/O in transaction.
      await audit(c,current,event);
      return {...dto(current),upload,reservation:{bytes:current.reserved_bytes,expiresAt:current.expires_at}};
    });
  }
  async function beginCancel(id,errorCode=null) {
    return tx(async c=>{
      const u=await locked(c,id);
      if(u.status==='completed')fail(409,'upload_already_completed');
      if(terminal.has(u.status))return u;
      if(u.status==='cancelling')return u;
      const r=(await c.query("update media.uploads set status='cancelling',verification_token=null,verification_until=null,error_code=$2,updated_at=now() where id=$1 returning *",[id,errorCode])).rows[0];
      await audit(c,r,'cancelling',errorCode);return r;
    });
  }
  async function cleanup(u) {
    if(terminal.has(u.status))return u;
    // No deletion of pending keys: create-only signed writes may still be in
    // flight. A zero-byte tombstone prevents any later commit to the same key.
    await store.tombstone(u.temporary_object_key);
    return storage.releaseAfterCleanup(u.id,{cleanupVerified:true,outcome:u.error_code?'failed':'cancelled'});
  }
  async function media(u,connection=pool) {
    const a=(await connection.query('select * from media.assets where id=$1',[u.asset_id])).rows[0];
    return {source:'asset',mediaId:a.id,kind:a.kind,status:a.status,mimeType:a.mime_type,sizeBytes:a.size_bytes,metadata:a.metadata};
  }
  const api={
    async initiate(req,body,key) {
      uuid(key);
      const resolved=await owner(req,body?.context);store.assertConfigured();
      const file=body?.file;
      if(!file || typeof file.name!=='string' || !file.name.trim() || file.name.length>255)fail(400,'invalid_request');
      bytes(file.sizeBytes,{positive:true});
      if(BigInt(file.sizeBytes)>BigInt(Number.MAX_SAFE_INTEGER))fail(413,'file_too_large');
      const context={type:body.context.type,...(body.context.type==='exercise_edit'?{exerciseId:uuid(body.context.exerciseId)}:{}),fileName:file.name};
      const accountId=await storage.ensureAccount(resolved);
      if(sourcePurposes.has(body.purpose)) {
        const sourceId=uuid(body.sourceMediaId);
        const source=(await pool.query("select id from media.assets where id=$1 and storage_account_id=$2 and kind='video' and status='ready'",[sourceId,accountId])).rows[0];
        if(!source)fail(404,'resource_not_found');
        if(typeof body.frameTimeSeconds!=='number' || !Number.isFinite(body.frameTimeSeconds) || body.frameTimeSeconds<0)fail(400,'invalid_request');
        context.sourceMediaId=sourceId;context.frameTimeSeconds=body.frameTimeSeconds;
      }
      await rate(req);
      const u=await storage.reserveUpload({storageAccountId:accountId,uploadedByUserId:req.user.id,idempotencyKey:key,kind:body.kind,purpose:body.purpose,
        sizeBytes:file.sizeBytes,mimeType:file.mimeType,context,ttlSeconds:600});
      return issue(req,u,'issued');
    },
    async status(req,id) {const u=await owned(req,id);return {...dto(u),...(u.status==='completed'?{media:await media(u)}:{})};},
    async renew(req,id) {
      const u=await owned(req,id);await authorize(req,u);store.assertConfigured();await rate(req);
      await tx(async c=>{
        const current=await locked(c,u.id);
        if(current.status!=='reserved' || new Date(current.expires_at)<=new Date() || Date.now()-new Date(current.created_at).getTime()>1200000)fail(409,'upload_expired');
        await c.query("update media.uploads set expires_at=now()+interval '10 minutes',updated_at=now() where id=$1",[u.id]);
      });
      return issue(req,u,'renewed');
    },
    async complete(req,id) {
      const initial=await owned(req,id);await authorize(req,initial);store.assertConfigured();
      if(initial.status==='completed')return {httpStatus:200,body:{...dto(initial),media:await media(initial)}};
      if(terminal.has(initial.status) || initial.status==='cancelling')fail(409,'state_conflict');
      if(new Date(initial.expires_at)<=new Date()) {await cleanup(await beginCancel(initial.id,'upload_expired'));fail(409,'upload_expired');}
      const token=randomUUID();
      const u=await tx(async c=>{
        const current=await locked(c,initial.id);
        if(current.status==='completed')return current;
        if(current.status==='verifying')return null;
        if(current.status!=='reserved' || new Date(current.expires_at)<=new Date())fail(409,'state_conflict');
        const r=(await c.query("update media.uploads set status='verifying',verification_token=$2,verification_until=now()+interval '2 minutes',updated_at=now() where id=$1 returning *",[current.id,token])).rows[0];
        await audit(c,r,'verifying');return r;
      });
      if(!u)return {httpStatus:202,body:{...dto(initial),status:'verifying'}};
      if(u.status==='completed')return {httpStatus:200,body:{...dto(u),media:await media(u)}};
      try {
        const head=await store.head(u.temporary_object_key);
        if(!head)fail(409,'upload_not_present',true);
        if(head.tombstone || !head.etag || head.sizeBytes!==u.expected_size_bytes || head.mimeType!==u.expected_mime_type)fail(422,'media_verification_failed');
        const metadata=await inspect(store,u,head);
        if(u.expected_mime_type.startsWith('image/'))Object.assign(metadata,{origin:u.purpose==='exercise_image'?'manual':u.purpose==='video_frame'?'frame':'automatic',
          ...(u.context.sourceMediaId?{sourceVideoMediaId:u.context.sourceMediaId,frameTimeSeconds:u.context.frameTimeSeconds}:{})});
        await authorize(req,u);
        const completed=await storage.commitVerifiedUpload(u.id,{sizeBytes:head.sizeBytes,mimeType:head.mimeType,metadata,verificationToken:token,objectKey:u.temporary_object_key});
        return {httpStatus:200,body:{...dto(completed),media:await media(completed)}};
      } catch(e) {
        if(e instanceof MediaStorageError && [415,422].includes(e.status)) {await cleanup(await beginCancel(u.id,e.code));throw e;}
        // Missing object / transient provider failure can be retried. A cancelled
        // or stolen verification claim cannot return the session to pending.
        await tx(async c=>{const current=await locked(c,u.id);if(current.status==='verifying' && current.verification_token===token)
          await c.query("update media.uploads set status='reserved',verification_token=null,verification_until=null,updated_at=now() where id=$1",[u.id]);});
        throw e;
      }
    },
    async cancel(req,id) {const u=await owned(req,id);const cancelled=await cleanup(await beginCancel(u.id));return {httpStatus:200,body:dto(cancelled)};},
    async cleanupExpired(limit=20) {
      store.assertConfigured();
      if(!Number.isInteger(limit) || limit<1 || limit>100)fail(400,'invalid_request');
      const rows=(await pool.query(`select id from media.uploads where (status='reserved' and expires_at<=now()) or
        (status='verifying' and verification_until<=now()) or status='cancelling' order by updated_at limit $1`,[limit])).rows;
      let cleaned=0,failed=0;
      for(const row of rows) {
        try {
          const u=await tx(async c=>{
            const current=await locked(c,row.id);
            if(terminal.has(current.status))return null;
            if(current.status==='reserved' && new Date(current.expires_at)>new Date())return null;
            if(current.status==='verifying' && new Date(current.verification_until)>new Date())return null;
            const r=(await c.query("update media.uploads set status='cancelling',verification_token=null,verification_until=null,error_code=coalesce(error_code,'upload_expired'),updated_at=now() where id=$1 returning *",[row.id])).rows[0];
            await audit(c,r,'cancelling',r.error_code);return r;
          });
          if(u){await cleanup(u);cleaned++;}
        } catch {failed++;}
      }
      return {cleaned,failed};
    },
  };
  return api;
}
