// Training Activity — read-only queries: canonical activity detail/
// results, and the activity list by period + athlete. Pure service
// functions taking an already-resolved read context (see
// resolveActivityReadContext in routes/trainingActivity.js, same
// isAthleteSelf/scope split as trainingLoadMetrics.js's own
// resolveReadContext).
import crypto from "node:crypto";
import { estimateLabelFor, readEstimateLabels } from "./estimateLabels.js";
import { query } from "./db.js";
import { activityReadScopeSqlForWorkspace, canReadActivityInScope, isAthleteInWorkspaceScope } from "./trainingActivityAccess.js";

// An estimated value (migration v63): never part of an athlete's own read.
export const isEstimateFact = (fact) => fact?.factKind === "metric_value" && fact.detail?.entryMethod === "estimate";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
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
// workspace's READ scope (trainingActivityAccess.js's
// canReadActivityInScope: the owner scope, and for a club workspace also
// the activities of the club's active teams — owner decision D8). A missing
// activity, another club's team, an archived team and every other caller
// get the identical 404 (ADR-006).
export async function getCanonicalActivityResults(readContext, activityId, { clubVariableNamesAllowed } = {}) {
  const activityRow = await query(
    `select a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id,
            t.club_id as owner_team_club_id, coalesce(t.is_active, true) as owner_team_active
     from training.activities a
     left join public.teams t on t.id = a.owner_team_id
     where a.id = $1`,
    [activityId],
  );
  // An athlete: the ownership question is asked whether or not the id exists, so a missing id and one that is not hers
  // cost the same and answer the same.
  if (!activityRow.rowCount && !readContext.isAthleteSelf) throw httpError(404, "Activity not found.");

  if (readContext.isAthleteSelf) {
    // Her own past results stay hers when the team (or its club) is archived later: an archive is the club's
    // administrative act, not a reason for her history to vanish (the Rukovodilac's reading of the owner's "all of
    // her own results", 2026-11-16). Everything else on that team is the same 404 as before.
    const owns = await query(
      `select 1 from training.activity_participants ap
       where ap.athlete_id = $1 and training.resolve_canonical_activity_id(ap.activity_id) = training.resolve_canonical_activity_id($2)`,
      [readContext.athleteId, activityId],
    );
    if (!owns.rowCount || !activityRow.rowCount) throw httpError(404, "Activity not found.");
  } else if (!canReadActivityInScope(readContext.scope, activityRow.rows[0])) {
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
  // The link-only facts (no athlete: which metric event or segment the activity is linked to) are the staff's
  // bookkeeping and are not hers either.
  // And an estimate is not hers to see at all (owner, 2026-11-16: "the athlete sees only data that was really
  // measured; there are no estimates on the athlete's side"): dropped here, on the server, before anything is built
  // from her facts - no value, no label, no name of its variable, no trace that one exists. A value a coach entered by
  // hand as a measurement (entry method manual) is a measured value and stays.
  const scoped = readContext.isAthleteSelf
    ? facts.filter((f) => f.athleteId !== null && String(f.athleteId) === String(readContext.athleteId) && !isEstimateFact(f))
    : facts;
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

  // 7h-V (C127, J14 O2 (a) and its 7h-V section): the name and unit of a club
  // variable in the team's own results. The Metrics Core catalog
  // (catalogVisibilitySql) hides a club-owned definition from a team coach,
  // and it is not touched; instead this read names, for an active coach of
  // the activity's active team in that team's workspace (C99's predicate,
  // resolveVariableEditor, asked by the route through
  // `clubVariableNamesAllowed`), exactly the club-owned definitions of the
  // team's own club that appear in the facts already scoped above - never
  // the club's catalog, never another club's variable, never a key, icon or
  // description. Every other caller (an athlete, a club or platform
  // workspace, a private coach) gets {}, whether or not the activity holds
  // a club variable. The predicate is asked only when such a definition is
  // present; its errors propagate (the route answers a busy database with
  // the stable 503, so no "Metric" answer is cached). Archived variables
  // are named too: results are history. The unit is the current version's,
  // as the catalog gives it.
  let variableNamesById = {};
  const activity = activityRow.rows[0];
  if (!readContext.isAthleteSelf && typeof clubVariableNamesAllowed === "function"
      && readContext.scope?.type === "team" && activity.owner_scope === "team" && activity.owner_team_club_id
      && String(activity.owner_team_id).toLowerCase() === String(readContext.scope.teamId).toLowerCase()) {
    const definitionIds = [...new Set(scoped
      .filter((f) => f.factKind === "metric_value")
      .map((f) => f.detail?.metricDefinitionId)
      .filter((id) => typeof id === "string" && UUID_PATTERN.test(id)))];
    if (definitionIds.length) {
      const names = await query(
        `select d.id, d.label, d.short_label, v.unit
           from training_load.metric_definitions d
           left join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
          where d.id = any($1::uuid[]) and d.owner_scope = 'club' and d.owner_club_id = $2`,
        [definitionIds, activity.owner_team_club_id],
      );
      if (names.rowCount && await clubVariableNamesAllowed({ teamId: String(activity.owner_team_id), clubId: String(activity.owner_team_club_id) })) {
        variableNamesById = Object.fromEntries(names.rows.map((r) => [r.id, { label: r.label, shortLabel: r.short_label ?? null, unit: r.unit ?? null }]));
      }
    }
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

  // 6b-C1: the label of each estimated value (contract rule 10) on that fact only; every other fact is as before. A copy
  // source is named only when this answer already names that athlete (athleteNamesById covers the facts the caller may
  // see); an athlete reading their own results gets the method, the author and the date only.
  const estimateFacts = scoped.filter((f) => f.factKind === "metric_value" && f.detail?.entryMethod === "estimate");
  if (estimateFacts.length) {
    const labels = await readEstimateLabels({ query }, estimateFacts.map((f) => f.detail?.occasionId));
    const namesLower = new Map(Object.entries(athleteNamesById).map(([id, name]) => [String(id).toLowerCase(), name]));
    for (const fact of estimateFacts) {
      const estimate = estimateLabelFor(labels.get(String(fact.detail?.occasionId)), (id) => namesLower.get(String(id).toLowerCase()) ?? null);
      // A coach's read only: an athlete's facts hold no estimate by now (dropped above).
      if (estimate) fact.estimate = estimate;
    }
  }

  if (readContext.isAthleteSelf) return athleteSelfResults({ canonicalActivityId, facts: scoped, components, athleteId: readContext.athleteId, teamSession: activity.owner_scope === "team" });
  return { canonicalActivityId, facts: scoped, athleteNamesById, variableNamesById, components };
}

// ---- what an athlete gets of her own results (owner's decision 2026-11-16: all of them, read-only, nobody else's) ----
// A fixed list of fields per kind of fact; whatever the canonical read adds later reaches her only when it is added
// here. Not hers: ids of occasions, sources, versions and alias participants (import bookkeeping), how a value was
// entered, an estimated value (not shown to her at all), a note or a prescription on a performed component, the
// link-only facts.
const SELF_DETAIL = Object.freeze({
  metric_value: ["metricDefinitionId", "valueNumeric", "valueBoolean", "valueText", "unitAtCapture"],
  rpe: ["rpe", "durationMinutes", "srpe"],
  component_performance: ["componentId", "name", "componentTypeKey", "status", "actualDurationSeconds"],
});
const SELF_COMPONENT = Object.freeze(["id", "parentComponentId", "componentTypeKey", "name", "sortOrder", "plannedDurationSeconds", "actualDurationSeconds"]);
const pick = (from, keys) => Object.fromEntries(keys.map((key) => [key, from?.[key] ?? null]));
// `place(segmentId)` says where a value of a drill belongs: { componentId, drillOrdinal } (athleteSelfResults).
export function athleteSelfFact(fact, place = () => ({ componentId: null, drillOrdinal: null })) {
  const keys = SELF_DETAIL[fact.factKind];
  if (!keys) return null;
  const detail = pick(fact.detail, keys);
  if (fact.factKind === "metric_value") {
    // The whole session, or one drill of it: the drill's place in the session's own structure (`components`) and its
    // order among the drills - never the source's segment or event id. A drill nobody linked to a component is still
    // a drill, with no component.
    const segmentId = fact.detail?.segmentId ?? null;
    const placed = segmentId ? place(String(segmentId)) : null;
    detail.level = segmentId ? "drill" : "session";
    detail.componentId = placed?.componentId ?? null;
    detail.drillOrdinal = placed?.drillOrdinal ?? null;
    // Which drill, as a key that says nothing: two drills are two keys even when neither has a component.
    detail.drillKey = segmentId ? crypto.createHash("sha256").update(`athlete-drill|${segmentId}`).digest("hex").slice(0, 16) : null;
    // A key for a row on the screen, the same on every read, that says nothing: two values of one variable in one
    // place (a re-measurement) are told apart by it.
    detail.valueKey = crypto.createHash("sha256").update(`athlete-value|${fact.detail?.occasionId ?? ""}|${fact.detail?.metricDefinitionId ?? ""}`).digest("hex").slice(0, 16);
  }
  // No word about how a value was entered and no estimate label: an estimate never reaches this function's caller
  // (it is dropped from her facts first), and a fact that is one is refused here as well.
  if (isEstimateFact(fact)) return null;
  const out = { factKind: fact.factKind, detail };
  return out;
}
// Her own attendance in a session: a value of hers means she took part (whatever an older decision says - the coach
// is shown that disagreement, she is not); without a value, the coach's current decision about her in one word - no
// reason, no note, no author; otherwise nothing is said. Read from the decisions about HER only.
const SELF_ATTENDANCE = Object.freeze({ did_not_participate: "did_not_participate", participated_no_values: "participated_no_device_data" });
async function selfAttendance(canonicalActivityId, athleteId, hasValues, teamSession) {
  if (hasValues) return "participated";
  // A coach decides about an athlete only on a team's session (the roster); elsewhere there is nothing to read.
  if (!teamSession) return null;
  const decisions = await query(
    `select distinct d.decision_kind
       from training.activity_athlete_decisions d
      where d.activity_id in (select activity_id from training.activity_alias_ids($1)) and d.athlete_id = $2
        and d.superseded_by_decision_id is null and d.decision_kind <> 'cleared'`,
    [canonicalActivityId, athleteId],
  );
  // Two alias sessions that disagree about her (a merge the coach has not settled): nothing is said.
  if (decisions.rowCount !== 1) return null;
  return SELF_ATTENDANCE[decisions.rows[0].decision_kind] ?? "participated";
}
async function athleteSelfResults({ canonicalActivityId, facts, components, athleteId, teamSession }) {
  // Where each drill's values belong: the component of THIS session its segment is linked to, and its order among
  // the drills of the recordings it came from (a session can hold more than one recording, each numbering from 1).
  const segmentIds = [...new Set(facts.filter((f) => f.factKind === "metric_value").map((f) => f.detail?.segmentId).filter((id) => typeof id === "string" && UUID_PATTERN.test(id)))];
  const places = new Map();
  if (segmentIds.length) {
    const componentIds = new Set(components.map((c) => String(c.id)));
    const rows = await query(
      `select s.id, l.activity_component_id,
              dense_rank() over (order by e.occurred_instant nulls last, e.occurred_date, e.id, s.segment_order, s.id) as ordinal
         from training_load.metric_event_segments s
         join training_load.metric_events e on e.id = s.event_id
         left join training.activity_component_metric_segment_links l on l.metric_event_segment_id = s.id and l.link_status = 'confirmed'
        where s.event_id in (select event_id from training_load.metric_event_segments where id = any($1::uuid[]))`,
      [segmentIds],
    );
    for (const r of rows.rows) {
      const componentId = r.activity_component_id && componentIds.has(String(r.activity_component_id)) ? String(r.activity_component_id) : null;
      places.set(String(r.id), { componentId, drillOrdinal: Number(r.ordinal) });
    }
  }
  const own = facts.map((f) => athleteSelfFact(f, (segmentId) => places.get(segmentId) ?? { componentId: null, drillOrdinal: null })).filter(Boolean);
  const mine = facts.filter((f) => f.factKind === "metric_value");
  const myAttendance = await selfAttendance(canonicalActivityId, athleteId, mine.length > 0, teamSession);
  const recordedBy = recordedByOf({ device: mine.some((f) => DEVICE_METHODS.includes(f.detail?.entryMethod)), any: mine.length > 0 });
  // The session's structure as far as it is hers: the components she has a result on (a value placed there, or her
  // own performance of it) and the ones they sit under. A drill only another athlete did is not listed to her.
  const byId = new Map(components.map((c) => [String(c.id), c]));
  const hers = new Set();
  for (const f of own) {
    let id = f.detail?.componentId ? String(f.detail.componentId) : null;
    while (id && byId.has(id) && !hers.has(id)) {
      hers.add(id);
      id = byId.get(id).parentComponentId ? String(byId.get(id).parentComponentId) : null;
    }
  }
  const ownComponents = components.filter((c) => hers.has(String(c.id)));
  // The name and unit of exactly the variables in her own facts, whoever owns them (a club's or a team's variable
  // has no name in her catalog read): read by id, never the catalog, never a key, an icon, an owner or a description.
  const definitionIds = [...new Set(own.filter((f) => f.factKind === "metric_value").map((f) => f.detail.metricDefinitionId).filter((id) => typeof id === "string" && UUID_PATTERN.test(id)))];
  let variableNamesById = {};
  if (definitionIds.length) {
    const names = await query(
      `select d.id, d.label, d.short_label, v.unit
         from training_load.metric_definitions d
         left join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
        where d.id = any($1::uuid[])`,
      [definitionIds],
    );
    variableNamesById = Object.fromEntries(names.rows.map((r) => [r.id, { label: r.label, shortLabel: r.short_label ?? null, unit: r.unit ?? null }]));
  }
  return { canonicalActivityId, myAttendance, recordedBy, facts: own, variableNamesById, components: ownComponents.map((c) => pick(c, SELF_COMPONENT)) };
}

// How HER values of a session came to be recorded, for an athlete: by a device (an imported value), by a coach
// (entered by hand as a measurement), or neither (no measured value of hers: a planned or rated session, or one
// where her only values are estimates). Never the source's name.
// Read from her own effective values, not from the activity's origin, which does not tell the two apart.
export function recordedByOf({ device, any }) {
  if (device) return "device";
  return any ? "coach" : null;
}
const DEVICE_METHODS = ["api_import", "csv_import"];
// SQL: whether a participant's effective values - her alias participants' after a merge included, as the detail
// reads them - include any (and any by a device). One row, two booleans.
export function recordedBySql(participantIdSql) {
  return `(select coalesce(bool_or(o.entry_method in ('api_import', 'csv_import')), false) as device, count(*) > 0 as any
            from training.activity_participant_metric_participant_links mpl
            join training_load.metric_measurement_occasions o on o.event_participant_id = mpl.metric_event_participant_id
            join training_load.metric_values v on v.occasion_id = o.id
           where mpl.activity_participant_id in (select pa.participant_id from training.participant_alias_ids(${participantIdSql}) pa) and mpl.link_status = 'confirmed'
             and o.superseded_by_occasion_id is null and o.import_conflict_status is null and o.entry_method <> 'estimate'
             and (o.source_identity_id is null or exists (select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id)))`;
}

// Whether she has at least one recorded session (owner, 2026-11-16: "My training" is shown only then): she is a
// participant of a session that holds measured values - a device's, or entered by hand by a coach; never an
// estimate (a session whose only values are estimates does not count) - hers or
// another participant's of that same session ("you took part; no data of yours was recorded" is such a session). A
// planned session she only rated does not count. One boolean: no count, no date, the same answer for every reason
// she has none. Sessions on a team or club archived later count (her history stays hers).
export async function athleteHasRecordedSessions(athleteId) {
  const found = await query(
    `select exists (
       select 1
         from training.activity_participants ap
         join training.activities a on a.id = ap.activity_id
        where ap.athlete_id = $1 and ap.merge_status = 'canonical' and a.lifecycle_state <> 'superseded'
          -- A session whose only values of HERS are estimates does not count (the Rukovodilac's rule, 2026-11-16).
          and not exists (
            select 1
              from training.participant_alias_ids(ap.id) pa
              join training.activity_participant_metric_participant_links ml on ml.activity_participant_id = pa.participant_id and ml.link_status = 'confirmed'
              join training_load.metric_measurement_occasions eo on eo.event_participant_id = ml.metric_event_participant_id
              join training_load.metric_values ev on ev.occasion_id = eo.id
             where eo.superseded_by_occasion_id is null and eo.import_conflict_status is null
            having bool_or(eo.entry_method = 'estimate') and not bool_or(eo.entry_method <> 'estimate'))
          and exists (
            select 1
              from training.activity_alias_ids(a.id) aa
              join training.activity_participants ap2 on ap2.activity_id = aa.activity_id
              join training.activity_participant_metric_participant_links mpl on mpl.activity_participant_id = ap2.id and mpl.link_status = 'confirmed'
              join training_load.metric_measurement_occasions o on o.event_participant_id = mpl.metric_event_participant_id
              join training_load.metric_values v on v.occasion_id = o.id
             where o.superseded_by_occasion_id is null and o.import_conflict_status is null and o.entry_method <> 'estimate'
               and (o.source_identity_id is null or exists (select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id)))
     ) as has`,
    [athleteId],
  );
  return found.rows[0].has === true;
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
  // The READ scope (D8): a club workspace lists its active teams' activities too.
  const scopeSql = readContext.isAthleteSelf ? "true" : activityReadScopeSqlForWorkspace(readContext.scope, "a", params);
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
            ap.id as participant_id, ap.athlete_id, ap.local_date, ap.participation_status${readContext.isAthleteSelf ? ", rb.device as recorded_device, rb.any as recorded_any" : ""}
     from training.activity_participants ap
     join training.activities a on a.id = ap.activity_id
     ${readContext.isAthleteSelf ? `cross join lateral ${recordedBySql("ap.id")} rb` : ""}
     where ap.local_date between $1 and $2
       and a.lifecycle_state <> 'superseded' and ap.merge_status = 'canonical'
       and (${scopeSql}) and (${athleteSql}) and (${cursorSql})
     order by ap.local_date desc, a.id desc, ap.id desc
     limit $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > pageSize;
  // Her own rows without the staff's bookkeeping (where the activity came from, its lifecycle, whose it is); how it
  // was recorded is one neutral word.
  const selfRow = ({ ownerScope, origin, lifecycleState, ...row }) => row;
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
    ...(readContext.isAthleteSelf ? { recordedBy: recordedByOf({ device: r.recorded_device, any: r.recorded_any }) } : {}),
  }));
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? { localDate: last.localDate, activityId: last.activityId, participantId: last.participantId } : null;
  return { rows: readContext.isAthleteSelf ? rows.map(selfRow) : rows, nextCursor };
}
