import { state } from './state.js';
import { mutatePage,resolvePageWrite } from './training-load-pages-data.js';

export function handlePageTabKeydown(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
    || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
  const tab = event.target?.closest?.('[role="tab"][data-action="training-load-analysis-page-select"]');
  const tablist = tab?.closest('[role="tablist"]');
  if (!tablist) return false;
  const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter(item =>
    item.closest('[role="tablist"]') === tablist && !item.matches(':disabled') && item.getAttribute('aria-disabled') !== 'true');
  const index = tabs.indexOf(tab);
  if (index < 0) return false;
  const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
    : tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
  event.preventDefault();
  for (const item of tablist.querySelectorAll('[role="tab"]')) {
    if (item.closest('[role="tablist"]') === tablist) item.tabIndex = item === next ? 0 : -1;
  }
  next.focus();
  return true;
}

const formError=error=>({stalePageRevision:'Stranica je u međuvremenu izmenjena. Osvežite je i proverite promene.',stalePagesRevision:'Redosled stranica je promenjen. Osvežite dashboard.',stalePageDefaultsRevision:'Početna podešavanja su promenjena. Osvežite stranicu.',lastPageRequired:'Poslednja stranica ne može da se obriše.',pageLimitReached:'Dashboard može imati najviše 32 stranice.',notFound:'Stranica više nije dostupna.',invalidRequest:'Proverite naziv i podešavanja stranice.'}[error.data?.error]||error.message||'Promena nije sačuvana. Pokušajte ponovo.');
export async function handlePageAction(action,{render,refresh,mayLeave,reconcile}){
  const a=state.trainingLoad.analysis,type=action.dataset.action.replace('training-load-analysis-page-','');
  if(type==='write-status'||type==='write-retry'){
    const promise=resolvePageWrite({retry:type==='write-retry'});render();const result=await promise;
    if(result){await refresh(result.pending.kind==='pages'&&['create','duplicate'].includes(result.receipt.operation)?result.receipt.pageId:undefined);reconcile?.(result);a.pageForm=null;a.notice='Čuvanje je potvrđeno. Proverite preostale izmene pre novog čuvanja.';}
    render();return true;
  }
  if(a.pageWritePending || a.saving || a.detailLoading || a.editor?.saving || a.metricPanel?.saving || ['saving','unknown'].includes(a.simpleEditor?.saveState))return true;
  if(type==='form-name'||type==='form-preset'){if(a.pageForm)a.pageForm[type==='form-name'?'name':'preset']=action.value;return true;}
  if(type==='form-cancel'){a.pageForm=null;render();return true;}
  if(type==='select'){
    if(action.dataset.pageId===a.selectedPageId || !a.pages.some(p=>p.id===action.dataset.pageId))return true;
    if(!mayLeave())return true;a.pageForm=null;await refresh(action.dataset.pageId);render();return true;
  }
  if(!a.pagesMode || !a.pageCapabilities.pageManagement || !a.page)return true;
  if(['create','rename','duplicate','delete'].includes(type)){
    if(['create','duplicate'].includes(type)&&a.pages.length>=32 || type==='delete'&&a.pages.length<=1)return true;
    if(!mayLeave())return true;
    a.pageForm={mode:type,name:type==='create'?'':type==='duplicate'?`${a.page.name} — kopija`.slice(0,200):a.page.name,preset:'last_28_days',targetId:a.page.id,pageRevision:a.page.revision,pagesRevision:a.pagesRevision,widgetCount:a.widgets.length,error:'',submitting:false};render();
    globalThis.document?.querySelector('[data-action="training-load-analysis-page-form-name"]')?.focus();return true;
  }
  let operation,fields,preferred;
  if(type==='form-submit'){
    const form=a.pageForm;if(!form || form.submitting || form.targetId!==a.page.id)return true;
    form.name=action.querySelector?.('[name="name"]')?.value??form.name;form.preset=action.querySelector?.('[name="preset"]')?.value??form.preset;
    if(form.mode!=='delete'&&(!form.name?.trim()||form.name.length>200)){form.error='Unesite naziv od 1 do 200 znakova.';render();return true;}
    operation=form.mode;
    const revisions={expectedPageRevision:form.pageRevision,expectedPagesRevision:form.pagesRevision};
    if(operation==='create'){
      const periodConfig=form.preset==='current'?{schemaVersion:1,mode:'fixed',...a.period,timeZone:a.period.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}:{schemaVersion:1,mode:'relative',preset:form.preset,timeZone:a.period.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
      fields={name:form.name.trim(),expectedPagesRevision:form.pagesRevision,periodConfig,defaultFilter:{}};
    }else if(operation==='rename')fields={name:form.name.trim(),expectedPageRevision:form.pageRevision};
    else if(operation==='duplicate')fields={name:form.name.trim(),...revisions};
    else fields={...revisions,deleteWidgets:form.widgetCount>0};
    form.submitting=true;form.error='';
  }else if(type==='left'||type==='right'){
    if(!mayLeave())return true;const ids=a.pages.map(p=>p.id),i=ids.indexOf(a.selectedPageId),j=i+(type==='left'?-1:1);
    if(j<0||j>=ids.length)return true;[ids[i],ids[j]]=[ids[j],ids[i]];operation='reorder';fields={pageIds:ids,expectedPagesRevision:a.pagesRevision};
  }else if(type==='defaults'){
    if(!mayLeave() || !a.period.dateFrom || !a.period.dateTo)return true;
    if(!window.confirm(`Sačuvati raspon ${a.period.dateFrom} – ${a.period.dateTo} i trenutne filtere kao početne za ovu stranicu?`))return true;
    const runtime={...a.runtimeFilter};if(Array.isArray(runtime.athleteIds)&&!runtime.athleteIds.length)delete runtime.athleteIds;
    if(runtime.activityId==='')runtime.activityId=null;if(runtime.componentId==='')runtime.componentId=null;
    operation='defaults';fields={expectedPageDefaultsRevision:a.page.defaultsRevision,periodConfig:{schemaVersion:1,mode:'fixed',dateFrom:a.period.dateFrom,dateTo:a.period.dateTo,timeZone:a.period.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'},defaultFilter:{...(a.page.defaultFilter??{}),...runtime}};
  }else return true;
  const promise=mutatePage(operation,fields);render();
  try{const receipt=await promise;if(['create','duplicate'].includes(operation))preferred=receipt.pageId;await refresh(preferred);a.pageForm=null;a.notice=operation==='delete'?'Stranica je obrisana.':'Promena stranice je sačuvana.';}
  catch(error){if(a.pageForm){a.pageForm.submitting=false;a.pageForm.error=formError(error);}else a.mutationError=formError(error);}
  render();return true;
}
