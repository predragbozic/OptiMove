// Type-7 interpolated quartiles; Tukey whiskers are observed values inside 1.5 IQR.
export function boxStatistics(input) {
  if(input.length<5 || input.some(value=>!Number.isFinite(value)))return null;
  const values=[...input].sort((a,b)=>a-b);
  const quantile=p=>{const h=(values.length-1)*p,i=Math.floor(h),t=h-i;return t===0?values[i]:(1-t)*values[i]+t*values[i+1];};
  const q1=quantile(.25),median=quantile(.5),q3=quantile(.75),iqr=q3-q1;
  const lower=q1-1.5*iqr,upper=q3+1.5*iqr;
  if(![q1,median,q3,iqr,lower,upper].every(Number.isFinite))return null;
  const inside=values.filter(value=>value>=lower && value<=upper);
  return {count:values.length,minimum:values[0],q1,median,q3,maximum:values.at(-1),low:inside[0],high:inside.at(-1),lowerFence:lower,upperFence:upper};
}

export function composeBoxplot(model,labelForSeries,options,settings,{identityKey,makeBuckets,color}) {
  const refuse=status=>({status,plots:[]});
  if(model.series.length!==1 || !['day','week'].includes(model.groupBy))return refuse('boxplotConfigurationRequired');
  const series=model.series[0];
  if(series.status!=='ready' || series.definition.axis!=='primary' || series.definition.comparison_period || series.comparison.length || series.comparisonRange || series.reasons.length)return refuse('boxplotConfigurationRequired');
  const period=options.resolvedPeriod ?? model.period,buckets=makeBuckets(period,model.groupBy);
  if(!buckets)return refuse('periodRequired');
  const rows=series.current;
  if(rows.length>8000)return refuse('requiresChoice');
  if(rows.some(row=>!buckets.includes(row.identity.bucketKey)))return refuse('invalidBuckets');
  if(rows.some(row=>typeof row.identity.athleteId!=='string' || !row.identity.athleteId))return refuse('boxplotIndividualRequired');
  const units=new Set(rows.map(row=>row.identity.unit));
  if(units.size>1)return refuse('ambiguousAxisUnit');
  if(rows.some(row=>typeof row.identity.unit!=='string' || !row.identity.unit.trim()))return refuse('boxplotUnitRequired');
  if(new Set(rows.map(row=>identityKey(row.identity.source))).size>1)return refuse('boxplotMixedSources');
  const athletes=new Set(rows.map(row=>row.identity.athleteId));
  if(athletes.size>20)return refuse('requiresChoice');
  const metric=labelForSeries(series.definition),unit=[...units][0],points=[],outliers=[],data=[],outlierData=[],cells=new Map();
  for(const row of rows){const key=identityKey([row.identity.bucketKey,row.identity.athleteId]);if(!cells.has(key))cells.set(key,[]);cells.get(key).push(row);}
  const exact=row=>({...structuredClone(row),identityKey:identityKey(row.identity),phase:'current',queryId:options.queryId ?? null,metricLabel:metric,athleteName:options.athletes?.find(a=>a.id===row.identity.athleteId)?.name || `Athlete ${row.identity.athleteId}`});
  let omittedBuckets=0;
  for(const [index,bucket]of buckets.entries()){
    const eligible=[];
    for(const athleteId of athletes){const candidates=cells.get(identityKey([bucket,athleteId])) ?? [];if(candidates.length===1 && candidates[0].chartStatus==='value' && Number.isFinite(candidates[0].value))eligible.push(candidates[0]);}
    const statistics=boxStatistics(eligible.map(row=>row.value));
    if(!statistics){points.push(null);data.push({value:[null,null,null,null,null]});omittedBuckets++;continue;}
    const sampleRows=eligible.map(exact),excluded=athletes.size-eligible.length;
    points.push({derivedDistribution:true,statistics,excluded,contributingRows:sampleRows,identity:{...structuredClone(eligible[0].identity),athleteId:null},queryId:options.queryId ?? null,phase:'current',chartStatus:'value',value:statistics.median,metricLabel:metric,athleteName:`Across ${statistics.count} athletes`});
    data.push({value:[statistics.low,statistics.q1,statistics.median,statistics.q3,statistics.high]});
    for(const row of sampleRows)if(row.value<statistics.lowerFence || row.value>statistics.upperFence){outliers.push(row);outlierData.push({value:[index,row.value]});}
  }
  if(!points.some(Boolean))return refuse('boxplotInsufficientData');
  const key=identityKey([model.widgetId,'boxplot',series.id]),zoom=settings.zoom==='local';
  const paint=/^#[0-9a-f]{6}$/i.test(series.definition.color ?? '')?series.definition.color:color(series.id);
  return {status:'ready',plots:[{enhanced:true,key,widgetId:model.widgetId,queryId:options.queryId ?? null,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(period),rowsBySeries:[points,outliers],
    settings:{...settings,applyPeriod:settings.applyPeriod && options.allowApplyPeriod!==false && Boolean(options.queryId)},precision:model.config.effective.numberFormat.maximumFractionDigits,valueAxis:'yAxis',
    caption:`${metric} · ${unit} · Across athletes · ${series.definition.analytical_aggregation ?? 'configured aggregation'} per athlete/${model.groupBy}`,
    warnings:['Distribution of returned athlete-level values, not individual session samples. Quartiles: linear interpolation (type 7); whiskers: observed values within 1.5 IQR. Outliers are statistical markers, not thresholds.',`At least 5 valid distinct athletes per bucket. Missing, problem and duplicate athlete values are excluded; ${omittedBuckets} buckets have insufficient or nonfinite statistics. Sample sizes and exclusions are available in point details.`],
    fingerprint:identityKey([options.contextId,options.queryId,options.widgetRevision,period,options.presentation,model.config.effective]),
    option:{animation:false,grid:{left:12,right:20,top:48,bottom:zoom?70:16,containLabel:true},legend:{show:model.config.effective.legend.visible,selectedMode:settings.legend,type:'scroll',left:12,right:12,top:4},tooltip:{trigger:'item',renderMode:'richText',confine:true},xAxis:{type:'category',data:buckets,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:unit,scale:true},
      series:[{id:key+':distribution',name:'Distribution',type:'boxplot',itemStyle:{color:paint,opacity:.65,borderColor:paint},label:{show:false},data},{id:key+':outliers',name:'Outliers',type:'scatter',symbolSize:8,itemStyle:{color:paint},label:{show:false},data:outlierData}],
      ...(zoom?{dataZoom:[{type:'slider',xAxisIndex:0,filterMode:'none',start:0,end:100},{type:'inside',xAxisIndex:0,filterMode:'none',zoomOnMouseWheel:false,moveOnMouseWheel:false,start:0,end:100}]}:{})}}]};
}
