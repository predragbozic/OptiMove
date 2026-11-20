# OptiMove decides the session type, not the source; manual values on the roster (plan)

Status: **Proposed** (2026-11-20, second head). This is a plan only: no code and no migration file until the owner
accepts it. Migration numbers come from the *Rukovodilac*.
Last verified against commit: `d3b5f50b` (`origin/main`, merge of PR #693).
Level: risky. It changes what an import writes and what a coach may write on a session, it needs migrations, and it
touches the approval's transaction. So it goes through the *Nezavisni revizor* and the *Rukovodilac*'s full gate
(triggers 1, 2, 3 and 4 of `CLAUDE.md`).

## 0. The owner's words (relayed by the *Rukovodilac*, 2026-11-20)

- Types: "Full training, game, friendly game, exercise, compensation, RTP".
- "A friendly is not added to the average of normal matches, but matches may count toward friendlies; if that is a
  problem, only sessions with the same name."
- "cele sesije su to, samo njihov naziv, inače mi možemo dodati i neki drugi naziv kasnije, treba imati to negde u tag
  i presets-u. Mogu i posle uvoza da menjam. Ako je u generalnom kalendaru podešeno može da se povuče ili odmah po
  uvozu da izaberem koji tip treninga. S tim što u rosteru ili negde drugo mogu i da promenim tip sesije ili čak nekom
  igraču ne svima, znači mogu i po igraču da promenim. Na primer uvezao sam ih sve ali neki igrač nije bio u ful
  treningu već je radio nešto sa strane... pa njemu svakako ide druga vrsta sesije."
- On manual values (relayed): "na ekranu danas postoji samo procena". The owner also wants:
  - **manual entry**: an athlete without a device, whose numbers the coach types in;
  - **manual correction** of a measured value: the measured value is not deleted; the correction counts and is marked
    as manual, with who and when.
- On re-import, word for word: "kada ponovo uvozim sesiju dobijam pitanje da li želim da ostanu moji podaci koji su
  upisani".
- Context: the owner plans to delete all 15 imported sessions through the app and import them again. So no backfill of
  mapped or calculated values is planned.

## 1. What the code does today (checked on `d3b5f50b`)

| Fact | Where |
|---|---|
| The activity's type is a row of `training.activity_types` (`key` PK, `label`, `is_active`). It is global, with no owner, and seeded with `training_session`, `match`, `testing_session`, `recovery_session`. Its own comment: a new type is an INSERT, not a schema change. No route writes it. | `migrations_v2/202609071000_training_activity_v1_core_tables.sql:39-49` |
| `training.activities.activity_type_key` references it and may be null. On a `confirmed` or `superseded` activity it changes only through `training.correct_confirmed_activity_fields(...)`, which locks the row and writes a before/after row to `training.activity_field_correction_log` (who, why). No route calls it. | same file, `:89`, `:167-182`, `:258-290` |
| `training.activity_participants` (one row per athlete and activity) has no type column. | same file, `:305-334` |
| The GPEXE mapper turns the category into the type with one pair, `FULL TRAINING` -> `training_session`. Any other category throws `unsupported_category`, which blocks the session at the check. | `backend/src/gpexeImportMapper.js:49`, `:368-369`; `backend/src/gpexeImportReasons.js:63` |
| The preview's session summary carries the source `categoryName`; the preview hash covers the summary. | `backend/src/gpexeImportPreview.js:268-280`, `:354` |
| An import never links a calendar event; `calendar.event_activity_links` rows are written by hand (K2a-1b, K5-3). | `backend/src/calendarEventService.js:1794` |
| Calendar event types are per club, with a write-once `kind` (`training`, `match`, `travel`, `meeting`, `day_off`, `camp`, `test`). | `migrations_v2/202610311000_calendar_v49_events.sql:98-133`, `:864-871` |
| Settings → *Tags & Presets* edits the builder's taxonomy (`library.node_presets`, template tags, `api/taxonomy/*`). It holds nothing about sessions. | `backend/src/routes/taxonomy.js`, `frontend/taxonomy-actions.js` |
| The estimate methods are `proportional` (Own average), `copy_athlete`, `team_average` and `scale_recording`. Own average reads only sessions whose activity has the same `activity_type_key` as the target's. D7 is not built. | `backend/src/metricEstimateService.js:34`, `:255-272` |
| Manual values already exist in the backend. An occasion's `entry_method` takes `manual`, `api_import`, `csv_import` and `estimate`. `POST /api/training-load/metrics/occasions/imported-correction` corrects an imported value manually: the imported occasion is kept as superseded, the identity's current occasion becomes the manual one. `POST …/occasions/:id/correct` corrects a manual one. Neither route has a screen on the roster. | `migrations_v2/202611121000_training_load_v63_metric_value_estimates.sql:90-91`; `backend/src/trainingLoadMetricsMeasurements.js:713-790`; `backend/src/routes/trainingLoadMetrics.js:558-590` |
| On a re-import the writer never replaces a manual current occasion. It records the source's value as `stale_resend_ignored`, flagged in `changesToImported`, and the review asks for *accept changes*. | `backend/src/gpexeImportWriter.js:58-66`, `:584-590` |
| The undo (v57, v76) refuses a session that holds any manual occasion (`manual_occasion`). | `migrations_v2/202611051000_training_load_v57_session_undo.sql:306`, `:550-551` |

## 2. The list of types: editable, one registry

**One registry.** The list stays `training.activity_types`. There is no parallel table, and the Tags & Presets tables
are the builder's and are not used for it. The screen lives in Settings → **Tags & Presets**, as a new section
*Session types*, because that is where the owner looks for it.

**Ownership.**
- **System types** are offered to every club. The platform admin edits them. Six are seeded, named as the owner named
  them:

  | Key | Label |
  |---|---|
  | `training_session` | Full training (renamed from "Training session") |
  | `match` | Game |
  | `friendly_match` | Friendly game |
  | `exercise_session` | Exercise |
  | `compensation_session` | Compensation |
  | `rtp_session` | RTP |

  `testing_session` and `recovery_session` stay for the activities that already use them. They are archived from the
  pickers unless the owner wants them.
- **Club types** are added by the club's admin, for that club's teams only.
- No team level: a coach chooses among the system types and the club's types. A coach of a team asks the club's admin
  for a new name, as with the calendar's event types.

**Identity is not the name.**
- The `key` is the identity. It is permanent, and every activity and override points at it. A club type's key is
  generated (`c_<8 hex>_<slug>`), so it never collides across clubs.
- *Rename* changes only `label`. Every session, past ones included, shows the new name at once, because nothing
  stores the label. Each rename writes a row to a new log table (who, when, old and new label).
- *Archive* sets `is_active = false` with who and when. The type is no longer offered for a new choice. Sessions that
  have it keep it and show "<label> (archived)". Own average and D7 keep treating it as its own type. It can be
  restored.
- No delete: the foreign keys forbid it once a type is in use.

**Routes** (under `/api/training-activity/session-types`; every write takes a `requestKey`):

| Route | Who | Notes |
|---|---|---|
| `GET /` | anyone who manages a team's sessions | the system types plus the caller's club's types, the archived ones flagged |
| `POST /` `{ label, ownerScope }` | system: an active platform admin in the platform workspace; club: the club's active admin in its own workspace | the key is generated by the server; the body never names a key, owner club, actor or basis |
| `POST /:key/rename` `{ label, expectedLabel }` | same as above, per the type's owner | `409 label_changed` when `expectedLabel` is stale; `409 label_taken` within the owner |
| `POST /:key/archive`, `/:key/restore` | same as above | an archived type stays on old sessions |

- **Audit.** One log table holds every add, rename, archive and restore: who, when, the action, and the old and new
  label. The v35 actor guard on the table and the log refuses a raw write.
- **Info hiding.** Everyone else gets the identical 404 (ADR-006).
- **Another club** never sees, chooses or learns of a club's own types. A session of club A that holds a club-A type
  stays readable to anyone who may read that session. The label is shown, and the type is not offered.

## 3. A type on two levels: the session and the athlete

- **The session's type** is `training.activities.activity_type_key`. It is the default for everyone in the session.
- **The athlete's exception** is a new row for one participant: "this athlete did <type> in this session". It is set
  from the Roster tab, on the athlete's row.
- **The effective type** of an athlete in a session is the athlete's live exception if one exists, otherwise the
  session's type. A function `training.effective_activity_type(participant_id)` is the one place that decides it.
- **Storage.** A new table holds the exceptions: `training.participant_activity_types`. Its columns are
  `participant_id`, `activity_type_key`, `set_by`, `set_at`, `reason`, and `ended_at` / `ended_by` for history. There
  is one live row per participant. Clearing an exception ends the row: nothing is deleted.
- **Merge and reparent** (the *Nezavisni revizor*'s LOW-2; ADR-001, trigger 3). An exception belongs to a participant
  row.
  - **Merge.** If participants are merged, the canonical participant keeps its own exception, if it has one, and the
    merged participant's exception ends.
  - **Reparent.** On a reparent to another activity, the exception ends, because the session around it changed.
  - **Where.** Both are written inside the existing functions, `training.merge_activity_participants`
    (`migrations_v2/202609071300_training_activity_v4_canonical_functions.sql:411`) and
    `training.reparent_activity_participant` (`:91`). They are replaced with `CREATE OR REPLACE` under an md5 gate on
    the bodies in force. The new lines run after the functions' existing locks:
    1. the activities `FOR UPDATE`, ascending (`:146-147`, `:458-460`);
    2. the participants `FOR UPDATE`, ascending (`:150`, `:466-467`);
    3. the exception rows, new and last.
  - **The exception write takes the same order:** the canonical activity, then the participant, then its exception
    row. It can therefore never close a cycle with a merge or a reparent.
  - **Test (ST-3):** a merge and an exception write on the same participant, run at once in both start orders. Both
    end with one consistent state and no `40P01`. A recorded-SQL-order test of the exception write.
  - The roster's "changed under you" mark lists an exception that a merge or a reparent ended.
- An exception equal to the session's type is refused (`409 same_as_session`), so the roster never shows a
  meaningless exception.

## 4. Where the session's type comes from

The order, first match wins:

1. **(a) The linked calendar event.**
   - If the activity is linked to a live event, the event type gives the suggestion. Once the calendar stream agrees,
     a nullable `calendar.event_types.activity_type_key` holds it. Until then the kind gives it: `training` →
     Full training, `match` → Game.
   - An import has no link at approval time, so this mostly applies afterwards: linking an event whose type differs
     offers *Change the session type to <X>?*. Nothing changes by itself.
2. **(b) The source's category.** The team's last choice for that category is the suggestion. A new table holds it:
   `training_load.source_session_types` (team, source, category → type; who, when). It is seeded with
   `FULL TRAINING` → `training_session` for each bound team. At approval the review reads
   "Type: Full training (from GPEXE "FULL TRAINING") · Change", and the coach confirms or changes it.
3. **(c) An unknown category no longer refuses the session.**
   - The mapper builds the plan with `activityTypeKey: null`, and the candidate is pending with the blocker
     `session_type_required` ("Choose the session type"). Approve stays off until a type is chosen.
   - The check-time preview runs without a type: the column may be null, and the preview is rolled back.
   - The approval refuses a null type with `409 session_type_required` and writes nothing.

**How a choice is bound (the hash contract; the *Nezavisni revizor*'s MEDIUM-1).** It reuses J20-B's subset pattern
(`approveCandidate` and `previewCandidateSubset`, `backend/src/gpexeImportService.js:2594-2777`, `:3098`); no new
mechanism is added.
- **The stored `preview_hash`** is the candidate's preview with the team's suggestion: the suggested type, or `null`
  for `session_type_required`, and no manual value replaced. The check computes it, as today. The client always sends
  it back as `previewHash`, and the approval compares it with the stored one first, exactly as today
  (`preview_changed` when they differ).
- **The coach's choice** is, together:
  - the excluded athletes;
  - `activityTypeKey`, when it differs from the suggestion;
  - `replaceManual` (section 8).

  It is bound by the J20-B subset route, widened to take the two new fields: `POST …/candidates/:id/subset-preview`
  `{ excludedAthleteIds?, activityTypeKey?, replaceManual? }`. That route answers the preview of the choice and its
  hash, still called `subsetHash` for compatibility and documented as "the hash of the preview with the coach's
  choices".
- **The approval** sends `previewHash`, the same choice fields, and `subsetHash`. Under its locks it recomputes the
  preview with the choice. It then compares:
  - against `subsetHash`, as J20-B does for exclusions (`409 subset_changed` with the fresh choice preview);
  - the chosen type, against the types offered to the team now, under the type row's `FOR SHARE` (below). A type
    archived, or no longer the club's, since the choice preview gives `409 session_type_not_offered`, and nothing is
    written.
- **No choice** (the suggestion as it stands, no exclusion, no replacement) needs no `subsetHash`, as today. A
  candidate with `session_type_required` always needs a choice, and is refused without one (`409
  session_type_required`).
- **Batch.**
  - Each item carries `{ candidateId, previewHash }`, and, when it has a choice, `activityTypeKey`, `replaceManual`
    and `subsetHash`.
  - The review dialog fetches the choice preview for each item that has a choice, before the batch is sent.
  - An item whose choice is stale stops with its own code, as the batch already does for `preview_changed`.
- **Hash effect of the deploy.** The stored preview's summary gains `activityTypeKey`, so every stored preview hash
  changes once. A candidate reviewed before the deploy needs *Update the review* once (the J20-A1 path, as after v62).
- **Tests and mutations (section 11):**
  - a choice different from the suggestion passes with its `subsetHash`;
  - a stale choice gives `409`: a type archived, or the club changed;
  - M: compare the chosen type's preview with the stored hash instead of the `subsetHash` → the "choice ≠ suggestion"
    test fails;
  - M: skip the offered-types check under the lock → the archived-type test fails.

After a confirmed approval, the team's suggestion for that category is updated in its own short transaction. That
write is best effort and never touches the import.

At approval only the session's type is chosen. Per-athlete exceptions are set on the roster afterwards, so the review
stays one decision per session.

## 5. Changing types after the import

- **The session.** `POST /api/training-activity/:activityId/type` `{ activityTypeKey, reason, requestKey }`.
  - It goes through `training.correct_confirmed_activity_fields` with every other field unchanged, so the row is
    locked and the correction log writes who, why and when.
  - Sending the same type is a `200` that changes nothing. A `requestKey` replay answers the saved outcome.
- **The athlete.** `PUT /api/training-activity/:activityId/roster/:athleteId/type` `{ activityTypeKey | null, reason,
  requestKey }` sets or ends the exception, with who, when and why.
- **Who.** Whoever manages the team's sessions: the team's coach in the team's workspace, the club's admin and a
  platform admin. That is the audience of roster decisions (`training.lock_activity_decider`). Everyone else gets the
  identical 404 (ADR-006). The lock order is users first (the rule of PR #346), then the role, then the canonical
  activity, then the participant. A superseded id answers `409 activity_superseded` with the current id.
- **Estimates already saved are never recalculated silently.**
  - An estimate whose athlete's effective type changed after it was saved keeps its value and its v63 basis. It is
    marked "Calculated when this was <old type>" and offers **Change the estimate…**, which opens the estimate panel
    with the new type.
  - The mark is derived, not stored. It compares the estimate's saved time with the latest change of that athlete's
    effective type: the correction log for the session, the exception rows for the athlete. No estimate column is
    needed.

## 6. What the effective type changes, and what it does not

**Own average** works by the athlete's effective type, in history too. A past session counts toward an athlete's
Own average only if the athlete's effective type in it equals the target's, with D7 applied (below). "Then" means the
past session's effective type as it stands now: a correction fixes the record, so a past session corrected to RTP
leaves the Full-training average. In SQL, the filter `a.activity_type_key = $8` becomes
`training.effective_activity_type(<that past participant>) = any($8)`.

**D7, which types count toward which:**

| Option | Rule | Cost |
|---|---|---|
| **1 (recommended)** | A game counts only games. A friendly counts friendlies and games. Every other type counts only itself. | One fixed table of sets in code; the panel's "Compares with" names the set ("Friendly game and Game"); two tests, one per direction. |
| 2 | Same type only. | Nothing beyond today. A friendly's Own average more often has fewer than 3 sessions, so the coach falls back to another method more often. |

Recommendation: option 1, the owner's first wording. It is no problem to build, so the fallback "only the same name"
is not needed. A club type counts only itself.

**Team average and Copy from an athlete** use only athletes whose effective type equals the target athlete's.

Recommendation:
- **Team average** filters to those athletes. With fewer than the method's minimum, the method is unavailable, with
  the reason `too_few_same_type` ("Not enough athletes did <type> in this session").
- **Copy from an athlete** offers only same-type athletes in its picker. A save naming an athlete of another type
  (stale screen) answers `409 source_type_differs` and writes nothing.

The *Rukovodilac* asked for at least a clear warning; the plan recommends the stricter form for both methods.
- The picker shows the other-type athletes greyed out, with "Did <type>, not <type>".
- A save that names one is refused.
- A warning that still allows the save would let a Full-training value land on an RTP athlete, which is what the owner
  wants to avoid.

If the owner prefers a warning, the change is one condition in the save, and the picker stays as described.

**Dashboards.** No dashboard filter or grouping reads a type today (`trainingLoadDashboard*.js`). When one is built,
by session or by athlete:
- **By athlete (recommended)** is right for exceptions: an RTP athlete's values never land in "Full training". Cost: a
  join to the exception table per participant, through the effective-type function or a view, and one index on the
  live exceptions.
- **By session** is cheaper but wrong for exactly the case the owner described.

That is a later request. This plan only makes sure the effective type is readable.

**Unchanged:** RPE and sRPE (asked and stored as today), the calendar (an event keeps its own type; a link only offers
the change), the roster's states, the import's values.

## 7. Manual entry and manual correction on the roster

The same place: the Roster tab, the athlete's row, the same panel as the estimate.

- **Enter values** is a fifth option beside the four estimate methods, for an athlete with no device record. The coach
  types a value per variable. The server writes a `manual` occasion through the same materialization the estimate
  uses: the participant, the event participant, the occasion. It is marked "Entered by <coach> on <date>". If the
  athlete already has an estimate, the manual values replace it as the current occasion; the estimate stays as
  history.
- **Correct a measured value**, on a row with a device record, uses the existing imported-correction route. The
  measured occasion is kept as superseded, the manual one counts, and the row shows "Corrected by <coach> on <date>
  (measured: <value>)". *Undo correction* makes the measured occasion current again (a manual correction of the
  manual occasion back to the measured values, through `…/occasions/:id/correct`). Nothing is deleted.
- **Rights.** These routes check the metrics scope today (`requireMetricsScope`). Before they get a screen, their
  rights are checked against the roster audience, and the identical 404 for everyone else, with the security review.
  Any difference is fixed in the same pull request.
- **Migration:** none. `manual` exists, and so do both routes.
- **Relation to v63's guards ("measured wins").** v63 treats a `manual` value as real, like an imported one.
  - **M2:** an estimate is refused while an effective real whole-session value of the same variable exists for the
    participant (`estimate_measured_exists`). After a manual entry or a correction, the estimate panel says the value
    exists and offers *Correct* instead.
  - **M3:** inserting an effective real whole-session value supersedes the participant's effective estimate of that
    variable, in the same transaction. A manual entry over an estimate therefore needs no code of its own: the
    database does it. The estimate's revision guard allows exactly that.
  - **Import over a manual value:** today the writer keeps the manual value (`stale_resend_ignored`). Section 8 turns
    that into a question.
- **Level.** Manual values are whole-session values only, never per drill, as with estimates.
- **Lock order of a manual write (entry or correction).**
  1. Rights, users first (PR #346).
  2. The team's import lock, taken with a try-lock as the estimate save does (`tryLockTeamForImport`). While an import
     or a check holds it, the answer is `409 try_again` and nothing is written.
  3. The source identity `FOR UPDATE`, for a correction (the existing path).
  4. v13's participant and event locks, taken by the occasion insert.
  5. The estimate occasion's row, through M3.

  The existing correction route does not take the team's import lock today. ST-3 adds it, and a recorded-SQL-order test
  proves the order.
- **Bounds.** The same statement, lock and idle bounds as the estimate save, and a bounded COMMIT. A lost answer reads
  *Result not confirmed* · *Check result*, which sends the same `requestKey`.

## 8. Re-import: "do you want to keep my data"

Today a re-import never replaces a manual value: it records the source's value as `stale_resend_ignored` and asks for
*accept changes*. The owner wants a question instead:

- When a re-import meets manual values (a manual entry or a correction), the review lists them in a block of their
  own: "<n> athletes have values you entered. Keep my values (default) / Use GPEXE's values". The answer is per
  session, with a per-athlete toggle under it.
- The approval carries `replaceManual: [athleteIds]`, bound by the choice hash of section 4 (`subsetHash`), never by
  the stored preview hash. The default, keep everything, needs no choice.
  - **Keep** is today's path: the source's value is recorded but not current. The row stays marked.
  - **Use GPEXE's values** is a new writer path, `manual_replaced`: the imported occasion supersedes the manual one,
    and the manual one stays as history.
  - Either way the change is listed in `changesToImported`, and the accept box still covers it. The question replaces
    the generic box only for these rows.
- Estimates keep the existing 6b-B rule, which this plan does not change.
- **The session's type and the athletes' exceptions** are never touched by a re-import: the writer's re-sighting and
  supplemented paths keep the activity and its participants. So there is nothing to ask about them while the session
  stays imported.
  - The review shows them, so the coach sees what stays: "Your choices stay: session type Full training; RTP for
    2 athletes".
  - After an undo and a fresh import, they are gone along with the activity. The undo's confirmation lists them, and
    the new import's review proposes the team's suggestion again.

**Undo.** The undo (v57, v76) refuses a session that holds a manual value. The owner's plan to delete and re-import the
15 sessions works only while they hold none, which should be today. After section 7 is in use, an undo of a session
with manual values is refused. Question 3 below asks whether the undo should list and remove them behind a
confirmation, the way O1 removes roster work.

## 9. The sessions already imported

- Per the *Rukovodilac*, the owner will delete the 15 sessions and import them again, so nothing is rewritten and no
  backfill runs. Each re-import chooses its type at approval (section 4).
- If they are not deleted, they keep `training_session` (Full training), which is right for GPEXE `FULL TRAINING`.
- The count is not read from production by this plan.

## 10. Migrations, locks and transactions

**Migration of ST-1 (★★):**
- `training.activity_types` gains:
  - an owner (`system` or `club`) and the owner club;
  - who archived it and when;
  - the rename log table;
  - the v35 actor guard on every write;
  - text checked by `source_metric_text_ok`;
  - the seed and the renames of section 2.
- `training_load.source_session_types`, with its guard and seed.

**Migration of ST-3 (★★):**
- `training.participant_activity_types`, with:
  - its one-live-row index;
  - the actor guard;
  - `training.effective_activity_type()`;
  - the end-on-merge and end-on-reparent rule.
- An index on the live rows.

**Calendar (only if the calendar stream agrees):** `calendar.event_types.activity_type_key`, nullable, with its seed.

Each migration has a rollback that refuses once its data is used, plus a preflight, a post-check and a runbook.

**The type's owner, guarded in the database (the *Nezavisni revizor*'s MEDIUM-2).** A foreign key does not know the
owner, so ST-1 adds a guard. It covers `training.activities` (`BEFORE INSERT OR UPDATE OF activity_type_key`) and, in
ST-3, `training.participant_activity_types` (`BEFORE INSERT`).
- **The rule.** The type is a system type, or a type of the club that owns the activity. The owning club is
  `owner_club_id`, or the owner team's club. A private coach's or a user's activity takes system types only.
- **When a new key is set** (`INSERT`, or `UPDATE` with a different key), the type must also be active. A row that
  keeps its key is never refused for an archive done later.
- **Inside the guard.** It locks the type row `FOR SHARE`, so an archive or a restore (which locks the type row
  `FOR UPDATE`) waits for a write in flight and never crosses it.
- **Refusal.** A fixed message, `23514`. The routes map it to `409 session_type_not_offered`.
- **Which paths it covers.** Every write path: the import's materialization, `correct_confirmed_activity_fields`, the
  other materializers of `trainingActivityMaterialize.js` and `trainingActivityMetricsLink.js`, and a raw write. Those
  paths write system types today, so they pass unchanged.
- **Lock order.** The type row comes after the activity or participant row in every path. An archive takes only the
  type row, so there is no cycle.
- **Test.** A club-A type on an activity of a club-B team is refused, by the route and by a raw `UPDATE`. An archived
  type cannot be newly set. A write in flight holds back an archive. M: drop the guard → the club-A-on-club-B test
  fails.

**The approval.**
- The type is part of the body and the plan. The approval checks the chosen type against the offered types under its
  locks (section 4). The guard above is the database's guarantee for every other path.
- The existing lock order (rights → candidate → team import lock → mapping) is unchanged.
- `replaceManual` changes only what the writer does for the listed occasions, inside the identity locks it already
  takes.
- The suggestion's write after the COMMIT is its own transaction and never takes the team import lock.

**A type change:** users → role → canonical activity `FOR UPDATE` → (participant) → log. It takes no team import lock,
so it never waits for an import. A re-sighting import never touches an activity's type or an exception.

**Calendar K5-4.** The "waiting for import" marks show the suggested type, or "Type to choose". That is a small
calendar-stream follow-up; the candidate list gains `suggestedActivityTypeKey`.

## 11. Test plan (disposable databases; mutations marked M)

1. **Type list.**
   - A club admin adds, renames and archives a club type. Another club's admin gets the identical 404. A coach cannot
     write.
   - A rename changes the label on an old session, and the key is unchanged.
   - An archived type is not offered, but stays on its sessions.
   - A raw write without the actor setting is refused.
   - M: drop the guard → the test fails.
2. **Mapper and preview.**
   - An unknown category gives `session_type_required`, not a throw.
   - Two chosen types give two different hashes.
   - Approving with another type answers `preview_changed`, and nothing is written.
   - M: restore the throw, or drop the type from the summary → the test fails.
3. **Approval.**
   - A null type → 409. A type not offered to the team → 400, before any lock.
   - A chosen type is written.
   - The batch takes one type per item.
   - The suggestion updates for this team only, and a failure of its write leaves the import committed.
4. **Exceptions.**
   - Set, end, and the history kept.
   - The same type as the session → 409.
   - The effective type follows the exception.
   - On a merge the canonical participant's exception stays; on a reparent it ends.
   - The roster audience may write; everyone else gets the identical 404.
   - Lock order: a recorded-SQL-order test.
   - M: the effective function returns the session's type → the tests fail.
5. **Estimates.**
   - Own average takes a past session only when the athlete's effective type matched. D7 option 1 in both
     directions.
   - Team average excludes other-type athletes, and `too_few_same_type`.
   - Copy refuses another-type source with 409.
   - A saved estimate keeps its value and carries the mark after a type change.
   - M: make the D7 set symmetric; ignore the exception in the history → the tests fail.
6. **Manual.**
   - An entry for an athlete with no record writes a `manual` occasion and replaces an estimate.
   - A correction keeps the measured occasion as superseded; *Undo correction* restores it.
   - The rights match the roster audience.
   - M: the correction deletes the measured occasion → the test fails.
7. **Re-import.**
   - Keep: the manual value stays current, and the source's value is recorded.
   - Use GPEXE: the import supersedes the manual value, and the manual one stays as history.
   - `replaceManual` is bound in the hash.
   - M: ignore `replaceManual` → the test fails.
8. **Migrations.** Apply, rollback and re-apply; the rollback refuses once its data is used.
9. **The choice and the hash** (MEDIUM-1, section 4).
   - A choice different from the suggestion passes with its `subsetHash`.
   - A `session_type_required` candidate without a choice is refused.
   - A stale choice is refused: a type archived, or no longer the club's.
   - A batch item with a stale choice stops alone.
   - M: compare the choice preview with the stored hash → the test fails.
   - M: skip the offered-types check under the lock → the test fails.
10. **The type's owner** (MEDIUM-2, section 10).
    - A club-A type on a club-B activity is refused, by the route and by a raw `UPDATE`, and so is the same type on
      an exception.
    - An archived type cannot be newly set, but an untouched row keeps it.
    - An archive waits for a write in flight.
    - M: drop the guard → the test fails.
11. **Merge or reparent against an exception** (LOW-2, section 3): run at once in both orders, with no `40P01`; the
    recorded SQL order.

Commands: `--kind disposable` for each new suite, `--preset gpexe`, `--preset frontend-fast` on the head and on a clean
main (the frontend PR gate), and `test:backend:shared` for the training-activity routes (a per-session decision). The
whole e2e for the screens.

## 12. Split into pull requests

The owner's rule of 2026-11-20: risky parts go in small, focused pull requests; the screens go together in one larger
ordinary pull request.

1. **ST-1 (★★, migration):** the type list (table changes, the log, the guard, the routes of section 2) and the source
   map. Backend only.
2. **ST-2 (★★, no migration):** the mapper, the preview and the approval with the chosen type; `session_type_required`.
3. **ST-3 (★★, migration):** per-athlete exceptions with their table and function, the session type change route, and
   the effective type in the estimates (Own average, D7, Team average, Copy), with the derived mark.
4. **ST-4 (★★, no migration):** manual entry and correction (the rights check, the team lock on the correction route),
   the re-import question and the `manual_replaced` writer path.
5. **ST-5 (ordinary, one PR, after the ★★ backends are merged):** every screen.
   - Settings → Tags & Presets → *Session types*.
   - The type in the session review.
   - *Choose the session type* on a blocked row.
   - The type in the session header and the athlete's exception on the Roster tab.
   - *Enter values* and *Correct* in the panel.
   - The estimate mark with *Change the estimate…*.
   - The re-import question.
   - "Compares with" naming the set.

The calendar column and K5-4's label go to the calendar stream, if it agrees.

## 13. The owner's answers, and the open questions

Answered on 2026-11-20 (relayed by the *Rukovodilac*):
- **Q1, "Exercise":** a whole session, only another name ("cele sesije su to, samo njihov naziv"). Key
  `exercise_session`, label "Exercise". The label of `training_session` is "Full training".
- **Q2, D7:** option 1.

Answered later on 2026-11-20 (relayed by the *Rukovodilac*; for Q3-Q5 the owner said to follow the recommendation
until he says otherwise; real data starts next year, today's data is trial data, and the 15 sessions are deleted and
imported again):
- **Who changes a session's type:** the team's coach, the club's admin and a platform admin (section 5, as
  recommended).
- **Q3, undo with manual values:** allowed after a confirmation that lists them (★★, in the same transaction); without
  the confirmation the undo still refuses. A later ★★ pull request, with ST-4.
- **Q4:** `training_session` is renamed "Full training" everywhere, hand-planned sessions included. Built in v85.
- **Q5:** `testing_session` and `recovery_session` are archived from the pickers; old sessions keep them. Built in v85.

## 14. ST-1 as built (migration v85, `migrations_v2/202611201500_training_load_v85_session_types.sql`)

- **Seed.** `training.activity_types` gains an owner (`system` / `club`), its club, the creator, the archive (who, when;
  `is_active` is the archive flag), a sort order and `updated_at`. The six system types carry the owner's labels;
  `testing_session` and `recovery_session` are archived without a user.
- **Log and guards.** `training.activity_type_changes` is the append-only log and the routes' request record (unique
  per user and `requestKey`, with the body's hash). The acting user is `optimove.session_type_actor` (the v35 pattern).
  The rights are locked users first (PR #346): `training.session_type_basis`. A type change without its log row is
  refused at COMMIT (deferred). A type is never deleted; key, owner and creator are write-once.
- **The owner guard on `training.activities`** (MEDIUM-2): `BEFORE INSERT OR UPDATE OF activity_type_key, owner_scope,
  owner_club_id, owner_team_id`, through `training.session_type_offered`, which locks the type row FOR SHARE.
- **`training_load.source_session_types`:** the team's suggestion per source category. It is seeded with
  `FULL TRAINING` → `training_session` for every team with an active gpexe binding. Its guard asks for a team manager,
  and for a type offered to the team and active. ST-2 writes it.
- **Routes** (`backend/src/routes/sessionTypes.js`, `backend/src/sessionTypeService.js`), mounted before the
  training-activity router:
  - `GET /api/training-activity/session-types`;
  - `POST /`, `POST /:key/rename` (with `expectedLabel`), `POST /:key/archive`, `POST /:key/restore`.

  System types are written in the platform workspace by a platform admin, club types in the club's workspace by its
  admin (a platform admin in a club's workspace writes as that club's admin, T6). Everyone else gets the identical 404.
  The key is generated (`s_<8 hex>_<slug>`, `c_<8 hex>_<slug>`).
- **Not in ST-1:**
  - the screen (ST-5);
  - the mapper, preview and approval (ST-2);
  - per-athlete exceptions (ST-3);
  - manual values (ST-4).

  The Training Load calendar still shows the raw key words ("training session") until ST-5 reads the labels.
- **Runbook:** `docs/runbooks/session-types-v85.md`, with its preflight, post-check, rollback and the rehearsal tool.
