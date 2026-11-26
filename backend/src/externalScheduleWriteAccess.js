import { lockClubCeiling } from "./clubCeilingLock.js";
import { externalScheduleScopeForWorkspace } from "./trainingLoadAccess.js";
import { resolveActiveWorkspace } from "./workspace.js";

// Resolve once before BEGIN and reuse the scope previously checked by the
// module gate. The locked writer checks the workspace's owning club again.
export async function resolveExternalScheduleWriteScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  const scope = externalScheduleScopeForWorkspace(workspace, req);
  return { ...scope, ceilingClubId: workspace?.type === "club" ? scope.clubId : workspace?.clubId ?? null };
}

// The M-2 bridge stages the word in SQL. The checked/editable JavaScript
// inventory and native /me projection are enabled only after old writers drain.
export async function lockExternalScheduleWriter(client, userId, scope) {
  const native = scope.type === "club" || scope.type === "team";
  const scopeId = scope.type === "club" ? scope.clubId : scope.type === "team" ? scope.teamId : null;
  const clubId = native ? scope.ceilingClubId : null;
  await lockClubCeiling(client, [clubId], "shared");

  const scopeType = native ? scope.type : scope.type === "platform" ? "global" : "private";
  await client.query("select public.lock_permission_actor($1, $2, $3)", [userId, scopeType, scopeId]);

  const result = await client.query(
    `select public.permission_word_honoured('load.schedule.manage')
       and exists (select 1 from public.users where id = $1 and is_active = true)
       and case $2::text
         when 'club' then exists (
           select 1 from public.user_club_roles r
           join public.clubs c on c.id = r.club_id
           where r.user_id = $1 and r.club_id = $3 and r.role = 'club_admin' and r.is_active = true
             and coalesce(c.is_active, true)
           for share of c
         )
         when 'team' then exists (
           select 1 from public.user_team_roles r
           join public.teams t on t.id = r.team_id
           where r.user_id = $1 and r.team_id = $3 and r.role = 'team_coach' and r.is_active = true
             and coalesce(t.is_active, true) and t.club_id is not distinct from $4::uuid
           for share of t
         )
         when 'platform' then exists (
           select 1 from public.user_global_roles
           where user_id = $1 and role = 'platform_admin' and is_active = true
         )
         when 'private_coach' then exists (
           select 1 from public.user_global_roles
           where user_id = $1 and role = 'independent_coach' and is_active = true
         )
         else false
       end
       and case when $2 in ('club', 'team') then
         public.user_has_permission($1, 'load.view.team', $2, $3)
         and public.user_has_permission($1, 'load.schedule.manage', $2, $3)
       else true end as allowed`,
    [userId, scope.type, scopeId, clubId],
  );
  return result.rows[0]?.allowed === true;
}

// Put the existing owner boundary in the locking query, so an inaccessible
// schedule does not wait on a row lock. The owner is checked by the caller
// against the same active scope before use.
export async function lockExternalSchedule(client, scope, scheduleId, mode) {
  const lock = mode === "share" ? "for share" : "for update";
  const result = await client.query(
    `select * from training_load.external_schedules
     where id = $1 and case $2::text
       when 'platform' then true
       when 'club' then owner_scope = 'club' and owner_club_id = $3
       when 'team' then owner_scope = 'team' and owner_team_id = $3
       when 'private_coach' then owner_scope = 'user' and owner_user_id = $3
       else false
     end ${lock}`,
    [scheduleId, scope.type, scope.clubId ?? scope.teamId ?? scope.userId ?? null],
  );
  return result.rows[0] ?? null;
}

// The marker is the last shared write before COMMIT. An unsuccessful request
// cannot advance it. Once the new writer was used, rollback is forward-fix only.
export async function recordExternalScheduleWrite(client) {
  await client.query(
    `update training_load.external_schedule_m2_use set first_checked_write_at = clock_timestamp()
     where singleton and first_checked_write_at is null`,
  );
}
