import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildMetricStack} from '../../backend/src/dashboardPages/metricStack.js';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,interactiveChartPresentation,chartPresentation} from '../training-load-chart-composer.js';
import {bindDashboardChartInteractions,chartPointText,clearDashboardChartStates} from '../training-load-chart-interactions.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,period={dateFrom:'2026-10-06',dateTo:'2026-10-08',timeZone:'Europe/Belgrade'};
const row=(value,extra={})=>({athleteId:id(1),bucketKey:'2026-10-06',value,unit:'m',...extra});
function fixture(arrays=[[row(0),row(4,{bucketKey:'2026-10-08'})],[row(3),row(6,{bucketKey:'2026-10-08'})]]){
 const definition={schemaVersion:1,semantics:'non-overlapping-additive',unit:'m',components:arrays.map((_,i)=>id(20+i))},presentation=interactiveChartPresentation('day','stacked',definition).value;
 const widget={id:id(3),widget_type:'bar_chart',group_by:'day',presentation_config:presentation,series:arrays.map((_,i)=>({id:id(10+i),metric_definition_id:id(20+i),axis:'primary',source_policy:'manual',data_scope_level:'session',analytical_aggregation:'sum',aggregation_role_policy:'standalone_only',coverage_policy:'complete_only'}))};
 const result={widgetId:widget.id,series:arrays.map((rows,i)=>({seriesId:widget.series[i].id,status:'ok',data:{current:rows}}))},queryId=id(5);
 const metricStack=buildMetricStack({widget,result,period,queryId}),model=buildDashboardWidgetDisplayModel(widget,result,{period}),options={presentation,metricStack,queryId,resolvedPeriod:period,contextId:'page-a',athletes:[{id:id(1),name:'Ana'}]};
 return {model,options,widget,result,compose:()=>composeDashboardCharts(model,s=>s.metric_definition_id===id(20)?'Component A':'Component B',()=>'',options)};
}
test('Stacked plots use server-confirmed components and total, preserving raw values, zero and dense gaps',()=>{
 const f=fixture(),before=structuredClone({model:f.model,options:f.options}),r=f.compose();assert.equal(r.status,'ready');const plot=r.plots[0];
 assert.deepEqual(plot.option.series.map(s=>[s.type,s.stack]),[['bar','declared-components'],['bar','declared-components']]);assert.deepEqual(plot.option.series[0].data,[{value:0},null,{value:4}]);assert.deepEqual(plot.option.series[1].data,[{value:3},null,{value:6}]);
 assert.equal(plot.rowsBySeries[1][2].rowIndex,1);assert.match(chartPointText(plot.rowsBySeries[1][2],1),/Original total \(all components\): 10 m/);assert.deepEqual({model:f.model,options:f.options},before);
 f.model.series[0].definition.color='#ab12ef';assert.equal(f.compose().plots[0].option.series[0].itemStyle.color,'#ab12ef');
 f.model.series[0].definition.color='url(https://example.invalid)';assert.notEqual(f.compose().plots[0].option.series[0].itemStyle.color,f.model.series[0].definition.color);
});
test('no partial-height buckets: missing/conflict/duplicate component leaves every series blank',()=>{
 for(const arrays of [[[row(2),row(4,{bucketKey:'2026-10-07'})],[row(3)]],[[row(2),row(null,{bucketKey:'2026-10-07',conflict:true})],[row(3),row(4,{bucketKey:'2026-10-07'})]],[[row(2),row(5,{bucketKey:'2026-10-07'}),row(6,{bucketKey:'2026-10-07'})],[row(3),row(4,{bucketKey:'2026-10-07'})]]]){
  const r=fixture(arrays).compose();assert.equal(r.status,'ready');assert.ok(r.plots[0].option.series.every(s=>s.data[1]===null));assert.match(r.plots[0].warnings.join(' '),/omitted in full/);
 }
});
test('missing/stale/tampered proof, changed metric declaration or incompatible policies never fall back to a fake stack',()=>{
 for(const change of [f=>delete f.options.metricStack,f=>f.options.metricStack.queryId=id(80),f=>f.options.metricStack.resolvedPeriod={...period,dateTo:'2026-10-07'},f=>f.options.metricStack.definition.unit='s',f=>f.options.metricStack.bindings[0].sourcePolicy='api_import',f=>f.options.metricStack.buckets[0].total=999,f=>f.options.metricStack.buckets[0].components[1].rowIndex=1,f=>f.options.metricStack.buckets[0].components[0].value=9,f=>f.options.metricStack.buckets[0].components[0].source.policy='api_import',f=>f.model.series[0].definition.analytical_aggregation='avg',f=>f.model.series[0].definition.metric_definition_id=id(80),f=>f.options.metricStack.buckets.push(structuredClone(f.options.metricStack.buckets[0]))]){
  const f=fixture();change(f);assert.deepEqual(f.compose(),{status:'stackProofRequired',plots:[]});
 }
});
test('author-declared definition is strict, named component set stays distinct from generic chart metadata',()=>{
 const f=fixture();assert.equal(chartPresentation(f.options.presentation).mode,'enhanced');
 for(const value of [{...f.options.presentation,chartVariant:'bar_chart'},{...f.options.presentation,stackDefinition:{...f.options.presentation.stackDefinition,components:[id(1),id(1)]}},{...f.options.presentation,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}}])assert.equal(chartPresentation(value).mode,'unsupported');
 assert.equal(fixture([[],[]]).compose().status,'stackNoData');
});
test('legend hiding is explicit about partial heights; reset restores every component and exact point locator',()=>{
 clearDashboardChartStates();const plot=fixture().compose().plots[0],window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;
 const host=window.document.querySelector('main'),listeners=new Map(),release=bindDashboardChartInteractions(host,{on:(name,fn)=>listeners.set(name,fn),off:name=>listeners.delete(name),setOption:()=>{},dispatchAction:()=>{}},plot,window);
 listeners.get('legendselectchanged')({selected:{[plot.option.series[0].name]:false}});assert.match(host.querySelector('.tl-chart-interaction-status').textContent,/not the complete total/);
 const select=host.querySelector('[aria-label="Point preview"]');select.value='1:2';select.dispatchEvent(new window.Event('change'));assert.equal(JSON.parse(host.querySelector('pre').textContent).value,6);
 [...host.querySelectorAll('button')].find(b=>b.textContent==='Reset view').click();assert.doesNotMatch(host.querySelector('.tl-chart-interaction-status').textContent,/not the complete total/);release();assert.equal(listeners.size,0);window.close();
});
