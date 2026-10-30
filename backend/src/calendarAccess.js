// Central calendar (K1a) — the read scopes of GET /api/calendar per active
// workspace (docs/ai/central-calendar-k1-plan.md, section 3; owner
// decisions D6, D7, D8). The workspace is resolved ONCE per request and
// every predicate is derived from that one object, the discipline of
// trainingLoadAccess.js and trainingActivityAccess.js.
//
// Three predicates, one per family of rows:
//   - athletes (plan sessions, assignments, targets), ON THE ITEM'S DAY
//     (manager decision 4 as approved: "membership on the day"): the
//     membership periods of migration v25 (public.athlete_membership_periods,
//     the same periods training.activity_roster() reads) — club → a club
//     period of the club or a team period of one of the club's active teams
//     covering the day (manager decision 5, the spirit of D8); team → a team
//     period of the team covering the day; private coach → the account's
//     active public.user_athletes (no history exists for that relationship);
//     platform → everyone; athlete → self. So an athlete who left a team
//     stays on the cards of the days before they left and is on none after,
//     and a new member's earlier plans never appear on the team's past days.
//   - activities: trainingActivityAccess.js's READ scope (D8: a club reads
//     the activities owned by its active teams as well as its own); athlete →
//     own canonical participation.
//   - schedules (the projected days of external and test schedules that have
//     no generated occurrence yet): owned inside the scope, or targeting the
//     scope's club, team or athletes (manager decision 6, the way
//     routes/tests.js projects a week), the athletes judged over the window;
//     for the athlete workspace, the schedules targeting the athlete, or one
//     of their teams or clubs within the window.
// Every predicate appends its bind parameters to the caller's `params`
// array and returns a boolean SQL fragment (the convention of
// activityScopeSqlForWorkspace). Nothing here writes.
import { resolveActiveWorkspace } from "./workspace.js";
import { query } from "./db.js";
import { activityReadScopeSqlForWorkspace, activityScopeForWorkspace } from "./trainingActivityAccess.js";

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

// A membership period (alias `mp`) that overlaps the local days from
// `fromExpr` to `toExpr` (both SQL date expressions; one day when equal):
// the rule of training.activity_roster() for a session without a start
// time — the period began before the end of the last day and had not ended
// at the start of the first.
export function periodCoversSql(mp, fromExpr, toExpr = fromExpr) {
  return `${mp}.valid_from < ((${toExpr})::date + 1) and coalesce(${mp}.valid_to, 'infinity') > (${fromExpr})::date`;
}

// `alias` is a public.athletes alias of the calling query; `fromExpr` /
// `toExpr` the day (or the window) the membership must cover.
export function calendarAthleteScopeSql(ctx, alias, params, fromExpr, toExpr = fromExpr) {
  if (ctx.type === "athlete") {
    params.push(ctx.athleteId);
    return `${alias}.id = $${params.length}`;
  }
  const workspace = ctx.workspace;
  if (workspace.type === "platform") return "true";
  if (workspace.type === "club") {
    params.push(workspace.scopeId);
    const n = params.length;
    return `exists (select 1 from public.athlete_membership_periods mp_s where mp_s.athlete_id = ${alias}.id and ${periodCoversSql("mp_s", fromExpr, toExpr)}
              and ((mp_s.membership_type = 'club' and mp_s.club_id = $${n})
                or (mp_s.membership_type = 'team' and mp_s.team_id in ${clubTeamsSql(n)})))`;
  }
  if (workspace.type === "team") {
    params.push(workspace.scopeId);
    return `exists (select 1 from public.athlete_membership_periods mp_s where mp_s.athlete_id = ${alias}.id and mp_s.membership_type = 'team' and mp_s.team_id = $${params.length} and ${periodCoversSql("mp_s", fromExpr, toExpr)})`;
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
// target_athlete_id, target_team_id, target_club_id); `fromExpr` / `toExpr`
// the window the athlete targets are judged over.
export function calendarScheduleScopeSql(ctx, alias, targetsTable, params, fromExpr, toExpr) {
  if (ctx.type === "athlete") {
    // Own targets only (plan section 3): the athlete directly, or a team or
    // club membership of theirs within the window; never a schedule's owner.
    params.push(ctx.athleteId);
    const n = params.length;
    return `exists (select 1 from ${targetsTable} tg where tg.schedule_id = ${alias}.id and (
              (tg.target_kind = 'athlete' and tg.target_athlete_id = $${n})
           or (tg.target_kind = 'team' and exists (select 1 from public.athlete_membership_periods mp_a where mp_a.athlete_id = $${n} and mp_a.membership_type = 'team' and mp_a.team_id = tg.target_team_id and ${periodCoversSql("mp_a", fromExpr, toExpr)}))
           or (tg.target_kind = 'club' and exists (select 1 from public.athlete_membership_periods mp_a where mp_a.athlete_id = $${n} and mp_a.membership_type = 'club' and mp_a.club_id = tg.target_club_id and ${periodCoversSql("mp_a", fromExpr, toExpr)}))))`;
  }
  const workspace = ctx.workspace;
  if (workspace.type === "platform") return "true";
  const athleteTarget = () => `(tg.target_kind = 'athlete' and exists (select 1 from public.athletes ax where ax.id = tg.target_athlete_id and ${calendarAthleteScopeSql(ctx, "ax", params, fromExpr, toExpr)}))`;
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

// The optional Club / Team / Athletes filter — the union semantics of the
// Training Load picker ("any mix": club OR team OR direct athlete, inside
// the mandatory scope, so it narrows and never widens), with the club and
// team memberships judged on the item's day like the scope. `filters` is
// { clubIds, teamIds, athleteIds } of UUID arrays or nulls; `alias` the
// public.athletes alias. The result starts with " and (" or is "".
export function calendarAthleteFilterSql(alias, filters, params, fromExpr, toExpr = fromExpr) {
  const conditions = [];
  if (filters.clubIds) {
    params.push(filters.clubIds);
    conditions.push(`exists (select 1 from public.athlete_membership_periods mp_f where mp_f.athlete_id = ${alias}.id and mp_f.membership_type = 'club' and mp_f.club_id = any($${params.length}::uuid[]) and ${periodCoversSql("mp_f", fromExpr, toExpr)})`);
  }
  if (filters.teamIds) {
    params.push(filters.teamIds);
    conditions.push(`exists (select 1 from public.athlete_membership_periods mp_f where mp_f.athlete_id = ${alias}.id and mp_f.membership_type = 'team' and mp_f.team_id = any($${params.length}::uuid[]) and ${periodCoversSql("mp_f", fromExpr, toExpr)})`);
  }
  if (filters.athleteIds) {
    params.push(filters.athleteIds);
    conditions.push(`${alias}.id = any($${params.length}::uuid[])`);
  }
  return conditions.length ? ` and (${conditions.join(" or ")})` : "";
}

// The same filter for an activity: at least one canonical participant
// matches it on the activity's own day (the rule of GET
// /api/training-load/calendar, with the day added).
export function calendarActivityFilterSql(alias, filters, params) {
  if (!filters.clubIds && !filters.teamIds && !filters.athleteIds) return "";
  const inner = calendarAthleteFilterSql("af", filters, params, `${alias}.occurred_local_date`);
  return ` and exists (select 1 from training.activity_participants ap_f join public.athletes af on af.id = ap_f.athlete_id where ap_f.activity_id = ${alias}.id and ap_f.merge_status = 'canonical'${inner})`;
}

// The teams the answer may name: the active club's active teams, or the one
// team of a team workspace; [] for a private coach, a platform admin and an
// athlete (section 1 of the plan). athleteCount is today's active team
// membership count.
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
