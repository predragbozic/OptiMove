import { MediaStorageError, uuid } from './mediaStorage.js';
import { exerciseReadScopeSql, exerciseLibraryScopeSql, hasExerciseAdministration, lockExerciseReuse } from './exerciseAccess.js';
import { canAccessPlan } from './access.js';
import { needsTemplateApproval } from './programAccessPolicy.js';

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
    if(explicit===undefined && ['asset','none'].includes(current?.[slot+'_source'])) {
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
export function describeMedia(row,context) {
  const media={accessContext:context};
  for(const slot of slots) {
    const source=row[slot+'_source']||'legacy',id=row[slot+'_asset_id'];
    const url=row['effective_'+slot+'_url']??row[slot+'_url']??'';
    media[slot]=source==='asset'?{source:'asset',mediaId:id,kind:slot}:
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
  for(const row of rows) {
    const selection=byId.get(idOf(row));if(!selection)continue;
    if(!mediaEnabled() && selection.video_source==='legacy' && selection.image_source==='legacy')continue;
    Object.assign(row,selection,{id:row.id});
    row.media=describeMedia(row,{type,id:idOf(row)});
    for(const slot of slots)if(selection[slot+'_source']!=='legacy') {
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
    // Match BE-2 completion's upload -> asset order; binding never changes an asset.
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
export function createMediaAccessService({pool,store,canReadPlan=canAccessPlan,approvalRequired=needsTemplateApproval}) {
  async function access(req,body) {
    if(!mediaEnabled())fail(503,'media_storage_disabled');
    if(!req.user)fail(401,'authentication_required');
    const context=body?.context,wanted=body?.slots;
    if(!context || !['exercise','plan_item','upload'].includes(context.type) || !Array.isArray(wanted) || !wanted.length || wanted.length>2 || wanted.some(s=>!slots.includes(s)))fail(400,'invalid_request');
    const id=uuid(context.id),c=await pool.connect();
    try {
      await c.query('begin');await c.query("set local statement_timeout='10s'");await lockExerciseReuse(c);
      const run=c.query.bind(c);let row;
      if(context.type==='exercise') {
        if(!req.authz?.capabilities?.coachWorkspace)fail(404,'resource_not_found');
        row=(await run(`select e.* from library.exercises e where e.id=$2 and ${exerciseReadScopeSql}`,[req.user.id,id])).rows[0];
      } else if(context.type==='plan_item') {
        const item=(await run(`select pi.*,pd.plan_id from plans.plan_items pi join plans.plan_sessions ps on ps.id=pi.plan_session_id join plans.plan_days pd on pd.id=ps.plan_day_id where pi.id=$1`,[id])).rows[0];
        if(item) {
          const plan=(await run('select * from plans.plans where id=$1',[item.plan_id])).rows[0];
          if(plan && (plan.is_active!==false || plan.is_edit_draft===true) && await canReadPlan(run,req,item.plan_id,{editable:true}) && !await approvalRequired(run,req,plan,item.plan_id))row=item;
        }
      } else {
        const u=(await run("select u.*,a.kind from media.uploads u join media.assets a on a.id=u.asset_id where u.id=$1 and u.uploaded_by_user_id=$2 and u.status='completed'",[id,req.user.id])).rows[0];
        if(u) {
          // A completed edit upload is still subject to current source rights.
          if(u.context.type==='exercise_edit' || u.context.boundExerciseId) {
            const target=u.context.exerciseId||u.context.boundExerciseId;
            if(!req.authz?.capabilities?.coachWorkspace || !(await run(`select e.id from library.exercises e where e.id=$2 and ${exerciseReadScopeSql}`,[req.user.id,target])).rowCount)fail(404,'resource_not_found');
          } else if(!req.authz?.capabilities?.coachWorkspace)fail(404,'resource_not_found');
          row={[u.kind+'_source']:'asset',[u.kind+'_asset_id']:u.asset_id};
        }
      }
      if(!row)fail(404,'resource_not_found');
      const result={};
      for(const slot of new Set(wanted)) {
        if(row[slot+'_source']!=='asset')continue;
        const asset=(await run("select * from media.assets where id=$1 and status='ready' and kind=$2 for share",[row[slot+'_asset_id'],slot])).rows[0];
        if(!asset)fail(404,'resource_not_found');
        const signed=await store.signGet(asset);
        result[slot]={source:'asset',mediaId:asset.id,mimeType:asset.mime_type,...signed};
      }
      await c.query('commit');return result;
    } catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
  }
  return {access,async batch(req,body) {
    if(!Array.isArray(body?.requests) || body.requests.length<1 || body.requests.length>50)fail(400,'invalid_request');
    const results=[];
    for(const [index,request] of body.requests.entries())try{results.push({index,media:await access(req,request)});}catch(e){if(!(e instanceof MediaStorageError))throw e;results.push({index,error:{code:e.code,status:e.status,retryable:Boolean(e.retryable)}});}
    return {results};
  }};
}
