import { Router } from "express";
import { query } from "../db.js";
import { isClubAdmin, isPlatformAdmin, isTeamCoach } from "../access.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const [clubs, teams, athletes] = await Promise.all([
      loadClubs(req.user),
      loadTeams(req.user),
      loadManagedAthletes(req.user),
    ]);
    res.json({
      scope: req.user?.role_hint || "coach",
      canCreateClub: isPlatformAdmin(req.user),
      canCreateTeam: isPlatformAdmin(req.user) || isClubAdmin(req.user),
      canCreateAthlete: true,
      clubs,
      teams,
      athletes,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/clubs", async (req, res, next) => {
  try {
    if (!isPlatformAdmin(req.user)) return res.status(403).json({ error: "Only platform admin can create clubs." });
    const name = clean(req.body?.name);
    if (!name) return res.status(400).json({ error: "Club name is required." });
    const result = await query(
      `insert into public.clubs (name, short_name, logo_url, city, country, is_active)
       values ($1, $2, $3, $4, $5, true)
       returning id, name, short_name, logo_url, city, country`,
      [name, clean(req.body?.shortName), clean(req.body?.logoUrl), clean(req.body?.city), clean(req.body?.country)],
    );
    res.status(201).json({ club: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/teams", async (req, res, next) => {
  try {
    if (!(isPlatformAdmin(req.user) || isClubAdmin(req.user))) return res.status(403).json({ error: "Only club admin can create teams." });
    const name = clean(req.body?.name);
    const clubId = clean(req.body?.clubId);
    if (!name) return res.status(400).json({ error: "Team name is required." });
    if (!clubId) return res.status(400).json({ error: "Club is required." });
    if (!(await canManageClub(req.user, clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const result = await query(
      `insert into public.teams (club_id, name, short_name, logo_url, is_active)
       values ($1, $2, $3, $4, true)
       returning id, club_id, name, short_name, logo_url`,
      [clubId, name, clean(req.body?.shortName), clean(req.body?.logoUrl)],
    );
    res.status(201).json({ team: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/athletes", async (req, res, next) => {
  try {
    const fullName = clean(req.body?.fullName);
    const athleteId = clean(req.body?.athleteId);
    const clubId = clean(req.body?.clubId) || null;
    const teamId = clean(req.body?.teamId) || null;
    if (!fullName) return res.status(400).json({ error: "Athlete name is required." });
    if (clubId && !(await canManageClub(req.user, clubId))) return res.status(403).json({ error: "Club is outside your access." });
    if (teamId && !(await canManageTeam(req.user, teamId))) return res.status(403).json({ error: "Team is outside your access." });

    const generatedId = athleteId || await nextAthleteId();
    const result = await query(
      `insert into public.athletes (
         athlete_id, source_external_id, full_name, display_name, image_url, user_id, club_id, team_id, is_active
       )
       values ($1, $2, $3, $3, $4, $5, $6, $7, true)
       returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
      [generatedId, athleteId || generatedId, fullName, clean(req.body?.imageUrl), req.user.id, clubId, teamId],
    );
    await query(
      `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
       values ($1, $2, 'coach', true)
       on conflict do nothing`,
      [req.user.id, result.rows[0].id],
    );
    res.status(201).json({ athlete: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

async function loadClubs(user) {
  if (isPlatformAdmin(user)) {
    const result = await query(
      `select id, name, short_name, logo_url, city, country
       from public.clubs
       where coalesce(is_active, true)
       order by name`,
    );
    return result.rows;
  }
  if (isClubAdmin(user)) {
    const result = await query(
      `select c.id, c.name, c.short_name, c.logo_url, c.city, c.country
       from public.user_club_roles ucr
       join public.clubs c on c.id = ucr.club_id
       where ucr.user_id = $1 and ucr.is_active = true and coalesce(c.is_active, true)
       order by c.name`,
      [user.id],
    );
    return result.rows;
  }
  if (isTeamCoach(user)) {
    const result = await query(
      `select distinct c.id, c.name, c.short_name, c.logo_url, c.city, c.country
       from public.user_team_roles utr
       join public.teams t on t.id = utr.team_id
       join public.clubs c on c.id = t.club_id
       where utr.user_id = $1 and utr.is_active = true and coalesce(c.is_active, true)
       order by c.name`,
      [user.id],
    );
    return result.rows;
  }
  return [];
}

async function loadTeams(user) {
  if (isPlatformAdmin(user)) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.teams t
       left join public.clubs c on c.id = t.club_id
       where coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
    );
    return result.rows;
  }
  if (isClubAdmin(user)) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.user_club_roles ucr
       join public.teams t on t.club_id = ucr.club_id
       left join public.clubs c on c.id = t.club_id
       where ucr.user_id = $1 and ucr.is_active = true and coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
      [user.id],
    );
    return result.rows;
  }
  if (isTeamCoach(user)) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.user_team_roles utr
       join public.teams t on t.id = utr.team_id
       left join public.clubs c on c.id = t.club_id
       where utr.user_id = $1 and utr.is_active = true and coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
      [user.id],
    );
    return result.rows;
  }
  return [];
}

async function loadManagedAthletes(user) {
  const result = await query(
    `select
       a.id, a.athlete_id, a.source_external_id,
       coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as name,
       a.image_url, a.club_id, c.name as club_name, a.team_id, t.name as team_name
     from public.athletes a
     left join public.clubs c on c.id = a.club_id
     left join public.teams t on t.id = a.team_id
     where coalesce(a.is_active, true)
       and (
         $2::boolean
         or a.user_id = $1
         or exists (select 1 from public.user_athletes ua where ua.user_id = $1 and ua.athlete_id = a.id and ua.is_active = true)
         or exists (select 1 from public.user_team_roles utr where utr.user_id = $1 and utr.is_active = true and utr.team_id = a.team_id)
         or exists (
           select 1
           from public.user_club_roles ucr
           left join public.teams athlete_team on athlete_team.id = a.team_id
           where ucr.user_id = $1 and ucr.is_active = true and (ucr.club_id = a.club_id or ucr.club_id = athlete_team.club_id)
         )
       )
     order by nullif(regexp_replace(coalesce(a.source_external_id, a.athlete_id), '\\D', '', 'g'), '')::int nulls last,
              name`,
    [user.id, isPlatformAdmin(user)],
  );
  return result.rows;
}

async function canManageClub(user, clubId) {
  if (isPlatformAdmin(user)) return true;
  const result = await query(
    `select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and is_active = true limit 1`,
    [user.id, clubId],
  );
  return result.rowCount > 0;
}

async function canManageTeam(user, teamId) {
  if (isPlatformAdmin(user)) return true;
  const result = await query(
    `select 1
     from public.teams t
     where t.id = $2
       and (
         exists (select 1 from public.user_team_roles utr where utr.user_id = $1 and utr.team_id = t.id and utr.is_active = true)
         or exists (select 1 from public.user_club_roles ucr where ucr.user_id = $1 and ucr.club_id = t.club_id and ucr.is_active = true)
       )
     limit 1`,
    [user.id, teamId],
  );
  return result.rowCount > 0;
}

async function nextAthleteId() {
  const result = await query(
    `select coalesce(max(nullif(regexp_replace(coalesce(source_external_id, athlete_id), '\\D', '', 'g'), '')::int), 999) + 1 as next_id
     from public.athletes`,
  );
  return String(result.rows[0]?.next_id || Date.now());
}

function clean(value) {
  return String(value || "").trim();
}

export default router;
