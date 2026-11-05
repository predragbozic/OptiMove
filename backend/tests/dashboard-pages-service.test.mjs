import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPagesService } from '../src/dashboardPages/service.js';
import { validatePageQuery } from '../src/dashboardPages/queryContract.js';
import { requireLegacySinglePage } from '../src/dashboardPages/legacyGuard.js';

const user='11111111-1111-4111-8111-111111111111', dashboardId='22222222-2222-4222-8222-222222222222', pageId='33333333-3333-4333-8333-333333333333', other='44444444-4444-4444-8444-444444444444', widgetId='55555555-5555-4555-8555-555555555555', requestId='66666666-6666-4666-8666-666666666666';
const req={user:{id:user}}, period={dateFrom:'2026-11-01',dateTo:'2026-11-04',timeZone:'Europe/Belgrade'};
function fixture(options={}) {
  const state={queries:[],releases:[],auth:[],batches:[],mutations:[],ledger:null,deny:false,filterDenied:false,commitLost:false};
  const page={id:pageId,dashboard_id:dashboardId,name:'Dnevni izveštaj',position:0,revision:2,defaults_revision:3,layout_revision:4,default_filter:{activityId:null},period_config:null,period_origin:'legacyRuntime'};
  const target={req,dashboard:{id:dashboardId,pages_revision:1,revision:5,status:'active',is_template:false,default_filter:{athleteIds:[user],activityId:other}},workspace:{dataWorkspaceType:'private_coach',dataWorkspaceUserId:user},canManage:true,canQuery:true};
  const widget={id:widgetId,page_id:pageId,widget_type:'table',presentation_config:{schemaVersion:1}};
  const client=Object.assign(new EventEmitter(),{release:destroy=>state.releases.push(destroy),query:async(sql,params=[])=>{
    state.queries.push({sql,params});
    if(sql.includes('to_regprocedure'))return{rows:[{ready:options.portsReady===true,combined_ready:options.combinedReady===true}]};
    if(sql==='commit'&&state.commitLost){state.commitLost=false;throw new Error('connection lost');}
    if(sql.includes('mutate_dashboard_page')){state.mutations.push(params);const receipt={requestId:params[1],dashboardId,pageId,operation:params[5],pagesRevision:2};state.ledger={request_id:params[1],payload_hash:params[2],workspace:target.workspace,receipt};return{rows:[{receipt}]};}
    if(sql.includes('dashboard_page_requests'))return{rows:state.ledger?.request_id===params[2]?[state.ledger]:[]};
    if(sql.includes('dashboard_pages'))return{rows:params.length===2&&typeof params[1]==='string'&&params[1]!==pageId?[]:[page]};
    if(sql.includes('dashboard_widgets'))return{rows:[widget]};
    if(sql.includes('dashboard_widget_series'))return{rows:[{id:'series',widget_id:widgetId}]};
    return{rows:[]};
  }});
  const service=createPagesService({pool:{connect:async()=>client},authorize:async(q,r,id,mode)=>{state.auth.push(mode);if(state.deny)throw Object.assign(new Error('notFound'),{code:'notFound',status:404});return target;},assertFilterVisible:async()=>{if(state.filterDenied)throw Object.assign(new Error('notFound'),{code:'notFound',status:404});},queryDashboard:async(...args)=>{state.batches.push(args);return[{widgetId,series:[]}];},now:()=>Date.parse('2026-11-04T12:00:00Z'),...options});
  return{state,page,target,service};
}
const createBody=()=>({contractVersion:1,requestId,name:'  Nova stranica  ',expectedPagesRevision:1,defaultFilter:{},periodConfig:{schemaVersion:1,mode:'fixed',...period}});

test('Page UI readiness requires both sanctioned ports and returns authorized parent metadata',async()=>{
  const f=fixture({portsReady:true});const result=await f.service.list({req,dashboardId});
  assert.equal(result.dashboard.id,dashboardId);assert.equal(result.capabilities.pages,true);assert.equal(result.capabilities.pageWidgetEditing,true);
  assert.equal(f.state.mutations.length,0);
  const legacy=fixture();assert.equal((await legacy.service.list({req,dashboardId})).capabilities.pages,false);
});
test('combined editing requires its migration marker, Page ports and both management/query rights',async()=>{
 for(const [portsReady,combinedReady,canManage,canQuery,expected] of [[true,true,true,true,true],[false,true,true,true,false],[true,false,true,true,false],[true,true,false,true,false],[true,true,true,false,false]]){
  const f=fixture({portsReady,combinedReady});Object.assign(f.target,{canManage,canQuery});
  assert.equal((await f.service.list({req,dashboardId})).capabilities.combinedCharts,expected);
 }
});

test('read snapshot vraća samo članove stranice i završava rollback-om bez upisa',async()=>{
  const f=fixture();const result=await f.service.detail({req,dashboardId,pageId});
  assert.equal(result.page.defaultsRevision,3);assert.equal(result.widgets[0].id,widgetId);
  assert.match(f.state.queries[0].sql,/repeatable read read only/);
  assert.ok(f.state.queries.some(q=>q.sql.includes('page_id=$2')&&q.params[1]===pageId));
  assert.equal(f.state.queries.at(-1).sql,'rollback');assert.deepEqual(f.state.releases,[false]);
});
test('list capabilities razlikuju čitanje od upravljanja i ne aktiviraju Page widget editore',async()=>{
  const f=fixture();f.target.canManage=false;
  const result=await f.service.list({req,dashboardId});
  assert.equal(result.capabilities.pageManagement,false);assert.equal(result.capabilities.pageWidgetEditing,false);assert.equal(result.capabilities.pages,false);
});
test('strana stranica i strano widget članstvo vraćaju 404 bez query engine-a',async()=>{
  const f=fixture();
  await assert.rejects(f.service.detail({req,dashboardId,pageId:other}),e=>e.code==='notFound');
  await assert.rejects(f.service.query({req,dashboardId,pageId,body:{period,widgetIds:[other]}}),e=>e.code==='notFound');
  assert.equal(f.state.batches.length,0);
});
test('legacyRuntime ne izmišlja period; eksplicitni runtime šalje jedan scoped batch',async()=>{
  const f=fixture();await assert.rejects(f.service.query({req,dashboardId,pageId,body:{}}),e=>e.code==='pagePeriodRequired');
  const result=await f.service.query({req,dashboardId,pageId,body:{period,runtimeFilter:{athleteIds:[]}}});
  assert.equal(f.state.batches.length,1);assert.deepEqual(result.resolvedPeriod,period);
  assert.deepEqual(f.state.batches[0][3].defaultFilter,{athleteIds:[user],activityId:null});
  assert.deepEqual(f.state.batches[0][3].requestFilter,{athleteIds:[]});assert.equal(result.pageId,pageId);
  assert.deepEqual(result.widgets[0].presentation_config,{schemaVersion:1});
});
test('configured relativni period razrešava server po imenovanoj zoni',async()=>{
  const f=fixture();f.page.period_origin='configured';f.page.period_config={schemaVersion:1,mode:'relative',preset:'this_week',timeZone:'Europe/Belgrade'};
  const result=await f.service.query({req,dashboardId,pageId,body:{}});
  assert.equal(result.resolvedPeriod.dateFrom,'2026-11-02');assert.equal(result.resolvedPeriod.dateTo,'2026-11-08');
});
test('zabrana pristupa ne čita stranice niti poziva engine',async()=>{
  const f=fixture();f.state.deny=true;
  await assert.rejects(f.service.query({req,dashboardId,pageId,body:{period}}),e=>e.code==='notFound');
  assert.equal(f.state.queries.some(q=>q.sql.includes('dashboard_pages')),false);assert.equal(f.state.batches.length,0);
});
test('write kanonizuje sadržaj, zaključava i zove samo sanctioned funkciju; retry ne ponavlja upis',async()=>{
  const f=fixture(),body=createBody(),before=structuredClone(body);
  const first=await f.service.mutate({req,dashboardId,operation:'create',body});
  assert.equal(first.verification,'commitAcknowledged');assert.equal(f.state.mutations.length,1);
  assert.equal(JSON.parse(f.state.mutations[0][6]).name,'Nova stranica');assert.deepEqual(body,before);
  const second=await f.service.mutate({req,dashboardId,operation:'create',body});
  assert.equal(second.verification,'replayed');assert.equal(f.state.mutations.length,1);
  assert.equal(f.state.auth.some(mode=>mode.lock===true),true);
  assert.equal(f.state.queries.some(q=>/^\s*(insert|update|delete)\b/i.test(q.sql)),false);
  await assert.rejects(f.service.mutate({req,dashboardId,operation:'create',body:{...body,name:'Druga'}}),e=>e.code==='idempotencyConflict');
});
test('izgubljen COMMIT proverava trajni receipt bez ponovnog upisa',async()=>{
  const f=fixture();f.state.commitLost=true;
  const result=await f.service.mutate({req,dashboardId,operation:'create',body:createBody()});
  assert.equal(result.verification,'verifiedAfterCommitError');assert.equal(f.state.mutations.length,1);assert.ok(f.state.releases.includes(true));
});
test('arhiviranje ne sprečava čitanje i replay završenog zahteva, ali sprečava novi upis',async()=>{
  const f=fixture(),body=createBody();
  await f.service.mutate({req,dashboardId,operation:'create',body});
  f.target.dashboard.status='archived';
  assert.equal((await f.service.status({req,dashboardId,requestId})).status,'recorded');
  assert.equal((await f.service.mutate({req,dashboardId,operation:'create',body})).verification,'replayed');
  await assert.rejects(f.service.mutate({req,dashboardId,operation:'create',body:{...body,requestId:other}}),e=>e.code==='dashboardArchived');
  assert.equal(f.state.mutations.length,1);
});
test('strani filter prekida transakciju pre sanctioned upisa',async()=>{
  const f=fixture();f.state.filterDenied=true;
  await assert.rejects(f.service.mutate({req,dashboardId,operation:'create',body:createBody()}),e=>e.code==='notFound');
  assert.equal(f.state.mutations.length,0);assert.equal(f.state.queries.at(-1).sql,'rollback');
});
test('status je scoped trenutnim workspace-om i initiator-om',async()=>{
  const f=fixture();await f.service.mutate({req,dashboardId,operation:'create',body:createBody()});
  const result=await f.service.status({req,dashboardId,requestId});assert.equal(result.status,'recorded');
  f.state.ledger.workspace={dataWorkspaceType:'team',dataWorkspaceScopeId:other};
  await assert.rejects(f.service.status({req,dashboardId,requestId}),e=>e.code==='notFound');
});
test('odgovor je ograničen pre izlaska iz read transakcije',async()=>{
  const f=fixture({responseLimit:64});await assert.rejects(f.service.list({req,dashboardId}),e=>e.code==='pageResponseTooLarge');
  assert.equal(f.state.queries.at(-1).sql,'rollback');
});
test('query ugovor odbija dodatne ključeve, nevažeće datume, duplikate i gettere',()=>{
  assert.equal(validatePageQuery(pageId,{}),true);
  for(const body of [{pageId:other},{period:{...period,dateTo:'2026-02-30'}},{widgetIds:[widgetId,widgetId.toUpperCase()]},{runtimeFilter:{ownerId:other}}])assert.equal(validatePageQuery(pageId,body),false);
  let called=0;const value={};Object.defineProperty(value,'period',{enumerable:true,get(){called++;return period;}});
  assert.equal(validatePageQuery(pageId,value),false);assert.equal(called,0);
});
test('legacy guard ne pretpostavlja Page UUID; bez migracije nema dodatnog upita',async()=>{
  let calls=0;assert.equal(await requireLegacySinglePage(()=>{calls++;},{id:dashboardId}),null);assert.equal(calls,0);
  assert.equal(await requireLegacySinglePage(async()=>({rows:[{id:pageId}]}),{id:dashboardId,pages_revision:1}),pageId);
  await assert.rejects(requireLegacySinglePage(async()=>({rows:[{id:pageId},{id:other}]}),{id:dashboardId,pages_revision:2}),e=>e.code==='pagesClientRequired');
});
