# Central calendar — K4b contract: changing an RPE answer while the question is open

Status: **Proposed** (documents only; no code, no migration file). Written against `main` `f406ee2d` and the K4 plan on
branch `claude/central-calendar-k4-plan` at `89f26566` (section 4). Migration **v83**, prefix **`202611201200`**
(given by the OptiMove manager on 2026-11-19; no file with that prefix exists on `f406ee2d`). ★★: triggers 1 (a
migration) and 4 (a transaction, lock order, idempotency) of `CLAUDE.md`.

The owner's rule (O4) and the OptiMove manager's six conditions are in the K4 plan, section 4. Section 9 of this
document maps each condition to the place that meets it.

## 1. Facts (file:line on `f406ee2d`)

### 1.1 The table and its trigger

- `training_load.session_feedback` is created in
  `migrations_v2/202608310900_training_load_v1_session_feedback.sql:63-95`: `rpe smallint not null` (79),
  `duration_minutes smallint not null` (80), `srpe integer generated always as (rpe * duration_minutes) stored` (82),
  `athlete_note text` (83), `created_at` (85), `submitted_at` (86); checks `rpe between 0 and 10` (88),
  `duration_minutes between 1 and 600` (89), note ≤ 500 characters (90).
- v5 (`202609011100_training_load_v5_unified_result_source.sql`) adds `source` (`planned` / `scheduled_external`,
  48-49), `external_assignment_id` (59-60), `event_name` (61-62), the XOR identity check (72-75) and
  `unique (external_assignment_id)` (84).
- **The trigger.** `protect_session_feedback_snapshot` is created in
  `202608320900_training_load_v2_logical_session_identity.sql:163-188` (BEFORE UPDATE, FOR EACH ROW) and its body is
  replaced, never weakened, in v5 `:107-131`. Every column but `plan_session_id` is frozen, `rpe`,
  `duration_minutes`, `athlete_note` and `submitted_at` among them. `srpe` is not compared (v2 `:148-160`: a generated
  column is NULL inside a BEFORE trigger) and needs no guard: it follows `rpe` and `duration_minutes`.

### 1.2 The window

- `training_load.external_assignments` (`202609011000_training_load_v4_external_scheduling.sql:316-345`) has its own
  `opens_at`, `due_at`, `closes_at` and `status` (`pending`, `open`, `in_progress`, `completed`, `missed`, `excused`,
  `cancelled`).
- The window is frozen at materialization: `protect_external_assignment_identity_and_lifecycle` (v4 `:347-372`)
  refuses any change of `opens_at` / `closes_at` (`:360`) and any move out of a terminal status (`completed` is
  terminal).
- **How a question "closes" before or at `closes_at`:**
  - the clock passes `closes_at`;
  - the schedule is cancelled: `cancelExternalSchedule` (`backend/src/externalScheduleWriter.js:44-49`, an `update …
    set status = 'cancelled'` of the schedule row). It runs when a calendar question ends
    (`backend/src/calendarQuestions.js:376-383`, `endQuestion`, the reasons `closed_early`, `removed`, `moved`,
    `event_cancelled`) and from Training Load's own `POST /external-schedules/:scheduleId/cancel`
    (`backend/src/routes/trainingLoad.js:2412`);
  - an occurrence turned `cancelled` (no route does it today; the submit refuses it defensively,
    `trainingLoad.js:2568-2576`).

  An answered assignment stays `completed`; the answers stay when a question ends
  (`calendarQuestions.js:374-375`).

### 1.3 The submit path today

`POST /api/training-load/external-assignments/:assignmentId/rpe`, `backend/src/routes/trainingLoad.js:2514-2659`:

1. `requireAthlete` (2517); a malformed id is `404 "Training session not found."` (2520).
2. The body: `rpe` an integer 0–10 (2524-2526), `durationMinutes` an integer 1–600 (2527-2529), `note` trimmed, ≤ 500
   (2532-2533).
3. `begin` (2536); an unlocked lookup of assignment → occurrence → schedule (2538-2545); not hers or missing → the same
   `404` (2547-2550).
4. **Locks, in this order:** schedule `FOR UPDATE` (2552), occurrence `FOR UPDATE` (2553), assignment `FOR UPDATE`
   (2555); the athlete re-checked on the locked row (2557-2560).
5. Gates under the locks: schedule `active` (2563-2567), occurrence not `cancelled` (2573-2576), assignment not
   `missed` / `excused` / `cancelled` (2589-2592, `409 "This check-in window is closed."`), `now()` inside
   `opens_at`–`closes_at` (2594-2599, the same sentence). `now()` is the transaction's start time, not the time after
   the locks.
6. `insert … on conflict (external_assignment_id) do nothing` (2601-2607); on an insert the assignment becomes
   `completed` (2611), the occurrence is materialized as one activity (2629-2632), `commit` (2633), the realtime
   event `training_load_changed` (2636), `201`.
7. On a conflict: the existing row is read (2640-2644); an identical answer is `200` (2647), anything else
   **`409 "This session already has a submitted result."`** (2648). This is the path K4b changes.

No users or athletes row is locked by the submit.

### 1.4 What the form sends, and whether the duration is the athlete's own entry

- The RPE form opens from `emptyRpeForm` (`frontend/state.js:669-688`) with `rpe: 5`, **`durationMinutes: ""`** and
  `note: ""`; `openRpeFormForSessionId` (`frontend/training-load-actions.js:2770-2785`) passes only the session's name,
  slot, time and date — never a duration.
- The duration field is "Actual duration (minutes)", empty with the placeholder "e.g. 60"
  (`frontend/training-load-view.js:337-340`); Save stays off until the athlete types 1–600 (`:360-364`).
- The submit sends exactly `{ rpe, durationMinutes, note }` (`frontend/training-load-data.js:429-433`).
- The calendar question's schedule carries no duration (`opens_time`, `due_time`, `closes_time`, the event's name and
  type; `trainingLoad.js:2483-2489`), and the route takes the duration only from the body (2527-2531).

**Settled: on an external (calendar) RPE answer, the RPE, the duration and the note are all three the athlete's own
entry. Nothing in the row comes from the coach or an import except the identity and snapshot columns (`event_name`,
`session_date`, `external_assignment_id`, `source`), which never change.** Section 2 and open question Q1 draw the
consequence.

### 1.5 Every reader of `session_feedback` (condition 3)

`grep -rn session_feedback backend/src migrations_v2 frontend` on `f406ee2d`. "Live" means: the reader joins the one row
by its identity at read time and keeps nothing between requests.

| # | Reader | file:line | What it reads | Caches / copies / sums history? |
|---|---|---|---|---|
| 1 | Athlete Home, planned rows (`GET /athlete/today`) | `routes/trainingLoad.js:173`, join `:191` | the row's values | live, no |
| 2 | Athlete Home, external rows (`GET /athlete/today`) | `:236`, `closesAt` `:274`, `actionable` `:281` | values, `closesAt` | live, no |
| 3 | Planned submit (its replay read) | `:462`, `:505` | the row | live, no |
| 4 | Weekly (`GET /weekly`), planned | `:1051`, join `:1187` | values | live, no |
| 5 | Weekly, external | `:1220` (`closesAt` `:1407`, `actionable` `:1417`) | values | live, no |
| 6 | Weekly, orphaned planned results | `:1250-1262` | values, `source = 'planned'` only | live, no; one row per identity (the comment `:1236-1245` on not double-counting) |
| 7 | Training Load calendar (`GET /calendar`) | `:1471`, `:1577` (`rated` count), `:1729` | existence | live count of current rows, no |
| 8 | External schedule detail | `:2137`, `:2159` (`rated_count`) | existence | live count, no |
| 9 | External submit (insert, replay read) | `:2602`, `:2641` | the row | live, no |
| 10 | Central calendar, planned groups | `backend/src/calendarQuery.js:209` (`rpe_submitted`) | existence | live, no |
| 11 | Central calendar, activities | `calendarQuery.js:266` (`requested` / `rated`) | existence | live count, no |
| 12 | Central calendar, external assignment rows | `calendarQuery.js:335` (`rpe_submitted`) | existence | live, no |
| 13 | Calendar question answered (athlete list) | `backend/src/calendarQuestionService.js:51-56` (`ANSWERED_SQL`), used `:84` | existence | live, no |
| 14 | Calendar question answered count | `backend/src/calendarQuestions.js:261-272` (`answeredCount`) | existence | live count, no |
| 15 | Event sessions with results | `backend/src/calendarEventService.js:1597` | count by `logical_session_id` | live, no (planned only) |
| 16 | Planned-session flags | `backend/src/plannedSessionFlags.js:81` | count | live, no (planned only) |
| 17 | `canonical_activity_results()` | `migrations_v2/202609071300_training_activity_v4_canonical_functions.sql:730`, the `rpe` fact `:761-765` | `rpe`, `durationMinutes`, `srpe` of the one row, built into the fact's `jsonb` at read time | live (`language sql stable`, no table), no; never redefined after v4 |
| 18 | Dashboards (built-in `rpe` / `srpe` / `duration_minutes`) | `backend/src/trainingLoadDashboardQuery.js:105-118` (via 17), `:285`, `:323-330` | the facts of 17 | live; `rangeCache` (`:695`) lives inside one `runDashboardBatchQuery` call only; sums (`srpe` `sum`, v18 seed `202609101200…:19`) are over current rows, one per identity |
| 19 | Athlete's own results | `backend/src/trainingActivityResults.js:213` (via 17) | `rpe`, `durationMinutes`, `srpe` | live, no |
| 20 | Rosters | v25 `:473`, v26 `:132`, v44 `:85`, v60 `:171` (all via 17) | existence of facts; v26 only `metric_value` | live, no; a change neither adds nor removes a row |
| 21 | Calendar v81 open questions | `202611191000_calendar_v81_athlete_questions.sql:499` | `not exists` | live, no |
| 22 | Activity materialization | `backend/src/trainingActivityMaterialize.js:790` (a comment); `materialize_activity_group_from_external_occurrence` copies no RPE value (`grep -n "duration_minutes\|sf.rpe" migrations_v2/*training_activity*` hits only 17) | — | no copy |

The frontend only renders what these reads return (`frontend/training-load-view.js:66`, `:715`); it keeps the last
read in `state` until the next read or a realtime event.

**Conclusion (condition 3):** no reader caches between requests, copies an RPE value into another table, or sums
anything but the one current row per identity. ADR-004 holds as written: the change happens in place, and every
reader sees it on its next read. The new history table (section 3) is read by exactly one new reader (section 4.3) and
by nothing that sums.

## 2. What may change (condition 4)

- **Changeable:** the RPE; the duration; the note. The duration is the athlete's own typed entry (1.4), so it falls
  under the manager's rule "what the athlete entered in that answer themselves" and under the owner's O4, which names
  "RPE, duration and note". The manager's text also says "not the duration"; that sentence assumed the duration might
  come from the schedule, which 1.4 disproves. **Q1** asks the manager to confirm; if he keeps "not the duration",
  the function takes no duration parameter and everything else here stands.
- **Never changeable:** every other column (identity, `source`, `event_name`, `session_date`, the snapshot columns,
  `submitted_at`, `created_at`). `submitted_at` stays the time of the first answer; the time of the last change lives
  in the history (no new column on `session_feedback`, so condition 5's "changes no existing row" holds trivially).
- **Only `source = 'scheduled_external'`.** A planned (Builder) answer has no window (O4); the function and the
  relaxed trigger refuse it.
- **Nothing from the coach or an import** is in this row; the rule is therefore enforced as "only these three
  columns, only on an external row".
- **The same value writes nothing.** An answer equal to the current row (RPE, duration, note after the same trim) is
  `200 unchanged`, with no history row and no update.

## 3. The design (option C)

### 3.1 Objects (migration v83)

- **`training_load.session_feedback_changes`**, append-only:
  - `id uuid pk`; `session_feedback_id uuid not null references training_load.session_feedback(id) on delete
    restrict`; `external_assignment_id uuid not null`; `athlete_id uuid not null`;
  - `revision integer not null check (revision >= 1)`, `unique (session_feedback_id, revision)`;
  - `changed_by_user_id uuid not null references public.users(id) on delete restrict`;
    `changed_at timestamptz not null default clock_timestamp()`;
  - `basis text not null check (basis = 'athlete_self')` (the only basis in K4b; a coach correction would be a new
    basis by a new decision);
  - `old_rpe`, `old_duration_minutes`, `old_athlete_note`, `new_rpe`, `new_duration_minutes`, `new_athlete_note`, with
    the same checks as `session_feedback`, and `check ((old_rpe, old_duration_minutes, old_athlete_note) is distinct
    from (new_rpe, new_duration_minutes, new_athlete_note))`;
  - `request_key uuid not null`, `request_hash text not null` (sha256 of the canonical body), `unique
    (session_feedback_id, request_key)`;
  - `xact_id xid8 not null default pg_current_xact_id()` (for the deferred guard; PostgreSQL ≥ 13, as v35).
  - Index `(external_assignment_id, changed_at desc)` for the coach's read.
  - Triggers: BEFORE UPDATE / DELETE / TRUNCATE refuse (`23514`, a fixed message); BEFORE INSERT
    `session_feedback_changes_guard` (3.4).
- **`training_load.rpe_change_marker_ok()`**: `coalesce(current_setting('optimove.rpe_change_tx', true) =
  pg_current_xact_id()::text, false)` (the v57 `session_undo_marker_ok` pattern, `v57:59-61`).
- **`training_load.change_external_rpe(...)`**: the sanctioned function (3.2).
- **`protect_session_feedback_snapshot`** replaced (`create or replace`, with an md5 precondition on the v5 body in
  force): unchanged, except that when `rpe_change_marker_ok()` is true **and** `OLD.source = 'scheduled_external'`,
  `rpe`, `duration_minutes` and `athlete_note` may differ; every other column stays frozen in every case.
- **`session_feedback_change_link`**: `create constraint trigger … after update of rpe, duration_minutes,
  athlete_note on training_load.session_feedback deferrable initially deferred for each row` (3.5).

No table but the new one, no column on an existing table, no data change: v83 changes no existing row.

### 3.2 The sanctioned function

`training_load.change_external_rpe(p_actor_user_id uuid, p_assignment_id uuid, p_request_key uuid, p_rpe smallint,
p_duration_minutes smallint, p_note text, p_expected_revision integer) returns jsonb`, `security invoker`,
`set search_path = pg_catalog, public`. It refuses with `raise exception 'rpe_change:<code>' using errcode = '55000'`
(the v57 shape), which the service maps (4.2). Steps:

1. Arguments: `p_note` trimmed, empty → `null`; ranges as the table's; any null required argument → `invalid`.
2. **Rights rows, users first** (`.claude/rules/migrations.md` "Lock order: rights rows"): `public.users` of the actor
   `for share` (active), then the athlete row whose `user_id = p_actor_user_id` `for share`. No athlete for the user →
   `not_found`.
3. Unlocked lookup assignment → occurrence → schedule (as the submit, 1.3 step 3). Missing, or the assignment's
   `athlete_id` is not the actor's athlete → `not_found` (the identical answer, 3.8).
4. **The submit's order:** schedule `FOR UPDATE` → occurrence `FOR UPDATE` → assignment `FOR UPDATE`; the athlete
   re-checked on the locked assignment (`not_found`).
5. The answer: `session_feedback` by `external_assignment_id` `FOR UPDATE`. None → `not_answered`. Its `source` must be
   `scheduled_external` (always true for that key; asserted).
6. **Idempotency before the window** (so a retry after an unknown outcome gets its answer even if the window closed
   meanwhile): a history row with `(session_feedback_id, request_key)` exists → same `request_hash` → `replayed`
   (nothing written); another hash → `request_key_reused`.
7. **The window, under the locks, at the clock** (`v_now := clock_timestamp()` read after step 5, never `now()`):
   schedule `active`, occurrence not `cancelled`, assignment `completed` (an answered assignment; any other status →
   `window_closed`), `v_now between opens_at and closes_at`. Otherwise `window_closed`.
8. Same values as the current row → `unchanged` (nothing written, no history row, the key not recorded).
9. `p_expected_revision` is not null and differs from the current revision (max `revision`, 0 when none) →
   `answer_changed` (another tab changed it first).
10. `perform set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true)`.
11. Insert the history row (revision + 1, the old and new values, the actor, `basis = 'athlete_self'`, the key, the
    hash).
12. `update training_load.session_feedback set rpe = …, duration_minutes = …, athlete_note = … where id = …`.
13. `set constraints training_load.session_feedback_change_link immediate` — the deferred check fires here, inside the
    function (the v57 step "the deferred link is checked here, not at the COMMIT", `v57:699`), then `set constraints
    … deferred` again.
14. `perform set_config('optimove.rpe_change_tx', '', true)` (the marker never outlives the function; `is_local = true`
    means it never outlives the transaction either).
15. Return `{ outcome: 'changed', feedbackId, revision, changedAt }`.

Inside a savepoint the function refuses (`in_savepoint`), as v35 does: a rolled-back savepoint could drop the history
row while a later update in the same transaction still saw the marker.

### 3.3 Lock order

`users (share) → athletes (share) → external_schedules (update) → external_schedule_occurrences (update) →
external_assignments (update) → session_feedback (update) → insert session_feedback_changes`.

- The schedule → occurrence → assignment part is the submit's own (1.3 step 4), so a change and a submit of the same
  assignment cannot deadlock.
- Users first matches the calendar commands that end a question (their writer lock takes users first since v54) and
  the rule of `migrations.md`. The submit takes no users lock; a change taking it first adds no inversion, since the
  submit holds nothing the users lock waits on.
- Every lock is taken before the first write (step 11); a recorded-SQL-order test proves it (section 7, T14).
- The route sets `lock_timeout` 5 s and `statement_timeout` 10 s after `BEGIN`; `55P03` / `40P01` / `57014` →
  `409 try_again`, nothing written.

### 3.4 The history insert guard (the database checks condition 1)

`session_feedback_changes_guard` (BEFORE INSERT) refuses (`42501` / `23514`, fixed messages) unless:
- `rpe_change_marker_ok()` is true;
- not inside a savepoint;
- the row's `session_feedback_id` row has `source = 'scheduled_external'` and the given `external_assignment_id` and
  `athlete_id`, and that athlete's `user_id = changed_by_user_id`, an active user;
- the assignment's schedule is `active`, the occurrence not `cancelled`, the assignment `completed`, and
  `clock_timestamp()` lies inside `opens_at`–`closes_at`;
- the old values equal the feedback row's current values and `revision` is the current max + 1.

So the window and ownership are checked by the database at the write, not only by the function or the service.

### 3.5 The deferred guard (the v35 lesson)

`session_feedback_change_link` fires for an update that changed `rpe`, `duration_minutes` or `athlete_note`. At its
check it reads the **current** row (not `NEW`, which a later update in the same transaction may have replaced) and
requires a history row with `session_feedback_id = id`, `xact_id = pg_current_xact_id()` and `new_*` equal to the
current values. Otherwise `23514` and the whole transaction rolls back.

What it stops, and what it does not. The marker is not a secret: any session on the database can set
`optimove.rpe_change_tx` for its own transaction (test 14 of the K4b suite does). What then still holds:

- the deferred link refuses a changed answer that has no history row from the same top-level transaction (not a
  savepoint);
- the history insert guard (3.4) bounds the change: the row's actor is the athlete's own active user, the window is open
  (schedule active, occurrence not cancelled, assignment completed, `clock_timestamp()` inside `opens_at`..`closes_at`,
  read under share locks), the old values are the answer's current values, and the revision is the next one;
- only `rpe`, `duration_minutes` and `athlete_note` of a `scheduled_external` answer can change.

So a raw session holding the database credentials can make a change that the athlete could have made, with its history
row, inside the open window. The guards prove that the row, the history and the window agree, not that the caller was
entitled; they do not stop a credential holder, who can also disable a trigger. This is the v35 limit, stated the same
way. The separate migration and runtime roles stay the later infrastructure task (`docs/ai/CURRENT_STATE.md`, Separate
tasks).

### 3.6 The race: a change against the question closing

Both orders, each with a test (T8, T9):

- **The close first** (a schedule cancel, e.g. `endQuestion`, commits first): the change's step 4 waits on the
  schedule row, then reads `cancelled` → `window_closed`. Nothing written.
- **The change first** (it holds the schedule row): the cancel's `update … set status = 'cancelled'` waits; the change
  commits (`changed`), then the cancel commits. The changed answer stays, as every answer stays when a question ends.
- **The clock:** the decision is `clock_timestamp()` read after the locks (3.2 step 7) and re-read by the history
  guard (3.4). A change decided at 21:59:59.900 whose COMMIT lands after 22:00 is `changed`; one whose locks were
  granted after 22:00 is `window_closed`. The submit's `now()` (the transaction's start) is not used here, since a
  change that waited on a lock would otherwise pass a window that had already closed.
- **A change against a first submit** of the same assignment cannot happen (a change needs the row the submit
  writes; both serialize on the assignment row).
- **Two changes at once** (two tabs): they serialize on the schedule row; the second sees the first's revision. With
  `expectedRevision` it gets `answer_changed`; without it, it applies over the first (last write wins, both in the
  history).

### 3.7 Idempotency

- `requestKey` (a UUID the client makes per *Save change*, reused only by *Check result*) is unique per answer in the
  history.
- The same key and body → `replayed`, nothing written; the same key with another body → `request_key_reused`.
- **The same value writes no history row** and records no key (3.2 step 8). A retry of a request whose first send
  changed the row finds its key (step 6) before it could look "unchanged".
- Replay answers the current row (which a later change may have replaced) and `outcome: 'replayed'`.
- After a lost COMMIT answer (the F2 discipline, as the other ★★ routes): the route checks on a new connection whether
  the key's history row exists → `200 changed` with `verifiedAfterCommitError`, else `503 outcome_unknown`; never
  "nothing was saved" once the COMMIT was sent.

### 3.8 Info-hiding

- Another athlete's assignment, a missing assignment, a malformed id, a coach or any non-athlete caller: the identical
  `404 { error: "not_found", message: "Training session not found." }` (the submit's sentence, 1.3), no-store, before
  any detail about the window or the answer.
- `not_answered`, `window_closed` and `answer_changed` are said only to the athlete who owns the assignment.

## 4. The route and its answers

### 4.1 `POST /api/training-load/external-assignments/:assignmentId/rpe/change`

Body `{ requestKey, rpe, durationMinutes, note, expectedRevision }` (`expectedRevision` optional; the screen always
sends it). Validation exactly as the submit (1.3 step 2) plus `requestKey` a UUID (`400`). The route calls the function
in one transaction (`BEGIN` → bounds → the function → bounded COMMIT) and emits `training_load_changed` for the athlete
after the COMMIT (as the submit, `trainingLoad.js:2636`) and `calendar_changed` for nobody else.

| Outcome | Status | Body |
|---|---|---|
| changed | 200 | `{ outcome: "changed", feedback, revision, changedAt, closesAt }` |
| unchanged (same values) | 200 | `{ outcome: "unchanged", feedback, revision, closesAt }` |
| replayed (same key and body) | 200 | `{ outcome: "replayed", feedback, revision, closesAt }` |
| verified after a COMMIT error | 200 | `changed` plus `verifiedAfterCommitError: true` |
| invalid body | 400 | the submit's sentences; `"requestKey must be a UUID."` |
| not hers / missing / not an athlete | 404 | `{ error: "not_found", message: "Training session not found." }` |
| not answered yet | 409 | `{ error: "not_answered", message: "There is no answer to change yet." }` |
| window closed | 409 | `{ error: "answer_locked", message: "This answer can no longer be changed. The question is closed." }` |
| another tab changed it | 409 | `{ error: "answer_changed", message: "Your answer was changed on another screen. Check it and try again.", feedback, revision }` |
| key reused with another body | 409 | `{ error: "request_key_reused" }` |
| busy (lock / statement timeout, deadlock) | 409 | `{ error: "try_again", message: "Nothing was saved. Try again." }` |
| outcome unknown | 503 | `{ error: "outcome_unknown", message: "We can't tell yet whether your change was saved." }` |

`answer_locked` is the one stable sentence for a closed question (condition 6), whatever closed it.

The existing submit (`…/rpe`) keeps its contract: a different second answer is still `409 "This session already has a
submitted result."`. The screen never sends a change through it.

### 4.2 The athlete's reads gain what the screen needs

`GET /athlete/today` (`trainingLoad.js:236-282`) and `GET /weekly` external rows (`:1220`, `:1407-1417`) already carry
`closesAt` and `feedback`. Each external row gains `changeable` (true when the row has an answer, the schedule is
`active`, the occurrence not `cancelled`, the assignment `completed` and `now()` before `closesAt`; a display hint, the
function decides) and `feedback.revision` (0 when never changed). Planned rows are unchanged.

The athlete's own calendar card (K4a, `GET /api/calendar` in the athlete workspace, `calendarQuery.js:323-341`) gains,
on her own external assignment rows only, `rpe`, `closesAt`, `changeable` and `revision`; the coach's view of the same
read is unchanged.

### 4.3 The coach's mark (condition 3): the event panel's question read

The smallest place a coach already reads: **`GET /api/calendar/events/:eventId/questions`**
(`backend/src/routes/calendarEvents.js:32` → `getEventQuestions`, `calendarQuestionService.js:66-108`). For `kind =
'rpe'`, each athlete in `answered` gains `changed` (boolean) and `lastChangedAt` (the newest `changed_at`, or `null`),
read by one `left join lateral` over `session_feedback_changes` by `external_assignment_id` (the new index). Counts,
the info-hiding of the route and the WELLNESS rows are unchanged. The panel shows "Changed 21:40" beside the athlete's
name.

Training Load's coach reads (`/weekly`, `/calendar`, the dashboards) are not changed in K4b: they show the current
value (ADR-004) with no mark. **Q4** asks whether a mark is wanted there later.

## 5. The migration outline (v83, `migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql`)

- **Preconditions (refuse, `23514`):** the md5 of `protect_session_feedback_snapshot`'s body in force equals the v5
  body; no `session_feedback_changes` table, no `change_external_rpe`, no `rpe_change_marker_ok`, no
  `session_feedback_change_link`; `pg_current_xact_id()` exists.
- **Objects:** section 3.1, in this order: the marker function, the table and its guards, the append-only triggers,
  the trigger body, the deferred constraint trigger, the sanctioned function, `revoke all … from public` on the new
  table and function (as v58), row-level security on the new table (no policy; the owner role writes).
- No row of any existing table is written; `git diff --check` clean, no trailing blank line (the v48 lesson).
- **Runbook** `docs/runbooks/rpe-answer-change-v83.md`; **preflight** `…-v83-preflight.sql` (read-only blocks: the
  server version; the last migration and its checksum; v83 absent; the trigger body md5; no object of v83; the count
  of `scheduled_external` rows, for the record; no idle transaction or lock wait on `session_feedback`);
  **post-check** `…-v83-postcheck.sql` (v83 recorded once with the file's sha256 and the last migration; the objects;
  the new trigger body md5; both new triggers enabled, the constraint trigger deferrable initially deferred; 0 history
  rows; the marker unset).
- **Rollback** `…-v83-rollback.sql`: refuses without v83, under a later migration, **once any
  `session_feedback_changes` row exists**, or when a v83 object is missing or changed (md5); otherwise drops the
  constraint trigger, the function, the guards, the table and the marker function, restores the v5 body by md5, and
  deletes the v83 record. After the first change v83 is forward-only.
- **Rehearsal** (disposable databases only, `optimove_tests_*`):
  1. the runner up to v82's predecessor (the last migration on `main` at the time) → v83 → the post-check →
     the rollback → a catalog identical to before (functions, triggers, md5) → v83 again;
  2. the same on a database built from the production schema snapshot
     (`backend/tests/support/legacy-schema.sql`, last v57, then the runner up to v83), since that is the shape
     production has;
  3. the rollback refused with one history row present.
- **PostgreSQL 17: NOT RUN.** The executor's and the reviewers' clusters are PostgreSQL 16; the owner runs 17 locally
  before the merge, or it stays NOT RUN in the packet.
- Deploy: a migration, so the owner's order naming v83, the preflight, the owner's deploy, the post-check (the
  standing order for migration PRs).

## 6. The UI (English copy)

- **Athlete Home** (the "Today's sessions" list, `frontend/training-load-view.js:170-176`, today a plain summary for a
  rated row) and the **event card** of the athlete's Calendar (K4a): a rated external row with `changeable` reads
  **"Your RPE: 7 · Change (until 22:00)"**; *Change* is a button. Without `changeable` it reads "Your RPE: 7" as
  today. The time is `closesAt` in the device's time; a window that ends on another day reads "until Sun 22:00"
  (the questions card's day words, `frontend/athlete-questions-view.js:36-50`).
- *Change* opens the existing RPE form (`renderRpeFormHtml`, `training-load-view.js:301`) **filled in** with the saved
  RPE, duration and note, the eyebrow "Change your answer", the line "You can change it until 22:00." under the
  title, and the primary button **Save change** (off while nothing differs from the saved answer, or the form is
  invalid). Cancel closes without a request.
- **Outcomes:**
  - `changed` → "Saved. Your RPE: 5 · 60 min · sRPE 300", then the row repaints;
  - `unchanged` → the form closes, nothing shown;
  - `answer_locked` → "This answer can no longer be changed. The question is closed." The form closes and the row
    shows the saved answer without *Change*;
  - `answer_changed` → the server's sentence; the form refills with the returned answer;
  - `try_again` → "Nothing was saved. Try again." The form stays;
  - no answer, a 5xx or `outcome_unknown` → "We can't tell yet whether your change was saved." with **Check result**,
    which sends the same request with the same `requestKey`; the form's other controls stay off until it settles.
- One request at a time; a double tap sends one. The planned (Builder) rows never show *Change*.
- **Coach:** the event panel's answered athlete reads "Changed 21:40" (4.3).

### 6.1 As built on the athlete's Calendar (K4b-UI, 2026-11-20; the stream manager's decisions of that day)

Departures from the text above and from mockup 05 (`docs/design/calendar-k4/05-k4b-change-rpe.html`), all accepted by
the stream manager before the code:

- **Q-A: the line is on her own "RPE request" card (`kind: "external"`), not on the event card.** The athlete's
  Calendar never folds an event's RPE question into the event card (`backend/src/calendarQuery.js:1287`, the fold runs
  only when `ctx.type !== "athlete"`), and the athlete's card allowlist (D21) carries no answer value. The event card
  keeps K4a's behaviour. No backend fold was added.
- **The data: her own weekly read, not a wider `/api/calendar` card (section 4.2).** For the shown week the Calendar
  also reads `GET /api/training-load/weekly` (her athlete-workspace read; no new route, no new field) and keeps its
  rated `scheduled_external` rows by `externalAssignmentId` (`frontend/athlete-calendar-answers.js`). A card gets the
  line, and Change opens the form, only from a row that read returned for that assignment while it says
  `changeable` - never from an id in the page. A failed read hides only the line (the card keeps "✓ RPE given"); an
  older read's answer is dropped (a generation counter); a workspace switch or sign-out clears it. The calendar's own
  read never waits for it.
- **The lines:** open: "Your RPE: 7" · *Change* · "You can change it until 22:00."; closed: "Your RPE: 7 · Answers
  closed at 22:00."; neither (a stopped question) or no row: "✓ RPE given".
- **The form's heading on every entry point** (Home, the weekly sheet and the Calendar share the form): "Change your
  RPE · <title>", the eyebrow removed; the line under it "<day> · Your answer: 7, sent at 12:04." (the Calendar passes
  its day label, "Friday 20.11").
- **After the form:** a confirmed change reads the week again with "Your answer was changed."; `answer_locked` reads
  it again once without a sentence (the form said it), so the card shows "Answers closed at"; a change closed while
  its result was not confirmed reads it again once without a sentence, so the card never keeps the value from before
  the request.
- **Phones and touch tablets:** the form's own buttons are 44 px targets (`(max-width: 760px), (pointer: coarse)`,
  the query of its 16 px fields).

## 7. Test plan

Backend, disposable databases (T1 runner, `--kind disposable`), new suite
`backend/tests/rpe-answer-change-k4b.test.mjs`:

- T1 the migration applies; the post-check's expectations hold; the rollback restores the v5 catalog exactly; v83
  applies again; the rollback is refused with one history row.
- T2 the same on the legacy-schema snapshot.
- T3 a change inside the window: the row's three values change, `srpe` follows, `submitted_at` / `created_at` /
  identity unchanged, one history row with the old values, the actor and `athlete_self`.
- T4 the same values → `unchanged`, no history row, no update (the row's `xmin` unchanged).
- T5 the same key and body → `replayed`, one history row; the same key, another body → `request_key_reused`.
- T6 the key's replay after the window closed still answers `replayed`.
- T7 `expectedRevision` stale → `answer_changed`, nothing written.
- T8 the race, the close first (a held schedule cancel commits, then the change) → `answer_locked`.
- T9 the race, the change first (the change holds the locks, the cancel waits) → `changed`, then the cancel commits;
  the answer stays.
- T10 the clock: a window whose `closes_at` passes while the change waits on a lock → `answer_locked`
  (`clock_timestamp`, not `now()`).
- T11 info-hiding: another athlete's assignment, a missing id, a malformed id, a coach → the identical 404 (status,
  body, headers byte for byte).
- T12 a planned answer cannot change (the function and the relaxed trigger both refuse).
- T13 raw paths: an `update` without the marker → refused by the v5 rule; with the marker set by hand and no history
  row → refused at COMMIT by the deferred guard; a history insert without the marker, outside the window, by another
  user, inside a savepoint, or with wrong old values → refused; update / delete / truncate of a history row → refused.
- T14 the recorded SQL order (the rule of PR #346): users → athletes → schedule → occurrence → assignment → feedback,
  no lock after the first write.
- T15 a change against a submit and against another change of the same assignment: no `40P01`.
- T16 the COMMIT trio: an error before, during (the answer lost) and after a COMMIT; `verifiedAfterCommitError` and
  `outcome_unknown`; never "nothing saved" after the COMMIT was sent.
- T17 readers: after a change, `/athlete/today`, `/weekly`, the Training Load calendar, `canonical_activity_results`
  and a dashboard query show the new value once (no duplicate fact), and sums over the athlete change by the
  difference only.
- T18 the coach's event panel: `changed` and `lastChangedAt` for the changed athlete only; another club's coach gets
  the identical 404 as today.

Frontend (JSDOM, `frontend/tests/rpe-answer-change.actions.test.mjs`): the row text with and without `changeable`;
the form opens filled in; *Save change* off when nothing differs; each outcome's sentence and state; *Check result*
sends the same key; a double tap sends one request; a planned row never offers *Change*.

**Mutations** (each must fail a test): drop the marker condition from the trigger; allow a fourth column under the
marker; drop `source = 'scheduled_external'`; `now()` instead of `clock_timestamp()`; the window check removed from the
guard; the deferred guard reading `NEW` instead of the current row; the deferred guard made not deferrable; the replay
check moved after the window; the same-value check moved after the history insert; the athlete check removed from the
lookup; the users lock moved after the schedule; the rollback's history-row refusal removed; the coach's mark counting
another assignment's change.

Gates: `--preset backend-fast`, `--preset frontend-fast` on the head and on a clean `origin/main` (the frontend PR
gate), the production build, `git diff --check`. `test:backend:shared` and PostgreSQL 17: NOT RUN unless the owner
orders them.

Reviewers: `db-reviewer`, `security-reviewer`, `code-reviewer`; `mobile-qa` and `ux-design-reviewer` for the screen;
then both ★★ GOs (the OptiMove manager and the *Nezavisni revizor*).

## 8. Open questions (each with a recommendation)

- **Q1 — the duration.** The form proves the duration is the athlete's own entry (1.4); O4 names it; the manager's
  condition 4 says "not the duration". **Recommendation:** the duration is changeable, with the RPE and the note; if
  the manager keeps it out, the function drops `p_duration_minutes` and the form shows it read-only.
- **Q2 — a cap on changes.** None in O4. **Recommendation:** no cap in K4b; the window bounds it and every change is in
  the history. Revisit if the history shows abuse.
- **Q3 — the planned (Builder) RPE.** It has no window (O4). **Recommendation:** out of K4b; when it gets a window it
  reuses the function with its own identity, as a separate decision.
- **Q4 — the coach's mark in Training Load** (`/weekly`, the Activities drawer). **Recommendation:** not in K4b; the
  event panel is the one place now. Add it on the pilot's feedback.
- **Q5 — does the coach see the old values** (the history), or only "Changed 21:40"? **Recommendation:** only the mark
  and the time in K4b; a history view later if asked.
- **Q6 — a change after the coach acted on the answer** (e.g. a dashboard already looked at). **Recommendation:** no
  extra rule; ADR-004 means every reader shows the current value, and the mark tells the coach it moved.
- **Q7 — locking users and athletes** (the submit does not). **Recommendation:** lock them, first (3.3); it costs one
  share lock and keeps the users-first rule for a new rights check.
- **Q8 — a note cleared to empty.** **Recommendation:** allowed (`null`), like a first answer without a note.

## 9. The six conditions, met

| Condition | Where |
|---|---|
| 1 Who and until when; checked by the database under the lock; the race both ways | 3.2 steps 2–7, 3.4, 3.6; T8–T11 |
| 2 Append-only history in the same transaction; the marker; the deferred guard (what it does not stop: the v35 limit) | 3.1, 3.2 steps 10–14, 3.4, 3.5; T3, T13 |
| 3 The coach is told; dashboards read the current value; every reader checked | 1.5, 4.3; T17, T18 |
| 4 What may change; `requestKey`; same value no history row | 1.4, 2, 3.7; T4, T5, T12; Q1 |
| 5 No existing row changed; rollback refuses with history; rehearsal; PG 17 NOT RUN | 3.1, 5; T1, T2 |
| 6 Identical 404; a stable sentence when closed | 3.8, 4.1; T11 |
