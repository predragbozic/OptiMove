import { createHash } from "node:crypto";
import { isPlatformAdministrator, loadAuthorizationContext } from "./authz.js";
import { lockClubCeiling } from "./clubCeilingLock.js";

function nativeScope(type, id) {
  return (type === "club" || type === "team") && id ? { type, id: String(id).toLowerCase() } : null;
}

export function dashboardWorkspaceWriteScope(workspace) {
  if (workspace?.view) return null;
  return nativeScope(workspace?.dataWorkspaceType ?? workspace?.type, workspace?.dataWorkspaceScopeId ?? workspace?.scopeId);
}

export function dashboardOwnerWriteScope(row) {
  if (row?.owner_scope === "club") return nativeScope("club", row.owner_club_id);
  if (row?.owner_scope === "team") return nativeScope("team", row.owner_team_id);
  return null;
}

// Each caller supplies only server-resolved scopes. Acquire all ceiling locks
// before locking identity or domain rows, including for a delegated team owner.
export async function lockDashboardManageCeilings(query, scopes) {
  const distinct = new Map(scopes.filter(Boolean).map(scope => [scope.type + ":" + scope.id, scope]));
  const ordered = [...distinct.keys()].sort().map(key => distinct.get(key));
  const client = { query };
  const clubs = [];
  for (const scope of ordered) {
    if (scope.type === "club") {
      clubs.push(scope.id);
      continue;
    }
    const { rows: [team] } = await query("select club_id from public.teams where id = $1", [scope.id]);
    if (!team) return null;
    if (team.club_id) clubs.push(team.club_id);
  }
  await lockClubCeiling(client, clubs, "shared");
  return ordered;
}

export async function lockDashboardActor(query, req) {
  const userId = req.user.id;
  await query("select id from public.users where id=$1 for share", [userId]);
  if (req.sessionToken) {
    const hash = createHash("sha256").update(String(req.sessionToken)).digest("base64url");
    await query("select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 for share", [userId, hash]);
  }
  for (const table of ["user_global_roles", "user_club_roles", "user_team_roles"]) {
    await query("select user_id from public." + table + " where user_id=$1 order by id for share", [userId]);
  }
  await query("select user_id from public.user_workspace_preferences where user_id=$1 for share", [userId]);
}

export async function loadDashboardWriteActor(query, req) {
  const params = [req.user.id];
  let session = "";
  if (req.sessionToken) {
    params.push(createHash("sha256").update(String(req.sessionToken)).digest("base64url"));
    session = "and exists (select 1 from public.auth_sessions s where s.user_id=u.id and s.token_hash=$2 and s.expires_at>now())";
  }
  const { rows: [user] } = await query("select u.* from public.users u where u.id=$1 and u.is_active " + session, params);
  if (!user) return null;
  return { user, authz: await loadAuthorizationContext(user, query) };
}

// Evaluate this after the ceiling and identity locks, on the same client as
// the write or receipt lookup. Existing owner checks still limit every route.
export async function dashboardManageRightsStillHold(query, actor, scopes, { viewOnly = [], refuse = () => false } = {}) {
  if (!scopes) return false;
  if (isPlatformAdministrator(actor.authz)) return true;
  for (const scope of scopes) {
    await query("select public.lock_permission_actor($1, $2, $3)", [actor.user.id, scope.type, scope.id]);
    const manage = !viewOnly.some(target => target.type === scope.type && target.id === scope.id);
    const { rows: [rights] } = await query(
      "select public.user_has_permission($1,'dashboards.view',$2,$3) and (not $4::boolean or (public.permission_word_honoured('dashboards.manage') and public.user_has_permission($1,'dashboards.manage',$2,$3))) as allowed",
      [actor.user.id, scope.type, scope.id, manage],
    );
    if (rights?.allowed !== true) return refuse({ manage });
  }
  return true;
}

// Set this inside the domain transaction, only after a native write succeeds.
// The lock protecting the checked scope remains held until this statement commits.
export async function markDashboardManageWrite(query, actor, scopes) {
  if (!scopes?.length || isPlatformAdministrator(actor.authz)) return;
  await query(
    "update training_load.dashboards_manage_v105_use set first_checked_write_at = clock_timestamp() where singleton and first_checked_write_at is null",
  );
}
