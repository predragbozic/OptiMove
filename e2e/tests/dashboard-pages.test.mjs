import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {launch,openAs,openTrainingLoad} from '../lib/browser.mjs';
import {startWorld} from '../lib/world.mjs';
let world,browser;
before(async()=>{
 const config={DASHBOARD_PAGES_ENABLED:'true',DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'2',DASHBOARD_SIMPLE_KEY_ID:'pages-browser-fixture',DASHBOARD_SIMPLE_KEY_BASE64:randomBytes(32).toString('base64')};
 const previous=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));Object.assign(process.env,config);
 try{world=await startWorld()}finally{for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v}
 const q=new pg.Client({connectionString:world.databaseUrl});await q.connect();try{await q.query('update training_load.dashboard_pages_activation set enabled=true')}finally{await q.end()}
 browser=await launch();
});
after(async()=>{await browser?.close();await world?.stop()});
const action=(page,name)=>page.locator(`[data-action="training-load-${name}"]`).first();
for(const width of [360,390,1280])test(`(${width}px) Pages create, rename, reorder, Simple save, copy, navigation and empty deletion`,async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',width);
 try{
  const created=await context.request.post(world.baseUrl+'/api/training-load/dashboards',{data:{name:'Pages browser '+width}});assert.equal(created.status(),201,await created.text());
  const {dashboard}=await created.json();
  await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();
  await action(page,'analysis-open-picker').click();await page.locator(`[data-dashboard-id="${dashboard.id}"]`).click();
  await page.locator('.tl-dashboard-pages nav').waitFor();
  assert.equal(await page.locator('#dashboard-period-panel').isVisible(),false);
  const sizes=await (await page.waitForFunction(()=>{
    const top=document.querySelector('.tl-analysis-topbar-compact'), strip=document.querySelector('.tl-compact-page-row');
    if(!top||!strip) return false;
    const height=top.getBoundingClientRect().height, pagesHeight=strip.getBoundingClientRect().height;
    return height>0&&pagesHeight>0?{height,pagesHeight}:false;
  })).jsonValue();
  assert.ok(sizes.height<=64,'toolbar stays one compact row: '+sizes.height);
  assert.ok(sizes.pagesHeight<=58,'Pages stays one compact row: '+sizes.pagesHeight);
  await page.getByRole('button',{name:/^Period:/}).click();
  await page.locator('[data-action="training-load-analysis-period-from"]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Choose activity',exact:true}).isVisible(),true);
  await page.locator('.tl-compact-presets button[data-preset="7d"]').click();
  await page.getByRole('button',{name:'Period: Last 7 days',exact:true}).waitFor();
  assert.equal(await page.locator('#dashboard-period-panel').isVisible(),true,'period selection does not dismiss its panel');
  const customDate=await page.locator('[data-action="training-load-analysis-period-from"]').inputValue();
  const dayBefore=new Date(customDate+'T00:00:00Z');dayBefore.setUTCDate(dayBefore.getUTCDate()-1);
  await page.locator('[data-action="training-load-analysis-period-from"]').fill(dayBefore.toISOString().slice(0,10));
  await page.getByRole('button',{name:'Period: Custom period',exact:true}).waitFor();
  if(process.env.DASHBOARD_COMPACT_SCREENSHOTS){await mkdir(process.env.DASHBOARD_COMPACT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.DASHBOARD_COMPACT_SCREENSHOTS,'dashboard-filters-'+width+'.png')});}
  await page.getByRole('button',{name:'Close period and activity',exact:true}).click();
  assert.equal(await page.locator('#dashboard-period-panel').isVisible(),false);
  if(process.env.DASHBOARD_COMPACT_SCREENSHOTS){await mkdir(process.env.DASHBOARD_COMPACT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.DASHBOARD_COMPACT_SCREENSHOTS,'dashboard-compact-'+width+'.png')});}
  await action(page,'pages-create').click();await action(page,'pages-name').fill('Home');await action(page,'pages-save').click();await page.getByText('A page with that name already exists. Choose a different name.',{exact:true}).waitFor();await action(page,'pages-name').fill('Performance');await action(page,'pages-preset').selectOption('last_7_days');await action(page,'pages-save').click();
  await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Performance'}).waitFor();
  await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-rename').click();await action(page,'pages-name').fill('Peak');await action(page,'pages-save').click();
  await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Peak'}).waitFor();
  await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-defaults').click();await action(page,'pages-preset').selectOption('today');await action(page,'pages-save').click();await page.locator('.tl-page-form').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await action(page,'analysis-add-widget').click();await page.locator('[data-action="training-load-simple-metric"][data-kind="builtin"][data-id="session_count"]').click();
  await action(page,'simple-next').click();await action(page,'simple-next').click();await action(page,'simple-title').fill('Page sessions');await action(page,'simple-preview').click();await page.locator('.tl-simple-preview-status[data-ready=true]').waitFor();await action(page,'simple-save').click();await page.locator('.tl-simple-editor').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Widget actions: Page sessions'}).click();await action(page,'pages-open-copy').click();await action(page,'pages-destination').selectOption({label:'Home'});await action(page,'pages-save').click();
  await page.getByText('Widget copied to Home.',{exact:true}).waitFor();await page.locator('.tl-dashboard-pages nav button').filter({hasText:'Home'}).click();await page.getByRole('button',{name:'Widget actions: Page sessions'}).waitFor();
  await page.locator('.tl-dashboard-pages nav button').filter({hasText:'Peak'}).click();await page.getByRole('button',{name:'Widget actions: Page sessions'}).waitFor();
  await page.reload();await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const reopenedTab=page.getByRole('tab',{name:'Dashboards'});if(await reopenedTab.isVisible())await reopenedTab.click();await action(page,'analysis-open-picker').click();await page.locator('[data-dashboard-id="'+dashboard.id+'"]').first().click();await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Peak'}).waitFor();
  await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-delete').click();await page.locator('.tl-page-form [data-action="training-load-pages-save"]').click();await page.getByText('This page still has widgets. Remove them before deleting the page.',{exact:true}).waitFor();await action(page,'pages-cancel').click();
  await action(page,'pages-create').click();await action(page,'pages-name').fill('Empty');await action(page,'pages-save').click();await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Empty'}).waitFor();await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-up').focus();await action(page,'pages-up').press('Enter');await page.locator('.tl-dashboard-pages nav button').nth(1).filter({hasText:'Empty'}).waitFor();await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-down').click();await page.locator('.tl-dashboard-pages nav button').nth(2).filter({hasText:'Empty'}).waitFor();await page.getByLabel('Page actions',{exact:true}).click();await action(page,'pages-delete').click();await page.locator('.tl-page-form [data-action="training-load-pages-save"]').click();await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Home'}).waitFor();
  assert.deepEqual(pageErrors,[]);assert.equal(await page.locator('.tl-layout-bar').count(),0);
  if(process.env.DASHBOARD_PAGES_SCREENSHOTS){await mkdir(process.env.DASHBOARD_PAGES_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.DASHBOARD_PAGES_SCREENSHOTS,`pages-${width}.png`)})}
 }finally{await context.close()}
});

for(const role of ['team_coach','club_admin'])test(role+': Page errors contain a plain next step without technical details',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,role,360);
 try{const created=await context.request.post(world.baseUrl+'/api/training-load/dashboards',{data:{name:'Private Pages '+role}});assert.equal(created.status(),201,await created.text());const {dashboard}=await created.json();
 await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();await action(page,'analysis-open-picker').click();await page.locator('[data-dashboard-id="'+dashboard.id+'"]').first().click();await page.locator('.tl-dashboard-pages nav').waitFor();
 await action(page,'pages-create').click();await action(page,'pages-save').click();await page.getByText('Choose a page name before saving.',{exact:true}).waitFor();
 const text=await page.locator('body').textContent();assert.doesNotMatch(text,/invalidRequest|previewToken|fingerprint|payload_hash|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);assert.equal(await page.locator('.tl-simple-technical').count(),0);assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});

test('a late Page detail cannot replace another dashboard after navigation',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);let release;
 try{const make=async(name)=>{const r=await context.request.post(world.baseUrl+'/api/training-load/dashboards',{data:{name}});assert.equal(r.status(),201,await r.text());return (await r.json()).dashboard};const a=await make('Delayed Pages A'),b=await make('Current Pages B');
 const add=async(d,title)=>{const r=await context.request.post(world.baseUrl+'/api/training-load/dashboards/'+d.id+'/widgets',{data:{expectedDashboardRevision:d.revision,widgetType:'table',title,widgetOrder:0,x:0,y:0,width:6,height:4,mobileOrder:0,groupBy:'athlete'}});assert.equal(r.status(),201,await r.text())};await add(a,'Old Page widget');await add(b,'Current Page widget');
 let arrived;const seen=new Promise(resolve=>{arrived=resolve});const hold=new Promise(resolve=>{release=resolve});
 await page.route('**/api/training-load/dashboards/'+a.id+'/pages/*',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response})});
 await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();await action(page,'analysis-open-picker').click();await page.locator('[data-dashboard-id="'+a.id+'"]').first().click();await seen;
 await action(page,'analysis-open-picker').click();await page.locator('[data-dashboard-id="'+b.id+'"]').first().click();await page.getByRole('button',{name:'Widget actions: Current Page widget'}).waitFor();
 const oldReply=page.waitForResponse(r=>r.url().includes('/dashboards/'+a.id+'/pages/'));release();const response=await oldReply;await response.finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.getByRole('button',{name:'Widget actions: Current Page widget'}).waitFor();assert.equal(await page.getByRole('button',{name:'Widget actions: Old Page widget'}).count(),0);assert.deepEqual(pageErrors,[]);
 }finally{release?.();await context.close()}
});

test('Page writes use server time even when the browser clock is ten minutes ahead',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);
 try{const created=await context.request.post(world.baseUrl+'/api/training-load/dashboards',{data:{name:'Server-clock Pages'}});assert.equal(created.status(),201,await created.text());const {dashboard}=await created.json();
 await page.addInitScript(()=>{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[OriginalDate.now()+600000]))}static now(){return OriginalDate.now()+600000}}});await page.reload();
 await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();await action(page,'analysis-open-picker').click();await page.locator('[data-dashboard-id="'+dashboard.id+'"]').first().click();await page.locator('.tl-dashboard-pages nav').waitFor();
 const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/dashboards/'+dashboard.id+'/pages'));await action(page,'pages-create').click();await action(page,'pages-name').fill('Clock-safe page');await action(page,'pages-save').click();const body=(await sent).postDataJSON();assert.ok(Math.abs(Date.parse(body.requestIssuedAt)-Date.now())<30000,'issued-at comes from the server read');await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Clock-safe page'}).waitFor();assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});
