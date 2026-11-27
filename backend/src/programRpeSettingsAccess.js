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
export async function lockProgramRpeActor(client, req, scope) {
  const scopeId = nativeProgramRpeScope(scope);
  const privateScope = scope.type === "private_coach";
  const userId = req.user.id;
  const platformScope = scope.type === "platform";
  if (!scopeId && !platformScope && (!privateScope || String(scope.userId) !== String(userId))) return null;

  let user;
  if (privateScope || platformScope) {
    user = (await client.query("select * from public.users where id=$1 and is_active for share", [userId])).rows[0];
    if (!user || !req.sessionToken) return null;
    const holding = await client.query(
      "select id from public.user_global_roles where user_id=$1 and role=$2 and is_active order by id for share",
      [userId, platformScope ? "platform_admin" : "independent_coach"],
    );
    if (!holding.rowCount) return null;
  } else {
    const clubId = await clubOfScope(client, scope.type, scopeId);
    if (!clubId) return null;
    await lockClubCeiling(client, [clubId], "shared");
    await client.query("select public.lock_permission_actor($1, $2, $3)", [userId, scope.type, scopeId]);
  }

  if (req.sessionToken) {
    const hash = createHash("sha256").update(String(req.sessionToken)).digest("base64url");
    const result = await client.query("select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 and expires_at>now() for share", [userId, hash]);
    if (!result.rowCount) return null;
  }
  user ??= (await client.query("select * from public.users where id=$1 and is_active", [userId])).rows[0];
  if (!user) return null;

  const preference = await client.query("select user_id from public.user_workspace_preferences where user_id=$1 for share", [userId]);
  if ((privateScope || platformScope) && !preference.rowCount) return null;
  // Authorization loads several independent reads together. Serialize them
  // on this transaction client so they share its locks and connection.
  let tail = Promise.resolve();
  const runQuery = (sql, values) => {
    const running = tail.then(() => client.query(sql, values));
    tail = running.catch(() => {});
    return running;
  };
  const { authz, workspace } = await (async () => {
    const authz = await loadAuthorizationContext(user, runQuery);
    const { workspace } = await resolveActiveWorkspaceReadOnly(user.id, authz, runQuery);
    return { authz, workspace };
  })().finally(() => tail);
  const actor = { user, authz };
  const fresh = externalScheduleScopeForWorkspace(workspace, actor);
  if (fresh.type !== scope.type || String(nativeProgramRpeScope(fresh)) !== String(scopeId) || (privateScope && String(fresh.userId) !== String(userId))) return null;
  return actor;
}

export async function programRpeSettingsRightsStillHold(client, actor, scope, { trainingLoadView = false } = {}) {
  if (!actor) return false;
  const scopeId = nativeProgramRpeScope(scope);
  if (!scopeId) return true;
  const right = await client.query(
    `select public.permission_word_honoured('programs.rpe_settings')
       and public.user_has_permission($1, 'programs.view', $2, $3)
       and public.user_has_permission($1, 'programs.rpe_settings', $2, $3)
       and (not $4::boolean or public.user_has_permission($1, 'load.view.team', $2, $3)) as allowed`,
    [actor.user.id, scope.type, scopeId, trainingLoadView],
  );
  return right.rows[0]?.allowed === true;
}

export async function lockProgramRpeSettingsActor(client, req, scope, options) {
  const actor = await lockProgramRpeActor(client, req, scope);
  return await programRpeSettingsRightsStillHold(client, actor, scope, options) ? actor : null;
}
