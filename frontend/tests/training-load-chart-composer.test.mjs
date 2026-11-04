import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildDashboardWidgetDisplayModel} from '../training-load-analysis-display-model.js';
import {composeDashboardCharts,chartZoomPeriod,chartPresentation,chartIdentityKey} from '../training-load-chart-composer.js';
import {bindDashboardChartInteractions,chartPointText,clearDashboardChartStates} from '../training-load-chart-interactions.js';

const period={dateFrom:'2026-10-06',dateTo:'2026-10-12'};
const presentation={schemaVersion:1,chartComposition:'athletes-v1',chartInteractions:{tooltip:{mode:'exact'},legend:{toggle:true},zoom:{mode:'local',applyPeriodAction:true},pointSelection:{mode:'details'},yAxis:{mode:'auto'}}};
const row=(athleteId,bucketKey,value,extra={})=>({athleteId,bucketKey,value,unit:'m',...extra});
function fixture(rows,{groupBy='day',sidecar=presentation,range=period,queryId='query-1',extraSeries=[]}={}){
  const widget={id:'w',title:'Distanca',widget_type:'line_chart',group_by:groupBy,series:[{id:'s',metric_definition_id:'metric',source_policy:'all_with_conflicts'},...extraSeries.map(entry=>entry.definition)]};
  const result={widgetId:'w',series:[{seriesId:'s',status:'ok',data:{current:rows}},...extraSeries.map(entry=>entry.result)]};
  const model=buildDashboardWidgetDisplayModel(widget,result,{period:range});
  return {model,output:composeDashboardCharts(model,()=> 'Distanca',()=>'',{presentation:sidecar,resolvedPeriod:range,queryId,contextId:'context-1',athletes:[{id:'a',name:'Isto ime'},{id:'b',name:'Isto ime'}]})};
}

test('dva sportista dele vremenski plot, vrednosti i identitet ostaju odvojeni, bez mutacije',()=>{
  const {model,output}=fixture([row('b','2026-10-08',-2.1234567),row('a','2026-10-06',0),row('a','2026-10-08',12)]);
  const before=structuredClone(model),plot=output.plots[0];
  assert.equal(output.status,'ready');assert.equal(output.plots.length,1);assert.equal(plot.option.series.length,2);
  assert.deepEqual(plot.buckets,['2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12']);
  assert.deepEqual(plot.option.series[0].data.map(p=>p?.value??null),[0,null,12,null,null,null,null]);
  assert.equal(plot.rowsBySeries[0][1],null);assert.equal(plot.rowsBySeries[1][2].rowIndex,0);
  assert.equal(plot.rowsBySeries[1][2].identityKey,chartIdentityKey(model.series[0].current[0].identity));
  assert.notEqual(plot.option.series[0].name,plot.option.series[1].name);assert.deepEqual(model,before);
  assert.match(chartPointText(plot.rowsBySeries[1][2],1),/-2\.1234567/);
  assert.equal(plot.option.series[0].connectNulls,false);
});

test('različite stvarne jedinice, prijavljeni izvori i DB serije ostaju posebni plotovi',()=>{
  const {output}=fixture([row('a','2026-10-06',1),row('b','2026-10-06',2),row('a','2026-10-06',3,{unit:'s'}),row('a','2026-10-06',4,{sourceConnectionId:'reported'})],{extraSeries:[{definition:{id:'other',metric_definition_id:'metric2'},result:{seriesId:'other',status:'ok',data:{current:[row('a','2026-10-06',7)]}}}]});
  assert.equal(output.plots.length,4);assert.equal(output.plots[0].option.series.length,2);
});

test('athlete poređenje koristi athlete kategorije umesto zajedničkog all bucket-a',()=>{
  const {output}=fixture([row('a','all',1),row('b','all',2)],{groupBy:'athlete'});
  const plot=output.plots[0];assert.equal(plot.option.series.length,1);assert.deepEqual(plot.option.series[0].data.map(p=>p.value),[1,2]);
  assert.notEqual(plot.option.xAxis.data[0],plot.option.xAxis.data[1]);assert.equal(plot.option.dataZoom,undefined);
  assert.equal(chartZoomPeriod(plot,0,1),null);
});

test('problem i duplirani bucket ostaju praznine bez izbora prvog reda',()=>{
  const {output}=fixture([row('a','2026-10-06',1),row('a','2026-10-06',2),row('a','2026-10-07',99,{conflict:true}),row('a','2026-10-08','3')]);
  const plot=output.plots[0];assert.equal(plot.option.series[0].data[0],null);assert.equal(plot.rowsBySeries[0][0].status,'duplicate');
  assert.equal(plot.rowsBySeries[0][0].identity,undefined);assert.equal(plot.option.series[0].data[1],null);assert.equal(plot.option.series[0].data[2],null);
});

test('nedeljna gusta osa ima ponedeljak, a primenjeni period obuhvata celu kantu i preseče granice',()=>{
  const {output}=fixture([row('a','2026-10-05',4)],{groupBy:'week'});const plot=output.plots[0];
  assert.deepEqual(plot.buckets,['2026-10-05','2026-10-12']);
  assert.deepEqual(chartZoomPeriod(plot,0,0),{dateFrom:'2026-10-06',dateTo:'2026-10-11'});
  assert.deepEqual(chartZoomPeriod(plot,1,1),{dateFrom:'2026-10-12',dateTo:'2026-10-12'});
  for(const [first,last] of [[-1,0],[0,2],[1,0],[0.5,1]])assert.equal(chartZoomPeriod(plot,first,last),null);
});

test('21 sportista blokira ceo sastavljeni prikaz bez skraćivanja',()=>{
  const rows=Array.from({length:21},(_,i)=>row(String(i),'2026-10-06',i));
  assert.deepEqual(fixture(rows).output,{status:'requiresChoice',plots:[]});
});

test('period je obavezan, ograničen, a nevažeće kante nisu prećutno izgubljene',()=>{
  assert.equal(fixture([row('a','2026-10-06',1)],{range:null}).output.status,'periodRequired');
  assert.equal(fixture([row('a','2026-10-05',1)]).output.status,'invalidBuckets');
  assert.equal(fixture([row('a','2026-10-06',1)],{range:{dateFrom:'2025-01-01',dateTo:'2026-10-12'}}).output.status,'periodRequired');
});

test('legacy i nepoznat sidecar se ne unapređuju i null tehnička polja se odbijaju',()=>{
  assert.equal(chartPresentation(null).mode,'legacy');
  for(const value of [{schemaVersion:99},{...presentation,script:'evil'}, {...presentation,chartInteractions:null}, {...presentation,chartInteractions:{tooltip:null}}, {...presentation,chartInteractions:{yAxis:null}}, {...presentation,chartInteractions:{zoom:{mode:'local'}}}])assert.equal(chartPresentation(value).mode,'unsupported');
});

test('ručni Y opseg ne menja podatke i upozorava; različite jedinice ne dele isti opseg',()=>{
  const fixed={...presentation,chartInteractions:{...presentation.chartInteractions,yAxis:{mode:'fixed',min:0,max:5}}};
  const plot=fixture([row('a','2026-10-06',-20)],{sidecar:fixed}).output.plots[0];assert.equal(plot.option.series[0].data[0].value,-20);assert.equal(plot.option.yAxis.min,0);assert.equal(plot.warnings.length,1);
  assert.equal(fixture([row('a','2026-10-06',1),row('a','2026-10-06',2,{unit:'s'})],{sidecar:fixed}).output.status,'ambiguousAxisUnit');
});

function runtime(plot){
  const window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;
  const host=window.document.querySelector('main'),listeners=new Map(),actions=[],options=[];
  const chart={on:(name,fn)=>listeners.set(name,fn),off:(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);},dispatchAction:action=>actions.push(action),setOption:option=>options.push(option)};
  const release=bindDashboardChartInteractions(host,chart,plot,window);
  return {window,host,listeners,actions,options,release};
}
test('klik tačke prati sortirani row locator; placeholder ne otvara tuđi red, native izbor čita isti red',()=>{
  clearDashboardChartStates();const plot=fixture([row('b','2026-10-08',4),row('a','2026-10-06',3)]).output.plots[0];const f=runtime(plot);
  f.listeners.get('click')({componentType:'series',seriesIndex:1,dataIndex:2});
  const detail=JSON.parse(f.host.querySelector('pre').textContent);assert.equal(detail.rowIndex,0);assert.equal(detail.identity.athleteId,'b');assert.equal(detail.queryId,'query-1');
  f.host.querySelector('details').open=false;f.listeners.get('click')({componentType:'series',seriesIndex:1,dataIndex:1});assert.equal(f.host.querySelector('details').open,false);
  const select=[...f.host.querySelectorAll('select')].at(-1);select.value='0:0';select.dispatchEvent(new f.window.Event('change'));assert.equal(JSON.parse(f.host.querySelector('pre').textContent).rowIndex,1);
  f.release();assert.equal(f.listeners.size,0);f.window.close();
});

test('zoom je lokalni; eksplicitno dugme emituje jedan datum opseg, repaint čuva stanje a novi query ga resetuje',()=>{
  clearDashboardChartStates();const plot=fixture([row('a','2026-10-06',1)]).output.plots[0];let f=runtime(plot),events=[];
  f.host.addEventListener('optimove-chart-period',event=>events.push(event.detail));
  f.listeners.get('datazoom')({start:0,end:50});assert.equal(events.length,0);
  [...f.host.querySelectorAll('button')].find(b=>b.textContent==='Primeni period na dashboard').click();assert.equal(events.length,0);[...f.host.querySelectorAll('button')].find(b=>b.textContent==='Potvrdi period').click();assert.equal(events.length,1);assert.equal(events[0].dateTo,'2026-10-09');assert.equal(events[0].confirmed,true);
  f.listeners.get('legendselectchanged')({selected:{[plot.option.series[0].name]:false}});assert.match(f.host.querySelector('[role=status]')?.textContent??f.host.querySelector('.tl-chart-interaction-status').textContent,/skrivene/);
  f.release();f.window.close();f=runtime(plot);assert.equal(f.options[0].legend.selected[plot.option.series[0].name],false);assert.equal(f.host.querySelectorAll('select')[1].value,'3');f.release();f.window.close();
  const next=fixture([row('a','2026-10-06',1)],{queryId:'query-2'}).output.plots[0];f=runtime(next);assert.deepEqual(f.options[0].legend.selected,{});assert.equal(f.host.querySelectorAll('select')[1].value,'6');f.release();f.window.close();
});

test('athlete poređenje nema lažne per-athlete legend kontrole i preveliki HTML ostaje običan tekst',()=>{
  const plot=fixture([row('<img onerror=x>','all',1)],{groupBy:'athlete'}).output.plots[0];const f=runtime(plot);
  assert.equal([...f.host.querySelectorAll('button')].some(b=>b.textContent.startsWith('Prikaži/sakrij')),false);assert.equal(f.host.querySelector('img'),null);f.release();f.window.close();
});

test('bez queryId nema obnavljanja prethodnog zoom-a ili detalja sa null identitetom',()=>{
  clearDashboardChartStates();let plot=fixture([row('a','2026-10-06',1)],{queryId:null}).output.plots[0];let f=runtime(plot);
  f.listeners.get('datazoom')({start:20,end:40});assert.equal(f.listeners.has('click'),false);f.release();f.window.close();
  plot=fixture([row('a','2026-10-06',4)],{queryId:null}).output.plots[0];f=runtime(plot);assert.equal(f.host.querySelectorAll('select')[0].value,'0');assert.equal(f.host.querySelector('details').open,false);f.release();f.window.close();
});

test('Auto Y opstaje tokom repaint-a, a Reset vraća fiksne granice i odgovarajuće upozorenje',()=>{
  clearDashboardChartStates();const fixed={...presentation,chartInteractions:{...presentation.chartInteractions,yAxis:{mode:'fixed',min:0,max:5}}};const plot=fixture([row('a','2026-10-06',12)],{sidecar:fixed}).output.plots[0];let f=runtime(plot);
  [...f.host.querySelectorAll('button')].find(b=>b.textContent==='Automatski Y opseg').click();assert.deepEqual(f.options.at(-1),{yAxis:{min:null,max:null}});assert.equal(f.host.querySelector('.tl-chart-interaction-status').textContent,'');f.release();f.window.close();
  f=runtime(plot);assert.ok(f.options.some(option=>option.yAxis?.min===null));[...f.host.querySelectorAll('button')].find(b=>b.textContent==='Vrati početni prikaz').click();assert.deepEqual(f.options.at(-1),{yAxis:{min:0,max:5}});assert.match(f.host.querySelector('.tl-chart-interaction-status').textContent,/izvan Y/);f.release();f.window.close();
});

test('greška setOption čisti delimične handlere i svaku aktivnu kontrolu',()=>{
  clearDashboardChartStates();const plot=fixture([row('a','2026-10-06',1)]).output.plots[0];const window=new JSDOM('<main><div class="tl-chart-controls"></div><p class="tl-chart-interaction-status"></p><details class="tl-chart-point-details"><pre></pre></details></main>').window;const host=window.document.querySelector('main');const listeners=new Map();
  const chart={on:(name,fn)=>listeners.set(name,fn),off:(name)=>listeners.delete(name),dispatchAction(){},setOption(){throw Error('namerna greška');}};
  assert.throws(()=>bindDashboardChartInteractions(host,chart,plot,window),/namerna greška/);assert.equal(listeners.size,0);assert.equal(host.querySelectorAll('button,select').length,0);window.close();
});

test('workspace clear ne oživljava staro stanje kada se stari element naknadno ukloni',()=>{
  clearDashboardChartStates();const plot=fixture([row('a','2026-10-06',1)]).output.plots[0];let f=runtime(plot);f.listeners.get('datazoom')({start:30,end:60});clearDashboardChartStates();f.release();f.window.close();f=runtime(plot);assert.equal(f.host.querySelectorAll('select')[0].value,'0');f.release();f.window.close();
});

test('promena imena sportiste ne menja skrivenost iste stabilne serije',()=>{
  clearDashboardChartStates();const plot=fixture([row('a','2026-10-06',1)]).output.plots[0];let f=runtime(plot);f.listeners.get('legendselectchanged')({selected:{[plot.option.series[0].name]:false}});f.release();f.window.close();
  const renamed=structuredClone(plot);renamed.option.series[0].name='Novo ime';f=runtime(renamed);assert.equal(f.options[0].legend.selected['Novo ime'],false);f.release();f.window.close();
});

test('Odustani i naknadni zoom poništavaju nepotvrđenu primenu perioda',()=>{
  const plot=fixture([row('a','2026-10-06',1)]).output.plots[0];const f=runtime(plot);let events=0;f.host.addEventListener('optimove-chart-period',()=>events++);const click=text=>[...f.host.querySelectorAll('button')].find(button=>button.textContent===text).click();
  click('Primeni period na dashboard');click('Odustani');click('Potvrdi period');assert.equal(events,0);
  click('Primeni period na dashboard');f.listeners.get('datazoom')({start:30,end:50});click('Potvrdi period');assert.equal(events,0);f.release();f.window.close();
});
