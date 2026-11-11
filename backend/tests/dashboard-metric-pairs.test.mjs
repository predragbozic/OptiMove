import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMetricPairs} from '../src/dashboardPages/metricPairs.js';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const athlete=uuid(1),other=uuid(2),widgetId=uuid(3),xId=uuid(4),yId=uuid(5),queryId=uuid(6);
const period={dateFrom:'2026-10-06',dateTo:'2026-10-08',timeZone:'Europe/Belgrade'};
const row=(value,extra={})=>({athleteId:athlete,bucketKey:'2026-10-06',value,unit:'m',...extra});
function fixture(x=[row(0)],y=[row(67.123456,{unit:'min'})]){
 const widget={id:widgetId,widget_type:'line_chart',group_by:'day',series:[{id:xId,metric_definition_id:uuid(10),resolution_status:'resolved',source_policy:'manual',data_scope_level:'session',analytical_aggregation:'sum'},{id:yId,built_in_series_key:'duration_minutes',resolution_status:'resolved',source_policy:'not_applicable',data_scope_level:'session',analytical_aggregation:'avg'}]};
 const result={widgetId,series:[{seriesId:xId,status:'ok',data:{current:x}},{seriesId:yId,status:'ok',data:{current:y}}]};
 const input={widget,result,request:{schemaVersion:1,widgetId,xSeriesId:xId,ySeriesId:yId},period,queryId};
 return {input,run:()=>buildMetricPairs(input)};
}
test('pairs exact X/Y values per athlete and bucket with independent units, policies and stable raw locators',()=>{
 const {input,run}=fixture([row(-12.3456789,{sourceConnectionId:uuid(20),sourceProvenance:{key:'raw'}})],[row(67.123456,{unit:'min'})]);const before=structuredClone(input),output=run();
 assert.equal(output.status,'ready');assert.equal(output.queryId,queryId);assert.equal(output.pairs.length,1);
 assert.deepEqual([output.pairs[0].x.value,output.pairs[0].y.value],[-12.3456789,67.123456]);assert.deepEqual([output.bindings.x.unit,output.bindings.y.unit],['m','min']);
 assert.equal(output.pairs[0].x.source.reported.sourceConnectionId,uuid(20));assert.equal(output.pairs[0].x.rowIndex,0);assert.equal(output.bindings.y.analyticalAggregation,'avg');assert.deepEqual(input,before);
 output.pairs[0].x.source.reported.sourceProvenance.key='changed';assert.equal(input.result.series[0].data.current[0].sourceProvenance.key,'raw');
});
test('alignment never zips by row order or pairs different athletes or dates',()=>{
 const {run}=fixture([row(10),row(20,{athleteId:other,bucketKey:'2026-10-08'})],[row(60,{athleteId:other,bucketKey:'2026-10-08',unit:'min'}),row(70,{unit:'min'})]);
 const output=run();assert.deepEqual(output.pairs.map(p=>[p.x.value,p.y.value,p.x.rowIndex,p.y.rowIndex]),[[10,70,0,1],[20,60,1,0]]);
 const missing=fixture([row(0)],[row(1,{athleteId:other,bucketKey:'2026-10-08'})]).run();assert.equal(missing.status,'empty');assert.equal(missing.pairs.length,0);assert.equal(missing.omissions.length,2);
});
test('duplicates from different sources, nulls and problem values produce explicit omissions without choosing first',()=>{
 const {run}=fixture([row(5,{sourceConnectionId:uuid(11)}),row(6,{sourceConnectionId:uuid(12)}),row(null,{bucketKey:'2026-10-07'}),row(9,{bucketKey:'2026-10-08',conflict:true})],[row(1),row(2,{bucketKey:'2026-10-07'}),row(3,{bucketKey:'2026-10-08'})]);
 const output=run();assert.equal(output.status,'empty');assert.deepEqual(output.omissions.map(o=>o.reasons),[['duplicateX'],['missingValueX'],['problemX']]);assert.deepEqual(output.omissions[0].xRowIndexes,[0,1]);
 const partial=fixture([row(0),row(3,{bucketKey:'2026-10-07'})],[row(4)]).run();assert.equal(partial.status,'partial');assert.equal(partial.pairs[0].x.value,0);assert.deepEqual(partial.omissions[0].reasons,['missingY']);
});
test('engine conflicts with null values stay classified as problems on both axes, distinct from missing measurements',()=>{
 for(const problem of [{conflict:true},{unitConflict:true},{typeConflict:true},{semanticConflict:true},{error:'unavailable'}]){
  const x=fixture([row(null,problem)],[row(4)]).run();assert.deepEqual(x.omissions[0].reasons,['problemX']);
  const y=fixture([row(4)],[row(null,problem)]).run();assert.deepEqual(y.omissions[0].reasons,['problemY']);
 }
 assert.deepEqual(fixture([row(null)],[row(4)]).run().omissions[0].reasons,['missingValueX']);
});
test('unsupported series, mixed units, nonnumeric values, invalid identities and buckets refuse complete pairing',()=>{
 for(const [change,reason]of [[f=>f.widget.group_by='athlete','unsupportedWidget'],[f=>f.widget.series[0].resolution_status='ambiguous','seriesNotReady'],[f=>f.widget.series[0].comparison_period='previous_period','seriesNotReady'],[f=>f.result.series[0].status='error','seriesNotReady'],[f=>f.result.series[0].data.comparison=[row(1)],'seriesNotReady'],[f=>f.result.series[0].data.current.push(row(2,{unit:'km'})),'ambiguousAxisUnit'],[f=>f.result.series[0].data.current[0].value='3','numericSeriesRequired'],[f=>f.result.series[0].data.current[0].value=NaN,'numericSeriesRequired'],[f=>f.result.series[0].data.current[0].athleteId=null,'invalidObservation'],[f=>f.result.series[0].data.current[0].bucketKey='2026-10-05','invalidObservation'],[f=>f.result.series[0].data.current[0].conflict='false','invalidObservation'],[f=>f.result.series.push(structuredClone(f.result.series[0])),'invalidResult']]){
  const {input,run}=fixture();change(input);const output=run();assert.equal(output.status,'unavailable');assert.equal(output.reason,reason);assert.deepEqual(output.pairs,[]);
 }
});
test('week joins use server bucket Monday even before clipped start; date limit cannot roll over year 9999',()=>{
 const f=fixture([row(2,{bucketKey:'2026-10-05'})],[row(8,{bucketKey:'2026-10-05'})]);f.input.widget.group_by='week';assert.equal(f.run().status,'ready');
 f.input.period={...period,dateFrom:'9999-12-31',dateTo:'9999-12-31'};f.input.widget.group_by='day';for(const s of f.input.result.series)s.data.current[0].bucketKey='9999-12-31';assert.equal(f.run().status,'ready');
});
test('case insensitive UUID identities are matched, response provenance stays original',()=>{
 const athleteUpper='ABCDEFAB-0000-4000-8000-000000000001',f=fixture([row(1,{athleteId:athleteUpper})],[row(2,{athleteId:athleteUpper.toLowerCase()})]);assert.equal(f.run().pairs[0].athleteId,athleteUpper.toLowerCase());
 f.input.request.ySeriesId=f.input.request.xSeriesId;assert.equal(f.run().reason,'invalidPairing');
});
test('limits reject excess athletes or rows without silently dropping points; missing observations have empty status',()=>{
 const f=fixture(Array.from({length:21},(_,i)=>row(i,{athleteId:uuid(i+100)})),[]);assert.equal(f.run().status,'requiresChoice');assert.equal(f.run().reason,'athleteLimitExceeded');
 const many=fixture(Array.from({length:16001},()=>row(1)),[]);assert.equal(many.run().reason,'rowLimitExceeded');
 assert.equal(fixture([],[]).run().status,'empty');
});
