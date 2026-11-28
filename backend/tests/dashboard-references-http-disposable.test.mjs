import pg from 'pg';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createPagesDatabase} from './support/dashboard-pages-db.mjs';
import {fixtures,startServer,key} from './support/permission-roles-world.mjs';
let db,q,F,srv,A,B,team,admin,coach,viewer,teamViewer,mixed,table;
const R='/api/training-load/reference-tables';
const post=(who,path,body)=>srv.api(who.cookie,path,{method:'POST',body});
const person=async(label,setup=async()=>{})=>{const id=await F.user(label);await setup(id);return{id,cookie:await srv.cookieFor(id)}};

async function setFixtureManageGrant(client, add) {
 const word='variables.manage', migration='fixtures/reference-table-manage-'+key();
 const {rows:[db]}=await client.query('select current_database() name');
 assert.match(db.name, /^optimove_tests_/);
 await client.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
 const {rows:[phase]}=await client.query('select public.permission_word_honoured($1) active',[word]);
 if(!phase.active){
  const {rows:[{ddl}]}=await client.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) ddl");
  const staged=ddl.replace("'variables.view'", "'variables.view', 'variables.manage'");
  assert.notEqual(staged,ddl);
  await client.query(staged);
 }
 const {rows:[role]}=await client.query("update public.permission_roles set revision=revision+1,updated_at=now() where basic_key='club_admin' returning id,revision");
 const column=add?'items_added':'items_removed';
 await client.query(`insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,${column}) values($1,$2,'migration',$3,array[$4]::text[])`,[role.id,role.revision,migration,word]);
 await client.query(add?'insert into public.permission_role_items(role_id,permission_word) values($1,$2)':'delete from public.permission_role_items where role_id=$1 and permission_word=$2',[role.id,word]);
 await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')",[migration]);
}

before(async()=>{
 db=await createPagesDatabase({through:'202612071000',label:'references_http'});q=db.client;F=fixtures(q);
 await q.query("begin");
 try { await setFixtureManageGrant(q,true); await q.query("commit"); }
 catch (error) { await q.query("rollback"); throw error; }
 process.env.DASHBOARD_REFERENCES_ENABLED='true';process.env.DASHBOARD_PAGES_ENABLED='true';srv=await startServer(db.url);
 A=await F.club('Ref Alpha');B=await F.club('Ref Beta');team=await F.team(A);
 admin=await person('refAdmin',id=>F.grantClub(id,A));coach=await person('refCoach',id=>F.grantTeam(id,team));
 const adminB=await person('refAdminB',id=>F.grantClub(id,B));
 viewer=await person('refViewer');teamViewer=await person('refTeamViewer');mixed=await person('refMixed',id=>F.grantClub(id,B));
 const r=await post(admin,'/api/organization/roles',{requestKey:key(),clubId:A,scopeTypes:['club','team'],items:['org.view'],name:'Reference viewer'});assert.equal(r.status,200,r.text);
 for(const [who,scopeType,scopeId]of [[viewer,'club',A],[teamViewer,'team',team],[mixed,'club',A]]){const assignment=await post(admin,'/api/organization/roles/assignments',{requestKey:key(),reason:'Reference access test',userId:who.id,roleId:r.body.role.id,scopeType,scopeId});assert.equal(assignment.status,200,assignment.text);}
 for(const who of [viewer,mixed])await q.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'club',$2) on conflict(user_id) do update set workspace_type='club',scope_id=excluded.scope_id",[who.id,A]);
 const created=await post(admin,R,{requestId:crypto.randomUUID(),name:'Game targets'});assert.equal(created.status,201,created.text);table=created.body;
});
after(async()=>{await srv?.stop();await db?.drop();delete process.env.DASHBOARD_REFERENCES_ENABLED;delete process.env.DASHBOARD_PAGES_ENABLED;});
test('club admin creates and reads; a coach reads the published catalog but cannot edit',async()=>{
 const list=await srv.api(admin.cookie,R);assert.equal(list.status,200,list.text);assert.equal(list.body.canCreate,true);assert.equal(list.body.tables.length,1);
 const read=await srv.api(coach.cookie,R);assert.equal(read.status,200,read.text);assert.equal(read.body.canCreate,false);assert.equal(read.body.tables.length,0,'unpublished tables are not offered to coaches');
 const denied=await post(coach,R,{requestId:crypto.randomUUID(),name:'No write'});assert.deepEqual([denied.status,denied.body],[404,{error:'notFound'}]);
});
test('club_view and team_view including a mixed old-role account cannot open any P3 route',async()=>{
 const paths=[[R,'GET'],[R+'/options','GET'],[R+'/'+table.id,'GET'],[R+'/'+table.id+'/versions/'+crypto.randomUUID(),'GET'],[R,'POST'],[R+'/'+table.id+'/draft','PATCH'],[R+'/'+table.id+'/publish','POST'],[R+'/'+table.id+'/archive','POST'],['/api/training-load/dashboard-references/'+crypto.randomUUID()+'/widgets/'+crypto.randomUUID(),'GET'],['/api/training-load/dashboard-references/'+crypto.randomUUID()+'/widgets/'+crypto.randomUUID(),'PUT']];
 for(const who of [viewer,teamViewer,mixed]){
  const me=await srv.api(who.cookie,'/api/auth/me');assert.ok(['club_view','team_view'].includes(me.body.user.activeWorkspace.type),me.text);
  for(const [path,method]of paths){const response=await srv.api(who.cookie,path,{method,...(method==='GET'?{}:{body:{}})});assert.equal(response.status,404,method+' '+path);assert.equal(response.text,'{"error":"notFound"}');}
 }
});
test('foreign and missing reference identities return byte-identical 404s',async()=>{
 const other=await person('refOther',id=>F.grantClub(id,B));
 const foreign=await srv.api(other.cookie,R+'/'+table.id),missing=await srv.api(other.cookie,R+'/'+crypto.randomUUID());
 assert.deepEqual([foreign.status,foreign.text],[missing.status,missing.text]);assert.equal(foreign.status,404);
});
// Snapshot every reference row/receipt/use record and dashboard content, not only the target row.
async function storedReferenceState(){
 const tables=(await q.query("select tablename from pg_tables where schemaname='training_load' and (tablename like 'dashboard_reference_%' or tablename in ('dashboards','dashboard_pages','dashboard_widgets','dashboard_widget_series')) order by tablename")).rows;
 const state={};for(const {tablename} of tables)state[tablename]=(await q.query("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text value from training_load."+tablename+' t')).rows[0].value;return state;
}

test('club A admin cannot draft, publish or archive club B tables; missing is identical and nothing is written',async()=>{
 const other=await person('foreignTableWriter',id=>F.grantClub(id,B));const made=await post(other,R,{requestId:crypto.randomUUID(),name:'Protected Beta targets'});assert.equal(made.status,201,made.text);
 const before=await storedReferenceState();
 for(const [action,method]of [['draft','PATCH'],['publish','POST'],['archive','POST']]){
  const body={requestId:crypto.randomUUID(),expectedRevision:made.body.revision,...(action==='draft'?{draft:{columns:[],rows:[],valueKinds:[],cells:[]}}:{})};
  const denied=await srv.api(admin.cookie,R+'/'+made.body.id+'/'+action,{method,body});const missing=await srv.api(admin.cookie,R+'/'+crypto.randomUUID()+'/'+action,{method,body:{...body,requestId:crypto.randomUUID()}});
  assert.deepEqual([denied.status,denied.text],[404,'{"error":"notFound"}'],action);assert.deepEqual([denied.status,denied.text],[missing.status,missing.text],action);assert.deepEqual(await storedReferenceState(),before,action+' writes no row or receipt');
 }
});

test('bad shape and stale writes refuse without changing the table',async()=>{
 const bad=await post(admin,R,{requestId:crypto.randomUUID(),name:'Wrong',clubId:B});assert.equal(bad.status,400,bad.text);
 const stale=await post(admin,R+'/'+table.id+'/archive',{requestId:crypto.randomUUID(),expectedRevision:999});assert.equal(stale.status,409,stale.text);
 assert.equal((await srv.api(admin.cookie,R+'/'+table.id)).body.table.archived,false);
});

test('published targets bind through the real widget route, replay once, and stale or foreign writes change nothing',async()=>{
 const definition=(await q.query("insert into training_load.metric_definitions(key,label,owner_scope,state,created_by_user_id) values('p3_http_distance','Distance','system','active',$1) returning id",[admin.id])).rows[0].id;
 await q.query("insert into training_load.metric_definition_versions(metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id) values($1,1,'m','numeric','sum',$2)",[definition,admin.id]);
 await q.query('update training_load.metric_definitions set current_version_id=(select id from training_load.metric_definition_versions where metric_definition_id=$1) where id=$1',[definition]);
 await q.query("insert into training_load.metric_definition_scope_capabilities values($1,'session')",[definition]);
 const position=(await q.query('select id from public.sport_positions order by sort_order limit 1')).rows[0].id;
 const made=await post(admin,R,{requestId:crypto.randomUUID(),name:'Widget targets'});assert.equal(made.status,201,made.text);
 const draft={columns:[{definitionId:definition,unit:'m',aggregation:'sum',dataLevel:'session',order:0}],rows:[{positionId:position,order:0}],valueKinds:[{key:'target',name:'Target',order:0}],cells:[{positionId:position,definitionId:definition,valueKey:'target',value:100}]};
 const edited=await srv.api(admin.cookie,R+'/'+made.body.id+'/draft',{method:'PATCH',body:{requestId:crypto.randomUUID(),expectedRevision:1,draft}});assert.equal(edited.status,200,edited.text);
 const published=await post(admin,R+'/'+made.body.id+'/publish',{requestId:crypto.randomUUID(),expectedRevision:edited.body.revision});assert.equal(published.status,200,published.text);
 const dashboard=(await q.query("select * from training_load.create_dashboard('References',null,'club',null,$1,null,'club',$1,false,$2,null)",[A,admin.id])).rows[0];
 const widget=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,'bar_chart','Distance',0,0,0,6,4,0,'athlete') returning *",[dashboard.id])).rows[0];
 const added=(await q.query("select * from training_load.add_series($1,$2,0,$3,null,null,'primary',null,null,'all_with_conflicts',null,'session','sum')",[widget.id,widget.revision,definition])).rows[0];
 const path='/api/training-load/dashboard-references/'+dashboard.id+'/widgets/'+widget.id;
 const read=await srv.api(admin.cookie,path);assert.equal(read.status,200,read.text);assert.equal(read.body.series[0].label,'Distance');
 const referenceConfig={schemaVersion:1,source:'preset',mode:'overlay',clubId:A,tableId:made.body.id,versionId:published.body.publishedVersionId,axes:[{seriesId:added.series_id,anchorKey:'target',valueKeys:['target']}]};
 const body={requestId:crypto.randomUUID(),expectedWidgetRevision:read.body.widget.revision,groupBy:'athlete',referenceConfig};
 const beforePreview=(await q.query('select to_jsonb(w) value from training_load.dashboard_widgets w where id=$1',[widget.id])).rows[0].value;
 const previewBody={dateFrom:'2026-11-01',dateTo:'2026-11-07',widgetIds:[widget.id],referencePreview:{widgetId:widget.id,expectedWidgetRevision:body.expectedWidgetRevision,groupBy:'athlete',referenceConfig}};
 const previewed=await post(admin,'/api/training-load/dashboards/'+dashboard.id+'/query',previewBody);assert.equal(previewed.status,200,previewed.text);assert.match(previewed.body.referencePreviewFingerprint,/^[a-f0-9]{64}$/);assert.equal(previewed.body.widgets[0].references.tableName,'Widget targets');
 assert.deepEqual((await q.query('select to_jsonb(w) value from training_load.dashboard_widgets w where id=$1',[widget.id])).rows[0].value,beforePreview,'preview writes no widget row');
 const secondDraft=await srv.api(admin.cookie,R+'/'+made.body.id+'/draft',{method:'PATCH',body:{requestId:crypto.randomUUID(),expectedRevision:published.body.revision,draft}});assert.equal(secondDraft.status,200,secondDraft.text);const secondVersion=await post(admin,R+'/'+made.body.id+'/publish',{requestId:crypto.randomUUID(),expectedRevision:secondDraft.body.revision});assert.equal(secondVersion.status,200,secondVersion.text);
 const otherPreview=await post(admin,'/api/training-load/dashboards/'+dashboard.id+'/query',{...previewBody,referencePreview:{...previewBody.referencePreview,referenceConfig:{...referenceConfig,versionId:secondVersion.body.publishedVersionId}}});assert.equal(otherPreview.status,200,otherPreview.text);assert.notEqual(otherPreview.body.referencePreviewFingerprint,previewed.body.referencePreviewFingerprint,'version change invalidates preview');
 const foreignAdmin=await person('foreignTargets',id=>F.grantClub(id,B));const foreignTable=await post(foreignAdmin,R,{requestId:crypto.randomUUID(),name:'Foreign published targets'});const foreignDraft=await srv.api(foreignAdmin.cookie,R+'/'+foreignTable.body.id+'/draft',{method:'PATCH',body:{requestId:crypto.randomUUID(),expectedRevision:1,draft}});assert.equal(foreignDraft.status,200,foreignDraft.text);const foreignVersion=await post(foreignAdmin,R+'/'+foreignTable.body.id+'/publish',{requestId:crypto.randomUUID(),expectedRevision:foreignDraft.body.revision});assert.equal(foreignVersion.status,200,foreignVersion.text);
 let refusals=[];for(const [tableId,versionId]of [[foreignTable.body.id,foreignVersion.body.publishedVersionId],[crypto.randomUUID(),crypto.randomUUID()]]){const config={...referenceConfig,tableId,versionId};const refusedPreview=await post(admin,'/api/training-load/dashboards/'+dashboard.id+'/query',{...previewBody,referencePreview:{...previewBody.referencePreview,referenceConfig:config}});const refusedSave=await srv.api(admin.cookie,path,{method:'PUT',body:{...body,requestId:crypto.randomUUID(),referenceConfig:config}});refusals.push([refusedPreview.status,refusedPreview.text,refusedSave.status,refusedSave.text]);}assert.deepEqual(refusals[0],refusals[1]);assert.equal(refusals[0][0],404);assert.equal(refusals[0][2],404);

 const saved=await srv.api(admin.cookie,path,{method:'PUT',body});assert.equal(saved.status,200,saved.text);
 const replay=await srv.api(admin.cookie,path,{method:'PUT',body});assert.equal(replay.status,200,replay.text);assert.deepEqual(replay.body,saved.body);
 const before=(await q.query('select to_jsonb(w) value from training_load.dashboard_widgets w where id=$1',[widget.id])).rows[0].value;
 const stale=await srv.api(admin.cookie,path,{method:'PUT',body:{...body,requestId:crypto.randomUUID()}});assert.equal(stale.status,409,stale.text);
 const other=await person('foreignBinding',id=>F.grantClub(id,B));const denied=await srv.api(other.cookie,path,{method:'PUT',body:{...body,requestId:crypto.randomUUID()}});assert.equal(denied.status,404,denied.text);
 assert.deepEqual((await q.query('select to_jsonb(w) value from training_load.dashboard_widgets w where id=$1',[widget.id])).rows[0].value,before);
 assert.deepEqual(before.presentation_config.referenceConfig,referenceConfig);
});

test('binding rejects foreign, unmanageable and wrong-data-workspace dashboards without any write',async()=>{
 const other=await person('protectedDashboardOwner',id=>F.grantClub(id,B));
 const foreignDashboard=(await q.query("select * from training_load.create_dashboard('Foreign binding target',null,'club',null,$1,null,'club',$1,false,$2,null)",[B,other.id])).rows[0];
 const privateDashboard=(await q.query("select * from training_load.create_dashboard('Unmanageable binding target',null,'user',$1,null,null,'club',$2,false,$1,null)",[other.id,A])).rows[0];
 // Manageable by the caller, but bound to another club: only dataWorkspaceMatches refuses this one.
 const mismatchedDashboard=(await q.query("select * from training_load.create_dashboard('Wrong data workspace',null,'user',$1,null,null,'club',$2,false,$1,null)",[admin.id,B])).rows[0];
 for(const [label,target] of [['foreign',foreignDashboard],['unmanageable',privateDashboard],['wrong data workspace',mismatchedDashboard]]){
  const row=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,'bar_chart','Protected',0,0,0,6,4,0,'athlete') returning *",[target.id])).rows[0];
  const protectedPath='/api/training-load/dashboard-references/'+target.id+'/widgets/'+row.id;const stored=await storedReferenceState();
  for(const method of ['GET','PUT']){
   const payload={requestId:crypto.randomUUID(),expectedWidgetRevision:row.revision,groupBy:'athlete',referenceConfig:null};
   const denied=await srv.api(admin.cookie,protectedPath,{method,...(method==='PUT'?{body:payload}:{})});const missing=await srv.api(admin.cookie,'/api/training-load/dashboard-references/'+crypto.randomUUID()+'/widgets/'+crypto.randomUUID(),{method,...(method==='PUT'?{body:payload}:{})});
   assert.deepEqual([denied.status,denied.text],[404,'{"error":"notFound"}'],label+' '+method);assert.deepEqual([denied.status,denied.text],[missing.status,missing.text]);assert.deepEqual(await storedReferenceState(),stored,'refused binding writes nothing');
  }
 }

});

test('team reference averages imported athlete period values only and shell selection never widens it',async()=>{
 const {seedGalleryMeasurements}=await import('./support/dashboard-gallery-seed.mjs');
 const athletes=[];for(const name of ['Alex','Bo','Cam']){const id=(await q.query("insert into public.athletes(athlete_id,first_name,last_name,full_name,display_name) values(nextval('public.athlete_generated_id_seq')::text,$1,'Test',$1,$1) returning id",[name])).rows[0].id;await q.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status,starts_at) values($1,$2,null,'club','active','2026-01-01'),($1,$2,$3,'team','active','2026-01-01')",[id,A,team]);athletes.push(id);}
 const definition=(await q.query("select id,current_version_id from training_load.metric_definitions where key='p3_http_distance'")).rows[0];
 await q.query("insert into training_load.metric_definition_scope_capabilities values($1,'session') on conflict do nothing",[definition.id]);
 await seedGalleryMeasurements(q,{actorId:admin.id,clubId:A,teamId:team,athleteIds:athletes,existingDefinitions:[{id:definition.id,versionId:definition.current_version_id,name:'Distance'}]});
 const dashboard=(await q.query("select * from training_load.create_dashboard('Team reference',null,'user',$1,null,null,'team',$2,false,$1,null)",[coach.id,team])).rows[0];
 const widget=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,'bar_chart','Team distance',0,0,0,6,4,0,'cohort') returning *",[dashboard.id])).rows[0];
 await q.query("select * from training_load.add_series($1,$2,0,$3,null,null,'primary',null,null,'all_with_conflicts',null,'session','sum')",[widget.id,widget.revision,definition.id]);widget.revision=(await q.query('select revision from training_load.dashboard_widgets where id=$1',[widget.id])).rows[0].revision;
 const series=(await q.query('select * from training_load.dashboard_widget_series where widget_id=$1',[widget.id])).rows[0];
 const path='/api/training-load/dashboard-references/'+widget.dashboard_id+'/widgets/'+widget.id;
 const config={schemaVersion:1,source:'teamAverage',mode:'overlay',clubId:A,teamId:team,axes:[{seriesId:series.id,valueKeys:['teamAverage']}]};
 const saved=await srv.api(coach.cookie,path,{method:'PUT',body:{requestId:crypto.randomUUID(),expectedWidgetRevision:widget.revision,groupBy:'cohort',referenceConfig:config}});assert.equal(saved.status,200,saved.text);
 const sibling=await F.team(A);const stored=await storedReferenceState();const current=(await q.query('select revision from training_load.dashboard_widgets where id=$1',[widget.id])).rows[0].revision;
 const deniedTeam=await srv.api(coach.cookie,path,{method:'PUT',body:{requestId:crypto.randomUUID(),expectedWidgetRevision:current,groupBy:'cohort',referenceConfig:{...config,teamId:sibling}}});
 assert.equal(deniedTeam.status,404,deniedTeam.text);assert.deepEqual(await storedReferenceState(),stored,'another team in the same club cannot change the binding');

 const queryPath='/api/training-load/dashboards/'+widget.dashboard_id+'/query',period={dateFrom:'2026-11-01',dateTo:'2026-11-10'};
 const manual=await post(coach,queryPath,period);assert.equal(manual.status,200,manual.text);assert.equal(manual.body.widgets[0].references.axes[0].reason,'tooFewAthletes');
 await seedGalleryMeasurements(q,{actorId:admin.id,clubId:A,teamId:team,athleteIds:athletes,dates:['2026-11-08','2026-11-09'],existingDefinitions:[{id:definition.id,versionId:definition.current_version_id,name:'Distance'}],entryMethod:'csv_import'});
 const measured=await post(coach,queryPath,period);assert.equal(measured.status,200,measured.text);const point=measured.body.widgets[0].references.axes[0].points[0];assert.equal(point.references[0].value,40,JSON.stringify(measured.body));assert.equal(point.includedAthletes,3);
 const selected=await post(coach,queryPath,{...period,shellFilter:{clubIds:[],teamIds:[],athleteIds:athletes.slice(0,2)}});assert.equal(selected.status,200,selected.text);assert.equal(selected.body.widgets[0].references.axes[0].reason,'tooFewAthletes');
 const empty=await post(coach,queryPath,{...period,shellFilter:{clubIds:[],teamIds:[],athleteIds:[crypto.randomUUID()]}});assert.equal(empty.status,200,empty.text);assert.deepEqual(empty.body.widgets[0].series[0].data.current,[]);
});

test('P3 route inventory covers every mounted read and write endpoint',async()=>{
 const {createReferenceRouter}=await import('../src/dashboardReferences/router.js');const {createReferenceBindingRouter}=await import('../src/dashboardReferences/bindingRouter.js');
 const routes=router=>router.stack.filter(layer=>layer.route).flatMap(layer=>Object.keys(layer.route.methods).map(method=>method.toUpperCase()+' '+layer.route.path)).sort();
 assert.deepEqual(routes(createReferenceRouter()),['GET /','GET /options','GET /:id','GET /:id/versions/:versionId','POST /','PATCH /:id/draft','POST /:id/publish','POST /:id/archive'].sort());
 assert.deepEqual(routes(createReferenceBindingRouter()),['GET /:dashboardId/widgets/:widgetId','PUT /:dashboardId/widgets/:widgetId']);
});

test('binding request advisory lock precedes the dashboard row lock',async()=>{
 const widget=(await q.query("select * from training_load.dashboard_widgets where title='Team distance'")).rows[0];const request=crypto.randomUUID();const writer=new pg.Client({connectionString:db.url});await writer.connect();let pending;
 try{
  await q.query('begin');await q.query("select pg_advisory_xact_lock(hashtextextended('dashboard-reference:'||$1::text||':'||$2::text,0))",[coach.id,request]);
  const pid=(await writer.query('select pg_backend_pid() pid')).rows[0].pid;await writer.query("set statement_timeout='10000ms'");
  pending=writer.query("select training_load.save_dashboard_reference_binding($1,$2,$3,$4,repeat('a',64),$5,$6,$7,'cohort',null)",[coach.id,A,team,request,widget.dashboard_id,widget.id,widget.revision]).then(result=>({result}),error=>({error}));
  let waiting=false;for(let attempt=0;attempt<100;attempt++){waiting=(await q.query("select wait_event_type='Lock' and wait_event='advisory' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(waiting,true,'writer is waiting for the same request advisory lock');
  await q.query('select id from training_load.dashboards where id=$1 for update nowait',[widget.dashboard_id]);await q.query('commit');const outcome=await pending;if(outcome.error)throw outcome.error;
 }finally{await q.query('rollback');if(pending)await pending;await writer.end();}
});

test('non-Home bindings follow both Pages gates and save through the sanctioned Page context',async()=>{
 const {app}=await import('../src/server.js');const widget=(await q.query("select * from training_load.dashboard_widgets where title='Distance'")).rows[0];const prefix='/api/training-load/dashboards/'+widget.dashboard_id+'/pages';
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 const listed=await srv.api(admin.cookie,prefix);assert.equal(listed.status,200,listed.text);
 const created=await post(admin,prefix,{requestId:crypto.randomUUID(),requestIssuedAt:listed.body.requestIssuedAt,expectedPagesRevision:listed.body.pagesRevision,input:{name:'Reference copy'}});assert.equal(created.status,200,created.text);
 const pageId=created.body.receipt.pageId,home=listed.body.pages.find(p=>p.is_home);const page=(await q.query('select * from training_load.dashboard_pages where id=$1',[pageId])).rows[0];
 const copied=await post(admin,prefix+'/'+home.id+'/widgets/'+widget.id+'/copy',{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId:pageId,expectedWidgetRevision:widget.revision,expectedPageRevision:page.revision});assert.equal(copied.status,200,copied.text);
 const copyId=copied.body.receipt.widgetId,path='/api/training-load/dashboard-references/'+widget.dashboard_id+'/widgets/'+copyId;
 try{
  app.locals.dashboardPagesEnabled=false;assert.equal((await srv.api(admin.cookie,path)).status,404);
  app.locals.dashboardPagesEnabled=true;await q.query('update training_load.dashboard_pages_activation set enabled=false');assert.equal((await srv.api(admin.cookie,path)).status,404);
  await q.query('update training_load.dashboard_pages_activation set enabled=true');const current=await srv.api(admin.cookie,path);assert.equal(current.status,200,current.text);
  const saved=await srv.api(admin.cookie,path,{method:'PUT',body:{requestId:crypto.randomUUID(),expectedWidgetRevision:current.body.widget.revision,groupBy:'athlete',referenceConfig:null}});assert.equal(saved.status,200,saved.text);assert.equal((await srv.api(admin.cookie,path)).body.widget.referenceConfig,null);
 }finally{app.locals.dashboardPagesEnabled=true;await q.query('update training_load.dashboard_pages_activation set enabled=true');}
});


test('reference authoring requires Variables Manage on the active club for drafts, writes and replays',async()=>{
 const definition=(await q.query("select id from training_load.metric_definitions where key='p3_http_distance'")).rows[0].id;
 const position=(await q.query('select id from public.sport_positions order by sort_order limit 1')).rows[0].id;
 const create={requestId:key(),name:'Manage boundary proof'};
 const published=await post(admin,R,create);
 assert.equal(published.status,201,published.text);
 const target=R+'/'+published.body.id;
 const draft={
  columns:[{definitionId:definition,unit:'m',aggregation:'sum',dataLevel:'session',order:0}],
  rows:[{positionId:position,order:0}],valueKinds:[{key:'target',name:'Target',order:0}],
  cells:[{positionId:position,definitionId:definition,valueKey:'target',value:100}],
 };
 const edited=await srv.api(admin.cookie,target+'/draft',{method:'PATCH',body:{requestId:key(),expectedRevision:published.body.revision,draft}});
 assert.equal(edited.status,200,edited.text);
 const live=await post(admin,target+'/publish',{requestId:key(),expectedRevision:edited.body.revision});
 assert.equal(live.status,200,live.text);
 const tracked=await storedReferenceState();
 const refused={status:404,text:'{"error":"notFound"}'};
 const responseOf=({status,text})=>({status,text});

 const blocker=new pg.Client({connectionString:db.url});
 await blocker.connect();
 let pending;
 try {
  await blocker.query('begin');
  await setFixtureManageGrant(blocker,false);
  const {rows:[{pid}]}=await blocker.query('select pg_backend_pid() pid');
  pending=post(admin,R,{requestId:key(),name:'Denied after queued revocation'});
  let waiting=false;
  for(let attempt=0;attempt<100&&!waiting;attempt++){
   waiting=(await q.query("select exists(select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid)) and query like 'select public.lock_club_ceiling%') waiting",[pid])).rows[0].waiting;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(waiting,true,'the native write reached the club licence lock before seeing the revoked grant');
  await blocker.query('commit');
  assert.deepEqual(responseOf(await pending),refused);
  assert.deepEqual(responseOf(await post(admin,R,create)),refused,'the same completed key gives no receipt after revocation');
  assert.deepEqual(responseOf(await post(admin,R,{requestId:key(),name:'Denied after revocation'})),refused);
  for(const [action,method] of [['draft','PATCH'],['publish','POST'],['archive','POST']]){
   const body={requestId:key(),expectedRevision:live.body.revision,...(action==='draft'?{draft}:{})};
   assert.deepEqual(responseOf(await srv.api(admin.cookie,target+'/'+action,{method,body})),refused);
  }
  const list=await srv.api(admin.cookie,R);
  assert.equal(list.status,200,list.text);
  assert.equal(list.body.canCreate,false);
  assert.ok(list.body.tables.some(row=>row.id===published.body.id));
  assert.ok(!list.body.tables.some(row=>row.id===table.id));
  assert.deepEqual(responseOf(await srv.api(admin.cookie,R+'/'+table.id)),refused);
  const publishedRead=await srv.api(admin.cookie,target);
  assert.equal(publishedRead.status,200,publishedRead.text);
  assert.equal(publishedRead.body.version.published,true);
  assert.equal(publishedRead.body.canEdit,false);
  assert.deepEqual(await storedReferenceState(),tracked);

  const platform=await person('referenceTablePlatform',async id=>{await F.grantPlatform(id);await F.grantClub(id,A);});
  const pick=await srv.api(platform.cookie,'/api/auth/workspace',{method:'PUT',body:{type:'club',scopeId:A}});
  assert.equal(pick.status,200,pick.text);
  assert.equal((await post(platform,R,{requestId:key(),name:'Platform keeps reference authoring'})).status,201);
 } finally {
  await blocker.query('rollback').catch(()=>{});
  if(pending)await pending.catch(()=>{});
  try {
   const has=(await blocker.query("select exists(select 1 from public.permission_role_items i join public.permission_roles r on r.id=i.role_id where r.basic_key='club_admin' and i.permission_word='variables.manage') present")).rows[0].present;
   if(!has){
    await blocker.query('begin');
    await setFixtureManageGrant(blocker,true);
    await blocker.query('commit');
   }
  } finally {await blocker.end();}
 }
});
