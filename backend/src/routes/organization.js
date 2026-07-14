import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import { isClubAdmin, isPlatformAdmin, isTeamCoach } from "../access.js";
import { hashPassword } from "../auth.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const [clubs, teams, athletes, users, accessRequests] = await Promise.all([
      loadClubs(req.user),
      loadTeams(req.user),
      loadManagedAthletes(req.user),
      loadUsers(req.user),
      loadProgramAccessRequests(req.user),
    ]);
    res.json({
      scope: req.user?.role_hint || "coach",
      canCreateClub: isPlatformAdmin(req.user),
      canCreateTeam: isPlatformAdmin(req.user) || isClubAdmin(req.user),
      canCreateAthlete: true,
      canCreateUser: true,
      clubs,
      teams,
      athletes,
      users,
      accessRequests,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const email = clean(req.body?.email).toLowerCase();
    const fullName = clean(req.body?.fullName);
    const password = String(req.body?.password || "");
    const roleHint = allowedUserRole(req.user, clean(req.body?.roleHint) || "athlete");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const nameParts = splitName(fullName || email);
    const result = await query(
      `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, created_by_user_id, is_active)
       values ($1, $2, $3, $4, $5, $5, $6, $7, true)
       on conflict (email) do nothing
       returning id, email, full_name, display_name, role_hint`,
      [email, nameParts.firstName, nameParts.lastName, hashPassword(password), fullName || email, roleHint, req.user.id],
    );
    if (!result.rows[0]) return res.status(409).json({ error: "A user with this email already exists." });
    res.status(201).json({ user: result.rows[0] });
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

router.put("/clubs/:clubId", async (req, res, next) => {
  try {
    if (!isPlatformAdmin(req.user) && !isClubAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
    if (!(await canManageClub(req.user, req.params.clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const name = clean(req.body?.name);
    if (!name) return res.status(400).json({ error: "Club name is required." });
    const result = await query(
      `update public.clubs
       set name = $2, short_name = $3, logo_url = $4, city = $5, country = $6, updated_at = now()
       where id = $1
       returning id, name, short_name, logo_url, city, country`,
      [req.params.clubId, name, clean(req.body?.shortName), clean(req.body?.logoUrl), clean(req.body?.city), clean(req.body?.country)],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Club not found." });
    res.json({ club: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/clubs/:clubId", async (req, res, next) => {
  try {
    if (!isPlatformAdmin(req.user)) return res.status(403).json({ error: "Only platform admin can delete clubs." });
    const result = await query(
      `update public.clubs set is_active = false, updated_at = now() where id = $1 returning id`,
      [req.params.clubId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Club not found." });
    res.json({ ok: true });
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

router.put("/teams/:teamId", async (req, res, next) => {
  try {
    if (!(await canManageTeam(req.user, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const name = clean(req.body?.name);
    const clubId = clean(req.body?.clubId);
    if (!name) return res.status(400).json({ error: "Team name is required." });
    if (!clubId) return res.status(400).json({ error: "Club is required." });
    if (!(await canManageClub(req.user, clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const result = await query(
      `update public.teams
       set club_id = $2, name = $3, short_name = $4, logo_url = $5, updated_at = now()
       where id = $1
       returning id, club_id, name, short_name, logo_url`,
      [req.params.teamId, clubId, name, clean(req.body?.shortName), clean(req.body?.logoUrl)],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Team not found." });
    res.json({ team: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/teams/:teamId", async (req, res, next) => {
  try {
    if (!(await canManageTeam(req.user, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const result = await query(
      `update public.teams set is_active = false, updated_at = now() where id = $1 returning id`,
      [req.params.teamId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Team not found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/athletes", async (req, res, next) => {
  try {
    const fullName = clean(req.body?.fullName);
    const athleteId = clean(req.body?.athleteId);
    const { clubId, teamId } = await resolveAthleteClubTeam(req.user, clean(req.body?.clubId), clean(req.body?.teamId));
    if (!fullName) return res.status(400).json({ error: "Athlete name is required." });

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

router.put("/athletes/:athleteId", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req.user, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const fullName = clean(req.body?.fullName);
    const athleteId = clean(req.body?.athleteId);
    const { clubId, teamId } = await resolveAthleteClubTeam(req.user, clean(req.body?.clubId), clean(req.body?.teamId));
    if (!fullName) return res.status(400).json({ error: "Athlete name is required." });
    const result = await query(
      `update public.athletes
       set athlete_id = coalesce(nullif($2, ''), athlete_id),
           source_external_id = coalesce(nullif($2, ''), source_external_id),
           full_name = $3,
           display_name = $3,
           image_url = $4,
           club_id = $5,
           team_id = $6
       where id = $1
       returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
      [req.params.athleteId, athleteId, fullName, clean(req.body?.imageUrl), clubId, teamId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    res.json({ athlete: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId/library-access", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req.user, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `insert into public.athlete_library_access (
         athlete_id,
         managed_by_user_id,
         can_view_coach_library,
         can_view_club_library,
         can_view_optimove_library,
         can_view_marketplace,
         free_only,
         require_approval,
         selected_programs_only
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (athlete_id) do update set
         managed_by_user_id = excluded.managed_by_user_id,
         can_view_coach_library = excluded.can_view_coach_library,
         can_view_club_library = excluded.can_view_club_library,
         can_view_optimove_library = excluded.can_view_optimove_library,
         can_view_marketplace = excluded.can_view_marketplace,
         free_only = excluded.free_only,
         require_approval = excluded.require_approval,
         selected_programs_only = excluded.selected_programs_only,
         updated_at = now()
       returning athlete_id, can_view_coach_library, can_view_club_library, can_view_optimove_library,
         can_view_marketplace, free_only, require_approval, selected_programs_only`,
      [
        req.params.athleteId,
        req.user.id,
        bool(req.body?.canViewCoachLibrary, true),
        bool(req.body?.canViewClubLibrary, false),
        bool(req.body?.canViewOptimoveLibrary, false),
        bool(req.body?.canViewMarketplace, false),
        bool(req.body?.freeOnly, true),
        bool(req.body?.requireApproval, true),
        bool(req.body?.selectedProgramsOnly, false),
      ],
    );
    res.json({ access: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/teams/:teamId/athletes", async (req, res, next) => {
  try {
    const teamId = clean(req.params.teamId);
    const athleteId = clean(req.body?.athleteId);
    if (!teamId || !athleteId) return res.status(400).json({ error: "Team and athlete are required." });
    if (!(await canManageTeam(req.user, teamId))) return res.status(403).json({ error: "Team is outside your access." });
    if (!(await canManageAthlete(req.user, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const team = await query(`select id, club_id from public.teams where id = $1 and coalesce(is_active, true) limit 1`, [teamId]);
    if (!team.rows[0]) return res.status(404).json({ error: "Team not found." });
    const result = await query(
      `update public.athletes
       set club_id = $2, team_id = $3
       where id = $1
       returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
      [athleteId, team.rows[0].club_id, teamId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    res.json({ athlete: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/athlete-invites", async (req, res, next) => {
  try {
    const athleteId = clean(req.body?.athleteId);
    const email = clean(req.body?.email).toLowerCase();
    if (!athleteId || !email) return res.status(400).json({ error: "Athlete and email are required." });
    if (!(await canManageAthlete(req.user, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const athlete = await query(
      `select id, coalesce(display_name, full_name, athlete_id) as name from public.athletes where id = $1 and coalesce(is_active, true) limit 1`,
      [athleteId],
    );
    if (!athlete.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(token);
    const invite = await query(
      `insert into public.athlete_invites (athlete_id, email, token_hash, invited_by_user_id, expires_at)
       values ($1, $2, $3, $4, now() + interval '14 days')
       returning id, athlete_id, email, expires_at, created_at`,
      [athleteId, email, tokenHash, req.user.id],
    );
    const inviteUrl = `${appOrigin(req)}/invite?token=${encodeURIComponent(token)}`;
    const subject = encodeURIComponent("OptiMove athlete access");
    const body = encodeURIComponent(`Hi ${athlete.rows[0].name || ""},\n\nUse this link to activate your OptiMove athlete account:\n${inviteUrl}\n\nThis link expires in 14 days.`);
    res.status(201).json({
      invite: invite.rows[0],
      inviteUrl,
      mailtoUrl: `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/program-access/:accessId/approve", async (req, res, next) => {
  try {
    const request = await loadProgramAccessRequest(req.params.accessId);
    if (!request) return res.status(404).json({ error: "Access request not found." });
    if (!(await canManageAthlete(req.user, request.athlete_id))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `update library.program_access
       set status = 'accessed',
           starts_at = coalesce(starts_at, now()),
           updated_at = now()
       where id = $1
       returning id, status, updated_at`,
      [req.params.accessId],
    );
    res.json({ access: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/program-access/:accessId/reject", async (req, res, next) => {
  try {
    const request = await loadProgramAccessRequest(req.params.accessId);
    if (!request) return res.status(404).json({ error: "Access request not found." });
    if (!(await canManageAthlete(req.user, request.athlete_id))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `update library.program_access
       set status = 'revoked',
           updated_at = now()
       where id = $1
       returning id, status, updated_at`,
      [req.params.accessId],
    );
    res.json({ access: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete("/athletes/:athleteId", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req.user, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `update public.athletes set is_active = false where id = $1 returning id`,
      [req.params.athleteId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/club-roles", async (req, res, next) => {
  try {
    const userId = clean(req.body?.userId);
    const clubId = clean(req.body?.clubId);
    if (!userId || !clubId) return res.status(400).json({ error: "User and club are required." });
    if (!(await canManageClub(req.user, clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const result = await query(
      `insert into public.user_club_roles (user_id, club_id, role, is_active)
       values ($1, $2, 'club_admin', true)
       on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now()
       returning id`,
      [userId, clubId],
    );
    res.status(201).json({ role: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/team-roles", async (req, res, next) => {
  try {
    const userId = clean(req.body?.userId);
    const teamId = clean(req.body?.teamId);
    if (!userId || !teamId) return res.status(400).json({ error: "User and team are required." });
    if (!(await canManageTeam(req.user, teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const result = await query(
      `insert into public.user_team_roles (user_id, team_id, role, is_active)
       values ($1, $2, 'team_coach', true)
       on conflict (user_id, team_id, role) do update set is_active = true, updated_at = now()
       returning id`,
      [userId, teamId],
    );
    res.status(201).json({ role: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/athlete-logins", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const athleteId = clean(req.body?.athleteId);
    const email = clean(req.body?.email).toLowerCase();
    const password = String(req.body?.password || "");
    if (!athleteId || !email || !password) return res.status(400).json({ error: "Athlete, email, and password are required." });
    if (!(await canManageAthlete(req.user, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const athlete = await query(
      `select id, coalesce(display_name, full_name, athlete_id) as name from public.athletes where id = $1 limit 1`,
      [athleteId],
    );
    if (!athlete.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    const nameParts = splitName(athlete.rows[0].name || email);
    await client.query("begin");
    const existing = await client.query(
      `select u.id, u.email, u.role_hint, a.id as linked_athlete_id
       from public.users u
       left join public.athletes a on a.user_id = u.id
       where lower(u.email) = lower($1)
       limit 1`,
      [email],
    );
    const existingUser = existing.rows[0];
    const existingRole = String(existingUser?.role_hint || "").toLowerCase();
    if (existingUser && existingRole && !["athlete", "user"].includes(existingRole)) {
      await client.query("rollback");
      return res.status(409).json({ error: "This email already belongs to a staff user." });
    }
    if (existingUser?.linked_athlete_id && String(existingUser.linked_athlete_id) !== String(athleteId)) {
      await client.query("rollback");
      return res.status(409).json({ error: "This email is already connected to another athlete." });
    }
    const user = existingUser
      ? await client.query(
          `update public.users
           set first_name = coalesce(first_name, $2),
               last_name = coalesce(last_name, $3),
               full_name = coalesce(full_name, $4),
               display_name = coalesce(display_name, $4),
               password_hash = $5,
               role_hint = 'athlete',
               is_active = true,
               updated_at = now()
           where id = $1
           returning id, email`,
          [existingUser.id, nameParts.firstName, nameParts.lastName, athlete.rows[0].name, hashPassword(password)],
        )
      : await client.query(
          `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, created_by_user_id, is_active)
           values ($1, $2, $3, $4, $5, $5, 'athlete', $6, true)
           returning id, email`,
          [email, nameParts.firstName, nameParts.lastName, hashPassword(password), athlete.rows[0].name, req.user.id],
        );
    await client.query(`update public.athletes set user_id = $2 where id = $1`, [athleteId, user.rows[0].id]);
    await client.query(
      `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
       values ($1, $2, 'athlete', true)
       on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
      [user.rows[0].id, athleteId],
    );
    await client.query("commit");
    res.status(201).json({ user: user.rows[0] });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    next(error);
  } finally {
    client.release();
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

async function loadUsers(user) {
  const result = await query(
    `select distinct u.id, u.email, coalesce(u.display_name, u.full_name, u.email) as name, u.role_hint
     from public.users u
     where u.is_active = true
       and (
         $2::boolean
         or u.id = $1
         or u.created_by_user_id = $1
         or exists (
           select 1
           from public.user_club_roles visible_role
           where visible_role.user_id = u.id
             and visible_role.is_active = true
             and visible_role.club_id in (select club_id from public.user_club_roles where user_id = $1 and is_active = true)
         )
         or exists (
           select 1
           from public.user_team_roles visible_role
           where visible_role.user_id = u.id
             and visible_role.is_active = true
             and visible_role.team_id in (select team_id from public.user_team_roles where user_id = $1 and is_active = true)
         )
       )
     order by name`,
    [user.id, isPlatformAdmin(user)],
  );
  return result.rows;
}

async function loadProgramAccessRequests(user) {
  const result = await query(
    `select distinct
       pa.id,
       pa.plan_id,
       pa.user_id,
       pa.access_type,
       pa.status,
       pa.created_at,
       pa.updated_at,
       coalesce(p.name, 'Program') as program_name,
       p.library_category,
       a.id as athlete_id,
       a.athlete_id as athlete_code,
       coalesce(a.display_name, a.full_name, a.athlete_id) as athlete_name,
       a.image_url as athlete_image_url,
       u.email as athlete_email
     from library.program_access pa
     join plans.plans p on p.id = pa.plan_id
     join public.users u on u.id = pa.user_id
     join public.athletes a on a.user_id = pa.user_id
        or exists (
          select 1
          from public.user_athletes ua
          where ua.user_id = pa.user_id
            and ua.athlete_id = a.id
            and ua.relationship_type = 'athlete'
            and ua.is_active = true
        )
     where pa.status = 'requested'
       and coalesce(a.is_active, true)
     order by pa.created_at desc
     limit 100`,
  );
  const visible = [];
  for (const row of result.rows) {
    if (await canManageAthlete(user, row.athlete_id)) visible.push(row);
  }
  return visible;
}

async function loadProgramAccessRequest(accessId) {
  const result = await query(
    `select distinct
       pa.id,
       pa.status,
       pa.plan_id,
       pa.user_id,
       a.id as athlete_id
     from library.program_access pa
     join public.users u on u.id = pa.user_id
     join public.athletes a on a.user_id = pa.user_id
        or exists (
          select 1
          from public.user_athletes ua
          where ua.user_id = pa.user_id
            and ua.athlete_id = a.id
            and ua.relationship_type = 'athlete'
            and ua.is_active = true
        )
     where pa.id = $1
     limit 1`,
    [accessId],
  );
  return result.rows[0] || null;
}

async function loadManagedAthletes(user) {
  const result = await query(
    `select
       a.id, a.athlete_id, a.source_external_id,
       coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as name,
       a.image_url, a.club_id, c.name as club_name, a.team_id, t.name as team_name, a.user_id,
       coalesce(ala.can_view_coach_library, true) as can_view_coach_library,
       coalesce(ala.can_view_club_library, false) as can_view_club_library,
       coalesce(ala.can_view_optimove_library, false) as can_view_optimove_library,
       coalesce(ala.can_view_marketplace, false) as can_view_marketplace,
       coalesce(ala.free_only, true) as free_only,
       coalesce(ala.require_approval, true) as require_approval,
       coalesce(ala.selected_programs_only, false) as selected_programs_only
     from public.athletes a
     left join public.clubs c on c.id = a.club_id
     left join public.teams t on t.id = a.team_id
     left join public.athlete_library_access ala on ala.athlete_id = a.id
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

async function canManageAthlete(user, athleteId) {
  if (isPlatformAdmin(user)) return true;
  const result = await query(
    `select 1
     from public.athletes a
     where a.id = $2
       and (
         a.user_id = $1
         or exists (select 1 from public.user_athletes ua where ua.user_id = $1 and ua.athlete_id = a.id and ua.is_active = true)
         or exists (select 1 from public.user_team_roles utr where utr.user_id = $1 and utr.is_active = true and utr.team_id = a.team_id)
         or exists (
           select 1
           from public.user_club_roles ucr
           left join public.teams athlete_team on athlete_team.id = a.team_id
           where ucr.user_id = $1 and ucr.is_active = true and (ucr.club_id = a.club_id or ucr.club_id = athlete_team.club_id)
         )
       )
     limit 1`,
    [user.id, athleteId],
  );
  return result.rowCount > 0;
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

async function resolveAthleteClubTeam(user, requestedClubId, requestedTeamId) {
  let clubId = clean(requestedClubId) || null;
  const teamId = clean(requestedTeamId) || null;
  if (clubId && !(await canManageClub(user, clubId))) {
    const error = new Error("Club is outside your access.");
    error.status = 403;
    throw error;
  }
  if (!teamId) return { clubId, teamId: null };
  if (!(await canManageTeam(user, teamId))) {
    const error = new Error("Team is outside your access.");
    error.status = 403;
    throw error;
  }
  const result = await query(`select id, club_id from public.teams where id = $1 and coalesce(is_active, true) limit 1`, [teamId]);
  const team = result.rows[0];
  if (!team) {
    const error = new Error("Team not found.");
    error.status = 404;
    throw error;
  }
  if (clubId && String(clubId) !== String(team.club_id)) {
    const error = new Error("Selected team does not belong to the selected club.");
    error.status = 400;
    throw error;
  }
  return { clubId: team.club_id, teamId: team.id };
}

function allowedUserRole(currentUser, requestedRole) {
  const role = clean(requestedRole).toLowerCase();
  const platformRoles = new Set(["platform_admin", "club_admin", "team_coach", "coach", "athlete"]);
  const clubRoles = new Set(["club_admin", "team_coach", "coach", "athlete"]);
  if (isPlatformAdmin(currentUser)) return platformRoles.has(role) ? role : "coach";
  if (isClubAdmin(currentUser)) return clubRoles.has(role) ? role : "team_coach";
  return "athlete";
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

function bool(value, fallback = false) {
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "0" || value === "") return false;
  return fallback;
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function appOrigin(req) {
  const configured = clean(process.env.PUBLIC_APP_URL);
  if (configured) return configured.replace(/\/$/, "");
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${protocol}://${req.get("host")}`;
}

function splitName(value) {
  const parts = clean(value).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || null,
  };
}

export default router;
