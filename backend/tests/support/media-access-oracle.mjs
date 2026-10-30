// The media access service as it was before option A (main e7d7e4f,
// backend/src/exerciseMedia.js): one transaction per context, the contexts of
// a batch one after another. Kept unchanged as the oracle of the equivalence
// tests in media-binding-be3.test.mjs - the set-based batch must answer every
// context exactly as this does. It uses the same helpers (the same SQL
// fragments and plan-access functions) as the service itself.
import { MediaStorageError, uuid } from '../../src/mediaStorage.js';
import { exerciseReadScopeSql, lockExerciseReuse } from '../../src/exerciseAccess.js';
import { canAccessPlan } from '../../src/access.js';
import { needsTemplateApproval } from '../../src/programAccessPolicy.js';
import { exerciseMediaJoinSql } from '../../src/exercisePersonalization.js';
import { driveFileIdOf, readyDriveCopies } from '../../src/driveCopies.js';
import { mediaEnabled } from '../../src/exerciseMedia.js';

const slots=['video','image'];
const fail=(status,code)=>{throw new MediaStorageError(status,code);};
const legacyUrlOf=(row,slot)=>row['effective_'+slot+'_url']??row[slot+'_url']??'';

export function createOracleMediaAccessService({pool,store,canReadPlan=canAccessPlan,approvalRequired=needsTemplateApproval}) {
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
        // The effective links (a private copy inherits its source's): a Drive copy is found by them.
        row=(await run(`select e.*,coalesce(e.video_url,fallback_media.video_url) as effective_video_url,coalesce(e.image_url,fallback_media.image_url) as effective_image_url
          from library.exercises e ${exerciseMediaJoinSql} where e.id=$2 and ${exerciseReadScopeSql}`,[req.user.id,id])).rows[0];
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
          if(u.context.type==='drive_import') {
            if(!req.authz?.platformRoles?.includes('platform_admin'))fail(404,'resource_not_found');
            const mapped=await run(`select c.asset_id from media.drive_copies c
              join media.storage_accounts a on a.id=$3 and a.owner_platform
              where c.drive_file_id=$1 and c.kind=$2 and c.asset_id=$4 for share of c`,
              [u.context.driveFileId,u.kind,u.storage_account_id,u.asset_id]);
            if(!mapped.rowCount)fail(404,'resource_not_found');
          } else if(u.context.type==='exercise_edit' || u.context.boundExerciseId) {
            const target=u.context.exerciseId||u.context.boundExerciseId;
            if(!req.authz?.capabilities?.coachWorkspace || !(await run(`select e.id from library.exercises e where e.id=$2 and ${exerciseReadScopeSql}`,[req.user.id,target])).rowCount)fail(404,'resource_not_found');
          } else if(!req.authz?.capabilities?.coachWorkspace)fail(404,'resource_not_found');
          row={[u.kind+'_source']:'asset',[u.kind+'_asset_id']:u.asset_id};
        }
      }
      if(!row)fail(404,'resource_not_found');
      const result={};
      for(const slot of new Set(wanted)) {
        let assetId=row[slot+'_source']==='asset'?row[slot+'_asset_id']:null;
        if(!assetId && (row[slot+'_source'] || 'legacy')==='legacy') {
          // A legacy Drive link of this row, authorized above, with a ready copy.
          const drive=driveFileIdOf(legacyUrlOf(row,slot));
          if(drive)assetId=(await readyDriveCopies(run,[drive])).get(`${drive}:${slot}`) || null;
        }
        if(!assetId)continue;
        const asset=(await run("select * from media.assets where id=$1 and status='ready' and kind=$2 for share",[assetId,slot])).rows[0];
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
