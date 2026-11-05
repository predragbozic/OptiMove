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
  const widget=options.widget ?? {id:widgetId,page_id:pageId,widget_type:'table',presentation_config:{schemaVersion:1}};
  const widgets=options.widgets ?? [widget], series=options.series ?? [{id:'series',widget_id:widgetId}];
  const client=Object.assign(new EventEmitter(),{release:destroy=>state.releases.push(destroy),query:async(sql,params=[])=>{
    state.queries.push({sql,params});
    if(sql.includes('to_regprocedure'))return{rows:[{ready:options.portsReady===true,combined_ready:options.combinedReady===true}]};
    if(sql==='commit'&&state.commitLost){state.commitLost=false;throw new Error('connection lost');}
    if(sql.includes('mutate_dashboard_page')){state.mutations.push(params);const receipt={requestId:params[1],dashboardId,pageId,operation:params[5],pagesRevision:2};state.ledger={request_id:params[1],payload_hash:params[2],workspace:target.workspace,receipt};return{rows:[{receipt}]};}
    if(sql.includes('dashboard_page_requests'))return{rows:state.ledger?.request_id===params[2]?[state.ledger]:[]};
    if(sql.includes('dashboard_pages'))return{rows:params.length===2&&typeof params[1]==='string'&&params[1]!==pageId?[]:[page]};
    if(sql.includes('dashboard_widgets'))return{rows:widgets};
    if(sql.includes('dashboard_widget_series'))return{rows:series};
    return{rows:[]};
  }});
  const service=createPagesService({pool:{connect:async()=>client},authorize:async(q,r,id,mode)=>{state.auth.push(mode);if(state.deny)throw Object.assign(new Error('notFound'),{code:'notFound',status:404});return target;},assertFilterVisible:async()=>{if(state.filterDenied)throw Object.assign(new Error('notFound'),{code:'notFound',status:404});},queryDashboard:async(...args)=>{state.batches.push(args);return options.result ?? [{widgetId,series:[]}];},now:()=>Date.parse('2026-11-04T12:00:00Z'),...options});
  return{state,page,target,service,widget,series};
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

const xSeriesId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ySeriesId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pairing=()=>({schemaVersion:1,widgetId,xSeriesId,ySeriesId});
function pairingFixture(options={}) {
  const widget={id:widgetId,page_id:pageId,widget_type:'line_chart',group_by:'day',presentation_config:{schemaVersion:1}};
  const series=[
    {id:xSeriesId,widget_id:widgetId,resolution_status:'resolved',metric_definition_id:other,built_in_series_key:null,data_scope_level:'day',analytical_aggregation:'sum',source_policy:'specific_source',source_connection_id:requestId,aggregation_role_policy:'standalone_only',coverage_policy:'full_only'},
    {id:ySeriesId,widget_id:widgetId,resolution_status:'resolved',metric_definition_id:null,built_in_series_key:'rpe',data_scope_level:'day',analytical_aggregation:'avg',source_policy:'all_sources',source_connection_id:null,aggregation_role_policy:'standalone_and_source_rollup',coverage_policy:'all'},
  ];
  const result=[{widgetId,series:series.map((entry,index)=>({widgetId,seriesId:entry.id,status:'ok',data:{current:[{athleteId:user,bucketKey:'2026-11-02',value:index?0:12.5,unit:index?'score':'m',sourceId:'saved-observation'}],comparison:null,comparisonRange:null}}))}];
  return fixture({widget,series,result,...options});
}
const queryPair=f=>f.service.query({req,dashboardId,pageId,body:{period,pairing:pairing()}});
const assertReadOnly=f=>{
  assert.equal(f.state.mutations.length,0);
  assert.match(f.state.queries[0].sql,/repeatable read read only/);
  assert.equal(f.state.queries.at(-1).sql,'rollback');
  assert.equal(f.state.queries.some(({sql})=>/^\s*(insert|update|delete|merge|create|alter|drop)\b|\bselect\s+training_load\.(mutate_dashboard_page|save_simple_page_widget)\s*\(/i.test(sql)),false);
};

test('pairing strict schema requires exactly four typed fields and distinct case-insensitive axes',async()=>{
  assert.equal(validatePageQuery(pageId,{pairing:pairing()}),true);
  assert.equal(validatePageQuery(pageId,{widgetIds:[widgetId.toUpperCase()],pairing:{...pairing(),xSeriesId:xSeriesId.toUpperCase()}}),true);
  const invalid=[null,[],true,1,'pairing',{}, {...pairing(),extra:1}, {...pairing(),schemaVersion:'1'}, {...pairing(),schemaVersion:true}, {...pairing(),schemaVersion:2}, {...pairing(),xSeriesId:ySeriesId.toUpperCase()}];
  for(const field of Object.keys(pairing())){
    const missing=pairing();delete missing[field];invalid.push(missing);
    for(const value of [null,{},[],false])invalid.push({...pairing(),[field]:value});
  }
  for(const field of ['widgetId','xSeriesId','ySeriesId'])for(const value of [1,'invalid',' '+xSeriesId])invalid.push({...pairing(),[field]:value});
  for(const value of invalid){
    const f=pairingFixture();
    assert.equal(validatePageQuery(pageId,{period,pairing:value}),false,JSON.stringify(value));
    await assert.rejects(f.service.query({req,dashboardId,pageId,body:{period,pairing:value}}),e=>e.code==='invalidRequest'&&e.status===400);
    assert.equal(f.state.queries.length,0);assert.equal(f.state.batches.length,0);
  }
  for(const widgetIds of [[],[other]])assert.equal(validatePageQuery(pageId,{widgetIds,pairing:pairing()}),false);
});

test('pairing uses existing JSON guard without invoking nested accessors or coercion',()=>{
  let calls=0;
  const accessor=pairing();Object.defineProperty(accessor,'xSeriesId',{enumerable:true,get(){calls++;return xSeriesId;}});
  const cast={toString(){calls++;return xSeriesId;}};
  const cyclic=pairing();cyclic.extra=cyclic;
  for(const value of [accessor,{...pairing(),xSeriesId:cast},cyclic,{...pairing(),[Symbol('hidden')]:1}])assert.equal(validatePageQuery(pageId,{pairing:value}),false);
  assert.equal(calls,0);
});

test('foreign pairing widget or either foreign series returns identical generic 404 before engine',async()=>{
  for(const patch of [{widgetId:other},{xSeriesId:other},{ySeriesId:other}]){
    const f=pairingFixture({widgets:[{id:widgetId,widget_type:'line_chart',group_by:'day'},{id:other,widget_type:'line_chart',group_by:'day'}]});
    f.series.push({id:other,widget_id:other});
    await assert.rejects(f.service.query({req,dashboardId,pageId,body:{period,pairing:{...pairing(),...patch}}}),e=>e.code==='notFound'&&e.status===404&&e.message==='notFound');
    assert.equal(f.state.batches.length,0);assert.deepEqual(f.state.auth,[{mode:'query'}]);assertReadOnly(f);
  }
  const f=pairingFixture();f.state.deny=true;
  await assert.rejects(queryPair(f),e=>e.code==='notFound'&&e.status===404);
  assert.equal(f.state.queries.some(({sql})=>sql.includes('dashboard_pages')),false);
  assert.equal(f.state.batches.length,0);
});

test('pairing is bound to saved definitions and exact batch observations with one shared query ID',async()=>{
  const f=pairingFixture(), input={period,runtimeFilter:{athleteIds:[user]},widgetIds:[widgetId],pairing:{...pairing(),xSeriesId:xSeriesId.toUpperCase(),ySeriesId:ySeriesId.toUpperCase()}}, before=structuredClone(input);
  const result=await f.service.query({req,dashboardId,pageId,body:input}), pair=result.metricPairs;
  assert.deepEqual(input,before);assert.equal(f.state.batches.length,1);
  assert.match(result.queryId,/^[0-9a-f-]{36}$/);assert.equal(pair.queryId,result.queryId);
  assert.equal(pair.schemaVersion,1);assert.equal(pair.status,'ready');assert.equal(pair.widgetId,widgetId);
  assert.equal(pair.xSeriesId,xSeriesId);assert.equal(pair.ySeriesId,ySeriesId);assert.deepEqual(pair.resolvedPeriod,result.resolvedPeriod);
  for(const [name,definition,unit]of [['x',f.series[0],'m'],['y',f.series[1],'score']]){
    assert.deepEqual(pair.bindings[name],{seriesId:definition.id,metricDefinitionId:definition.metric_definition_id,builtInSeriesKey:definition.built_in_series_key,dataScopeLevel:definition.data_scope_level,analyticalAggregation:definition.analytical_aggregation,sourcePolicy:definition.source_policy,sourceConnectionId:definition.source_connection_id,aggregationRolePolicy:definition.aggregation_role_policy,coveragePolicy:definition.coverage_policy,unit});
  }
  assert.deepEqual(pair.pairs,[{athleteId:user,bucketKey:'2026-11-02',x:{seriesId:xSeriesId,rowIndex:0,value:12.5,unit:'m',source:{policy:f.series[0].source_policy,configuredConnectionId:requestId,reported:{sourceId:'saved-observation'}}},y:{seriesId:ySeriesId,rowIndex:0,value:0,unit:'score',source:{policy:f.series[1].source_policy,configuredConnectionId:null,reported:{sourceId:'saved-observation'}}}}]);
  assert.deepEqual(f.state.batches[0][1][0].series,f.series);assert.deepEqual(f.state.batches[0][2],period);
  assert.deepEqual(f.state.batches[0][3].requestFilter,input.runtimeFilter);assertReadOnly(f);
});

test('ordinary callers retain exact response shape and pairing adds no SQL or extra batch',async()=>{
  const plain=pairingFixture(), paired=pairingFixture();
  const result=await plain.service.query({req,dashboardId,pageId,body:{period}}), withPair=await queryPair(paired);
  assert.deepEqual(Object.keys(result),['queryId','evaluatedAt','dashboardRevision','pageId','pageRevision','defaultsRevision','layoutRevision','resolvedPeriod','widgets']);
  assert.equal(Object.hasOwn(result,'metricPairs'),false);
  const {metricPairs,...oldShape}=withPair;
  assert.deepEqual({...oldShape,queryId:result.queryId},result);
  assert.deepEqual(paired.state.queries,plain.state.queries);assert.equal(plain.state.batches.length,1);assert.equal(paired.state.batches.length,1);
  assertReadOnly(plain);assertReadOnly(paired);
});

test('pairing supports configured server-resolved period and selected widget subset',async()=>{
  const f=pairingFixture();f.page.period_config={schemaVersion:1,mode:'relative',preset:'this_week',timeZone:'Europe/Belgrade'};
  const result=await f.service.query({req,dashboardId,pageId,body:{widgetIds:[widgetId],pairing:pairing()}});
  assert.equal(result.metricPairs.status,'ready');assert.deepEqual(result.metricPairs.resolvedPeriod,result.resolvedPeriod);
  assert.equal(result.resolvedPeriod.dateFrom,'2026-11-02');assertReadOnly(f);
});

test('unsupported widget, grouping and series statuses are helper refusals after the same batch',async()=>{
  for(const patch of [{widget_type:'table'},{group_by:'athlete'}]){
    const f=pairingFixture();Object.assign(f.widget,patch);
    const result=await queryPair(f);assert.equal(result.metricPairs.status,'unavailable');assert.equal(result.metricPairs.reason,'unsupportedWidget');assert.equal(f.state.batches.length,1);assertReadOnly(f);
  }
  const f=pairingFixture();f.series[0].resolution_status='unresolved';
  const result=await queryPair(f);assert.equal(result.metricPairs.status,'unavailable');assert.equal(result.metricPairs.reason,'seriesNotReady');assert.equal(f.state.batches.length,1);assertReadOnly(f);
});

test('response byte limit includes metricPairs and accepts the exact UTF-8 boundary without writes',async()=>{
  const probe=pairingFixture();const result=await queryPair(probe), bytes=Buffer.byteLength(JSON.stringify(result),'utf8');
  const ordinary=pairingFixture({responseLimit:bytes-1});
  await ordinary.service.query({req,dashboardId,pageId,body:{period}});
  const over=pairingFixture({responseLimit:bytes-1});
  await assert.rejects(queryPair(over),e=>e.code==='pageResponseTooLarge'&&e.status===413);assertReadOnly(over);
  const exact=pairingFixture({responseLimit:bytes});
  assert.equal(Buffer.byteLength(JSON.stringify(await queryPair(exact)),'utf8'),bytes);assertReadOnly(exact);
});

test('metric pairing capability requires query permission only, independent of migration markers',async()=>{
  for(const portsReady of [false,true])for(const combinedReady of [false,true])for(const canManage of [false,true])for(const canQuery of [false,true]){
    const f=fixture({portsReady,combinedReady});Object.assign(f.target,{canManage,canQuery});
    const result=await f.service.list({req,dashboardId});
    assert.equal(result.capabilities.metricPairing,canQuery?'athlete-bucket-v1':undefined);
    assert.equal(Object.hasOwn(result.capabilities,'metricPairing'),canQuery);assertReadOnly(f);
  }
});
