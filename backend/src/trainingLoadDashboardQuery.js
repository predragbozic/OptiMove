// Training Load Analysis Dashboard — the real, set-based query engine.
//
// This replaces the disposable-DB design proof's own per-activity N+1
// adapter (feature/training-load-analysis-dashboard-model's test-harness.mjs
// queryMetricSeries()/queryBuiltInSeries()) with a genuine SET-BASED query
// plan: for any date range this request touches, the authorized activity
// set is resolved ONCE, and every canonical Activity/Metrics-Core fact for
// that WHOLE set is fetched in ONE query (a LATERAL join over
// training.canonical_activity_results(), a real `language sql stable`
// function whose body is a handful of recursive CTEs, never a per-row
// loop) — never one query per activity. The two-stage aggregation, no-
// double-count/conflict, and canonical-component-identity logic below is
// ported byte-faithful from the design proof (it was proven correct there
// across 161 tests) — only the FETCHING underneath it changed.
//
// Contract preserved exactly from DASHBOARD_MODEL_REPORT.md (Round 6):
//  - activityId/componentId always intersect with the already-authorized
//    set, never widen it; componentId narrows only component-grain
//    facts, session-level facts (including built-ins) for the SAME
//    parent activity stay visible.
//  - a standalone (non-built-in) day-scope series under an activity/
//    component filter returns zero rows, structurally.
//  - real session/component/day/week/athlete/cohort grain; Stage 1
//    (metric's own daily_aggregation_method) then Stage 2 (the series'
//    own analytical_aggregation).
//  - no-double-count via the real measurement-TARGET state machine
//    (athlete+grain+grainKey+unit); >1 surviving candidate on one target
//    is a real conflict (conflict:true, value:null), never silently
//    summed or dropped.
//  - a historical unit change stays two separate groups (unitConflict),
//    never blended or silently converted.
//  - source_policy genuinely filters (all_with_conflicts/source_connection/
//    manual/api_import/csv_import/derived).
//  - an archived metric's already-bound series keeps reading its full
//    history — nothing here checks metric_definitions.state at query
//    time, only at BINDING time (schema triggers).
import { query } from "./db.js";

const RECOGNIZED_DATA_WORKSPACE_TYPES = ["platform", "club", "team", "private_coach", "athlete"];

function requireWorkspaceType(dataWorkspaceType) {
  if (!RECOGNIZED_DATA_WORKSPACE_TYPES.includes(dataWorkspaceType)) {
    throw new Error(`trainingLoadDashboardQuery: dataWorkspaceType must be one of ${RECOGNIZED_DATA_WORKSPACE_TYPES.join("/")} (got ${dataWorkspaceType})`);
  }
}

// ------------------------------------------------------------
// Set-based fetchers — each is ONE query regardless of how many
// activities/metrics/occasions are involved.
// ------------------------------------------------------------

// The authorized activity id set for one date range + workspace +
// (optional) athlete filter — mirrors the real, already-shipped
// GET /api/training-activity list-query's own workspace scoping.
async function fetchAuthorizedActivityIds({ dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, dateFrom, dateTo, athleteIds }) {
  requireWorkspaceType(dataWorkspaceType);
  const params = [dateFrom, dateTo];
  let scopeSql = "true";
  if (dataWorkspaceType === "club") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `a.owner_scope='club' and a.owner_club_id=$${params.length}`;
  } else if (dataWorkspaceType === "team") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `a.owner_scope='team' and a.owner_team_id=$${params.length}`;
  } else if (dataWorkspaceType === "private_coach") {
    params.push(dataWorkspaceUserId);
    scopeSql = `a.owner_scope='user' and a.owner_user_id=$${params.length}`;
  }
  const effectiveAthleteIds = dataWorkspaceType === "athlete" ? [athleteWorkspaceAthleteId] : athleteIds;
  let athleteSql = "true";
  if (effectiveAthleteIds?.length) {
    params.push(effectiveAthleteIds);
    athleteSql = `exists (select 1 from training.activity_participants p where p.activity_id=a.id and p.athlete_id = any($${params.length}::uuid[]) and p.merge_status='canonical')`;
  }
  const r = await query(
    `select a.id from training.activities a where a.occurred_local_date between $1 and $2 and a.lifecycle_state <> 'superseded' and (${scopeSql}) and (${athleteSql})`,
    params,
  );
  return r.rows.map((row) => row.id);
}

async function resolveComponentOwningActivityId(componentId) {
  const r = await query(`select activity_id from training.activity_components where id = $1`, [componentId]);
  return r.rows[0]?.activity_id ?? null;
}

// ONE query for the WHOLE activity set: activity local date/start instant
// LATERAL-joined with every canonical fact training.canonical_activity_
// results() would produce per activity. This is the single fetch that
// replaces the design proof's own per-activity loop.
async function fetchCanonicalFactsForActivities(activityIds) {
  if (!activityIds.length) return { factRows: [], activityDT: {} };
  const r = await query(
    `select a.id as activity_id, a.occurred_local_date::text as local_date, a.started_at,
            r.canonical_activity_id, r.canonical_participant_id, r.athlete_id, r.fact_kind, r.detail
     from training.activities a
     cross join lateral training.canonical_activity_results(a.id) r
     where a.id = any($1::uuid[])`,
    [activityIds],
  );
  const activityDT = {};
  for (const row of r.rows) {
    if (!activityDT[row.activity_id]) {
      activityDT[row.activity_id] = { localDate: row.local_date, startedAt: row.started_at ? row.started_at.toISOString() : null };
    }
  }
  return { factRows: r.rows, activityDT };
}

async function fetchOccasionContexts(occasionIds) {
  const uniq = [...new Set(occasionIds)];
  if (!uniq.length) return {};
  const r = await query(
    `select o.id as occasion_id, e.source_connection_id, e.scope_level as event_scope_level, e.occurred_instant as event_instant
     from training_load.metric_measurement_occasions o
     join training_load.metric_event_participants ep on ep.id = o.event_participant_id
     join training_load.metric_events e on e.id = ep.event_id
     where o.id = any($1::uuid[])`,
    [uniq],
  );
  return Object.fromEntries(r.rows.map((row) => [row.occasion_id, {
    sourceConnectionId: row.source_connection_id,
    eventScopeLevel: row.event_scope_level,
    eventInstant: row.event_instant ? row.event_instant.toISOString() : null,
  }]));
}

async function fetchVersionInfo(versionIds) {
  const uniq = [...new Set(versionIds)];
  if (!uniq.length) return {};
  const r = await query(`select id, daily_aggregation_method, value_type from training_load.metric_definition_versions where id = any($1::uuid[])`, [uniq]);
  return Object.fromEntries(r.rows.map((row) => [row.id, { dailyAggregationMethod: row.daily_aggregation_method, valueType: row.value_type }]));
}

// One query for EVERY session_count/last_session_date built-in request in
// this batch, across the WHOLE authorized activity set — never per
// activity.
async function fetchActivityParticipantRows(activityIds) {
  if (!activityIds.length) return [];
  const r = await query(
    `select p.athlete_id, a.id as activity_id, a.occurred_local_date::text as local_date
     from training.activity_participants p join training.activities a on a.id = p.activity_id
     where a.id = any($1::uuid[]) and a.lifecycle_state <> 'superseded' and p.merge_status = 'canonical'`,
    [activityIds],
  );
  return r.rows;
}

// ONE query per DISTINCT metric definition id needing a standalone
// day-scope fetch in this batch — never one query per widget. `metricIds`
// is deduplicated by the caller (buildRangeContext) before this is
// called, and the whole set is fetched together via `= any($...)`.
async function fetchDayLevelFactsForMetrics(metricIds, { dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, dateFrom, dateTo }) {
  if (!metricIds.length) return [];
  requireWorkspaceType(dataWorkspaceType);
  const params = [metricIds, dateFrom, dateTo];
  let scopeSql = "true";
  let athleteSql = "true";
  if (dataWorkspaceType === "athlete") {
    params.push(athleteWorkspaceAthleteId);
    athleteSql = `p.athlete_id = $${params.length}`;
  } else if (dataWorkspaceType === "club") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `ev.owner_scope='club' and ev.owner_club_id=$${params.length}`;
  } else if (dataWorkspaceType === "team") {
    params.push(dataWorkspaceScopeId);
    scopeSql = `ev.owner_scope='team' and ev.owner_team_id=$${params.length}`;
  } else if (dataWorkspaceType === "private_coach") {
    params.push(dataWorkspaceUserId);
    scopeSql = `ev.owner_scope='user' and ev.owner_user_id=$${params.length}`;
  }
  const r = await query(
    `select v.metric_definition_id, p.athlete_id, ev.occurred_date::text as local_date, ev.occurred_instant as event_instant,
            ev.source_connection_id, o.id as occasion_id, o.entry_method,
            v.metric_definition_version_id, v.value_numeric, v.value_boolean, v.value_text, v.unit_at_capture,
            v.aggregation_role, v.coverage, v.is_derived
     from training_load.metric_events ev
     join training_load.metric_event_participants p on p.event_id = ev.id
     join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
     join training_load.metric_values v on v.occasion_id = o.id
     where ev.scope_level = 'day'
       and v.metric_definition_id = any($1::uuid[])
       and ev.occurred_date between $2 and $3
       and (${scopeSql})
       and (${athleteSql})
       and o.superseded_by_occasion_id is null
       and o.import_conflict_status is null
       and (o.source_identity_id is null or exists (
         select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id
       ))`,
    params,
  );
  const versionInfo = await fetchVersionInfo(r.rows.map((row) => row.metric_definition_version_id));
  return r.rows.map((row) => {
    const ver = versionInfo[row.metric_definition_version_id] || {};
    return {
      metricDefinitionId: row.metric_definition_id,
      athleteId: row.athlete_id, activityId: null, componentKey: null, canonicalComponentId: null,
      grain: "day", grainKey: row.local_date,
      date: row.local_date, startedAt: row.event_instant ? row.event_instant.toISOString() : null,
      occasionId: row.occasion_id, versionId: row.metric_definition_version_id,
      dailyAggregationMethod: ver.dailyAggregationMethod ?? null, valueType: ver.valueType ?? "numeric",
      unit: row.unit_at_capture,
      aggregationRole: row.aggregation_role, coverage: row.coverage,
      entryMethod: row.entry_method, isDerived: row.is_derived,
      sourceConnectionId: row.source_connection_id ?? null,
      value: row.value_numeric ?? row.value_text ?? row.value_boolean,
    };
  });
}

// ------------------------------------------------------------
// Range context — everything a whole batch of widgets sharing the SAME
// (dateFrom, dateTo, workspace, athleteIds, activityId, componentId)
// needs, fetched ONCE and reused by every series in the batch. This is
// what makes the batch endpoint genuinely set-based: N widgets against
// the SAME range never cost more DB round trips than 1 widget would.
// ------------------------------------------------------------
async function buildRangeContext({ dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, athleteIds, dateFrom, dateTo, activityId, componentId }, dayScopeMetricIds) {
  const workspaceArgs = { dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, dateFrom, dateTo, athleteIds };
  let authorizedActivityIds = await fetchAuthorizedActivityIds(workspaceArgs);

  // activityId/componentId ALWAYS intersect with the already-authorized
  // set — never trusted outright, never widening it.
  let resolvedComponentId = null;
  if (componentId) {
    const owningActivityId = await resolveComponentOwningActivityId(componentId);
    if (owningActivityId && authorizedActivityIds.includes(owningActivityId) && (!activityId || owningActivityId === activityId)) {
      authorizedActivityIds = [owningActivityId];
      resolvedComponentId = componentId;
    } else {
      authorizedActivityIds = [];
    }
  } else if (activityId) {
    authorizedActivityIds = authorizedActivityIds.includes(activityId) ? [activityId] : [];
  }

  const { factRows, activityDT } = await fetchCanonicalFactsForActivities(authorizedActivityIds);

  // Build the segment -> canonical component map from the SAME fact rows
  // already fetched (no second round trip) — component_metric_segment_
  // link facts, link_status='confirmed' only (per canonical_activity_
  // results()'s own real SQL).
  const segmentToComponentId = new Map();
  for (const row of factRows) {
    if (row.fact_kind === "component_metric_segment_link") segmentToComponentId.set(row.detail.metricEventSegmentId, row.detail.componentId);
  }

  const metricValueRows = factRows.filter((r) => r.fact_kind === "metric_value");
  const rpeRows = factRows.filter((r) => r.fact_kind === "rpe");
  const occContext = await fetchOccasionContexts(metricValueRows.map((r) => r.detail.occasionId));
  const versionInfo = await fetchVersionInfo(metricValueRows.map((r) => r.detail.metricDefinitionVersionId));

  // Every real Metrics-Core metric_value fact, canonicalized exactly like
  // the design proof's own queryMetricSeries() — grain/component identity
  // derived once here, shared by every series that needs this metric.
  const metricFactsByDefinition = new Map();
  for (const row of metricValueRows) {
    const d = row.detail;
    const defId = d.metricDefinitionId;
    if (!metricFactsByDefinition.has(defId)) metricFactsByDefinition.set(defId, []);
    const occ = occContext[d.occasionId] || {};
    const dt = activityDT[row.activity_id] || {};
    const ver = versionInfo[d.metricDefinitionVersionId] || {};
    const grain = d.segmentId != null ? "component" : "session";
    const canonicalComponentId = grain === "component" ? (segmentToComponentId.get(d.segmentId) ?? null) : null;
    if (grain === "component" && canonicalComponentId == null) continue; // no CONFIRMED canonical link — cannot be safely bucketed
    if (resolvedComponentId && grain === "component" && canonicalComponentId !== resolvedComponentId) continue; // componentId filter — component-grain only, session-level stays visible
    metricFactsByDefinition.get(defId).push({
      athleteId: row.athlete_id, canonicalActivityId: row.canonical_activity_id, canonicalParticipantId: row.canonical_participant_id,
      activityId: row.activity_id, componentKey: d.segmentId ?? null, canonicalComponentId,
      grain, grainKey: grain === "component" ? canonicalComponentId : row.activity_id,
      date: dt.localDate, startedAt: dt.startedAt ?? occ.eventInstant ?? null,
      occasionId: d.occasionId, versionId: d.metricDefinitionVersionId,
      dailyAggregationMethod: ver.dailyAggregationMethod ?? null, valueType: ver.valueType ?? "numeric",
      unit: d.unitAtCapture,
      aggregationRole: d.aggregationRole, coverage: d.coverage,
      entryMethod: occ.entryMethod ?? null, isDerived: d.isDerived,
      sourceConnectionId: occ.sourceConnectionId ?? null,
      value: d.valueNumeric ?? d.valueText ?? d.valueBoolean,
    });
  }

  const rpeFacts = { rpe: [], srpe: [], duration_minutes: [] };
  for (const row of rpeRows) {
    const d = row.detail;
    const dt = activityDT[row.activity_id] || {};
    const common = { grain: "session", grainKey: row.activity_id, activityId: row.activity_id, date: dt.localDate, startedAt: dt.startedAt, occasionId: null };
    if (d.rpe != null) rpeFacts.rpe.push({ athleteId: row.athlete_id, value: d.rpe, unit: null, valueType: "numeric", dailyAggregationMethod: null, ...common });
    if (d.srpe != null) rpeFacts.srpe.push({ athleteId: row.athlete_id, value: d.srpe, unit: null, valueType: "numeric", dailyAggregationMethod: null, ...common });
    if (d.durationMinutes != null) rpeFacts.duration_minutes.push({ athleteId: row.athlete_id, value: d.durationMinutes, unit: null, valueType: "numeric", dailyAggregationMethod: null, ...common });
  }

  const participantRows = await fetchActivityParticipantRows(authorizedActivityIds);

  let dayLevelFactsByDefinition = new Map();
  if (dayScopeMetricIds?.length) {
    // A standalone day-scope series under an activityId/componentId filter
    // returns ZERO rows, structurally — the day-level fetch is never even
    // attempted when either filter narrowed the set.
    if (!activityId && !componentId) {
      const rows = await fetchDayLevelFactsForMetrics(dayScopeMetricIds, workspaceArgs);
      for (const f of rows) {
        if (!dayLevelFactsByDefinition.has(f.metricDefinitionId)) dayLevelFactsByDefinition.set(f.metricDefinitionId, []);
        dayLevelFactsByDefinition.get(f.metricDefinitionId).push(f);
      }
    }
  }

  return { authorizedActivityIds, metricFactsByDefinition, rpeFacts, participantRows, dayLevelFactsByDefinition };
}

// ------------------------------------------------------------
// Pure JS reduction — ported byte-faithful from the design proof
// (test-harness.mjs), proven correct there across 161 tests. No DB
// access below this point.
// ------------------------------------------------------------

function resolveFactsToRows(facts, { dataScopeLevel, athleteIds, aggregationRolePolicy, coveragePolicy, sourcePolicy, sourceConnectionId }) {
  const roleSets = {
    standalone_only: ["standalone"],
    standalone_and_source_rollup: ["standalone", "source_rollup"],
    all_including_derived: ["standalone", "source_rollup", "derived_rollup"],
  };
  const allowedRoles = roleSets[aggregationRolePolicy || "standalone_and_source_rollup"];
  const coverageSets = { complete_only: ["complete", "not_applicable"], complete_and_partial: ["complete", "partial", "not_applicable"], any: ["complete", "partial", "unknown", "not_applicable"] };
  const allowedCoverage = coverageSets[coveragePolicy || "complete_and_partial"];
  const effectiveSourcePolicy = sourcePolicy || "all_with_conflicts";

  let candidates = facts.filter((f) => f.grain === dataScopeLevel);
  if (athleteIds) candidates = candidates.filter((f) => athleteIds.includes(f.athleteId));
  candidates = candidates.filter((f) => allowedRoles.includes(f.aggregationRole) && allowedCoverage.includes(f.coverage));
  if (effectiveSourcePolicy === "derived") candidates = candidates.filter((f) => f.isDerived);
  else if (effectiveSourcePolicy === "source_connection") candidates = candidates.filter((f) => f.sourceConnectionId === sourceConnectionId);
  else if (["manual", "api_import", "csv_import"].includes(effectiveSourcePolicy)) candidates = candidates.filter((f) => f.entryMethod === effectiveSourcePolicy);
  else if (effectiveSourcePolicy !== "all_with_conflicts") throw new Error(`resolveFactsToRows: unknown source_policy ${effectiveSourcePolicy}`);

  // A MEASUREMENT TARGET = canonical participant + this metric (implicit)
  // + grain + grain identity + unit. Two normal readings on two DIFFERENT
  // sessions/days are simply two DIFFERENT targets. A conflict is ONLY
  // >1 surviving candidate on the SAME target.
  const targets = new Map();
  for (const f of candidates) {
    const key = `${f.athleteId}|${f.grain}|${f.grainKey}|${f.unit ?? "__none__"}`;
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key).push(f);
  }

  const byAthlete = new Map();
  for (const group of targets.values()) {
    const athleteId = group[0].athleteId;
    if (!byAthlete.has(athleteId)) byAthlete.set(athleteId, { athleteId, values: [], targetConflicts: [] });
    const bucket = byAthlete.get(athleteId);
    if (group.length === 1) {
      bucket.values.push(group[0]);
    } else {
      bucket.targetConflicts.push({ grain: group[0].grain, grainKey: group[0].grainKey, unit: group[0].unit, candidates: group });
    }
  }

  for (const row of byAthlete.values()) {
    const byUnit = new Map();
    for (const v of row.values) {
      const k = v.unit ?? "__none__";
      if (!byUnit.has(k)) byUnit.set(k, []);
      byUnit.get(k).push(v);
    }
    row.groups = [...byUnit.entries()].map(([unit, values]) => ({ unit: unit === "__none__" ? null : unit, values, conflict: false }));
    for (const tc of row.targetConflicts) {
      const g = row.groups.find((g) => g.unit === (tc.unit ?? null));
      if (g) g.conflict = true; else row.groups.push({ unit: tc.unit ?? null, values: [], conflict: true });
    }
    const distinctUnits = new Set(row.values.map((v) => v.unit));
    row.unitConflict = distinctUnits.size > 1;
    row.conflict = row.targetConflicts.length > 0;
  }
  return [...byAthlete.values()];
}

function compareForLast(a, b) {
  if (a.instant !== b.instant) return a.instant < b.instant ? -1 : 1;
  return a.tiebreakId < b.tiebreakId ? -1 : (a.tiebreakId > b.tiebreakId ? 1 : 0);
}

function reduceTyped(items, method, valueType) {
  if (!items.length) return null;
  const effectiveMethod = method || "none";
  if ((valueType === "text" || valueType === "boolean") && !["last", "none"].includes(effectiveMethod)) {
    throw new Error(`reduceTyped: aggregation '${effectiveMethod}' is not supported for value_type '${valueType}'`);
  }
  if (effectiveMethod === "none") {
    return items.length === 1 ? items[0].value : items.map((i) => i.value);
  }
  if (effectiveMethod === "last") {
    const sorted = [...items].sort(compareForLast);
    return sorted[sorted.length - 1].value;
  }
  if (valueType !== "numeric") {
    throw new Error(`reduceTyped: aggregation '${effectiveMethod}' requires value_type 'numeric' (got '${valueType}')`);
  }
  const nums = items.map((i) => Number(i.value));
  if (effectiveMethod === "sum") return nums.reduce((a, b) => a + b, 0);
  if (effectiveMethod === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (effectiveMethod === "max") return Math.max(...nums);
  throw new Error(`reduceTyped: unknown aggregation method ${effectiveMethod}`);
}

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayIndex = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayIndex);
  return monday.toISOString().slice(0, 10);
}

export function shiftDateRange(dateFrom, dateTo, comparisonPeriod) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  if (comparisonPeriod === "previous_period") {
    const spanDays = Math.round((to - from) / 86400000) + 1;
    const newTo = new Date(from); newTo.setUTCDate(newTo.getUTCDate() - 1);
    const newFrom = new Date(newTo); newFrom.setUTCDate(newFrom.getUTCDate() - (spanDays - 1));
    return { dateFrom: newFrom.toISOString().slice(0, 10), dateTo: newTo.toISOString().slice(0, 10) };
  }
  if (comparisonPeriod === "previous_year") {
    const newFrom = new Date(from); newFrom.setUTCFullYear(newFrom.getUTCFullYear() - 1);
    const newTo = new Date(to); newTo.setUTCFullYear(newTo.getUTCFullYear() - 1);
    return { dateFrom: newFrom.toISOString().slice(0, 10), dateTo: newTo.toISOString().slice(0, 10) };
  }
  throw new Error(`shiftDateRange: unknown comparisonPeriod ${comparisonPeriod}`);
}

function pushConflict(out, athleteKey, tc, bucketKey) {
  if (bucketKey == null) return;
  const existing = out.find((o) => o.bucketKey === bucketKey && o.unit === (tc.unit ?? null) && o.athleteId === athleteKey);
  if (existing) {
    existing.value = null;
    existing.conflict = true;
    existing.conflictCandidates = tc.candidates;
  } else {
    out.push({ athleteId: athleteKey, unit: tc.unit ?? null, bucketKey, value: null, conflict: true, conflictCandidates: tc.candidates, rawCount: 0 });
  }
}

function reduceRows(rows, { groupBy, analyticalAggregation }) {
  const out = [];

  function finalizeStage2(g) {
    const items = g.items;
    const valueType = items[0]?.valueType ?? "numeric";
    if (new Set(items.map((i) => i.valueType)).size > 1) {
      return { athleteId: g.athleteId, unit: g.unit, bucketKey: g.bucketKey, value: null, typeConflict: true, rawCount: items.length };
    }
    try {
      const value = reduceTyped(items.map((i) => ({ value: i.value, instant: i.startedAt || i.date || "", tiebreakId: i.occasionId || i.activityId || "" })), analyticalAggregation, valueType);
      return { athleteId: g.athleteId, unit: g.unit, bucketKey: g.bucketKey, value, rawCount: items.length };
    } catch (err) {
      return { athleteId: g.athleteId, unit: g.unit, bucketKey: g.bucketKey, value: null, error: err.message, rawCount: items.length };
    }
  }

  if (groupBy === "session" || groupBy === "component") {
    const buckets = new Map();
    for (const row of rows) {
      for (const v of row.values) {
        let bucketKey;
        if (groupBy === "session") bucketKey = (v.grain === "session" || v.grain === "component") ? (v.grain === "session" ? v.grainKey : v.activityId) : null;
        else bucketKey = v.grain === "component" ? v.grainKey : null;
        if (bucketKey == null) continue;
        const key = `${row.athleteId}|${v.unit ?? "__none__"}|${bucketKey}`;
        if (!buckets.has(key)) buckets.set(key, { athleteId: row.athleteId, unit: v.unit ?? null, bucketKey, items: [] });
        buckets.get(key).items.push(v);
      }
    }
    for (const b of buckets.values()) out.push(finalizeStage2(b));
    for (const row of rows) {
      for (const tc of row.targetConflicts || []) {
        if (groupBy === "session" && tc.grain !== "session" && tc.grain !== "component") continue;
        if (groupBy === "component" && tc.grain !== "component") continue;
        const bucketKey = tc.grain === "session" ? tc.grainKey : (groupBy === "session" ? tc.candidates[0]?.activityId : tc.grainKey);
        pushConflict(out, row.athleteId, tc, bucketKey);
      }
    }
    return out;
  }

  const perDate = new Map();
  for (const row of rows) {
    for (const v of row.values) {
      const date = v.date ?? "unknown";
      const key = `${row.athleteId}|${v.unit ?? "__none__"}|${date}`;
      if (!perDate.has(key)) perDate.set(key, { athleteId: row.athleteId, unit: v.unit ?? null, date, items: [] });
      perDate.get(key).items.push(v);
    }
  }
  const phase1 = [];
  for (const g of perDate.values()) {
    const items = g.items;
    if (items.length > 1 && items.some((i) => i.dailyAggregationMethod != null)) {
      const types = new Set(items.map((i) => i.valueType));
      if (types.size > 1) {
        phase1.push({ athleteId: g.athleteId, unit: g.unit, date: g.date, value: null, valueType: "numeric", typeConflict: true, rawCount: items.length });
        continue;
      }
      const methods = new Set(items.map((i) => i.dailyAggregationMethod).filter((m) => m != null));
      if (methods.size > 1) {
        phase1.push({ athleteId: g.athleteId, unit: g.unit, date: g.date, value: null, valueType: [...types][0], semanticConflict: true, conflictingMethods: [...methods], rawCount: items.length });
        continue;
      }
      const method = [...methods][0];
      const valueType = [...types][0];
      try {
        const reduced = reduceTyped(items.map((i) => ({ value: i.value, instant: i.startedAt || i.date || "", tiebreakId: i.occasionId || i.activityId || "" })), method, valueType);
        phase1.push({ athleteId: g.athleteId, unit: g.unit, date: g.date, value: reduced, valueType, startedAt: items[items.length - 1].startedAt, occasionId: null, activityId: null, rawCount: items.length });
      } catch (err) {
        phase1.push({ athleteId: g.athleteId, unit: g.unit, date: g.date, value: null, valueType, error: err.message, rawCount: items.length });
      }
    } else {
      for (const i of items) phase1.push({ athleteId: g.athleteId, unit: g.unit, date: g.date, value: i.value, valueType: i.valueType, startedAt: i.startedAt, occasionId: i.occasionId, activityId: i.activityId, rawCount: 1 });
    }
  }
  const carryThrough = phase1.filter((p) => p.typeConflict || p.semanticConflict || p.error);
  const clean = phase1.filter((p) => !p.typeConflict && !p.semanticConflict && !p.error);

  function bucketKeyForDate(date) {
    if (groupBy === "day") return date ?? "unknown";
    if (groupBy === "week") return date ? isoWeekKey(date) : "unknown";
    return "all";
  }

  for (const p of carryThrough) {
    const athleteKey = groupBy === "cohort" ? null : p.athleteId;
    out.push({ athleteId: athleteKey, unit: p.unit, bucketKey: bucketKeyForDate(p.date), value: null, typeConflict: p.typeConflict, semanticConflict: p.semanticConflict, conflictingMethods: p.conflictingMethods, error: p.error, rawCount: p.rawCount });
  }

  const buckets = new Map();
  for (const p of clean) {
    const athleteKey = groupBy === "cohort" ? null : p.athleteId;
    const bucketKey = bucketKeyForDate(p.date);
    const key = `${athleteKey}|${p.unit ?? "__none__"}|${bucketKey}`;
    if (!buckets.has(key)) buckets.set(key, { athleteId: athleteKey, unit: p.unit ?? null, bucketKey, items: [] });
    buckets.get(key).items.push(p);
  }
  for (const b of buckets.values()) out.push(finalizeStage2(b));

  for (const row of rows) {
    for (const tc of row.targetConflicts || []) {
      const sample = tc.candidates[0];
      const bucketKey = bucketKeyForDate(sample.date);
      const athleteKey = groupBy === "cohort" ? null : row.athleteId;
      pushConflict(out, athleteKey, tc, bucketKey);
    }
  }
  return out;
}

// ------------------------------------------------------------
// Per-series entry points, fed from a SHARED range context — no DB
// access happens here, only in buildRangeContext above.
// ------------------------------------------------------------

function queryMetricSeriesFromContext(ctx, { metricDefinitionId, dataScopeLevel, aggregationRolePolicy, coveragePolicy, sourcePolicy, sourceConnectionId, athleteIds }) {
  if (dataScopeLevel === "day") {
    const facts = ctx.dayLevelFactsByDefinition.get(metricDefinitionId) || [];
    return resolveFactsToRows(facts, { dataScopeLevel, athleteIds, aggregationRolePolicy, coveragePolicy, sourcePolicy, sourceConnectionId });
  }
  const facts = ctx.metricFactsByDefinition.get(metricDefinitionId) || [];
  return resolveFactsToRows(facts, { dataScopeLevel, athleteIds, aggregationRolePolicy, coveragePolicy, sourcePolicy, sourceConnectionId });
}

function queryBuiltInSeriesFromContext(ctx, { key, athleteIds }) {
  if (key === "session_count" || key === "last_session_date") {
    const byAthlete = new Map();
    for (const row of ctx.participantRows) {
      if (athleteIds && !athleteIds.includes(row.athlete_id)) continue;
      if (!byAthlete.has(row.athlete_id)) byAthlete.set(row.athlete_id, { athleteId: row.athlete_id, values: [], targetConflicts: [] });
      byAthlete.get(row.athlete_id).values.push({
        value: key === "session_count" ? 1 : row.local_date,
        unit: null, valueType: key === "session_count" ? "numeric" : "text",
        dailyAggregationMethod: null, grain: "session", grainKey: row.activity_id,
        activityId: row.activity_id, date: row.local_date, startedAt: null, occasionId: null,
      });
    }
    for (const row of byAthlete.values()) row.groups = [{ unit: null, values: row.values, conflict: false }];
    return [...byAthlete.values()];
  }
  const facts = (ctx.rpeFacts[key] || []).filter((f) => !athleteIds || athleteIds.includes(f.athleteId));
  const byAthlete = new Map();
  for (const f of facts) {
    if (!byAthlete.has(f.athleteId)) byAthlete.set(f.athleteId, { athleteId: f.athleteId, values: [], targetConflicts: [] });
    byAthlete.get(f.athleteId).values.push(f);
  }
  for (const row of byAthlete.values()) row.groups = [{ unit: null, values: row.values, conflict: false }];
  return [...byAthlete.values()];
}

// ------------------------------------------------------------
// The batch entry point. `specs` is an array of resolved series specs
// (one per widget-series the caller wants queried), each already
// authorized (the route layer resolves data workspace ONCE and passes it
// in — this function does no authorization of its own beyond the
// activityId/componentId intersection, which is a QUERY-shape guarantee,
// not an authorization decision). Ranges are memoized by their own
// (dateFrom,dateTo) key so N series/widgets sharing the same range cost
// exactly one set of fetches — the actual "no N+1" property.
// ------------------------------------------------------------
export async function runDashboardBatchQuery({ dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, athleteIds, dateFrom, dateTo, activityId, componentId }, specs) {
  const rangeCache = new Map();
  const dayScopeMetricIds = [...new Set(specs.filter((s) => !s.builtInSeriesKey && s.dataScopeLevel === "day").map((s) => s.metricDefinitionId))];

  async function contextFor(rDateFrom, rDateTo) {
    const cacheKey = `${rDateFrom}|${rDateTo}`;
    if (!rangeCache.has(cacheKey)) {
      rangeCache.set(cacheKey, buildRangeContext(
        { dataWorkspaceType, dataWorkspaceScopeId, dataWorkspaceUserId, athleteWorkspaceAthleteId, athleteIds, dateFrom: rDateFrom, dateTo: rDateTo, activityId, componentId },
        dayScopeMetricIds,
      ));
    }
    return rangeCache.get(cacheKey);
  }

  async function runOne(spec) {
    const groupBy = spec.groupBy || "day";
    const analyticalAggregation = spec.analyticalAggregation || "sum";
    const effectiveAthleteIds = dataWorkspaceType === "athlete" ? [athleteWorkspaceAthleteId] : athleteIds;

    async function runForRange(rDateFrom, rDateTo) {
      const ctx = await contextFor(rDateFrom, rDateTo);
      const rows = spec.builtInSeriesKey
        ? queryBuiltInSeriesFromContext(ctx, { key: spec.builtInSeriesKey, athleteIds: effectiveAthleteIds })
        : queryMetricSeriesFromContext(ctx, {
            metricDefinitionId: spec.metricDefinitionId, dataScopeLevel: spec.dataScopeLevel,
            aggregationRolePolicy: spec.aggregationRolePolicy, coveragePolicy: spec.coveragePolicy,
            sourcePolicy: spec.sourcePolicy, sourceConnectionId: spec.sourceConnectionId, athleteIds: effectiveAthleteIds,
          });
      return reduceRows(rows, { groupBy, analyticalAggregation });
    }

    const current = await runForRange(dateFrom, dateTo);
    let comparison = null;
    let comparisonRange = null;
    if (spec.comparisonPeriod) {
      comparisonRange = shiftDateRange(dateFrom, dateTo, spec.comparisonPeriod);
      comparison = await runForRange(comparisonRange.dateFrom, comparisonRange.dateTo);
    }
    return { current, comparison, comparisonRange };
  }

  const results = await Promise.all(specs.map(async (spec) => {
    try {
      const data = await runOne(spec);
      return { widgetId: spec.widgetId, seriesId: spec.seriesId, status: "ok", data };
    } catch (error) {
      return { widgetId: spec.widgetId, seriesId: spec.seriesId, status: "error", error: error.message };
    }
  }));
  return results;
}

// ------------------------------------------------------------
// Dashboard-level entry point — the ONE batch endpoint the route layer
// calls: reads every widget (or a requested subset) + their series once,
// skips unresolved/ambiguous series structurally (never queried — they
// come back as a fixed placeholder result, matching the model's own
// "never query a non-resolved series" rule), and groups the results back
// by widget. This is what makes "load the whole dashboard" cost a small,
// range-bounded number of queries regardless of how many widgets/series
// it holds.
// ------------------------------------------------------------
export async function queryDashboard(dataWorkspaceArgs, widgetsWithSeries, { dateFrom, dateTo, athleteIds, activityId, componentId }) {
  const specs = [];
  const placeholders = [];
  for (const widget of widgetsWithSeries) {
    for (const series of widget.series) {
      if (series.resolution_status !== "resolved") {
        placeholders.push({ widgetId: widget.id, seriesId: series.id, status: series.resolution_status, data: null });
        continue;
      }
      specs.push({
        widgetId: widget.id, seriesId: series.id,
        metricDefinitionId: series.metric_definition_id, builtInSeriesKey: series.built_in_series_key,
        dataScopeLevel: series.data_scope_level, aggregationRolePolicy: series.aggregation_role_policy,
        coveragePolicy: series.coverage_policy, sourcePolicy: series.source_policy, sourceConnectionId: series.source_connection_id,
        groupBy: widget.group_by, analyticalAggregation: series.analytical_aggregation, comparisonPeriod: series.comparison_period,
      });
    }
  }
  const results = await runDashboardBatchQuery({ ...dataWorkspaceArgs, athleteIds, dateFrom, dateTo, activityId, componentId }, specs);
  const byWidget = new Map();
  for (const item of [...results, ...placeholders]) {
    if (!byWidget.has(item.widgetId)) byWidget.set(item.widgetId, []);
    byWidget.get(item.widgetId).push(item);
  }
  return widgetsWithSeries.map((widget) => ({ widgetId: widget.id, series: byWidget.get(widget.id) || [] }));
}
