// Synthetic, measured values only. Shared by backend HTTP and browser tests;
// this helper never imports browser tooling and accepts only the test-owned client.
import crypto from 'node:crypto';
export async function seedGalleryMeasurements(q,{actorId,clubId,athleteIds,teamId=null,dates=['2026-11-05','2026-11-06'],existingDefinitions=null}){
 const definitions=existingDefinitions??[];
 for(const name of (existingDefinitions?[]:['Distance part A','Distance part B'])){
  const id=(await q.query("insert into training_load.metric_definitions(key,label,owner_scope,state,created_by_user_id) values($1,$2,'system','active',$3) returning id",['gallery_'+crypto.randomUUID(),name,actorId])).rows[0].id;
  const versionId=(await q.query("insert into training_load.metric_definition_versions(metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id) values($1,1,'m','numeric','sum',$2) returning id",[id,actorId])).rows[0].id;
  await q.query('update training_load.metric_definitions set current_version_id=$2 where id=$1',[id,versionId]);await q.query("insert into training_load.metric_definition_scope_capabilities(metric_definition_id,scope_level) values($1,'session')",[id]);definitions.push({id,versionId,name});
 }
 const connection=(await q.query("insert into training_load.metric_source_connections(source_system,owner_scope,owner_club_id,owner_team_id) values('gallery-test',$1,$2,$3) returning id",[teamId?'team':'club',teamId?null:clubId,teamId])).rows[0].id;
 for(const [index,athlete]of athleteIds.slice(0,3).entries())for(const date of dates){
  const instant=date+'T10:00:00Z';
  const activity=(await q.query("insert into training.activities(activity_type_key,name,occurred_local_date,started_at,timezone_snapshot,owner_scope,owner_club_id,owner_team_id,origin,lifecycle_state,created_by_user_id) values('training_session','Full training',$1,$2,'UTC',$3,$4,$5,'manual','confirmed',$6) returning id",[date,instant,teamId?'team':'club',teamId?null:clubId,teamId,actorId])).rows[0].id;
  const participant=(await q.query("insert into training.activity_participants(activity_id,athlete_id,local_date,timezone_snapshot,participation_status) values($1,$2,$3,'UTC','participated') returning id",[activity,athlete,date])).rows[0].id;
  const event=(await q.query("insert into training_load.metric_events(event_name,occurred_date,occurred_instant,scope_level,owner_scope,owner_club_id,owner_team_id,source_connection_id,created_by_user_id) values('Full training',$1,$2,'session',$3,$4,$5,$6,$7) returning id",[date,instant,teamId?'team':'club',teamId?null:clubId,teamId,connection,actorId])).rows[0].id;
  const ep=(await q.query("insert into training_load.metric_event_participants(event_id,athlete_id,athlete_timezone_snapshot) values($1,$2,'UTC') returning id",[event,athlete])).rows[0].id;
  await q.query("insert into training.activity_metric_event_links(activity_id,metric_event_id,link_method,link_status) values($1,$2,'manual','confirmed')",[activity,event]);
  await q.query("insert into training.activity_participant_metric_participant_links(activity_participant_id,metric_event_participant_id,link_method,link_status) values($1,$2,'manual','confirmed')",[participant,ep]);
  const occasion=(await q.query("insert into training_load.metric_measurement_occasions(event_participant_id,entry_method) values($1,'manual') returning id",[ep])).rows[0].id;
  for(const [component,definition]of definitions.entries())await q.query("insert into training_load.metric_values(occasion_id,metric_definition_id,metric_definition_version_id,value_numeric,unit_at_capture,aggregation_role,coverage) values($1,$2,$3,$4,'m','standalone','not_applicable')",[occasion,definition.id,definition.versionId,(index+1)*(component+1)*10]);
 }
 return definitions;
}
export async function seedGalleryDashboard(q,{actorId,ownerId=actorId,workspaceType='platform',scopeId=null,definitions,title='Gallery browser'}){
 const dashboard=(await q.query("insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,data_workspace_scope_id,created_by_user_id) values($1,'user',$2,$3,$4,$5) returning *",[title,ownerId,workspaceType,scopeId,actorId])).rows[0];
 const home=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1',[dashboard.id])).rows[0];
 await q.query('update training_load.dashboard_pages set period_config=$2 where id=$1',[home.id,{schemaVersion:1,mode:'fixed',dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'}]);
 const widgets=[];
 for(const [index,kind]of ['area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot'].entries()){
  const widget=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by,display_config) values($1,$2,$3,$4,$5,$6,6,4,$4,'day',$7) returning *",[dashboard.id,kind==='area'?'line_chart':'bar_chart',kind,index,index%2*6,Math.floor(index/2)*4,{schemaVersion:2,numberFormat:{maximumFractionDigits:2},legend:{visible:true}}])).rows[0];
  const ids=[];for(const [n,definition]of (['combined','scatter','stacked'].includes(kind)?definitions:definitions.slice(0,1)).entries()){
   const revision=(await q.query('select revision from training_load.dashboard_widgets where id=$1',[widget.id])).rows[0].revision;
   const added=(await q.query("select * from training_load.add_series($1,$2,$3,$4,null,null,$5,null,null,'manual',null,'session','none')",[widget.id,revision,n,definition.id,n&&kind==='combined'?'secondary':'primary'])).rows[0];ids.push(added.series_id);
  }
  const shape={schemaVersion:1,kind,seriesIds:ids,...(kind==='stacked'?{additive:true}:{}),...(kind==='combined'?{bindings:ids.map((seriesId,n)=>({seriesId,mark:n?'line':'bar',axis:n}))}:{})};
  await q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[widget.id,{schemaVersion:1,chartShape:shape,chartInteractions:{tooltip:{mode:'formatted'},legend:{toggle:true},zoom:{mode:'local',applyPeriodAction:true},pointSelection:{mode:'details'},yAxis:{mode:'auto'}}}]);widgets.push(widget.id);
 }
 return{dashboard,home,widgets};
}
