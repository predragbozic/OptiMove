import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildMetricPairs} from '../../backend/src/dashboardPages/metricPairs.js';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,interactiveChartPresentation,chartPresentation} from '../training-load-chart-composer.js';
import {chartPointText,bindDashboardChartInteractions,clearDashboardChartStates} from '../training-load-chart-interactions.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,period={dateFrom:'2026-10-06',dateTo:'2026-10-08',timeZone:'Europe/Belgrade'};
const presentation=interactiveChartPresentation('day','scatter').value;
const row=(value,extra={})=>({athleteId:id(1),bucketKey:'2026-10-06',unit:'m',value,...extra});
function fixture(x=[row(0),row(-12.3456789,{bucketKey:'2026-10-08'})],y=[row(67.123456,{unit:'min'}),row(88,{bucketKey:'2026-10-08',unit:'min'})]){
 const widget={id:id(3),widget_type:'line_chart',group_by:'day',series:[{id:id(4),metric_definition_id:id(10),axis:'primary',source_policy:'manual'},{id:id(5),built_in_series_key:'duration_minutes',axis:'secondary',source_policy:'not_applicable'}]};
 const result={widgetId:widget.id,series:[{seriesId:id(4),status:'ok',data:{current:x}},{seriesId:id(5),status:'ok',data:{current:y}}]},queryId=id(6);
 const metricPairs=buildMetricPairs({widget,result,request:{schemaVersion:1,widgetId:widget.id,xSeriesId:id(4),ySeriesId:id(5)},period,queryId});
 const model=buildDashboardWidgetDisplayModel(widget,result,{period}),options={presentation,resolvedPeriod:period,queryId,contextId:'page-a',metricPairs,athletes:[{id:id(1),name:'Ana'},{id:id(2),name:'Bojan'}]};
 return {model,options,result,compose:()=>composeDashboardCharts(model,s=>s.id===id(4)?'Distance':'Duration',()=>'',options)};
}
test('Scatter uses exact server-confirmed X/Y coordinates, distinct units and source identities without mutation',()=>{
 const f=fixture(),before=structuredClone({model:f.model,options:f.options}),output=f.compose();assert.equal(output.status,'ready');const plot=output.plots[0];
 assert.equal(plot.option.series[0].type,'scatter');assert.deepEqual(plot.option.series[0].data.map(d=>d.value),[[0,67.123456],[-12.3456789,88]]);
 assert.equal(plot.option.xAxis.type,'value');assert.equal(plot.option.yAxis.type,'value');assert.match(plot.option.xAxis.name,/Distance.*m/);assert.match(plot.option.yAxis.name,/Duration.*min/);assert.equal(plot.option.dataZoom,undefined);
 assert.equal(plot.rowsBySeries[0][1].rowIndex,1);assert.equal(plot.rowsBySeries[0][1].pairedPoint.identity.seriesId,id(5));assert.match(chartPointText(plot.rowsBySeries[0][0],1),/X:[\s\S]*0 m[\s\S]*Y:[\s\S]*67\.123456 min/);
 assert.deepEqual({model:f.model,options:f.options},before);
});
test('no frontend joining: missing/stale/cross-context or altered server proof refuses the whole chart',()=>{
 for(const change of [f=>delete f.options.metricPairs,f=>f.options.metricPairs.queryId=id(80),f=>f.options.metricPairs.schemaVersion=99,f=>f.options.metricPairs.widgetId=id(9),f=>f.options.metricPairs.xSeriesId=id(5),f=>f.options.metricPairs.resolvedPeriod={...period,dateTo:'2026-10-07'},f=>f.options.metricPairs.bindings.x.metricDefinitionId=id(80),f=>f.options.metricPairs.pairs[0].x.rowIndex=999,f=>f.options.metricPairs.pairs[0].x.value=1,f=>f.options.metricPairs.pairs[0].y.unit='s',f=>f.options.metricPairs.pairs[0].x.source.policy='api',f=>f.options.metricPairs.pairs.push(structuredClone(f.options.metricPairs.pairs[0])),f=>f.options.metricPairs.pairs[0].athleteId=id(2),f=>f.options.metricPairs.pairs[0].bucketKey='2026-10-07']){
  const f=fixture();change(f);assert.deepEqual(f.compose(),{status:'scatterPairsRequired',plots:[]});
 }
});
test('partial pair sets expose omissions and zero remains a valid point; unmatched rows are never synthesized',()=>{
 const f=fixture([row(0),row(10,{bucketKey:'2026-10-07'})],[row(3,{unit:'min'})]),output=f.compose();assert.equal(output.status,'ready');assert.deepEqual(output.plots[0].option.series[0].data,[{value:[0,3]}]);assert.match(output.plots[0].warnings[0],/1 unpaired or problem/);
 assert.equal(fixture([row(1)],[]).compose().status,'scatterNoPairs');
});
test('athletes have separate selectable series and collisions get unique labels',()=>{
 const f=fixture([row(1),row(2,{athleteId:id(2)})],[row(3),row(4,{athleteId:id(2)})]);f.options.athletes=[{id:id(1),name:'Same'},{id:id(2),name:'Same'}];const plot=f.compose().plots[0];assert.equal(plot.option.series.length,2);assert.equal(new Set(plot.option.series.map(s=>s.name)).size,2);assert.deepEqual(plot.rowsBySeries.map(rows=>rows[0].identity.athleteId),[id(1),id(2)]);
});
test('Scatter presentation is paired and automatic, with no temporal zoom; empty interactions keep defaults',()=>{
 assert.equal(chartPresentation({schemaVersion:1,chartVariant:'scatter',chartComposition:'pairs-v1',chartInteractions:{}}).mode,'enhanced');
 for(const invalid of [{...presentation,chartComposition:'metrics-v1'},{...presentation,chartInteractions:{zoom:{mode:'local',applyPeriodAction:false}}},{...presentation,chartInteractions:{yAxis:{mode:'fixed',min:0,max:1}}}])assert.equal(chartPresentation(invalid).mode,'unsupported');
 const f=fixture();f.model.series[0].definition.axis='secondary';assert.equal(f.compose().status,'scatterPairsRequired');
});
test('native point details show both raw observations and Reset preserves both numeric axes',()=>{
 clearDashboardChartStates();const plot=fixture().compose().plots[0],window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;
 const host=window.document.querySelector('main'),options=[],listeners=new Map(),release=bindDashboardChartInteractions(host,{on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),dispatchAction:()=>{},setOption:o=>options.push(o)},plot,window);
 const select=host.querySelector('[aria-label="Point preview"]');assert.match(select.querySelector('option[value="0:1"]').textContent,/-12\.3456789 m.*Duration: 88 min/);select.value='0:1';select.dispatchEvent(new window.Event('change'));
 const detail=JSON.parse(host.querySelector('pre').textContent);assert.equal(detail.value,-12.3456789);assert.equal(detail.y.value,88);assert.equal(detail.y.identity.seriesId,id(5));
 assert.equal(host.querySelector('[aria-label="Zoom from"]'),null);[...host.querySelectorAll('button')].find(b=>b.textContent==='Reset view').click();assert.equal(options.some(o=>o.yAxis || o.xAxis),false);release();assert.equal(listeners.size,0);window.close();
});
