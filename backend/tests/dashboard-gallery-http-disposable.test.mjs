import {seedGalleryMeasurements} from './support/dashboard-gallery-seed.mjs';
import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import pg from 'pg';
import {startDashboardShellFixture} from './support/dashboard-shell-fixture.mjs';import {draft} from './fixtures/dashboard-simple/contracts.mjs';
let world,q,actor,dashboard,home,definitions;const saved=[];
const period={dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'};
async function api(path,body,method='POST',account=actor){const r=await fetch(world.baseUrl+path,{method,headers:{Cookie:`optimove_session=${account.sessionToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();return{status:r.status,text,body:JSON.parse(text)}}
before(async()=>{
 world=await startDashboardShellFixture({envOverrides:{DASHBOARD_PAGES_ENABLED:'true',DASHBOARD_REFERENCES_ENABLED:'true',DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'1',DASHBOARD_SIMPLE_KEY_ID:'gallery-http-test',DASHBOARD_SIMPLE_KEY_BASE64:crypto.randomBytes(32).toString('base64')}});
 q=new pg.Client({connectionString:world.databaseUrl});await q.connect();actor=world.accounts[0];
 dashboard=(await api('/api/training-load/dashboards',{name:'Gallery HTTP'})).body.dashboard;assert.ok(dashboard);
 home=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[dashboard.id])).rows[0].id;
 for(const athlete of world.ids.athleteIds.slice(0,2)){
  const activity=(await q.query("insert into training.activities(activity_type_key,name,occurred_local_date,started_at,timezone_snapshot,owner_scope,owner_club_id,origin,lifecycle_state,created_by_user_id) values('training_session','Gallery session','2026-11-03','2026-11-03T10:00Z','UTC','club',$1,'manual','confirmed',$2) returning id",[world.ids.clubA,actor.id])).rows[0].id;
  await q.query("insert into training.activity_participants(activity_id,athlete_id,local_date,timezone_snapshot,participation_status) values($1,$2,'2026-11-03','UTC','participated')",[activity,athlete]);
 }
});
after(async()=>{await q?.end();await world?.stop()});
for(const kind of ['area','horizontal_bar','heatmap','boxplot'])test(kind+': real preview → atomic save/replay → saved query uses the same chart model',async()=>{
 const inputDraft=draft();inputDraft.title=kind;inputDraft.metricRef={kind:'builtin',key:'session_count'};inputDraft.athleteSelection={mode:'allAuthorized'};
 inputDraft.view={type:kind==='area'?'line_chart':'bar_chart',groupBy:'day',dataScopeLevel:'day',analyticalAggregation:['heatmap','boxplot'].includes(kind)?'none':'sum',chartKind:kind};
 const input={contractVersion:1,context:{kind:'legacyDashboard',period},draftRef:{draftId:inputDraft.draftId,draftVersion:1},draft:inputDraft,editTarget:null};
 const preview=await api(`/api/training-load/dashboards/${dashboard.id}/simple/preview`,input);assert.equal(preview.status,200,preview.text);assert.equal(preview.body.status,'valid',preview.text);assert.ok(preview.body.widgetResult.gallery);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:preview.body.requestIssuedAt,resolvedPeriod:preview.body.resolvedPeriod,previewToken:preview.body.previewToken,input};
 const save=await api(`/api/training-load/dashboards/${dashboard.id}/simple/widgets`,body);assert.equal(save.status,200,save.text);
 const replay=await api(`/api/training-load/dashboards/${dashboard.id}/simple/widgets`,body);assert.equal(replay.status,200,replay.text);assert.equal(replay.body.widgetId,save.body.widgetId);
 const w=(await q.query('select * from training_load.dashboard_widgets where id=$1',[save.body.widgetId])).rows[0];assert.deepEqual(w.presentation_config.chartShape.seriesIds,[save.body.seriesId]);
 const query=await api(`/api/training-load/dashboards/${dashboard.id}/query`,{dateFrom:period.dateFrom,dateTo:period.dateTo});assert.equal(query.status,200,query.text);const result=query.body.widgets.find(w=>w.widgetId===save.body.widgetId);assert.ok(result.gallery);
 assert.deepEqual(result.gallery.groups,preview.body.widgetResult.gallery.groups);assert.equal(result.gallery.status,'ready',JSON.stringify(result));saved.push({widget:w,receipt:save.body});
});
test('Page query and copy remap shape bindings, preserve source, and keep constrained-empty empty',async()=>{
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 const target=(await q.query("insert into training_load.dashboard_pages(dashboard_id,name,position) values($1,'Copies',1) returning *",[dashboard.id])).rows[0];
 const source=saved[0].widget;
 const copied=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${home}/widgets/${source.id}/copy`,{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId:target.id,expectedWidgetRevision:source.revision,expectedPageRevision:target.revision});assert.equal(copied.status,200,copied.text);
 const created=(await q.query('select * from training_load.dashboard_widgets where id=$1',[copied.body.receipt.widgetId])).rows[0];assert.notDeepEqual(created.presentation_config.chartShape.seriesIds,source.presentation_config.chartShape.seriesIds);
 const query=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${target.id}/query`,period);assert.equal(query.status,200,query.text);assert.equal(query.body.widgets[0].gallery.status,'ready');
 const empty=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${target.id}/query`,{...period,shellFilter:{clubIds:[],teamIds:[],athleteIds:[]}});assert.equal(empty.status,200,empty.text);assert.equal(empty.body.widgets[0].series[0].status,'ok');assert.deepEqual(empty.body.widgets[0].gallery.groups,[]);assert.equal(empty.body.widgets[0].gallery.status,'empty');
});
test('only the existing pilot audience receives the new editing capability',async()=>{
 const cap=await api(`/api/training-load/dashboards/${dashboard.id}` ,null,'GET');assert.equal(cap.body.chartShapes,true);
 const club=world.accounts.find(a=>a.role==='club_admin');const own=(await api('/api/training-load/dashboards',{name:'Coach ordinary'},'POST',club)).body.dashboard;
 const detail=await api(`/api/training-load/dashboards/${own.id}`,null,'GET',club);assert.equal(detail.body.chartShapes,undefined);
});
for(const kind of ['combined','scatter','stacked'])test(kind+': real measured inputs produce paired or declared-component chart data',async()=>{
 definitions??=await seedGalleryMeasurements(q,{actorId:actor.id,clubId:world.ids.clubA,athleteIds:world.ids.athleteIds});
 const revision=(await q.query('select revision from training_load.dashboards where id=$1',[dashboard.id])).rows[0].revision;
 const position=(await q.query('select coalesce(max(y+height),0)::int y,coalesce(max(widget_order)+1,0)::int n from training_load.dashboard_widgets where dashboard_id=$1',[dashboard.id])).rows[0];
 const created=await api(`/api/training-load/dashboards/${dashboard.id}/widgets`,{expectedDashboardRevision:revision,widgetType:'bar_chart',title:kind,groupBy:'day',widgetOrder:position.n,x:0,y:position.y,width:6,height:4,mobileOrder:position.n});assert.equal(created.status,201,created.text);
 const widgetId=created.body.widgetId,ids=[];let widgetRevision=1;
 for(const [i,definition]of definitions.entries()){
  const added=await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${widgetId}/series`,{expectedWidgetRevision:widgetRevision,seriesOrder:i,metricDefinitionId:definition.id,axis:i?'secondary':'primary',sourcePolicy:'manual',dataScopeLevel:'session',analyticalAggregation:'none'});assert.equal(added.status,201,added.text);ids.push(added.body.seriesId);widgetRevision=added.body.widgetRevision;
 }
 const shape={schemaVersion:1,kind,seriesIds:ids,...(kind==='stacked'?{additive:true}:{}),...(kind==='combined'?{bindings:ids.map((seriesId,i)=>({seriesId,mark:i?'line':'bar',axis:i}))}:{})};
 const configured=await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${widgetId}`,{expectedWidgetRevision:widgetRevision,presentation:{mode:'replace',value:{schemaVersion:1,chartShape:shape}}},'PATCH');assert.equal(configured.status,200,configured.text);
 const result=await api(`/api/training-load/dashboards/${dashboard.id}/query`,{dateFrom:period.dateFrom,dateTo:period.dateTo});assert.equal(result.status,200,result.text);const plot=result.body.widgets.find(w=>w.widgetId===widgetId).gallery;assert.equal(plot.status,'ready',JSON.stringify(plot));assert.equal(plot.groups.length,6);assert.deepEqual(plot.groups.map(g=>g.values).sort((a,b)=>a[0]-b[0]),[[10,20],[10,20],[20,40],[20,40],[30,60],[30,60]]);if(kind==='stacked')assert.deepEqual(plot.groups.map(g=>g.total).sort((a,b)=>a-b),[30,30,60,60,90,90]);
});
test('clone remaps every gallery series reference to the new widget identities',async()=>{
 await q.query('update training_load.dashboards set is_template=true where id=$1',[dashboard.id]);
 const cloned=await api(`/api/training-load/dashboards/${dashboard.id}/clone`,{name:'Gallery clone'});assert.equal(cloned.status,201,cloned.text);
 const widgets=(await q.query('select * from training_load.dashboard_widgets where dashboard_id=$1',[cloned.body.dashboard.id])).rows;assert.ok(widgets.length>=4);
 for(const w of widgets){const ids=(await q.query('select id from training_load.dashboard_widget_series where widget_id=$1',[w.id])).rows.map(s=>s.id);assert.deepEqual(w.presentation_config.chartShape.seriesIds,ids);}
});

test('Page gallery previews and atomically creates every shape with matching values and replay',async()=>{
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 definitions??=await seedGalleryMeasurements(q,{actorId:actor.id,clubId:world.ids.clubA,athleteIds:world.ids.athleteIds});
 const club=world.accounts.find(a=>a.role==='club_admin');
 const created=await api('/api/training-load/dashboards',{name:'New shape gallery'},'POST',club);
 assert.equal(created.status,201,created.text);
 const d=created.body.dashboard;
 const {id:pageId}=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[d.id])).rows[0];
 const url=`/api/training-load/dashboards/${d.id}/pages/${pageId}`;
 for(const kind of ['area','horizontal_bar','heatmap','boxplot','combined','scatter','stacked']){
  const multi=['combined','scatter','stacked'].includes(kind);
  const measure=['heatmap','boxplot'].includes(kind);
  const galleryDraft={kind,title:`New ${kind}`,groupBy:'day',series:definitions.slice(0,multi?2:1).map((def,i)=>({
   metricDefinitionId:def.id,dataScopeLevel:'session',analyticalAggregation:measure?'none':'sum',
   ...(kind==='combined'?{mark:i?'line':'bar',axis:i?'secondary':'primary'}:{}),
  })),...(kind==='stacked'?{additive:true}:{})};
  const preview=await api(url+'/query',{...period,galleryDraft},'POST',club);
  assert.equal(preview.status,200,preview.text);
  assert.equal(preview.body.result.gallery.status,'ready',preview.text);
  const count=async()=>(await q.query('select count(*)::int n from training_load.dashboard_widgets where page_id=$1 and title=$2',[pageId,galleryDraft.title])).rows[0].n;
  assert.equal(await count(),0);
  const state=await api(url,null,'GET',club);
  const body={requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),draft:galleryDraft,
   expectedDashboardRevision:state.body.dashboard.revision,expectedPageRevision:state.body.page.revision};
  const save=await api(url+'/gallery',body,'POST',club);
  assert.equal(save.status,200,save.text);
  assert.equal(await count(),1);
  const replay=await api(url+'/gallery',body,'POST',club);
  assert.deepEqual(replay.body,save.body);
  assert.equal(await count(),1);
  const saved=await api(url+'/query',{...period,widgetIds:[save.body.widgetId]},'POST',club);
  assert.equal(saved.status,200,saved.text);
  assert.deepEqual(saved.body.widgets[0].gallery.groups,preview.body.result.gallery.groups);
 }
});

test('new Radar uses measured team reference and binds the newly saved series IDs',async()=>{
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 const club=world.accounts.find(a=>a.role==='club_admin');
 const measured=await seedGalleryMeasurements(q,{actorId:actor.id,clubId:world.ids.clubA,athleteIds:world.ids.athleteIds,
  entryMethod:'api_import',labels:['Radar distance A','Radar distance B','Radar distance C']});
 const created=await api('/api/training-load/dashboards',{name:'New Radar gallery'},'POST',club);
 assert.equal(created.status,201,created.text);
 const d=created.body.dashboard;
 const page=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1',[d.id])).rows[0];
 const url=`/api/training-load/dashboards/${d.id}/pages/${page.id}`;
 const draft={kind:'radar',title:'Radar profile',groupBy:'cohort',teamId:world.ids.teamA,series:measured.map(def=>({
  metricDefinitionId:def.id,dataScopeLevel:'session',analyticalAggregation:'sum',
 }))};
 const preview=await api(url+'/query',{...period,galleryDraft:draft},'POST',club);
 assert.equal(preview.status,200,preview.text);
 assert.equal(preview.body.result.references.axes.length,3);
 assert.equal(preview.body.result.references.status,'ready',preview.text);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),draft,
  expectedDashboardRevision:d.revision,expectedPageRevision:page.revision};
 const denied=await api(url+'/gallery',body,'POST',world.accounts.find(a=>a.role==='athlete'));
 assert.equal(denied.status,404,denied.text);
 const saved=await api(url+'/gallery',body,'POST',club);
 assert.equal(saved.status,200,saved.text);
 const stored=(await q.query('select presentation_config from training_load.dashboard_widgets where id=$1',[saved.body.widgetId])).rows[0];
 const ids=(await q.query('select id from training_load.dashboard_widget_series where widget_id=$1 order by series_order',[saved.body.widgetId])).rows.map(row=>row.id);
 assert.deepEqual(stored.presentation_config.referenceConfig.axes.map(axis=>axis.seriesId),ids);
 const queried=await api(url+'/query',{...period,widgetIds:[saved.body.widgetId]},'POST',club);
 assert.equal(queried.status,200,queried.text);
 assert.deepEqual(queried.body.widgets[0].references.axes.map(axis=>axis.points),preview.body.result.references.axes.map(axis=>axis.points));
});
