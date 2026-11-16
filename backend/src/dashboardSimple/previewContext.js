import { createHash } from 'node:crypto';
import { loadAuthorizationContext } from '../authz.js';
import { resolveActiveWorkspaceReadOnly } from '../workspace.js';
import { canManageDashboardRow, dataWorkspaceMatches, dataWorkspaceForActiveWorkspace } from '../trainingLoadDashboardAccess.js';
import { isUuid } from './schema.js';
import { previewError } from './previewTransaction.js';

export async function authorizePreviewTarget(queryRunner, req, dashboardId, { requireWritable = true } = {}) {
  if (!isUuid(req?.user?.id)) throw previewError('notFound', 404);
  let user;
  if (req.sessionToken) {
    const sessionHash = createHash('sha256').update(String(req.sessionToken)).digest('base64url');
    user = (await queryRunner(`select account.* from public.users account join public.auth_sessions session on session.user_id=account.id
      where account.id=$1 and account.is_active=true and session.token_hash=$2 and session.expires_at>now()`, [req.user.id, sessionHash])).rows[0];
  } else user = (await queryRunner('select * from public.users where id=$1 and is_active=true', [req.user.id])).rows[0];
  if (!user) throw previewError('notFound', 404);
  const authz = await loadAuthorizationContext(user, queryRunner);
  const resolved = await resolveActiveWorkspaceReadOnly(user.id, authz, queryRunner);
  if (!resolved.workspace) throw previewError('workspaceSelectionRequired', 409);
  const serverReq = { user, authz };
  const workspace = dataWorkspaceForActiveWorkspace(resolved.workspace, serverReq);
  if (!isUuid(dashboardId)) throw previewError('notFound', 404);
  const dashboard = (await queryRunner('select * from training_load.dashboards where id=$1', [dashboardId])).rows[0];
  if (!dashboard || !canManageDashboardRow(serverReq, dashboard) || !dataWorkspaceMatches(workspace, dashboard)) throw previewError('notFound', 404);
  if (requireWritable && dashboard.status !== 'active') throw previewError('dashboardArchived', 409);
  if (requireWritable && (dashboard.is_template || dashboard.data_workspace_type == null)) throw previewError('templateRequiresClone', 409);
  return { req: serverReq, dashboard, workspace };
}

export async function loadPreviewExisting(queryRunner, dashboardId, editTarget) {
  if (!editTarget) return null;
  const widget = (await queryRunner('select * from training_load.dashboard_widgets where id=$1 and dashboard_id=$2', [editTarget.widgetId, dashboardId])).rows[0];
  if (!widget) throw previewError('notFound', 404);
  const series = (await queryRunner('select * from training_load.dashboard_widget_series where widget_id=$1 order by series_order, id', [widget.id])).rows;
  return { ...widget, series };
}

export async function loadPreviewContext(queryRunner, target, envelope, existing, evaluatedAt) {
  const workspace = target.workspace;
  let athleteSql = 'true';
  const params = [];
  if (workspace.dataWorkspaceType === 'club' || workspace.dataWorkspaceType === 'team') {
    params.push(workspace.dataWorkspaceScopeId, workspace.dataWorkspaceType);
    const column = workspace.dataWorkspaceType === 'club' ? 'club_id' : 'team_id';
    athleteSql = `exists(select 1 from public.athlete_memberships membership where membership.athlete_id=athlete.id and membership.status='active' and membership.membership_type=$2 and membership.${column}=$1)`;
  } else if (workspace.dataWorkspaceType === 'private_coach') {
    params.push(workspace.dataWorkspaceUserId);
    athleteSql = 'exists(select 1 from public.user_athletes membership where membership.athlete_id=athlete.id and membership.user_id=$1 and membership.is_active=true)';
  } else if (workspace.dataWorkspaceType === 'athlete') { params.push(workspace.athleteWorkspaceAthleteId); athleteSql = 'athlete.id=$1'; }
  const authorizedAthleteIds = (await queryRunner(`select athlete.id from public.athletes athlete where ${athleteSql} order by athlete.id`, params)).rows.map(row => row.id);
  const layers = [target.dashboard.default_filter, envelope.context.runtimeFilter, existing?.local_filter_override].filter(Boolean);
  const activityIds = [...new Set([...layers.map(layer => layer.activityId), envelope.draft.advancedFilter?.activity?.id].filter(isUuid))];
  const componentIds = [...new Set([...layers.map(layer => layer.componentId), envelope.draft.advancedFilter?.component?.id].filter(isUuid))];
  const components = componentIds.length ? (await queryRunner('select id, activity_id from training.activity_components where id=any($1::uuid[])', [componentIds])).rows : [];
  const candidates = [...new Set([...activityIds, ...components.map(component => component.activity_id)])];
  const visibilityParams = [candidates];
  let visibility = 'true';
  if (workspace.dataWorkspaceType === 'club' || workspace.dataWorkspaceType === 'team') {
    visibilityParams.push(workspace.dataWorkspaceScopeId);
    const kind = workspace.dataWorkspaceType;
    visibility = `activity.owner_scope='${kind}' and activity.owner_${kind}_id=$2`;
  } else if (workspace.dataWorkspaceType === 'private_coach') {
    visibilityParams.push(workspace.dataWorkspaceUserId);
    visibility = "activity.owner_scope='user' and activity.owner_user_id=$2";
  } else if (workspace.dataWorkspaceType === 'athlete') {
    visibilityParams.push(workspace.athleteWorkspaceAthleteId);
    visibility = 'exists(select 1 from training.activity_participants participant where participant.activity_id=activity.id and participant.athlete_id=$2 and participant.merge_status=\'canonical\')';
  }
  const visibleActivityIds = candidates.length ? (await queryRunner(`select activity.id from training.activities activity where activity.id=any($1::uuid[]) and activity.lifecycle_state<>'superseded' and (${visibility})`, visibilityParams)).rows.map(row => row.id) : [];
  const selection = envelope.draft.advancedFilter?.component;
  const componentLocal = { ...(existing?.local_filter_override ?? {}) };
  if (selection?.mode === 'inherit') delete componentLocal.componentId;
  else if (selection?.mode === 'clear') componentLocal.componentId = null;
  else if (selection?.mode === 'selected') componentLocal.componentId = selection.id.toLowerCase();
  const effectiveComponent = { ...target.dashboard.default_filter, ...envelope.context.runtimeFilter, ...componentLocal }.componentId;
  return {
    authorizedAthleteIds, authorizedFilterIds: { activityId: visibleActivityIds, componentId: components.filter(component => visibleActivityIds.includes(component.activity_id)).map(component => component.id) },
    componentActivityId: components.find(component => component.id === effectiveComponent)?.activity_id,
    athleteWorkspaceAthleteId: workspace.athleteWorkspaceAthleteId,
    defaultFilter: target.dashboard.default_filter, runtimeFilter: envelope.context.runtimeFilter,
    period: envelope.context.period, evaluatedAt,
  };
}
