
export const MAX_SHELL_IDS = 200;
const kinds = ['clubIds', 'teamIds', 'athleteIds'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeShellFilter(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || Object.keys(value).some(key => !kinds.includes(key))
    || kinds.some(key => !Array.isArray(value[key]) || value[key].some(id => typeof id !== 'string' || !uuid.test(id)))
    || kinds.reduce((n, key) => n + value[key].length, 0) > MAX_SHELL_IDS) {
    throw Object.assign(new Error('Invalid shell filter'), { code: 'invalidRequest', status: 400 });
  }
  return Object.fromEntries(kinds.map(key => [key, [...new Set(value[key].map(id => id.toLowerCase()))].sort()]));
}

// Selection is NEVER an authority/source of facts. This cohort can only narrow
// the existing dashboard data_workspace query and each widget's effective filter.
export async function resolveShellCohort(workspace, selection, queryRunner) {
  const shell = normalizeShellFilter(selection);
  if (shell === null) return null;
  const params = [shell.clubIds, shell.teamIds, shell.athleteIds];
  const type = workspace.dataWorkspaceType;
  const groupsAllowed = ['platform', 'club', 'team'].includes(type);
  let scope;
  if (type === 'platform') scope = 'true';
  else if (type === 'club' || type === 'team') {
    params.push(workspace.dataWorkspaceScopeId);
    scope = `exists(select 1 from public.athlete_memberships own where own.athlete_id=a.id and own.status='active' and own.membership_type='${type}' and own.${type}_id=$4)`;
  } else if (type === 'private_coach') {
    params.push(workspace.dataWorkspaceUserId);
    scope = 'exists(select 1 from public.user_athletes own where own.athlete_id=a.id and own.user_id=$4 and own.is_active=true)';
  } else if (type === 'athlete') {
    params.push(workspace.athleteWorkspaceAthleteId);
    scope = 'a.id=$4';
  } else throw new Error('Unsupported dashboard workspace');
  const union = `${groupsAllowed ? `exists(select 1 from public.athlete_memberships am where am.athlete_id=a.id and am.status='active' and ((am.membership_type='club' and am.club_id=any($1::uuid[])) or (am.membership_type='team' and am.team_id=any($2::uuid[])))) or ` : ''}a.id=any($3::uuid[])`;
  // Keep positions typed even when organizational selections deliberately match nobody.
  const r = await queryRunner(`select a.id from public.athletes a where ($1::uuid[] is not null and $2::uuid[] is not null) and (${union}) and (${scope}) order by a.id`, params);
  return r.rows.map(row => row.id);
}

export function intersectShellAthletes(athleteIds, cohort) {
  if (cohort === null) return athleteIds;
  return cohort.filter(id => !athleteIds?.length || athleteIds.some(other => other.toLowerCase() === id));
}
