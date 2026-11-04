import { previewError } from '../dashboardSimple/previewTransaction.js';

export async function requireLegacySinglePage(queryRunner, dashboard) {
  if (dashboard.pages_revision === undefined) return null;
  const pages = (await queryRunner('select id from training_load.dashboard_pages where dashboard_id=$1 order by position,id limit 2', [dashboard.id])).rows;
  if (pages.length > 1) throw Object.assign(previewError('pagesClientRequired', 409), { httpStatus: 409 });
  if (pages.length !== 1) throw Object.assign(previewError('pagesUnavailable'), { httpStatus: 503 });
  return pages[0].id;
}
