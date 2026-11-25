import {test,mock} from 'node:test';
import {needsModuleMocksRelaunch,relaunchWithModuleMocks} from './support/relaunch-with-module-mocks.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

if(needsModuleMocksRelaunch()){test('reference query with isolated database dependency',()=>relaunchWithModuleMocks(import.meta.url));}else{
mock.module('../src/db.js',{namedExports:{query:async()=>{throw Error('Unexpected default query')}}});
const {attachReferenceResults}=await import('../src/dashboardReferences/query.js');
const club=randomUUID(),athlete=randomUUID(),position=randomUUID(),metric=randomUUID(),seriesId=randomUUID(),widgetId=randomUUID();
const config={schemaVersion:1,source:'preset',mode:'radar',clubId:club,tableId:randomUUID(),versionId:randomUUID(),axes:[{seriesId,anchorKey:'target',valueKeys:['minimum','target'],band:{lowerKey:'minimum',upperKey:'target'}}]};
function fixture(overrides={}){
 const widgets=[{id:widgetId,presentation_config:{schemaVersion:1,referenceConfig:structuredClone(config)},series:[{id:seriesId,metric_definition_id:metric,analytical_aggregation:'sum',data_scope_level:'session'}]}];
 const results=[{widgetId,series:[{seriesId,status:'ok',data:{current:[{athleteId:athlete,value:150,unit:'m'}]}}]}];
 const calls=[];
 const query=async(sql,params)=>{calls.push([sql,params]);let rows;
 if(sql.includes('dashboard_reference_tables'))rows=[{name:'Game targets',version:1}];
 else if(sql.includes('metric_definitions'))rows=[{label:'Distance',state:'active',unit:'m'}];
 else if(sql.includes('dashboard_reference_columns'))rows=[{unit:'m',aggregation:'sum',data_level:'session'}];
 else if(sql.includes('public.athletes'))rows=[{id:athlete,name:'Alex Player',position_id:position}];
 else if(sql.includes('dashboard_reference_cells'))rows=[{position_id:position,value_key:'minimum',value:0},{position_id:position,value_key:'target',value:100}];
 else if(sql.includes('dashboard_reference_value_kinds'))rows=[{key:'minimum',name:'Minimum'},{key:'target',name:'Target'}];
 else throw Error('Unexpected query: '+sql);
 if(overrides.rows)rows=overrides.rows(sql,rows);
 return {rows};};
 const args={query,widgets,results,workspace:{dataWorkspaceType:'club',dataWorkspaceScopeId:club},period:{},defaultFilter:{},requestFilter:{},referenceClubId:club,enabled:true};
 return {args,calls,widgets,results};
}
test('preset comparison uses the pinned version, current position and unclamped actual; zero remains a reference',async()=>{
 const f=fixture(),[result]=await attachReferenceResults(f.args),point=result.references.axes[0].points[0];
 assert.equal(point.label,'Alex Player');assert.equal(point.normalized,150);assert.equal(point.references[0].value,0);assert.equal(point.references[0].normalized,0);
 assert.deepEqual(point.band,{status:'ok',lower:0,upper:100});
 assert.ok(f.calls.some(([sql,params])=>sql.includes('dashboard_reference_tables')&&params[2]===config.versionId));
 assert.ok(f.calls.some(([sql,params])=>sql.includes('athlete_position_in_force')&&params[1]===club));
 assert.doesNotMatch(JSON.stringify(result.references),new RegExp(athlete+'|'+position));
});
test('no position and absent target are unavailable, never zero',async()=>{
 const f=fixture({rows:(sql,rows)=>sql.includes('public.athletes')?[{id:athlete,name:'Alex Player',position_id:null}]:rows});
 assert.equal((await attachReferenceResults(f.args))[0].references.axes[0].points[0].reason,'noPosition');
 const missing=fixture({rows:(sql,rows)=>sql.includes('dashboard_reference_cells')?[]:rows});
 const p=(await attachReferenceResults(missing.args))[0].references.axes[0].points[0];assert.equal(p.status,'unavailable');assert.equal(p.reason,'invalidAnchor');assert.equal(p.references[0].value,null);
});
test('a genuine measurement conflict is unavailable and never normalized',async()=>{
 const f=fixture();f.results[0].series[0].data.current[0].conflict=true;
 const p=(await attachReferenceResults(f.args))[0].references.axes[0].points[0];assert.equal(p.reason,'dataConflict');assert.equal(p.actual,null);assert.equal(p.normalized,undefined);
});
test('foreign, disabled and view-only workspaces cannot retrieve reference values',async()=>{
 for(const patch of [{referenceClubId:randomUUID()},{enabled:false},{workspace:{dataWorkspaceType:'club_view',dataWorkspaceScopeId:club}},{workspace:{dataWorkspaceType:'team_view',dataWorkspaceScopeId:club}}]){
  const f=fixture();Object.assign(f.args,patch);const result=(await attachReferenceResults(f.args))[0];assert.equal(result.references.status,'unavailable');assert.equal(f.calls.length,0);assert.deepEqual(result.series,f.results[0].series);
 }
});
test('archived or hidden metric and mismatched unit do not expose targets',async()=>{
 for(const [needle,rows,reason]of [['metric_definitions',[],'metricUnavailable'],['dashboard_reference_columns',[{unit:'min',aggregation:'sum',data_level:'session'}],'incompatibleUnit']]){
  const f=fixture({rows:(sql,current)=>sql.includes(needle)?rows:current});const a=(await attachReferenceResults(f.args))[0].references.axes[0];assert.equal(a.reason,reason);assert.deepEqual(a.points,[]);
 }
});

}
