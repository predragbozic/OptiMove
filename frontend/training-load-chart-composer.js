import { composeScatter } from './training-load-scatter-composer.js';
import { composeBoxplot } from './training-load-boxplot-composer.js';
import { composeStacked, validStackDefinition } from './training-load-stacked-composer.js';

export function chartIdentityKey(value) {
  if (Array.isArray(value)) return `[${value.map(chartIdentityKey).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${chartIdentityKey(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const isChartDate = value => typeof value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0,10);
const monday = date => shift(date, -(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7);
const palette = ['#157b70','#427eb5','#8560b0','#9b641e','#a54343','#246778','#725b42'];
const color = id => { let hash = 0; for (const c of String(id)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0; return palette[hash % palette.length]; };
const only = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function interactiveChartPresentation(groupBy, variant, stackDefinition) {
  const time=['day','week'].includes(groupBy) && variant!=='scatter';
  return {mode:'replace',value:{schemaVersion:1,...(variant?{chartVariant:variant}:{}),...(variant==='boxplot'?{chartComposition:'distribution-v1'}:variant==='stacked'?{chartComposition:'components-v1',...(stackDefinition?{stackDefinition:structuredClone(stackDefinition)}:{})}:variant==='scatter'?{chartComposition:'pairs-v1'}:variant==='heatmap'?{chartComposition:'matrix-v1'}:variant==='combined'?{chartComposition:'metrics-v1'}:time || groupBy==='athlete'?{chartComposition:'athletes-v1'}:{}),chartInteractions:{tooltip:{mode:'exact'},legend:{toggle:true},zoom:{mode:time?'local':'disabled',applyPeriodAction:time},pointSelection:{mode:'details'},yAxis:{mode:'auto'}}}};
}

export function chartPresentation(presentation) {
  if (presentation == null) return { mode:'legacy' };
  if (!only(presentation,['schemaVersion','chartVariant','chartComposition','chartInteractions','stackDefinition','chartReference']) || presentation.schemaVersion !== 1 || presentation.chartComposition !== undefined && !['athletes-v1','metrics-v1','matrix-v1','pairs-v1','components-v1','distribution-v1'].includes(presentation.chartComposition)) return { mode:'unsupported' };
  if (Object.hasOwn(presentation,'chartVariant') && (!['area','horizontal-bar','combined','heatmap','scatter','stacked','boxplot'].includes(presentation.chartVariant) || !Object.hasOwn(presentation,'chartInteractions'))) return {mode:'unsupported'};
  if ((presentation.chartVariant==='boxplot') !== (presentation.chartComposition==='distribution-v1')) return {mode:'unsupported'};
  if ((presentation.chartVariant==='combined') !== (presentation.chartComposition==='metrics-v1')) return {mode:'unsupported'};
  if ((presentation.chartVariant==='heatmap') !== (presentation.chartComposition==='matrix-v1')) return {mode:'unsupported'};
  if ((presentation.chartVariant==='scatter') !== (presentation.chartComposition==='pairs-v1')) return {mode:'unsupported'};
  if ((presentation.chartVariant==='stacked') !== (presentation.chartComposition==='components-v1') || (presentation.chartVariant==='stacked') !== Object.hasOwn(presentation,'stackDefinition') || presentation.chartVariant==='stacked' && !validStackDefinition(presentation.stackDefinition))return {mode:'unsupported'};
  if(Object.hasOwn(presentation,'chartInteractions') && !only(presentation.chartInteractions,['tooltip','legend','zoom','pointSelection','yAxis']))return {mode:'unsupported'};
  const input = presentation.chartInteractions ?? {};
  if (!only(input,['tooltip','legend','zoom','pointSelection','yAxis'])) return { mode:'unsupported' };
  if (Object.hasOwn(input,'tooltip') && (!only(input.tooltip,['mode']) || !['exact','formatted'].includes(input.tooltip?.mode)) || Object.hasOwn(input,'legend') && (!only(input.legend,['toggle']) || typeof input.legend?.toggle !== 'boolean') || Object.hasOwn(input,'zoom') && (!only(input.zoom,['mode','applyPeriodAction']) || !['disabled','local'].includes(input.zoom?.mode) || typeof input.zoom?.applyPeriodAction !== 'boolean') || Object.hasOwn(input,'pointSelection') && (!only(input.pointSelection,['mode']) || !['disabled','details'].includes(input.pointSelection?.mode))) return {mode:'unsupported'};
  if(Object.hasOwn(input,'yAxis') && !only(input.yAxis,['mode','min','max']))return {mode:'unsupported'};
  const axis=input.yAxis ?? {mode:'auto'};
  if (!only(axis,axis.mode === 'fixed' ? ['mode','min','max'] : ['mode']) || !['auto','fixed'].includes(axis.mode) || axis.mode === 'fixed' && (!Number.isFinite(axis.min) || !Number.isFinite(axis.max) || axis.min >= axis.max)) return {mode:'unsupported'};
  if(['combined','heatmap','scatter','stacked','boxplot'].includes(presentation.chartVariant) && axis.mode!=='auto')return {mode:'unsupported'};
  if(presentation.chartVariant==='scatter' && (input.zoom?.mode==='local' || input.zoom?.applyPeriodAction))return {mode:'unsupported'};
  return {mode:'enhanced',variant:presentation.chartVariant,composition:presentation.chartComposition === 'athletes-v1',tooltip:input.tooltip?.mode ?? 'exact',legend:input.legend?.toggle ?? true,zoom:input.zoom?.mode ?? 'disabled',applyPeriod:input.zoom?.applyPeriodAction === true,pointDetails:input.pointSelection?.mode === 'details',axis};
}

export function chartBuckets(period, groupBy) {
  if (!isChartDate(period?.dateFrom) || !isChartDate(period?.dateTo) || period.dateTo < period.dateFrom || (Date.parse(period.dateTo)-Date.parse(period.dateFrom))/86400000 > 399) return null;
  const result=[];
  for (let date = groupBy === 'week' ? monday(period.dateFrom) : period.dateFrom; date <= period.dateTo; date=shift(date,groupBy === 'week'?7:1)) result.push(date);
  return result;
}

export function chartZoomPeriod(plot, first, last) {
  if (!['day','week'].includes(plot.groupBy) || !plot.resolvedPeriod || !Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= plot.buckets.length) return null;
  const dateFrom = [plot.buckets[first],plot.resolvedPeriod.dateFrom].sort().at(-1);
  const dateTo = [shift(plot.buckets[last],plot.groupBy === 'week'?6:0),plot.resolvedPeriod.dateTo].sort()[0];
  return isChartDate(dateFrom) && isChartDate(dateTo) && dateFrom <= dateTo ? {dateFrom,dateTo} : null;
}

export function composeDashboardCharts(model, labelForSeries, rowContext, options = {}) {
  const settings = chartPresentation(options.presentation);
  if (settings.mode !== 'enhanced') return {status:settings.mode,plots:[]};
  if (model.status !== 'ready' || !['line_chart','bar_chart'].includes(model.widgetType)) return {status:'notReady',plots:[]};
  if (settings.variant && model.widgetType!==({area:'line_chart','horizontal-bar':'bar_chart',combined:'line_chart',heatmap:'bar_chart',scatter:'line_chart',stacked:'bar_chart',boxplot:'bar_chart'}[settings.variant])) return {status:'unsupported',plots:[]};
  if(settings.variant==='boxplot')return composeBoxplot(model,labelForSeries,options,settings,{identityKey:chartIdentityKey,makeBuckets:chartBuckets,color});
  if(settings.variant==='stacked')return composeStacked(model,labelForSeries,options,settings,{identityKey:chartIdentityKey,buckets:chartBuckets,color});
  if(settings.variant==='scatter')return composeScatter(model,labelForSeries,options,settings,{identityKey:chartIdentityKey,buckets:chartBuckets,color});
  if(settings.variant==='combined')return composeCombinedCharts(model,labelForSeries,options,settings);
  if(settings.variant==='heatmap')return composeHeatmap(model,labelForSeries,options,settings);
  const time = ['day','week'].includes(model.groupBy);
  const composed = settings.composition && (time || model.groupBy === 'athlete');
  const period = options.resolvedPeriod ?? model.period;
  const dense = time ? chartBuckets(period,model.groupBy) : null;
  if (time && !dense) return {status:'periodRequired',plots:[]};
  const groups = new Map();
  for (const series of model.series) {
    if (series.status !== 'ready') continue;
    for (const [phase,rows] of [['current',series.current],['comparison',series.comparison]]) {
      for (const row of rows) {
        const {bucketKey,athleteId,...identity} = row.identity;
        const key=chartIdentityKey({widgetId:model.widgetId,...identity,...(!composed?{athleteId}:{}),phase});
        if (!groups.has(key)) groups.set(key,{key,phase,definition:series.definition,identity,rows:[],comparisonPeriod:series.comparisonRange});
        groups.get(key).rows.push(row);
      }
    }
  }
  const plots=[];
  for (const group of groups.values()) {
    const athleteIds=[...new Set(group.rows.map(row=>row.identity.athleteId))].sort((a,b)=>String(a).localeCompare(String(b)));
    if (athleteIds.length>20) return {status:'requiresChoice',plots:[]};
    const phasePeriod=group.phase === 'comparison' ? group.comparisonPeriod : period;
    const buckets=time ? chartBuckets(phasePeriod,model.groupBy) : model.groupBy === 'athlete' && composed ? athleteIds : [...new Set(group.rows.map(row=>row.identity.bucketKey))];
    if (!buckets || group.rows.some(row => time && !buckets.includes(row.identity.bucketKey))) return {status:'invalidBuckets',plots:[]};
    const athleteName=id=>options.athletes?.find(athlete=>athlete.id===id)?.name || (id == null ? 'Whole group' : `Athlete ${id}`);
    const names=athleteIds.map(athleteName);
    const labels=athleteIds.map((id,index)=>names.filter(name=>name===names[index]).length>1 ? `${names[index]} (${id ?? 'group'})` : names[index]);
    const labelCollision=new Set(labels).size!==labels.length;
    const uniqueLabel=id=>labelCollision ? JSON.stringify([athleteName(id),id]) : labels[athleteIds.indexOf(id)];
    const name=labelForSeries(group.definition);
    const rowsBySeries=[];
    const definitions=[];
    for (const id of model.groupBy === 'athlete' && composed ? [null] : athleteIds) {
      const members=model.groupBy === 'athlete' && composed ? group.rows : group.rows.filter(row=>row.identity.athleteId===id);
      const points=buckets.map(bucket=>{
        const candidates=members.filter(row=>(model.groupBy === 'athlete' && composed ? row.identity.athleteId : row.identity.bucketKey)===bucket);
        if (candidates.length!==1) return candidates.length ? {status:'duplicate',value:null,rows:structuredClone(candidates)} : null;
        const row=candidates[0];
        return {...structuredClone(row),identityKey:chartIdentityKey(row.identity),phase:group.phase,queryId:options.queryId ?? null,athleteName:athleteName(row.identity.athleteId),metricLabel:name};
      });
      rowsBySeries.push(points);
      const label=model.groupBy === 'athlete' && composed ? name : uniqueLabel(id);
      definitions.push({id:chartIdentityKey([group.key,id]),name:label,type:model.widgetType==='bar_chart'?'bar':'line',connectNulls:false,showSymbol:true,symbolSize:7,barMaxWidth:26,itemStyle:{color:color(id)},lineStyle:{color:color(id),width:2.5},label:{show:model.config.effective.valueLabels.visible,position:'top'},data:points.map(point=>point?.chartStatus==='value'?{value:point.value}:null)});
    }
    const fixed=settings.axis.mode==='fixed';
    const units=new Set([...groups.values()].filter(other=>other.definition.id===group.definition.id && other.phase===group.phase).map(other=>other.identity.unit));
    if (fixed && units.size>1) return {status:'ambiguousAxisUnit',plots:[]};
    const zoom=time && settings.zoom==='local';
    const warnings=[];
    if (fixed && group.rows.some(row=>row.chartStatus==='value' && (row.value<settings.axis.min || row.value>settings.axis.max))) warnings.push('Some values are outside the value axis range. Original values remain in the table.');
    const plot={enhanced:true,key:group.key,widgetId:model.widgetId,queryId:options.queryId ?? null,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(phasePeriod),rowsBySeries,settings:{...settings,applyPeriod:settings.applyPeriod && options.allowApplyPeriod!==false && group.phase==='current' && Boolean(options.queryId)},warnings,precision:model.config.effective.numberFormat.maximumFractionDigits,
      caption:[name,group.phase==='comparison'?'Comparison':'Current period',group.identity.unit ?? 'Unit not specified'].join(' · '),
      option:{animation:false,grid:{left:12,right:20,top:48,bottom:zoom?70:16,containLabel:true},legend:{show:model.config.effective.legend.visible,selectedMode:settings.legend,type:'scroll',left:12,right:12,top:4},tooltip:{trigger:'item',renderMode:'richText',confine:true},xAxis:{type:'category',data:model.groupBy==='athlete' && composed?buckets.map(uniqueLabel):buckets,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:group.identity.unit ?? '',...(fixed?{min:settings.axis.min,max:settings.axis.max}:{}),scale:false},series:definitions,...(zoom?{dataZoom:[{type:'slider',filterMode:'none',start:0,end:100},{type:'inside',filterMode:'none',zoomOnMouseWheel:false,moveOnMouseWheel:false,start:0,end:100}]}:{})}};
    plot.valueAxis=settings.variant==='horizontal-bar'?'xAxis':'yAxis';
    if(settings.variant==='area')for(const series of definitions)series.areaStyle={opacity:0.18};
    if(settings.variant==='horizontal-bar'){
      const category=plot.option.xAxis,value=plot.option.yAxis;
      plot.option.xAxis=value;plot.option.yAxis={...category,inverse:true};
      for(const series of definitions)series.label.position='right';
      if(zoom){plot.option.grid.right=58;for(const control of plot.option.dataZoom){control.yAxisIndex=0;control.orient='vertical';if(control.type==='slider'){control.right=4;control.top=60;control.bottom=20;}}}
    }
    plot.fingerprint=chartIdentityKey([options.contextId,options.queryId,options.widgetRevision,phasePeriod,options.presentation,model.config.effective]);
    plots.push(plot);
  }
  return {status:'ready',plots};
}

// Two metric axes are composed per athlete; values never cross athlete or unit boundaries.
function composeCombinedCharts(model, labelForSeries, options, settings) {
  const refuse=status=>({status,plots:[]});
  if(!['day','week'].includes(model.groupBy) || model.series.length!==2) return refuse('combinedConfigurationRequired');
  const series=['primary','secondary'].map(axis=>model.series.filter(item=>item.definition.axis===axis));
  if(series.some(items=>items.length!==1))return refuse('combinedConfigurationRequired');
  const ordered=series.map(items=>items[0]);
  if(ordered.some(item=>item.status!=='ready' || item.definition.comparison_period || item.comparison.length || item.comparisonRange || item.reasons.length))return refuse('notReady');
  const period=options.resolvedPeriod ?? model.period;
  const buckets=chartBuckets(period,model.groupBy);
  if(!buckets)return refuse('periodRequired');
  const units=ordered.map(item=>[...new Set(item.current.map(row=>row.identity.unit))]);
  if(units.some(values=>values.length>1))return refuse('ambiguousAxisUnit');
  if(ordered.some(item=>item.current.some(row=>!buckets.includes(row.identity.bucketKey))))return refuse('invalidBuckets');
  if(ordered.some(item=>item.current.some(row=>row.chartStatus==='unsupported')))return refuse('notReady');
  const athletes=[...new Set(ordered.flatMap(item=>item.current.map(row=>row.identity.athleteId)))].sort((a,b)=>String(a).localeCompare(String(b)));
  if(athletes.length>20)return refuse('requiresChoice');
  const names=athletes.map(id=>options.athletes?.find(item=>item.id===id)?.name || (id==null?'Whole group':`Athlete ${id}`));
  const zoom=settings.zoom==='local';
  const plots=athletes.map((athleteId,index)=>{
    const athleteName=names.filter(name=>name===names[index]).length>1?`${names[index]} (${athleteId ?? 'group'})`:names[index];
    const labels=ordered.map((item,i)=>`${labelForSeries(item.definition)} · ${units[i][0] ?? 'Unit not specified'} · ${i===0?'Left / bar':'Right / line'}`);
    const rowsBySeries=ordered.map(item=>buckets.map(bucket=>{
      const candidates=item.current.filter(row=>row.identity.athleteId===athleteId && row.identity.bucketKey===bucket);
      if(candidates.length!==1)return candidates.length?{status:'duplicate',value:null,rows:structuredClone(candidates)}:null;
      const row=candidates[0];
      return {...structuredClone(row),identityKey:chartIdentityKey(row.identity),phase:'current',queryId:options.queryId ?? null,athleteName,metricLabel:labelForSeries(item.definition)};
    }));
    const key=chartIdentityKey([model.widgetId,'combined',athleteId,ordered.map(item=>item.id)]);
    return {enhanced:true,key,widgetId:model.widgetId,queryId:options.queryId ?? null,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(period),rowsBySeries,
      settings:{...settings,applyPeriod:settings.applyPeriod && options.allowApplyPeriod!==false && Boolean(options.queryId)},warnings:[],precision:model.config.effective.numberFormat.maximumFractionDigits,
      caption:`${athleteName} · ${labels.join(' / ')}`,valueAxis:'yAxis',
      fingerprint:chartIdentityKey([options.contextId,options.queryId,options.widgetRevision,period,options.presentation,model.config.effective]),
      option:{animation:false,grid:{left:12,right:20,top:64,bottom:zoom?70:16,containLabel:true},legend:{show:model.config.effective.legend.visible,selectedMode:settings.legend,type:'scroll',left:12,right:12,top:4},tooltip:{trigger:'item',renderMode:'richText',confine:true},
        xAxis:{type:'category',data:buckets,axisLabel:{hideOverlap:true}},
        yAxis:units.map((values,i)=>({type:'value',position:i===0?'left':'right',name:values[0] ?? '',scale:false,splitLine:{show:i===0}})),
        series:ordered.map((item,i)=>({id:chartIdentityKey([key,item.id]),name:labels[i],type:i===0?'bar':'line',yAxisIndex:i,connectNulls:false,showSymbol:true,symbolSize:7,barMaxWidth:26,itemStyle:{color:i===0?'#157b70':'#b56b20'},lineStyle:{color:'#b56b20',width:2.5},label:{show:model.config.effective.valueLabels.visible,position:'top'},data:rowsBySeries[i].map(point=>point?.chartStatus==='value'?{value:point.value}:null)})),
        ...(zoom?{dataZoom:[{type:'slider',filterMode:'none',start:0,end:100},{type:'inside',filterMode:'none',zoomOnMouseWheel:false,moveOnMouseWheel:false,start:0,end:100}]}:{})}};
  });
  return {status:'ready',plots};
}

function composeHeatmap(model,labelForSeries,options,settings) {
  const refuse=status=>({status,plots:[]});
  if(model.series.length!==1 || !['day','week'].includes(model.groupBy))return refuse('heatmapConfigurationRequired');
  const series=model.series[0];
  if(series.status!=='ready' || series.definition.comparison_period || series.comparison.length || series.comparisonRange || series.reasons.length)return refuse('notReady');
  const period=options.resolvedPeriod ?? model.period,buckets=chartBuckets(period,model.groupBy);
  if(!buckets)return refuse('periodRequired');
  const rows=series.current,units=[...new Set(rows.map(row=>row.identity.unit))];
  if(units.length>1)return refuse('ambiguousAxisUnit');
  if(rows.some(row=>!buckets.includes(row.identity.bucketKey)))return refuse('invalidBuckets');
  if(rows.some(row=>row.chartStatus==='unsupported'))return refuse('notReady');
  const athleteIds=[...new Set(rows.map(row=>row.identity.athleteId))].sort((a,b)=>String(a).localeCompare(String(b)));
  if(athleteIds.length>20)return refuse('requiresChoice');
  const names=athleteIds.map(id=>options.athletes?.find(athlete=>athlete.id===id)?.name || (id==null?'Whole group':`Athlete ${id}`));
  const labels=names.map((name,i)=>names.filter(other=>other===name).length>1?`${name} (${athleteIds[i] ?? 'group'})`:name);
  if(new Set(labels).size!==labels.length)for(let i=0;i<labels.length;i++)labels[i]=JSON.stringify([names[i],athleteIds[i]]);
  const metric=labelForSeries(series.definition),points=[],data=[],cells=new Map();
  for(const row of rows){const key=chartIdentityKey([row.identity.athleteId,row.identity.bucketKey]);if(!cells.has(key))cells.set(key,[]);cells.get(key).push(row);}
  for(const [athleteIndex,id] of athleteIds.entries())for(const [bucketIndex,bucket] of buckets.entries()){
    const candidates=cells.get(chartIdentityKey([id,bucket])) ?? [];
    const row=candidates[0];
    const point=candidates.length===1?{...structuredClone(row),identityKey:chartIdentityKey(row.identity),phase:'current',queryId:options.queryId ?? null,athleteName:labels[athleteIndex],metricLabel:metric}:candidates.length?{status:'duplicate',value:null,rows:structuredClone(candidates)}:null;
    points.push(point);data.push({value:[bucketIndex,athleteIndex,point?.chartStatus==='value'?point.value:null]});
  }
  const values=points.filter(point=>point?.chartStatus==='value').map(point=>point.value);
  if(!values.length)return refuse('noNumericData');
  const min=Math.min(...values),max=Math.max(...values),zoom=settings.zoom==='local';
  const scaleLabel=value=>String(value).length<=12?String(value):value.toExponential(3);
  const key=chartIdentityKey([model.widgetId,'heatmap',series.id]);
  return {status:'ready',plots:[{enhanced:true,key,widgetId:model.widgetId,queryId:options.queryId ?? null,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(period),rowsBySeries:[points],
    settings:{...settings,applyPeriod:settings.applyPeriod && options.allowApplyPeriod!==false && Boolean(options.queryId)},warnings:['Colors show the observed value range, not thresholds or reference attainment. The scale can change with the selected data.'],precision:model.config.effective.numberFormat.maximumFractionDigits,
    caption:`${metric} · ${units[0] ?? 'Unit not specified'} · Athlete × ${model.groupBy==='week'?'week':'day'}`,valueAxis:'yAxis',renderHeight:Math.max(320,athleteIds.length*28+170),
    fingerprint:chartIdentityKey([options.contextId,options.queryId,options.widgetRevision,period,options.presentation,model.config.effective]),
    option:{animation:false,grid:{left:12,right:20,top:24,bottom:zoom?122:70,containLabel:true},legend:{show:false,selectedMode:settings.legend},tooltip:{trigger:'item',renderMode:'richText',confine:true},
      xAxis:{type:'category',data:buckets,splitArea:{show:true},axisLabel:{hideOverlap:true}},yAxis:{type:'category',data:labels,inverse:true,splitArea:{show:true},axisLabel:{width:110,overflow:'truncate'}},
      visualMap:{show:model.config.effective.legend.visible,type:'continuous',dimension:2,seriesIndex:0,min,max,text:[scaleLabel(max),scaleLabel(min)],itemHeight:100,itemWidth:12,textGap:8,textStyle:{fontSize:11},calculable:false,orient:'horizontal',left:'center',bottom:zoom?56:8,inRange:{color:['#e5f3ef','#11776b']},precision:model.config.effective.numberFormat.maximumFractionDigits},
      series:[{id:chartIdentityKey([key,series.id]),name:metric,type:'heatmap',encode:{x:0,y:1,value:2},label:{show:model.config.effective.valueLabels.visible},data}],
      ...(zoom?{dataZoom:[{type:'slider',xAxisIndex:0,filterMode:'none',start:0,end:100},{type:'inside',xAxisIndex:0,filterMode:'none',zoomOnMouseWheel:false,moveOnMouseWheel:false,start:0,end:100}]}:{})}}]};
}
