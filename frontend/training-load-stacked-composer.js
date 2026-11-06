export function validStackDefinition(value) {
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===4 && value.schemaVersion===1 && value.semantics==='non-overlapping-additive' && typeof value.unit==='string' && value.unit.length>0 && value.unit.length<=100 && value.unit.trim()===value.unit && Array.isArray(value.components) && value.components.length>=2 && value.components.length<=8 && value.components.every(id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) && new Set(value.components.map(id=>id.toLowerCase())).size===value.components.length;
}

export function composeStacked(model,labelForSeries,options,settings,{identityKey,buckets:makeBuckets,color}) {
  const refuse=status=>({status,plots:[]}),proof=options.metricStack,definition=options.presentation.stackDefinition;
  const series=model.series,period=options.resolvedPeriod ?? model.period,buckets=makeBuckets(period,model.groupBy);
  if(!['day','week'].includes(model.groupBy) || !buckets || series.length<2 || series.length>8 || series.some(s=>s.status!=='ready' || s.definition.axis!=='primary' || s.definition.comparison_period || s.comparison.length || s.comparisonRange || s.reasons.length))return refuse('stackProofRequired');
  if(!proof || proof.schemaVersion!==1 || !options.queryId || proof.queryId!==options.queryId || proof.widgetId!==model.widgetId || identityKey(proof.resolvedPeriod)!==identityKey(period) || identityKey(proof.definition)!==identityKey(definition) || !['ready','partial','empty'].includes(proof.status) || !Array.isArray(proof.bindings) || proof.bindings.length!==series.length || !Array.isArray(proof.buckets) || !Array.isArray(proof.omissions) || proof.buckets.length+proof.omissions.length>8000)return refuse('stackProofRequired');
  const metadata={metricDefinitionId:'metric_definition_id',builtInSeriesKey:'built_in_series_key',dataScopeLevel:'data_scope_level',analyticalAggregation:'analytical_aggregation',sourcePolicy:'source_policy',sourceConnectionId:'source_connection_id',aggregationRolePolicy:'aggregation_role_policy',coveragePolicy:'coverage_policy'};
  const metricIds=series.map(s=>s.definition.metric_definition_id?.toLowerCase());
  if(new Set(metricIds).size!==series.length || definition.components.length!==series.length || definition.components.some(id=>!metricIds.includes(id.toLowerCase())))return refuse('stackProofRequired');
  for(const [i,s]of series.entries()){
    const b=proof.bindings[i],d=s.definition;
    if(!b || b.seriesId!==s.id || Object.entries(metadata).some(([key,field])=>(b[key]??null)!==(d[field]??null)) || d.built_in_series_key || d.analytical_aggregation!=='sum' || d.aggregation_role_policy!=='standalone_only' || d.coverage_policy!=='complete_only' || ['data_scope_level','source_policy','source_connection_id'].some(field=>(d[field]??null)!==(series[0].definition[field]??null)))return refuse('stackProofRequired');
  }
  if(!proof.buckets.length)return proof.status==='empty'?refuse('stackNoData'):refuse('stackProofRequired');
  if(proof.status==='empty' || (proof.status==='partial')!==(proof.omissions.length>0))return refuse('stackProofRequired');
  const cells=new Map(),athletes=new Set(),cellKey=row=>identityKey([row.athleteId,row.bucketKey]);
  for(const omitted of proof.omissions){if(!omitted || typeof omitted.athleteId!=='string' || !buckets.includes(omitted.bucketKey) || cells.has(cellKey(omitted)))return refuse('stackProofRequired');cells.set(cellKey(omitted),null);athletes.add(omitted.athleteId);}
  for(const bucket of proof.buckets){
    if(!bucket || typeof bucket.athleteId!=='string' || !buckets.includes(bucket.bucketKey) || cells.has(cellKey(bucket)) || !Array.isArray(bucket.components) || bucket.components.length!==series.length || !Number.isFinite(bucket.total))return refuse('stackProofRequired');
    const points=[];
    for(const [i,point]of bucket.components.entries()){
      const row=point && Number.isSafeInteger(point.rowIndex) && point.rowIndex>=0?series[i].current[point.rowIndex]:null;
      if(!row || point.seriesId!==series[i].id || row.identity.athleteId!==bucket.athleteId || row.identity.bucketKey!==bucket.bucketKey || row.rowIndex!==point.rowIndex || row.chartStatus!=='value' || !Number.isFinite(point.value) || point.value<0 || point.value!==row.value || point.unit!==definition.unit || point.unit!==row.identity.unit || proof.bindings[i].unit!==definition.unit || identityKey(point.source)!==identityKey(row.identity.source))return refuse('stackProofRequired');
      points.push({...structuredClone(row),identityKey:identityKey(row.identity),phase:'current',queryId:options.queryId,metricLabel:labelForSeries(series[i].definition),stackTotal:bucket.total});
    }
    if(points.reduce((sum,p)=>sum+p.value,0)!==bucket.total)return refuse('stackProofRequired');
    cells.set(cellKey(bucket),points);athletes.add(bucket.athleteId);
  }
  if(athletes.size>20)return refuse('requiresChoice');
  const ids=[...athletes].sort(),names=ids.map(id=>options.athletes?.find(a=>a.id===id)?.name || `Athlete ${id}`);
  const labels=series.map(s=>labelForSeries(s.definition));
  const uniqueLabels=labels.map((name,i)=>labels.filter(label=>label===name).length>1?`${name} (${series[i].definition.metric_definition_id})`:name);
  if(new Set(uniqueLabels).size!==uniqueLabels.length)for(let i=0;i<uniqueLabels.length;i++)uniqueLabels[i]=identityKey([labels[i],series[i].id]);
  return {status:'ready',plots:ids.map((athleteId,index)=>{
    const athleteName=names.filter(name=>name===names[index]).length>1?`${names[index]} (${athleteId})`:names[index];
    const rowsBySeries=series.map((_,i)=>buckets.map(bucket=>{const row=cells.get(identityKey([athleteId,bucket]))?.[i];return row?{...row,athleteName}:null;}));
    const key=identityKey([model.widgetId,'stacked',athleteId]),zoom=settings.zoom==='local';
    const omitted=proof.omissions.filter(row=>row.athleteId===athleteId).length;
    return {enhanced:true,key,widgetId:model.widgetId,queryId:options.queryId,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(period),rowsBySeries,settings:{...settings,applyPeriod:settings.applyPeriod && options.allowApplyPeriod!==false},warnings:['Components are declared non-overlapping by the author. Do not combine a total with its parts.',...(omitted?[`${omitted} incomplete or problem buckets were omitted in full. Original values remain in the table.`]:[])],precision:model.config.effective.numberFormat.maximumFractionDigits,valueAxis:'yAxis',caption:`${athleteName} · Additive components · ${definition.unit}`,
      fingerprint:identityKey([options.contextId,options.queryId,options.widgetRevision,period,options.presentation,model.config.effective]),
      option:{animation:false,grid:{left:12,right:20,top:48,bottom:zoom?70:16,containLabel:true},legend:{show:model.config.effective.legend.visible,selectedMode:settings.legend,type:'scroll',left:12,right:12,top:4},tooltip:{trigger:'item',renderMode:'richText',confine:true},xAxis:{type:'category',data:buckets,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:definition.unit,scale:false},
        series:series.map((s,i)=>({id:identityKey([key,s.id]),name:uniqueLabels[i],type:'bar',stack:'declared-components',barMaxWidth:40,itemStyle:{color:/^#[0-9a-f]{6}$/i.test(s.definition.color ?? '')?s.definition.color:color(s.definition.metric_definition_id)},label:{show:model.config.effective.valueLabels.visible,position:'inside'},data:rowsBySeries[i].map(point=>point?{value:point.value}:null)})),
        ...(zoom?{dataZoom:[{type:'slider',filterMode:'none',start:0,end:100},{type:'inside',filterMode:'none',zoomOnMouseWheel:false,moveOnMouseWheel:false,start:0,end:100}]}:{})}};
  })};
}
