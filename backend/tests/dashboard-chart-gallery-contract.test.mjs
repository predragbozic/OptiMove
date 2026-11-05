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
