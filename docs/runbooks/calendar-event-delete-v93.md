# v93: delete a calendar event that holds nothing

Migration `migrations_v2/202611251000_calendar_v93_event_delete.sql`. Owner's decision of 2026-11-22, relayed by the
OptiMove manager with the number v93 and decisions B1–B4. The files beside this one are:
- `calendar-event-delete-v93-preflight.sql`;
- `calendar-event-delete-v93-postcheck.sql`;
- `calendar-event-delete-v93-rollback.sql`.

The rehearsal tool is `backend/scripts/calendar-event-delete-v93-rehearsal.mjs`, with `.sh` and `.ps1` wrappers.

## What it does

Until v93 an event could only be cancelled. The database refused every delete (v49's `events_no_delete`), and the
tables that name an event are append-only or refuse deletes.

- **`calendar.delete_event(event, expected revision, user, basis, request key, request hash, result)`**: the only way
  to delete an event. In one transaction it:
  1. locks the event `FOR UPDATE` and checks the revision;
  2. writes one row of `calendar.event_deletion_log`;
  3. deletes the event's own rows (its change log, its request records, its chosen details, its targets);
  4. deletes the event itself.
- **`calendar.event_deletion_log`** (decision B1): who, when, on which basis, the owner, the title, the day(s), the
  event's status and revision, and the request key and hash. It is the delete route's request record. It is
  append-only and cannot be truncated. It keeps no target, note, detail or athlete.
- **The insert guard of the log row** re-checks three things under the event's lock:
  - **The right:** `calendar.lock_event_writer`, the cancel right, raises `42501` when it does not hold.
  - **The facts:** the row must repeat the event's own facts.
  - **Nothing attached** (decision B2). Each class refuses with its own constraint name, which the route answers as a
    stable 409:
    - `event_has_trainings`: a session link, ended ones included;
    - `event_has_activities`: an activity link, ended ones included;
    - `event_has_questions`: a question for athletes;
    - `event_has_assignments`: a skipped test assignment (a Day off's);
    - `event_has_details`: a value of a detail;
    - `event_has_schedule`: a referenced RPE or test schedule.
- **Cancelled events** are deleted on the same terms (decision B3).
- **`calendar.event_deleted_request_keys`**: the deleted event's request keys (user, key, hash, operation), written by
  `delete_event` from the event's request records before they go. The command runner reads them for every event
  command. A request whose key is there never runs again: the same request answers the one 404, another one
  `request_key_reused`. Without it, a *Check result* of the event's create after a lost answer would create the event
  again (code review of this pull request, HIGH). It is append-only, cannot be truncated, and only a sanctioned
  delete writes it.
- **The proof that a delete is sanctioned** is the deletion-log row of the SAME transaction
  (`calendar.event_deletion_pending`: the row's `xmin` is the current transaction). This is v57's transaction-local
  marker, except that only the guarded insert can create it.
  - Every guard that refused a delete on `events`, `event_requests`, `event_changes`, `event_targets` and
    `event_selected_fields` lets that one event's rows through. Any other delete is refused exactly as before.
  - At COMMIT a deferred check makes sure the logged event is gone.
- **What it changes in place:**
  - **Replaced:** two v49 bodies (`event_targets_before_delete`, `event_targets_need_target_after_delete`), each
    md5-gated.
  - **Split** so that the DELETE branch has its own function: five triggers (`events_no_delete`,
    `event_requests_append_only`, `event_changes_append_only`, `event_selected_fields_guard`,
    `event_selected_fields_need_parent`).
  - **Not changed:** the shared `refuse_change` and `refuse_delete`.
- **Lock order** (the same in the service and in the two functions, which read the owner without a lock, lock the
  rights, then the event, and compare the owner again):
  1. the writer's rights rows (`lock_event_writer`);
  2. the event `FOR NO KEY UPDATE` (the service, as every event command does);
  3. a Day off's day keys (as a cancel takes them);
  4. the event `FOR UPDATE` (`delete_event`).

  A concurrent attach or edit either finishes first, and the delete answers `409 event_changed` or the class code,
  or it waits and finds no event (the one 404).
- **Locks at deploy:** the migration sets `lock_timeout = '5s'`. Its trigger changes take a short lock on the five
  calendar tables. No row changes.

## The route

`POST /api/calendar/events/:eventId/delete { requestKey, expectedRevision }`:
- **Who:** the same right as cancel. A missing event and one the caller may not delete answer the identical 404.
- **Success:** `200 { deleted: true, eventId }`.
- **Replay:** the same key answers the saved result again, authorized again on the owner the log kept. The same key
  with another body is `request_key_reused`.
- **A lost COMMIT:** verified by the key in the log (`verifiedAfterCommitError`), otherwise `503 outcome_unknown`.
  The answer never says "not deleted" when the outcome is not known.
- **The manager's event read** (`GET /api/calendar/events/:eventId`) carries `deletable`: the same checks, read
  without a lock. It only chooses whether the panel shows Delete.
- **The panel:**
  - Delete is shown only when the event is `deletable`. For a cancelled event, which has no manager read, it is shown
    when the event has no schedule.
  - A first press shows "Delete “…” for good? It can't be undone." with **Delete event** and **Keep**.
  - A refusal hides the button.

## Before the merge

1. **Preflight**, read-only, each block as `begin transaction read only; <block>; rollback;`. Every ok column must be
   true.
   - Block 2 checks that the four bodies and the five triggers are as v49 / v51 left them. If another migration
     changed one of them first, v93 refuses to run and must be rebuilt on the new state.
2. **Block 5 of the preflight, in git:** the 12-digit prefix is unique on the merge tree.
3. **PostgreSQL 17 rehearsal** (production runs 17). It needs a PostgreSQL 17 server on loopback, `node` and
   `npm --prefix backend ci`.
   - Linux / macOS: `backend/scripts/calendar-event-delete-v93-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin`
   - Windows: `powershell -ExecutionPolicy Bypass -File backend\scripts\calendar-event-delete-v93-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"`

   It builds and drops only its own `optimove_tests_v93rehearsal_*` databases. It runs, in order: preflight, apply,
   a sanctioned delete (rolled back), post-check, the rollback to the same catalog, apply again, a committed delete,
   the rollback's refusal, and a dump / restore read-back. It must end with `RESULT: PASS`.

## After the deploy

- **Post-check**, read-only. Every ok column must be true. Block 4 (the log is empty) holds only right after the
  deploy.
- **Smoke:** without a login, `POST /api/calendar/events/<zero UUID>/delete` with `{}` answers 401.

## Rollback

`calendar-event-delete-v93-rollback.sql`: one transaction, at a quiet moment, and only on its own approval.
- **Before running it:** the deployed commit no longer contains the v93 file or the delete route.
- **When it refuses**, changing nothing: v93 is not recorded, a later migration is recorded, a deletion-log row exists,
  or the bodies in force are not v93's. Once one event has been deleted, v93 is forward-only: the log is the only
  trace of the deleted event.
- **What it restores:** the v49 / v51 triggers and the two v49 bodies verbatim (checked by md5 at its end).
  `backend/tests/calendar-event-delete-v93.test.mjs` test 9 and the rehearsal's step 6 check that the calendar catalog
  then equals the one before v93.

## Known limits

- The guards prove that the log row, the actor's right and the event agree. They do not stop whoever holds the
  database credentials (as v35 states it).
- A deleted event's history (its change rows, its request records) goes with it. Only the log row and the spent keys
  stay. That is the owner's "permanently" (B1).
- **The log keeps the event's title in plain text** for as long as the log is kept. A coach can type a name into a
  title. No route reads the log, and there is no retention rule for it yet.
- **The importer's undo** (v57, v60, v63) refuses while any calendar activity link names the activity, ended ones
  included. A deleted event never had one, so this is unchanged.
