import {configureDashboardPlot} from '../training-load-analysis-echarts-options.js';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {galleryChartPlot} from '../training-load-gallery-options.js';
const id='11111111-1111-4111-8111-111111111111';
const base={status:'ready',kind:'area',series:[{seriesId:id,unit:'m'}],groups:[{athleteId:id,bucketKey:id,values:[0]}],omitted:0};
const labels={seriesLabel:()=> 'Distance',athleteLabel:()=> 'Alex',bucketLabel:()=> '01.11.2026'};
test('area preserves zero and gaps and does not mutate confirmed data',()=>{
 const data={...base,groups:[...base.groups,{athleteId:id,bucketKey:'b',values:[null]}]},copy=structuredClone(data);
 const plot=galleryChartPlot(data,labels);assert.deepEqual(plot.option.series[0].data,[0,null]);assert.deepEqual(plot.option.series[0].areaStyle,{opacity:.2});assert.equal(plot.option.series[0].connectNulls,false);assert.deepEqual(data,copy);
});
test('horizontal bars swap category/value axes with names and zero unchanged',()=>{
 const p=galleryChartPlot({...base,kind:'horizontal_bar'},labels);assert.equal(p.option.xAxis.type,'value');assert.equal(p.option.yAxis.type,'category');assert.deepEqual(p.option.yAxis.data,['01.11.2026']);assert.deepEqual(p.option.series[0].data,[0]);assert.equal(p.shortDateCategoryAxis,'y');
});
test('every gallery plot obeys legend visibility without serializing internal identities',()=>{
 for(const kind of ['area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot']){
  const data={...base,kind,...(kind==='boxplot'?{groups:[{bucketKey:id,count:1,box:[0,0,0,0,0],outliers:[]}]}:{})};
  const p=galleryChartPlot(data,{...labels,legendVisible:false,bindings:[{seriesId:id,axis:0,mark:'bar'}]});
  assert.equal(p.option.legend.show,false);assert.doesNotMatch(JSON.stringify(p),/[0-9a-f]{8}-[0-9a-f-]{27,}|Source provenance|rawCount/i);
 }
});
test('same-name athlete lines have distinct legend entries, including loading fallback',()=>{
 for(const athleteLabel of [()=> 'Alex',()=> 'Athlete name unavailable']){
  const p=galleryChartPlot({...base,groups:[...base.groups,{athleteId:'second',bucketKey:id,values:[1]}]},{...labels,athleteLabel});
  assert.equal(new Set(p.option.series.map(s=>s.name)).size,2);
 }
});
test('scatter renders server-confirmed pairs and labelled independent numeric axes',()=>{
 const p=galleryChartPlot({...base,kind:'scatter',series:[...base.series,{seriesId:'time',unit:'min'}],groups:[{athleteId:id,bucketKey:id,values:[2,4]}]},labels);
 assert.equal(p.option.xAxis.type,'value');assert.equal(p.option.yAxis.type,'value');assert.deepEqual(p.option.series[0].data[0].value,[2,4]);assert.equal(p.option.tooltip.renderMode,'richText');
});
test('heatmap and boxplot consume server cells and summaries without client aggregation',()=>{
 const heat=galleryChartPlot({...base,kind:'heatmap'},labels);assert.deepEqual(heat.option.series[0].data,[[0,0,0]]);
 const box=galleryChartPlot({...base,kind:'boxplot',groups:[{bucketKey:id,count:8,box:[1,2,3,4,5],outliers:[9]}]},labels);
 assert.deepEqual(box.option.series[0].data[0].value,[1,2,3,4,5]);assert.match(box.option.series[0].data[0].name,/8 values/);assert.deepEqual(box.option.series[1].data,[[0,9]]);
});
test('empty or unavailable projections never create an invented chart',()=>{
 assert.equal(galleryChartPlot({...base,status:'unavailable'},labels),null);assert.equal(galleryChartPlot({...base,groups:[]},labels),null);
});

test('gallery legend uses the roster comparator and the scatter labels fit inside their axes',()=>{
 const data={...base,kind:'scatter',series:[...base.series,{seriesId:'b',unit:'min'}],groups:[{athleteId:'z',bucketKey:id,values:[1,2]},{athleteId:'a',bucketKey:id,values:[3,4]}]};
 const plot=galleryChartPlot(data,{...labels,athleteLabel:key=>key==='z'?'Zora':'Ana'});assert.deepEqual(plot.option.series.map(s=>s.name),['Ana','Zora']);assert.equal(plot.option.xAxis.nameLocation,'middle');assert.equal(plot.option.yAxis.nameLocation,'middle');
});

test('legend interaction follows the stored setting and carries only a local generation counter',()=>{
 const plot=configureDashboardPlot(galleryChartPlot(base,labels),{chartInteractions:{legend:{toggle:false}},groupBy:'day',interactionGeneration:7,period:{dateFrom:'2026-11-01',dateTo:'2026-11-02'}});
 assert.equal(plot.option.legend.selectedMode,false);assert.equal(plot.interactionGeneration,7);assert.doesNotMatch(JSON.stringify(plot),/boundContext|fingerprint/);
});