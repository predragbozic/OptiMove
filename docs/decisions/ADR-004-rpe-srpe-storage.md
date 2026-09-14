# ADR-004: RPE/sRPE storage and the dashboard read path

**Status:** Active

## Context

RPE (rate of perceived exertion), duration, and sRPE (session load) need one clear
source of truth, readable both directly and through the Training Load Analysis
dashboard's built-in series, without risking the dashboard showing stale data because of
a copy that fell out of sync with the original entry.

## Decision

RPE, duration, and sRPE live only in `training_load.session_feedback`. sRPE is a
database-generated column (`rpe * duration_minutes`), never a value written by the
client or copied elsewhere. The dashboard's built-in `rpe`/`srpe`/`duration_minutes`
series read this table live, through `training.canonical_activity_results()` (see
ADR-001) — there is no duplicate copy into a `metric_values`-style table.

## Exact contracts

- Table: `training_load.session_feedback`, created
  `migrations_v2/202608310900_training_load_v1_session_feedback.sql:63-95`.
- Columns: `rpe smallint not null` (line 79); `duration_minutes smallint not null`
  (line 80); `srpe integer generated always as (rpe * duration_minutes) stored`
  (line 82).
- No duplication: a search across every migration referencing `metric_values` and every
  one referencing `session_feedback` found no `insert into ... metric_values ... select
  ... from training_load.session_feedback` anywhere.
- Dashboard read path: `backend/src/trainingLoadDashboardQuery.js:261`
  (`rpeRows = factRows.filter(r => r.fact_kind === "rpe")`) and lines 298-305 build the
  `rpe`/`srpe`/`duration_minutes` built-in series directly from
  `canonical_activity_results()`'s `rpe` fact-kind rows — not from a separate copy.

## Consequences

- A change to how RPE/sRPE is computed or stored happens in
  `training_load.session_feedback` (and its generated column) — not by also updating a
  second, cached representation, because there isn't one.
- A future metric that DOES need dashboard-side denormalization/caching should say so
  explicitly as a new decision (and likely a new ADR) — it would be a deliberate
  departure from this single-source-of-truth pattern, not a silent addition.

## Evidence

Verified against `migrations_v2/202608310900_training_load_v1_session_feedback.sql` and
`trainingLoadDashboardQuery.js`, including a full-migrations grep for `metric_values`
duplication, in a research pass on 2026-09-14.

## Supersedes / Superseded by

—
