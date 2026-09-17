# Undoing one imported GPEXE session

The way back from a bad GPEXE import, written down and executable **before**
anything is imported into a persistent database. It is a rehearsed operational
procedure, not a product feature: there is no UI, no API route, no per-athlete
variant, and the script refuses every database except a disposable
`optimove_tests_gpexe_*` one.

Script: `backend/scripts/gpexe-undo-imported-session.mjs`.
Proof: `backend/tests/gpexe-undo-session.test.mjs` (4 tests, disposable database).

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

Everything that belongs to that single event, in this order:

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
- **A shared activity.** If the activity also carries participants of another
  event, the run refuses rather than deleting a container that outlives this
  session.
- **Any database that is not disposable.** Same guard as the import CLI: the
  URL must be explicit and carry no query parameters, the host must be local,
  the name must match `optimove_tests_gpexe_*` and must not be `OPTIMOVE` or
  `monitoring2`, the connected server must agree on the name, and the database
  must carry the disposable marker table.

## How to run it

Dry run — runs the same statements and rolls them back, so the reported scope
is what would actually happen:

```
node backend/scripts/gpexe-undo-imported-session.mjs \
  --database-url <disposable url> --team-session 186942 --owner-team-id <uuid>
```

Apply, on a disposable database:

```
node backend/scripts/gpexe-undo-imported-session.mjs \
  --database-url <disposable url> --team-session 186942 --owner-team-id <uuid> \
  --apply --performed-by-user-id <uuid> --reason "wrong session imported" --log undo.json
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

## The log

Every run returns, prints and (with `--log`) writes a JSON record: when, by
whom, why, whether it was applied, the event id, the GPEXE `source_external_id`,
the threshold set that was recorded for it, and the number of rows removed per
table. That file is the record of the operation — the database itself keeps no
deletion log yet, which is exactly why the JSON must be kept with the import's
own run report.

**The file is written before the commit, not after.** It lands on disk (with
`fsync`) with `"outcome": "pending"` while the transaction is still open, and
is rewritten with `"outcome": "committed"` once the commit succeeds. So:

| The process dies... | On disk | In the database |
|---|---|---|
| before the log is written | no file | nothing removed (rollback) |
| between the log write and the commit | `pending` | either nothing removed, or the removal committed — the log alone does not say which |
| after the commit | `committed` | removed |

A `pending` file is therefore a record that the run was attempted and what it
covered, never a claim that the removal happened. **When you find one, answer
the question with the database**: run the same command as a dry run — if it
still finds the event, nothing was removed; if it reports that no imported
GPEXE event exists for that session, the removal committed and the `pending`
file is its record. Writing the log only after the commit was the alternative,
and it loses the record of a removal that did happen; that trade was made
deliberately.

## Before this is ever used on a persistent database

Not approved, and not covered by the proof above:

- A **verified backup** taken immediately before the import, and a restore that
  was actually tried once.
- A decision on **who** may run this, and on a database-side deletion log (the
  dashboard subsystem's `dashboard_deletion_log`, added in v19, is the shape to
  copy).
- A decision on the two cases this procedure deliberately refuses: a session
  with a manual correction, and an activity shared with another event.
- Per-athlete removal, editing an imported session's own fields, and filling in
  athletes with no GPS record (estimated values) are **separate work**, none of
  it designed or approved yet. An estimated value must never be stored as a
  GPEXE measurement.
