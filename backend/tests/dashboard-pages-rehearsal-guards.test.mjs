import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs,databaseUrl} from '../scripts/dashboard-pages-rehearsal.mjs';
test('rehearsal accepts only loopback maintenance targets and exact old-build SHA',()=>{
 assert.equal(parseArgs([]).host,'127.0.0.1');assert.throws(()=>parseArgs(['--host','example.com']),/loopback/);assert.throws(()=>parseArgs(['--database','postgres']),/no database name/);assert.throws(()=>parseArgs(['--port','0']),/port/);assert.throws(()=>parseArgs(['--port','65536']),/port/);assert.throws(()=>parseArgs(['--old-build','main']),/full commit/);
});
test('IPv6 and credentials form a maintenance URL without accepting a target DB override',()=>{
 const u=new URL(databaseUrl(parseArgs(['--host','::1','--port','5439','--user','test_user']),'test-only:@'));
 assert.equal(u.hostname,'[::1]');assert.equal(u.pathname,'/postgres');assert.equal(u.port,'5439');assert.equal(decodeURIComponent(u.password),'test-only:@');
});
