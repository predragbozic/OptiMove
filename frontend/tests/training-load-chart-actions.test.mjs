import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {state,emptyTrainingLoadState} from '../state.js';
import {applyDashboardChartPeriod,dashboardChartContext} from '../training-load-chart-actions.js';
import {clearAllViewCache} from '../view-cache.js';
let calls,confirmations;
beforeEach(()=>{
  clearAllViewCache();calls=[];confirmations=0;
  state.activeTab='training-load';state.currentUser={id:'coach',activeWorkspace:{type:'team',scopeId:'team'}};state.trainingLoad=emptyTrainingLoadState();state.trainingLoad.section='analysis';
  Object.assign(state.trainingLoad.analysis,{selectedDashboardId:'dashboard',dashboard:{id:'dashboard',status:'active',revision:1},widgets:[{id:'widget',revision:1}],queryResult:{queryId:'query'},period:{dateFrom:'2026-10-01',dateTo:'2026-10-14'},runtimeFilter:{athleteIds:['a'],activityId:'',componentId:''}});
  globalThis.window={confirm:()=>{confirmations++;return true;}};
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({queryId:'next',widgets:[]})};};
});
const detail=()=>({queryId:'query',widgetId:'widget',contextId:dashboardChartContext(),confirmed:true,dateFrom:'2026-10-02',dateTo:'2026-10-05'});
test('eksplicitna potvrda menja lični period i šalje tačno jedan batch bez shared upisa',async()=>{
  assert.equal(await applyDashboardChartPeriod(detail(),()=>{}),true);assert.equal(confirmations,0);assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/training-load/dashboards/dashboard/query');
  assert.deepEqual(JSON.parse(calls[0].options.body),{dateFrom:'2026-10-02',dateTo:'2026-10-05',athleteIds:['a'],activityId:null,componentId:null});
  assert.equal(state.trainingLoad.analysis.queryResult.queryId,'next');assert.equal(state.trainingLoad.analysis.dashboard.revision,1);
});
test('otkazivanje ne menja period i ne šalje zahtev',async()=>{
  assert.equal(await applyDashboardChartPeriod({...detail(),confirmed:false},()=>{}),false);assert.equal(calls.length,0);assert.equal(state.trainingLoad.analysis.period.dateFrom,'2026-10-01');
});
test('stari query, kontekst, nestali widget i prevelik opseg ne šalju batch',async()=>{
  for(const change of [{queryId:'old'},{contextId:'old'},{widgetId:'gone'},{dateFrom:'2026-09-30'},{dateTo:'2026-10-15'},{dateTo:'2026-02-30'}])assert.equal(await applyDashboardChartPeriod({...detail(),...change},()=>{}),false);
  assert.equal(confirmations,0);assert.equal(calls.length,0);
});
test('tokom editora, layouta, query-a i druge sekcije nema promene perioda',async()=>{
  const a=state.trainingLoad.analysis;
  for(const field of ['simpleEditor','layoutDraft','queryLoading']){a[field]={};assert.equal(await applyDashboardChartPeriod(detail(),()=>{}),false);a[field]=field==='queryLoading'?false:null;}
  a.editor.open=true;assert.equal(await applyDashboardChartPeriod(detail(),()=>{}),false);a.editor.open=false;
  state.trainingLoad.section='today';assert.equal(await applyDashboardChartPeriod(detail(),()=>{}),false);assert.equal(calls.length,0);
});
test('promena konteksta tokom potvrde čini odloženu akciju nevažećom',async()=>{
  const input=detail();state.trainingLoad.analysis.runtimeFilter.athleteIds=['other'];
  assert.equal(await applyDashboardChartPeriod(input,()=>{}),false);assert.equal(calls.length,0);
});
