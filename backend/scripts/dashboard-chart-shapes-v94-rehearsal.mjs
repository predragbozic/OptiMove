// Loopback-only owner rehearsal. Every suite creates/drops its own disposable DB.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';import pg from 'pg';
import {parseArgs,databaseUrl} from './dashboard-pages-rehearsal.mjs';
import {assertGalleryRehearsalNode} from '../src/dashboardGallery/rehearsalConfig.js';
export async function runGalleryRehearsal(argv){
 assertGalleryRehearsalNode();const args=parseArgs(argv);if(!argv.includes('--old-build'))args.oldBuild='3cf0f7f92ec82ee75ed470149c9ab688c1fd384b';
 const root=fileURLToPath(new URL('../../',import.meta.url)),env={...process.env},password=env.OPTIMOVE_REHEARSAL_PASSWORD??env.PGPASSWORD??'';
 for(const k of Object.keys(env))if(k.toUpperCase().startsWith('PG'))delete env[k];
 env.DATABASE_URL=databaseUrl(args,password);env.P1_PREVIOUS_BUILD_SHA=args.oldBuild;env.DASHBOARD_GALLERY_REHEARSAL='true';
 if(args.pgBin){const keys=Object.keys(env).filter(k=>k.toLowerCase()==='path'),oldPath=env[keys[0]]??'';for(const key of keys)delete env[key];env[process.platform==='win32'?'Path':'PATH']=args.pgBin+path.delimiter+oldPath;}
 const probe=new pg.Client({connectionString:env.DATABASE_URL});await probe.connect();try{const row=(await probe.query("select current_setting('server_version_num')::int version,current_setting('server_version') label")).rows[0];if(Math.floor(row.version/10000)!==17)throw Error('Use PostgreSQL 17, matching production.');console.log('Gallery rehearsal: Node '+process.versions.node+'; PostgreSQL '+row.label+'; loopback '+args.host+':'+args.port+'; maintenance postgres');}finally{await probe.end()}
 console.log('Previous deployed build:',args.oldBuild);
 for(const file of ['dashboard-gallery-data.test.mjs','dashboard-gallery-contract.test.mjs','dashboard-gallery-compiler.test.mjs','dashboard-gallery-rehearsal-config.test.mjs','dashboard-gallery-staging.test.mjs','dashboard-gallery-v94-disposable.test.mjs','dashboard-gallery-http-disposable.test.mjs','dashboard-pages-legacy-server.test.mjs']){
  if(!fs.existsSync(path.join(root,'backend/tests',file)))throw Error('Missing rehearsal suite: '+file);
  const command=['scripts/test-runner.mjs','--project','backend',...(!file.includes('disposable')&&!file.includes('legacy-server')?['--kind','unit']:[]),'--file',file];console.log('\nnode '+command.join(' '));
  const r=spawnSync(process.execPath,command,{cwd:root,env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)throw Error('Rehearsal failed: '+file);
 }
 console.log('\nRESULT: PASS');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)runGalleryRehearsal(process.argv.slice(2)).catch(error=>{console.error('RESULT: FAIL — '+error.message);process.exitCode=1});
