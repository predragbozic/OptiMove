import {api} from './api.js';
import {state} from './state.js';
import {currentUserWorkspaceContextParts} from './access.js';
import {resetAnalysisDashboardQuery,queryAnalysisDashboard} from './training-load-analysis-data.js';
let generation=0;
const a=()=>state.trainingLoad.analysis;
const key=dashboardId=>JSON.stringify([...currentUserWorkspaceContextParts(),dashboardId]);
const selections=new Map();
const personalPeriods=new Map();
function selected(dashboardId){const k=key(dashboardId);try{return localStorage.getItem('optimove-dashboard-page:'+k)||selections.get(k)}catch{return selections.get(k)}}
function remember(dashboardId,id){const k=key(dashboardId);selections.set(k,id);try{localStorage.setItem('optimove-dashboard-page:'+k,id)}catch{/* browser storage can be unavailable */}}
export function pageApiPath(dashboardId,pageId=null){return `/api/training-load/dashboards/${encodeURIComponent(dashboardId)}/pages${pageId?'/'+encodeURIComponent(pageId):''}`}
export async function loadDashboardPages(render,{pageId=null}={}){
 const model=a();if(!model.pagesAvailable)return;
 const dashboardId=model.selectedDashboardId,context=key(dashboardId),ticket=++generation;
 if(model.pageContextKey!==context){Object.assign(model,{pageContextKey:context,page:null,pages:[],pageForm:null,pagePending:null,pageRequestIssuedAt:null,pageError:'',pageSaving:false,selectedPageId:null})}
 if(model.page?.dashboard_id===dashboardId){
  const periodKey=context+':'+model.page.id;
  if(!model.pageResolvedPeriod||JSON.stringify(model.period)!==JSON.stringify(model.pageResolvedPeriod))personalPeriods.set(periodKey,{config:JSON.stringify(model.page.period_config),period:structuredClone(model.period)});
  else personalPeriods.delete(periodKey);
 }
 model.pageLoading=true;render?.();
 try{
  const list=await api(pageApiPath(dashboardId));
  if(ticket!==generation||key(a().selectedDashboardId)!==context)return;
  const choice=list.pages.find(p=>p.id===(pageId||selected(dashboardId)))||list.pages.find(p=>p.is_home);
  if(!choice)throw Error('missingPage');
  const detail=await api(pageApiPath(dashboardId,choice.id));
  if(ticket!==generation||key(a().selectedDashboardId)!==context)return;
  const personal=personalPeriods.get(context+':'+choice.id);
  if(personal&&personal.config===JSON.stringify(detail.page.period_config))model.period=personal.period;
  else if(detail.resolvedPeriod)model.period=detail.resolvedPeriod;
  model.pageResolvedPeriod=detail.resolvedPeriod??null;
  resetAnalysisDashboardQuery();Object.assign(model,{pageRequestIssuedAt:detail.requestIssuedAt,pages:detail.pages,page:detail.page,pagesRevision:detail.pagesRevision,pageCanManage:detail.canManage,selectedPageId:choice.id,widgets:detail.widgets,dashboard:detail.dashboard,pageLoading:false,pageError:'',editMode:false,layoutDraft:null});
  remember(dashboardId,choice.id);render?.();
 }catch{if(ticket===generation&&key(a().selectedDashboardId)===context){model.pageLoading=false;model.pageError='Pages could not be loaded. Reload the dashboard.';model.widgets=[];resetAnalysisDashboardQuery();render?.()}}
}
export async function selectDashboardPage(id,render){
 if(id===a().selectedPageId)return;
 resetAnalysisDashboardQuery();a().widgets=[];a().selectedPageId=id;
 await loadDashboardPages(render,{pageId:id});await queryAnalysisDashboard(render,{force:true});
}
export async function mutateDashboardPage(operation,input,pageId,render){
 const model=a(),dashboardId=model.selectedDashboardId,context=key(dashboardId);
 if(model.pageSaving)return;
 if(!model.pagePending&&!model.pageRequestIssuedAt){model.pageError='Reload the dashboard before making this change.';render?.();return;}
 const body=model.pagePending?.body??{requestId:crypto.randomUUID(),requestIssuedAt:model.pageRequestIssuedAt,expectedPagesRevision:model.pagesRevision,input,...(['rename','defaults'].includes(operation)?{operation}:{})};
 const path=pageApiPath(dashboardId,pageId)+(operation==='reorder'?'/reorder':'');
 const method=operation==='delete'?'DELETE':['rename','defaults'].includes(operation)?'PATCH':'POST';
 model.pagePending={body,operation,pageId,path,method};model.pageSaving=true;model.pageError='';render?.();
 try{
  const response=await api(path,{method,body:JSON.stringify(body)});
  if(key(a().selectedDashboardId)!==context)return;
  model.pagePending=null;model.pageSaving=false;model.pageForm=null;
  await loadDashboardPages(render,{pageId:operation==='create'?response.receipt.pageId:operation==='delete'?null:model.selectedPageId});
  await queryAnalysisDashboard(render,{force:true});
 }catch(error){
  if(key(a().selectedDashboardId)!==context)return;
  model.pageSaving=false;
  if(error.status>=400&&error.status<500){model.pagePending=null;model.pageError=error.message==='conflict'?'A page with that name already exists. Choose a different name.':error.message==='pageNotEmpty'?'This page still has widgets. Remove them before deleting the page.':error.message==='pageLimit'?'This dashboard has 20 pages. Delete an empty page before adding another.':error.status===409?'This page changed or cannot be updated. Reload it before trying again.':'This page could not be updated. Check your choices and try again.'}
  else model.pageError='The update is not confirmed. Check it before making another change.';
  render?.();
 }
}
export async function copyDashboardPageWidget(widgetId,destinationPageId,render){
 const model=a(),source=model.widgets.find(w=>w.id===widgetId),destination=model.pages.find(p=>p.id===destinationPageId);
 if(model.pageSaving||!source||!destination)return;
 if(!model.pagePending&&!model.pageRequestIssuedAt){model.pageError='Reload the dashboard before making this change.';render?.();return;}
 const context=key(model.selectedDashboardId);
 const body=model.pagePending?.body??{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId,expectedWidgetRevision:source.revision,expectedPageRevision:destination.revision};
 const path=pageApiPath(model.selectedDashboardId,model.selectedPageId)+'/widgets/'+encodeURIComponent(widgetId)+'/copy';
 model.pagePending={kind:'copy',body,widgetId,destinationPageId,path,method:'POST'};model.pageSaving=true;model.pageError='';render();
 try{
  await api(path,{method:'POST',body:JSON.stringify(body)});if(key(a().selectedDashboardId)!==context)return;
  model.pagePending=null;model.pageSaving=false;model.pageForm=null;await loadDashboardPages(render);await queryAnalysisDashboard(render,{force:true});model.notice='Widget copied to '+destination.name+'.';render();
 }catch(error){if(key(a().selectedDashboardId)!==context)return;model.pageSaving=false;
  if(error.status>=400&&error.status<500){model.pagePending=null;model.pageError='This widget could not be copied. Reload the dashboard and try again.'}
  else model.pageError='The copy is not confirmed. Check it before trying again.';render();
 }
}
export async function handleDashboardPageAction(action,render){
 const type=action.dataset.action;if(!type?.startsWith('training-load-pages-'))return false;
 const model=a();if(!model.pagesAvailable)return true;
 if(type==='training-load-pages-select')await selectDashboardPage(action.dataset.pageId,render);
 else if(type==='training-load-pages-reload'){await loadDashboardPages(render);await queryAnalysisDashboard(render,{force:true})}
 else if(type==='training-load-pages-check'){
  const pending=model.pagePending;if(!pending)return true;
  model.pageSaving=true;render();
  try{
   const response=await api(pageApiPath(model.selectedDashboardId)+'/requests/'+encodeURIComponent(pending.body.requestId));
   if(response.status==='recorded'){model.pagePending=null;model.pageForm=null;model.pageSaving=false;await loadDashboardPages(render);await queryAnalysisDashboard(render,{force:true})}
   else {model.pageSaving=false;if(pending.kind==='copy')await copyDashboardPageWidget(pending.widgetId,pending.destinationPageId,render);else await mutateDashboardPage(pending.operation,pending.body.input,pending.pageId,render)}
  }catch{model.pageSaving=false;model.pageError='The update is still not confirmed. Check again before making another change.';render()}
 }
 else if(type==='training-load-pages-open-copy'){const widget=model.widgets.find(w=>w.id===action.dataset.widgetId);if(widget){model.pageForm={operation:'copy',widgetId:widget.id,name:widget.title,destinationPageId:model.pages.find(p=>p.id!==model.selectedPageId)?.id??model.selectedPageId};model.menu='';render()}}
 else if(type==='training-load-pages-destination')model.pageForm.destinationPageId=action.value;
 else if(type==='training-load-pages-create'){model.pageForm={operation:'create',name:'',preset:'last_28_days'};render()}
 else if(type==='training-load-pages-defaults'){model.pageForm={operation:'defaults',name:model.page.name,preset:model.page.period_config?.mode==='relative'?model.page.period_config.preset:'unchanged'};render()}
 else if(type==='training-load-pages-rename'){model.pageForm={operation:'rename',name:model.page.name};render()}
 else if(type==='training-load-pages-delete'){model.pageForm={operation:'delete',name:model.page.name};render()}
 else if(type==='training-load-pages-name')model.pageForm.name=action.value;
 else if(type==='training-load-pages-preset')model.pageForm.preset=action.value;
 else if(type==='training-load-pages-cancel'){model.pageForm=null;render()}
 else if(type==='training-load-pages-save'){
  const f=model.pageForm;if(['create','rename'].includes(f.operation)&&!f.name.trim()){model.pageError='Choose a page name before saving.';render();return true;}if(f.operation==='copy'){await copyDashboardPageWidget(f.widgetId,f.destinationPageId,render);return true;}
  const input=f.operation==='delete'?{}:f.operation==='defaults'?{expectedDefaultsRevision:model.page.defaults_revision,defaultFilter:model.page.default_filter,period:f.preset==='unchanged'?model.page.period_config:f.preset==='dashboard'?null:{schemaVersion:1,mode:'relative',preset:f.preset,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}}:{name:f.name};
  if(f.operation==='create')input.period={schemaVersion:1,mode:'relative',preset:f.preset,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  await mutateDashboardPage(f.operation,input,f.operation==='create'?null:model.selectedPageId,render);
 }else if(type==='training-load-pages-up'||type==='training-load-pages-down'){
  const pages=model.pages.slice().sort((x,y)=>x.position-y.position);const i=pages.findIndex(p=>p.id===model.selectedPageId),j=i+(type.endsWith('-up')?-1:1);
  if(i>0&&j>0&&j<pages.length){[pages[i],pages[j]]=[pages[j],pages[i]];await mutateDashboardPage('reorder',{pageIds:pages.map(p=>p.id)},null,render)}
 }
 return true;
}
