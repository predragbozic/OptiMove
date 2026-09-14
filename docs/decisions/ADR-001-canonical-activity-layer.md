# ADR-001: Training Activity as the canonical activity layer

**Status:** Active

## Context

Training activities can be superseded/aliased (e.g. a duplicate or corrected activity
record), and their related facts — RPE feedback, metric values, component performance —
are scattered across several tables. Consumers (like the Training Load Analysis
dashboard) need one place to ask "give me everything about this activity" without each
needing to know the alias-resolution and multi-table-join logic themselves.

## Decision

`training.canonical_activity_results(p_activity_id uuid)` is the single canonical
function for resolving an activity (even via a superseded alias id) to its real activity
and returning its unified fact set. It:

1. Resolves the given id to its canonical activity via
   `training.resolve_canonical_activity_id`.
2. Expands to every alias activity id and every canonical/alias participant.
3. Returns a UNION of five fact kinds in one result set: `rpe` (joined from
   `training_load.session_feedback`), `metric_value` (from
   `training_load.metric_measurement_occasions`/`metric_values`),
   `component_performance`, `metric_event_link`, `component_metric_segment_link`.

## Exact contract

- Definition: `migrations_v2/202609071300_training_activity_v4_canonical_functions.sql:730-818`.
- Signature: `training.canonical_activity_results(p_activity_id uuid) returns table(canonical_activity_id uuid, canonical_participant_id uuid, athlete_id uuid, fact_kind text, detail jsonb)`, `language sql stable`.
- Callers: `backend/src/trainingActivityResults.js:49` (`getCanonicalActivityResults`);
  `backend/src/trainingLoadDashboardQuery.js:102-108`
  (`fetchCanonicalFactsForActivities`, `cross join lateral`).

## Consequences

- Any new consumer needing activity-level facts (RPE, metrics, component performance)
  should call this function rather than re-implementing alias resolution or joining the
  underlying tables directly — that logic already exists once, here.
- A new fact kind (a 6th category) should be added inside this function's UNION, not as a
  parallel query a caller runs alongside it — otherwise alias resolution has to be
  duplicated at the call site.
- `stable`, not `volatile` — callers can rely on it being safe to call multiple times in
  one query/transaction without side effects, and the planner can treat it as such.

## Evidence

Verified directly against `migrations_v2/202609071300_training_activity_v4_canonical_functions.sql`
and the two backend call sites listed above, in a research pass on 2026-09-14.

## Supersedes / Superseded by

—
