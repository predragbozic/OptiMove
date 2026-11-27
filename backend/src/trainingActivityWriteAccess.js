import { lockClubCeiling } from "./clubCeilingLock.js";

const nativeScopes = new Set(["club", "team"]);

export function isNativeActivityWriter(scope) {
  return Boolean(scope.staffActorId) && nativeScopes.has(scope.type);
}

export function activityWriteDenied(message = "Forbidden") {
  return Object.assign(new Error(message), { httpStatus: 403 });
}

// Only the mounted staff routes bind a staff actor. Shared SQL and other
// sanctioned callers retain their independent authorization.
export async function lockActivityWriter(client, scope) {
  if (!isNativeActivityWriter(scope)) return;
  const scopeId = scope.clubId ?? scope.teamId;
  const team = scope.teamId ? (await client.query("select club_id from public.teams where id=$1", [scope.teamId])).rows[0] : null;
  const clubId = scope.clubId ?? team?.club_id;
  if (!clubId) throw activityWriteDenied();
  await lockClubCeiling(client, [clubId], "shared");
  if (scope.teamId) {
    const { rows } = await client.query(
      "select id from public.teams where id=$1 and club_id=$2 and coalesce(is_active,true) for share",
      [scope.teamId, clubId],
    );
    if (!rows.length) throw activityWriteDenied();
  }
  const { rows } = await client.query("select id from public.clubs where id=$1 and coalesce(is_active,true) for share", [clubId]);
  if (!rows.length) throw activityWriteDenied();
  await client.query("select public.lock_permission_actor($1, $2, $3)", [scope.staffActorId, scope.type, scopeId]);
  const { rows: [rights] } = await client.query(
    `select exists (select 1 from public.users where id=$1 and is_active)
       and case $2::text
         when 'club' then exists (select 1 from public.user_club_roles where user_id=$1 and club_id=$3 and role='club_admin' and is_active)
         when 'team' then exists (select 1 from public.user_team_roles where user_id=$1 and team_id=$3 and role='team_coach' and is_active)
         else false end
       and public.permission_word_honoured('load.activities.manage')
       and public.user_has_permission($1, 'load.view.team', $2, $3)
       and public.user_has_permission($1, 'load.activities.manage', $2, $3) as allowed`,
    [scope.staffActorId, scope.type, scopeId],
  );
  if (!rights?.allowed) throw activityWriteDenied();
}

export async function recordCheckedActivityWrite(client, scope) {
  if (!isNativeActivityWriter(scope)) return;
  await client.query(
    `update training_load.activity_identity_m3c_use set first_checked_write_at=clock_timestamp()
     where singleton and first_checked_write_at is null`,
  );
}
