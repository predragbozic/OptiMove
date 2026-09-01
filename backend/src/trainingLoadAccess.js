// Shared scope/permission helpers for training_load.external_schedules -
// a training_load-owned copy of testsAccess.js's own shape, deliberately
// NOT imported from that file: training_load must mirror the WELLNESS
// (tests.*) authorization PATTERN without taking a dependency on tests.*
// internals. external_schedules follows the exact same owner_scope/
// owner_user_id/owner_club_id/owner_team_id shape testsAccess.js's own
// tests.test_schedules already uses, so "who may manage this schedule" is
// decided the same way "who may manage this club/team" already is
// everywhere else in the app.
//
// Hardening correction: every function here now resolves against the
// account's CURRENTLY ACTIVE workspace, never its full global role set.
// The original shape (isPlatformAdministrator/canManageClub/
// canManageTeamById, all read straight off req.authz) let a dual-role
// coach - say, club_admin of BOTH Club A and Club B - list, edit, target,
// or remind against Club B's external schedules while sitting in the
// Club A workspace, simply because the SAME account also happened to
// manage Club B somewhere else. That's exactly the workspace-scoping bug
// GET /weekly's own coachWorkspaceScopeSql (routes/trainingLoad.js) was
// already built to avoid for athlete visibility - this file now applies
// the identical discipline to schedule ownership/management/targeting.
import { resolveActiveWorkspace } from "./workspace.js";
import { query } from "./db.js";

function externalScheduleScopeFromWorkspace(workspace, req) {
  if (!workspace) return { type: null };
  if (workspace.type === "platform") return { type: "platform" };
  if (workspace.type === "club") return { type: "club", clubId: workspace.scopeId };
  if (workspace.type === "team") return { type: "team", teamId: workspace.scopeId };
  if (workspace.type === "private_coach") return { type: "private_coach", userId: req.user.id };
  return { type: null };
}

// Hardening correction: a platform-admin-created schedule used to be
// stamped owner_scope='user'/owner_user_id=<the admin> - byte-identical
// to what a private_coach-workspace schedule for that SAME account looks
// like. That let a dual-role account (platform admin who is ALSO a
// private coach somewhere) see/manage a schedule it created as an admin
// from its own unrelated private_coach workspace. The DB's own
// owner_scope CHECK already allows 'system' for exactly this case (see
// migrations_v2/202609011000's owner_scope shape) - it was simply never
// produced here. canManageExternalScheduleInScope's platform branch
// stays unconditionally true regardless (an admin manages everything),
// so this only ever tightens the private_coach/club/team branches.
function externalScheduleOwnerContextFromWorkspace(workspace, req) {
  if (workspace?.type === "club") return { ownerScope: "club", ownerUserId: null, ownerClubId: workspace.scopeId, ownerTeamId: null };
  if (workspace?.type === "team") return { ownerScope: "team", ownerUserId: null, ownerClubId: null, ownerTeamId: workspace.scopeId };
  if (workspace?.type === "platform") return { ownerScope: "system", ownerUserId: null, ownerClubId: null, ownerTeamId: null };
  return { ownerScope: "user", ownerUserId: req.user.id, ownerClubId: null, ownerTeamId: null };
}

// Resolves "what may this request currently manage" as ONE discriminated
// scope object, computed ONCE per request (a single resolveActiveWorkspace
// call - see the ownerContext property below) and threaded through every
// other function for that same request - never re-derived independently
// partway through. { type: null } covers both "no workspace at all" and
// the athlete workspace itself: a coach schedule route must be completely
// unreachable from an athlete workspace, even when the same account also
// holds a real coach role elsewhere - switching workspace is the only way
// back in, exactly like coachWorkspaceScopeSql's own athlete branch.
//
// Hardening correction: this used to be called once for target-validation
// scope, with resolveExternalScheduleOwnerContext (below) re-resolving the
// active workspace a SECOND, independent time later in the SAME request to
// decide what to actually stamp on the new row. A workspace switch landing
// between those two reads could validate targets against workspace A but
// create the schedule owned by workspace B. The scope object returned here
// now carries its own `ownerContext` (computed from the SAME workspace
// read), so a caller that also needs ownership uses `scope.ownerContext`
// instead of a second resolveActiveWorkspace call.
export async function resolveExternalScheduleWorkspaceScope(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  return externalScheduleScopeForWorkspace(workspace, req);
}

// Same result as resolveExternalScheduleWorkspaceScope, for a caller that
// has ALREADY resolved the active workspace itself this request (e.g.
// GET /weekly, which also needs it for coachWorkspaceScopeSql's own
// athlete-visibility scoping) - lets that caller reuse the SAME
// resolveActiveWorkspace read for both purposes instead of triggering a
// second one, closing the exact race this file's own header describes.
export function externalScheduleScopeForWorkspace(workspace, req) {
  const scope = externalScheduleScopeFromWorkspace(workspace, req);
  if (scope.type !== null) scope.ownerContext = externalScheduleOwnerContextFromWorkspace(workspace, req);
  return scope;
}

// Correction: routes/builder.js used to snapshot a NEW weekly plan's
// owner via a resolveCurrentWorkspaceOwnerContext() that quietly fell
// back to owner_scope='unresolved' whenever the creating account had no
// real manageable workspace active - which meant a genuinely new,
// LIVE-created plan could be born 'unresolved' too, exactly the state
// the legacy backfill's own "never guess" rule was meant to be a
// fallback for PRE-EXISTING plans only, not something a live create
// should ever intentionally produce. routes/builder.js now resolves the
// full scope via resolveExternalScheduleWorkspaceScope (below) itself,
// rejects with a controlled 403 when scope.type === null BEFORE creating
// anything, and only ever stamps scope.ownerContext (always a real,
// non-'unresolved' owner by construction once that check passes) - see
// that route's own comment for the full reasoning. isAthleteInWorkspaceScope
// (below) is what it uses to validate each requested target athlete
// against that SAME resolved scope before ever creating a plan for them.

// Workspace-scoped "does this athlete belong here" check - the single
// source of truth for both external-schedule target validation
// (routes/trainingLoad.js's own resolveValidExternalTargets) and
// routes/builder.js's own weekly-plan target validation. Athlete ids
// here are always the real public.athletes.id UUID (never the human-
// readable athlete_id code the org picker's fuzzier global helper
// supports), so a direct membership-table comparison is both correct
// and simpler than reusing that helper.
export async function isAthleteInWorkspaceScope(scope, athleteId) {
  if (scope.type === "platform") {
    const r = await query(`select 1 from public.athletes where id = $1`, [athleteId]);
    return r.rowCount > 0;
  }
  if (scope.type === "club") {
    const r = await query(`select 1 from public.athlete_memberships where athlete_id = $1 and membership_type = 'club' and status = 'active' and club_id = $2`, [athleteId, scope.clubId]);
    return r.rowCount > 0;
  }
  if (scope.type === "team") {
    const r = await query(`select 1 from public.athlete_memberships where athlete_id = $1 and membership_type = 'team' and status = 'active' and team_id = $2`, [athleteId, scope.teamId]);
    return r.rowCount > 0;
  }
  if (scope.type === "private_coach") {
    const r = await query(`select 1 from public.user_athletes where athlete_id = $1 and user_id = $2 and is_active = true`, [athleteId, scope.userId]);
    return r.rowCount > 0;
  }
  return false;
}

// Correction round 4: workspace-scope coverage of a plan's athlete is
// NOT proof that a given workspace actually OWNS an 'unresolved' plan -
// isAthleteInWorkspaceScope alone let ANY workspace that happens to
// currently manage the same athlete (a private coach, a different club
// via a second membership, etc.) claim a legacy plan regardless of who
// actually made it, turning "resolve the ownership" into "whoever clicks
// first wins" - exactly the kind of cross-workspace leak this branch's
// own ownership model exists to prevent, just moved into the resolution
// action itself instead of the read path.
//
// Conservative rule for a genuinely UNRESOLVED plan: only its own
// ORIGINAL creator (plans.plans.created_by_user_id) may resolve it, and
// only while their own currently active workspace still genuinely covers
// the plan's athlete (never a bare identity check alone - a creator who
// no longer has any real relationship to this athlete can't resolve it
// either). A plan with no creator on record (created_by_user_id is
// null - never guessed at) is never resolvable through this identity
// check by anyone. A real platform administrator is the one deliberate,
// explicit override for exactly that "creator is gone/unknown" case -
// never a plain club/team/private-coach workspace, no matter how
// legitimately it manages the same athlete today.
//
// `plan` here only ever needs `athlete_id` and `created_by_user_id` -
// callers pass whatever subset of a fuller row they already have.
//
// perf: `membershipCache` is an OPTIONAL Map<athleteId, Promise<boolean>>
// a caller looping over many plans in one request (GET /weekly's own
// per-row canResolveOwnership computation) may pass in, so the SAME
// athlete's membership is only ever queried once per request even if
// several of their unresolved sessions appear in the same response -
// same scope, same athlete, same answer, every time. Omit it (as every
// single-plan caller, e.g. POST /plans/resolve-rpe-ownership, already
// does) and this behaves exactly as before - no behavior change, only
// fewer redundant round trips for a caller that opts in.
export async function canResolvePlanOwnership(scope, plan, userId, membershipCache) {
  if (scope.type === "platform") return true;
  if (plan.created_by_user_id == null || String(plan.created_by_user_id) !== String(userId)) return false;
  if (!membershipCache) return isAthleteInWorkspaceScope(scope, plan.athlete_id);
  const athleteId = String(plan.athlete_id);
  if (!membershipCache.has(athleteId)) membershipCache.set(athleteId, isAthleteInWorkspaceScope(scope, plan.athlete_id));
  return membershipCache.get(athleteId);
}

export function canManageExternalScheduleInScope(scope, schedule) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return schedule.owner_scope === "club" && String(schedule.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return schedule.owner_scope === "team" && String(schedule.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return schedule.owner_scope === "user" && String(schedule.owner_user_id) === String(scope.userId);
  return false;
}

// List-query equivalent of canManageExternalScheduleInScope's own per-row
// check - appends its own param(s) to the caller's params array (matching
// this file's existing SQL-fragment-builder convention) and returns just
// the boolean SQL fragment.
export function externalScheduleScopeSqlForWorkspace(scope, params) {
  if (scope.type === "platform") return "true";
  if (scope.type === "club") {
    params.push(scope.clubId);
    return `(s.owner_scope = 'club' and s.owner_club_id = $${params.length})`;
  }
  if (scope.type === "team") {
    params.push(scope.teamId);
    return `(s.owner_scope = 'team' and s.owner_team_id = $${params.length})`;
  }
  if (scope.type === "private_coach") {
    params.push(scope.userId);
    return `(s.owner_scope = 'user' and s.owner_user_id = $${params.length})`;
  }
  return "false";
}
