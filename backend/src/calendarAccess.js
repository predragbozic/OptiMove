// Central calendar (K1a) — the read scopes of GET /api/calendar per active
// workspace (docs/ai/central-calendar-k1-plan.md, section 3; owner
// decisions D6, D7, D8). The workspace is resolved ONCE per request and
// every predicate is derived from that one object, the discipline of
// trainingLoadAccess.js and trainingActivityAccess.js.
//
// Three predicates, one per family of rows:
//   - athletes (plan sessions, assignments, targets), ON THE ITEM'S DAY
//     (manager decision 4 as approved: "membership on the day"), through the
//     one function membershipOnDaySql below — the membership periods of
//     migration v25 (public.athlete_membership_periods, the same periods
//     training.activity_roster() reads) — club → a club period of the club
//     or a team period of one of the club's active teams covering the day
//     (manager decision 5, the spirit of D8); team → a team period of the
//     team covering the day; private coach → the account's active
//     public.user_athletes (no history exists for that relationship);
//     platform → everyone; athlete → self.
//   - activities: trainingActivityAccess.js's READ scope (D8: a club reads
//     the activities owned by its active teams as well as its own); athlete →
//     own canonical participation.
//   - schedules (the projected days of external and test schedules that have
//     no generated occurrence yet): a STRUCTURAL relation (owned inside the
//     scope, or targeting the scope's club or team itself) shows every
//     projected day; a relation through athletes (a direct athlete target, a
//     team or club target reached through its members; the athlete
//     workspace's own targets) shows a day only when at least one athlete
//     was a member ON THAT DAY (manager decision 6, the way routes/tests.js
//     projects a week). The window only pre-selects candidate schedules and
//     never decides access (the owner's external review of PR #281).
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

// The calendar day of a period boundary: its instant read as a UTC date.
// Memberships are added and archived in Settings at a moment, items carry a
// local day without a zone, so the comparison is made at DATE granularity in
// ONE stated zone, UTC — unlike training.activity_roster(), which compares
// instants in the activity's own time zone. The joining day and the leaving
// day both count as member days.
function periodDaySql(expr) {
  return `(${expr} at time zone 'UTC')::date`;
}

// A membership period (alias `mp`) that covers at least one of the local
// days from `fromExpr` to `toExpr` (both SQL date expressions; one day when
// equal): it began on or before the last day and ended on or after the first
// (an open period never ended).
export function periodCoversSql(mp, fromExpr, toExpr = fromExpr) {
  return `${periodDaySql(`${mp}.valid_from`)} <= (${toExpr})::date and (${fromExpr})::date <= coalesce(${periodDaySql(`${mp}.valid_to`)}, 'infinity'::date)`;
}

// THE membership rule of the calendar (manager decision 4 and its fallback,
// option (b) of plan section 3): the athlete `athleteIdExpr` is a member of
// what `cond(mp)` describes (a club, a team, a set of either) on the day(s)
// when
//   - a period of that membership covers the day (periodCoversSql), or
//   - the day lies BEFORE the athlete's first membership period in that
//     CLUB (their OptiMove history there has not started: imported history,
//     an athlete added late) and the membership is current (an open period).
// So an athlete who left stays on the cards through the leaving day and is
// on none after; a current member's older plans stay visible, as Coach Home
// shows them today; an athlete who moved from team X to team Y inside the
// club is X's through the leaving day and Y's from the joining day, never
// Y's before it (their club history already existed). `cond` is a function
// of the period alias, e.g. (m) => `(${m}.membership_type = 'team' and ${m}.team_id = $3)`.
export function membershipOnDaySql(athleteIdExpr, cond, fromExpr, toExpr = fromExpr) {
  return `exists (select 1 from public.athlete_membership_periods mp
           where mp.athlete_id = ${athleteIdExpr} and ${cond("mp")}
             and (${periodCoversSql("mp", fromExpr, toExpr)}
                  or (mp.valid_to is null
                      and not exists (select 1 from public.athlete_membership_periods mp0
                                       where mp0.athlete_id = ${athleteIdExpr} and mp0.club_id = mp.club_id
                                         and ${periodDaySql("mp0.valid_from")} <= (${fromExpr})::date))))`;
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
    return membershipOnDaySql(`${alias}.id`, (m) => `((${m}.membership_type = 'club' and ${m}.club_id = $${n}) or (${m}.membership_type = 'team' and ${m}.team_id in ${clubTeamsSql(n)}))`, fromExpr, toExpr);
  }
  if (workspace.type === "team") {
    params.push(workspace.scopeId);
    const n = params.length;
    return membershipOnDaySql(`${alias}.id`, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = $${n})`, fromExpr, toExpr);
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

// A schedule's STRUCTURAL relation to the workspace — one that depends on no
// athlete's membership: the scope owns the schedule, or the schedule
// targets the scope's club or team itself (a club workspace: its club or
// one of its active teams; a team workspace: its team or its club). A
// projected day of such a schedule is the workspace's own event and is
// shown whatever its members on that day. Never for the athlete workspace.
// `alias` is the schedule alias (owner_scope / owner_user_id / owner_club_id
// / owner_team_id); `targetsTable` holds (<idColumn>, target_kind,
// target_athlete_id, target_team_id, target_club_id) — `schedule_id` for the
// external and test schedules, `event_id` for calendar.event_targets (K2a).
export function calendarScheduleStructuralSql(ctx, alias, targetsTable, params, idColumn = "schedule_id") {
  if (ctx.type === "athlete") return "false";
  const workspace = ctx.workspace;
  if (workspace.type === "platform") return "true";
  if (workspace.type === "club") {
    params.push(workspace.scopeId);
    const n = params.length;
    return `((${alias}.owner_scope = 'club' and ${alias}.owner_club_id = $${n}) or (${alias}.owner_scope = 'team' and ${alias}.owner_team_id in ${clubTeamsSql(n)})
             or exists (select 1 from ${targetsTable} tg where tg.${idColumn} = ${alias}.id
                          and ((tg.target_kind = 'club' and tg.target_club_id = $${n}) or (tg.target_kind = 'team' and tg.target_team_id in ${clubTeamsSql(n)}))))`;
  }
  if (workspace.type === "team") {
    params.push(workspace.scopeId);
    const n = params.length;
    return `((${alias}.owner_scope = 'team' and ${alias}.owner_team_id = $${n})
             or exists (select 1 from ${targetsTable} tg where tg.${idColumn} = ${alias}.id
                          and ((tg.target_kind = 'team' and tg.target_team_id = $${n}) or (tg.target_kind = 'club' and tg.target_club_id = (select t_t.club_id from public.teams t_t where t_t.id = $${n})))))`;
  }
  if (workspace.type === "private_coach") {
    params.push(ctx.userId);
    return `(${alias}.owner_scope = 'user' and ${alias}.owner_user_id = $${params.length})`;
  }
  return "false";
}

// The CANDIDATE pre-selection of schedules for a window: the structural
// relation above, or an athlete target / a team or club target whose
// athletes were in the scope on SOME day of the window. This never decides
// access: a projected day is shown only through the structural relation or
// through at least one athlete who was a member ON THAT DAY
// (readScheduleTargetAthletes judges every (schedule, day) with
// membershipOnDaySql on the day), so a former member or a former coach
// never sees a day after the membership ended, whatever range is asked.
// The pre-selection is a provable SUPERSET of what the per-day check can
// allow on any day of the window, with the SAME membership semantics
// (membershipOnDaySql over the window, fallback included — the window
// version covers every day's own answer: a period covering a day covers the
// window, and "no period started on or before the day" implies "none on or
// before the window's first day"), so a wide request never shows a
// permitted card that a one-day request hides (the owner's external
// re-check of PR #281, P2). `fromExpr` / `toExpr` are the window's SQL date
// expressions.
export function calendarScheduleCandidateSql(ctx, alias, targetsTable, params, fromExpr, toExpr, idColumn = "schedule_id") {
  if (ctx.type === "athlete") {
    // Own targets (plan section 3): the athlete directly, or a team or club
    // membership of theirs on some day of the window; never a schedule's owner.
    params.push(ctx.athleteId);
    const n = params.length;
    return `exists (select 1 from ${targetsTable} tg where tg.${idColumn} = ${alias}.id and (
              (tg.target_kind = 'athlete' and tg.target_athlete_id = $${n})
           or (tg.target_kind = 'team' and ${membershipOnDaySql(`$${n}`, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = tg.target_team_id)`, fromExpr, toExpr)})
           or (tg.target_kind = 'club' and ${membershipOnDaySql(`$${n}`, (m) => `(${m}.membership_type = 'club' and ${m}.club_id = tg.target_club_id)`, fromExpr, toExpr)})))`;
  }
  if (ctx.workspace.type === "platform") return "true";
  const structural = calendarScheduleStructuralSql(ctx, alias, targetsTable, params, idColumn);
  // A target the scope reaches only through athletes: a direct athlete
  // target, or a team / club target with an athlete who was both in the
  // scope and a member of the target (the same membershipOnDaySql rule,
  // fallback included) on some day of the window.
  const athleteInScope = () => calendarAthleteScopeSql(ctx, "ax", params, fromExpr, toExpr);
  return `(${structural} or exists (select 1 from ${targetsTable} tg where tg.${idColumn} = ${alias}.id and (
            (tg.target_kind = 'athlete' and exists (select 1 from public.athletes ax where ax.id = tg.target_athlete_id and ${athleteInScope()}))
         or (tg.target_kind = 'team' and exists (select 1 from public.athletes ax where ${athleteInScope()}
                 and ${membershipOnDaySql("ax.id", (m) => `(${m}.membership_type = 'team' and ${m}.team_id = tg.target_team_id)`, fromExpr, toExpr)}))
         or (tg.target_kind = 'club' and exists (select 1 from public.athletes ax where ${athleteInScope()}
                 and ${membershipOnDaySql("ax.id", (m) => `(${m}.membership_type = 'club' and ${m}.club_id = tg.target_club_id)`, fromExpr, toExpr)})))))`;
}

// The optional Club / Team / Athletes filter — the union semantics of the
// Training Load picker ("any mix": club OR team OR direct athlete, inside
// the mandatory scope, so it narrows and never widens), with the club and
// team memberships judged on the item's day by the same membershipOnDaySql
// rule as the scope. `filters` is { clubIds, teamIds, athleteIds } of UUID
// arrays or nulls; `alias` the public.athletes alias. The result starts with
// " and (" or is "".
export function calendarAthleteFilterSql(alias, filters, params, fromExpr, toExpr = fromExpr) {
  const conditions = [];
  if (filters.clubIds) {
    params.push(filters.clubIds);
    const n = params.length;
    conditions.push(membershipOnDaySql(`${alias}.id`, (m) => `(${m}.membership_type = 'club' and ${m}.club_id = any($${n}::uuid[]))`, fromExpr, toExpr));
  }
  if (filters.teamIds) {
    params.push(filters.teamIds);
    const n = params.length;
    conditions.push(membershipOnDaySql(`${alias}.id`, (m) => `(${m}.membership_type = 'team' and ${m}.team_id = any($${n}::uuid[]))`, fromExpr, toExpr));
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
