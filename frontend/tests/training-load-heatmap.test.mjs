import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,interactiveChartPresentation,chartPresentation,chartZoomPeriod} from '../training-load-chart-composer.js';
import {bindDashboardChartInteractions,chartPointText,clearDashboardChartStates} from '../training-load-chart-interactions.js';
import {renderDashboardChartPlots} from '../training-load-analysis-echarts-options.js';
import {registerDashboardChartElement} from '../training-load-analysis-echarts.js';

const period={dateFrom:'2026-10-06',dateTo:'2026-10-08'};
const presentation=interactiveChartPresentation('day','heatmap').value;
const row=(athleteId,bucketKey,value,extra={})=>({athleteId,bucketKey,value,unit:'m',...extra});
function fixture(rows,{groupBy='day',range=period,sidecar=presentation}={}){
 const widget={id:'w',widget_type:'bar_chart',group_by:groupBy,series:[{id:'s',metric_definition_id:'distance',axis:'primary',source_policy:'all_with_conflicts'}]};
 const model=buildDashboardWidgetDisplayModel(widget,{widgetId:'w',series:[{seriesId:'s',status:'ok',data:{current:rows}}]},{period:range});
 const options={presentation:sidecar,resolvedPeriod:range,queryId:'q',contextId:'page-a',athletes:[{id:'a',name:'Ana'},{id:'b',name:'Bojan'}]};
 const compose=()=>composeDashboardCharts(model,()=> 'Distance',()=>'',options);
 return {model,compose,options};
}
test('heatmap aligns athlete/date cells, preserves exact values and raw identity without mutation',()=>{
 const {model,compose}=fixture([row('b','2026-10-08',1234.56789),row('a','2026-10-06',0),row('a','2026-10-08',-5)]),before=structuredClone(model);
 const output=compose(),plot=output.plots[0];assert.equal(output.status,'ready');assert.equal(output.plots.length,1);
 assert.deepEqual(plot.option.xAxis.data,['2026-10-06','2026-10-07','2026-10-08']);assert.deepEqual(plot.option.yAxis.data,['Ana','Bojan']);
 assert.deepEqual(plot.option.series[0].data.map(d=>d.value),[[0,0,0],[1,0,null],[2,0,-5],[0,1,null],[1,1,null],[2,1,1234.56789]]);
 assert.equal(plot.rowsBySeries[0][5].rowIndex,0);assert.equal(plot.rowsBySeries[0][5].identity.athleteId,'b');assert.equal(plot.rowsBySeries[0][5].queryId,'q');
 assert.match(chartPointText(plot.rowsBySeries[0][5],1),/1234\.56789 m/);assert.deepEqual(model,before);
 assert.equal(plot.option.visualMap.min,-5);assert.equal(plot.option.visualMap.max,1234.56789);assert.equal(plot.option.visualMap.dimension,2);assert.equal(plot.option.visualMap.calculable,false);
 assert.match(plot.warnings[0],/not thresholds/);assert.deepEqual(chartZoomPeriod(plot,0,1),{dateFrom:'2026-10-06',dateTo:'2026-10-07'});
});
test('missing/conflicted/duplicate cells stay blank and cannot affect color scale',()=>{
 const plot=fixture([row('a','2026-10-06',5),row('a','2026-10-07',999,{conflict:true}),row('a','2026-10-08',500,{sourceConnectionId:'one'}),row('a','2026-10-08',600,{sourceConnectionId:'two'})]).compose().plots[0];
 assert.deepEqual(plot.option.series[0].data.map(d=>d.value[2]),[5,null,null]);assert.equal(plot.rowsBySeries[0][2].rows.length,2);
 assert.equal(plot.option.visualMap.min,5);assert.equal(plot.option.visualMap.max,5);
 assert.equal(fixture([row('a','2026-10-06',null)]).compose().status,'noNumericData');
});
test('rows with different units, invalid dates, unsupported values or too many athletes refuse rather than truncate',()=>{
 for(const [rows,status]of [[[row('a','2026-10-06',1),row('b','2026-10-08',2,{unit:'km'})],'ambiguousAxisUnit'],[[row('a','2026-10-05',1)],'invalidBuckets'],[[row('a','2026-10-06','text')],'notReady'],[Array.from({length:21},(_,i)=>row(String(i),'2026-10-06',i)),'requiresChoice']])assert.deepEqual(fixture(rows).compose(),{status,plots:[]});
 for(const mutation of [m=>m.series.push(structuredClone(m.series[0])),m=>m.groupBy='athlete',m=>m.series[0].status='unresolved',m=>m.series[0].comparisonRange=period]){const {model,compose}=fixture([row('a','2026-10-06',1)]);mutation(model);assert.notEqual(compose().status,'ready');}
});
test('week buckets, whole-group row and colliding athlete labels retain distinct cell coordinates',()=>{
 const output=fixture([row(null,'2026-10-05',9),row('a','2026-10-05',4),row('b','2026-10-05',7)],{groupBy:'week',sidecar:interactiveChartPresentation('week','heatmap').value}).compose();
 assert.equal(output.status,'ready');assert.deepEqual(output.plots[0].buckets,['2026-10-05']);assert.equal(output.plots[0].option.yAxis.data.length,3);
 const f=fixture([row('a','2026-10-06',1),row('b','2026-10-06',2)]);f.options.athletes=[{id:'a',name:'Same'},{id:'b',name:'Same'}];assert.equal(new Set(f.compose().plots[0].option.yAxis.data).size,2);
 assert.equal(fixture(Array.from({length:20},(_,i)=>row(String(i),'2026-10-06',i))).compose().plots[0].renderHeight,730);
});
test('heatmap presentation requires matrix pairing and automatic category axes, preserving opaque future content',()=>{
 assert.equal(chartPresentation(presentation).mode,'enhanced');
 for(const invalid of [{...presentation,chartComposition:'athletes-v1'},{...presentation,chartVariant:'area'},{...presentation,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}},{...presentation,schemaVersion:99}])assert.equal(chartPresentation(invalid).mode,'unsupported');
 const f=fixture([row('a','2026-10-06',1)]);f.model.groupBy='athlete';assert.match(renderDashboardChartPlots(f.model,()=>'',()=>'',f.options),/one numeric metric grouped by day or week/);
});
test('heatmap controls map dataIndex to original row, local zoom/reset leave category axes intact',()=>{
 clearDashboardChartStates();const plot=fixture([row('b','2026-10-08',9),row('a','2026-10-06',4)]).compose().plots[0];
 const window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;
 const host=window.document.querySelector('main'),options=[],listeners=new Map();
 const release=bindDashboardChartInteractions(host,{on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),setOption:o=>options.push(o),dispatchAction:()=>{}},plot,window);
 const select=host.querySelector('[aria-label="Point preview"]');select.value='0:5';select.dispatchEvent(new window.Event('change'));
 const detail=JSON.parse(host.querySelector('pre').textContent);assert.equal(detail.rowIndex,0);assert.equal(detail.identity.athleteId,'b');assert.equal(detail.value,9);
 [...host.querySelectorAll('button')].find(b=>b.textContent==='Reset view').click();assert.equal(options.some(o=>o.yAxis),false);assert.match(host.querySelector('.tl-chart-interaction-status').textContent,/not thresholds/);release();assert.equal(listeners.size,0);window.close();
});
test('mounted heatmap formats the value dimension and exact tooltip, not the coordinate tuple',async()=>{
 const plot=fixture([row('a','2026-10-06',12.3456)]).compose().plots[0],window=new JSDOM('<main></main>').window;
 let drawn;registerDashboardChartElement(window,async()=>({init:()=>({setOption:o=>{if(o.series)drawn=o;},on:()=>{},off:()=>{},dispatchAction:()=>{},dispose:()=>{}})}));
 const host=window.document.createElement('optimove-dashboard-chart');host.setAttribute('data-chart',JSON.stringify(plot));host.innerHTML='<div class="tl-analysis-echarts"></div><p class="tl-analysis-chart-failure" hidden></p>';
 Object.defineProperties(host.firstElementChild,{clientWidth:{value:400},clientHeight:{value:320}});window.document.querySelector('main').append(host);await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(drawn.series[0].label.formatter({value:[0,0,12.3456]}),'12.3');assert.equal(drawn.series[0].label.formatter({value:[0,0,null]}),'');assert.match(drawn.tooltip.formatter({seriesIndex:0,dataIndex:0}),/12\.3456 m/);host.remove();window.close();
});
