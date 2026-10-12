# ADR-007: Metrics Core is the canonical variable registry; source mapping is explicit, versioned and audited

**Status:** Accepted (owner, 2026-10-11). Decisions 1, 3 and 5 below are provable by the
checked-out code today; decisions 2 and 4 are accepted and are implemented by the separate
PRs M1–M4 of `docs/ai/gpexe-metric-variable-mapping-discovery.md` — until M4 is merged the
importer still creates `gpexe_*` definitions, and this ADR does not claim otherwise.

## Context

OptiMove already holds one metric-definition system, Metrics Core (`training_load.metric_*`,
migrations v10–v13 plus `training_activity_v3`), with immutable semantic versions, scope
capabilities, classification, provenance and append-only values. The GPEXE importer bypassed
it: `backend/src/gpexeImportWriter.js` creates team-owned definitions whose key and label are
the GPEXE name, and the whole field→metric mapping is a JavaScript constant
(`backend/src/gpexeImportMapper.js` `GPEXE_METRIC_SPECS`). The discovery of 2026-10-11
(`docs/ai/gpexe-metric-variable-mapping-discovery.md`) recorded the existing contract and the
owner accepted the direction below.

## Decisions

1. **Metrics Core is the only canonical registry of OptiMove variables.** No parallel
   "Variable Registry", metric table or parameter catalog for Training Load is built; a new
   variable is a `metric_definitions` row with a `metric_definition_versions` row, created
   through `backend/src/routes/trainingLoadMetrics.js`.
2. **A source never creates a canonical definition automatically.** A canonical variable is
   created by a platform admin (`system`) or a club admin (`club`) independently of any
   source; a source field reaches it only through an explicit mapping. *Pending M4:* the
   writer's `ensureMetricDefinitions` is removed and an architecture test refuses any INSERT
   into `metric_definitions` from the importer modules.
3. **Several different sources may fill the same canonical variable**, and two sources for the
   same athlete and event are never merged and no winner is chosen: each stays its own fact,
   the dashboard reports the conflict.
4. **A mapping is explicit, versioned and audited**: a stable source field identity with
   revisioned proven contracts, a mapping identity with immutable versions (controlled linear
   conversion, snapshotted parameters), an activation per team binding and exact mapping
   version, and an append-only audit without a structured value-bearing column (bounded,
   format-checked free text only). *Pending M1–M2.*
5. **A historical fact is never retroactively reinterpreted**: a changed mapping, unit proof,
   threshold set or conversion factor produces new versions and new facts, never a rewrite of
   an existing value, version or provenance row.

## Exact contracts (what proves 1, 3 and 5 today)

- Definitions and versions: `migrations_v2/202609041400_training_load_v10_metrics_catalog.sql:102`
  (`metric_definitions`), `:139` (`metric_definition_versions`, append-only trigger `:173-181`);
  scope capabilities `migrations_v2/202609071200_training_activity_v3_metrics_core_extensions.sql:22`.
- Values pinned to an exact version and append-only:
  `migrations_v2/202609041700_training_load_v13_metrics_measurements.sql:274-292` (composite FK),
  `:332-334` (`metric_values_immutable`); a new semantic version never reinterprets a captured
  value: `backend/tests/training-load-metrics.test.mjs:701-731`. Decision 5 is provable today for
  these existing append-only objects (versions, values, the threshold snapshot); its extension to
  mapping versions, unit proofs and conversion factors is pending M1.
- Several sources per definition, never merged: `metric_source_connections.source_system` is
  free text (`migrations_v2/202609041500_training_load_v11_metrics_provenance.sql:10-11`);
  `backend/src/trainingLoadDashboardQuery.js:337-394` (`resolveFactsToRows`) groups by unit and
  reports a conflict when more than one fact survives on one target, never summing.
- Threshold provenance immutable per event:
  `migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql:182-204`.
- The registry's write API with no frontend writer yet:
  `backend/src/routes/trainingLoadMetrics.js:182-418`; the frontend calls only the GET routes
  (`frontend/training-load-analysis-data.js:1532-1540`,
  `frontend/training-load-calendar-data.js:347-362`).
- The current departure that decisions 2 and 4 remove: `backend/src/gpexeImportWriter.js:168-224`
  (`ensureMetricDefinitions`), `backend/src/gpexeImportMapper.js:125-178` (`GPEXE_METRIC_SPECS`).

## Consequences

- A GPEXE (or any source) name is never the `key` or `label` of a canonical definition; it is
  a `source_label` of a source metric.
- Dashboards and every reader keep using `metric_definition_id`; the source filter and the
  conflict display stay as they are (ADR-004 keeps `dashboard_builtin_series` separate).
- Any change to this direction (a parallel registry, an automatic definition from a source,
  a merge of two sources, a rewrite of history) is a new ADR that supersedes this one, not a
  silent edit.

## Evidence

Verified against the files above at `main` commit `af11338` (merge of PR #155) on
2026-10-11; the full discovery and the accepted design are in
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (sections A–D).

## Supersedes / Superseded by

—
