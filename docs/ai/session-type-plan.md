# OptiMove decides the session type, not the source (plan)

Status: **Proposed** (2026-11-20). This is a plan only: no code and no migration file until the owner accepts it. The
migration number comes from the *Rukovodilac*.
Last verified against commit: `d3b5f50b` (`origin/main`, merge of PR #693).
Level: risky. It changes what an import writes (the activity's type) and needs a migration, so it goes through the
*Nezavisni revizor* and the *Rukovodilac*'s full gate (triggers 1 and 3 of `CLAUDE.md`; trigger 4 for the approval's
transaction).

## 0. The owner's words (relayed by the *Rukovodilac*, 2026-11-20)

- The types: "Full training, game, friendly game, exercise, compensation, RTP".
- "A friendly is not added to the average of normal matches, but matches may count toward friendlies; if that is a
  problem, only sessions with the same name."

## 1. What the code does today (checked on `d3b5f50b`)

| Fact | Where |
|---|---|
| The activity's type is a row of the catalog `training.activity_types` (`key`, `label`, `is_active`); seeded with `training_session`, `match`, `testing_session`, `recovery_session`. The table's own comment: a new type is an INSERT, never a schema change. | `migrations_v2/202609071000_training_activity_v1_core_tables.sql:39-49` |
| `training.activities.activity_type_key` references it and may be null. | same file, `:89` |
| On a `confirmed` or `superseded` activity the type is immutable, except through `training.correct_confirmed_activity_fields(...)`, which locks the row and writes a before/after row to `training.activity_field_correction_log` (who, why). No route calls it today. | same file, `:167-182`, `:258-290` |
| The GPEXE mapper turns the source's category into the type with one fixed pair: `FULL TRAINING` -> `training_session`. Any other category throws `unsupported_category`, so the whole session is blocked at the check (shown as `unsupported_session_type`). | `backend/src/gpexeImportMapper.js:49`, `:368-369`; `backend/src/gpexeImportReasons.js:63` |
| The writer passes that key to `training.materialize_activity_group_from_metric_event`. | `backend/src/gpexeImportWriter.js:757` |
| The preview's session summary carries the source's `categoryName`, not the OptiMove type; the preview hash covers the summary. | `backend/src/gpexeImportPreview.js:268-280`, `:354` |
| An import never links a calendar event: `calendar.event_activity_links` rows are written by hand (K2a-1b, K5-3 *Add to the event?*). | `backend/src/calendarEventService.js:1794`; no writer in `gpexeImport*.js` |
| Calendar event types are per club, with a write-once `kind` in (`training`, `match`, `travel`, `meeting`, `day_off`, `camp`, `test`); the system seed has one row per kind. | `migrations_v2/202610311000_calendar_v49_events.sql:98-133`, `:864-871` |
| The estimate's Own average reads only sessions whose activity has the SAME `activity_type_key` as the target. The D7 match rule is not built. | `backend/src/metricEstimateService.js:255-272` |

## 2. One type list (no parallel registry)

The list stays `training.activity_types`. The owner's six names map to it like this:

| Owner's word | Key | Today |
|---|---|---|
| Full training | `training_session` (label stays "Training session", or renamed "Full training" by the owner) | exists |
| Game | `match` | exists |
| Friendly game | `friendly_match` | new row |
| Exercise | `exercise_session` | new row (see question Q1) |
| Compensation | `compensation_session` | new row |
| RTP | `rtp_session` (label "Return to play") | new row |

- `testing_session` and `recovery_session` stay in the catalog for activities that already use them. They are not
  offered for a GPS session unless the owner wants them.
- **Rows on production need a migration file.** The rows are data, not schema, but nothing writes to production
  except through the migration runner, so the four rows come in the same migration as section 7.

**Calendar fit.** A calendar event's `kind` is coarser than this list (`match` covers both a game and a friendly).
Recommended: a nullable `activity_type_key` on `calendar.event_types`, which references `training.activity_types`. The
system rows are seeded (`training` -> `training_session`, `match` -> `match`, `test` -> `testing_session`), and a club
may add its own "Friendly" type that points at `friendly_match`. That table belongs to the calendar stream, so this
column goes in only with that stream's agreement. Until then, rule (a) of section 3 uses the kind alone.

## 3. Where the type comes from

The order, first match wins:

1. **(a) The linked calendar event.** If the activity is linked to a live calendar event, the event type's
   `activity_type_key` (or, until the column exists, its kind: `training` -> `training_session`, `match` -> `match`)
   is the **suggestion**. Today an import has no link at approval time (section 1), so this applies mainly to a type
   change after the import (section 4): linking an event whose type differs offers *Change the type to <X>?*. It
   never changes anything by itself.
2. **(b) The source's category, confirmed by the coach.**
   - The team's last choice for that category is the suggestion. It is stored per team, source and category, in a
     new table: `training_load.source_session_types` (`owner_team_id`, `source_system`, `category_name`,
     `activity_type_key`, who, when).
   - The seed is one row per team that holds a binding: `FULL TRAINING` -> `training_session`, today's fixed pair.
   - At approval the coach sees the suggestion and may change it. The review's header reads
     "Type: Full training (from GPEXE "FULL TRAINING") - Change".
3. **(c) An unknown category no longer refuses the session.** The mapper builds the plan with
   `activityTypeKey: null`, and the session is a pending candidate with the blocker `session_type_required`
   ("Choose the session type").
   - Approve stays off until a type is chosen.
   - The check-time preview runs with no type. The column may be null, and the preview is rolled back.
   - The approval refuses a null type with `409 session_type_required`, and writes nothing.

**Sent and checked.**
- The approval body (single and batch) carries `activityTypeKey` per candidate. The server checks it against
  `training.activity_types where is_active`, before any lock (`400 invalid_session_type`).
- The chosen type goes into the plan and into the preview's session summary as `activityTypeKey`. The preview hash
  therefore binds it, and a type changed after the review answers `preview_changed`.
- **Hash effect:** every stored preview changes once, because the summary gains a field. So a candidate reviewed
  before the deploy answers `preview_changed` once at approval (the J20-A1 *Update the review* path, as after v62).
  No imported data changes.

**After a confirmed approval** the team's suggestion for that category is updated in its own short transaction. It is
best effort: a failure is logged and never touches the import.

## 4. Changing the type after the import

- **Route:** `POST /api/training-activity/:activityId/type` `{ activityTypeKey, reason, requestKey }`.
  - It calls `training.correct_confirmed_activity_fields` with every other field unchanged. That function already
    locks the activity row and writes the before/after row to the correction log (who, why, when).
  - The same type again is a no-op `200`. A `requestKey` replay answers the saved outcome, and the request record is
    the correction-log row together with the key.
- **Who:** the people who manage the team's sessions. That is the team's coach in the team's workspace, the club's
  admin and a platform admin, the audience of roster decisions (`training.lock_activity_decider`). Everyone else gets
  the identical 404 (ADR-006). The rights lock comes before the activity row, users first (the rule of PR #346).
- **Estimates already saved stay as they are**, with their value and their v63 basis unchanged.
  - The panel marks such an estimate as "Calculated when this was a <old type> session".
  - The mark is derived, not stored: the estimate's saved time is compared with the activity's last type correction
    in the log. So no estimate column is needed and v63's shape check is untouched.
  - A new estimate uses the new type.
- **Merged or superseded activities:** the change acts on the canonical activity only
  (`training.resolve_canonical_activity_id`); a superseded id answers `409 activity_superseded` with the current id,
  as the roster does.

## 5. Own average by OptiMove type (D7)

Own average already compares by `activity_type_key` (section 1), so it follows the OptiMove type automatically once
the type is right. The open part is D7, which types count toward which:

| Option | Rule | Cost |
|---|---|---|
| **1 (owner's first wording, recommended)** | A game counts only games. A friendly counts friendlies and games. Every other type counts only itself. | One fixed table of comparison sets in code (`COMPARES_WITH`), with no migration. The SQL filter becomes `a.activity_type_key = any($8)`. The panel's "Compares with:" names the set ("Friendly game and Game"). Tests: one per direction (a friendly target sees a game; a game target never sees a friendly). |
| 2 ("same type only") | Every type counts only itself. | No code change beyond today. A friendly's Own average often has fewer than 3 sessions ("too_few_sessions"), so the coach falls back to the position or team average more often. |

Recommendation: **option 1**. It is what the owner asked for first, and its cost is one constant and two tests.
Nothing in it is a problem, so the owner's fallback ("only the same name") is not needed. Rule D7 never reads the
source's category, only the OptiMove type.

## 6. The sessions already imported

- As relayed, 15 imported sessions on production are all GPEXE `FULL TRAINING`, imported as `training_session`. That
  is the right type, so nothing is rewritten and no backfill runs.
- If the owner wants one of them marked differently (an RTP session recorded as a full training, say), it is changed
  one at a time through section 4, with a reason, after the deploy.
- The count is not read from production by this plan. The *Rukovodilac*'s read-only post-check confirms it:
  `select activity_type_key, count(*)` over the activities the GPEXE approvals wrote.

## 7. Migration, locks and transactions

**Migration: yes, one, ★★.** It contains:
1. four rows in `training.activity_types` (section 2), checked by key;
2. `training_load.source_session_types`:
   - a primary key on team, source and category;
   - a foreign key to `training.activity_types`;
   - the v35 actor guard on every write: a team manager, or the approval's own user;
   - text checked by `source_metric_text_ok`;
   - the seed rows of section 3 (b);
3. (only if the calendar stream agrees) `calendar.event_types.activity_type_key`, nullable, with the system seed.
   Otherwise this is a later calendar migration.

Its rollback refuses once an activity uses a new type, or a non-seed map row exists. It comes with a preflight,
a post-check and a runbook, as usual.

**The approval.**
- The type is part of the body and the plan. It adds no lock: the catalog is read once outside the transaction, and
  the foreign key on `training.activities` is the database's guarantee if a type is retired meanwhile.
- The approval's lock order (rights -> candidate -> team import lock -> mapping) is unchanged.
- The suggestion's write after the COMMIT is a separate transaction. It never takes the team import lock, so it
  cannot wait on a running check.

**The type change (section 4):** rights (users first) -> the canonical activity `FOR UPDATE` (inside the sanctioned
function) -> the correction log. It takes no team import lock, so it never waits for an import. An import that
re-sights the session later does not touch the activity's type: the writer's supplemented path keeps the activity.

**Dashboards.** No dashboard filter reads `activity_type_key` today (checked: `trainingLoadDashboard*.js`), so nothing
changes there. A type filter is a later, separate request.

**Calendar K5-4.**
- The "waiting for import" marks read the candidates, and show the source's category today.
- After this plan they show the suggested OptiMove type, or "Type to choose" for `session_type_required`.
- That is a small calendar-stream follow-up; the candidate list gains `suggestedActivityTypeKey` for it.

## 8. Test plan (disposable databases; mutations marked M)

1. **Mapper.**
   - `FULL TRAINING` without a choice gives `training_session`.
   - An unknown category gives a plan with a null type and the blocker `session_type_required`, not a throw.
   - M: restore the throw, and the test fails.
2. **Preview hash.**
   - The same candidate with two different chosen types gives two different hashes.
   - Approving with a type other than the reviewed one answers `preview_changed`, and nothing is written.
   - M: drop `activityTypeKey` from the summary, and the test fails.
3. **Approval.**
   - A null type: `409 session_type_required`, nothing written.
   - An inactive or unknown key: `400 invalid_session_type`, before any lock. The test asserts no lock was taken.
   - A chosen `friendly_match` writes it on the activity.
   - The batch carries a type per item.
   - M: skip the null check, and the test fails.
4. **Suggestion.**
   - After the approval, the team's map row holds the choice, and the next check suggests it.
   - Another team's choice never leaks into this team's suggestion.
   - A failure of the suggestion's write leaves the import committed.
   - M: write the map with the wrong team, and the test fails.
5. **Type change.**
   - The coach and the club admin may change it; another club's admin, a coach of another team and an athlete get
     the identical 404 (byte for byte).
   - One correction-log row with who and why.
   - The same type is a no-op.
   - A `requestKey` replay writes nothing.
   - A superseded id answers `409`.
   - A recorded-SQL-order test (users -> role -> activity), per the rule of PR #346.
   - M: drop the rights check, and the test fails. M: lock the activity before the users row, and the order test
     fails.
6. **Estimates (D7, option 1).**
   - A friendly target counts games and friendlies; a game target never counts a friendly.
   - A saved estimate keeps its value after a type change and shows the "Calculated when…" mark; a new proposal uses
     the new type.
   - M: make the set symmetric, and the game test fails.
7. **Migration.**
   - Apply, rollback and re-apply on a disposable database.
   - The rollback refuses when a new type is in use.
   - The actor guard refuses a raw map write without the actor setting.
   - M: remove the guard's trigger, and the test fails.

Test commands: `--kind disposable` for each new suite, `--preset gpexe`, `--preset frontend-fast` on the head and on
a clean main (the frontend PR gate), and `test:backend:shared` for the training-activity route (a per-session
decision).

## 9. Split into pull requests

1. **ST-1 (★★, migration):**
   - the catalog rows, the map table and its guard;
   - the mapper and preview change (unknown category -> `session_type_required`);
   - the approval's type and the suggestion's write;
   - the backend tests.
2. **ST-2 (★★, no migration):** the type change route with its rights, plus the estimate's derived mark and D7.
3. **ST-3 (ordinary):** the screens:
   - the type chooser in the session review;
   - *Choose the session type* on a blocked row;
   - the type change in the session's header;
   - "Compares with" naming the set.

The calendar column and K5-4's label go to the calendar stream, if it agrees.

## 10. Questions for the owner (at most three)

1. **"Exercise":** what is this session? An individual or gym session, a team drill session, or something else? The
   answer sets its key and label.
2. **D7:** option 1 (a friendly counts games, a game never counts a friendly; recommended) or option 2 (same type
   only)?
3. **Who may change a session's type after import:** the team's coach, the club admin and a platform admin
   (recommended, the same people as roster decisions), or only the people who may approve imports?
