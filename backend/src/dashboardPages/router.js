import { validPageWidgetBody } from './widgetValidation.js';
import { validateContract } from '../dashboardSimple/schema.js';
import {Router} from 'express';
import {createPageService} from './service.js';
import {isUuid} from '../dashboardSimple/schema.js';
import {validFilterShape} from '../trainingLoadDashboardCatalog.js';

// Created/mounted only when the server-owned feature setting is true.
export const PAGE_ROUTE_MATRIX=Object.freeze([
 ['put','/:dashboardId/pages/:pageId/layout'],
 ['post','/:dashboardId/pages/:pageId/widgets'],
 ['patch','/:dashboardId/pages/:pageId/widgets/:widgetId'],
 ['patch','/:dashboardId/pages/:pageId/widgets/:widgetId/layout'],
 ['delete','/:dashboardId/pages/:pageId/widgets/:widgetId'],
 ['post','/:dashboardId/pages/:pageId/widgets/:widgetId/series'],
 ['patch','/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId'],
 ['delete','/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId'],
 ['put','/:dashboardId/pages/:pageId/widgets/:widgetId/series/reorder'],
 ['post','/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId/resolve'],
 ['get','/:dashboardId/pages/requests/:requestId'],['get','/:dashboardId/pages'],['get','/:dashboardId/pages/:pageId'],
 ['post','/:dashboardId/pages'],['post','/:dashboardId/pages/reorder'],['post','/:dashboardId/pages/:pageId/copy'],
 ['post','/:dashboardId/pages/:pageId/query'],['post','/:dashboardId/pages/:pageId/widgets/:widgetId/copy'],['patch','/:dashboardId/pages/:pageId'],['delete','/:dashboardId/pages/:pageId']
]);
function validInput(op,input){
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const keys={create:['name','period','defaultFilter'],copyPage:['name','sourceRevision','widgetRevisions'],rename:['name'],reorder:['pageIds'],delete:[],defaults:['defaultFilter','period','expectedDefaultsRevision']}[op];
 if(!keys||Object.keys(input).some(k=>!keys.includes(k)))return false;
 if(['create','rename','copyPage'].includes(op)&&!(typeof input.name==='string'&&[...input.name].length>=1&&[...input.name].length<=80&&input.name===input.name.trim()&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.name)))return false;
 if(op==='copyPage'){
  const revision=value=>Number.isSafeInteger(value)&&value>0;
  const widgets=input.widgetRevisions;
  if(!revision(input.sourceRevision)||!widgets||typeof widgets!=='object'||Array.isArray(widgets)
   ||Object.entries(widgets).length>200||!Object.entries(widgets).every(([id,value])=>isUuid(id)&&revision(value)))return false;
 }
 if(op==='reorder'&&!(Array.isArray(input.pageIds)&&input.pageIds.length>=1&&input.pageIds.length<=20&&input.pageIds.every(isUuid)&&new Set(input.pageIds.map(s=>s.toLowerCase())).size===input.pageIds.length))return false;
 if(Object.hasOwn(input,'defaultFilter')&&input.defaultFilter!==null&&!validFilterShape(input.defaultFilter))return false;
 if(Object.hasOwn(input,'period')&&input.period!==null&&!validateContract('periodConfig',input.period).valid)return false;
 if(op==='defaults'&&(!Number.isSafeInteger(input.expectedDefaultsRevision)||input.expectedDefaultsRevision<1))return false;
 return true;
}
export function createPagesRouter({pool}){
 const router=Router(),service=createPageService({pool,validateWidgetBody:validPageWidgetBody});
 const handle=(operation)=>async(req,res,next)=>{try{
  if(!isUuid(req.params.dashboardId)||req.params.pageId&&!isUuid(req.params.pageId))return res.status(400).json({error:'invalidRequest'});
  const args={req,dashboardId:req.params.dashboardId,pageId:req.params.pageId??null};
  if(operation.startsWith('widget:'))return res.json(await service.writeWidget({...args,widgetId:req.params.widgetId??null,seriesId:req.params.seriesId??null,operation:operation.slice(7),body:req.body}));
  if(operation==='status')return res.json(await service.status({...args,requestId:req.params.requestId}));
  if(operation==='read')return res.json(await (args.pageId?service.detail(args):service.read(args)));
  if(operation==='copy'){
   const b=req.body;
   if(!b||Object.keys(b).some(k=>!['requestId','requestIssuedAt','destinationPageId','expectedWidgetRevision','expectedPageRevision'].includes(k)))return res.status(400).json({error:'invalidRequest'});
   return res.json(await service.copy({...args,widgetId:req.params.widgetId,body:b}));
  }
  if(operation==='query'){
   const b=req.body;
   if(!b||Object.keys(b).some(k=>!['dateFrom','dateTo','timeZone','athleteIds','activityId','componentId','shellFilter','widgetIds','referencePreview'].includes(k))||b.widgetIds&&!(Array.isArray(b.widgetIds)&&b.widgetIds.length<=200&&b.widgetIds.every(isUuid)))return res.status(400).json({error:'invalidRequest'});
   return res.json(await service.queryPage({...args,body:b}));
  }
  const body=req.body;
  if(!body||Object.keys(body).some(k=>!['requestId','requestIssuedAt','expectedPagesRevision','input','operation'].includes(k)))return res.status(400).json({error:'invalidRequest'});
  const op=operation==='edit'?body.operation:operation;
  if(operation==='edit'&&!['rename','defaults'].includes(op)||!validInput(op,body.input))return res.status(400).json({error:'invalidRequest'});
  res.json(await service.mutate({...args,operation:op,body}));
 }catch(e){
  if(operation==='copyPage'&&e.code==='S2C02')return res.status(409).json({error:'pageCopyConfigurationUnavailable'});
  const codes={P0002:[404,'notFound'],'40001':[409,'staleRevision'],'40002':[409,'dashboardArchived'],S2C01:[409,'idempotencyConflict'],S2C06:[409,'requestExpired'],'23505':[409,'conflict'],'23514':[409,'pageUnavailable'],'22023':[400,'invalidRequest'],P0001:[400,'invalidRequest'],'22P02':[400,'invalidRequest'],'23503':[404,'notFound']};
  if(e.code==='23514'&&['pageNotEmpty','homePageRequired','pageLimit'].includes(e.message))return res.status(409).json({error:e.message});
  const mapped=codes[e.code];if(mapped)return res.status(mapped[0]).json({error:mapped[1]});
  if(e.httpStatus)return res.status(e.httpStatus).json({error:e.code});next(e);
 }};
 router.get('/:dashboardId/pages/requests/:requestId',handle('status'));
 router.get('/:dashboardId/pages',handle('read'));router.get('/:dashboardId/pages/:pageId',handle('read'));
 router.post('/:dashboardId/pages/:pageId/query',handle('query'));
 router.post('/:dashboardId/pages/:pageId/widgets/:widgetId/copy',handle('copy'));
 router.post('/:dashboardId/pages/:pageId/copy',handle('copyPage'));
 router.post('/:dashboardId/pages',handle('create'));router.post('/:dashboardId/pages/reorder',handle('reorder'));
 router.patch('/:dashboardId/pages/:pageId',handle('edit'));router.delete('/:dashboardId/pages/:pageId',handle('delete'));
 router.put('/:dashboardId/pages/:pageId/layout',handle('widget:layout'));
 router.post('/:dashboardId/pages/:pageId/widgets',handle('widget:create'));
 router.patch('/:dashboardId/pages/:pageId/widgets/:widgetId',handle('widget:content'));
 router.patch('/:dashboardId/pages/:pageId/widgets/:widgetId/layout',handle('widget:widgetLayout'));
 router.delete('/:dashboardId/pages/:pageId/widgets/:widgetId',handle('widget:delete'));
 router.post('/:dashboardId/pages/:pageId/widgets/:widgetId/series',handle('widget:addSeries'));
 router.patch('/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId',handle('widget:updateSeries'));
 router.delete('/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId',handle('widget:deleteSeries'));
 router.put('/:dashboardId/pages/:pageId/widgets/:widgetId/series/reorder',handle('widget:reorderSeries'));
 router.post('/:dashboardId/pages/:pageId/widgets/:widgetId/series/:seriesId/resolve',handle('widget:resolveSeries'));
 return router;
}
