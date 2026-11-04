import { Router,json } from 'express';
const sqlErrors={P4P01:['pagesClientRequired',409],P4P02:['stalePageRevision',409],P4P08:['idempotencyConflict',409],P4P09:['invalidRequest',400],P4P10:['notFound',404],P4A01:['stalePageLayoutRevision',409],'40001':['staleRevision',409],'40002':['dashboardArchived',409],'23505':['conflict',409],'23514':['invalidRequest',400],'23503':['invalidRequest',400],P0001:['invalidRequest',400],S2C02:['invalidRequest',400],S2C03:['advancedRequired',409],S2C05:['invalidRequest',400],S2C07:['notFound',404]};
const allowed=new Set(['notFound','invalidRequest','dashboardArchived','templateRequiresClone','workspaceSelectionRequired','idempotencyConflict','outcomeUnknown','pagesUnavailable','saveFailed','saveBusy','saveTimeout','requestInProgress','previewBusy','previewTimeout','previewCleanupFailed','previewReadOnlyViolation']);
export function createPageAdvancedRouter({service}){
  const router=Router({mergeParams:true});
  router.use((req,res,next)=>req.user?.id?next():res.status(401).json({error:'unauthorized'}));
  router.use(json({limit:65536,strict:true}));
  const handler=(operation)=>async(req,res)=>{
    try{const result=await service[operation==='status'?'status':'mutate']({req,dashboardId:req.params.dashboardId,pageId:req.params.pageId,widgetId:req.params.widgetId??null,seriesId:req.params.seriesId??null,requestId:req.params.requestId,operation,body:req.body});res.status(['widgetCreate','seriesAdd'].includes(operation)?201:200).json(result);}
    catch(error){const mapped=sqlErrors[error?.code],code=mapped?.[0]??(allowed.has(error?.code)?error.code:'pagesUnavailable');res.status(mapped?.[1]??(code==='pagesUnavailable'?503:error.status??503)).json({error:code,...(code==='outcomeUnknown'?{requestId:req.body?.requestId}:{})});}
  };
  for(const[method,path,op]of[['get','/requests/:requestId','status'],['put','/layout','layout'],['post','/widgets','widgetCreate'],['patch','/widgets/:widgetId/layout','widgetLayout'],['patch','/widgets/:widgetId','widgetContent'],['delete','/widgets/:widgetId','widgetDelete'],['post','/widgets/:widgetId/series','seriesAdd'],['put','/widgets/:widgetId/series/reorder','seriesReorder'],['patch','/widgets/:widgetId/series/:seriesId','seriesUpdate'],['delete','/widgets/:widgetId/series/:seriesId','seriesDelete'],['post','/widgets/:widgetId/series/:seriesId/resolve','seriesResolve']])router[method](path,handler(op));
  router.use((error,req,res,next)=>res.status(error?.type==='entity.too.large'?413:400).json({error:error?.type==='entity.too.large'?'payloadTooLarge':'invalidRequest'}));
  return router;
}
