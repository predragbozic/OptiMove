// Central calendar (K2a) — who may write an event, for which owner, on which
// basis (docs/ai/central-calendar-k2a-plan.md, section 4.1; owner decisions
// D4, D6, D7 and D18), and the target rules of plan section 1.2 as the
// service checks them before the database's own triggers (migration v48).
//
// The workspace is resolved ONCE per request (resolveCalendarContext of
// calendarAccess.js) and threaded through; nothing here resolves it again.
// The basis a request writes on is re-checked by calendar.lock_event_writer()
// inside the transaction, with the role rows locked FOR SHARE — this module
// only decides what to ask the database for, never grants anything by itself.
import { holdsClubAdminRole, holdsTeamCoachRole, isPlatformAdministrator } from "./authz.js";
import { membershipOnDaySql } from "./calendarAccess.js";

export class EventError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

// A missing event and one the caller may not touch are the same answer
// (ADR-006); the router sends the one fixed body for every 404.
export const notFound = () => new EventError(404, "notFound", "Not found.");
export const forbidden = () => new EventError(403, "forbidden", "Forbidden");

export const EVENT_WRITE_BASES = Object.freeze(["platform_admin", "club_admin", "team_coach", "private_coach"]);

// The owner of a NEW event: the active workspace (D4 club, D6 team, D7 private
// coach). The platform workspace creates no event (no system-owned events,
// plan choice 9.11); the athlete workspace never writes.
export function eventOwnerForWorkspace(ctx) {
  if (ctx.type !== "coach") return null;
  const ws = ctx.workspace;
  if (ws.type === "club") return { scope: "club", clubId: String(ws.scopeId), teamId: null, userId: null, teamClubId: null, teamActive: true };
  if (ws.type === "team") return { scope: "team", clubId: null, teamId: String(ws.scopeId), userId: null, teamClubId: null, teamActive: true };
  if (ws.type === "private_coach") return { scope: "user", clubId: null, teamId: null, userId: String(ctx.userId), teamClubId: null, teamActive: true };
  return null;
}

// The owner of an existing row. The row carries the owner columns and, for a
// team-owned event, `owner_team_club_id` / `owner_team_active` from a
// `left join public.teams` the caller made — never read again here.
export function eventOwnerOfRow(row) {
  return {
    scope: row.owner_scope,
    clubId: row.owner_club_id ? String(row.owner_club_id) : null,
    teamId: row.owner_team_id ? String(row.owner_team_id) : null,
    userId: row.owner_user_id ? String(row.owner_user_id) : null,
    teamClubId: row.owner_team_club_id ? String(row.owner_team_club_id) : null,
    teamActive: row.owner_team_active !== false,
    clubActive: row.owner_club_active !== false,
    teamClubActive: row.owner_team_club_active !== false,
  };
}

// The basis on which THIS request may write the events of `owner`, or null.
//   platform workspace → platform_admin (support), any owner;
//   club workspace → club_admin for the club's own events AND for the events
//     of its active teams (D18); a platform admin in the club's workspace
//     writes as platform_admin;
//   team workspace → team_coach for the team's own events; a club admin who
//     opened the team's workspace writes as club_admin; never a club-owned
//     event (the team coach reads it, the panel offers nothing);
//   private coach → private_coach for the account's own events.
// An archived owner takes writes from the next level up only (plan 4.1,
// the manager's decision of 2026-10-30, so an archived team's or club's
// events can still be cancelled): an archived team of an active club → its
// club's admin or the platform admin, never the team coach; an archived club
// (an archived team's club included) → the platform admin only. The lock
// function refuses the same bases, so `canManage` and the write verdict
// agree.
export function eventWriteBasis(ctx, owner) {
  if (ctx.type !== "coach" || !owner) return null;
  const teamArchived = owner.scope === "team" && owner.teamActive === false;
  const clubArchived = (owner.scope === "club" && owner.clubActive === false) || (owner.scope === "team" && owner.teamClubActive === false);
  const { workspace: ws, authz } = ctx;
  const platform = isPlatformAdministrator(authz) ? "platform_admin" : null;
  if (ws.type === "platform") return platform;
  if (ws.type === "club") {
    const club = String(ws.scopeId);
    const inClub = (owner.scope === "club" && owner.clubId === club) || (owner.scope === "team" && owner.teamClubId === club);
    if (!inClub) return null;
    if (!clubArchived && holdsClubAdminRole(authz, club)) return "club_admin";
    return platform;
  }
  if (ws.type === "team") {
    if (owner.scope !== "team" || owner.teamId !== String(ws.scopeId)) return null;
    if (!teamArchived && !clubArchived && holdsTeamCoachRole(authz, owner.teamId)) return "team_coach";
    if (!clubArchived && owner.teamClubId && holdsClubAdminRole(authz, owner.teamClubId)) return "club_admin";
    return platform;
  }
  if (ws.type === "private_coach") {
    if (owner.scope !== "user" || owner.userId !== String(ctx.userId)) return null;
    return authz.isIndependentCoach ? "private_coach" : null;
  }
  return null;
}

// The owner id the lock function takes for an owner.
export function eventOwnerId(owner) {
  if (owner.scope === "club") return owner.clubId;
  if (owner.scope === "team") return owner.teamId;
  return owner.userId;
}

// The event types an owner's events may use (plan section 6): a club's own
// copy for club- and team-owned events, the system set for a private coach
// (and for the platform workspace's read of the catalog). `alias` is the
// calendar.event_types alias; the fragment appends its parameter.
export function eventTypesOwnerSql(owner, alias, params) {
  const club = owner?.scope === "club" ? owner.clubId : owner?.scope === "team" ? owner.teamClubId : null;
  if (club) {
    params.push(club);
    return `(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${params.length})`;
  }
  return `${alias}.owner_scope = 'system'`;
}

// The target rules of plan section 1.2, checked before the write with the
// calendar's one membership rule ON THE EVENT'S FIRST DAY (membershipOnDaySql,
// fallback included). The database trigger re-checks the owner relation on
// every row (existence of a membership, not the day). Every refusal is the
// same answer, whatever the reason — a missing id, a foreign one, an archived
// team, a non-member — so a target id is never confirmed to exist.
export const targetNotAvailable = () => new EventError(400, "target_not_available", "One of the chosen targets is not available in this workspace.");

export async function resolveEventTargets(client, owner, targets, day) {
  const athletes = targets.filter((t) => t.kind === "athlete").map((t) => t.id);
  const teams = targets.filter((t) => t.kind === "team").map((t) => t.id);
  const clubs = targets.filter((t) => t.kind === "club").map((t) => t.id);
  if (clubs.length) {
    if (owner.scope !== "club" || clubs.some((id) => id !== owner.clubId)) throw targetNotAvailable();
  }
  if (teams.length) {
    if (owner.scope === "club") {
      const rows = (await client.query(
        `select t.id from public.teams t where t.id = any($1::uuid[]) and t.club_id = $2 and coalesce(t.is_active, true)`,
        [teams, owner.clubId],
      )).rows;
      if (rows.length !== teams.length) throw targetNotAvailable();
    } else if (owner.scope === "team") {
      if (teams.some((id) => id !== owner.teamId)) throw targetNotAvailable();
    } else {
      throw targetNotAvailable();
    }
  }
  if (athletes.length) {
    const params = [athletes];
    let cond;
    if (owner.scope === "club") {
      params.push(owner.clubId, day);
      cond = membershipOnDaySql("a.id", (m) => `(${m}.club_id = $2)`, "$3::date");
    } else if (owner.scope === "team") {
      params.push(owner.teamId, day);
      cond = membershipOnDaySql("a.id", (m) => `(${m}.membership_type = 'team' and ${m}.team_id = $2)`, "$3::date");
    } else {
      params.push(owner.userId);
      // The coach relationship, as every private-coach access check of the
      // repository reads it (access.js, inviteContext.js, programAccessPolicy.js).
      cond = `exists (select 1 from public.user_athletes ua where ua.user_id = $2 and ua.athlete_id = a.id and ua.relationship_type = 'coach' and ua.is_active = true)`;
    }
    const rows = (await client.query(
      `select a.id from public.athletes a where a.id = any($1::uuid[]) and coalesce(a.is_active, true) and ${cond}`,
      params,
    )).rows;
    if (rows.length !== athletes.length) throw targetNotAvailable();
  }
  return targets;
}
