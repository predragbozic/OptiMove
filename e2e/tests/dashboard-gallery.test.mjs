import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import pg from 'pg';
import {launch,openAs,openTrainingLoad} from '../lib/browser.mjs';import {startWorld} from '../lib/world.mjs';
import {seedGalleryMeasurements,seedGalleryDashboard} from '../../backend/tests/support/dashboard-gallery-seed.mjs';
let world,browser,gallery;const byRole=new Map();
const action=(page,name)=>page.locator(`[data-action="training-load-${name}"]`);
async function openDashboard(page,id){await openTrainingLoad(page);await page.getByRole('tab',{name:'Data & Analysis'}).click();const tab=page.getByRole('tab',{name:'Dashboards'});if(await tab.isVisible())await tab.click();await page.locator('.tl-dash-picker-trigger').click();await page.locator('[data-dashboard-id="'+id+'"]').first().click();await page.locator('optimove-dashboard-chart svg').first().waitFor();}
// Follow the same visible controls as a coach: Dashboard actions -> PDF.
// Register the popup wait only after the menu is open; never click a hidden item.
async function exportFromDashboardMenu(page){
 await page.getByRole('button',{name:'Dashboard actions',exact:true}).click();
 const item=page.getByRole('menuitem',{name:'Export page as PDF',exact:true});
 await item.waitFor({state:'visible'});assert.equal(await item.isEnabled(),true);
 const [report]=await Promise.all([page.waitForEvent('popup'),item.click()]);
 return report;
}
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
  const bars=page.locator('[data-analysis-widget-id]').filter({has:page.getByRole('button',{name:'Widget actions: horizontal_bar',exact:true})}).locator('optimove-dashboard-chart');
  await bars.locator('.tl-analysis-echarts').scrollIntoViewIfNeeded();
  const point=await bars.evaluate(el=>{
    const series=el.chart.getOption().series.findIndex(item=>item.data.some(value=>typeof value==='number'&&value>0));
    const values=el.chart.getOption().series[series].data;
    const index=values.findIndex(value=>typeof value==='number'&&value>0);
    const coords=el.chart.convertToPixel({seriesIndex:series},[values[index]/2,index]);
    const rect=el.querySelector('.tl-analysis-echarts').getBoundingClientRect();
    return {x:rect.left+coords[0],y:rect.top+coords[1]};
  });
  await page.mouse.click(point.x,point.y);
  const date=await bars.getByRole('button',{name:'Filter dashboard to this day'}).getAttribute('data-date-from');
  const filtered=page.waitForRequest(request=>request.url().endsWith('/query')&&request.method()==='POST'&&request.postDataJSON().dateFrom===date&&request.postDataJSON().dateTo===date);
  await bars.getByRole('button',{name:'Filter dashboard to this day'}).click();
  await filtered;
  await page.getByRole('button',{name:'Clear chart day filter'}).click();
  await host.locator('svg').waitFor();
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
for (const width of [390, 1280]) test(`${width}px: Advanced table adds, reorders and previews measured variables`, async () => {
 const role = width === 390 ? 'club_admin' : 'platform_admin';
 const fixture = width === 390 ? byRole.get(role) : gallery;
 const {context, page, pageErrors} = await openAs(browser, world, role, width);
 try {
  await openDashboard(page, fixture.dashboard.id);
  const widget = page.locator(`[data-analysis-widget-id="${fixture.widgets[0]}"]`);
  await widget.getByRole('button',{name:'Widget actions: area',exact:true}).click();
  await action(page,'analysis-edit-widget').click();
  await action(page,'simple-advanced').click();
  const editor = page.getByRole('dialog',{name:'Widget settings'});
  await action(page,'analysis-widget-type').selectOption('table');
  await action(page,'analysis-widget-group').selectOption('athlete');
  await action(page,'analysis-series-aggregation').selectOption('min');
  await editor.getByRole('button',{name:/Add variable/}).click();
  await editor.getByRole('searchbox',{name:'Search metrics'}).fill('Distance part B');
  await editor.getByRole('button',{name:/Distance part B/}).click();
  await action(page,'analysis-series-aggregation').selectOption('max');
  await editor.getByRole('button',{name:'Move up: Distance part B',exact:true}).click();
  const [response] = await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/query') && r.request().postDataJSON()?.advancedPreview),
   editor.getByRole('button',{name:'Load preview',exact:true}).click(),
  ]);
  assert.equal(response.status(),200,await response.text());
  const preview = editor.getByRole('region',{name:'Widget preview',exact:true});
  const headers = preview.getByRole('columnheader');
  await headers.last().waitFor();
  const visibleHeaders = await headers.allTextContents();
  assert.match(visibleHeaders[1],/Distance part B/);
  assert.match(visibleHeaders[2],/Distance part A/);
  assert.ok(await preview.getByRole('row').count() > 1);
  assert.equal(await widget.locator('optimove-dashboard-chart').count(),1);
  assert.equal(await editor.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await editor.getByRole('button',{name:'Save changes',exact:true}).click();
  await editor.waitFor({state:'hidden'});
  await widget.getByRole('table').waitFor();
  assert.deepEqual(await widget.getByRole('columnheader').allTextContents(),visibleHeaders);
  assert.deepEqual(pageErrors,[]);
 } finally { await context.close(); }
});

for(const width of [390,1280])test(width+'px: PDF copies seven graphs in visible order and only expanded tables, with no controls or identifiers',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',width);try{
  await context.addInitScript(()=>{window.print=()=>{}});await openDashboard(page,gallery.dashboard.id);await page.waitForFunction(()=>document.querySelectorAll('.tl-analysis-grid optimove-dashboard-chart svg').length===7);
  const first=page.locator(`[data-analysis-widget-id="${gallery.widgets[0]}"]`);await first.locator('.tl-analysis-chart-values summary').click();
  const tables=await page.locator('.tl-analysis-chart-values[open] table').count();const report=await exportFromDashboardMenu(page);
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

for (const width of [1280,390]) test(`${width}px: Edit metric shows every illustrated display and loads preview`,async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'club_admin',width);
 try{
  await openDashboard(page,byRole.get('club_admin').dashboard.id);
  await page.getByRole('button',{name:'Widget actions: horizontal_bar',exact:true}).click();
  await action(page,'analysis-edit-widget').click();
  const editor=page.getByRole('dialog',{name:'Edit metric'});
  await editor.waitFor();
  assert.equal(await editor.locator('.tl-metric-panel-types button svg').count(),12);
  assert.equal(await editor.getByRole('button',{name:/^Radar/}).isVisible(),true);
  assert.equal(await editor.getByRole('button',{name:'Advanced settings',exact:true}).isVisible(),true);
  assert.equal(await editor.locator('.tl-metric-panel-body').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),width===1280?2:1);
  const [preview]=await Promise.all([
   page.waitForResponse(response=>response.url().endsWith('/query')&&response.request().postDataJSON()?.metricPreview),
   editor.getByRole('button',{name:'Load preview',exact:true}).click(),
  ]);
  assert.equal(preview.status(),200,await preview.text());
  assert.ok((await preview.json()).result.series[0].data.current.some(row=>typeof row.value==='number'));
  await editor.locator('[aria-label="Widget preview"][aria-busy="false"]').waitFor();
  assert.equal(await editor.locator('[aria-label="Widget preview"] [role="alert"]').count(),0);
  assert.equal(await editor.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});

test('an existing gallery can become a table without a hidden gallery setting blocking save',async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'platform_admin',1280);try{
  await openDashboard(page,gallery.dashboard.id);await page.getByRole('button',{name:'Widget actions: combined',exact:true}).click();await action(page,'analysis-edit-widget').click();await action(page,'simple-advanced').click();
  const dialog=page.getByRole('dialog',{name:'Widget settings'});await dialog.waitFor();await action(page,'analysis-widget-type').selectOption('table');await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.locator('[data-analysis-widget-id="'+gallery.widgets[2]+'"] table').waitFor();assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});

for(const width of [1280,390,360]) test(`${width}px: add Area from View and preview before atomic save`,async()=>{
 const {context,page,pageErrors}=await openAs(browser,world,'club_admin',width);
 try{
  await openDashboard(page,byRole.get('club_admin').dashboard.id);
  await page.getByRole('button',{name:'Add widget',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'Add metric'});
  assert.equal(await editor.locator('.tl-metric-panel-types button:enabled svg').count(),12);
  for(const field of ['groupBy','aggregation','scope']){
   const select=editor.locator(`select[data-action="training-load-analysis-panel-field"][data-field="${field}"]`);
   if(await select.isEnabled()){
    await select.scrollIntoViewIfNeeded();
    const original=await select.elementHandle();
    const body=editor.locator('.tl-metric-panel-body');
    const scrollBefore=await body.evaluate(el=>el.scrollTop);
    await select.dispatchEvent('click');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await original.evaluate(el=>el.isConnected),true,field);
    assert.equal(await body.evaluate(el=>el.scrollTop),scrollBefore,field);
    await original.dispose();
   }
  }
  if(width<720){
   const layout=await editor.locator('.tl-metric-panel-types').evaluate(grid=>{
    const buttons=[...grid.querySelectorAll('button')];
    const bounds=buttons.map(button=>button.getBoundingClientRect());
    return {
     columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
     rows:new Set(bounds.map(rect=>rect.top)).size,
     height:grid.getBoundingClientRect().height,
     fits:grid.scrollWidth<=grid.clientWidth+1&&buttons.every(button=>button.scrollWidth<=button.clientWidth+1),
     touchTargets:bounds.every(rect=>rect.width>=44&&rect.height>=44),
    };
   });
   assert.equal(layout.columns,3);
   assert.equal(layout.rows,4);
   assert.ok(layout.height<=240,JSON.stringify(layout));
   assert.ok(layout.fits&&layout.touchTargets,JSON.stringify(layout));
  }
  await editor.getByRole('button',{name:'Area',exact:true}).click();
  const metric=editor.getByLabel('Measurement 1');
  await metric.selectOption({label:'Distance part A'});
  await editor.getByLabel('Title').fill(`Area preview ${width}`);
  await editor.getByLabel('Title').press('Tab');
  const [preview]=await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/query')&&r.request().postDataJSON()?.galleryDraft),
   editor.getByRole('button',{name:'Load preview',exact:true}).click(),
  ]);
  assert.equal(preview.status(),200,await preview.text());
  assert.ok((await preview.json()).result.series[0].data.current.some(row=>typeof row.value==='number'));
  await editor.locator('[aria-label="Widget preview"] optimove-dashboard-chart svg').waitFor();
  assert.equal(await page.locator('.tl-analysis-grid').getByRole('heading',{name:`Area preview ${width}`}).count(),0);
  const [saved]=await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/gallery')&&r.request().method()==='POST'),
   editor.getByRole('button',{name:'Save metric',exact:true}).click(),
  ]);
  assert.equal(saved.status(),200,await saved.text());
  await page.locator('.tl-analysis-grid').getByRole('heading',{name:`Area preview ${width}`}).waitFor();
  assert.deepEqual(pageErrors,[]);
 }finally{await context.close()}
});

test('PDF never executes or fetches active content from a live SVG snapshot',async()=>{
 const {context,page}=await openAs(browser,world,'platform_admin',1280),unsafeRequests=[];
 context.on('request',request=>{if(request.url().includes('svg-test.invalid'))unsafeRequests.push(request.url())});
 try{
  await context.addInitScript(()=>{window.print=()=>{}});await openDashboard(page,gallery.dashboard.id);
  await page.locator('optimove-dashboard-chart').first().evaluate(host=>{host.printSvg=()=>'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" onload="window.__svgExecuted=true"><script>window.__svgExecuted=true</script><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="https://svg-test.invalid/leak" onerror="window.__svgExecuted=true"/></body></foreignObject><image href="https://svg-test.invalid/leak"/><rect width="20" height="20" fill="green"/></svg>'});
  const report=await exportFromDashboardMenu(page);await report.locator('.report-widget svg').first().waitFor();
  assert.equal(await report.locator('script,foreignObject,image,[onload],[onerror]').count(),0);assert.equal(await report.evaluate(()=>window.__svgExecuted),undefined);assert.deepEqual(unsafeRequests,[]);await report.close();
 }finally{await context.close()}
});
