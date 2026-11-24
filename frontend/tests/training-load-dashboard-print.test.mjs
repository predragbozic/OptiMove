import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {buildDashboardReport,orderedReportWidgets,printDashboardPage} from '../training-load-dashboard-print.js';
function fixture(){const source=new JSDOM(`<main><article class="tl-analysis-widget" data-analysis-widget-id="internal-2" style="--tl-y:4;--tl-x:0"><h3>Second</h3><figure class="tl-analysis-plot"><figcaption>Area</figcaption><optimove-dashboard-chart><svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><defs><clipPath id="zr0-c0"><rect width="2" height="2"/></clipPath></defs><path d="M0 0" clip-path="url(#zr0-c0)"/></svg></optimove-dashboard-chart></figure><details><summary>Values</summary><table><tr><td>Do not print collapsed values</td></tr></table></details></article><article class="tl-analysis-widget" data-analysis-widget-id="internal-1" style="--tl-y:0;--tl-x:0"><h3>First</h3><button>Settings</button><details open><summary>Values</summary><table><thead><tr><th>Duration (min)</th></tr></thead><tbody><tr><td>0</td></tr></tbody></table></details><pre>secret token</pre></article></main>`).window.document;return source;}
test('PDF follows visual layout order and includes expanded tables only, outside their chart section',()=>{
 const source=fixture(),target=new JSDOM().window.document;buildDashboardReport(source.querySelector('main'),target,{title:'Dashboard',subtitle:'Home'});
 assert.deepEqual([...target.querySelectorAll('.report-widget h2')].map(n=>n.textContent),['Second']);assert.equal(target.querySelectorAll('table').length,1);assert.equal(target.body.children[2].className,'report-values');
 assert.equal(target.querySelector('.report-widget table'),null);assert.match(target.querySelector('.report-values').textContent,/Duration \(min\).*0/s);
 assert.doesNotMatch(target.body.innerHTML,/internal-|data-|secret token|Settings|Do not print collapsed/);
 assert.ok(target.querySelector('#zr0-c0'));assert.equal(source.querySelectorAll('table').length,2);
});
test('report title is text, SVG is scalable, repeated table headers and long-table page flow are declared',()=>{
 const target=new JSDOM().window.document;buildDashboardReport(fixture(),target,{title:'<img src=x onerror=bad>'});
 assert.equal(target.querySelector('img'),null);assert.equal(target.querySelector('svg').getAttribute('viewBox'),'0 0 600 300');
 assert.match(target.querySelector('style').textContent,/report-values\{break-before:page;break-after:page/);assert.match(target.querySelector('style').textContent,/thead\{display:table-header-group/);assert.match(target.querySelector('style').textContent,/report-values\.is-long\{break-inside:auto/);
});
test('PDF refuses incomplete charts and a blocked or empty report with one next step',async()=>{
 const source=fixture();source.querySelector('svg').remove();assert.throws(()=>buildDashboardReport(source,new JSDOM().window.document),/Charts are still loading/);
 await assert.rejects(printDashboardPage(null),/Add a widget first/);
 await assert.rejects(printDashboardPage(fixture(),{}, {open:()=>null}),/Allow pop-ups/);
});
test('visual browser rectangles take precedence over DOM and saved layout',()=>{
 const source=fixture();source.querySelectorAll('article')[0].getBoundingClientRect=()=>({top:0,left:0});source.querySelectorAll('article')[1].getBoundingClientRect=()=>({top:100,left:0});assert.equal(orderedReportWidgets(source)[0].querySelector('h3').textContent,'Second');
});

test('PDF replaces interactive legends with full static names and preserves SVG clip references',()=>{
 const source=fixture(),chart=source.querySelector('optimove-dashboard-chart');chart.printLegend=()=>[{name:'A complete athlete name',color:'#00aa66'}];const target=new JSDOM().window.document;buildDashboardReport(source,target);
 assert.equal(target.querySelector('.report-legend li').textContent,'A complete athlete name');assert.equal(target.querySelector('.report-legend span').style.backgroundColor,'rgb(0, 170, 102)');assert.ok(target.querySelector('#zr0-c0'));assert.match(target.querySelector('path').getAttribute('clip-path'),/zr0-c0/);
});

test('a table-only widget has one values heading and no orphan chart sheet',()=>{
 const source=fixture();source.querySelectorAll('article')[0].remove();const target=new JSDOM().window.document;buildDashboardReport(source,target);
 assert.equal(target.querySelector('.report-widget'),null);assert.equal(target.querySelectorAll('h2').length,1);assert.equal(target.querySelector('h2').textContent,'First — values');
});

for(const path of ['printSvg','outerHTML'])test('PDF scrubs active SVG before insertion via '+path,()=>{
 const source=fixture(),chart=source.querySelector('optimove-dashboard-chart'),svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" onload="window.bad=true"><script>window.bad=true</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject><image href="https://svg-test.invalid/leak"/><use href="javascript:bad()"/><a href="https://svg-test.invalid/leak"><text>unsafe link</text></a><defs><clipPath id="zr0-c0"><rect width="2" height="2"/></clipPath></defs><path d="M0 0" clip-path="url(#zr0-c0)" onmouseover="bad()" fill="url(https://svg-test.invalid/leak)"/><text style="font-size:12px;position:fixed;fill:url(https://svg-test.invalid/leak)">Safe label</text></svg>';
 if(path==='printSvg')chart.printSvg=()=>svg;else chart.innerHTML=svg;
 const target=new JSDOM().window.document;buildDashboardReport(source,target);
 assert.equal(target.querySelector('script,foreignObject,image,use,a'),null);assert.equal(target.querySelector('[onload],[onmouseover],[href]'),null);assert.doesNotMatch(target.body.innerHTML,/svg-test|javascript:|position:|window.bad/);assert.ok(target.querySelector('#zr0-c0'));assert.equal(target.querySelector('path').getAttribute('clip-path'),'url(#zr0-c0)');assert.equal(target.querySelector('text').style.fontSize,'12px');
});
test('PDF rejects malformed or entity-bearing SVG without inserting it',()=>{
 for(const svg of ['<svg><broken>','<!DOCTYPE svg [<!ENTITY x SYSTEM "https://svg-test.invalid">]><svg xmlns="http://www.w3.org/2000/svg"/>']){
  const source=fixture();source.querySelector('optimove-dashboard-chart').printSvg=()=>svg;const target=new JSDOM().window.document;assert.throws(()=>buildDashboardReport(source,target),/Try PDF again/);assert.equal(target.querySelector('svg'),null);
 }
});
