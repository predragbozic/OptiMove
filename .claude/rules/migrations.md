---
paths:
  - "migrations_v2/**"
  - "backend/src/migrate.js"
  - "backend/tests/migrate*.test.mjs"
---

# Migrations

Runner: `backend/src/migrate.js`. Verified against current code — see
`docs/decisions/ADR-005-append-only-migration-policy.md` for the full evidence trail.

## File contract

- New migrations live only in `migrations_v2/`, flat directory, named
  `YYYYMMDDHHMM_description.sql`. The runner regex-validates this naming
  (`backend/src/migrate.js`) — a wrongly-named file fails to apply, it doesn't silently
  get skipped.
- No transaction-control statements inside a migration file — `BEGIN`, `COMMIT`,
  `ROLLBACK`, `START TRANSACTION`, `END`, `ABORT`, `PREPARE TRANSACTION` are all rejected
  by `assertNoTransactionControl()` before the migration runs. `ROLLBACK TO SAVEPOINT` is
  the one exception. `BEGIN`/`END` inside a dollar-quoted `CREATE FUNCTION ... $$ ... $$`
  body is fine — the runner's own lexer masks those out before checking.
- **Already-applied migrations are immutable.** The runner computes a SHA-256 checksum of
  the file at apply time and stores it; on a later run, a matching checksum is a no-op
  skip, a mismatched checksum aborts with an explicit error. Editing a migration after
  it's been applied anywhere (including your own local dev DB) breaks the next run
  against that database — change a NEW migration instead, once the old one has been
  applied anywhere real.
- On an unpublished feature branch, before merge, a migration that hasn't been applied
  anywhere yet can still be edited freely — the immutability rule is about "already
  applied," not "already committed."

## Backfill

- A `NOT NULL` column added to a table with existing rows needs either a `DEFAULT` or a
  paired backfill `UPDATE` in the same migration.
- Prefer a backfill shape that doesn't require a full-table rewrite or per-row
  computation where a simple `DEFAULT` + filtered `UPDATE` will do (see the real example
  cited in ADR-005).

## Lock order (Training Load dashboard subsystem specifically)

`training_load` dashboard writes lock in this order: **dashboard → widget → series**.
This is stated in the schema migration comments and provable in the sanctioned functions
themselves (e.g. `update_widget_layout`, `add_series` both lock the dashboard row before
the widget row). A new function touching more than one of these tables must follow the
same order, or it's a deadlock risk against the existing functions. See
`docs/decisions/ADR-003-dashboard-sanctioned-writes.md`.

## Never automatic

Running a migration against any persistent database (local OPTIMOVE dev included) is
never automatic — see `database-safety.md`. This file governs what a migration file
should look like; it doesn't grant permission to apply one.
