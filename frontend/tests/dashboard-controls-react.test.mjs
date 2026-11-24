import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
let dom,islands;
const hosts=[];
before(async()=>{
  dom=new JSDOM('<!doctype html><body></body>',{url:'http://localhost/',pretendToBeVisual:true});
  for(const key of ['window','document','navigator','HTMLElement','Node','Event','MouseEvent','MutationObserver']) Object.defineProperty(globalThis,key,{value:key==='window'?dom.window:dom.window[key],configurable:true,writable:true});
  islands=await import('../react-build/islands.js');
});
afterEach(()=>{for(const host of hosts.splice(0)){islands.unmountIsland(host);host.remove();}});
after(()=>dom.window.close());
function mount(name,props){const host=document.createElement('div');document.body.append(host);hosts.push(host);islands.mountIsland(host,islands[name],props,{name:'dashboard_controls'});return host;}
const home={id:'home',name:'Home',is_home:true,position:0};
const pageProps={pages:[home,{id:'second',name:'Performance',position:1}],selectedPageId:'home',page:home,busy:false,canManage:true};
test('page tabs retain selected state and renamed Home identity without duplicating Home',()=>{
 const host=mount('DashboardPageStrip',pageProps);
 assert.equal(host.querySelector('[aria-current="page"]').textContent,'Home');
 assert.equal(host.textContent.includes('Home · Home'),false);
 islands.mountIsland(host,islands.DashboardPageStrip,{...pageProps,pages:[{...home,name:'Overview'}]});
 assert.equal(host.querySelector('nav').textContent,'Overview · Home');
});
test('page mutations are absent for viewers and disabled while a write is unknown',()=>{
 const host=mount('DashboardPageStrip',{...pageProps,canManage:false});
 assert.equal(host.querySelectorAll('nav button').length,2);
 assert.equal(host.querySelector('details'),null);
 assert.equal(host.querySelector('[data-action="training-load-pages-create"]'),null);
 islands.mountIsland(host,islands.DashboardPageStrip,{...pageProps,busy:true});
 assert.equal(host.querySelectorAll('button:not(:disabled)').length,0);
 assert.equal(host.querySelector('summary').getAttribute('aria-disabled'),'true');
});
test('Home cannot be deleted or reordered; secondary actions are inside the disclosure',()=>{
 const host=mount('DashboardPageStrip',pageProps);
 assert.equal(host.querySelector('[data-action="training-load-pages-delete"]'),null);
 assert.equal(host.querySelector('[data-action="training-load-pages-up"]'),null);
 assert.equal(host.querySelector('details').open,false);
 assert.ok(host.querySelector('details [data-action="training-load-pages-defaults"]'));
 islands.mountIsland(host,islands.DashboardPageStrip,{...pageProps,page:pageProps.pages[1],selectedPageId:'second'});
});
test('period button exposes a single compact accessible trigger and activity indicator',()=>{
 let toggled=0;
 const host=mount('DashboardPeriodButton',{label:'Last 28 days',open:false,activeFilter:true,onToggle:()=>toggled++});
 const button=host.querySelector('button');button.click();
 assert.equal(toggled,1);
 assert.equal(button.getAttribute('aria-expanded'),'false');
 assert.match(button.getAttribute('aria-label'),/activity selected/);
 assert.equal(host.querySelector('input'),null);
});
test('period panel retains existing date and preset actions and explicit close',()=>{
 let closed=0;
 const host=mount('DashboardPeriodFields',{presets:[{key:'28d',label:'Last 28 days'},{key:'7d',label:'Last 7 days'}],selected:'7d',dateFrom:'2026-11-01',dateTo:'2026-11-07',onClose:()=>closed++});
 assert.equal(host.querySelector('[aria-pressed="true"]').dataset.preset,'7d');
 assert.equal(host.querySelector('[data-action="training-load-analysis-period-from"]').value,'2026-11-01');
 assert.equal(host.querySelector('[data-action="training-load-analysis-period-to"]').value,'2026-11-07');
 host.querySelector('[aria-label="Close period and activity"]').click();assert.equal(closed,1);
});

test('the bridge preserves an open filter across query repaints, closes on Escape, and releases detached roots', async()=>{
 const {state,emptyTrainingLoadState}=await import('../state.js');
 const {renderTrainingLoadAnalysisHtml}=await import('../training-load-analysis-view.js');
 const bridge=await import('../dashboard-controls.js');
 state.trainingLoad=emptyTrainingLoadState();
 state.currentUser={id:'test-user',activeWorkspace:{type:'club',scopeId:'test-club'}};
 const a=state.trainingLoad.analysis;
 a.selectedDashboardId='dashboard';a.dashboard={id:'dashboard',name:'Proba2',status:'active',is_template:false};
 a.pagesAvailable=true;a.pages=[home];a.page=home;a.pageCanManage=true;a.selectedPageId='home';
 a.period={dateFrom:'2026-11-01',dateTo:'2026-11-07'};
 const root=document.createElement('div');document.body.append(root);
 try{
   root.innerHTML=renderTrainingLoadAnalysisHtml();await bridge.mountDashboardControls(root);
   assert.equal(root.querySelector('#dashboard-period-panel').hidden,true);
   root.querySelector('.tl-compact-period').click();
   assert.equal(root.querySelector('#dashboard-period-panel').hidden,false);
   bridge.disposeDashboardControls();root.innerHTML=renderTrainingLoadAnalysisHtml();await bridge.mountDashboardControls(root);
   assert.equal(root.querySelector('#dashboard-period-panel').hidden,false,'query repaint does not close the date panel');
   bridge.closeDashboardControlPanel({type:'keydown',key:'Escape',preventDefault(){},stopPropagation(){}});
   assert.equal(root.querySelector('#dashboard-period-panel').hidden,true);
   assert.equal(document.activeElement,root.querySelector('.tl-compact-period'));
   root.querySelector('.tl-compact-page-menu summary').click();
   assert.equal(root.querySelector('.tl-compact-page-menu').open,true);
   bridge.disposeDashboardControls();root.innerHTML=renderTrainingLoadAnalysisHtml();await bridge.mountDashboardControls(root);
   assert.equal(root.querySelector('.tl-compact-page-menu').open,true,'finishing a query must not close the action menu');
   const tab=root.querySelector('[data-dashboard-controls="pages"]');
   root.remove();await new Promise(resolve=>setTimeout(resolve,0));
   assert.equal(islands.isIslandMounted(tab),false);
 }finally{bridge.disposeDashboardControls();root.remove();}
});
