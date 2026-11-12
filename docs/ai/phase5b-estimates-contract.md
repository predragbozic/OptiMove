# Phase 5b (6b): estimated values — contract (6b-0)

Status: **accepted** with the *Rukovodilac*'s three corrections (GO of 2026-11-12, M1–M3 and two LOW, folded in below). It follows the discovery `docs/ai/phase5b-estimates-discovery.md` (branch
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
     There is no source identity and no batch. **One estimate occasion holds one value**, of one variable for one athlete, so an
     estimate is superseded per (athlete, variable) (rule 6).
   - **Its values (M1, option (a)).** `is_derived = false`, `aggregation_role = 'standalone'`, `coverage = 'not_applicable'`,
     `computed_by_ref` null.
     - **Recognition.** An estimate is recognised only by its occasion's `entry_method = 'estimate'`. `is_derived` keeps its
       meaning (a value computed from other values), so the dashboards' `derived` policy never picks up an estimate.
     - **v3 allows the combination.** `computed_by_ref is null or aggregation_role = 'derived_rollup'` (M/training_activity_v3:158)
       holds with null. `aggregation_role <> 'derived_rollup' or (…)` (v3:160) holds with standalone. `(standalone and
       not_applicable) or …` (v3:162-165) holds.
     - **Proof.** A 6b-A test inserts exactly this value under the estimate guards.
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
4. **When (M2, per athlete and variable).** Only on an activity that came from an import and is not undone, for an athlete of the
   activity. An estimate is **never written for a variable that already has an effective measured whole-session value for that
   athlete** in the same metric event.
   - **"Effective measured"** means an occasion with `entry_method in ('api_import', 'csv_import')`, no segment,
     `superseded_by_occasion_id` null, `import_conflict_status` null, and (when it has a source identity) its identity's current
     occasion, carrying a value of that variable.
   - **The database holds it.** A BEFORE INSERT trigger on `metric_values` for a value of an `estimate` occasion refuses it
     (`23514`, `estimate_measured_exists`). It runs after the occasion's insert has locked the participant and the event
     (`lock_ancestors_before_occasion_insert`, v13:106-125).
   - **Never** in the preview, the approval or the import transaction.
5. **Who.** The J20-C audience: the activity's roster decider, through `training.lock_activity_decider`'s right, in the team's
   workspace. Everyone else gets the identical 404.
6. **A measured value later (M3).** The database does it, whoever writes the measured value, so the import writer needs no new
   write code.
   - **The mechanism.** An AFTER INSERT trigger on `metric_values` (`metric_values_supersede_estimate`) fires for a value of a
     measured whole-session occasion. It finds the effective estimate occasion of the same participant (the same event and
     athlete) holding a value of the same variable. It sets that occasion's `superseded_by_occasion_id` to the new measured
     occasion; the column is v13:45, and v13 freezes only identity and content, not the revision fields (v13:134-148).
   - **The reads follow without a change.** The new measured occasion's `supersedes_occasion_id` is left as the import's own chain
     sets it, and estimates are not chained the other way. Every reader of effective values already filters
     `superseded_by_occasion_id is null` (`canonical_activity_results`, v4:786; the dashboards' fact query; the occasion index,
     v13:272).
   - **Lock order.** Both sides take the same locks in the same order, so they serialize and never deadlock:
     1. the team's import lock (`lockTeamForImport`, the advisory key the import already holds; the estimate save takes it first,
        try-lock, `409 try_again`);
     2. the participant row `FOR UPDATE`, then the event `FOR UPDATE` (the occasion insert trigger);
     3. the estimate occasion's row (the supersede update).
   - **The preview.** The import's preview runs the real import in a rolled-back transaction, so the trigger fires there too. The
     preview counts the estimate occasions it superseded and lists them under *changes to imported results* as "an estimate is
     replaced by a measured value". It never blocks the import and is never kept the way `manual` is.
   - **Tests (6b-A and 6b-B, disposable databases, both orders):**
     - an estimate, then an import of a measured value for the same athlete and variable: the estimate is superseded, and
       `canonical_activity_results` shows the measured value only;
     - an import, then an estimate: refused, `estimate_measured_exists`;
     - an import holding the team lock while an estimate is saved: the save answers `try_again` (or waits and is then refused),
       and nothing is written twice;
     - two estimates of the same athlete and variable: the second supersedes the first through rule 7;
     - a measured value of another variable leaves the estimate in force.
7. **A new estimate replaces the old one.** It is a new `estimate` occasion that supersedes the previous one; the history is kept.
8. **The undo** counts the `estimate` occasions and values of the event in its scope (`estimateOccasionCount`,
   `estimateValueCount`). It deletes them with their provenance rows and records `estimates_removed` in `removed_counts`. They
   never block. The preview lists them: "N estimated values of M athletes will be removed".
9. **Dashboards** leave estimates out by default (section 5, PR 6b-D).
10. **Every place that shows a value** shows an estimate with its label: method, basis, author and date. A coach never sees an
    estimate unlabelled. The readers, and who labels each:
    - `training.canonical_activity_results()`, which passes `detail.entryMethod` (v4:764-783), feeds the Activities drawer's
      recorded metrics. 6b-C labels it.
    - The activity's Roster tab metric columns (`activityRoster.js`): an estimate is not measured (`MEASURED_METHODS`), so the row
      keeps its state. 6b-C shows the estimated value with its label beside it.
    - The import's session review: an estimate never appears among import values. Only the replacement line of rule 6 shows,
      from 6b-B, and 6b-C words it.
    - Dashboards and analyses: left out under every existing policy, shown only under the new policy (6b-D, section 5).
    - `calendarQuery.js:302` reads only measured methods; it is unchanged and shows no estimate.

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
- The two triggers on `metric_values`: the M2 refusal and the M3 supersede (rules 4 and 6).
- The `source_policy` CHECKs widened to `estimate` (section 5).
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

## 5. Dashboards (6b-D): the *Rukovodilac*'s decision of 2026-11-12

- **The flag.** 6b-B keeps the save behind a server flag `ESTIMATES_ENABLED`, default off. The flag is turned on only after 6b-D
  is merged and deployed, by a separate owner order.
- **6b-D is built by this executor,** as a small separate pull request right after 6b-C.
  - **Backend:** in `resolveFactsToRows`, an estimate (`entryMethod === 'estimate'`) is left out under every existing policy,
    `all_with_conflicts` and `derived` included, and shown only under the new policy word **`estimate`**.
  - **The CHECK.** v16's `source_policy` CHECK (M/v16:365-366, and its twins at 393-394 and 418-419, and v17's) is widened to
    `estimate` **inside v63**, so 6b-D needs no migration of its own.
  - **Frontend:** only the option's label.
- Other executors' D pull requests merge main after it, whatever their order.

## 6. Not in this contract

- Positions and the position average.
- Estimates at the drill level.
- An estimate before the import, in the review (it would need the approval's window and key).
- Exporting estimates: an estimate goes to no export, file or third party; it lives only in OptiMove's own views.
