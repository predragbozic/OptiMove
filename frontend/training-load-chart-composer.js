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

export function interactiveChartPresentation(groupBy, variant) {
  const time=['day','week'].includes(groupBy);
  return {mode:'replace',value:{schemaVersion:1,...(variant?{chartVariant:variant}:{}),...(time || groupBy==='athlete'?{chartComposition:'athletes-v1'}:{}),chartInteractions:{tooltip:{mode:'exact'},legend:{toggle:true},zoom:{mode:time?'local':'disabled',applyPeriodAction:time},pointSelection:{mode:'details'},yAxis:{mode:'auto'}}}};
}

export function chartPresentation(presentation) {
  if (presentation == null) return { mode:'legacy' };
  if (!only(presentation,['schemaVersion','chartVariant','chartComposition','chartInteractions']) || presentation.schemaVersion !== 1 || presentation.chartComposition !== undefined && presentation.chartComposition !== 'athletes-v1') return { mode:'unsupported' };
  if (Object.hasOwn(presentation,'chartVariant') && (!['area','horizontal-bar'].includes(presentation.chartVariant) || !Object.hasOwn(presentation,'chartInteractions'))) return {mode:'unsupported'};
  if(Object.hasOwn(presentation,'chartInteractions') && !only(presentation.chartInteractions,['tooltip','legend','zoom','pointSelection','yAxis']))return {mode:'unsupported'};
  const input = presentation.chartInteractions ?? {};
  if (!only(input,['tooltip','legend','zoom','pointSelection','yAxis'])) return { mode:'unsupported' };
  if (Object.hasOwn(input,'tooltip') && (!only(input.tooltip,['mode']) || !['exact','formatted'].includes(input.tooltip?.mode)) || Object.hasOwn(input,'legend') && (!only(input.legend,['toggle']) || typeof input.legend?.toggle !== 'boolean') || Object.hasOwn(input,'zoom') && (!only(input.zoom,['mode','applyPeriodAction']) || !['disabled','local'].includes(input.zoom?.mode) || typeof input.zoom?.applyPeriodAction !== 'boolean') || Object.hasOwn(input,'pointSelection') && (!only(input.pointSelection,['mode']) || !['disabled','details'].includes(input.pointSelection?.mode))) return {mode:'unsupported'};
  if(Object.hasOwn(input,'yAxis') && !only(input.yAxis,['mode','min','max']))return {mode:'unsupported'};
  const axis=input.yAxis ?? {mode:'auto'};
  if (!only(axis,axis.mode === 'fixed' ? ['mode','min','max'] : ['mode']) || !['auto','fixed'].includes(axis.mode) || axis.mode === 'fixed' && (!Number.isFinite(axis.min) || !Number.isFinite(axis.max) || axis.min >= axis.max)) return {mode:'unsupported'};
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
  if (settings.variant && model.widgetType!==({area:'line_chart','horizontal-bar':'bar_chart'}[settings.variant])) return {status:'unsupported',plots:[]};
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
