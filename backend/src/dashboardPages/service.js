import { createHash, randomUUID } from 'node:crypto';
import { validatePageRequest, MAX_DASHBOARD_PAGES } from './contract.js';
import { validatePageQuery } from './queryContract.js';
import { validateContract, isUuid } from '../dashboardSimple/schema.js';
import { canonicalKey, resolvePeriod } from '../dashboardSimple/compiler.js';
import { withPreviewTransaction, previewError } from '../dashboardSimple/previewTransaction.js';
import { runSimpleSaveTransaction } from '../dashboardSimple/saveTransaction.js';

const fingerprint = value => createHash('sha256').update(canonicalKey(value)).digest('hex');
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'name' ? entry.trim() : normalize(entry)]));
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : value;
};
const pageDto = row => ({ id: row.id, dashboardId: row.dashboard_id, name: row.name, position: row.position, revision: row.revision, defaultsRevision: row.defaults_revision, layoutRevision: row.layout_revision, defaultFilter: row.default_filter, periodConfig: row.period_config, periodOrigin: row.period_origin });

export function createPagesService({ pool, authorize, queryDashboard, assertFilterVisible, now = () => Date.now(), transactionOptions = {}, responseLimit = 4 * 1024 * 1024 }) {
  if (!pool || typeof authorize !== 'function' || typeof queryDashboard !== 'function' || typeof assertFilterVisible !== 'function' || !Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 4 * 1024 * 1024) throw new TypeError('Pages dependencies required');
  const read = operation => withPreviewTransaction({ pool, transactionTimeoutMs: 5000, ...transactionOptions.read }, async q => {
    const result = await operation(q);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > responseLimit) throw previewError('pageResponseTooLarge', 413);
    return result;
  });
  const failIds = (req, dashboardId, pageId) => { if (!isUuid(req?.user?.id) || !isUuid(dashboardId) || pageId != null && !isUuid(pageId)) throw previewError('notFound', 404); };
  const page = async (q, dashboardId, pageId) => {
    const row = (await q('select * from training_load.dashboard_pages where dashboard_id=$1 and id=$2', [dashboardId, pageId])).rows[0];
    if (!row) throw previewError('notFound', 404);
    return row;
  };
  const detail = async (q, dashboardId, pageId) => {
    const row = await page(q, dashboardId, pageId);
    const widgets = (await q(`select id, dashboard_id, page_id, widget_type, title, widget_order, x, y, width, height, mobile_order, group_by, state, display_config, presentation_config, local_filter_override, revision
      from training_load.dashboard_widgets where dashboard_id=$1 and page_id=$2 order by widget_order,id limit 201`, [dashboardId, pageId])).rows;
    if (widgets.length > 200) throw previewError('pageTooLarge', 409);
    const ids = widgets.map(widget => widget.id);
    const series = ids.length ? (await q('select * from training_load.dashboard_widget_series where widget_id=any($1::uuid[]) order by widget_id,series_order,id', [ids])).rows : [];
    return { page: pageDto(row), widgets: widgets.map(widget => ({ ...widget, series: series.filter(entry => entry.widget_id === widget.id) })) };
  };
  const recorded = async (q, target, requestId, hash) => {
    const row = (await q('select * from training_load.dashboard_page_requests where initiator_user_id=$1 and dashboard_id=$2 and request_id=$3 and workspace=$4::jsonb', [target.req.user.id, target.dashboard.id, requestId, JSON.stringify(target.workspace)])).rows[0];
    if (!row) return null;
    if (canonicalKey(row.workspace) !== canonicalKey(target.workspace)) throw previewError('notFound', 404);
    if (hash && row.payload_hash !== hash) throw previewError('idempotencyConflict', 409);
    return row.receipt;
  };
  return {
    async list({ req, dashboardId }) {
      failIds(req, dashboardId);
      return read(async q => {
        const target = await authorize(q, req, dashboardId, { mode: 'read' });
        const rows = (await q('select * from training_load.dashboard_pages where dashboard_id=$1 order by position,id limit $2', [dashboardId, MAX_DASHBOARD_PAGES + 1])).rows;
        if (rows.length > MAX_DASHBOARD_PAGES) throw previewError('pageLimitReached', 409);
        const support=(await q("select to_regprocedure('training_load.mutate_dashboard_page_advanced(uuid,uuid,text,uuid,uuid,uuid,uuid,text,jsonb,jsonb)') is not null and to_regprocedure('training_load.save_simple_page_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb,uuid,integer,jsonb)') is not null as ready, to_regprocedure('training_load.dashboard_combined_chart_v1()') is not null as combined_ready")).rows[0];
        const ready=support?.ready===true;
        return { dashboardId, dashboard:target.dashboard, pagesRevision: target.dashboard.pages_revision, pages: rows.map(pageDto), capabilities: { pageManagement: ready && target.canManage === true && target.canQuery === true, pageQuery: target.canQuery === true, pageWidgetEditing: ready && target.canManage === true && target.canQuery === true, pages: ready, combinedCharts: ready && support?.combined_ready===true && target.canManage===true && target.canQuery===true }, limits: { pages: MAX_DASHBOARD_PAGES, responseBytes: responseLimit } };
      });
    },
    async detail({ req, dashboardId, pageId }) {
      failIds(req, dashboardId, pageId);
      return read(async q => { await authorize(q, req, dashboardId, { mode: 'read' }); return detail(q, dashboardId, pageId); });
    },
    async query({ req, dashboardId, pageId, body }) {
      failIds(req, dashboardId, pageId);
      if (!validatePageQuery(pageId, body)) throw previewError('invalidRequest', 400);
      return read(async q => {
        const target = await authorize(q, req, dashboardId, { mode: 'query' });
        const data = await detail(q, dashboardId, pageId);
        const evaluatedAt = new Date(now()).toISOString();
        let period = body.period;
        if (!period) {
          if (!data.page.periodConfig) throw previewError('pagePeriodRequired', 400);
          if (!validateContract('periodConfig', data.page.periodConfig).valid) throw previewError('invalidPageDefaults', 409);
          period = resolvePeriod(data.page.periodConfig, evaluatedAt);
        }
        const selected = body.widgetIds?.map(id => id.toLowerCase());
        const widgets = selected ? data.widgets.filter(widget => selected.includes(widget.id.toLowerCase())) : data.widgets;
        if (selected && widgets.length !== selected.length) throw previewError('notFound', 404);
        const defaults = { ...(target.dashboard.default_filter ?? {}), ...(data.page.defaultFilter ?? {}) };
        const results = widgets.length ? await queryDashboard(target.workspace, widgets, period, { queryRunner: q, defaultFilter: defaults, requestFilter: body.runtimeFilter ?? {} }) : [];
        const presentations = new Map(widgets.map(widget => [widget.id, widget.presentation_config]));
        return { queryId: randomUUID(), evaluatedAt, dashboardRevision: target.dashboard.revision, pageId, pageRevision: data.page.revision, defaultsRevision: data.page.defaultsRevision, layoutRevision: data.page.layoutRevision, resolvedPeriod: period, widgets: results.map(widget => ({ ...widget, presentation_config: presentations.get(widget.widgetId) ?? null })) };
      });
    },
    async status({ req, dashboardId, requestId }) {
      failIds(req, dashboardId);
      if (!isUuid(requestId)) throw previewError('invalidRequest', 400);
      return read(async q => { const target = await authorize(q, req, dashboardId, { mode: 'status' }); const receipt = await recorded(q, target, requestId); return receipt ? { status: 'recorded', requestId, receipt } : { status: 'notRecorded', requestId, retrySameRequest: true }; });
    },
    async mutate({ req, dashboardId, pageId = null, operation, body }) {
      failIds(req, dashboardId, pageId);
      if (!validatePageRequest(operation, body).valid || (operation === 'create' || operation === 'reorder') !== (pageId === null)) throw previewError('invalidRequest', 400);
      const input = normalize(body);
      const hash = fingerprint({ dashboardId: dashboardId.toLowerCase(), pageId: pageId?.toLowerCase() ?? null, operation, input });
      const verify = () => read(async q => { const target = await authorize(q, req, dashboardId, { mode: 'status' }); return recorded(q, target, input.requestId, hash); });
      return runSimpleSaveTransaction({ pool, ...transactionOptions.write, requestId: input.requestId, verify, write: async q => {
        await q('select pg_advisory_xact_lock(hashtextextended($1,0))', [`dashboard-page:${req.user.id.toLowerCase()}:${input.requestId}`]);
        await authorize(q, req, dashboardId, { mode: 'write', lock: true });
        await q('select id from training_load.dashboards where id=$1 for update', [dashboardId]);
        const target = await authorize(q, req, dashboardId, { mode: 'write' });
        const replay = await recorded(q, target, input.requestId, hash);
        if (replay) return { receipt: replay, replayed: true };
        if (target.dashboard.status !== 'active') throw previewError('dashboardArchived', 409);
        if (target.dashboard.is_template || target.dashboard.data_workspace_type === null) throw previewError('templateRequiresClone', 409);
        if (pageId) await page(q, dashboardId, pageId);
        await assertFilterVisible(q, target, input.defaultFilter);
        const receipt = (await q('select training_load.mutate_dashboard_page($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,$7::jsonb,$8::jsonb) as receipt', [req.user.id, input.requestId, hash, dashboardId, pageId, operation, JSON.stringify(input), JSON.stringify(target.workspace)])).rows[0]?.receipt;
        if (!receipt) throw previewError('saveFailed');
        return { receipt, replayed: false };
      } });
    },
  };
}
