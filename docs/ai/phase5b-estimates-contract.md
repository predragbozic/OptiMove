# Phase 5b (6b): estimated values — contract (6b-0)

Status: **proposed**, for the *Rukovodilac*'s GO. It follows the discovery `docs/ai/phase5b-estimates-discovery.md` (branch
`docs/phase5b-estimates-discovery` at `51d1c91`). The owner approved that discovery's recommendations on 2026-11-12 (relayed by
the *Rukovodilac*). This contract fixes the exact shape of each pull request. No code is written before the GO.

Last verified against commit: `576e157` (main after #495). `M/` is `migrations_v2/`.

## 1. The owner's answers (2026-11-12, "as recommended")

| # | Question | Answer |
|---|---|---|
| 1 | Storage | A new capture kind `estimate`, with a provenance table |
| 2 | When | After the import only, never in the preview or the import itself |
| 3 | The proportional method's history | The last 5 measured whole-session results of the same session category, within 90 days, at least 3 |
| 4 | Dashboards | Estimates are left out by default |
| 5 | The undo | Estimates are removed with the session, listed, and logged; they never block |
| 6 | Who | The J20-C audience: whoever may make that athlete's roster decision for the activity |

The *Rukovodilac*'s order adds: always labelled as an estimate and never mixed with measured values; sum, avg and max rules per
variable as in the discovery (section 4); a runbook with a preflight, a post-check and a rehearsed rollback; the Independent
reviewer and the *Rukovodilac*'s gate; no migration runs without the owner's order.

## 2. Facts this contract relies on (read at `576e157`)

- **The capture kind.** `metric_measurement_occasions.entry_method` is `check (entry_method in ('manual', 'api_import',
  'csv_import'))` (M/v13:28).
  - The column is frozen after insert (`protect_occasion_identity_always`, v13:138-154).
  - An occasion with neither a source identity nor a batch skips the owner-scope check (v13:192).
- **Values.** `metric_values` is `unique (occasion_id, metric_definition_id)`, append-only (`metric_values_immutable`), with
  `is_derived` and `computed_by_ref` (v13:274-332). v3's constraints tie `computed_by_ref` to `derived_rollup`.
- **The participant.** `metric_event_participants` is `unique (event_id, athlete_id)` (M/v12:135-148), and no INSERT trigger
  requires a source identity. An athlete left out of an import or without a GPEXE record has no participant; an estimate adds
  one and a confirmed link to the activity's participant (`training.activity_participant_metric_participant_links`, M/
  training_activity_v2:399-449). That link needs a confirmed `activity_metric_event_links` row to the same activity. The link's
  insert records a roster change (v26:355-358).
- **The reader of activity facts.** `training.canonical_activity_results()` does not filter on `entry_method` or `is_derived`. It
  passes both out in `detail` (`entryMethod`, `isDerived`; M/training_activity_v4:764-783).
- **The undo.** v60's `undo_imported_session` deletes every occasion of every participant of the event (`v_occ`, v60:428), with
  their values (789) and their occasions (794).
  - It refuses only `manual` occasions (`manual_occasion`, v60:429, 681-682). An `estimate` occasion today would be deleted
    without being counted.
  - Its log row is `import_deletion_log`, with `removed_counts` and `roster_work_removed` (v60:306, 850-854).
  - Its bodies are replaced under an md5 gate (v60:54-80); a new body is the same pattern.
- **Dashboards.** `resolveFactsToRows` (`backend/src/trainingLoadDashboardQuery.js:337-389`): the default policy
  `all_with_conflicts` applies no source filter. An estimate would therefore be included, and with another value on the same
  athlete, grain and unit it would become a conflict. The `source_policy` CHECK is at M/v16:365-366.
- **Other readers of `entry_method`.**
  - `activityRoster.js:72` treats only `api_import` and `csv_import` as measured, so an estimate is not device data and the athlete
    stays *Participated · no device data*. That is correct and unchanged.
  - `calendarQuery.js:302` does the same.
  - `gpexeImportWriter.js:550` and `gpexeImportPreview.js:525-535` special-case `manual` (a manual correction is kept, and a resend
    is `stale_resend_ignored`).
  - `trainingLoadMetricsMeasurements.js:853` does the same for the older manual API.

## 3. Rules

1. **An estimate is its own kind.**
   - **The occasion.** `entry_method = 'estimate'`, whole-session level only (no segment); `recorded_by_user_id` is the author.
     There is no source identity and no batch.
   - **Its values.** `is_derived = true`, `aggregation_role = 'standalone'`, `coverage = 'not_applicable'`, `computed_by_ref` null.
     v3's constraints stay as they are.
   - **The provenance.** Each estimated value has exactly one row in `training_load.metric_value_estimates`. Nothing else may write
     an `estimate` occasion or value (database guard).
2. **Methods** (the discovery's section 5): `proportional`, `copy_athlete`, `team_average`. The `position_average` method waits
   for positions.
   - Only measured values are a basis (`entry_method in ('api_import', 'csv_import')`, effective occasions), never another
     estimate. The values must be of the same variable and version unit.
3. **Which variables** (the discovery's section 4), from the variable's current version:
   - numeric only;
   - `sum`: every method;
   - `avg`: `copy_athlete` and `team_average`;
   - `max`, `last`, `none`: never.

   The database guard checks the same rule.
4. **When.** Only on an activity that came from an import and is not undone, for an athlete of the activity whose roster state is
   *Participated · no device data*, or who has no measured whole-session value. Never in the preview, the approval or the import
   transaction.
5. **Who.** The J20-C audience: the activity's roster decider, through `training.lock_activity_decider`'s right, in the team's
   workspace. Everyone else gets the identical 404.
6. **A measured value later.** A measured whole-session value for the same athlete and variable supersedes the estimate occasion,
   through the existing supersede chain. The import preview lists it under *changes to imported results* as "an estimate is
   replaced by a measured value". An estimate never blocks a measured value, and it is never kept the way `manual` is.
7. **A new estimate replaces the old one.** It is a new `estimate` occasion that supersedes the previous one; the history is kept.
8. **The undo** counts the `estimate` occasions and values of the event in its scope (`estimateOccasionCount`,
   `estimateValueCount`). It deletes them with their provenance rows and records `estimates_removed` in `removed_counts`. They
   never block. The preview lists them: "N estimated values of M athletes will be removed".
9. **Dashboards** leave estimates out by default (section 5, PR 6b-D).
10. **Every place that shows a value** shows an estimate with its label: method, basis, author and date. A coach never sees an
    estimate unlabelled.

## 4. The pull requests

| PR | Content | Mark |
|---|---|---|
| **6b-0** | This contract | ★ (docs) |
| **6b-A** | Migration **v63** (the next free slot after #493's v62, prefix after `202611111200`) | ★★ |
| **6b-B** | The service and routes | ★★ |
| **6b-C** | Frontend: the action on a *No device data* row of the session review and of the Roster tab; the label wherever an estimated value shows | ★ (code, ux, mobile) |
| **6b-D** | Dashboards | Needs the answer in section 5 |

**6b-A, migration v63.**
- The `entry_method` CHECK widened to `estimate`.
- `training_load.metric_value_estimates`: `metric_value_id` unique, the method, the basis jsonb in a closed shape, the author, the
  time, an optional note.
- Guards:
  - the occasion must be `estimate`;
  - a value of an `estimate` occasion needs its provenance row by COMMIT (a deferred constraint trigger, the v35 pattern);
  - the method is allowed by the variable's aggregation;
  - the author is the v35-style actor in the transaction;
  - the table is append-only, except a DELETE under the session undo marker.
- The undo's two bodies replaced under an md5 gate on v60's bodies: `session_undo_scope` and `undo_imported_session`.
- A preflight, a post-check, a rollback (it refuses once an estimate exists), and a rehearsal on disposable databases.

**6b-B, the service and routes.**
- The proposal: a read giving the three methods' numbers and why one cannot run.
- The save:
  - a request key, with a request record;
  - a bounded COMMIT;
  - the participant and its confirmed link when missing;
  - one occasion per athlete.
- The writer's and the preview's rule that a measured value supersedes an estimate (rule 6).
- `activityRoster` and `calendarQuery` stay as they are: an estimate is not measured.

**6b-D, dashboards.** It needs the answer in section 5. It depends on rule 1: an estimate is always `entry_method = 'estimate'`
and `is_derived = true`.

## 5. One question before 6b-D (not blocking 6b-A to 6b-C)

Leaving estimates out by default means a change in `backend/src/trainingLoadDashboardQuery.js` (`resolveFactsToRows`, the
default `all_with_conflicts`) and a policy word in the `source_policy` CHECK (M/v16:365) or a separate switch, with its frontend
in `frontend/training-load-analysis-*`. The executor does not touch these files without the *Rukovodilac*'s word, and another
executor's D pull requests are working in them.

Until 6b-D, an estimate would appear in dashboards as an ordinary value, or as a conflict next to a measured one. **Proposal:**
6b-B does not let anyone save an estimate until 6b-D is merged; the route stays behind a server flag (`ESTIMATES_ENABLED`,
default off). Question for the *Rukovodilac*: who builds 6b-D, and in which order with the D pull requests?

## 6. Not in this contract

- Positions and the position average.
- Estimates at the drill level.
- An estimate before the import, in the review (it would need the approval's window and key).
- Exporting estimates.
