import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createPagesRouter} from '../src/dashboardPages/router.js';

test('HTTP parser ograničava originalne bajtove, mapira rute i skriva interne greške',async()=>{
  const calls=[];let deny=null;
  const service=Object.fromEntries(['list','detail','query','mutate','status'].map(method=>[method,async args=>{calls.push({method,args});if(deny)throw Object.assign(new Error('secret SQL foreign id'),{code:deny});return{ok:true};}]));
  const app=express();app.use((req,res,next)=>{if(req.headers['x-user'])req.user={id:'user'};next();});
  app.use('/dashboards/:dashboardId/pages',createPagesRouter({service}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const root=`http://127.0.0.1:${server.address().port}/dashboards/d/pages`;
  const send=(path='',options={})=>fetch(root+path,{headers:{'x-user':'yes','content-type':'application/json'},...options});
  try{
    assert.equal((await fetch(root)).status,401);assert.equal(calls.length,0);
    assert.equal((await send('',{method:'POST',body:' '.repeat(65536)+'{}'})).status,413);assert.equal(calls.length,0);
    assert.equal((await send('',{method:'POST',body:'{'})).status,400);assert.equal(calls.length,0);
    assert.equal((await send('',{method:'POST',body:'{}'})).status,201);assert.equal(calls.at(-1).args.operation,'create');assert.equal(calls.at(-1).args.dashboardId,'d');
    assert.equal((await send('/order',{method:'PUT',body:'{}'})).status,200);assert.equal(calls.at(-1).args.operation,'reorder');
    await send('/requests/r');assert.equal(calls.at(-1).method,'status');assert.equal(calls.at(-1).args.requestId,'r');
    await send('/p/query',{method:'POST',body:'{}'});assert.equal(calls.at(-1).method,'query');assert.equal(calls.at(-1).args.pageId,'p');
    deny='23514';const response=await send();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'pagesUnavailable'});
    deny='P4P02';const stale=await send();assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'stalePageRevision'});
  }finally{await new Promise(resolve=>server.close(resolve));}
});
