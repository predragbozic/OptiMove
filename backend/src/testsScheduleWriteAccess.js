import { isPlatformAdministrator, loadAuthorizationContext } from "./authz.js";
import { clubOfScope, lockClubCeiling } from "./clubCeilingLock.js";
import { resolveActiveWorkspaceReadOnly } from "./workspace.js";

// Creation has exactly one owner: the requesting coach's active workspace.
// Keep the existing platform and personal branches on their own authority.
export async function lockTestsScheduleCreateAccess(client, req, owner) {
  const scopeType = owner.ownerScope;
  if (isPlatformAdministrator(req.authz) || scopeType === "user") return req;
  if (scopeType !== "club" && scopeType !== "team") return null;

  const scopeId = scopeType === "club" ? owner.ownerClubId : owner.ownerTeamId;
  const clubId = await clubOfScope(client, scopeType, scopeId);
  if (!scopeId) return null;
  await client.query("set local lock_timeout = '5s'");
  await lockClubCeiling(client, [clubId], "shared");
  if (scopeType === "team") {
    const team = await client.query(
      "select id from public.teams where id=$1 and club_id is not distinct from $2 and coalesce(is_active,true) for share",
      [scopeId, clubId],
    );
    if (!team.rowCount) return null;
  }
  if (clubId) {
    const club = await client.query(
      "select id from public.clubs where id=$1 and coalesce(is_active,true) for share",
      [clubId],
    );
    if (!club.rowCount) return null;
  }

  const actorId = req.user.id;
  await client.query("select public.lock_permission_actor($1,$2,$3)", [actorId, scopeType, scopeId]);
  const { rows: [rights] } = await client.query(
    `select exists(select 1 from public.users where id=$1 and is_active)
       and public.permission_word_honoured('tests.schedule.manage')
       and public.user_has_permission($1,'tests.view',$2,$3)
       and public.user_has_permission($1,'tests.schedule.manage',$2,$3) as allowed`,
    [actorId, scopeType, scopeId],
  );
  if (!rights?.allowed) return null;

  // Read current workspace and target authority after waiting on the locks.
  const queryRunner = client.query.bind(client);
  await queryRunner("select user_id from public.user_workspace_preferences where user_id=$1 for share", [actorId]);
  const authz = await loadAuthorizationContext(req.user, queryRunner);
  const { workspace } = await resolveActiveWorkspaceReadOnly(actorId, authz, queryRunner);
  if (workspace?.type !== scopeType || String(workspace.scopeId) !== String(scopeId)) return null;
  return { user: req.user, authz };
}
