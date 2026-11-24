import {test} from 'node:test';import assert from 'node:assert/strict';
import {compileSimpleDraft} from '../src/dashboardSimple/compiler.js';
import {draft,snapshot,context} from './fixtures/dashboard-simple/contracts.mjs';
test('Simple compiles each single-metric gallery form to its actual stable series identity',()=>{
 for(const [kind,type]of [['area','line_chart'],['horizontal_bar','bar_chart'],['heatmap','bar_chart'],['boxplot','bar_chart']]){
  const d=draft(),s=snapshot();s.capabilities.chartShapes=true;d.view={...d.view,type,chartKind:kind,analyticalAggregation:['heatmap','boxplot'].includes(kind)?'none':'sum'};
  const result=compileSimpleDraft(d,s,context());assert.equal(result.status,'valid',JSON.stringify(result));assert.deepEqual(result.widget.presentation_config.chartShape.seriesIds,[result.widget.series[0].id]);assert.equal(result.widget.presentation_config.chartShape.kind,kind);
 }
});
test('a stale capability cannot compile a new shape before v94, and pooled distributions ask for separate values',()=>{
 const d=draft(),s=snapshot();d.view.chartKind='area';assert.equal(compileSimpleDraft(d,s,context()).status,'invalid');s.capabilities.chartShapes=true;d.view.chartKind='heatmap';assert.ok(compileSimpleDraft(d,s,context()).issues.some(i=>i.code==='galleryMeasurementsRequired'));
});
