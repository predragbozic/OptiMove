# GPEXE metric / variable mapping — discovery and accepted contract

**Purpose.** The authoritative starting point for every later piece of work on Metrics Core
(the canonical variable registry), the source metric catalog, source-to-canonical mapping,
the GPEXE mapper / writer and dashboard metric definitions. It records three things kept
strictly apart: what the repository provably holds today (section A, B), what the owner has
decided (section C), and the accepted design that is **not yet implemented** (sections D to K).

| | |
|---|---|
| Discovery date | 2026-10-11 |
| Existing state verified against commit | `af11338` (merge of PR #155, `feature/test-infrastructure-t1` → `main`; the full 40-character id is in that PR's merge record — this repository's documents keep the short form, because the secret scans in `backend/tests/source-hosts-server3.test.mjs` treat a 40-hex value as the shape of a REST token) |
| Last verified against commit | `9e4dfb5` (merge of PR #162, the GPEXE check timing line, integrated into the M3-0 pull request) — `ed13f8a..9e4dfb5` changed `gpexeImportService.js`, `gpexeRestV1Adapter.js` and `sourceImportCredentialResolver.js` for the timing line only: no mapping, metric, binding or snapshot contract changed, and the three line references into `gpexeImportService.js` moved and were updated — before it `ed13f8a` (merge of PR #161, v35; the base of the M3-0 pull request) — `1164041..ed13f8a` changed only the v35 files (its migration, rollback and runbooks, the M2 service's actor setting and COMMIT rule, the tests, these documents), so sections A and B stand — before it `1164041` (merge of PR #160, the first M2 PR; the base of the v35 pull request) — before it `15efd7a` (merge of PR #159, M1; the base of the first M2 pull request, whose head commit is named in its description) — `e6bc885..15efd7a` changed only the M1 files (v34, its rollback, the undo script, the GPEXE test migrations, the M1 suite, these documents and rules), so sections A and B stand; sections C, D and J describe the merged M1 schema, and C59–C73 and J1 the first M2 pull request |
| Status | **Accepted architecture; M1 (the schema, migration v34) merged and deployed (PR #159, `15efd7a`; v34 directly confirmed on the production database by the owner's read-only post-check); the first M2 PR (read API, T3 create, T4 draft, submit) merged and deployed (PR #160, `1164041`, no migration); v35, the database actor guards (C74–C79, J2), merged and deployed (PR #161, `ed13f8a`; confirmed on production by the owner's read-only post-check); M3-0, the canonical-variable admin API and its request record v36 (C80–C88, J3), implemented in an open pull request — not merged, not deployed, v36 applied to no persistent database; M2b (the T2b confirmations, v37), the M3 frontend and M4–M6 not started** |
| Owner acceptance | 2026-10-11, in three rounds (direction B; the corrected contract; the final consolidation), all recorded in section C; 2026-10-12, the owner's external review of PR #156 decided the eight review-raised points (C32–C39; review history in K2) |

**Which changes require a targeted re-verification of this document** (not a repeat of the whole
discovery): any change to `migrations_v2/` files v10–v13 (`2026090414*`–`2026090417*`), the
training_activity v3 / v4 files (`202609071200`, `202609071300`), the dashboard files v15–v18
(`2026091009*`–`2026091012*`), v20 (`202609171800`), v22–v24 (GPEXE import), v27–v34 (source
connections, identities, check finalization, the M1 mapping schema `202610121000`); any change to
`docs/runbooks/source-metric-mapping-v34-rollback.sql` or `backend/scripts/gpexe-undo-imported-session.mjs`;
any change to `backend/src/gpexeImportMapper.js`,
`gpexeImportWriter.js`, `gpexeImportPreview.js`, `gpexeImportService.js`, `gpexeRestV1Adapter.js`,
`trainingLoadMetricsCatalog.js`, `trainingLoadMetricsMeasurements.js`, `trainingLoadMetricsAccess.js`,
`trainingLoadDashboardQuery.js`, `trainingLoadDashboardWidgets.js`, `sourceHosts.js`,
`sourceImportCredentialResolver.js`, `routes/trainingLoadMetrics.js`, `routes/gpexeImport.js`; any
change to `frontend/gpexe-import-view.js`, `training-load-calendar-view.js`,
`training-load-calendar-data.js`, `training-load-analysis-data.js`, `training-load-analysis-view.js`,
`activity-roster-view.js`, `navigation.js`; and the tests named in this document.

**Warning.** If this document and the checked-out code or migrations disagree, the code and the
migrations are the source of truth (`CLAUDE.md`, "Hijerarhija izvora istine"). A pull request that
changes any contract described here updates this document and its `Last verified against commit`
line in the same change (`.claude/rules/metrics-core-mapping.md`).

**Privacy and scope of this document.** It carries no athlete name, GPEXE athlete id, date of
birth or value, no raw source answer and no credential. The only source identifiers named are Team ID
980, a team binding fact already recorded in `docs/ai/CURRENT_STATE.md`, and the threshold-set id
in the tracked fixture path cited in section B (a team configuration id, not a person).

**How it was produced.** Three read-only inventories (schema; the GPEXE flow; frontend, docs and
tests) cross-checked against first-hand reads of the migrations and modules cited below, in a
separate worktree at `af11338`, with no database, GPEXE or production access. No file was
changed by the discovery itself.

---

## A. Proven existing state

### A1. Metrics Core is the only canonical registry

The one metric-definition system in use is Metrics Core in schema `training_load`, migrations
v10–v13 plus `training_activity_v3`. It already supports creating "my OptiMove variable" through
the API, classification, immutable semantic versions, values with the unit at capture, and
provenance per source. Dashboards already reference it. No parallel registry exists, and none is
needed.

| Table | Created in | Contract (as checked out) |
|---|---|---|
| `training_load.metric_definitions` | `migrations_v2/202609041400_training_load_v10_metrics_catalog.sql:102` | Stable identity plus cosmetic fields: `key`, `label`, `short_label`, `description`, `icon_url`; `owner_scope` in `system|club|team|user` with exactly one owner; `state` in `active|archived`; `current_version_id` with a composite FK to its own version (:168-171). The key is unique **per owner**, not globally (`unique nulls not distinct`, :127). No seed row anywhere in `migrations_v2/`. |
| `training_load.metric_definition_versions` | v10:139 | Append-only (`metric_definition_versions_immutable` → `forbid_update_delete`, :173-181). Semantics: `unit text` (free text, no catalog), `value_type` in `numeric|boolean|text`, `min_value`, `max_value`, `condition_description jsonb` (:147-155, a structured threshold / condition description, "descriptive, not mechanically enforced"), `daily_aggregation_method` in `sum|avg|max|last|none`, `superseded_reason`. `unique (metric_definition_id, version_number)` and `unique (id, metric_definition_id)` (:160, :163). |
| `training_load.metric_definition_scope_capabilities` | `migrations_v2/202609071200_training_activity_v3_metrics_core_extensions.sql:22` | Which level a definition may receive: `session|component|day`. The trigger `check_metric_value_scope_capability` refuses a value at an undeclared level and requires a confirmed segment link for `component` (:252-316); a level with history cannot be removed (:62-83). |
| `training_load.metric_domains`, `metric_categories` | v10:57, v10:78 | `name`, owner columns, `is_active`. No key, description, hierarchy or source tag. |
| `training_load.metric_structure_links` | v10:196 | A classification link with its own ownership: any non-empty combination of domain, category and definition; `temporal_smoothing_enabled`; one definition may sit under several links. Classification only, no mapping semantics. |
| `training_load.metric_definition_hidden` | v10:183 | Per-user hiding. Not relevant to mapping. |

**Value validation.** `training_load.validate_metric_value()`
(`migrations_v2/202609041700_training_load_v13_metrics_measurements.sql:297-327`) enforces the
version's `value_type` and bounds on every `metric_values` insert. A new semantic version never
reinterprets an already captured value (`backend/tests/training-load-metrics.test.mjs:701-731`);
`unit` and `value_type` are version fields a cosmetic PATCH cannot change (:1465-1482).

### A2. Provenance that already exists

| Table | Created in | Contract |
|---|---|---|
| `training_load.metric_source_connections` | `migrations_v2/202609041500_training_load_v11_metrics_provenance.sql:30` | `source_system text` is deliberately free text, "never a fixed enum of known providers" (v11:10-11); owner columns; `state` in `active|inactive`. Ownership is immutable once any event or identity uses the row (`protect_connection_ownership_once_used`, v11:52-74). v20 adds one active `gpexe` row per team (`metric_source_connections_one_active_gpexe_per_team_idx`, `migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql:142-144`). The only runtime writer is `backend/src/gpexeImportWriter.js` `ensureSourceConnection` (:137-157), which inserts `('gpexe','team',<team>)`. |
| `training_load.metric_source_identities` | v11:122 | The stable dedup slot `(source_connection_id, source_external_id)` with `current_occasion_id` (composite FK completed in v13:58-60). GPEXE formats: `team_session:<id>` (`gpexeImportMapper.js:402`) and `athlete_session:<id>:full` / `:drill:<n>` (`:363`). |
| `training_load.metric_import_batches` | v11:76 | `filename`, uploader, owner. Written by the writer; read by no route. |
| `training_load.metric_event_source_bindings` | v20:109-138 | One binding per event: the GPEXE threshold set in force for the session — `reference_set_external_id`, `reference_valid_from`, `reference_valid_to`, `reference_payload jsonb`, `reference_hash`, `reference_hash_version`; `unique (source_connection_id, source_external_id)`; immutable and undeletable (:182-204). v20:92-103 states the distinction this document keeps: the static bound of a metric belongs to `condition_description`, the team's threshold set in force for a session belongs to this snapshot. |
| `training_load.import_deletion_log` | `migrations_v2/202609181000_training_load_v21_import_deletion_log.sql:32` | Written only by `backend/scripts/gpexe-undo-imported-session.mjs` (disposable databases only). |

**The v11 connection and the v27 credential connection are not linked today.** A search for
`metric_source_connections` across `migrations_v2/` v27–v33, `backend/src/sourceConnectionService.js`
and `backend/src/sourceImportCredentialResolver.js` returns no match. The approval path passes no
binding fact into the writer: `source_binding_id` appears in `backend/src/gpexeImportService.js`
only in the check-row INSERT (:894). The check row carries `source_connection_id`,
`source_binding_id`, `source_team_id` and `source_host_key`
(`migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql:65-89`), and a
candidate carries `first_seen_check_id` / `last_seen_check_id`
(`migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql:267-268`), so the binding facts
of an approval are reachable without a new input.

### A3. Events, participants, segments, occasions, values

| Table | Created in | Contract |
|---|---|---|
| `training_load.metric_events` | `migrations_v2/202609041600_training_load_v12_metrics_events.sql:31` | `scope_level` in `session|day`; `source_connection_id` / `source_external_id` as descriptive provenance; `event_timezone_snapshot` (v3, write-once). The writer sets `source_external_id = team_session:<id>` (`gpexeImportWriter.js:226-257`); the v20 trigger `enforce_gpexe_event_uniqueness` refuses a second event for the same gpexe connection and external id and freezes a bound event's identity (v20:39-90). |
| `training_load.metric_event_participants` | v12:135 | `unique (event_id, athlete_id)`; `logical_session_id` without FK. |
| `training_load.metric_event_segments` | v12:182 | `label`, `segment_order`. GPEXE drills are `Drill n` (`gpexeImportMapper.js:389-394`). No external drill id, no segment type. |
| `training_load.metric_measurement_occasions` | v13:24 | `entry_method` in `manual|api_import|csv_import` (`csv_import` written by nothing), `content_hash`, `source_identity_id`, `source_reported_at`, `import_batch_id`, `import_conflict_status` in `needs_review|stale_resend_ignored|no_reliable_identifier`, the `supersedes` / `superseded_by` chain. |
| `training_load.metric_values` | v13:274 | Append-only (`metric_values_immutable`, v13:332-334). `metric_definition_id` + `metric_definition_version_id` with a composite FK (:290-292); `value_numeric|boolean|text`; `unit_at_capture text`; `is_derived`, `computed_by_ref`; v3 adds `aggregation_role` in `standalone|source_rollup|derived_rollup` and `coverage` in `complete|partial|unknown|not_applicable`. `unique (occasion_id, metric_definition_id)` (:286). Nobody writes `is_derived = true`, `computed_by_ref` or `derived_rollup`. No column for the source field, the raw source value or the source unit. |
| `training_load.metric_write_requests` | v13:342 | Idempotency of the manual routes only. |

**Canonical activity results.** `training.canonical_activity_results()`
(`migrations_v2/202609071300_training_activity_v4_canonical_functions.sql:730-818`, ADR-001)
assembles the `metric_value` fact with explicit fields (`metricDefinitionId`,
`metricDefinitionVersionId`, `unitAtCapture`, `aggregationRole`, `coverage`, …) for effective
occasions only (:786-790). Readers: `backend/src/trainingActivityResults.js:49`,
`backend/src/activityRoster.js:252`, `backend/src/trainingLoadDashboardQuery.js:108`.

### A4. Dashboards

- `training_load.dashboard_widget_series`
  (`migrations_v2/202609101000_training_load_v16_dashboard_widgets_series_selection.sql:311`):
  `metric_definition_id` XOR `built_in_series_key` XOR `template_metric_key_hints`; `source_policy`
  in `all_with_conflicts|source_connection|manual|api_import|csv_import|derived|not_applicable` with
  `source_connection_id`; `aggregation_role_policy`; `coverage_policy`. The unit per axis is compared
  as a string (:566-620), never converted.
- `backend/src/trainingLoadDashboardQuery.js` `resolveFactsToRows` (:337-394) filters by role,
  coverage and source policy, groups by unit and reports `unitConflict` and a per-target `conflict`
  when more than one fact survives on the same athlete, grain and unit. It never sums or converts.
- `backend/src/trainingLoadDashboardWidgets.js` `resolveTemplateSeriesBatchForWorkspace` (:89-167)
  resolves a key plus optional unit, value type and scope level against the visible definitions of a
  workspace and answers `resolved|unresolved|ambiguous`, never picking a winner. It is the closest
  existing analog of "a canonical key resolved to one definition".
- `training_load.dashboard_builtin_series`
  (`migrations_v2/202609100900_training_load_v15_dashboard_catalog_and_dashboards.sql:118`, seed
  `migrations_v2/202609101200_training_load_v18_dashboard_catalog_seed.sql:17-25`): `rpe`, `srpe`,
  `duration_minutes`, `session_count`, `last_session_date`. A separate, deliberate mini catalog
  without a link to `metric_definitions` (ADR-004). **Out of this project.**

### A5. Separate systems that are not metric definitions

- `training_load.session_feedback` (`migrations_v2/202608310900_training_load_v1_session_feedback.sql:63`):
  `rpe`, `duration_minutes`, `srpe` as a generated column (ADR-004).
- `tests.test_parameters` (`migrations_v2/202608220900_tests_v42_schema.sql:205`) and its derived
  parameters, presentation and criteria tables: a richer parameter system (`integer`, `ordinal`,
  `decimal_places`, formulas with `definition_version`) written only by seed migrations and not
  linked to Metrics Core.
- `tests.legacy_import_map` (:2066): the only source→target map in the repository, row-level UUID
  provenance without field, unit or conversion.

### A6. The existing API for creating and versioning OptiMove variables, and the missing UI

`backend/src/routes/trainingLoadMetrics.js` (mounted at `/api/training-load/metrics`): GET/POST
`/domains` (:182, :191) and `/domains/:id/archive` (:205); the same for `/categories` (:217, :226,
:240); GET `/definitions` (:256) and `/definitions/:id` (:272); POST `/definitions` (:283); PATCH
`/definitions/:id` (:297); POST `/definitions/:id/archive` (:309); PUT
`/definitions/:id/scope-capabilities` (:328); GET/POST `/definitions/:id/versions` (:340, :351);
POST/DELETE `/definitions/:id/hide` (:367, :377); GET/POST/DELETE `/structure-links` (:391, :403,
:418); POST `/events` (:486); `/occasions/:id`, `/occasions/:id/history`, `/occasions/:id/correct`,
`/occasions/imported-correction` (:554); GET `/results` (:575). Service:
`backend/src/trainingLoadMetricsCatalog.js` (`createDefinition` :193-245 writes version 1 with unit,
value type, bounds, `conditionDescription`, `dailyAggregationMethod` and the scope capabilities;
`createDefinitionVersion` :413; `updateDefinitionCosmetic` :343-363; `archiveDefinition` :376-400).
Ownership of catalog objects is a client-requested scope checked by `resolveCatalogOwnerScope` in
`backend/src/trainingLoadMetricsAccess.js:78-108` (`system` only for a platform admin, `club` /
`team` by the manage right, `user` by default).

**What that existing API does today, as checked out — not the M2 contract of section G:** the gate
is the manage right alone, with no active-workspace check, and a foreign club or team answers `403`
with a sentence ("That club is outside your access.", :98; "That team is outside your access.",
:104), not the ADR-006 `404`; `requireMetricsScope` (`routes/trainingLoadMetrics.js:128-135`)
admits every coach-capable workspace, so a coach may create `team`- and `user`-owned definitions;
`respondToWriteError` (:110-113) forwards a `P0001` trigger message as `400 {error: <message>}` and
maps `23505` to `409` — a deliberate choice recorded in `.claude/rules/backend-security.md`. Whether
M3 hardens this API (identical 404, stable codes) or keeps it is an open item of section K; the M2
routes of the new tables follow the stable-code / identical-404 contract from the start (section D).

**No frontend writes to the registry.** The frontend calls only the four GET routes
(`frontend/training-load-analysis-data.js:1532-1540`, `frontend/training-load-calendar-data.js:347-362`)
for the Activities "Choose metrics" picker and the dashboard metric pickers. Settings has no metrics
section (`frontend/navigation.js:133-151`). Labels and units reach the Activities drawer from the
catalog (`frontend/training-load-calendar-view.js:529`, `:657`) and the cell unit from
`unit_at_capture` (:453-466).

### A7. The current GPEXE candidate / preview / approve / import flow

1. A check (`backend/src/gpexeImportService.js` `startCheck` :790) reads GPEXE through the bound
   connection (`backend/src/sourceImportCredentialResolver.js`), stages observations per check (v33)
   and publishes candidates with `raw_bundle`, `bundle_hash`, `preview`, `preview_hash`
   (`migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql:250-265`).
2. The preview is a rolled-back run of the real writer under the team lock
   (`backend/src/gpexeImportPreview.js:151-154`); its value entries carry
   `{metricKey, label, unit, previous, value, change}` (:126-141).
3. Approve (`routes/gpexeImport.js:167`, batch :202) runs `approveCandidate` (:2091) →
   `previewLocked` (:2164) → `importGpexePlanLocked` in one transaction; while
   `GPEXE_IMPORT_APPLY_ENABLED` is not `"true"` (`applyEnabled`, :40-42) it refuses with
   `409 import_switch_off` before taking a database connection (:2098).
4. The writer (`backend/src/gpexeImportWriter.js`) creates the v11 connection, the event, segments,
   participants, the v20 threshold binding, occasions (`entry_method = 'api_import'`) and
   `metric_values` with `unit_at_capture = spec.unit`, `is_derived = false`; a whole session is
   `source_rollup / complete`, a drill `standalone / not_applicable` (:120-122); then
   `training.materialize_activity_group_from_metric_event` (:622).

### A8. The hard-coded mapping and the team-owned `gpexe_*` definitions

- `GPEXE_METRIC_SPECS` (`backend/src/gpexeImportMapper.js:125-178`) is the whole field→metric
  contract: eleven specs with `key`, `label`, `unit`, `dailyAggregationMethod`, `definition`
  (`confirmed` / `unconfirmed`), a `sourceContext` (`field`, `sourceUnit`, `conversion`, zone and
  threshold context) and an `extract` function. `GPEXE_DERIVED_NOT_IMPORTED` (:180-186) lists the
  derived values that are deliberately not imported.
- The writer's `ensureMetricDefinitions` (:168-224) **creates a team-owned definition per key** —
  `key = metric.key` (`gpexe_*`), `label` = the GPEXE name (`TIME`, `TotDist`, `SPEEDmax`, …),
  `short_label = label`, `description = "Imported from GPEXE: <field>"`, `owner_scope = 'team'`
  (:204-208) — with version 1 carrying `unit`, `value_type = 'numeric'` and the source mapping only
  as JSON in `condition_description` (`conditionDescriptionFor`, :160-162: `{ source, definition,
  sourceContext }`), scope capabilities `session` + `component`. A later import reuses the
  definition only when label, unit, value type, daily aggregation and that JSON are byte-equal,
  otherwise `metric_definition_mismatch` (:194-200).
- The GPEXE name is therefore already the canonical label: the Activities drawer and the dashboards
  read the catalog label and would show `TotDist (m)` after an import; only the Imports screen hides
  it behind the hard-coded `METRIC_TEXT` (`frontend/gpexe-import-view.js:130-142`). The same keys
  are duplicated in `SOURCE_ATHLETE_VALUE_KEYS` (`gpexeImportService.js:1473`), `LINK_CONTEXT_KEYS`
  (`frontend/gpexe-import-view.js:1527`) and `MAP_VALUE_LABELS` (:1027, which hard-codes the units
  although `GET …/source-athletes` returns `units`, `routes/gpexeImport.js:229`).
- The mapping is implicit, hard-coded, without status, version or audit, keyed and labelled by the
  GPEXE name, multiplied per team, and not generalizable to another source without new code.

### A9. Production state (as recorded in `docs/ai/CURRENT_STATE.md`)

No GPEXE metric fact has ever been imported into the deployed or the local OPTIMOVE database, and
no `gpexe_*` definition exists there — inferred from two recorded facts, not from a query of either
database: every real check ended before an approval, and `GPEXE_IMPORT_APPLY_ENABLED` is off in
every environment. The `gpexe_*` keys live only in the `preview` JSON of the stored candidates
(three rows on the owner's Imports screen on 2026-10-11; the deployed database was not queried). A
change of those keys will show every stored candidate as *changed* once, through `preview_hash`.

---

## B. The current GPEXE map

Scope: S = whole session, D = drill. "e03 pilot" = real e03 answers of 2026-09-17 kept as
`backend/tests/_gpexe-fixtures.mjs`. On `server3` / `rest_v1` the *shape* of the listed fields is
observed (owner-run probe of 2026-10-01 and the checks of 2026-10-06 to 2026-10-11,
`docs/ai/gpexe-rest-v1-compatibility.md` sections 1–4); **the units are not verified there**
(`docs/ai/gpexe-rest-v1-compatibility.md:95`, `:227`; gate (2) under "Separate tasks" in
`docs/ai/CURRENT_STATE.md`).

| Source field | Current key (label) | Conversion → unit | Scope | Proven on e03 | Proven on server3 | Not proven | Stored today | Safe for a future mapping |
|---|---|---|---|---|---|---|---|---|
| `athlete_session.total_time` | `gpexe_time_min` (TIME) | ÷ 60 → min | S, D | field, unit s, meaning | field present, finite number | unit and meaning on server3 | yes | after the server3 unit is verified |
| `athlete_session.total_distance` | `gpexe_total_distance` (TotDist) | 1:1 → m | S, D | field, unit m, meaning | field present | unit on server3 | yes | after the server3 unit is verified |
| `athlete_session.max_v` | `gpexe_max_speed` (SPEEDmax) | × 3.6 → km/h | S, D | field, unit m/s, meaning | field present | unit on server3 | yes | after the server3 unit is verified |
| `more.complementary_data.power[].distance` (zone with exact `extremes`) | `gpexe_power_zone_25_60_distance`, `_60_75_`, `_75_plus_` | 1:1 → m | S, D | field, zone model, unit m, bound unit W/kg | `/more/` field present | unit and bound unit on server3; the bounds themselves are the team's configuration, not a GPEXE contract | yes | only through a mapping version that carries the bounds (section E) |
| `more.complementary_data.speed[].distance` (zone [7, ∞) m/s) | `gpexe_sprint_distance_7mps` | 1:1 → m | S, D | as above | as above | as above | yes | as above |
| `more.events.acceleration_events_count`, `deceleration_events_count` (threshold +2.5 m/s² for acceleration and −2.5 m/s² for deceleration, 0.3 s, checked against the answer; `gpexeImportMapper.js:145-153`) | `gpexe_acceleration_events`, `gpexe_deceleration_events` | 1:1 → n | S, D | field, meaning as GPEXE's own event count | `/more/` field present | threshold and duration are the team's configuration; units on server3 | yes | only through a mapping version that carries the threshold |
| `details.players[athlete].tot_burst_events`, `tot_brake_events` (`{unit:"number", value}`) | `gpexe_burst_events`, `gpexe_brake_events` | 1:1 → n | S, D | shape | shape on server3 (2026-10-06, 2026-10-09) | **the meaning**; `unit:"number"` is a shape, not a physical unit | yes, `definition: "unconfirmed"` | not until GPEXE confirms the meaning |

**Control fields, never stored as a value:** `teamSession.id`, `team`, `category_name` (only
`"FULL TRAINING"` → `training_session`, `gpexeImportMapper.js:32`), `start_timestamp`,
`updated_on` (→ `source_reported_at`), `drills_count`, `is_stats_valid`; `end_timestamp` is parsed
and never written; `athleteSession.id`, `athlete`, `track`, `teamsession`, `drill`,
`is_stats_valid`; `track.athlete`, `timezone`, `timestamp`, `utc_timestamp`; the threshold set
(`id`, `team`, `validity_start`, `validity_end`, `power_thresholds`, `speed_thresholds`, the
acceleration / deceleration threshold and duration) → the v20 snapshot; `zone.extremes`,
`is_ready`; `events.*_threshold_value`, `*_duration`.

**Dropped by the projection:** everything else — `BUNDLE_FIELDS` and `DETAILS_CONSUMED_FIELDS` in
`backend/src/gpexeRestV1Adapter.js` (:85-94, :431); of the 43 keys of the recorded threshold
answer (`backend/tests/fixtures/gpexe-team-thresholds-1473.json`, the real e03 answer with the
`user` field removed) the adapter keeps 10.

**Derived values are not imported** (owner decision 2026-09-17): m/min, Acc+Dec, Burst&brakes, HMLD
≥ 25 W/kg, EXPDist ≥ 60 W/kg wait for a derived-metrics feature with a formula and a formula version.

**Stated plainly.** The server3 units for time, distance and max speed are not confirmed. The
burst / brake shape is observed, its semantics are not confirmed. Zones and thresholds are not a
universal source semantics; they are the team's configuration, confirmed per session against the
fetched threshold set (`zoneDistance`, `gpexeImportMapper.js:64-74`; `eventCount`, :102-109) and
snapshotted per event (v20); they must stay bound to a concrete approved contract and to the event
snapshot.

**Multiple tracks today.** Rows of one athlete with more than one `track` are skipped with the
anomaly `multiple_tracks` (`gpexeImportMapper.js:312-316`), shown as GPS *needs manual review*
(`gpexeImportPreview.js:62`); an athlete imported earlier blocks the session as
`identities_missing_from_source` with the step `fix_in_gpexe_or_undo` (:341-348); the approval
records a `record_unusable` observation (`training.activity_source_observations`,
`migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql:643`). A row whose
track was not fetched fails the session (`track_missing`, :318). No selection, sum or merge exists.

---

## C. Architectural decisions of the owner (accepted 2026-10-11)

1. Metrics Core (`metric_definitions` + `metric_definition_versions` + scope capabilities +
   classification) is the only canonical registry. No parallel Variable Registry is built.
2. An OptiMove variable is created independently of any source. A source never creates a canonical
   definition automatically; the importer stops creating `gpexe_*` definitions (M4).
3. Canonical ownership in the mapping flow is `system` or `club`. `team` and `user` ownership stay
   available in Metrics Core but are not a mapping target.
4. Several different sources may fill the same canonical variable.
5. Two sources for the same fact are never merged and no winner is chosen automatically; the
   existing conflict mechanism stays fail-closed.
6. A mapping is explicit, versioned and audited.
7. Activation is bound to a team binding and to one exact, immutable mapping version.
8. A new mapping version inherits no activation; re-activation is explicit per binding, done in the
   same transaction as the replacement only for explicitly listed bindings.
9. A new canonical semantic version is refused while an active mapping version pins the old one.
10. Fact provenance is a separate append-only 1:1 table.
11. v11 and v27 are linked by a stable, write-once source-instance identity on the Metrics Core
    connection; Metrics Core never holds a credential.
12. Conversions are controlled linear numeric conversions only (`value × scale + offset`); boolean
    and text mappings stay outside M1 / M4. (M1 represents the factor as `scale`, `scale_divisor`
    and `offset` so that 1/60 and 1/3.6 are exact rational constants — a representation found in
    the code review of this document, not a new kind of conversion; accepted by the owner on
    2026-10-12, C34.)
13. Historical facts are never retroactively reinterpreted: a changed mapping, unit proof, threshold
    set or conversion row creates new versions and new facts, never a rewrite.
14. A `required` activation whose value is missing for any athlete the existing rules admit blocks
    the whole candidate. No partial import. Never a zero.
15. An `optional` value may be left out with a reason; it never becomes a zero.
16. A mismatch of unit, value shape or threshold contract blocks the whole candidate.
17. `nothing_to_import` is never Ready.
18. Multiple tracks stay fail-closed until a separate M5; no sum, max, weighting or merge.
19. Dashboards use the canonical `metric_definition_id`; the source filter and the conflict display
    stay available.
20. `dashboard_builtin_series` stays separate (ADR-004) and outside this project.
21. The source metric contract is versioned (model A, section D); a wrongly confirmed contract gets
    a new revision; the old one is retired, never changed.
22. `unit_conversions` is the database-checkable gate of every conversion and of the equivalence of
    zone and threshold bounds; the mapping version keeps its own copies of the factors.
23. The requirement (`required` / `optional`) lives on the activation, without a default.
24. A `team`-owned v27 connection may host an activation only when the binding and ownership guards
    prove the same team and club unambiguously; otherwise fail-closed.
25. `rounding_decimals` stays nullable and unused in the first pilot.
26. A canonical zone variable is its own definition with the bounds in `condition_description`.
27. The mapping identity (T3) may be created before the unit is proven; a mapping version (T4) only
    after.
28. The mapping preview over a saved candidate stays aggregate, without rows per athlete.
29. Generic `observed` source metric revisions are seeded without confirmed units and without any
    active mapping.
30. Club mapping proposals are part of the M1 model and the M3 UI; activation and ending of an
    activation are platform-admin only in the first scope.
31. `source_host_key` stays beside `source_instance_key`.

Decided by the owner's external review of PR #156 (2026-10-12), after the internal reviews raised
them (review history in K2):

32. A parameter fingerprint on T4, with a checked copy on T5: one generic source field may feed
    several canonical zone variables, one per distinct proven parameter set; the fingerprint is
    computed server-side from the canonicalised parameter contract, stable and versioned, never a
    client string, free of athlete, session and team identity, and part of the relevant unique and
    FK contracts (section E, "Parameter fingerprint").
33. The active canonical target of a source metric with given parameters is unique **per owner**,
    not globally: the platform may hold a system mapping, each club its own mapping of the same
    field and parameters towards its own club variable, enforced by the database through a checked,
    non-null owner key on T4 (`'system'` or the club id, D6); none is activated automatically, and when a system and a club mapping
    coexist the platform admin chooses explicitly which one a binding uses. T5 still admits only
    one open activation per (field, parameters) and per (canonical, scope) on a binding.
34. The exact rational conversion `canonical = source × scale / scale_divisor + offset`:
    `scale_divisor > 0`, identity as `1, 1, 0`, no binary floating-point arithmetic in the import
    writer, every historical mapping version keeps its own factors, a retired `unit_conversions`
    row changes no history — still a linear numeric conversion, not a new kind of formula. Factors
    are normalized where possible: **the normal form of D5 is a mandatory contract of the
    system**, guaranteed in two layers. **The database** guarantees finite factors (no NaN, no
    infinity), the CHECK `scale = 1 or scale_divisor = 1`, and either (a) for different units,
    that the mapping version's factors equal the single active `unit_conversions` row of that unit
    pair, or (b) for string-equal units, the identity tuple `(1, 1, 0)` without a
    `unit_conversions` row. **The M2 API** guarantees the
    canonical choice of representation and refuses any other form of the same value (for example
    `(1, 0.25)` instead of `(4, 1)`). M1 by itself does not claim to tell apart numerically equal
    written forms such as `3.60` and `3.6`: PostgreSQL `numeric` treats them as the same value. A
    conversion the normal form cannot represent is refused (D5).
35. A team-owned connection never hosts a club mapping in M1 / M2; only contracts whose ownership
    and same team / club the database can prove are allowed; a later widening is a separate owner
    decision.
36. The source-instance unique stays partial (active instances only), the writer refuses
    `session_imported_under_another_instance` fail-closed, a held instance is ended only by an
    explicit platform-admin operation in M2, no history is moved to a new team automatically, and
    every historical fact keeps pointing to the old instance; ending an instance deletes no event,
    fact or provenance row.
37. ADR-007 is narrowed to the decisions the implemented system already proves (Metrics Core is the
    canonical registry; facts of several sources are never merged and a conflict stays visible; a
    historical fact is never reinterpreted by a change of the current definition). "A source never
    creates a canonical definition" and "a mapping is explicit, versioned and audited" stay
    accepted future design in this document, not an implemented ADR, until M1–M4 are merged.
38. `bound_operator` is part of the versioned source contract: NULL until the meaning is confirmed,
    confirmed together with the meaning evidence, a closed operator set, the canonical
    `condition_description.operator` semantically equal, a changed operator a new revision, an old
    fact bound to the old contract.
39. The storage scale S = 9 decimals: decimal arithmetic, round half away from zero, the same rule
    in the writer and in the database check (the check accepts exactly the value the rule produces
    and no other, D8), `rounding_decimals` a future
    presentation field without effect on the pilot, a display free to show fewer decimals without
    changing the stored value, and a characterisation test proving that today's GPEXE values stay
    equivalent within the existing `1e-9` contract.

Decided by the owner for the M1 SQL (2026-10-12), where sections D and E did not fix a detail
(each is built in migration v34 and tested in `backend/tests/source-metric-mapping-m1.test.mjs`):

40. **`evidence_ref` shape** (every `evidence_ref`, `unit_evidence_ref`, `meaning_evidence_ref` and
    the T8 reference): a repository-relative `path#anchor` of 1–300 characters; the path starts with
    `docs/`, never with `/`, has no empty, `.` or `..` segment (so no `//`); exactly one `#` with both
    parts non-empty; no URL, space, colon or control character
    (`^docs(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+#[A-Za-z0-9_-]+$`). That the file and the anchor exist is
    proven by a test for every seeded reference; an anchor is a real Markdown heading slug or an
    explicit stable `<a id>` anchor.
41. **Bounded single-line text**: `btrim(value) = value`, 1–N characters, no C0, DEL or C1 control
    character and no U+2028 / U+2029 (widened by C53 to the listed invisible and bidi characters); a
    nullable column applies the same rule when it is not NULL, and
    an empty string is never a stand-in for NULL. N is 500 for T2a `retired_reason`, T2b `unit_note`
    and `retired_reason`, `unit_conversions.retired_reason` and T4 `disable_reason` (and, as before, for
    `conversion_note` and the T5 / T8 `reason`; 80 for `source_label`).
42. **T2b immutability and lifecycle**: the revision identity, the hypothesis (`expected_*`,
    `unit_note`), the shape, the parameter kind and the levels never change; a proof column moves from
    NULL to a value only through its own verification act (unit, or meaning with the operator), with its
    actor, time and reference, once, never overwritten or cleared; any change to the real contract is a
    new revision; the generic `evidence_ref` is written once, in the same change that raises
    `evidence_status` from `unproven` (the database requires `evidence_ref` exactly when the status is not
    `unproven`). A revision is created only for an `active` T2a field, activating a revision needs an
    `active` field, a T5 row is inserted only open, and a T2a field is not retired while one of its
    revisions is `draft` or `active` or an activation of it is open.
43. **Parameterized revisions**: an `event_threshold` revision uses its proven bound unit exactly like a
    zone; a parameterized revision with a proven value unit must have a proven bound unit; the operator
    is confirmed with the meaning (C38).
44. **Errors**: an acting user who is not allowed raises SQLSTATE `42501`; every other explicit trigger
    refusal raises `23514`; messages are fixed text without an id, a value or a source answer. Native FK,
    UNIQUE, NOT NULL and CHECK errors keep their own codes; `23514` is not a mask for them.
45. **Role checks**: an active platform admin as in v21 and an active club admin as in v26 (an active
    role, an active user and, for a club admin, an active club, the rows held `FOR SHARE`, one stable lock
    order); the club-admin basis only where sections D / G allow it (a club mapping's submission); an
    acting-user check only on the columns D / G name (no extra check on `created_by`, `retired_by` or
    T8 `performed_by`, whose FKs and paired-field rules stay); the M2 service authorizes every write
    before any trigger runs, and an audit actor is never taken as authorized because its id exists.
46. **The Metrics Core guard in M1**: the guards M1 adds are the decision-9 guard on
    `metric_definitions` and the scope-capability guard of section E; no M1 trigger or seed creates a
    canonical definition (tested). The GPEXE importer still creates its team-owned `gpexe_*`
    definitions: this is **temporary compatibility, not a departure from the contract** (decision 2) —
    a database-wide refusal now would break the existing importer, and removing the automatic creation
    belongs to M4, before the switch is turned on.
47. **The undo script in M1**: T6's append-only trigger is in `PROTECTED_TRIGGERS` already in M1, and the
    disposable undo removes a value's provenance first, in the same transaction; no production history or
    trigger protection is bypassed.
48. **T8 shape per action**: `request_key uuid` and `request_hash` (64 lower-case hex characters) are set
    together or not at all; every action has one shape of target columns, from / to status, reason and
    evidence (table in D10); no audit row may fail to identify a supported object.
49. **No fact through an ended activation**: a T6 insert holds its activation `FOR SHARE` and refuses an
    ended one; ending an activation never changes or removes a historical T6 row, and no fact is moved to
    a newer activation. Either the fact is written while the activation is open and the ending waits for
    it, or the ending lands first and the fact is refused (concurrency-tested in both orders).
50. **The seed values of D12**: `source_label` `TIME`, `TotDist`, `SPEEDmax` (the GPEXE names of
    section B) and the neutral `Power zone distance`, `Speed zone distance`, `Acceleration events`,
    `Deceleration events`, `Burst events`, `Brake events`; `unit_note` "Expected unit is a hypothesis
    from the e03 pilot; not proven on server3." (burst / brake add "The observed unit "number" is a
    shape; the meaning is unconfirmed."); every seeded revision supports session and drill (section B,
    S and D), `value_shape = 'number'` for time, distance and max speed, status `observed`, never
    `verified`; `evidence_ref` `docs/ai/gpexe-rest-v1-compatibility.md#2-the-table` for the revisions and
    `docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit-conversion-seed` for the four unit
    conversions; `seed_migration` the migration's own `schema_migrations` name
    (`migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`,
    `^migrations_v2/[0-9]{12}_[a-z0-9_]+\.sql$`). No server3 unit or meaning is confirmed by the seed.

Decided by the owner after the internal reviews of M1 (2026-10-12; the five points those reviews
raised, formerly listed as open in section K), built in v34 and tested in the same suite:

51. **A canonical definition named by a mapping keeps its owner.** Once any T3 row names a
    `metric_definitions` row, its `owner_scope`, `owner_user_id`, `owner_club_id` and `owner_team_id`
    never change (`23514`, trigger `metric_definitions_source_metric_owner_guard`); without a mapping the
    owner may change as before. Creating a mapping locks the definition `FOR SHARE`; an owner change is
    an `UPDATE` of that row, which takes the row's lock itself before the trigger runs (the owner columns
    are in the definition's unique key, so it is the strongest row lock) — the trigger takes no extra
    lock (owner's external review of `ff0ba57`: a redundant `FOR UPDATE` is not kept). The two
    serialize: the mapping first → the owner change is refused; the owner change first → the mapping
    checks the new owner (and is refused when it no longer fits). Tested in both orders.
52. **The conversion gate is checked again at activation.** For different units the T4 transition to
    `active` locks the active `unit_conversions` row of the value pair and of the bound pair `FOR SHARE`
    (the first table of the lock order) and requires the version's factors to equal it again; a retired
    row fails the activation, a new active row with the same factors passes; equal units stay the
    identity `(1, 1, 0)` without a row. Existing `active` versions and history are not changed by a later
    retirement. Retirement vs activation tested in both orders.
53. **Invisible and bidi characters in free text.** Every bounded single-line free-text column (C41:
    `source_label`, each `retired_reason`, `unit_note`, `conversion_note`, `disable_reason`, the T5
    and T8 `reason`, and the `unit_conversions` unit pair) refuses, beside C41's surrounding-space and
    length rule, exactly these code points and no others (`source_metric_text_ok`): `U+0001–U+001F`,
    `U+007F–U+009F`, `U+00AD`, `U+061C`, `U+180E`, `U+200B–U+200F`, `U+2028`, `U+2029`,
    `U+202A–U+202E`, `U+2060–U+2064`, `U+2066–U+206F`, `U+FEFF`. This list is what the SQL proves; it is
    not "every format character (Cf)": other code points of category Cf — for example `U+0600–U+0605`,
    `U+FFF9–U+FFFB`, `U+E0001` and `U+E0020–U+E007F` — pass free text, and so does `U+2065`, an
    unassigned code point (not Cf) between two refused ranges. M3 still neutralizes text on display.
    The closed unit token (`source_metric_unit_token_ok`; D3, C56) is stricter: 1–30 characters, none of
    the locale's `\s`, `|` or `=`, and none of `U+0001–U+001F`, `U+007F–U+009F`, `U+00A0`, `U+00AD`,
    `U+061C`, `U+1680`, `U+180E`, `U+2000–U+200F`, `U+2028–U+202F`, `U+205F–U+206F` (so it refuses
    `U+2065`), `U+3000`, `U+FEFF`.
54. **Positive factors.** `scale > 0` and `parameter_scale > 0` (T4) and `scale > 0`
    (`unit_conversions`); the divisors stay `> 0`; an offset may be negative. A negative scale would
    invert `>` / `<` while the operator stays equal on both sides; allowing one needs a new owner
    decision.
55. **The database checks a new T6 fact against its whole chain.** On every INSERT: the activation is
    open, the binding is `active`, the Metrics Core connection the fact names is `active` (v11
    `metric_source_connections.state`, the connection whose ending is the end of the source instance,
    C36), the connection, binding and activation are one chain (the activation names the binding; the
    connection's system, host and instance key are the binding's, D9), the value's event is owned by
    the binding's team, the value's level is one the activation covers (a session-level event without a
    segment ↔ `applies_to_session`, a drill segment of a session-level event ↔ `applies_to_drill`, a
    day-level event never), and every existing exact-version, unit, source-instance and FK invariant
    holds. The trigger does not read the import switch. Lock order of a new fact: T5 → the team binding
    → the Metrics Core connection, each `FOR SHARE`; a later ending of any of them never changes an
    existing fact, but a fact never lands after the ending (INSERT vs ending of the binding, the
    connection and the activation tested in both orders). The v27 credential connection is read plain,
    for the chain only; its credential state (`verified` / `needs_reconnect`) is not a condition of a fact
    (a fact is written from a stored snapshot, not from the source). **Confirmed by the owner's external
    review of `ff0ba57` (2026-10-12):** a later *Needs reconnect* does not reinterpret data already
    confirmed; a stricter policy would be a new owner decision.

Decided by the owner at the external review of `ff0ba57` (2026-10-12):

56. **The canonical target unit is a unit token.** Metrics Core keeps its free-text units, its
    existing `metric_definition_versions` rows are not changed and no global Metrics Core constraint is
    added; but a canonical version whose unit does not pass the M1 unit-token contract (1–30 characters,
    none of the whitespace / control / zero-width / bidi / format code points the C53 unit token refuses,
    no `|` or `=`) is never a mapping target. The T4 INSERT trigger refuses it fail-closed
    (`canonical_unit_not_a_token`, `23514`); `target_unit` is the checked copy, a unit token by its own
    CHECK (`source_metric_mapping_versions_target_unit_token`), re-evaluated on every update of the row, so
    on every transition and the activation too; T6 `unit_at_capture` must equal `target_unit`, so it
    carries the same guarantee. No separate statement re-reads the unit at activation: the canonical
    version is immutable (v10 `metric_definition_versions_immutable`) and the activation re-checks under
    `FOR SHARE` that it is still the definition's current version, so such a statement could never fail
    (dead code).
57. **The M4 writer's lock contract** (future, not implemented in M1). Metrics Core locks the Metrics
    Core connection `FOR UPDATE` on every event and every source-identity insert (v11, v12), while a T6
    insert holds it `FOR SHARE` (C55). So the M4 writer: locks and checks the event and every source
    identity of the import **before its first T6 insert**; imports one team through **one importing
    transaction** in the defined lock order (the team import lock first, as today); never inserts a T6
    row and then asks for a stronger lock on that Metrics Core connection. The aim is that a `40P01`
    between a T6 `FOR SHARE` and a later `FOR UPDATE` cannot arise.
58. **Unbind and a fact already in flight.** An Unbind (the end of a binding) may briefly wait on a
    binding row held `FOR SHARE` by a T6 insert that is already running. The wait stays under the
    existing bound (the Unbind's row `lock_timeout`, `ROW_LOCK_TIMEOUT_MS` = 2 s in
    `backend/src/sourceConnectionService.js`), a lock still held then answers the stable `try_again`
    with nothing changed, nothing waits without a bound, exactly one of the two outcomes wins
    atomically (the fact first and the Unbind after it, or the Unbind first and the fact refused), and
    an existing fact is never deleted. The Unbind code is unchanged; test 23 proves it against the real
    `unbindTeam`. (An M4 import also holds the team import lock, at which an Unbind answers `try_again`
    at once.)

Decided by the owner for the first M2 pull request (2026-10-13; the HTTP contract itself is section
J1):

59. **The scope of the first M2 PR.** The read API (T2a / T2b fields, canonical targets, unit
    conversions, T3 mappings with their T4 versions), the T3 create, the T4 draft create and the one
    transition `draft → needs_review`. Not in it: T2b unit and meaning confirmation and the revision
    lifecycle, T4 activate / disable / replacement, every T5 operation, `unit_conversions` maintenance,
    the aggregate preview, the extractor registry, ending a held source instance and the catalog
    `500 → 409` mapping of `routes/trainingLoadMetrics.js` (it moves to the PR that introduces an active
    version, because only an active version can trigger those refusals). No M2 operation writes a T5
    or a T6 row. In production no draft version can be created until a later PR proves a unit (every
    seeded revision is unproven).
60. **The owner comes from the active workspace only.** The platform workspace is the system scope (a
    platform admin; `owner_club_id` NULL, `owner_key = 'system'`); a club workspace is that club's scope
    (its active club admin, or a platform admin there for support — a club workspace exists only for an
    active `club_admin` role, `backend/src/workspace.js`); a team or private-coaching workspace, an
    athlete, another club, a revoked role, an inactive user or an archived club get nothing (the 404).
    A body never names an owner (`owner_club_id`, `owner_key`, `ownerScope` …: `400 invalid_body`);
    the right, the user and the club are checked again under `FOR SHARE` right before every write.
61. **The canonical target has the mapping's owner scope** (D4 and the v34 T3 trigger, confirmed; no
    migration needed for it - the v35 of C73 is a separate actor check): a system mapping targets a system definition only, a club X mapping a club X definition
    only; a system definition from a club workspace is `409 target_scope_mismatch`; another club's,
    a team's or a user's definition is the 404.
62. **Parameter values are decimal JSON strings** (`^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$`: at most
    12 integer and 9 decimal digits, no exponent; `durationSeconds ≥ 0`), never a JavaScript `Number`;
    parsing and arithmetic are exact decimals; before `canonical_parameters` and the fingerprint the
    server writes one canonical record (trailing zeros removed, a negative zero `0`), so numerically
    equal inputs give the same parameters and fingerprint; the database stays the final authority.
63. **Free text in a response** is only the M1-bounded `label` (T2a `source_label`, ≤80), the evidence
    references (C40 shape) and `conversionNote` (≤500), beside units; never `unitNote`, a retire or
    disable reason, a T8 `reason`, Metrics Core `key` / `label` / description, a raw
    `condition_description`, a trigger's or the database's text, or an acting user's id.
64. **Lists** have a stable order and a hard cap (fields 100, revisions per field 20, targets 200,
    conversions 100, mappings 100, versions per mapping 50); a longer result is `409 result_too_large`,
    never a cut list; the mapping list carries a version summary, the detail every version. (For the
    mappings and a mapping's versions superseded by C68: pages, not a cap.)
65. **A replay is a read of the current state.** The same user, key and request hash: the right is
    checked again, the referenced resource is read again and answered `200` with `replayed: true` —
    never a stored historical body (T8 stores none). Another body on the key: `409 request_key_reused`.
    A refusal is no request record. A lost COMMIT answer verified on a second connection: `200` (a
    create too) with `commitConfirmation: "verified_after_commit_error"`; not verified: `503
    outcome_unknown` with the key.
66. **Errors.** Only an allowlisted database refusal becomes a 4xx (the codes of J1); any other
    constraint, an unexpected `23514`, an SQL or program error is `500 internal_error` without the
    database's text. A busy pool is `409 try_again` with `Retry-After: 5`, the answer of the source and
    importer routes (`routes/sourceConnections.js`, `routes/gpexeImport.js`).

**The owner's external review of the first M2 PR (head `26a0748`, 2026-10-13: NOT READY), decided and
built in the same PR:**

67. **The answer of `POST /mappings`** is the bounded mapping summary of the list (row 4 of J1), never
    the version list.
68. **Pages, no write quota.** `GET /mappings` and the versions of `GET /mappings/:id` are read by
    keyset pages: a fixed page size (mappings 100, versions 50), the stable order of C64, `nextCursor`
    (null on the last page), no gap and no duplicate in a stable snapshot. (A mapping's `created_at` is
    its transaction's start, so one that commits after a page was read with an earlier `created_at`
    than the cursor's position appears only in a list read again from the start.) The cursor is opaque and
    strictly validated, bound to the workspace's owner key (and, for versions, to the mapping); an
    invalid cursor is `400 invalid_query`. No write refuses a mapping or a version at a count.
    `/fields`, `/targets` and `/conversions` (catalogs M2 does not write) keep their hard caps.
69. **The answer of a committed write follows the replay rule (C65).** After a COMMIT confirmed
    directly or verified on a second connection, the right, the user and the club are checked again,
    `FOR SHARE` on a new bounded connection and held while the answer is read, before anything of the
    resource is read. A right lost meanwhile answers the identical 404 and shows nothing of the resource.
    A check or a read that fails or runs past its bound keeps the write's status with `readError`, and
    names the ids of what was written only once the right was confirmed again (a replay with the same
    `requestKey` answers the rest).
70. **Every M2 read is bounded** (the F3c2d discipline): its own short transaction with a statement and
    a lock bound on the server and a client bound on the whole read; a connection that ran past its
    client bound is closed, never returned to the pool. A GET past its bound is `409 try_again`; the
    read after a COMMIT is `readError`.
71. **The facts of a version are checked again under lock.** v34 keeps every T2b fact a version create
    uses final once it was seen as the create accepted it (C42; a unit proof and a meaning proof are
    written once); the create still compares them again under `FOR SHARE` (field, parameter kind, both
    levels, both units, operator), so a later migration that allows a change answers `409 try_again`.
    The current canonical version is re-read under `FOR SHARE` of `metric_definitions`, then the levels
    under `FOR SHARE` of its scope capability rows (the v34 order): a new current version is
    `try_again`, a removed level `level_not_allowed`, and a level removal waits for the version.
72. **The 42501 allowlist is exact:** the three v34 actor texts become the 404; any other `42501`,
    whatever its beginning, is a sanitized `500 internal_error`.
73. **A database actor check on the T3 / T4 inserts and the T8 request records is a mandatory, separate
    hardening PR (v35)** before any T5 activation and before the API's real administrative use. It is
    not part of the first M2 PR, which adds no migration; the M2 API stays the only application writer
    meanwhile (test 20 of the M2 suite). **Built in v35 (J2).**

**The owner's decisions for v35 (2026-10-13), after the v35 discovery found that v34 has no actor
context the database could check and that the application and the migrations share one owner role:**

74. **The actor context** is the transaction-local setting `optimove.source_metric_actor`, set with
    `set_config(..., true)` from the authenticated server session, never from a request body. Its value
    is `<lowercase canonical user uuid>:<id of the top-level transaction>` - the id makes a
    session-level `SET` left from an earlier transaction invalid. Missing, empty, not canonical or of
    another transaction: `42501`. **Limit:** it keeps an accidental or unintended write that bypasses
    the M2 service out (a script, another module, a stale setting). The guards prove that the row, the
    acting user and the user's right agree - not that the code which set the acting user was entitled
    to. It is no defence against whoever controls the owner credentials the application and the
    migrations share, nor against any code that runs SQL through the application's pool (another
    module, an injection): either can set the setting, disable a trigger or switch
    `session_replication_role`. Separate migration and runtime roles are a separate infrastructure task
    and do not block v35.
75. **Where it is set:** in every M2 write transaction (create a mapping, create a version, submit),
    right before its first protected write - after the bounds, the per-user lock and the request-record
    lookup, so a replay, which writes nothing, sets none. GET routes set none. The setting is gone at
    COMMIT and ROLLBACK, also on a pooled connection that is used again.
76. **Scope:** T3, T4 (its insert and the `submitted_by`, `activated_by` and `disabled_by` transitions,
    the existing and the future ones) and T8. T2a, T2b, `unit_conversions` and T5 keep their v34 checks;
    every future route that writes them gets its database actor guard before it is released. A T8 row of
    any other action needs an active platform admin as the acting user (its chain comes with its PR).
77. **The audit link both ways.** A T8 row's BEFORE guard proves its operation in the same transaction:
    the mapping or version it names was written by this transaction (its `xmin` is the transaction's
    id), by the acting user, with the version's status equal to the row's `to_status` and the
    transition's user and basis; the operation has no audit row yet. At COMMIT, deferred constraint
    triggers require a `mapping_create` row for every T3 insert, a `mapping_version_create` row for
    every T4 insert and a `mapping_status` (or `mapping_version_replaced`) row with the same from / to
    status for every T4 status or actor change; otherwise the whole transaction is rolled back. A
    trivial T4 update (no status or actor change) is not checked. No schema extension was needed.
78. **Subtransactions:** a row written inside a savepoint carries the subtransaction's id as `xmin`, so
    its audit row is refused (fail closed). The M2 service uses no savepoint; a test pins the behaviour.
79. **Errors:** a refused actor is `42501`, a chain or audit violation `23514`, each with a fixed message
    without an id, name, value or SQL. Through M2 such a guard is a programming error and answers a
    sanitized `500 internal_error`. A COMMIT that PostgreSQL itself refuses with an ordinary ERROR
    (severity ERROR, a backend routine, not class 08, 57P or XX, not 40003) is a definite failure,
    nothing written; every other COMMIT error - FATAL, a connection pooler's own answer, a lost answer -
    is verified by the request key (`verified_after_commit_error` or `503 outcome_unknown`). The severity
    is the localized one the driver receives, so on a server whose `lc_messages` is not English every
    COMMIT error is verified by the request key - the safe direction. The expected loss of a right stays
    M2's own `404`. A club admin granted the platform admin role while its write runs answers `409
    try_again` (the database would derive `platform_admin`) when the grant is committed before the
    request's rights check; a grant committed after that check and before the audit row is refused by
    v35 (a sanitized `500`, nothing written; a role row that does not exist yet cannot be locked). No
    public HTTP change.

**M3-0 - the canonical-variable admin API (owner's decisions of 2026-10-14, after the M3a discovery and
the M3-0 delta discovery; as built in section J3):**

80. **Where the M3 frontend lives:** Training Load, not the general Settings. The administrator item of
    the Training Load navigation is **Data configuration**, its screen **Variables & mappings**, with the
    tabs **Variables**, **Source fields** and **Mappings**. It is shown only to an active platform admin in
    the platform workspace or a club workspace, and to an active club admin in that club's own workspace;
    coaches and athletes never see it. The existing metric pickers of the analyses and dashboards stay a
    separate function and do not change. M3-0 builds no navigation or frontend; the M3 frontend applies
    this.
81. **A new admin API for canonical variables** (J3), the only one the M3 frontend uses to create or
    version an OptiMove variable - never the older `/api/training-load/metrics` write routes. The owner
    is always derived from the active workspace (the platform workspace: the system scope; a club
    workspace: that club); the client never sends an owner, an owner key, an actor id or a basis.
82. **A durable request record (v36)**, `training_load.metric_variable_requests`: one row per successful
    admin write, in the write's own transaction, before its COMMIT. The same user, key and hash replay;
    the same key with another hash or operation is `request_key_reused`; a lost COMMIT answer is
    verified by looking the row up on another connection. The write sets the v35 transaction-local actor
    setting before its first protected write, and the row's BEFORE guard checks the acting user, the
    derived basis (the v35 functions) and that the definition and the version are this transaction's
    own. **Limit, stated:** the older `/api/training-load/metrics` API and the GPEXE team-owned writer
    keep writing Metrics Core definitions without a request row or an acting user (compatibility,
    unchanged). A deferred "every definition this transaction wrote has its request row" check is not
    built in M3-0: it could only be opt-in - scoped to the transactions that carry the acting-user setting,
    the same limit as C74 - and the admin service writes the row as the last statement of its transaction,
    before the COMMIT, which its tests prove. The guard is point-in-time: it proves that the row agrees with
    its definition and version when it is inserted, not that a later statement of the same transaction
    leaves them so (a deferred re-check of the row at COMMIT, proposed by the database review, is left to
    the owner). `expectedCurrentVersionId` is a precondition of a new version, never the idempotency of a
    request.
83. **Stable codes:** `409 variable_not_active` (a new version of an archived variable);
    `409 variable_pinned` (v34's decision 9 guard: an active mapping version pins the current version -
    unreachable before T5, mapped and tested now); `409 version_unchanged` (the new version's whole
    semantics - unit, value type, daily aggregation, minimum, maximum and condition - equal the current
    version's, compared through a deterministic normalization: exact decimals and the condition in a
    fixed field order, never a JSON text; the reason is not semantics).
84. **The key:** the server suggests it from the name, the client may send its own before the create,
    and it is immutable afterwards (shown only in Technical details). Rule `^[a-z][a-z0-9_]{0,62}$`
    (1-63 characters; Metrics Core itself stores any text, v10). The suggestion is deterministic: NFKD
    normalization; the combining marks removed; the Serbian Latin letters mapped explicitly (đ and Đ as
    `dj`; č, ć, š and ž listed too); lower case; every run of other characters one underscore;
    underscores merged and trimmed; cut to 63 characters (a trailing underscore removed); a result that
    fails the rule is no key - `400 key_required`. It transliterates no Cyrillic or other script.
85. **Fields and validation:** a canonical variable of this flow is `numeric`; its unit is a unit token
    (the v34 rule `source_metric_unit_token_ok`; the UI suggests `s`, `min`, `m`, `km`, `m/s`, `km/h`,
    `count` and `W/kg`, not a closed list), otherwise `400 invalid_unit`; the levels are `session` and
    `drill` (Metrics Core's `component`; `day` is not offered), at least one; `dailyAggregationMethod`
    is required; the condition is none, a zone (`between` with lower and upper, or one of `>=`, `>`,
    `<=`, `<` with one value) or an event threshold (one of the four one-sided operators, a value and
    `durationSeconds` of at least 0), each with a unit token - any other shape `400 invalid_condition`;
    decimals are exact strings (the M2 rule), never a binary float.
86. **B3:** the M2 reads carry the canonical target's `key` and `label` (`/targets`, every mapping
    summary and detail) and the source field's own `label` (1-80 by its CHECK). Metrics Core's own
    columns are unbounded text, so the bounds are the admin API's input limits (label 80, key 63, short
    label 20, description 500, unit 30, reason 500); a longer value written through the older API is cut
    at its limit and `truncated: true` says so.
87. **The request hash** covers the contract version (`metric-variables/v1`), the operation, the path
    ids and the canonically normalized body.
88. **Scope of the first M3:** create a variable and create a new immutable semantic version - no
    archive or reactivation, no level removal, no domains, categories or structure links. Archived
    variables stay visible read-only (`state=active|archived|all`), for their history, data and taken
    key. In a club workspace the system variables are a separate read-only reference (`scope=system`),
    never a target of a club mapping.

**Migration numbering (decided 2026-10-14):** v36 is the M3-0 request record; M2b - the T2b unit and
meaning confirmations and their database actor guards - is v37, and comes before the M3 write UI of
draft mappings (M3c).

---

## D. Accepted model — **implemented as schema in M1 (v34, merged and deployed); read and first written by M2 (J1), used by the importer only from M4**

At `af11338` nothing of this section existed. Migration v34
(`migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`, rollback
`docs/runbooks/source-metric-mapping-v34-rollback.sql`) builds D1–D10 and the D12 seed as described,
with the owner's M1 decisions C40–C58; where the build adds a detail the design left open, an
**As built (M1)** note says so. No route, service, importer, mapper, preview or writer reads these
tables yet (M2, M4). **Lock order for every writer**
(admin and importer): `unit_conversions` → T2a → T2b → T3 → T4 → `metric_definitions` (the
canonical row, `FOR SHARE`) → its scope-capability rows (`FOR SHARE`, activation only) → T5 → the
team binding (`FOR SHARE`, a new T6 fact only) → the Metrics Core connection (`FOR SHARE`, a new T6
fact only) → the acting user's `user_global_roles`, `user_club_roles`,
`users` and `clubs` rows (`FOR SHARE`, after every registry row; no role or club writer ever waits
on a registry row), ascending by id within a table. The replacement sequences written in D3 and D6 are the order of **state changes**,
not of locks: an operation pre-locks every T2b, T3 and T4 row it will touch `FOR UPDATE` in this
order, then the canonical `metric_definitions` row `FOR SHARE`, then the T5 rows, before its first
modification, and inserts T5 rows ascending by binding id. The T4 INSERT trigger reads
`unit_conversions` as a plain read.
Every transition trigger locks the parents it reads `FOR SHARE` in the same order before reading
them (T4 → `active` locks T2b, T3, then the canonical `metric_definitions` row; a T5 insert locks
its T4 row), so "retire vs activate", "disable vs activate" and "canonical repoint vs activate"
are serialized and never check-then-act races. The guard on `metric_definitions` (decision 9)
reads T4 with a plain SELECT and never a lock, which is what keeps the order cycle-free against the
catalog writers that lock `metric_definitions` first (`trainingLoadMetricsCatalog.js:279`, :380,
:420) and against the importer (`gpexeImportWriter.js:178`). v27 rows (connection, catalog,
binding) are read by the T5 trigger as plain reads in the v27 order connection → catalog →
binding, never locked, so an Unbind is never inverted; the one race this allows — an activation
inserted for a binding ended in the same instant — is harmless, because that binding applies to
nothing. The importer reads T5 unlocked first, then locks T2b → T3 → T4 → T5 `FOR SHARE` and
re-checks that the rows are unchanged (the F3c2g pattern); no admin operation ever takes a team
lock or a measurement row. Every write of M2 carries a `requestKey`; the operation's own audit row
is the request record (the F3c2f pattern, D10);
every COMMIT follows the F2 discipline (`verified_after_commit_error` / `503 outcome_unknown`,
never "nothing was changed"); a replay of a `requestKey` re-evaluates the caller's current right
before the saved answer is returned (the F3c2f rule). Every M2 route resolves ownership and the
active workspace in the service before any trigger can fire, answers the identical 404 of ADR-006
to everyone outside the rights of section G, uses stable codes only (a transition conflict is a
`409`) and never forwards a trigger's text; every new trigger raises a fixed message without an
id, so the triggers are backstops, never the first check. The acting user of every activation,
disabling and ending is verified in the database as an active platform admin (D6, D7); the same
identity check covers the revision's `unit_verified_by_user_id`, `meaning_verified_by_user_id` and
`activated_by_user_id` (T2b), `unit_conversions.created_by_user_id`, and `submitted_by_user_id`
against `submitted_basis` (an active platform admin for `platform_admin`, an active admin of the
mapping's club for `club_admin`) — a basis label never stands in for the user.

**As built (M1), lock order and reads.** The T4 transition to `active` locks, after the canonical
`metric_definitions` row, that definition's scope-capability rows `FOR SHARE` before it re-checks the
levels — the reads the trigger depends on are locked, as this section requires — so removing a level
and activating a version that applies to it never both succeed; the catalog writers lock
`metric_definitions` before touching capabilities, so the order stays cycle-free. T2a is read plain by
the T2b activation and the T5 insert: its state is implied by the chain (a T2a field is not retired
while a revision is `draft` or `active`; a revision insert locks the field `FOR SHARE`; T5 needs an
`active` T4, which needs an `active` revision), and a lock there would invert the order against a
writer that already holds T4. The T5 insert reads the v27 rows plain in the order binding →
connection joined with its catalog row (it needs the binding's connection id first), never locked;
the order of plain reads has no lock effect. The T6 insert locks its T5 row `FOR SHARE` (C49). Every
refusal is `42501` or `23514` with a fixed message (C44). A transition trigger runs after the row it
changes is already locked, so the documented order holds only when the M2 writer pre-locks T2b → T3 →
T4 as this section requires (an M2 acceptance item); a raw writer that does not can meet a clean
`40P01`, never an inconsistent row. The serialization pairs are tested in both orders with the second
operation proven to wait (`backend/tests/source-metric-mapping-m1.test.mjs` test 20, test 13 and 14).

**As built (M1), review corrections (2026-10-12):** a seed marker is accepted only inside the
seeding migration itself — it must name v34 and v34 must not be recorded yet, which is true only in
v34's own transaction (the runner records a migration after running it, in the same transaction);
afterwards a row with a marker has no acting user and is refused with `42501` on T2a, T2b and
`unit_conversions` (a later seeding migration replaces `source_metric_require_seed_window` to name
itself). Disabling a T4 version writes only its own facts (no submission or activation added on the
way). A T8 row with the club-admin basis must name a club-owned mapping (C45). The unit token refuses,
beside the locale's whitespace (`\s`), `|`, `=`, C0, DEL and C1, exactly these characters: `U+00A0`,
`U+00AD`, `U+061C`, `U+1680`, `U+180E`, `U+2000–U+200F`, `U+2028–U+202F`, `U+205F–U+206F`, `U+3000`,
`U+FEFF` — D3's "no whitespace" taken literally, widened by C53. The rollback refuses a database on
which v34 is not recorded.

**As built (M1), the owner's decisions C51–C58 (2026-10-12).** The owner freeze is a `BEFORE UPDATE OF
owner_scope, owner_user_id, owner_club_id, owner_team_id` trigger on `metric_definitions` that fires only
when one of the four changes and refuses when a T3 row names it; it takes no lock of its own — the
owner-change `UPDATE` already holds the row's lock (its strongest mode, the owner columns being in the
definition's unique key) before the trigger runs, and the T3 INSERT locks the definition `FOR SHARE`
(D4), so the two serialize on that row. The activation
(T4 `needs_review → active`) now starts with `source_metric_lock_conversions()` — the active
`unit_conversions` rows of the value pair and of the bound pair, `FOR SHARE`, ascending by id — then
locks T2b, T3, the canonical row and its scope capabilities as before, and checks the value conversion
and the bound conversion against the locked rows (C52); the T4 INSERT still reads `unit_conversions`
plain. The T6 INSERT locks T5 → the binding → the Metrics Core connection `FOR SHARE` and then reads
T4, T2b, the value chain (value → occasion → participant → event) and the v27 credential connection
plain (C55); none of those plain-read rows is locked by any M1 writer before T5, so the order stays
cycle-free. An ending of a binding (v27 Unbind, which takes the team's import lock inside its trigger)
or of a Metrics Core connection is a row UPDATE that waits for a fact holding the row `FOR SHARE`, or
lands first and the fact is refused; the real Unbind bounds that wait by its row `lock_timeout` and
answers `try_again` (C58). The T4 INSERT refuses a canonical unit that is not a unit token
(`canonical_unit_not_a_token`) and `target_unit` carries the unit-token CHECK (C56). Tests:
`backend/tests/source-metric-mapping-m1.test.mjs` 4 (C53), 8 and 9 (C54, C56), 21 (C51), 22 (C52),
23 (C55, C58) and 14 (the activation side of C49 / C55).

### D1. `source_host_catalog.api_family` (extension of v27)

`api_family text not null check (in ('api','rest_v1'))`, backfilled `e03 → api`,
`server3 → rest_v1`, immutable afterwards (extension of `source_host_catalog_immutable`,
`migrations_v2/202609271000_training_load_v27_source_credential_connections.sql:97`). A test
compares the column with `SOURCE_HOSTS[*].apiFamily` in `backend/src/sourceHosts.js:49-58`; the code
stays the authority and the database must agree. Without it the database cannot refuse an
activation of a contract proven on `rest_v1` for an `api` host. The v28 rollback script's row
comparison is to be checked in M1.

**As built (M1):** the immutability is a separate trigger beside the v27 guard
(`source_host_catalog_api_family_immutable`), so the v27 function is unchanged and the v34 rollback
restores nothing but drops its own objects; a catalog row the backfill cannot place stays NULL and
fails the migration (no guessed family); a test compares the column with `SOURCE_HOSTS[*].apiFamily`.
The v28 rollback's row comparison (label, state, note) is unaffected: it refuses under any later
migration, and after a v34 rollback the column no longer exists. The v27 runbook's "Adding a confirmed
shard" insert names `api_family` (a later data-only catalog migration without it fails, and with it
the deploy that carries it); a test runs that insert shape.

### D2. T2a `training_load.source_metric_definitions` — stable identity of a source field

- Purpose: one row per field a source offers, with no semantics. System-owned, written by a
  platform admin. Holds no athlete data.
- Columns: `id`; `source_system` (`^[a-z][a-z0-9_]{1,30}$`); `api_family` in `api|rest_v1`;
  `source_metric_key` (`^[a-z][a-z0-9_.]{1,120}$`, the field path, e.g.
  `athlete_session.total_time`, `more.complementary_data.power.distance`); `source_label` (the
  source's own name, 1–80, the only editable field); `state` in `active|retired` with
  `retired_by/at/reason` null together; `created_by_user_id`, `created_at`; `seed_migration text`
  (CHECK: exactly one of `created_by_user_id` or `seed_migration` is set, D12).
- Uniqueness: `unique (source_system, api_family, source_metric_key)`;
  `unique (id, source_system, api_family)` (composite FK anchor).
- Immutable: system, family and key always. DELETE refused. `retired` refused while a revision is
  `active` or `draft`.
- Never stores a unit, a value, a bound or a threshold. Its only free text is `source_label` and
  `retired_reason`, bounded and single-line (no control character). No free-text column of any
  table in this section is a place for an athlete's name, id, date of birth or value: the UI and
  the runbook say so in so many words, because these rows are immutable or append-only and cannot be
  erased.

### D3. T2b `training_load.source_metric_definition_versions` — the proven contract, revisioned

- Purpose: the evidence-bearing contract of a field: shape, parameter kind, levels, proven units,
  proven meaning. A correction is a new revision; the old one is retired, never changed.
- Columns: `id`; `source_metric_definition_id` → T2a; `revision_number > 0`; `value_shape` in
  `number|numeric_text|unit_value_object|zone_distance|event_count`; `parameter_kind` in
  `none|zone_bounds|event_threshold` with `(value_shape = 'zone_distance') = (parameter_kind =
  'zone_bounds')` and `(value_shape = 'event_count') = (parameter_kind = 'event_threshold')`;
  `supports_session`, `supports_drill` (at least one); every unit column of this table
  (`expected_source_unit`, `source_unit`, `expected_source_bound_unit`, `source_bound_unit`) holds
  a **unit token**: a CHECK of 1–30 characters with no whitespace, no control character, no `|` and
  no `=` (the same token the fingerprint of section E renders); `expected_source_unit`, `unit_note`
  (hypothesis, documentation only); `source_unit` (**only a proven unit, NULL until proven**);
  `expected_source_bound_unit`, `source_bound_unit` (only for `parameter_kind <> 'none'`; a zone
  revision with a proven value unit must also have a proven bound unit); `bound_operator` in
  `between|>=|>|<=|<` (only for `parameter_kind <> 'none'`; a deceleration threshold is `<=` with
  a negative value; NULL until the meaning is verified, required
  for `verified`; the operator the source applies to its bound — confirmed in the same act as the
  meaning, immutable once set, part of the proven contract; a different operator is a new revision,
  and an old fact stays bound to the old contract through its mapping version; accepted
  2026-10-12, C38); `unit_verified_by_user_id`,
  `unit_verified_at`, `unit_evidence_ref` (null together; `(source_unit is null) = (unit_verified_at
  is null)`); `meaning_verified_by_user_id`, `meaning_verified_at`, `meaning_evidence_ref` (null
  together); `evidence_status` in `unproven|documented|observed|verified` with
  `(evidence_status = 'verified') = (source_unit is not null and meaning_verified_at is not null
  and (parameter_kind = 'none' or bound_operator is not null))`;
  `evidence_ref` (required unless `unproven`); `state` in `draft|active|retired` with
  `activated_by/at` and `retired_by/at/reason`; `created_by_user_id`, `created_at`;
  `seed_migration text` (CHECK: exactly one of `created_by_user_id` or `seed_migration`, and for
  an `active` row exactly one of `activated_by_user_id` or `seed_migration`; a row inserted
  directly as `active` — not through `draft → active` — is allowed only with the seed marker,
  D12).
- Uniqueness: `unique (source_metric_definition_id, revision_number)`;
  `unique (id, source_metric_definition_id)` (anchor for T4);
  `unique (source_metric_definition_id) where state = 'active'` — **at most one active revision per
  (system, family, key)**; `unique (source_metric_definition_id) where state = 'draft'` — at most
  one draft in preparation.
- Immutable: `value_shape`, `parameter_kind`, levels from INSERT; `source_unit` and
  `source_bound_unit` write-once, only together with the verification fields; `evidence_status`
  only upwards.
- Transitions: `draft → active → retired`, `draft → retired`. `active` refused while another
  revision of the same definition is not `retired` (the partial unique enforces it physically).
  `retired` refused while a T4 version pinned to the revision is `active` or `needs_review`.
  DELETE refused.
- Audit (T8): `source_metric_revision_create`, `source_metric_unit_verified` (with `evidence_ref`),
  `source_metric_meaning_verified`, `source_metric_revision_activate`,
  `source_metric_revision_retire`.
- Never stores a value, a bound or a threshold. `evidence_ref`, `unit_evidence_ref` and
  `meaning_evidence_ref` carry a CHECK for a document-path-plus-anchor shape (a restricted alphabet,
  no space, 1–300 characters); `unit_note` and `retired_reason` are bounded single-line text without
  control characters. The D2 warning applies to every one of them.
- **Revision replacement** (M2 operation, one bounded transaction): prepared in advance (draft
  revision R+1, its unit and meaning verified and audited, new T4 versions pinned to R+1 in
  `needs_review`); then, under the lock order above: end every open T5 activation of the versions
  pinned to R → `disabled` those versions → `retired` R → `active` R+1 → `active` the new T4
  versions → new T5 activations only for the explicitly listed bindings. The new revision inherits
  nothing; old facts and old versions stay pinned to R.

### D4. T3 `training_load.source_metric_mappings` — the stable identity of one link

- Purpose: "this source field feeds this canonical variable". May be created before the unit is
  proven (decision 27).
- Columns: `id`; `source_metric_definition_id`, `source_system`, `api_family` with
  `fk (source_metric_definition_id, source_system, api_family) → T2a (id, source_system,
  api_family)`; `metric_definition_id → metric_definitions(id)`; `owner_scope` in `system|club`
  with `owner_club_id` (`system` ⇔ null club); `created_by_user_id`, `created_at`.
- Uniqueness: `unique (source_metric_definition_id, metric_definition_id)` — one lineage per pair,
  changes go through versions; `unique (id, source_metric_definition_id, metric_definition_id)`,
  `unique (id, source_system, api_family)` and `unique (id, owner_key)` (anchors; the last one lets
  T4 carry a checked, non-null owner key for the per-owner unique of D6). `owner_key text not
  null` is a generated stored column, `coalesce(owner_club_id::text, 'system')`: it is never NULL,
  so a composite FK that copies it is always checked (PostgreSQL's default `MATCH SIMPLE` skips a
  foreign key whenever a referencing column is NULL, which is why the nullable `owner_club_id` is
  not used as a copied key).
- Trigger: a `system` mapping targets a `system` canonical definition; a `club` mapping targets a
  `club` definition of the same club; the definition is `active` at creation. Identity immutable;
  DELETE refused.

### D5. `training_load.unit_conversions` — the small, append-only gate of every conversion

- Purpose: the only place a non-identity factor between two units may come from, checkable by the
  database. **It is not a metric catalog**: it holds no metric key, label, type, level or
  semantics, only a pair of free-text units of the existing registries and a factor.
- Columns: `id`; `from_unit`, `to_unit` (1–30, different); `scale numeric` (`> 0`, finite; C54 —
  `unit_conversions_scale_positive`); `scale_divisor numeric` (`> 0`, finite); `offset numeric`
  (finite, may be negative) — "finite" is a CHECK that
  refuses `NaN`, `Infinity` and `-Infinity`, all three of which a PostgreSQL 14+ `numeric` can hold;
  `check (scale = 1 or scale_divisor = 1)`; `state` in `active|retired` with `retired_by/at/reason`;
  `evidence_ref` (required, the D3 shape CHECK); `created_by_user_id`, `created_at`;
  `seed_migration text` (CHECK: exactly one of actor or seed marker, D12). The
  conversion is `canonical = source × scale / scale_divisor + offset`; the divisor exists so that
  factors such as 1/60 and 1/3.6 are exact rational constants in `numeric`, never a rounded decimal
  (a representation of the owner's linear rule, decision 12, not a new kind of conversion; accepted
  2026-10-12, C34). **Normal form:** a factor whose value is a terminating decimal is stored as
  `(that decimal, 1)` — `m/s → km/h` is `(3.6, 1)`, `m → km` is `(0.001, 1)`; a factor that is not
  (1/60, 1/3.6) is stored as `(1, d)` with `d` its reciprocal in shortest terminating decimal form —
  `(1, 60)`, `(1, 3.6)`, never `(2, 120)`, `(36, 10)` or `(5, 18)`. The CHECK `scale = 1 or
  scale_divisor = 1` refuses every pair with two non-unit factors; numeric equality makes `3.60` and
  `3.6` the same value; the M2 API refuses any other non-normal pair; the database enforces the
  exact tuple match against the single active row of the pair. **Representable range:** a
  conversion whose factor and reciprocal are both non-terminating decimals (for example 7/3), or
  whose offset is itself a non-terminating decimal (°F → °C, offset −160/9), cannot be stored in M1
  and is refused; none of the pilot's conversions (s, m, m/s, km/h) is affected, and widening the
  representation is a separate owner decision (K). The import writer never computes in binary
  floating point (D8, J M4).
- Uniqueness: `unique (from_unit, to_unit) where state = 'active'`.
- Maintained by a platform admin through M2 (T8 `unit_conversion_create` / `_retire`) or by a data
  migration. Rows are immutable; a correction is `retired` plus a new row. A T4 version keeps **its
  own copies** of the factors, so retiring a row changes no existing `active` version, no history and
  no fact; the table gates new versions **and their activation** (C52: the transition to `active`
  locks the active row of the value pair and of the bound pair `FOR SHARE` and checks the version's
  factors against it again, so a draft built from a row retired before its activation cannot be
  activated). Identity pairs need no row: the trigger accepts `1, 1, 0` when the units are
  string-equal.
- <a id="d5-unit-conversion-seed"></a>Seed (M1), as (scale, scale_divisor, offset): `s → min (1, 60, 0)`,
  `m/s → km/h (3.6, 1, 0)`, `m → km (0.001, 1, 0)`, `km/h → m/s (1, 3.6, 0)`. These four rows are SI
  definitions; their `evidence_ref` points here (`#d5-unit-conversion-seed`, a stable explicit anchor).

### D6. T4 `training_load.source_metric_mapping_versions` — the immutable mapping contract

- Purpose: one approved way to turn one source revision into one canonical version, with the
  conversion and the semantic parameters snapshotted.
- Columns: `id`; `mapping_id`, `source_metric_definition_id`, `metric_definition_id` with
  `fk (mapping_id, source_metric_definition_id, metric_definition_id) → T3 (id, …)`;
  `owner_key text not null` (the checked copy of the mapping's owner through `fk (mapping_id,
  owner_key) → T3 (id, owner_key)`; T3's `owner_key` is never NULL — a club id, or `'system'` —
  so this FK is checked for every row, system rows included, which a copy of the nullable
  `owner_club_id` would not be under PostgreSQL's default `MATCH SIMPLE`; the INSERT trigger fills
  it from T3 and refuses a supplied value that differs; immutable from INSERT. It exists because
  status lives on this table and ownership on T3, and a partial unique index cannot join — so the
  per-owner unique below is enforced by the database, not by the application);
  `source_metric_version_id` with `fk (source_metric_version_id, source_metric_definition_id) → T2b
  (id, source_metric_definition_id)` (**the exact revision**); `version_number > 0`;
  `metric_definition_version_id` with `fk (metric_definition_version_id, metric_definition_id) →
  metric_definition_versions (id, metric_definition_id)` (the exact canonical version);
  `conversion_kind` in `numeric_linear` (M1); `scale` (`> 0`, finite, C54), `scale_divisor` (`> 0`,
  finite), `offset` (finite), `check (scale = 1 or scale_divisor = 1)`, `rounding_decimals` (null or 0–6, a presentation field unused in the pilot; the
  storage scale of an imported value is the fixed S = 9 decimals of D8, not this column); `source_unit`, `target_unit` (copies,
  checked against the revision and the canonical version; both unit tokens by their CHECKs, C56); `conversion_note` (bounded single-line text, 1–500; required when the
  units differ); `parameter_kind` (copy of the revision); `source_parameters jsonb`,
  `canonical_parameters jsonb` (flat objects, no secret-named key, see section E);
  `parameter_fingerprint text not null` (computed by the INSERT trigger, never taken from the
  caller; `''` for `parameter_kind = 'none'`, otherwise `v1:` plus the SHA-256 hex of the canonical
  parameter text defined in section E, "Parameter fingerprint"; it lets one source field feed
  several canonical zone variables, one per distinct bound set, and carries no athlete, session or
  team identity);
  `parameter_scale` (`> 0`, finite, C54), `parameter_scale_divisor` (`> 0`, finite),
  `parameter_offset` (finite, may be negative), `check (parameter_scale = 1 or parameter_scale_divisor = 1)`;
  `applies_to_session`,
  `applies_to_drill` (at least one); `status` in `draft|needs_review|active|disabled` with
  `submitted_by/at`, `submitted_basis` (`platform_admin|club_admin`), `activated_by/at`,
  `activated_basis` (`platform_admin`), `disabled_by/at`, `disabled_basis` (`platform_admin`),
  `disable_reason` (bounded single-line text); `created_by_user_id`, `created_at`.
- Uniqueness: `unique (mapping_id, version_number)`; `unique (mapping_id) where status = 'active'`
  — one active version per mapping; **the active canonical target of a source metric with given
  parameters is unique within one owner** (owner decision of 2026-10-12, C33), enforced by one
  partial unique index over the checked owner key: `unique (source_metric_definition_id,
  parameter_fingerprint, owner_key) where status = 'active'` — the system scope is the single key
  `'system'` and each club its own id, which is exactly the owner's "system: (field, fingerprint);
  club: (field, fingerprint, owner_club_id)" — so the platform may hold a system mapping of a (field, parameters) pair,
  each club its own mapping of the same pair towards its own club variable, and none of them is
  ever activated automatically; within one owner the same pair never has two active targets, and
  the three power zones of one field are three fingerprints that may all be active; `unique (id,
  mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint)`, `unique
  (id, mapping_id)` and `unique (id, source_metric_version_id)` (anchors for T5 and T6 — PostgreSQL
  requires a unique constraint with exactly the referenced columns). Supporting indexes:
  `(source_metric_version_id)`, `(metric_definition_id) where status = 'active'`. **No global
  unique per canonical and source family**: alternative source fields of the same API family may
  hold active versions towards the same canonical variable; exclusivity is decided at the
  activation (T5), where a binding may hold only one open activation per (field, parameters) and
  one per (canonical, scope), so when a system mapping and a club mapping of the same pair both
  exist the platform admin chooses explicitly which one that binding uses. The refusal within one
  owner is `409 source_metric_target_taken`; it names only the owner scope of the mapping being
  activated.
- INSERT trigger (fail-closed, also for direct SQL): a row is inserted only as `draft` (every
  later state is a checked transition, so no direct insert skips the active-platform-admin
  check); the revision is `draft` or `active` with
  `source_unit not null`; `source_unit` equals the revision; the pinned canonical version is
  `numeric` and its `unit` is not NULL and 1–30 characters (`metric_definition_versions.unit` is
  nullable free text, v10:143 — a version without a unit is not a mapping target,
  `canonical_unit_missing`) and a unit token (C56, `canonical_unit_not_a_token`), and `target_unit` equals it; `parameter_fingerprint` is computed by
  the trigger from `source_parameters`, never taken from the caller; levels ⊆ the revision's and ⊆ the definition's
  scope capabilities (`session` ↔ `session`, `drill` ↔ `component`); the value conversion is `1, 1, 0`
  (scale, divisor, offset) for string-equal units, otherwise exactly one active `unit_conversions`
  row `(source_unit → target_unit)` with the same `scale`, `scale_divisor` and `offset`; the
  parameter rules of section E.
- Transition to `active`: the revision is `active` and `verified`; the canonical definition is
  `active` with `current_version_id` equal to the pinned version; the parameter equivalence is
  re-checked, and so are the levels against the definition's current scope capabilities (a level
  removed while the version was `draft` or `needs_review` is caught here, the BEFORE DELETE guard
  of section E covering `active` versions only); `activated_basis = 'platform_admin'` **and** `activated_by_user_id` is an active
  platform admin at that moment — the trigger locks that user's `user_global_roles` row `FOR SHARE`
  and checks `users.is_active` (the v21 / v23 precedent), SQLSTATE `42501` otherwise; the basis
  label alone never proves the right. Transition to `disabled`: refused while an open T5 activation
  references the version; the same identity check on `disabled_by_user_id`. A club admin may only
  submit (`draft → needs_review`, `submitted_basis = 'club_admin'`); every other transition is a
  platform admin's. Transitions: `draft → needs_review → active → disabled`,
  `draft → disabled`, `needs_review → disabled`; nothing leaves `disabled`. All non-status columns
  immutable from INSERT. DELETE refused.
- Guard on `metric_definitions`: BEFORE UPDATE OF `current_version_id` or `state` refuses while an
  `active` T4 version pins the old current version (decision 9). The explicit order is: disable the
  mapping version → new canonical version → new mapping version → activate. No computed "stale"
  state exists.
- **Version replacement** (M2 operation `activate version N+1`, one bounded transaction, lock order
  above): end every open T5 activation of version N with `end_reason =
  'mapping_version_replaced'` → `disabled` N → `active` N+1 → new T5 rows only for the explicitly
  listed bindings, each with its own `requirement` and audit row. Every intermediate state satisfies
  the constraints; a failure rolls everything back; a lost COMMIT answer is verified on a second
  connection by `request_key`. Disabling without a replacement is the same sequence without the
  last two steps (`mapping_version_disabled`). Both sequences end every open T5 row of the version,
  including rows whose binding has meanwhile ended, so a stale activation never blocks a disable.

### D7. T5 `training_load.source_metric_mapping_activations` — the permission for one version on one binding

- Purpose: "this team binding may import through exactly this mapping version". Written and ended
  only by a platform admin in the first scope.
- Columns: `id`; `mapping_version_id`, `mapping_id`, `source_metric_definition_id`,
  `metric_definition_id`, `parameter_fingerprint` with `fk (…) → T4 (id, mapping_id,
  source_metric_definition_id, metric_definition_id, parameter_fingerprint)` (checked copies, so the
  partial uniques below can name them); `source_team_binding_id`, `team_id` with `fk (source_team_binding_id,
  team_id) → source_team_bindings (id, team_id)` (M1 adds `unique (id, team_id)` to the v27 table);
  `applies_to_session`, `applies_to_drill` (checked copies of the version); `requirement` in
  `required|optional` **without a default**; `activated_by_user_id`, `activated_basis`
  (`platform_admin`), `activated_at`, `reason` (bounded single-line text, 1–500); `ended_at`, `ended_by_user_id`, `ended_basis`
  (`platform_admin`), `end_reason` in `admin_ended|mapping_version_replaced|mapping_version_disabled`
  (null together; there is no reason for an ended binding, because an Unbind never writes this row).
- Uniqueness: `unique (source_team_binding_id, source_metric_definition_id, parameter_fingerprint)
  where ended_at is null` — a source metric with given parameters at most once per binding (the
  three power zones of one field are three open rows); supporting index `(mapping_version_id) where
  ended_at is null`; `unique (source_team_binding_id, metric_definition_id)
  where ended_at is null and applies_to_session` and the same `where … and applies_to_drill` — **on
  one binding and one scope a canonical variable has one activated source**; `unique (id,
  mapping_version_id, source_team_binding_id)` (anchor for T6).
- INSERT trigger: `activated_by_user_id` is an active platform admin (the same `FOR SHARE`
  identity check as T4; the basis label is never enough), and the ending UPDATE checks
  `ended_by_user_id` the same way; the version is `active`; the binding is `active`; the binding's
  `source_system` equals the field's; the `api_family` of the binding's connection host (`source_host_catalog`,
  through `connection.host_key`) equals the field's; the mapping's owner is read from T3 (never from
  an unchecked value of the caller; T4's `owner_key` is its checked copy); a `system` mapping on any binding, a `club`
  mapping only on a binding whose connection is club-owned by that club; a `team`-owned connection
  (allowed by v27, created by no route today) may host a `system` mapping only when
  `connection.owner_team_id = binding.team_id`, and **never a club mapping** — the v27 team-move
  guard protects only club-owned connections (`source_team_binding_guard_team_move`, v27:410-427),
  so the database cannot prove the club stays the same, and decision 24 says fail-closed; the level
  copies equal the version. The trigger locks the T4 row `FOR SHARE` (so a concurrent disable is
  serialized) and reads the v27 rows (connection, catalog, binding) as plain reads in the v27 order,
  never locked.
- UPDATE only of the ending fields; DELETE refused. An Unbind does not touch the row: the binding
  becomes `ended`, a new bind is a new id, so the old activation applies to nothing and stays as
  history. A team or club archive makes the import impossible through the existing resolver rules;
  the activation stays as history.
- **An activation never exists without a verified source contract**: it requires an `active` T4
  version, which requires an `active`, `verified` revision with a proven unit.

### D8. T6 `training_load.metric_value_source_provenance` — 1:1 with the value, append-only

- Purpose: every imported fact permanently names what produced it. Never read by any coach-facing
  reader: `canonical_activity_results()` and the dashboard query project explicit `metric_values`
  columns and do not touch this table.
- Columns: `metric_value_id` (PK, → `metric_values(id)`); `activation_id`, `mapping_version_id`,
  `source_team_binding_id` with `fk (…) → T5 (id, mapping_version_id, source_team_binding_id)`;
  `mapping_id` with `fk (mapping_version_id, mapping_id) → T4 (id, mapping_id)`;
  `source_metric_version_id` with `fk (mapping_version_id, source_metric_version_id) → T4 (id,
  source_metric_version_id)`; `metric_source_connection_id → metric_source_connections(id)`;
  `source_unit` (not null); `source_value_numeric` (not null, finite); `recorded_at`.
- Trigger: the value's `metric_definition_id` and `metric_definition_version_id` equal the ones
  pinned by the mapping version; `unit_at_capture = target_unit`; `source_unit` equals the pinned
  revision's `source_unit`; the arithmetic holds at the **storage scale S = 9 decimals** under one
  rule, applied by both sides (C39): the writer stores `value_numeric` = the exact value
  `(source_value_numeric × scale + offset × scale_divisor) / scale_divisor` rounded to 9 decimals,
  half away from zero, computed in decimal arithmetic; the trigger accepts exactly that value and
  no other, with multiplications only, so it never depends on PostgreSQL's numeric division scale:
  with `n = source_value_numeric × scale + offset × scale_divisor`, `d = value_numeric ×
  scale_divisor − n` and `h = scale_divisor × 5 × 10^-10` (half a unit of the 9th decimal, scaled),
  the trigger requires `scale(trim_scale(value_numeric)) <= 9` **and** (`abs(d) < h` **or**
  (`abs(d) = h` and `sign(d) = sign(n)`)). The first condition puts the value on the 9-decimal grid
  (trailing zeros beyond the 9th decimal do not matter); `abs(d) < h` picks the unique nearest grid
  value; the tie case `abs(d) = h` admits only the neighbour away from zero. All of it is exact
  `numeric` arithmetic (`scale()` exists since PostgreSQL 9.6; `trim_scale()`, used here and by the
  fingerprint, needs PostgreSQL 13 or later, which J M1 verifies on the local and the deployed
  server before relying on it). Exact
  equality without rounding is for the constants of section E only, never for a quotient such as
  `seconds / 60`, which is not a terminating decimal. S is a storage rule of M1; a display may show
  fewer decimals without changing the stored value, and `rounding_decimals` stays an unused
  presentation field without effect on the pilot (C25, C39);
  the binding's connection `host_key` equals the instance's `source_host_key`; the value's occasion → identity →
  the same `metric_source_connection_id`; that connection's `source_system` and
  `source_instance_key` equal the binding's `source_system` and `source_team_id`.
- Append-only through a dedicated function (`forbid_update_delete` formats `old.id`, v10:175, and
  T6 has no `id` column — its key is `metric_value_id`), plus a `BEFORE TRUNCATE` guard in the v27
  `source_history_no_truncate` style (v27:393-401); the same TRUNCATE guard protects every
  append-only or history table of this section (T2a, T2b, T3, T4, T5, T8, `unit_conversions`).
  Supporting indexes: `(activation_id)`, `(source_team_binding_id)`. All FKs `on delete restrict`.
  The undo script's `PROTECTED_TRIGGERS` list (`backend/scripts/gpexe-undo-imported-session.mjs`)
  gains T6's append-only trigger, otherwise "delete T6 first" cannot run — **as built, already in
  M1 (C47)**, with the provenance removed first, in the same transaction, on disposable databases only.
- **As built (M1), C49:** the insert trigger also holds the T5 row `FOR SHARE` and refuses an ended
  activation, so no fact is written through an activation after its end.
- **As built (M1), C55:** the insert trigger then holds the team binding and the Metrics Core
  connection `FOR SHARE` and refuses an ended binding (`a fact is never written through an ended
  binding`), an inactive connection (`… through an inactive source instance`), a value whose event is
  not owned by the binding's team (`the value must belong to the binding's team`) and a value at a level
  the activation does not cover (`the value's level is not one the activation covers`); the import
  switch is not read. The M4 writer checks the same before it writes, for its stable codes; the
  trigger is the backstop.
- The content hash of an imported occasion (`gpexeImportWriter.js` `importedOccasionContentHash`,
  :99-116) gains the mapping version id and the source value and unit, so an identical session
  re-imported under a new mapping version is `needs_review`, never a silent supersede.
- Never stores: raw JSON, a name, an id of a person, a credential.
- Comparison that led to this choice (nullable columns on `metric_values` were the alternative): a
  separate table gives NOT NULL integrity with no half-filled state, keeps provenance out of every
  existing reader by construction, costs one join only when provenance is asked for, and behaves
  identically under RESTRICT, backup and retention. The undo script must delete T6 before the values
  in the same transaction (M4).

### D9. T7 — the write-once source instance identity on `metric_source_connections` (v11)

- Two columns, null together, write-once (set only from NULL, never changed): `source_host_key`
  (format as v27) and `source_instance_key` (`^[A-Za-z0-9._:-]{1,64}$`; for GPEXE the canonical
  Team ID). Partial unique `(source_system, source_host_key, source_instance_key) where state =
  'active'` — one active Metrics Core instance per source team.
- Why this and not a FK to the credential connection or a link table: a credential connection can be
  replaced (a duplicate after a lost Create, a later dedicated account) and bound to several teams,
  while the v11 row must outlive all of that so that the `team_session:<id>` dedup of v20 keeps
  working; a link table would duplicate what every T6 row already records (instance and binding).
- No Metrics Core table references or copies a credential column: there is no FK to
  `source_credential_connections`; the T5, T6 and T7 triggers select only `host_key`, `source_system`
  and the owner columns of a connection; every M2 reader of T5 / T6 projects explicit columns and
  never joins the credential connection. A fact stays readable after an Unbind, a Reconnect or an
  archive (everything RESTRICT, no row is deleted). Replacing a connection touches no fact. The
  writer (M4) refuses `source_instance_changed` when the binding's source team differs from the
  instance key.
- **A re-bind of the same source team to another OptiMove team** (allowed by v27 after an Unbind
  for a future source; for GPEXE today unreachable, because v30 binds only a team's own approved
  pair with one canonical Team ID across all settings rows (`refuse_unapproved_gpexe_binding`,
  v30:111-141; `gpexe_team_settings_canonical_team_id_key`, v30:175) and v24 freezes the first
  team's settings once GPEXE data exists — so this rule is defence in depth):
  the partial unique keeps the first team's instance `active`, so the new team's first import is
  refused fail-closed with `source_instance_held` and nothing is written. The old instance is ended
  (`state = 'inactive'`) only by a platform admin through an explicit, audited M2 operation
  (`source_instance_end` in T8); ending an instance deletes no event, identity, occasion, value or
  provenance row, moves no history to the new team, and every historical fact keeps pointing to the
  old instance; after that the new team's writer creates its own instance (accepted 2026-10-12,
  C36). The shape of that operation is an item of section K. Because the unique is partial (`active` only),
  an ended instance and the new team's instance share the same source team: to keep the v20 dedup
  across them, the writer refuses `session_imported_under_another_instance` when the session's
  external id already exists under any v11 row with the same `(source_system, source_host_key,
  source_instance_key)`, whatever its state — one GPEXE session is never imported into two OptiMove
  teams. The unique stays partial (decided, C36; review history K2 item 5).

### D10. T8 `training_load.source_metric_audit` — append-only, without a value-bearing column

- Columns: `id`; `action` in a closed set (`source_metric_create`, `source_metric_revision_create`,
  `source_metric_unit_verified`, `source_metric_meaning_verified`, `source_metric_revision_activate`,
  `source_metric_revision_retire`, `source_metric_retire`, `mapping_create`,
  `mapping_version_create`, `mapping_status`, `mapping_version_replaced`, `activation_start`,
  `activation_end`, `unit_conversion_create`, `unit_conversion_retire`, `source_instance_end`); nullable FKs to T2a, T2b,
  T3, T4, T5, `unit_conversions`, `metric_source_connections` (for `source_instance_end`) and
  `team_id`; `from_status`, `to_status`; `reason` (1–500);
  `evidence_ref` (1–300); `performed_by_user_id`; `basis` in `platform_admin|club_admin`;
  `performed_at`; `operation_id uuid not null` (every row of one operation shares it);
  `request_key`, `request_hash` (set on exactly one row per operation — the operation's own action
  row, e.g. `mapping_version_replaced` or `activation_start` — which is the request record; the
  other rows of the same transaction carry NULL and are found through `operation_id`);
  `unique (performed_by_user_id, request_key) where request_key is not null`, so a replay finds one
  row and a second body on the same key is `request_key_reused`; `unique (operation_id) where
  request_key is not null`, so one operation has exactly one request record.
- No `metadata jsonb` and no structured value-bearing column. Its free text is bounded and
  format-checked: `evidence_ref` has the document-path-plus-anchor CHECK of D3 and `reason` is
  single-line text of 1–500 characters without control characters. Both are typed by an
  administrator, so the UI and the runbook say in so many words that no athlete name, id, date of
  birth or value is entered there — the row is append-only and cannot be erased — and the M6 unit
  evidence is a document reference, never a value. Append-only trigger as `source_connection_audit`
  (v27:585).
- **As built (M1), one shape per action (C48).** The FK columns are `source_metric_definition_id`,
  `source_metric_version_id`, `mapping_id`, `mapping_version_id`, `activation_id`,
  `unit_conversion_id`, `metric_source_connection_id` and `team_id`; every action sets exactly its
  targets and no other; the composite FKs `(source_metric_version_id, source_metric_definition_id)` and
  `(mapping_version_id, mapping_id)` and a trigger (an activation row names its own version and team)
  keep the targets consistent; `from_status` / `to_status` come from `draft | needs_review | active |
  disabled | retired | inactive`; the basis is `platform_admin` except where a club admin may act.

  | Action | Targets | From → to | Reason | Evidence | Club admin |
  |---|---|---|---|---|---|
  | `source_metric_create` | T2a | — → `active` | | | |
  | `source_metric_retire` | T2a | `active` → `retired` | required | | |
  | `source_metric_revision_create` | T2a, T2b | — → `draft` | | | |
  | `source_metric_unit_verified` | T2a, T2b | — | | required | |
  | `source_metric_meaning_verified` | T2a, T2b | — | | required | |
  | `source_metric_revision_activate` | T2a, T2b | `draft` → `active` | | | |
  | `source_metric_revision_retire` | T2a, T2b | `draft` or `active` → `retired` | required | | |
  | `mapping_create` | T3 | — | | | yes |
  | `mapping_version_create` | T3, T4 | — → `draft` | | | yes |
  | `mapping_status` | T3, T4 | `draft` → `needs_review`; `needs_review` → `active`; `draft`, `needs_review` or `active` → `disabled` | required for `disabled` | | `draft` → `needs_review` only |
  | `mapping_version_replaced` | T3, T4 (the new version) | `needs_review` → `active` | required | | |
  | `activation_start` | T4, T5, team | — | required | | |
  | `activation_end` | T4, T5, team | — | | | |
  | `unit_conversion_create` | `unit_conversions` | — → `active` | | required | |
  | `unit_conversion_retire` | `unit_conversions` | `active` → `retired` | required | | |
  | `source_instance_end` | v11 connection (team optional) | `active` → `inactive` | required | | |

### D11. Invariants, stated once

1. One stable identity per source field (T2a unique).
2. At most one active source metric revision per (system, family, key) and at most one draft (T2b
   partial uniques).
3. An old mapping version and an old fact stay pinned to the old revision (T4 → T2b FK, T6 → T4 FK;
   both append-only).
4. One active version per mapping (T4 partial unique).
5. Within one owner (the system, or one club) the same source metric with the same parameters
   never has two active canonical targets (one T4 partial unique over the checked owner key,
   by field identity and parameter fingerprint); different owners may each hold their own.
6. Alternative source fields of the same API family may exist for the same canonical variable (no
   global unique on T4 by canonical and family).
7. On one binding and one scope a canonical variable has at most one activated source (T5 partial
   uniques; a canonical variable with no activated source is allowed, section F).
8. An activation references the exact mapping version (T5 composite FK).
9. A fact references the source revision, the mapping version, the activation, the binding and the
   Metrics Core source instance (T6 composite FKs and trigger). That every imported value has its
   T6 row is the writer's and the architecture test's guarantee (M4), not a database constraint:
   the database cannot force the pair, it can only refuse an inconsistent one.
10. No activation exists without a verified source contract (T5 → active T4 → active verified T2b
    with a proven unit).
11. No conversion factor exists outside `unit_conversions` and the versions' own immutable copies.

### D12. Seed of M1 (data only)

Nine T2a identities for `gpexe` / `rest_v1`, each with one T2b revision 1 in state `active`,
`evidence_status = 'observed'`, **all units NULL**, `expected_*` as a hypothesis labelled as coming
from the e03 pilot, no parameters, `evidence_ref` to `docs/ai/gpexe-rest-v1-compatibility.md`:
`athlete_session.total_time` (expected `s`), `athlete_session.total_distance` (`m`),
`athlete_session.max_v` (`m/s`), `more.complementary_data.power.distance` (`zone_distance`, expected
`m`, bound `W/kg`), `more.complementary_data.speed.distance` (`zone_distance`, expected `m`, bound
`m/s`), `more.events.acceleration_events_count` and `deceleration_events_count` (`event_count`,
expected `count`), `details.players.tot_burst_events` and `tot_brake_events` (`unit_value_object`,
expected `count`; the observed `unit: "number"` is a shape, the meaning is unconfirmed). The `api`
family (e03) is not seeded (F3c4 retires it). `bound_operator` is NULL on every seeded revision
(unproven, like the units). No T3, T4 or T5 row; the four `unit_conversions` rows of D5. No
canonical definition is seeded. Seed rows have no acting user: `created_by_user_id` and
`activated_by_user_id` are nullable only together with a non-null `seed_migration text` naming the
migration (CHECK: exactly one of actor or seed marker); every row created through M2 carries an
actor and no seed marker. **As built (M1):** the labels, notes, references and the marker are those
of C50; the rollback refuses unless these rows are exactly the seed.

---

## E. Units, zones and thresholds

- **Expected versus verified.** `expected_source_unit` and `unit_note` are a hypothesis and never
  enter a mapping. `source_unit` is NULL until a platform admin confirms it in one act that writes
  the unit, `unit_verified_by/at`, `unit_evidence_ref` and the T8 row
  `source_metric_unit_verified` with the same reference.
- **Unit and meaning are confirmed separately.** `verified` is possible only when both are
  confirmed (the T2b CHECK). A seen shape proves neither (burst / brake).
- **A mapping version exists only after the unit is proven** (T4 INSERT trigger); a mapping identity
  may exist before.
- **`unit_conversions` is not a metric catalog** (D5). A version keeps its own copies of every
  factor; retiring a conversion row changes no history.
- **Source and canonical parameter snapshots.** For `parameter_kind = 'none'` both JSON objects are
  empty and `parameter_scale = 1`, `parameter_scale_divisor = 1`, `parameter_offset = 0`. For `zone_bounds`: `source_parameters`
  is exactly `{operator, lower, upper|null, unit}` with `operator = revision.bound_operator`,
  `unit = revision.source_bound_unit` and `lower < upper`; `canonical_parameters` is exactly
  `{operator, lower, upper|null, unit}` and must equal the normalized `condition_description` of
  the pinned canonical version (`operator = cd.operator`, `lower = cd.min` or `cd.value`, `upper =
  cd.max` or null, `unit = cd.unit`; any other shape of `condition_description` is refused). For
  `event_threshold`: `source_parameters` is exactly `{operator, threshold_value, duration_seconds,
  unit}`, `canonical_parameters` exactly `{operator, value, duration_seconds, unit}` equal to the
  normalized `condition_description` (a deceleration threshold is `operator = '<='` with a negative
  value on both sides, so the equivalence holds with `parameter_scale = 1`).
- **Parameter fingerprint** (T4, copied to T5; owner decision of 2026-10-12, C32). Computed
  server-side by the T4 INSERT trigger from `source_parameters` only; a client never supplies it.
  Canonical text, version 1: `<parameter_kind>` followed by every key of `source_parameters` as
  `|<key>=<value>` with the keys sorted bytewise ascending (so for `zone_bounds`:
  `lower`, `operator`, `unit`, `upper`; for `event_threshold`: `duration_seconds`, `operator`,
  `threshold_value`, `unit`); a numeric value is rendered through `trim_scale()` in plain decimal
  notation (no exponent, no trailing zeros, so 25 and 25.0 agree); a JSON null (an open top zone's
  `upper`) is rendered as the four characters `null`; a text value (`unit`, `operator`) is rendered
  as its UTF-8 bytes without quotes. The shape CHECK admits no other key, requires `jsonb_typeof`
  `number` for `lower`, `upper` (or `null`), `threshold_value` and `duration_seconds` and `string`
  for `unit` and `operator`, takes `operator` from the closed set of D3, and requires `unit` to be a
  unit token of D3 (1–30 characters, no whitespace, control character, `|` or `=`), so the
  canonical text is unambiguous and nothing else can enter.
  `parameter_fingerprint = 'v1:' || encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex')`
  (`sha256` takes `bytea`; 64 lower-case hex characters after the prefix); `''` for
  `parameter_kind = 'none'`. Two CHECKs hold it in shape: `(parameter_kind = 'none') =
  (parameter_fingerprint = '')` and `parameter_fingerprint = '' or parameter_fingerprint ~
  '^v[0-9]+:[0-9a-f]{64}$'`. The prefix is the canonicalisation version: a change of the rule is
  `v2:`, applied only to new versions, never to a stored row, so an old mapping version keeps the
  fingerprint it was activated with. The fingerprint contains bounds, units and the operator only —
  never an athlete, session, team, club or connection identity, and never a measured value. The
  M2 API computes the same text and hash to show it; the database value is authoritative and a
  test proves the two agree.
- **Database-checkable equivalence.** The T4 INSERT trigger (and the transition to `active`)
  checks `canonical.lower × parameter_scale_divisor = source.lower × parameter_scale +
  parameter_offset × parameter_scale_divisor` (and `upper`, null ↔ null; `value` for a threshold;
  `duration_seconds` equal without conversion) — multiplications only, in exact `numeric`
  arithmetic, so `25.2 × 1 = 7 × 3.6` holds without tolerance and without a division; string-equal
  bound units require `1, 1, 0`; different bound units require an active `unit_conversions` row
  with the same `parameter_scale`, `parameter_scale_divisor` and `parameter_offset`. A direct SQL writer therefore cannot create, let alone activate, a version
  whose bounds are not equivalent.
- **The operator is part of the contract too.** `canonical_parameters` carries `operator`
  (`between` for a closed zone, `>=` for an open top zone, `>`, `>=`, `<` or `<=` for an event
  threshold; a CHECK couples them: `between` ⇒ `upper` not null, any other operator ⇒ `upper`
  null) and the trigger requires it to equal the revision's proven `bound_operator` (D3); a canonical
  `condition_description` whose `operator` differs is refused, so `>` and `>=` are never confused
  silently (`condition_description` is "descriptive" in v10:153, which is why the mapping contract
  pins it here).
- **Scope capabilities under an active mapping.** A `BEFORE DELETE` guard on
  `metric_definition_scope_capabilities` refuses to remove a level while an active T4 version
  applies to it (the v3 guard, :62-83, protects only a level with history); the order is disable
  the version first, then remove the level.
- **The bound of a zone is part of the meaning of the canonical variable**, so each zone is its own
  canonical definition (system or club) with the bound in `condition_description`, e.g. a sprint
  distance variable with `{"operator": ">=", "value": 25.2, "unit": "km/h"}` and value unit `m`;
  the mapping version towards it carries `{lower: 7, upper: null, unit: "m/s"}`. Metrics Core has
  no parameterized variable (one value per occasion and definition), so this is the only shape the
  existing model supports without a change.
- **The real threshold set stays a snapshot on the event** (`metric_event_source_bindings`, v20).
  At import the mapper does what `zoneDistance` and `eventCount` do today, with the bounds and
  thresholds taken from the version instead of the code: both bounds in the team's threshold set
  valid on the session date, no intermediate threshold, a zone with exactly those `extremes`; the
  answer's threshold value and duration equal to the version's.
- **A mismatch with the approved threshold contract blocks the candidate**
  (`source_threshold_contract_mismatch`): it is a property of the session, not of one athlete; the
  remedy is a new version with new bounds, or a correction in GPEXE. `zones_not_ready` and
  `zone_distance_missing` are a missing value of one athlete (section F).
- A change of the team's thresholds never reinterprets a historical fact: T6 points to the version
  with its bounds, the event to its snapshot.

---

## F. Required / optional and the fail-closed table

| Case | Behaviour | Visibility |
|---|---|---|
| Source field without a T2a identity | Never stored (the projection already drops it); never a canonical definition; only a sanitized count per session | Admin: count; coach: nothing |
| Known source metric without an open activation on this binding | Not imported; the candidate may be actionable | Admin: the source labels; coach: a count |
| Athlete not linked, not an active member, more than one track, invalid statistics, more than one whole-session row | The existing rules and codes unchanged: `athlete_not_linked`, `athlete_not_in_team`, `multiple_tracks`, `stats_invalid`, `whole_session_row_count`, `identities_missing_from_source` | As today |
| `required` activation, value missing for any athlete the existing rules admit to the import, on any level the activation covers | **The whole candidate is `blocked`, `required_value_missing`**; no partial import of the other athletes; never a zero | The detail names the athletes (by their OptiMove identity) and the level |
| `optional` activation, value missing | The value is left out with its reason ("Left out", never a zero); the candidate stays actionable if nothing else blocks it | As today's skip entries |
| Unit in the answer differs from the revision / version (`unit_value_object.unit`, threshold units) | **Whole candidate `blocked`, `source_unit_mismatch`**, also for `optional` | Blocked |
| Value shape differs from the revision | **Whole candidate `blocked`, `source_shape_mismatch`** | Blocked |
| Team zone or threshold differs from the version's `source_parameters` | **Whole candidate `blocked`, `source_threshold_contract_mismatch`** | Blocked |
| Activation ended, mapping version `disabled`, source revision `retired`, or binding ended after the preview | The preview hash includes the set of `(activation_id, mapping_version_id)`; approve recomputes → `409 preview_changed`; the next check → `blocked`, `mapping_not_usable` | Blocked |
| No value would be written for any athlete | `nothing_to_import`, **never Ready** | Shown as the reason |
| Re-run of the same session | The identity `(connection, external_id)` and the content hash (now including the mapping version, source value and unit) decide: identical → `unchanged`; a new mapping version → `needs_review` with `changesToImported`, never a silent supersede; the same `requestKey` never writes twice | As today |
| Two sources for the same athlete and event | Two events under two v11 connections, two facts; `metric_values` `unique (occasion_id, metric_definition_id)` refuses a duplicate inside one occasion; `resolveFactsToRows` reports a conflict and never sums; no winner is chosen | Conflict shown in dashboards |

No unknown metric ever creates a canonical definition (an architecture test in the B7 style refuses
any INSERT into `metric_definitions` from the importer modules, M4). The writer never writes a zero
and never a value without a T6 row.

**Audience of every refusal code of this section** (`mapping_not_usable`,
`source_threshold_contract_mismatch`, `source_unit_mismatch`, `source_shape_mismatch`,
`required_value_missing`, `nothing_to_import`, `source_instance_held`,
`session_imported_under_another_instance`, `source_metric_target_taken`): the F3c2g rule — the
precise code reaches a platform admin and the owning club's admin; a coach gets the stable sentence
to contact an administrator; no refusal ever names another team, club, connection, instance or
holder.

**Where today's mapper skip codes land in this table** (`gpexeImportMapper.js:64-74`, `:102-109`,
`:111-118`, `:125-178`): session-level threshold contract — `team_threshold_missing`,
`team_threshold_split`, `threshold_mismatch`, `duration_mismatch`, `zone_boundary_missing`,
`zone_boundary_ambiguous` (the zone extremes follow the team's threshold set, so a missing or
doubled zone is a property of the session, as section E says) → `source_threshold_contract_mismatch`
(whole candidate); shape — `unexpected_unit` → `source_unit_mismatch` (whole candidate); a missing
value of one athlete — `zones_missing`, `zones_not_ready`, `zone_distance_missing`,
`events_missing`, `count_missing`, `details_not_fetched`, `field_missing`, `value_missing`,
`total_time_missing`, `total_distance_missing`, `max_v_missing` → `required_value_missing` (whole
candidate) under a `required` activation, a "Left out" entry under an `optional` one.

---

## G. Roles

- **Platform admin** (platform workspace or the club's workspace for support): system canonical
  definitions; the source metric catalog (T2a / T2b), unit and meaning confirmations;
  `unit_conversions`; T3 / T4 for system and club mappings and every status transition except a
  club admin's own `draft → needs_review` (the platform admin alone activates and disables); T5
  activation and ending; the action "activate for every active binding of this connection" (N
  explicit rows, each audited, never a future binding); ending a held source instance (D9). When a
  system mapping and a club mapping of the same source field and parameters both exist, the
  platform admin chooses explicitly, at activation, which one a given binding uses (the T5
  uniques admit only one of them per binding). The database verifies the acting user of every
  activation, disabling and ending as an active platform admin (D6, D7), not only the basis label.
- **Club admin** (own club workspace): creates and versions club canonical definitions through the
  existing Metrics Core API; creates a T3 identity and T4 draft for a club variable and submits it
  (`draft → needs_review`, `submitted_basis = 'club_admin'`), including a mapping of a source field
  and parameters that a system mapping or another club's mapping already uses, towards the club's
  own variable (the per-owner uniques of D6); reads system T2a / T2b / T3 / T4 and
  the T5 state of the club's own bindings — M2 returns those rows without the acting users' ids
  (`created_by`, `activated_by`, `disabled_by`, `ended_by` of platform admins), so an id without a
  reason is never shown. **Does not activate, disable or end an activation** in
  the first scope: the `*_basis` CHECKs allow `platform_admin` only, and the T4 / T5 triggers verify
  that the acting user is an active platform admin (D6, D7), so the rule holds against direct SQL
  as well.
- **Coach**: nothing in the mapping flow — no source metric, mapping, version or activation, and no
  canonical definition as a mapping target. The existing catalog API still lets a coach create
  `team`- and `user`-owned definitions (A6); those are not mapping targets. The Imports screen keeps
  its stable sentences.
- Any widening of rights needs a separate owner decision, a migration of the CHECKs and a contract
  change. Everyone else — a coach, an athlete, a team workspace, another club, the wrong workspace,
  an archived club or team, a revoked role — gets the identical 404 of the M2 routes (ADR-006),
  with stable codes only and never a trigger's text.

---

## H. UI goal (M3)

Three administrator views - since C80 in **Training Load → Data configuration → Variables & mappings**
(the tabs Variables, Source fields and Mappings), not in Settings:

- **Variables** — the write UI over the canonical-variable admin API of M3-0 (J3, C81; never the older
  `/api/training-load/metrics` write routes): create a canonical variable (name, short name, description,
  numeric, a canonical unit token, minimum and maximum, the session and drill levels, the daily
  aggregation, a zone or threshold condition) and a new semantic version; archived variables read-only;
  in a club workspace the system variables as a read-only reference (C88). Not a new registry.
- **Source metrics** — source system and API family, field key and label, revisions with expected
  and proven units, value shape, session / drill scope, evidence status and references, unit and
  meaning confirmation.
- **Mappings / activations** — choose an existing OptiMove variable, show the source and canonical
  units, scale / offset, parameters for zones and thresholds, scope, Draft / Needs review / Active /
  Disabled, activation per binding with `required` / `optional` (platform admin only, section G), the
  aggregate preview over a saved candidate (no raw answer, no row per athlete; allowed only to a
  caller who may see the candidate's team — a platform admin, or the club's admin in that club's
  workspace — and, for a club mapping, only over a candidate of the mapping's own club, otherwise
  the identical 404, decided before `snapshot_expired` is answered; min and max only from a minimum
  count of athletes, section K), history and audit. Every free-text field of these views carries
  the sentence that no athlete name, id, date of birth or value is entered.

Every control follows the existing mobile rules (`.claude/rules/frontend.md`): 44 px targets,
16 px inputs, checked at 360 / 375 / 390 px.

---

## I. Multiple tracks

Today's behaviour is in section B. Why no automatic merge is acceptable: duration and distance may
be summed only when the tracks do not overlap in time, which the bundle does not tell; top speed is
semantically a maximum, but only it; burst / brake and acceleration counts sum only for disjoint
tracks; zone distances likewise; drill rows come per track and the drill index need not agree;
time-weighting needs a duration per track the bundle does not carry; keeping both as separate
records breaks "one whole-session row per athlete" and creates a dashboard conflict.

Decision: the status quo stays (the athlete is not imported, `needs_manual_review`, the existing
codes). A future **M5** may offer a manual choice of one track with an audit and an observation for
the rejected track, only on a new owner decision. No automation.

---

## J. Plan M1–M6

| PR | Scope | Explicitly not changed | Review triggers | Reviewers | Acceptance criteria | Production gates |
|---|---|---|---|---|---|---|
| **M1 schema foundation** — merged and deployed (PR #159, `15efd7a`; v34, `backend/tests/source-metric-mapping-m1.test.mjs`; v34 confirmed on production by the owner's read-only post-check) | Migration: D1 `api_family`, T2a, T2b, T3, `unit_conversions`, T4, T5, T6, T7, T8, `unique (id, team_id)` on `source_team_bindings`, the `metric_definitions` guard; the D12 seed; rollback script (refuses once any T3–T6 row exists, once T2a / T2b / `unit_conversions` differ from the seed, or under a later migration); tests on a disposable database (apply / rollback; every trigger, CHECK and partial unique with a mutation that the test kills; two concurrent activations; the equivalence trigger with equal and different bound units; T6 consistency); the undo script extended to delete T6 first (disposable only); every new trigger raises a fixed message without an id; the identity triggers of D6 / D7 (active platform admin, `42501`); the shape CHECK of every `evidence_ref` and the bounded single-line CHECK of every free-text column | The importer, routes, frontend, the v33 flow, `GPEXE_IMPORT_APPLY_ENABLED`, every persistent database | 1 (migration, rollback), 2 (`owner_scope` in triggers), 4 (lock order, idempotency) | `db-reviewer`, `security-reviewer`, `code-reviewer`; external review by the owner | No active mapping after the migration; `api_family` equals `sourceHosts.js`; rollback rehearsed; the identity triggers refuse a non-platform-admin actor with `42501`; the shape CHECKs refuse a space or a control character; a T4 row whose `owner_key` differs from its T3 row is refused (system rows included), and the generated T3 `owner_key` is proven to work as an FK target and to drop cleanly in the rollback; the T6 check accepts exactly the round-half-away-from-zero value at 9 decimals and refuses its other neighbour in a tie; the fingerprint of a fixed parameter set equals a value computed independently; the server version of the local and the deployed database is PostgreSQL 13 or later (`scale()`, `trim_scale()`) before the migration relies on it; existing Metrics Core and GPEXE suites pass under the T1 runner | The migration reaches the deployed database only through a merge and deploy the owner orders (`.claude/rules/database-safety.md`); no data beyond the seed; the local OPTIMOVE database only on a separate order |
| **M2 admin API** | Routes under `/api/training-load/sources/metrics…` for T2a / T2b (list, create, revise, verify unit, verify meaning, activate / retire a revision), T3 / T4 (create, version, transitions, replacement), T5 (activate, end, "every active binding of this connection"), `unit_conversions`, T8 reads; `requestKey` on every write; the aggregate preview over a saved candidate (count of athletes with a value, min, max, units before and after; `snapshot_expired` when the raw snapshot is purged); the extractor registry keyed by `source_metric_key` (`source_metric_unsupported` otherwise); the lock order and the bounded transactions of D3 / D6; ownership and the active workspace resolved in the service before any trigger; stable codes only, a transition conflict `409`; the preview's authorization (H); the platform-admin operation that ends a held source instance (D9) | The importer, the UI, migrations | 2 (auth, info hiding), 4 (transactions, idempotency) | `code-reviewer`, `security-reviewer`; external review | Secret scan of every response and audit row; info-hiding tests per role and workspace; a test that no response carries a trigger's text or an SQLSTATE; a replay re-checks the caller's right; the preview never returns `raw_bundle` or a row per athlete and answers the identical 404 before `snapshot_expired` to a caller outside the candidate's club; every transition audited | None (no production data changes without an admin acting) |
| **M3 frontend** | The three views of section H (Training Load → Data configuration, C80) over the M3-0 admin API (J3) and the M2 routes; rights of section G | Backend, the import | New user flow | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`; browser QA at 1280 / 360 / 375 / 390 px | A canonical variable created through the UI is a Metrics Core row created through the M3-0 admin API; activation is an explicit step whose confirmation names source, mapping version, team and binding | None |
| **M4 GPEXE importer integration** | The mapper reads the open activations of the binding instead of `GPEXE_METRIC_SPECS`; the writer takes `metricDefinitionId` and version from the plan, creates no definition, writes T6 and sets the T7 keys at the first import; content hash and preview hash include the mapping version, source value and unit and the activation set; the preview carries the canonical name and unit plus the source value; helper values of Link athletes and `METRIC_TEXT` move to the source metric keys of the preview; the fail-closed table of section F plus `source_instance_held` (D9); the writer's arithmetic in decimal at the storage scale S = 9 of D8 (half away from zero; the T6 trigger accepts exactly the value this rule produces), never binary floating point; `session_imported_under_another_instance` (D9); the undo script already removes T6 first (done in M1, C47); the B7-style architecture test | The switch, Link, multi-track, the list and drill reads | 1 (persistent write path), 3 (canonical identity), 4; the five-point rule for transactions with an external effect | `code-reviewer`, `security-reviewer`, `db-reviewer`; external review | A characterisation test: the fixture with activated mappings yields the same numbers as today within the preview's existing `1e-9` tolerance (`gpexeImportPreview.js:137`; today's mapper divides in binary floating point, the new writer computes in decimal at the storage scale S = 9); without an activation zero values are imported and nothing is written to `metric_definitions`; the stored candidates turn *changed* exactly once | The switch stays off |
| **M5 multiple tracks** | Only on a new owner decision: a manual choice of one track with audit and observation | Everything else | 3, 4 | `code-reviewer`, `security-reviewer` | Decided with the order | Decided with the order |
| **M6 units, pilot mapping, controlled first import** | Owner-run: gate (2) for `total_time`, `total_distance`, `max_v` on server3; the admin confirms units and meanings with references, creates the system variables, takes the mappings `draft → needs_review → active`, activates them on the First team binding with explicit requirements; one check with the switch off; then the decision on the first controlled import | No code beyond small fixes | 5 (only real evidence counts) | External review by the owner | The preview of a saved candidate shows the converted values in the canonical units | Conditions 1–3, 6 and 7 of `docs/ai/CURRENT_STATE.md` "Separate tasks", a fresh verified backup, the owner's explicit order for the switch and for every approval |

M2 is delivered in parts. **The first M2 PR** (C59) builds the contract of J1; the rest of the M2 row
(the T2b confirmations and revision lifecycle, T4 activate / disable / replacement, T5, `unit_conversions`
maintenance, T8 reads, the aggregate preview, the extractor registry, ending a held instance, the catalog
`500 → 409`) waits for later M2 PRs on the owner's orders.

**M3-0** (decisions C80–C88) adds the canonical-variable admin API and its request record, migration v36
(J3), before the M3 frontend. **M2b** - the T2b unit and meaning confirmations and their database actor
guards - is migration **v37** and comes before the M3 write UI of draft mappings.

### J1. M2 HTTP contract — the first M2 PR (approved by the owner on 2026-10-13; as built)

Router `backend/src/routes/sourceMetrics.js`, service `backend/src/sourceMetricMappingService.js`,
mounted at `/api/training-load/sources/metrics` behind `requireAuth` (before the source connections).
PA = an active platform admin, CA = an active club admin; WS = the active workspace (C60). Every other
caller — and every resource it may not see — gets the identical `404 {"error":"notFound"}`.

| # | Route | Who / WS | Input | Server-derived (never from the client) | Success | Refusals | Reads / writes |
|---|---|---|---|---|---|---|---|
| 1 | `GET /fields` | PA (platform or club WS), CA (own club WS) | query `sourceSystem`, `apiFamily` (optional) | — | `200 {fields:[{id, sourceSystem, apiFamily, key, label, state, revisions:[…]}]}`; order system, family, key (`collate "C"`), revisions by number descending | `400 invalid_query`, `409 result_too_large`, `409 try_again`, `404` | reads T2a, T2b |
| 2 | `GET /targets` | PA platform WS → system; PA / CA club WS X → club X | — | the owner from the WS | `200 {targets:[{id, ownerScope, key, label, truncated, currentVersion:{id, versionNumber, unit, canonicalParameters}, scopes, versionReady, notReadyCode}]}` (`key`, `label`, `truncated`: B3, C86); order `id`; `unit` only when a unit token; `canonicalParameters` the normalized form or null | `409 result_too_large`, `409 try_again`, `404` | reads Metrics Core |
| 3 | `GET /conversions` | as 1 | — | — | `200 {conversions:[{id, fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef}]}`; active rows; order units (`collate "C"`); exact decimal text | `409 result_too_large`, `409 try_again`, `404` | reads `unit_conversions` |
| 4 | `GET /mappings` | platform WS → system; club WS X → system + club X | query `cursor` (optional) | visibility from the WS | `200 {mappings:[{id, ownerScope, sourceMetric:{id, key, apiFamily, label}, metricDefinitionId, target:{key, label, truncated}, createdAt, latestVersion, activeVersionId, versionCounts}], nextCursor}` (the labels: B3, C86): one page of at most 100, order system first, `createdAt`, `id`; `nextCursor` null on the last page (C68) | `400 invalid_query`, `409 try_again`, `404` | reads T3, T4 |
| 5 | `GET /mappings/:mappingId` | as 4 | query `cursor` (optional) | — | `200 {mapping, nextCursor}`: the mapping with one page of at most 50 of its versions (all statuses), by number descending | `400 invalid_query`, `409 try_again`, `404` | reads T3, T4 |
| 6 | `POST /mappings` | PA platform WS → system; PA / CA club WS X → club X | `requestKey`, `sourceMetricId`, `metricDefinitionId` | owner scope, club, `owner_key`, source system, API family, actor, T8 | `201 {mapping, replayed:false}`, `mapping` in the summary shape of row 4 (never the version list); replay or verified COMMIT `200` | `400 invalid_body`, `415 jsonRequired`, `404`, `409 target_scope_mismatch`, `source_metric_retired`, `target_not_active`, `mapping_exists` (+`current.mappingId`), `request_key_reused`, `try_again`, `503 outcome_unknown`, `500 internal_error` | writes T3 + T8 `mapping_create` |
| 7 | `POST /mappings/:mappingId/versions` | the mapping's owner WS only | `requestKey`, `sourceRevisionId`, `appliesToSession`, `appliesToDrill`; `conversionNote` (required when the units differ); `sourceParameters` (`{lower, upper}` or `{thresholdValue, durationSeconds}`, decimal strings) | version number, canonical version (current), both units, factors (`1, 1, 0` or the one active row in the D5 normal form), parameter kind, operator, bound unit, canonical parameters, parameter factors, fingerprint (checked against the database), `owner_key`, status `draft`, actor, T8 | `201 {version, replayed:false}`, `version` one version in the shape of row 5; replay or verified COMMIT `200` | `400 invalid_body`, `invalid_parameters`, `conversion_note_required`; `415 jsonRequired`; `404`; `409 revision_not_usable`, `unit_not_proven`, `parameters_not_proven`, `target_not_active`, `canonical_not_numeric`, `canonical_unit_missing`, `canonical_unit_not_a_token`, `conversion_unavailable`, `conversion_not_normal`, `bound_conversion_unavailable`, `condition_description_unsupported`, `parameters_not_equivalent`, `level_not_allowed`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` | writes T4 + T8 `mapping_version_create` |
| 8 | `POST /mappings/:mappingId/versions/:versionId/submit` | as 7 (CA only its own club's mapping) | `requestKey` | `submitted_by`, `submitted_at`, `submitted_basis` (from the role), T8 | `200 {version, replayed}` | `400 invalid_body`, `415 jsonRequired`, `404`, `409 version_not_draft` (+`current.status`), `revision_not_usable`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` | writes T4 status + T8 `mapping_status` |

- **Lock order of a write** (C57 order, section D): the per-user advisory lock (bounded, 5 s) → the
  request record lookup → active `unit_conversions` rows `FOR SHARE` (value pair, then bound pair,
  ascending id) → T2a / T2b `FOR SHARE` → T3 (`FOR NO KEY UPDATE` for a version, serializing its
  number; `FOR SHARE` for a submit) → T4 `FOR UPDATE` (submit) → `metric_definitions` `FOR SHARE` (its
  current version re-checked) → its scope capability rows `FOR SHARE` (the levels re-checked; a version
  create) → role, user and club `FOR SHARE` → the row, its T8 request record → the bounded COMMIT. A
  version create compares the T2b facts it used again under their lock (C71). `statement_timeout` 10 s, `lock_timeout` 2 s on rows; `55P03`, `40P01`, `57014` →
  `409 try_again` (logged by SQLSTATE only).
- **Answers of a write** never go through a page: a mapping write answers (and replays) the bounded
  summary of row 4, a version write and a submit one version, each re-read only when the active
  workspace may write that mapping (its `owner_key`). After the COMMIT the right, the user and the club
  are checked again first, on a new bounded connection (C69): a right lost is the identical 404 with
  nothing of the resource; a check or a read that fails or runs past its bound keeps the status (`201` /
  `200`) with `{readError: true, replayed: false}`, plus `mappingId` / `versionId` of what was written
  only once the right was confirmed again.
- **Pages** (C68): the cursor is the base64url of a small JSON object, opaque to a client; the server
  accepts exactly its keys, its version, its kind, the workspace's owner key (and the mapping) it was
  issued for and a well-formed position (a real instant, not before 2000), or answers `400 invalid_query`; a query parameter other than
  one `cursor` is `400 invalid_query` too. Keyset on (system first, `created_at`, `id`) and on the
  version number.
- **Every read is bounded** (C70): REPEATABLE READ READ ONLY (READ COMMITTED when it holds the right's
  `FOR SHARE` locks), `statement_timeout` 5 s and `lock_timeout` 2 s on the server, 8 s on the client for
  the whole read; past the client bound the connection is closed. The access check of a club workspace,
  every GET, the name of an existing mapping and the answer after a COMMIT all read this way.
- **Every answer of the router** (a `404` and a refusal included) carries `Cache-Control: no-store`;
  a POST without a JSON body is `415 jsonRequired`.
- **The database allowlist:** `23505 source_metric_mappings_pair_key` → `mapping_exists`; `23505
  source_metric_mapping_versions_number_key` and `source_metric_audit_one_request_per_key` → `try_again`;
  `42501` → the 404 only when its message is exactly one of the three v34 actor refusals (C72; logged by
  its code only), any other `42501` is a `500`; `23514` only when the message is exactly one of the fixed v34 trigger texts the
  service lists (each to its code). Everything else is `500 internal_error`; only the code and the
  route template are logged.
- **Tests:** `backend/tests/source-metric-mapping-m2.test.mjs` (disposable database, the real HTTP stack);
  mutation evidence for the authorization, scope, conversion, idempotency and transaction guards.

### J2. v35 — the database actor guards (as built)

Migration `migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql`, rollback
`docs/runbooks/source-metric-mapping-v35-rollback.sql`, tests `backend/tests/source-metric-mapping-v35.test.mjs`.
Functions, triggers and two partial indexes, no table, column or data; v34's own functions are not changed
and run first (trigger order is by name).

| Table and event | v35 guard (BEFORE unless deferred) | Refusal |
|---|---|---|
| any guarded write | `source_metric_context_actor()`: the setting is `<lowercase uuid>:<pg_current_xact_id()>` | `42501` no acting user |
| T3 INSERT | `created_by_user_id` = actor; system: an active platform admin; club: an active platform admin of an active club, or that active club's active admin | `42501` |
| T4 INSERT | `created_by_user_id` = actor; the actor may write the mapping's owner scope | `42501` |
| T4 UPDATE of status or an actor column | the transition's `submitted_by` / `activated_by` / `disabled_by` = actor; its basis = the derived basis | `42501` |
| T8 INSERT | `performed_by_user_id` = actor; mapping actions: owner scope and derived basis, the named mapping (`mapping_create`) or version (other actions) written by this transaction with the matching user / status / basis, once; other actions: an active platform admin | `42501` / `23514` |
| T3 INSERT, deferred | a `mapping_create` row for it | `23514` at COMMIT |
| T4 INSERT, deferred | a `mapping_version_create` row for it | `23514` at COMMIT |
| T4 UPDATE of status or an actor column, deferred | a `mapping_status` / `mapping_version_replaced` row with the same from / to status | `23514` at COMMIT |

- **The derived basis** (`source_metric_actor_basis`): an active platform admin (role and user active)
  is `platform_admin` - for a club mapping only while the club is active; otherwise the active admin of
  the mapping's active club is `club_admin`; otherwise none. A platform admin who also holds the club
  admin role is `platform_admin`, as in M2. Consequence for later writers: while a club is archived no
  one - not even a platform admin - writes a version transition or an audit row of its mappings (a
  disable or a clean-up included); whether a disable should ignore club activity is an M3 decision (K).
- **Lock order:** the v34 guard of each table first; then the mapping row `FOR SHARE` (M2 already holds
  it: `FOR NO KEY UPDATE` for a version, `FOR SHARE` for a submission, its own new row for a create);
  then the acting user's role and user rows and the club row `FOR SHARE` - the rows and the order of M2's
  own right re-check. A revocation waits for a write that holds them, and a write waits for a revocation
  in flight and is then refused. A version create and a submission of the same mapping serialize on the
  mapping row without a deadlock.
- **M2:** `ACTOR_CONTEXT_SQL` in `runWrite` before the operation; `commitCertainlyRefused` classifies a
  COMMIT error as a definite refusal only when PostgreSQL itself raised an ordinary ERROR (C79), else it
  is verified by the request key; `rightsStillHold` answers `try_again` for a club admin who has become
  an active platform admin before its check (a later grant: v35's sanitized `500`, C79). Two partial
  indexes serve the audit lookups
  (`source_metric_audit_v35_mapping_create_idx`, `source_metric_audit_v35_version_idx`).
- **Production preflight** (read-only, for the owner, run block by block):
  `docs/runbooks/source-metric-mapping-v35-preflight.sql`; **production post-check**
  `docs/runbooks/source-metric-mapping-v35-postcheck.sql` (run by the owner on 2026-10-14 after the
  deploy of `ed13f8a`: all eight blocks as expected).

### J3. M3-0 — the canonical-variable admin API and its request record v36 (as built)

Service `backend/src/canonicalVariableAdminService.js` (it shares M2's write and read machinery,
`adminWriteKit` of `sourceMetricMappingService.js` - one runWrite with a pluggable request store, one
bounded read, one right re-check), routes in `backend/src/routes/sourceMetrics.js`, migration
`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql`, rollback
`docs/runbooks/metric-variable-requests-v36-rollback.sql`, preflight
`docs/runbooks/metric-variable-requests-v36-preflight.sql`, tests `backend/tests/metric-variables-m3-0.test.mjs`.
Access, `401`, the identical `404 {"error":"notFound"}`, `Cache-Control: no-store`, `415 jsonRequired` and
`Retry-After: 5` on `try_again` are J1's.

| # | Route | Input | Server-derived | Success | Refusals |
|---|---|---|---|---|---|
| V1 | `GET /variables` | query `scope` (`own`, default, or `system`: in a club workspace the system variables as a read-only reference), `state` (`active`, default, `archived`, `all`), `cursor` | visibility from the workspace | `200 {variables:[variable], nextCursor}`: a page of at most 100 in (`created_at`, `id`) order; the cursor bound to owner key, scope and state | `400 invalid_query`, `409 try_again` |
| V2 | `GET /variables/key-suggestion` | query `label` | the key (C84) | `200 {key, taken}` (`taken`: the workspace's owner already holds it, in any state) | `400 invalid_query`, `400 key_required` |
| V3 | `GET /variables/:id` | query `cursor` | - | `200 {variable, nextCursor}`, the variable with `versions` (a page of 50 by number descending, `current` and `reason` per version); own, or the system reference in a club workspace | `404`, `400 invalid_query` |
| V4 | `POST /variables` | `requestKey`*, `label`*, `shortLabel`, `description`, `key`, `unit`*, `levels`*, `dailyAggregationMethod`*, `minValue`, `maxValue`, `condition` | owner, actor, basis, `numeric`, `active`, version 1, `current_version_id`, `drill → component`, the key when none is sent, the request record | `201 {variable, replayed:false}`; replay or verified COMMIT `200` | `400 invalid_body`, `invalid_unit`, `invalid_condition`, `key_required`; `404`; `409 key_taken`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |
| V5 | `POST /variables/:id/versions` | `requestKey`*, `expectedCurrentVersionId`*, `unit`*, `dailyAggregationMethod`*, `minValue`, `maxValue`, `condition`, `reason` | the version number, `numeric`, the repoint, actor, basis, the request record; key, owner and levels never change | `201 {variable, version, replayed:false}`; replay or verified COMMIT `200` | `400 invalid_body`, `invalid_unit`, `invalid_condition`; `404`; `409 current_version_changed` (+`current:{versionId, versionNumber}`), `variable_not_active`, `variable_pinned`, `version_unchanged`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |

- **A variable:** `{id, key, label, shortLabel, description, ownerScope, state, editable, levels, currentVersion:{id,
  versionNumber, unit, valueType, dailyAggregationMethod, minValue, maxValue, condition, createdAt}, mappingTarget:{ready,
  notReadyCode}, createdAt, updatedAt, truncated}` - no acting user's id. `condition` is the API's normalized form or
  `{kind:"unsupported"}` for any other stored shape (never the stored JSON). `mappingTarget` is M2's readiness, plus
  `target_not_active` for an archived variable and `target_scope_mismatch` for the system reference in a club workspace.
  A `day` level written by the older API is not shown.
- **A new version replaces the whole semantics** (V5): unit, daily aggregation, minimum, maximum and condition are
  taken as sent; a field left out is cleared, never carried over from the current version, so the M3 frontend sends the
  full semantics. Each version carries its `reason`, also for the system reference read in a club workspace (a
  platform admin's note on a global variable; accepted at the M3-0 security review).
- **Lock order:** a create - the per-user advisory lock (bounded, the M2 key) → the request record → the role, user and
  club rows `FOR SHARE` (the right again) → its own new rows → the request row → the bounded COMMIT. A new version - the
  advisory lock → the request record → `metric_definitions` `FOR UPDATE` (the catalog writers' first lock) → the role,
  user and club rows `FOR SHARE` → the version insert and the repoint (the v34 pin guard) → the request row → the
  COMMIT. The same order as M2 (definition before the right); no new lock edge. A deadlock with another order is answered
  by PostgreSQL and becomes `try_again`.
- **The COMMIT:** M2's rule (C79): a definite refusal only when PostgreSQL itself raised an ordinary ERROR; every other
  COMMIT error is verified by the request record on another connection (`200` with
  `commitConfirmation:"verified_after_commit_error"` or `503 outcome_unknown`). The answer after a COMMIT checks the
  right again on a new bounded connection (a right lost: `404`; a read that fails: `readError` with `variableId`).
- **v36:** one table (checks; foreign keys to the user, the club, the definition and - composite - its version;
  uniques: one per user and request key, one per version, one `variable_create` per definition), its BEFORE INSERT
  guard (the acting user: `42501`; the derived basis: `42501`; the request following its own operation - the definition
  of the row's owner, written by this transaction (for a create, created by the acting user), active, its current
  version the row's version, created by this transaction and this user, version 1 for a create, a later one for a new
  version: `23514`; point-in-time, C82), and append-only triggers (`23514`). Fixed messages. Depends on the v35 functions; the v35 rollback refuses while v36 is recorded. No data
  change.

---

## K. Open, but not blocking M1

Decisions that may safely wait, with the PR that takes them:

- the exact UI sentences for the new codes (M3);
- the format of `evidence_ref` — decided for the database in M1 (C40); M2 only adds its API checks;
- `unit_conversions` rows beyond the four seeded (M2 API);
- the fields of the aggregate preview (M2);
- the UI shape of the action over every active binding of a connection (M3);
- names, descriptions, units, domains and `condition_description` values of the first system
  variables, the zones included (M3 / M6);
- which activations are `required` in the pilot (M6);
- the evidence that closes `unit_evidence_ref` and `meaning_evidence_ref` for server3 (M6, gate 2);
- the throttle of the M2 routes (M2); their read and write bounds are decided (C70, J1);
- the test-runner kind of the M1 suites — `disposable`, through the T1 runner (as built);
- whether a system-owned zone or threshold mapping may show one team's bounds to every club admin,
  or such mappings are club-owned (the M1 schema supports both; the bounds are not personal data)
  (M2 / M3);
- the minimum count of athletes below which the aggregate preview returns the count only, without
  min and max (M2);
- decided (C81, C82): the existing Metrics Core catalog API stays as it is for its current callers (its
  `403` for a foreign club or team, the forwarded `P0001` text, coach-created `team` / `user` definitions,
  A6); the M3 frontend writes canonical variables only through the M3-0 admin API (J3);
- the shape of the platform-admin operation that ends a held source instance (D9) (M2);
- **the mandatory gate of C73 is built in v35 (J2, C74–C79)**, merged and deployed (PR #161) and
  confirmed by the owner's production post-check;
- a v35 / v36 test-hardening task (owner, 2026-10-14): a regression test that one SQL statement - a
  multi-row `VALUES`, `INSERT … SELECT`, data-modifying CTEs, a CTE with a main `INSERT` - never writes
  two audit rows for one operation (a one-off probe refused all four with `23514`; the version and
  status rows were not probed);
- separate migration and runtime database roles, so that the v35 guards also hold against the
  application's own credentials (C74; an infrastructure task, recorded in CURRENT_STATE);
- for M3, from the v35 reviews: the audit row of a transition does not cross-check its `reason` or its
  time with the version's `disable_reason` and `*_at` columns (the M3 route derives one from the other,
  or the M3 guard adds the check); the one-audit-row rule per (version, target status) assumes v34's
  forward-only status machine (a future "back to draft" needs a new rule); and whether a platform
  admin's disable should ignore an archived club (J2);
- the shared session and workspace reads every route runs before M2's own code (`requireAuth`,
  `resolveActiveWorkspace`) use the general pool without a statement bound (the pool checkout is
  bounded): an app-wide matter, outside the M2 routes;
- the access helpers of the M2 service (`resolveMappingAdmin`, `rightsStillHold`) move to their own
  module before T5 reuses them (M2);
- whether a later conversion that the M1 normal form cannot represent (a factor whose value and
  reciprocal both do not terminate, or a non-terminating offset such as °F → °C) is ever needed;
  widening the representation is then a separate owner decision (not needed by the pilot).

Everything in sections C to G is decided and is not reopened by this list.

**Raised by the internal reviews of M1 (2026-10-12) and decided by the owner the same day (C51–C55,
section C), built in v34:** the ownership freeze of a mapped canonical definition (security F2,
database L-2 → C51); the conversion gate re-checked under a lock at activation (database M-1, security
F5 → C52); the invisible and bidi characters in every free-text column (security F6, database L-1 →
C53); positive scales (database L-5 → C54); the further T6 checks (security F4, database L-4 → C55).
Nothing of this list is open any more.

**Carried into later PRs by the M1 reviews:** the PR that introduces an active mapping version (a
later M2 PR, C59) maps the two `metric_definitions` / scope-capability guard refusals (`23514`, no
constraint name) to a stable `409` in `backend/src/routes/trainingLoadMetrics.js` (`respondToWriteError`
maps only `P0001` and `23505` today, so from the first active mapping version an archive, a new
semantic version or a level removal of a pinned variable would answer `500`); M2 maps every native
error by constraint name and never forwards its DETAIL, and maps `40P01` to `try_again` (done in the
first M2 PR, J1); M2 pre-locks the `unit_conversions` rows it relies on, then T2b → T3 → T4, before a
transition (done for the version create and the submit, J1); indexes on the M1 foreign keys come with
the M2 / M3 readers (the first M2 PR's reads use the existing primary keys and partial indexes; no
index was added); the M4 writer checks the C55 conditions before it writes (its stable codes), the T6
trigger being the backstop, and follows the lock contract C57 (event and identities before the first
T6 row, one importing transaction per team); no existing route changes a definition's owner, and one
that ever does maps the C51 refusal to a stable `409`; M2 maps `canonical_unit_not_a_token` (C56) to a
stable code.

### K2. Review history — points raised by the internal reviews and decided by the owner

The internal reviews of 2026-10-12 (code, database, security) raised the eight points below; the
owner's external review of PR #156 decided each of them on 2026-10-12 (decisions C32–C39, written
into sections D to G). Nothing here is open any more. M1 (ordered on 2026-10-12) builds them as
schema in migration v34, merged as PR #159; the code that uses them is M2–M4.

1. **Parameter fingerprint on T4 / T5** (D6, D7): one source field may feed several canonical zone
   variables, one per distinct bound set, so the "one active canonical target per source metric"
   uniques are scoped by `(field, parameters)`. Without it the three power zones of
   `more.complementary_data.power.distance` could never all be active. Decided: accepted (C32).
2. **Global or per-owner active-target unique** (D6): the review's default was the owner's literal
   rule (global across system and every club). Decided: **per owner** (C33) — one partial unique
   index `(field, fingerprint, owner_key) where status = 'active'` over a checked, non-null owner key
   on T4 (`'system'` for the system scope, the club id for a club; the final re-check showed that a
   copy of the nullable `owner_club_id` would leave system rows unchecked under `MATCH SIMPLE`), the
   T5 per-binding uniques for exclusivity, and an explicit
   platform-admin choice when a system and a club mapping coexist.
3. **`scale_divisor`** (D5, D6, E, C12): the factor is kept as an exact rational (scale, divisor,
   offset) so that 1/60 and 1/3.6 are exact and the bound equivalence needs no division. Decided:
   accepted (C34), with normalized factors and no binary floating point in the writer.
4. **Team-owned connections and club mappings** (D7): refused in M1, because the v27 team-move
   guard protects only club-owned connections. Decided: refused in M1 / M2 (C35); a widening is a
   separate owner decision.
5. **The source-instance unique** (D9): partial (`active` only) plus the writer's
   `session_imported_under_another_instance` refusal, against an unconditional unique that would
   bind a source team to its first OptiMove team forever. Decided: accepted (C36) — partial plus the refusal;
   the platform-admin "end instance" operation belongs to M2 and deletes nothing.
6. **ADR-007 and the ADR policy**: `docs/decisions/README.md` admits only implemented decisions,
   and the first draft of ADR-007 carried two accepted but unimplemented decisions. Decided: no
   exception (C37) — ADR-007 is narrowed to the three decisions the code proves (registry, no
   merge, no reinterpretation), with status `Active`; the mapping decisions stay in this document
   as accepted future design until M1–M4 are merged.
7. **`bound_operator` on the source revision** (D3, E): the operator (`between`, `>=`, `>`, `<=`, `<`) is a
   proven fact of the source contract, NULL until verified with the meaning, and the canonical
   `condition_description.operator` must equal it. Decided: accepted (C38); a changed operator is a
   new revision.
8. **Storage scale S = 9** (D8, J M4): every imported value is stored rounded to 9 decimals (half
   away from zero) and the T6 trigger checks the arithmetic at that scale with multiplications
   only; `rounding_decimals` (C25) stays an unused presentation field. Decided: accepted (C39).
