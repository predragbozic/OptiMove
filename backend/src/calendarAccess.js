// Central calendar (K1a) — the read scopes of GET /api/calendar per active
// workspace (docs/ai/central-calendar-k1-plan.md, section 3; owner
// decisions D6, D7, D8). The workspace is resolved ONCE per request and
// every predicate is derived from that one object, the discipline of
// trainingLoadAccess.js and trainingActivityAccess.js.
//
// Three predicates, one per family of rows:
//   - athletes (plan sessions, assignments, targets): club → active members
//     of the club or of one of the club's active teams (manager decision 5,
//     the spirit of D8); team → active members of the team; private coach →
//     the account's active public.user_athletes; platform → everyone;
//     athlete → self.
//   - activities: trainingActivityAccess.js's READ scope (D8: a club reads
//     the activities owned by its active teams as well as its own); athlete →
//     own canonical participation.
//   - schedules (the projected days of external and test schedules that have
//     no generated occurrence yet): owned inside the scope, or targeting the
//     scope's club, team or athletes (manager decision 6, the way
//     routes/tests.js projects a week); for the athlete workspace, the
//     schedules targeting the athlete, one of their active teams or clubs.
// Every predicate appends its bind parameters to the caller's `params`
// array and returns a boolean SQL fragment (the convention of
// activityScopeSqlForWorkspace). Nothing here writes.
import { resolveActiveWorkspace } from "./workspace.js";
import { query } from "./db.js";
import { activityReadScopeSqlForWorkspace, activityScopeForWorkspace } from "./trainingActivityAccess.js";
import { athleteExtraFilterSql } from "./trainingLoadAccess.js";

// { type: "coach", workspace, activityScope, userId } for a coach-capable
// workspace; { type: "athlete", workspace, athleteId, userId } for the
// athlete workspace; { type: null, reason } when the request may read
// nothing (no workspace at all, or an athlete workspace without a profile).
export async function resolveCalendarContext(req) {
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return { type: null, reason: "no_workspace" };
  if (workspace.type === "athlete") {
    if (!req.authz.athleteId) return { type: null, reason: "no_athlete_profile" };
    return { type: "athlete", workspace, athleteId: req.authz.athleteId, userId: req.user.id };
  }
  const activityScope = activityScopeForWorkspace(workspace, req);
  if (activityScope.type === null) return { type: null, reason: "no_workspace" };
  return { type: "coach", workspace, activityScope, userId: req.user.id };
}

// The active teams of the club bound as $<paramIndex>.
function clubTeamsSql(paramIndex) {
  return `(select t_c.id from public.teams t_c where t_c.club_id = $${paramIndex} and coalesce(t_c.is_active, true))`;
}

// `alias` is a public.athletes alias of the calling query.
export function calendarAthleteScopeSql(ctx, alias, params) {
  if (ctx.type === "athlete") {
    params.push(ctx.athleteId);
    return `${alias}.id = $${params.length}`;
  }
  const workspace = ctx.workspace;
  if (workspace.type === "platform") return "true";
  if (workspace.type === "club") {
    params.push(workspace.scopeId);
    const n = params.length;
    return `exists (select 1 from public.athlete_memberships am_s where am_s.athlete_id = ${alias}.id and am_s.status = 'active'
              and ((am_s.membership_type = 'club' and am_s.club_id = $${n})
                or (am_s.membership_type = 'team' and am_s.team_id in ${clubTeamsSql(n)})))`;
  }
  if (workspace.type === "team") {
    params.push(workspace.scopeId);
    return `exists (select 1 from public.athlete_memberships am_s where am_s.athlete_id = ${alias}.id and am_s.membership_type = 'team' and am_s.status = 'active' and am_s.team_id = $${params.length})`;
  }
  if (workspace.type === "private_coach") {
    params.push(ctx.userId);
    return `exists (select 1 from public.user_athletes ua_s where ua_s.athlete_id = ${alias}.id and ua_s.user_id = $${params.length} and ua_s.is_active = true)`;
  }
  return "false";
}

// `alias` is a training.activities alias of the calling query.
export function calendarActivityScopeSql(ctx, alias, params) {
  if (ctx.type === "athlete") {
    params.push(ctx.athleteId);
    return `exists (select 1 from training.activity_participants ap_s where ap_s.activity_id = ${alias}.id and ap_s.athlete_id = $${params.length} and ap_s.merge_status = 'canonical')`;
  }
  return activityReadScopeSqlForWorkspace(ctx.activityScope, alias, params);
}

// `alias` is the schedule alias (owner_scope / owner_user_id / owner_club_id /
// owner_team_id); `targetsTable` holds (schedule_id, target_kind,
// target_athlete_id, target_team_id, target_club_id).
export function calendarScheduleScopeSql(ctx, alias, targetsTable, params) {
  if (ctx.type === "athlete") {
    // Own targets only (plan section 3): the athlete directly, or an active
    // team or club membership of theirs; never a schedule's owner.
    params.push(ctx.athleteId);
    const n = params.length;
    return `exists (select 1 from ${targetsTable} tg where tg.schedule_id = ${alias}.id and (
              (tg.target_kind = 'athlete' and tg.target_athlete_id = $${n})
           or (tg.target_kind = 'team' and exists (select 1 from public.athlete_memberships am_a where am_a.athlete_id = $${n} and am_a.membership_type = 'team' and am_a.status = 'active' and am_a.team_id = tg.target_team_id))
           or (tg.target_kind = 'club' and exists (select 1 from public.athlete_memberships am_a where am_a.athlete_id = $${n} and am_a.membership_type = 'club' and am_a.status = 'active' and am_a.club_id = tg.target_club_id))))`;
  }
  const workspace = ctx.workspace;
  if (workspace.type === "platform") return "true";
  const athleteTarget = () => `(tg.target_kind = 'athlete' and exists (select 1 from public.athletes ax where ax.id = tg.target_athlete_id and ${calendarAthleteScopeSql(ctx, "ax", params)}))`;
  const withTargets = (owner, targets) => `(${owner} or exists (select 1 from ${targetsTable} tg where tg.schedule_id = ${alias}.id and (${targets})))`;
  if (workspace.type === "club") {
    params.push(workspace.scopeId);
    const n = params.length;
    const owner = `(${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${n}) or (${alias}.owner_scope = 'team' and ${alias}.owner_team_id in ${clubTeamsSql(n)})`;
    const targets = `(tg.target_kind = 'club' and tg.target_club_id = $${n}) or (tg.target_kind = 'team' and tg.target_team_id in ${clubTeamsSql(n)}) or ${athleteTarget()}`;
    return withTargets(owner, targets);
  }
  if (workspace.type === "team") {
    params.push(workspace.scopeId);
    const n = params.length;
    const owner = `(${alias}.owner_scope = 'team' and ${alias}.owner_team_id = $${n})`;
    const targets = `(tg.target_kind = 'team' and tg.target_team_id = $${n}) or (tg.target_kind = 'club' and tg.target_club_id = (select t_t.club_id from public.teams t_t where t_t.id = $${n})) or ${athleteTarget()}`;
    return withTargets(owner, targets);
  }
  if (workspace.type === "private_coach") {
    params.push(ctx.userId);
    const owner = `(${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${params.length})`;
    return withTargets(owner, athleteTarget());
  }
  return "false";
}

// The optional Club / Team / Athletes filter: narrows inside the scope,
// never widens it (the union semantics of athleteExtraFilterSql). `filters`
// is { clubIds, teamIds, athleteIds } of UUID arrays or nulls.
export function calendarAthleteFilterSql(alias, filters, params) {
  return athleteExtraFilterSql(alias, filters.clubIds || null, filters.teamIds || null, filters.athleteIds || null, params);
}

// The same filter for an activity: at least one canonical participant
// matches it (the rule of GET /api/training-load/calendar).
export function calendarActivityFilterSql(alias, filters, params) {
  if (!filters.clubIds && !filters.teamIds && !filters.athleteIds) return "";
  const inner = athleteExtraFilterSql("af", filters.clubIds || null, filters.teamIds || null, filters.athleteIds || null, params);
  return ` and exists (select 1 from training.activity_participants ap_f join public.athletes af on af.id = ap_f.athlete_id where ap_f.activity_id = ${alias}.id and ap_f.merge_status = 'canonical'${inner})`;
}

// The teams the answer may name: the active club's active teams, or the one
// team of a team workspace; [] for a private coach, a platform admin and an
// athlete (section 1 of the plan).
export async function loadWorkspaceTeams(ctx) {
  if (ctx.type !== "coach") return [];
  const workspace = ctx.workspace;
  if (workspace.type !== "club" && workspace.type !== "team") return [];
  const where = workspace.type === "club" ? "t.club_id = $1 and coalesce(t.is_active, true)" : "t.id = $1";
  const result = await query(
    `select t.id, t.name,
            (select count(*)::int from public.athlete_memberships am where am.team_id = t.id and am.membership_type = 'team' and am.status = 'active') as athlete_count
       from public.teams t
      where ${where}
      order by t.name, t.id`,
    [workspace.scopeId],
  );
  return result.rows.map((row) => ({ teamId: row.id, name: row.name, athleteCount: Number(row.athlete_count) }));
}
