// Athlete invite lifecycle (Phase 6): every invite still targets exactly one
// existing athlete profile (never a group/join link), but now remembers
// which CONTEXT it was created from - private_coach/club/team/platform -
// and every action against it re-derives permission from that context and
// req.authz, never from role_hint and never from the broad, scope-agnostic
// canManageAthlete (which would let a club_admin, say, invite via a context
// they don't actually hold, since it can't tell WHICH relationship is
// granting access).
import { canManageTeamById, isPlatformAdministrator } from "./authz.js";

// The set of context types the CURRENT invite-creation endpoint may write.
// 'legacy' is deliberately excluded - it is only ever assigned once, by the
// 20260806_athlete_invites_context.sql migration, to invite rows that
// predate context tracking entirely. No code path ever creates a new
// 'legacy' row.
export const INVITE_CONTEXT_TYPES = new Set(["platform", "private_coach", "club", "team"]);

// Shared lock namespace serializing every mutation that can affect a given
// athlete's invite/login state: creating or regenerating an invite in ANY
// context, accepting one, linking one to an existing account, and revoking
// one. All four acquire this SAME lock, keyed by athlete_id ALONE (never by
// context too), before reading or writing anything that another one of
// these four could also read or write - athletes.user_id and the invite
// row(s) for this athlete. Because every caller takes exactly this one
// lock and nothing else, there is no ordering to get wrong and therefore no
// way for these four operations to deadlock against each other. The key
// carries no meaning beyond "this one lock namespace" and must never change
// or be reused elsewhere.
const ATHLETE_INVITE_ACTION_LOCK_NAMESPACE = 719402583;

export async function lockAthleteInviteActions(executor, athleteId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [ATHLETE_INVITE_ACTION_LOCK_NAMESPACE, String(athleteId)]);
}

export function inviteContextShapeValid(contextType, contextId) {
  if (!INVITE_CONTEXT_TYPES.has(contextType)) return false;
  if (contextType === "club" || contextType === "team") return Boolean(contextId);
  return !contextId;
}

// The actual gate for CREATING a new invite in a given context - explicit
// per context, never falls back to canManageAthlete. Never bypassed by
// role_hint.
export async function canCreateInviteInContext(executor, req, athleteId, contextType, contextId) {
  const authz = req.authz;
  if (contextType === "platform") {
    if (!isPlatformAdministrator(authz)) {
      return { ok: false, status: 403, error: "Only a platform admin can send a platform-level invite." };
    }
    return { ok: true };
  }

  if (contextType === "private_coach") {
    if (!authz.isIndependentCoach) {
      return { ok: false, status: 403, error: "Only an independent/private coach can send a private coaching invite." };
    }
    const relationship = await executor(
      `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true limit 1`,
      [req.user.id, athleteId],
    );
    if (!relationship.rowCount) {
      return { ok: false, status: 403, error: "You must have an active private coaching relationship with this athlete." };
    }
    return { ok: true };
  }

  if (contextType === "club") {
    const canManage = isPlatformAdministrator(authz) || authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(contextId));
    if (!canManage) return { ok: false, status: 403, error: "You are not a club admin for this club." };
    const membership = await executor(
      `select 1 from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active' limit 1`,
      [athleteId, contextId],
    );
    if (!membership.rowCount) return { ok: false, status: 403, error: "This athlete is not an active member of this club." };
    return { ok: true };
  }

  if (contextType === "team") {
    if (!canManageTeamById(authz, contextId)) {
      return { ok: false, status: 403, error: "You are not a coach or club admin for this team." };
    }
    const membership = await executor(
      `select 1 from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team' and status = 'active' limit 1`,
      [athleteId, contextId],
    );
    if (!membership.rowCount) return { ok: false, status: 403, error: "This athlete is not an active member of this team." };
    return { ok: true };
  }

  return { ok: false, status: 400, error: "UNSUPPORTED_INVITE_CONTEXT" };
}

// The gate for REVOKING an existing invite - uses the invite's OWN stored
// context, never a client-supplied one. A platform admin may always revoke.
// A club/team context may be revoked by ANY current holder of that role
// (not just the original inviter) - "drugi aktuelni club admin istog kluba"
// etc. A private_coach invite is tied to one specific 1:1 relationship, so
// only the original inviter, and only while they still hold that exact
// active relationship, may revoke it.
export async function canRevokeInvite(executor, req, invite) {
  const authz = req.authz;
  if (isPlatformAdministrator(authz)) return { ok: true };

  if (invite.context_type === "platform") {
    return { ok: false, status: 403, error: "Only a platform admin can revoke a platform-level invite." };
  }

  if (invite.context_type === "private_coach") {
    if (String(req.user.id) !== String(invite.invited_by_user_id)) {
      return { ok: false, status: 403, error: "Only the coach who sent this invite can revoke it." };
    }
    if (!authz.isIndependentCoach) {
      return { ok: false, status: 403, error: "You no longer hold an active private coaching role." };
    }
    const relationship = await executor(
      `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true limit 1`,
      [req.user.id, invite.athlete_id],
    );
    if (!relationship.rowCount) {
      return { ok: false, status: 403, error: "You no longer have an active coaching relationship with this athlete." };
    }
    return { ok: true };
  }

  if (invite.context_type === "club") {
    const canManage = authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(invite.context_id));
    if (!canManage) return { ok: false, status: 403, error: "You are not a club admin for this club." };
    return { ok: true };
  }

  if (invite.context_type === "team") {
    if (!canManageTeamById(authz, invite.context_id)) {
      return { ok: false, status: 403, error: "You are not a coach or club admin for this team." };
    }
    return { ok: true };
  }

  if (invite.context_type === "legacy") {
    // No recorded context to check a specific role against - allow revoke
    // by anyone who currently has ANY real active access to this athlete
    // (mirrors isInviteContextStillValid's legacy check below), not only
    // the original inviter, matching how club/team already work.
    if (authz.isIndependentCoach) {
      const relationship = await executor(
        `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true limit 1`,
        [req.user.id, invite.athlete_id],
      );
      if (relationship.rowCount) return { ok: true };
    }
    const clubAdmin = await executor(
      `select 1
       from public.user_club_roles ucr
       join public.athlete_memberships am
         on am.club_id = ucr.club_id and am.membership_type = 'club' and am.status = 'active'
       where ucr.user_id = $1 and ucr.role = 'club_admin' and ucr.is_active = true and am.athlete_id = $2
       limit 1`,
      [req.user.id, invite.athlete_id],
    );
    if (clubAdmin.rowCount) return { ok: true };
    const teamCoach = await executor(
      `select 1
       from public.user_team_roles utr
       join public.athlete_memberships am
         on am.team_id = utr.team_id and am.membership_type = 'team' and am.status = 'active'
       where utr.user_id = $1 and utr.role = 'team_coach' and utr.is_active = true and am.athlete_id = $2
       limit 1`,
      [req.user.id, invite.athlete_id],
    );
    if (teamCoach.rowCount) return { ok: true };
    return { ok: false, status: 403, error: "You do not have active access to this athlete." };
  }

  return { ok: false, status: 403, error: "UNSUPPORTED_INVITE_CONTEXT" };
}

// Re-checked immediately before GET/accept/link ever act on a token - the
// relationship/membership/role the invite was ORIGINALLY issued from must
// still be real right now, not just at creation time. This is what stops a
// stale link from resurrecting a club/team/coach relationship that was
// archived in the meantime. Checks the ORIGINAL INVITER's continued
// standing for club/team/platform (not merely "does someone still hold this
// role"), matching how revoke works - if the person whose authority backed
// this invite has since lost it, the chain of custody is broken even though
// the token itself hasn't expired.
export async function isInviteContextStillValid(executor, invite) {
  if (invite.context_type === "platform") {
    const admin = await executor(
      `select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active = true limit 1`,
      [invite.invited_by_user_id],
    );
    return admin.rowCount > 0;
  }

  if (invite.context_type === "private_coach") {
    const relationship = await executor(
      `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true limit 1`,
      [invite.invited_by_user_id, invite.athlete_id],
    );
    return relationship.rowCount > 0;
  }

  if (invite.context_type === "club") {
    const [membership, inviterStillAdmin] = await Promise.all([
      executor(
        `select 1 from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' and status = 'active' limit 1`,
        [invite.athlete_id, invite.context_id],
      ),
      executor(
        `select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin' and is_active = true limit 1`,
        [invite.invited_by_user_id, invite.context_id],
      ),
    ]);
    return membership.rowCount > 0 && inviterStillAdmin.rowCount > 0;
  }

  if (invite.context_type === "team") {
    const membership = await executor(
      `select 1 from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team' and status = 'active' limit 1`,
      [invite.athlete_id, invite.context_id],
    );
    if (!membership.rowCount) return false;
    // Mirrors canManageTeamById: the inviter still qualifies if they're
    // currently team_coach of this exact team, or still club_admin of the
    // club that owns it.
    const teamRow = await executor(`select club_id from public.teams where id = $1 limit 1`, [invite.context_id]);
    const clubId = teamRow.rows[0]?.club_id;
    const stillQualifies = await executor(
      `select 1 from public.user_team_roles where user_id = $1 and team_id = $2 and role = 'team_coach' and is_active = true
       union
       select 1 from public.user_club_roles where user_id = $1 and club_id = $3 and role = 'club_admin' and is_active = true
       limit 1`,
      [invite.invited_by_user_id, invite.context_id, clubId],
    );
    return stillQualifies.rowCount > 0;
  }

  if (invite.context_type === "legacy") {
    // A historical invite from before context tracking existed (backfilled
    // by the migration - see its comment). Its real originating context was
    // never recorded and is never guessed at here. Instead: valid as long
    // as the original inviter has ANY real, currently active access to this
    // athlete - platform_admin, an active private-coach relationship, an
    // active club_admin role together with the athlete's active membership
    // in that same club, or an active team_coach role together with the
    // athlete's active membership in that same team. Never role_hint.
    // Accepting a legacy invite still only links the existing profile to a
    // user account, exactly like every other context - it never creates or
    // reactivates a relationship, so there is no membership to widen here.
    const admin = await executor(
      `select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active = true limit 1`,
      [invite.invited_by_user_id],
    );
    if (admin.rowCount > 0) return true;

    const privateCoach = await executor(
      `select 1 from public.user_athletes where user_id = $1 and athlete_id = $2 and relationship_type = 'coach' and is_active = true limit 1`,
      [invite.invited_by_user_id, invite.athlete_id],
    );
    if (privateCoach.rowCount > 0) return true;

    const clubAdmin = await executor(
      `select 1
       from public.user_club_roles ucr
       join public.athlete_memberships am
         on am.club_id = ucr.club_id and am.membership_type = 'club' and am.status = 'active'
       where ucr.user_id = $1 and ucr.role = 'club_admin' and ucr.is_active = true and am.athlete_id = $2
       limit 1`,
      [invite.invited_by_user_id, invite.athlete_id],
    );
    if (clubAdmin.rowCount > 0) return true;

    const teamCoach = await executor(
      `select 1
       from public.user_team_roles utr
       join public.athlete_memberships am
         on am.team_id = utr.team_id and am.membership_type = 'team' and am.status = 'active'
       where utr.user_id = $1 and utr.role = 'team_coach' and utr.is_active = true and am.athlete_id = $2
       limit 1`,
      [invite.invited_by_user_id, invite.athlete_id],
    );
    return teamCoach.rowCount > 0;
  }

  return false;
}

// Shared by GET /invites/:token, POST /invites/:token/accept, and POST
// /invites/:token/link - the single definition of "is this token currently
// usable". `executor` is a callable (text, params) => Promise<{rows}> - pass
// the plain query() function for a read-only lookup, or client.query bound
// to an open transaction when the caller is about to mutate. Returns null
// (never a distinguishing reason) for not-found, expired, revoked, accepted,
// or context-no-longer-valid alike - callers must always surface the same
// generic "Invite is invalid or expired" regardless of which of those it
// was, so a link can never be used to probe whether it was revoked vs.
// expired vs. never existed.
export async function loadUsableInvite(executor, tokenHash, { forUpdate = false } = {}) {
  const result = await executor(
    `select i.id, i.email, i.athlete_id, i.context_type, i.context_id, i.invited_by_user_id, i.expires_at,
            a.user_id as athlete_user_id,
            coalesce(a.display_name, a.full_name, a.athlete_id, i.email) as athlete_name,
            a.athlete_id as athlete_code
     from public.athlete_invites i
     join public.athletes a on a.id = i.athlete_id
     where i.token_hash = $1
       and i.accepted_at is null
       and i.revoked_at is null
       and i.expires_at > now()
     limit 1
     ${forUpdate ? "for update of i" : ""}`,
    [tokenHash],
  );
  const invite = result.rows[0];
  if (!invite) return null;
  const contextValid = await isInviteContextStillValid(executor, invite);
  if (!contextValid) return null;
  return invite;
}
