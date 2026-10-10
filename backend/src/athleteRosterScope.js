import { athleteListAccessFilter } from "./access.js";
import { resolveActiveWorkspace } from "./workspace.js";

// Presentation scope narrows the roster; it never replaces authorization.
export function athleteRosterScope(req, workspace, alias = "a") {
  const access = athleteListAccessFilter(req, alias);
  const placeholder = `$${access.params.length + 1}`;
  let sql = "and false";
  let params = [];
  if (workspace?.type === "private_coach") {
    sql = `and exists (select 1 from public.user_athletes ua where ua.athlete_id = ${alias}.id and ua.user_id = ${placeholder} and ua.is_active = true)`;
    params = [req.user.id];
  } else if (workspace?.type === "club" || workspace?.type === "team") {
    const kind = workspace.type;
    sql = `and exists (select 1 from public.athlete_memberships am where am.athlete_id = ${alias}.id and am.membership_type = '${kind}' and am.status = 'active' and am.${kind}_id = ${placeholder})`;
    params = [workspace.scopeId];
  } else if (workspace?.type === "athlete") {
    sql = `and ${alias}.id = ${placeholder}`;
    params = [req.authz.athleteId];
  }
  return { sql: `${access.sql} ${sql}`, params: [...access.params, ...params] };
}

export async function currentAthleteRosterScope(req, alias = "a") {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return athleteRosterScope(req, workspace, alias);
}
