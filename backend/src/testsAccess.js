// Shared scope/permission helpers for the Tests module (Phase 2) - reuses
// the app's existing authorization primitives rather than inventing a
// parallel scope model. tests.test_schedules follows the exact same
// owner_scope/owner_user_id/owner_club_id/owner_team_id pattern already used
// by tests.test/tests.test_battery (Tests v4.2, untouched here) - "who may
// manage this schedule" is decided the same way "who may manage this
// club/team" already is everywhere else in the app.
import { canManageClub, canManageTeamById, isPlatformAdministrator } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";
import { query } from "./db.js";
import { can, clubScope, teamScope } from "./permissions.js";

// Roles V-4 (docs/ai/roles-v-steps-plan.md section 2.5): the Tests module's two view words. Every coach path also asks
// them at each row's club or team (R4 section 6: the word taken away, or the club's licence closed, closes the module,
// writes included). The schedule is tests.view; results and the per-athlete group are tests.results.view.
export const TESTS_VIEW = "tests.view";
export const TESTS_RESULTS_VIEW = "tests.results.view";
function holds(authz, word, scope) {
  if (word === TESTS_RESULTS_VIEW) return can(authz, "tests.results.view", scope);
  return can(authz, "tests.view", scope);
}

// A schedule is manageable by: a platform admin, the exact independent coach
// who owns a 'user'-scoped schedule, a club_admin of a 'club'-scoped
// schedule's club, or a team_coach (or the club_admin of its club) of a
// 'team'-scoped schedule's team - i.e. exactly canManageClub/canManageTeamById,
// mirrored from tests.test_schedules' own ownership CHECK.
// Roles V-4: and the module's word at the schedule's club or team (`word`: tests.view, or tests.results.view for a
// result). A platform admin and a person's own schedule are unchanged (R4 Q10).
export function canManageSchedule(req, schedule, { word = TESTS_VIEW } = {}) {
  if (isPlatformAdministrator(req.authz)) return true;
  if (schedule.owner_scope === "user") return String(schedule.owner_user_id) === String(req.user.id);
  if (schedule.owner_scope === "club") {
    return canManageClub(req.authz, schedule.owner_club_id) && holds(req.authz, word, clubScope(String(schedule.owner_club_id)));
  }
  if (schedule.owner_scope === "team") {
    return canManageTeamById(req.authz, schedule.owner_team_id) && holds(req.authz, word, teamScope(String(schedule.owner_team_id)));
  }
  return false;
}

// Derives the owner_scope/owner_*_id a NEW schedule should be created with,
// from the coach's own currently-active workspace (backend/src/workspace.js) -
// the same "which context am I acting in right now" concept already driving
// Organization's data-context filtering, reused here instead of asking the
// coach to redundantly re-pick a scope the app already knows. A platform
// workspace (or any workspace type with no natural club/team home) falls
// back to owner_scope='user' scoped to the acting coach themselves - a
// platform admin's own ad hoc schedule, matching created_by_user_id anyway.
export async function resolveScheduleOwnerContext(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (workspace?.type === "club") {
    return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  }
  if (workspace?.type === "team") {
    return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  }
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Which club/team ids this coach may manage - used to build the "give me
// every schedule I may manage" WHERE clause without re-deriving the same
// sets query by query. Platform admins get a sentinel the caller interprets
// as "no scope filter at all" (see routes/tests.js).
// Roles V-4: only the clubs and teams where the account holds `word` (tests.view, or tests.results.view for results).
export function manageableClubIds(authz, word = TESTS_VIEW) {
  if (isPlatformAdministrator(authz)) return null;
  return (authz.clubRoles || []).filter((r) => r.role === "club_admin").map((r) => r.clubId)
    .filter((id) => holds(authz, word, clubScope(String(id))));
}

export function manageableTeamIds(authz, word = TESTS_VIEW) {
  if (isPlatformAdministrator(authz)) return null;
  const direct = (authz.teamRoles || []).filter((r) => r.role === "team_coach").map((r) => r.teamId);
  return [...new Set([...direct, ...(authz.managedTeamIds || [])])].filter((id) => holds(authz, word, teamScope(String(id))));
}

// Roles V-4: the schedules a view workspace reads (the entry gate's scope, routes/tests.js; reads only). A club view:
// the club's own schedules and its active teams'; a team view: the team's. Never a person's own schedule (`userId` null), never
// every schedule. Null when the club or team is no longer active (the route then answers its refusal).
export async function viewScheduleScope(moduleView) {
  const scope = moduleView?.scope;
  if (!scope) return null;
  if (scope.type === "club") {
    const club = await query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true)`, [scope.id]);
    if (!club.rowCount) return null;
    const teams = await query(`select id from public.teams where club_id = $1 and coalesce(is_active, true)`, [scope.id]);
    return Object.freeze({ userId: null, clubIds: [scope.id], teamIds: teams.rows.map((r) => String(r.id)), all: false });
  }
  const team = await query(
    `select 1 from public.teams t join public.clubs c on c.id = t.club_id where t.id = $1 and coalesce(t.is_active, true) and coalesce(c.is_active, true)`,
    [scope.id]);
  if (!team.rowCount) return null;
  return Object.freeze({ userId: null, clubIds: [], teamIds: [scope.id], all: false });
}

// Whether a view scope (viewScheduleScope) reads this schedule row (its owner columns).
export function viewScopeReadsSchedule(scope, schedule) {
  if (!scope || !schedule) return false;
  if (schedule.owner_scope === "club") return scope.clubIds.includes(String(schedule.owner_club_id));
  if (schedule.owner_scope === "team") return scope.teamIds.includes(String(schedule.owner_team_id));
  return false;
}
