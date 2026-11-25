import {assertReferenceSource} from './preview.js';
import {pageDatabaseEnabled} from '../dashboardPages/config.js';
import { getVariable } from "../canonicalVariableAdminService.js";
import { Router } from 'express';
import { adminWriteKit } from '../sourceMetricMappingService.js';
import { resolveReferenceContext } from './access.js';
import { referenceUuid, validReferenceConfig } from './contract.js';
import { canManageDashboardRow,dataWorkspaceForActiveWorkspace,dataWorkspaceMatches } from '../trainingLoadDashboardAccess.js';
const { boundedRead, rightsStillHold, hashOf } = adminWriteKit;
const missing=res=>res.status(404).json({error:'notFound'});
const deny=()=>Object.assign(new Error('notFound'),{code:'42501'});
export function createReferenceBindingRouter(){
 const router=Router();
 router.use(async(req,res,next)=>{res.set('Cache-Control','no-store');try{if(process.env.DASHBOARD_REFERENCES_ENABLED!=='true')return missing(res);const ctx=await resolveReferenceContext(req);if(!ctx)return missing(res);req.referenceContext=ctx;next();}catch(error){next(error)}});
 const handler=write=>async(req,res,next)=>{try{
  if(!referenceUuid(req.params.dashboardId)||!referenceUuid(req.params.widgetId))return missing(res);
  const b=req.body,ctx=req.referenceContext;
  if(write&&(!b||Object.keys(b).some(key=>!['requestId','expectedWidgetRevision','groupBy','referenceConfig'].includes(key))||!referenceUuid(b.requestId)||!Number.isSafeInteger(b.expectedWidgetRevision)||b.expectedWidgetRevision<1||!['athlete','cohort'].includes(b.groupBy)||!Object.hasOwn(b,'referenceConfig')||b.referenceConfig!==null&&!validReferenceConfig(b.referenceConfig)))return res.status(400).json({error:'invalidRequest'});
  const result=await boundedRead(async client=>{
   const d=(await client.query('select * from training_load.dashboards where id=$1',[req.params.dashboardId])).rows[0];
   const workspace=dataWorkspaceForActiveWorkspace(ctx.workspace,req);
   if(!d||!canManageDashboardRow(req,d)||!dataWorkspaceMatches(workspace,d))throw deny();
   const widget=(await client.query('select * from training_load.dashboard_widgets where id=$1 and dashboard_id=$2',[req.params.widgetId,d.id])).rows[0];if(!widget)throw deny();
   const page=(await client.query('select is_home from training_load.dashboard_pages where id=$1 and dashboard_id=$2',[widget.page_id,d.id])).rows[0];
   if(!page||!page.is_home&&(req.app?.locals?.dashboardPagesEnabled!==true||!await pageDatabaseEnabled(client.query.bind(client))))throw deny();
   if(!write){const series=(await client.query('select s.id,s.metric_definition_id,s.analytical_aggregation,s.data_scope_level,s.resolution_status,d.label,v.unit from training_load.dashboard_widget_series s left join training_load.metric_definitions d on d.id=s.metric_definition_id left join training_load.metric_definition_versions v on v.id=d.current_version_id where s.widget_id=$1 order by s.series_order,s.id',[widget.id])).rows;return{widget:{id:widget.id,title:widget.title,widgetType:widget.widget_type,displayConfig:widget.display_config,revision:widget.revision,groupBy:widget.group_by,referenceConfig:widget.presentation_config?.referenceConfig??null},series};}
   if(b.referenceConfig)await assertReferenceSource(client.query.bind(client),b.referenceConfig,ctx.owner.clubId,ctx.workspace,widget.presentation_config?.referenceConfig);
   if(!await rightsStillHold(client,ctx))throw deny();
   const hash=hashOf({contract:'dashboard-reference-binding/v1',dashboardId:d.id,widgetId:widget.id,body:b});
   return(await client.query('select training_load.save_dashboard_reference_binding($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) receipt',[ctx.userId,ctx.owner.clubId,ctx.teamId??null,b.requestId,hash,d.id,widget.id,b.expectedWidgetRevision,b.groupBy,b.referenceConfig])).rows[0].receipt;
  },{locks:write});
  if(!write){
   for(const series of result.series){
    const current=series.metric_definition_id?await getVariable({ctx:req.referenceContext,variableId:series.metric_definition_id,query:{}}):null;
    if(current?.variable?.state==='active')series.label=current.variable.label;
    else {series.label='Metric unavailable';series.metric_definition_id=null;series.unit=null;}
   }
  }
  return res.json(result);
 }catch(error){
  if(error.code==='42501'||error.httpStatus===404)return missing(res);
  if(error.message==='staleRevision')return res.status(409).json({error:'staleRevision',message:'This widget changed. Reopen its reference settings.'});
  if(['S2C02','23514','23503','23505','22P02'].includes(error.code))return res.status(409).json({error:'referenceNotAvailable',message:'These references do not match the widget. Choose matching values.'});
  return next(error);
 }};
 router.get('/:dashboardId/widgets/:widgetId',handler(false));
 router.put('/:dashboardId/widgets/:widgetId',handler(true));
 return router;
}
