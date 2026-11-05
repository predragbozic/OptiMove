import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,chartPresentation,interactiveChartPresentation,chartZoomPeriod} from '../training-load-chart-composer.js';
import {chartPointText,bindDashboardChartInteractions,clearDashboardChartStates} from '../training-load-chart-interactions.js';
import {JSDOM} from 'jsdom';

const period={dateFrom:'2026-10-06',dateTo:'2026-10-08'};
const presentation=interactiveChartPresentation('day','combined').value;
const row=(athleteId,bucketKey,value,unit='m',extra={})=>({athleteId,bucketKey,value,unit,...extra});
function fixture(first=[row('a','2026-10-06',0),row('a','2026-10-08',1234.56789)],second=[row('a','2026-10-06',67.123456,'min')]){
 const widget={id:'w',widget_type:'line_chart',group_by:'day',series:[{id:'distance',metric_definition_id:'m1',axis:'primary',source_policy:'all_with_conflicts'},{id:'duration',metric_definition_id:'m2',axis:'secondary',source_policy:'pinned',source_connection_id:'source-two'}]};
 const model=buildDashboardWidgetDisplayModel(widget,{widgetId:'w',series:[{seriesId:'distance',status:'ok',data:{current:first}},{seriesId:'duration',status:'ok',data:{current:second}}]},{period});
 const compose=()=>composeDashboardCharts(model,d=>d.id==='distance'?'Distance':'Duration',()=>'',{presentation,resolvedPeriod:period,queryId:'q',contextId:'page-a',athletes:[{id:'a',name:'Ana'},{id:'b',name:'Bojan'}]});
 return {model,compose};
}
test('combined keeps exact independent metric values, units, gaps, provenance and two axis bindings',()=>{
 const {model,compose}=fixture();const original=structuredClone(model),output=compose(),plot=output.plots[0];
 assert.equal(output.status,'ready');assert.equal(output.plots.length,1);
 assert.deepEqual(plot.option.series.map(s=>[s.type,s.yAxisIndex]),[['bar',0],['line',1]]);
 assert.deepEqual(plot.option.yAxis.map(a=>[a.position,a.name]),[['left','m'],['right','min']]);
 assert.deepEqual(plot.option.series[0].data,[{value:0},null,{value:1234.56789}]);
 assert.deepEqual(plot.option.series[1].data,[{value:67.123456},null,null]);
 assert.equal(plot.rowsBySeries[1][0].identity.source.configuredConnectionId,'source-two');
 assert.equal(plot.rowsBySeries[1][0].identity.seriesId,'duration');assert.equal(plot.rowsBySeries[1][0].queryId,'q');
 assert.match(chartPointText(plot.rowsBySeries[1][0],1),/67\.123456 min/);
 assert.deepEqual(chartZoomPeriod(plot,0,1),{dateFrom:'2026-10-06',dateTo:'2026-10-07'});
 assert.deepEqual(model,original);
});
test('athletes and whole-group observations never share one combined plot',()=>{
 const {compose}=fixture([row('a','2026-10-06',5),row('b','2026-10-06',6),row(null,'2026-10-06',11)], [row('b','2026-10-06',70,'min')]);
 const output=compose();assert.equal(output.plots.length,3);
 for(const plot of output.plots){const ids=new Set(plot.rowsBySeries.flat().filter(Boolean).map(p=>p.identity.athleteId));assert.equal(ids.size,1);}
 const ana=output.plots.find(p=>p.caption.startsWith('Ana'));assert.deepEqual(ana.option.series[1].data,[null,null,null]);
});
test('duplicates across reported sources retain all evidence and make a gap',()=>{
 const {compose}=fixture([row('a','2026-10-06',5,'m',{sourceConnectionId:'one'}),row('a','2026-10-06',9,'m',{sourceConnectionId:'two'})]);
 const plot=compose().plots[0];assert.equal(plot.option.series[0].data[0],null);assert.equal(plot.rowsBySeries[0][0].rows.length,2);
});
test('mixed units within one metric, invalid buckets and nonnumeric values refuse combined rendering',()=>{
 assert.equal(fixture([row('a','2026-10-06',1),row('a','2026-10-08',2,'km')]).compose().status,'ambiguousAxisUnit');
 assert.equal(fixture([row('a','2026-10-05',1)]).compose().status,'invalidBuckets');
 assert.equal(fixture([row('a','2026-10-06','text')]).compose().status,'notReady');
});
test('incomplete, unresolved, duplicate axes, comparisons and unsupported groups never silently lose a series',()=>{
 for(const change of [m=>m.series.pop(),m=>m.series[1].definition.axis='primary',m=>m.series[1].status='unresolved',m=>m.series[1].definition.comparison_period={kind:'previous'},m=>m.series[1].comparisonRange=period,m=>m.groupBy='athlete']){
  const {model,compose}=fixture();change(model);const result=compose();assert.notEqual(result.status,'ready');assert.deepEqual(result.plots,[]);
 }
});
test('combined bounds athletes at twenty and only permits paired composition with automatic axes',()=>{
 assert.equal(fixture(Array.from({length:21},(_,i)=>row(String(i),'2026-10-06',i)),[]).compose().status,'requiresChoice');
 assert.equal(chartPresentation(presentation).mode,'enhanced');
 for(const invalid of [{...presentation,chartComposition:'athletes-v1'},{schemaVersion:1,chartComposition:'metrics-v1'}, {...presentation,chartInteractions:{yAxis:{mode:'fixed',min:0,max:100}}}])assert.equal(chartPresentation(invalid).mode,'unsupported');
});
test('combined controls identify both metrics and select the exact second-axis row without overwriting axes on reset',()=>{
 clearDashboardChartStates();const plot=fixture().compose().plots[0];
 const window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;
 const host=window.document.querySelector('main'),options=[],listeners=new Map();
 const chart={on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),dispatchAction:()=>{},setOption:option=>options.push(option)};
 const release=bindDashboardChartInteractions(host,chart,plot,window);
 const select=host.querySelector('select[aria-label="Point preview"]');assert.match(select.querySelector('option[value="1:0"]').textContent,/Duration.*67\.123456 min/);
 select.value='1:0';select.dispatchEvent(new window.Event('change'));assert.equal(JSON.parse(host.querySelector('pre').textContent).identity.seriesId,'duration');
 const buttons=[...host.querySelectorAll('button')];assert.equal(buttons.some(b=>b.textContent==='Automatic value range'),false);
 buttons.find(b=>b.textContent==='Reset view').click();assert.equal(options.some(option=>Object.hasOwn(option,'yAxis')),false);
 assert.equal(host.querySelector('select[aria-label="Zoom from"]').value,'0');release();assert.equal(listeners.size,0);window.close();
});
