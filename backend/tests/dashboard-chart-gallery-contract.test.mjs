import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateContract} from '../src/dashboardSimple/schema.js';
import {compileSimpleDraft} from '../src/dashboardSimple/compiler.js';
import {draft,snapshot,context} from './fixtures/dashboard-simple/contracts.mjs';

for(const [variant,type]of [['area','line_chart'],['horizontal-bar','bar_chart']])test(`gallery ${variant} compiles only with its matching persisted widget type`,()=>{
 const d=draft();d.view.type=type;d.presentation={mode:'replace',value:{schemaVersion:1,chartVariant:variant,chartInteractions:{yAxis:{mode:'auto'}}}};
 assert.equal(validateContract('presentationV1',d.presentation.value).valid,true);
 const compiled=compileSimpleDraft(d,snapshot(),context());assert.equal(compiled.status,'valid',JSON.stringify(compiled));assert.equal(compiled.widget.presentation_config.chartVariant,variant);
 d.view.type=type==='line_chart'?'bar_chart':'line_chart';const rejected=compileSimpleDraft(d,snapshot(),context());assert.ok(rejected.issues.some(i=>i.code==='incompatiblePresentation'));
});
test('gallery sidecars reject unknown variants, callbacks, missing interactions and table mixtures',()=>{
 for(const value of [{schemaVersion:1,chartVariant:'scatter',chartInteractions:{}},{schemaVersion:1,chartVariant:'area'},{schemaVersion:1,chartVariant:'area',chartInteractions:{},callback:'x'},{schemaVersion:1,chartVariant:'area',chartInteractions:{},tableFormatting:{evaluationVersion:1,rules:[]}}])assert.equal(validateContract('presentationV1',value).valid,false);
});
test('combined is a valid Advanced presentation and explicitly requires the multi-series editor',()=>{
 const value={schemaVersion:1,chartVariant:'combined',chartComposition:'metrics-v1',chartInteractions:{yAxis:{mode:'auto'}}};
 assert.equal(validateContract('presentationV1',value).valid,true);
 const d=draft();d.view.type='line_chart';d.presentation={mode:'replace',value};
 assert.equal(compileSimpleDraft(d,snapshot(),context()).status,'advancedRequired');
 for(const invalid of [{...value,chartComposition:'athletes-v1'},{...value,chartVariant:'area'},{...value,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}}])assert.equal(validateContract('presentationV1',invalid).valid,false);
});
test('heatmap compiles one numeric series only for bar/day-week with paired matrix and auto axes',()=>{
 const value={schemaVersion:1,chartVariant:'heatmap',chartComposition:'matrix-v1',chartInteractions:{yAxis:{mode:'auto'}}};
 assert.equal(validateContract('presentationV1',value).valid,true);
 const enabled=()=>{const s=snapshot();s.capabilities.chartComposition.push('matrix-v1');return s;};
 const d=draft();d.view.type='bar_chart';d.presentation={mode:'replace',value};const scope=context();scope.authorizedAthleteIds=Array.from({length:21},(_,i)=>`00000000-0000-4000-8000-${String(i+100).padStart(12,'0')}`);
 const overLimit=compileSimpleDraft(d,enabled(),scope);assert.equal(overLimit.status,'requiresChoice');assert.ok(overLimit.issues.some(i=>i.reason==='maxChartAthletes'));
 for(const groupBy of ['day','week']){const d=draft();d.view={...d.view,type:'bar_chart',groupBy};d.presentation={mode:'replace',value};const result=compileSimpleDraft(d,enabled(),context());assert.equal(result.status,'valid',JSON.stringify(result));}
 for(const [type,groupBy]of [['line_chart','day'],['bar_chart','athlete']]){const d=draft();d.view={...d.view,type,groupBy};d.presentation={mode:'replace',value};assert.ok(compileSimpleDraft(d,snapshot(),context()).issues.some(i=>i.code==='incompatiblePresentation'));}
 for(const invalid of [{...value,chartComposition:'athletes-v1'},{...value,chartVariant:'area'},{...value,chartInteractions:{yAxis:{mode:'fixed',min:0,max:10}}}])assert.equal(validateContract('presentationV1',invalid).valid,false);
});
