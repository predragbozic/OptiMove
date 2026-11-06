// Isolated S7a contracts. Validation is not authorization or result proof.
// Live Dashboard/Simple contracts deliberately do not import this module yet.
import {isUuid,isDate} from '../dashboardSimple/schema.js';
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
function json(v,seen=new Set(),depth=0){
  if(depth>15)return false;
  if(v===null || ['string','boolean'].includes(typeof v))return true;
  if(typeof v==='number')return Number.isFinite(v);
  if(!Array.isArray(v) && !object(v) || seen.has(v) || Object.getOwnPropertySymbols(v).length)return false;
  if(Array.isArray(v) && Object.getPrototypeOf(v)!==Array.prototype)return false;
  seen.add(v);
  if(Array.isArray(v) && (v.length>1000 || Array.from({length:v.length},(_,i)=>!Object.hasOwn(v,i)).some(Boolean)))return false;
  const ok=Object.entries(Object.getOwnPropertyDescriptors(v)).every(([key,d])=>Array.isArray(v)&&key==='length' || 'value' in d && d.enumerable && json(d.value,seen,depth+1));
  seen.delete(v);return ok;
}
const exact=(v,keys)=>object(v) && Object.keys(v).length===keys.length && keys.every(key=>Object.hasOwn(v,key));
const text=(v,max=200)=>typeof v==='string' && v===v.trim() && v.length>0 && v.length<=max;
const integer=(v,min,max)=>Number.isSafeInteger(v) && v>=min && v<=max;
const one=(v,values)=>values.includes(v);
const distinctIds=(v,min,max)=>Array.isArray(v) && v.length>=min && v.length<=max && v.every(isUuid) && new Set(v.map(id=>id.toLowerCase())).size===v.length;
const instant=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const zone=v=>{if(typeof v!=='string' || /^[+-]/.test(v))return false;try{new Intl.DateTimeFormat('en',{timeZone:v}).format();return true;}catch{return false;}};
const result=issues=>({valid:issues.length===0,issues});
function start(v){return json(v) && Buffer.byteLength(JSON.stringify(v),'utf8')<=65536;}

export function validReferenceBinding(v){
  return start(v) && exact(v,['metricDefinitionId','metricVersionId','unit','dataScopeLevel','analyticalAggregation','sourcePolicy','sourceConnectionId','aggregationRolePolicy','coveragePolicy']) && isUuid(v.metricDefinitionId) && isUuid(v.metricVersionId) && text(v.unit,100) && one(v.dataScopeLevel,['day','session','component']) && one(v.analyticalAggregation,['sum','avg','max','last']) && one(v.sourcePolicy,['manual','api_import','csv_import','derived','all_with_conflicts','source_connection']) && (v.sourcePolicy==='source_connection'?isUuid(v.sourceConnectionId):v.sourceConnectionId===null) && one(v.aggregationRolePolicy,['standalone_only','standalone_and_source_rollup','all_including_derived']) && one(v.coveragePolicy,['complete_only','complete_and_partial','any']);
}

export function validateReferenceDefinition(v){
  if(!start(v))return result([{code:'invalidJson',path:'$'}]);
  const issues=[],fail=(code,path)=>issues.push({code,path});
  if(!exact(v,['schemaVersion','id','revision','name','owner','binding','population','effective','source']))return result([{code:'invalidShape',path:'$'}]);
  if(v.schemaVersion!==1)fail('unsupportedVersion','$.schemaVersion');
  if(!isUuid(v.id))fail('invalidId','$.id');
  if(!integer(v.revision,1,Number.MAX_SAFE_INTEGER))fail('invalidRevision','$.revision');
  if(!text(v.name))fail('invalidName','$.name');
  if(!exact(v.owner,['kind','id']) || !one(v.owner.kind,['team','club','user']) || !isUuid(v.owner.id))fail('invalidOwner','$.owner');
  if(!validReferenceBinding(v.binding))fail('invalidBinding','$.binding');
  const p=v.population;
  if(!(exact(p,['kind'])&&p.kind==='individual' || exact(p,['kind','teamId'])&&p.kind==='team'&&isUuid(p.teamId) || exact(p,['kind','teamId','positionBasis'])&&p.kind==='position'&&isUuid(p.teamId)&&p.positionBasis==='measurementDate'))fail('invalidPopulation','$.population');
  if(!exact(v.effective,['dateFrom','dateTo']) || !isDate(v.effective.dateFrom) || !(v.effective.dateTo===null || isDate(v.effective.dateTo)&&v.effective.dateTo>=v.effective.dateFrom))fail('invalidEffectiveRange','$.effective');
  const s=v.source;
  if(s?.kind==='manual'){
    if(!exact(s,['kind','value']) || !Number.isFinite(s.value))fail('invalidManualReference','$.source');
  }else if(s?.kind==='referenceTable'){
    if(!exact(s,['kind','tableId','tableRevision','dimensions','dimensionBasis','ambiguity']) || !isUuid(s.tableId) || !integer(s.tableRevision,1,Number.MAX_SAFE_INTEGER) || !Array.isArray(s.dimensions) || s.dimensions.length<1 || s.dimensions.length>3 || s.dimensions.some(x=>!one(x,['position','ageBand','sex'])) || new Set(s.dimensions).size!==s.dimensions.length || s.dimensionBasis!=='measurementDate' || s.ambiguity!=='unavailable')fail('invalidTableReference','$.source');
  }else if(s?.kind==='rollingMatches'){
    if(!exact(s,['kind','requestedMatches','minimumMatches','partialPolicy','selection','matchTypes','minimumParticipationMinutes','normalization','weighting','cutoff','excludeEvaluatedEvent']) || !integer(s.requestedMatches,1,20) || !integer(s.minimumMatches,1,s.requestedMatches) || !one(s.partialPolicy,['unavailable','allowPartial']) || s.partialPolicy==='unavailable'&&s.minimumMatches!==s.requestedMatches || !one(s.selection,['teamMatches','athleteParticipatedMatches']) || !one(s.matchTypes,['official','officialAndFriendly']) || !Number.isFinite(s.minimumParticipationMinutes) || s.minimumParticipationMinutes<0 || s.minimumParticipationMinutes>300 || s.normalization!=='none' || !one(s.weighting,['playerMatchEqual','athleteMeansEqual']) || s.cutoff!=='strictlyBeforeMeasurement' || s.excludeEvaluatedEvent!==true)fail('invalidRollingReference','$.source');
    if(p?.kind==='individual' && s.weighting!=='playerMatchEqual')fail('incompatibleWeighting','$.source.weighting');
  }else fail('unsupportedSource','$.source');
  return result(issues);
}

// Future server adapters must authorize owner, metric, population and every
// contributing event/table row before producing an observation. Never trust a
// request-body observation just because it passes this shape validator.
export function validateReferenceObservation(v){
  if(!start(v))return result([{code:'invalidJson',path:'$'}]);
  if(!exact(v,['schemaVersion','queryId','referenceId','referenceRevision','evaluatedAt','measurementDate','measurementInstant','timeZone','athleteId','bucketKey','binding','status','value','reason','sample']))return result([{code:'invalidShape',path:'$'}]);
  const issues=[],fail=(code,path)=>issues.push({code,path});
  if(v.schemaVersion!==1 || ![v.queryId,v.referenceId,v.athleteId].every(isUuid) || !integer(v.referenceRevision,1,Number.MAX_SAFE_INTEGER))fail('invalidIdentity','$');
  if(!instant(v.evaluatedAt) || !instant(v.measurementInstant) || !zone(v.timeZone) || !isDate(v.measurementDate) || !isDate(v.bucketKey))fail('invalidTime','$');
  else {const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:v.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(v.measurementInstant)).map(p=>[p.type,p.value]));if(`${parts.year}-${parts.month}-${parts.day}`!==v.measurementDate)fail('measurementDateMismatch','$.measurementDate');}
  if(!validReferenceBinding(v.binding))fail('invalidBinding','$.binding');
  if(v.status==='ready'?(!Number.isFinite(v.value)||v.reason!==null):v.status==='unavailable'?(v.value!==null || !one(v.reason,['missingReference','ambiguousReference','missingDimension','incompatibleBinding','insufficientSample','outOfValidity','problemData','notAuthorized'])):true)fail('invalidState','$');
  const s=v.sample;
  if(s!==null && (!exact(s,['requestedMatches','usedMatches','partial','eventIds']) || !integer(s.requestedMatches,1,20) || !integer(s.usedMatches,0,s.requestedMatches) || typeof s.partial!=='boolean' || s.partial!==(s.usedMatches<s.requestedMatches) || !distinctIds(s.eventIds,0,20) || s.eventIds.length!==s.usedMatches))fail('invalidSample','$.sample');
  if(v.status==='ready' && s && s.usedMatches===0)fail('emptyReadySample','$.sample');
  return result(issues);
}

export function validateRadarConfiguration(v){
  if(!start(v))return result([{code:'invalidJson',path:'$'}]);
  if(!exact(v,['schemaVersion','chartVariant','formulaVersion','radialScale','axes','athleteIds','missing']) || v.schemaVersion!==1 || v.chartVariant!=='radar' || v.formulaVersion!=='attainment-positive-v1' || !exact(v.radialScale,['mode','minimum']) || v.radialScale.mode!=='auto' || v.radialScale.minimum!==0 || v.missing!=='unavailable' || !distinctIds(v.athleteIds,1,5) || !Array.isArray(v.axes) || v.axes.length<3 || v.axes.length>8)return result([{code:'invalidRadarConfiguration',path:'$'}]);
  if(v.axes.some(a=>!exact(a,['metricDefinitionId','referenceId','referenceRevision']) || !isUuid(a.metricDefinitionId) || !isUuid(a.referenceId) || !integer(a.referenceRevision,1,Number.MAX_SAFE_INTEGER)) || new Set(v.axes.map(a=>a.metricDefinitionId.toLowerCase())).size!==v.axes.length)return result([{code:'invalidRadarAxes',path:'$.axes'}]);
  return result([]);
}
