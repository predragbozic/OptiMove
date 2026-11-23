// PG17-only, loopback-only rehearsal. Never accepts a database name. Each test
// creates/drops its own optimove_tests_* database using the repository safety helper.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {PREVIOUS_BUILD} from '../tests/support/dashboard-pages-old-server.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function parseArgs(argv){
 const out={host:'127.0.0.1',port:'5432',user:'postgres',pgBin:null,oldBuild:PREVIOUS_BUILD};
 const names={'--host':'host','--port':'port','--user':'user','--pg-bin':'pgBin','--old-build':'oldBuild'};
 for(let n=0;n<argv.length;n++){
  const field=names[argv[n]],value=argv[++n];if(!field||!value||value.startsWith('--'))throw Error('Use --host, --port, --user, --pg-bin and --old-build only; no database name is accepted');out[field]=value;
 }
 if(!['127.0.0.1','localhost','::1'].includes(out.host))throw Error('Rehearsal host must be loopback');
 if(!/^[0-9]{1,5}$/.test(out.port)||Number(out.port)<1||Number(out.port)>65535)throw Error('Invalid local port');
 if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(out.user))throw Error('Invalid PostgreSQL user');
 if(!/^[0-9a-f]{40}$/.test(out.oldBuild))throw Error('The previous build must be a full commit SHA');
 if(out.pgBin&&!fs.statSync(out.pgBin).isDirectory())throw Error('--pg-bin must be a directory');
 return out;
}
export function databaseUrl(args,password=''){
 const u=new URL(`postgres://${args.host==='::1'?'[::1]':args.host}:${args.port}/postgres`);u.username=args.user;if(password)u.password=password;return u.toString();
}
export async function runRehearsal(argv){
 const args=parseArgs(argv);
 if(Number(process.versions.node.split('.')[0])!==22)throw Error('Use Node 22 for the rehearsal');
 const env={...process.env};const password=env.OPTIMOVE_REHEARSAL_PASSWORD??env.PGPASSWORD??'';
 for(const key of Object.keys(env))if(key.toUpperCase().startsWith('PG'))delete env[key];
 env.DATABASE_URL=databaseUrl(args,password);env.P1_PREVIOUS_BUILD_SHA=args.oldBuild;
 if(args.pgBin){
  const pathKeys=Object.keys(env).filter(key=>key.toLowerCase()==='path');const originalPath=env[pathKeys[0]]??process.env.PATH??'';
  for(const key of pathKeys)delete env[key];env[process.platform==='win32'?'Path':'PATH']=args.pgBin+path.delimiter+originalPath;
 }
 const probe=new pg.Client({connectionString:env.DATABASE_URL});await probe.connect();
 try{
  const row=(await probe.query("select current_setting('server_version_num')::int version,current_setting('server_version') label")).rows[0];
  if(Math.floor(row.version/10000)!==17)throw Error('Use PostgreSQL 17, matching production');
  console.log(`P1 rehearsal: Node ${process.versions.node}; PostgreSQL ${row.label}; loopback ${args.host}:${args.port}; maintenance postgres`);
 }finally{await probe.end()}
 console.log('Previous server build:',args.oldBuild);
 const files=['dashboard-pages-migration.test.mjs','dashboard-pages-writers.test.mjs','dashboard-pages-v91-rollback.test.mjs','dashboard-pages-legacy-server.test.mjs','dashboard-pages-disposable.test.mjs','dashboard-pages-access.test.mjs','dashboard-pages-concurrency.test.mjs'];
 for(const file of files){
  if(!fs.existsSync(path.join(root,'backend/tests',file)))throw Error('Missing required rehearsal test: '+file);
  const command=['scripts/test-runner.mjs','--project','backend','--file',file];console.log('\nnode '+command.join(' '));
  const result=spawnSync(process.execPath,command,{cwd:root,env,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;if(result.status!==0)throw Error('Rehearsal failed: '+file);
 }
 console.log('\nRESULT: PASS');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 runRehearsal(process.argv.slice(2)).catch(error=>{console.error('RESULT: FAIL — '+error.message);process.exitCode=1});
}
