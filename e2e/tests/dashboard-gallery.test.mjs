import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import pg from 'pg';
import {launch,openAs,openTrainingLoad} from '../lib/browser.mjs';import {startWorld} from '../lib/world.mjs';
import {seedGalleryMeasurements,seedGalleryDashboard} from '../../backend/tests/support/dashboard-gallery-seed.mjs';
let world,browser,gallery;const byRole=new Map();
const action=(page,name)=>page.locator(`[data-action="training-load-${name}"]`);
async function openDashboard(page,id){await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();await page.locator('.tl-dash-picker-trigger').click();await page.locator('[data-dashboard-id="'+id+'"]').first().click();await page.locator('optimove-dashboard-chart svg').first().waitFor();}
before(async()=>{
 const config={DASHBOARD_PAGES_ENABLED:'true',DASHBOARD_SIMPLE_MODE:'enabled',DASHBOARD_SIMPLE_BUDGET_VERIFIED:'true',DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED:'true',DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE:'2',DASHBOARD_SIMPLE_KEY_ID:'gallery-browser',DASHBOARD_SIMPLE_KEY_BASE64:randomBytes(32).toString('base64')},previous=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));Object.assign(process.env,config);
 try{world=await startWorld()}finally{for(const [k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;}
 const q=new pg.Client({connectionString:world.databaseUrl});await q.connect();try{
  await q.query('update training_load.dashboard_pages_activation set enabled=true');const actor=world.accounts.find(a=>a.role==='platform_admin');
  const definitions=await seedGalleryMeasurements(q,{actorId:actor.id,clubId:world.ids.clubA,athleteIds:world.ids.athleteIds});
  await seedGalleryMeasurements(q,{actorId:actor.id,clubId:world.ids.clubA,teamId:world.ids.teamA,athleteIds:world.ids.athleteIds,dates:['2026-11-02','2026-11-03'],existingDefinitions:definitions});
  gallery=await seedGalleryDashboard(q,{actorId:actor.id,definitions});
  await q.query("update training_load.dashboard_pages set period_config=jsonb_set(period_config,'{dateFrom}','\"2026-11-04\"') where id=$1",[gallery.home.id]);
  await q.query("insert into training_load.dashboard_pages(dashboard_id,name,position) values($1,'Other page',1)",[gallery.dashboard.id]);
  for(const [role,type,scope]of [['club_admin','club',world.ids.clubA],['team_coach','team',world.ids.teamA]]){
   const owner=world.accounts.find(a=>a.role===role);byRole.set(role,await seedGalleryDashboard(q,{actorId:actor.id,ownerId:owner.id,workspaceType:type,scopeId:scope,definitions,title:'Gallery '+role}));
  }
 }finally{await q.end()}
 browser=await launch();
});
after(async()=>{await browser?.close();await world?.stop()});
test('1280px: seven real charts, distinct names, controls, local zoom and remembered disclosure state',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);try{
  await openDashboard(page,gallery.dashboard.id);await page.waitForFunction(()=>document.querySelectorAll('.tl-analysis-grid optimove-dashboard-chart svg').length===7);
  if(process.env.DASHBOARD_GALLERY_EVIDENCE){await mkdir(process.env.DASHBOARD_GALLERY_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.DASHBOARD_GALLERY_EVIDENCE,'gallery-1280.png'),fullPage:true});}
  const first=page.locator(`[data-analysis-widget-id="${gallery.widgets[0]}"]`),host=first.locator('optimove-dashboard-chart');
  const names=await host.evaluate(el=>el.chart.getOption().series.map(s=>s.name));assert.equal(new Set(names).size,3);assert.ok(names.every(n=>!/[0-9a-f]{8}-/.test(n)));
  await host.evaluate(el=>el.chart.dispatchAction({type:'legendToggleSelect',name:el.chart.getOption().series[0].name}));await host.getByRole('button',{name:'Show all series'}).click();assert.equal(await host.evaluate(el=>Object.values(el.chart.getOption().legend[0].selected).every(Boolean)),true);
  await first.locator('.tl-analysis-chart-values summary').click();await host.locator('.tl-chart-controls summary').click();
  await page.locator('.tl-dashboard-pages nav button').filter({hasText:'Other page'}).click();await page.locator('.tl-dashboard-pages nav [aria-current="page"]').filter({hasText:'Other page'}).waitFor();
  await page.locator('.tl-dashboard-pages nav button').filter({hasText:'Home'}).click();await host.locator('svg').waitFor();assert.equal(await first.locator('.tl-analysis-chart-values').getAttribute('open'),null);assert.equal(await host.locator('.tl-chart-controls').getAttribute('open'),null);
  await host.locator('.tl-chart-controls summary').click();await host.evaluate(el=>el.chart.dispatchAction({type:'dataZoom',start:0,end:0}));await host.getByRole('button',{name:'Apply selected period'}).click();
  await page.waitForFunction(()=>document.querySelector('[data-action="training-load-analysis-period-from"]').value==='2026-11-05');
  assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});
for(const width of [360,375,390])test(width+'px: visual gallery editor saves a multi-series shape without clipping',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',width);try{
  await openDashboard(page,gallery.dashboard.id);await page.getByRole('button',{name:'Widget actions: combined',exact:true}).click();await action(page,'analysis-edit-widget').click();
  await action(page,'simple-advanced').click();const dialog=page.getByRole('dialog',{name:'Widget settings'});await dialog.waitFor();assert.equal(await dialog.locator('.tl-gallery-pick').count(),8);
  await dialog.locator(`[data-action="training-load-analysis-gallery-kind"][value="${width===360?'scatter':'combined'}"]`).check();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await dialog.locator('select,input:not([type=checkbox]):not([type=radio])').evaluateAll(nodes=>nodes.every(n=>parseFloat(getComputedStyle(n).fontSize)>=16)),true);
  if(process.env.DASHBOARD_GALLERY_EVIDENCE){await mkdir(process.env.DASHBOARD_GALLERY_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.DASHBOARD_GALLERY_EVIDENCE,`gallery-editor-${width}.png`),fullPage:false});}
  await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const selected=page.locator(`[data-analysis-widget-id="${gallery.widgets[2]}"] optimove-dashboard-chart`);await selected.locator('svg').waitFor();assert.equal(await selected.evaluate(el=>JSON.parse(el.getAttribute('data-chart')).option.series[0].type),width===360?'scatter':'bar');assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});
test('PDF copies seven graphs in visible order and only expanded tables, with no controls or identifiers',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);try{
  await context.addInitScript(()=>{window.print=()=>{}});await openDashboard(page,gallery.dashboard.id);await page.waitForFunction(()=>document.querySelectorAll('.tl-analysis-grid optimove-dashboard-chart svg').length===7);
  const first=page.locator(`[data-analysis-widget-id="${gallery.widgets[0]}"]`);await first.locator('.tl-analysis-chart-values summary').click();
  const tables=await page.locator('.tl-analysis-chart-values[open] table').count(),popupPromise=page.waitForEvent('popup');await action(page,'analysis-print').click();const report=await popupPromise;
  await report.locator('.report-widget').last().waitFor();assert.equal(await report.locator('.report-widget svg').count(),7);assert.equal(await report.locator('.report-values table').count(),tables);
  assert.deepEqual(await report.locator('.report-widget h2').allTextContents(),['area','horizontal_bar','combined','heatmap','scatter','stacked','boxplot']);
  assert.equal(await report.locator('button,input,select,details').count(),0);assert.ok(await report.locator('.report-legend li').count()>0);assert.doesNotMatch(await report.locator('svg').allTextContents().then(v=>v.join(' ')),/1\/3|1\/6/);assert.doesNotMatch(await report.locator('body').innerHTML(),/data-chart|previewToken|fingerprint|[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  if(process.env.DASHBOARD_GALLERY_EVIDENCE){await mkdir(process.env.DASHBOARD_GALLERY_EVIDENCE,{recursive:true});await writeFile(path.join(process.env.DASHBOARD_GALLERY_EVIDENCE,'gallery-report.html'),await report.content());await report.pdf({path:path.join(process.env.DASHBOARD_GALLERY_EVIDENCE,'gallery.pdf'),printBackground:true,preferCSSPageSize:true});await report.screenshot({path:path.join(process.env.DASHBOARD_GALLERY_EVIDENCE,'gallery-report.png'),fullPage:true});}
  await report.close();assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});
for(const role of ['club_admin','team_coach'])test(role+': saved gallery is read-safe and adds no pilot controls or technical DOM',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,role,390);try{
  await openDashboard(page,byRole.get(role).dashboard.id);await page.waitForFunction(()=>document.querySelectorAll('.tl-analysis-grid optimove-dashboard-chart svg').length===7);
  const charts=await page.locator('optimove-dashboard-chart').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-chart')).join('\n'));assert.doesNotMatch(charts,/[0-9a-f]{8}-[0-9a-f-]{27,}|Source provenance|rawCount|previewToken|fingerprint/i);
  assert.equal(await page.locator('.tl-simple-technical').count(),0);assert.doesNotMatch(await page.locator('.tl-analysis-grid').textContent(),/[0-9a-f]{8}-[0-9a-f-]{27,}|Source provenance/i);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});

test('an existing gallery can become a table without a hidden gallery setting blocking save',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);try{
  await openDashboard(page,gallery.dashboard.id);await page.getByRole('button',{name:'Widget actions: combined',exact:true}).click();await action(page,'analysis-edit-widget').click();await action(page,'simple-advanced').click();
  const dialog=page.getByRole('dialog',{name:'Widget settings'});await dialog.waitFor();await action(page,'analysis-widget-type').selectOption('table');await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.locator('[data-analysis-widget-id="'+gallery.widgets[2]+'"] table').waitFor();assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});
