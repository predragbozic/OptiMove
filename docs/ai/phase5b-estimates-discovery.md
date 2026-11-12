# Phase 5b (6b): estimated values for an athlete without GPS data — discovery

Status: **discovery only.** No code, no migration. Ordered by the owner before the identity load's team-mode rights (relayed
by the *Rukovodilac*, 2026-11-11). The owner's requirements of 2026-11-09 are in `docs/ai/j20-session-review-contract.md`
section 7; this document says what the existing model offers, what is missing and how to build it.

Last verified against commit: `b9460a0` (main after #492). Paths are under `backend/src/` and `migrations_v2/`.

## 1. What Metrics Core already has

| Fact | Where | What it means for an estimate |
|---|---|---|
| `metric_measurement_occasions.entry_method` in (`manual`, `api_import`, `csv_import`) | v13, a CHECK | There is no "estimate" way of capture. A dashboard series can already filter by it (`source_policy` `manual` / `api_import` / `csv_import`, `trainingLoadDashboardQuery.js` `resolveFactsToRows`). |
| `metric_values.is_derived` (boolean) and `computed_by_ref` (jsonb) | v13 | Meant for computed numbers. v3 of the activity track ties them to rollups: `computed_by_ref` non-null **requires** `aggregation_role = 'derived_rollup'`, and `derived_rollup` requires `is_derived` and `computed_by_ref` (`metric_values_computed_by_ref_requires_derived`, `…_derived_rollup_requires_provenance`). |
| `aggregation_role` (`standalone` / `source_rollup` / `derived_rollup`) and `coverage` | v3 extensions | An estimate is not a rollup of components; it is one athlete's one number. Storing it as `derived_rollup` would lie to the dashboards' "Values included" filter. |
| `source_policy = 'derived'` in a dashboard series | v16, `resolveFactsToRows` (`f.isDerived`) | Selects only `is_derived` values; `all_with_conflicts` (the default) includes everything. |
| Values are append-only (`metric_values_immutable`); a correction is a new occasion that supersedes the old one | v13 | An estimate is never edited in place; replacing it is a new occasion. |
| `metric_value_source_provenance` (T6, one row per imported value with its mapping activation) | v34 | Import provenance only; an estimate has no source activation. |
| `metric_definition_versions.daily_aggregation_method` in (`sum`, `avg`, `max`, `last`, `none`), `value_type` | v10 | Decides which variables can be estimated (section 4). |
| The undo (`training_load.undo_imported_session`, v57; v60 for roster work) | v57 lines 304–307, 550 | It removes every participant, occasion and value of the event, but **refuses** (`manual_occasion`) when any occasion of the event is `manual`. |

**Conclusion.** None of the existing markers fits without bending a meaning: `manual` would make an estimate look typed in by a
person from a measurement, `is_derived` with `computed_by_ref` forces `derived_rollup`, and `is_derived` alone carries no
method or basis. An estimate needs its own capture kind and its own provenance.

## 2. Where it lives (recommended: a new capture kind and a provenance table)

- `metric_measurement_occasions.entry_method` gains **`estimate`** (the CHECK widened). An estimate is one occasion of the
  athlete's participant in the session's event, at the whole-session level only in the first version (no drills).
- Its values: `is_derived = true`, `aggregation_role = 'standalone'`, `coverage = 'not_applicable'`, `computed_by_ref` null
  (the v3 constraints stay true and unchanged).
- A new append-only table **`training_load.metric_value_estimates`**, one row per estimated value: the value, the method
  (closed list, section 5), the basis (closed shape: the minutes used, the source athlete for a copy, the sessions and their
  count for an average, the per-minute rate), who, when (`clock_timestamp()`), and an optional note. A database guard: the value
  must be `is_derived`, numeric, of an occasion with `entry_method = 'estimate'`, of a variable whose version allows the method;
  the actor setting of the v35 family (who wrote it is the user who asked, under the right of section 6).
- **The participant.** An athlete left out of the import (J20-B) or without a GPEXE record has no participant in the event.
  The estimate adds one (no source identity) and links it to the activity's participant
  (`training.activity_participant_metric_participant_links`), so the activity's results and `training.canonical_activity_results()`
  (ADR-001, the one place activity facts are assembled) see it.
- **The label everywhere:** "Estimate · own average × 75 min · Ana Coach, 11.11.2026" (method, basis, author, date). A coach never
  sees an estimate without its label.

Rejected: `manual` + a side table (dashboards' "Manual entry only" would include estimates); `derived_rollup` (wrong meaning);
a separate value table outside Metrics Core (a second registry of facts, against ADR-007's spirit and every reader).

## 3. How the undo removes it, and the relation to an import

- **An estimate depends on the import:** it needs the session's event, which exists only after the import. The first version
  offers it **after the import**, for an athlete whose attendance is *Participated · no device data* (J20-C) — in the activity's
  Roster tab and in the imported session's review. (Offering it in the review before the import, saved with the approval like
  J20-C's states, is a later step; it would need the approval's window and request key.)
- **The undo today refuses** an event with a `manual` occasion and would refuse nothing for `estimate` (it does not know the
  kind), but it deletes all occasions of the event's participants, so an estimate would disappear silently. Owner rule O1:
  undo and re-import must always be possible, and work done after the import gets a separate warning, a list and a count, and is
  logged. So the undo is **extended** (a migration replacing the v57/v60 bodies under an md5 gate, as v60 did): estimates are
  listed in the undo's preview ("2 estimated values of 1 athlete will be removed"), removed with the event, counted in the
  deletion log (`estimates_removed`), and never block. A re-import does not bring them back; the coach estimates again.
- **When a measured value arrives later** (GPEXE re-sends the session with that athlete's data, or a link is made and the
  session is imported again): the measured occasion **supersedes** the estimate occasion (the existing supersede chain), the
  preview lists it under *changes to imported results* ("an estimate is replaced by a measured value"), and the label disappears
  because the current occasion is measured. An estimate never blocks a measured value.

## 4. Which variables can be estimated

From the variable's current version:
- **numeric** only;
- `daily_aggregation_method` **`sum`** (distance, duration, counts of accelerations, decelerations, sprints, zone distances):
  all three methods;
- **`avg`** (an average speed, a mean heart rate): copy and team average, **not** proportional (an average does not scale with
  minutes);
- **`max`** (maximal running speed), **`last`**, **`none`**: **not estimated** — a maximum cannot be inferred, and a guessed top
  speed would corrupt every max trend;
- a variable with a condition that makes it a threshold count (an event-threshold variable) follows its aggregation: `sum` → yes.

The service decides from the version, and the database guard checks the same rule (section 2).

## 5. The three methods

| Method | How | Basis kept | Label |
|---|---|---|---|
| **Proportional** (own average, scaled by minutes) | The athlete's own per-minute rate of that variable over their last N measured whole-session results of the same session category (proposed N = 5, at least 3, within 90 days), × the minutes the coach enters (default: the session's duration) | the minutes, N, the rate, the sessions' dates | "Estimate · own average × 75 min" |
| **Copy from an athlete** (the weakest; a warning) | Another athlete's measured value in the same session, the coach chooses whom | the source athlete (shown by name to whoever may see both) | "Estimate · copied from Bea Example" |
| **Team average** | The mean of the measured whole-session values of this session's athletes (at least 3 athletes) | the athlete count | "Estimate · team average (14 athletes)" |

- All three use only measured values (never another estimate), of the same variable and version unit.
- The coach sees the proposed numbers before saving, chooses the method per athlete (one method for all of that athlete's
  variables), and saves; a method that cannot run (too few sessions, too few athletes) is shown disabled with the reason.
- The **position average** (the owner's second source) waits for its prerequisite: positions are not assigned to athletes
  (`public.sport_positions` has 0 rows and no athlete or membership table has a position; the *Rukovodilac*'s read of
  2026-11-09, not re-read here).
- Author and time on every value; changing an estimate is a new estimate occasion that supersedes the old one (history kept).

## 6. Who

Proposed: whoever may make the athlete's roster decision for that activity (the team's coach, the club admin, a platform admin
— the J20-C audience), in the team's workspace. Owner decision 6 below.

## 7. Where an estimate shows, and how it is excluded

- The activity's results and the session review: the label beside every estimated value, in another style from measured values.
- **Dashboards and analyses** read `entry_method` and `is_derived`. A series must be able to exclude estimates; today
  `all_with_conflicts` includes them and only `derived` selects them. This needs a dashboard change (a `source_policy` or a
  separate "include estimates" switch) in `trainingLoadDashboard*.js` / `training-load-analysis-*`, which this executor does not
  touch without the *Rukovodilac*'s and the owner's word: **open question 4**. Until it is built, estimates are either kept out
  of dashboards by default (the safe choice) or included and marked.
- Every other reader of metric values (the activity drawer through `canonical_activity_results()`, and any load calculation
  outside dashboards) must be listed in the contract with its rule; this discovery did not trace them all (to do in 6b-0).

## 8. Split into pull requests

| PR | What | Mark |
|---|---|---|
| 6b-0 | The contract from this discovery, with the owner's answers | ★ (docs) |
| 6b-A | Migration: `entry_method` `estimate`; `metric_value_estimates` with its guards and actor rules; the undo's extension (md5 gate on the v57/v60 bodies; estimates listed, removed, counted in the log); preflight, post-check, rollback | ★★ (migration, the undo, an irreversible operation) |
| 6b-B | The service and routes: the proposal (read only: the three methods' numbers and why one cannot run), the save (request key, bounded COMMIT, the participant and its link, one occasion per athlete), the writer's rule that a measured value supersedes an estimate | ★★ (transactions, concurrency with the import and the undo, rights) |
| 6b-C | Frontend: the third action on a *No device data* row (J20-A2 left room for it) and in the Roster tab; the label everywhere the value shows | ★ (code, ux, mobile) |
| 6b-D | Dashboards and analyses: exclude or mark estimates | ★ or ★★, after the owner's answer to question 4 |
| later | Positions (a catalog with rows and an athlete's position), then the position average | own contract |

## 9. Decisions for the owner

1. The storage: a new capture kind `estimate` with a provenance table (recommended).
2. When: after the import only in the first version (recommended), or also in the review before the import.
3. The proportional method's history: the last 5 measured sessions of the same category within 90 days, at least 3.
4. Dashboards: estimates excluded by default until a dashboard switch exists (recommended), or included with a mark.
5. The undo: estimates are removed with the session, listed and logged, and never block (recommended, as O1).
6. Who may estimate: the J20-C audience (recommended), or administrators only.
