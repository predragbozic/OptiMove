import { athleteListAccessFilter } from "./access.js";
import { resolveActiveWorkspace } from "./workspace.js";

// Presentation scope narrows the roster; it never replaces authorization.
//
// Roles V-2 (docs/ai/roles-v-steps-plan.md section 9): a view workspace (club_view / team_view) has no old role row in
// its club or team, so the access predicate (old rows only) cannot be its right. Its right is the athletes module's
// entry gate (moduleView.js viewEntryGate): only when the gate let THIS request through for the athletes module
// (req.moduleView, with canView = can(athletes.view) at the workspace's club or team) does the roster read the
// workspace's own active memberships, in an active club (and an active team for team_view). Any other view-workspace
// read - an unlisted route, no word, another module's gate - stays `and false`, as before V-2.
export function athleteRosterScope(req, workspace, alias = "a") {
  if (workspace?.type === "club_view" || workspace?.type === "team_view") return viewRosterScope(req, workspace, alias);
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

function viewRosterScope(req, workspace, alias) {
  const view = req?.moduleView;
  const scope = view?.module === "athletes" ? view.scope : null;
  if (!req?.user || !scope || view.workspace !== workspace) return { sql: "and false", params: [] };
  if (scope.type === "club") {
    return {
      sql: `and exists (select 1 from public.athlete_memberships am join public.clubs vc on vc.id = am.club_id
              where am.athlete_id = ${alias}.id and am.membership_type = 'club' and am.status = 'active'
                and am.club_id = $1::uuid and coalesce(vc.is_active, true))`,
      params: [scope.id],
    };
  }
  if (scope.type === "team") {
    return {
      sql: `and exists (select 1 from public.athlete_memberships am join public.teams vt on vt.id = am.team_id
              join public.clubs vc on vc.id = vt.club_id
              where am.athlete_id = ${alias}.id and am.membership_type = 'team' and am.status = 'active'
                and am.team_id = $1::uuid and coalesce(vt.is_active, true) and coalesce(vc.is_active, true))`,
      params: [scope.id],
    };
  }
  return { sql: "and false", params: [] };
}

// A request the athletes gate let through carries its read-only workspace (req.moduleView); it is not resolved again
// (and never with the preference-writing resolver, plan hazard 1). Every other request resolves as before.
export async function currentAthleteRosterScope(req, alias = "a") {
  if (req?.moduleView?.module === "athletes") return athleteRosterScope(req, req.moduleView.workspace, alias);
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return athleteRosterScope(req, workspace, alias);
}
