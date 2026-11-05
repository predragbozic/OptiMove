import { api } from './api.js';
import { state } from './state.js';
import { currentUserWorkspaceContextParts } from './access.js';

const copy=v=>structuredClone(v);
const identity=()=>JSON.stringify(currentUserWorkspaceContextParts());
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const root=id=>`/api/training-load/dashboards/${encodeURIComponent(id)}`;
const pendingIsCurrent=(a,p)=>state.trainingLoad.analysis===a && identity()===p.identity && a.selectedDashboardId===p.dashboardId && a.selectedPageId===p.pageId;
let readGeneration=0;
export const pageContextIdentity=()=>JSON.stringify([identity(),state.trainingLoad.analysis.selectedDashboardId,state.trainingLoad.analysis.selectedPageId]);
export const pageWriteIsPending=()=>Boolean(state.trainingLoad.analysis.pageWritePending);

export function rememberPageRuntime(a=state.trainingLoad.analysis){
  if(a.pagesMode && a.selectedPageId)a.pageRuntime[a.selectedPageId]=copy({period:a.period,runtimeFilter:a.runtimeFilter,selectedActivity:a.selectedActivity,componentOptions:a.componentOptions,usesDefaults:a.pageRuntimeUsesDefaults});
}
function restoreRuntime(a,page){
  const saved=a.pageRuntime[page.id];
  if(saved){a.period=copy(saved.period);a.runtimeFilter=copy(saved.runtimeFilter);a.selectedActivity=copy(saved.selectedActivity);a.componentOptions=copy(saved.componentOptions);a.pageRuntimeUsesDefaults=saved.usesDefaults;return;}
  const configured=Boolean(page.periodConfig);
  a.period=page.periodConfig?.mode==='fixed'?{dateFrom:page.periodConfig.dateFrom,dateTo:page.periodConfig.dateTo,timeZone:page.periodConfig.timeZone}:configured?{dateFrom:'',dateTo:'',timeZone:page.periodConfig.timeZone}:{...a.period,timeZone:a.period.timeZone||zone()};
  a.runtimeFilter={};a.selectedActivity=null;a.componentOptions=[];a.pageRuntimeUsesDefaults=configured;
}
export function clearPagesState(a=state.trainingLoad.analysis){
  readGeneration++;a.pagesMode=false;a.pages=[];a.page=null;a.selectedPageId='';a.pagesDashboardId='';a.pagesRevision=null;a.pageRuntime={};a.pageCapabilities={};a.pageForm=null;
}

export async function loadPagesDashboard(dashboardId,onPainted,{preferredPageId,force=false}={}){
  const a=state.trainingLoad.analysis,who=identity(),run=++readGeneration;
  if(a.pagesDashboardId!==dashboardId){a.pagesMode=false;a.pages=[];a.page=null;a.selectedPageId='';a.pageRuntime={};a.pagesDashboardId=dashboardId;}
  const current=()=>state.trainingLoad.analysis===a && identity()===who && a.selectedDashboardId===dashboardId && run===readGeneration;
  a.detailLoading=true;a.detailError='';onPainted?.();
  try{
    const list=await api(root(dashboardId)+'/pages');
    if(!current())return true;
    if(list.capabilities?.pages!==true || !list.dashboard || !list.pages?.length){clearPagesState(a);return false;}
    rememberPageRuntime(a);
    a.pagesMode=true;a.dashboard=list.dashboard;a.pages=list.pages;a.pagesRevision=list.pagesRevision;a.pageCapabilities=list.capabilities;
    const next=list.pages.find(p=>p.id===(preferredPageId||a.selectedPageId))||list.pages[0];
    const changed=a.selectedPageId!==next.id;a.selectedPageId=next.id;a.page=next;
    if(changed){restoreRuntime(a,next);if(a.pageHandoff){Object.assign(a,copy(a.pageHandoff));a.pageHandoff=null;}a.widgets=[];a.queryResult=null;a.editMode=false;a.layoutDraft=null;}
    const detail=await api(root(dashboardId)+'/pages/'+encodeURIComponent(next.id));
    if(!current() || a.selectedPageId!==next.id)return true;
    a.page=detail.page;a.widgets=detail.widgets||[];a.pages=a.pages.map(p=>p.id===next.id?detail.page:p);a.layoutDraft=null;a.detailLoading=false;a.detailError='';
    onPainted?.();return true;
  }catch(error){
    if(!current())return true;
    a.detailLoading=false;
    if(['pagesUnavailable','notFound'].includes(error.data?.error) && !a.pagesMode){clearPagesState(a);return false;}
    a.widgets=[];a.queryResult=null;a.detailError=error.status===404?'Stranica više nije dostupna. Osvežite dashboard.':'Stranice trenutno ne mogu da se učitaju. Pokušajte ponovo.';onPainted?.();return true;
  }
}

export async function selectPageData(pageId,onPainted){
  const a=state.trainingLoad.analysis;
  if(!a.pagesMode || pageId===a.selectedPageId || !a.pages.some(p=>p.id===pageId) || a.pageWritePending)return false;
  rememberPageRuntime(a);
  await loadPagesDashboard(a.selectedDashboardId,onPainted,{preferredPageId:pageId,force:true});return true;
}

function unknownError(){return Object.assign(new Error('Ishod čuvanja nije potvrđen. Proverite ishod ili ponovite isti zahtev.'),{pageOutcomeUnknown:true,data:{error:'outcomeUnknown'}});}
async function sendPending(a,pending){
  const receipt=await api(pending.url,{method:pending.method,body:pending.body});
  if(a.pageWritePending===pending)a.pageWritePending=null;
  return receipt;
}
async function startWrite(a,{url,method,body,kind,statusUrl}){
  if(a.pageWritePending)throw unknownError();
  const requestId=crypto.randomUUID();
  const pending={url,method,body:JSON.stringify({...body,contractVersion:1,requestId}),requestId,kind,statusUrl:statusUrl(requestId),dashboardId:a.selectedDashboardId,pageId:a.selectedPageId,identity:identity(),status:'sending'};
  a.pageWritePending=pending;
  try{return await sendPending(a,pending);}
  catch(error){
    const definite=error.status>=400&&error.status<500&&!['requestInProgress'].includes(error.data?.error);
    if(definite){if(a.pageWritePending===pending)a.pageWritePending=null;throw error;}
    pending.status='unknown';throw unknownError();
  }
}
export async function mutatePage(operation,fields){
  const a=state.trainingLoad.analysis,p=a.page,base=root(a.selectedDashboardId)+'/pages';
  const paths={create:['POST',base],rename:['PATCH',base+'/'+p?.id],defaults:['PATCH',base+'/'+p?.id+'/defaults'],duplicate:['POST',base+'/'+p?.id+'/duplicate'],delete:['DELETE',base+'/'+p?.id],reorder:['PUT',base+'/order']};
  const[method,url]=paths[operation];
  return startWrite(a,{url,method,body:fields,kind:'pages',statusUrl:id=>base+'/requests/'+id});
}
export async function resolvePageWrite({retry=false}={}){
  const a=state.trainingLoad.analysis,pending=a.pageWritePending;
  if(!pending || ['sending','checking'].includes(pending.status))return null;
  if(!pendingIsCurrent(a,pending))return null;
  pending.status='checking';
  try{
    if(retry){const receipt=await sendPending(a,pending);return pendingIsCurrent(a,pending)?{receipt,pending}:null;}
    const result=await api(pending.statusUrl);
    if(result.status==='recorded' && pendingIsCurrent(a,pending)){if(a.pageWritePending===pending)a.pageWritePending=null;return {receipt:result.receipt,pending};}
    pending.status='unknown';pending.error='Zapis još nije pronađen. To ne potvrđuje poništenje. Ponovite isti zahtev ili proverite ponovo.';return null;
  }catch{pending.status='unknown';pending.error='Ishod još nije potvrđen. Zadržite ekran i pokušajte ponovo.';return null;}
}

// Adapter keeps the existing staged Advanced plans, but each individual write
// gets a durable identity. Unknown steps block compensation and further writes.
export async function pageAdvancedApi(url,options){
  const a=state.trainingLoad.analysis;
  if(!a.pagesMode)return api(url,options);
  if(!a.page || !a.pageCapabilities.pageWidgetEditing)throw Object.assign(new Error('Stranica je samo za pregled.'),{status:409});
  const prefix=root(a.dashboard.id),tail=url.slice(prefix.length),body=JSON.parse(options.body||'{}');
  if(!url.startsWith(prefix+'/'))throw new Error('Invalid Advanced parent');
  if(Object.hasOwn(body,'expectedDashboardRevision')){delete body.expectedDashboardRevision;body.expectedPageRevision=a.page.revision;}
  if(Object.hasOwn(body,'expectedRevision')){delete body.expectedRevision;body.expectedPageLayoutRevision=a.page.layoutRevision;}
  const base=prefix+'/pages/'+encodeURIComponent(a.selectedPageId)+'/advanced';
  const receipt=await startWrite(a,{url:base+tail,method:options.method,body,kind:'advanced',statusUrl:id=>base+'/requests/'+id});
  return receipt.result;
}
