# ADR-007: Metrics Core is the canonical variable registry; facts of several sources are never merged; a historical fact is never reinterpreted

**Status:** Active

## Context

OptiMove holds one metric-definition system, Metrics Core (`training_load.metric_*`,
migrations v10–v13 plus `training_activity_v3`), with immutable semantic versions, scope
capabilities, classification, provenance and append-only values. The discovery of 2026-10-11
(`docs/ai/gpexe-metric-variable-mapping-discovery.md`) recorded its contract and the owner
confirmed the three decisions below, each provable by the checked-out code. The owner's
further decisions for the source-to-canonical mapping — a source never creates a canonical
definition automatically; a mapping is explicit, versioned and audited — are **accepted future
design**, recorded in that document (sections C and D) and not in this ADR, because the
repository's ADR rule (`docs/decisions/README.md`) admits only implemented decisions; once
M1–M4 of that document are merged, this ADR is extended or a new ADR is written under the rule
of that time.

## Decisions

1. **Metrics Core is the only canonical registry of OptiMove variables.** A variable is a
   `metric_definitions` row with `metric_definition_versions` rows, created and versioned
   through `backend/src/routes/trainingLoadMetrics.js`; no parallel "variable registry",
   metric table or parameter catalog exists for Training Load, and none is built without a
   new owner decision.
2. **Facts of several sources are never merged and no winner is chosen automatically.**
   Several sources may record the same canonical variable for the same athlete and grain;
   each stays its own fact, and the dashboard query reports the conflict instead of summing
   or picking one.
3. **A historical metric fact is never reinterpreted by a later change of the current
   definition.** A new semantic version or a corrected value produces new rows; the captured
   value, its version, its provenance and the per-event threshold snapshot are never rewritten,
   and a re-import of an already imported session under a different threshold set is refused
   (`source_reference_set_changed`), never applied as a rewrite.

## Exact contracts

- Definitions and versions: `migrations_v2/202609041400_training_load_v10_metrics_catalog.sql:102`
  (`metric_definitions`), `:139` (`metric_definition_versions`, append-only trigger `:173-181`);
  scope capabilities `migrations_v2/202609071200_training_activity_v3_metrics_core_extensions.sql:22`;
  no seed and no second definition table anywhere in `migrations_v2/` (the dashboard's
  `dashboard_builtin_series` is a deliberately separate built-in catalog, ADR-004, and the Tests
  module's `tests.test_parameters` belongs to that module, not to Training Load metrics).
- The registry's write API: `backend/src/routes/trainingLoadMetrics.js:182-418` (domains,
  categories, definitions, versions, scope capabilities, hide, structure links); the frontend
  calls only the GET routes (`frontend/training-load-analysis-data.js:1532-1540`,
  `frontend/training-load-calendar-data.js:347-362`).
- Several sources, never merged: `metric_source_connections.source_system` is free text
  (`migrations_v2/202609041500_training_load_v11_metrics_provenance.sql:10-11`);
  `backend/src/trainingLoadDashboardQuery.js:337-394` (`resolveFactsToRows`) groups the facts
  of one target by unit, marks `conflict` when more than one survives and `unitConflict` when
  the units differ, and never sums or converts;
  `backend/tests/training-load-dashboard.test.mjs:943` ("a genuine two-source conflict is never
  silently summed").
- Not reinterpreted: values are pinned to an exact version by a composite FK
  (`migrations_v2/202609041700_training_load_v13_metrics_measurements.sql:274-292`) and are
  append-only (`metric_values_immutable`, `:332-334`); a correction is a new occasion that
  supersedes the old one (`:44-45`, the supersede chain); a new semantic version never
  reinterprets a captured value (`backend/tests/training-load-metrics.test.mjs:701-731`); the
  threshold set a session was imported under is an immutable per-event snapshot
  (`migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql:182-204`), and the
  writer stops a re-import whose set differs (`backend/src/gpexeImportWriter.js:34-38`, `:292`).

## Consequences

- Any new source of metric values (GPEXE today, others later) ends in `metric_values` rows
  that reference an existing `metric_definitions` row; it never brings its own registry.
- Readers keep using `metric_definition_id`; the source filter and the conflict display of
  the dashboards stay as they are.
- A departure from any of the three decisions (a parallel registry, an automatic merge of two
  sources, a rewrite of history) is a new ADR that supersedes this one, not a silent edit.

## Evidence

Verified against the files above at `main` commit `af11338` (merge of PR #155) on
2026-10-11; the discovery and the accepted future design are in
`docs/ai/gpexe-metric-variable-mapping-discovery.md`.

## Supersedes / Superseded by

—
