import { test,mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter,once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { id } from './fixtures/dashboard-simple/contracts.mjs';
import { validatePageAdvancedRequest as valid } from '../src/dashboardPages/advancedContract.js';
import { createPageAdvancedRouter } from '../src/dashboardPages/advancedRouter.js';
import { runDashboardCloneTransaction } from '../src/dashboardPages/cloneTransaction.js';
import { copyDashboardPages } from '../src/dashboardPages/clonePages.js';

const wrapper = fields => ({contractVersion:1,requestId:id(10),...fields});
const create = () => wrapper({expectedPageRevision:1,widgetType:'table',title:'Widget',widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0});
test('Advanced actions use Page revisions and reject unknown, coerced or unsafe fields',()=>{
  for(const[op,input]of[['widgetCreate',create()],['layout',wrapper({expectedPageLayoutRevision:1,layout:[{widgetId:id(2),x:0}]})],['widgetLayout',wrapper({expectedWidgetRevision:1,y:8})],['widgetContent',wrapper({expectedWidgetRevision:1,title:'Novo'})],['widgetDelete',wrapper({expectedWidgetRevision:1})],['seriesAdd',wrapper({expectedWidgetRevision:1,seriesOrder:0,builtInSeriesKey:'srpe'})],['seriesUpdate',wrapper({expectedWidgetRevision:1,color:null})],['seriesDelete',wrapper({expectedWidgetRevision:1})],['seriesReorder',wrapper({expectedWidgetRevision:1,order:[{seriesId:id(3),seriesOrder:0}]})],['seriesResolve',wrapper({expectedWidgetRevision:1,metricDefinitionId:id(4)})]]){
    assert.equal(valid(op,input),true,op);
    assert.equal(valid(op,{...input,ownerUserId:id(1)}),false,op);
    assert.equal(valid(op,{...input,contractVersion:'1'}),false,op);
  }
  const wrong=create();wrong.expectedDashboardRevision=1;delete wrong.expectedPageRevision;assert.equal(valid('widgetCreate',wrong),false);
  assert.equal(valid('widgetCreate',{...create(),width:13}),false);
  assert.equal(valid('widgetContent',wrapper({expectedWidgetRevision:1})),false);
  assert.equal(valid('widgetContent',wrapper({expectedWidgetRevision:1,title:null})),false);
  const cycle=create();cycle.cycle=cycle;assert.equal(valid('widgetCreate',cycle),false);
});
test('Nested layout/series identities, binding hints and presentation modes are strict',()=>{
  assert.equal(valid('layout',wrapper({expectedPageLayoutRevision:1,layout:[{widgetId:id(2),x:0},{widgetId:id(2).toUpperCase(),y:2}]})),false);
  assert.equal(valid('layout',wrapper({expectedPageLayoutRevision:1,layout:[{widgetId:id(2),pageId:id(3),x:0}]})),false);
  assert.equal(valid('seriesAdd',wrapper({expectedWidgetRevision:1,seriesOrder:0,metricDefinitionId:id(4),templateMetricKeyHints:[{key:'x'}]})),false);
  assert.equal(valid('seriesAdd',wrapper({expectedWidgetRevision:1,seriesOrder:0,builtInSeriesKey:'srpe',sourcePolicy:'manual'})),false);
  assert.equal(valid('seriesReorder',wrapper({expectedWidgetRevision:1,order:[{seriesId:id(3),seriesOrder:0},{seriesId:id(4),seriesOrder:0}]})),false);
  assert.equal(valid('widgetCreate',{...create(),presentation:{mode:'preserve'}}),false);
  assert.equal(valid('widgetContent',wrapper({expectedWidgetRevision:1,presentation:{mode:'preserve'},localFilterOverride:null})),true);
});

test('Advanced HTTP forwards Page identity and sanitizes errors before global parser',async t=>{
  const calls=[],app=express();
  app.use((req,res,next)=>{req.user={id:id(1)};next();});
  app.use('/dashboards/:dashboardId/pages/:pageId/advanced',createPageAdvancedRouter({service:{status:async args=>({status:'notRecorded'}),mutate:async args=>{calls.push(args);if(args.body.fail)throw Object.assign(new Error('private table name'),{code:'P4A01'});return {pageId:args.pageId};}}}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const root=`http://127.0.0.1:${server.address().port}/dashboards/${id(2)}/pages/${id(3)}/advanced`;
  const send=body=>fetch(root+'/widgets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send(create())).status,201);assert.equal(calls[0].pageId,id(3));assert.equal(calls[0].operation,'widgetCreate');
  const conflict=await send({fail:true});assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'stalePageLayoutRevision'});
  assert.equal((await send({x:' '.repeat(70000)})).status,413);
});

function connection(options={}){
  const client=new EventEmitter(),calls=[],releases=[];
  client.query=async(sql,args)=>{calls.push({sql,args});if(sql==='commit'&&options.lostCommit)throw new Error('lost ack');return {rows:[]};};
  client.release=destroy=>releases.push(destroy);
  return {pool:{connect:cb=>cb(null,client)},client,calls,releases};
}
test('Clone observes disconnect and rolls back/destroys without an unhandled error',async()=>{
  const f=connection();
  await assert.rejects(runDashboardCloneTransaction({pool:f.pool,write:async q=>{f.client.emit('error',new Error('connection terminated'));await q('select 1');},verify:async()=>null}),{code:'outcomeUnknown'});
  assert.deepEqual(f.releases,[true]);assert.equal(f.client.listenerCount('error'),0);
});
test('Clone rollback and lost-COMMIT recovery do not repeat composite writes',async()=>{
  const f=connection();let writes=0;
  await assert.rejects(runDashboardCloneTransaction({pool:f.pool,write:async q=>{await q('insert into test values ($1)',[1]);throw Object.assign(new Error('business'),{code:'notFound'});},verify:async()=>assert.fail()}),{code:'notFound'});
  assert.ok(f.calls.some(c=>c.sql==='rollback'));assert.deepEqual(f.releases,[false]);
  const g=connection({lostCommit:true});
  const result=await runDashboardCloneTransaction({pool:g.pool,write:async()=>{writes++;return {dashboard:{id:id(4)}};},verify:async()=>({dashboard:{id:id(4)}})});
  assert.equal(writes,1);assert.equal(result.dashboard.id,id(4));assert.deepEqual(g.releases,[true]);assert.ok(!g.calls.some(c=>c.sql==='rollback'));
});
test('Clone Page graph preserves null legacy defaults and independent ordering',async()=>{
  const pages=[{id:id(1),name:'Prva',position:0,default_filter:{},period_config:null,period_origin:'legacyRuntime'},{id:id(2),name:'Druga',position:1,default_filter:{athleteIds:[]},period_config:{x:1},period_origin:'configured'}],calls=[];
  const q=async(sql,args)=>{calls.push({sql,args});return {rows:sql.startsWith('select *')?pages:sql.startsWith('select id')?[{id:id(5)}]:sql.startsWith('insert')?[{id:id(6)}]:[]};};
  const mapping=await copyDashboardPages(q,{id:id(3),pages_revision:1},{id:id(4)});
  assert.deepEqual([...mapping],[[id(1),id(5)],[id(2),id(6)]]);
  assert.equal(calls[2].args[4],null);assert.equal(calls[2].args[5],'legacyRuntime');assert.equal(calls[3].args[2],1);
});

if(!process.execArgv.includes('--experimental-test-module-mocks')){
  test('Page Advanced service with isolated database mock',()=>{const r=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',fileURLToPath(import.meta.url)],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);});
}else{
  mock.module('../src/db.js',{namedExports:{query:async()=>assert.fail('Default database forbidden')}});
  const {createPageAdvancedService}=await import('../src/dashboardPages/advancedService.js');
  const target={req:{user:{id:id(1)}},workspace:{type:'team'},dashboard:{id:id(2),status:'active',is_template:false,data_workspace_type:'team'}};
  const args=()=>({req:target.req,dashboardId:id(2),pageId:id(3),operation:'widgetDelete',widgetId:id(4),body:wrapper({expectedWidgetRevision:1})});
  function fixture({receipt=null,foreign=false,archived=false,lostCommit=false,boxplotReady=false,boxplotError=false}={}){
    const f=connection({lostCommit});let saved=receipt;
    const original=f.client.query;
    f.client.query=async(sql,params)=>{
      if(sql.includes("to_regprocedure('training_load.dashboard_boxplot_flush_checks()')"))return {rows:[{ready:boxplotReady}]};
      if(sql==='select training_load.dashboard_boxplot_flush_checks()'){f.calls.push({sql,params});if(boxplotError)throw Object.assign(new Error('boxplot shape'),{code:'S2C02'});return {rows:[]};}
      if(sql.includes('from training_load.dashboard_page_advanced_requests'))return {rows:saved?[saved]:[]};
      if(sql.includes('from training_load.dashboard_pages'))return {rows:[{id:id(3)}]};
      if(sql.includes('from training_load.dashboard_widgets'))return {rows:foreign?[]:[{id:id(4)}]};
      if(sql.includes('mutate_dashboard_page_advanced')){saved={dashboard_id:id(2),page_id:id(3),workspace:target.workspace,payload_hash:params[2],receipt:{requestId:id(10),operation:'widgetDelete',pageId:id(3)}};return {rows:[{receipt:saved.receipt}]};}
      return original(sql,params);
    };
    const service=createPageAdvancedService({pool:f.pool,authorize:async()=>({...target,dashboard:{...target.dashboard,status:archived?'archived':'active'}}),assertFilterVisible:async()=>{}});return {...f,service};
  }
  test('Advanced rejects a foreign widget before mutation and permits deleted-target replay',async()=>{
    const foreign=fixture({foreign:true});await assert.rejects(foreign.service.mutate(args()),{code:'notFound'});
    const f=fixture(),first=await f.service.mutate(args());assert.equal(first.pageId,id(3));
    const replay=await f.service.mutate(args());assert.equal(replay.verification,'replayed');
  });
  test('Box plot constraints flush before COMMIT; known shape rejection rolls back instead of reporting unknown outcome',async()=>{
    const valid=fixture({boxplotReady:true});assert.equal((await valid.service.mutate(args())).verification,'commitAcknowledged');
    assert.ok(valid.calls.findIndex(c=>c.sql==='select training_load.dashboard_boxplot_flush_checks()')<valid.calls.findIndex(c=>c.sql==='commit'));
    const invalid=fixture({boxplotReady:true,boxplotError:true});await assert.rejects(invalid.service.mutate(args()),{code:'S2C02'});
    assert.ok(invalid.calls.some(c=>c.sql==='rollback'));assert.equal(invalid.calls.some(c=>c.sql==='commit'),false);
  });
  test('Advanced lost COMMIT is recovered from Page ledger; archive/status keep completed proof',async()=>{
    const f=fixture({lostCommit:true});const result=await f.service.mutate(args());assert.equal(result.verification,'verifiedAfterCommitError');
    assert.equal((await f.service.status({...args(),requestId:id(10)})).status,'recorded');
    await assert.rejects(f.service.status({...args(),pageId:id(8),requestId:id(10)}),{code:'notFound'});
    const archived=fixture({archived:true});await assert.rejects(archived.service.mutate(args()),{code:'dashboardArchived'});
  });
}
