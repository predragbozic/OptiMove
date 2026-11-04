import {test} from 'node:test';
import assert from 'node:assert/strict';
import {state,emptyTrainingLoadState} from '../state.js';
import {loadDashboardDetail} from '../training-load-analysis-data.js';
import {clearAllViewCache} from '../view-cache.js';

test('povratak A-B-A pokreće roster za novu instancu, a stari odgovor je ne može popuniti',async()=>{
  clearAllViewCache();
  const originalFetch=globalThis.fetch;const pending=[];
  const ok=value=>({ok:true,json:async()=>structuredClone(value)});
  globalThis.fetch=async url=>{
    if(String(url)==='/api/organization')return new Promise(resolve=>pending.push(value=>resolve(ok(value))));
    return ok({dashboard:{id:'d',name:'D',status:'active',revision:1},widgets:[{id:'w',widget_type:'line_chart',group_by:'day',revision:1,presentation_config:{schemaVersion:1,chartComposition:'athletes-v1'},series:[{id:'s',built_in_series_key:'rpe',resolution_status:'resolved'}]}]});
  };
  const open=async scope=>{state.currentUser={id:'u',activeWorkspace:{type:'team',scopeId:scope}};state.trainingLoad=emptyTrainingLoadState();state.trainingLoad.analysis.selectedDashboardId='d';await loadDashboardDetail('d',()=>{},{force:true});};
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  try{
    await open('A');assert.equal(pending.length,1);
    state.currentUser.activeWorkspace.scopeId='B';state.trainingLoad=emptyTrainingLoadState();
    await open('A');assert.equal(pending.length,2);
    pending[0]({athletes:[{id:'old',name:'Staro'}]});await flush();assert.equal(state.trainingLoad.orgPickerData,null);
    pending[1]({athletes:[{id:'new',name:'Novo'}]});await flush();assert.deepEqual(state.trainingLoad.orgPickerData,{athletes:[{id:'new',name:'Novo'}]});
  }finally{globalThis.fetch=originalFetch;}
});
