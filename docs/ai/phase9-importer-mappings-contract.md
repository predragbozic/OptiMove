# J17 — phase 9: the importer writes through mappings (M4), and the first controlled import (M6) (proposed ★★ contract)

This is the contract of phase 9 of `docs/ai/metrics-core-plan.md` ("### Phase 9 ★★: M4, the importer integration") and
of the owner-run M6 that follows it. It is the M4 and M6 rows of section J of
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*), built on what phases 1–8 delivered
(v34–v50, the routes of J1–J13, the Mappings screen of J16). J14 and J15 stay reserved for 7h and 7i.

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-01, on the *Rukovodilac*'s order of that day („Posle merge-a: faza 9 (prvi kontrolisani uvoz, M4/M6). Pošalji mi plan ili ugovor faze 9 pre koda, sa jasnim spiskom koraka koje radi vlasnik (crvena zona: prekidač za uvoz, backup, GPEXE).”). No phase 9 contract existed; the plan holds a stub (`metrics-core-plan.md:1114-1120`). **No code is written before this contract is accepted.** |
| Verified against commit | `1932ad1` (merge of PR #310). Every file and line reference is to that commit unless marked otherwise. |
| Mark | ★★ (triggers 1, 2, 3 and 4; the five-point rule for transactions with an external effect). For a ★★ phase the owner approves the contract before any code (`metrics-core-plan.md:450-452`). |
| Owner decisions | Section 12.2 (O1–O13). The plan's phase 9 has no "Input (red zone)" or "Start" line; those are written only on the owner's own word, never by relay (`metrics-core-plan.md:432-435`). |
| Decides | The owner: O1–O13. The *Rukovodilac*: R1–R16 (section 12.1). The *Nezavisni revizor* reviews this contract and 9-B (★★). |

---

## 0. In short

**M4 (phase 9, code).** The GPEXE importer stops using the hard-coded `GPEXE_METRIC_SPECS` and stops creating its own
team-owned `gpexe_*` definitions. For a bound team it writes a value **only** through an open activation (T5) of the
team's binding: into the activation's system or club canonical variable (the version T4 pins), converted exactly at
the storage scale S = 9, with one provenance row (T6) per value, and with the source-instance keys (T7) set at the
first import. Everything else is refused fail-closed with a stable code (section F of the discovery document). The
import switch stays **off** throughout phase 9.

**M6 (after phase 9, the owner only).** A numbered list of red-zone steps (section 10) that ends with **one** approved
GPEXE session in one environment: the unit and meaning evidence (C97), the first field confirmations, the system
variables, the mappings, the activations on the First team's binding, one check with the switch off, a fresh
restore-verified backup, the switch on, exactly one approval, the switch off, a read-only post-check. The executor
only prepares text, SQL files and procedures; it never sends a GPEXE request, reads or writes a persistent database,
or touches Render or Supabase.

**Urgent, independent of the code (section 10, step P1).** The stored snapshots the C97 evidence procedure reads
expire: the sessions of 05–06.10.2026 around **2026-11-10** (`docs/runbooks/gpexe-c97-unit-evidence-owner-procedure.md:29-32`),
those of 11.10–24.10.2026 around 2026-11-23 (inferred: last seen 2026-10-24, `CURRENT_STATE.md:2095-2096`, plus the 30
days of `gpexeImportService.js:33`). C97 is phase P of the plan (`metrics-core-plan.md:687-695`), owner-run, and does
not wait for this contract or for 9-B. A later C97 needs a refreshing GPEXE search, which only the owner may order.

---

## 1. What exists (verified at `1932ad1`)

### 1.1 Today's write path (`approveCandidate`, `backend/src/gpexeImportService.js:2154-2301`)

One transaction on one pooled client:
1. Refusals before any connection: a malformed hash, a non-boolean `acceptChanges`, the switch off (`409
   import_switch_off`, `:2161`; the switch is `process.env.GPEXE_IMPORT_APPLY_ENABLED === 'true'`, read on every call,
   `:41-43`). `pool.connect` at `:2163`.
2. `begin`; `lock_gpexe_import_approver` (role, grant and user rows `FOR SHARE`, v23 `:33-57`; its order documented at
   v23 `:16-23`); the candidate `FOR UPDATE` (`:2171-2184`); the existing refusals (`:2185-2212`), among them
   `nothing_to_import` for a preview whose status is `no_changes` (`:2206`).
3. `buildGpexeImportPlan(raw_bundle)` **before** the team lock (`:2217`); a mapping error stores a blocked preview and
   answers `409 preview_changed` (`:2218-2224`).
4. The team import lock (`lockTeamForImport`, `pg_advisory_xact_lock(hashtextextended('gpexe-import-team:<uuid>', 21))`,
   `gpexeImportWriter.js:599-602`), then `previewLocked` (`gpexeImportPreview.js:178-381`), which runs the writer
   inside `savepoint gpexe_preview_import` (`:201`, rolled back to it on a `GpexeImportError`, `:214`).
5. The writer `importGpexePlanLocked` (`gpexeImportWriter.js:634-704`): athletes in the team; `ensureSourceConnection`
   (an unlocked read or an insert of the team-owned v11 connection, **no T7 keys**, `:137-158`);
   `ensureMetricDefinitions` (**creates team-owned `gpexe_*` definitions**, version 1 and the `session` and
   `component` capabilities, `:168-224`, `:641`); the source identities `FOR UPDATE` (`:468-484`), then the event
   (`:226-257`); the threshold-set binding (`metric_event_source_bindings`, `:263-343`); segments, participants,
   `materialize_activity_group_from_metric_event`, drill components; per result an occasion and **one multi-row
   INSERT into `metric_values` with the JS double** (`:406-459`).
6. The preview hash compared again (`:2231-2234`; a refusal stores the refreshed preview itself,
   `storeRefreshedPreview`, `:2287-2289`, body `:1852-1859`); the approval row (its v33 trigger re-checks the right,
   the hashes and the actionable state); the candidate `imported`; the roster observations; the bounded COMMIT with
   the F2 outcome discipline (`:1730-1831`, `:2262-2300`).
7. No `lock_timeout`, `statement_timeout` or `idle_in_transaction_session_timeout` anywhere in `:2154-2515`
   (switch condition 2, unbuilt).

The same writer runs, rolled back, on every check: `recordCandidate` → `buildCandidatePreview` (`begin`, team lock,
writer, always `rollback`; `gpexeImportService.js:1170`, `gpexeImportPreview.js:155-171`). A check's
new / changed / unchanged counts compare `bundle_hash`, the raw answer (`gpexeImportService.js:1188`); the finalization
refreshes `preview` and `preview_hash` of same-content rows (`:2045-2063`).

**Not written today:** no T6 row, no T7 key, no T5 read (`grep` of `backend/src`). The archive of the team is
checked once, unlocked, at the route (`gpexeImportAccess.js:19-22`); the club's archive is not checked there, and no
team or club row is locked during an approval.

### 1.2 Today's values

- 11 specs (`gpexeImportMapper.js:76-87`, `:125-178`), each on the whole session (`full`) and every drill (`drill`),
  never summed. Whole-session values are `source_rollup` / `complete`, drill values `standalone` / `not_applicable`
  (`gpexeImportWriter.js:120-122`).
- A JS double goes to `value_numeric` through `Number.prototype.toString()` (`pg` `utils.js:44-69`), e.g. 1397/60 is
  stored as `23.283333333333335`.
- `1e-9` appears only in the preview's changed / same label, as an absolute difference (`gpexeImportPreview.js:137`).
  The occasion content hash (`gpexeImportWriter.js:99-116`) and the preview hash (`gpexeImportPreview.js:379-380`) are
  exact.
- `METRIC_BY_KEY` (`gpexeImportPreview.js:45, :130, :315`) labels preview values from the specs; the Link athletes
  helper values read the preview by the keys `gpexe_time_min`, `gpexe_total_distance`, `gpexe_max_speed`
  (`SOURCE_ATHLETE_VALUE_KEYS`, `gpexeImportService.js:1482-1496`); the frontend has its own key lists
  (`METRIC_TEXT`, `LINK_CONTEXT_KEYS`, `MAP_VALUE_LABELS`; `frontend/gpexe-import-view.js:130-149, :1027, :1527`).

### 1.3 What phase 9 builds on

- **The schema is complete** (v34): T2a / T2b (source fields and revisions), T3 / T4 (mappings and their immutable
  versions with exact `scale`, `scale_divisor`, `offset`), T5 (activations, `requirement` `required` | `optional`
  with no default, v34 `:1304-1306`), T6 (`metric_value_source_provenance`, append-only, `v34:1483-1623`), T7 (two
  write-once columns on `metric_source_connections`, `v34:1448-1479`), T8 and `unit_conversions`. v48 changed only T5
  (actor, basis, audit), v50 added the instance state guard (`v50:105-172`).
- **The T6 insert guard** (`metric_value_provenance_insert_guard`, `v34:1519-1617`) refuses with `23514` unless: the
  T5 row is open and matches (`FOR SHARE`); the binding is active (`FOR SHARE`); the Metrics Core connection is active
  (`FOR SHARE`); the T4 pins match; `source_unit` equals the revision's and the version's; the event is the T5
  team's and at a level the activation covers; the value's definition and version are T4's; `unit_at_capture` is
  T4's target unit; `value_numeric` passes `source_metric_value_matches`; the connection's
  `(source_system, source_host_key, source_instance_key)` equals the binding's; the occasion's identity belongs to
  the same connection. It reads neither `requirement` nor the switch. It does not check for a savepoint.
- **Reusable code:** the extractor registry, ten frozen entries keyed `gpexe/rest_v1/<key>` that return the value in
  the field's source unit or `{ skip: code }` (`sourceMetricExtractors.js:1-289`, `extractorFor`,
  `extractabilityCode`); `convertAtStorageScale` (`sourceMetricPreview.js:33-56`), the exact BigInt rule the T6
  trigger re-checks; the seam `buildGpexeImportPlan(bundle, { metricSpecs })` (`gpexeImportMapper.js:277`) and its
  per-level use `gpexeLevelValues` (`:420-442`); the 7e reader of a version's factors and levels
  (`sourceMetricPreviewService.js:66-77`, `:145-146`). 7f test 9 already proves the extractors equal the specs on seven
  bundle variants (`source-metric-extractors-7f.test.mjs:224-276`).
- **Coverage:** every one of the 11 specs has a seeded field and an extractor (the closed power zone field serves
  25–60 and 60–75 through its parameters; the open top zone is v42's). Burst and brake meanings are unconfirmed.

### 1.4 What blocks a mapped import today (production, by the record)

- Every seeded revision is `observed` with no proven unit (`v34:1778-1817`; v42 `:73-86`): no mapping version can be
  created (`v34:1053-1054`) and none activated. A revision becomes `verified` only when **both** the unit act and the
  meaning act are done (`sourceFieldVerificationService.js:245-253`).
- No system or club canonical variable for these fields exists in production (by the record; not queried).
- The specs use the unit `n`, the seed's hypothesis is `count`, and no conversion between them is seeded.
- Switch conditions (`CURRENT_STATE.md`, "Separate tasks"): **1** (a fresh restore-verified backup) unmet, no
  Supabase method defined (`docs/runbooks/gpexe-in-app-import.md:747-773`; `backend/scripts/gpexe-backup-verify.mjs`
  refuses any source but localhost); **2** (bounded lock waits before an approval's COMMIT, and the deployed request
  timeout confirmed) unbuilt; **3** (the undo takes the team lock) unbuilt; **4** and **5** are required before
  regular production imports; **6** and **7** are built and deployed (PR #153, #154).
- No sanctioned undo exists for a persistent database (`docs/runbooks/gpexe-undo-imported-session.md:100-127`), and no
  read-only post-check of an import exists.
- Recorded "before M6": the pinned step's cap and Q1 (c), refusing to archive a club that holds a mapping version
  (`CURRENT_STATE.md:3686-3696`); F3c4 is ordered before a controlled real import by the F3c plan
  (`CURRENT_STATE.md:855-865`); the production-use gate and the link gates (1) and (2) are not recorded as confirmed.

---

## 2. Pull requests

| PR | Content | Migration | Merge path (proposal; R1, R3) |
|---|---|---|---|
| **9-A** | This contract (docs only) and its pointers in the plan and the discovery document | — | The owner accepts the contract (A1) before any code; the *Rukovodilac*'s and the *Nezavisni revizor*'s GOs |
| **9-0** | Switch conditions 2 and 3 (section 9), reserved since 7g (`metrics-core-plan.md:1075-1078`) | none | Standing merge order after both GOs (trigger 4; it imports `gpexeImportService.js`, which `server.js` and `gpexeRetentionCli.js` load at start-up, so the PR body states that nothing new runs or writes at start-up) |
| **9-B** | The writer and the mapper through mappings (sections 3–7), the frontend text of the Imports review (R14), the tests of section 8 | none (R2) | Both GOs; the deploy changes what a check shows for a bound team (section 7.3), so the owner decides when it is deployed (O13) |
| **9-R** | The M6 runbook and the executor's prepared material (section 10.3): the Supabase backup procedure draft, the pre-switch and post-import SELECT files, the proposals for variables and mappings, the record-table row | none | M6 material, outside the green zone (`metrics-core-plan.md:1120`): the owner's word |
| **9-E** | Facts after each merge (CURRENT_STATE, the J M4 row "As built", the ADR-007 extension) | none | Standing merge order (facts only) |

A migration is not planned. Should one become necessary (for example C98's canonical-row guard, R2), it is its own PR
under the standing order for migration PRs, and it must not guard T6, T7 or `metric_values` with a savepoint refusal:
the import runs inside a savepoint (section 3, step 9).

---

## 3. The writer's new path (9-B), in lock order

The approval runs the steps below and commits; the check-time preview runs steps 3–11 for each session and rolls back
(R10). Steps 1–2 are today's prefix, unchanged.

1. **The prefix.** The switch refusal before `pool.connect`; `begin`; the approver rights `FOR SHARE`; the candidate
   `FOR UPDATE`; the existing refusals (`gpexeImportService.js:2161-2212`). 9-0's bounds are set before the first lock
   (section 9).
2. **The team import lock** (`lockTeamForImport`). C57's "the team import lock first, as today" is read as *first among
   the importer's own locks*, after the approval's prefix (v23 `:16-23` documents that order; R5).
3. **The binding.** At an approval: the candidate's `last_seen_check_id` → `gpexe_import_checks.source_binding_id`
   (`gpexeImportService.js:898`); that binding is read `FOR SHARE` and must be `active` and the team's one active
   GPEXE binding. A candidate last seen by a `legacy_env` check, a missing, ended or other binding → `409
   preview_changed` with the refreshed preview `blocked` `mapping_not_usable`. At a check: the resolver's facts of
   that run (`sourceImportCredentialResolver.js:174-224`). The v27 credential connection's state is not a condition
   (C55); its `host_key` is read without a lock.
   - *Lock order note.* The discovery document's order is registry → binding → connection
     (`discovery:1213-1216`). Reading the binding `FOR SHARE` before the registry rows departs from it; both are
     `FOR SHARE`, and no writer takes the binding exclusively after a registry row (an Unbind takes the binding with a
     2 s `lock_timeout` and never a registry row; C58). R5 asks the *Rukovodilac* and `db-reviewer` to accept either
     this order or a re-read of the binding after step 5.
4. **The open activations, unlocked.** The T5 rows with `source_team_binding_id` = the binding and `ended_at is null`,
   joined to T4 (factors, units, `source_parameters`, the pinned definition and version, the levels), T3, T2a
   (`source_system`, `api_family`, `source_metric_key`) and T2b (`value_shape`, `parameter_kind`, `source_unit`,
   state, `evidence_status`). Ordered by T5 id.
5. **The registry locks and the re-check.** T2b → T3 → T4 → the canonical `metric_definitions` row → T5, each
   `FOR SHARE`, ascending by id within a table (the D order, `discovery:1213-1218`); then the rows are compared with
   step 4. Any difference (an ended activation, a disabled version, a retired revision, a changed definition) →
   `409 preview_changed`; the next check → `mapping_not_usable`. The approver's role and user rows were taken in step 1,
   before the registry — a second departure from D's "after every registry row", safe because the importer holds them
   only `FOR SHARE` and no role writer waits on a registry row (`discovery:1217-1218`; R5).
6. **The Metrics Core connection `FOR UPDATE`.** The team's **active** team-owned v11 row for `gpexe` (v20: at most one
   per team, `metric_source_connections_one_active_gpexe_per_team_idx`); an inactive row (ended by 7g) is never used
   again and never reactivated (v50).
   - No active row: one is inserted with the T7 keys in the INSERT (`source_host_key` = the credential connection's
     `host_key`, `source_instance_key` = the binding's `source_team_id`). A `23505` on
     `metric_source_connections_one_active_instance` (another team holds the triple) → `source_instance_held` (whole
     candidate; no holder named).
   - The active row, keys NULL (a row written before M4): the keys are set from NULL (the write-once trigger allows
     it); a `23505` → `source_instance_held`.
   - The active row, keys set: they must equal the binding's, else `source_instance_changed`.
   - The row read `FOR UPDATE` is re-checked `active` (the 7g prerequisite, `phase7g…:182-187`; a 7g end cannot run
     meanwhile, because it takes the team lock as a try-lock): otherwise `mapping_not_usable` (R6).
   - The session's `team_session:<id>` identity exists under another v11 row with the same triple (any state) →
     `session_imported_under_another_instance`.
   The keys are set before the first T6 row, because T6's check 12 compares them with the binding. From here on no
   stronger lock on this connection is ever asked for (C57): the v11 / v12 triggers' `FOR UPDATE` on it in step 9 is
   already held.
7. **The plan (pure, no lock).** Built **after** the locks, from the stored bundle and the locked activation set:
   one `metricSpec` per activation, whose `extract` is `extractorFor(source_system, api_family, source_metric_key)`
   with the version's `source_parameters` (never a bound or threshold from code, discovery section E), at the
   version's levels (`applies_to_session` → `full`, `applies_to_drill` → `drill`). A missing extractor or a revision
   `extractabilityCode()` refuses is `mapping_not_usable`. The session gates and the per-athlete exclusions of
   today's mapper are unchanged (`gpexeImportMapper.js:221-267, :277-387`): an athlete with several tracks, invalid
   statistics or more than one whole-session row is left out as today, before any requirement is judged (C18,
   section F row 3).
8. **Classification (section F), whole candidate first.** In this order, the first that applies decides:
   - a threshold-contract skip (`team_threshold_missing`, `team_threshold_split`, `threshold_mismatch`,
     `duration_mismatch`, `zone_boundary_missing`, `zone_boundary_ambiguous`) on any admitted athlete under any
     activation → `blocked`, `source_threshold_contract_mismatch`;
   - `unexpected_unit`, or a unit in the answer different from the revision's proven `source_unit` (R7) →
     `source_unit_mismatch`; a value of another shape than the revision's → `source_shape_mismatch`;
   - a converted value outside the canonical version's `min` / `max` → `blocked`, `canonical_value_out_of_range`
     (new, R8; today the v13 trigger raises an untyped error whose text carries the value, and the approval logs it,
     `v13:310`, `gpexeImportService.js:2295`);
   - a missing value (`zones_missing`, `zones_not_ready`, `zone_distance_missing`, `events_missing`, `count_missing`,
     `details_not_fetched`, `field_missing`, `value_missing`, `total_time_missing`, `total_distance_missing`,
     `max_v_missing`) of an admitted athlete on a level the activation covers: under `required` →
     `required_value_missing` (whole candidate, no partial import, never a zero, C14); under `optional` → a "Left out"
     entry with its reason (C15). A drill an athlete has no row for is not a missing value (R9);
   - no value at all to write → `blocked`, **`no_mapped_values`** (R4; never Ready, C17).
   The precise code reaches a platform admin and the owning club's admin; a coach gets the stable sentence to contact
   an administrator; no refusal names another team, club, connection, instance or holder (`discovery:1892-1895`).
9. **`savepoint gpexe_preview_import`, then the writes.** The identities `FOR UPDATE` (with the `team_session:<id>`
   reservation), the event, the threshold-set binding, segments, participants, the materialized activity and drill
   components — as today. **`ensureMetricDefinitions` is gone** (C46): every value uses the T4-pinned
   `metric_definition_id` and `metric_definition_version_id`; a canonical definition lacks the needed scope capability
   (`session` or `component`) → `mapping_not_usable` before the savepoint (R11).
10. **Values, then T6.** `value_numeric` is the decimal **string** `convertAtStorageScale` returns (never a JS double);
    `unit_at_capture` is T4's target unit. One T6 row per value: `activation_id`, `mapping_version_id`, the binding,
    `mapping_id`, `source_metric_version_id`, the connection, `source_unit` (T2b's), `source_value_numeric` (the
    extractor's value as an exact decimal string). The writer checks C55's conditions before it writes, for its stable
    codes; the trigger is the backstop, and a `23514` from it inside the savepoint is answered as `internal_error`
    with nothing written (never a value without its T6 row). Never a stronger lock after a T6 insert.
11. **Hashes.** The occasion content hash gains the mapping version id and, per value, the source value and unit
    (`discovery:1645-1648`): a session re-imported under a new mapping version is `needs_review`, never a silent
    supersede. The preview hash gains the sorted set of `(activation_id, mapping_version_id)` (`discovery:1883`).
12. **The approval's end, unchanged:** the hash compared again, the approval row, the candidate `imported`, the
    observations, the bounded COMMIT and its five-point outcome rule.

---

## 4. A value's identity and the preview (preview version 3)

One source field may carry several mappings (the closed power zone serves 25–60 and 60–75; the uniques are keyed by
`(field, parameter_fingerprint)`, `v34:892-893, :1337-1339`), so a source key alone cannot name a value.

- **In the writer and the occasion content hash:** the canonical `metric_definition_id` and the mapping version id.
- **In the preview hash:** the activation set of step 11, plus each value's `activation_id`.
- **In the preview JSON** (`PREVIEW_VERSION` 2 → 3, `gpexeImportPreview.js:22`): each value entry carries
  `activationId`, `mappingVersionId`, the canonical `variableKey`, `label` and `unit`, the converted `value` (decimal
  string), the source `sourceMetricKey`, `sourceParameterFingerprint`, `sourceValue` (decimal string) and `sourceUnit`,
  `previous` and `change`. A "Left out" entry carries the activation and its reason. `METRIC_BY_KEY` and the spec
  labels are no longer used for a mapped value.
- **The changed / same label** compares the normalized decimal strings exactly; `1e-9` stays only as the
  characterisation test's tolerance against today's doubles (R13).
- **The Link athletes helper values** (Time, Distance, Top speed) no longer come from preview values, which an
  unmapped session would not have: they are computed from the stored snapshot through the three `athlete_session`
  extractors in the source units (s, m, m/s) and shown converted for display only (min, m, km/h), independent of any
  activation (R12). Gate (2) relies on them.

---

## 5. Today's `gpexe_*` definitions (C46)

- **Creation stops** at all four entry points: the approval (committed), the check-time preview (rolled back),
  `importGpexePlan` used by `backend/scripts/gpexe-import-pilot.mjs:24` and by
  `backend/scripts/gpexe-pilot-disposable-run.mjs:146, 156` (disposable databases only), and the tests. The two
  scripts take a mapped plan or are retired (R15). An architecture test in the B7 style refuses any INSERT into
  `metric_definitions` (and its versions and capabilities) from the importer modules (`discovery:1888-1890`).
- **Existing rows** are left as they are: never deleted, never reinterpreted (ADR-007 decision 3), never mapping
  targets (`sourceMetricMappingService.js:584`, `canonicalVariableAdminService.js:354-361`); the undo keeps them
  (`gpexe-undo-imported-session.mjs:43-44`). None is expected on the deployed or the local OPTIMOVE database (A9;
  by the record, not queried). A cleanup is not in this contract.
- **Read sites changed in 9-B:** the preview's `currentState` (`gpexeImportPreview.js:86-98`, now by definition id),
  `METRIC_BY_KEY`, `SOURCE_ATHLETE_VALUE_KEYS` (section 4), the frontend key lists. The read-only probe
  `backend/scripts/gpexe-details-coverage-probe.mjs:34, 52-61` keeps its own list (it imports nothing).
- **The legacy path.** A `legacy_env` team has no binding and therefore no activation: its candidates are
  `blocked` `mapping_not_usable` (C2: no source creates a definition; the e03 `api` family has no extractor,
  `sourceMetricExtractors.js:7-9`). Retiring the environment token stays F3c4 (O4).

---

## 6. Codes

| Code | New? | Where | Audience |
|---|---|---|---|
| `mapping_not_usable` | new | check: candidate `blocked`; approval: `409 preview_changed` | admins precise, coach the sentence |
| `source_threshold_contract_mismatch`, `source_unit_mismatch`, `source_shape_mismatch` | new | candidate `blocked` | same |
| `required_value_missing` | new | candidate `blocked`; the detail names the athletes by their OptiMove identity and the level, for the two admins | same |
| `canonical_value_out_of_range` | new (R8) | candidate `blocked`; never the value | same |
| `no_mapped_values` | new (R4) | candidate `blocked`, never Ready; `nothing_to_import` keeps its meaning `no_changes` | same |
| `source_instance_held`, `source_instance_changed`, `session_imported_under_another_instance` | new | candidate `blocked` | same; no holder named |
| `source_metric_target_taken` | exists | a mapping-service refusal (`sourceMetricMappingService.js:364, 408, 1446`), **not** an importer code (the discovery's audience list at `:1892-1895` names it) | — |

A coach's Imports screen shows one sentence for all of them ("This session can't be imported until an administrator
finishes its data setup."), a platform admin and the club's admin the precise reason. No code text reaches a log with
a value.

---

## 7. Stored candidates and the deploy

### 7.1 Pre-M4 candidates

M4 does not change the bundle, so a check reports them **unchanged**. Their stored preview and hash change once: at the
first successful check after the 9-B deploy (the finalization refresh), or at an approval that is refused with
`preview_changed` and stores the recomputed preview itself. The J M4 row's "the stored candidates turn *changed*
exactly once" (`discovery:2044`) is amended in 9-B to this mechanism (R13); the test pins both refresh paths.

### 7.2 Snapshot expiry

Unapproved snapshots expire 30 days after the last sighting (`gpexeImportService.js:33`). Only a GPEXE search
refreshes them; the executor never sends one.

### 7.3 What the 9-B deploy changes while the switch is off

The check path has no switch: from the first check after the deploy, a bound team's sessions are judged through its
activations. Without any activation every session of the First team is `blocked` `no_mapped_values` (never Ready), so
"Ready to import 2" becomes "Needs attention"; the Link athletes helper values stay (section 4). No import can happen
(the switch is off). The way back is a revert PR (no migration). **O13:** the owner decides whether 9-B is deployed as
soon as it is merged, or only after M6 steps 2–6 (the activations exist before the deploy, so the screen goes from
today's previews straight to mapped ones; the old importer ignores activations).

---

## 8. Tests (9-B)

### 8.1 The characterisation test (the plan's acceptance)

Two fixtures, two runs, because the pinned counts and the rounding-sensitive values come from different bundles:

- **Arm A1 — the writer, counts.** `backend/tests/_gpexe-fixtures.mjs` `makeBundle({ athletes: standardAthletes() })`
  (team 77, session 5001, athletes 101 / 102 / 103, thresholds 1473, `detailsDrills = [0]`). Eleven system variables
  and eleven active mappings (time s → min `/60`; distance m; max speed m/s → km/h `×3.6`; the two closed power zones
  25–60 and 60–75, the open top ≥ 75; the speed zone ≥ 7 m/s; acceleration and deceleration ±2.5 m/s² with 0.3 s;
  burst and brake), every activation `optional` at both levels, written through the guarded fixture
  (`backend/tests/support/source-revisions.mjs`, every guard on). The oracle is a frozen copy of
  `GPEXE_METRIC_SPECS` under `backend/tests/support` (7f test 9's pattern), one double per (athlete, level, legacy key).
  Asserts:
  1. the set of (athlete, level, metric) written equals the oracle's non-skipped set (athlete 103 left out for
     `multiple_tracks`; burst and brake of drill index 1 left out `details_not_fetched`); no extra value, no zero;
  2. per value `|value_numeric − oracle| ≤ 1e-9` (absolute, as `gpexeImportPreview.js:137`) **and**
     `value_numeric::text` equals `convertAtStorageScale` exactly;
  3. one T6 row per value of the import, `source_value_numeric` equal to the extractor's output;
  4. the T7 keys set once;
  5. the structural counts equal today's pinned ones (`gpexe-import.test.mjs:279-358`: 1 event, 2 segments,
     2 participants, 6 identities, 1 batch, 5 occasions, 53 values, 1 activity, 2 components, 2 links, 1 threshold-set
     binding) except definitions, versions and capabilities: **0 new**;
  6. `metric_definitions`, its versions and scope capabilities digest-identical before and after.
- **Arm A2 — the real route, rounding.** `backend/tests/support/preview-bundles.mjs` `previewBundle` (values chosen to
  round at the 10th decimal; three kept athletes and a two-track fourth, `detailsDrills [0, 1]`), the same
  activations, approved through the real `approveCandidate` route with the switch on in the test process only:
  assertions 2, 3, 4 and 6, and the counts this bundle gives (recomputed in the test, not copied).
- **Arm B — no activation.** The same two bundles with no activation, and again with an activation on an ended
  binding: the check preview is `blocked` `no_mapped_values`; the approval is refused before any write; zero new rows in
  `metric_values`, occasions, identities, events, participants, segments, activities, components, T6, and the
  definition tables (digest). Today's mapper does not refuse a plan with no values (`gpexeImportMapper.js:386` refuses
  only "no athlete admitted"), so this gate is new.
- **Arm C — a pre-M4 candidate.** Stored with today's preview v2: the first approval answers `preview_changed` and
  stores the recomputed preview; a second approval with that hash imports exactly once. Separately: one check refreshes
  the preview, reports the session unchanged, and the approval imports once.

### 8.2 Also in 9-B

- Every code of section 6 through the real route, with the admin / coach audience split and no holder named.
- `required` against `optional`, including the drill-level rule of R9.
- The preview hash changes when an activation ends between preview and approval; the content hash changes under a new
  mapping version (`needs_review`).
- The seven COMMIT-outcome tests (`gpexe-in-app-import.test.mjs:1508-1763`) re-run with activations on.
- Concurrency (two real connections each): the import against a 7d version end (its T5 `FOR NO KEY UPDATE` waits);
  against an Unbind (`try_again` at the team lock, C58); against a 7g instance end (its try-lock); two approvals of the
  same team; no `40P01` in any order (C57). Each wait falls under 9-0's bound.
- The undo removes T6 first on an M4-imported session (C47; disposable only).
- Architecture tests: no `metric_definitions` insert from importer modules; no value without its T6 row; no mapped
  value without an extractor (`phase7f…:336-337`).
- The approval of a team or club archived after the route's check (R16).
- Mutation evidence for every new guard.
- Tier: `test:gpexe` and the disposable suites; `test:backend:shared` only if non-GPEXE Training Load is touched
  (`agent-efficiency.md` §6); the frontend file of the Imports screen and `test:frontend:fast` for R14; the production
  build.

---

## 9. 9-0: switch conditions 2 and 3

- **Condition 2.** `approveCandidate` (and the batch, which calls it) sets, right after `begin` and before the first
  lock, `SET LOCAL lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` (values proposed in the
  PR, below the client's and the route's bounds); a `55P03` / `57014` before the COMMIT is `409 try_again` with
  nothing written; the COMMIT keeps its own 15 s bound and the five-point rule. A test proves the bound covers the
  advisory team lock and a row lock, and that a bounded refusal writes nothing. The second half of condition 2, the
  deployed request timeout (Render and any proxy), is an owner step (section 10, step 7).
- **Condition 3.** The undo script takes `lockTeamForImport` after its `user_global_roles` read and before
  `metric_events` (the importer's order: rights → team lock → identities and events), still on disposable databases
  only; a test proves an undo waits for a running import of the same team and the reverse.
- Reviewers: `code-reviewer`, `db-reviewer` (trigger 4).

---

## 10. M6: the owner's red-zone steps

Every OWNER step needs the owner's own word for that case (`metrics-core-plan.md:143-175`); a relayed word needs a
verbatim quote and its event id. EXECUTOR-PREPARES means text, SQL files or procedures only; the executor sends no GPEXE
request, reads or writes no persistent database, and touches no Render or Supabase setting.

### 10.1 Now, independent of the code (phase P)

- **P1. OWNER — the C97 unit evidence, before the snapshots expire (05–06.10 around 2026-11-10).** Blocks 1–3 of
  `docs/runbooks/gpexe-c97-unit-evidence-owner-procedure.md` in the Supabase SQL Editor, the comparison in the GPEXE UI
  for sessions S1 and S2 and athletes A–C, a sanitized table back (factors and booleans only). In the same pass the link
  gates: (1) the count of non-canonical `gpexe_athlete_id` (expected 0, only the number) and (2) the helper values
  against GPEXE for two or three athletes (`docs/runbooks/gpexe-owner-pilot-f3c3.md:142-199`). If P1 cannot run before
  the expiry: either on the 11.10–24.10 snapshots (around 2026-11-23, inferred) or after a refreshing search the owner
  orders (a GPEXE request).
  - EXECUTOR-PREPARES: the evidence document with its anchor (its merge needs the owner's word). `max_v`'s value is the
    details field `max_values_speed`, canary-checked against the row's own `max_v` (C97 runbook `:21-27`); the document
    says so.
- **P2. OWNER — the meaning evidence for every pilot field** (not only burst and brake: `verified` needs both acts):
  the official handbook or a written answer of GPEXE support (C97, `discovery:813-817`); O7 decides whether the GPEXE 6
  handbook counts for a server reporting 9.11.8.

### 10.2 After the evidence (may run before 9-B is deployed; the old importer ignores them)

1. **OWNER — decisions O1–O12** (section 12.2).
2. **OWNER — the first field confirmations** (a separate order, `metrics-core-plan.md:827-828`): the unit act and the
   meaning act in Source fields, as an active platform admin in the platform workspace; each is written once.
   EXECUTOR-PREPARES: the exact units, operators and evidence anchors.
3. **OWNER — the system variables** in Variables. EXECUTOR-PREPARES: names, keys, units, daily aggregation (sum; max
   for speed), the `session` and `component` levels.
4. **OWNER — the mappings**: create, draft, submit, activate (Mappings screen). EXECUTOR-PREPARES: the list with the
   seeded conversions (s → min, m/s → km/h).
5. **OWNER — switch them on for the First team's binding**, with an explicit requirement for each (O6).
6. **OWNER — the merge and deploy of 9-0 and 9-B** as O13 decides (a deploy is the *Rukovodilac*'s under its Render
   key, on the owner's order).
7. **OWNER — confirm the deployed request timeout** (Render and any proxy; condition 2's second half). A Render setting
   stays the owner's.
8. **OWNER — one check with the switch off** on a small window that holds the target session. Stop on any failure code
   and repeat nothing. Acceptance (M6): the aggregate preview of the saved candidate shows the converted values in the
   canonical units, and the candidate is *Ready to import* with the expected requirement outcome.

### 10.3 The import window

9. **OWNER — a fresh backup of the chosen environment, restore-verified** (condition 1). Local: `gpexe-backup-verify.mjs`
   prints VERIFIED and writes `<dump>.verify.json`. Supabase: the method O2 decides; "fresh" means no write to the
   import tables between the backup and the switch-on (checked by step 10). EXECUTOR-PREPARES: the Supabase procedure
   draft and the record-table row (`gpexe-in-app-import.md:747-773`).
10. **OWNER — the read-only pre-switch preflight** (EXECUTOR-PREPARES a SELECT-only file; the owner runs it, or the
    *Rukovodilac* through its connector if the owner extends that right): the served commit equals `main`, no migration
    undeployed; no running check; the target candidate actionable (last check `succeeded`, drill effect `confirmed` or
    `not_required`), its preview v3 `ready`; the open activations and their requirements as decided; the T7 keys of the
    First team (NULL or the expected triple); the un-revoked coach approver grants of the team (expected none, or the
    owner accepts them); the non-canonical link count 0.
11. **OWNER — the freeze**: no merge or deploy until step 14 (the *Rukovodilac* included); the First team's coaches told
    not to run a check in the window.
12. **OWNER — switch on**: `GPEXE_IMPORT_APPLY_ENABLED=true` in Render for the chosen environment only. Whether the
    service must restart for it to take effect is not verifiable from the repository; the owner confirms "on" through
    the Imports status (`importSwitch`) before step 13, never by assumption.
13. **OWNER — exactly one approval** through the single-candidate route with its `previewHash` (never the batch). On
    `503 import_outcome_unknown`: the `verify` links, never a blind retry (`gpexe-in-app-import.md:393-532`). No roster
    decision on the imported activity until step 15 passes (the undo refuses after one).
14. **OWNER — switch off at once**, confirmed through `importSwitch`; "Switch off at" in the record row; the freeze ends.
15. **OWNER — the read-only post-import check** (EXECUTOR-PREPARES the SELECT file; none exists today): the approval read
    (`GET …/approvals/:approvalId`, `routes/gpexeImport.js:212`); the candidate `imported`; the counts equal the
    preview; no new `gpexe_*` definition; T6 rows = values of the import; the T7 keys set; no zero where the preview
    left a value out.
16. **OWNER — the facts PR** (the owner's word).

**On any anomaly at any step: stop.** No sanctioned production undo or scripted restore exists; the owner decides
(O3).

---

## 11. Reviewers and gates

- **9-A:** the *Rukovodilac* and the *Nezavisni revizor*; the owner's acceptance (A1). No internal reviewer is needed
  for a contract without code, beyond a `code-reviewer` pass on the whole document (the matrix's docs row).
- **9-0:** `code-reviewer`, `db-reviewer`; trigger 4.
- **9-B:** `code-reviewer`, `security-reviewer`, `db-reviewer` (the J M4 row); `mobile-qa` and `ux-design-reviewer`
  if the Imports review's layout changes (R14); triggers 1, 2, 3, 4 and the five-point rule; then the *Rukovodilac*'s
  and the *Nezavisni revizor*'s ★★ reviews.
- **M6:** triggers 1 and 5 (only fake-source evidence exists for an irreversible write); the owner's external review.

---

## 12. Decisions

### 12.1 For the *Rukovodilac*

- **R1 The PR split** of section 2. Recommendation: yes.
- **R2 No migration in phase 9.** C98's canonical-row guard stays an optional later hardening (`discovery:871-873`
  reads "before M4"; R2 asks whether that is binding). Recommendation: no migration; the architecture test is the guard.
- **R3 Merge paths** of section 2. Recommendation: as written; 9-B's deploy by O13.
- **R4 `no_mapped_values`** as a new code; `nothing_to_import` keeps `no_changes` (it is "up to date" on the screen,
  `frontend/gpexe-import-view.js:65, :177, :765, :1717`). Recommendation: yes.
- **R5 The lock order** of section 3 (the approval prefix first; the binding before the registry, or re-read after it;
  the approver rows before the registry). Recommendation: accept, with `db-reviewer`'s confirmation in 9-B; it amends
  the wording of C57 and D, recorded in the discovery document.
- **R6 A Metrics Core connection found inactive under its `FOR UPDATE`** (reachable only by a raw write, since a 7g end
  needs the team lock): `mapping_not_usable` (recommended) or a new code.
- **R7 The details unit check:** compare with the revision's proven `source_unit` instead of the literal `'number'`
  (`sourceMetricExtractors.js:140`); either way a mismatch is `source_unit_mismatch`. Recommendation: the proven unit.
- **R8 `canonical_value_out_of_range`** pre-checked under the locks, the value never logged. Recommendation: yes.
- **R9 The drill-level "missing" under `required`:** a drill the athlete has no row for is not missing;
  `details_not_fetched` is. Recommendation: yes, with a test.
- **R10 The check-time preview runs the full path** (T6 and T7 included) and rolls back. Recommendation: yes.
- **R11 A canonical definition without the needed scope capability** → `mapping_not_usable` before any write.
  Recommendation: yes.
- **R12 The helper values from the snapshot** through the extractors, independent of activations. Recommendation: yes.
- **R13 The `1e-9` tolerance** absolute (today's code) for the characterisation only, and the J M4 row's "changed
  exactly once" amended to the mechanism of section 7.1. Recommendation: yes.
- **R14 The frontend in 9-B:** the Imports review shows the canonical name and unit and the source value; phase 8's
  R18 sentence is removed (`phase8-mappings-screen-contract.md:467-468`). Recommendation: in 9-B.
- **R15 The pilot CLI and the disposable-run script:** take a mapped plan (they need activations on their disposable
  database) or are retired. Recommendation: take a mapped plan; both stay disposable-only.
- **R16 A team or club archived after the route's check:** the approval re-reads the team and the club `FOR SHARE`
  after the team lock and answers the identical 404. Recommendation: yes (a test).

### 12.2 For the owner

- **O1 The environment of the first import.** Production (the First team's binding exists only there) supersedes the
  plan of 2026-09-18 ("F4: the first real local import", `CURRENT_STATE.md:3938, :4001`); the local OPTIMOVE is
  recorded at v21, with no GPEXE table. Recommendation: production, only after O2 and O3.
- **O2 The Supabase backup and its restore check**, and what "fresh" means. The local script refuses Supabase.
  EXECUTOR-PREPARES a procedure draft in 9-R.
- **O3 The way back.** (a) A full restore is the only remedy for the pilot — it also rolls back every unrelated write
  since the backup (for example the R2 media rows and quotas, whose objects stay in the bucket); or (b) the undo is
  unlocked for production first (an authenticated identity, a narrow credential, a second person's approval, an
  external review). Either way: after an undo the candidate stays `imported` and its approval is append-only, so the
  same session cannot be imported again without a further decision; the undo refuses once a roster decision exists.
- **O4 F3c4 before the controlled import** (the F3c order of 2026-10-05, `CURRENT_STATE.md:855-865`), or after it.
  The bound First team cannot read the environment token (v31).
- **O5 Q1 (c) and the pinned step's cap**, both scheduled "before M6" (`CURRENT_STATE.md:3686-3696`): built before
  step 2, or waived for a pilot of system mappings only.
- **O6 The pilot's fields and each activation's requirement.** (a) minimal: `total_time`, `total_distance`, `max_v`
  (no operator needed); (b) plus the zones and events; (c) all eleven. Recommendation: (a), all `required`.
- **O7 The meaning evidence:** whether the GPEXE 6 handbook counts as official documentation for a server reporting
  9.11.8, or a written GPEXE support answer is needed.
- **O8 The count unit** (only if O6 includes an event count): `count` as the proven source unit, or `n` with a new
  conversion row.
- **O9 The C97 timing:** P1 on the 05–06.10 snapshots before about 2026-11-10, on the 11.10–24.10 snapshots before
  about 2026-11-23, or after a refreshing search (a GPEXE request).
- **O10 The gates' state:** the production-use gate (identity, minors included) and link gates (1) and (2).
- **O11 Condition 5** (a team archived during a running check): closed by F3c2g's re-checks, or still open (needed
  before regular imports, not before the pilot).
- **O12 The plan lines:** the owner adds phase 9's "Input (red zone)" and "Start" lines, or states that section 10 of
  this contract is the phase's red-zone list.
- **O13 When 9-B is deployed** (section 7.3): at once after its merge, or after M6 steps 2–5.

---

## 13. Risks

- **The snapshot expiry** (P1, O9).
- **More locks per approval** while condition 2 is unbuilt; 9-0 comes first.
- **The visible change at the 9-B deploy** (section 7.3, O13).
- **No production undo** (O3); a restore loses every later write.
- **A whole candidate blocked by one athlete** under `required` (C14).
- **Unconfirmed meanings** (burst and brake; every field's meaning needs P2).
- **The production state is inferred, not queried:** no `gpexe_*` definition, no Metrics Core connection for the First
  team, no confirmed revision, no canonical variable.
- **The switch's effect after a Render change** is not verifiable from the repository (step 12).
- **Short rosters** for sessions from before an athlete's membership (an open risk of `CURRENT_STATE.md`).
- **"Nine" against "ten" fields** in the plan and CURRENT_STATE against J4 and the C97 runbook (v42's open top zone).

---

## 14. Not in this contract

The switch's default or how it is read; regular production imports and conditions 4 and 5; Link and Unlink; several
tracks (M5, phase 10) and estimates (phase 10, no T6); derived variables (phase 11); the session list and drill reads;
7h, 7i and R1; a production undo (unless O3 (b)); F3c4 (unless O4); a new source or adapter; a cleanup of existing
`gpexe_*` definitions; any GPEXE request, persistent-database read or write, Render or Supabase setting or credential
by the executor.
