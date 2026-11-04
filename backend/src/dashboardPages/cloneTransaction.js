import { performance } from 'node:perf_hooks';
import { checkoutObservedClient } from '../dashboardSimple/clientLifecycle.js';
import { previewError } from '../dashboardSimple/previewTransaction.js';

const bounded = (promise,ms,code) => {
  let timer;
  return Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(previewError(code)),ms);})]).finally(()=>clearTimeout(timer));
};

// Composite clone is the existing explicit exception to sanctioned SQL writes.
// Observe the leased connection and bound its lifetime just like Simple saves.
export async function runDashboardCloneTransaction({pool,write,verify,checkoutTimeoutMs=1000,transactionTimeoutMs=10000,statementTimeoutMs=3000,commitTimeoutMs=5000}) {
  if(!pool || typeof write!=='function' || typeof verify!=='function' || ![checkoutTimeoutMs,transactionTimeoutMs,statementTimeoutMs,commitTimeoutMs].every(v=>Number.isSafeInteger(v)&&v>0) || checkoutTimeoutMs>1000 || transactionTimeoutMs>10000 || statementTimeoutMs>3000 || commitTimeoutMs>5000)throw new TypeError('Bounded clone dependencies required');
  const pending=checkoutObservedClient(pool); let lease;
  try{lease=await bounded(pending,checkoutTimeoutMs,'cloneUnavailable');}
  catch(error){pending.then(late=>late.lifecycle.release(true),()=>{}).catch(()=>{});throw error;}
  const {client,lifecycle}=lease,deadline=performance.now()+transactionTimeoutMs;
  let queue=Promise.resolve(),stopped=false,begun=false,commitStarted=false;
  const q=(sql,args=[])=>{
    const next=queue.then(async()=>{
      lifecycle.check();
      if(stopped || performance.now()>=deadline)throw previewError('cloneUnavailable');
      if(typeof sql!=='string' || !/^\s*(select|insert|update)\b/i.test(sql) || /;\s*\S/.test(sql))throw previewError('cloneUnavailable');
      await client.query(`set local statement_timeout='${Math.max(1,Math.min(statementTimeoutMs,Math.floor(deadline-performance.now())))}ms'`);
      lifecycle.check(); if(stopped || performance.now()>=deadline)throw previewError('cloneUnavailable');
      return client.query(sql,args);
    });
    queue=next.catch(()=>{});return next;
  };
  try{
    begun=true;
    await bounded(lifecycle.run(()=>client.query('begin')),Math.max(1,deadline-performance.now()),'cloneUnavailable');
    await bounded(lifecycle.run(()=>client.query("set local lock_timeout='1000ms'")),Math.max(1,deadline-performance.now()),'cloneUnavailable');
    const result=await bounded(lifecycle.run(()=>write(q)),Math.max(1,deadline-performance.now()),'cloneUnavailable');
    await bounded(lifecycle.run(()=>queue),Math.max(1,deadline-performance.now()),'cloneUnavailable');
    lifecycle.check();if(performance.now()>=deadline)throw previewError('cloneUnavailable');
    commitStarted=true;
    await bounded(lifecycle.run(()=>client.query('commit')),commitTimeoutMs,'outcomeUnknown');
    begun=false;lifecycle.release(false);return result;
  }catch(error){
    stopped=true;
    if(commitStarted){
      lifecycle.release(true);
      try{const recovered=await bounded(Promise.resolve().then(verify),5000,'outcomeUnknown');if(recovered)return recovered;}
      catch(recoveryError){if(['notFound','workspaceSelectionRequired'].includes(recoveryError?.code))throw recoveryError;}
      throw previewError('outcomeUnknown');
    }
    let rolledBack=false;
    if(begun){try{await bounded(lifecycle.run(async()=>{await queue;await client.query('rollback');}),500,'outcomeUnknown');rolledBack=true;}catch{}}
    lifecycle.release(!rolledBack);
    if(!rolledBack)throw previewError('outcomeUnknown');
    throw error;
  }
}
