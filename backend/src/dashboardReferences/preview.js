import {createHash} from 'node:crypto';
import {referenceUuid,validReferenceConfig} from './contract.js';
const refusal=(code,status)=>Object.assign(new Error(code),{code,status,httpStatus:status});
export function validReferencePreview(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&Object.keys(value).every(key=>['widgetId','expectedWidgetRevision','groupBy','referenceConfig'].includes(key))&&referenceUuid(value.widgetId)&&Number.isSafeInteger(value.expectedWidgetRevision)&&value.expectedWidgetRevision>0&&['athlete','cohort'].includes(value.groupBy)&&validReferenceConfig(value.referenceConfig);}
// Runtime-only override; the saved rows, defaults and Simple tokens are untouched.
export function referencePreviewWidgets(widgets,preview,clubId){
 if(!validReferencePreview(preview))throw refusal('invalidRequest',400);
 if(preview.referenceConfig.clubId.toLowerCase()!==clubId?.toLowerCase())throw refusal('notFound',404);
 const widget=widgets.find(w=>w.id.toLowerCase()===preview.widgetId.toLowerCase());if(!widget)throw refusal('notFound',404);
 if(widget.revision!==preview.expectedWidgetRevision)throw refusal('staleRevision',409);
 return widgets.map(w=>w!==widget?w:{...w,group_by:preview.groupBy,presentation_config:{...(w.presentation_config??{schemaVersion:1}),chartShape:undefined,chartComposition:undefined,referenceConfig:preview.referenceConfig}});
}
export const referencePreviewFingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function assertReferenceSource(query,config,clubId,workspace,existing=null){
 if(!config||config.clubId.toLowerCase()!==clubId?.toLowerCase())throw refusal('notFound',404);
 if(config.source==='preset'){
  const row=(await query('select t.id from training_load.dashboard_reference_tables t join training_load.dashboard_reference_versions v on v.table_id=t.id where t.id=$1 and t.club_id=$2 and v.id=$3 and v.published and (not t.archived or t.id=$4 and v.id=$5)',[config.tableId,clubId,config.versionId,existing?.tableId??null,existing?.versionId??null])).rows[0];if(!row)throw refusal('notFound',404);
 }else{
  const row=(await query('select id from public.teams where id=$1 and club_id=$2 and coalesce(is_active,true)',[config.teamId,clubId])).rows[0];if(!row||workspace.type==='team'&&row.id!==workspace.scopeId)throw refusal('notFound',404);
 }
}
