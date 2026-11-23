import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {draft} from './fixtures/dashboard-simple/contracts.mjs';
import {startDashboardShellFixture} from './support/dashboard-shell-fixture.mjs';
let world,q,actor,dashboard,home;
async function api(path,body,method='GET'){
 const r=await fetch(world.baseUrl+path,{method,headers:{Cookie:`optimove_session=${actor.sessionToken}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 return {status:r.status,text:await r.text(),headers:Object.fromEntries([...r.headers].filter(([k])=>!['date','connection','keep-alive','x-request-id'].includes(k)))};
}
before(async()=>{
 world=await startDashboardShellFixture({envOverrides:{DASHBOARD_PAGES_ENABLED:'true',DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'1',DASHBOARD_SIMPLE_KEY_ID:'p1-disposable-only',DASHBOARD_SIMPLE_KEY_BASE64:crypto.randomBytes(32).toString('base64')}});
 q=new pg.Client({connectionString:world.databaseUrl});await q.connect();actor=world.accounts[0];
 const response=await api('/api/training-load/dashboards',{name:'Page routes'},'POST');assert.equal(response.status,201,response.text);dashboard=JSON.parse(response.text).dashboard;
 home=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[dashboard.id])).rows[0].id;
});
after(async()=>{await q?.end();await world?.stop()});
test('server setting alone does not activate database Page capability or routes',async()=>{
 const path=`/api/training-load/dashboards/${dashboard.id}`;
 const detail=await api(path);assert.equal(detail.status,200);assert.equal(JSON.parse(detail.text).pagesAvailable,undefined);
 const pages=await api(path+'/pages');assert.equal(pages.status,404);assert.equal(pages.text,'{"error":"notFound"}');
 await q.query('update training_load.dashboard_pages_activation set enabled=true');
 const active=await api(path);assert.equal(JSON.parse(active.text).pagesAvailable,true);
});
test('real route creates a Page; replay uses same identity without a navigation revision bump',async()=>{
 const path=`/api/training-load/dashboards/${dashboard.id}/pages`;
 const read=await api(path),initial=JSON.parse(read.text);assert.equal(read.status,200,read.text);assert.equal(initial.pages.length,1);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:initial.pagesRevision,input:{name:'Performance'}};
 const result=await api(path,body,'POST');assert.equal(result.status,200,result.text);
 const replay=await api(path,body,'POST');assert.equal(replay.status,200,replay.text);assert.equal(replay.text,result.text);
 const after=JSON.parse((await api(path)).text);assert.equal(after.pages.length,2);assert.equal(after.pagesRevision,initial.pagesRevision+1);
});
test('foreign-parent Page and missing Page respond byte-identically including application headers',async()=>{
 const other=await api('/api/training-load/dashboards',{name:'Other Pages'},'POST');const otherId=JSON.parse(other.text).dashboard.id;
 const foreign=(await q.query('select id from training_load.dashboard_pages where dashboard_id=$1',[otherId])).rows[0].id;
 const a=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${foreign}`);
 const b=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${crypto.randomUUID()}`);
 assert.equal(a.status,404);assert.deepEqual(a,b);
});
test('athlete cannot read someone else\'s Page; invisible and missing parent respond identically',async()=>{
 actor=world.accounts.find(a=>a.role==='athlete');
 const a=await api(`/api/training-load/dashboards/${dashboard.id}/pages/${home}`);
 const b=await api(`/api/training-load/dashboards/${crypto.randomUUID()}/pages/${crypto.randomUUID()}`);
 assert.equal(a.status,404);assert.deepEqual(a,b);
 actor=world.accounts[0];
});

test('Page data query applies the separate active data-workspace gate',async()=>{
 const path=`/api/training-load/dashboards/${dashboard.id}/pages/${home}/query`;
 const period={dateFrom:'2026-11-01',dateTo:'2026-11-07'};
 const ok=await api(path,{...period,shellFilter:{clubIds:[],teamIds:[],athleteIds:[]}},'POST');
 assert.equal(ok.status,200,ok.text);assert.deepEqual(JSON.parse(ok.text).widgets,[]);
 await q.query("insert into public.user_club_roles(user_id,club_id,role,is_active) values($1,$2,'club_admin',true)",[actor.id,world.ids.clubA]);
 await q.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$2 where user_id=$1",[actor.id,world.ids.clubA]);
 try{
  const mismatch=await api(path,period,'POST');assert.equal(mismatch.status,404,mismatch.text);assert.equal(mismatch.text,'{"error":"notFound"}');
  const {createPageService}=await import('../src/dashboardPages/service.js');const pool=new pg.Pool({connectionString:world.databaseUrl}),statements=[];
  try{const recorded={async connect(){const c=await pool.connect();return{query(sql,args){statements.push(sql);return c.query(sql,args)},release(){c.release()}}}};
   await assert.rejects(createPageService({pool:recorded}).queryPage({req:{user:{id:actor.id}},dashboardId:dashboard.id,pageId:home,body:period}),e=>e.httpStatus===404);
   assert.equal(statements.some(sql=>/select \* from training_load\.dashboard_widgets/.test(sql)),false,'workspace mismatch stops before reading widget content');
  }finally{await pool.end()}

 }finally{await q.query("update public.user_workspace_preferences set workspace_type='platform',scope_id=null where user_id=$1",[actor.id]);await q.query("delete from public.user_club_roles where user_id=$1 and club_id=$2",[actor.id,world.ids.clubA])}
});

test('request status returns the stored receipt for the live actor and never invents success',async()=>{
 const path=`/api/training-load/dashboards/${dashboard.id}/pages`;
 const read=JSON.parse((await api(path)).text);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:read.pagesRevision,input:{name:'Recovery'}};
 const saved=await api(path,body,'POST');assert.equal(saved.status,200,saved.text);
 const status=await api(path+'/requests/'+body.requestId);assert.equal(status.status,200,status.text);
 assert.deepEqual(JSON.parse(status.text).receipt,JSON.parse(saved.text).receipt);
 assert.equal(JSON.parse(status.text).status,'recorded');
 const absent=await api(path+'/requests/'+crypto.randomUUID());assert.equal(absent.status,200);assert.equal(JSON.parse(absent.text).status,'notRecorded');
});

test('Simple preview → save → replay stores a widget on the selected Page, never Home',async()=>{
 const page=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1 and not is_home order by position limit 1',[dashboard.id])).rows[0];
 const beforeHome=(await q.query('select count(*)::int n from training_load.dashboard_widgets where page_id=$1',[home])).rows[0].n;
 const value=draft();value.title='Page sessions';value.metricRef={kind:'builtin',key:'session_count'};
 value.view={type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'};
 const input={contractVersion:1,context:{kind:'page',pageId:page.id,expectedPageDefaultsRevision:page.defaults_revision,period:{dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'},shellFilter:null},draftRef:{draftId:value.draftId,draftVersion:value.draftVersion},draft:value,editTarget:null};
 const base=`/api/training-load/dashboards/${dashboard.id}/simple`;
 const preview=await api(base+'/preview',input,'POST');

 assert.equal(preview.status,200,preview.text);const result=JSON.parse(preview.text);assert.equal(result.status,'valid',preview.text);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:result.requestIssuedAt,resolvedPeriod:result.resolvedPeriod,previewToken:result.previewToken,input};
 const saved=await api(base+'/widgets',body,'POST');assert.equal(saved.status,200,saved.text);
 const receipt=JSON.parse(saved.text);assert.equal(receipt.pageId,page.id);
 const row=(await q.query('select page_id from training_load.dashboard_widgets where id=$1',[receipt.widgetId])).rows[0];assert.equal(row.page_id,page.id);
 const replay=await api(base+'/widgets',body,'POST');assert.equal(replay.status,200,replay.text);assert.deepEqual({...JSON.parse(replay.text),verification:undefined},{...receipt,verification:undefined});assert.equal(JSON.parse(replay.text).verification,'replayed');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_widgets where page_id=$1',[home])).rows[0].n,beforeHome);
 const legacy=await api(`/api/training-load/dashboards/${dashboard.id}`);assert.equal(JSON.parse(legacy.text).widgets.some(w=>w.id===receipt.widgetId),false);
 const shared={schemaVersion:1,mode:'relative',preset:'today',timeZone:'UTC'};
 const pagesRevision=(await q.query('select pages_revision from training_load.dashboards where id=$1',[dashboard.id])).rows[0].pages_revision;
 const changed=await api('/api/training-load/dashboards/'+dashboard.id+'/pages/'+page.id,{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:pagesRevision,operation:'defaults',input:{expectedDefaultsRevision:page.defaults_revision,defaultFilter:page.default_filter,period:shared}},'PATCH');assert.equal(changed.status,200,changed.text);
 const beforeReplay=(await q.query('select to_jsonb(p) row from training_load.dashboard_pages p where id=$1',[page.id])).rows[0].row;
 const ledger=(await q.query('select * from training_load.dashboard_simple_requests where request_id=$1 and initiator_user_id=$2',[body.requestId,actor.id])).rows[0];
 await q.query('select training_load.save_simple_page_widget($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[page.id,page.defaults_revision,actor.id,body.requestId,ledger.payload_hash,ledger.request_issued_at,dashboard.id,null,null,{},result.resolvedPeriod,ledger.workspace,{...shared,preset:'last_7_days'}]);
 assert.deepEqual((await q.query('select to_jsonb(p) row from training_load.dashboard_pages p where id=$1',[page.id])).rows[0].row,beforeReplay,'SQL replay never overwrites newer shared defaults');

});

test('copy to Home keeps source bytes unchanged and replays without duplicate widgets or series',async()=>{
 const source=(await q.query("select * from training_load.dashboard_widgets where dashboard_id=$1 and title='Page sessions'",[dashboard.id])).rows[0];assert.ok(source);
 const before=(await q.query('select to_jsonb(w) row from training_load.dashboard_widgets w where id=$1',[source.id])).rows[0].row;
 const target=(await q.query('select * from training_load.dashboard_pages where id=$1',[home])).rows[0];
 const body={requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),destinationPageId:home,expectedWidgetRevision:source.revision,expectedPageRevision:target.revision};
 const path=`/api/training-load/dashboards/${dashboard.id}/pages/${source.page_id}/widgets/${source.id}/copy`;
 const response=await api(path,body,'POST');assert.equal(response.status,200,response.text);const receipt=JSON.parse(response.text).receipt;
 assert.notEqual(receipt.widgetId,source.id);assert.equal(receipt.pageId,home);
 const replay=await api(path,body,'POST');assert.equal(replay.status,200,replay.text);assert.equal(replay.text,response.text);
 assert.deepEqual((await q.query('select to_jsonb(w) row from training_load.dashboard_widgets w where id=$1',[source.id])).rows[0].row,before);
 const copies=(await q.query('select * from training_load.dashboard_widgets where id=$1',[receipt.widgetId])).rows;assert.equal(copies.length,1);assert.equal(copies[0].page_id,home);
 const series=(await q.query('select id,built_in_series_key,created_by_user_id from training_load.dashboard_widget_series where widget_id=$1',[receipt.widgetId])).rows;assert.equal(series.length,1);assert.equal(series[0].built_in_series_key,'session_count');assert.equal(series[0].created_by_user_id,actor.id);
});

test('whole-dashboard clone preserves all Pages and keeps each widget on its mapped Page',async()=>{
 const revision=(await q.query('select revision from training_load.dashboards where id=$1',[dashboard.id])).rows[0].revision;
 const template=await api(`/api/training-load/dashboards/${dashboard.id}`,{expectedRevision:revision,isTemplate:true},'PATCH');assert.equal(template.status,200,template.text);
 const beforePages=(await q.query('select name,position,is_home,default_filter,period_config from training_load.dashboard_pages where dashboard_id=$1 order by position',[dashboard.id])).rows;
 const beforeWidgets=(await q.query('select p.name,w.title,w.widget_order,w.x,w.y,w.width,w.height,w.mobile_order,w.display_config,w.presentation_config from training_load.dashboard_widgets w join training_load.dashboard_pages p on p.id=w.page_id where w.dashboard_id=$1 order by p.position,w.widget_order',[dashboard.id])).rows;
 const clone=await api(`/api/training-load/dashboards/${dashboard.id}/clone`,{ownerScope:'user',name:'Pages clone'},'POST');assert.equal(clone.status,201,clone.text);const id=JSON.parse(clone.text).dashboard.id;
 assert.deepEqual((await q.query('select name,position,is_home,default_filter,period_config from training_load.dashboard_pages where dashboard_id=$1 order by position',[id])).rows,beforePages);
 assert.deepEqual((await q.query('select p.name,w.title,w.widget_order,w.x,w.y,w.width,w.height,w.mobile_order,w.display_config,w.presentation_config from training_load.dashboard_widgets w join training_load.dashboard_pages p on p.id=w.page_id where w.dashboard_id=$1 order by p.position,w.widget_order',[id])).rows,beforeWidgets);
});

test('Advanced create → series → edit → layout works on an explicit Page and legacy routes cannot write it',async()=>{
 const target=(await q.query("select * from training_load.dashboard_pages where dashboard_id=$1 and name='Recovery'",[dashboard.id])).rows[0];
 const root=`/api/training-load/dashboards/${dashboard.id}/pages/${target.id}`;
 const created=await api(root+'/widgets',{expectedPageRevision:target.revision,widgetType:'table',title:'Advanced Page',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0,groupBy:'athlete'},'POST');assert.equal(created.status,200,created.text);
 const id=JSON.parse(created.text).widgetId;assert.ok(id);
 const added=await api(root+`/widgets/${id}/series`,{expectedWidgetRevision:1,seriesOrder:0,builtInSeriesKey:'session_count',dataScopeLevel:'day',analyticalAggregation:'sum'},'POST');assert.equal(added.status,200,added.text);
 let widget=(await q.query('select * from training_load.dashboard_widgets where id=$1',[id])).rows[0];assert.equal(widget.page_id,target.id);
 const update=await api(root+`/widgets/${id}`,{expectedWidgetRevision:widget.revision,title:'Edited Page'},'PATCH');assert.equal(update.status,200,update.text);
 widget=(await q.query('select * from training_load.dashboard_widgets where id=$1',[id])).rows[0];
 const parent=(await q.query('select * from training_load.dashboard_pages where id=$1',[target.id])).rows[0];
 const layout=await api(root+'/layout',{expectedPageRevision:parent.revision,layout:[{widgetId:id,x:0,y:2,width:6,height:4,mobileOrder:0}]},'PUT');assert.equal(layout.status,200,layout.text);
 assert.equal((await q.query('select y from training_load.dashboard_widgets where id=$1',[id])).rows[0].y,2);
 const legacy=await api(`/api/training-load/dashboards/${dashboard.id}/widgets/${id}`,{expectedWidgetRevision:widget.revision+1,title:'Wrong legacy write'},'PATCH');assert.equal(legacy.status,404,legacy.text);
 assert.equal((await q.query('select title from training_load.dashboard_widgets where id=$1',[id])).rows[0].title,'Edited Page');
});

test('Page identity/defaults are signed: a token cannot save on another Page or after shared defaults change',async()=>{
 const created=await api('/api/training-load/dashboards',{name:'Page binding'},'POST');assert.equal(created.status,201,created.text);const d=JSON.parse(created.text).dashboard;
 const base=`/api/training-load/dashboards/${d.id}`;
 const create=async(name,revision)=>{const r=await api(base+'/pages',{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:revision,input:{name}},'POST');assert.equal(r.status,200,r.text);return JSON.parse(r.text).receipt.pageId};
 const a=await create('A',1),b=await create('B',2);
 const value=draft();value.title='Signed Page';value.metricRef={kind:'builtin',key:'session_count'};value.view={type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'};
 const input={contractVersion:1,context:{kind:'page',pageId:a,expectedPageDefaultsRevision:1,period:{dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'}},draftRef:{draftId:value.draftId,draftVersion:value.draftVersion},draft:value,editTarget:null};
 const preview=await api(base+'/simple/preview',input,'POST');assert.equal(preview.status,200,preview.text);const p=JSON.parse(preview.text);
 const body={requestId:crypto.randomUUID(),requestIssuedAt:p.requestIssuedAt,resolvedPeriod:p.resolvedPeriod,previewToken:p.previewToken,input:structuredClone(input)};body.input.context.pageId=b;
 const wrong=await api(base+'/simple/widgets',body,'POST');assert.equal(wrong.status,409,wrong.text);assert.equal(JSON.parse(wrong.text).error,'previewRequired');
 assert.equal((await q.query('select count(*)::int n from training_load.dashboard_widgets where dashboard_id=$1',[d.id])).rows[0].n,0);
 const update=await api(base+'/pages/'+a,{requestId:crypto.randomUUID(),requestIssuedAt:new Date().toISOString(),expectedPagesRevision:3,operation:'defaults',input:{expectedDefaultsRevision:1,defaultFilter:{athleteIds:[]},period:null}},'PATCH');assert.equal(update.status,200,update.text);
 body.requestId=crypto.randomUUID();body.input=structuredClone(input);const stale=await api(base+'/simple/widgets',body,'POST');assert.equal(stale.status,409,stale.text);assert.equal(JSON.parse(stale.text).error,'staleRevision');
});

test('Simple cannot open an edit target through another Page',async()=>{
 const revision=(await q.query('select revision from training_load.dashboards where id=$1',[dashboard.id])).rows[0].revision;const ordinary=await api('/api/training-load/dashboards/'+dashboard.id,{expectedRevision:revision,isTemplate:false},'PATCH');assert.equal(ordinary.status,200,ordinary.text);
 const widget=(await q.query("select * from training_load.dashboard_widgets where dashboard_id=$1 and title='Page sessions'",[dashboard.id])).rows[0];
 const other=(await q.query('select * from training_load.dashboard_pages where dashboard_id=$1 and id<>$2 limit 1',[dashboard.id,widget.page_id])).rows[0];
 const value=draft();value.metricRef={kind:'builtin',key:'session_count'};value.view={type:'table',groupBy:'athlete',dataScopeLevel:'day',analyticalAggregation:'sum'};
 const input={contractVersion:1,context:{kind:'page',pageId:other.id,expectedPageDefaultsRevision:other.defaults_revision,period:{dateFrom:'2026-11-01',dateTo:'2026-11-07',timeZone:'UTC'}},draftRef:{draftId:value.draftId,draftVersion:value.draftVersion},draft:value,editTarget:{widgetId:widget.id,expectedWidgetRevision:widget.revision}};
 const response=await api('/api/training-load/dashboards/'+dashboard.id+'/simple/preview',input,'POST');assert.equal(response.status,404,response.text);
});
