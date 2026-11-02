# J17 — phase 9: the importer writes through mappings (M4), and the first controlled import (M6) (proposed ★★ contract)

This is the contract of phase 9 of `docs/ai/metrics-core-plan.md` ("### Phase 9 ★★: M4, the importer integration") and
of the owner-run M6 that follows it. It is the M4 and M6 rows of section J of
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*), built on what phases 1–8 delivered
(v34–v50, the routes of J1–J13, the Mappings screen of J16). J14 and J15 stay reserved for 7h and 7i.

| | |
|---|---|
| Status | **Accepted** by the owner on 2026-11-01 (A1; turn `e34ccb50`, 21:23:53 UTC, section 12.3), with O1, O3–O6, O8, O9 and O11–O16 decided as recommended; O10 decided the same day (turn `bdb881f2`, section 12.3). Proposed (merged as PR #311, `798d355`, exactly from `e57f854d`, after both ★★ GOs; amended for the owner's decisions of 2026-11-01, C110 and O2, section 12.3) by the executor on 2026-11-01, on the *Rukovodilac*'s order of that day („Posle merge-a: faza 9 (prvi kontrolisani uvoz, M4/M6). Pošalji mi plan ili ugovor faze 9 pre koda, sa jasnim spiskom koraka koje radi vlasnik (crvena zona: prekidač za uvoz, backup, GPEXE).”). No phase 9 contract existed; the plan holds a stub (`metrics-core-plan.md:1114-1120` at the base). **No code is written before this contract is accepted.** |
| Verified against commit | `1932ad1` (merge of PR #310). Every file and line reference is to that commit unless marked otherwise. |
| Mark | ★★ (triggers 1, 2, 3 and 4 — trigger 2 added by this contract for sections 4.1 and 6.1, the plan's phase 9 line naming 1, 3 and 4 (R3); the five-point rule for transactions with an external effect). For a ★★ phase the owner approves the contract before any code (`metrics-core-plan.md:450-452`). |
| Owner decisions | Section 12.2 (O1–O16). The plan's phase 9 has no "Input (red zone)" or "Start" line; those are written only on the owner's own word, never by relay (`metrics-core-plan.md:432-435`). |
| Decides | The owner: O1–O16. The *Rukovodilac*: R1 and R3–R18 (section 12.1; R2 became O14). The *Nezavisni revizor* reviews this contract and 9-B (★★). |

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
restore-verified backup under a freeze, the switch on, exactly one approval, the switch off, a read-only post-check. The executor
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
2. `begin` (`:2171`); `lock_gpexe_import_approver` (role, grant and user rows `FOR SHARE`, `:2173-2176`; v23 `:33-57`,
   its order documented at v23 `:16-23`); the candidate `FOR UPDATE` (`:2179-2184`); the existing refusals (`:2185-2212`), among them
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
| **9-A** | This contract (docs only) and its pointers in the plan and the discovery document | — | The owner accepts the contract before any code (the plan's rule A1); the *Rukovodilac*'s and the *Nezavisni revizor*'s GOs |
| **9-0** | Switch conditions 2 and 3 (section 9), reserved since 7g (`metrics-core-plan.md:1075-1078`), and the same bounds on the check-time preview | none | Standing merge order after both GOs (trigger 4). It touches condition (b) of the order — `gpexeImportService.js` is a module `gpexeRetentionCli.js` and `startGpexeRetentionSchedule()` call — so it is covered only when its body says what then runs at start-up and on a schedule and why it writes nothing to production data, and the GO confirms that (`metrics-core-plan.md:193-211`) |
| **9-B** | The writer and the mapper through mappings (sections 3–7), the audience mechanism (section 6.1), the frontend of the Imports review (R14), the tests of section 8 | none (O14) | Both GOs, then **the owner's word naming the merge and the deploy** (O13): the deploy puts the new write path live and changes what a check shows for a bound team (section 7.3). While auto-deploy is off (every deploy since 2026-10-28 was started by hand, `metrics-core-plan.md:266-268`), the deploy of any commit of `main` that carries 9-B is started only on the owner's word naming it, not under the *Rukovodilac*'s "a deploy without a migration after a merge, as needed" (`:373-375`, R3); while auto-deploy is on, a merge is a deploy (`:252-256`), so the merge itself waits for that word. **Amended by the owner's work order `628d0be9`** (section 12.3): both GOs, then the merge under the standing merge order and the *Rukovodilac*'s deploy without a migration; no owner's word |
| **9-R** | The M6 runbook and the executor's prepared material (section 10.4): the Supabase backup procedure draft, the pre-switch and post-import SELECT files (each run by the executor only on a disposable `optimove_tests_*` database), the proposals for variables and mappings, the record-table row | none | M6 material, outside the green zone (`metrics-core-plan.md:1120` at the base: „M6 follows phase 9. All of it is the owner's and outside the green zone, the standing merge order included.”): the owner's word |
| **9-E** | Facts after each merge (CURRENT_STATE, the J M4 row "As built", the ADR-007 extension) | none | Standing merge order (facts only) |

A migration is not planned (O14). Should one become necessary (for example C98's canonical-row guard), it is its own PR
under the standing order for migration PRs, and it must not guard T6, T7 or `metric_values` with a savepoint refusal:
the import runs inside savepoints (section 3, steps 6 and 9). The residual without one: the T6 trigger refuses a
**wrong** provenance row (`v34:1519-1617`) but not a **missing** one (no deferred trigger requires a T6 row per value),
so "never a value without its T6 row" rests on the writer's code and the architecture test of section 8.2.

---

## 3. The writer's new path (9-B), in lock order

The approval runs the steps below and commits; the check-time preview runs steps 2–11 for each session (without
steps 2a and 6b) and rolls back (R10). Section 16 records what the 9-B pull request built and where it departs from
this text.

1. **The prefix.** The switch refusal before `pool.connect`; `begin`; 9-0's bounds (section 9); an **unlocked** check
   of the approver's right, for the early `403 not_an_approver`; the candidate `FOR UPDATE`; the existing refusals
   (`gpexeImportService.js:2161-2212`). Unlike today, the approver's role, grant and user rows are **not** locked here
   (step 6b; R5).
2. **The team import lock** (`lockTeamForImport`). C57's "the team import lock first, as today" is read as *first among
   the importer's own locks*, after the candidate row (R5).
   - **2a (approval only).** The team and its club are re-read `FOR SHARE` with the resolver's facts (`judge()`,
     `sourceImportCredentialResolver.js:200-231`: the team active, its club active, the connection owned by that
     club). Archived or moved since the route's check → the identical `404` (R16). The archive writers are single
     statements and a team move takes the team lock as a try-lock, so this read cannot wait behind them in a cycle.
     Taking the team and club `FOR SHARE` here, before the registry, departs from D, which lists club rows after every
     registry row (`discovery:1216-1218`); no team or club writer holds a registry row or the team import lock (R5).
3. **The binding `FOR SHARE`.** At an approval: the candidate's `last_seen_check_id` →
   `gpexe_import_checks.source_binding_id` (`gpexeImportService.js:898`), joined pinned to the route's team (as
   `candidateActionable` does, `:1901-1905`); it must be `active` and the team's one active GPEXE binding. A candidate
   last seen by a `legacy_env` check, a missing, ended or other binding → `409 preview_changed` with the refreshed
   preview `blocked` `mapping_not_usable`. At a check: the resolver's facts of that run
   (`sourceImportCredentialResolver.js:174-224`). The v27 credential connection's state is not a condition (C55); its
   `host_key` is read without a lock.
   - *Lock order note (R5).* The discovery document's order is registry → binding → connection
     (`discovery:1213-1216`). Taking the binding `FOR SHARE` before the registry is safe: every writer of a binding
     holds the team import lock, which the importer already holds (the v27 binding trigger, the Unbind,
     `sourceConnectionService.js:479`, and 7g's try-lock, `sourceInstanceEndService.js:235`), so none can wait on the
     importer while holding what the importer waits for.
4. **The open activations, unlocked.** The T5 rows with `source_team_binding_id` = the binding and `ended_at is null`,
   joined to T4 (factors, units, `source_parameters`, the pinned definition and version, the levels), T3, T2a
   (`source_system`, `api_family`, `source_metric_key`) and T2b (`value_shape`, `parameter_kind`, `source_unit`,
   state, `evidence_status`). Ordered by T5 id.
5. **The registry locks and the re-check.** T2b → T3 → T4 → the canonical `metric_definitions` row → T5, each
   `FOR SHARE`, ascending by id within a table (the D order, `discovery:1213-1218`; the admin writers take the same
   order, `sourceMetricMappingService.js:24-27, :1204-1208`, and T5 after T4, `sourceMetricActivationSteps.js:205-220`); then the rows are compared with step 4. Any difference (an ended
   activation, a disabled version, a retired revision, a changed definition) → `409 preview_changed`; the next check →
   `mapping_not_usable`.
6. **The Metrics Core connection `FOR UPDATE`.** The team's **active** team-owned v11 row for `gpexe` (v20: at most one
   per team, `metric_source_connections_one_active_gpexe_per_team_idx`); an inactive row (ended by 7g) is never used
   again and never reactivated (v50). D lists the connection `FOR SHARE` for a new T6 fact (`discovery:1215-1216`);
   taking it `FOR UPDATE` here, before any identity, event or T6 row, is what C57 requires, since v11 / v12 take it
   `FOR UPDATE` on every identity and event insert — never `FOR SHARE` first and a stronger lock later (R5).
   - The row read `FOR UPDATE` is re-checked `active` (the 7g prerequisite, `phase7g…:182-187`; a 7g end cannot run
     meanwhile, because it takes the team lock as a try-lock): otherwise `mapping_not_usable` (R6).
   - The T7 write runs in **its own savepoint** (`savepoint gpexe_source_instance`): no active row → one is inserted
     with the T7 keys in the INSERT (`source_host_key` = the credential connection's `host_key`,
     `source_instance_key` = the binding's `source_team_id`); the active row with NULL keys (written before M4) → the
     keys are set from NULL (the write-once trigger allows it). A `23505` on
     `metric_source_connections_one_active_instance` (another team holds the triple) → `rollback to savepoint` and
     `source_instance_held` (whole candidate). Row locks taken before the savepoint survive the rollback to it, so the
     transaction stays usable and the candidate can be stored as `blocked`. A successful write releases the savepoint.
   - The active row with keys set: they must equal the binding's, else `source_instance_changed`.
   - The session's `team_session:<id>` identity exists under another v11 row with the same triple (any state) →
     `session_imported_under_another_instance`. The lookup crosses owner scopes and returns a boolean only, never an
     id.
   The keys are set before the first T6 row, because T6's check 12 compares them with the binding. From here on no
   stronger lock on this connection is ever asked for (C57): the v11 / v12 triggers' `FOR UPDATE` on it in step 9 is
   already held.
   - **6b (approval only). The approver's rights `FOR SHARE`** (`lock_gpexe_import_approver`, v23 `:33-57`), after
     every registry row, as D orders (`discovery:1213-1219`). A right revoked since step 1 → `42501` →
     `403 not_an_approver`, nothing written. The approval row's `basis` and grant come from this locked result, not from
     step 1's unlocked check (`gpexeImportService.js:2243`). The approval row's v23 / v33 trigger then finds the rows
     already held.
   - *Why here, and what remains (R5).* Taking the rights in step 1, as today, would close a cycle with a
     platform-admin revoke and a 7d operation: the revoke locks every active platform admin `FOR UPDATE` in id order
     (`routes/organization.js:522-531`, `:962-978`); a 7d operation holds its registry rows and then waits for its own
     admin's rows `FOR SHARE` (`source_metric_require_platform_admin`, `v34:167-173`); the importer, holding the
     approver's rows, would wait for that registry row. Step 6b removes that cycle. It does **not** make the approval
     cycle-free: the roster commands take the actor's rights first and the team import lock second
     (`lock_activity_decider`, v26 `:750-759`; `activityRosterCommands.js:9-19, :278-283`), the inverse of the
     importer's team lock → rights, so a roster command by one platform admin, a revoke and an approval by another can
     still form a cycle. A check-time preview started by a platform admin is in the same class (its event row's
     `created_by_user_id` takes `FOR KEY SHARE` on the user's row, `gpexeImportWriter.js:245-247`). PostgreSQL breaks
     such a cycle with `40P01`; 9-0's bounds and the `40P01` → `try_again` mapping (section 9) answer it with nothing
     written. Reordering the roster commands is a separate decision, not in this contract.
7. **The plan (pure, no lock).** Built **after** the locks, from the stored bundle and the locked activation set:
   one `metricSpec` per activation, whose `extract` is `extractorFor(source_system, api_family, source_metric_key)`
   with the version's `source_parameters` (never a bound or threshold from code, discovery section E), at the
   version's levels (`applies_to_session` → `full`, `applies_to_drill` → `drill`). A missing extractor or a revision
   `extractabilityCode()` refuses is `mapping_not_usable`. The session gates and the per-athlete exclusions of
   today's mapper are unchanged (`gpexeImportMapper.js:221-267, :277-387`): an athlete with several tracks, invalid
   statistics or more than one whole-session row is left out as today, before any requirement is judged (C18,
   section F row 3).
8. **Classification (section F), whole candidate first.** The whole-candidate blocks are checked first, in this order,
   the first that applies deciding; then each value's "Left out" entries (C110); **last**, `no_mapped_values` over what
   remains:
   - a threshold-contract skip (`team_threshold_missing`, `team_threshold_split`, `threshold_mismatch`,
     `duration_mismatch`, `zone_boundary_missing`, `zone_boundary_ambiguous`) on any admitted athlete under any
     activation → `blocked`, `source_threshold_contract_mismatch`;
   - the details' literal `unit: "number"` is checked as a **shape**, as today (`sourceMetricExtractors.js:140`; the
     seed: "The observed unit "number" is a shape", `v34:1811-1814`; the C97 runbook, row of
     `details.players.tot_burst_events`): another literal (`unexpected_unit`) → `source_shape_mismatch`, as does a
     value of another shape than the revision's (R7). The proven unit is a fact of the revision; it is compared with
     T4's `source_unit` (the T6 guard does the same), never with a literal of the answer. `source_unit_mismatch`
     stays for a revision / version unit disagreement found under the locks (defence in depth beside the T6 guard);
   - **the owner's decision C110 (2026-11-01), pilot form B** for the next two cases: only that athlete's value at that
     level is left out, as a "Left out" entry with its reason; the rest of the session imports and the candidate stays
     Ready if nothing else blocks it; never a zero; the value is never logged or returned. The review says plainly why
     each value is missing. (The target form C — the session waits and an administrator chooses "leave out only this
     value", the default, or "import anyway" with a mandatory reason and a record of who approved it — is a separate,
     later work, not built in 9-B.)
     - a converted value outside the canonical version's `min` / `max` → Left out, `canonical_value_out_of_range`
       (pre-checked under the locks, R8; today the v13 trigger raises an untyped error whose text carries the value,
       and the approval logs it, `v13:310`, `gpexeImportService.js:2295`);
     - a missing value (`zones_missing`, `zones_not_ready`, `zone_distance_missing`, `events_missing`, `count_missing`,
       `details_not_fetched`, `field_missing`, `value_missing`, `total_time_missing`, `total_distance_missing`,
       `max_v_missing`) of an admitted athlete on a level the activation covers: under `required` → Left out,
       `required_value_missing` (C110 departs here from C14's "the whole candidate is blocked" and from section F's
       row 4, for the pilot); under `optional` → Left out with the extractor's own reason (C15). A drill an athlete
       has no row for is not a missing value (R9);
   - no value at all to write — no open activation, or every mapped value left out → `blocked`,
     **`no_mapped_values`** (R4; never Ready, C17).
   Who reads which code is section 6.1; no refusal names another team, club, connection, instance or holder
   (section F's audience list ("Audience of every refusal code", `discovery:1920-1926`)).
9. **`savepoint gpexe_preview_import`, then the writes.** Every source identity of the import inserted and locked
   `FOR UPDATE` first (with the `team_session:<id>` reservation; today `gpexeImportWriter.js:468-484`), then the event,
   the threshold-set binding, segments, participants, the materialized activity and drill components — as today. The
   occasions follow per result with their values and T6 rows (step 10); every identity precedes the first T6 row, as
   C57 asks, and the connection has been held `FOR UPDATE` since step 6. **`ensureMetricDefinitions` is gone** (C46): every value uses the T4-pinned
   `metric_definition_id` and `metric_definition_version_id`; a canonical definition lacks the needed scope capability
   (`session` or `component`) → `mapping_not_usable` before the savepoint (R11).
10. **Values, then T6.** `value_numeric` is the decimal **string** `convertAtStorageScale` returns (never a JS double);
    `unit_at_capture` is T4's target unit. One T6 row per value: `activation_id`, `mapping_version_id`, the binding,
    `mapping_id`, `source_metric_version_id`, the connection, `source_unit` (T2b's), `source_value_numeric` (the
    extractor's value as an exact decimal string). The writer checks C55's conditions before it writes, for its stable
    codes; the trigger is the backstop, and a `23514` from it inside the savepoint is answered as `internal_error`
    with nothing written (never a value without its T6 row). Never a stronger lock after a T6 insert. **Logs** on
    this path carry only the database error's `code`, `constraint`, `table` and `routine` fields, never its `message`,
    `detail`, `where`, `hint` or a stack (the v13 messages carry the value and the definition id, `v13:307, :310`). 9-B
    rewrites the sinks that log message or stack text today: `gpexeImportService.js:1112, :2289, :2295, :2441, :2452`
    and `routes/gpexeImport.js:181`.
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
  labels are no longer used for a mapped value. The top-level `changesToImported` array keeps its place and the
  length the v23 and v33 approval triggers read (`v23:108-109`, `v33:189`), which is one reason no migration is needed;
  its entries' `values` (`gpexeImportPreview.js:302-309`) take the v3 value shape and are projected per audience like
  every value (section 6.1).
- **Unmapped and unactivated source fields** (section F rows 1–2): each preview carries `unmappedSourceFields` (a count
  of fields without a T2a identity) and `unactivatedSourceMetrics` (the source labels of known fields without an open
  activation on the binding). The projection gives `club_admin` and `platform` both; `other` only the count of the
  second and nothing of the first.
- **The changed / same label** compares the normalized decimal strings exactly; `1e-9` stays only as the
  characterisation test's tolerance against today's doubles (R13).
- **The Link athletes helper values** (Time, Distance, Top speed) no longer come from preview values, which an
  unmapped session would not have: they are computed from the stored snapshot through the three `athlete_session`
  extractors in the source units (s, m, m/s) and shown converted for display only (min, m, km/h), independent of any
  activation (R12). Gate (2) relies on them.

### 4.1 Owner scope and data workspace (two separate contracts, ADR-002)

- **Owner scope** — who may use a definition or a mapping: answered by T3 / T4 / T5 and the database (a club mapping
  targets a definition of the same club, `v34:655-656`; a club mapping is activated only on that club's connection,
  `v34:1397-1401`; T6 checks the event's team), by the approver's right (step 6b) and by R16. The importer never
  widens it: it writes only through an activation of the team's own binding.
- **Data workspace** — which team events and athletes the writer touches: only the route's team and the binding's
  source team, as today; a system or club definition then carries that team's events.
- **What a coach sees of the variable.** A value's `metricDefinitionId` reaches a coach through the activity results
  (`canonical_activity_results`, v4 `:770-781`), and preview v3 carries the variable's `label` and `unit`, while the
  catalog shows a club-owned definition only to that club's admin (`trainingLoadMetricsAccess.js:116-134`). For a
  coach, the preview projection (section 6.1) names a club variable only where C99 admits that coach to it (an active
  coach of an active team of that club, in that team's workspace, `discovery:887-893`; the predicate C99 built is
  `resolveVariableEditor`, `canonicalVariableAdminService.js:735-763`, not `catalogVisibilitySql`), otherwise as "Club
  variable"; system variables are named for everyone (R17). After an import, the activity results carry only the
  definition id, which the catalog hides from a team coach for a club variable; so no club mapping is switched on for a
  binding before that view is decided (O16). The pilot uses system variables
  only (section 10.2, step 3).

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
  `METRIC_BY_KEY`, `SOURCE_ATHLETE_VALUE_KEYS` (section 4), the frontend key lists, and the writer's
  `isPureSupplement` (`gpexeImportWriter.js:521`): it compares `Number(row.value_numeric) !== v.value`, which is always
  true for a decimal string, so the `supplemented` outcome (`:572-575`) would silently die; it compares the normalized
  decimal text on both sides instead (a test in section 8.2); its `addedMetricKeys` (`gpexeImportWriter.js:525`) and
  `importResult`'s `definitions.byKey.get(v.metricKey)` (`:538`) key by the activation and the definition id instead of
  the source key, which one field's two mappings would share (a test with the two closed power zones). The read-only probe
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
| `required_value_missing` | new | a "Left out" entry of that athlete and level; the rest of the session imports (C110, pilot form B) | the plain reason for everyone, the code for the two admins |
| `canonical_value_out_of_range` | new (R8) | a "Left out" entry of that athlete and level; the rest imports (C110); never the value, in no answer and no log | same as the row above |
| `no_mapped_values` | new (R4) | candidate `blocked`, never Ready, whenever no value would be written for any athlete — no open activation, or every mapped value left out (optional, required under C110, or out of range); `nothing_to_import` keeps its meaning `no_changes` | admins precise, coach the sentence |
| `source_instance_held`, `source_instance_changed`, `session_imported_under_another_instance` | new | candidate `blocked` | **a platform admin only**; the club's admin gets the `mapping_not_usable` sentence and a coach the stable sentence, so no one but a platform admin learns that another instance or holder exists (the F3c2e rule) |
| `source_metric_target_taken` | exists | a mapping-service refusal (`sourceMetricMappingService.js:364, 408, 1446`), **not** an importer code (the discovery's audience list at `:1892-1895` names it) | — |

A coach's Imports screen shows one sentence for all of them ("This session can't be imported until an administrator
finishes its data setup."), a platform admin and the club's admin the precise reason (except the three instance codes
above) — **except the two Left-out codes `required_value_missing` and `canonical_value_out_of_range`** (C110): they
block nothing, and every level sees their plain reason on the athlete's Left-out entry ("required value missing",
"outside the variable's limits"), never the value; only the code itself is for the two admins. No log on this path carries an error's message, a value or a value-bearing id (section 3, step 10).

### 6.1 The audience mechanism

Today a coach is masked only on check rows (`adminViewerOf`, `routes/gpexeImport.js:25-30`; `checkView`,
`gpexeImportService.js:764-780`; a closed code set with a classification test,
`sourceImportCredentialResolver.js:122-137`), on a source-connection refusal's `reason` (`routes/gpexeImport.js:57-61`)
and on the status's settings (`:96`). The candidate surfaces take no viewer: the list and the detail
(`routes/gpexeImport.js:143-157`) return the stored preview whole (`gpexeImportService.js:1402-1431`) and
`candidateReasons` passes `blockedSourceCode` verbatim (`gpexeImportReasons.js:93-100`); the batch returns `blockedCode`
and `reasons` (`gpexeImportService.js:2375-2383, :2396`); the coach screen shows Technical details to everyone
(`frontend/gpexe-import-view.js:222-231`). Preview v3 adds mapping ids and fingerprints to that same column (a "Left
out" entry of C110 names the team's own athlete, the level and the reason in plain words, never the value, and is shown
to every level). So 9-B adds:
- **One audience per request, three levels** — `platform` (an active platform admin), `club_admin` (the owning club's
  active admin in that club's workspace) and `other` — computed once by the route from its own access snapshot
  (`adminViewerOf`'s definition, split into its two bases) and passed down to **six surfaces**: the list, the detail,
  the approval's refusals, the batch results, the candidate read inside a successful approval's answer
  (`routes/gpexeImport.js:176-188`, which embeds `getCandidate`), and the stored candidate a check shows. The service
  never recomputes it; the parameter is **required, with no default**, and a missing or unknown level is treated as
  `other`.
- **A projection of the stored preview per level.** For `other`: the **blocking** codes of section 6 replaced by the
  stable code and sentence (a Left-out entry of C110 keeps its plain reason; only its code is admin-only), no `activationId`, `mappingVersionId`, `sourceParameterFingerprint` or instance fact; values and their labels as section 4.1 says. For `club_admin`: the precise codes, except the three
  instance codes, which become `mapping_not_usable` with its sentence in `preview.blocked`, `blockedCode` and
  `blockedSourceCode`. `platform` sees the stored preview. The projection applies to every part of a preview a surface
  returns, stored or recomputed under the lock: also `changesToImported` in a `409 preview_changed`'s details
  (`routes/gpexeImport.js:52, :63`) and in a batch's `refusedResult` (`gpexeImportService.js:2376-2379`). The preview
  hash stays computed on the full preview, so an approval still compares equal; the approval route compares the hash
  the caller sent, never a projected one.
- **A closed set of admin-only candidate codes** with a test that every code of section 6 is classified (as the
  resolver's test does), and the new **blocking** codes mapped into `BLOCKED_CODES` with a coach-safe `blockedCode` and
  `blockedSourceCode`; the two Left-out codes of C110 are value-level reasons, never in `BLOCKED_CODES`
  (`gpexeImportReasons.js:12-13`: that map is "why the whole session cannot be imported"), and a session that carries
  only them has `blockedCode` null.
- **The discovery document's audience list** (section F's audience list ("Audience of every refusal code", `discovery:1920-1926`)) gains `no_mapped_values` and
  `source_instance_changed`, loses `nothing_to_import` and `source_metric_target_taken` (neither is an importer refusal
  of a mapped value) and `required_value_missing` (a Left-out reason under C110, its plain reason shown to every level),
  records `canonical_value_out_of_range` the same way, and records the platform-admin-only level of the instance codes
  — in 9-B, with the code.

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
(the switch is off). The way back is a revert PR (no migration). **O13** therefore governs the **deploy** of 9-B, not
only its merge: the owner names the deploy of the commit that carries 9-B, either as soon as it has both GOs, or only
after M6 steps 2–5 (the activations exist before the deploy, so the screen goes from today's previews straight to mapped
ones; the old importer ignores activations). While auto-deploy is off (`metrics-core-plan.md:266-268`), no deploy of a
commit of `main` that carries 9-B starts without that word — the *Rukovodilac*'s deploy "as needed" of step 6 of the
standing order for migration PRs (`:373-375`) does not cover it (R3). That exception holds for the commit that carries
9-B and for every later commit of `main` (each carries 9-B too), until 9-B is live, deployed on the owner's word
(O13). **The *Rukovodilac*'s commitment (2026-11-01): it deploys no commit that contains 9-B code without the
owner's word.** While auto-deploy is on (`:252-256`), the merge of 9-B itself waits for that word.
**Amended (2026-11-01, the owner's work order `628d0be9`, section 12.3):** the owner's word for the merge and the deploy
of 9-B is no longer needed. After both GOs, 9-B merges under the standing merge order and the *Rukovodilac* deploys it
without a migration; its commitment above ends with that order. The activations of the pilot exist already (M6 steps
2–5, section 12.3), so the screen goes from today's previews straight to mapped ones.

---

## 8. Tests (9-B)

### 8.1 The characterisation test (the plan's acceptance)

Two fixtures, two runs, because the pinned counts and the rounding-sensitive values come from different bundles:

- **Arm A1 — the writer, counts.** `backend/tests/_gpexe-fixtures.mjs` `makeBundle({ athletes: standardAthletes() })`
  (team 77, session 5001, athletes 101 / 102 / 103, thresholds 1473, `detailsDrills = [0]`). Eleven system variables
  and eleven active mappings (time s → min `/60`; distance m; max speed m/s → km/h `×3.6`; the two closed power zones
  25–60 and 60–75, the open top ≥ 75; the speed zone ≥ 7 m/s; acceleration and deceleration ±2.5 m/s² with 0.3 s;
  burst and brake), every activation `optional` at both levels. The revisions are verified through
  `verifyRevisionRow` of `backend/tests/support/source-revisions.mjs` with every guard on (never
  `zoneMeaningAsFutureDecision`, which turns triggers off; a zone's meaning is possible with every guard on since v42);
  the variables, mappings and activations are written through the real M3-0, M2, 7b and 7d service paths. The oracle is
  a new frozen copy of `GPEXE_METRIC_SPECS` under `backend/tests/support` (7f test 9 compares against the live
  export), one double per (athlete, level, legacy key).
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
- **Arm B — no activation, proven at the writer itself** (every earlier gate open; never through an earlier refusal
  such as the switch, an ended binding or a blocked candidate). Today's mapper does not refuse a plan with no values
  (`gpexeImportMapper.js:386` refuses only "no athlete admitted"), so this gate is new.
  1. *Writer:* `runImport` (the writer's own entry, as Arm A1) on both bundles with no activation refuses
     `no_mapped_values`; zero new rows in `metric_values`, occasions, identities, events, participants, segments,
     activities, components and T6; the definition tables digest-identical. Today's writer creates eleven definitions
     here, so this test fails before 9-B and passes after it.
  2. *Route, switch on in the test process:* a candidate previewed with an activation, the activation ended, then the
     approval: refused (`preview_changed`, the refreshed preview `no_mapped_values`), nothing written.
  3. *An ended binding:* the team bound again, its only activation still on the old, ended binding: the new binding
     has no open activation, so the check preview is `blocked` `no_mapped_values` and nothing is written.
- **Arm C — a pre-M4 candidate.** Stored with today's preview v2: the first approval answers `preview_changed` and
  stores the recomputed preview; a second approval with that hash imports exactly once. Separately: one check refreshes
  the preview, reports the session unchanged, and the approval imports once.

### 8.2 Also in 9-B

- Every code of section 6 through the real route, on **all six surfaces** of section 6.1 as a coach, a granted coach,
  the club's admin and a platform admin: the three levels, the instance codes for a platform admin only (the club's
  admin sees `mapping_not_usable`), no holder named, the projection carrying none of the admin-only fields, a call
  without a level treated as `other`, and the hash of the full preview still accepted by the approval.
- R17: a club variable's name for a coach of a team of that club in its workspace, "Club variable" for anyone else.
- A granted coach sends a stale `previewHash` for a candidate that changes an imported result: the `409
  preview_changed` and the batch's result carry no `activationId`, `mappingVersionId` or `sourceParameterFingerprint` in
  any `changesToImported[*].values[*]`.
- F rows 1–2: an unactivated known field shows its label to the two admins and only a count to a coach.
- Every mapped value left out (optional, required under C110, or out of range) → `blocked` `no_mapped_values`, never
  Ready.
- C110 audience: a session carrying only Left-out entries of C110, with at least one mapped value written, has
  `blockedCode` null and is Ready; the coach's
  projection keeps each entry's plain reason and never shows "This session can't be imported".
- C110 (pilot form B): a `required` value missing for one athlete at one level → that value Left out with
  `required_value_missing`, every other value of the session imported and the candidate Ready; a converted value
  outside the variable's `min` / `max` (the owner's `maximal_running_speed` with max 40 km/h: an athlete at 41) → Left
  out with `canonical_value_out_of_range`, the value in no answer, preview or log line; never a zero; the reasons shown
  in plain words to a coach and as codes to the two admins.
- R7: burst and brake with `unit: "number"` in the answer pass under a revision whose proven unit is `count`; another
  literal → `blocked` `source_shape_mismatch`.
- `required` against `optional` under C110 (both leave the value out; the reason differs), including the drill-level
  rule of R9.
- The preview hash changes when an activation ends between preview and approval; the content hash changes under a new
  mapping version (`needs_review`); a re-import that only adds a mapped metric is `supplemented` (the decimal compare of
  `isPureSupplement`, section 5).
- The seven COMMIT-outcome tests (`gpexe-in-app-import.test.mjs:1508-1763`) re-run with activations on.
- Concurrency (real connections): the import against a 7d version end (its T5 `FOR NO KEY UPDATE` waits); against an
  Unbind (`try_again` at the team lock, C58); against a 7g instance end (its try-lock); two approvals of the same team;
  **an approval, a 7d operation by another platform admin and a platform-admin revoke together** (the cycle step 6b
  removes; a revoke of the approver lands as `403 not_an_approver` with nothing written); **an approval, a roster
  command by another platform admin and a platform-admin revoke together** (the cycle class that remains): any
  `40P01` is answered `try_again` with nothing written, never a partial write. No `40P01` arises between the importer
  and a 7d writer, an Unbind or a 7g end (C57). Each wait falls under 9-0's bound.
- The T7 refusal through a fault seam (two teams on one triple are unreachable through v30): the `23505` rolls back to
  its savepoint and the candidate is stored `blocked` `source_instance_held`. *As built (D19, section 16): through a
  real keyed row of another team, not a fault seam; the case is reachable after an Unbind, a settings change and a new
  bind, so "unreachable through v30" is too strong.*
- A value-bearing trigger error injected on the import path: the log holds the SQLSTATE and the constraint or trigger
  name, never the value or an id.
- The undo removes T6 first on an M4-imported session (C47; disposable only).
- Architecture tests: no `metric_definitions` insert from importer modules; no value without its T6 row; no mapped
  value without an extractor (`phase7f…:336-337`).
- The approval of a team or club archived after the route's check (R16), through the single route (the identical 404)
  and through the batch (its result for that candidate, and whether the batch goes on, as R16 decides).
- Mutation evidence for every new guard.
- Tier: `test:gpexe` and the disposable suites; the frontend file of the Imports screen and `test:frontend:fast` for
  R14; the production build. `test:backend:shared` writes to the local OPTIMOVE database, so it runs only on the
  owner's word for that run (`metrics-core-plan.md:159-163`), and only if non-GPEXE Training Load is touched
  (`agent-efficiency.md` §6).

---

## 9. 9-0: switch conditions 2 and 3

- **Condition 2, the approval.** `approveCandidate` (and the batch, which calls it) sets, right after `begin` and
  before the first lock, `SET LOCAL lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout`. The
  values are proposed in the PR, below the client's and the route's bounds; `statement_timeout` is chosen from a
  measurement on the Arm A1 fixture (53 values) of the T6 trigger's cost **and of the COMMIT with its deferred trigger
  work** (a `SET LOCAL` is still in force at the COMMIT, so the effective server bound on it is the lower of the two),
  not guessed. A test commits an Arm A1 approval under the chosen value, and an injected slow deferred trigger gives a
  `57014` at the COMMIT that goes through `resolveUncertainCommit`, never `try_again`.
  - Before the COMMIT, a `55P03`, `57014` or `40P01` is `409 try_again` with nothing written (as
    `sourceConnectionService.js:532` and `gpexeImportService.js:1617` map `40P01`).
  - An error the COMMIT itself raises goes through `resolveUncertainCommit`, never `try_again`; the COMMIT keeps its
    own 15 s bound and the five-point rule.
  - The checked-out client gets an `error` listener (removed before release), as the check paths already do
    (`gpexeImportService.js:855-858`, `:1218-1223`): the server's FATAL kill of an idle session must not end the
    Node process.
  - Tests through the real route: the bound covers the advisory team lock and a row lock; a bounded refusal writes
    nothing; a killed idle session answers a stable code and the process survives; an error raised by the COMMIT is
    resolved, never answered `try_again`.
- **Condition 2, the check-time preview.** The same three bounds in `buildCandidatePreview`
  (`gpexeImportPreview.js:155-171`), whose transaction holds the team lock (so an Unbind, a 7g end and a settings
  change answer `try_again` for as long as it waits), and the same `error` listener on its client in `recordCandidate`
  (`gpexeImportService.js:1166-1173`). A bounded wait there fails the check with a stable code, never a `blocked`
  candidate; a test proves a killed preview session fails the check with a stable code and the process survives.
- **Condition 2, the deployed request timeout** (Render and any proxy) is an owner step (section 10, step 7).
- **Condition 3, on disposable databases only.** Today the undo script checks the platform admin
  (`assertPlatformAdmin`, defined at `gpexe-undo-imported-session.mjs:266-274`, called at `:288`) and then locks the
  event `FOR UPDATE` (`:289`); it never reads the team. 9-0 reads the event's `owner_team_id` without a lock (new),
  takes `lockTeamForImport`, then locks and re-checks the event (the 7g pattern, `sourceInstanceEndService.js:219-266`),
  and moves the platform-admin check after the team lock, the importer's order. A test proves an undo waits for a running import of the same team
  and the reverse. The team lock does **not** make the undo safe on a persistent database: it disables triggers table
  by table (`:85-94`, `:298`; `ALTER TABLE … DISABLE TRIGGER` takes a `SHARE ROW EXCLUSIVE` lock), which inverts with
  every other team's import or check-time preview (they write the threshold-set binding, then the values, then T6) and
  blocks all of them while it runs. A production undo needs its own mechanism or a maintenance window (O3).
- Reviewers: `code-reviewer`, `db-reviewer` (trigger 4).
- **As built (9-0)** — PR #322, merged `8fa0ea7` and deployed on 2026-11-01. `backend/src/gpexeImportPreview.js` (`setImportTransactionBounds`), `gpexeImportService.js`
  (`approveCandidate`, `recordCandidate`, the batch), `backend/scripts/gpexe-undo-imported-session.mjs`; tests
  `backend/tests/gpexe-import-bounds-9-0.test.mjs`. The values: `lock_timeout` 5 s, `statement_timeout` 10 s,
  `idle_in_transaction_session_timeout` 10 s, for the approval and the check-time preview alike. Measured on Arm A1
  (53 values, the writer in the approval's transaction shape): the longest statement about 11 ms, the COMMIT about
  3 ms; through the route (both drills) about 4 ms and 2 ms. Departures from the text above:
  - **The COMMIT's deferred work.** PostgreSQL does not apply `statement_timeout` to the deferred trigger and
    constraint work a COMMIT runs (measured on PostgreSQL 16 by hand: a 3 s deferred trigger finished, and
    committed, under a 1 s bound, with `SET LOCAL` and at the session level alike; test 6a repeats it with 1.5 s under
    300 ms; PostgreSQL 17.6, which production runs, was not measured, and the fix holds either way), so the sentence "the effective
    server bound on it is the lower of the two" does not hold. The approval therefore runs `SET CONSTRAINTS ALL
    IMMEDIATE` right before the COMMIT: the deferred work runs as a statement the server bounds, and a slow
    deferred trigger is a `409 try_again` with nothing written (test 6b), a definite answer before the COMMIT
    instead of an unknown outcome. An error the COMMIT itself raises still goes through `resolveUncertainCommit`,
    never `try_again` (test 6c, a 57014 at the COMMIT that did and did not land). The COMMIT keeps its 15 s
    client bound.
  - **T6 is not measured here:** the writer of 9-0 does not write T6 yet; 9-B's Arm A1 runs under the same bounds
    and is measured again there.
  - **The batch stops at `try_again`** (the team lock or the server is busy, and every candidate of a batch is the
    same team's). Each wait is bounded, not the request: waits that end just under their bounds are successes, so a
    batch of N can still take about N times their sum (the deployed request timeout of step 7 is sized with that).
  - **Only the approval and the check-time preview get the idle bound.** The other holders of the team lock (a check
    start, a link or settings write, the roster command, a source-connection Test / Reconnect / Bind across its
    source request) set a lock bound at most; one of them abandoned makes approvals and previews of the team answer
    `try_again` / `check_preview_busy` until the server drops it. A follow-up, not in 9-0.
  - **The check-time preview's codes:** `check_preview_busy` (55P03, 57014, 40P01) and `check_preview_interrupted`
    (a session the server ended), both shown to a coach as they are.
  - **A session the server ended** before the COMMIT is `try_again` too (the transaction went with it); its
    connection is released as broken. Proved on a direct PostgreSQL 16 connection; behind the Supabase pooler a
    killed session could surface as a code not in the list (for example 08P01) and answer `500 internal_error` -
    still nothing written, and the batch stops. Not measured on production.
  - **Server-side bounds only.** A statement before the COMMIT whose answer is lost on the network is bounded by TCP
    and the deployed request timeout (step 7), not by these bounds; only the COMMIT has a client-side bound.

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

### 10.2 After the evidence (steps 1–5 may run before 9-B is deployed, the old importer ignoring them; steps 6–8 are the deploy and its check)

1. **OWNER — decisions O1–O12 and O14–O16** (section 12.2; O13 at step 6).
2. **OWNER — the first field confirmations** (a separate order, `metrics-core-plan.md:827-828`): the unit act and the
   meaning act in Source fields, as an active platform admin in the platform workspace; each is written once.
   EXECUTOR-PREPARES: the exact units, operators and evidence anchors.
3. **OWNER — the system variables** in Variables. EXECUTOR-PREPARES: names, keys, units, daily aggregation (sum; max
   for speed), the `session` and `component` levels.
4. **OWNER — the mappings**: create, draft, submit, activate (Mappings screen). EXECUTOR-PREPARES: the list with the
   seeded conversions (s → min, m/s → km/h).
5. **OWNER — switch them on for the First team's binding**, with an explicit requirement for each (O6).
6. **OWNER — the merge of 9-0 and 9-B, and the deploy of 9-B**: 9-0 under the standing merge order; 9-B merged on the
   owner's word naming it, and the commit that carries it deployed only on the owner's word naming that deploy, at the
   time O13 decides (the *Rukovodilac* starts it under its Render key; its "as needed" deploy without a migration does
   not cover a commit that carries 9-B, R3).
   - **6a. OWNER — the merge of 9-R** (the owner's word), so that steps 11 and 16 run merged files named by their
     sha256 (the connector rule needs the whole file's hash, `metrics-core-plan.md:365`), before the freeze of step 9.
7. **OWNER — confirm the deployed request timeout** (Render and any proxy; condition 2's second half). A Render setting
   stays the owner's.
8. **OWNER — one check with the switch off** on a small window that holds the target session. Stop on any failure code
   and repeat nothing. Acceptance (M6): the aggregate preview of the saved candidate shows the converted values in the
   canonical units, and the candidate is *Ready to import* with the expected requirement outcome.

### 10.3 The import window

9. **OWNER — the freeze**, from here until step 16 passes: no merge or deploy (the *Rukovodilac* included); no
   administrator change of the team's mappings, activations or binding; the First team's coaches told not to run a
   check.
10. **OWNER — a fresh backup of the chosen environment, restore-verified** (condition 1). Local:
    `gpexe-backup-verify.mjs` prints VERIFIED and writes `<dump>.verify.json`. Supabase: the method O2 decides.
    "Fresh" means: since the backup, no approval, no write to `metric_*`, to T6 or to an approval row (retention
    bookkeeping of the candidates excepted) — checked by step 11.
11. **OWNER — the read-only pre-switch preflight** (the SELECT file of section 10.4), run by the owner, or by the
    *Rukovodilac* through its connector only if the owner's recorded word extends that right beyond the migration
    pre- and post-checks (`metrics-core-plan.md:357-371`) — extended by the owner's work order `628d0be9` (section
    12.3). It shows:
    - the served commit equals `main`, and no migration is undeployed; no running check;
    - the freshness of step 10 (the newest approval, occasion, value and T6 time against the backup's time);
    - the target candidate actionable (last check `succeeded`, drill effect `confirmed` or `not_required`), its
      preview v3 `ready`;
    - **every** actionable candidate of the team by id: the owner accepts each one by id, or the window does not open
      (O15 offers a technical bound);
    - **every** active platform admin and every un-revoked approver grant of the team: the owner accepts each one;
    - the open activations and their requirements as decided, and that the First team's binding is the **only**
      binding with an open activation (with 9-B live a candidate imports only through an open activation of its own
      binding, so this bounds the environment-wide switch to that team); the T7 keys of the First team (NULL or the
      expected triple); the non-canonical link count 0.
    Every SELECT file runs inside the plan's read-only wrapper (`begin transaction read only;` … `rollback;`,
    `metrics-core-plan.md:361-363`), from the merged 9-R file named by its sha256 (step 6a).
12. **OWNER — the record row** (environment, backup, `.verify.json`, verified at, confirmed by) is written **before**
    the switch goes on (`gpexe-in-app-import.md:764-767`). During the freeze it is kept outside the repository; step
    17's facts PR commits it into the runbook's table.
13. **OWNER — switch on**: `GPEXE_IMPORT_APPLY_ENABLED=true` in Render for the chosen environment only, by the owner's
    own action; no executor or *Rukovodilac* key sets a Render environment variable. Whether the service must restart
    for it to take effect is not verifiable from the repository; a change of a Render environment variable starts a
    new deploy of the commit already served, so the owner confirms "on" through the Imports status (`importSwitch`)
    and `/api/health` three times in a row on the same commit step 11 found (equal to `main`) before step 14, never by
    assumption.
14. **OWNER — exactly one approval** through the single-candidate route with its `previewHash`, never the batch. On
    `503 import_outcome_unknown`: the `verify` links, never a blind retry (`gpexe-in-app-import.md:393-532`). No roster
    decision on the imported activity until step 16 passes (the undo refuses after one).
15. **OWNER — switch off at once**, confirmed by three consecutive reads of `importSwitch` showing it off and
    `/api/health` three times in a row on the same commit as in step 11 (the change starts a new deploy of it);
    "Switch off at" in the record row.
16. **OWNER — the read-only post-import check** (the merged SELECT file of section 10.4, named by its sha256): the approval read
    (`GET …/approvals/:approvalId`, `routes/gpexeImport.js:212`); the candidate `imported`; no other candidate of the
    team imported in the window; the counts equal the preview; no new `gpexe_*` definition; T6 rows = values of the
    import; the T7 keys set; no zero where the preview left a value out. The freeze ends when it passes.
17. **OWNER — the facts PR** (the owner's word).

**On any anomaly at any step: stop.** No sanctioned production undo or scripted restore exists; the owner decides
(O3).

### 10.4 What the executor prepares (9-R, text and SQL only)

- the M6 runbook: the steps above, with the stop rules and the records each step leaves;
- the Supabase backup and restore-check procedure draft (O2), with its record-table row;
- the pre-switch preflight and the post-import check, SELECT-only files, each run by the executor only on a disposable
  `optimove_tests_*` database before it is handed over;
- the proposals: the system variables (names, keys, units, aggregation, levels), the mappings (fields, parameters,
  conversions) and the requirement of each activation, for O6;
- the evidence document of P1 with its anchor, from the owner's sanitized table.

#### As built (9-R: the window's two SELECT files)

The *Rukovodilac* asked for them after step 8 passed (2026-11-02). They do not include the M6 runbook or the proposals.
They are merged only on the owner's word (section 2's 9-R row, step 6a).

- **`docs/runbooks/gpexe-import-window-preflight.sql`** (step 11), 14 numbered blocks:
  1. the migrations: v51 last, with its checksum, nothing later;
  2. nothing running: checks and identity loads;
  3. a quiet moment: idle transactions, write locks on the import's tables, advisory locks;
  4. every binding with an open activation, in any binding state; one row expected, 980 on `server3`;
  5. the open activations against O6: each row `as_decided`;
  6. the First team's T7 instance: none, `NULL / NULL` or `server3 / 980`;
  7. link gate (1);
  8. nothing imported yet: approvals, imported candidates, T6, GPEXE events, batches, team-owned `gpexe_*`
     definitions;
  9. every actionable candidate by id, with its GPEXE session and date;
  10. the team's candidates counted, and its newest check;
  11. every active platform admin, with name, basis and role times;
  12. every grant of the team that is not revoked, whether it gives the right now or not;
  13. the rights counted;
  14. freshness: per table, the row count and the newest time in UTC; the *Rukovodilac* compares them with the
      backup's time.
- **`docs/runbooks/gpexe-import-window-postcheck.sql`** (step 16), 11 numbered blocks:
  1. the migrations;
  2. nothing running, and no check of the team since the approval;
  3. the approval, and that it is the First team's;
  4. the candidate imported, its preview the approved one, no other candidate imported;
  5. every count against the approved preview: results, occasions, values, T6 rows, Left-out entries, participants;
  6. value by value against the preview entries;
  7. the T6 chain: binding, instance, open activation, pinned version, system variable, aggregation role, coverage;
  8. the T7 keys, and the import written under that instance;
  9. no stored value, and above all no zero, where the preview left one out;
  10. no `gpexe_*` definition;
  11. the event, the threshold binding, the batch, the activity, the identities, and no roster decision.
- **No parameter, no id.**
  - The First team is the one active GPEXE binding with an open activation. Blocks 6, 10, 12 and 13 print
    `first_team_bindings`; block 9 lists nothing unless it is 1.
  - The approval is the only row of the append-only approvals table, since step 11's block 8 shows none. Each
    post-check block reads that row only while exactly one exists. Blocks 2, 3, 9 and 10 print `approvals_total`, so
    a second approval shows itself rather than as an error.
  - Every block is one plain SELECT, valid inside the connector's `begin transaction read only;` … `rollback;`.
- **Pinned.** The files name v51 and its checksum, and the three decided mappings (`duration`, `total_distance`,
  `maximal_running_speed`, with their units and factors). If main gains a migration, or the decided mappings change,
  before step 11, both files are re-issued under new sha256s; both headers say so.
- **Kept out.**
  - Neither file prints an email, a credential column, a grant or revoke reason, or a stored source answer.
  - The rights blocks, and the approver in post-check block 3, print the user's display name (else the full name,
    never the email): the owner accepts each row by person (the *Rukovodilac*'s decision, 2026-11-02).
  - Read outside the files: the served commit (`/api/health`), the approval read
    (`GET …/approvals/:approvalId`) and the switch (`importSwitch`).
- **Evidence.** `backend/tests/gpexe-import-window-sql-9r.test.mjs` (disposable `optimove_tests_gpexe_*`, fake
  `server3` source, no GPEXE request). These runs send every block exactly as the connector does, and each asserts
  the block's exact list of output columns:
  - the pilot built as production's: the three system variables under their production keys, Required, at both
    levels; one team bound to 980;
  - the preflight after one succeeded check;
  - one approval through the single-candidate route, with the switch on and then off;
  - the post-check, then the preflight again (block 8 and the freshness rows then name the import);
  - block 3 again while a real second session holds a read, then a write lock and an advisory lock.

  28 planted cases are each rolled back, and run the same block text inside the planting transaction. They cover the
  stops of both files' blocks 1 and 2, preflight blocks 4 to 7 and 9 to 13, and post-check blocks 3 to 11.
  The file-shape check (LF, blocks 1..N, one SELECT each, no parameter, no write, no lock, no email or credential
  column) needs no data.
  39 mutations of the two files are all killed: 22 of the preflight and 17 of the post-check.
  The staged observations of preflight block 2 are shown only and are not planted.

---

## 11. Reviewers and gates

- **9-A** (documentation of DB, auth and red-zone contracts, the matrix's docs row): `code-reviewer` on the whole
  document, `db-reviewer` on its DB and transaction parts, `security-reviewer` on its audience, authorization, DB-safety
  and red-zone parts; then the *Rukovodilac* and the *Nezavisni revizor*; then the owner's acceptance before any code (the plan's rule A1).
- **9-0:** `code-reviewer`, `db-reviewer`; trigger 4.
- **9-B:** `code-reviewer`, `security-reviewer`, `db-reviewer` (the J M4 row); `mobile-qa` and `ux-design-reviewer`
  if the Imports review's layout changes (R14); triggers 1, 2, 3, 4 and the five-point rule; then the *Rukovodilac*'s
  and the *Nezavisni revizor*'s ★★ reviews; then the owner's word naming the merge and the deploy (O13).
- **M6:** triggers 1 and 5 (only fake-source evidence exists for an irreversible write); the owner's external review.

---

## 12. Decisions

### 12.1 For the *Rukovodilac* (decided on 2026-11-01 in its ★★ review of `275cf62`: R1, R3–R6, R8–R18 as recommended; R7 as written below)

- **R1 The PR split** of section 2. Recommendation: yes.
- **R3 Merge and deploy paths** of section 2 (9-0 under the standing merge order; 9-B merged on the owner's word, and
  every deploy of a commit of `main` that carries 9-B — that commit and every later one, until 9-B is live, deployed
  on the owner's word (O13) — started only on the owner's word naming it, O13: a departure from step 6 of the standing
  order for migration PRs, which lets the *Rukovodilac* deploy a commit without a migration "as needed",
  `metrics-core-plan.md:373-375`; the *Rukovodilac* has committed to deploying no commit that contains 9-B code without
  the owner's word; 9-R on the owner's word, before the freeze, step
  6a). *Amended for 9-B by the owner's work order `628d0be9` (section 12.3).* This contract also adds trigger 2 (the audience mechanism, R18) to the plan's
  "Triggers 1, 3 and 4" for phase 9 (`metrics-core-plan.md:1115`); it is stricter, and the plan's line itself changes
  only on the owner's word. Recommendation: as written.
- **R4 `no_mapped_values`** as a new code; `nothing_to_import` keeps `no_changes` (it is "up to date" on the screen,
  `frontend/gpexe-import-view.js:65, :177, :765, :1717`). Recommendation: yes.
- **R5 The lock order** of section 3: the approval's candidate row and then the team lock first; the binding
  `FOR SHARE` before the registry (every binding writer holds the team lock; a departure from D's registry → binding
  order); the approver's rights after every registry row (step 6b, D's order), with an unlocked right check in the
  prefix; the team and club `FOR SHARE` in step 2a, before the registry; the Metrics Core connection `FOR UPDATE` in
  step 6, where D says `FOR SHARE`. It amends the wording of C57 ("first" = first among the importer's locks, after the
  candidate row) and
  changes today's order of the approver lock; recorded in the discovery document. The remaining cycle class with the
  roster commands (step 6b) is accepted as bounded by 9-0 and answered `try_again`. Recommendation: accept, with
  `db-reviewer`'s confirmation in 9-B.
- **R6 A Metrics Core connection found inactive under its `FOR UPDATE`** (reachable only by a raw write, since a 7g end
  needs the team lock): `mapping_not_usable` (recommended) or a new code.
- **R7 The details unit check** — *decided by the Rukovodilac (2026-11-01)*: the literal `'number'`
  (`sourceMetricExtractors.js:140`) stays, as a check of the answer's **shape**; another literal is
  `source_shape_mismatch`, never `source_unit_mismatch`. The proven unit (for burst and brake the seed's hypothesis is
  `count`, `v34:1811-1814`) is a fact of the revision and is compared with T4, never with the answer's literal —
  comparing the two would refuse every session. It departs from section F's earlier mapping of `unexpected_unit` to
  `source_unit_mismatch`; section F of the discovery document now records R7, and the code follows in 9-B.
- **R8 `canonical_value_out_of_range`** pre-checked under the locks, the value never logged; per the owner's decision
  C110 it leaves out only that athlete's value at that level in the pilot (form B), never the whole candidate.
- **R9 The drill-level "missing" under `required`:** a drill the athlete has no row for is not missing;
  `details_not_fetched` is. Recommendation: yes, with a test.
- **R10 The check-time preview runs the full path** (T6 and T7 included) and rolls back. Recommendation: yes.
- **R11 A canonical definition without the needed scope capability** → `mapping_not_usable` before any write.
  Recommendation: yes.
- **R12 The helper values from the snapshot** through the extractors, independent of activations. Recommendation: yes.
- **R13 The `1e-9` tolerance** absolute (today's code) for the characterisation only, and the J M4 row's "changed
  exactly once" amended to the mechanism of section 7.1. Recommendation: yes.
- **R14 The frontend in 9-B:** the Imports review shows the canonical name and unit and the source value, through the
  projection of section 6.1; phase 8's R18 sentence is removed (`phase8-mappings-screen-contract.md:467-468`).
  Recommendation: in 9-B.
- **R15 The pilot CLI and the disposable-run script:** take a mapped plan (they need activations on their disposable
  database) or are retired. Recommendation: take a mapped plan; both stay disposable-only.
- **R16 A team or club archived after the route's check:** step 2a re-reads the resolver's facts under the team lock
  and answers the identical 404. Through the batch (`approveOneOfBatch`, `gpexeImportService.js:2460`, which turns it
  into a per-candidate `notFound` and goes on, `BATCH_STOP_CODES` at `:2368`): R16 adds that code to
  `BATCH_STOP_CODES`, so the batch stops at it. Recommendation: yes, both routes tested.
- **R17 A club variable's name for a coach** (section 4.1): shown only where C99 admits that coach to the club variable
  (`resolveVariableEditor`'s predicate), otherwise "Club variable", with a test. Recommendation: yes; the pilot uses
  system variables only.
- **R18 The three-level audience and the platform-admin-only instance codes** (section 6, 6.1). It departs from section
  F's accepted rule that the owning club's admin gets every precise code (`discovery:1892-1898`), so that no one but a
  platform admin learns that another instance or holder exists (the F3c2e rule). Recommendation: yes; the discovery
  document's audience list is amended in 9-B.

### 12.2 For the owner

- **O1 The environment of the first import.** Production (the First team's binding exists only there) supersedes the
  plan of 2026-09-18 ("F4: the first real local import", `CURRENT_STATE.md:3938, :4001`); the local OPTIMOVE is
  recorded at v21, with no GPEXE table. Recommendation: production, only after O2 and O3.
- **O2 The Supabase backup and its restore check — decided by the owner (2026-11-01, section 12.3):** a manual
  `pg_dump` from the owner's own computer and a restore check into a local Postgres; the executor prepares the
  procedure in 9-R. *The executor's proposal, not the owner's words:* for Windows, by adapting
  `gpexe-backup-verify.mjs` (today local-only) rather than writing a new tool, reviewed in 9-R. "Fresh" is defined in step
  10.
- **O3 The way back.**
  - (a) A full restore is the only remedy for the pilot. It also rolls back every unrelated write since the backup
    (for example the R2 media rows and quotas, whose objects stay in the bucket).
  - (b) The undo is unlocked for production first: an authenticated identity, a narrow credential, a second person's
    approval, an external review, **and** a maintenance window (the switch off, no check, no other writer) or another
    mechanism, because the undo's trigger switching takes table locks that block every team's import and check while
    it runs (section 9).
  - Either way: after an undo the candidate stays `imported` and its approval is append-only, so the same session
    cannot be imported again without a further decision; the undo refuses once a roster decision exists.
- **O4 F3c4 before the controlled import** (the F3c order of 2026-10-05, `CURRENT_STATE.md:855-865`), or after it.
  The bound First team cannot read the environment token (v31).
- **O5 Q1 (c) and the pinned step's cap**, both scheduled "before M6" (`CURRENT_STATE.md:3686-3696`): built before
  step 2, or waived for a pilot of system mappings only.
- **O6 The pilot's fields and each activation's requirement.** (a) minimal: `total_time`, `total_distance`, `max_v`
  (no operator needed); (b) plus the zones and events; (c) all eleven. Recommendation: (a), all `required`. Under
  C110 a `required` activation no longer blocks a session: a missing value is left out with `required_value_missing`
  and shown as such (form C, later, holds the session for an administrator's choice). *Reported by the Rukovodilac
  from a read-only production check (not an O6 answer):* on 2026-11-01 the owner created three system variables —
  `duration` (min), `total_distance` (m) and `maximal_running_speed` (km/h, max 40); under C110 a speed above 40 km/h
  is left out for that athlete, not a blocked session. The check followed the owner's „napravio sam proveri" (the
  *Rukovodilac*'s session, event `755396e6`, 2026-11-01 16:52:13 UTC). It was one `SELECT` in a read-only transaction
  on `metric_definitions`, its versions and scope capabilities for `owner_scope = 'system'`, and it read no athlete
  row.
- **O7 The meaning evidence:** whether the GPEXE 6 handbook counts as official documentation for a server reporting
  9.11.8, or a written GPEXE support answer is needed. *Decided for the three pilot fields (section 12.3).*
- **O8 The count unit** (only if O6 includes an event count): `count` as the proven source unit, or `n` with a new
  conversion row.
- **O9 The C97 timing:** P1 on the 05–06.10 snapshots before about 2026-11-10, on the 11.10–24.10 snapshots before
  about 2026-11-23, or after a refreshing search (a GPEXE request).
- **O10 The gates' state:** the production-use gate (identity, minors included) and link gates (1) and (2).
  *Decided (section 12.3).*
- **O11 Condition 5** (a team archived during a running check): closed by F3c2g's re-checks, or still open (needed
  before regular imports, not before the pilot).
- **O12 The plan lines:** the owner adds phase 9's "Input (red zone)" and "Start" lines, or states that section 10 of
  this contract is the phase's red-zone list.
- **O13 When 9-B is deployed** (section 7.3): the owner names the deploy of the commit that carries 9-B (and its merge
  while auto-deploy is on): at once after both GOs, or after M6 steps 2–5. Until then no other deploy carries it, and
  later commits follow the same rule until 9-B is live, deployed on the owner's word (R3).
- **O14 No migration in phase 9.** C98 records that a database guard for canonical rows stays "an optional later
  hardening (a migration), before M4" (`discovery:871-873`, the owner's wording): whether "before M4" binds. Without
  one, "never a value without its T6 row" rests on the writer and its tests (section 2). Recommendation: no migration
  in phase 9; the guard stays optional later.
- **O15 A technical bound on the import window.** Today the switch is environment-wide, so while it is on any active
  platform admin or granted coach could approve any actionable candidate of any team; the window relies on the freeze
  and on step 11's lists. Option: an allowlist of one candidate id read together with the switch. It changes how the
  switch is read, so it is the owner's decision (section 14). Recommendation: the procedural controls of section 10.3
  for the pilot; the allowlist only if step 11 shows another actionable candidate or another approver the owner does
  not accept.
- **O16 A club variable through an import.** The activity results carry only a value's definition id, which the
  catalog hides from a team coach for a club-owned variable (`trainingLoadMetricsAccess.js:116-134`). Until the owner
  decides whether a team coach sees a club variable's name and unit there, no club mapping is switched on for a team
  binding. Recommendation: decide it with 7h (club mapping approval); the pilot uses system variables only.

### 12.3 Decided by the owner

Relayed by the *Rukovodilac* with the owner's words and event ids, each checked by the executor in the *Rukovodilac*'s
transcript.

- **A1: the acceptance of this contract, and O1, O3–O6, O8, O9, O11–O16** — „Prihvatam ugovor J17 (faza 9). Preostale
  odluke O1, O3–O6 i O8–O16 po preporukama Rukovodioca: prvi uvoz u produkciji, put nazad je vraćanje celog backupa,
  F3c4 posle uvoza, preskočiti Q1(c) i cap za pilot, polja pilota trajanje/distanca/max brzina sa Required, O8 ne
  treba, O9 urađeno, O11 pre redovnih uvoza, sekcija 10 je spisak crvene zone, 9-B deploy odmah posle oba GO-a na moju
  reč, bez migracije, proceduralne kontrole prozora, samo sistemske varijable u pilotu.” (owner turn `e34ccb50`,
  2026-11-01 21:23:53 UTC, with a screenshot). Read item by item against section 12.2:
  - **O1:** the first import is in production.
  - **O3:** (a) — a full restore of the backup is the only way back for the pilot.
  - **O4:** F3c4 comes after the controlled import.
  - **O5:** Q1 (c) and the pinned step's cap are waived for the pilot (system mappings only).
  - **O6:** (a) — `total_time`, `total_distance` and `max_v`, each activation `required` (under C110 a missing value is
    left out, not a blocked session).
  - **O8:** not needed (no event count in the pilot).
  - **O9:** done — P1 on the stored snapshot of session 190122 (PR #316).
  - **O10:** not in this turn; decided by the owner's next turn (below).
  - **O11:** condition 5 stays open, to be closed before regular imports, not before the pilot.
  - **O12:** section 10 of this contract is phase 9's red-zone list; the plan needs no "Input (red zone)" or "Start"
    line for it.
  - **O13:** 9-B is deployed at once after both GOs, on the owner's word naming the deploy (R3 unchanged). *Amended
    by the work order `628d0be9` below: no owner's word.*
  - **O14:** no migration in phase 9.
  - **O15:** the procedural controls of section 10.3; no allowlist.
  - **O16:** system variables only in the pilot.

- **O10: the gates' state** — „Ne treba pravni osnov” (owner turn `bdb881f2`, 2026-11-01 21:25:05 UTC), the answer to
  the *Rukovodilac*'s question (its turn `dd5ccc68`, 21:24:20 UTC) whether a legal basis and a notice to the athletes,
  and to the parents of minors, exist for OptiMove processing their names, dates of birth and GPS data from GPEXE.
  Read:
  - **The production-use gate** (the legal basis and the notice for names and dates of birth, minors included): the
    owner decides it is not required. This is the owner's own assessment, not a legal confirmation; the *Rukovodilac*
    named the risk to the owner before recording it.
  - **Link gate (1)**, the count of non-canonical `gpexe_athlete_id` values in the deployed `gpexe_athlete_links`
    (expected 0): not part of the owner's answer and stays open as a technical check. It is a line of step 11's
    preflight ("the non-canonical link count 0", section 10.3); a non-zero count stops the window.
  - **Link gate (2)**, the helper values on *Link athletes* against GPEXE's own view: recorded as met, on the
    *Rukovodilac*'s proposal checked by the executor (not an owner decision). The screen shows each athlete's
    whole-session preview values `gpexe_time_min`, `gpexe_total_distance` and `gpexe_max_speed`
    (`backend/src/gpexeImportService.js:1481-1497`), which the mapper computes from `total_time` ÷ 60,
    `total_distance` and `max_v` × 3.6 (`backend/src/gpexeImportMapper.js:128-175`). The C97 comparison (PR #316,
    session 190122) found on the GPEXE screen exactly those three conversions of the raw `rest_v1` values for 13 of 13
    athletes. So the gate rests on that comparison and on the code path; the *Link athletes* screen itself was not
    compared, and the C97 document still lists the link gates as separate checks (its section "Limits").
- **O2** — „O2: backup ručnim pg_dump-om sa mog računara i proverom vraćanja u lokalni Postgres. Pripremi postupak u
  9-R.” (owner turn `9348cbc7`, 2026-11-01 19:20:57 UTC). Section 12.2, O2.
- **C110: a value out of the variable's limits, and a missing value of a required field** — „1. Vrednost van granica
  varijable i vrednost koja nedostaje kod obaveznog polja: cilj je opcija C — sesija čeka, admin bira „izostavi samo tu
  vrednost" (podrazumevano) ili „uvezi ipak" uz obavezan razlog i zapis ko je odobrio. Za pilot, dok C ne postoji,
  opcija B — izostavlja se samo ta vrednost, ostatak sesije se uvozi, pregled jasno kaže zašto. Izmeni J17 (R8, C14,
  O6) u skladu s tim pre koda 9-B.” (owner turn `f2ed35f4`, 2026-11-01 19:22:07 UTC). Built as form B in 9-B
  (section 3, step 8; section 6; section 8.2; R8; O6); it supersedes C14 and section F's row 4 for the pilot. Form C
  is a separate, later work.
- **C111: editing a canonical variable** — point 2 of the same turn: „Izmena varijable: naziv, kratak naziv, opis i
  ikona uvek se menjaju na licu mesta. Jedinica, dnevno sabiranje, min/max, uslov, nivoi i ključ menjaju se na licu
  mesta samo dok varijabla nema nijednu vrednost i nijedno mapiranje; posle toga samo nova verzija (ključ trajno).
  Svaka izmena se beleži. Pripremi ugovor kao poseban posao posle faze 9.” A separate contract after phase 9; not in
  this one.
- **O7: the meaning evidence of the three pilot fields** — „O7: prihvatam GPEXE 6 REST priručnik (str. 11, 37–38, 52)
  kao dokaz značenja za total_time, total_distance i max_v na serveru 9.11.x.” (owner turn `9b1f4a69`, 2026-11-01
  20:10:49 UTC). The evidence is `docs/ai/gpexe-c97-meaning-evidence.md` (PR #318); the unit evidence of the same
  fields is `docs/ai/gpexe-c97-unit-evidence.md` (PR #316, merged on the owner's word, turn `5e2df34f`). Section 10.1's
  P1 and P2 are thereby ready for step 2 of section 10.2 once PR #318 is merged.
- **M6 steps 2–5 done, as the owner reports them** — „Total distance i Maximal running speed uključeni za First team,
  kao Duration.” (owner turn `35fc8434`, 2026-11-01 21:38:27 UTC). With the report of 22:23 CET (Duration switched on):
  the three system mappings (TIME → Duration, TotDist → Total distance, SPEEDmax → Maximal running speed) have version
  1 active and are switched on for the First team's binding (GPEXE team 980), each `required`. The database was not read.
- **The owner's work order** — „kada bude nesto trebalo javljaj, mada vecinu stvari koje smo dogovorili da radis bez moje
  pomoci radi a to podrazumeva postcek, precek, merogovanje, deploy, samo deploy sa migracijama me mozes pitati i nesto u
  vezi promene planiranja ili neka odluka viseg nivoa. Sve ostalo samostalno” (owner turn `628d0be9`, 2026-11-01
  21:39:51 UTC, in the *Rukovodilac*'s session; relayed with the *Rukovodilac*'s reading, checked). For this contract:
  - **O13 and R3, 9-B:** no owner's word for the merge or the deploy. After both GOs (the *Rukovodilac*'s and the
    *Nezavisni revizor*'s ★★), 9-B merges under the standing merge order, and the *Rukovodilac* deploys it under its
    "a deploy without a migration after a merge, as needed" (`metrics-core-plan.md:373-375`). Its commitment of section
    7.3 ends.
  - **Steps 11 and 16:** the owner's recorded word that lets the *Rukovodilac* run the read-only pre-switch preflight
    and post-import check through its connector, inside the plan's read-only wrapper, from the merged files named by
    their sha256 (step 6a). It never writes.
  - **Evidence documents and other PRs without a migration** that this contract put on the owner's word: the
    *Rukovodilac*'s GO under the standing merge order, and the *Nezavisni revizor*'s GO where a ★★ review asks for it.
  - **Unchanged:** a PR with a migration and its deploy (the owner's order naming the migration, and the owner's „da”);
    the import switch, the key and the window (steps 9, 10, 12–15: the owner's own actions); a change of the plan's
    sections 1–4, of the ★ marks or of the phase order (never by relay, `metrics-core-plan.md`, section 2). The plan's
    text is not changed: its step 6 already lets the *Rukovodilac* deploy without a migration, and the standing merge
    order already covers PRs without one.
- **C112: mapping by drag and drop** (owner turns `7fca0a79` and `fbeca2ea`, 2026-11-01; discovery C112) — a direction
  for mappings after the pilot; it changes nothing in this contract.

---

## 13. Risks

- **The snapshot expiry** (P1, O9).
- **More locks per approval** while condition 2 is unbuilt; 9-0 comes first.
- **A rare deadlock answered `try_again`** (a roster command, a platform-admin revoke and an approval together; step 6b).
- **The visible change at the 9-B deploy** (section 7.3, O13).
- **No production undo** (O3); a restore loses every later write.
- **A value silently missing from an imported session** (C110, form B): a required or out-of-range value is left out
  while the rest imports; the review must make every gap visible, and form C (an administrator's choice) is later
  work.
- **Unconfirmed meanings** (burst and brake; every field's meaning needs P2).
- **The production state is inferred, not queried:** no `gpexe_*` definition, no Metrics Core connection for the First
  team, no confirmed revision, no canonical variable.
- **The switch's effect after a Render change** is not verifiable from the repository (steps 13 and 15).
- **The switch is environment-wide** while it is on (O15); the window rests on the freeze and step 11's lists.
- **Short rosters** for sessions from before an athlete's membership (an open risk of `CURRENT_STATE.md`).
- **"Nine" against "ten" fields** in the plan and CURRENT_STATE against J4 and the C97 runbook (v42's open top zone).

---

## 14. Not in this contract

C110's form C (a session held for an administrator's choice, "import anyway" with a reason and a record) — a
separate, later work; editing a canonical variable (C111) — a separate contract after phase 9; the switch's default or
how it is read (unless O15); regular production imports and conditions 4 and 5; Link and Unlink; several
tracks (M5, phase 10) and estimates (phase 10, no T6); derived variables (phase 11); the session list and drill reads;
7h, 7i and the plan's R1 (the re-import of a session); a production undo (unless O3 (b)); F3c4 (unless O4); a new source or adapter; a cleanup of existing
`gpexe_*` definitions; any GPEXE request, persistent-database read or write, Render or Supabase setting or credential
by the executor.

---

## 15. Review record (internal, before the *Rukovodilac*'s and the *Nezavisni revizor*'s reviews)

- **Round 1, on the first draft:** `db-reviewer` NOT READY — HIGH: the approver's rights locked before the registry
  closed a cycle with a platform-admin revoke and a 7d operation (now step 6b); MEDIUM: the T7 write outside a
  savepoint, no client `error` listener under an idle timeout, the check-time preview unbounded, `isPureSupplement` on
  decimals, the undo's team lock on a persistent database; LOW: R16's position, the binding justification, R2 as an
  owner item, 9-0's error mapping. `security-reviewer` NOT READY — HIGH: the candidate surfaces carried admin-only codes
  and fields to any coach (now section 6.1); MEDIUM: owner scope and data workspace unstated (now 4.1), the import window
  without controls, a merge being a deploy, logs carrying values; LOW: the instance codes' audience, R16 through the
  batch, red-zone wording. All folded.
- **Round 2, narrow, on the fixes:** `db-reviewer` READY WITH NON-BLOCKING NOTES (the roster-command cycle class that
  remains, now stated and bounded; the preview client's listener; the approval row's basis; the savepoint release;
  R16's wording); `security-reviewer` READY WITH NON-BLOCKING NOTES (the sixth surface and a required audience level;
  three levels; R17's predicate; the log field whitelist and R18; the binding scope of step 11). All folded.
- **`code-reviewer`, in four slices** (one pass over the whole document did not finish): sections 8–14 READY WITH
  NON-BLOCKING NOTES (Arm B at the writer itself; the 9-R merge before the freeze; LOW wording); section 3 READY WITH
  NON-BLOCKING NOTES (step 2a and step 6 named as departures from D; identities before the first T6 row); sections 4–7
  READY WITH NON-BLOCKING NOTES (MEDIUM: `changesToImported` values projected on every surface; LOW: today's masking,
  section F rows 1–2, the writer's source-key lookups, the scope of `no_mapped_values`); sections 0–2 NOT READY on one
  HIGH (9-0 under the standing merge order), refuted by `metrics-core-plan.md:209-211` and **closed** by the narrow
  re-review (READY); its LOW notes folded.
- No test was run (documents only); `git diff --check` clean on every commit.
- **The *Nezavisni revizor*'s ★★ review of `275cf62`:** NO-GO on one MEDIUM — O13 governed the merge of 9-B, while
  auto-deploy is off and step 6 of the standing order for migration PRs lets the *Rukovodilac* deploy a commit without a
  migration "as needed", so 9-B could go live before the owner's chosen moment. Fixed in the commit after it: O13, R3,
  section 2, section 7.3, step 6 and section 11 now govern the deploy of every commit that carries 9-B.
- **The *Rukovodilac*'s ★★ review of `275cf62`:** NO-GO on one MEDIUM — R7 as first recommended (compare the answer's
  `unit` with the revision's proven unit) contradicted the seed (`"number"` is a shape) and Arm A1; its decision: the
  literal stays as a shape check, `source_shape_mismatch`. A LOW: a Render environment change redeploys the served commit,
  so steps 13 and 15 confirm `/api/health` three times on the same commit. It accepted the *Nezavisni revizor*'s finding
  and set the deploy exception's duration and its own commitment (section 7.3, R3, O13). Its decisions on R1 and R3–R18
  are final. All folded in the commit after `5715f12`.
- **The ★★ GOs on `e57f854d`:** the *Rukovodilac* (narrow re-review; R7 and the LOW closed) and the *Nezavisni revizor*
  (narrow re-review; one optional LOW: section 7.3 and R3 end the deploy exception "until M6 steps 2–5 are done or the
  owner says otherwise" while O13 has the owner name the deploy, so the text should read "until 9-B is live, deployed
  on the owner's word (O13)"; the *Rukovodilac*'s unconditional commitment already covers it). The *Rukovodilac*
  accepted it as a wording correction without a new head; it goes into the first later pull request that changes this
  contract anyway (the owner's acceptance edit, 9-0 or 9-B), recorded here then.
- **Amendment after the owner's decisions of 2026-11-01** (section 12.3): C110 as form B in step 8, section 6, 6.1,
  8.2, R8, O6 and the risks; O2 decided; C111 recorded out of scope; the *Nezavisni revizor*'s LOW folded (section
  7.3, R3 and O13 now end the deploy exception "until 9-B is live, deployed on the owner's word (O13)").

---

## 16. As built (9-B)

The 9-B pull request (branch `feature/phase9-b-mapped-writer`), built on `8fa0ea7` (merge of PR #322, 9-0; the base).
Merged as PR #326 (`b6c2254`, exactly from `fec1bde3`, 2026-11-02 08:38:27 UTC, after both ★★ GOs) and deployed by
the *Rukovodilac* the same morning (`/api/health` first served `b6c2254` at 08:42:51 UTC); its test follow-up, PR #327, is
merged as `f4f2772`. No migration (O14); the import switch untouched. The *Rukovodilac* accepted the decisions
D1–D38 of the executor's 9-B plan as recommended (2026-11-02), with the conditions on D9 and D29 written below. This
section names functions and tests, not line numbers.

### 16.1 What was built, by step

- **Steps 1–2a (approval).** An unlocked `canApproveGpexeImport` inside the transaction gives the early
  `403 not_an_approver`; then the candidate `FOR UPDATE`, the existing refusals and the team import lock. Step 2a is
  `lockApprovalTeam` (`backend/src/gpexeImportAccess.js`): the team and its club `FOR SHARE` in two plain locked reads,
  not `judge()` (it refuses a connection that is not `verified`, which C55 forbids as a condition, and its LEFT JOINs
  cannot be locked). A team or club missing or archived, or a team moved to another club since the route's check, is
  the identical 404 (R16); `notFound` is now in `BATCH_STOP_CODES`, so a batch stops at it.
- **Step 3.** `readImportBinding` (`backend/src/gpexeImportMapping.js`): the binding `FOR SHARE`, active, of the team and
  of `gpexe`, with its raw `source_team_id` (T6 compares the instance key with the stored text). At an approval it is the
  binding of the candidate's last check, pinned to the team; a `legacy_env` check, or a missing, ended or other binding,
  stores a preview blocked `mapping_not_usable` that lists the athletes, and answers `preview_changed`. At a check it is
  the run's own binding (`importSourceIdentity`); a binding found not active under the lock fails the check
  `binding_ended`, nothing staged.
- **Steps 4–5.** `readOpenActivations` (unlocked), then `lockActivations`: T2b → T3 → T4 → `metric_definitions` → T5,
  each `FOR SHARE` ascending by id, and the rows read again and compared on every field that decides a write. A
  difference throws `ImportMappingChangedError`: `409 preview_changed` with nothing stored at an approval,
  `check_preview_busy` at a check. R11: a variable without the scope capability of a level it is switched on for
  (`session`, `component`) is `mapping_not_usable`. The labels of the binding family's active fields with no open
  activation give `unactivatedSourceMetrics`.
- **Step 6.** `lockSourceInstance`: the team's active team-owned gpexe v11 row is found, then locked `FOR UPDATE` by id
  (R6: found inactive → `mapping_not_usable`). Its T7 keys are set from NULL, or a row is inserted with them, inside
  `savepoint gpexe_source_instance`; a `23505` is told apart by its constraint (`source_instance_held`, or
  `mapping_not_usable` for the one-active-gpexe-per-team index). Keys that differ → `source_instance_changed`; the
  session under another instance → `session_imported_under_another_instance` (a boolean lookup). **6b:**
  `lock_gpexe_import_approver` runs after it; `42501` → `403 not_an_approver`; the approval row's basis and grant come
  from this locked result.
- **Steps 7–8.** `mappedMetricSpecs` (`gpexeImportMapper.js`) builds one frozen spec per locked activation through
  `extractorFor`, or refuses with `mapping_not_usable` or `source_unit_mismatch`. `buildGpexeImportPlan(bundle, {
  metricSpecs })` converts each value with `convertAtStorageScale` and checks the range with `compareDecimal`,
  inclusive. `classifyMappedPlan` decides the whole-candidate blocks and `leftOutReason` the Left-out reasons;
  `SKIP_CATEGORY` (`sourceMetricExtractors.js`) classifies the 18 extractor codes. Before the locks only the gates run
  (no specs), to name the session and its GPEXE team.
- **Steps 9–11.** The writer (`gpexeImportWriter.js`). `importGpexePlanLocked` checks C55 for every value before any
  write (`checkMappedValues`) and refuses `no_mapped_values` when no value remains. It writes each value as decimal text,
  then its T6 rows in the same function (`metricValueProvenanceInsert`, matched by definition id). It creates no
  definition: `ensureSourceConnection` and `ensureMetricDefinitions` are removed. The occasion content hash covers the
  canonical definition and version, the mapping version, the value and unit, and the source value and unit. A current
  value under another mapping version, or without a T6 row, gives `needs_review`. `importGpexeBundle` and
  `importGpexeBundleLocked` replace `importGpexePlan` as the writer's own entry. Preview version 3
  (`gpexeImportPreview.js`); its hash adds the sorted activation set.
- **Section 6.1.** `backend/src/gpexeImportAudience.js`: the three levels, the closed code sets, `projectPreview` and
  `projectBlockedCodes`. `importAudienceOf` (`gpexeImportAccess.js`); the route computes the level once (`teamAccess`)
  and passes it to the list, the detail and the candidate inside an approval's answer. `data_setup_incomplete` is the
  `blockedCode` of the eight blocking codes (`gpexeImportReasons.js`).
- **R12.** `listSourceAthletes` and `getCandidate`'s `helperValues` read the helper values from the snapshot through
  `wholeRowHelperValues`.
- **R14.** `frontend/gpexe-import-view.js` reads version 3 and still renders version 2: Variable, Before, Imported and the
  GPEXE value; Left-out entries by label with a plain reason; "All values left out"; the coach sentence against the
  administrators' precise sentences; the note of fields not switched on; "N values left out" on a Ready row and in the
  batch confirmation. The Mappings screen (`frontend/metric-mappings-*.js`): J16's R18 sentence removed and
  `REQUIREMENT_MEANING` rewritten for C110 form B (J16 section 15).
- **R15.** `gpexe-import-pilot.mjs` (the dry run builds gates only; `--apply` runs `importGpexeBundle` on a disposable
  database), `gpexe-pilot-disposable-run.mjs` (a mapped world), `gpexe-api-probe.mjs` (empty specs) and
  `gpexe-details-coverage-probe.mjs` (its own constants).
- **Logs (step 10).** `dbErrorFields` and `formatDbError` (`gpexeImportService.js`): code, constraint, table, routine,
  the PL/pgSQL function name and the error's name; never the message, detail, hint, `where` or a stack. Every importer
  log sink uses them, four older sinks included: the team settings, the retention schedule and link trigger errors,
  which the architecture suite found, and the retention CLI (`gpexeRetentionCli.js`), which the internal code review
  found. The suite's log test now takes as sinks every `backend/src` module that calls an importer entry point, not a
  fixed list. The disposable-database operator scripts (`backend/scripts/gpexe-*.mjs`) still print an error's text.

### 16.2 Decisions D1–D38 (accepted as recommended)

- **D1** `GPEXE_METRIC_SPECS`, `GPEXE_DERIVED_NOT_IMPORTED` and their helpers deleted from `src`; `buildGpexeImportPlan`
  has no default specs (a `TypeError` without them); the frozen copy lives in `backend/tests/support/gpexe-legacy-specs.mjs`.
- **D2** A level no activation covers produces no result (no identity, occasion or segment); a covered level whose
  values are all left out keeps its occasion with no values.
- **D3** "Admitted" means the linked active members (all participants when none is linked); no activation is always
  `no_mapped_values`; nobody linked while the mapping gives values keeps `no_changes` with the link reason.
- **D4** The plan with values is built only after the locks, at a check and at an approval; codes win in step order.
- **D5** A difference under the registry locks: `preview_changed` with nothing stored at an approval,
  `check_preview_busy` at a check.
- **D6** A check whose binding is not active under `FOR SHARE` fails `binding_ended`; nothing staged.
- **D7** Step 2a checks the team and club active and the club unchanged; the connection's club is a binding fact
  (step 3).
- **D8** `club_admin` needs the club's workspace; `adminViewerOf` is "the level is not `other`". This also narrows the
  check rows of a club admin who coaches the team, in the team workspace (audience test 5; for the security review).
- **D9** `blockedCode` is `data_setup_incomplete` for all eight codes at every level. The precise code stays in
  `blockedSourceCode` and `preview.blocked`: all eight for the platform admin; for the club's admin, with
  `mapping_not_usable` in place of the three instance codes; `other` gets the stable code and the coach sentence
  (the *Rukovodilac*'s condition; tested for every level on the six surfaces, audience tests 1 and 3).
- **D10** `previewHash` is null for a blocked candidate at `club_admin` and `other`; a candidate that is not blocked keeps
  its hash for every level (audience test 3).
- **D11** `changesToImported` in a refusal is a count, behind an integer guard in the route.
- **D12** Left-out entries keep the names `skippedValues` and `counts.skippedValues`, are listed for every participant
  with `message` in plain words; the C110 code and `sourceReason` are for the two admins.
- **D13** The value entry carries `variableScope`; `metricKey` is gone; the change labels add `left_out` and `not_mapped`.
- **D14** The Link athletes helper values are computed when read, from one whole-session row of a measured athlete in
  the snapshot, converted as doubles for display; `getCandidate` adds `helperValues` for the review's link context.
- **D15** `derivedNotImported` dropped.
- **D16** `unactivatedSourceMetrics` per binding, labels sorted, with `unactivatedSourceMetricCount`.
- **D17** A current value under another mapping version, or from before M4 (no T6 row), gives `needs_review` whatever
  the report time.
- **D18** A bundle of another GPEXE team than the binding's is `mapping_not_usable`.
- **D19** The T7 `23505` is produced through a real keyed row, not a JS fault seam (section 8.2).
- **D20** Logs carry the fields of `dbErrorFields`; errors are never re-wrapped, so 9-0's codes hold.
- **D21** The pilot CLI's dry run has no values (R15).
- **D22** The API probe uses empty specs.
- **D23** An unknown skip code throws a plain error (internal); the 18-code completeness test shows it is unreachable.
- **D24** `unexpected_unit` is the only runtime shape code; the registry is unchanged.
- **D25** An empty `events` object (`{}`: present, without the version's threshold or duration fields) gives
  `threshold_mismatch`, which blocks the candidate (a known limit). An absent `events` object is `events_missing`,
  which leaves that value out (C110 form B).
- **D26** R17 uses `resolveVariableEditor` unchanged, asked lazily; any error masks the name.
- **D27** The activation set enters the preview hash only, not the preview JSON.
- **D28** `importGpexePlan` removed; `importGpexeBundle` and `importGpexeBundleLocked` keep the athlete map strict
  (`onlyMapped` for tests).
- **D29** An athlete whose values are all left out still counts as imported for the roster (participation recorded).
  The *Rukovodilac*'s condition: the review shows that athlete with "All values left out" and the reasons, never as
  imported with data (`allValuesLeftOut`; audience test 4).
- **D30** No backend module outside the GPEXE importer and the extractor registry changes; `resolveVariableEditor` is
  unchanged; `PARAMS_AS_TEXT` is copied into `gpexeImportMapping.js`.
- **D31** `REQUIREMENT_MEANING` rewritten for C110 form B in 9-B; reviewed by `code-reviewer` only (the *Rukovodilac*).
- **D32** "N values left out" on Ready rows and in the batch confirmation; the approval note reads "Athletes and values
  left out stay out.".
- **D33** No version marker for the content hash.
- **D34** The writer's C55 checks are D5's (`checkMappedValues`); R6 locks the instance by id in two steps.
- **D35** The check routes keep `adminViewer`; a check answer carries no candidate; surface 6 is the list read again.
- **D36** Only step 3 short-circuits an approval; a block at step 6 still runs step 6b and is refused at step 12.
- **D37** A step-3 block stores a preview that lists the athletes (`session_blocked`).
- **D38** A team without a club compares null with null at step 2a.

### 16.3 Departures from the text above

- **Section 4, the value entry:** it also carries `metricDefinitionId`, and a value the result had and this import does
  not write can also read `missing_in_gpexe` (D13 named `left_out` and `not_mapped`).
- **Section 4 / D16, `unmappedSourceFields`:** always 0, by construction. The server3 snapshot keeps only the fields the
  extractor registry reads (the adapter's `BUNDLE_FIELDS`), so no walker was built and no test uses an unprojected
  bundle.
- **Section 6.1, the batch:** `approveCandidates` receives the level but does not read it; its results carry only the
  neutral `blockedCode` and a count, which audience test 1 checks for every viewer.
- **Section 8.2, the T7 refusal:** D19.
- **Section 8.1, Arm A1:** the writer's own entry is `importGpexeBundle` (D28), not `runImport`.

### 16.4 Tests

- **New suites:** `backend/tests/gpexe-import-mapped-plan-9b.test.mjs` (unit: the spec builder's refusals, the plan
  against the oracle, D2, the 18 codes, C110, R7, R8, R9, never a zero, `gpexeLevelValues`, `wholeRowHelperValues`, D3,
  two mappings of one field); `gpexe-import-mapped-9b.test.mjs` (Arm A1, the writer half of A2, Arm B1 and an ended
  activation, R12); `gpexe-import-mapped-routes-9b.test.mjs` (Arms A2, B2, B3 and C); `gpexe-import-mapped-audience-9b.test.mjs`
  (the D9 matrix, each blocking code arising for real, D10 and the granted coach, D29 with C110 and R17, D8);
  `gpexe-import-mapped-architecture-9b.test.mjs` (C46, a T6 row for every value, specs only from the registry, the test
  seams, the log sinks, the audience on the six surfaces); `gpexe-import-mapped-concurrency-9b.test.mjs` (the writer
  against a 7d end in three orders through the mapping hold seam, an approval against an Unbind and a 7g end in both
  orders, two approvals of one team, a revoke and a 7d end during an approval - no `40P01`, `403` -, R16 through the
  single route and the batch, the T7 `23505` inside its savepoint for the writer and the approval);
  `gpexe-import-mapped-writer-9b.test.mjs` (D17 `needs_review` under a replacement version, the exact-decimal
  supplement, the two closed power zones keyed apart, `PARAMS_AS_TEXT` parity, D18, R6, R11).
- **Added to `gpexe-import-bounds-9-0`:** 6c2 (LOW-1), 12c (LOW-2), the idle gap in 8 and the synthetic session 8b
  (LOW-3).
- **New support:** `backend/tests/support/gpexe-legacy-specs.mjs` (the frozen pre-9-B specs, the oracle),
  `support/gpexe-fake-source.mjs` (the fake server3 source and binding through the routes, extracted from
  the finalization suite's own, which it keeps), `support/mapped-world.mjs` (the ten seeded revisions confirmed with every guard on, eleven system
  variables and active mappings through the real services, bindings and activations).
- **Rewritten onto the binding path with activations, or onto the mapped writer:** `gpexe-import`,
  `gpexe-in-app-import`, `gpexe-batch-approve`, `gpexe-import-bounds-9-0`, `gpexe-check-finalization`,
  `gpexe-import-credential-resolver`, `gpexe-import-values-batch`, `gpexe-undo-session`, `gpexe-undo-guards`,
  `gpexe-backup-verify`, `gpexe-import-reasons`, `activity-roster-5a1`, `activity-roster-5a2`,
  `activity-roster-self-report`, `central-calendar-k1a`, `source-metric-extractors-7f`, `source-metric-preview-7e`,
  `source-metric-preview-math-7e`, `gpexe-rest-v1-adapter-reads`, `gpexe-details-coverage-probe`,
  `source-metric-mapping-m2`, `metric-variables-m3-0` and `source-instance-end-7g`; in the frontend
  `gpexe-import.actions`, `gpexe-imports-batch.actions`, `gpexe-imports-id-masking.actions`,
  `gpexe-imports-v33.actions` and `metric-mappings.actions`.
- **Retired on purpose** (9-B removes the behaviour): in `gpexe-import`, "an existing definition whose GPEXE source
  context changed stops the import" and "an import racing a catalog archive of its definition". The importer no longer
  creates or checks its own definitions.
- **`source-instance-end-7g` test 7** now builds its own state (the *Nezavisni revizor*'s LOW-1 on PR #305).

### 16.5 Measurements (LOW-3; bounds tests 8 and 8b)

PostgreSQL 16 on a disposable database in the executor's container; PostgreSQL 17.6 (production) was not measured.
- Arm A1, the writer (53 values, 53 T6 rows): 68 statements; the longest statement 8.1 ms
  (`materialize_activity_group_from_metric_event`); the COMMIT 3.4 ms; the longest idle gap 2.4 ms.
- An approval through the route (one candidate, both drills): 86 statements; the longest statement 6.7 ms
  (`activity_roster`); the COMMIT 1.9 ms; the longest idle gap 1.8 ms (after `lock_gpexe_import_approver`).
- A synthetic session of 40 athletes on 6 levels with the eleven activations: 2,640 values and 2,640 T6 rows; 1,334
  statements and 1,207 ms of statement time; the longest statement 15.7 ms; the COMMIT 3.1 ms; the longest idle gap
  33 ms.
- The bounds are 10 s per statement, 10 s idle in a transaction and 5 s per lock wait; the tests assert each measure
  below a quarter of its bound.

### 16.6 The *Nezavisni revizor*'s LOW notes on 9-0

- **LOW-1** (bounds test 6c2): once the COMMIT is sent, no error is answered `try_again`. A 55P03, 40P01, 57P01, 25P03
  or 57014 raised by the COMMIT is `503 import_outcome_unknown` when it did not land and `200` verified when it did.
- **LOW-2** (bounds test 12c): an approval and an undo of the same team both take the team import lock first and their
  rights after it, so they serialize in both orders; the second waits on the advisory lock, never a deadlock.
- **LOW-3** (bounds tests 8 and 8b): section 16.5.

### 16.7 Mutations

- LOW-1: N7a (the COMMIT's catch rethrows instead of `resolveUncertainCommit`) and N7b (N7a plus the outer `!commitSent`
  guard removed) are killed by test 6c2. N7c (the outer guard removed alone) survives: every COMMIT error is resolved
  in the inner catch, so the guard is unreachable defence in depth.
- Audience suite: M-D9 (the club admin reads the instance codes unprojected), M-D10 (a blocked candidate's hash for every
  level), M-D8 (`club_admin` in any workspace), M-R17b (every coach reads a club variable's name) and M-R17c (the
  projection never hides it) are killed.
- Architecture suite: test 5 found the three older log sinks of section 16.1, fixed.
- Concurrency and writer suites: M-R16 (step 2a removed), M-T7 (the source-instance savepoint removed), M-D18 (the
  bundle-team guard removed) and M-PARAMS (`PARAMS_AS_TEXT` without `trim_scale`) are killed.

### 16.8 Section 8.2 items and where they are tested

- The concurrency cases (a 7d version end, an Unbind, a 7g end, two approvals of one team, the revoke during an
  approval), R16 through the single route and the batch, the preview with the mapping hold seam and the T7 `23505`:
  `gpexe-import-mapped-concurrency-9b`.
- R6, R11, D18 and the `PARAMS_AS_TEXT` parity (D30): `gpexe-import-mapped-writer-9b`. R6 is built with every trigger on
  by ending the instance between the importer's unlocked read and its lock; R11 removes a level's capability with the
  history triggers off, as the 7d suite's `rawActivation` does, because with them on the capability cannot be removed.
- The stale-hash `changesToImported` count: the single 409 in `gpexe-in-app-import`, the batch's
  `changes_need_acceptance` in `gpexe-batch-approve`.
- A value-bearing database error: the batch suite's `42P01` carrying a marker text on the approval path (the log names
  the code, never the text), and the architecture suite's rule for every importer log sink.

### 16.9 Recorded, not changed

- **Pre-existing, confirmed by the security review (MEDIUM, a separate task):** a coach of a team whose club was
  archived still reaches the GPEXE team routes. The club archive (`DELETE /clubs/:id`) sets only `clubs.is_active`;
  `loadAvailableWorkspaces` still offers the team workspace and `resolveGpexeTeamAccess` checks the team, not its club.
  Reads (status, candidates, source athletes, approvers) and Link / Unlink stay open to that coach; a check start is
  refused by the credential resolver (`team_club_active`) and, since 9-B, an approval by `lockApprovalTeam` (the
  identical 404). No other tenant's data is reachable. The fix (the club's `is_active` in `resolveGpexeTeamAccess` and in
  the team-workspace query) is outside 9-B and is recorded for a separate task.
- **Line references.** Sections 1–9 and 12 cite lines at `1932ad1`, as the header says. 9-0 moved
  `gpexeImportPreview.js` and `gpexeImportService.js` by about 70–80 lines (to `8fa0ea7`), and 9-B rewrote the mapper,
  the writer, the preview and much of the service, so most cited lines in those files no longer match. They are not
  rewritten: read them at `1932ad1`. The 9-B plan's own line numbers are at `8fa0ea7`.

### 16.10 Internal review round (frozen head `71caa135`)

`code-reviewer`, `db-reviewer`, `security-reviewer`, `mobile-qa` and `ux-design-reviewer` each answered READY WITH
NON-BLOCKING NOTES; none found a BLOCKER or HIGH. Fixed in the next commit, each with a test:
- **Code, LOW:** the Required / Optional text promised the session is always imported - a session with no value left
  is blocked `no_mapped_values`; the text says so now. D25 here said "a missing `events` object" for what the code does
  with an empty one (an absent one is `events_missing`, left out); reworded. The retention CLI (`gpexeRetentionCli.js`)
  still logged an error's message; it uses `formatDbError` now, and architecture test 5 takes as log sinks every
  `backend/src` module that calls an importer entry point (the CLI included), not a fixed list. **NIT:** routes test C
  plants a real version 2 preview (values by `metricKey`, `derivedNotImported`, no version 3 field).
- **Code and security, NIT / LOW:** the route no longer passes a dead `audience` to `approveCandidates` (the batch
  answers the same neutral result for every level); architecture test 6 now asserts that neither approval call takes an
  audience and that both pass `expectedClubId: access.clubId` (R16).
- **Security, LOW:** the coach's projection removes named fields; audience test 4 now pins the exact key sets a coach
  reads (the preview, an athlete, a result, a value, a Left-out entry), so a new field must be decided for that level.
  Architecture test 5 also refuses `.detail`, `.hint`, `.where`, `.cause`, `.internalQuery` and `toString()` in a log
  call.
- **Database, MEDIUM (F1):** the concurrency suite had no case of the importer against the 7b transitions, the revision
  lifecycle's pinned step or a canonical variable version. Tests 8–10 add them, both orders, no `40P01`:
  - 8a / 8b: an A2 disable of the version the activation pins waits at the import's T3 row, or holds its locks first
    and the import's step-5 re-read answers the change;
  - 9: the lifecycle's L5 retirement waits at the T2b row, or holds it first;
  - 10: a canonical variable version create waits at the `metric_definitions` row and is then refused
    `variable_pinned` (decision 9: a variable a mapping pins keeps its current version), in both orders.
  - They disable versions and retire revisions of the suite's shared world, so they stay last in the file.
  - Removing the step-5 `FOR SHARE` fails 8a, 8b, 9 and 10 (and 1a, 1c, 5).
- **Database, LOW (F2):** the approval, the check-time preview and the writer's entry open with
  `begin isolation level read committed` (steps 4–5 read, lock, read again and compare); architecture test 7 pins it.
- **UX, MEDIUM M1–M5** (text and view only):
  - M1: `no_mapped_values` says it covers "no mapping switched on for this team gives a value for this session" and
    "every mapped value left out", and its step names the mappings with the levels they cover and the Left-out reasons.
  - M2: `mapping_not_usable` names the team's GPEXE binding as well as its mappings, and the step ends with "ask a
    platform administrator".
  - M3: the athlete's summary names its values left out, and the approval note names the session's count (D32).
  - M4: the value table's header is "OptiMove value" (or "Before | New value"), never "Imported" before an approval.
  - M5: Required / Optional say that both import the same way for now and differ only in the reason the review names.
  - **UX, LOW:**
    - L1 in part: a coach reads "not set up for import" instead of "not switched on", and an administrator reads
      where to set up a mapping and switch it on. The C110 Left-out words stay as section 6 fixes them.
    - L2: a result with no value says "no value imported (see Left out)".
    - L3: the shape and instance steps name a platform administrator; `session_imported_under_another_instance` says
      the session stays out (ending an instance never lifts it).
    - L4: a switch-on says "Imports use it from the next Find new sessions."
  - The coach's sentence is unchanged (section 6 fixes it).
- **Mobile, LOW:** a v3 table's first column wraps a long unbroken label, and the field note is 0.9rem, full contrast
  and wraps. A non-zero value below 0.005 keeps three significant digits instead of reading "0".

Narrow re-reviews of the fixes: `code-reviewer`, `ux-design-reviewer` and `db-reviewer` (F1, F2) answered READY WITH
NON-BLOCKING NOTES; F1 and F2 are closed. Applied:
- `fmtValue` is pinned for 0.0012345, 0, -0.004 and 0.005;
- the coach's key sets are also pinned for the session, `thresholdsUsed`, the counts, `gps` and `participation`;
- `no_mapped_values` also covers "a mapping is switched on but gives no value for this session" (no level covered),
  and its step names the levels;
- the administrator's field note says to set up a mapping and switch it on;
- `session_imported_under_another_instance` no longer points to ending an instance;
- `source_instance_changed` points to the team's binding first.

Recorded, not changed:
- the pre-existing archived-club access (16.9);
- R17 resolving the workspace a second time (`resolveVariableEditor`), and comparing the viewer's club with the team's
  current club, not the variable's owner (LOW; name-only, narrow precondition);
- an optional / other Left-out entry keeps the extractor's code in `reason` for a coach (NIT; the same as version 2,
  shown as plain words);
- the step-3 refresh of a blocked preview before step 6b (D36, accepted);
- one pre-existing statement that may grow with history, `assertNoIdentitiesMissingFromSource` (LOW; no EXPLAIN run);
- a runtime canary test for a value-bearing database error on the approval path beyond the batch's `42P01` (LOW);
- UX NIT (b) "its data setup" and NIT (c) `white-space: nowrap` for value cells;
- from the database re-review: the import-first orders of tests 8a, 9 and 10 finish inside the writers' 2 s row lock
  timeout (a flake risk on a very slow machine, not a correctness gap); A1 replace is not a separate case (it takes only
  `FOR SHARE` locks the import does not conflict with, so it never waits on the import); a behavioural proof of the
  READ COMMITTED pin under a `repeatable read` server default is not built (architecture test 7 is static).

### 16.11 After the external review of PR #326

The *Nezavisni revizor* gave GO on the frozen head `fec1bde` with two LOW test-coverage notes, both code correct;
their two surviving mutations (M4, M8) are now killed by a test each (a test-only follow-up pull request):
- **L1:** concurrency test 1d swaps the binding's one open activation for a new one of the same version between step 4
  and step 5 (the same count, another id). Only the decision-key compare in `lockActivations` catches that, and the
  import answers `mapping_changed` with nothing written. With the compare replaced by a no-op, 1d fails.
- **L2:** writer test B8 tampers with a built plan before `importGpexePlanLocked`: a value that is not the exact
  conversion, another target unit, or another mapping version. Each is refused `mapping_not_usable` before anything is
  written. Without the conversion re-check, B8 fails: the T6 trigger then refuses the row with a database error instead
  of the stable code.
- **The Rukovodilac's LOW (step 3):** his mutation of step 3 (`if (!binding)` → `if (false)`) survived, because
  `prepareImportMapping` answers a missing binding with the same blocked preview, and step 12 then gives the same
  `preview_changed`. Concurrency test 2b ends the binding after the check, then approves the still-pending candidate:
  409 `preview_changed`, the stored preview blocked `mapping_not_usable`, no row added or removed. The approval observer
  is never called, so the approval stops before step 6b and the preview. With the mutation the observer is called, and
  2b fails.
