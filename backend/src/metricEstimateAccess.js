import { RosterError, noRoster } from "./activityRoster.js";
import { lockClubCeiling } from "./clubCeilingLock.js";

const notFound = () => new RosterError(404, "notFound", "Not found.");

// The request's workspace is fixed. Check the actual holding again in the
// proposal snapshot, the save transaction and the fresh receipt transaction.
export async function assertEstimateRights(client, ctx) {
  const { type, scopeId } = ctx.workspace ?? {};
  const { rows: [rights] } = await client.query(
    `select exists (select 1 from public.users where id = $1 and is_active)
       and case $2::text
         when 'platform' then exists (
           select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active
         )
         when 'club' then exists (
           select 1 from public.user_club_roles r join public.clubs c on c.id = r.club_id
           where r.user_id = $1 and r.club_id = $3 and r.role = 'club_admin' and r.is_active and coalesce(c.is_active, true)
         )
         when 'team' then exists (
           select 1 from public.user_team_roles r join public.teams t on t.id = r.team_id
           join public.clubs c on c.id = t.club_id
           where r.user_id = $1 and r.team_id = $3 and r.role = 'team_coach' and r.is_active
             and coalesce(t.is_active, true) and coalesce(c.is_active, true)
         )
         else false end
       and case when $2 in ('club', 'team') then
         public.permission_word_honoured('load.estimates.manage')
         and public.user_has_permission($1, 'load.view.team', $2, $3)
         and public.user_has_permission($1, 'load.estimates.manage', $2, $3)
       else true end as allowed`,
    [ctx.userId, type, scopeId ?? null],
  );
  if (!rights?.allowed) throw notFound();
}

// The caller has located the target without locking foreign resources.
// For a team session, retain the v54 owner → user/native role lock order.
export async function lockEstimateWriter(client, ctx, target) {
  const { type, scopeId } = ctx.workspace ?? {};
  const native = type === "club" || type === "team";
  const clubId = target.team?.club_id ?? target.activity.owner_club_id;
  if (native) await lockClubCeiling(client, [clubId], "shared");
  if (target.team) {
    try {
      await client.query("select training.lock_activity_decider($1, $2, $3)", [ctx.userId, target.team.id, target.basis]);
    } catch (error) {
      if (error?.code === "42501") throw new RosterError(403, "not_a_team_coach", "You may not decide on this team's roster.");
      throw error;
    }
    if (native) {
      const { rows: [owner] } = await client.query("select club_id from public.teams where id = $1", [target.team.id]);
      if (String(owner?.club_id) !== String(clubId)) throw notFound();
    }
  }
  if (native) await client.query("select public.lock_permission_actor($1, $2, $3)", [ctx.userId, type, scopeId]);
  await assertEstimateRights(client, ctx);
}

export async function assertEstimateRoster(client, target) {
  if (!target.team) throw new RosterError(409, "roster_not_applicable", "Only a team session has a roster.");
  const { rows: [gate] } = await client.query(
    "select coalesce(training.activity_has_roster($1), false) as has_roster",
    [target.canonicalId],
  );
  if (!gate.has_roster) throw noRoster();
}

export async function assertCanonicalEstimateOwner(client, canonicalId, target) {
  const { rows: [current] } = await client.query(
    "select owner_scope, owner_team_id from training.activities where id = $1",
    [canonicalId],
  );
  if (current?.owner_scope !== "team" || String(current.owner_team_id) !== String(target.team.id)) throw notFound();
}
