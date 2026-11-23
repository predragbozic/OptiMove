// Optional local evidence tool. Creates/drops its own loopback disposable database.
// Does not alter a working-tree source, migration file, or persistent database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createPagesDatabase} from '../tests/support/dashboard-pages-db.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.chdir(root);
const outputRoot=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-gallery-mutation-evidence-'));

async function dataMutations(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-p2-mutations-'));const original=fs.readFileSync('backend/src/dashboardGallery/data.js','utf8');const test=fs.readFileSync('backend/tests/dashboard-gallery-data.test.mjs','utf8');
const mutations=[
 ['duplicate-winner','rows.length===1 && usable(rows[0])','rows.length>=1 && usable(rows[0])'],
 ['conflict-admitted','!badFlags.some(key => r[key] === true)','true'],
 ['missing-as-zero','?rows[0].value:null','?rows[0].value:0'],
 ['ratio-stacked',"s.definition.analytical_aggregation === 'ratio'","false"],
 ['identity-positional','s.cells.get(identity) ?? []','[...s.cells.values()][cellKeys.indexOf(identity)] ?? []'],
 ['unit-guard-removed',"if (axes.has(binding.axis) && axes.get(binding.axis) !== found.unit)","if (false)"],
 ['athlete-bound-removed',"shape.kind!=='boxplot'&&new Set", "false&&new Set"]
];const results=[];try{for(const [name,from,to]of [['control','',''],...mutations]){if(from&&!original.includes(from)){results.push({name,status:'NOT RUN',reason:'mutation target missing'});continue;}fs.writeFileSync(path.join(dir,'data.mjs'),from?original.replace(from,to):original);fs.writeFileSync(path.join(dir,'data.test.mjs'),test.replace('../src/dashboardGallery/data.js',pathToFileURL(path.join(dir,'data.mjs')).href));const run=spawnSync(process.execPath,['--test',path.join(dir,'data.test.mjs')],{encoding:'utf8'});fs.writeFileSync(path.join(outputRoot,'data-'+name+'.log'),run.stdout+run.stderr);results.push({name,status:name==='control'?(run.status===0?'PASS':'FAIL'):(run.status!==0?'KILLED':'SURVIVED')});}return results;}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
async function printMutations(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-p2-print-mutations-'));const modulePath=path.resolve('frontend/training-load-dashboard-print.js');const testPath=path.resolve('frontend/tests/training-load-dashboard-print.test.mjs');const req=createRequire(testPath);const original=fs.readFileSync(modulePath,'utf8');const test=fs.readFileSync(testPath,'utf8').replace('../training-load-dashboard-print.js',pathToFileURL(path.join(dir,'print.mjs')).href).replace("from 'jsdom'","from '"+pathToFileURL(req.resolve('jsdom')).href+"'");const results=[];
try{for(const [name,from,to]of [['control','',''],['collapsed-tables-included','details:not([open]),[hidden],pre,code','[hidden],pre,code'],['legend-omitted',"original.printLegend?.()??[]","[]"]]){if(from&&!original.includes(from))throw Error('missing mutation target');fs.writeFileSync(path.join(dir,'print.mjs'),from?original.replace(from,to):original);fs.writeFileSync(path.join(dir,'print.test.mjs'),test);const run=spawnSync(process.execPath,['--test',path.join(dir,'print.test.mjs')],{encoding:'utf8'});fs.writeFileSync(path.join(outputRoot,'print-'+name+'.log'),run.stdout+run.stderr);results.push({name,status:name==='control'?(run.status===0?'PASS':'FAIL'):(run.status!==0?'KILLED':'SURVIVED')});}return results;}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
async function sqlMutations(){const db=await createPagesDatabase({through:'202611261000',label:'p2_sql_mutation'}),q=db.client;const results=[];async function check(name,fn,expected){try{await fn();results.push({name,status:expected?'SURVIVED':'PASS'});}catch(e){if(e.code==='ERR_ASSERTION')results.push({name,status:expected?'KILLED':'FAIL',reason:e.message.split('\n')[0]});else throw e;}}
try{
 const original=(await q.query("select pg_get_functiondef('training_load.dashboard_chart_shape_valid(jsonb)'::regprocedure) body")).rows[0].body;
 const shapeCheck=async()=>assert.equal((await q.query("select training_load.dashboard_chart_shape_valid('{\"schemaVersion\":1,\"kind\":\"scatter\",\"seriesIds\":[]}'::jsonb) valid")).rows[0].valid,false);
 await check('sql-shape-control',shapeCheck,false);await q.query('create or replace function training_load.dashboard_chart_shape_valid(s jsonb) returns boolean language sql immutable parallel safe as $$select true$$');await check('sql-shape-bypass',shapeCheck,true);await q.query(original);
 const actor=(await q.query("insert into public.users(email,first_name,last_name,full_name,display_name) values('p2-mutation@test.invalid','P2','Mutation','P2 Mutation','P2 Mutation') returning id")).rows[0].id;
 const dashboard=(await q.query("select * from training_load.create_dashboard('Mutation',null,'user',$1,null,null,'platform',null,false,$1,null)",[actor])).rows[0];const w=(await q.query("insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by) values($1,'bar_chart','Mutation',0,0,0,6,4,0,'day') returning *",[dashboard.id])).rows[0];let ids=[];for(const [index,key]of ['duration_minutes','srpe'].entries()){const rev=(await q.query('select revision from training_load.dashboard_widgets where id=$1',[w.id])).rows[0].revision;ids.push((await q.query("select * from training_load.add_series($1,$2,$3,null,$4,null,$5,null,null,'not_applicable',null,'session','sum')",[w.id,rev,index,key,index?'secondary':'primary'])).rows[0].series_id);}
 const body=(await q.query("select pg_get_functiondef('training_load.dashboard_chart_shape_assert(uuid)'::regprocedure) body")).rows[0].body;
 const checkAxis=async()=>{let refused=false;await q.query('begin');try{await q.query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1',[w.id,{schemaVersion:1,chartShape:{schemaVersion:1,kind:'combined',seriesIds:ids,bindings:ids.map((seriesId,index)=>({seriesId,mark:index?'line':'bar',axis:0}))}}]);await q.query('commit');}catch(e){await q.query('rollback');if(e.code==='S2C02'&&e.message==='incompatibleAxisUnit')refused=true;else throw e;}assert.equal(refused,true,'incompatible axes must be refused');};
 await check('sql-axis-control',checkAxis,false);const pattern=/if r\.gallery_unit is null or r\.axis is distinct from[\s\S]*?then raise exception 'incompatibleAxisUnit'/;assert.match(body,pattern);await q.query(body.replace(pattern,"if false then raise exception 'incompatibleAxisUnit'"));await check('sql-axis-bypass',checkAxis,true);await q.query(body);
 return results;
}finally{await db.drop()}
}


async function interactionMutations(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-gallery-interaction-mutations-')),results=[];
 const imports=(source,base)=>source.replace(/(['"])(\.\.?\/[^'"]+)\1/g,(_all,quote,name)=>quote+pathToFileURL(path.resolve(base,name)).href+quote);
 try{for(const [name,moduleName,testName,from,to]of [
  ['stale-context-accepted','training-load-actions.js','training-load-analysis.actions.test.mjs','||Number(action.dataset.boundGeneration)!==analysisChartInteractionGeneration()',''],
  ['legend-toggle-ignored','training-load-analysis-echarts-options.js','training-load-gallery-options.test.mjs',"plot.option.legend.selectedMode=false","plot.option.legend.selectedMode=true"]
 ]){
  const modulePath=path.join(root,'frontend',moduleName),testPath=path.join(root,'frontend/tests',testName),original=fs.readFileSync(modulePath,'utf8');
  if(!original.includes(from))throw Error('Missing mutation target '+name);
  for(const control of [true,false]){
   const filename=path.join(dir,'subject.mjs');fs.writeFileSync(filename,imports(control?original:original.replace(from,to),path.dirname(modulePath)));
   const test=imports(fs.readFileSync(testPath,'utf8'),path.dirname(testPath)).replaceAll(pathToFileURL(modulePath).href,pathToFileURL(filename).href);fs.writeFileSync(path.join(dir,'subject.test.mjs'),test);
   const run=spawnSync(process.execPath,['--test',path.join(dir,'subject.test.mjs')],{encoding:'utf8',timeout:30000});
   fs.writeFileSync(path.join(outputRoot,name+(control?'-control':'')+'.log'),run.stdout+run.stderr);
   results.push({name:name+(control?'-control':''),status:control?(run.status===0?'PASS':'FAIL'):(run.status!==0?'KILLED':'SURVIVED')});
  }
 }return results;}finally{fs.rmSync(dir,{recursive:true,force:true})}
}

const results=[...await interactionMutations(),...await dataMutations(),...await printMutations(),...await sqlMutations()];
fs.writeFileSync(path.join(outputRoot,'results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({results,logs:outputRoot},null,2));
if(results.some(r=>!['PASS','KILLED'].includes(r.status)))process.exitCode=1;
