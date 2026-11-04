// Who may do what in the in-app GPEXE import (phase F1).
//
//   * Review (settings status, "Check now", candidates, previews, athlete
//     links): whoever manages the team — its team_coach, the admin of its
//     club, or a platform admin — acting in a workspace that contains the
//     team, and only while the team is active. Anything else - an archived
//     team included - gets the same 404 as a team that does not exist
//     (ADR-006).
//   * Configure the GPEXE team, grant and revoke approver rights, read the
//     retention status: an active platform admin only.
//   * Approve an import (F2): an active platform admin, or a coach holding an
//     active, explicit approver grant for that team while still actively
//     coaching it. canApproveGpexeImport() below is what the F1 screens show;
//     the approval itself re-checks it in the database, in its transaction.
import { canManageTeamById, holdsClubAdminRole, isPlatformAdministrator } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";

export async function resolveGpexeTeamAccess(req, teamId, { query }) {
  // An archived team is the same 404 as a missing one, for its coach, its
  // club admin and a platform admin alike - every GPEXE route, including
  // the administrative ones, goes through here.
  const team = (await query(`select id, club_id from public.teams where id = $1 and coalesce(is_active, true)`, [teamId])).rows[0];
  if (!team) return null;
  if (!canManageTeamById(req.authz, team.id)) return null;
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  const platformAdmin = isPlatformAdministrator(req.authz);
  const inWorkspace =
    (workspace?.type === "platform" && platformAdmin) ||
    (workspace?.type === "team" && String(workspace.scopeId) === String(team.id)) ||
    (workspace?.type === "club" && String(workspace.scopeId) === String(team.club_id) && (platformAdmin || holdsClubAdminRole(req.authz, team.club_id)));
  if (!inWorkspace) return null;
  // The workspace the access was resolved in, for a route whose right is
  // narrower than "manages the team" (the identity load: no team workspace).
  return { teamId: String(team.id), clubId: team.club_id ? String(team.club_id) : null, platformAdmin, workspace: { type: workspace.type, scopeId: workspace.scopeId ? String(workspace.scopeId) : null } };
}

// Live read, never the cached req.authz: a revoked grant or role must stop
// showing the button on the next request. U2 (v56): the person's RIGHT (basis)
// is separate from the team's switch: `canApprove` needs both. The basis order
// is the database's (lock_gpexe_import_approver): platform_admin, team_grant,
// club_admin, team_coach; the last two only while the team's switch is on in
// mode 'team'. `switchOn` / `switchMode` are what the screens show.
export async function canApproveGpexeImport({ query }, userId, teamId) {
  const r = await query(
    `select
       exists (select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
               where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true) as platform_admin,
       exists (select 1 from training_load.gpexe_import_approvers a
               join public.user_team_roles tr on tr.user_id = a.user_id and tr.team_id = a.owner_team_id
                    and tr.role = 'team_coach' and tr.is_active = true
               join public.users u on u.id = a.user_id and u.is_active = true
               where a.user_id = $1 and a.owner_team_id = $2 and a.revoked_at is null) as granted,
       exists (select 1 from public.teams t
               join public.user_club_roles cr on cr.club_id = t.club_id and cr.user_id = $1
                    and cr.role = 'club_admin' and cr.is_active = true
               join public.users u on u.id = cr.user_id and u.is_active = true
               where t.id = $2) as club_admin,
       exists (select 1 from public.user_team_roles tr
               join public.users u on u.id = tr.user_id and u.is_active = true
               where tr.user_id = $1 and tr.team_id = $2 and tr.role = 'team_coach' and tr.is_active = true) as team_coach,
       (select s.enabled from training_load.gpexe_team_import_switch s where s.owner_team_id = $2) as switch_on,
       (select s.mode from training_load.gpexe_team_import_switch s where s.owner_team_id = $2) as switch_mode`,
    [userId, teamId],
  );
  const row = r.rows[0];
  const switchOn = row.switch_on === true;
  const switchMode = row.switch_mode || null;
  let basis = null;
  if (row.platform_admin) basis = "platform_admin";
  else if (row.granted) basis = "team_grant";
  else if (row.club_admin && switchMode === "team") basis = "club_admin";
  else if (row.team_coach && switchMode === "team") basis = "team_coach";
  return { canApprove: basis !== null && switchOn, basis, hasRight: basis !== null, switchOn, switchMode };
}

// J17 step 2a (R16), the approval only, after the team import lock: the team
// and its club FOR SHARE. A team or club archived, missing, or a team moved
// to another club since the route's access check is the identical 404. The
// archive writers are single statements and a team move takes the team lock
// as a try-lock, so this read waits behind no cycle. expectedClubId: the club
// the route resolved the access in (null for a team without a club;
// undefined when the caller is not a route - the club is then not compared).
export class ApprovalTeamGoneError extends Error {
  constructor() {
    super("Not found.");
    this.code = "notFound";
  }
}
export async function lockApprovalTeam(client, teamId, expectedClubId = undefined) {
  const team = (await client.query(`select id, club_id, coalesce(is_active, true) as active from public.teams where id = $1 for share`, [teamId])).rows[0];
  if (!team || team.active !== true) throw new ApprovalTeamGoneError();
  const clubId = team.club_id ? String(team.club_id) : null;
  if (expectedClubId !== undefined && clubId !== (expectedClubId === null ? null : String(expectedClubId))) throw new ApprovalTeamGoneError();
  if (clubId) {
    const club = (await client.query(`select coalesce(is_active, true) as active from public.clubs where id = $1 for share`, [clubId])).rows[0];
    if (!club || club.active !== true) throw new ApprovalTeamGoneError();
  }
}

// J17 section 6.1: the audience of one request, computed once from the route's
// own access snapshot (resolveGpexeTeamAccess) - "platform" for an active
// platform admin; "club_admin" for the owning club's active admin acting in
// that club's workspace (D8: not in a team workspace, where a club admin who
// also coaches the team acts as its coach); "other" for everyone else.
export function importAudienceOf(authz, access) {
  if (!access) return "other";
  if (access.platformAdmin) return "platform";
  if (access.clubId && holdsClubAdminRole(authz, access.clubId)
    && access.workspace?.type === "club" && String(access.workspace.scopeId) === String(access.clubId)) return "club_admin";
  return "other";
}
