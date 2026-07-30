import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import {
  canManageClub as authzCanManageClub,
  canManageTeamById as authzCanManageTeam,
  isPlatformAdministrator,
  loadAuthorizationContext,
} from "../authz.js";
import { destroySessionsForUser, hashPassword } from "../auth.js";
import { createNotification } from "../notifications.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const [clubs, teams, athletes, users, accessRequests] = await Promise.all([
      loadClubs(req),
      loadTeams(req),
      loadManagedAthletes(req),
      loadUsers(req),
      loadProgramAccessRequests(req.user),
    ]);
    res.json({
      scope: req.user?.role_hint || "coach",
      isPlatformAdmin: isPlatformAdministrator(req.authz),
      canCreateClub: isPlatformAdministrator(req.authz),
      canCreateTeam: isPlatformAdministrator(req.authz) || req.authz.clubRoles.length > 0,
      canCreateAthlete: true,
      canCreateUser: isPlatformAdministrator(req.authz) || req.authz.clubRoles.length > 0,
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
    // Frontend hides this form from anyone without club/platform scope, but
    // that's a UI convenience, not enforcement - the real restriction has to
    // live here too.
    if (!isPlatformAdministrator(req.authz) && req.authz.clubRoles.length === 0) {
      return res.status(403).json({ error: "Only a platform admin or club admin can create user accounts." });
    }
    const email = clean(req.body?.email).toLowerCase();
    const fullName = clean(req.body?.fullName);
    const password = String(req.body?.password || "");
    const roleHint = allowedUserRole(req.authz, clean(req.body?.roleHint) || "athlete");
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

router.delete("/users/:userId", async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) return res.status(400).json({ error: "You cannot delete your own account." });
    const result = await query(
      `update public.users
       set is_active = false, updated_at = now()
       where id = $1 and (created_by_user_id = $2 or $3::boolean)
       returning id`,
      [req.params.userId, req.user.id, isPlatformAdministrator(req.authz)],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found or outside your access." });
    await destroySessionsForUser(result.rows[0].id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/clubs", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only platform admin can create clubs." });
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
    if (!(await canManageClub(req, req.params.clubId))) return res.status(403).json({ error: "Club is outside your access." });
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
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only platform admin can delete clubs." });
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
    if (!(isPlatformAdministrator(req.authz) || req.authz.clubRoles.length > 0)) return res.status(403).json({ error: "Only club admin can create teams." });
    const name = clean(req.body?.name);
    const clubId = clean(req.body?.clubId);
    if (!name) return res.status(400).json({ error: "Team name is required." });
    if (!clubId) return res.status(400).json({ error: "Club is required." });
    if (!(await canManageClub(req, clubId))) return res.status(403).json({ error: "Club is outside your access." });
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
    if (!(await canManageTeam(req, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const name = clean(req.body?.name);
    const clubId = clean(req.body?.clubId);
    if (!name) return res.status(400).json({ error: "Team name is required." });
    if (!clubId) return res.status(400).json({ error: "Club is required." });
    if (!(await canManageClub(req, clubId))) return res.status(403).json({ error: "Club is outside your access." });
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
    if (!(await canManageTeam(req, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
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
    const { clubId, teamId } = await resolveAthleteClubTeam(req, clean(req.body?.clubId), clean(req.body?.teamId));
    if (!fullName) return res.status(400).json({ error: "Athlete name is required." });

    const generatedId = athleteId || await nextAthleteId();
    const { firstName, lastName } = splitName(fullName);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into public.athletes (
           athlete_id, source_external_id, first_name, last_name, full_name, display_name, image_url, created_by_user_id, club_id, team_id, is_active
         )
         values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, true)
         returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
        [generatedId, athleteId || generatedId, firstName, lastName, fullName, clean(req.body?.imageUrl), req.user.id, clubId, teamId],
      );
      await client.query(
        `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
         values ($1, $2, 'coach', true)
         on conflict do nothing`,
        [req.user.id, result.rows[0].id],
      );
      // The initial club/team assignment also becomes this athlete's first
      // active athlete_memberships row(s) - the new authoritative source for
      // club/team access (see ensureActiveMembership). All in one
      // transaction so a failure partway never leaves the athlete row
      // created without its matching membership/coach-link rows.
      if (clubId) await ensureActiveMembership(client, result.rows[0].id, clubId, null, "club", req.user.id);
      if (teamId) await ensureActiveMembership(client, result.rows[0].id, clubId, teamId, "team", req.user.id);
      await client.query("commit");
      res.status(201).json({ athlete: result.rows[0] });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const fullName = clean(req.body?.fullName);
    const athleteId = clean(req.body?.athleteId);
    const { clubId, teamId } = await resolveAthleteClubTeam(req, clean(req.body?.clubId), clean(req.body?.teamId));
    if (!fullName) return res.status(400).json({ error: "Athlete name is required." });
    const { firstName, lastName } = splitName(fullName);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update public.athletes
         set athlete_id = coalesce(nullif($2, ''), athlete_id),
             source_external_id = coalesce(nullif($2, ''), source_external_id),
             first_name = $3,
             last_name = $4,
             full_name = $5,
             display_name = $5,
             image_url = $6,
             club_id = $7,
             team_id = $8
         where id = $1
         returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
        [req.params.athleteId, athleteId, firstName, lastName, fullName, clean(req.body?.imageUrl), clubId, teamId],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Athlete not found." });
      }
      // Editing the club/team fields here only ever ADDS an active
      // membership (an athlete may hold several at once) - it never
      // archives whatever was there before. Use the dedicated team/club
      // archive endpoints to end a specific membership.
      if (clubId) await ensureActiveMembership(client, req.params.athleteId, clubId, null, "club", req.user.id);
      if (teamId) await ensureActiveMembership(client, req.params.athleteId, clubId, teamId, "team", req.user.id);
      await client.query("commit");
      res.json({ athlete: result.rows[0] });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId/library-access", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const access = await saveAthleteLibraryAccess(req.params.athleteId, req.user.id, req.body || {});
    res.json({ access });
  } catch (error) {
    next(error);
  }
});

router.put("/athlete-library-access/bulk", async (req, res, next) => {
  try {
    const athleteIds = Array.isArray(req.body?.athleteIds) ? req.body.athleteIds.map(clean).filter(Boolean) : [];
    if (!athleteIds.length) return res.status(400).json({ error: "Choose at least one athlete." });
    if (athleteIds.length > 200) return res.status(400).json({ error: "Too many athletes in one update." });

    const patch = req.body?.patch && typeof req.body.patch === "object" ? req.body.patch : {};
    const changed = [];
    for (const athleteId of athleteIds) {
      if (!(await canManageAthlete(req, athleteId))) return res.status(403).json({ error: "One or more athletes are outside your access." });
      changed.push(await saveAthleteLibraryAccess(athleteId, req.user.id, patch, { partial: true }));
    }
    res.json({ updated: changed });
  } catch (error) {
    next(error);
  }
});

router.post("/teams/:teamId/athletes", async (req, res, next) => {
  try {
    const teamId = clean(req.params.teamId);
    const athleteId = clean(req.body?.athleteId);
    if (!teamId || !athleteId) return res.status(400).json({ error: "Team and athlete are required." });
    if (!(await canManageTeam(req, teamId))) return res.status(403).json({ error: "Team is outside your access." });
    if (!(await canManageAthlete(req, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const team = await query(`select id, club_id from public.teams where id = $1 and coalesce(is_active, true) limit 1`, [teamId]);
    if (!team.rows[0]) return res.status(404).json({ error: "Team not found." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Adds an active membership rather than overwriting - an athlete may
      // already have other active club/team memberships, and this simply
      // adds one more (including a second team within the same club).
      await ensureActiveMembership(client, athleteId, team.rows[0].club_id, null, "club", req.user.id);
      await ensureActiveMembership(client, athleteId, team.rows[0].club_id, teamId, "team", req.user.id);
      const result = await client.query(
        `update public.athletes
         set club_id = $2, team_id = $3
         where id = $1
         returning id, athlete_id, source_external_id, full_name, display_name, image_url, club_id, team_id`,
        [athleteId, team.rows[0].club_id, teamId],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "Athlete not found." });
      }
      await client.query("commit");
      res.json({ athlete: result.rows[0] });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.post("/athlete-invites", async (req, res, next) => {
  try {
    const athleteId = clean(req.body?.athleteId);
    const email = clean(req.body?.email).toLowerCase();
    if (!athleteId || !email) return res.status(400).json({ error: "Athlete and email are required." });
    if (!(await canManageAthlete(req, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
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
    if (!(await canManageAthlete(req, request.athlete_id))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `update library.program_access
       set status = 'accessed',
           starts_at = coalesce(starts_at, now()),
           updated_at = now()
       where id = $1
       returning id, status, updated_at`,
      [req.params.accessId],
    );
    if (result.rows[0]) await notifyProgramAccessDecision(request, req.user, "approved");
    res.json({ access: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/program-access/bulk", async (req, res, next) => {
  try {
    const action = clean(req.body?.action);
    const accessIds = Array.isArray(req.body?.accessIds) ? req.body.accessIds.map((id) => clean(id)).filter(Boolean) : [];
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Invalid access action." });
    if (!accessIds.length) return res.status(400).json({ error: "Select at least one access request." });
    if (accessIds.length > 100) return res.status(400).json({ error: "Too many requests selected." });

    const updated = [];
    const skipped = [];

    for (const accessId of accessIds) {
      const request = await loadProgramAccessRequest(accessId);
      if (!request) {
        skipped.push({ id: accessId, reason: "not_found" });
        continue;
      }
      if (request.status !== "requested") {
        skipped.push({ id: accessId, reason: "not_pending" });
        continue;
      }
      if (!(await canManageAthlete(req, request.athlete_id))) {
        skipped.push({ id: accessId, reason: "forbidden" });
        continue;
      }

      const result = await query(
        action === "approve"
          ? `update library.program_access
             set status = 'accessed',
                 starts_at = coalesce(starts_at, now()),
                 updated_at = now()
             where id = $1
               and status = 'requested'
             returning id, status, updated_at`
          : `update library.program_access
             set status = 'rejected',
                 updated_at = now()
             where id = $1
               and status = 'requested'
             returning id, status, updated_at`,
        [accessId],
      );
      if (result.rows[0]) {
        updated.push(result.rows[0]);
        await notifyProgramAccessDecision(request, req.user, action === "approve" ? "approved" : "rejected");
      }
      else skipped.push({ id: accessId, reason: "not_pending" });
    }

    res.json({ updated, skipped });
  } catch (error) {
    next(error);
  }
});

router.post("/program-access/:accessId/reject", async (req, res, next) => {
  try {
    const request = await loadProgramAccessRequest(req.params.accessId);
    if (!request) return res.status(404).json({ error: "Access request not found." });
    if (!(await canManageAthlete(req, request.athlete_id))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `update library.program_access
       set status = 'rejected',
           updated_at = now()
       where id = $1
       returning id, status, updated_at`,
      [req.params.accessId],
    );
    if (result.rows[0]) await notifyProgramAccessDecision(request, req.user, "rejected");
    res.json({ access: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/program-access/:accessId/revoke", async (req, res, next) => {
  try {
    const request = await loadProgramAccessRequest(req.params.accessId);
    if (!request) return res.status(404).json({ error: "Program access not found." });
    if (!(await canManageAthlete(req, request.athlete_id))) return res.status(403).json({ error: "Athlete is outside your access." });
    const result = await query(
      `delete from library.program_access
       where id = $1
       returning id, status, updated_at`,
      [req.params.accessId],
    );
    res.json({ access: result.rows[0], removed: true });
  } catch (error) {
    next(error);
  }
});

// Archives the whole sporting PROFILE (athletes.is_active) - not any one
// relationship. This used to be a bare DELETE any manager could call to
// "remove an athlete from my list", which actually killed the profile for
// every coach/team/club at once. It is now explicitly named and restricted
// to a platform admin; a private coach, team coach, or club admin who wants
// to end THEIR OWN relationship must use the coach-relationship, team, or
// club membership endpoints below instead - those never touch this flag.
router.delete("/athletes/:athleteId/archive-profile", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only a platform admin can archive an athlete's whole profile." });
    const result = await query(
      `update public.athletes set is_active = false, updated_at = now() where id = $1 returning id`,
      [req.params.athleteId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId/restore-profile", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only a platform admin can restore an athlete's whole profile." });
    const result = await query(
      `update public.athletes set is_active = true, updated_at = now() where id = $1 returning id`,
      [req.params.athleteId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Archives ONLY the caller's own private-coach relationship (user_athletes,
// relationship_type='coach') - never someone else's. A coach can never
// archive another coach's relationship through this endpoint since it's
// always scoped to req.user.id. Does not touch athletes.is_active,
// athlete_memberships, users.is_active, or sessions.
router.delete("/athletes/:athleteId/coach-relationship", async (req, res, next) => {
  try {
    const result = await query(
      `update public.user_athletes
       set is_active = false, updated_at = now()
       where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true
       returning id`,
      [req.user.id, req.params.athleteId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "You don't have an active private-coach relationship with this athlete." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId/coach-relationship/restore", async (req, res, next) => {
  try {
    const result = await query(
      `update public.user_athletes
       set is_active = true, updated_at = now()
       where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = false
       returning id`,
      [req.user.id, req.params.athleteId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "No archived private-coach relationship with this athlete was found." });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Archives ONLY this athlete's membership in this one team - other team
// memberships, club memberships, private-coach relationships, the sporting
// profile, and the login are all untouched.
router.delete("/teams/:teamId/athletes/:athleteId", async (req, res, next) => {
  try {
    if (!(await canManageTeam(req, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update public.athlete_memberships
         set status = 'archived', archived_at = now(), archived_by_user_id = $1, archive_reason = $2, updated_at = now()
         where athlete_id = $3 and team_id = $4 and membership_type = 'team' and status = 'active'
         returning id`,
        [req.user.id, clean(req.body?.reason) || null, req.params.athleteId, req.params.teamId],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "This athlete has no active membership in this team." });
      }
      await syncLegacyAthletePointer(req.params.athleteId, client);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.put("/teams/:teamId/athletes/:athleteId/restore", async (req, res, next) => {
  try {
    if (!(await canManageTeam(req, req.params.teamId))) return res.status(403).json({ error: "Team is outside your access." });
    const team = await query(`select id, club_id from public.teams where id = $1 limit 1`, [req.params.teamId]);
    if (!team.rows[0]) return res.status(404).json({ error: "Team not found." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Lock the ONE row for this (athlete, team) identity, regardless of
      // its current status, then branch after the lock is held - not two
      // separate status-filtered SELECTs. That matters under concurrency:
      // if this query blocked waiting for another restore's lock on the
      // very same row, once that lock is released it re-reads the row's
      // now-current status rather than the stale "still archived" snapshot,
      // so a second concurrent restore converges on "already active" (200)
      // instead of finding nothing to restore (a spurious 404).
      const membership = await client.query(
        `select id, status from public.athlete_memberships
         where athlete_id = $1 and team_id = $2 and membership_type = 'team'
         order by updated_at desc, created_at desc
         limit 1
         for update`,
        [req.params.athleteId, req.params.teamId],
      );
      if (!membership.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "No membership in this team was found." });
      }
      if (membership.rows[0].status === "active") {
        await client.query("commit");
        return res.json({ ok: true, alreadyActive: true });
      }
      await client.query(
        `update public.athlete_memberships
         set status = 'active', archived_at = null, archived_by_user_id = null, archive_reason = null, updated_at = now()
         where id = $1`,
        [membership.rows[0].id],
      );
      // A restored team membership must always have a club membership behind
      // it too - create/reactivate one if it was archived or never existed.
      await ensureActiveMembership(client, req.params.athleteId, team.rows[0].club_id, null, "club", req.user.id);
      await syncLegacyAthletePointer(req.params.athleteId, client);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Archives this athlete's club membership AND, transactionally, every
// currently active TEAM membership of theirs that belongs to THIS club only
// - other clubs, their teams, private-coach relationships, the profile, and
// the login are untouched.
router.delete("/clubs/:clubId/athletes/:athleteId", async (req, res, next) => {
  try {
    if (!(await canManageClub(req, req.params.clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const reason = clean(req.body?.reason) || null;
      const clubMembership = await client.query(
        `update public.athlete_memberships
         set status = 'archived', archived_at = now(), archived_by_user_id = $1, archive_reason = $2, updated_at = now()
         where athlete_id = $3 and club_id = $4 and membership_type = 'club' and status = 'active'
         returning id`,
        [req.user.id, reason, req.params.athleteId, req.params.clubId],
      );
      if (!clubMembership.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "This athlete has no active membership in this club." });
      }
      await client.query(
        `update public.athlete_memberships
         set status = 'archived', archived_at = now(), archived_by_user_id = $1, archive_reason = $2, updated_at = now()
         where athlete_id = $3 and club_id = $4 and membership_type = 'team' and status = 'active'`,
        [req.user.id, reason, req.params.athleteId, req.params.clubId],
      );
      await syncLegacyAthletePointer(req.params.athleteId, client);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Club-level restore only - it does NOT auto-restore team memberships that
// were cascaded when the club membership was archived (a coach may have
// separately, deliberately archived one of those team memberships for their
// own reason); restore those individually via the team endpoint above.
router.put("/clubs/:clubId/athletes/:athleteId/restore", async (req, res, next) => {
  try {
    if (!(await canManageClub(req, req.params.clubId))) return res.status(403).json({ error: "Club is outside your access." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Lock the ONE row for this (athlete, club) identity, regardless of
      // its current status, then branch after the lock is held - see the
      // matching comment on the team restore endpoint for why this is
      // safer under concurrency than two separate status-filtered SELECTs.
      const membership = await client.query(
        `select id, status from public.athlete_memberships
         where athlete_id = $1 and club_id = $2 and membership_type = 'club'
         order by updated_at desc, created_at desc
         limit 1
         for update`,
        [req.params.athleteId, req.params.clubId],
      );
      if (!membership.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "No membership in this club was found." });
      }
      if (membership.rows[0].status === "active") {
        await client.query("commit");
        return res.json({ ok: true, alreadyActive: true });
      }
      await client.query(
        `update public.athlete_memberships
         set status = 'active', archived_at = null, archived_by_user_id = null, archive_reason = null, updated_at = now()
         where id = $1`,
        [membership.rows[0].id],
      );
      await syncLegacyAthletePointer(req.params.athleteId, client);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.put("/athletes/:athleteId/login-status", async (req, res, next) => {
  try {
    if (!(await canManageAthlete(req, req.params.athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    const active = Boolean(req.body?.active);
    // Whether this athlete "has a login" comes from athletes.user_id itself,
    // not the linked account's role_hint - a multi-role account (e.g.
    // role_hint="coach" who is also, genuinely, this athlete) must still be
    // recognized.
    const athlete = await query(
      `select a.user_id from public.athletes a where a.id = $1 limit 1`,
      [req.params.athleteId],
    );
    if (!athlete.rows[0]) return res.status(404).json({ error: "Athlete not found." });
    if (!athlete.rows[0].user_id) {
      return res.status(400).json({ error: "This athlete has no login to update." });
    }

    const targetUserId = athlete.rows[0].user_id;
    const targetUser = await query(`select id, role_hint from public.users where id = $1 limit 1`, [targetUserId]);
    if (!targetUser.rows[0]) return res.status(400).json({ error: "This athlete has no login to update." });

    // This control toggles users.is_active - a GLOBAL account flag, not
    // something scoped to "athlete access". If the linked account also holds
    // any real coach/admin capability (platform, club, team, or independent
    // coach - regardless of who is making this request, including a
    // platform admin), flipping it here would silently kill their staff
    // access too. That is never this endpoint's job; a dedicated, audited
    // account-suspension tool is the right place for that later.
    const targetAuthz = await loadAuthorizationContext(targetUser.rows[0]);
    const targetHasStaffCapability = targetAuthz.platformRoles.length > 0
      || targetAuthz.clubRoles.length > 0
      || targetAuthz.teamRoles.length > 0
      || targetAuthz.isIndependentCoach;
    if (targetHasStaffCapability) {
      return res.status(409).json({
        error: "MULTI_ROLE_ACCOUNT",
        message: "This user also has coach or administrator access. Their whole account cannot be disabled from the athlete login control.",
      });
    }

    const result = await query(
      `update public.users set is_active = $2, updated_at = now() where id = $1 returning id, is_active`,
      [targetUserId, active],
    );
    if (!active) await destroySessionsForUser(targetUserId);
    res.json({ ok: true, active: result.rows[0]?.is_active });
  } catch (error) {
    next(error);
  }
});

router.post("/club-roles", async (req, res, next) => {
  try {
    const userId = clean(req.body?.userId);
    const clubId = clean(req.body?.clubId);
    if (!userId || !clubId) return res.status(400).json({ error: "User and club are required." });
    if (!(await canManageClub(req, clubId))) return res.status(403).json({ error: "Club is outside your access." });
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
    if (!(await canManageTeam(req, teamId))) return res.status(403).json({ error: "Team is outside your access." });
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

// Manual athlete login lets an authenticated coach/admin type a password on
// an athlete's behalf, but that trust only ever covers CREATING a brand-new
// account - it must never be usable to reset the password of an account
// that already exists, no matter whose it is or how the coach found the
// email. There is deliberately no platform-admin bypass for this rule: a
// safe, explicit password-reset process is a separate future feature, not
// this endpoint.
router.post("/athlete-logins", async (req, res, next) => {
  try {
    const athleteId = clean(req.body?.athleteId);
    const email = clean(req.body?.email).toLowerCase();
    const password = String(req.body?.password || "");
    if (!athleteId || !email || !password) return res.status(400).json({ error: "Athlete, email, and password are required." });
    if (!(await canManageAthlete(req, athleteId))) return res.status(403).json({ error: "Athlete is outside your access." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const athlete = await query(
      `select a.id, a.user_id, coalesce(a.display_name, a.full_name, a.athlete_id) as name
       from public.athletes a
       where a.id = $1
       limit 1`,
      [athleteId],
    );
    if (!athlete.rows[0]) return res.status(404).json({ error: "Athlete not found." });

    // Trust athletes.user_id directly (not the linked account's role_hint),
    // so a multi-role account (e.g. role_hint="coach" who is also, genuinely,
    // this athlete) is still recognized as already linked.
    const currentUserId = athlete.rows[0].user_id || null;
    if (currentUserId) {
      return res.status(409).json({
        error: "This athlete already has a login. This form can no longer reset an existing password - they need to log in directly, or use a dedicated password reset process.",
        requiresLogin: true,
      });
    }

    const emailOwner = await query(`select id from public.users where lower(email) = lower($1) limit 1`, [email]);
    if (emailOwner.rows[0]) {
      return res.status(409).json({
        error: "An account with this email already exists. That user must log in and link this athlete profile themselves via the invite/link process - this form cannot set a password for an existing account.",
        requiresLogin: true,
      });
    }

    const nameParts = splitName(athlete.rows[0].name || email);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, created_by_user_id, is_active)
         values ($1, $2, $3, $4, $5, $5, 'athlete', $6, true)
         returning id, email`,
        [email, nameParts.firstName, nameParts.lastName, hashPassword(password), athlete.rows[0].name, req.user.id],
      );
      await client.query(`update public.athletes set user_id = $2 where id = $1`, [athleteId, inserted.rows[0].id]);
      await client.query(
        `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
         values ($1, $2, 'athlete', true)
         on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
        [inserted.rows[0].id, athleteId],
      );
      await client.query("commit");
      res.status(201).json({ user: inserted.rows[0] });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      if (error?.code === "23505") return res.status(409).json({ error: "An account with this email already exists.", requiresLogin: true });
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Branches on the user's REAL scoped roles (req.authz), not role_hint - a
// role_hint of "athlete" must not hide clubs/teams this account genuinely
// administers via an actual user_club_roles/user_team_roles row, and a
// role_hint that merely says "club_admin" with no such row must not see
// every club either.
async function loadClubs(req) {
  const authz = req.authz;
  if (isPlatformAdministrator(authz)) {
    const result = await query(
      `select id, name, short_name, logo_url, city, country
       from public.clubs
       where coalesce(is_active, true)
       order by name`,
    );
    return result.rows;
  }
  if (authz.clubRoles.length) {
    const result = await query(
      `select c.id, c.name, c.short_name, c.logo_url, c.city, c.country
       from public.user_club_roles ucr
       join public.clubs c on c.id = ucr.club_id
       where ucr.user_id = $1 and ucr.is_active = true and coalesce(c.is_active, true)
       order by c.name`,
      [req.user.id],
    );
    return result.rows;
  }
  if (authz.teamRoles.length) {
    const result = await query(
      `select distinct c.id, c.name, c.short_name, c.logo_url, c.city, c.country
       from public.user_team_roles utr
       join public.teams t on t.id = utr.team_id
       join public.clubs c on c.id = t.club_id
       where utr.user_id = $1 and utr.is_active = true and coalesce(c.is_active, true)
       order by c.name`,
      [req.user.id],
    );
    return result.rows;
  }
  return [];
}

async function loadTeams(req) {
  const authz = req.authz;
  if (isPlatformAdministrator(authz)) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.teams t
       left join public.clubs c on c.id = t.club_id
       where coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
    );
    return result.rows;
  }
  if (authz.clubRoles.length) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.user_club_roles ucr
       join public.teams t on t.club_id = ucr.club_id
       left join public.clubs c on c.id = t.club_id
       where ucr.user_id = $1 and ucr.is_active = true and coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
      [req.user.id],
    );
    return result.rows;
  }
  if (authz.teamRoles.length) {
    const result = await query(
      `select t.id, t.club_id, t.name, t.short_name, t.logo_url, c.name as club_name
       from public.user_team_roles utr
       join public.teams t on t.id = utr.team_id
       left join public.clubs c on c.id = t.club_id
       where utr.user_id = $1 and utr.is_active = true and coalesce(t.is_active, true)
       order by c.name nulls last, t.name`,
      [req.user.id],
    );
    return result.rows;
  }
  return [];
}

async function loadUsers(req) {
  const result = await query(
    `select distinct u.id, u.email, coalesce(u.display_name, u.full_name, u.email) as name, u.role_hint
     from public.users u
     where u.is_active = true
       and (
         u.role_hint <> 'athlete'
         or exists (select 1 from public.user_club_roles ucr2 where ucr2.user_id = u.id and ucr2.is_active = true)
         or exists (select 1 from public.user_team_roles utr2 where utr2.user_id = u.id and utr2.is_active = true)
       )
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
    [req.user.id, isPlatformAdministrator(req.authz)],
  );
  return result.rows;
}

async function loadProgramAccessRequests(user) {
  const result = await query(
    `select
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
     join lateral (
       select athlete.*
       from public.athletes athlete
       where athlete.user_id = pa.user_id
          or exists (
          select 1
          from public.user_athletes ua
          where ua.user_id = pa.user_id
            and ua.athlete_id = athlete.id
            and ua.relationship_type = 'athlete'
            and ua.is_active = true
          )
       order by case when athlete.user_id = pa.user_id then 0 else 1 end,
                athlete.updated_at desc nulls last,
                athlete.created_at desc nulls last
       limit 1
     ) a on true
     where pa.status in ('requested', 'rejected', 'accessed', 'used', 'completed')
       and coalesce(a.is_active, true)
     order by
       case pa.status
         when 'requested' then 0
         when 'accessed' then 1
         when 'used' then 2
         when 'completed' then 3
         when 'rejected' then 4
         else 5
       end,
       pa.updated_at desc,
       pa.created_at desc
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
       coalesce(p.name, 'Program') as program_name,
       a.id as athlete_id
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
     where pa.id = $1
     limit 1`,
    [accessId],
  );
  return result.rows[0] || null;
}

async function notifyProgramAccessDecision(request, actor, decision) {
  await createNotification({
    recipientUserId: request.user_id,
    actorUserId: actor?.id || null,
    type: decision === "approved" ? "program_access_approved" : "program_access_rejected",
    title: decision === "approved" ? "Program approved" : "Program request rejected",
    body: decision === "approved"
      ? `${request.program_name || "Program"} is now available.`
      : `${request.program_name || "Program"} was not approved.`,
    entityType: "program_access",
    entityId: request.id,
    href: "/athlete",
    metadata: { planId: request.plan_id, status: decision },
  });
}

async function loadManagedAthletes(req) {
  const result = await query(
    `select
       a.id, a.athlete_id, a.source_external_id,
       coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.athlete_id) as name,
       a.image_url, coalesce(a.is_active, true) as is_active,
       -- Legacy "primary" pointer only - informational display fallback,
       -- never authoritative. An athlete can hold several active club/team
       -- memberships at once; see the memberships array below for the real,
       -- current relationship set (used by team/club-scoped views and by
       -- the archive/restore actions to know exactly which relationship is
       -- being changed).
       a.club_id, c.name as club_name, a.team_id, t.name as team_name, a.user_id,
       case when a.user_id is null then null else coalesce(u.is_active, false) end as login_active,
       coalesce(memberships.data, '[]'::json) as memberships,
       exists (
         select 1 from public.user_athletes ua_mine
         where ua_mine.user_id = $1 and ua_mine.athlete_id = a.id and ua_mine.relationship_type = 'coach' and ua_mine.is_active = true
       ) as has_my_active_coach_relationship,
       exists (
         select 1 from public.user_athletes ua_mine_archived
         where ua_mine_archived.user_id = $1 and ua_mine_archived.athlete_id = a.id and ua_mine_archived.relationship_type = 'coach' and ua_mine_archived.is_active = false
       ) as has_my_archived_coach_relationship,
       -- True when the linked account also holds any real staff/coach/admin
       -- capability, so the frontend can show a locked "multi-role" state
       -- instead of a plain toggle (see PUT /athletes/:id/login-status,
       -- which independently re-checks this server-side regardless of what
       -- the client renders). Role_hint list here mirrors access.js's
       -- PLATFORM_ROLES + CLUB_ROLES + TEAM_ROLES + COACH_ROLES sets.
       case when a.user_id is null then false else (
         coalesce(u.role_hint, '') in (
           'admin', 'platform_admin', 'general_admin',
           'club_admin', 'club_manager',
           'team_admin', 'team_coach', 'team_trainer',
           'coach', 'independent_coach', 'fitness_coach', 'trainer'
         )
         or exists (select 1 from public.user_club_roles ucr4 where ucr4.user_id = a.user_id and ucr4.is_active = true)
         or exists (select 1 from public.user_team_roles utr4 where utr4.user_id = a.user_id and utr4.is_active = true)
       ) end as login_is_multi_role,
       coalesce(ala.can_view_coach_library, true) as can_view_coach_library,
       coalesce(ala.can_view_team_library, false) as can_view_team_library,
       coalesce(ala.can_view_club_library, false) as can_view_club_library,
       coalesce(ala.can_view_optimove_library, false) as can_view_optimove_library,
       coalesce(ala.can_view_marketplace, false) as can_view_marketplace,
       coalesce(ala.can_view_coach_profiles, true) as can_view_coach_profiles,
       coalesce(ala.can_view_club_coach_profiles, false) as can_view_club_coach_profiles,
       coalesce(ala.can_view_public_coach_profiles, false) as can_view_public_coach_profiles,
       coalesce(ala.can_contact_visible_coaches, true) as can_contact_visible_coaches,
       coalesce(ala.can_view_assigned_exercises, true) as can_view_assigned_exercises,
       coalesce(ala.can_view_coach_exercise_library, false) as can_view_coach_exercise_library,
       coalesce(ala.can_view_team_exercise_library, false) as can_view_team_exercise_library,
       coalesce(ala.can_view_club_exercise_library, false) as can_view_club_exercise_library,
       coalesce(ala.can_view_optimove_exercise_library, false) as can_view_optimove_exercise_library,
       coalesce(ala.can_view_exercise_groups, false) as can_view_exercise_groups,
       coalesce(ala.free_only, true) as free_only,
       coalesce(ala.require_approval, true) as require_approval,
       coalesce(ala.selected_programs_only, false) as selected_programs_only
     from public.athletes a
     left join public.clubs c on c.id = a.club_id
     left join public.teams t on t.id = a.team_id
     left join public.users u on u.id = a.user_id
     left join public.athlete_library_access ala on ala.athlete_id = a.id
     left join lateral (
       select json_agg(json_build_object(
         'id', m.id,
         'membershipType', m.membership_type,
         'status', m.status,
         'clubId', m.club_id,
         'clubName', mc.name,
         'teamId', m.team_id,
         'teamName', mt.name,
         'archivedAt', m.archived_at,
         'archiveReason', m.archive_reason
       ) order by m.membership_type, mc.name, mt.name) as data
       from public.athlete_memberships m
       left join public.clubs mc on mc.id = m.club_id
       left join public.teams mt on mt.id = m.team_id
       where m.athlete_id = a.id
     ) memberships on true
     where (
         $2::boolean
         or a.user_id = $1
         or exists (select 1 from public.user_athletes ua where ua.user_id = $1 and ua.athlete_id = a.id and ua.is_active = true)
         or exists (
           select 1
           from public.user_team_roles utr
           join public.athlete_memberships tm
             on tm.team_id = utr.team_id and tm.membership_type = 'team' and tm.status = 'active'
           where utr.user_id = $1 and utr.is_active = true and tm.athlete_id = a.id
         )
         or exists (
           select 1
           from public.user_club_roles ucr
           join public.athlete_memberships cm
             on cm.club_id = ucr.club_id and cm.membership_type = 'club' and cm.status = 'active'
           where ucr.user_id = $1 and ucr.is_active = true and cm.athlete_id = a.id
         )
         -- Also surface a row whose only remaining tie to this viewer is an
         -- ARCHIVED relationship they still own/manage, so "Show archived"
         -- has something to render and Restore has something to act on.
         -- This is visibility only - it never implies active access; every
         -- write endpoint (canManageAthlete, canManageTeam, canManageClub)
         -- independently re-checks against ACTIVE rows only.
         or exists (
           select 1 from public.user_athletes ua_archived
           where ua_archived.user_id = $1 and ua_archived.athlete_id = a.id and ua_archived.relationship_type = 'coach' and ua_archived.is_active = false
         )
         or exists (
           select 1
           from public.user_team_roles utr_archived
           join public.athlete_memberships tm_archived
             on tm_archived.team_id = utr_archived.team_id and tm_archived.membership_type = 'team' and tm_archived.status = 'archived'
           where utr_archived.user_id = $1 and utr_archived.is_active = true and tm_archived.athlete_id = a.id
         )
         or exists (
           select 1
           from public.user_club_roles ucr_archived
           join public.athlete_memberships cm_archived
             on cm_archived.club_id = ucr_archived.club_id and cm_archived.membership_type = 'club' and cm_archived.status = 'archived'
           where ucr_archived.user_id = $1 and ucr_archived.is_active = true and cm_archived.athlete_id = a.id
         )
       )
     order by nullif(regexp_replace(coalesce(a.source_external_id, a.athlete_id), '\\D', '', 'g'), '')::int nulls last,
              name`,
    [req.user.id, isPlatformAdministrator(req.authz)],
  );
  return result.rows;
}

async function saveAthleteLibraryAccess(athleteId, managedByUserId, body, { partial = false } = {}) {
  const current = partial
    ? (await query(`select * from public.athlete_library_access where athlete_id = $1 limit 1`, [athleteId])).rows[0] || {}
    : {};
  const value = (bodyKey, dbKey, fallback) => (partial && body[bodyKey] === undefined ? bool(current[dbKey], fallback) : bool(body[bodyKey], fallback));
  const result = await query(
    `insert into public.athlete_library_access (
       athlete_id,
       managed_by_user_id,
       can_view_coach_library,
       can_view_team_library,
       can_view_club_library,
       can_view_optimove_library,
       can_view_marketplace,
       can_view_coach_profiles,
       can_view_club_coach_profiles,
       can_view_public_coach_profiles,
       can_contact_visible_coaches,
       can_view_assigned_exercises,
       can_view_coach_exercise_library,
       can_view_team_exercise_library,
       can_view_club_exercise_library,
       can_view_optimove_exercise_library,
       can_view_exercise_groups,
       free_only,
       require_approval,
       selected_programs_only
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     on conflict (athlete_id) do update set
       managed_by_user_id = excluded.managed_by_user_id,
       can_view_coach_library = excluded.can_view_coach_library,
       can_view_team_library = excluded.can_view_team_library,
       can_view_club_library = excluded.can_view_club_library,
       can_view_optimove_library = excluded.can_view_optimove_library,
       can_view_marketplace = excluded.can_view_marketplace,
       can_view_coach_profiles = excluded.can_view_coach_profiles,
       can_view_club_coach_profiles = excluded.can_view_club_coach_profiles,
       can_view_public_coach_profiles = excluded.can_view_public_coach_profiles,
       can_contact_visible_coaches = excluded.can_contact_visible_coaches,
       can_view_assigned_exercises = excluded.can_view_assigned_exercises,
       can_view_coach_exercise_library = excluded.can_view_coach_exercise_library,
       can_view_team_exercise_library = excluded.can_view_team_exercise_library,
       can_view_club_exercise_library = excluded.can_view_club_exercise_library,
       can_view_optimove_exercise_library = excluded.can_view_optimove_exercise_library,
       can_view_exercise_groups = excluded.can_view_exercise_groups,
       free_only = excluded.free_only,
       require_approval = excluded.require_approval,
       selected_programs_only = excluded.selected_programs_only,
       updated_at = now()
     returning athlete_id, can_view_coach_library, can_view_team_library, can_view_club_library, can_view_optimove_library,
       can_view_marketplace, can_view_coach_profiles, can_view_club_coach_profiles,
       can_view_public_coach_profiles, can_contact_visible_coaches, can_view_assigned_exercises,
       can_view_coach_exercise_library, can_view_team_exercise_library, can_view_club_exercise_library, can_view_optimove_exercise_library,
       can_view_exercise_groups, free_only, require_approval, selected_programs_only`,
    [
      athleteId,
      managedByUserId,
      value("canViewCoachLibrary", "can_view_coach_library", true),
      value("canViewTeamLibrary", "can_view_team_library", false),
      value("canViewClubLibrary", "can_view_club_library", false),
      value("canViewOptimoveLibrary", "can_view_optimove_library", false),
      value("canViewMarketplace", "can_view_marketplace", false),
      value("canViewCoachProfiles", "can_view_coach_profiles", true),
      value("canViewClubCoachProfiles", "can_view_club_coach_profiles", false),
      value("canViewPublicCoachProfiles", "can_view_public_coach_profiles", false),
      value("canContactVisibleCoaches", "can_contact_visible_coaches", true),
      value("canViewAssignedExercises", "can_view_assigned_exercises", true),
      value("canViewCoachExerciseLibrary", "can_view_coach_exercise_library", false),
      value("canViewTeamExerciseLibrary", "can_view_team_exercise_library", false),
      value("canViewClubExerciseLibrary", "can_view_club_exercise_library", false),
      value("canViewOptimoveExerciseLibrary", "can_view_optimove_exercise_library", false),
      value("canViewExerciseGroups", "can_view_exercise_groups", false),
      value("freeOnly", "free_only", true),
      value("requireApproval", "require_approval", true),
      value("selectedProgramsOnly", "selected_programs_only", false),
    ],
  );
  return result.rows[0];
}

// Platform/club/team scope comes from req.authz (loaded once per request by
// attachAuthorizationContext) - no re-querying user_club_roles/user_team_roles
// here. Athlete-level access still needs one targeted query since a specific
// athlete's own club/team isn't preloaded for every request.
// Uses athlete_memberships (active rows only) for club/team scope, never the
// legacy athletes.club_id/team_id pointer - an athlete can hold several
// active club/team memberships at once, and an archived membership must
// never grant management access again.
async function canManageAthlete(req, athleteId) {
  if (isPlatformAdministrator(req.authz)) return true;
  const result = await query(
    `select 1
     from public.athletes a
     where a.id = $2
       and (
         a.user_id = $1
         or exists (select 1 from public.user_athletes ua where ua.user_id = $1 and ua.athlete_id = a.id and ua.is_active = true)
         or exists (
           select 1
           from public.user_team_roles utr
           join public.athlete_memberships tm
             on tm.team_id = utr.team_id and tm.membership_type = 'team' and tm.status = 'active'
           where utr.user_id = $1 and utr.is_active = true and tm.athlete_id = a.id
         )
         or exists (
           select 1
           from public.user_club_roles ucr
           join public.athlete_memberships cm
             on cm.club_id = ucr.club_id and cm.membership_type = 'club' and cm.status = 'active'
           where ucr.user_id = $1 and ucr.is_active = true and cm.athlete_id = a.id
         )
       )
     limit 1`,
    [req.user.id, athleteId],
  );
  return result.rowCount > 0;
}

function canManageClub(req, clubId) {
  return authzCanManageClub(req.authz, clubId);
}

function canManageTeam(req, teamId) {
  return authzCanManageTeam(req.authz, teamId);
}


// Takes the full req (not req.user) - canManageClub/canManageTeam read
// req.authz, loaded once per request by attachAuthorizationContext. This
// previously took req.user by mistake, which meant req.authz was undefined
// inside those checks and any create/edit athlete request that actually
// supplied a clubId or teamId crashed with a 500 (found while touching this
// code for Phase 3's membership changes; fixed here since it's the same line).
async function resolveAthleteClubTeam(req, requestedClubId, requestedTeamId) {
  let clubId = clean(requestedClubId) || null;
  const teamId = clean(requestedTeamId) || null;
  if (clubId && !(await canManageClub(req, clubId))) {
    const error = new Error("Club is outside your access.");
    error.status = 403;
    throw error;
  }
  if (!teamId) return { clubId, teamId: null };
  if (!(await canManageTeam(req, teamId))) {
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

// Creates a new active athlete_memberships row unless an identical active one
// already exists (an athlete may hold several DIFFERENT active club/team
// memberships at once - this only guards against an exact duplicate, per the
// partial unique indexes in the athlete_memberships migration). teamId is
// null for a club-only membership.
// A (athlete, club, team, membership_type) combination identifies ONE
// membership across its whole lifecycle - reactivating it always reuses the
// same row (status flips active <-> archived) instead of inserting a new
// one. Inserting a fresh row every time an archived membership was re-added
// used to leave several archived rows behind after repeated
// archive/add/archive cycles, which then made a later "restore" (a single
// UPDATE ... WHERE status = 'archived') match more than one row at once and
// collide with the partial unique "one active row" index.
// Must be called with a real client already inside a transaction (this
// function takes a row lock via FOR UPDATE, which only holds meaningfully
// inside an explicit transaction) - never a bare pool/query.
async function ensureActiveMembership(client, athleteId, clubId, teamId, membershipType, createdByUserId) {
  const existing = await client.query(
    `select id, status from public.athlete_memberships
     where athlete_id = $1 and club_id = $2 and membership_type = $3
       and team_id is not distinct from $4
     order by created_at desc
     limit 1
     for update`,
    [athleteId, clubId, membershipType, teamId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status !== "active") {
      await client.query(
        `update public.athlete_memberships
         set status = 'active', archived_at = null, archived_by_user_id = null, archive_reason = null, updated_at = now()
         where id = $1`,
        [existing.rows[0].id],
      );
    }
    return existing.rows[0].id;
  }
  const inserted = await client.query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, created_by_user_id)
     values ($1, $2, $3, $4, 'active', $5)
     returning id`,
    [athleteId, clubId, teamId, membershipType, createdByUserId],
  );
  return inserted.rows[0].id;
}

// Re-points the legacy athletes.club_id/team_id "primary" pointer only when
// it has gone stale (no longer matches any of the athlete's remaining active
// memberships of that type) - archiving or restoring a membership never
// churns the pointer if it's still valid. Deterministic choice when a nudge
// IS needed: the most recently created remaining active membership, or NULL
// if none remain. Authorization never reads this pointer (see
// athleteAccessPredicate/canManageAthlete/loadManagedAthletes) - it exists
// only for old call sites and simple display.
async function syncLegacyAthletePointer(athleteId, client = { query }) {
  await client.query(
    `update public.athletes a
     set club_id = (
       select m.club_id from public.athlete_memberships m
       where m.athlete_id = a.id and m.membership_type = 'club' and m.status = 'active'
       order by m.created_at desc, m.id desc limit 1
     ),
     updated_at = now()
     where a.id = $1
       and (
         a.club_id is null
         or not exists (
           select 1 from public.athlete_memberships m2
           where m2.athlete_id = a.id and m2.membership_type = 'club' and m2.status = 'active' and m2.club_id = a.club_id
         )
       )`,
    [athleteId],
  );
  await client.query(
    `update public.athletes a
     set team_id = (
       select m.team_id from public.athlete_memberships m
       where m.athlete_id = a.id and m.membership_type = 'team' and m.status = 'active'
       order by m.created_at desc, m.id desc limit 1
     ),
     updated_at = now()
     where a.id = $1
       and (
         a.team_id is null
         or not exists (
           select 1 from public.athlete_memberships m2
           where m2.athlete_id = a.id and m2.membership_type = 'team' and m2.status = 'active' and m2.team_id = a.team_id
         )
       )`,
    [athleteId],
  );
}

// Only a platform admin can ever hand out role_hint="platform_admin" here -
// a club admin's allowed set deliberately excludes it, and this is now keyed
// off req.authz's real scoped roles rather than the role_hint string, so a
// role_hint that merely SAYS "club_admin" with no actual user_club_roles row
// gets no more than the generic-user default.
function allowedUserRole(authz, requestedRole) {
  const role = clean(requestedRole).toLowerCase();
  const platformRoles = new Set(["platform_admin", "club_admin", "team_coach", "coach", "athlete"]);
  const clubRoles = new Set(["club_admin", "team_coach", "coach", "athlete"]);
  if (isPlatformAdministrator(authz)) return platformRoles.has(role) ? role : "coach";
  if (authz.clubRoles.length > 0) return clubRoles.has(role) ? role : "team_coach";
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
    lastName: parts.slice(1).join(" "),
  };
}

export default router;
