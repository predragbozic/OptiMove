import { createHash } from "node:crypto";
import { loadAuthorizationContext } from "./authz.js";
import { clubOfScope, lockClubCeiling } from "./clubCeilingLock.js";
import { externalScheduleScopeForWorkspace } from "./trainingLoadAccess.js";
import { resolveActiveWorkspaceReadOnly } from "./workspace.js";

export function nativeProgramRpeScope(scope) {
  if (scope.type === "club") return scope.clubId;
  if (scope.type === "team") return scope.teamId;
  return null;
}

// Resolve the expected scope before the first entity lock. The fresh role
// and workspace are checked on the same client as the plan/session write.
export async function lockProgramRpeSettingsActor(client, req, scope, { trainingLoadView = false } = {}) {
  const scopeId = nativeProgramRpeScope(scope);
  if (!scopeId) return scope.type === "platform" || scope.type === "private_coach" ? req : null;
  const clubId = await clubOfScope(client, scope.type, scopeId);
  if (!clubId) return null;
  await lockClubCeiling(client, [clubId], "shared");
  await client.query("select public.lock_permission_actor($1, $2, $3)", [req.user.id, scope.type, scopeId]);
  const params = [req.user.id];
  if (req.sessionToken) {
    params.push(createHash("sha256").update(String(req.sessionToken)).digest("base64url"));
    const result = await client.query("select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 and expires_at>now() for share", params);
    if (!result.rowCount) return null;
  }
  const user = (await client.query("select * from public.users where id=$1 and is_active", [req.user.id])).rows[0];
  if (!user) return null;
  await client.query("select user_id from public.user_workspace_preferences where user_id=$1 for share", [user.id]);
  const authz = await loadAuthorizationContext(user, client.query.bind(client));
  const { workspace } = await resolveActiveWorkspaceReadOnly(user.id, authz, client.query.bind(client));
  const actor = { user, authz };
  const fresh = externalScheduleScopeForWorkspace(workspace, actor);
  if (fresh.type !== scope.type || String(nativeProgramRpeScope(fresh)) !== String(scopeId)) return null;
  const right = await client.query(
    "select public.permission_word_honoured('programs.rpe_settings') and public.user_has_permission($1, 'programs.view', $2, $3) and public.user_has_permission($1, 'programs.rpe_settings', $2, $3) and (not $4::boolean or public.user_has_permission($1, 'load.view.team', $2, $3)) as allowed",
    [user.id, scope.type, scopeId, trainingLoadView],
  );
  return right.rows[0]?.allowed === true ? actor : null;
}
