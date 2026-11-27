import {test} from 'node:test';
import assert from 'node:assert/strict';
import {state,emptyTrainingLoadState} from '../state.js';
import {renderTrainingLoadAnalysisHtml} from '../training-load-analysis-view.js';
import {renderDashboardPages} from '../training-load-pages-view.js';
function model(extra={}){state.trainingLoad.analysis={pagesAvailable:true,pages:[{id:'home',name:'Home',is_home:true,position:0}],selectedPageId:'home',page:{id:'home',name:'Home',is_home:true,position:0},pageCanManage:true,...extra};}
test('Page UI is absent until the server offers it',()=>{model({pagesAvailable:false});assert.equal(renderDashboardPages(),'')});
test('Pages shell hands navigation to the React island',()=>{model();assert.doesNotMatch(renderDashboardPages(),/Home · Home/);model({pages:[{id:'home',name:'Overview',is_home:true}]});assert.match(renderDashboardPages(),/data-dashboard-controls="pages"/)});
test('Pages shell contains no inline mutation controls',()=>{model({pageCanManage:false});const html=renderDashboardPages();assert.match(html,/Dashboard pages/);assert.doesNotMatch(html,/pages-create|pages-rename|pages-defaults|pages-delete/)});
test('shared-period edit explains its scope and retains the selected choice',()=>{model({pageForm:{operation:'defaults',preset:'today'}});const html=renderDashboardPages();assert.match(html,/shared by everyone/);assert.match(html,/value="today" selected/);assert.match(html,/Keep current period/);assert.doesNotMatch(html,/Page name<input/)});
test('unknown writes block edits and offer Check update with a plain sentence',()=>{model({pagePending:{},pageError:'The update is not confirmed. Check it before making another change.'});const html=renderDashboardPages();assert.match(html,/Check update/);assert.match(html,/data-dashboard-controls="pages"/);assert.doesNotMatch(html,/requestId|payload_hash|fingerprint/)});

test('the copy form has the Copy widget accessible label',()=>{model({pageForm:{operation:'copy',name:'Sessions',destinationPageId:'home'}});assert.match(renderDashboardPages(),/role="group" aria-label="Copy widget"/)});

test('widget creation stays disabled until Page reload/save/recovery is complete',()=>{
 for(const field of ['pageLoading','pageSaving','pagePending']){state.trainingLoad=emptyTrainingLoadState();const a=state.trainingLoad.analysis;a.dashboard={id:'dashboard',name:'Dashboard',status:'active',is_template:false};a.pagesAvailable=true;a.dashboardCanManage=true;a.pageCanManage=true;a[field]=true;const buttons=renderTrainingLoadAnalysisHtml().match(/<button[^>]*data-action="training-load-analysis-add-widget"[^>]*>/g);assert.ok(buttons?.length);assert.ok(buttons.every(button=>button.includes('disabled')),field);a[field]=false;const ready=renderTrainingLoadAnalysisHtml().match(/<button[^>]*data-action="training-load-analysis-add-widget"[^>]*>/g);assert.ok(ready.every(button=>!button.includes('disabled')))}
});
