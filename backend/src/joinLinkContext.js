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
import { revokeActiveEmailVerificationTokensForJoinLink } from "./emailVerification.js";

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

// A SECOND, independent lock namespace keyed by applicant_user_id (never
// join_link_id) - held only inside POST .../approve's existing-account
// branch, around the "does this account already have an athlete profile"
// check-then-create. Two applications against two DIFFERENT join links for
// the SAME existing account each hold a different lockJoinLinkActions key
// (their own link's id), so that lock alone cannot serialize them against
// each other - both could see athletes.user_id as still empty and both
// attempt to insert a new athletes row, tripping the athletes_user_id_unique
// partial index on whichever loses and surfacing as an unhandled 500 instead
// of a clean, successful re-use of the same profile. This lock closes
// exactly that gap. A distinct constant from both
// JOIN_LINK_ACTION_LOCK_NAMESPACE above and
// inviteContext.js's ATHLETE_INVITE_ACTION_LOCK_NAMESPACE - never reused. No
// deadlock risk: every caller acquires its own join-link lock first and this
// user lock second, always in that order, and never holds two different
// join-link locks at once.
const APPLICANT_ATHLETE_CREATION_LOCK_NAMESPACE = 719402629;

export async function lockApplicantAthleteCreation(executor, userId) {
  await executor(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [APPLICANT_ATHLETE_CREATION_LOCK_NAMESPACE, String(userId)]);
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

// Closes out every still-open (pending or requires_login) application for a
// join link that has become permanently unusable for NEW activity - expired,
// revoked, or its backing context (an archived club/team, or a private coach
// who has lost the independent_coach role) is no longer real. Deliberately
// does NOT trigger on "full" (max_uses reached) alone - a full link is still
// a real, valid link whose outstanding requests may still legitimately be
// rejected, just never approved past capacity. Idempotent: a no-op once
// nothing matches (already cancelled, or the link never had anything
// pending), and never touches an already-approved/rejected/cancelled row.
// No single human "reviewed" this closure, so reviewed_by_user_id is left
// null - distinct from an explicit revoke's cascade (see
// backend/src/routes/organization.js's DELETE .../athlete-join-links/:linkId,
// which sets it to the revoking admin and is left untouched by this
// function).
//
// Must be called with `executor` bound to a transaction that already holds
// lockJoinLinkActions for this exact link.id (see
// backend/src/routes/organization.js's sweepUnusableJoinLink, and the
// approve/reject handlers, which all call this immediately after loading the
// link FOR UPDATE under that lock) - there is no background job scheduler in
// this codebase, so an authenticated viewer loading (GET
// /api/organization[/athlete-join-links]) or acting on (approve/reject) a
// link is what actually performs this sweep, opportunistically, the next
// time anyone with real access looks at it.
export async function closeUnusableJoinLinkApplications(executor, link) {
  const isExpired = new Date(link.expires_at) <= new Date();
  const isRevoked = !link.is_active || Boolean(link.revoked_at);
  const contextValid = isExpired || isRevoked ? false : await isJoinLinkContextStillValid(executor, link);
  if (!isExpired && !isRevoked && contextValid) return 0;
  const result = await executor(
    `update public.athlete_join_applications
     set status = 'cancelled', password_hash = null, reviewed_at = now(), updated_at = now()
     where join_link_id = $1 and status in ('pending', 'requires_login')`,
    [link.id],
  );
  // Any still-active email-verification token for one of the applications
  // just cancelled above would otherwise remain a live, clickable link to
  // nowhere-useful indefinitely - see backend/src/emailVerification.js.
  await revokeActiveEmailVerificationTokensForJoinLink(executor, link.id);
  return result.rowCount;
}

// perf/join-link-cleanup: batch, READ-ONLY prefilter for
// loadJoinLinksForWorkspace (backend/src/routes/organization.js) - answers
// "which of these links might closeUnusableJoinLinkApplications actually
// need to touch?" for many links in one pass, using at most 3 extra queries
// total (one each for private_coach creators / clubs / teams among the
// candidates - never one query per link, and zero when nothing needs a
// context check). This is ONLY an optimization: every id it returns still
// goes through the exact same lock -> re-fetch FOR UPDATE -> re-check
// -> mutate sequence as before (see organization.js's sweepUnusableJoinLink)
// - this function only decides whether that sequence runs AT ALL, never
// what it does once it runs. A link this misses as a false negative (its
// context changed in the instant between this read and the caller's lock)
// is caught the next time anyone with real access loads it, or the moment
// anyone approves/rejects one of its applications directly - exactly the
// same "opportunistic, eventually swept" characteristic the unbatched
// version already had, not a new one introduced by batching.
//
// `links` must carry the same shape loadJoinLinksForWorkspace's own SELECT
// already produces (id, context_type, context_id, created_by_user_id,
// expires_at, is_active, revoked_at) - no separate query needed to obtain
// it. Only links already known to have a pending_count > 0 should be passed
// in; a link with nothing pending has nothing this could ever flag anyway.
export async function findJoinLinkIdsNeedingCleanupCheck(executor, links) {
  const now = new Date();
  const candidateIds = new Set();
  const needsContextCheck = [];
  for (const link of links) {
    const isExpired = new Date(link.expires_at) <= now;
    const isRevoked = !link.is_active || Boolean(link.revoked_at);
    if (isExpired || isRevoked) {
      candidateIds.add(String(link.id));
      continue;
    }
    needsContextCheck.push(link);
  }
  if (!needsContextCheck.length) return candidateIds;

  const privateCoachCreatorIds = [...new Set(
    needsContextCheck.filter((link) => link.context_type === "private_coach").map((link) => link.created_by_user_id),
  )];
  const clubContextIds = [...new Set(
    needsContextCheck.filter((link) => link.context_type === "club").map((link) => link.context_id),
  )];
  const teamContextIds = [...new Set(
    needsContextCheck.filter((link) => link.context_type === "team").map((link) => link.context_id),
  )];

  const [activeCoachRows, clubRows, teamRows] = await Promise.all([
    privateCoachCreatorIds.length
      ? executor(
          `select user_id from public.user_global_roles where role = 'independent_coach' and is_active = true and user_id = any($1::uuid[])`,
          [privateCoachCreatorIds],
        )
      : Promise.resolve({ rows: [] }),
    clubContextIds.length
      ? executor(`select id, coalesce(is_active, true) as is_active from public.clubs where id = any($1::uuid[])`, [clubContextIds])
      : Promise.resolve({ rows: [] }),
    teamContextIds.length
      ? executor(
          `select t.id, coalesce(t.is_active, true) as team_active, coalesce(c.is_active, true) as club_active
           from public.teams t
           join public.clubs c on c.id = t.club_id
           where t.id = any($1::uuid[])`,
          [teamContextIds],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const activeCoachIds = new Set(activeCoachRows.rows.map((row) => String(row.user_id)));
  const clubIsActive = new Map(clubRows.rows.map((row) => [String(row.id), Boolean(row.is_active)]));
  const teamIsActive = new Map(teamRows.rows.map((row) => [String(row.id), Boolean(row.team_active) && Boolean(row.club_active)]));

  for (const link of needsContextCheck) {
    let contextValid;
    if (link.context_type === "private_coach") contextValid = activeCoachIds.has(String(link.created_by_user_id));
    else if (link.context_type === "club") contextValid = clubIsActive.get(String(link.context_id)) === true;
    else if (link.context_type === "team") contextValid = teamIsActive.get(String(link.context_id)) === true;
    else contextValid = false;
    if (!contextValid) candidateIds.add(String(link.id));
  }
  return candidateIds;
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
