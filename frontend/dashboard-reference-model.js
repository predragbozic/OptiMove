import {sortAthletes} from './athlete-list-tools.js';
import { formatDashboardValue } from './training-load-dashboard-table.js';
export const safeReferenceText=(value,fallback='Unavailable')=>typeof value==='string'&&value.trim()&&!/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(value)?value:fallback;
export const formatReferenceValue=value=>typeof value==='number'&&Number.isFinite(value)?formatDashboardValue(value,{config:{effective:{numberFormat:{maximumFractionDigits:2}}}}):'—';
export const referenceReason=reason=>({noPosition:'Reference not available: no position is selected.',mixedActivities:'Team average is not available across different activity types.',noData:'No data for this period.',dataConflict:'Conflicting measurements cannot be compared.',incompatibleUnit:'This reference does not match the metric’s unit or calculation.',metricUnavailable:'This metric is not available.',teamUnavailable:'This team reference is not available.',tooFewAthletes:'Team average not available: fewer than three athletes have matching measurements.',calculatedMetric:'Team average is not available for a calculated metric.',invalidAnchor:'This Radar axis needs a positive reference value.',invalidActual:'This value cannot be shown on Radar.',missingReference:'Reference not available for this position and metric.',invalidBand:'The selected band limits do not match.'}[reason]??'This reference is not available.');
export const referenceDisplayAxes=data=>(data?.axes??[]).map(axis=>({...axis,points:sortAthletes((axis.points??[]).map(point=>({...point,name:safeReferenceText(point.label,'Athlete name unavailable')})))}));
export const referenceNextStep=reason=>({noPosition:'Choose a position in the athlete profile.',invalidAnchor:'Choose a positive 100% reference value.',incompatibleUnit:'Choose a matching reference table.',missingReference:'Enter this value in the reference table and publish a version.',tooFewAthletes:'Choose another period.',mixedActivities:'Choose one activity or a comparable period.'}[reason]??'Choose another reference or period.');
export function referenceChartModel(input,widget={}) {
 const data=input?{...input,axes:referenceDisplayAxes(input)}:input;
 if(!data?.axes?.length)return null;
 const precision=2,showLegend=widget.display_config?.legend?.visible!==false;
 if(data.mode==='overlay'){
  if(data.axes.length!==1)return null;
  const axis=data.axes[0],points=axis.points??[],labels=points.map(p=>safeReferenceText(p.label,'Athlete name unavailable'));
  if(!points.length)return null;
  const values=points.map(p=>typeof p.actual==='number'?p.actual:null);
  const kinds=[...new Map(points.flatMap(p=>(p.references??[]).map(ref=>[ref.key,safeReferenceText(ref.label,'Reference')]))).entries()];
  const bands=points.flatMap((p,i)=>p.band?.status==='ok'?[[{coord:[i-.4,p.band.lower]},{coord:[i+.4,p.band.upper]}]]:[]);
  const series=[{name:'Actual',type:widget.widget_type==='line_chart'?'line':'bar',data:values,connectNulls:false,...(bands.length?{markArea:{silent:true,itemStyle:{color:'rgba(19,125,112,.1)'},data:bands}}:{})},...kinds.map(([key,name])=>({name,type:'line',symbol:'circle',connectNulls:false,lineStyle:{type:'dashed'},data:points.map(p=>p.references?.find(ref=>ref.key===key)?.value??null)}))];
  return {precision,caption:safeReferenceText(axis.label,'Metric'),interactions:{legend:{toggle:true}},option:{animation:false,tooltip:{trigger:'axis',renderMode:'richText'},legend:{show:showLegend,type:'scroll'},grid:{top:48,left:55,right:20,bottom:65},xAxis:{type:'category',data:labels,axisLabel:{rotate:labels.length>6?30:0}},yAxis:{type:'value',name:safeReferenceText(axis.unit,'')},series}};
 }
 const axes=data.axes.filter(axis=>(axis.points??[]).some(p=>p.status==='ok'));
 if(axes.length<3)return null;
 const people=new Map();
 for(const axis of axes)for(const [i,p] of (axis.points??[]).entries())if(p.status==='ok')people.set(p.personKey??String(i),safeReferenceText(p.label,'Athlete name unavailable'));
 const counts=new Map(),series=[];
 for(const [key,name]of people){
  const count=(counts.get(name)??0)+1;counts.set(name,count);const label=count>1?`${name} (${count})`:name;
  const points=axes.map(axis=>axis.points.find((p,i)=>(p.personKey??String(i))===key));
  if(points.some(p=>p?.status!=='ok'||!Number.isFinite(p.normalized)))continue;
  series.push({name:label,type:'radar',data:[{name:label,value:points.map(p=>p.normalized)}]});
  const kinds=[...new Map(points.flatMap(p=>(p.references??[]).map(r=>[r.key,safeReferenceText(r.label,'Reference')]))).entries()];
  for(const [valueKey,valueName]of kinds){const values=points.map(p=>p.references?.find(r=>r.key===valueKey)?.normalized);if(values.some(v=>!Number.isFinite(v)))continue;const refName=`${valueName} · ${label}`;series.push({name:refName,type:'radar',lineStyle:{type:'dashed'},symbol:'none',data:[{name:refName,value:values}]});}
 }
 if(!series.length)return null;
 const max=Math.max(100,...series.flatMap(s=>s.data[0].value));
 return {precision,caption:'Values as a percentage of the chosen reference',interactions:{legend:{toggle:true}},option:{animation:false,tooltip:{renderMode:'richText'},legend:{show:showLegend,type:'scroll',bottom:0},radar:{radius:'62%',center:['50%','44%'],indicator:axes.map(axis=>({name:`${safeReferenceText(axis.label,'Metric')}${axis.unit?` (${safeReferenceText(axis.unit,'')})`:''}`,max:Number.isFinite(max*1.1)?max*1.1:max}))},series}};
}
