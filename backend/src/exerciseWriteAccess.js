import { createHash } from "node:crypto";
import { loadAuthorizationContext } from "./authz.js";
import { clubOfScope, lockClubCeiling } from "./clubCeilingLock.js";
import { pickFallbackWorkspace, resolveActiveWorkspaceReadOnly } from "./workspace.js";

async function activeWorkspace(userId, authz, query) {
  const { workspace, availableWorkspaces } = await resolveActiveWorkspaceReadOnly(userId, authz, query);
  return workspace ?? pickFallbackWorkspace(availableWorkspaces);
}

export async function resolveExerciseWriteWorkspace(req, query) {
  if (!req.authz?.clubRoles?.length && !req.authz?.teamRoles?.length) return null;
  const active = await activeWorkspace(req.user.id, req.authz, query);
  return active ?? { type: "unavailable" };
}

export async function lockExerciseWriter(client, req, expected, word, dependentWords = []) {
  if (!expected) return true;
  const { type, scopeId } = expected;
  const native = type === "club" || type === "team";
  if (!native && type !== "platform" && type !== "private_coach") return false;
  if (native) {
    const clubId = await clubOfScope(client, type, scopeId);
    if (!clubId) return false;
    await lockClubCeiling(client, [clubId], "shared");
  }
  const userId = req.user.id;
  await client.query("select public.lock_permission_actor($1,$2,$3)",
    [userId, native ? type : type === "platform" ? "global" : "private", native ? scopeId : null]);
  if (!req.sessionToken) return false;
  const hash = createHash("sha256").update(String(req.sessionToken)).digest("base64url");
  const session = await client.query(
    "select user_id from public.auth_sessions where user_id=$1 and token_hash=$2 and expires_at>now() for share",
    [userId, hash],
  );
  if (!session.rowCount) return false;
  const { rows: [preference] } = await client.query("select workspace_type,scope_id from public.user_workspace_preferences where user_id=$1 for update", [userId]);
  const user = (await client.query("select * from public.users where id=$1 and is_active", [userId])).rows[0];
  if (!user) return false;
  let pending = Promise.resolve();
  const runQuery = (sql, values) => {
    const result = pending.then(() => client.query(sql, values));
    pending = result.catch(() => {});
    return result;
  };
  let authz, resolution;
  try {
    authz = await loadAuthorizationContext(user, runQuery);
    resolution = await resolveActiveWorkspaceReadOnly(userId, authz, runQuery);
  } finally {
    await pending;
  }
  const matches = workspace => workspace?.type === type && (workspace.scopeId ?? null) === (scopeId ?? null);
  if (resolution.workspace) {
    if (!matches(resolution.workspace)) return false;
  } else {
    const fallback = pickFallbackWorkspace(resolution.availableWorkspaces);
    if (!matches(fallback)) return false;
    // A competing first explicit selection wins unless it picked the same workspace.
    const saved = await client.query(
      `insert into public.user_workspace_preferences as saved_preference(user_id,workspace_type,scope_id)
       values($1,$2,$3)
       on conflict(user_id) do update set workspace_type=excluded.workspace_type,scope_id=excluded.scope_id,updated_at=now()
       where saved_preference.workspace_type is not distinct from $4
         and saved_preference.scope_id is not distinct from $5::uuid
       returning user_id`,
      [userId, type, scopeId ?? null, preference?.workspace_type ?? null, preference?.scope_id ?? null],
    );
    if (!saved.rowCount && !matches((await resolveActiveWorkspaceReadOnly(userId, authz, runQuery)).workspace)) return false;
  }
  if (!native) return true;
  const { rows: [rights] } = await client.query(
    `select public.permission_word_honoured($1)
        and public.user_has_permission($2,'exercises.use',$3,$4)
        and public.user_has_permission($2,$1,$3,$4)
        and not exists (
          select 1 from unnest($5::text[]) as required(word)
          where public.permission_word_honoured(required.word)
            and not public.user_has_permission($2,required.word,$3,$4)
        ) as allowed`,
    [word, userId, type, scopeId, dependentWords],
  );
  return rights?.allowed === true;
}

export async function recordExerciseWriterUse(client, workspace) {
  if (workspace?.type !== "club" && workspace?.type !== "team") return;
  await client.query(
    `insert into library.exercise_manage_v108_use(singleton)
     select true where not exists(select 1 from library.exercise_manage_v108_use)
     on conflict do nothing`,
  );
}
