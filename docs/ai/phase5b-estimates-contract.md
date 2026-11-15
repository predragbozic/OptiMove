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
   activity. An estimate is **never written for a variable that already has an effective real whole-session value for that
   athlete** in the same metric event.
   - **"Effective real"** means an occasion with `entry_method in ('manual', 'api_import', 'csv_import')`, no segment,
     `superseded_by_occasion_id` null, `import_conflict_status` null, and (when it has a source identity) its identity's current
     occasion, carrying a value of that variable.
   - **A coach's manual value counts** (the *Rukovodilac*'s decision of 2026-11-12, Q2): the owner's rule is that an estimate is
     never mixed with real values, and a value a coach entered is real. So a `manual` whole-session value refuses an estimate
     here, and a later one supersedes it in rule 6, exactly like an imported one. `activityRoster` and `calendarQuery` keep their
     own meaning of "measured" (device data), and only measured values are a basis for a method (rule 2).
   - **The database holds it.** A BEFORE INSERT trigger on `metric_values` for a value of an `estimate` occasion refuses it
     (`23514`, `estimate_measured_exists`). It runs after the occasion's insert has locked the participant and the event
     (`lock_ancestors_before_occasion_insert`, v13:106-125).
   - **Never** in the preview, the approval or the import transaction.
5. **Who.** The J20-C audience: the activity's roster decider, through `training.lock_activity_decider`'s right, in the team's
   workspace. Everyone else gets the identical 404.
6. **A real value later (M3).** The database does it, whoever writes the real value (manual or imported), so the import writer needs no new
   write code.
   - **The mechanism.** An AFTER INSERT trigger on `metric_values` (`metric_values_supersede_estimate`) fires for a value of a
     real (`manual`, `api_import` or `csv_import`) whole-session occasion. It finds the effective estimate occasion of the same participant (the same event and
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
      recorded metrics. 6b-C1 labels it (section 8).
    - The activity's Roster tab metric columns (`activityRoster.js`): an estimate is not measured (`MEASURED_METHODS`), so the row
      keeps its state. 6b-C1 shows the estimated value with its label beside it (section 8).
    - The import's session review: an estimate never appears among import values. Only the replacement line of rule 6 shows,
      from 6b-B, and 6b-C2 words it.
    - Dashboards and analyses: left out under every existing policy, shown only under the new policy (6b-D, section 5).
    - `calendarQuery.js:302` reads only measured methods; it is unchanged and shows no estimate.

## 4. The pull requests

| PR | Content | Mark |
|---|---|---|
| **6b-0** | This contract | ★ (docs) |
| **6b-A** | Migration **v63** (the next free slot after #493's v62, prefix after `202611111200`) | ★★ |
| **6b-B** | The service and routes | ★★ |
| **6b-C1** | The label's provenance on the Roster and Activities reads (backend, no migration); the Roster tab's action on a *Participated · no device data* row; the label on the Roster tab and in the Activities drawer (section 8) | ★★ (trigger 2: names on existing reads) |
| **6b-C2** | After the design executor's P4a (#534): the action on the imported session's review and the wording of its replacement line | ★ (code, ux, mobile) |
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
  - one occasion per variable (rule 1: an estimate occasion holds one value; section 7).
- The writer's and the preview's rule that a measured value supersedes an estimate (rule 6).
- `activityRoster` and `calendarQuery` stay as they are: an estimate is not measured.

**6b-D, dashboards.** It needs the answer in section 5. It depends on rule 1: an estimate is always `entry_method = 'estimate'`
and `is_derived = false` (M1).

## 5. Dashboards (6b-D): the *Rukovodilac*'s decision of 2026-11-12

- **The flag.** 6b-B keeps the save behind a server flag `ESTIMATES_ENABLED`, default off. The flag is turned on only after 6b-D
  is merged and deployed, by a separate owner order.
- **6b-D is built by this executor,** as a small separate pull request right after 6b-C1.
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

## 7. 6b-B as built

The *Rukovodilac*'s GO of 2026-11-12 answered the four open questions:
- **Q1 (a):** the request key lives on the provenance rows (migration v64), not in a request table;
- **Q2 (a):** the estimate participant's time zone may be re-snapshot by a later import, under a database condition;
- **Q3, Q4:** confirmed as proposed.

Section 4's line "one occasion per athlete" reads **one occasion per variable**: rule 1 holds one value per estimate occasion, so
a save writes one occasion for each variable it estimates.

**Migration v64** (`migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql`; runbook
`docs/runbooks/metric-value-estimates-v64.md`):
- `metric_value_estimates.request_key` and `request_hash`, both `NOT NULL`, with an index on `(estimated_by_user_id,
  request_key)`. The provenance guard refuses a second hash for an (author, key), under a transaction-scoped advisory lock of
  that (author, key).
- v12's participant guard allows a change of `athlete_timezone_snapshot` alone, and only while every occasion of the participant
  is an estimate with no source identity.
- v1's activity participant guard lets the linked `training.activity_participants` row follow, in the same transaction: its zone
  and its day, to exactly what `materialize_activity_group_from_metric_event` computes, under the same condition. Both layers
  then equal a direct import (the *Nezavisni revizor*'s M1, the *Rukovodilac*'s fix (b)).

**The routes** (`backend/src/metricEstimateService.js`, `backend/src/routes/trainingActivity.js`). Both are behind
`ESTIMATES_ENABLED` (default off); off, both are the router's identical 404.

- `GET /api/training-activity/:activityId/estimates/proposal?athleteId=…[&minutes=…][&sourceAthleteId=…]`
  - **Audience:** the roster read's (`resolveRosterTarget`: the team's coach, the club's admin, a platform admin, in the right
    workspace); everyone else gets the identical 404.
  - **The read:** no lock, nothing written, one read-only transaction bounded by a 5 s statement timeout (`503 try_again` past
    it).
  - **The answer:**
    - the session's variables, each `estimable` or with its reason (`not_estimable` for a non-numeric or `max` / `last` / `none`
      variable, `measured_exists` for a variable with the athlete's own real value);
    - the three methods' numbers per variable, or why one cannot run (`too_few_athletes`, `too_few_sessions`,
      `minutes_required`, `duration_not_available`, `method_not_for_variable`, `source_has_no_value`, and `invalid_history` for
      a negative rate from a source's negative values);
    - the default minutes (the median of the other athletes' measured durations) and the minutes used;
    - the copy sources: roster athletes with a measured value of an estimable variable.
- `POST /api/training-activity/:activityId/estimates` `{ requestKey, athleteId, method, minutes?, sourceAthleteId?, note? }`
  - **Validation:**
    - `minutes` belongs to `proportional` only (above 0 and at most 600 after rounding to 2 decimals; default: the median as
      above);
    - `sourceAthleteId` belongs to `copy_athlete` only and is never the athlete;
    - `note` is one trimmed line of at most 500 visible characters.
  - **One transaction, in this lock order:**
    1. `training.lock_activity_decider` (`403 not_a_team_coach`);
    2. the team's import lock, try-lock (`409 try_again`);
    3. the alias set;
    4. the (author, request key) advisory lock (v64's guard takes the same one), then the replay;
    5. the checks under the locks;
    6. the participant in the event's zone and its confirmed activity link
       (`training.materialize_activity_group_from_metric_event`);
    7. per variable: the occasion, its value and its provenance row.
  - **The COMMIT:** the deferred checks are made immediate before the COMMIT, and the COMMIT is bounded (15 s). An unknown
    outcome is looked up by the key on a new connection (5 s): `201` with `verifiedAfterCommitError`, or `503 outcome_unknown`.
  - **The answer** is read back from the saved rows. The same key and body replays it (`200`); the same key with another body
    (activity, athlete, method, minutes, source athlete, note) is `409 request_key_reused`.
  - **Refusals write nothing,** so their key stays free:
    - `athlete_not_on_roster`;
    - `estimate_not_available`: the activity has no single imported session event;
    - `copy_source_not_usable`: the source is not on the roster, or has no measured value;
    - `minutes_required`;
    - `nothing_to_estimate`, with the reasons;
    - `measured_exists`: v63's M2 refusal of a real value written meanwhile by a path that does not take the team lock;
    - `activity_superseded`;
    - `roster_not_applicable`.
- **The bases** (rule 2):
  - measured values only (`api_import`, `csv_import`, effective, whole session) in the version's unit;
  - `team_average` needs at least 3 athletes of the session;
  - `copy_athlete` copies a roster athlete's value of the same session;
  - `proportional`, for `sum` variables only: the athlete's own rate per minute over the last 5 measured sessions of the same
    team and activity type within 90 days before this session (at least 3), times the minutes. A session's minutes are the
    athlete's measured value of the system variable `duration`, in `min`.
  - Values are rounded to 3 decimals, the rate to 6.

**The import** (rule 6):
- **The writer:** `ensureParticipants` re-snapshots an estimate participant's zone to the athlete's own, and its linked activity
  participant's zone and day (the database's v64 conditions); any other zone change stays `participant_timezone_changed`.
- **A Complete roster (I2, intended).** An estimate for an athlete without a metric participant adds the participant's confirmed
  activity link, which is a roster change: a Complete roster turns to `needs_review` (the roster changed). The session undo then
  lists that work and asks for `roster_work_needs_confirmation`, as for any later roster work.
- **The preview:** the preview lists the estimates the import would replace in `supersededEstimates` (`athleteId`,
  `metricDefinitionId`). The field is present only when there are some, so an existing preview hash is unchanged. It never
  blocks and is never part of `acceptChanges`. An estimate saved after a check changes the approval's recomputed preview, so the
  approval answers `preview_changed` and the coach reviews again.

**Tests:** `backend/tests/metric-estimates-6b-b.test.mjs`, on disposable databases with the real import through the routes:
- the flag;
- the audience;
- the proposal;
- the save with its rows and link;
- the request key, and one key sent to two teams' sessions at once (`request_key_reused`, never a second hash);
- the refusals;
- rule 7;
- the try-lock;
- the COMMIT outcomes;
- Q2 through a real re-import near midnight UTC (both layers equal a direct import, the day moves with the zone; the supersede;
  the preview's list; the frozen zone in both layers with a manual value);
- the undo after an estimate saved through the route (not blocked, `estimates_removed`), and on a Complete roster (I2);
- v64's participant guard, and its (author, key) lock between two transactions on two events;
- the participant in the event's zone when the athlete's own zone differs, and in the v62 team zone for a mixed session;
- the migration's preflight, post-check and rehearsed rollback.

**Not in 6b-B:** the screens (6b-C) and the dashboards (6b-D).

## 8. 6b-C1 as built

The *Rukovodilac*'s scope decision of 2026-11-15: rule 10's label needs the provenance, which neither read gave, so 6b-C is
not frontend-only. It is split: C1 (this section) and C2 (the imported session's review, after P4a #534, whose files it shares).

**The reads** (`backend/src/estimateLabels.js`, used by `activityRoster.js` and `trainingActivityResults.js`; joined in JS from
`metric_value_estimates` by the occasion; no change to `canonical_activity_results`, no migration):
- Each value of an `estimate` occasion carries `estimate`: `method`, `estimatedBy` (the author's name), `estimatedAt`, and by
  method `minutes` and `sessionCount` (proportional), `athleteCount` (team average), `recordedMinutes` and `targetMinutes`
  (scale recording), `sourceAthleteName` (copy). Never a user id, an athlete id, the rate or the raw basis.
- **The copy source's name** is given only when the same answer already names that athlete: on the Roster read, an athlete of
  the roster or of *recorded outside the roster*; on the Activities read, an athlete of the facts the caller may see. A source who
  left the team after the session is named as the roster names them for that day.
- **An athlete reading their own results** (the Activities read, athlete-self) gets exactly `method`, `estimatedBy` and
  `estimatedAt` for every method: no basis number (a team average's athlete count is team information) and never the copy
  source. The screen then reads in plain words ("Estimate · team average · …", "own average", "scaled from a shorter
  recording", "copied from another athlete"). The Independent's M1 on #537; tests 17 (6b-B suite) and 3 (MT-D suite).
- A replaced estimate has no label: the reads show only effective values (rule 7).
- **Known, accepted (the security review of C1):** a copied value equals a teammate's measured value of the same session. An
  athlete reading their own results sees the number as their estimate, labelled "copied from another athlete", never whose
  it is. This follows from the coach's choice of the copy method (6b-B) and is not changed here.
- Every other value, and an answer with no estimate, is exactly as before. The Roster read's `viewer` carries
  `estimates: true` only while `ESTIMATES_ENABLED` is on.
- **Recorded, no change (the Independent on #537):**
  - the author is named whether or not their account is still active;
  - an author cannot be deleted while an estimate names them: `metric_value_estimates.estimated_by_user_id` references
    `public.users` with `on delete restrict` (v63), so the inner join that reads the name never drops a label;
  - the author may be a platform admin, whose name then reaches the team's coaches and the athlete, as any author's does;
  - the labels are not gated by the flag: an estimate saved while `ESTIMATES_ENABLED` was on keeps its label after it is
    turned off (only the action and `viewer.estimates` follow the flag).

**The Roster tab** (`frontend/activity-estimate.js` with `activity-roster-*.js`):
- **The action:** "Estimate values…" ("Change the estimate…" once one exists), only on a row whose state is *Participated · no
  device data*, for a viewer who may decide, while the server says the save is on. Not on *Unknown*: a state first, then the
  estimate.
- **The panel:**
  - the proposal (one read), with the four methods, their numbers, and an unavailable method disabled with its reason;
  - the minutes for the own average (Update reads the numbers again), and the athlete to copy from;
  - an optional note.
- **The save:**
  - one request key per attempt; a refusal (a coded 4xx, or `503 try_again`) writes nothing and frees the key;
  - a lost answer is *Result not confirmed*: Check result sends the same command and key, the leave check asks, and Escape and
    Cancel keep it;
  - after a save the roster is read again.
- **The label:** an estimated value is in italics with an *est.* mark, its label in the cell's title, and the full label in the
  row's Details.

**The Activities drawer** (`training-load-calendar-view.js`): the results table's cell, the athlete drawer's value and the
conflict panel show *est.* and the label; the sources list shows the label instead of "Direct".

**Tests:**
- backend `metric-estimates-6b-b.test.mjs` test 17: the labels on both reads for three methods, the closed fields, no id, a
  measured value unchanged, the athlete-self read, a source who left, the replaced estimate, the flag, and the identical 404;
- frontend `activity-estimate.actions.test.mjs`, and `training-load-calendar.actions.test.mjs`'s 6b-C1 test.

## 9. 6b-C2 as built

Frontend only, no backend change, no migration (★: code, ux, mobile). The *Rukovodilac*'s decision of 2026-11-15: option (A),
one write path.

- **The replacement line (rule 6).** The session review shows the estimates an import replaces with measured values, from
  6b-B's `preview.supersededEstimates` (athlete and variable ids only). The section is headed "Estimates replaced by measured
  values (N)", or "An estimate is replaced by a measured value" for one. It has one line per athlete: the athlete's name as
  the review names it, and the variables as the preview's own values label them (a club variable of another club stays
  "Club variable"; a variable the preview does not label reads "Variable"). It says nothing needs to be accepted: no
  checkbox, it never blocks, and it adds nothing to the approval.
  - **Wording by status:** before the import it says the measured values replace the estimates when the coach imports;
    after it, that they replaced them in this import.
  - **An undone import** shows no line.
- **The action.** An imported session's review (not an undone one, and not one undone or being undone in the same review)
  reads the activity's roster (GET, the Roster tab's own
  read) when it opens, and again after the import's attendance states are saved.
  - **The list:** while the server says `viewer.estimates`, the review lists the athletes in state *Participated · no
    device data* under "Took part without device data", each with **Estimate values in Activities**. An athlete who
    already has an estimate gets **Change the estimate in Activities** and an "Estimated" mark. A failed read shows no
    link. Only the newest read counts.
  - **The link:** it never acts while an approval, its check or an undo is in flight. Every question comes before the
    review closes, so a No to any of them keeps the review as it is:
    - while the import's attendance states are still being saved or not confirmed;
    - Activities' own question when another session's roster has a write in flight or not confirmed.

    Then it closes the review the way its Close does.
  - **Where it goes:** the session in Activities (the existing results-to-calendar hand-off) with its Roster tab and that
    athlete's estimate panel (6b-C1) open. The review saves no estimate itself and keeps no second roster state.
- **Code:** `frontend/gpexe-estimate-link.js`, `gpexe-import-view.js` (`renderReplacedEstimatesHtml`), the action in
  `training-load-actions.js` (`training-load-estimate-in-activities`), and the reads' hooks in `gpexe-import-data.js` and
  `gpexe-import-states-data.js`. Tests: `frontend/tests/gpexe-estimates-6b-c2.actions.test.mjs`.
