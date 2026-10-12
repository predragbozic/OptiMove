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
| Last verified against commit | `af11338` |
| Status | **Accepted architecture; M1 not started** |
| Owner acceptance | 2026-10-11, in three rounds (direction B; the corrected contract; the final consolidation), all recorded in section C; 2026-10-12, the owner's external review of PR #156 decided the eight review-raised points (C32–C39; review history in K2) |

**Which changes require a targeted re-verification of this document** (not a repeat of the whole
discovery): any change to `migrations_v2/` files v10–v13 (`2026090414*`–`2026090417*`), the
training_activity v3 / v4 files (`202609071200`, `202609071300`), the dashboard files v15–v18
(`2026091009*`–`2026091012*`), v20 (`202609171800`), v22–v24 (GPEXE import), v27–v33 (source
connections, identities, check finalization); any change to `backend/src/gpexeImportMapper.js`,
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
only in the check-row INSERT (:890). The check row carries `source_connection_id`,
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

1. A check (`backend/src/gpexeImportService.js` `startCheck` :789) reads GPEXE through the bound
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
  are duplicated in `SOURCE_ATHLETE_VALUE_KEYS` (`gpexeImportService.js:1419`), `LINK_CONTEXT_KEYS`
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
    `scale_divisor > 0`, every factor finite (no NaN, no infinity), identity as `1, 1, 0`, factors normalized where possible, no
    binary floating-point arithmetic in the import writer, every historical mapping version keeps
    its own factors, a retired `unit_conversions` row changes no history — still a linear numeric
    conversion, not a new kind of formula.
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

---

## D. Accepted future model — **Accepted design, not yet implemented**

Nothing in this section exists in the repository at `af11338`. **Lock order for every writer**
(admin and importer): `unit_conversions` → T2a → T2b → T3 → T4 → `metric_definitions` (the
canonical row, `FOR SHARE`) → T5 → the acting user's `user_global_roles`, `user_club_roles`,
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

### D1. `source_host_catalog.api_family` (extension of v27)

`api_family text not null check (in ('api','rest_v1'))`, backfilled `e03 → api`,
`server3 → rest_v1`, immutable afterwards (extension of `source_host_catalog_immutable`,
`migrations_v2/202609271000_training_load_v27_source_credential_connections.sql:97`). A test
compares the column with `SOURCE_HOSTS[*].apiFamily` in `backend/src/sourceHosts.js:49-58`; the code
stays the authority and the database must agree. Without it the database cannot refuse an
activation of a contract proven on `rest_v1` for an `api` host. The v28 rollback script's row
comparison is to be checked in M1.

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
  `supports_session`, `supports_drill` (at least one); `expected_source_unit`, `unit_note`
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
- Columns: `id`; `from_unit`, `to_unit` (1–30, different); `scale numeric` (`<> 0`, finite);
  `scale_divisor numeric` (`> 0`, finite); `offset numeric` (finite) — "finite" is a CHECK that
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
  exact tuple match against the single active row of the pair. The import writer never computes in
  binary floating point (D8, J M4).
- Uniqueness: `unique (from_unit, to_unit) where state = 'active'`.
- Maintained by a platform admin through M2 (T8 `unit_conversion_create` / `_retire`) or by a data
  migration. Rows are immutable; a correction is `retired` plus a new row. A T4 version keeps **its
  own copies** of the factors, so retiring a row changes no existing version and no fact; the table
  only gates new versions. Identity pairs need no row: the trigger accepts `1, 1, 0` when the units are
  string-equal.
- Seed (M1), as (scale, scale_divisor, offset): `s → min (1, 60, 0)`, `m/s → km/h (3.6, 1, 0)`,
  `m → km (0.001, 1, 0)`, `km/h → m/s (1, 3.6, 0)`.

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
  `conversion_kind` in `numeric_linear` (M1); `scale` (`<> 0`, finite), `scale_divisor` (`> 0`,
  finite), `offset` (finite), `check (scale = 1 or scale_divisor = 1)`, `rounding_decimals` (null or 0–6, a presentation field unused in the pilot; the
  storage scale of an imported value is the fixed S = 9 decimals of D8, not this column); `source_unit`, `target_unit` (copies,
  checked against the revision and the canonical version); `conversion_note` (bounded single-line text, 1–500; required when the
  units differ); `parameter_kind` (copy of the revision); `source_parameters jsonb`,
  `canonical_parameters jsonb` (flat objects, no secret-named key, see section E);
  `parameter_fingerprint text not null` (computed by the INSERT trigger, never taken from the
  caller; `''` for `parameter_kind = 'none'`, otherwise `v1:` plus the SHA-256 hex of the canonical
  parameter text defined in section E, "Parameter fingerprint"; it lets one source field feed
  several canonical zone variables, one per distinct bound set, and carries no athlete, session or
  team identity);
  `parameter_scale` (`<> 0`, finite), `parameter_scale_divisor` (`> 0`, finite),
  `parameter_offset` (finite), `check (parameter_scale = 1 or parameter_scale_divisor = 1)`;
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
  owner is `409 source_metric_target_taken`; it names only the caller's own owner scope.
- INSERT trigger (fail-closed, also for direct SQL): the revision is `draft` or `active` with
  `source_unit not null`; `source_unit` equals the revision; the pinned canonical version is
  `numeric` and its `unit` is not NULL and 1–30 characters (`metric_definition_versions.unit` is
  nullable free text, v10:143 — a version without a unit is not a mapping target,
  `canonical_unit_missing`), and `target_unit` equals it; `parameter_fingerprint` is computed by
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
  the trigger requires `scale(value_numeric) <= 9` **and** (`abs(d) < h` **or** (`abs(d) = h` and
  `sign(d) = sign(n)`)). The first condition puts the value on the 9-decimal grid; `abs(d) < h`
  picks the unique nearest grid value; the tie case `abs(d) = h` admits only the neighbour away from
  zero. All of it is exact `numeric` arithmetic (`scale()` and `trim_scale()` need PostgreSQL 13 or
  later, which J M1 verifies on the local and the deployed server before relying on them). Exact
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
  The undo script's `PROTECTED_TRIGGERS` list (`backend/scripts/gpexe-undo-imported-session.mjs:84`)
  gains T6's triggers in M4, otherwise "delete T6 first" cannot run.
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
actor and no seed marker.

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
  for `unit` and `operator`, takes `operator` from the closed set of D3, and refuses `|`, `=` and
  control characters in `unit`, so the canonical text is unambiguous and nothing else can enter.
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

Three administrator views in Settings:

- **Variables** — the first write UI over the **existing** Metrics Core API
  (`backend/src/routes/trainingLoadMetrics.js`): create a canonical definition (name, short name,
  description, domain and category through structure links, `numeric|boolean|text`, canonical unit,
  minimum and maximum, `session|component|day` scope, aggregation method), a new semantic version,
  archive without deleting history. Not a new registry.
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
| **M1 schema foundation** | Migration: D1 `api_family`, T2a, T2b, T3, `unit_conversions`, T4, T5, T6, T7, T8, `unique (id, team_id)` on `source_team_bindings`, the `metric_definitions` guard; the D12 seed; rollback script (refuses once any T3–T6 row exists, once T2a / T2b / `unit_conversions` differ from the seed, or under a later migration); tests on a disposable database (apply / rollback; every trigger, CHECK and partial unique with a mutation that the test kills; two concurrent activations; the equivalence trigger with equal and different bound units; T6 consistency); the undo script extended to delete T6 first (disposable only); every new trigger raises a fixed message without an id; the identity triggers of D6 / D7 (active platform admin, `42501`); the shape CHECK of every `evidence_ref` and the bounded single-line CHECK of every free-text column | The importer, routes, frontend, the v33 flow, `GPEXE_IMPORT_APPLY_ENABLED`, every persistent database | 1 (migration, rollback), 2 (`owner_scope` in triggers), 4 (lock order, idempotency) | `db-reviewer`, `security-reviewer`, `code-reviewer`; external review by the owner | No active mapping after the migration; `api_family` equals `sourceHosts.js`; rollback rehearsed; the identity triggers refuse a non-platform-admin actor with `42501`; the shape CHECKs refuse a space or a control character; a T4 row whose `owner_key` differs from its T3 row is refused (system rows included); the T6 check accepts exactly the round-half-away-from-zero value at 9 decimals and refuses its other neighbour in a tie; the fingerprint of a fixed parameter set equals a value computed independently; the server version of the local and the deployed database is PostgreSQL 13 or later (`scale()`, `trim_scale()`) before the migration relies on it; existing Metrics Core and GPEXE suites pass under the T1 runner | The migration reaches the deployed database only through a merge and deploy the owner orders (`.claude/rules/database-safety.md`); no data beyond the seed; the local OPTIMOVE database only on a separate order |
| **M2 admin API** | Routes under `/api/training-load/sources/metrics…` for T2a / T2b (list, create, revise, verify unit, verify meaning, activate / retire a revision), T3 / T4 (create, version, transitions, replacement), T5 (activate, end, "every active binding of this connection"), `unit_conversions`, T8 reads; `requestKey` on every write; the aggregate preview over a saved candidate (count of athletes with a value, min, max, units before and after; `snapshot_expired` when the raw snapshot is purged); the extractor registry keyed by `source_metric_key` (`source_metric_unsupported` otherwise); the lock order and the bounded transactions of D3 / D6; ownership and the active workspace resolved in the service before any trigger; stable codes only, a transition conflict `409`; the preview's authorization (H); the platform-admin operation that ends a held source instance (D9) | The importer, the UI, migrations | 2 (auth, info hiding), 4 (transactions, idempotency) | `code-reviewer`, `security-reviewer`; external review | Secret scan of every response and audit row; info-hiding tests per role and workspace; a test that no response carries a trigger's text or an SQLSTATE; a replay re-checks the caller's right; the preview never returns `raw_bundle` or a row per athlete and answers the identical 404 before `snapshot_expired` to a caller outside the candidate's club; every transition audited | None (no production data changes without an admin acting) |
| **M3 frontend** | The three Settings views of section H over the existing Metrics Core routes and the M2 routes; rights of section G | Backend, the import | New user flow | `code-reviewer`, `mobile-qa`, `ux-design-reviewer`; browser QA at 1280 / 360 / 375 / 390 px | A canonical variable created through the UI is a row created through the existing API; activation is an explicit step whose confirmation names source, mapping version, team and binding | None |
| **M4 GPEXE importer integration** | The mapper reads the open activations of the binding instead of `GPEXE_METRIC_SPECS`; the writer takes `metricDefinitionId` and version from the plan, creates no definition, writes T6 and sets the T7 keys at the first import; content hash and preview hash include the mapping version, source value and unit and the activation set; the preview carries the canonical name and unit plus the source value; helper values of Link athletes and `METRIC_TEXT` move to the source metric keys of the preview; the fail-closed table of section F plus `source_instance_held` (D9); the writer's arithmetic in decimal at the storage scale S = 9 of D8 (half away from zero; the T6 trigger accepts exactly the value this rule produces), never binary floating point; `session_imported_under_another_instance` (D9); the undo script's `PROTECTED_TRIGGERS` gains T6 (disposable only); the B7-style architecture test | The switch, Link, multi-track, the list and drill reads | 1 (persistent write path), 3 (canonical identity), 4; the five-point rule for transactions with an external effect | `code-reviewer`, `security-reviewer`, `db-reviewer`; external review | A characterisation test: the fixture with activated mappings yields the same numbers as today within the preview's existing `1e-9` tolerance (`gpexeImportPreview.js:137`; today's mapper divides in binary floating point, the new writer computes in decimal at the storage scale S = 9); without an activation zero values are imported and nothing is written to `metric_definitions`; the stored candidates turn *changed* exactly once | The switch stays off |
| **M5 multiple tracks** | Only on a new owner decision: a manual choice of one track with audit and observation | Everything else | 3, 4 | `code-reviewer`, `security-reviewer` | Decided with the order | Decided with the order |
| **M6 units, pilot mapping, controlled first import** | Owner-run: gate (2) for `total_time`, `total_distance`, `max_v` on server3; the admin confirms units and meanings with references, creates the system variables, takes the mappings `draft → needs_review → active`, activates them on the First team binding with explicit requirements; one check with the switch off; then the decision on the first controlled import | No code beyond small fixes | 5 (only real evidence counts) | External review by the owner | The preview of a saved candidate shows the converted values in the canonical units | Conditions 1–3, 6 and 7 of `docs/ai/CURRENT_STATE.md` "Separate tasks", a fresh verified backup, the owner's explicit order for the switch and for every approval |

---

## K. Open, but not blocking M1

Decisions that may safely wait, with the PR that takes them:

- the exact UI sentences for the new codes (M3);
- the format of `evidence_ref` (a document path and section; M2);
- `unit_conversions` rows beyond the four seeded (M2 API);
- the fields of the aggregate preview (M2);
- the UI shape of the action over every active binding of a connection (M3);
- names, descriptions, units, domains and `condition_description` values of the first system
  variables, the zones included (M3 / M6);
- which activations are `required` in the pilot (M6);
- the evidence that closes `unit_evidence_ref` and `meaning_evidence_ref` for server3 (M6, gate 2);
- timeout and throttle values of the M2 routes, following the F3c2d pattern (M2);
- the test-runner kind of the M1 suites (`disposable`, the T1 runner);
- whether a system-owned zone or threshold mapping may show one team's bounds to every club admin,
  or such mappings are club-owned (the M1 schema supports both; the bounds are not personal data)
  (M2 / M3);
- the minimum count of athletes below which the aggregate preview returns the count only, without
  min and max (M2);
- whether M3 hardens the existing Metrics Core catalog API (its `403` for a foreign club or team,
  the forwarded `P0001` text, coach-created `team` / `user` definitions, A6) or keeps it as it is
  (M3);
- the shape of the platform-admin operation that ends a held source instance (D9) (M2).

Everything in sections C to G is decided and is not reopened by this list.

### K2. Review history — points raised by the internal reviews and decided by the owner

The internal reviews of 2026-10-12 (code, database, security) raised the eight points below; the
owner's external review of PR #156 decided each of them on 2026-10-12 (decisions C32–C39, written
into sections D to G). Nothing here is open any more, and nothing here is implemented: M1 starts
only on the owner's separate order.

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
