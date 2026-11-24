// Optional local evidence tool. Creates/drops its own loopback disposable database.
// Does not alter a working-tree source, migration file, or persistent database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {GALLERY_SQL_MUTATIONS} from '../tests/support/dashboard-gallery-sql-mutations.mjs';
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
async function printMutations(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-p2-print-mutations-'));const modulePath=path.resolve('frontend/training-load-dashboard-print.js');const testPath=path.resolve('frontend/tests/training-load-dashboard-print.test.mjs');const req=createRequire(testPath);const original=fs.readFileSync(modulePath,'utf8').replace('./training-load-dashboard-svg.js',pathToFileURL(path.resolve('frontend/training-load-dashboard-svg.js')).href);const test=fs.readFileSync(testPath,'utf8').replace('../training-load-dashboard-print.js',pathToFileURL(path.join(dir,'print.mjs')).href).replace("from 'jsdom'","from '"+pathToFileURL(req.resolve('jsdom')).href+"'");const results=[];
try{for(const [name,from,to]of [['control','',''],['collapsed-tables-included','details:not([open]),[hidden],pre,code','[hidden],pre,code'],['legend-omitted',"original.printLegend?.()??[]","[]"]]){if(from&&!original.includes(from))throw Error('missing mutation target');fs.writeFileSync(path.join(dir,'print.mjs'),from?original.replace(from,to):original);fs.writeFileSync(path.join(dir,'print.test.mjs'),test);const run=spawnSync(process.execPath,['--test',path.join(dir,'print.test.mjs')],{encoding:'utf8'});fs.writeFileSync(path.join(outputRoot,'print-'+name+'.log'),run.stdout+run.stderr);results.push({name,status:name==='control'?(run.status===0?'PASS':'FAIL'):(run.status!==0?'KILLED':'SURVIVED')});}return results;}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
async function sqlMutations(){
 const results=[];
 for(const name of [null,...Object.keys(GALLERY_SQL_MUTATIONS)]){
  const env={...process.env};delete env.DASHBOARD_GALLERY_SQL_MUTATION;if(name)env.DASHBOARD_GALLERY_SQL_MUTATION=name;
  const run=spawnSync(process.execPath,['scripts/test-runner.mjs','--project','backend','--kind','disposable','--file','dashboard-gallery-v94-disposable.test.mjs'],{cwd:root,env,encoding:'utf8',timeout:180000,windowsHide:true});
  const output=(run.stdout??'')+(run.stderr??'');fs.writeFileSync(path.join(outputRoot,(name??'sql-control')+'.runner.log'),output);
  const logs=output.match(/^Logs: (.+)$/m)?.[1].trim();if(!logs||run.error)throw Error('SQL mutation runner did not complete: '+name+' '+(run.error??output));
  const raw=fs.readFileSync(path.join(logs,'backend/disposable/dashboard-gallery-v94-disposable.test.mjs.log'),'utf8');fs.writeFileSync(path.join(outputRoot,(name??'sql-control')+'.test.log'),raw);
  const events=raw.split(/\r?\n/).filter(line=>line.startsWith('@@optimove-test@@ ')).map(line=>JSON.parse(line.slice(18)));
  const applied=events.some(e=>e.e==='pass'&&e.name.startsWith('v94 applies'));
  if(!name){results.push({name:'sql-control',status:run.status===0&&applied?'PASS':'FAIL'});continue;}
  const target=GALLERY_SQL_MUTATIONS[name].test,failed=events.find(e=>e.e==='fail'&&e.name===target);
  const functional=failed&&(name==='sql-shape-validation'?/^shape validation:/.test(failed.message):/Missing expected rejection/.test(failed.message));
  const installed=raw.includes('Installed test-only SQL mutation AFTER v94 apply/rollback/reapply: '+name);
  results.push({name,status:applied&&installed&&functional?'KILLED':'SURVIVED',killedBy:failed?.name??null,targetFailure:failed?.message??null,unmodifiedMigrationTestPassed:applied,installedAfterApply:installed});
 }
 return results;
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
