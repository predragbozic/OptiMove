import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildGalleryData,galleryQuantile} from '../src/dashboardGallery/data.js';
const row=(value,bucketKey='2026-11-01',extra={})=>({athleteId:'athlete-a',bucketKey,unit:'m',value,...extra});
function project(kind,rows=[[row(2)],[row(4)]],shape={},definitions={}){
 const ids=rows.map((_,n)=>'series-'+n);
 const widget={id:'widget',widget_type:'bar_chart',group_by:'day',series:ids.map(id=>({id,data_scope_level:'session',analytical_aggregation:'sum',...definitions}))};
 const result={widgetId:'widget',series:ids.map((seriesId,n)=>({seriesId,status:'ok',data:{current:rows[n]}}))};
 return buildGalleryData({widget,result,shape:{kind,...shape}});
}
test('scatter joins exact identities even when both axes arrive in different orders',()=>{
 const result=project('scatter',[[row(2),row(3,'2026-11-02')],[row(8,'2026-11-02'),row(4)]]);
 assert.equal(result.status,'ready');assert.deepEqual(result.groups.map(g=>g.values),[[2,4],[3,8]]);
});
test('scatter never chooses among real sources or duplicate target candidates',()=>{
 for(const first of [[row(2),row(3)],[row(2),row(3,'2026-11-01',{sourceConnectionId:'other'})],[row(2,'2026-11-01',{conflict:true})]]){
  const result=project('scatter',[first,[row(4)]]);assert.equal(result.status,'empty');assert.deepEqual(result.groups,[]);assert.equal(result.omitted,1);
 }
});
test('scatter omits unmatched athletes, dates and missing values; zero remains a point',()=>{
 const r=project('scatter',[[row(0),row(null,'2026-11-02'),row(3,'2026-11-03')],[row(-2),row(2,'2026-11-02'),row(7,'2026-11-03',{athleteId:'other'})]]);
 assert.deepEqual(r.groups.map(g=>g.values),[[0,-2]]);assert.equal(r.omitted,3);
});
test('athlete identifiers compare case-insensitively and shape references are distinct',()=>{
 assert.equal(project('scatter',[[row(2,'2026-11-01',{athleteId:'ABC'})],[row(4,'2026-11-01',{athleteId:'abc'})]]).groups.length,1);
 assert.equal(project('scatter',undefined,{seriesIds:['series-0','SERIES-0']}).reason,'invalidSeries');
});
test('combined axes require explicit complete bindings and compatible known units',()=>{
 const bindings=[{seriesId:'series-0',mark:'bar',axis:0},{seriesId:'series-1',mark:'line',axis:1}];
 assert.equal(project('combined',[[row(2)],[row(4,'2026-11-01',{unit:'min'})]],{bindings}).status,'ready');
 assert.equal(project('combined',[[row(2)],[row(4,'2026-11-01',{unit:'min'})]],{bindings:bindings.map(b=>({...b,axis:0}))}).reason,'incompatibleAxisUnit');
 assert.equal(project('combined',undefined,{bindings:[]}).reason,'chooseAxes');
 assert.equal(project('combined',undefined,{bindings:[bindings[0],bindings[0]]}).reason,'chooseAxes');
});
test('stacked needs declared additive components; missing and conflicting components are not zero',()=>{
 assert.equal(project('stacked').reason,'declareComponents');
 const ready=project('stacked',undefined,{additive:true});assert.equal(ready.groups[0].total,6);
 for(const bad of [row(null),row(3,'2026-11-01',{unitConflict:true}),row('3')])assert.equal(project('stacked',[[row(2)],[bad]],{additive:true}).status,'empty');
});
test('ratio and percent components cannot stack and unit mismatch cannot normalize',()=>{
 assert.equal(project('stacked',undefined,{additive:true},{analytical_aggregation:'ratio'}).reason,'nonAdditiveComponents');
 assert.equal(project('stacked',[[row(2)],[row(4,'2026-11-01',{unit:'min'})]],{additive:true}).reason,'nonAdditiveComponents');
 assert.equal(project('stacked',[[row(2,'2026-11-01',{unit:'%'})],[row(4,'2026-11-01',{unit:'%'})]],{additive:true}).reason,'nonAdditiveComponents');
});
test('heatmap retains zero and omits missing/conflicts without manufacturing cells',()=>{
 const r=project('heatmap',[[row(0),row(null,'2026-11-02'),row(9,'2026-11-03',{conflict:true})]]);
 assert.deepEqual(r.groups.map(g=>g.values),[[0]]);assert.equal(r.omitted,2);
 assert.equal(project('heatmap',[[row(1,'2026-11-01',{athleteId:null})]]).status,'empty');
});
test('boxplot uses declared interpolated quartiles, fences and count, not unseen observations',()=>{
 const values=[0,1,2,3,4,5,6,7,100];const r=project('boxplot',[values.map((n,i)=>row(n,'2026-11-01',{athleteId:'athlete-'+i}))]);
 assert.deepEqual(r.groups,[{bucketKey:'2026-11-01',count:9,box:[0,2,4,6,7],outliers:[100]}]);
 assert.deepEqual(project('boxplot',[[row(0)]]).groups[0].box,[0,0,0,0,0]);
 assert.equal(galleryQuantile([],0.5),null);
});
test('distribution drops ambiguous duplicate athlete samples and never weights by rawCount',()=>{
 const r=project('boxplot',[[row(2),row(3),row(9,'2026-11-01',{athleteId:'other',rawCount:500})]]);
 assert.equal(r.omitted,1);assert.equal(r.groups[0].count,1);assert.deepEqual(r.groups[0].box,[9,9,9,9,9]);
});
test('area and horizontal bars preserve independent series gaps and zero',()=>{
 for(const kind of ['area','horizontal_bar']){
  const r=project(kind,[[row(0),row(null,'2026-11-02')],[row(2,'2026-11-02')]]);
  assert.deepEqual(r.groups.map(g=>g.values),[[0,null],[null,2]]);assert.equal(r.status,'partial');
 }
});
test('unknown unit mixtures, mismatched widget and unready series fail closed',()=>{
 assert.equal(project('scatter',[[row(2),row(3,'2026-11-02',{unit:'min'})],[row(4)]]).reason,'seriesUnavailable');
 assert.equal(buildGalleryData({widget:{id:'a',series:[]},result:{widgetId:'b',series:[]},shape:{kind:'scatter'}}).status,'unavailable');
});
test('projections are pure and bounded; overflow totals are omitted',()=>{
 const widget={id:'w',widget_type:'bar_chart',group_by:'day',series:[{id:'a'},{id:'b'}]},result={widgetId:'w',series:[{seriesId:'a',status:'ok',data:{current:[row(1)]}},{seriesId:'b',status:'ok',data:{current:[row(2)]}}]};
 const before=structuredClone({widget,result});buildGalleryData({widget,result,shape:{kind:'scatter'}});assert.deepEqual({widget,result},before);
 assert.equal(project('stacked',[[row(Number.MAX_VALUE)],[row(Number.MAX_VALUE)]],{additive:true}).status,'empty');
 assert.equal(project('scatter',[[...Array(16001)].map(()=>row(1)),[row(2)]]).reason,'seriesUnavailable');
});

test('area and horizontal bars never combine incompatible units on their one axis',()=>{
 for(const kind of ['area','horizontal_bar'])assert.equal(project(kind,[[row(2)],[row(3,'2026-11-01',{unit:'min'})]]).reason,'incompatibleAxisUnit');
});

test('large athlete charts ask for a smaller selection; box distributions retain their bounded samples',()=>{
 const rows=Array.from({length:21},(_,i)=>row(i,'2026-11-01',{athleteId:'athlete-'+i}));
 assert.equal(project('heatmap',[rows]).reason,'athleteLimitExceeded');assert.equal(project('boxplot',[rows]).groups[0].count,21);
});
