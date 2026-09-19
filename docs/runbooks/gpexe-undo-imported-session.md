# Undoing one imported GPEXE session

The way back from a bad GPEXE import, written down and executable **before**
anything is imported into a persistent database. It is a rehearsed operational
procedure, not a product feature: there is no UI, no API route, no per-athlete
variant, and the script refuses every database except a disposable
`optimove_tests_gpexe_*` one.

Script: `backend/scripts/gpexe-undo-imported-session.mjs`.
Database record: `training_load.import_deletion_log` (migration v21,
`migrations_v2/202609181000_training_load_v21_import_deletion_log.sql`).
Proof: `backend/tests/gpexe-undo-session.test.mjs` and
`backend/tests/gpexe-undo-guards.test.mjs`, both on a disposable database.

## Who may run it

Only an **active platform admin**, and only with a **reason** (owner decision
2026-09-18). "Active" means a `public.user_global_roles` row with
`role = 'platform_admin'` and `is_active = true`, for a user whose own
`public.users.is_active` is true. A revoked role or a disabled account is
refused.

The check is made twice, independently:

1. **By the script**, first thing inside the transaction, before any lock is
   taken or any protection is disabled. It reads the role row `FOR SHARE`, so a
   concurrent revocation either commits first and is seen, or waits until the
   run has finished.
2. **By the database**, when the log row is written: the v21 insert trigger
   repeats the same check and raises `insufficient_privilege` (SQLSTATE
   42501). A copy of the script with its own check removed still cannot commit
   a removal under a non-admin's name.

**What this does not do: authenticate the person at the keyboard.** The CLI
has no login. It checks that the user id passed with `--performed-by-user-id`
is an active platform admin, not that the operator *is* that admin. Whoever
can run the script with database credentials that are allowed to disable
triggers can name any admin. The record is therefore "run in the name of this
admin, for this reason". The accountability rests on who holds those
credentials. An in-app undo behind the normal login would close this gap, and
is separate, unapproved work.

## Why a procedure is needed at all

An imported session cannot be removed with ordinary SQL. Measured on a
disposable database with a real imported session, every single-statement delete
is refused:

| Attempt | Refused by |
|---|---|
| `delete from training.activities` | `activity_participants` FK |
| `delete from training.activity_components` | `activity_component_metric_segment_links` FK |
| `delete from training_load.metric_events` | `metric_event_participants` FK |
| `delete from training_load.metric_measurement_occasions` | `metric_source_identities.current_occasion` FK |
| `delete from training_load.metric_source_identities` | `metric_measurement_occasions.source_identity_id` FK |
| `delete from training_load.metric_values` | `metric_values_immutable` trigger (v13) |
| `delete from training_load.metric_event_source_bindings` | `metric_event_source_bindings_no_delete` trigger (v20) |

Six of the seven predate the GPEXE work. The procedure exists to undo the
session **in the right order**, with the two immutability triggers disabled
only inside the one transaction that does it.

## Scope — what one run removes

Everything that belongs to that single event. The scope is collected **inside
the same transaction that removes it**, after the event row and then its
activities are locked, so a link another writer adds in the meantime is either
seen (and the run refuses) or blocked until the run ends. Link rows are removed
only for this event, never "every link of the activity": if a foreign link were
somehow still there, removing the activity fails on its foreign key and the
whole run rolls back. The order:

1. `activity_component_metric_segment_links`
2. `activity_components`
3. `activity_participant_metric_participant_links`
4. `activity_participants`
5. `activity_metric_event_links`
6. `training.activities` — **only** when this session is the activity's single
   source; an activity that also carries participants of another event stops
   the run
7. `metric_values`
8. `metric_source_identities.current_occasion_id` (cleared)
9. `metric_measurement_occasions` — including superseded and flagged ones
10. `metric_source_identities` of this session, including the `team_session:<id>`
    reservation
11. `metric_event_participants`
12. `metric_event_segments`
13. `metric_event_source_bindings`
14. `metric_events`
15. `metric_import_batches` that no remaining occasion uses

**Not removed**, because they are not session-specific: the GPEXE source
connection, the metric definitions and their versions, the athletes, the team.
A later import of the same session reuses them.

## What stops the run

- **A manual correction.** If any occasion of the session was entered by hand
  (`entry_method = 'manual'`), the run refuses. Removing someone's hand-entered
  value is a separate decision, not a side effect of undoing an import.
- **A shared activity.** The run refuses if the activity also carries
  participants of another event, **or** if another metric event is linked to it
  at all — an event link is written without any participant link, so counting
  participants alone would miss it and the activity would be deleted out from
  under that other event.
- **A merged, reparented or superseded activity.** Removing it would break a
  chain another activity depends on, so the run stops instead.
- **Two events for the same GPEXE session.** v20's uniqueness covers active
  connections only, so an archived connection can leave a second event with the
  same `team_session:<id>`. Which one to undo is a decision; the run refuses
  until the connections are sorted out.
- **Any database that is not disposable.** Same guard as the import CLI: the
  URL must be explicit and carry no query parameters, the host must be local,
  the name must match `optimove_tests_gpexe_*` and must not be `OPTIMOVE` or
  `monitoring2`, the connected server must agree on the name, and the database
  must carry the disposable marker table.

## How to run it

`--reason` and `--performed-by-user-id` are required for **every** run. That
includes the dry run, which goes through the same checks and the same
statements as the real run, log insert included.

Dry run — runs the same statements in a normal transaction and rolls it back,
so the reported scope is what would actually happen. It holds the same locks as
an applied run while it lasts, so it is not free on a database others are using:

```
node backend/scripts/gpexe-undo-imported-session.mjs \
  --database-url <disposable url> --team-session 186942 --owner-team-id <uuid> \
  --performed-by-user-id <platform admin uuid> --reason "check before undo"
```

Apply, on a disposable database. `--log` is also **required** with `--apply`.
The log file is never written over: if the path already exists the run refuses,
so an earlier record cannot be lost by reusing the same file name:

```
node backend/scripts/gpexe-undo-imported-session.mjs \
  --database-url <disposable url> --team-session 186942 --owner-team-id <uuid> \
  --apply --performed-by-user-id <platform admin uuid> --reason "wrong session imported" --log undo.json
```

## The protections come back on, including when the run fails

`ALTER TABLE ... DISABLE TRIGGER` is transactional in Postgres, so the two
immutability protections are restored by three independent things:

1. **Rollback restores them by itself** — an error, a refusal, a dry run, a
   killed process or a lost connection all abort the transaction, and the
   trigger state goes back with it. Nothing has to run for this to happen.
2. **The run switches them back on explicitly** before it commits.
3. **The commit is refused unless the database confirms all three are enabled
   again** (`pg_trigger.tgenabled = 'O'`); if any is still off, the run throws
   and the whole transaction, removal included, is rolled back.

While the triggers are off, the transaction holds a lock on those two tables,
so no other session can write to them in that window — and no other session
ever sees the protections as disabled.

Proven by `backend/tests/gpexe-undo-session.test.mjs`: an interrupted run, a
dry run and a run whose protection is left off at commit time all end with the
three triggers enabled, the data untouched, and a real delete attempt refused
again. Each of those checks was verified to fail when the protection it covers
is removed from the code.

## The database log

An applied run writes **one row** to `training_load.import_deletion_log` in the
**same transaction** as the removal. The row commits with the removal or not
at all. It records:

| Column | What |
|---|---|
| `deleted_at` | when (transaction time) |
| `deleted_by_user_id`, `authorized_via` | which platform admin, on what basis (`platform_admin` is the only basis accepted) |
| `reason` | why, trimmed; a blank reason is refused |
| `event_id`, `source_system`, `source_connection_id`, `source_external_id` | which session (`team_session:<id>`); the event itself is gone, so it is kept by value |
| `owner_team_id`, `occurred_date` | the team and the day |
| `reference_set_external_id` | the GPEXE threshold set the values had been imported under, if the event had a v20 binding |
| `removed_counts`, `removed_total` | rows removed per table, and their sum |

What the database guarantees on its own:

- the row cannot be **changed or deleted** (an append-only trigger refuses
  `UPDATE` and `DELETE`, the same shape as v19's `dashboard_deletion_log`);
- it can only name an **active platform admin** (see Who may run it);
- it can only describe an event that **no longer exists** at the moment of the
  insert. It records a removal made in that transaction, never a plan;
- one row per event id, a non-empty reason, non-empty counts, a positive total.

What it does **not** guarantee: that every removal is logged. Removing an
imported session by hand, outside this procedure, is already out of contract
and takes disabling the v13/v20 protections as the table owner. Such a
removal leaves no row here.

A dry run inserts the row too, and rolls it back with everything else. Nothing
remains.

## The file log

Every run also returns, prints and (with `--log`) writes a JSON record: when,
by whom, why, whether it was applied, the event id, the team, the GPEXE
`source_external_id`, the threshold set that was recorded for it, the number of
rows removed per table and in total, and, for an applied run, the id of the
database log row (`databaseLogId`). Keep it with the import's own run report.

**The file is written before the commit, not after.** It lands on disk (with
`fsync`) with `"outcome": "pending"` while the transaction is still open, and
is rewritten with `"outcome": "committed"` once the commit succeeds. So:

| The process dies... | On disk | In the database |
|---|---|---|
| before the log is written | no file | nothing removed (rollback) |
| between the log write and the commit | `pending` | either nothing removed, or the removal committed — the log alone does not say which |
| after the commit | `committed` | removed |

A `pending` file is therefore a record that the run was attempted and what it
covered, never a claim that the removal happened. **When you find one, check
the database**: run the same command as a dry run.

- Use a **new** `--log` path for that check, or leave `--log` out: the run
  refuses to write over the existing file.
- If it still finds the event, **nothing was removed by that attempt** — the
  session is intact and can be left alone or undone again.
- If it reports that no imported GPEXE event exists for that session, that tells
  you **the state of the database right now, and nothing more**. It does not by
  itself prove that this attempt is what removed it: another run, another
  operator, or a restore from backup could equally have produced the same
  state. A `pending` file plus a missing event is consistent with the removal
  having committed — it is not evidence of it.
- To attribute the removal, use something the attempt alone cannot fake: the
  `committed` log of some run, the import's own run report, the database
  backup taken before the work, or the server log for that window. If none of
  those settles it, record the outcome as unknown rather than assuming.

Writing the log only after the commit was the alternative, and it loses the
record of a removal that did happen; that trade was made deliberately.

## Before this is ever used on a persistent database

Not approved, and not covered by the proof above:

- Applying v21 to that database. The deletion log and its checks exist only
  where the migration has run.
- A **verified backup** taken immediately before the import, with
  `backend/scripts/gpexe-backup-verify.mjs`. It restores the dump into a
  separate database and compares it with the source table by table and row by
  row. See `docs/runbooks/gpexe-backup-verify.md`.
- Unlocking the script for anything but a disposable database. That is its own
  decision, after the ones above, and it needs an external review (auth/role
  trigger). Before that, at least three things are needed:
  - **A real authenticated identity.** Either a server-side action behind the
    app's normal login, driven by the session's `req.authz`, or a CLI that makes
    the admin re-authenticate at run time. A user id typed on the command line
    is not enough.
  - **A narrow credential for disabling the v13/v20 protections.** It must be
    separate from "has the platform_admin role", and its use must be audited.
  - **A second person's approval, or a ticket reference,** recorded with the
    reason.
- A decision on the two cases this procedure deliberately refuses: a session
  with a manual correction, and an activity shared with another event.
- Per-athlete removal, editing an imported session's own fields, and filling in
  athletes with no GPS record (estimated values) are **separate work**, none of
  it designed or approved yet. An estimated value must never be stored as a
  GPEXE measurement.
