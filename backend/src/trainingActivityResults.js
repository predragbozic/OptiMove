// Training Activity — read-only queries: canonical activity detail/
// results, and the activity list by period + athlete. Pure service
// functions taking an already-resolved read context (see
// resolveActivityReadContext in routes/trainingActivity.js, same
// isAthleteSelf/scope split as trainingLoadMetrics.js's own
// resolveReadContext).
import { query } from "./db.js";
import { activityScopeSqlForWorkspace, isAthleteInWorkspaceScope } from "./trainingActivityAccess.js";

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function canManageOwnerRow(scope, row) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return row.owner_scope === "club" && String(row.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return row.owner_scope === "team" && String(row.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return row.owner_scope === "user" && String(row.owner_user_id) === String(scope.userId);
  return false;
}

// Canonical activity detail: resolves p_activity_id (which may itself be
// a superseded alias) to its canonical activity/participant identity and
// every fact reachable through it (RPE, metric values, component
// performance, activity/component-level links) — see
// training.canonical_activity_results() in migrations_v2's
// training_activity_v4 migration for the full contract. An athlete may
// only ever read their OWN results (never another athlete's, even one
// nominally "in their own workspace" — there is no such thing for an
// athlete). A coach may read any activity within their currently active
// workspace's owner scope.
export async function getCanonicalActivityResults(readContext, activityId) {
  const activityRow = await query(`select owner_scope, owner_user_id, owner_club_id, owner_team_id from training.activities where id = $1`, [activityId]);
  if (!activityRow.rowCount) throw httpError(404, "Activity not found.");

  if (readContext.isAthleteSelf) {
    const owns = await query(
      `select 1 from training.activity_participants ap
       where ap.athlete_id = $1 and training.resolve_canonical_activity_id(ap.activity_id) = training.resolve_canonical_activity_id($2)`,
      [readContext.athleteId, activityId],
    );
    if (!owns.rowCount) throw httpError(404, "Activity not found.");
  } else if (!canManageOwnerRow(readContext.scope, activityRow.rows[0])) {
    throw httpError(404, "Activity not found.");
  }

  const results = await query(`select canonical_activity_id, canonical_participant_id, athlete_id, fact_kind, detail from training.canonical_activity_results($1)`, [activityId]);
  const facts = results.rows.map((r) => ({
    canonicalActivityId: r.canonical_activity_id,
    canonicalParticipantId: r.canonical_participant_id,
    athleteId: r.athlete_id,
    factKind: r.fact_kind,
    detail: r.detail,
  }));
  // For an athlete-self caller, every OTHER athlete's facts on a shared
  // group activity are stripped before the response ever leaves this
  // function — the canonical read contract itself has no concept of "my
  // own facts only", so that narrowing happens here, not in the route.
  const scoped = readContext.isAthleteSelf ? facts.filter((f) => f.athleteId === null || String(f.athleteId) === String(readContext.athleteId)) : facts;
  const canonicalActivityId = results.rows[0]?.canonical_activity_id || (await query(`select training.resolve_canonical_activity_id($1) as id`, [activityId])).rows[0].id;

  // Training Load Frontend 3A — compatible, additive extension: the
  // canonical read contract (training.canonical_activity_results, a pure
  // SQL function with no idea what an "athlete display name" even is)
  // returns athleteId only. A results TABLE needs a real name per row, and
  // the frontend must never resolve that by re-deriving/guessing it from
  // anywhere else — one extra query here, keyed on the exact athleteIds
  // this response already scoped/authorized above, never a schema change.
  const athleteIds = [...new Set(scoped.map((f) => f.athleteId).filter(Boolean))];
  let athleteNamesById = {};
  if (athleteIds.length) {
    const names = await query(
      `select id, coalesce(display_name, full_name, concat_ws(' ', first_name, last_name), athlete_id) as name from public.athletes where id = any($1::uuid[])`,
      [athleteIds],
    );
    athleteNamesById = Object.fromEntries(names.rows.map((r) => [r.id, r.name]));
  }

  // Training Load Frontend 3A — another compatible, additive extension: the
  // canonical read contract's own component-related fact kinds
  // (component_performance, component_metric_segment_link) only surface a
  // component when a participant has actually performed it or a metric
  // segment has been linked to it — there is currently no write path at
  // all for activity_participant_components, so most real components would
  // otherwise never appear here, and a merely-linked one would carry no
  // name. The activity's OWN component hierarchy (name/order/duration)
  // lives on training.activity_components regardless of performance/link
  // facts, so it is fetched directly here, across every alias activity
  // (mirrors alias_activities in canonical_activity_results itself), and
  // returned as a separate top-level field — never folded into `facts`.
  const componentRows = await query(
    `select c.id, c.activity_id, c.parent_component_id, c.component_type_key, c.exercise_id, c.name_snapshot,
            c.sort_order, c.planned_duration_seconds, c.actual_duration_seconds
     from training.activity_components c
     cross join lateral training.activity_alias_ids($1::uuid) aa
     where c.activity_id = aa.activity_id
     order by c.sort_order, c.id`,
    [canonicalActivityId],
  );
  const components = componentRows.rows.map((r) => ({
    id: r.id,
    activityId: r.activity_id,
    parentComponentId: r.parent_component_id,
    componentTypeKey: r.component_type_key,
    exerciseId: r.exercise_id,
    name: r.name_snapshot,
    sortOrder: Number(r.sort_order),
    plannedDurationSeconds: r.planned_duration_seconds === null ? null : Number(r.planned_duration_seconds),
    actualDurationSeconds: r.actual_duration_seconds === null ? null : Number(r.actual_duration_seconds),
  }));

  return { canonicalActivityId, facts: scoped, athleteNamesById, components };
}

const LIST_MAX_PAGE_SIZE = 200;
const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_DATE_RANGE_DAYS = 366;

// Activities within [dateFrom, dateTo] (inclusive, by each participant's
// OWN local_date — never a shared/event-local one), optionally narrowed
// to one athlete. A coach sees every canonical (non-superseded, non-alias)
// participant row within their active workspace's owner scope; an athlete
// sees only their own, and any requested athleteId other than their own
// is refused rather than silently ignored. Cursor-paginated on
// (local_date, activity_id, participant_id) — composite, since more than
// one participant can legitimately share the same local_date.
export async function listActivities(readContext, { athleteId, dateFrom, dateTo, limit, cursor } = {}) {
  if (!dateFrom || !dateTo) throw httpError(400, "dateFrom and dateTo are required.");
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw httpError(400, "dateFrom/dateTo must be valid dates (YYYY-MM-DD).");
  if (to < from) throw httpError(400, "dateTo must not be before dateFrom.");
  if ((to - from) / 86400000 > LIST_MAX_DATE_RANGE_DAYS) throw httpError(400, `Date range must not exceed ${LIST_MAX_DATE_RANGE_DAYS} days.`);

  const pageSize = Math.min(Math.max(Number(limit) || LIST_DEFAULT_PAGE_SIZE, 1), LIST_MAX_PAGE_SIZE);

  let targetAthleteId;
  if (readContext.isAthleteSelf) {
    if (athleteId && String(athleteId) !== String(readContext.athleteId)) throw httpError(403, "Forbidden");
    targetAthleteId = readContext.athleteId;
  } else {
    if (athleteId) {
      if (!(await isAthleteInWorkspaceScope(readContext.scope, athleteId))) throw httpError(403, "That athlete is outside your access.");
    }
    targetAthleteId = athleteId || null;
  }

  const params = [dateFrom, dateTo];
  const scopeSql = readContext.isAthleteSelf ? "true" : activityScopeSqlForWorkspace(readContext.scope, "a", params);
  let athleteSql = "true";
  if (targetAthleteId) {
    params.push(targetAthleteId);
    athleteSql = `ap.athlete_id = $${params.length}`;
  }
  let cursorSql = "true";
  if (cursor?.localDate && cursor?.activityId && cursor?.participantId) {
    params.push(cursor.localDate, cursor.activityId, cursor.participantId);
    const n = params.length;
    cursorSql = `(ap.local_date, a.id, ap.id) < ($${n - 2}, $${n - 1}, $${n})`;
  }
  params.push(pageSize + 1);

  const result = await query(
    `select a.id as activity_id, a.activity_type_key, a.name, a.occurred_local_date, a.started_at, a.ended_at, a.timezone_snapshot,
            a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id, a.origin, a.lifecycle_state,
            ap.id as participant_id, ap.athlete_id, ap.local_date, ap.participation_status
     from training.activity_participants ap
     join training.activities a on a.id = ap.activity_id
     where ap.local_date between $1 and $2
       and a.lifecycle_state <> 'superseded' and ap.merge_status = 'canonical'
       and (${scopeSql}) and (${athleteSql}) and (${cursorSql})
     order by ap.local_date desc, a.id desc, ap.id desc
     limit $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > pageSize;
  const rows = result.rows.slice(0, pageSize).map((r) => ({
    activityId: r.activity_id,
    participantId: r.participant_id,
    activityTypeKey: r.activity_type_key,
    name: r.name,
    localDate: r.local_date,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    timezoneSnapshot: r.timezone_snapshot,
    athleteId: r.athlete_id,
    participationStatus: r.participation_status,
    ownerScope: r.owner_scope,
    origin: r.origin,
    lifecycleState: r.lifecycle_state,
  }));
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? { localDate: last.localDate, activityId: last.activityId, participantId: last.participantId } : null;
  return { rows, nextCursor };
}
