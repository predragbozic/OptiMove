import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReferenceDefinition as definition,validateReferenceObservation as observation,validateRadarConfiguration as radar} from '../src/dashboardReferences/contract.js';
import {calculateReferenceValue} from '../src/dashboardReferences/calculations.js';
const id=n=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding=()=>({metricDefinitionId:id(1),metricVersionId:id(2),unit:'m',dataScopeLevel:'session',analyticalAggregation:'sum',sourcePolicy:'manual',sourceConnectionId:null,aggregationRolePolicy:'standalone_only',coveragePolicy:'complete_only'});
const manual=()=>({schemaVersion:1,id:id(3),revision:1,name:'Match distance reference',owner:{kind:'team',id:id(4)},binding:binding(),population:{kind:'individual'},effective:{dateFrom:'2026-10-01',dateTo:null},source:{kind:'manual',value:5000}});
const rolling=()=>({...manual(),source:{kind:'rollingMatches',requestedMatches:5,minimumMatches:5,partialPolicy:'unavailable',selection:'athleteParticipatedMatches',matchTypes:'official',minimumParticipationMinutes:60,normalization:'none',weighting:'playerMatchEqual',cutoff:'strictlyBeforeMeasurement',excludeEvaluatedEvent:true}});
const obs=()=>({schemaVersion:1,queryId:id(5),referenceId:id(3),referenceRevision:1,evaluatedAt:'2026-11-06T10:00:00.000Z',measurementDate:'2026-10-06',measurementInstant:'2026-10-06T08:00:00.000Z',timeZone:'Europe/Belgrade',athleteId:id(6),bucketKey:'2026-10-06',binding:binding(),status:'ready',value:5000,reason:null,sample:null});
const config=()=>({schemaVersion:1,chartVariant:'radar',formulaVersion:'attainment-positive-v1',radialScale:{mode:'auto',minimum:0},axes:[1,2,3].map(n=>({metricDefinitionId:id(n),referenceId:id(n+10),referenceRevision:1})),athleteIds:[id(50)],missing:'unavailable'});
test('strict manual/table/rolling definitions preserve versioned bindings and input',()=>{
 const values=[manual(),{...manual(),population:{kind:'position',teamId:id(4),positionBasis:'measurementDate'},source:{kind:'referenceTable',tableId:id(8),tableRevision:2,dimensions:['position','ageBand','sex'],dimensionBasis:'measurementDate',ambiguity:'unavailable'}},rolling()];
 for(const v of values){const before=structuredClone(v);assert.equal(definition(v).valid,true,JSON.stringify(definition(v)));assert.deepEqual(v,before);}
 const zero=manual();zero.source.value=0;assert.equal(definition(zero).valid,true); // Legal for differences, not attainment.
});
test('binding enums match existing query policies; no implicit source or unit conversion',()=>{
 for(const policy of ['manual','api_import','csv_import','derived','all_with_conflicts','source_connection']){const v=manual();v.binding.sourcePolicy=policy;v.binding.sourceConnectionId=policy==='source_connection'?id(7):null;assert.equal(definition(v).valid,true);}
 for(const mutate of [v=>v.binding.metricVersionId=null,v=>v.binding.sourceConnectionId=id(7),v=>v.binding.unit=' m',v=>v.binding.unit='',v=>v.binding.analyticalAggregation='none',v=>v.binding.aggregationRolePolicy='prefer_components',v=>v.binding.coveragePolicy='allow_partial',v=>v.owner.kind='public',v=>v.revision=0,v=>v.effective.dateTo='2026-09-30',v=>v.source.value='5000',v=>v.extra='ignored']){const v=manual();mutate(v);assert.equal(definition(v).valid,false,JSON.stringify(v));}
});
test('table ambiguity/dimension history and rolling sample/cutoff/weighting policies cannot be guessed',()=>{
 for(const mutate of [v=>v.source.requestedMatches=0,v=>v.source.minimumMatches=2,v=>v.source.cutoff='now',v=>v.source.excludeEvaluatedEvent=false,v=>v.source.selection='last5rows',v=>v.source.normalization='per90',v=>v.source.minimumParticipationMinutes=-1,v=>v.source.weighting='athleteMeansEqual']){const v=rolling();mutate(v);assert.equal(definition(v).valid,false,JSON.stringify(v));}
 const v=rolling();v.source.minimumMatches=2;v.source.partialPolicy='allowPartial';assert.equal(definition(v).valid,true);
 const table={...manual(),source:{kind:'referenceTable',tableId:id(8),tableRevision:1,dimensions:['position'],dimensionBasis:'measurementDate',ambiguity:'unavailable'}};
 for(const mutate of [v=>v.source.dimensions.push('position'),v=>v.source.dimensionBasis='current',v=>v.source.ambiguity='firstRow',v=>v.source.tableRevision=0]){const copy=structuredClone(table);mutate(copy);assert.equal(definition(copy).valid,false);}
});
test('observations bind query/athlete/version/timezone and distinguish unavailable from zero',()=>{
 assert.equal(observation(obs()).valid,true);const unavailable={...obs(),status:'unavailable',value:null,reason:'insufficientSample',sample:{requestedMatches:5,usedMatches:2,partial:true,eventIds:[id(20),id(21)]}};assert.equal(observation(unavailable).valid,true);
 for(const mutate of [v=>v.value=null,v=>v.reason='missingReference',v=>v.measurementInstant='2026-02-30T00:00:00.000Z',v=>v.timeZone='fake',v=>v.athleteId=null,v=>v.sample={requestedMatches:5,usedMatches:2,partial:false,eventIds:[id(20),id(21)]},v=>v.sample={requestedMatches:5,usedMatches:2,partial:true,eventIds:[id(20),id(20).toUpperCase()]},v=>v.sample={requestedMatches:5,usedMatches:0,partial:true,eventIds:[]}]){const v=obs();mutate(v);assert.equal(observation(v).valid,false,JSON.stringify(v));}
 assert.equal(observation({...obs(),value:0}).valid,true);
 const midnight={...obs(),measurementInstant:'2026-10-06T23:30:00.000Z',measurementDate:'2026-10-07'};assert.equal(observation(midnight).valid,true);assert.equal(observation({...midnight,measurementDate:'2026-10-06'}).valid,false);
});
test('Radar uses 100 percent attainment, unique metric axes and bounded athlete comparisons; no missing-to-zero or 100 cap',()=>{
 assert.equal(radar(config()).valid,true);
 for(const mutate of [v=>v.formulaVersion='signed-relative-abs-v1',v=>v.axes[1].metricDefinitionId=v.axes[0].metricDefinitionId.toUpperCase(),v=>v.axes.pop(),v=>v.athleteIds=Array.from({length:6},(_,i)=>id(40+i)),v=>v.missing='zero',v=>v.radialScale.maximum=100]){const v=config();mutate(v);assert.equal(radar(v).valid,false,JSON.stringify(v));}
 const input={value:5000,unit:'m',referenceValue:5000,referenceUnit:'m'};
 assert.equal(calculateReferenceValue({...input,operand:'referenceAttainment',formulaVersion:'attainment-positive-v1'}).value,100);
 assert.equal(calculateReferenceValue({...input,operand:'referencePercent',formulaVersion:'signed-relative-abs-v1'}).value,0);
 assert.equal(calculateReferenceValue({...input,value:6000,operand:'referenceAttainment',formulaVersion:'attainment-positive-v1'}).value,120);
});
test('untrusted JSON inputs fail closed without executing getters or recursion',()=>{
 const cycle=manual();cycle.loop=cycle;const getter=manual();Object.defineProperty(getter,'source',{enumerable:true,get:()=>assert.fail('getter executed')});
 const symbol=manual();symbol[Symbol('hidden')]=1;
 for(const v of [cycle,getter,symbol,NaN,[],new Date(),{...manual(),name:'x'.repeat(70000)}])for(const validate of [definition,observation,radar])assert.equal(validate(v).valid,false);
 const malicious={value:2,unit:'m',operand:'value'};Object.defineProperty(malicious,'referenceValue',{enumerable:true,get:()=>assert.fail('calculator getter executed')});assert.equal(calculateReferenceValue(malicious).status,'unavailable');
 assert.equal(calculateReferenceValue({value:2,unit:'m',operand:'value',ignored:true}).status,'unavailable');
});
test('custom array prototypes cannot execute inherited toJSON getters or remove array methods',()=>{
 const inherited=[];const prototype=Object.create(Array.prototype);Object.defineProperty(prototype,'toJSON',{get:()=>assert.fail('inherited getter executed')});Object.setPrototypeOf(inherited,prototype);
 const missingMethods=[];Object.setPrototypeOf(missingMethods,null);
 for(const array of [inherited,missingMethods]){
  for(const [validate,value]of [[definition,{...manual(),source:{kind:'referenceTable',tableId:id(8),tableRevision:1,dimensions:array,dimensionBasis:'measurementDate',ambiguity:'unavailable'}}],[observation,{...obs(),sample:{requestedMatches:5,usedMatches:0,partial:true,eventIds:array}}],[radar,{...config(),axes:array}]])assert.deepEqual(validate(value),{valid:false,issues:[{code:'invalidJson',path:'$'}]});
 }
});
