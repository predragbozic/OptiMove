import { isPlatformAdministrator, loadAuthorizationContext } from "./authz.js";
import { clubOfScope, lockClubCeiling } from "./clubCeilingLock.js";
import { canManageSchedule } from "./testsAccess.js";
import { resolveActiveWorkspaceReadOnly } from "./workspace.js";

async function lockScheduleDestination(client, req, scopeType, scopeId) {
  if (!scopeId || (scopeType !== "club" && scopeType !== "team")) return null;
  const clubId = await clubOfScope(client, scopeType, scopeId);
  await client.query("set local lock_timeout = '5s'");
  await lockClubCeiling(client, [clubId], "shared");
  const actorId = req.user.id;
  await client.query("select public.lock_permission_actor($1,$2,$3)", [actorId, scopeType, scopeId]);
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

  const { rows: [rights] } = await client.query(
    `select exists(select 1 from public.users where id=$1 and is_active)
       and public.permission_word_honoured('tests.schedule.manage')
       and public.user_has_permission($1,'tests.view',$2,$3)
       and public.user_has_permission($1,'tests.schedule.manage',$2,$3) as allowed`,
    [actorId, scopeType, scopeId],
  );
  return rights?.allowed ? actorId : null;
}

// Creation derives its destination from the active workspace.
export async function lockTestsScheduleCreateAccess(client, req, owner) {
  const scopeType = owner.ownerScope;
  if (isPlatformAdministrator(req.authz) || scopeType === "user") return req;

  const scopeId = scopeType === "club" ? owner.ownerClubId : owner.ownerTeamId;
  const actorId = await lockScheduleDestination(client, req, scopeType, scopeId);
  if (!actorId) return null;

  const queryRunner = client.query.bind(client);
  await queryRunner("select user_id from public.user_workspace_preferences where user_id=$1 for share", [actorId]);
  const authz = await loadAuthorizationContext(req.user, queryRunner);
  const { workspace } = await resolveActiveWorkspaceReadOnly(actorId, authz, queryRunner);
  if (workspace?.type !== scopeType || String(workspace.scopeId) !== String(scopeId)) return null;
  return { user: req.user, authz };
}

// Existing schedules may be administered through a holding outside the current
// native workspace. Check the destination and preserve that holding's scope.
export async function lockTestsScheduleMutation(client, req, scheduleId) {
  const { rows: [hint] } = await client.query(
    "select owner_scope, owner_user_id, owner_club_id, owner_team_id from tests.test_schedules where id=$1",
    [scheduleId],
  );
  if (!hint || !canManageSchedule(req, hint)) return null;

  let writeRequest = req;
  if (hint.owner_scope !== "user" && !isPlatformAdministrator(req.authz)) {
    const scopeId = hint.owner_scope === "club" ? hint.owner_club_id : hint.owner_team_id;
    if (!await lockScheduleDestination(client, req, hint.owner_scope, scopeId)) return null;
    const authz = await loadAuthorizationContext(req.user, client.query.bind(client));
    writeRequest = { user: req.user, authz };
  }

  const { rows: [schedule] } = await client.query(
    "select * from tests.test_schedules where id=$1 for update",
    [scheduleId],
  );
  if (!schedule || schedule.owner_scope !== hint.owner_scope || schedule.owner_user_id !== hint.owner_user_id
      || schedule.owner_club_id !== hint.owner_club_id || schedule.owner_team_id !== hint.owner_team_id
      || !canManageSchedule(writeRequest, schedule)) return null;
  return { schedule, writeRequest };
}
