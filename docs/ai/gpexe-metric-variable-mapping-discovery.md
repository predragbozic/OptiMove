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
| Last verified against commit | `a1bb932` (merge of PR #229, Q10 part A; the base of the phase 2c pull request) — `1900ed6..a1bb932` is that pull request, as J3b.9 records it; section H and J3b.10 describe the phase 2c pull request as built (frontend only; no backend, migration or API contract changed) — before it `1900ed6` (merge of PR #228; the base of the Q10 part A pull request, PR #229) — `e556d08..1900ed6` changed only this document, the plan and `CURRENT_STATE.md`; J3b.9 describes PR #229 as built — before it `e556d08` (merge of PR #227, the R2 implementation) — `e8e2b0a..e556d08` is that pull request, as J3b.8 records it; only the status line, the J3b headings, J3b.8's mutation note and its Data API limit were updated — before it `e8e2b0a` (merge of PR #224, the R2 contract; the base of the R2 implementation pull request) — `e489eeb..e8e2b0a` changed only the plan and this document; sections J3b and J3b.8 describe the R2 pull request as built — before it `e489eeb` (merge of PR #223, the phase 3 docs sync) — re-verified for the facts R2 builds on (J3b.1, C99); `6c7dfa4..e489eeb` changed only this document and `CURRENT_STATE.md` — before it `6c7dfa4` (merge of PR #218, M3a) — `deb2aa1..6c7dfa4` changed the older catalog's write guard (C98, PR #219, already verified against `deb2aa1` below), the plan documents (PR #221) and the M3a frontend (PR #218, section H); no migration, mapping, binding, importer or snapshot contract changed; re-verified for the status line, section H and the K note on the two `23514` guard refusals — before it `deb2aa1` (merge of PR #217; the base of the canonical-guard pull request, C98) — re-verified for the Metrics Core catalog only (`trainingLoadMetricsCatalog.js`, `trainingLoadMetricsAccess.js`, `routes/trainingLoadMetrics.js`, A6, C82, C98); the other sections were not re-derived — before it `60aadb9` (merge of PR #163, M3-0; the base of the M2b pull request) — its tree is the integrated M3-0 branch's own (`a9a6d5e`), so nothing documented changed — before it `9e4dfb5` (merge of PR #162, the GPEXE check timing line, integrated into the M3-0 pull request) — `ed13f8a..9e4dfb5` changed `gpexeImportService.js`, `gpexeRestV1Adapter.js` and `sourceImportCredentialResolver.js` for the timing line only: no mapping, metric, binding or snapshot contract changed, and the three line references into `gpexeImportService.js` moved and were updated — before it `ed13f8a` (merge of PR #161, v35; the base of the M3-0 pull request) — `1164041..ed13f8a` changed only the v35 files (its migration, rollback and runbooks, the M2 service's actor setting and COMMIT rule, the tests, these documents), so sections A and B stand — before it `1164041` (merge of PR #160, the first M2 PR; the base of the v35 pull request) — before it `15efd7a` (merge of PR #159, M1; the base of the first M2 pull request, whose head commit is named in its description) — `e6bc885..15efd7a` changed only the M1 files (v34, its rollback, the undo script, the GPEXE test migrations, the M1 suite, these documents and rules), so sections A and B stand; sections C, D and J describe the merged M1 schema, and C59–C73 and J1 the first M2 pull request |
| Status | **Accepted architecture; M1 (the schema, migration v34) merged and deployed (PR #159, `15efd7a`; v34 directly confirmed on the production database by the owner's read-only post-check); the first M2 PR (read API, T3 create, T4 draft, submit) merged and deployed (PR #160, `1164041`, no migration); v35, the database actor guards (C74–C79, J2), merged and deployed (PR #161, `ed13f8a`; confirmed on production by the owner's read-only post-check); M3-0, the canonical-variable admin API and its request record v36 (C80–C88, J3), merged and deployed (PR #163, `60aadb9`; v36 directly confirmed on production by the owner's read-only post-check); M2b, the source-field evidence confirmation and its database guards v37 (C89–C97, J4), merged (PR #164, `66c50d6`; its deploy and v37 on the production database not re-verified in this update), no production field confirmed; the older catalog's guard on the canonical variables (C98, no migration) merged and deployed (PR #219, `7a9e59d`); M3a, the Variables view of the M3 frontend (section H, C80) over the M3-0 API, merged and deployed (PR #218, `6c7dfa4`, no migration); R2, renaming, archiving and restoring a canonical variable with a team coach for club variables (C99, J3b), accepted by the owner on 2026-10-27 (PR #224, `e8e2b0a`), merged and deployed (PR #227, `e556d08`; v38 confirmed on the production database by the owner's read-only post-check) (J3b.8); Q10 part A (the invisible characters in the services and the frontend, J3b.9) merged and deployed (PR #229, `a1bb932`, no migration); phase 2c, R2 in the Variables view (section H, J3b.10), in an open pull request, frontend only; the revision lifecycle (C91), the rest of the M3 frontend and M4–M6 not started** |
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
`backend/src/trainingLoadMetricsCatalog.js` (`createDefinition` :231-284 writes version 1 with unit,
value type, bounds, `conditionDescription`, `dailyAggregationMethod` and the scope capabilities;
`createDefinitionVersion` :452; `updateDefinitionCosmetic` :383-403; `archiveDefinition` :416-439).
Ownership of catalog objects is a client-requested scope checked by `resolveCatalogOwnerScope` in
`backend/src/trainingLoadMetricsAccess.js:78-108` (`system` only for a platform admin, `club` /
`team` by the manage right, `user` by default).
**Since C98** (owner, 2026-10-26; the canonical-guard pull request, no migration): for a `system` or
`club` definition - a canonical variable - this API's create (`POST /definitions` with that
`ownerScope`), cosmetic edit, level change, archive and new version answer a caller authorized for
the row (for a create: for the scope) `409 {"error":"System and club variables can only be changed in
Training Load > Data configuration.","code":"canonical_variable_read_only"}` and write nothing; the
check sits in the service, always after the existing right check (`definitionWriteRefusal`,
`isCanonicalOwnerScope`, `CANONICAL_VARIABLE_READ_ONLY`). The three writers that lock the row
`FOR UPDATE` (levels, archive, new version) decide on an unlocked read first
(`definitionWritePreCheck`), so a caller refused on the committed row never takes or waits for the row
lock; a caller that read allows is decided again on the row read under the lock, and may be refused
there if the row changed meanwhile. The two writers that take a body (levels, new version) judge it
only after that: the order is the right (`404`), then the canonical variable (`409`), then the body
(`400`), then the lock and the second decision, then the write - so a missing, hidden or foreign id
never answers `400`, and a canonical variable answers `409` whatever the body. A definition that is
missing, not visible or not the caller's to manage answers the byte-identical
`404 {"error":"Metric definition not found."}` - the body the routes already send for a malformed id
(ADR-006, never `403`); the archive of a domain or category and the delete of a structure link answer
`404 {"error":"Not found."}` the same way. `team` and `user` definitions, the reads, the per-user hide,
and creating domains, categories and structure links are unchanged. Tests:
`backend/tests/metrics-core-canonical-guard.test.mjs`.

**What that existing API does today, as checked out — not the M2 contract of section G:** the gate
is the manage right alone, with no active-workspace check; a create for a foreign club or team answers
`403` with a sentence ("That club is outside your access.", :98; "That team is outside your access.",
:104), while a write on an existing row the caller may not manage answers the ADR-006 `404` since
C98; `requireMetricsScope` (`routes/trainingLoadMetrics.js:128-135`)
admits every coach-capable workspace, so a coach may create `team`- and `user`-owned definitions;
`respondToWriteError` (:110-113) forwards a `P0001` trigger message as `400 {error: <message>}` and
maps `23505` to `409` — a deliberate choice recorded in `.claude/rules/backend-security.md`. Whether
M3 hardens the rest of this API (stable codes) or keeps it is an open item of section K (the identical
404 for an existing row and the canonical variables are decided by C98); the M2
routes of the new tables follow the stable-code / identical-404 contract from the start (section D).

**No frontend writes through the older Metrics Core API.** The frontend calls only its four GET routes
(`frontend/training-load-analysis-data.js:1532-1540`, `frontend/training-load-calendar-data.js:347-362`)
for the Activities "Choose metrics" picker and the dashboard metric pickers. Since M3a (section H), the
Training Load tab **Data configuration → Variables** (`frontend/metric-variables-*.js`) writes canonical
variables through the M3-0 admin API only: `POST /api/training-load/sources/metrics/variables` and
`POST …/variables/:variableId/versions` (J3). Settings has no metrics
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
    unchanged). *Superseded in part by C98 (2026-10-26):* the older API no longer creates or changes a
    `system` or `club` definition; it keeps writing `team` and `user` definitions, and the GPEXE writer
    its team-owned ones. A deferred "every definition this transaction wrote has its request row" check is not
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

**M2b - the source-field evidence confirmation (owner's decisions of 2026-10-15, after the M2b delta
discovery; as built in section J4):**

89. **Zones (O1):** how closed and open zones share one `bound_operator` per revision is unresolved: M2's
    version create takes an upper bound exactly for `between`, so one revision cannot carry a closed zone
    and the open top zone (`[7, ∞)` m/s, ≥ 75 W/kg) alike. Until the owner decides, a zone revision's unit
    may be confirmed (with its bound unit, on valid evidence), but its meaning act answers
    `409 verification_model_unresolved` whatever `boundOperator` or `evidenceRef` the body names - after
    the caller's right (the identical `404`, so a caller who may not verify never learns that a zone
    exists), the path ids, the body's keys and `requestKey`, the request record and the revision's
    existence (`404`); before the state, the operator, the reference and the right's re-check under
    `FOR SHARE` - v37 refuses a zone's meaning act in the
    database (`23514`, after v34's guard and v37's acting-user checks), and a zone revision never becomes
    `verified`. An event threshold is not blocked by this model, but is never `verified` without a proven
    threshold unit, meaning and operator (v34's CHECKs), and its operator is one-sided (`>=`, `>`, `<=`,
    `<`): v34's parameter shape of an event threshold takes no other, so `between` would leave a write-once
    proof no mapping version could ever use - it is `400 invalid_operator`, and `23514` in the database
    (internal review of M2b, 2026-10-15).
90. **Fail closed (O2):** v37 refuses every T2b write but the two acts (a new revision, a state change,
    any other update: `23514`) and every T8 row whose chain is not built (every source metric, revision,
    activation, unit conversion and source instance action but the two verifications; the mapping actions
    keep v35's chain).
91. **The revision lifecycle (O3)** - a new revision R+1, its activation, the retirement and the
    replacement - is the next backend contract and must be finished before the first real production
    confirmation. M2b may be merged and deployed, but no production seed field is confirmed through it
    before then. v37 refuses every new revision and state change, so that pull request (and any later
    seeding migration) replaces v37's T2b guard or adds its own exception with its own actor guard.
92. **`evidence_status` is always derived by the server (O4):** an act that completes the proof raises it
    to `verified` (v34's CHECK demands it), otherwise it stays as it was; the first `evidence_ref` of an
    `unproven` revision is the completing act's reference (v37 checks that in the database too). The
    client never sends a status.
93. **The meaning is a reference (O5):** T2b keeps only the stable references (`unit_evidence_ref`,
    `meaning_evidence_ref`); the content of the meaning stays in the evidence document.
94. **Rights (O6):** the two acts only by an active platform admin in the platform workspace; everyone
    else (a club admin, a platform admin in a club workspace, coaches, athletes) the identical `404`,
    before the body is looked at; the field detail is read like `GET /fields`.
95. **The reference is checked by format only (O7):** in the service and in the database (v34's
    `source_metric_evidence_ref_ok`), never against a file at runtime; the evidence document and its
    anchor are merged before a real act.
96. **Rollback (O8):** the v37 rollback refuses once any confirmation exists.
97. **The evidence standard for server3 (O9):** at least two sessions and two or three athletes per
    session where the field exists, several different non-zero values, the same field, session and
    athlete compared between the raw server3 answer and the GPEXE UI, the exact factor documented, the
    evidence sanitized (no identity, no id); the meaning and the bound operator need official
    documentation or the written confirmation of GPEXE support.

**The older catalog and the canonical variables (owner's decision of 2026-10-26, after the M3a review's
findings M-1 and P-1; built in the canonical-guard pull request, no migration):**

98. **One rule for a canonical variable, no way around it through the older catalog** (supersedes the
    part of C82 and of the "decided (C81, C82)" bullet of section K that kept the older
    `/api/training-load/metrics` API "as it is" for `system` and `club` definitions and kept its `403`):
    - a `system` or `club` definition is created, versioned and otherwise changed only through the
      canonical-variable admin API (M3-0, J3); the older API's create of that scope, cosmetic edit
      (name, short name, description, icon), level change, archive and new version answer a caller
      authorized for the row (for a create: for the scope) `409 canonical_variable_read_only` and write
      nothing - an unauthorized caller keeps getting the identical `404` (or, for a create, the existing
      `403` of the scope check, which names no row); the three writers that lock the definition row
      decide on an unlocked read first and again under the lock, so a caller refused on the committed
      row never takes or waits for that lock, while a caller that read allows may still be refused under
      the lock if the row changed meanwhile (an existing row would otherwise answer later than a missing
      one while another transaction holds it, and any coach could briefly hold up the value writes of a
      definition that is not theirs - the security review of the pull request, MEDIUM, pre-existing);
    - the rule follows the owner scope, not the creation path: a `system` or `club` definition the older
      API wrote before this decision is covered too (the owner's read-only production check of
      2026-10-26 found none: no `system` or `club` definition exists there);
    - ADR-006 across the older catalog: a definition, domain, category or structure link that is
      missing, not visible or not the caller's to manage answers the byte-identical `404`, the body the
      route sends for a malformed id - never `403`;
    - unchanged: `team` and `user` definitions (coach content, never a mapping target, D4), the reads,
      the per-user hide, creating domains, categories and structure links, the M3-0 API, the GPEXE
      writer;
    - which fields are permanent: the key, the owner and the value type never change; the semantics
      (unit, the day's combination, allowed values, condition) change only by a new immutable M3-0
      version; the name, short name, description, icon and the status (archive) have no route today and
      may change later only through a controlled M3-0 route with its request record and acting user (a
      separate owner order); the levels have no route either, and may later at most be added to by such
      a controlled change, never removed;
    - unchanged as well: the classification of a canonical variable through structure links (a caller
      links it into the domains and categories of their own scope); governing it like the variable itself
      would need its own owner decision;
    - the 409 sentence names Training Load > Data configuration, the screen of Draft PR #218; until that
      screen is deployed only an API client can meet the sentence (no frontend writes through these
      routes) — the screen is merged and deployed since 2026-10-26 (PR #218, `6c7dfa4`);
    - the order of the answers on an existing row (the independent review of the pull request, MEDIUM):
      the right (`404`), then the canonical variable (`409`), then the body (`400`), then the lock and
      the second decision, then the write; a missing, malformed, hidden or not-manageable id answers the
      identical `404` with no body, an empty or a wrong body alike, and nothing is written before the
      right and the body are both settled. A body that is not readable JSON never reaches a route: the
      app-wide parser (`backend/src/server.js`) answers `400 {"error":"invalid_json"}` before routing,
      the same for every id and every caller (unchanged by C98);
    - known and accepted (the independent review, LOW): in an athlete workspace a malformed id answers
      the route's `404` (the id is checked before the workspace), any well-formed id - existing or not -
      the workspace's `403 Forbidden`; the answer differs by the id's form only, never by whether a row
      exists. The cosmetic edit (`PATCH`) decides on an unlocked read and then updates without a lock
      or an owner-scope condition: a row whose owner changed between the two would be renamed, but no
      code path changes a definition's owner (only raw SQL could, the next limit); the three writers
      that lock the row decide again under the lock;
    - limit, stated: raw SQL and whoever holds the database credentials can still bypass it (the v35
      limit); a database guard for canonical rows stays an optional later hardening (a migration), before
      M4.
99. **R2: renaming, archiving and restoring a canonical variable, and a team coach for club variables**
    (changes C80, C81 and C88 for club variables; the contract is section J3b; not implemented yet,
    migration v38).
    - **The owner's words** (all in the *Rukovodilac*'s chat, owner turns checked by the executor):
      - the request, 2026-10-26: „Stavio sam ali bilo bi dobro da mogu preimomenovati kanonsku varijablu i
        arhivirati” (`5153b50a`, 22:10:18 UTC) and „Zašto trener ne moze imati opciju da moze da menja.”
        (`f8936f87`, 22:12:46 UTC);
      - option 2 of the *Rukovodilac*'s proposal of 22:13:40 UTC: „Slažem se sa tobom idemo za sada tako pa
        ćemo menjati ako bude potrebe” (`92449c5f`, 22:16:26 UTC);
      - the contract and the answers below, 2026-10-27: „ok ugovor 2b, Q10 ne” (`bf9dce82`, 06:34:26 UTC),
        accepting the contract of PR #224 at `fcde740` with the recommended answers. The *Rukovodilac*'s
        GO on `fcde740` came before it (06:26 UTC); the *Nezavisni revizor*'s GO on `fcde740` followed
        (06:45 UTC), and its findings were folded into J3b without changing any of these answers.
    - **Who:** a system variable - an active platform admin in the platform workspace. A club variable - the
      club's active admin in its workspace, or a platform admin there, and **an active coach of an active
      team of that club, in that team's workspace** (the team's club from `public.teams.club_id`, never the
      request). The coach gets rename, archive and restore only - never create, a new version, the key
      suggestion, the Source fields and Mappings views or the M2 routes (each the identical 404). A coach may
      archive a club variable other teams use (an archived variable accepts no new values from anyone in
      the club until it is restored).
    - **Never through R2:** the key, the owner, the levels, the semantics.
    - **The rule it departs from:** a club-owned catalog row was managed only by the club's admin
      (`canManageCatalogRow`, C80, C81, C88). A definition has no data workspace, so ADR-002's second
      contract does not apply.
    - **The answers** (the contract's questions, kept by number):
      - Q3: a reason is required for an archive, optional for a restore (at most 500 characters).
      - Q4: a pinned variable (an active mapping version uses it) is renamed only by an admin; a coach gets
        `409 variable_pinned`. Archiving a pinned variable stays refused for everyone (decision 9).
      - Q5: an archived variable is not renamed; restore it first.
      - Q6: an admin acts in a team workspace only as that team's coach; the basis written is always the
        strongest the database derives.
      - Q7: a coach reads a reduced view (id, key, label, short label, description, state, owner scope,
        `truncated`, `actions`, the rename precondition token), in every answer; accepted disclosure: the
        actions and `409 variable_pinned` / `409 restore_by_admin` tell a coach that a mapping pins a
        variable or that an admin archived it.
      - Q8: a coach restores only what a coach archived. The deciding row is the request linked to the
        definition's most recent `archive` change (the largest `seq`, assigned under the definition's lock);
        a legacy archive without a change row counts as an admin's.
      - Q9: the admins read the change history, through a later read; R2 writes it from the first change.
      - Q10: **not in R2.** The known gap of the invisible-character list is closed by a separate small PR
        (the *Rukovodilac* recommends it before phase 2c); until then it is an accepted risk (J3b.4.5). Built in
        two parts: part A, PR #229, closes it in the services and the frontend (J3b.9); part B, the database twins,
        goes into v39.
      - Q11: no write quota for coaches (as C68).
    - **Numbering:** R2 is v38, the revision lifecycle v39 (recorded in the plan by PR #226).

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
  `source_metric_unit_verified` with the same reference (built by M2b, J4).
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
  *As built (M3a, PR #218, merged and deployed as `6c7dfa4`; frontend only):* the Training Load tab **Data configuration** shows
  this view (`frontend/metric-variables-{data,view,actions}.js`), offered only from the active workspace
  (platform, or a club workspace); the server still decides on every request. It sends only the J3 bodies
  (never an owner, actor or basis), checks the J3 input rules before sending, keeps one write at a time,
  and shows a lost answer as *Result not confirmed* · *Check result*, which sends the same request key and
  body again. The Source fields and Mappings views are not built yet, so the tab shows Variables alone.
  Tested with a fake fetch (jsdom) and in Chromium at 1280 / 390 / 375 / 360 px against an in-page fake
  of the M3-0 routes. **The integration with the real API is confirmed** (2026-10-26, on disposable
  databases migrated through v37; the branch's real server in process and the real frontend in Chromium;
  the record is in PR #218):
  the executor's run on head `6436461` (57 of 59 checks; the two others are the client's intended
  normalisation of whitespace and of "-0") and the *Rukovodilac*'s own run on the same head (16 of 16).
  Not checked on a physical device (iOS `datalist`, WebKit `select`).
  *As built (phase 2c, R2 in this view; frontend only; J3b.10):* the view is also offered in a team workspace
  of a club, to its coach, in the reduced view (Q7): the club's variables, renamed, archived and restored,
  never created or versioned. A team workspace gets the Variables view only, never Source fields or Mappings
  (C99). Rename, Archive, Restore and New version are offered only as the server's `actions` name them.
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
guards - is migration **v37** and comes before the M3 write UI of draft mappings; it is built in J4
(decisions C89–C97), and the revision lifecycle (C91) follows it.

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

### J3b. R2 — renaming, archiving and restoring a canonical variable (accepted 2026-10-27; built in PR #227, migration v38, merged and deployed as `e556d08` — see J3b.8)

The contract the owner accepted as C99 (PR #224 at `fcde740`; the reviews of `code-reviewer`, `security-reviewer`
and `db-reviewer`, of the *Rukovodilac* and of the *Nezavisni revizor*; the latter's MEDIUM on the order of changes
and LOWs on Q10 and the lock order folded in when it moved here). The Q-numbers name the owner's answers in C99. Phase
2b of `docs/ai/metrics-core-plan.md` implements it as migration v38; phase 2c is its Variables-tab part.

#### J3b.1 Facts it builds on (verified at `e489eeb`)

**Where the names and the state live.**
- `label`, `short_label`, `description`, `icon_url` and `state` (`active` / `archived`) are columns of
  `training_load.metric_definitions` itself (v10, `202609041400_…_v10_metrics_catalog.sql:102-128`), not of a version.
- A version (`metric_definition_versions`) holds the semantics only, and is append-only.
- So a rename or an archive changes the definition row and never creates a version.
- The key is part of the owner-scoped unique `unique nulls not distinct (owner_scope, …, key)`. The unique covers
  archived rows too, so a restore can never collide.
- Metrics Core text is unbounded and unchecked in the database (v10). A label, short label or description written
  through the older API before C98 may be longer than the admin API's output bounds, or span several lines.

**The M3-0 admin API.**
- Routes: `backend/src/routes/sourceMetrics.js:144-182`; service: `backend/src/canonicalVariableAdminService.js`.
- It reads, creates and versions. It has no rename, archive or restore.
- Its audience is `resolveMappingAdmin()` (`sourceMetricMappingService.js:202-220`): a platform admin (platform
  workspace: the system scope; a club workspace: that club), or the club's own active admin in that club's workspace.
- Everyone else, a team workspace included, gets the identical `404 {"error":"notFound"}`. That 404 comes before the
  body is looked at (`sourceMetrics.js:177-181`), and a malformed id is a 404 before the body too
  (`canonicalVariableAdminService.js:535`).
- The rights are checked again inside every write, on a replay and before the answer after a COMMIT, by
  `rightsStillHold()` (`sourceMetricMappingService.js:227-258`). Its branches are `platform_admin` and `club_admin`
  only. A club admin who has become a platform admin answers `409 try_again`.

**The request record v36** (`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql`).
- It allows only `variable_create` and `variable_version_create`.
- It requires a version written by the same transaction (`metric_definition_version_id not null`,
  `one_per_version`).
- It allows only the bases `platform_admin` and `club_admin`, derived by v35's
  `training_load.source_metric_actor_basis()`: platform admin first, as one joined `FOR SHARE`.
- Its insert guard requires an active definition and a version of this transaction (v36:106-133). A row written
  inside a savepoint is refused through the xmin comparison with v35's `source_metric_current_xmin()`.

**Decision 9** (v34, `…_v34_source_metric_mapping.sql:1225-1238`).
- A BEFORE UPDATE OF `current_version_id, state` trigger refuses a new version, and any state change, while an
  active mapping version pins the current version. It answers `23514`, which M3-0 maps to `409 variable_pinned`
  (`canonicalVariableAdminService.js:423`).
- A rename does not fire it.
- The activation of a mapping version takes the canonical definition `FOR SHARE` and refuses one that is not active
  or whose pinned version is not current (v34:1178-1182). So an archive (`FOR UPDATE`) and an activation already
  serialize in both orders.
- A mapping (T3) targets only a `system` or `club` definition of the same owner, active at its creation (D4).

**C98 (PR #219).** The older API `/api/training-load/metrics` refuses every write to a `system` or `club` definition
with `409 canonical_variable_read_only` (`trainingLoadMetricsCatalog.js:37-41, 240, 325, 386, 425, 465`). No other
code under `backend/src` changes the four columns of a canonical definition. The GPEXE writer updates only
team-owned rows (`gpexeImportWriter.js:216`), and no migration updates them.

**What archiving does, everywhere.**
- The older catalog's default list shows only `active` definitions (`trainingLoadMetricsCatalog.js:163-168`).
- A dashboard series may be newly bound only to an active metric (`trainingLoadDashboardWidgets.js:52-56`). An
  already bound series keeps reading its full history (`trainingLoadDashboardQuery.js:34-36`).
- Cloning a template resolves its metrics among active definitions only (`trainingLoadDashboardWidgets.js:109`).
- **A new value can no longer be entered** for an archived definition: `400 … is archived and cannot accept new
  values` (`trainingLoadMetricsMeasurements.js:200`, the create path `:429` with `requireActive`).
- Existing values and versions are never touched. Restoring undoes all of this.

**Who sees a club variable today.** The older catalog shows a `club` definition only to that club's admins and to a
platform admin (`catalogVisibilitySql`, `trainingLoadMetricsAccess.js:116-134`). It manages one through
`canManageCatalogRow` (`:61-67`, the club admin). **A team coach sees no club variable today.**

**A team workspace.**
- It carries the team and its `club_id`, which may be null (`backend/src/workspace.js:60`).
- The coach role is `public.user_team_roles` (`role = 'team_coach'`, `is_active`). `public.teams` has `club_id` and
  `is_active`.
- The repository's only team-coach database lock is `training.lock_activity_decider`, as redefined by v26
  (`…_v26_activity_roster_decisions.sql:732-766`). It locks the team, then the club (`coalesce(is_active, true)`),
  then the role and the user in one joined `FOR SHARE`.
- A value entry for a definition takes it `FOR SHARE` (`trainingLoadMetricsMeasurements.js:178-181`), so an entry
  and an archive (`FOR UPDATE`) serialize.

#### J3b.2 HTTP contract

All routes sit under `/api/training-load/sources/metrics`, behind `requireAuth`, with `Cache-Control: no-store`,
same-origin JSON and the M3-0 error envelope. Every write is idempotent by `requestKey`, and the request hash covers:
- the contract version `metric-variables/v1`;
- the operation;
- the variable id;
- the normalized body, the precondition token included, as M3-0 includes `expectedCurrentVersionId`.

**Answers.**
- `200 { variable }`. A replay adds `replayed: true`, and a verified lost COMMIT adds `commitConfirmation`.
- A read that fails after a COMMIT keeps the status, with `readError`, as in M3-0.
- `503 outcome_unknown` carries only `{ error, message, requestKey }`: repeat with the same key. There is no verify
  path, as in M3-0.

**The order of the answers, for every R2 route:**
1. the identical 404 when the caller has no right to this route in this workspace — before the body;
2. `415 jsonRequired`;
3. a JSON body that is not an object: `400 invalid_body` (the router's `jsonObjectBody`, before the service);
4. a malformed `variableId`: the identical 404;
5. `400 invalid_body` for an object of the wrong shape;
6. *inside the write:*
   - a replay of the same key answers here, before any precondition;
   - then the definition: not visible or not writable by this caller is the identical 404 (an unlocked read first,
     so a refused caller never waits for the lock);
   - the definition `FOR UPDATE`;
   - **the rights again, `FOR SHARE` (J3b.5)**: lost means the identical 404, never a 409;
7. the 409s of each route below;
8. rename only (Q10, J3b.9): `400 invalid_body` for a value that changes and breaks the text rule. A field's type
   is still checked at step 5.

**Reads, for a coach in a team workspace** (`GET /variables`, `GET /variables/:variableId`):
- the owner is the team's club;
- the view is the reduced one of Q7;
- `editable` is true only for that club's variables;
- `actions` lists what this caller may do now.

For the admins the reads are unchanged, except that they gain the same `actions` field, which then also names
`newVersion`.

**Admin-only routes.** `GET /variables/key-suggestion`, `POST /variables`, `POST /variables/:id/versions` and the M2
routes answer a coach the identical 404 (step 1).

**The rename precondition token.** Every read of a variable carries `labelsToken`: the server's SHA-256 of the JSON
array `[label, shortLabel, description, state]` of the **stored** row (a NULL is JSON `null`, never `""`). The server
compares it only under the definition lock. The client sends it back. The server never
compares the client's text with the stored text, so a stored value that the output cut (`truncated`), or that spans
several lines, can still be renamed.

**`POST /variables/:variableId/rename`**

```
{ "requestKey": uuid, "labelsToken": text,
  "label"?: text, "shortLabel"?: text|null, "description"?: text|null }
```

- At least one of the three fields is present.
- A field that is left out stays unchanged. `null` clears the short label or the description.
- The new values follow M3-0's text rules: one line of visible characters without surrounding spaces; at most 80
  for the label, 20 for the short label and 500 for the description; C53, widened by Q10 (J3b.9).

The 409s, in this order:
1. `409 variable_not_active`: archived (Q5);
2. `409 variable_changed`: `labelsToken` is not the stored one. The answer carries the current reduced view and
   token;
3. `409 rename_unchanged`: the new values equal the stored ones;
4. a coach on a pinned variable: `409 variable_pinned` (Q4).

**`POST /variables/:variableId/archive`**

```
{ "requestKey": uuid, "reason": text }
```

`reason` is required (Q3). The 409s, in this order:
1. `409 variable_not_active`: already archived;
2. `409 variable_pinned`: decision 9.

**`POST /variables/:variableId/restore`**

```
{ "requestKey": uuid, "reason"?: text }
```

The 409s, in this order:
1. `409 variable_active`: not archived;
2. a coach on a variable an admin archived: `409 restore_by_admin` (Q8);
3. `409 variable_pinned`: decision 9 also fires on a restore. It is not reachable today, since an activation needs
   an active definition, but it is mapped and tested.

**Common codes.**
- `409 request_key_reused`.
- `409 try_again`, with `Retry-After`. It covers `55P03`, `40P01` and `57014`, and a stronger basis that appeared
  during the request.
- Every other database refusal is a sanitized `500`.

#### J3b.3 Authorization of a coach, and info hiding

**The resolver.** A new resolver for the variable routes, `resolveVariableEditor(req)`, keeps `resolveMappingAdmin()`
unchanged for the M2 routes.
- In the platform workspace and in a club workspace it works exactly as `resolveMappingAdmin()`.
- In a team workspace it reads from the database, never from the workspace list:
  - the team: active, with a non-null `club_id`;
  - the club: active;
  - the user's active `team_coach` role on that team;
  - the user: active.
- The owner is then `{ scope: club, clubId: team.club_id }`.
- **The basis is the strongest the user holds for that club**, by the database's own precedence: platform admin,
  then the club's admin, then the team's coach.
- `teamId` (and later `basis_team_id`) is recorded only when the basis is `team_coach`.
- Under Q6, holding the coach role on the team is required to act in a team workspace at all. The database cannot
  check that requirement when the basis is not `team_coach`, so it is the service's. Inside the write it is not
  checked again for an admin basis, which is harmless: the admin could act from the club workspace.
- An active team or club means `coalesce(is_active, true)`, as v26 and v35 do.

**The shared rights check gets a `team_coach` branch.** `rightsStillHold()` is used by the write, the replay and the
answer after a COMMIT; its existing branches stay as they are. The new branch:
1. probes the stronger bases as v35 does, each as one joined statement:
   - the platform role and the user (`for share of g, u`);
   - the club's admin role, the user and the club.

   Either found means `409 try_again`.
2. then the team, the club again, and the coach role with the user in one joined statement, all `FOR SHARE`. The
   team must be active, with `club_id` equal to the owner club.

A joined `FOR SHARE` locks only the rows it returns. So the probes lock rows only when they find a stronger role, and
then the answer is `try_again` anyway. For a coach without a stronger role, the order is v26's
`lock_activity_decider` order: team → club → coach role + user.

All these locks are `FOR SHARE`, and each writer that contends with them is a single-row UPDATE (a team or club
archive, a role revoke). A deadlock therefore needs such a writer, and would surface as `40P01`, which is `try_again`.

The same order is used by the database function of J3b.4.2. The M2 routes never reach the new branch, because their
resolver never returns `team_coach`.

**The identical 404.** Every case below answers `{"error":"notFound"}`, the same bytes as a missing id, whatever the
route and the body:
- a coach of another club's team;
- a team without a club;
- an archived team or club;
- a revoked role;
- an athlete or private-coach workspace;
- a system variable for a coach's write;
- a right lost during the request.

#### J3b.4 The database: migration v38

**Numbering.**
- R2 is ready before phase 4, which waits for the owner's v37 post-check and its own decisions.
- R2 is **v38**, and the revision lifecycle is **v39** (the owner's decision; recorded in the plan by PR #226).
- The migration runner orders files by their unique 12-digit prefix (`migrate.js:722-742`). "v38" is a label; the
  file must sort after the newest file on `main` when the branch is finished (today
  `202610191300_media_upload_lifecycle.sql`).

##### J3b.4.1 The request record (v36's table, widened, v36's guard untouched)

**What changes in the table:**
- `operation` adds `variable_rename`, `variable_archive` and `variable_restore`.
- `metric_definition_version_id` becomes nullable, with an "iff" check: it is not null exactly when the operation is
  `variable_create` or `variable_version_create`.
- The composite FK `(version_id, definition_id)` is `MATCH SIMPLE`: a null version id skips it, which is intended.
  The plain definition FK still applies.
- `basis` adds `team_coach`, with a new column `basis_team_id` (FK `public.teams`, RESTRICT). Two "iff" checks:
  - `(basis = 'team_coach') = (basis_team_id is not null)`;
  - `team_coach` only for the club scope and the three R2 operations.
- New: `metric_variable_change_id` (unique, FK to J3b.4.3): not null exactly for the three R2 operations.
- New: `reason`, nullable and only for the R2 operations, checked by `training_load.source_metric_text_ok(reason, 500)`
  in the database.
- A partial index on `basis_team_id where basis_team_id is not null`.

**What stays as it is:**
- The existing constraint names. The M3-0 tests snapshot them (`metric-variables-m3-0.test.mjs:325-333`).
- The uniques. There is still one row per user and key, so one key namespace covers all five operations, and the
  database itself refuses a key reused across operations. `one_per_version` still holds, nulls excluded.

**v36's insert guard function is not changed.** Its trigger is recreated with
`WHEN (new.operation in ('variable_create', 'variable_version_create'))`. A separate R2 guard function and trigger
run with `WHEN (new.operation in ('variable_rename', 'variable_archive', 'variable_restore'))`.

##### J3b.4.2 The basis

A new function, `training_load.metric_variable_change_basis(actor, owner_club, team)`. v35's
`source_metric_actor_basis()` is not changed.
- **Precedence:** `platform_admin` → the club's `club_admin` → `team_coach` (the team is active, its `club_id` is
  `owner_club`, the club is active, and the actor holds an active `team_coach` role on it).
- **Locks:** taken in exactly the order of J3b.3, `FOR SHARE`.
- The service writes the basis the database derives.

##### J3b.4.3 The change record, written by the database

A new append-only table, `training_load.metric_variable_changes`. Each row holds:
- `id`, the definition, `owner_scope` and `owner_club_id` (the guard checks them against the definition);
- the kind (`rename` / `archive` / `restore`);
- the old and new `label`, `short_label`, `description` and `state`. These carry no length or text check, since
  Metrics Core text is unbounded, and a check would make a legacy variable impossible to rename;
- the acting user;
- the full 64-bit `pg_current_xact_id()`;
- the row's own xmin, checked as below;
- `seq bigint generated always as identity`, the order of the changes;
- `changed_at`, set to `clock_timestamp()`.

**The order of changes.** The AFTER trigger assigns `seq` while the UPDATE holds the definition's row lock. So for one
definition, a later change always has a larger `seq`. **"The most recent change" of a definition always means its
largest `seq`**, never the earliest `changed_at` or a transaction's start time. An admin whose transaction began first
but wrote last therefore holds the most recent archive.

Indexes on the definition and on the acting user.

**Who writes it.** An AFTER UPDATE row trigger on `metric_definitions` (`UPDATE OF label, short_label, description,
state`) writes it.
- Its `WHEN` clause fires it only when OLD or NEW is `system` or `club`, and any of the four columns `IS DISTINCT
  FROM` its old value. Because that is tested first, the older API's writes to team and user rows
  (`trainingLoadMetricsCatalog.js:391, 430`) never reach the actor check.
- The values come from `OLD` and `NEW`, never from the client.
- It requires the v35 acting-user setting of this transaction, or it refuses with `42501`.
- `icon_url` is not audited; R2 does not change it.

**A BEFORE INSERT guard on the changes table** admits a row only when all of these hold:
- the row is written from inside a trigger, at depth 2 or more (`pg_trigger_depth() > 1`, because the guard itself
  is depth 1);
- `xact_id = pg_current_xact_id()`;
- the acting user is the v35 actor;
- the definition's xmin equals `source_metric_current_xmin()`.

This proves "some trigger in this transaction", not "that trigger", and the limits in J3b.4.5 say so. A forged row is
still caught by the request guard and by the COMMIT check below: it would need a definition updated in this
transaction, exactly one change row, and its own request.

**The key, in the database.** A BEFORE UPDATE OF `key` trigger refuses a change of the key when OLD or NEW is
`system` or `club` (`23514`). Its name sorts after v34's `metric_definitions_source_metric_owner_guard`, so v34's
messages keep winning wherever both fire.

**The owner and the levels stay as they are:**
- the owner is C51 for a mapped definition (v34) and a service rule otherwise;
- the levels are a service rule;
- R2 writes neither, and C98 refuses both in the older API.

An owner freeze for unmapped canonical rows would change C51 and break its tested interleavings
(`source-metric-mapping-m1.test.mjs` test 21), so it is not proposed.

**The R2 request guard checks, at insert:**
- the request names the acting user (`42501`);
- the request's owner equals the definition's owner and the change row's owner, and the request's definition is the
  change row's;
- the basis is the one `metric_variable_change_basis()` derives from **the definition's** owner, with `basis_team_id`
  for `team_coach` (`42501`);
- that exactly one change row of this transaction exists for this definition;
- that the request's `metric_variable_change_id` names that row;
- that the change row was made by the actor;
- that the change row's xmin and the definition's xmin equal `source_metric_current_xmin()`, so a write inside a
  savepoint is refused;
- that the definition's current four values equal the change row's new values;
- that the kind matches the operation:
  - a rename changes label columns only, with the state `active`;
  - an archive is `active → archived`, with the labels unchanged;
  - a restore is `archived → active`, with the labels unchanged;
- for a rename, the new label (80), short label (20) and description (500) with `source_metric_text_ok()`; the old
  values are exempt;
- for the `team_coach` basis:
  - Q4: no rename of a pinned variable;
  - Q8: a restore only when the definition's most recent `archive` change row (largest `seq`) has a request with the
    `team_coach` basis.

Any of these fails with `23514`.

**At COMMIT.** A deferred constraint trigger on `metric_variable_changes` requires the request row that points at
**that exact change** (`metric_variable_change_id`), in the same transaction (`23514`).
- So a rename or archive of a canonical variable by any path through the application's pool, without its own request
  row, is rolled back. An earlier request for the same definition does not count.
- A refusal at COMMIT is a definite failure (`commitCertainlyRefused`).

##### J3b.4.4 Append-only and rollback

- Both tables refuse UPDATE, DELETE and TRUNCATE.
- The rollback script (`docs/runbooks/…-v38-rollback.sql`):
  - refuses once any R2 request or change row exists, or a later migration is recorded;
  - otherwise drops the R2 objects explicitly, under a bounded `lock_timeout`;
  - restores v36's checks and recreates v36's trigger without `WHEN`;
  - is rehearsed: apply → rollback → the catalog identical to the one before v38 → re-apply.
- A read-only production preflight and post-check, on the v36 pattern, cover:
  - v37 recorded and v38 absent (preflight);
  - the constraint definitions, the triggers enabled (`tgenabled = 'O'`) and their deferred flags;
  - the indexes valid;
  - no R2 or change row;
  - no actor setting.

##### J3b.4.5 Limits, and what v38 changes for existing code

**Limits, as v35 and v36.** The guards prove that the row, the actor and the right agree. They are no defence against
whoever holds the shared owner credentials, or runs SQL through the application's pool and disables a trigger. The
changes table's own guard can be satisfied by any other trigger of the same transaction (J3b.4.3).

**A future migration** that changes a canonical definition's label or state must set the acting user, or disable the
trigger inside itself, and say so.

**Existing test statements that v38 breaks.** Found by searching every raw update of the four columns. Each one is
rewritten to disable the trigger inside its own fixture, as the v37 suites did, and none changes what it asserts:
- `source-metric-mapping-m1.test.mjs:960` and `:1341` (raw renames);
- `metric-variables-m3-0.test.mjs:665` and `:866` (`state = 'archived'` fixtures).

**Not affected:**
- `source-metric-mapping-m1.test.mjs:959` and `:1271`: decision 9 refuses them first, with the same message;
- test 21 of the same file (owner changes): no key change and none of the four columns;
- `metrics-core-canonical-guard.test.mjs:471` (user → system): the same reason.

No production writer is affected.

**An accepted risk until the Q10 PR.** The C53 list misses some invisible characters (U+3164, U+2800, U+115F/1160,
U+FFA0, U+034F, the variation selectors, the tag characters). With R2, every coach of a club writes club-wide labels,
so such a label can now come from a coach. The owner decided that the fix is a separate small PR, not R2 (Q10).
`metric_definitions` has no text check of its own (v10): the service and the R2 request guard check the new labels,
no constraint does. **Closed in the services and the frontend by PR #229 (Q10 part A, J3b.9); the database twins
follow in v39 (part B).**

#### J3b.5 Lock order, idempotency, outcome

A write follows M3-0's machinery:
1. the per-user advisory lock;
2. the request record lookup:
   - a replay re-checks the right and answers the current state, before any precondition;
   - the same key with another request is `request_key_reused`;
3. the acting-user setting;
4. the unlocked visibility read, then the definition `FOR UPDATE`;
5. **the rights `FOR SHARE`** (J3b.3), before any answer that carries data;
6. the 409 checks of J3b.2;
7. for the text rule: `source_metric_text_ok` again inside the write;
8. the UPDATE, and the AFTER trigger's change row;
9. the request row;
10. a bounded COMMIT, whose lost answer is verified by the request record on another connection.

Step 5 before step 6 deliberately departs from M3-0, where the rights follow the 409s
(`canonicalVariableAdminService.js:569-579`): `variable_changed` carries data. The same ordering in M3-0's
version route is recorded as a follow-up; R2 does not change M3-0.

The COMMIT bound and the verify window are M3-0's. After an unknown COMMIT, the connection is closed, never returned to
the pool, and its locks end when the server ends the transaction.

**Concurrent writes.**
- Two writes on one variable serialize on the definition lock.
- A rename and an M3-0 new version both lock the definition first, and neither changes what the other checks.
- An archive and a mapping activation serialize through v34 (J3b.1). R2 adds the two interleaving tests.
- An archive and a value entry serialize on the definition row (J3b.1). R2 tests both orders: an entry after the archive
  is refused, and an archive after the entry leaves the entry stored.

#### J3b.6 Tests and mutations

One suite, `backend/tests/canonical-variables-r2.test.mjs`, runs on disposable databases with the T1 runner. It
covers the following.

**Audience and the identical 404:**
- the platform admin on a system variable;
- the club admin on a club variable;
- the coach in a team workspace on a club variable;
- a coach on a system variable (write), another club, a team without a club, an archived team or club, a revoked
  role, a private-coach or athlete workspace: a byte-identical 404;
- a coach on the admin-only routes and on the M2 routes: 404.

**The order of the answers** (J3b.2):
- no right plus a bad body is 404;
- a coach with a non-JSON body is 415;
- a non-object JSON body is 400;
- a bad UUID plus an object body is 404;
- a coach's right revoked mid-request (the rights-hold seam) is 404, never a 409 with data.

**Reads:**
- the coach's reduced view (Q7): a field allowlist on both reads, the system reference, every write answer, a
  replay, `commitConfirmation` and `409 variable_changed`;
- `actions` and `editable` for each caller and state;
- a truncated or multi-line stored value can still be renamed through `labelsToken`.

**Each operation:**
- success, with the change row's old and new values;
- every 409 in its order;
- Q4 (a coach on a pinned variable versus an admin);
- Q8:
  - a coach restoring an admin's archive;
  - a legacy archive with no change row (raw, trigger off): coach 409, admin 200;
  - archive by a coach, restore by an admin, archive by an admin, then a coach's restore: 409;
  - the interleaving of the ordering rule: an admin's transaction begins first and waits; a coach archives and
    someone restores; then the admin archives. The coach's restore answers `409 restore_by_admin`, because the
    admin's archive has the larger `seq`;
- a restore of a pinned archived row;
- archive against activation in both orders (archive first: the activation refuses with `23514`; activation
  first: `409 variable_pinned`);
- archive against a value entry, in both orders.

**Basis:**
- a coach only (`team_coach`, `basis_team_id` set);
- a club admin who is also the coach (`club_admin`, `basis_team_id` null);
- a platform admin who is also the coach;
- a promotion mid-request: `409 try_again`.

**Idempotency and outcome, through the real routes:**
- a replay, also for a coach;
- a replay after the role is revoked: 404;
- a key reused across operations;
- concurrent identical requests;
- a lost COMMIT verified (the commit-fault seam);
- `503 outcome_unknown` with exactly `{error, message, requestKey}`;
- `readError` after a COMMIT;
- a deferred refusal at COMMIT;
- `try_again` on a held lock.

**Database guards:**
- no actor gives `42501`; a wrong basis; `team_coach` on system;
- a change without its request row gives `23514` at COMMIT, even with an earlier request for the same definition;
- a request without a change;
- a change row inserted outside the trigger (a direct INSERT; the mutation `> 1 → > 0` is killed);
- the request guard's identity checks (another owner, another definition, another user);
- the Q4 and Q8 database checks for the `team_coach` basis;
- a savepoint;
- a key change on a system or club row (OLD or NEW); v34's owner messages unchanged;
- append-only;
- the text rule (`source_metric_text_ok` on the new labels).

**Rollback.** The rehearsal, and a rollback refused once a row exists.

**Unchanged contracts:**
- the older API's C98 answers;
- the M3-0 create and version, and the constraint-name snapshot;
- the dashboards' "bound series keeps reading" after an archive;
- the rewritten fixtures of J3b.4.5.

**Mutations.** Every guard of J3b.3 and J3b.4 has a mutation that the tests kill.

**Reviewers.**
- For R2: `db-reviewer`, `security-reviewer` and `code-reviewer`, then the *Rukovodilac* and the *Nezavisni revizor*.
- For phase 2c (the Variables-tab part), its own PR: `code-reviewer`, `mobile-qa` and `ux-design-reviewer`. Its
  acceptance includes J4's escaped-text rendering.

#### J3b.7 Not in R2

- Changing the key, the owner, the levels or the semantics. A new version stays the M3-0 route, for admins only.
- Moving the rights check before the 409s in M3-0's version route (J3b.5): a follow-up of its own.
- A route that reads the change history (Q9).
- Domains, categories and structure links.
- The older API, which C98 keeps refused.
- Deleting a variable.
- The phase 2c frontend.
- Any production write. Merge, deploy and the migration need the owner's order that names v38.

#### J3b.8 As built (PR #227, from `e8e2b0a`; merged as `e556d08`)

**Files.**
- Migration `migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql`. It sorts after
  `202610191300_media_upload_lifecycle.sql`.
- The rollback, read-only preflight and post-check: `docs/runbooks/metric-variable-changes-v38-{rollback,preflight,postcheck}.sql`.
  The suite runs the preflight on v37 and the post-check on v38; the post-check carries the migration's checksum.
- `backend/src/canonicalVariableAdminService.js`:
  - `resolveVariableEditor()`;
  - the three writes through one `runChange()`;
  - the views with `actions` and `labelsToken`.
- `backend/src/sourceMetricMappingService.js`:
  - the `team_coach` branch of `rightsStillHold()`;
  - `resolveMappingAdmin(req, known)`, which takes an already resolved workspace.
- `backend/src/routes/sourceMetrics.js`:
  - the two variable reads and the three POST routes use the editor context;
  - every other route keeps the admin context.
- Tests: `backend/tests/canonical-variables-r2.test.mjs` (disposable databases, T1 runner).

**Where the build refines the text above.**
- **Q8, the deciding row.** It is the definition's most recent change before the restore (the largest `seq`), and it
  must be an archive whose request had the `team_coach` basis. That is C99's rule that "a legacy archive without a
  change row counts as an admin's". Take a coach's archive and restore followed by a legacy archive (or one written
  with the trigger off): the archive in force has no change row, so a coach is refused. The literal "most recent
  `archive` row" would have found the coach's older archive. The service (`coachArchived()`) and the request guard
  apply the same rule, and a test covers that sequence.
- **J3b.3, the coach's locks.** These are three statements: the team, then the club, then the coach role with the
  user, each `FOR SHARE` (v26's order). Both the service and `metric_variable_change_basis()` take them so. The
  two probes for a stronger role come first, as the text says.
- **The reduced view (Q7)** carries `editable` (J3b.2) besides Q7's list, so its fields are: `id`, `key`,
  `label`, `shortLabel`, `description`, `ownerScope`, `state`, `editable`, `actions`, `labelsToken`, `truncated`.
  - A team workspace reads it whoever the caller is, the basis deciding only `actions`.
  - `GET /variables/:id` there returns no versions (`nextCursor: null`) and takes no query parameter: a `cursor`
    is `400 invalid_query`.
  - `newVersion` is named only outside a team workspace.
- **The order of the answers.** It starts at the router. A body that is not JSON at all is refused by the
  application's JSON parser before any route; that is the same for every route and unchanged by R2.
  - A coach of another club has the route in its workspace. So a non-object body is `400` (step 3), and the
    variable is the identical `404` after it (step 6).
  - A platform admin whose stored workspace is a team it does not coach falls back to another workspace through
    the workspace resolver. Such a team workspace is never offered, which is what Q6 needs.
- **The text rule.** A value the rename leaves as it was is exempt, in the service and in the request guard alike
  (a legacy label longer than 80 characters stays while the description changes). Since Q10 (J3b.9) a field sent with
  its stored value is exempt too. The reason of an archive or a
  restore is checked by `source_metric_text_ok()` inside the write and by the table's own check.
- **`409 variable_pinned`** keeps its code everywhere, with a message for the case: a coach's rename, or an archive
  or restore.
- **J3b.4.5, the fixtures.** Only the two `state = 'archived'` fixtures of `metric-variables-m3-0.test.mjs` were
  rewritten, through a helper that turns the change trigger off in their own transaction. The M3-0 suite's test 3
  now expects that a team's coach (and a platform admin as that team's coach) reads the variables; the key set of
  test 6 gains `actions` and `labelsToken`.
  - `source-metric-mapping-m1.test.mjs:960` and `:1341` are not affected: that suite's databases stop at v34.
  - No other test or production code changes a canonical definition's names, state or key (searched).
- **The dashboards.** R2 changes no dashboard code, and `trainingLoadDashboardQuery.js` never reads a definition's
  state at query time (its header, lines 34–36). Test 16 binds a series, enters a value, archives through R2 and
  reads the same value again.
- **An archive against a value entry.** Test 9 pauses a real `/events` entry after it locked the definition (another
  session holds `metric_events`, which the entry writes next). The archive waits for the entry's COMMIT, and the
  value stays. The entry locks the definition twice: `FOR SHARE` around its state check, then `FOR KEY SHARE`.
  Either lock alone makes the archive wait in that test, so removing only the first one is not distinguishable
  there. That would need a pause between the two statements, which no seam provides.
- **Q3 in the database.** The CHECK `metric_variable_requests_archive_reason` requires an archive's reason, besides
  the service.
- **A stronger role granted after the rights check.** The service's probes lock only the rows they find. A grant
  committed between the probes and the request row therefore makes the request guard derive the stronger basis,
  and refuse (`42501`, "the basis is not the acting user's own"). The R2 writes answer exactly that refusal
  `409 try_again`, as J3b.2 says (`classifyChangeError()`). M3-0's create and version keep v35's documented
  sanitized `500` for the same window.
- **A platform admin in a team workspace** (Q6). A platform admin who coaches team T writes club X's variables
  through T's team workspace with the basis `platform_admin`. A platform admin is offered a club workspace only with
  a `club_admin` role there, so "the admin could act from the club workspace" (J3b.3) is not literally true for
  them. The effect is the same: the database derives `platform_admin` for any active club, a right they already
  hold.
- **The admin-only operations** (create, a new version, the key suggestion) refuse a team workspace's context in the
  service too (`adminOnly()`), besides their routes' admin context.
- **`seq` is `generated always as identity (cache 1)`.** The cache of 1 (the default, written out) keeps "a later
  change has a larger `seq`" true across sessions.
- **J3b.4.5's advice for a future migration is corrected.** A migration that changes a canonical definition's names
  or state must disable `metric_definitions_v38_record_change` inside itself and enable it again. Setting the
  acting user is not enough: the change row it would write has no request row, and the COMMIT refuses it.
- **Known limits.**
  - Both tables keep their free text for good (old and new names, a request's reason): nothing deletes or rewrites
    a row.
  - Coaches have no write quota (Q11).
  - Like v36, the tables have no row-level security. That is sound while the `training_load` schema is not
    exposed through Supabase's Data API, which this pull request does not verify. At the merge the owner found the
    Data API switched off ("No schemas can be queried"; see `CURRENT_STATE.md`).
- **The rollback** also locks `metric_definitions`, whose two v38 triggers it drops.
- **A dump and restore reads v38 back the same** (what `backend/scripts/gpexe-backup-verify.mjs` compares). The
  change trigger's `WHEN` compares the four columns one by one, not as a row, and `owner_scope::text`, not the varchar
  column. PostgreSQL stores a row comparison as nested `OR`s and an `IN` list against varchar with casts, and a
  restore rewrites both, so the restored trigger's text would differ. Test 15 dumps and restores the behaviour
  database and compares every trigger, constraint and function v38 adds or gates.

**Mutations.** The record is in PR #227's description, with the reviewers' own sets. Every guard of J3b.3 and J3b.4
has a mutation that a test kills, except redundant checks: a check whose removal another guard of the same chain still
catches. These are the R2 guard's checks of the change row's owner, transaction, xmin and author and of the
definition's xmin, and the value entry's first lock (above).

#### J3b.9 Q10 part A as built (PR #229, from `1900ed6`; no migration; merged and deployed as `a1bb932`)

The *Rukovodilac*'s decisions of 2026-10-27, following the executor's proposal: the unit token is in Q10; an emoji
with the variation selector U+FE0F is refused (without it, it passes); the database twins go into v39 as a separate
part with its own preflight block and rollback part (no v40); a rename checks only the values that change.

- **One module.** `backend/src/metricTextRules.js` holds the lists and the two checks, without a database:
  - `TEXT_FORBIDDEN` and `boundedText()` (labels, short labels, descriptions, reasons, M2's conversion note, the key
    suggestion's label);
  - `UNIT_FORBIDDEN` and `unitTokenOk()` (M3-0's unit and condition unit, M2b's source units).

  `sourceMetricMappingService.js` and `canonicalVariableAdminService.js` import them; the latter still exports
  `unitTokenOk` for M2b.
- **The characters.** The lists are explicit, since PostgreSQL's regular expressions have no Unicode properties, so
  v39's SQL can carry the same list. Both lists add, beyond C53:
  - U+034F;
  - U+115F-1160, U+3164 and U+FFA0 (the Hangul fillers);
  - U+17B4-17B5;
  - U+180B-180D and U+180F (with C53's U+180E, U+180B-180F);
  - U+2065 (with C53's ranges, U+2060-206F);
  - U+2800 (the blank braille pattern);
  - U+FE00-FE0F (the variation selectors);
  - U+FFF0-FFFB;
  - U+1BCA0-1BCA3 and U+1D173-1D17A;
  - U+E0000-E0FFF (the tags and the variation selectors supplement).

  That is every default-ignorable code point, plus U+2800 and U+FFF9-FFFB. The text list grows from 96 to 4,245 code
  points, the unit list from 116 to 4,264 (U+2065 was in it already). The regular expressions carry the `u` flag.
- **Blanks.** A text may not start or end with a blank: U+0020 (C41's rule) or another space separator (U+00A0,
  U+1680, U+2000-200A, U+202F, U+205F, U+3000). So a text made only of blanks is refused too, and no label can look
  like another by a hidden blank at its edge (the security review of PR #229). A blank between visible characters
  stays allowed. A unit token refuses every blank already. v39's SQL twin must take the same edge rule, since
  `btrim()` trims only U+0020.
- **The frontend.** `frontend/metric-variables-data.js` carries copies of both lists. It needs no blank rule: its
  `oneLine()` removes every blank first, and an empty label is "Required.". The unit test compares the copies with
  the server's lists over every code point U+0000-U+10FFFF.
- **A rename checks the values that change.** The rename body now checks only the type of a field. The text rule runs
  inside the write, after the 409s, on each value that differs from the stored one, and the database checks it once
  more. A field left out, or sent with its stored value, is exempt, as in v38's request guard.
  - **The order of the answers moves for a bad text** (J3b.2, step 8): everything inside the write answers first.
    That is a replay or `409 request_key_reused`, the identical 404, `409 try_again`, and the rename's 409s
    (`variable_not_active`, `variable_changed`, `rename_unchanged`, `variable_pinned`). Only then comes the
    `400 invalid_body`. The codes and messages are unchanged.
  - The archive's and the restore's reasons are new values, so they are still checked in the body (step 5).
- **What a stored value keeps.** No stored label, reason or unit is rewritten. A legacy value with a character Q10 adds
  stays readable and can be kept by a rename. v39's preflight must count the rows that the database twins would
  refuse (expected 0).
- **Known limits.**
  - Create, archive and restore still check their texts in the body, before the request key's replay. So a request
    that succeeded before the deploy with a character Q10 refuses answers 400 when it is repeated afterwards with the
    same key. It is refused, never written twice, and only for the deploy window.
  - The older catalog API (`trainingLoadMetricsCatalog.js`) only trims the labels of team- and user-owned
    definitions. Club and system variables never pass through it (C98). A separate task records it.
  - Phase 2c's rename form must check only the fields that change. The frontend's `TEXT_FORBIDDEN` would otherwise
    block a stored legacy value that the server exempts.
- **Tests and mutations.**
  - `backend/tests/metric-text-rules-q10.test.mjs` (unit, no database):
    - every added code point is refused in a text and in a unit;
    - the lists equal C53's plus Q10's groups, code point by code point;
    - the frontend's copies are identical to the server's lists;
    - the blank rule;
    - ordinary names in several scripts, emoji without U+FE0F and a length counted in code points pass.
  - `canonical-variables-r2.test.mjs` test 17 checks, through the real routes, a sample of every group and a
    blanks-only text. It covers create (each text field and the unit), the key suggestion, a rename that changes a
    value (both a coach and a club admin; no change or request row written), an archive's and a restore's reason, the
    outsider's 404, and the legacy label kept by a rename.
  - The M2 suite's conversion note takes the same sample of every group. The M2b suite's unit list and the
    frontend's form test gain samples.
  - Test 17 also refuses a label that starts or ends with a non-ASCII blank, on create and on a rename.
  - Test 17 also pins the order: a reused key, a stale token and an outsider each answer before the 400.
  - 57 mutations, all killed:
    - each group removed from each of the four lists;
    - the edge-blank rule removed, narrowed to a leading blank, or without one of its blanks;
    - the rename checking every sent value, checking none, checking in the body again;
    - the write without the JavaScript text rule.

#### J3b.10 Phase 2c: R2 in the Variables view (as built; frontend only, from `a1bb932`)

The Variables view of section H over the R2 routes of J3b.2 (`frontend/metric-variables-{data,view,actions}.js`,
`frontend/styles.css`). No backend, migration or API contract changed.

**Who is offered it.** `variablesContext()` reads the active workspace the client already holds (`/me`):
- the platform workspace and a club workspace give the administrator's view;
- a team workspace of a club (`activeWorkspace.type = "team"` with a `clubId`) gives the coach's view;
- a team without a club gets nothing.

A team workspace is offered the Variables view only, never Source fields or Mappings (C99). The frontend has
neither view yet. The server decides again on every request (J3b.3).

**The coach's view (Q7).**
- The list holds the club's variables (*This club* / *System (reference)*). It has no *New variable*.
- Its texts say that the club's variables are shared by all its teams and that a coach's change applies to every
  team of the club. The system variables read as shared by all clubs and changed only by a platform administrator.
- One variable shows its names, description and state. The key, owner and id are under Technical details.
- No facts and no versions are shown.

**Buttons from the server.** Rename, New version, Archive and Restore are offered only when the variable's
`actions` name them. A click on an action not in `actions` opens nothing. Where an action is missing, a note
says why:
- a system variable is read only;
- an active mapping uses the variable: an administrator reads that it cannot get a new version or be archived
  now; a coach reads that a data source is mapped to it, so it cannot be archived now and only an administrator
  of the club can rename it;
- an administrator archived it, so only an administrator can restore it (Q8).

On a desktop the actions sit at the right of the name; on a phone they fill a grid, and an odd last button takes
the whole row.

**Rename.**
- The body is `{ requestKey, labelsToken, ...changed }`.
- A name goes into the body only when its one-line form differs from the saved name. An emptied short name or
  description is `null`.
- Nothing changed is said before sending; no request goes out.
- A saved name the server would refuse today (Q10) stays out of the body while it is untouched.

**Locked names** (the *Rukovodilac*'s remark 2 on the 2c plan, 2026-10-27).
- A name the form cannot show exactly as saved is read only, with a *Replace* button and a reason. The reasons,
  in this order:
  - the read may have cut it: `truncated` is one flag for the whole variable, so while it is set every name at
    its limit counts as cut, and the text says it *may* be longer, with a "…";
  - it holds a line break;
  - it holds spacing a field would tidy: a double space, a space at an end, a non-breaking space.
- The saved text is shown with its lines and spacing. *Replace* is described by the reason, not by the whole
  text.
- A read-only name is never sent until the coach replaces it, even after an input event for a field that is not
  on the screen.
- *Replace* starts the field from the text shown, as one line. A note above the hint says what saving loses for
  that reason, for a cut name "the hidden part too". A replaced name left as shown is still not sent.
- The description field takes the whole row of the form.

**`409 variable_changed`** (remark 3). The answer carries `current`: the reduced view with the new token. The
form stays open on it:
- a name the coach changed keeps the coach's text. When someone else changed the same name, the field says what
  is saved now, or that it is the same as the coach's text;
- every other name shows the saved value, read only again when needed;
- the new token and a new request key are used, and the coach saves again;
- the focus goes to the explanation (not to a field, so a phone's keyboard does not open);
- Cancel then reads the variable again. An unconfirmed later save is said first: *Close without checking*
  still says the result was not checked.

The form closes only when `current` is missing or no longer offers `rename` (for example, a variable now pinned
for a coach).

**Archive and restore.**
- An archive needs a reason (Q3); a restore's reason is optional.
- The archive form says what archiving does for every team of the club (for a system variable, every club),
  from J3b.1's "What archiving does": no new values can be entered and it cannot be added to a dashboard until
  it is restored. Values already recorded, its history and the dashboards that already show it stay. An
  administrator also reads that it gets no new version and no new mapping. The restore form says the reverse.
- The archive form says who can restore it later (Q8). That depends on the basis the server will write (J3b.3:
  the strongest role the user holds), which the client reads from the workspaces `/me` lists:
  - a platform workspace, or this club's workspace: "Only an administrator can restore it later; a coach
    cannot.";
  - neither: "A coach of this club's teams or an administrator can restore it later.";
  - `/me` without that list: both cases are stated.

**Refusals.**
- `variable_not_active`, `variable_active`, `variable_pinned` and `restore_by_admin` close the form with the
  sentence of its mode and read the variable again.
- `rename_unchanged`, `invalid_body` and `try_again` keep the form.
- A lost answer is *Result not confirmed* · *Check result*, which sends the same raw body. The R2 refusals
  settle the check (J3b.2, step 6). *Close without checking* reads the variable again.

Every text from the server is escaped, the locked names and the "saved now" notes included. On phones the
action buttons sit in a grid of columns at least 140 px wide, and the form's buttons are full width (at most
760 px).

**Evidence (before review):**
- `frontend/tests/metric-variables-r2.actions.test.mjs` (jsdom, a fake fetch) and the updated
  `metric-variables.actions.test.mjs`;
- 34 frontend mutations, all killed;
- an integration run with the branch's real server in process and the real frontend in Chromium. It ran on a
  disposable database migrated through v38. The users were a club admin, a coach of one of the club's teams, the
  club's admin who also coaches that team (in the team's workspace), and a coach of another club. It covered:
  - rename, archive and restore, and Q8;
  - the dual-role user's archive: written with the basis `club_admin`, so the plain coach gets no Restore;
  - a stale token;
  - a cut and a multi-line description;
  - a Q10 legacy name;
  - a lost answer with *Check result*;
  - isolation from the other club;
  - layout at 1280 / 390 / 375 / 360 px: no overflow, 44 px targets, 16 px fields, the actions' placement and the
    full-row description.

The record is in the pull request. Not checked on a physical device.

### J4. M2b — the source-field evidence confirmation and its database guards v37 (as built)

Service `backend/src/sourceFieldVerificationService.js` (M2's machinery, `adminWriteKit`; the revision
shape `revisionOut` shared with `GET /fields`), routes in `backend/src/routes/sourceMetrics.js`, migration
`migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql`, rollback
`docs/runbooks/source-metric-revision-guards-v37-rollback.sql`, read-only production preflight and
post-check `docs/runbooks/source-metric-revision-guards-v37-preflight.sql` / `…-postcheck.sql`, tests
`backend/tests/source-field-verification-m2b.test.mjs`. Access, `401`, the identical `404
{"error":"notFound"}`, `Cache-Control: no-store` and `Retry-After: 5` on `try_again` are J1's; `415
jsonRequired` only for a caller who may verify.

| # | Route | Who | Input | Success | Refusals |
|---|---|---|---|---|---|
| F1 | `GET /fields/:fieldId` | as `GET /fields` (C94) | — | `200 {field:{id, sourceSystem, apiFamily, key, label, state, revisions:[revision]}, verifications:[{revisionId, act, at, evidenceRef}]}` (`act` `unit` or `meaning`; never who) | `404`, `400 invalid_query`, `409 result_too_large` |
| F2 | `POST /fields/:fieldId/revisions/:revisionId/unit-verification` | an active platform admin in the platform workspace (C94) | `requestKey`*, `sourceUnit`* (a unit token), `sourceBoundUnit` (exactly for a zone or an event threshold), `evidenceRef`* | `201 {revision, replayed:false}`; replay or verified COMMIT `200` | `400 invalid_body`, `invalid_unit`, `invalid_evidence_ref`, `bound_unit_required`, `bound_unit_not_allowed`; `404`; `409 unit_already_verified` (+`current`), `revision_retired`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |
| F3 | `POST /fields/:fieldId/revisions/:revisionId/meaning-verification` | the same | `requestKey`*, `boundOperator` (exactly for an event threshold, one-sided: `>=`, `>`, `<=`, `<`), `evidenceRef`* | as F2 | `400 invalid_body`, `invalid_evidence_ref`, `invalid_operator` (also `between` on an event threshold), `operator_required`, `operator_not_allowed`; `404`; `409 verification_model_unresolved` (every zone revision, C89: after the right (`404`), the path ids, the body's keys and `requestKey`, the request record and the revision's existence (`404`); before the state, the operator, the reference and the right's re-check), `meaning_already_verified` (+`current`), `revision_retired`, `request_key_reused`, `try_again`; `503 outcome_unknown`; `500 internal_error` |

- **A revision:** `{id, fieldId (in F2 / F3), revisionNumber, state, valueShape, parameterKind, supportsSession,
  supportsDrill, expectedSourceUnit, sourceUnit, expectedSourceBoundUnit, sourceBoundUnit, boundOperator,
  evidenceStatus, evidenceRef, unitEvidenceRef, meaningEvidenceRef, unitVerifiedAt, meaningVerifiedAt}` -
  never a verifier's id.
- **An act:** one `UPDATE` of the revision (its proof columns once, from NULL; `evidence_status` derived,
  C92) and one T8 row (`source_metric_unit_verified` / `source_metric_meaning_verified`, targets T2a and
  T2b, the act's reference, basis `platform_admin`, the request key and hash) in one transaction; the T8 row
  is the request record (one key space with M2's mapping writes, so a key of another operation is
  `request_key_reused`). The request hash covers the contract version (`source-fields/v1`), the action,
  both path ids and the normalized body. A wrong act is never overwritten: its correction is a new revision
  (C91).
- **Lock order:** the per-user advisory lock (the M2 key) → the request record → the T2b row `FOR UPDATE`
  (T2a read plainly: a revision that is not retired implies an active field) → the role and user rows
  `FOR SHARE` (the right again) → the T2b update (v34's and v37's guards) → the T8 row (v34's, v35's and
  v37's guards) → the bounded COMMIT (v37's deferred link). No T3, T4, canonical or binding row is locked;
  an M2 version create holds the T2b row `FOR SHARE` and serializes with an act.
- **The COMMIT:** M2's rule (C79); the right is checked again before the answer.
- **v37:** three functions, two T2b triggers (`source_metric_revisions_v37_actor_guard` BEFORE INSERT OR
  UPDATE; `source_metric_revisions_v37_audit_link`, a deferred constraint trigger AFTER UPDATE of the
  proof), one T8 trigger (`source_metric_audit_v37_revision_guard` BEFORE INSERT) and two indexes (the
  lookup `source_metric_audit_v37_revision_idx` and the unique `source_metric_audit_v37_verification_once`,
  one verification row per revision and act); no table, column or data. The acting user (the v35 setting)
  is an active platform admin (`42501`) and the user the act names (`42501`); everything else is `23514`:
  a write that is not exactly one act (C90), a zone's meaning act (C89), an event threshold's meaning act
  without a one-sided operator (C89), a first `evidence_ref` other than the completing act's reference
  (C92); a savepoint fails closed. Depends on the v35 functions; the v35 and v36 rollbacks refuse while v37
  is recorded.
- **For the M3 frontend:** a unit token may hold characters such as `<` (only whitespace, `|`, `=`,
  control and invisible characters are refused), so every unit and evidence reference is rendered as
  escaped text - never into `innerHTML` or as an `href` (security review of M2b, 2026-10-15).
- **What the nine seeded `rest_v1` fields still need (C97; none is confirmed, and none may be before C91):**

  | Field | The unit act needs | The meaning act needs |
  |---|---|---|
  | `athlete_session.total_time`, `total_distance`, `max_v` | the server3 raw value against the GPEXE UI for the same field, session and athlete (the expected factors 60 for minutes, 1, 3.6 for km/h are hypotheses) | the field's definition from GPEXE documentation or support |
  | `more.complementary_data.power.distance`, `speed.distance` | the distance unit (the UI zone table) and the bound unit from the server3 threshold set against the team's settings in the UI (W/kg, m/s) | blocked until the zone model is decided (C89) |
  | `more.events.acceleration_events_count`, `deceleration_events_count` | `count` and the threshold's unit (the seed carries no hypothesis for it) | the operator (`>=` or `>`, `<=` or `<`) and the meaning from documentation or support |
  | `details.players.tot_burst_events`, `tot_brake_events` | `{unit: "number"}` is a shape, not a unit | the meaning, which GPEXE support must confirm |
- **Tests:** the migration and the rehearsed rollback, the database guards (no actor, another user, a
  non-platform-admin session, both acts in one update, a zone's meaning act, the COMMIT link, the audit
  chain, a savepoint, an unbuilt action), access, body validation with the JavaScript / database parity of
  the evidence reference, the two acts and the derived status for a plain field, an event threshold and a
  zone, the one-sided operator of an event threshold, the first evidence reference, the physical "once",
  the state codes, idempotency and the replay's right, concurrency (two acts, and an act against a real M2
  version create in both orders), the COMMIT, the M2 version create after a proven unit, a right revoked
  inside the write, no actor left and no leak, the nine seeded revisions untouched; mutation evidence. The M2 and M3-0 suites write their revision fixtures with v37's
  T2b triggers off (the future lifecycle PR's writes, in one transaction; v34's guard stays on).

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
- the evidence that closes `unit_evidence_ref` and `meaning_evidence_ref` for server3 (M6, gate 2) - its
  standard is decided (C97), what each seeded field still needs is listed in J4, and the owner collects it;
- the revision lifecycle (C91), before the first real production confirmation, and the zone model (C89);
- the throttle of the M2 routes (M2); their read and write bounds are decided (C70, J1);
- the test-runner kind of the M1 suites — `disposable`, through the T1 runner (as built);
- whether a system-owned zone or threshold mapping may show one team's bounds to every club admin,
  or such mappings are club-owned (the M1 schema supports both; the bounds are not personal data)
  (M2 / M3);
- the minimum count of athletes below which the aggregate preview returns the count only, without
  min and max (M2);
- decided (C81, C82): the existing Metrics Core catalog API stays as it is for its current callers (its
  `403` for a foreign club or team, the forwarded `P0001` text, coach-created `team` / `user` definitions,
  A6); the M3 frontend writes canonical variables only through the M3-0 admin API (J3); *superseded in
  part by C98 (2026-10-26):* the older API no longer creates or changes a `system` or `club` definition,
  and a write on an existing row the caller may not manage answers the identical `404` instead of `403`
  (a create for a foreign club or team keeps its `403`);
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
constraint name) to a stable `409` in `backend/src/routes/trainingLoadMetrics.js` — *superseded by C98
(PR #219), no longer needed:* a mapping targets only a `system` or `club` definition (D4), and for those the
older API refuses an archive, a new version and a level change with `409 canonical_variable_read_only`
and writes nothing, so neither guard refusal can reach its `respondToWriteError` any more; the
M3-0 API maps the pin guard to `409 variable_pinned` for a new version (J3), and the archive of R2
(phase 2b of `docs/ai/metrics-core-plan.md`) is planned to answer the same; M2 maps every native
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
