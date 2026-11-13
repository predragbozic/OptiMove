import { isUuid, validateContract } from './schema.js';
import { resolvePeriod } from './compiler.js';
import { previewError } from './previewTransaction.js';
import { requireLegacySinglePage } from '../dashboardPages/legacyGuard.js';

// Route identity is authoritative. A tagged envelope cannot silently upgrade a
// legacy route, or redirect a Page route to a different parent/child.
export async function loadSimplePageTarget(query, target, { pageId = null, context, lock = false } = {}) {
  if (pageId == null) {
    await requireLegacySinglePage(query, target.dashboard);
    if (context && context.kind !== 'legacyDashboard') throw previewError('pagesClientRequired', 409);
    return target;
  }
  if (!isUuid(pageId) || context && (context.kind !== 'page' || context.pageId?.toLowerCase() !== pageId.toLowerCase())) throw previewError('notFound', 404);
  if (target.dashboard.pages_revision === undefined) throw previewError('pagesUnavailable');
  const page = (await query(`select * from training_load.dashboard_pages where dashboard_id=$1 and id=$2${lock ? ' for update' : ''}`, [target.dashboard.id, pageId])).rows[0];
  if (!page) throw previewError('notFound', 404);
  const ready = (await query("select to_regprocedure('training_load.save_simple_page_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb,uuid,integer,jsonb)') is not null as ready")).rows[0]?.ready;
  if (ready !== true) throw previewError('pagesUnavailable');
  return { ...target, page };
}

export function simplePageDefaults(target) {
  return { ...(target.dashboard.default_filter ?? {}), ...(target.page?.default_filter ?? {}) };
}

export function simplePagePeriod(target, envelope, evaluatedAt) {
  if (envelope.context.period) return envelope.context.period;
  if (envelope.draft.periodIntent.mode === 'replacePageRuntime') return undefined;
  if (!target.page?.period_config) throw previewError('pagePeriodRequired', 400);
  if (!validateContract('periodConfig', target.page.period_config).valid) throw previewError('invalidPageDefaults', 409);
  return resolvePeriod(target.page.period_config, evaluatedAt);
}
