import {pagesEnabled,pageDatabaseEnabled} from './config.js';
import {previewError} from '../dashboardSimple/previewTransaction.js';
import {isUuid} from '../dashboardSimple/schema.js';
import {resolvePeriod} from '../dashboardSimple/compiler.js';

// Only Page envelopes gain additional binding fields. Legacy Home envelopes and
// their fingerprints/tokens remain byte-identical across the schema backfill.
export async function applySimplePage(q,target,envelope,existing,evaluatedAt){
 if(envelope?.context?.kind!=='page')return null;
 if(!pagesEnabled()||!await pageDatabaseEnabled(q))throw previewError('notFound',404);
 if(!isUuid(envelope.context.pageId))throw previewError('notFound',404);
 const page=(await q('select * from training_load.dashboard_pages where dashboard_id=$1 and id=$2',[target.dashboard.id,envelope.context.pageId])).rows[0];
 if(!page)throw previewError('notFound',404);
 if(existing?.page_id&&existing.page_id!==page.id)throw previewError('notFound',404);
 if(envelope.context.expectedPageDefaultsRevision!==page.defaults_revision)throw previewError('staleRevision',409);
 target.page=page;
 target.dashboard={...target.dashboard,default_filter:page.default_filter};
 if(!envelope.context.period&&page.period_config)envelope.context.period=resolvePeriod(page.period_config,evaluatedAt);
 return page;
}
export const simplePageBinding=target=>target.page?{page:{id:target.page.id,defaultsRevision:target.page.defaults_revision}}:{};
