// Group athlete join links: a link tied to a CONTEXT (private_coach/club/
// team), not to any pre-existing athlete profile. Many different people can
// submit a request against the same link; each request (an
// athlete_join_applications row) is reviewed and approved/rejected
// independently, and only approval ever creates a login/athlete
// profile/membership. This is deliberately separate from
// backend/src/inviteContext.js (single-athlete invites) - no code here is
// shared with it beyond following the same shape of pattern (context
// permission matrix, a per-entity advisory lock, "resolve without mutation,
// then lock, then re-check").
import { canManageTeamById, isPlatformAdministrator } from "./authz.js";

export const JOIN_LINK_CONTEXT_TYPES = new Set(["private_coach", "club", "team"]);

// Shared lock namespace serializing every mutation that can affect a given
// join link: creating a new pending application against it, regenerating its
// token, revoking it, and approving/rejecting any of its applications. All
// of these acquire this SAME lock, keyed by join_link_id alone, before
// reading or writing anything another one of them could also read or write
// (the link's own is_active/approved_uses/token_hash, and its applications).
// A distinct constant from inviteContext.js's ATHLETE_INVITE_ACTION_LOCK_NAMESPACE -
// never reused, never changed.
const JOIN_LINK_ACTION_LOCK_NAMESPACE = 719402617;

export async function lockJoinLinkActions(executor, joinLinkId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [JOIN_LINK_ACTION_LOCK_NAMESPACE, String(joinLinkId)]);
}

export function joinLinkContextShapeValid(contextType, contextId) {
  if (!JOIN_LINK_CONTEXT_TYPES.has(contextType)) return false;
  if (contextType === "club" || contextType === "team") return Boolean(contextId);
  return !contextId;
}

// The gate for CREATING a join link in a given context - explicit per
// context, never falls back to the broad canManageAthlete (there is no
// athlete yet) and never reads role_hint.
export function canCreateJoinLinkInContext(req, contextType, contextId) {
  const authz = req.authz;
  if (contextType === "private_coach") {
    if (!authz.isIndependentCoach) {
      return { ok: false, status: 403, error: "Only an independent/private coach can create a private coaching join link." };
    }
    return { ok: true };
  }
  if (contextType === "club") {
    const canManage = isPlatformAdministrator(authz) || authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(contextId));
    if (!canManage) return { ok: false, status: 403, error: "You are not a club admin for this club." };
    return { ok: true };
  }
  if (contextType === "team") {
    if (!canManageTeamById(authz, contextId)) {
      return { ok: false, status: 403, error: "You are not a coach or club admin for this team." };
    }
    return { ok: true };
  }
  return { ok: false, status: 400, error: "UNSUPPORTED_JOIN_LINK_CONTEXT" };
}

// The gate for MANAGING (viewing details for regenerate/revoke, and for
// listing) an existing link - uses the link's OWN stored context, never a
// client-supplied one. A platform admin may always manage any link, but the
// link itself must still be a real private/club/team context (platform-wide
// links are never created in the first place). A private_coach link is a 1:1
// scope tied to the specific creator - only that creator (while they still
// hold the role) may manage it. club/team may be managed by ANY current
// holder of that role, not just the original creator.
export function canManageJoinLink(req, link) {
  const authz = req.authz;
  if (isPlatformAdministrator(authz)) return { ok: true };
  if (link.context_type === "private_coach") {
    if (String(req.user.id) !== String(link.created_by_user_id)) {
      return { ok: false, status: 403, error: "Only the coach who created this join link can manage it." };
    }
    if (!authz.isIndependentCoach) {
      return { ok: false, status: 403, error: "You no longer hold an active private coaching role." };
    }
    return { ok: true };
  }
  if (link.context_type === "club") {
    const canManage = authz.clubRoles.some((r) => r.role === "club_admin" && String(r.clubId) === String(link.context_id));
    if (!canManage) return { ok: false, status: 403, error: "You are not a club admin for this club." };
    return { ok: true };
  }
  if (link.context_type === "team") {
    if (!canManageTeamById(authz, link.context_id)) {
      return { ok: false, status: 403, error: "You are not a coach or club admin for this team." };
    }
    return { ok: true };
  }
  return { ok: false, status: 403, error: "UNSUPPORTED_JOIN_LINK_CONTEXT" };
}

// Reviewing a specific pending application uses the exact same authority as
// managing the link itself - "another current holder of the same club/team
// role may review", "a private_coach link stays tied to its one creator".
export const canReviewJoinApplication = canManageJoinLink;

// Whether the CONTEXT backing this link is still real right now - the
// private_coach creator must still hold the role, or the club/team must
// still be active (not archived). This is what stops an application from
// being approved once the coach who created the link has lost their role, or
// the club/team has since been archived (per phase spec section 18),
// independent of whether the acting reviewer individually has permission.
export async function isJoinLinkContextStillValid(executor, link) {
  if (link.context_type === "private_coach") {
    const stillCoach = await executor(
      `select 1 from public.user_global_roles where user_id = $1 and role = 'independent_coach' and is_active = true limit 1`,
      [link.created_by_user_id],
    );
    return stillCoach.rowCount > 0;
  }
  if (link.context_type === "club") {
    const club = await executor(`select coalesce(is_active, true) as is_active from public.clubs where id = $1 limit 1`, [link.context_id]);
    return Boolean(club.rows[0]?.is_active);
  }
  if (link.context_type === "team") {
    const team = await executor(
      `select t.id, coalesce(t.is_active, true) as team_active, coalesce(c.is_active, true) as club_active
       from public.teams t
       join public.clubs c on c.id = t.club_id
       where t.id = $1
       limit 1`,
      [link.context_id],
    );
    if (!team.rows[0]) return false;
    return Boolean(team.rows[0].team_active) && Boolean(team.rows[0].club_active);
  }
  return false;
}

export function joinLinkIsWithinCapacity(link) {
  if (link.max_uses == null) return true;
  return Number(link.approved_uses) < Number(link.max_uses);
}

export function joinLinkStatus(link) {
  if (link.revoked_at) return "revoked";
  if (new Date(link.expires_at) <= new Date()) return "expired";
  if (!joinLinkIsWithinCapacity(link)) return "full";
  return "active";
}

// Shared by GET /join-links/:token, POST /join-links/:token/apply, and POST
// /join-links/:token/apply-existing - the single definition of "is this link
// currently usable for a NEW application". `executor` is a callable (text,
// params) => Promise<{rows}> - pass the plain query() function for a
// read-only lookup, or client.query bound to an open transaction when the
// caller is about to mutate. Returns null (never a distinguishing reason)
// for not-found, inactive/revoked, expired, at-capacity, or
// context-no-longer-valid alike - callers must always surface the same
// generic "This join link is invalid or no longer available." regardless of
// which of those it was.
export async function loadUsableJoinLink(executor, tokenHash, { forUpdate = false } = {}) {
  const result = await executor(
    `select l.id, l.token_hash, l.context_type, l.context_id, l.created_by_user_id, l.label,
            l.expires_at, l.max_uses, l.approved_uses, l.is_active, l.revoked_at
     from public.athlete_join_links l
     where l.token_hash = $1
     limit 1
     ${forUpdate ? "for update of l" : ""}`,
    [tokenHash],
  );
  const link = result.rows[0];
  if (!link) return null;
  if (!link.is_active || link.revoked_at) return null;
  if (new Date(link.expires_at) <= new Date()) return null;
  if (!joinLinkIsWithinCapacity(link)) return null;
  const contextValid = await isJoinLinkContextStillValid(executor, link);
  if (!contextValid) return null;
  return link;
}

// Resolves a human-readable name for the link's context, for the public GET
// /join-links/:token response only - never the creator's email or any other
// internal identity/role detail.
export async function loadJoinLinkContextName(executor, link) {
  if (link.context_type === "private_coach") {
    const coach = await executor(
      `select coalesce(display_name, full_name, email) as name from public.users where id = $1 limit 1`,
      [link.created_by_user_id],
    );
    return coach.rows[0]?.name || "Private coach";
  }
  if (link.context_type === "club") {
    const club = await executor(`select name from public.clubs where id = $1 limit 1`, [link.context_id]);
    return club.rows[0]?.name || "Club";
  }
  if (link.context_type === "team") {
    const team = await executor(`select name from public.teams where id = $1 limit 1`, [link.context_id]);
    return team.rows[0]?.name || "Team";
  }
  return "";
}
