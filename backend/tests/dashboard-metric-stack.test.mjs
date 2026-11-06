import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMetricStack} from '../src/dashboardPages/metricStack.js';
import {validateContract} from '../src/dashboardSimple/schema.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const period={dateFrom:'2026-10-06',dateTo:'2026-10-08',timeZone:'Europe/Belgrade'};
const row=(value,extra={})=>({athleteId:id(1),bucketKey:'2026-10-06',value,unit:'m',...extra});
function fixture(arrays=[[row(0),row(4,{bucketKey:'2026-10-08'})],[row(3),row(6,{bucketKey:'2026-10-08'})]]){
 const definition={schemaVersion:1,semantics:'non-overlapping-additive',unit:'m',components:arrays.map((_,i)=>id(20+i))};
 const series=arrays.map((_,i)=>({id:id(10+i),metric_definition_id:id(20+i),axis:'primary',resolution_status:'resolved',data_scope_level:'session',analytical_aggregation:'sum',source_policy:'manual',aggregation_role_policy:'standalone_only',coverage_policy:'complete_only'}));
 const widget={id:id(3),widget_type:'bar_chart',group_by:'day',presentation_config:{schemaVersion:1,chartVariant:'stacked',chartComposition:'components-v1',chartInteractions:{},stackDefinition:definition},series};
 const result={widgetId:widget.id,series:arrays.map((rows,i)=>({seriesId:series[i].id,status:'ok',data:{current:rows}}))};
 const input={widget,result,period,queryId:id(5)};return {input,run:()=>buildMetricStack(input)};
}
test('server stack validates explicit additive set and yields exact components, provenance and finite total',()=>{
 const f=fixture(),before=structuredClone(f.input),r=f.run();assert.equal(r.status,'ready');assert.deepEqual(r.buckets.map(b=>b.total),[3,10]);assert.deepEqual(r.buckets[0].components.map(c=>c.value),[0,3]);assert.equal(r.bindings[0].unit,'m');assert.equal(r.buckets[1].components[1].rowIndex,1);assert.deepEqual(f.input,before);
 r.definition.components.pop();assert.equal(f.input.widget.presentation_config.stackDefinition.components.length,2);
});
test('missing, null conflict, duplicate, negative or overflowing components omit the entire bucket',()=>{
 for(const [arrays,reason]of [[[[row(2)],[row(3,{bucketKey:'2026-10-07'})]],'incompleteOrProblemComponents'],[[[row(null,{conflict:true})],[row(3)]],'incompleteOrProblemComponents'],[[[row(2),row(4)],[row(3)]],'incompleteOrProblemComponents'],[[[row(-1)],[row(3)]],'negativeComponent'],[[[row(Number.MAX_VALUE)],[row(Number.MAX_VALUE)]],'nonFiniteTotal']]){
  const r=fixture(arrays).run();assert.equal(r.status,'empty');assert.deepEqual(r.buckets,[]);assert.ok(r.omissions.every(o=>o.reasons.includes(reason)));
 }
 const r=fixture([[row(2),row(9,{bucketKey:'2026-10-07'})],[row(3)]]).run();assert.equal(r.status,'partial');assert.equal(r.buckets[0].total,5);assert.equal(r.omissions.length,1);
});
test('same unit is insufficient: declaration, distinct metric IDs, sum and matched compatible policies are required',()=>{
 for(const change of [f=>delete f.widget.presentation_config.stackDefinition,f=>f.widget.presentation_config.stackDefinition.components[0]=id(90),f=>f.widget.series[1].metric_definition_id=f.widget.series[0].metric_definition_id,f=>f.widget.series[0].built_in_series_key='rpe',f=>f.widget.series[0].analytical_aggregation='avg',f=>f.widget.series[0].axis='secondary',f=>f.widget.series[0].aggregation_role_policy='standalone_and_source_rollup',f=>f.widget.series[0].coverage_policy='complete_and_partial',f=>f.widget.series[1].source_policy='api_import',f=>f.widget.series[1].data_scope_level='day',f=>f.widget.series[0].resolution_status='unresolved',f=>f.widget.group_by='athlete',f=>f.result.series[1].data.current[0].unit='s']){
  const {input,run}=fixture();change(input);assert.equal(run().status,'unavailable');assert.deepEqual(run().buckets,[]);
 }
});
test('three or more component series are joined by athlete/bucket, never by row order',()=>{
 const r=fixture([[row(4),row(8,{bucketKey:'2026-10-08'})],[row(3,{bucketKey:'2026-10-08'}),row(2)],[row(9),row(5,{bucketKey:'2026-10-08'})]]).run();assert.equal(r.status,'ready');assert.deepEqual(r.buckets.map(b=>b.components.map(c=>c.value)),[[4,2,9],[8,3,5]]);assert.deepEqual(r.buckets.map(b=>b.total),[15,16]);
});
test('definition shape pairs with stacked only and keeps opaque future support separate',()=>{
 const value=fixture().input.widget.presentation_config;assert.equal(validateContract('presentationV1',value).valid,true);
 for(const invalid of [{...value,chartVariant:'area'},{...value,chartComposition:'athletes-v1'},{...value,stackDefinition:{...value.stackDefinition,components:[id(1),id(1)]}},{...value,stackDefinition:{...value.stackDefinition,unit:' '}},{...value,chartInteractions:{yAxis:{mode:'fixed',min:0,max:100}}}])assert.equal(validateContract('presentationV1',invalid).valid,false);
});
test('limits and empty observations never silently truncate or invent stack totals',()=>{
 assert.equal(fixture([[],[]]).run().status,'empty');
 const many=fixture([Array.from({length:21},(_,i)=>row(2,{athleteId:id(100+i)})),[]]).run();assert.equal(many.status,'requiresChoice');
 assert.equal(fixture(Array.from({length:9},()=>[row(2)])).run().status,'unavailable');
});
