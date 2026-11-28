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
import {createHash,randomUUID} from 'node:crypto';
import {loadAuthorizationContext} from '../authz.js';
import {pickFallbackWorkspace,resolveActiveWorkspaceReadOnly} from '../workspace.js';
import {viewReadScope} from '../moduleView.js';
import {athleteTrainingLoadAllowed} from '../athleteTrainingLoadLicence.js';
import {canViewDashboardRow,canManageDashboardRow,dashboardWidgetsForViewer,dashboardNamedAthletesAllowed,dataWorkspaceForActiveWorkspace,dataWorkspaceMatches,redactDashboardAthleteFilters} from '../trainingLoadDashboardAccess.js';
import {canonicalKey} from '../dashboardSimple/compiler.js';
import {isUuid} from '../dashboardSimple/schema.js';
import {pageDatabaseEnabled} from './config.js';
import {buildGalleryDraft,bindGallerySeries} from './galleryDraft.js';
import {buildAdvancedPreviewWidget} from './advancedPreview.js';
import {adminWriteKit} from '../sourceMetricMappingService.js';
import {dashboardManageOffered,dashboardWorkspaceWriteScope,dashboardOwnerWriteScope,lockDashboardManageCeilings,dashboardManageRightsStillHold,lockDashboardActor,markDashboardManageWrite} from '../dashboardManageAccess.js';

export const pageError=(code='notFound',status=404)=>Object.assign(new Error(code),{code,httpStatus:status,status});

async function buildMetricPreviewWidget(q, dashboard, widgets, draft) {
 const fields=['widgetId','widgetType','groupBy','title','metricDefinitionId','builtInSeriesKey','dataScopeLevel','analyticalAggregation'];
 if(!draft||typeof draft!=='object'||Array.isArray(draft)||Object.keys(draft).some(key=>!fields.includes(key))
   ||!['kpi','table','line_chart','bar_chart'].includes(draft.widgetType)
   ||!['day','week','athlete','session','component','cohort'].includes(draft.groupBy)
   ||!['day','session','component'].includes(draft.dataScopeLevel)
   ||!['sum','avg','max','last','none','ratio'].includes(draft.analyticalAggregation)
   ||typeof draft.title!=='string'||!draft.title.trim()||draft.title.length>200
   ||(draft.metricDefinitionId!==undefined)===(draft.builtInSeriesKey!==undefined)
   ||draft.metricDefinitionId!==undefined&&!isUuid(draft.metricDefinitionId)
   ||draft.builtInSeriesKey!==undefined&&typeof draft.builtInSeriesKey!=='string'
   ||draft.widgetId!==undefined&&!isUuid(draft.widgetId))throw pageError('invalidRequest',400);
 const widget=draft.widgetId?widgets.find(w=>w.id===draft.widgetId):null;
 if(draft.widgetId&&(!widget||widget.series.length!==1))throw pageError();
 const id=widget?.id??randomUUID();
 const old=widget?.series[0];
 const sameMetric=old&&(draft.metricDefinitionId?old.metric_definition_id===draft.metricDefinitionId:old.built_in_series_key===draft.builtInSeriesKey);
 let role='standalone_and_source_rollup';
 if(draft.metricDefinitionId){
  const {visible,def}=await isMetricVisibleToDashboard(dashboard,draft.metricDefinitionId,q);
  if(!visible||!def||def.state!=='active'&&!sameMetric)throw pageError();
  role=def.calculation_kind==='ratio'?'all_including_derived':role;
  assertDashboardAggregation(def.calculation_kind==='ratio'?{kind:'ratio'}:null,draft.analyticalAggregation,sameMetric?old.aggregation_role_policy:role);
 }else{
  const builtin=(await q('select fixed_data_scope_level from training_load.dashboard_builtin_series where key=$1 and is_active',[draft.builtInSeriesKey])).rows[0];
  if(!builtin||builtin.fixed_data_scope_level&&builtin.fixed_data_scope_level!==draft.dataScopeLevel)throw pageError('invalidRequest',400);
 }
 const shape=sameMetric&&widget.widget_type===draft.widgetType?widget.presentation_config?.chartShape:null;
 return {...widget,id,widget_type:draft.widgetType,group_by:draft.groupBy,title:draft.title,
  display_config:widget?.display_config??{schemaVersion:1},presentation_config:shape?{schemaVersion:1,chartShape:shape}:null,
  series:[{...(sameMetric?old:{}),id:old?.id??randomUUID(),widget_id:id,series_order:1,resolution_status:'resolved',
   metric_definition_id:draft.metricDefinitionId??null,built_in_series_key:draft.builtInSeriesKey??null,
   data_scope_level:draft.dataScopeLevel,analytical_aggregation:draft.analyticalAggregation,
   aggregation_role_policy:sameMetric?old.aggregation_role_policy:role}]};
}
const requestWindow=7*24*60*60*1000;
function validIssuedAt(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function freshRequest(body,now){const age=now()-Date.parse(body.requestIssuedAt);if(age>requestWindow)throw pageError('requestExpired',409);if(age< -1000)throw pageError('invalidRequest',400);}
async function recordedPageRequest(q,target,userId,requestId,hash,operation,now){
 const row=(await q('select * from training_load.dashboard_page_requests where initiator_user_id=$1 and request_id=$2',[userId,requestId])).rows[0];if(!row)return null;
 if(row.dashboard_id!==target.dashboard.id||row.payload_hash!==hash||row.operation!==operation||canonicalKey(row.workspace)!==canonicalKey(target.workspace))throw pageError('idempotencyConflict',409);
 if(now()>new Date(row.retain_until).getTime())throw pageError('requestExpired',409);return {receipt:row.receipt};
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
async function lockManagedPageTarget(q,req,dashboardId,{status=false}={}){
 const initial=await pageTarget(q,req,dashboardId,{manage:true});
 if(!await pageDatabaseEnabled(q))throw pageError();
 const scopes=await lockDashboardManageCeilings(q,[dashboardWorkspaceWriteScope(initial.workspace),dashboardOwnerWriteScope(initial.dashboard)]);
 await lockDashboardActor(q,req);
 const target=await pageTarget(q,req,dashboardId,{manage:true});
 if(canonicalKey(target.workspace)!==canonicalKey(initial.workspace))throw pageError();
 if(!await dashboardManageRightsStillHold(q,target.req,scopes))throw pageError();
 const lock=status?'for share':'for update';
 const dashboard=(await q('select * from training_load.dashboards where id=$1 '+lock,[dashboardId])).rows[0];
 if(!dashboard||!canManageDashboardRow(target.req,dashboard)
   ||canonicalKey(dashboardOwnerWriteScope(dashboard))!==canonicalKey(dashboardOwnerWriteScope(initial.dashboard)))throw pageError();
 if(!status&&dashboard.status!=='active')throw pageError('dashboardArchived',409);
 return {...target,dashboard,manageScopes:scopes};
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
   return {requestIssuedAt:new Date(now()).toISOString(),pages:shown.pages,pagesRevision:target.dashboard.pages_revision,canManage:target.dashboard.status==='active'&&canManageDashboardRow(target.req,target.dashboard)&&dashboardManageOffered(target.req,target.workspace,target.dashboard)};
  });
 }
 async function mutate({req,dashboardId,pageId=null,operation,body}){
  if(!body||!isUuid(body.requestId)||!validIssuedAt(body.requestIssuedAt))throw pageError('invalidRequest',400);
  if(!Number.isSafeInteger(body.expectedPagesRevision)||body.expectedPagesRevision<1)throw pageError('invalidRequest',400);
  return transaction(async q=>{
   await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-page:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
   const target=await lockManagedPageTarget(q,req,dashboardId);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   const hash=createHash('sha256').update(canonicalKey({dashboardId:dashboardId.toLowerCase(),pageId:pageId?.toLowerCase()??null,operation,body})).digest('hex');
   const copying=operation==='copyPage';
   // The immutable receipt records the sanctioned create. Its hash binds the copy
   // operation and source snapshot, so it cannot be replayed as a regular create.
   const recordedOperation=copying?'create':operation;
   const replay=await recordedPageRequest(q,target,req.user.id,body.requestId,hash,recordedOperation,now);if(replay)return replay;freshRequest(body,now);
   const source=pageId ? await requirePage(q,dashboardId,pageId) : null;
   if(copying){
    const widgets=(await q('select id,revision from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by id for update',[dashboardId,pageId])).rows;
    if(source.revision!==body.input.sourceRevision ||
      canonicalKey(Object.fromEntries(widgets.map(widget=>[widget.id,widget.revision])))!==canonicalKey(body.input.widgetRevisions)){
     throw pageError('staleRevision',409);
    }
   }

   const receipt=(await q('select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) receipt',
    [dashboardId,req.user.id,target.workspace,body.requestId,hash,body.expectedPagesRevision,recordedOperation,copying?null:pageId,copying?{name:body.input.name}:body.input,body.requestIssuedAt])).rows[0].receipt;
   if(copying){
    await q('select training_load.copy_dashboard_page_contents($1,$2,$3,$4,$5)',[dashboardId,pageId,receipt.pageId,req.user.id,body.requestId]);
   }
   await markDashboardManageWrite(q,target.req,target.manageScopes);
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
   return {requestIssuedAt:new Date(now()).toISOString(),dashboard:shown.dashboard,page:shown.page,resolvedPeriod:page.period_config?resolvePeriod(page.period_config,new Date(now()).toISOString()):null,pages:shown.pages,pagesRevision:target.dashboard.pages_revision,canManage:target.dashboard.status==='active'&&canManageDashboardRow(target.req,target.dashboard)&&dashboardManageOffered(target.req,target.workspace,target.dashboard),widgets:shown.widgets};
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
   if(body.galleryDraft!==undefined){
    if(!canManageDashboardRow(target.req,target.dashboard)||!dashboardManageOffered(target.req,target.workspace,target.dashboard))throw pageError();
    if(['widgetIds','referencePreview','metricPreview','advancedPreview'].some(key=>Object.hasOwn(body,key)))throw pageError('invalidRequest',400);
    const widget=await buildGalleryDraft(q,target,body.galleryDraft);
    const namedAthletes=dashboardNamedAthletesAllowed(target.req,target.workspace);
    const options={defaultFilter:page.default_filter,requestFilter:filter,shellFilter};
    const results=await queryDashboardForViewer(target.workspace,[widget],period,{...options,queryRunner:q,includeClubDistance:true},{namedAthletes});
    const clubId=widget.presentation_config.referenceConfig?.clubId;
    const [result]=await attachReferenceResults({query:q,widgets:[widget],results,workspace:target.workspace,period,...options,referenceClubId:clubId,enabled:Boolean(clubId)&&namedAthletes});
    const previewWidget={...widget,series:widget.series.map(({galleryCalculation,galleryUnit,...entry})=>entry)};
    return {widget:previewWidget,result:attachGalleryResult(widget,result),resolvedPeriod:period,requestIssuedAt:new Date(now()).toISOString()};
   }
   const widgets=(await q('select * from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by widget_order,id',[dashboardId,page.id])).rows;
   const series=widgets.length?(await q('select * from training_load.dashboard_widget_series where widget_id=any($1::uuid[]) order by widget_id,series_order,id',[widgets.map(w=>w.id)])).rows:[];
   let selected=dashboardWidgetsForViewer(target.req,widgets).filter(w=>!body.widgetIds||body.widgetIds.includes(w.id)).map(w=>({...w,series:series.filter(s=>s.widget_id===w.id)}));
   if(body.advancedPreview!==undefined){
    if(!canManageDashboardRow(target.req,target.dashboard)||!dashboardManageOffered(target.req,target.workspace,target.dashboard))throw pageError();
    if(['widgetIds','referencePreview','metricPreview'].some(key=>Object.hasOwn(body,key)))throw pageError('invalidRequest',400);
    const previous=selected.find(w=>w.id===String(body.advancedPreview?.widgetId??'').toLowerCase());
    const widget=await buildAdvancedPreviewWidget(q,target.dashboard,previous,body.advancedPreview,validateWidgetBody);
    const [result]=await queryDashboardForViewer(target.workspace,[widget],period,{defaultFilter:page.default_filter,requestFilter:filter,shellFilter,queryRunner:q},{namedAthletes:dashboardNamedAthletesAllowed(target.req,target.workspace)});
    const {local_filter_override,...previewWidget}=widget;
    previewWidget.series=widget.series.map(({galleryCalculation,source_connection_id,...entry})=>entry);
    return {widget:previewWidget,result:attachGalleryResult(widget,result),resolvedPeriod:period};
   }
   if(body.metricPreview!==undefined){
    if(!canManageDashboardRow(target.req,target.dashboard)||!dashboardManageOffered(target.req,target.workspace,target.dashboard))throw pageError();
    if(body.widgetIds!==undefined||body.referencePreview!==undefined)throw pageError('invalidRequest',400);
    const widget=await buildMetricPreviewWidget(q,target.dashboard,selected,body.metricPreview);
    const [result]=await queryDashboardForViewer(target.workspace,[widget],period,{defaultFilter:page.default_filter,requestFilter:filter,shellFilter,queryRunner:q,includeClubDistance:true},{namedAthletes:dashboardNamedAthletesAllowed(target.req,target.workspace)});
    const [galleryWidget]=await hydrateGalleryWidgets(q,[widget]);
    const {id,widget_type,group_by,title,display_config,presentation_config,series:previewSeries}=widget;
    const previewWidget={id,widget_type,group_by,title,display_config,presentation_config,series:previewSeries.map(s=>({
     id:s.id,series_order:s.series_order,display_label:s.display_label,color:s.color,axis:s.axis,
     metric_definition_id:s.metric_definition_id,built_in_series_key:s.built_in_series_key,
     data_scope_level:s.data_scope_level,analytical_aggregation:s.analytical_aggregation,resolution_status:s.resolution_status,
    }))};
    return {widget:previewWidget,result:attachGalleryResult(galleryWidget,result),resolvedPeriod:period};
   }
   const referenceRequest={...target.req,_resolvedDataWorkspacePromise:Promise.resolve(target.workspace)};
   if(body.referencePreview!==undefined){
    if(!validReferencePreview(body.referencePreview))throw pageError('invalidRequest',400);
    if(process.env.DASHBOARD_REFERENCES_ENABLED!=='true'||!canManageDashboardRow(target.req,target.dashboard))throw pageError();
    const ctx=await resolveReferenceContext(referenceRequest);
    selected=referencePreviewWidgets(selected,body.referencePreview,ctx?.owner.clubId);await assertReferenceSource(q,body.referencePreview.referenceConfig,ctx.owner.clubId,ctx.workspace,widgets.find(w=>w.id===body.referencePreview.widgetId)?.presentation_config?.referenceConfig);
   }
   const result=await queryDashboardForViewer(target.workspace,selected,period,{defaultFilter:page.default_filter,requestFilter:filter,shellFilter,queryRunner:q,includeClubDistance:body.referencePreview===undefined},{namedAthletes:dashboardNamedAthletesAllowed(target.req,target.workspace)});
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
   const target=await lockManagedPageTarget(q,req,dashboardId,{status:true});
   // Gallery receipts must be recovered through POST so Radar rechecks reference access.
   const row=(await q("select receipt,retain_until,workspace from training_load.dashboard_page_requests where initiator_user_id=$1 and request_id=$2 and dashboard_id=$3 and operation<>'createGallery'",[req.user.id,requestId,dashboardId])).rows[0];
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
   const target=await lockManagedPageTarget(q,req,dashboardId);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   const hash=createHash('sha256').update(canonicalKey({dashboardId,pageId,widgetId,operation:'copy',body})).digest('hex');
   const replay=await recordedPageRequest(q,target,req.user.id,body.requestId,hash,'copy',now);if(replay)return replay;freshRequest(body,now);
   await requirePage(q,dashboardId,pageId);await requirePage(q,dashboardId,body.destinationPageId);
   if(!(await q('select id from training_load.dashboard_widgets where id=$1 and dashboard_id=$2 and page_id=$3 for update',[widgetId,dashboardId,pageId])).rows.length)throw pageError();
   await q('select id from training_load.dashboard_widget_series where widget_id=$1 order by id for update',[widgetId]);

   const receipt=(await q('select training_load.copy_dashboard_page_widget($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) receipt',[dashboardId,req.user.id,target.workspace,body.requestId,hash,pageId,widgetId,body.expectedWidgetRevision,body.destinationPageId,body.expectedPageRevision,body.requestIssuedAt])).rows[0].receipt;
   await markDashboardManageWrite(q,target.req,target.manageScopes);
   return {receipt};
  });
 }
 async function createGallery({req,dashboardId,pageId,body}){
  if(!body||Object.keys(body).some(k=>!['expectedPageRevision','expectedDashboardRevision','requestId','requestIssuedAt','draft'].includes(k))
     ||!isUuid(body.requestId)||!validIssuedAt(body.requestIssuedAt)
     ||!Number.isSafeInteger(body.expectedPageRevision)||!Number.isSafeInteger(body.expectedDashboardRevision))throw pageError('invalidRequest',400);
  return transaction(async q=>{
   await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-page:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
   if(body.draft?.kind==='radar')await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-reference:${req.user.id.toLowerCase()}:${body.requestId.toLowerCase()}`]);
   const target=await lockManagedPageTarget(q,req,dashboardId);
   // Management ownership does not authorize the selected data workspace.
   // Verify the locked dashboard before looking up even an existing receipt.
   if(!dataWorkspaceMatches(target.workspace,target.dashboard))throw pageError();
   let referenceContext;
   if(body.draft?.kind==='radar'){
    if(process.env.DASHBOARD_REFERENCES_ENABLED!=='true'||!dashboardNamedAthletesAllowed(target.req,target.workspace))throw pageError();
    referenceContext=await resolveReferenceContext({...target.req,_resolvedDataWorkspacePromise:Promise.resolve(target.workspace)});
    if(!referenceContext||referenceContext.readOnly||!await adminWriteKit.rightsStillHold({query:q},referenceContext))throw pageError();
   }
   const operation='createGallery';
   const hash=createHash('sha256').update(canonicalKey({dashboardId,pageId,operation,body})).digest('hex');
   const replay=await recordedPageRequest(q,target,req.user.id,body.requestId,hash,operation,now);
   if(replay)return replay.receipt;
   freshRequest(body,now);
   await q('select id from training_load.dashboard_pages where dashboard_id=$1 order by id for update',[dashboardId]);
   const page=await requirePage(q,dashboardId,pageId);
   if(page.revision!==body.expectedPageRevision||target.dashboard.revision!==body.expectedDashboardRevision)throw pageError('staleRevision',409);
   const draft=await buildGalleryDraft(q,target,body.draft,{referenceContext});
   const reference=draft.presentation_config.referenceConfig;
   const layout=(await q('select coalesce(max(y+height),0) as y, coalesce(max(greatest(widget_order,mobile_order)),0)+1 as position from training_load.dashboard_widgets where page_id=$1',[pageId])).rows[0];
   const write=async (operation,id,payload,revision=null)=>(await q('select training_load.write_dashboard_page_widget($1,$2,$3,$4,$5,$6,$7,$8) result',[dashboardId,pageId,revision,operation,id,null,req.user.id,payload])).rows[0].result;
   const {widgetId}=await write('create',null,{widgetType:draft.widget_type,title:draft.title,groupBy:draft.group_by,widgetOrder:layout.position,mobileOrder:layout.position,x:0,y:layout.y,width:6,height:5},page.revision);
   const ids=new Map();
   let revision=1;
   for(const entry of draft.series){
    const added=await write('addSeries',widgetId,{expectedWidgetRevision:revision,seriesOrder:entry.series_order,
     ...(entry.built_in_series_key?{builtInSeriesKey:entry.built_in_series_key}:{metricDefinitionId:entry.metric_definition_id}),
     axis:entry.axis,dataScopeLevel:entry.data_scope_level,analyticalAggregation:entry.analytical_aggregation,aggregationRolePolicy:entry.aggregation_role_policy});
    revision=added.widgetRevision;
    ids.set(entry.id,added.seriesId);
   }
   const presentation=bindGallerySeries(draft.presentation_config,ids);
   if(reference){
    const referenceHash=adminWriteKit.hashOf({dashboardId,pageId,widgetId,draft:body.draft});
    await q('select training_load.save_dashboard_reference_binding($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
     [req.user.id,reference.clubId,referenceContext.teamId??null,body.requestId,referenceHash,dashboardId,widgetId,revision,draft.group_by,presentation.referenceConfig]);
   }else{
    await write('content',widgetId,{expectedWidgetRevision:revision,presentation:{mode:'replace',value:presentation}});
   }
   await markDashboardManageWrite(q,target.req,target.manageScopes);
   const receipt={widgetId};
   await q(`insert into training_load.dashboard_page_requests
      (initiator_user_id,request_id,dashboard_id,workspace,operation,payload_hash,receipt,request_issued_at,retain_until)
      values($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz+interval '168 hours 10 minutes')`,
    [req.user.id,body.requestId,dashboardId,target.workspace,operation,hash,receipt,body.requestIssuedAt]);
   return receipt;
  });
 }
 async function writeWidget({req,dashboardId,pageId,widgetId=null,seriesId=null,operation,body}){
  return transaction(async q=>{
   const target=await lockManagedPageTarget(q,req,dashboardId);
   if(!validateWidgetBody(operation,body,{req:target.req,workspace:target.workspace,mode:req.app?.locals?.dashboardSimpleMode}))throw pageError('invalidRequest',400);
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
   if(body.sourceConnectionId){const {visible,conn}=await isSourceConnectionVisibleToDashboard(target.dashboard,body.sourceConnectionId,q);if(!visible||!conn||conn.state!=='active')throw pageError();await q('select id from training_load.metric_source_connections where id=$1 for share',[body.sourceConnectionId]);}
   if(body.widgetType){const type=(await q('select key from training_load.dashboard_widget_types where key=$1 and is_active for share',[body.widgetType])).rows[0];if(!type)throw pageError('invalidRequest',400);}
   if(body.builtInSeriesKey)await q('select key from training_load.dashboard_builtin_series where key=$1 for share',[body.builtInSeriesKey]);
   const result=(await q('select training_load.write_dashboard_page_widget($1,$2,$3,$4,$5,$6,$7,$8) result',[dashboardId,pageId,body.expectedPageRevision??null,operation,widgetId,seriesId,req.user.id,normalized])).rows[0].result;
   await markDashboardManageWrite(q,target.req,target.manageScopes);
   return result;
  });
 }
 return {read,detail,queryPage,mutate,status,copy,createGallery,writeWidget};
}
