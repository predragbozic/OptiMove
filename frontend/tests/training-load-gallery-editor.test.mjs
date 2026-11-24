import {test} from 'node:test';import assert from 'node:assert/strict';
import {galleryDraftSettings,galleryEditorProblem,gallerySettingsChanged,galleryEditorPresentation} from '../training-load-gallery-editor.js';
const draft=()=>({widgetType:'bar_chart',groupBy:'day',galleryKind:'combined',galleryMarks:{a:'bar',b:'line'},series:[{key:'a',id:'a',fields:{axis:'primary',analyticalAggregation:'sum'}},{key:'b',id:'b',fields:{axis:'secondary',analyticalAggregation:'sum'}}]});
test('gallery selection becomes explicit series ids and mark/axis bindings without changing the draft',()=>{
 const d=draft(),before=structuredClone(d),w={presentation_config:{schemaVersion:1,chartInteractions:{legend:{toggle:false}}}},p=galleryEditorPresentation(w,d);
 assert.deepEqual(p.chartShape.bindings,[{seriesId:'a',mark:'bar',axis:0},{seriesId:'b',mark:'line',axis:1}]);assert.equal(p.chartInteractions.legend.toggle,false);assert.deepEqual(d,before);
 assert.equal(gallerySettingsChanged({presentation_config:p},d),false);d.galleryMarks.b='bar';assert.match(galleryEditorProblem(d),/bars and a line/);
});
test('scatter, stack and distribution give specific choices rather than generic or raw errors',()=>{
 const d=draft();d.galleryKind='scatter';d.galleryKeys=['a'];assert.match(galleryEditorProblem(d),/X and Y/);
 d.galleryKeys=null;d.galleryKind='stacked';assert.match(galleryEditorProblem(d),/Confirm/);d.galleryAdditive=true;d.series[0].fields.analyticalAggregation='ratio';assert.match(galleryEditorProblem(d),/Ratios/);
 d.galleryKind='heatmap';d.galleryKeys=['a'];assert.match(galleryEditorProblem(d),/Each measurement/);
});
test('Standard removes only the gallery shape and keeps other presentation settings',()=>{
 const d=draft();d.galleryKind='standard';const p=galleryEditorPresentation({presentation_config:{schemaVersion:1,chartShape:{kind:'combined'},chartInteractions:{legend:{toggle:true}}}},d);assert.equal(p.chartShape,undefined);assert.ok(p.chartInteractions);
});

test('an explicit X/Y order survives reopening even when it differs from series_order',()=>{
 const d=draft();d.galleryKind='scatter';d.galleryKeys=['b','a'];
 const widget={presentation_config:{schemaVersion:1,chartShape:{schemaVersion:1,kind:'scatter',seriesIds:['b','a']}}};
 assert.equal(gallerySettingsChanged(widget,d),false);assert.deepEqual(galleryEditorPresentation(widget,d).chartShape.seriesIds,['b','a']);
});

test('opaque future presentation is never interpreted as a gallery on opening or title edits',()=>{
 const widget={presentation_config:{schemaVersion:2,chartShape:{schemaVersion:1,kind:'scatter',seriesIds:['b','a']},futureSetting:'preserve'}};
 const d={...draft(),...galleryDraftSettings(widget)};
 assert.deepEqual(galleryDraftSettings(widget),{galleryKind:'standard',galleryKeys:null,galleryMarks:{},galleryAdditive:false});
 assert.equal(gallerySettingsChanged(widget,d),false);assert.equal(galleryEditorProblem(d),'');
});

test('changing a gallery to table or KPI drops incompatible chart settings',()=>{
 for(const widgetType of ['table','kpi']){
  const d={...draft(),widgetType,galleryKind:'standard'},widget={presentation_config:{schemaVersion:1,chartShape:{schemaVersion:1,kind:'combined'},chartInteractions:{zoom:{mode:'local'}},chartComposition:'athletes-v1'}};
  assert.equal(gallerySettingsChanged(widget,d),true);assert.deepEqual(galleryEditorPresentation(widget,d),{schemaVersion:1});assert.equal(galleryEditorProblem(d),'');
 }
});
