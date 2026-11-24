import {test} from 'node:test';import assert from 'node:assert/strict';
import {validGalleryShape} from '../src/dashboardGallery/contract.js';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const shape=(kind,seriesIds=[a],more={})=>({schemaVersion:1,kind,seriesIds,...more});
test('all seven gallery contracts have bounded explicit series bindings',()=>{
 for(const kind of ['area','horizontal_bar','heatmap','boxplot'])assert.equal(validGalleryShape(shape(kind)),true);
 assert.equal(validGalleryShape(shape('scatter',[a,b])),true);
 assert.equal(validGalleryShape(shape('stacked',[a,b],{additive:true})),true);
 assert.equal(validGalleryShape(shape('combined',[a,b],{bindings:[{seriesId:a,mark:'bar',axis:0},{seriesId:b,mark:'line',axis:1}]})),true);
});
test('unknown keys, duplicate ids, unsupported versions and arbitrary chart definitions are refused',()=>{
 for(const value of [shape('area',[a,a.toUpperCase()]),shape('area',['unsafe']),shape('unknown'),{...shape('area'),schemaVersion:2},shape('area',[a],{anything:true}),shape('area',[a],{additive:true}),shape('scatter'),shape('heatmap',[a,b]),shape('stacked',[a,b]),shape('combined',[a,b]),null])assert.equal(validGalleryShape(value),false,JSON.stringify(value));
});
test('combined bindings cover each selected series once with both marks and at most two axes',()=>{
 const bindings=[{seriesId:a,mark:'bar',axis:0},{seriesId:b,mark:'line',axis:1}];
 for(const wrong of [[bindings[0],bindings[0]],[bindings[0],{...bindings[1],axis:2}],[bindings[0],{...bindings[1],mark:'bar'}],[bindings[0],{...bindings[1],script:'x'}]])assert.equal(validGalleryShape(shape('combined',[a,b],{bindings:wrong})),false);
});
