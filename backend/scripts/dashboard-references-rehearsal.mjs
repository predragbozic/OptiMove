import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
if(Number(process.versions.node.split('.')[0])<20)throw Error('Node 20 or newer is required.');
const target=new URL(process.env.DATABASE_URL??'invalid:');
if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||!['postgres:','postgresql:'].includes(target.protocol))throw Error('Only a dedicated loopback test cluster is allowed.');
const root=fileURLToPath(new URL('../../',import.meta.url));
// mock.module is a Node 22 test API. Node 20 still runs the identical real-DB packet.
const files=['dashboard-p3-calculations.test.mjs','dashboard-references-v97-disposable.test.mjs','dashboard-references-http-disposable.test.mjs','dashboard-references-migration-disposable.test.mjs'];
if(Number(process.versions.node.split('.')[0])>=22)files.push('dashboard-reference-query.test.mjs');
const args=['scripts/test-runner.mjs','--project','backend',...files.flatMap(file=>['--file',file])];
console.log('P3 rehearsal: disposable optimove_tests_* databases only; Node '+process.versions.node+'.');
const child=spawnSync(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit'});
if(child.error)throw child.error;if(child.status!==0){console.error('RESULT: FAIL');process.exit(child.status??1);}console.log('RESULT: PASS');
