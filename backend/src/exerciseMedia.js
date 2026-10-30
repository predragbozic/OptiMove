import { MediaStorageError, uuid } from './mediaStorage.js';
import { exerciseReadScopeSql, exerciseLibraryScopeSql, hasExerciseAdministration, lockExerciseReuse } from './exerciseAccess.js';
import { canAccessPlan } from './access.js';
import { needsTemplateApproval } from './programAccessPolicy.js';
import { exerciseMediaJoinSql } from './exercisePersonalization.js';
import { driveFileIdOf, readyDriveCopies } from './driveCopies.js';

const slots=['video','image'];
const fail=(status,code)=>{throw new MediaStorageError(status,code);};
export const mediaEnabled=()=>process.env.MEDIA_STORAGE_ENABLED==='true';
export function mediaSelections(body,current=null) {
  const result={};
  if(body.media!==undefined) {
    if(!body.media || typeof body.media!=='object' || Array.isArray(body.media) || Object.keys(body.media).some(k=>!slots.includes(k)))fail(400,'invalid_request');
    if(!mediaEnabled())fail(503,'media_storage_disabled');
  }
  for(const slot of slots) {
    const explicit=body.media?.[slot],legacy=slot+'Url';
    if(explicit!==undefined && Object.hasOwn(body,legacy))fail(400,'invalid_request');
    const value=explicit===undefined?(Object.hasOwn(body,legacy)?{source:'legacy',url:body[legacy]}:undefined):explicit;
    if(value===undefined)continue;
    // Legacy editors echo hidden/retained URLs or blank inputs on metadata saves.
    // Only a genuinely changed, nonempty implicit URL may replace an asset/none.
    // A legacy link with a ready Drive copy is shown as that copy, its link field
    // blank (decorateMediaRows): an echoed blank link leaves it as it is too.
    if(explicit===undefined && (['asset','none'].includes(current?.[slot+'_source']) || current?.[slot+'_copied']===true)) {
      const incoming=typeof body[legacy]==='string'?body[legacy].trim():'';
      const retained=typeof current[slot+'_url']==='string'?current[slot+'_url'].trim():'';
      if(!incoming || incoming===retained)continue;
    }
    if(!value || !['asset','legacy','none'].includes(value.source))fail(400,'invalid_request');
    if(value.source==='asset')result[slot]={source:'asset',mediaId:uuid(value.mediaId)};
    else if(value.source==='legacy') {
      if(typeof value.url==='string' && /[?&]x-amz-signature=/i.test(value.url))fail(400,'invalid_request');
      if(explicit===undefined) {result[slot]={source:'legacy',url:typeof value.url==='string'?value.url.trim():null};continue;}
      if(typeof value.url!=='string' || !/^https?:\/\//i.test(value.url.trim()) || /[?&]x-amz-signature=/i.test(value.url) || value.url.length>8192)fail(400,'invalid_request');
      result[slot]={source:'legacy',url:value.url.trim()};
    } else result[slot]={source:'none'};
  }
  return result;
}
// A legacy slot whose link names a Drive file with a ready copy (copies:
// readyDriveCopies) is described as that asset: it plays from R2, not Drive.
const legacyUrlOf=(row,slot)=>row['effective_'+slot+'_url']??row[slot+'_url']??'';
export function describeMedia(row,context,copies=null) {
  const media={accessContext:context};
  for(const slot of slots) {
    const source=row[slot+'_source']||'legacy',id=row[slot+'_asset_id'];
    const url=legacyUrlOf(row,slot);
    const copy=source==='legacy' && url && copies?.get(`${driveFileIdOf(url)}:${slot}`);
    media[slot]=source==='asset'?{source:'asset',mediaId:id,kind:slot}:
      copy?{source:'asset',mediaId:copy,kind:slot}:
      source==='legacy' && url?{source:'legacy',url}:{source:'none'};
  }
  return media;
}
// One bounded query per response, never an asset/key/URL lookup per row.
export async function decorateMediaRows(rows,type,runQuery) {
  if(!rows.length)return rows;
  const idOf=r=>type==='exercise'?r.id:r.plan_item_id||r.item_id||r.id;
  const ids=[...new Set(rows.map(idOf).filter(Boolean))];
  if(!ids.length)return rows;
  const table=type==='exercise'?'library.exercises':'plans.plan_items';
  const found=await runQuery(`select id,coalesce(to_jsonb(m)->>'video_source','legacy') as video_source,(to_jsonb(m)->>'video_asset_id')::uuid as video_asset_id,
      coalesce(to_jsonb(m)->>'image_source','legacy') as image_source,(to_jsonb(m)->>'image_asset_id')::uuid as image_asset_id from ${table} m where id=any($1::uuid[])`,[ids]);
  const byId=new Map(found.rows.map(r=>[r.id,r]));
  // The Drive files named by legacy slots, and their ready copies: one query.
  const driveIds=[];
  if(mediaEnabled())for(const row of rows) {
    const selection=byId.get(idOf(row));if(!selection)continue;
    for(const slot of slots)if(selection[slot+'_source']==='legacy')driveIds.push(driveFileIdOf(legacyUrlOf(row,slot)));
  }
  const copies=await readyDriveCopies(runQuery,driveIds);
  for(const row of rows) {
    const selection=byId.get(idOf(row));if(!selection)continue;
    if(!mediaEnabled() && selection.video_source==='legacy' && selection.image_source==='legacy')continue;
    Object.assign(row,selection,{id:row.id});
    row.media=describeMedia(row,{type,id:idOf(row)},copies);
    for(const slot of slots)if(selection[slot+'_source']!=='legacy' || row.media[slot].source==='asset') {
      row[slot+'_url']='';if(Object.hasOwn(row,'effective_'+slot+'_url'))row['effective_'+slot+'_url']='';
    }
  }
  return rows;
}

// Caller owns the exercise transaction and existing edit/copy/reuse guard.
// Upload row lock serializes the first exercise_create binding without a new table.
export async function bindExerciseMedia(client,req,exerciseId,body,{creating=false,previous=null}={}) {
  if(body.media===undefined && !mediaEnabled())return;
  if(!Object.keys(mediaSelections(body)).length)return;
  const run=client.query.bind(client);
  await lockExerciseReuse(client,req.exerciseReuseGuard);
  const exercise=(await run(`select e.* from library.exercises e where e.id=$2 and (${exerciseLibraryScopeSql}) and e.is_active=true for update of e`,[req.user.id,uuid(exerciseId)])).rows[0];
  if(!exercise)fail(404,'resource_not_found');
  const selections=mediaSelections(body,previous||exercise);
  if(!Object.keys(selections).length)return;
  const admin=await hasExerciseAdministration(req.user.id,req.authz,run);
  if(!req.authz?.capabilities?.coachWorkspace || !(admin || exercise.owner_scope==='user' && exercise.owner_user_id===req.user.id))fail(403,'operation_not_allowed');
  const assetIds=Object.values(selections).filter(s=>s.source==='asset').map(s=>s.mediaId).sort();
  if(assetIds.length) {
    await run('select id from media.uploads where asset_id=any($1::uuid[]) and uploaded_by_user_id=$2 order by id for update',[assetIds,req.user.id]);
    await run('select id from media.assets where id=any($1::uuid[]) order by id for share',[assetIds]);
  }
  for(const slot of slots) {
    const selection=selections[slot];if(!selection)continue;
    if(selection.source==='asset') {
      const a=(await run(`select a.*,u.id as upload_id,u.status as upload_status,u.context,sa.owner_user_id,sa.owner_club_id
        from media.assets a join media.uploads u on u.asset_id=a.id join media.storage_accounts sa on sa.id=a.storage_account_id
        where a.id=$1 and u.uploaded_by_user_id=$2 for update of u`,[selection.mediaId,req.user.id])).rows[0];
      const ownerOk=a && (exercise.owner_scope==='club'?a.owner_club_id===exercise.owner_club_id:
        a.owner_user_id===(exercise.owner_scope==='system'?req.user.id:exercise.owner_user_id));
      if(!ownerOk)fail(404,'resource_not_found');
      const ctx=a.context;
      const valid=ctx.type==='exercise_edit'?ctx.exerciseId===exercise.id:
        ctx.type==='exercise_create' && (ctx.boundExerciseId===exercise.id || creating && !ctx.boundExerciseId && exercise.owner_scope==='user' && exercise.owner_user_id===req.user.id);
      if(!valid)fail(404,'resource_not_found');
      if(a.status!=='ready' || a.upload_status!=='completed')fail(409,'media_not_ready');
      if(a.kind!==slot)fail(415,'media_kind_mismatch');
      if(ctx.type==='exercise_create' && !ctx.boundExerciseId)await run("update media.uploads set context=jsonb_set(context,'{boundExerciseId}',to_jsonb($2::text)),updated_at=now() where id=$1",[a.upload_id,exercise.id]);
    }
    await run(`update library.exercises set ${slot}_source=$2,${slot}_asset_id=$3,${slot}_url=case when $2='legacy' then $4 else ${slot}_url end,updated_at=now() where id=$1`,
      [exercise.id,selection.source,selection.mediaId||null,selection.url||null]);
  }
}
export async function snapshotExerciseMedia(run,exerciseId,itemId) {
  await run(`update plans.plan_items p set video_source=e.video_source,video_asset_id=e.video_asset_id,image_source=e.image_source,image_asset_id=e.image_asset_id,video_url=case when e.video_source='legacy' then coalesce(p.video_url,e.video_url) else e.video_url end,image_url=case when e.image_source='legacy' then coalesce(p.image_url,e.image_url) else e.image_url end
    from library.exercises e where e.id=$1 and p.id=$2`,[exerciseId,itemId]);
}
// One request's own checks, before any database work, in the order and with
// the codes they always had.
function accessRequest(req,body) {
  if(!mediaEnabled())fail(503,'media_storage_disabled');
  if(!req.user)fail(401,'authentication_required');
  const context=body?.context,wanted=body?.slots;
  if(!context || !['exercise','plan_item','upload'].includes(context.type) || !Array.isArray(wanted) || !wanted.length || wanted.length>2 || wanted.some(s=>!slots.includes(s)))fail(400,'invalid_request');
  const id=uuid(context.id);
  return {type:context.type,id,key:context.type+':'+id,slots:[...new Set(wanted)]};
}
// The asset a slot of an authorized row plays: its own, or for a legacy Drive
// link the ready copy (copies: readyDriveCopies of every such link at once).
const ownAssetOf=(row,slot)=>row[slot+'_source']==='asset'?row[slot+'_asset_id']:null;
const legacyDriveOf=(row,slot)=>!ownAssetOf(row,slot) && (row[slot+'_source'] || 'legacy')==='legacy'?driveFileIdOf(legacyUrlOf(row,slot)):null;
const slotAssetOf=(row,slot,copies)=>ownAssetOf(row,slot) || (legacyDriveOf(row,slot) && copies.get(`${legacyDriveOf(row,slot)}:${slot}`)) || null;
// Option A of the image-latency discovery (owner, 2026-10-30): one transaction
// for a whole batch, the contexts of a type authorized together, with the
// same rules a single context always had - the same SQL fragments
// (exerciseReadScopeSql, exerciseMediaJoinSql) over `= any(...)`, the
// plan-access functions once per plan, an upload's own checks one by one.
// A context that is missing, foreign, revoked or not allowed answers 404
// resource_not_found on its own and never fails or shows the others. access()
// is a batch of one, so there is one authorization path.
export function createMediaAccessService({pool,store,canReadPlan=canAccessPlan,approvalRequired=needsTemplateApproval}) {
  // The rows each authorized context may play, by `type:id`.
  async function authorizedRows(run,req,requests) {
    const rows=new Map();
    const idsOf=type=>[...new Set(requests.filter(r=>r.type===type).map(r=>r.id))];
    const exerciseIds=idsOf('exercise');
    if(exerciseIds.length && req.authz?.capabilities?.coachWorkspace) {
      // The effective links (a private copy inherits its source's): a Drive copy is found by them.
      const found=await run(`select e.*,coalesce(e.video_url,fallback_media.video_url) as effective_video_url,coalesce(e.image_url,fallback_media.image_url) as effective_image_url
        from library.exercises e ${exerciseMediaJoinSql} where e.id=any($2::uuid[]) and ${exerciseReadScopeSql}`,[req.user.id,exerciseIds]);
      for(const row of found.rows)rows.set('exercise:'+row.id,row);
    }
    const itemIds=idsOf('plan_item');
    if(itemIds.length) {
      const items=(await run(`select pi.*,pd.plan_id from plans.plan_items pi join plans.plan_sessions ps on ps.id=pi.plan_session_id join plans.plan_days pd on pd.id=ps.plan_day_id where pi.id=any($1::uuid[])`,[itemIds])).rows;
      const planIds=[...new Set(items.map(item=>item.plan_id))];
      const plans=new Map(planIds.length?(await run('select * from plans.plans where id=any($1::uuid[])',[planIds])).rows.map(plan=>[plan.id,plan]):[]);
      // A plan's access depends on the plan alone: asked once per plan, not per item.
      const readable=new Set();
      for(const planId of planIds) {
        const plan=plans.get(planId);
        if(plan && (plan.is_active!==false || plan.is_edit_draft===true) && await canReadPlan(run,req,planId,{editable:true}) && !await approvalRequired(run,req,plan,planId))readable.add(planId);
      }
      for(const item of items)if(readable.has(item.plan_id))rows.set('plan_item:'+item.id,item);
    }
    // An upload preview (the editor's, one or two at a time): its own checks.
    for(const id of idsOf('upload')) {
      const u=(await run("select u.*,a.kind from media.uploads u join media.assets a on a.id=u.asset_id where u.id=$1 and u.uploaded_by_user_id=$2 and u.status='completed'",[id,req.user.id])).rows[0];
      if(!u)continue;
      // A completed edit upload is still subject to current source rights.
      if(u.context.type==='drive_import') {
        if(!req.authz?.platformRoles?.includes('platform_admin'))continue;
        const mapped=await run(`select c.asset_id from media.drive_copies c
          join media.storage_accounts a on a.id=$3 and a.owner_platform
          where c.drive_file_id=$1 and c.kind=$2 and c.asset_id=$4 for share of c`,
          [u.context.driveFileId,u.kind,u.storage_account_id,u.asset_id]);
        if(!mapped.rowCount)continue;
      } else if(u.context.type==='exercise_edit' || u.context.boundExerciseId) {
        const target=u.context.exerciseId||u.context.boundExerciseId;
        if(!req.authz?.capabilities?.coachWorkspace || !(await run(`select e.id from library.exercises e where e.id=$2 and ${exerciseReadScopeSql}`,[req.user.id,target])).rowCount)continue;
      } else if(!req.authz?.capabilities?.coachWorkspace)continue;
      rows.set('upload:'+id,{[u.kind+'_source']:'asset',[u.kind+'_asset_id']:u.asset_id});
    }
    return rows;
  }
  // One outcome per body, in order: { media } or { error } (a MediaStorageError).
  async function resolve(req,bodies) {
    const outcomes=bodies.map(body=>{
      try {return {request:accessRequest(req,body)};}
      catch(e){if(!(e instanceof MediaStorageError))throw e;return {error:e};}
    });
    const requests=outcomes.filter(o=>o.request).map(o=>o.request);
    if(!requests.length)return outcomes;
    const c=await pool.connect();
    try {
      // The shared reuse lock once for the batch: it guards reads against an
      // application-block change, and every context's reads are inside it.
      await c.query('begin');await c.query("set local statement_timeout='10s'");await lockExerciseReuse(c);
      const run=c.query.bind(c);
      const rows=await authorizedRows(run,req,requests);
      const driveIds=[];
      for(const request of requests) {
        const row=rows.get(request.key);
        if(row)for(const slot of request.slots)driveIds.push(legacyDriveOf(row,slot));
      }
      // A legacy Drive link of an authorized row, with a ready copy: one query.
      const copies=await readyDriveCopies(run,driveIds);
      const pairs=new Map();
      for(const request of requests) {
        const row=rows.get(request.key);
        if(row)for(const slot of request.slots) {
          const assetId=slotAssetOf(row,slot,copies);
          if(assetId)pairs.set(assetId+':'+slot,[assetId,slot]);
        }
      }
      const assets=new Map();
      if(pairs.size) {
        const wanted=[...pairs.values()];
        const found=await run(`select a.* from media.assets a join unnest($1::uuid[],$2::text[]) as wanted(id,kind) on a.id=wanted.id and a.kind=wanted.kind
          where a.status='ready' order by a.id for share of a`,[wanted.map(p=>p[0]),wanted.map(p=>p[1])]);
        for(const asset of found.rows)assets.set(asset.id+':'+asset.kind,asset);
      }
      for(const outcome of outcomes) {
        if(!outcome.request)continue;
        try {
          const request=outcome.request,row=rows.get(request.key);
          if(!row)fail(404,'resource_not_found');
          const result={};
          for(const slot of request.slots) {
            const assetId=slotAssetOf(row,slot,copies);
            if(!assetId)continue;
            const asset=assets.get(assetId+':'+slot);
            if(!asset)fail(404,'resource_not_found');
            const signed=await store.signGet(asset);
            result[slot]={source:'asset',mediaId:asset.id,mimeType:asset.mime_type,...signed};
          }
          outcome.media=result;
        } catch(e){if(!(e instanceof MediaStorageError))throw e;outcome.error=e;}
      }
      await c.query('commit');return outcomes;
    } catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
  }
  return {
    async access(req,body) {
      const [outcome]=await resolve(req,[body]);
      if(outcome.error)throw outcome.error;
      return outcome.media;
    },
    async batch(req,body) {
      if(!Array.isArray(body?.requests) || body.requests.length<1 || body.requests.length>50)fail(400,'invalid_request');
      const outcomes=await resolve(req,body.requests);
      return {results:outcomes.map(({media,error},index)=>error?{index,error:{code:error.code,status:error.status,retryable:Boolean(error.retryable)}}:{index,media})};
    },
  };
}
