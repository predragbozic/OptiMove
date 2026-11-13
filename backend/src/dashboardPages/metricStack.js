import { validateContract, isUuid } from '../dashboardSimple/schema.js';
import { buildMetricPairs } from './metricPairs.js';

const lower=value=>typeof value==='string'?value.toLowerCase():value;
const key=row=>JSON.stringify([lower(row.athleteId),row.bucketKey]);
const limits={maxComponents:8,maxAthletes:20,maxBuckets:8000};

// The author declares semantic additivity; server checks the declared set and
// technical compatibility. Units alone are never treated as proof of additivity.
export function buildMetricStack({widget,result,period,queryId}) {
  const definition=widget?.presentation_config?.stackDefinition;
  const base={schemaVersion:1,status:'unavailable',widgetId:widget?.id ?? null,queryId,resolvedPeriod:structuredClone(period),definition:definition?structuredClone(definition):null,bindings:[],buckets:[],omissions:[],limits:{...limits}};
  const refuse=(reason,status='unavailable')=>({...base,status,reason});
  if(widget?.presentation_config?.schemaVersion!==1 || widget.presentation_config.chartVariant!=='stacked' || !validateContract('presentationV1',widget.presentation_config).valid || widget.widget_type!=='bar_chart' || !['day','week'].includes(widget.group_by) || !isUuid(queryId))return refuse('invalidStackConfiguration');
  const series=widget.series ?? [];
  if(series.length<2 || series.length>8 || series.some(s=>!isUuid(s.metric_definition_id) || s.built_in_series_key || s.axis!=='primary' || s.resolution_status && s.resolution_status!=='resolved' || s.analytical_aggregation!=='sum' || s.aggregation_role_policy!=='standalone_only' || s.coverage_policy!=='complete_only' || s.comparison_period!=null || !['day','session','component'].includes(s.data_scope_level)))return refuse('incompatibleComponents');
  const ids=series.map(s=>lower(s.metric_definition_id));
  if(new Set(ids).size!==series.length || definition.components.length!==series.length || definition.components.some(metric=>!ids.includes(lower(metric))))return refuse('componentDeclarationChanged');
  const fields=['data_scope_level','source_policy','source_connection_id'];
  if(!series[0].source_policy || series.some(s=>fields.some(field=>(s[field] ?? null)!==(series[0][field] ?? null))))return refuse('incompatibleComponentPolicies');
  const proofs=series.slice(1).map(other=>buildMetricPairs({widget,result,request:{schemaVersion:1,widgetId:widget.id,xSeriesId:series[0].id,ySeriesId:other.id},period,queryId}));
  const invalid=proofs.find(proof=>!['ready','partial','empty'].includes(proof.status));
  if(invalid)return refuse(invalid.reason,invalid.status==='requiresChoice'?'requiresChoice':'unavailable');
  const bindings=[proofs[0].bindings.x,...proofs.map(proof=>proof.bindings.y)];
  if(bindings.some((binding,index)=>binding.unit!==definition.unit && result.series.find(s=>lower(s.seriesId)===lower(series[index].id))?.data.current.length))return refuse('componentUnitMismatch');
  const cells=new Map(),athletes=new Set();
  for(const proof of proofs){
    for(const row of [...proof.pairs,...proof.omissions]){if(!cells.has(key(row)))cells.set(key(row),{athleteId:row.athleteId,bucketKey:row.bucketKey});athletes.add(row.athleteId);}
  }
  if(athletes.size>20 || cells.size>8000)return refuse('stackLimitExceeded','requiresChoice');
  const lookup=proofs.map(proof=>new Map(proof.pairs.map(pair=>[key(pair),pair]))),buckets=[],omissions=[];
  for(const [cellKey,cell]of [...cells].sort(([a],[b])=>a.localeCompare(b))){
    const pairs=lookup.map(map=>map.get(cellKey));
    if(pairs.some(pair=>!pair)){omissions.push({...cell,reasons:['incompleteOrProblemComponents']});continue;}
    const components=[pairs[0].x,...pairs.map(pair=>pair.y)];
    if(components.some(point=>point.value<0)){omissions.push({...cell,reasons:['negativeComponent']});continue;}
    const total=components.reduce((sum,point)=>sum+point.value,0);
    if(!Number.isFinite(total)){omissions.push({...cell,reasons:['nonFiniteTotal']});continue;}
    buckets.push({...cell,components:structuredClone(components),total});
  }
  return {...base,status:buckets.length?omissions.length?'partial':'ready':'empty',bindings:structuredClone(bindings),buckets,omissions};
}
