import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateContract} from '../src/dashboardSimple/schema.js';
import {compileSimpleDraft} from '../src/dashboardSimple/compiler.js';
import {draft,snapshot,context,id} from './fixtures/dashboard-simple/contracts.mjs';
const presentation=()=>({schemaVersion:1,chartVariant:'boxplot',chartComposition:'distribution-v1',chartInteractions:{yAxis:{mode:'auto'}}});
const boxDraft=()=>({...draft(),view:{...draft().view,type:'bar_chart'},presentation:{mode:'replace',value:presentation()}});
const pageSnapshot=()=>{const s=snapshot();s.capabilities.pageDefaultsSave=true;return s;};

test('boxplot requires strict paired distribution composition and auto y axis',()=>{
 const p=presentation();assert.equal(validateContract('presentationV1',p).valid,true);
 for(const invalid of [{...p,chartComposition:'athletes-v1'},{...p,chartVariant:'heatmap'},{...p,chartVariant:undefined},{...p,chartComposition:undefined},{...p,chartInteractions:undefined},{...p,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}},{...p,stackDefinition:{}}])assert.equal(validateContract('presentationV1',invalid).valid,false,JSON.stringify(invalid));
 assert.equal(validateContract('presentationV1',{...p,chartInteractions:{}}).valid,true);
});

test('Simple boxplot compiles one numeric primary series for day/week across returned athletes',()=>{
 for(const groupBy of ['day','week']){
  const d=boxDraft();d.view.groupBy=groupBy;const c=context();c.authorizedAthleteIds=Array.from({length:20},(_,i)=>id(i+100));
  const result=compileSimpleDraft(d,pageSnapshot(),c);assert.equal(result.status,'valid',JSON.stringify(result));
  assert.equal(result.widget.series.length,1);assert.equal(result.widget.series[0].axis,'primary');assert.equal(result.widget.series[0].comparison_period,null);assert.deepEqual(result.widget.presentation_config,presentation());
  assert.equal(result.widget.series[0].analytical_aggregation,'sum');assert.equal(result.effectiveFilter.athleteIds.length,20);
 }
 const over=context();over.authorizedAthleteIds=Array.from({length:21},(_,i)=>id(i+100));
 assert.ok(compileSimpleDraft(boxDraft(),pageSnapshot(),over).issues.some(i=>i.reason==='maxChartAthletes'));
 assert.equal(compileSimpleDraft(boxDraft(),snapshot(),context()).status,'invalid');
 for(const [type,groupBy]of [['line_chart','day'],['bar_chart','athlete'],['bar_chart','session']]){
  const d=boxDraft();Object.assign(d.view,{type,groupBy});assert.ok(compileSimpleDraft(d,pageSnapshot(),context()).issues.some(i=>i.code==='incompatiblePresentation'));
 }
 const s=pageSnapshot();s.metric.value_type='text';const d=boxDraft();d.view.analyticalAggregation='last';assert.ok(compileSimpleDraft(d,s,context()).issues.some(i=>i.code==='numericChartRequired'));
});

test('Simple update and preserve reject comparisons, secondary axes and multiple series',()=>{
 const widget=compileSimpleDraft(boxDraft(),pageSnapshot(),context()).widget;
 for(const mode of ['replace','preserve'])for(const mutation of [w=>w.series[0].comparison_period='previous_period',w=>w.series[0].axis='secondary',w=>w.series.push({...w.series[0],id:id(99)})]){
  const existing=structuredClone(widget);mutation(existing);const d=boxDraft();d.display={mode:'preserve'};d.presentation=mode==='preserve'?{mode:'preserve'}:d.presentation;
  assert.notEqual(compileSimpleDraft(d,pageSnapshot(),context(),existing).status,'valid');
 }
 const d=boxDraft();d.display={mode:'preserve'};d.presentation={mode:'preserve'};
 assert.equal(compileSimpleDraft(d,pageSnapshot(),context(),widget).status,'valid');
 const opaque=structuredClone(widget);opaque.presentation_config={schemaVersion:99,anything:{future:true}};
 assert.equal(compileSimpleDraft(d,pageSnapshot(),context(),opaque).status,'valid');
});
