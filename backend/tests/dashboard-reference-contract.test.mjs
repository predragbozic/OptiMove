import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReferenceDefinition as definition,validateReferenceObservation as observation,validateRadarConfiguration as radar} from '../src/dashboardReferences/contract.js';
import {calculateReferenceValue} from '../src/dashboardReferences/calculations.js';
import {buildManualRadarSnapshot,buildRadarSnapshot} from '../src/dashboardReferences/radarSnapshot.js';
import {resolveRollingReference} from '../src/dashboardReferences/referenceSources.js';
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

test('Radar snapshot keeps 120 percent and refuses incomplete polygons', () => {
  const radar = config();
  const [athleteId] = radar.athleteIds;
  const query = { queryId: obs().queryId, bucketKey: obs().bucketKey };
  const observations = radar.axes.map(axis => ({
    ...obs(), athleteId, referenceId: axis.referenceId, referenceRevision: axis.referenceRevision,
    binding: { ...binding(), metricDefinitionId: axis.metricDefinitionId }
  }));
  const measurements = observations.map((reference, index) => ({
    ...query, athleteId, binding: reference.binding, status: 'ready', value: [0, 5000, 6000][index]
  }));
  const snapshot = buildRadarSnapshot(radar, { ...query, measurements, observations });
  assert.deepEqual(snapshot.athletes[0].polygon, [0, 100, 120]);
  assert.equal(snapshot.radialMaximum, 120);
  const mixed = structuredClone(measurements);
  mixed[2].binding.metricVersionId = id(99);
  const unavailable = buildRadarSnapshot(radar, { ...query, measurements: mixed, observations });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.athletes[0].polygon, null);
  assert.equal(unavailable.athletes[0].axes[2].reason, 'incompatibleResult');
});

test('manual Radar definitions enforce their date and team binding', () => {
  const radar = config();
  const [athleteId] = radar.athleteIds;
  const {queryId,bucketKey,measurementDate,measurementInstant,timeZone,evaluatedAt} = obs();
  const definitions = radar.axes.map(axis => ({
    ...manual(), id: axis.referenceId, revision: axis.referenceRevision,
    population: {kind:'team',teamId:id(4)},
    binding: {...binding(),metricDefinitionId:axis.metricDefinitionId}
  }));
  const measurements = definitions.map(definition => ({
    queryId,bucketKey,measurementDate,measurementInstant,timeZone,athleteId,
    teamId:id(4), binding:definition.binding,status:'ready',value:6000
  }));
  const input = {queryId,bucketKey,evaluatedAt,measurements,definitions};
  assert.deepEqual(buildManualRadarSnapshot(radar,input).athletes[0].polygon,[120,120,120]);
  definitions[0].effective.dateFrom = '2026-10-07';
  measurements[1].teamId = id(9);
  const result = buildManualRadarSnapshot(radar,input).athletes[0];
  assert.equal(result.polygon,null);
  assert.equal(result.axes[0].reason,'outOfValidity');
  assert.equal(result.axes[1].reason,'notAuthorized');
});

test('daily Dashboard Radar uses only same-team verified metric rows', async () => {
  const {buildDashboardRadar} = await import('../src/dashboardReferences/dashboardRadar.js');
  const {dashboardRowMetricVersion} = await import('../src/dashboardReferences/manualThreshold.js');
  const radar = config();
  const [athleteId] = radar.athleteIds;
  const date = '2026-10-06';
  const period = {dateFrom:date,dateTo:date};
  const definitions = radar.axes.map(axis => ({
    ...manual(), id:axis.referenceId, population:{kind:'team',teamId:id(4)},
    binding:{...binding(),metricDefinitionId:axis.metricDefinitionId}
  }));
  const widget = {id:id(25), group_by:'day', series:radar.axes.map((axis,index) => ({
    id:id(30+index), metric_definition_id:axis.metricDefinitionId, data_scope_level:'session',
    analytical_aggregation:'sum', source_policy:'manual', source_connection_id:null,
    aggregation_role_policy:'standalone_only', coverage_policy:'complete_only', comparison_period:null
  }))};
  const result = {widgetId:widget.id, series:widget.series.map(series => ({
    seriesId:series.id, status:'ok', data:{current:[{
      athleteId,bucketKey:date,unit:'m',value:6000,[dashboardRowMetricVersion]:id(2)
    }]}
  }))};
  const input = {widget,result,period,queryId:id(80),config:radar,definitions,teamId:id(4)};
  assert.deepEqual(buildDashboardRadar(input).athletes[0].polygon,[120,120,120]);
  assert.equal(buildDashboardRadar({...input,teamId:id(5)}).athletes[0].polygon,null);
  delete result.series[0].data.current[0][dashboardRowMetricVersion];
  assert.equal(buildDashboardRadar(input).athletes[0].axes[0].reason,'incompatibleBinding');
});

test('rolling reference excludes the evaluated event and future matches and explains partial samples', () => {
  const reference = rolling();
  reference.source.minimumMatches = 2;
  reference.source.partialPolicy = 'allowPartial';
  const athleteId = id(6);
  const player = { athleteId, minutes: 70, value: 100, binding: binding() };
  const event = (n, date, players, matchType = 'official') => ({
    id: id(n), teamId: id(4), instant: `${date}T12:00:00.000Z`, matchType, rosterConfirmed: true, players
  });
  const input = {
    athleteId, teamId: id(4), evaluatedEventId: id(30), measurementInstant: '2026-10-25T12:00:00.000Z',
    measurementDate: '2026-10-25',
    evidence: { complete: true, events: [
      event(20, '2026-10-20', [player]), event(23, '2026-10-23', [{ ...player, value: 140 }]),
      event(30, '2026-10-24', [player]), event(31, '2026-10-27', [player]),
      event(22, '2026-10-22', [player], 'friendly')
    ] }
  };
  assert.deepEqual(resolveRollingReference(reference, input), {
    status: 'ready', value: 120,
    sample: { requestedMatches: 5, usedMatches: 2, partial: true, eventIds: [id(23), id(20)] }
  });
  assert.equal(resolveRollingReference(reference, { ...input, evidence: null }).reason, 'missingMatchEvidence');
  input.evidence.events[0].players = [{ ...player, minutes: null }];
  assert.equal(resolveRollingReference(reference, input).reason, 'missingPlayingMinutes');
  input.evidence.events[0].matchType = null;
  assert.equal(resolveRollingReference(reference, input).reason, 'missingMatchClassification');
});

test('rolling team reference distinguishes player-match weights from equal athlete means', () => {
  const reference = rolling();
  reference.population = { kind: 'team', teamId: id(4) };
  Object.assign(reference.source, { requestedMatches: 2, minimumMatches: 2, selection: 'teamMatches' });
  const player = (n, value) => ({ athleteId: id(n), value, binding: binding(), minutes: 90 });
  const evidence = { complete: true, events: [
    { id: id(21), teamId: id(4), instant: '2026-10-22T12:00:00.000Z', matchType: 'official',
      rosterConfirmed: true, players: [player(6, 60), player(7, 120)] },
    { id: id(22), teamId: id(4), instant: '2026-10-23T12:00:00.000Z', matchType: 'official',
      rosterConfirmed: true, players: [player(6, 0)] }
  ] };
  const context = { evidence, teamId: id(4), athleteId: id(6), evaluatedEventId: id(29),
    measurementDate: '2026-10-25', measurementInstant: '2026-10-25T12:00:00.000Z' };
  assert.equal(resolveRollingReference(reference, context).value, 60);
  reference.source.weighting = 'athleteMeansEqual';
  assert.equal(resolveRollingReference(reference, context).value, 75);
  reference.population = { kind: 'position', teamId: id(4), positionBasis: 'measurementDate' };
  assert.equal(resolveRollingReference(reference, context).reason, 'missingDimension');
});
