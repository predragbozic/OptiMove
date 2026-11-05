import { isUuid, validateContract } from '../dashboardSimple/schema.js';

const limits=Object.freeze({maxAthletes:20,maxPairs:8000,maxRowsPerAxis:16000});
const sourceFields=['source','sourceId','sourceConnectionId','source_connection_id','sourceIdentityId','source_identity_id','sourceSystem','source_system','entryMethod','entry_method','sourceMetricId','sourceMetricDefinitionId','sourceMetricMappingVersionId','sourceProvenance','provenance'];
const problemFlags=['conflict','unitConflict','typeConflict','semanticConflict'];
const plain=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const id=value=>typeof value==='string'?value.toLowerCase():value;
const copy=value=>value===undefined?null:structuredClone(value);
const date=value=>typeof value==='string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const shift=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const monday=value=>shift(value,-(new Date(value+'T00:00:00Z').getUTCDay()+6)%7);
const binding=series=>({seriesId:series.id,metricDefinitionId:series.metric_definition_id ?? null,builtInSeriesKey:series.built_in_series_key ?? null,dataScopeLevel:series.data_scope_level ?? null,analyticalAggregation:series.analytical_aggregation ?? null,sourcePolicy:series.source_policy ?? null,sourceConnectionId:series.source_connection_id ?? null,aggregationRolePolicy:series.aggregation_role_policy ?? null,coveragePolicy:series.coverage_policy ?? null});

// Only server-read, already-authorized results enter this function. It joins
// observations; it never queries, aggregates, interpolates or chooses a duplicate.
export function buildMetricPairs({widget,result,request,period,queryId}) {
  const base={schemaVersion:1,status:'unavailable',widgetId:widget?.id ?? null,xSeriesId:id(request?.xSeriesId),ySeriesId:id(request?.ySeriesId),queryId,resolvedPeriod:copy(period),bindings:null,pairs:[],omissions:[],limits:{...limits}};
  const refuse=(reason,status='unavailable')=>({...base,status,reason});
  if(!widget || !request || request.schemaVersion!==1 || !isUuid(queryId) || !isUuid(request.widgetId) || id(request.widgetId)!==id(widget.id) || !isUuid(request.xSeriesId) || !isUuid(request.ySeriesId) || id(request.xSeriesId)===id(request.ySeriesId))return refuse('invalidPairing');
  if(!['line_chart','bar_chart'].includes(widget.widget_type) || !['day','week'].includes(widget.group_by))return refuse('unsupportedWidget');
  if(!validateContract('context',{kind:'legacyDashboard',period}).valid)return refuse('invalidPeriod');
  const definitions=[request.xSeriesId,request.ySeriesId].map(key=>(widget.series ?? []).filter(series=>id(series.id)===id(key)));
  if(definitions.some(matches=>matches.length!==1))return refuse('seriesNotFound');
  const series=definitions.map(matches=>matches[0]);
  if(series.some(item=>(item.resolution_status ?? 'resolved')!=='resolved' || item.comparison_period!=null))return refuse('seriesNotReady');
  if(!result || id(result.widgetId)!==id(widget.id) || !Array.isArray(result.series))return refuse('invalidResult');
  const results=series.map(item=>result.series.filter(entry=>id(entry.seriesId)===id(item.id)));
  if(results.some(matches=>matches.length!==1))return refuse('invalidResult');
  const axis=results.map(matches=>matches[0]);
  if(axis.some(item=>item.status!=='ok' || !plain(item.data) || !Array.isArray(item.data.current) || item.data.comparisonRange!=null || item.data.comparison!=null && (!Array.isArray(item.data.comparison) || item.data.comparison.length)))return refuse('seriesNotReady');
  if(axis.some(item=>item.data.current.length>limits.maxRowsPerAxis))return refuse('rowLimitExceeded','requiresChoice');
  const buckets=new Set();
  const start=widget.group_by==='week'?monday(period.dateFrom):period.dateFrom;
  for(let instant=Date.parse(start+'T00:00:00Z'),end=Date.parse(period.dateTo+'T00:00:00Z');instant<=end;instant+=(widget.group_by==='week'?7:1)*86400000)buckets.add(new Date(instant).toISOString().slice(0,10));
  const athletes=new Set(),cells=new Map(),units=[];
  for(const [axisIndex,item]of axis.entries()){
    const axisUnits=new Set();
    for(const [rowIndex,row]of item.data.current.entries()){
      if(!plain(row) || !Object.hasOwn(row,'value') || !isUuid(row.athleteId) || !date(row.bucketKey) || !buckets.has(row.bucketKey) || row.unit!=null && typeof row.unit!=='string' || problemFlags.some(flag=>row[flag]!==undefined && typeof row[flag]!=='boolean'))return refuse('invalidObservation');
      if(row.value!==null && (typeof row.value!=='number' || !Number.isFinite(row.value)))return refuse('numericSeriesRequired');
      const athleteId=id(row.athleteId),key=JSON.stringify([athleteId,row.bucketKey]);
      athletes.add(athleteId);axisUnits.add(row.unit ?? null);
      if(!cells.has(key))cells.set(key,{athleteId,bucketKey:row.bucketKey,rows:[[],[]]});
      cells.get(key).rows[axisIndex].push({rowIndex,row});
    }
    if(axisUnits.size>1)return refuse('ambiguousAxisUnit');
    units.push(axisUnits.size?[...axisUnits][0]:null);
  }
  if(athletes.size>limits.maxAthletes)return refuse('athleteLimitExceeded','requiresChoice');
  if(cells.size>limits.maxPairs)return refuse('pairLimitExceeded','requiresChoice');
  const pairs=[],omissions=[];
  const point=(entry,index)=>({seriesId:series[index].id,rowIndex:entry.rowIndex,value:entry.row.value,unit:entry.row.unit ?? null,source:{policy:series[index].source_policy ?? null,configuredConnectionId:series[index].source_connection_id ?? null,reported:Object.fromEntries(sourceFields.filter(key=>Object.hasOwn(entry.row,key)).map(key=>[key,copy(entry.row[key])]))}});
  for(const cell of [...cells.values()].sort((a,b)=>a.athleteId.localeCompare(b.athleteId)||a.bucketKey.localeCompare(b.bucketKey))){
    const reasons=[];
    for(const [index,entries]of cell.rows.entries()){
      const name=index===0?'X':'Y';
      if(entries.length!==1)reasons.push(entries.length?'duplicate'+name:'missing'+name);
      else if(problemFlags.some(flag=>entries[0].row[flag]===true) || entries[0].row.error!=null)reasons.push('problem'+name);
      else if(entries[0].row.value===null)reasons.push('missingValue'+name);
    }
    if(reasons.length)omissions.push({athleteId:cell.athleteId,bucketKey:cell.bucketKey,reasons,xRowIndexes:cell.rows[0].map(entry=>entry.rowIndex),yRowIndexes:cell.rows[1].map(entry=>entry.rowIndex)});
    else pairs.push({athleteId:cell.athleteId,bucketKey:cell.bucketKey,x:point(cell.rows[0][0],0),y:point(cell.rows[1][0],1)});
  }
  return {...base,status:pairs.length?omissions.length?'partial':'ready':'empty',bindings:{x:{...binding(series[0]),unit:units[0]},y:{...binding(series[1]),unit:units[1]}},pairs,omissions};
}
