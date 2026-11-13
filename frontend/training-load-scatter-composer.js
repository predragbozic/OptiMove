// Consume server-confirmed observations only. No local joining or statistics.
export function composeScatter(model,labelForSeries,options,settings,{identityKey,buckets:makeBuckets,color}) {
  const refuse=status=>({status,plots:[]}),server=options.metricPairs;
  if(model.series.length!==2 || !['day','week'].includes(model.groupBy))return refuse('scatterPairsRequired');
  const axes=['primary','secondary'].map(axis=>model.series.filter(series=>series.definition.axis===axis));
  if(axes.some(matches=>matches.length!==1))return refuse('scatterPairsRequired');
  const series=axes.map(matches=>matches[0]),period=options.resolvedPeriod ?? model.period,buckets=makeBuckets(period,model.groupBy);
  if(!buckets || series.some(s=>s.status!=='ready' || s.definition.comparison_period || s.comparison.length || s.comparisonRange || s.reasons.length))return refuse('scatterPairsRequired');
  if(!server || server.schemaVersion!==1 || !options.queryId || server.queryId!==options.queryId || server.widgetId!==model.widgetId || server.xSeriesId!==series[0].id || server.ySeriesId!==series[1].id || identityKey(server.resolvedPeriod)!==identityKey(period) || !['ready','partial','empty'].includes(server.status) || !Array.isArray(server.pairs) || !Array.isArray(server.omissions))return refuse('scatterPairsRequired');
  if(server.pairs.length>8000 || server.omissions.length>8000)return refuse('scatterPairsRequired');
  const bindingFields={metricDefinitionId:'metric_definition_id',builtInSeriesKey:'built_in_series_key',dataScopeLevel:'data_scope_level',analyticalAggregation:'analytical_aggregation',sourcePolicy:'source_policy',sourceConnectionId:'source_connection_id',aggregationRolePolicy:'aggregation_role_policy',coveragePolicy:'coverage_policy'};
  for(const [index,side]of ['x','y'].entries()){
    const binding=server.bindings?.[side],definition=series[index].definition;
    if(!binding || binding.seriesId!==definition.id || Object.entries(bindingFields).some(([key,field])=>(binding[key] ?? null)!==(definition[field] ?? null)))return refuse('scatterPairsRequired');
  }
  if(!server.pairs.length)return server.status==='empty'?refuse('scatterNoPairs'):refuse('scatterPairsRequired');
  if(server.status==='empty' || (server.status==='partial')!==(server.omissions.length>0))return refuse('scatterPairsRequired');
  const seen=new Set(),groups=new Map();
  const names=new Map((options.athletes ?? []).map(athlete=>[athlete.id,athlete.name]));
  const athleteName=id=>names.get(id) || `Athlete ${id}`;
  for(const pair of server.pairs){
    if(!pair || typeof pair.athleteId!=='string' || !buckets.includes(pair.bucketKey))return refuse('scatterPairsRequired');
    const key=identityKey([pair.athleteId,pair.bucketKey]);if(seen.has(key))return refuse('scatterPairsRequired');seen.add(key);
    const rows=[];
    for(const [index,side]of ['x','y'].entries()){
      const point=pair[side],row=point && Number.isSafeInteger(point.rowIndex) && point.rowIndex>=0 ? series[index].current[point.rowIndex] : null;
      if(!row || row.rowIndex!==point.rowIndex || point.seriesId!==series[index].id || row.identity.athleteId!==pair.athleteId || row.identity.bucketKey!==pair.bucketKey || row.chartStatus!=='value' || typeof point.value!=='number' || !Number.isFinite(point.value) || point.value!==row.value || point.unit!==row.identity.unit || point.unit!==server.bindings[side].unit || identityKey(point.source)!==identityKey(row.identity.source))return refuse('scatterPairsRequired');
      rows.push({...structuredClone(row),identityKey:identityKey(row.identity),phase:'current',queryId:options.queryId,athleteName:athleteName(pair.athleteId),metricLabel:labelForSeries(series[index].definition)});
    }
    const point={...rows[0],pairedPoint:rows[1]};
    if(!groups.has(pair.athleteId))groups.set(pair.athleteId,[]);groups.get(pair.athleteId).push(point);
  }
  if(groups.size>20)return refuse('requiresChoice');
  const labels=[...groups.keys()].map(athleteName),ids=[...groups.keys()];
  const namesUnique=ids.map((id,index)=>labels.filter(label=>label===labels[index]).length>1?`${labels[index]} (${id})`:labels[index]);
  if(new Set(namesUnique).size!==namesUnique.length)for(let i=0;i<ids.length;i++)namesUnique[i]=JSON.stringify([labels[i],ids[i]]);
  const xLabel=`${labelForSeries(series[0].definition)} · ${server.bindings.x.unit ?? 'Unit not specified'}`,yLabel=`${labelForSeries(series[1].definition)} · ${server.bindings.y.unit ?? 'Unit not specified'}`;
  const key=identityKey([model.widgetId,'scatter',series.map(s=>s.id)]),rowsBySeries=[...groups.values()];
  return {status:'ready',plots:[{enhanced:true,key,widgetId:model.widgetId,queryId:options.queryId,contextId:options.contextId ?? null,groupBy:model.groupBy,buckets,resolvedPeriod:structuredClone(period),rowsBySeries,settings:{...settings,applyPeriod:false},warnings:server.omissions.length?[`${server.omissions.length} unpaired or problem observations were omitted. Inspect Values and status for the original rows.`]:[],precision:model.config.effective.numberFormat.maximumFractionDigits,valueAxis:'yAxis',
    caption:`X: ${xLabel} / Y: ${yLabel}`,
    fingerprint:identityKey([options.contextId,options.queryId,options.widgetRevision,period,options.presentation,model.config.effective]),
    option:{animation:false,grid:{left:18,right:24,top:58,bottom:70,containLabel:true},legend:{show:model.config.effective.legend.visible,selectedMode:settings.legend,type:'scroll',left:12,right:12,top:4},tooltip:{trigger:'item',renderMode:'richText',confine:true},
      xAxis:{type:'value',name:xLabel,nameLocation:'middle',nameGap:40,scale:false,axisLabel:{hideOverlap:true}},yAxis:{type:'value',name:yLabel,scale:false,axisLabel:{hideOverlap:true}},
      series:rowsBySeries.map((points,index)=>({id:identityKey([key,ids[index]]),name:namesUnique[index],type:'scatter',symbolSize:9,itemStyle:{color:color(ids[index])},label:{show:model.config.effective.valueLabels.visible,position:'top'},data:points.map(point=>({value:[point.value,point.pairedPoint.value]}))}))}}]};
}
