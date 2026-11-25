import { query } from "./db.js";

// Self reads span clubs. A closed licence in an active membership closes
// this unscoped self view until the athlete can select a club-specific view.
export async function athleteTrainingLoadAllowed(athleteId, run = query) {
  if (!athleteId) return false;
  const result = await run(`
    select not exists (
      select 1
      from public.athlete_memberships m
      left join public.teams t on m.membership_type = 'team' and t.id = m.team_id
      join public.clubs c on c.id = case when m.membership_type = 'team' then t.club_id else m.club_id end
      where m.athlete_id = $1 and m.status = 'active' and coalesce(c.is_active, true)
        and (m.membership_type = 'club' or (m.membership_type = 'team' and coalesce(t.is_active, true)))
        and public.permission_club_module_closed(c.id, 'training_load')
    ) as allowed
  `, [athleteId]);
  return result.rows[0]?.allowed === true;
}
