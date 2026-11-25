import {validReferencePreview,referencePreviewWidgets,referencePreviewFingerprint,assertReferenceSource} from '../dashboardReferences/preview.js';
import { attachReferenceResults } from "../dashboardReferences/query.js";
import { resolveReferenceContext } from "../dashboardReferences/access.js";
import {attachGalleryResult,hydrateGalleryWidgets} from '../dashboardGallery/query.js';
import { isMetricVisibleToDashboard, isSourceConnectionVisibleToDashboard } from '../trainingLoadDashboardAccess.js';
import { assertDashboardAggregation } from '../dashboardRatios.js';
import { queryDashboardForViewer } from '../trainingLoadDashboardQuery.js';
import { normalizeShellFilter } from '../dashboardShellFilter.js';
import { resolvePeriod } from '../dashboardSimple/compiler.js';
import { validateContract } from '../dashboardSimple/schema.js';
import {createHash} from 'node:crypto';
import {loadAuthorizationContext} from '../authz.js';
import {pickFallbackWorkspace,resolveActiveWorkspaceReadOnly} from '../workspace.js';
import {viewReadScope} from '../moduleView.js';
import {athleteTrainingLoadAllowed} from '../athleteTrainingLoadLicence.js';
import {canViewDashboardRow,canManageDashboardRow,dashboardWidgetsForViewer,dashboardNamedAthletesAllowed,dataWorkspaceForActiveWorkspace,dataWorkspaceMatches,redactDashboardAthleteFilters} from '../trainingLoadDashboardAccess.js';
import {canonicalKey} from '../dashboardSimple/compiler.js';
import {isUuid} from '../dashboardSimple/schema.js';
import {pageDatabaseEnabled} from './config.js';

export const pageError=(code='notFound',status=404)=>Object.assign(new Error(code),{code,httpStatus:status,status});
const requestWindow=7*24*60*60*1000;
function validIssuedAt(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function freshRequest(body,now){const age=now()-Date.parse(body.requestIssuedAt);if(age>requestWindow)throw pageError('requestExpired',409);if(age< -1000)throw pageError('invalidRequest',400);}
async function recordedPageRequest(q,target,userId,requestId,hash,operation,now){
 const row=(await q('select * from training_load.dashboard_page_requests where initiator_user_id=$1 and request_id=$2',[userId,requestId])).rows[0];if(!row)return null;
 if(row.dashboard_id!==target.dashboard.id||row.payload_hash!==hash||row.operation!==operation||canonicalKey(row.workspace)!==canonicalKey(target.workspace))throw pageError('idempotencyConflict',409);
 if(now()>new Date(row.retain_until).getTime())throw pageError('requestExpired',409);return {receipt:row.receipt};
}
async function lockActor(q,req){
 await q('select id from public.users where id=$1 for share',[req.user.id]);
 if(req.sessionToken)await q('select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 for share',[req.user.id,createHash('sha256').update(String(req.sessionToken)).digest('base64url')]);
 for(const table of ['user_global_roles','user_club_roles','user_team_roles','user_workspace_preferences'])await q(`select user_id from public.${table} where user_id=$1 for share`,[req.user.id]);
}
export async function pageTarget(q,req,dashboardId,{write=false,manage=false}={}){
 if(req.dashboardsViewRefused||!isUuid(req.user?.id)||!isUuid(dashboardId))throw pageError();
 const args=[req.user.id];
 let sessionSql='';
 if(req.sessionToken){args.push(createHash('sha256').update(String(req.sessionToken)).digest('base64url'));sessionSql='and exists(select 1 from public.auth_sessions s where s.user_id=u.id and s.token_hash=$2 and s.expires_at>now())';}
 const user=(await q(`select u.* from public.users u where u.id=$1 and u.is_active=true ${sessionSql}`,args)).rows[0];
 if(!user)throw pageError();
 const authz=await loadAuthorizationContext(user,q);
 const resolved=await resolveActiveWorkspaceReadOnly(user.id,authz,q);
 // Roles V-6: a view workspace reads a page only on a read the dashboards gate admitted (req.moduleView), in the workspace
 // the gate resolved (its fallback included); anything else of a view workspace, and any workspace without a data
 // workspace (no dashboards.view there, as the legacy routes' requireDataWorkspace), answers the 404. A view actor never
 // manages (canManageDashboardRow).
 const admitted=req.moduleView?.module==='dashboards'&&!write&&!manage;
 const active=resolved.workspace||(admitted?pickFallbackWorkspace(resolved.availableWorkspaces):null);
 if(!active || (admitted && (active.type!==req.moduleView.workspace.type || String(active.scopeId)!==String(req.moduleView.workspace.scopeId))))throw pageError();
 if(active.type==="athlete"&&!(await athleteTrainingLoadAllowed(authz.athleteId,q)))throw pageError();
 const actor={user,authz};
 if(viewReadScope(active)){if(admitted)actor.moduleView=req.moduleView;else actor.dashboardsViewRefused=true;}
 const workspace=dataWorkspaceForActiveWorkspace(active,actor);
 if(actor.dashboardsViewRefused||!workspace.dataWorkspaceType)throw pageError();
 const dashboard=(await q('select * from training_load.dashboards where id=$1',[dashboardId])).rows[0];
 if(!dashboard||!((write||manage)?canManageDashboardRow(actor,dashboard):canViewDashboardRow(actor,dashboard,workspace)))throw pageError();
 if(write&&dashboard.status!=='active')throw pageError('dashboardArchived',409);
 return {req:actor,workspace,dashboard};
}
export async function requirePage(q,dashboardId,pageId){
 if(!isUuid(pageId))throw pageError();
 const page=(await q('select * from training_load.dashboard_pages where dashboard_id=$1 and id=$2',[dashboardId,pageId])).rows[0];
 if(!page)throw pageError();return page;
}
export function createPageService({pool,now=()=>Date.now(),validateWidgetBody=()=>false}){
 async function transaction(fn){const c=await pool.connect();try{await c.query('begin');await c.query("set local statement_timeout='5000ms';set local lock_timeout='2000ms'");const result=await fn(c.query.bind(c));await c.query('commit');return result;}catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release()}}
 async function read({req,dashboardId,pageId=null}){
  return transaction(async q=>{const target=await pageTarget(q,req,dashboardId);if(!(await pageDatabaseEnabled(q)))throw pageError();
   const pages=(await q('select * from training_load.dashboard_pages where dashboard_id=$1 order by position,id',[dashboardId])).rows;
   if(pageId&&!pages.some(p=>p.id.toLowerCase()===pageId.toLowerCase()))throw pageError();
   const shown=dashboardNamedAthletesAllowed(target.req,target.workspace)?{pages}:redactDashboardAthleteFilters({pages});
   return {requestIssuedAt:new Date(now()).toISOString(),pages:shown.pages,pagesRevision:target.dashboard.pages_revision,canManage:target.dashboard.status==='active'&&canManageDashboardRow(target.req,target.dashboard)};
  });
 }
 async function mutate({req,dashboardId,pageId=null,operation,body}){
  if(!body||!isUuid(body.requestId)||!validIssuedAt(body.requestIssuedAt))throw pageError('invalidRequest',400);
  if(!Number.isSafeInteger(body.expectedPagesRevision)||body.expectedPagesRevision<1)throw pageError('invalidRequest',400);
  return transaction(async q=>{
   await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-page:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
   await lockActor(q,req);
   const target=await pageTarget(q,req,dashboardId,{write:true});
   if(!(await pageDatabaseEnabled(q)))throw pageError();
   await q('select id from training_load.dashboards where id=$1 for update',[dashboardId]);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   const hash=createHash('sha256').update(canonicalKey({dashboardId:dashboardId.toLowerCase(),pageId:pageId?.toLowerCase()??null,operation,body})).digest('hex');
   const replay=await recordedPageRequest(q,target,req.user.id,body.requestId,hash,operation,now);if(replay)return replay;freshRequest(body,now);
   if(pageId)await requirePage(q,dashboardId,pageId);

   const receipt=(await q('select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) receipt',
    [dashboardId,req.user.id,target.workspace,body.requestId,hash,body.expectedPagesRevision,operation,pageId,body.input,body.requestIssuedAt])).rows[0].receipt;
   return {receipt};
  });
 }
 async function detail({req,dashboardId,pageId}){
  return transaction(async q=>{
   const target=await pageTarget(q,req,dashboardId);if(!await pageDatabaseEnabled(q))throw pageError();
   const page=await requirePage(q,dashboardId,pageId);
   const widgets=(await q('select * from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by widget_order,id',[dashboardId,page.id])).rows;
   const series=widgets.length?(await q('select * from training_load.dashboard_widget_series where widget_id=any($1::uuid[]) order by widget_id,series_order,id',[widgets.map(w=>w.id)])).rows:[];
   const pages=(await q('select * from training_load.dashboard_pages where dashboard_id=$1 order by position,id',[dashboardId])).rows;
   const full={dashboard:target.dashboard,page,pages,widgets:dashboardWidgetsForViewer(target.req,widgets).map(w=>({...w,series:series.filter(s=>s.widget_id===w.id)}))};
   // Roles V-6: without load.view.athlete the filters' athletes are not returned (dashboard, pages, widgets).
   const shown=dashboardNamedAthletesAllowed(target.req,target.workspace)?full:redactDashboardAthleteFilters(full);
   return {requestIssuedAt:new Date(now()).toISOString(),dashboard:shown.dashboard,page:shown.page,resolvedPeriod:page.period_config?resolvePeriod(page.period_config,new Date(now()).toISOString()):null,pages:shown.pages,pagesRevision:target.dashboard.pages_revision,canManage:target.dashboard.status==='active'&&canManageDashboardRow(target.req,target.dashboard),widgets:shown.widgets};
  });
 }
 async function queryPage({req,dashboardId,pageId,body}){
  return transaction(async q=>{
   const target=await pageTarget(q,req,dashboardId);if(!await pageDatabaseEnabled(q))throw pageError();
   if(target.dashboard.data_workspace_type===null)throw pageError('templateRequiresClone',409);
   if(!dataWorkspaceMatches(target.workspace,target.dashboard))throw pageError();
   if(target.dashboard.status!=='active')throw pageError('dashboardArchived',409);
   const page=await requirePage(q,dashboardId,pageId);
   const period=body.dateFrom&&body.dateTo?{dateFrom:body.dateFrom,dateTo:body.dateTo,timeZone:body.timeZone??'UTC'}:page.period_config?resolvePeriod(page.period_config,new Date(now()).toISOString()):null;
   if(!period||!validateContract('context',{kind:'legacyDashboard',period}).valid)throw pageError('invalidRequest',400);
   const filter=Object.fromEntries(['athleteIds','activityId','componentId'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
   if(!validateContract('runtimeFilter',filter).valid)throw pageError('invalidRequest',400);
   let shellFilter;try{shellFilter=normalizeShellFilter(body.shellFilter)}catch{throw pageError('invalidRequest',400)}
   const widgets=(await q('select * from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by widget_order,id',[dashboardId,page.id])).rows;
   const series=widgets.length?(await q('select * from training_load.dashboard_widget_series where widget_id=any($1::uuid[]) order by widget_id,series_order,id',[widgets.map(w=>w.id)])).rows:[];
   let selected=dashboardWidgetsForViewer(target.req,widgets).filter(w=>!body.widgetIds||body.widgetIds.includes(w.id)).map(w=>({...w,series:series.filter(s=>s.widget_id===w.id)}));
   const referenceRequest={...target.req,_resolvedDataWorkspacePromise:Promise.resolve(target.workspace)};
   if(body.referencePreview!==undefined){
    if(!validReferencePreview(body.referencePreview))throw pageError('invalidRequest',400);
    if(process.env.DASHBOARD_REFERENCES_ENABLED!=='true'||!canManageDashboardRow(target.req,target.dashboard))throw pageError();
    const ctx=await resolveReferenceContext(referenceRequest);
    selected=referencePreviewWidgets(selected,body.referencePreview,ctx?.owner.clubId);await assertReferenceSource(q,body.referencePreview.referenceConfig,ctx.owner.clubId,ctx.workspace,widgets.find(w=>w.id===body.referencePreview.widgetId)?.presentation_config?.referenceConfig);
   }
   const result=await queryDashboardForViewer(target.workspace,selected,period,{defaultFilter:page.default_filter,requestFilter:filter,shellFilter,queryRunner:q},{namedAthletes:dashboardNamedAthletesAllowed(target.req,target.workspace)});
   const galleryWidgets=await hydrateGalleryWidgets(q,selected);
   const referenceEnabled=process.env.DASHBOARD_REFERENCES_ENABLED==='true';
   const referenceContext=referenceEnabled&&selected.some(w=>w.presentation_config?.referenceConfig)?await resolveReferenceContext(referenceRequest):null;
   const referenced=await attachReferenceResults({query:q,widgets:selected,results:result,workspace:target.workspace,period,defaultFilter:page.default_filter,requestFilter:filter,shellFilter,referenceClubId:referenceContext?.owner.clubId,enabled:referenceEnabled});
   return {...(body.referencePreview?{referencePreviewFingerprint:referencePreviewFingerprint({binding:body.referencePreview,period,filter,shellFilter,results:referenced})}:{}),dashboardRevision:target.dashboard.revision,pageId:page.id,pageRevision:page.revision,defaultsRevision:page.defaults_revision,resolvedPeriod:period,widgets:referenced.map(w=>attachGalleryResult(galleryWidgets.find(x=>x.id===w.widgetId),{...w,presentation_config:selected.find(x=>x.id===w.widgetId)?.presentation_config}))};
  });
 }
 async function status({req,dashboardId,requestId}){
  if(!isUuid(requestId))throw pageError('invalidRequest',400);
  return transaction(async q=>{
   const target=await pageTarget(q,req,dashboardId,{manage:true});
   if(!await pageDatabaseEnabled(q))throw pageError();
   const row=(await q('select receipt,retain_until,workspace from training_load.dashboard_page_requests where initiator_user_id=$1 and request_id=$2 and dashboard_id=$3',[req.user.id,requestId,dashboardId])).rows[0];
   if(row&&canonicalKey(row.workspace)!==canonicalKey(target.workspace))throw pageError();
   if(row&&now()>new Date(row.retain_until).getTime())throw pageError('requestExpired',409);
   return row?{status:'recorded',requestId,receipt:row.receipt}:{status:'notRecorded',requestId,retrySameRequest:true};
  });
 }
 async function copy({req,dashboardId,pageId,widgetId,body}){
  if(!body||!isUuid(body.requestId)||!isUuid(body.destinationPageId)||!isUuid(widgetId)||!validIssuedAt(body.requestIssuedAt))throw pageError('invalidRequest',400);
  if(!Number.isSafeInteger(body.expectedWidgetRevision)||body.expectedWidgetRevision<1||!Number.isSafeInteger(body.expectedPageRevision)||body.expectedPageRevision<1)throw pageError('invalidRequest',400);
  return transaction(async q=>{
   await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-page:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
   await lockActor(q,req);const target=await pageTarget(q,req,dashboardId,{write:true});
   if(!await pageDatabaseEnabled(q))throw pageError();
   await q('select id from training_load.dashboards where id=$1 for update',[dashboardId]);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   const hash=createHash('sha256').update(canonicalKey({dashboardId,pageId,widgetId,operation:'copy',body})).digest('hex');
   const replay=await recordedPageRequest(q,target,req.user.id,body.requestId,hash,'copy',now);if(replay)return replay;freshRequest(body,now);
   await requirePage(q,dashboardId,pageId);await requirePage(q,dashboardId,body.destinationPageId);
   if(!(await q('select id from training_load.dashboard_widgets where id=$1 and dashboard_id=$2 and page_id=$3 for update',[widgetId,dashboardId,pageId])).rows.length)throw pageError();
   await q('select id from training_load.dashboard_widget_series where widget_id=$1 order by id for update',[widgetId]);

   const receipt=(await q('select training_load.copy_dashboard_page_widget($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) receipt',[dashboardId,req.user.id,target.workspace,body.requestId,hash,pageId,widgetId,body.expectedWidgetRevision,body.destinationPageId,body.expectedPageRevision,body.requestIssuedAt])).rows[0].receipt;
   return {receipt};
  });
 }
 async function writeWidget({req,dashboardId,pageId,widgetId=null,seriesId=null,operation,body}){
  return transaction(async q=>{
   await lockActor(q,req);const target=await pageTarget(q,req,dashboardId,{write:true});
   if(!await pageDatabaseEnabled(q))throw pageError();
   if(!validateWidgetBody(operation,body,{req:target.req,workspace:target.workspace,mode:req.app?.locals?.dashboardSimpleMode}))throw pageError('invalidRequest',400);
   await q('select id from training_load.dashboards where id=$1 for update',[dashboardId]);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   await requirePage(q,dashboardId,pageId);
   if(operation==='layout')await q('select id from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by id for update',[dashboardId,pageId]);
   if(widgetId){
    if(!isUuid(widgetId)||!((await q('select id from training_load.dashboard_widgets where id=$1 and dashboard_id=$2 and page_id=$3 for update',[widgetId,dashboardId,pageId])).rows.length))throw pageError();
    await q('select id from training_load.dashboard_widget_series where widget_id=$1 order by id for update',[widgetId]);
   }
   if(seriesId&&!isUuid(seriesId))throw pageError();
   const normalized={...body};
   let metricId=body.metricDefinitionId;
   let oldSeries=null;
   if(['updateSeries','resolveSeries'].includes(operation)){
    oldSeries=(await q('select * from training_load.dashboard_widget_series where id=$1 and widget_id=$2',[seriesId,widgetId])).rows[0];if(!oldSeries)throw pageError();metricId=metricId??oldSeries.metric_definition_id;
   }
   if(metricId){
    const {visible,def}=await isMetricVisibleToDashboard(target.dashboard,metricId);if(!visible||!def||(def.state!=='active'&&operation!=='updateSeries'))throw pageError();
    const ratio=def.calculation_kind==='ratio';
    if(operation==='addSeries'){
     normalized.analyticalAggregation??=ratio?'ratio':'sum';normalized.aggregationRolePolicy??=ratio?'all_including_derived':'standalone_and_source_rollup';
    }
    assertDashboardAggregation(ratio?{kind:'ratio'}:null,normalized.analyticalAggregation??oldSeries?.analytical_aggregation,normalized.aggregationRolePolicy??oldSeries?.aggregation_role_policy);
    await q('select id from training_load.metric_definitions where id=$1 for share',[metricId]);
    await q('select v.id from training_load.metric_definition_versions v join training_load.metric_definitions d on d.current_version_id=v.id where d.id=$1 for share of v',[metricId]);
   }
   if(body.sourceConnectionId){const {visible,conn}=await isSourceConnectionVisibleToDashboard(target.dashboard,body.sourceConnectionId);if(!visible||!conn||conn.state!=='active')throw pageError();await q('select id from training_load.metric_source_connections where id=$1 for share',[body.sourceConnectionId]);}
   if(body.widgetType){const type=(await q('select key from training_load.dashboard_widget_types where key=$1 and is_active for share',[body.widgetType])).rows[0];if(!type)throw pageError('invalidRequest',400);}
   if(body.builtInSeriesKey)await q('select key from training_load.dashboard_builtin_series where key=$1 for share',[body.builtInSeriesKey]);
   return (await q('select training_load.write_dashboard_page_widget($1,$2,$3,$4,$5,$6,$7,$8) result',[dashboardId,pageId,body.expectedPageRevision??null,operation,widgetId,seriesId,req.user.id,normalized])).rows[0].result;
  });
 }
 return {read,detail,queryPage,mutate,status,copy,writeWidget};
}
