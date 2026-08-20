# migrations_v2

New, flat-namespaced SQL migrations for OptiMove, applied by
`backend/src/migrate.js` (`runMigrations()`) on every startup.

## Naming convention

```
YYYYMMDDHHMM_description.sql
```

- `YYYYMMDDHHMM` - a 12-digit timestamp prefix (year, month, day, hour,
  minute). It fixes execution order and must be unique across every file in
  this directory - two files sharing a prefix cause the runner to abort
  ("ambiguous order").
- `description` - lowercase letters, digits, and underscores only.
- This directory must stay **flat**. The runner refuses to start if it finds
  a subdirectory here.
- Only `.sql` files are treated as migrations. Any other file (like this
  README) is ignored.
- Never edit a migration file after it has been applied anywhere. The
  runner records a SHA-256 checksum of every applied file and aborts if the
  file on disk no longer matches what was recorded - write a new migration
  instead.
- A migration file must not contain its own transaction-control statements
  (`BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION`, etc. - `ROLLBACK TO
  SAVEPOINT` is fine). The runner wraps every migration in its own
  transaction; a file managing its own transaction would break that.

## How the runner decides what to run (Strategy B)

This project's schema was originally built by 29 migrations (still listed,
for the historical record, in `migrationPaths` inside `backend/src/migrate.js`).
Those are **no longer re-executed on startup**. Instead, the runner:

1. Computes a structural "legacy fingerprint" of the database (presence of
   the tables/columns/constraints those 29 migrations produced).
2. The first time it sees a database whose fingerprint matches, it records
   that acceptance once (`public.migration_cutovers`) and creates
   `public.schema_migrations`.
3. From then on (and on every future startup), it only applies whatever
   `.sql` files in this directory aren't already recorded in
   `public.schema_migrations`.

## Fresh (empty) databases are not yet supported

**A brand-new, empty database will fail the Strategy B preflight** - it
doesn't have the legacy fingerprint, so the runner aborts rather than
guessing what to do, and creates nothing. Bootstrapping a fresh database
(a consolidated schema snapshot standing in for the 29 legacy migrations)
is intentionally **out of scope** here and is planned as a future,
separate piece of work. Until that exists, this runner only supports
databases that already have the legacy OptiMove schema in place.
