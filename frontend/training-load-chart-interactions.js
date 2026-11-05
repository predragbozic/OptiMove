import { chartZoomPeriod } from './training-load-chart-composer.js';

const states = new Map();
let stateEpoch=0;
export const clearDashboardChartStates = () => {stateEpoch++;states.clear();};
function remember(key, value) {
  states.delete(key); states.set(key,value);
  while (states.size>64) states.delete(states.keys().next().value);
}
export function chartPointText(point, precision, formatted = false) {
  if (!point) return 'No data';
  if (!point.identity) return 'Duplicate observations. See the values table.';
  const value=point.chartStatus === 'value' ? formatted ? Number(point.value).toFixed(precision) : String(point.value) : `${point.chartStatus}: ${String(point.rawValue)}`;
  return [point.metricLabel ?? point.identity.builtInSeriesKey ?? point.identity.metricDefinitionId,point.athleteName,point.identity.bucketKey,`${value} ${point.identity.unit ?? '(unit not specified)'}`,
    `Source policy: ${point.identity.source.policy ?? 'not reported'}`,`Configured source: ${point.identity.source.configuredConnectionId ?? 'not reported'}`,`Reported source: ${Object.keys(point.identity.source.reported).length?JSON.stringify(point.identity.source.reported):'not reported'}`].join('\n');
}

export function bindDashboardChartInteractions(host, chart, plot, scope = globalThis) {
  const document=host.ownerDocument;
  const controls=host.querySelector('.tl-chart-controls');
  const status=host.querySelector('.tl-chart-interaction-status');
  const details=host.querySelector('.tl-chart-point-details');
  if (!controls || !status || !details || typeof chart.on!=='function') return () => {};
  const key=JSON.stringify([plot.key,plot.contextId]);
  const valueAxis=plot.valueAxis==='xAxis'?'xAxis':'yAxis';
  const epoch=stateEpoch;
  const previous=states.get(key);
  const state=plot.queryId && previous?.fingerprint===plot.fingerprint ? structuredClone(previous) : {fingerprint:plot.fingerprint,selected:{},first:0,last:plot.buckets.length-1,yAuto:false};
  const rememberState=()=>{if(epoch===stateEpoch)remember(key,structuredClone(state));};
  const handlers=[];
  let released=false;
  const cleanup=()=>{if(released)return;released=true;rememberState();for(const [name,fn] of handlers)chart.off?.(name,fn);controls.replaceChildren();};
  try {
  const on=(name,fn)=>{ chart.on(name,fn); handlers.push([name,fn]); };
  const button=(label,fn,parent=controls)=>{const element=document.createElement('button');element.type='button';element.className='plain-button compact-button';element.textContent=label;element.addEventListener('click',fn);parent.append(element);return element;};
  const group=(label)=>{const element=document.createElement('fieldset');element.className='tl-chart-control-group';const legend=document.createElement('legend');legend.textContent=label;element.append(legend);controls.append(element);return element;};
  const legendButtons=new Map();
  const point=(series,index)=>plot.rowsBySeries[series]?.[index];
  const showPoint=(series,index)=>{
    const selected=point(series,index);
    if (!plot.queryId || !selected?.identity || selected.queryId!==plot.queryId) return;
    let summary=details.querySelector('.tl-chart-point-summary');if(!summary){summary=document.createElement('p');summary.className='tl-chart-point-summary';details.insertBefore(summary,details.querySelector('pre'));}
    summary.textContent=chartPointText(selected,plot.precision);
    details.querySelector('pre').textContent=JSON.stringify({queryId:selected.queryId,phase:selected.phase,rowIndex:selected.rowIndex,identityKey:selected.identityKey,identity:selected.identity,status:selected.status,value:selected.rawValue,raw:selected.raw},null,2);
    details.open=true;
  };
  const updateStatus=()=>{
    const ids=plot.option.series.map(series=>series.id);
    const hidden=ids.length && ids.every(id=>state.selected[id]===false);
    for(const [id,element] of legendButtons)element.setAttribute('aria-pressed',String(state.selected[id]!==false));
    status.textContent=[hidden?'All series are hidden. Reset the view to show them again.':'',...(state.yAuto?[]:plot.warnings)].filter(Boolean).join(' ');
  };
  const setRange=(first,last,dispatch=true)=>{
    if (!Number.isInteger(first)||!Number.isInteger(last)||first<0||last<first||last>=plot.buckets.length) return;
    if(first!==state.first || last!==state.last)clearPeriodConfirmation();
    state.first=first; state.last=last; rememberState();
    if (dispatch) chart.dispatchAction?.({type:'dataZoom',startValue:first,endValue:last});
    if (from) from.value=String(first); if(to) to.value=String(last);
  };
  let from,to,clearPeriodConfirmation=()=>{};
  const zoom=plot.option.dataZoom?.length>0;
  if (zoom) {
    const rangeControls=group('Displayed period');
    const hint=document.createElement('p');hint.className='tl-chart-control-hint';hint.textContent='Zoom affects only this chart. The dashboard period changes only after confirmation.';rangeControls.append(hint);
    for (const [label,isFrom] of [['Zoom from',true],['Zoom to',false]]) {
      const wrapper=document.createElement('label');wrapper.textContent=label;
      const select=document.createElement('select');
      select.setAttribute('aria-label',label);
      for (const [index,bucket] of plot.buckets.entries()) {const option=document.createElement('option');option.value=String(index);option.textContent=bucket;select.append(option);}
      select.value=String(isFrom?state.first:state.last);
      select.addEventListener('change',()=>{const index=Number(select.value);setRange(isFrom?Math.min(index,state.last):state.first,isFrom?state.last:Math.max(index,state.first));});
      wrapper.append(select);rangeControls.append(wrapper); if(isFrom)from=select;else to=select;
    }
    on('datazoom',event=>{
      const range=event.batch?.[0] ?? event;
      if (Number.isFinite(range.start) && Number.isFinite(range.end)) setRange(Math.round(Math.max(0,Math.min(100,range.start))*(plot.buckets.length-1)/100),Math.round(Math.max(0,Math.min(100,range.end))*(plot.buckets.length-1)/100),false);
      else if(Number.isInteger(range.startValue)&&Number.isInteger(range.endValue))setRange(range.startValue,range.endValue,false);
    });
    if(plot.settings.applyPeriod) {
      const confirmation=document.createElement('div');confirmation.className='tl-chart-period-confirmation';confirmation.hidden=true;confirmation.setAttribute('role','group');confirmation.setAttribute('aria-label','Confirm period change');
      const explanation=document.createElement('p');confirmation.append(explanation);let proposedPeriod;
      const apply=button('Apply period to dashboard',()=>{
        proposedPeriod=chartZoomPeriod(plot,state.first,state.last);
        if(proposedPeriod){explanation.textContent=`The period ${proposedPeriod.dateFrom} – ${proposedPeriod.dateTo} will apply to the dashboard. Saved default filters will stay unchanged.`;confirmation.hidden=false;accept.focus();}
      },rangeControls);
      const accept=button('Confirm period',()=>{if(proposedPeriod){confirmation.hidden=true;host.dispatchEvent(new scope.CustomEvent('optimove-chart-period',{bubbles:true,detail:{...proposedPeriod,confirmed:true,queryId:plot.queryId,widgetId:plot.widgetId,contextId:plot.contextId}}));proposedPeriod=null;}},confirmation);
      button('Cancel',()=>{confirmation.hidden=true;proposedPeriod=null;apply.focus();},confirmation);rangeControls.append(confirmation);
      clearPeriodConfirmation=()=>{confirmation.hidden=true;proposedPeriod=null;};
    }
  }
  if(plot.settings.legend && plot.groupBy!=='athlete') {
    const seriesControls=group('Visible series');
    for(const series of plot.option.series)legendButtons.set(series.id,button(`Show/hide ${series.name}`,()=>chart.dispatchAction?.({type:'legendToggleSelect',name:series.name}),seriesControls));
    on('legendselectchanged',event=>{state.selected=Object.fromEntries(plot.option.series.map(series=>[series.id,event.selected?.[series.name]!==false]));rememberState();updateStatus();});
  }
  if(plot.settings.pointDetails && plot.queryId) {
    const pointControls=group('Values and details');
    const label=document.createElement('label');label.textContent='Point preview';const select=document.createElement('select');select.setAttribute('aria-label','Point preview');
    const empty=document.createElement('option');empty.value='';empty.textContent='Select a point';select.append(empty);
    for(const [series,rows] of plot.rowsBySeries.entries()) for(const [index,row] of rows.entries())if(row?.identity){const option=document.createElement('option');option.value=`${series}:${index}`;option.textContent=`${row.metricLabel ?? ''} · ${row.athleteName} · ${row.identity.bucketKey} · ${row.chartStatus==='value'?String(row.value):row.chartStatus} ${row.identity.unit ?? ''}`;select.append(option);}
    select.addEventListener('change',()=>{if(select.value){const [series,index]=select.value.split(':').map(Number);showPoint(series,index);}});label.append(select);pointControls.append(label);
    on('click',event=>{if(event.componentType==='series' && Number.isInteger(event.seriesIndex) && Number.isInteger(event.dataIndex))showPoint(event.seriesIndex,event.dataIndex);});
  }
  const viewControls=group('Display settings');
  button('Reset view',()=>{
    clearPeriodConfirmation();
    state.selected={};for(const series of plot.option.series)chart.dispatchAction?.({type:'legendSelect',name:series.name});
    state.yAuto=false;if(plot.settings.axis.mode==='fixed')chart.setOption({[valueAxis]:{min:plot.settings.axis.min,max:plot.settings.axis.max}});
    if(zoom)setRange(0,plot.buckets.length-1);rememberState();details.open=false;updateStatus();
  },viewControls);
  if(plot.settings.axis.mode==='fixed')button('Automatic value range',()=>{state.yAuto=true;rememberState();chart.setOption({[valueAxis]:{min:null,max:null}});updateStatus();},viewControls);
  chart.setOption({legend:{selected:Object.fromEntries(plot.option.series.filter(series=>Object.hasOwn(state.selected,series.id)).map(series=>[series.name,state.selected[series.id]]))}});
  if(state.yAuto)chart.setOption({[valueAxis]:{min:null,max:null}});
  if(zoom)setRange(state.first,state.last);
  updateStatus();
  return cleanup;
  } catch(error) {cleanup();throw error;}
}
