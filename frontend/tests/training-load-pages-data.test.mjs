import {test} from 'node:test';
import assert from 'node:assert/strict';
import {state,emptyTrainingLoadState} from '../state.js';
import {clearAllViewCache} from '../view-cache.js';
import {loadPagesDashboard,pageAdvancedApi,resolvePageWrite} from '../training-load-pages-data.js';
import {loadDashboardDetail,queryAnalysisDashboard,openAnalysisWidgetEditor,addEditorSeries,setEditorSeriesMetric,rebaseAnalysisEditorDraft,reconcileConfirmedPageWrite,analysisEditorPlan} from '../training-load-analysis-data.js';
import {handlePageAction} from '../training-load-pages-actions.js';

globalThis.window={confirm:()=>true,matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}};
globalThis.document={querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},body:{classList:{contains:()=>false}}};
const root='/api/training-load/dashboards/d1';
const pages=[{id:'p1',name:'Prva',revision:3,defaultsRevision:2,layoutRevision:4,position:0,periodOrigin:'configured',periodConfig:{schemaVersion:1,mode:'fixed',dateFrom:'2026-10-01',dateTo:'2026-10-07',timeZone:'Europe/Belgrade'},defaultFilter:{}},{id:'p2',name:'Druga',revision:1,defaultsRevision:1,layoutRevision:1,position:1,periodOrigin:'configured',periodConfig:{schemaVersion:1,mode:'relative',preset:'last_7_days',timeZone:'Europe/Belgrade'},defaultFilter:{}}];
const dashboard={id:'d1',name:'Dashboard',status:'active',is_template:false,revision:9,pages_revision:2,default_filter:{}};
function reset(responder){
  clearAllViewCache();state.currentUser={id:'u1',activeWorkspace:{type:'private_coach',scopeId:null}};state.trainingLoad=emptyTrainingLoadState();
  const a=state.trainingLoad.analysis;Object.assign(a,{selectedDashboardId:'d1',dashboard:{...dashboard},dashboards:[{...dashboard}],period:{dateFrom:'2026-09-01',dateTo:'2026-09-10'}});
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const call={url:String(url),method:options.method||'GET',body:options.body};calls.push(call);
    const result=await (responder?.(call)??defaultResponse(call));
    return {ok:(result.status??200)<300,status:result.status??200,json:async()=>result.body??result};
  };
  return {a,calls};
}
function defaultResponse(c){
  if(c.url===root+'/pages')return {dashboard:{...dashboard},pages:structuredClone(pages),pagesRevision:2,capabilities:{pages:true,pageManagement:true,pageWidgetEditing:true,pageQuery:true}};
  const page=pages.find(p=>c.url===root+'/pages/'+p.id);if(page)return {page:structuredClone(page),widgets:[{id:'w-'+page.id,revision:1,title:page.name,series:[]}]};
  if(c.url.endsWith('/query'))return {pageId:c.url.includes('/p2/')?'p2':'p1',queryId:'q',resolvedPeriod:{dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'Europe/Belgrade'},widgets:[]};
  throw new Error('Unexpected request '+c.url);
}
test('Pages list supplies parent metadata and loads only the active Page',async()=>{
  const f=reset();await loadDashboardDetail('d1',()=>{});
  assert.equal(f.a.pagesMode,true);assert.equal(f.a.selectedPageId,'p1');assert.equal(f.a.widgets[0].id,'w-p1');
  assert.deepEqual(f.calls.map(c=>c.url),[root+'/pages',root+'/pages/p1']);
});
test('Late detail of the previous Page cannot replace the selected Page',async()=>{
  let finish;
  const f=reset(c=>c.url===root+'/pages/p1'?new Promise(resolve=>{finish=()=>resolve(defaultResponse(c));}):defaultResponse(c));
  const first=loadPagesDashboard('d1',()=>{});while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
  await loadPagesDashboard('d1',()=>{},{preferredPageId:'p2'});finish();await first;
  assert.equal(f.a.selectedPageId,'p2');assert.equal(f.a.widgets[0].id,'w-p2');
});
test('Personal filter/period stays with its Page; configured defaults resolve on server',async()=>{
  const f=reset();await loadDashboardDetail('d1',()=>{});
  f.a.period={dateFrom:'2026-09-02',dateTo:'2026-09-03',timeZone:'Europe/Belgrade'};f.a.runtimeFilter={activityId:'a1'};f.a.pageRuntimeUsesDefaults=false;
  await loadDashboardDetail('d1',()=>{},{preferredPageId:'p2'});assert.deepEqual(f.a.runtimeFilter,{});assert.equal(f.a.pageRuntimeUsesDefaults,true);
  await queryAnalysisDashboard(()=>{},{force:true});
  const sent=JSON.parse(f.calls.find(c=>c.url.endsWith('/p2/query')).body);assert.equal(Object.hasOwn(sent,'period'),false);assert.equal(f.a.period.dateFrom,'2026-11-01');
  await loadDashboardDetail('d1',()=>{},{preferredPageId:'p1'});assert.equal(f.a.period.dateFrom,'2026-09-02');assert.deepEqual(f.a.runtimeFilter,{activityId:'a1'});
});
test('Late query results are discarded after changing Page',async()=>{
  let finish;
  const f=reset(c=>c.url.endsWith('/p1/query')?new Promise(resolve=>{finish=()=>resolve({pageId:'p1',widgets:[{widgetId:'foreign'}]});}):defaultResponse(c));
  await loadDashboardDetail('d1',()=>{});const query=queryAnalysisDashboard(()=>{},{force:true});while(!finish)await new Promise(resolve=>setTimeout(resolve,0));
  await loadDashboardDetail('d1',()=>{},{preferredPageId:'p2'});finish();await query;assert.equal(f.a.queryResult,null);assert.equal(f.a.selectedPageId,'p2');
});
test('Advanced unknown blocks compensation and retries original bytes on original Page',async()=>{
  let lost=true;
  const f=reset(c=>c.method==='POST'?lost?Promise.reject(new Error('lost')):{requestId:'r',pageId:'p1',result:{widgetId:'new'}}:defaultResponse(c));
  await loadDashboardDetail('d1',()=>{});
  await assert.rejects(pageAdvancedApi(root+'/widgets',{method:'POST',body:JSON.stringify({expectedDashboardRevision:9,title:'Widget'})}),{pageOutcomeUnknown:true});
  const original=f.calls.find(c=>c.method==='POST');assert.equal(original.url,root+'/pages/p1/advanced/widgets');assert.equal(JSON.parse(original.body).expectedPageRevision,3);
  const count=f.calls.length;await assert.rejects(pageAdvancedApi(root+'/widgets/new',{method:'DELETE',body:'{}'}),{pageOutcomeUnknown:true});assert.equal(f.calls.length,count);
  f.a.page.revision=20;lost=false;const result=await resolvePageWrite({retry:true});assert.equal(result.receipt.result.widgetId,'new');
  assert.deepEqual(f.calls.filter(c=>c.method==='POST')[1],original);assert.equal(f.a.pageWritePending,null);
});
test('notRecorded status keeps durable request locked; other Page cannot consume it',async()=>{
  const f=reset(c=>c.method==='POST'?Promise.reject(new Error('lost')):c.url.includes('/requests/')?{status:'notRecorded'}:defaultResponse(c));
  await loadDashboardDetail('d1',()=>{});await assert.rejects(pageAdvancedApi(root+'/widgets',{method:'POST',body:'{}'}));
  await resolvePageWrite();assert.equal(f.a.pageWritePending.status,'unknown');
  const count=f.calls.length;f.a.selectedPageId='p2';assert.equal(await resolvePageWrite(),null);assert.equal(f.calls.length,count);
});
test('Delete confirmation retains the Page revision shown when the form opened',async()=>{
  const f=reset(c=>c.method==='DELETE'?{operation:'delete',pageId:'p1'}:defaultResponse(c));await loadDashboardDetail('d1',()=>{});
  const action=type=>({dataset:{action:'training-load-analysis-page-'+type}}),options={render(){},refresh:async()=>{},mayLeave:()=>true};
  await handlePageAction(action('delete'),options);assert.equal(f.a.pageForm.widgetCount,1);
  f.a.page.revision=50;f.a.pagesRevision=20;f.a.widgets.push({id:'new'});
  await handlePageAction(action('form-submit'),options);
  const sent=JSON.parse(f.calls.find(c=>c.method==='DELETE').body);assert.equal(sent.expectedPageRevision,3);assert.equal(sent.expectedPagesRevision,2);assert.equal(sent.deleteWidgets,true);
});

for(const earlyCommit of [false,true])test(`Confirmed Advanced series adopts exact receipt after ${earlyCommit?'early':'late'} COMMIT, without another add`,()=>{
  const f=reset(),a=f.a;
  a.pagesMode=true;a.selectedPageId='p1';
  const first={id:'s1',widget_id:'w',series_order:1,built_in_series_key:'rpe',resolution_status:'resolved',axis:'primary',source_policy:'not_applicable',data_scope_level:'session',analytical_aggregation:'avg',aggregation_role_policy:'standalone_and_source_rollup',coverage_policy:'complete_and_partial'};
  const widget={id:'w',title:'Table',widget_type:'table',group_by:'day',revision:1,series:[first]};a.widgets=[widget];openAnalysisWidgetEditor(widget);
  const draft=a.editor.draft,key=addEditorSeries(draft),entry=draft.series.find(e=>e.key===key);setEditorSeriesMetric(entry,{kind:'builtin',key:'srpe'});
  entry.pendingAdd={knownIds:['s1'],requestId:'r1'};
  const pending={kind:'advanced',dashboardId:'d1',pageId:'p1',requestId:'r1',draftSeriesKey:key,replacesSeriesId:null,url:root+'/pages/p1/advanced/widgets/w/series',body:JSON.stringify({builtInSeriesKey:'srpe'})};a.pageWritePending=pending;
  const committed={...widget,revision:2,series:[first,{...first,id:'s2',series_order:2,built_in_series_key:'srpe',analytical_aggregation:'sum'}]};
  rebaseAnalysisEditorDraft(earlyCommit?committed:widget,draft,a.editor.base);
  assert.equal(entry.pendingAdd.requestId,'r1');
  a.widgets=[committed];a.pageWritePending=null;reconcileConfirmedPageWrite({pending,receipt:{result:{seriesId:'s2'}}});
  assert.equal(draft.series.filter(e=>e.id==='s2').length,1);assert.equal(entry.id,'s2');assert.equal(entry.pendingAdd,null);
  assert.equal(analysisEditorPlan(committed,draft).some(op=>op.type==='addSeries'),false);
});
