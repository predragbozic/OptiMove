import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {boxStatistics} from '../training-load-boxplot-composer.js';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,interactiveChartPresentation,chartPresentation} from '../training-load-chart-composer.js';
import {chartPointText,bindDashboardChartInteractions} from '../training-load-chart-interactions.js';
import {renderDashboardChartPlots} from '../training-load-analysis-echarts-options.js';
import * as echarts from '../vendor/echarts/echarts-6.1.0.min.mjs';
const period={dateFrom:'2026-10-06',dateTo:'2026-10-08'},presentation=interactiveChartPresentation('day','boxplot').value;
const row=(athleteId,value,bucketKey='2026-10-06',extra={})=>({athleteId,value,bucketKey,unit:'m',...extra});
function fixture(rows){const widget={id:'w',widget_type:'bar_chart',group_by:'day',series:[{id:'s',metric_definition_id:'distance',axis:'primary',source_policy:'manual',analytical_aggregation:'sum'}]};const model=buildDashboardWidgetDisplayModel(widget,{widgetId:'w',series:[{seriesId:'s',status:'ok',data:{current:rows}}]},{period});const options={presentation,resolvedPeriod:period,queryId:'q'};return {model,options,compose:()=>composeDashboardCharts(model,()=> 'Distance',()=>'',options)};}
const sample=values=>values.map((v,i)=>row(String(i),v));
test('bundled ECharts really renders a boxplot and retains missing buckets as invalid data, never zero boxes',()=>{
 const plot=fixture(sample([0,1,2,3,4,100])).compose().plots[0],chart=echarts.init(null,null,{renderer:'svg',ssr:true,width:900,height:400});
 try{chart.setOption(plot.option);const data=chart.getModel().getSeriesByIndex(0).getData();assert.equal(data.hasValue(0),true);assert.equal(data.hasValue(1),false);assert.equal(data.hasValue(2),false);const svg=chart.renderToSVGString();assert.match(svg,/<svg/);assert.ok(svg.length>3000);assert.doesNotMatch(svg,/NaN|Infinity/);}finally{chart.dispose();}
});
test('type7 quartiles, Tukey observed whiskers, equal/negative/zero values and minimum sample',()=>{
 assert.deepEqual(boxStatistics([0,1,2,3,4,100]),{count:6,minimum:0,q1:1.25,median:2.5,q3:3.75,maximum:100,low:0,high:4,lowerFence:-2.5,upperFence:7.5});
 assert.equal(boxStatistics([2,2,2,2,2]).low,2);assert.equal(boxStatistics([-4,-3,-2,-1,0]).median,-2);
 assert.equal(boxStatistics([1,2,3,4]),null);assert.equal(boxStatistics([1,2,3,4,Infinity]),null);assert.equal(boxStatistics([-1e308,-1e308,0,1e308,1e308]),null);
});
test('dense time buckets, original contributor/outlier locators and immutability',()=>{
 const f=fixture(sample([0,1,2,3,4,100])),before=structuredClone(f.model),out=f.compose(),p=out.plots[0];assert.equal(out.status,'ready');
 assert.deepEqual(p.option.series[0].data,[{value:[0,1.25,2.5,3.75,4]},{value:[null,null,null,null,null]},{value:[null,null,null,null,null]}]);assert.deepEqual(p.option.series[1].data,[{value:[0,100]}]);
 assert.equal(p.rowsBySeries[1][0].rowIndex,5);assert.equal(p.rowsBySeries[0][0].contributingRows.length,6);assert.equal(p.rowsBySeries[0][0].rowIndex,undefined);
 assert.match(chartPointText(p.rowsBySeries[0][0],1),/Across 6 returned athlete values[\s\S]*Median: 2.5/);assert.match(p.caption,/sum per athlete\/day/);assert.deepEqual(f.model,before);
});
test('duplicates across source IDs, conflicts, missing values and sample counts exclude athletes, never weight rawCount',()=>{
 const rows=sample([1,2,3,4,5,6,7]);rows[0].rawCount=1000;rows.push(row('6',8));rows[5].conflict=true;rows.push(row('missing',null));
 const p=fixture(rows).compose().plots[0].rowsBySeries[0][0];assert.equal(p.statistics.count,5);assert.equal(p.statistics.median,3);assert.equal(p.excluded,3);
 const f=fixture(sample([1,2,3,4,5]));f.model.series[0].current.push(structuredClone(f.model.series[0].current[4]));assert.equal(f.compose().status,'boxplotInsufficientData');
});
test('mixed units/source, group rows, out-of-range, too many athletes, comparisons and unknown/fixed sidecars refuse',()=>{
 for(const [mutate,status]of [[r=>r[0].unit='km','ambiguousAxisUnit'],[r=>r[0].sourceConnectionId='other','boxplotMixedSources'],[r=>r[0].athleteId=null,'boxplotIndividualRequired'],[r=>r[0].bucketKey='2026-10-01','invalidBuckets']]){const rows=sample([1,2,3,4,5]);mutate(rows);assert.equal(fixture(rows).compose().status,status);}
 assert.equal(fixture(sample(Array.from({length:21},(_,i)=>i))).compose().status,'requiresChoice');
 const f=fixture(sample([1,2,3,4,5]));f.model.series[0].comparisonRange=period;assert.equal(f.compose().status,'boxplotConfigurationRequired');
 for(const invalid of [{...presentation,chartComposition:'athletes-v1'},{...presentation,chartVariant:'heatmap'},{...presentation,schemaVersion:99},{...presentation,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}}])assert.equal(chartPresentation(invalid).mode,'unsupported');
 assert.match(renderDashboardChartPlots(fixture(sample([1,2,3,4])).model,()=>'',()=>'',{presentation}),/at least 5/);
});
test('summary click and keyboard details expose derived statistics and every original contributor; outlier maps exact raw row',()=>{
 const p=fixture(sample([0,1,2,3,4,100])).compose().plots[0],window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window,host=window.document.querySelector('main'),events=new Map();
 const release=bindDashboardChartInteractions(host,{on:(n,f)=>events.set(n,f),off:n=>events.delete(n),setOption:()=>{},dispatchAction:()=>{}},p,window);
 events.get('click')({componentType:'series',seriesIndex:0,dataIndex:0});let detail=JSON.parse(host.querySelector('pre').textContent);assert.equal(detail.derivedDistribution,true);assert.equal(detail.contributingRows[5].rowIndex,5);assert.equal(detail.statistics.median,2.5);
 const select=host.querySelector('[aria-label="Point preview"]');select.value='1:0';select.dispatchEvent(new window.Event('change'));detail=JSON.parse(host.querySelector('pre').textContent);assert.equal(detail.rowIndex,5);assert.equal(detail.value,100);release();window.close();
});
