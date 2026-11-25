import {api} from './api.js';
import {state} from './state.js';
import {currentUserWorkspaceContextParts} from './access.js';
import {reportHandlerError} from './app-errors-capture.js';
import {loadDashboardDetail,queryAnalysisDashboard} from './training-load-analysis-data.js';
const R='/api/training-load/reference-tables';
let islandsPromise,islands,root,renderApp,generation=0,hosts=[],observer,tableGeneration=0,bindingGeneration=0;
export function referenceState(){return state.trainingLoad.references??=( {context:null,initialized:false,available:false,loading:false,busy:false,pending:null,error:'',notice:'',tables:[],options:{positions:[],teams:[]},definitions:[],detail:null,draft:null,dirty:false,binding:null} );}
const context=()=>JSON.stringify(currentUserWorkspaceContextParts());
function payloadFromDetail(detail){return {columns:detail.columns.map(c=>({definitionId:c.definition_id,unit:c.unit,aggregation:c.aggregation,dataLevel:c.data_level,order:c.sort_order})),rows:detail.rows.map(r=>({positionId:r.position_id,order:r.sort_order})),valueKinds:detail.valueKinds.map(k=>({key:k.key,name:k.name,order:k.sort_order})),cells:detail.cells.map(c=>({positionId:c.position_id,definitionId:c.definition_id,valueKey:c.value_key,value:Number(c.value)}))};}
function message(error){return ({staleRevision:'This changed while you were editing. Reopen it before saving.',referenceEmpty:'Add a value before publishing.',referenceNotAvailable:'These references do not match the widget. Choose matching values.',invalidRequest:'Check the names, calculations and numeric values before saving.'})[error?.data?.error]??'This update could not be completed. Try again.';}
export function referencesMayBeLeft(){const s=referenceState();if(s.busy||s.pending){s.error='This update is not confirmed. Check it before leaving.';paint();return false;}if((s.dirty||s.binding?.dirty)&&globalThis.confirm&&!globalThis.confirm('Leave without saving the reference changes?'))return false;s.dirty=false;if(s.detail)s.draft=payloadFromDetail(s.detail);s.binding=null;state.trainingLoad.analysis.referenceEditorOpen=false;return true;}
export function disposeReferenceIslands(){generation++;for(const host of hosts)islands?.unmountIsland(host);hosts=[];observer?.disconnect();observer=null;}
function release(){for(const host of hosts.filter(h=>!h.isConnected))islands?.unmountIsland(host);hosts=hosts.filter(h=>h.isConnected);if(!hosts.length){observer?.disconnect();observer=null;}}
async function readList(){const response=await api(R);const s=referenceState();s.tables=response.tables;s.canEdit=response.canCreate;s.available=true;}
async function openTable(id){const s=referenceState();if(s.dirty&&!referencesMayBeLeft())return;const token=context(),ticket=++tableGeneration;const detail=await api(`${R}/${encodeURIComponent(id)}`);if(context()!==token||ticket!==tableGeneration)return;s.detail=detail;s.draft=payloadFromDetail(detail);s.dirty=false;if(!s.draft.valueKinds.length&&s.canEdit){s.draft.valueKinds=[{key:'minimum',name:'Minimum',order:0},{key:'maximum',name:'Maximum',order:1},{key:'target',name:'Target',order:2}];s.dirty=true;}s.creating=false;}
async function referenceDefinitions(){
 const rows=[];let cursor=null;
 for(let page=0;page<200;page++){
  const params=new URLSearchParams({purpose:'dashboardSeries',limit:'100'});if(cursor){params.set('cursorLabel',cursor.label);params.set('cursorId',cursor.id);}
  const response=await api('/api/training-load/metrics/definitions?'+params);rows.push(...(response.rows??[]));if(!response.nextCursor)return rows.filter(row=>row.state==='active'&&!row.hiddenInClub);cursor=response.nextCursor;
 }
 throw Error('Metric catalog is too large');
}
export async function loadReferenceSection(render){
 const s=referenceState(),key=context();if(s.loading&&s.context===key)return;
 s.context=key;s.loading=true;s.error='';paint();
 try{
  const [list,options,metrics]=await Promise.all([api(R),api(`${R}/options`),referenceDefinitions()]);
  if(context()!==key||referenceState()!==s)return;
  s.available=true;state.trainingLoad.analysis.referencesAvailable=true;s.tables=list.tables;s.canEdit=list.canCreate;s.options=options;s.definitions=metrics;
 }catch(error){if(context()===key){s.available=false;state.trainingLoad.analysis.referencesAvailable=false;s.error=error.status===404?'':'Reference tables could not be loaded. Try again.';}}
 finally{if(context()===key){s.initialized=true;s.loading=false;if(state.trainingLoad.section==='references')render?.();else if(state.trainingLoad.section==='analysis')render?.();else paint();}}
}
async function perform(request){
 const s=referenceState(),key=context();s.busy=true;s.error='';s.pending=request;paint();
 try{const result=await api(request.path,{method:request.method,body:JSON.stringify(request.body)});if(context()!==key)return;s.pending=null;s.dirty=false;
  if(request.kind==='binding'){s.binding=null;state.trainingLoad.analysis.referenceEditorOpen=false;s.notice='References saved.';await loadDashboardDetail(state.trainingLoad.analysis.selectedDashboardId,renderApp,{force:true});await queryAnalysisDashboard(renderApp,{force:true});}
  else{await readList();await openTable(result.id);s.notice=request.kind==='publish'?'Version published. Existing charts keep their pinned version.':'Draft saved.';}
 }catch(error){if(context()!==key)return;if(error.status){s.pending=null;s.error=message(error);}else s.error='The update is not confirmed. Check it before making another change.';}
 finally{if(context()===key){s.busy=false;paint();renderApp?.();}}
}
function fieldDirty(){const s=referenceState();s.dirty=true;s.error='';paint();}
export async function referenceAction(action,value){const s=referenceState();if(s.busy)return;
 try{
  if(action==='retry'){if(s.pending)await perform(s.pending);return;}
  if(s.pending)return;
  if(action==='new'){if(!s.dirty||referencesMayBeLeft()){s.creating=true;s.newName='';s.detail=null;s.draft=null;paint();}return;}
  if(action==='name'){s.newName=value;paint();return;}
  if(action==='cancelNew'){s.creating=false;paint();return;}
  if(action==='create'){await perform({kind:'create',path:R,method:'POST',body:{requestId:crypto.randomUUID(),name:s.newName.trim()}});return;}
  if(action==='open'){await openTable(value);paint();return;}
  if(action==='metric'){s.selectedMetric=value;paint();return;}
  if(action==='position'){s.selectedPosition=value;paint();return;}
  if(action==='kindName'){s.newKind=value;paint();return;}
  if(action==='addMetric'){const d=s.definitions.find(item=>item.id===s.selectedMetric);if(!d||s.draft.columns.length>=20)return;s.draft.columns.push({definitionId:d.id,unit:d.unit??null,aggregation:d.calculation?.kind==='ratio'?'ratio':d.allowedAggregations?.includes(d.daily_aggregation_method)?d.daily_aggregation_method:d.allowedAggregations?.[0]??'sum',dataLevel:d.scope_capabilities?.includes('session')?'session':d.scope_capabilities?.[0]??'session',order:s.draft.columns.length});s.selectedMetric='';fieldDirty();return;}
  if(action==='addPosition'){if(!s.selectedPosition||s.draft.rows.length>=100)return;s.draft.rows.push({positionId:s.selectedPosition,order:s.draft.rows.length});s.selectedPosition='';fieldDirty();return;}
  if(action==='addKind'){if(s.draft.valueKinds.length>=20)return;const name=s.newKind?.trim();if(!name)return;let key=name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,35);if(!/^[a-z]/.test(key))key='value_'+s.draft.valueKinds.length;let suffix=1,base=key;while(s.draft.valueKinds.some(k=>k.key===key))key=base.slice(0,34)+'_'+suffix++;s.draft.valueKinds.push({key,name,order:s.draft.valueKinds.length});s.newKind='';fieldDirty();return;}
  if(action==='dataLevel'){s.draft.columns.find(c=>c.definitionId===value.id).dataLevel=value.value;fieldDirty();return;}
  if(action==='aggregation'){s.draft.columns.find(c=>c.definitionId===value.id).aggregation=value.value;fieldDirty();return;}
  if(action==='cell'){const cells=s.draft.cells;const index=cells.findIndex(c=>c.positionId===value.rowKey&&c.definitionId===value.columnKey&&c.valueKey===value.valueKey);if(index>=0)cells.splice(index,1);if(value.value!==null)cells.push({positionId:value.rowKey,definitionId:value.columnKey,valueKey:value.valueKey,value:value.value});fieldDirty();return;}
  if(action==='save'||action==='publish'||action==='archive'){
   if(action==='archive'&&!confirm('Archive this table? Existing charts keep their published version.'))return;
   const id=s.detail.table.id,body={requestId:crypto.randomUUID(),expectedRevision:s.detail.table.revision,...(action==='save'?{draft:s.draft}:{})};
   await perform({kind:action,path:`${R}/${id}/${action==='save'?'draft':action}`,method:action==='save'?'PATCH':'POST',body});return;
  }
  if(action==='openBinding'){
   if(!s.initialized)await loadReferenceSection();
   if(!s.available)return;
   const a=state.trainingLoad.analysis,response=await api(`/api/training-load/dashboard-references/${a.selectedDashboardId}/widgets/${value}`),existing=response.widget.referenceConfig;
   s.binding={widget:response.widget,series:response.series,mode:existing?.mode??'overlay',source:existing?.source??'preset',groupBy:['athlete','cohort'].includes(response.widget.groupBy)?response.widget.groupBy:'athlete',tableId:existing?.tableId??'',teamId:existing?.teamId??'',selected:existing?.axes.map(axis=>axis.seriesId)??response.series.filter(item=>item.metric_definition_id).map(item=>item.id),axes:Object.fromEntries((existing?.axes??[]).map(axis=>[axis.seriesId,{...axis,lowerKey:axis.band?.lowerKey,upperKey:axis.band?.upperKey}]))};
   if(existing?.source==='preset')s.binding.version=await api(`${R}/${existing.tableId}/versions/${existing.versionId}`);
   s.error='';a.menu='';a.referenceEditorOpen=true;renderApp?.();paint();return;
  }
  if(action==='closeBinding'){if(s.binding?.dirty&&!confirm('Close without saving the reference settings?'))return;s.binding=null;state.trainingLoad.analysis.referenceEditorOpen=false;s.error='';renderApp?.();return;}
  if(action==='bindingField'){s.binding.dirty=true;s.binding[value.key]=value.value;paint();return;}
  if(action==='bindingTable'){const binding=s.binding,ticket=++bindingGeneration,key=context();binding.dirty=true;binding.tableId=value;binding.version=null;const table=s.tables.find(t=>t.id===value);paint();const version=table?await api(`${R}/${table.id}/versions/${table.published_version_id}`):null;if(context()!==key||s.binding!==binding||ticket!==bindingGeneration)return;binding.version=version;if(version){const kinds=version.valueKinds;binding.axes=Object.fromEntries(binding.selected.map(id=>[id,{anchorKey:kinds.find(k=>k.key==='target')?.key??kinds[0]?.key,valueKeys:kinds.map(k=>k.key)}]));}paint();return;}
  if(action==='bindingSeries'){s.binding.dirty=true;s.binding.selected=s.binding.selected.includes(value)?s.binding.selected.filter(id=>id!==value):[...s.binding.selected,value];paint();return;}
  if(action==='bindingAxis'){s.binding.dirty=true;(s.binding.axes[value.id]??={anchorKey:'target',valueKeys:[]})[value.key]=value.value;paint();return;}
  if(action==='bindingValue'){s.binding.dirty=true;const axis=s.binding.axes[value.id]??={anchorKey:'target',valueKeys:[]};axis.valueKeys=axis.valueKeys.includes(value.key)?axis.valueKeys.filter(k=>k!==value.key):[...axis.valueKeys,value.key];paint();return;}
  if(action==='saveBinding'||action==='clearBinding'){
   const b=s.binding,a=state.trainingLoad.analysis;
   if(action==='saveBinding'&&(b.mode==='radar'?b.selected.length<3:b.selected.length!==1)){s.error=b.mode==='radar'?'Choose at least three variables for Radar.':'Choose one variable for reference lines, or choose Radar.';paint();return;}
   if(action==='saveBinding'&&b.groupBy==='cohort'&&b.source!=='teamAverage'){s.error='Choose Team average to compare a group.';paint();return;}
   if(action==='saveBinding'&&(b.source==='preset'&&!b.version||b.source==='teamAverage'&&!b.teamId)){s.error='Choose a reference table or team before saving.';paint();return;}
   const config={schemaVersion:1,source:b.source,mode:b.mode,clubId:s.options.clubId,...(b.source==='preset'?{tableId:b.tableId,versionId:b.version.version.id}:{teamId:b.teamId}),axes:b.selected.map(id=>({seriesId:id,...(b.source==='teamAverage'?{valueKeys:['teamAverage']}:{anchorKey:b.axes[id]?.anchorKey??'target',valueKeys:b.axes[id]?.valueKeys??[],...(b.mode==='overlay'&&b.axes[id]?.lowerKey&&b.axes[id]?.upperKey?{band:{lowerKey:b.axes[id].lowerKey,upperKey:b.axes[id].upperKey}}:{})})}))};
   await perform({kind:'binding',path:`/api/training-load/dashboard-references/${a.selectedDashboardId}/widgets/${b.widget.id}`,method:'PUT',body:{requestId:crypto.randomUUID(),expectedWidgetRevision:b.widget.revision,groupBy:b.groupBy,referenceConfig:action==='clearBinding'?null:config}});return;
  }
 }catch(error){s.error=message(error);paint();}
}
function paint(){if(!islands||!root?.isConnected)return;const s=referenceState();
 for(const host of root.querySelectorAll('[data-reference-island]')){
  const kind=host.dataset.referenceIsland;
  let Component,props;
  if(kind==='entry'){Component=islands.ReferenceEntry;props={available:s.available};}
  if(kind==='workspace'){Component=islands.ReferenceWorkspace;props={model:s,onAction:referenceAction};}
  if(kind==='binding'){Component=islands.ReferenceBindingEditor;props={model:s,onAction:referenceAction};}
  if(kind==='chart'){const widget=state.trainingLoad.analysis.widgets.find(w=>w.id===host.dataset.widgetId),result=state.trainingLoad.analysis.queryResult?.widgets.find(w=>w.widgetId===widget?.id);Component=islands.ReferenceChart;props={data:result?.references,widget};}
  if(Component){islands.mountIsland(host,Component,props,{name:'dashboard_references'});if(!hosts.includes(host))hosts.push(host);}
 }
}
export async function mountReferenceIslands(container,render){const token=++generation;root=container;renderApp=render;const s=referenceState();
 if(s.context!==context()){state.trainingLoad.references=undefined;state.trainingLoad.analysis.referencesAvailable=false;referenceState().context=context();}
 if(!container.querySelector('[data-reference-island]'))return;
 try{islandsPromise??=import('./react-build/islands.js');islands=await islandsPromise;if(token!==generation||!container.isConnected)return;await import('./training-load-analysis-echarts.js');release();paint();observer??=new MutationObserver(release);observer.observe(document.body,{childList:true,subtree:true});
  if(!referenceState().initialized&&!referenceState().loading)void loadReferenceSection(render);
 }catch(error){islandsPromise=null;reportHandlerError(error,'dashboard_references');}
}
