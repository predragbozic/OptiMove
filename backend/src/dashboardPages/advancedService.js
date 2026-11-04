import { createHash } from 'node:crypto';
import { isUuid } from '../dashboardSimple/schema.js';
import { canonicalKey } from '../dashboardSimple/compiler.js';
import { previewError, withPreviewTransaction } from '../dashboardSimple/previewTransaction.js';
import { runSimpleSaveTransaction } from '../dashboardSimple/saveTransaction.js';
import { validatePageAdvancedRequest } from './advancedContract.js';
import { isMetricVisibleToDashboard,isSourceConnectionVisibleToDashboard } from '../trainingLoadDashboardAccess.js';

const normalize = (v, key) => Array.isArray(v) ? v.map(item => normalize(item)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,value]) => [k,normalize(value,k)])) : typeof v === 'string' && isUuid(v) ? v.toLowerCase() : key === 'title' && typeof v === 'string' ? v.trim() : v;
export function createPageAdvancedService({ pool, authorize, assertFilterVisible, transactionOptions = {} }) {
  if (!pool || typeof authorize !== 'function' || typeof assertFilterVisible !== 'function') throw new TypeError('Page Advanced dependencies required');
  const read = op => withPreviewTransaction({ pool }, op);
  const ids = ({ req, dashboardId, pageId, widgetId, seriesId }) => {
    if (![req?.user?.id,dashboardId,pageId].every(isUuid) || [widgetId,seriesId].some(id => id != null && !isUuid(id))) throw previewError('notFound',404);
  };
  const recorded = async (q, target, pageId, requestId, hash) => {
    const row = (await q('select * from training_load.dashboard_page_advanced_requests where initiator_user_id=$1 and request_id=$2', [target.req.user.id,requestId])).rows[0];
    if (!row) return null;
    if (row.dashboard_id !== target.dashboard.id || row.page_id !== pageId || canonicalKey(row.workspace) !== canonicalKey(target.workspace) || hash && row.payload_hash !== hash) throw previewError(hash ? 'idempotencyConflict' : 'notFound',hash ? 409 : 404);
    return row.receipt;
  };
  return {
    async status(options) {
      ids(options); if (!isUuid(options.requestId)) throw previewError('invalidRequest',400);
      return read(async q => {
        const target = await authorize(q,options.req,options.dashboardId,{mode:'status'});
        const receipt = await recorded(q,target,options.pageId.toLowerCase(),options.requestId.toLowerCase());
        return receipt ? { status:'recorded',requestId:options.requestId,receipt } : { status:'notRecorded',requestId:options.requestId,retrySameRequest:true };
      });
    },
    async mutate(options) {
      ids(options);
      const { req,operation,body } = options;
      const needsWidget = !['layout','widgetCreate'].includes(operation), needsSeries = ['seriesUpdate','seriesDelete','seriesResolve'].includes(operation);
      if (!validatePageAdvancedRequest(operation,body) || needsWidget !== (options.widgetId != null) || needsSeries !== (options.seriesId != null)) throw previewError('invalidRequest',400);
      const dashboardId=options.dashboardId.toLowerCase(), pageId=options.pageId.toLowerCase(), widgetId=options.widgetId?.toLowerCase() ?? null, seriesId=options.seriesId?.toLowerCase() ?? null, input=normalize(body);
      const hash=createHash('sha256').update(canonicalKey({dashboardId,pageId,widgetId,seriesId,operation,input})).digest('hex');
      const verify=()=>read(async q=>{const target=await authorize(q,req,dashboardId,{mode:'status'});return recorded(q,target,pageId,input.requestId,hash);});
      return runSimpleSaveTransaction({pool,...transactionOptions,requestId:input.requestId,verify,write:async q=>{
        await q('select pg_advisory_xact_lock(hashtextextended($1,0))',[`dashboard-page-advanced:${req.user.id.toLowerCase()}:${input.requestId}`]);
        await authorize(q,req,dashboardId,{mode:'write',lock:true});
        await q('select id from training_load.dashboards where id=$1 for update',[dashboardId]);
        const target=await authorize(q,req,dashboardId,{mode:'write'});
        const replay=await recorded(q,target,pageId,input.requestId,hash); if(replay)return {receipt:replay,replayed:true};
        if(target.dashboard.status!=='active')throw previewError('dashboardArchived',409);
        if(target.dashboard.is_template || target.dashboard.data_workspace_type==null)throw previewError('templateRequiresClone',409);
        const page=(await q('select * from training_load.dashboard_pages where id=$1 and dashboard_id=$2 for update',[pageId,dashboardId])).rows[0];
        if(!page)throw previewError('notFound',404);
        const members=[...new Set([widgetId,...(input.layout?.map(e=>e.widgetId)??[])].filter(Boolean))];
        if(members.length){const widgets=(await q('select id from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 and id=any($3::uuid[]) order by id for update',[dashboardId,pageId,members])).rows;if(widgets.length!==members.length)throw previewError('notFound',404);}
        if(seriesId && !(await q('select id from training_load.dashboard_widget_series where id=$1 and widget_id=$2 for update',[seriesId,widgetId])).rows.length)throw previewError('notFound',404);
        if(input.order){const series=(await q('select id from training_load.dashboard_widget_series where widget_id=$1 order by id for update',[widgetId])).rows;if(series.length!==input.order.length || series.some(s=>!input.order.some(e=>e.seriesId===s.id)))throw previewError('notFound',404);}
        await assertFilterVisible(q,target,input.localFilterOverride);
        if(input.metricDefinitionId){
          await q('select id from training_load.metric_definitions where id=$1 for share',[input.metricDefinitionId]);
          const metric=await isMetricVisibleToDashboard(target.dashboard,input.metricDefinitionId,q);
          if(!metric.visible || metric.def?.state!=='active')throw previewError('notFound',404);
        }
        if(input.sourceConnectionId){
          await q('select id from training_load.metric_source_connections where id=$1 for share',[input.sourceConnectionId]);
          const source=await isSourceConnectionVisibleToDashboard(target.dashboard,input.sourceConnectionId,q);
          if(!source.visible || source.conn?.state!=='active')throw previewError('notFound',404);
        }
        const receipt=(await q('select training_load.mutate_dashboard_page_advanced($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::jsonb,$10::jsonb) as receipt',[req.user.id,input.requestId,hash,dashboardId,pageId,widgetId,seriesId,operation,JSON.stringify(input),JSON.stringify(target.workspace)])).rows[0]?.receipt;
        if(!receipt)throw previewError('saveFailed');return {receipt,replayed:false};
      }});
    },
  };
}
