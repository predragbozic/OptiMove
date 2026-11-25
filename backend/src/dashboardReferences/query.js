import { runDashboardBatchQuery, fetchAuthorizedActivityIds, mergeFilters } from '../trainingLoadDashboardQuery.js';
import { resolveShellCohort, intersectShellAthletes } from '../dashboardShellFilter.js';
import { radarReferenceAxis, teamAverageReference, referenceBand } from './calculations.js';
import { validReferenceConfig } from './contract.js';
const unavailable = reason => ({status:'unavailable',reason});
const valueOk = row => typeof row?.value==='number'&&Number.isFinite(row.value)&&!row.conflict&&!row.unitConflict&&!row.semanticConflict&&!row.typeConflict;
const safeName = value => typeof value==='string'&&value.trim()&&!/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(value)?value:'Athlete name unavailable';

// The caller has already passed the dashboard's independent view/owner and
// data_workspace gates. This function only narrows that fact set.
export async function attachReferenceResults({query,widgets,results,workspace,period,defaultFilter,requestFilter,shellFilter,referenceClubId,enabled}) {
 if(!widgets.some(widget=>widget.presentation_config?.schemaVersion===1&&widget.presentation_config.referenceConfig))return results;
 // Request-local only: complete SQL + parameters retain every workspace/filter boundary.
 const read=query,cache=new Map();query=(sql,params=[])=>{const key=JSON.stringify([sql,params]);if(!cache.has(key))cache.set(key,Promise.resolve().then(()=>read(sql,params)));return cache.get(key);};
 const cohort=enabled?await resolveShellCohort(workspace,shellFilter,query):null;
 const enriched=[];
 for(const result of results){
  const widget=widgets.find(item=>item.id===result.widgetId),config=widget?.presentation_config?.referenceConfig;
  if(!config){enriched.push(result);continue;}
  const deny=reason=>enriched.push({...result,references:{...unavailable(reason),mode:config.mode,axes:[]}});
  if(!enabled||!referenceClubId||config.clubId!==referenceClubId||!['club','team'].includes(workspace.dataWorkspaceType)||!validReferenceConfig(config)){deny('notAvailable');continue;}
  const effective=mergeFilters(defaultFilter,requestFilter,widget.local_filter_override);
  const selected=intersectShellAthletes(effective.athleteIds?.length?effective.athleteIds:undefined,cohort);
  let preset=null;
  if(config.source==='preset'){
   preset=(await query(`select t.name,v.version from training_load.dashboard_reference_tables t join training_load.dashboard_reference_versions v on v.table_id=t.id where t.id=$1 and t.club_id=$2 and v.id=$3 and v.published`,[config.tableId,referenceClubId,config.versionId])).rows[0];
   if(!preset){deny('notAvailable');continue;}
  }
  const personIds=[...new Set(result.series.flatMap(series=>(series.data?.current??[]).map(row=>row.athleteId).filter(Boolean)))].sort();
  const axes=[];
  for(const axis of config.axes){
   const series=widget.series.find(item=>item.id.toLowerCase()===axis.seriesId.toLowerCase());
   const actual=result.series.find(item=>item.seriesId===series?.id);
   if(!series?.metric_definition_id||actual?.status!=='ok'){axes.push({...unavailable('noData'),label:'Metric',points:[]});continue;}
   const definition=(await query(`select d.label,d.state,d.owner_scope,d.owner_club_id,v.unit,v.calculation from training_load.metric_definitions d join training_load.metric_definition_versions v on v.id=d.current_version_id where d.id=$1 and (d.owner_scope='system' or (d.owner_scope='club' and d.owner_club_id=$2)) and not exists(select 1 from training_load.metric_definition_club_hides h where h.club_id=$2 and h.metric_definition_id=d.id and h.shown_at is null)`,[series.metric_definition_id,referenceClubId])).rows[0];
   if(!definition||definition.state!=='active'){axes.push({...unavailable('metricUnavailable'),label:'Metric unavailable',points:[]});continue;}
   const base={label:definition.label,unit:definition.unit,seriesId:series.id};
   if(config.source==='preset'){
    const column=(await query('select unit,aggregation,data_level from training_load.dashboard_reference_columns where version_id=$1 and definition_id=$2',[config.versionId,series.metric_definition_id])).rows[0];
    if(!column||column.aggregation!==series.analytical_aggregation||column.data_level!==series.data_scope_level||!column.unit||column.unit!==definition.unit){axes.push({...base,...unavailable('incompatibleUnit'),points:[]});continue;}
    const rows=actual.data?.current??[];
    const ids=[...new Set(rows.map(row=>row.athleteId).filter(Boolean))];
    const people=ids.length?(await query(`select a.id,coalesce(nullif(a.display_name,''),a.full_name) name,public.athlete_position_in_force(a.id,$2) position_id from public.athletes a where a.id=any($1::uuid[])`,[ids,referenceClubId])).rows:[];
    const cells=(await query('select position_id,value_key,value::float8 value from training_load.dashboard_reference_cells where version_id=$1 and definition_id=$2',[config.versionId,series.metric_definition_id])).rows;
    const kinds=(await query('select key,name from training_load.dashboard_reference_value_kinds where version_id=$1',[config.versionId])).rows;
    const points=rows.map(row=>{
     const person=people.find(p=>p.id===row.athleteId);
     const point={personKey:'athlete_'+personIds.indexOf(row.athleteId),label:safeName(person?.name),actual:valueOk(row)?row.value:null};
     if(!row.athleteId||!person?.position_id)return {...point,...unavailable('noPosition')};
     if(!valueOk(row)||row.unit!==column.unit)return {...point,...unavailable('dataConflict')};
     const cell=key=>cells.find(c=>c.position_id===person.position_id&&c.value_key===key)?.value;
     const references=axis.valueKeys.map(key=>({key,label:kinds.find(kind=>kind.key===key)?.name??'Reference',value:cell(key)??null}));
     const radar=config.mode==='radar'?radarReferenceAxis({actual:row.value,anchor:cell(axis.anchorKey),references}):{status:references.some(ref=>typeof ref.value==='number')?'ok':'unavailable',reason:'missingReference',value:row.value};
     const band=axis.band?referenceBand(cell(axis.band.lowerKey),cell(axis.band.upperKey)):null;
     return {...point,...radar,references:references.map(ref=>({...ref,normalized:radar.references?.find(x=>x.key===ref.key)?.normalized??null})),...(band?{band}:{})};
    });
    axes.push({...base,status:points.some(p=>p.status==='ok')?'ready':'unavailable',reason:points[0]?.reason??'noData',points});
   }else{
    if(definition.calculation){axes.push({...base,...unavailable('calculatedMetric'),points:[]});continue;}
    const team=(await query('select id,name from public.teams where id=$1 and club_id=$2 and coalesce(is_active,true)',[config.teamId,referenceClubId])).rows[0];
    if(!team||workspace.dataWorkspaceType==='team'&&workspace.dataWorkspaceScopeId!==team.id){axes.push({...base,...unavailable('teamUnavailable'),points:[]});continue;}
    const args={...workspace,...period,athleteIds:selected};
    let activityIds=selected?.length===0?[]:await fetchAuthorizedActivityIds(args,query);
    if(effective.activityId)activityIds=activityIds.filter(id=>id===effective.activityId);
    if(effective.componentId){const own=(await query('select activity_id from training.activity_components where id=$1',[effective.componentId])).rows[0]?.activity_id;activityIds=activityIds.filter(id=>id===own);}
    if(activityIds.length){const types=(await query('select distinct activity_type_key from training.activities where id=any($1::uuid[])',[activityIds])).rows;if(types.length>1){axes.push({...base,...unavailable('mixedActivities'),points:[]});continue;}}
    const roster=activityIds.length?(await query(`select distinct r.athlete_id id from unnest($1::uuid[]) a(id) cross join lateral training.activity_roster(a.id) r where exists(select 1 from public.athlete_memberships m where m.athlete_id=r.athlete_id and m.team_id=$2 and m.status='active') and ($3::uuid[] is null or r.athlete_id=any($3::uuid[]))`,[activityIds,team.id,selected??null])).rows.map(row=>row.id):[];
    const measured=await runDashboardBatchQuery({...workspace,...period},[{widgetId:widget.id,seriesId:series.id,metricDefinitionId:series.metric_definition_id,builtInSeriesKey:null,dataScopeLevel:series.data_scope_level,aggregationRolePolicy:series.aggregation_role_policy,coveragePolicy:series.coverage_policy,sourcePolicy:series.source_policy,sourceConnectionId:series.source_connection_id,groupBy:'athlete',analyticalAggregation:series.analytical_aggregation,athleteIds:roster,activityId:effective.activityId,componentId:effective.componentId,shellConstrained:true}],{queryRunner:query,referenceMeasurementsOnly:true});
    const perAthlete=new Map();
    for(const row of measured[0]?.data?.current??[]){const valid=valueOk(row)&&row.unit===definition.unit;if(perAthlete.has(row.athleteId))perAthlete.set(row.athleteId,{athleteId:row.athleteId,status:'conflict',value:null,unit:definition.unit});else perAthlete.set(row.athleteId,{athleteId:row.athleteId,status:valid?'ok':'conflict',value:valid?row.value:null,unit:row.unit});}
    const average=teamAverageReference({rosterAthleteIds:roster,athleteValues:[...perAthlete.values()],unit:definition.unit,calculated:Boolean(definition.calculation)});
    const points=(actual.data?.current??[]).map(row=>({personKey:'group',label:team.name,actual:valueOk(row)?row.value:null,...(average.status==='ok'&&valueOk(row)&&row.unit===definition.unit?(config.mode==='radar'?radarReferenceAxis({actual:row.value,anchor:average.value,references:[{key:'teamAverage',value:average.value}]}):{status:'ok',value:row.value}):average.status==='ok'?unavailable('dataConflict'):average),references:[{key:'teamAverage',label:'Team average',value:average.value,normalized:average.status==='ok'?100:null}],includedAthletes:average.includedAthletes??0,leftOutAthletes:average.leftOutAthletes??0}));
    axes.push({...base,status:points.some(p=>p.status==='ok')?'ready':'unavailable',reason:average.reason??'noData',points});
   }
  }
  enriched.push({...result,references:{status:axes.every(axis=>axis.status==='ready')?'ready':'partial',mode:config.mode,source:config.source,tableName:preset?.name??'Team average',version:preset?.version??null,axes}});
 }
 return enriched;
}
