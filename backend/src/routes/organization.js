import crypto from "node:crypto";
import { Router } from "express";
import { pool, query } from "../db.js";
import {
  canAssignClubRole as authzCanAssignClubRole,
  canAssignTeamRole as authzCanAssignTeamRole,
  canManageClub as authzCanManageClub,
  canManageTeamById as authzCanManageTeam,
  isPlatformAdministrator,
  loadAuthorizationContext,
} from "../authz.js";
import { destroySessionsForUser, hashPassword } from "../auth.js";
import { createNotification } from "../notifications.js";
import { resolveActiveWorkspace } from "../workspace.js";
import { canCreateInviteInContext, canRevokeInvite, INVITE_CONTEXT_TYPES, inviteContextShapeValid, lockAthleteInviteActions } from "../inviteContext.js";
import {
  canCreateJoinLinkInContext,
  canManageJoinLink,
  canReviewJoinApplication,
  isJoinLinkContextStillValid,
  joinLinkContextShapeValid,
  joinLinkStatus,
  lockJoinLinkActions,
} from "../joinLinkContext.js";

const router = Router();

// Presentation/data-context filtering only - narrows which of the already-
// authorized clubs/teams/athletes/users this response includes, based on the
// account's currently active workspace (see backend/src/workspace.js). This
// is never a security boundary: every write endpoint below independently
// re-checks req.authz regardless of what this filtering shows, exactly as
// before this function existed. A platform workspace (or no workspace at
// all, e.g. right after a role was revoked) returns everything the account
// is authorized to see, unfiltered - the same as pre-Phase-5 behavior.
function filterOrganizationDataForWorkspace(workspace, { clubs, teams, athletes, users, accessRequests }, actorUserId) {
  if (!workspace || workspace.type === "platform" || workspace.type === "athlete") {
    return { clubs, teams, athletes, users, accessRequests };
  }

  const isSelf = (user) => String(user.id) === String(actorUserId);
  const hasAnyActiveScopedRole = (user) =>
    (user.clubRoles || []).some((r) => r.isActive) || (user.teamRoles || []).some((r) => r.isActive);
  // A user row survives the workspace narrowing regardless of club/team
  // match only when doing so can never leak a DIFFERENT club/team's roster:
  // always the viewer's own account, and an account the viewer created but
  // that doesn't yet hold any active club/team role anywhere (so it can
  // still be assigned one from inside this workspace) - never an account
  // whose only active scoped role is in some OTHER club/team, even if this
  // same viewer created it. canManageLogin is only ever true for the
  // viewer's own creations or a platform admin, and platform never reaches
  // this branch.
  const alwaysVisibleUser = (user) => isSelf(user) || (user.canManageLogin && !hasAnyActiveScopedRole(user));

  if (workspace.type === "club") {
    const clubId = String(workspace.scopeId);
    const filteredClubs = clubs.filter((club) => String(club.id) === clubId);
    const filteredTeams = teams.filter((team) => String(team.club_id) === clubId);
    const filteredTeamIds = new Set(filteredTeams.map((team) => String(team.id)));
    // Matches on club/team id alone, regardless of membership status - an
    // archived-only tie must still surface here (same rows loadManagedAthletes
    // already decided this actor may see, e.g. for Show archived/Restore),
    // only rows with NO tie at all to this club are dropped.
    const filteredAthletes = athletes.filter((athlete) =>
      (athlete.memberships || []).some((m) => String(m.clubId) === clubId),
    );
    const filteredUsers = users.filter((user) =>
      alwaysVisibleUser(user)
      || (user.clubRoles || []).some((r) => String(r.clubId) === clubId)
      || (user.teamRoles || []).some((r) => filteredTeamIds.has(String(r.teamId))),
    );
    const filteredAthleteIds = new Set(filteredAthletes.map((athlete) => String(athlete.id)));
    const filteredAccessRequests = accessRequests.filter((r) => filteredAthleteIds.has(String(r.athlete_id)));
    return { clubs: filteredClubs, teams: filteredTeams, athletes: filteredAthletes, users: filteredUsers, accessRequests: filteredAccessRequests };
  }

  if (workspace.type === "team") {
    const teamId = String(workspace.scopeId);
    const filteredTeams = teams.filter((team) => String(team.id) === teamId);
    const filteredAthletes = athletes.filter((athlete) =>
      (athlete.memberships || []).some((m) => m.membershipType === "team" && String(m.teamId) === teamId),
    );
    const filteredUsers = users.filter((user) => alwaysVisibleUser(user) || (user.teamRoles || []).some((r) => String(r.teamId) === teamId));
    const filteredAthleteIds = new Set(filteredAthletes.map((athlete) => String(athlete.id)));
    const filteredAccessRequests = accessRequests.filter((r) => filteredAthleteIds.has(String(r.athlete_id)));
    return { clubs: [], teams: filteredTeams, athletes: filteredAthletes, users: filteredUsers, accessRequests: filteredAccessRequests };
  }

  if (workspace.type === "private_coach") {
    // Only athletes tied to THIS account's own private-coach relationship -
    // never clubs/teams, even if the same account also holds those roles.
    const filteredAthletes = athletes.filter((athlete) => athlete.has_my_active_coach_relationship || athlete.has_my_archived_coach_relationship);
    const filteredAthleteIds = new Set(filteredAthletes.map((athlete) => String(athlete.id)));
    const filteredAccessRequests = accessRequests.filter((r) => filteredAthleteIds.has(String(r.athlete_id)));
    return { clubs: [], teams: [], athletes: filteredAthletes, users: [], accessRequests: filteredAccessRequests };
  }

  return { clubs, teams, athletes, users, accessRequests };
}

// Attaches, to each athlete row, the invite status the CURRENT viewer is
// allowed to see - never anyone else's invites from a different context.
// Only the invite matching the account's active workspace context (same
// context_type + context_id) is surfaced, and for private_coach only the
// invite THIS viewer personally sent (a private-coach invite is a 1:1
// relationship, not something a fellow coach should see). Never returns a
// token or token hash. Only the most recently created row per athlete is
// shown - an older, superseded (regenerated/revoked) row stays in the audit
// trail but never surfaces here.
async function loadAthleteInviteStatuses(activeWorkspace, athleteIds, viewerUserId) {
  const byAthlete = new Map();
  if (!activeWorkspace || !athleteIds.length || !INVITE_CONTEXT_TYPES.has(activeWorkspace.type)) return byAthlete;
  const contextType = activeWorkspace.type;
  const contextId = activeWorkspace.scopeId || null;
  const params = [athleteIds, contextType, contextId];
  let viewerClause = "";
  if (contextType === "private_coach") {
    viewerClause = "and i.invited_by_user_id = $4";
    params.push(viewerUserId);
  }
  const result = await query(
    `select distinct on (i.athlete_id)
       i.id, i.athlete_id, i.email, i.context_type, i.context_id, i.expires_at, i.created_at,
       i.accepted_at, i.revoked_at, i.invited_by_user_id,
       coalesce(u.display_name, u.full_name, u.email) as invited_by_name
     from public.athlete_invites i
     left join public.users u on u.id = i.invited_by_user_id
     where i.athlete_id = any($1::uuid[])
       and i.context_type = $2
       and coalesce(i.context_id::text, '') = coalesce($3::text, '')
       ${viewerClause}
     order by i.athlete_id, i.created_at desc`,
    params,
  );
  for (const row of result.rows) {
    const status = row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : new Date(row.expires_at) <= new Date() ? "expired" : "pending";
    byAthlete.set(row.athlete_id, {
      status,
      invite: {
        id: row.id,
        email: row.email,
        contextType: row.context_type,
        contextId: row.context_id,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        invitedByUserId: row.invited_by_user_id,
        invitedByName: row.invited_by_name,
      },
    });
  }
  return byAthlete;
}

// Group join links visible to the CURRENT viewer's active workspace - a
// separate system from the per-athlete invites above (see
// backend/src/joinLinkContext.js). private_coach shows only the viewer's own
// links (a personal 1:1 scope, like a private-coach invite); club shows every
// link for that club AND every team-context link for a team under that club
// (a club admin manages both); team shows only that team's own links;
// platform (for a platform admin) shows every link across every context.
// Never filtered by role_hint.
async function loadJoinLinksForWorkspace(req, activeWorkspace) {
  const authz = req.authz;
  let whereClause;
  const params = [];
  if (activeWorkspace?.type === "platform" && isPlatformAdministrator(authz)) {
    whereClause = "true";
  } else if (activeWorkspace?.type === "private_coach" && authz.isIndependentCoach) {
    params.push(req.user.id);
    whereClause = `l.context_type = 'private_coach' and l.created_by_user_id = $1`;
  } else if (activeWorkspace?.type === "club") {
    params.push(activeWorkspace.scopeId);
    whereClause = `(l.context_type = 'club' and l.context_id = $1) or (l.context_type = 'team' and l.context_id in (select id from public.teams where club_id = $1))`;
  } else if (activeWorkspace?.type === "team") {
    params.push(activeWorkspace.scopeId);
    whereClause = `l.context_type = 'team' and l.context_id = $1`;
  } else {
    return [];
  }
  const result = await query(
    `select l.id, l.context_type, l.context_id, l.created_by_user_id, l.label, l.expires_at, l.max_uses,
            l.approved_uses, l.is_active, l.revoked_at, l.created_at,
            coalesce(u.display_name, u.full_name, u.email) as created_by_name,
            (select count(*) from public.athlete_join_applications a where a.join_link_id = l.id and a.status = 'pending') as pending_count
     from public.athlete_join_links l
     left join public.users u on u.id = l.created_by_user_id
     where ${whereClause}
     order by l.created_at desc`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    contextType: row.context_type,
    contextId: row.context_id,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    label: row.label,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    approvedUses: row.approved_uses,
    pendingCount: Number(row.pending_count),
    status: joinLinkStatus(row),
    createdAt: row.created_at,
  }));
}

// Every application (any status, for history) against a join link the
// current viewer can already see per loadJoinLinksForWorkspace above - never
// a password hash or status token.
async function loadJoinApplicationsForWorkspace(req, activeWorkspace, links) {
  const linkIds = links.map((link) => link.id);
  if (!linkIds.length) return [];
  const result = await query(
    `select a.id, a.join_link_id, a.applicant_user_id, a.email, a.first_name, a.last_name, a.display_name,
            a.status, a.submitted_at, a.reviewed_at, a.rejection_reason
     from public.athlete_join_applications a
     where a.join_link_id = any($1::uuid[])
     order by a.submitted_at desc`,
    [linkIds],
  );
  return result.rows.map((row) => ({
    id: row.id,
    joinLinkId: row.join_link_id,
    email: row.email,
    name: row.display_name || [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email,
    accountType: row.applicant_user_id ? "existing" : "new",
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
  }));
}

router.get("/", async (req, res, next) => {
  try {
    const [clubs, teams, athletes, users, accessRequests, { workspace: activeWorkspace }] = await Promise.all([
      loadClubs(req),
      loadTeams(req),
      loadManagedAthletes(req),
      loadUsers(req),
      loadProgramAccessRequests(req),
      resolveActiveWorkspace(req.user.id, req.authz),
    ]);
    const scoped = filterOrganizationDataForWorkspace(activeWorkspace, { clubs, teams, athletes, users, accessRequests }, req.user.id);
    const inviteStatuses = await loadAthleteInviteStatuses(activeWorkspace, scoped.athletes.map((a) => a.id), req.user.id);
    const athletesWithInviteStatus = scoped.athletes.map((athlete) => {
      const entry = inviteStatuses.get(athlete.id);
      return { ...athlete, inviteStatus: entry?.status || "none", invite: entry?.invite || null };
    });
    const joinLinks = await loadJoinLinksForWorkspace(req, activeWorkspace);
    const joinApplications = await loadJoinApplicationsForWorkspace(req, activeWorkspace, joinLinks);
    res.json({
      scope: req.user?.role_hint || "coach",
      isPlatformAdmin: isPlatformAdministrator(req.authz),
      canCreateClub: isPlatformAdministrator(req.authz),
      canCreateTeam: isPlatformAdministrator(req.authz) || req.authz.clubRoles.length > 0,
      canCreateAthlete: true,
      canCreateUser: isPlatformAdministrator(req.authz) || req.authz.clubRoles.length > 0,
      // The single source of truth for which club_admin/team_coach Add/Remove
      // controls the frontend may offer - computed with the exact same
      // functions the grant/revoke endpoints themselves enforce
      // (authzCanAssignClubRole/authzCanAssignTeamRole), so the frontend
      // never has to guess or re-derive this from role_hint or anything else.
      manageableClubIds: scoped.clubs.filter((club) => authzCanAssignClubRole(req.authz, club.id)).map((club) => club.id),
      manageableTeamIds: scoped.teams.filter((team) => authzCanAssignTeamRole(req.authz, team.id)).map((team) => team.id),
      clubs: scoped.clubs,
      teams: scoped.teams,
      athletes: athletesWithInviteStatus,
      users: scoped.users,
      accessRequests: scoped.accessRequests,
      joinLinks,
      joinApplications,
      activeWorkspace,
    });
  } catch (error) {
    next(error);
  }
});

// Mirrors PLATFORM_ROLES / INDEPENDENT_COACH_ROLE_HINTS (access.js/authz.js)
// and the 20260802_user_global_roles.sql backfill mapping - kept as a
// separate literal here (rather than imported) because this is the one
// place a NEW account's role_hint choice must be translated into a real
// user_global_roles row at creation time, same set, same meaning.
const PLATFORM_ADMIN_ROLE_HINTS = new Set(["admin", "platform_admin", "general_admin"]);
const INDEPENDENT_COACH_ROLE_HINTS = new Set(["coach", "independent_coach", "fitness_coach", "trainer"]);

function globalRoleForRoleHint(roleHint) {
  if (PLATFORM_ADMIN_ROLE_HINTS.has(roleHint)) return "platform_admin";
  if (INDEPENDENT_COACH_ROLE_HINTS.has(roleHint)) return "independent_coach";
  return null;
}

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
    const globalRole = globalRoleForRoleHint(roleHint);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, created_by_user_id, is_active)
         values ($1, $2, $3, $4, $5, $5, $6, $7, true)
         on conflict (email) do nothing
         returning id, email, full_name, display_name, role_hint`,
        [email, nameParts.firstName, nameParts.lastName, hashPassword(password), fullName || email, roleHint, req.user.id],
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return res.status(409).json({ error: "A user with this email already exists." });
      }
      // Written in the SAME transaction as the users row - there must never
      // be a moment where a platform_admin/independent_coach account exists
      // without its matching real user_global_roles row (or vice versa).
      if (globalRole) {
        await client.query(
          `insert into public.user_global_roles (user_id, role, is_active, granted_by_user_id)
           values ($1, $2, true, $3)
           on conflict (user_id, role) do update set is_active = true, updated_at = now()`,
          [result.rows[0].id, globalRole, req.user.id],
        );
      }
      await client.query("commit");
      res.status(201).json({ user: result.rows[0] });
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

// Legacy name only - this has always disabled the account (users.is_active
// = false), never hard-deleted the row. Delegates to the same guarded
// service PUT /users/:userId/login-status uses, so both paths get the same
// self-disable guard, ownership/scope check, platform-admin-only-touches-
// platform-admin rule, and last-platform-admin protection. The response is
// explicitly labeled "disabled", not "deleted", to avoid implying the row
// was removed.
router.delete("/users/:userId", async (req, res, next) => {
  try {
    const result = await setUserLoginStatus(req, req.params.userId, false);
    res.status(result.status).json({ ...result.body, deleted: false });
  } catch (error) {
    next(error);
  }
});

router.put("/users/:userId/login-status", async (req, res, next) => {
  try {
    // Strictly a JSON boolean - "false" (string), 0/1, null, and a missing
    // field are all rejected rather than coerced. Boolean(req.body?.active)
    // used to turn a missing field into `false` (silently disabling the
    // account) and the string "false" into `true` (Boolean("false") ===
    // true) - both are exactly the kind of accidental-disable bug this
    // endpoint must never allow.
    if (typeof req.body?.active !== "boolean") {
      return res.status(400).json({ error: "INVALID_LOGIN_STATUS" });
    }
    const result = await setUserLoginStatus(req, req.params.userId, req.body.active);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

// Shared lock key for the "how many platform admins can actually log in"
// invariant. Revoking the platform_admin role (which mutates
// user_global_roles) and disabling a platform admin's login (which mutates
// users) touch different tables and would never naturally serialize against
// each other through row locks alone - two concurrent requests on each path
// could both read "more than one qualifying admin left" and both succeed,
// leaving zero. Every code path that could reduce that count acquires this
// SAME pg_advisory_xact_lock before reading the count, so only one such
// operation is ever "inside the decision" at a time, regardless of which
// table it's about to modify. The key is an arbitrary constant - it carries
// no meaning beyond "this one lock" and must never change or be reused for
// anything else. pg_advisory_xact_lock auto-releases at transaction end
// (commit or rollback); never pair it with pg_advisory_unlock.
const PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY = 726354981;

async function lockPlatformAdminHeadcount(client) {
  await client.query("select pg_advisory_xact_lock($1)", [PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY]);
}

// Must be called AFTER lockPlatformAdminHeadcount, inside the same open
// transaction - re-reads the current state fresh rather than trusting
// anything read before the lock was acquired (this transaction may have
// waited an arbitrary amount of time behind another one holding the lock).
// "Qualifying" means BOTH users.is_active = true (can actually log in) AND
// user_global_roles.is_active = true (still holds the role) - a role-active
// account whose login is already disabled cannot use platform
// administration, so it must never count toward "there's still an admin
// left" when deciding whether a revoke or a disable would be the last one.
async function loadQualifyingPlatformAdminIds(client) {
  const result = await client.query(
    `select u.id
     from public.users u
     join public.user_global_roles g on g.user_id = u.id and g.role = 'platform_admin' and g.is_active = true
     where u.is_active = true
     order by u.id
     for update of u, g`,
  );
  return result.rows.map((row) => row.id);
}

// Enables/disables a login (users.is_active) without touching any role -
// global, club, team, or athlete FK. Never a hard delete. Shared by the
// legacy DELETE /users/:userId and the explicit PUT .../login-status.
//
// Ownership/scope follows the existing model unchanged: a platform admin can
// manage any account; anyone else only an account they created
// (created_by_user_id). Disabling always runs inside the shared advisory-
// locked transaction below, regardless of the target's platform-admin
// status - the target's real status is read fresh AFTER the lock is
// acquired, never trusted from a query run before this transaction opened.
// On top of the ownership/scope check:
//   - only a platform admin may disable a platform admin's login (their own
//     included), even if they technically created that account (a club
//     admin must never be able to lock out a platform admin);
//   - disabling the last remaining login-active + role-active platform
//     admin is rejected with 409 LAST_PLATFORM_ADMIN. This is checked
//     BEFORE the generic self-disable rule below, so a platform admin
//     disabling their own login gets the more specific 409 when they're the
//     last one, and the generic 400 otherwise;
//   - self-disable is otherwise always rejected, regardless of scope;
//   - the users.is_active update and the session deletion happen on the
//     same transaction client before commit, so a failure partway never
//     leaves a disabled account with live sessions or vice versa.
// Re-enabling a login (active === true) can never reduce the admin count,
// so it skips the shared lock entirely.
async function setUserLoginStatus(req, targetUserId, active) {
  const target = await query(`select id, created_by_user_id from public.users where id = $1 limit 1`, [targetUserId]);
  if (!target.rows[0]) return { status: 404, body: { error: "User not found or outside your access." } };

  const actorIsPlatformAdmin = isPlatformAdministrator(req.authz);
  const ownsTarget = String(target.rows[0].created_by_user_id) === String(req.user.id);
  if (!actorIsPlatformAdmin && !ownsTarget) {
    return { status: 404, body: { error: "User not found or outside your access." } };
  }

  if (!active) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await lockPlatformAdminHeadcount(client);
      const targetPlatformAdminRow = await client.query(
        `select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active = true limit 1`,
        [targetUserId],
      );
      const targetIsPlatformAdmin = Boolean(targetPlatformAdminRow.rows[0]);
      if (targetIsPlatformAdmin && !actorIsPlatformAdmin) {
        await client.query("rollback");
        return { status: 403, body: { error: "Only a platform admin can manage a platform admin account." } };
      }
      if (targetIsPlatformAdmin) {
        const qualifyingIds = await loadQualifyingPlatformAdminIds(client);
        const targetQualifies = qualifyingIds.some((id) => String(id) === String(targetUserId));
        if (targetQualifies && qualifyingIds.length <= 1) {
          await client.query("rollback");
          return { status: 409, body: { error: "LAST_PLATFORM_ADMIN" } };
        }
      }
      const blockedClubId = await findClubAdminLastAdminBlock(client, targetUserId);
      if (blockedClubId) {
        await client.query("rollback");
        return { status: 409, body: { error: "LAST_CLUB_ADMIN" } };
      }
      if (String(targetUserId) === String(req.user.id)) {
        await client.query("rollback");
        return { status: 400, body: { error: "You cannot disable your own account." } };
      }
      const updated = await client.query(
        `update public.users set is_active = false, updated_at = now() where id = $1 returning id, is_active`,
        [targetUserId],
      );
      await client.query(`delete from public.auth_sessions where user_id = $1`, [targetUserId]);
      await client.query("commit");
      return { status: 200, body: { ok: true, active: updated.rows[0].is_active, disabled: true } };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Re-enabling: no admin-count risk, so no shared lock - still confirm only
  // a platform admin may flip a platform admin's login back on.
  const targetPlatformAdminRow = await query(
    `select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active = true limit 1`,
    [targetUserId],
  );
  if (targetPlatformAdminRow.rows[0] && !actorIsPlatformAdmin) {
    return { status: 403, body: { error: "Only a platform admin can manage a platform admin account." } };
  }
  const updated = await query(
    `update public.users set is_active = true, updated_at = now() where id = $1 returning id, is_active`,
    [targetUserId],
  );
  return { status: 200, body: { ok: true, active: updated.rows[0].is_active, disabled: false } };
}

// Allowed global roles - a "platform-wide" concept, structurally independent
// of any club/team scope and of role_hint. Only an active platform_admin
// from req.authz (real user_global_roles row, never role_hint) may grant or
// revoke either one, including for their own account.
const GLOBAL_ROLES = new Set(["platform_admin", "independent_coach"]);

router.put("/users/:userId/global-roles/:role", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only a platform admin can grant global roles." });
    const role = clean(req.params.role);
    if (!GLOBAL_ROLES.has(role)) return res.status(400).json({ error: "Unknown global role." });
    const targetUserId = clean(req.params.userId);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const target = await client.query(`select id from public.users where id = $1 limit 1`, [targetUserId]);
      if (!target.rows[0]) {
        await client.query("rollback");
        return res.status(404).json({ error: "User not found." });
      }
      // Idempotent grant/reactivate: never touches role_hint, users.is_active,
      // or any athlete/club/team role. Reactivating an existing (revoked) row
      // always clears its revoke audit fields - a role that's active again
      // has no "revoked by/at" to show.
      await client.query(
        `insert into public.user_global_roles (user_id, role, is_active, granted_by_user_id, revoked_at, revoked_by_user_id)
         values ($1, $2, true, $3, null, null)
         on conflict (user_id, role) do update
           set is_active = true,
               granted_by_user_id = excluded.granted_by_user_id,
               revoked_at = null,
               revoked_by_user_id = null,
               updated_at = now()`,
        [targetUserId, role, req.user.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true, globalRoles: await loadGlobalRoles(targetUserId) });
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:userId/global-roles/:role", async (req, res, next) => {
  try {
    if (!isPlatformAdministrator(req.authz)) return res.status(403).json({ error: "Only a platform admin can revoke global roles." });
    const role = clean(req.params.role);
    if (!GLOBAL_ROLES.has(role)) return res.status(400).json({ error: "Unknown global role." });
    const targetUserId = clean(req.params.userId);
    const target = await query(`select id from public.users where id = $1 limit 1`, [targetUserId]);
    if (!target.rows[0]) return res.status(404).json({ error: "User not found." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      if (role === "platform_admin") {
        // Same shared advisory lock the disable-login path uses, then the
        // same fresh (login-active AND role-active) qualifying-count read -
        // see lockPlatformAdminHeadcount/loadQualifyingPlatformAdminIds.
        await lockPlatformAdminHeadcount(client);
        const qualifyingIds = await loadQualifyingPlatformAdminIds(client);
        const targetQualifies = qualifyingIds.some((id) => String(id) === String(targetUserId));
        if (targetQualifies && qualifyingIds.length <= 1) {
          await client.query("rollback");
          return res.status(409).json({ error: "LAST_PLATFORM_ADMIN" });
        }
      }
      // Idempotent: if there's no active row for this (user, role) - already
      // revoked, or never granted - this affects zero rows and the request
      // still succeeds, returning the current (unchanged) role state.
      await client.query(
        `update public.user_global_roles
         set is_active = false, revoked_at = now(), revoked_by_user_id = $1, updated_at = now()
         where user_id = $2 and role = $3 and is_active = true`,
        [req.user.id, targetUserId, role],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true, globalRoles: await loadGlobalRoles(targetUserId) });
  } catch (error) {
    next(error);
  }
});

async function loadGlobalRoles(userId) {
  const result = await query(
    `select role, is_active as "isActive", granted_by_user_id as "grantedByUserId",
            revoked_at as "revokedAt", revoked_by_user_id as "revokedByUserId",
            created_at as "createdAt", updated_at as "updatedAt"
     from public.user_global_roles
     where user_id = $1
     order by role`,
    [userId],
  );
  return result.rows;
}

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
    const contextType = clean(req.body?.contextType);
    const contextId = req.body?.contextId != null ? clean(req.body.contextId) : null;
    if (!athleteId || !email) return res.status(400).json({ error: "Athlete and email are required." });
    if (!inviteContextShapeValid(contextType, contextId)) return res.status(400).json({ error: "UNSUPPORTED_INVITE_CONTEXT" });

    // Fast-fail pre-checks outside any transaction, purely so an obviously
    // unauthorized or already-linked call never pays for opening a
    // transaction/lock at all. Neither is the real enforcement point - both
    // are re-run fresh below, after the per-athlete lock is held, which is
    // what actually closes the races (see lockAthleteInviteActions).
    const permission = await canCreateInviteInContext(query, req, athleteId, contextType, contextId);
    if (!permission.ok) return res.status(permission.status).json({ error: permission.error });

    const athlete = await query(
      `select id, coalesce(display_name, full_name, athlete_id) as name
       from public.athletes where id = $1 and coalesce(is_active, true) limit 1`,
      [athleteId],
    );
    if (!athlete.rows[0]) return res.status(404).json({ error: "Athlete not found." });

    const client = await pool.connect();
    let invite;
    let token;
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      // Same lock namespace/key that accept, link, and revoke all acquire
      // for this athlete_id before touching athletes.user_id or this
      // athlete's invite rows - see lockAthleteInviteActions. This is what
      // actually prevents a concurrent accept/link from linking the login
      // (or a concurrent revoke from resolving) while this request is
      // mid-decision.
      await lockAthleteInviteActions(exec, athleteId);
      // Re-check inside the lock: a concurrent accept/link could have
      // linked this athlete's login between the pre-check above and here.
      const recheck = await client.query(`select user_id from public.athletes where id = $1 for update`, [athleteId]);
      if (recheck.rows[0]?.user_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "ATHLETE_ALREADY_HAS_LOGIN" });
      }
      // Re-run the exact same context/permission/membership check again,
      // now under the lock - membership or role could have been archived in
      // the window between the pre-check above and acquiring this lock.
      const lockedPermission = await canCreateInviteInContext(exec, req, athleteId, contextType, contextId);
      if (!lockedPermission.ok) {
        await client.query("rollback");
        return res.status(lockedPermission.status).json({ error: lockedPermission.error });
      }
      // Regenerating always revokes whatever open (not accepted, not
      // revoked) invite already exists for this exact (athlete, context) -
      // regardless of which email it was sent to - so there is only ever
      // one live link per athlete+context, matching the partial unique
      // index in the migration.
      await client.query(
        `update public.athlete_invites
         set revoked_at = now(), revoked_by_user_id = $1, revoke_reason = 'regenerated', updated_at = now()
         where athlete_id = $2 and context_type = $3 and coalesce(context_id::text, '') = coalesce($4::text, '')
           and accepted_at is null and revoked_at is null`,
        [req.user.id, athleteId, contextType, contextId],
      );
      token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashInviteToken(token);
      const inserted = await client.query(
        `insert into public.athlete_invites (athlete_id, email, token_hash, invited_by_user_id, context_type, context_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
         returning id, athlete_id, email, expires_at, created_at, context_type, context_id`,
        [athleteId, email, tokenHash, req.user.id, contextType, contextId],
      );
      invite = inserted.rows[0];
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const inviteUrl = `${appOrigin(req)}/invite?token=${encodeURIComponent(token)}`;
    const subject = encodeURIComponent("OptiMove athlete access");
    const body = encodeURIComponent(`Hi ${athlete.rows[0].name || ""},\n\nUse this link to activate your OptiMove athlete account:\n${inviteUrl}\n\nThis link expires in 7 days.`);
    res.status(201).json({
      invite: {
        id: invite.id,
        athleteId: invite.athlete_id,
        email: invite.email,
        expiresAt: invite.expires_at,
        createdAt: invite.created_at,
        contextType: invite.context_type,
        contextId: invite.context_id,
      },
      inviteUrl,
      mailtoUrl: `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/athlete-invites/:inviteId", async (req, res, next) => {
  try {
    const inviteId = clean(req.params.inviteId);
    // Resolve athlete_id without any mutation, purely to have the lock key
    // before opening a transaction - if the invite doesn't exist at all,
    // there's nothing to lock or revoke.
    const resolved = await query(`select athlete_id from public.athlete_invites where id = $1 limit 1`, [inviteId]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Invite not found." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      // Same per-athlete lock accept/link/generate all use - serializes this
      // revoke against a concurrent accept/link of the SAME token (or a
      // concurrent regenerate of a different open invite for this athlete).
      await lockAthleteInviteActions(exec, resolved.rows[0].athlete_id);

      const fresh = await client.query(
        `select id, athlete_id, context_type, context_id, invited_by_user_id, accepted_at, revoked_at
         from public.athlete_invites where id = $1 limit 1 for update`,
        [inviteId],
      );
      const invite = fresh.rows[0];
      if (!invite) {
        await client.query("rollback");
        return res.status(404).json({ error: "Invite not found." });
      }
      if (invite.accepted_at) {
        await client.query("rollback");
        return res.status(409).json({ error: "This invite has already been accepted." });
      }

      const permission = await canRevokeInvite(exec, req, invite);
      if (!permission.ok) {
        await client.query("rollback");
        return res.status(permission.status).json({ error: permission.error });
      }

      // Idempotent: revoking an already-revoked invite is a no-op success,
      // not an error - but the permission check above still ran first
      // against the fresh, locked row, so an unauthorized viewer never
      // learns whether it was already revoked.
      if (invite.revoked_at) {
        await client.query("commit");
        return res.json({ ok: true });
      }

      await client.query(
        `update public.athlete_invites
         set revoked_at = now(), revoked_by_user_id = $1, revoke_reason = 'revoked', updated_at = now()
         where id = $2 and accepted_at is null and revoked_at is null`,
        [req.user.id, inviteId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// --- Group athlete join links (feature/group-athlete-join-links) ---
// A SEPARATE system from the athlete-invites endpoints above - a join link
// targets a context (private_coach/club/team), not a pre-existing athlete
// profile, and many different people can submit a request against the same
// link. See backend/src/joinLinkContext.js for the shared permission
// matrix/lock.

router.post("/athlete-join-links", async (req, res, next) => {
  try {
    const contextType = clean(req.body?.contextType);
    const contextId = req.body?.contextId != null ? clean(req.body.contextId) : null;
    const label = clean(req.body?.label) || null;
    const expiresInDaysRaw = Number(req.body?.expiresInDays);
    const expiresInDays = Number.isFinite(expiresInDaysRaw) ? Math.trunc(expiresInDaysRaw) : NaN;
    if (!joinLinkContextShapeValid(contextType, contextId)) return res.status(400).json({ error: "UNSUPPORTED_JOIN_LINK_CONTEXT" });
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      return res.status(400).json({ error: "Expiration must be between 1 and 30 days." });
    }
    let maxUses = null;
    const maxUsesRaw = req.body?.maxUses;
    if (maxUsesRaw !== null && maxUsesRaw !== undefined && maxUsesRaw !== "") {
      const parsed = Number(maxUsesRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        return res.status(400).json({ error: "Max uses must be a whole number between 1 and 500, or left empty for unlimited." });
      }
      maxUses = parsed;
    }
    if (contextType === "club" || contextType === "team") {
      const table = contextType === "club" ? "clubs" : "teams";
      const exists = await query(`select id from public.${table} where id = $1 and coalesce(is_active, true) limit 1`, [contextId]);
      if (!exists.rows[0]) return res.status(404).json({ error: contextType === "club" ? "Club not found." : "Team not found." });
    }
    const permission = canCreateJoinLinkInContext(req, contextType, contextId);
    if (!permission.ok) return res.status(permission.status).json({ error: permission.error });

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashInviteToken(token);
    const inserted = await query(
      `insert into public.athlete_join_links (token_hash, context_type, context_id, created_by_user_id, label, expires_at, max_uses)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval, $7)
       returning id, context_type, context_id, label, expires_at, max_uses, approved_uses, is_active, created_at`,
      [tokenHash, contextType, contextId, req.user.id, label, String(expiresInDays), maxUses],
    );
    const link = inserted.rows[0];
    res.status(201).json({
      link: {
        id: link.id,
        contextType: link.context_type,
        contextId: link.context_id,
        label: link.label,
        expiresAt: link.expires_at,
        maxUses: link.max_uses,
        approvedUses: link.approved_uses,
        pendingCount: 0,
        status: joinLinkStatus(link),
        createdAt: link.created_at,
      },
      joinUrl: `${appOrigin(req)}/join?token=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/athlete-join-links", async (req, res, next) => {
  try {
    const { workspace: activeWorkspace } = await resolveActiveWorkspace(req.user.id, req.authz);
    const links = await loadJoinLinksForWorkspace(req, activeWorkspace);
    res.json({ links });
  } catch (error) {
    next(error);
  }
});

router.delete("/athlete-join-links/:linkId", async (req, res, next) => {
  try {
    const linkId = clean(req.params.linkId);
    // Resolve without mutation, purely to have the lock key - if the link
    // doesn't exist at all, there's nothing to lock or revoke.
    const resolved = await query(`select id from public.athlete_join_links where id = $1 limit 1`, [linkId]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Join link not found." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockJoinLinkActions(exec, linkId);

      const fresh = await client.query(
        `select id, context_type, context_id, created_by_user_id, is_active, revoked_at
         from public.athlete_join_links where id = $1 limit 1 for update`,
        [linkId],
      );
      const link = fresh.rows[0];
      if (!link) {
        await client.query("rollback");
        return res.status(404).json({ error: "Join link not found." });
      }
      const permission = canManageJoinLink(req, link);
      if (!permission.ok) {
        await client.query("rollback");
        return res.status(permission.status).json({ error: permission.error });
      }

      // Idempotent - revoking an already-revoked link is a no-op success.
      if (!link.is_active || link.revoked_at) {
        await client.query("commit");
        return res.json({ ok: true });
      }

      await client.query(
        `update public.athlete_join_links set is_active = false, revoked_at = now(), revoked_by_user_id = $1, updated_at = now() where id = $2`,
        [req.user.id, linkId],
      );
      // Revoking auto-cancels this link's still-open applications (pending or
      // requires_login) and clears their password hashes - none of them can
      // ever be reviewed/approved once the link itself is dead, so leaving
      // them open would just be stale, misleading state (and a lingering
      // password hash with nowhere safe to go). Already-approved/rejected/
      // cancelled applications are untouched - they stay as audit history.
      await client.query(
        `update public.athlete_join_applications
         set status = 'cancelled', password_hash = null, reviewed_at = now(), reviewed_by_user_id = $1, updated_at = now()
         where join_link_id = $2 and status in ('pending', 'requires_login')`,
        [req.user.id, linkId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/athlete-join-links/:linkId/regenerate", async (req, res, next) => {
  try {
    const linkId = clean(req.params.linkId);
    const resolved = await query(`select id from public.athlete_join_links where id = $1 limit 1`, [linkId]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Join link not found." });

    const client = await pool.connect();
    let link;
    let token;
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockJoinLinkActions(exec, linkId);

      const fresh = await client.query(
        `select id, context_type, context_id, created_by_user_id, is_active, revoked_at
         from public.athlete_join_links where id = $1 limit 1 for update`,
        [linkId],
      );
      const current = fresh.rows[0];
      if (!current) {
        await client.query("rollback");
        return res.status(404).json({ error: "Join link not found." });
      }
      const permission = canManageJoinLink(req, current);
      if (!permission.ok) {
        await client.query("rollback");
        return res.status(permission.status).json({ error: permission.error });
      }
      if (!current.is_active || current.revoked_at) {
        await client.query("rollback");
        return res.status(409).json({ error: "This join link has been revoked. Create a new one instead." });
      }

      // Regenerating changes the SAME row's token in place (unlike an
      // athlete-invite regenerate, which revokes an old row and inserts a
      // new one) - a join link is a persistent context-level entity, and its
      // id is what every already-submitted application (join_link_id) points
      // at, so those must never be disturbed by this.
      token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashInviteToken(token);
      const updated = await client.query(
        `update public.athlete_join_links set token_hash = $2, updated_at = now() where id = $1
         returning id, context_type, context_id, label, expires_at, max_uses, approved_uses, is_active, created_at`,
        [linkId, tokenHash],
      );
      link = updated.rows[0];
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({
      link: {
        id: link.id,
        contextType: link.context_type,
        contextId: link.context_id,
        label: link.label,
        expiresAt: link.expires_at,
        maxUses: link.max_uses,
        approvedUses: link.approved_uses,
        status: joinLinkStatus(link),
        createdAt: link.created_at,
      },
      joinUrl: `${appOrigin(req)}/join?token=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/athlete-join-applications/:applicationId/approve", async (req, res, next) => {
  try {
    const applicationId = clean(req.params.applicationId);
    const resolved = await query(`select join_link_id from public.athlete_join_applications where id = $1 limit 1`, [applicationId]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Request not found." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      // Same per-join-link lock regenerate/revoke/apply all acquire - this is
      // what actually prevents two concurrent approvals of two different
      // pending applications on the SAME link from both squeezing past the
      // max_uses check, and what makes "two parallel approvals of the SAME
      // application create only one account" hold (the loser sees status is
      // no longer 'pending' once it gets the lock).
      await lockJoinLinkActions(exec, resolved.rows[0].join_link_id);

      const linkResult = await client.query(
        `select id, context_type, context_id, created_by_user_id, is_active, revoked_at, max_uses, approved_uses
         from public.athlete_join_links where id = $1 limit 1 for update`,
        [resolved.rows[0].join_link_id],
      );
      const link = linkResult.rows[0];
      if (!link) {
        await client.query("rollback");
        return res.status(404).json({ error: "Join link not found." });
      }
      const permission = canReviewJoinApplication(req, link);
      if (!permission.ok) {
        await client.query("rollback");
        return res.status(permission.status).json({ error: permission.error });
      }

      const appResult = await client.query(
        `select id, join_link_id, applicant_user_id, email, first_name, last_name, display_name, password_hash, status
         from public.athlete_join_applications where id = $1 limit 1 for update`,
        [applicationId],
      );
      const application = appResult.rows[0];
      if (!application || String(application.join_link_id) !== String(link.id)) {
        await client.query("rollback");
        return res.status(404).json({ error: "Request not found." });
      }
      if (application.status !== "pending") {
        await client.query("rollback");
        return res.status(409).json({ error: "This request has already been reviewed." });
      }

      // Re-checked fresh, under the lock, immediately before creating
      // anything - the private coach may have lost the role, or the
      // club/team may have been archived, since this application was
      // submitted (or even since the reviewer opened this screen).
      const contextValid = await isJoinLinkContextStillValid(exec, link);
      if (!contextValid || !link.is_active || link.revoked_at) {
        await client.query("rollback");
        return res.status(409).json({ error: "This join link is no longer valid, so this request cannot be approved." });
      }
      if (link.max_uses != null && Number(link.approved_uses) >= Number(link.max_uses)) {
        await client.query("rollback");
        return res.status(409).json({ error: "JOIN_LINK_FULL" });
      }

      let resultingUserId;
      let resultingAthleteId;

      if (application.applicant_user_id) {
        // Existing account (POST .../apply-existing): never touches
        // password/email/role_hint, never disturbs any other role the
        // account holds. Reuses the athlete profile already linked to this
        // account (athletes.user_id is the real FK, protected by the
        // athletes_user_id_unique partial index), or creates exactly one new
        // one if it doesn't have one yet.
        const existingAthlete = await client.query(`select id from public.athletes where user_id = $1 limit 1`, [application.applicant_user_id]);
        if (existingAthlete.rows[0]) {
          resultingAthleteId = existingAthlete.rows[0].id;
        } else {
          const userRow = await client.query(`select email, full_name, display_name from public.users where id = $1 limit 1`, [application.applicant_user_id]);
          const fullName = userRow.rows[0]?.full_name || userRow.rows[0]?.display_name || userRow.rows[0]?.email || "Athlete";
          const generatedId = await nextAthleteId();
          const { firstName, lastName } = splitName(fullName);
          // created_by_user_id is the APPROVER (req.user.id) - the account
          // actually performing this creation, mirroring POST /athletes
          // elsewhere in this file - not the join link's original creator,
          // who may not even be the one reviewing this request (any current
          // holder of a club/team role may review).
          const createdAthlete = await client.query(
            `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, created_by_user_id, is_active)
             values ($1, $1, $2, $3, $4, $4, $5, $6, true)
             returning id`,
            [generatedId, firstName, lastName, fullName, application.applicant_user_id, req.user.id],
          );
          resultingAthleteId = createdAthlete.rows[0].id;
        }
        resultingUserId = application.applicant_user_id;
      } else {
        // Brand-new email (POST .../apply): re-check it hasn't been claimed
        // by anyone since this application was submitted - never upsert a
        // password onto an existing row, and never silently approve into
        // the wrong account.
        const emailOwner = await client.query(`select id from public.users where lower(email) = lower($1) limit 1`, [application.email]);
        if (emailOwner.rows[0]) {
          await client.query(
            `update public.athlete_join_applications set status = 'requires_login', password_hash = null, updated_at = now() where id = $1`,
            [application.id],
          );
          await client.query("commit");
          return res.status(409).json({ error: "EMAIL_NOW_EXISTS_REQUIRES_LOGIN" });
        }
        const fullName = application.display_name || [application.first_name, application.last_name].filter(Boolean).join(" ") || application.email;
        let insertedUser;
        try {
          insertedUser = await client.query(
            `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
             values ($1, $2, $3, $4, $5, $5, 'athlete', true)
             returning id`,
            [application.email, application.first_name || "Athlete", application.last_name || "", application.password_hash, fullName],
          );
        } catch (insertError) {
          // A second, DIFFERENT join link's pending application for the same
          // email could be approved concurrently - each approve only locks
          // its OWN join_link_id, so this is the one race the per-link lock
          // above cannot close on its own. The database's own unique
          // constraint on users.email is the real backstop.
          if (insertError?.code === "23505") {
            await client.query(
              `update public.athlete_join_applications set status = 'requires_login', password_hash = null, updated_at = now() where id = $1`,
              [application.id],
            );
            await client.query("commit");
            return res.status(409).json({ error: "EMAIL_NOW_EXISTS_REQUIRES_LOGIN" });
          }
          throw insertError;
        }
        resultingUserId = insertedUser.rows[0].id;
        const generatedId = await nextAthleteId();
        const { firstName, lastName } = splitName(fullName);
        const createdAthlete = await client.query(
          `insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, created_by_user_id, is_active)
           values ($1, $1, $2, $3, $4, $4, $5, $6, true)
           returning id`,
          [generatedId, firstName, lastName, fullName, resultingUserId, req.user.id],
        );
        resultingAthleteId = createdAthlete.rows[0].id;
      }

      await client.query(
        `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
         values ($1, $2, 'athlete', true)
         on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
        [resultingUserId, resultingAthleteId],
      );

      // The relationship/membership this join CONTEXT grants - never touches
      // any other existing relationship this athlete/account may already
      // have.
      if (link.context_type === "private_coach") {
        await client.query(
          `insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active)
           values ($1, $2, 'coach', true)
           on conflict (user_id, athlete_id, relationship_type) do update set is_active = true, updated_at = now()`,
          [link.created_by_user_id, resultingAthleteId],
        );
      } else if (link.context_type === "club") {
        await ensureActiveMembership(client, resultingAthleteId, link.context_id, null, "club", req.user.id);
      } else if (link.context_type === "team") {
        const teamRow = await client.query(`select club_id from public.teams where id = $1 limit 1`, [link.context_id]);
        const clubId = teamRow.rows[0]?.club_id;
        await ensureActiveMembership(client, resultingAthleteId, clubId, null, "club", req.user.id);
        await ensureActiveMembership(client, resultingAthleteId, clubId, link.context_id, "team", req.user.id);
      }
      await syncLegacyAthletePointer(resultingAthleteId, { query: (text, params) => client.query(text, params) });

      await client.query(
        `update public.athlete_join_applications
         set status = 'approved', password_hash = null, reviewed_at = now(), reviewed_by_user_id = $1,
             resulting_user_id = $2, resulting_athlete_id = $3, updated_at = now()
         where id = $4`,
        [req.user.id, resultingUserId, resultingAthleteId, application.id],
      );
      await client.query(
        `update public.athlete_join_links set approved_uses = approved_uses + 1, updated_at = now() where id = $1`,
        [link.id],
      );
      await client.query("commit");
      res.json({ ok: true, userId: resultingUserId, athleteId: resultingAthleteId });
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

router.post("/athlete-join-applications/:applicationId/reject", async (req, res, next) => {
  try {
    const applicationId = clean(req.params.applicationId);
    const reason = clean(req.body?.reason) || null;
    const resolved = await query(`select join_link_id from public.athlete_join_applications where id = $1 limit 1`, [applicationId]);
    if (!resolved.rows[0]) return res.status(404).json({ error: "Request not found." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const exec = (text, params) => client.query(text, params);
      await lockJoinLinkActions(exec, resolved.rows[0].join_link_id);

      const linkResult = await client.query(
        `select id, context_type, context_id, created_by_user_id from public.athlete_join_links where id = $1 limit 1 for update`,
        [resolved.rows[0].join_link_id],
      );
      const link = linkResult.rows[0];
      if (!link) {
        await client.query("rollback");
        return res.status(404).json({ error: "Join link not found." });
      }
      const permission = canReviewJoinApplication(req, link);
      if (!permission.ok) {
        await client.query("rollback");
        return res.status(permission.status).json({ error: permission.error });
      }

      const appResult = await client.query(
        `select id, join_link_id, status from public.athlete_join_applications where id = $1 limit 1 for update`,
        [applicationId],
      );
      const application = appResult.rows[0];
      if (!application || String(application.join_link_id) !== String(link.id)) {
        await client.query("rollback");
        return res.status(404).json({ error: "Request not found." });
      }
      if (application.status !== "pending") {
        await client.query("rollback");
        return res.status(409).json({ error: "This request has already been reviewed." });
      }

      await client.query(
        `update public.athlete_join_applications
         set status = 'rejected', password_hash = null, reviewed_at = now(), reviewed_by_user_id = $1, rejection_reason = $2, updated_at = now()
         where id = $3`,
        [req.user.id, reason, application.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true });
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

// Scoped role management (Phase 4: security/scoped-role-management).
//
// Only two scoped roles are grantable through these endpoints: club_admin
// and team_coach. club_manager/team_admin/team_trainer have no fully
// defined authorization semantics in authz.js - if they exist in old data
// they are shown read-only elsewhere (loadUsers/loadClubs/loadTeams never
// filter them out), but nothing here ever grants, revokes, or infers
// meaning for them.
//
// canAssignTeamRole is NOT the same check as canManageTeamById (used
// elsewhere for day-to-day team/athlete management) - canManageTeamById
// deliberately also returns true for a team's own team_coach, which is
// correct for managing that team's athletes but would be a privilege
// escalation if reused here: a team_coach must never be able to grant
// themselves or anyone else more team_coach access. Assigning either
// scoped role is always a CLUB-level decision (platform admin, or the
// club_admin of the club that owns the club/team in question) - see
// authz.js's canAssignClubRole/canAssignTeamRole.

// Shared lock namespace for the "does this club still have an active
// admin" invariant, scoped per-club via hashtext(clubId) as the second
// advisory-lock key (distinct from PLATFORM_ADMIN_HEADCOUNT_LOCK_KEY's
// single global key - concurrent revokes on two DIFFERENT clubs must not
// block each other). The exact constant carries no meaning beyond "this
// one lock namespace" and must never change or be reused elsewhere.
const CLUB_ADMIN_HEADCOUNT_LOCK_NAMESPACE = 891234567;

async function lockClubAdminHeadcount(client, clubId) {
  await client.query("select pg_advisory_xact_lock($1, hashtext($2::text))", [CLUB_ADMIN_HEADCOUNT_LOCK_NAMESPACE, clubId]);
}

// Must be called AFTER lockClubAdminHeadcount, inside the same open
// transaction - re-reads current state fresh. "Qualifying" means BOTH
// users.is_active = true (can actually log in) AND
// user_club_roles.is_active = true (still holds the role), mirroring the
// same fix already applied to LAST_PLATFORM_ADMIN: a role-active admin
// whose login is disabled cannot actually administer the club, so must
// never count toward "there's still an admin left".
async function loadQualifyingClubAdminUserIds(client, clubId) {
  const result = await client.query(
    `select u.id
     from public.users u
     join public.user_club_roles r on r.user_id = u.id and r.club_id = $1 and r.role = 'club_admin' and r.is_active = true
     where u.is_active = true
     order by u.id
     for update of u, r`,
    [clubId],
  );
  return result.rows.map((row) => row.id);
}

// Must be called inside the same open transaction as the login-disable flow
// in setUserLoginStatus, before any mutation. Finds every ACTIVE club where
// the target currently holds an active club_admin role (an archived club is
// exempt from the LAST_CLUB_ADMIN invariant - it doesn't need to keep an
// admin forever), locks each one's headcount via lockClubAdminHeadcount in
// deterministic (sorted club id) order - never any other order - so that
// two concurrent requests against a user who administers multiple clubs can
// never form a circular wait, then re-reads the fresh qualifying count for
// each locked club. Returns the id of the first club where the target would
// be left as the last qualifying admin, or null if disabling the login is
// safe for all of them. No bypass for platform admin actors - this runs
// unconditionally, exactly like the LAST_PLATFORM_ADMIN check above.
async function findClubAdminLastAdminBlock(client, targetUserId) {
  const clubRows = await client.query(
    `select r.club_id as "clubId"
     from public.user_club_roles r
     join public.clubs c on c.id = r.club_id
     where r.user_id = $1 and r.role = 'club_admin' and r.is_active = true and coalesce(c.is_active, true) = true
     order by r.club_id`,
    [targetUserId],
  );
  const clubIds = clubRows.rows.map((row) => row.clubId);
  for (const clubId of clubIds) {
    await lockClubAdminHeadcount(client, clubId);
  }
  for (const clubId of clubIds) {
    const qualifyingIds = await loadQualifyingClubAdminUserIds(client, clubId);
    const targetQualifies = qualifyingIds.some((id) => String(id) === String(targetUserId));
    if (targetQualifies && qualifyingIds.length <= 1) {
      return clubId;
    }
  }
  return null;
}

async function loadClubRolesForUser(userId) {
  const result = await query(
    `select r.club_id as "clubId", c.name as "clubName", r.role, r.is_active as "isActive",
            r.granted_by_user_id as "grantedByUserId", r.revoked_at as "revokedAt", r.revoked_by_user_id as "revokedByUserId",
            r.created_at as "createdAt", r.updated_at as "updatedAt"
     from public.user_club_roles r
     join public.clubs c on c.id = r.club_id
     where r.user_id = $1
     order by c.name`,
    [userId],
  );
  return result.rows;
}

async function loadTeamRolesForUser(userId) {
  const result = await query(
    `select r.team_id as "teamId", t.name as "teamName", t.club_id as "clubId", r.role, r.is_active as "isActive",
            r.granted_by_user_id as "grantedByUserId", r.revoked_at as "revokedAt", r.revoked_by_user_id as "revokedByUserId",
            r.created_at as "createdAt", r.updated_at as "updatedAt"
     from public.user_team_roles r
     join public.teams t on t.id = r.team_id
     where r.user_id = $1
     order by t.name`,
    [userId],
  );
  return result.rows;
}

async function grantClubAdminRole(req, targetUserId, clubId) {
  if (!authzCanAssignClubRole(req.authz, clubId)) {
    return { status: 403, body: { error: "Only a platform admin, or this club's own admin, can grant club administrator access." } };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const [club, target] = await Promise.all([
      client.query(`select id from public.clubs where id = $1 limit 1`, [clubId]),
      client.query(`select id from public.users where id = $1 limit 1`, [targetUserId]),
    ]);
    if (!club.rows[0]) {
      await client.query("rollback");
      return { status: 404, body: { error: "Club not found." } };
    }
    if (!target.rows[0]) {
      await client.query("rollback");
      return { status: 404, body: { error: "User not found." } };
    }
    // Idempotent: never touches role_hint, login status, or any other
    // global/club/team/athlete role. Reactivating an existing (revoked) row
    // always clears its revoke audit fields.
    await client.query(
      `insert into public.user_club_roles (user_id, club_id, role, is_active, granted_by_user_id, revoked_at, revoked_by_user_id)
       values ($1, $2, 'club_admin', true, $3, null, null)
       on conflict (user_id, club_id, role) do update
         set is_active = true,
             granted_by_user_id = excluded.granted_by_user_id,
             revoked_at = null,
             revoked_by_user_id = null,
             updated_at = now()`,
      [targetUserId, clubId, req.user.id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { status: 200, body: { ok: true, clubRoles: await loadClubRolesForUser(targetUserId) } };
}

async function revokeClubAdminRole(req, targetUserId, clubId) {
  if (!authzCanAssignClubRole(req.authz, clubId)) {
    return { status: 403, body: { error: "Only a platform admin, or this club's own admin, can remove club administrator access." } };
  }
  const club = await query(`select id, coalesce(is_active, true) as "isActive" from public.clubs where id = $1 limit 1`, [clubId]);
  if (!club.rows[0]) return { status: 404, body: { error: "Club not found." } };
  const clubIsActive = club.rows[0].isActive;

  const client = await pool.connect();
  try {
    await client.query("begin");
    // The LAST_CLUB_ADMIN invariant only protects ACTIVE clubs - an
    // archived club doesn't need to keep an admin forever, so the lock and
    // headcount check are skipped entirely for it. When the club is active,
    // the lock is held for the full decision AND the update below, in one
    // transaction - releasing it early would reopen the exact race this is
    // meant to close. Applies regardless of who the actor is (platform
    // admin included) - there is no bypass for this check.
    if (clubIsActive) {
      await lockClubAdminHeadcount(client, clubId);
      const qualifyingIds = await loadQualifyingClubAdminUserIds(client, clubId);
      const targetQualifies = qualifyingIds.some((id) => String(id) === String(targetUserId));
      if (targetQualifies && qualifyingIds.length <= 1) {
        await client.query("rollback");
        return { status: 409, body: { error: "LAST_CLUB_ADMIN" } };
      }
    }
    // Idempotent: if there's no active row for this (user, club) - already
    // revoked, or never granted - this affects zero rows and the request
    // still succeeds, returning the current (unchanged) role state.
    await client.query(
      `update public.user_club_roles
       set is_active = false, revoked_at = now(), revoked_by_user_id = $1, updated_at = now()
       where user_id = $2 and club_id = $3 and role = 'club_admin' and is_active = true`,
      [req.user.id, targetUserId, clubId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { status: 200, body: { ok: true, clubRoles: await loadClubRolesForUser(targetUserId) } };
}

async function grantTeamCoachRole(req, targetUserId, teamId) {
  if (!authzCanAssignTeamRole(req.authz, teamId)) {
    return { status: 403, body: { error: "Only a platform admin, or this team's club admin, can grant team coach access." } };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const [team, target] = await Promise.all([
      client.query(`select id from public.teams where id = $1 limit 1`, [teamId]),
      client.query(`select id from public.users where id = $1 limit 1`, [targetUserId]),
    ]);
    if (!team.rows[0]) {
      await client.query("rollback");
      return { status: 404, body: { error: "Team not found." } };
    }
    if (!target.rows[0]) {
      await client.query("rollback");
      return { status: 404, body: { error: "User not found." } };
    }
    await client.query(
      `insert into public.user_team_roles (user_id, team_id, role, is_active, granted_by_user_id, revoked_at, revoked_by_user_id)
       values ($1, $2, 'team_coach', true, $3, null, null)
       on conflict (user_id, team_id, role) do update
         set is_active = true,
             granted_by_user_id = excluded.granted_by_user_id,
             revoked_at = null,
             revoked_by_user_id = null,
             updated_at = now()`,
      [targetUserId, teamId, req.user.id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { status: 200, body: { ok: true, teamRoles: await loadTeamRolesForUser(targetUserId) } };
}

// No LAST_CLUB_ADMIN-style protection here on purpose - a team may
// legitimately sit without a coach for a while; only a club losing its
// last administrator is treated as an invariant worth blocking.
async function revokeTeamCoachRole(req, targetUserId, teamId) {
  if (!authzCanAssignTeamRole(req.authz, teamId)) {
    return { status: 403, body: { error: "Only a platform admin, or this team's club admin, can remove team coach access." } };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const team = await client.query(`select id from public.teams where id = $1 limit 1`, [teamId]);
    if (!team.rows[0]) {
      await client.query("rollback");
      return { status: 404, body: { error: "Team not found." } };
    }
    await client.query(
      `update public.user_team_roles
       set is_active = false, revoked_at = now(), revoked_by_user_id = $1, updated_at = now()
       where user_id = $2 and team_id = $3 and role = 'team_coach' and is_active = true`,
      [req.user.id, targetUserId, teamId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { status: 200, body: { ok: true, teamRoles: await loadTeamRolesForUser(targetUserId) } };
}

router.put("/users/:userId/club-roles/:clubId/:role", async (req, res, next) => {
  try {
    if (clean(req.params.role) !== "club_admin") return res.status(400).json({ error: "Unsupported club role." });
    const result = await grantClubAdminRole(req, clean(req.params.userId), clean(req.params.clubId));
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:userId/club-roles/:clubId/:role", async (req, res, next) => {
  try {
    if (clean(req.params.role) !== "club_admin") return res.status(400).json({ error: "Unsupported club role." });
    const result = await revokeClubAdminRole(req, clean(req.params.userId), clean(req.params.clubId));
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.put("/users/:userId/team-roles/:teamId/:role", async (req, res, next) => {
  try {
    if (clean(req.params.role) !== "team_coach") return res.status(400).json({ error: "Unsupported team role." });
    const result = await grantTeamCoachRole(req, clean(req.params.userId), clean(req.params.teamId));
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.delete("/users/:userId/team-roles/:teamId/:role", async (req, res, next) => {
  try {
    if (clean(req.params.role) !== "team_coach") return res.status(400).json({ error: "Unsupported team role." });
    const result = await revokeTeamCoachRole(req, clean(req.params.userId), clean(req.params.teamId));
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

// Legacy endpoints, kept only because the existing "Add or manage users"
// club/team assignment forms still call them - rewired onto the exact same
// service functions and checks above (no weaker parallel path). New code
// should use the explicit /users/:userId/club-roles|team-roles/:scopeId/:role
// endpoints instead.
router.post("/club-roles", async (req, res, next) => {
  try {
    const userId = clean(req.body?.userId);
    const clubId = clean(req.body?.clubId);
    if (!userId || !clubId) return res.status(400).json({ error: "User and club are required." });
    const result = await grantClubAdminRole(req, userId, clubId);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.post("/team-roles", async (req, res, next) => {
  try {
    const userId = clean(req.body?.userId);
    const teamId = clean(req.body?.teamId);
    if (!userId || !teamId) return res.status(400).json({ error: "User and team are required." });
    const result = await grantTeamCoachRole(req, userId, teamId);
    res.status(result.status).json(result.body);
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

// Returns each visible user's REAL role set - global, club, and team roles
// each as their own structured array (never collapsed into role_hint),
// plus isAthlete and derived capabilities - so a future frontend can render
// the account's full, actual access without guessing from role_hint. role_hint
// itself is still included as legacyDisplayRole (display text only, per the
// existing organization-view.js "role_hint" badge - never read as a real
// role list) alongside the raw role_hint field the current frontend already
// depends on.
// The exact policy setUserLoginStatus enforces (mirrored here, not
// duplicated with different logic): a platform admin can manage anyone;
// anyone else only an account they created, and never a platform admin
// account. Feeds the informational canManageLogin flag GET /organization
// returns per user, so the frontend can decide whether to even offer the
// Enable/Disable login control - the backend endpoint itself remains the
// real enforcement point regardless of what this flag says.
function canManageLoginFor({ actorIsPlatformAdmin, ownsTarget, targetIsPlatformAdmin }) {
  return actorIsPlatformAdmin || (ownsTarget && !targetIsPlatformAdmin);
}

async function loadUsers(req) {
  const actorIsPlatformAdmin = isPlatformAdministrator(req.authz);
  const result = await query(
    `select distinct
       u.id, u.email, coalesce(u.display_name, u.full_name, u.email) as name,
       u.role_hint, u.created_by_user_id,
       u.is_active as login_active,
       exists (select 1 from public.athletes ath where ath.user_id = u.id) as is_athlete,
       coalesce(global_roles.data, '[]'::jsonb) as global_roles,
       coalesce(club_roles.data, '[]'::jsonb) as club_roles,
       coalesce(team_roles.data, '[]'::jsonb) as team_roles
     from public.users u
     left join lateral (
       select jsonb_agg(jsonb_build_object(
         'role', g.role,
         'isActive', g.is_active,
         'grantedByUserId', g.granted_by_user_id,
         'revokedAt', g.revoked_at,
         'revokedByUserId', g.revoked_by_user_id,
         'createdAt', g.created_at,
         'updatedAt', g.updated_at
       ) order by g.role) as data
       from public.user_global_roles g
       where g.user_id = u.id
     ) global_roles on true
     left join lateral (
       select jsonb_agg(jsonb_build_object(
         'clubId', ucr.club_id,
         'clubName', c.name,
         'role', ucr.role,
         'isActive', ucr.is_active
       ) order by c.name) as data
       from public.user_club_roles ucr
       join public.clubs c on c.id = ucr.club_id
       where ucr.user_id = u.id
     ) club_roles on true
     left join lateral (
       select jsonb_agg(jsonb_build_object(
         'teamId', utr.team_id,
         'teamName', t.name,
         'clubId', t.club_id,
         'role', utr.role,
         'isActive', utr.is_active
       ) order by t.name) as data
       from public.user_team_roles utr
       join public.teams t on t.id = utr.team_id
       where utr.user_id = u.id
     ) team_roles on true
     where (
         -- Excludes only accounts whose SOLE real identity is an athlete
         -- profile with no staff-ish role of any kind - never role_hint. A
         -- multi-role athlete+staff account (any active global/club/team
         -- role) must still appear here even if role_hint says "athlete".
         not exists (select 1 from public.athletes ath where ath.user_id = u.id)
         or exists (select 1 from public.user_global_roles ugr where ugr.user_id = u.id and ugr.is_active = true)
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
    [req.user.id, actorIsPlatformAdmin],
  );
  return result.rows.map((row) => {
    const activeGlobalRoles = new Set(row.global_roles.filter((r) => r.isActive).map((r) => r.role));
    const hasActiveClubRole = row.club_roles.some((r) => r.isActive);
    const hasActiveTeamRole = row.team_roles.some((r) => r.isActive);
    const platformAdministration = activeGlobalRoles.has("platform_admin");
    const coachWorkspace = platformAdministration || hasActiveClubRole || hasActiveTeamRole || activeGlobalRoles.has("independent_coach");
    const ownsTarget = String(row.created_by_user_id) === String(req.user.id);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role_hint: row.role_hint,
      legacyDisplayRole: row.role_hint,
      loginActive: row.login_active,
      isAthlete: row.is_athlete,
      globalRoles: row.global_roles,
      clubRoles: row.club_roles,
      teamRoles: row.team_roles,
      canManageLogin: canManageLoginFor({ actorIsPlatformAdmin, ownsTarget, targetIsPlatformAdmin: platformAdministration }),
      capabilities: {
        coachWorkspace,
        athleteWorkspace: row.is_athlete,
        platformAdministration,
      },
    };
  });
}

// Takes the full req (not req.user) - canManageAthlete reads req.authz,
// loaded once per request by attachAuthorizationContext. This previously
// took req.user by mistake, so req.authz was undefined inside
// canManageAthlete and any GET /organization request that actually had a
// pending/decided program-access row to check crashed with a 500 (same
// class of bug as the earlier resolveAthleteClubTeam fix, just in a
// function Phase 3 never touched, so it stayed dormant until production
// data happened to include a matching program_access row).
async function loadProgramAccessRequests(req) {
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
    if (await canManageAthlete(req, row.athlete_id)) visible.push(row);
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
       -- True only when the viewer has a currently ACTIVE tie to this
       -- athlete (platform admin, is the athlete themselves, an active
       -- private-coach relationship, or an active team/club membership in a
       -- team/club they manage). The row can still be RETURNED by the query
       -- below when only an archived tie remains (so Show archived/Restore
       -- work) - this flag is what the frontend must use to decide whether
       -- the row belongs in the normal active list, never is_active alone.
       -- coalesced to false: a.user_id = $1 is NULL (not false) whenever
       -- a.user_id itself is NULL, and NULL would otherwise propagate through
       -- the ORs and surface as SQL NULL / JS null in the JSON response
       -- instead of a clean boolean (a WHERE clause silently treats NULL as
       -- "no match", but a plain SELECTed column does not get that same
       -- coercion).
       coalesce(
         $2::boolean
         or a.user_id = $1
         or exists (select 1 from public.user_athletes ua_access where ua_access.user_id = $1 and ua_access.athlete_id = a.id and ua_access.is_active = true)
         or exists (
           select 1
           from public.user_team_roles utr_access
           join public.athlete_memberships tm_access
             on tm_access.team_id = utr_access.team_id and tm_access.membership_type = 'team' and tm_access.status = 'active'
           where utr_access.user_id = $1 and utr_access.is_active = true and tm_access.athlete_id = a.id
         )
         or exists (
           select 1
           from public.user_club_roles ucr_access
           join public.athlete_memberships cm_access
             on cm_access.club_id = ucr_access.club_id and cm_access.membership_type = 'club' and cm_access.status = 'active'
           where ucr_access.user_id = $1 and ucr_access.is_active = true and cm_access.athlete_id = a.id
         ),
         false
       ) as has_active_access,
       -- True when the linked account also holds any real staff/coach/admin
       -- capability, so the frontend can show a locked "multi-role" state
       -- instead of a plain toggle (see PUT /athletes/:id/login-status,
       -- which independently re-checks this server-side regardless of what
       -- the client renders). Mirrors that same endpoint's targetAuthz check
       -- (platformRoles/isIndependentCoach via user_global_roles, plus
       -- clubRoles/teamRoles) exactly - never role_hint, which can now
       -- disagree with reality in both directions (a role_hint='athlete'
       -- account can genuinely hold a real staff role, and a stale staff
       -- role_hint with no matching row grants nothing).
       case when a.user_id is null then false else (
         exists (select 1 from public.user_global_roles ugr4 where ugr4.user_id = a.user_id and ugr4.is_active = true)
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
