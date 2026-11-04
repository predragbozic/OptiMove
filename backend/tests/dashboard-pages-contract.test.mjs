import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePageRequest, MAX_DASHBOARD_PAGES } from '../src/dashboardPages/contract.js';

const requestId='11111111-1111-4111-8111-111111111111';
const pageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const periodConfig={schemaVersion:1,mode:'fixed',dateFrom:'2026-11-01',dateTo:'2026-11-04',timeZone:'Europe/Belgrade'};
const bodies={
  create:{name:'Dnevni izveštaj',periodConfig,defaultFilter:{},expectedPagesRevision:1},
  rename:{name:'Igrači',expectedPageRevision:2},
  defaults:{defaultFilter:{athleteIds:null,activityId:null},expectedPageDefaultsRevision:3},
  reorder:{pageIds:[pageId,otherId],expectedPagesRevision:4},
  duplicate:{name:'Kopija',expectedPageRevision:2,expectedPagesRevision:4},
  delete:{expectedPageRevision:2,expectedPagesRevision:4,deleteWidgets:false},
};
const input=operation=>structuredClone({contractVersion:1,requestId,...bodies[operation]});
for(const operation of Object.keys(bodies)) {
  test(`${operation}: validan zahtev ne menja ulaz`,()=>{
    const value=input(operation),before=structuredClone(value);
    assert.deepEqual(validatePageRequest(operation,value),{valid:true,issues:[]});
    assert.deepEqual(value,before);
  });
  test(`${operation}: nema prećutne verzije, request ID-a ili stranih ownership polja`,()=>{
    for(const patch of [{contractVersion:2},{requestId:'bad'},{ownerUserId:otherId},{dashboardId:otherId},{pageId},{expectedWidgetRevision:1}]) {
      assert.equal(validatePageRequest(operation,{...input(operation),...patch}).valid,false);
    }
    for(const field of ['contractVersion','requestId',...Object.keys(bodies[operation])]) {
      const value=input(operation);delete value[field];
      if(operation==='defaults'&&field==='defaultFilter')continue;
      assert.equal(validatePageRequest(operation,value).valid,false,field);
    }
  });
}
test('naziv ne prihvata prazno, kontrolne znakove, predugačko ili automatski cast',()=>{
  for(const name of ['', '  ', 'a\nb', '\0', 'a'.repeat(201), null, 42]) assert.equal(validatePageRequest('create',{...input('create'),name}).valid,false);
  assert.equal(validatePageRequest('create',{...input('create'),name:' Izveštaj 🏃 '} ).valid,true);
});
test('revizije su pozitivni bezbedni celi brojevi; nema mešanja defaults/layout revizija',()=>{
  for(const revision of [0,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1]) assert.equal(validatePageRequest('rename',{...input('rename'),expectedPageRevision:revision}).valid,false);
  assert.equal(validatePageRequest('defaults',{contractVersion:1,requestId,expectedPageRevision:1,periodConfig}).valid,false);
  assert.equal(validatePageRequest('rename',{...input('rename'),expectedLayoutRevision:1}).valid,false);
});
test('period koristi postojeći ugovor: validna zona, stvarni datum i najviše 400 uključivih dana',()=>{
  for(const patch of [{timeZone:'Bad/Zone'},{dateFrom:'2026-02-30'},{dateTo:'2026-10-01'},{dateTo:'2028-11-01'},{mode:'today'}]) assert.equal(validatePageRequest('create',{...input('create'),periodConfig:{...periodConfig,...patch}}).valid,false);
  assert.equal(validatePageRequest('create',{...input('create'),periodConfig:{schemaVersion:1,mode:'relative',preset:'this_week',timeZone:'Europe/Belgrade'}}).valid,true);
});
test('nasleđivanje i eksplicitni clear filtera ostaju različiti, bez tuđih ključeva',()=>{
  for(const defaultFilter of [{},{athleteIds:[]},{athleteIds:null},{athleteIds:[pageId]},{activityId:null,componentId:otherId}]) assert.equal(validatePageRequest('create',{...input('create'),defaultFilter}).valid,true);
  for(const defaultFilter of [{athleteIds:[pageId,pageId.toUpperCase()]},{athleteIds:['bad']},{ownerScope:'team'},{dateFrom:'2026-01-01'}]) assert.equal(validatePageRequest('create',{...input('create'),defaultFilter}).valid,false);
});
test('defaults izmena mora biti eksplicitna i neprazna',()=>{
  assert.equal(validatePageRequest('defaults',{contractVersion:1,requestId,expectedPageDefaultsRevision:1}).valid,false);
  assert.equal(validatePageRequest('defaults',{contractVersion:1,requestId,expectedPageDefaultsRevision:1,periodConfig}).valid,true);
});
test('reorder odbija prazno, nevažeće ID-ove i duplikate različitog case-a',()=>{
  for(const pageIds of [[],null,[pageId,'bad'],[pageId,pageId.toUpperCase()]]) assert.equal(validatePageRequest('reorder',{...input('reorder'),pageIds}).valid,false);
});
test('reorder je ograničen na 32 stranice; server kasnije proverava kompletno članstvo',()=>{
  const ids=Array.from({length:MAX_DASHBOARD_PAGES+1},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
  assert.equal(validatePageRequest('reorder',{...input('reorder'),pageIds:ids.slice(0,MAX_DASHBOARD_PAGES)}).valid,true);
  assert.equal(validatePageRequest('reorder',{...input('reorder'),pageIds:ids}).valid,false);
});
test('brisanje zahteva eksplicitno boolean opredeljenje za widgete',()=>{
  for(const deleteWidgets of [null,'false',0]) assert.equal(validatePageRequest('delete',{...input('delete'),deleteWidgets}).valid,false);
  assert.equal(validatePageRequest('delete',{...input('delete'),deleteWidgets:true}).valid,true);
});
test('ne izvršava gettere i odbija cikluse, sparse nizove, simbole i ne-JSON vrednosti',()=>{
  let calls=0;const getter=input('create');Object.defineProperty(getter,'trap',{enumerable:true,get(){calls++;return 1;}});
  const cycle=input('create');cycle.self=cycle;
  const symbol=input('create');symbol[Symbol('secret')]=1;
  const sparse=input('reorder');sparse.pageIds=Array(2);
  for(const value of [getter,cycle,symbol,sparse,{...input('create'),x:undefined},{...input('create'),x:Infinity},{...input('create'),x:new Date()},JSON.parse('{"__proto__":{}}')]) assert.equal(validatePageRequest('create',value).valid,false);
  assert.equal(calls,0);
  class UnsafeArray extends Array { toJSON(){calls++;return [];} }
  assert.equal(validatePageRequest('reorder',{...input('reorder'),pageIds:new UnsafeArray(pageId)}).valid,false);
  assert.equal(calls,0);
});
test('veličina payload-a je ograničena i nepoznata operacija ne dobija podrazumevano značenje',()=>{
  const result=validatePageRequest('create',{...input('create'),name:'a'.repeat(65537)});
  assert.equal(result.issues[0].code,'payloadTooLarge');
  assert.throws(()=>validatePageRequest('publish',input('create')),TypeError);
});
