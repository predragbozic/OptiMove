// Run an exact repository commit, with its lockfile verified against installed
// dependencies. Only the generated scratch tree and a disposable database are used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateKeyEntry} from '../../src/sourceCredentialCrypto.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export const PREVIOUS_BUILD='aa6e765c86525f23d4ff970c9fa550b4183bae01';
export async function previousDashboardServer(databaseUrl,overrides={},commit=process.env.P1_PREVIOUS_BUILD_SHA??PREVIOUS_BUILD){
 const url=new URL(databaseUrl);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^optimove_tests_[a-z0-9_]+$/.test(url.pathname.slice(1)))throw Error('Previous-build rehearsal requires its own disposable database');
 if(!/^[0-9a-f]{40}$/.test(commit))throw Error('Exact previous build SHA required');
 execFileSync('git',['cat-file','-e',commit+'^{commit}'],{cwd:root,windowsHide:true});
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'optimove-p1-old-build-'));
 const build=path.join(scratch,'build');fs.mkdirSync(build);
 let child,linked=false;
 const dependencies=path.join(build,'backend/node_modules');
 const cleanup=async()=>{
  if(child&&child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});
  if(linked){fs.unlinkSync(dependencies);linked=false}
  if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('optimove-p1-old-build-'))throw Error('Scratch cleanup refused');
  fs.rmSync(scratch,{recursive:true,force:true});
 };
 try{
  execFileSync('git',['archive','--format=tar','-o',path.join(scratch,'old.tar'),commit],{cwd:root,windowsHide:true});
  execFileSync('tar',['-xf',path.join(scratch,'old.tar'),'-C',build],{windowsHide:true});
  const installed=JSON.parse(fs.readFileSync(path.join(root,'backend/package-lock.json'),'utf8'));
  const previous=JSON.parse(fs.readFileSync(path.join(build,'backend/package-lock.json'),'utf8'));
  if(JSON.stringify(installed)!==JSON.stringify(previous))throw Error('Previous build dependency lock differs; prepare its exact dependencies before rehearsal');
  fs.symlinkSync(path.join(root,'backend/node_modules'),dependencies,process.platform==='win32'?'junction':'dir');linked=true;
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
  const baseUrl='http://127.0.0.1:'+port;
  const env={...process.env,...overrides,DATABASE_URL:databaseUrl,PORT:String(port),NODE_ENV:'development'};
  for(const key of Object.keys(env))if(/^(SUPABASE|RENDER|GPEXE_API_TOKEN|SOURCE_CREDENTIAL_|APP_ERROR_USER_HASH_KEYS)/.test(key))delete env[key];
  env.SOURCE_CREDENTIAL_KEYS=generateKeyEntry(1);env.APP_ERROR_USER_HASH_KEYS=generateKeyEntry(2);
  child=spawn(process.execPath,['src/server.js'],{cwd:path.join(build,'backend'),env,stdio:'ignore',windowsHide:true});
  const until=Date.now()+60000;
  while(Date.now()<until){if(child.exitCode!==null)throw Error('Previous server exited '+child.exitCode);try{if((await fetch(baseUrl+'/api/health')).ok)return{baseUrl,commit,stop:cleanup}}catch{}await new Promise(r=>setTimeout(r,100))}
  throw Error('Previous server startup timed out');
 }catch(error){await cleanup();throw error}
}
