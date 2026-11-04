import { createHash } from 'node:crypto';
import { authorizePreviewTarget, loadPreviewContext } from '../dashboardSimple/previewContext.js';
import { previewError } from '../dashboardSimple/previewTransaction.js';
import { canManageDashboardRow, dataWorkspaceMatches } from '../trainingLoadDashboardAccess.js';

export async function authorizePages(queryRunner, req, dashboardId, { mode = 'read', lock = false } = {}) {
  if (lock) {
    await queryRunner('select id from public.users where id=$1 for share', [req.user.id]);
    if (req.sessionToken) await queryRunner('select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 for share', [req.user.id, createHash('sha256').update(String(req.sessionToken)).digest('base64url')]);
    for (const table of ['user_global_roles', 'user_club_roles', 'user_team_roles', 'user_workspace_preferences']) await queryRunner(`select user_id from public.${table} where user_id=$1 for share`, [req.user.id]);
  }
  const target = await authorizePreviewTarget(queryRunner, req, dashboardId, { requireWritable: mode === 'query', requireManage: mode === 'write' || mode === 'status', requireDataMatch: mode !== 'read' });
  if (target.dashboard.pages_revision === undefined) throw previewError('pagesUnavailable');
  return { ...target, canManage: canManageDashboardRow(target.req, target.dashboard), canQuery: target.dashboard.status === 'active' && !target.dashboard.is_template && dataWorkspaceMatches(target.workspace, target.dashboard) };
}

export async function assertPageFilterVisible(queryRunner, target, filter) {
  if (!filter) return;
  const context = await loadPreviewContext(queryRunner, target, { context: { runtimeFilter: filter }, draft: {} }, null, new Date().toISOString());
  const athletes = new Set(context.authorizedAthleteIds.map(id => id.toLowerCase()));
  if (filter.athleteIds?.some(id => !athletes.has(id.toLowerCase()))) throw previewError('notFound', 404);
  for (const key of ['activityId', 'componentId']) if (filter[key] && !context.authorizedFilterIds[key].includes(filter[key])) throw previewError('notFound', 404);
  if (filter.activityId && filter.componentId && context.componentActivityId !== filter.activityId) throw previewError('invalidRequest', 400);
}
